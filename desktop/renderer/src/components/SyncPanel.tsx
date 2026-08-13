import type { SyncMode } from '@shared/types'
import { useStore } from '../store'
import { formatTime } from '../format'

const SYNC_MODE_LABEL: Record<SyncMode, string> = {
  off: '不同步',
  manual: '手动推送',
  auto: '自动同步'
}

interface Props {
  onClose(): void
}

export default function SyncPanel({ onClose }: Props): React.JSX.Element {
  const sync = useStore((s) => s.sync)
  const collections = useStore((s) => s.collections)
  const patchCollection = useStore((s) => s.patchCollection)
  const toggleSync = useStore((s) => s.toggleSync)
  const openPairing = useStore((s) => s.openPairing)
  const closePairing = useStore((s) => s.closePairing)
  const forgetDevice = useStore((s) => s.forgetDevice)

  const confirmForget = async (id: string, name: string): Promise<void> => {
    if (confirm(`解除与「${name}」的配对？下次要重新扫码。`)) await forgetDevice(id)
  }

  return (
    <div
      onClick={onClose}
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88%] w-[460px] overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">手机同步</h2>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-white">
            ×
          </button>
        </div>

        <div className="mb-3 flex items-center justify-between rounded bg-[var(--color-surface)] px-3 py-2">
          <div>
            <div>{sync.running ? '局域网服务已开启' : '局域网服务未开启'}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {sync.running
                ? sync.addresses.length > 0
                  ? `${sync.addresses.join(' / ')}:${sync.port}`
                  : '没有可用网卡，手机连不上'
                : '开启后手机才能连接'}
            </div>
          </div>
          <button
            onClick={toggleSync}
            className={`rounded px-3 py-1 ${
              sync.running
                ? 'bg-[var(--color-surface-hover)]'
                : 'bg-[var(--color-accent)] text-white'
            }`}
          >
            {sync.running ? '关闭' : '开启'}
          </button>
        </div>

        {sync.pairingQr ? (
          <div className="mb-3 flex flex-col items-center rounded bg-white p-3">
            <img src={sync.pairingQr} alt="配对二维码" className="h-56 w-56" />
            <div className="mt-2 text-[11px] text-neutral-600">
              用手机端「扫码配对」扫描，3 分钟内有效
            </div>
            <button
              onClick={closePairing}
              className="mt-2 rounded bg-neutral-200 px-3 py-1 text-neutral-700"
            >
              关闭二维码
            </button>
          </div>
        ) : (
          <button
            onClick={openPairing}
            className="mb-3 w-full rounded border border-dashed border-[var(--color-border-subtle)] py-2 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            + 配对新手机（显示二维码）
          </button>
        )}

        <div className="mb-1.5 text-[var(--color-text-muted)]">已配对设备</div>
        {sync.devices.length === 0 ? (
          <div className="mb-3 rounded bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text-muted)]">
            还没有配对过设备
          </div>
        ) : (
          sync.devices.map((device) => (
            <div
              key={device.id}
              className="group mb-1.5 flex items-center gap-2 rounded bg-[var(--color-surface)] px-3 py-2"
            >
              <span
                title={device.online ? '在线' : '离线'}
                className={`h-2 w-2 shrink-0 rounded-full ${
                  device.online ? 'bg-emerald-400' : 'bg-neutral-600'
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate">{device.name}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {device.online
                    ? '在线'
                    : device.lastSeen
                      ? `最后在线 ${formatTime(device.lastSeen)}`
                      : '从未连接'}
                </div>
              </div>
              <button
                onClick={() => confirmForget(device.id, device.name)}
                className="hidden shrink-0 text-[var(--color-text-muted)] hover:text-red-400 group-hover:block"
              >
                解除配对
              </button>
            </div>
          ))
        )}

        <div className="mt-4 mb-2 text-[var(--color-text-muted)]">各分类同步策略</div>
        {collections.map((collection) => (
          <div key={collection.id} className="mb-2 flex items-center justify-between">
            <span className="truncate">{collection.name}</span>
            <select
              value={collection.syncMode}
              onChange={(e) => patchCollection(collection.id, { syncMode: e.target.value as SyncMode })}
              className="rounded bg-[var(--color-surface)] px-2 py-1 outline-none"
            >
              {(['off', 'manual', 'auto'] as SyncMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {SYNC_MODE_LABEL[mode]}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div className="text-[11px] text-[var(--color-text-muted)]">
          自动同步的分类两端保持一致；手动推送的分类只在你点「推送」时发送。
        </div>
      </div>
    </div>
  )
}
