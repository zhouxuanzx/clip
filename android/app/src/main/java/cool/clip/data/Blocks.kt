package cool.clip.data

import android.net.Uri
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 一条笔记的内容模型：从「一段文字 + 一堆图」升级为「一串块」，
 * 文本块与图片块可以任意顺序穿插（文字→图→文字→图）。
 *
 * 这是持久化形态——图片块只存文件名（images 目录下的 hash.png），不存字节。
 */
@Serializable
sealed interface Block {
    @Serializable
    @SerialName("text")
    data class Text(val text: String) : Block

    @Serializable
    @SerialName("image")
    data class Image(val name: String) : Block
}

/**
 * 编辑器内部的块。和 [Block] 的区别是：图片块可能还没落盘（只有 uri、还没算出 name）。
 * 这个类型只在 UI → Repository 之间传，不参与序列化。
 */
sealed interface SaveBlock {
    data class Text(val text: String) : SaveBlock
    data class Image(val name: String? = null, val uri: Uri? = null) : SaveBlock
}

/** 块序列的 JSON 序列化。用 "t" 作判别字段，与同步协议保持一致 */
val BlockJson = Json {
    ignoreUnknownKeys = true
    classDiscriminator = "t"
    encodeDefaults = true
}
