import { StateGraph, START, END, interrupt } from '@langchain/langgraph'
import { PipelineStateAnnotation, type StageResult } from './graph-state.js'
import type {
  StageDefinition,
  StageContext,
  StageExecutionResult,
  ServerInfo,
} from './types.js'
import { resolveApprovers } from './approval-resolvers.js'

// Hooks let the builder stay agnostic of SSH / capability implementations.
// The executor (Task 4) wires real implementations; tests wire plain stubs.
export interface StageHooks {
  runScript(
    stage: StageDefinition,
    ctx: StageContext,
    targetServers: ServerInfo[],
  ): Promise<StageExecutionResult>
  runCapability(
    stage: StageDefinition,
    ctx: StageContext,
    triggerParams?: Record<string, unknown>,
  ): Promise<StageExecutionResult>
}

// StageContext minus stageIndex — the builder fills stageIndex per node.
export type StageContextBase = Omit<StageContext, 'stageIndex'>

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

// Resolve target servers from the stage context using targetRoles.
// Mirrors executor.ts behaviour: empty targetRoles falls back to every
// server bound to any role in the run.
function resolveTargetServers(
  stage: StageDefinition,
  servers: Record<string, ServerInfo[]>,
): ServerInfo[] {
  if (stage.targetRoles.length > 0) {
    return stage.targetRoles.flatMap((role) => servers[role] ?? [])
  }
  return Object.values(servers).flat()
}

function nowIso(): string {
  return new Date().toISOString()
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
) {
  return async () => {
    const targetServers = resolveTargetServers(stage, ctxBase.servers)
    if (targetServers.length === 0) {
      return {
        currentStageIndex: index,
        stageResults: skippedResult(stage, 'No servers for target roles'),
      }
    }
    const startedAt = nowIso()
    const startedMs = Date.now()
    const ctx: StageContext = { ...ctxBase, stageIndex: index }
    let exec: StageExecutionResult
    try {
      exec = await hooks.runScript(stage, ctx, targetServers)
    } catch (err) {
      exec = {
        status: 'failed',
        output: `script hook error: ${String(err)}`,
        error: String(err),
      }
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
    }
  }
}

function buildCapabilityNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
  hooks: StageHooks,
  triggerParams?: Record<string, unknown>,
) {
  return async () => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const ctx: StageContext = { ...ctxBase, stageIndex: index }
    let exec: StageExecutionResult
    try {
      exec = await hooks.runCapability(stage, ctx, triggerParams)
    } catch (err) {
      exec = {
        status: 'failed',
        output: `capability hook error: ${String(err)}`,
        error: String(err),
      }
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
    }
  }
}

function buildApprovalNode(
  stage: StageDefinition,
  index: number,
  triggerParams?: Record<string, unknown>,
) {
  return async () => {
    const startedAt = nowIso()
    const startedMs = Date.now()

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

function buildWaitWebhookNode(stage: StageDefinition, index: number) {
  return async () => {
    const startedAt = nowIso()
    const startedMs = Date.now()
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

function extractRuntimeVars(
  tag: string,
  data: unknown,
): Record<string, unknown> | null {
  if (data === undefined) return null
  if (isPlainObject(data)) return { ...data }
  return { [`__webhook_${tag}`]: data }
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

// Router for stage i: reads the matching StageResult from state and decides
// success|continue → next stage (or END), failed+stop → skip_rest sink.
function buildRouter(stages: StageDefinition[], index: number) {
  const stage = stages[index]
  const isLast = index === stages.length - 1
  const nextNode = isLast ? END : nodeName(index + 1, stages[index + 1])
  const skipNode = skipRestName(index)
  return (state: typeof PipelineStateAnnotation.State): string => {
    const result = state.stageResults.find((r) => r.name === stage.name)
    // Missing result falls through to the next node — stage nodes always
    // write a result on exit, so this branch is purely defensive.
    if (!result) return nextNode
    if (shouldStopAfter(stage, result)) return skipNode
    return nextNode
  }
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
 */
export function buildGraphFromStages(
  input: BuildGraphInput,
): ReturnType<typeof makeBuilder> {
  return makeBuilder(input)
}

// makeBuilder keeps the dynamic node union hidden from the public signature:
// addNode widens N step by step, so we cast at the boundary.
function makeBuilder(input: BuildGraphInput) {
  const { stages, stageContext, hooks, triggerParams } = input
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let graph: any = new StateGraph(PipelineStateAnnotation)

  if (stages.length === 0) {
    graph = graph.addEdge(START, END)
    return graph as StateGraph<typeof PipelineStateAnnotation.State>
  }

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]
    const name = nodeName(i, stage)
    switch (stage.stageType) {
      case 'script':
        graph = graph.addNode(name, buildScriptNode(stage, i, stageContext, hooks))
        break
      case 'capability':
        graph = graph.addNode(
          name,
          buildCapabilityNode(stage, i, stageContext, hooks, triggerParams),
        )
        break
      case 'approval':
        graph = graph.addNode(name, buildApprovalNode(stage, i, triggerParams))
        break
      case 'wait_webhook':
        graph = graph.addNode(name, buildWaitWebhookNode(stage, i))
        break
      default: {
        const unknown: never = stage.stageType
        throw new Error(`Unsupported stage type: ${String(unknown)}`)
      }
    }
    graph = graph.addNode(skipRestName(i), buildSkipRestNode(stages, i + 1))
  }

  graph = graph.addEdge(START, nodeName(0, stages[0]))
  for (let i = 0; i < stages.length; i++) {
    const name = nodeName(i, stages[i])
    const isLast = i === stages.length - 1
    const nextName = isLast ? END : nodeName(i + 1, stages[i + 1])
    const skipName = skipRestName(i)
    graph = graph.addConditionalEdges(name, buildRouter(stages, i), {
      [nextName]: nextName,
      [skipName]: skipName,
    })
    graph = graph.addEdge(skipName, END)
  }

  return graph as StateGraph<typeof PipelineStateAnnotation.State>
}
