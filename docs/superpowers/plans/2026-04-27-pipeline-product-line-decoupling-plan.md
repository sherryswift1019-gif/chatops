# Pipeline 跟产线解绑实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `test_pipelines` 跟产线解绑，让多产线复用同条 pipeline；新增 `pipeline_bindings` 关联表表达「产线 × ref_key → pipeline + server 分配」；scheduler 模块整体删除。

**Architecture:** test_pipelines 退化为全局 pipeline 池（仅 graph/variables/triggerParams）；产线维度的 server 分配迁到 pipeline_bindings.server_role_assignments JSONB；coordinator/executor 触发链路从「pipeline.productLineId 查 server」改为「binding 提供 server id 列表 hydrate」。

**Tech Stack:** PostgreSQL 16 / Node.js TypeScript / Fastify / pg / Vitest / React 18 / Ant Design 5

**Spec:** `docs/superpowers/specs/2026-04-27-pipeline-product-line-decoupling-design.md`

**Baseline (写 plan 时)：**
- main HEAD = `f55505c` (含 phase 4 + spec commit)
- pnpm test: 1089 pass / 6 fail (dingtalk-sync) / 10 todo / typecheck 干净 / web build 干净
- 主 working tree dirty: src/db/migrate.ts modified + schema-v38/v39 untracked + .DS_Store（用户独立线，不影响本 plan）

**约束：**
- 阶段 1-3 必须各自独立 ship，每段后 baseline 不增 fail
- 阶段 4 推迟到生产稳定 1 周后再做（本 plan 含但标 deferred）
- 不动 `internal_capability_pipelines` 表（phase 4 ship）
- 不破坏老 pipeline（pipeline.serverRoles 非空 + binding 入参为空 → fallback 老逻辑）

---

## File Structure（决策 locked）

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/db/schema-v42.sql` | 创建 | pipeline_bindings 表 + test_pipelines 字段改 + 老数据迁移 + DROP schedule |
| `src/db/migrate.ts` | 修改 | SCHEMA_FILES 追加 v42 |
| `src/__tests__/helpers/db.ts` | 修改 | SCHEMA_FILES 追加 v42 |
| `src/db/repositories/pipeline-bindings.ts` | 创建 | CRUD + resolvePipelineForTrigger |
| `src/db/repositories/test-pipelines.ts` | 修改 | 删 schedule 列处理 |
| `src/__tests__/unit/pipeline-bindings.test.ts` | 创建 | repository unit test |
| `src/__tests__/integration/schema-v42-migration.test.ts` | 创建 | 老数据迁移 + server_roles count → ids 转换 |
| `src/agent/coordinator.ts` | 修改 | findPipelineByLevel → resolvePipelineForTrigger；删 PIPELINE_NAMES |
| `src/pipeline/executor.ts` | 修改 | runPipeline 入参 + hydrateServerAssignments |
| `src/pipeline/scheduler.ts` | 删除 | 整个文件 |
| `src/server.ts` | 修改 | 删 scheduler 启动代码 |
| `src/admin/routes/pipeline-bindings.ts` | 创建 | CRUD 端点 |
| `src/admin/routes/test-pipelines.ts` | 修改 | 删 schedule 参数；productLineId/serverRoles 改可选 |
| `src/admin/index.ts` | 修改 | 注册 pipeline-bindings 路由 |
| `src/__tests__/integration/pipeline-decoupling.test.ts` | 创建 | bugfix L1/L2/L3 触发 + 跨产线复用 + 老 fallback |
| `web/src/api/pipeline-bindings.ts` | 创建 | API client |
| `web/src/pages/TestPipelinesPage.tsx` | 修改 | 删产线/server_roles/schedule 相关 UI |
| `web/src/pages/ProductLineDetailPage.tsx` | 修改 | 加 Pipeline 绑定 Tab |
| `web/src/components/PipelineBindingForm.tsx` | 创建 | binding 编辑表单（含 Server 分配控件） |
| `docs/smoke-pipeline-decoupling.md` | 创建 | 冒烟手册 |

---

## Task 0: 冒烟手册起步（先写好供后续阶段对照）

**Files:**
- Create: `docs/smoke-pipeline-decoupling.md`

- [ ] **Step 1: 写冒烟手册骨架**

```markdown
# 冒烟：pipeline 跟产线解绑

把 test_pipelines 退化为全局池，多产线通过 pipeline_bindings 引用同条 pipeline。

## 前置
- 数据库已 migrate 到 v42 (`pnpm migrate`)
- pipeline_bindings 表存在且每条 (product_line_id 非空) 老 pipeline 都有自动迁移的 binding 记录

## 场景 1：bugfix L1/L2/L3 走 binding 路径
[实施完阶段 2 后填]

## 场景 2：跨产线复用同条 pipeline
[实施完阶段 2 后填]

## 场景 3：老 pipeline 兼容
[实施完阶段 2 后填]

## 场景 4：前端 binding CRUD
[实施完阶段 3 后填]

## 已知差异
- KD-1: server_roles count → server id 自动转换在迁移时刻锚定，扩缩容后需手动 update
- KD-2: scheduler 删除后老 pipeline 的 schedule 字段失效（已 DROP）

## 回滚
- 阶段 1 回滚：`DROP TABLE pipeline_bindings; ALTER TABLE test_pipelines ADD COLUMN schedule TEXT...`
- 阶段 2 回滚：revert coordinator/executor 代码
- 阶段 3 回滚：revert 前端代码
```

写到 `docs/smoke-pipeline-decoupling.md`。

- [ ] **Step 2: commit**

```bash
git add docs/smoke-pipeline-decoupling.md
git commit -m "docs(smoke): pipeline 解绑冒烟手册骨架"
```

---

## 阶段 1：schema-v42 + repository

### Task 1.1: schema-v42.sql 写出来

**Files:**
- Create: `src/db/schema-v42.sql`

- [ ] **Step 1: 写 schema-v42.sql**

```sql
-- v42: pipeline 解绑产线，新建 pipeline_bindings 关联表
-- 见 docs/superpowers/specs/2026-04-27-pipeline-product-line-decoupling-design.md §3.3

-- 1. pipeline_bindings 关联表
CREATE TABLE IF NOT EXISTS pipeline_bindings (
  product_line_id          INT      NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  ref_key                  TEXT     NOT NULL,
  pipeline_id              INT      NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  server_role_assignments  JSONB    NOT NULL DEFAULT '{}'::jsonb,
  description              TEXT     NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_line_id, ref_key)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_bindings_pipeline ON pipeline_bindings(pipeline_id);

-- 2. test_pipelines.product_line_id 改 NULLable + ON DELETE SET NULL
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'test_pipelines' AND constraint_name = 'test_pipelines_product_line_id_fkey'
  ) THEN
    EXECUTE 'ALTER TABLE test_pipelines DROP CONSTRAINT test_pipelines_product_line_id_fkey';
  END IF;
END $$;

ALTER TABLE test_pipelines ALTER COLUMN product_line_id DROP NOT NULL;
ALTER TABLE test_pipelines ADD CONSTRAINT test_pipelines_product_line_id_fkey
  FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE SET NULL;

-- 3. 老 pipeline 自动建 binding（每条非 internal pipeline 一条）
--    server_roles count → server id 列表，按 server.id ASC 取前 N 台
DO $$
DECLARE
  rec RECORD;
  v_role TEXT;
  v_count INT;
  v_server_ids JSONB;
  v_assignments JSONB;
BEGIN
  FOR rec IN
    SELECT p.id, p.product_line_id, p.name, p.server_roles
    FROM test_pipelines p
    WHERE p.product_line_id IS NOT NULL
      AND p.id NOT IN (SELECT pipeline_id FROM internal_capability_pipelines)
  LOOP
    v_assignments := '{}'::jsonb;
    IF rec.server_roles IS NOT NULL AND rec.server_roles != '{}'::jsonb THEN
      FOR v_role, v_count IN SELECT * FROM jsonb_each_text(rec.server_roles) LOOP
        SELECT COALESCE(jsonb_agg(s.id::text ORDER BY s.id), '[]'::jsonb)
          INTO v_server_ids
        FROM (
          SELECT id FROM test_servers
          WHERE product_line_id = rec.product_line_id AND role = v_role
          ORDER BY id ASC LIMIT v_count::int
        ) s;
        v_assignments := v_assignments || jsonb_build_object(v_role, v_server_ids);
        RAISE NOTICE 'v42 migrate: pipeline=% role=% count=% picked=%',
                     rec.id, v_role, v_count, v_server_ids;
      END LOOP;
    END IF;

    INSERT INTO pipeline_bindings (
      product_line_id, ref_key, pipeline_id, server_role_assignments, description
    )
    VALUES (
      rec.product_line_id,
      CASE rec.name
        WHEN 'L1-配置类'   THEN 'fix_bug_l1'
        WHEN 'L2-代码缺陷' THEN 'fix_bug_l2'
        WHEN 'L3-业务逻辑' THEN 'fix_bug_l3'
        WHEN 'L4-复杂问题' THEN 'fix_bug_l4'
        ELSE rec.name
      END,
      rec.id,
      v_assignments,
      '从 schema-v3 ~ v41 自动迁移'
    )
    ON CONFLICT (product_line_id, ref_key) DO NOTHING;
  END LOOP;
END $$;

-- 4. internal pipeline 解绑产线（保持「全局共享」语义，不建 binding）
UPDATE test_pipelines
SET product_line_id = NULL
WHERE id IN (SELECT pipeline_id FROM internal_capability_pipelines);

-- 5. test_pipelines.schedule DROP（scheduler 模块删除）
ALTER TABLE test_pipelines DROP COLUMN IF EXISTS schedule;

-- 6. test_pipelines.server_roles 标 deprecated（不删，阶段 4 才 DROP）
COMMENT ON COLUMN test_pipelines.server_roles IS
  'DEPRECATED v42: server 分配迁到 pipeline_bindings.server_role_assignments。本字段保留兼容老 pipeline，新 pipeline 应填空对象。阶段 4 删除。';

-- 7. 断言：每条非 internal 的产线绑定 pipeline 都有 binding
DO $$
DECLARE
  v_pipeline_count INT;
  v_binding_count INT;
BEGIN
  SELECT COUNT(*) INTO v_pipeline_count
  FROM test_pipelines
  WHERE product_line_id IS NOT NULL
    AND id NOT IN (SELECT pipeline_id FROM internal_capability_pipelines);
  SELECT COUNT(*) INTO v_binding_count FROM pipeline_bindings;
  IF v_pipeline_count != v_binding_count THEN
    RAISE EXCEPTION 'v42 migrate: pipeline count mismatch (% pipelines vs % bindings)',
                    v_pipeline_count, v_binding_count;
  END IF;
END $$;
```

- [ ] **Step 2: 改 src/db/migrate.ts 追加 v42**

修改 `src/db/migrate.ts` 的 `SCHEMA_FILES` 数组末尾，加：

```typescript
  ['v42', 'schema-v42.sql'],
```

并在「v37Applied / v38Applied」检测之后加 v40Applied 检测（已加），在 fingerprint 推断的 `upTo` 计算里加上对 v42 的判断（保守做法：保留现有 fingerprint，让新跑的 v42 自然加到 _migrations 表）。当前 bootstrap 逻辑对 v40+v41+v42 都自动跑，无需特殊处理。

- [ ] **Step 3: 改 src/__tests__/helpers/db.ts 追加 v42**

`SCHEMA_FILES` 表追加 `['v42', 'schema-v42.sql']`。

- [ ] **Step 4: typecheck**

```bash
pnpm typecheck
```

预期：`tsc --noEmit` 干净退出。

- [ ] **Step 5: 跑一次 pnpm test 看 baseline 不增 fail**

```bash
pnpm test 2>&1 | tail -8
```

预期：`Test Files 1 failed | 119 passed` / `Tests 6 failed | 1089 passed | 38 skipped | 10 todo`（baseline 不变；新加 schema 不影响现有测试）。

- [ ] **Step 6: commit**

```bash
git add src/db/schema-v42.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat(db): schema-v42 — pipeline_bindings 表 + 老数据迁移 + 删 schedule"
```

---

### Task 1.2: pipeline-bindings repository

**Files:**
- Create: `src/db/repositories/pipeline-bindings.ts`
- Test: `src/__tests__/unit/pipeline-bindings.test.ts`

- [ ] **Step 1: 写 unit test（先 fail）**

```typescript
// src/__tests__/unit/pipeline-bindings.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  upsertPipelineBinding,
  getPipelineBinding,
  listPipelineBindings,
  deletePipelineBinding,
  resolvePipelineForTrigger,
} from '../../db/repositories/pipeline-bindings.js'

async function seedFixture(): Promise<{ productLineId: number; pipelineId: number }> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pl-test', 'PL Test', '') RETURNING id`,
  )
  const plRes = await pool.query(`SELECT id FROM product_lines WHERE name='pl-test'`)
  const productLineId = plRes.rows[0].id

  const pipelineRes = await pool.query(
    `INSERT INTO test_pipelines (name, description, graph, trigger_params, enabled,
      server_roles, variables, stages, product_line_id)
     VALUES ('test-p', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb,
       true, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, NULL)
     RETURNING id`,
  )
  return { productLineId, pipelineId: pipelineRes.rows[0].id }
}

describe('pipeline-bindings repository', () => {
  beforeEach(async () => {
    await resetTestDb()
  })

  it('upsertPipelineBinding 创建 → getPipelineBinding 命中', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId,
      refKey: 'fix_bug_l1',
      pipelineId: fx.pipelineId,
      serverRoleAssignments: { web: ['srv-1', 'srv-2'] },
      description: 'test',
    })
    const got = await getPipelineBinding(fx.productLineId, 'fix_bug_l1')
    expect(got).not.toBeNull()
    expect(got!.pipelineId).toBe(fx.pipelineId)
    expect(got!.serverRoleAssignments).toEqual({ web: ['srv-1', 'srv-2'] })
  })

  it('upsertPipelineBinding 重复 key → 更新 (PK 冲突 ON CONFLICT)', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1', pipelineId: fx.pipelineId,
      serverRoleAssignments: {}, description: 'v1',
    })
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1', pipelineId: fx.pipelineId,
      serverRoleAssignments: { web: ['x'] }, description: 'v2',
    })
    const got = await getPipelineBinding(fx.productLineId, 'fix_bug_l1')
    expect(got!.serverRoleAssignments).toEqual({ web: ['x'] })
    expect(got!.description).toBe('v2')
  })

  it('listPipelineBindings filter by productLineId', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1',
      pipelineId: fx.pipelineId, serverRoleAssignments: {}, description: '',
    })
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l2',
      pipelineId: fx.pipelineId, serverRoleAssignments: {}, description: '',
    })
    const list = await listPipelineBindings({ productLineId: fx.productLineId })
    expect(list).toHaveLength(2)
  })

  it('deletePipelineBinding 删除', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1',
      pipelineId: fx.pipelineId, serverRoleAssignments: {}, description: '',
    })
    await deletePipelineBinding(fx.productLineId, 'fix_bug_l1')
    const got = await getPipelineBinding(fx.productLineId, 'fix_bug_l1')
    expect(got).toBeNull()
  })

  it('resolvePipelineForTrigger 命中', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1', pipelineId: fx.pipelineId,
      serverRoleAssignments: { web: ['srv-1'] }, description: '',
    })
    const res = await resolvePipelineForTrigger(fx.productLineId, 'fix_bug_l1')
    expect(res).toEqual({ pipelineId: fx.pipelineId, serverRoleAssignments: { web: ['srv-1'] } })
  })

  it('resolvePipelineForTrigger 未命中返回 null', async () => {
    const fx = await seedFixture()
    const res = await resolvePipelineForTrigger(fx.productLineId, 'no_such_key')
    expect(res).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试看 fail**

```bash
npx vitest run src/__tests__/unit/pipeline-bindings.test.ts 2>&1 | tail -15
```

预期：FAIL with "Cannot find module '../../db/repositories/pipeline-bindings.js'"

- [ ] **Step 3: 写 repository 实现**

```typescript
// src/db/repositories/pipeline-bindings.ts
import { getPool } from '../client.js'

export interface PipelineBinding {
  productLineId: number
  refKey: string
  pipelineId: number
  serverRoleAssignments: Record<string, string[]>
  description: string
  createdAt: Date
  updatedAt: Date
}

interface DbRow {
  product_line_id: number
  ref_key: string
  pipeline_id: number
  server_role_assignments: Record<string, string[]>
  description: string
  created_at: Date
  updated_at: Date
}

function mapRow(r: DbRow): PipelineBinding {
  return {
    productLineId: r.product_line_id,
    refKey: r.ref_key,
    pipelineId: r.pipeline_id,
    serverRoleAssignments: r.server_role_assignments ?? {},
    description: r.description ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function getPipelineBinding(
  productLineId: number,
  refKey: string,
): Promise<PipelineBinding | null> {
  const { rows } = await getPool().query<DbRow>(
    `SELECT * FROM pipeline_bindings
     WHERE product_line_id = $1 AND ref_key = $2`,
    [productLineId, refKey],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listPipelineBindings(filter?: {
  productLineId?: number
  pipelineId?: number
}): Promise<PipelineBinding[]> {
  const conds: string[] = []
  const params: unknown[] = []
  if (filter?.productLineId !== undefined) {
    params.push(filter.productLineId)
    conds.push(`product_line_id = $${params.length}`)
  }
  if (filter?.pipelineId !== undefined) {
    params.push(filter.pipelineId)
    conds.push(`pipeline_id = $${params.length}`)
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
  const { rows } = await getPool().query<DbRow>(
    `SELECT * FROM pipeline_bindings ${where} ORDER BY product_line_id, ref_key`,
    params,
  )
  return rows.map(mapRow)
}

export async function upsertPipelineBinding(
  b: Omit<PipelineBinding, 'createdAt' | 'updatedAt'>,
): Promise<PipelineBinding> {
  const { rows } = await getPool().query<DbRow>(
    `INSERT INTO pipeline_bindings
       (product_line_id, ref_key, pipeline_id, server_role_assignments, description)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (product_line_id, ref_key) DO UPDATE SET
       pipeline_id = EXCLUDED.pipeline_id,
       server_role_assignments = EXCLUDED.server_role_assignments,
       description = EXCLUDED.description,
       updated_at = NOW()
     RETURNING *`,
    [
      b.productLineId,
      b.refKey,
      b.pipelineId,
      JSON.stringify(b.serverRoleAssignments),
      b.description,
    ],
  )
  return mapRow(rows[0])
}

export async function deletePipelineBinding(
  productLineId: number,
  refKey: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM pipeline_bindings WHERE product_line_id = $1 AND ref_key = $2`,
    [productLineId, refKey],
  )
}

export async function resolvePipelineForTrigger(
  productLineId: number,
  refKey: string,
): Promise<{ pipelineId: number; serverRoleAssignments: Record<string, string[]> } | null> {
  const { rows } = await getPool().query<DbRow>(
    `SELECT pipeline_id, server_role_assignments FROM pipeline_bindings
     WHERE product_line_id = $1 AND ref_key = $2`,
    [productLineId, refKey],
  )
  if (!rows[0]) return null
  return {
    pipelineId: rows[0].pipeline_id,
    serverRoleAssignments: rows[0].server_role_assignments ?? {},
  }
}
```

- [ ] **Step 4: 跑测试看 pass**

```bash
npx vitest run src/__tests__/unit/pipeline-bindings.test.ts 2>&1 | tail -15
```

预期：6 case 全 PASS。

- [ ] **Step 5: typecheck + 全套测试不增 fail**

```bash
pnpm typecheck && pnpm test 2>&1 | tail -8
```

预期：typecheck 干净；`Tests 6 failed | 1095 passed`（1089 baseline + 6 新 case）。

- [ ] **Step 6: commit**

```bash
git add src/db/repositories/pipeline-bindings.ts src/__tests__/unit/pipeline-bindings.test.ts
git commit -m "feat(db): pipeline-bindings repository (CRUD + resolvePipelineForTrigger)"
```

---

### Task 1.3: schema-v42 数据迁移 integration test

**Files:**
- Create: `src/__tests__/integration/schema-v42-migration.test.ts`

- [ ] **Step 1: 写 fixture 测试（先 fail，覆盖迁移正确性）**

```typescript
// src/__tests__/integration/schema-v42-migration.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { listPipelineBindings } from '../../db/repositories/pipeline-bindings.js'

async function seedPreV42State(): Promise<{ pl1: number; pl2: number; p1: number; p2: number; p3: number }> {
  const pool = getTestPool()

  // 2 个产线
  const pl1Res = await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-1', 'PL1', '') RETURNING id`,
  )
  const pl2Res = await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-2', 'PL2', '') RETURNING id`,
  )
  const pl1 = pl1Res.rows[0].id
  const pl2 = pl2Res.rows[0].id

  // 每个产线 3 台 web + 1 台 db server
  for (const pl of [pl1, pl2]) {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO test_servers (product_line_id, host, port, username, role, name, key_path)
         VALUES ($1, $2, 22, 'root', 'web', $3, '')`,
        [pl, `web${i}-pl${pl}.example.com`, `web${i}-pl${pl}`],
      )
    }
    await pool.query(
      `INSERT INTO test_servers (product_line_id, host, port, username, role, name, key_path)
       VALUES ($1, $2, 22, 'root', 'db', $3, '')`,
      [pl, `db-pl${pl}.example.com`, `db-pl${pl}`],
    )
  }

  // pl1 有 L1-配置类 + L3-业务逻辑
  const p1Res = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, graph, trigger_params, enabled,
       server_roles, variables, stages)
     VALUES ($1, 'L1-配置类', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true,
       '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)
     RETURNING id`,
    [pl1],
  )
  const p2Res = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, graph, trigger_params, enabled,
       server_roles, variables, stages)
     VALUES ($1, 'L3-业务逻辑', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true,
       '{"web":2,"db":1}'::jsonb, '{}'::jsonb, '[]'::jsonb)
     RETURNING id`,
    [pl1],
  )
  // pl2 有 L1-配置类（同名不同实例 = 现状每产线各 seed 一份）
  const p3Res = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, graph, trigger_params, enabled,
       server_roles, variables, stages)
     VALUES ($1, 'L1-配置类', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true,
       '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)
     RETURNING id`,
    [pl2],
  )

  return { pl1, pl2, p1: p1Res.rows[0].id, p2: p2Res.rows[0].id, p3: p3Res.rows[0].id }
}

describe('schema-v42 数据迁移', () => {
  beforeEach(async () => {
    // resetTestDb() 已经跑完所有 SCHEMA_FILES 含 v42。我们的策略是：
    // 1. resetTestDb() 后表已建好但无数据
    // 2. 模拟「v42 之前的状态」：人工 INSERT 老 pipeline + servers
    // 3. 重跑 schema-v42.sql 看迁移效果（v42 用 DO blocks 幂等）
    await resetTestDb()
  })

  it('每条 (product_line_id 非空) 的非 internal pipeline 自动建一条 binding', async () => {
    const fx = await seedPreV42State()

    // 重跑 v42（DO blocks 幂等）
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v42.sql'), 'utf8')
    await getTestPool().query(sql)

    const bindings = await listPipelineBindings()
    expect(bindings).toHaveLength(3) // pl1×2 + pl2×1
    
    // L1 pipeline 转成 ref_key='fix_bug_l1'
    const l1Bindings = bindings.filter(b => b.refKey === 'fix_bug_l1')
    expect(l1Bindings).toHaveLength(2)
    expect(l1Bindings.map(b => b.productLineId).sort()).toEqual([fx.pl1, fx.pl2].sort())

    // L3 pipeline 转成 ref_key='fix_bug_l3'
    const l3 = bindings.find(b => b.refKey === 'fix_bug_l3')
    expect(l3).toBeDefined()
    expect(l3!.pipelineId).toBe(fx.p2)
  })

  it('server_roles {web:2,db:1} 自动转换为前 N 台 server id 列表', async () => {
    const fx = await seedPreV42State()
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v42.sql'), 'utf8')
    await getTestPool().query(sql)

    const l3 = (await listPipelineBindings()).find(b => b.refKey === 'fix_bug_l3')
    expect(l3!.serverRoleAssignments).toMatchObject({
      web: expect.arrayContaining([expect.any(String)]),  // 2 个 server id
      db: expect.arrayContaining([expect.any(String)]),   // 1 个 server id
    })
    expect((l3!.serverRoleAssignments.web as string[]).length).toBe(2)
    expect((l3!.serverRoleAssignments.db as string[]).length).toBe(1)
  })

  it('server_roles 为空 {} 的 pipeline → assignments 也是 {}', async () => {
    const fx = await seedPreV42State()
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v42.sql'), 'utf8')
    await getTestPool().query(sql)

    const l1 = (await listPipelineBindings()).find(b => b.productLineId === fx.pl1 && b.refKey === 'fix_bug_l1')
    expect(l1!.serverRoleAssignments).toEqual({})
  })

  it('internal pipeline 不被迁移到 pipeline_bindings（保持全局共享语义）', async () => {
    const fx = await seedPreV42State()
    const pool = getTestPool()
    // 把 fx.p1 标为 internal pipeline
    await pool.query(
      `INSERT INTO internal_capability_pipelines (capability_key, pipeline_id) VALUES ('test_internal', $1)
       ON CONFLICT DO NOTHING`,
      [fx.p1],
    )
    // 重跑 v42（DO blocks 幂等）
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v42.sql'), 'utf8')
    await pool.query(sql)

    const bindings = await listPipelineBindings()
    // p1 是 internal，不在 binding 里；剩下 p2 (pl1.l3) + p3 (pl2.l1) = 2 个 binding
    expect(bindings.find(b => b.pipelineId === fx.p1)).toBeUndefined()
    expect(bindings).toHaveLength(2)

    // p1 的 product_line_id 应被 UPDATE 为 NULL
    const r = await pool.query(`SELECT product_line_id FROM test_pipelines WHERE id = $1`, [fx.p1])
    expect(r.rows[0].product_line_id).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试看 PASS（schema-v42 已 ship 在 Task 1.1）**

```bash
npx vitest run src/__tests__/integration/schema-v42-migration.test.ts 2>&1 | tail -15
```

预期：3 case 全 PASS。

- [ ] **Step 3: typecheck + 全套测试**

```bash
pnpm typecheck && pnpm test 2>&1 | tail -8
```

预期：1098 pass / 6 fail。

- [ ] **Step 4: commit**

```bash
git add src/__tests__/integration/schema-v42-migration.test.ts
git commit -m "test(db): schema-v42 数据迁移正确性"
```

> **Note**: 测试在 `beforeEach` 跑 `resetTestDb()` 后表已建好（含 v42 已 apply），fixture 通过 INSERT 模拟"v42 之前的状态"，重跑 schema-v42.sql 验证迁移正确（DO blocks 幂等）。`createBugAnalysisReport` repo 不在此 task 出现 —— Task 2.5 用到时再用 repo helper 而非裸 SQL。

---

## 阶段 2：后端路由 + executor 改造

### Task 2.1: coordinator.findPipelineByLevel → resolvePipelineForTrigger

**Files:**
- Modify: `src/agent/coordinator.ts:284-316`（删 PIPELINE_NAMES + findPipelineByLevel；改 handleAnalysisComplete）

- [ ] **Step 1: 跑现有 coordinator 相关 test 看 baseline**

```bash
npx vitest run src/__tests__/integration/handler-vs-pipeline-handover.test.ts 2>&1 | tail -8
```

预期：3 case 全 PASS。

- [ ] **Step 2: 改 coordinator.ts**

删 `PIPELINE_NAMES` 字典（行 284-289）+ `findPipelineByLevel` 函数（行 291-316）。

修改 `handleAnalysisComplete`：

```typescript
// 改前（行 ~370）
const pipeline = await findPipelineByLevel(report.productLineId, level)
if (!pipeline) {
  console.error(`[AgentCoordinator] no pipeline for productLine=${report.productLineId} level=${level}, mark aborted`)
  await updateReportStatus(reportId, 'aborted')
  return
}
// ...
const runId = await runPipeline(
  pipeline.id,
  {},
  apiTrigger({ triggeredBy, params: { reportId } }),
  { reportId: String(reportId) },
  onComplete,
)
```

```typescript
// 改后
import { resolvePipelineForTrigger } from '../db/repositories/pipeline-bindings.js'

// ...
const refKey = `fix_bug_${level}`
const binding = await resolvePipelineForTrigger(report.productLineId, refKey)
if (!binding) {
  console.error(`[AgentCoordinator] no pipeline binding for productLine=${report.productLineId} ref_key=${refKey}, mark aborted`)
  await updateReportStatus(reportId, 'aborted')
  return
}
// ...
const runId = await runPipeline(
  binding.pipelineId,
  binding.serverRoleAssignments,  // 从 {} 改为 binding 提供
  apiTrigger({ triggeredBy, params: { reportId } }),
  { reportId: String(reportId) },
  onComplete,
)
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

预期：tsc 报错 — runPipeline 第 2 参数类型从 `Record<string, ServerInfo[]>` 变为 `Record<string, string[]>` 不匹配（这是 Task 2.2 才做）。

**临时方案**：让 Task 2.1 完成后 build 通过 + 现有测试不破，binding.serverRoleAssignments 暂时透传 `{}`（runPipeline 老逻辑兼容空入参 → 走 fallback 路径用 pipeline.serverRoles）。Task 2.2 才真正把 server 路径接通。

```typescript
// Task 2.1 接 binding 路径，server_role_assignments 暂时透传 {} 让现有 fallback 跑
const runId = await runPipeline(
  binding.pipelineId,
  {},  // FIXME(T2.2): 改为 binding.serverRoleAssignments hydrate 后传入
  apiTrigger({ triggeredBy, params: { reportId } }),
  { reportId: String(reportId) },
  onComplete,
)
```

T2.1 完成后 bugfix 链路从「按 pipeline.name 查 pipeline」改为「按 binding 查 pipeline」，但 server 仍走老 fallback 逻辑（pipeline.productLineId × listTestServers）—— 现有 fixture 走得通。T2.2 把 server 也接上。

- [ ] **Step 4: 跑现有 handler-vs-pipeline 测试看不破**

```bash
npx vitest run src/__tests__/integration/handler-vs-pipeline-handover.test.ts 2>&1 | tail -8
npx vitest run src/__tests__/integration/handler-vs-pipeline-notify.test.ts 2>&1 | tail -8
npx vitest run src/__tests__/integration/handler-vs-pipeline-mr.test.ts 2>&1 | tail -8
```

预期：3 个文件 case 全 PASS（这些测试不依赖 findPipelineByLevel，走 internal_capability_pipelines 路径）。

但 `handleAnalysisComplete` 路径还没有专门的集成测试。需要写一条来 verify binding 路径生效。这放在 Task 2.5 的集成测试里。

- [ ] **Step 5: 全套 test 不增 fail**

```bash
pnpm test 2>&1 | tail -8
```

预期：1098 pass / 6 fail（baseline，新加无 fail）。

- [ ] **Step 6: commit**

```bash
git add src/agent/coordinator.ts
git commit -m "refactor(coordinator): findPipelineByLevel → resolvePipelineForTrigger (binding 路径)"
```

---

### Task 2.2: runPipeline 入参变更 + executor hydrate

**Files:**
- Modify: `src/pipeline/executor.ts`（runPipeline 函数签名 + 内部 hydrate 逻辑）
- Modify: `src/agent/coordinator.ts`（去掉 T2.1 的 FIXME）

- [ ] **Step 1: 写 hydrateServerAssignments helper 单元测试**

```typescript
// src/__tests__/unit/hydrate-server-assignments.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { hydrateServerAssignments } from '../../pipeline/executor.js'

describe('hydrateServerAssignments', () => {
  let pl1: number
  let serverIds: number[]
  beforeEach(async () => {
    await resetTestDb()
    const pool = getTestPool()
    const plRes = await pool.query(
      `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-test', '', '') RETURNING id`,
    )
    pl1 = plRes.rows[0].id
    serverIds = []
    for (const role of ['web', 'web', 'db']) {
      const res = await pool.query(
        `INSERT INTO test_servers (product_line_id, host, port, username, role, name, key_path)
         VALUES ($1, 'h.example.com', 22, 'r', $2, $3, '') RETURNING id`,
        [pl1, role, `s-${role}-${Math.random()}`],
      )
      serverIds.push(res.rows[0].id)
    }
  })

  it('从 server id list hydrate 为 ServerInfo[]', async () => {
    const result = await hydrateServerAssignments({
      web: [String(serverIds[0]), String(serverIds[1])],
      db: [String(serverIds[2])],
    })
    expect(Object.keys(result).sort()).toEqual(['db', 'web'])
    expect(result.web).toHaveLength(2)
    expect(result.db).toHaveLength(1)
    expect(result.web[0]).toMatchObject({ host: 'h.example.com', role: 'web' })
  })

  it('空 assignments 返回空对象', async () => {
    const result = await hydrateServerAssignments({})
    expect(result).toEqual({})
  })

  it('server id 不存在 → 报错', async () => {
    await expect(
      hydrateServerAssignments({ web: ['99999999'] }),
    ).rejects.toThrow(/not found/i)
  })
})
```

- [ ] **Step 2: 跑测试看 fail**

```bash
npx vitest run src/__tests__/unit/hydrate-server-assignments.test.ts 2>&1 | tail -10
```

预期：FAIL with "hydrateServerAssignments is not exported"。

- [ ] **Step 3: 改 executor.ts 加 hydrateServerAssignments + 改 runPipeline 签名**

```typescript
// src/pipeline/executor.ts （在文件顶部加 import 和 export）

import type { ServerInfo } from './types.js'
import { listTestServersByIds } from '../db/repositories/test-servers.js'  // ← 可能要加这个 helper

/**
 * 把 binding.serverRoleAssignments (role → server id 列表) hydrate 为 ServerInfo[]。
 * 缺 server id → 抛错。
 */
export async function hydrateServerAssignments(
  assignments: Record<string, string[]>,
): Promise<Record<string, ServerInfo[]>> {
  if (Object.keys(assignments).length === 0) return {}
  const allIds = Array.from(new Set(Object.values(assignments).flat().map(Number)))
  const servers = await listTestServersByIds(allIds)
  const byId = new Map(servers.map(s => [s.id, s]))
  
  const result: Record<string, ServerInfo[]> = {}
  for (const [role, ids] of Object.entries(assignments)) {
    result[role] = ids.map(idStr => {
      const id = Number(idStr)
      const s = byId.get(id)
      if (!s) throw new Error(`server id ${id} not found in test_servers`)
      return s
    })
  }
  return result
}
```

如果 `listTestServersByIds` 不存在（新 helper），先在 `src/db/repositories/test-servers.ts` 加：

```typescript
export async function listTestServersByIds(ids: number[]): Promise<TestServer[]> {
  if (ids.length === 0) return []
  const { rows } = await getPool().query<DbRow>(
    `SELECT * FROM test_servers WHERE id = ANY($1::int[])`,
    [ids],
  )
  return rows.map(mapRow)
}
```

接着改 `runPipeline` 函数签名（找到当前签名，第 2 参数 server_roles 类型）：

```typescript
// runPipeline 内部，旧的"先 listTestServers + allocateByRole"逻辑替换为：

async function runPipeline(
  pipelineId: number,
  serverRoleAssignments: Record<string, string[]>,  // ← 类型从 Record<string, ServerInfo[]> 改为
  trigger: TriggerContext,
  runtimeVars: Record<string, string>,
  onComplete?: OnCompleteHook,
): Promise<number> {
  const pipeline = await getTestPipelineById(pipelineId)
  
  let resolved: Record<string, ServerInfo[]>
  if (Object.keys(serverRoleAssignments).length > 0) {
    // 新路径：binding 提供 server id 列表
    resolved = await hydrateServerAssignments(serverRoleAssignments)
  } else if (pipeline.productLineId && Object.keys(pipeline.serverRoles ?? {}).length > 0) {
    // 老路径兼容（阶段 4 删除）：pipeline 还带 serverRoles + productLineId
    const allServers = await listTestServers(pipeline.productLineId)
    resolved = allocateByRole(allServers, pipeline.serverRoles)
  } else {
    // bugfix / 纯数据流 pipeline：无需 server
    resolved = {}
  }
  // ...剩余 stage 执行用 resolved（保持不变）
}
```

如果 `runPipeline` 已有调用方传 `Record<string, ServerInfo[]>`（已 hydrate 的），那要找出来一一改掉，让它们改传 `Record<string, string[]>`（id list）。这是 breaking change。

- [ ] **Step 4: 跑 hydrate 单元测试看 PASS**

```bash
npx vitest run src/__tests__/unit/hydrate-server-assignments.test.ts 2>&1 | tail -8
```

预期：3 case 全 PASS。

- [ ] **Step 5: 改 coordinator.ts 去 FIXME**

```typescript
// 把 Task 2.1 的临时 {} 改回 binding.serverRoleAssignments
const runId = await runPipeline(
  binding.pipelineId,
  binding.serverRoleAssignments,  // ← 真正接通
  apiTrigger({ triggeredBy, params: { reportId } }),
  { reportId: String(reportId) },
  onComplete,
)
```

- [ ] **Step 6: 改其他 runPipeline 调用方（如有）**

grep `runPipeline\(` 找全所有调用方，确认每处传的是 `Record<string, string[]>` 还是 `Record<string, ServerInfo[]>`。

可能调用方：
- coordinator.ts (已改) — 用 binding.serverRoleAssignments (已是 string[] map)
- coordinator.ts:triggerCapability (走 im_trigger / internal_capability) — 当前传 `{}`，无需改
- IM trigger 触发的 pipeline — 当前传 `{}`，无需改
- web/admin 手动触发 — 看 admin route 实现

- [ ] **Step 7: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

预期：tsc 干净。

- [ ] **Step 8: 全套 test 不增 fail**

```bash
pnpm test 2>&1 | tail -8
```

预期：1101 pass / 6 fail。

- [ ] **Step 9: commit**

```bash
git add src/pipeline/executor.ts src/agent/coordinator.ts \
  src/db/repositories/test-servers.ts src/__tests__/unit/hydrate-server-assignments.test.ts
git commit -m "feat(executor): runPipeline 入参改 server id list + hydrateServerAssignments"
```

---

### Task 2.3: scheduler 模块删除

**Files:**
- Delete: `src/pipeline/scheduler.ts`
- Modify: `src/server.ts`（删启动代码）
- Modify: `src/admin/routes/test-pipelines.ts`（删 schedule 参数）
- Modify: `src/db/repositories/test-pipelines.ts`（删 schedule 列处理）

- [ ] **Step 1: 找出所有 scheduler 引用**

```bash
grep -rn "scheduler\|Scheduler" src/ --include="*.ts" | grep -v "scheduler.ts:" | head -20
```

记录所有引用点的行号。

- [ ] **Step 2: 删 src/pipeline/scheduler.ts**

```bash
rm src/pipeline/scheduler.ts
```

- [ ] **Step 3: 改 src/server.ts 删 scheduler 启动代码**

找 `import.*scheduler` 和 `startScheduler` 的调用，整段删除。

- [ ] **Step 4: 改 src/db/repositories/test-pipelines.ts 删 schedule 列处理**

`mapRow` 函数删 `schedule: r.schedule ?? ''` 行。
INSERT/UPDATE SQL 模板里删 `schedule` 字段。
TypeScript interface `TestPipeline` 删 `schedule: string` 字段。

- [ ] **Step 5: 改 src/admin/routes/test-pipelines.ts 删 schedule 参数**

POST/PUT body 校验里删 `schedule` 参数；列表 / 详情响应里删 schedule 字段。

- [ ] **Step 6: typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

预期：可能有几处需要修（schedule 字段引用）。逐个修掉。

- [ ] **Step 7: 全套 test 不增 fail**

```bash
pnpm test 2>&1 | tail -8
```

预期：1101 pass / 6 fail（schedule 字段相关测试若有需删）。

- [ ] **Step 8: commit**

```bash
git add -A
git commit -m "refactor(pipeline): scheduler 模块整体删除 + test_pipelines.schedule 字段下线"
```

---

### Task 2.4: pipeline-bindings admin API

**Files:**
- Create: `src/admin/routes/pipeline-bindings.ts`
- Modify: `src/admin/index.ts`（注册路由）

- [ ] **Step 1: 写 admin route**

```typescript
// src/admin/routes/pipeline-bindings.ts
import type { FastifyPluginAsync } from 'fastify'
import {
  getPipelineBinding,
  listPipelineBindings,
  upsertPipelineBinding,
  deletePipelineBinding,
} from '../../db/repositories/pipeline-bindings.js'

export const pipelineBindingsRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/api/pipeline-bindings?productLineId=&pipelineId=
  app.get('/pipeline-bindings', async (request) => {
    const q = request.query as { productLineId?: string; pipelineId?: string }
    const filter: { productLineId?: number; pipelineId?: number } = {}
    if (q.productLineId) filter.productLineId = Number(q.productLineId)
    if (q.pipelineId) filter.pipelineId = Number(q.pipelineId)
    return await listPipelineBindings(filter)
  })

  // GET /admin/api/pipeline-bindings/:productLineId/:refKey
  app.get('/pipeline-bindings/:productLineId/:refKey', async (request, reply) => {
    const p = request.params as { productLineId: string; refKey: string }
    const binding = await getPipelineBinding(Number(p.productLineId), p.refKey)
    if (!binding) {
      reply.code(404)
      return { error: 'not found' }
    }
    return binding
  })

  // POST /admin/api/pipeline-bindings (upsert)
  app.post('/pipeline-bindings', async (request) => {
    const b = request.body as {
      productLineId: number
      refKey: string
      pipelineId: number
      serverRoleAssignments?: Record<string, string[]>
      description?: string
    }
    return await upsertPipelineBinding({
      productLineId: b.productLineId,
      refKey: b.refKey,
      pipelineId: b.pipelineId,
      serverRoleAssignments: b.serverRoleAssignments ?? {},
      description: b.description ?? '',
    })
  })

  // DELETE /admin/api/pipeline-bindings/:productLineId/:refKey
  app.delete('/pipeline-bindings/:productLineId/:refKey', async (request) => {
    const p = request.params as { productLineId: string; refKey: string }
    await deletePipelineBinding(Number(p.productLineId), p.refKey)
    return { ok: true }
  })
}
```

- [ ] **Step 2: 改 src/admin/index.ts 注册路由**

```typescript
import { pipelineBindingsRoutes } from './routes/pipeline-bindings.js'
// ...
app.register(pipelineBindingsRoutes, { prefix: '/admin/api' })
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

预期：tsc 干净。

- [ ] **Step 4: 写 admin route smoke test（可选）**

跳过 unit test —— admin route 是简单 CRUD 包装，repository 已测试覆盖。Manual smoke 在浏览器测。

- [ ] **Step 5: commit**

```bash
git add src/admin/routes/pipeline-bindings.ts src/admin/index.ts
git commit -m "feat(admin): pipeline-bindings CRUD API"
```

---

### Task 2.5: bugfix 全链路 integration test

**Files:**
- Create: `src/__tests__/integration/pipeline-decoupling.test.ts`

- [ ] **Step 1: 写跨产线复用 + binding 路径 + 老 fallback 集成测试**

```typescript
// src/__tests__/integration/pipeline-decoupling.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { upsertPipelineBinding } from '../../db/repositories/pipeline-bindings.js'
import { handleAnalysisComplete } from '../../agent/coordinator.js'
import {
  createBugAnalysisReport,
  getBugAnalysisReportById,
} from '../../db/repositories/bug-analysis-reports.js'

async function seedSharedPipeline(): Promise<{
  pl1: number; pl2: number; pipelineId: number
}> {
  const pool = getTestPool()
  const pl1 = (await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-1', '', '') RETURNING id`,
  )).rows[0].id
  const pl2 = (await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-2', '', '') RETURNING id`,
  )).rows[0].id

  // 一条全局 pipeline（解绑产线）
  const pipelineId = (await pool.query(
    `INSERT INTO test_pipelines (name, description, graph, trigger_params, enabled,
       server_roles, variables, stages, product_line_id)
     VALUES ('shared-l3', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true,
       '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, NULL)
     RETURNING id`,
  )).rows[0].id

  // 两个产线都引用同条 pipeline，ref_key 相同
  await upsertPipelineBinding({
    productLineId: pl1, refKey: 'fix_bug_l3', pipelineId, serverRoleAssignments: {}, description: '',
  })
  await upsertPipelineBinding({
    productLineId: pl2, refKey: 'fix_bug_l3', pipelineId, serverRoleAssignments: {}, description: '',
  })

  return { pl1, pl2, pipelineId }
}

async function seedReport(productLineId: number, issueId: number, primaryProjectPath: string): Promise<number> {
  const r = await createBugAnalysisReport({
    issueId,
    issueUrl: `http://gl/issue/${issueId}`,
    productLineId,
    agentSessionId: null,
    level: 'l3',
    classification: 'bug',
    confidence: 'high',
    confidenceScore: 0.9,
    rootCauseSummary: 'rc',
    solutionsJson: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
    affectedModules: null,
    analysisSteps: null,
    metadata: null,
    primaryProjectPath,
  })
  return r.id
}

describe('pipeline 解绑产线 — 跨产线复用 + binding 路径', () => {
  beforeEach(async () => {
    await resetTestDb()
  })

  it('两个产线共用同条 pipeline，handleAnalysisComplete 能各自启动', async () => {
    const fx = await seedSharedPipeline()
    const r1 = await seedReport(fx.pl1, 101, 'path-1')
    const r2 = await seedReport(fx.pl2, 102, 'path-2')

    await handleAnalysisComplete(r1, 'l3', 'bug', 'u-trigger')
    await handleAnalysisComplete(r2, 'l3', 'bug', 'u-trigger')

    const rep1 = await getBugAnalysisReportById(r1)
    const rep2 = await getBugAnalysisReportById(r2)
    expect(rep1?.pipelineRunId).not.toBeNull()
    expect(rep2?.pipelineRunId).not.toBeNull()
    expect(rep1?.pipelineRunId).not.toBe(rep2?.pipelineRunId)

    const runs = (await getTestPool().query(
      `SELECT pipeline_id FROM test_runs WHERE id IN ($1, $2)`,
      [rep1!.pipelineRunId, rep2!.pipelineRunId],
    )).rows
    expect(runs[0].pipeline_id).toBe(fx.pipelineId)
    expect(runs[1].pipeline_id).toBe(fx.pipelineId)
  })

  it('binding 不存在 → handleAnalysisComplete 标 aborted', async () => {
    const pool = getTestPool()
    const pl = (await pool.query(
      `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-noref', '', '') RETURNING id`,
    )).rows[0].id
    const r = await seedReport(pl, 200, '')

    await handleAnalysisComplete(r, 'l3', 'bug', 'u-trigger')
    const rep = await getBugAnalysisReportById(r)
    expect(rep?.status).toBe('aborted')
  })
})
```

- [ ] **Step 2: 跑测试看 PASS**

```bash
npx vitest run src/__tests__/integration/pipeline-decoupling.test.ts 2>&1 | tail -8
```

预期：2 case 全 PASS。如果失败：
- 「pipeline 路径未走 binding」→ 检查 coordinator.ts 改造是否完整
- 「ServerInfo hydrate 报错」→ 该 fixture pipeline 无 server 节点，应 hydrate 空对象，调试 hydrateServerAssignments

- [ ] **Step 3: 全套 test 不增 fail**

```bash
pnpm test 2>&1 | tail -8
```

预期：1103 pass / 6 fail。

- [ ] **Step 4: 更新冒烟手册场景 1-3**

把 `docs/smoke-pipeline-decoupling.md` 的 [实施完阶段 2 后填] 占位填上，写：
- 场景 1: bugfix L1/L2/L3 走 binding 路径（怎么验证 log）
- 场景 2: 跨产线复用同条 pipeline（在管理后台同时建两条 binding 指同一 pipeline）
- 场景 3: 老 pipeline 兼容（pipeline.serverRoles 非空 + binding 入参为空）

- [ ] **Step 5: commit**

```bash
git add src/__tests__/integration/pipeline-decoupling.test.ts docs/smoke-pipeline-decoupling.md
git commit -m "test(pipeline): 跨产线复用 + binding 路径集成测试"
```

---

## 阶段 3：前端改造

### Task 3.1: API client + TestPipelinesPage 简化

**Files:**
- Create: `web/src/api/pipeline-bindings.ts`
- Modify: `web/src/pages/TestPipelinesPage.tsx`
- Modify: `web/src/api/test-pipelines.ts`（接口 schedule 字段去除）

- [ ] **Step 1: 写 API client**

```typescript
// web/src/api/pipeline-bindings.ts
import axios from 'axios'

export interface PipelineBinding {
  productLineId: number
  refKey: string
  pipelineId: number
  serverRoleAssignments: Record<string, string[]>
  description: string
  createdAt: string
  updatedAt: string
}

export async function listPipelineBindings(filter?: {
  productLineId?: number
  pipelineId?: number
}): Promise<PipelineBinding[]> {
  const { data } = await axios.get('/admin/api/pipeline-bindings', { params: filter })
  return data
}

export async function getPipelineBinding(productLineId: number, refKey: string): Promise<PipelineBinding> {
  const { data } = await axios.get(`/admin/api/pipeline-bindings/${productLineId}/${encodeURIComponent(refKey)}`)
  return data
}

export async function upsertPipelineBinding(b: Omit<PipelineBinding, 'createdAt' | 'updatedAt'>): Promise<PipelineBinding> {
  const { data } = await axios.post('/admin/api/pipeline-bindings', b)
  return data
}

export async function deletePipelineBinding(productLineId: number, refKey: string): Promise<void> {
  await axios.delete(`/admin/api/pipeline-bindings/${productLineId}/${encodeURIComponent(refKey)}`)
}
```

- [ ] **Step 2: 改 TestPipelinesPage.tsx**

- 列表删「产线名称」列、删「schedule」列；加「被引用产线数」列（实现：列表行 render 时调 `listPipelineBindings({pipelineId: row.id}).length`，或后端 join 时 INSERT `binding_count`）
- Form.Item 删产线下拉、server_roles 编辑器、schedule cron 输入
- 行操作删「运行」按钮
- 详情面板加「被以下产线引用」section，列出 `listPipelineBindings({pipelineId: id})`，每条点击跳转 `/admin/product-lines/:id/bindings`

修改约 150-200 行，保留：name/description/graph 画布编辑/variables/triggerParams/enabled。

- [ ] **Step 3: 改 web/src/api/test-pipelines.ts**

interface 删 `schedule` / `productLineId` / `serverRoles`（或改为可选）。`createTestPipeline` payload 删这些。

- [ ] **Step 4: 浏览器手测**

```bash
cd web && pnpm dev
```

打开 http://localhost:5173/admin/test-pipelines，确认：
- 列表无产线列、无 schedule 列
- 新建表单无产线下拉
- 详情页有"被以下产线引用"

- [ ] **Step 5: 跑 web build 看不破**

```bash
cd web && pnpm build 2>&1 | tail -5
```

预期：build 干净。

- [ ] **Step 6: commit**

```bash
git add web/src/api/pipeline-bindings.ts web/src/api/test-pipelines.ts web/src/pages/TestPipelinesPage.tsx
git commit -m "feat(web): TestPipelinesPage 简化（去产线/server_roles/schedule）+ pipeline-bindings API client"
```

---

### Task 3.2: 产线详情页 Pipeline 绑定 Tab + binding 编辑表单

**Files:**
- Modify: `web/src/pages/ProductLineDetailPage.tsx`（加 Tab）
- Create: `web/src/components/PipelineBindingForm.tsx`（编辑表单 + Server 分配控件）

- [ ] **Step 1: 写 PipelineBindingForm.tsx**

```typescript
// web/src/components/PipelineBindingForm.tsx
import React, { useEffect, useState } from 'react'
import { Form, Input, Select, Button, Modal, message, Space, Tag } from 'antd'
import { ExclamationCircleTwoTone } from '@ant-design/icons'
import { getTestPipelines, type TestPipeline } from '../api/test-pipelines'
import { getTestServers, type TestServer } from '../api/test-servers'
import { upsertPipelineBinding, type PipelineBinding } from '../api/pipeline-bindings'

interface Props {
  productLineId: number
  initialValue?: PipelineBinding
  onSuccess: () => void
  onCancel: () => void
  visible: boolean
}

const RESERVED_REF_KEYS = ['fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3', 'fix_bug_l4']

export const PipelineBindingForm: React.FC<Props> = ({
  productLineId, initialValue, onSuccess, onCancel, visible,
}) => {
  const [form] = Form.useForm()
  const [pipelines, setPipelines] = useState<TestPipeline[]>([])
  const [servers, setServers] = useState<TestServer[]>([])
  const [scriptRoles, setScriptRoles] = useState<string[]>([])

  useEffect(() => {
    Promise.all([getTestPipelines(), getTestServers(productLineId)])
      .then(([ps, ss]) => { setPipelines(ps); setServers(ss) })
  }, [productLineId])

  useEffect(() => {
    if (initialValue) {
      form.setFieldsValue({ ...initialValue })
      updateScriptRoles(initialValue.pipelineId)
    }
  }, [initialValue, form])

  function updateScriptRoles(pipelineId: number) {
    const p = pipelines.find(x => x.id === pipelineId)
    if (!p) { setScriptRoles([]); return }
    try {
      const graph = typeof p.graph === 'string' ? JSON.parse(p.graph) : p.graph
      const roles = new Set<string>()
      for (const node of graph.nodes ?? []) {
        if (node.stageType === 'script' || node.nodeTypeKey === 'script') {
          for (const r of node.targetRoles ?? []) roles.add(r)
        }
      }
      setScriptRoles(Array.from(roles))
    } catch {
      setScriptRoles([])
    }
  }

  async function handleSubmit(values: Record<string, unknown>) {
    try {
      await upsertPipelineBinding({
        productLineId,
        refKey: values.refKey as string,
        pipelineId: values.pipelineId as number,
        serverRoleAssignments: values.serverRoleAssignments as Record<string, string[]> ?? {},
        description: (values.description as string) ?? '',
      })
      message.success('保存成功')
      onSuccess()
    } catch (err: unknown) {
      message.error('保存失败：' + (err as Error).message)
    }
  }

  return (
    <Modal title={initialValue ? '编辑绑定' : '新增绑定'} open={visible} onCancel={onCancel} footer={null}>
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item name="refKey" label="ref_key" rules={[{ required: true }]}>
          <Select
            disabled={!!initialValue}
            showSearch
            allowClear
            mode="combobox"
            placeholder="约定保留：fix_bug_l1 / l2 / l3 / l4 ; 自由文本：自行命名"
          >
            {RESERVED_REF_KEYS.map(k => (
              <Select.Option key={k} value={k}>
                <Tag color="blue">约定</Tag> {k}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>

        <Form.Item name="pipelineId" label="引用 Pipeline" rules={[{ required: true }]}>
          <Select
            showSearch
            optionFilterProp="children"
            onChange={updateScriptRoles}
          >
            {pipelines.map(p => (
              <Select.Option key={p.id} value={p.id}>
                {p.name} <small>(#{p.id})</small>
              </Select.Option>
            ))}
          </Select>
        </Form.Item>

        {scriptRoles.length === 0 ? (
          <div style={{ color: '#999', marginBottom: 16 }}>此 pipeline 无需 server 分配</div>
        ) : (
          scriptRoles.map(role => (
            <Form.Item key={role} name={['serverRoleAssignments', role]} label={`Server 分配 - ${role}`}>
              <Select mode="multiple" allowClear>
                {servers.filter(s => s.role === role).map(s => (
                  <Select.Option key={s.id} value={String(s.id)}>{s.name} ({s.host})</Select.Option>
                ))}
              </Select>
            </Form.Item>
          ))
        )}

        <Form.Item name="description" label="描述">
          <Input.TextArea rows={2} />
        </Form.Item>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">保存</Button>
            <Button onClick={onCancel}>取消</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  )
}
```

- [ ] **Step 2: 改 ProductLineDetailPage.tsx 加 Tab**

在现有 Tab 列表（概览 / 项目 / 服务器 / IM 触发器）旁加一个：

```typescript
{
  key: 'bindings',
  label: 'Pipeline 绑定',
  children: <PipelineBindingsTab productLineId={Number(id)} />,
}
```

新建 `PipelineBindingsTab` 组件（可以放同文件 or 独立 file）：表格列出 `listPipelineBindings({productLineId})` 结果，每行有「编辑/解绑」按钮，调用 `PipelineBindingForm` 和 `deletePipelineBinding`。

- [ ] **Step 3: 浏览器手测**

```bash
cd web && pnpm dev
```

进 http://localhost:5173/admin/product-lines/:id 点 "Pipeline 绑定" tab，测：
- 列表显示
- 新增 binding 表单弹窗
- 选 pipeline 后 server 分配控件按 graph.script 节点动态显示 / 隐藏
- 解绑

- [ ] **Step 4: build**

```bash
cd web && pnpm build 2>&1 | tail -5
```

预期：build 干净。

- [ ] **Step 5: 更新冒烟手册场景 4**

把 `docs/smoke-pipeline-decoupling.md` 场景 4 写好。

- [ ] **Step 6: commit**

```bash
git add web/src/components/PipelineBindingForm.tsx web/src/pages/ProductLineDetailPage.tsx \
  docs/smoke-pipeline-decoupling.md
git commit -m "feat(web): 产线 Pipeline 绑定 Tab + 编辑表单（Server 分配按 graph.script 动态显示）"
```

---

## 阶段 4：老 server_roles 字段下线（推迟，本期标 deferred 不做）

> ⚠️ **本阶段推迟到生产稳定 1 周后再做**，本 plan 列出但本期不执行。

### Task 4.1: schema-v43 DROP server_roles

**Files:**
- Create: `src/db/schema-v43.sql`

```sql
-- v43: 删 test_pipelines.server_roles 字段（阶段 1 后已 deprecated 1 周以上）
-- 见 design §6.1 阶段 4

ALTER TABLE test_pipelines DROP COLUMN IF EXISTS server_roles;
```

migrate.ts / helpers/db.ts 追加 v43。

### Task 4.2: executor 老兼容路径删除

修改 `src/pipeline/executor.ts:runPipeline`，去掉 `else if (pipeline.productLineId && Object.keys(pipeline.serverRoles ?? {}).length > 0)` 分支（老 fallback）。test_pipelines.serverRoles 字段已删，TypeScript 类型也不再有该字段。

### Task 4.3: commit + verify

跑全套测试 + 浏览器手测，确认无回归。

---

## 收尾

- [ ] **跑全套验证（plan 落地后）**

```bash
pnpm typecheck
pnpm test 2>&1 | tail -8
cd web && pnpm build 2>&1 | tail -5
```

预期：
- typecheck 干净
- pnpm test: ~1103 pass / 6 fail (baseline) / 10 todo
- web build 干净

- [ ] **本地 docker 部署验证**

```bash
./deploy.sh up
```

预期：
- migrate 跑 v42 成功
- chatops + postgres healthy
- /health 返回 ok

- [ ] **冒烟手册执行**

按 `docs/smoke-pipeline-decoupling.md` 4 个场景手动验证。

---

## Definition of Done

阶段 1-3 完整 ship 的判定（阶段 4 推迟）：

1. ✓ schema-v42 已应用，pipeline_bindings 表存在
2. ✓ 老 pipeline 自动迁移为 binding（断言 §3.3 步骤 7）
3. ✓ coordinator.findPipelineByLevel 删除 + handleAnalysisComplete 走 binding 路径
4. ✓ runPipeline 入参类型变更，executor 支持 hydrate from server id list
5. ✓ scheduler 模块完全删除
6. ✓ admin API `/admin/api/pipeline-bindings` CRUD 工作
7. ✓ TestPipelinesPage 简化（去产线/server_roles/schedule）
8. ✓ ProductLineDetailPage Pipeline 绑定 Tab + 编辑表单浏览器手测通过
9. ✓ 集成测试覆盖跨产线复用 + binding 路径
10. ✓ baseline 6 dingtalk-sync fail 不变；新增 ~14 case 全 PASS
11. ✓ 冒烟手册 4 场景全部填写且执行通过
12. ✓ 本地 docker 部署 healthy
