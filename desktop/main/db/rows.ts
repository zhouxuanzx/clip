import type { Collection, Item } from '@shared/types'

/** SQLite 原始行。布尔在库里是 0/1，这里统一转换。 */
export interface CollectionRow {
  id: string
  name: string
  kind: string
  sort_order: number
  max_items: number
  sync_mode: string
  builtin: number
  created_at: number
  updated_at: number
  deleted: number
}

export interface ItemRow {
  id: string
  collection_id: string
  type: string
  content: string
  hash: string
  width: number | null
  height: number | null
  size: number
  pinned: number
  done: number
  sort_order: number
  source_app: string | null
  origin_device: string
  created_at: number
  updated_at: number
  deleted: number
}

export function toCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as Collection['kind'],
    sortOrder: row.sort_order,
    maxItems: row.max_items,
    syncMode: row.sync_mode as Collection['syncMode'],
    builtin: row.builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1
  }
}

export function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    collectionId: row.collection_id,
    type: row.type as Item['type'],
    content: row.content,
    hash: row.hash,
    width: row.width,
    height: row.height,
    size: row.size,
    pinned: row.pinned === 1,
    done: row.done === 1,
    sortOrder: row.sort_order,
    sourceApp: row.source_app,
    originDevice: row.origin_device,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1
  }
}
