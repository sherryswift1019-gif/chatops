import { getPool } from '../client.js'

// ─── Session ──────────────────────────────────────────────────────────────────

export interface ArchChatSession {
  id: number
  sessionKey: string
  archId: number | null
  sourcePrdId: number | null
  productLineId: number
  porygonSessionId: string | null
  createdBy: string
  lastActiveAt: Date
  createdAt: Date
}

function mapSession(row: Record<string, unknown>): ArchChatSession {
  return {
    id: row.id as number,
    sessionKey: row.session_key as string,
    archId: row.arch_id as number | null,
    sourcePrdId: row.source_prd_id as number | null,
    productLineId: row.product_line_id as number,
    porygonSessionId: row.porygon_session_id as string | null,
    createdBy: row.created_by as string,
    lastActiveAt: row.last_active_at as Date,
    createdAt: row.created_at as Date,
  }
}

export async function createArchChatSession(params: {
  sessionKey: string
  productLineId: number
  sourcePrdId?: number | null
  createdBy: string
}): Promise<ArchChatSession> {
  const result = await getPool().query(
    `INSERT INTO arch_chat_sessions (session_key, product_line_id, source_prd_id, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [params.sessionKey, params.productLineId, params.sourcePrdId ?? null, params.createdBy]
  )
  return mapSession(result.rows[0])
}

export async function getArchChatSessionByKey(key: string): Promise<ArchChatSession | null> {
  const result = await getPool().query(
    'SELECT * FROM arch_chat_sessions WHERE session_key = $1',
    [key]
  )
  return result.rows[0] ? mapSession(result.rows[0]) : null
}

export async function touchArchChatSession(sessionKey: string): Promise<void> {
  await getPool().query(
    'UPDATE arch_chat_sessions SET last_active_at = NOW() WHERE session_key = $1',
    [sessionKey]
  )
}

export async function updateArchChatSessionPorygonId(
  sessionKey: string,
  porygonSessionId: string
): Promise<void> {
  await getPool().query(
    'UPDATE arch_chat_sessions SET porygon_session_id = $1, last_active_at = NOW() WHERE session_key = $2',
    [porygonSessionId, sessionKey]
  )
}

export async function linkArchChatSessionToArch(
  sessionKey: string,
  archId: number
): Promise<void> {
  await getPool().query(
    'UPDATE arch_chat_sessions SET arch_id = $1, last_active_at = NOW() WHERE session_key = $2',
    [archId, sessionKey]
  )
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface ArchChatMessage {
  id: number
  sessionId: number
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'error'
  content: string
  toolName: string | null
  toolUseId: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

function mapMessage(row: Record<string, unknown>): ArchChatMessage {
  return {
    id: row.id as number,
    sessionId: row.session_id as number,
    role: row.role as ArchChatMessage['role'],
    content: row.content as string,
    toolName: row.tool_name as string | null,
    toolUseId: row.tool_use_id as string | null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at as Date,
  }
}

export async function appendArchChatMessage(params: {
  sessionId: number
  role: ArchChatMessage['role']
  content: string
  toolName?: string
  toolUseId?: string
  metadata?: Record<string, unknown>
}): Promise<ArchChatMessage> {
  const result = await getPool().query(
    `INSERT INTO arch_chat_messages
       (session_id, role, content, tool_name, tool_use_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.sessionId,
      params.role,
      params.content,
      params.toolName ?? null,
      params.toolUseId ?? null,
      params.metadata ?? {},
    ]
  )
  return mapMessage(result.rows[0])
}

export async function listArchChatMessages(sessionId: number): Promise<ArchChatMessage[]> {
  const result = await getPool().query(
    'SELECT * FROM arch_chat_messages WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId]
  )
  return result.rows.map(mapMessage)
}
