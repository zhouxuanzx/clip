import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

export function readSettings(db: Database): AppSettings {
  const rows = db.prepare<[], { key: string; value: string }>(`SELECT key, value FROM settings`).all()
  const stored: Record<string, unknown> = {}
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value)
    } catch {
      // 单个坏值不该让整个应用起不来，忽略即可，下次写入会覆盖
    }
  }
  return { ...DEFAULT_SETTINGS, ...stored } as AppSettings
}

export function writeSettings(db: Database, patch: Partial<AppSettings>): void {
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      stmt.run(key, JSON.stringify(value))
    }
  })()
}

/** 首次启动生成本机设备标识，后续同步握手要用 */
export function ensureDeviceIdentity(db: Database, defaultName: string): AppSettings {
  const settings = readSettings(db)
  const patch: Partial<AppSettings> = {}
  if (!settings.deviceId) patch.deviceId = randomUUID()
  if (!settings.deviceName) patch.deviceName = defaultName

  if (Object.keys(patch).length > 0) {
    writeSettings(db, patch)
    return { ...settings, ...patch }
  }
  return settings
}
