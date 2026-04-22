import { Pool, types as pgTypes } from 'pg'
import { config } from '../config.js'

// 把 timestamp WITHOUT time zone（OID 1114）强制按 UTC 解析。
// 部分业务表（bug_analysis_reports / bug_fix_events / 等）的时间列用的是无时区 timestamp，
// pg 默认 parser 会按 node 本地时区（CST）把"2026-04-22 03:31:30"当 CST 解析，
// 得到的 Date 绝对时刻偏早 8h，JSON 序列化后前端显示错。
// 写入端用 now() 存的就是 UTC（pg 连接 timezone=UTC），读出端也按 UTC 解析才配对。
// 长期正解是把相关列 ALTER 成 timestamptz（见 TODO）。
pgTypes.setTypeParser(1114, (v: string) => new Date(v + 'Z'))

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.DATABASE_URL })
  }
  return pool
}
