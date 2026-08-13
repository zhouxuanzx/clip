import { EventEmitter } from 'node:events'
import { clipboard, nativeImage } from 'electron'
import { sha256 } from './db/items'
import { win32, isWindows } from './win32'

export interface CapturedText {
  type: 'text'
  content: string
  hash: string
  size: number
  sourceApp: string | null
}

export interface CapturedImage {
  type: 'image'
  /** PNG 字节，由调用方决定落盘位置 */
  buffer: Buffer
  hash: string
  width: number
  height: number
  size: number
  sourceApp: string | null
}

export type Captured = CapturedText | CapturedImage

interface WatcherOptions {
  /** 轮询间隔。只比对一个整数，代价极低 */
  intervalMs?: number
  /** 防抖：一次复制常触发多次剪贴板变更 */
  debounceMs?: number
  /** 单条文本超过这个长度就截断，避免误复制整个文件内容撑爆库 */
  maxTextLength?: number
}

/**
 * 剪贴板监听。
 *
 * Windows 上先用 GetClipboardSequenceNumber 做廉价探测——那只是读一个整数，
 * CPU 开销可以忽略；序列号变了才去读真正的内容。非 Windows 平台没有这个 API，
 * 退化成直接读文本比对（图片在非 Windows 上不轮询，太贵）。
 */
export class ClipboardWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private lastSequence = 0
  private lastHash = ''
  private paused = false

  private readonly intervalMs: number
  private readonly debounceMs: number
  private readonly maxTextLength: number

  constructor(options: WatcherOptions = {}) {
    super()
    this.intervalMs = options.intervalMs ?? 400
    this.debounceMs = options.debounceMs ?? 150
    this.maxTextLength = options.maxTextLength ?? 100_000
  }

  start(): void {
    if (this.timer) return
    // 记下启动那一刻的状态，避免把启动前就在剪贴板里的内容当成新条目
    this.lastSequence = win32.getClipboardSequenceNumber()
    this.lastHash = this.currentTextHash()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.timer = null
    this.debounceTimer = null
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    // 恢复时把当前状态吃掉，暂停期间复制的东西（比如密码）不补录
    if (!paused) {
      this.lastSequence = win32.getClipboardSequenceNumber()
      this.lastHash = this.currentTextHash()
    }
  }

  /**
   * 应用自己写剪贴板（点击条目复制回去）时调用，
   * 否则会被当成用户的新复制动作又存一遍。
   */
  ignoreNext(): void {
    setTimeout(() => {
      this.lastSequence = win32.getClipboardSequenceNumber()
      this.lastHash = this.currentTextHash()
    }, 50)
  }

  private currentTextHash(): string {
    const text = clipboard.readText()
    return text ? sha256(text) : ''
  }

  private tick(): void {
    if (this.paused) return

    if (isWindows) {
      const seq = win32.getClipboardSequenceNumber()
      if (seq === this.lastSequence) return
      this.lastSequence = seq
    }

    // 一次 Ctrl+C 常触发多次变更（应用先清空再写入），等它稳定下来再读
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.capture(), this.debounceMs)
  }

  private capture(): void {
    if (this.paused) return

    try {
      const formats = clipboard.availableFormats()
      const sourceApp = this.readSourceApp()

      const text = clipboard.readText()
      if (text && text.trim()) {
        const content = text.length > this.maxTextLength ? text.slice(0, this.maxTextLength) : text
        const hash = sha256(content)
        if (hash === this.lastHash) return
        this.lastHash = hash
        this.emit('captured', {
          type: 'text',
          content,
          hash,
          size: Buffer.byteLength(content, 'utf8'),
          sourceApp
        } satisfies CapturedText)
        return
      }

      // readImage 是全量解码，只在确实有图片格式时才调
      if (!formats.some((f) => f.startsWith('image/'))) return

      const image = clipboard.readImage()
      if (image.isEmpty()) return

      const buffer = image.toPNG()
      const hash = sha256(buffer)
      if (hash === this.lastHash) return
      this.lastHash = hash

      const { width, height } = image.getSize()
      this.emit('captured', {
        type: 'image',
        buffer,
        hash,
        width,
        height,
        size: buffer.byteLength,
        sourceApp
      } satisfies CapturedImage)
    } catch (err) {
      // 剪贴板被别的进程独占时读取会抛错，跳过这一轮即可
      console.error('[clipboard] 读取失败：', err)
    }
  }

  private readSourceApp(): string | null {
    if (!isWindows) return null
    const title = win32.getWindowTitle(win32.getForegroundWindow())
    return title || null
  }
}

/** 把剪贴板内容写回系统剪贴板 */
export function writeToClipboard(type: 'text' | 'image', payload: string | Buffer): void {
  if (type === 'text') {
    clipboard.writeText(payload as string)
  } else {
    clipboard.writeImage(nativeImage.createFromBuffer(payload as Buffer))
  }
}
