import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FRAME_KIND_BINARY,
  FRAME_KIND_JSON,
  IV_BYTES,
  PROTOCOL_VERSION,
  TAG_BYTES
} from '@shared/sync'
import {
  deriveSessionKey,
  deriveTransportKey,
  FrameCodec,
  generatePairingCode,
  randomNonce
} from './crypto'

/** 测试里绝大多数用例只关心控制消息，解包一下省得每处都判种类 */
function json(codec: FrameCodec, frame: Buffer): unknown {
  const decoded = codec.decode(frame)
  if (decoded.kind !== 'json') throw new Error('期望控制帧')
  return decoded.value
}

describe('密钥派生', () => {
  it('两端用相同的 code 和随机数派生出相同的会话密钥', () => {
    const code = generatePairingCode()
    const clientNonce = randomNonce()
    const serverNonce = randomNonce()

    const a = deriveSessionKey(code, clientNonce, serverNonce)
    const b = deriveSessionKey(code, clientNonce, serverNonce)
    expect(a.equals(b)).toBe(true)
    expect(a).toHaveLength(32)
  })

  it('随机数顺序反了就派生不出同一把密钥', () => {
    const code = generatePairingCode()
    const n1 = randomNonce()
    const n2 = randomNonce()
    expect(deriveSessionKey(code, n1, n2).equals(deriveSessionKey(code, n2, n1))).toBe(false)
  })

  it('配对密钥不同则会话密钥不同', () => {
    const n1 = randomNonce()
    const n2 = randomNonce()
    const a = deriveSessionKey(generatePairingCode(), n1, n2)
    const b = deriveSessionKey(generatePairingCode(), n1, n2)
    expect(a.equals(b)).toBe(false)
  })

  it('同一会话密钥在不同连接上派生出不同的传输密钥', () => {
    const session = deriveSessionKey(generatePairingCode(), randomNonce(), randomNonce())
    const first = deriveTransportKey(session, randomNonce(), randomNonce())
    const second = deriveTransportKey(session, randomNonce(), randomNonce())
    expect(first.equals(second)).toBe(false)
  })
})

describe('加密帧', () => {
  function pair(): [FrameCodec, FrameCodec] {
    const key = randomBytes(32)
    return [new FrameCodec(key), new FrameCodec(key)]
  }

  it('往返能还原原始对象', () => {
    const [sender, receiver] = pair()
    const payload = { t: 'push', items: [{ id: 'a', content: '中文内容 🎉' }] }
    expect(json(receiver, sender.encode(payload))).toEqual(payload)
  })

  it('帧的头部布局符合约定：1B 版本 + 1B 种类 + 12B IV，尾部 16B tag', () => {
    const [sender] = pair()
    const frame = sender.encode({ t: 'ping' })
    expect(frame[0]).toBe(PROTOCOL_VERSION)
    expect(frame[1]).toBe(FRAME_KIND_JSON)
    expect(frame.length).toBeGreaterThan(2 + IV_BYTES + TAG_BYTES)
  })

  it('连续多帧的 IV 计数器递增，同一前缀', () => {
    const [sender, receiver] = pair()
    const first = sender.encode({ n: 1 })
    const second = sender.encode({ n: 2 })

    expect(first.subarray(2, 6).equals(second.subarray(2, 6))).toBe(true)
    expect(second.readBigUInt64BE(6)).toBe(first.readBigUInt64BE(6) + 1n)
    expect(json(receiver, first)).toEqual({ n: 1 })
    expect(json(receiver, second)).toEqual({ n: 2 })
  })

  it('二进制帧原样还原，不经过 base64', () => {
    const [sender, receiver] = pair()
    const payload = randomBytes(64 * 1024)
    const decoded = receiver.decode(sender.encodeBinary(payload))

    expect(decoded.kind).toBe('binary')
    if (decoded.kind !== 'binary') return
    expect(decoded.data.equals(payload)).toBe(true)
  })

  it('控制帧和二进制帧共用一条计数器序列', () => {
    const [sender, receiver] = pair()
    const first = sender.encode({ n: 1 })
    const second = sender.encodeBinary(Buffer.from([1, 2, 3]))

    expect(second.readBigUInt64BE(6)).toBe(first.readBigUInt64BE(6) + 1n)
    expect(json(receiver, first)).toEqual({ n: 1 })
    expect(receiver.decode(second).kind).toBe('binary')
  })

  it('篡改种类字节会被 AAD 拦下——否则控制帧能被伪装成文件字节', () => {
    const [sender, receiver] = pair()
    const frame = sender.encode({ t: 'ping' })
    frame[1] = FRAME_KIND_BINARY
    expect(() => receiver.decode(frame)).toThrow()
  })

  it('未知的帧种类直接拒绝', () => {
    const [sender, receiver] = pair()
    const frame = sender.encode({ t: 'ping' })
    frame[1] = 9
    expect(() => receiver.decode(frame)).toThrow(/种类/)
  })

  it('密钥不对时解密失败——这就是隐式身份认证', () => {
    const sender = new FrameCodec(randomBytes(32))
    const receiver = new FrameCodec(randomBytes(32))
    expect(() => receiver.decode(sender.encode({ t: 'ping' }))).toThrow()
  })

  it('篡改密文会被 GCM 校验拦下', () => {
    const [sender, receiver] = pair()
    const frame = sender.encode({ t: 'push', items: [] })
    frame[20] ^= 0xff
    expect(() => receiver.decode(frame)).toThrow()
  })

  it('重放同一帧会被拒绝', () => {
    const [sender, receiver] = pair()
    const frame = sender.encode({ t: 'ping' })
    receiver.decode(frame)
    expect(() => receiver.decode(frame)).toThrow(/重放/)
  })

  it('乱序的旧帧会被拒绝', () => {
    const [sender, receiver] = pair()
    const first = sender.encode({ n: 1 })
    const second = sender.encode({ n: 2 })
    receiver.decode(second)
    expect(() => receiver.decode(first)).toThrow(/重放/)
  })

  it('中途换发送方（IV 前缀突变）会被拒绝', () => {
    const key = randomBytes(32)
    const receiver = new FrameCodec(key)
    receiver.decode(new FrameCodec(key).encode({ n: 1 }))
    // 另一个 codec 有不同的随机前缀
    expect(() => receiver.decode(new FrameCodec(key).encode({ n: 2 }))).toThrow(/前缀/)
  })

  it('二进制帧同样受重放保护', () => {
    const [sender, receiver] = pair()
    const frame = sender.encodeBinary(Buffer.from('chunk'))
    receiver.decode(frame)
    expect(() => receiver.decode(frame)).toThrow(/重放/)
  })

  it('版本不符直接报错', () => {
    const [sender, receiver] = pair()
    const frame = sender.encode({ t: 'ping' })
    frame[0] = 99
    expect(() => receiver.decode(frame)).toThrow(/版本/)
  })

  it('过短的帧不会导致越界读取', () => {
    const [, receiver] = pair()
    expect(() => receiver.decode(Buffer.alloc(5))).toThrow(/长度/)
  })

  it('能承载图片大小的 payload', () => {
    const [sender, receiver] = pair()
    const image = randomBytes(512 * 1024).toString('base64')
    const decoded = json(receiver, sender.encode({ t: 'push', image })) as { image: string }
    expect(decoded.image).toBe(image)
  })
})
