// src/__tests__/integration/pipeline-a.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'

vi.mock('child_process', () => ({ spawnSync: vi.fn(), spawn: vi.fn() }))
vi.mock('../../e2e/pipeline-a/llm-bridge.js', () => ({
  executeCapabilityDirectForE2e: vi.fn()
    .mockResolvedValueOnce('test("login-success", async ({ page }) => { await page.goto("/"); await expect(page).toHaveTitle("ChatOps"); })')
    .mockResolvedValue('{"verdict":"script_bug"}'),
}))
vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn().mockResolvedValue({ url: 'https://gitlab.example.com', token: 'tok' }),
}))

import { spawnSync } from 'child_process'
import { runPipelineA } from '../../e2e/pipeline-a/runner.js'
import { listE2eSpecs } from '../../db/repositories/e2e-specs.js'

beforeEach(async () => {
  await resetTestDb()
  vi.clearAllMocks()
})

describe('Pipeline A integration', () => {
  it('happy path: generate → static_check pass → baseline pass → pr_open', async () => {
    vi.mocked(spawnSync)
      // provision
      .mockReturnValueOnce({ status: 0, stdout: '{"envId":"test-1","kind":"docker-compose-local","endpoints":{},"internalRefs":{}}', stderr: '' } as any)
      // build
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      // deploy
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      // static_check → pass
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      // run_baseline_check → pass
      .mockReturnValueOnce({ status: 0, stdout: '{"summary":"ok"}', stderr: '' } as any)
      // git checkout -b, git add, git commit, git push
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      // glab mr create
      .mockReturnValueOnce({ status: 0, stdout: 'https://gitlab.example.com/devops/chatops/-/merge_requests/1\n', stderr: '' } as any)
      // teardown
      .mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    await runPipelineA({ targetProjectId: 'chatops', specPaths: ['docs/test-specs/login.md'], baseBranch: 'main' })

    const specs = await listE2eSpecs('chatops')
    expect(specs.some(s => s.generationStatus === 'pr_open')).toBe(true)
  })

  it('baseline fails 3 times → spec marked baseline_failed', async () => {
    vi.mocked(spawnSync)
      // provision
      .mockReturnValueOnce({ status: 0, stdout: '{"envId":"test-2","kind":"docker-compose-local","endpoints":{},"internalRefs":{}}', stderr: '' } as any)
      // build
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      // deploy
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      // static_check pass
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      // 3 baseline fail attempts
      .mockReturnValueOnce({ status: 1, stdout: '{"summary":"selector not found"}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '{"summary":"selector not found"}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '{"summary":"selector not found"}', stderr: '' } as any)
      // teardown
      .mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)

    await runPipelineA({ targetProjectId: 'chatops', specPaths: ['docs/test-specs/login.md'], baseBranch: 'main' })

    const specs = await listE2eSpecs('chatops')
    expect(specs.some(s => s.generationStatus === 'baseline_failed')).toBe(true)
  })
})
