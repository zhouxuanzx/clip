/**
 * 主进程 / 渲染进程 / 未来的安卓端共用的数据契约。
 * 字段命名与 SQLite 表结构保持一致，避免来回转换。
 */

/** 分类的渲染方式。用户新建左侧菜单时选其中一种。 */
export type CollectionKind =
  /** 剪贴板：自动写入、受条数上限滚动淘汰，不可手动新增 */
  | 'clipboard'
  /** 普通列表：收藏、提示词、笔记、日记都属于这类 */
  | 'list'
  /** 待办：多一个完成状态，可勾选 */
  | 'todo'

/** 分类级同步策略 */
export type SyncMode =
  /** 不参与任何同步 */
  | 'off'
  /** 只能手动勾选条目推送到对端 */
  | 'manual'
  /** 两端自动保持一致（增删改都同步） */
  | 'auto'

export type ItemType = 'text' | 'image'

export interface Collection {
  id: string
  name: string
  kind: CollectionKind
  /** 左侧菜单排序，越小越靠上 */
  sortOrder: number
  /** 条数上限，0 表示不限。目前只对 kind='clipboard' 生效 */
  maxItems: number
  syncMode: SyncMode
  /** 内置分类不可删除（只有剪贴板分类是内置的） */
  builtin: boolean
  createdAt: number
  updatedAt: number
  deleted: boolean
}

export interface Item {
  id: string
  collectionId: string
  type: ItemType
  /** 文本条目为正文；图片条目为 userData/images 下的相对文件名 */
  content: string
  /** 内容指纹，用于去重。文本取正文 sha256，图片取 PNG 字节 sha256 */
  hash: string
  /** 图片宽高，仅图片条目有值 */
  width: number | null
  height: number | null
  /** 字节数，列表里展示用 */
  size: number
  /** 置顶条目不受条数上限淘汰 */
  pinned: boolean
  /** 仅 kind='todo' 的分类使用 */
  done: boolean
  /** 手动排序位，置顶区和 todo 拖动排序用 */
  sortOrder: number
  /** 复制时的前台窗口标题，可为空 */
  sourceApp: string | null
  /** 条目最初产生于哪台设备，同步后仍保留原值 */
  originDevice: string
  createdAt: number
  updatedAt: number
  /** 软删除墓碑。同步需要它来传播删除，物理清理在保留期之后 */
  deleted: boolean
}

/** 新建条目时的入参，其余字段由数据层补齐 */
export interface NewItemInput {
  collectionId: string
  type: ItemType
  content: string
  hash?: string
  width?: number | null
  height?: number | null
  size?: number
  sourceApp?: string | null
  originDevice?: string
  pinned?: boolean
  done?: boolean
  createdAt?: number
}

export interface NewCollectionInput {
  name: string
  kind: CollectionKind
  maxItems?: number
  syncMode?: SyncMode
}

export interface CollectionPatch {
  name?: string
  maxItems?: number
  syncMode?: SyncMode
  sortOrder?: number
}

export interface ItemPatch {
  content?: string
  pinned?: boolean
  done?: boolean
  sortOrder?: number
  collectionId?: string
}

export interface ListItemsQuery {
  collectionId: string
  /** 关键词为空则按时间倒序列出全部 */
  keyword?: string
  limit?: number
  offset?: number
}

/** 全局搜索：跨所有分类 */
export interface SearchQuery {
  keyword: string
  limit?: number
}

export interface SearchHit extends Item {
  collectionName: string
}

/** 应用设置，存在 settings 表里的 key-value */
export interface AppSettings {
  /** 暂停记录剪贴板（复制密码时用） */
  paused: boolean
  /** 唤起主窗口的全局热键 */
  hotkey: string
  /** 开机自启 */
  autoLaunch: boolean
  /** 选中条目后自动粘贴回原窗口 */
  autoPaste: boolean
  /** 本机设备 id，首次启动生成 */
  deviceId: string
  deviceName: string
  /** 启动时自动开启局域网同步服务 */
  syncEnabled: boolean
  /** 手机传来的文件存放目录。空字符串表示用系统下载目录下的 Clip 子目录 */
  downloadDir: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  paused: false,
  hotkey: 'Alt+`',
  autoLaunch: false,
  autoPaste: true,
  deviceId: '',
  deviceName: '',
  syncEnabled: false,
  downloadDir: ''
}

/** 预置的三个分类（首次启动写入） */
export const BUILTIN_COLLECTIONS: NewCollectionInput[] = [
  { name: '剪贴板', kind: 'clipboard', maxItems: 500, syncMode: 'manual' },
  { name: '收藏', kind: 'list', maxItems: 0, syncMode: 'manual' },
  { name: '待办事项', kind: 'todo', maxItems: 0, syncMode: 'manual' }
]
