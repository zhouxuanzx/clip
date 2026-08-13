package cool.clip.sync

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.nio.ByteBuffer
import java.security.MessageDigest

/**
 * 手机端的文件传输状态机，刻意与桌面端的 FileTransferManager 对称：
 * offer → accept → 若干二进制分片 → done(带 hash) → ack。
 *
 * 与桌面端两点不同：
 *  1) 接收侧落盘走 MediaStore（Downloads/Clip 目录，API 29+ 的 IS_PENDING 模式），
 *     不需要任何存储权限；
 *  2) 发送侧读的是 content:// URI（系统分享或文档选择器给的），不是本地文件路径。
 *
 * 编号奇偶区分两端：桌面端占偶数，本端占奇数，双向同时传也不会撞。
 */
class FileTransferManager(
    private val scope: CoroutineScope,
    private val context: Context,
    private val notify: (String) -> Unit = {}
) {
    private val _transfers = MutableStateFlow<List<FileTransfer>>(emptyList())
    val transfers: StateFlow<List<FileTransfer>> = _transfers.asStateFlow()

    private var link: TransferLink? = null

    private val dataLock = Mutex()
    private val outById = mutableMapOf<Int, Outgoing>()
    private val inById = mutableMapOf<Int, Incoming>()
    private val queue = ArrayDeque<Outgoing>()
    private var busy = false
    private var nextId = 1
    private var keySeq = 0
    private val records = mutableListOf<FileTransfer>()
    /** records 会被多个 IO 协程（收发并发）和界面读取，ArrayList 非线程安全，单独加锁 */
    private val recordsLock = Any()
    /** 发送端发完 file-done 后，等对方 file-ack 的最长时间；超时没回就乐观认为已送达 */
    private companion object {
        const val ACK_TIMEOUT_MS = 10_000L
    }

    // ── 对外接口 ──────────────────────────────────────────

    fun setLink(link: TransferLink) {
        this.link = link
    }

    /** 把一批 content URI 排进发送队列（来自文档选择器或系统分享） */
    fun sendFiles(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch(Dispatchers.IO) {
            val link = link ?: run {
                notify("还没连上电脑")
                return@launch
            }
            val queued = uris.mapNotNull { buildOutgoing(it, link) }
            if (queued.isEmpty()) {
                notify("没有可读的文件")
                return@launch
            }
            dataLock.withLock { queue.addAll(queued) }
            pump()
        }
    }

    /** 分发来自对端的文件类消息（其余消息由 SyncManager 自己处理） */
    suspend fun handleMessage(message: SyncMessage) {
        when (message) {
            is FileOffer -> onOffer(message)
            is FileAccept -> onAccept(message.id)
            is FileReject -> onReject(message.id, message.reason)
            is FileDone -> onDone(message.id, message.hash)
            is FileAck -> onAck(message)
            is FileCancel -> onCancel(message)
            else -> Unit
        }
    }

    /** 二进制帧：分片载荷是 [4B 编号][8B 偏移][文件字节] */
    suspend fun handleBinary(data: ByteArray) = handleChunk(data)

    fun cancel(key: String) {
        scope.launch(Dispatchers.IO) {
            var out: Outgoing? = null
            var inc: Incoming? = null
            dataLock.withLock {
                out = outById.values.firstOrNull { it.record.key == key }?.also { outById.remove(it.id) }
                if (out == null) {
                    inc = inById.values.firstOrNull { it.record.key == key }?.also { inById.remove(it.id) }
                }
                if (out == null && inc == null) {
                    // 还在排队、没真正发出的，直接从队列里摘掉
                    val idx = queue.indexOfFirst { it.record.key == key }
                    if (idx >= 0) out = queue.removeAt(idx)
                }
                busy = false
            }
            out?.let {
                it.canceled = true
                it.settle?.complete("已取消")
                link?.sendMessage(FileCancel(it.id, "发送方取消"))
                finishRecord(it.record, TransferState.CANCELED, "已取消")
            }
            inc?.let {
                runCatching { it.os.close() }
                runCatching { context.contentResolver.delete(it.uri, null, null) }
                link?.sendMessage(FileCancel(it.id, "接收方取消"))
                finishRecord(it.record, TransferState.CANCELED, "接收方取消")
            }
            pump()
        }
    }

    fun clearFinished() {
        scope.launch(Dispatchers.IO) {
            synchronized(recordsLock) { records.removeAll { !isActive(it.state) } }
            touch()
        }
    }

    /** 连接断了：在途的全部标失败，残片清掉 */
    suspend fun clearLink() {
        val (outs, incs, queued) = dataLock.withLock {
            val o = outById.values.toList()
            val i = inById.values.toList()
            val q = queue.toList()
            outById.clear()
            inById.clear()
            queue.clear()
            busy = false
            Triple(o, i, q)
        }
        outs.forEach {
            it.canceled = true
            it.settle?.complete("连接已断开")
            it.ack?.complete(null)
            finishRecord(it.record, TransferState.FAILED, "连接已断开")
        }
        incs.forEach {
            runCatching { it.os.close() }
            runCatching { context.contentResolver.delete(it.uri, null, null) }
            finishRecord(it.record, TransferState.FAILED, "连接已断开")
        }
        // 还没轮到发出的，也得给个失败结局（和桌面端 unregisterLink 一致）
        queued.forEach { finishRecord(it.record, TransferState.FAILED, "连接已断开") }
        link = null
    }

    /** 落盘完成后的文件用外部应用打开 */
    fun reveal(transfer: FileTransfer) {
        val uri = runCatching { Uri.parse(transfer.path) }.getOrNull() ?: return
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mimeOf(transfer.name))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching {
            context.startActivity(Intent.createChooser(intent, "用其他应用打开").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        }
    }

    // ── 发送 ──────────────────────────────────────────────

    private fun buildOutgoing(uri: Uri, link: TransferLink): Outgoing? {
        val (name, size) = queryMeta(uri)
        if (size <= 0L) return null
        val id = allocateId()
        val record = createRecord(link, "send", name, size, uri.toString())
        return Outgoing(id, record, uri, size)
    }

    private fun pump() {
        scope.launch(Dispatchers.IO) {
            val out = dataLock.withLock {
                if (busy) return@withLock null
                val o = queue.removeFirstOrNull() ?: return@withLock null
                busy = true
                outById[o.id] = o
                o
            } ?: return@launch
            run(out)
        }
    }

    private suspend fun run(out: Outgoing) {
        val link = link ?: return finish(out, TransferState.FAILED, "连接已断开")
        val settle = CompletableDeferred<String?>()
        out.settle = settle
        val offer = FileOffer(out.id, out.record.name, out.size, mimeOf(out.record.name))
        if (!link.sendMessage(offer)) {
            finish(out, TransferState.FAILED, "连接已断开")
            return
        }

        val rejection = runCatching {
            withTimeout(30_000) { settle.await() }
        }.getOrElse { "等待对方回应超时" }
        out.settle = null
        if (rejection != null) {
            finish(out, if (out.canceled) TransferState.CANCELED else TransferState.FAILED, rejection)
            return
        }

        out.record = out.record.copy(state = TransferState.ACTIVE)
        touch()

        try {
            val hash = stream(out, link)
            if (out.canceled) return

            // 等对方的 file-ack。收尾挪到 run 里做，onAck 只负责兑现这个承诺，
            // 这样 ack 超时也能在这里统一兜底。
            val ack = CompletableDeferred<FileAck?>()
            out.ack = ack
            if (!link.sendMessage(FileDone(out.id, hash))) {
                out.ack = null
                finish(out, TransferState.FAILED, "连接已断开")
                return
            }

            val result = withTimeoutOrNull(ACK_TIMEOUT_MS) { ack.await() }
            out.ack = null
            if (out.canceled) return

            if (result != null) {
                finish(
                    out,
                    if (result.ok) TransferState.DONE else TransferState.FAILED,
                    if (result.ok) "" else result.message.ifEmpty { "对方未能保存" }
                )
            } else if (dataLock.withLock { outById.containsKey(out.id) }) {
                // 一直没回 ack：连接多半已断，但分片都发出去了、hash 也随 done 带走，
                // 偏向认为已送达，避免误报"失败"（真校验失败对端会回 ack(false)）
                finish(out, TransferState.DONE, "已发送，对方未回确认，可能已收到")
            }
        } catch (e: Exception) {
            link.sendMessage(FileCancel(out.id, e.message ?: "发送失败"))
            finish(out, TransferState.FAILED, e.message ?: "发送失败")
        }
    }

    private suspend fun stream(out: Outgoing, link: TransferLink): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val input = context.contentResolver.openInputStream(out.uri)
            ?: throw IOException("打不开文件")
        input.use {
            val buf = ByteArray(FILE_CHUNK_BYTES)
            var offset = 0L
            while (true) {
                if (out.canceled) throw IOException("已取消")
                val read = it.read(buf)
                if (read <= 0) break
                val slice = if (read == buf.size) buf else buf.copyOf(read)
                digest.update(slice)
                val header = ByteBuffer.allocate(CHUNK_HEADER_BYTES).putInt(out.id).putLong(offset).array()
                link.sendChunk(header + slice)
                offset += read
                out.record = out.record.copy(transferred = offset)
                touch()
            }
        }
        return digest.digest().toHex()
    }

    // ── 接收 ──────────────────────────────────────────────

    private suspend fun onOffer(offer: FileOffer) {
        val link = link ?: return
        val reject: (String) -> Unit = { reason -> link.sendMessage(FileReject(offer.id, reason)) }

        if (offer.size < 0) {
            reject("文件大小无效")
            return
        }

        val name = safeName(offer.name)
        val finalName = uniqueDisplayName(name)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, finalName)
            put(MediaStore.Downloads.MIME_TYPE, offer.mime.ifEmpty { mimeOf(finalName) })
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/$TRANSFER_DIR")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }

        val uri = runCatching { context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) }
            .getOrNull() ?: run { reject("无法创建文件"); return }
        val os = runCatching { context.contentResolver.openOutputStream(uri) }
            .getOrNull() ?: run {
                runCatching { context.contentResolver.delete(uri, null, null) }
                reject("无法写入")
                return
            }

        val record = createRecord(link, "receive", finalName, offer.size, uri.toString())
            .copy(state = TransferState.ACTIVE)
        val inc = Incoming(offer.id, record, uri, os, MessageDigest.getInstance("SHA-256"), 0)
        dataLock.withLock { inById[offer.id] = inc }
        link.sendMessage(FileAccept(offer.id))
        touch()
    }

    private suspend fun onDone(id: Int, hash: String) {
        val inc = dataLock.withLock { inById.remove(id) } ?: return
        val link = link
        val ack: (Boolean, String) -> Unit = { ok, msg -> link?.sendMessage(FileAck(id, ok, msg)) }

        runCatching { inc.os.close() }
        val actual = inc.digest.digest().toHex()
        if (actual != hash) {
            runCatching { context.contentResolver.delete(inc.uri, null, null) }
            finishRecord(inc.record, TransferState.FAILED, "校验不通过，文件已丢弃")
            ack(false, "校验不通过")
            return
        }

        val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
        runCatching { context.contentResolver.update(inc.uri, values, null, null) }
            .onFailure {
                runCatching { context.contentResolver.delete(inc.uri, null, null) }
                finishRecord(inc.record, TransferState.FAILED, it.message ?: "落盘失败")
                ack(false, it.message ?: "落盘失败")
                return
            }
        finishRecord(inc.record, TransferState.DONE, "")
        ack(true, "")
        notify("收到文件：${inc.record.name}")
    }

    private suspend fun handleChunk(data: ByteArray) {
        if (data.size < CHUNK_HEADER_BYTES) return
        val buf = ByteBuffer.wrap(data)
        val id = buf.int
        val offset = buf.long
        val inc = dataLock.withLock { inById[id] } ?: return

        if (offset != inc.received) {
            link?.sendMessage(FileCancel(id, "分片错位"))
            dataLock.withLock { inById.remove(id) }
            runCatching { inc.os.close() }
            runCatching { context.contentResolver.delete(inc.uri, null, null) }
            finishRecord(inc.record, TransferState.FAILED, "分片错位")
            return
        }

        val payload = data.copyOfRange(CHUNK_HEADER_BYTES, data.size)
        runCatching { inc.os.write(payload) }.onFailure {
            dataLock.withLock { inById.remove(id) }
            runCatching { inc.os.close() }
            runCatching { context.contentResolver.delete(inc.uri, null, null) }
            finishRecord(inc.record, TransferState.FAILED, "写入失败")
            return
        }
        inc.digest.update(payload)
        inc.received += payload.size
        inc.record = inc.record.copy(transferred = inc.received)
        touch()
    }

    // ── 消息回调 ──────────────────────────────────────────

    private fun onAccept(id: Int) {
        dataLock.withLock { outById[id] }?.settle?.complete(null)
    }

    private fun onReject(id: Int, reason: String) {
        dataLock.withLock { outById[id] }?.settle?.complete(reason.ifEmpty { "对方拒绝接收" })
    }

    private fun onAck(message: FileAck) {
        val out = dataLock.withLock { outById[message.id] } ?: return
        // 收尾在 run 里做，这里只兑现 ack 承诺
        out.ack?.complete(message)
    }

    private suspend fun onCancel(message: FileCancel) {
        val reason = message.reason.ifEmpty { "对方取消" }
        val out = dataLock.withLock { outById.remove(message.id) }
        if (out != null) {
            out.canceled = true
            out.settle?.complete(reason)
            out.ack?.complete(null)
            finish(out, TransferState.CANCELED, reason)
            return
        }
        val inc = dataLock.withLock { inById.remove(message.id) }
        if (inc != null) {
            runCatching { inc.os.close() }
            runCatching { context.contentResolver.delete(inc.uri, null, null) }
            finishRecord(inc.record, TransferState.CANCELED, reason)
        }
    }

    // ── 收尾辅助 ─────────────────────────────────────────

    private fun finish(out: Outgoing, state: TransferState, error: String) {
        out.record = finishRecord(out.record, state, error)
        scope.launch(Dispatchers.IO) { releaseAndPump(out) }
    }

    private suspend fun releaseAndPump(out: Outgoing) {
        dataLock.withLock {
            outById.remove(out.id)
            busy = false
        }
        pump()
    }

    private fun finishRecord(record: FileTransfer, state: TransferState, error: String): FileTransfer {
        if (!isActive(record.state)) return record
        val updated = record.copy(
            state = state,
            error = error,
            transferred = if (state == TransferState.DONE) record.size else record.transferred
        )
        synchronized(recordsLock) { records.replaceAll { if (it.key == updated.key) updated else it } }
        touch()
        return updated
    }

    private fun createRecord(link: TransferLink, direction: String, name: String, size: Long, path: String): FileTransfer {
        keySeq += 1
        val record = FileTransfer(
            key = "t$keySeq",
            deviceId = link.deviceId,
            deviceName = link.deviceName,
            direction = direction,
            name = name,
            size = size,
            transferred = 0,
            state = TransferState.WAITING,
            error = "",
            path = path,
            startedAt = System.currentTimeMillis()
        )
        synchronized(recordsLock) { records.add(0, record) }
        return record
    }

    private fun touch() {
        synchronized(recordsLock) { _transfers.value = records.toList() }
    }

    private fun isActive(state: TransferState): Boolean = state == TransferState.WAITING || state == TransferState.ACTIVE

    /** 奇数编号归手机端，且落在 31 位正整数范围，不会和桌面端的偶数撞 */
    private fun allocateId(): Int {
        nextId = (nextId + 2) and 0x7FFFFFFF
        return nextId or 1
    }

    private fun queryMeta(uri: Uri): Pair<String, Long> {
        var name = "未命名文件"
        var size = -1L
        runCatching {
            context.contentResolver.query(
                uri,
                arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE),
                null, null, null
            )?.use { c ->
                if (c.moveToFirst()) {
                    val n = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
                    if (n >= 0) c.getString(n)?.takeIf { it.isNotBlank() }?.let { name = it }
                    val s = c.getColumnIndex(MediaStore.MediaColumns.SIZE)
                    if (s >= 0) size = c.getLong(s)
                }
            }
        }
        if (size < 0) {
            size = runCatching { context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: -1L
        }
        return name to size
    }

    private fun uniqueDisplayName(name: String): String {
        val ext = name.substringAfterLast('.', "")
        val stem = if (ext.isEmpty()) name else name.substring(0, name.length - ext.length - 1)
        for (i in 0..999) {
            val candidate = if (i == 0) name else "$stem ($i).$ext"
            if (!nameExists(candidate)) return candidate
        }
        return "${System.currentTimeMillis()}-$name"
    }

    private fun nameExists(name: String): Boolean {
        val uri = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val sel = "${MediaStore.Downloads.DISPLAY_NAME} = ?"
        return runCatching {
            context.contentResolver.query(uri, null, sel, arrayOf(name), null)?.use { it.moveToFirst() } ?: false
        }.getOrNull() ?: false
    }
}

/** SyncManager 提供给 FileTransferManager 的发送能力 */
interface TransferLink {
    val deviceId: String
    val deviceName: String
    fun sendMessage(message: SyncMessage): Boolean
    suspend fun sendChunk(payload: ByteArray)
}

private const val TRANSFER_DIR = "Clip"

private data class Outgoing(
    val id: Int,
    var record: FileTransfer,
    val uri: Uri,
    val size: Long,
    var canceled: Boolean = false,
    var settle: CompletableDeferred<String?>? = null,
    /** 等待对端 file-ack 的兑现函数；超时兜底由 run 处理 */
    var ack: CompletableDeferred<FileAck?>? = null
)

private data class Incoming(
    val id: Int,
    var record: FileTransfer,
    val uri: Uri,
    val os: java.io.OutputStream,
    val digest: MessageDigest,
    var received: Long
)

/** 只取基名，再挡掉路径分隔符和控制字符，防路径穿越 */
private fun safeName(raw: String): String {
    val base = raw.replace('\\', '/').substringAfterLast('/').trim()
    val cleaned = base.replace(Regex("[<>:\"/\\\\|?*\\u0000-\\u001f]"), "_")
    if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") return "未命名文件"
    return if (cleaned.length > 180) cleaned.substring(0, 180) else cleaned
}

private fun mimeOf(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return MIME_BY_EXT[ext] ?: "application/octet-stream"
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

private val MIME_BY_EXT: Map<String, String> = mapOf(
    "txt" to "text/plain", "md" to "text/markdown", "csv" to "text/csv",
    "json" to "application/json", "xml" to "application/xml", "html" to "text/html",
    "pdf" to "application/pdf", "zip" to "application/zip", "7z" to "application/x-7z-compressed",
    "rar" to "application/vnd.rar", "png" to "image/png", "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg", "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp",
    "svg" to "image/svg+xml", "mp3" to "audio/mpeg", "wav" to "audio/wav", "flac" to "audio/flac",
    "mp4" to "video/mp4", "mkv" to "video/x-matroska", "mov" to "video/quicktime",
    "doc" to "application/msword", "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls" to "application/vnd.ms-excel", "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt" to "application/vnd.ms-powerpoint", "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "apk" to "application/vnd.android.package-archive"
)
