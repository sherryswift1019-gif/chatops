import { describe, it, expect } from 'vitest'
import { search, extractQueryFromText } from '../../agent/knowledge/index-matcher.js'

// Mock readIndexFile by providing a test product with no actual file system
// These tests focus on the matching logic, not file I/O

describe('extractQueryFromText', () => {
  it('extracts error codes from text', () => {
    const result = extractQueryFromText('用户登录报错 TASK_PWD_4001，请帮忙分析')
    expect(result.errorCodes).toContain('TASK_PWD_4001')
  })

  it('extracts keywords from text', () => {
    const result = extractQueryFromText('postgresql 大小写 验密失败')
    expect(result.keywords).toContain('postgresql')
    expect(result.keywords.some(k => k.includes('大小写'))).toBe(true)
  })

  it('filters out pure numbers', () => {
    const result = extractQueryFromText('错误码 4001 在第 23 行')
    expect(result.keywords).not.toContain('4001')
    expect(result.keywords).not.toContain('23')
  })

  it('handles empty text', () => {
    const result = extractQueryFromText('')
    expect(result.keywords).toHaveLength(0)
    expect(result.errorCodes).toHaveLength(0)
  })
})

describe('search (integration - requires index.json)', () => {
  it('returns empty array for non-existent product', () => {
    const results = search('non-existent-product', { keywords: ['test'] })
    expect(results).toHaveLength(0)
  })
})
