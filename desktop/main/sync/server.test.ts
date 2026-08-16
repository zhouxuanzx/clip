import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { SyncMessage } from '@shared/sync'
import { FILE_CHUNK_BYTES, PROTOCOL_VERSION } from '@shared/sync'
import { openDatabase } from '../db'
import { upsertDevice } from '../db/devices'
import type { ImageSink } from '../db/sync'
import { deriveTransportKey, FrameCodec, randomNonce } from './crypto'
import { SyncServer } from './server'
import { FileTransferManager } from './transfer'

const images: ImageSink = {
  has: () => false,
  read: () => null,
  save: (hash) => `${hash}.png`
}

/**
 * 回归测试：手机连续发来的文件分片必须按序写盘。
 * 修 bug 前分片错位检查与写盘并发执行，后到的分片会在前一片写完前
 * 看到 received 未推进，误判「分片错位」终止传输。
 */
describe('SyncServer 文件接收', () => {
  let dir: string
  let server: SyncServer | null = null
  let ws: WebSocket | null = null

  afterEach(async () => {
    ws?.terminate()
    server?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('手机连发的分片按序落盘，file-ack ok', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clip-server-'))
    const db = openDatabase(':memory:')
    const transfers = new FileTransferManager(dir)

    const did = 'phone-test-1'
    const sessionKey = randomBytes(32)
    upsertDevice(db, {
      id: did,
      name: '测试手机',
      platform: 'android',
      sessionKey,
      lastAddress: null,
      pairedAt: Date.now(),
      lastSeen: Date.now()
    })

    server = new SyncServer(db, images, () => 'desktop-1', () => '测试电脑', transfers)
    await server.start(0)
    const port = server.listeningPort

    const fileData = randomBytes(FILE_CHUNK_BYTES * 2 + 123)
    const fileHash = createHash('sha256').update(fileData).digest('hex')
    const fileId = 3

    const clientNonce = randomNonce()
    const ack = await new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
      let codec: FrameCodec | null = null
      let stage: 'handshake' | 'waiting-accept' | 'sending' = 'handshake'

      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      ws = socket
      socket.on('error', (err) => reject(err))
      socket.on('close', () => reject(new Error('连接提前关闭')))

      socket.on('message', (raw: Buffer) => {
        try {
          if (stage === 'handshake') {
            const hello = JSON.parse(raw.toString('utf8'))
            if (hello.t !== 'hello-ack') throw new Error(`握手被拒：${hello.message ?? hello.t}`)
            const serverNonce = Buffer.from(hello.nonce, 'base64')
            codec = new FrameCodec(
              deriveTransportKey(sessionKey, clientNonce, serverNonce)
            )
            stage = 'waiting-accept'
            socket.send(
              codec.encode({
                t: 'file-offer',
                id: fileId,
                name: '回归测试.bin',
                size: fileData.length,
                mime: 'application/octet-stream'
              } satisfies SyncMessage)
            )
            return
          }

          const frame = codec!.decode(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))
          if (frame.kind !== 'json') return
          const msg = frame.value as SyncMessage

          if (msg.t === 'file-accept' && stage === 'waiting-accept') {
            stage = 'sending'
            // 像手机端一样同步连发，不等待任何回执——这正是触发竞态的条件
            let offset = 0
            while (offset < fileData.length) {
              const slice = fileData.subarray(offset, offset + FILE_CHUNK_BYTES)
              const payload = Buffer.alloc(12 + slice.length)
              payload.writeUInt32BE(fileId, 0)
              payload.writeBigUInt64BE(BigInt(offset), 4)
              slice.copy(payload, 12)
              socket.send(codec!.encodeBinary(payload))
              offset += slice.length
            }
            socket.send(
              codec!.encode({ t: 'file-done', id: fileId, hash: fileHash } satisfies SyncMessage)
            )
          } else if (msg.t === 'file-ack') {
            resolve({ ok: msg.ok, message: msg.message })
          } else if (msg.t === 'file-cancel') {
            reject(new Error(`传输被取消：${msg.reason}`))
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })

      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            t: 'hello',
            v: PROTOCOL_VERSION,
            mode: 'resume',
            did,
            name: '测试手机',
            platform: 'android',
            nonce: clientNonce.toString('base64')
          })
        )
      })
    })

    expect(ack.ok, ack.message).toBe(true)

    const onDisk = await readFile(join(dir, '回归测试.bin'))
    expect(onDisk.equals(fileData)).toBe(true)

    const record = transfers.list().find((t) => t.direction === 'receive')
    expect(record?.state).toBe('done')
    db.close()
  }, 15000)
})
