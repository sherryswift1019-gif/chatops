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

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
await pool.query(schema)

const schemaV2 = readFileSync(join(__dirname, 'schema-v2.sql'), 'utf8')
await pool.query(schemaV2)

const schemaV3 = readFileSync(join(__dirname, 'schema-v3.sql'), 'utf8')
await pool.query(schemaV3)

const schemaV4 = readFileSync(join(__dirname, 'schema-v4.sql'), 'utf8')
await pool.query(schemaV4)

const schemaV5 = readFileSync(join(__dirname, 'schema-v5.sql'), 'utf8')
await pool.query(schemaV5)

const schemaV6 = readFileSync(join(__dirname, 'schema-v6.sql'), 'utf8')
await pool.query(schemaV6)

const schemaV7 = readFileSync(join(__dirname, 'schema-v7.sql'), 'utf8')
await pool.query(schemaV7)

const schemaV8 = readFileSync(join(__dirname, 'schema-v8.sql'), 'utf8')
await pool.query(schemaV8)

const schemaV9 = readFileSync(join(__dirname, 'schema-v9.sql'), 'utf8')
await pool.query(schemaV9)

const schemaV10 = readFileSync(join(__dirname, 'schema-v10.sql'), 'utf8')
await pool.query(schemaV10)

const schemaV11 = readFileSync(join(__dirname, 'schema-v11.sql'), 'utf8')
await pool.query(schemaV11)

const schemaV12 = readFileSync(join(__dirname, 'schema-v12.sql'), 'utf8')
await pool.query(schemaV12)
console.log('[migrate] schema-v12 applied')

const schemaV13 = readFileSync(join(__dirname, 'schema-v13.sql'), 'utf8')
await pool.query(schemaV13)
console.log('[migrate] schema-v13 applied')

const schemaV14 = readFileSync(join(__dirname, 'schema-v14.sql'), 'utf8')
await pool.query(schemaV14)
console.log('[migrate] schema-v14 applied')

const schemaV15 = readFileSync(join(__dirname, 'schema-v15.sql'), 'utf8')
await pool.query(schemaV15)
console.log('[migrate] schema-v15 applied')

const schemaV16 = readFileSync(join(__dirname, 'schema-v16.sql'), 'utf8')
await pool.query(schemaV16)
console.log('[migrate] schema-v16 applied')

const schemaV17 = readFileSync(join(__dirname, 'schema-v17.sql'), 'utf8')
await pool.query(schemaV17)
console.log('[migrate] schema-v17 applied')

const schemaV18 = readFileSync(join(__dirname, 'schema-v18.sql'), 'utf8')
await pool.query(schemaV18)
console.log('[migrate] schema-v18 applied')

const schemaV19 = readFileSync(join(__dirname, 'schema-v19.sql'), 'utf8')
await pool.query(schemaV19)
console.log('[migrate] schema-v19 applied')

const schemaV20 = readFileSync(join(__dirname, 'schema-v20.sql'), 'utf8')
await pool.query(schemaV20)
console.log('[migrate] schema-v20 applied')

const schemaV21 = readFileSync(join(__dirname, 'schema-v21.sql'), 'utf8')
await pool.query(schemaV21)
console.log('[migrate] schema-v21 applied')

const schemaV22 = readFileSync(join(__dirname, 'schema-v22.sql'), 'utf8')
await pool.query(schemaV22)
console.log('[migrate] schema-v22 applied')

const schemaV23 = readFileSync(join(__dirname, 'schema-v23.sql'), 'utf8')
await pool.query(schemaV23)
console.log('[migrate] schema-v23 applied')

const schemaV24 = readFileSync(join(__dirname, 'schema-v24.sql'), 'utf8')
await pool.query(schemaV24)
console.log('[migrate] schema-v24 applied')

const schemaV25 = readFileSync(join(__dirname, 'schema-v25.sql'), 'utf8')
await pool.query(schemaV25)
console.log('[migrate] schema-v25 applied')

const schemaV26 = readFileSync(join(__dirname, 'schema-v26.sql'), 'utf8')
await pool.query(schemaV26)
console.log('[migrate] schema-v26 applied')

const schemaV28 = readFileSync(join(__dirname, 'schema-v28.sql'), 'utf8')
await pool.query(schemaV28)
console.log('[migrate] schema-v28 applied')

const schemaV29 = readFileSync(join(__dirname, 'schema-v29.sql'), 'utf8')
await pool.query(schemaV29)
console.log('[migrate] schema-v29 applied')

const schemaV45 = readFileSync(join(__dirname, 'schema-v45.sql'), 'utf8')
await pool.query(schemaV45)
console.log('[migrate] schema-v45 applied')

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

await pool.end()
console.log('✅ Database schema applied (v1 ~ v26 + v28 + v29 + v45, 含 PRD v16/v17 + pipeline canvas v18 + IM binding v19 + drop module_owners v20 + view_branches v21 + trigger_sources v22 + PRD V2 metrics v23 + Arch Agent v24 + pam bootstrap v25 + capability prompts v26 + PRD active submit MR v28 + product_lines FK cascade v29 + pipeline_dryrun_snapshots + test_runs.trigger_params v45)')
