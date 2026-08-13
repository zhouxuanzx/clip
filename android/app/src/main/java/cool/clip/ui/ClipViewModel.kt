package cool.clip.ui

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import cool.clip.ClipApp
import cool.clip.data.CollectionEntity
import cool.clip.data.ItemEntity
import cool.clip.data.PeerEntity
import cool.clip.sync.FileTransfer
import cool.clip.sync.PairingPayload
import cool.clip.sync.ProtocolJson
import cool.clip.sync.SyncState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString

@OptIn(ExperimentalCoroutinesApi::class)
class ClipViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as ClipApp
    private val repo = app.repo
    private val sync = app.sync

    val syncState: StateFlow<SyncState> = sync.state
    val notices = sync.notices
    /** 文件传输记录（收发都在一起），给传输页用 */
    val transfers: StateFlow<List<FileTransfer>> = sync.transfers

    private val _activeId = MutableStateFlow<String?>(null)

    val collections: StateFlow<List<CollectionEntity>> = repo.observeCollections()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val peers: StateFlow<List<PeerEntity>> = repo.observePeers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** 当前分类。列表加载完还没选过就落到第一个 */
    val activeCollection: StateFlow<CollectionEntity?> =
        combine(collections, _activeId) { list, id ->
            list.firstOrNull { it.id == id } ?: list.firstOrNull()
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val items: StateFlow<List<ItemEntity>> = activeCollection
        .flatMapLatest { collection ->
            if (collection == null) flowOf(emptyList()) else repo.observeItems(collection.id)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val deviceName: String get() = repo.prefs.deviceName
    val keepConnected: Boolean get() = repo.prefs.keepConnected

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    fun selectCollection(id: String) {
        _activeId.value = id
    }

    fun showMessage(text: String) {
        _message.value = text
    }

    fun consumeMessage() {
        _message.value = null
    }

    // ── 条目操作 ──────────────────────────────────────────

    fun addText(text: String) {
        val collection = activeCollection.value ?: return
        viewModelScope.launch {
            repo.addText(collection.id, text.trim())
            sync.pushAutoChanges()
        }
    }

    fun toggleDone(item: ItemEntity) {
        viewModelScope.launch {
            repo.setDone(item, !item.done)
            sync.pushAutoChanges()
        }
    }

    fun togglePinned(item: ItemEntity) {
        viewModelScope.launch {
            repo.setPinned(item, !item.pinned)
            sync.pushAutoChanges()
        }
    }

    fun deleteItem(item: ItemEntity) {
        viewModelScope.launch {
            repo.deleteItems(listOf(item.id))
            sync.pushAutoChanges()
        }
    }

    fun pushItem(item: ItemEntity) {
        if (!sync.isConnected) {
            showMessage("还没连上电脑")
            return
        }
        sync.pushItems(listOf(item.id))
        showMessage("已推送到电脑")
    }

    // ── 连接 ──────────────────────────────────────────────

    fun connect() = sync.connect()

    fun disconnect() = sync.disconnect()

    /** 扫码结果是一段 JSON，解析失败说明扫到的不是配对码 */
    fun pairFromQr(raw: String) {
        val payload = runCatching { ProtocolJson.decodeFromString<PairingPayload>(raw) }.getOrNull()
        if (payload == null) {
            showMessage("这不是 Clip 的配对二维码")
            return
        }
        sync.pair(payload)
    }

    fun forgetPeer(peer: PeerEntity) {
        viewModelScope.launch {
            sync.disconnect()
            repo.forgetPeer(peer.id)
        }
    }

    fun setDeviceName(name: String) {
        repo.prefs.deviceName = name.trim().ifEmpty { repo.prefs.deviceName }
    }

    fun imageFile(item: ItemEntity) = repo.images.fileOf(item.content)

    // ── 文件传输 ──────────────────────────────────────────

    fun sendFiles(uris: List<Uri>) = sync.sendFiles(uris)

    fun cancelTransfer(key: String) = sync.cancelTransfer(key)

    fun clearTransfers() = sync.clearTransfers()

    fun revealTransfer(transfer: FileTransfer) = sync.revealTransfer(transfer)
}
