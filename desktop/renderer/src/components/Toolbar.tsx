import type { Collection } from '@shared/types'
import { useStore } from '../store'

interface Props {
  activeCollection: Collection | null
}

export default function Toolbar({ activeCollection }: Props): React.JSX.Element {
  const keyword = useStore((s) => s.keyword)
  const setKeyword = useStore((s) => s.setKeyword)
  const selectedIds = useStore((s) => s.selectedIds)
  const removeSelected = useStore((s) => s.removeSelected)
  const pushSelected = useStore((s) => s.pushSelected)
  const paused = useStore((s) => s.settings.paused)
  const patchSettings = useStore((s) => s.patchSettings)
  const searching = useStore((s) => s.searchHits !== null)
  const hasOnlineDevice = useStore((s) => s.sync.devices.some((d) => d.online))

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <input
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="搜索全部分类…"
        className="flex-1 rounded bg-[var(--color-surface-raised)] px-2.5 py-1.5 outline-none placeholder:text-[var(--color-text-muted)] focus:ring-1 focus:ring-[var(--color-accent)]"
      />

      {!searching && activeCollection && (
        <span className="shrink-0 text-[var(--color-text-muted)]">{activeCollection.name}</span>
      )}

      {selectedIds.size > 0 && hasOnlineDevice && (
        <button
          onClick={() => pushSelected()}
          title="推送到在线的手机"
          className="shrink-0 rounded bg-[var(--color-accent)]/15 px-2 py-1 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25"
        >
          推送到手机
        </button>
      )}

      {selectedIds.size > 0 && (
        <button
          onClick={removeSelected}
          className="shrink-0 rounded bg-red-500/15 px-2 py-1 text-red-400 hover:bg-red-500/25"
        >
          删除 {selectedIds.size} 项
        </button>
      )}

      <button
        onClick={() => patchSettings({ paused: !paused })}
        title={paused ? '当前已暂停记录剪贴板' : '暂停记录（复制密码时用）'}
        className={`shrink-0 rounded px-2 py-1 ${
          paused
            ? 'bg-amber-500/20 text-amber-400'
            : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        {paused ? '已暂停' : '记录中'}
      </button>
    </div>
  )
}
