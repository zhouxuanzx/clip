package cool.clip.sync

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * 与桌面端 desktop/shared/sync.ts 一一对应的协议定义。
 *
 * 这个文件是复制过来的契约，字段名、常量、消息标签都不能自行改动。
 * 桌面端改了要同步改这里，并且两边一起升 PROTOCOL_VERSION。
 */

const val PROTOCOL_VERSION = 2
const val DEFAULT_PORT = 47653
const val MAX_IMAGE_BYTES = 5 * 1024 * 1024

const val INFO_SESSION = "clip-session-v1"
const val INFO_TRANSPORT = "clip-transport-v1"

const val KEY_BYTES = 32
const val NONCE_BYTES = 16
const val IV_BYTES = 12
const val TAG_BYTES = 16

/** 帧种类：控制消息是 JSON，文件分片是裸字节。两者都经过同一把传输密钥加密，
 *  但种类字节会作为 GCM 的 AAD，中间人没法把控制帧伪装成分片写进磁盘 */
const val FRAME_KIND_JSON = 0
const val FRAME_KIND_BINARY = 1

/** 文件分片头：4 字节传输编号 + 8 字节偏移（大端），后面紧跟文件字节 */
const val CHUNK_HEADER_BYTES = 12
const val FILE_CHUNK_BYTES = 256 * 1024

/** 单文件/单方向传输的状态。范围与桌面端 desktop/shared/sync.ts 保持一致 */
enum class TransferState {
    WAITING,
    ACTIVE,
    DONE,
    FAILED,
    CANCELED
}

/**
 * 一条传输记录在 UI 上的样子。字段顺序、命名刻意贴近桌面端的 FileTransfer，
 * 方便两端对看日志。path 在接收侧是 MediaStore 的 uri 字符串，发送侧是源 uri 串。
 */
data class FileTransfer(
    val key: String,
    val deviceId: String,
    val deviceName: String,
    val direction: String, // "send" | "receive"
    val name: String,
    val size: Long,
    val transferred: Long,
    val state: TransferState,
    val error: String,
    val path: String,
    val startedAt: Long
)

/**
 * explicitNulls 必须保持默认的 true：桌面端把 width/height/sourceApp 直接绑进 SQLite，
 * 字段缺失会变成 undefined 让 better-sqlite3 抛错，null 才是合法值。
 */
val ProtocolJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    classDiscriminator = "t"
}

/** 二维码里的内容 */
@Serializable
data class PairingPayload(
    val v: Int,
    val host: String,
    val port: Int,
    val did: String,
    val name: String,
    val code: String
)

/** 客户端 → 服务端，明文 */
@Serializable
data class ClientHello(
    val t: String = "hello",
    val v: Int = PROTOCOL_VERSION,
    /** "pair" 首次配对；"resume" 已配对重连 */
    val mode: String,
    val did: String,
    val name: String,
    val platform: String = "android",
    /** base64 的 16 字节随机数 */
    val nonce: String
)

/** 服务端 → 客户端的明文回应。t 可能是 "hello-ack" 或 "error" */
@Serializable
data class ServerHelloOrError(
    val t: String,
    val v: Int = 0,
    val did: String = "",
    val name: String = "",
    val nonce: String = "",
    val code: String = "",
    val message: String = ""
)

@Serializable
data class SyncCollection(
    val id: String,
    val name: String,
    val kind: String,
    val syncMode: String,
    val updatedAt: Long,
    val deleted: Boolean
)

@Serializable
data class SyncItem(
    val id: String,
    val collectionId: String,
    val type: String,
    val content: String,
    val hash: String,
    val width: Int? = null,
    val height: Int? = null,
    val size: Long,
    val pinned: Boolean,
    val done: Boolean,
    val sourceApp: String? = null,
    val originDevice: String,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean,
    /** PNG 字节的 base64，仅在对端可能缺文件时携带 */
    val image: String? = null
)

@Serializable
@JsonClassDiscriminator("t")
sealed interface SyncMessage

@Serializable
@SerialName("ready")
data class ReadyMessage(val lastSyncAt: Long) : SyncMessage

@Serializable
@SerialName("push")
data class PushMessage(
    val collections: List<SyncCollection>,
    val items: List<SyncItem>,
    val sentAt: Long
) : SyncMessage

@Serializable
@SerialName("push-ack")
data class PushAck(
    val accepted: Int,
    val needImages: List<String>,
    val sentAt: Long
) : SyncMessage

@Serializable
@SerialName("pull")
data class PullMessage(val since: Long) : SyncMessage

@Serializable
@SerialName("ping")
data object PingMessage : SyncMessage

@Serializable
@SerialName("pong")
data object PongMessage : SyncMessage

// ── 文件传输，刻意不走同步库：文件是一次性动作，不是要两端保持一致的状态 ──
// 协议：offer → accept → 若干二进制分片 → done(带 hash) → ack。
// 编号奇偶区分两端：桌面端占偶数，手机端占奇数，双向同时传也不会撞。

@Serializable
@SerialName("file-offer")
data class FileOffer(
    val id: Int,
    val name: String,
    val size: Long,
    val mime: String
) : SyncMessage

@Serializable
@SerialName("file-accept")
data class FileAccept(val id: Int) : SyncMessage

@Serializable
@SerialName("file-reject")
data class FileReject(val id: Int, val reason: String = "") : SyncMessage

@Serializable
@SerialName("file-done")
data class FileDone(val id: Int, val hash: String) : SyncMessage

@Serializable
@SerialName("file-ack")
data class FileAck(val id: Int, val ok: Boolean, val message: String = "") : SyncMessage

@Serializable
@SerialName("file-cancel")
data class FileCancel(val id: Int, val reason: String = "") : SyncMessage
