import { getPool } from '../client.js'
import { randomUUID } from 'crypto'

export type TaskStatus =
  | 'queued' | 'pending_approval' | 'approved'
  | 'executing' | 'done' | 'rejected' | 'cancelled' | 'timeout'

export interface Task {
  id: string
  groupId: string
  platform: string
  initiatorId: string
  intent: string
  status: TaskStatus
  toolName?: string
  toolParams?: unknown
  result?: unknown
  createdAt: Date
  approvedAt?: Date
  approvedBy?: string
  executedAt?: Date
  doneAt?: Date
}

export async function createTask(data: Omit<Task, 'id' | 'status' | 'createdAt'>): Promise<Task> {
  const pool = getPool()
  const id = randomUUID()
  const { rows } = await pool.query(
    `INSERT INTO tasks (id, group_id, platform, initiator_id, intent, tool_name, tool_params)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, data.groupId, data.platform, data.initiatorId, data.intent,
     data.toolName ?? null, data.toolParams ? JSON.stringify(data.toolParams) : null]
  )
  return mapTask(rows[0])
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus,
  extra: Partial<Pick<Task, 'approvedBy' | 'result' | 'toolName' | 'toolParams'>> = {}
): Promise<void> {
  const pool = getPool()
  const now = new Date()
  const approvedAt = status === 'approved' ? now : null
  const executedAt = status === 'executing' ? now : null
  const doneAt = ['done', 'rejected', 'cancelled', 'timeout'].includes(status) ? now : null

  await pool.query(
    `UPDATE tasks SET status=$2,
       approved_at = COALESCE($3, approved_at),
       approved_by = COALESCE($4, approved_by),
       executed_at = COALESCE($5, executed_at),
       done_at = COALESCE($6, done_at),
       result = COALESCE($7, result),
       tool_name = COALESCE($8, tool_name),
       tool_params = COALESCE($9, tool_params)
     WHERE id=$1`,
    [id, status,
     approvedAt, extra.approvedBy ?? null,
     executedAt, doneAt,
     extra.result ? JSON.stringify(extra.result) : null,
     extra.toolName ?? null,
     extra.toolParams ? JSON.stringify(extra.toolParams) : null]
  )
}

export async function getExecutingTask(groupId: string): Promise<Task | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE group_id=$1 AND status='executing' LIMIT 1`,
    [groupId]
  )
  return rows[0] ? mapTask(rows[0]) : null
}

export async function getQueuedTasks(groupId: string): Promise<Task[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE group_id=$1 AND status='queued' ORDER BY created_at`,
    [groupId]
  )
  return rows.map(mapTask)
}

export async function getTaskById(id: string): Promise<Task | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id=$1', [id])
  return rows[0] ? mapTask(rows[0]) : null
}

export async function getRecentTasks(groupId: string, limit = 10): Promise<Task[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE group_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [groupId, limit]
  )
  return rows.map(mapTask)
}

function mapTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    groupId: row.group_id as string,
    platform: row.platform as string,
    initiatorId: row.initiator_id as string,
    intent: row.intent as string,
    status: row.status as TaskStatus,
    toolName: row.tool_name as string | undefined,
    toolParams: row.tool_params,
    result: row.result,
    createdAt: row.created_at as Date,
    approvedAt: row.approved_at as Date | undefined,
    approvedBy: row.approved_by as string | undefined,
    executedAt: row.executed_at as Date | undefined,
    doneAt: row.done_at as Date | undefined,
  }
}
