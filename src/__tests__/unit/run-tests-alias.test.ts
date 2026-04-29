import { describe, it, expect } from 'vitest'
import '../../agent/tools/run-command.js'
import '../../agent/tools/run-tests.js'
import { getTool } from '../../agent/tools/index.js'

describe('run_tests deprecated alias', () => {
  it('both run_tests and run_command are registered with the same execute', () => {
    const cmd = getTool('run_command')
    const legacy = getTool('run_tests')
    expect(cmd).toBeDefined()
    expect(legacy).toBeDefined()
    // 别名复用同一份 execute 引用
    expect(legacy!.execute).toBe(cmd!.execute)
  })

  it('run_tests description marks it deprecated', () => {
    const legacy = getTool('run_tests')!
    expect(legacy.description).toMatch(/deprecated/i)
  })
})
