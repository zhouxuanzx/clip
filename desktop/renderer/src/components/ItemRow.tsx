import { useState } from 'react'
import type { Collection, Item } from '@shared/types'
import { formatSize, formatTime, previewText } from '../format'

interface Props {
  item: Item
  /** 全局搜索结果里额外显示条目所属分类 */
  collectionName?: string
  kind: Collection['kind']
  selected: boolean
  /** 可移动到的目标分类（不含条目当前所在分类、不含剪贴板分类） */
  targets: Collection[]
  onClick(event: React.MouseEvent): void
  onPaste(): void
  onTogglePinned(): void
  onToggleDone(): void
  /** 收藏：把条目移入「收藏」分类（由父组件决定是否提供，已在该分类内则不传） */
  onFavorite?(): void
  onMove(targetId: string): void
  onRemove(): void
}

export default function ItemRow({
  item,
  collectionName,
  kind,
  selected,
  targets,
  onClick,
  onPaste,
  onTogglePinned,
  onToggleDone,
  onFavorite,
  onMove,
  onRemove
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(item.content)

  const isText = item.type === 'text'
  const canEdit = isText && kind !== 'clipboard'

  const submitEdit = async (): Promise<void> => {
    const trimmed = editText.trim()
    if (trimmed && trimmed !== item.content) {
      await window.clip.items.update(item.id, { content: trimmed })
    }
    setEditing(false)
  }

  return (
    <div
      onClick={onClick}
      onDoubleClick={() => {
        // 双击仅用于编辑（列表/待办）；剪贴板条目不再因双击而被粘贴并关窗
        if (canEdit) {
          setEditText(item.content)
          setEditing(true)
        }
      }}
      className={`group mb-1 flex cursor-pointer gap-2 rounded border px-2.5 py-2 ${
        selected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
          : 'border-transparent bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      {kind === 'todo' && (
        <input
          type="checkbox"
          checked={item.done}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleDone}
          className="mt-0.5 shrink-0 accent-[var(--color-accent)]"
        />
      )}

      <div className="min-w-0 flex-1">
        {item.type === 'image' ? (
          <img
            src={`clip-image://${item.content}`}
            alt=""
            className="max-h-24 rounded object-contain"
          />
        ) : editing ? (
          <textarea
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit() }
              if (e.key === 'Escape') { setEditing(false) }
            }}
            onBlur={submitEdit}
            rows={2}
            className="w-full resize-none rounded bg-[var(--color-surface)] px-1.5 py-1 outline-none ring-1 ring-[var(--color-accent)]"
          />
        ) : (
          <div
            className={`break-all whitespace-pre-wrap ${
              item.done ? 'text-[var(--color-text-muted)] line-through' : ''
            }`}
          >
            {previewText(item.content)}
          </div>
        )}

        <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
          <span>{formatTime(item.createdAt)}</span>
          {item.type === 'image' ? (
            <span>
              {item.width}×{item.height}
            </span>
          ) : (
            <span>{formatSize(item.size)}</span>
          )}
          {collectionName && <span className="text-[var(--color-accent)]">{collectionName}</span>}
          {item.sourceApp && <span className="truncate">{item.sourceApp}</span>}
        </div>
      </div>

      <div className="flex shrink-0 items-start gap-1">
        {/* 置顶：被置顶的条目常驻显示 📌，一眼可辨 */}
        <button
          onClick={onTogglePinned}
          title={item.pinned ? '取消置顶' : '置顶'}
          className={`shrink-0 ${item.pinned ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100'}`}
        >
          📌
        </button>

        <div
          onClick={(e) => e.stopPropagation()}
          className="flex shrink-0 items-start gap-1 opacity-0 group-hover:opacity-100"
        >
          {onFavorite && (
            <button
              onClick={onFavorite}
              title="收藏（移入「收藏」分类）"
              className="text-[var(--color-text-muted)] hover:text-pink-400"
            >
              ♥
            </button>
          )}

          {targets.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) onMove(e.target.value)
                e.target.value = ''
              }}
              title="移动到其它分类（含「收藏」）"
              className="rounded bg-[var(--color-surface)] px-1 text-[var(--color-text-muted)] outline-none"
            >
              <option value="">移至…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}

          {kind === 'clipboard' && (
            <button
              onClick={onPaste}
              title="粘贴到上一个窗口并收起"
              className="rounded bg-[var(--color-accent)]/15 px-1.5 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25"
            >
              粘贴
            </button>
          )}

          <button
            onClick={onRemove}
            title="删除"
            className="text-[var(--color-text-muted)] hover:text-red-400"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  )
}
