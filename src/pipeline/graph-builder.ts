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
import { evalExpression } from './expressions.js'
import { extractJsonObject, NotJsonObjectError } from './json-extract.js'

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

async function runScriptInDocker(
  stage: StageDefinition,
  ctxBase: StageContextBase,
  stageIndex: number,
  executor: DockerExecutor,
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
  }
  const resolvedScript = resolveVariables(script, varCtx)

  const result = await executor.exec(resolvedScript)
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  if (result.exitCode !== 0) {
    return { status: 'failed', output, error: `exit code ${result.exitCode}` }
  }
  return { status: 'success', output }
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
    const startedAt = nowIso()
    const startedMs = Date.now()
    let exec: StageExecutionResult

    if (targetServers.length > 0) {
      // SSH path — existing behaviour unchanged
      const ctx: StageContext = { ...ctxBase, stageIndex: index }
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
          exec = await runScriptInDocker(stage, ctxBase, index, nodeExecutor)
        } finally {
          await nodeExecutor.teardown()
        }
      } else if (ctxBase.dockerExecutor) {
        // Pipeline-level shared executor
        exec = await runScriptInDocker(stage, ctxBase, index, ctxBase.dockerExecutor)
      } else {
        exec = {
          status: 'failed',
          output: 'No executor configured: set a role or container image',
          error: 'no_executor',
        }
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
    const runtimeVars = { ...(ctxBase.variables ?? {}), ...(state.runtimeVars ?? {}) }
    let exec: StageExecutionResult
    try {
      const agentMode = stage.agentMode ?? 'capability'
      if (agentMode === 'custom') {
        if (!hooks.runCustomAgent) {
          exec = { status: 'failed', output: 'custom agent hook not configured', error: 'no_hook' }
        } else {
          exec = await hooks.runCustomAgent(stage, ctx, triggerParams, runtimeVars)
        }
      } else {
        if (!hooks.runCapability) {
          exec = { status: 'failed', output: 'capability hook not configured', error: 'no_hook' }
        } else {
          exec = await hooks.runCapability(stage, ctx, triggerParams, runtimeVars)
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
      case 'http': {
        // ---- Side-effect nodes: optionally wrapped with dryRunFlavor interrupt ----
        let realFn: (state: typeof PipelineStateAnnotation.State) => Promise<unknown>
        if (node.stageType === 'script') {
          realFn = buildScriptNode(node, i, stageContext, hooks) as typeof realFn
        } else if (node.stageType === 'approval') {
          realFn = buildApprovalNode(node, i, triggerParams) as typeof realFn
        } else {
          // dm / db_update / http — generic NodeExecutor dispatch
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
        builder = builder.addNode(name, buildWaitWebhookNode(node, i))
        break

      // Non-side-effect NodeExecutor-backed types — wrap with snapshot recorder when dryRunFlavor present.
      case 'sql_query':
      case 'file_read':
      case 'template_render':
      case 'fan_out':
      case 'switch':
        builder = builder.addNode(name, wrapWithSnapshot(node, i,
          buildExecutorNode(node, i, stageContext, triggerParams ?? {}) as (state: typeof PipelineStateAnnotation.State) => Promise<unknown>))
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
