import type { Database } from 'better-sqlite3'

export interface DeviceRecord {
  id: string
  name: string
  platform: string
  /** 长期会话密钥，配对时派生。重连时用它再派生本次的传输密钥 */
  sessionKey: Buffer
  lastAddress: string | null
  pairedAt: number
  lastSeen: number
  /** 上次成功同步的时间点，增量同步的水位线 */
  lastSyncAt: number
}

interface DeviceRow {
  id: string
  name: string
  platform: string
  session_key: Buffer | null
  last_address: string | null
  paired_at: number
  last_seen: number
  last_sync_at: number
}

function toDevice(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    sessionKey: row.session_key ?? Buffer.alloc(0),
    lastAddress: row.last_address,
    pairedAt: row.paired_at,
    lastSeen: row.last_seen,
    lastSyncAt: row.last_sync_at
  }
}

export function listDevices(db: Database): DeviceRecord[] {
  return db
    .prepare<[], DeviceRow>(`SELECT * FROM devices ORDER BY last_seen DESC`)
    .all()
    .map(toDevice)
}

export function getDevice(db: Database, id: string): DeviceRecord | null {
  const row = db.prepare<[string], DeviceRow>(`SELECT * FROM devices WHERE id = ?`).get(id)
  return row ? toDevice(row) : null
}

/** 配对成功后写入；重复配对同一设备则覆盖密钥 */
export function upsertDevice(
  db: Database,
  device: Omit<DeviceRecord, 'lastSyncAt'> & { lastSyncAt?: number }
): void {
  db.prepare(
    `INSERT INTO devices (id, name, platform, session_key, last_address, paired_at, last_seen, last_sync_at)
     VALUES (@id, @name, @platform, @sessionKey, @lastAddress, @pairedAt, @lastSeen, @lastSyncAt)
     ON CONFLICT(id) DO UPDATE SET
       name         = excluded.name,
       platform     = excluded.platform,
       session_key  = excluded.session_key,
       last_address = excluded.last_address,
       last_seen    = excluded.last_seen`
  ).run({
    ...device,
    lastSyncAt: device.lastSyncAt ?? 0
  })
}

export function touchDevice(db: Database, id: string, address: string | null): void {
  db.prepare(`UPDATE devices SET last_seen = ?, last_address = ? WHERE id = ?`).run(
    Date.now(),
    address,
    id
  )
}

export function markSynced(db: Database, id: string, at: number): void {
  db.prepare(`UPDATE devices SET last_sync_at = ? WHERE id = ?`).run(at, id)
}

export function removeDevice(db: Database, id: string): void {
  db.prepare(`DELETE FROM devices WHERE id = ?`).run(id)
}
