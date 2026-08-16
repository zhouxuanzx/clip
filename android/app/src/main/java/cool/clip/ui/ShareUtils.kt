package cool.clip.ui

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.text.StaticLayout
import android.text.TextPaint
import android.widget.Toast
import androidx.core.content.FileProvider
import cool.clip.data.Block
import cool.clip.data.ItemEntity
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

private const val FILE_PROVIDER_AUTHORITY = "cool.clip.fileprovider"

private fun Context.toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

private data class NoteContent(val text: String, val imageFiles: List<File>)

private fun noteContent(vm: ClipViewModel, item: ItemEntity): NoteContent {
    val blocks = vm.blocksOf(item)
    val text = blocks.filterIsInstance<Block.Text>().joinToString("\n") { it.text }.trim()
    val imageFiles = blocks.filterIsInstance<Block.Image>().mapNotNull { b ->
        vm.imageFileOf(b.name).takeIf { it.exists() }
    }
    return NoteContent(text, imageFiles)
}

/** 纯文字分享 */
fun shareText(context: Context, vm: ClipViewModel, item: ItemEntity) {
    val (text) = noteContent(vm, item)
    if (text.isBlank()) { context.toast("这条没有文字"); return }
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(intent, "分享文字"))
}

/** 纯图片分享（单图 SEND，多图 SEND_MULTIPLE） */
fun shareImages(context: Context, vm: ClipViewModel, item: ItemEntity) {
    val (_, imageFiles) = noteContent(vm, item)
    if (imageFiles.isEmpty()) { context.toast("这条没有图片"); return }
    val uris = ArrayList<Uri>(imageFiles.map { FileProvider.getUriForFile(context, FILE_PROVIDER_AUTHORITY, it) })
    val intent = Intent().apply {
        action = if (uris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE
        type = "image/*"
        if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris.first())
        else putExtra(Intent.EXTRA_STREAM, uris)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "分享图片"))
}

/** 图文合并成一张图再分享，微信里文字图片全在、绝不丢字 */
fun shareAsImage(context: Context, vm: ClipViewModel, item: ItemEntity) {
    val (text, imageFiles) = noteContent(vm, item)
    if (text.isBlank() && imageFiles.isEmpty()) { context.toast("没有可分享的内容"); return }
    val bmp = renderNoteToBitmap(text, imageFiles) ?: run { context.toast("生成图片失败"); return }
    val file = File(context.cacheDir, "share_${item.id}.png")
    FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    bmp.recycle()
    val uri = FileProvider.getUriForFile(context, FILE_PROVIDER_AUTHORITY, file)
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "分享为图片"))
}

/** 生成含文字+图片的 Word(.docx) 文档分享 */
fun shareAsWord(context: Context, vm: ClipViewModel, item: ItemEntity) {
    val (text, imageFiles) = noteContent(vm, item)
    if (text.isBlank() && imageFiles.isEmpty()) { context.toast("没有可分享的内容"); return }
    val file = buildDocx(context, text, imageFiles, item.id) ?: run { context.toast("生成文档失败"); return }
    val uri = FileProvider.getUriForFile(context, FILE_PROVIDER_AUTHORITY, file)
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "分享为 Word"))
}

/** 把单张图片存进手机相册（编辑时点击图片用；尤其方便保存从电脑同步过来的图） */
fun saveImageToGallery(context: Context, uri: Uri?) {
    if (uri == null) { context.toast("这张图还没有本地文件，无法保存"); return }
    val resolver = context.contentResolver
    val values = ContentValues().apply {
        put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Clip")
        put(MediaStore.Images.Media.DISPLAY_NAME, "clip_${System.currentTimeMillis()}.png")
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
    }
    val outUri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: run {
        context.toast("保存失败"); return
    }
    try {
        resolver.openOutputStream(outUri)?.use { out ->
            if (uri.scheme == "file") {
                File(uri.path ?: "").inputStream().use { it.copyTo(out) }
            } else {
                resolver.openInputStream(uri)?.use { it.copyTo(out) }
            }
        }
        context.toast("已保存到 相册/Clip")
    } catch (_: Exception) {
        context.toast("保存失败")
    }
}

/** 导出到本机「下载 / clip」目录：文字存成 .txt，图片各存一张 .png（走 MediaStore，无需存储权限） */
fun exportItem(context: Context, vm: ClipViewModel, item: ItemEntity) {
    val (text, imageFiles) = noteContent(vm, item)
    val base = text.lineSequence().firstOrNull { it.isNotBlank() }
        ?.take(40)?.trim()?.replace(Regex("[\\\\/:*?\"<>|]"), "_")
        ?: "clip_导出_${item.createdAt}"
    val dir = "${Environment.DIRECTORY_DOWNLOADS}/clip"
    val resolver = context.contentResolver
    var count = 0

    if (text.isNotBlank()) {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.RELATIVE_PATH, dir)
            put(MediaStore.Downloads.DISPLAY_NAME, "$base.txt")
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
        }
        resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)?.let { uri ->
            resolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            count++
        }
    }

    imageFiles.forEachIndexed { index, file ->
        val name = if (imageFiles.size > 1) "${base}_${index + 1}.png" else "$base.png"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.RELATIVE_PATH, dir)
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        }
        resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)?.let { uri ->
            resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
            count++
        }
    }

    context.toast(if (count > 0) "已导出 $count 个文件到 下载/clip/" else "没有可导出的内容")
}

// ── 渲染辅助 ───────────────────────────────────────────────

private fun renderNoteToBitmap(text: String, images: List<File>): Bitmap? {
    val width = 720
    val pad = 36
    val inner = width - pad * 2
    val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        textSize = 30f
        typeface = Typeface.DEFAULT
    }

    val layouts = mutableListOf<StaticLayout>()
    var totalH = pad * 2
    if (text.isNotBlank()) {
        val sl = StaticLayout.Builder.obtain(text, 0, text.length, textPaint, inner)
            .setLineSpacing(0f, 1.35f)
            .build()
        layouts.add(sl)
        totalH += sl.height + 28
    }

    val bitmaps = mutableListOf<Bitmap>()
    for (f in images) {
        val bmp = BitmapFactory.decodeFile(f.absolutePath) ?: continue
        val h = (bmp.height * inner.toFloat() / bmp.width).toInt().coerceAtLeast(1)
        bitmaps.add(bmp)
        totalH += h + 28
    }
    if (totalH < 1) return null

    val out = Bitmap.createBitmap(width, totalH, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawColor(Color.WHITE)
    var y = pad
    for (sl in layouts) {
        canvas.save()
        canvas.translate(pad.toFloat(), y.toFloat())
        sl.draw(canvas)
        canvas.restore()
        y += sl.height + 28
    }
    for (bmp in bitmaps) {
        val h = (bmp.height * inner.toFloat() / bmp.width).toInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(bmp, inner, h, true)
        canvas.drawBitmap(scaled, pad.toFloat(), y.toFloat(), null)
        if (scaled != bmp) scaled.recycle()
        y += h + 28
    }
    return out
}

private fun escapeXml(s: String): String =
    s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

/** 拼一个最小可用、Word 能打开的 .docx（文字按行成段，图片内嵌） */
private fun buildDocx(context: Context, text: String, images: List<File>, id: String): File? {
    val dir = File(context.cacheDir, "docx").apply { mkdirs() }
    val file = File(dir, "clip_$id.docx")
    val emu = 9525 // EMU per px @96dpi
    val wNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    val rNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    val aNamespace = "http://schemas.openxmlformats.org/drawingml/2006/main"
    val picNamespace = "http://schemas.openxmlformats.org/drawingml/2006/picture"

    val sb = StringBuilder()
    sb.append(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<w:document xmlns:w=\"$wNamespace\" xmlns:r=\"$rNamespace\"><w:body>"
    )
    if (text.isNotBlank()) {
        text.split("\n").forEach { line ->
            sb.append("<w:p><w:r><w:t xml:space=\"preserve\">${escapeXml(line)}</w:t></w:r></w:p>")
        }
    }
    val imgRels = StringBuilder(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
    )
    var rid = 100
    images.forEachIndexed { i, f ->
        val bmp = BitmapFactory.decodeFile(f.absolutePath) ?: return@forEachIndexed
        if (bmp.width <= 0 || bmp.height <= 0) { bmp.recycle(); return@forEachIndexed }
        // 限制显示宽度，避免大图在 Word 里超出页面（嵌入的 PNG 仍是原分辨率）
        val maxW = 600
        val w = minOf(bmp.width, maxW)
        val h = (bmp.height.toFloat() * w / bmp.width).toInt()
        val cx = (w * emu).toString()
        val cy = (h * emu).toString()
        val relId = "rId$rid"; rid++
        imgRels.append(
            "<Relationship Id=\"$relId\" Type=\"$rNamespace/image\" Target=\"media/image${i + 1}.png\"/>"
        )
        sb.append(
            "<w:p><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\" " +
                "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\">" +
                "<wp:extent cx=\"$cx\" cy=\"$cy\"/><wp:docPr id=\"${i + 1}\" name=\"Picture${i + 1}\"/>" +
                "<a:graphic xmlns:a=\"$aNamespace\"><a:graphicData uri=\"$picNamespace\">" +
                "<pic:pic xmlns:pic=\"$picNamespace\"><pic:nvPicPr>" +
                "<pic:cNvPr id=\"${i + 1}\" name=\"Picture${i + 1}\"/><pic:cNvPicPr/></pic:nvPicPr>" +
                "<pic:blipFill><a:blip r:embed=\"$relId\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>" +
                "<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"$cx\" cy=\"$cy\"/></a:xfrm>" +
                "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>" +
                "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
        )
        bmp.recycle()
    }
    imgRels.append("</Relationships>")

    val contentTypes =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
            "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
            "<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
            "<Default Extension=\"png\" ContentType=\"image/png\"/>" +
            "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>" +
            "</Types>"
    val rootRels =
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
            "<Relationship Id=\"rId1\" Type=\"$rNamespace/officeDocument\" Target=\"word/document.xml\"/>" +
            "</Relationships>"

    sb.append("</w:body></w:document>")

    return try {
        ZipOutputStream(FileOutputStream(file)).use { zos ->
            fun add(name: String, data: String) {
                zos.putNextEntry(ZipEntry(name))
                zos.write(data.toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
            add("[Content_Types].xml", contentTypes)
            add("_rels/.rels", rootRels)
            add("word/document.xml", sb.toString())
            add("word/_rels/document.xml.rels", imgRels.toString())
            images.forEachIndexed { i, f ->
                zos.putNextEntry(ZipEntry("word/media/image${i + 1}.png"))
                f.inputStream().use { it.copyTo(zos) }
                zos.closeEntry()
            }
        }
        file
    } catch (_: Exception) {
        null
    }
}
