import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ImageSink } from './db'

/**
 * 图片按内容 hash 命名存放，天然去重：
 * 同一张图复制两次只有一个文件，多个条目共享它。
 * 删除时必须先确认没有别的存活条目引用（见 items.ts 的孤儿判定）。
 */
export class ImageStore implements ImageSink {
  private readonly dir: string

  constructor(userDataPath: string) {
    this.dir = join(userDataPath, 'images')
    mkdirSync(this.dir, { recursive: true })
  }

  get directory(): string {
    return this.dir
  }

  /** 落盘并返回文件名（存进 items.content 的值） */
  save(hash: string, png: Buffer): string {
    const fileName = `${hash}.png`
    const fullPath = join(this.dir, fileName)
    if (!existsSync(fullPath)) writeFileSync(fullPath, png)
    return fileName
  }

  pathOf(fileName: string): string {
    return join(this.dir, fileName)
  }

  has(fileName: string): boolean {
    return existsSync(join(this.dir, fileName))
  }

  read(fileName: string): Buffer | null {
    try {
      return readFileSync(join(this.dir, fileName))
    } catch {
      return null
    }
  }

  remove(fileNames: string[]): void {
    for (const name of fileNames) {
      try {
        unlinkSync(join(this.dir, name))
      } catch {
        // 文件可能已经不在了，不是问题
      }
    }
  }
}
