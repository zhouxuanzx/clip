package cool.clip.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * 表结构与桌面端 SQLite 对齐（字段名换成驼峰）。
 * 手机端不需要 maxItems / builtin / sortOrder(条目) 这些桌面专属的东西，去掉了。
 */

@Entity(tableName = "collections")
data class CollectionEntity(
    @PrimaryKey val id: String,
    val name: String,
    /** clipboard / list / todo */
    val kind: String,
    val sortOrder: Int,
    /** off / manual / auto */
    val syncMode: String,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean
)

@Entity(
    tableName = "items",
    indices = [Index("collectionId"), Index("updatedAt")]
)
data class ItemEntity(
    @PrimaryKey val id: String,
    val collectionId: String,
    /** text / image */
    val type: String,
    /** 文本正文；图片时是 files/images 下的文件名 */
    val content: String,
    val hash: String,
    val width: Int?,
    val height: Int?,
    val size: Long,
    val pinned: Boolean,
    val done: Boolean,
    val sourceApp: String?,
    val originDevice: String,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean
)

/** 配对过的桌面端。手机同时只主动连一台，但允许存多台切换 */
@Entity(tableName = "peers")
data class PeerEntity(
    @PrimaryKey val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val sessionKey: ByteArray,
    val pairedAt: Long,
    /** 本机变更已经推送到哪个时刻（本机时钟），只由自己的 push 被 ack 时推进 */
    val lastSyncAt: Long
) {
    // ByteArray 在 data class 里默认按引用比较，Room 的差量更新会误判，这里改成按内容
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PeerEntity) return false
        return id == other.id &&
            name == other.name &&
            host == other.host &&
            port == other.port &&
            sessionKey.contentEquals(other.sessionKey) &&
            pairedAt == other.pairedAt &&
            lastSyncAt == other.lastSyncAt
    }

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + name.hashCode()
        result = 31 * result + host.hashCode()
        result = 31 * result + port
        result = 31 * result + sessionKey.contentHashCode()
        result = 31 * result + pairedAt.hashCode()
        result = 31 * result + lastSyncAt.hashCode()
        return result
    }
}
