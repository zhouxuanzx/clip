import { useState } from 'react'
import type { Item } from '@shared/types'
import { useStore } from '../store'
import { formatSize, formatTime } from '../format'

interface Props {
  item: Item
}

/**
 * 备忘录式编辑器：占据整个主区域，大编辑区 + 图片管理。
 */
export default function ItemEditor({ item }: Props): React.JSX.Element {
  const closeEditor = useStore((s) => s.closeEditor)
  const saveEditor = useStore((s) => s.saveEditor)
  const removeItem = useStore((s) => s.removeItem)
  const showToast = useStore((s) => s.showToast)

  const [text, setText] = useState(item.content)
  const [images, setImages] = useState<string[]>(item.images)
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)

  const canSave = text.trim() !== '' || images.length > 0

  const save = async (): Promise<void> => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      await saveEditor(item.id, text, images)
    } finally {
      setSaving(false)
    }
  }

  const pickImages = async (): Promise<void> => {
    setPicking(true)
    try {
      const picked = await window.clip.items.pickImages()
      if (picked.length > 0) setImages((prev) => [...prev, ...picked.map((p) => p.name)])
    } finally {
      setPicking(false)
    }
  }

  const pasteImage = async (): Promise<void> => {
    const img = await window.clip.items.imageFromClipboard()
    if (img) {
      setImages((prev) => [...prev, img.name])
      showToast('已插入剪贴板图片')
    } else {
      showToast('剪贴板里没有图片')
    }
  }

  const copyImage = async (name: string): Promise<void> => {
    const ok = await window.clip.items.copyImage(name)
    showToast(ok ? '图片已复制，可粘贴到微信/Word' : '复制图片失败')
  }

  // Ctrl+V 时若剪贴板里带图，把图插进条目而不是贴进文本框
  const onPaste = (e: React.ClipboardEvent): void => {
    const hasImage = Array.from(e.clipboardData.items).some(
      (it) => it.kind === 'file' && it.type.startsWith('image/')
    )
    if (!hasImage) return
    e.preventDefault()
    void pasteImage()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeEditor()
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    }
  }

  return (
    <div className="flex h-full flex-col" onPaste={onPaste} onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <button
          onClick={closeEditor}
          title="返回（Esc）"
          className="shrink-0 rounded px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          ← 返回
        </button>
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-muted)]">
          编辑条目
        </span>
        <button
          onClick={async () => {
            await removeItem(item.id)
            closeEditor()
          }}
          className="shrink-0 rounded bg-red-500/15 px-2 py-1 text-red-400 hover:bg-red-500/25"
        >
          删除
        </button>
        <button
          onClick={() => void save()}
          disabled={!canSave || saving}
          title="保存（Ctrl+S）"
          className="shrink-0 rounded bg-[var(--color-accent)] px-3 py-1 text-white disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {item.blocks && item.blocks.length > 0 && (
        <div className="max-h-44 shrink-0 overflow-auto border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2">
          <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">原版式（只读预览）</div>
          <div className="space-y-1">
            {item.blocks.map((b, i) =>
              b.t === 'text' ? (
                <div key={i} className="whitespace-pre-wrap break-all text-sm">
                  {b.text}
                </div>
              ) : (
                <img
                  key={i}
                  src={`clip-image://${b.name}`}
                  alt=""
                  className="max-h-40 max-w-full rounded object-contain"
                />
              )
            )}
          </div>
        </div>
      )}

      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入内容，Ctrl+S 保存，Esc 取消…"
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 outline-none placeholder:text-[var(--color-text-muted)]"
      />

      {images.length > 0 && (
        <div className="flex flex-wrap gap-3 border-t border-[var(--color-border-subtle)] px-4 py-3">
          {images.map((name, i) => (
            <div
              key={`${name}-${i}`}
              className="group relative rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-1.5"
            >
              <img
                src={`clip-image://${name}`}
                alt=""
                className="max-h-40 max-w-56 rounded object-contain"
              />
              <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => void copyImage(name)}
                  title="复制图片到系统剪贴板"
                  className="rounded bg-black/70 px-1.5 py-0.5 text-xs text-white hover:bg-black/90"
                >
                  复制
                </button>
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  title="从条目移除这张图"
                  className="rounded bg-black/70 px-1.5 py-0.5 text-xs text-white hover:bg-black/90"
                >
                  移除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border-subtle)] px-3 py-2">
        <button
          onClick={() => void pickImages()}
          disabled={picking}
          className="shrink-0 rounded bg-[var(--color-surface-hover)] px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          {picking ? '…' : '🖼 添加图片'}
        </button>
        <button
          onClick={() => void pasteImage()}
          className="shrink-0 rounded bg-[var(--color-surface-hover)] px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          粘贴剪贴板图片
        </button>
        <span className="flex-1 truncate text-right text-[11px] text-[var(--color-text-muted)]">
          {formatTime(item.createdAt)}
          {item.sourceApp ? ` · ${item.sourceApp}` : ''}
          {` · ${formatSize(item.size)}`}
        </span>
      </div>
    </div>
  )
}
