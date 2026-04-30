import { getPool } from '../client.js'

export type GenerationStatus =
  | 'pending' | 'generating' | 'pr_open' | 'committed'
  | 'baseline_failed' | 'blocked_on_baseline_bug' | 'skipped'

export interface E2eSpec {
  id: bigint
  targetProjectId: string
  specPath: string
  title: string
  contentHash: string
  generatedArtifactPath: string | null
  generatedPrUrl: string | null
  generationStatus: GenerationStatus
  lastGeneratedAt: Date | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): E2eSpec {
  return {
    id: r.id as bigint,
    targetProjectId: r.target_project_id as string,
    specPath: r.spec_path as string,
    title: r.title as string,
    contentHash: r.content_hash as string,
    generatedArtifactPath: r.generated_artifact_path as string | null,
    generatedPrUrl: r.generated_pr_url as string | null,
    generationStatus: r.generation_status as GenerationStatus,
    lastGeneratedAt: r.last_generated_at as Date | null,
    createdAt: r.created_at as Date,
  }
}

export async function listE2eSpecs(targetProjectId: string): Promise<E2eSpec[]> {
  const { rows } = await getPool().query(
    'SELECT * FROM e2e_specs WHERE target_project_id = $1 ORDER BY spec_path',
    [targetProjectId],
  )
  return rows.map(mapRow)
}

export async function getE2eSpec(id: bigint): Promise<E2eSpec | null> {
  const { rows } = await getPool().query('SELECT * FROM e2e_specs WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function upsertE2eSpec(
  data: Pick<E2eSpec, 'targetProjectId' | 'specPath' | 'title' | 'contentHash'>,
): Promise<E2eSpec> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_specs (target_project_id, spec_path, title, content_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (target_project_id, spec_path) DO UPDATE
       SET title = EXCLUDED.title, content_hash = EXCLUDED.content_hash
     RETURNING *`,
    [data.targetProjectId, data.specPath, data.title, data.contentHash],
  )
  return mapRow(rows[0])
}

export async function updateE2eSpecStatus(
  id: bigint,
  status: GenerationStatus,
  extra?: { generatedArtifactPath?: string; generatedPrUrl?: string; lastGeneratedAt?: Date },
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_specs SET
       generation_status = $2,
       generated_artifact_path = COALESCE($3, generated_artifact_path),
       generated_pr_url = COALESCE($4, generated_pr_url),
       last_generated_at = COALESCE($5, last_generated_at)
     WHERE id = $1`,
    [id, status, extra?.generatedArtifactPath ?? null, extra?.generatedPrUrl ?? null, extra?.lastGeneratedAt ?? null],
  )
}
