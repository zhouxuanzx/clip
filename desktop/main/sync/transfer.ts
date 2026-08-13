import { EventEmitter } from 'node:events'
import { createHash, type Hash } from 'node:crypto'
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type {
  FileAccept,
  FileAck,
  FileCancel,
  FileDone,
  FileOffer,
  FileReject,
  FileTransfer,
  SyncMessage
} from '@shared/sync'
import { CHUNK_HEADER_BYTES, FILE_CHUNK_BYTES } from '@shared/sync'

/**
 * 文件传输。刻意不走同步库——剪贴板条目是"两端要保持一致的状态"，
 * 需要 LWW 合并和墓碑；文件是"一次性的动作"，发过去就完了。
 * 混在一起会让两边的逻辑都变得没法维护。
 *
 * 流程：offer → accept → 若干二进制分片 → done(带 hash) → ack。
 * 同一台设备的发送任务排队串行，不并发——一条 socket 上交错传几个文件，
 * 每个都慢，进度条还看不出个所以然。
 */

/** 一条连接的发送能力，由 SyncServer 提供 */
export interface TransferLink {
  deviceId: string
  deviceName: string
  sendMessage(message: SyncMessage): boolean
  /** 发一片二进制。Promise 在数据真正写进 socket 后兑现，背压全靠它 */
  sendChunk(payload: Buffer): Promise<void>
}

export interface TransferEvents {
  changed: []
  /** 接收完成，参数是落盘路径 */
  received: [path: string, name: string]
}

interface Outgoing {
  id: number
  record: FileTransfer
  path: string
  canceled: boolean
  /** 等待对端 accept/reject 的兑现函数 */
  settle: ((error: string | null) => void) | null
  /** 等待对端 file-ack 的兑现函数；超时兜底由 run 处理 */
  ack: ((message: FileAck | null) => void) | null
}

interface Incoming {
  id: number
  record: FileTransfer
  handle: FileHandle
  partPath: string
  finalPath: string
  hash: Hash
  received: number
}

/** 进度变化很密集，攒一攒再通知界面 */
const PROGRESS_FLUSH_MS = 150

/** 发送端发完 file-done 后，等对方 file-ack 的最长时间；超时没回就乐观认为已送达 */
const ACK_TIMEOUT_MS = 10_000

export class FileTransferManager extends EventEmitter<TransferEvents> {
  private readonly links = new Map<string, TransferLink>()
  private readonly outgoing = new Map<string, Map<number, Outgoing>>()
  private readonly incoming = new Map<string, Map<number, Incoming>>()
  /** 每台设备的待发队列，队头传完才发下一个 */
  private readonly queues = new Map<string, Outgoing[]>()
  private readonly busy = new Set<string>()

  /** 界面上的记录，按 key 存，完成后仍保留 */
  private readonly records: FileTransfer[] = []
  private keySeq = 0
  /** 服务端占偶数号，手机占奇数号，双向同时传也不会撞 */
  private nextId = 0

  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private downloadDir: string) {
    super()
  }

  /** 用户在设置里改了接收目录，只影响之后开始的传输 */
  setDownloadDir(dir: string): void {
    this.downloadDir = dir
  }

  list(): FileTransfer[] {
    return this.records.map((record) => ({ ...record }))
  }

  clearFinished(): void {
    const alive = this.records.filter((record) => isActive(record.state))
    this.records.length = 0
    this.records.push(...alive)
    this.flush()
  }

  registerLink(link: TransferLink): void {
    this.links.set(link.deviceId, link)
    this.pump(link.deviceId)
  }

  /** 连接断了：在途的全部标失败，残片删掉 */
  async unregisterLink(deviceId: string): Promise<void> {
    this.links.delete(deviceId)

    for (const out of this.outgoing.get(deviceId)?.values() ?? []) {
      out.canceled = true
      out.settle?.('连接已断开')
      out.ack?.(null)
      this.finishRecord(out.record, 'failed', '连接已断开')
    }
    this.outgoing.delete(deviceId)

    // 先把在途的接收残片真正删掉，再标失败——这样界面看到 failed 时文件已不在
    const incs = [...(this.incoming.get(deviceId)?.values() ?? [])]
    this.incoming.delete(deviceId)
    await Promise.all(incs.map((inc) => this.discard(inc)))
    for (const inc of incs) this.finishRecord(inc.record, 'failed', '连接已断开')

    for (const queued of this.queues.get(deviceId) ?? []) {
      this.finishRecord(queued.record, 'failed', '连接已断开')
    }
    this.queues.delete(deviceId)
    this.busy.delete(deviceId)
  }

  // ── 发送 ────────────────────────────────────────────────────

  /** 把文件排进某台设备的发送队列，返回排上的数量 */
  async enqueue(deviceId: string, paths: string[]): Promise<number> {
    const link = this.links.get(deviceId)
    if (!link) return 0

    let queued = 0
    for (const path of paths) {
      const info = await stat(path).catch(() => null)
      // 目录得先打包，这里只发单文件；用户拖进来一个文件夹就跳过
      if (!info?.isFile()) continue

      const id = this.allocateId()
      const out: Outgoing = {
        id,
        path,
        canceled: false,
        settle: null,
        ack: null,
        record: this.createRecord({
          deviceId,
          deviceName: link.deviceName,
          direction: 'send',
          name: basename(path),
          size: info.size,
          path
        })
      }

      const queue = this.queues.get(deviceId) ?? []
      queue.push(out)
      this.queues.set(deviceId, queue)
      queued += 1
    }

    this.flush()
    this.pump(deviceId)
    return queued
  }

  cancel(key: string): void {
    for (const [deviceId, byId] of this.outgoing) {
      for (const out of byId.values()) {
        if (out.record.key !== key) continue
        out.canceled = true
        out.settle?.('已取消')
        this.links.get(deviceId)?.sendMessage({ t: 'file-cancel', id: out.id, reason: '发送方取消' })
        this.finishRecord(out.record, 'canceled', '已取消')
        byId.delete(out.id)
        this.release(deviceId)
        return
      }
    }

    for (const [deviceId, byId] of this.incoming) {
      for (const inc of byId.values()) {
        if (inc.record.key !== key) continue
        this.links.get(deviceId)?.sendMessage({ t: 'file-cancel', id: inc.id, reason: '接收方取消' })
        void this.discard(inc)
        this.finishRecord(inc.record, 'canceled', '已取消')
        byId.delete(inc.id)
        return
      }
    }

    // 还在队列里没发出去的，直接摘掉
    for (const [deviceId, queue] of this.queues) {
      const index = queue.findIndex((out) => out.record.key === key)
      if (index < 0) continue
      const [out] = queue.splice(index, 1)
      this.finishRecord(out.record, 'canceled', '已取消')
      this.pump(deviceId)
      return
    }
  }

  /** 取队头开传，一台设备同时只有一个在途 */
  private pump(deviceId: string): void {
    if (this.busy.has(deviceId)) return
    const queue = this.queues.get(deviceId)
    const out = queue?.shift()
    if (!out) return

    const link = this.links.get(deviceId)
    if (!link) {
      this.finishRecord(out.record, 'failed', '连接已断开')
      return
    }

    this.busy.add(deviceId)
    const byId = this.outgoing.get(deviceId) ?? new Map<number, Outgoing>()
    byId.set(out.id, out)
    this.outgoing.set(deviceId, byId)

    // 不在 run 里收尾：对端的 ack 比 done 晚到，收尾交给 onAck / onCancel
    // / unregisterLink。这条链路在 ack 回来前一直占着（串行），不让队列
    // 里的下一个文件上来。
    void this.run(link, out)
  }

  private release(deviceId: string): void {
    this.busy.delete(deviceId)
    this.pump(deviceId)
  }

  /** 一笔发送彻底结束：移出在途表、释放链路，让队列里的下一个上 */
  private completeOut(deviceId: string, out: Outgoing): void {
    this.outgoing.get(deviceId)?.delete(out.id)
    this.busy.delete(deviceId)
    this.pump(deviceId)
  }

  private async run(link: TransferLink, out: Outgoing): Promise<void> {
    const offer: FileOffer = {
      t: 'file-offer',
      id: out.id,
      name: out.record.name,
      size: out.record.size,
      mime: mimeOf(out.record.name)
    }
    // 先挂上兑现函数再发 offer：对端可能在同一轮事件循环里就回了 accept，
    // 那时候 settle 还没赋值的话这笔传输就永远卡住了
    const settled = new Promise<string | null>((resolve) => {
      out.settle = resolve
    })
    if (!link.sendMessage(offer)) {
      this.finishRecord(out.record, 'failed', '连接已断开')
      this.completeOut(link.deviceId, out)
      return
    }

    const rejection = await settled
    out.settle = null
    if (rejection !== null) {
      this.finishRecord(out.record, out.canceled ? 'canceled' : 'failed', rejection)
      this.completeOut(link.deviceId, out)
      return
    }

    out.record.state = 'active'
    this.flush()

    try {
      const hash = await this.stream(link, out)
      if (out.canceled) return

      // 等对方的 file-ack。把收尾挪到 run 里做，onAck 只负责兑现这个承诺，
      // 这样 ack 超时也能在这里统一兜底。
      const acked = new Promise<FileAck | null>((resolve) => {
        out.ack = resolve
      })
      if (!link.sendMessage({ t: 'file-done', id: out.id, hash })) {
        out.ack = null
        this.finishRecord(out.record, 'failed', '连接已断开')
        this.completeOut(link.deviceId, out)
        return
      }

      let ack: FileAck | null = null
      try {
        ack = await withTimeout(ACK_TIMEOUT_MS, () => acked)
      } catch {
        ack = null
      }
      out.ack = null
      if (out.canceled) return

      if (ack) {
        this.finishRecord(out.record, ack.ok ? 'done' : 'failed', ack.ok ? '' : (ack.message || '对方未能保存'))
        this.completeOut(link.deviceId, out)
      } else if (this.outgoing.get(link.deviceId)?.has(out.id)) {
        // 一直没回 ack：连接多半已断，但分片都发出去了、hash 也随 done 带走，
        // 偏向认为已送达，避免误报"失败"（真校验失败对端会回 ack(false)）
        this.finishRecord(out.record, 'done', '已发送，对方未回确认，可能已收到')
        this.completeOut(link.deviceId, out)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      link.sendMessage({ t: 'file-cancel', id: out.id, reason })
      this.finishRecord(out.record, 'failed', reason)
      this.completeOut(link.deviceId, out)
    }
  }

  private async stream(link: TransferLink, out: Outgoing): Promise<string> {
    const handle = await open(out.path, 'r')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(FILE_CHUNK_BYTES)
    let offset = 0

    try {
      while (offset < out.record.size) {
        if (out.canceled) throw new Error('已取消')

        const { bytesRead } = await handle.read(buffer, 0, FILE_CHUNK_BYTES, offset)
        if (bytesRead === 0) throw new Error('文件在发送途中被截短了')

        const slice = buffer.subarray(0, bytesRead)
        hash.update(slice)

        const payload = Buffer.allocUnsafe(CHUNK_HEADER_BYTES + bytesRead)
        payload.writeUInt32BE(out.id, 0)
        payload.writeBigUInt64BE(BigInt(offset), 4)
        slice.copy(payload, CHUNK_HEADER_BYTES)

        await link.sendChunk(payload)

        offset += bytesRead
        out.record.transferred = offset
        this.touch()
      }
    } finally {
      await handle.close()
    }

    return hash.digest('hex')
  }

  // ── 接收 ────────────────────────────────────────────────────

  async handleMessage(deviceId: string, message: SyncMessage): Promise<void> {
    switch (message.t) {
      case 'file-offer':
        await this.onOffer(deviceId, message)
        break
      case 'file-accept':
        this.onAccept(deviceId, message)
        break
      case 'file-reject':
        this.onReject(deviceId, message)
        break
      case 'file-done':
        await this.onDone(deviceId, message)
        break
      case 'file-ack':
        this.onAck(deviceId, message)
        break
      case 'file-cancel':
        await this.onCancel(deviceId, message)
        break
      default:
        break
    }
  }

  /** 二进制帧：[4B 编号][8B 偏移][字节] */
  async handleChunk(deviceId: string, payload: Buffer): Promise<void> {
    if (payload.length < CHUNK_HEADER_BYTES) return

    const id = payload.readUInt32BE(0)
    const offset = Number(payload.readBigUInt64BE(4))
    const inc = this.incoming.get(deviceId)?.get(id)
    if (!inc) return

    // 分片是严格顺序发的，对不上说明中间丢了帧，继续写只会得到一个坏文件
    if (offset !== inc.received) {
      this.links.get(deviceId)?.sendMessage({
        t: 'file-cancel',
        id,
        reason: `分片错位（期望 ${inc.received}，收到 ${offset}）`
      })
      await this.discard(inc)
      this.finishRecord(inc.record, 'failed', '分片错位')
      this.incoming.get(deviceId)?.delete(id)
      return
    }

    const data = payload.subarray(CHUNK_HEADER_BYTES)
    try {
      await inc.handle.write(data, 0, data.length, offset)
    } catch {
      // 句柄可能刚被取消/断线关掉，这一片写不进去已无意义
      return
    }
    inc.hash.update(data)
    inc.received += data.length
    inc.record.transferred = inc.received
    this.touch()
  }

  private async onOffer(deviceId: string, offer: FileOffer): Promise<void> {
    const link = this.links.get(deviceId)
    if (!link) return

    const reject = (reason: string): void => {
      link.sendMessage({ t: 'file-reject', id: offer.id, reason } satisfies FileReject)
    }

    if (!Number.isSafeInteger(offer.size) || offer.size < 0) {
      reject('文件大小无效')
      return
    }

    try {
      await mkdir(this.downloadDir, { recursive: true })
      // 文件名完全由对端提供，只取基名再洗一遍，不能让它跳出接收目录
      const finalPath = await uniquePath(this.downloadDir, safeName(offer.name))
      const partPath = `${finalPath}.part`
      const handle = await open(partPath, 'w')

      const inc: Incoming = {
        id: offer.id,
        handle,
        partPath,
        finalPath,
        hash: createHash('sha256'),
        received: 0,
        record: this.createRecord({
          deviceId,
          deviceName: link.deviceName,
          direction: 'receive',
          name: basename(finalPath),
          size: offer.size,
          path: finalPath
        })
      }
      inc.record.state = 'active'

      const byId = this.incoming.get(deviceId) ?? new Map<number, Incoming>()
      byId.set(offer.id, inc)
      this.incoming.set(deviceId, byId)

      link.sendMessage({ t: 'file-accept', id: offer.id } satisfies FileAccept)
      this.flush()
    } catch (err) {
      reject(err instanceof Error ? err.message : '无法创建文件')
    }
  }

  private onAccept(deviceId: string, message: FileAccept): void {
    this.outgoing.get(deviceId)?.get(message.id)?.settle?.(null)
  }

  private onReject(deviceId: string, message: FileReject): void {
    this.outgoing.get(deviceId)?.get(message.id)?.settle?.(message.reason || '对方拒绝接收')
  }

  private async onDone(deviceId: string, message: FileDone): Promise<void> {
    const link = this.links.get(deviceId)
    const inc = this.incoming.get(deviceId)?.get(message.id)
    if (!inc) return
    this.incoming.get(deviceId)?.delete(message.id)

    const ack = (ok: boolean, text: string): void => {
      link?.sendMessage({ t: 'file-ack', id: message.id, ok, message: text } satisfies FileAck)
    }

    try {
      await inc.handle.close()
    } catch {
      // 关不上也要继续走校验分支，让记录有个明确结局
    }

    const actual = inc.hash.digest('hex')
    if (actual !== message.hash) {
      await rm(inc.partPath, { force: true })
      this.finishRecord(inc.record, 'failed', '校验不通过，文件已丢弃')
      ack(false, '校验不通过')
      return
    }

    try {
      await rename(inc.partPath, inc.finalPath)
    } catch (err) {
      await rm(inc.partPath, { force: true })
      const reason = err instanceof Error ? err.message : '重命名失败'
      this.finishRecord(inc.record, 'failed', reason)
      ack(false, reason)
      return
    }

    this.finishRecord(inc.record, 'done', '')
    ack(true, '')
    this.emit('received', inc.finalPath, inc.record.name)
  }

  private onAck(deviceId: string, message: FileAck): void {
    const out = this.outgoing.get(deviceId)?.get(message.id)
    if (!out) return
    // 收尾在 run 里做，这里只兑现 ack 承诺
    out.ack?.(message)
  }

  private async onCancel(deviceId: string, message: FileCancel): Promise<void> {
    const reason = message.reason || '对方取消了'

    const out = this.outgoing.get(deviceId)?.get(message.id)
    if (out) {
      out.canceled = true
      out.settle?.(reason)
      out.ack?.(null)
      this.finishRecord(out.record, 'canceled', reason)
      this.completeOut(deviceId, out)
    }

    const inc = this.incoming.get(deviceId)?.get(message.id)
    if (inc) {
      // 先从表上摘掉，再异步关句柄：否则关句柄的那一瞬间若还有分片送达，
      // handleChunk 会拿到一个正在关闭的句柄去写，报 EBADF
      this.incoming.get(deviceId)?.delete(message.id)
      await this.discard(inc)
      this.finishRecord(inc.record, 'canceled', reason)
    }
  }

  private async discard(inc: Incoming): Promise<void> {
    await inc.handle.close().catch(() => undefined)
    await rm(inc.partPath, { force: true })
  }

  // ── 记录与通知 ──────────────────────────────────────────────

  private allocateId(): number {
    // 偶数区间归服务端，且 4 字节存得下
    this.nextId = (this.nextId + 2) % 0xfffffffe
    return this.nextId
  }

  private createRecord(
    seed: Pick<FileTransfer, 'deviceId' | 'deviceName' | 'direction' | 'name' | 'size' | 'path'>
  ): FileTransfer {
    this.keySeq += 1
    const record: FileTransfer = {
      ...seed,
      key: `t${this.keySeq}`,
      transferred: 0,
      state: 'waiting',
      error: '',
      startedAt: Date.now()
    }
    this.records.unshift(record)
    return record
  }

  private finishRecord(record: FileTransfer, state: FileTransfer['state'], error: string): void {
    if (!isActive(record.state)) return
    record.state = state
    record.error = error
    if (state === 'done') record.transferred = record.size
    this.flush()
  }

  /** 进度用，攒批通知 */
  private touch(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.dirty) {
        this.dirty = false
        this.emit('changed')
      }
    }, PROGRESS_FLUSH_MS)
  }

  /** 状态变化用，立刻通知 */
  private flush(): void {
    this.dirty = false
    this.emit('changed')
  }
}

function isActive(state: FileTransfer['state']): boolean {
  return state === 'waiting' || state === 'active'
}

/** 给一个会兑现的 promise 加超时；超时就 reject（不残留定时器） */
function withTimeout<T>(ms: number, producer: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    producer().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** 只取基名，再挡掉路径分隔符和控制字符 */
export function safeName(raw: string): string {
  const base = basename(raw.replace(/\\/g, '/')).trim()
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '未命名文件'
  return cleaned.slice(0, 180)
}

/** 重名时加 (1)(2)，不覆盖已有文件 */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name

  for (let i = 0; i < 1000; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem} (${i})${ext}`)
    const exists = await stat(candidate).then(
      () => true,
      () => false
    )
    const partExists = await stat(`${candidate}.part`).then(
      () => true,
      () => false
    )
    if (!exists && !partExists) return candidate
  }
  return join(dir, `${Date.now()}-${name}`)
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk': 'application/vnd.android.package-archive'
}

/** 安卓侧要靠 mime 决定文件进哪个 MediaStore 集合，值得多写这几行 */
export function mimeOf(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream'
}
