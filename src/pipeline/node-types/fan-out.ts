import { registerNodeType, getExecutor } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { resolveVariables, type VariableContext } from '../variables.js'

/**
 * Phase 3 T15 — fan_out 调度器（v1）。
 *
 * 语义（spec §4.4）：
 *   - params.source: 字符串模板，解析后必须是数组（如 `{{steps.q1.output.rows}}` 或 `{{vars.items}}`）
 *   - params.as: 把每个 item 注入到 ctx.scopes[<as>] 供 body 节点引用
 *     （variables.ts 的 resolvePath 优先从 scopes 取头节点）
 *   - params.parallel: 并发上限（默认 3，最少 1）
 *   - params.onItemFailure: 'continue' | 'stop' | 'aggregate'（默认 continue）
 *       - continue: 失败仅记录到 failed 列表，整体 status='success'
 *       - stop:     失败立即中止剩余 batch，整体 status='failed'
 *       - aggregate: 同 continue，但语义上明示"业务方需要看 failed 列表"
 *   - params.body: 预解析的 body 节点数组 [{ id, nodeTypeKey, params }]
 *     —— graph-builder 拼接 body 节点 ID → executor 模式由 graph-builder 集成时再做
 *
 * 输出 shape：
 *   { items: [<每个子运行最后一个 body 节点的 output>], failed: [{ index, item, error }] }
 *
 * v1 限制（重要）：
 *   1. 不支持嵌套 fan_out（spec §4.4 明确禁止）
 *   2. body 节点**不能**是 interrupt / state-bound 类型 ——
 *      不允许 approval / capability / im_input / wait_webhook（这些走 graph-builder
 *      switch dispatch + LangGraph interrupt，本 executor 用 plain Promise.all 子运行
 *      没有 LangGraph checkpointer，无法 resume）
 *   3. body 节点之间不互相引用（v1 子运行只关心最后一个 output；
 *      未来若要支持 body 内 steps 链式引用，需要在子 ctx 里维护独立 steps 表）
 *   4. 进程崩溃中断 fan_out 时，子运行无法 resume —— 生产级 fan_out（LangGraph
 *      子图集成）推迟到 phase 4
 *
 * 选用 Option A（standalone NodeExecutor + plain JS Promise.all）的理由：
 *   spec §4.4 已限制 v1 body，不依赖 interrupt；与 T9-T14 的简单 executor 模式一致；
 *   未来扩展 LangGraph 子图集成可在不破坏接口的前提下做。
 */

interface FanOutBodyNode {
  id: string
  nodeTypeKey: string
  params: Record<string, unknown>
}

interface FanOutParams {
  source: string
  as: string
  parallel?: number
  onItemFailure?: 'continue' | 'stop' | 'aggregate'
  body?: FanOutBodyNode[]
}

interface ItemSuccess {
  index: number
  output: unknown
}

interface ItemFailure {
  index: number
  item: unknown
  error: string
}

function buildVariableContext(ctx: ExecutionContext): VariableContext & Record<string, unknown> {
  const mergedVars: Record<string, string> = {}
  for (const [k, v] of Object.entries(ctx.vars ?? {})) {
    mergedVars[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return {
    productLine: { name: '', displayName: '' },
    pipeline: { id: ctx.pipelineId, name: '' },
    run: { id: ctx.runId, triggeredBy: '', triggerType: '' },
    stage: { name: ctx.nodeId, index: 0 },
    server: ctx.server
      ? { host: ctx.server.host, port: ctx.server.port, username: ctx.server.username, name: '', role: '' }
      : { host: '', port: 0, username: '', name: '', role: '' },
    vars: mergedVars,
    steps: ctx.steps ?? {},
    triggerParams: ctx.triggerParams ?? {},
    scopes: ctx.scopes ?? {},
  }
}

/**
 * 把 params.source（字符串模板）解析为数组。优先尝试单一表达式 `{{path}}` 直接走
 * raw ctx（保留 array 结构）；fallback 走 resolveVariables + JSON.parse。
 *
 * 失败返回 null（调用方会转 status='failed'）。
 */
function resolveSourceToArray(source: string, ctx: ExecutionContext): unknown[] | null {
  // 单一表达式快路径：`{{xxx}}` 包了整个 source —— 在 raw ctx 上做点路径查找,
  // 这样 array / object 结构完整保留（不会被 String() 压扁）。
  const match = source.trim().match(/^\{\{\s*([^}|]+?)\s*\}\}$/)
  if (match) {
    const path = match[1].trim()
    const resolved = resolveRawPath(ctx, path)
    if (Array.isArray(resolved)) return resolved
    // fall through: 让 JSON 路径再试一次（可能是字符串化的 JSON 数组）
  }
  // 通用路径：渲染后按 JSON 解析
  const varCtx = buildVariableContext(ctx)
  let rendered: string
  try {
    rendered = resolveVariables(source, varCtx as VariableContext)
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(rendered)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 在 raw ExecutionContext 上做点路径取值,保留 array / object 结构。
 * 优先级与 variables.ts 的 resolvePath 保持一致：scopes > steps > vars > triggerParams。
 * 仅支持 dot 与方括号索引（`a.b[0].c`）。
 */
function resolveRawPath(ctx: ExecutionContext, path: string): unknown {
  // parse path
  const parts: Array<{ kind: 'name' | 'index'; value: string | number }> = []
  let i = 0
  while (i < path.length) {
    if (path[i] === '.') { i++; continue }
    if (path[i] === '[') {
      const j = path.indexOf(']', i)
      if (j === -1) return undefined
      const idx = parseInt(path.slice(i + 1, j), 10)
      if (Number.isNaN(idx)) return undefined
      parts.push({ kind: 'index', value: idx })
      i = j + 1
      continue
    }
    let j = i
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++
    parts.push({ kind: 'name', value: path.slice(i, j) })
    i = j
  }
  if (parts.length === 0) return undefined

  // 决定起点 root：scopes 命中 → 从 scopes 起；否则把 ctx 的几个关键命名空间合成一个查找 root
  const head = parts[0]
  const scopes = ctx.scopes ?? {}
  let root: Record<string, unknown>
  if (head.kind === 'name' && typeof head.value === 'string' && head.value in scopes) {
    root = scopes
  } else {
    root = {
      steps: ctx.steps ?? {},
      vars: ctx.vars ?? {},
      triggerParams: ctx.triggerParams ?? {},
      scopes,
    }
  }

  let cursor: unknown = root
  for (const p of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    if (p.kind === 'name') {
      cursor = (cursor as Record<string, unknown>)[p.value as string]
    } else {
      cursor = (cursor as unknown[])[p.value as number]
    }
  }
  return cursor
}

registerNodeType({
  key: 'fan_out',
  async execute(
    rawParams: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const params = rawParams as unknown as FanOutParams

    if (typeof params.source !== 'string' || !params.source.trim()) {
      return {
        status: 'failed',
        output: {},
        error: 'fan_out executor requires params.source (template string resolving to array)',
      }
    }
    if (typeof params.as !== 'string' || !params.as.trim()) {
      return {
        status: 'failed',
        output: {},
        error: 'fan_out executor requires params.as (scope variable name)',
      }
    }

    const items = resolveSourceToArray(params.source, ctx)
    if (items === null) {
      return {
        status: 'failed',
        output: {},
        error: `fan_out source did not resolve to array: ${params.source}`,
      }
    }

    const parallel = Math.max(1, params.parallel ?? 3)
    const onItemFailure = params.onItemFailure ?? 'continue'
    const body = params.body ?? []

    // v1 防御：禁止嵌套 fan_out
    for (const node of body) {
      if (node.nodeTypeKey === 'fan_out') {
        return {
          status: 'failed',
          output: {},
          error: 'fan_out v1 does not support nesting fan_out inside body',
        }
      }
    }

    const successes: ItemSuccess[] = []
    const failed: ItemFailure[] = []
    let aborted = false

    // 按 parallel 切批次串行；每批内 Promise.all 并发
    for (let i = 0; i < items.length; i += parallel) {
      if (aborted) break
      const batch = items.slice(i, i + parallel)
      const batchResults = await Promise.all(
        batch.map(async (item, batchIdx) => {
          const globalIdx = i + batchIdx
          const subCtx: ExecutionContext = {
            ...ctx,
            scopes: {
              ...(ctx.scopes ?? {}),
              [params.as]: item as Record<string, unknown>,
            },
          }
          let lastOutput: unknown = undefined
          for (const bodyNode of body) {
            const executor = getExecutor(bodyNode.nodeTypeKey)
            if (!executor) {
              return {
                ok: false as const,
                index: globalIdx,
                item,
                error: `unknown executor: ${bodyNode.nodeTypeKey}`,
              }
            }
            let result: NodeExecutionResult
            try {
              result = await executor.execute(bodyNode.params, subCtx)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              return {
                ok: false as const,
                index: globalIdx,
                item,
                error: `body node "${bodyNode.id}" threw: ${msg}`,
              }
            }
            if (result.status !== 'success') {
              return {
                ok: false as const,
                index: globalIdx,
                item,
                error: result.error ?? `body node "${bodyNode.id}" status=${result.status}`,
              }
            }
            lastOutput = result.output
          }
          return { ok: true as const, index: globalIdx, output: lastOutput }
        }),
      )

      for (const r of batchResults) {
        if (r.ok) {
          successes.push({ index: r.index, output: r.output })
        } else {
          failed.push({ index: r.index, item: r.item, error: r.error })
          if (onItemFailure === 'stop') {
            aborted = true
          }
        }
      }
    }

    const itemsOutput = successes
      .sort((a, b) => a.index - b.index)
      .map((s) => s.output)

    if (failed.length === 0) {
      return { status: 'success', output: { items: itemsOutput, failed: [] } }
    }

    if (onItemFailure === 'stop') {
      return {
        status: 'failed',
        output: { items: itemsOutput, failed },
        error: `fan_out aborted: ${failed.length} item(s) failed (onItemFailure=stop)`,
      }
    }

    // continue / aggregate：失败仅记录，整体仍 success
    return { status: 'success', output: { items: itemsOutput, failed } }
  },
})
