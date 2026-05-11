import { StateGraph, START, END, interrupt } from '@langchain/langgraph'
import { PipelineStateAnnotation, type StageResult, type StepOutput } from './graph-state.js'
import type {
  StageDefinition,
  StageContext,
  StageExecutionResult,
  ServerInfo,
  PipelineGraph,
  PipelineNode,
  PipelineEdge,
  ConditionSpec,
} from './types.js'
import { resolveApprovers } from './approval-resolvers.js'
import { getExecutor } from './node-types/registry.js'
import type { ExecutionContext, NodeExecutionResult } from './node-types/types.js'
import type { DockerExecutor } from './executors/docker.js'
import { resolveVariables, type VariableContext } from './variables.js'
import { resolveCapabilityParams } from './executor-hooks.js'
import { evalExpression } from './expressions.js'
import { extractJsonObject, NotJsonObjectError } from './json-extract.js'
import { markStageRunning } from './stage-status.js'
import type { SkillExecutor, RunSkillOptions, SkillContextInputs, PreviousRoundData, AcceptanceCriterion, AcDiff } from '../quick-impl/skill-runner.js'
import {
  runSkill,
  defaultMcpServerPath,
  SkillOutputParseError,
  diffAcceptanceCriteria,
} from '../quick-impl/skill-runner.js'
import {
  createWaiter,
  getActiveWaiter,
  getWaiterByNodeAndRound,
  type ApprovalKind,
  type DecisionSet,
  type RequirementApprovalWaiter,
} from '../db/repositories/requirement-approval-waiters.js'
import {
  shouldEscalate,
  computeNewBudget,
} from '../quick-impl/approval-claim.js'
import { setRequirementStatus } from '../db/repositories/requirements.js'
import { appendStageResult, getTestRunById } from '../db/repositories/test-runs.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { buildSpecApprovalSummary, buildFinalApprovalSummary, buildPlanApprovalSummary } from './approval-summary/index.js'
import type { SpecAuthorOutput } from '../quick-impl/role-output-schemas.js'

// Hooks let the builder stay agnostic of SSH / capability implementations.
// The executor (Task 4) wires real implementations; tests wire plain stubs.

/**
 * DryRunFlavor — injected by dryrun-runner to intercept side-effect nodes.
 * When present, side-effect nodes (dm/db_update/script/approval/http) call
 * beforeSideEffect to get a decision before executing. Non-side-effect nodes
 * (sql_query etc.) are not intercepted but do still emit recordSnapshot.
 */
export interface DryRunFlavor {
  /**
   * Called before a side-effect node executes.
   * Returns a decision: 'real' (execute the real hook), 'stub' (skip, use
   * default empty output), or 'manual' (skip, use caller-supplied output).
   */
  beforeSideEffect: (
    nodeId: string,
    nodeType: string,
    params: unknown,
  ) => Promise<{ decision: 'real' | 'stub' | 'manual'; output?: Record<string, unknown> }>
  /**
   * Called after each node (side-effect or not) completes. Persists the result
   * to pipeline_dryrun_snapshots for Inspector "upstream fields" display.
   */
  recordSnapshot: (nodeId: string, snapshot: {
    status: 'success' | 'failed' | 'skipped'
    output: Record<string, unknown>
    source: 'real' | 'stub' | 'manual'
    durationMs: number
    error?: string
  }) => Promise<void>
  /**
   * Returns the upstream params hash for a given node id (pre-computed before
   * graph execution starts, used for stale-detection in snapshots).
   */
  upstreamHashOf: (nodeId: string) => string
}

export interface StageHooks {
  runScript(
    stage: StageDefinition,
    ctx: StageContext,
    targetServers: ServerInfo[],
  ): Promise<StageExecutionResult>
  runCapability?(
    stage: StageDefinition,
    ctx: StageContext,
    triggerParams?: Record<string, unknown>,
    runtimeVars?: Record<string, unknown>,
  ): Promise<StageExecutionResult>
  runCustomAgent?(
    stage: StageDefinition,
    ctx: StageContext,
    triggerParams?: Record<string, unknown>,
    runtimeVars?: Record<string, unknown>,
  ): Promise<StageExecutionResult>
  /** DryRunFlavor — injected only during dry runs. When absent, zero overhead. */
  dryRunFlavor?: DryRunFlavor
}

// StageContext minus stageIndex — the builder fills stageIndex per node.
export interface StageContextBase extends Omit<StageContext, 'stageIndex'> {
  dockerExecutor?: DockerExecutor
  /** Pipeline 级默认镜像；node 没配 containerImage 时由 hooks 回落使用 */
  pipelineContainerImage?: string
  /** Quick-Impl skill 节点执行器（skill_node / skill_with_approval / skill_with_review 用）。
   *  生产环境由 server.ts 注入 ClaudeRunner 包装；测试注入 fake。 */
  skillExecutor?: SkillExecutor
  /** 专用 MCP server 路径；未设置时 skill-runner 用 defaultMcpServerPath()。 */
  mcpServerPath?: string
}

export interface BuildGraphInput {
  stages: StageDefinition[]
  stageContext: StageContextBase
  hooks: StageHooks
  triggerParams?: Record<string, unknown>
}

// Interrupt type / resume value constants. Task 3 (approval-manager /
// webhook-waiter) routes on the `type` field; keeping these as named constants
// lets TypeScript catch typos at compile time instead of at runtime.
export const APPROVAL_INTERRUPT = 'approval' as const
export const WEBHOOK_INTERRUPT = 'webhook' as const
export const APPROVAL_APPROVED = 'approved' as const
export const APPROVAL_REJECTED = 'rejected' as const
// NOTE: webhook timeout is expressed as `{ timeout: true }` on the resume
// value (see `WebhookResume`), not as an extra constant here.

// ---- Quick-Impl skill_with_approval interrupt/resume types ---------------

export const QI_APPROVAL_INTERRUPT = 'qi_approval' as const

/** 单轮审批循环状态，随 interrupt payload 和 resume prevState 传递。 */
export interface ApprovalLoopState {
  budgetUsed: number
  rejectHistory: Array<{
    round: number
    reason: string | null
    at: string
    /** PRD §7 step 6：人审 rejected_plan 时填的 task 定位（仅 plan_escalation） */
    targetTaskId?: string | null
    /** PRD §7 step 6：人审勾选的 AI notes 子集（仅 plan_escalation） */
    citedAiNotes?: string[] | null
  }>
  lastCommit?: string
  lastArtifactPath?: string
  /** 最近一轮 skill 的 fenced-JSON 完整输出（无则退化为 .output 摘要对象）。
   *  下游模板 {{steps.<id>.output.skillOutput}} 用，跨 interrupt 通过 resume.prevState 持久。 */
  lastSkillOutput?: unknown
}

/** interrupt 值：graph-runner dispatchInterrupt 据此注册 pending waiter。 */
export interface QiApprovalInterruptValue {
  type: typeof QI_APPROVAL_INTERRUPT
  waiterId: number
  runId: number
  nodeId: string
  round: number
  approvalKind: ApprovalKind
  decisionSet: DecisionSet
  loopState: ApprovalLoopState
  /** 钉钉审批人 userId 列表，空数组 = 仅 Web 审批 */
  approverIds: string[]
  requirementId: number
  requirementTitle: string
  contextSummary: string | null
  /** v3 IM 卡片精简摘要（≤ 250 字符，由 buildSpec/FinalApprovalSummary 拼装）；缺失时 IM 走 contextSummary 截断 */
  imSummary?: string | null
}

/** resume 值：由 resumeFromQiApproval 打包后通过 Command({resume:...}) 送回节点。 */
export interface QiApprovalResume {
  claimedWaiter: RequirementApprovalWaiter
  prevState: ApprovalLoopState
}

// ---- Quick-Impl im_input interrupt/resume types --------------------------
// im_input 是单次 interrupt（不像 skill_with_approval 多轮 loop），用于 e2e 失败 /
// sandbox 失败两类人工介入场景。详见 docs/prds/prd-quick-impl-e2e-phase2.md "三个新节点类型 / im_input"。

export const QI_IM_INPUT_INTERRUPT = 'qi_im_input' as const

export interface QiImInputInterruptValue {
  type: typeof QI_IM_INPUT_INTERRUPT
  waiterId: number
  runId: number
  nodeId: string
  /** 'qi_e2e_intervention' (3 按钮) | 'qi_sandbox_failed' (2 按钮) */
  kind: string
  approverIds: string[]
  requirementId: number
  requirementTitle: string
  contextSummary: string | null
}

export interface QiImInputResume {
  claimedWaiter: RequirementApprovalWaiter
}

// Shape of the value passed to interrupt() for approval stages.
export interface ApprovalInterruptValue {
  type: typeof APPROVAL_INTERRUPT
  stageIndex: number
  approverIds: string[]
  description: string
}
// Expected resume value for an approval interrupt.
export type ApprovalResume =
  | typeof APPROVAL_APPROVED
  | typeof APPROVAL_REJECTED
  | 'timeout'

// Shape of the value passed to interrupt() for webhook stages.
export interface WebhookInterruptValue {
  type: typeof WEBHOOK_INTERRUPT
  stageIndex: number
  tag: string
}
/**
 * Expected resume value for a webhook interrupt.
 *
 * Task 3 **must** dispatch exactly one of:
 *   - `new Command({ resume: { data: <payload> } })`  — webhook arrived
 *   - `new Command({ resume: { timeout: true } })`    — wait timed out
 *
 * Rationale for not allowing `null` / `undefined`:
 * LangGraph's Command constructor treats `resume == null` as "no resume
 * provided" and throws `EmptyInputError`. Timeout must therefore be an
 * explicit sentinel object, not a nullish value. Narrowing the type here
 * prevents Task 3 from accidentally falling into that trap.
 *
 * Success vs timeout is distinguished by the presence of the `timeout: true`
 * field (see `buildWaitWebhookNode`). Payloads that happen to contain a
 * `timeout` key can use `{ data: ... }` to disambiguate.
 */
export type WebhookResume = { data: unknown } | { timeout: true }

function nodeName(index: number, stage: StageDefinition): string {
  return `stage_${index}_${stage.stageType}`
}

// Resolve target servers for a stage. Empty targetRoles = no server target
// (use Docker path); non-empty = SSH to the listed roles only.
function resolveTargetServers(
  stage: StageDefinition,
  servers: Record<string, ServerInfo[]>,
): ServerInfo[] {
  if (stage.targetRoles.length > 0) {
    return stage.targetRoles.flatMap((role) => servers[role] ?? [])
  }
  return []
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * v2: 从 ClaudeRunner raw output 抽取最后一个 ```json``` block 的扩展字段。
 * 现有 SkillOutputSchema 只解析 summary/decision/notes，v2 的 acceptanceCriteria/tasks/commits/specCoverage
 * 等需要二次解析。失败返回 null（兼容 v1 baseline 输出格式不规范的情况）。
 */
function parseFencedJsonFromRaw(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  const fenced = raw.match(/```\s*json\s*([\s\S]*?)```/g)
  if (!fenced) return null
  const last = fenced[fenced.length - 1]!
  const body = last.replace(/```\s*json\s*/, '').replace(/```$/, '').trim()
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

// Build a StageResult patch for the "running" → "done" transition.
function finishedResult(
  stage: StageDefinition,
  startedAt: string,
  startedMs: number,
  exec: StageExecutionResult,
): StageResult {
  return {
    name: stage.name,
    type: stage.stageType,
    status: exec.status,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedMs,
    output: exec.output,
    error: exec.error,
  }
}

function skippedResult(stage: StageDefinition, reason: string): StageResult {
  return {
    name: stage.name,
    type: stage.stageType,
    status: 'skipped',
    output: reason,
  }
}

// Pure function — given a finished StageResult and the stage's onFailure
// policy, decide whether downstream should keep running.
function shouldStopAfter(stage: StageDefinition, result: StageResult): boolean {
  return result.status === 'failed' && stage.onFailure === 'stop'
}

async function runScriptInDocker(
  stage: StageDefinition,
  ctxBase: StageContextBase,
  stageIndex: number,
  executor: DockerExecutor,
  stepOutputs: Record<string, unknown>,
  triggerParams: Record<string, unknown>,
): Promise<StageExecutionResult> {
  const script = stage.script ?? ''
  if (!script.trim()) return { status: 'success', output: 'No script to execute' }

  const varCtx: VariableContext = {
    productLine: ctxBase.productLine ?? { name: '', displayName: '' },
    pipeline: ctxBase.pipeline ?? { id: ctxBase.runId, name: '' },
    run: ctxBase.run ?? { id: ctxBase.runId, triggeredBy: '', triggerType: '' },
    stage: { name: stage.name, index: stageIndex },
    server: { host: '', port: 0, username: '', name: '', role: '' },
    vars: (ctxBase.variables ?? {}) as Record<string, string>,
    steps: stepOutputs,
    triggerParams,
  }
  const resolvedScript = resolveVariables(script, varCtx)

  const result = await executor.exec(resolvedScript)
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  // Docker 路径无 server 概念，但下游消费方（buildScriptNode 写 stepOutputs）需要
  // 形状统一的 servers[] 数组。塞一条虚拟条目：host=""、role="docker"、port=0，
  // 其余字段镜像 docker exec 结果。让 `{{steps.<id>.output.host}}` 等模板对
  // SSH/Docker 两路径都不破。
  const success = result.exitCode === 0
  const dockerDetail = {
    host: '',
    port: 0,
    role: 'docker',
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    success,
  }
  if (!success) {
    return { status: 'failed', output, error: `exit code ${result.exitCode}`, servers: [dockerDetail] }
  }
  return { status: 'success', output, servers: [dockerDetail] }
}

// Build the script node. Captures stage/index/hooks/ctx in a closure so the
// returned async function matches the StateGraph NodeAction signature.
//
// Hook errors are caught and materialised as a failed StageExecutionResult so
// the conditional router still runs: otherwise a thrown hook would crash the
// superstep, no StageResult gets written, and `onFailure='continue'` would
// silently stop the graph. Mirrors executor.ts behaviour (executeScriptStage
// / executeCapabilityStage wrap their work in try/catch).
function buildScriptNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
  hooks: StageHooks,
  triggerParams?: Record<string, unknown>,
) {
  return async (state: typeof PipelineStateAnnotation.State) => {
    const targetServers = resolveTargetServers(stage, ctxBase.servers)
    const startedAt = nowIso()
    const startedMs = Date.now()
    // Publish a `running` entry to test_runs.stage_results so the admin Drawer
    // Timeline reflects the in-progress stage. finishedResult below merges
    // over this by name when the node completes.
    await markStageRunning(ctxBase.runId, stage, startedAt)
    const stepOutputs = state.stepOutputs ?? {}
    const tp = triggerParams ?? {}
    let exec: StageExecutionResult

    if (targetServers.length > 0) {
      // SSH path — existing behaviour unchanged
      const ctx: StageContext = { ...ctxBase, stageIndex: index, stepOutputs, triggerParams: tp }
      try {
        exec = await hooks.runScript(stage, ctx, targetServers)
      } catch (err) {
        exec = { status: 'failed', output: `script hook error: ${String(err)}`, error: String(err) }
      }
    } else {
      // Docker path
      const nodeImage = stage.containerImage?.trim()
      if (nodeImage) {
        // Per-node override: spin up a dedicated container just for this node
        const { DockerExecutor } = await import('./executors/docker.js')
        const containerName = `chatops-node-${ctxBase.runId}-${index}`
        const nodeExecutor = new DockerExecutor(nodeImage)
        await nodeExecutor.setup(containerName)
        try {
          exec = await runScriptInDocker(stage, ctxBase, index, nodeExecutor, stepOutputs, tp)
        } finally {
          await nodeExecutor.teardown()
        }
      } else if (ctxBase.dockerExecutor) {
        // Pipeline-level shared executor
        exec = await runScriptInDocker(stage, ctxBase, index, ctxBase.dockerExecutor, stepOutputs, tp)
      } else {
        exec = {
          status: 'failed',
          output: 'No executor configured: set a role or container image',
          error: 'no_executor',
        }
      }
    }

    const stepOutput = buildScriptStepOutput(exec)
    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
      ...(stepOutput
        ? { stepOutputs: { [(stage as PipelineNode).id ?? stage.name]: stepOutput } }
        : {}),
    }
  }
}

/**
 * Construct the structured stepOutput for a finished script stage so downstream
 * nodes can resolve `{{steps.<scriptId>.output.<field>}}` templates.
 *
 * Top-level shortcut fields (host/port/role/stdout/stderr/exitCode/success)
 * mirror the "first failure or first success" server — chosen because the
 * PAM Proxy 诊断修复 capability uses these as the primary diagnostic source:
 * when a multi-server install fails on the second host, the LLM should see
 * the failing host's stdout/stderr without having to dig into servers[].
 *
 * Selection rule:
 *   - 单 server：第一台
 *   - 多 server 全成功：第一台 success
 *   - 多 server 含失败：第一台失败的 server
 *
 * Returns null when the hook didn't supply a `servers` array (e.g. the
 * "no_executor" branch, an empty-script success, or a hook mock that
 * doesn't fill the field). In that case buildScriptNode skips the
 * stepOutputs write — preserving the legacy "no structured output" behaviour
 * for tests / hooks that don't produce per-server detail.
 */
function buildScriptStepOutput(
  exec: StageExecutionResult,
): { status: 'success' | 'failed'; output: Record<string, unknown> } | null {
  const servers = exec.servers
  if (!servers || servers.length === 0) return null

  // Pick the top-level "primary" server.
  const firstFailed = servers.find((s) => !s.success)
  const primary = firstFailed ?? servers[0]

  return {
    status: exec.status,
    output: {
      host: primary.host,
      port: primary.port,
      role: primary.role,
      stdout: primary.stdout,
      stderr: primary.stderr,
      exitCode: primary.exitCode,
      success: primary.success,
      ...(primary.error !== undefined ? { error: primary.error } : {}),
      servers,
    },
  }
}

function buildCapabilityNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
  hooks: StageHooks,
  triggerParams?: Record<string, unknown>,
) {
  return async (state: typeof PipelineStateAnnotation.State) => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    // Stream a `running` entry into stage_results so admin Drawer Timeline
    // can render in-progress capability runs (e.g. PAM Proxy 诊断修复 LLM
    // turns) without waiting for the node to finalize.
    await markStageRunning(ctxBase.runId, stage, startedAt)
    const ctx: StageContext = { ...ctxBase, stageIndex: index }
    const runtimeVars = { ...(ctxBase.variables ?? {}), ...(state.runtimeVars ?? {}) }

    // 在 hook 调用前一次性把 capabilityParams 里的 `{{steps.<id>.output.x}}` /
    // `{{vars.<obj>.<field>}}` / `{{triggerParams.<x>.<y>}}` 嵌套模板解析掉。
    // 旧实现只展开单段 key，hook 拿到原始 `{{...}}` 字面量，下游（capability
    // 入参 / LLM agent）根本无法消费——这是 PAM Proxy pipeline 的失败根因。
    //
    // 解析后会传给 hook 替代原 stage.capabilityParams。hook 内部仍会再调一次
    // resolveCapabilityParams（兼容性 / 防御性，无 graph-builder 走 executor 直入）：
    // 那次 call 对已 resolve 的值是 no-op（resolve-capability-params idempotency
    // 单测 lockdown）。
    //
    // 注意 vars 字段必须用结构化版（runtimeVars 原始 unknown 值），不能用
    // buildVariableContext 那个 JSON.stringify 后的 Record<string, string>——
    // 否则 `{{vars.config.host}}` 的 nested 路径在 resolvePath 里会撞到一个
    // 字符串而非对象，路径展开失败保留 literal。
    const baseCtx = buildVariableContext(state, ctxBase, triggerParams ?? {}, stage, index)
    const varCtx: VariableContext & Record<string, unknown> = {
      ...baseCtx,
      vars: runtimeVars as unknown as Record<string, string>,
    }
    let resolvedCapabilityParams: Record<string, unknown> | undefined
    try {
      resolvedCapabilityParams = resolveCapabilityParams(stage.capabilityParams, varCtx)
    } catch (err) {
      // resolvePath 不会 throw，但保险起见兜底。
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `capability 参数解析失败: ${String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult(stage, startedAt, startedMs, exec),
      }
    }
    const stageWithResolved: StageDefinition = {
      ...stage,
      capabilityParams: resolvedCapabilityParams,
    }

    let exec: StageExecutionResult
    try {
      const agentMode = stage.agentMode ?? 'capability'
      if (agentMode === 'custom') {
        if (!hooks.runCustomAgent) {
          exec = { status: 'failed', output: 'custom agent hook not configured', error: 'no_hook' }
        } else {
          exec = await hooks.runCustomAgent(stageWithResolved, ctx, triggerParams, runtimeVars)
        }
      } else {
        if (!hooks.runCapability) {
          exec = { status: 'failed', output: 'capability hook not configured', error: 'no_hook' }
        } else {
          exec = await hooks.runCapability(stageWithResolved, ctx, triggerParams, runtimeVars)
        }
      }
    } catch (err) {
      exec = {
        status: 'failed',
        output: `capability hook error: ${String(err)}`,
        error: String(err),
      }
    }

    const outputFormat = stage.outputFormat ?? 'json'
    let stepOutput: { status: 'success'; output: Record<string, unknown> } | null = null

    if (outputFormat === 'json' && exec.status === 'success') {
      try {
        // LLM 输出常包 ```json``` markdown fence 或附带前后散文，
        // extractJsonObject 按严格性递减尝试剥离 fence / 找 `{...}` 子串。
        const parsed = extractJsonObject(exec.output)
        stepOutput = { status: 'success', output: parsed }
      } catch (e) {
        if (e instanceof NotJsonObjectError) {
          exec = { status: 'failed', output: exec.output, error: 'outputFormat=json: 输出必须是 JSON 对象' }
        } else {
          const msg = e instanceof Error ? e.message : String(e)
          exec = { status: 'failed', output: exec.output, error: `outputFormat=json: parse 失败: ${msg}` }
        }
      }
    }

    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
      ...(stepOutput ? { stepOutputs: { [(stage as PipelineNode).id ?? stage.name]: stepOutput } } : {}),
    }
  }
}

function buildApprovalNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
  triggerParams?: Record<string, unknown>,
) {
  return async () => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    // Approval nodes can sit waiting for hours — stream a `running` entry up
    // front so the Drawer Timeline shows the awaiting-approval row.
    await markStageRunning(ctxBase.runId, stage, startedAt)

    // 审批人两种来源（二选一）：
    //   1. stage.approverIdsResolver 指定 resolver 名 → 运行时动态查（主路径，业务默认）
    //   2. stage.approverIds 静态列表（含 `{{triggerParams.x}}` 模板展开）
    // 设计说明见 src/pipeline/approval-resolvers.ts 头部
    let approverIds: string[]
    let description: string
    try {
      if (stage.approverIdsResolver) {
        const r = await resolveApprovers(stage.approverIdsResolver, triggerParams ?? {})
        approverIds = r.approverIds
        description = r.description
          ?? resolveTemplateString(stage.approvalDescription ?? stage.name, triggerParams)
      } else {
        approverIds = resolveApproverIds(stage.approverIds ?? [], triggerParams)
        description = resolveTemplateString(stage.approvalDescription ?? stage.name, triggerParams)
      }
    } catch (err) {
      // resolver 失败 → stage failed，不触发 interrupt（否则无接收方、挂在那里）
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[approval-node] resolver/approverIds 解析失败:`, msg)
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `审批人解析失败: ${msg}`,
        error: 'resolver_failed',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult(stage, startedAt, startedMs, exec),
      }
    }

    const payload: ApprovalInterruptValue = {
      type: APPROVAL_INTERRUPT,
      stageIndex: index,
      approverIds,
      description,
    }
    // interrupt() throws a GraphInterrupt on first entry and returns the
    // resume value on subsequent entries once Command({resume}) is applied.
    const decision = interrupt(payload) as ApprovalResume
    const exec: StageExecutionResult =
      decision === APPROVAL_APPROVED
        ? { status: 'success', output: '审批通过' }
        : decision === APPROVAL_REJECTED
          ? { status: 'failed', output: '审批被拒绝', error: 'rejected' }
          : { status: 'failed', output: '审批超时', error: 'timeout' }
    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
    }
  }
}

/**
 * 展开 approverIds 数组里的 `{{triggerParams.xxx}}` 占位符，变成实际值。
 * 支持 L3 审批场景：pipeline 定义时 approverIds = ["{{triggerParams.primaryOwnerId}}"]，
 * coordinator 触发 pipeline 时已把 primaryOwnerId 塞进 triggerParams，这里运行时替换。
 *
 * 单元素整字符串匹配 `{{triggerParams.xxx}}`（如 "{{triggerParams.primaryOwnerId}}"）
 * → 替换为 triggerParams[xxx]（字符串）。
 * 无匹配或 triggerParams 缺 key → 保留原字符串（用户会看到 placeholder，方便排查配置错误）。
 * 非字符串元素（理论上不会有，防御性） → 原样保留。
 */
function resolveApproverIds(
  raw: string[],
  triggerParams?: Record<string, unknown>,
): string[] {
  if (!triggerParams) return raw
  return raw.map(v => resolveTemplateString(v, triggerParams))
}

/**
 * 对 description/approverId 字符串做 `{{triggerParams.xxx}}` 替换（全子串）。
 * 不支持嵌套/条件/过滤器等 Mustache 完整能力，MVP 足够。
 */
function resolveTemplateString(
  s: string,
  triggerParams?: Record<string, unknown>,
): string {
  if (!s || !triggerParams) return s
  return s.replace(/\{\{triggerParams\.(\w+)\}\}/g, (match, key) => {
    const v = triggerParams[key]
    if (v === undefined || v === null) return match // 缺 key 保留占位符便于排查
    return String(v)
  })
}

function buildWaitWebhookNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
) {
  return async () => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    // Webhook waits can sit on `interrupt()` for hours — publish running so
    // the Drawer Timeline reflects the awaiting-webhook row.
    await markStageRunning(ctxBase.runId, stage, startedAt)
    const payload: WebhookInterruptValue = {
      type: WEBHOOK_INTERRUPT,
      stageIndex: index,
      tag: stage.webhookTag ?? '',
    }
    const resume = interrupt(payload) as WebhookResume
    // Task 3 contract: resume is either `{ data: ... }` (success) or
    // `{ timeout: true }` (timeout). Any other shape is a caller bug —
    // we treat "no `timeout: true`" as success and read `data` from it.
    const isTimeout =
      typeof resume === 'object' &&
      resume !== null &&
      'timeout' in resume &&
      (resume as { timeout: unknown }).timeout === true
    if (isTimeout) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `等待 webhook 超时: ${stage.webhookTag ?? ''}`,
        error: 'timeout',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult(stage, startedAt, startedMs, exec),
      }
    }
    const exec: StageExecutionResult = {
      status: 'success',
      output: `webhook 已到达: ${stage.webhookTag ?? ''}`,
    }
    // Merge webhook payload into runtimeVars. Plain objects merge
    // key-by-key; scalars/arrays/other get stored under `__webhook_<tag>`.
    const tag = stage.webhookTag ?? 'unknown'
    const runtimePatch = extractRuntimeVars(tag, (resume as { data: unknown }).data)
    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
      ...(runtimePatch ? { runtimeVars: runtimePatch } : {}),
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

// ---- Executor-node dispatch (Phase 3 sql_query/http/db_update/dm/file_read/
// template_render/fan_out) -----------------------------------------------
//
// These 7 node types are implemented as standalone NodeExecutor instances
// (see src/pipeline/node-types/*.ts) rather than as bespoke graph-builder
// nodes. The dispatcher here:
//
//   1. Resolves all string templates inside `node.params` against the merged
//      template context (vars + triggerParams + steps + scopes).
//   2. Builds an ExecutionContext from PipelineState + closure context.
//   3. Calls the executor and translates NodeExecutionResult → StageResult.
//   4. Persists structured `output` (Record<string, unknown>) into
//      state.stepOutputs keyed by node id, so downstream `{{steps.<id>.x}}`
//      templates resolve against the structured value (not the JSON string
//      we put on StageResult.output for the run report).
//
// shortCircuitWhen is **not** wired here (phase 3 deferred); see the comment
// inside `buildExecutorNode` and the report message.
const TEMPLATE_RX = /\{\{[^}]+\}\}/

function hasTemplate(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return TEMPLATE_RX.test(value)
}

/**
 * Recursively render `{{...}}` templates inside any string contained in
 * `params`. Non-string leaves pass through untouched. Resolution uses
 * `resolveVariables` against a synthesized VariableContext that adds
 * `steps`/`triggerParams`/`scopes` as siblings of `vars`.
 *
 * Templates that don't resolve are left as the literal `{{...}}` string,
 * matching `resolveVariables` semantics (so executors can give clearer
 * "unresolved placeholder" errors than a silent empty value).
 */
function renderParamTemplates(
  params: Record<string, unknown>,
  ctx: VariableContext & Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    out[k] = renderValueTemplates(v, ctx)
  }
  return out
}

function renderValueTemplates(
  value: unknown,
  ctx: VariableContext & Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    if (!hasTemplate(value)) return value
    return resolveVariables(value, ctx)
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderValueTemplates(v, ctx))
  }
  if (isPlainObject(value)) {
    return renderParamTemplates(value as Record<string, unknown>, ctx)
  }
  return value
}

/**
 * Produce a VariableContext from the current PipelineState + closure ctxBase
 * + per-run triggerParams. Mirrors what executor-hooks.resolveCapabilityParams
 * builds, but exposes all four namespaces (`vars` / `triggerParams` /
 * `steps` / `scopes`) so SQL/HTTP/template_render templates can dot-walk
 * structured upstream outputs (e.g. `steps.load_report.output.rows[0].id`).
 */
function buildVariableContext(
  state: typeof PipelineStateAnnotation.State,
  ctxBase: StageContextBase,
  triggerParams: Record<string, unknown>,
  stage: StageDefinition,
  index: number,
): VariableContext & Record<string, unknown> {
  const mergedVars: Record<string, string> = {}
  for (const [k, v] of Object.entries(ctxBase.variables ?? {})) {
    mergedVars[k] = String(v)
  }
  for (const [k, v] of Object.entries(state.runtimeVars ?? {})) {
    mergedVars[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return {
    productLine: ctxBase.productLine
      ? { name: ctxBase.productLine.name, displayName: ctxBase.productLine.displayName }
      : { name: '', displayName: '' },
    pipeline: ctxBase.pipeline ?? { id: 0, name: '' },
    run: ctxBase.run ?? { id: ctxBase.runId, triggeredBy: '', triggerType: '' },
    stage: { name: stage.name ?? '', index },
    server: { host: '', port: 0, username: '', name: '', role: '' },
    vars: mergedVars,
    steps: state.stepOutputs ?? {},
    triggerParams,
    // scopes 由 fan_out body 子运行注入；外层 graph dispatch 永远是空。
    scopes: {},
  }
}

/**
 * StageResult.name we publish into state. Pipeline graph nodes (canvas)
 * have an `id`; legacy stage definitions only have `name`. Use `name` when
 * present, fall back to `id` so the conditional-edge router and the steps
 * registry stay consistent.
 */
function nodeStageResultName(node: PipelineNode | StageDefinition): string {
  const n = (node as PipelineNode & StageDefinition).name
  if (n && n.length > 0) return n
  const id = (node as PipelineNode).id
  return id ?? ''
}

/**
 * Generic dispatch to the NodeExecutor registry. Used by the 7 phase-3
 * stage types (sql_query / http / db_update / dm / file_read /
 * template_render / fan_out).
 *
 * Failure semantics mirror buildScriptNode: any throw inside the executor
 * is caught and materialised as a failed StageResult so the conditional
 * router still runs (otherwise an uncaught throw would break the
 * superstep without writing a result, and onFailure='continue' would
 * silently stop the graph).
 *
 * shortCircuitWhen (phase 3 spec §4.6) is **not** wired here yet — phase 3
 * landed only the expression parser. When parser+runtime are reconnected
 * the early-return below should evaluate `node.params.shortCircuitWhen`
 * against the same VariableContext and short-circuit to a `skipped` result.
 */
function buildExecutorNode(
  node: PipelineNode,
  index: number,
  ctxBase: StageContextBase,
  triggerParams: Record<string, unknown>,
) {
  const executor = getExecutor(node.stageType)
  if (!executor) {
    // Defensive: dispatch should only call this for registered types. Wrap
    // in a node action that fails the run rather than throwing at compile.
    return async () => {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `No executor registered for stage type "${node.stageType}"`,
        error: 'no_executor_registered',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult(node, nowIso(), Date.now(), exec),
      }
    }
  }

  return async (state: typeof PipelineStateAnnotation.State) => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const stageName = nodeStageResultName(node)
    // Stream `running` so executor-backed nodes (sql_query / http / dm /
    // db_update / file_read / template_render / fan_out / switch) appear in
    // the Drawer Timeline while in flight. Use stageName (resolves id when
    // node has no name) to keep merge-by-name consistent with finishedResult.
    await markStageRunning(
      ctxBase.runId,
      { name: stageName, stageType: node.stageType },
      startedAt,
    )

    const rawParams = ((node as unknown as { params?: Record<string, unknown> }).params ?? {})
    const varCtx = buildVariableContext(state, ctxBase, triggerParams, node, index)

    let resolvedParams: Record<string, unknown>
    try {
      resolvedParams = renderParamTemplates(rawParams, varCtx)
    } catch (err) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `param template resolve failed: ${String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    const execCtx: ExecutionContext = {
      runId: ctxBase.runId,
      pipelineId: ctxBase.pipeline?.id ?? 0,
      nodeId: node.id ?? stageName,
      triggerParams,
      vars: state.runtimeVars ?? ctxBase.variables ?? {},
      steps: state.stepOutputs ?? {},
    }

    let result: NodeExecutionResult
    try {
      result = await executor.execute(resolvedParams, execCtx)
    } catch (err) {
      result = {
        status: 'failed',
        output: {},
        error: err instanceof Error ? err.message : String(err),
      }
    }

    // StageResult.output is `string` per existing schema — JSON-encode the
    // structured executor output so the run report still gets readable
    // diagnostics. Templates that need the structured value read it from
    // state.stepOutputs (which keeps the original Record).
    let outputStr: string
    try {
      outputStr = JSON.stringify(result.output)
    } catch {
      outputStr = String(result.output)
    }

    const exec: StageExecutionResult = {
      status: result.status === 'skipped' ? 'failed' : result.status, // StageExecutionResult only has success/failed
      output: outputStr,
      ...(result.error ? { error: result.error } : {}),
    }

    // For 'skipped' status (not currently produced by any executor in v1, but
    // reserved for the shortCircuitWhen path) emit a literally-skipped
    // StageResult instead of bending it through StageExecutionResult.
    const stageResult: StageResult =
      result.status === 'skipped'
        ? {
            name: stageName,
            type: node.stageType,
            status: 'skipped',
            startedAt,
            finishedAt: nowIso(),
            durationMs: Date.now() - startedMs,
            output: outputStr,
          }
        : finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec)

    const stepOutput: StepOutput = {
      status: result.status,
      output: result.output ?? {},
    }

    if (result.status === 'success' && resolvedParams.statusOnSuccess) {
      const reqId = Number(resolvedParams.requirementId || triggerParams.requirementId)
      if (reqId && !isNaN(reqId)) {
        setRequirementStatus(reqId, resolvedParams.statusOnSuccess as any).catch(() => {})
      }
    }

    return {
      currentStageIndex: index,
      stageResults: stageResult,
      stepOutputs: { [node.id ?? stageName]: stepOutput },
    }
  }
}

function extractRuntimeVars(
  tag: string,
  data: unknown,
): Record<string, unknown> | null {
  if (data === undefined) return null
  if (isPlainObject(data)) return { ...data }
  return { [`__webhook_${tag}`]: data }
}

// ---- Quick-Impl skill node builders ----------------------------------------
//
// All three share the same param-resolve + skillExecutor-guard prologue.
// skill_node: single shot (no interrupt).
// skill_with_approval: multi-round interrupt loop with human gate.
// skill_with_review: multi-round async loop with AI reviewer gate.

function buildSkillNode(
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
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `skill_node param resolve failed: ${String(err)}`,
        error: String(err),
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    if (!ctxBase.skillExecutor) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: 'skill_node: skillExecutor not configured in stageContext',
        error: 'no_skill_executor',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    const requirementId = Number(params.requirementId)
    const skill = String(params.skill ?? '')
    const role = String(params.role ?? '')
    const worktreePath = String(params.worktreePath ?? '')
    const branch = String(params.branch ?? '')
    const baseBranch = String(params.baseBranch ?? '')
    const artifactPath = String(params.artifactPath ?? '')
    const nodeId = (node as PipelineNode).id ?? stageName

    if (!skill || !role || !worktreePath) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `skill_node: missing required params (skill=${skill}, role=${role}, worktreePath=${worktreePath})`,
        error: 'missing_params',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    let result: Awaited<ReturnType<typeof runSkill>>
    try {
      result = await runSkill(
        {
          requirementId,
          nodeId,
          skill,
          role,
          worktreePath,
          branch,
          baseBranch,
          artifactPath,
          inputs: (params.inputs as SkillContextInputs) ?? {},
          specSources: params.specSources as string[] | undefined,
          maxTurns: typeof params.maxTurns === 'number' ? params.maxTurns : undefined,
          timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
        },
        ctxBase.skillExecutor,
        ctxBase.mcpServerPath,
      )
    } catch (err) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `skill_node: ${String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    const exec: StageExecutionResult = {
      status: result.output.decision === 'fail' ? 'failed' : 'success',
      output: result.rawOutput,
    }
    const stepOutput: StepOutput = {
      status: exec.status,
      output: {
        ...result.output,
        durationMs: result.durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    }
    if (exec.status === 'success' && params.statusOnSuccess && requirementId) {
      setRequirementStatus(requirementId, params.statusOnSuccess as any).catch(() => {})
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      stepOutputs: { [(node as PipelineNode).id ?? stageName]: stepOutput },
    }
  }
}

/**
 * skill_with_approval — interrupt-based multi-round loop with human gate.
 *
 * Loop invariant (replay-safe):
 *   Each round creates exactly one DB waiter. On replay, getWaiterByNodeAndRound
 *   detects the existing waiter and skips the generator so we don't double-run.
 *   Calling interrupt() the N-th time in a replay returns the N-th stored resume
 *   value; only the NEW interrupt throws to pause the graph.
 *
 * State threading:
 *   loopState is embedded in the interrupt payload so graph-runner can register
 *   it in qi-approval-waiter.ts; resumeFromQiApproval echoes it back as
 *   resume.prevState, which restores lastCommit etc. on replay (when the
 *   generator was skipped and loopState wasn't recomputed from scratch).
 */
function buildSkillWithApprovalNode(
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
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `skill_with_approval param resolve failed: ${String(err)}`,
        error: String(err),
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    if (!ctxBase.skillExecutor) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: 'skill_with_approval: skillExecutor not configured',
        error: 'no_skill_executor',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }
    const skillExecutor = ctxBase.skillExecutor

    const requirementId = Number(params.requirementId)
    const skill = String(params.skill ?? '')
    const role = String(params.role ?? '')
    const worktreePath = String(params.worktreePath ?? '')
    const branch = String(params.branch ?? '')
    const baseBranch = String(params.baseBranch ?? '')
    const artifactPath = String(params.artifactPath ?? '')
    const decisionSet = (params.decisionSet as DecisionSet | undefined) ?? 'binary'
    const maxRounds = typeof params.maxRounds === 'number' ? params.maxRounds : 5
    // PRD #4：plan_human_escalation 等"先通知再修"场景下 round 1 跳过 skill 直接挂 waiter；
    // round 2+（人拒绝后）才跑 skill，把人审 reason 与 priorReviewerNotes 一起作为修订输入。
    const skipFirstSkill = params.skipFirstSkill === true
    const nodeId = (node as PipelineNode).id ?? stageName
    // approverIds: 逗号分隔字符串或已经是数组（bootstrap 传 variable 展开后）
    const rawApprovers = params.approverIds
    const approverIds: string[] = Array.isArray(rawApprovers)
      ? (rawApprovers as string[]).filter(Boolean)
      : typeof rawApprovers === 'string' && rawApprovers.trim()
        ? rawApprovers.split(',').map(s => s.trim()).filter(Boolean)
        : []

    let loopState: ApprovalLoopState = {
      budgetUsed: typeof params.initialBudget === 'number' ? params.initialBudget : 0,
      rejectHistory: [],
    }

    for (let round = 1; ; round++) {
      // Replay protection: if a waiter already exists for this round, the
      // generator already ran in a prior execution — skip it.
      const existingWaiter = await getWaiterByNodeAndRound(requirementId, nodeId, round, ctxBase.runId)
      let waiterRow: RequirementApprovalWaiter
      // 由 createWaiter 内的 contextSummary IIFE 设置；后续 interruptPayload 透传给 IM 卡片。
      // 提到 if(!existingWaiter) 之外是为了让 else 分支（已有 waiter）也能拿到字段（默认 null）
      let pendingImSummary: string | null = null

      if (!existingWaiter) {
        const baseApprovalKind = (params.approvalKind as ApprovalKind | undefined) ?? 'spec'
        // budgetUsed 累积 budget_extended 决策追加的 round 配额（默认 0）；
        // 有效预算 = maxRounds + budgetUsed。round >= effectiveBudget 时切 escalation。
        const effectiveBudget = maxRounds + loopState.budgetUsed
        const approvalKind: ApprovalKind = shouldEscalate(round, effectiveBudget)
          ? 'escalation'
          : baseApprovalKind
        const effectiveDecisionSet: DecisionSet = approvalKind === 'escalation' ? 'escalation' : decisionSet

        // round 内可被 createWaiter IIFE 引用的 spec-author 上下文
        // 声明在 if(skill) 之外，以便无 skill 路径也能正确处理（spec-author 走有 skill 路径，
        // 这些变量仅在 if(skill) 内被赋值）
        let prevSkillOutput: SpecAuthorOutput | undefined
        let usesV3SummaryForMeta: boolean | undefined = undefined
        // 在 if(skill) 内赋值；createWaiter contextSummary IIFE 外层引用
        let currentSkillOutput: SpecAuthorOutput | null = null
        let currentAcDiff: AcDiff | null = null

        if (skill && !(skipFirstSkill && round === 1)) {
          // v2: 构造 previousRound 反馈传给 runSkill（多轮场景）
          let previousRound: PreviousRoundData | undefined
          let prevAcs: AcceptanceCriterion[] | undefined
          if (round > 1) {
            try {
              const tr = await getTestRunById(ctxBase.runId)
              const stageRounds = tr?.stageResults?.[index]?.rounds ?? []
              const prevRound = [...stageRounds].reverse().find(
                (r: { round: number }) => r.round === round - 1,
              )
              const lastReject = loopState.rejectHistory[loopState.rejectHistory.length - 1]
              const prevSO = prevRound?.skillOutput as SpecAuthorOutput | undefined
              previousRound = {
                round: round - 1,
                decision: 'rejected',
                rejectReason: lastReject?.reason ?? undefined,
                previousArtifactPath: prevRound?.artifactPath ?? loopState.lastArtifactPath,
                previousCommits: loopState.lastCommit ? [loopState.lastCommit] : undefined,
                decidedAt: lastReject?.at,
                // v3: 透传上轮 LLM 自报 review 点 + 已接受的 assumption（feedback.md 渲染用）
                prevReviewHints: Array.isArray(prevSO?.reviewHints) ? prevSO!.reviewHints : undefined,
                prevAssumptions: Array.isArray(prevSO?.clarifications)
                  ? prevSO!.clarifications.filter((c) => c.kind === 'assumption').map((c) => ({
                      q: c.q,
                      a: c.a,
                      userMayDisagreeIf: c.userMayDisagreeIf,
                    }))
                  : undefined,
                // PRD §7 step 6：plan_escalation rejected_plan 的字段级反馈
                targetTaskId: lastReject?.targetTaskId ?? undefined,
                citedAiNotes: lastReject?.citedAiNotes ?? undefined,
              }
              prevAcs = (prevRound?.skillOutput?.acceptanceCriteria as AcceptanceCriterion[]) ?? undefined
              prevSkillOutput = prevSO
            } catch (err) {
              console.warn(`[graph-builder] previousRound build failed (continuing): ${err}`)
            }
          }

          // Run skill generator then create waiter
          let genResult: Awaited<ReturnType<typeof runSkill>>
          try {
            genResult = await runSkill(
              {
                requirementId,
                nodeId: `${nodeId}:gen:r${round}`,
                skill,
                role,
                worktreePath,
                branch,
                baseBranch,
                artifactPath,
                inputs: {
                  round,
                  budgetUsed: loopState.budgetUsed,
                  rejectHistory: loopState.rejectHistory,
                  lastCommit: loopState.lastCommit,
                  ...((params.inputs as SkillContextInputs) ?? {}),
                },
                specSources: params.specSources as string[] | undefined,
                previousRound,
              },
              skillExecutor,
              ctxBase.mcpServerPath,
            )
          } catch (err) {
            const exec: StageExecutionResult = {
              status: 'failed',
              output: `skill_with_approval round ${round} generator failed: ${String(err)}`,
              error: err instanceof Error ? err.message : String(err),
            }
            return {
              currentStageIndex: index,
              stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
            }
          }

          if (genResult.output.decision === 'fail') {
            const exec: StageExecutionResult = {
              status: 'failed',
              output: `skill_with_approval round ${round} generator decision=fail: ${genResult.output.summary}`,
              error: 'generator_fail',
            }
            return {
              currentStageIndex: index,
              stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
            }
          }

          // plan-decomposer v3 可能返回 reject_input（upstream spec 有问题无法继续拆解）。
          // 未来 TODO: 路由回 spec_review_loop 并把 rejectReasons[] 写入 spec-author 的 feedback.md。
          // 现在：停 pipeline，保留 rejectReasons 供运营查看（不走 human-approval 流程）。
          if ((genResult.output as { decision?: string }).decision === 'reject_input') {
            const rejectReasons = (genResult.output as { rejectReasons?: string[] }).rejectReasons ?? []
            const exec: StageExecutionResult = {
              status: 'failed',
              output: `skill_with_approval round ${round} generator decision=reject_input: ${genResult.output.summary} | rejectReasons: ${rejectReasons.join('; ')}`,
              error: 'reject_input',
            }
            return {
              currentStageIndex: index,
              stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
            }
          }

          // v2: 持久化本轮 skillOutput / acDiff（详见 docs/prds/quick-impl-roles-v2/02-data-flow.md §5/§6）
          const extendedOutput = parseFencedJsonFromRaw(genResult.rawOutput)
          const currentAcs = extendedOutput?.acceptanceCriteria as AcceptanceCriterion[] | undefined
          const acDiff = role === 'spec-author' && round > 1 && prevAcs && currentAcs
            ? diffAcceptanceCriteria(prevAcs, currentAcs)
            : undefined
          // hoist 给外层 createWaiter contextSummary IIFE 用（v3 摘要直接传，不再绕 state.stageResults）
          currentSkillOutput = (extendedOutput as SpecAuthorOutput | null) ?? null
          currentAcDiff = acDiff ?? null
          // 持久化到 loopState：interrupt resume 时 prevState 还原后，success path 的 stepOutputs
          // 才能拿到 skillOutput / lastArtifactPath（下游 dev-loop 模板 {{steps.<id>.output.skillOutput}} 依赖）。
          loopState = {
            ...loopState,
            lastArtifactPath: artifactPath,
            lastSkillOutput: currentSkillOutput ?? genResult.output,
          }
          if (acDiff && (acDiff.added.length || acDiff.removed.length || acDiff.changed.length)) {
            console.log(
              `[graph-builder] spec acDiff round ${round}: +${acDiff.added.length} -${acDiff.removed.length} ~${acDiff.changed.length}`,
            )
          }
          // v3 灰度路由（仅 spec-author 适用）：第一次进 spec_review_loop 时基于 env 计算 usesV3Summary
          // 后续 resume / 跨轮直接读 stage.meta.usesV3Summary（避免 in-flight pipeline 因 env 变化漂移）
          if (role === 'spec-author' && requirementId) {
            const cachedFlag = (
              (state.stageResults as Array<{ meta?: { usesV3Summary?: boolean } }> | undefined)?.[index]?.meta?.usesV3Summary
            )
            if (cachedFlag !== undefined) {
              usesV3SummaryForMeta = cachedFlag  // 沿用上一轮缓存
            } else {
              const v3FlagEnabled = process.env.QI_SPEC_V3_SUMMARY === 'true'
              const v3Percent = Math.max(0, Math.min(100, parseInt(process.env.QI_SPEC_V3_SUMMARY_PERCENT ?? '0', 10) || 0))
              usesV3SummaryForMeta = v3FlagEnabled && requirementId % 100 < v3Percent
            }
          }
          // v3 metric：观测 LLM 输出健康指标 + 缓存灰度路由决定
          const metaPatch: Record<string, unknown> = {
            zodParseStatus: extendedOutput ? 'success' : 'failed',
            reviewHintsCount: Array.isArray((extendedOutput as { reviewHints?: unknown[] } | null)?.reviewHints)
              ? (extendedOutput as { reviewHints: unknown[] }).reviewHints.length
              : 0,
            confidenceLevel: (extendedOutput as { confidenceLevel?: string } | null)?.confidenceLevel ?? null,
          }
          if (usesV3SummaryForMeta !== undefined) metaPatch.usesV3Summary = usesV3SummaryForMeta
          await appendStageResult(ctxBase.runId, index, {
            round,
            decision: 'pass',
            summary: genResult.output.summary,
            skillOutput: extendedOutput ?? { summary: genResult.output.summary },
            evidence: extendedOutput?.evidence as { standardsConsulted?: string[]; selfCheck?: Array<{ item: string; passed: boolean; reason?: string }> } | undefined,
            artifactPath,
            acDiff,
            meta: metaPatch,
          }).catch((err) => {
            console.warn(`[graph-builder] appendStageResult failed (non-fatal): ${err}`)
          })
        }

        // 灰度路由：复用上面 appendStageResult 写入 metaPatch 时算好的 usesV3SummaryForMeta；
        // 若上轮已缓存到 stage.meta.usesV3Summary 则沿用（in-flight 跨轮一致）。
        const usesV3Summary: boolean = ((): boolean => {
          if (usesV3SummaryForMeta !== undefined) return usesV3SummaryForMeta
          const cached = (state.stageResults as Array<{ meta?: { usesV3Summary?: boolean } }> | undefined)?.[index]?.meta?.usesV3Summary
          return cached === true
        })()

        waiterRow = await createWaiter({
          requirementId,
          pipelineRunId: ctxBase.runId,
          nodeId,
          approvalKind,
          round,
          decisionSet: effectiveDecisionSet,
          contextSummary: (() => {
            const staticSummary = (params.contextSummary as string | null | undefined) ?? null
            if (staticSummary) return staticSummary
            if (!worktreePath || !requirementId) return null

            // ── final approval（已抽到 approval-summary/final.ts） ────────────────
            // baseApprovalKind 来自 params；approvalKind 可能被 shouldEscalate 升为 'escalation'，
            // 但 final 节点要按原 kind 处理。
            if (baseApprovalKind === 'final') {
              const stepOutputs = state.stepOutputs as Record<string, { output?: Record<string, unknown> }>
              const devOutput = stepOutputs?.dev_with_review_loop?.output as {
                review?: { summary?: string; decision?: string; notes?: Array<{ msg: string }>; fileRisks?: Array<{ file: string; role: string; impact: string; risk: 'high' | 'medium' | 'low'; focusOn: string }> }
                tasksDone?: string[]
                fixRounds?: number
              } | undefined
              const e2eOutput = stepOutputs?.qi_e2e_runner?.output as {
                result?: string
                scenariosRun?: number
                passed?: number
                failed?: number
                skipped?: boolean
                skipReason?: string
              } | undefined
              const { web, im } = buildFinalApprovalSummary({
                devOutput: devOutput ?? null,
                e2eOutput: e2eOutput ?? null,
                worktreePath,
              })
              pendingImSummary = im
              return web || null
            }

            // ── plan approval：v3 摘要 builder（PRD §3 step 5；含 stage 2 reviewer notes）──
            if (baseApprovalKind === 'plan') {
              const planPath = join(worktreePath, 'docs', 'plans', `qi-${requirementId}.md`)
              const planMdContent = existsSync(planPath) ? readFileSync(planPath, 'utf8') : ''

              const stepOutputs = state.stepOutputs as Record<string, { output?: Record<string, unknown> }>
              const planReviewLoopOutput = stepOutputs?.plan_review_loop?.output as
                | {
                    review?: { summary?: string; decision?: string; notes?: Array<{ severity?: string; msg: string; file?: string }> }
                    reviewHistory?: Array<{ round: number; output: Record<string, unknown> }>
                    skillOutput?: unknown
                    maxRoundsExceeded?: boolean
                  }
                | undefined
              const specReviewLoopOutput = stepOutputs?.spec_review_loop?.output as
                | { skillOutput?: unknown }
                | undefined

              // 优先用当前阶段重跑的 plan-decomposer 输出；fallback 到 stage 2 持久化的
              // （PRD #6 修后 stage 2 失败时也会持久化；PRD #4 修后 stage 3 round 1 不重跑，fallback 是主路径）
              const planSkillOutput =
                (currentSkillOutput as unknown as import('../quick-impl/role-output-schemas.js').PlanDecomposerOutputV3 | null) ??
                (planReviewLoopOutput?.skillOutput as
                  | import('../quick-impl/role-output-schemas.js').PlanDecomposerOutputV3
                  | undefined ??
                  null)

              const reviewHistory = planReviewLoopOutput?.reviewHistory ?? []
              const aiRejectRounds = reviewHistory.length || (planReviewLoopOutput?.maxRoundsExceeded ? 2 : 0)

              const { web, im } = buildPlanApprovalSummary({
                planSkillOutput,
                lastReview: planReviewLoopOutput?.review ?? null,
                reviewHistory,
                planMdContent,
                specOutput:
                  (specReviewLoopOutput?.skillOutput as
                    | import('../quick-impl/role-output-schemas.js').SpecAuthorOutput
                    | undefined) ?? null,
                round,
                aiRejectRounds,
              })
              pendingImSummary = im
              return web || planMdContent || null
            }

            // ── spec / escalation：v3 摘要 or fallback readFileSync(spec.md) ──
            const specPath = join(worktreePath, 'docs', 'specs', `qi-${requirementId}.md`)
            const specMdContent = existsSync(specPath) ? readFileSync(specPath, 'utf8') : ''

            if (!usesV3Summary) {
              return specMdContent || null  // 灰度未命中：保留旧行为
            }

            // 走 v3 摘要：直接用本作用域内已校验的 spec-author 结构化输出
            // （state.stageResults 是 LangGraph 内存态，appendStageResult 仅写 DB 不回写内存）
            const skillOutputForSummary = currentSkillOutput
            const acDiffForSummary = currentAcDiff

            // 读 .qi-context/feedback.md（round 2+ 才存在；不存在则空）
            let feedbackMd: string | null = null
            try {
              const fbPath = join(worktreePath, '.qi-context', 'feedback.md')
              if (existsSync(fbPath)) feedbackMd = readFileSync(fbPath, 'utf8')
            } catch {
              /* non-fatal */
            }

            const { web, im } = buildSpecApprovalSummary({
              skillOutput: skillOutputForSummary,
              specMdContent,
              round,
              acDiff: acDiffForSummary,
              feedbackMd,
              prevSkillOutput,
              budgetExtended: loopState.budgetUsed > 0,
            })
            pendingImSummary = im
            return web || null
          })(),
        })
      } else {
        waiterRow = existingWaiter
      }

      // interrupt() throws on first call; returns stored resume on replay.
      const interruptPayload: QiApprovalInterruptValue = {
        type: QI_APPROVAL_INTERRUPT,
        waiterId: waiterRow.id,
        runId: ctxBase.runId,
        nodeId,
        round,
        approvalKind: waiterRow.approvalKind,
        decisionSet: waiterRow.decisionSet,
        loopState,
        approverIds,
        requirementId,
        requirementTitle: String(params.title ?? triggerParams.title ?? ''),
        contextSummary: waiterRow.contextSummary,
        imSummary: pendingImSummary,
      }
      const resume = interrupt(interruptPayload) as QiApprovalResume

      // Restore loopState from resume.prevState so that lastCommit etc. are
      // available even when the generator was skipped on replay.
      loopState = { ...loopState, ...resume.prevState }

      const { decision } = resume.claimedWaiter

      if (decision === 'approved' || decision === 'force_passed') {
        if (params.statusOnSuccess && requirementId) {
          setRequirementStatus(requirementId, params.statusOnSuccess as any).catch(() => {})
        }
        const exec: StageExecutionResult = {
          status: 'success',
          output: `skill_with_approval approved at round ${round} (${decision})`,
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
          stepOutputs: {
            [(node as PipelineNode).id ?? stageName]: {
              status: 'success' as const,
              output: {
                round,
                decision,
                loopState,
                // 下游模板契约（docs/standards/skill-reviewer-design.md §5）：所有产出 artifact
                // 的 skill 节点必须暴露 lastArtifactPath（文件路径）+ skillOutput（完整 JSON）。
                lastArtifactPath: loopState.lastArtifactPath ?? artifactPath,
                skillOutput: loopState.lastSkillOutput,
              },
            },
          },
        }
      }

      if (decision === 'aborted') {
        if (requirementId) {
          await setRequirementStatus(requirementId, 'aborted' as any).catch(() => {})
        }
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `skill_with_approval aborted at round ${round}`,
          error: 'aborted',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
        }
      }

      // PRD §7 step 4：rejected_spec 暂当 abort（spec 升级路径见 follow-up PRD）。
      // rejectReason 加 [SPEC_REVISION_NEEDED] 前缀，以便后续 worker / 运营按前缀识别。
      if (decision === 'rejected_spec') {
        if (requirementId) {
          await setRequirementStatus(requirementId, 'aborted' as any).catch(() => {})
        }
        const humanReason = resume.claimedWaiter.rejectReason ?? '(no reason)'
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `skill_with_approval rejected_spec at round ${round}: [SPEC_REVISION_NEEDED] ${humanReason}`,
          error: 'spec_revision_needed',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
        }
      }

      if (decision === 'budget_extended') {
        loopState = {
          ...loopState,
          budgetUsed: computeNewBudget(loopState.budgetUsed, resume.claimedWaiter.budgetDelta ?? 1),
        }
        continue
      }

      // decision === 'rejected' | 'rejected_plan' (or null/unknown — treat as reject)
      // PRD §7 step 4：'rejected_plan' 与 'rejected' 共享 round++ 路径，区别仅在反馈语义（plan 锅 vs 通用拒绝）
      if (round >= maxRounds) {
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `skill_with_approval rejected, max rounds (${maxRounds}) reached`,
          error: 'max_rounds_exceeded',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
        }
      }

      loopState = {
        ...loopState,
        rejectHistory: [
          ...loopState.rejectHistory,
          {
            round,
            reason: resume.claimedWaiter.rejectReason ?? null,
            at: nowIso(),
            targetTaskId: resume.claimedWaiter.targetTaskId,
            citedAiNotes: resume.claimedWaiter.citedAiNotes,
          },
        ],
      }
      // continue to next round
    }
  }
}

/**
 * im_input — 单次 interrupt-bound 节点，让人工通过钉钉卡片 / Web UI 决策。
 *
 * 用于 Quick-Impl Phase 2：
 *   - kind='qi_e2e_intervention' — E2E 第 3 轮失败，3 按钮 fix/force_passed/aborted
 *   - kind='qi_sandbox_failed'   — sandbox provision 失败，2 按钮 retry/aborted (内部归 fix/aborted)
 *
 * 与 skill_with_approval 的差异：
 *   - 单次 interrupt，没有多轮 loop
 *   - 没有 generator 阶段（dev-loop 输出在前置节点已生成）
 *   - decisionSet 用新枚举值 'qi_e2e_intervention' / 'qi_sandbox_failed'
 *
 * resume 后输出：
 *   { decision, humanNote, decidedBy, decidedAt }
 * 下游用 switch 节点按 decision 分流。
 */
function buildImInputNode(
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
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `im_input param resolve failed: ${String(err)}`,
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    const requirementId = Number(params.requirementId ?? triggerParams.requirementId ?? 0)
    if (!requirementId) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: 'im_input: requirementId required',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    const kind = String(params.kind ?? '')
    if (kind !== 'qi_e2e_intervention' && kind !== 'qi_sandbox_failed') {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `im_input: kind must be 'qi_e2e_intervention' or 'qi_sandbox_failed', got "${kind}"`,
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    const approverIds = Array.isArray(params.approverIds)
      ? (params.approverIds as unknown[]).map((x) => String(x))
      : []
    const requirementTitle = String(params.requirementTitle ?? triggerParams.title ?? '')
    const contextSummary =
      typeof params.contextSummary === 'string' ? params.contextSummary :
      params.contextSummary != null ? JSON.stringify(params.contextSummary).slice(0, 1500) :
      null
    const nodeId = (node as PipelineNode).id ?? stageName

    // 复用 / 创建 waiter（replay 时可能已存在）
    let waiterRow: RequirementApprovalWaiter
    const existing = await getActiveWaiter(requirementId, nodeId)
    if (existing) {
      waiterRow = existing
    } else {
      waiterRow = await createWaiter({
        requirementId,
        pipelineRunId: ctxBase.runId,
        nodeId,
        approvalKind: kind as ApprovalKind,
        round: 1,
        decisionSet: kind as DecisionSet,
        contextSummary,
      })
    }

    const interruptPayload: QiImInputInterruptValue = {
      type: QI_IM_INPUT_INTERRUPT,
      waiterId: waiterRow.id,
      runId: ctxBase.runId,
      nodeId,
      kind,
      approverIds,
      requirementId,
      requirementTitle,
      contextSummary: waiterRow.contextSummary,
    }
    const resume = interrupt(interruptPayload) as QiImInputResume

    const decision = resume.claimedWaiter.decision ?? 'aborted'
    const humanNote = resume.claimedWaiter.rejectReason ?? null
    const decidedBy = resume.claimedWaiter.decidedBy ?? resume.claimedWaiter.claimedBy ?? null
    const decidedAt = resume.claimedWaiter.claimedAt
      ? resume.claimedWaiter.claimedAt.toISOString()
      : nowIso()

    const exec: StageExecutionResult = {
      status: 'success',
      output: `im_input ${kind} resolved: ${decision} by ${decidedBy ?? '(unknown)'}`,
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      stepOutputs: {
        [nodeId]: {
          status: 'success' as const,
          output: { decision, humanNote, decidedBy, decidedAt },
        },
      },
    }
  }
}

/**
 * skill_with_review — async multi-round loop with AI reviewer gate (no interrupt).
 *
 * Phase 1: runs dev generator → reviewer → if reviewer passes, success; if fail,
 * feed reviewer notes back into next round. Max rounds hard-stop.
 */
function buildSkillWithReviewNode(
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
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `skill_with_review param resolve failed: ${String(err)}`,
        error: String(err),
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    if (!ctxBase.skillExecutor) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: 'skill_with_review: skillExecutor not configured',
        error: 'no_skill_executor',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }
    const skillExecutor = ctxBase.skillExecutor

    const requirementId = Number(params.requirementId)
    const devSkill = String(params.devSkill ?? '')
    const devRole = String(params.devRole ?? '')
    const reviewerSkill = String(params.reviewerSkill ?? '')
    const reviewerRole = String(params.reviewerRole ?? '')
    const worktreePath = String(params.worktreePath ?? '')
    const branch = String(params.branch ?? '')
    const baseBranch = String(params.baseBranch ?? '')
    const artifactPath = String(params.artifactPath ?? '')
    const maxRounds = typeof params.maxRounds === 'number' ? params.maxRounds : 3
    const nodeId = (node as PipelineNode).id ?? stageName

    let reviewNotes: string | null = null
    // 跨轮累积：失败 path 持久化 reviewer notes 到 stepOutputs（PRD #6）
    const reviewHistory: Array<{ round: number; output: Record<string, unknown> }> = []
    let lastDevResult: Awaited<ReturnType<typeof runSkill>> | null = null
    let lastReviewResult: Awaited<ReturnType<typeof runSkill>> | null = null

    for (let round = 1; round <= maxRounds; round++) {
      let devResult: Awaited<ReturnType<typeof runSkill>>
      try {
        devResult = await runSkill(
          {
            requirementId,
            nodeId: `${nodeId}:dev:r${round}`,
            skill: devSkill,
            role: devRole,
            worktreePath,
            branch,
            baseBranch,
            artifactPath,
            inputs: {
              round,
              reviewNotes,
              ...((params.inputs as SkillContextInputs) ?? {}),
            },
            specSources: params.specSources as string[] | undefined,
          },
          skillExecutor,
          ctxBase.mcpServerPath,
        )
      } catch (err) {
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `skill_with_review round ${round} dev generator failed: ${String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
        }
      }

      if (devResult.output.decision === 'fail') {
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `skill_with_review round ${round} dev decision=fail: ${devResult.output.summary}`,
          error: 'dev_fail',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
        }
      }

      let reviewResult: Awaited<ReturnType<typeof runSkill>>
      try {
        reviewResult = await runSkill(
          {
            requirementId,
            nodeId: `${nodeId}:review:r${round}`,
            skill: reviewerSkill,
            role: reviewerRole,
            worktreePath,
            branch,
            baseBranch,
            artifactPath,
            inputs: {
              round,
              devOutput: devResult.output,
              ...((params.reviewerInputs as SkillContextInputs) ?? {}),
            },
            specSources: params.specSources as string[] | undefined,
          },
          skillExecutor,
          ctxBase.mcpServerPath,
        )
      } catch (err) {
        if (err instanceof SkillOutputParseError && round < maxRounds) {
          // reviewer JSON 格式错误 — 视为本轮无效，继续下一轮让 dev 重试
          console.warn(`[skill-with-review] round ${round} reviewer parse error, retrying next round: ${err.message}`)
          reviewNotes = `上一轮 reviewer 输出 JSON 格式解析失败，请本轮确保严格输出合法 JSON。`
          continue
        }
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `skill_with_review round ${round} reviewer failed: ${String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
        }
      }

      if (reviewResult.output.decision !== 'fail') {
        if (params.statusOnSuccess && requirementId) {
          setRequirementStatus(requirementId, params.statusOnSuccess as any).catch(() => {})
        }
        const exec: StageExecutionResult = {
          status: 'success',
          output: `skill_with_review passed at round ${round}: ${reviewResult.output.summary}`,
        }
        const extendedDevOutput = parseFencedJsonFromRaw(devResult.rawOutput) ?? devResult.output
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
          stepOutputs: {
            [(node as PipelineNode).id ?? stageName]: {
              status: 'success' as const,
              output: {
                round,
                review: reviewResult.output,
                tasksDone: (devResult.output as { tasksDone?: unknown[] }).tasksDone ?? [],
                fixRounds: round - 1,
                lastArtifactPath: artifactPath,
                skillOutput: extendedDevOutput,
              },
            },
          },
        }
      }

      // review 判 fail：累积历史，供 max_rounds_exceeded 的 stepOutputs 用（PRD #6）
      lastDevResult = devResult
      lastReviewResult = reviewResult
      reviewHistory.push({ round, output: reviewResult.output as Record<string, unknown> })

      reviewNotes =
        reviewResult.output.notes?.map((n) => n.msg).join('\n') ??
        reviewResult.output.summary
    }

    const exec: StageExecutionResult = {
      status: 'failed',
      output: `skill_with_review: max rounds (${maxRounds}) exceeded without passing review`,
      error: 'max_rounds_exceeded',
    }
    // PRD #6：失败 path 也写 stepOutputs，让下游 plan_human_escalation
    // 能通过 {{steps.<id>.output.review.notes}} 模板拿到 AI reviewer 拒绝原因。
    const failedStepOutput: Record<string, unknown> = {
      maxRoundsExceeded: true,
      reviewHistory,
      lastArtifactPath: artifactPath,
    }
    if (lastReviewResult) {
      failedStepOutput.review = lastReviewResult.output
    }
    if (lastDevResult) {
      const extendedLastDevOutput =
        parseFencedJsonFromRaw(lastDevResult.rawOutput) ?? lastDevResult.output
      failedStepOutput.skillOutput = extendedLastDevOutput
      failedStepOutput.tasksDone =
        (lastDevResult.output as { tasksDone?: unknown[] }).tasksDone ?? []
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      stepOutputs: {
        [(node as PipelineNode).id ?? stageName]: {
          status: 'failed' as const,
          output: failedStepOutput,
        },
      },
    }
  }
}

/**
 * llm_author — 调一次 runSkill() 跑 author role，输出 artifact 文件 + skillOutput。
 * 不在节点内 commit（commit 留给 git_commit_push 节点）。
 * round 从 graph state 的 stageResults 计算；上轮 reviewer/human notes 从同前缀节点读取。
 */
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
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `llm_author param resolve failed: ${String(err)}`,
        error: String(err),
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    if (!ctxBase.skillExecutor) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: 'llm_author: skillExecutor not configured',
        error: 'no_skill_executor',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }
    const skillExecutor = ctxBase.skillExecutor

    const requirementId = Number(params.requirementId ?? triggerParams?.requirementId)
    const skill = String(params.skill ?? '')
    const role = String(params.role ?? '')
    const worktreePath = String(params.worktreePath ?? '')
    const branch = String(params.branch ?? '')
    const baseBranch = String(params.baseBranch ?? 'main')
    const artifactPath = String(params.artifactPath ?? '')

    if (!requirementId) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: 'llm_author: requirementId required',
        error: 'missing_requirement_id',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    if (!skill || !role) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `llm_author: skill and role required (skill=${skill}, role=${role})`,
        error: 'missing_skill_or_role',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    if (!worktreePath || !branch || !artifactPath) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `llm_author: worktreePath, branch, artifactPath required`,
        error: 'missing_path_params',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }

    // round 计算：数 stageResults 中本节点 name 已出现几次
    const past = (state.stageResults ?? []).filter(r => r.name === stageName)
    const round = past.length + 1

    // 上轮 notes 读取（从 state 找对应的 ai_review / human_gate 节点最新输出）
    // 约定：authorNodeName 形如 `spec_author` → 对应 `spec_ai_review` / `spec_human_gate`
    const phasePrefix = node.name.replace(/_author$/, '')
    const aiReviewNodeName = nodeStageResultName({ name: `${phasePrefix}_ai_review` } as PipelineNode)
    const humanGateNodeName = nodeStageResultName({ name: `${phasePrefix}_human_gate` } as PipelineNode)

    let priorReviewerNotes: string | null = null
    let priorHumanNotes: string | null = null
    for (let i = (state.stageResults ?? []).length - 1; i >= 0; i--) {
      const r = (state.stageResults ?? [])[i]
      if (priorReviewerNotes === null && r.name === aiReviewNodeName) {
        priorReviewerNotes = (r.output as { notes?: string })?.notes ?? null
      }
      if (priorHumanNotes === null && r.name === humanGateNodeName) {
        priorHumanNotes = (r.output as { humanNotes?: string })?.humanNotes ?? null
      }
      if (priorReviewerNotes !== null && priorHumanNotes !== null) break
    }

    const inputs: SkillContextInputs = {
      round,
      priorReviewerNotes,
      priorHumanNotes,
      ...((params.inputs as SkillContextInputs) ?? {}),
    }

    try {
      const result = await runSkill(
        {
          requirementId,
          nodeId: `${node.name}:r${round}`,
          skill,
          role,
          worktreePath,
          branch,
          baseBranch,
          artifactPath,
          inputs,
          specSources: params.specSources as string[] | undefined,
          previousRound: round > 1 && (priorReviewerNotes !== null || priorHumanNotes !== null)
            ? {
                round: round - 1,
                decision: 'rejected',
                reviewerNotes: priorReviewerNotes
                  ? [{ severity: 'error' as const, msg: priorReviewerNotes }]
                  : undefined,
                rejectReason: priorHumanNotes ?? undefined,
              }
            : undefined,
        },
        skillExecutor,
        ctxBase.mcpServerPath,
      )

      if (result.output.decision === 'fail') {
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `llm_author decision=fail: ${result.output.summary}`,
          error: 'llm_author_fail',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
          stepOutputs: {
            [(node as PipelineNode).id ?? stageName]: {
              status: 'failed' as const,
              output: {
                artifactPath,
                skillOutput: parseFencedJsonFromRaw(result.rawOutput) ?? result.output,
                round,
              },
            },
          },
        }
      }

      const exec: StageExecutionResult = {
        status: 'success',
        output: `llm_author round ${round} succeeded: ${result.output.summary ?? ''}`,
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
        stepOutputs: {
          [(node as PipelineNode).id ?? stageName]: {
            status: 'success' as const,
            output: {
              artifactPath,
              skillOutput: parseFencedJsonFromRaw(result.rawOutput) ?? result.output,
              round,
              lastArtifactPath: artifactPath,
            },
          },
        },
      }
    } catch (err) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: `llm_author round ${round} failed: ${String(err)}`,
        error: err instanceof Error ? err.message : String(err),
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      }
    }
  }
}

// skip_rest node: mark every stage at/after startIndex as skipped so the
// StageResult list reflects the truncation, then flow to END.
function buildSkipRestNode(stages: StageDefinition[], startIndex: number) {
  return async () => {
    const patches: StageResult[] = []
    for (let j = startIndex; j < stages.length; j++) {
      patches.push({
        name: stages[j].name,
        type: stages[j].stageType,
        status: 'skipped',
      })
    }
    if (patches.length === 0) return {}
    return { stageResults: patches }
  }
}

function skipRestName(index: number): string {
  return `skip_rest_after_${index}`
}

/**
 * Compile a StageDefinition[] into an uncompiled LangGraph StateGraph.
 *
 * The returned builder still needs `.compile({ checkpointer })` by the caller
 * — the executor uses PostgresSaver, tests use MemorySaver.
 *
 * Node naming: `stage_<index>_<type>`. Each stage also gets a paired
 * `skip_rest_after_<index>` node that marks downstream stages as skipped
 * when `onFailure === 'stop'` takes effect.
 *
 * Legacy wrapper: delegates to buildGraphFromPipeline after internal
 * linearization so the two code paths never diverge.
 */
export function buildGraphFromStages(
  input: BuildGraphInput,
): StateGraph<typeof PipelineStateAnnotation.State> {
  return buildGraphFromPipeline({
    graph: linearizeStagesForBuilder(input.stages),
    stageContext: input.stageContext,
    hooks: input.hooks,
    triggerParams: input.triggerParams,
  })
}

// Internal fallback: build a linear PipelineGraph from legacy stages.
// Distinct from graph-migration.linearizeStages — that one uses ULIDs and
// x/y coordinates for the canvas; this one uses deterministic n<i> ids
// so legacy tests/fixtures stay stable.
function linearizeStagesForBuilder(stages: StageDefinition[]): PipelineGraph {
  const nodes = stages.map((s, i) => ({
    ...s, id: `n${i}`, position: { x: 0, y: i * 100 },
  }))
  const edges: PipelineEdge[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ id: `e${i}`, source: nodes[i].id, target: nodes[i + 1].id })
  }
  return { nodes, edges }
}

// ---- PipelineGraph-based builder with conditional edges -----------------

export interface BuildPipelineGraphInput {
  graph: PipelineGraph
  stageContext: StageContextBase
  hooks: StageHooks
  triggerParams?: Record<string, unknown>
}

// Safe expression evaluator. Uses parseExpression engine (evalExpression).
export function conditionMatches(
  cond: ConditionSpec | undefined,
  result: StageResult,
  state: typeof PipelineStateAnnotation.State,
  triggerParams: Record<string, unknown> | undefined,
): boolean {
  if (!cond) return true
  if (cond.kind === 'onSuccess') return result.status === 'success'
  if (cond.kind === 'onFailure') return result.status === 'failed'
  if (cond.kind === 'expression') {
    const ctx = {
      status: result.status,
      output: result.output,
      steps: state.stepOutputs,
      vars: state.runtimeVars,
      triggerParams: triggerParams ?? {},
    }
    try {
      return evalExpression(cond.expression, ctx)
    } catch {
      return false
    }
  }
  return false
}

/**
 * Compile a PipelineGraph into an uncompiled LangGraph StateGraph.
 *
 * For each node, registers the appropriate stage action + a paired
 * skip_rest sink. Out-edges are assembled via addConditionalEdges with
 * a router that:
 *   1. Respects stage-level onFailure: 'stop' (→ skip sink)
 *   2. Picks the first out-edge whose condition matches
 *   3. Falls through to END if no condition matches
 */
export function buildGraphFromPipeline(
  input: BuildPipelineGraphInput,
): StateGraph<typeof PipelineStateAnnotation.State> {
  const { graph, stageContext, hooks, triggerParams } = input
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder: any = new StateGraph(PipelineStateAnnotation)

  if (graph.nodes.length === 0) {
    builder = builder.addEdge(START, END)
    return builder as StateGraph<typeof PipelineStateAnnotation.State>
  }

  const idToName = new Map(graph.nodes.map((n, i) => [n.id, nodeName(i, n)]))

  // Stage types that have external side effects (send messages, modify DB,
  // run scripts, trigger approvals, make HTTP calls). These are intercepted
  // by the dryRunFlavor wrapper when present.
  // wait_webhook is excluded: it uses its own interrupt loop and is not
  // wrapped (the user triggers it externally).
  const SIDE_EFFECT_TYPES = new Set<string>(['script', 'dm', 'db_update', 'http', 'approval'])

  /**
   * Wraps a side-effect node with a dryRunFlavor interrupt.
   *
   * Flow:
   *   1. Call beforeSideEffect → get decision (real/stub/manual)
   *   2. 'real': run the actual node, then recordSnapshot(source='real')
   *   3. 'stub' / 'manual': skip the real node, construct stepOutputs from
   *      decision.output, then recordSnapshot(source=decision)
   */
  function wrapSideEffect(
    node: PipelineGraph['nodes'][number],
    index: number,
    realNodeFn: (state: typeof PipelineStateAnnotation.State) => Promise<unknown>,
  ): (state: typeof PipelineStateAnnotation.State) => Promise<unknown> {
    const dr = hooks.dryRunFlavor!
    return async (state: typeof PipelineStateAnnotation.State) => {
      const startedAt = Date.now()
      const params = (node as unknown as { params?: unknown }).params
      const { decision, output: decisionOutput } = await dr.beforeSideEffect(node.id, node.stageType, params)

      if (decision === 'real') {
        const result = await realNodeFn(state) as Record<string, unknown>
        // Extract the stepOutput produced by the real node (if any)
        const stepOutput = (result?.stepOutputs as Record<string, unknown> | undefined)?.[node.id] as
          { status?: string; output?: unknown } | undefined
        const outputVal = (stepOutput?.output ?? {}) as Record<string, unknown>
        const status = (stepOutput?.status ?? 'success') as 'success' | 'failed' | 'skipped'
        await dr.recordSnapshot(node.id, {
          status,
          output: outputVal,
          source: 'real',
          durationMs: Date.now() - startedAt,
        })
        return result
      }

      // stub or manual: skip real execution, use provided output
      const output = decisionOutput ?? {}
      await dr.recordSnapshot(node.id, {
        status: 'success',
        output,
        source: decision,
        durationMs: Date.now() - startedAt,
      })
      return {
        currentStageIndex: index,
        stageResults: {
          name: node.name,
          status: 'success' as const,
          output: JSON.stringify(output),
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
        },
        stepOutputs: { [node.id]: { status: 'success' as const, output } },
      }
    }
  }

  /**
   * Wraps a non-side-effect node with a snapshot recorder (source='real' always).
   * Only active when dryRunFlavor is present.
   */
  function wrapWithSnapshot(
    node: PipelineGraph['nodes'][number],
    index: number,
    fn: (state: typeof PipelineStateAnnotation.State) => Promise<unknown>,
  ): (state: typeof PipelineStateAnnotation.State) => Promise<unknown> {
    if (!hooks.dryRunFlavor) return fn
    const dr = hooks.dryRunFlavor
    return async (state: typeof PipelineStateAnnotation.State) => {
      const startedAt = Date.now()
      const result = await fn(state) as Record<string, unknown>
      const stepOutput = (result?.stepOutputs as Record<string, unknown> | undefined)?.[node.id] as
        { status?: string; output?: unknown } | undefined
      const outputVal = (stepOutput?.output ?? {}) as Record<string, unknown>
      const status = (stepOutput?.status ?? 'success') as 'success' | 'failed' | 'skipped'
      await dr.recordSnapshot(node.id, {
        status,
        output: outputVal,
        source: 'real',
        durationMs: Date.now() - startedAt,
      })
      return result
    }
  }

  // addNode
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]
    const name = idToName.get(node.id)!

    // Build the base node function per stageType, then apply dryRunFlavor wrapping.
    switch (node.stageType) {
      case 'script':
      case 'approval':
      case 'dm':
      case 'db_update':
      case 'http':
      case 'mr_create':
      case 'git_commit_push': {
        // ---- Side-effect nodes: optionally wrapped with dryRunFlavor interrupt ----
        let realFn: (state: typeof PipelineStateAnnotation.State) => Promise<unknown>
        if (node.stageType === 'script') {
          realFn = buildScriptNode(node, i, stageContext, hooks, triggerParams) as typeof realFn
        } else if (node.stageType === 'approval') {
          realFn = buildApprovalNode(node, i, stageContext, triggerParams) as typeof realFn
        } else {
          // dm / db_update / http / mr_create / git_commit_push — generic NodeExecutor dispatch
          realFn = buildExecutorNode(node, i, stageContext, triggerParams ?? {}) as typeof realFn
        }
        const nodeFn = hooks.dryRunFlavor
          ? wrapSideEffect(node, i, realFn)
          : realFn
        builder = builder.addNode(name, nodeFn)
        break
      }

      case 'llm_agent':
        builder = builder.addNode(name, wrapWithSnapshot(node, i,
          buildCapabilityNode(node, i, stageContext, hooks, triggerParams) as (state: typeof PipelineStateAnnotation.State) => Promise<unknown>))
        break

      case 'wait_webhook':
        // Not wrapped: wait_webhook uses its own interrupt loop + external trigger.
        builder = builder.addNode(name, buildWaitWebhookNode(node, i, stageContext))
        break

      // Non-side-effect NodeExecutor-backed types — wrap with snapshot recorder when dryRunFlavor present.
      case 'end':
      case 'cleanup':
      case 'sql_query':
      case 'file_read':
      case 'template_render':
      case 'fan_out':
      case 'switch':
      case 'init_qi_branch':
      case 'e2e_stub':
      case 'qi_e2e_runner':
        builder = builder.addNode(name, wrapWithSnapshot(node, i,
          buildExecutorNode(node, i, stageContext, triggerParams ?? {}) as (state: typeof PipelineStateAnnotation.State) => Promise<unknown>))
        break

      case 'skill_node':
        builder = builder.addNode(name, buildSkillNode(node, i, stageContext, triggerParams ?? {}))
        break

      case 'skill_with_approval':
        builder = builder.addNode(name, buildSkillWithApprovalNode(node, i, stageContext, triggerParams ?? {}))
        break

      case 'skill_with_review':
        builder = builder.addNode(name, buildSkillWithReviewNode(node, i, stageContext, triggerParams ?? {}))
        break

      case 'im_input':
        builder = builder.addNode(name, buildImInputNode(node, i, stageContext, triggerParams ?? {}))
        break

      case 'llm_author':
        builder = builder.addNode(name, buildLlmAuthorNode(node, i, stageContext, triggerParams ?? {}))
        break

      default: {
        const unknown: never = node.stageType
        throw new Error(`Unsupported stage type: ${String(unknown)}`)
      }
    }

    builder = builder.addNode(skipRestName(i), buildSkipRestNode(graph.nodes, i + 1))
  }

  // Entry: first node without an incoming edge; fallback to node[0].
  const hasIncoming = new Set(graph.edges.map(e => e.target))
  const entry = graph.nodes.find(n => !hasIncoming.has(n.id)) ?? graph.nodes[0]
  builder = builder.addEdge(START, idToName.get(entry.id)!)

  // Group out-edges by source.
  const outBySource = new Map<string, PipelineEdge[]>()
  for (const e of graph.edges) {
    const arr = outBySource.get(e.source) ?? []
    arr.push(e)
    outBySource.set(e.source, arr)
  }

  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]
    const name = idToName.get(node.id)!
    const skipName = skipRestName(i)
    const outs = outBySource.get(node.id) ?? []

    if (outs.length === 0) {
      // Terminal node → END (with skip_rest guard for onFailure=stop).
      const lookupName = nodeStageResultName(node)
      builder = builder.addConditionalEdges(name, (state: typeof PipelineStateAnnotation.State) => {
        const result = state.stageResults.find((r) => r.name === lookupName)
        if (result && shouldStopAfter(node, result)) return skipName
        return END
      }, { [END]: END, [skipName]: skipName })
      builder = builder.addEdge(skipName, END)
      continue
    }

    const routeMap: Record<string, string> = { [skipName]: skipName, [END]: END }
    for (const e of outs) {
      const targetName = idToName.get(e.target)!
      routeMap[targetName] = targetName
    }

    const lookupName = nodeStageResultName(node)

    if (node.stageType === 'switch') {
      builder = builder.addConditionalEdges(name, (state: typeof PipelineStateAnnotation.State) => {
        const result = state.stageResults.find(r => r.name === lookupName)
        if (result && shouldStopAfter(node, result)) return skipName
        if (!result || result.status === 'failed') return skipName  // 求值错走 sink
        const stepOutput = state.stepOutputs[node.id]
        const matchedTarget = (stepOutput?.output as { matchedTarget?: unknown } | undefined)?.matchedTarget
        if (typeof matchedTarget !== 'string') return END
        const targetName = idToName.get(matchedTarget)
        if (!targetName || !routeMap[targetName]) return END
        return targetName
      }, routeMap)
      builder = builder.addEdge(skipName, END)
      continue
    }

    builder = builder.addConditionalEdges(name, (state: typeof PipelineStateAnnotation.State) => {
      const result = state.stageResults.find((r) => r.name === lookupName)
      if (!result) return idToName.get(outs[0].target) ?? END
      if (shouldStopAfter(node, result)) return skipName
      for (const e of outs) {
        if (conditionMatches(e.condition, result, state, triggerParams)) return idToName.get(e.target)!
      }
      return END
    }, routeMap)

    builder = builder.addEdge(skipName, END)
  }

  return builder as StateGraph<typeof PipelineStateAnnotation.State>
}
