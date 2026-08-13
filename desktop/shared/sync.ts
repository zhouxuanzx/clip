/**
 * 桌面端与安卓端之间的同步协议。
 *
 * 这个文件是两端共同的契约，Kotlin 侧必须逐字对齐。
 * 改动任何常量或字段名都要同步改安卓端，并且升 PROTOCOL_VERSION。
 */

export const PROTOCOL_VERSION = 2

/** 默认监听端口。被占用时会往后顺延，实际端口写在二维码里 */
export const DEFAULT_PORT = 47653

/** 单条图片的传输上限，超过就不推送（base64 会再膨胀 1/3） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

// ── 帧种类 ────────────────────────────────────────────────────
// 帧的第二个字节标明载荷类型。文件字节走二进制帧，不经过 base64——
// 大文件 base64 会白白多传 1/3，还要在两端各拷一遍字符串。

/** 载荷是 UTF-8 的控制消息 JSON */
export const FRAME_KIND_JSON = 0
/** 载荷是 [4B 传输编号][8B 偏移][文件字节] */
export const FRAME_KIND_BINARY = 1

/** 二进制帧里文件字节前面的头部长度 */
export const CHUNK_HEADER_BYTES = 12

/** 每片文件字节数。太小则帧开销占比高，太大则取消响应迟钝 */
export const FILE_CHUNK_BYTES = 256 * 1024

// ── 密钥派生参数 ───────────────────────────────────────────────
// 两端都用 HKDF-SHA256，salt 一律为 clientNonce || serverNonce（各 16 字节）

/** 配对时从二维码里的一次性 code 派生长期会话密钥 */
export const INFO_SESSION = 'clip-session-v1'
/** 每次连接从长期会话密钥派生本次连接专用的传输密钥 */
export const INFO_TRANSPORT = 'clip-transport-v1'

export const KEY_BYTES = 32
export const NONCE_BYTES = 16
/** AES-GCM 的 IV 长度 */
export const IV_BYTES = 12
/** AES-GCM 认证标签长度，密文末尾 */
export const TAG_BYTES = 16

// ── 二维码 ────────────────────────────────────────────────────

/** 二维码里编码的 JSON。手机扫到之后据此发起连接 */
export interface PairingPayload {
  v: number
  /** 桌面端局域网 IP */
  host: string
  port: number
  /** 桌面端设备 id */
  did: string
  /** 桌面端设备名 */
  name: string
  /** 一次性配对密钥，base64url 的 32 字节 */
  code: string
}

// ── 握手 ──────────────────────────────────────────────────────
// 握手的前两条消息是明文 JSON（此时还没有密钥）。
// 之后所有消息都是加密帧，解密成功本身就是身份证明——
// 密钥不对时 GCM 校验会失败，不需要额外的挑战应答。

export type HandshakeMode =
  /** 首次配对，客户端刚扫了码 */
  | 'pair'
  /** 已配对设备重连，双方各自用存下来的会话密钥 */
  | 'resume'

/** 客户端 → 服务端，明文 */
export interface ClientHello {
  t: 'hello'
  v: number
  mode: HandshakeMode
  /** 客户端设备 id */
  did: string
  name: string
  platform: 'android' | 'windows' | 'linux' | 'darwin'
  /** base64 的 16 字节随机数 */
  nonce: string
}

/** 服务端 → 客户端，明文 */
export interface ServerHello {
  t: 'hello-ack'
  v: number
  did: string
  name: string
  nonce: string
}

/** 服务端 → 客户端，明文。握手失败时回这个然后断开 */
export interface HandshakeError {
  t: 'error'
  /** unknown-device: 未配对却用了 resume；version: 协议版本不符 */
  code: 'unknown-device' | 'version' | 'no-pairing' | 'bad-request'
  message: string
}

// ── 业务消息（全部走加密帧）───────────────────────────────────

/** 同步时携带的分类信息，接收端按 id 建同名分类，保证两端 id 一致 */
export interface SyncCollection {
  id: string
  name: string
  kind: 'clipboard' | 'list' | 'todo'
  syncMode: 'off' | 'manual' | 'auto'
  updatedAt: number
  deleted: boolean
}

/** 同步时携带的条目。图片的 PNG 字节放在 image 字段里 */
export interface SyncItem {
  id: string
  collectionId: string
  type: 'text' | 'image'
  /** 文本正文；图片时是文件名 */
  content: string
  hash: string
  width: number | null
  height: number | null
  size: number
  pinned: boolean
  done: boolean
  sourceApp: string | null
  originDevice: string
  createdAt: number
  updatedAt: number
  deleted: boolean
  /** 图片的 PNG 字节，base64。仅 type='image' 且对端没有该文件时才带 */
  image?: string
}

/** 认证成功后服务端主动发的第一条加密消息 */
export interface ReadyMessage {
  t: 'ready'
  /** 服务端已知的、上次与该设备同步的时间点 */
  lastSyncAt: number
}

/** 推送一批条目（手动推送与自动同步共用） */
export interface PushMessage {
  t: 'push'
  /** 本批涉及的分类，接收端先 upsert 分类再写条目 */
  collections: SyncCollection[]
  items: SyncItem[]
  /** 发送方的时间戳，接收方回 ack 时带回，用于推进 lastSyncAt */
  sentAt: number
}

export interface PushAck {
  t: 'push-ack'
  /** 实际写入的条目数 */
  accepted: number
  /** 接收方缺失 PNG 文件的图片条目 hash，发送方补发 */
  needImages: string[]
  sentAt: number
}

/** 请求对端把 sync_mode='auto' 的分类里、since 之后的变更发过来 */
export interface PullMessage {
  t: 'pull'
  since: number
}

/** 心跳。局域网断连不一定触发 close 事件，靠它检测 */
export interface PingMessage {
  t: 'ping'
}
export interface PongMessage {
  t: 'pong'
}

// ── 文件传输 ──────────────────────────────────────────────────
// 文件不进同步库：剪贴板条目是"要两端保持一致的状态"，文件是"一次性的动作"，
// 混在一起会让 LWW 合并和墓碑逻辑变得没法维护。
//
// 传输编号在一条连接内分配，按奇偶分区间避免双向撞号：
// 服务端（桌面）用偶数，客户端（手机）用奇数。这样任何一条 file-* 消息
// 里的 id 都能唯一定位到一笔传输，不必再区分方向。

/** 发送方发起。此时还不知道 hash——大文件为了算它得先整读一遍，不值得 */
export interface FileOffer {
  t: 'file-offer'
  id: number
  name: string
  size: number
  mime: string
}

/** 接收方准备好了，发送方收到才开始发字节 */
export interface FileAccept {
  t: 'file-accept'
  id: number
}

export interface FileReject {
  t: 'file-reject'
  id: number
  reason: string
}

/** 发送方发完最后一片。hash 是边读边算出来的 SHA-256 */
export interface FileDone {
  t: 'file-done'
  id: number
  hash: string
}

/** 接收方落盘并校验完毕的回执 */
export interface FileAck {
  t: 'file-ack'
  id: number
  ok: boolean
  message: string
}

/** 任意一方中止，接收方收到后删掉残片 */
export interface FileCancel {
  t: 'file-cancel'
  id: number
  reason: string
}

export type FileMessage =
  | FileOffer
  | FileAccept
  | FileReject
  | FileDone
  | FileAck
  | FileCancel

export type SyncMessage =
  | ReadyMessage
  | PushMessage
  | PushAck
  | PullMessage
  | PingMessage
  | PongMessage
  | FileMessage

// ── 桌面端界面用的设备状态 ────────────────────────────────────

export interface PairedDevice {
  id: string
  name: string
  platform: string
  pairedAt: number
  lastSeen: number
  lastSyncAt: number
  online: boolean
}

export interface SyncServerStatus {
  running: boolean
  port: number
  /** 局域网地址列表，多网卡时不止一个 */
  addresses: string[]
  /** 配对二维码的 data URL，仅在配对模式开启时有值 */
  pairingQr: string | null
  devices: PairedDevice[]
}

// ── 传输列表用的状态 ──────────────────────────────────────────

export type TransferDirection = 'send' | 'receive'

/** waiting: 已发 offer 等对方接收；active: 正在传字节 */
export type TransferState = 'waiting' | 'active' | 'done' | 'failed' | 'canceled'

export interface FileTransfer {
  /** deviceId:id，一条连接内的 id 会复用，加上设备才唯一 */
  key: string
  deviceId: string
  deviceName: string
  direction: TransferDirection
  name: string
  size: number
  transferred: number
  state: TransferState
  /** 失败原因，成功时为空 */
  error: string
  /** 发送时是源文件路径，接收完成后是落盘路径 */
  path: string
  startedAt: number
}
