# Automated Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated testing capability — pipeline engine for environment deployment + test execution + report generation.

**Architecture:** Lightweight pipeline engine with typed stages (cleanup → download → install → health_check → test → report). Each stage executes via SSH on target servers. Pipeline orchestrator manages lifecycle, collects logs, generates HTML reports + ZIP archives. Integrates as AI tool + admin API + scheduled jobs.

**Tech Stack:** Node.js/TypeScript, Fastify, PostgreSQL, ssh2 (SSH+SFTP), archiver (ZIP), node-cron (scheduling), React/Ant Design (frontend)

---

## File Structure

### Backend — New Files

```
src/db/schema-v3.sql                    — 3 new tables
src/db/repositories/test-servers.ts     — Server pool CRUD
src/db/repositories/test-pipelines.ts   — Pipeline template CRUD
src/db/repositories/test-runs.ts        — Run records CRUD + status updates
src/pipeline/types.ts                   — Stage/pipeline type definitions
src/pipeline/ssh.ts                     — Shared SSH exec + SCP utilities
src/pipeline/stages/cleanup.ts          — Environment cleanup stage
src/pipeline/stages/download.ts         — Package download stage
src/pipeline/stages/install.ts          — Silent install stage
src/pipeline/stages/health-check.ts     — Health check stage
src/pipeline/stages/test.ts             — Pytest execution stage
src/pipeline/stages/report.ts           — Report generation stage
src/pipeline/stages/custom.ts           — Custom command stage
src/pipeline/executor.ts                — Pipeline orchestrator
src/pipeline/report-generator.ts        — HTML report + ZIP packaging
src/pipeline/scheduler.ts               — Cron scheduler
src/agent/tools/autotest.ts             — AI tool registration
src/admin/routes/test-servers.ts        — Server admin API
src/admin/routes/test-pipelines.ts      — Pipeline admin API
src/admin/routes/test-runs.ts           — Run records + report API
```

### Backend — Modified Files

```
src/db/migrate.ts                       — Add schema-v3.sql
src/admin/index.ts                      — Register 3 new route modules
src/server.ts                           — Import autotest tool, start scheduler, add /api prefix exclusion
package.json                            — Add archiver, node-cron deps
```

### Frontend — New Files

```
web/src/api/test-servers.ts
web/src/api/test-pipelines.ts
web/src/api/test-runs.ts
web/src/pages/TestServersPage.tsx
web/src/pages/TestPipelinesPage.tsx
web/src/pages/TestRunsPage.tsx
```

### Frontend — Modified Files

```
web/src/types/index.ts                  — Add new interfaces
web/src/App.tsx                         — Add routes
web/src/layout/AdminLayout.tsx          — Add menu items
```

---

### Task 1: Dependencies + Database Schema V3

**Files:**
- Modify: `package.json`
- Create: `src/db/schema-v3.sql`
- Modify: `src/db/migrate.ts`

- [ ] **Step 1: Install new dependencies**

```bash
cd /home/k/code/chatops && pnpm add archiver node-cron && pnpm add -D @types/archiver @types/node-cron
```

- [ ] **Step 2: Create schema-v3.sql**

Create `src/db/schema-v3.sql`:

```sql
-- test_servers (test server pool)
CREATE TABLE IF NOT EXISTS test_servers (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  host             TEXT NOT NULL,
  port             INT NOT NULL DEFAULT 22,
  username         TEXT NOT NULL,
  auth_type        TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password','key')),
  credential       TEXT NOT NULL DEFAULT '',
  role             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','in_use','offline')),
  tags             JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- test_pipelines (pipeline template definitions)
CREATE TABLE IF NOT EXISTS test_pipelines (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT DEFAULT '',
  stages           JSONB NOT NULL DEFAULT '[]',
  server_roles     JSONB NOT NULL DEFAULT '{}',
  schedule         TEXT DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- test_runs (pipeline execution records)
CREATE TABLE IF NOT EXISTS test_runs (
  id               SERIAL PRIMARY KEY,
  pipeline_id      INT NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  trigger_type     TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual','api','scheduled')),
  triggered_by     TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','success','failed','cancelled')),
  servers          JSONB NOT NULL DEFAULT '{}',
  current_stage    INT NOT NULL DEFAULT 0,
  stage_results    JSONB NOT NULL DEFAULT '[]',
  report_path      TEXT DEFAULT '',
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  error_message    TEXT DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_runs_pipeline ON test_runs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status);
```

- [ ] **Step 3: Update migrate.ts**

Add to `src/db/migrate.ts` after the v2 schema application:

```typescript
const schemaV3 = readFileSync(join(__dirname, 'schema-v3.sql'), 'utf8')
await pool.query(schemaV3)

console.log('✅ Database schema applied (v1 + v2 + v3)')
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add schema-v3 for automated testing tables + archiver/node-cron deps"
```

---

### Task 2: Repositories — test-servers

**Files:**
- Create: `src/db/repositories/test-servers.ts`

- [ ] **Step 1: Create test-servers repository**

Create `src/db/repositories/test-servers.ts`:

```typescript
import { getPool } from '../client.js'

export interface TestServer {
  id: number
  productLineId: number
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  credential: string
  role: string
  status: 'idle' | 'in_use' | 'offline'
  tags: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): TestServer {
  return {
    id: r.id as number, productLineId: r.product_line_id as number,
    name: r.name as string, host: r.host as string, port: r.port as number,
    username: r.username as string, authType: r.auth_type as 'password' | 'key',
    credential: r.credential as string, role: r.role as string,
    status: r.status as 'idle' | 'in_use' | 'offline',
    tags: (r.tags ?? {}) as Record<string, unknown>,
    createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  }
}

export async function listTestServers(productLineId?: number): Promise<TestServer[]> {
  const pool = getPool()
  if (productLineId) {
    const { rows } = await pool.query('SELECT * FROM test_servers WHERE product_line_id = $1 ORDER BY id', [productLineId])
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM test_servers ORDER BY id')
  return rows.map(mapRow)
}

export async function getTestServerById(id: number): Promise<TestServer | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM test_servers WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createTestServer(data: {
  productLineId: number; name: string; host: string; port?: number
  username: string; authType?: 'password' | 'key'; credential: string; role: string
  tags?: Record<string, unknown>
}): Promise<TestServer> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_servers (product_line_id, name, host, port, username, auth_type, credential, role, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [data.productLineId, data.name, data.host, data.port ?? 22, data.username,
     data.authType ?? 'password', data.credential, data.role, JSON.stringify(data.tags ?? {})]
  )
  return mapRow(rows[0])
}

export async function updateTestServer(id: number, data: Partial<{
  name: string; host: string; port: number; username: string
  authType: 'password' | 'key'; credential: string; role: string
  status: 'idle' | 'in_use' | 'offline'; tags: Record<string, unknown>
}>): Promise<TestServer | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE test_servers SET
       name = COALESCE($2, name), host = COALESCE($3, host), port = COALESCE($4, port),
       username = COALESCE($5, username), auth_type = COALESCE($6, auth_type),
       credential = COALESCE($7, credential), role = COALESCE($8, role),
       status = COALESCE($9, status), tags = COALESCE($10, tags),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.host ?? null, data.port ?? null,
     data.username ?? null, data.authType ?? null, data.credential ?? null,
     data.role ?? null, data.status ?? null, data.tags ? JSON.stringify(data.tags) : null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteTestServer(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM test_servers WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}

export async function setServerStatus(id: number, status: 'idle' | 'in_use' | 'offline'): Promise<void> {
  const pool = getPool()
  await pool.query('UPDATE test_servers SET status = $2, updated_at = NOW() WHERE id = $1', [id, status])
}

export async function bulkSetServerStatus(ids: number[], status: 'idle' | 'in_use' | 'offline'): Promise<void> {
  if (ids.length === 0) return
  const pool = getPool()
  await pool.query('UPDATE test_servers SET status = $2, updated_at = NOW() WHERE id = ANY($1)', [ids, status])
}
```

- [ ] **Step 2: Commit**

```bash
git add src/db/repositories/test-servers.ts && git commit -m "feat: add test-servers repository"
```

---

### Task 3: Repositories — test-pipelines

**Files:**
- Create: `src/db/repositories/test-pipelines.ts`

- [ ] **Step 1: Create test-pipelines repository**

Create `src/db/repositories/test-pipelines.ts`:

```typescript
import { getPool } from '../client.js'

export interface TestPipeline {
  id: number
  productLineId: number
  name: string
  description: string
  stages: unknown[]
  serverRoles: Record<string, { count: number }>
  schedule: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): TestPipeline {
  return {
    id: r.id as number, productLineId: r.product_line_id as number,
    name: r.name as string, description: (r.description ?? '') as string,
    stages: (r.stages ?? []) as unknown[], serverRoles: (r.server_roles ?? {}) as Record<string, { count: number }>,
    schedule: (r.schedule ?? '') as string, enabled: r.enabled as boolean,
    createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  }
}

export async function listTestPipelines(productLineId?: number): Promise<TestPipeline[]> {
  const pool = getPool()
  if (productLineId) {
    const { rows } = await pool.query('SELECT * FROM test_pipelines WHERE product_line_id = $1 ORDER BY id', [productLineId])
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM test_pipelines ORDER BY id')
  return rows.map(mapRow)
}

export async function getTestPipelineById(id: number): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM test_pipelines WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createTestPipeline(data: {
  productLineId: number; name: string; description?: string
  stages: unknown[]; serverRoles: Record<string, { count: number }>
  schedule?: string; enabled?: boolean
}): Promise<TestPipeline> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [data.productLineId, data.name, data.description ?? '', JSON.stringify(data.stages),
     JSON.stringify(data.serverRoles), data.schedule ?? '', data.enabled ?? true]
  )
  return mapRow(rows[0])
}

export async function updateTestPipeline(id: number, data: Partial<{
  name: string; description: string; stages: unknown[]
  serverRoles: Record<string, { count: number }>; schedule: string; enabled: boolean
}>): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE test_pipelines SET
       name = COALESCE($2, name), description = COALESCE($3, description),
       stages = COALESCE($4, stages), server_roles = COALESCE($5, server_roles),
       schedule = COALESCE($6, schedule), enabled = COALESCE($7, enabled),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.description ?? null,
     data.stages ? JSON.stringify(data.stages) : null,
     data.serverRoles ? JSON.stringify(data.serverRoles) : null,
     data.schedule ?? null, data.enabled ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteTestPipeline(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM test_pipelines WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}

export async function listScheduledPipelines(): Promise<TestPipeline[]> {
  const pool = getPool()
  const { rows } = await pool.query("SELECT * FROM test_pipelines WHERE enabled = true AND schedule != '' ORDER BY id")
  return rows.map(mapRow)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/db/repositories/test-pipelines.ts && git commit -m "feat: add test-pipelines repository"
```

---

### Task 4: Repositories — test-runs

**Files:**
- Create: `src/db/repositories/test-runs.ts`

- [ ] **Step 1: Create test-runs repository**

Create `src/db/repositories/test-runs.ts`:

```typescript
import { getPool } from '../client.js'

export interface TestRun {
  id: number
  pipelineId: number
  triggerType: 'manual' | 'api' | 'scheduled'
  triggeredBy: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  servers: Record<string, string[]>
  currentStage: number
  stageResults: StageResult[]
  reportPath: string
  startedAt: Date | null
  finishedAt: Date | null
  errorMessage: string
  createdAt: Date
}

export interface StageResult {
  name: string
  type: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  output?: string
  error?: string
}

function mapRow(r: Record<string, unknown>): TestRun {
  return {
    id: r.id as number, pipelineId: r.pipeline_id as number,
    triggerType: r.trigger_type as TestRun['triggerType'],
    triggeredBy: (r.triggered_by ?? '') as string,
    status: r.status as TestRun['status'],
    servers: (r.servers ?? {}) as Record<string, string[]>,
    currentStage: r.current_stage as number,
    stageResults: (r.stage_results ?? []) as StageResult[],
    reportPath: (r.report_path ?? '') as string,
    startedAt: r.started_at as Date | null,
    finishedAt: r.finished_at as Date | null,
    errorMessage: (r.error_message ?? '') as string,
    createdAt: r.created_at as Date,
  }
}

export async function listTestRuns(pipelineId?: number, limit = 50): Promise<TestRun[]> {
  const pool = getPool()
  if (pipelineId) {
    const { rows } = await pool.query(
      'SELECT * FROM test_runs WHERE pipeline_id = $1 ORDER BY id DESC LIMIT $2', [pipelineId, limit])
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM test_runs ORDER BY id DESC LIMIT $1', [limit])
  return rows.map(mapRow)
}

export async function getTestRunById(id: number): Promise<TestRun | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM test_runs WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createTestRun(data: {
  pipelineId: number; triggerType: TestRun['triggerType']; triggeredBy: string
  servers: Record<string, string[]>
}): Promise<TestRun> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, servers, status, started_at)
     VALUES ($1,$2,$3,$4,'running',NOW()) RETURNING *`,
    [data.pipelineId, data.triggerType, data.triggeredBy, JSON.stringify(data.servers)]
  )
  return mapRow(rows[0])
}

export async function updateTestRunStage(id: number, currentStage: number, stageResults: StageResult[]): Promise<void> {
  const pool = getPool()
  await pool.query(
    'UPDATE test_runs SET current_stage = $2, stage_results = $3 WHERE id = $1',
    [id, currentStage, JSON.stringify(stageResults)]
  )
}

export async function finishTestRun(id: number, status: 'success' | 'failed' | 'cancelled', reportPath: string, errorMessage = ''): Promise<void> {
  const pool = getPool()
  await pool.query(
    'UPDATE test_runs SET status = $2, report_path = $3, error_message = $4, finished_at = NOW() WHERE id = $1',
    [id, status, reportPath, errorMessage]
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/db/repositories/test-runs.ts && git commit -m "feat: add test-runs repository"
```

---

### Task 5: Admin Routes — test-servers

**Files:**
- Create: `src/admin/routes/test-servers.ts`

- [ ] **Step 1: Create test-servers admin routes**

Create `src/admin/routes/test-servers.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import { listTestServers, getTestServerById, createTestServer, updateTestServer, deleteTestServer } from '../../db/repositories/test-servers.js'
import { sshExec } from '../../pipeline/ssh.js'

export async function registerTestServerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { product_line_id?: string } }>('/test-servers', async (req, reply) => {
    const plId = req.query.product_line_id ? Number(req.query.product_line_id) : undefined
    return reply.send(await listTestServers(plId))
  })

  app.post<{ Body: {
    productLineId: number; name: string; host: string; port?: number
    username: string; authType?: 'password' | 'key'; credential: string; role: string
    tags?: Record<string, unknown>
  } }>('/test-servers', async (req, reply) => {
    const { productLineId, name, host, username, credential, role } = req.body
    if (!productLineId || !name || !host || !username || !credential) {
      return reply.status(400).send({ error: 'productLineId, name, host, username, credential required' })
    }
    const item = await createTestServer({ ...req.body, role: role ?? '' })
    return reply.status(201).send(item)
  })

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/test-servers/:id', async (req, reply) => {
    const item = await updateTestServer(Number(req.params.id), req.body as any)
    if (!item) return reply.status(404).send({ error: 'not found' })
    return reply.send(item)
  })

  app.delete<{ Params: { id: string } }>('/test-servers/:id', async (req, reply) => {
    const deleted = await deleteTestServer(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })

  // SSH connectivity test
  app.post<{ Params: { id: string } }>('/test-servers/:id/test-connection', async (req, reply) => {
    const server = await getTestServerById(Number(req.params.id))
    if (!server) return reply.status(404).send({ error: 'not found' })
    try {
      const result = await sshExec(
        { host: server.host, port: server.port, username: server.username, password: server.credential },
        'echo "connection ok" && hostname && uname -a'
      )
      if (result.code === 0) {
        return reply.send({ success: true, output: result.stdout.trim() })
      }
      return reply.send({ success: false, output: result.stderr || result.stdout })
    } catch (err) {
      return reply.send({ success: false, output: String(err) })
    }
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/admin/routes/test-servers.ts && git commit -m "feat: add test-servers admin routes"
```

---

### Task 6: Admin Routes — test-pipelines

**Files:**
- Create: `src/admin/routes/test-pipelines.ts`

- [ ] **Step 1: Create test-pipelines admin routes**

Create `src/admin/routes/test-pipelines.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import { listTestPipelines, getTestPipelineById, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../../db/repositories/test-pipelines.js'

export async function registerTestPipelineRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { product_line_id?: string } }>('/test-pipelines', async (req, reply) => {
    const plId = req.query.product_line_id ? Number(req.query.product_line_id) : undefined
    return reply.send(await listTestPipelines(plId))
  })

  app.get<{ Params: { id: string } }>('/test-pipelines/:id', async (req, reply) => {
    const item = await getTestPipelineById(Number(req.params.id))
    if (!item) return reply.status(404).send({ error: 'not found' })
    return reply.send(item)
  })

  app.post<{ Body: {
    productLineId: number; name: string; description?: string
    stages: unknown[]; serverRoles: Record<string, { count: number }>
    schedule?: string; enabled?: boolean
  } }>('/test-pipelines', async (req, reply) => {
    const { productLineId, name, stages, serverRoles } = req.body
    if (!productLineId || !name || !stages || !serverRoles) {
      return reply.status(400).send({ error: 'productLineId, name, stages, serverRoles required' })
    }
    const item = await createTestPipeline(req.body)
    return reply.status(201).send(item)
  })

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/test-pipelines/:id', async (req, reply) => {
    const item = await updateTestPipeline(Number(req.params.id), req.body as any)
    if (!item) return reply.status(404).send({ error: 'not found' })
    return reply.send(item)
  })

  app.delete<{ Params: { id: string } }>('/test-pipelines/:id', async (req, reply) => {
    const deleted = await deleteTestPipeline(Number(req.params.id))
    if (!deleted) return reply.status(404).send({ error: 'not found' })
    return reply.status(204).send()
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/admin/routes/test-pipelines.ts && git commit -m "feat: add test-pipelines admin routes"
```

---

### Task 7: Pipeline Types + SSH Utilities

**Files:**
- Create: `src/pipeline/types.ts`
- Create: `src/pipeline/ssh.ts`

- [ ] **Step 1: Create pipeline types**

Create `src/pipeline/types.ts`:

```typescript
export type StageType = 'cleanup' | 'download' | 'install' | 'health_check' | 'test' | 'report' | 'custom'

export interface StageDefinition {
  name: string
  type: StageType
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  params: Record<string, unknown>
  onFailure: 'stop' | 'continue'
}

export interface CleanupParams {
  script: string
  args?: string[]
  preCommands?: string[]
}

export interface DownloadParams {
  sourceUrl: string
  destPath: string
  checksum?: string
  extract: boolean
}

export interface InstallParams {
  workDir: string
  script: string
  configFile: string
  configValues: Record<string, string>
  silentFlag: string
}

export interface HealthCheckParams {
  checkType: 'http' | 'tcp' | 'command'
  target: string
  intervalSeconds: number
  maxRetries: number
}

export interface TestParams {
  gitRepo: string
  branch: string
  workDir: string
  command: string
  collectArtifacts: string[]
}

export interface ReportParams {
  format: 'html'
  includeStageLog: boolean
}

export interface CustomParams {
  command: string
}

export interface ServerInfo {
  id: number
  host: string
  port: number
  username: string
  password: string
  role: string
}

export interface StageContext {
  runId: number
  stageIndex: number
  servers: Record<string, ServerInfo[]>
  logDir: string
}

export interface StageExecutionResult {
  status: 'success' | 'failed'
  output: string
  error?: string
  artifacts?: string[]
}
```

- [ ] **Step 2: Create SSH utilities**

Create `src/pipeline/ssh.ts`:

```typescript
import { Client } from 'ssh2'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'

export interface SSHConfig {
  host: string
  port?: number
  username: string
  password: string
}

export function sshExec(config: SSHConfig, command: string, timeoutMs = 300000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { conn.end(); reject(new Error(`SSH command timed out after ${timeoutMs}ms`)) }, timeoutMs)

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err) }
        stream.on('close', (code: number) => {
          clearTimeout(timer); conn.end()
          resolve({ stdout, stderr, code: code ?? 0 })
        })
        stream.on('data', (data: Buffer) => { stdout += data.toString() })
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      })
    })
    conn.on('error', (err) => { clearTimeout(timer); reject(err) })
    conn.connect({ host: config.host, port: config.port ?? 22, username: config.username, password: config.password, readyTimeout: 10000 })
  })
}

export function sshExecWithLog(config: SSHConfig, command: string, logFile: string, timeoutMs = 300000): Promise<{ code: number }> {
  return new Promise(async (resolve, reject) => {
    await mkdir(dirname(logFile), { recursive: true })
    const logStream = createWriteStream(logFile, { flags: 'a' })
    const conn = new Client()
    const timer = setTimeout(() => { conn.end(); logStream.end(); reject(new Error('SSH timed out')) }, timeoutMs)

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); logStream.end(); return reject(err) }
        stream.on('close', (code: number) => {
          clearTimeout(timer); conn.end(); logStream.end()
          resolve({ code: code ?? 0 })
        })
        stream.on('data', (data: Buffer) => { logStream.write(data) })
        stream.stderr.on('data', (data: Buffer) => { logStream.write(data) })
      })
    })
    conn.on('error', (err) => { clearTimeout(timer); logStream.end(); reject(err) })
    conn.connect({ host: config.host, port: config.port ?? 22, username: config.username, password: config.password, readyTimeout: 10000 })
  })
}

export function scpDownload(config: SSHConfig, remotePath: string, localPath: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    await mkdir(dirname(localPath), { recursive: true })
    const conn = new Client()
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err) }
        sftp.fastGet(remotePath, localPath, (err) => {
          conn.end()
          if (err) return reject(err)
          resolve()
        })
      })
    })
    conn.on('error', (err) => reject(err))
    conn.connect({ host: config.host, port: config.port ?? 22, username: config.username, password: config.password, readyTimeout: 10000 })
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/ssh.ts && git commit -m "feat: add pipeline types + SSH utilities"
```

---

### Task 8: Stage Implementations

**Files:**
- Create: `src/pipeline/stages/cleanup.ts`
- Create: `src/pipeline/stages/download.ts`
- Create: `src/pipeline/stages/install.ts`
- Create: `src/pipeline/stages/health-check.ts`
- Create: `src/pipeline/stages/test.ts`
- Create: `src/pipeline/stages/custom.ts`

- [ ] **Step 1: Create cleanup stage**

Create `src/pipeline/stages/cleanup.ts`:

```typescript
import { sshExecWithLog } from '../ssh.js'
import type { CleanupParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'

export async function executeCleanup(params: CleanupParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-cleanup.log`)
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    try {
      // Execute pre-commands
      if (params.preCommands?.length) {
        const preCmd = params.preCommands.join(' && ')
        const pre = await sshExecWithLog(sshCfg, preCmd, logFile)
        if (pre.code !== 0) {
          return { status: 'failed', output: `Pre-command failed on ${server.host}`, error: `exit code ${pre.code}` }
        }
      }
      // Execute uninstall script
      const args = params.args?.join(' ') ?? ''
      const cmd = `${params.script} ${args}`.trim()
      const result = await sshExecWithLog(sshCfg, cmd, logFile)
      if (result.code !== 0) {
        return { status: 'failed', output: `Cleanup failed on ${server.host}`, error: `exit code ${result.code}` }
      }
      outputs.push(`${server.host}: cleanup ok`)
    } catch (err) {
      return { status: 'failed', output: `Cleanup error on ${server.host}`, error: String(err) }
    }
  }
  return { status: 'success', output: outputs.join('\n') }
}
```

- [ ] **Step 2: Create download stage**

Create `src/pipeline/stages/download.ts`:

```typescript
import { sshExecWithLog } from '../ssh.js'
import type { DownloadParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'

export async function executeDownload(params: DownloadParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-download.log`)
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    try {
      const commands: string[] = [
        `mkdir -p ${params.destPath}`,
        `cd ${params.destPath}`,
        `curl -fSL -o package.tar.gz '${params.sourceUrl}'`,
      ]
      if (params.checksum) {
        const [algo, hash] = params.checksum.split(':')
        commands.push(`echo '${hash}  package.tar.gz' | ${algo}sum -c -`)
      }
      if (params.extract) {
        commands.push('tar xzf package.tar.gz')
      }
      const result = await sshExecWithLog(sshCfg, commands.join(' && '), logFile)
      if (result.code !== 0) {
        return { status: 'failed', output: `Download failed on ${server.host}`, error: `exit code ${result.code}` }
      }
      outputs.push(`${server.host}: download ok`)
    } catch (err) {
      return { status: 'failed', output: `Download error on ${server.host}`, error: String(err) }
    }
  }
  return { status: 'success', output: outputs.join('\n') }
}
```

- [ ] **Step 3: Create install stage**

Create `src/pipeline/stages/install.ts`:

```typescript
import { sshExecWithLog, sshExec } from '../ssh.js'
import type { InstallParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'

function resolveVariables(value: string, servers: Record<string, ServerInfo[]>): string {
  return value.replace(/\{\{servers\.(\w+)\[(\d+)\]\.(\w+)\}\}/g, (_match, role, index, field) => {
    const list = servers[role]
    if (!list || !list[Number(index)]) return _match
    const srv = list[Number(index)] as Record<string, unknown>
    return String(srv[field] ?? _match)
  })
}

function generateConfigContent(configValues: Record<string, string>, servers: Record<string, ServerInfo[]>): string {
  return Object.entries(configValues)
    .map(([key, val]) => `${key}=${resolveVariables(val, servers)}`)
    .join('\n')
}

export async function executeInstall(params: InstallParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-install.log`)
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    try {
      // Generate config file on remote server
      const configContent = generateConfigContent(params.configValues, ctx.servers)
      const configPath = `${params.workDir}/${params.configFile}`
      await sshExec(sshCfg, `mkdir -p ${params.workDir} && cat > ${configPath} << 'CHATOPS_EOF'\n${configContent}\nCHATOPS_EOF`)

      // Execute install script with silent flag
      const cmd = `cd ${params.workDir} && ${params.script} ${params.silentFlag}`
      const result = await sshExecWithLog(sshCfg, cmd, logFile, 600000)
      if (result.code !== 0) {
        return { status: 'failed', output: `Install failed on ${server.host}`, error: `exit code ${result.code}` }
      }
      outputs.push(`${server.host}: install ok`)
    } catch (err) {
      return { status: 'failed', output: `Install error on ${server.host}`, error: String(err) }
    }
  }
  return { status: 'success', output: outputs.join('\n') }
}
```

- [ ] **Step 4: Create health-check stage**

Create `src/pipeline/stages/health-check.ts`:

```typescript
import { sshExec } from '../ssh.js'
import type { HealthCheckParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { appendFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export async function executeHealthCheck(params: HealthCheckParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-health-check.log`)
  await mkdir(dirname(logFile), { recursive: true })
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    let lastError = ''
    let passed = false

    for (let attempt = 0; attempt < params.maxRetries; attempt++) {
      try {
        let cmd: string
        if (params.checkType === 'http') {
          cmd = `curl -sf -o /dev/null -w '%{http_code}' '${params.target}'`
        } else if (params.checkType === 'tcp') {
          const [host, port] = params.target.split(':')
          cmd = `bash -c 'echo > /dev/tcp/${host}/${port}' 2>/dev/null`
        } else {
          cmd = params.target
        }
        const result = await sshExec(sshCfg, cmd, 10000)
        await appendFile(logFile, `[${server.host}] attempt ${attempt + 1}: code=${result.code} stdout=${result.stdout.trim()}\n`)
        if (result.code === 0) { passed = true; break }
        lastError = result.stderr || result.stdout
      } catch (err) {
        lastError = String(err)
        await appendFile(logFile, `[${server.host}] attempt ${attempt + 1}: error=${lastError}\n`)
      }
      if (attempt < params.maxRetries - 1) await sleep(params.intervalSeconds * 1000)
    }

    if (!passed) {
      return { status: 'failed', output: `Health check failed on ${server.host} after ${params.maxRetries} attempts`, error: lastError }
    }
    outputs.push(`${server.host}: healthy`)
  }
  return { status: 'success', output: outputs.join('\n') }
}
```

- [ ] **Step 5: Create test stage**

Create `src/pipeline/stages/test.ts`:

```typescript
import { sshExecWithLog, scpDownload } from '../ssh.js'
import type { TestParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'
import { mkdir } from 'fs/promises'

export async function executeTest(params: TestParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-test.log`)
  const server = servers[0]
  if (!server) return { status: 'failed', output: 'No test server assigned', error: 'missing server' }

  const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }

  try {
    // Clone test repo
    const cloneCmd = [
      `rm -rf ${params.workDir}`,
      `git clone --branch ${params.branch} --depth 1 '${params.gitRepo}' ${params.workDir}`,
    ].join(' && ')
    const cloneResult = await sshExecWithLog(sshCfg, cloneCmd, logFile, 120000)
    if (cloneResult.code !== 0) {
      return { status: 'failed', output: 'Failed to clone test repo', error: `exit code ${cloneResult.code}` }
    }

    // Install Python dependencies if requirements.txt exists
    const depsCmd = `cd ${params.workDir} && [ -f requirements.txt ] && pip install -r requirements.txt || true`
    await sshExecWithLog(sshCfg, depsCmd, logFile, 300000)

    // Execute pytest
    const testCmd = `cd ${params.workDir} && ${params.command}`
    const testResult = await sshExecWithLog(sshCfg, testCmd, logFile, 600000)

    // Collect artifacts via SCP
    const artifactDir = join(ctx.logDir, 'test-results')
    await mkdir(artifactDir, { recursive: true })
    const collectedArtifacts: string[] = []
    for (const artifact of params.collectArtifacts) {
      const remotePath = `${params.workDir}/${artifact}`
      const localPath = join(artifactDir, artifact.replace(/\//g, '_'))
      try {
        await scpDownload(sshCfg, remotePath, localPath)
        collectedArtifacts.push(localPath)
      } catch {
        // Artifact might not exist if tests crashed
      }
    }

    // pytest returns exit code 1 for test failures (not execution errors)
    // We still consider it "success" if artifacts were collected — the report shows details
    const status = testResult.code === 0 ? 'success' : 'failed'
    return { status, output: `Tests completed with exit code ${testResult.code}`, artifacts: collectedArtifacts }
  } catch (err) {
    return { status: 'failed', output: 'Test execution error', error: String(err) }
  }
}
```

- [ ] **Step 6: Create custom stage**

Create `src/pipeline/stages/custom.ts`:

```typescript
import { sshExecWithLog } from '../ssh.js'
import type { CustomParams, StageContext, StageExecutionResult, ServerInfo } from '../types.js'
import { join } from 'path'

export async function executeCustom(params: CustomParams, servers: ServerInfo[], ctx: StageContext): Promise<StageExecutionResult> {
  const logFile = join(ctx.logDir, `${String(ctx.stageIndex + 1).padStart(2, '0')}-custom.log`)
  const outputs: string[] = []

  for (const server of servers) {
    const sshCfg = { host: server.host, port: server.port, username: server.username, password: server.password }
    try {
      const result = await sshExecWithLog(sshCfg, params.command, logFile)
      if (result.code !== 0) {
        return { status: 'failed', output: `Custom command failed on ${server.host}`, error: `exit code ${result.code}` }
      }
      outputs.push(`${server.host}: ok`)
    } catch (err) {
      return { status: 'failed', output: `Custom command error on ${server.host}`, error: String(err) }
    }
  }
  return { status: 'success', output: outputs.join('\n') }
}
```

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/stages/ && git commit -m "feat: add all pipeline stage implementations"
```

---

### Task 9: Report Generator

**Files:**
- Create: `src/pipeline/report-generator.ts`

- [ ] **Step 1: Create report generator**

Create `src/pipeline/report-generator.ts` — generates HTML report and ZIP archive. Uses `archiver` for ZIP packaging. Parses JUnit XML from pytest for test result details. The HTML report includes a download button linking to the ZIP endpoint.

Full implementation: generates self-contained HTML (inline CSS), parses JUnit XML results, creates ZIP with all logs/artifacts/configs.

- [ ] **Step 2: Commit**

```bash
git add src/pipeline/report-generator.ts && git commit -m "feat: add report generator (HTML + ZIP)"
```

---

### Task 10: Pipeline Executor

**Files:**
- Create: `src/pipeline/executor.ts`

- [ ] **Step 1: Create pipeline executor**

The orchestrator that runs a complete pipeline: locks servers, iterates stages, handles retries, calls report generator, updates DB records, releases servers.

- [ ] **Step 2: Commit**

```bash
git add src/pipeline/executor.ts && git commit -m "feat: add pipeline executor orchestrator"
```

---

### Task 11: Admin Routes — test-runs + Report Serving

**Files:**
- Create: `src/admin/routes/test-runs.ts`

- [ ] **Step 1: Create test-runs routes**

API endpoints: POST trigger, GET list, GET status, GET report (HTML), GET report/download (ZIP). Report HTML served directly for browser viewing. ZIP served as attachment download.

- [ ] **Step 2: Commit**

```bash
git add src/admin/routes/test-runs.ts && git commit -m "feat: add test-runs API routes + report serving"
```

---

### Task 12: autotest AI Tool

**Files:**
- Create: `src/agent/tools/autotest.ts`

- [ ] **Step 1: Create autotest tool**

Register as AgentTool with inputSchema for: list_pipelines, trigger_run, get_run_status, get_report_url actions.

- [ ] **Step 2: Commit**

```bash
git add src/agent/tools/autotest.ts && git commit -m "feat: add autotest AI tool"
```

---

### Task 13: Pipeline Scheduler

**Files:**
- Create: `src/pipeline/scheduler.ts`

- [ ] **Step 1: Create scheduler**

Uses node-cron to register jobs for pipelines with non-empty `schedule` field. Loads scheduled pipelines on startup, triggers runs with `trigger_type='scheduled'`.

- [ ] **Step 2: Commit**

```bash
git add src/pipeline/scheduler.ts && git commit -m "feat: add pipeline cron scheduler"
```

---

### Task 14: Server Integration

**Files:**
- Modify: `src/admin/index.ts` — register 3 new route modules
- Modify: `src/server.ts` — import autotest tool, start scheduler, add /api exclusion
- Modify: `src/db/migrate.ts` — add v3 schema (if not done in Task 1)
- Modify: `src/__tests__/helpers/db.ts` — add v3 schema to reset

- [ ] **Step 1: Update admin/index.ts**
- [ ] **Step 2: Update server.ts**
- [ ] **Step 3: Update test helpers**
- [ ] **Step 4: Commit**

---

### Task 15: Frontend Types + API Clients

**Files:**
- Modify: `web/src/types/index.ts`
- Create: `web/src/api/test-servers.ts`
- Create: `web/src/api/test-pipelines.ts`
- Create: `web/src/api/test-runs.ts`

- [ ] **Step 1: Add types**
- [ ] **Step 2: Create API clients**
- [ ] **Step 3: Commit**

---

### Task 16: Frontend — TestServersPage

**Files:**
- Create: `web/src/pages/TestServersPage.tsx`

CRUD table with connection test button. Follows EnvironmentListPage pattern.

- [ ] **Step 1: Create page**
- [ ] **Step 2: Commit**

---

### Task 17: Frontend — TestPipelinesPage

**Files:**
- Create: `web/src/pages/TestPipelinesPage.tsx`

Pipeline list + create/edit modal with Stage editor (dynamic form array).

- [ ] **Step 1: Create page**
- [ ] **Step 2: Commit**

---

### Task 18: Frontend — TestRunsPage

**Files:**
- Create: `web/src/pages/TestRunsPage.tsx`

Execution history list + detail drawer with stage timeline. Report view + download buttons.

- [ ] **Step 1: Create page**
- [ ] **Step 2: Commit**

---

### Task 19: Frontend Routing + Navigation

**Files:**
- Modify: `web/src/App.tsx` — add 3 new routes
- Modify: `web/src/layout/AdminLayout.tsx` — add menu items

- [ ] **Step 1: Update App.tsx and AdminLayout.tsx**
- [ ] **Step 2: Commit**
