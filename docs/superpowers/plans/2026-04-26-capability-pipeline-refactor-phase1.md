# 能力(Capability)与流水线(Pipeline)分工重构 — 阶段 1 sub-plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 capabilities 表加 4 个字段（max_turns / timeout_ms / requires_worktree / requires_deploy_lock）+ backfill 现有 capability 行；把 claude-runner.ts 中 3 处硬编码（writeCapabilities / CODE_CAPABILITIES / Porygon defaults）改为读 DB 字段；同时补 phase 0 deferred 的 admin route 测试模式。

**Architecture:** ALTER TABLE 只 ADD 不 DROP（旧字段如 default_pipeline_id / category / param_schema / playbook 留到 phase 2 cleanup PR）；backfill 由 SQL 末尾 `RAISE EXCEPTION` 断言保证；claude-runner 改造采用"if-condition 替换"——逻辑不变，决策来源从硬编码 Set 改为 capability 字段。

**Tech Stack:** TypeScript (ES2022, NodeNext), Fastify 5, PostgreSQL 16 (pg driver, raw SQL, 无 ORM), Vitest, LangGraph (`@snack-kit/porygon` for Claude CLI orchestration).

**Spec:** [`../specs/2026-04-26-capability-pipeline-refactor-design.md`](../specs/2026-04-26-capability-pipeline-refactor-design.md) §3.4
**Master plan:** [`./2026-04-26-capability-pipeline-refactor.md`](./2026-04-26-capability-pipeline-refactor.md) §B
**Phase 0 merge:** main = `11e5ac2 merge: phase 0 capability/pipeline 重构基础设施`

---

## 阶段 1 范围与不动的部分

| 范围 | 在本 plan 内 | 不在本 plan 内（phase 2 处理） |
|------|------------|-----------------------------|
| `capabilities` 表 ADD 4 字段 + backfill | ✅ Task 1 | — |
| capabilities repository 类型/mapRow 扩展 | ✅ Task 1 | — |
| `writeCapabilities` Set → `requires_deploy_lock` | ✅ Task 2 | — |
| `CODE_CAPABILITIES` 数组 → `requires_worktree` | ✅ Task 3 | — |
| Porygon `maxTurns / timeoutMs` 按 capability 覆盖 | ✅ Task 4 | — |
| 冒烟手册 + 阶段验收 | ✅ Task 5 | — |
| Phase 0 deferred follow-up：admin route 用 fastify-inject 测试模式 | ✅ Task 6 | — |
| `FAILURE_MSGS` / `CAP_NAMES` / `examples` 字典 | ❌ | phase 2（搬到 im_triggers） |
| `HANDLER_CAPABILITIES` 集合 | ❌ | phase 2（capability 双层职责剥离时处理） |
| `DROP COLUMN` 旧字段（default_pipeline_id 等） | ❌ | phase 2 cleanup PR |

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema-v31.sql` | 创建 | ALTER capabilities ADD 4 字段 + backfill UPDATE + 末尾 RAISE EXCEPTION 断言 |
| `src/db/migrate.ts` | 修改 | 追加 v31 块、更新最终 console.log 摘要 |
| `src/db/repositories/capabilities.ts` | 修改 | `Capability` 类型加 4 字段；`mapRow` 处理新列 |
| `src/__tests__/helpers/db.ts` | 修改 | `SCHEMA_FILES` 数组加 `'schema-v31.sql'`（按 phase 0 立下的 forward policy） |
| `src/__tests__/unit/capabilities-repo-extended-fields.test.ts` | 创建 | 验证 4 字段 backfill 正确（deploy/rollback/restart 锁=true，fix_bug_l*/analyze_bug worktree=true，view_logs 等 neither） |
| `src/agent/claude-runner.ts` | 修改 | 三处硬编码替换：行 473 / 648 / 192-200 + 692-711 |
| `src/__tests__/unit/admin-pipeline-node-types-route.test.ts` | 修改 | 替换为 fastify-inject 风格（解决 phase 0 follow-up #16） |
| `src/__tests__/helpers/admin-app.ts` | 创建 | 共享 admin route 测试 helper：`buildAdminTestApp()` 注册 routes 但跳过 requireAuth |
| `docs/smoke-capabilities-cleanup.md` | 创建 | 阶段 1 冒烟手册 |

## 执行前提

- [ ] **Worktree 检查**：本 plan 设计在 worktree 中执行。建议在主仓库根目录运行：
  ```bash
  git worktree add -b refactor/cap-pipe-phase1 .claude/worktrees/refactor-cap-pipe-phase1 main
  ```
  然后让 agentic worker 切到该 worktree（或用 `EnterWorktree` skill 工具）。
- [ ] **依赖检查**：`pnpm install` 通过；`pnpm test src/__tests__/unit/pipeline-node-types-repo.test.ts` 全绿（验证 phase 0 schema-v30 数据已就绪）；`pnpm migrate` 跑通到 v30。

---

## Task 1: schema-v31 + capabilities repository 扩展

**Files:**
- Create: `src/db/schema-v31.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/repositories/capabilities.ts`
- Modify: `src/__tests__/helpers/db.ts`
- Create: `src/__tests__/unit/capabilities-repo-extended-fields.test.ts`

- [ ] **Step 1: 创建 schema-v31.sql**

Create `src/db/schema-v31.sql`:

```sql
-- v31: capabilities 表瘦身第一步——ADD 4 个 LLM agent 配置字段
-- 这些字段把 src/agent/claude-runner.ts 当前 3 处硬编码挪进 DB:
--   - max_turns / timeout_ms: 替代 ClaudeRunner 构造时的 Porygon defaults (line 197-198)
--   - requires_worktree:    替代 CODE_CAPABILITIES 数组 (line 648)
--   - requires_deploy_lock: 替代 writeCapabilities Set (line 473)
-- 旧字段(default_pipeline_id / category / param_schema / playbook / needs_approval)
-- 不在本迁移删除,phase 2 cleanup PR 单独处理(spec §3.6)

ALTER TABLE capabilities
  ADD COLUMN IF NOT EXISTS max_turns INT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS timeout_ms INT NOT NULL DEFAULT 1200000,
  ADD COLUMN IF NOT EXISTS requires_worktree BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requires_deploy_lock BOOLEAN NOT NULL DEFAULT FALSE;

-- backfill: deploy / rollback / restart 需要 deploy lock
UPDATE capabilities
   SET requires_deploy_lock = TRUE
 WHERE key IN ('deploy', 'rollback', 'restart');

-- backfill: bug 分析 + 自动修复 需要 worktree
UPDATE capabilities
   SET requires_worktree = TRUE
 WHERE key IN ('analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3');

-- 断言: backfill 命中数符合预期
DO $$
DECLARE
  v_lock_count INT;
  v_worktree_count INT;
BEGIN
  SELECT COUNT(*) INTO v_lock_count
    FROM capabilities
   WHERE requires_deploy_lock = TRUE
     AND key IN ('deploy', 'rollback', 'restart');
  IF v_lock_count <> 3 THEN
    RAISE EXCEPTION 'schema-v31 backfill 失败: requires_deploy_lock=true 应匹配 3 行(deploy/rollback/restart),实际 %', v_lock_count;
  END IF;

  SELECT COUNT(*) INTO v_worktree_count
    FROM capabilities
   WHERE requires_worktree = TRUE
     AND key IN ('analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3');
  IF v_worktree_count <> 4 THEN
    RAISE EXCEPTION 'schema-v31 backfill 失败: requires_worktree=true 应匹配 4 行(analyze_bug + fix_bug_l1/l2/l3),实际 %', v_worktree_count;
  END IF;

  RAISE NOTICE 'schema-v31 backfill 验证通过: lock=%, worktree=%', v_lock_count, v_worktree_count;
END $$;
```

- [ ] **Step 2: 在 migrate.ts 追加 v31 块**

Edit `src/db/migrate.ts`. 找到 v30 块（应在 v29 之后），在 v30 后追加：

```typescript
const schemaV31 = readFileSync(join(__dirname, 'schema-v31.sql'), 'utf8')
await pool.query(schemaV31)
console.log('[migrate] schema-v31 applied')
```

并把文件末尾的"已应用版本"console.log 行更新（grep `'✅ Database schema applied'` 找它）追加 `+ v31 + capabilities-extended-fields v31`。

- [ ] **Step 3: SCHEMA_FILES 加 v31**

Edit `src/__tests__/helpers/db.ts`. 找到 `SCHEMA_FILES` 数组（phase 0 添加了 v30 注释，紧邻其下追加）：

```typescript
  // v30 (pipeline_node_types) 例外:全新表 + 非污染 catalog seed (5 行节点
  // 类型定义),所有依赖此表的测试都期望这 5 行存在,不会干扰其它 fixture。
  // 后续 v31+ schema 遵循同样规则:纯 DDL 或"全新表 + 所有测试都期望存在
  // 的 catalog seed"才能加进 SCHEMA_FILES。
  'schema-v30.sql',
  // v31 (capabilities 4 字段): 纯 ALTER TABLE ADD + 对已有行的 UPDATE backfill。
  // 不引入新 capability 行,不影响其它 fixture。所有依赖 capabilities 表
  // 4 字段的测试都期望 deploy/rollback/restart 有 deploy lock,
  // analyze_bug + fix_bug_l1/l2/l3 有 worktree,其余 capability neither。
  'schema-v31.sql',
]
```

- [ ] **Step 4: 写 repository 测试（先失败）**

Create `src/__tests__/unit/capabilities-repo-extended-fields.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { listCapabilities, getCapabilityByKey } from '../../db/repositories/capabilities.js'

describe('capabilities repository — phase 1 extended fields', () => {
  it('Capability 类型暴露 4 个新字段并默认值正确', async () => {
    const caps = await listCapabilities()
    expect(caps.length).toBeGreaterThan(0)
    for (const c of caps) {
      expect(typeof c.maxTurns).toBe('number')
      expect(c.maxTurns).toBeGreaterThan(0)
      expect(typeof c.timeoutMs).toBe('number')
      expect(c.timeoutMs).toBeGreaterThan(0)
      expect(typeof c.requiresWorktree).toBe('boolean')
      expect(typeof c.requiresDeployLock).toBe('boolean')
    }
  })

  it('deploy / rollback / restart 已 backfill requiresDeployLock=true', async () => {
    for (const key of ['deploy', 'rollback', 'restart']) {
      const c = await getCapabilityByKey(key)
      expect(c, `capability "${key}" not found`).not.toBeNull()
      expect(c!.requiresDeployLock, `${key}.requiresDeployLock`).toBe(true)
      expect(c!.requiresWorktree, `${key}.requiresWorktree`).toBe(false)
    }
  })

  it('analyze_bug + fix_bug_l1/l2/l3 已 backfill requiresWorktree=true', async () => {
    for (const key of ['analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3']) {
      const c = await getCapabilityByKey(key)
      expect(c, `capability "${key}" not found`).not.toBeNull()
      expect(c!.requiresWorktree, `${key}.requiresWorktree`).toBe(true)
      expect(c!.requiresDeployLock, `${key}.requiresDeployLock`).toBe(false)
    }
  })

  it('view_logs / view_deployments 等查询类 neither 标志为 true', async () => {
    for (const key of ['view_logs', 'view_deployments']) {
      const c = await getCapabilityByKey(key)
      if (!c) continue  // 容忍 seed 中可能不存在的 capability
      expect(c.requiresWorktree, `${key}.requiresWorktree`).toBe(false)
      expect(c.requiresDeployLock, `${key}.requiresDeployLock`).toBe(false)
    }
  })

  it('默认 maxTurns=30 / timeoutMs=1200000 来自 schema DEFAULT', async () => {
    const c = await getCapabilityByKey('view_logs')
    if (!c) return  // 测试环境无 view_logs 时跳过
    expect(c.maxTurns).toBe(30)
    expect(c.timeoutMs).toBe(1200000)
  })
})
```

Run: `pnpm test src/__tests__/unit/capabilities-repo-extended-fields.test.ts`
Expected: FAIL —— 类型缺字段（编译报错）或字段读不到（runtime 失败）。

- [ ] **Step 5: 扩展 Capability 类型 + mapRow**

Edit `src/db/repositories/capabilities.ts`. 找到 `export interface Capability` 块，在末尾追加 4 个字段（与现有字段的命名风格保持 camelCase）：

```typescript
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
  systemPrompt: string | null
  defaultSystemPrompt: string | null
  defaultPipelineId: number | null
  // ── phase 1 新增（spec §3.4 / plan §B） ─────────────────────────
  maxTurns: number
  timeoutMs: number
  requiresWorktree: boolean
  requiresDeployLock: boolean
  // ───────────────────────────────────────────────────────────────
  updatedAt: Date | null
  createdAt: Date
}
```

找到 `mapRow` 函数，在返回对象里追加 4 个映射（snake_case → camelCase）：

```typescript
function mapRow(r: Record<string, unknown>): Capability {
  return {
    // ... 现有字段保持原样 ...
    maxTurns: (r.max_turns ?? 30) as number,
    timeoutMs: (r.timeout_ms ?? 1200000) as number,
    requiresWorktree: (r.requires_worktree ?? false) as boolean,
    requiresDeployLock: (r.requires_deploy_lock ?? false) as boolean,
    // ...
  }
}
```

`?? 30 / ?? 1200000 / ?? false` 兜底：理论上 schema NOT NULL DEFAULT 保证非空，但旧 row 在 ALTER 应用前查询会得到 null，兜底防御。

- [ ] **Step 6: 跑测试 + 跑迁移**

```bash
pnpm migrate    # 验证 schema-v31 SQL + 断言通过
pnpm test src/__tests__/unit/capabilities-repo-extended-fields.test.ts
```
Expected: migrate 输出 `[migrate] schema-v31 applied` + `NOTICE: schema-v31 backfill 验证通过`；测试 5 PASS。

跑全套确认无回归：
```bash
pnpm test
```
Expected: 不引入新 fail（dingtalk-sync 6 fail 是 phase 0 已知 pre-existing）。

- [ ] **Step 7: Commit**

```bash
git add src/db/schema-v31.sql src/db/migrate.ts \
        src/db/repositories/capabilities.ts \
        src/__tests__/helpers/db.ts \
        src/__tests__/unit/capabilities-repo-extended-fields.test.ts
git commit -m "feat(db): capabilities 表加 4 字段(maxTurns/timeoutMs/requiresWorktree/requiresDeployLock)+ backfill(schema-v31)"
```

---

## Task 2: claude-runner — writeCapabilities → requires_deploy_lock

**Files:**
- Modify: `src/agent/claude-runner.ts` (around line 473)

- [ ] **Step 1: 读现状**

Run: `grep -n "writeCapabilities\|needsLock\|acquireLock" src/agent/claude-runner.ts | head -10`
Expected output 包括：
```
473:      const writeCapabilities = new Set(['deploy', 'rollback', 'restart'])
474:      const needsLock = writeCapabilities.has(intent.capability) && intent.project && intent.env
```

- [ ] **Step 2: 替换硬编码 Set**

Edit `src/agent/claude-runner.ts`. 找到行 473-474 的 `writeCapabilities` Set 定义和 `needsLock` 推导，替换为：

```typescript
      // 写操作加 deploy lock —— 是否需要由 capability.requiresDeployLock 决定（phase 1 起从 DB 读）
      const needsLock = capability.requiresDeployLock && intent.project && intent.env
```

注意保留 `intent.project && intent.env` 的运行时校验（lock 需要这两个字段才能 acquire）。

⚠️ 执行前确认：在该位置上下文（约第 460-490 行）`capability` 变量已经定义并且非 null（应该来自 Step 4 的 `getCapabilityByKey(intent.capability)`）。如果有 nullable 路径，加 `?.` 守卫：`capability?.requiresDeployLock`，但典型情况上下文已保证 capability 非 null，直接读即可。

- [ ] **Step 3: 跑 typecheck**

```bash
pnpm typecheck
```
Expected: 无 TS 错误。

- [ ] **Step 4: 跑现有测试**

```bash
pnpm test
```
Expected: 不引入新 fail（同 Task 1 step 6 基线）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude-runner.ts
git commit -m "refactor(agent): writeCapabilities Set 改为读 capability.requiresDeployLock"
```

---

## Task 3: claude-runner — CODE_CAPABILITIES → requires_worktree

**Files:**
- Modify: `src/agent/claude-runner.ts` (around line 648)

- [ ] **Step 1: 读现状**

Run: `grep -n "CODE_CAPABILITIES\|requires_worktree\|worktree = await acquire" src/agent/claude-runner.ts | head -10`
Expected output 包括：
```
648:    const CODE_CAPABILITIES = ['analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3']
651:    if (capability && CODE_CAPABILITIES.includes(capability.key) && opts.productLineId) {
```

- [ ] **Step 2: 替换硬编码数组**

Edit `src/agent/claude-runner.ts`. 删除 line 648 的 `CODE_CAPABILITIES` 常量定义。把 line 651 的判断改为：

```typescript
    // 需要代码访问的 capability，自动创建 worktree（phase 1 起从 DB 读）
    let worktree: Worktree | null = null
    console.log(`[Runner] worktree check: capability=${capability?.key}, productLineId=${opts.productLineId}`)
    if (capability?.requiresWorktree && opts.productLineId) {
      try {
        // ... 现有 acquire / release / cwd 注入逻辑保持不变 ...
      } catch (err) {
        // ...
      }
    }
```

具体改动只两处：
1. 删 const 行 (`const CODE_CAPABILITIES = [...]`)
2. 改 if 条件：`capability && CODE_CAPABILITIES.includes(capability.key) && opts.productLineId` → `capability?.requiresWorktree && opts.productLineId`

`capability?.requiresWorktree` 在 capability undefined 时短路为 false（兼容现有 `capability && ...` 的语义）。

- [ ] **Step 3: 跑 typecheck + 全套测试**

```bash
pnpm typecheck && pnpm test
```
Expected: 无新 fail。

- [ ] **Step 4: Commit**

```bash
git add src/agent/claude-runner.ts
git commit -m "refactor(agent): CODE_CAPABILITIES 数组改为读 capability.requiresWorktree"
```

---

## Task 4: claude-runner — Porygon maxTurns/timeoutMs 按 capability 覆盖

**Files:**
- Modify: `src/agent/claude-runner.ts` (executeWithPorygon 内的 query() 调用)

**说明**：Porygon 构造时的 `defaults: { timeoutMs, maxTurns }` 是 fallback。每次 `porygon.query(...)` 调用可以传 maxTurns/timeoutMs 覆盖。phase 1 让 IM 主路径（executeWithPorygon）按 capability 覆盖；executeCapabilityDirect 已支持调用方传参，phase 1 不动它的调用方（spec §3.4 范围限定）。

- [ ] **Step 1: 读 executeWithPorygon 的 query() 调用现状**

Run: `sed -n '690,712p' src/agent/claude-runner.ts`
Expected output 包括 `for await (const msg of this.porygon.query({ ... }))` 块（不含 `maxTurns` / `timeoutMs` 参数当前）。

- [ ] **Step 2: 在 query() 调用处加 capability 覆盖**

Edit `src/agent/claude-runner.ts`. 找到 `executeWithPorygon` 内的 `this.porygon.query({ ... })` 调用（应在 line 692 附近），在 `disallowedTools` 行之前加入两行（保持 spread 风格）：

```typescript
      for await (const msg of this.porygon.query({
        prompt: prompt + contextNote,
        appendSystemPrompt: systemPrompt,
        ...(existingSessionId ? { resume: existingSessionId } : {}),
        // phase 1: 按 capability 覆盖 Porygon defaults，让单条 capability
        // 可以独立配置(如 analyze_bug 长 timeout / view_logs 短 maxTurns)
        ...(capability ? { maxTurns: capability.maxTurns, timeoutMs: capability.timeoutMs } : {}),
        mcpServers: { ... 现有不变 ... },
        disallowedTools: [...],
        envVars: claudeEnv,
      })) {
```

⚠️ 不要改 Porygon 构造（line 192-200）的 `defaults`——它仍作为 capability undefined 时的 fallback（如 `detectIntent` 那次轻量 query 不绑 capability）。

- [ ] **Step 3: 跑 typecheck + 全套测试**

```bash
pnpm typecheck && pnpm test
```
Expected: 无新 fail。

- [ ] **Step 4: Commit**

```bash
git add src/agent/claude-runner.ts
git commit -m "refactor(agent): IM 主路径 query() 按 capability.maxTurns/timeoutMs 覆盖 Porygon defaults"
```

---

## Task 5: 冒烟手册 + 阶段验收

**Files:**
- Create: `docs/smoke-capabilities-cleanup.md`

- [ ] **Step 1: 编写冒烟手册**

Create `docs/smoke-capabilities-cleanup.md`:

````markdown
# 冒烟：capabilities 表瘦身 + 3 处硬编码清理（阶段 1）

## 验收清单

### 1. DB 状态
```bash
psql $DATABASE_URL -c "SELECT key, max_turns, timeout_ms, requires_worktree, requires_deploy_lock FROM capabilities ORDER BY key;"
```
预期：每行都有 4 列值；
- `deploy / rollback / restart` 三行 `requires_deploy_lock=t`
- `analyze_bug / fix_bug_l1 / fix_bug_l2 / fix_bug_l3` 四行 `requires_worktree=t`
- 其它行两个 boolean 都为 `f`
- 所有行 `max_turns=30` / `timeout_ms=1200000`（来自 DEFAULT）

### 2. 启动日志
```bash
pnpm dev
```
预期日志包含：`[migrate] schema-v31 applied` + `[server] node-type registry verified: 5 types`（phase 0 残留检查），server 正常进入 listen 状态。

### 3. claude-runner 三处硬编码字典已不复存在
```bash
grep -n "writeCapabilities\|CODE_CAPABILITIES" src/agent/claude-runner.ts
```
预期：无输出（只剩注释中的历史引用，如本冒烟手册或 commit message——可接受）。

### 4. Deploy lock 路径
模拟 IM 触发 `部署 ssh-proxy 到 dev`：
- 在 IM 触发前 `psql $DATABASE_URL -c "UPDATE capabilities SET requires_deploy_lock=false WHERE key='deploy';"`
- 触发 deploy → 预期不再尝试 acquireLock（log 中无 `acquireLock` 调用）
- 恢复：`psql ... SET requires_deploy_lock=true WHERE key='deploy';`

### 5. Worktree 路径
模拟 IM 触发 bug 分析（带 `analyze_bug` 关键词）：
- 在触发前 `psql $DATABASE_URL -c "UPDATE capabilities SET requires_worktree=false WHERE key='analyze_bug';"`
- 触发 analyze_bug → 预期 log 无 `Worktree acquired`
- 恢复：`SET requires_worktree=true WHERE key='analyze_bug';`

### 6. maxTurns / timeoutMs 路径
- 在 IM 触发前 `psql $DATABASE_URL -c "UPDATE capabilities SET max_turns=5 WHERE key='deploy';"`
- 触发 deploy → 走到 5 轮 tool call 后 Porygon 终止（用 log 验证："maxTurns reached" 或类似消息）
- 恢复：`SET max_turns=30 WHERE key='deploy';`

### 7. 现有 pipeline 行为零回归
触发 schema-v19 的 deploy-im-demo pipeline，跑通 IM 入口 → im_input → approval → capability 三阶段。
（capability stage 内部的 LLM 行为现在按 capability 行的 maxTurns/timeoutMs 走，不应有可见差别。）

## 回滚
```sql
ALTER TABLE capabilities
  DROP COLUMN IF EXISTS max_turns,
  DROP COLUMN IF EXISTS timeout_ms,
  DROP COLUMN IF EXISTS requires_worktree,
  DROP COLUMN IF EXISTS requires_deploy_lock;
```
（开发期；rollback 后 server 启动会因 capabilities mapRow 读不到列报 TS-runtime 错，需要先 revert 代码）

## 故障诊断

启动时看到 `schema-v31 backfill 失败`?
- 检查 capabilities 表是否包含 deploy/rollback/restart/analyze_bug/fix_bug_l1/l2/l3 这 7 个 key（seed 文件会插入）
- 如某 capability key 在你的环境下被自定义改名，UPDATE 命中数会偏离 → 检查 seed 数据
````

- [ ] **Step 2: 执行冒烟手册（best-effort）**

按手册第 1-3 步逐项执行（DB 状态、启动日志、grep 清查）。第 4-7 步需要真实 IM 环境，开发期可文档化但不强制执行（参考 phase 0 的同类做法）。

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-capabilities-cleanup.md
git commit -m "docs(smoke): 阶段 1 冒烟手册"
```

---

## Task 6: 补 Phase 0 deferred follow-up — admin route fastify-inject 测试

**Files:**
- Create: `src/__tests__/helpers/admin-app.ts`
- Modify: `src/__tests__/unit/admin-pipeline-node-types-route.test.ts`

**说明**：phase 0 T5 reviewer 反馈 I2：admin route 测试只测了 repository 层数据形态，没真正调路由 handler。phase 1 补一个共享 helper，让所有 admin route 测试都用 fastify-inject 风格——这样后续 phase 的新增 admin route（im_triggers / pipeline_node_types 等）都可以复用。

- [ ] **Step 1: 创建测试 helper**

Create `src/__tests__/helpers/admin-app.ts`:

```typescript
/**
 * 共享 admin route 测试 helper.
 * 启动一个最小 Fastify 实例,只注册需要的 admin route,跳过 requireAuth preHandler
 * 以便单元测试聚焦 route 行为本身(不测 auth 链路)。
 */
import Fastify, { type FastifyInstance } from 'fastify'

export async function buildAdminTestApp(
  registerRoutes: (app: FastifyInstance) => Promise<void> | void,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await registerRoutes(app)
  await app.ready()
  return app
}
```

- [ ] **Step 2: 改写 admin-pipeline-node-types-route.test.ts 用 fastify-inject**

Edit `src/__tests__/unit/admin-pipeline-node-types-route.test.ts`. 替换全部内容为：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerPipelineNodeTypeRoutes } from '../../admin/routes/pipeline-node-types.js'
import { getPool } from '../../db/client.js'

describe('GET /pipeline-node-types route — fastify-inject', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildAdminTestApp(async (a) => {
      await registerPipelineNodeTypeRoutes(a)
    })
  })
  afterAll(async () => { await app.close() })

  it('returns 200 with bare array of 5 enabled node types', async () => {
    const res = await app.inject({ method: 'GET', url: '/pipeline-node-types' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(5)
  })

  it('disabled node types are filtered out', async () => {
    // 临时把 script 标记 disabled
    await getPool().query(`UPDATE pipeline_node_types SET enabled=false WHERE key='script'`)
    try {
      const res = await app.inject({ method: 'GET', url: '/pipeline-node-types' })
      const body = res.json() as Array<{ key: string }>
      expect(body.find(t => t.key === 'script')).toBeUndefined()
      expect(body).toHaveLength(4)
    } finally {
      await getPool().query(`UPDATE pipeline_node_types SET enabled=true WHERE key='script'`)
    }
  })

  it('each item exposes key/displayName/category/paramSchema/outputSchema', async () => {
    const res = await app.inject({ method: 'GET', url: '/pipeline-node-types' })
    const body = res.json() as Array<Record<string, unknown>>
    for (const item of body) {
      expect(item).toHaveProperty('key')
      expect(item).toHaveProperty('displayName')
      expect(item).toHaveProperty('category')
      expect(typeof item.paramSchema).toBe('object')
      expect(typeof item.outputSchema).toBe('object')
    }
  })
})
```

⚠️ 注意 `registerPipelineNodeTypeRoutes` 注册的是 `app.get('/pipeline-node-types', ...)`，没有 `/admin` 前缀（admin 前缀是在 `src/admin/index.ts` 里通过 `app.register(adminPlugin, { prefix: '/admin' })` 加的）。所以 inject URL 是 `/pipeline-node-types` 不是 `/admin/pipeline-node-types`。

- [ ] **Step 3: 跑测试**

```bash
pnpm test src/__tests__/unit/admin-pipeline-node-types-route.test.ts
```
Expected: 3 PASS（取代之前的 2 个 repository-level 测试）。

跑全套确认无回归：
```bash
pnpm test
```
Expected: 不引入新 fail。

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/helpers/admin-app.ts \
        src/__tests__/unit/admin-pipeline-node-types-route.test.ts
git commit -m "test(admin): admin route 测试改为 fastify-inject + helper(解决 phase 0 follow-up)"
```

---

## 阶段 1 Definition of Done

- [ ] schema-v31 已应用，5 个 backfill 断言通过（DO $$ ... $$ block 输出 NOTICE）
- [ ] `pnpm test src/__tests__/unit/capabilities-repo-extended-fields.test.ts` 5 PASS
- [ ] `pnpm test src/__tests__/unit/admin-pipeline-node-types-route.test.ts` 3 PASS
- [ ] `pnpm test` 全套不引入新 fail（dingtalk-sync 6 fail 是 pre-existing）
- [ ] `pnpm typecheck` 干净
- [ ] `cd web && pnpm build` 干净
- [ ] `pnpm dev` 启动顺利，含 `[migrate] schema-v31 applied` 和 `node-type registry verified` 两行日志
- [ ] `grep "writeCapabilities\|CODE_CAPABILITIES" src/agent/claude-runner.ts` 无非注释命中
- [ ] `docs/smoke-capabilities-cleanup.md` 第 1-3 项手测通过
- [ ] 6 个 commit 清晰提交（schema-v31 / writeCapabilities 替换 / CODE_CAPABILITIES 替换 / Porygon 覆盖 / 冒烟手册 / fastify-inject 测试）
- [ ] 旧字段（default_pipeline_id / category / param_schema / playbook / needs_approval）**未删除**——这是 phase 2 cleanup PR 的事

阶段 1 完成后启动阶段 2 sub-plan 生成，输入示例：

> "阶段 1 已合并到 main（merge commit X）。基于阶段 1 实际形态生成阶段 2 sub-plan：im_triggers 表 + 路由层重构 + 前端 P0 拆 CapabilitiesPage 等。已知约束：phase 1 已加 capabilities 4 字段；旧字段(default_pipeline_id/category/param_schema/playbook/needs_approval)将在 phase 2 cleanup PR 删除。"
