import { getPool } from '../client.js'

export interface CachedImage {
  project: string
  tag: string
  digest?: string
  builtAt?: Date
  commitSha?: string
  commitMessage?: string
  pipelineId?: number
  syncedAt: Date
}

const CACHE_TTL_MS = 5 * 60 * 1000

export async function upsertImageCache(image: Omit<CachedImage, 'syncedAt'>): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO image_cache (project, tag, digest, built_at, commit_sha, commit_message, pipeline_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (project, tag) DO UPDATE
     SET digest=$3, built_at=$4, commit_sha=$5, commit_message=$6,
         pipeline_id=$7, synced_at=NOW()`,
    [image.project, image.tag, image.digest ?? null, image.builtAt ?? null,
     image.commitSha ?? null, image.commitMessage ?? null, image.pipelineId ?? null]
  )
}

export async function getFreshImages(project: string, limit = 10): Promise<CachedImage[]> {
  const pool = getPool()
  const cutoff = new Date(Date.now() - CACHE_TTL_MS)
  const { rows } = await pool.query(
    `SELECT * FROM image_cache WHERE project=$1 AND synced_at > $2
     ORDER BY built_at DESC NULLS LAST LIMIT $3`,
    [project, cutoff, limit]
  )
  return rows.map(r => ({
    project: r.project,
    tag: r.tag,
    digest: r.digest,
    builtAt: r.built_at,
    commitSha: r.commit_sha,
    commitMessage: r.commit_message,
    pipelineId: r.pipeline_id,
    syncedAt: r.synced_at,
  }))
}
