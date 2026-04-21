import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Pool } from 'pg'
import 'dotenv/config'

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

await pool.end()
console.log('✅ Database schema applied (v1 ~ v15, 含 completed_at + triggered_by)')
