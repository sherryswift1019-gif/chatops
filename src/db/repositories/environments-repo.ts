import { getPool } from '../client.js'

export interface Environment {
  id: number
  name: string
  displayName: string
  defaultRuntime: 'kubernetes' | 'docker'
  sortOrder: number
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): Environment {
  return {
    id: r.id as number,
    name: r.name as string,
    displayName: r.display_name as string,
    defaultRuntime: (r.default_runtime as string ?? 'docker') as 'kubernetes' | 'docker',
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as Date,
  }
}

export async function listEnvironments(): Promise<Environment[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM environments ORDER BY sort_order, id')
  return rows.map(mapRow)
}

export async function getEnvironmentById(id: number): Promise<Environment | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM environments WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createEnvironment(
  data: Pick<Environment, 'name' | 'displayName'> & Partial<Pick<Environment, 'defaultRuntime' | 'sortOrder'>>
): Promise<Environment> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO environments (name, display_name, default_runtime, sort_order)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.name, data.displayName, data.defaultRuntime ?? 'docker', data.sortOrder ?? 0]
  )
  return mapRow(rows[0])
}

export async function updateEnvironment(
  id: number,
  data: Partial<Pick<Environment, 'name' | 'displayName' | 'defaultRuntime' | 'sortOrder'>>
): Promise<Environment | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE environments SET
       name = COALESCE($2, name),
       display_name = COALESCE($3, display_name),
       default_runtime = COALESCE($4, default_runtime),
       sort_order = COALESCE($5, sort_order)
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.displayName ?? null, data.defaultRuntime ?? null, data.sortOrder ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteEnvironment(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM environments WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
