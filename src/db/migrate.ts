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

await pool.end()
console.log('✅ Database schema applied (v1 + v2 + v3)')
