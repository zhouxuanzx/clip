import { writeFileSync } from 'node:fs'
import { nativeImage } from 'electron'
import { AlignmentType, Document, ImageRun, Packer, Paragraph, TextRun } from 'docx'
import type { Item } from '@shared/types'
import type { ImageStore } from './images'

/** A4 页面（twips） */
const PAGE = { width: 11906, height: 16838 }
/** 图片最大宽度 15cm（EMU）：等比缩放后不超过页面内容区宽度 */
const MAX_IMAGE_WIDTH_EMU = 15 * 360000
const EMU_PER_PX = 9525

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 把条目序列化成 .docx：
 * 每条 = 灰色时间/来源 meta 行 + 正文段落 + 居中图片（等比缩放、最大宽 15cm），
 * 条目之间空一行分隔。
 */
export async function exportItemsToWord(
  images: ImageStore,
  items: Item[],
  filePath: string
): Promise<void> {
  const maxPx = Math.floor(MAX_IMAGE_WIDTH_EMU / EMU_PER_PX)
  const children: Paragraph[] = []

  for (const item of items) {
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: `${fmtTime(item.createdAt)}${item.sourceApp ? ` · ${item.sourceApp}` : ''}`,
            size: 18,
            color: '888888'
          })
        ]
      })
    )

    if (item.content) {
      for (const line of item.content.split('\n')) {
        children.push(
          line === '' ? new Paragraph({}) : new Paragraph({ children: [new TextRun(line)] })
        )
      }
    }

    for (const name of item.images) {
      const png = images.read(name)
      if (!png) continue
      const { width, height } = nativeImage.createFromBuffer(png).getSize()
      if (width <= 0 || height <= 0) continue
      const scale = Math.min(1, maxPx / width)
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 120 },
          children: [
            new ImageRun({
              type: 'png',
              data: png,
              transformation: {
                width: Math.max(1, Math.round(width * scale)),
                height: Math.max(1, Math.round(height * scale))
              }
            })
          ]
        })
      )
    }

    children.push(new Paragraph({}))
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 21 } } } },
    sections: [
      {
        properties: {
          page: {
            size: PAGE,
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
          }
        },
        children
      }
    ]
  })

  const buffer = await Packer.toBuffer(doc)
  writeFileSync(filePath, buffer)
}
