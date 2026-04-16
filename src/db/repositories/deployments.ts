import { getPool } from '../client.js'

export interface Deployment {
  id: number
  project: string
  env: string
  imageTag: string
  imageDigest?: string
  deployedBy: string
  approvedBy?: string
  deployedAt: Date
  status: 'success' | 'failed' | 'rolled_back'
}

export async function recordDeployment(
  data: Omit<Deployment, 'id' | 'deployedAt'>
): Promise<Deployment> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO deployments (project, env, image_tag, image_digest, deployed_by, approved_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [data.project, data.env, data.imageTag, data.imageDigest ?? null,
     data.deployedBy, data.approvedBy ?? null, data.status]
  )
  return {
    id: rows[0].id,
    project: rows[0].project,
    env: rows[0].env,
    imageTag: rows[0].image_tag,
    imageDigest: rows[0].image_digest,
    deployedBy: rows[0].deployed_by,
    approvedBy: rows[0].approved_by,
    deployedAt: rows[0].deployed_at,
    status: rows[0].status,
  }
}

export async function getRecentDeployments(project: string, env?: string, limit = 5): Promise<Deployment[]> {
  const pool = getPool()
  const envClause = env ? 'AND d.env=$2' : ''
  const params = env ? [project, env, limit] : [project, limit]
  const { rows } = await pool.query(
    `SELECT d.*, COALESCE(u.name, d.deployed_by) AS deployed_by_name
     FROM deployments d
     LEFT JOIN dingtalk_users u ON u.user_id = d.deployed_by
     WHERE d.project=$1 ${envClause}
     ORDER BY d.deployed_at DESC LIMIT $${env ? 3 : 2}`,
    params
  )
  return rows.map(r => ({
    id: r.id, project: r.project, env: r.env,
    imageTag: r.image_tag, imageDigest: r.image_digest,
    deployedBy: r.deployed_by_name, approvedBy: r.approved_by,
    deployedAt: r.deployed_at, status: r.status,
  }))
}
