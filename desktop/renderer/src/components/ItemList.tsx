import { useMemo, useState } from 'react'
import { VList } from 'virtua'
import type { Collection, Item } from '@shared/types'
import { useStore } from '../store'
import ItemRow from './ItemRow'

interface Props {
  activeCollection: Collection | null
}

function NewItemInput({ collectionId, onDone }: { collectionId: string; onDone(): void }): React.JSX.Element {
  const addItem = useStore((s) => s.addItem)
  const [text, setText] = useState('')

  const submit = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) { onDone(); return }
    await addItem(collectionId, trimmed)
    setText('')
    onDone()
  }

  return (
    <div className="mx-2 mb-1 mt-1 rounded border border-[var(--color-accent)] bg-[var(--color-surface)] p-2">
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          if (e.key === 'Escape') onDone()
        }}
        placeholder="输入内容，Enter 确认…"
        className="w-full resize-none rounded bg-[var(--color-surface-hover)] px-2 py-1 outline-none"
      />
      <div className="mt-1.5 flex gap-1">
        <button onClick={submit} className="flex-1 rounded bg-[var(--color-accent)] py-1 text-white">添加</button>
        <button onClick={onDone} className="flex-1 rounded bg-[var(--color-surface-hover)] py-1">取消</button>
      </div>
    </div>
  )
}

export default function ItemList({ activeCollection }: Props): React.JSX.Element {
  const items = useStore((s) => s.items)
  const searchHits = useStore((s) => s.searchHits)
  const collections = useStore((s) => s.collections)
  const selectedIds = useStore((s) => s.selectedIds)
  const toggleSelected = useStore((s) => s.toggleSelected)
  const togglePinned = useStore((s) => s.togglePinned)
  const toggleDone = useStore((s) => s.toggleDone)
  const moveItem = useStore((s) => s.moveItem)
  const removeItem = useStore((s) => s.removeItem)
  const activeCollectionId = useStore((s) => s.activeCollectionId)
  const todoFilter = useStore((s) => s.todoFilter)
  const setTodoFilter = useStore((s) => s.setTodoFilter)
  const todoDay = useStore((s) => s.todoDay)
  const setTodoDay = useStore((s) => s.setTodoDay)

  const [showNewInput, setShowNewInput] = useState(false)

  const searching = searchHits !== null
  const rawRows: Item[] = searching ? searchHits! : items

  const collectionNameById = useMemo(
    () => new Map(collections.map((c) => [c.id, c.name])),
    [collections]
  )

  const canAdd = !searching && activeCollection && activeCollection.kind !== 'clipboard'

  // 日期辅助：时间戳转 'YYYY-MM-DD'，待办按天筛选用
  const ymd = (ts: number): string => {
    const d = new Date(ts)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const today = ymd(Date.now())
  const yesterday = ymd(Date.now() - 86400000)

  // 收藏分类（不含当前所在分类）：♥ 把条目移进去
  const favoritesCollection = useMemo(
    () => collections.find((c) => c.name === '收藏' && c.id !== activeCollectionId),
    [collections, activeCollectionId]
  )

  // 筛选：待办按 全部/未完成/已完成 + 按天
  let rows: Item[] = rawRows
  if (activeCollection?.kind === 'todo') {
    rows = rawRows.filter((r) => {
      if (todoFilter === 'active' && r.done) return false
      if (todoFilter === 'done' && !r.done) return false
      if (todoDay && ymd(r.createdAt) !== todoDay) return false
      return true
    })
  }

  if (rawRows.length === 0) {
    if (showNewInput && activeCollectionId) {
      return (
        <div className="flex flex-1 flex-col">
          <NewItemInput collectionId={activeCollectionId} onDone={() => setShowNewInput(false)} />
          <div className="flex flex-1 items-center justify-center text-[var(--color-text-muted)]">
            {searching ? '没有匹配的内容' : '还没有内容'}
          </div>
        </div>
      )
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-[var(--color-text-muted)] gap-3">
        <span>{searching ? '没有匹配的内容' : '还没有内容'}</span>
        {canAdd && (
          <button
            onClick={() => setShowNewInput(true)}
            className="rounded border border-dashed border-[var(--color-accent)] px-4 py-1.5 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
          >
            + 新建条目
          </button>
        )}
      </div>
    )
  }

  // 有内容但被筛选过滤光了：给个明确的空状态和"清除筛选"
  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-[var(--color-text-muted)] gap-3">
        <span>没有符合条件的条目</span>
        {activeCollection?.kind === 'todo' && (
          <button
            onClick={() => {
              setTodoFilter('all')
              setTodoDay(null)
            }}
            className="rounded border border-dashed border-[var(--color-accent)] px-4 py-1.5 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
          >
            清除筛选
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      {activeCollection?.kind === 'todo' && !searching && (
        <div className="flex flex-wrap items-center gap-1 px-2 pt-1 text-[11px]">
          {(['all', 'active', 'done'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setTodoFilter(f)}
              className={
                todoFilter === f
                  ? 'rounded bg-[var(--color-accent)]/15 px-2 py-0.5 text-[var(--color-accent)]'
                  : 'rounded bg-[var(--color-surface-hover)] px-2 py-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              }
            >
              {f === 'all' ? '全部' : f === 'active' ? '未完成' : '已完成'}
            </button>
          ))}
          <span className="mx-1 text-[var(--color-text-muted)]">·</span>
          <button
            onClick={() => setTodoDay(today)}
            className={
              todoDay === today
                ? 'rounded bg-[var(--color-accent)]/15 px-2 py-0.5 text-[var(--color-accent)]'
                : 'rounded bg-[var(--color-surface-hover)] px-2 py-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
            }
          >
            今天
          </button>
          <button
            onClick={() => setTodoDay(yesterday)}
            className={
              todoDay === yesterday
                ? 'rounded bg-[var(--color-accent)]/15 px-2 py-0.5 text-[var(--color-accent)]'
                : 'rounded bg-[var(--color-surface-hover)] px-2 py-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
            }
          >
            昨天
          </button>
          <button
            onClick={() => setTodoDay(null)}
            className={
              todoDay === null
                ? 'rounded bg-[var(--color-accent)]/15 px-2 py-0.5 text-[var(--color-accent)]'
                : 'rounded bg-[var(--color-surface-hover)] px-2 py-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
            }
          >
            全部日期
          </button>
          <input
            type="date"
            value={todoDay ?? ''}
            onChange={(e) => setTodoDay(e.target.value || null)}
            className="rounded bg-[var(--color-surface-hover)] px-1 py-0.5 text-[var(--color-text-muted)] outline-none"
          />
        </div>
      )}
      {canAdd && !showNewInput && (
        <div className="flex px-2 pt-1">
          <button
            onClick={() => setShowNewInput(true)}
            className="flex-1 rounded border border-dashed border-[var(--color-border-subtle)] py-1 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            + 新建条目
          </button>
        </div>
      )}
      {showNewInput && activeCollectionId && (
        <NewItemInput collectionId={activeCollectionId} onDone={() => setShowNewInput(false)} />
      )}
      <VList className="flex-1 px-2 py-1">
      {rows.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          collectionName={searching ? collectionNameById.get(item.collectionId) : undefined}
          kind={
            searching
              ? (collections.find((c) => c.id === item.collectionId)?.kind ?? 'list')
              : (activeCollection?.kind ?? 'list')
          }
          selected={selectedIds.has(item.id)}
          targets={collections.filter((c) => c.id !== item.collectionId && c.kind !== 'clipboard')}
          onClick={(event) => {
            toggleSelected(item.id, event.ctrlKey || event.metaKey)
            window.clip.items.writeToClipboard(item.id)
          }}
          onPaste={() => window.clip.items.paste(item.id)}
          onTogglePinned={() => togglePinned(item)}
          onToggleDone={() => toggleDone(item)}
          onFavorite={favoritesCollection ? () => moveItem(item.id, favoritesCollection.id) : undefined}
          onMove={(targetId) => moveItem(item.id, targetId)}
          onRemove={() => removeItem(item.id)}
        />
      ))}
      </VList>
    </div>
  )
}
