package cool.clip

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 系统分享菜单的落点。
 *
 * 手机端不自动抓剪贴板：安卓 10 起后台读剪贴板被系统禁掉，
 * 前台读也会弹"XX 已粘贴"的提示，体验很差。
 * 走分享菜单是唯一既合规又顺手的入口。
 *
 * 文本进剪贴板分类；文件/图片则直接发往已连接的电脑。
 */
class ShareReceiverActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val text = when (intent?.action) {
            Intent.ACTION_SEND ->
                if (intent.hasExtra(Intent.EXTRA_STREAM)) null
                else intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            Intent.ACTION_PROCESS_TEXT ->
                intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
            else -> null
        }

        val uris = collectSharedUris()

        val app = ClipApp.from(this)

        // 分享的是文件：直接发给电脑
        if (uris.isNotEmpty()) {
            if (!app.sync.isConnected) {
                toastAndFinish("请先在设置里连上电脑")
                return
            }
            app.sync.sendFiles(uris)
            toastAndFinish("正在发给电脑")
            return
        }

        if (text.isNullOrBlank()) {
            toastAndFinish("没有可保存的内容")
            return
        }

        app.appScope.launch {
            val target = pickInbox(app)
            if (target == null) {
                withContext(Dispatchers.Main) { toastAndFinish("先在设置里与电脑配对") }
                return@launch
            }
            app.repo.addText(target, text)
            app.sync.pushAutoChanges()
            withContext(Dispatchers.Main) { toastAndFinish("已保存到 Clip") }
        }
    }

    /** 从分享意图里取出所有文件 URI（单文件或多文件） */
    @Suppress("DEPRECATION")
    private fun collectSharedUris(): List<Uri> {
        return when (intent?.action) {
            Intent.ACTION_SEND -> {
                (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)
                    ?.let { listOf(it) } ?: emptyList()
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                (intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM) as? ArrayList<Uri>)?.toList()
                    ?: emptyList()
            }
            else -> emptyList()
        }
    }

    /** 优先用户指定的收件分类，否则第一个普通列表，再否则第一个分类 */
    private suspend fun pickInbox(app: ClipApp): String? {
        val prefs = app.repo.prefs
        val all = app.repo.currentCollections()

        prefs.inboxCollectionId?.let { saved ->
            if (all.any { it.id == saved }) return saved
        }
        val fallback = all.firstOrNull { it.kind == "list" } ?: all.firstOrNull()
        return fallback?.id?.also { prefs.inboxCollectionId = it }
    }

    private fun toastAndFinish(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        setResult(Activity.RESULT_OK)
        finish()
    }
}
