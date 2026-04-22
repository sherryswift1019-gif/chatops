import { StateGraph, START, END, interrupt } from '@langchain/langgraph'
import { PipelineStateAnnotation, type StageResult } from './graph-state.js'
import { consultImInputAgent } from './im-input-agent.js'
import type {
  StageDefinition,
  StageContext,
  StageExecutionResult,
  ServerInfo,
  PipelineGraph,
  PipelineEdge,
  ConditionSpec,
} from './types.js'

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
    runtimeVars?: Record<string, unknown>,
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
export const IM_INPUT_INTERRUPT = 'im_input' as const
export const APPROVAL_APPROVED = 'approved' as const
export const APPROVAL_REJECTED = 'rejected' as const
/** graph-runner 侧注入以示超时结束（handler 捕获后把 stage 标为 failed）。 */
export const IM_INPUT_TIMEOUT_SENTINEL = '__im_input_timeout__' as const
/** graph-runner 侧注入以示用户显式取消。 */
export const IM_INPUT_CANCEL_SENTINEL = '__im_input_cancel__' as const
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

/**
 * im_input stage interrupt payload. graph-runner 根据 kind 路由到 im-router
 * 注册 waiter 并把 prompt 推到 IM 群，等待用户消息作为 resume value（string）。
 */
export interface ImInputInterruptValue {
  type: typeof IM_INPUT_INTERRUPT
  stageIndex: number
  stageName: string
  platform: string
  groupId: string
  prompt: string
  paramSchema: Record<string, unknown>
  collectedSoFar: Record<string, unknown>
  timeoutSeconds: number
}

/**
 * im_input resume value：正常情况下是用户 IM 消息（string）；
 * 超时/取消时 graph-runner 注入 sentinel 常量。
 */
export type ImInputResume = string

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
  return async (state: typeof PipelineStateAnnotation.State) => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const ctx: StageContext = { ...ctxBase, stageIndex: index }
    const runtimeVars = state.runtimeVars
    let exec: StageExecutionResult
    try {
      exec = await hooks.runCapability(stage, ctx, triggerParams, runtimeVars)
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

function buildApprovalNode(stage: StageDefinition, index: number) {
  return async () => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const payload: ApprovalInterruptValue = {
      type: APPROVAL_INTERRUPT,
      stageIndex: index,
      approverIds: stage.approverIds ?? [],
      description: stage.approvalDescription ?? stage.name,
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

/**
 * im_input 节点：对话式采集参数。
 *
 * 工作流程：
 *   1. 进入时从 runtimeVars 读回已采集参数（用于 resume 场景）；
 *   2. interrupt() 挂起，等 IM 消息作 resume value；
 *   3. 消息交 consultImInputAgent 判定：done/aborted/continue；
 *   4. continue → 回到第 2 步继续 interrupt（下一轮用更新后的 prompt）；
 *   5. done → 返回 success StageResult + 参数合入 runtimeVars；
 *      aborted/timeout → 返回 failed StageResult。
 *
 * resume value 约定：
 *   - string：用户 IM 消息（正常路径）
 *   - IM_INPUT_TIMEOUT_SENTINEL：graph-runner 超时定时器触发
 *   - IM_INPUT_CANCEL_SENTINEL：系统显式取消
 */
function buildImInputNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
) {
  return async (state: typeof PipelineStateAnnotation.State) => {
    const cfg = stage.imInputConfig
    const startedAt = nowIso()
    const startedMs = Date.now()

    if (!cfg) {
      const exec: StageExecutionResult = {
        status: 'failed',
        output: 'imInputConfig missing on im_input stage',
        error: 'imInputConfig missing',
      }
      return {
        currentStageIndex: index,
        stageResults: finishedResult(stage, startedAt, startedMs, exec),
      }
    }

    const platform = ctxBase.triggerPlatform ?? ''
    const groupId = ctxBase.triggerGroupId ?? ''
    const timeoutSeconds = cfg.timeoutSeconds ?? 600

    // 从 runtimeVars 读回上一轮 resume 前保存的参数快照（支持多轮 interrupt）。
    // 以 `__im_input_collected_<index>` 为 key，避免污染业务 runtimeVars。
    const collectedKey = `__im_input_collected_${index}`
    let collected: Record<string, unknown> =
      (state.runtimeVars?.[collectedKey] as Record<string, unknown> | undefined) ?? {}
    let nextPrompt = cfg.prompt

    // 多轮 interrupt 循环：每轮等一条 IM 消息
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const payload: ImInputInterruptValue = {
        type: IM_INPUT_INTERRUPT,
        stageIndex: index,
        stageName: stage.name,
        platform,
        groupId,
        prompt: nextPrompt,
        paramSchema: cfg.paramSchema,
        collectedSoFar: collected,
        timeoutSeconds,
      }
      const resume = interrupt(payload) as ImInputResume

      // 系统注入的 sentinel：超时/取消
      if (resume === IM_INPUT_TIMEOUT_SENTINEL) {
        const exec: StageExecutionResult = {
          status: 'failed',
          output: `IM 输入超时（${timeoutSeconds}s 未回复）`,
          error: 'im_input_timeout',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult(stage, startedAt, startedMs, exec),
        }
      }
      if (resume === IM_INPUT_CANCEL_SENTINEL) {
        const exec: StageExecutionResult = {
          status: 'failed',
          output: '系统取消 IM 输入',
          error: 'im_input_cancelled',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult(stage, startedAt, startedMs, exec),
        }
      }

      const r = await consultImInputAgent({
        userMessage: String(resume),
        currentParams: collected,
        paramSchema: cfg.paramSchema,
      })

      if (r.aborted) {
        const exec: StageExecutionResult = {
          status: 'failed',
          output: '用户取消',
          error: 'user_cancelled',
        }
        return {
          currentStageIndex: index,
          stageResults: finishedResult(stage, startedAt, startedMs, exec),
        }
      }

      collected = r.params
      if (r.done) {
        const exec: StageExecutionResult = {
          status: 'success',
          output: JSON.stringify(collected),
        }
        // 参数进入 runtimeVars 供下游 stage 变量解析使用；同时保留快照
        return {
          currentStageIndex: index,
          stageResults: finishedResult(stage, startedAt, startedMs, exec),
          runtimeVars: {
            ...collected,
            [collectedKey]: collected,
          },
        }
      }

      // 还缺参数：更新 prompt，同时把当前快照落盘，下次 interrupt 入参时能读回
      nextPrompt = r.nextPrompt ?? cfg.prompt
      // NOTE: 由于 handler 只有在 return 时写入 state，while loop 内的
      // collected 变量本身会跨 interrupt 保留（闭包），无需显式写 state。
      // collectedKey 快照仅在"handler 异常中断后恢复"时起作用，此处由
      // 最终 return 覆盖。
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

// Safe expression evaluator. Only two templates are accepted:
//   - status === 'success' | 'failed' | 'skipped'
//   - output.includes('...')
// Anything else returns false, avoiding eval / new Function.
function conditionMatches(cond: ConditionSpec | undefined, result: StageResult): boolean {
  if (!cond) return true
  if (cond.kind === 'onSuccess') return result.status === 'success'
  if (cond.kind === 'onFailure') return result.status === 'failed'
  // expression
  const expr = cond.expression.trim()
  const statusMatch = expr.match(/^status\s*===\s*'(success|failed|skipped)'$/)
  if (statusMatch) return result.status === statusMatch[1]
  const outputMatch = expr.match(/^output\.includes\(['"]([^'"]+)['"]\)$/)
  if (outputMatch) return (result.output ?? '').includes(outputMatch[1])
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

  // addNode
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]
    const name = idToName.get(node.id)!
    switch (node.stageType) {
      case 'script':
        builder = builder.addNode(name, buildScriptNode(node, i, stageContext, hooks)); break
      case 'capability':
        builder = builder.addNode(name, buildCapabilityNode(node, i, stageContext, hooks, triggerParams)); break
      case 'approval':
        builder = builder.addNode(name, buildApprovalNode(node, i)); break
      case 'wait_webhook':
        builder = builder.addNode(name, buildWaitWebhookNode(node, i)); break
      case 'im_input':
        builder = builder.addNode(name, buildImInputNode(node, i, stageContext)); break
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
      builder = builder.addConditionalEdges(name, (state: typeof PipelineStateAnnotation.State) => {
        const result = state.stageResults.find((r) => r.name === node.name)
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

    builder = builder.addConditionalEdges(name, (state: typeof PipelineStateAnnotation.State) => {
      const result = state.stageResults.find((r) => r.name === node.name)
      if (!result) return idToName.get(outs[0].target) ?? END
      if (shouldStopAfter(node, result)) return skipName
      for (const e of outs) {
        if (conditionMatches(e.condition, result)) return idToName.get(e.target)!
      }
      return END
    }, routeMap)

    builder = builder.addEdge(skipName, END)
  }

  return builder as StateGraph<typeof PipelineStateAnnotation.State>
}
