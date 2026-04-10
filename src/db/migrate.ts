import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Pool } from 'pg'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

await pool.query(sql)
await pool.end()
console.log('✅ Database schema applied')
