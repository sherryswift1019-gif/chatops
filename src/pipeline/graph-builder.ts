import { StateGraph, START, END, interrupt } from '@langchain/langgraph'
import { PipelineStateAnnotation, type StageResult } from './graph-state.js'
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
        // Handler 在 Task 6 实现。此处占位避免 exhaustive check 报错。
        throw new Error('im_input stage not yet implemented (Task 6)')
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
