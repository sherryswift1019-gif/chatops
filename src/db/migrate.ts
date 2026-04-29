import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Pool } from 'pg'
import 'dotenv/config'
import {
  CREATE_PRD_SYSTEM_PROMPT,
  REVIEW_PRD_SYSTEM_PROMPT,
} from '../agent/prd/prompts.js'
import { CREATE_ARCH_SYSTEM_PROMPT } from '../agent/arch/prompts.js'
import { PRD_REVIEW_SYSTEM_PROMPT } from '../agent/prd-submit/prompts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// 所有 schema 文件按版本号升序，新增 schema 时在尾部追加一行。
// v27 原本是空号（开发阶段被 squash），merge main 后被 pipeline_node_types
// 注册表占用——必须早于 v34/v35/v36/v44（这些 schema 都 INSERT/UPDATE 该表）。
const SCHEMA_FILES: ReadonlyArray<readonly [string, string]> = [
  ['v1',  'schema.sql'],
  ['v2',  'schema-v2.sql'],
  ['v3',  'schema-v3.sql'],
  ['v4',  'schema-v4.sql'],
  ['v5',  'schema-v5.sql'],
  ['v6',  'schema-v6.sql'],
  ['v7',  'schema-v7.sql'],
  ['v8',  'schema-v8.sql'],
  ['v9',  'schema-v9.sql'],
  ['v10', 'schema-v10.sql'],
  ['v11', 'schema-v11.sql'],
  ['v12', 'schema-v12.sql'],
  ['v13', 'schema-v13.sql'],
  ['v14', 'schema-v14.sql'],
  ['v15', 'schema-v15.sql'],
  ['v16', 'schema-v16.sql'],
  ['v17', 'schema-v17.sql'],
  ['v18', 'schema-v18.sql'],
  ['v19', 'schema-v19.sql'],
  ['v20', 'schema-v20.sql'],
  ['v21', 'schema-v21.sql'],
  ['v22', 'schema-v22.sql'],
  ['v23', 'schema-v23.sql'],
  ['v24', 'schema-v24.sql'],
  ['v25', 'schema-v25.sql'],
  ['v26', 'schema-v26.sql'],
  ['v27', 'schema-v27.sql'],
  ['v28', 'schema-v28.sql'],
  ['v29', 'schema-v29.sql'],
  ['v30', 'schema-v30.sql'],
  ['v31', 'schema-v31.sql'],
  ['v32', 'schema-v32.sql'],
  ['v33', 'schema-v33.sql'],
  ['v34', 'schema-v34.sql'],
  ['v35', 'schema-v35.sql'],
  ['v36', 'schema-v36.sql'],
  ['v37', 'schema-v37.sql'],
  ['v38', 'schema-v38.sql'],
  ['v39', 'schema-v39.sql'],
  ['v40', 'schema-v40.sql'],
  ['v41', 'schema-v41.sql'],
  ['v42', 'schema-v42.sql'],
  ['v43', 'schema-v43.sql'],
  ['v44', 'schema-v44.sql'],
  ['v45', 'schema-v45.sql'],
  ['v46', 'schema-v46.sql'],
  ['v47', 'schema-v47.sql'],
  ['v48', 'schema-v48.sql'],
  ['v49', 'schema-v49.sql'],
  ['v50', 'schema-v50.sql'],
  ['v51', 'schema-v51.sql'],
  ['v52', 'schema-v52.sql'],
  ['v53', 'schema-v53.sql'],
  ['v54', 'schema-v54.sql'],
  ['v55', 'schema-v55.sql'],
  ['v56', 'schema-v56.sql'],
  ['v57', 'schema-v57.sql'],
  ['v58', 'schema-v58.sql'],
  ['v59', 'schema-v59.sql'],
]

// _migrations: 已 applied 的 schema 版本登记表。
// 引入此表前老库的 schema 文件每次 migrate 都重跑——v33 DROP capabilities.category
// 之后, v2/v4/v8/v12/v13/v16/v21/v24/v26/v28 的 INSERT INTO capabilities (..., category, ...)
// 在 SQL 解析阶段就报 42703,根本走不到 ON CONFLICT。改用版本登记 + 跳过已 applied 修掉。
await pool.query(`
  CREATE TABLE IF NOT EXISTS _migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`)

const { rows: appliedRows } = await pool.query(
  `SELECT version FROM _migrations`
)
const applied = new Set<string>(appliedRows.map((r: { version: string }) => r.version))

// Bootstrap legacy DB: _migrations 是空但 capabilities 表已存在 → 这是引入登记表
// 之前已经跑过 migrate 的老库, 用 fingerprint 推断已 applied 到哪个版本。
if (applied.size === 0) {
  const { rows: capTable } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'capabilities'`
  )
  if (capTable.length > 0) {
    const { rows: catCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'capabilities' AND column_name = 'category'`
    )
    const v33Applied = catCol.length === 0
    if (!v33Applied) {
      // 老库但停在 v33 之前 (category 列还在), 没有幂等问题, 让下方循环正常按文件跑。
      console.log('[migrate] legacy DB detected (pre-v33), running all schema files')
    } else {
      // v33 之后状态: 顺序执行的 migrate.ts 一旦跑到 v33 必然往后跑到当时最新版本。
      // 用更新的 fingerprint 锚定上次跑到的最远版本。
      const { rows: icpTable } = await pool.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_name = 'internal_capability_pipelines'`
      )
      const v37Applied = icpTable.length > 0
      const { rows: fkRow } = await pool.query(
        `SELECT confdeltype FROM pg_constraint
          WHERE conname = 'im_triggers_pipeline_id_fkey'`
      )
      const v38Applied = fkRow.length > 0 && fkRow[0].confdeltype === 'n'

      const upTo = v38Applied ? 38 : v37Applied ? 37 : 33
      for (const [version] of SCHEMA_FILES) {
        const num = version === 'v1' ? 1 : Number(version.slice(1))
        if (num <= upTo) {
          await pool.query(
            `INSERT INTO _migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
            [version]
          )
          applied.add(version)
        }
      }
      console.log(`[migrate] bootstrapped legacy DB: marked v1..v${upTo} as applied`)
    }
  }
}

let appliedThisRun = 0
for (const [version, file] of SCHEMA_FILES) {
  if (applied.has(version)) continue
  const sql = readFileSync(join(__dirname, file), 'utf8')
  await pool.query(sql)
  await pool.query(
    `INSERT INTO _migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
    [version]
  )
  console.log(`[migrate] ${version} applied`)
  appliedThisRun++
}
if (appliedThisRun === 0) {
  console.log('[migrate] all schema files already applied, nothing to run')
}

// Sync PRD system prompts from prompts.ts (code is the truth source).
// - default_system_prompt: always refreshed from code.
// - system_prompt: refreshed only when it still equals the previous default
//   (i.e. admin hasn't hand-edited via Web). Admin edits are preserved.
await pool.query(
  `UPDATE capabilities
     SET system_prompt = $2,
         default_system_prompt = $2,
         updated_at = NOW()
   WHERE key = $1
     AND (system_prompt IS NULL OR system_prompt = default_system_prompt)`,
  ['create_prd', CREATE_PRD_SYSTEM_PROMPT]
)
await pool.query(
  `UPDATE capabilities
     SET default_system_prompt = $2, updated_at = NOW()
   WHERE key = $1 AND default_system_prompt IS DISTINCT FROM $2`,
  ['create_prd', CREATE_PRD_SYSTEM_PROMPT]
)
await pool.query(
  `UPDATE capabilities
     SET system_prompt = $2,
         default_system_prompt = $2,
         updated_at = NOW()
   WHERE key = $1
     AND (system_prompt IS NULL OR system_prompt = default_system_prompt)`,
  ['review_prd', REVIEW_PRD_SYSTEM_PROMPT]
)
await pool.query(
  `UPDATE capabilities
     SET default_system_prompt = $2, updated_at = NOW()
   WHERE key = $1 AND default_system_prompt IS DISTINCT FROM $2`,
  ['review_prd', REVIEW_PRD_SYSTEM_PROMPT]
)

// prd_ai_review_mr (v28): PRD 主动提交链路的 MR diff review prompt。
// 与 create_prd / review_prd 同模式两段式 UPDATE。
await pool.query(
  `UPDATE capabilities
     SET system_prompt = $2,
         default_system_prompt = $2,
         updated_at = NOW()
   WHERE key = $1
     AND (system_prompt IS NULL OR system_prompt = default_system_prompt)`,
  ['prd_ai_review_mr', PRD_REVIEW_SYSTEM_PROMPT]
)
await pool.query(
  `UPDATE capabilities
     SET default_system_prompt = $2, updated_at = NOW()
   WHERE key = $1 AND default_system_prompt IS DISTINCT FROM $2`,
  ['prd_ai_review_mr', PRD_REVIEW_SYSTEM_PROMPT]
)

// touch CREATE_ARCH_SYSTEM_PROMPT to retain import (placeholder for future arch prompt sync)
void CREATE_ARCH_SYSTEM_PROMPT

await pool.end()
console.log('✅ Database schema applied via _migrations tracker')
