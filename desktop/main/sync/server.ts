import { EventEmitter } from 'node:events'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Database } from 'better-sqlite3'
import type {
  ClientHello,
  FileMessage,
  HandshakeError,
  PairedDevice,
  PairingPayload,
  PushAck,
  PushMessage,
  ServerHello,
  SyncMessage
} from '@shared/sync'
import { DEFAULT_PORT, PROTOCOL_VERSION } from '@shared/sync'
import {
  applyChanges,
  attachImages,
  collectAutoChanges,
  collectItemsForPush,
  getDevice,
  listDevices,
  markSynced,
  touchDevice,
  upsertDevice,
  type ImageSink
} from '../db'
import {
  deriveSessionKey,
  deriveTransportKey,
  FrameCodec,
  generatePairingCode,
  randomNonce
} from './crypto'
import type { FileTransferManager, TransferLink } from './transfer'

/** 配对窗口的有效期，过期自动关闭，避免二维码长期有效 */
const PAIRING_TTL_MS = 3 * 60 * 1000
/** 心跳间隔，两个周期没响应就断开 */
const HEARTBEAT_MS = 20_000

interface Connection {
  socket: WebSocket
  deviceId: string
  deviceName: string
  codec: FrameCodec
  alive: boolean
}

export interface SyncServerEvents {
  changed: []
  /** 收到远端变更并写入本地 */
  applied: [count: number]
}

/** 文件消息交给 FileTransferManager，同步消息留在本类处理 */
function isFileMessage(message: SyncMessage): message is FileMessage {
  return message.t.startsWith('file-')
}

/**
 * 局域网同步服务端。
 *
 * 握手：明文交换 hello（各带一个 16 字节随机数）→ 双方派生本次连接的传输密钥
 * → 之后全部走加密帧。密钥不对时 GCM 解密必然失败，这本身就是身份认证，
 * 不需要额外的挑战应答。
 */
export class SyncServer extends EventEmitter<SyncServerEvents> {
  private wss: WebSocketServer | null = null
  private port = 0
  private readonly connections = new Map<string, Connection>()
  private heartbeat: NodeJS.Timeout | null = null

  /** 当前开放的配对码，null 表示不接受新设备 */
  private pairingCode: string | null = null
  private pairingExpiry = 0
  private pairingTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: Database,
    private readonly images: ImageSink,
    private readonly selfId: () => string,
    private readonly selfName: () => string,
    private readonly transfers: FileTransferManager
  ) {
    super()
  }

  get listeningPort(): number {
    return this.port
  }

  get isRunning(): boolean {
    return this.wss !== null
  }

  get isPairing(): boolean {
    return this.pairingCode !== null && Date.now() < this.pairingExpiry
  }

  async start(preferredPort = DEFAULT_PORT): Promise<void> {
    if (this.wss) return

    this.port = await new Promise<number>((resolve, reject) => {
      const server = new WebSocketServer({ port: preferredPort, maxPayload: 32 * 1024 * 1024 })
      server.once('listening', () => {
        this.wss = server
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : preferredPort)
      })
      server.once('error', (err: NodeJS.ErrnoException) => {
        // 端口被占用就顺延一个，实际端口写进二维码，客户端不受影响
        if (err.code === 'EADDRINUSE' && preferredPort < DEFAULT_PORT + 20) {
          server.close()
          this.start(preferredPort + 1).then(() => resolve(this.port), reject)
        } else {
          reject(err)
        }
      })
    })

    this.wss!.on('connection', (socket, request) => {
      this.handleConnection(socket, request.socket.remoteAddress ?? null)
    })

    this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_MS)
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    this.heartbeat = null
    this.pairingTimer = null

    for (const conn of this.connections.values()) conn.socket.close()
    this.connections.clear()
    this.wss?.close()
    this.wss = null
    this.port = 0
  }

  /** 开一个限时的配对窗口，返回二维码要编码的内容 */
  openPairing(): PairingPayload | null {
    const host = primaryAddress()
    if (!host || !this.wss) return null

    this.pairingCode = generatePairingCode()
    this.pairingExpiry = Date.now() + PAIRING_TTL_MS

    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    this.pairingTimer = setTimeout(() => this.closePairing(), PAIRING_TTL_MS)

    return {
      v: PROTOCOL_VERSION,
      host,
      port: this.port,
      did: this.selfId(),
      name: this.selfName(),
      code: this.pairingCode
    }
  }

  closePairing(): void {
    this.pairingCode = null
    this.pairingExpiry = 0
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    this.pairingTimer = null
    this.emit('changed')
  }

  listPairedDevices(): PairedDevice[] {
    return listDevices(this.db).map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      pairedAt: device.pairedAt,
      lastSeen: device.lastSeen,
      lastSyncAt: device.lastSyncAt,
      online: this.connections.has(device.id)
    }))
  }

  /** 当前在线的设备 id */
  onlineDevices(): string[] {
    return [...this.connections.keys()]
  }

  /** 发文件。不指定设备就发给第一台在线的——同一份文件群发没什么意义 */
  async sendFiles(paths: string[], deviceId?: string): Promise<number> {
    const target = deviceId ?? this.onlineDevices()[0]
    if (!target) return 0
    return this.transfers.enqueue(target, paths)
  }

  /** 手动推送指定条目到某台设备（不传则推给所有在线设备） */
  pushItems(itemIds: string[], deviceId?: string): number {
    const changes = attachImages(collectItemsForPush(this.db, itemIds), this.images)
    if (changes.items.length === 0) return 0

    const message: PushMessage = { ...changes, t: 'push', sentAt: Date.now() }
    return this.sendToDevices(message, deviceId)
  }

  /** 把 auto 分类的增量推给某台设备 */
  private pushAutoChanges(deviceId: string): void {
    const device = getDevice(this.db, deviceId)
    if (!device) return

    const changes = attachImages(collectAutoChanges(this.db, device.lastSyncAt), this.images)
    if (changes.items.length === 0 && changes.collections.length === 0) return

    this.send(deviceId, { ...changes, t: 'push', sentAt: Date.now() })
  }

  /** 本地数据变了，广播给所有在线设备（只涉及 auto 分类） */
  broadcastAutoChanges(): void {
    for (const deviceId of this.connections.keys()) this.pushAutoChanges(deviceId)
  }

  private sendToDevices(message: SyncMessage, deviceId?: string): number {
    const targets = deviceId ? [deviceId] : [...this.connections.keys()]
    let sent = 0
    for (const id of targets) {
      if (this.send(id, message)) sent += 1
    }
    return sent
  }

  private send(deviceId: string, message: SyncMessage): boolean {
    const conn = this.connections.get(deviceId)
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false
    try {
      conn.socket.send(conn.codec.encode(message))
      return true
    } catch (err) {
      console.error('[sync] 发送失败：', err)
      return false
    }
  }

  private handleConnection(socket: WebSocket, address: string | null): void {
    // 握手完成前只接受一条明文 hello，超时就断开，防止空连接堆积
    const timeout = setTimeout(() => socket.close(), 10_000)

    socket.once('message', (raw: Buffer) => {
      clearTimeout(timeout)
      try {
        this.handleHello(socket, JSON.parse(raw.toString('utf8')) as ClientHello, address)
      } catch (err) {
        console.error('[sync] 握手失败：', err)
        this.rejectHandshake(socket, 'bad-request', '握手报文无法解析')
      }
    })

    socket.on('error', (err) => console.error('[sync] 连接错误：', err))
  }

  private handleHello(socket: WebSocket, hello: ClientHello, address: string | null): void {
    if (hello.t !== 'hello' || hello.v !== PROTOCOL_VERSION) {
      this.rejectHandshake(socket, 'version', `需要协议版本 ${PROTOCOL_VERSION}`)
      return
    }

    const clientNonce = Buffer.from(hello.nonce, 'base64')
    const serverNonce = randomNonce()

    let sessionKey: Buffer

    if (hello.mode === 'pair') {
      if (!this.isPairing || !this.pairingCode) {
        this.rejectHandshake(socket, 'no-pairing', '桌面端没有开启配对')
        return
      }
      sessionKey = deriveSessionKey(this.pairingCode, clientNonce, serverNonce)
      upsertDevice(this.db, {
        id: hello.did,
        name: hello.name,
        platform: hello.platform,
        sessionKey,
        lastAddress: address,
        pairedAt: Date.now(),
        lastSeen: Date.now()
      })
      // 一次配对码只用一次
      this.closePairing()
    } else {
      const device = getDevice(this.db, hello.did)
      if (!device || device.sessionKey.length === 0) {
        this.rejectHandshake(socket, 'unknown-device', '设备未配对，请重新扫码')
        return
      }
      sessionKey = device.sessionKey
      touchDevice(this.db, hello.did, address)
    }

    const ack: ServerHello = {
      t: 'hello-ack',
      v: PROTOCOL_VERSION,
      did: this.selfId(),
      name: this.selfName(),
      nonce: serverNonce.toString('base64')
    }
    socket.send(JSON.stringify(ack))

    const codec = new FrameCodec(deriveTransportKey(sessionKey, clientNonce, serverNonce))
    this.registerConnection(socket, hello, codec)
  }

  /** 握手不通过：回一条明文错误让对端能提示用户，再断开 */
  private rejectHandshake(
    socket: WebSocket,
    code: HandshakeError['code'],
    message: string
  ): void {
    const error: HandshakeError = { t: 'error', code, message }
    try {
      socket.send(JSON.stringify(error))
    } catch {
      // 对端可能已经断了，忽略
    }
    socket.close()
  }

  private registerConnection(socket: WebSocket, hello: ClientHello, codec: FrameCodec): void {
    // 同一设备重连时踢掉旧连接
    this.connections.get(hello.did)?.socket.close()

    const conn: Connection = {
      socket,
      deviceId: hello.did,
      deviceName: hello.name,
      codec,
      alive: true
    }
    this.connections.set(hello.did, conn)

    socket.removeAllListeners('message')
    socket.on('message', (raw: Buffer) => this.handleFrame(conn, raw))
    socket.on('close', () => {
      if (this.connections.get(hello.did) === conn) this.connections.delete(hello.did)
      this.transfers.unregisterLink(hello.did)
      this.emit('changed')
    })

    this.transfers.registerLink(this.linkFor(conn))

    const device = getDevice(this.db, hello.did)
    this.send(hello.did, { t: 'ready', lastSyncAt: device?.lastSyncAt ?? 0 })
    this.emit('changed')

    // 连上就把 auto 分类的积压变更推过去
    this.pushAutoChanges(hello.did)
  }

  private linkFor(conn: Connection): TransferLink {
    return {
      deviceId: conn.deviceId,
      deviceName: conn.deviceName,
      sendMessage: (message) => this.send(conn.deviceId, message),
      sendChunk: (payload) =>
        new Promise<void>((resolve, reject) => {
          if (conn.socket.readyState !== conn.socket.OPEN) {
            reject(new Error('连接已断开'))
            return
          }
          // ws 的 send 回调在数据真正写进 socket 后才触发，这就是背压：
          // 不等它就会把整个文件读进内存排队，大文件直接把进程撑爆
          conn.socket.send(conn.codec.encodeBinary(payload), (err) =>
            err ? reject(err) : resolve()
          )
        })
    }
  }

  private handleFrame(conn: Connection, raw: Buffer): void {
    let message: SyncMessage
    try {
      const frame = conn.codec.decode(raw)
      conn.alive = true

      if (frame.kind === 'binary') {
        void this.transfers.handleChunk(conn.deviceId, frame.data)
        return
      }
      message = frame.value as SyncMessage
    } catch (err) {
      // 解密失败意味着对方拿不出正确密钥，直接断开
      console.error('[sync] 帧解密失败，断开连接：', err)
      conn.socket.close()
      return
    }

    if (isFileMessage(message)) {
      void this.transfers.handleMessage(conn.deviceId, message)
      return
    }

    switch (message.t) {
      case 'ping':
        this.send(conn.deviceId, { t: 'pong' })
        break

      case 'pong':
        break

      case 'push': {
        const result = applyChanges(
          this.db,
          { collections: message.collections, items: message.items },
          this.images
        )
        const ack: PushAck = {
          t: 'push-ack',
          accepted: result.accepted,
          needImages: result.needImages,
          sentAt: message.sentAt
        }
        this.send(conn.deviceId, ack)
        // 注意不要用对端的 sentAt 推进 lastSyncAt：那是对端的钟。
        // lastSyncAt 的语义是"我已经把本机哪个时刻之前的变更发给它了"，
        // 只能由自己发出的 push 被 ack 时推进，否则时钟偏差会让本机变更被跳过。
        if (result.accepted > 0) this.emit('applied', result.accepted)
        break
      }

      case 'push-ack':
        markSynced(this.db, conn.deviceId, message.sentAt)
        if (message.needImages.length > 0) this.resendImages(conn.deviceId, message.needImages)
        break

      case 'pull': {
        const changes = attachImages(collectAutoChanges(this.db, message.since), this.images)
        this.send(conn.deviceId, { ...changes, t: 'push', sentAt: Date.now() })
        break
      }

      case 'ready':
        break
    }
  }

  /** 对端缺图片时按 hash 找到对应条目重发一次，这次会带上 PNG 字节 */
  private resendImages(deviceId: string, hashes: string[]): void {
    if (hashes.length === 0) return

    const ids = this.db
      .prepare<string[], { id: string }>(
        `SELECT id FROM items
          WHERE type = 'image' AND deleted = 0
            AND hash IN (${hashes.map(() => '?').join(',')})`
      )
      .all(...hashes)
      .map((row) => row.id)

    if (ids.length > 0) this.pushItems(ids, deviceId)
  }

  private pingAll(): void {
    for (const [deviceId, conn] of this.connections) {
      if (!conn.alive) {
        conn.socket.terminate()
        this.connections.delete(deviceId)
        continue
      }
      conn.alive = false
      this.send(deviceId, { t: 'ping' })
    }
  }
}

/** 局域网地址，排除回环和虚拟网卡 */
export function localAddresses(): string[] {
  const result: string[] = []
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    // VirtualBox / VMware / WSL 的虚拟网卡手机连不上，过滤掉
    if (/^(vEthernet|VirtualBox|VMware|Loopback|docker|br-|veth)/i.test(name)) continue
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) result.push(info.address)
    }
  }
  return result
}

/** 多网卡时优先选私有网段地址 */
function primaryAddress(): string | null {
  const all = localAddresses()
  const priv = all.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))
  return priv ?? all[0] ?? null
}
