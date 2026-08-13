import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Collection, CollectionPatch, NewCollectionInput } from '@shared/types'
import { BUILTIN_COLLECTIONS } from '@shared/types'
import { toCollection, type CollectionRow } from './rows'

export function listCollections(db: Database): Collection[] {
  const rows = db
    .prepare<[], CollectionRow>(
      `SELECT * FROM collections WHERE deleted = 0 ORDER BY sort_order ASC, created_at ASC`
    )
    .all()
  return rows.map(toCollection)
}

export function getCollection(db: Database, id: string): Collection | null {
  const row = db
    .prepare<[string], CollectionRow>(`SELECT * FROM collections WHERE id = ?`)
    .get(id)
  return row ? toCollection(row) : null
}

export function createCollection(db: Database, input: NewCollectionInput): Collection {
  const now = Date.now()
  const nextOrder =
    (db
      .prepare<[], { v: number | null }>(`SELECT MAX(sort_order) AS v FROM collections`)
      .get()?.v ?? -1) + 1

  const collection: Collection = {
    id: randomUUID(),
    name: input.name,
    kind: input.kind,
    sortOrder: nextOrder,
    maxItems: input.maxItems ?? 0,
    syncMode: input.syncMode ?? 'off',
    // 剪贴板分类由程序自动写入，删掉就没法工作了，标记为内置
    builtin: input.kind === 'clipboard',
    createdAt: now,
    updatedAt: now,
    deleted: false
  }

  db.prepare(
    `INSERT INTO collections
       (id, name, kind, sort_order, max_items, sync_mode, builtin, created_at, updated_at, deleted)
     VALUES
       (@id, @name, @kind, @sortOrder, @maxItems, @syncMode, @builtin, @createdAt, @updatedAt, 0)`
  ).run({
    ...collection,
    builtin: collection.builtin ? 1 : 0
  })

  return collection
}

export function updateCollection(db: Database, id: string, patch: CollectionPatch): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, updatedAt: Date.now() }

  if (patch.name !== undefined) {
    sets.push('name = @name')
    params.name = patch.name
  }
  if (patch.maxItems !== undefined) {
    sets.push('max_items = @maxItems')
    params.maxItems = patch.maxItems
  }
  if (patch.syncMode !== undefined) {
    sets.push('sync_mode = @syncMode')
    params.syncMode = patch.syncMode
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = @sortOrder')
    params.sortOrder = patch.sortOrder
  }
  if (sets.length === 0) return

  sets.push('updated_at = @updatedAt')
  db.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

/**
 * 删除分类（软删除）。分类下的条目一并打上墓碑，
 * 这样删除动作才能在阶段三通过增量同步传播到手机端。
 * 返回不再被引用的图片文件名，由调用方负责删磁盘文件。
 */
export function deleteCollection(db: Database, id: string): string[] {
  const collection = getCollection(db, id)
  if (!collection || collection.builtin) return []

  const now = Date.now()
  const orphans = db.transaction(() => {
    const images = db
      .prepare<[string], { content: string }>(
        `SELECT DISTINCT content FROM items
          WHERE collection_id = ? AND type = 'image' AND deleted = 0`
      )
      .all(id)
      .map((r) => r.content)

    db.prepare(`UPDATE items SET deleted = 1, updated_at = ? WHERE collection_id = ? AND deleted = 0`).run(
      now,
      id
    )
    db.prepare(`UPDATE collections SET deleted = 1, updated_at = ? WHERE id = ?`).run(now, id)

    // 只有在别的分类里也不再被引用的图片，才算孤儿
    const stillUsed = db.prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM items WHERE type = 'image' AND content = ? AND deleted = 0`
    )
    return images.filter((name) => (stillUsed.get(name)?.n ?? 0) === 0)
  })()

  return orphans
}

/** 按传入的 id 顺序重排左侧菜单 */
export function reorderCollections(db: Database, orderedIds: string[]): void {
  const now = Date.now()
  const stmt = db.prepare(`UPDATE collections SET sort_order = ?, updated_at = ? WHERE id = ?`)
  db.transaction(() => {
    orderedIds.forEach((id, index) => stmt.run(index, now, id))
  })()
}

/** 首次启动时写入预置分类。已有任何分类则不动。 */
export function ensureBuiltinCollections(db: Database): void {
  const count = db
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM collections`)
    .get()!.n
  if (count > 0) return

  db.transaction(() => {
    for (const preset of BUILTIN_COLLECTIONS) createCollection(db, preset)
  })()
}

/** 剪贴板监听写入时要用：找到那个自动记录的分类 */
export function getClipboardCollection(db: Database): Collection | null {
  const row = db
    .prepare<[], CollectionRow>(
      `SELECT * FROM collections WHERE kind = 'clipboard' AND deleted = 0
        ORDER BY sort_order ASC LIMIT 1`
    )
    .get()
  return row ? toCollection(row) : null
}
