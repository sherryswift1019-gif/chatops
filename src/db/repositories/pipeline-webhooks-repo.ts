import { getPool } from '../client.js'
import { generateWebhookToken } from '../../pipeline/webhook-token.js'

export interface PipelineWebhook {
  id: number
  pipelineId: number
  name: string
  /** 完整 token（create/rotate/getByToken 返回）或 masked（列表） */
  token: string
  enabled: boolean
  defaultServers: Record<string, string[]> | null
  createdAt: Date
  createdBy: string
  lastUsedAt: Date | null
  lastRunId: number | null
  triggerCount: number
}

function mapRow(r: Record<string, unknown>): PipelineWebhook {
  return {
    id: r.id as number,
    pipelineId: r.pipeline_id as number,
    name: r.name as string,
    token: r.token as string,
    enabled: r.enabled as boolean,
    defaultServers: r.default_servers as Record<string, string[]> | null,
    createdAt: r.created_at as Date,
    createdBy: r.created_by as string,
    lastUsedAt: r.last_used_at as Date | null,
    lastRunId: r.last_run_id as number | null,
    triggerCount: r.trigger_count as number,
  }
}

/** 列表：token 脱敏为前 8 字符 + 省略号 */
export async function listPipelineWebhooks(pipelineId: number): Promise<PipelineWebhook[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT *, LEFT(token, 8) || chr(8230) AS token
     FROM pipeline_webhooks WHERE pipeline_id = $1 ORDER BY id`,
    [pipelineId],
  )
  return rows.map(mapRow)
}

/** 通过 id 查单条（供管理路由做归属校验） */
export async function getPipelineWebhookById(id: number): Promise<PipelineWebhook | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM pipeline_webhooks WHERE id = $1`,
    [id],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/** 通过 token 精确查找（公开端点鉴权用，返回完整行） */
export async function getPipelineWebhookByToken(token: string): Promise<PipelineWebhook | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM pipeline_webhooks WHERE token = $1`,
    [token],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export interface CreateWebhookInput {
  pipelineId: number
  name: string
  createdBy: string
  defaultServers?: Record<string, string[]>
}

/** Create：返回含完整 token 的行 */
export async function createPipelineWebhook(input: CreateWebhookInput): Promise<PipelineWebhook> {
  const pool = getPool()
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = generateWebhookToken()
    try {
      const { rows } = await pool.query(
        `INSERT INTO pipeline_webhooks (pipeline_id, name, token, created_by, default_servers)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          input.pipelineId,
          input.name,
          token,
          input.createdBy,
          input.defaultServers ? JSON.stringify(input.defaultServers) : null,
        ],
      )
      return mapRow(rows[0])
    } catch (err: unknown) {
      const pg = err as { code?: string; constraint?: string }
      if (pg.code === '23505' && pg.constraint?.includes('token')) continue
      throw err
    }
  }
  throw new Error('Failed to generate unique webhook token after 3 attempts')
}

export interface UpdateWebhookInput {
  name?: string
  enabled?: boolean
  defaultServers?: Record<string, string[]> | null
}

export async function updatePipelineWebhook(
  id: number,
  input: UpdateWebhookInput,
): Promise<PipelineWebhook | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE pipeline_webhooks
     SET name            = COALESCE($2, name),
         enabled         = COALESCE($3, enabled),
         default_servers = CASE WHEN $4::boolean THEN $5::jsonb ELSE default_servers END
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.name ?? null,
      input.enabled ?? null,
      input.defaultServers !== undefined,
      input.defaultServers !== undefined && input.defaultServers !== null
        ? JSON.stringify(input.defaultServers)
        : null,
    ],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/** Rotate：新 token 立即覆盖旧 token，旧 token 失效。返回完整新 token。 */
export async function rotatePipelineWebhookToken(id: number): Promise<{ newToken: string }> {
  const pool = getPool()
  for (let attempt = 0; attempt < 3; attempt++) {
    const newToken = generateWebhookToken()
    try {
      const { rowCount } = await pool.query(
        `UPDATE pipeline_webhooks SET token = $2 WHERE id = $1`,
        [id, newToken],
      )
      if ((rowCount ?? 0) === 0) throw new Error(`Webhook ${id} not found`)
      return { newToken }
    } catch (err: unknown) {
      const pg = err as { code?: string }
      if (pg.code === '23505') continue
      throw err
    }
  }
  throw new Error('Failed to generate unique token after 3 attempts')
}

export async function deletePipelineWebhook(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    `DELETE FROM pipeline_webhooks WHERE id = $1`,
    [id],
  )
  return (rowCount ?? 0) > 0
}

/** 触发后更新统计字段（fire-and-forget） */
export async function recordWebhookUsed(id: number, runId: number): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE pipeline_webhooks
     SET last_used_at = NOW(), last_run_id = $2, trigger_count = trigger_count + 1
     WHERE id = $1`,
    [id, runId],
  )
}
