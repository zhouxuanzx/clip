import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Item, ItemPatch, ListItemsQuery, NewItemInput, SearchHit } from '@shared/types'
import { toItem, type ItemRow } from './rows'
import { getCollection } from './collections'

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** LIKE 关键词转义，避免用户输入的 % _ 变成通配符 */
function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** 不同 kind 的分类，列表排序规则不同 */
function orderClause(kind: string): string {
  if (kind === 'todo') {
    return `ORDER BY done ASC, pinned DESC, sort_order ASC, created_at DESC`
  }
  return `ORDER BY pinned DESC, created_at DESC`
}

export function getItem(db: Database, id: string): Item | null {
  const row = db.prepare<[string], ItemRow>(`SELECT * FROM items WHERE id = ?`).get(id)
  return row ? toItem(row) : null
}

export function listItems(db: Database, query: ListItemsQuery): Item[] {
  const collection = getCollection(db, query.collectionId)
  if (!collection) return []

  const params: unknown[] = [query.collectionId]
  let where = `collection_id = ? AND deleted = 0`
  if (query.keyword) {
    where += ` AND content LIKE ? ESCAPE '\\'`
    params.push(likePattern(query.keyword))
  }
  params.push(query.limit ?? 200, query.offset ?? 0)

  const rows = db
    .prepare<unknown[], ItemRow>(
      `SELECT * FROM items WHERE ${where} ${orderClause(collection.kind)} LIMIT ? OFFSET ?`
    )
    .all(...params)
  return rows.map(toItem)
}

/** 跨全部分类的搜索。图片条目的 content 是文件名，没有搜索意义，只搜文本。 */
export function searchAll(db: Database, keyword: string, limit = 200): SearchHit[] {
  if (!keyword.trim()) return []
  const rows = db
    .prepare<[string, number], ItemRow & { collection_name: string }>(
      `SELECT i.*, c.name AS collection_name
         FROM items i
         JOIN collections c ON c.id = i.collection_id
        WHERE i.deleted = 0 AND c.deleted = 0
          AND i.type = 'text'
          AND i.content LIKE ? ESCAPE '\\'
        ORDER BY i.pinned DESC, i.created_at DESC
        LIMIT ?`
    )
    .all(likePattern(keyword), limit)

  return rows.map((row) => ({ ...toItem(row), collectionName: row.collection_name }))
}

/**
 * 写入条目。若同分类内已存在相同内容（hash 相同）的条目，
 * 不新增，而是把老条目的时间戳刷新到最新——效果就是"置顶回列表最前面"，
 * 避免反复复制同一段文字把历史撑爆。
 */
export function addItem(db: Database, input: NewItemInput): Item {
  const now = input.createdAt ?? Date.now()
  const hash = input.hash ?? sha256(input.content)

  const existing = db
    .prepare<[string, string], ItemRow>(
      `SELECT * FROM items WHERE collection_id = ? AND hash = ? AND deleted = 0 LIMIT 1`
    )
    .get(input.collectionId, hash)

  if (existing) {
    db.prepare(`UPDATE items SET created_at = ?, updated_at = ? WHERE id = ?`).run(
      now,
      now,
      existing.id
    )
    return toItem({ ...existing, created_at: now, updated_at: now })
  }

  const item: Item = {
    id: randomUUID(),
    collectionId: input.collectionId,
    type: input.type,
    content: input.content,
    hash,
    width: input.width ?? null,
    height: input.height ?? null,
    size: input.size ?? Buffer.byteLength(input.content, 'utf8'),
    pinned: input.pinned ?? false,
    done: input.done ?? false,
    sortOrder: 0,
    sourceApp: input.sourceApp ?? null,
    originDevice: input.originDevice ?? '',
    createdAt: now,
    updatedAt: now,
    deleted: false
  }

  db.prepare(
    `INSERT INTO items
       (id, collection_id, type, content, hash, width, height, size, pinned, done,
        sort_order, source_app, origin_device, created_at, updated_at, deleted)
     VALUES
       (@id, @collectionId, @type, @content, @hash, @width, @height, @size, @pinned, @done,
        @sortOrder, @sourceApp, @originDevice, @createdAt, @updatedAt, 0)`
  ).run({
    ...item,
    pinned: item.pinned ? 1 : 0,
    done: item.done ? 1 : 0
  })

  return item
}

export function updateItem(db: Database, id: string, patch: ItemPatch): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, updatedAt: Date.now() }

  if (patch.content !== undefined) {
    sets.push('content = @content', 'hash = @hash')
    params.content = patch.content
    params.hash = sha256(patch.content)
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = @pinned')
    params.pinned = patch.pinned ? 1 : 0
  }
  if (patch.done !== undefined) {
    sets.push('done = @done')
    params.done = patch.done ? 1 : 0
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = @sortOrder')
    params.sortOrder = patch.sortOrder
  }
  if (patch.collectionId !== undefined) {
    sets.push('collection_id = @collectionId')
    params.collectionId = patch.collectionId
  }
  if (sets.length === 0) return

  sets.push('updated_at = @updatedAt')
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

/**
 * 把条目移动到另一个分类（"移至…""收藏"走这里）。
 * 直接改归属：从原分类移除、落到目标分类，内容/置顶/收藏等标记都保留。
 * 目标不会是剪贴板分类（渲染端的下拉已排除），避免和自动淘汰逻辑打架。
 */
export function moveItemTo(db: Database, itemId: string, targetId: string): void {
  const source = getItem(db, itemId)
  if (!source || source.deleted) return
  db.prepare(
    `UPDATE items SET collection_id = ?, sort_order = 0, updated_at = ? WHERE id = ? AND deleted = 0`
  ).run(targetId, Date.now(), itemId)
}

/**
 * 用户主动删除：打墓碑而不是物理删除，删除动作才能同步到手机端。
 * 返回不再被引用的图片文件名，由调用方删磁盘文件。
 */
export function deleteItems(db: Database, ids: string[]): string[] {
  if (ids.length === 0) return []
  const now = Date.now()

  return db.transaction(() => {
    const images = collectImageNames(db, ids)
    const stmt = db.prepare(`UPDATE items SET deleted = 1, updated_at = ? WHERE id = ?`)
    for (const id of ids) stmt.run(now, id)
    return filterOrphanImages(db, images)
  })()
}

/**
 * 按分类上限滚动淘汰。这是"过期"不是"删除"——
 * 用物理删除且不留墓碑，这样电脑上淘汰旧记录不会把手机上同步过去的那条也删掉。
 * 置顶条目不参与淘汰。
 */
export function trimCollection(db: Database, collectionId: string): string[] {
  const collection = getCollection(db, collectionId)
  if (!collection || collection.maxItems <= 0) return []

  return db.transaction(() => {
    const victims = db
      .prepare<[string, number], { id: string }>(
        `SELECT id FROM items
          WHERE collection_id = ? AND deleted = 0 AND pinned = 0
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?`
      )
      .all(collectionId, collection.maxItems)
      .map((r) => r.id)

    if (victims.length === 0) return []

    const images = collectImageNames(db, victims)
    const stmt = db.prepare(`DELETE FROM items WHERE id = ?`)
    for (const id of victims) stmt.run(id)
    return filterOrphanImages(db, images)
  })()
}

/** 清理超过保留期的墓碑，避免数据库无限膨胀 */
export function purgeTombstones(db: Database, retainDays = 30): string[] {
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000

  return db.transaction(() => {
    const victims = db
      .prepare<[number], { id: string }>(
        `SELECT id FROM items WHERE deleted = 1 AND updated_at < ?`
      )
      .all(cutoff)
      .map((r) => r.id)

    if (victims.length === 0) return []

    const images = collectImageNames(db, victims)
    const stmt = db.prepare(`DELETE FROM items WHERE id = ?`)
    for (const id of victims) stmt.run(id)
    db.prepare(`DELETE FROM collections WHERE deleted = 1 AND updated_at < ?`).run(cutoff)
    return filterOrphanImages(db, images)
  })()
}

function collectImageNames(db: Database, ids: string[]): string[] {
  const stmt = db.prepare<[string], { content: string }>(
    `SELECT content FROM items WHERE id = ? AND type = 'image'`
  )
  const names = new Set<string>()
  for (const id of ids) {
    const row = stmt.get(id)
    if (row) names.add(row.content)
  }
  return [...names]
}

/** 过滤出确实没有任何存活条目再引用的图片文件 */
function filterOrphanImages(db: Database, names: string[]): string[] {
  if (names.length === 0) return []
  const stmt = db.prepare<[string], { n: number }>(
    `SELECT COUNT(*) AS n FROM items WHERE type = 'image' AND content = ? AND deleted = 0`
  )
  return names.filter((name) => (stmt.get(name)?.n ?? 0) === 0)
}
