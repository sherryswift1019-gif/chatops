import { StateGraph, START, END, interrupt } from '@langchain/langgraph'
import { PipelineStateAnnotation, type StageResult } from './graph-state.js'
import type {
  StageDefinition,
  StageContext,
  StageExecutionResult,
  ServerInfo,
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

// Shape of the value passed to interrupt() for approval stages.
export interface ApprovalInterruptValue {
  type: 'approval'
  stageIndex: number
  approverIds: string[]
  description: string
}
// Expected resume value for an approval interrupt.
export type ApprovalResume = 'approved' | 'rejected' | 'timeout'

// Shape of the value passed to interrupt() for webhook stages.
export interface WebhookInterruptValue {
  type: 'webhook'
  stageIndex: number
  tag: string
}
// Expected resume value for a webhook interrupt.
// Note: LangGraph's Command treats `resume == null` as "no resume" and throws
// EmptyInputError, so timeout must be encoded as an explicit sentinel object
// rather than null. Callers should dispatch `Command({ resume: { timeout: true } })`.
export type WebhookResume = { data: unknown } | { timeout: true } | null | undefined

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
    const exec = await hooks.runScript(stage, ctx, targetServers)
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
    const exec = await hooks.runCapability(stage, ctx, triggerParams)
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
      type: 'approval',
      stageIndex: index,
      approverIds: stage.approverIds ?? [],
      description: stage.approvalDescription ?? stage.name,
    }
    // interrupt() throws a GraphInterrupt on first entry and returns the
    // resume value on subsequent entries once Command({resume}) is applied.
    const decision = interrupt(payload) as ApprovalResume
    const exec: StageExecutionResult =
      decision === 'approved'
        ? { status: 'success', output: '审批通过' }
        : decision === 'rejected'
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
      type: 'webhook',
      stageIndex: index,
      tag: stage.webhookTag ?? '',
    }
    const resume = interrupt(payload) as WebhookResume
    const isTimeout =
      resume === null ||
      resume === undefined ||
      (typeof resume === 'object' && 'timeout' in resume && resume.timeout === true)
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
        graph = graph.addNode(name, buildApprovalNode(stage, i))
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
