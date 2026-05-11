# QI Pipeline branch_init Early Push (Sub-plan D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `init_qi_branch` 节点在创建本地 worktree + bare repo 之后**额外**做一个空占位 commit + push 到 GitLab `origin/feat/qi-N`，开发期 GitLab 即可见该需求的分支存在；abort 时由 Sub-plan C cleanup 节点的 `remote_branch` target 收尾。

**Architecture:** 抽 `gitPushBranch` / `normalizeProjectPath` / `escapeShell` 三个 helper 从 `src/pipeline/node-types/mr-create.ts` 移到 `src/pipeline/git-helpers.ts`（消除 DRY），然后在 `init_qi_branch` 节点末尾调用：先 `git commit --allow-empty -m "chore(qi-N): init branch"`（用 `-c user.email/user.name` inline 配 author），再 `gitPushBranch`。push 失败 warn-continue（不让网络抖动卡死整条 pipeline），output 加 `remotePushed: boolean` 字段。

**Tech Stack:** TypeScript ES2022 + NodeNext + child_process exec + Vitest

**Spec:** [docs/superpowers/specs/2026-05-11-qi-pipeline-topology-design.md](../specs/2026-05-11-qi-pipeline-topology-design.md) §2.3 "每阶段里程碑 push GitLab" + §5 节点 1 "branch_init 也推占位 commit"
**审计:** [docs/qi-workflow-audit.md](../../qi-workflow-audit.md) §2.1 init_branch 不 push、§4-D.17 开发期 GitLab 完全看不到此需求

**Out of Scope（本 plan 不涉及）：**
- E2E 节点 4 拆（留 E2E sub-plan）
- 节点级 retry admin API（→ Sub-plan E）
- 多 retry attempt 的分支命名策略（acquireWorktree 已支持 `feat/qi-N-r{M}`，Sub-plan D 沿用）

---

## File Structure

**Create:**
- `src/pipeline/git-helpers.ts` — 抽出的共享 git helper（escapeShell / normalizeProjectPath / gitPushBranch）
- `src/__tests__/unit/pipeline/git-helpers.test.ts` — pure unit tests for helpers
- `src/__tests__/unit/node-types/init-qi-branch-push.test.ts` — Task 2 集成单测

**Modify:**
- `src/pipeline/node-types/mr-create.ts` — 删除本地 helpers，改为 import from git-helpers
- `src/pipeline/node-types/init-qi-branch.ts` — 加 empty commit + push 逻辑（含 warn-continue 错误处理 + output.remotePushed 字段）

**单元测试 pattern 参考：** [src/__tests__/unit/node-types/mr-create-idempotent.test.ts](../../../src/__tests__/unit/node-types/mr-create-idempotent.test.ts) + [src/__tests__/unit/node-types/git-commit-push.test.ts](../../../src/__tests__/unit/node-types/git-commit-push.test.ts)

---

## Task 1: 抽 git helpers 到 `src/pipeline/git-helpers.ts`

把 `mr-create.ts` 里的 3 个 module-local helpers (`escapeShell` / `normalizeProjectPath` / `gitPushBranch`) 抽到共享模块，让 `init_qi_branch.ts` 能复用。

**Files:**
- Create: `src/pipeline/git-helpers.ts`
- Create: `src/__tests__/unit/pipeline/git-helpers.test.ts`
- Modify: `src/pipeline/node-types/mr-create.ts` — 删 local helpers，改 import

### Steps

- [ ] **Step 1.1: 写 pure helper 测试（escapeShell / normalizeProjectPath）**

Create `src/__tests__/unit/pipeline/git-helpers.test.ts`：

```typescript
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
```

- [ ] **Step 1.2: Run — expect FAIL（模块不存在）**

```bash
npx vitest run src/__tests__/unit/pipeline/git-helpers.test.ts
```

- [ ] **Step 1.3: 抽 helpers 到新模块**

Create `src/pipeline/git-helpers.ts`：

```typescript
import { exec } from 'child_process'
import { promisify } from 'util'
import { injectGitlabAuth } from '../config/git-auth.js'

const execAsync = promisify(exec)

/** Shell-quote a string for single-quote literal usage. */
export function escapeShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Normalize various GitLab project identifiers down to `group/repo` form.
 * Accepts: "https://host/group/repo.git", "group/repo.git", "/group/repo/", "group/repo"
 */
export function normalizeProjectPath(input: string): string {
  let s = input.trim().replace(/\.git$/i, '')
  const m = /^https?:\/\/[^/]+\/(.+)$/.exec(s)
  if (m) s = m[1]
  return s.replace(/^\/+|\/+$/g, '')
}

/**
 * Push current HEAD of `worktreePath` to `<gitlabUrl>/<project>.git` as `branch`.
 * Uses authed URL (inject token via injectGitlabAuth).
 * Throws on any push failure.
 */
export async function gitPushBranch(
  worktreePath: string,
  branch: string,
  gitlabUrl: string,
  gitlabProject: string,
): Promise<void> {
  const projectPath = normalizeProjectPath(gitlabProject)
  const rawUrl = `${gitlabUrl.replace(/\/$/, '')}/${projectPath}.git`
  const authedUrl = await injectGitlabAuth(rawUrl)
  await execAsync(
    `git push ${escapeShell(authedUrl)} HEAD:${escapeShell(branch)}`,
    { cwd: worktreePath, timeout: 60_000 },
  )
}
```

- [ ] **Step 1.4: 更新 mr-create.ts 引用**

修改 `src/pipeline/node-types/mr-create.ts`：

1. **删除** L18-L47 段（`const execAsync = promisify(exec)` + `escapeShell` + `normalizeProjectPath` + `gitPushBranch`）— 注意保留 `detectRebaseHint` 和后续的 helper functions
2. **新增 import**：

```typescript
import { gitPushBranch, normalizeProjectPath } from '../git-helpers.js'
```

3. **删除多余 import**：如果删 helpers 后 `exec` / `promisify` 在 mr-create.ts 没人用，删那两行 import；如果 `detectRebaseHint` 还用 `execAsync`，则保留 `import { exec } from 'child_process'` + `import { promisify } from 'util'` + `const execAsync = promisify(exec)`（保留这 3 行，因为 `detectRebaseHint` 用它）
4. **删除多余 import**：`import { injectGitlabAuth } from '../../config/git-auth.js'` — 已不再直接用（移到 git-helpers.ts 里）

注意：mr-create.ts 的 `normalizeProjectPath` 调用在多处（L184 等），import 后这些调用 site 不需要改（函数名一样）。

- [ ] **Step 1.5: Run tests — expect PASS**

```bash
npx vitest run src/__tests__/unit/pipeline/git-helpers.test.ts
npx vitest run src/__tests__/unit/node-types/mr-create-idempotent.test.ts  # mr_create 测试仍 pass
./test.sh --typecheck
```

- [ ] **Step 1.6: Commit**

```bash
git add src/pipeline/git-helpers.ts src/pipeline/node-types/mr-create.ts src/__tests__/unit/pipeline/git-helpers.test.ts
git commit -m "refactor(qi): 抽 git helpers 到 src/pipeline/git-helpers.ts

为 Sub-plan D init_qi_branch 早 push 做准备。从 mr-create.ts 把 escapeShell /
normalizeProjectPath / gitPushBranch 三个 module-local helpers 移到共享模块。
mr-create.ts 现 import；后续 init_qi_branch 也将复用。
新增 9 个 pure unit tests 覆盖 escapeShell / normalizeProjectPath。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: `init_qi_branch` 加 empty commit + push origin

在 acquireWorktree + ensureBareRepo 之后，做空占位 commit + push GitLab。push 失败 warn-continue（不阻断 pipeline）。output 加 `remotePushed: boolean`。

**Files:**
- Modify: `src/pipeline/node-types/init-qi-branch.ts`
- Create: `src/__tests__/unit/node-types/init-qi-branch-push.test.ts`

### Steps

- [ ] **Step 2.1: 写失败测试**

Create `src/__tests__/unit/node-types/init-qi-branch-push.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
import '../../../pipeline/node-types/init-qi-branch.js'

vi.mock('../../../db/repositories/requirements.js', async () => ({
  getRequirementById: vi.fn(),
  setBranchAndWorktree: vi.fn(),
  setRequirementStatus: vi.fn(),
}))
vi.mock('../../../config/gitlab.js', () => ({
  resolveGitlabConfig: async () => ({ url: 'https://gitlab.test', token: 'tok' }),
}))
vi.mock('../../../quick-impl/worktree.js', async () => ({
  acquireWorktree: vi.fn(),
  countLiveWorktrees: vi.fn(),
  WORKTREE_BASE_QI: '/tmp/quick-impl',
}))
vi.mock('../../../quick-impl/qi-bare-repo.js', () => ({
  ensureBareRepo: vi.fn(),
}))
vi.mock('../../../pipeline/git-helpers.js', () => ({
  gitPushBranch: vi.fn(),
  normalizeProjectPath: (s: string) => s,
  escapeShell: (s: string) => `'${s}'`,
}))
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' })),
}))

const reqRepo = await import('../../../db/repositories/requirements.js')
const worktree = await import('../../../quick-impl/worktree.js')
const bareRepo = await import('../../../quick-impl/qi-bare-repo.js')
const helpers = await import('../../../pipeline/git-helpers.js')

describe('init_qi_branch early push to GitLab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(reqRepo.getRequirementById).mockResolvedValue({
      id: 7, title: 't', rawInput: 'x', status: 'queued',
      branch: null, baseBranch: 'main', gitlabProject: 'group/proj',
      worktreePath: null, mrUrl: null, specContent: null, planContent: null,
      pipelineRunId: 1, currentStage: null, specPath: null, planPath: null,
      abortReason: null, retryCounters: {}, source: 'web', createdBy: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    } as any)
    vi.mocked(worktree.countLiveWorktrees).mockResolvedValue(0)
    vi.mocked(worktree.acquireWorktree).mockResolvedValue({
      branch: 'feat/qi-7', path: '/tmp/quick-impl/qi-7', cachePath: '/cache/proj',
    } as any)
    vi.mocked(bareRepo.ensureBareRepo).mockResolvedValue('/tmp/bare/proj.git')
  })

  it('makes empty commit + push origin after worktree + bare repo', async () => {
    vi.mocked(helpers.gitPushBranch).mockResolvedValue(undefined)

    const exec = getExecutor('init_qi_branch')
    const result = await exec!.execute(
      { requirementId: 7 },
      { runId: 1, pipelineId: 1, nodeId: 'init_branch', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.remotePushed).toBe(true)
    expect(helpers.gitPushBranch).toHaveBeenCalledWith(
      '/tmp/quick-impl/qi-7',
      'feat/qi-7',
      'https://gitlab.test',
      'group/proj',
    )
  })

  it('warn-continue when push fails (network / auth) — status still success', async () => {
    vi.mocked(helpers.gitPushBranch).mockRejectedValue(new Error('Could not resolve host: gitlab.test'))

    const exec = getExecutor('init_qi_branch')
    const result = await exec!.execute(
      { requirementId: 7 },
      { runId: 1, pipelineId: 1, nodeId: 'init_branch', triggerParams: {}, vars: {}, steps: {} },
    )

    // node 自身依然 success（push 是 best-effort），但 output.remotePushed=false
    expect(result.status).toBe('success')
    expect(result.output.remotePushed).toBe(false)
    expect(result.output.pushError).toMatch(/Could not resolve host/)
  })

  it('makes commit with -c user.email/user.name to avoid global config dep', async () => {
    vi.mocked(helpers.gitPushBranch).mockResolvedValue(undefined)
    const cp = await import('child_process')
    const execMock = vi.mocked(cp.exec)

    const exec = getExecutor('init_qi_branch')
    await exec!.execute(
      { requirementId: 7 },
      { runId: 1, pipelineId: 1, nodeId: 'init_branch', triggerParams: {}, vars: {}, steps: {} },
    )

    // 找 commit --allow-empty 调用
    const commitCall = execMock.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('commit --allow-empty')
    )
    expect(commitCall).toBeDefined()
    expect(commitCall![0]).toContain('-c user.email=')
    expect(commitCall![0]).toContain('-c user.name=')
    expect(commitCall![0]).toMatch(/chore\(qi-7\): init branch/)
  })
})
```

- [ ] **Step 2.2: Run — expect FAIL**

```bash
npx vitest run src/__tests__/unit/node-types/init-qi-branch-push.test.ts
```

- [ ] **Step 2.3: 实现 empty commit + push 逻辑**

修改 `src/pipeline/node-types/init-qi-branch.ts`：

1. **新增 import**（在文件顶部已有 imports 附近）：

```typescript
import { gitPushBranch } from '../git-helpers.js'
```

2. **在 ensureBareRepo block 之后、`return` 之前**插入：

```typescript
    // Sub-plan D: 空占位 commit + push 到 GitLab，让开发期分支可见
    // push 失败 warn-continue（网络抖动不应阻断 init 整体 success）
    let remotePushed = false
    let pushError: string | null = null
    try {
      // 用 -c 内联 author，避免依赖全局 git config（CI / 新 worktree 可能没配）
      await execAsync(
        `git -c user.email=quick-impl@chatops -c user.name='quick-impl bot' -C ${wt.path} commit --allow-empty -m 'chore(qi-${requirementId}): init branch'`,
        { timeout: 10_000 },
      )
      await gitPushBranch(wt.path, wt.branch, gitlabUrl, gitlabProject)
      remotePushed = true
    } catch (err) {
      pushError = err instanceof Error ? err.message : String(err)
      console.warn(
        `[init_qi_branch] early push to GitLab failed (non-fatal, mr_create 会兜底): ${pushError}`,
      )
    }

    return {
      status: 'success',
      output: {
        branch: wt.branch,
        worktreePath: wt.path,
        cachePath: wt.cachePath,
        bareRepoPath,
        remotePushed,
        ...(pushError ? { pushError } : {}),
      },
    }
```

注意 `gitlabUrl` 已在函数前面 resolve 过（L73-76）。

3. **删除**原 return（L131-139）— 已被上面的新 return 替换。

- [ ] **Step 2.4: Run tests — expect PASS**

```bash
npx vitest run src/__tests__/unit/node-types/init-qi-branch-push.test.ts
./test.sh --typecheck
```

- [ ] **Step 2.5: Commit**

```bash
git add src/pipeline/node-types/init-qi-branch.ts src/__tests__/unit/node-types/init-qi-branch-push.test.ts
git commit -m "feat(qi): init_qi_branch 加空占位 commit + push GitLab（早可见）

修审计 §2.1 + §4-D.17：当前 init_qi_branch 不 push GitLab，开发期 GitLab
完全看不到此需求存在。新逻辑：
- ensureBareRepo 之后做 git commit --allow-empty -m 'chore(qi-N): init branch'
  （-c user.email/user.name 内联，避免全局 git config 依赖）
- gitPushBranch 推到 origin/feat/qi-N
- push 失败 warn-continue（network 抖动不阻断 init），output.remotePushed=false
- output 加 remotePushed + pushError 字段

abort 路径由 Sub-plan C cleanup remote_branch target 清理远端分支。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: 全套测试 + smoke verify

verify Sub-plan D 改动不破坏 Sub-plan A/B/C 任何已建测试。

### Steps

- [ ] **Step 3.1: Typecheck**

```bash
./test.sh --typecheck
```

Expected: PASS

- [ ] **Step 3.2: 相关测试套件**

```bash
npx vitest run --exclude '**/var/**' \
  src/__tests__/unit/pipeline/git-helpers \
  src/__tests__/unit/node-types/init-qi-branch-push \
  src/__tests__/unit/node-types/mr-create-idempotent \
  src/__tests__/unit/node-types/cleanup-gitlab \
  src/__tests__/unit/node-types/cleanup.test.ts \
  src/__tests__/unit/node-type-registry
```

Expected: 所有 pass。

- [ ] **Step 3.3: 可选 — 跑完整测试**

```bash
./test.sh
```

Expected: 仅 pre-existing failures（Sub-plan B Task 6 已列：quick-impl-role-contract / pipeline-node-types-repo / admin-pipeline-node-types-route / quick-impl-schema-v60 / quick-impl-worktree / web-review-waiter）。Sub-plan D 不应引入新 failures。

注：现有 `init_qi_branch` 相关测试（如 `qi-pipeline-bootstrap-v12.test.ts` / `qi-pipeline-bootstrap-v13.test.ts`）assert 节点存在不查输出 / 不查 push 行为，应该 pass。

- [ ] **Step 3.4: 不需要 commit**（仅 verify）

---

## Self-Review

- [ ] **Spec coverage**：spec §2.3 "branch_init 阶段也 push 一个空占位 commit" → Task 2 ✅。spec §5 节点 1 "建 worktree+bare repo；push 占位 commit" → Task 2 ✅。

- [ ] **Placeholder scan**：grep `TODO|TBD|implement later` 在本 plan 代码块。无。

- [ ] **Type consistency**：
  - `remotePushed: boolean` 输出字段 — 下游不消费，仅 audit 用 ✅
  - `pushError: string | undefined` — 仅失败时存在
  - gitPushBranch signature 跟 mr-create.ts 现有调用一致（4 参数）✅
  - escapeShell / normalizeProjectPath 行为不变（pure refactor）✅

- [ ] **风险**：
  - Task 1 refactor 改了 mr-create.ts 9 行 import + 删 30 行 local helpers — mr_create 现有测试（mr-create-idempotent）应 pass，因为函数语义不变
  - empty commit + push 总时间 ~1-3s（一次额外 git 操作），对 init_branch 整体 latency 影响 < 5%
  - GitLab 端 abort 后留分支垃圾，由 Sub-plan C cleanup remote_branch 处理 ✅

- [ ] **Commit message 约定**：`feat(qi): ...` / `refactor(qi): ...` 符合 commit-conventions ✅

---

## Execution Handoff

Plan 写完，保存到 `docs/superpowers/plans/2026-05-11-qi-pipeline-branch-init-push-sub-plan-d.md`。

**风险：**
- Task 1 抽 helpers 是 pure refactor — 验证手段：mr_create 现有 3 个测试（POST/PUT/409 fallback）和 cleanup 测试 仍 pass
- Task 2 push 失败 warn-continue — 设计意图：网络抖动不阻断 init，mr_create 会兜底 push；但代价是用户看不到 remotePushed=false 时的明确提示（仅日志）。trade-off 文档化在 commit message
- 真实 git config 依赖：用 `-c user.email=... -c user.name=...` 内联绕开全局 config，CI 测试不受影响

**执行选项：**

1. **Subagent-Driven（推荐）** — 每 task fresh subagent + 两阶段 review
2. **Inline 执行** — 当前 session 用 executing-plans skill 批量跑

Which approach?
