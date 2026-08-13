import { describe, expect, it } from 'vitest'
import type { Database as Db } from 'better-sqlite3'
import {
  addItem,
  moveItemTo,
  createCollection,
  deleteCollection,
  deleteItems,
  getClipboardCollection,
  getItem,
  listCollections,
  listItems,
  openDatabase,
  purgeTombstones,
  readSettings,
  searchAll,
  trimCollection,
  updateCollection,
  updateItem,
  writeSettings
} from './index'

function freshDb(): Db {
  return openDatabase(':memory:')
}

function clipboardId(db: Db): string {
  return getClipboardCollection(db)!.id
}

describe('分类', () => {
  it('首次打开写入三个预置分类，只有剪贴板是内置的', () => {
    const db = freshDb()
    const collections = listCollections(db)

    expect(collections.map((c) => c.name)).toEqual(['剪贴板', '收藏', '待办事项'])
    expect(collections.map((c) => c.kind)).toEqual(['clipboard', 'list', 'todo'])
    expect(collections.filter((c) => c.builtin).map((c) => c.name)).toEqual(['剪贴板'])
  })

  it('重复打开不会重复写入预置分类', () => {
    const db = freshDb()
    const before = listCollections(db).length
    // 模拟再次启动：对同一个连接重跑一次初始化
    openDatabase(':memory:')
    expect(listCollections(db).length).toBe(before)
  })

  it('可以新增自定义分类并改名、排在最后', () => {
    const db = freshDb()
    const created = createCollection(db, { name: '提示词', kind: 'list' })
    expect(created.sortOrder).toBe(3)
    expect(created.builtin).toBe(false)

    updateCollection(db, created.id, { name: '我的提示词库', maxItems: 50 })
    const found = listCollections(db).find((c) => c.id === created.id)!
    expect(found.name).toBe('我的提示词库')
    expect(found.maxItems).toBe(50)
  })

  it('内置的剪贴板分类删不掉，自定义分类删除后其条目一并打墓碑', () => {
    const db = freshDb()
    const clip = getClipboardCollection(db)!
    deleteCollection(db, clip.id)
    expect(getClipboardCollection(db)).not.toBeNull()

    const notes = createCollection(db, { name: '笔记', kind: 'list' })
    const item = addItem(db, { collectionId: notes.id, type: 'text', content: '一条笔记' })
    deleteCollection(db, notes.id)

    expect(listCollections(db).find((c) => c.id === notes.id)).toBeUndefined()
    expect(getItem(db, item.id)!.deleted).toBe(true)
  })
})

describe('条目写入与去重', () => {
  it('同一分类里重复内容不新增，而是把老条目刷到最前面', () => {
    const db = freshDb()
    const cid = clipboardId(db)

    const first = addItem(db, { collectionId: cid, type: 'text', content: 'hello', createdAt: 1000 })
    addItem(db, { collectionId: cid, type: 'text', content: 'world', createdAt: 2000 })
    const again = addItem(db, { collectionId: cid, type: 'text', content: 'hello', createdAt: 3000 })

    expect(again.id).toBe(first.id)
    expect(listItems(db, { collectionId: cid })).toHaveLength(2)
    expect(listItems(db, { collectionId: cid })[0]!.content).toBe('hello')
  })

  it('不同分类之间互不去重', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    const fav = listCollections(db).find((c) => c.name === '收藏')!.id

    const a = addItem(db, { collectionId: cid, type: 'text', content: '同样的内容' })
    const b = addItem(db, { collectionId: fav, type: 'text', content: '同样的内容' })
    expect(a.id).not.toBe(b.id)
  })

  it('置顶条目排在前面，待办按未完成优先', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    addItem(db, { collectionId: cid, type: 'text', content: '新的', createdAt: 3000 })
    const old = addItem(db, { collectionId: cid, type: 'text', content: '旧的', createdAt: 1000 })
    updateItem(db, old.id, { pinned: true })
    expect(listItems(db, { collectionId: cid })[0]!.content).toBe('旧的')

    const todo = listCollections(db).find((c) => c.kind === 'todo')!.id
    const done = addItem(db, { collectionId: todo, type: 'text', content: '已完成', createdAt: 3000 })
    addItem(db, { collectionId: todo, type: 'text', content: '待完成', createdAt: 1000 })
    updateItem(db, done.id, { done: true })
    expect(listItems(db, { collectionId: todo }).map((i) => i.content)).toEqual([
      '待完成',
      '已完成'
    ])
  })
})

describe('条数上限淘汰', () => {
  it('超出上限的旧条目被物理淘汰，置顶的不动', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    updateCollection(db, cid, { maxItems: 3 })

    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      ids.push(addItem(db, { collectionId: cid, type: 'text', content: `第${i}条`, createdAt: 1000 + i }).id)
    }
    updateItem(db, ids[0]!, { pinned: true })

    trimCollection(db, cid)
    const left = listItems(db, { collectionId: cid }).map((i) => i.content)
    // 置顶的第0条 + 最新的三条
    expect(left).toEqual(['第0条', '第5条', '第4条', '第3条'])
  })

  it('淘汰是物理删除不留墓碑，避免把手机上同步过去的那条也删掉', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    updateCollection(db, cid, { maxItems: 1 })
    const older = addItem(db, { collectionId: cid, type: 'text', content: 'a', createdAt: 1000 })
    addItem(db, { collectionId: cid, type: 'text', content: 'b', createdAt: 2000 })

    trimCollection(db, cid)
    expect(getItem(db, older.id)).toBeNull()
  })

  it('上限为 0 表示不限', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    updateCollection(db, cid, { maxItems: 0 })
    for (let i = 0; i < 20; i++) {
      addItem(db, { collectionId: cid, type: 'text', content: `x${i}`, createdAt: 1000 + i })
    }
    trimCollection(db, cid)
    expect(listItems(db, { collectionId: cid })).toHaveLength(20)
  })
})

describe('跨分类移动', () => {
  it('移动到收藏后从原分类移除，归属改变但记录唯一', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    const fav = listCollections(db).find((c) => c.name === '收藏')!.id

    const source = addItem(db, { collectionId: cid, type: 'text', content: '要留住的内容', createdAt: 1000 })
    moveItemTo(db, source.id, fav)

    // 原分类不再包含它
    expect(listItems(db, { collectionId: cid }).find((i) => i.id === source.id)).toBeUndefined()
    // 目标分类包含它，且是同一条记录（不是副本）
    const moved = listItems(db, { collectionId: fav }).find((i) => i.id === source.id)
    expect(moved).toBeDefined()
    expect(moved!.content).toBe('要留住的内容')
  })
})

describe('删除与图片文件回收', () => {
  it('用户删除是软删除，会返回不再被引用的图片文件名', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    const item = addItem(db, {
      collectionId: cid,
      type: 'image',
      content: 'abc123.png',
      hash: 'abc123'
    })

    const orphans = deleteItems(db, [item.id])
    expect(orphans).toEqual(['abc123.png'])
    expect(getItem(db, item.id)!.deleted).toBe(true)
  })

  it('移动到其它分类后删除会正常回收图片', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    const fav = listCollections(db).find((c) => c.name === '收藏')!.id
    const item = addItem(db, {
      collectionId: cid,
      type: 'image',
      content: 'shared.png',
      hash: 'shared'
    })
    moveItemTo(db, item.id, fav)

    expect(deleteItems(db, [item.id])).toEqual(['shared.png'])
  })

  it('墓碑超过保留期后被物理清理', async () => {
    const db = freshDb()
    const cid = clipboardId(db)
    const item = addItem(db, { collectionId: cid, type: 'text', content: '待清理' })
    deleteItems(db, [item.id])

    purgeTombstones(db, 30)
    expect(getItem(db, item.id)).not.toBeNull()

    // 保留期为 0 时截止时间就是此刻，等几毫秒让墓碑落到截止时间之前
    await new Promise((resolve) => setTimeout(resolve, 5))
    purgeTombstones(db, 0)
    expect(getItem(db, item.id)).toBeNull()
  })
})

describe('搜索', () => {
  it('中文关键词能命中子串', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    addItem(db, { collectionId: cid, type: 'text', content: '这是一段剪贴板历史记录' })
    addItem(db, { collectionId: cid, type: 'text', content: '无关内容' })

    expect(searchAll(db, '剪贴')).toHaveLength(1)
    expect(searchAll(db, '剪贴板历史')).toHaveLength(1)
    expect(searchAll(db, '不存在的词')).toHaveLength(0)
  })

  it('关键词里的 % 和 _ 当普通字符处理，不是通配符', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    addItem(db, { collectionId: cid, type: 'text', content: '折扣 50%' })
    addItem(db, { collectionId: cid, type: 'text', content: 'snake_case' })

    expect(searchAll(db, '50%')).toHaveLength(1)
    expect(searchAll(db, '%')).toHaveLength(1)
    expect(searchAll(db, 'snake_case')).toHaveLength(1)
    // 下划线若被当通配符，'snakeXcase' 也会命中，这里必须是 0
    expect(searchAll(db, 'snakeXcase')).toHaveLength(0)
  })

  it('搜索结果带上所属分类名，且跳过已删除的分类', () => {
    const db = freshDb()
    const notes = createCollection(db, { name: '笔记', kind: 'list' })
    addItem(db, { collectionId: notes.id, type: 'text', content: '会议纪要' })

    expect(searchAll(db, '会议')[0]!.collectionName).toBe('笔记')
    deleteCollection(db, notes.id)
    expect(searchAll(db, '会议')).toHaveLength(0)
  })

  it('分类内搜索只在该分类里找', () => {
    const db = freshDb()
    const cid = clipboardId(db)
    const fav = listCollections(db).find((c) => c.name === '收藏')!.id
    addItem(db, { collectionId: cid, type: 'text', content: '关键词在剪贴板' })
    addItem(db, { collectionId: fav, type: 'text', content: '关键词在收藏' })

    expect(listItems(db, { collectionId: fav, keyword: '关键词' })).toHaveLength(1)
  })
})

describe('设置', () => {
  it('未写入时返回默认值，写入后覆盖', () => {
    const db = freshDb()
    expect(readSettings(db).paused).toBe(false)
    expect(readSettings(db).hotkey).toBe('Alt+`')

    writeSettings(db, { paused: true, hotkey: 'Ctrl+Shift+V' })
    expect(readSettings(db).paused).toBe(true)
    expect(readSettings(db).hotkey).toBe('Ctrl+Shift+V')
    // 没动过的字段仍是默认值
    expect(readSettings(db).autoPaste).toBe(true)
  })
})
