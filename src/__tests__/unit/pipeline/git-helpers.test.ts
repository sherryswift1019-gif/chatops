import { describe, it, expect } from 'vitest'
import { escapeShell, normalizeProjectPath } from '../../../pipeline/git-helpers.js'

describe('git-helpers', () => {
  describe('escapeShell', () => {
    it('wraps string in single quotes', () => {
      expect(escapeShell('hello')).toBe("'hello'")
    })

    it('escapes single quotes inside string', () => {
      // "a'b" → 'a'\''b'
      expect(escapeShell("a'b")).toBe("'a'\\''b'")
    })

    it('handles empty string', () => {
      expect(escapeShell('')).toBe("''")
    })

    it('handles strings with shell metacharacters safely', () => {
      // 不会被 shell 解释为命令
      expect(escapeShell('foo; rm -rf /')).toBe("'foo; rm -rf /'")
    })
  })

  describe('normalizeProjectPath', () => {
    it('strips https:// URL down to group/repo', () => {
      expect(normalizeProjectPath('https://gitlab.com/group/repo.git')).toBe('group/repo')
    })

    it('handles already-normalized path', () => {
      expect(normalizeProjectPath('group/repo')).toBe('group/repo')
    })

    it('strips .git suffix', () => {
      expect(normalizeProjectPath('group/repo.git')).toBe('group/repo')
    })

    it('strips leading and trailing slashes', () => {
      expect(normalizeProjectPath('/group/repo/')).toBe('group/repo')
    })

    it('handles nested groups', () => {
      expect(normalizeProjectPath('top/sub/repo.git')).toBe('top/sub/repo')
    })
  })
})
