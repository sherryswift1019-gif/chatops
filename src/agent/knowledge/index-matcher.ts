import type { KnowledgeEntry, IndexFile, SearchResult } from './types.js'
import { readIndexFile, readKnowledgeFile } from './repository.js'

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s,;，；、\-_./]+/).filter(t => t.length > 0)
}

function matchesVersion(entryVersions: string, targetVersion: string): boolean {
  if (!entryVersions || entryVersions === '*') return true
  if (!targetVersion) return true

  // 简单的版本匹配：>=X.Y 格式
  const match = entryVersions.match(/^>=(\d+(?:\.\d+)?)/)
  if (match) {
    const minVersion = parseFloat(match[1])
    const target = parseFloat(targetVersion.replace(/^v/, ''))
    return !isNaN(target) && target >= minVersion
  }

  return entryVersions.includes(targetVersion)
}

function scoreEntry(entry: KnowledgeEntry, keywords: string[], errorCodes: string[], modules: string[], version: string): number {
  let score = 0

  // 错误码精确匹配（权重最高）
  for (const code of errorCodes) {
    if (entry.errorCodes.some(ec => ec.toLowerCase() === code.toLowerCase())) {
      score += 10
    }
  }

  // 模块匹配
  for (const mod of modules) {
    if (entry.modules.some(em => em.toLowerCase() === mod.toLowerCase())) {
      score += 5
    }
  }

  // 关键词匹配
  const entryKeywords = entry.keywords.map(k => k.toLowerCase())
  for (const kw of keywords) {
    if (entryKeywords.includes(kw)) {
      score += 2
    }
  }

  // 版本匹配（不匹配则扣分）
  if (!matchesVersion(entry.versions, version)) {
    score -= 3
  }

  return score
}

export function search(
  product: string,
  query: { keywords?: string[]; errorCodes?: string[]; modules?: string[]; version?: string }
): SearchResult[] {
  const rawIndex = readIndexFile(product)
  if (!rawIndex) return []

  let indexFile: IndexFile
  try {
    indexFile = JSON.parse(rawIndex)
  } catch {
    console.error(`[Knowledge] failed to parse index.json for ${product}`)
    return []
  }

  const keywords = query.keywords ?? []
  const errorCodes = query.errorCodes ?? []
  const modules = query.modules ?? []
  const version = query.version ?? ''

  const results: SearchResult[] = []

  for (const entry of indexFile.entries) {
    const score = scoreEntry(entry, keywords, errorCodes, modules, version)
    if (score > 0) {
      const content = readKnowledgeFile(product, entry.file) ?? ''
      results.push({ entry, score, content })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, 5) // top 5
}

export function extractQueryFromText(text: string): { keywords: string[]; errorCodes: string[] } {
  const errorCodePattern = /[A-Z_]{2,}[\-_]?\d{3,}/g
  const errorCodes = text.match(errorCodePattern) ?? []

  const keywords = tokenize(text).filter(t => t.length >= 2 && !/^\d+$/.test(t))

  return { keywords: keywords.slice(0, 20), errorCodes }
}
