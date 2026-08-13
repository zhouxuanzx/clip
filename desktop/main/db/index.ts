import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { migrate } from './schema'
import { ensureBuiltinCollections } from './collections'

export * from './collections'
export * from './items'
export * from './settings'
export * from './devices'
export * from './sync'
export { migrate } from './schema'

/**
 * 打开数据库并升级到最新结构。
 * 传 ':memory:' 可以开一个内存库，单元测试用。
 */
export function openDatabase(filePath: string): Db {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  ensureBuiltinCollections(db)
  return db
}
