import { getPool } from '../client.js'

export interface ModuleOwner {
  id: number
  productLineId: number
  modulePattern: string
  ownerUserId: string
  backupOwnerUserId: string | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): ModuleOwner {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    modulePattern: r.module_pattern as string,
    ownerUserId: r.owner_user_id as string,
    backupOwnerUserId: r.backup_owner_user_id as string | null,
    createdAt: r.created_at as Date,
  }
}

export async function findOwner(productLineId: number, module: string): Promise<ModuleOwner | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM module_owners
     WHERE product_line_id = $1 AND $2 LIKE REPLACE(module_pattern, '*', '%')
     ORDER BY LENGTH(module_pattern) DESC LIMIT 1`,
    [productLineId, module]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listModuleOwners(productLineId: number): Promise<ModuleOwner[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM module_owners WHERE product_line_id = $1 ORDER BY module_pattern',
    [productLineId]
  )
  return rows.map(mapRow)
}

export async function createModuleOwner(
  data: Pick<ModuleOwner, 'productLineId' | 'modulePattern' | 'ownerUserId' | 'backupOwnerUserId'>
): Promise<ModuleOwner> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO module_owners (product_line_id, module_pattern, owner_user_id, backup_owner_user_id)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [data.productLineId, data.modulePattern, data.ownerUserId, data.backupOwnerUserId ?? null]
  )
  return mapRow(rows[0])
}

export async function deleteModuleOwner(id: number): Promise<void> {
  const pool = getPool()
  await pool.query('DELETE FROM module_owners WHERE id = $1', [id])
}
