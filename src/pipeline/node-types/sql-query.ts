import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { getPool } from '../../db/client.js'

/**
 * Phase 3 T12 — sql_query executor。
 *
 * 用 pg 参数化 query 执行 SELECT 类语句, 返回 rows 数组。
 *
 * params:
 *   - sqlTemplate: string  必填,带 $1, $2 占位符的参数化 SQL
 *   - params?: unknown[]
 *
 * 与 db_update 镜像;唯一差异是 output={rows} 而非 {rowsAffected}。
 *
 * 成功: status='success', output={rows: result.rows}
 * 失败: status='failed', error=err.message
 */
registerNodeType({
  key: 'sql_query',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const sqlTemplate = params.sqlTemplate as string | undefined
    if (!sqlTemplate || !sqlTemplate.trim()) {
      return { status: 'failed', output: {}, error: 'sql_query executor requires params.sqlTemplate' }
    }
    const sqlParams = Array.isArray(params.params) ? params.params : []

    try {
      const result = await getPool().query(sqlTemplate, sqlParams)
      return {
        status: 'success',
        output: { rows: result.rows },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'failed', output: {}, error: msg }
    }
  },
})
