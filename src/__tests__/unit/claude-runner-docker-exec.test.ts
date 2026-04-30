import { describe, it, expect } from 'vitest'
import { buildDockerExecClaudeArgs } from '../../agent/claude-runner.js'

describe('buildDockerExecClaudeArgs', () => {
  it('无 dockerExec → 原样返回', () => {
    const args = buildDockerExecClaudeArgs(['--print', '--model', 'claude-3'], undefined)
    expect(args).toEqual({ bin: 'claude', args: ['--print', '--model', 'claude-3'] })
  })

  it('有 dockerExec → 包 docker exec 前缀', () => {
    const result = buildDockerExecClaudeArgs(['--print', 'hello'], { containerId: 'chatops-sandbox-42' })
    expect(result).toEqual({
      bin: 'docker',
      args: ['exec', '-i', 'chatops-sandbox-42', 'claude', '--print', 'hello'],
    })
  })

  it('有 dockerExec + user → 包含 --user 选项', () => {
    const result = buildDockerExecClaudeArgs(['--print'], { containerId: 'sandbox-1', user: 'node' })
    expect(result).toEqual({
      bin: 'docker',
      args: ['exec', '-i', '--user', 'node', 'sandbox-1', 'claude', '--print'],
    })
  })
})
