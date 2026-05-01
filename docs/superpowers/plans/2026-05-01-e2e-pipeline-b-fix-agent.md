# E2E Pipeline B — e2e-fix llm_agent 节点 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 e2e-fix llm_agent 节点：AI 自动读取失败证据、定位根因、修改代码、commit + push 到 iteration_branch，输出结构化诊断结果。

**Architecture:** 创建专用 skill `~/.claude/skills/e2e-fix/SKILL.md`，基于 `debug-fix` skill 改写为无人交互的自动化版本，包含证据读取→根因分析→TDD-lite 复现→修复→验证→commit→JSON 输出全流程；`runner.ts` 读取该 skill 文件内容作为 systemPrompt 传给 `claude-runner.ts` 的 `executeCapabilityDirect` dockerExec 调用。

**Tech Stack:** TypeScript, claude-runner.ts（已有），Vitest

**前置条件:** Pipeline A 基础设施计划全部完成（claude-runner dockerExec、DB repositories）

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `~/.claude/skills/e2e-fix/SKILL.md` |
| 新建 | `src/agent/e2e-fix/runner.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/e2e-fix-agent.ts` |
| 新建 | `src/__tests__/unit/e2e-fix-runner.test.ts` |
| 新建 | `src/__tests__/unit/e2e-fix-agent-node.test.ts` |

**关键路径说明：**
- Skill 文件安装在 `~/.claude/skills/e2e-fix/SKILL.md`（宿主机，ChatOps 进程同一台机器）
- `runner.ts` 通过 `path.join(os.homedir(), '.claude/skills/e2e-fix/SKILL.md')` 读取内容，作为 `systemPrompt` 传给 `executeCapabilityDirect`
- Claude CLI 通过 `docker exec` 在沙盒容器内运行，systemPrompt 在 claude-runner 侧通过 wrapper 脚本或 `--system-prompt` 参数注入

---

### Task 1: 创建 e2e-fix skill

**Files:**
- 新建: `~/.claude/skills/e2e-fix/SKILL.md`

基于 `~/.claude/skills/debug-fix/SKILL.md` 改写：去掉所有"STOP FOR CONFIRMATION"人工门禁（Phase 4 / 7 / 10 / 11 / 15），合并为全自动化流程，补充 e2e 专用的证据读取和 `test.sh` 集成。

- [ ] **Step 1: 创建 skill 目录和文件**

```bash
mkdir -p ~/.claude/skills/e2e-fix
```

写入 `~/.claude/skills/e2e-fix/SKILL.md`：

```markdown
---
name: e2e-fix
description: Use when an automated E2E test scenario has failed in a sandbox and you need to diagnose and fix the product bug without human interaction. You are running autonomously inside a Docker container with Read, Edit, and Bash tools.
---

# E2E Automated Fix

## Overview

You are an automated bug-fix agent running inside a sandboxed Docker container.
A test scenario has failed. Your job: diagnose the root cause, fix the product code,
commit the fix to the iteration branch — all without human interaction.

**Core principle (from debug-fix):** Find root cause before touching code. Symptom fixes are failure.

**You will receive in your first user message:**
- `scenarioId` — the failing scenario ID
- `evidenceDir` — path to evidence directory (contains `manifest.json` + `artifacts/`)
- `iterationBranch` — the git branch to commit the fix on

**Your final output MUST be a single JSON line as the very last line:**
```json
{"success":true,"commitSha":"<sha>","verdict":"product_bug","rootCauseSummary":"<one sentence>","fixedFiles":["src/..."],"failureReason":""}
```

---

## Phase 1: Read the Evidence

Read `<evidenceDir>/manifest.json` first. Note:
- `summary` — failure description
- `contextHint` — what kind of system this is, what to focus on
- `artifacts` — list of evidence files

Then read each artifact:
- `text/*` artifacts: use Read tool; for large logs focus on ERROR/PANIC/FATAL/Exception lines and the tail
- `image/*` artifacts: use Read tool (vision) — look for visible error states
- `application/json`: read directly

**From debug-fix Phase 1:** Don't skip past errors. Read stack traces completely. Note line numbers, file paths, error codes.

---

## Phase 2: Investigate the Code

1. Use Bash (grep/find) + Read to locate code paths mentioned in the evidence
2. Check recent changes: `git log --oneline -20`
3. For each suspect file: `git diff HEAD~10..HEAD -- <file>` to see what changed
4. **Form a single hypothesis:** "I think X is the root cause because Y"
   - Be specific, not vague
   - Focus on what *changed*, not what has always been there

**From debug-fix Phase 3:** One hypothesis at a time. If your first hypothesis is refuted by evidence, form a new one with fresh information — don't pile additional guesses on top of a failed one.

---

## Phase 3: Reproduce (TDD-lite)

Run the failing scenario to confirm you can reproduce it:

```bash
./test.sh --scenario <scenarioId> --evidence-dir=<evidenceDir>-repro
```

Parse the last JSON line: `{"result":"pass|fail|error|timeout","summary":"...","duration_ms":...}`

**If result == "pass":** The failure was transient.
→ Set `verdict=test_flakiness`, `success=false`
→ Skip to Phase 7, output JSON and stop.

**If result == "fail" or "error":** Reproduction confirmed. Proceed to Phase 4.

**If result == "timeout":** Likely infra issue.
→ Set `verdict=infra_issue`, `success=false`
→ Skip to Phase 7, output JSON and stop.

---

## Phase 4: Fix the Code

Edit the minimum set of files necessary to fix the confirmed root cause.

**Rules (from debug-fix):**
- Fix the root cause, not just the symptom
- One file at a time, within the confirmed scope
- Do NOT modify test files (`*.spec.ts`, `*.test.ts`)
- Do NOT add TODO comments
- Do NOT change unrelated code
- No "while I'm here" cleanup

---

## Phase 5: Verify the Fix

Run the scenario again:

```bash
./test.sh --scenario <scenarioId> --evidence-dir=<evidenceDir>-verify
```

**If result == "pass":** Fix works. Proceed to Phase 6.

**If result != "pass" (first fix attempt):** Assess:
- Evidence points to a different cause → form new hypothesis, go back to Phase 4 (one more attempt only)
- Evidence shows infrastructure problem → `verdict=infra_issue`, `success=false`, skip to Phase 7

**If result != "pass" (second fix attempt):**
→ `verdict=uncertain`, `success=false`, skip to Phase 7.
→ Do NOT make a third fix attempt.

---

## Phase 6: Commit and Push

```bash
git add -A
git commit -m "e2e-fix: <scenarioId> <one-line root cause summary>"
git push origin <iterationBranch>
SHA=$(git rev-parse HEAD)
echo "Committed: $SHA"
```

`fixedFiles` = the relative paths of files you edited (not test files, not `git add -A` —
list only what you actually changed).

---

## Phase 7: Output JSON

Print as the **very last line** of your entire output (nothing after it):

**On success:**
```json
{"success":true,"commitSha":"<SHA from git rev-parse HEAD>","verdict":"product_bug","rootCauseSummary":"<one sentence describing the root cause>","fixedFiles":["src/path/to/file.ts"],"failureReason":""}
```

**On failure:**
```json
{"success":false,"commitSha":null,"verdict":"test_flakiness|infra_issue|uncertain","rootCauseSummary":"<what you found, even if inconclusive>","fixedFiles":[],"failureReason":"<why fix was not possible or not needed>"}
```

---

## Verdict Guide

| Verdict | When to use |
|---|---|
| `product_bug` | Root cause is a product code bug; you fixed it and the test passes |
| `test_flakiness` | Scenario passed on re-run with zero code changes |
| `infra_issue` | Network timeout, port conflict, OOM, docker daemon issue — not a code bug |
| `uncertain` | Could not determine root cause after 2 fix attempts |

---

## Hard Rules

- **Never push to any branch other than the `iterationBranch` given in the user message**
- **Never modify test files** (`*.spec.ts`, `*.test.ts`, `*.spec.js`)
- **Always output the JSON as the very last line** — even if something went wrong mid-process
- **Maximum 2 fix attempts** — if still failing after attempt 2, output `success=false`
- **`commitSha` must be the actual SHA** from `git rev-parse HEAD` — never a placeholder
- **`fixedFiles` must list actual file paths** you edited — not all staged files

---

## Common Failure Patterns (ChatOps-specific)

- **DB schema mismatch**: check `src/db/schema-v*.sql` and recent migrations
- **Import cycle / missing export**: check TypeScript errors with `tsc --noEmit`
- **Async race condition**: look for missing `await`, wrong Promise chain, race in session-manager
- **Config not read**: check `resolveGitlabConfig()` vs `process.env.GITLAB_URL` direct read (always use the former)
- **MCP tool not registered**: check `src/server.ts` and `src/agent/mcp-server.ts` imports
```

- [ ] **Step 2: 验证文件创建**

```bash
cat ~/.claude/skills/e2e-fix/SKILL.md | head -5
```

期望：看到 `---` frontmatter 开头。

- [ ] **Step 3: commit（项目侧记录 skill 路径约定）**

skill 文件本身在 `~/.claude/`（不进项目仓库），但在项目里记录一个说明注释以便团队知道有这个 skill。

```bash
# 不需要 git add（~/.claude 不在项目 repo 里）
# 此 step 跳过，继续 Task 2
```

---

### Task 2: runner.ts — 加载 skill + 薄壳调用 claude-runner

**Files:**
- 新建: `src/agent/e2e-fix/runner.ts`
- 新建: `src/__tests__/unit/e2e-fix-runner.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/e2e-fix-runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import { homedir } from 'os'

// mock claude-runner
vi.mock('../../agent/claude-runner.js', () => ({
  ClaudeRunner: vi.fn().mockImplementation(() => ({
    executeCapabilityDirect: vi.fn(),
  })),
}))

// mock fs.readFileSync — 让 skill 路径返回假内容
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((p: unknown) => {
      const skillPath = join(homedir(), '.claude', 'skills', 'e2e-fix', 'SKILL.md')
      if (String(p) === skillPath) return '# E2E Fix Skill\n(mock skill content)'
      return actual.readFileSync(p as string, 'utf8')
    }),
  }
})

describe('runE2eFix', () => {
  let executeCapabilityDirectMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const { ClaudeRunner } = await import('../../agent/claude-runner.js')
    const instance = new (ClaudeRunner as ReturnType<typeof vi.fn>)()
    executeCapabilityDirectMock = instance.executeCapabilityDirect as ReturnType<typeof vi.fn>
    ;(ClaudeRunner as ReturnType<typeof vi.fn>).mockReturnValue(instance)
  })

  it('parses last JSON line from stdout on success', async () => {
    const payload = {
      success: true,
      commitSha: 'abc1234',
      verdict: 'product_bug',
      rootCauseSummary: 'null pointer in auth handler',
      fixedFiles: ['src/agent/auth.ts'],
      failureReason: '',
    }
    executeCapabilityDirectMock.mockResolvedValue(
      `Some Claude output\nthinking...\n${JSON.stringify(payload)}\n`,
    )

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    const result = await runE2eFix({
      scenarioId: 'login-success',
      evidenceDir: '/tmp/evidence/login-success',
      iterationBranch: 'test-iter/42',
      containerId: 'sandbox-container-42',
      workdir: '/workspace/chatops',
    })

    expect(result.success).toBe(true)
    expect(result.fixCommitSha).toBe('abc1234')
    expect(result.verdict).toBe('product_bug')
    expect(result.fixedFiles).toEqual(['src/agent/auth.ts'])
  })

  it('returns success=false with failureReason when stdout has no valid JSON', async () => {
    executeCapabilityDirectMock.mockResolvedValue(
      'Claude said something but forgot to output the final JSON line',
    )

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    const result = await runE2eFix({
      scenarioId: 'login-success',
      evidenceDir: '/tmp/evidence/login-success',
      iterationBranch: 'test-iter/42',
      containerId: 'sandbox-container-42',
      workdir: '/workspace/chatops',
    })

    expect(result.success).toBe(false)
    expect(result.fixCommitSha).toBeNull()
    expect(result.verdict).toBe('uncertain')
    expect(result.failureReason).toMatch(/no valid JSON/)
  })

  it('returns success=false when executeCapabilityDirect throws', async () => {
    executeCapabilityDirectMock.mockRejectedValue(new Error('timeout after 1800000ms'))

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    const result = await runE2eFix({
      scenarioId: 'approval-flow',
      evidenceDir: '/tmp/evidence/approval-flow',
      iterationBranch: 'test-iter/42',
      containerId: 'sandbox-container-42',
      workdir: '/workspace/chatops',
    })

    expect(result.success).toBe(false)
    expect(result.failureReason).toMatch(/timeout/)
  })

  it('passes dockerExec containerId + timeoutMs to executeCapabilityDirect', async () => {
    executeCapabilityDirectMock.mockResolvedValue(
      JSON.stringify({
        success: false, commitSha: null, verdict: 'uncertain',
        rootCauseSummary: 'x', fixedFiles: [], failureReason: 'y',
      }),
    )

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    await runE2eFix({
      scenarioId: 'create-prd',
      evidenceDir: '/tmp/evidence/create-prd',
      iterationBranch: 'test-iter/7',
      containerId: 'my-container-id',
      workdir: '/workspace/chatops',
    })

    expect(executeCapabilityDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerExec: expect.objectContaining({ containerId: 'my-container-id' }),
        timeoutMs: 30 * 60 * 1000,
      }),
    )
  })

  it('reads skill from ~/.claude/skills/e2e-fix/SKILL.md as systemPrompt', async () => {
    executeCapabilityDirectMock.mockResolvedValue(
      JSON.stringify({
        success: false, commitSha: null, verdict: 'uncertain',
        rootCauseSummary: 'x', fixedFiles: [], failureReason: 'y',
      }),
    )

    const { runE2eFix } = await import('../../agent/e2e-fix/runner.js')
    await runE2eFix({
      scenarioId: 'create-prd',
      evidenceDir: '/tmp/evidence/create-prd',
      iterationBranch: 'test-iter/7',
      containerId: 'my-container-id',
      workdir: '/workspace/chatops',
    })

    expect(executeCapabilityDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('E2E Fix Skill'),
      }),
    )
  })
})
```

Run — 期望 5 个测试全部失败（模块不存在）：

```bash
npx vitest run src/__tests__/unit/e2e-fix-runner.test.ts
```

- [ ] **Step 2: 实现 runner.ts**

```typescript
// src/agent/e2e-fix/runner.ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ClaudeRunner } from '../claude-runner.js'
import type { TaskContext } from '../tools/types.js'

const SKILL_PATH = join(homedir(), '.claude', 'skills', 'e2e-fix', 'SKILL.md')

export interface AiDiagnosis {
  verdict: 'product_bug' | 'test_flakiness' | 'infra_issue' | 'uncertain'
  rootCauseSummary: string
  fixCommitSha: string | null
  fixedFiles: string[]
  success: boolean
  failureReason: string
}

export interface E2eFixInput {
  scenarioId: string
  evidenceDir: string
  iterationBranch: string
  containerId: string
  workdir: string
}

const E2E_FIX_CONTEXT: TaskContext = {
  taskId: 'e2e-fix-agent',
  groupId: 'e2e-pipeline-b',
  platform: 'internal',
  initiatorId: 'pipeline-b',
  initiatorRole: null,
}

let _runner: ClaudeRunner | null = null
function getRunner(): ClaudeRunner {
  if (!_runner) _runner = new ClaudeRunner()
  return _runner
}

function parseLastJsonLine(output: string): AiDiagnosis | null {
  const lines = output.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line)
      if (typeof obj.success === 'boolean' && typeof obj.verdict === 'string') {
        return {
          verdict: obj.verdict as AiDiagnosis['verdict'],
          rootCauseSummary: String(obj.rootCauseSummary ?? ''),
          fixCommitSha: obj.commitSha ?? null,
          fixedFiles: Array.isArray(obj.fixedFiles) ? (obj.fixedFiles as string[]) : [],
          success: Boolean(obj.success),
          failureReason: String(obj.failureReason ?? ''),
        }
      }
    } catch {
      // not valid JSON, keep scanning upward
    }
  }
  return null
}

export async function runE2eFix(input: E2eFixInput): Promise<AiDiagnosis> {
  const systemPrompt = readFileSync(SKILL_PATH, 'utf8')

  const userMessage = [
    `场景 ${input.scenarioId} 在沙盒里失败。`,
    `Evidence dir: ${input.evidenceDir}`,
    `Iteration branch: ${input.iterationBranch}`,
    ``,
    `请按 skill 中的流程操作：`,
    `Phase 1: 读取 ${input.evidenceDir}/manifest.json 和所有 artifacts`,
    `Phase 2: 定位根因（grep/git log/Read）`,
    `Phase 3: 运行 ./test.sh --scenario ${input.scenarioId} --evidence-dir=${input.evidenceDir}-repro 复现失败`,
    `Phase 4-5: 修复代码并验证（./test.sh --scenario ${input.scenarioId} --evidence-dir=${input.evidenceDir}-verify）`,
    `Phase 6: git add -A && git commit && git push origin ${input.iterationBranch}`,
    `Phase 7: 输出最后一行 JSON（格式见 skill Hard Rules）`,
  ].join('\n')

  try {
    const output = await getRunner().executeCapabilityDirect({
      prompt: userMessage,
      systemPrompt,
      context: E2E_FIX_CONTEXT,
      tools: [],
      cwd: input.workdir,
      sessionKey: `e2e-fix-${input.scenarioId}`,
      freshSession: true,
      maxTurns: 40,
      timeoutMs: 30 * 60 * 1000,
      dockerExec: { containerId: input.containerId },
    })

    const parsed = parseLastJsonLine(output)
    if (!parsed) {
      return {
        verdict: 'uncertain',
        rootCauseSummary: '',
        fixCommitSha: null,
        fixedFiles: [],
        success: false,
        failureReason: 'no valid JSON in last line of Claude output',
      }
    }
    return parsed
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      verdict: 'uncertain',
      rootCauseSummary: '',
      fixCommitSha: null,
      fixedFiles: [],
      success: false,
      failureReason: msg,
    }
  }
}
```

- [ ] **Step 3: 跑测试，期望全绿**

```bash
npx vitest run src/__tests__/unit/e2e-fix-runner.test.ts
```

期望：5 个测试全部 PASS。

- [ ] **Step 4: commit**

```bash
git add src/agent/e2e-fix/runner.ts src/__tests__/unit/e2e-fix-runner.test.ts
git commit -m "feat(e2e-fix): runner.ts — 从 skill 加载 systemPrompt + dockerExec + 解析 JSON"
```

---

### Task 3: e2e-fix-agent 节点实现

**Files:**
- 新建: `src/e2e/pipeline-b/nodes/e2e-fix-agent.ts`
- 新建: `src/__tests__/unit/e2e-fix-agent-node.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/e2e-fix-agent-node.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SandboxHandle } from '../../db/repositories/e2e-sandboxes.js'

vi.mock('../../agent/e2e-fix/runner.js', () => ({
  runE2eFix: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({
  getPool: vi.fn(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  })),
}))

const mockSandboxHandle: SandboxHandle & { containerId: string; workdir: string } = {
  envId: 'test-env-42',
  kind: 'docker-compose-local',
  endpoints: { web: 'http://localhost:13042' },
  containerId: 'sandbox-42-container',
  workdir: '/workspace/chatops',
}

describe('e2eFixAgentNode', () => {
  let runE2eFixMock: ReturnType<typeof vi.fn>
  let poolQueryMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const runner = await import('../../agent/e2e-fix/runner.js')
    runE2eFixMock = runner.runE2eFix as ReturnType<typeof vi.fn>
    const { getPool } = await import('../../db/client.js')
    poolQueryMock = (getPool as ReturnType<typeof vi.fn>)().query
  })

  it('calls runE2eFix with correct params derived from state', async () => {
    runE2eFixMock.mockResolvedValue({
      success: true, fixCommitSha: 'def5678', verdict: 'product_bug',
      rootCauseSummary: 'missing null check', fixedFiles: ['src/pipeline/executor.ts'], failureReason: '',
    })

    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')
    await e2eFixAgentNode({
      sandboxHandle: mockSandboxHandle,
      iterationBranch: 'test-iter/42',
      evidenceDir: '/var/chatops/e2e-evidence/42/login-success/1',
      scenarioId: 'login-success',
      scenarioRunId: BigInt(99),
    })

    expect(runE2eFixMock).toHaveBeenCalledWith({
      scenarioId: 'login-success',
      evidenceDir: '/var/chatops/e2e-evidence/42/login-success/1',
      iterationBranch: 'test-iter/42',
      containerId: 'sandbox-42-container',
      workdir: '/workspace/chatops',
    })
  })

  it('writes aiDiagnosis into evidence_manifest via jsonb_set', async () => {
    runE2eFixMock.mockResolvedValue({
      success: true, fixCommitSha: 'def5678', verdict: 'product_bug',
      rootCauseSummary: 'missing null check', fixedFiles: ['src/pipeline/executor.ts'], failureReason: '',
    })

    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')
    await e2eFixAgentNode({
      sandboxHandle: mockSandboxHandle,
      iterationBranch: 'test-iter/42',
      evidenceDir: '/var/chatops/e2e-evidence/42/login-success/1',
      scenarioId: 'login-success',
      scenarioRunId: BigInt(99),
    })

    expect(poolQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('jsonb_set'),
      expect.arrayContaining([BigInt(99)]),
    )
  })

  it('returns AiDiagnosis in lastFixResult on success', async () => {
    const diagnosis = {
      success: true, fixCommitSha: 'abc0001', verdict: 'product_bug' as const,
      rootCauseSummary: 'race condition in session manager',
      fixedFiles: ['src/agent/session-manager.ts'], failureReason: '',
    }
    runE2eFixMock.mockResolvedValue(diagnosis)

    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')
    const result = await e2eFixAgentNode({
      sandboxHandle: mockSandboxHandle,
      iterationBranch: 'test-iter/42',
      evidenceDir: '/var/chatops/e2e-evidence/42/create-prd/1',
      scenarioId: 'create-prd',
      scenarioRunId: BigInt(101),
    })

    expect(result.lastFixResult?.success).toBe(true)
    expect(result.lastFixResult?.fixCommitSha).toBe('abc0001')
    expect(result.lastFixResult?.verdict).toBe('product_bug')
  })

  it('returns lastFixResult with success=false when runE2eFix reports failure', async () => {
    runE2eFixMock.mockResolvedValue({
      success: false, fixCommitSha: null, verdict: 'uncertain',
      rootCauseSummary: 'could not reproduce', fixedFiles: [],
      failureReason: 'test passed during reproduce step — flaky',
    })

    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')
    const result = await e2eFixAgentNode({
      sandboxHandle: mockSandboxHandle,
      iterationBranch: 'test-iter/42',
      evidenceDir: '/var/chatops/e2e-evidence/42/approval-flow/2',
      scenarioId: 'approval-flow',
      scenarioRunId: BigInt(200),
    })

    expect(result.lastFixResult?.success).toBe(false)
    expect(result.lastFixResult?.failureReason).toMatch(/flaky/)
  })

  it('throws when sandboxHandle has no containerId', async () => {
    const { e2eFixAgentNode } = await import('../../e2e/pipeline-b/nodes/e2e-fix-agent.js')

    await expect(
      e2eFixAgentNode({
        sandboxHandle: { envId: 'x', kind: 'docker-compose-local', endpoints: {} } as SandboxHandle,
        iterationBranch: 'test-iter/42',
        evidenceDir: '/tmp/evidence',
        scenarioId: 'login-success',
        scenarioRunId: BigInt(1),
      }),
    ).rejects.toThrow(/containerId/)
  })
})
```

Run — 期望 5 个测试全部失败（模块不存在）：

```bash
npx vitest run src/__tests__/unit/e2e-fix-agent-node.test.ts
```

- [ ] **Step 2: 创建目录并实现节点**

```typescript
// src/e2e/pipeline-b/nodes/e2e-fix-agent.ts
import { getPool } from '../../../db/client.js'
import type { SandboxHandle } from '../../../db/repositories/e2e-sandboxes.js'
import { runE2eFix, type AiDiagnosis } from '../../../agent/e2e-fix/runner.js'

export interface E2eFixAgentInput {
  sandboxHandle: SandboxHandle & { containerId?: string; workdir?: string }
  iterationBranch: string
  evidenceDir: string
  scenarioId: string
  scenarioRunId: bigint
}

export interface E2eFixAgentOutput {
  lastFixResult: AiDiagnosis
}

export async function e2eFixAgentNode(
  input: E2eFixAgentInput,
): Promise<E2eFixAgentOutput> {
  const { sandboxHandle, iterationBranch, evidenceDir, scenarioId, scenarioRunId } = input

  if (!sandboxHandle.containerId) {
    throw new Error('sandboxHandle.containerId is required for e2eFixAgentNode')
  }

  const diagnosis = await runE2eFix({
    scenarioId,
    evidenceDir,
    iterationBranch,
    containerId: sandboxHandle.containerId,
    workdir: sandboxHandle.workdir ?? '/workspace',
  })

  await getPool().query(
    `UPDATE e2e_scenario_runs
        SET evidence_manifest = jsonb_set(
              COALESCE(evidence_manifest, '{}'::jsonb),
              '{aiDiagnosis}',
              $1::jsonb
            )
      WHERE id = $2`,
    [JSON.stringify(diagnosis), scenarioRunId],
  )

  return { lastFixResult: diagnosis }
}
```

- [ ] **Step 3: 跑测试，期望全绿**

```bash
npx vitest run src/__tests__/unit/e2e-fix-agent-node.test.ts
```

- [ ] **Step 4: commit**

```bash
git add src/e2e/pipeline-b/nodes/e2e-fix-agent.ts src/__tests__/unit/e2e-fix-agent-node.test.ts
git commit -m "feat(e2e-fix): e2e-fix-agent 节点 — 调 runner + 落库 aiDiagnosis"
```

---

### Task 4: 全量验证

**Files:**
- 测试: `src/__tests__/unit/e2e-fix-runner.test.ts`
- 测试: `src/__tests__/unit/e2e-fix-agent-node.test.ts`

- [ ] **Step 1: 跑两个单测文件确认全绿**

```bash
npx vitest run src/__tests__/unit/e2e-fix-runner.test.ts
npx vitest run src/__tests__/unit/e2e-fix-agent-node.test.ts
```

期望：9 个测试全部 PASS。

- [ ] **Step 2: TypeScript 类型检查**

```bash
./test.sh --typecheck
```

期望：tsc --noEmit 无报错。

- [ ] **Step 3: 验证 skill 文件存在**

```bash
test -f ~/.claude/skills/e2e-fix/SKILL.md && echo "skill exists" || echo "MISSING: install skill first (Task 1)"
```

- [ ] **Step 4: 如有修复则补提交**

```bash
git add -A
git commit -m "fix(e2e-fix): TypeScript 类型修复"
```
