import type { Database } from 'better-sqlite3'
import type { SyncCollection, SyncItem } from '@shared/sync'
import { MAX_IMAGE_BYTES } from '@shared/sync'
import type { CollectionRow, ItemRow } from './rows'
import { toCollection, toItem } from './rows'

/**
 * 增量同步的读写两端。
 *
 * 冲突解决用 LWW（后写覆盖）：比 updated_at，大的胜；
 * 完全相同时比 id 的字符串序——这条规则保证两台设备各自独立计算也能得到同一结果，
 * 不会出现"我覆盖你、你覆盖我"的来回震荡。
 */

/** 图片文件的读写口子，抽出来是为了让同步逻辑可以脱离文件系统测试 */
export interface ImageSink {
  has(fileName: string): boolean
  read(fileName: string): Buffer | null
  save(hash: string, png: Buffer): string
}

export interface ChangeSet {
  collections: SyncCollection[]
  items: SyncItem[]
}

function toSyncCollection(row: CollectionRow): SyncCollection {
  const c = toCollection(row)
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    syncMode: c.syncMode,
    updatedAt: c.updatedAt,
    deleted: c.deleted
  }
}

function toSyncItem(row: ItemRow): SyncItem {
  const i = toItem(row)
  return {
    id: i.id,
    collectionId: i.collectionId,
    type: i.type,
    content: i.content,
    hash: i.hash,
    width: i.width,
    height: i.height,
    size: i.size,
    pinned: i.pinned,
    done: i.done,
    sourceApp: i.sourceApp,
    originDevice: i.originDevice,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    deleted: i.deleted
  }
}

/**
 * 取出自 since 之后、所有 sync_mode='auto' 分类的变更。
 * 手动推送不走这里——那条路径由用户勾选具体条目。
 */
export function collectAutoChanges(db: Database, since: number): ChangeSet {
  const collections = db
    .prepare<[number], CollectionRow>(
      `SELECT * FROM collections WHERE sync_mode = 'auto' AND updated_at > ?`
    )
    .all(since)
    .map(toSyncCollection)

  const items = db
    .prepare<[number], ItemRow>(
      `SELECT i.* FROM items i
         JOIN collections c ON c.id = i.collection_id
        WHERE c.sync_mode = 'auto' AND i.updated_at > ?
        ORDER BY i.updated_at ASC`
    )
    .all(since)
    .map(toSyncItem)

  // 条目所属的分类必须一并带上，否则对端建不出分类。
  // 上面按 updated_at 过滤会漏掉"分类没变但条目变了"的情况，这里补齐。
  const known = new Set(collections.map((c) => c.id))
  const missing = [...new Set(items.map((i) => i.collectionId))].filter((id) => !known.has(id))
  if (missing.length > 0) {
    const stmt = db.prepare<[string], CollectionRow>(`SELECT * FROM collections WHERE id = ?`)
    for (const id of missing) {
      const row = stmt.get(id)
      if (row) collections.push(toSyncCollection(row))
    }
  }

  return { collections, items }
}

/** 手动推送：把指定的条目连同它们所属的分类打包 */
export function collectItemsForPush(db: Database, itemIds: string[]): ChangeSet {
  if (itemIds.length === 0) return { collections: [], items: [] }

  const itemStmt = db.prepare<[string], ItemRow>(`SELECT * FROM items WHERE id = ? AND deleted = 0`)
  const items: SyncItem[] = []
  for (const id of itemIds) {
    const row = itemStmt.get(id)
    if (row) items.push(toSyncItem(row))
  }

  const collectionStmt = db.prepare<[string], CollectionRow>(`SELECT * FROM collections WHERE id = ?`)
  const collections: SyncCollection[] = []
  for (const id of new Set(items.map((i) => i.collectionId))) {
    const row = collectionStmt.get(id)
    if (row) collections.push(toSyncCollection(row))
  }

  return { collections, items }
}

/** 给待发送的图片条目附上 PNG 字节。太大的图片跳过，只发文字信息。 */
export function attachImages(changes: ChangeSet, images: ImageSink): ChangeSet {
  return {
    collections: changes.collections,
    items: changes.items.map((item) => {
      if (item.type !== 'image' || item.deleted) return item
      const png = images.read(item.content)
      if (!png || png.byteLength > MAX_IMAGE_BYTES) return item
      return { ...item, image: png.toString('base64') }
    })
  }
}

export interface ApplyResult {
  /** 实际写入（新增或覆盖）的条目数 */
  accepted: number
  /** 因为本地缺 PNG 文件而需要对端补发的图片条目 hash */
  needImages: string[]
}

/**
 * 应用对端推来的变更。
 * 分类必须先于条目写入，否则外键约束会拒绝。
 */
export function applyChanges(db: Database, changes: ChangeSet, images: ImageSink): ApplyResult {
  return db.transaction(() => {
    for (const remote of changes.collections) applyCollection(db, remote)

    let accepted = 0
    const needImages: string[] = []
    for (const remote of changes.items) {
      const outcome = applyItem(db, remote, images)
      if (outcome.written) accepted += 1
      if (outcome.needImage) needImages.push(remote.hash)
    }
    return { accepted, needImages: [...new Set(needImages)] }
  })()
}

function applyCollection(db: Database, remote: SyncCollection): void {
  const local = db
    .prepare<[string], CollectionRow>(`SELECT * FROM collections WHERE id = ?`)
    .get(remote.id)

  if (local && !shouldOverwrite(local.updated_at, local.id, remote.updatedAt, remote.id)) return

  if (!local) {
    // 对端的分类在本地不存在：建一个同 id 同名的。
    // sync_mode 沿用对端设置，这样"自动同步"这个属性本身也是同步的。
    // 排到最后，不打乱用户已有的菜单顺序。
    const nextOrder =
      (db.prepare<[], { v: number | null }>(`SELECT MAX(sort_order) AS v FROM collections`).get()
        ?.v ?? -1) + 1
    db.prepare(
      `INSERT INTO collections
         (id, name, kind, sort_order, max_items, sync_mode, builtin, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`
    ).run(
      remote.id,
      remote.name,
      remote.kind,
      nextOrder,
      remote.syncMode,
      remote.updatedAt,
      remote.updatedAt,
      remote.deleted ? 1 : 0
    )
    return
  }

  // 已存在则只更新可同步的字段。max_items 和 sort_order 是本机偏好，不跨设备覆盖。
  db.prepare(
    `UPDATE collections SET name = ?, sync_mode = ?, updated_at = ?, deleted = ? WHERE id = ?`
  ).run(remote.name, remote.syncMode, remote.updatedAt, remote.deleted ? 1 : 0, remote.id)
}

function applyItem(
  db: Database,
  remote: SyncItem,
  images: ImageSink
): { written: boolean; needImage: boolean } {
  // 分类不存在说明对端没把分类信息带过来，丢弃这条，等下次全量
  const collectionExists = db
    .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM collections WHERE id = ?`)
    .get(remote.collectionId)!.n
  if (collectionExists === 0) return { written: false, needImage: false }

  const local = db.prepare<[string], ItemRow>(`SELECT * FROM items WHERE id = ?`).get(remote.id)
  if (local && !shouldOverwrite(local.updated_at, local.id, remote.updatedAt, remote.id)) {
    return { written: false, needImage: false }
  }

  let content = remote.content
  let needImage = false

  if (remote.type === 'image' && !remote.deleted) {
    if (remote.image) {
      const png = Buffer.from(remote.image, 'base64')
      // 文件名由本地按 hash 重新生成，不信任对端给的路径
      content = images.save(remote.hash, png)
    } else {
      content = `${remote.hash}.png`
      needImage = !images.has(content)
    }
  }

  const params = {
    id: remote.id,
    collectionId: remote.collectionId,
    type: remote.type,
    content,
    hash: remote.hash,
    width: remote.width,
    height: remote.height,
    size: remote.size,
    pinned: remote.pinned ? 1 : 0,
    done: remote.done ? 1 : 0,
    sourceApp: remote.sourceApp,
    originDevice: remote.originDevice,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    deleted: remote.deleted ? 1 : 0
  }

  db.prepare(
    `INSERT INTO items
       (id, collection_id, type, content, hash, width, height, size, pinned, done,
        sort_order, source_app, origin_device, created_at, updated_at, deleted)
     VALUES
       (@id, @collectionId, @type, @content, @hash, @width, @height, @size, @pinned, @done,
        0, @sourceApp, @originDevice, @createdAt, @updatedAt, @deleted)
     ON CONFLICT(id) DO UPDATE SET
       collection_id = excluded.collection_id,
       content       = excluded.content,
       hash          = excluded.hash,
       width         = excluded.width,
       height        = excluded.height,
       size          = excluded.size,
       pinned        = excluded.pinned,
       done          = excluded.done,
       updated_at    = excluded.updated_at,
       deleted       = excluded.deleted`
  ).run(params)

  return { written: true, needImage }
}

/**
 * LWW 判定。时间戳相同时用 id 字符串序打破平局——
 * 两端各自独立算也会得到一致结论，不会来回覆盖。
 */
function shouldOverwrite(
  localUpdatedAt: number,
  localId: string,
  remoteUpdatedAt: number,
  remoteId: string
): boolean {
  if (remoteUpdatedAt !== localUpdatedAt) return remoteUpdatedAt > localUpdatedAt
  return remoteId > localId
}
