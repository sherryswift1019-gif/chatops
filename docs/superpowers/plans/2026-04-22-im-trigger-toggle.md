# 产线内能力 IM 触发开关 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `product_line_capabilities` 表新增 `trigger_sources` JSONB 白名单字段，使产线可独立启用/禁用某能力的 IM 群聊触发通道；IM 触发与群聊能力列表（help）均按该字段过滤。

**Architecture:** 白名单字段 `trigger_sources JSONB DEFAULT '["im","web"]'` 承载触发源语义；后端运行时入口 `claude-runner.ts:run()` 已调 `checkCapabilityAccess`，只需注入 `source='im'` 参数 + 专用拒绝文案；`sendGreeting()` 渲染前按 `trigger_sources` 过滤能力清单；Admin API 与 Web 产线详情页同步暴露该字段的读写。

**Tech Stack:** TypeScript (ES2022, NodeNext), Fastify 5, PostgreSQL 16 (pg driver, raw SQL, 无 ORM), React 18 + Ant Design 5, Vitest.

**Spec:** [`docs/superpowers/specs/2026-04-22-im-trigger-toggle-design.md`](../specs/2026-04-22-im-trigger-toggle-design.md)

---

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema-v22.sql` | 创建 | 给 `product_line_capabilities` 加 `trigger_sources JSONB` 列 |
| `src/db/migrate.ts` | 修改 | 追加 v22 执行块，更新末尾 console.log |
| `src/db/repositories/product-line-capabilities.ts` | 修改 | 类型/mapRow/checkCapabilityAccess/batchSet 支持 triggerSources |
| `src/__tests__/unit/product-line-capabilities-repo.test.ts` | 创建 | checkCapabilityAccess 新路径单测 |
| `src/agent/claude-runner.ts` | 修改 | Step 4b 传 source='im'；sendGreeting 过滤能力清单 |
| `src/agent/runner-greet-filter.ts` | 创建 | 纯函数：按 product_line_capabilities 过滤 IM 可用能力（方便单测） |
| `src/__tests__/unit/runner-greet-filter.test.ts` | 创建 | filterImTriggerableCapabilities 单测 |
| `src/admin/routes/product-lines.ts` | 修改 | PUT 请求体 schema 接受 triggerSources |
| `web/src/api/capabilities.ts` | 修改 | `ProductLineCapability` 与 setter 签名加 `triggerSources` |
| `web/src/pages/ProductLineDetailPage.tsx` | 修改 | `editConfigs` 状态加 triggerSources；Modal 加「允许 IM 触发」Switch；保存时带上 |

---

## Task 1: 新增 schema-v22 迁移

**Files:**
- Create: `src/db/schema-v22.sql`
- Modify: `src/db/migrate.ts`

- [ ] **Step 1: 创建 SQL 文件**

Create `src/db/schema-v22.sql`:

```sql
-- v22: 产线内能力 IM 触发开关
-- 新增 trigger_sources JSONB 白名单，控制该能力在该产线下允许的触发源。
-- 值枚举：'im'（IM 群聊）、'web'（管理后台手动，v1 预留）；未来扩展 schedule/webhook。
-- 默认 ["im","web"]：向后兼容，迁移后现有数据等价于全部允许。

ALTER TABLE product_line_capabilities
  ADD COLUMN IF NOT EXISTS trigger_sources JSONB NOT NULL DEFAULT '["im","web"]'::jsonb;
```

- [ ] **Step 2: 在 migrate.ts 追加执行块**

Edit `src/db/migrate.ts`, 在 v21 块（第 83-85 行）之后、`// Sync PRD system prompts` 注释之前插入：

```typescript
const schemaV22 = readFileSync(join(__dirname, 'schema-v22.sql'), 'utf8')
await pool.query(schemaV22)
console.log('[migrate] schema-v22 applied')

```

并把文件最后一行（~第 123 行）的完成日志更新：

```typescript
console.log('✅ Database schema applied (v1 ~ v22, 含 PRD v16/v17 + pipeline canvas v18 + IM binding v19 + drop module_owners v20 + view_branches v21 + trigger_sources v22)')
```

- [ ] **Step 3: 运行迁移验证 SQL 语法正确**

Run: `pnpm migrate`
Expected: 输出最后一行包含 `v22` 字样，无异常。

- [ ] **Step 4: Commit**

```bash
git add src/db/schema-v22.sql src/db/migrate.ts
git commit -m "feat(db): 新增 trigger_sources 字段（schema-v22）"
```

---

## Task 2: Repository 类型与 mapRow 支持 triggerSources

**Files:**
- Modify: `src/db/repositories/product-line-capabilities.ts`

- [ ] **Step 1: 扩展类型与 mapRow**

Edit `src/db/repositories/product-line-capabilities.ts`. 把第 3-10 行的 interface 与第 12-21 行的 mapRow 替换为：

```typescript
export interface ProductLineCapability {
  id: number
  productLineId: number
  capabilityKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources: string[]
}

function mapRow(r: Record<string, unknown>): ProductLineCapability {
  const rawSources = r.trigger_sources
  const triggerSources: string[] = Array.isArray(rawSources)
    ? (rawSources as unknown[]).map(String)
    : ['im', 'web']
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    capabilityKey: r.capability_key as string,
    envName: r.env_name as string,
    enabled: r.enabled as boolean,
    allowedRoles: r.allowed_roles as string[],
    triggerSources,
  }
}
```

> `rawSources` 做非空数组兜底是防御性（DB 默认已是 `["im","web"]`，但极端场景 / 旧数据异常时不至于 crash）。

- [ ] **Step 2: 扩展 batchSetProductLineCapabilities**

同文件中，把第 65-91 行替换为：

```typescript
export async function batchSetProductLineCapabilities(
  productLineId: number,
  capabilities: Array<{
    capabilityKey: string
    envName: string
    enabled: boolean
    allowedRoles: string[]
    triggerSources?: string[]
  }>
): Promise<ProductLineCapability[]> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM product_line_capabilities WHERE product_line_id = $1', [productLineId])
    const results: ProductLineCapability[] = []
    for (const c of capabilities) {
      const sources = c.triggerSources ?? ['im', 'web']
      const { rows } = await client.query(
        `INSERT INTO product_line_capabilities
           (product_line_id, capability_key, env_name, enabled, allowed_roles, trigger_sources)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [productLineId, c.capabilityKey, c.envName, c.enabled, JSON.stringify(c.allowedRoles), JSON.stringify(sources)]
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
```

- [ ] **Step 3: 编译验证**

Run: `pnpm tsc --noEmit`
Expected: 无类型错误（checkCapabilityAccess 的调用还没改 signature，兼容；下个 Task 改）

- [ ] **Step 4: Commit**

```bash
git add src/db/repositories/product-line-capabilities.ts
git commit -m "feat(db): ProductLineCapability 类型与 batchSet 支持 triggerSources"
```

---

## Task 3: checkCapabilityAccess 增加 source 参数 + 单测

**Files:**
- Modify: `src/db/repositories/product-line-capabilities.ts`
- Create: `src/__tests__/unit/product-line-capabilities-repo.test.ts`

- [ ] **Step 1: 先写失败测试**

Create `src/__tests__/unit/product-line-capabilities-repo.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('../../db/client.js', () => ({
  getPool: () => ({ query: mockQuery, connect: vi.fn() }),
}))

import { checkCapabilityAccess } from '../../db/repositories/product-line-capabilities.js'

beforeEach(() => { mockQuery.mockReset() })

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    product_line_id: 1,
    capability_key: 'deploy',
    env_name: '*',
    enabled: true,
    allowed_roles: ['developer'],
    trigger_sources: ['im', 'web'],
    ...overrides,
  }
}

describe('checkCapabilityAccess - trigger_sources', () => {
  it('allows IM when trigger_sources contains im', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(true)
  })

  it('blocks IM with reason=source-blocked when trigger_sources excludes im', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ trigger_sources: ['web'] })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('source-blocked')
  })

  it('defaults to allow when trigger_sources column missing (legacy row)', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ trigger_sources: undefined })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(true)
  })

  it('priority: enabled=false rejects before trigger_sources check', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ enabled: false, trigger_sources: ['web'] })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(false)
    expect(res.reason).not.toBe('source-blocked')
  })

  it('priority: allowedRoles mismatch rejects before trigger_sources check', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ allowed_roles: ['admin'], trigger_sources: ['web'] })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(false)
    expect(res.reason).not.toBe('source-blocked')
  })

  it('web source allowed when trigger_sources contains web', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ trigger_sources: ['web'] })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'web')
    expect(res.allowed).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run src/__tests__/unit/product-line-capabilities-repo.test.ts`
Expected: 多条 FAIL（当前 `checkCapabilityAccess` 不接受第 5 参数 / 未返回 `source-blocked`）。TypeScript 也会报错。

- [ ] **Step 3: 实现 —— 扩展 checkCapabilityAccess**

Edit `src/db/repositories/product-line-capabilities.ts`. 把 `checkCapabilityAccess` 函数（~第 32-63 行）替换为：

```typescript
export async function checkCapabilityAccess(
  productLineId: number,
  capabilityKey: string,
  envName: string,
  userRole: string,
  source: 'im' | 'web' = 'im'
): Promise<{ allowed: boolean; reason?: string }> {
  const pool = getPool()

  // Check specific env first, then wildcard
  const { rows } = await pool.query(
    `SELECT * FROM product_line_capabilities
     WHERE product_line_id = $1 AND capability_key = $2 AND env_name IN ($3, '*')
     ORDER BY CASE WHEN env_name = $3 THEN 0 ELSE 1 END
     LIMIT 1`,
    [productLineId, capabilityKey, envName]
  )

  if (rows.length === 0) {
    return { allowed: false, reason: '该产线未配置此能力' }
  }

  const config = mapRow(rows[0])
  if (!config.enabled) {
    return { allowed: false, reason: '该能力在此环境未开放' }
  }
  if (!config.allowedRoles.includes(userRole)) {
    return { allowed: false, reason: '您的角色无权使用此能力' }
  }
  if (!config.triggerSources.includes(source)) {
    return { allowed: false, reason: 'source-blocked' }
  }

  return { allowed: true }
}
```

`source` 默认 `'im'` 是为了让现有（尚未改 signature 的）调用点在过渡期保持旧行为——但实际全仓只有 claude-runner 一处调用，Task 4 会显式传入。

- [ ] **Step 4: 测试通过**

Run: `npx vitest run src/__tests__/unit/product-line-capabilities-repo.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/product-line-capabilities.ts src/__tests__/unit/product-line-capabilities-repo.test.ts
git commit -m "feat(db): checkCapabilityAccess 支持 source 参数 + 单测"
```

---

## Task 4: Claude Runner Step 4b 注入 source='im' + 专用拒绝文案

**Files:**
- Modify: `src/agent/claude-runner.ts`

- [ ] **Step 1: 修改 checkCapabilityAccess 调用与拒绝分支**

Edit `src/agent/claude-runner.ts`. 把第 308-319 行（Step 4b）替换为：

```typescript
      // 4b: 已有产线的用户检查 capability-level 权限
      if (productLineId) {
        const envName = intent.env ?? '*'
        const access = await checkCapabilityAccess(productLineId, capability.key, envName, userRole, 'im')
        if (!access.allowed) {
          const text = access.reason === 'source-blocked'
            ? `⛔ 能力「${capability.displayName}」在当前产线已禁止通过 IM 触发，请到管理后台执行。`
            : `⛔ 无法执行「${capability.displayName}」：${access.reason}`
          await adapter.sendMessage(
            { type: 'group', id: opts.groupId },
            { text }
          )
          return
        }
      }
```

- [ ] **Step 2: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错。

- [ ] **Step 3: 既有测试无回归**

Run: `pnpm test`
Expected: 已有单测全部通过（这处改动与既有测试无交叉）。

- [ ] **Step 4: Commit**

```bash
git add src/agent/claude-runner.ts
git commit -m "feat(runner): IM 触发带 source='im' + source-blocked 专用拒绝文案"
```

> **测试说明**：Spec 提到 `claude-runner.run()` 的 IM 拦截路径应有单测，但 `run()` 分支庞大、无现成测试文件且外部依赖（Porygon、IMAdapter、Session）极多，为其新建 mock 套件代价高于收益。本 plan 通过两层覆盖该路径：(a) Task 3 的 `checkCapabilityAccess` 单测验证 `source='im'` + `source-blocked` 原因码；(b) Task 10 的手工端到端验证确认 Runner 正确传递 source 参数与渲染专用文案。如后续 Runner 层需要单测，建议把 Step 4b 内部的 access→text 映射提纯成独立函数再单测。

---

## Task 5: sendGreeting 按 trigger_sources 过滤能力清单

**Files:**
- Create: `src/agent/runner-greet-filter.ts`
- Create: `src/__tests__/unit/runner-greet-filter.test.ts`
- Modify: `src/agent/claude-runner.ts`

- [ ] **Step 1: 先写失败测试**

Create `src/__tests__/unit/runner-greet-filter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { filterImTriggerableCapabilities } from '../../agent/runner-greet-filter.js'
import type { Capability } from '../../db/repositories/capabilities.js'
import type { ProductLineCapability } from '../../db/repositories/product-line-capabilities.js'

function cap(key: string): Capability {
  return {
    id: 0, key, displayName: key, description: '', category: 'action',
    toolNames: [], needsApproval: false, paramSchema: {}, playbook: [],
    isSystem: false, systemPrompt: null, defaultSystemPrompt: null,
    defaultPipelineId: null,
    createdAt: new Date(), updatedAt: new Date(),
  } as Capability
}

function plCap(
  capabilityKey: string,
  opts: { enabled?: boolean; roles?: string[]; sources?: string[]; envName?: string } = {}
): ProductLineCapability {
  return {
    id: 0, productLineId: 1, capabilityKey,
    envName: opts.envName ?? '*',
    enabled: opts.enabled ?? true,
    allowedRoles: opts.roles ?? ['developer', 'tester', 'ops', 'admin'],
    triggerSources: opts.sources ?? ['im', 'web'],
  }
}

describe('filterImTriggerableCapabilities', () => {
  it('keeps capability when PL config allows IM', () => {
    const caps = [cap('deploy')]
    const plCaps = [plCap('deploy')]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer').map(c => c.key)).toEqual(['deploy'])
  })

  it('drops capability when trigger_sources excludes im', () => {
    const caps = [cap('deploy'), cap('rollback')]
    const plCaps = [plCap('deploy', { sources: ['web'] }), plCap('rollback')]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer').map(c => c.key)).toEqual(['rollback'])
  })

  it('drops capability when enabled=false', () => {
    const caps = [cap('deploy')]
    const plCaps = [plCap('deploy', { enabled: false })]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer')).toEqual([])
  })

  it('drops capability when user role not allowed', () => {
    const caps = [cap('deploy')]
    const plCaps = [plCap('deploy', { roles: ['admin'] })]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer')).toEqual([])
  })

  it('drops capability with no PL config at all', () => {
    const caps = [cap('deploy'), cap('unconfigured')]
    const plCaps = [plCap('deploy')]
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer').map(c => c.key)).toEqual(['deploy'])
  })

  it('prefers specific env over wildcard when both exist', () => {
    // This helper is fed "*" configs in the greet path; specific-env merging is
    // already handled by checkCapabilityAccess at runtime. Here we only need
    // wildcard behavior.
    const caps = [cap('deploy')]
    const plCaps = [plCap('deploy', { envName: 'prod', sources: ['web'] }), plCap('deploy', { envName: '*' })]
    // '*' permits; 'prod' row is extra config but wildcard is authoritative for greet
    expect(filterImTriggerableCapabilities(caps, plCaps, 'developer').map(c => c.key)).toEqual(['deploy'])
  })
})
```

- [ ] **Step 2: 运行测试看失败**

Run: `npx vitest run src/__tests__/unit/runner-greet-filter.test.ts`
Expected: FAIL，`filterImTriggerableCapabilities` 未定义。

- [ ] **Step 3: 实现过滤函数**

Create `src/agent/runner-greet-filter.ts`:

```typescript
import type { Capability } from '../db/repositories/capabilities.js'
import type { ProductLineCapability } from '../db/repositories/product-line-capabilities.js'

/**
 * Greet/help 列表过滤：选出当前用户在该产线下"能被 IM 触发"的能力。
 * 仅看 env_name='*' 的配置，env 特定配置不在 greet 场景参与决策。
 */
export function filterImTriggerableCapabilities(
  caps: Capability[],
  plCaps: ProductLineCapability[],
  userRole: string,
): Capability[] {
  const wildcardByKey = new Map<string, ProductLineCapability>()
  for (const p of plCaps) {
    if (p.envName === '*') wildcardByKey.set(p.capabilityKey, p)
  }
  return caps.filter(c => {
    const p = wildcardByKey.get(c.key)
    if (!p) return false
    if (!p.enabled) return false
    if (!p.allowedRoles.includes(userRole)) return false
    if (!p.triggerSources.includes('im')) return false
    return true
  })
}
```

- [ ] **Step 4: 测试通过**

Run: `npx vitest run src/__tests__/unit/runner-greet-filter.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 修改 sendGreeting 调用 + 签名**

Edit `src/agent/claude-runner.ts`. 首先在文件顶部 import 区（~第 7 行附近）追加：

```typescript
import { checkCapabilityAccess, getProductLineCapabilities } from '../db/repositories/product-line-capabilities.js'
import { filterImTriggerableCapabilities } from './runner-greet-filter.js'
```

把原来第 7 行单独的 `import { checkCapabilityAccess } ...` 合并成上面这一行。

然后把第 263-267 行（greet 分支）替换为：

```typescript
      // Step 2: greet → 固定帮助（永不 resume）
      if (intent?.capability === 'greet') {
        await this.sendGreeting(adapter, opts.groupId, atIds, productLineId, context.initiatorRole ?? 'developer')
        return
      }
```

把第 282-284 行（无 session 也无 intent 的 fallback greet）替换为：

```typescript
        // 无 session 也无 intent → 当 greet
        await this.sendGreeting(adapter, opts.groupId, atIds, productLineId, context.initiatorRole ?? 'developer')
        return
```

- [ ] **Step 6: 修改 sendGreeting 函数体**

同一文件，把 `sendGreeting` 方法（~第 471-498 行）整体替换为：

```typescript
  private async sendGreeting(
    adapter: IMAdapter,
    groupId: string,
    atDingtalkIds?: string[],
    productLineId?: number,
    userRole: string = 'developer',
  ): Promise<void> {
    let caps = await listCapabilities()
    if (productLineId) {
      const plCaps = await getProductLineCapabilities(productLineId)
      caps = filterImTriggerableCapabilities(caps, plCaps, userRole)
    }
    if (caps.length === 0) {
      await adapter.sendMessage(
        { type: 'group', id: groupId },
        { text: '你当前在本产线下没有可通过 IM 触发的能力，请联系管理员或到管理后台查看。', atDingtalkIds } as any
      )
      return
    }
    const examples: Record<string, string> = {
      deploy: '部署 ssh-proxy 到 dev 环境，分支 develop',
      rollback: '回滚 ssh-proxy dev 环境',
      restart: '重启 rdp-proxy dev 环境',
      custom_script: '在 proxy-server 上执行 df -h',
      manage_role: '给黄文华 ops 角色',
      view_deployments: '查看 ssh-proxy 的部署历史',
      view_images: '查看 rdp-proxy 的镜像列表',
      view_logs: '查看 ssh-proxy dev 环境最近 50 行日志',
      view_commits: '查看 ssh-proxy 最近的提交记录',
      view_projects: '查看当前产线有哪些模块',
    }
    const capsList = caps.map(c => {
      const ex = examples[c.key]
      return ex
        ? `- **${c.displayName}** — ${c.description}\n  > 💬 \`${ex}\``
        : `- **${c.displayName}** — ${c.description}`
    }).join('\n')
    const text = [
      '## 你好！我是 ChatOps 助手',
      '**我目前支持以下能力：**',
      capsList,
      '直接用自然语言告诉我你想做什么即可。',
    ].join('\n\n')
    await adapter.sendMessage({ type: 'group', id: groupId }, { text, atDingtalkIds } as any)
  }
```

- [ ] **Step 7: 类型检查 + 全量测试**

Run: `pnpm tsc --noEmit && pnpm test`
Expected: 类型无错，所有测试通过。

- [ ] **Step 8: Commit**

```bash
git add src/agent/runner-greet-filter.ts src/__tests__/unit/runner-greet-filter.test.ts src/agent/claude-runner.ts
git commit -m "feat(runner): sendGreeting 按 trigger_sources 过滤 IM 能力清单"
```

---

## Task 6: Admin API 接受 triggerSources

**Files:**
- Modify: `src/admin/routes/product-lines.ts`

- [ ] **Step 1: 扩展 PUT 请求体类型**

Edit `src/admin/routes/product-lines.ts`. 把第 115-123 行替换为：

```typescript
  app.put<{
    Params: { id: string }
    Body: Array<{
      capabilityKey: string
      envName: string
      enabled: boolean
      allowedRoles: string[]
      triggerSources?: string[]
    }>
  }>(
    '/product-lines/:id/capabilities', async (req, reply) => {
      const productLineId = Number(req.params.id)
      const caps = req.body
      if (!Array.isArray(caps)) return reply.status(400).send({ error: 'body must be array' })
      const result = await batchSetProductLineCapabilities(productLineId, caps)
      return reply.send(result)
    }
  )
```

GET 路由（第 111-113 行）无需改：repository 的 mapRow 已在 Task 2 补了 `triggerSources`，`getProductLineCapabilities` 自动带上该字段。

- [ ] **Step 2: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错。

- [ ] **Step 3: Commit**

```bash
git add src/admin/routes/product-lines.ts
git commit -m "feat(admin): /product-lines/:id/capabilities 请求体接受 triggerSources"
```

---

## Task 7: 前端 API 类型与 setter 签名

**Files:**
- Modify: `web/src/api/capabilities.ts`

- [ ] **Step 1: 扩展类型与 setter**

Edit `web/src/api/capabilities.ts`. 把第 21-28 行替换为：

```typescript
export interface ProductLineCapability {
  id: number
  productLineId: number
  capabilityKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources: string[]
}
```

把第 47-48 行替换为：

```typescript
export const setProductLineCapabilities = (
  plId: number,
  caps: Array<{
    capabilityKey: string
    envName: string
    enabled: boolean
    allowedRoles: string[]
    triggerSources?: string[]
  }>
) =>
  client.put<ProductLineCapability[]>(`/product-lines/${plId}/capabilities`, caps).then(r => r.data)
```

- [ ] **Step 2: 前端类型检查**

Run: `cd web && pnpm tsc --noEmit`
Expected: 会在 `ProductLineDetailPage.tsx` 有报错（editConfigs 类型尚未含 triggerSources），Task 8 会解决。

如果报错只发生在 ProductLineDetailPage.tsx：符合预期，继续。
如有其他文件报错：对应补上。

- [ ] **Step 3: Commit**

```bash
git add web/src/api/capabilities.ts
git commit -m "feat(web): ProductLineCapability 类型支持 triggerSources"
```

---

## Task 8: 前端 editConfigs 状态结构升级

**Files:**
- Modify: `web/src/pages/ProductLineDetailPage.tsx`

- [ ] **Step 1: editConfigs 类型与初始/变更/保存逻辑同步扩展**

Edit `web/src/pages/ProductLineDetailPage.tsx`.

**(1) 第 750 行** state 定义替换为：

```typescript
  const [editConfigs, setEditConfigs] = useState<Record<string, { enabled: boolean; allowedRoles: string[]; triggerSources: string[] }>>({})
```

**(2) 第 770-778 行** `openEdit` 函数替换为：

```typescript
  function openEdit(cap: Capability) {
    setEditingCap(cap)
    const configs: Record<string, { enabled: boolean; allowedRoles: string[]; triggerSources: string[] }> = {}
    const capConfigs = plCaps.filter(c => c.capabilityKey === cap.key)
    for (const c of capConfigs) {
      configs[c.envName] = {
        enabled: c.enabled,
        allowedRoles: [...c.allowedRoles],
        triggerSources: c.triggerSources ? [...c.triggerSources] : ['im', 'web'],
      }
    }
    setEditConfigs(configs)
  }
```

**(3) 第 780-788 行** `handleConfigChange` 函数替换为（新增 `triggerSources` 字段类型 + 默认值）：

```typescript
  function handleConfigChange(envName: string, field: 'enabled' | 'allowedRoles' | 'triggerSources', value: unknown) {
    setEditConfigs(prev => ({
      ...prev,
      [envName]: {
        ...(prev[envName] ?? { enabled: true, allowedRoles: ['developer', 'tester', 'ops', 'admin'], triggerSources: ['im', 'web'] }),
        [field]: value,
      },
    }))
  }
```

**(4) 第 790-809 行** `handleSave` 函数替换为：

```typescript
  async function handleSave() {
    if (!editingCap) return
    setSaving(true)
    try {
      const otherConfigs = plCaps
        .filter(c => c.capabilityKey !== editingCap.key)
        .map(c => ({
          capabilityKey: c.capabilityKey,
          envName: c.envName,
          enabled: c.enabled,
          allowedRoles: c.allowedRoles,
          triggerSources: c.triggerSources ?? ['im', 'web'],
        }))

      const thisConfigs = Object.entries(editConfigs)
        .filter(([_, v]) => v.enabled || v.allowedRoles.length > 0)
        .map(([envName, v]) => ({
          capabilityKey: editingCap.key,
          envName,
          enabled: v.enabled,
          allowedRoles: v.allowedRoles,
          triggerSources: v.triggerSources,
        }))

      await setProductLineCapabilities(productLineId, [...otherConfigs, ...thisConfigs])
      message.success('能力配置已保存')
      setEditingCap(null)
      await loadData()
    } catch { message.error('保存失败') }
    finally { setSaving(false) }
  }
```

- [ ] **Step 2: 类型检查**

Run: `cd web && pnpm tsc --noEmit`
Expected: 如果还有 Modal 里 `editConfigs['*']?.triggerSources` 相关报错，说明 UI 部分还没加（Task 9 解决）。如果只剩 Modal 未使用的报错或无报错，继续。

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/ProductLineDetailPage.tsx
git commit -m "feat(web): 能力配置 state 支持 triggerSources"
```

---

## Task 9: 前端 Modal 加「允许 IM 触发」Switch

**Files:**
- Modify: `web/src/pages/ProductLineDetailPage.tsx`

- [ ] **Step 1: 引入 Tooltip（若未引入）**

Check 文件顶部 antd import。若无 `Tooltip`，把 antd import 语句加上 `Tooltip`，例如：

```typescript
import { /* ...existing... */ Tooltip } from 'antd'
```

（若已存在则跳过）

- [ ] **Step 2: 替换 Modal 里全局行的渲染**

Edit `web/src/pages/ProductLineDetailPage.tsx`. 把第 881-897 行（全局行 `* 全局` 块）替换为：

```tsx
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fafafa', borderRadius: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 500, width: 120 }}>* 全局</span>
                <Switch
                  checked={editConfigs['*']?.enabled ?? false}
                  onChange={(v) => handleConfigChange('*', 'enabled', v)}
                  checkedChildren="开" unCheckedChildren="关"
                />
                <Tooltip title="关闭后该能力在本产线下不能通过钉钉/飞书群聊触发，仍可通过管理后台执行">
                  <span style={{ marginLeft: 12 }}>
                    <span style={{ marginRight: 6, color: '#666' }}>允许 IM 触发</span>
                    <Switch
                      checked={editConfigs['*']?.triggerSources?.includes('im') ?? true}
                      onChange={(v) => {
                        const current = editConfigs['*']?.triggerSources ?? ['im', 'web']
                        const next = v
                          ? Array.from(new Set([...current, 'im']))
                          : current.filter(s => s !== 'im')
                        handleConfigChange('*', 'triggerSources', next.length > 0 ? next : ['web'])
                      }}
                      checkedChildren="IM" unCheckedChildren="IM"
                    />
                  </span>
                </Tooltip>
              </div>
              {editConfigs['*']?.enabled && (
                <Checkbox.Group
                  options={roleOptions}
                  value={editConfigs['*']?.allowedRoles ?? []}
                  onChange={(v) => handleConfigChange('*', 'allowedRoles', v)}
                />
              )}
            </div>
```

- [ ] **Step 3: 替换 Modal 里 env 行的渲染**

同文件，把第 899-917 行（`envs.map(env => ...)` 块）替换为：

```tsx
            {envs.map(env => (
              <div key={env.id} style={{ marginBottom: 12, padding: '8px 12px', background: '#fafafa', borderRadius: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 500, width: 120 }}>{env.displayName}（{env.name}）</span>
                  <Switch
                    checked={editConfigs[env.name]?.enabled ?? false}
                    onChange={(v) => handleConfigChange(env.name, 'enabled', v)}
                    checkedChildren="开" unCheckedChildren="关"
                  />
                  <Tooltip title="关闭后该能力在本产线下不能通过钉钉/飞书群聊触发，仍可通过管理后台执行">
                    <span style={{ marginLeft: 12 }}>
                      <span style={{ marginRight: 6, color: '#666' }}>允许 IM 触发</span>
                      <Switch
                        checked={editConfigs[env.name]?.triggerSources?.includes('im') ?? true}
                        onChange={(v) => {
                          const current = editConfigs[env.name]?.triggerSources ?? ['im', 'web']
                          const next = v
                            ? Array.from(new Set([...current, 'im']))
                            : current.filter(s => s !== 'im')
                          handleConfigChange(env.name, 'triggerSources', next.length > 0 ? next : ['web'])
                        }}
                        checkedChildren="IM" unCheckedChildren="IM"
                      />
                    </span>
                  </Tooltip>
                </div>
                {editConfigs[env.name]?.enabled && (
                  <Checkbox.Group
                    options={roleOptions}
                    value={editConfigs[env.name]?.allowedRoles ?? []}
                    onChange={(v) => handleConfigChange(env.name, 'allowedRoles', v)}
                  />
                )}
              </div>
            ))}
```

- [ ] **Step 4: 前端构建验证**

Run: `cd web && pnpm build`
Expected: 类型检查与打包都成功，生成 `web/dist/`。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ProductLineDetailPage.tsx
git commit -m "feat(web): 能力配置 Modal 新增允许 IM 触发 Switch"
```

---

## Task 10: 后端构建 + 手工端到端验证

**Files:** 无代码改动

- [ ] **Step 1: 后端构建**

Run: `pnpm tsc --noEmit && pnpm test`
Expected: 类型检查无错，所有单测通过。

- [ ] **Step 2: 启动环境**

Run: `pnpm migrate && pnpm dev`
Expected: `[migrate] schema-v22 applied` 打印出现；后端监听端口无异常。

另开终端：`cd web && pnpm dev`
前端访问 `http://localhost:5173`。

- [ ] **Step 3: UI 验证「允许 IM 触发」Switch 保存/读取**

1. 进入任一产线详情页 → 能力管理 → 编辑任一能力
2. 关闭某环境的「允许 IM 触发」Switch → 保存
3. 重新打开该能力的配置 → 确认该环境「允许 IM 触发」仍是关闭状态
4. DB 侧确认：
   ```sql
   SELECT env_name, trigger_sources FROM product_line_capabilities
   WHERE product_line_id=<PL_ID> AND capability_key=<KEY>;
   ```
   对应行的 `trigger_sources` 应为 `["web"]`。

- [ ] **Step 4: IM 触发拦截验证**

1. 在配置为 `trigger_sources=["web"]` 的能力所在产线的钉钉/飞书群中，`@` 机器人触发该能力（例如 "部署 ssh-proxy 到 dev"）
2. 预期：收到 `⛔ 能力「XXX」在当前产线已禁止通过 IM 触发，请到管理后台执行。`，**未**启动 pipeline 或 Agent 执行
3. 把 Switch 重新打开并保存
4. 重新 @ 机器人触发 → 预期正常进入能力执行流程

- [ ] **Step 5: help 列表过滤验证**

1. 产线里仅保留某能力 A（`trigger_sources=["im","web"]`）；能力 B 配 `trigger_sources=["web"]`
2. 群内 @ 机器人发 "help" 或 "支持哪些能力"
3. 预期：列表只含 A，不含 B
4. 把 A 的 IM 开关也关闭 → 群内再次发 help → 预期：收到"你当前在本产线下没有可通过 IM 触发的能力..." 提示

- [ ] **Step 6: Commit 可选的文档修订**

如手工验证发现文案/行为不符合 spec，回到对应 Task 补修复并 commit。

全部通过后本地分支状态已准备好用于 PR。
