package cool.clip.data

import android.content.Context
import android.os.Build
import java.util.UUID

/** 本机身份与几个小设置，量很小，用 SharedPreferences 就够 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("clip", Context.MODE_PRIVATE)

    /** 本机设备 id，首次启动生成后不再变。换了它等于换了一台新设备，需要重新配对 */
    val deviceId: String
        get() = sp.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
            sp.edit().putString(KEY_DEVICE_ID, it).apply()
        }

    var deviceName: String
        get() = sp.getString(KEY_DEVICE_NAME, null) ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        set(value) = sp.edit().putString(KEY_DEVICE_NAME, value).apply()

    /** 分享菜单收到的内容默认进哪个分类 */
    var inboxCollectionId: String?
        get() = sp.getString(KEY_INBOX, null)
        set(value) = sp.edit().putString(KEY_INBOX, value).apply()

    /** 是否在后台保持连接（前台服务） */
    var keepConnected: Boolean
        get() = sp.getBoolean(KEY_KEEP_CONNECTED, false)
        set(value) = sp.edit().putBoolean(KEY_KEEP_CONNECTED, value).apply()

    private companion object {
        const val KEY_DEVICE_ID = "deviceId"
        const val KEY_DEVICE_NAME = "deviceName"
        const val KEY_INBOX = "inboxCollectionId"
        const val KEY_KEEP_CONNECTED = "keepConnected"
    }
}
