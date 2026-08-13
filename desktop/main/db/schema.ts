import type { Database } from 'better-sqlite3'

/**
 * 迁移列表。数组下标 + 1 就是 PRAGMA user_version 的目标值。
 * 只允许往后追加，永远不要改动已发布的条目。
 */
export const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
  // v1 初始结构
  (db) => {
    db.exec(`
      CREATE TABLE collections (
        id          TEXT PRIMARY KEY,
        name        TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK (kind IN ('clipboard', 'list', 'todo')),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        max_items   INTEGER NOT NULL DEFAULT 0,
        sync_mode   TEXT    NOT NULL DEFAULT 'off' CHECK (sync_mode IN ('off', 'manual', 'auto')),
        builtin     INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        deleted     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE items (
        id            TEXT PRIMARY KEY,
        collection_id TEXT    NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        type          TEXT    NOT NULL CHECK (type IN ('text', 'image')),
        content       TEXT    NOT NULL,
        hash          TEXT    NOT NULL,
        width         INTEGER,
        height        INTEGER,
        size          INTEGER NOT NULL DEFAULT 0,
        pinned        INTEGER NOT NULL DEFAULT 0,
        done          INTEGER NOT NULL DEFAULT 0,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        source_app    TEXT,
        origin_device TEXT    NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        deleted       INTEGER NOT NULL DEFAULT 0
      );

      -- 列表查询：某分类下未删除的条目，置顶优先、按时间倒序
      CREATE INDEX idx_items_list ON items (collection_id, deleted, pinned, created_at);
      -- 去重：判断某分类里是否已存在同内容条目
      CREATE INDEX idx_items_hash ON items (collection_id, hash, deleted);
      -- 增量同步：按修改时间拉 delta
      CREATE INDEX idx_items_updated ON items (updated_at);
      -- 图片文件引用计数
      CREATE INDEX idx_items_content_type ON items (type, content);

      -- 已配对的设备
      CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        name         TEXT    NOT NULL,
        platform     TEXT    NOT NULL,
        session_key  BLOB,
        last_address TEXT,
        paired_at    INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL DEFAULT 0,
        last_sync_at INTEGER NOT NULL DEFAULT 0
      );

      -- 应用设置，简单的 key-value，value 存 JSON
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }
]

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= MIGRATIONS.length) return

  for (let version = current; version < MIGRATIONS.length; version++) {
    const step = MIGRATIONS[version]!
    db.transaction(() => {
      step(db)
      // user_version 不支持参数绑定，这里的值来自本文件的数组下标，不存在注入风险
      db.pragma(`user_version = ${version + 1}`)
    })()
  }
}
