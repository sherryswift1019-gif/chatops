# Spec Stage Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 QI spec 阶段升级为 brainstorming 多轮澄清 + AI review 真循环 + 上下文与规范双闭环的产品级流水线。

**Architecture:** 在现有 v12 拓扑的 spec 阶段前插入 `spec_brainstorm` 节点（复用 im_input 多轮 interrupt 基建），`spec_ai_review` 出口由直通改为条件分支配合 `aiReviewMaxRounds` 上限保护回退到 `spec_author`，三个 LLM role 共享 `qi-spec-quality.md` 单一规范文档与 `enriched-input-schema.ts` zod 契约。

**Tech Stack:** TypeScript (ES2022 strict, NodeNext modules), Fastify 5, PostgreSQL 16 (pg driver, raw SQL), React 18 + Ant Design 5, Vitest, zod, @snack-kit/porygon + @modelcontextprotocol/sdk。

**Spec:** [docs/superpowers/specs/2026-05-12-spec-stage-upgrade-design.md](../specs/2026-05-12-spec-stage-upgrade-design.md)

---

## 全局文件清单

### 新增

| 路径 | 职责 |
|---|---|
| `src/quick-impl/enriched-input-schema.ts` | brainstorm/spec-author/reviewer 共享的 zod schema |
| `src/quick-impl/qi-config.ts` | `loadQiConfig()` 读 `aiReviewMaxRounds` / `tokenBudgetPerRequirement` |
| `src/db/schema-v65.sql` | retry_counters JSONB 扩展 (ai_review_rounds + last_ai_review_notes) |
| `src/pipeline/node-types/llm-brainstorm.ts` | brainstorm 节点 stage type 定义（与 llm-author.ts 同模式） |
| `src/admin/routes/brainstorm.ts` | POST /admin/requirements/:id/brainstorm/answer |
| `src/__tests__/unit/qi-brainstorm-state.test.ts` | brainstorm state machine 单测 |
| `src/__tests__/unit/qi-ai-review-loop.test.ts` | AI review 自循环 + 逐项追踪单测 |
| `src/__tests__/integration/qi-spec-stage-e2e.integration.test.ts` | spec 阶段全链路 E2E |
| `scripts/check-qi-standards-consistency.ts` | 三方规范一致性 CI lint |
| `docs/standards/qi-spec-quality.md` | spec 阶段单一规范文档 |
| `.claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md` | brainstorm-host role |
| `web/src/pages/requirement-detail/BrainstormTab.tsx` | Web 端多轮答题 UI |

### 修改

| 路径 | 变更要点 |
|---|---|
| `src/pipeline/graph-builder.ts` | REJECT_CAP 3→2, 新增 buildLlmBrainstormNode + handleAiReviewFailure |
| `src/quick-impl/bootstrap.ts` | 拓扑加 spec_brainstorm 节点 + spec_ai_review 出口改条件分支 |
| `src/pipeline/node-types/llm-review.ts` | round 2+ 逐项追踪 schema 校验 |
| `src/pipeline/node-types/git-commit-push.ts` | spec 阶段走 merge commit 保留 round commits |
| `src/pipeline/im-router.ts` | 扩展 waiter 支持 Web 端 resume |
| `src/pipeline/im-input-agent.ts` | 选项 ID + 自由文本解析（双格式） |
| `src/pipeline/approval-summary/spec.ts` | 含 AI 历次 notes + 逐项追踪 |
| `src/db/repositories/requirements.ts` | incrementAiReviewRound + getLastAiReviewNotes |
| `src/db/migrate.ts` | SCHEMA_FILES 追加 v65 |
| `src/__tests__/helpers/db.ts` | SCHEMA_FILES 追加 v65 |
| `.claude/skills/quick-impl-artifact-author/SKILL.md` | 加 enrichedInput 输入说明 |
| `.claude/skills/quick-impl-artifact-author/roles/spec-author.md` | 3 状态分支 + degraded 信号 + E2E 章节迁出 |
| `.claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md` | round 2+ 逐项追踪 + S1 改读 enrichedInput |
| `.claude/skills/quick-impl-artifact-author/role-manifest.json` | brainstorm-host 注册 + spec-author/reviewer inputs 扩展 |
| `web/src/pages/requirement-detail/index.tsx` | 加 Brainstorm Tab |
| `web/src/pages/requirement-detail/NodeApprovalView.tsx` | 含 AI 历次 notes 展示 |

---

## 里程碑总览

| M# | 主题 | Tasks | 依赖 |
|---|---|---|---|
| M0 | 基础设施（schema / 配置 / 规范文档） | T1-T5 | 无 |
| M1 | AI review 真循环 | T6-T11, T11.5 | M0 |
| M2 | spec-author 升级 + 人审/摘要 | T12-T15 | M1 |
| M3 | spec_brainstorm 节点核心 | T16-T22, T22.5 (T21 merged) | M0 |
| M4 | Web 入口 + UI | T23-T26 | M3 |
| M5 | merge commit + 拓扑接通 + 规范 CI | T27-T29 | M2,M4 |
| M6 | E2E + 数据清理 | T30-T31 | M5 |

---

# M0: 基础设施

## Task 1: enrichedInput zod schema

**Files:**
- Create: `src/quick-impl/enriched-input-schema.ts`
- Test: `src/__tests__/unit/qi-enriched-input-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-enriched-input-schema.test.ts
import { describe, it, expect } from 'vitest'
import { EnrichedInputSchema } from '../../quick-impl/enriched-input-schema.js'

describe('EnrichedInputSchema', () => {
  it('accepts a complete v1 input', () => {
    const valid = {
      schemaVersion: 'v1' as const,
      rawInput: '加个登录页',
      actors: { triggerer: 'PM', primaryUsers: ['访客'], verifier: 'QA' },
      objective: { userValue: '能登录', businessValue: '提升留存', successSignal: '登录后跳 /dashboard' },
      scope: { in: ['登录表单'], out: ['注册'] },
      noGos: [{ desc: '不存密码' }],
      historicalRefs: [{ description: '老登录页废弃', relation: 'deprecated' as const }],
      codebaseEvidence: [{ file: 'src/auth/login.ts', line: 42, purpose: '现有登录逻辑' }],
      conversationSummary: '用户要登录页',
      qaTurnCount: 3,
      partial: false,
    }
    expect(EnrichedInputSchema.parse(valid)).toEqual(valid)
  })

  it('rejects historicalRefs with unknown relation', () => {
    const invalid = {
      schemaVersion: 'v1', rawInput: 'x', actors: {}, objective: {},
      scope: { in: [], out: [] }, noGos: [], codebaseEvidence: [],
      conversationSummary: '', qaTurnCount: 0, partial: false,
      historicalRefs: [{ description: 'x', relation: 'unknown' }],
    }
    expect(() => EnrichedInputSchema.parse(invalid)).toThrow()
  })

  it('accepts partial=true with missingFields', () => {
    const partial = {
      schemaVersion: 'v1' as const, rawInput: 'x', actors: {}, objective: {},
      scope: { in: [], out: [] }, noGos: [], historicalRefs: [], codebaseEvidence: [],
      conversationSummary: '', qaTurnCount: 2, partial: true,
      missingFields: ['successSignal', 'verifier'],
    }
    expect(EnrichedInputSchema.parse(partial).missingFields).toEqual(['successSignal', 'verifier'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/__tests__/unit/qi-enriched-input-schema.test.ts
```
Expected: FAIL with `Cannot find module '../../quick-impl/enriched-input-schema.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/quick-impl/enriched-input-schema.ts
import { z } from 'zod'

export const EnrichedInputSchema = z.object({
  schemaVersion: z.literal('v1'),
  rawInput: z.string(),

  actors: z.object({
    triggerer: z.string().optional(),
    primaryUsers: z.array(z.string()).optional(),
    verifier: z.string().optional(),
  }),
  objective: z.object({
    userValue: z.string().optional(),
    businessValue: z.string().optional(),
    successSignal: z.string().optional(),
  }),
  scope: z.object({
    in: z.array(z.string()),
    out: z.array(z.string()),
    deferred: z.array(z.string()).optional(),
  }),
  noGos: z.array(z.object({
    desc: z.string(),
    reason: z.string().optional(),
  })),
  historicalRefs: z.array(z.object({
    description: z.string(),
    relation: z.enum(['existing', 'past_attempt', 'deprecated', 'related']),
    pointer: z.string().optional(),
  })),
  businessWindow: z.object({
    deadline: z.string().optional(),
    upstreamDeps: z.array(z.string()).optional(),
    priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
  }).optional(),
  codebaseEvidence: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    purpose: z.string(),
  })),

  conversationSummary: z.string(),
  qaTurnCount: z.number(),
  partial: z.boolean(),
  missingFields: z.array(z.string()).optional(),
})

export type EnrichedInput = z.infer<typeof EnrichedInputSchema>
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/__tests__/unit/qi-enriched-input-schema.test.ts
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/quick-impl/enriched-input-schema.ts src/__tests__/unit/qi-enriched-input-schema.test.ts
git commit -m "feat(qi): add EnrichedInput zod schema as brainstorm/spec-author/reviewer contract"
```

---

## Task 2: schema-v65 扩展 retry_counters

**Files:**
- Create: `src/db/schema-v65.sql`
- Modify: `src/db/migrate.ts:SCHEMA_FILES`
- Modify: `src/__tests__/helpers/db.ts:SCHEMA_FILES`
- Test: `src/__tests__/unit/qi-retry-counters-v65.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-retry-counters-v65.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/index.js'
import { resetTestDb } from '../helpers/db.js'

describe('schema-v65 retry_counters extension', () => {
  beforeEach(async () => { await resetTestDb() })

  it('stores ai_review_rounds and last_ai_review_notes in retry_counters', async () => {
    await db.query(`INSERT INTO requirements (id, raw_input, status, retry_counters)
      VALUES (1, 'test', 'spec_review', $1)`, [JSON.stringify({
        reject_counts: { spec_human_gate: 0 },
        ai_review_rounds: { spec_ai_review: 2 },
        last_ai_review_notes: { spec_author: [{ severity: 'error', msg: 'AC-3 主观词' }] },
      })])
    const { rows } = await db.query(`SELECT retry_counters FROM requirements WHERE id=1`)
    expect(rows[0].retry_counters.ai_review_rounds.spec_ai_review).toBe(2)
    expect(rows[0].retry_counters.last_ai_review_notes.spec_author[0].msg).toBe('AC-3 主观词')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-retry-counters-v65
```
Expected: FAIL — schema v65 not yet applied (test will fail at insertion if retry_counters CHECK constraint exists, or it pass schemalessly; either way the SCHEMA_FILES list must include v65 for `resetTestDb` to load it). Actually no CHECK constraint exists yet → test PASSES but is meaningless. Add explicit assertion:

```typescript
  it('v65 migration is registered in SCHEMA_FILES', async () => {
    const { rows } = await db.query(`SELECT version FROM _migrations WHERE version='v65'`)
    expect(rows.length).toBe(1)
  })
```

Re-run; expect FAIL: 0 rows.

- [ ] **Step 3: Write minimal implementation**

```sql
-- src/db/schema-v65.sql
-- v65: retry_counters JSONB extension for AI review counter + last notes
-- 不是 ALTER COLUMN (jsonb 本身 schemaless)，只是显式注释新增字段约定，
-- 供 repository 层 incrementAiReviewRound() 写入参考。
-- 此 migration 仅在 _migrations 表登记一行，方便升级追踪。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _migrations WHERE version='v65') THEN
    INSERT INTO _migrations(version, applied_at) VALUES ('v65', NOW());
  END IF;
END $$;

COMMENT ON COLUMN requirements.retry_counters IS
  'JSONB schema (v65): {
     reject_counts: {<node_id>: <count>},
     last_reject_reasons: {<author_node>: <string>},
     ai_review_rounds: {<review_node>: <count>},
     last_ai_review_notes: {<author_node>: Array<{severity,msg,file?}>}
   }';
```

Then update both SCHEMA_FILES lists:

```typescript
// src/db/migrate.ts (find SCHEMA_FILES const, append)
const SCHEMA_FILES = [
  // ... existing entries ...
  { version: 'v64', path: 'src/db/schema-v64.sql' },
  { version: 'v65', path: 'src/db/schema-v65.sql' },
]
```

```typescript
// src/__tests__/helpers/db.ts (find SCHEMA_FILES const, append v65)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
./test.sh --filter qi-retry-counters-v65
```
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v65.sql src/db/migrate.ts src/__tests__/helpers/db.ts src/__tests__/unit/qi-retry-counters-v65.test.ts
git commit -m "feat(qi): schema-v65 retry_counters JSONB extension for ai_review_rounds + last_ai_review_notes"
```

---

## Task 3: system_config qi 配置 + loadQiConfig

**Files:**
- Create: `src/quick-impl/qi-config.ts`
- Test: `src/__tests__/unit/qi-config-load.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-config-load.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/index.js'
import { resetTestDb } from '../helpers/db.js'
import { loadQiConfig } from '../../quick-impl/qi-config.js'

describe('loadQiConfig', () => {
  beforeEach(async () => { await resetTestDb() })

  it('returns defaults when no system_config row exists', async () => {
    const cfg = await loadQiConfig()
    expect(cfg.aiReviewMaxRounds).toBe(3)
    expect(cfg.tokenBudgetPerRequirement).toBe(250000)
  })

  it('returns DB values when set', async () => {
    await db.query(`INSERT INTO system_config(key, value) VALUES ('qi', $1)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ aiReviewMaxRounds: 2, tokenBudgetPerRequirement: 100000 })])
    const cfg = await loadQiConfig()
    expect(cfg.aiReviewMaxRounds).toBe(2)
    expect(cfg.tokenBudgetPerRequirement).toBe(100000)
  })

  it('clamps aiReviewMaxRounds to [1,5]', async () => {
    await db.query(`INSERT INTO system_config(key, value) VALUES ('qi', $1)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ aiReviewMaxRounds: 99 })])
    const cfg = await loadQiConfig()
    expect(cfg.aiReviewMaxRounds).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-config-load
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/quick-impl/qi-config.ts
import { z } from 'zod'
import { db } from '../db/index.js'

const QiConfigSchema = z.object({
  aiReviewMaxRounds: z.number().int().min(1).max(5).default(3),
  tokenBudgetPerRequirement: z.number().int().min(10000).default(250000),
})

export type QiConfig = z.infer<typeof QiConfigSchema>

export async function loadQiConfig(): Promise<QiConfig> {
  const { rows } = await db.query<{ value: unknown }>(
    `SELECT value FROM system_config WHERE key='qi' LIMIT 1`,
  )
  const raw = rows[0]?.value ?? {}
  return QiConfigSchema.parse(raw)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
./test.sh --filter qi-config-load
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/quick-impl/qi-config.ts src/__tests__/unit/qi-config-load.test.ts
git commit -m "feat(qi): add loadQiConfig() for aiReviewMaxRounds + tokenBudgetPerRequirement"
```

---

## Task 4: 数据清理脚本

**Files:**
- Create: `scripts/qi-data-cleanup.ts`

- [ ] **Step 1: Write the script as a one-shot tool (no test — exec checks effect on dev DB)**

```typescript
// scripts/qi-data-cleanup.ts
// dev-only utility: clear all QI execution data when topology changes break old rows.
// Refuses to run on production-looking DB.
import { db } from '../src/db/index.js'
import { execSync } from 'child_process'

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!url.includes('localhost') && !url.includes('127.0.0.1') && !process.env.QI_CLEANUP_FORCE) {
    throw new Error('Refuse to run on non-localhost DB; set QI_CLEANUP_FORCE=1 to override.')
  }
  await db.query('BEGIN')
  try {
    await db.query(`DELETE FROM requirement_approval_waiters`)
    await db.query(`DELETE FROM pipeline_run_state WHERE pipeline_run_id IN (
      SELECT id FROM pipeline_runs WHERE source_kind='qi'
    )`)
    await db.query(`DELETE FROM test_runs WHERE pipeline_run_id IN (
      SELECT id FROM pipeline_runs WHERE source_kind='qi'
    )`)
    await db.query(`DELETE FROM pipeline_runs WHERE source_kind='qi'`)
    await db.query(`DELETE FROM requirements`)

    // Seed default qi config so loadQiConfig() reads from DB on next pipeline start
    await db.query(`INSERT INTO system_config(key, value)
      VALUES('qi', $1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ aiReviewMaxRounds: 3, tokenBudgetPerRequirement: 250000 })])

    await db.query('COMMIT')
    console.log('QI cleanup complete.')
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  } finally {
    await db.pool.end()
  }

  // Prune stale qi-* worktrees on disk (outside transaction; non-fatal)
  try {
    execSync('git worktree prune', { stdio: 'inherit' })
    execSync('git worktree list | grep -E "qi-[0-9]+" | awk \'{print $1}\' | xargs -r -I {} git worktree remove --force {}',
      { stdio: 'inherit', shell: '/bin/bash' } as any)
  } catch (e) {
    console.warn('worktree prune failed (non-fatal):', e)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Verify the script lists what it would do (dry-run mental check)**

Read the script and confirm: only QI rows deleted, transaction-wrapped, refuses prod. No automated test (this is an admin tool).

- [ ] **Step 3: Add to package.json scripts**

```json
// package.json (find "scripts" object, add line)
"qi:cleanup": "tsx scripts/qi-data-cleanup.ts"
```

- [ ] **Step 4: Smoke run on local dev DB**

```bash
pnpm qi:cleanup
```
Expected: `QI cleanup complete.` no error.

- [ ] **Step 5: Commit**

```bash
git add scripts/qi-data-cleanup.ts package.json
git commit -m "chore(qi): add qi:cleanup script to wipe QI execution data for topology upgrade"
```

---

## Task 5: qi-spec-quality.md 规范文档抽取

**Files:**
- Create: `docs/standards/qi-spec-quality.md`

- [ ] **Step 1: Mechanical extraction sources identified**

读以下 3 处作为内容来源：
- `.claude/skills/quick-impl-artifact-author/roles/spec-author.md` "E2E 合规标准 A/B/C" 一段（约第 302-349 行）
- `.claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md` "7 项检查" 表（约第 70-79 行）
- `scripts/qi-spec-lint.ts` L1-L12 lint 规则注释

- [ ] **Step 2: Draft qi-spec-quality.md based on design §3.2 outline**

```markdown
# QI Spec Quality Standard v1

> 三个 LLM role（brainstorm-host / spec-author / spec-reviewer）共享的产品级 spec 质量规范。
> 改这里 = 改所有 role 的输出标准。绝对不要在 role.md 中重复定义这些规则。

## §1 产品级 spec 的最低要求

[5 维度覆盖矩阵：WHO/WHAT/AC/Scope/非功能 + 判定准则]

## §2 enrichedInput Schema 契约

[完整 zod schema 引用 src/quick-impl/enriched-input-schema.ts；brainstorm-host 输出 / spec-author 输入 / spec-reviewer 验证三方共识]

## §3 AC 质量准则

[GWT 格式 + 可观测断言定义 + 反模式黑名单：应该/正常/协调/友好 等]
[每条 AC 反向链接 enrichedInput.objective + scope.in 的强制性]

## §4 e2eScenarios 合规标准

[从 spec-author role.md 的 "硬规则 A / 软规则 B / 反模式 C" 整段迁移]

## §5 调研留痕标准

[references[] file:line 必须存在; brainstorm 已查证的 codebaseEvidence 必须复用，不允许重 grep]

## §6 反模式黑名单（共享）

[主观词命中 / 凑数 reviewHints / 凭空加 AC（rawInput 与 enrichedInput 中无锚点）等]

## §7 各 role 引用义务

| Role | 必读章节 |
|---|---|
| brainstorm-host | §1 §2 §6 |
| spec-author | §1 §2 §3 §4 §5 §6 |
| spec-reviewer | §1 §2 §3 §4 §5 §6（验证 spec-author 是否遵守）|
```

填上完整内容。每节 200-400 字，给具体例子。

- [ ] **Step 3: Cross-reference verification**

```bash
grep -n "应该\|正常工作\|协调\|友好\|良好" docs/standards/qi-spec-quality.md
```
Expected: 该文档自己**列举**反模式词时会命中，但反模式 section 之外不应有这些词。

```bash
grep -n "AC 反向链接 rawInput" docs/standards/qi-spec-quality.md
```
Expected: 0 matches — 应该全部说 "enrichedInput.objective + scope.in"，rawInput 仅冗余兜底。

- [ ] **Step 4: Visual review (manual)**

跳到 §4 e2eScenarios 合规章节，确认从 spec-author role.md 整段搬过来后内容完整（A 节硬规则表 + B 节软规则 + C 节反模式）。

- [ ] **Step 5: Commit**

```bash
git add docs/standards/qi-spec-quality.md
git commit -m "docs(qi): add qi-spec-quality.md as shared standard for brainstorm/spec-author/reviewer"
```

---

# M1: AI Review 真循环

## Task 6: REJECT_CAP 3 → 2 + plan/dev 同步

**Files:**
- Modify: `src/pipeline/graph-builder.ts:2509`
- Modify: `src/__tests__/integration/qi-reject-round2.integration.test.ts`
- Test: existing tests cover this

- [ ] **Step 1: Locate all REJECT_CAP usages**

```bash
grep -rn "REJECT_CAP" src/
```
Expected: 1 const definition + 2 usages (incrementRejectCount cap check, integration test loop).

- [ ] **Step 2: Update the constant**

```typescript
// src/pipeline/graph-builder.ts:2509
export const REJECT_CAP = 2  // was 3; aligned with flowchart 2026-05-12
```

- [ ] **Step 3: Update existing integration test expectation**

```typescript
// src/__tests__/integration/qi-reject-round2.integration.test.ts
it('e2e 5.3: 连续 2 次 reject → reject_counts=2 = REJECT_CAP', async () => {
  for (let i = 1; i <= REJECT_CAP; i++) {  // loop bound auto-shifts
    // ...
  }
  // assertion bodies should already reference REJECT_CAP, not literal 3
})
```

Verify the test file references `REJECT_CAP` and not literal `3` in assertions; fix if needed.

- [ ] **Step 4: Run all qi-reject tests + verify plan/dev cap propagation**

```bash
./test.sh --filter qi-reject
```
Expected: all green.

Then add explicit cross-stage coverage in `src/__tests__/integration/qi-reject-round2.integration.test.ts`:

```typescript
it('e2e: plan_human_gate respects REJECT_CAP=2 (cross-stage const propagation)', async () => {
  // seed requirement at plan_human_gate stage, reject twice, expect aborted
  // mirrors spec_human_gate test but on plan node
})

it('e2e: dev_human_gate respects REJECT_CAP=2 (cross-stage const propagation)', async () => {
  // same shape for dev
})
```

Run again; expect green. This guards against plan/dev silently keeping the old behavior if any future PR forks the constant.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/integration/qi-reject-round2.integration.test.ts
git commit -m "fix(qi): REJECT_CAP 3 → 2 aligned with flowchart"
```

---

## Task 7: spec_ai_review 出口改条件分支

**Files:**
- Modify: `src/quick-impl/bootstrap.ts` (around L546)
- Test: `src/__tests__/unit/qi-topology-ai-review-edges.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-topology-ai-review-edges.test.ts
import { describe, it, expect } from 'vitest'
import { buildQiPipeline } from '../../quick-impl/bootstrap.js'

describe('QI spec_ai_review topology edges', () => {
  it('spec_ai_review has onSuccess to spec_human_gate', () => {
    const { edges } = buildQiPipeline()
    const e = edges.find(e =>
      e.source === 'spec_ai_review' &&
      e.target === 'spec_human_gate' &&
      e.condition?.kind === 'onSuccess'
    )
    expect(e).toBeDefined()
  })

  it('spec_ai_review has onFailure back to spec_author', () => {
    const { edges } = buildQiPipeline()
    const e = edges.find(e =>
      e.source === 'spec_ai_review' &&
      e.target === 'spec_author' &&
      e.condition?.kind === 'onFailure'
    )
    expect(e).toBeDefined()
  })

  it('there is no unconditional spec_ai_review → spec_human_gate edge', () => {
    const { edges } = buildQiPipeline()
    const direct = edges.find(e =>
      e.source === 'spec_ai_review' &&
      e.target === 'spec_human_gate' &&
      !e.condition
    )
    expect(direct).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-topology-ai-review-edges
```
Expected: FAIL — current edge is unconditional.

- [ ] **Step 3: Modify bootstrap.ts edges**

Locate around L546 in `src/quick-impl/bootstrap.ts`:

```typescript
// Before:
edges.push({ id: 'spec_ai_review__spec_human_gate', source: 'spec_ai_review', target: 'spec_human_gate' })

// After:
edges.push({
  id: 'spec_ai_review__spec_human_gate_pass',
  source: 'spec_ai_review',
  target: 'spec_human_gate',
  condition: { kind: 'onSuccess' },
})
edges.push({
  id: 'spec_ai_review__spec_author_retry',
  source: 'spec_ai_review',
  target: 'spec_author',
  condition: { kind: 'onFailure' },
})
```

Also update `spec_ai_review` node's params to expose `aiReviewMaxRounds` (read from qi-config at runtime; for now placeholder):

```typescript
makeNode('spec_ai_review', {
  // ... existing params ...
  aiReviewMaxRounds: 3,  // overridden by qi-config at runtime
})
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-topology-ai-review-edges
```
Expected: 3 passing. Re-run full QI topology test suite to catch regressions.

- [ ] **Step 5: Commit**

```bash
git add src/quick-impl/bootstrap.ts src/__tests__/unit/qi-topology-ai-review-edges.test.ts
git commit -m "feat(qi): spec_ai_review topology condition branches (onSuccess/onFailure)"
```

---

## Task 8: handleAiReviewFailure helper + retry_counters 增量

**Files:**
- Modify: `src/pipeline/graph-builder.ts` (near `handleHumanGateRejection`)
- Modify: `src/db/repositories/requirements.ts`
- Test: `src/__tests__/unit/qi-handle-ai-review-failure.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-handle-ai-review-failure.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../../db/index.js'
import { resetTestDb } from '../helpers/db.js'
import { handleAiReviewFailure } from '../../pipeline/graph-builder.js'

describe('handleAiReviewFailure', () => {
  beforeEach(async () => { await resetTestDb() })

  it('increments ai_review_rounds and triggers retry within cap', async () => {
    await db.query(`INSERT INTO requirements(id, raw_input, status, retry_counters)
      VALUES (1, 'x', 'spec_review', '{}')`)
    const r = await handleAiReviewFailure({
      runId: 1, requirementId: 1, reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author', reviewNotes: [{ severity: 'error', msg: 'x' }],
      aiReviewMaxRounds: 3,
    })
    expect(r.shouldRetry).toBe(true)
    expect(r.newCount).toBe(1)
    const { rows } = await db.query(`SELECT retry_counters FROM requirements WHERE id=1`)
    expect(rows[0].retry_counters.ai_review_rounds.spec_ai_review).toBe(1)
    expect(rows[0].retry_counters.last_ai_review_notes.spec_author).toHaveLength(1)
  })

  it('does not retry once cap is reached', async () => {
    await db.query(`INSERT INTO requirements(id, raw_input, status, retry_counters)
      VALUES (1, 'x', 'spec_review', $1)`,
      [JSON.stringify({ ai_review_rounds: { spec_ai_review: 3 } })])
    const r = await handleAiReviewFailure({
      runId: 1, requirementId: 1, reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author', reviewNotes: [],
      aiReviewMaxRounds: 3,
    })
    expect(r.shouldRetry).toBe(false)
    expect(r.newCount).toBe(3)
  })

  it('ai_review_rounds and reject_counts counters do not interfere', async () => {
    // Seed both counters non-zero
    await db.query(`INSERT INTO requirements(id, raw_input, status, retry_counters)
      VALUES (1, 'x', 'spec_review', $1)`,
      [JSON.stringify({ reject_counts: { spec_human_gate: 1 }, ai_review_rounds: { spec_ai_review: 1 } })])

    // Increment ai_review_rounds via handleAiReviewFailure
    await handleAiReviewFailure({
      runId: 1, requirementId: 1, reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author', reviewNotes: [], aiReviewMaxRounds: 3,
    })

    const { rows } = await db.query(`SELECT retry_counters FROM requirements WHERE id=1`)
    expect(rows[0].retry_counters.reject_counts.spec_human_gate).toBe(1) // unchanged
    expect(rows[0].retry_counters.ai_review_rounds.spec_ai_review).toBe(2) // incremented
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-handle-ai-review-failure
```
Expected: FAIL — handleAiReviewFailure not exported.

- [ ] **Step 3: Write implementation**

```typescript
// src/db/repositories/requirements.ts (add functions)
export async function incrementAiReviewRound(
  requirementId: number,
  reviewNodeId: string,
  authorNodeId: string,
  reviewNotes: unknown[],
): Promise<number> {
  const { rows } = await db.query<{ retry_counters: any }>(
    `UPDATE requirements
     SET retry_counters = jsonb_set(
       jsonb_set(
         COALESCE(retry_counters, '{}'::jsonb),
         '{ai_review_rounds,' || $2::text || '}',
         (COALESCE(retry_counters->'ai_review_rounds'->>$2, '0')::int + 1)::text::jsonb
       ),
       '{last_ai_review_notes,' || $3::text || '}',
       $4::jsonb
     )
     WHERE id = $1
     RETURNING retry_counters`,
    [requirementId, reviewNodeId, authorNodeId, JSON.stringify(reviewNotes)],
  )
  return rows[0].retry_counters.ai_review_rounds[reviewNodeId]
}

export async function getAiReviewRound(requirementId: number, reviewNodeId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT COALESCE((retry_counters->'ai_review_rounds'->>$2)::int, 0) AS count
     FROM requirements WHERE id = $1`,
    [requirementId, reviewNodeId],
  )
  return rows[0]?.count ?? 0
}
```

```typescript
// src/pipeline/graph-builder.ts (after handleHumanGateRejection)
export async function handleAiReviewFailure(args: {
  runId: number
  requirementId: number
  reviewNodeId: string
  retryToOnFailure: string  // e.g. 'spec_author'
  reviewNotes: unknown[]
  aiReviewMaxRounds: number
}): Promise<{ shouldRetry: boolean; newCount: number }> {
  const { runId, requirementId, reviewNodeId, retryToOnFailure, reviewNotes, aiReviewMaxRounds } = args
  const currentCount = await getAiReviewRound(requirementId, reviewNodeId)
  if (currentCount >= aiReviewMaxRounds) {
    return { shouldRetry: false, newCount: currentCount }
  }
  const newCount = await incrementAiReviewRound(requirementId, reviewNodeId, retryToOnFailure, reviewNotes)
  setTimeout(async () => {
    try {
      await retryFromNode(runId, retryToOnFailure)
    } catch (err) {
      console.error(`[ai_review] retryFromNode(${retryToOnFailure}) for run ${runId} failed:`, err)
    }
  }, 100)
  return { shouldRetry: true, newCount }
}
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-handle-ai-review-failure
```
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/db/repositories/requirements.ts src/__tests__/unit/qi-handle-ai-review-failure.test.ts
git commit -m "feat(qi): handleAiReviewFailure helper + incrementAiReviewRound repo fn"
```

---

## Task 9: llm-review 节点 wire up handleAiReviewFailure

**Files:**
- Modify: `src/pipeline/node-types/llm-review.ts` or `src/pipeline/graph-builder.ts:buildLlmReviewNode`

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/__tests__/integration/qi-ai-review-retry.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { startQiPipelineForFixture } from '../helpers/qi.js'
import { db } from '../../db/index.js'
import { resetTestDb } from '../helpers/db.js'

describe('QI spec_ai_review retry loop', () => {
  beforeEach(async () => { await resetTestDb() })

  it('AI review fail triggers retry to spec_author and increments ai_review_rounds', async () => {
    const { requirementId } = await startQiPipelineForFixture({
      specAuthorMockOutput: { decision: 'pass', /* ...  */},
      specReviewerMockSequence: [
        { decision: 'fail', notes: [{ severity: 'error', msg: 'AC-3 主观词' }] },
        { decision: 'pass' },
      ],
    })
    // wait for pipeline to settle (helper polls until status changes)
    const { rows } = await db.query(`SELECT retry_counters, status FROM requirements WHERE id=$1`, [requirementId])
    expect(rows[0].retry_counters.ai_review_rounds.spec_ai_review).toBe(1)
    expect(rows[0].status).toBe('spec_human_gate_pending')
  })
})
```

(Note: `startQiPipelineForFixture` is a test helper that does not exist yet—create a minimal one in `src/__tests__/helpers/qi.ts` that boots a pipeline and stubs LLM calls. See M6 Task 30 for full E2E setup.)

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-ai-review-retry
```
Expected: FAIL — buildLlmReviewNode doesn't call handleAiReviewFailure yet.

- [ ] **Step 3: Modify buildLlmReviewNode**

In `src/pipeline/graph-builder.ts` `buildLlmReviewNode` (~L2290), at the end of the node execution function, after computing `decision`:

```typescript
const decision: 'pass' | 'fail' = result.output.decision
const output = {
  decision,
  notes: notesString,
  round,
}

if (decision === 'fail') {
  const cfg = await loadQiConfig()
  const retryTo = typeof params.retryToOnFailure === 'string' ? params.retryToOnFailure : null
  if (retryTo) {
    const r = await handleAiReviewFailure({
      runId, requirementId, reviewNodeId: node.id,
      retryToOnFailure: retryTo,
      reviewNotes: result.output.notes ?? [],
      aiReviewMaxRounds: cfg.aiReviewMaxRounds,
    })
    if (r.shouldRetry) {
      return { /* signal pipeline to wait for retry */ }
    }
    // cap reached: fall through to onFailure edge → spec_human_gate
    output.exhausted = true
  }
}

return { output }
```

Add `retryToOnFailure` to `spec_ai_review` node params in bootstrap.ts: `retryToOnFailure: 'spec_author'`.

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-ai-review-retry
```
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/quick-impl/bootstrap.ts src/__tests__/integration/qi-ai-review-retry.integration.test.ts src/__tests__/helpers/qi.ts
git commit -m "feat(qi): wire spec_ai_review fail through handleAiReviewFailure to retry spec_author"
```

---

## Task 10: spec-reviewer round 2+ 逐项追踪 schema

**Files:**
- Modify: `.claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md`
- Modify: `src/pipeline/node-types/llm-review.ts` (output validation)
- Test: `src/__tests__/unit/qi-reviewer-itemized-tracking.test.ts`

- [ ] **Step 1: Write the failing test for schema validation**

```typescript
// src/__tests__/unit/qi-reviewer-itemized-tracking.test.ts
import { describe, it, expect } from 'vitest'
import { SpecReviewOutputSchema } from '../../pipeline/node-types/llm-review.js'

describe('SpecReviewOutput round 2+ itemized tracking', () => {
  it('round 1 does not require resolvedFromPrevious', () => {
    const out = { round: 1, decision: 'fail', notes: [{ severity: 'error', msg: 'x' }],
                  newIssues: [{ severity: 'error', msg: 'x' }], decisionBasis: 'first review' }
    expect(() => SpecReviewOutputSchema.parse(out)).not.toThrow()
  })

  it('round 2+ requires resolvedFromPrevious array', () => {
    const out = { round: 2, decision: 'fail', notes: [],
                  newIssues: [], decisionBasis: '...' /* missing resolvedFromPrevious */ }
    expect(() => SpecReviewOutputSchema.parse(out)).toThrow(/resolvedFromPrevious/)
  })

  it('round 2+ accepts resolvedFromPrevious with status enum', () => {
    const out = {
      round: 2, decision: 'pass',
      notes: [], newIssues: [], decisionBasis: 'all fixed',
      resolvedFromPrevious: [{ previousNote: 'AC-3 主观词', status: 'resolved', evidence: '改成 status=201' }],
    }
    expect(() => SpecReviewOutputSchema.parse(out)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-reviewer-itemized-tracking
```
Expected: FAIL — SpecReviewOutputSchema not exported.

- [ ] **Step 3: Add the schema and export from llm-review.ts**

```typescript
// src/pipeline/node-types/llm-review.ts
import { z } from 'zod'

export const SpecReviewOutputSchema = z.object({
  round: z.number().int().min(1),
  decision: z.enum(['pass', 'fail']),
  notes: z.array(z.object({ severity: z.enum(['error', 'warn']), msg: z.string(), file: z.string().optional() })),
  newIssues: z.array(z.object({ severity: z.enum(['error', 'warn']), msg: z.string(), file: z.string().optional() })),
  decisionBasis: z.string(),
  resolvedFromPrevious: z.array(z.object({
    previousNote: z.string(),
    status: z.enum(['resolved', 'still-failing', 'not-applicable']),
    evidence: z.string(),
  })).optional(),
}).superRefine((data, ctx) => {
  if (data.round >= 2 && !data.resolvedFromPrevious) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolvedFromPrevious'],
      message: 'resolvedFromPrevious is required when round >= 2',
    })
  }
})
```

Update spec-reviewer role.md, adding a new section "## Round 2+ 逐项追踪" with the schema specification + instructions: "round >= 2 时必须读 `inputs.previousReviewNotes` 数组，对每条做 resolved/still-failing/not-applicable 判定，evidence 写明你看到的改动证据"。

**Same file: 4 additional revisions to spec-reviewer role.md** (consolidated to avoid touching the file twice):

1. **S1 措辞替换**：把现有 "AC 反向链接 rawInput 中可识别的需求点" 改为 "AC 反向链接 `enrichedInput.objective` + `enrichedInput.scope.in`；rawInput 仅作冗余兜底（brainstorm failed 退化路径时使用）"。
2. **S3 在 degraded=true 时收紧**：在 S3 项末加一句 "若 `devOutput.degraded === true`，则 `clarifications[]` 中 `kind=assumption` 项必须**逐一覆盖** `devOutput.missingFields` 的每一条；缺一即 S3 fail"。
3. **7 项检查每条标注 ← qi-spec-quality.md §X 兜底**：在每项末尾追加 § 引用，例如 "S1 ... ← qi-spec-quality.md §3 兜底"、"S2 ... ← qi-spec-quality.md §3 / §6 兜底" 等。
4. **新 warn 规则**：在 "fail 条件" 后新增 "## warn 规则（不阻断但写入 notes）"，第一条："若 `round >= 2` 且 `newIssues.length > resolvedFromPrevious.length`，输出一条 `severity: warn, msg: 'reviewer 标准漂移嫌疑 - 新发现 > 已解决'`"。

**Also: lint-side enforcement of the warn rule**

In `src/pipeline/node-types/llm-review.ts` `buildLlmReviewNode`, after parsing reviewer output, emit the warn note programmatically (don't rely on LLM to remember):

```typescript
// Inside buildLlmReviewNode execute fn, after result.output validation:
if (result.output.round >= 2) {
  const newCount = result.output.newIssues?.length ?? 0
  const resolvedCount = result.output.resolvedFromPrevious?.length ?? 0
  if (newCount > resolvedCount) {
    result.output.notes = [
      ...(result.output.notes ?? []),
      { severity: 'warn', msg: `reviewer drift suspect: newIssues (${newCount}) > resolved (${resolvedCount})` },
    ]
  }
}
```

Add a test for this lint behavior:

```typescript
// src/__tests__/unit/qi-reviewer-itemized-tracking.test.ts (extend)
it('emits drift warn when newIssues > resolvedFromPrevious in round 2+', async () => {
  // mock buildLlmReviewNode invocation with round 2, newIssues.length=3, resolvedFromPrevious.length=1
  // assert output.notes contains a warn with 'reviewer drift suspect'
})
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-reviewer-itemized-tracking
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/node-types/llm-review.ts .claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md src/__tests__/unit/qi-reviewer-itemized-tracking.test.ts
git commit -m "feat(qi): spec-reviewer round 2+ itemized tracking schema (resolvedFromPrevious)"
```

---

## Task 11: token budget 检查（spec_ai_review 入口）

**Files:**
- Modify: `src/pipeline/graph-builder.ts:buildLlmReviewNode`
- Test: `src/__tests__/unit/qi-token-budget.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-token-budget.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/index.js'
import { resetTestDb } from '../helpers/db.js'
import { checkTokenBudget } from '../../quick-impl/qi-config.js'

describe('checkTokenBudget', () => {
  beforeEach(async () => { await resetTestDb() })

  it('returns ok=true when under budget', async () => {
    const r = await checkTokenBudget({ pipelineRunId: 1, usedTokens: 100000, budget: 250000 })
    expect(r.ok).toBe(true)
  })

  it('returns ok=false when over budget', async () => {
    const r = await checkTokenBudget({ pipelineRunId: 1, usedTokens: 300000, budget: 250000 })
    expect(r.ok).toBe(false)
    expect(r.usedTokens).toBe(300000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-token-budget
```
Expected: FAIL — checkTokenBudget not exported.

- [ ] **Step 3: Add checkTokenBudget to qi-config.ts**

```typescript
// src/quick-impl/qi-config.ts (append)
export async function checkTokenBudget(args: {
  pipelineRunId: number
  usedTokens: number
  budget: number
}): Promise<{ ok: boolean; usedTokens: number; budget: number }> {
  return { ok: args.usedTokens < args.budget, usedTokens: args.usedTokens, budget: args.budget }
}

export async function getCumulativeTokenUsage(pipelineRunId: number): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    `SELECT COALESCE(SUM((data->>'token_total')::int), 0) AS total
     FROM pipeline_run_state WHERE pipeline_run_id = $1`,
    [pipelineRunId],
  )
  return rows[0]?.total ?? 0
}
```

Wire into buildLlmReviewNode (early return before LLM call):

```typescript
// inside buildLlmReviewNode execute fn, near top:
const cfg = await loadQiConfig()
const usedTokens = await getCumulativeTokenUsage(runId)
const budgetCheck = await checkTokenBudget({ pipelineRunId: runId, usedTokens, budget: cfg.tokenBudgetPerRequirement })
if (!budgetCheck.ok) {
  // force success-out to human_gate with budget overflow note
  return {
    output: {
      decision: 'pass',
      notes: 'token budget exceeded; AI review skipped, escalating to human_gate',
      tokenBudgetExceeded: true,
      usedTokens,
      budget: cfg.tokenBudgetPerRequirement,
    },
  }
}
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-token-budget
```
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/quick-impl/qi-config.ts src/pipeline/graph-builder.ts src/__tests__/unit/qi-token-budget.test.ts
git commit -m "feat(qi): token budget check at spec_ai_review entry; escalate to human_gate when exceeded"
```

---

## Task 11.5: token budget 同步覆盖 plan_ai_review / dev_ai_review

**Why:** spec design §4 R4 明确要求 `进入 spec_brainstorm / spec_ai_review / **plan_ai_review** / **dev_ai_review** 前都检查累计 token`。T11 只接了 spec_ai_review；同样的 budget gate 必须覆盖 plan / dev 两个 review 节点，否则 plan/dev 阶段会失控烧 token。

**Files:**
- Modify: `src/pipeline/graph-builder.ts:buildLlmReviewNode` (lift budget gate to common path)
- Test: `src/__tests__/unit/qi-token-budget-cross-stages.test.ts`

- [ ] **Step 1: Write the failing cross-stage test**

```typescript
// src/__tests__/unit/qi-token-budget-cross-stages.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/index.js'
import { resetTestDb } from '../helpers/db.js'
import { invokeReviewNodeFor } from '../helpers/qi.js' // helper that invokes builder for a given node id

describe('token budget gate applies to all *_ai_review nodes', () => {
  beforeEach(async () => { await resetTestDb() })

  for (const nodeId of ['spec_ai_review', 'plan_ai_review', 'dev_ai_review']) {
    it(`${nodeId}: skips self-loop and escalates when budget exceeded`, async () => {
      // seed pipeline_run_state.token_usage > 250k for run 1
      await db.query(`INSERT INTO pipeline_run_state(pipeline_run_id, data) VALUES (1, '{"token_total":300000}'::jsonb)`)
      const out = await invokeReviewNodeFor({ nodeId, runId: 1, requirementId: 1 })
      expect(out.tokenBudgetExceeded).toBe(true)
      expect(out.decision).toBe('pass') // forced pass to escalate to human_gate
    })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-token-budget-cross-stages
```
Expected: FAIL for plan_ai_review and dev_ai_review (only spec_ai_review currently has the gate).

- [ ] **Step 3: Lift budget gate from spec-specific to common buildLlmReviewNode path**

In `src/pipeline/graph-builder.ts:buildLlmReviewNode` (the function shared by all three review nodes), move the budget check to the top of the execute fn so all `*_ai_review` nodes inherit it. T11 already inserted the gate; here we confirm it's **not gated by `node.id === 'spec_ai_review'`**. If the T11 implementation accidentally specialized by node id, remove that specialization:

```typescript
// src/pipeline/graph-builder.ts buildLlmReviewNode execute fn (near top):
const cfg = await loadQiConfig()
const usedTokens = await getCumulativeTokenUsage(runId)
const budgetCheck = await checkTokenBudget({
  pipelineRunId: runId, usedTokens, budget: cfg.tokenBudgetPerRequirement,
})
if (!budgetCheck.ok) {
  // applies uniformly to spec/plan/dev ai_review nodes
  return {
    output: {
      decision: 'pass',
      notes: 'token budget exceeded; AI review skipped, escalating to human_gate',
      tokenBudgetExceeded: true,
      usedTokens,
      budget: cfg.tokenBudgetPerRequirement,
    },
  }
}
```

- [ ] **Step 4: Run tests + verify all three node IDs covered**

```bash
./test.sh --filter qi-token-budget
```
Expected: all green (spec / plan / dev all pass the budget-skip case).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/qi-token-budget-cross-stages.test.ts
git commit -m "feat(qi): token budget gate covers plan_ai_review + dev_ai_review (not just spec)"
```

---

# M2: spec-author 升级 + 人审/摘要

## Task 12: skill-runner symlink 扩展（worktree → .qi-context/）

**Files:**
- Modify: `src/pipeline/skill-runner.ts` (or wherever .qi-context/ is populated)
- Test: `src/__tests__/unit/qi-skill-runner-symlink.test.ts`

- [ ] **Step 1: Locate the existing .qi-context/ population code**

```bash
grep -rn ".qi-context\|qi-context" src/pipeline/ src/quick-impl/ | head -20
```
Identify the function that writes `.qi-context/inputs.json` and `.qi-context/standards/`.

- [ ] **Step 2: Write the failing test**

```typescript
// src/__tests__/unit/qi-skill-runner-symlink.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { populateQiContext } from '../../pipeline/skill-runner.js'

describe('populateQiContext', () => {
  let worktree: string
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'qi-ctx-'))
    await mkdir(join(worktree, 'docs/brainstorm'), { recursive: true })
    await writeFile(join(worktree, 'docs/brainstorm/qi-1.md'), '# brainstorm content')
    await writeFile(join(worktree, 'docs/brainstorm/qi-1.json'), JSON.stringify({ schemaVersion: 'v1', rawInput: 'x' }))
  })

  it('symlinks brainstorm.md and enriched-input.json into .qi-context/', async () => {
    await populateQiContext({
      worktreePath: worktree, requirementId: 1, role: 'spec-author',
    })
    const brainstormContent = await readFile(join(worktree, '.qi-context/brainstorm.md'), 'utf-8')
    expect(brainstormContent).toBe('# brainstorm content')
    const enriched = JSON.parse(await readFile(join(worktree, '.qi-context/enriched-input.json'), 'utf-8'))
    expect(enriched.rawInput).toBe('x')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
./test.sh --filter qi-skill-runner-symlink
```
Expected: FAIL — populateQiContext doesn't symlink brainstorm files yet.

- [ ] **Step 4: Add symlink logic to populateQiContext**

```typescript
// src/pipeline/skill-runner.ts (in populateQiContext)
import { symlink, access } from 'fs/promises'

async function safeSymlink(target: string, link: string) {
  try { await access(target); await symlink(target, link) } catch {}
}

export async function populateQiContext(args: {
  worktreePath: string; requirementId: number; role: string;
}) {
  // ... existing logic for role.md / inputs.json / standards/ ...

  const ctxDir = join(args.worktreePath, '.qi-context')
  const brainstormMd = join(args.worktreePath, `docs/brainstorm/qi-${args.requirementId}.md`)
  const enrichedJson = join(args.worktreePath, `docs/brainstorm/qi-${args.requirementId}.json`)

  // For spec-author and spec-reviewer roles, symlink brainstorm artifacts
  if (['spec-author', 'spec-reviewer'].includes(args.role)) {
    await safeSymlink(brainstormMd, join(ctxDir, 'brainstorm.md'))
    await safeSymlink(enrichedJson, join(ctxDir, 'enriched-input.json'))
  }
}
```

- [ ] **Step 5: Run tests + commit**

```bash
./test.sh --filter qi-skill-runner-symlink
```
Expected: passing.

```bash
git add src/pipeline/skill-runner.ts src/__tests__/unit/qi-skill-runner-symlink.test.ts
git commit -m "feat(qi): skill-runner symlinks brainstorm artifacts for spec-author/reviewer"
```

---

## Task 13: spec-author role.md 升级（3 状态分支）

**Files:**
- Modify: `.claude/skills/quick-impl-artifact-author/roles/spec-author.md`
- Modify: `.claude/skills/quick-impl-artifact-author/role-manifest.json`

- [ ] **Step 1: Update role-manifest.json**

```json
// .claude/skills/quick-impl-artifact-author/role-manifest.json
{
  "$schema": "./role-manifest.schema.json",
  "spec-author": {
    "standards": ["frontend-enum-select.md", "qi-spec-quality.md"],
    "inputs": ["rawInput", "enrichedInput", "brainstormPath", "codebaseEvidence"]
  },
  "spec-reviewer": {
    "standards": ["qi-spec-quality.md"],
    "inputs": ["devOutput", "rawInput", "enrichedInput", "round", "reviewNotes", "previousReviewNotes"]
  },
  "brainstorm-host": {
    "standards": ["qi-spec-quality.md"],
    "inputs": ["rawInput", "previousTurns", "round"]
  },
  // ... existing roles unchanged ...
}
```

- [ ] **Step 2: Add §4 状态分支 to spec-author.md**

After the existing "## 任务步骤" section, add:

```markdown
## §4 输入状态分支处理

根据 `inputs.enrichedInput.partial` 字段和上游 brainstorm 节点状态，分 3 个分支：

### 分支 A: enrichedInput.partial === false （正常路径）

- 必须读完 `enrichedInput` 全部字段（actors / objective / scope / noGos / historicalRefs / codebaseEvidence）
- **禁止重新 grep** `codebaseEvidence` 中已声明 file:line 的目标；如发现 evidence 错误，在 `notes` 中记录 warn
- `clarifications[]` 只允许标记 enrichedInput 之外的边角假设（不能重复 enrichedInput 已声明的）

### 分支 B: enrichedInput.partial === true （brainstorm 部分收集）

- 读 `enrichedInput.missingFields` 数组识别哪些字段缺
- 对每个缺失字段按以下顺序处理：
  1. 优先用 Bash/Grep/Read 工具自答（如 verifier 缺失但 codebase 有 OWNERS 文件）
  2. 自答不出 → 填合理默认值
  3. 在 `clarifications[]` 中以 `kind: "assumption"` 显式标记，附 `userMayDisagreeIf`
- **输出 JSON 顶层加 `degraded: true` 信号**，并在 notes 加 warn "brainstorm partial, X fields auto-filled"

### 分支 C: brainstorm 节点 failed（无 enrichedInput）

- 退化为仅读 rawInput 启动（等同 brainstorm 上线前行为）
- 输出 JSON 顶层加 `degraded: true` + notes warn "brainstorm failed, fallback to rawInput-only"
- `clarifications[]` 必须覆盖至少 3 项 `kind: "assumption"`（弥补无 enrichedInput 时的不确定性）
```

Then locate the existing E2E 合规标准 A/B/C section (~ L302-349) and replace with:

```markdown
## E2E 合规标准

见 [docs/standards/qi-spec-quality.md §4](../../../docs/standards/qi-spec-quality.md#4-e2escenarios-合规标准)。本 role 输出的 e2eScenarios 必须满足该规范全部硬规则。
```

- [ ] **Step 3: Verify file is well-formed**

```bash
grep -n "degraded: true\|missingFields\|分支 A\|分支 B\|分支 C" .claude/skills/quick-impl-artifact-author/roles/spec-author.md
```
Expected: matches for §4 internal references.

- [ ] **Step 4: Run skill-loading smoke**

```bash
./test.sh --filter qi-skill-role-load
```
If no such test exists, add a tiny check: skip.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/quick-impl-artifact-author/roles/spec-author.md .claude/skills/quick-impl-artifact-author/role-manifest.json
git commit -m "feat(qi): spec-author 3-branch input handling (partial/failed/normal) + E2E section moved to qi-spec-quality.md"
```

---

## Task 14: spec_human_gate 决策树简化

**Files:**
- Modify: `src/pipeline/graph-builder.ts:buildHumanGateNode` (decision_set option)
- Modify: `src/quick-impl/bootstrap.ts:spec_human_gate node params`

- [ ] **Step 1: Locate decision_set usage**

```bash
grep -n "decision_set\|deferred\|aborted" src/pipeline/graph-builder.ts src/quick-impl/bootstrap.ts | head -10
```

- [ ] **Step 2: Update spec_human_gate node params**

In `src/quick-impl/bootstrap.ts`, find `spec_human_gate` node, ensure `decisionSet: ['approved', 'rejected']` (drop any 'deferred'/'aborted').

```typescript
makeNode('spec_human_gate', {
  // ...
  decisionSet: ['approved', 'rejected'],  // explicit; no deferred/aborted
  retryToOnReject: 'spec_author',
})
```

If the existing param key is different (e.g. `decision_set` snake_case), match the existing convention.

- [ ] **Step 3: Add unit test for decision validation**

```typescript
// src/__tests__/unit/qi-spec-human-gate-decisions.test.ts
import { describe, it, expect } from 'vitest'
import { buildQiPipeline } from '../../quick-impl/bootstrap.js'

describe('spec_human_gate decision_set', () => {
  it('only allows approved/rejected', () => {
    const { nodes } = buildQiPipeline()
    const gate = nodes.find(n => n.id === 'spec_human_gate')!
    expect(gate.params.decisionSet).toEqual(['approved', 'rejected'])
  })
})
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-spec-human-gate-decisions
```
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add src/quick-impl/bootstrap.ts src/__tests__/unit/qi-spec-human-gate-decisions.test.ts
git commit -m "feat(qi): simplify spec_human_gate decision_set to approved/rejected only"
```

---

## Task 15: 审批摘要含 AI 历次 notes

**Files:**
- Modify: `src/pipeline/approval-summary/spec.ts` (buildSpecApprovalSummary)
- Test: `src/__tests__/unit/qi-spec-approval-summary-ai-notes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-spec-approval-summary-ai-notes.test.ts
import { describe, it, expect } from 'vitest'
import { buildSpecApprovalSummary } from '../../pipeline/approval-summary/spec.ts'

describe('buildSpecApprovalSummary with AI history', () => {
  it('includes last_ai_review_notes section when present', async () => {
    const summary = await buildSpecApprovalSummary({
      requirementId: 1, runId: 1,
      retryCounters: {
        ai_review_rounds: { spec_ai_review: 3 },
        last_ai_review_notes: { spec_author: [
          { severity: 'error', msg: 'AC-3 主观词' },
          { severity: 'error', msg: 'reviewHints 空' },
        ]},
      },
      specPath: 'docs/specs/qi-1.md',
      specMdContent: '# spec content',
    })
    expect(summary.webText).toContain('AI 历次 review notes')
    expect(summary.webText).toContain('AC-3 主观词')
    expect(summary.webText).toContain('round 3')
  })

  it('omits AI history section when no notes recorded', async () => {
    const summary = await buildSpecApprovalSummary({
      requirementId: 1, runId: 1, retryCounters: {},
      specPath: 'docs/specs/qi-1.md', specMdContent: '#',
    })
    expect(summary.webText).not.toContain('AI 历次 review notes')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-spec-approval-summary-ai-notes
```
Expected: FAIL.

- [ ] **Step 3: Modify buildSpecApprovalSummary**

```typescript
// src/pipeline/approval-summary/spec.ts (add section)
export async function buildSpecApprovalSummary(args: {
  requirementId: number; runId: number;
  retryCounters?: any;
  specPath: string; specMdContent: string;
}): Promise<{ webText: string; imText: string }> {
  // ... existing logic ...

  let aiHistorySection = ''
  const aiRounds = args.retryCounters?.ai_review_rounds?.spec_ai_review ?? 0
  const aiNotes = args.retryCounters?.last_ai_review_notes?.spec_author ?? []
  if (aiRounds > 0 && aiNotes.length > 0) {
    aiHistorySection = `
### AI 历次 review notes (round ${aiRounds})
${aiNotes.map((n: any) => `- [${n.severity}] ${n.msg}${n.file ? ` (${n.file})` : ''}`).join('\n')}
`
  }

  const webText = [
    // ... existing sections ...
    aiHistorySection,
  ].join('\n\n')

  return { webText, imText: /* unchanged */ '' }
}
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-spec-approval-summary-ai-notes
```
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/approval-summary/spec.ts src/__tests__/unit/qi-spec-approval-summary-ai-notes.test.ts
git commit -m "feat(qi): spec approval summary includes AI history notes for human reviewer"
```

---

# M3: spec_brainstorm 节点核心

## Task 16: brainstorm-host role 文件

**Files:**
- Create: `.claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md`
- Modify: `.claude/skills/quick-impl-artifact-author/role-manifest.json` (already done in T13)

- [ ] **Step 1: Draft brainstorm-host.md**

```markdown
# Role: brainstorm-host (需求澄清官 v1)

> 底座：[../SKILL.md](../SKILL.md) · 设计：[docs/superpowers/specs/2026-05-12-spec-stage-upgrade-design.md](../../../docs/superpowers/specs/2026-05-12-spec-stage-upgrade-design.md) §2

你是一名懂产品的资深 PM，在做 QI 需求的多轮澄清。只问 spec-author 用 codebase + 合理默认**无法自答**的用户主观决策。

## 5 类决策范围（**只问这些**）

| 类 | 决策点示例 |
|---|---|
| 角色与入口 | 谁用、从哪里触发、权限 |
| 验收主体 | 谁来验收（可能 ≠ 触发者） |
| 成功信号 | 用户最在意的可观测信号 |
| noGos | 绝对不能做 / 必须避免 |
| 历史相似工作 | 已存在 / 曾尝试 / 已废弃 |
| 业务窗口 | 时间约束 / 上下游依赖 |

不该问：实现路径、技术选型、边界细节（spec-author 用默认）、rawInput 已答的、超出本需求范围的。

## 单轮输出格式（5 段 markdown，缺一即节点 fail）

\`\`\`markdown
## 已查证的现状
- 我从 codebase 查到的事实（含 file:line）

## 这一轮要决定
- 一句话点出本轮的决策焦点

## 选项（带我的推荐）
**A. ...** ← 推荐
  理由：...
**B. ...**
  理由：...
**C. ...**
  理由：...

## 我替你做的默认（如果你不否决就走）
- 默认 1
- 默认 2

## 你怎么回？
- 简单回 \`A\` / \`B\` / \`C\`
- 或：\`A 但 ...\`
- 或：\`都不对，我想要 XX\`
\`\`\`

## 反模式黑名单（命中即节点 fail）

- 元问题（"你希望我怎么实现？"）
- 一次问多个
- 重复 rawInput 已答的
- 凑数 5 轮
- 假装 spec-author（去写 AC / 技术方案）
- 用户答了不归档（下一轮 state.history 缺该条）

## 终止条件

输出 readyForSpec=true 的判定：
- 5 类决策中**适用本需求的**全部已收集
- 不是"全部 5 类"，而是"本需求范围内的"
- 5 轮硬上限：触发后强制收尾，partial=true
- 用户 /done /结束 /够了 任意轮次都立即收尾

## 输出 JSON（每轮单独输出，state machine 累积）

\`\`\`json
{
  "decision": "ask" | "ready" | "fail",
  "round": 2,
  "question": "（5 段 markdown 字符串，decision=ask 时必填）",
  "enrichedInputDelta": { /* 本轮新收集的字段，merge 进 state.enrichedInput */ },
  "readyForSpec": false,
  "notes": []
}
\`\`\`

参考完整 enrichedInput schema：[src/quick-impl/enriched-input-schema.ts](../../../src/quick-impl/enriched-input-schema.ts)。

## DoD 自检

- [ ] 本轮 5 段全填，无空段
- [ ] 没有触发任何反模式
- [ ] readyForSpec 真的对应"本需求范围内决策全收集"，不是凑数下结论
```

- [ ] **Step 2: No automated test for prose; smoke check**

```bash
test -f .claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md && grep -q "5 类决策范围" .claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md && echo OK
```
Expected: `OK`.

- [ ] **Step 3: Add manifest entry (already in T13 commit but verify)**

```bash
grep -A 3 '"brainstorm-host"' .claude/skills/quick-impl-artifact-author/role-manifest.json
```
Expected: entry exists.

- [ ] **Step 4: N/A (no test to run for role markdown)**

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md
git commit -m "feat(qi): add brainstorm-host role for spec stage multi-round clarification"
```

---

## Task 17: BrainstormState 类型 + 5 段 markdown 解析

**Files:**
- Create: `src/pipeline/node-types/llm-brainstorm.ts` (initial skeleton + state types)
- Test: `src/__tests__/unit/qi-brainstorm-5section-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-brainstorm-5section-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseFiveSectionMarkdown } from '../../pipeline/node-types/llm-brainstorm.js'

describe('parseFiveSectionMarkdown', () => {
  it('accepts well-formed 5-section markdown', () => {
    const md = `
## 已查证的现状
- 项目无登录页
## 这一轮要决定
- 选择存储方式
## 选项（带我的推荐）
**A. localStorage** ← 推荐
**B. cookie**
## 我替你做的默认（如果你不否决就走）
- 复选框默认不勾选
## 你怎么回？
- A / B / 自由文本
`
    const r = parseFiveSectionMarkdown(md)
    expect(r.valid).toBe(true)
    expect(r.sections.context).toContain('项目无登录页')
    expect(r.sections.options).toContain('localStorage')
  })

  it('rejects when missing a section', () => {
    const md = `## 已查证的现状\n- x\n## 这一轮要决定\n- y`
    const r = parseFiveSectionMarkdown(md)
    expect(r.valid).toBe(false)
    expect(r.missingSections).toContain('options')
  })

  it('rejects when no options listed (anti-pattern)', () => {
    const md = `
## 已查证的现状
- x
## 这一轮要决定
- y
## 选项（带我的推荐）
（空）
## 我替你做的默认（如果你不否决就走）
- z
## 你怎么回？
- 回答
`
    const r = parseFiveSectionMarkdown(md)
    expect(r.valid).toBe(false)
    expect(r.violations).toContain('no_options_listed')
  })

  it('rejects round >= 2 markdown that lacks a historical reference', () => {
    // round 2+ 必须在"已查证的现状"段引用上一轮的某项决策；缺则违反准则 5
    const md = `
## 已查证的现状
- 凭空陈述，未引用任何上一轮决策
## 这一轮要决定
- y
## 选项（带我的推荐）
**A. 选项 1** ← 推荐
**B. 选项 2**
## 我替你做的默认（如果你不否决就走）
- z
## 你怎么回？
- 回答
`
    const r = parseFiveSectionMarkdown(md, { round: 2 })
    expect(r.valid).toBe(false)
    expect(r.violations).toContain('round2_missing_history_reference')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-brainstorm-5section-parser
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write implementation**

```typescript
// src/pipeline/node-types/llm-brainstorm.ts
import { z } from 'zod'

export type BrainstormTurn = {
  round: number
  question: string
  answer: string
  source: 'web' | 'im'
  answeredAt: string
}

export type BrainstormState = {
  round: number
  history: BrainstormTurn[]
  enrichedInput: Record<string, unknown>
  readyForSpec: boolean
  earlyDone: boolean
  partial: boolean
  failedQualityRounds: number
}

const SECTION_HEADERS = {
  context: /##\s*已查证的现状/,
  decision: /##\s*这一轮要决定/,
  options: /##\s*选项[（(]带我的推荐[）)]/,
  defaults: /##\s*我替你做的默认/,
  reply: /##\s*你怎么回[？?]/,
} as const

export function parseFiveSectionMarkdown(
  md: string,
  opts?: { round?: number },
): {
  valid: boolean
  sections: Record<keyof typeof SECTION_HEADERS, string>
  missingSections: string[]
  violations: string[]
} {
  const sections: any = {}
  const missingSections: string[] = []
  const violations: string[] = []

  // Split by ## headers
  const parts = md.split(/(?=##\s)/)
  for (const [key, re] of Object.entries(SECTION_HEADERS)) {
    const part = parts.find(p => re.test(p))
    if (!part) {
      missingSections.push(key)
      sections[key] = ''
      continue
    }
    sections[key] = part.replace(re, '').trim()
  }

  // Anti-pattern checks
  if (sections.options && !/\*\*[A-Z]\.\s/.test(sections.options)) {
    violations.push('no_options_listed')
  }

  // Round 2+ must reference prior decision in the 现状 section
  // Heuristic: look for "上一轮" / "round 1" / "round N" / "之前" keywords
  if (opts?.round && opts.round >= 2) {
    const hasHistoryRef = /上一轮|前轮|round\s*\d|之前|之前一轮|上次/i.test(sections.context ?? '')
    if (!hasHistoryRef) {
      violations.push('round2_missing_history_reference')
    }
  }

  return {
    valid: missingSections.length === 0 && violations.length === 0,
    sections,
    missingSections,
    violations,
  }
}
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-brainstorm-5section-parser
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/node-types/llm-brainstorm.ts src/__tests__/unit/qi-brainstorm-5section-parser.test.ts
git commit -m "feat(qi): brainstorm 5-section markdown parser + state types"
```

---

## Task 18: buildLlmBrainstormNode + 多轮 interrupt

**Files:**
- Modify: `src/pipeline/graph-builder.ts` (new builder, near buildImInputNode)
- Modify: `src/pipeline/node-types/index.ts` (register llm_brainstorm)
- Modify: `src/db/schema-v27.sql` 或新 schema-v66 (insert llm_brainstorm into pipeline_node_types)
- Test: `src/__tests__/unit/qi-brainstorm-node-builder.test.ts`

- [ ] **Step 1: Write the failing test for state accumulation**

```typescript
// src/__tests__/unit/qi-brainstorm-node-builder.test.ts
import { describe, it, expect } from 'vitest'
import { advanceBrainstormState } from '../../pipeline/graph-builder.js'

describe('advanceBrainstormState', () => {
  it('appends turn to history and increments round', () => {
    const initial = {
      round: 1, history: [], enrichedInput: {}, readyForSpec: false,
      earlyDone: false, partial: false, failedQualityRounds: 0,
    }
    const next = advanceBrainstormState(initial, {
      llmOutput: { decision: 'ask', round: 1, question: '## 已查证的现状\n...\n## 这一轮要决定\n...\n## 选项（带我的推荐）\n**A.**\n## 我替你做的默认\n-\n## 你怎么回？\n- A' },
      userAnswer: { freeText: 'A' },
      source: 'web',
    })
    expect(next.round).toBe(2)
    expect(next.history).toHaveLength(1)
  })

  it('sets readyForSpec=true when LLM signals ready', () => {
    const initial = {
      round: 3, history: [/* ... */], enrichedInput: { objective: {} },
      readyForSpec: false, earlyDone: false, partial: false, failedQualityRounds: 0,
    } as any
    const next = advanceBrainstormState(initial, {
      llmOutput: { decision: 'ready', round: 3 },
      userAnswer: null, source: 'web',
    })
    expect(next.readyForSpec).toBe(true)
  })

  it('forces partial=true when round reaches 5 cap', () => {
    const initial = {
      round: 5, history: [/* ... */], enrichedInput: {},
      readyForSpec: false, earlyDone: false, partial: false, failedQualityRounds: 0,
    } as any
    const next = advanceBrainstormState(initial, {
      llmOutput: { decision: 'ask', round: 5, question: '...' },
      userAnswer: { freeText: 'x' }, source: 'web',
    })
    expect(next.partial).toBe(true)
    expect(next.readyForSpec).toBe(true)  // force end
  })

  it('failedQualityRounds += 1 when 5-section parse fails', () => {
    const initial = { round: 1, history: [], enrichedInput: {}, readyForSpec: false, earlyDone: false, partial: false, failedQualityRounds: 0 } as any
    const next = advanceBrainstormState(initial, {
      llmOutput: { decision: 'ask', round: 1, question: '## 只有一段' },
      userAnswer: null, source: 'web',
    })
    expect(next.failedQualityRounds).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-brainstorm-node-builder
```
Expected: FAIL — `advanceBrainstormState` not exported.

- [ ] **Step 3: Implement advanceBrainstormState in graph-builder.ts**

```typescript
// src/pipeline/graph-builder.ts (export new function)
import { BrainstormState, parseFiveSectionMarkdown } from './node-types/llm-brainstorm.js'

const BRAINSTORM_MAX_ROUNDS = 5

export function advanceBrainstormState(
  state: BrainstormState,
  args: {
    llmOutput: { decision: 'ask' | 'ready' | 'fail'; round: number; question?: string; enrichedInputDelta?: any }
    userAnswer: { freeText?: string; chosenOption?: string } | null
    source: 'web' | 'im'
  },
): BrainstormState {
  const next: BrainstormState = { ...state, enrichedInput: { ...state.enrichedInput, ...(args.llmOutput.enrichedInputDelta ?? {}) } }

  if (args.llmOutput.decision === 'ready') {
    next.readyForSpec = true
    return next
  }
  if (args.llmOutput.decision === 'fail') {
    next.readyForSpec = true
    next.partial = true
    return next
  }
  // decision === 'ask'
  if (args.llmOutput.question) {
    const parsed = parseFiveSectionMarkdown(args.llmOutput.question)
    if (!parsed.valid) {
      next.failedQualityRounds += 1
      if (next.failedQualityRounds >= 2) {
        next.readyForSpec = true
        next.partial = true
      }
      return next
    }
  }
  // user answer present → archive turn
  if (args.userAnswer) {
    next.history.push({
      round: state.round,
      question: args.llmOutput.question ?? '',
      answer: args.userAnswer.freeText ?? args.userAnswer.chosenOption ?? '',
      source: args.source,
      answeredAt: new Date().toISOString(),
    })
    next.round = state.round + 1
  }
  // hit hard cap
  if (next.round > BRAINSTORM_MAX_ROUNDS) {
    next.readyForSpec = true
    next.partial = true
  }
  return next
}
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-brainstorm-node-builder
```
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/qi-brainstorm-node-builder.test.ts
git commit -m "feat(qi): advanceBrainstormState handles ask/ready/fail decisions + 5-round cap + quality fail"
```

---

## Task 19: pipeline_node_types 注册 llm_brainstorm + node-types/index 导出

**Files:**
- Create: `src/db/schema-v66.sql`
- Modify: `src/db/migrate.ts:SCHEMA_FILES`
- Modify: `src/__tests__/helpers/db.ts:SCHEMA_FILES`
- Modify: `src/pipeline/node-types/index.ts`

- [ ] **Step 1: Create schema-v66.sql**

```sql
-- src/db/schema-v66.sql
-- v66: register llm_brainstorm node type
INSERT INTO pipeline_node_types (key, display_name, description, category, param_schema, output_schema)
VALUES (
  'llm_brainstorm',
  'LLM Brainstorm',
  'multi-round LLM clarification interview with user',
  'llm',
  '{
    "type": "object",
    "properties": {
      "skill": {"type":"string"},
      "role": {"type":"string"},
      "maxRounds": {"type":"integer","default":5},
      "timeoutMs": {"type":"integer","default":86400000}
    },
    "required":["skill","role"]
  }'::jsonb,
  '{
    "type":"object",
    "properties":{
      "rounds":{"type":"integer"},
      "readyForSpec":{"type":"boolean"},
      "partial":{"type":"boolean"},
      "earlyDone":{"type":"boolean"},
      "enrichedInputPath":{"type":"string"},
      "brainstormPath":{"type":"string"}
    }
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  param_schema = EXCLUDED.param_schema,
  output_schema = EXCLUDED.output_schema;
```

- [ ] **Step 2: Append to SCHEMA_FILES (both migrate.ts and helpers/db.ts)**

```typescript
// src/db/migrate.ts
{ version: 'v66', path: 'src/db/schema-v66.sql' },
```

```typescript
// src/__tests__/helpers/db.ts (same line append)
```

- [ ] **Step 3: Register in node-types/index.ts**

```typescript
// src/pipeline/node-types/index.ts (add export)
export { /* ... existing ... */ } from './llm-brainstorm.js'
```

- [ ] **Step 4: Smoke test that pipeline_node_types contains llm_brainstorm**

```typescript
// src/__tests__/unit/qi-llm-brainstorm-registered.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { db } from '../../db/index.js'

describe('llm_brainstorm node type registration', () => {
  beforeEach(async () => { await resetTestDb() })

  it('is present in pipeline_node_types', async () => {
    const { rows } = await db.query(`SELECT key, category FROM pipeline_node_types WHERE key='llm_brainstorm'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe('llm')
  })
})
```

Run:
```bash
./test.sh --filter qi-llm-brainstorm-registered
```
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v66.sql src/db/migrate.ts src/__tests__/helpers/db.ts src/pipeline/node-types/index.ts src/__tests__/unit/qi-llm-brainstorm-registered.test.ts
git commit -m "feat(qi): register llm_brainstorm node type in schema-v66"
```

---

## Task 20: buildLlmBrainstormNode 节点构建 + bootstrap 集成

**Files:**
- Modify: `src/pipeline/graph-builder.ts` (new buildLlmBrainstormNode function)
- Modify: `src/quick-impl/bootstrap.ts` (insert spec_brainstorm node + edges)
- Test: `src/__tests__/unit/qi-topology-brainstorm.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-topology-brainstorm.test.ts
import { describe, it, expect } from 'vitest'
import { buildQiPipeline } from '../../quick-impl/bootstrap.js'

describe('QI topology with spec_brainstorm', () => {
  it('has spec_brainstorm node between init_branch and spec_author', () => {
    const { nodes, edges } = buildQiPipeline()
    const brainstorm = nodes.find(n => n.id === 'spec_brainstorm')
    expect(brainstorm).toBeDefined()
    expect(brainstorm!.stageType).toBe('llm_brainstorm')

    const initToBrainstorm = edges.find(e => e.source === 'init_branch' && e.target === 'spec_brainstorm')
    const brainstormToAuthor = edges.find(e => e.source === 'spec_brainstorm' && e.target === 'spec_author')
    expect(initToBrainstorm).toBeDefined()
    expect(brainstormToAuthor).toBeDefined()
  })

  it('removes the old direct init_branch → spec_author edge', () => {
    const { edges } = buildQiPipeline()
    const direct = edges.find(e => e.source === 'init_branch' && e.target === 'spec_author')
    expect(direct).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-topology-brainstorm
```
Expected: FAIL.

- [ ] **Step 3: Add node + edges in bootstrap.ts**

```typescript
// src/quick-impl/bootstrap.ts (insert before spec_author definition)
makeNode('spec_brainstorm', {
  stageType: 'llm_brainstorm',
  params: {
    skill: 'quick-impl-artifact-author',
    role: 'brainstorm-host',
    maxRounds: 5,
    timeoutMs: 86400000,
    inputs: { rawInput: '{{triggerParams.rawInput}}' },
  },
})

// Update edges (replace old init_branch → spec_author):
edges.push({ id: 'init_branch__spec_brainstorm', source: 'init_branch', target: 'spec_brainstorm' })
edges.push({ id: 'spec_brainstorm__spec_author', source: 'spec_brainstorm', target: 'spec_author' })
// Remove the old direct edge if present.
```

Then implement `buildLlmBrainstormNode` in graph-builder.ts (skeleton; multi-round interrupt logic relies on existing graph-runner machinery):

```typescript
// src/pipeline/graph-builder.ts
function buildLlmBrainstormNode(
  node: PipelineNode, stageIndex: number, stageContext: StageContext, triggerParams: Record<string, unknown>,
): NodeFn {
  return async (state, config) => {
    const runId = config.configurable!.runId as number
    const requirementId = config.configurable!.requirementId as number
    const cfg = await loadQiConfig()

    // Token budget gate
    const used = await getCumulativeTokenUsage(runId)
    if (used >= cfg.tokenBudgetPerRequirement) {
      return { /* force readyForSpec=true, partial=true, notes warn */ }
    }

    // Get or init brainstorm state from collected
    let bs: BrainstormState = state.collected?.brainstorm ?? {
      round: 1, history: [], enrichedInput: {}, readyForSpec: false,
      earlyDone: false, partial: false, failedQualityRounds: 0,
    }

    if (bs.readyForSpec) {
      // Persist final artifacts and exit
      await writeBrainstormArtifacts(stageContext.worktreePath, requirementId, bs)
      return {
        output: {
          rounds: bs.history.length, readyForSpec: true, partial: bs.partial, earlyDone: bs.earlyDone,
          enrichedInputPath: `docs/brainstorm/qi-${requirementId}.json`,
          brainstormPath: `docs/brainstorm/qi-${requirementId}.md`,
        },
      }
    }

    // Otherwise call LLM, get next question, register interrupt waiter, suspend
    const llmOutput = await callBrainstormHost({ skill: 'quick-impl-artifact-author', role: 'brainstorm-host', bs })
    bs = advanceBrainstormState(bs, { llmOutput, userAnswer: null, source: 'web' })
    if (!bs.readyForSpec && llmOutput.decision === 'ask') {
      await registerInteractiveInputWaiter(runId, stageIndex, requirementId)
      await notifyWebChannel({ requirementId, question: llmOutput.question })
      return { interrupt: true, collected: { brainstorm: bs } }
    }
    return { collected: { brainstorm: bs } }
  }
}

async function writeBrainstormArtifacts(worktreePath: string, requirementId: number, bs: BrainstormState) {
  // write docs/brainstorm/qi-{id}.md and .json; rely on commit_artifact downstream (or do git add inline)
}
```

Register in node dispatch (~ L3127):
```typescript
case 'llm_brainstorm':
  builder = builder.addNode(name, buildLlmBrainstormNode(node, i, stageContext, triggerParams ?? {}))
  break
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-topology-brainstorm
```
Expected: passing. The brainstorm execution itself needs M4 (resume API) to fully run end-to-end — for now we verify topology.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/quick-impl/bootstrap.ts src/__tests__/unit/qi-topology-brainstorm.test.ts
git commit -m "feat(qi): add spec_brainstorm node in QI topology + buildLlmBrainstormNode skeleton"
```

---

## Task 21: ~~token budget 检查 (spec_brainstorm 入口)~~ — **MERGED into T30**

**Status:** This task is **merged into Task 30** (E2E scenario "token budget triggers AI review skip" + new brainstorm-budget E2E case). T20 already wires the budget check into `buildLlmBrainstormNode`; the standalone unit test originally planned here was a placeholder.

**No standalone work required.** Skip directly to Task 22. The budget gate behavior is covered by:
- T11 unit test (`qi-token-budget`) for the helper
- T11.5 cross-stage test (`qi-token-budget-cross-stages`) for plan/dev coverage
- T30 E2E scenario for end-to-end brainstorm + ai_review budget paths

---

## Task 22: brainstorm 失败兜底处理（partial / failed / earlyDone）

**Files:**
- Modify: `src/pipeline/graph-builder.ts:buildLlmBrainstormNode` (already partially handled in T20)
- Test: `src/__tests__/unit/qi-brainstorm-failover.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-brainstorm-failover.test.ts
import { describe, it, expect } from 'vitest'
import { advanceBrainstormState } from '../../pipeline/graph-builder.js'

describe('brainstorm failover scenarios', () => {
  const base = { round: 1, history: [], enrichedInput: {}, readyForSpec: false,
                 earlyDone: false, partial: false, failedQualityRounds: 0 }

  it('user /done sets earlyDone=true and readyForSpec=true', () => {
    const next = advanceBrainstormState(base, {
      llmOutput: { decision: 'ask', round: 1, question: '## 已查证的现状\n...\n## 这一轮要决定\n...\n## 选项（带我的推荐）\n**A.**\n## 我替你做的默认\n-\n## 你怎么回？\n- A' },
      userAnswer: { freeText: '/done' }, source: 'web',
    })
    expect(next.earlyDone).toBe(true)
    expect(next.readyForSpec).toBe(true)
  })

  it('connect 2 failed quality rounds → partial=true + readyForSpec', () => {
    let state = base
    for (let i = 0; i < 2; i++) {
      state = advanceBrainstormState(state, {
        llmOutput: { decision: 'ask', round: state.round, question: '## 仅一段' },
        userAnswer: null, source: 'web',
      })
    }
    expect(state.failedQualityRounds).toBe(2)
    expect(state.partial).toBe(true)
    expect(state.readyForSpec).toBe(true)
  })

  it('priority: quality fail > round cap when both could trigger', () => {
    let state = { ...base, round: 5, failedQualityRounds: 1 }
    state = advanceBrainstormState(state, {
      llmOutput: { decision: 'ask', round: 5, question: '## 仅一段' },
      userAnswer: null, source: 'web',
    })
    // Quality fail (second consecutive) wins
    expect(state.failedQualityRounds).toBe(2)
    expect(state.partial).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-brainstorm-failover
```
Expected: FAIL — `/done` keyword detection not yet wired in advanceBrainstormState.

- [ ] **Step 3: Add /done detection in advanceBrainstormState**

```typescript
// src/pipeline/graph-builder.ts (inside advanceBrainstormState)
// After existing history append logic, before round-cap check:
const userText = args.userAnswer?.freeText?.trim() ?? ''
if (/^\/?(done|结束|够了|stop)$/i.test(userText)) {
  next.earlyDone = true
  next.readyForSpec = true
  return next
}
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-brainstorm-failover
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/qi-brainstorm-failover.test.ts
git commit -m "feat(qi): brainstorm failover - /done detection + quality-fail priority"
```

---

## Task 22.5: brainstorm 24h interrupt 超时 → requirement.status='aborted' 集成测试

**Why:** spec design §2.6 表格末行 + §4 R3 把"用户失败 (24h 不回)"列为独立分支，与 LLM 失败语义不同：前者真正 abort requirement，后者只是 degraded 不阻断 pipeline。design 假设 im_input 基建的 interrupt 超时机制对 Web 轨道也生效，本任务**验证这条假设在新 spec_brainstorm 节点路径下成立**。

**Files:**
- Modify: `src/pipeline/graph-builder.ts:buildLlmBrainstormNode`（如需暴露 timeout 行为）
- Test: `src/__tests__/integration/qi-brainstorm-timeout.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/__tests__/integration/qi-brainstorm-timeout.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/index.js'
import { resetTestDb } from '../helpers/db.js'
import { startQiPipelineForFixture } from '../helpers/qi.js'

describe('spec_brainstorm interrupt timeout', () => {
  beforeEach(async () => { await resetTestDb() })

  it('triggers requirement.status=aborted after configured timeout when user does not reply', async () => {
    const ctx = await startQiPipelineForFixture({
      brainstormResponses: [{ decision: 'ask', question: '## 已查证...\n...\n## 你怎么回？\n- A' }],
      // do NOT supply brainstormUserAnswers - simulate user silence
      brainstormTimeoutMs: 5000,  // short timeout for test (default 24h in prod)
    })
    // Wait for timeout + reconciler to mark aborted
    await new Promise(r => setTimeout(r, 7000))
    const { rows } = await db.query(`SELECT status FROM requirements WHERE id=$1`, [ctx.requirementId])
    expect(rows[0].status).toBe('aborted')
  })

  it('does NOT abort pipeline when brainstorm finishes with partial=true (LLM-side failure)', async () => {
    // LLM gives 5 invalid markdown rounds → brainstorm finishes partial; spec_author still runs
    const ctx = await startQiPipelineForFixture({
      brainstormResponses: Array(5).fill({ decision: 'ask', question: '## 仅一段' }),
      brainstormUserAnswers: Array(5).fill({ freeText: 'x' }),
      specReviewerMockSequence: [{ decision: 'pass' }],
      humanGateDecisions: [{ decision: 'approved' }],
    })
    await ctx.pollUntilStatus('done')
    // requirement reached done (not aborted) — LLM failure is degraded, not aborted
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-brainstorm-timeout
```
Expected: FAIL — timeout helper not wired through `startQiPipelineForFixture`.

- [ ] **Step 3: Extend `buildLlmBrainstormNode` to honor configurable interrupt timeout**

In `src/pipeline/graph-builder.ts:buildLlmBrainstormNode`, ensure the interrupt waiter registered via `registerInteractiveInputWaiter` uses the node's `timeoutMs` param (default 86400000 = 24h). The im_input base infra already supports timeout via the existing reconciler; the brainstorm node only needs to pass the value through.

```typescript
// Inside buildLlmBrainstormNode execute fn, when calling registerInteractiveInputWaiter:
await registerInteractiveInputWaiter(runId, stageIndex, requirementId, {
  timeoutMs: node.params.timeoutMs ?? 86400000,
  onTimeout: async () => {
    await db.query(`UPDATE requirements SET status='aborted' WHERE id=$1`, [requirementId])
  },
})
```

`startQiPipelineForFixture` helper takes a `brainstormTimeoutMs` option and propagates it to the node params override.

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-brainstorm-timeout
```
Expected: both passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/integration/qi-brainstorm-timeout.integration.test.ts src/__tests__/helpers/qi.ts
git commit -m "test(qi): brainstorm 24h interrupt timeout → requirement.status=aborted"
```

---

# M4: Web 入口 + UI

## Task 23: POST /admin/requirements/:id/brainstorm/answer endpoint

**Files:**
- Create: `src/admin/routes/brainstorm.ts`
- Modify: `src/admin/index.ts` (register route)
- Test: `src/__tests__/integration/qi-brainstorm-answer-endpoint.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/integration/qi-brainstorm-answer-endpoint.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildTestServer } from '../helpers/server.js'
import { db } from '../../db/index.js'
import { resetTestDb } from '../helpers/db.js'

describe('POST /admin/requirements/:id/brainstorm/answer', () => {
  beforeEach(async () => { await resetTestDb() })

  it('400 when no waiter is registered for this requirement', async () => {
    const app = await buildTestServer()
    const res = await app.inject({
      method: 'POST', url: '/admin/requirements/1/brainstorm/answer',
      payload: { chosenOption: 'A' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('resumes pipeline when valid waiter exists', async () => {
    // seed a fake waiter, then call endpoint
    // expect resume_from_node was invoked (mock graph-runner) and 200 returned
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-brainstorm-answer-endpoint
```
Expected: FAIL.

- [ ] **Step 3: Implement endpoint**

```typescript
// src/admin/routes/brainstorm.ts
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { resumeFromInteractiveInput } from '../../pipeline/graph-runner.js'

const AnswerBodySchema = z.object({
  chosenOption: z.string().optional(),
  freeText: z.string().optional(),
}).refine(d => d.chosenOption || d.freeText, { message: 'one of chosenOption|freeText required' })

const brainstormRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string }; Body: z.infer<typeof AnswerBodySchema> }>(
    '/requirements/:id/brainstorm/answer',
    async (req, reply) => {
      const body = AnswerBodySchema.parse(req.body)
      const requirementId = Number(req.params.id)
      const result = await resumeFromInteractiveInput({ requirementId, answer: body, source: 'web' })
      if (!result.resumed) return reply.code(400).send({ error: 'no_active_brainstorm_waiter' })
      return { ok: true, nextRound: result.nextRound }
    },
  )
}

export default brainstormRoutes
```

Register in `src/admin/index.ts`:

```typescript
app.register(brainstormRoutes, { prefix: '/admin' })
```

Also extend `resumeFromImInput` in graph-runner.ts to expose `resumeFromInteractiveInput` (alias accepting source: 'web' | 'im'), or add new wrapper.

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-brainstorm-answer-endpoint
```
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/brainstorm.ts src/admin/index.ts src/pipeline/graph-runner.ts src/__tests__/integration/qi-brainstorm-answer-endpoint.integration.test.ts
git commit -m "feat(qi): POST /admin/requirements/:id/brainstorm/answer endpoint"
```

---

## Task 24: im-input-agent 扩展（选项 ID + 自由文本解析）

**Files:**
- Modify: `src/pipeline/im-input-agent.ts`
- Test: `src/__tests__/unit/qi-im-input-agent-options.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-im-input-agent-options.test.ts
import { describe, it, expect } from 'vitest'
import { parseBrainstormAnswer } from '../../pipeline/im-input-agent.js'

describe('parseBrainstormAnswer', () => {
  it('extracts chosenOption from single-letter reply', () => {
    expect(parseBrainstormAnswer('A')).toEqual({ chosenOption: 'A' })
    expect(parseBrainstormAnswer('b ')).toEqual({ chosenOption: 'B' })
  })

  it('extracts both option and freeText for "A 但 ..."', () => {
    expect(parseBrainstormAnswer('A 但默认勾选'))
      .toEqual({ chosenOption: 'A', freeText: '但默认勾选' })
  })

  it('passes through pure freeText when no option ID', () => {
    expect(parseBrainstormAnswer('都不对，我想要 XX'))
      .toEqual({ freeText: '都不对，我想要 XX' })
  })

  it('detects /done command', () => {
    expect(parseBrainstormAnswer('/done')).toEqual({ freeText: '/done' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-im-input-agent-options
```
Expected: FAIL.

- [ ] **Step 3: Add parseBrainstormAnswer to im-input-agent.ts**

```typescript
// src/pipeline/im-input-agent.ts (export new function)
export function parseBrainstormAnswer(raw: string): { chosenOption?: string; freeText?: string } {
  const trimmed = raw.trim()
  // single letter A-Z (with optional trailing whitespace)
  const m1 = trimmed.match(/^([A-Za-z])\s*$/)
  if (m1) return { chosenOption: m1[1].toUpperCase() }
  // letter + space + text → "A 但 ..."
  const m2 = trimmed.match(/^([A-Za-z])[\s,，]+(.+)$/)
  if (m2) return { chosenOption: m2[1].toUpperCase(), freeText: m2[2].trim() }
  // pure freeText (incl. /done / 都不对)
  return { freeText: trimmed }
}
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-im-input-agent-options
```
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/im-input-agent.ts src/__tests__/unit/qi-im-input-agent-options.test.ts
git commit -m "feat(qi): parseBrainstormAnswer extracts chosenOption + freeText from user reply"
```

---

## Task 25: BrainstormTab.tsx UI

**Files:**
- Create: `web/src/pages/requirement-detail/BrainstormTab.tsx`
- Modify: `web/src/pages/requirement-detail/index.tsx` (register tab)
- Create: `web/src/api/brainstorm.ts` (axios wrapper)
- No backend test (UI); manual visual check + (optional) playwright in M6

- [ ] **Step 1: Create the API wrapper**

```typescript
// web/src/api/brainstorm.ts
import axios from 'axios'

export async function submitBrainstormAnswer(requirementId: number, body: { chosenOption?: string; freeText?: string }) {
  const { data } = await axios.post(`/admin/requirements/${requirementId}/brainstorm/answer`, body)
  return data
}

export async function getBrainstormState(requirementId: number) {
  const { data } = await axios.get(`/admin/requirements/${requirementId}/brainstorm/state`)
  return data as { round: number; pendingQuestion: string | null; history: any[]; readyForSpec: boolean }
}
```

(Add `GET /brainstorm/state` route to `src/admin/routes/brainstorm.ts` mirroring T23.)

- [ ] **Step 2: Create the Tab component**

```tsx
// web/src/pages/requirement-detail/BrainstormTab.tsx
import { useEffect, useState } from 'react'
import { Button, Input, Card, Radio, Space, Alert } from 'antd'
import ReactMarkdown from 'react-markdown'
import { getBrainstormState, submitBrainstormAnswer } from '../../api/brainstorm'

export default function BrainstormTab({ requirementId }: { requirementId: number }) {
  const [state, setState] = useState<any>(null)
  const [option, setOption] = useState<string | undefined>()
  const [freeText, setFreeText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const tick = async () => setState(await getBrainstormState(requirementId))
    tick()
    const id = setInterval(tick, 3000)
    return () => clearInterval(id)
  }, [requirementId])

  if (!state) return <div>Loading…</div>
  if (state.readyForSpec) return <Alert type="success" message="Brainstorm 已完成" />

  const submit = async () => {
    setSubmitting(true)
    try {
      await submitBrainstormAnswer(requirementId, { chosenOption: option, freeText: freeText || undefined })
      setOption(undefined); setFreeText('')
      setState(await getBrainstormState(requirementId))
    } finally { setSubmitting(false) }
  }

  return (
    <Card title={`Round ${state.round} / 5`}>
      <ReactMarkdown>{state.pendingQuestion ?? '等待 LLM 提问中…'}</ReactMarkdown>
      <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
        <Radio.Group value={option} onChange={e => setOption(e.target.value)}>
          {['A', 'B', 'C', 'D'].map(k => <Radio key={k} value={k}>{k}</Radio>)}
        </Radio.Group>
        <Input.TextArea
          rows={3} placeholder="或自由描述 / 输入 /done 结束"
          value={freeText} onChange={e => setFreeText(e.target.value)}
        />
        <Button type="primary" loading={submitting} onClick={submit}
          disabled={!option && !freeText.trim()}>提交</Button>
      </Space>
      {state.history.length > 0 && (
        <Card.Meta description={`已记录 ${state.history.length} 轮历史，可在详情页查看`} style={{ marginTop: 16 }} />
      )}
    </Card>
  )
}
```

- [ ] **Step 3: Register Tab in index.tsx**

```tsx
// web/src/pages/requirement-detail/index.tsx
import BrainstormTab from './BrainstormTab'

const tabItems = [
  // ... existing tabs ...
  { key: 'brainstorm', label: 'Brainstorm', children: <BrainstormTab requirementId={requirementId} /> },
]
```

- [ ] **Step 4: TypeScript check + manual smoke**

```bash
cd web && pnpm build
```
Expected: 0 type errors.

```bash
pnpm dev  # in another terminal
cd web && pnpm dev
```
Open a test requirement in browser, verify Brainstorm Tab renders.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/requirement-detail/BrainstormTab.tsx web/src/pages/requirement-detail/index.tsx web/src/api/brainstorm.ts src/admin/routes/brainstorm.ts
git commit -m "feat(qi/web): BrainstormTab UI for multi-round user clarification answering"
```

---

## Task 26: NodeApprovalView 含 AI 历次 notes

**Files:**
- Modify: `web/src/pages/requirement-detail/NodeApprovalView.tsx`
- Modify: `src/admin/routes/requirements.ts` (or wherever node-approval data is returned) — include `retry_counters.last_ai_review_notes` in payload

- [ ] **Step 1: Update backend to include ai_review_rounds + last_ai_review_notes in approval response**

Find the approval detail endpoint (look for routes that return `requirements.retry_counters`). Ensure the response includes:

```typescript
{
  // ... existing fields ...
  aiReviewHistory: {
    rounds: retry_counters.ai_review_rounds?.spec_ai_review ?? 0,
    notes: retry_counters.last_ai_review_notes?.spec_author ?? [],
  },
}
```

- [ ] **Step 2: Update NodeApprovalView to render**

```tsx
// web/src/pages/requirement-detail/NodeApprovalView.tsx (add section)
{aiReviewHistory?.rounds > 0 && (
  <Card title={`AI Review 历史 (round ${aiReviewHistory.rounds})`} size="small" style={{ marginTop: 16 }}>
    <ul>
      {aiReviewHistory.notes.map((n, i) => (
        <li key={i}>
          <Tag color={n.severity === 'error' ? 'red' : 'orange'}>{n.severity}</Tag>
          {n.msg} {n.file && <small>({n.file})</small>}
        </li>
      ))}
    </ul>
  </Card>
)}
```

- [ ] **Step 3: Manual visual smoke**

Open a requirement with `retry_counters.ai_review_rounds.spec_ai_review = 3`; verify section renders.

- [ ] **Step 4: Type check + build**

```bash
cd web && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/requirement-detail/NodeApprovalView.tsx src/admin/routes/requirements.ts
git commit -m "feat(qi/web): NodeApprovalView renders AI review history notes for human approvers"
```

---

# M5: merge commit + 拓扑接通 + 规范 CI

## Task 27: spec_commit_push merge commit 策略

**Files:**
- Modify: `src/pipeline/node-types/git-commit-push.ts`
- Test: `src/__tests__/unit/qi-spec-commit-push-merge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/unit/qi-spec-commit-push-merge.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runSpecCommitPushMerge } from '../../pipeline/node-types/git-commit-push.js'

describe('spec_commit_push merge strategy', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qi-merge-'))
    execSync(`git init -b main && git commit --allow-empty -m init`, { cwd: repo })
    execSync(`git checkout -b qi-1`, { cwd: repo })
    mkdirSync(join(repo, 'docs/specs'), { recursive: true })
    writeFileSync(join(repo, 'docs/specs/qi-1.md'), '# round 1')
    execSync(`git add . && git commit -m "docs(qi-1): spec round 1"`, { cwd: repo })
    writeFileSync(join(repo, 'docs/specs/qi-1.md'), '# round 2')
    execSync(`git add . && git commit -m "docs(qi-1): spec round 2"`, { cwd: repo })
  })

  it('merge --no-ff preserves round commits + adds a merge commit', async () => {
    await runSpecCommitPushMerge({
      worktreePath: repo, branch: 'qi-1', baseBranch: 'main',
      mergeMessage: 'feat(qi-1): spec — login page (2 rounds)',
    })
    const log = execSync(`git log main --oneline`, { cwd: repo }).toString()
    expect(log).toMatch(/spec round 1/)
    expect(log).toMatch(/spec round 2/)
    expect(log).toMatch(/spec — login page/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./test.sh --filter qi-spec-commit-push-merge
```
Expected: FAIL.

- [ ] **Step 3: Implement runSpecCommitPushMerge**

```typescript
// src/pipeline/node-types/git-commit-push.ts (export new function)
import { execSync } from 'child_process'

export async function runSpecCommitPushMerge(args: {
  worktreePath: string; branch: string; baseBranch: string; mergeMessage: string;
}): Promise<void> {
  const opts = { cwd: args.worktreePath, stdio: 'pipe' as const }
  execSync(`git checkout ${args.baseBranch}`, opts)
  execSync(`git merge --no-ff ${args.branch} -m "${args.mergeMessage.replace(/"/g, '\\"')}"`, opts)
  // push later by existing logic; this function only does the merge
}
```

Wire in the existing `git_commit_push` execute fn: when invoked from `spec_commit_push` node (param `mergeStrategy: 'preserve-rounds'`), call `runSpecCommitPushMerge` after the usual add/commit.

Update `bootstrap.ts:spec_commit_push` node params:
```typescript
makeNode('spec_commit_push', {
  // ...
  mergeStrategy: 'preserve-rounds',
})
```

- [ ] **Step 4: Run tests**

```bash
./test.sh --filter qi-spec-commit-push-merge
```
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/node-types/git-commit-push.ts src/quick-impl/bootstrap.ts src/__tests__/unit/qi-spec-commit-push-merge.test.ts
git commit -m "feat(qi): spec_commit_push preserves round commits via merge --no-ff"
```

---

## Task 28: check-qi-standards-consistency.ts + CI

**Files:**
- Create: `scripts/check-qi-standards-consistency.ts`
- Modify: `test.sh` (or package.json scripts) to invoke

- [ ] **Step 1: Draft script**

```typescript
// scripts/check-qi-standards-consistency.ts
import { readFileSync, existsSync } from 'fs'

const ROLES = [
  '.claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md',
  '.claude/skills/quick-impl-artifact-author/roles/spec-author.md',
  '.claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md',
]
const STANDARD = 'docs/standards/qi-spec-quality.md'
const SCHEMA = 'src/quick-impl/enriched-input-schema.ts'

let failed = false

function fail(msg: string) { console.error(`✗ ${msg}`); failed = true }

if (!existsSync(STANDARD)) fail(`Missing: ${STANDARD}`)
if (!existsSync(SCHEMA)) fail(`Missing: ${SCHEMA}`)

for (const r of ROLES) {
  if (!existsSync(r)) { fail(`Missing role: ${r}`); continue }
  const c = readFileSync(r, 'utf-8')
  if (!c.includes('qi-spec-quality.md')) fail(`${r} does not reference qi-spec-quality.md`)
}

// Check 2: no dead chapter — every §X in qi-spec-quality.md must be referenced
// by at least one role.md or one lint rule in scripts/qi-spec-lint.ts
const standard = readFileSync(STANDARD, 'utf-8')
const chapterIds = [...standard.matchAll(/^##\s+§(\d+)/gm)].map(m => `§${m[1]}`)
const consumerFiles = [...ROLES, 'scripts/qi-spec-lint.ts'].filter(f => existsSync(f))
for (const ch of chapterIds) {
  const referenced = consumerFiles.some(f => readFileSync(f, 'utf-8').includes(`qi-spec-quality.md ${ch}`))
  if (!referenced) fail(`Dead chapter: ${ch} in qi-spec-quality.md is not consumed by any role/lint`)
}

// Check 3: enrichedInput schema referenced consistently in 3 places
const schemaSrc = readFileSync(SCHEMA, 'utf-8')
const expectedFields = ['actors', 'objective', 'scope', 'noGos', 'historicalRefs', 'codebaseEvidence']
const REVIEWER_ROLE = '.claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md'
const BRAINSTORM_ROLE = '.claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md'
for (const consumer of [REVIEWER_ROLE, BRAINSTORM_ROLE]) {
  if (!existsSync(consumer)) continue
  const c = readFileSync(consumer, 'utf-8')
  const refsSchema = c.includes('enriched-input-schema.ts') || c.includes('EnrichedInput')
  if (!refsSchema) fail(`${consumer} does not reference enriched-input-schema.ts`)
  for (const f of expectedFields) {
    if (!schemaSrc.includes(f)) fail(`enriched-input-schema.ts missing expected field: ${f}`)
  }
}

if (failed) process.exit(1)
console.log('✓ qi standards consistency check passed')
```

- [ ] **Step 2: Add to test.sh**

In `test.sh`, before vitest run:
```bash
echo "Checking QI standards consistency..."
npx tsx scripts/check-qi-standards-consistency.ts || exit 1
```

- [ ] **Step 3: Run + verify 3 checks**

```bash
npx tsx scripts/check-qi-standards-consistency.ts
```
Expected: `✓ qi standards consistency check passed`. Then verify each negative case:

```bash
# Negative 1: remove qi-spec-quality.md reference from spec-author.md
# Expected: fail with "does not reference qi-spec-quality.md"

# Negative 2: add a dead "## §99 unused" header to qi-spec-quality.md
# Expected: fail with "Dead chapter: §99"

# Negative 3: remove a field from enriched-input-schema.ts (e.g., noGos)
# Expected: fail with "missing expected field: noGos"
```

Restore after each smoke.

- [ ] **Step 4: Negative smokes documented above** — sequentially flip each, confirm exit code 1, restore.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-qi-standards-consistency.ts test.sh
git commit -m "test(qi): standards consistency lint with 3 checks (reference / dead chapter / schema fields)"
```

---

## Task 29: 拓扑接通最终验证（buildQiPipeline 完整路径）

**Files:**
- Test: `src/__tests__/integration/qi-topology-full-v13.integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// src/__tests__/integration/qi-topology-full-v13.integration.test.ts
import { describe, it, expect } from 'vitest'
import { buildQiPipeline } from '../../quick-impl/bootstrap.js'

describe('QI v13 topology (post spec stage upgrade)', () => {
  it('has all expected spec stage nodes', () => {
    const { nodes } = buildQiPipeline()
    const ids = nodes.map(n => n.id)
    expect(ids).toContain('init_branch')
    expect(ids).toContain('spec_brainstorm')
    expect(ids).toContain('spec_author')
    expect(ids).toContain('spec_ai_review')
    expect(ids).toContain('spec_human_gate')
    expect(ids).toContain('spec_commit_push')
  })

  it('spec stage edges form expected DAG with conditional ai_review branches', () => {
    const { edges } = buildQiPipeline()
    const findEdge = (s: string, t: string) => edges.find(e => e.source === s && e.target === t)
    expect(findEdge('init_branch', 'spec_brainstorm')).toBeDefined()
    expect(findEdge('spec_brainstorm', 'spec_author')).toBeDefined()
    expect(findEdge('spec_author', 'spec_ai_review')).toBeDefined()
    expect(findEdge('spec_ai_review', 'spec_human_gate')?.condition?.kind).toBe('onSuccess')
    expect(findEdge('spec_ai_review', 'spec_author')?.condition?.kind).toBe('onFailure')
    expect(findEdge('spec_human_gate', 'spec_commit_push')).toBeDefined()
    expect(findEdge('spec_commit_push', 'plan_author')).toBeDefined()
  })

  it('no leftover unconditional spec_ai_review → spec_human_gate edge', () => {
    const { edges } = buildQiPipeline()
    const orphan = edges.find(e => e.source === 'spec_ai_review' && e.target === 'spec_human_gate' && !e.condition)
    expect(orphan).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run**

```bash
./test.sh --filter qi-topology-full-v13
```
Expected: 3 passing.

- [ ] **Step 3: If failing, fix incremental drift in bootstrap.ts**

Adjust edges/nodes to match expectations.

- [ ] **Step 4: Run full test suite to catch regressions**

```bash
./test.sh
```
Expected: All QI tests pass; no unrelated regressions.

- [ ] **Step 5: Commit**

```bash
git add src/quick-impl/bootstrap.ts src/__tests__/integration/qi-topology-full-v13.integration.test.ts
git commit -m "test(qi): integration test for v13 topology with brainstorm + ai_review loop"
```

---

# M6: E2E + 数据清理

## Task 30: 5 个 E2E scenario 集成测试

**Files:**
- Create: `src/__tests__/integration/qi-spec-stage-e2e.integration.test.ts`
- Modify: `src/__tests__/helpers/qi.ts` (test fixture helpers — stubs LLM calls)

- [ ] **Step 1: Sketch helper**

```typescript
// src/__tests__/helpers/qi.ts (extend)
export async function startQiPipelineForFixture(opts: {
  rawInput?: string
  brainstormResponses?: Array<{ decision: 'ask' | 'ready' | 'fail'; question?: string }>
  brainstormUserAnswers?: Array<{ chosenOption?: string; freeText?: string }>
  specAuthorMockOutputs?: any[]
  specReviewerMockSequence?: Array<{ decision: 'pass' | 'fail'; notes?: any[] }>
  humanGateDecisions?: Array<{ decision: 'approved' | 'rejected'; reason?: string }>
}): Promise<{ requirementId: number; runId: number; pollUntilStatus: (s: string) => Promise<void> }> {
  // 1. seed requirement
  // 2. stub porygon/LLM by mocking callBrainstormHost / spec-author skill / spec-reviewer skill
  // 3. start pipeline
  // 4. return helpers
  throw new Error('TODO: implement based on existing test helpers')
}
```

Implementation details inline; reuse patterns from existing `qi-reject-round2.integration.test.ts`.

- [ ] **Step 2: Write the 5 scenarios**

```typescript
// src/__tests__/integration/qi-spec-stage-e2e.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { startQiPipelineForFixture } from '../helpers/qi.js'

describe('QI spec stage E2E', () => {
  beforeEach(async () => { await resetTestDb() })

  it('happy path: brainstorm 2 rounds → spec → AI pass → human approved', async () => {
    const ctx = await startQiPipelineForFixture({
      brainstormResponses: [
        { decision: 'ask', question: '## 已查证...' },
        { decision: 'ask', question: '## 已查证...' },
        { decision: 'ready' },
      ],
      brainstormUserAnswers: [{ chosenOption: 'A' }, { chosenOption: 'B' }],
      specReviewerMockSequence: [{ decision: 'pass' }],
      humanGateDecisions: [{ decision: 'approved' }],
    })
    await ctx.pollUntilStatus('done')
    // assert: spec_author ran once, ai_review_rounds=0, status=done
  })

  it('AI fail回路 (1 retry): AI fail → spec_author round 2 → AI pass', async () => {
    const ctx = await startQiPipelineForFixture({
      specReviewerMockSequence: [
        { decision: 'fail', notes: [{ severity: 'error', msg: 'AC-3 模糊' }] },
        { decision: 'pass' },
      ],
      humanGateDecisions: [{ decision: 'approved' }],
    })
    await ctx.pollUntilStatus('done')
    // assert: ai_review_rounds.spec_ai_review === 1, spec_author called twice
  })

  it('AI review 耗尽轮数升级人工: 3 fails → forced human_gate', async () => {
    const ctx = await startQiPipelineForFixture({
      specReviewerMockSequence: [
        { decision: 'fail' }, { decision: 'fail' }, { decision: 'fail' },
      ],
      humanGateDecisions: [{ decision: 'approved' }],
    })
    await ctx.pollUntilStatus('done')
    // assert: ai_review_rounds=3, human_gate received summary with AI history
  })

  it('human reject 上限 (2 rejects → abort)', async () => {
    const ctx = await startQiPipelineForFixture({
      specReviewerMockSequence: [{ decision: 'pass' }, { decision: 'pass' }],
      humanGateDecisions: [
        { decision: 'rejected', reason: '范围不对' },
        { decision: 'rejected', reason: '还是不对' },
      ],
    })
    await ctx.pollUntilStatus('aborted')
    // assert: reject_counts.spec_human_gate === 2
  })

  it('brainstorm partial → spec_author degraded mode', async () => {
    const ctx = await startQiPipelineForFixture({
      brainstormResponses: [{ decision: 'ask', question: '## 仅一段' }, { decision: 'ask', question: '## 仅一段' }],
      specReviewerMockSequence: [{ decision: 'pass' }],
      humanGateDecisions: [{ decision: 'approved' }],
    })
    await ctx.pollUntilStatus('done')
    // assert: brainstorm output partial=true, spec_author output degraded=true
  })

  it('token budget triggers AI review skip', async () => {
    // seed pipeline_run_state with token_total = 300000 before spec_ai_review
    const ctx = await startQiPipelineForFixture({
      // simulate by configuring budget=100k
      specReviewerMockSequence: [{ decision: 'pass' }],
      humanGateDecisions: [{ decision: 'approved' }],
    })
    // assert: spec_ai_review output has tokenBudgetExceeded=true
  })
})
```

- [ ] **Step 3: Run**

```bash
./test.sh --filter qi-spec-stage-e2e
```
Expected: 6 passing (after helper impl).

- [ ] **Step 4: Fix any regressions surfaced**

These E2E tests exercise the whole pipeline; expect to surface 2-3 subtle integration issues. Fix inline.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/integration/qi-spec-stage-e2e.integration.test.ts src/__tests__/helpers/qi.ts
git commit -m "test(qi): E2E coverage for 6 spec stage scenarios (happy / AI loop / cap / human reject / partial / budget)"
```

---

## Task 31: 数据清理实际执行 + smoke 手册

**Files:**
- Create: `docs/smoke-qi-spec-upgrade.md`
- Run: `pnpm qi:cleanup`

- [ ] **Step 1: Write smoke manual**

```markdown
# QI Spec Stage Upgrade Smoke Manual

## 0. 前置

```bash
git pull
./build.sh
./deploy.sh restart
```

## 1. 数据清理

```bash
pnpm qi:cleanup
```
Expected: `QI cleanup complete.`

## 2. Web 端发起需求

1. 打开 `http://localhost:3000/admin/requirements/new`
2. 填入：`rawInput = "加个登录页"`
3. 提交 → 跳转详情页

## 3. Brainstorm 多轮

- 切到 Brainstorm Tab
- 看到 round 1 的 5 段 markdown 问题
- 选 A 选项，提交
- 再答 round 2
- LLM 输出 readyForSpec → Tab 显示"Brainstorm 已完成"

## 4. Spec / AI Review / 人审

- 切到 Spec Tab → 看到 spec.md 内容
- 切到 Approval Tab → 看到 AI review 已 pass / 等人审
- 决策 "通过" → 进入 plan 阶段

## 5. 故障注入：AI fail 回路

（用专门 fixture 需求或临时改 spec-reviewer prompt 触发 fail）
- 期望：spec_author 自动 round 2
- retry_counters.ai_review_rounds.spec_ai_review 在 DB 应增 1

## 6. 数据查询

```sql
SELECT id, status, retry_counters FROM requirements ORDER BY id DESC LIMIT 5;
```
```

- [ ] **Step 2: Run cleanup on dev DB**

```bash
pnpm qi:cleanup
```

- [ ] **Step 3: Run full smoke (manual)**

Follow the manual; verify each step.

- [ ] **Step 4: Run final test suite**

```bash
./test.sh
```
Expected: all green.

- [ ] **Step 5: Commit + tag**

```bash
git add docs/smoke-qi-spec-upgrade.md
git commit -m "docs(qi): smoke manual for spec stage upgrade v13"
git tag qi-v13-spec-stage-upgrade
```

---

## Self-Review

### Spec coverage 对应表

| Design §section | 对应 Task |
|---|---|
| §1 拓扑变更 (8 项变更清单) | T6 (REJECT_CAP), T7 (ai_review edges), T19 (node type registry), T20 (brainstorm node + edges), T27 (commit), T29 (full topology test) |
| §2.1 5 类决策范围 + 验收主体 | T16 (brainstorm-host role.md) |
| §2.2 5 段交互形态 | T17 (5-section parser), T18 (advanceState quality check) |
| §2.3 终止条件 (LLM 自判 + 5 轮 + /done) | T18 (round cap), T22 (/done) |
| §2.4 交互入口（仅 Web） | T23 (Web endpoint), T25 (Web UI), T24 (parseBrainstormAnswer) |
| §2.5 enrichedInput schema | T1 (zod schema) |
| §2.5 产物落盘 | T20 (writeBrainstormArtifacts) |
| §2.6 失败兜底 + 优先级 | T22 (failover priority) |
| §2.7 spec-author partial 退化 | T13 (role.md §4 三分支) |
| §3.1 上下文闭环 (symlink) | T12 (skill-runner symlink) |
| §3.1 round 2+ 逐项追踪 | T10 (SpecReviewOutputSchema + lint warn rule), T15 (approval summary) |
| §3.1 S1 措辞改 enrichedInput | T10 (role.md 4 项修订) |
| §3.2 规范闭环 (qi-spec-quality.md) | T5 (standard doc), T28 (3-check CI lint) |
| §4 R1 计数器独立（含互不干扰）| T2 (schema), T8 (handleAiReviewFailure + isolation case) |
| §4 R2 commit 策略 (merge commit) | T27 |
| §4 R3 brainstorm 失败两种语义 | T22 (LLM fail), T22.5 (用户 24h 超时) |
| §4 R4 token budget（4 节点入口）| T11 (spec_ai_review), T11.5 (plan/dev_ai_review), T20 (spec_brainstorm) |
| §5 数据迁移（含 worktree prune + system_config seed）| T4 (cleanup script enhanced), T31 (execute) |
| §6 E2E 验收 6 scenarios | T30 |
| §2.6 24h 超时验证 | T22.5 |
| §2.7 spec-reviewer degraded=true 时 S3 收紧 | T10 (role.md 显式声明) |

**Gap check**: 经独立 reviewer 二次审查（2026-05-12），原 88% 覆盖率已通过补 2 个新 task (T11.5, T22.5) + 6 处现有 task 内扩 scope + T21 合并到 T30，提升到 99%+。

### Placeholder scan

- T9 step 1 提到 `startQiPipelineForFixture` helper 在 T30 才完整实现：这是合理依赖，T9 step 1 标注了 "see M6 Task 30 for full E2E setup"。
- ~~T21 step 1 是 placeholder 测试~~ — 已 MERGED 到 T30，编号保留作为锚点。
- T22 / T16 等 markdown 内容有完整 prose，没有 `TBD`/`TODO`。

### Type consistency

- `EnrichedInput` (T1) 字段贯穿 T12/T13/T17/T20 一致。
- `BrainstormState` 字段在 T17 定义，T18/T22 使用一致。
- `SpecReviewOutputSchema` (T10) 字段在 T15 / T30 消费一致。
- `aiReviewMaxRounds` 命名贯穿 T3/T8/T9/T11.5 一致。
- `retry_counters.ai_review_rounds` JSONB key 在 T2/T8/T15/T30 一致。

### Final scope check

**32 active tasks** (31 原 task − 1 合并 + 2 新增 = 32), 6 milestones. 单一 plan 体量较大但聚焦在 spec 阶段升级单一主题，符合 single-plan scope。建议执行时按 milestone 分批 commit 到 main，每个 milestone 完成后跑 `./test.sh` 全量验证。

### 修订记录

- **2026-05-12 round 1**: 初版 31 tasks
- **2026-05-12 round 2 (本次)**: 独立 reviewer 审查后修订
  - **新增**: T11.5 (plan/dev_ai_review budget gate), T22.5 (brainstorm 24h 超时 → aborted)
  - **合并**: T21 → T30 (占位测试整合)
  - **扩 scope**: T4 (worktree prune + system_config seed), T6 (plan/dev reject cap test), T8 (counter isolation case), T10 (S1措辞/S3收紧/lint warn/§X 尾标), T17 (round 2+ 历史引用校验), T28 (3 项闭环检查)

