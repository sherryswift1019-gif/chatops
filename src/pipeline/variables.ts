/**
 * 变量模板约定（script 与 capability 节点语义统一）
 *
 * - `{{vars.xxx}}`：读取 `state.runtimeVars`（由 im_input / wait_webhook
 *   节点写入）与 `pipeline.variables`（流水线配置自定义变量）的合并值。
 *   script 节点走 resolveVariables（本文件），capability 节点走
 *   resolveCapabilityParams（src/pipeline/executor-hooks.ts）。
 * - `{{triggerParams.xxx}}`：仅 capability 节点识别，读取流水线触发时
 *   透传的 triggerParams。
 * - 未匹配的模板：保留字面字符串。
 *
 * capability 第一版仅支持整值替换（^{{...}}$），不支持嵌入式模板
 * （如 "foo-{{vars.x}}"）。
 */
export interface VariableContext {
  productLine: { name: string; displayName: string }
  pipeline: { id: number; name: string }
  run: { id: number; triggeredBy: string; triggerType: string }
  stage: { name: string; index: number }
  server: { host: string; port: number; username: string; name: string; role: string }
  vars: Record<string, string>
}

export interface VariableDefinition {
  key: string
  description: string
  category: string
}

export const VARIABLE_CATALOG: VariableDefinition[] = [
  // 产线
  { key: 'productLine.name', description: '产线标识名', category: '产线' },
  { key: 'productLine.displayName', description: '产线显示名', category: '产线' },
  // 流水线
  { key: 'pipeline.id', description: '流水线ID', category: '流水线' },
  { key: 'pipeline.name', description: '流水线名称', category: '流水线' },
  // 执行
  { key: 'run.id', description: '执行ID', category: '执行' },
  { key: 'run.triggeredBy', description: '触发人', category: '执行' },
  { key: 'run.triggerType', description: '触发方式', category: '执行' },
  // 阶段
  { key: 'stage.name', description: '当前阶段名称', category: '阶段' },
  { key: 'stage.index', description: '当前阶段序号', category: '阶段' },
  // 服务器
  { key: 'server.host', description: '服务器IP', category: '服务器' },
  { key: 'server.port', description: '服务器端口', category: '服务器' },
  { key: 'server.username', description: '用户名', category: '服务器' },
  { key: 'server.name', description: '服务器名称', category: '服务器' },
  { key: 'server.role', description: '服务器角色', category: '服务器' },
  // 自定义
  { key: 'vars.*', description: '自定义变量，在流水线配置中定义', category: '自定义' },
]

/**
 * Replace all {{xxx}} templates in script with values from context.
 * Supports dot-notation paths: {{server.host}}, {{productLine.displayName}}, {{vars.APP_NAME}}
 * Unresolved variables are left as-is.
 */
export function resolveVariables(script: string, ctx: VariableContext): string {
  return script.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim()
    const value = resolvePath(ctx as unknown as Record<string, unknown>, trimmed)
    if (value === undefined) return `{{${trimmed}}}`
    return String(value)
  })
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
