import { getPool } from '../client.js'

export interface MetricDaily {
  id: number
  date: Date
  productLineId: number | null
  metricKey: string
  metricValue: number
  metadata: Record<string, unknown> | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): MetricDaily {
  return {
    id: r.id as number,
    date: r.date as Date,
    productLineId: r.product_line_id as number | null,
    metricKey: r.metric_key as string,
    metricValue: Number(r.metric_value),
    metadata: r.metadata as Record<string, unknown> | null,
    createdAt: r.created_at as Date,
  }
}

export async function upsertMetric(
  date: Date, productLineId: number | null, metricKey: string, metricValue: number, metadata?: Record<string, unknown>
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO metrics_daily (date, product_line_id, metric_key, metric_value, metadata)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (date, product_line_id, metric_key)
     DO UPDATE SET metric_value = $4, metadata = COALESCE($5, metrics_daily.metadata)`,
    [date, productLineId, metricKey, metricValue, metadata ? JSON.stringify(metadata) : null]
  )
}

export async function getMetricRange(
  productLineId: number | null, metricKey: string, fromDate: Date, toDate: Date
): Promise<MetricDaily[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM metrics_daily
     WHERE (product_line_id = $1 OR ($1 IS NULL AND product_line_id IS NULL))
       AND metric_key = $2 AND date >= $3 AND date <= $4
     ORDER BY date`,
    [productLineId, metricKey, fromDate, toDate]
  )
  return rows.map(mapRow)
}
