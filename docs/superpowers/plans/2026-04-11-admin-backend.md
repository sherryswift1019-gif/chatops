# ChatOps Admin Configuration Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the admin configuration backend API for the ChatOps platform, providing RESTful endpoints under `/admin` for managing product lines, projects, environments, approval rules, DingTalk user sync, and system configuration.

**Architecture:** New repositories layer (one per table) following existing patterns (`getPool()` from `client.js`, snake_case to camelCase mapping). Admin routes registered as a Fastify plugin under `/admin` prefix. DingTalk user sync service calls DingTalk OpenAPI using credentials from `system_config` table.

**Tech Stack:** Node.js 20, TypeScript, Fastify 5, PostgreSQL 16, pg driver, Vitest, pnpm, ESM (.js extensions)

---

## File Map

```
src/
  db/
    schema-v2.sql                        # DDL for all new tables + ALTER for approval_rules
    migrate.ts                           # Updated to also apply schema-v2.sql
    repositories/
      product-lines.ts                   # CRUD for product_lines
      product-line-members.ts            # CRUD for product_line_members
      projects-repo.ts                   # CRUD for projects (named to avoid conflict)
      environments-repo.ts               # CRUD for environments (named to avoid conflict)
      product-line-envs.ts               # CRUD for product_line_envs
      dingtalk-users.ts                  # UPSERT + search for dingtalk_users
      system-config.ts                   # get/set/getAll for system_config
      approval-rules.ts                  # Updated: add productLineId, updateApprovalRule, deleteApprovalRule
  admin/
    index.ts                             # Register all admin routes as Fastify plugin
    services/
      dingtalk-sync.ts                   # Sync users from DingTalk OpenAPI
    routes/
      product-lines.ts                   # Product line CRUD + members + envs sub-routes
      projects.ts                        # Project CRUD
      environments.ts                    # Environment CRUD
      approval-rules.ts                  # Approval rules CRUD with product_line_id filter
      dingtalk-users.ts                  # User list + sync trigger
      system-config.ts                   # Config get/put with secret masking
  server.ts                              # Updated: register admin routes plugin
  __tests__/
    helpers/
      db.ts                              # Updated: also apply schema-v2.sql
    unit/
      admin-repositories.test.ts         # Tests for new repositories
      admin-routes.test.ts               # Tests for admin route handlers
```

---

## Task 1: Schema v2 + Migrate Script Update

**Files:**
- Create: `src/db/schema-v2.sql`
- Update: `src/db/migrate.ts`
- Update: `src/__tests__/helpers/db.ts`

- [ ] **Step 1: Write `src/db/schema-v2.sql`**

```sql
-- product_lines
CREATE TABLE IF NOT EXISTS product_lines (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  description   TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- product_line_members
CREATE TABLE IF NOT EXISTS product_line_members (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  user_name        TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('developer','ops','admin')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_line_id, user_id)
);

-- projects
CREATE TABLE IF NOT EXISTS projects (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  gitlab_path      TEXT DEFAULT '',
  harbor_project   TEXT DEFAULT '',
  owner_id         TEXT DEFAULT '',
  owner_name       TEXT DEFAULT '',
  description      TEXT DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- environments
CREATE TABLE IF NOT EXISTS environments (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- product_line_envs
CREATE TABLE IF NOT EXISTS product_line_envs (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  env_id           INT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  runtime          TEXT NOT NULL CHECK (runtime IN ('kubernetes','docker')),
  namespace        TEXT DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(product_line_id, env_id)
);

-- dingtalk_users
CREATE TABLE IF NOT EXISTS dingtalk_users (
  user_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT DEFAULT '',
  department  TEXT DEFAULT '',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- system_config
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add product_line_id to existing approval_rules
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS product_line_id INT REFERENCES product_lines(id) ON DELETE CASCADE;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_product_line_members_pl ON product_line_members(product_line_id);
CREATE INDEX IF NOT EXISTS idx_projects_pl ON projects(product_line_id);
CREATE INDEX IF NOT EXISTS idx_product_line_envs_pl ON product_line_envs(product_line_id);
CREATE INDEX IF NOT EXISTS idx_dingtalk_users_name ON dingtalk_users(name);
CREATE INDEX IF NOT EXISTS idx_approval_rules_pl ON approval_rules(product_line_id);
```

- [ ] **Step 2: Update `src/db/migrate.ts`** to also apply schema-v2.sql

The current migrate.ts reads only `schema.sql`. Update it to read and execute both schema files sequentially.

```typescript
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Pool } from 'pg'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const schemaV1 = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
const schemaV2 = readFileSync(join(__dirname, 'schema-v2.sql'), 'utf8')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

await pool.query(schemaV1)
await pool.query(schemaV2)
await pool.end()
console.log('✅ Database schema applied (v1 + v2)')
```

- [ ] **Step 3: Update `src/__tests__/helpers/db.ts`** to apply both schemas on reset

```typescript
import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

let testPool: Pool | null = null

export function getTestPool(): Pool {
  if (!testPool) {
    testPool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return testPool
}

export async function resetTestDb(): Promise<void> {
  const pool = getTestPool()
  const schemaV1 = readFileSync(join(process.cwd(), 'src/db/schema.sql'), 'utf8')
  const schemaV2 = readFileSync(join(process.cwd(), 'src/db/schema-v2.sql'), 'utf8')
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await pool.query(schemaV1)
  await pool.query(schemaV2)
}
```

- [ ] **Step 4: Verify migration**

```bash
pnpm migrate
```

Expected: `✅ Database schema applied (v1 + v2)`

- [ ] **Step 5: Verify existing tests still pass**

```bash
pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add src/db/schema-v2.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat: add schema-v2 with admin tables and update migration script"
```

---

## Task 2: System Config Repository

**Files:**
- Create: `src/db/repositories/system-config.ts`

- [ ] **Step 1: Write `src/db/repositories/system-config.ts`**

Follow existing repository pattern: import `getPool` from `../client.js`, export interface + functions, use parameterized queries.

```typescript
import { getPool } from '../client.js'

export interface SystemConfigEntry {
  key: string
  value: Record<string, unknown>
  updatedAt: Date
}

export async function getConfig(key: string): Promise<SystemConfigEntry | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM system_config WHERE key = $1',
    [key]
  )
  if (!rows[0]) return null
  return {
    key: rows[0].key,
    value: rows[0].value,
    updatedAt: rows[0].updated_at,
  }
}

export async function setConfig(key: string, value: Record<string, unknown>): Promise<SystemConfigEntry> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO system_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
     RETURNING *`,
    [key, JSON.stringify(value)]
  )
  return {
    key: rows[0].key,
    value: rows[0].value,
    updatedAt: rows[0].updated_at,
  }
}

export async function getAllConfig(): Promise<SystemConfigEntry[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM system_config ORDER BY key')
  return rows.map(r => ({
    key: r.key,
    value: r.value,
    updatedAt: r.updated_at,
  }))
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/system-config.ts
git commit -m "feat: system-config repository — get/set/getAll for system_config table"
```

---

## Task 3: Product Lines Repository

**Files:**
- Create: `src/db/repositories/product-lines.ts`

- [ ] **Step 1: Write `src/db/repositories/product-lines.ts`**

Full CRUD: list, getById, create, update, delete.

```typescript
import { getPool } from '../client.js'

export interface ProductLine {
  id: number
  name: string
  displayName: string
  description: string
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): ProductLine {
  return {
    id: r.id as number,
    name: r.name as string,
    displayName: r.display_name as string,
    description: r.description as string,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listProductLines(): Promise<ProductLine[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM product_lines ORDER BY id')
  return rows.map(mapRow)
}

export async function getProductLineById(id: number): Promise<ProductLine | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM product_lines WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createProductLine(
  data: Pick<ProductLine, 'name' | 'displayName' | 'description'>
): Promise<ProductLine> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ($1, $2, $3) RETURNING *`,
    [data.name, data.displayName, data.description ?? '']
  )
  return mapRow(rows[0])
}

export async function updateProductLine(
  id: number,
  data: Partial<Pick<ProductLine, 'name' | 'displayName' | 'description'>>
): Promise<ProductLine | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE product_lines
     SET name = COALESCE($2, name),
         display_name = COALESCE($3, display_name),
         description = COALESCE($4, description),
         updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.displayName ?? null, data.description ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteProductLine(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM product_lines WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/product-lines.ts
git commit -m "feat: product-lines repository — CRUD for product_lines table"
```

---

## Task 4: Product Line Members Repository

**Files:**
- Create: `src/db/repositories/product-line-members.ts`

- [ ] **Step 1: Write `src/db/repositories/product-line-members.ts`**

```typescript
import { getPool } from '../client.js'

export interface ProductLineMember {
  id: number
  productLineId: number
  userId: string
  userName: string
  role: 'developer' | 'ops' | 'admin'
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): ProductLineMember {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    userId: r.user_id as string,
    userName: r.user_name as string,
    role: r.role as 'developer' | 'ops' | 'admin',
    createdAt: r.created_at as Date,
  }
}

export async function listMembers(productLineId: number): Promise<ProductLineMember[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM product_line_members WHERE product_line_id = $1 ORDER BY id',
    [productLineId]
  )
  return rows.map(mapRow)
}

export async function addMember(
  data: Pick<ProductLineMember, 'productLineId' | 'userId' | 'userName' | 'role'>
): Promise<ProductLineMember> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_line_members (product_line_id, user_id, user_name, role)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.productLineId, data.userId, data.userName, data.role]
  )
  return mapRow(rows[0])
}

export async function updateMemberRole(
  id: number,
  role: 'developer' | 'ops' | 'admin'
): Promise<ProductLineMember | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    'UPDATE product_line_members SET role = $2 WHERE id = $1 RETURNING *',
    [id, role]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function removeMember(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    'DELETE FROM product_line_members WHERE id = $1',
    [id]
  )
  return (rowCount ?? 0) > 0
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/product-line-members.ts
git commit -m "feat: product-line-members repository — CRUD for product_line_members table"
```

---

## Task 5: Projects Repository

**Files:**
- Create: `src/db/repositories/projects-repo.ts`

Named `projects-repo.ts` (not `projects.ts`) to avoid ambiguity with any existing project-related types/modules.

- [ ] **Step 1: Write `src/db/repositories/projects-repo.ts`**

```typescript
import { getPool } from '../client.js'

export interface Project {
  id: number
  productLineId: number
  name: string
  displayName: string
  gitlabPath: string
  harborProject: string
  ownerId: string
  ownerName: string
  description: string
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): Project {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    name: r.name as string,
    displayName: r.display_name as string,
    gitlabPath: r.gitlab_path as string,
    harborProject: r.harbor_project as string,
    ownerId: r.owner_id as string,
    ownerName: r.owner_name as string,
    description: r.description as string,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listProjects(productLineId?: number): Promise<Project[]> {
  const pool = getPool()
  if (productLineId !== undefined) {
    const { rows } = await pool.query(
      'SELECT * FROM projects WHERE product_line_id = $1 ORDER BY id',
      [productLineId]
    )
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM projects ORDER BY id')
  return rows.map(mapRow)
}

export async function getProjectById(id: number): Promise<Project | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createProject(
  data: Pick<Project, 'productLineId' | 'name' | 'displayName'> &
    Partial<Pick<Project, 'gitlabPath' | 'harborProject' | 'ownerId' | 'ownerName' | 'description'>>
): Promise<Project> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO projects
       (product_line_id, name, display_name, gitlab_path, harbor_project, owner_id, owner_name, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      data.productLineId, data.name, data.displayName,
      data.gitlabPath ?? '', data.harborProject ?? '',
      data.ownerId ?? '', data.ownerName ?? '', data.description ?? '',
    ]
  )
  return mapRow(rows[0])
}

export async function updateProject(
  id: number,
  data: Partial<Pick<Project, 'name' | 'displayName' | 'gitlabPath' | 'harborProject' | 'ownerId' | 'ownerName' | 'description' | 'productLineId'>>
): Promise<Project | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE projects SET
       name = COALESCE($2, name),
       display_name = COALESCE($3, display_name),
       gitlab_path = COALESCE($4, gitlab_path),
       harbor_project = COALESCE($5, harbor_project),
       owner_id = COALESCE($6, owner_id),
       owner_name = COALESCE($7, owner_name),
       description = COALESCE($8, description),
       product_line_id = COALESCE($9, product_line_id),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id,
      data.name ?? null, data.displayName ?? null,
      data.gitlabPath ?? null, data.harborProject ?? null,
      data.ownerId ?? null, data.ownerName ?? null,
      data.description ?? null, data.productLineId ?? null,
    ]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteProject(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/projects-repo.ts
git commit -m "feat: projects repository — CRUD for projects table"
```

---

## Task 6: Environments Repository

**Files:**
- Create: `src/db/repositories/environments-repo.ts`

Named `environments-repo.ts` to avoid ambiguity.

- [ ] **Step 1: Write `src/db/repositories/environments-repo.ts`**

```typescript
import { getPool } from '../client.js'

export interface Environment {
  id: number
  name: string
  displayName: string
  sortOrder: number
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): Environment {
  return {
    id: r.id as number,
    name: r.name as string,
    displayName: r.display_name as string,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as Date,
  }
}

export async function listEnvironments(): Promise<Environment[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM environments ORDER BY sort_order, id')
  return rows.map(mapRow)
}

export async function getEnvironmentById(id: number): Promise<Environment | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM environments WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createEnvironment(
  data: Pick<Environment, 'name' | 'displayName'> & Partial<Pick<Environment, 'sortOrder'>>
): Promise<Environment> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO environments (name, display_name, sort_order)
     VALUES ($1, $2, $3) RETURNING *`,
    [data.name, data.displayName, data.sortOrder ?? 0]
  )
  return mapRow(rows[0])
}

export async function updateEnvironment(
  id: number,
  data: Partial<Pick<Environment, 'name' | 'displayName' | 'sortOrder'>>
): Promise<Environment | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE environments SET
       name = COALESCE($2, name),
       display_name = COALESCE($3, display_name),
       sort_order = COALESCE($4, sort_order)
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.displayName ?? null, data.sortOrder ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteEnvironment(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM environments WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/environments-repo.ts
git commit -m "feat: environments repository — CRUD for environments table"
```

---

## Task 7: Product Line Envs Repository

**Files:**
- Create: `src/db/repositories/product-line-envs.ts`

- [ ] **Step 1: Write `src/db/repositories/product-line-envs.ts`**

```typescript
import { getPool } from '../client.js'

export interface ProductLineEnv {
  id: number
  productLineId: number
  envId: number
  runtime: 'kubernetes' | 'docker'
  namespace: string
  enabled: boolean
}

function mapRow(r: Record<string, unknown>): ProductLineEnv {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    envId: r.env_id as number,
    runtime: r.runtime as 'kubernetes' | 'docker',
    namespace: r.namespace as string,
    enabled: r.enabled as boolean,
  }
}

export async function listProductLineEnvs(productLineId: number): Promise<ProductLineEnv[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM product_line_envs WHERE product_line_id = $1 ORDER BY id',
    [productLineId]
  )
  return rows.map(mapRow)
}

export async function upsertProductLineEnv(
  data: Pick<ProductLineEnv, 'productLineId' | 'envId' | 'runtime'> &
    Partial<Pick<ProductLineEnv, 'namespace' | 'enabled'>>
): Promise<ProductLineEnv> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_line_envs (product_line_id, env_id, runtime, namespace, enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (product_line_id, env_id) DO UPDATE
     SET runtime = $3, namespace = $4, enabled = $5
     RETURNING *`,
    [
      data.productLineId, data.envId, data.runtime,
      data.namespace ?? '', data.enabled ?? true,
    ]
  )
  return mapRow(rows[0])
}

export async function batchSetProductLineEnvs(
  productLineId: number,
  envs: Array<Pick<ProductLineEnv, 'envId' | 'runtime'> & Partial<Pick<ProductLineEnv, 'namespace' | 'enabled'>>>
): Promise<ProductLineEnv[]> {
  const pool = getPool()
  // Delete existing, then insert new — wrapped in a transaction
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM product_line_envs WHERE product_line_id = $1', [productLineId])
    const results: ProductLineEnv[] = []
    for (const env of envs) {
      const { rows } = await client.query(
        `INSERT INTO product_line_envs (product_line_id, env_id, runtime, namespace, enabled)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [productLineId, env.envId, env.runtime, env.namespace ?? '', env.enabled ?? true]
      )
      results.push(mapRow(rows[0]))
    }
    await client.query('COMMIT')
    return results
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function deleteProductLineEnv(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM product_line_envs WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/product-line-envs.ts
git commit -m "feat: product-line-envs repository — CRUD with batch upsert for product_line_envs"
```

---

## Task 8: DingTalk Users Repository

**Files:**
- Create: `src/db/repositories/dingtalk-users.ts`

- [ ] **Step 1: Write `src/db/repositories/dingtalk-users.ts`**

```typescript
import { getPool } from '../client.js'

export interface DingTalkUser {
  userId: string
  name: string
  avatar: string
  department: string
  syncedAt: Date
}

function mapRow(r: Record<string, unknown>): DingTalkUser {
  return {
    userId: r.user_id as string,
    name: r.name as string,
    avatar: r.avatar as string,
    department: r.department as string,
    syncedAt: r.synced_at as Date,
  }
}

export async function listDingTalkUsers(keyword?: string): Promise<DingTalkUser[]> {
  const pool = getPool()
  if (keyword) {
    const { rows } = await pool.query(
      `SELECT * FROM dingtalk_users
       WHERE name ILIKE $1 OR user_id ILIKE $1 OR department ILIKE $1
       ORDER BY name LIMIT 50`,
      [`%${keyword}%`]
    )
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM dingtalk_users ORDER BY name LIMIT 200')
  return rows.map(mapRow)
}

export async function upsertDingTalkUser(
  data: Pick<DingTalkUser, 'userId' | 'name'> & Partial<Pick<DingTalkUser, 'avatar' | 'department'>>
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO dingtalk_users (user_id, name, avatar, department, synced_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET name = $2, avatar = $3, department = $4, synced_at = NOW()`,
    [data.userId, data.name, data.avatar ?? '', data.department ?? '']
  )
}

export async function bulkUpsertDingTalkUsers(
  users: Array<Pick<DingTalkUser, 'userId' | 'name'> & Partial<Pick<DingTalkUser, 'avatar' | 'department'>>>
): Promise<number> {
  if (users.length === 0) return 0
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const user of users) {
      await client.query(
        `INSERT INTO dingtalk_users (user_id, name, avatar, department, synced_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET name = $2, avatar = $3, department = $4, synced_at = NOW()`,
        [user.userId, user.name, user.avatar ?? '', user.department ?? '']
      )
    }
    await client.query('COMMIT')
    return users.length
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/dingtalk-users.ts
git commit -m "feat: dingtalk-users repository — list, upsert, bulk-upsert for dingtalk_users"
```

---

## Task 9: Update Approval Rules Repository

**Files:**
- Update: `src/db/repositories/approval-rules.ts`

Add `productLineId` to the interface, add `updateApprovalRule`, `deleteApprovalRule`, and update `getApprovalRules` to support filtering by `productLineId`.

- [ ] **Step 1: Update `src/db/repositories/approval-rules.ts`**

Key changes from the existing file at `/home/k/Code/chatops/src/db/repositories/approval-rules.ts`:
- Add `productLineId?: number` to the `ApprovalRule` interface
- Add `product_line_id` to the row mapper and insert
- Add `getApprovalRulesByProductLine(productLineId)` function
- Add `updateApprovalRule(id, data)` function
- Add `deleteApprovalRule(id)` function

```typescript
import { getPool } from '../client.js'

export interface ApprovalRule {
  id: number
  action: string
  env: string
  primaryApprovers: string[]
  backupApprovers: string[]
  primaryTimeoutMin: number
  totalTimeoutMin: number
  productLineId?: number
}

function mapRow(r: Record<string, unknown>): ApprovalRule {
  return {
    id: r.id as number,
    action: r.action as string,
    env: r.env as string,
    primaryApprovers: r.primary_approvers as string[],
    backupApprovers: r.backup_approvers as string[],
    primaryTimeoutMin: r.primary_timeout_min as number,
    totalTimeoutMin: r.total_timeout_min as number,
    productLineId: r.product_line_id as number | undefined,
  }
}

export async function getApprovalRules(): Promise<ApprovalRule[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM approval_rules ORDER BY id')
  return rows.map(mapRow)
}

export async function getApprovalRulesByProductLine(productLineId: number): Promise<ApprovalRule[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM approval_rules WHERE product_line_id = $1 ORDER BY id',
    [productLineId]
  )
  return rows.map(mapRow)
}

export async function insertApprovalRule(rule: Omit<ApprovalRule, 'id'>): Promise<ApprovalRule> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO approval_rules
       (action, env, primary_approvers, backup_approvers, primary_timeout_min, total_timeout_min, product_line_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [rule.action, rule.env,
     JSON.stringify(rule.primaryApprovers), JSON.stringify(rule.backupApprovers),
     rule.primaryTimeoutMin, rule.totalTimeoutMin, rule.productLineId ?? null]
  )
  return mapRow(rows[0])
}

export async function updateApprovalRule(
  id: number,
  data: Partial<Omit<ApprovalRule, 'id'>>
): Promise<ApprovalRule | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE approval_rules SET
       action = COALESCE($2, action),
       env = COALESCE($3, env),
       primary_approvers = COALESCE($4, primary_approvers),
       backup_approvers = COALESCE($5, backup_approvers),
       primary_timeout_min = COALESCE($6, primary_timeout_min),
       total_timeout_min = COALESCE($7, total_timeout_min),
       product_line_id = COALESCE($8, product_line_id)
     WHERE id = $1 RETURNING *`,
    [
      id,
      data.action ?? null, data.env ?? null,
      data.primaryApprovers ? JSON.stringify(data.primaryApprovers) : null,
      data.backupApprovers ? JSON.stringify(data.backupApprovers) : null,
      data.primaryTimeoutMin ?? null, data.totalTimeoutMin ?? null,
      data.productLineId ?? null,
    ]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteApprovalRule(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM approval_rules WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
```

- [ ] **Step 2: Verify TypeScript compiles** (this checks that existing consumers of ApprovalRule still compile since we only added an optional field)

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Verify existing tests still pass**

```bash
pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add src/db/repositories/approval-rules.ts
git commit -m "feat: update approval-rules repository — add productLineId, update, delete"
```

---

## Task 10: Admin Route Plugin Setup + System Config Routes

**Files:**
- Create: `src/admin/index.ts`
- Create: `src/admin/routes/system-config.ts`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p src/admin/routes src/admin/services
```

- [ ] **Step 2: Write `src/admin/routes/system-config.ts`**

Secret masking logic: GET responses mask any field whose key contains "secret", "password", "token", or "key" (case-insensitive) by showing only the last 4 characters. PUT merges new values with existing, skipping empty strings to preserve old values.

```typescript
import type { FastifyInstance } from 'fastify'
import { getAllConfig, getConfig, setConfig } from '../../db/repositories/system-config.js'

const SECRET_FIELDS = /secret|password|token|key/i

function maskSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && SECRET_FIELDS.test(k) && v.length > 0) {
      masked[k] = '****' + v.slice(-4)
    } else {
      masked[k] = v
    }
  }
  return masked
}

export async function registerSystemConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/system-config', async (_req, reply) => {
    const configs = await getAllConfig()
    const result = configs.map(c => ({
      key: c.key,
      value: maskSecrets(c.value),
      updatedAt: c.updatedAt,
    }))
    return reply.send(result)
  })

  app.put<{ Params: { key: string }; Body: Record<string, unknown> }>(
    '/system-config/:key',
    async (req, reply) => {
      const { key } = req.params
      const newValue = req.body as Record<string, unknown>

      // Merge with existing — skip empty strings to preserve old values
      const existing = await getConfig(key)
      const merged: Record<string, unknown> = existing ? { ...existing.value } : {}
      for (const [k, v] of Object.entries(newValue)) {
        if (v !== '') {
          merged[k] = v
        }
      }

      const entry = await setConfig(key, merged)
      return reply.send({
        key: entry.key,
        value: maskSecrets(entry.value),
        updatedAt: entry.updatedAt,
      })
    }
  )
}
```

- [ ] **Step 3: Write `src/admin/index.ts`**

This is the Fastify plugin that registers all admin sub-routes under `/admin` prefix. Start with just system-config; other routes will be added in later tasks.

```typescript
import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Manual test** (after Task 16 wires it to server.ts, or temporarily wire it now for testing)

```bash
# After server is running:
curl http://localhost:3000/admin/system-config
# Expected: []

curl -X PUT http://localhost:3000/admin/system-config/gitlab \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://gitlab.example.com","token":"glpat-abc123xyz"}'
# Expected: {"key":"gitlab","value":{"url":"https://gitlab.example.com","token":"****xyz"},"updatedAt":"..."}

curl http://localhost:3000/admin/system-config
# Expected: array with gitlab entry, token masked
```

- [ ] **Step 6: Commit**

```bash
git add src/admin/index.ts src/admin/routes/system-config.ts
git commit -m "feat: admin plugin setup + system-config routes with secret masking"
```

---

## Task 11: Product Lines Routes (CRUD + Members + Envs)

**Files:**
- Create: `src/admin/routes/product-lines.ts`
- Update: `src/admin/index.ts` — add registration

- [ ] **Step 1: Write `src/admin/routes/product-lines.ts`**

This is the largest route file. It handles:
- `GET /admin/product-lines` — list all
- `POST /admin/product-lines` — create
- `PUT /admin/product-lines/:id` — update
- `DELETE /admin/product-lines/:id` — delete
- `GET /admin/product-lines/:id/members` — list members
- `POST /admin/product-lines/:id/members` — add member
- `PUT /admin/product-lines/:id/members/:memberId` — update member role
- `DELETE /admin/product-lines/:id/members/:memberId` — remove member
- `GET /admin/product-lines/:id/envs` — list env configs
- `PUT /admin/product-lines/:id/envs` — batch update env configs

```typescript
import type { FastifyInstance } from 'fastify'
import {
  listProductLines,
  getProductLineById,
  createProductLine,
  updateProductLine,
  deleteProductLine,
} from '../../db/repositories/product-lines.js'
import {
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
} from '../../db/repositories/product-line-members.js'
import {
  listProductLineEnvs,
  batchSetProductLineEnvs,
} from '../../db/repositories/product-line-envs.js'

export async function registerProductLineRoutes(app: FastifyInstance): Promise<void> {
  // ── Product Lines CRUD ───────────────────────────────────────────────

  app.get('/product-lines', async (_req, reply) => {
    const items = await listProductLines()
    return reply.send(items)
  })

  app.post<{ Body: { name: string; displayName: string; description?: string } }>(
    '/product-lines',
    async (req, reply) => {
      const { name, displayName, description } = req.body
      if (!name || !displayName) {
        return reply.status(400).send({ error: 'name and displayName are required' })
      }
      const item = await createProductLine({ name, displayName, description: description ?? '' })
      return reply.status(201).send(item)
    }
  )

  app.put<{ Params: { id: string }; Body: { name?: string; displayName?: string; description?: string } }>(
    '/product-lines/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const item = await updateProductLine(id, req.body)
      if (!item) return reply.status(404).send({ error: 'product line not found' })
      return reply.send(item)
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/product-lines/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const deleted = await deleteProductLine(id)
      if (!deleted) return reply.status(404).send({ error: 'product line not found' })
      return reply.status(204).send()
    }
  )

  // ── Members Sub-routes ───────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/product-lines/:id/members',
    async (req, reply) => {
      const productLineId = Number(req.params.id)
      const members = await listMembers(productLineId)
      return reply.send(members)
    }
  )

  app.post<{ Params: { id: string }; Body: { userId: string; userName: string; role: string } }>(
    '/product-lines/:id/members',
    async (req, reply) => {
      const productLineId = Number(req.params.id)
      const { userId, userName, role } = req.body
      if (!userId || !userName || !role) {
        return reply.status(400).send({ error: 'userId, userName, and role are required' })
      }
      const member = await addMember({
        productLineId,
        userId,
        userName,
        role: role as 'developer' | 'ops' | 'admin',
      })
      return reply.status(201).send(member)
    }
  )

  app.put<{ Params: { id: string; memberId: string }; Body: { role: string } }>(
    '/product-lines/:id/members/:memberId',
    async (req, reply) => {
      const memberId = Number(req.params.memberId)
      const { role } = req.body
      if (!role) return reply.status(400).send({ error: 'role is required' })
      const member = await updateMemberRole(memberId, role as 'developer' | 'ops' | 'admin')
      if (!member) return reply.status(404).send({ error: 'member not found' })
      return reply.send(member)
    }
  )

  app.delete<{ Params: { id: string; memberId: string } }>(
    '/product-lines/:id/members/:memberId',
    async (req, reply) => {
      const memberId = Number(req.params.memberId)
      const deleted = await removeMember(memberId)
      if (!deleted) return reply.status(404).send({ error: 'member not found' })
      return reply.status(204).send()
    }
  )

  // ── Environment Configs Sub-routes ───────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/product-lines/:id/envs',
    async (req, reply) => {
      const productLineId = Number(req.params.id)
      const envs = await listProductLineEnvs(productLineId)
      return reply.send(envs)
    }
  )

  app.put<{
    Params: { id: string }
    Body: Array<{ envId: number; runtime: string; namespace?: string; enabled?: boolean }>
  }>(
    '/product-lines/:id/envs',
    async (req, reply) => {
      const productLineId = Number(req.params.id)
      const envs = req.body
      if (!Array.isArray(envs)) {
        return reply.status(400).send({ error: 'body must be an array of env configs' })
      }
      const result = await batchSetProductLineEnvs(
        productLineId,
        envs.map(e => ({
          envId: e.envId,
          runtime: e.runtime as 'kubernetes' | 'docker',
          namespace: e.namespace,
          enabled: e.enabled,
        }))
      )
      return reply.send(result)
    }
  )
}
```

- [ ] **Step 2: Update `src/admin/index.ts`** to register product-lines routes

```typescript
import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Manual test**

```bash
# Create product line
curl -X POST http://localhost:3000/admin/product-lines \
  -H 'Content-Type: application/json' \
  -d '{"name":"pam","displayName":"PAM 产线","description":"PAM product line"}'

# List
curl http://localhost:3000/admin/product-lines

# Add member
curl -X POST http://localhost:3000/admin/product-lines/1/members \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u123","userName":"张三","role":"admin"}'

# List members
curl http://localhost:3000/admin/product-lines/1/members
```

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/product-lines.ts src/admin/index.ts
git commit -m "feat: product-lines routes — CRUD + members + envs sub-routes"
```

---

## Task 12: Projects Routes

**Files:**
- Create: `src/admin/routes/projects.ts`
- Update: `src/admin/index.ts`

- [ ] **Step 1: Write `src/admin/routes/projects.ts`**

```typescript
import type { FastifyInstance } from 'fastify'
import {
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
} from '../../db/repositories/projects-repo.js'

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { product_line_id?: string } }>(
    '/projects',
    async (req, reply) => {
      const productLineId = req.query.product_line_id
        ? Number(req.query.product_line_id)
        : undefined
      const items = await listProjects(productLineId)
      return reply.send(items)
    }
  )

  app.post<{
    Body: {
      productLineId: number
      name: string
      displayName: string
      gitlabPath?: string
      harborProject?: string
      ownerId?: string
      ownerName?: string
      description?: string
    }
  }>(
    '/projects',
    async (req, reply) => {
      const { productLineId, name, displayName } = req.body
      if (!productLineId || !name || !displayName) {
        return reply.status(400).send({ error: 'productLineId, name, and displayName are required' })
      }
      const item = await createProject(req.body)
      return reply.status(201).send(item)
    }
  )

  app.put<{
    Params: { id: string }
    Body: {
      name?: string
      displayName?: string
      gitlabPath?: string
      harborProject?: string
      ownerId?: string
      ownerName?: string
      description?: string
      productLineId?: number
    }
  }>(
    '/projects/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const item = await updateProject(id, req.body)
      if (!item) return reply.status(404).send({ error: 'project not found' })
      return reply.send(item)
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/projects/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const deleted = await deleteProject(id)
      if (!deleted) return reply.status(404).send({ error: 'project not found' })
      return reply.status(204).send()
    }
  )
}
```

- [ ] **Step 2: Update `src/admin/index.ts`** to register project routes

```typescript
import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'
import { registerProjectRoutes } from './routes/projects.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
  await registerProjectRoutes(app)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Manual test**

```bash
# Create project (requires existing product line with id=1)
curl -X POST http://localhost:3000/admin/projects \
  -H 'Content-Type: application/json' \
  -d '{"productLineId":1,"name":"payment-service","displayName":"支付服务","gitlabPath":"group/payment-service"}'

# List all
curl http://localhost:3000/admin/projects

# List by product line
curl 'http://localhost:3000/admin/projects?product_line_id=1'
```

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/projects.ts src/admin/index.ts
git commit -m "feat: projects routes — CRUD with product_line_id filter"
```

---

## Task 13: Environments Routes

**Files:**
- Create: `src/admin/routes/environments.ts`
- Update: `src/admin/index.ts`

- [ ] **Step 1: Write `src/admin/routes/environments.ts`**

```typescript
import type { FastifyInstance } from 'fastify'
import {
  listEnvironments,
  createEnvironment,
  updateEnvironment,
  deleteEnvironment,
} from '../../db/repositories/environments-repo.js'

export async function registerEnvironmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/environments', async (_req, reply) => {
    const items = await listEnvironments()
    return reply.send(items)
  })

  app.post<{ Body: { name: string; displayName: string; sortOrder?: number } }>(
    '/environments',
    async (req, reply) => {
      const { name, displayName } = req.body
      if (!name || !displayName) {
        return reply.status(400).send({ error: 'name and displayName are required' })
      }
      const item = await createEnvironment(req.body)
      return reply.status(201).send(item)
    }
  )

  app.put<{ Params: { id: string }; Body: { name?: string; displayName?: string; sortOrder?: number } }>(
    '/environments/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const item = await updateEnvironment(id, req.body)
      if (!item) return reply.status(404).send({ error: 'environment not found' })
      return reply.send(item)
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/environments/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const deleted = await deleteEnvironment(id)
      if (!deleted) return reply.status(404).send({ error: 'environment not found' })
      return reply.status(204).send()
    }
  )
}
```

- [ ] **Step 2: Update `src/admin/index.ts`** to register environment routes

```typescript
import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerEnvironmentRoutes } from './routes/environments.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
  await registerProjectRoutes(app)
  await registerEnvironmentRoutes(app)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Manual test**

```bash
curl -X POST http://localhost:3000/admin/environments \
  -H 'Content-Type: application/json' \
  -d '{"name":"dev","displayName":"开发环境","sortOrder":1}'

curl -X POST http://localhost:3000/admin/environments \
  -H 'Content-Type: application/json' \
  -d '{"name":"staging","displayName":"预发环境","sortOrder":2}'

curl http://localhost:3000/admin/environments
```

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/environments.ts src/admin/index.ts
git commit -m "feat: environments routes — CRUD for global environments"
```

---

## Task 14: Approval Rules Routes

**Files:**
- Create: `src/admin/routes/approval-rules.ts`
- Update: `src/admin/index.ts`

- [ ] **Step 1: Write `src/admin/routes/approval-rules.ts`**

```typescript
import type { FastifyInstance } from 'fastify'
import {
  getApprovalRules,
  getApprovalRulesByProductLine,
  insertApprovalRule,
  updateApprovalRule,
  deleteApprovalRule,
} from '../../db/repositories/approval-rules.js'

export async function registerApprovalRuleRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { product_line_id?: string } }>(
    '/approval-rules',
    async (req, reply) => {
      const productLineId = req.query.product_line_id
        ? Number(req.query.product_line_id)
        : undefined
      const rules = productLineId !== undefined
        ? await getApprovalRulesByProductLine(productLineId)
        : await getApprovalRules()
      return reply.send(rules)
    }
  )

  app.post<{
    Body: {
      action: string
      env: string
      primaryApprovers: string[]
      backupApprovers: string[]
      primaryTimeoutMin: number
      totalTimeoutMin: number
      productLineId?: number
    }
  }>(
    '/approval-rules',
    async (req, reply) => {
      const { action, env, primaryApprovers, backupApprovers, primaryTimeoutMin, totalTimeoutMin, productLineId } = req.body
      if (!action || !env || !primaryApprovers) {
        return reply.status(400).send({ error: 'action, env, and primaryApprovers are required' })
      }
      const rule = await insertApprovalRule({
        action,
        env,
        primaryApprovers,
        backupApprovers: backupApprovers ?? [],
        primaryTimeoutMin: primaryTimeoutMin ?? 10,
        totalTimeoutMin: totalTimeoutMin ?? 20,
        productLineId,
      })
      return reply.status(201).send(rule)
    }
  )

  app.put<{
    Params: { id: string }
    Body: {
      action?: string
      env?: string
      primaryApprovers?: string[]
      backupApprovers?: string[]
      primaryTimeoutMin?: number
      totalTimeoutMin?: number
      productLineId?: number
    }
  }>(
    '/approval-rules/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const rule = await updateApprovalRule(id, req.body)
      if (!rule) return reply.status(404).send({ error: 'approval rule not found' })
      return reply.send(rule)
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/approval-rules/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const deleted = await deleteApprovalRule(id)
      if (!deleted) return reply.status(404).send({ error: 'approval rule not found' })
      return reply.status(204).send()
    }
  )
}
```

- [ ] **Step 2: Update `src/admin/index.ts`** to register approval rules routes

```typescript
import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerEnvironmentRoutes } from './routes/environments.js'
import { registerApprovalRuleRoutes } from './routes/approval-rules.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
  await registerProjectRoutes(app)
  await registerEnvironmentRoutes(app)
  await registerApprovalRuleRoutes(app)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Manual test**

```bash
# Create rule with product line
curl -X POST http://localhost:3000/admin/approval-rules \
  -H 'Content-Type: application/json' \
  -d '{"action":"deploy","env":"production","primaryApprovers":["u1"],"backupApprovers":["u2"],"primaryTimeoutMin":10,"totalTimeoutMin":20,"productLineId":1}'

# List all
curl http://localhost:3000/admin/approval-rules

# List by product line
curl 'http://localhost:3000/admin/approval-rules?product_line_id=1'

# Update
curl -X PUT http://localhost:3000/admin/approval-rules/1 \
  -H 'Content-Type: application/json' \
  -d '{"totalTimeoutMin":30}'

# Delete
curl -X DELETE http://localhost:3000/admin/approval-rules/1
```

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/approval-rules.ts src/admin/index.ts
git commit -m "feat: approval-rules routes — CRUD with product_line_id filter"
```

---

## Task 15: DingTalk User Sync Service + Routes

**Files:**
- Create: `src/admin/services/dingtalk-sync.ts`
- Create: `src/admin/routes/dingtalk-users.ts`
- Update: `src/admin/index.ts`

- [ ] **Step 1: Write `src/admin/services/dingtalk-sync.ts`**

This service reads DingTalk credentials from system_config, gets an access token, recursively fetches department IDs, fetches users for each department, deduplicates, and bulk-upserts into dingtalk_users.

The DingTalk adapter at `/home/k/Code/chatops/src/adapters/im/dingtalk.ts` line 204-221 shows the token fetching pattern (POST to `https://api.dingtalk.com/v1.0/oauth2/accessToken` with `appKey` and `appSecret`). This service replicates that pattern using credentials from the DB.

```typescript
import axios from 'axios'
import { getConfig } from '../../db/repositories/system-config.js'
import { bulkUpsertDingTalkUsers } from '../../db/repositories/dingtalk-users.js'

const DINGTALK_API = 'https://oapi.dingtalk.com'
const DINGTALK_API_V2 = 'https://api.dingtalk.com'

interface DingTalkCredentials {
  clientId: string
  clientSecret: string
}

async function getCredentials(): Promise<DingTalkCredentials> {
  const entry = await getConfig('dingtalk')
  if (!entry) throw new Error('DingTalk config not found in system_config')
  const { clientId, clientSecret } = entry.value as Record<string, string>
  if (!clientId || !clientSecret) throw new Error('DingTalk clientId/clientSecret not configured')
  return { clientId, clientSecret }
}

async function getAccessToken(creds: DingTalkCredentials): Promise<string> {
  const response = await axios.post<{ accessToken: string; expireIn: number }>(
    `${DINGTALK_API_V2}/v1.0/oauth2/accessToken`,
    { appKey: creds.clientId, appSecret: creds.clientSecret }
  )
  return response.data.accessToken
}

async function getSubDepartmentIds(token: string, parentId: number): Promise<number[]> {
  const response = await axios.post<{ result: number[] }>(
    `${DINGTALK_API_V2}/v1.0/contact/departments/listSubDepartmentIds`,
    { parentDepartmentId: parentId },
    { headers: { 'x-acs-dingtalk-access-token': token } }
  )
  const subIds = response.data.result ?? []
  const allIds = [...subIds]
  for (const subId of subIds) {
    const deeper = await getSubDepartmentIds(token, subId)
    allIds.push(...deeper)
  }
  return allIds
}

interface DingTalkUserInfo {
  userid: string
  name: string
  avatar: string
  dept_id_list: number[]
}

async function getDepartmentUsers(
  token: string,
  departmentId: number
): Promise<DingTalkUserInfo[]> {
  const users: DingTalkUserInfo[] = []
  let cursor = 0
  let hasMore = true

  while (hasMore) {
    const response = await axios.post<{
      result: { list: DingTalkUserInfo[]; has_more: boolean; next_cursor: number }
    }>(
      `${DINGTALK_API}/topapi/v2/user/list`,
      { dept_id: departmentId, cursor, size: 100 },
      {
        params: { access_token: token },
      }
    )
    const result = response.data.result
    if (result?.list) {
      users.push(...result.list)
    }
    hasMore = result?.has_more ?? false
    cursor = result?.next_cursor ?? 0
  }

  return users
}

export async function syncDingTalkUsers(): Promise<{ synced: number }> {
  const creds = await getCredentials()
  const token = await getAccessToken(creds)

  // Get all department IDs (root department is 1)
  const rootDeptId = 1
  const deptIds = [rootDeptId, ...await getSubDepartmentIds(token, rootDeptId)]

  // Fetch users from all departments, deduplicate by userId
  const userMap = new Map<string, { userId: string; name: string; avatar: string; department: string }>()

  for (const deptId of deptIds) {
    const users = await getDepartmentUsers(token, deptId)
    for (const u of users) {
      if (!userMap.has(u.userid)) {
        userMap.set(u.userid, {
          userId: u.userid,
          name: u.name,
          avatar: u.avatar ?? '',
          department: String(deptId),
        })
      }
    }
  }

  const allUsers = Array.from(userMap.values())
  const count = await bulkUpsertDingTalkUsers(allUsers)

  return { synced: count }
}
```

- [ ] **Step 2: Write `src/admin/routes/dingtalk-users.ts`**

```typescript
import type { FastifyInstance } from 'fastify'
import { listDingTalkUsers } from '../../db/repositories/dingtalk-users.js'
import { syncDingTalkUsers } from '../services/dingtalk-sync.js'

export async function registerDingTalkUserRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { keyword?: string } }>(
    '/dingtalk/users',
    async (req, reply) => {
      const keyword = req.query.keyword
      const users = await listDingTalkUsers(keyword)
      return reply.send(users)
    }
  )

  app.post('/dingtalk/users/sync', async (_req, reply) => {
    try {
      const result = await syncDingTalkUsers()
      return reply.send(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'sync failed'
      return reply.status(500).send({ error: message })
    }
  })
}
```

- [ ] **Step 3: Update `src/admin/index.ts`** to register DingTalk routes

```typescript
import type { FastifyInstance } from 'fastify'
import { registerSystemConfigRoutes } from './routes/system-config.js'
import { registerProductLineRoutes } from './routes/product-lines.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerEnvironmentRoutes } from './routes/environments.js'
import { registerApprovalRuleRoutes } from './routes/approval-rules.js'
import { registerDingTalkUserRoutes } from './routes/dingtalk-users.js'

export async function adminPlugin(app: FastifyInstance): Promise<void> {
  await registerSystemConfigRoutes(app)
  await registerProductLineRoutes(app)
  await registerProjectRoutes(app)
  await registerEnvironmentRoutes(app)
  await registerApprovalRuleRoutes(app)
  await registerDingTalkUserRoutes(app)
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Manual test**

```bash
# List users (empty initially)
curl http://localhost:3000/admin/dingtalk/users

# First set DingTalk credentials
curl -X PUT http://localhost:3000/admin/system-config/dingtalk \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"xxx","clientSecret":"yyy"}'

# Trigger sync (will fail if credentials invalid — expected)
curl -X POST http://localhost:3000/admin/dingtalk/users/sync

# Search users
curl 'http://localhost:3000/admin/dingtalk/users?keyword=张'
```

- [ ] **Step 6: Commit**

```bash
git add src/admin/services/dingtalk-sync.ts src/admin/routes/dingtalk-users.ts src/admin/index.ts
git commit -m "feat: DingTalk user sync service + admin routes for user list and sync trigger"
```

---

## Task 16: Wire Admin Routes into server.ts

**Files:**
- Update: `src/server.ts`

- [ ] **Step 1: Update `src/server.ts`**

Add the admin plugin registration. The key change: import `adminPlugin` from `./admin/index.js` and register it with a prefix of `/admin`.

The existing server at `/home/k/Code/chatops/src/server.ts` needs these additions (after existing route registrations, before `app.listen`):

1. Add import at top: `import { adminPlugin } from './admin/index.js'`
2. Register the plugin with prefix before the `app.listen` call:

```typescript
// Register admin routes
await app.register(adminPlugin, { prefix: '/admin' })
```

This should be placed after line 123 (the gitlab webhook route) and before line 124 (the root endpoint), or right before the root GET handler. The exact insertion point: after the `app.post('/webhook/gitlab', ...)` block and before `app.get('/', ...)`.

Also update the root endpoint's response to include admin in endpoints:

```typescript
app.get('/', async () => ({
  name: 'ChatOps Platform',
  version: '1.0.0',
  status: 'running',
  endpoints: {
    health: '/health',
    admin: '/admin/*',
    webhooks: {
      feishu: '/webhook/feishu',
      gitlab: '/webhook/gitlab',
    },
    stream: {
      dingtalk: 'connected via WebSocket (Stream mode)',
    },
  },
}))
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Run all tests**

```bash
pnpm test
```

- [ ] **Step 4: Start server and smoke test**

```bash
# Start (in another terminal)
pnpm dev

# Smoke test all admin endpoints
curl http://localhost:3000/
curl http://localhost:3000/admin/system-config
curl http://localhost:3000/admin/product-lines
curl http://localhost:3000/admin/projects
curl http://localhost:3000/admin/environments
curl http://localhost:3000/admin/approval-rules
curl http://localhost:3000/admin/dingtalk/users
```

Expected: Each returns `[]` or `200 OK` with empty arrays (no data yet).

- [ ] **Step 5: Full integration test**

```bash
# 1. Create environment
curl -X POST http://localhost:3000/admin/environments \
  -H 'Content-Type: application/json' \
  -d '{"name":"dev","displayName":"开发环境","sortOrder":1}'

# 2. Create product line
curl -X POST http://localhost:3000/admin/product-lines \
  -H 'Content-Type: application/json' \
  -d '{"name":"pam","displayName":"PAM 产线"}'

# 3. Add member to product line
curl -X POST http://localhost:3000/admin/product-lines/1/members \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u1","userName":"张三","role":"admin"}'

# 4. Create project under product line
curl -X POST http://localhost:3000/admin/projects \
  -H 'Content-Type: application/json' \
  -d '{"productLineId":1,"name":"payment-service","displayName":"支付服务"}'

# 5. Set product line env config
curl -X PUT http://localhost:3000/admin/product-lines/1/envs \
  -H 'Content-Type: application/json' \
  -d '[{"envId":1,"runtime":"kubernetes","namespace":"pam-dev"}]'

# 6. Create approval rule for product line
curl -X POST http://localhost:3000/admin/approval-rules \
  -H 'Content-Type: application/json' \
  -d '{"action":"deploy","env":"*","primaryApprovers":["u1"],"backupApprovers":[],"primaryTimeoutMin":10,"totalTimeoutMin":20,"productLineId":1}'

# 7. Set system config
curl -X PUT http://localhost:3000/admin/system-config/gitlab \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://gitlab.example.com","token":"glpat-test123"}'

# 8. Verify masking
curl http://localhost:3000/admin/system-config
```

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire admin routes plugin into server.ts under /admin prefix"
```

---

## Dependencies and Sequencing

The tasks must be executed in order since later tasks depend on earlier ones:

```
Task 1 (schema-v2)
  |
  +-- Task 2 (system-config repo)
  +-- Task 3 (product-lines repo)
  +-- Task 4 (product-line-members repo)
  +-- Task 5 (projects repo)
  +-- Task 6 (environments repo)
  +-- Task 7 (product-line-envs repo)
  +-- Task 8 (dingtalk-users repo)
  +-- Task 9 (approval-rules update)
  |
  +-- Task 10 (admin plugin + system-config routes)  -- depends on Task 2
  +-- Task 11 (product-lines routes) -- depends on Tasks 3, 4, 7
  +-- Task 12 (projects routes) -- depends on Task 5
  +-- Task 13 (environments routes) -- depends on Task 6
  +-- Task 14 (approval-rules routes) -- depends on Task 9
  +-- Task 15 (dingtalk sync + routes) -- depends on Tasks 2, 8
  |
  +-- Task 16 (wire into server) -- depends on Task 10
```

Tasks 2-9 are independent of each other and could be parallelized. Tasks 10-15 depend on their respective repository tasks. Task 16 depends on everything.

## Potential Challenges

1. **The `COALESCE` pattern for partial updates**: When a field's current value is `''` (empty string) and the update passes `null` (meaning "don't change"), `COALESCE` correctly keeps the empty string. However, if you want to explicitly set a field to empty string, the current pattern cannot distinguish "not provided" from "set to empty". This is acceptable for this use case since the design spec says empty-string PUT values mean "keep old value" only for system-config secrets, and other fields always accept the provided value.

2. **DingTalk API rate limits**: The sync service calls DingTalk APIs sequentially per department. For large organizations with many departments, this could be slow. Consider adding batch logging and progress tracking in future iterations.

3. **The `approval_rules` ALTER**: The `ADD COLUMN IF NOT EXISTS` is idempotent, but the existing `approval-rules.ts` consumers (e.g., `ApprovalRouter` in `src/approval/router.ts` and `ApprovalGate` in `src/approval/gate.ts`) do not use `productLineId`. Adding it as optional (no NOT NULL constraint) ensures backward compatibility.

4. **Repository naming**: Using `projects-repo.ts` and `environments-repo.ts` avoids potential name conflicts while keeping the pattern clear. The existing codebase has no naming collisions in the repositories directory, but using distinct names is defensive.

---

### Critical Files for Implementation
- `/home/k/Code/chatops/src/db/schema-v2.sql` (new, all table DDL)
- `/home/k/Code/chatops/src/admin/index.ts` (new, central plugin wiring all routes)
- `/home/k/Code/chatops/src/admin/routes/product-lines.ts` (new, largest route file with members/envs sub-routes)
- `/home/k/Code/chatops/src/db/repositories/approval-rules.ts` (existing, must be updated without breaking consumers)
- `/home/k/Code/chatops/src/server.ts` (existing, must add admin plugin registration)
