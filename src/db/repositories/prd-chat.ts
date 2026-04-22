import { getPool } from '../client.js'

export type PrdChatRole = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'error'

export interface PrdChatSession {
  id: number
  sessionKey: string
  prdId: number | null
  productLineId: number
  createdBy: string
  porygonSessionId: string | null
  lastActiveAt: Date
  createdAt: Date
}

export interface PrdChatMessage {
  id: number
  sessionKey: string
  role: PrdChatRole
  content: string
  toolName: string | null
  toolUseId: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

function mapSession(r: Record<string, unknown>): PrdChatSession {
  return {
    id: r.id as number,
    sessionKey: r.session_key as string,
    prdId: (r.prd_id ?? null) as number | null,
    productLineId: r.product_line_id as number,
    createdBy: r.created_by as string,
    porygonSessionId: (r.porygon_session_id ?? null) as string | null,
    lastActiveAt: r.last_active_at as Date,
    createdAt: r.created_at as Date,
  }
}

function mapMessage(r: Record<string, unknown>): PrdChatMessage {
  return {
    id: r.id as number,
    sessionKey: r.session_key as string,
    role: r.role as PrdChatRole,
    content: (r.content ?? '') as string,
    toolName: (r.tool_name ?? null) as string | null,
    toolUseId: (r.tool_use_id ?? null) as string | null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.created_at as Date,
  }
}

export async function createChatSession(data: {
  sessionKey: string
  prdId?: number | null
  productLineId: number
  createdBy: string
}): Promise<PrdChatSession> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO prd_chat_sessions (session_key, prd_id, product_line_id, created_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [data.sessionKey, data.prdId ?? null, data.productLineId, data.createdBy]
  )
  return mapSession(rows[0])
}

export async function getChatSessionByKey(sessionKey: string): Promise<PrdChatSession | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM prd_chat_sessions WHERE session_key = $1',
    [sessionKey]
  )
  return rows[0] ? mapSession(rows[0]) : null
}

export async function updateChatSessionPorygonId(
  sessionKey: string,
  porygonSessionId: string
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE prd_chat_sessions
       SET porygon_session_id = $2, last_active_at = NOW()
     WHERE session_key = $1`,
    [sessionKey, porygonSessionId]
  )
}

export async function linkChatSessionToPrd(
  sessionKey: string,
  prdId: number
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE prd_chat_sessions
       SET prd_id = $2, last_active_at = NOW()
     WHERE session_key = $1 AND prd_id IS NULL`,
    [sessionKey, prdId]
  )
}

export async function touchChatSession(sessionKey: string): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE prd_chat_sessions SET last_active_at = NOW() WHERE session_key = $1`,
    [sessionKey]
  )
}

export async function appendChatMessage(data: {
  sessionKey: string
  role: PrdChatRole
  content?: string
  toolName?: string | null
  toolUseId?: string | null
  metadata?: Record<string, unknown>
}): Promise<PrdChatMessage> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO prd_chat_messages
       (session_key, role, content, tool_name, tool_use_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [
      data.sessionKey,
      data.role,
      data.content ?? '',
      data.toolName ?? null,
      data.toolUseId ?? null,
      JSON.stringify(data.metadata ?? {}),
    ]
  )
  return mapMessage(rows[0])
}

export async function listChatMessages(sessionKey: string): Promise<PrdChatMessage[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM prd_chat_messages WHERE session_key = $1 ORDER BY created_at, id`,
    [sessionKey]
  )
  return rows.map(mapMessage)
}

export async function listChatSessionsForPrd(prdId: number): Promise<PrdChatSession[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM prd_chat_sessions WHERE prd_id = $1 ORDER BY last_active_at DESC`,
    [prdId]
  )
  return rows.map(mapSession)
}
