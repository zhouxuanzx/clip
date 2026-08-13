package cool.clip.data

import android.content.Context
import java.io.File

/** 图片按内容 hash 命名，重名即同图，天然去重。与桌面端规则一致。 */
class ImageStore(context: Context) {
    private val dir = File(context.filesDir, "images").apply { mkdirs() }

    fun fileOf(name: String): File = File(dir, name)

    fun has(name: String): Boolean = name.isNotEmpty() && fileOf(name).exists()

    fun read(name: String): ByteArray? = fileOf(name).takeIf { it.exists() }?.readBytes()

    /** 返回文件名。文件名只由 hash 决定，不信任对端给的路径 */
    fun save(hash: String, png: ByteArray): String {
        val name = "$hash.png"
        val file = fileOf(name)
        if (!file.exists()) file.writeBytes(png)
        return name
    }

    fun remove(names: Collection<String>) {
        names.forEach { name ->
            if (name.isNotEmpty()) fileOf(name).delete()
        }
    }
}
