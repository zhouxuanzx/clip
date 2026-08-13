package cool.clip.data

import android.content.Context
import android.util.Base64
import androidx.room.withTransaction
import cool.clip.sync.MAX_IMAGE_BYTES
import cool.clip.sync.SyncCollection
import cool.clip.sync.SyncItem
import kotlinx.coroutines.flow.Flow
import java.security.MessageDigest
import java.util.UUID

data class ChangeSet(
    val collections: List<SyncCollection>,
    val items: List<SyncItem>
)

data class ApplyResult(
    val accepted: Int,
    val needImages: List<String>
)

/**
 * 本地数据的唯一入口。同步的冲突解决与桌面端 desktop/main/db/sync.ts 一致：
 * LWW（updatedAt 大的胜），完全相同时比 id 字符串序——两端各自独立算也能得到同一结论。
 */
class Repository(context: Context) {
    private val db = ClipDatabase.get(context)
    private val dao = db.dao()
    val images = ImageStore(context)
    val prefs = Prefs(context)
    /** 暴露给文件传输等需要 Android 上下文的模块 */
    val context: Context = context

    fun observeCollections(): Flow<List<CollectionEntity>> = dao.observeCollections()
    suspend fun currentCollections(): List<CollectionEntity> = dao.listCollections()
    fun observeItems(collectionId: String): Flow<List<ItemEntity>> = dao.observeItems(collectionId)
    fun observePeers(): Flow<List<PeerEntity>> = dao.observePeers()

    suspend fun primaryPeer(): PeerEntity? = dao.primaryPeer()
    suspend fun savePeer(peer: PeerEntity) = dao.upsertPeer(peer)
    suspend fun forgetPeer(id: String) = dao.deletePeer(id)
    suspend fun updatePeerAddress(id: String, host: String, port: Int) =
        dao.updatePeerAddress(id, host, port)

    /** 只在自己发出的 push 被 ack 时调用，参数是本机时钟 */
    suspend fun advanceLastSync(peerId: String, at: Long) = dao.advanceLastSync(peerId, at)

    // ── 本地操作 ──────────────────────────────────────────

    /** 手动添加一条文本。同分类下内容重复时只刷新时间戳，返回受影响的条目 */
    suspend fun addText(collectionId: String, text: String): ItemEntity {
        val now = System.currentTimeMillis()
        val hash = sha256Hex(text.toByteArray(Charsets.UTF_8))

        dao.findByHash(collectionId, hash)?.let { existing ->
            val refreshed = existing.copy(createdAt = now, updatedAt = now)
            dao.updateItem(refreshed)
            return refreshed
        }

        val item = ItemEntity(
            id = UUID.randomUUID().toString(),
            collectionId = collectionId,
            type = "text",
            content = text,
            hash = hash,
            width = null,
            height = null,
            size = text.toByteArray(Charsets.UTF_8).size.toLong(),
            pinned = false,
            done = false,
            sourceApp = null,
            originDevice = prefs.deviceId,
            createdAt = now,
            updatedAt = now,
            deleted = false
        )
        dao.upsertItem(item)
        return item
    }

    suspend fun setDone(item: ItemEntity, done: Boolean) {
        dao.updateItem(item.copy(done = done, updatedAt = System.currentTimeMillis()))
    }

    suspend fun setPinned(item: ItemEntity, pinned: Boolean) {
        dao.updateItem(item.copy(pinned = pinned, updatedAt = System.currentTimeMillis()))
    }

    /** 软删除，留墓碑把删除传播给电脑 */
    suspend fun deleteItems(ids: List<String>) {
        if (ids.isEmpty()) return
        val doomed = dao.findItems(ids)
        dao.softDeleteItems(ids, System.currentTimeMillis())

        // 图片文件可能还被别的条目按 hash 复用，只删没人引用的
        val doomedImages = doomed.filter { it.type == "image" }
        if (doomedImages.isEmpty()) return
        val stillUsed = dao.findImageItemsByHash(doomedImages.map { it.hash }).map { it.content }.toSet()
        images.remove(doomedImages.map { it.content }.filterNot { it in stillUsed })
    }

    /** 清理超过保留期的墓碑 */
    suspend fun purgeTombstones(days: Int = 30) {
        val before = System.currentTimeMillis() - days * 24L * 3600 * 1000
        images.remove(dao.tombstoneImages(before))
        dao.purgeTombstones(before)
    }

    suspend fun findItems(ids: List<String>): List<ItemEntity> = dao.findItems(ids)

    // ── 打包待发送的变更 ──────────────────────────────────

    /** 手动推送：指定条目 + 它们所属的分类 */
    suspend fun collectItemsForPush(itemIds: List<String>): ChangeSet {
        if (itemIds.isEmpty()) return ChangeSet(emptyList(), emptyList())
        val items = dao.findItems(itemIds)
        if (items.isEmpty()) return ChangeSet(emptyList(), emptyList())
        val collections = dao.collectionsByIds(items.map { it.collectionId }.distinct())
        return ChangeSet(collections.map { it.toSync() }, items.map { it.toSync() })
    }

    /** 自动同步：since 之后、所有 auto 分类的变更 */
    suspend fun collectAutoChanges(since: Long): ChangeSet {
        val collections = dao.autoChangedCollections(since).toMutableList()
        val items = dao.autoChangedItems(since)

        // 分类本身没变但条目变了的情况，也得把分类带上，否则对端建不出来
        val known = collections.map { it.id }.toSet()
        val missing = items.map { it.collectionId }.distinct().filterNot { it in known }
        if (missing.isNotEmpty()) collections += dao.collectionsByIds(missing)

        return ChangeSet(collections.map { it.toSync() }, items.map { it.toSync() })
    }

    /** 给图片条目附上 PNG 字节，太大的跳过只发文字信息 */
    fun attachImages(changes: ChangeSet): ChangeSet = changes.copy(
        items = changes.items.map { item ->
            if (item.type != "image" || item.deleted) return@map item
            val png = images.read(item.content) ?: return@map item
            if (png.size > MAX_IMAGE_BYTES) return@map item
            item.copy(image = Base64.encodeToString(png, Base64.NO_WRAP))
        }
    )

    // ── 应用对端推来的变更 ────────────────────────────────

    suspend fun applyChanges(changes: ChangeSet): ApplyResult = db.withTransaction {
        changes.collections.forEach { applyCollection(it) }

        var accepted = 0
        val needImages = mutableListOf<String>()
        for (remote in changes.items) {
            val outcome = applyItem(remote)
            if (outcome.first) accepted++
            if (outcome.second) needImages += remote.hash
        }
        ApplyResult(accepted, needImages.distinct())
    }

    private suspend fun applyCollection(remote: SyncCollection) {
        val local = dao.findCollection(remote.id)
        if (local != null && !shouldOverwrite(local.updatedAt, local.id, remote.updatedAt, remote.id)) return

        if (local == null) {
            dao.upsertCollection(
                CollectionEntity(
                    id = remote.id,
                    name = remote.name,
                    kind = remote.kind,
                    sortOrder = dao.maxCollectionOrder() + 1,
                    syncMode = remote.syncMode,
                    createdAt = remote.updatedAt,
                    updatedAt = remote.updatedAt,
                    deleted = remote.deleted
                )
            )
            return
        }

        // sortOrder 是本机的菜单偏好，不跨设备覆盖
        dao.upsertCollection(
            local.copy(
                name = remote.name,
                kind = remote.kind,
                syncMode = remote.syncMode,
                updatedAt = remote.updatedAt,
                deleted = remote.deleted
            )
        )
    }

    /** 返回 (是否写入, 是否需要对端补发图片) */
    private suspend fun applyItem(remote: SyncItem): Pair<Boolean, Boolean> {
        // 分类没跟着过来就丢弃，等下一轮全量
        if (dao.findCollection(remote.collectionId) == null) return false to false

        val local = dao.findItem(remote.id)
        if (local != null && !shouldOverwrite(local.updatedAt, local.id, remote.updatedAt, remote.id)) {
            return false to false
        }

        var content = remote.content
        var needImage = false

        if (remote.type == "image" && !remote.deleted) {
            val png = remote.image
            if (png != null) {
                content = images.save(remote.hash, Base64.decode(png, Base64.DEFAULT))
            } else {
                content = "${remote.hash}.png"
                needImage = !images.has(content)
            }
        }

        dao.upsertItem(
            ItemEntity(
                id = remote.id,
                collectionId = remote.collectionId,
                type = remote.type,
                content = content,
                hash = remote.hash,
                width = remote.width,
                height = remote.height,
                size = remote.size,
                pinned = remote.pinned,
                done = remote.done,
                sourceApp = remote.sourceApp,
                originDevice = remote.originDevice,
                createdAt = remote.createdAt,
                updatedAt = remote.updatedAt,
                deleted = remote.deleted
            )
        )
        return true to needImage
    }

    /** 对端说缺图，按 hash 找回条目重发（这次会带上 PNG） */
    suspend fun itemIdsByImageHash(hashes: List<String>): List<String> =
        if (hashes.isEmpty()) emptyList() else dao.findImageItemsByHash(hashes).map { it.id }
}

private fun CollectionEntity.toSync() = SyncCollection(
    id = id, name = name, kind = kind, syncMode = syncMode, updatedAt = updatedAt, deleted = deleted
)

private fun ItemEntity.toSync() = SyncItem(
    id = id,
    collectionId = collectionId,
    type = type,
    content = content,
    hash = hash,
    width = width,
    height = height,
    size = size,
    pinned = pinned,
    done = done,
    sourceApp = sourceApp,
    originDevice = originDevice,
    createdAt = createdAt,
    updatedAt = updatedAt,
    deleted = deleted
)

/** 时间戳相同时用 id 字符串序打破平局，保证两端结论一致 */
private fun shouldOverwrite(
    localUpdatedAt: Long,
    localId: String,
    remoteUpdatedAt: Long,
    remoteId: String
): Boolean {
    if (remoteUpdatedAt != localUpdatedAt) return remoteUpdatedAt > localUpdatedAt
    return remoteId > localId
}

fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
