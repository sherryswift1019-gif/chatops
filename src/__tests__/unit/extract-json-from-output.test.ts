import { describe, it, expect } from 'vitest'
import { extractJsonFromOutput } from '../../agent/analysis/claude-runs.js'

describe('extractJsonFromOutput', () => {
  it('提取纯 JSON', () => {
    expect(extractJsonFromOutput('{"a":1}')).toBe('{"a":1}')
  })

  it('提取带前缀的 JSON', () => {
    expect(extractJsonFromOutput('thinking...\n{"a":1}')).toBe('{"a":1}')
  })

  it('嵌套 JSON：抓最外层而非内层（回归：2026-04-20 fix）', () => {
    const input = `{
  "involvedProjects": [
    { "projectPath": "PAM/foo", "isPrimary": true, "sourceBranch": "test" }
  ],
  "primaryProjectPath": "PAM/foo"
}`
    const out = extractJsonFromOutput(input)
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!)
    expect(parsed).toHaveProperty('involvedProjects')
    expect(parsed).toHaveProperty('primaryProjectPath', 'PAM/foo')
    expect(parsed.involvedProjects).toHaveLength(1)
  })

  it('深层嵌套：三层对象抓最外层', () => {
    const input = '{"a":{"b":{"c":1}}}'
    const out = extractJsonFromOutput(input)
    expect(out).toBe('{"a":{"b":{"c":1}}}')
    expect(JSON.parse(out!)).toEqual({ a: { b: { c: 1 } } })
  })

  it('字符串里的 { } 不参与配对', () => {
    const input = '{"text":"hello { nested } world","n":42}'
    const out = extractJsonFromOutput(input)
    expect(JSON.parse(out!)).toEqual({ text: 'hello { nested } world', n: 42 })
  })

  it('无 JSON 返回 null', () => {
    expect(extractJsonFromOutput('no json here')).toBeNull()
  })
})
