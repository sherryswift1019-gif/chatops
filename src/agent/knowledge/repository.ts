import { exec } from 'child_process'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { injectGitlabAuth } from '../../config/git-auth.js'

const execAsync = promisify(exec)

const KNOWLEDGE_CACHE_BASE = process.env.KNOWLEDGE_CACHE_BASE ?? '/var/cache/chatops-knowledge'

function buildCachePath(product: string): string {
  return join(KNOWLEDGE_CACHE_BASE, product)
}

export async function ensureLocalCache(product: string, repoUrl: string): Promise<string> {
  const cachePath = buildCachePath(product)

  if (existsSync(join(cachePath, '.git')) || existsSync(join(cachePath, 'HEAD'))) {
    try {
      await execAsync('git pull --ff-only', { cwd: cachePath, timeout: 60_000 })
    } catch {
      console.warn(`[Knowledge] git pull failed for ${product}, using stale cache`)
    }
    return cachePath
  }

  mkdirSync(cachePath, { recursive: true })
  const authedUrl = await injectGitlabAuth(repoUrl)
  await execAsync(`git clone ${authedUrl} ${cachePath}`, { timeout: 120_000 })
  console.log(`[Knowledge] cloned ${repoUrl} to ${cachePath}`)
  return cachePath
}

export function readKnowledgeFile(product: string, relativePath: string): string | null {
  const cachePath = buildCachePath(product)
  const fullPath = join(cachePath, relativePath)

  if (!fullPath.startsWith(cachePath)) {
    console.error(`[Knowledge] path traversal blocked: ${relativePath}`)
    return null
  }

  if (!existsSync(fullPath)) return null

  try {
    return readFileSync(fullPath, 'utf8')
  } catch {
    return null
  }
}

export function readIndexFile(product: string): string | null {
  return readKnowledgeFile(product, 'index.json')
}
