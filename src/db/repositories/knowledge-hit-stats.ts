import { getPool } from '../client.js'

export interface KnowledgeHitStat {
  id: number
  entryId: string
  productLineId: number
  hitCount: number
  lastHitAt: Date | null
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): KnowledgeHitStat {
  return {
    id: r.id as number,
    entryId: r.entry_id as string,
    productLineId: r.product_line_id as number,
    hitCount: r.hit_count as number,
    lastHitAt: r.last_hit_at as Date | null,
    updatedAt: r.updated_at as Date,
  }
}

export async function incrementHit(entryId: string, productLineId: number): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO knowledge_hit_stats (entry_id, product_line_id, hit_count, last_hit_at, updated_at)
     VALUES ($1, $2, 1, NOW(), NOW())
     ON CONFLICT (entry_id, product_line_id)
     DO UPDATE SET hit_count = knowledge_hit_stats.hit_count + 1, last_hit_at = NOW(), updated_at = NOW()`,
    [entryId, productLineId]
  )
}

export async function getTopHits(productLineId: number, limit = 20): Promise<KnowledgeHitStat[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM knowledge_hit_stats WHERE product_line_id = $1 ORDER BY hit_count DESC LIMIT $2',
    [productLineId, limit]
  )
  return rows.map(mapRow)
}
