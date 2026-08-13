import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FileTransfer, SyncMessage } from '@shared/sync'
import { CHUNK_HEADER_BYTES } from '@shared/sync'
import { FileTransferManager, mimeOf, safeName, type TransferLink } from './transfer'

/**
 * 两个 manager 直接对接，中间不过 WebSocket。
 * 消息一律异步投递，模拟真实网络——同步投递会掩盖时序 bug。
 */
class Wire {
  readonly desktop: FileTransferManager
  readonly phone: FileTransferManager
  /** 丢弃之后的所有投递，用来模拟断线 */
  private cut = false

  constructor(desktopDir: string, phoneDir: string) {
    this.desktop = new FileTransferManager(desktopDir)
    this.phone = new FileTransferManager(phoneDir)

    this.desktop.registerLink(this.linkTo(this.phone, 'desktop', '手机'))
    this.phone.registerLink(this.linkTo(this.desktop, 'phone', '电脑'))
  }

  /** 返回的 link 装在 owner 上，发出的东西送到 target */
  private linkTo(target: FileTransferManager, senderId: string, name: string): TransferLink {
    const deliver = (fn: () => Promise<void>): void => {
      if (this.cut) return
      setTimeout(() => {
        if (!this.cut) void fn()
      }, 0)
    }

    return {
      deviceId: senderId === 'desktop' ? 'phone' : 'desktop',
      deviceName: name,
      sendMessage: (message: SyncMessage) => {
        if (this.cut) return false
        // 过一遍 JSON，确保真的只依赖可序列化的字段
        const copy = JSON.parse(JSON.stringify(message)) as SyncMessage
        deliver(() => target.handleMessage(senderId, copy))
        return true
      },
      sendChunk: (payload: Buffer) =>
        new Promise<void>((resolve, reject) => {
          if (this.cut) {
            reject(new Error('连接已断开'))
            return
          }
          const copy = Buffer.from(payload)
          deliver(() => target.handleChunk(senderId, copy))
          setTimeout(resolve, 0)
        })
    }
  }

  disconnect(): void {
    this.cut = true
    this.desktop.unregisterLink('phone')
    this.phone.unregisterLink('desktop')
  }
}

/** 轮询等到条件成立，比固定 sleep 稳 */
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时')
}

function settled(manager: FileTransferManager): FileTransfer[] {
  return manager.list().filter((t) => t.state !== 'waiting' && t.state !== 'active')
}

describe('文件名清洗', () => {
  it('剥掉目录，只留基名', () => {
    expect(safeName('/etc/passwd')).toBe('passwd')
    expect(safeName('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts')
  })

  it('挡住路径穿越', () => {
    expect(safeName('../../../.bashrc')).toBe('.bashrc')
    expect(safeName('..')).toBe('未命名文件')
    expect(safeName('')).toBe('未命名文件')
  })

  it('替换掉 Windows 不接受的字符', () => {
    expect(safeName('a:b*c?d.txt')).toBe('a_b_c_d.txt')
  })

  it('超长文件名会被截断', () => {
    expect(safeName('x'.repeat(500)).length).toBeLessThanOrEqual(180)
  })
})

describe('mime 推断', () => {
  it('常见扩展名认得出来', () => {
    expect(mimeOf('a.PNG')).toBe('image/png')
    expect(mimeOf('片子.mp4')).toBe('video/mp4')
  })

  it('不认识的一律当二进制流', () => {
    expect(mimeOf('a.qwerty')).toBe('application/octet-stream')
    expect(mimeOf('README')).toBe('application/octet-stream')
  })
})

describe('文件传输', () => {
  let desktopDir: string
  let phoneDir: string
  let sourceDir: string
  let wire: Wire

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'clip-transfer-'))
    desktopDir = join(root, 'desktop')
    phoneDir = join(root, 'phone')
    sourceDir = join(root, 'src')
    await mkdtemp(join(tmpdir(), 'x-'))
    await writeFile(join(root, '.keep'), '')
    await import('node:fs/promises').then((fs) => fs.mkdir(sourceDir, { recursive: true }))
    wire = new Wire(desktopDir, phoneDir)
  })

  afterEach(async () => {
    wire.disconnect()
    await rm(desktopDir, { recursive: true, force: true })
    await rm(phoneDir, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  })

  async function makeFile(name: string, bytes: Buffer): Promise<string> {
    const path = join(sourceDir, name)
    await writeFile(path, bytes)
    return path
  }

  it('小文件原样送达', async () => {
    const content = Buffer.from('你好，文件传输 🎬', 'utf8')
    const path = await makeFile('note.txt', content)

    expect(await wire.desktop.enqueue('phone', [path])).toBe(1)
    await until(() => settled(wire.phone).length === 1)

    const received = settled(wire.phone)[0]
    expect(received.state).toBe('done')
    expect(received.direction).toBe('receive')
    expect(received.name).toBe('note.txt')
    expect(await readFile(join(phoneDir, 'note.txt'))).toEqual(content)
  })

  it('多分片的大文件也能对上字节', async () => {
    // 明确跨过 256KB 的分片边界，且不是整数倍
    const content = randomBytes(700 * 1024 + 123)
    const path = await makeFile('big.bin', content)

    await wire.desktop.enqueue('phone', [path])
    await until(() => settled(wire.phone).length === 1)

    expect(settled(wire.phone)[0].state).toBe('done')
    expect(await readFile(join(phoneDir, 'big.bin'))).toEqual(content)
  })

  it('空文件不会卡住', async () => {
    const path = await makeFile('empty.txt', Buffer.alloc(0))

    await wire.desktop.enqueue('phone', [path])
    await until(() => settled(wire.phone).length === 1)

    expect(settled(wire.phone)[0].state).toBe('done')
    expect(existsSync(join(phoneDir, 'empty.txt'))).toBe(true)
  })

  it('发送方收到 ack 后才算完成，两端记录一致', async () => {
    const path = await makeFile('note.txt', Buffer.from('hi'))

    await wire.desktop.enqueue('phone', [path])
    await until(() => settled(wire.desktop).length === 1)

    const sent = settled(wire.desktop)[0]
    expect(sent.state).toBe('done')
    expect(sent.direction).toBe('send')
    expect(sent.transferred).toBe(sent.size)
  })

  it('重名不覆盖，自动加序号', async () => {
    await writeFile(join(phoneDir, 'note.txt'), 'old').catch(async () => {
      await import('node:fs/promises').then((fs) => fs.mkdir(phoneDir, { recursive: true }))
      await writeFile(join(phoneDir, 'note.txt'), 'old')
    })

    const path = await makeFile('note.txt', Buffer.from('new'))
    await wire.desktop.enqueue('phone', [path])
    await until(() => settled(wire.phone).length === 1)

    expect(await readFile(join(phoneDir, 'note.txt'), 'utf8')).toBe('old')
    expect(await readFile(join(phoneDir, 'note (1).txt'), 'utf8')).toBe('new')
  })

  it('对端发来的文件名不能跳出接收目录', async () => {
    const content = Buffer.from('x')
    // 直接伪造一条 offer，绕过发送端的 basename
    await wire.phone.handleMessage('desktop', {
      t: 'file-offer',
      id: 2,
      name: '../../escaped.txt',
      size: content.length,
      mime: 'text/plain'
    })
    await until(() => wire.phone.list().length === 1 && wire.phone.list()[0].state === 'active')

    // 真的把这一片发过去，让传输走完——名子必须被洗回基名、落在接收目录里
    const payload = Buffer.alloc(CHUNK_HEADER_BYTES + content.length)
    payload.writeUInt32BE(2, 0)
    payload.writeBigUInt64BE(0n, 4)
    content.copy(payload, CHUNK_HEADER_BYTES)
    await wire.phone.handleChunk('desktop', payload)
    await wire.phone.handleMessage('desktop', {
      t: 'file-done',
      id: 2,
      hash: createHash('sha256').update(content).digest('hex')
    })
    await until(() => settled(wire.phone).length === 1)

    expect(existsSync(join(phoneDir, 'escaped.txt'))).toBe(true)
    // 没有跳出到父目录去
    expect(existsSync(join(phoneDir, '..', '..', 'escaped.txt'))).toBe(false)
  })

  it('同一台设备的多个文件串行传完，不会互相打断', async () => {
    const paths = await Promise.all([
      makeFile('a.bin', randomBytes(300 * 1024)),
      makeFile('b.bin', randomBytes(300 * 1024)),
      makeFile('c.bin', randomBytes(300 * 1024))
    ])

    expect(await wire.desktop.enqueue('phone', paths)).toBe(3)
    await until(() => settled(wire.phone).length === 3, 15_000)

    expect(settled(wire.phone).every((t) => t.state === 'done')).toBe(true)
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      expect(await readFile(join(phoneDir, name))).toEqual(await readFile(join(sourceDir, name)))
    }
  })

  it('目录会被跳过，只有真文件排得上队', async () => {
    expect(await wire.desktop.enqueue('phone', [sourceDir])).toBe(0)
    expect(await wire.desktop.enqueue('phone', [join(sourceDir, '不存在')])).toBe(0)
  })

  it('校验不通过时丢弃文件并回失败', async () => {
    const path = await makeFile('bad.bin', randomBytes(1024))
    await wire.desktop.enqueue('phone', [path])
    await until(() => wire.phone.list().length === 1)

    // 抢在真正的 file-done 之前送一个错 hash
    await wire.phone.handleMessage('desktop', {
      t: 'file-done',
      id: wire.desktop.list()[0].size >= 0 ? 2 : 2,
      hash: 'f'.repeat(64)
    })
    await until(() => settled(wire.phone).length === 1)

    const record = settled(wire.phone)[0]
    expect(record.state).toBe('failed')
    expect(record.error).toContain('校验')
    expect(existsSync(join(phoneDir, 'bad.bin'))).toBe(false)
    expect(existsSync(join(phoneDir, 'bad.bin.part'))).toBe(false)
  })

  it('取消发送后两端都不留残片', async () => {
    const path = await makeFile('cancel.bin', randomBytes(4 * 1024 * 1024))
    await wire.desktop.enqueue('phone', [path])
    await until(() => wire.desktop.list()[0].state === 'active')

    wire.desktop.cancel(wire.desktop.list()[0].key)
    await until(() => settled(wire.phone).length === 1, 10_000)

    expect(wire.desktop.list()[0].state).toBe('canceled')
    expect(settled(wire.phone)[0].state).toBe('canceled')
    expect(existsSync(join(phoneDir, 'cancel.bin'))).toBe(false)
    expect(existsSync(join(phoneDir, 'cancel.bin.part'))).toBe(false)
  })

  it('断线时在途的传输标为失败，残片清掉', async () => {
    const path = await makeFile('drop.bin', randomBytes(4 * 1024 * 1024))
    await wire.desktop.enqueue('phone', [path])
    await until(() => wire.phone.list().length === 1)

    wire.disconnect()
    await until(() => settled(wire.phone).length === 1)

    expect(settled(wire.phone)[0].state).toBe('failed')
    expect(settled(wire.desktop)[0].state).toBe('failed')
    expect(existsSync(join(phoneDir, 'drop.bin.part'))).toBe(false)
  })

  it('清理只删已结束的记录', async () => {
    const path = await makeFile('note.txt', Buffer.from('hi'))
    await wire.desktop.enqueue('phone', [path])
    await until(() => settled(wire.desktop).length === 1)

    wire.desktop.clearFinished()
    expect(wire.desktop.list()).toHaveLength(0)
  })
})
