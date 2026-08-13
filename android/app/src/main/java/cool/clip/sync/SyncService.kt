package cool.clip.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import cool.clip.ClipApp
import cool.clip.MainActivity
import cool.clip.R
import cool.clip.sync.TransferState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * 前台服务，作用只有一个：让 WebSocket 在息屏和切后台时别被系统掐掉。
 * 手机端不做剪贴板自动抓取——安卓从 10 起后台读剪贴板就是被禁的，
 * 硬做也只会得到一堆"XX 已粘贴"的系统提示。
 */
class SyncService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watcher: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForegroundCompat(getString(R.string.sync_connecting))

        val app = ClipApp.from(this)
        watcher = scope.launch {
            combine(app.sync.state, app.sync.transfers) { state, list ->
                val active = list.firstOrNull {
                    it.state == TransferState.ACTIVE || it.state == TransferState.WAITING
                }
                if (active != null) {
                    val pct = if (active.size > 0) (active.transferred * 100 / active.size) else 0
                    val dir = if (active.direction == "send") "发送" else "接收"
                    "$dir「${active.name}」 $pct%"
                } else {
                    when (state) {
                        is SyncState.Connected -> getString(R.string.sync_connected, state.peerName)
                        is SyncState.Connecting -> getString(R.string.sync_connecting)
                        is SyncState.Failed -> state.reason
                        SyncState.Idle -> getString(R.string.sync_idle)
                    }
                }
            }.collectLatest { notify(it) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = ClipApp.from(this)
        when (intent?.action) {
            ACTION_STOP -> {
                app.sync.disconnect()
                app.repo.prefs.keepConnected = false
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                app.repo.prefs.keepConnected = true
                app.sync.connect()
            }
        }
        // 被系统回收后自动拉起，保持连接是这个服务存在的唯一理由
        return START_STICKY
    }

    override fun onDestroy() {
        watcher?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.sync_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.sync_channel_desc)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, SyncService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_clip)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(open)
            .addAction(0, getString(R.string.sync_stop), stop)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun startForegroundCompat(text: String) {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(text), type)
    }

    private fun notify(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(text))
    }

    companion object {
        private const val CHANNEL_ID = "sync"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "cool.clip.STOP_SYNC"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, SyncService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, SyncService::class.java).setAction(ACTION_STOP))
        }
    }
}
