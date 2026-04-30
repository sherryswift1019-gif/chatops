import { getPool } from '../client.js'

export type SandboxStatus = 'provisioning' | 'ready' | 'redeploying' | 'torn_down' | 'failed'

export interface SandboxHandle {
  envId: string
  kind: string
  endpoints: Record<string, string>
  modules?: Array<{ name: string; host: string; port: number }>
  internalRefs?: Record<string, unknown>
}

export interface E2eSandbox {
  id: bigint
  e2eRunId: bigint | null
  kind: string
  handle: SandboxHandle
  status: SandboxStatus
  createdAt: Date
  readyAt: Date | null
  destroyedAt: Date | null
}

function mapRow(r: Record<string, unknown>): E2eSandbox {
  return {
    id: r.id as bigint,
    e2eRunId: r.e2e_run_id as bigint | null,
    kind: r.kind as string,
    handle: r.handle as SandboxHandle,
    status: r.status as SandboxStatus,
    createdAt: r.created_at as Date,
    readyAt: r.ready_at as Date | null,
    destroyedAt: r.destroyed_at as Date | null,
  }
}

export async function createSandbox(
  data: Pick<E2eSandbox, 'e2eRunId' | 'kind' | 'handle'>,
): Promise<E2eSandbox> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_sandboxes (e2e_run_id, kind, handle) VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [data.e2eRunId, data.kind, JSON.stringify(data.handle)],
  )
  return mapRow(rows[0])
}

export async function updateSandboxStatus(
  id: bigint,
  status: SandboxStatus,
  extra?: { readyAt?: Date; destroyedAt?: Date; handle?: SandboxHandle },
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_sandboxes SET
       status = $2,
       ready_at = COALESCE($3, ready_at),
       destroyed_at = COALESCE($4, destroyed_at),
       handle = COALESCE($5::jsonb, handle)
     WHERE id = $1`,
    [id, status, extra?.readyAt ?? null, extra?.destroyedAt ?? null, extra?.handle ? JSON.stringify(extra.handle) : null],
  )
}

export async function getSandboxByRunId(e2eRunId: bigint): Promise<E2eSandbox | null> {
  const { rows } = await getPool().query(
    `SELECT * FROM e2e_sandboxes WHERE e2e_run_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [e2eRunId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
