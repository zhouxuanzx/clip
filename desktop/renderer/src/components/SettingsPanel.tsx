import { useState } from 'react'
import { useStore } from '../store'

interface Props {
  onClose(): void
}

export default function SettingsPanel({ onClose }: Props): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const collections = useStore((s) => s.collections)
  const patchCollection = useStore((s) => s.patchCollection)
  const downloadDir = useStore((s) => s.downloadDir)
  const chooseDownloadDir = useStore((s) => s.chooseDownloadDir)

  const [hotkeyDraft, setHotkeyDraft] = useState(settings.hotkey)
  const [recording, setRecording] = useState(false)

  // 进入录制态后，捕获下一次按键组合，拼成 Electron accelerator 格式（如 Ctrl+Shift+V）
  const onHotkeyKeyDown = (e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(false)
      return
    }
    const mods: string[] = []
    if (e.ctrlKey) mods.push('Control')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    if (e.metaKey) mods.push('Super')
    // 只按了修饰键先不收尾，等真正的键落下
    if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return
    let main = e.key
    if (main === ' ') main = 'Space'
    else if (main.length === 1) main = main.toUpperCase()
    const acc = [...mods, main].join('+')
    setHotkeyDraft(acc)
    void patchSettings({ hotkey: acc })
    setRecording(false)
  }

  return (
    <div
      onClick={onClose}
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85%] w-[420px] overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">设置</h2>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-white">
            ×
          </button>
        </div>

        <Field label="唤起热键">
          {recording ? (
            <button
              autoFocus
              onKeyDown={onHotkeyKeyDown}
              onBlur={() => setRecording(false)}
              className="w-40 rounded bg-[var(--color-accent)]/15 px-2 py-1 text-right text-[var(--color-accent)] outline-none"
            >
              按下组合键…（Esc 取消）
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRecording(true)}
                title="点击后按下要设置的快捷键"
                className="w-40 rounded bg-[var(--color-surface)] px-2 py-1 text-right outline-none hover:bg-[var(--color-surface-hover)]"
              >
                {hotkeyDraft || '点击录制'}
              </button>
              {hotkeyDraft && (
                <button
                  onClick={() => {
                    setHotkeyDraft('')
                    void patchSettings({ hotkey: '' })
                  }}
                  title="清除快捷键"
                  className="text-[var(--color-text-muted)] hover:text-red-400"
                >
                  清除
                </button>
              )}
            </div>
          )}
        </Field>

        <Toggle
          label="选中后自动粘贴到原窗口"
          checked={settings.autoPaste}
          onChange={(v) => patchSettings({ autoPaste: v })}
        />

        <Toggle
          label="开机自启"
          checked={settings.autoLaunch}
          onChange={(v) => patchSettings({ autoLaunch: v })}
        />

        <Toggle
          label="暂停记录剪贴板"
          checked={settings.paused}
          onChange={(v) => patchSettings({ paused: v })}
        />

        <div className="mt-4 mb-2 text-[var(--color-text-muted)]">各分类保留条数（0 = 不限）</div>
        {collections.map((collection) => (
          <Field key={collection.id} label={collection.name}>
            <input
              type="number"
              min={0}
              defaultValue={collection.maxItems}
              onBlur={(e) => {
                const value = Math.max(0, Number(e.target.value) || 0)
                if (value !== collection.maxItems) patchCollection(collection.id, { maxItems: value })
              }}
              className="w-24 rounded bg-[var(--color-surface)] px-2 py-1 text-right outline-none"
            />
          </Field>
        ))}

        <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-3">
          <div className="mb-1.5 text-[var(--color-text-muted)]">手机发来的文件存到</div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded bg-[var(--color-surface)] px-2 py-1 text-[11px]" title={downloadDir}>
              {downloadDir || '（默认下载目录下的 Clip 文件夹）'}
            </span>
            <button
              onClick={() => void chooseDownloadDir()}
              className="shrink-0 rounded bg-[var(--color-surface-hover)] px-2 py-1 hover:text-[var(--color-text-primary)]"
            >
              更改
            </button>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-3 text-[11px] text-[var(--color-text-muted)]">
          本机设备名：{settings.deviceName || '未设置'}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span>{label}</span>
      {children}
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange(value: boolean): void
}): React.JSX.Element {
  return (
    <label className="mb-2 flex cursor-pointer items-center justify-between">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--color-accent)]"
      />
    </label>
  )
}
