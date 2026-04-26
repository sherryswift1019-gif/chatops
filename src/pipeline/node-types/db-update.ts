import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { getPool } from '../../db/client.js'

/**
 * Phase 3 T11 — db_update executor。
 *
 * 用 pg 参数化 query 执行 INSERT / UPDATE / DELETE 类语句。
 *
 * params:
 *   - sqlTemplate: string  必填,带 $1, $2 占位符的参数化 SQL
 *   - params?: unknown[]   占位符值数组(类型由调用方约定)
 *
 * ⚠️ 安全约定: sqlTemplate 内部不允许业务变量字符串拼接 —— 调度方在传入前
 *    可对其做 {{vars.x}} 模板插值,但建议把动态值放进 params 数组里走参数化。
 *    本 executor 直接把 sqlTemplate 当 SQL 喂给 pool.query, 不做 SQL parsing。
 *
 * 成功: status='success', output={rowsAffected: rowCount}
 * 失败: status='failed', error=err.message
 */
registerNodeType({
  key: 'db_update',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const sqlTemplate = params.sqlTemplate as string | undefined
    if (!sqlTemplate || !sqlTemplate.trim()) {
      return { status: 'failed', output: {}, error: 'db_update executor requires params.sqlTemplate' }
    }
    const sqlParams = Array.isArray(params.params) ? params.params : []

    try {
      const result = await getPool().query(sqlTemplate, sqlParams)
      return {
        status: 'success',
        output: { rowsAffected: result.rowCount ?? 0 },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'failed', output: {}, error: msg }
    }
  },
})
