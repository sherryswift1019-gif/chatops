import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 断言 DATABASE_URL 在测试环境下指向测试库（含 _test 或在白名单里）。
 * 不抛的场景：NODE_ENV 非 test（跳过，不干扰生产/开发环境的调用）。
 * 抛的场景：NODE_ENV=test 且 DATABASE_URL 未设 / 指向非测试库。
 *
 * 这是 DROP/INSERT/UPDATE 级别的"总门"——B2+B3 只防 resetTestDb 的 DROP，
 * 防不住 integration 测试 seedReport 通过 getPool/getTestPool 的 INSERT 污染。
 * 本函数在 setupFiles 顶部统一断言，测试任何路径都无法触达非测试库。
 */
export function assertDatabaseUrlForTests(
  databaseUrl: string | undefined,
  nodeEnv: string | undefined,
  allowedDbNames?: string,
): void {
  if (nodeEnv !== 'test') return
  if (!databaseUrl) {
    throw new Error(
      `[test setup] DATABASE_URL 未设置。` +
      ` 测试运行时必须显式传 DATABASE_URL=postgres://.../chatops_test（或设 NODE_ENV!=test 跳过校验）。`,
    )
  }
  const whitelist = new Set(
    (allowedDbNames ?? '').split(',').map(n => n.trim()).filter(Boolean),
  )
  const dbName = databaseUrl.split('/').pop() ?? ''
  const dbNameBeforeQuery = dbName.split('?')[0]
  const okByConvention = dbNameBeforeQuery.includes('_test')
  const okByWhitelist = whitelist.has(dbNameBeforeQuery)
  if (!okByConvention && !okByWhitelist) {
    throw new Error(
      `[test setup] DATABASE_URL 指向非测试库 (${databaseUrl})。` +
      ` 测试库名需含 "_test" 或在 ALLOWED_TEST_DB_NAMES 白名单里，避免 seedReport / resetTestDb 等污染开发/生产库。`,
    )
  }
}

// Vitest setup file: ensures tool modules that transitively load src/config.ts
// can be imported in unit tests without a real DATABASE_URL in the environment.
// Integration tests that actually talk to Postgres must set their own URL.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/chatops_test'
}

// 总门：测试环境下 DATABASE_URL 必须指向测试库，不通过立即中止 vitest 启动
// 必须在任何业务代码 import（如 config.ts 的 `import 'dotenv/config'`）之后再次校验
assertDatabaseUrlForTests(
  process.env.DATABASE_URL,
  process.env.NODE_ENV,
  process.env.ALLOWED_TEST_DB_NAMES,
)

let testPool: Pool | null = null

export function getTestPool(): Pool {
  if (!testPool) {
    testPool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return testPool
}

/**
 * 测试库 marker 表名（第二道防御：生产库绝不会有此表）。
 * resetTestDb 在 DROP SCHEMA 前校验此表存在，否则立即中止；
 * 重建 schema 之后再把此表种回去（因为 DROP SCHEMA CASCADE 会把它一起删）。
 */
export const TEST_DB_MARKER_TABLE = 'chatops_test_db_marker'

interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * 双重防御：
 * 1. NODE_ENV 必须为 'test'（vitest 自动设置）——拦非测试进程的意外调用
 * 2. 当前 DB 必须存在 marker 表 `chatops_test_db_marker`——拦 NODE_ENV 被误设的极端情况
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
  if (rows.length === 0) {
    throw new Error(
      `resetTestDb() 拒绝执行：当前 DB (${databaseUrl}) 缺少 marker 表 "${TEST_DB_MARKER_TABLE}"，` +
      `不能确认是测试库。\n\nBootstrap 说明（只需做一次，确认当前连接的库确实是专用测试库后）：\n` +
      `  psql "${databaseUrl}" -c "CREATE TABLE ${TEST_DB_MARKER_TABLE} (id INT PRIMARY KEY); INSERT INTO ${TEST_DB_MARKER_TABLE} (id) VALUES (1);"`,
    )
  }
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
