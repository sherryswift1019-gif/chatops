import { getPool } from '../client.js'

export interface DryRunSnapshot {
  pipelineId: number
  nodeId: string
  status: 'success' | 'failed' | 'skipped'
  output: Record<string, unknown>
  source: 'real' | 'stub' | 'manual'
  upstreamParamsHash: string
  lastDecision: string | null
  lastManualInput: Record<string, unknown> | null
  durationMs: number | null
  error: string | null
  ranAt: Date
}

interface UpsertInput extends Omit<DryRunSnapshot, 'ranAt'> {}

function mapRow(r: Record<string, unknown>): DryRunSnapshot {
  return {
    pipelineId: r.pipeline_id as number,
    nodeId: r.node_id as string,
    status: r.status as DryRunSnapshot['status'],
    output: (r.output ?? {}) as Record<string, unknown>,
    source: r.source as DryRunSnapshot['source'],
    upstreamParamsHash: r.upstream_params_hash as string,
    lastDecision: (r.last_decision ?? null) as string | null,
    lastManualInput: (r.last_manual_input ?? null) as Record<string, unknown> | null,
    durationMs: (r.duration_ms ?? null) as number | null,
    error: (r.error ?? null) as string | null,
    ranAt: r.ran_at as Date,
  }
}

export async function upsertSnapshot(input: UpsertInput): Promise<void> {
  await getPool().query(
    `INSERT INTO pipeline_dryrun_snapshots (
       pipeline_id, node_id, status, output, source,
       upstream_params_hash, last_decision, last_manual_input,
       duration_ms, error, ran_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (pipeline_id, node_id) DO UPDATE SET
       status = EXCLUDED.status, output = EXCLUDED.output, source = EXCLUDED.source,
       upstream_params_hash = EXCLUDED.upstream_params_hash,
       last_decision = COALESCE(EXCLUDED.last_decision, pipeline_dryrun_snapshots.last_decision),
       last_manual_input = COALESCE(EXCLUDED.last_manual_input, pipeline_dryrun_snapshots.last_manual_input),
       duration_ms = EXCLUDED.duration_ms, error = EXCLUDED.error, ran_at = NOW()`,
    [input.pipelineId, input.nodeId, input.status, JSON.stringify(input.output),
     input.source, input.upstreamParamsHash, input.lastDecision,
     input.lastManualInput ? JSON.stringify(input.lastManualInput) : null,
     input.durationMs, input.error])
}

export async function listSnapshots(pipelineId: number): Promise<DryRunSnapshot[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1 ORDER BY node_id`,
    [pipelineId])
  return rows.map(mapRow)
}

export async function deleteSnapshot(pipelineId: number, nodeId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1 AND node_id=$2`,
    [pipelineId, nodeId])
}

export async function deleteAllSnapshots(pipelineId: number): Promise<void> {
  await getPool().query(
    `DELETE FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1`, [pipelineId])
}
