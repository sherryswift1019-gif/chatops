import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { resolveVariables, type VariableContext } from '../variables.js'

/**
 * Phase 3 T14 — template_render executor。
 *
 * 把 params.template 通过 resolveVariables 渲染为最终字符串,把渲染结果作为
 * output.text 输出。下游节点(db_update / dm / http body 等)通过
 * `{{steps.<this>.output.text}}` 引用。
 *
 * 与变量解析约定:
 *   - 解析顺序: scopes > steps > vars > triggerParams (variables.ts 已实现)
 *   - 模板内可引用 {{vars.x}} / {{steps.x.output.y}} / {{server.host}}/...
 *   - 内置过滤器 urlEncode / jsonStringify / lower / upper(variables.ts)
 *   - params.vars: 可在本节点临时覆盖/扩展 vars 命名空间(merged into ctx.vars)
 *
 * 失败语义: template 缺失或为空 → status='failed'; resolveVariables 抛(未知 filter)
 * → status='failed'。其它情况 status='success', output={text: rendered}。
 */
registerNodeType({
  key: 'template_render',
  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const template = params.template as string | undefined
    if (template === undefined || template === null) {
      return { status: 'failed', output: {}, error: 'template_render executor requires params.template' }
    }
    const localVars = (params.vars ?? {}) as Record<string, unknown>

    const mergedVars: Record<string, string> = {}
    for (const [k, v] of Object.entries(ctx.vars ?? {})) {
      mergedVars[k] = String(v)
    }
    for (const [k, v] of Object.entries(localVars)) {
      mergedVars[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }

    const varCtx: VariableContext & Record<string, unknown> = {
      productLine: { name: '', displayName: '' },
      pipeline: { id: ctx.pipelineId, name: '' },
      run: { id: ctx.runId, triggeredBy: '', triggerType: '' },
      stage: { name: ctx.nodeId, index: 0 },
      server: ctx.server
        ? {
            host: ctx.server.host,
            port: ctx.server.port,
            username: ctx.server.username,
            name: '',
            role: '',
          }
        : { host: '', port: 0, username: '', name: '', role: '' },
      vars: mergedVars,
      // 把 ctx 上的 steps / triggerParams / scopes 也注入到 path resolver,
      // 让模板能引用 {{steps.x.output.y}} / {{triggerParams.z}} / {{scopes.item.k}}
      steps: ctx.steps ?? {},
      triggerParams: ctx.triggerParams ?? {},
      scopes: ctx.scopes ?? {},
    }

    try {
      const text = resolveVariables(template, varCtx as VariableContext)
      return { status: 'success', output: { text } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'failed', output: {}, error: msg }
    }
  },
})
