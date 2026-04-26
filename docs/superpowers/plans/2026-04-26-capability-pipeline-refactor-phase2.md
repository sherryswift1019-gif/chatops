# 能力(Capability)与流水线(Pipeline)分工重构 — 阶段 2 sub-plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `im_triggers` + `product_line_im_triggers` 表，把 capabilities 表的"IM 入口"职责剥离过去；重构 claude-runner 路由层 + 清理剩余 3 处硬编码字典（FAILURE_MSGS / CAP_NAMES / examples）；前端拆 CapabilitiesPage → IMTriggersPage + 改造 ProductLineDetailPage / ApprovalRulesPage。

**Architecture:** schema-v32 一次性 ship 所有 DDL + 数据迁移；过渡期 `product_line_capabilities` 表保留（LLM agent RBAC 仍用）；旧 capability 字段（default_pipeline_id 等）暂不删，phase 2 末尾或后续 cleanup PR 处理。前后端必须同 PR ship 防止形状不匹配。

**Tech Stack:** TypeScript (ES2022, NodeNext), Fastify 5, PostgreSQL 16 (raw SQL), React 18 + Ant Design 5, Vitest.

**Spec:** [`../specs/2026-04-26-capability-pipeline-refactor-design.md`](../specs/2026-04-26-capability-pipeline-refactor-design.md) §3.1/§3.2/§5.2/§7
**Master plan:** [`./2026-04-26-capability-pipeline-refactor.md`](./2026-04-26-capability-pipeline-refactor.md) §C
**Phase 1 merge:** main = `7695d2a merge: phase 1 ...`

---

## 重要事实修正（spec / 主 plan 与实际代码的偏差）

- **`approval_rules` 表字段是 `action` 不是 `capability_key`**（spec §5.2 描述有误）。phase 2 改名是 `action` → `im_trigger_key`，repository `ApprovalRule.action` → `ApprovalRule.imTriggerKey`，router `route(action, env)` → `route(imTriggerKey, env)`。
- 当前 `product_line_capabilities` 已有 `trigger_sources` 字段（schema-v22 加的）；新表 `product_line_im_triggers` 复制时要包含该字段。
- 当前 `claude-runner.ts` 还有 4 处硬编码：FAILURE_MSGS @ 39 / CAP_NAMES @ 51 / examples 字典 @ 532 / HANDLER_CAPABILITIES @ 378。**前 3 处 phase 2 处理；HANDLER_CAPABILITIES 推迟到 phase 3**（它是 capability 走 handler-path 还是通用对话的分流，跟 IM 入口职责正交）。

## 阶段 2 范围与不动的部分

| 范围 | 在本 plan 内 | 不在本 plan 内 |
|------|------------|--------------|
| schema-v32 (im_triggers + product_line_im_triggers + ALTER approval_rules + 数据迁移) | ✅ Task 1 | — |
| im-triggers repository | ✅ Task 2 | — |
| product-line-im-triggers repository | ✅ Task 3 | — |
| approval_rules `action` → `im_trigger_key` 改名（DB + repo + router/gate） | ✅ Task 4 | — |
| claude-runner 路由层（detectIntent + 权限校验） | ✅ Task 5 | — |
| claude-runner 字典清理（FAILURE_MSGS / CAP_NAMES / examples） + sendGreeting 重写 | ✅ Task 6 | — |
| admin API: im-triggers + product-lines IM 触发器 endpoint | ✅ Task 7 | — |
| 前端 IMTriggersPage 新建 + 菜单 + 路由 | ✅ Task 8 | — |
| 前端 CapabilitiesPage 重构 + ProductLineDetailPage Tab + ApprovalRulesPage 改造 | ✅ Task 9 | — |
| 冒烟手册 + 阶段验收 | ✅ Task 10 | — |
| `HANDLER_CAPABILITIES` 集合 | ❌ | phase 3（与 capability 职责重命名一起处理） |
| `DROP COLUMN capabilities.default_pipeline_id / category / param_schema / playbook / needs_approval` | ❌ | phase 2 完毕后单独 cleanup PR |
| `product_line_capabilities` 表删除 | ❌ | LLM agent RBAC 仍需要，长期保留 |

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema-v32.sql` | 创建 | CREATE 2 表 + ALTER approval_rules + 数据迁移 + 末尾 DO $$ 断言 |
| `src/db/migrate.ts` | 修改 | 追加 v32 块 |
| `src/__tests__/helpers/db.ts` | 修改 | SCHEMA_FILES 加 schema-v32.sql |
| `src/db/repositories/im-triggers.ts` | 创建 | list / get / create / update / delete + checkAccess |
| `src/db/repositories/product-line-im-triggers.ts` | 创建 | list / batchSet / checkAccess(plId, key, env, role, source) |
| `src/db/repositories/approval-rules.ts` | 修改 | `action` → `imTriggerKey` + mapRow 调整 |
| `src/__tests__/unit/im-triggers-repo.test.ts` | 创建 | repository 5+ 测试 |
| `src/__tests__/unit/product-line-im-triggers-repo.test.ts` | 创建 | repository 5+ 测试 |
| `src/__tests__/unit/approval-router-im-trigger.test.ts` | 创建 | router 改名后行为测试 |
| `src/agent/claude-runner.ts` | 修改 | 路由层重构 + 字典清理 + sendGreeting 改写 |
| `src/agent/runner-greet-filter.ts` | 修改 | 改读 product-line-im-triggers |
| `src/approval/router.ts` | 修改 | `route(action, env)` → `route(imTriggerKey, env)` |
| `src/approval/gate.ts` | 修改 | 调用方字段改名 |
| `src/admin/routes/im-triggers.ts` | 创建 | GET/POST/PUT/DELETE im_triggers |
| `src/admin/routes/product-lines.ts` | 修改 | IM 触发器 endpoint 改用 product_line_im_triggers |
| `src/admin/index.ts` | 修改 | 注册新 route |
| `src/__tests__/unit/admin-im-triggers-route.test.ts` | 创建 | fastify-inject 测试（用 phase 1 引入的 admin-app helper） |
| `web/src/types/imTrigger.ts` | 创建 | 类型 |
| `web/src/api/imTriggers.ts` | 创建 | API client |
| `web/src/pages/IMTriggersPage.tsx` | 创建 | IM 触发器管理页 |
| `web/src/pages/CapabilitiesPage.tsx` | 修改 | 移除 IM 入口字段（default_pipeline_id 等不显示） |
| `web/src/pages/ProductLineDetailPage.tsx` | 修改 | Tab 改名 IM 触发器 + 数据源 |
| `web/src/pages/ApprovalRulesPage.tsx` | 修改 | `action` 字段改 `imTriggerKey` + 下拉源换 |
| `web/src/layout/AdminLayout.tsx` | 修改 | 菜单加 IM 触发器 项 |
| `web/src/router.tsx` 或同类 | 修改 | 路由 `/admin/im-triggers` 注册 |
| `docs/smoke-im-triggers.md` | 创建 | 阶段 2 冒烟手册 |

## 执行前提

- [ ] **Worktree**：建议 `EnterWorktree` 创建 worktree（refactor-cap-pipe-phase2）；首次进入后 `git rebase main` 确保拿到 phase 1 的 7695d2a HEAD（phase 0/1 都遇到过 EnterWorktree base 偏旧问题）。
- [ ] **依赖检查**：`pnpm migrate` 应用到 v31；`pnpm test src/__tests__/unit/capabilities-repo-extended-fields.test.ts` 5 PASS。

---

## Task 1: schema-v32 + 数据迁移 + SCHEMA_FILES

**Files:**
- Create: `src/db/schema-v32.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`

- [ ] **Step 1: 创建 schema-v32.sql**

```sql
-- v32: phase 2 — IM 入口职责从 capabilities 剥离到 im_triggers
-- 见 spec §3.1/§3.2/§5.2

-- ── 1. CREATE TABLE im_triggers ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS im_triggers (
  id                       SERIAL PRIMARY KEY,
  key                      TEXT NOT NULL UNIQUE,
  display_name             TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  pipeline_id              INTEGER REFERENCES test_pipelines(id) ON DELETE RESTRICT,
  intent_hints             TEXT NOT NULL DEFAULT '',
  examples                 JSONB NOT NULL DEFAULT '[]',
  failure_messages         JSONB NOT NULL DEFAULT '{}',
  default_approval_rule_id INTEGER REFERENCES approval_rules(id) ON DELETE SET NULL,
  is_system                BOOLEAN NOT NULL DEFAULT FALSE,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_im_triggers_pipeline ON im_triggers(pipeline_id);

-- pipeline_id 是 nullable: 数据迁移时 capabilities.default_pipeline_id 可能为 null;
-- 不影响 IM 触发(只在 trigger 时报"该入口未绑定 pipeline")。后续可改 NOT NULL。

-- ── 2. CREATE TABLE product_line_im_triggers ──────────────────────────────
CREATE TABLE IF NOT EXISTS product_line_im_triggers (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  im_trigger_key   TEXT NOT NULL REFERENCES im_triggers(key) ON UPDATE CASCADE ON DELETE CASCADE,
  env_name         TEXT NOT NULL DEFAULT '*',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_roles    JSONB NOT NULL DEFAULT '["developer","tester","ops","admin"]'::jsonb,
  trigger_sources  JSONB NOT NULL DEFAULT '["im","web"]'::jsonb,
  approval_rule_id INTEGER REFERENCES approval_rules(id) ON DELETE SET NULL,
  UNIQUE(product_line_id, im_trigger_key, env_name)
);
CREATE INDEX IF NOT EXISTS idx_plit_lookup
  ON product_line_im_triggers(product_line_id, im_trigger_key, env_name);

-- ── 3. ALTER approval_rules: action → im_trigger_key ──────────────────────
ALTER TABLE approval_rules RENAME COLUMN action TO im_trigger_key;
-- 注:不立刻加 FK 约束(im_trigger_key 可能含通配符 '*'),保持灵活。
-- router.ts 的路由逻辑保留通配符语义。

-- ── 4. 数据迁移: capabilities → im_triggers ───────────────────────────────
-- 入口类 capability 定义: category IN ('query','action','admin')
-- 这是 spec §3.4 提到的"入口类"——其它 category(env_prep/verify/testing/result)
-- 是 2026-04-14 unified spec 残留,不是 IM 入口,跳过。
INSERT INTO im_triggers (key, display_name, description, pipeline_id, examples, failure_messages, is_system, enabled)
SELECT
  key,
  display_name,
  description,
  default_pipeline_id,
  COALESCE(
    -- 如果 capabilities 行已有 examples(罕见),拷贝过来;否则用空数组(后续 manual fill)
    CASE WHEN jsonb_typeof(NULLIF(playbook, 'null'::jsonb)) = 'array' THEN '[]'::jsonb ELSE '[]'::jsonb END,
    '[]'::jsonb
  ) AS examples,
  '{}'::jsonb AS failure_messages,
  is_system,
  TRUE  -- 默认 enabled
FROM capabilities
WHERE category IN ('query', 'action', 'admin')
ON CONFLICT (key) DO NOTHING;

-- ── 5. 数据迁移: product_line_capabilities → product_line_im_triggers ─────
-- 仅迁移 capability_key 在 im_triggers 里的行(避免外键违反)
INSERT INTO product_line_im_triggers
  (product_line_id, im_trigger_key, env_name, enabled, allowed_roles, trigger_sources)
SELECT
  plc.product_line_id,
  plc.capability_key,
  plc.env_name,
  plc.enabled,
  plc.allowed_roles,
  plc.trigger_sources
FROM product_line_capabilities plc
WHERE EXISTS (SELECT 1 FROM im_triggers it WHERE it.key = plc.capability_key)
ON CONFLICT (product_line_id, im_trigger_key, env_name) DO NOTHING;

-- ── 6. 断言: im_triggers 至少有 5 行(基础入口能力数量下限) ───────────────
DO $$
DECLARE
  v_im_triggers_count INT;
  v_entry_caps_count INT;
BEGIN
  SELECT COUNT(*) INTO v_entry_caps_count
    FROM capabilities WHERE category IN ('query', 'action', 'admin');

  SELECT COUNT(*) INTO v_im_triggers_count FROM im_triggers;

  IF v_im_triggers_count < v_entry_caps_count THEN
    RAISE EXCEPTION 'schema-v32 数据迁移失败: im_triggers 行数(%)<入口类 capability 数(%)', v_im_triggers_count, v_entry_caps_count;
  END IF;

  IF v_im_triggers_count < 5 THEN
    RAISE EXCEPTION 'schema-v32 数据迁移失败: im_triggers 行数(%)异常少,期望 ≥5', v_im_triggers_count;
  END IF;

  RAISE NOTICE 'schema-v32 数据迁移验证通过: im_triggers=% / 入口类 capabilities=%', v_im_triggers_count, v_entry_caps_count;
END $$;
```

- [ ] **Step 2: migrate.ts 追加 v32 块**

Edit `src/db/migrate.ts`. 在 v31 块之后追加：

```typescript
const schemaV32 = readFileSync(join(__dirname, 'schema-v32.sql'), 'utf8')
await pool.query(schemaV32)
console.log('[migrate] schema-v32 applied')
```

更新最终 console.log 摘要加 `+ v32 + im_triggers v32`。

- [ ] **Step 3: SCHEMA_FILES 加 v32**

Edit `src/__tests__/helpers/db.ts`. 在 v31 后追加：

```typescript
  // v32 (im_triggers + product_line_im_triggers + approval_rules 改名): 
  // 新表 + ALTER + 数据迁移。所有依赖 IM 触发器的测试期望 im_triggers 至少有
  // 入口类 capability 行数 (~5+)。同 v31 forward policy。
  'schema-v32.sql',
]
```

- [ ] **Step 4: 跑 migrate 验证**

```bash
pnpm migrate
```
Expected: 输出含 `[migrate] schema-v32 applied` + `NOTICE: schema-v32 数据迁移验证通过`。

- [ ] **Step 5: 跑全套测试确认 phase 1 测试不破**

```bash
pnpm test
```
Expected: 同 phase 1 baseline (6 dingtalk-sync fail，零新增)。

⚠️ Note: `approval-rules` 改名后，相关测试可能 fail（因为 repository 还没改 `action` → `imTriggerKey`）。这是 Task 4 的事；如果这里 test 报相关 fail，记下，Task 4 修复。

- [ ] **Step 6: Commit**

```bash
git add src/db/schema-v32.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat(db): im_triggers + product_line_im_triggers 表 + 数据迁移(schema-v32)"
```

---

## Task 2: im-triggers repository + 单测

**Files:**
- Create: `src/db/repositories/im-triggers.ts`
- Create: `src/__tests__/unit/im-triggers-repo.test.ts`

- [ ] **Step 1: 写测试**

Create `src/__tests__/unit/im-triggers-repo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { listIMTriggers, getIMTrigger, createIMTrigger, updateIMTrigger, deleteIMTrigger } from '../../db/repositories/im-triggers.js'

describe('im-triggers repository', () => {
  it('lists IM triggers (migrated from entry-class capabilities)', async () => {
    const triggers = await listIMTriggers()
    expect(triggers.length).toBeGreaterThanOrEqual(5)
    for (const t of triggers) {
      expect(typeof t.key).toBe('string')
      expect(typeof t.displayName).toBe('string')
      expect(t.examples).toBeInstanceOf(Array)
      expect(typeof t.failureMessages).toBe('object')
      expect(typeof t.enabled).toBe('boolean')
    }
  })

  it('getIMTrigger by key returns row or null', async () => {
    const triggers = await listIMTriggers()
    if (triggers.length === 0) return
    const found = await getIMTrigger(triggers[0].key)
    expect(found).not.toBeNull()
    expect(found!.key).toBe(triggers[0].key)
    expect(await getIMTrigger('nonexistent_xxx')).toBeNull()
  })

  it('createIMTrigger / updateIMTrigger / deleteIMTrigger round-trip', async () => {
    const created = await createIMTrigger({
      key: 'test_trigger_phase2',
      displayName: '测试触发器',
      description: 'phase 2 unit test',
      pipelineId: null,
      intentHints: '',
      examples: ['测试一下'],
      failureMessages: { test_error: '测试错误' },
      defaultApprovalRuleId: null,
      isSystem: false,
      enabled: true,
    })
    expect(created.id).toBeGreaterThan(0)
    expect(created.key).toBe('test_trigger_phase2')

    const updated = await updateIMTrigger(created.id, { displayName: '改名了' })
    expect(updated!.displayName).toBe('改名了')

    await deleteIMTrigger(created.id)
    expect(await getIMTrigger('test_trigger_phase2')).toBeNull()
  })

  it('intent_hints / examples / failure_messages backfill correctly', async () => {
    const all = await listIMTriggers()
    for (const t of all) {
      expect(typeof t.intentHints).toBe('string')
      expect(Array.isArray(t.examples)).toBe(true)
      expect(typeof t.failureMessages).toBe('object')
    }
  })

  it('pipeline_id may be null (some entry capabilities had no default pipeline)', async () => {
    const all = await listIMTriggers()
    const withPipeline = all.filter(t => t.pipelineId !== null)
    const withoutPipeline = all.filter(t => t.pipelineId === null)
    // 至少存在某种状态;测试不强制要求两类都存在
    expect(withPipeline.length + withoutPipeline.length).toBe(all.length)
  })
})
```

Run: `pnpm test src/__tests__/unit/im-triggers-repo.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 repository**

Create `src/db/repositories/im-triggers.ts`:

```typescript
import { getPool } from '../client.js'

export interface IMTrigger {
  id: number
  key: string
  displayName: string
  description: string
  pipelineId: number | null
  intentHints: string
  examples: string[]
  failureMessages: Record<string, string>
  defaultApprovalRuleId: number | null
  isSystem: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): IMTrigger {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: (r.description ?? '') as string,
    pipelineId: (r.pipeline_id ?? null) as number | null,
    intentHints: (r.intent_hints ?? '') as string,
    examples: (r.examples ?? []) as string[],
    failureMessages: (r.failure_messages ?? {}) as Record<string, string>,
    defaultApprovalRuleId: (r.default_approval_rule_id ?? null) as number | null,
    isSystem: r.is_system as boolean,
    enabled: r.enabled as boolean,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listIMTriggers(): Promise<IMTrigger[]> {
  const { rows } = await getPool().query('SELECT * FROM im_triggers ORDER BY key')
  return rows.map(mapRow)
}

export async function getIMTrigger(key: string): Promise<IMTrigger | null> {
  const { rows } = await getPool().query('SELECT * FROM im_triggers WHERE key = $1', [key])
  return rows[0] ? mapRow(rows[0]) : null
}

export interface CreateIMTriggerInput {
  key: string
  displayName: string
  description?: string
  pipelineId?: number | null
  intentHints?: string
  examples?: string[]
  failureMessages?: Record<string, string>
  defaultApprovalRuleId?: number | null
  isSystem?: boolean
  enabled?: boolean
}

export async function createIMTrigger(input: CreateIMTriggerInput): Promise<IMTrigger> {
  const { rows } = await getPool().query(
    `INSERT INTO im_triggers
       (key, display_name, description, pipeline_id, intent_hints, examples, failure_messages,
        default_approval_rule_id, is_system, enabled)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
     RETURNING *`,
    [
      input.key, input.displayName, input.description ?? '',
      input.pipelineId ?? null, input.intentHints ?? '',
      JSON.stringify(input.examples ?? []),
      JSON.stringify(input.failureMessages ?? {}),
      input.defaultApprovalRuleId ?? null,
      input.isSystem ?? false, input.enabled ?? true,
    ],
  )
  return mapRow(rows[0])
}

export async function updateIMTrigger(id: number, patch: Partial<CreateIMTriggerInput>): Promise<IMTrigger | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let idx = 1
  if (patch.displayName !== undefined) { fields.push(`display_name = $${idx++}`); values.push(patch.displayName) }
  if (patch.description !== undefined) { fields.push(`description = $${idx++}`); values.push(patch.description) }
  if (patch.pipelineId !== undefined) { fields.push(`pipeline_id = $${idx++}`); values.push(patch.pipelineId) }
  if (patch.intentHints !== undefined) { fields.push(`intent_hints = $${idx++}`); values.push(patch.intentHints) }
  if (patch.examples !== undefined) { fields.push(`examples = $${idx++}::jsonb`); values.push(JSON.stringify(patch.examples)) }
  if (patch.failureMessages !== undefined) { fields.push(`failure_messages = $${idx++}::jsonb`); values.push(JSON.stringify(patch.failureMessages)) }
  if (patch.defaultApprovalRuleId !== undefined) { fields.push(`default_approval_rule_id = $${idx++}`); values.push(patch.defaultApprovalRuleId) }
  if (patch.enabled !== undefined) { fields.push(`enabled = $${idx++}`); values.push(patch.enabled) }
  if (fields.length === 0) return getIMTriggerById(id)
  fields.push(`updated_at = NOW()`)
  values.push(id)
  const { rows } = await getPool().query(
    `UPDATE im_triggers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getIMTriggerById(id: number): Promise<IMTrigger | null> {
  const { rows } = await getPool().query('SELECT * FROM im_triggers WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteIMTrigger(id: number): Promise<void> {
  await getPool().query('DELETE FROM im_triggers WHERE id = $1', [id])
}
```

- [ ] **Step 3: 跑测试**

```bash
pnpm test src/__tests__/unit/im-triggers-repo.test.ts
```
Expected: 5 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/db/repositories/im-triggers.ts src/__tests__/unit/im-triggers-repo.test.ts
git commit -m "feat(db): im-triggers repository + CRUD + 单测"
```

---

## Task 3: product-line-im-triggers repository + 单测

**Files:**
- Create: `src/db/repositories/product-line-im-triggers.ts`
- Create: `src/__tests__/unit/product-line-im-triggers-repo.test.ts`

- [ ] **Step 1: 写测试**

Create `src/__tests__/unit/product-line-im-triggers-repo.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { getPool } from '../../db/client.js'
import { resetTestDb } from '../helpers/db.js'
import {
  listProductLineIMTriggers,
  batchSetProductLineIMTriggers,
  checkIMTriggerAccess,
} from '../../db/repositories/product-line-im-triggers.js'

let testPlId: number

describe('product-line-im-triggers repository', () => {
  beforeAll(async () => {
    await resetTestDb()
    // create a test product line
    const { rows } = await getPool().query(
      `INSERT INTO product_lines (name, display_name) VALUES ('test_pl_phase2', 'Phase 2 Test PL') RETURNING id`,
    )
    testPlId = rows[0].id as number
  })

  it('checkIMTriggerAccess: 未配置返回 not allowed', async () => {
    const r = await checkIMTriggerAccess(testPlId, 'view_logs', '*', 'developer', 'im')
    expect(r.allowed).toBe(false)
  })

  it('batchSetProductLineIMTriggers + checkIMTriggerAccess happy path', async () => {
    await batchSetProductLineIMTriggers(testPlId, [
      { imTriggerKey: 'view_logs', envName: '*', enabled: true,
        allowedRoles: ['developer', 'ops'], triggerSources: ['im','web'] },
    ])
    const r = await checkIMTriggerAccess(testPlId, 'view_logs', '*', 'developer', 'im')
    expect(r.allowed).toBe(true)
  })

  it('checkIMTriggerAccess: source 不在 trigger_sources 列表 → source-blocked', async () => {
    await batchSetProductLineIMTriggers(testPlId, [
      { imTriggerKey: 'view_logs', envName: '*', enabled: true,
        allowedRoles: ['developer'], triggerSources: ['web'] },
    ])
    const r = await checkIMTriggerAccess(testPlId, 'view_logs', '*', 'developer', 'im')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('source-blocked')
  })

  it('checkIMTriggerAccess: enabled=false → blocked', async () => {
    await batchSetProductLineIMTriggers(testPlId, [
      { imTriggerKey: 'view_logs', envName: '*', enabled: false,
        allowedRoles: ['developer'], triggerSources: ['im','web'] },
    ])
    const r = await checkIMTriggerAccess(testPlId, 'view_logs', '*', 'developer', 'im')
    expect(r.allowed).toBe(false)
  })

  it('listProductLineIMTriggers 返回该产线全部条目', async () => {
    const all = await listProductLineIMTriggers(testPlId)
    expect(all.length).toBeGreaterThanOrEqual(1)
    expect(all.some(r => r.imTriggerKey === 'view_logs')).toBe(true)
  })
})
```

Run: `pnpm test src/__tests__/unit/product-line-im-triggers-repo.test.ts`
Expected: FAIL.

- [ ] **Step 2: 实现 repository**

Create `src/db/repositories/product-line-im-triggers.ts`:

```typescript
import { getPool } from '../client.js'

export interface ProductLineIMTrigger {
  id: number
  productLineId: number
  imTriggerKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources: string[]
  approvalRuleId: number | null
}

function mapRow(r: Record<string, unknown>): ProductLineIMTrigger {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    imTriggerKey: r.im_trigger_key as string,
    envName: r.env_name as string,
    enabled: r.enabled as boolean,
    allowedRoles: (r.allowed_roles ?? []) as string[],
    triggerSources: (r.trigger_sources ?? ['im','web']) as string[],
    approvalRuleId: (r.approval_rule_id ?? null) as number | null,
  }
}

export async function listProductLineIMTriggers(productLineId: number): Promise<ProductLineIMTrigger[]> {
  const { rows } = await getPool().query(
    'SELECT * FROM product_line_im_triggers WHERE product_line_id = $1 ORDER BY im_trigger_key, env_name',
    [productLineId],
  )
  return rows.map(mapRow)
}

export interface AccessCheck {
  allowed: boolean
  reason?: 'not-configured' | 'disabled' | 'role-not-allowed' | 'source-blocked'
}

export async function checkIMTriggerAccess(
  productLineId: number,
  imTriggerKey: string,
  envName: string,
  role: string,
  source: 'im' | 'web' = 'im',
): Promise<AccessCheck> {
  const { rows } = await getPool().query(
    `SELECT * FROM product_line_im_triggers
      WHERE product_line_id = $1 AND im_trigger_key = $2 AND env_name IN ($3, '*')
      ORDER BY (env_name = $3) DESC LIMIT 1`,
    [productLineId, imTriggerKey, envName],
  )
  if (rows.length === 0) return { allowed: false, reason: 'not-configured' }
  const r = mapRow(rows[0])
  if (!r.enabled) return { allowed: false, reason: 'disabled' }
  if (!r.allowedRoles.includes(role)) return { allowed: false, reason: 'role-not-allowed' }
  if (!r.triggerSources.includes(source)) return { allowed: false, reason: 'source-blocked' }
  return { allowed: true }
}

export interface SetIMTriggerInput {
  imTriggerKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources?: string[]
  approvalRuleId?: number | null
}

export async function batchSetProductLineIMTriggers(productLineId: number, items: SetIMTriggerInput[]): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    for (const it of items) {
      await client.query(
        `INSERT INTO product_line_im_triggers
           (product_line_id, im_trigger_key, env_name, enabled, allowed_roles, trigger_sources, approval_rule_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         ON CONFLICT (product_line_id, im_trigger_key, env_name) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           allowed_roles = EXCLUDED.allowed_roles,
           trigger_sources = EXCLUDED.trigger_sources,
           approval_rule_id = EXCLUDED.approval_rule_id`,
        [productLineId, it.imTriggerKey, it.envName, it.enabled,
         JSON.stringify(it.allowedRoles), JSON.stringify(it.triggerSources ?? ['im','web']),
         it.approvalRuleId ?? null],
      )
    }
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}
```

- [ ] **Step 3: 跑测试**

```bash
pnpm test src/__tests__/unit/product-line-im-triggers-repo.test.ts
```
Expected: 5 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/db/repositories/product-line-im-triggers.ts \
        src/__tests__/unit/product-line-im-triggers-repo.test.ts
git commit -m "feat(db): product-line-im-triggers repository + checkAccess"
```

---

## Task 4: approval_rules `action` → `imTriggerKey` 改名

**Files:**
- Modify: `src/db/repositories/approval-rules.ts`
- Modify: `src/approval/router.ts`
- Modify: `src/approval/gate.ts`
- Create: `src/__tests__/unit/approval-router-im-trigger.test.ts`

- [ ] **Step 1: 写测试**

Create `src/__tests__/unit/approval-router-im-trigger.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ApprovalRouter } from '../../approval/router.js'

describe('ApprovalRouter — phase 2 imTriggerKey', () => {
  it('matches exact imTriggerKey + env', () => {
    const r = new ApprovalRouter([
      { id: 1, productLineId: null, imTriggerKey: 'deploy', env: 'prod',
        primaryApprovers: ['ops'], backupApprovers: [], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
    ])
    expect(r.route('deploy', 'prod')?.id).toBe(1)
    expect(r.route('deploy', 'dev')).toBeNull()
  })

  it('falls back to wildcard env', () => {
    const r = new ApprovalRouter([
      { id: 2, productLineId: null, imTriggerKey: 'deploy', env: '*',
        primaryApprovers: ['ops'], backupApprovers: [], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
    ])
    expect(r.route('deploy', 'staging')?.id).toBe(2)
  })

  it('falls back to wildcard imTriggerKey', () => {
    const r = new ApprovalRouter([
      { id: 3, productLineId: null, imTriggerKey: '*', env: 'prod',
        primaryApprovers: ['ops'], backupApprovers: [], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
    ])
    expect(r.route('rollback', 'prod')?.id).toBe(3)
  })
})
```

Run: `pnpm test src/__tests__/unit/approval-router-im-trigger.test.ts`
Expected: FAIL（imTriggerKey 字段不存在）。

- [ ] **Step 2: 改 ApprovalRule type + mapRow**

Edit `src/db/repositories/approval-rules.ts`. 改 `action: string` → `imTriggerKey: string`，mapRow 改读 `r.im_trigger_key`：

```typescript
export interface ApprovalRule {
  id: number
  productLineId: number | null
  imTriggerKey: string  // schema-v32: action → im_trigger_key
  env: string
  primaryApprovers: string[]
  backupApprovers: string[]
  primaryTimeoutMin: number
  totalTimeoutMin: number
}
```

mapRow 内 `action: r.action as string` → `imTriggerKey: r.im_trigger_key as string`。

所有 INSERT/UPDATE 语句字段也改：`action` → `im_trigger_key`。

- [ ] **Step 3: 改 router.ts**

Edit `src/approval/router.ts`。把所有 `action` 参数 / `r.action` 字段引用改为 `imTriggerKey`：

```typescript
route(imTriggerKey: string, env: string): ApprovalRule | null {
  const candidates = [
    this.find(imTriggerKey, env),
    this.find(imTriggerKey, '*'),
    this.find('*', env),
    this.find('*', '*'),
  ]
  return candidates.find((r): r is ApprovalRule => r !== null) ?? null
}

private find(imTriggerKey: string, env: string): ApprovalRule | null {
  return this.rules.find(r => r.imTriggerKey === imTriggerKey && r.env === env) ?? null
}
```

- [ ] **Step 4: 改 gate.ts**

Edit `src/approval/gate.ts`. 找所有 `.action` 引用改 `.imTriggerKey`，方法参数 `action` 改 `imTriggerKey`。

```bash
grep -n "action" src/approval/gate.ts
```
按 grep 结果逐处替换。

- [ ] **Step 5: 跑测试**

```bash
pnpm test src/__tests__/unit/approval-router-im-trigger.test.ts
pnpm typecheck
pnpm test
```
Expected: 新测试 3 PASS；typecheck 干净；全套不引入新 fail。

⚠️ 现有 `src/__tests__/unit/approval-router.test.ts`（如果有）可能也用 `action` 字段，可能 fail。如果 fail 是因为字段改名，把那些测试也改名。如果 fail 是其它原因，BLOCKED 报告。

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/approval-rules.ts \
        src/approval/router.ts src/approval/gate.ts \
        src/__tests__/unit/approval-router-im-trigger.test.ts \
        src/__tests__/unit/approval-router.test.ts  # 如果有改动
git commit -m "refactor(approval): action 字段改名为 imTriggerKey + router/gate 适配"
```

---

## Task 5: claude-runner 路由层 part 1 — detectIntent + 权限校验

**Files:**
- Modify: `src/agent/claude-runner.ts`

- [ ] **Step 1: 改 detectIntent 输出空间**

Edit `src/agent/claude-runner.ts:558` 附近的 `detectIntent` 方法。把 `listCapabilities()` 改为 `listIMTriggers()`，capList 字段从 capability.key/displayName 改为 trigger.key/displayName/intentHints：

```typescript
import { listIMTriggers, getIMTrigger } from '../db/repositories/im-triggers.js'

private async detectIntent(prompt: string): Promise<DetectedIntent | null> {
  const triggers = await listIMTriggers()
  const capList = triggers
    .filter(t => t.enabled)
    .map(t => `- ${t.key}: ${t.displayName}${t.intentHints ? ` (${t.intentHints})` : ''}`)
    .join('\n')
  // ... 其余 prompt 拼装逻辑保持原样,只 capList 内容变 ...
}
```

- [ ] **Step 2: 改 Step 4b 权限校验**

Edit `src/agent/claude-runner.ts` 的权限校验段（找 `checkCapabilityAccess` 调用，~340 行附近）。新引入 `checkIMTriggerAccess`：

```typescript
import { checkIMTriggerAccess } from '../db/repositories/product-line-im-triggers.js'

// 4b: 检查 IM 触发器在该产线下是否允许
if (productLineId) {
  const envName = intent.env ?? '*'
  const access = await checkIMTriggerAccess(productLineId, intent.capability, envName, userRole, 'im')
  if (!access.allowed) {
    const text = access.reason === 'source-blocked'
      ? `⛔ IM 触发器「${imTrigger.displayName}」在当前产线已禁止通过 IM 触发,请到管理后台执行。`
      : `⛔ 无法触发「${imTrigger.displayName}」: ${access.reason}`
    await adapter.sendMessage({ type: 'group', id: opts.groupId }, { text })
    return
  }
}
```

⚠️ 注意：`intent.capability` 命名仍叫 capability（detectIntent 输出的字段名），因为它现在指 `im_trigger.key`。命名不改（避免改太多）；后续 phase 3 可统一改成 `intent.imTriggerKey`。

⚠️ `imTrigger` 变量从哪来：之前的 `getCapabilityByKey(intent.capability)` 可能还在（保留作为 LLM agent config 来源）。新增 `const imTrigger = await getIMTrigger(intent.capability)` 用于 IM 入口元数据访问（displayName 拒绝文案）。

- [ ] **Step 3: 跑 typecheck + 全套测试**

```bash
pnpm typecheck && pnpm test
```
Expected: 无新 fail。

- [ ] **Step 4: Commit**

```bash
git add src/agent/claude-runner.ts
git commit -m "refactor(agent): claude-runner 路由层(detectIntent + 权限校验)改读 im_triggers"
```

---

## Task 6: claude-runner 路由层 part 2 — sendGreeting + 字典清理

**Files:**
- Modify: `src/agent/claude-runner.ts`
- Modify: `src/agent/runner-greet-filter.ts`

- [ ] **Step 1: 改 runner-greet-filter.ts 改读 im_triggers**

Edit `src/agent/runner-greet-filter.ts`. 把签名从接受 `(caps, plCaps, userRole)` 改为 `(triggers, plTriggers, userRole)`，逻辑相同（filter enabled + role + source 'im'）。

```typescript
import type { IMTrigger } from '../db/repositories/im-triggers.js'
import type { ProductLineIMTrigger } from '../db/repositories/product-line-im-triggers.js'

export function filterImTriggerableTriggers(
  triggers: IMTrigger[],
  plTriggers: ProductLineIMTrigger[],
  userRole: string,
): IMTrigger[] {
  const wildcardByKey = new Map<string, ProductLineIMTrigger>()
  for (const p of plTriggers) {
    if (p.envName === '*') wildcardByKey.set(p.imTriggerKey, p)
  }
  return triggers.filter(t => {
    if (!t.enabled) return false
    const p = wildcardByKey.get(t.key)
    if (!p) return false
    if (!p.enabled) return false
    if (!p.allowedRoles.includes(userRole)) return false
    if (!p.triggerSources.includes('im')) return false
    return true
  })
}
```

⚠️ 旧 `filterImTriggerableCapabilities(caps, plCaps, userRole)` 函数：保留（向后兼容期）但标记 deprecated；后续 cleanup PR 删除。

⚠️ 更新现有 `runner-greet-filter.test.ts`：可能需要新增 IMTrigger fixture（同 phase 1 那个 cap fixture 风格）。或者新建测试文件 `runner-im-trigger-filter.test.ts`。

- [ ] **Step 2: 改 sendGreeting 改读 im_triggers**

Edit `src/agent/claude-runner.ts:512` 附近的 `sendGreeting` 方法。把 `listCapabilities()` 改为 `listIMTriggers()`，相应的 `getProductLineCapabilities` 改为 `listProductLineIMTriggers`，调用 `filterImTriggerableTriggers`。examples 字段从硬编码字典改为 `t.examples`：

```typescript
import { listProductLineIMTriggers } from '../db/repositories/product-line-im-triggers.js'
import { filterImTriggerableTriggers } from './runner-greet-filter.js'

private async sendGreeting(...) {
  let triggers = (await listIMTriggers()).filter(t => t.enabled)
  if (productLineId) {
    const plTriggers = await listProductLineIMTriggers(productLineId)
    triggers = filterImTriggerableTriggers(triggers, plTriggers, userRole)
  }
  // ... 渲染:
  const capsList = triggers.map(t => {
    const example = (t.examples?.[0]) ?? null
    return example
      ? `- **${t.displayName}** — ${t.description}\n  > 💬 \`${example}\``
      : `- **${t.displayName}** — ${t.description}`
  }).join('\n')
  // ... 其余逻辑(空列表提示等)保持
}
```

- [ ] **Step 3: 删 FAILURE_MSGS / CAP_NAMES 字典 + buildFailureReply 改写**

Edit `src/agent/claude-runner.ts:39-67` 附近。删除 `const FAILURE_MSGS` (line 39) 和 `const CAP_NAMES` (line 51)。`buildFailureReply` 改为 async，从 im_triggers 表读：

```typescript
async function buildFailureReply(imTriggerKey: string, errorCode?: string): Promise<string> {
  const trigger = await getIMTrigger(imTriggerKey)
  const cap = trigger?.displayName ?? '处理'
  const detail = trigger?.failureMessages?.[errorCode ?? ''] ?? null
  return detail ? `${cap}未完成: ${detail}` : `${cap}未完成,请稍后重试`
}
```

调用方（如 line 417 `buildFailureReply(intent.capability, result.error)`）需加 `await`。

- [ ] **Step 4: 删 examples 字典**

之前 sendGreeting 内的 `examples: Record<string, string>` 字典（line 532 附近）已在 Step 2 替换为读 `t.examples[0]`，所以这里只需 grep 验证 examples 字典已被删除：

```bash
grep -n "const examples" src/agent/claude-runner.ts
```
Expected: 无输出。

- [ ] **Step 5: 跑 typecheck + 全套测试**

```bash
pnpm typecheck && pnpm test
```
Expected: 无新 fail。注意 `runner-greet-filter.test.ts` 如果还在测旧 API，需要更新或弃用。

- [ ] **Step 6: Commit**

```bash
git add src/agent/claude-runner.ts src/agent/runner-greet-filter.ts \
        src/__tests__/unit/runner-greet-filter.test.ts  # 如有更新
git commit -m "refactor(agent): claude-runner sendGreeting + 字典清理(FAILURE_MSGS/CAP_NAMES/examples)"
```

---

## Task 7: admin API — im-triggers + product-lines 改造

**Files:**
- Create: `src/admin/routes/im-triggers.ts`
- Modify: `src/admin/routes/product-lines.ts`
- Modify: `src/admin/index.ts`
- Create: `src/__tests__/unit/admin-im-triggers-route.test.ts`

- [ ] **Step 1: 实现 im-triggers admin route**

Create `src/admin/routes/im-triggers.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import {
  listIMTriggers,
  getIMTrigger,
  createIMTrigger,
  updateIMTrigger,
  deleteIMTrigger,
  type CreateIMTriggerInput,
  getIMTriggerById,
} from '../../db/repositories/im-triggers.js'

export async function registerIMTriggersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/im-triggers', async () => {
    return await listIMTriggers()
  })

  app.get<{ Params: { key: string } }>('/im-triggers/:key', async (req, reply) => {
    const trigger = await getIMTrigger(req.params.key)
    if (!trigger) return reply.status(404).send({ error: 'not_found' })
    return trigger
  })

  app.post<{ Body: CreateIMTriggerInput }>('/im-triggers', async (req, reply) => {
    const created = await createIMTrigger(req.body)
    return reply.status(201).send(created)
  })

  app.put<{ Params: { id: string }, Body: Partial<CreateIMTriggerInput> }>('/im-triggers/:id', async (req, reply) => {
    const updated = await updateIMTrigger(Number(req.params.id), req.body)
    if (!updated) return reply.status(404).send({ error: 'not_found' })
    return updated
  })

  app.delete<{ Params: { id: string } }>('/im-triggers/:id', async (req, reply) => {
    const existing = await getIMTriggerById(Number(req.params.id))
    if (!existing) return reply.status(404).send({ error: 'not_found' })
    await deleteIMTrigger(Number(req.params.id))
    return reply.status(204).send()
  })
}
```

Edit `src/admin/index.ts`. import + `await registerIMTriggersRoutes(app)`（同 phase 0 风格）。

- [ ] **Step 2: 改 product-lines.ts 接入 product_line_im_triggers**

Edit `src/admin/routes/product-lines.ts`. 找 capability 相关 endpoint（GET/PUT capabilities），新增对称的 IM 触发器 endpoint：

```typescript
import { listProductLineIMTriggers, batchSetProductLineIMTriggers } from '../../db/repositories/product-line-im-triggers.js'

app.get<{ Params: { id: string } }>('/product-lines/:id/im-triggers', async (req) => {
  return await listProductLineIMTriggers(Number(req.params.id))
})

app.put<{ Params: { id: string }, Body: { items: SetIMTriggerInput[] } }>('/product-lines/:id/im-triggers', async (req, reply) => {
  await batchSetProductLineIMTriggers(Number(req.params.id), req.body.items)
  return reply.status(204).send()
})
```

⚠️ 旧 capability endpoint（GET/PUT product-lines/:id/capabilities）保留——LLM agent RBAC 仍用 product_line_capabilities 表。

- [ ] **Step 3: 写 fastify-inject 测试**

Create `src/__tests__/unit/admin-im-triggers-route.test.ts`（用 phase 1 引入的 `buildAdminTestApp` helper）：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerIMTriggersRoutes } from '../../admin/routes/im-triggers.js'

describe('admin im-triggers route — fastify-inject', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildAdminTestApp(async (a) => { await registerIMTriggersRoutes(a) })
  })
  afterAll(async () => { await app.close() })

  it('GET /im-triggers returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/im-triggers' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('GET /im-triggers/:key returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/im-triggers/nonexistent_xxx' })
    expect(res.statusCode).toBe(404)
  })

  it('POST + GET + DELETE round-trip', async () => {
    const post = await app.inject({
      method: 'POST', url: '/im-triggers',
      payload: { key: 'test_admin_phase2', displayName: '测试', description: 'fastify-inject' },
    })
    expect(post.statusCode).toBe(201)
    const created = post.json() as { id: number; key: string }
    expect(created.key).toBe('test_admin_phase2')

    const get = await app.inject({ method: 'GET', url: '/im-triggers/test_admin_phase2' })
    expect(get.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: `/im-triggers/${created.id}` })
    expect(del.statusCode).toBe(204)
  })
})
```

- [ ] **Step 4: 跑测试**

```bash
pnpm test src/__tests__/unit/admin-im-triggers-route.test.ts
```
Expected: 3 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/im-triggers.ts src/admin/routes/product-lines.ts \
        src/admin/index.ts src/__tests__/unit/admin-im-triggers-route.test.ts
git commit -m "feat(admin): im-triggers CRUD API + product-lines 接入 product_line_im_triggers"
```

---

## Task 8: 前端 IMTriggersPage 新建 + 菜单 + 路由

**Files:**
- Create: `web/src/types/imTrigger.ts`
- Create: `web/src/api/imTriggers.ts`
- Create: `web/src/pages/IMTriggersPage.tsx`
- Modify: `web/src/layout/AdminLayout.tsx`（菜单）
- Modify: 路由文件（router 注册）

- [ ] **Step 1: 类型 + API client**

Create `web/src/types/imTrigger.ts`:

```typescript
export interface IMTrigger {
  id: number
  key: string
  displayName: string
  description: string
  pipelineId: number | null
  intentHints: string
  examples: string[]
  failureMessages: Record<string, string>
  defaultApprovalRuleId: number | null
  isSystem: boolean
  enabled: boolean
}
```

Create `web/src/api/imTriggers.ts`:

```typescript
import client from './client'
import type { IMTrigger } from '../types/imTrigger'

export async function listIMTriggers(): Promise<IMTrigger[]> {
  const { data } = await client.get<IMTrigger[]>('/im-triggers')
  return data
}

export async function getIMTrigger(key: string): Promise<IMTrigger> {
  const { data } = await client.get<IMTrigger>(`/im-triggers/${key}`)
  return data
}

export async function createIMTrigger(input: Partial<IMTrigger>): Promise<IMTrigger> {
  const { data } = await client.post<IMTrigger>('/im-triggers', input)
  return data
}

export async function updateIMTrigger(id: number, patch: Partial<IMTrigger>): Promise<IMTrigger> {
  const { data } = await client.put<IMTrigger>(`/im-triggers/${id}`, patch)
  return data
}

export async function deleteIMTrigger(id: number): Promise<void> {
  await client.delete(`/im-triggers/${id}`)
}
```

- [ ] **Step 2: IMTriggersPage**

Create `web/src/pages/IMTriggersPage.tsx`. 参考现有 `web/src/pages/CapabilitiesPage.tsx` 的列表 + 编辑 Modal 模式，但展示字段为 IMTrigger 字段（key / displayName / pipeline / examples 数量 / enabled）。编辑表单字段：key（创建后只读）、displayName、description、pipelineId（下拉选 pipeline）、intentHints（textarea）、examples（tags input）、failureMessages（key-value 编辑器）、enabled（switch）。

⚠️ 该页面较大（200+ 行）。Implementer 应参考 CapabilitiesPage.tsx 的实际结构、复制核心结构后改字段。

- [ ] **Step 3: 菜单 + 路由**

Edit `web/src/layout/AdminLayout.tsx`. 找菜单数组，在"能力管理"项前后加：

```tsx
{ label: 'IM 触发器', key: '/admin/im-triggers' },
```

Edit 路由配置（grep `'/admin/capabilities'` 找文件位置）：

```tsx
import IMTriggersPage from './pages/IMTriggersPage'
// 路由表：
{ path: '/admin/im-triggers', element: <IMTriggersPage /> },
```

- [ ] **Step 4: build + 浏览器手测**

```bash
cd web && pnpm build
```
Expected: TS 干净 + Vite build 成功。

启动 backend + frontend dev 手测：访问 `/admin/im-triggers` 看到 IMTriggersPage 列出 5+ 行（迁移过来的入口类）。

- [ ] **Step 5: Commit**

```bash
git add web/src/types/imTrigger.ts web/src/api/imTriggers.ts \
        web/src/pages/IMTriggersPage.tsx \
        web/src/layout/AdminLayout.tsx web/src/router.tsx  # 或同类
git commit -m "feat(web): IMTriggersPage + admin 菜单 + /admin/im-triggers 路由"
```

---

## Task 9: 前端 CapabilitiesPage 重构 + ProductLineDetailPage Tab + ApprovalRulesPage

**Files:**
- Modify: `web/src/pages/CapabilitiesPage.tsx`
- Modify: `web/src/pages/ProductLineDetailPage.tsx`
- Modify: `web/src/pages/ApprovalRulesPage.tsx`

- [ ] **Step 1: CapabilitiesPage 移除 IM 入口字段**

Edit `web/src/pages/CapabilitiesPage.tsx`. 找编辑表单里的字段：

- 移除 `defaultPipelineId` 表单项（该职责挪到 IMTriggersPage）
- 移除 `category` 列（表格）和编辑（如果存在）
- 保留：key / displayName / description / systemPrompt / toolNames / maxTurns / timeoutMs / requiresWorktree / requiresDeployLock

⚠️ 后端 capability 字段还在（phase 2 不删 column），前端只是不展示。

- [ ] **Step 2: ProductLineDetailPage Tab 改名 + 数据源**

Edit `web/src/pages/ProductLineDetailPage.tsx`. 找"能力管理" Tab：

```tsx
// 旧
{ key: 'capabilities', label: '能力管理', children: <CapabilityTab .../> }
// 新增 IM 触发器 Tab
{ key: 'im-triggers', label: 'IM 触发器', children: <IMTriggersTab .../> }
{ key: 'capabilities', label: '能力库', children: <CapabilityTab .../> }
```

`IMTriggersTab` 是新组件：
- API 调 `GET /admin/product-lines/:id/im-triggers`
- 列表显示每个 IM 触发器 + enabled Switch + role checkbox + trigger_sources Switch + approval_rule 下拉
- 保存调 `PUT /admin/product-lines/:id/im-triggers`

`CapabilityTab` 保留（capability LLM agent 行的 RBAC 仍用 product_line_capabilities）。

⚠️ 这步工作量较大。Implementer 应先读现有 ProductLineDetailPage 结构，复制 CapabilityTab 改成 IMTriggersTab，然后并列展示。

- [ ] **Step 3: ApprovalRulesPage 字段改名**

Edit `web/src/pages/ApprovalRulesPage.tsx`. 全局替换 `action` → `imTriggerKey`：

- Table 列 `dataIndex: 'action'` → `dataIndex: 'imTriggerKey'`，title 改 'IM 触发器' 之类
- Form.Item `name="action"` → `name="imTriggerKey"`，label 改
- Select 数据源从 capability 列表换成 im_triggers list（调 `listIMTriggers()`）
- 保留通配符 `*` 选项 + stale 兼容（CLAUDE.md 规范）

- [ ] **Step 4: build + 手测**

```bash
cd web && pnpm build
```
Expected: 干净。手测 3 个页面行为零回归。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/CapabilitiesPage.tsx web/src/pages/ProductLineDetailPage.tsx \
        web/src/pages/ApprovalRulesPage.tsx
git commit -m "feat(web): CapabilitiesPage 移除 IM 字段 + ProductLineDetailPage 加 IM 触发器 Tab + ApprovalRulesPage 改名"
```

---

## Task 10: 集成测试 + 冒烟手册 + 阶段验收

**Files:**
- Create: `docs/smoke-im-triggers.md`

- [ ] **Step 1: 编写冒烟手册**

Create `docs/smoke-im-triggers.md`:

````markdown
# 冒烟：im_triggers 表 + 路由层重构（阶段 2）

## 验收清单

### 1. DB 迁移正确性
```bash
psql $DATABASE_URL -c "SELECT COUNT(*) AS triggers FROM im_triggers; SELECT COUNT(*) AS pl_triggers FROM product_line_im_triggers; SELECT COUNT(*) AS rules FROM approval_rules WHERE im_trigger_key IS NOT NULL;"
```
预期：im_triggers ≥ 5；product_line_im_triggers 与原 product_line_capabilities 入口类行数一致；approval_rules 全部 im_trigger_key 非空。

### 2. claude-runner 字典已清除
```bash
grep -nE "FAILURE_MSGS|CAP_NAMES" src/agent/claude-runner.ts
```
预期：无输出（HANDLER_CAPABILITIES 暂留，phase 3 处理）。

### 3. 启动日志
```bash
pnpm dev
```
预期：`[migrate] schema-v32 applied` + `NOTICE: schema-v32 数据迁移验证通过` + `[server] node-type registry verified: 5 types`。

### 4. IM greet 列表
群聊发 "help"（或机器人收到任意打招呼）→ 预期 sendGreeting 渲染的 markdown 列表来自 im_triggers，每个 trigger 后带 examples[0]。

### 5. IM 触发链路
群聊发"部署 ssh-proxy 到 dev"：
- detectIntent 识别为 'deploy'
- checkIMTriggerAccess(productLineId, 'deploy', 'dev', userRole, 'im') 通过
- 入口审批 router.route('deploy', 'dev') 命中规则
- pipeline 启动

### 6. 拒绝路径
- 关闭 deploy 触发器：`UPDATE product_line_im_triggers SET enabled=false WHERE im_trigger_key='deploy';`
- 群聊触发 → 预期看到 "无法触发「部署服务」" 之类的拒绝文案
- 恢复：`SET enabled=true`

### 7. 失败文案
- 模拟某个 capability 报错（如手动让 fix_bug_l1 fail），看 buildFailureReply 输出从 im_triggers.failure_messages 读取（如配置了 `claude_invalid_json` → "分析用时过长..."）

### 8. 前端 P0
- 访问 `/admin/im-triggers` 看到列表
- 访问 `/admin/capabilities` 不再有 default_pipeline_id 字段
- 访问 `/admin/approval-rules` 字段名是 IM 触发器
- 产线详情页能管理 IM 触发器（Tab 存在 + 修改保存）

## 回滚

```sql
ALTER TABLE approval_rules RENAME COLUMN im_trigger_key TO action;
DROP TABLE IF EXISTS product_line_im_triggers CASCADE;
DROP TABLE IF EXISTS im_triggers CASCADE;
```
（开发期；rollback 后 server 启动会因 router.ts 等读 imTriggerKey 字段失败 → 必须 revert 代码）

## 故障诊断

`schema-v32 数据迁移失败: im_triggers 行数 < 入口类 capability 数`?
- 检查 capabilities 表里 category IN ('query','action','admin') 的行
- 可能某些 capability 的 default_pipeline_id 引用了不存在的 pipeline_id（FK 约束失败）→ 修 seed

`router.route is not a function` 或 `imTriggerKey is undefined`?
- 检查 src/approval/router.ts 是否完成改名
- 检查所有调用方（approval-manager 等）是否更新

claude-runner 路由层报错？
- 看 detectIntent prompt 里的 capList 输出空（im_triggers 表为空？检查 seed）
- 看 checkIMTriggerAccess 报 'not-configured' 是否产线缺配置
````

- [ ] **Step 2: 执行冒烟手册第 1-4 项 + 第 8 项前端手测**

按手册逐项跑。第 5/6/7 项（IM 群聊）在 IM 环境受限场景文档化即可。

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-im-triggers.md
git commit -m "docs(smoke): 阶段 2 冒烟手册"
```

---

## 阶段 2 Definition of Done

- [ ] schema-v32 应用，im_triggers 行数 ≥ 入口类 capability 行数（DO $$ 断言通过）
- [ ] `pnpm test` 全套不引入新 fail（dingtalk-sync 6 fail 是 pre-existing）
- [ ] `pnpm typecheck` 干净
- [ ] `cd web && pnpm build` 干净
- [ ] `grep -nE "FAILURE_MSGS|CAP_NAMES" src/agent/claude-runner.ts` 无输出
- [ ] 10 个 commit 清晰提交
- [ ] 冒烟手册第 1-4 + 第 8 项手测通过
- [ ] **`HANDLER_CAPABILITIES` 集合保留**（phase 3 处理）
- [ ] **`capabilities.default_pipeline_id` 等旧字段保留**（phase 2 末尾或后续 cleanup PR 处理）

阶段 2 完成后启动阶段 3 sub-plan 生成（DSL 增强：节点类型扩展 + retry_when + fan_out + 表达式解析器）。
