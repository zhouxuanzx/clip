import { useState } from 'react'
import type { FileTransfer } from '@shared/sync'
import { useStore } from '../store'
import { formatSize, formatTime } from '../format'

const STATE_LABEL: Record<FileTransfer['state'], string> = {
  waiting: '排队中',
  active: '传输中',
  done: '完成',
  failed: '失败',
  canceled: '已取消'
}

const STATE_COLOR: Record<FileTransfer['state'], string> = {
  waiting: 'text-[var(--color-text-muted)]',
  active: 'text-[var(--color-accent)]',
  done: 'text-emerald-400',
  failed: 'text-red-400',
  canceled: 'text-[var(--color-text-muted)]'
}

export default function TransfersPage(): React.JSX.Element {
  const transfers = useStore((s) => s.transfers)
  const devices = useStore((s) => s.sync.devices)
  const sendFiles = useStore((s) => s.sendFiles)
  const pickFiles = useStore((s) => s.pickFiles)
  const cancelTransfer = useStore((s) => s.cancelTransfer)
  const clearTransfers = useStore((s) => s.clearTransfers)
  const revealTransfer = useStore((s) => s.revealTransfer)
  const setView = useStore((s) => s.setView)

  const [targetId, setTargetId] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const online = devices.filter((d) => d.online)
  const effectiveId = targetId || online[0]?.id || ''
  const targetLabel = devices.find((d) => d.id === effectiveId)?.name ?? '在线设备'

  const finishedCount = transfers.filter(
    (t) => t.state === 'done' || t.state === 'failed' || t.state === 'canceled'
  ).length

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    const paths = [...event.dataTransfer.files]
      .map((f) => (f as unknown as { path?: string }).path)
      .filter((p): p is string => !!p)
    if (paths.length > 0) void sendFiles(paths, effectiveId)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <button
          onClick={() => setView('collections')}
          title="返回剪贴板"
          className="shrink-0 rounded px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          ← 返回
        </button>
        <span className="font-medium">传输</span>

        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="rounded bg-[var(--color-surface-raised)] px-2 py-1 text-[var(--color-text-muted)] outline-none"
        >
          <option value="">
            {online.length > 0 ? `发送到：${targetLabel}` : '（没有在线设备）'}
          </option>
          {online.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>

        <button
          onClick={() => void pickFiles(effectiveId)}
          title="弹系统选择框挑文件"
          className="rounded bg-[var(--color-accent)] px-3 py-1 text-white hover:bg-[var(--color-accent)]/85"
        >
          选择文件
        </button>

        {finishedCount > 0 && (
          <button
            onClick={() => void clearTransfers()}
            className="rounded bg-[var(--color-surface-hover)] px-3 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            清空已完成
          </button>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex-1 overflow-y-auto p-3 transition ${
          dragOver ? 'bg-[var(--color-accent)]/10 ring-2 ring-inset ring-[var(--color-accent)]' : ''
        }`}
      >
        {transfers.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-text-muted)]">
            <div className="text-4xl">⇄</div>
            <div>把文件拖到这里，或点「选择文件」发给手机</div>
            <div className="text-[11px]">手机发来的文件会自动存到接收目录</div>
          </div>
        ) : (
          <div className="space-y-2">
            {transfers.map((t) => (
              <TransferRow
                key={t.key}
                transfer={t}
                onCancel={() => void cancelTransfer(t.key)}
                onReveal={() => void revealTransfer(t.path)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TransferRow({
  transfer,
  onCancel,
  onReveal
}: {
  transfer: FileTransfer
  onCancel(): void
  onReveal(): void
}): React.JSX.Element {
  const pct =
    transfer.size > 0 ? Math.min(100, Math.round((transfer.transferred / transfer.size) * 100)) : 0
  const isReceive = transfer.direction === 'receive'
  const active = transfer.state === 'active' || transfer.state === 'waiting'

  return (
    <div className="rounded bg-[var(--color-surface)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[var(--color-text-muted)]">{isReceive ? '↓' : '↑'}</span>
        <span className="min-w-0 flex-1 truncate font-medium" title={transfer.name}>
          {transfer.name}
        </span>
        <span className={`shrink-0 ${STATE_COLOR[transfer.state]}`}>
          {active ? `${STATE_LABEL[transfer.state]} ${pct}%` : STATE_LABEL[transfer.state]}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <span className="truncate">
          {transfer.deviceName} · {formatTime(transfer.startedAt)}
        </span>
        <span className="shrink-0">
          {formatSize(transfer.transferred)}
          {transfer.size > 0 && ` / ${formatSize(transfer.size)}`}
        </span>
        {transfer.error && <span className="truncate text-red-400">{transfer.error}</span>}
      </div>

      {active && (
        <div className="mt-1.5 h-1 overflow-hidden rounded bg-[var(--color-surface-hover)]">
          <div
            className="h-full bg-[var(--color-accent)] transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <div className="mt-1.5 flex gap-3 text-[11px]">
        {active && (
          <button onClick={onCancel} className="text-[var(--color-text-muted)] hover:text-red-400">
            取消
          </button>
        )}
        {isReceive && transfer.state === 'done' && (
          <button onClick={onReveal} className="text-[var(--color-accent)] hover:underline">
            打开所在文件夹
          </button>
        )}
      </div>
    </div>
  )
}
