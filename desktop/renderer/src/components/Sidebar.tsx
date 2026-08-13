import { useState } from 'react'
import type { Collection, CollectionKind } from '@shared/types'
import { useStore } from '../store'

const KIND_LABEL: Record<CollectionKind, string> = {
  clipboard: '自动记录',
  list: '普通列表',
  todo: '待办'
}

interface Props {
  view: 'collections' | 'transfers'
  onOpenTransfers(): void
  onOpenSettings(): void
  onOpenSync(): void
}

export default function Sidebar({ view, onOpenTransfers, onOpenSettings, onOpenSync }: Props): React.JSX.Element {
  const collections = useStore((s) => s.collections)
  const onlineCount = useStore((s) => s.sync.devices.filter((d) => d.online).length)
  const activeId = useStore((s) => s.activeCollectionId)
  const selectCollection = useStore((s) => s.selectCollection)
  const addCollection = useStore((s) => s.addCollection)
  const renameCollection = useStore((s) => s.renameCollection)
  const removeCollection = useStore((s) => s.removeCollection)

  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftKind, setDraftKind] = useState<CollectionKind>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const submitCreate = async (): Promise<void> => {
    const name = draftName.trim()
    if (!name) {
      setCreating(false)
      return
    }
    await addCollection(name, draftKind)
    setDraftName('')
    setDraftKind('list')
    setCreating(false)
  }

  const submitRename = async (id: string): Promise<void> => {
    const name = editingName.trim()
    if (name) await renameCollection(id, name)
    setEditingId(null)
  }

  const confirmRemove = async (collection: Collection): Promise<void> => {
    await window.clip.window.lock()
    try {
      if (confirm(`删除「${collection.name}」？分类下的条目会一并删除。`)) {
        await removeCollection(collection.id)
      }
    } finally {
      await window.clip.window.unlock()
    }
  }

  return (
    <aside className="flex h-full w-48 shrink-0 flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
      <div className="flex-1 overflow-y-auto py-2">
        {collections.map((collection) => {
          const active = collection.id === activeId
          return (
            <div
              key={collection.id}
              onClick={() => selectCollection(collection.id)}
              onDoubleClick={() => {
                setEditingId(collection.id)
                setEditingName(collection.name)
              }}
              className={`group mx-2 mb-0.5 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${
                active
                  ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              {editingId === collection.id ? (
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => submitRename(collection.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename(collection.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="w-full rounded bg-[var(--color-surface)] px-1 py-0.5 outline-none"
                />
              ) : (
                <>
                  <span className="flex-1 truncate">{collection.name}</span>
                  {!collection.builtin && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        confirmRemove(collection)
                      }}
                      title="删除分类"
                      className="hidden text-[var(--color-text-muted)] hover:text-red-400 group-hover:block"
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}

        {creating ? (
          <div className="mx-2 mt-2 rounded bg-[var(--color-surface)] p-2">
            <input
              autoFocus
              placeholder="分类名称"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate()
                if (e.key === 'Escape') setCreating(false)
              }}
              className="mb-1.5 w-full rounded bg-[var(--color-surface-hover)] px-1.5 py-1 outline-none"
            />
            <select
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value as CollectionKind)}
              className="mb-1.5 w-full rounded bg-[var(--color-surface-hover)] px-1.5 py-1 outline-none"
            >
              <option value="list">{KIND_LABEL.list}</option>
              <option value="todo">{KIND_LABEL.todo}</option>
            </select>
            <div className="flex gap-1">
              <button
                onClick={submitCreate}
                className="flex-1 rounded bg-[var(--color-accent)] py-1 text-white"
              >
                创建
              </button>
              <button
                onClick={() => setCreating(false)}
                className="flex-1 rounded bg-[var(--color-surface-hover)] py-1"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="mx-2 mt-2 w-[calc(100%-1rem)] rounded border border-dashed border-[var(--color-border-subtle)] py-1.5 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            + 新建分类
          </button>
        )}
      </div>

      <div className="flex border-t border-[var(--color-border-subtle)]">
        <button
          onClick={onOpenTransfers}
          title="文件传输"
          className={`flex flex-1 items-center justify-center gap-1.5 py-2 hover:bg-[var(--color-surface-hover)] ${
            view === 'transfers'
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
          }`}
        >
          传输
        </button>
        <button
          onClick={onOpenSync}
          title={onlineCount > 0 ? `${onlineCount} 台设备在线` : '手机同步'}
          className="flex flex-1 items-center justify-center gap-1.5 border-l border-[var(--color-border-subtle)] py-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          手机
          {onlineCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
        </button>
        <button
          onClick={onOpenSettings}
          className="flex-1 border-l border-[var(--color-border-subtle)] py-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          设置
        </button>
      </div>
    </aside>
  )
}
