# QI Pipeline Stage Types Sub-plan A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 6 个新 stage type（llm_author / llm_review / human_gate / git_commit_push / cleanup / end）作为 QI pipeline topology 重设计的基础设施。

**Architecture:** 简单节点（git_commit_push / cleanup / end）直接通过 `registerNodeType()` 在 `src/pipeline/node-types/` 注册执行器；LLM 节点（llm_author / llm_review）和 interrupt 节点（human_gate）走「stub + graph-builder build*Node」两层结构，因为需要访问 `ctxBase.skillExecutor` / `mcpServerPath` 或调用 `interrupt()`。

**Tech Stack:** TypeScript ES2022 + NodeNext + Fastify + LangGraph + PostgreSQL（pg）+ Vitest

**Spec：** [docs/superpowers/specs/2026-05-11-qi-pipeline-topology-design.md](../specs/2026-05-11-qi-pipeline-topology-design.md)

**Out of Scope（本 plan 不涉及）：**
- QI pipeline JSON 定义改用新 stage types（→ Sub-plan B）
- mr_create 幂等改造（→ Sub-plan C）
- branch_init 占位 push 增强（→ Sub-plan D）
- 节点级 retry admin API（→ Sub-plan E）
- E2E 节点 4 拆（占位待议）

---

## File Structure

**Create:**
- `src/pipeline/node-types/end.ts` — END 显式终结节点（no-op executor）
- `src/pipeline/node-types/cleanup.ts` — 资源清理节点
- `src/pipeline/node-types/git-commit-push.ts` — 幂等 commit + push
- `src/pipeline/node-types/llm-author.ts` — LLM 生成 artifact 节点（stub）
- `src/pipeline/node-types/llm-review.ts` — LLM 审 artifact 节点（stub）
- `src/pipeline/node-types/human-gate.ts` — 人工 binary 批准节点（stub）
- `src/__tests__/unit/node-types/end.test.ts`
- `src/__tests__/unit/node-types/cleanup.test.ts`
- `src/__tests__/unit/node-types/git-commit-push.test.ts`
- `src/__tests__/unit/node-types/llm-author.test.ts`
- `src/__tests__/unit/node-types/llm-review.test.ts`
- `src/__tests__/unit/node-types/human-gate.test.ts`

**Modify:**
- `src/pipeline/node-types/index.ts` — 加 6 个新 import
- `src/pipeline/graph-builder.ts` — 加 `buildLlmAuthorNode` / `buildLlmReviewNode` / `buildHumanGateNode` 三个函数 + 在 `buildGraphFromPipeline` 的 switch 里 wire 起来

**单元测试 pattern 参考：** [src/__tests__/unit/node-type-registry.test.ts](../../../src/__tests__/unit/node-type-registry.test.ts) + 现有 `src/__tests__/unit/*.test.ts`

---

## Task 1: `end` stage type — 显式 END 节点

替代现状 `mr_create_skip` switch 自环 hack。`end` 类型节点本身不做事，graph-builder 在 wire 时把它的下游连到 LangGraph END。

**Files:**
- Create: `src/pipeline/node-types/end.ts`
- Create: `src/__tests__/unit/node-types/end.test.ts`
- Modify: `src/pipeline/node-types/index.ts`
- Modify: `src/pipeline/graph-builder.ts:buildGraphFromPipeline` switch（加 case 'end'）

### Steps

- [ ] **Step 1.1: 写失败测试**

Create `src/__tests__/unit/node-types/end.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { __resetRegistryForTesting, getExecutor, registerNodeType } from '../../../pipeline/node-types/registry.js'

describe('end node type', () => {
  beforeEach(async () => {
    __resetRegistryForTesting()
    await import('../../../pipeline/node-types/end.js')
  })

  it('registers as "end" kind', () => {
    const exec = getExecutor('end')
    expect(exec).toBeDefined()
    expect(exec?.key).toBe('end')
  })

  it('executes as success no-op', async () => {
    const exec = getExecutor('end')
    const result = await exec!.execute({}, {
      runId: 1, pipelineId: 1, nodeId: 'done',
      triggerParams: {}, vars: {}, steps: {},
    })
    expect(result.status).toBe('success')
    expect(result.output).toEqual({ terminated: true })
  })
})
```

- [ ] **Step 1.2: Run test — expect FAIL**

```bash
npx vitest run src/__tests__/unit/node-types/end.test.ts
```

Expected: FAIL — `Cannot find module 'src/pipeline/node-types/end.ts'`

- [ ] **Step 1.3: 实现 end stage type**

Create `src/pipeline/node-types/end.ts`:

```typescript
import { registerNodeType } from './registry.js'
import type { NodeExecutionResult, ExecutionContext } from './types.js'

registerNodeType({
  key: 'end',
  async execute(
    _params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    return { status: 'success', output: { terminated: true } }
  },
})
```

- [ ] **Step 1.4: 在 index.ts 注册 import**

Modify `src/pipeline/node-types/index.ts` — 在已有 import 列表底部加：

```typescript
import './end.js'
```

- [ ] **Step 1.5: 修 graph-builder 让 'end' 类型节点连到 LangGraph END**

在 `src/pipeline/graph-builder.ts:buildGraphFromPipeline` 的 stage type dispatch switch 中查找现有 `case 'switch':`、`case 'skill_with_approval':` 等模式所在位置。在所有 case 后添加：

```typescript
case 'end': {
  // 'end' 节点用现有 registerNodeType 执行器跑（no-op success）
  // graph-builder 在 wireEdges() 阶段会识别这个节点没有 outgoing edges，
  // 自动在 LangGraph 上把它连接到 END
  builder = builder.addNode(node.name, buildGenericNode(node, index, ctxBase, triggerParams))
  break
}
```

注：若 graph-builder 现有 wireEdges 逻辑已经支持「无 outgoing edges 的节点自动连 END」，则此 case 可不动；否则在 wire 出边逻辑里加：「若 node.type === 'end'，addEdge(node.name, END)」。**实现时需要先 grep `addEdge.*END` 看现状**。

- [ ] **Step 1.6: Run test — expect PASS**

```bash
npx vitest run src/__tests__/unit/node-types/end.test.ts
```

Expected: PASS

- [ ] **Step 1.7: 跑现有 node-type-registry test 不被破坏**

```bash
npx vitest run src/__tests__/unit/node-type-registry.test.ts
```

Expected: PASS（已注册节点列表新增 'end'，更新现有断言数组）

如果 node-type-registry.test.ts 的 expect-set 是 hardcoded，需要 add 'end' 进去。

- [ ] **Step 1.8: Commit**

```bash
git add src/pipeline/node-types/end.ts src/pipeline/node-types/index.ts src/pipeline/graph-builder.ts src/__tests__/unit/node-types/end.test.ts src/__tests__/unit/node-type-registry.test.ts
git commit -m "feat(pipeline): add 'end' stage type as explicit END sink

替代 mr_create_skip switch 自环 hack；'end' 节点本身 no-op success，
graph-builder 把它当 LangGraph END 处理。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: `cleanup` stage type — 资源清理

清 worktree / sandbox / remote_branch / draft_mr / bare_repo。targets 列表驱动，每个 target 独立 try-catch（一个失败不卡其他）。

**Files:**
- Create: `src/pipeline/node-types/cleanup.ts`
- Create: `src/__tests__/unit/node-types/cleanup.test.ts`
- Modify: `src/pipeline/node-types/index.ts`

### Steps

- [ ] **Step 2.1: 写失败测试**

Create `src/__tests__/unit/node-types/cleanup.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { __resetRegistryForTesting, getExecutor } from '../../../pipeline/node-types/registry.js'

describe('cleanup node type', () => {
  beforeEach(async () => {
    __resetRegistryForTesting()
    await import('../../../pipeline/node-types/cleanup.js')
  })

  it('removes worktree directory if exists', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-test-'))
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello')

    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'worktree', path: tmpDir }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.report).toMatchObject({
      cleaned: [{ kind: 'worktree', path: tmpDir, ok: true }],
      failed: [],
    })

    // 验证目录真被删
    await expect(fs.access(tmpDir)).rejects.toThrow()
  })

  it('reports failed targets but still returns success status (warn-continue)', async () => {
    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [{ kind: 'worktree', path: '/nonexistent/path/zzz123' }] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )

    // 哪怕清理失败也返回 success（warn but continue 语义）
    expect(result.status).toBe('success')
    expect(result.output.report).toMatchObject({
      cleaned: [],
      failed: [{ kind: 'worktree', ok: false }],
    })
  })

  it('handles empty targets gracefully', async () => {
    const exec = getExecutor('cleanup')
    const result = await exec!.execute(
      { targets: [] },
      { runId: 1, pipelineId: 1, nodeId: 'cleanup', triggerParams: {}, vars: {}, steps: {} },
    )
    expect(result.status).toBe('success')
    expect(result.output.report).toMatchObject({ cleaned: [], failed: [] })
  })
})
```

- [ ] **Step 2.2: Run test — expect FAIL**

```bash
npx vitest run src/__tests__/unit/node-types/cleanup.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 2.3: 实现 cleanup stage type**

Create `src/pipeline/node-types/cleanup.ts`:

```typescript
import * as fs from 'node:fs/promises'
import { registerNodeType } from './registry.js'
import type { NodeExecutionResult, ExecutionContext } from './types.js'

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

async function cleanWorktree(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

async function cleanSandbox(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

async function cleanBareRepo(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

async function cleanRemoteBranch(_project: string, _branch: string): Promise<void> {
  // TODO Sub-plan C 接入 GitLab API DELETE /projects/:id/repository/branches/:branch
  throw new Error('remote_branch cleanup pending Sub-plan C (GitLab branch delete API)')
}

async function cleanDraftMr(_project: string, _mrIid: number): Promise<void> {
  // TODO Sub-plan C 接入 GitLab API PUT /projects/:id/merge_requests/:iid (state_event=close)
  throw new Error('draft_mr cleanup pending Sub-plan C (GitLab MR close API)')
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
          case 'worktree':    await cleanWorktree(t.path);                            break
          case 'sandbox':     await cleanSandbox(t.path);                             break
          case 'bare_repo':   await cleanBareRepo(t.path);                            break
          case 'remote_branch': await cleanRemoteBranch(t.project, t.branch);         break
          case 'draft_mr':    await cleanDraftMr(t.project, t.mrIid);                 break
          default:
            report.failed.push({ ...(t as CleanupTarget), ok: false, error: 'unknown kind' })
            continue
        }
        report.cleaned.push({ ...(t as CleanupTarget), ok: true })
      } catch (err) {
        report.failed.push({
          ...(t as CleanupTarget),
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // warn-but-continue：哪怕 failed.length > 0 仍返 success，由上游决定要不要管
    return { status: 'success', output: { report } }
  },
})
```

- [ ] **Step 2.4: 在 index.ts 注册**

加 `import './cleanup.js'` 到 `src/pipeline/node-types/index.ts`。

- [ ] **Step 2.5: Run test — expect PASS**

```bash
npx vitest run src/__tests__/unit/node-types/cleanup.test.ts
```

Expected: PASS

- [ ] **Step 2.6: 更新 node-type-registry test expected set**

如果 `src/__tests__/unit/node-type-registry.test.ts` 有 hardcode set，加 'cleanup'。

- [ ] **Step 2.7: Commit**

```bash
git add src/pipeline/node-types/cleanup.ts src/pipeline/node-types/index.ts src/__tests__/unit/node-types/cleanup.test.ts src/__tests__/unit/node-type-registry.test.ts
git commit -m "feat(pipeline): add 'cleanup' stage type — worktree/sandbox/bare_repo cleanup

按 targets[] 列表清理；warn-but-continue 语义（局部失败不阻断）；
remote_branch / draft_mr targets 留给 Sub-plan C 接入 GitLab API。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `git_commit_push` stage type — 幂等 commit + push

接受 `artifactPaths` + `commitMessage`，做 `git add → commit → push origin`。已 push 过的 commit 跳过 push。

**Files:**
- Create: `src/pipeline/node-types/git-commit-push.ts`
- Create: `src/__tests__/unit/node-types/git-commit-push.test.ts`
- Modify: `src/pipeline/node-types/index.ts`

### Steps

- [ ] **Step 3.1: 探现有 git helper（先 grep）**

```bash
grep -rn "exec(\|execFile(\|spawn(\|gitPushBranch\|simpleGit" src/pipeline/node-types/mr-create.ts src/pipeline/node-types/init-qi-branch.ts | head -20
```

确认现有节点用什么调 git（`child_process.exec` / `simple-git` / 自封装）。**优先复用** `init-qi-branch.ts` / `mr-create.ts` 已有的 git 封装。

- [ ] **Step 3.2: 写失败测试**

Create `src/__tests__/unit/node-types/git-commit-push.test.ts`:

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { __resetRegistryForTesting, getExecutor } from '../../../pipeline/node-types/registry.js'

const exec = promisify(execFile)

async function makeGitRepo(): Promise<{ worktree: string; bare: string }> {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'git-cp-bare-'))
  await exec('git', ['init', '--bare', bare])
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'git-cp-wt-'))
  await exec('git', ['clone', bare, worktree])
  // 让 worktree 有初始 commit
  await fs.writeFile(path.join(worktree, 'README.md'), 'init\n')
  await exec('git', ['-C', worktree, 'add', '.'])
  await exec('git', ['-C', worktree, 'config', 'user.email', 'test@example.com'])
  await exec('git', ['-C', worktree, 'config', 'user.name', 'test'])
  await exec('git', ['-C', worktree, 'commit', '-m', 'init'])
  await exec('git', ['-C', worktree, 'push', 'origin', 'master'])
  return { worktree, bare }
}

describe('git_commit_push node type', () => {
  beforeEach(async () => {
    __resetRegistryForTesting()
    await import('../../../pipeline/node-types/git-commit-push.js')
  })

  it('commits and pushes a new file', async () => {
    const { worktree } = await makeGitRepo()
    await fs.writeFile(path.join(worktree, 'spec.md'), '# spec\n')

    const cp = getExecutor('git_commit_push')
    const result = await cp!.execute(
      {
        worktreePath: worktree,
        branch: 'master',
        artifactPaths: ['spec.md'],
        commitMessage: 'docs(qi-1): spec — test',
      },
      { runId: 1, pipelineId: 1, nodeId: 'spec_commit_push', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(result.status).toBe('success')
    expect(result.output.commitSha).toMatch(/^[a-f0-9]{40}$/)
    expect(result.output.pushedAt).toBeTruthy()
  })

  it('is idempotent: re-running on same state returns success with skipped=true', async () => {
    const { worktree } = await makeGitRepo()
    await fs.writeFile(path.join(worktree, 'spec.md'), '# spec\n')

    const cp = getExecutor('git_commit_push')
    // 第一次
    await cp!.execute(
      { worktreePath: worktree, branch: 'master', artifactPaths: ['spec.md'], commitMessage: 'docs: spec' },
      { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} },
    )
    // 第二次重跑（无新改动）
    const r2 = await cp!.execute(
      { worktreePath: worktree, branch: 'master', artifactPaths: ['spec.md'], commitMessage: 'docs: spec' },
      { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} },
    )

    expect(r2.status).toBe('success')
    expect(r2.output.skipped).toBe(true)  // 无新改动跳过
  })

  it('fails clearly when worktreePath missing', async () => {
    const cp = getExecutor('git_commit_push')
    const result = await cp!.execute(
      { branch: 'master', artifactPaths: ['spec.md'], commitMessage: 'msg' },
      { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/worktreePath/)
  })
})
```

- [ ] **Step 3.3: Run test — expect FAIL**

```bash
npx vitest run src/__tests__/unit/node-types/git-commit-push.test.ts
```

- [ ] **Step 3.4: 实现 git_commit_push**

Create `src/pipeline/node-types/git-commit-push.ts`:

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { registerNodeType } from './registry.js'
import type { NodeExecutionResult, ExecutionContext } from './types.js'

const execFileP = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileP('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 })
  return { stdout: stdout.toString(), stderr: stderr.toString() }
}

async function hasChangesToCommit(worktreePath: string, artifactPaths: string[]): Promise<boolean> {
  // 用 git status --porcelain 检查 artifactPaths 是否有 unstaged/staged 改动
  const { stdout } = await git(worktreePath, ['status', '--porcelain', '--', ...artifactPaths])
  return stdout.trim().length > 0
}

async function isHeadAheadOfRemote(worktreePath: string, branch: string): Promise<boolean> {
  // HEAD 是否有新于 origin/<branch> 的 commit
  try {
    const { stdout } = await git(worktreePath, [
      'rev-list', '--count', `origin/${branch}..HEAD`,
    ])
    return Number(stdout.trim()) > 0
  } catch {
    // origin/<branch> 不存在 → 视为 ahead（首次 push）
    return true
  }
}

registerNodeType({
  key: 'git_commit_push',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const worktreePath = String(params.worktreePath ?? '')
    const branch = String(params.branch ?? '')
    const artifactPaths = (params.artifactPaths ?? []) as string[]
    const commitMessage = String(params.commitMessage ?? '')
    const pushOnly = Boolean(params.pushOnly ?? false)  // dev_push 模式

    if (!worktreePath) return { status: 'failed', output: {}, error: 'git_commit_push: worktreePath required' }
    if (!branch)       return { status: 'failed', output: {}, error: 'git_commit_push: branch required' }
    if (!pushOnly && !commitMessage) {
      return { status: 'failed', output: {}, error: 'git_commit_push: commitMessage required (unless pushOnly)' }
    }

    try {
      let commitSha: string | null = null
      let didCommit = false

      if (!pushOnly) {
        const hasChanges = await hasChangesToCommit(worktreePath, artifactPaths)
        if (hasChanges) {
          await git(worktreePath, ['add', '--', ...artifactPaths])
          await git(worktreePath, ['commit', '-m', commitMessage])
          didCommit = true
        }
      }

      const headSha = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
      commitSha = headSha

      const needsPush = pushOnly ? true : await isHeadAheadOfRemote(worktreePath, branch)
      if (!needsPush && !didCommit) {
        // 完全幂等：无新 commit、远端已同步
        return { status: 'success', output: { commitSha, skipped: true } }
      }

      await git(worktreePath, ['push', 'origin', `HEAD:${branch}`])

      return {
        status: 'success',
        output: { commitSha, pushedAt: new Date().toISOString(), skipped: false },
      }
    } catch (err) {
      return {
        status: 'failed',
        output: {},
        error: `git_commit_push: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})
```

- [ ] **Step 3.5: 在 index.ts 注册**

加 `import './git-commit-push.js'`。

- [ ] **Step 3.6: Run test — expect PASS**

```bash
npx vitest run src/__tests__/unit/node-types/git-commit-push.test.ts
```

- [ ] **Step 3.7: Commit**

```bash
git add src/pipeline/node-types/git-commit-push.ts src/pipeline/node-types/index.ts src/__tests__/unit/node-types/git-commit-push.test.ts src/__tests__/unit/node-type-registry.test.ts
git commit -m "feat(pipeline): add 'git_commit_push' stage type — idempotent commit+push

无改动跳过 commit；HEAD 已同步 origin 跳过 push；支持 pushOnly 模式（dev_push 用）。
完全幂等，可作节点级 retry 入口。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `llm_author` stage type — LLM 生成 artifact

调 `runSkill()` 跑一轮 author role，输出 artifact 文件 + skillOutput。**不在节点内 commit**（commit 留给 git_commit_push）。

走「stub + graph-builder build*Node」结构因为需要访问 `ctxBase.skillExecutor` / `mcpServerPath`。

**Files:**
- Create: `src/pipeline/node-types/llm-author.ts` (stub)
- Create: `src/__tests__/unit/node-types/llm-author.test.ts`
- Modify: `src/pipeline/node-types/index.ts`
- Modify: `src/pipeline/graph-builder.ts` — 加 `buildLlmAuthorNode()` 函数 + 在 dispatch switch 接入

### Steps

- [ ] **Step 4.1: 阅读现有 buildSkillWithReviewNode（参考模板）**

```bash
sed -n '1813,2065p' src/pipeline/graph-builder.ts
```

理解：参数 resolution、`ctxBase.skillExecutor` 检查、`runSkill()` 调用 signature、`finishedResult()` 构造、`markStageRunning` / 状态切换约定。

- [ ] **Step 4.2: 写失败测试**

Create `src/__tests__/unit/node-types/llm-author.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { __resetRegistryForTesting, getExecutor } from '../../../pipeline/node-types/registry.js'

describe('llm_author node type stub', () => {
  beforeEach(async () => {
    __resetRegistryForTesting()
    await import('../../../pipeline/node-types/llm-author.js')
  })

  it('registers as "llm_author" kind', () => {
    const exec = getExecutor('llm_author')
    expect(exec).toBeDefined()
    expect(exec?.key).toBe('llm_author')
  })

  it('stub executor throws (interrupt-bound, must use graph-builder)', async () => {
    const exec = getExecutor('llm_author')
    await expect(
      exec!.execute({}, { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} }),
    ).rejects.toThrow(/graph-builder/)
  })
})

// buildLlmAuthorNode 的单测放在 src/__tests__/unit/graph-builder-llm-author.test.ts
// （需要 mock SkillExecutor）
```

- [ ] **Step 4.3: Run — expect FAIL**

```bash
npx vitest run src/__tests__/unit/node-types/llm-author.test.ts
```

- [ ] **Step 4.4: 实现 stub 文件**

Create `src/pipeline/node-types/llm-author.ts`:

```typescript
import { registerNodeType } from './registry.js'

registerNodeType({
  key: 'llm_author',
  async execute() {
    throw new Error(
      'llm_author must be invoked via graph-builder (buildLlmAuthorNode). See src/pipeline/graph-builder.ts.',
    )
  },
})
```

- [ ] **Step 4.5: 在 index.ts 注册**

加 `import './llm-author.js'`。

- [ ] **Step 4.6: Run stub test — expect PASS**

```bash
npx vitest run src/__tests__/unit/node-types/llm-author.test.ts
```

- [ ] **Step 4.7: 实现 buildLlmAuthorNode（参考 buildSkillWithReviewNode 拆出 author 部分）**

在 `src/pipeline/graph-builder.ts` 加新函数（建议放在 buildSkillWithReviewNode 之后）：

```typescript
function buildLlmAuthorNode(
  node: PipelineNode,
  index: number,
  ctxBase: StageContextBase,
  triggerParams: Record<string, unknown>,
) {
  return async (state: typeof PipelineStateAnnotation.State) => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const stageName = nodeStageResultName(node)
    await markStageRunning(ctxBase.runId, { ...node, name: stageName }, startedAt)

    const rawParams = ((node as unknown as { params?: Record<string, unknown> }).params ?? {})
    const varCtx = buildVariableContext(state, ctxBase, triggerParams, node, index)
    let params: Record<string, unknown>
    try {
      params = renderParamTemplates(rawParams, varCtx)
    } catch (err) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, `llm_author param resolve failed: ${String(err)}`)
    }

    if (!ctxBase.skillExecutor) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, 'llm_author: skillExecutor not configured', 'no_skill_executor')
    }

    const requirementId = Number(params.requirementId ?? triggerParams?.requirementId)
    const skill = String(params.skill ?? '')
    const role = String(params.role ?? '')
    const worktreePath = String(params.worktreePath ?? '')
    const branch = String(params.branch ?? '')
    const baseBranch = String(params.baseBranch ?? 'main')
    const artifactPath = String(params.artifactPath ?? '')

    if (!requirementId) return finishStageWithError(node, index, stageName, startedAt, startedMs, 'llm_author: requirementId required')
    if (!skill || !role) return finishStageWithError(node, index, stageName, startedAt, startedMs, 'llm_author: skill+role required')
    if (!worktreePath || !branch || !artifactPath) return finishStageWithError(node, index, stageName, startedAt, startedMs, 'llm_author: worktreePath/branch/artifactPath required')

    // round + 上轮 notes 从 graph state 拿
    const round = computeRoundFromState(state, node.name)  // 见下文 helper
    const priorReviewerNotes = readPriorNotes(state, node.name, 'reviewer')
    const priorHumanNotes = readPriorNotes(state, node.name, 'human')

    const inputs: Record<string, unknown> = {
      round,
      priorReviewerNotes,
      priorHumanNotes,
      ...(params.inputs as Record<string, unknown> ?? {}),
    }

    try {
      const result = await runSkill(
        {
          requirementId,
          nodeId: `${node.name}:r${round}`,
          skill, role, worktreePath, branch, baseBranch, artifactPath,
          inputs,
          specSources: params.specSources as undefined,
          previousRound: round > 1 ? { reviewerNotes: priorReviewerNotes, humanNotes: priorHumanNotes } : undefined,
        },
        ctxBase.skillExecutor,
        ctxBase.mcpServerPath,
      )

      if (result.output.decision === 'fail') {
        return finishStageWithError(node, index, stageName, startedAt, startedMs, `llm_author generator failed: ${result.output.reason ?? 'unknown'}`)
      }

      const exec: StageExecutionResult = {
        status: 'success',
        output: {
          artifactPath,
          skillOutput: result.output,
          round,
        },
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    } catch (err) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, `llm_author runtime: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// 辅助函数：从 state 累计的 stageResults 中算当前是第几轮
function computeRoundFromState(state: typeof PipelineStateAnnotation.State, nodeName: string): number {
  const past = (state.stageResults ?? []).filter(r => r.name === nodeStageResultName({ name: nodeName } as PipelineNode))
  return past.length + 1
}

// 辅助函数：从 state 中找上一轮 ai_review / human_gate 节点的 notes
function readPriorNotes(
  state: typeof PipelineStateAnnotation.State,
  authorNodeName: string,
  kind: 'reviewer' | 'human',
): string | null {
  // 约定：state.stageResults 里 ai_review/human_gate 节点输出 { decision, notes } 字段；
  // 遍历倒数找最新的同 phase 的对应节点。实现时按 phase prefix 匹配（如 spec_ai_review 对 spec_author）。
  const phasePrefix = authorNodeName.replace(/_author$/, '')
  const targetNodeName = kind === 'reviewer' ? `${phasePrefix}_ai_review` : `${phasePrefix}_human_gate`
  for (let i = (state.stageResults ?? []).length - 1; i >= 0; i--) {
    const r = (state.stageResults ?? [])[i]
    if (r.name === nodeStageResultName({ name: targetNodeName } as PipelineNode)) {
      return (r.output as { notes?: string })?.notes ?? null
    }
  }
  return null
}
```

注：`finishStageWithError` 是建议抽出的 helper（替代重复的 `return { currentStageIndex, stageResults: finishedResult(...) }` 错误路径，5 处以上重复）。**第一次出现时直接 inline 即可**，不必为这个 plan task 重构所有错误路径。

- [ ] **Step 4.8: 在 graph-builder dispatch switch 注册 llm_author**

找到 `buildGraphFromPipeline` 函数里的 stage type dispatch switch（约 L2139+），添加：

```typescript
case 'llm_author': {
  builder = builder.addNode(node.name, buildLlmAuthorNode(node, index, ctxBase, triggerParams))
  break
}
```

- [ ] **Step 4.9: 加 buildLlmAuthorNode 单测**

Create `src/__tests__/unit/graph-builder-llm-author.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
// 注：buildLlmAuthorNode 未 export，测试需 export 出来或通过 buildGraphFromPipeline 间接测
// 推荐方案：在 graph-builder.ts 加 `export { buildLlmAuthorNode }` 仅供测试访问

import { buildLlmAuthorNode } from '../../pipeline/graph-builder.js'

describe('buildLlmAuthorNode', () => {
  it('calls runSkill with correct role + inputs (round 1)', async () => {
    const skillExecutor = {
      execute: vi.fn(async () => ({
        success: true,
        text: '',
        usage: { input_tokens: 0, output_tokens: 0 },
      })),
    }

    const node = {
      name: 'spec_author',
      type: 'llm_author' as const,
      params: {
        requirementId: 42,
        skill: 'quick-impl-artifact-author',
        role: 'spec-author',
        worktreePath: '/tmp/worktree',
        branch: 'feat/qi-42',
        baseBranch: 'main',
        artifactPath: 'docs/specs/qi-42.md',
      },
    }
    const ctxBase = {
      runId: 100, pipelineId: 1,
      skillExecutor,
      mcpServerPath: '/path/to/mcp-server.ts',
      // ... 其它必要字段
    } as any

    const fn = buildLlmAuthorNode(node as any, 0, ctxBase, {})
    const state = { stageResults: [], currentStageIndex: -1 } as any

    // 因 runSkill 内部依赖 DB，需 mock runSkill 或用 fake skillExecutor 完全屏蔽
    // 这个 test 主要验证 build 函数本身的入参 wiring，不验证 runSkill 内部

    // ... assertion
  })

  // 更复杂场景：round 2+ 注入 priorReviewerNotes
  // 略
})
```

这个单测对 graph-builder 函数本身复杂度比较高，**建议先把端到端集成测试放 Task 7**，本 step 只写一个最小 smoke test 验证 stub-stub 注册，详细 buildLlmAuthorNode 路径用 Task 7 集成测试覆盖。

- [ ] **Step 4.10: Run smoke + integration**

```bash
npx vitest run src/__tests__/unit/node-types/llm-author.test.ts
```

确保不破坏现有 `node-type-registry` 全套测试。

- [ ] **Step 4.11: Commit**

```bash
git add src/pipeline/node-types/llm-author.ts src/pipeline/node-types/index.ts src/pipeline/graph-builder.ts src/__tests__/unit/node-types/llm-author.test.ts src/__tests__/unit/node-type-registry.test.ts
git commit -m "feat(pipeline): add 'llm_author' stage type — LLM 写 artifact（不 commit）

Stub 注册 + graph-builder.buildLlmAuthorNode 实现；round/priorNotes 从 graph state 计算；
artifact 文件由 LLM 写，commit 责任移交后续 git_commit_push 节点。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `llm_review` stage type — LLM 审 artifact

调 `runSkill()` 跑 reviewer role，输出 `{decision: 'pass'|'fail', notes, specCoverage?}`。

**Files:**
- Create: `src/pipeline/node-types/llm-review.ts` (stub)
- Create: `src/__tests__/unit/node-types/llm-review.test.ts`
- Modify: `src/pipeline/node-types/index.ts`
- Modify: `src/pipeline/graph-builder.ts` — 加 `buildLlmReviewNode()`

### Steps

- [ ] **Step 5.1: 写 stub 单测**

Create `src/__tests__/unit/node-types/llm-review.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { __resetRegistryForTesting, getExecutor } from '../../../pipeline/node-types/registry.js'

describe('llm_review node type stub', () => {
  beforeEach(async () => {
    __resetRegistryForTesting()
    await import('../../../pipeline/node-types/llm-review.js')
  })

  it('registers as "llm_review" kind', () => {
    expect(getExecutor('llm_review')?.key).toBe('llm_review')
  })

  it('stub throws on direct execute', async () => {
    await expect(
      getExecutor('llm_review')!.execute({}, { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} }),
    ).rejects.toThrow(/graph-builder/)
  })
})
```

- [ ] **Step 5.2: Run — expect FAIL**

```bash
npx vitest run src/__tests__/unit/node-types/llm-review.test.ts
```

- [ ] **Step 5.3: 实现 stub**

Create `src/pipeline/node-types/llm-review.ts`:

```typescript
import { registerNodeType } from './registry.js'

registerNodeType({
  key: 'llm_review',
  async execute() {
    throw new Error(
      'llm_review must be invoked via graph-builder (buildLlmReviewNode). See src/pipeline/graph-builder.ts.',
    )
  },
})
```

- [ ] **Step 5.4: 在 index.ts 注册**

加 `import './llm-review.js'`。

- [ ] **Step 5.5: 实现 buildLlmReviewNode**

在 `src/pipeline/graph-builder.ts` 添加（在 buildLlmAuthorNode 之后）：

```typescript
function buildLlmReviewNode(
  node: PipelineNode,
  index: number,
  ctxBase: StageContextBase,
  triggerParams: Record<string, unknown>,
) {
  return async (state: typeof PipelineStateAnnotation.State) => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const stageName = nodeStageResultName(node)
    await markStageRunning(ctxBase.runId, { ...node, name: stageName }, startedAt)

    const rawParams = ((node as unknown as { params?: Record<string, unknown> }).params ?? {})
    const varCtx = buildVariableContext(state, ctxBase, triggerParams, node, index)
    let params: Record<string, unknown>
    try {
      params = renderParamTemplates(rawParams, varCtx)
    } catch (err) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, `llm_review param resolve failed: ${String(err)}`)
    }

    if (!ctxBase.skillExecutor) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, 'llm_review: skillExecutor not configured')
    }

    const requirementId = Number(params.requirementId ?? triggerParams?.requirementId)
    const skill = String(params.skill ?? '')
    const role = String(params.role ?? '')
    const worktreePath = String(params.worktreePath ?? '')
    const branch = String(params.branch ?? '')
    const baseBranch = String(params.baseBranch ?? 'main')
    const artifactPath = String(params.artifactPath ?? '')

    if (!requirementId || !skill || !role || !worktreePath || !artifactPath) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, 'llm_review: missing required params (requirementId/skill/role/worktreePath/artifactPath)')
    }

    const round = computeRoundFromState(state, node.name)

    try {
      const result = await runSkill(
        {
          requirementId,
          nodeId: `${node.name}:r${round}`,
          skill, role, worktreePath, branch, baseBranch, artifactPath,
          inputs: {
            round,
            ...(params.inputs as Record<string, unknown> ?? {}),
          },
          specSources: params.specSources as undefined,
        },
        ctxBase.skillExecutor,
        ctxBase.mcpServerPath,
      )

      const decision = (result.output.decision === 'pass' || result.output.decision === 'fail')
        ? result.output.decision
        : 'fail'  // 默认保守 → fail，由上游路由进 escalation

      const exec: StageExecutionResult = {
        status: 'success',  // review 本身完成视为 success；fail decision 通过 output 字段表达
        output: {
          decision,
          notes: result.output.notes ?? '',
          specCoverage: result.output.specCoverage ?? null,
          round,
        },
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    } catch (err) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, `llm_review runtime: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
```

- [ ] **Step 5.6: 在 dispatch switch 接入**

```typescript
case 'llm_review': {
  builder = builder.addNode(node.name, buildLlmReviewNode(node, index, ctxBase, triggerParams))
  break
}
```

- [ ] **Step 5.7: Run test — expect PASS**

```bash
npx vitest run src/__tests__/unit/node-types/llm-review.test.ts
```

- [ ] **Step 5.8: Commit**

```bash
git add src/pipeline/node-types/llm-review.ts src/pipeline/node-types/index.ts src/pipeline/graph-builder.ts src/__tests__/unit/node-types/llm-review.test.ts src/__tests__/unit/node-type-registry.test.ts
git commit -m "feat(pipeline): add 'llm_review' stage type — LLM 审 artifact

Stub + graph-builder.buildLlmReviewNode；output.decision (pass/fail) 通过 graph 边路由表达，
review 节点本身永远 success status（除非 LLM 调用层失败）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: `human_gate` stage type — 人工 binary 批准 (interrupt-bound)

push IM/Web 卡片，调 LangGraph `interrupt()` 等审。input.source ∈ {ai_pass, ai_escalation, final} 决定渲染细节，决策类型与下游一致。

**Files:**
- Create: `src/pipeline/node-types/human-gate.ts` (stub)
- Create: `src/__tests__/unit/node-types/human-gate.test.ts`
- Modify: `src/pipeline/node-types/index.ts`
- Modify: `src/pipeline/graph-builder.ts` — 加 `buildHumanGateNode()` (含 interrupt)

### Steps

- [ ] **Step 6.1: 阅读 buildSkillWithApprovalNode 现有 interrupt 机制**

```bash
sed -n '1158,1300p' src/pipeline/graph-builder.ts
```

理解：
- `interrupt({ type: QI_APPROVAL_INTERRUPT, waiterId, ... })` 暂停 graph
- `createWaiter()` 建 DB waiter 记录 + 推 IM 卡片
- `resumeFromQiApproval(waiterId, claimedWaiter)` 从外部恢复

- [ ] **Step 6.2: 写 stub 单测**

Create `src/__tests__/unit/node-types/human-gate.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { __resetRegistryForTesting, getExecutor } from '../../../pipeline/node-types/registry.js'

describe('human_gate node type stub', () => {
  beforeEach(async () => {
    __resetRegistryForTesting()
    await import('../../../pipeline/node-types/human-gate.js')
  })

  it('registers as "human_gate" kind', () => {
    expect(getExecutor('human_gate')?.key).toBe('human_gate')
  })

  it('stub throws on direct execute', async () => {
    await expect(
      getExecutor('human_gate')!.execute({}, { runId: 1, pipelineId: 1, nodeId: 'x', triggerParams: {}, vars: {}, steps: {} }),
    ).rejects.toThrow(/graph-builder/)
  })
})
```

- [ ] **Step 6.3: Run — expect FAIL**

- [ ] **Step 6.4: 实现 stub**

Create `src/pipeline/node-types/human-gate.ts`:

```typescript
import { registerNodeType } from './registry.js'

registerNodeType({
  key: 'human_gate',
  async execute() {
    throw new Error(
      'human_gate is interrupt-bound: must be invoked via graph-builder (buildHumanGateNode). See src/pipeline/graph-builder.ts.',
    )
  },
})
```

- [ ] **Step 6.5: 在 index.ts 注册**

加 `import './human-gate.js'`。

- [ ] **Step 6.6: 实现 buildHumanGateNode**

在 `src/pipeline/graph-builder.ts` 添加（位置：在 buildSkillWithApprovalNode 后）：

```typescript
function buildHumanGateNode(
  node: PipelineNode,
  index: number,
  ctxBase: StageContextBase,
  triggerParams: Record<string, unknown>,
) {
  return async (state: typeof PipelineStateAnnotation.State) => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const stageName = nodeStageResultName(node)
    await markStageRunning(ctxBase.runId, { ...node, name: stageName }, startedAt)

    const rawParams = ((node as unknown as { params?: Record<string, unknown> }).params ?? {})
    const varCtx = buildVariableContext(state, ctxBase, triggerParams, node, index)
    let params: Record<string, unknown>
    try {
      params = renderParamTemplates(rawParams, varCtx)
    } catch (err) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, `human_gate param resolve failed: ${String(err)}`)
    }

    const requirementId = Number(params.requirementId ?? triggerParams?.requirementId)
    if (!requirementId) {
      return finishStageWithError(node, index, stageName, startedAt, startedMs, 'human_gate: requirementId required')
    }

    // 关键配置（按 §4 stage type contract）
    const mode = (params.mode === 'required' || params.mode === 'on_fail') ? params.mode : 'required'
    const timeoutSeconds = Number(params.timeoutSeconds ?? 86400)
    const onTimeout = (params.onTimeout === 'approve' || params.onTimeout === 'reject') ? params.onTimeout : 'reject'

    // 入边上下文（由上游 ai_review / 路由器塞进来）
    const source = String(params.source ?? 'ai_pass') as 'ai_pass' | 'ai_escalation' | 'final'
    const artifact = params.artifact ?? {}
    const aiReview = params.aiReview ?? null
    const aiAttempts = Number(params.aiAttempts ?? 0)

    // on_fail 模式 + ai_pass source → 节点该被边短路（不应该到这），但兜底直接 approve 放行
    if (mode === 'on_fail' && source === 'ai_pass') {
      const exec: StageExecutionResult = {
        status: 'success',
        output: { decision: 'approved', humanNotes: null, autoBypass: true },
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    // 复用 createWaiter（已有 IM 卡片 push 逻辑）但传 escalation 上下文
    // 注意：existing approval-manager 假设 decisionSet 是预定义集，需要确认是否要复用 'spec_human_approval' 等现有 decisionSet
    // 或新增 'human_gate' 通用 decisionSet（approve/reject 二元）

    const existingWaiter = await getWaiterByNodeAndRound(requirementId, node.name, 1, ctxBase.runId)
    let waiterRow: RequirementApprovalWaiter

    if (!existingWaiter) {
      waiterRow = await createWaiter({
        requirementId,
        runId: ctxBase.runId,
        nodeId: node.name,
        round: 1,
        decisionSet: 'human_gate',  // 新 decisionSet，需在 approval-resolvers 注册（见 step 6.7）
        approverIds: params.approverIds as string[] ?? [],
        contextSummary: {
          source,
          artifact,
          aiReview,
          aiAttempts,
        },
        timeoutSeconds,
        onTimeout,
      })
    } else {
      waiterRow = existingWaiter
    }

    // 推 IM 卡片（按 source 渲染）
    await sendHumanGateImCard(waiterRow, { source, artifact, aiReview, aiAttempts })

    // 暂停 graph 等待人审
    const resumeValue = await interrupt({
      type: QI_APPROVAL_INTERRUPT,
      waiterId: waiterRow.id,
      runId: ctxBase.runId,
      nodeId: node.name,
      round: 1,
      approvalKind: 'human_gate',
      decisionSet: 'human_gate',
      contextSummary: { source, artifact, aiReview, aiAttempts },
    })

    if (!resumeValue) {
      // 中止或超时
      const exec: StageExecutionResult = {
        status: 'failed',
        output: { decision: onTimeout === 'approve' ? 'approved' : 'rejected', autoDecidedReason: 'timeout' },
        error: 'human_gate: interrupted without decision (timeout or abort)',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    const claimedWaiter = (resumeValue as QiApprovalResume).claimedWaiter
    const decision = claimedWaiter.decision === 'approved' ? 'approved' : 'rejected'

    const exec: StageExecutionResult = {
      status: 'success',
      output: {
        decision,
        humanNotes: claimedWaiter.humanNote ?? null,
        source,
      },
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
    }
  }
}
```

- [ ] **Step 6.7: 注册 `human_gate` decisionSet 到 approval-resolvers**

```bash
grep -n "decisionSet\|spec_human_approval\|plan_escalation" src/pipeline/approval-resolvers.ts | head -20
```

参考现有 `spec_human_approval` 的 entries，添加 `human_gate` decisionSet（binary approved/rejected，含 humanNote）。

具体改动需要根据 approval-resolvers.ts 的结构定（不在本 plan 内细写），核心是：
- decisionSet 名 `human_gate`
- 决策枚举 ['approved', 'rejected']
- 必填 humanNote on 'rejected'

- [ ] **Step 6.8: 实现 sendHumanGateImCard（按 source 渲染）**

```bash
grep -n "sendImCard\|sendApprovalImCard\|spec_human" src/pipeline/qi-approval-manager.ts src/pipeline/approval-manager.ts | head
```

参考现有 spec/plan/dev approval 的 IM 卡片渲染逻辑，加 `sendHumanGateImCard(waiter, ctx)`：

- `source === 'ai_pass'`：卡片标题"请审核 spec/plan/dev"，主体展示 artifact 摘要 + AI review notes（如果有）
- `source === 'ai_escalation'`：卡片标题"⚠️ AI review 多轮未通过，需人工裁决"，主体展示 AI 历轮 notes + attempts
- `source === 'final'`：卡片标题"最终批准 — 即将创建 MR"，主体展示 spec/plan/dev/e2e 全摘要

具体在 `src/pipeline/im-notifier.ts` 或 `src/pipeline/qi-approval-manager.ts` 加 `sendHumanGateImCard()` helper，模板抄自现有 spec_human_gate 的实现（grep `spec_human_approval` 找现状）。

- [ ] **Step 6.9: 在 dispatch switch 接入**

```typescript
case 'human_gate': {
  builder = builder.addNode(node.name, buildHumanGateNode(node, index, ctxBase, triggerParams))
  break
}
```

- [ ] **Step 6.10: Run unit + integration test**

```bash
npx vitest run src/__tests__/unit/node-types/human-gate.test.ts
```

Expected: PASS（仅 stub 注册测试，interrupt 路径用 Task 7 集成测试覆盖）

- [ ] **Step 6.11: Commit**

```bash
git add src/pipeline/node-types/human-gate.ts src/pipeline/node-types/index.ts src/pipeline/graph-builder.ts src/pipeline/approval-resolvers.ts src/pipeline/qi-approval-manager.ts src/__tests__/unit/node-types/human-gate.test.ts src/__tests__/unit/node-type-registry.test.ts
git commit -m "feat(pipeline): add 'human_gate' stage type — interrupt-bound 人审节点

Stub + graph-builder.buildHumanGateNode (LangGraph interrupt)；
mode=required/on_fail 两模式；source=ai_pass/ai_escalation/final 决定 IM 卡片渲染；
on_fail+ai_pass 边路由短路；新增 'human_gate' decisionSet。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: 端到端集成测试 — 6 个新 stage type 串通

用最小 graph 验证：`end / cleanup / git_commit_push / llm_author / llm_review / human_gate` 都能在 graph-builder 里 wire 起来、跑通典型路径。

**Files:**
- Create: `src/__tests__/integration/new-stage-types-smoke.test.ts`

### Steps

- [ ] **Step 7.1: 写集成测试**

Create `src/__tests__/integration/new-stage-types-smoke.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { buildGraphFromPipeline } from '../../pipeline/graph-builder.js'
import { getCheckpointer } from '../../pipeline/graph-runtime.js'

// 注：这是 smoke 集成测试，验证「6 个新 stage type 能在 graph-builder 中被识别 + addNode + 不抛错」。
// 不验证 LLM 调用或人审 interrupt 端到端（那需要更复杂 mock）。

describe('new stage types smoke', () => {
  beforeAll(async () => {
    await resetTestDb()
  })

  it('builds a graph using all 6 new stage types without throwing', async () => {
    const fakeSkillExecutor = {
      execute: async () => ({
        success: true,
        text: '{"decision":"pass","notes":"ok"}',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    }

    const pipeline = {
      id: 1,
      name: 'smoke',
      nodes: [
        { name: 'start',         type: 'script',          params: { command: 'echo start' } },
        { name: 'spec_author',   type: 'llm_author',      params: { requirementId: 1, skill: 'qi', role: 'spec-author', worktreePath: '/tmp', branch: 'm', artifactPath: 'spec.md' } },
        { name: 'spec_ai_review',type: 'llm_review',      params: { requirementId: 1, skill: 'qi', role: 'spec-reviewer', worktreePath: '/tmp', branch: 'm', artifactPath: 'spec.md' } },
        { name: 'spec_human',    type: 'human_gate',      params: { requirementId: 1, mode: 'required', timeoutSeconds: 3600 } },
        { name: 'spec_push',     type: 'git_commit_push', params: { worktreePath: '/tmp', branch: 'm', artifactPaths: ['spec.md'], commitMessage: 'docs: spec' } },
        { name: 'cleanup',       type: 'cleanup',         params: { targets: [] } },
        { name: 'done',          type: 'end',             params: {} },
      ],
      edges: [
        { from: 'start',          to: 'spec_author' },
        { from: 'spec_author',    to: 'spec_ai_review' },
        { from: 'spec_ai_review', to: 'spec_human' },
        { from: 'spec_human',     to: 'spec_push' },
        { from: 'spec_push',      to: 'cleanup' },
        { from: 'cleanup',        to: 'done' },
      ],
    }

    const ctxBase = {
      runId: 9999,
      pipelineId: 1,
      skillExecutor: fakeSkillExecutor,
      mcpServerPath: '/dev/null',
    } as any

    // 关键断言：build 函数不抛错
    expect(() => buildGraphFromPipeline(pipeline as any, ctxBase, {})).not.toThrow()
  })
})
```

- [ ] **Step 7.2: 跑 smoke**

```bash
npx vitest run src/__tests__/integration/new-stage-types-smoke.test.ts
```

Expected: PASS

- [ ] **Step 7.3: 跑全套 typecheck + 全套测试确保没回归**

```bash
./test.sh --typecheck
./test.sh  # 完整跑一次（200s+）
```

Expected: 全 PASS，新加节点不影响现有 pipeline。

- [ ] **Step 7.4: Commit**

```bash
git add src/__tests__/integration/new-stage-types-smoke.test.ts
git commit -m "test(pipeline): smoke integration test for 6 new stage types

验证 end/cleanup/git_commit_push/llm_author/llm_review/human_gate 能在 graph-builder
里被识别、addNode、不抛错。LLM/人审端到端覆盖留给 Sub-plan B 集成时补全。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review

完成所有 task 后做自查：

- [ ] **Spec coverage**：spec §4 列出 11 个标准 stage type。本 plan 实现了其中 6 个（end / cleanup / git_commit_push / llm_author / llm_review / human_gate）。其余 5 个（branch_init 增强 / mr_create_or_update / human_intervention / e2e_* / switch）属于其他 sub-plan 或保持现状。✅
- [ ] **Placeholder scan**：grep `TODO|TBD|implement later` 在本 plan 的代码块里。仅在 cleanup.ts 的 remote_branch/draft_mr 两个 target 留了 explicit TODO 指向 Sub-plan C，**已 explicit 说明**，不算 placeholder。
- [ ] **Type consistency**：
  - `decision` 在 llm_review output 是 'pass'/'fail'，在 human_gate output 是 'approved'/'rejected' — 跟 spec §4.1 一致 ✅
  - `source` 在 human_gate 是 'ai_pass'/'ai_escalation'/'final' — 跟 spec §4.1 一致 ✅
- [ ] **跨 task 引用**：Task 4 / 5 的 `runSkill` / `finishedResult` / `nodeStageResultName` / `markStageRunning` 等 helper 在 graph-builder.ts 已存在，无需新建 ✅
- [ ] **Commit message 约定**：所有 commit 用 `feat(pipeline): ...` 前缀，符合现仓 commit-conventions ✅

---

## Execution Handoff

Plan 写完，保存到 `docs/superpowers/plans/2026-05-11-qi-pipeline-stage-types-sub-plan-a.md`。

执行选项：

1. **Subagent-Driven（推荐）** — 我每 task dispatch 一个 fresh subagent，task 间复审，快速迭代
2. **Inline 执行** — 在本 session 用 executing-plans skill 批量执行，checkpoint 处给你看

哪种？
