import { getPool } from '../client.js'

export interface ApprovalRequest {
  id: number
  taskId: string
  approverId: string
  approverType: 'primary' | 'backup'
  sentAt: Date
  respondedAt?: Date
  decision?: 'approved' | 'rejected' | 'timeout'
  dmMessageId?: string
}

export async function createApprovalRequest(
  data: Pick<ApprovalRequest, 'taskId' | 'approverId' | 'approverType' | 'dmMessageId'>
): Promise<ApprovalRequest> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO approval_requests (task_id, approver_id, approver_type, dm_message_id)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [data.taskId, data.approverId, data.approverType, data.dmMessageId ?? null]
  )
  return mapRequest(rows[0])
}

export async function resolveApprovalRequest(
  taskId: string,
  approverId: string,
  decision: 'approved' | 'rejected'
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE approval_requests SET decision=$3, responded_at=NOW()
     WHERE task_id=$1 AND approver_id=$2 AND decision IS NULL`,
    [taskId, approverId, decision]
  )
}

export async function getPendingRequests(taskId: string): Promise<ApprovalRequest[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM approval_requests WHERE task_id=$1 AND decision IS NULL`,
    [taskId]
  )
  return rows.map(mapRequest)
}

function mapRequest(r: Record<string, unknown>): ApprovalRequest {
  return {
    id: r.id as number,
    taskId: r.task_id as string,
    approverId: r.approver_id as string,
    approverType: r.approver_type as 'primary' | 'backup',
    sentAt: r.sent_at as Date,
    respondedAt: r.responded_at as Date | undefined,
    decision: r.decision as 'approved' | 'rejected' | 'timeout' | undefined,
    dmMessageId: r.dm_message_id as string | undefined,
  }
}
