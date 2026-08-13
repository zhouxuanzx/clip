/**
 * 主进程与渲染进程之间的通道契约。
 * 渲染进程不直接碰数据库，全部经由这些通道。
 */
import type {
  AppSettings,
  Collection,
  CollectionPatch,
  Item,
  ItemPatch,
  ListItemsQuery,
  NewCollectionInput,
  NewItemInput,
  SearchHit
} from './types'
import type { FileTransfer, SyncServerStatus } from './sync'

export const IPC = {
  collectionsList: 'collections:list',
  collectionsCreate: 'collections:create',
  collectionsUpdate: 'collections:update',
  collectionsDelete: 'collections:delete',
  collectionsReorder: 'collections:reorder',

  itemsList: 'items:list',
  itemsAdd: 'items:add',
  itemsUpdate: 'items:update',
  itemsDelete: 'items:delete',
  itemsMove: 'items:move',
  itemsSearch: 'items:search',
  itemsWriteToClipboard: 'items:writeToClipboard',
  itemsPaste: 'items:paste',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  syncStatus: 'sync:status',
  syncStart: 'sync:start',
  syncStop: 'sync:stop',
  syncOpenPairing: 'sync:openPairing',
  syncClosePairing: 'sync:closePairing',
  syncPush: 'sync:push',
  syncForget: 'sync:forget',

  transfersList: 'transfers:list',
  transfersSend: 'transfers:send',
  transfersPick: 'transfers:pick',
  transfersCancel: 'transfers:cancel',
  transfersClear: 'transfers:clear',
  transfersReveal: 'transfers:reveal',
  transfersDir: 'transfers:dir',
  transfersChooseDir: 'transfers:chooseDir',

  windowHide: 'window:hide',
  windowLock: 'window:lock',
  windowUnlock: 'window:unlock',

  /** 主进程 → 渲染进程：剪贴板抓到新条目 */
  onItemAdded: 'event:itemAdded',
  /** 主进程 → 渲染进程：设置被外部改动（比如托盘菜单里切了暂停） */
  onSettingsChanged: 'event:settingsChanged',
  /** 主进程 → 渲染进程：设备上下线、配对状态变化 */
  onSyncChanged: 'event:syncChanged',
  /** 主进程 → 渲染进程：收到远端数据并写入，列表需要刷新 */
  onRemoteApplied: 'event:remoteApplied',
  /** 主进程 → 渲染进程：文件传输进度或状态变化 */
  onTransfersChanged: 'event:transfersChanged'
} as const

/** 预加载脚本暴露给渲染进程的 API 形状 */
export interface ClipApi {
  collections: {
    list(): Promise<Collection[]>
    create(input: NewCollectionInput): Promise<Collection>
    update(id: string, patch: CollectionPatch): Promise<void>
    remove(id: string): Promise<void>
    reorder(orderedIds: string[]): Promise<void>
  }
  items: {
    list(query: ListItemsQuery): Promise<Item[]>
    add(input: NewItemInput): Promise<Item>
    update(id: string, patch: ItemPatch): Promise<void>
    remove(ids: string[]): Promise<void>
    /** 把条目移动到另一个分类（从原分类移除） */
    move(itemId: string, targetCollectionId: string): Promise<void>
    search(keyword: string): Promise<SearchHit[]>
    /** 写回系统剪贴板 */
    writeToClipboard(id: string): Promise<void>
    /** 写回剪贴板并粘贴到唤起前的那个窗口 */
    paste(id: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  sync: {
    status(): Promise<SyncServerStatus>
    start(): Promise<SyncServerStatus>
    stop(): Promise<SyncServerStatus>
    /** 开启配对窗口，返回含二维码的最新状态 */
    openPairing(): Promise<SyncServerStatus>
    closePairing(): Promise<SyncServerStatus>
    /** 推送条目到指定设备，不传 deviceId 则推给所有在线设备。返回送达设备数 */
    push(itemIds: string[], deviceId?: string): Promise<number>
    /** 解除配对 */
    forget(deviceId: string): Promise<SyncServerStatus>
  }
  transfers: {
    list(): Promise<FileTransfer[]>
    /** 发送本地文件，不传 deviceId 则发给第一台在线设备。返回排上队的数量 */
    send(paths: string[], deviceId?: string): Promise<number>
    /** 弹系统选择框挑文件再发 */
    pick(deviceId?: string): Promise<number>
    cancel(key: string): Promise<void>
    /** 清掉已结束的记录 */
    clear(): Promise<void>
    /** 在文件管理器里定位 */
    reveal(path: string): Promise<void>
    /** 当前接收目录的绝对路径 */
    dir(): Promise<string>
    /** 弹目录选择框，返回新的接收目录（取消则返回原值） */
    chooseDir(): Promise<string>
  }
  window: {
    hide(): Promise<void>
    lock(): Promise<void>
    unlock(): Promise<void>
  }
  /** 返回取消订阅函数 */
  onItemAdded(handler: (item: Item) => void): () => void
  onSettingsChanged(handler: (settings: AppSettings) => void): () => void
  onSyncChanged(handler: (status: SyncServerStatus) => void): () => void
  onRemoteApplied(handler: (count: number) => void): () => void
  onTransfersChanged(handler: (transfers: FileTransfer[]) => void): () => void
}
