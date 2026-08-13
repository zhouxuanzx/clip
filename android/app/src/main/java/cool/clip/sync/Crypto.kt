package cool.clip.sync

import android.util.Base64
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 与桌面端 desktop/main/sync/crypto.ts 对齐的加密层。
 *
 * 帧格式：[1B 版本][1B 种类][12B IV][密文 …][16B GCM tag]
 * 前两字节作为 GCM 的 AAD 一起参与认证——否则中间人能把控制帧的种类
 * 改成二进制，骗接收端把内容当文件字节写进磁盘。
 *
 * IV = 4 字节连接前缀 + 8 字节大端递增计数器。
 */
object Crypto {
    private val random = SecureRandom()

    fun randomBytes(size: Int): ByteArray = ByteArray(size).also { random.nextBytes(it) }

    fun randomNonce(): ByteArray = randomBytes(NONCE_BYTES)

    /** 二维码里的 code 是 base64url 的 32 字节 */
    fun decodePairingCode(code: String): ByteArray =
        Base64.decode(code, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    fun deriveSessionKey(pairingCode: String, clientNonce: ByteArray, serverNonce: ByteArray): ByteArray =
        hkdf(decodePairingCode(pairingCode), clientNonce, serverNonce, INFO_SESSION)

    fun deriveTransportKey(sessionKey: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray): ByteArray =
        hkdf(sessionKey, clientNonce, serverNonce, INFO_TRANSPORT)

    /** salt 固定是 客户端随机数 || 服务端随机数，顺序不能反 */
    private fun hkdf(ikm: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray, info: String): ByteArray =
        hkdfSha256(ikm, clientNonce + serverNonce, info.toByteArray(Charsets.UTF_8), KEY_BYTES)

    /** RFC 5869，Java 标准库没有现成实现，手写一份 */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")

        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)

        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArrayOutputStream()
        var block = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            mac.update(block)
            mac.update(info)
            mac.update(counter.toByte())
            block = mac.doFinal()
            out.write(block)
            counter++
        }
        return out.toByteArray().copyOf(length)
    }
}

class FrameException(message: String) : Exception(message)

/** 解码后的帧：要么是 JSON 控制消息，要么是文件分片的裸字节 */
sealed interface DecodedFrame
data class JsonFrame(val text: String) : DecodedFrame
data class BinaryFrame(val data: ByteArray) : DecodedFrame

private const val HEADER_BYTES = 2

/** 一条连接上的帧编解码器，持有本次连接的传输密钥与 IV 计数器 */
class FrameCodec(key: ByteArray) {
    private val keySpec = SecretKeySpec(key, "AES")
    private val sendPrefix = Crypto.randomBytes(4)
    private var sendCounter = 0L
    private var lastRecvCounter = -1L
    private var recvPrefix: ByteArray? = null

    fun encode(json: String): ByteArray = seal(FRAME_KIND_JSON, json.toByteArray(Charsets.UTF_8))

    /** 二进制帧，载荷由调用方自行组织（文件分片：[4B 编号][8B 偏移][字节]） */
    fun encodeBinary(payload: ByteArray): ByteArray = seal(FRAME_KIND_BINARY, payload)

    private fun seal(kind: Int, plain: ByteArray): ByteArray {
        val iv = ByteArray(IV_BYTES)
        System.arraycopy(sendPrefix, 0, iv, 0, 4)
        ByteBuffer.wrap(iv, 4, 8).putLong(sendCounter)
        sendCounter++

        // 头两字节同时作为 AAD：种类被篡改会让 GCM 校验直接失败
        val header = byteArrayOf(PROTOCOL_VERSION.toByte(), kind.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, GCMParameterSpec(TAG_BYTES * 8, iv))
        cipher.updateAAD(header)
        // doFinal 的结果已经含 tag
        val body = cipher.doFinal(plain)

        return ByteArray(HEADER_BYTES + IV_BYTES + body.size).also {
            System.arraycopy(header, 0, it, 0, HEADER_BYTES)
            System.arraycopy(iv, 0, it, HEADER_BYTES, IV_BYTES)
            System.arraycopy(body, 0, it, HEADER_BYTES + IV_BYTES, body.size)
        }
    }

    fun decode(frame: ByteArray): DecodedFrame {
        if (frame.size < HEADER_BYTES + IV_BYTES + TAG_BYTES) throw FrameException("帧长度不足")
        if (frame[0].toInt() != PROTOCOL_VERSION) throw FrameException("协议版本不符: ${frame[0]}")

        val kind = frame[1].toInt() and 0xFF
        if (kind != FRAME_KIND_JSON && kind != FRAME_KIND_BINARY) throw FrameException("未知帧种类: $kind")

        val header = frame.copyOfRange(0, HEADER_BYTES)
        val iv = frame.copyOfRange(HEADER_BYTES, HEADER_BYTES + IV_BYTES)
        val body = frame.copyOfRange(HEADER_BYTES + IV_BYTES, frame.size)

        // 对端的 IV 前缀在本次连接内必须一致，计数器必须严格递增，否则就是重放
        val prefix = iv.copyOfRange(0, 4)
        val known = recvPrefix
        if (known == null) recvPrefix = prefix
        else if (!known.contentEquals(prefix)) throw FrameException("IV 前缀突变")

        val counter = ByteBuffer.wrap(iv, 4, 8).long
        if (counter <= lastRecvCounter) throw FrameException("检测到重放帧")

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keySpec, GCMParameterSpec(TAG_BYTES * 8, iv))
        cipher.updateAAD(header)
        val plain = cipher.doFinal(body)

        // 校验通过才推进计数器，伪造帧不该影响正常序列
        lastRecvCounter = counter
        return if (kind == FRAME_KIND_BINARY) BinaryFrame(plain) else JsonFrame(String(plain, Charsets.UTF_8))
    }
}
