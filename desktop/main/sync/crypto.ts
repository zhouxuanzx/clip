import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import {
  FRAME_KIND_BINARY,
  FRAME_KIND_JSON,
  INFO_SESSION,
  INFO_TRANSPORT,
  IV_BYTES,
  KEY_BYTES,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  TAG_BYTES
} from '@shared/sync'

/**
 * 加密帧格式（与 Kotlin 端逐字节对齐）：
 *
 *   [1B 版本][1B 种类][12B IV][密文 …][16B GCM tag]
 *
 * 头两个字节作为 GCM 的 AAD 参与认证，改一位都会导致解密失败——
 * 否则中间人可以把控制帧的种类标成二进制，骗接收端当文件字节写进磁盘。
 *
 * 注意 tag 的位置：Java 的 Cipher 会把 tag 直接附在密文末尾，
 * Node 则是分开的 getAuthTag()。这里统一按 Java 的布局来，
 * Node 侧自己做拼接和切分，省得安卓端写特殊处理。
 *
 * IV 的 12 字节 = 4 字节连接前缀 + 8 字节递增计数器。
 * 每条连接都重新派生密钥，所以计数器从 0 开始也不会重复用同一 (key, iv)。
 */

/** 帧头：版本 + 种类 */
const HEADER_BYTES = 2

export type DecodedFrame =
  | { kind: 'json'; value: unknown }
  | { kind: 'binary'; data: Buffer }

export function randomNonce(): Buffer {
  return randomBytes(NONCE_BYTES)
}

/** 生成二维码里那个一次性配对密钥 */
export function generatePairingCode(): string {
  return randomBytes(KEY_BYTES).toString('base64url')
}

/**
 * 配对：从一次性 code 派生长期会话密钥，两端各存一份。
 * salt 必须是 客户端随机数 || 服务端随机数，顺序不能反。
 */
export function deriveSessionKey(
  pairingCode: string,
  clientNonce: Buffer,
  serverNonce: Buffer
): Buffer {
  return hkdf(Buffer.from(pairingCode, 'base64url'), clientNonce, serverNonce, INFO_SESSION)
}

/** 每次连接从长期会话密钥再派生一把只用于本次连接的传输密钥 */
export function deriveTransportKey(
  sessionKey: Buffer,
  clientNonce: Buffer,
  serverNonce: Buffer
): Buffer {
  return hkdf(sessionKey, clientNonce, serverNonce, INFO_TRANSPORT)
}

function hkdf(ikm: Buffer, clientNonce: Buffer, serverNonce: Buffer, info: string): Buffer {
  const salt = Buffer.concat([clientNonce, serverNonce])
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), KEY_BYTES))
}

/** 一条连接上的帧编解码器。持有本次连接的传输密钥与 IV 计数器。 */
export class FrameCodec {
  private readonly key: Buffer
  /** 本端发送用的 IV 前缀，连接建立时随机生成一次 */
  private readonly sendPrefix: Buffer
  private sendCounter = 0n
  /** 收到的最大计数器值，用于拒绝重放 */
  private lastRecvCounter = -1n
  private recvPrefix: Buffer | null = null

  constructor(key: Buffer) {
    this.key = key
    this.sendPrefix = randomBytes(4)
  }

  /** 控制消息帧 */
  encode(payload: unknown): Buffer {
    return this.seal(FRAME_KIND_JSON, Buffer.from(JSON.stringify(payload), 'utf8'))
  }

  /** 二进制帧，载荷由调用方自行组织（文件传输用 [4B 编号][8B 偏移][字节]） */
  encodeBinary(payload: Buffer): Buffer {
    return this.seal(FRAME_KIND_BINARY, payload)
  }

  private seal(kind: number, plain: Buffer): Buffer {
    const iv = Buffer.alloc(IV_BYTES)
    this.sendPrefix.copy(iv, 0)
    iv.writeBigUInt64BE(this.sendCounter, 4)
    this.sendCounter += 1n

    const header = Buffer.from([PROTOCOL_VERSION, kind])
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(header)
    const body = Buffer.concat([cipher.update(plain), cipher.final()])

    return Buffer.concat([header, iv, body, cipher.getAuthTag()])
  }

  decode(frame: Buffer): DecodedFrame {
    if (frame.length < HEADER_BYTES + IV_BYTES + TAG_BYTES) throw new Error('帧长度不足')
    if (frame[0] !== PROTOCOL_VERSION) throw new Error(`协议版本不符: ${frame[0]}`)

    const kind = frame[1]
    if (kind !== FRAME_KIND_JSON && kind !== FRAME_KIND_BINARY) {
      throw new Error(`未知的帧种类: ${kind}`)
    }

    const header = frame.subarray(0, HEADER_BYTES)
    const iv = frame.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES)
    const body = frame.subarray(HEADER_BYTES + IV_BYTES, frame.length - TAG_BYTES)
    const tag = frame.subarray(frame.length - TAG_BYTES)

    // 对端的 IV 前缀在本次连接内必须始终一致，计数器必须严格递增，
    // 否则就是重放或者中途换了发送方
    const prefix = iv.subarray(0, 4)
    const counter = iv.readBigUInt64BE(4)
    if (this.recvPrefix === null) {
      this.recvPrefix = Buffer.from(prefix)
    } else if (!this.recvPrefix.equals(prefix)) {
      throw new Error('IV 前缀突变')
    }
    if (counter <= this.lastRecvCounter) throw new Error('检测到重放帧')

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(body), decipher.final()])

    // 解密和校验都通过了才推进计数器，避免伪造帧影响正常序列
    this.lastRecvCounter = counter

    if (kind === FRAME_KIND_BINARY) return { kind: 'binary', data: plain }
    return { kind: 'json', value: JSON.parse(plain.toString('utf8')) }
  }
}
