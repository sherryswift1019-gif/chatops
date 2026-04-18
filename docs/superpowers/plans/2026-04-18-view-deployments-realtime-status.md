# view_deployments 实时环境巡检 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `view_deployments` 能力从"查 DB 历史"重构为"实时扫描环境中所有模块的容器状态 + GitLab 版本差异"。

**Architecture:**
新增 `check_environment_status` MCP 工具替换旧 `query_deployments`。工具并行对产线下每个模块 SSH 执行 `docker inspect`，从镜像 RepoTags 反解部署 commit，然后调 GitLab Compare API 统计落后 commit 数。新增 schema-v10 给 `product_line_envs` 加 `default_branch` 列，admin UI 环境配置行增加输入框。

**Tech Stack:** TypeScript / Node.js / Fastify / PostgreSQL / ssh2 / axios / Vitest / React 18 / Ant Design 5

**Spec:** `docs/superpowers/specs/2026-04-18-view-deployments-realtime-status-design.md`

**注意：schema-v9 已被 `admin_users` 占用**，本次 schema 变更使用 **v10**。

---

## 文件结构

### 新建
- `src/db/schema-v10.sql` — ALTER TABLE + UPDATE capabilities
- `src/agent/tools/check-env-status.ts` — 主工具（~120 行）
- `src/agent/tools/env-status/tag-parser.ts` — 镜像 tag → { branch, shortId } 反解（纯函数，易测）
- `src/agent/tools/env-status/gitlab.ts` — getLatestBranchCommit + compareCommits
- `src/agent/tools/env-status/docker-probe.ts` — SSH 执行 docker inspect + image inspect 并解析
- `src/agent/tools/env-status/resolver.ts` — 单模块状态决策（纯函数，易测）
- `src/agent/tools/env-status/formatter.ts` — 结果 → LLM 文本
- `src/__tests__/unit/env-status-tag-parser.test.ts`
- `src/__tests__/unit/env-status-resolver.test.ts`
- `src/__tests__/unit/env-status-formatter.test.ts`
- `src/__tests__/unit/check-env-status-tool.test.ts`

### 修改
- `src/db/migrate.ts` — 追加 v10 执行
- `src/db/repositories/product-line-envs.ts` — interface + CRUD 加 `defaultBranch`
- `src/admin/routes/product-lines.ts` — PUT /envs body 加 defaultBranch
- `src/agent/tools/types.ts` — DEFAULT_TOOL_ROLES 增加 check_environment_status
- `src/agent/tools/index.ts` — 无改动（工具自注册）
- `src/agent/mcp-server.ts` — import 新工具，移除 query-deployments
- `src/server.ts` — import 同上
- `web/src/types/index.ts` — ProductLineEnv 加 defaultBranch
- `web/src/api/product-lines.ts` — setProductLineEnvs body 加 defaultBranch
- `web/src/pages/ProductLineDetailPage.tsx` — EnvConfigTab 加"默认分支"列

### 保留（deprecated）
- `src/agent/tools/query-deployments.ts` — 两周观察期内保留文件（不注册），用作回滚备份

---

## Task 1: Schema 迁移（v10）新增 default_branch 列

**Files:**
- Create: `src/db/schema-v10.sql`
- Modify: `src/db/migrate.ts:32-36`

- [ ] **Step 1: 写 schema-v10.sql**

Create `src/db/schema-v10.sql`:
```sql
-- schema-v10: product_line_envs.default_branch + view_deployments tool 切换

ALTER TABLE product_line_envs
  ADD COLUMN IF NOT EXISTS default_branch TEXT NOT NULL DEFAULT '';

-- view_deployments capability 指向新工具
UPDATE capabilities SET
  tool_names = '["check_environment_status"]',
  default_system_prompt = E'你是一个 DevOps 助手，帮用户汇总某环境下所有模块的实时部署状态。\n当前用户角色: {{initiatorRole}}\n只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具。\n\n根据 check_environment_status 工具的输出，用 Markdown 表格汇总每个模块的：状态 / 启动时长 / 当前版本 / 与最新版本差距。\n状态图标：✅ 最新、🟡 落后、⚠️ 不健康、❌ 异常、⚪ 未部署、❓ 未知。\n如有模块落后 commit 数较大（≥30），额外标注提示。',
  system_prompt = default_system_prompt,
  updated_at = NOW()
WHERE key = 'view_deployments';
```

- [ ] **Step 2: 把 v10 加到 migrate.ts**

In `src/db/migrate.ts`, 在 v9 执行后、`await pool.end()` 之前插入：
```ts
const schemaV10 = readFileSync(join(__dirname, 'schema-v10.sql'), 'utf8')
await pool.query(schemaV10)
```

And update the final console.log:
```ts
console.log('✅ Database schema applied (v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9 + v10)')
```

- [ ] **Step 3: 本地执行迁移验证**

Run: `pnpm migrate`

Expected: 打印 `✅ Database schema applied ... + v10`，无错误。

Verify via psql:
```sql
\d product_line_envs
```
Expected: 列 `default_branch | text | not null | ''::text`

- [ ] **Step 4: 提交**

```bash
git add src/db/schema-v10.sql src/db/migrate.ts
git commit -m "feat(db): schema v10 adds product_line_envs.default_branch + retarget view_deployments"
```

---

## Task 2: Repository 层加入 defaultBranch

**Files:**
- Modify: `src/db/repositories/product-line-envs.ts:20-28, 38-48, 50-65, 97-103`

- [ ] **Step 1: 写失败测试**

Create/append in `src/__tests__/unit/repositories.test.ts` (or create new `src/__tests__/unit/product-line-envs-repo.test.ts` if repositories.test.ts doesn't cover this repo; verify first with `grep -n "product-line-envs" src/__tests__/unit/repositories.test.ts`）：

若不存在相关测试，新建 `src/__tests__/unit/product-line-envs-repo.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('../../db/client.js', () => ({
  getPool: () => ({ query: mockQuery, connect: vi.fn() }),
}))

import { upsertProductLineEnv } from '../../db/repositories/product-line-envs.js'

beforeEach(() => { mockQuery.mockReset() })

describe('product-line-envs repo - defaultBranch', () => {
  it('persists defaultBranch on upsert', async () => {
    mockQuery.mockResolvedValue({ rows: [{
      id: 1, product_line_id: 1, env_id: 2,
      runtime: 'docker', namespace: '', enabled: true,
      connection_config: { serverIds: [5] },
      default_branch: 'develop',
    }]})
    const res = await upsertProductLineEnv({
      productLineId: 1, envId: 2, runtime: 'docker',
      connectionConfig: { serverIds: [5] }, defaultBranch: 'develop',
    })
    expect(res.defaultBranch).toBe('develop')
    const callArgs = mockQuery.mock.calls[0]
    expect(callArgs[1]).toContain('develop')
  })

  it('defaults defaultBranch to empty string when mapping row', async () => {
    mockQuery.mockResolvedValue({ rows: [{
      id: 1, product_line_id: 1, env_id: 2,
      runtime: 'docker', namespace: '', enabled: true,
      connection_config: {},
      default_branch: '',
    }]})
    const res = await upsertProductLineEnv({
      productLineId: 1, envId: 2, runtime: 'docker',
    })
    expect(res.defaultBranch).toBe('')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/product-line-envs-repo.test.ts`
Expected: FAIL — `defaultBranch` does not exist on ProductLineEnv / function signature mismatch.

- [ ] **Step 3: 改 interface、mapRow、upsert、batchSet**

Edit `src/db/repositories/product-line-envs.ts`:

① Interface (line ~20):
```ts
export interface ProductLineEnv {
  id: number
  productLineId: number
  envId: number
  runtime: 'kubernetes' | 'docker'
  namespace: string
  enabled: boolean
  connectionConfig: ConnectionConfig
  defaultBranch: string
}
```

② mapRow:
```ts
function mapRow(r: Record<string, unknown>): ProductLineEnv {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    envId: r.env_id as number,
    runtime: r.runtime as 'kubernetes' | 'docker',
    namespace: r.namespace as string,
    enabled: r.enabled as boolean,
    connectionConfig: (r.connection_config ?? {}) as ConnectionConfig,
    defaultBranch: (r.default_branch ?? '') as string,
  }
}
```

③ `upsertProductLineEnv`:
```ts
export async function upsertProductLineEnv(
  data: Pick<ProductLineEnv, 'productLineId' | 'envId' | 'runtime'> &
    Partial<Pick<ProductLineEnv, 'namespace' | 'enabled' | 'connectionConfig' | 'defaultBranch'>>
): Promise<ProductLineEnv> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_line_envs (product_line_id, env_id, runtime, namespace, enabled, connection_config, default_branch)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (product_line_id, env_id) DO UPDATE
     SET runtime = $3, namespace = $4, enabled = $5, connection_config = $6, default_branch = $7
     RETURNING *`,
    [data.productLineId, data.envId, data.runtime, data.namespace ?? '',
     data.enabled ?? true, JSON.stringify(data.connectionConfig ?? {}),
     data.defaultBranch ?? '']
  )
  return mapRow(rows[0])
}
```

④ `batchSetProductLineEnvs` — 把 defaultBranch 加到 param 类型和 INSERT SQL：
```ts
export async function batchSetProductLineEnvs(
  productLineId: number,
  envs: Array<Pick<ProductLineEnv, 'envId' | 'runtime'> &
    Partial<Pick<ProductLineEnv, 'namespace' | 'enabled' | 'connectionConfig' | 'defaultBranch'>>>
): Promise<ProductLineEnv[]> {
  // ... 保留原有 serverEnvMap 校验 ...

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM product_line_envs WHERE product_line_id = $1', [productLineId])
    const results: ProductLineEnv[] = []
    for (const env of envs) {
      const { rows } = await client.query(
        `INSERT INTO product_line_envs (product_line_id, env_id, runtime, namespace, enabled, connection_config, default_branch)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [productLineId, env.envId, env.runtime, env.namespace ?? '',
         env.enabled ?? true, JSON.stringify(env.connectionConfig ?? {}),
         env.defaultBranch ?? '']
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

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/unit/product-line-envs-repo.test.ts`
Expected: 2 passed.

- [ ] **Step 5: 提交**

```bash
git add src/db/repositories/product-line-envs.ts src/__tests__/unit/product-line-envs-repo.test.ts
git commit -m "feat(repo): product-line-envs add defaultBranch field"
```

---

## Task 3: Admin API 路由接受 defaultBranch

**Files:**
- Modify: `src/admin/routes/product-lines.ts:85-101`

- [ ] **Step 1: 更新 PUT /envs 的 Body 类型和字段映射**

Edit `src/admin/routes/product-lines.ts:85-101`:
```ts
app.put<{ Params: { id: string }; Body: Array<{ envId: number; runtime: string; namespace?: string; enabled?: boolean; connectionConfig?: Record<string, unknown>; defaultBranch?: string }> }>(
  '/product-lines/:id/envs', async (req, reply) => {
    const envs = req.body
    if (!Array.isArray(envs)) return reply.status(400).send({ error: 'body must be array' })
    try {
      const result = await batchSetProductLineEnvs(
        Number(req.params.id),
        envs.map(e => ({
          envId: e.envId,
          runtime: e.runtime as 'kubernetes' | 'docker',
          namespace: e.namespace,
          enabled: e.enabled,
          connectionConfig: e.connectionConfig,
          defaultBranch: e.defaultBranch,
        }))
      )
      return reply.send(result)
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number; duplicates?: Array<[number, number[]]> }
      if (e.statusCode === 400) return reply.status(400).send({ error: e.message, duplicates: e.duplicates })
      throw err
    }
  }
)
```

- [ ] **Step 2: 冒烟测试 API**

启动后端：`pnpm dev`

在另一个终端用 curl：
```bash
curl -X PUT http://localhost:3000/admin/product-lines/1/envs \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <从浏览器拿到的 session cookie>' \
  -d '[{"envId":1,"runtime":"docker","enabled":true,"connectionConfig":{"serverIds":[1]},"defaultBranch":"develop"}]'
```
Expected: 200，响应中包含 `"defaultBranch":"develop"`。

（若本地无 test 环境，此步可跳过，依赖后续 Task 5 前端打通后集成验证。）

- [ ] **Step 3: 提交**

```bash
git add src/admin/routes/product-lines.ts
git commit -m "feat(admin): product-line envs API accepts defaultBranch"
```

---

## Task 4: 前端类型 + API 接入

**Files:**
- Modify: `web/src/types/index.ts:10-14`
- Modify: `web/src/api/product-lines.ts:22-23`

- [ ] **Step 1: 更新前端 ProductLineEnv 类型**

Edit `web/src/types/index.ts:10-14`:
```ts
export interface ProductLineEnv {
  id: number; productLineId: number; envId: number
  runtime: 'kubernetes' | 'docker'; namespace: string; enabled: boolean
  connectionConfig: Record<string, unknown>
  defaultBranch: string
}
```

- [ ] **Step 2: 更新 setProductLineEnvs body 类型**

Edit `web/src/api/product-lines.ts:22-23`:
```ts
export const setProductLineEnvs = (plId: number, envs: Array<{
  envId: number; runtime: string; namespace?: string; enabled?: boolean
  connectionConfig?: Record<string, unknown>; defaultBranch?: string
}>) =>
  client.put<ProductLineEnv[]>(`/product-lines/${plId}/envs`, envs).then(r => r.data)
```

- [ ] **Step 3: 前端 TS 类型检查**

Run: `cd web && pnpm build`
Expected: 可能会因 ProductLineDetailPage 未传 defaultBranch 报错 → 在 Task 5 修复。若 build 成功说明 tsc 对可选字段容忍；若失败记下错误，转 Task 5。

- [ ] **Step 4: 提交**

```bash
git add web/src/types/index.ts web/src/api/product-lines.ts
git commit -m "feat(web): ProductLineEnv type adds defaultBranch"
```

---

## Task 5: 前端环境配置表格加"默认分支"列

**Files:**
- Modify: `web/src/pages/ProductLineDetailPage.tsx:377-462`（EnvRow interface + load + save + columns）

- [ ] **Step 1: EnvRow interface 加 defaultBranch**

Edit `web/src/pages/ProductLineDetailPage.tsx:377-385`:
```ts
interface EnvRow {
  envId: number
  envName: string
  envDisplayName: string
  enabled: boolean
  runtime: 'kubernetes' | 'docker'
  namespace: string
  connectionConfig: Record<string, unknown>
  defaultBranch: string
}
```

- [ ] **Step 2: load() 填充 defaultBranch**

Edit 同文件 `setRows(...)` 块，在每行对象里加：
```ts
return {
  envId: env.id,
  envName: env.name,
  envDisplayName: env.displayName,
  enabled: existing?.enabled ?? false,
  runtime: (existing?.runtime as 'kubernetes' | 'docker') ?? 'docker',
  namespace: existing?.namespace ?? '',
  connectionConfig: existing?.connectionConfig ?? {},
  defaultBranch: existing?.defaultBranch ?? '',
}
```

- [ ] **Step 3: handleSave() 传 defaultBranch**

Edit 同文件 setProductLineEnvs 调用处：
```ts
await setProductLineEnvs(productLineId, rows.map(r => ({
  envId: r.envId,
  runtime: r.runtime,
  namespace: r.namespace,
  enabled: r.enabled,
  connectionConfig: r.connectionConfig,
  defaultBranch: r.defaultBranch,
})))
```

- [ ] **Step 4: columns 追加"默认分支"列**

Edit 同文件 `const columns = [...]`，在"连接配置"之后追加：
```tsx
{
  title: '默认分支',
  dataIndex: 'defaultBranch',
  width: 140,
  render: (v: string, record: EnvRow) => (
    <Input
      value={v}
      placeholder="如 develop"
      onChange={(e) => updateRow(record.envId, { defaultBranch: e.target.value })}
    />
  ),
},
```

- [ ] **Step 5: 前端构建 + 手动验证**

Run: `cd web && pnpm build`
Expected: 0 errors.

Run: `cd web && pnpm dev` 然后浏览器打开产线详情 → 环境配置页，应看到"默认分支"输入框。填入 `develop` 点保存 → 刷新页面 → 值保留。

- [ ] **Step 6: 提交**

```bash
git add web/src/pages/ProductLineDetailPage.tsx
git commit -m "feat(web): env config tab adds default branch input"
```

---

## Task 6: 镜像 tag 反解工具函数

**Files:**
- Create: `src/agent/tools/env-status/tag-parser.ts`
- Create: `src/__tests__/unit/env-status-tag-parser.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/unit/env-status-tag-parser.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseImageTag, findDeployedTag } from '../../agent/tools/env-status/tag-parser.js'

describe('parseImageTag', () => {
  it('parses simple branch_shortId', () => {
    expect(parseImageTag('develop_a1b2c3d4')).toEqual({ branch: 'develop', shortId: 'a1b2c3d4' })
  })

  it('parses branch with underscores', () => {
    expect(parseImageTag('release_1.2_deadbeef')).toEqual({ branch: 'release_1.2', shortId: 'deadbeef' })
    expect(parseImageTag('feature_auth_v2_cafebabe')).toEqual({ branch: 'feature_auth_v2', shortId: 'cafebabe' })
  })

  it('rejects latest/prev/non-commit tags', () => {
    expect(parseImageTag('latest')).toBeNull()
    expect(parseImageTag('prev')).toBeNull()
    expect(parseImageTag('develop_XYZ12345')).toBeNull()  // non-hex
    expect(parseImageTag('develop_a1b2c3')).toBeNull()     // too short
    expect(parseImageTag('develop_a1b2c3d4e')).toBeNull()  // too long
  })
})

describe('findDeployedTag', () => {
  it('picks the {branch}_{hex8} tag from RepoTags', () => {
    const tags = [
      'harbor.example.com/proj/svc:latest',
      'harbor.example.com/proj/svc:prev',
      'harbor.example.com/proj/svc:develop_a1b2c3d4',
    ]
    expect(findDeployedTag(tags, 'harbor.example.com', 'proj/svc'))
      .toEqual({ branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' })
  })

  it('returns null when no commit-style tag exists', () => {
    const tags = ['harbor.example.com/proj/svc:latest', 'harbor.example.com/proj/svc:prev']
    expect(findDeployedTag(tags, 'harbor.example.com', 'proj/svc')).toBeNull()
  })

  it('ignores tags from other repositories', () => {
    const tags = [
      'harbor.example.com/other/svc:develop_11111111',
      'harbor.example.com/proj/svc:latest',
    ]
    expect(findDeployedTag(tags, 'harbor.example.com', 'proj/svc')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/env-status-tag-parser.test.ts`
Expected: FAIL — file not found.

- [ ] **Step 3: 实现**

Create `src/agent/tools/env-status/tag-parser.ts`:
```ts
export interface ParsedTag {
  branch: string
  shortId: string
}

export interface DeployedTag extends ParsedTag {
  imageTag: string
}

const TAG_RE = /^(.+)_([0-9a-f]{8})$/

export function parseImageTag(tag: string): ParsedTag | null {
  const m = TAG_RE.exec(tag)
  if (!m) return null
  return { branch: m[1], shortId: m[2] }
}

export function findDeployedTag(
  repoTags: string[],
  registryHost: string,
  harborProject: string,
): DeployedTag | null {
  const prefix = `${registryHost}/${harborProject}:`
  for (const full of repoTags) {
    if (!full.startsWith(prefix)) continue
    const tag = full.slice(prefix.length)
    const parsed = parseImageTag(tag)
    if (parsed) return { ...parsed, imageTag: tag }
  }
  return null
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/unit/env-status-tag-parser.test.ts`
Expected: all passed.

- [ ] **Step 5: 提交**

```bash
git add src/agent/tools/env-status/tag-parser.ts src/__tests__/unit/env-status-tag-parser.test.ts
git commit -m "feat(env-status): image tag parser helpers"
```

---

## Task 7: GitLab 查询封装（branch 最新 + compare）

**Files:**
- Create: `src/agent/tools/env-status/gitlab.ts`

- [ ] **Step 1: 实现 GitLab helpers**

Create `src/agent/tools/env-status/gitlab.ts`:
```ts
import axios from 'axios'
import https from 'https'
import { getConfig } from '../../../db/repositories/system-config.js'

export interface LatestCommit {
  commitId: string
  shortId: string
  message: string
}

export interface CompareResult {
  commitsBehind: number | null
  tooLarge: boolean
  latestSummaries: Array<{ shortId: string; message: string }>
}

async function gitlabConfig(): Promise<{ url: string; token: string; agent?: https.Agent } | null> {
  const cfg = await getConfig('gitlab')
  if (!cfg) return null
  const v = cfg.value as Record<string, string>
  if (!v.url || !v.token) return null
  const skip = v.skipTlsVerify === 'true' || v.skipTlsVerify === (true as unknown as string)
  return {
    url: v.url,
    token: v.token,
    agent: skip ? new https.Agent({ rejectUnauthorized: false }) : undefined,
  }
}

export async function getLatestBranchCommit(
  gitlabPath: string,
  branch: string,
): Promise<LatestCommit | null> {
  const gl = await gitlabConfig()
  if (!gl) return null

  const encodedProject = encodeURIComponent(gitlabPath)
  const encodedBranch = encodeURIComponent(branch)
  try {
    const res = await axios.get<{ commit: { id: string; short_id: string; message: string } }>(
      `${gl.url}/api/v4/projects/${encodedProject}/repository/branches/${encodedBranch}`,
      { headers: { 'PRIVATE-TOKEN': gl.token }, httpsAgent: gl.agent, timeout: 10000 }
    )
    return {
      commitId: res.data.commit.id,
      shortId: res.data.commit.short_id.slice(0, 8),
      message: res.data.commit.message,
    }
  } catch {
    return null
  }
}

export async function compareCommits(
  gitlabPath: string,
  fromShort: string,
  toShort: string,
): Promise<CompareResult | null> {
  const gl = await gitlabConfig()
  if (!gl) return null

  const encodedProject = encodeURIComponent(gitlabPath)
  try {
    const res = await axios.get<{
      commits: Array<{ id: string; short_id: string; message: string }>
      compare_timeout?: boolean
    }>(
      `${gl.url}/api/v4/projects/${encodedProject}/repository/compare`,
      {
        headers: { 'PRIVATE-TOKEN': gl.token },
        httpsAgent: gl.agent,
        timeout: 10000,
        params: { from: fromShort, to: toShort, straight: true },
      }
    )
    if (res.data.compare_timeout) {
      return { commitsBehind: null, tooLarge: true, latestSummaries: [] }
    }
    const commits = res.data.commits ?? []
    return {
      commitsBehind: commits.length,
      tooLarge: false,
      latestSummaries: commits.slice(0, 3).map(c => ({
        shortId: c.short_id.slice(0, 8),
        message: c.message.split('\n')[0].slice(0, 80),
      })),
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 2: TS 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -50`
Expected: 无本文件相关错误。

- [ ] **Step 3: 提交**

```bash
git add src/agent/tools/env-status/gitlab.ts
git commit -m "feat(env-status): GitLab latest-commit and compare helpers"
```

---

## Task 8: Docker inspect 探测封装

**Files:**
- Create: `src/agent/tools/env-status/docker-probe.ts`

- [ ] **Step 1: 实现 docker 探测**

Create `src/agent/tools/env-status/docker-probe.ts`:
```ts
import { Client } from 'ssh2'
import type { SSHTarget } from '../ssh-utils.js'
import { findDeployedTag, type DeployedTag } from './tag-parser.js'

export interface ContainerStatus {
  exists: boolean
  state?: 'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead' | 'removing'
  startedAt?: string
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none'
  exitCode?: number
}

export interface DockerProbeResult {
  container: ContainerStatus
  deployed: DeployedTag | null
  error?: string
}

function sshExec(target: SSHTarget, command: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { conn.end(); reject(new Error('ssh exec timeout')) }, timeoutMs)
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err) }
        stream.on('close', (code: number) => {
          clearTimeout(timer); conn.end()
          resolve({ stdout, stderr, code: code ?? 0 })
        })
        stream.on('data', (d: Buffer) => { stdout += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      })
    })
    conn.on('error', (e) => { clearTimeout(timer); reject(e) })
    conn.connect({
      host: target.host, port: target.port, username: target.username, password: target.password,
      readyTimeout: 10000,
    })
  })
}

const SEP = '---CHATOPS-SEP---'

export async function probeContainer(
  target: SSHTarget,
  containerName: string,
  registryHost: string,
  harborProject: string,
): Promise<DockerProbeResult> {
  const cmd = [
    `timeout 15 docker inspect ${containerName} 2>/dev/null || echo '[]'`,
    `echo '${SEP}'`,
    `IMG=$(timeout 5 docker inspect --format '{{.Image}}' ${containerName} 2>/dev/null)`,
    `if [ -n "$IMG" ]; then timeout 15 docker image inspect "$IMG" 2>/dev/null || echo '[]'; else echo '[]'; fi`,
  ].join('; ')

  try {
    const result = await sshExec(target, cmd)
    const [containerPart, imagePart] = result.stdout.split(SEP).map(s => s.trim())

    const containerArr = JSON.parse(containerPart || '[]') as Array<Record<string, unknown>>
    if (containerArr.length === 0) {
      return { container: { exists: false }, deployed: null }
    }
    const c = containerArr[0] as {
      State?: { Status?: string; StartedAt?: string; ExitCode?: number; Health?: { Status?: string } }
    }
    const state = (c.State?.Status ?? 'dead') as ContainerStatus['state']
    const health = (c.State?.Health?.Status ?? 'none') as ContainerStatus['health']

    const container: ContainerStatus = {
      exists: true,
      state,
      startedAt: c.State?.StartedAt,
      health,
      exitCode: c.State?.ExitCode,
    }

    const imageArr = JSON.parse(imagePart || '[]') as Array<{ RepoTags?: string[] }>
    const repoTags = imageArr[0]?.RepoTags ?? []
    const deployed = findDeployedTag(repoTags, registryHost, harborProject)

    return { container, deployed }
  } catch (err) {
    return {
      container: { exists: false },
      deployed: null,
      error: `ssh: ${String(err)}`,
    }
  }
}
```

- [ ] **Step 2: TS 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'docker-probe|env-status' | head -20`
Expected: 0 errors.

- [ ] **Step 3: 提交**

```bash
git add src/agent/tools/env-status/docker-probe.ts
git commit -m "feat(env-status): docker container + image probe over SSH"
```

---

## Task 9: 单模块状态决策器（纯函数）

**Files:**
- Create: `src/agent/tools/env-status/resolver.ts`
- Create: `src/__tests__/unit/env-status-resolver.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/unit/env-status-resolver.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolveProjectStatus } from '../../agent/tools/env-status/resolver.js'

const baseDeployed = { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' }
const baseLatest = { commitId: 'full', shortId: 'a1b2c3d4', message: 'x' }

describe('resolveProjectStatus', () => {
  it('healthy when running + same commit', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'healthy' }, deployed: baseDeployed },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('healthy')
    expect(r.commitsBehind).toBe(0)
  })

  it('healthy when running + no healthcheck + same commit', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'none' }, deployed: baseDeployed },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('healthy')
  })

  it('stale when commits differ', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'healthy' }, deployed: baseDeployed },
      latest: { ...baseLatest, shortId: '99887766' },
      compare: { commitsBehind: 7, tooLarge: false, latestSummaries: [] },
      hasHistory: true,
    })
    expect(r.status).toBe('stale')
    expect(r.commitsBehind).toBe(7)
  })

  it('degraded when running but unhealthy', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'unhealthy' }, deployed: baseDeployed },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('degraded')
  })

  it('down when exited', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'exited', exitCode: 137 }, deployed: baseDeployed },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('down')
  })

  it('not_deployed when no container and no history', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: false }, deployed: null },
      latest: baseLatest,
      compare: null,
      hasHistory: false,
    })
    expect(r.status).toBe('not_deployed')
  })

  it('down when no container but history exists', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: false }, deployed: null },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('down')
  })

  it('unknown when running but tag cannot be parsed', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'none' }, deployed: null },
      latest: baseLatest,
      compare: null,
      hasHistory: true,
    })
    expect(r.status).toBe('unknown')
  })

  it('commitsBehindNote too_large when compare timed out', () => {
    const r = resolveProjectStatus({
      probe: { container: { exists: true, state: 'running', health: 'healthy' }, deployed: baseDeployed },
      latest: { ...baseLatest, shortId: '99887766' },
      compare: { commitsBehind: null, tooLarge: true, latestSummaries: [] },
      hasHistory: true,
    })
    expect(r.status).toBe('stale')
    expect(r.commitsBehind).toBeNull()
    expect(r.commitsBehindNote).toBe('too_large')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/env-status-resolver.test.ts`
Expected: FAIL — resolver module not found.

- [ ] **Step 3: 实现**

Create `src/agent/tools/env-status/resolver.ts`:
```ts
import type { DockerProbeResult } from './docker-probe.js'
import type { LatestCommit, CompareResult } from './gitlab.js'
import type { DeployedTag } from './tag-parser.js'

export type ProjectStatus = 'healthy' | 'stale' | 'degraded' | 'down' | 'not_deployed' | 'unknown'

export interface ResolvedProject {
  status: ProjectStatus
  deployed: DeployedTag | null
  latest: LatestCommit | null
  commitsBehind: number | null
  commitsBehindNote?: 'too_large' | 'compare_failed'
  latestCommitSummaries?: Array<{ shortId: string; message: string }>
}

export interface ResolveInput {
  probe: DockerProbeResult
  latest: LatestCommit | null
  compare: CompareResult | null
  hasHistory: boolean
}

export function resolveProjectStatus(input: ResolveInput): ResolvedProject {
  const { probe, latest, compare, hasHistory } = input

  // 无容器
  if (!probe.container.exists) {
    return {
      status: hasHistory ? 'down' : 'not_deployed',
      deployed: null,
      latest,
      commitsBehind: null,
    }
  }

  const state = probe.container.state

  // 容器存在但不 running
  if (state !== 'running') {
    return {
      status: 'down',
      deployed: probe.deployed,
      latest,
      commitsBehind: null,
    }
  }

  // running 但 tag 反解失败
  if (!probe.deployed) {
    return {
      status: 'unknown',
      deployed: null,
      latest,
      commitsBehind: null,
    }
  }

  // running 但健康检查不过
  if (probe.container.health === 'unhealthy' || probe.container.health === 'starting') {
    return {
      status: 'degraded',
      deployed: probe.deployed,
      latest,
      commitsBehind: compare?.commitsBehind ?? null,
      commitsBehindNote: compare?.tooLarge ? 'too_large' : undefined,
    }
  }

  // running + healthy（或无 healthcheck）
  if (!latest) {
    // GitLab 查不到 latest，无法对比，视为 healthy 不附 commitsBehind
    return {
      status: 'healthy',
      deployed: probe.deployed,
      latest: null,
      commitsBehind: null,
    }
  }

  if (probe.deployed.shortId === latest.shortId) {
    return {
      status: 'healthy',
      deployed: probe.deployed,
      latest,
      commitsBehind: 0,
    }
  }

  // stale
  return {
    status: 'stale',
    deployed: probe.deployed,
    latest,
    commitsBehind: compare?.commitsBehind ?? null,
    commitsBehindNote: compare?.tooLarge
      ? 'too_large'
      : (compare === null ? 'compare_failed' : undefined),
    latestCommitSummaries: compare?.latestSummaries,
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/unit/env-status-resolver.test.ts`
Expected: 9 passed.

- [ ] **Step 5: 提交**

```bash
git add src/agent/tools/env-status/resolver.ts src/__tests__/unit/env-status-resolver.test.ts
git commit -m "feat(env-status): project status resolver (pure function)"
```

---

## Task 10: 输出格式化器（纯函数）

**Files:**
- Create: `src/agent/tools/env-status/formatter.ts`
- Create: `src/__tests__/unit/env-status-formatter.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/unit/env-status-formatter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { formatEnvStatusOutput } from '../../agent/tools/env-status/formatter.js'
import type { ResolvedProject } from '../../agent/tools/env-status/resolver.js'

function proj(name: string, over: Partial<ResolvedProject> & { status: ResolvedProject['status'] }): {
  name: string
  displayName: string
  resolved: ResolvedProject
  container: { state?: string; startedAt?: string }
  servers: string[]
} {
  return {
    name,
    displayName: name,
    resolved: {
      deployed: null, latest: null, commitsBehind: null,
      ...over,
    } as ResolvedProject,
    container: { state: 'running', startedAt: new Date(Date.now() - 3600_000).toISOString() },
    servers: ['10.0.0.5'],
  }
}

describe('formatEnvStatusOutput', () => {
  it('renders headline with product line and branch', () => {
    const out = formatEnvStatusOutput({
      env: 'dev',
      productLine: 'paraview',
      defaultBranch: 'develop',
      projects: [],
    })
    expect(out).toContain('环境: dev')
    expect(out).toContain('产线: paraview')
    expect(out).toContain('默认分支: develop')
  })

  it('shows healthy with ✅', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('ssh-proxy', {
        status: 'healthy',
        deployed: { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' },
        latest: { commitId: '...', shortId: 'a1b2c3d4', message: 'fix' },
        commitsBehind: 0,
      })],
    })
    expect(out).toContain('ssh-proxy')
    expect(out).toContain('✅')
    expect(out).toContain('develop_a1b2c3d4')
  })

  it('shows stale with 🟡 and commits behind count', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('rdp-proxy', {
        status: 'stale',
        deployed: { branch: 'develop', shortId: '11223344', imageTag: 'develop_11223344' },
        latest: { commitId: '...', shortId: '99887766', message: 'feat' },
        commitsBehind: 7,
      })],
    })
    expect(out).toContain('🟡')
    expect(out).toContain('落后 7 个 commit')
  })

  it('appends "跨度较大" when commitsBehind >= 30', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('billing', {
        status: 'stale',
        deployed: { branch: 'develop', shortId: 'deadbeef', imageTag: 'develop_deadbeef' },
        latest: { commitId: '...', shortId: 'cafebabe', message: 'x' },
        commitsBehind: 42,
      })],
    })
    expect(out).toContain('跨度较大')
  })

  it('marks too_large compare with ⚠️ 跨度过大', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('svc', {
        status: 'stale',
        deployed: { branch: 'develop', shortId: 'aaaaaaaa', imageTag: 'develop_aaaaaaaa' },
        latest: { commitId: '...', shortId: 'bbbbbbbb', message: 'x' },
        commitsBehind: null,
        commitsBehindNote: 'too_large',
      })],
    })
    expect(out).toContain('跨度过大')
  })

  it('shows not_deployed with ⚪', () => {
    const out = formatEnvStatusOutput({
      env: 'dev', productLine: 'pl', defaultBranch: 'develop',
      projects: [proj('newsvc', { status: 'not_deployed' })],
    })
    expect(out).toContain('⚪')
    expect(out).toContain('未部署')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/env-status-formatter.test.ts`
Expected: FAIL — formatter module not found.

- [ ] **Step 3: 实现 formatter**

Create `src/agent/tools/env-status/formatter.ts`:
```ts
import type { ResolvedProject } from './resolver.js'

export interface ProjectRow {
  name: string
  displayName: string
  resolved: ResolvedProject
  container: { state?: string; startedAt?: string; exitCode?: number }
  servers: string[]
  error?: string
}

export interface FormatInput {
  env: string
  productLine: string
  defaultBranch: string
  projects: ProjectRow[]
}

const ICONS: Record<ResolvedProject['status'], string> = {
  healthy: '✅',
  stale: '🟡',
  degraded: '⚠️',
  down: '❌',
  not_deployed: '⚪',
  unknown: '❓',
}

function humanizeDuration(startedAtISO?: string): string {
  if (!startedAtISO) return '-'
  const started = Date.parse(startedAtISO)
  if (isNaN(started)) return '-'
  const sec = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h${min % 60 > 0 ? `${min % 60}m` : ''}`
  const d = Math.floor(hr / 24)
  return `${d}d${hr % 24 > 0 ? `${hr % 24}h` : ''}`
}

function renderVersionCol(p: ProjectRow): string {
  const { deployed, latest, status } = p.resolved
  if (status === 'not_deployed' || (!deployed && !latest)) return '-'
  if (!deployed) return `(未知) → ${latest?.branch ?? ''}_${latest?.shortId ?? ''}`
  if (status === 'healthy') return deployed.imageTag
  return `${deployed.imageTag} → ${latest?.branch ?? deployed.branch}_${latest?.shortId ?? '?'}`
}

function renderStatusCol(p: ProjectRow): string {
  const { status, commitsBehind, commitsBehindNote } = p.resolved
  const icon = ICONS[status]

  if (p.error) return `${icon} ${p.error}`

  switch (status) {
    case 'healthy': return `${icon} 最新`
    case 'stale': {
      if (commitsBehindNote === 'too_large') return `${icon} 落后（跨度过大）`
      if (commitsBehind === null) return `${icon} 落后（对比失败）`
      const note = commitsBehind >= 30 ? '（跨度较大）' : ''
      return `${icon} 落后 ${commitsBehind} 个 commit${note}`
    }
    case 'degraded': return `${icon} 运行但不健康`
    case 'down': {
      const code = p.container.exitCode !== undefined ? `(${p.container.exitCode})` : ''
      return `${icon} 容器异常${code}`
    }
    case 'not_deployed': return `${icon} 未部署`
    case 'unknown': return `${icon} 版本未知`
  }
}

function renderContainerCol(p: ProjectRow): string {
  const { state, startedAt } = p.container
  if (!state || state === undefined) return '-'
  if (state === 'running') return `running ${humanizeDuration(startedAt)}`
  return state
}

export function formatEnvStatusOutput(input: FormatInput): string {
  const lines: string[] = [
    `环境: ${input.env} (产线: ${input.productLine}, 默认分支: ${input.defaultBranch || '未配置'})`,
  ]
  const allServers = new Set<string>()
  input.projects.forEach(p => p.servers.forEach(s => allServers.add(s)))
  if (allServers.size > 0) {
    lines.push(`服务器: ${[...allServers].join(', ')}`)
  }
  lines.push('')

  for (const p of input.projects) {
    lines.push(`- ${p.displayName.padEnd(16)} | ${renderContainerCol(p).padEnd(14)} | ${renderVersionCol(p).padEnd(40)} | ${renderStatusCol(p)}`)
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/unit/env-status-formatter.test.ts`
Expected: 6 passed.

- [ ] **Step 5: 提交**

```bash
git add src/agent/tools/env-status/formatter.ts src/__tests__/unit/env-status-formatter.test.ts
git commit -m "feat(env-status): output formatter"
```

---

## Task 11: 主工具 check-env-status.ts 装配

**Files:**
- Create: `src/agent/tools/check-env-status.ts`
- Create: `src/__tests__/unit/check-env-status-tool.test.ts`
- Modify: `src/agent/tools/types.ts:29-40`
- Modify: `src/agent/mcp-server.ts:24`
- Modify: `src/server.ts:23`

- [ ] **Step 1: 写 tool 集成测试**

Create `src/__tests__/unit/check-env-status-tool.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/projects-repo.js', () => ({ listProjects: vi.fn() }))
vi.mock('../../db/repositories/product-lines.js', () => ({ getProductLineById: vi.fn() }))
vi.mock('../../db/repositories/environments-repo.js', () => ({ listEnvironments: vi.fn() }))
vi.mock('../../db/repositories/product-line-envs.js', () => ({ listProductLineEnvs: vi.fn() }))
vi.mock('../../db/repositories/deployments.js', () => ({ getRecentDeployments: vi.fn() }))
vi.mock('../../db/repositories/system-config.js', () => ({ getConfig: vi.fn() }))
vi.mock('../../db/repositories/test-servers.js', () => ({ getTestServerById: vi.fn() }))
vi.mock('../../agent/tools/env-status/docker-probe.js', () => ({ probeContainer: vi.fn() }))
vi.mock('../../agent/tools/env-status/gitlab.js', () => ({
  getLatestBranchCommit: vi.fn(),
  compareCommits: vi.fn(),
}))

import { listProjects } from '../../db/repositories/projects-repo.js'
import { getProductLineById } from '../../db/repositories/product-lines.js'
import { listEnvironments } from '../../db/repositories/environments-repo.js'
import { listProductLineEnvs } from '../../db/repositories/product-line-envs.js'
import { getRecentDeployments } from '../../db/repositories/deployments.js'
import { getConfig } from '../../db/repositories/system-config.js'
import { getTestServerById } from '../../db/repositories/test-servers.js'
import { probeContainer } from '../../agent/tools/env-status/docker-probe.js'
import { getLatestBranchCommit, compareCommits } from '../../agent/tools/env-status/gitlab.js'
import { checkEnvStatusTool } from '../../agent/tools/check-env-status.js'
import type { TaskContext } from '../../agent/tools/types.js'

const ctx: TaskContext = {
  taskId: 't', groupId: 'g', platform: 'dingtalk',
  initiatorId: 'u1', initiatorRole: 'ops', productLineId: 1,
}

beforeEach(() => { vi.clearAllMocks() })

describe('check_environment_status tool', () => {
  it('rejects when user not bound to product line', async () => {
    const r = await checkEnvStatusTool.execute({ env: 'dev' }, { ...ctx, productLineId: undefined })
    expect(r.success).toBe(false)
    expect(r.output).toContain('未加入任何产线')
  })

  it('rejects unknown env', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    const r = await checkEnvStatusTool.execute({ env: 'nonexistent' }, ctx)
    expect(r.success).toBe(false)
    expect(r.output).toContain('未定义')
  })

  it('rejects when env not configured for product line', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(listProductLineEnvs).mockResolvedValue([])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    const r = await checkEnvStatusTool.execute({ env: 'dev' }, ctx)
    expect(r.success).toBe(false)
    expect(r.output).toContain('未配置')
  })

  it('scans all projects and returns formatted output', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    vi.mocked(listProductLineEnvs).mockResolvedValue([{
      id: 1, productLineId: 1, envId: 1, runtime: 'docker', namespace: '', enabled: true,
      connectionConfig: { serverIds: [10] }, defaultBranch: 'develop',
    }])
    vi.mocked(getTestServerById).mockResolvedValue({
      id: 10, productLineId: 1, name: 's1', role: 'app',
      host: '10.0.0.5', port: 22, username: 'root', credential: 'x',
      createdAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getTestServerById>>)
    vi.mocked(listProjects).mockResolvedValue([{
      id: 100, productLineId: 1, name: 'svc', displayName: 'SVC',
      gitlabPath: 'g/svc', harborProject: 'p/svc',
      ownerId: '', ownerName: '',
      dockerContainerName: 'svc', k8sProjectName: '', composePath: '',
      description: '', createdAt: new Date(), updatedAt: new Date(),
    }])
    vi.mocked(getConfig).mockResolvedValue({ key: 'harbor', value: { url: 'https://harbor.example.com' }, updatedAt: new Date() } as unknown as Awaited<ReturnType<typeof getConfig>>)
    vi.mocked(getRecentDeployments).mockResolvedValue([])
    vi.mocked(probeContainer).mockResolvedValue({
      container: { exists: true, state: 'running', startedAt: new Date().toISOString(), health: 'healthy' },
      deployed: { branch: 'develop', shortId: 'a1b2c3d4', imageTag: 'develop_a1b2c3d4' },
    })
    vi.mocked(getLatestBranchCommit).mockResolvedValue({ commitId: 'full', shortId: 'a1b2c3d4', message: 'fix' })
    vi.mocked(compareCommits).mockResolvedValue({ commitsBehind: 0, tooLarge: false, latestSummaries: [] })

    const r = await checkEnvStatusTool.execute({ env: 'dev' }, ctx)
    expect(r.success).toBe(true)
    expect(r.output).toContain('SVC')
    expect(r.output).toContain('✅')
    expect(r.output).toContain('develop_a1b2c3d4')
  })

  it('filters to single project when project param given', async () => {
    vi.mocked(listEnvironments).mockResolvedValue([{ id: 1, name: 'dev', displayName: 'Dev', sortOrder: 0, createdAt: new Date() }])
    vi.mocked(getProductLineById).mockResolvedValue({ id: 1, name: 'pl', displayName: 'PL', description: '', createdAt: new Date(), updatedAt: new Date() })
    vi.mocked(listProductLineEnvs).mockResolvedValue([{
      id: 1, productLineId: 1, envId: 1, runtime: 'docker', namespace: '', enabled: true,
      connectionConfig: { serverIds: [10] }, defaultBranch: 'develop',
    }])
    vi.mocked(getTestServerById).mockResolvedValue({
      id: 10, productLineId: 1, name: 's1', role: 'app',
      host: '10.0.0.5', port: 22, username: 'root', credential: 'x',
      createdAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getTestServerById>>)
    vi.mocked(listProjects).mockResolvedValue([
      { id: 100, productLineId: 1, name: 'a', displayName: 'A', gitlabPath: 'g/a', harborProject: 'p/a', ownerId:'', ownerName:'', dockerContainerName: 'a', k8sProjectName:'', composePath:'', description:'', createdAt: new Date(), updatedAt: new Date() },
      { id: 101, productLineId: 1, name: 'b', displayName: 'B', gitlabPath: 'g/b', harborProject: 'p/b', ownerId:'', ownerName:'', dockerContainerName: 'b', k8sProjectName:'', composePath:'', description:'', createdAt: new Date(), updatedAt: new Date() },
    ])
    vi.mocked(getConfig).mockResolvedValue({ key: 'harbor', value: { url: 'https://harbor.example.com' }, updatedAt: new Date() } as unknown as Awaited<ReturnType<typeof getConfig>>)
    vi.mocked(getRecentDeployments).mockResolvedValue([])
    vi.mocked(probeContainer).mockResolvedValue({ container: { exists: false }, deployed: null })
    vi.mocked(getLatestBranchCommit).mockResolvedValue(null)
    vi.mocked(compareCommits).mockResolvedValue(null)

    const r = await checkEnvStatusTool.execute({ env: 'dev', project: 'b' }, ctx)
    expect(r.success).toBe(true)
    expect(probeContainer).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/unit/check-env-status-tool.test.ts`
Expected: FAIL — `checkEnvStatusTool` not found.

- [ ] **Step 3: 实现主工具**

Create `src/agent/tools/check-env-status.ts`:
```ts
import { registerTool } from './index.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { getProductLineById } from '../../db/repositories/product-lines.js'
import { listEnvironments } from '../../db/repositories/environments-repo.js'
import { listProductLineEnvs } from '../../db/repositories/product-line-envs.js'
import { getRecentDeployments } from '../../db/repositories/deployments.js'
import { getConfig } from '../../db/repositories/system-config.js'
import { getTestServerById } from '../../db/repositories/test-servers.js'
import { probeContainer } from './env-status/docker-probe.js'
import { getLatestBranchCommit, compareCommits } from './env-status/gitlab.js'
import { resolveProjectStatus } from './env-status/resolver.js'
import { formatEnvStatusOutput, type ProjectRow } from './env-status/formatter.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import type { SSHTarget } from './ssh-utils.js'
import { appendFileSync } from 'fs'

function log(msg: string) {
  try { appendFileSync('/tmp/mcp-server.log', `[${new Date().toISOString()}] [env-status] ${msg}\n`) } catch { /* */ }
}

async function resolveServers(serverIds: number[]): Promise<SSHTarget[]> {
  const all = await Promise.all(serverIds.map(id => getTestServerById(id)))
  return all
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map(s => ({ host: s.host, port: s.port, username: s.username, password: s.credential }))
}

function registryHostFrom(harborUrl: string): string {
  return harborUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export const checkEnvStatusTool: AgentTool = {
  name: 'check_environment_status',
  description: '检查指定环境下所有模块（或单个模块）的实时部署状态：容器运行情况、启动时长、当前部署 commit 与 GitLab 最新 commit 的差距。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      env: { type: 'string', description: '环境名，如 dev/staging/prod' },
      project: { type: 'string', description: '可选，单模块查询' },
    },
    required: ['env'],
  },
  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { env: envName, project: projectName } = params as { env: string; project?: string }
    log(`execute: env=${envName} project=${projectName ?? '*'} pl=${ctx.productLineId}`)

    if (!ctx.productLineId) {
      return { success: false, output: '⛔ 你未加入任何产线，无法查询环境状态。' }
    }

    const envs = await listEnvironments()
    const envRow = envs.find(e => e.name === envName || e.displayName === envName)
    if (!envRow) return { success: false, output: `环境 "${envName}" 未定义。` }

    const plEnvs = await listProductLineEnvs(ctx.productLineId)
    const plEnv = plEnvs.find(p => p.envId === envRow.id)
    const pl = await getProductLineById(ctx.productLineId)
    const plDisplay = pl?.displayName ?? pl?.name ?? `PL#${ctx.productLineId}`
    if (!plEnv) return { success: false, output: `产线 "${plDisplay}" 未配置 "${envName}" 环境。` }

    if (plEnv.runtime !== 'docker') {
      return { success: true, output: `环境 "${envName}" 运行时为 ${plEnv.runtime}。K8s 详细状态查询暂不支持。` }
    }

    const cfg = plEnv.connectionConfig as { serverIds?: number[] }
    const servers = await resolveServers(Array.isArray(cfg.serverIds) ? cfg.serverIds : [])
    if (servers.length === 0) {
      return { success: false, output: `环境 "${envName}" 未配置服务器，请在产线环境配置中补充。` }
    }

    const harborCfg = await getConfig('harbor')
    const harborUrl = (harborCfg?.value as Record<string, string> | undefined)?.url ?? ''
    const registryHost = registryHostFrom(harborUrl)

    const allProjects = await listProjects(ctx.productLineId)
    const scoped = projectName
      ? allProjects.filter(p => p.name === projectName || p.displayName === projectName)
      : allProjects

    if (scoped.length === 0) {
      return { success: false, output: projectName ? `模块 "${projectName}" 不在产线下。` : '当前产线下还没有模块。' }
    }

    const rows: ProjectRow[] = await Promise.all(scoped.map(async (project): Promise<ProjectRow> => {
      const containerName = project.dockerContainerName || project.name
      const harborProject = project.harborProject || project.name

      try {
        const probePromises = servers.map(s => probeContainer(s, containerName, registryHost, harborProject))
        const branchForGitLab = plEnv.defaultBranch
        const latestPromise = branchForGitLab && project.gitlabPath
          ? getLatestBranchCommit(project.gitlabPath, branchForGitLab)
          : Promise.resolve(null)
        const historyPromise = getRecentDeployments(project.name, envName, 1)

        const [probes, latest, history] = await Promise.all([Promise.all(probePromises), latestPromise, historyPromise])
        const probe = probes.find(p => p.container.exists) ?? probes[0]

        let compare: Awaited<ReturnType<typeof compareCommits>> | null = null
        if (probe.deployed && latest && probe.deployed.shortId !== latest.shortId && project.gitlabPath) {
          compare = await compareCommits(project.gitlabPath, probe.deployed.shortId, latest.shortId)
        }

        const resolved = resolveProjectStatus({ probe, latest, compare, hasHistory: history.length > 0 })
        return {
          name: project.name,
          displayName: project.displayName || project.name,
          resolved,
          container: {
            state: probe.container.state,
            startedAt: probe.container.startedAt,
            exitCode: probe.container.exitCode,
          },
          servers: servers.map(s => s.host),
          error: probe.error,
        }
      } catch (err) {
        log(`project ${project.name} error: ${String(err)}`)
        return {
          name: project.name,
          displayName: project.displayName || project.name,
          resolved: { status: 'unknown', deployed: null, latest: null, commitsBehind: null },
          container: {},
          servers: servers.map(s => s.host),
          error: String(err),
        }
      }
    }))

    const output = formatEnvStatusOutput({
      env: envName,
      productLine: plDisplay,
      defaultBranch: plEnv.defaultBranch,
      projects: rows,
    })

    return {
      success: true,
      output,
      data: {
        env: envName,
        productLine: plDisplay,
        defaultBranch: plEnv.defaultBranch,
        servers: servers.map(s => ({ host: s.host, port: s.port })),
        projects: rows.map(r => ({
          name: r.name,
          status: r.resolved.status,
          container: r.container,
          deployed: r.resolved.deployed,
          latest: r.resolved.latest,
          commitsBehind: r.resolved.commitsBehind,
          commitsBehindNote: r.resolved.commitsBehindNote,
          latestCommitSummaries: r.resolved.latestCommitSummaries,
          error: r.error,
        })),
      },
    }
  },
}

registerTool(checkEnvStatusTool)
```

- [ ] **Step 4: 在 DEFAULT_TOOL_ROLES 注册权限**

Edit `src/agent/tools/types.ts:29-40`，添加 `check_environment_status` 条目，**保留** `query_deployments`（两周观察期）：
```ts
export const DEFAULT_TOOL_ROLES: Record<string, Role[]> = {
  query_deployments: ['developer', 'tester', 'ops', 'admin'],
  check_environment_status: ['developer', 'tester', 'ops', 'admin'],
  list_images: ['developer', 'tester', 'ops', 'admin'],
  get_gitlab_commits: ['developer', 'tester', 'ops', 'admin'],
  get_logs: ['developer', 'tester', 'ops', 'admin'],
  execute_deploy: ['ops', 'admin'],
  execute_rollback: ['ops', 'admin'],
  execute_restart: ['ops', 'admin'],
  request_approval: ['developer', 'tester', 'ops', 'admin'],
  manage_role: ['admin'],
  list_product_line_projects: ['developer', 'tester', 'ops', 'admin'],
}
```

- [ ] **Step 5: 注册新工具 + 移除旧工具的 import**

Edit `src/agent/mcp-server.ts:24`，移除一行、新增一行：
```ts
// 移除：
// import './tools/query-deployments.js'
// 新增：
import './tools/check-env-status.js'
```

Edit `src/server.ts:23` 做同样改动：
```ts
// 移除：
// import './agent/tools/query-deployments.js'
// 新增：
import './agent/tools/check-env-status.js'
```

- [ ] **Step 6: 运行所有测试**

Run: `pnpm test`
Expected: 全部通过（包含新加的 4 个测试文件，共约 20 个新 case）。

- [ ] **Step 7: TS 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 8: 提交**

```bash
git add src/agent/tools/check-env-status.ts \
        src/__tests__/unit/check-env-status-tool.test.ts \
        src/agent/tools/types.ts \
        src/agent/mcp-server.ts \
        src/server.ts
git commit -m "feat(env-status): check_environment_status MCP tool + wire-up"
```

---

## Task 12: 端到端冒烟测试

**Files:** 无文件改动，仅验证

- [ ] **Step 1: 在本地数据库为 dev 环境配置 default_branch**

启动后端 `pnpm dev`，打开前端，产线详情 → 环境配置 → 给 dev 填写默认分支如 `develop`，保存。

Alternatively via SQL：
```sql
UPDATE product_line_envs SET default_branch = 'develop'
  WHERE product_line_id = 1 AND env_id = <dev env id>;
```

- [ ] **Step 2: 在 IM 群发测试消息**

在钉钉/飞书群 @chatops 机器人发送："查看 dev 环境的部署情况"

Expected:
- 后端日志：`[Runner] Intent result: {"capability":"view_deployments",...}`
- MCP 日志 `/tmp/mcp-server.log`：`[env-status] execute: env=dev ...`
- 群里回复包含每个模块一行，带状态图标与版本差距

- [ ] **Step 3: 边界验证**

a. 未配默认分支：将某产线的 dev 环境 `default_branch` 清空，再次查询。
   Expected: 输出头部"默认分支: 未配置"，各模块 status 可能为 `healthy`（无 latest 对比）或其他原生状态。

b. 单模块：群里发送"查看 dev 下 ssh-proxy 的状态"。
   Expected: 仅返回一行。

c. 未绑定产线：用未分配产线的账号发送同样请求。
   Expected: 收到"⛔ 你未加入任何产线..."。

- [ ] **Step 4: 若发现 bug 修复后追加提交**

若任一步未达预期，回查日志并修复。每个修复都一个独立 commit。

- [ ] **Step 5: 合并到 main**

```bash
git log --oneline main..HEAD
# 列出本次所有提交
git push -u origin worktree-jazzy-chasing-spring
gh pr create --title "feat: view_deployments 改为实时环境巡检" --body "见 docs/superpowers/specs/2026-04-18-view-deployments-realtime-status-design.md"
```

(注：worktree 内的分支名按实际 git 分支。)

---

## Task 13: 两周观察期后清理旧工具

**Files:**
- Delete: `src/agent/tools/query-deployments.ts`
- Modify: `src/agent/tools/types.ts` （移除 query_deployments 项）

**触发时机**：本次改动上线后满 14 天，新工具运行稳定。此 Task 单独成 PR，不与主 PR 合并。

- [ ] **Step 1: 确认生产数据库中 view_deployments 的 tool_names 已是 check_environment_status**

```sql
SELECT key, tool_names FROM capabilities WHERE key='view_deployments';
```
Expected: `["check_environment_status"]`

- [ ] **Step 2: 删除旧文件 + 从 DEFAULT_TOOL_ROLES 移除**

```bash
rm src/agent/tools/query-deployments.ts
```

Edit `src/agent/tools/types.ts`：移除 `query_deployments: [...]` 那一行。

- [ ] **Step 3: 运行测试 + 类型检查**

```bash
pnpm test && npx tsc --noEmit -p tsconfig.json
```
Expected: 0 errors.

- [ ] **Step 4: 提交**

```bash
git add -u
git commit -m "chore(env-status): remove deprecated query_deployments tool after 2-week soak"
```

---

## Self-Review 结果

对照 spec 每个章节：
- §3.1 分支来源（product_line_envs.default_branch）→ Task 1/2/3/4/5 覆盖
- §3.2 能力映射（tool 新建、capability 重指）→ Task 1 SQL + Task 11 注册
- §4.1 工具签名 → Task 11 inputSchema
- §4.2 数据流 → Task 11 execute
- §4.3 状态判定 → Task 9 resolver
- §4.4 commit 落后统计 → Task 7 compareCommits + Task 9 resolver + Task 10 formatter
- §4.5 多服务器 → Task 11 `resolveServers` + `Promise.all(probePromises)`
- §4.6 K8s 降级 → Task 11 runtime 判断
- §4.7 tag 反解 → Task 6 tag-parser
- §5 输出契约 → Task 10 formatter + Task 11 返回 data
- §6 错误处理 → Task 8 docker-probe error 字段 + Task 9 resolver 分支 + Task 7 GitLab catch 返 null
- §7 并发超时 → Task 8 sshExec timer + Task 7 axios timeout + Task 11 Promise.all
- §8 Schema v9 → 实际为 v10（schema-v9 已占用，文首已注明）
- §9 影响面 → 全覆盖
- §10 回滚 → Task 13 的触发条件即是"稳定 2 周后"
- §11 非目标 → 本 plan 均未涉及

占位符扫描：无 TBD/TODO；每个代码步骤附完整实现；测试代码完整。

类型一致性：所有文件使用一致的导出名（`checkEnvStatusTool`, `probeContainer`, `resolveProjectStatus`, `formatEnvStatusOutput`, `parseImageTag`, `findDeployedTag`, `getLatestBranchCommit`, `compareCommits`）。

Scope：13 个 task，每个独立可提交，单文件集中修改，符合 DRY/YAGNI/TDD。
