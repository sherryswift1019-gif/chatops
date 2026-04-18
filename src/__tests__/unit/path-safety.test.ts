import { describe, it, expect } from 'vitest'

// 测试路径安全逻辑（不依赖真实文件系统，只测逻辑）
import { relative, resolve, isAbsolute } from 'path'

function isPathSafe(cwd: string, filePath: string): boolean {
  const absPath = resolve(cwd, filePath)
  const rel = relative(cwd, absPath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

describe('MCP Tool Path Safety', () => {
  const cwd = '/tmp/analysis/user-pam-dev-abc123'

  it('allows normal relative paths', () => {
    expect(isPathSafe(cwd, 'src/main.java')).toBe(true)
    expect(isPathSafe(cwd, 'docs/ai/module.md')).toBe(true)
    expect(isPathSafe(cwd, 'pom.xml')).toBe(true)
  })

  it('blocks path traversal with ../', () => {
    expect(isPathSafe(cwd, '../../../etc/passwd')).toBe(false)
    expect(isPathSafe(cwd, 'src/../../secret')).toBe(false)
  })

  it('blocks absolute paths', () => {
    expect(isPathSafe(cwd, '/etc/passwd')).toBe(false)
    expect(isPathSafe(cwd, '/root/.ssh/id_rsa')).toBe(false)
  })

  it('blocks sibling directory escape', () => {
    // /tmp/analysis/user-pam-dev-abc123 的兄弟目录
    expect(isPathSafe(cwd, '../user-other/file')).toBe(false)
  })

  it('handles edge case: cwd prefix match attack', () => {
    // 确保 /app 不会匹配 /app-other/
    const shortCwd = '/app'
    expect(isPathSafe(shortCwd, '../app-other/secret')).toBe(false)
  })

  it('allows deeply nested paths within cwd', () => {
    expect(isPathSafe(cwd, 'src/main/java/com/example/Service.java')).toBe(true)
  })
})
