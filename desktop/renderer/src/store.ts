import { create } from 'zustand'
import type { AppSettings, Collection, Item, SearchHit } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { FileTransfer, SyncServerStatus } from '@shared/sync'

const OFFLINE_SYNC: SyncServerStatus = {
  running: false,
  port: 0,
  addresses: [],
  pairingQr: null,
  devices: []
}

interface ClipState {
  collections: Collection[]
  activeCollectionId: string | null
  items: Item[]
  /** 全局搜索结果，非空时列表区展示它而不是 items */
  searchHits: SearchHit[] | null
  keyword: string
  selectedIds: Set<string>
  settings: AppSettings
  sync: SyncServerStatus
  /** 主区域当前显示哪个：剪贴板分类，还是文件传输页 */
  view: 'collections' | 'transfers'
  /** 文件传输记录，由主进程推送更新 */
  transfers: FileTransfer[]
  /** 待办筛选：全部 / 未完成 / 已完成 */
  todoFilter: 'all' | 'active' | 'done'
  /** 待办按天筛选，'YYYY-MM-DD'；null 表示不限 */
  todoDay: string | null
  /** 接收文件落盘的绝对目录 */
  downloadDir: string
  /** 一次性提示语，比如"已推送到 1 台设备"，几秒后自动清空 */
  toast: string | null
  loading: boolean

  loadAll(): Promise<void>
  setView(view: 'collections' | 'transfers'): void
  setTodoFilter(value: 'all' | 'active' | 'done'): void
  setTodoDay(value: string | null): void
  loadTransfers(): Promise<void>
  selectCollection(id: string): Promise<void>
  refreshItems(): Promise<void>
  setKeyword(keyword: string): Promise<void>

  toggleSelected(id: string, additive: boolean): void
  clearSelection(): void

  addCollection(name: string, kind: Collection['kind']): Promise<void>
  renameCollection(id: string, name: string): Promise<void>
  patchCollection(id: string, patch: Parameters<typeof window.clip.collections.update>[1]): Promise<void>
  removeCollection(id: string): Promise<void>

  moveItem(id: string, targetId: string): Promise<void>
  togglePinned(item: Item): Promise<void>
  toggleDone(item: Item): Promise<void>
  removeSelected(): Promise<void>
  removeItem(id: string): Promise<void>
  addItem(collectionId: string, content: string): Promise<void>

  patchSettings(patch: Partial<AppSettings>): Promise<void>

  refreshSync(): Promise<void>
  toggleSync(): Promise<void>
  openPairing(): Promise<void>
  closePairing(): Promise<void>
  forgetDevice(id: string): Promise<void>
  /** 把条目推给手机，不传 deviceId 则推给所有在线设备 */
  pushItems(ids: string[], deviceId?: string): Promise<void>
  pushSelected(deviceId?: string): Promise<void>

  /** 弹窗选文件发给手机（不传 deviceId 发给第一台在线设备） */
  pickFiles(deviceId?: string): Promise<void>
  /** 直接发一批本地文件路径 */
  sendFiles(paths: string[], deviceId?: string): Promise<void>
  cancelTransfer(key: string): Promise<void>
  clearTransfers(): Promise<void>
  revealTransfer(path: string): Promise<void>
  /** 弹目录选择框改接收目录 */
  chooseDownloadDir(): Promise<void>

  showToast(text: string): void
  /** 主进程推来的新剪贴板条目 */
  onExternalItem(item: Item): void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useStore = create<ClipState>((set, get) => ({
  collections: [],
  activeCollectionId: null,
  items: [],
  searchHits: null,
  keyword: '',
  selectedIds: new Set(),
  settings: DEFAULT_SETTINGS,
  sync: OFFLINE_SYNC,
  view: 'collections',
  transfers: [],
  todoFilter: 'all',
  todoDay: null,
  downloadDir: '',
  toast: null,
  loading: true,

  async loadAll() {
    const [collections, settings, sync, transfers, downloadDir] = await Promise.all([
      window.clip.collections.list(),
      window.clip.settings.get(),
      window.clip.sync.status(),
      window.clip.transfers.list(),
      window.clip.transfers.dir()
    ])
    const activeId = get().activeCollectionId ?? collections[0]?.id ?? null
    set({ collections, settings, sync, transfers, downloadDir, activeCollectionId: activeId, loading: false })
    if (activeId) await get().refreshItems()
  },

  setView(view) {
    set({ view })
  },

  setTodoFilter(value) {
    set({ todoFilter: value })
  },

  setTodoDay(value) {
    set({ todoDay: value })
  },

  async loadTransfers() {
    const [transfers, downloadDir] = await Promise.all([
      window.clip.transfers.list(),
      window.clip.transfers.dir()
    ])
    set({ transfers, downloadDir })
  },

  async selectCollection(id) {
    // 在传输页里点分类也要切回剪贴板视图，否则主区域会一直停在传输页
    // 切换分类时顺手清掉筛选状态，避免上一分类的"仅看收藏/待办筛选"串过来
    set({
      activeCollectionId: id,
      keyword: '',
      searchHits: null,
      selectedIds: new Set(),
      view: 'collections',
      todoFilter: 'all',
      todoDay: null
    })
    await get().refreshItems()
  },

  async refreshItems() {
    const { activeCollectionId, keyword, searchHits } = get()
    // 全局搜索模式下不受当前分类影响
    if (searchHits !== null) {
      set({ searchHits: await window.clip.items.search(keyword) })
      return
    }
    if (!activeCollectionId) return
    set({ items: await window.clip.items.list({ collectionId: activeCollectionId }) })
  },

  async setKeyword(keyword) {
    set({ keyword, selectedIds: new Set() })
    if (!keyword.trim()) {
      set({ searchHits: null })
      await get().refreshItems()
      return
    }
    set({ searchHits: await window.clip.items.search(keyword) })
  },

  toggleSelected(id, additive) {
    const current = get().selectedIds
    if (!additive) {
      set({ selectedIds: new Set(current.has(id) && current.size === 1 ? [] : [id]) })
      return
    }
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set({ selectedIds: next })
  },

  clearSelection() {
    set({ selectedIds: new Set() })
  },

  async addCollection(name, kind) {
    await window.clip.collections.create({ name, kind })
    set({ collections: await window.clip.collections.list() })
  },

  async renameCollection(id, name) {
    await window.clip.collections.update(id, { name })
    set({ collections: await window.clip.collections.list() })
  },

  async patchCollection(id, patch) {
    await window.clip.collections.update(id, patch)
    set({ collections: await window.clip.collections.list() })
    await get().refreshItems()
  },

  async removeCollection(id) {
    await window.clip.collections.remove(id)
    const collections = await window.clip.collections.list()
    const activeId = get().activeCollectionId === id ? (collections[0]?.id ?? null) : get().activeCollectionId
    set({ collections, activeCollectionId: activeId })
    await get().refreshItems()
  },

  async moveItem(id, targetId) {
    await window.clip.items.move(id, targetId)
    await get().refreshItems()
  },

  async togglePinned(item) {
    await window.clip.items.update(item.id, { pinned: !item.pinned })
    await get().refreshItems()
  },

  async toggleDone(item) {
    await window.clip.items.update(item.id, { done: !item.done })
    get().showToast(item.done ? '已标记为未完成' : '已完成 ✓')
    await get().refreshItems()
  },

  async removeSelected() {
    const ids = [...get().selectedIds]
    if (ids.length === 0) return
    await window.clip.items.remove(ids)
    set({ selectedIds: new Set() })
    await get().refreshItems()
  },

  async removeItem(id) {
    await window.clip.items.remove([id])
    const next = new Set(get().selectedIds)
    next.delete(id)
    set({ selectedIds: next })
    await get().refreshItems()
  },

  async addItem(collectionId, content) {
    await window.clip.items.add({ collectionId, type: 'text', content })
    await get().refreshItems()
  },

  async patchSettings(patch) {
    set({ settings: await window.clip.settings.set(patch) })
  },

  async refreshSync() {
    set({ sync: await window.clip.sync.status() })
  },

  async toggleSync() {
    const running = get().sync.running
    set({ sync: running ? await window.clip.sync.stop() : await window.clip.sync.start() })
  },

  async openPairing() {
    set({ sync: await window.clip.sync.openPairing() })
    if (!get().sync.pairingQr) {
      get().showToast('没有可用的局域网地址，请检查网络连接')
    }
  },

  async closePairing() {
    set({ sync: await window.clip.sync.closePairing() })
  },

  async forgetDevice(id) {
    set({ sync: await window.clip.sync.forget(id) })
  },

  async pushItems(ids, deviceId) {
    if (ids.length === 0) return
    const sent = await window.clip.sync.push(ids, deviceId)
    get().showToast(
      sent > 0 ? `已推送 ${ids.length} 项到 ${sent} 台设备` : '没有在线设备，先在手机上连接'
    )
  },

  async pushSelected(deviceId) {
    await get().pushItems([...get().selectedIds], deviceId)
  },

  async pickFiles(deviceId) {
    const count = await window.clip.transfers.pick(deviceId)
    if (count > 0) {
      set({ view: 'transfers' })
      get().showToast(`已加入 ${count} 个文件`)
    } else {
      get().showToast('没有选到文件，或没有在线设备')
    }
  },

  async sendFiles(paths, deviceId) {
    if (paths.length === 0) return
    const count = await window.clip.transfers.send(paths, deviceId)
    if (count <= 0) {
      get().showToast('没有在线设备，先在手机上连一下')
      return
    }
    set({ view: 'transfers' })
    get().showToast(`正在发送 ${count} 个文件`)
  },

  async cancelTransfer(key) {
    await window.clip.transfers.cancel(key)
  },

  async clearTransfers() {
    await window.clip.transfers.clear()
  },

  async revealTransfer(path) {
    await window.clip.transfers.reveal(path)
  },

  async chooseDownloadDir() {
    const dir = await window.clip.transfers.chooseDir()
    set({ downloadDir: dir })
  },

  showToast(text) {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: text })
    toastTimer = setTimeout(() => set({ toast: null }), 2600)
  },

  onExternalItem(item) {
    const { activeCollectionId, searchHits, items } = get()
    // 不在剪贴板分类页 / 正在搜索时，不打断当前视图
    if (searchHits !== null || item.collectionId !== activeCollectionId) return
    // 重复内容会被后端合并成"刷新时间戳"，这里同样按 id 去重后置顶
    set({ items: [item, ...items.filter((i) => i.id !== item.id)] })
  }
}))
