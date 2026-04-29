import { describe, it, expect } from 'vitest'
import { isAbsolute, sep } from 'path'
import { resolveDataDir } from '../../pipeline/data-dir.js'

describe('resolveDataDir', () => {
  it('回落到 <cwd>/var/test-runs 当 env 未设', () => {
    const result = resolveDataDir({})
    expect(isAbsolute(result)).toBe(true)
    expect(result.endsWith(`${sep}var${sep}test-runs`)).toBe(true)
    expect(result.startsWith(process.cwd())).toBe(true)
  })

  it('使用 env 值当 TEST_DATA_DIR 已设', () => {
    expect(resolveDataDir({ TEST_DATA_DIR: '/tmp/foo' })).toBe('/tmp/foo')
  })

  it('回落到默认当 env 是空白字符串', () => {
    const result = resolveDataDir({ TEST_DATA_DIR: '   ' })
    expect(result.endsWith(`${sep}var${sep}test-runs`)).toBe(true)
  })
})
