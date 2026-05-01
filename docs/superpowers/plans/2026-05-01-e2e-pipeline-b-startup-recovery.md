# E2E Pipeline B — 进程重启 Startup Recovery 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 recoverInflightE2eRuns()：进程启动时扫描所有 running/awaiting_fix 的 e2e run，全部标记 aborted + best-effort teardown 沙盒 + delete remote branch，防止沙盒泄漏和 run 卡死。

**Architecture:** 纯函数 recoverInflightE2eRuns() 在 server onReady hook 调用；teardown/branch-delete 都是 best-effort（catch 后 log，不阻止 server 启动）。

**Tech Stack:** TypeScript, Fastify onReady hook, Vitest

**前置条件:** Plan B3+B4（节点实现）完成

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `src/e2e/pipeline-b/startup-recovery.ts` |
| 修改 | `src/server.ts` |
| 新建 | `src/__tests__/unit/startup-recovery.test.ts` |

---

### Task 1: startup-recovery.ts（实现 + 单测）

**Files:**
- 新建: `src/e2e/pipeline-b/startup-recovery.ts`
- 新建: `src/__tests__/unit/startup-recovery.test.ts`

- [ ] **Step 1: 写单测文件**

```typescript
// src/__tests__/unit/startup-recovery.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- mock 所有外部依赖 ---
vi.mock('../../db/repositories/e2e-runs.js', () => ({
  listInflightE2eRuns: vi.fn(),
  updateE2eRunStatus: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-sandboxes.js', () => ({
  getSandboxByRunId: vi.fn(),
  updateSandboxStatus: vi.fn(),
}))

vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn(),
}))

// mock child_process / fs — startup-recovery 内部调 execa 或 fs.writeFile
// 用 vi.mock 替换 fs/promises 和 execa
vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
  unlink: vi.fn(),
  mkdtemp: vi.fn(),
}))

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

// mock global fetch（deleteRemoteBranchBestEffort 使用）
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { recoverInflightE2eRuns } from '../../e2e/pipeline-b/startup-recovery.js'
import { listInflightE2eRuns, updateE2eRunStatus } from '../../db/repositories/e2e-runs.js'
import { getSandboxByRunId, updateSandboxStatus } from '../../db/repositories/e2e-sandboxes.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import * as fsPromises from 'fs/promises'
import { execa } from 'execa'

const mockListInflight = vi.mocked(listInflightE2eRuns)
const mockUpdateRunStatus = vi.mocked(updateE2eRunStatus)
const mockGetSandbox = vi.mocked(getSandboxByRunId)
const mockUpdateSandboxStatus = vi.mocked(updateSandboxStatus)
const mockResolveGitlab = vi.mocked(resolveGitlabConfig)
const mockWriteFile = vi.mocked(fsPromises.writeFile)
const mockUnlink = vi.mocked(fsPromises.unlink)
const mockMkdtemp = vi.mocked(fsPromises.mkdtemp)
const mockExeca = vi.mocked(execa)

function makeRun(id: bigint, iterationBranch = 'e2e/iter-abc123') {
  return {
    id,
    targetProjectId: 'group/repo',
    triggerType: 'manual',
    triggerActor: null,
    sourceBranch: 'main',
    iterationBranch,
    scenarioFilter: null,
    status: 'running' as const,
    governorState: {},
    summaryMrUrl: null,
    startedAt: new Date('2026-05-01T00:00:00Z'),
    finishedAt: null,
    abortReason: null,
  }
}

function makeSandbox(id: bigint, runId: bigint, status = 'ready' as const) {
  return {
    id,
    e2eRunId: runId,
    kind: 'compose',
    handle: { envId: 'env-1', kind: 'compose', endpoints: {} },
    status,
    createdAt: new Date(),
    readyAt: new Date(),
    destroyedAt: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateRunStatus.mockResolvedValue(undefined)
  mockUpdateSandboxStatus.mockResolvedValue(undefined)
  mockResolveGitlab.mockResolvedValue({ url: 'https://gitlab.example.com', token: 'tok-test', skipTlsVerify: false })
  mockMkdtemp.mockResolvedValue('/tmp/e2e-recovery-abc')
  mockWriteFile.mockResolvedValue(undefined)
  mockUnlink.mockResolvedValue(undefined)
  mockExeca.mockResolvedValue({ exitCode: 0 } as any)
  fetchMock.mockResolvedValue({ status: 204 })
})

describe('recoverInflightE2eRuns', () => {
  it('无 inflight runs → 函数正常退出，不报错', async () => {
    mockListInflight.mockResolvedValue([])

    await expect(recoverInflightE2eRuns()).resolves.toBeUndefined()

    expect(mockUpdateRunStatus).not.toHaveBeenCalled()
    expect(mockGetSandbox).not.toHaveBeenCalled()
  })

  it('2 个 inflight runs → 全部标 aborted，teardown 被调用', async () => {
    const run1 = makeRun(1n, 'e2e/iter-aaa')
    const run2 = makeRun(2n, 'e2e/iter-bbb')
    mockListInflight.mockResolvedValue([run1, run2])

    const sb1 = makeSandbox(10n, 1n, 'ready')
    const sb2 = makeSandbox(11n, 2n, 'provisioning')
    mockGetSandbox.mockImplementation(async (runId) => {
      if (runId === 1n) return sb1
      if (runId === 2n) return sb2
      return null
    })

    await recoverInflightE2eRuns()

    // 两个 run 都被标 aborted
    expect(mockUpdateRunStatus).toHaveBeenCalledTimes(2)
    expect(mockUpdateRunStatus).toHaveBeenCalledWith(1n, 'aborted', {
      finishedAt: expect.any(Date),
      abortReason: 'process_restart',
    })
    expect(mockUpdateRunStatus).toHaveBeenCalledWith(2n, 'aborted', {
      finishedAt: expect.any(Date),
      abortReason: 'process_restart',
    })

    // 两个沙盒都被 teardown（更新状态为 torn_down）
    expect(mockUpdateSandboxStatus).toHaveBeenCalledWith(10n, 'torn_down', expect.objectContaining({ destroyedAt: expect.any(Date) }))
    expect(mockUpdateSandboxStatus).toHaveBeenCalledWith(11n, 'torn_down', expect.objectContaining({ destroyedAt: expect.any(Date) }))

    // 分支删除 fetch 被调用 2 次
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('teardown 失败 → 不抛异常，run 仍被标 aborted', async () => {
    const run = makeRun(3n, 'e2e/iter-ccc')
    mockListInflight.mockResolvedValue([run])
    mockGetSandbox.mockResolvedValue(makeSandbox(20n, 3n, 'ready'))

    // deploy.sh teardown 失败
    mockExeca.mockRejectedValue(new Error('docker teardown failed'))

    await expect(recoverInflightE2eRuns()).resolves.toBeUndefined()

    // run 仍然被标 aborted
    expect(mockUpdateRunStatus).toHaveBeenCalledWith(3n, 'aborted', {
      finishedAt: expect.any(Date),
      abortReason: 'process_restart',
    })
  })

  it('delete branch 返回 404 → 算成功，不抛异常', async () => {
    const run = makeRun(4n, 'e2e/iter-ddd')
    mockListInflight.mockResolvedValue([run])
    mockGetSandbox.mockResolvedValue(null) // 无沙盒

    // GitLab 返回 404（分支不存在）
    fetchMock.mockResolvedValue({ status: 404 })

    await expect(recoverInflightE2eRuns()).resolves.toBeUndefined()

    expect(mockUpdateRunStatus).toHaveBeenCalledWith(4n, 'aborted', {
      finishedAt: expect.any(Date),
      abortReason: 'process_restart',
    })
  })

  it('已是 torn_down 的沙盒 → 跳过 teardown', async () => {
    const run = makeRun(5n, 'e2e/iter-eee')
    mockListInflight.mockResolvedValue([run])
    mockGetSandbox.mockResolvedValue(makeSandbox(30n, 5n, 'torn_down'))

    await recoverInflightE2eRuns()

    // sandbox status 已是 torn_down，不应再调 teardown
    expect(mockExeca).not.toHaveBeenCalled()
    expect(mockUpdateSandboxStatus).not.toHaveBeenCalled()
  })

  it('已是 failed 的沙盒 → 跳过 teardown', async () => {
    const run = makeRun(6n, 'e2e/iter-fff')
    mockListInflight.mockResolvedValue([run])
    mockGetSandbox.mockResolvedValue(makeSandbox(31n, 6n, 'failed'))

    await recoverInflightE2eRuns()

    expect(mockExeca).not.toHaveBeenCalled()
    expect(mockUpdateSandboxStatus).not.toHaveBeenCalled()
  })

  it('delete branch fetch 抛异常 → 不阻止 run 标 aborted', async () => {
    const run = makeRun(7n, 'e2e/iter-ggg')
    mockListInflight.mockResolvedValue([run])
    mockGetSandbox.mockResolvedValue(null)

    fetchMock.mockRejectedValue(new Error('network error'))

    await expect(recoverInflightE2eRuns()).resolves.toBeUndefined()

    expect(mockUpdateRunStatus).toHaveBeenCalledWith(7n, 'aborted', expect.any(Object))
  })
})
```

- [ ] **Step 2: 运行单测（预期全红，因为实现文件尚未存在）**

```bash
npx vitest run src/__tests__/unit/startup-recovery.test.ts
```

- [ ] **Step 3: 实现 startup-recovery.ts**

```typescript
// src/e2e/pipeline-b/startup-recovery.ts
import { writeFile, unlink, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execa } from 'execa'
import {
  listInflightE2eRuns,
  updateE2eRunStatus,
} from '../../db/repositories/e2e-runs.js'
import {
  getSandboxByRunId,
  updateSandboxStatus,
  type E2eSandbox,
} from '../../db/repositories/e2e-sandboxes.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'

// deploy.sh path — same dir convention as rest of codebase
const DEPLOY_SH = join(process.cwd(), 'deploy.sh')

/**
 * Best-effort teardown of a sandbox: write handle JSON to tmp file,
 * invoke deploy.sh teardown, then clean up the tmp file.
 * Updates sandbox status to 'torn_down' on success.
 *
 * Throws on unexpected errors; caller is responsible for .catch().
 */
async function teardownSandboxBestEffort(sandbox: E2eSandbox): Promise<void> {
  const handleJson = JSON.stringify(sandbox.handle)

  // Write handle to a temp file so deploy.sh can read it as --handle=<file>
  const tmpDir = await mkdtemp(join(tmpdir(), 'e2e-recovery-'))
  const handleFile = join(tmpDir, 'handle.json')
  await writeFile(handleFile, handleJson, 'utf8')

  try {
    await execa('bash', [DEPLOY_SH, 'teardown', `--handle=${handleFile}`], {
      timeout: 60_000,
    })
  } finally {
    await unlink(handleFile).catch(() => undefined)
  }

  await updateSandboxStatus(sandbox.id, 'torn_down', { destroyedAt: new Date() })
}

/**
 * Best-effort delete of a remote GitLab branch.
 * 404 is treated as success (branch already gone = idempotent).
 *
 * Throws on unexpected errors; caller is responsible for .catch().
 */
async function deleteRemoteBranchBestEffort(
  repoPath: string,
  branch: string,
): Promise<void> {
  const { url, token } = await resolveGitlabConfig()
  const encodedRepo = encodeURIComponent(repoPath)
  const encodedBranch = encodeURIComponent(branch)
  const apiUrl = `${url.replace(/\/$/, '')}/api/v4/projects/${encodedRepo}/repository/branches/${encodedBranch}`

  const resp = await fetch(apiUrl, {
    method: 'DELETE',
    headers: { 'PRIVATE-TOKEN': token },
  })

  if (resp.status !== 204 && resp.status !== 404) {
    throw new Error(`GitLab branch delete returned unexpected status ${resp.status} for branch ${branch}`)
  }
  // 404 = already gone, treat as success
}

/**
 * Scan for all inflight e2e runs (status running / awaiting_fix) left over
 * from a previous server process and mark them aborted, then best-effort
 * teardown their sandboxes and delete remote iteration branches.
 *
 * Never throws — all errors are logged but do not prevent server startup.
 */
export async function recoverInflightE2eRuns(): Promise<void> {
  const stuck = await listInflightE2eRuns()

  if (stuck.length === 0) return

  console.log(`[E2eRecovery] found ${stuck.length} inflight run(s) — marking aborted`)

  for (const run of stuck) {
    // 1. Mark aborted first so subsequent logic (even if it errors) doesn't
    //    leave a run in a permanently stuck state.
    await updateE2eRunStatus(run.id, 'aborted', {
      finishedAt: new Date(),
      abortReason: 'process_restart',
    })

    // 2. Find associated sandbox
    const sandbox = await getSandboxByRunId(run.id)

    // 3. Best-effort teardown (skip if already terminal)
    if (
      sandbox &&
      sandbox.status !== 'torn_down' &&
      sandbox.status !== 'failed'
    ) {
      await teardownSandboxBestEffort(sandbox).catch((err) => {
        console.error(
          `[E2eRecovery] teardown failed for sandbox ${sandbox.id}:`,
          err,
        )
      })
    }

    // 4. Best-effort delete remote iteration branch
    await deleteRemoteBranchBestEffort(run.targetProjectId, run.iterationBranch).catch(
      (err) => {
        console.error(
          `[E2eRecovery] branch delete failed for ${run.iterationBranch}:`,
          err,
        )
      },
    )

    console.log(`[E2eRecovery] recovered run ${run.id}: aborted + teardown`)
  }
}
```

- [ ] **Step 4: 运行单测（预期全绿）**

```bash
npx vitest run src/__tests__/unit/startup-recovery.test.ts
```

---

### Task 2: server.ts 集成（onReady hook）

**Files:**
- 修改: `src/server.ts`

- [ ] **Step 1: 在 server.ts 顶部 import 区加 import**

在 `src/server.ts` 中，在 `import { verifySandboxSafety } ...` 一行附近（E2E 相关 import 区）加入：

```typescript
import { recoverInflightE2eRuns } from './e2e/pipeline-b/startup-recovery.js'
```

- [ ] **Step 2: 在 buildServer/main() 里加 onReady hook**

在 `src/server.ts` 中，找到已有的 `sweepOrphanReviewingPrds` 的 try/catch 块之后、
`sessionManager` 创建之前，加入：

```typescript
  // 启动兜底：把被上次进程中断的 e2e run（running / awaiting_fix）全部标 aborted
  // + best-effort 清理沙盒 / 删 iteration branch，防资源泄漏。
  try {
    await recoverInflightE2eRuns()
  } catch (err) {
    app.log.warn({ err }, '[E2eRecovery] startup recovery failed (non-fatal)')
  }
```

完整上下文（修改后该区域应如下所示）：

```typescript
  // 启动兜底：把被上次进程中断的 PRD（status=reviewing 停留 >5min）推到 review_blocked，
  // 避免 UI 永久卡在 "Agent 正在处理" 的 spinner。
  try {
    const swept = await sweepOrphanReviewingPrds(5 * 60 * 1000)
    if (swept > 0) {
      app.log.info(`[prd-sweep] marked ${swept} orphan reviewing PRD(s) as review_blocked`)
    }
  } catch (err) {
    app.log.warn({ err }, '[prd-sweep] sweep orphan reviewing PRDs failed')
  }

  // 启动兜底：把被上次进程中断的 e2e run（running / awaiting_fix）全部标 aborted
  // + best-effort 清理沙盒 / 删 iteration branch，防资源泄漏。
  try {
    await recoverInflightE2eRuns()
  } catch (err) {
    app.log.warn({ err }, '[E2eRecovery] startup recovery failed (non-fatal)')
  }

  // Session manager — processes each message
  const sessionManager = new SessionManager(
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
./test.sh --typecheck
```

---

## 验收检查清单

- [ ] `npx vitest run src/__tests__/unit/startup-recovery.test.ts` 全绿（7 cases）
- [ ] `./test.sh --typecheck` 无 TS 报错
- [ ] server 启动日志含 `[E2eRecovery]` 相关输出（无 inflight 时静默通过）
- [ ] 无 inflight run 时函数不调用任何 DB write
- [ ] teardown 失败 / branch 删除失败均不阻止 server 启动
