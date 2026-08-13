package cool.clip

import android.app.Application
import android.content.Context
import cool.clip.data.Repository
import cool.clip.sync.SyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class ClipApp : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    lateinit var repo: Repository
        private set
    lateinit var sync: SyncManager
        private set

    override fun onCreate() {
        super.onCreate()
        repo = Repository(this)
        sync = SyncManager(repo, appScope)
        appScope.launch { repo.purgeTombstones() }
    }

    companion object {
        fun from(context: Context): ClipApp = context.applicationContext as ClipApp
    }
}
