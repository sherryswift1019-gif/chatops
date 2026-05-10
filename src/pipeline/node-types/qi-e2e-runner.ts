/**
 * qi_e2e_runner — Quick-Impl 自有 E2E 测试节点
 *
 * 设计：docs/prds/prd-quick-impl-e2e-phase2.md - "三个新节点类型 / qi_e2e_runner"
 *
 * 执行流程（详见 PRD execute 流程）：
 *   1. 读 worktree 的 docs/test-playbooks/qi-{requirementId}.yaml + parsePlaybookYaml 校验
 *      + 附加 v9 合规校验（数量 / negative / AC 全覆盖 — 这层只能事后查不能拒，
 *        硬规则在 SpecAuthorOutputSchema superRefine 已拦了；这里是兜底防 dev-loop
 *        在 commit YAML 时手抖漏）
 *   2. attempt 计数：从 ctx.steps[nodeId]?.output?.attempt 推断（首次入 = 1）
 *   3. push worktree 当前分支到本地 bare（pushToBare）
 *   4. 反查 e2e_target_projects（按 requirement.gitlabProject 字符串匹配）
 *   5. provisionQiSandbox（git clone + deploy.sh provision）
 *      失败 → SandboxProvisionError 路径，返回 result='sandbox_failed'
 *   6. 串行 runE2eScenario × N，runId 用 -BigInt(requirementId) 防止撞 e2e_runs.id
 *   7. teardownQiSandbox 在 try-finally 里
 *   8. 全 pass → result='pass'；任一 fail → result='fail' + failureReport
 */
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { parsePlaybookYaml } from '../../e2e/pipeline-b/playbook/parse.js'
import type { Playbook } from '../../e2e/pipeline-b/playbook/types.js'
import {
  provisionQiSandbox,
  teardownQiSandbox,
  SandboxProvisionError,
  type QiSandboxHandle,
} from '../../quick-impl/qi-sandbox.js'
import { pushToBare } from '../../quick-impl/qi-bare-repo.js'
import {
  runE2eScenario,
  type RunScenarioResult,
} from '../../agent/e2e-scenario/runner.js'
import {
  buildQiFailureReport,
  type ScenarioRunRecord,
} from '../../quick-impl/qi-e2e-failure-report.js'
import { getRequirementById } from '../../db/repositories/requirements.js'
import { listE2eTargetProjects } from '../../db/repositories/e2e-target-projects.js'
import { acquireQiE2eSlot } from '../../quick-impl/qi-e2e-concurrency.js'
import { resolveDataDir } from '../data-dir.js'

/**
 * Evidence 落盘根目录（TEST_DATA_DIR/qi-evidence）。
 *
 * 必须独立于 QiSandboxHandle.sandboxDir：teardownQiSandbox 会 rmSync 整个 sandboxDir
 * （[qi-sandbox.ts] rmSync(handle.sandboxDir, recursive)），如果 evidence 嵌在 sandbox
 * 里就会一起被删，failureReport.scenarios[].artifactsDir 指向已删除目录，web UI 拿不到
 * 截图 / manifest。
 *
 * 路径同 docker volume 挂载点（/data/chatops/test-runs/），web UI 静态服务能读。
 */
export const QI_EVIDENCE_DIR_BASE =
  process.env.QI_EVIDENCE_DIR_BASE ??
  join(resolveDataDir(), 'qi-evidence')

/** evidence 路径：<base>/qi-{reqId}/attempt-{n}/{scenarioId}/ */
function buildEvidenceDir(reqId: number, attempt: number, scenarioId: string): string {
  return join(QI_EVIDENCE_DIR_BASE, `qi-${reqId}`, `attempt-${attempt}`, scenarioId)
}

interface QiE2eRunnerParams {
  requirementId: number
  worktreePath: string
  branch: string
  bareRepoPath: string
  /** Optional：覆盖反查；不传时按 requirement.gitlabProject ↔ e2e_target_projects.gitlabRepo 匹配 */
  targetProjectId?: string
  maxAttempts?: number
}

function readQiPlaybook(worktreePath: string, requirementId: number): Playbook {
  const playbookPath = join(worktreePath, 'docs/test-playbooks', `qi-${requirementId}.yaml`)
  const yamlContent = readFileSync(playbookPath, 'utf8')
  const parsed = parsePlaybookYaml(yamlContent)
  if (!parsed.ok) {
    const issues = parsed.issues?.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ') ?? ''
    throw new Error(`playbook YAML invalid: ${parsed.error}${issues ? ` (${issues})` : ''}`)
  }
  return parsed.value
}

/** v9-only 合规校验（spec_author schema 已拦但 dev-loop commit YAML 时可能漏） */
function validatePlaybookCompliance(playbook: { scenarios: Array<{ id: string; tags: string[] }> }): void {
  const count = playbook.scenarios.length
  if (count === 0) throw new Error('playbook has 0 scenarios')
  if (count > 5) throw new Error(`playbook has ${count} scenarios, max 5`)
}

async function resolveTargetProjectId(
  paramTargetProjectId: string | undefined,
  gitlabProject: string,
): Promise<string> {
  if (paramTargetProjectId) return paramTargetProjectId

  const all = await listE2eTargetProjects()
  // gitlabProject 可能是 "group/repo"，e2e_target_projects.gitlabRepo 可能是 url 或 path
  const match = all.find(
    (p) =>
      p.gitlabRepo === gitlabProject ||
      p.gitlabRepo.endsWith(`/${gitlabProject}`) ||
      p.gitlabRepo.endsWith(`/${gitlabProject}.git`),
  )
  if (!match) {
    throw new Error(
      `no e2e_target_projects matches gitlabProject "${gitlabProject}". 请先在 admin 后台 e2e-targets 页登记该项目。`,
    )
  }
  return match.id
}

/**
 * 从 ctx.steps[ctx.nodeId] 读取上一次本节点的输出推断 attempt。
 * - 首次执行：steps 不含本 nodeId → attempt=1
 * - fix-loop 回环二次进入：steps[nodeId].output.attempt = 上次值 → +1
 */
function deriveAttempt(ctx: ExecutionContext): number {
  const prior = ctx.steps[ctx.nodeId]?.output?.attempt
  if (typeof prior === 'number' && prior > 0) return prior + 1
  return 1
}

registerNodeType({
  key: 'qi_e2e_runner',
  async execute(
    rawParams: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    // 申请并发槽位（QI_E2E_CONCURRENCY 默认 1，多 QI run 并行时排队）
    const release = await acquireQiE2eSlot()
    try {
      return await runQiE2eExecute(rawParams, ctx)
    } finally {
      release()
    }
  },
})

async function runQiE2eExecute(
  rawParams: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<NodeExecutionResult> {
    const params = rawParams as Partial<QiE2eRunnerParams>

    const requirementId = Number(params.requirementId ?? ctx.triggerParams?.requirementId)
    if (!requirementId || isNaN(requirementId)) {
      return { status: 'failed', output: { reason: 'missing requirementId' }, error: 'requirementId required' }
    }
    const worktreePath = String(params.worktreePath ?? '')
    if (!worktreePath) {
      return { status: 'failed', output: { reason: 'missing worktreePath' }, error: 'worktreePath required' }
    }
    const branch = String(params.branch ?? '')
    if (!branch) {
      return { status: 'failed', output: { reason: 'missing branch' }, error: 'branch required' }
    }
    const bareRepoPath = String(params.bareRepoPath ?? '')
    if (!bareRepoPath) {
      return { status: 'failed', output: { reason: 'missing bareRepoPath' }, error: 'bareRepoPath required' }
    }
    const attempt = deriveAttempt(ctx)
    const startMs = Date.now()

    // 1. 解析 + 合规校验 playbook
    let playbook: Playbook
    const playbookPath = join(worktreePath, 'docs/test-playbooks', `qi-${requirementId}.yaml`)
    if (!existsSync(playbookPath)) {
      // playbook 不存在：dev-loop 未生成（通常是纯配置/注释类改动），视为跳过 E2E。
      // 用 result=skipped 而非 pass：UI 能渲染"已跳过"区分真跑通过的场景；下游 switch
      // 把 skipped 与 pass 都路由到 final_approval（同样推进流程）。
      console.log(`[qi-e2e-runner] no playbook at ${playbookPath}, skipping E2E`)
      return {
        status: 'success',
        output: {
          result: 'skipped',
          attempt,
          scenariosRun: 0,
          passed: 0,
          failed: 0,
          durationMs: Date.now() - startMs,
          skipped: true,
          skipReason: 'no playbook — dev-loop did not generate test scenarios (non-functional change)',
        },
      }
    }
    try {
      const parsed = readQiPlaybook(worktreePath, requirementId)
      validatePlaybookCompliance(parsed)
      playbook = parsed
    } catch (err) {
      return {
        status: 'failed',
        output: {
          result: 'fail',
          attempt,
          scenariosRun: 0,
          passed: 0,
          failed: 0,
          durationMs: Date.now() - startMs,
          failureReport: {
            total: 0,
            passed: 0,
            failed: 1,
            scenarios: [
              {
                id: 'playbook',
                name: 'playbook 解析或合规校验失败',
                result: 'no-manifest',
                failureReason: (err as Error).message,
                failedAcceptances: [],
                claudeTraceTail: '',
                artifactsDir: null,
              },
            ],
          },
        },
        error: (err as Error).message,
      }
    }

    // 2. 反查 requirement
    const requirement = await getRequirementById(requirementId)
    if (!requirement) {
      return { status: 'failed', output: { reason: 'requirement not found' }, error: `requirement ${requirementId} missing` }
    }

    // 3. push 到本地 bare（让 sandbox 能 clone 到这个分支）
    try {
      await pushToBare(worktreePath, branch, bareRepoPath)
    } catch (err) {
      return {
        status: 'failed',
        output: {
          result: 'sandbox_failed',
          attempt,
          sandboxError: `push to bare failed: ${(err as Error).message}`,
        },
        error: (err as Error).message,
      }
    }

    // 4. 反查 targetProjectId
    let targetProjectId: string
    try {
      targetProjectId = await resolveTargetProjectId(params.targetProjectId, requirement.gitlabProject)
    } catch (err) {
      return {
        status: 'failed',
        output: {
          result: 'sandbox_failed',
          attempt,
          sandboxError: (err as Error).message,
        },
        error: (err as Error).message,
      }
    }

    // 5. provision sandbox（失败走 sandbox_failed 分支）
    let handle: QiSandboxHandle
    try {
      handle = await provisionQiSandbox({
        requirementId,
        attempt,
        bareRepoPath,
        branch,
        targetProjectId,
      })
    } catch (err) {
      const isSandboxErr = err instanceof SandboxProvisionError
      const stage = isSandboxErr ? err.stage : 'unknown'
      return {
        status: 'failed',
        output: {
          result: 'sandbox_failed',
          attempt,
          sandboxError: `[${stage}] ${(err as Error).message}`,
        },
        error: (err as Error).message,
      }
    }

    // 6/7. 串行跑 scenario，try-finally 保证 teardown
    const records: ScenarioRunRecord[] = []
    const fakeRunId = -BigInt(requirementId) // 撞库防御
    try {
      for (const scenario of playbook.scenarios) {
        // evidence 写到 sandbox 之外的持久目录（TEST_DATA_DIR/qi-evidence/...），
        // 避免 teardown rmSync(sandboxDir) 把 manifest/截图一起带走。
        const evidenceDir = buildEvidenceDir(requirementId, attempt, scenario.id)
        mkdirSync(evidenceDir, { recursive: true })

        let result: RunScenarioResult
        try {
          result = await runE2eScenario({
            playbook,
            scenarioId: scenario.id,
            evidenceDir,
            sandboxHandle: handle,
            attemptNumber: attempt,
            runId: fakeRunId,
          })
        } catch (err) {
          // runE2eScenario 内部已大量 try/catch 兜底，正常返回 errorMessage 不抛；
          // 但 ClaudeRunner / Playwright MCP 启动错误可能漏到这里
          result = { manifest: null, rawOutput: '', errorMessage: (err as Error).message }
        }
        records.push({
          ...result,
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          evidenceDir,
        })
      }
    } finally {
      await teardownQiSandbox(handle).catch((err) => {
        console.warn(`[qi-e2e-runner] teardown failed (envId=${handle.envId}): ${(err as Error).message}`)
      })
    }

    // 8. 组装结果
    const failureReport = buildQiFailureReport(records, playbook)
    const passedCount = records.filter((r) => r.manifest?.result === 'pass' && !r.errorMessage).length
    const failedCount = records.length - passedCount
    const allPass = failedCount === 0

    return {
      status: 'success', // 节点本身执行成功（哪怕 scenario 失败）；result 字段决定下游分支
      output: {
        result: allPass ? 'pass' : 'fail',
        attempt,
        scenariosRun: records.length,
        passed: passedCount,
        failed: failedCount,
        durationMs: Date.now() - startMs,
        failureReport: allPass ? null : failureReport,
        sandboxError: null,
      },
    }
}
