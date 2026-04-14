# Unified Capability Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pipeline stage JSON textarea with structured forms backed by a unified capability system (Agent/Skills/Tools architecture).

**Architecture:** Extend the existing `capabilities` table with `param_schema`, `playbook`, `is_system` fields. Add a `pipeline_tools` table for 6 atomic infrastructure tools. Refactor the frontend to render dynamic forms based on each capability's `param_schema`. Pipeline stages reference `capabilityKey` instead of the old `type` enum.

**Tech Stack:** PostgreSQL (JSONB), Fastify, React 18, Ant Design 5, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-14-unified-capability-pipeline-design.md`

---

### Task 1: Database Schema v4

**Files:**
- Create: `src/db/schema-v4.sql`
- Modify: `src/db/migrate.ts`

- [ ] **Step 1: Create schema-v4.sql**

```sql
-- ============================================================
-- schema-v4: Unified Capability System + Pipeline Tools
-- ============================================================

-- 1. Pipeline Tools table (6 atomic infrastructure tools)
CREATE TABLE IF NOT EXISTS pipeline_tools (
  id           SERIAL PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description  TEXT DEFAULT '',
  param_schema JSONB NOT NULL DEFAULT '{}',
  is_system    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pipeline_tools (key, display_name, description) VALUES
  ('ssh_exec',      '远程命令执行', '通过SSH在远程服务器执行命令或脚本'),
  ('file_transfer', '文件传输',     'SCP/SFTP在服务器间上传/下载文件'),
  ('http_probe',    '网络探测',     'HTTP/TCP连通性检查，支持重试'),
  ('http_download', 'HTTP下载',     '从URL下载文件，支持校验和与自动解压'),
  ('docker_op',     '容器镜像操作', 'docker pull、docker compose等容器操作'),
  ('file_read',     '远程文件读取', '读取远程服务器上的日志/文件内容')
ON CONFLICT (key) DO NOTHING;

-- 2. Extend capabilities table
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS param_schema JSONB DEFAULT '{}';
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS playbook     JSONB DEFAULT '[]';
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS is_system    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW();

-- Widen category CHECK
ALTER TABLE capabilities DROP CONSTRAINT IF EXISTS capabilities_category_check;
DO $$ BEGIN
  ALTER TABLE capabilities ADD CONSTRAINT capabilities_category_check
    CHECK (category IN ('query','action','admin','env_prep','verify','testing','result'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Seed 7 new capabilities
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, param_schema, is_system) VALUES
(
  'env_init', '环境初始化', '在新机器上从零搭建运行环境', 'env_prep',
  '["ssh_exec","file_transfer"]', false,
  '{
    "type": "object",
    "properties": {
      "commands": {"type":"string","format":"textarea","title":"执行命令","description":"shell命令，每行一条。支持变量"},
      "script":   {"type":"string","title":"脚本","description":"脚本路径（可带参数），如 /opt/scripts/init.sh -f"}
    }
  }',
  true
),
(
  'env_cleanup', '环境清理', '清理旧版本、停服务，为重新部署做准备', 'env_prep',
  '["ssh_exec"]', false,
  '{
    "type": "object",
    "properties": {
      "commands": {"type":"string","format":"textarea","title":"执行命令","description":"shell命令，每行一条。支持变量"},
      "script":   {"type":"string","title":"脚本","description":"脚本路径（可带参数）"}
    }
  }',
  true
),
(
  'health_check', '健康检查', '验证服务部署后是否正常运行', 'verify',
  '["http_probe","ssh_exec"]', false,
  '{
    "type": "object",
    "required": ["checkType","target"],
    "properties": {
      "checkType":       {"type":"string","title":"检查方式","enum":["http","tcp","command"]},
      "target":          {"type":"string","title":"检查目标","description":"支持变量，如 http://{{servers.app[0].host}}:8080/health"},
      "intervalSeconds": {"type":"integer","title":"检查间隔(秒)","default":5},
      "maxRetries":      {"type":"integer","title":"最大重试次数","default":10},
      "expectedStatus":  {"type":"integer","title":"期望状态码","default":200}
    }
  }',
  true
),
(
  'auto_test', '自动化测试', '拉取测试代码、执行测试、收集结果', 'testing',
  '["ssh_exec","file_transfer"]', false,
  '{
    "type": "object",
    "required": ["gitRepo","branch","workDir","command"],
    "properties": {
      "gitRepo":          {"type":"string","title":"Git 仓库","description":"支持变量"},
      "branch":           {"type":"string","title":"分支","description":"支持变量"},
      "workDir":          {"type":"string","title":"工作目录"},
      "command":          {"type":"string","format":"textarea","title":"测试命令","description":"支持变量"},
      "collectArtifacts": {"type":"array","items":{"type":"string"},"title":"收集制品路径"}
    }
  }',
  true
),
(
  'log_collect', '日志收集', '从目标服务器收集日志文件用于分析', 'result',
  '["file_read","file_transfer"]', false,
  '{
    "type": "object",
    "required": ["logPaths"],
    "properties": {
      "logPaths":      {"type":"array","items":{"type":"string"},"title":"日志文件路径"},
      "grepKeywords":  {"type":"array","items":{"type":"string"},"title":"过滤关键词"},
      "maxLines":      {"type":"integer","title":"最大行数","default":1000}
    }
  }',
  true
),
(
  'report_gen', '报告生成', '流水线执行完毕后生成汇总报告', 'result',
  '[]', false,
  '{
    "type": "object",
    "properties": {
      "format":           {"type":"string","title":"报告格式","enum":["html"],"default":"html"},
      "includeStageLogs": {"type":"boolean","title":"包含阶段日志","default":true}
    }
  }',
  true
),
(
  'custom_script', '自定义脚本', '执行任意自定义命令或脚本', 'action',
  '["ssh_exec"]', false,
  '{
    "type": "object",
    "properties": {
      "commands": {"type":"string","format":"textarea","title":"执行命令","description":"支持变量"},
      "script":   {"type":"string","title":"脚本","description":"脚本路径（可带参数）"}
    }
  }',
  true
)
ON CONFLICT (key) DO NOTHING;

-- 4. Update existing deploy/rollback/restart with param_schema
UPDATE capabilities SET
  tool_names = '["execute_deploy","request_approval","ssh_exec","http_download","docker_op"]',
  param_schema = '{
    "type": "object",
    "required": ["deployType"],
    "properties": {
      "deployType":    {"type":"string","title":"部署方式","enum":["package","container"]},
      "packageUrl":    {"type":"string","title":"部署包地址","description":"支持变量，如 https://releases.example.com/{{branch}}/app.tar.gz","x-depends-on":{"deployType":"package"}},
      "downloadDir":   {"type":"string","title":"下载目录","x-depends-on":{"deployType":"package"}},
      "checksum":      {"type":"string","title":"校验和","description":"格式 algo:hash","x-depends-on":{"deployType":"package"}},
      "extract":       {"type":"boolean","title":"自动解压","default":true,"x-depends-on":{"deployType":"package"}},
      "silentConfig":  {"type":"string","format":"textarea","title":"Silent安装配置内容","description":"支持变量，如 DB_HOST={{servers.db[0].host}}","x-depends-on":{"deployType":"package"}},
      "installScript": {"type":"string","title":"安装脚本","description":"脚本路径（可带参数）","x-depends-on":{"deployType":"package"}},
      "image":         {"type":"string","title":"镜像地址","description":"支持变量","x-depends-on":{"deployType":"container"}},
      "action":        {"type":"string","title":"操作","enum":["pull","compose_up"],"x-depends-on":{"deployType":"container"}},
      "composeFile":   {"type":"string","title":"Compose文件路径","x-depends-on":{"deployType":"container"}},
      "commands":      {"type":"string","format":"textarea","title":"执行命令","description":"安装/启动命令"}
    }
  }',
  is_system = true, updated_at = NOW()
WHERE key = 'deploy';

UPDATE capabilities SET
  tool_names = '["execute_rollback","request_approval","ssh_exec"]',
  param_schema = '{
    "type": "object",
    "properties": {
      "commands": {"type":"string","format":"textarea","title":"回滚命令"},
      "script":   {"type":"string","title":"回滚脚本","description":"脚本路径（可带参数）"}
    }
  }',
  is_system = true, updated_at = NOW()
WHERE key = 'rollback';

UPDATE capabilities SET
  tool_names = '["execute_restart","request_approval","ssh_exec"]',
  param_schema = '{
    "type": "object",
    "properties": {
      "commands": {"type":"string","format":"textarea","title":"重启命令"},
      "script":   {"type":"string","title":"重启脚本","description":"脚本路径（可带参数）"}
    }
  }',
  is_system = true, updated_at = NOW()
WHERE key = 'restart';

-- Set is_system on existing query/admin capabilities
UPDATE capabilities SET is_system = true, updated_at = NOW()
WHERE key IN ('view_deployments','view_images','view_logs','view_commits','manage_role')
  AND is_system IS DISTINCT FROM true;

-- 5. Add trigger_params to test_pipelines
ALTER TABLE test_pipelines ADD COLUMN IF NOT EXISTS trigger_params JSONB DEFAULT '{}';
```

- [ ] **Step 2: Update migrate.ts**

Add schema-v4 execution after schema-v3 in `src/db/migrate.ts`:

```typescript
const schemaV4 = readFileSync(join(__dirname, 'schema-v4.sql'), 'utf8')
await pool.query(schemaV4)

await pool.end()
console.log('✅ Database schema applied (v1 + v2 + v3 + v4)')
```

- [ ] **Step 3: Run migration and verify**

Run: `docker compose up -d postgres && sleep 3 && pnpm migrate`

Expected: `✅ Database schema applied (v1 + v2 + v3 + v4)`

Verify with: `docker compose exec postgres psql -U chatops -c "SELECT key, category FROM capabilities ORDER BY category, id;"`

Expected: 15 capabilities across 7 categories.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema-v4.sql src/db/migrate.ts
git commit -m "feat: add schema-v4 for unified capability system and pipeline tools"
```

---

### Task 2: Backend – Extend Capabilities Repository

**Files:**
- Modify: `src/db/repositories/capabilities.ts`

- [ ] **Step 1: Extend Capability interface and mapRow**

Replace the entire `src/db/repositories/capabilities.ts` with extended version. The `Capability` interface gains 4 fields: `paramSchema`, `playbook`, `isSystem`, `updatedAt`. The `category` type union is widened. `mapRow` maps the new columns. Add `listPipelineCapabilities()` which filters out query/admin categories.

```typescript
import { getPool } from '../client.js'

export type CapabilityCategory = 'query' | 'action' | 'admin' | 'env_prep' | 'verify' | 'testing' | 'result'

export interface Capability {
  id: number
  key: string
  displayName: string
  description: string
  category: CapabilityCategory
  toolNames: string[]
  needsApproval: boolean
  paramSchema: Record<string, unknown>
  playbook: unknown[]
  isSystem: boolean
  updatedAt: Date | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): Capability {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: r.description as string,
    category: r.category as CapabilityCategory,
    toolNames: r.tool_names as string[],
    needsApproval: r.needs_approval as boolean,
    paramSchema: (r.param_schema ?? {}) as Record<string, unknown>,
    playbook: (r.playbook ?? []) as unknown[],
    isSystem: (r.is_system ?? true) as boolean,
    updatedAt: r.updated_at as Date | null,
    createdAt: r.created_at as Date,
  }
}

export async function listCapabilities(): Promise<Capability[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM capabilities ORDER BY category, id')
  return rows.map(mapRow)
}

export async function listPipelineCapabilities(): Promise<Capability[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    "SELECT * FROM capabilities WHERE category NOT IN ('query', 'admin') ORDER BY category, id"
  )
  return rows.map(mapRow)
}

export async function getCapabilityByKey(key: string): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM capabilities WHERE key = $1', [key])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createCapability(
  data: Pick<Capability, 'key' | 'displayName' | 'description' | 'category' | 'toolNames' | 'needsApproval'> & { paramSchema?: Record<string, unknown> }
): Promise<Capability> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, param_schema)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [data.key, data.displayName, data.description ?? '', data.category,
     JSON.stringify(data.toolNames), data.needsApproval, JSON.stringify(data.paramSchema ?? {})]
  )
  return mapRow(rows[0])
}

export async function updateCapability(
  id: number,
  data: Partial<Pick<Capability, 'displayName' | 'description' | 'category' | 'toolNames' | 'needsApproval' | 'paramSchema'>>
): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET
       display_name = COALESCE($2, display_name),
       description = COALESCE($3, description),
       category = COALESCE($4, category),
       tool_names = COALESCE($5, tool_names),
       needs_approval = COALESCE($6, needs_approval),
       param_schema = COALESCE($7, param_schema),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.displayName ?? null, data.description ?? null, data.category ?? null,
     data.toolNames ? JSON.stringify(data.toolNames) : null, data.needsApproval ?? null,
     data.paramSchema ? JSON.stringify(data.paramSchema) : null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/capabilities.ts
git commit -m "feat: extend capabilities repository with paramSchema, playbook, isSystem"
```

---

### Task 3: Backend – Pipeline Tools Repository + Route

**Files:**
- Create: `src/db/repositories/pipeline-tools.ts`
- Create: `src/admin/routes/pipeline-tools.ts`
- Modify: `src/admin/index.ts`
- Modify: `src/admin/routes/capabilities.ts`

- [ ] **Step 1: Create pipeline-tools repository**

```typescript
// src/db/repositories/pipeline-tools.ts
import { getPool } from '../client.js'

export interface PipelineTool {
  id: number
  key: string
  displayName: string
  description: string
  paramSchema: Record<string, unknown>
  isSystem: boolean
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): PipelineTool {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: r.description as string,
    paramSchema: (r.param_schema ?? {}) as Record<string, unknown>,
    isSystem: (r.is_system ?? true) as boolean,
    createdAt: r.created_at as Date,
  }
}

export async function listPipelineTools(): Promise<PipelineTool[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM pipeline_tools ORDER BY id')
  return rows.map(mapRow)
}
```

- [ ] **Step 2: Create pipeline-tools route**

```typescript
// src/admin/routes/pipeline-tools.ts
import type { FastifyInstance } from 'fastify'
import { listPipelineTools } from '../../db/repositories/pipeline-tools.js'

export async function registerPipelineToolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pipeline-tools', async (_req, reply) => {
    return reply.send(await listPipelineTools())
  })
}
```

- [ ] **Step 3: Add pipeline capabilities endpoint to capabilities route**

In `src/admin/routes/capabilities.ts`, add import and endpoint:

```typescript
import { listCapabilities, listPipelineCapabilities, createCapability, updateCapability } from '../../db/repositories/capabilities.js'

// Add inside registerCapabilityRoutes, before the POST handler:
app.get('/capabilities/pipeline', async (_req, reply) => {
  return reply.send(await listPipelineCapabilities())
})
```

- [ ] **Step 4: Register pipeline-tools route in admin/index.ts**

Add import and registration:

```typescript
import { registerPipelineToolRoutes } from './routes/pipeline-tools.js'

// Inside adminPlugin, after registerCapabilityRoutes:
await registerPipelineToolRoutes(app)
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/pipeline-tools.ts src/admin/routes/pipeline-tools.ts src/admin/routes/capabilities.ts src/admin/index.ts
git commit -m "feat: add pipeline-tools repository and route, add /capabilities/pipeline endpoint"
```

---

### Task 4: Backend – Update Pipeline Types + Repository for trigger_params

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/db/repositories/test-pipelines.ts`

- [ ] **Step 1: Update pipeline types.ts**

Add `capabilityKey` to `StageDefinition` alongside `type` (kept for backward compat with executor). Add legacy mapping helper.

At the top of `src/pipeline/types.ts`, after existing `StageType`:

```typescript
export interface StageDefinition {
  name: string
  type?: StageType               // DEPRECATED - kept for executor backward compat
  capabilityKey?: string          // NEW - references capabilities.key
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  params: Record<string, unknown>
  onFailure: 'stop' | 'continue'
}

const LEGACY_TYPE_MAP: Record<string, string> = {
  cleanup: 'env_cleanup', download: 'deploy', install: 'deploy',
  health_check: 'health_check', test: 'auto_test',
  report: 'report_gen', custom: 'custom_script',
}

export function getStageCapabilityKey(stage: StageDefinition): string {
  if (stage.capabilityKey) return stage.capabilityKey
  return LEGACY_TYPE_MAP[stage.type ?? ''] ?? stage.type ?? 'custom_script'
}
```

- [ ] **Step 2: Update test-pipelines repository**

Add `triggerParams` to interface and mapRow. Update create/update to handle it.

In `src/db/repositories/test-pipelines.ts`:

Add to `TestPipeline` interface:
```typescript
triggerParams: Record<string, unknown>
```

Update `mapRow` — add:
```typescript
triggerParams: (r.trigger_params ?? {}) as Record<string, unknown>,
```

Update `createTestPipeline` data parameter — add `triggerParams?: Record<string, unknown>` and update SQL:
```sql
INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
```
Add `JSON.stringify(data.triggerParams ?? {})` as the 8th parameter.

Update `updateTestPipeline` data type — add `triggerParams?: Record<string, unknown>` and update SQL to include:
```sql
trigger_params = COALESCE($8, trigger_params),
```
Add `data.triggerParams ? JSON.stringify(data.triggerParams) : null` as the 8th parameter.

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/types.ts src/db/repositories/test-pipelines.ts
git commit -m "feat: add capabilityKey to StageDefinition, add triggerParams to TestPipeline"
```

---

### Task 5: Frontend – Types and API Layer

**Files:**
- Modify: `web/src/types/index.ts`
- Modify: `web/src/api/capabilities.ts`
- Modify: `web/src/api/test-pipelines.ts`

- [ ] **Step 1: Update frontend types**

In `web/src/types/index.ts`, update `StageDefinition`:

```typescript
export interface StageDefinition {
  name: string
  capabilityKey: string
  type?: string                  // legacy, kept for reading old data
  targetRoles: string[]
  parallel: boolean
  timeoutSeconds: number
  retryCount: number
  params: Record<string, unknown>
  onFailure: 'stop' | 'continue'
}
```

Add `triggerParams: Record<string, unknown>` to `TestPipeline` interface.

- [ ] **Step 2: Update capabilities API**

In `web/src/api/capabilities.ts`, extend the `Capability` interface:

```typescript
export interface Capability {
  id: number
  key: string
  displayName: string
  description: string
  category: 'query' | 'action' | 'admin' | 'env_prep' | 'verify' | 'testing' | 'result'
  toolNames: string[]
  needsApproval: boolean
  paramSchema: Record<string, unknown>
  playbook: unknown[]
  isSystem: boolean
  updatedAt: string
  createdAt: string
}

export const getPipelineCapabilities = () =>
  client.get<Capability[]>('/capabilities/pipeline').then(r => r.data)
```

- [ ] **Step 3: Verify TS compilation**

Run: `cd web && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add web/src/types/index.ts web/src/api/capabilities.ts
git commit -m "feat: update frontend types for unified capability system"
```

---

### Task 6: Frontend – StageParamsForm Component

**Files:**
- Create: `web/src/components/StageParamsForm.tsx`

This is the core dynamic form renderer. It reads a capability's JSON Schema `param_schema` and renders Ant Design form fields.

- [ ] **Step 1: Create StageParamsForm.tsx**

```tsx
import { Form, Input, InputNumber, Select, Switch } from 'antd'
import type { FormInstance } from 'antd'

interface SchemaProperty {
  type: string
  format?: string
  title?: string
  description?: string
  enum?: string[]
  default?: unknown
  items?: { type: string }
  'x-depends-on'?: Record<string, string>
}

interface StageParamsFormProps {
  paramSchema: Record<string, unknown>
  parentFieldName: number
  form: FormInstance
}

export default function StageParamsForm({ paramSchema, parentFieldName, form }: StageParamsFormProps) {
  const properties = (paramSchema?.properties ?? {}) as Record<string, SchemaProperty>
  const required = (paramSchema?.required ?? []) as string[]

  const allParams = Form.useWatch(['stages', parentFieldName, 'params'], form) as Record<string, unknown> | undefined

  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {Object.entries(properties).map(([key, prop]) => {
        // Handle conditional visibility via x-depends-on
        if (prop['x-depends-on']) {
          const deps = prop['x-depends-on']
          for (const [depKey, depValue] of Object.entries(deps)) {
            if (allParams?.[depKey] !== depValue) return null
          }
        }

        const isRequired = required.includes(key)
        const label = prop.title ?? key
        const rules = isRequired ? [{ required: true, message: `请输入${label}` }] : []

        // Array of strings → Select mode="tags"
        if (prop.type === 'array' && prop.items?.type === 'string') {
          return (
            <div key={key} style={{ flex: '1 1 250px', minWidth: 200 }}>
              <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}>
                <Select mode="tags" tokenSeparators={[',']} placeholder="输入后回车添加" />
              </Form.Item>
            </div>
          )
        }

        // Enum → Select
        if (prop.enum) {
          return (
            <div key={key} style={{ minWidth: 130 }}>
              <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}
                initialValue={prop.default}>
                <Select options={prop.enum.map(v => ({ value: v, label: v }))} style={{ width: '100%' }} />
              </Form.Item>
            </div>
          )
        }

        // Boolean → Switch
        if (prop.type === 'boolean') {
          return (
            <div key={key} style={{ minWidth: 100 }}>
              <Form.Item name={[parentFieldName, 'params', key]} label={label}
                valuePropName="checked" initialValue={prop.default}>
                <Switch />
              </Form.Item>
            </div>
          )
        }

        // Integer/Number → InputNumber
        if (prop.type === 'integer' || prop.type === 'number') {
          return (
            <div key={key} style={{ minWidth: 100 }}>
              <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}
                initialValue={prop.default}>
                <InputNumber style={{ width: '100%' }} />
              </Form.Item>
            </div>
          )
        }

        // String with format=textarea → TextArea
        if (prop.format === 'textarea') {
          return (
            <div key={key} style={{ flex: '1 1 100%', minWidth: 300 }}>
              <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}>
                <Input.TextArea rows={3} placeholder={prop.description} style={{ fontFamily: 'monospace', fontSize: 12 }} />
              </Form.Item>
            </div>
          )
        }

        // Default: string → Input
        return (
          <div key={key} style={{ flex: '1 1 200px', minWidth: 150 }}>
            <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}>
              <Input placeholder={prop.description} />
            </Form.Item>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd web && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add web/src/components/StageParamsForm.tsx
git commit -m "feat: add StageParamsForm component for dynamic capability param rendering"
```

---

### Task 7: Frontend – Refactor TestPipelinesPage

**Files:**
- Modify: `web/src/pages/TestPipelinesPage.tsx`

This is the main deliverable. Replace the `STAGE_TYPES` constant and JSON textarea with capability-driven forms.

- [ ] **Step 1: Rewrite TestPipelinesPage.tsx**

Replace the entire file. Key changes:
- Remove `STAGE_TYPES`
- Load pipeline capabilities via `getPipelineCapabilities()`
- Build `capabilityMap` for quick lookup
- Replace `type` Select with grouped capability Select
- Replace `paramsJson` textarea with `StageParamsForm`
- Add `targetRoles` and `parallel` fields
- Handle capability switching (clear params)
- Handle legacy data in `openEdit`

```tsx
import { useEffect, useState, useMemo } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, Popconfirm, Space, Tag, InputNumber, message } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { getTestPipelines, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../api/test-pipelines'
import { getProductLines } from '../api/product-lines'
import { getPipelineCapabilities } from '../api/capabilities'
import type { TestPipeline, ProductLine } from '../types'
import type { Capability } from '../api/capabilities'
import StageParamsForm from '../components/StageParamsForm'

const CATEGORY_ORDER = ['env_prep', 'action', 'verify', 'testing', 'result']
const CATEGORY_LABELS: Record<string, string> = {
  env_prep: '环境准备', action: '操作', verify: '验证', testing: '测试', result: '结果处理',
}

const LEGACY_TYPE_MAP: Record<string, string> = {
  cleanup: 'env_cleanup', download: 'deploy', install: 'deploy',
  health_check: 'health_check', test: 'auto_test', report: 'report_gen', custom: 'custom_script',
}

export default function TestPipelinesPage() {
  const [data, setData] = useState<TestPipeline[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestPipeline | null>(null)
  const [form] = Form.useForm()

  useEffect(() => { load(); loadProductLines(); loadCapabilities() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getTestPipelines()) } finally { setLoading(false) }
  }
  async function loadProductLines() {
    try { setProductLines(await getProductLines()) } catch { /* */ }
  }
  async function loadCapabilities() {
    try { setCapabilities(await getPipelineCapabilities()) } catch { /* */ }
  }

  const capabilityMap = useMemo(() => {
    const m = new Map<string, Capability>()
    capabilities.forEach(c => m.set(c.key, c))
    return m
  }, [capabilities])

  const capabilityOptions = useMemo(() => {
    return CATEGORY_ORDER
      .map(cat => {
        const items = capabilities.filter(c => c.category === cat)
        if (items.length === 0) return null
        return {
          label: CATEGORY_LABELS[cat] ?? cat,
          options: items.map(c => ({ value: c.key, label: c.displayName })),
        }
      })
      .filter(Boolean)
  }, [capabilities])

  function openCreate() {
    setEditing(null); form.resetFields()
    form.setFieldsValue({
      enabled: true,
      stages: [{
        capabilityKey: 'env_cleanup', name: '环境清理',
        parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop',
        targetRoles: [], params: {},
      }],
    })
    setModalOpen(true)
  }

  function openEdit(r: TestPipeline) {
    setEditing(r)
    const stages = (r.stages as any[]).map((s: any) => ({
      ...s,
      capabilityKey: s.capabilityKey || LEGACY_TYPE_MAP[s.type] || s.type,
      targetRoles: s.targetRoles ?? [],
      parallel: s.parallel ?? false,
      params: s.params ?? {},
    }))
    form.setFieldsValue({ ...r, stages, serverRolesJson: JSON.stringify(r.serverRoles, null, 2) })
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    const payload = {
      ...values,
      serverRoles: values.serverRolesJson ? JSON.parse(values.serverRolesJson) : {},
      stages: values.stages.map((s: any) => ({
        name: s.name,
        capabilityKey: s.capabilityKey,
        params: s.params ?? {},
        targetRoles: s.targetRoles ?? [],
        parallel: s.parallel ?? false,
        timeoutSeconds: s.timeoutSeconds ?? 300,
        retryCount: s.retryCount ?? 0,
        onFailure: s.onFailure ?? 'stop',
      })),
    }
    delete payload.serverRolesJson
    if (editing) {
      await updateTestPipeline(editing.id, payload)
      message.success('更新成功')
    } else {
      await createTestPipeline(payload)
      message.success('创建成功')
    }
    setModalOpen(false); await load()
  }

  async function handleDelete(id: number) {
    await deleteTestPipeline(id); message.success('删除成功'); await load()
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '名称', dataIndex: 'name' },
    { title: '产线', dataIndex: 'productLineId', width: 100, render: (v: number) => productLines.find(p => p.id === v)?.displayName ?? v },
    { title: '阶段数', width: 80, render: (_: unknown, r: TestPipeline) => (r.stages as any[]).length },
    { title: '定时', dataIndex: 'schedule', width: 120, render: (v: string) => v || '-' },
    { title: '状态', dataIndex: 'enabled', width: 80, render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '禁用'}</Tag> },
    {
      title: '操作', width: 150,
      render: (_: unknown, r: TestPipeline) => (
        <Space>
          <a onClick={() => openEdit(r)}>编辑</a>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}><a style={{ color: 'red' }}>删除</a></Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card title="测试流水线管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增流水线</Button>}>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal title={editing ? '编辑流水线' : '新增流水线'} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)} destroyOnClose width={900}>
        <Form form={form} layout="vertical">
          <Form.Item name="productLineId" label="所属产线" rules={[{ required: true }]}>
            <Select options={productLines.map(p => ({ value: p.id, label: p.displayName }))} placeholder="选择产线" />
          </Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="name" label="名称" rules={[{ required: true }]} style={{ flex: 1 }}><Input placeholder="如: 回归测试" /></Form.Item>
            <Form.Item name="schedule" label="定时(cron)"><Input placeholder="如: 0 2 * * *" style={{ width: 200 }} /></Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
          </Space>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="serverRolesJson" label="服务器角色定义 (JSON)" rules={[{ required: true }]}>
            <Input.TextArea rows={3} placeholder='{"db": {"count": 1}, "app": {"count": 1}}' />
          </Form.Item>

          <div style={{ marginBottom: 8, fontWeight: 500 }}>阶段配置</div>
          <Form.List name="stages">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <Card key={key} size="small" style={{ marginBottom: 8 }} extra={<DeleteOutlined onClick={() => remove(name)} style={{ color: 'red' }} />}>
                    <Space style={{ display: 'flex', flexWrap: 'wrap' }}>
                      <Form.Item {...rest} name={[name, 'name']} label="阶段名称" rules={[{ required: true }]}>
                        <Input style={{ width: 150 }} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'capabilityKey']} label="选择能力" rules={[{ required: true }]}>
                        <Select
                          options={capabilityOptions as any}
                          style={{ width: 160 }}
                          onChange={() => form.setFieldValue(['stages', name, 'params'], {})}
                        />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'targetRoles']} label="目标角色">
                        <Select mode="tags" style={{ width: 160 }} placeholder="输入角色名" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'timeoutSeconds']} label="超时(秒)"><InputNumber min={10} style={{ width: 100 }} /></Form.Item>
                      <Form.Item {...rest} name={[name, 'retryCount']} label="重试次数"><InputNumber min={0} max={5} style={{ width: 80 }} /></Form.Item>
                      <Form.Item {...rest} name={[name, 'onFailure']} label="失败策略">
                        <Select options={[{ value: 'stop', label: '停止' }, { value: 'continue', label: '继续' }]} style={{ width: 90 }} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'parallel']} label="并行" valuePropName="checked">
                        <Switch />
                      </Form.Item>
                    </Space>
                    <StageParamsFormWrapper stageIndex={name} form={form} capabilityMap={capabilityMap} />
                  </Card>
                ))}
                <Button type="dashed" onClick={() => add({
                  capabilityKey: 'custom_script', name: '', parallel: false,
                  timeoutSeconds: 300, retryCount: 0, onFailure: 'stop', targetRoles: [], params: {},
                })} block icon={<PlusOutlined />}>
                  添加阶段
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </Card>
  )
}

function StageParamsFormWrapper({ stageIndex, form, capabilityMap }: {
  stageIndex: number; form: any; capabilityMap: Map<string, Capability>
}) {
  const capabilityKey = Form.useWatch(['stages', stageIndex, 'capabilityKey'], form)
  const capability = capabilityKey ? capabilityMap.get(capabilityKey) : null
  if (!capability?.paramSchema || !Object.keys(capability.paramSchema).length) return null
  return (
    <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 6, padding: 12, marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: '#fa8c16', marginBottom: 10 }}>
        {capability.displayName} 能力参数
      </div>
      <StageParamsForm paramSchema={capability.paramSchema} parentFieldName={stageIndex} form={form} />
    </div>
  )
}
```

- [ ] **Step 2: Verify dev server**

Run: `cd web && pnpm dev`

Open `http://localhost:5173`, navigate to test pipelines page, click "新增流水线". Verify:
1. Capability selector shows grouped options
2. Selecting different capabilities shows different param fields
3. Deploy capability shows deployType selector, and fields change when switching package/container
4. Submit creates pipeline with `capabilityKey` and structured params

- [ ] **Step 3: Test editing existing pipeline**

If existing pipelines have `type` field, verify `openEdit` correctly maps them to `capabilityKey`.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/TestPipelinesPage.tsx
git commit -m "feat: refactor pipeline stage config with capability-driven dynamic forms"
```

---

### Task 8: Frontend – Update CapabilitiesPage for New Fields

**Files:**
- Modify: `web/src/pages/CapabilitiesPage.tsx`

- [ ] **Step 1: Update category labels and colors**

Add new categories to the constants:

```typescript
const categoryColors: Record<string, string> = {
  query: 'blue', action: 'orange', admin: 'red',
  env_prep: 'cyan', verify: 'green', testing: 'purple', result: 'magenta',
}
const categoryLabels: Record<string, string> = {
  query: '查询', action: '操作', admin: '管理',
  env_prep: '环境准备', verify: '验证', testing: '测试', result: '结果处理',
}
```

- [ ] **Step 2: Add isSystem column to table**

```typescript
{ title: '类型', dataIndex: 'isSystem', width: 80,
  render: (v: boolean) => <Tag color={v ? 'default' : 'blue'}>{v ? '系统' : '自定义'}</Tag> },
```

- [ ] **Step 3: Widen category Select in form**

Update the category options in the create/edit modal to include all 7 categories.

- [ ] **Step 4: Verify**

Open the Capabilities page, verify all 15 capabilities display with correct category colors and labels.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/CapabilitiesPage.tsx
git commit -m "feat: update CapabilitiesPage with new categories and isSystem field"
```

---

## Verification

After all tasks are complete:

1. **Run migration**: `pnpm migrate` — expect success with v4
2. **Start backend**: `docker compose up -d` — verify chatops service starts without errors
3. **Start frontend**: `cd web && pnpm dev`
4. **Test pipeline creation**: Create a pipeline with stages using different capabilities (env_cleanup, deploy with package mode, health_check, auto_test, report_gen). Verify dynamic forms render correctly for each.
5. **Test deploy mode switching**: Switch between package/container deploy types, verify conditional fields toggle.
6. **Test capability switching**: Change a stage's capability, verify old params are cleared.
7. **Test variable syntax**: Enter `{{branch}}` in a URL field, verify it saves and loads correctly.
8. **Test edit of existing pipeline**: If legacy pipelines exist with `type` field, verify they load correctly.
9. **Verify capabilities page**: All 15 capabilities show with correct categories.
10. **Verify API**: `GET /admin/capabilities/pipeline` returns only pipeline-eligible capabilities. `GET /admin/pipeline-tools` returns 6 tools.
