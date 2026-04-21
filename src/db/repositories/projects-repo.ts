import { getPool } from '../client.js'

export interface Project {
  id: number
  productLineId: number
  name: string
  displayName: string
  gitlabPath: string
  harborProject: string
  ownerId: string
  ownerName: string
  dockerContainerName: string
  k8sProjectName: string
  composePath: string
  description: string
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): Project {
  return {
    id: r.id as number, productLineId: r.product_line_id as number,
    name: r.name as string, displayName: r.display_name as string,
    gitlabPath: r.gitlab_path as string, harborProject: r.harbor_project as string,
    ownerId: r.owner_id as string, ownerName: r.owner_name as string,
    dockerContainerName: (r.docker_container_name as string) ?? '',
    k8sProjectName: (r.k8s_project_name as string) ?? '',
    composePath: (r.compose_path as string) ?? '',
    description: r.description as string,
    createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  }
}

export async function listProjects(productLineId?: number): Promise<Project[]> {
  const pool = getPool()
  if (productLineId !== undefined) {
    const { rows } = await pool.query(
      'SELECT * FROM projects WHERE product_line_id = $1 ORDER BY id', [productLineId]
    )
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM projects ORDER BY id')
  return rows.map(mapRow)
}

export async function getProjectById(id: number): Promise<Project | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getProjectByGitlabPath(gitlabPath: string): Promise<Project | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM projects WHERE gitlab_path = $1 LIMIT 1', [gitlabPath])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createProject(
  data: Pick<Project, 'productLineId' | 'name' | 'displayName'> &
    Partial<Pick<Project, 'gitlabPath' | 'harborProject' | 'ownerId' | 'ownerName' | 'dockerContainerName' | 'k8sProjectName' | 'composePath' | 'description'>>
): Promise<Project> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO projects (product_line_id, name, display_name, gitlab_path, harbor_project,
       owner_id, owner_name, docker_container_name, k8s_project_name, compose_path, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [data.productLineId, data.name, data.displayName,
     data.gitlabPath ?? '', data.harborProject ?? '',
     data.ownerId ?? '', data.ownerName ?? '',
     data.dockerContainerName ?? '', data.k8sProjectName ?? '',
     data.composePath ?? '', data.description ?? '']
  )
  return mapRow(rows[0])
}

export async function updateProject(
  id: number,
  data: Partial<Pick<Project, 'name' | 'displayName' | 'gitlabPath' | 'harborProject' | 'ownerId' | 'ownerName' | 'dockerContainerName' | 'k8sProjectName' | 'composePath' | 'description' | 'productLineId'>>
): Promise<Project | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE projects SET name = COALESCE($2, name), display_name = COALESCE($3, display_name),
     gitlab_path = COALESCE($4, gitlab_path), harbor_project = COALESCE($5, harbor_project),
     owner_id = COALESCE($6, owner_id), owner_name = COALESCE($7, owner_name),
     docker_container_name = COALESCE($8, docker_container_name),
     k8s_project_name = COALESCE($9, k8s_project_name),
     compose_path = COALESCE($10, compose_path),
     description = COALESCE($11, description), product_line_id = COALESCE($12, product_line_id),
     updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.displayName ?? null, data.gitlabPath ?? null,
     data.harborProject ?? null, data.ownerId ?? null, data.ownerName ?? null,
     data.dockerContainerName ?? null, data.k8sProjectName ?? null,
     data.composePath ?? null, data.description ?? null, data.productLineId ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteProject(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
