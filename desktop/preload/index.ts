import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  CollectionPatch,
  Item,
  ItemPatch,
  ListItemsQuery,
  NewCollectionInput,
  NewItemInput
} from '@shared/types'
import type { FileTransfer, SyncServerStatus } from '@shared/sync'
import { IPC, type ClipApi } from '@shared/ipc'

const api: ClipApi = {
  collections: {
    list: () => ipcRenderer.invoke(IPC.collectionsList),
    create: (input: NewCollectionInput) => ipcRenderer.invoke(IPC.collectionsCreate, input),
    update: (id: string, patch: CollectionPatch) =>
      ipcRenderer.invoke(IPC.collectionsUpdate, id, patch),
    remove: (id: string) => ipcRenderer.invoke(IPC.collectionsDelete, id),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke(IPC.collectionsReorder, orderedIds)
  },
  items: {
    list: (query: ListItemsQuery) => ipcRenderer.invoke(IPC.itemsList, query),
    add: (input: NewItemInput) => ipcRenderer.invoke(IPC.itemsAdd, input),
    update: (id: string, patch: ItemPatch) => ipcRenderer.invoke(IPC.itemsUpdate, id, patch),
    remove: (ids: string[]) => ipcRenderer.invoke(IPC.itemsDelete, ids),
    move: (itemId: string, targetCollectionId: string) =>
      ipcRenderer.invoke(IPC.itemsMove, itemId, targetCollectionId),
    search: (keyword: string) => ipcRenderer.invoke(IPC.itemsSearch, keyword),
    writeToClipboard: (id: string) => ipcRenderer.invoke(IPC.itemsWriteToClipboard, id),
    paste: (id: string) => ipcRenderer.invoke(IPC.itemsPaste, id)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  sync: {
    status: () => ipcRenderer.invoke(IPC.syncStatus),
    start: () => ipcRenderer.invoke(IPC.syncStart),
    stop: () => ipcRenderer.invoke(IPC.syncStop),
    openPairing: () => ipcRenderer.invoke(IPC.syncOpenPairing),
    closePairing: () => ipcRenderer.invoke(IPC.syncClosePairing),
    push: (itemIds: string[], deviceId?: string) =>
      ipcRenderer.invoke(IPC.syncPush, itemIds, deviceId),
    forget: (deviceId: string) => ipcRenderer.invoke(IPC.syncForget, deviceId)
  },
  transfers: {
    list: () => ipcRenderer.invoke(IPC.transfersList),
    send: (paths: string[], deviceId?: string) =>
      ipcRenderer.invoke(IPC.transfersSend, paths, deviceId),
    pick: (deviceId?: string) => ipcRenderer.invoke(IPC.transfersPick, deviceId),
    cancel: (key: string) => ipcRenderer.invoke(IPC.transfersCancel, key),
    clear: () => ipcRenderer.invoke(IPC.transfersClear),
    reveal: (path: string) => ipcRenderer.invoke(IPC.transfersReveal, path),
    dir: () => ipcRenderer.invoke(IPC.transfersDir),
    chooseDir: () => ipcRenderer.invoke(IPC.transfersChooseDir)
  },
  window: {
    hide: () => ipcRenderer.invoke(IPC.windowHide),
    lock: () => ipcRenderer.invoke(IPC.windowLock),
    unlock: () => ipcRenderer.invoke(IPC.windowUnlock)
  },
  onItemAdded: (handler: (item: Item) => void) => {
    const listener = (_event: IpcRendererEvent, item: Item): void => handler(item)
    ipcRenderer.on(IPC.onItemAdded, listener)
    return () => ipcRenderer.removeListener(IPC.onItemAdded, listener)
  },
  onSettingsChanged: (handler: (settings: AppSettings) => void) => {
    const listener = (_event: IpcRendererEvent, settings: AppSettings): void => handler(settings)
    ipcRenderer.on(IPC.onSettingsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.onSettingsChanged, listener)
  },
  onSyncChanged: (handler: (status: SyncServerStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: SyncServerStatus): void => handler(status)
    ipcRenderer.on(IPC.onSyncChanged, listener)
    return () => ipcRenderer.removeListener(IPC.onSyncChanged, listener)
  },
  onRemoteApplied: (handler: (count: number) => void) => {
    const listener = (_event: IpcRendererEvent, count: number): void => handler(count)
    ipcRenderer.on(IPC.onRemoteApplied, listener)
    return () => ipcRenderer.removeListener(IPC.onRemoteApplied, listener)
  },
  onTransfersChanged: (handler: (transfers: FileTransfer[]) => void) => {
    const listener = (_event: IpcRendererEvent, list: FileTransfer[]): void => handler(list)
    ipcRenderer.on(IPC.onTransfersChanged, listener)
    return () => ipcRenderer.removeListener(IPC.onTransfersChanged, listener)
  }
}

contextBridge.exposeInMainWorld('clip', api)
