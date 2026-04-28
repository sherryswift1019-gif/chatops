import { describe, it, expect } from 'vitest'
import { buildDiagnosePrompt } from '../../agent/repair/diagnose-repair-handler.js'

describe('buildDiagnosePrompt', () => {
  it('包含 failedCommand', () => {
    const p = buildDiagnosePrompt({
      failedCommand: 'PAM_ADDRESS=x ./install.sh',
      stdout: 'starting...',
      stderr: 'error: port in use',
      serverHost: '10.0.0.1',
      maxRetries: 4,
    })
    expect(p).toContain('PAM_ADDRESS=x ./install.sh')
    expect(p).toContain('10.0.0.1')
    expect(p).toContain('port in use')
    expect(p).toContain('4')
  })

  it('maxRetries 默认值为 4', () => {
    const p = buildDiagnosePrompt({
      failedCommand: 'cmd',
      stdout: '',
      stderr: '',
      serverHost: 'host',
    })
    expect(p).toContain('4')
  })
})
