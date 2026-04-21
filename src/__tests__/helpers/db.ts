import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 测试库 marker 表名（防误连生产/开发库的唯一硬防线）。
 * resetTestDb 在 DROP SCHEMA 前校验此表存在，否则立即中止；
 * 重建 schema 之后再把此表种回去（因为 DROP SCHEMA CASCADE 会把它一起删）。
 */
export const TEST_DB_MARKER_TABLE = 'chatops_test_db_marker'

/**
 * 断言 DATABASE_URL 在测试环境下已设置（仅非空校验）。
 * 不抛的场景：NODE_ENV 非 test（跳过，不干扰生产/开发环境的调用）。
 * 抛的场景：NODE_ENV=test 且 DATABASE_URL 未设置。
 *
 * 注：URL 名字约定（含 _test 或白名单）已移除，唯一防线是 resetTestDb 内部的
 * marker 表 `chatops_test_db_marker`——生产/开发库绝无此表，DROP SCHEMA 前会
 * 校验，缺失立即中止。放宽 URL 校验是为了让 GitLab CI 直接用 `.../chatops`
 * 跑测试（CI 容器里 postgres service 默认 db 名就叫 chatops）。
 */
export function assertDatabaseUrlForTests(
  databaseUrl: string | undefined,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv !== 'test') return
  if (!databaseUrl) {
    throw new Error(
      `[test setup] DATABASE_URL 未设置。` +
      ` 测试运行时必须显式传 DATABASE_URL（resetTestDb 会再校验 marker 表 ${TEST_DB_MARKER_TABLE} 防止误连开发/生产库）。`,
    )
  }
}

// Vitest setup file: ensures tool modules that transitively load src/config.ts
// can be imported in unit tests without a real DATABASE_URL in the environment.
// Integration tests that actually talk to Postgres must set their own URL.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/chatops_test'
}

// 总门：测试环境下 DATABASE_URL 必须已设置（仅非空校验，名字约定已移除）
// 真正的测试库/生产库判别交给 resetTestDb 里的 marker 表校验
assertDatabaseUrlForTests(
  process.env.DATABASE_URL,
  process.env.NODE_ENV,
)

// Pipeline executor resolves TEST_DATA_DIR at module-load time; must be set
// before any pipeline import, which happens before any beforeAll().
if (!process.env.TEST_DATA_DIR) {
  process.env.TEST_DATA_DIR = '/tmp/chatops-test-runs'
}

let testPool: Pool | null = null

export function getTestPool(): Pool {
  if (!testPool) {
    testPool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return testPool
}

interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * 三叉防御：
 * 1. NODE_ENV 必须为 'test'（vitest 自动设置）——拦非测试进程的意外调用
 * 2. 有 marker 表 → 通过（本地开发者已 bootstrap 过的测试库）
 * 3. 无 marker 表 + public schema 完全空 → 视为全新测试库，自动 bootstrap marker 后通过
 *    （GitLab CI 里 postgres service 刚启动时 public 就是空的；开发库/生产库不可能空）
 * 4. 无 marker 表 + public schema 有业务表 → throw（典型开发库/生产库，硬防线）
 *
 * 抛出错误时必须包含 bootstrap 指南（CREATE TABLE + INSERT），让用户知道如何合法初始化测试 DB。
 */
export async function assertTestDbSafeToReset(
  pool: QueryablePool,
  nodeEnv: string | undefined,
  databaseUrl: string | undefined,
): Promise<void> {
  if (nodeEnv !== 'test') {
    throw new Error(
      `resetTestDb() 拒绝执行：NODE_ENV=${nodeEnv}，必须为 'test'。` +
      ` 正常跑测试时 vitest 会自动设 NODE_ENV=test。如果你在写脚本绕过了该机制，请检查调用链。`,
    )
  }

  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=$1`,
    [TEST_DB_MARKER_TABLE],
  )
  if (rows.length > 0) return

  // marker 缺失——判断是否为"全新空库"场景：public schema 一个表都没有就视为 CI 的全新 postgres 容器
  // 开发库/生产库必有业务表（capabilities / projects / users ...），不会误判
  const { rows: tableRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname='public'`,
  )
  const tableCount = Number((tableRows[0] as { n?: number })?.n ?? 0)
  if (tableCount === 0) {
    // 全新空库 → 自动 bootstrap marker，后续 resetTestDb 的 DROP SCHEMA CASCADE 会再把它一起删
    // 再次重建 schema 时 resetTestDb 会把 marker 重新种回来（末尾 CREATE + INSERT）
    await pool.query(`CREATE TABLE ${TEST_DB_MARKER_TABLE} (id INT PRIMARY KEY)`)
    await pool.query(`INSERT INTO ${TEST_DB_MARKER_TABLE} (id) VALUES (1)`)
    console.log(
      `[test] 空库自动 bootstrap marker 表 ${TEST_DB_MARKER_TABLE} (${databaseUrl})`,
    )
    return
  }

  throw new Error(
    `resetTestDb() 拒绝执行：当前 DB (${databaseUrl}) 缺少 marker 表 "${TEST_DB_MARKER_TABLE}"，` +
    `不能确认是测试库（public schema 有 ${tableCount} 个业务表，不像全新空库）。\n\nBootstrap 说明（只需做一次，确认当前连接的库确实是专用测试库后）：\n` +
    `  psql "${databaseUrl}" -c "CREATE TABLE ${TEST_DB_MARKER_TABLE} (id INT PRIMARY KEY); INSERT INTO ${TEST_DB_MARKER_TABLE} (id) VALUES (1);"`,
  )
}

const SCHEMA_FILES = [
  'schema.sql',
  'schema-v2.sql',
  'schema-v3.sql',
  'schema-v4.sql',
  'schema-v5.sql',
  'schema-v6.sql',
  'schema-v7.sql',
  'schema-v8.sql',
  'schema-v9.sql',
  'schema-v10.sql',
  'schema-v11.sql',
  'schema-v12.sql',
  'schema-v13.sql',
  'schema-v14.sql',
  'schema-v15.sql',
  'schema-v16.sql',
  'schema-v17.sql',
]

export async function resetTestDb(): Promise<void> {
  const pool = getTestPool()
  await assertTestDbSafeToReset(pool, process.env.NODE_ENV, process.env.DATABASE_URL)
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  for (const file of SCHEMA_FILES) {
    const sql = readFileSync(join(process.cwd(), 'src/db', file), 'utf8')
    await pool.query(sql)
  }
  // DROP SCHEMA CASCADE 把 marker 一并删了，重建 schema 后补回来供下次校验
  await pool.query(`CREATE TABLE ${TEST_DB_MARKER_TABLE} (id INT PRIMARY KEY)`)
  await pool.query(`INSERT INTO ${TEST_DB_MARKER_TABLE} (id) VALUES (1)`)
}
