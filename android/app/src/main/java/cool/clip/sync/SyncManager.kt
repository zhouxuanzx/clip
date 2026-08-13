package cool.clip.sync

import android.util.Log
import cool.clip.data.ChangeSet
import cool.clip.data.PeerEntity
import cool.clip.data.Repository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.util.concurrent.TimeUnit
import android.net.Uri
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.first

private const val TAG = "ClipSync"

sealed interface SyncState {
    data object Idle : SyncState
    data object Connecting : SyncState
    data class Connected(val peerName: String) : SyncState
    data class Failed(val reason: String) : SyncState
}

/**
 * 手机侧的同步连接。手机永远是客户端，电脑是服务端——
 * 手机 IP 变动频繁、还会被系统随时冻结，让它主动连更靠谱。
 */
class SyncManager(
    private val repo: Repository,
    private val scope: CoroutineScope
) {
    private val http = OkHttpClient.Builder()
        // 长连接不能有读超时，心跳交给应用层的 ping/pong
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .connectTimeout(6, TimeUnit.SECONDS)
        .build()

    private val _state = MutableStateFlow<SyncState>(SyncState.Idle)
    val state: StateFlow<SyncState> = _state.asStateFlow()

    /** 给界面弹提示用，例如"收到 3 项" */
    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val notices: SharedFlow<String> = _notices.asSharedFlow()

    private val lock = Mutex()
    private var socket: WebSocket? = null
    private var codec: FrameCodec? = null
    private var peerId: String? = null
    private var reconnectJob: Job? = null
    /** 用户主动断开时不再自动重连 */
    private var wantConnection = false

    val isConnected: Boolean get() = state.value is SyncState.Connected

    /** 文件传输状态机，落盘、分片、校验都在它里面 */
    private val transferMgr =
        FileTransferManager(scope, repo.context) { scope.launch { _notices.emit(it) } }

    /** 给界面看的传输记录（收发的都在一起） */
    val transfers: StateFlow<List<FileTransfer>> = transferMgr.transfers

    /** 把一批 content URI 发给电脑，必要时先建立连接 */
    fun sendFiles(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            if (!isConnected) {
                connect()
                withTimeoutOrNull(8_000) { state.first { it is SyncState.Connected } }
            }
            transferMgr.sendFiles(uris)
        }
    }

    fun cancelTransfer(key: String) = transferMgr.cancel(key)

    fun clearTransfers() = transferMgr.clearFinished()

    fun revealTransfer(transfer: FileTransfer) = transferMgr.reveal(transfer)

    // ── 连接 ──────────────────────────────────────────────

    /** 用已配对的电脑重连 */
    fun connect() {
        wantConnection = true
        scope.launch {
            val peer = repo.primaryPeer()
            if (peer == null) {
                // 还没配对不算失败，别在首次启动时红一片
                wantConnection = false
                _state.value = SyncState.Idle
                return@launch
            }
            open(peer.host, peer.port, ClientHello(
                mode = "resume",
                did = repo.prefs.deviceId,
                name = repo.prefs.deviceName,
                nonce = ""
            ), peer)
        }
    }

    /** 扫码后首次配对 */
    fun pair(payload: PairingPayload) {
        wantConnection = true
        scope.launch {
            if (payload.v != PROTOCOL_VERSION) {
                _state.value = SyncState.Failed("电脑端协议版本是 ${payload.v}，请两端都更新")
                return@launch
            }
            open(
                payload.host, payload.port,
                ClientHello(
                    mode = "pair",
                    did = repo.prefs.deviceId,
                    name = repo.prefs.deviceName,
                    nonce = ""
                ),
                peer = null,
                pairing = payload
            )
        }
    }

    fun disconnect() {
        wantConnection = false
        reconnectJob?.cancel()
        socket?.close(1000, "用户断开")
        socket = null
        codec = null
        scope.launch { transferMgr.clearLink() }
        _state.value = SyncState.Idle
    }

    private fun open(
        host: String,
        port: Int,
        helloTemplate: ClientHello,
        peer: PeerEntity?,
        pairing: PairingPayload? = null
    ) {
        socket?.cancel()
        _state.value = SyncState.Connecting

        val clientNonce = Crypto.randomNonce()
        val hello = helloTemplate.copy(nonce = clientNonce.base64())
        val request = Request.Builder().url("ws://$host:$port").build()

        socket = http.newWebSocket(request, Listener(hello, clientNonce, peer, pairing, host, port))
    }

    private fun scheduleReconnect() {
        if (!wantConnection) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            // 固定退避即可：局域网断连基本是熄屏或换网，多等一会儿反而更省电
            delay(5_000)
            if (wantConnection && !isConnected) connect()
        }
    }

    // ── 发送 ──────────────────────────────────────────────

    /** 手动推送指定条目 */
    fun pushItems(itemIds: List<String>) {
        scope.launch {
            val changes = repo.attachImages(repo.collectItemsForPush(itemIds))
            if (changes.items.isEmpty()) return@launch
            sendPush(changes)
        }
    }

    /** 本地 auto 分类有改动时调用，把增量推给电脑 */
    fun pushAutoChanges() {
        scope.launch {
            val peer = repo.primaryPeer() ?: return@launch
            val changes = repo.attachImages(repo.collectAutoChanges(peer.lastSyncAt))
            if (changes.items.isEmpty() && changes.collections.isEmpty()) return@launch
            sendPush(changes)
        }
    }

    private fun sendPush(changes: ChangeSet) {
        send(PushMessage(changes.collections, changes.items, System.currentTimeMillis()))
    }

    private fun send(message: SyncMessage): Boolean {
        val ws = socket ?: return false
        val frame = codec?.encode(ProtocolJson.encodeToString(message)) ?: return false
        return ws.send(frame.toByteString())
    }

    // ── 连接回调 ──────────────────────────────────────────

    private inner class Listener(
        private val hello: ClientHello,
        private val clientNonce: ByteArray,
        private val peer: PeerEntity?,
        private val pairing: PairingPayload?,
        private val host: String,
        private val port: Int
    ) : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            // 握手的头两条消息是明文，此时还没有密钥
            webSocket.send(ProtocolJson.encodeToString(hello))
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val ack = runCatching { ProtocolJson.decodeFromString<ServerHelloOrError>(text) }
                .getOrElse {
                    fail(webSocket, "电脑端回了看不懂的握手报文")
                    return
                }

            if (ack.t == "error") {
                fail(webSocket, ack.message.ifEmpty { "握手被拒绝（${ack.code}）" })
                return
            }
            if (ack.t != "hello-ack" || ack.v != PROTOCOL_VERSION) {
                fail(webSocket, "协议版本不符，请两端都更新")
                return
            }

            val serverNonce = ack.nonce.decodeBase64OrNull()
            if (serverNonce == null) {
                fail(webSocket, "握手随机数无效")
                return
            }

            val sessionKey = when {
                pairing != null -> Crypto.deriveSessionKey(pairing.code, clientNonce, serverNonce)
                peer != null -> peer.sessionKey
                else -> {
                    fail(webSocket, "缺少配对信息")
                    return
                }
            }

            codec = FrameCodec(Crypto.deriveTransportKey(sessionKey, clientNonce, serverNonce))
            transferMgr.setLink(object : TransferLink {
                override val deviceId: String get() = ack.did
                override val deviceName: String get() = ack.name.ifEmpty { host }
                override fun sendMessage(message: SyncMessage): Boolean = this@SyncManager.send(message)
                override suspend fun sendChunk(payload: ByteArray) {
                    val ws = socket ?: throw IOException("连接已断开")
                    val frame = codec?.encodeBinary(payload) ?: throw IOException("未加密的连接")
                    var sent = false
                    while (!sent) {
                        sent = ws.send(frame.toByteString())
                        if (!sent) delay(6)
                    }
                }
            })
            _state.value = SyncState.Connected(ack.name.ifEmpty { host })

            scope.launch {
                if (pairing != null) {
                    repo.savePeer(
                        PeerEntity(
                            id = ack.did,
                            name = ack.name,
                            host = host,
                            port = port,
                            sessionKey = sessionKey,
                            pairedAt = System.currentTimeMillis(),
                            lastSyncAt = 0
                        )
                    )
                    _notices.emit("已与「${ack.name}」配对")
                } else {
                    // IP 可能变过，记下这次连通的地址
                    repo.updatePeerAddress(ack.did, host, port)
                }
                peerId = ack.did
                pushAutoChanges()
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val frame = try {
                codec?.decode(bytes.toByteArray()) ?: return
            } catch (e: Exception) {
                // 解密失败说明密钥对不上，继续连着也没意义
                Log.w(TAG, "帧解密失败", e)
                fail(webSocket, "数据校验失败，请重新配对")
                return
            }

            when (frame) {
                is JsonFrame -> {
                    val message = runCatching { ProtocolJson.decodeFromString<SyncMessage>(frame.text) }
                        .getOrElse {
                            Log.w(TAG, "无法解析同步消息", it)
                            return
                        }
                    scope.launch { lock.withLock { handle(message) } }
                }
                is BinaryFrame -> {
                    scope.launch { lock.withLock { transferMgr.handleBinary(frame.data) } }
                }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "连接失败", t)
            if (socket !== webSocket) return
            socket = null
            codec = null
            scope.launch { transferMgr.clearLink() }
            _state.value = SyncState.Failed(t.message ?: "连接失败")
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (socket !== webSocket) return
            socket = null
            codec = null
            scope.launch { transferMgr.clearLink() }
            if (wantConnection) {
                _state.value = SyncState.Failed("连接已断开")
                scheduleReconnect()
            } else {
                _state.value = SyncState.Idle
            }
        }

        private fun fail(webSocket: WebSocket, reason: String) {
            _state.value = SyncState.Failed(reason)
            wantConnection = false
            webSocket.close(1000, reason)
            if (socket === webSocket) {
                socket = null
                codec = null
                scope.launch { transferMgr.clearLink() }
            }
        }
    }

    private suspend fun handle(message: SyncMessage) {
        when (message) {
            is PingMessage -> send(PongMessage)
            is PongMessage -> Unit

            is ReadyMessage -> Unit

            is PushMessage -> {
                val result = repo.applyChanges(ChangeSet(message.collections, message.items))
                send(PushAck(result.accepted, result.needImages, message.sentAt))
                // 注意不要用 message.sentAt 推进自己的 lastSyncAt：那是电脑的钟。
                // lastSyncAt 只表示"本机变更已推送到哪"，只能由自己的 push 被 ack 时推进。
                if (result.accepted > 0) _notices.emit("收到 ${result.accepted} 项")
            }

            is PushAck -> {
                peerId?.let { repo.advanceLastSync(it, message.sentAt) }
                if (message.needImages.isNotEmpty()) {
                    val ids = repo.itemIdsByImageHash(message.needImages)
                    if (ids.isNotEmpty()) pushItems(ids)
                }
            }

            is PullMessage -> {
                val changes = repo.attachImages(repo.collectAutoChanges(message.since))
                sendPush(changes)
            }

            // 文件传输类消息交给状态机处理
            is FileOffer,
            is FileAccept,
            is FileReject,
            is FileDone,
            is FileAck,
            is FileCancel -> transferMgr.handleMessage(message)
        }
    }
}

private fun ByteArray.base64(): String =
    android.util.Base64.encodeToString(this, android.util.Base64.NO_WRAP)

private fun String.decodeBase64OrNull(): ByteArray? = runCatching {
    android.util.Base64.decode(this, android.util.Base64.DEFAULT)
}.getOrNull()?.takeIf { it.size == NONCE_BYTES }
