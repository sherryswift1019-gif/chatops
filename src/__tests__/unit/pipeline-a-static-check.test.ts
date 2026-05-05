import { describe, it, expect } from 'vitest'
import { staticCheckNode } from '../../e2e/pipeline-a/nodes/static-check.js'

const VALID_PLAYBOOK_YAML = `
specPath: docs/test-specs/s.md
specTitle: S
scenarios:
  - id: s.smoke
    name: Smoke
    tags: [smoke]
    acceptance:
      - kind: url_match
        value: /
`

const INVALID_YAML = `
specPath: docs/test-specs/s.md
scenarios:
  - id: bad
    name: B
    acceptance: []
`

const baseState = {
  specs: [
    {
      specId: 1n,
      specPath: 'docs/s.md',
      title: 'S',
      contentHash: 'x',
      targetProjectId: 'chatops',
      scriptPath: 'docs/test-playbooks/s.playbook.yaml',
      generatedContent: VALID_PLAYBOOK_YAML,
    },
  ],
  currentSpecIndex: 0,
  staticCheckAttempts: 0,
  maxStaticCheckAttempts: 2,
  baseBranch: 'main',
  targetProjectId: 'chatops',
  specPaths: [],
  sandboxHandle: null,
  baselineAttempts: 0,
  lastBaselineResult: null,
  completedSpecs: [],
  maxBaselineAttempts: 3,
  lastError: null,
  staticCheckResult: null,
  diagnosisVerdict: null,
}

describe('staticCheckNode (playbook YAML 校验)', () => {
  it('合法 playbook YAML → staticCheckResult=pass，lastError=null', async () => {
    const result = await staticCheckNode(baseState as any)
    expect(result.staticCheckResult).toBe('pass')
    expect(result.lastError).toBeNull()
  })

  it('非法 playbook YAML（acceptance=[] 违反 schema）→ fail + lastError 含 issues', async () => {
    const state = {
      ...baseState,
      specs: [{ ...baseState.specs[0], generatedContent: INVALID_YAML }],
    }
    const result = await staticCheckNode(state as any)
    expect(result.staticCheckResult).toBe('fail')
    expect(result.lastError).toMatch(/schema 校验失败/)
    expect(result.staticCheckAttempts).toBe(1)
  })

  it('YAML 语法错 → fail + lastError 含 YAML 解析错', async () => {
    const state = {
      ...baseState,
      specs: [{ ...baseState.specs[0], generatedContent: 'foo: : :' }],
    }
    const result = await staticCheckNode(state as any)
    expect(result.staticCheckResult).toBe('fail')
    expect(result.lastError).toMatch(/YAML/i)
  })

  it('generatedContent 为空 → fail + 提示 LLM 没产出', async () => {
    const state = {
      ...baseState,
      specs: [{ ...baseState.specs[0], generatedContent: undefined }],
    }
    const result = await staticCheckNode(state as any)
    expect(result.staticCheckResult).toBe('fail')
    expect(result.lastError).toMatch(/为空/)
  })
})
