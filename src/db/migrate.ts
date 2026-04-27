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

const schemaV30 = readFileSync(join(__dirname, 'schema-v30.sql'), 'utf8')
await pool.query(schemaV30)
console.log('[migrate] schema-v30 applied')

const schemaV31 = readFileSync(join(__dirname, 'schema-v31.sql'), 'utf8')
await pool.query(schemaV31)
console.log('[migrate] schema-v31 applied')

const schemaV32 = readFileSync(join(__dirname, 'schema-v32.sql'), 'utf8')
await pool.query(schemaV32)
console.log('[migrate] schema-v32 applied')

const schemaV33 = readFileSync(join(__dirname, 'schema-v33.sql'), 'utf8')
await pool.query(schemaV33)
console.log('[migrate] schema-v33 applied')

const schemaV34 = readFileSync(join(__dirname, 'schema-v34.sql'), 'utf8')
await pool.query(schemaV34)
console.log('[migrate] schema-v34 applied')

const schemaV35 = readFileSync(join(__dirname, 'schema-v35.sql'), 'utf8')
await pool.query(schemaV35)
console.log('[migrate] schema-v35 applied')

const schemaV36 = readFileSync(join(__dirname, 'schema-v36.sql'), 'utf8')
await pool.query(schemaV36)
console.log('[migrate] schema-v36 applied')

const schemaV37 = readFileSync(join(__dirname, 'schema-v37.sql'), 'utf8')
await pool.query(schemaV37)
console.log('[migrate] schema-v37 applied')

const schemaV40 = readFileSync(join(__dirname, 'schema-v40.sql'), 'utf8')
await pool.query(schemaV40)
console.log('[migrate] schema-v40 applied')

const schemaV41 = readFileSync(join(__dirname, 'schema-v41.sql'), 'utf8')
await pool.query(schemaV41)
console.log('[migrate] schema-v41 applied')

const schemaV42 = readFileSync(join(__dirname, 'schema-v42.sql'), 'utf8')
await pool.query(schemaV42)
console.log('[migrate] schema-v42 applied')


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
console.log('✅ Database schema applied (v1 ~ v26 + v28 + v29 + v30 + v31 + v32 + v33 + v34 + v35 + v36 + v37 + v40 + v41 + im_triggers v32 + capabilities-cleanup v33 + node-types-7-new v34 + node-types-enable v35 + capability-rename-llm_agent v36 + internal_capability_pipelines v37 + notify-internal v40 + create-mr-internal v41, 含 PRD v16/v17 + pipeline canvas v18 + IM binding v19 + drop module_owners v20 + view_branches v21 + trigger_sources v22 + PRD V2 metrics v23 + Arch Agent v24 + pam bootstrap v25 + capability prompts v26 + PRD active submit MR v28 + product_lines FK cascade v29 + pipeline_node_types v30 + capabilities-extended-fields v31 + im_triggers v32 + capabilities cleanup v33 + node-types-7-new v34 + node-types-enable v35 + capability→llm_agent v36 + internal_capability_pipelines v37 + notify-internal pipeline v40 + create-mr-internal pipeline v41)')
