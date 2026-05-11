# QI Pipeline MR Idempotency + Remote Cleanup (Sub-plan C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `mr_create` 节点幂等（撞 409 不报错改 update），让 `cleanup` 节点能真正清远端（remote_branch DELETE / draft_mr close），打通 QI abort 路径的远端资源清理闭环。

**Architecture:** 改 `src/pipeline/node-types/mr-create.ts` 加 `req.mrUrl` 已存在分支走 PUT update；改 `src/pipeline/node-types/cleanup.ts` 把 `cleanRemoteBranch` / `cleanDraftMr` 两个 throw stub 替换为真实 GitLab API 调用；更新 `src/quick-impl/bootstrap.ts` 的 cleanup 节点 targets 加上 `remote_branch` + `draft_mr`（条件性）。

**Tech Stack:** TypeScript ES2022 + NodeNext + Fastify + GitLab REST API v4 + axios + Vitest

**Spec:** [docs/superpowers/specs/2026-05-11-qi-pipeline-topology-design.md](../specs/2026-05-11-qi-pipeline-topology-design.md) §4.1 + §8（mr_create_or_update / cleanup remote_branch 议题）
**审计:** [docs/qi-workflow-audit.md](../../qi-workflow-audit.md) §2.6 "Retry 不幂等"、§3 cleanup 散落、§4-D.17 "每节点不 push 导致 abort 后 worktree+GitLab branch 都不清理"

**Out of Scope（本 plan 不涉及）：**
- E2E 节点 4 拆（sandbox_failed bug，留 E2E sub-plan）
- branch_init 占位 push（→ Sub-plan D）
- 节点级 retry admin API（→ Sub-plan E）
- mr_create 节点本身的 push 逻辑改造（push 已在各 phase commit_push 完成，但 mr_create 仍调 gitPushBranch 兜底；保留兜底行为不动）

---

## File Structure

**Create:**
- `src/__tests__/unit/node-types/mr-create-idempotent.test.ts` — Task 1 单测
- `src/__tests__/unit/node-types/cleanup-gitlab.test.ts` — Task 2+3 单测

**Modify:**
- `src/pipeline/node-types/mr-create.ts` — Task 1：加 mrUrl 已存在分支
- `src/pipeline/node-types/cleanup.ts` — Task 2+3：实接 cleanRemoteBranch / cleanDraftMr
- `src/quick-impl/bootstrap.ts:buildQuickImplGraph()` — Task 4：cleanup 节点 targets 加 remote_branch / draft_mr

**单元测试 pattern 参考：** [src/__tests__/unit/node-types/cleanup.test.ts](../../../src/__tests__/unit/node-types/cleanup.test.ts) + [src/__tests__/unit/node-types/git-commit-push.test.ts](../../../src/__tests__/unit/node-types/git-commit-push.test.ts)

---

## Task 1: `mr_create` 幂等改造

把现有 `mr_create` 改为：如果 `requirements.mrUrl` 已存在，解析 mrIid → PUT GitLab API 更新 title/description/labels；否则 POST 新建（现有逻辑）。

API 撞 409（同 source_branch 已有 MR）时降级为 PUT update 兜底（防御性）。

**Files:**
- Modify: `src/pipeline/node-types/mr-create.ts` (the registerNodeType call body)
- Create: `src/__tests__/unit/node-types/mr-create-idempotent.test.ts`

### Steps

- [ ] **Step 1.1: 探查 mrUrl 解析 + 现有 mr_create 错误处理**

```bash
grep -n "mr_url\|mrUrl\|setMrUrl\|mrIid" src/db/repositories/requirements.ts src/pipeline/node-types/mr-create.ts | head -15
```

确认：
- `Requirement.mrUrl` 类型 `string | null`
- mrUrl 形如 `https://gitlab.com/sherryswift1019-group/chatops/-/merge_requests/42`
- 提取 mrIid 用正则 `/merge_requests/(\d+)$/`

- [ ] **Step 1.2: 写失败测试（idempotent 路径）**

Create `src/__tests__/unit/node-types/mr-create-idempotent.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import axios from 'axios'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/mr-create.js'

vi.mock('axios')
vi.mock('../../../db/repositories/requirements.js', async () => ({
  getRequirementById: vi.fn(),
  setMrUrl: vi.fn(),
  setRequirementStatus: vi.fn(),
  setSpecPlanContent: vi.fn(),
}))
vi.mock('../../../config/gitlab.js', () => ({
  resolveGitlabConfig: async () => ({ url: 'https://gitlab.test', token: 'tok' }),
}))
vi.mock('../../../pipeline/git-push.js', () => ({
  gitPushBranch: async () => {},
  detectRebaseHint: async () => null,
  normalizeProjectPath: (s: string) => s,
}))

const reqRepo = await import('../../../db/repositories/requirements.js')
const mockedAxios = vi.mocked(axios)

describe('mr_create idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('POST creates MR when mrUrl is null (existing behavior)', async () => {
    vi.mocked(reqRepo.getRequirementById).mockResolvedValue({
      id: 1, title: 't', rawInput: 'x', status: 'mr_pending',
      branch: 'feat/qi-1', baseBranch: 'main', gitlabProject: 'group/proj',
      worktreePath: '/tmp/wt', mrUrl: null,
      specContent: 'spec', planContent: null,
      pipelineRunId: 1, currentStage: null, specPath: null, planPath: null,
      abortReason: null, retryCounters: {}, source: 'web', createdBy: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    } as any)
    mockedAxios.post = vi.fn().mockResolvedValue({ data: { iid: 42, web_url: 'https://gitlab.test/group/proj/-/merge_requests/42' } })

    const exec = getExecutor('mr_create')
    const result = await exec!.execute(
      { requirementId: 1, titleTemplate: '[qi] {{requirement.title}}' },
      { runId: 1, pipelineId: 1, nodeId: 'mr_create', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.created).toBe(true)
    expect(result.output.mrIid).toBe(42)
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
  })

  it('PUT updates MR when mrUrl already exists', async () => {
    vi.mocked(reqRepo.getRequirementById).mockResolvedValue({
      id: 1, title: 't', rawInput: 'x', status: 'mr_open',
      branch: 'feat/qi-1', baseBranch: 'main', gitlabProject: 'group/proj',
      worktreePath: '/tmp/wt', mrUrl: 'https://gitlab.test/group/proj/-/merge_requests/42',
      specContent: 'spec', planContent: null,
      pipelineRunId: 1, currentStage: null, specPath: null, planPath: null,
      abortReason: null, retryCounters: {}, source: 'web', createdBy: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    } as any)
    mockedAxios.put = vi.fn().mockResolvedValue({ data: { iid: 42, web_url: 'https://gitlab.test/group/proj/-/merge_requests/42' } })

    const exec = getExecutor('mr_create')
    const result = await exec!.execute(
      { requirementId: 1, titleTemplate: '[qi] {{requirement.title}}' },
      { runId: 1, pipelineId: 1, nodeId: 'mr_create', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.created).toBe(false)
    expect(result.output.mrIid).toBe(42)
    expect(mockedAxios.put).toHaveBeenCalledTimes(1)
    expect((mockedAxios.put as any).mock.calls[0][0]).toMatch(/\/merge_requests\/42$/)
  })

  it('POST 409 falls back to PUT (defensive idempotency)', async () => {
    vi.mocked(reqRepo.getRequirementById).mockResolvedValue({
      id: 1, title: 't', rawInput: 'x', status: 'mr_pending',
      branch: 'feat/qi-1', baseBranch: 'main', gitlabProject: 'group/proj',
      worktreePath: '/tmp/wt', mrUrl: null,
      specContent: 'spec', planContent: null,
      pipelineRunId: 1, currentStage: null, specPath: null, planPath: null,
      abortReason: null, retryCounters: {}, source: 'web', createdBy: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    } as any)

    // POST 409 with existing MR info in response.data
    mockedAxios.post = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: 'Another open merge request already exists' } },
    })
    // 409 后查 MR by source_branch
    mockedAxios.get = vi.fn().mockResolvedValue({ data: [{ iid: 99, web_url: 'https://gitlab.test/group/proj/-/merge_requests/99', state: 'opened' }] })
    mockedAxios.put = vi.fn().mockResolvedValue({ data: { iid: 99, web_url: 'https://gitlab.test/group/proj/-/merge_requests/99' } })
    vi.mocked(axios.isAxiosError).mockReturnValue(true)

    const exec = getExecutor('mr_create')
    const result = await exec!.execute(
      { requirementId: 1 },
      { runId: 1, pipelineId: 1, nodeId: 'mr_create', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.created).toBe(false)
    expect(result.output.mrIid).toBe(99)
    expect(mockedAxios.put).toHaveBeenCalled()
  })
})
```

- [ ] **Step 1.3: Run — expect FAIL（创建+更新+409 三个测试，PUT 路径不存在）**

```bash
npx vitest run src/__tests__/unit/node-types/mr-create-idempotent.test.ts
```

- [ ] **Step 1.4: 实现幂等改造**

修改 `src/pipeline/node-types/mr-create.ts`，找到 `// Create MR` 注释段（约 L180），把原本只 POST 的逻辑改为分支：

```typescript
// ─── Idempotent create or update ──────────────────────────────────────────
// Parse existing mrIid from req.mrUrl if present
function parseMrIidFromUrl(mrUrl: string): number | null {
  const m = mrUrl.match(/\/merge_requests\/(\d+)(?:[/?#]|$)/)
  return m ? Number(m[1]) : null
}

async function findOpenMrBySourceBranch(
  gitlabUrl: string,
  gitlabToken: string,
  project: string,
  sourceBranch: string,
): Promise<{ iid: number; web_url: string } | null> {
  const resp = await axios.get<Array<{ iid: number; web_url: string; state: string }>>(
    `${gitlabUrl}/api/v4/projects/${encodeURIComponent(project)}/merge_requests`,
    {
      headers: { 'PRIVATE-TOKEN': gitlabToken },
      params: { source_branch: sourceBranch, state: 'opened' },
      timeout: 30_000,
    },
  )
  const opened = resp.data.find(m => m.state === 'opened')
  return opened ? { iid: opened.iid, web_url: opened.web_url } : null
}

// 主流程改造（替换原来 // Create MR 那段）：
let mr: { iid: number; web_url: string }
let created = false

const existingMrIid = req.mrUrl ? parseMrIidFromUrl(req.mrUrl) : null
const normalizedProject = normalizeProjectPath(req.gitlabProject)

if (existingMrIid !== null) {
  // PUT update existing MR (idempotent path)
  try {
    const resp = await axios.put(
      `${gitlabUrl}/api/v4/projects/${encodeURIComponent(normalizedProject)}/merge_requests/${existingMrIid}`,
      {
        title,
        description,
        labels,
        // remove_source_branch / squash 不动（PUT 不应改这俩）
      },
      { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 },
    )
    mr = resp.data as { iid: number; web_url: string }
    created = false
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
      : String(err)
    return { status: 'failed', output: {}, error: `mr_create: GitLab API PUT error: ${msg}` }
  }
} else {
  // POST create (existing behavior)
  try {
    const resp = await axios.post(
      `${gitlabUrl}/api/v4/projects/${encodeURIComponent(normalizedProject)}/merge_requests`,
      {
        title,
        description,
        source_branch: req.branch,
        target_branch: req.baseBranch,
        labels,
        remove_source_branch: params.removeSourceBranchAfterMerge !== false,
        squash: params.squashCommits === true,
      },
      { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 },
    )
    mr = resp.data as { iid: number; web_url: string }
    created = true
  } catch (err) {
    // 防御性：409 撞已有 MR → 查 + PUT update
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      try {
        const existing = await findOpenMrBySourceBranch(gitlabUrl, gitlabToken, normalizedProject, req.branch)
        if (!existing) {
          return { status: 'failed', output: {}, error: 'mr_create: 409 but no open MR found by source_branch' }
        }
        const putResp = await axios.put(
          `${gitlabUrl}/api/v4/projects/${encodeURIComponent(normalizedProject)}/merge_requests/${existing.iid}`,
          { title, description, labels },
          { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 },
        )
        mr = putResp.data as { iid: number; web_url: string }
        created = false
      } catch (innerErr) {
        const msg = axios.isAxiosError(innerErr)
          ? `${innerErr.response?.status ?? ''} ${JSON.stringify(innerErr.response?.data ?? innerErr.message)}`
          : String(innerErr)
        return { status: 'failed', output: {}, error: `mr_create: 409 fallback PUT failed: ${msg}` }
      }
    } else {
      const msg = axios.isAxiosError(err)
        ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
        : String(err)
      return { status: 'failed', output: {}, error: `mr_create: GitLab API error: ${msg}` }
    }
  }
}

// Persist MR URL + advance status
await setMrUrl(requirementId, mr.web_url)
await setRequirementStatus(requirementId, 'mr_open')

return {
  status: 'success',
  output: { mrUrl: mr.web_url, mrIid: mr.iid, rebaseHint, created },
}
```

注意：保留 `parseMrIidFromUrl` / `findOpenMrBySourceBranch` 为本文件 module-level helpers（不抽 export），避免污染公共接口。

- [ ] **Step 1.5: Run tests — expect PASS**

```bash
npx vitest run src/__tests__/unit/node-types/mr-create-idempotent.test.ts
./test.sh --typecheck
```

- [ ] **Step 1.6: Commit**

```bash
git add src/pipeline/node-types/mr-create.ts src/__tests__/unit/node-types/mr-create-idempotent.test.ts
git commit -m "feat(qi): mr_create 幂等改造 — mrUrl 已存在走 PUT update + 409 fallback

修审计 §2.6 #2：mr_create 重跑撞 409 报错。新逻辑：
- req.mrUrl 已存在 → 解析 mrIid → PUT update
- req.mrUrl 为空 → POST create
- POST 409 防御性 fallback：查 source_branch 已有 MR → PUT update
output.created 字段标记本次是新建还是更新。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: cleanup `cleanRemoteBranch` 实接 GitLab API

把 `cleanRemoteBranch` throw stub 替换为真实 GitLab DELETE `/projects/:id/repository/branches/:branch` 调用。404（分支不存在）视为 success（abort 路径常态：本地有但远端未 push）。

**Files:**
- Modify: `src/pipeline/node-types/cleanup.ts`
- Create: `src/__tests__/unit/node-types/cleanup-gitlab.test.ts`

### Steps

- [ ] **Step 2.1: 写失败测试**

Create `src/__tests__/unit/node-types/cleanup-gitlab.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import axios from 'axios'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/cleanup.js'

vi.mock('axios')
vi.mock('../../../config/gitlab.js', () => ({
  resolveGitlabConfig: async () => ({ url: 'https://gitlab.test', token: 'tok' }),
}))

const mockedAxios = vi.mocked(axios)

describe('cleanup remote_branch (GitLab DELETE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(axios.isAxiosError).mockImplementation((e: any) => Boolean(e?.isAxiosError))
  })

  it('deletes remote branch (200 / 204 success)', async () => {
    mockedAxios.delete = vi.fn().mockResolvedValue({ status: 204 })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'remote_branch', project: 'group/proj', branch: 'feat/qi-7' }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.report.cleaned).toHaveLength(1)
    expect(result.output.report.failed).toHaveLength(0)
    expect(mockedAxios.delete).toHaveBeenCalledWith(
      'https://gitlab.test/api/v4/projects/group%2Fproj/repository/branches/feat%2Fqi-7',
      expect.objectContaining({ headers: { 'PRIVATE-TOKEN': 'tok' } }),
    )
  })

  it('treats 404 as success (branch already gone)', async () => {
    mockedAxios.delete = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { message: '404 Branch Not Found' } },
    })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'remote_branch', project: 'group/proj', branch: 'feat/qi-7' }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.output.report.cleaned).toHaveLength(1)
    expect(result.output.report.failed).toHaveLength(0)
  })

  it('reports failure on 403 (no permission) — warn-continue', async () => {
    mockedAxios.delete = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { message: '403 Forbidden' } },
    })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'remote_branch', project: 'group/proj', branch: 'feat/qi-7' }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success') // warn-continue
    expect(result.output.report.cleaned).toHaveLength(0)
    expect(result.output.report.failed).toHaveLength(1)
    expect(result.output.report.failed[0]).toMatchObject({
      kind: 'remote_branch',
      ok: false,
    })
    expect(result.output.report.failed[0].error).toMatch(/403/)
  })
})

describe('cleanup draft_mr (GitLab close)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(axios.isAxiosError).mockImplementation((e: any) => Boolean(e?.isAxiosError))
  })

  it('closes draft MR (PUT state_event=close)', async () => {
    mockedAxios.put = vi.fn().mockResolvedValue({ data: { iid: 42, state: 'closed' } })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'draft_mr', project: 'group/proj', mrIid: 42 }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.output.report.cleaned).toHaveLength(1)
    expect(mockedAxios.put).toHaveBeenCalledWith(
      'https://gitlab.test/api/v4/projects/group%2Fproj/merge_requests/42',
      { state_event: 'close' },
      expect.objectContaining({ headers: { 'PRIVATE-TOKEN': 'tok' } }),
    )
  })

  it('treats 404 as success (MR already gone)', async () => {
    mockedAxios.put = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 404 },
    })

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'draft_mr', project: 'group/proj', mrIid: 42 }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.output.report.cleaned).toHaveLength(1)
  })

  it('skips when mrIid is 0 or invalid (no MR was created)', async () => {
    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'draft_mr', project: 'group/proj', mrIid: 0 }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    // mrIid=0 → 视为 no-MR-to-close，归入 cleaned 但加 skipped 标记
    expect(result.output.report.cleaned).toHaveLength(1)
    expect(result.output.report.cleaned[0]).toMatchObject({ kind: 'draft_mr', mrIid: 0, ok: true })
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2.2: Run — expect FAIL（stub throws）**

```bash
npx vitest run src/__tests__/unit/node-types/cleanup-gitlab.test.ts
```

- [ ] **Step 2.3: 实现 cleanRemoteBranch**

修改 `src/pipeline/node-types/cleanup.ts`，把现有 throw stub 替换为：

```typescript
import * as fs from 'node:fs/promises'
import axios from 'axios'
import { registerNodeType } from './registry.js'
import type { NodeExecutionResult, ExecutionContext } from './types.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'

type CleanupTarget =
  | { kind: 'worktree'; path: string }
  | { kind: 'sandbox'; path: string }
  | { kind: 'remote_branch'; project: string; branch: string }
  | { kind: 'bare_repo'; path: string }
  | { kind: 'draft_mr'; project: string; mrIid: number }

type CleanupReport = {
  cleaned: Array<CleanupTarget & { ok: true }>
  failed: Array<CleanupTarget & { ok: false; error: string }>
}

async function cleanRemoteBranch(project: string, branch: string): Promise<void> {
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) {
    throw new Error('GitLab config (url/token) missing')
  }
  try {
    await axios.delete(
      `${url}/api/v4/projects/${encodeURIComponent(project)}/repository/branches/${encodeURIComponent(branch)}`,
      {
        headers: { 'PRIVATE-TOKEN': token },
        timeout: 30_000,
        validateStatus: (s) => s >= 200 && s < 300,
      },
    )
  } catch (err) {
    // 404 视为成功（分支不存在 = 目标已达成）
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return
    }
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
      : String(err)
    throw new Error(`GitLab DELETE branch failed: ${msg}`)
  }
}

async function cleanDraftMr(project: string, mrIid: number): Promise<void> {
  if (!mrIid || mrIid <= 0) {
    // mrIid=0 / invalid → 没 MR 可关，视为成功
    return
  }
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) {
    throw new Error('GitLab config (url/token) missing')
  }
  try {
    await axios.put(
      `${url}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${mrIid}`,
      { state_event: 'close' },
      {
        headers: { 'PRIVATE-TOKEN': token },
        timeout: 30_000,
        validateStatus: (s) => s >= 200 && s < 300,
      },
    )
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return
    }
    const msg = axios.isAxiosError(err)
      ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
      : String(err)
    throw new Error(`GitLab close MR failed: ${msg}`)
  }
}

registerNodeType({
  key: 'cleanup',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const targets = (params.targets ?? []) as CleanupTarget[]
    if (!Array.isArray(targets)) {
      return { status: 'failed', output: {}, error: 'cleanup: targets must be array' }
    }

    const report: CleanupReport = { cleaned: [], failed: [] }

    for (const t of targets) {
      try {
        switch (t.kind) {
          case 'worktree':
          case 'sandbox':
          case 'bare_repo':
            await fs.rm(t.path, { recursive: true, force: true })
            break
          case 'remote_branch': await cleanRemoteBranch(t.project, t.branch); break
          case 'draft_mr':      await cleanDraftMr(t.project, t.mrIid);       break
          default:
            report.failed.push({ ...(t as CleanupTarget), ok: false, error: 'unknown kind' })
            continue
        }
        report.cleaned.push({ ...t, ok: true })
      } catch (err) {
        report.failed.push({
          ...t,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { status: 'success', output: { report } }
  },
})
```

- [ ] **Step 2.4: Run — expect PASS**

```bash
npx vitest run src/__tests__/unit/node-types/cleanup-gitlab.test.ts
npx vitest run src/__tests__/unit/node-types/cleanup.test.ts  # 原有 3 个测试不能挂
./test.sh --typecheck
```

- [ ] **Step 2.5: Commit**

```bash
git add src/pipeline/node-types/cleanup.ts src/__tests__/unit/node-types/cleanup-gitlab.test.ts
git commit -m "feat(qi): cleanup 接 GitLab API — remote_branch DELETE + draft_mr close

修审计 §4-D.17：abort 后 GitLab branch + draft MR 不清理。
- remote_branch → DELETE /api/v4/projects/:id/repository/branches/:branch
- draft_mr → PUT /api/v4/projects/:id/merge_requests/:iid (state_event=close)
- 404 一律视为 success（目标已达成）
- mrIid=0/invalid → no-op success（无 MR 可关）
- 其它错误（403/500）→ warn-continue（汇 failed[] 不阻断）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: bootstrap cleanup 节点 targets 加 `remote_branch` + `draft_mr`

让 QI pipeline 的 cleanup 节点真正能清远端资源。`remote_branch` 总加（每个 abort 路径都有 branch）；`draft_mr` 有条件（mr_create 跑过才有 mrIid，否则模板渲染为空 → cleanup 节点内部 mrIid=0 兜底 skip）。

**Files:**
- Modify: `src/quick-impl/bootstrap.ts:buildQuickImplGraph()` — cleanup 节点 params
- Modify: `src/quick-impl/bootstrap.ts` — `QUICK_IMPL_TEMPLATE_VERSION` 12 → 13

### Steps

- [ ] **Step 3.1: 探查当前 cleanup 节点 params**

```bash
grep -A 12 "makeNode('cleanup'" src/quick-impl/bootstrap.ts
```

确认当前 targets 数组只含 worktree + bare_repo。

- [ ] **Step 3.2: 写集成测试（bootstrap v13）**

Create `src/__tests__/integration/qi-pipeline-bootstrap-v13.test.ts`：

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { bootstrapQuickImpl } from '../../quick-impl/bootstrap.js'
import { getTestPipelineByName } from '../../db/repositories/test-pipelines.js'

describe('Quick-Impl bootstrap v13 (cleanup 加 remote_branch + draft_mr)', () => {
  beforeAll(async () => {
    await resetTestDb()
  })

  it('cleanup node targets include remote_branch + draft_mr', async () => {
    await bootstrapQuickImpl()
    const pipeline = await getTestPipelineByName('quick-impl')
    expect(pipeline).toBeDefined()

    const cleanupNode = pipeline!.graph!.nodes.find(n => n.id === 'cleanup')
    expect(cleanupNode).toBeDefined()

    const targets = (cleanupNode!.params?.targets ?? []) as Array<{ kind: string }>
    const kinds = targets.map(t => t.kind)

    expect(kinds).toContain('worktree')
    expect(kinds).toContain('bare_repo')
    expect(kinds).toContain('remote_branch')   // ← 新增
    expect(kinds).toContain('draft_mr')        // ← 新增
  })
})
```

- [ ] **Step 3.3: Run — expect FAIL**

```bash
npx vitest run src/__tests__/integration/qi-pipeline-bootstrap-v13.test.ts
```

- [ ] **Step 3.4: 改 cleanup 节点 targets**

在 `src/quick-impl/bootstrap.ts:buildQuickImplGraph()` 中找到 cleanup 节点定义，把 params.targets 改为：

```typescript
makeNode('cleanup', {
  name: 'Cleanup',
  stageType: 'cleanup',
  onFailure: 'stop',
  params: {
    targets: [
      { kind: 'worktree', path: '{{steps.init_branch.output.worktreePath}}' },
      { kind: 'bare_repo', path: '{{steps.init_branch.output.bareRepoPath}}' },
      { kind: 'remote_branch', project: '{{triggerParams.gitlabProject}}', branch: '{{steps.init_branch.output.branch}}' },
      { kind: 'draft_mr', project: '{{triggerParams.gitlabProject}}', mrIid: '{{steps.mr_create.output.mrIid}}' },
    ],
    statusOnSuccess: 'aborted',
  },
} as any),
```

注意：
- `remote_branch` 总执行（branch 总是已建）；如果 abort 在 init_branch 之前发生，整个 cleanup 节点都走不到，所以不用担心
- `draft_mr` 的 mrIid 模板：abort 在 mr_create 之前发生时，`steps.mr_create.output.mrIid` 渲染为空字符串 / undefined → cleanup 节点内部 `cleanDraftMr` 函数已经处理：`mrIid <= 0` 时直接 return success（Task 2 已实现）

- [ ] **Step 3.5: Bump QUICK_IMPL_TEMPLATE_VERSION**

```typescript
const QUICK_IMPL_TEMPLATE_VERSION = 13  // 从 12 改为 13
```

同步更新 description：

```typescript
description: 'Quick-Impl：25 节点新拓扑（cleanup 加 remote_branch+draft_mr 闭环）',
```

- [ ] **Step 3.6: Run — expect PASS**

```bash
npx vitest run src/__tests__/integration/qi-pipeline-bootstrap-v13.test.ts
./test.sh --filter qi-pipeline-bootstrap  # 既有 v12 test 不能挂；它断言旧 cleanup 节点应仍存在
./test.sh --typecheck
```

注意：v12 测试断言 cleanup 节点存在 + 含 worktree/bare_repo target，**仍然成立**（v13 是叠加 remote_branch + draft_mr，不删旧的）。如有断言 targets 数组长度精确为 2，需放宽到 `>= 2` 或更新数字。grep 确认：

```bash
grep -n "targets.*length\|kinds.*toEqual\|kinds.*length" src/__tests__/integration/qi-pipeline-bootstrap-v12.test.ts
```

- [ ] **Step 3.7: Commit**

```bash
git add src/quick-impl/bootstrap.ts src/__tests__/integration/qi-pipeline-bootstrap-v13.test.ts
git commit -m "feat(qi): cleanup 节点加 remote_branch + draft_mr targets — bump v13

QUICK_IMPL_TEMPLATE_VERSION 12 → 13。cleanup 节点 targets 加 remote_branch
（abort 路径清远端分支）+ draft_mr（abort 路径关已开 draft MR）。
mr_create 未跑场景：mrIid 模板渲染为空 → cleanDraftMr 内部 mrIid<=0 兜底 skip。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: 全套测试 + smoke

跑全套确保无回归，verify Sub-plan C 改动跟 Sub-plan A+B 兼容。

### Steps

- [ ] **Step 4.1: 全套 typecheck**

```bash
./test.sh --typecheck
```

- [ ] **Step 4.2: 跑相关测试套件**

```bash
./test.sh --filter "mr-create-idempotent|cleanup|cleanup-gitlab|qi-pipeline-bootstrap"
```

预期所有相关测试 pass。

- [ ] **Step 4.3: 可选 — 跑完整测试**

```bash
./test.sh
```

预期：仅 Sub-plan B 完工时遗留的 11 个 pre-existing failures（quick-impl-role-contract / pipeline-node-types-repo / admin-pipeline-node-types-route / quick-impl-schema-v60 / quick-impl-worktree / web-review-waiter），Sub-plan C 不引入新 failures。

如果有 Sub-plan C 引入的新 failures，定位修复：
- 修测试（如果是测试 assertion 跟新行为不一致，如 cleanup-test 期望 remote_branch throws）
- 修代码（如果是真 bug）
- BLOCKED escalate

- [ ] **Step 4.4: 不需要 commit**（仅 verify，没改动文件）

---

## Self-Review

- [ ] **Spec coverage**：spec §4.1 "mr_create_or_update 必须幂等" → Task 1 ✅；spec §8 "cleanup remote_branch / draft_mr" → Task 2+3 ✅。spec 没要求改 stage type 名（用 mr_create 即可），保持兼容。

- [ ] **Placeholder scan**：grep `TODO|TBD|implement later` 在本 plan 代码块。无。Task 2 实现的 cleanup helpers 不再有 "pending Sub-plan C" throw stub。

- [ ] **Type consistency**：
  - mrIid 类型 number 一致（DB 列 / API 响应 / cleanup target.mrIid）✅
  - cleanRemoteBranch / cleanDraftMr 签名一致（project: string, branch/mrIid）✅
  - axios.isAxiosError 在所有 catch 用法一致 ✅
  - `created` boolean 输出新增字段，下游不消费但有用于 audit ✅

- [ ] **Commit message 约定**：`feat(qi): ...` 前缀，符合 commit-conventions ✅

---

## Execution Handoff

Plan 写完，保存到 `docs/superpowers/plans/2026-05-11-qi-pipeline-mr-idempotent-cleanup-sub-plan-c.md`。

**风险：**
- Task 1 的 mr_create 改造是中等大改动（~80 行新代码），但有 3 个测试覆盖三条路径（POST/PUT/409 fallback）
- Task 3 模板渲染 mrIid='' 时 cleanup 节点收到的是空字符串还是 undefined 取决于 renderParamTemplates 实现；测试覆盖了 mrIid=0 路径，实际跑可能值是 `''` — cleanDraftMr 里 `if (!mrIid || mrIid <= 0)` 用 falsy 检查兼容空字符串 ✅
- v13 bootstrap 测试可能干扰 v12 测试（如果 v12 测试 assertion 用 exact match）— Step 3.6 grep 已提示要 verify

**执行选项：**

1. **Subagent-Driven（推荐）** — 每 task fresh subagent + 两阶段 review
2. **Inline 执行** — 当前 session 用 executing-plans skill 批量跑

Which approach?
