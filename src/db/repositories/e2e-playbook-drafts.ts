import { getPool } from '../client.js'

export type DraftStatus = 'drafting' | 'reviewing' | 'approved' | 'rejected' | 'generation_failed'

export interface E2ePlaybookDraft {
  id: bigint
  targetProjectId: string
  scenarioInput: string
  yamlContent: string | null
  status: DraftStatus
  e2eRunId: bigint | null
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): E2ePlaybookDraft {
  return {
    id: r.id as bigint,
    targetProjectId: r.target_project_id as string,
    scenarioInput: r.scenario_input as string,
    yamlContent: r.yaml_content as string | null,
    status: r.status as DraftStatus,
    e2eRunId: r.e2e_run_id != null ? BigInt(r.e2e_run_id as string | number) : null,
    errorMessage: r.error_message as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function createDraft(input: { targetProjectId: string; scenarioInput: string }): Promise<bigint> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_playbook_drafts (target_project_id, scenario_input)
     VALUES ($1, $2) RETURNING id`,
    [input.targetProjectId, input.scenarioInput],
  )
  return rows[0].id as bigint
}

export async function getDraft(id: bigint): Promise<E2ePlaybookDraft | null> {
  const { rows } = await getPool().query(
    'SELECT * FROM e2e_playbook_drafts WHERE id = $1',
    [id],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listDraftsByProject(projectId: string, limit = 20): Promise<E2ePlaybookDraft[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM e2e_playbook_drafts
     WHERE target_project_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [projectId, Math.min(limit, 100)],
  )
  return rows.map(mapRow)
}

export async function updateDraftYaml(
  id: bigint,
  yaml: string,
  status: 'reviewing' | 'generation_failed',
  errMsg?: string,
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_playbook_drafts
     SET yaml_content = $2,
         status = $3,
         error_message = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [id, yaml, status, errMsg ?? null],
  )
}

export async function approveDraft(id: bigint, runId: bigint): Promise<void> {
  await getPool().query(
    `UPDATE e2e_playbook_drafts
     SET status = 'approved',
         e2e_run_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [id, runId],
  )
}

export async function rejectDraft(id: bigint): Promise<void> {
  await getPool().query(
    `UPDATE e2e_playbook_drafts
     SET status = 'rejected',
         updated_at = NOW()
     WHERE id = $1`,
    [id],
  )
}
