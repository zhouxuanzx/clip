import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { toDataURL } from 'qrcode'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  Tray
} from 'electron'
import type {
  AppSettings,
  CollectionPatch,
  ItemPatch,
  ListItemsQuery,
  NewCollectionInput,
  NewItemInput
} from '@shared/types'
import { IPC } from '@shared/ipc'
import {
  addItem,
  createCollection,
  deleteCollection,
  deleteItems,
  ensureDeviceIdentity,
  getClipboardCollection,
  getItem,
  listCollections,
  listItems,
  moveItemTo,
  openDatabase,
  purgeTombstones,
  readSettings,
  reorderCollections,
  searchAll,
  trimCollection,
  updateCollection,
  updateItem,
  writeSettings
} from './db'
import { ClipboardWatcher, type Captured } from './clipboardWatcher'
import { ImageStore } from './images'
import { pasteToPreviousWindow } from './paste'
import { win32, isWindows } from './win32'
import { SyncServer, localAddresses } from './sync/server'
import { FileTransferManager } from './sync/transfer'
import { removeDevice } from './db/devices'
import type { SyncServerStatus } from '@shared/sync'

// 单实例：第二次启动时唤起已有窗口而不是再开一个
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// 渲染进程不能直接读本地文件，图片走这个受限协议：
// clip-image://<文件名>，只映射到图片目录内，不接受路径穿越
protocol.registerSchemesAsPrivileged([
  { scheme: 'clip-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// ---- 日志系统 ----
let logPath = ''

function log(tag: string, msg: string): void {
  const line = `[${new Date().toISOString()}] ${tag} ${msg}\n`
  console.error(line)
  if (logPath) {
    try { appendFileSync(logPath, line, 'utf8') } catch { /* 日志写入失败不中断主流程 */ }
  }
}

// ---- 全局异常捕获，防止闪退 ----
process.on('uncaughtException', (err) => {
  log('FATAL', err.stack || err.message)
})
process.on('unhandledRejection', (reason) => {
  log('FATAL', `Unhandled rejection: ${String(reason)}`)
})

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let db: ReturnType<typeof openDatabase>
let images: ImageStore
let watcher: ClipboardWatcher
let settings: AppSettings
let syncServer: SyncServer
let transfers: FileTransferManager
/** 当前二维码的 data URL，配对窗口关闭时清空 */
let pairingQr: string | null = null
/** 唤起小窗之前的前台窗口，粘贴时要还焦点给它 */
let previousHwnd = 0

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 640,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    frame: true,
    icon: generateClipIcon(64),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 关窗只是收进托盘，不退出进程
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  // 失焦自动收起，符合"弹出式剪贴板"的直觉。
  // 但渲染进程弹原生 confirm/dialog 也会触发失焦，此时不隐藏
  mainWindow.on('blur', () => {
    if (suppressBlurHide) return
    if (!mainWindow?.webContents.isDevToolsOpened()) mainWindow?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

let isQuitting = false
/** 渲染进程弹确认框等操作期间，失焦不隐藏窗口 */
let suppressBlurHide = false

function toggleWindow(): void {
  if (!mainWindow) return

  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
    return
  }

  // 记住当前前台窗口，供"回车粘贴"用
  previousHwnd = win32.getForegroundWindow()
  // showInactive 不抢焦点，这样用户原来在打字的窗口不会被打断
  mainWindow.showInactive()
  mainWindow.focus()
}

function registerHotkey(accelerator: string): boolean {
  globalShortcut.unregisterAll()
  if (!accelerator) return false
  try {
    return globalShortcut.register(accelerator, toggleWindow)
  } catch (err) {
    log('HOTKEY', `注册失败 ${accelerator}: ${String(err)}`)
    return false
  }
}

function applyAutoLaunch(enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}

function broadcastSettings(): void {
  mainWindow?.webContents.send(IPC.onSettingsChanged, settings)
}

/** 代码绘制剪贴板图标，返回 nativeImage。尺寸建议 32（托盘）或 64（窗口） */
function generateClipIcon(size: number): Electron.NativeImage {
  const S = size
  const buf = Buffer.alloc(S * S * 4)
  buf.fill(0)

  function set(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    if (x < 0 || x >= S || y < 0 || y >= S) return
    const i = (y * S + x) * 4
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
  }

  // 坐标按比例缩放
  const s = S / 32
  const clampTop = Math.round(2 * s), clampBot = Math.round(8 * s)
  const clampL = Math.round(10 * s), clampR = Math.round(22 * s)
  const bodyTop = Math.round(9 * s), bodyBot = Math.round(31 * s)
  const bodyL = Math.round(3 * s), bodyR = Math.round(29 * s)

  // 夹子
  for (let y = clampTop; y < clampBot; y++)
    for (let x = clampL; x < clampR; x++)
      set(x, y, 41, 55, 80)

  // 主体
  const bR = 48, bG = 120, bB = 232
  for (let y = bodyTop; y < bodyBot; y++)
    for (let x = bodyL; x < bodyR; x++)
      set(x, y, bR, bG, bB)

  // 四角圆角
  for (const [ax, ay] of [[bodyL, bodyTop], [bodyR - 1, bodyTop], [bodyL, bodyBot - 1], [bodyR - 1, bodyBot - 1]])
    set(ax, ay, 0, 0, 0, 0)

  // 内容横线
  const lineX = Math.round(7 * s)
  for (let line = 0; line < 3; line++) {
    const y = Math.round((14 + line * 6) * s)
    const w = Math.round((line === 2 ? 12 : 18) * s)
    for (let x = lineX; x < lineX + w; x++)
      set(x, y, 200, 215, 235)
  }

  return nativeImage.createFromBuffer(buf, { width: S, height: S })
}

function buildTray(): void {
  const iconPath = join(import.meta.dirname, '../../resources/tray.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    icon = generateClipIcon(32)
  }

  tray = new Tray(icon)
  tray.setToolTip('Clip 剪贴板')
  refreshTrayMenu()
  tray.on('click', toggleWindow)
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: toggleWindow },
      {
        label: '暂停记录',
        type: 'checkbox',
        checked: settings.paused,
        click: (menuItem) => {
          settings = { ...settings, paused: menuItem.checked }
          writeSettings(db, { paused: menuItem.checked })
          watcher.setPaused(menuItem.checked)
          broadcastSettings()
          refreshTrayMenu()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

/** 剪贴板抓到新内容 → 落库 → 通知界面 */
function onCaptured(captured: Captured): void {
  const target = getClipboardCollection(db)
  if (!target) return

  const base: NewItemInput = {
    collectionId: target.id,
    type: captured.type,
    content: '',
    hash: captured.hash,
    size: captured.size,
    sourceApp: captured.sourceApp,
    originDevice: settings.deviceId
  }

  const input: NewItemInput =
    captured.type === 'text'
      ? { ...base, content: captured.content }
      : {
          ...base,
          content: images.save(captured.hash, captured.buffer),
          width: captured.width,
          height: captured.height
        }

  const item = addItem(db, input)
  const orphans = trimCollection(db, target.id)
  if (orphans.length > 0) images.remove(orphans)

  mainWindow?.webContents.send(IPC.onItemAdded, item)
  // 剪贴板分类若设为自动同步，新条目立刻推给在线设备
  if (target.syncMode === 'auto') syncServer.broadcastAutoChanges()
}

function syncStatus(): SyncServerStatus {
  return {
    running: syncServer.isRunning,
    port: syncServer.listeningPort,
    addresses: localAddresses(),
    pairingQr: syncServer.isPairing ? pairingQr : null,
    devices: syncServer.listPairedDevices()
  }
}

function broadcastSyncStatus(): void {
  mainWindow?.webContents.send(IPC.onSyncChanged, syncStatus())
}

/** 接收目录：设置里指定了就用它，否则落在系统下载目录的 Clip 子目录 */
function downloadDir(): string {
  return settings.downloadDir || join(app.getPath('downloads'), 'Clip')
}

function registerIpc(): void {
  ipcMain.handle(IPC.collectionsList, () => listCollections(db))

  ipcMain.handle(IPC.collectionsCreate, (_e, input: NewCollectionInput) =>
    createCollection(db, input)
  )

  ipcMain.handle(IPC.collectionsUpdate, (_e, id: string, patch: CollectionPatch) => {
    updateCollection(db, id, patch)
    // 上限调小时立刻生效
    if (patch.maxItems !== undefined) {
      const orphans = trimCollection(db, id)
      if (orphans.length > 0) images.remove(orphans)
    }
  })

  ipcMain.handle(IPC.collectionsDelete, (_e, id: string) => {
    const orphans = deleteCollection(db, id)
    if (orphans.length > 0) images.remove(orphans)
  })

  ipcMain.handle(IPC.collectionsReorder, (_e, orderedIds: string[]) =>
    reorderCollections(db, orderedIds)
  )

  ipcMain.handle(IPC.itemsList, (_e, query: ListItemsQuery) => listItems(db, query))

  ipcMain.handle(IPC.itemsAdd, (_e, input: NewItemInput) => {
    const item = addItem(db, { ...input, originDevice: settings.deviceId })
    const orphans = trimCollection(db, input.collectionId)
    if (orphans.length > 0) images.remove(orphans)
    return item
  })

  ipcMain.handle(IPC.itemsUpdate, (_e, id: string, patch: ItemPatch) => updateItem(db, id, patch))

  ipcMain.handle(IPC.itemsDelete, (_e, ids: string[]) => {
    const orphans = deleteItems(db, ids)
    if (orphans.length > 0) images.remove(orphans)
  })

  ipcMain.handle(IPC.itemsMove, (_e, itemId: string, targetId: string) => {
    moveItemTo(db, itemId, targetId)
  })

  ipcMain.handle(IPC.itemsSearch, (_e, keyword: string) => searchAll(db, keyword))

  ipcMain.handle(IPC.itemsWriteToClipboard, (_e, id: string) => {
    writeItemToClipboard(id)
  })

  ipcMain.handle(IPC.itemsPaste, async (_e, id: string) => {
    if (!writeItemToClipboard(id)) return
    mainWindow?.hide()
    if (settings.autoPaste) await pasteToPreviousWindow(previousHwnd)
  })

  ipcMain.handle(IPC.settingsGet, () => settings)

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    writeSettings(db, patch)
    const previous = settings
    settings = readSettings(db)

    if (patch.paused !== undefined) {
      watcher.setPaused(settings.paused)
      refreshTrayMenu()
    }
    if (patch.hotkey !== undefined && patch.hotkey !== previous.hotkey) {
      registerHotkey(settings.hotkey)
    }
    if (patch.autoLaunch !== undefined) {
      applyAutoLaunch(settings.autoLaunch)
    }
    return settings
  })

  ipcMain.handle(IPC.windowHide, () => mainWindow?.hide())

  ipcMain.handle(IPC.windowLock, () => { suppressBlurHide = true })
  ipcMain.handle(IPC.windowUnlock, () => { suppressBlurHide = false })

  ipcMain.handle(IPC.syncStatus, () => syncStatus())

  ipcMain.handle(IPC.syncStart, async () => {
    await syncServer.start()
    writeSettings(db, { syncEnabled: true })
    settings = readSettings(db)
    return syncStatus()
  })

  ipcMain.handle(IPC.syncStop, () => {
    syncServer.stop()
    pairingQr = null
    writeSettings(db, { syncEnabled: false })
    settings = readSettings(db)
    return syncStatus()
  })

  ipcMain.handle(IPC.syncOpenPairing, async () => {
    if (!syncServer.isRunning) await syncServer.start()

    const payload = syncServer.openPairing()
    if (!payload) {
      pairingQr = null
      return syncStatus()
    }

    // 二维码里是配对密钥，容错等级低一些换取更小的图形，扫码更快
    pairingQr = await toDataURL(JSON.stringify(payload), {
      errorCorrectionLevel: 'L',
      margin: 1,
      width: 320
    })
    return syncStatus()
  })

  ipcMain.handle(IPC.syncClosePairing, () => {
    syncServer.closePairing()
    pairingQr = null
    return syncStatus()
  })

  ipcMain.handle(IPC.syncPush, (_e, itemIds: string[], deviceId?: string) =>
    syncServer.pushItems(itemIds, deviceId)
  )

  ipcMain.handle(IPC.syncForget, (_e, deviceId: string) => {
    removeDevice(db, deviceId)
    return syncStatus()
  })

  ipcMain.handle(IPC.transfersList, () => transfers.list())

  ipcMain.handle(IPC.transfersSend, (_e, paths: string[], deviceId?: string) =>
    syncServer.sendFiles(paths, deviceId)
  )

  ipcMain.handle(IPC.transfersPick, async (_e, deviceId?: string) => {
    if (!mainWindow) return 0
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要发到手机的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return 0
    return syncServer.sendFiles(result.filePaths, deviceId)
  })

  ipcMain.handle(IPC.transfersCancel, (_e, key: string) => transfers.cancel(key))

  ipcMain.handle(IPC.transfersClear, () => transfers.clearFinished())

  ipcMain.handle(IPC.transfersReveal, (_e, path: string) => {
    if (path) shell.showItemInFolder(path)
  })

  ipcMain.handle(IPC.transfersDir, () => downloadDir())

  ipcMain.handle(IPC.transfersChooseDir, async () => {
    if (!mainWindow) return downloadDir()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择接收文件的目录',
      defaultPath: downloadDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return downloadDir()

    writeSettings(db, { downloadDir: result.filePaths[0] })
    settings = readSettings(db)
    transfers.setDownloadDir(downloadDir())
    return downloadDir()
  })
}

/** 把条目写回系统剪贴板，返回是否成功 */
function writeItemToClipboard(id: string): boolean {
  const item = getItem(db, id)
  if (!item || item.deleted) return false

  // 自己写剪贴板不该被当成用户的新复制动作
  watcher.ignoreNext()

  if (item.type === 'text') {
    clipboard.writeText(item.content)
    return true
  }

  try {
    const png = readFileSync(images.pathOf(item.content))
    clipboard.writeImage(nativeImage.createFromBuffer(png))
    return true
  } catch (err) {
    log('CLIP', `图片写回失败: ${String(err)}`)
    return false
  }
}

app.whenReady().then(() => {
  logPath = join(app.getPath('userData'), 'clip.log')
  log('START', 'Clip 启动')

  // 生成打包用图标（开发时自动写入 build/icon.png，供 electron-builder 打包 exe 图标）
  try {
    const buildDir = join(import.meta.dirname, '../../build')
    const iconFile = join(buildDir, 'icon.png')
    if (!existsSync(iconFile)) {
      if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true })
      writeFileSync(iconFile, generateClipIcon(256).toPNG())
      log('ICON', '已生成 build/icon.png')
    }
  } catch { /* 打包后 build 目录不存在，忽略 */ }

  db = openDatabase(join(app.getPath('userData'), 'clip.db'))
  images = new ImageStore(app.getPath('userData'))
  settings = ensureDeviceIdentity(db, hostname())

  // 启动时清一次过期墓碑
  const orphans = purgeTombstones(db, 30)
  if (orphans.length > 0) images.remove(orphans)

  protocol.handle('clip-image', (request) => {
    const name = decodeURIComponent(new URL(request.url).hostname)
    // 只允许 hash 生成的文件名，杜绝 ../ 之类的路径穿越
    if (!/^[a-f0-9]{64}\.png$/.test(name)) return new Response('bad request', { status: 400 })
    return net.fetch(pathToFileURL(images.pathOf(name)).toString())
  })

  watcher = new ClipboardWatcher()
  watcher.on('captured', onCaptured)
  watcher.setPaused(settings.paused)
  watcher.start()

  transfers = new FileTransferManager(downloadDir())
  transfers.on('changed', () => {
    mainWindow?.webContents.send(IPC.onTransfersChanged, transfers.list())
  })

  syncServer = new SyncServer(
    db,
    images,
    () => settings.deviceId,
    () => settings.deviceName,
    transfers
  )
  syncServer.on('changed', broadcastSyncStatus)
  syncServer.on('applied', (count) => {
    mainWindow?.webContents.send(IPC.onRemoteApplied, count)
  })
  if (settings.syncEnabled) {
    syncServer.start().catch((err) => log('SYNC', `启动失败: ${String(err)}`))
  }

  registerIpc()
  createWindow()
  buildTray()
  registerHotkey(settings.hotkey)
  applyAutoLaunch(settings.autoLaunch)

  app.on('second-instance', toggleWindow)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 托盘应用：关掉所有窗口也不退出
app.on('window-all-closed', () => {
  if (!isWindows && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  watcher?.stop()
  syncServer?.stop()
  db?.close()
})
