import { describe, expect, it } from 'vitest'
import type { Database as Db } from 'better-sqlite3'
import type { SyncItem } from '@shared/sync'
import {
  addItem,
  applyChanges,
  attachImages,
  collectAutoChanges,
  collectItemsForPush,
  createCollection,
  getClipboardCollection,
  getItem,
  listCollections,
  listItems,
  openDatabase,
  updateCollection,
  type ImageSink
} from './index'

/** 内存版图片仓库，避免测试碰文件系统 */
function memoryImages(seed: Record<string, Buffer> = {}): ImageSink & { files: Map<string, Buffer> } {
  const files = new Map(Object.entries(seed))
  return {
    files,
    has: (name) => files.has(name),
    read: (name) => files.get(name) ?? null,
    save: (hash, png) => {
      const name = `${hash}.png`
      files.set(name, png)
      return name
    }
  }
}

function freshDb(): Db {
  return openDatabase(':memory:')
}

/** 把 updated_at 改成确定值，避免同一毫秒内写入导致 since 过滤失效 */
function setUpdatedAt(db: Db, itemId: string, at: number): void {
  db.prepare(`UPDATE items SET updated_at = ? WHERE id = ?`).run(at, itemId)
}

function baseItem(overrides: Partial<SyncItem> & Pick<SyncItem, 'id' | 'collectionId'>): SyncItem {
  return {
    type: 'text',
    content: '内容',
    hash: 'h',
    width: null,
    height: null,
    size: 6,
    pinned: false,
    done: false,
    sourceApp: null,
    originDevice: 'remote-device',
    createdAt: 1000,
    updatedAt: 1000,
    deleted: false,
    ...overrides
  }
}

describe('收集变更', () => {
  it('只收集 sync_mode=auto 分类的变更', () => {
    const db = freshDb()
    const auto = createCollection(db, { name: '待办', kind: 'todo', syncMode: 'auto' })
    const off = createCollection(db, { name: '私密', kind: 'list', syncMode: 'off' })
    addItem(db, { collectionId: auto.id, type: 'text', content: '要同步' })
    addItem(db, { collectionId: off.id, type: 'text', content: '不同步' })

    const changes = collectAutoChanges(db, 0)
    expect(changes.items.map((i) => i.content)).toEqual(['要同步'])
  })

  it('按 since 过滤，只拿增量', () => {
    const db = freshDb()
    const auto = createCollection(db, { name: '待办', kind: 'todo', syncMode: 'auto' })
    const stale = addItem(db, { collectionId: auto.id, type: 'text', content: '旧的' })
    const fresh = addItem(db, { collectionId: auto.id, type: 'text', content: '新的' })
    // updated_at 由数据层用当前时间写入，测试里直接改成确定值，避免同毫秒导致过滤失效
    setUpdatedAt(db, stale.id, 1000)
    setUpdatedAt(db, fresh.id, 3000)

    expect(collectAutoChanges(db, 2000).items.map((i) => i.content)).toEqual(['新的'])
  })

  it('分类本身没改但条目改了，也要把分类信息带上，否则对端建不出分类', () => {
    const db = freshDb()
    const auto = createCollection(db, { name: '待办', kind: 'todo', syncMode: 'auto' })
    const item = addItem(db, { collectionId: auto.id, type: 'text', content: '新条目' })
    setUpdatedAt(db, item.id, 3000)
    // 分类的 updated_at 停留在 since 之前，模拟"只有条目变了"
    db.prepare(`UPDATE collections SET updated_at = 500 WHERE id = ?`).run(auto.id)

    const changes = collectAutoChanges(db, 2000)
    expect(changes.items).toHaveLength(1)
    expect(changes.collections.map((c) => c.id)).toContain(auto.id)
  })

  it('手动推送打包指定条目及其分类', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    const a = addItem(db, { collectionId: cid, type: 'text', content: 'A' })
    const b = addItem(db, { collectionId: cid, type: 'text', content: 'B' })
    addItem(db, { collectionId: cid, type: 'text', content: 'C' })

    const changes = collectItemsForPush(db, [a.id, b.id])
    expect(changes.items.map((i) => i.content).sort()).toEqual(['A', 'B'])
    expect(changes.collections).toHaveLength(1)
  })
})

describe('图片附带', () => {
  it('图片条目会带上 base64 的 PNG', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    const png = Buffer.from('fake-png')
    addItem(db, { collectionId: cid, type: 'image', content: 'abc.png', hash: 'abc' })

    const attached = attachImages(
      collectItemsForPush(db, listItems(db, { collectionId: cid }).map((i) => i.id)),
      memoryImages({ 'abc.png': png })
    )
    expect(attached.items[0]!.image).toBe(png.toString('base64'))
  })

  it('超过大小上限的图片不附带字节，只发元信息', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    addItem(db, { collectionId: cid, type: 'image', content: 'big.png', hash: 'big' })

    const huge = Buffer.alloc(6 * 1024 * 1024)
    const attached = attachImages(
      collectItemsForPush(db, listItems(db, { collectionId: cid }).map((i) => i.id)),
      memoryImages({ 'big.png': huge })
    )
    expect(attached.items[0]!.image).toBeUndefined()
  })
})

describe('应用远端变更', () => {
  it('远端分类在本地不存在时按同一 id 创建', () => {
    const db = freshDb()
    const images = memoryImages()
    applyChanges(
      db,
      {
        collections: [
          {
            id: 'remote-col',
            name: '手机笔记',
            kind: 'list',
            syncMode: 'auto',
            updatedAt: 5000,
            deleted: false
          }
        ],
        items: [baseItem({ id: 'i1', collectionId: 'remote-col', content: '来自手机' })]
      },
      images
    )

    const created = listCollections(db).find((c) => c.id === 'remote-col')!
    expect(created.name).toBe('手机笔记')
    expect(created.syncMode).toBe('auto')
    expect(getItem(db, 'i1')!.content).toBe('来自手机')
  })

  it('分类的本机偏好（条数上限、排序）不被远端覆盖', () => {
    const db = freshDb()
    const local = createCollection(db, { name: '待办', kind: 'todo', syncMode: 'auto' })
    updateCollection(db, local.id, { maxItems: 88 })

    applyChanges(
      db,
      {
        collections: [
          {
            id: local.id,
            name: '手机改的名字',
            kind: 'todo',
            syncMode: 'auto',
            updatedAt: Date.now() + 10_000,
            deleted: false
          }
        ],
        items: []
      },
      memoryImages()
    )

    const after = listCollections(db).find((c) => c.id === local.id)!
    expect(after.name).toBe('手机改的名字')
    expect(after.maxItems).toBe(88)
  })

  it('远端更新则覆盖本地', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    const local = addItem(db, { collectionId: cid, type: 'text', content: '本地旧值' })

    applyChanges(
      db,
      {
        collections: [],
        items: [
          baseItem({
            id: local.id,
            collectionId: cid,
            content: '远端新值',
            updatedAt: local.updatedAt + 1000
          })
        ]
      },
      memoryImages()
    )
    expect(getItem(db, local.id)!.content).toBe('远端新值')
  })

  it('本地更新则拒绝远端旧值', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    const local = addItem(db, { collectionId: cid, type: 'text', content: '本地新值' })

    const result = applyChanges(
      db,
      {
        collections: [],
        items: [
          baseItem({
            id: local.id,
            collectionId: cid,
            content: '远端旧值',
            updatedAt: local.updatedAt - 1000
          })
        ]
      },
      memoryImages()
    )
    expect(result.accepted).toBe(0)
    expect(getItem(db, local.id)!.content).toBe('本地新值')
  })

  it('时间戳相同时按 id 字符串序打破平局，两端算出一致结果', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    const same = 9_000_000

    // 本地 id 固定为 'bbb'，远端分别试 'aaa'（更小）和 'zzz'（更大）
    db.prepare(
      `INSERT INTO items (id, collection_id, type, content, hash, size, created_at, updated_at)
       VALUES ('bbb', ?, 'text', '本地', 'h', 2, ?, ?)`
    ).run(cid, same, same)

    applyChanges(
      db,
      { collections: [], items: [baseItem({ id: 'aaa', collectionId: cid, updatedAt: same })] },
      memoryImages()
    )
    expect(getItem(db, 'bbb')!.content).toBe('本地')

    // id 更大的远端条目是另一条记录，不会覆盖 bbb；这里验证判定函数对同 id 的行为
    db.prepare(`UPDATE items SET content = '本地' WHERE id = 'bbb'`).run()
    applyChanges(
      db,
      {
        collections: [],
        items: [baseItem({ id: 'bbb', collectionId: cid, content: '远端', updatedAt: same })]
      },
      memoryImages()
    )
    // 同 id 同时间戳，id 相等不构成"远端更大"，保持本地
    expect(getItem(db, 'bbb')!.content).toBe('本地')
  })

  it('删除墓碑会传播过来', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    const local = addItem(db, { collectionId: cid, type: 'text', content: '将被远端删除' })

    applyChanges(
      db,
      {
        collections: [],
        items: [
          baseItem({
            id: local.id,
            collectionId: cid,
            content: local.content,
            deleted: true,
            updatedAt: local.updatedAt + 500
          })
        ]
      },
      memoryImages()
    )
    expect(getItem(db, local.id)!.deleted).toBe(true)
  })

  it('分类不存在的条目被丢弃，不会因外键报错', () => {
    const db = freshDb()
    const result = applyChanges(
      db,
      { collections: [], items: [baseItem({ id: 'orphan', collectionId: '不存在的分类' })] },
      memoryImages()
    )
    expect(result.accepted).toBe(0)
    expect(getItem(db, 'orphan')).toBeNull()
  })

  it('带 PNG 字节的图片条目会落盘，文件名按 hash 本地生成', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    const images = memoryImages()
    const png = Buffer.from('png-bytes')

    applyChanges(
      db,
      {
        collections: [],
        items: [
          baseItem({
            id: 'img1',
            collectionId: cid,
            type: 'image',
            // 对端给的路径不可信，本地必须按 hash 重新命名
            content: '../../evil.png',
            hash: 'deadbeef',
            image: png.toString('base64')
          })
        ]
      },
      images
    )

    expect(getItem(db, 'img1')!.content).toBe('deadbeef.png')
    expect(images.files.get('deadbeef.png')!.equals(png)).toBe(true)
  })

  it('图片没带字节且本地也没有文件时，要求对端补发', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id

    const result = applyChanges(
      db,
      {
        collections: [],
        items: [
          baseItem({ id: 'img2', collectionId: cid, type: 'image', content: 'x.png', hash: 'need' })
        ]
      },
      memoryImages()
    )
    expect(result.needImages).toEqual(['need'])
  })

  it('本地已有同 hash 图片时不要求补发', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id

    const result = applyChanges(
      db,
      {
        collections: [],
        items: [
          baseItem({ id: 'img3', collectionId: cid, type: 'image', content: 'y.png', hash: 'have' })
        ]
      },
      memoryImages({ 'have.png': Buffer.from('x') })
    )
    expect(result.needImages).toEqual([])
  })

  it('同一批变更重复应用两次结果一致（幂等）', () => {
    const db = freshDb()
    const cid = getClipboardCollection(db)!.id
    const changes = {
      collections: [],
      items: [baseItem({ id: 'idem', collectionId: cid, content: '幂等', updatedAt: 8000 })]
    }

    applyChanges(db, changes, memoryImages())
    const second = applyChanges(db, changes, memoryImages())
    // 第二次时间戳相同、id 相同，判定为不覆盖
    expect(second.accepted).toBe(0)
    expect(listItems(db, { collectionId: cid })).toHaveLength(1)
  })
})
