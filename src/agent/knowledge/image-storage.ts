import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'

const IMAGE_BASE = process.env.KNOWLEDGE_IMAGE_DIR ?? '/opt/knowledge/images'

export interface ImageStorageResult {
  relativePath: string
  absolutePath: string
}

export function saveImage(product: string, filename: string, data: Buffer): ImageStorageResult {
  const dir = join(IMAGE_BASE, product)
  mkdirSync(dir, { recursive: true })

  const absPath = join(dir, filename)
  writeFileSync(absPath, data)

  const relativePath = `${product}/${filename}`
  console.log(`[Knowledge] image saved: ${relativePath} (${data.length} bytes)`)

  return { relativePath, absolutePath: absPath }
}

export function imageExists(product: string, filename: string): boolean {
  return existsSync(join(IMAGE_BASE, product, filename))
}

export function getImageDir(): string {
  return IMAGE_BASE
}
