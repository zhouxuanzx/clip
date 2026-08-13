import { useEffect, useState } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import Toolbar from './components/Toolbar'
import ItemList from './components/ItemList'
import TransfersPage from './components/TransfersPage'
import SettingsPanel from './components/SettingsPanel'
import SyncPanel from './components/SyncPanel'

export default function App(): React.JSX.Element {
  const loading = useStore((s) => s.loading)
  const loadAll = useStore((s) => s.loadAll)
  const collections = useStore((s) => s.collections)
  const activeId = useStore((s) => s.activeCollectionId)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const onExternalItem = useStore((s) => s.onExternalItem)
  const clearSelection = useStore((s) => s.clearSelection)
  const toast = useStore((s) => s.toast)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    const offItem = window.clip.onItemAdded(onExternalItem)
    const offSettings = window.clip.onSettingsChanged((settings) =>
      useStore.setState({ settings })
    )
    const offSync = window.clip.onSyncChanged((sync) => useStore.setState({ sync }))
    // 远端写入的条目可能落在任意分类，直接整表刷新最省事
    const offApplied = window.clip.onRemoteApplied(async (count) => {
      const { refreshItems, showToast } = useStore.getState()
      useStore.setState({ collections: await window.clip.collections.list() })
      await refreshItems()
      showToast(`收到手机同步的 ${count} 项`)
    })
    // 文件传输进度/状态变化：直接替换列表，并在收到新文件时提示
    const offTransfers = window.clip.onTransfersChanged((transfers) => {
      const prev = useStore.getState().transfers
      for (const t of transfers) {
        if (t.direction === 'receive' && t.state === 'done') {
          const before = prev.find((p) => p.key === t.key)
          if (!before || before.state !== 'done') {
            useStore.getState().showToast(`收到文件：${t.name}`)
          }
        }
      }
      useStore.setState({ transfers })
    })
    return () => {
      offItem()
      offSettings()
      offSync()
      offApplied()
      offTransfers()
    }
  }, [onExternalItem])

  // Esc 收起窗口，符合"弹出式工具"的直觉
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (settingsOpen || syncOpen) {
        setSettingsOpen(false)
        setSyncOpen(false)
        return
      }
      if (view === 'transfers') {
        setView('collections')
        return
      }
      clearSelection()
      window.clip.window.hide()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, syncOpen, view, setView, clearSelection])

  const activeCollection = collections.find((c) => c.id === activeId) ?? null

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-text-muted)]">
        加载中…
      </div>
    )
  }

  return (
    <div className="relative flex h-full">
      <Sidebar
        view={view}
        onOpenTransfers={() => setView('transfers')}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSync={() => setSyncOpen(true)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {view === 'transfers' ? (
          <TransfersPage />
        ) : (
          <>
            <Toolbar activeCollection={activeCollection} />
            <ItemList activeCollection={activeCollection} />
          </>
        )}
      </main>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {syncOpen && <SyncPanel onClose={() => setSyncOpen(false)} />}
      {toast && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded bg-black/80 px-3 py-1.5 text-white">
          {toast}
        </div>
      )}
    </div>
  )
}
