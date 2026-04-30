# E2E Pipeline A — 基础设施实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 Pipeline A 所需的全部基础设施：DB schema、5 张表的 repository、`invoke_target_script` 节点、claude-runner dockerExec 选项、ChatOps 自身脚本子命令扩展（deploy/test/build）、以及沙盒启动 sentinel 校验。

**Architecture:** 独立 `v1000` 段位 schema；`invoke_target_script` 是纯本地子进程节点，不走 SSH；dockerExec 通过向 claude-runner 注入 `docker exec <containerId>` 前缀实现；deploy/test/build 脚本扩子命令保持各自原有风格（位置参数 / 长选项 / ENV 驱动）。

**Tech Stack:** PostgreSQL raw SQL, Node.js child_process.spawn, Vitest, Bash

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `src/db/schema-v1000.sql` |
| 修改 | `src/db/migrate.ts` (SCHEMA_FILES 末尾追加) |
| 修改 | `src/__tests__/helpers/db.ts` (SCHEMA_FILES 末尾追加) |
| 新建 | `src/db/repositories/e2e-target-projects.ts` |
| 新建 | `src/db/repositories/e2e-specs.ts` |
| 新建 | `src/db/repositories/e2e-runs.ts` |
| 新建 | `src/db/repositories/e2e-scenario-runs.ts` |
| 新建 | `src/db/repositories/e2e-sandboxes.ts` |
| 新建 | `src/pipeline/node-types/invoke-target-script.ts` |
| 新建 | `src/__tests__/unit/invoke-target-script.test.ts` |
| 修改 | `src/pipeline/node-types/index.ts` (import 新节点) |
| 修改 | `src/agent/claude-runner.ts` (dockerExec 选项) |
| 新建 | `src/__tests__/unit/claude-runner-docker-exec.test.ts` |
| 新建 | `src/e2e/sandbox-sentinel.ts` |
| 新建 | `src/__tests__/unit/sandbox-sentinel.test.ts` |
| 修改 | `deploy.sh` (新增 provision/teardown/healthcheck/deploy/redeploy) |
| 修改 | `test.sh` (新增 --discover/--scenario/--static-check) |
| 修改 | `build.sh` (末尾追加 stdout JSON 行) |

---

### Task 1: Schema v1000 SQL 文件

**Files:**
- 新建: `src/db/schema-v1000.sql`

- [ ] **Step 1: 写 schema-v1000.sql**

```sql
-- src/db/schema-v1000.sql
-- E2E 自动化测试模块 — 独立段位，永不与主干 v1..v999 撞号

CREATE TABLE e2e_target_projects (
  id                   TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  gitlab_repo          TEXT NOT NULL,
  default_branch       TEXT NOT NULL DEFAULT 'main',
  working_dir          TEXT NOT NULL DEFAULT '.',
  scripts              JSONB NOT NULL,
  capabilities         JSONB NOT NULL DEFAULT '{}',
  default_sandbox_kind TEXT NOT NULL DEFAULT 'docker-compose-local',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE e2e_specs (
  id                      BIGSERIAL PRIMARY KEY,
  target_project_id       TEXT NOT NULL REFERENCES e2e_target_projects(id),
  spec_path               TEXT NOT NULL,
  title                   TEXT NOT NULL,
  content_hash            TEXT NOT NULL,
  generated_artifact_path TEXT,
  generated_pr_url        TEXT,
  generation_status       TEXT NOT NULL DEFAULT 'pending',
  last_generated_at       TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_project_id, spec_path),
  CHECK (generation_status IN ('pending','generating','pr_open','committed','baseline_failed','blocked_on_baseline_bug','skipped'))
);

CREATE TABLE e2e_runs (
  id                BIGSERIAL PRIMARY KEY,
  target_project_id TEXT NOT NULL REFERENCES e2e_target_projects(id),
  trigger_type      TEXT NOT NULL,
  trigger_actor     TEXT,
  source_branch     TEXT NOT NULL,
  iteration_branch  TEXT NOT NULL,
  scenario_filter   JSONB,
  status            TEXT NOT NULL DEFAULT 'pending',
  governor_state    JSONB NOT NULL DEFAULT '{}',
  summary_mr_url    TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  abort_reason      TEXT,
  CHECK (status IN ('pending','running','awaiting_fix','passed','failed','aborted'))
);

CREATE INDEX idx_e2e_runs_status ON e2e_runs(status)
  WHERE status IN ('pending','running','awaiting_fix');
CREATE INDEX idx_e2e_runs_project ON e2e_runs(target_project_id, started_at DESC);

CREATE TABLE e2e_scenario_runs (
  id                   BIGSERIAL PRIMARY KEY,
  e2e_run_id           BIGINT NOT NULL REFERENCES e2e_runs(id) ON DELETE CASCADE,
  scenario_id          TEXT NOT NULL,
  scenario_name        TEXT,
  attempt_number       INT NOT NULL,
  result               TEXT NOT NULL,
  duration_ms          INT,
  evidence_manifest    JSONB,
  evidence_dir_uri     TEXT,
  linked_bug_report_id BIGINT REFERENCES bug_analysis_reports(id) ON DELETE SET NULL,
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ,
  UNIQUE (e2e_run_id, scenario_id, attempt_number),
  CHECK (result IN ('pass','fail','error','timeout','skipped','unfixable')),
  CHECK (evidence_manifest IS NULL OR length(evidence_manifest::text) < 32768)
);

CREATE INDEX idx_e2e_scenario_runs_run ON e2e_scenario_runs(e2e_run_id, scenario_id);
CREATE INDEX idx_e2e_scenario_runs_failed ON e2e_scenario_runs(e2e_run_id)
  WHERE result IN ('fail','error');

CREATE TABLE e2e_sandboxes (
  id           BIGSERIAL PRIMARY KEY,
  e2e_run_id   BIGINT REFERENCES e2e_runs(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,
  handle       JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'provisioning',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at     TIMESTAMPTZ,
  destroyed_at TIMESTAMPTZ,
  CHECK (status IN ('provisioning','ready','redeploying','torn_down','failed'))
);

CREATE INDEX idx_e2e_sandboxes_run ON e2e_sandboxes(e2e_run_id)
  WHERE status NOT IN ('torn_down','failed');

-- chatops dogfood 项目硬编码登记
INSERT INTO e2e_target_projects (id, display_name, gitlab_repo, default_branch, working_dir, scripts, capabilities) VALUES (
  'chatops',
  'ChatOps',
  'devops/chatops',
  'main',
  '.',
  '{"build":"build.sh","deploy":"deploy.sh","test":"test.sh"}',
  '{"testFramework":"playwright","sandboxKind":"docker-compose-local"}'
);

-- invoke_target_script 节点注册
INSERT INTO pipeline_node_types (key, display_name, description, param_schema, enabled)
VALUES (
  'invoke_target_script',
  '调用项目脚本',
  '调用被测项目的约定脚本（build/deploy/test/fix），按 stdout JSON + exit code 协议解析结果',
  '{"type":"object","properties":{"scriptPath":{"type":"string"},"args":{"type":"array","items":{"type":"string"}},"env":{"type":"object"},"timeoutSeconds":{"type":"number"},"workingDir":{"type":"string"}},"required":["scriptPath","args"]}',
  true
)
ON CONFLICT (key) DO UPDATE SET enabled = true;

-- 注意: internal_capability_pipelines 的 e2e_generate_script 映射不在本 schema 中插入。
-- Pipeline A 是 hardcoded LangGraph graph，不存储在 pipelines 表，没有 pipeline_id 可引用。
-- IM 触发路径（@bot 生成测试 ...）需要在 coordinator.ts 里单独加 dispatch，Phase 1 不实现。
-- UI 触发路径（POST /admin/e2e-specs/:id/generate）在 Plan 2 Task 9 中直接调用 runPipelineA()。

-- 断言：enabled node types ≥ 13
DO $$
DECLARE cnt INT;
BEGIN
  SELECT count(*) INTO cnt FROM pipeline_node_types WHERE enabled = true;
  IF cnt < 13 THEN
    RAISE EXCEPTION 'pipeline_node_types enabled count is %, expected >= 13', cnt;
  END IF;
END $$;
```

- [ ] **Step 2: 本地验证 SQL 能解析（语法检查）**

```bash
psql --set ON_ERROR_STOP=1 -c "$(cat src/db/schema-v1000.sql)" 2>&1 | head -20
# 预期：如果报 "relation does not exist" 是正常的（没有真实 DB 上下文），关键是无语法错误
# 直接跑 migrate 才能真正验证，见 Task 2
```

- [ ] **Step 3: Commit**

```bash
git add src/db/schema-v1000.sql
git commit -m "feat(e2e): schema-v1000 — 5张表 + chatops项目登记 + invoke_target_script节点"
```

---

### Task 2: 更新 migrate.ts 和测试 helper

**Files:**
- 修改: `src/db/migrate.ts`
- 修改: `src/__tests__/helpers/db.ts`

- [ ] **Step 1: 在 migrate.ts 的 SCHEMA_FILES 末尾追加 v1000**

找到：
```typescript
  ['v59', 'schema-v59.sql'],
] as const
```

改为：
```typescript
  ['v59', 'schema-v59.sql'],
  ['v1000', 'schema-v1000.sql'],
] as const
```

- [ ] **Step 2: 在 src/__tests__/helpers/db.ts 末尾追加 v1000**

找到：
```typescript
  'schema-v59.sql',
```

改为：
```typescript
  'schema-v59.sql',
  'schema-v1000.sql',
```

> 理由：v1000 全是新建表 + chatops 项目 INSERT，无种子数据污染，符合"全新表 + 非污染 catalog seed"标准。

- [ ] **Step 3: 本地跑 migrate 验证**

```bash
pnpm migrate 2>&1 | tail -5
# 预期最后一行: ✅ Database schema applied via _migrations tracker
```

- [ ] **Step 4: 跑测试验证 DB 初始化不爆**

```bash
npx vitest run src/__tests__/unit/ --reporter=verbose 2>&1 | tail -20
# 预期：现有 unit 测试全过（或 skip），不出现 "relation e2e_ does not exist"
```

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat(e2e): 注册 schema-v1000 到 migrate + test helper"
```

---

### Task 3: DB Repositories（5 张表）

**Files:**
- 新建: `src/db/repositories/e2e-target-projects.ts`
- 新建: `src/db/repositories/e2e-specs.ts`
- 新建: `src/db/repositories/e2e-runs.ts`
- 新建: `src/db/repositories/e2e-scenario-runs.ts`
- 新建: `src/db/repositories/e2e-sandboxes.ts`

- [ ] **Step 1: 写 e2e-target-projects.ts**

```typescript
// src/db/repositories/e2e-target-projects.ts
import { getPool } from '../client.js'

export interface E2eTargetProject {
  id: string
  displayName: string
  gitlabRepo: string
  defaultBranch: string
  workingDir: string
  scripts: { build: string; deploy: string; test: string; fix?: string }
  capabilities: Record<string, unknown>
  defaultSandboxKind: string
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): E2eTargetProject {
  return {
    id: r.id as string,
    displayName: r.display_name as string,
    gitlabRepo: r.gitlab_repo as string,
    defaultBranch: r.default_branch as string,
    workingDir: r.working_dir as string,
    scripts: r.scripts as E2eTargetProject['scripts'],
    capabilities: r.capabilities as Record<string, unknown>,
    defaultSandboxKind: r.default_sandbox_kind as string,
    createdAt: r.created_at as Date,
  }
}

export async function listE2eTargetProjects(): Promise<E2eTargetProject[]> {
  const { rows } = await getPool().query('SELECT * FROM e2e_target_projects ORDER BY id')
  return rows.map(mapRow)
}

export async function getE2eTargetProject(id: string): Promise<E2eTargetProject | null> {
  const { rows } = await getPool().query('SELECT * FROM e2e_target_projects WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 2: 写 e2e-specs.ts**

```typescript
// src/db/repositories/e2e-specs.ts
import { getPool } from '../client.js'

export type GenerationStatus =
  | 'pending' | 'generating' | 'pr_open' | 'committed'
  | 'baseline_failed' | 'blocked_on_baseline_bug' | 'skipped'

export interface E2eSpec {
  id: bigint
  targetProjectId: string
  specPath: string
  title: string
  contentHash: string
  generatedArtifactPath: string | null
  generatedPrUrl: string | null
  generationStatus: GenerationStatus
  lastGeneratedAt: Date | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): E2eSpec {
  return {
    id: r.id as bigint,
    targetProjectId: r.target_project_id as string,
    specPath: r.spec_path as string,
    title: r.title as string,
    contentHash: r.content_hash as string,
    generatedArtifactPath: r.generated_artifact_path as string | null,
    generatedPrUrl: r.generated_pr_url as string | null,
    generationStatus: r.generation_status as GenerationStatus,
    lastGeneratedAt: r.last_generated_at as Date | null,
    createdAt: r.created_at as Date,
  }
}

export async function listE2eSpecs(targetProjectId: string): Promise<E2eSpec[]> {
  const { rows } = await getPool().query(
    'SELECT * FROM e2e_specs WHERE target_project_id = $1 ORDER BY spec_path',
    [targetProjectId],
  )
  return rows.map(mapRow)
}

export async function getE2eSpec(id: bigint): Promise<E2eSpec | null> {
  const { rows } = await getPool().query('SELECT * FROM e2e_specs WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function upsertE2eSpec(
  data: Pick<E2eSpec, 'targetProjectId' | 'specPath' | 'title' | 'contentHash'>,
): Promise<E2eSpec> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_specs (target_project_id, spec_path, title, content_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (target_project_id, spec_path) DO UPDATE
       SET title = EXCLUDED.title, content_hash = EXCLUDED.content_hash
     RETURNING *`,
    [data.targetProjectId, data.specPath, data.title, data.contentHash],
  )
  return mapRow(rows[0])
}

export async function updateE2eSpecStatus(
  id: bigint,
  status: GenerationStatus,
  extra?: { generatedArtifactPath?: string; generatedPrUrl?: string; lastGeneratedAt?: Date },
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_specs SET
       generation_status = $2,
       generated_artifact_path = COALESCE($3, generated_artifact_path),
       generated_pr_url = COALESCE($4, generated_pr_url),
       last_generated_at = COALESCE($5, last_generated_at)
     WHERE id = $1`,
    [id, status, extra?.generatedArtifactPath ?? null, extra?.generatedPrUrl ?? null, extra?.lastGeneratedAt ?? null],
  )
}
```

- [ ] **Step 3: 写 e2e-runs.ts**

```typescript
// src/db/repositories/e2e-runs.ts
import { getPool } from '../client.js'

export type E2eRunStatus = 'pending' | 'running' | 'awaiting_fix' | 'passed' | 'failed' | 'aborted'

export interface E2eRun {
  id: bigint
  targetProjectId: string
  triggerType: string
  triggerActor: string | null
  sourceBranch: string
  iterationBranch: string
  scenarioFilter: Record<string, unknown> | null
  status: E2eRunStatus
  governorState: Record<string, unknown>
  summaryMrUrl: string | null
  startedAt: Date
  finishedAt: Date | null
  abortReason: string | null
}

function mapRow(r: Record<string, unknown>): E2eRun {
  return {
    id: r.id as bigint,
    targetProjectId: r.target_project_id as string,
    triggerType: r.trigger_type as string,
    triggerActor: r.trigger_actor as string | null,
    sourceBranch: r.source_branch as string,
    iterationBranch: r.iteration_branch as string,
    scenarioFilter: r.scenario_filter as Record<string, unknown> | null,
    status: r.status as E2eRunStatus,
    governorState: r.governor_state as Record<string, unknown>,
    summaryMrUrl: r.summary_mr_url as string | null,
    startedAt: r.started_at as Date,
    finishedAt: r.finished_at as Date | null,
    abortReason: r.abort_reason as string | null,
  }
}

export async function createE2eRun(
  data: Pick<E2eRun, 'targetProjectId' | 'triggerType' | 'triggerActor' | 'sourceBranch' | 'iterationBranch' | 'scenarioFilter'>,
): Promise<E2eRun> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_runs (target_project_id, trigger_type, trigger_actor, source_branch, iteration_branch, scenario_filter)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [data.targetProjectId, data.triggerType, data.triggerActor, data.sourceBranch, data.iterationBranch, data.scenarioFilter ? JSON.stringify(data.scenarioFilter) : null],
  )
  return mapRow(rows[0])
}

export async function getE2eRun(id: bigint): Promise<E2eRun | null> {
  const { rows } = await getPool().query('SELECT * FROM e2e_runs WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateE2eRunStatus(
  id: bigint,
  status: E2eRunStatus,
  extra?: { finishedAt?: Date; abortReason?: string; summaryMrUrl?: string; governorState?: Record<string, unknown> },
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_runs SET
       status = $2,
       finished_at = COALESCE($3, finished_at),
       abort_reason = COALESCE($4, abort_reason),
       summary_mr_url = COALESCE($5, summary_mr_url),
       governor_state = COALESCE($6::jsonb, governor_state)
     WHERE id = $1`,
    [id, status, extra?.finishedAt ?? null, extra?.abortReason ?? null, extra?.summaryMrUrl ?? null, extra?.governorState ? JSON.stringify(extra.governorState) : null],
  )
}

export async function listInflightE2eRuns(): Promise<E2eRun[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM e2e_runs WHERE status IN ('running','awaiting_fix') ORDER BY started_at`,
  )
  return rows.map(mapRow)
}
```

- [ ] **Step 4: 写 e2e-scenario-runs.ts**

```typescript
// src/db/repositories/e2e-scenario-runs.ts
import { getPool } from '../client.js'

export type ScenarioResult = 'pass' | 'fail' | 'error' | 'timeout' | 'skipped' | 'unfixable'

export interface E2eScenarioRun {
  id: bigint
  e2eRunId: bigint
  scenarioId: string
  scenarioName: string | null
  attemptNumber: number
  result: ScenarioResult
  durationMs: number | null
  evidenceManifest: Record<string, unknown> | null
  evidenceDirUri: string | null
  linkedBugReportId: bigint | null
  startedAt: Date
  finishedAt: Date | null
}

function mapRow(r: Record<string, unknown>): E2eScenarioRun {
  return {
    id: r.id as bigint,
    e2eRunId: r.e2e_run_id as bigint,
    scenarioId: r.scenario_id as string,
    scenarioName: r.scenario_name as string | null,
    attemptNumber: r.attempt_number as number,
    result: r.result as ScenarioResult,
    durationMs: r.duration_ms as number | null,
    evidenceManifest: r.evidence_manifest as Record<string, unknown> | null,
    evidenceDirUri: r.evidence_dir_uri as string | null,
    linkedBugReportId: r.linked_bug_report_id as bigint | null,
    startedAt: r.started_at as Date,
    finishedAt: r.finished_at as Date | null,
  }
}

export async function createScenarioRun(
  data: Pick<E2eScenarioRun, 'e2eRunId' | 'scenarioId' | 'scenarioName' | 'attemptNumber'>,
): Promise<E2eScenarioRun> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_scenario_runs (e2e_run_id, scenario_id, scenario_name, attempt_number, result, started_at)
     VALUES ($1, $2, $3, $4, 'error', NOW()) RETURNING *`,
    [data.e2eRunId, data.scenarioId, data.scenarioName, data.attemptNumber],
  )
  return mapRow(rows[0])
}

export async function finishScenarioRun(
  id: bigint,
  result: ScenarioResult,
  extra?: { durationMs?: number; evidenceManifest?: Record<string, unknown>; evidenceDirUri?: string },
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_scenario_runs SET
       result = $2, finished_at = NOW(),
       duration_ms = COALESCE($3, duration_ms),
       evidence_manifest = COALESCE($4::jsonb, evidence_manifest),
       evidence_dir_uri = COALESCE($5, evidence_dir_uri)
     WHERE id = $1`,
    [id, result, extra?.durationMs ?? null, extra?.evidenceManifest ? JSON.stringify(extra.evidenceManifest) : null, extra?.evidenceDirUri ?? null],
  )
}

export async function listScenarioRuns(e2eRunId: bigint): Promise<E2eScenarioRun[]> {
  const { rows } = await getPool().query(
    'SELECT * FROM e2e_scenario_runs WHERE e2e_run_id = $1 ORDER BY scenario_id, attempt_number',
    [e2eRunId],
  )
  return rows.map(mapRow)
}

export async function getLatestAttemptNumber(e2eRunId: bigint, scenarioId: string): Promise<number> {
  const { rows } = await getPool().query(
    'SELECT COALESCE(MAX(attempt_number), 0) AS n FROM e2e_scenario_runs WHERE e2e_run_id = $1 AND scenario_id = $2',
    [e2eRunId, scenarioId],
  )
  return rows[0].n as number
}
```

- [ ] **Step 5: 写 e2e-sandboxes.ts**

```typescript
// src/db/repositories/e2e-sandboxes.ts
import { getPool } from '../client.js'

export type SandboxStatus = 'provisioning' | 'ready' | 'redeploying' | 'torn_down' | 'failed'

export interface SandboxHandle {
  envId: string
  kind: string
  endpoints: Record<string, string>
  modules?: Array<{ name: string; host: string; port: number }>
  internalRefs?: Record<string, unknown>
}

export interface E2eSandbox {
  id: bigint
  e2eRunId: bigint | null
  kind: string
  handle: SandboxHandle
  status: SandboxStatus
  createdAt: Date
  readyAt: Date | null
  destroyedAt: Date | null
}

function mapRow(r: Record<string, unknown>): E2eSandbox {
  return {
    id: r.id as bigint,
    e2eRunId: r.e2e_run_id as bigint | null,
    kind: r.kind as string,
    handle: r.handle as SandboxHandle,
    status: r.status as SandboxStatus,
    createdAt: r.created_at as Date,
    readyAt: r.ready_at as Date | null,
    destroyedAt: r.destroyed_at as Date | null,
  }
}

export async function createSandbox(
  data: Pick<E2eSandbox, 'e2eRunId' | 'kind' | 'handle'>,
): Promise<E2eSandbox> {
  const { rows } = await getPool().query(
    `INSERT INTO e2e_sandboxes (e2e_run_id, kind, handle) VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [data.e2eRunId, data.kind, JSON.stringify(data.handle)],
  )
  return mapRow(rows[0])
}

export async function updateSandboxStatus(
  id: bigint,
  status: SandboxStatus,
  extra?: { readyAt?: Date; destroyedAt?: Date; handle?: SandboxHandle },
): Promise<void> {
  await getPool().query(
    `UPDATE e2e_sandboxes SET
       status = $2,
       ready_at = COALESCE($3, ready_at),
       destroyed_at = COALESCE($4, destroyed_at),
       handle = COALESCE($5::jsonb, handle)
     WHERE id = $1`,
    [id, status, extra?.readyAt ?? null, extra?.destroyedAt ?? null, extra?.handle ? JSON.stringify(extra.handle) : null],
  )
}

export async function getSandboxByRunId(e2eRunId: bigint): Promise<E2eSandbox | null> {
  const { rows } = await getPool().query(
    `SELECT * FROM e2e_sandboxes WHERE e2e_run_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [e2eRunId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 6: 跑集成测试验证 repo 能对新 DB 正常读写**

```bash
npx vitest run src/__tests__/integration/e2e-repos.test.ts --reporter=verbose
# 因为文件还不存在，先跳过，Task 3 Step 7 写
```

- [ ] **Step 7: 写 repo 集成测试**

新建 `src/__tests__/integration/e2e-repos.test.ts`：

```typescript
// src/__tests__/integration/e2e-repos.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { listE2eTargetProjects, getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { upsertE2eSpec, updateE2eSpecStatus, listE2eSpecs } from '../../db/repositories/e2e-specs.js'
import { createE2eRun, getE2eRun, updateE2eRunStatus } from '../../db/repositories/e2e-runs.js'
import { createScenarioRun, finishScenarioRun, getLatestAttemptNumber } from '../../db/repositories/e2e-scenario-runs.js'
import { createSandbox, updateSandboxStatus, getSandboxByRunId } from '../../db/repositories/e2e-sandboxes.js'

beforeEach(async () => { await resetTestDb() })

describe('e2e-target-projects repo', () => {
  it('chatops project is seeded', async () => {
    const projects = await listE2eTargetProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe('chatops')
    expect(projects[0].scripts.deploy).toBe('deploy.sh')
  })

  it('getE2eTargetProject returns null for unknown id', async () => {
    expect(await getE2eTargetProject('unknown')).toBeNull()
  })
})

describe('e2e-specs repo', () => {
  it('upsertE2eSpec creates and updates', async () => {
    const spec = await upsertE2eSpec({ targetProjectId: 'chatops', specPath: 'docs/test-specs/login.md', title: 'Login', contentHash: 'abc123' })
    expect(spec.generationStatus).toBe('pending')

    await updateE2eSpecStatus(spec.id, 'generating')
    const all = await listE2eSpecs('chatops')
    expect(all[0].generationStatus).toBe('generating')
  })
})

describe('e2e-runs + scenario-runs repo', () => {
  it('creates run and scenario run, updates status', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'manual', triggerActor: 'test', sourceBranch: 'main', iterationBranch: 'test-iter/1', scenarioFilter: null })
    expect(run.status).toBe('pending')

    await updateE2eRunStatus(run.id, 'running')
    const fetched = await getE2eRun(run.id)
    expect(fetched?.status).toBe('running')

    const sr = await createScenarioRun({ e2eRunId: run.id, scenarioId: 'login-success', scenarioName: 'Login success', attemptNumber: 1 })
    await finishScenarioRun(sr.id, 'pass', { durationMs: 1500 })

    const nextAttempt = await getLatestAttemptNumber(run.id, 'login-success')
    expect(nextAttempt).toBe(1)
  })
})

describe('e2e-sandboxes repo', () => {
  it('creates sandbox and updates status', async () => {
    const run = await createE2eRun({ targetProjectId: 'chatops', triggerType: 'test', triggerActor: null, sourceBranch: 'main', iterationBranch: 'test-iter/2', scenarioFilter: null })
    const sandbox = await createSandbox({ e2eRunId: run.id, kind: 'docker-compose-local', handle: { envId: 'e2e-42', kind: 'docker-compose-local', endpoints: { api: 'http://localhost:13001' } } })
    expect(sandbox.status).toBe('provisioning')

    await updateSandboxStatus(sandbox.id, 'ready', { readyAt: new Date() })
    const fetched = await getSandboxByRunId(run.id)
    expect(fetched?.status).toBe('ready')
  })
})
```

- [ ] **Step 8: 跑集成测试**

```bash
npx vitest run src/__tests__/integration/e2e-repos.test.ts --reporter=verbose
# 预期：4 describe 全 pass
```

- [ ] **Step 9: Commit**

```bash
git add src/db/repositories/e2e-*.ts src/__tests__/integration/e2e-repos.test.ts
git commit -m "feat(e2e): 5张表的 DB repositories + 集成测试"
```

---

### Task 4: invoke_target_script 节点

**Files:**
- 新建: `src/pipeline/node-types/invoke-target-script.ts`
- 新建: `src/__tests__/unit/invoke-target-script.test.ts`
- 修改: `src/pipeline/node-types/index.ts`

- [ ] **Step 1: 写节点失败测试**

新建 `src/__tests__/unit/invoke-target-script.test.ts`：

```typescript
// src/__tests__/unit/invoke-target-script.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type ChildProcess, type SpawnOptionsWithoutStdio } from 'child_process'
import { EventEmitter } from 'events'

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'
import { getExecutor, __resetRegistryForTesting } from '../../pipeline/node-types/registry.js'

// 导入节点以触发 registerNodeType
import '../../pipeline/node-types/invoke-target-script.js'

function makeSpawnMock(stdout: string, exitCode: number) {
  const proc = new EventEmitter() as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  vi.mocked(spawn).mockReturnValueOnce(proc as unknown as ChildProcess)
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from(stdout))
    proc.emit('close', exitCode)
  })
  return proc
}

const baseCtx = { runId: 1, pipelineId: 1, nodeId: 'test', triggerParams: {}, vars: {}, steps: {} }

describe('invoke_target_script node', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('exit 0 + valid JSON last line → success', async () => {
    makeSpawnMock('some output\n{"artifact":"chatops:v1","kind":"docker-image"}', 0)
    const executor = getExecutor('invoke_target_script')!
    const result = await executor.execute({ scriptPath: '/app/build.sh', args: [] }, baseCtx)
    expect(result.status).toBe('success')
    expect(result.output.parsed).toEqual({ artifact: 'chatops:v1', kind: 'docker-image' })
    expect(result.output.exitCode).toBe(0)
  })

  it('exit 1 → failed', async () => {
    makeSpawnMock('error occurred\n', 1)
    const executor = getExecutor('invoke_target_script')!
    const result = await executor.execute({ scriptPath: '/app/deploy.sh', args: ['provision'] }, baseCtx)
    expect(result.status).toBe('failed')
    expect(result.output.exitCode).toBe(1)
  })

  it('exit 0 but no JSON last line → success with parsed=null', async () => {
    makeSpawnMock('just text output\n', 0)
    const executor = getExecutor('invoke_target_script')!
    const result = await executor.execute({ scriptPath: '/app/test.sh', args: ['--discover'] }, baseCtx)
    expect(result.status).toBe('success')
    expect(result.output.parsed).toBeNull()
  })

  it('missing scriptPath → failed', async () => {
    const executor = getExecutor('invoke_target_script')!
    const result = await executor.execute({ args: [] }, baseCtx)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('scriptPath')
  })

  it('passes env vars to spawn', async () => {
    makeSpawnMock('{"ok":true}', 0)
    const executor = getExecutor('invoke_target_script')!
    await executor.execute(
      { scriptPath: '/app/deploy.sh', args: ['provision'], env: { DATABASE_URL: 'postgres://sandbox/db' } },
      baseCtx,
    )
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      '/app/deploy.sh',
      ['provision'],
      expect.objectContaining({ env: expect.objectContaining({ DATABASE_URL: 'postgres://sandbox/db' }) }),
    )
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/__tests__/unit/invoke-target-script.test.ts --reporter=verbose
# 预期: FAIL — "invoke_target_script" executor not found
```

- [ ] **Step 3: 实现 invoke_target_script 节点**

新建 `src/pipeline/node-types/invoke-target-script.ts`：

```typescript
// src/pipeline/node-types/invoke-target-script.ts
import { spawn } from 'child_process'
import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'

registerNodeType({
  key: 'invoke_target_script',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const scriptPath = params.scriptPath as string | undefined
    if (!scriptPath) {
      return { status: 'failed', output: {}, error: 'invoke_target_script: scriptPath is required' }
    }
    const args = (params.args as string[]) ?? []
    const env = params.env as Record<string, string> | undefined
    const timeoutSeconds = (params.timeoutSeconds as number | undefined) ?? 300
    const workingDir = params.workingDir as string | undefined

    return new Promise((resolve) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let timedOut = false

      const child = spawn(scriptPath, args, {
        env: { ...process.env, ...env },
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutSeconds * 1000)

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

      child.on('close', (code) => {
        clearTimeout(timer)
        const stdoutStr = Buffer.concat(stdout).toString('utf8')
        const stderrStr = Buffer.concat(stderr).toString('utf8')
        const exitCode = timedOut ? -2 : (code ?? -1)

        const parsed = parseLastJsonLine(stdoutStr)

        if (exitCode !== 0) {
          return resolve({
            status: 'failed',
            output: { exitCode, stdout: stdoutStr, stderr: stderrStr, parsed },
            error: timedOut
              ? `Script timed out after ${timeoutSeconds}s`
              : `Script exited with code ${exitCode}`,
          })
        }
        resolve({ status: 'success', output: { exitCode: 0, stdout: stdoutStr, stderr: stderrStr, parsed } })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ status: 'failed', output: { exitCode: -1, stdout: '', stderr: err.message, parsed: null }, error: err.message })
      })
    })
  },
})

function parseLastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{')) {
      try { return JSON.parse(line) } catch { /* skip */ }
    }
  }
  return null
}
```

- [ ] **Step 4: 在 index.ts 添加 import**

找 `src/pipeline/node-types/index.ts`，在现有 import 列表末尾加：

```typescript
import './invoke-target-script.js'
```

- [ ] **Step 5: 运行测试，确认全过**

```bash
npx vitest run src/__tests__/unit/invoke-target-script.test.ts --reporter=verbose
# 预期: 5 tests PASS
```

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/node-types/invoke-target-script.ts src/pipeline/node-types/index.ts src/__tests__/unit/invoke-target-script.test.ts
git commit -m "feat(e2e): invoke_target_script 节点 — 本地子进程 + stdout JSON 解析"
```

---

### Task 5: claude-runner dockerExec 选项

**Files:**
- 修改: `src/agent/claude-runner.ts`
- 新建: `src/__tests__/unit/claude-runner-docker-exec.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `src/__tests__/unit/claude-runner-docker-exec.test.ts`：

```typescript
// src/__tests__/unit/claude-runner-docker-exec.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildDockerExecClaudeArgs } from '../../agent/claude-runner.js'

describe('buildDockerExecClaudeArgs', () => {
  it('无 dockerExec → 原样返回', () => {
    const args = buildDockerExecClaudeArgs(['--print', '--model', 'claude-3'], undefined)
    expect(args).toEqual({ bin: 'claude', args: ['--print', '--model', 'claude-3'] })
  })

  it('有 dockerExec → 包 docker exec 前缀', () => {
    const result = buildDockerExecClaudeArgs(['--print', 'hello'], { containerId: 'chatops-sandbox-42' })
    expect(result).toEqual({
      bin: 'docker',
      args: ['exec', '-i', 'chatops-sandbox-42', 'claude', '--print', 'hello'],
    })
  })

  it('有 dockerExec + user → 包含 --user 选项', () => {
    const result = buildDockerExecClaudeArgs(['--print'], { containerId: 'sandbox-1', user: 'node' })
    expect(result).toEqual({
      bin: 'docker',
      args: ['exec', '-i', '--user', 'node', 'sandbox-1', 'claude', '--print'],
    })
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/__tests__/unit/claude-runner-docker-exec.test.ts --reporter=verbose
# 预期: FAIL — buildDockerExecClaudeArgs is not exported
```

- [ ] **Step 3: 在 claude-runner.ts 中实现并导出 buildDockerExecClaudeArgs**

在 `src/agent/claude-runner.ts` 顶部 exports 区域（或 class 定义之前）添加：

```typescript
export interface DockerExecOptions {
  containerId: string
  user?: string
}

export function buildDockerExecClaudeArgs(
  claudeArgs: string[],
  dockerExec: DockerExecOptions | undefined,
): { bin: string; args: string[] } {
  if (!dockerExec) return { bin: 'claude', args: claudeArgs }
  const dockerArgs = ['exec', '-i']
  if (dockerExec.user) dockerArgs.push('--user', dockerExec.user)
  dockerArgs.push(dockerExec.containerId, 'claude', ...claudeArgs)
  return { bin: 'docker', args: dockerArgs }
}
```

然后在 `executeCapabilityDirect` 函数签名里增加可选参数（找到函数定义并扩展 opts 接口）：

```typescript
// 在 executeCapabilityDirect 的 opts 类型里加
dockerExec?: DockerExecOptions
```

并在 Porygon 调用处使用 `buildDockerExecClaudeArgs` 构建 claude 命令：

```typescript
// 找到 Porygon 实例化或 query 的地方，加入 bin/args 覆盖
const { bin: claudeBin, args: claudePrefixArgs } = buildDockerExecClaudeArgs([], opts.dockerExec)
// 根据 Porygon API 将 claudeBin 传入
// 如果 Porygon 不支持自定义 bin，创建临时 wrapper 脚本（见下方备注）
```

> **备注**：如果 `@snack-kit/porygon` 不支持自定义 claude 二进制路径，用临时 wrapper 脚本方案：
> ```typescript
> import { writeFileSync, chmodSync } from 'fs'
> import { tmpdir } from 'os'
> import { join } from 'path'
> // 在 executeCapabilityDirect 开始时：
> let claudeBin = 'claude'
> if (opts.dockerExec) {
>   const wrapper = join(tmpdir(), `claude-docker-exec-${opts.dockerExec.containerId.replace(/[^a-z0-9]/g,'-')}.sh`)
>   writeFileSync(wrapper, `#!/bin/sh\nexec docker exec -i ${opts.dockerExec.user ? `--user ${opts.dockerExec.user} ` : ''}${opts.dockerExec.containerId} claude "$@"\n`)
>   chmodSync(wrapper, 0o755)
>   claudeBin = wrapper
> }
> ```

- [ ] **Step 4: 运行测试，确认全过**

```bash
npx vitest run src/__tests__/unit/claude-runner-docker-exec.test.ts --reporter=verbose
# 预期: 3 tests PASS
```

- [ ] **Step 5: 手工验证 dockerExec（需要有运行中的容器）**

```bash
# 启一个 alpine 容器用于验证（不依赖真实 chatops 沙盒）
docker run -d --name e2e-test-alpine alpine:3 sleep 600

# 手工测试 docker exec + claude（假设宿主有 claude CLI）
docker exec -i e2e-test-alpine echo "docker exec works"
# 预期: docker exec works

docker stop e2e-test-alpine && docker rm e2e-test-alpine
```

- [ ] **Step 6: Commit**

```bash
git add src/agent/claude-runner.ts src/__tests__/unit/claude-runner-docker-exec.test.ts
git commit -m "feat(e2e): claude-runner dockerExec 选项 — 支持在容器内跑 Claude CLI"
```

---

### Task 6: deploy.sh 新增沙盒子命令

**Files:**
- 修改: `deploy.sh`

- [ ] **Step 1: 备份理解现有 case 结构**

```bash
grep -n "case\|esac\|\*)" deploy.sh
# 确认结构：case "$ACTION" in ... esac
```

- [ ] **Step 2: 将现有的 `*) echo "Usage: ..." ;;` 替换为新子命令 + 扩展 Usage**

找到 `deploy.sh` 末尾的：
```bash
  *)
    echo "Usage: $0 {up|down|restart|logs|migrate|status}"
    exit 1
    ;;
esac
```

替换为：

```bash
  provision)
    BRANCH="${2#--branch=}"
    OUT_HANDLE="${3#--out-handle=}"
    if [ -z "$BRANCH" ] || [ -z "$OUT_HANDLE" ]; then
      echo "Usage: $0 provision --branch=<branch> --out-handle=<file>" >&2; exit 1
    fi
    RUN_ID="${E2E_RUN_ID:-$(date +%s)}"
    SANDBOX_NET="chatops-e2e-sandbox-${RUN_ID}"
    # 动态端口分配：找一个 13000+ 的空闲端口
    API_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
    echo "==> Provisioning sandbox network: ${SANDBOX_NET}, port: ${API_PORT}"
    docker network create "${SANDBOX_NET}" 2>/dev/null || true
    # 写 handle JSON
    cat > "${OUT_HANDLE}" <<EOF
{
  "envId": "test-iter-${RUN_ID}",
  "kind": "docker-compose-local",
  "endpoints": { "api": "http://localhost:${API_PORT}" },
  "modules": [],
  "internalRefs": { "network": "${SANDBOX_NET}", "apiPort": ${API_PORT}, "runId": "${RUN_ID}" }
}
EOF
    echo "==> Sandbox provisioned. Handle: ${OUT_HANDLE}"
    ;;

  teardown)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "teardown: --handle file not found: $HANDLE" >&2; exit 1
    fi
    SANDBOX_NET=$(python3 -c "import json,sys; d=json.load(open('$HANDLE')); print(d['internalRefs']['network'])")
    echo "==> Tearing down sandbox network: ${SANDBOX_NET}"
    # 停止并移除沙盒容器
    docker ps -a --filter "network=${SANDBOX_NET}" --format "{{.ID}}" | xargs -r docker rm -f
    docker network rm "${SANDBOX_NET}" 2>/dev/null || true
    echo "==> Teardown complete."
    ;;

  healthcheck)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "healthcheck: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(python3 -c "import json,sys; d=json.load(open('$HANDLE')); print(d['internalRefs']['apiPort'])")
    echo "==> Healthcheck on port ${API_PORT}..."
    for i in $(seq 1 30); do
      if curl -sf "http://localhost:${API_PORT}/health" > /dev/null 2>&1; then
        echo "==> Healthy."; exit 0
      fi
      sleep 2
    done
    echo "==> Healthcheck failed after 60s" >&2; exit 1
    ;;

  deploy)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "deploy: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(python3 -c "import json,sys; d=json.load(open('$HANDLE')); print(d['internalRefs']['apiPort'])")
    SANDBOX_NET=$(python3 -c "import json,sys; d=json.load(open('$HANDLE')); print(d['internalRefs']['network'])")
    echo "==> Deploying into sandbox (port ${API_PORT}, net ${SANDBOX_NET})..."
    E2E_SANDBOX_MODE=true \
    PORT="${API_PORT}" \
    DOCKER_NETWORK="${SANDBOX_NET}" \
    DATABASE_URL="${E2E_SANDBOX_DB_URL:-$DATABASE_URL}" \
    docker compose -p "e2e-${API_PORT}" up -d --build chatops
    echo "{\"deployedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"modules\":[\"chatops\"]}"
    ;;

  redeploy)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "redeploy: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(python3 -c "import json,sys; d=json.load(open('$HANDLE')); print(d['internalRefs']['apiPort'])")
    echo "==> Redeploying sandbox (port ${API_PORT})..."
    E2E_SANDBOX_MODE=true PORT="${API_PORT}" docker compose -p "e2e-${API_PORT}" restart chatops
    echo "{\"redeployedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    ;;

  *)
    echo "Usage: $0 {up|down|restart|logs|migrate|status|provision|teardown|healthcheck|deploy|redeploy}"
    exit 1
    ;;
esac
```

- [ ] **Step 3: 手工测试 provision + teardown**

```bash
E2E_RUN_ID=test999 ./deploy.sh provision --branch=main --out-handle=/tmp/e2e-handle.json
cat /tmp/e2e-handle.json
# 预期: JSON 含 envId, endpoints.api, internalRefs.network, internalRefs.apiPort

./deploy.sh teardown --handle=/tmp/e2e-handle.json
# 预期: "Teardown complete."
```

- [ ] **Step 4: Commit**

```bash
git add deploy.sh
git commit -m "feat(e2e): deploy.sh 新增 provision/teardown/healthcheck/deploy/redeploy 子命令"
```

---

### Task 7: test.sh 新增 --discover / --scenario / --static-check

**Files:**
- 修改: `test.sh`

- [ ] **Step 1: 在 while 参数解析 loop 中添加新 flag**

找到 test.sh 里的 `while [[ $# -gt 0 ]]; do` 块，在 `--rounds)` 之后、`-h|--help)` 之前插入：

```bash
        --discover)  ACTION="discover"; shift ;;
        --static-check) ACTION="static-check"; shift ;;
        --scenario)  ACTION="scenario"; SCENARIO_ID="$2"; shift 2 ;;
        --evidence-dir) EVIDENCE_DIR="$2"; shift 2 ;;
        --format)    FORMAT="$2"; shift 2 ;;
```

在 flag 变量初始化区域（`ACTION="run"` 那几行下面）加：

```bash
SCENARIO_ID=""
EVIDENCE_DIR=""
FORMAT="text"
```

- [ ] **Step 2: 在 case "$ACTION" 分发（或末尾）加新 action**

找到 `test.sh` 里处理 ACTION 的地方（通常是一大段 if/case 或直接跑 vitest）。在正式跑测试逻辑之前加 guard：

```bash
# === e2e 新增 action ===
if [[ "$ACTION" == "discover" ]]; then
  # 扫 tests/e2e/ 目录，收集所有 .spec.ts 的 test() 名称
  SCENARIOS=()
  while IFS= read -r line; do
    # 从 "test('login-success', ..." 提取 id
    id=$(echo "$line" | sed "s/.*test[[:space:]]*('[[:space:]]*//" | sed "s/'[[:space:]]*,.*//" | tr -d ' ')
    [[ -n "$id" ]] && SCENARIOS+=("{\"id\":\"$id\",\"name\":\"$id\",\"tags\":[]}")
  done < <(grep -rh "^test(" tests/e2e/ 2>/dev/null || true)
  JSON_SCENARIOS=$(IFS=,; echo "[${SCENARIOS[*]}]")
  echo "{\"scenarios\":${JSON_SCENARIOS}}"
  exit 0
fi

if [[ "$ACTION" == "static-check" ]]; then
  echo "==> Running static check (tsc --noEmit)..."
  cd web && npx tsc --noEmit && cd ..
  npx tsc --noEmit
  echo "==> Static check passed."
  exit 0
fi

if [[ "$ACTION" == "scenario" ]]; then
  if [[ -z "$SCENARIO_ID" ]]; then
    fail "--scenario requires a scenario ID"; exit 1
  fi
  EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/e2e-evidence}"
  mkdir -p "${EVIDENCE_DIR}/${SCENARIO_ID}/artifacts"
  echo "==> Running scenario: $SCENARIO_ID (evidence → ${EVIDENCE_DIR}/${SCENARIO_ID})"
  START_MS=$(($(date +%s%N) / 1000000))

  # 跑 Playwright 单个 spec（按 grep title 过滤）
  set +e
  npx playwright test --grep "$SCENARIO_ID" --reporter=json 2>&1 | tee "${EVIDENCE_DIR}/${SCENARIO_ID}/playwright-output.txt"
  PW_EXIT=$?
  set -e

  END_MS=$(($(date +%s%N) / 1000000))
  DURATION=$((END_MS - START_MS))
  RESULT="pass"
  [[ $PW_EXIT -ne 0 ]] && RESULT="fail"

  # 生成 manifest.json
  cat > "${EVIDENCE_DIR}/${SCENARIO_ID}/manifest.json" <<EOF
{
  "summary": "Playwright scenario: ${SCENARIO_ID}, result: ${RESULT}",
  "contextHint": "Playwright E2E，查看 playwright-output.txt 和截图",
  "artifacts": [
    {"kind":"log","mimeType":"text/plain","path":"artifacts/playwright-output.txt","description":"Playwright 输出"}
  ]
}
EOF
  cp "${EVIDENCE_DIR}/${SCENARIO_ID}/playwright-output.txt" "${EVIDENCE_DIR}/${SCENARIO_ID}/artifacts/" 2>/dev/null || true

  echo "{\"result\":\"${RESULT}\",\"summary\":\"scenario ${SCENARIO_ID}: ${RESULT}\",\"duration_ms\":${DURATION}}"
  exit $PW_EXIT
fi
```

- [ ] **Step 3: 手工测试 --discover**

```bash
./test.sh --discover
# 预期: {"scenarios":[...]} — 如果 tests/e2e/ 目录不存在则 {"scenarios":[]}
```

- [ ] **Step 4: 手工测试 --static-check**

```bash
./test.sh --static-check
# 预期: tsc 不报错时 "Static check passed."
```

- [ ] **Step 5: Commit**

```bash
git add test.sh
git commit -m "feat(e2e): test.sh 新增 --discover / --scenario / --static-check flag"
```

---

### Task 8: build.sh 末尾追加 stdout JSON

**Files:**
- 修改: `build.sh`

- [ ] **Step 1: 在 build.sh 末尾 echo Size 行之后追加 JSON**

找到 `build.sh` 末尾：
```bash
echo "==> Build complete: ${IMAGE_NAME}:${IMAGE_TAG}"
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "Size: {{.Size}}"
```

改为：
```bash
echo "==> Build complete: ${IMAGE_NAME}:${IMAGE_TAG}"
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "Size: {{.Size}}"
echo "{\"artifact\":\"${IMAGE_NAME}:${IMAGE_TAG}\",\"kind\":\"docker-image\"}"
```

- [ ] **Step 2: 手工验证**

```bash
IMAGE_NAME=chatops IMAGE_TAG=e2e-test BASE_IMAGE=chatops-base:local ./build.sh 2>&1 | tail -3
# 预期最后一行: {"artifact":"chatops:e2e-test","kind":"docker-image"}
```

> 注意：如果 build 环境没有 BASE_IMAGE 会失败，直接 grep 最后一行检查 echo 语句即可：
> ```bash
> tail -1 build.sh
> # 预期: echo "{\"artifact\":\"${IMAGE_NAME}:${IMAGE_TAG}\",\"kind\":\"docker-image\"}"
> ```

- [ ] **Step 3: Commit**

```bash
git add build.sh
git commit -m "feat(e2e): build.sh 末尾追加 stdout JSON ({artifact, kind})"
```

---

### Task 9: 沙盒启动 Sentinel 校验

**Files:**
- 新建: `src/e2e/sandbox-sentinel.ts`
- 新建: `src/__tests__/unit/sandbox-sentinel.test.ts`
- 修改: `src/server.ts` (在 migrate 前调用 sentinel)

- [ ] **Step 1: 写失败测试**

新建 `src/__tests__/unit/sandbox-sentinel.test.ts`：

```typescript
// src/__tests__/unit/sandbox-sentinel.test.ts
import { describe, it, expect, vi } from 'vitest'

// 给 getPool 打桩
vi.mock('../../db/client.js', () => ({
  getPool: vi.fn(),
}))

import { getPool } from '../../db/client.js'
import { verifySandboxSafety } from '../../e2e/sandbox-sentinel.js'

function mockPool(dbName: string) {
  vi.mocked(getPool).mockReturnValue({
    query: vi.fn().mockResolvedValue({ rows: [{ current_database: dbName }] }),
  } as unknown as ReturnType<typeof getPool>)
}

describe('verifySandboxSafety', () => {
  it('非沙盒模式 → 直接返回（不查 DB）', async () => {
    delete process.env.E2E_SANDBOX_MODE
    await expect(verifySandboxSafety()).resolves.toBeUndefined()
    expect(getPool).not.toHaveBeenCalled()
  })

  it('沙盒模式 + DB 名以 sandbox- 开头 → 通过', async () => {
    process.env.E2E_SANDBOX_MODE = 'true'
    mockPool('sandbox-pg-test-iter-42')
    await expect(verifySandboxSafety()).resolves.toBeUndefined()
    delete process.env.E2E_SANDBOX_MODE
  })

  it('沙盒模式 + DB 名是生产库名 → 抛错', async () => {
    process.env.E2E_SANDBOX_MODE = 'true'
    mockPool('chatops_production')
    await expect(verifySandboxSafety()).rejects.toThrow('sandbox safety check failed')
    delete process.env.E2E_SANDBOX_MODE
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/__tests__/unit/sandbox-sentinel.test.ts --reporter=verbose
# 预期: FAIL — verifySandboxSafety not found
```

- [ ] **Step 3: 实现 sandbox-sentinel.ts**

```typescript
// src/e2e/sandbox-sentinel.ts
import { getPool } from '../db/client.js'

const SAFE_DB_PREFIXES = ['sandbox-', 'e2e-', 'test-']

export async function verifySandboxSafety(): Promise<void> {
  if (process.env.E2E_SANDBOX_MODE !== 'true') return

  const { rows } = await getPool().query('SELECT current_database()')
  const dbName: string = rows[0].current_database

  const isSafe = SAFE_DB_PREFIXES.some((prefix) => dbName.startsWith(prefix))
  if (!isSafe) {
    throw new Error(
      `sandbox safety check failed: current_database()="${dbName}" does not start with any of [${SAFE_DB_PREFIXES.join(', ')}]. ` +
        'Refusing to start sandbox chatops connected to a non-sandbox database.',
    )
  }
  console.log(`[SandboxSentinel] DB safe: ${dbName}`)
}
```

- [ ] **Step 4: 在 server.ts 启动时调用 sentinel**

在 `src/server.ts` 中找到 server 启动逻辑（`server.listen` 或 `app.listen` 之前），加：

```typescript
import { verifySandboxSafety } from './e2e/sandbox-sentinel.js'

// 在 server 启动前（migrate 之前或 startup 钩子）
await verifySandboxSafety()
```

- [ ] **Step 5: 运行测试**

```bash
npx vitest run src/__tests__/unit/sandbox-sentinel.test.ts --reporter=verbose
# 预期: 3 tests PASS
```

- [ ] **Step 6: Commit**

```bash
git add src/e2e/sandbox-sentinel.ts src/__tests__/unit/sandbox-sentinel.test.ts src/server.ts
git commit -m "feat(e2e): sandbox sentinel — 沙盒启动时校验 current_database() 防误连生产库"
```

---

## 验收标准

- [ ] `pnpm migrate` 运行无误，`pipeline_node_types` enabled ≥ 13 断言通过
- [ ] `npx vitest run src/__tests__/unit/invoke-target-script.test.ts` → 5 PASS
- [ ] `npx vitest run src/__tests__/unit/sandbox-sentinel.test.ts` → 3 PASS
- [ ] `npx vitest run src/__tests__/unit/claude-runner-docker-exec.test.ts` → 3 PASS
- [ ] `npx vitest run src/__tests__/integration/e2e-repos.test.ts` → 4 describe 全 PASS
- [ ] `./deploy.sh provision --branch=main --out-handle=/tmp/h.json && ./deploy.sh teardown --handle=/tmp/h.json` 手工跑通
- [ ] `./test.sh --discover` 返回有效 JSON
- [ ] `./test.sh --static-check` tsc 不报错
- [ ] `build.sh` 最后一行是 stdout JSON echo
