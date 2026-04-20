# 流水线制品输入选择 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 pipeline 配置中声明 artifactInputs，触发时由 Agent 对话选包（或按 default / defaultStrategy 自动解析），选中值注入 runtime var 供脚本使用。

**Architecture:** 在 `test_pipelines.artifact_inputs` JSONB 里内联声明输入需求；新增 `src/pipeline/artifact-resolver.ts` 作为人工/定时共用解析器；`runPipeline` 接收 `runtimeVars`，解析所有 artifactInputs 后合并进 `{{vars.*}}` 模板变量。Agent 侧新增两个 MCP 工具：`list_artifacts` / `get_pipeline_artifact_inputs`。

**Tech Stack:** Node.js + TypeScript + Fastify + pg + Vitest；前端 React 18 + Ant Design 5。

---

## 文件结构

**新增**
- `src/db/schema-v10.sql` — 新增两列
- `src/pipeline/glob-match.ts` — 轻量 glob → RegExp 工具
- `src/pipeline/artifact-resolver.ts` — `listArtifacts` / `resolveArtifact`
- `src/admin/routes/artifacts.ts` — POST /admin/artifacts/list
- `src/agent/tools/list-artifacts.ts` — MCP 工具
- `src/agent/tools/get-pipeline-artifact-inputs.ts` — MCP 工具
- `src/__tests__/unit/glob-match.test.ts`
- `src/__tests__/unit/artifact-resolver.test.ts`
- `src/__tests__/unit/list-artifacts-tool.test.ts`
- `src/__tests__/unit/get-pipeline-artifact-inputs-tool.test.ts`
- `src/__tests__/unit/pipeline-artifact-validation.test.ts`

**修改**
- `src/db/migrate.ts` — 加载 v10
- `src/pipeline/types.ts` — `ArtifactInput` 接口
- `src/db/repositories/test-pipelines.ts` — `artifactInputs` 列读写
- `src/db/repositories/test-runs.ts` — `runtimeVars` 列读写 + `createTestRun` 入参
- `src/pipeline/executor.ts` — `runPipeline` 接收 `runtimeVars`，触发前解析 artifactInputs
- `src/admin/routes/pipelines.ts` — 保存时校验 default/defaultStrategy
- `src/admin/routes/test-runs.ts` — `POST /test-runs` 接收 `runtimeVars`
- `src/admin/index.ts` — 注册 artifacts 路由
- `src/pipeline/scheduler.ts` — 定时触发调用新签名
- `src/agent/tools/autotest.ts` — 若存在 pipeline 触发工具调用点，传递 `runtimeVars`
- `src/agent/tools/types.ts` — `DEFAULT_TOOL_ROLES` 加两项
- `src/agent/tools/index.ts` — 若是按需 import，加新工具
- `src/server.ts` / `src/agent/mcp-server.ts` — import 新工具
- `web/src/api/pipelines.ts` — artifactInputs 字段 + runtimeVars 参数
- `web/src/api/artifacts.ts` **新增** — 列出工具
- `web/src/pages/Pipelines/...` — 编辑器新增"制品输入"分节 + 手动运行对话框接收 runtimeVars

---

## Task 1 · 数据库 schema v10

**Files:**
- Create: `src/db/schema-v10.sql`
- Modify: `src/db/migrate.ts`

- [ ] **Step 1: 创建 schema-v10.sql**

```sql
-- schema-v10.sql: artifact inputs for pipelines + runtime vars record
ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS artifact_inputs JSONB NOT NULL DEFAULT '[]';

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS runtime_vars JSONB NOT NULL DEFAULT '{}';
```

- [ ] **Step 2: 追加到 migrate.ts**

在 `src/db/migrate.ts` 末尾 `await pool.end()` 之前追加：

```ts
const schemaV10 = readFileSync(join(__dirname, 'schema-v10.sql'), 'utf8')
await pool.query(schemaV10)
```

并把最后的日志字符串改为 `'✅ Database schema applied (v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9 + v10)'`。

- [ ] **Step 3: 运行 migrate 验证**

```bash
pnpm migrate
```

预期：输出含 `v10`；无错误。

- [ ] **Step 4: 验证列确实创建**

```bash
psql "$DATABASE_URL" -c "\d test_pipelines" | grep artifact_inputs
psql "$DATABASE_URL" -c "\d test_runs" | grep runtime_vars
```

预期：各输出一行 `jsonb` 类型列。

- [ ] **Step 5: 提交**

```bash
git add src/db/schema-v10.sql src/db/migrate.ts
git commit -m "db(schema): 新增 artifact_inputs 与 runtime_vars 列"
```

---

## Task 2 · ArtifactInput 类型定义

**Files:**
- Modify: `src/pipeline/types.ts`

- [ ] **Step 1: 在 types.ts 末尾追加接口**

```ts
export interface ArtifactInput {
  name: string
  listUrl: string
  glob: string
  outputVar: string
  valueFrom: 'url' | 'name' | 'path'
  default?: string
  defaultStrategy?: 'latest-by-mtime' | 'first-match'
  authHeaders?: Record<string, string>
}
```

- [ ] **Step 2: TS 编译验证**

```bash
pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: 提交**

```bash
git add src/pipeline/types.ts
git commit -m "types: 新增 ArtifactInput 接口"
```

---

## Task 3 · test-pipelines 仓库扩展

**Files:**
- Modify: `src/db/repositories/test-pipelines.ts`

- [ ] **Step 1: 扩展 TestPipeline 接口**

在 `TestPipeline` 接口里 `variables` 之后新增一行：

```ts
  artifactInputs: unknown[]
```

（用 `unknown[]` 保留扩展性；消费侧按 `ArtifactInput[]` 断言使用。）

- [ ] **Step 2: 更新 mapRow**

在 `mapRow` 的返回对象中加入：

```ts
artifactInputs: (r.artifact_inputs ?? []) as unknown[],
```

- [ ] **Step 3: 扩展 create/update 签名和 SQL**

`createTestPipeline` 入参类型加：

```ts
artifactInputs?: unknown[]
```

INSERT SQL 加 `artifact_inputs` 列与参数：

```ts
const { rows } = await pool.query(
  `INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, schedule, enabled, trigger_params, variables, artifact_inputs)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [data.productLineId, data.name, data.description ?? '', JSON.stringify(data.stages),
   JSON.stringify(data.serverRoles), data.schedule ?? '', data.enabled ?? true,
   JSON.stringify(data.triggerParams ?? {}), JSON.stringify(data.variables ?? {}),
   JSON.stringify(data.artifactInputs ?? [])]
)
```

`updateTestPipeline` 入参和 UPDATE 加一列：

```ts
// Partial type 加一行
artifactInputs: unknown[]

// SQL 新增 artifact_inputs = COALESCE($10, artifact_inputs)
// 参数列表新增 data.artifactInputs ? JSON.stringify(data.artifactInputs) : null
```

- [ ] **Step 4: TS 编译验证**

```bash
pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 5: 单元测试（扩展 repositories.test.ts）**

读 `src/__tests__/unit/repositories.test.ts` 找到 `test-pipelines` 相关的 describe 块；若没有则跳过。若有，在 create+update 用例里追加 `artifactInputs` 字段验证往返：

```ts
const created = await createTestPipeline({ /* ...其它现有字段... */, artifactInputs: [{
  name: 't', listUrl: 'http://x/y', glob: '*.tar.gz', outputVar: 'P', valueFrom: 'url',
}]})
expect(created.artifactInputs).toHaveLength(1)
```

若该文件不存在对应 describe（本项目中可能没有 DB 集成测试），跳过此 step。

- [ ] **Step 6: 运行测试**

```bash
pnpm test
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/db/repositories/test-pipelines.ts src/__tests__/unit/repositories.test.ts
git commit -m "repo(test-pipelines): 读写 artifact_inputs 列"
```

---

## Task 4 · test-runs 仓库扩展（runtimeVars）

**Files:**
- Modify: `src/db/repositories/test-runs.ts`

- [ ] **Step 1: 扩展 TestRun 接口**

在 `TestRun` 接口最后追加：

```ts
  runtimeVars: Record<string, string>
```

- [ ] **Step 2: 更新 mapRow**

```ts
runtimeVars: (r.runtime_vars ?? {}) as Record<string, string>,
```

- [ ] **Step 3: 更新 createTestRun 签名与 SQL**

```ts
export async function createTestRun(data: {
  pipelineId: number; triggerType: TestRun['triggerType']; triggeredBy: string
  servers: Record<string, string[]>
  runtimeVars?: Record<string, string>
}): Promise<TestRun> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, servers, runtime_vars, status, started_at)
     VALUES ($1,$2,$3,$4,$5,'running',NOW()) RETURNING *`,
    [data.pipelineId, data.triggerType, data.triggeredBy,
     JSON.stringify(data.servers), JSON.stringify(data.runtimeVars ?? {})]
  )
  return mapRow(rows[0])
}
```

- [ ] **Step 4: 编译验证**

```bash
pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 5: 提交**

```bash
git add src/db/repositories/test-runs.ts
git commit -m "repo(test-runs): 持久化 runtime_vars"
```

---

## Task 5 · glob → RegExp 工具（TDD）

**Files:**
- Create: `src/pipeline/glob-match.ts`
- Test: `src/__tests__/unit/glob-match.test.ts`

- [ ] **Step 1: 写测试**

```ts
// src/__tests__/unit/glob-match.test.ts
import { describe, it, expect } from 'vitest'
import { globMatch } from '../../pipeline/glob-match.js'

describe('globMatch', () => {
  it('matches simple suffix pattern', () => {
    expect(globMatch('PAM-Docker-develop.tar.gz', 'PAM-Docker-develop*.tar.gz')).toBe(true)
  })
  it('matches with multiple stars', () => {
    expect(globMatch('PAM-Docker-6.7.0.10.tar.gz', 'PAM-*.tar.gz')).toBe(true)
  })
  it('rejects non-matching name', () => {
    expect(globMatch('other.tar.gz', 'PAM-*.tar.gz')).toBe(false)
  })
  it('? matches single char', () => {
    expect(globMatch('a1b', 'a?b')).toBe(true)
    expect(globMatch('a12b', 'a?b')).toBe(false)
  })
  it('escapes regex special chars in glob (dot)', () => {
    expect(globMatch('file.tar.gz', 'file.tar.gz')).toBe(true)
    expect(globMatch('fileXtar.gz', 'file.tar.gz')).toBe(false)
  })
  it('empty glob matches everything', () => {
    expect(globMatch('any', '')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/glob-match.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 glob-match.ts**

```ts
// src/pipeline/glob-match.ts
export function globMatch(name: string, glob: string): boolean {
  if (!glob) return true
  const pattern = '^' + glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // escape regex specials except * ?
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$'
  return new RegExp(pattern).test(name)
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/unit/glob-match.test.ts
```

预期：全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/glob-match.ts src/__tests__/unit/glob-match.test.ts
git commit -m "pipeline: 新增 globMatch 工具 + 测试"
```

---

## Task 6 · artifact-resolver 模块（TDD）

**Files:**
- Create: `src/pipeline/artifact-resolver.ts`
- Test: `src/__tests__/unit/artifact-resolver.test.ts`

- [ ] **Step 1: 写测试**

```ts
// src/__tests__/unit/artifact-resolver.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listArtifacts, resolveArtifact } from '../../pipeline/artifact-resolver.js'
import type { ArtifactInput } from '../../pipeline/types.js'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const SAMPLE = {
  files: [
    { name: 'PAM-Docker-develop.tar.gz', path: 'pam/deploy/PAM-Docker-develop.tar.gz', type: 'file', size: 100, mtime: 3000 },
    { name: 'PAM-Docker-6.7.0.10.tar.gz', path: 'pam/deploy/PAM-Docker-6.7.0.10.tar.gz', type: 'file', size: 200, mtime: 2000 },
    { name: 'PAM-Docker-dir',             path: 'pam/deploy/PAM-Docker-dir',             type: 'dir',  size: 0,   mtime: 1000 },
    { name: 'other.txt',                  path: 'pam/deploy/other.txt',                  type: 'file', size: 50,  mtime: 500 },
  ],
}

function mockOk(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body })
}

describe('listArtifacts', () => {
  it('fetches listUrl?json=true and filters by glob, excludes dirs', async () => {
    mockOk(SAMPLE)
    const files = await listArtifacts({
      listUrl: 'http://repo/pam/deploy',
      glob: 'PAM-Docker-*.tar.gz',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://repo/pam/deploy?json=true',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(files.map(f => f.name)).toEqual([
      'PAM-Docker-develop.tar.gz',
      'PAM-Docker-6.7.0.10.tar.gz',
    ])
  })

  it('builds downloadUrl from listUrl origin + path', async () => {
    mockOk(SAMPLE)
    const files = await listArtifacts({ listUrl: 'http://repo/pam/deploy', glob: '*.tar.gz' })
    expect(files[0].downloadUrl).toBe('http://repo/pam/deploy/PAM-Docker-develop.tar.gz')
  })

  it('sorts by mtime desc', async () => {
    mockOk(SAMPLE)
    const files = await listArtifacts({ listUrl: 'http://repo/pam/deploy', glob: '*.tar.gz' })
    expect(files[0].mtime).toBeGreaterThan(files[1].mtime)
  })

  it('throws ARTIFACT_REPO_UNREACHABLE on network error', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    await expect(
      listArtifacts({ listUrl: 'http://repo/pam/deploy', glob: '*' }),
    ).rejects.toThrow(/ARTIFACT_REPO_UNREACHABLE/)
  })

  it('throws ARTIFACT_REPO_UNREACHABLE on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    await expect(
      listArtifacts({ listUrl: 'http://repo', glob: '*' }),
    ).rejects.toThrow(/ARTIFACT_REPO_UNREACHABLE/)
  })
})

describe('resolveArtifact', () => {
  const base: ArtifactInput = {
    name: 't', listUrl: 'http://repo/pam/deploy',
    glob: 'PAM-Docker-*.tar.gz', outputVar: 'PACKAGE_URL', valueFrom: 'url',
  }

  it('uses providedRuntimeVar when given', async () => {
    const v = await resolveArtifact(base, 'http://override')
    expect(v).toBe('http://override')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses default when no runtimeVar', async () => {
    const v = await resolveArtifact({ ...base, default: 'http://defaulted' }, undefined)
    expect(v).toBe('http://defaulted')
  })

  it('defaultStrategy latest-by-mtime picks newest', async () => {
    mockOk(SAMPLE)
    const v = await resolveArtifact({ ...base, defaultStrategy: 'latest-by-mtime' }, undefined)
    expect(v).toBe('http://repo/pam/deploy/PAM-Docker-develop.tar.gz')
  })

  it('defaultStrategy first-match picks lex-sorted first', async () => {
    mockOk(SAMPLE)
    const v = await resolveArtifact({ ...base, defaultStrategy: 'first-match' }, undefined)
    // 字典序 '6'(0x36) < 'd'(0x64)，所以 6.7.0.10 版本先
    expect(v).toBe('http://repo/pam/deploy/PAM-Docker-6.7.0.10.tar.gz')
  })

  it('valueFrom=name returns file name', async () => {
    mockOk(SAMPLE)
    const v = await resolveArtifact(
      { ...base, valueFrom: 'name', defaultStrategy: 'latest-by-mtime' },
      undefined,
    )
    expect(v).toBe('PAM-Docker-develop.tar.gz')
  })

  it('throws ARTIFACT_INPUT_UNRESOLVED when no runtimeVar / default / strategy', async () => {
    await expect(resolveArtifact(base, undefined)).rejects.toThrow(/ARTIFACT_INPUT_UNRESOLVED/)
  })

  it('strategy finds nothing → ARTIFACT_NO_MATCH', async () => {
    mockOk({ files: [{ name: 'other.txt', path: 'x', type: 'file', size: 1, mtime: 1 }] })
    await expect(
      resolveArtifact({ ...base, defaultStrategy: 'latest-by-mtime' }, undefined),
    ).rejects.toThrow(/ARTIFACT_NO_MATCH/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/__tests__/unit/artifact-resolver.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 artifact-resolver.ts**

```ts
// src/pipeline/artifact-resolver.ts
import { globMatch } from './glob-match.js'
import type { ArtifactInput } from './types.js'

export interface ArtifactFile {
  name: string
  path: string
  size: number
  mtime: number
  downloadUrl: string
}

interface RemoteFileEntry {
  name: string
  path: string
  type: string
  size: number
  mtime: number
}

interface RemoteListResponse {
  files?: RemoteFileEntry[]
}

function buildDownloadUrl(listUrl: string, path: string): string {
  const base = new URL(listUrl)
  return `${base.origin}/${path.replace(/^\//, '')}`
}

export async function listArtifacts(
  input: Pick<ArtifactInput, 'listUrl' | 'glob' | 'authHeaders'>,
): Promise<ArtifactFile[]> {
  const url = `${input.listUrl}${input.listUrl.includes('?') ? '&' : '?'}json=true`
  const headers: Record<string, string> = { Accept: 'application/json', ...(input.authHeaders ?? {}) }

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (e) {
    throw new Error(`ARTIFACT_REPO_UNREACHABLE: ${input.listUrl} — ${(e as Error).message}`)
  }
  if (!res.ok) {
    throw new Error(`ARTIFACT_REPO_UNREACHABLE: ${input.listUrl} — HTTP ${res.status}`)
  }
  const body = (await res.json()) as RemoteListResponse
  const files = body.files ?? []

  return files
    .filter(f => f.type === 'file')
    .filter(f => globMatch(f.name, input.glob))
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => ({
      name: f.name, path: f.path, size: f.size, mtime: f.mtime,
      downloadUrl: buildDownloadUrl(input.listUrl, f.path),
    }))
}

function extract(file: ArtifactFile, valueFrom: ArtifactInput['valueFrom']): string {
  switch (valueFrom) {
    case 'name': return file.name
    case 'path': return file.path
    case 'url':
    default:     return file.downloadUrl
  }
}

export async function resolveArtifact(
  input: ArtifactInput,
  providedRuntimeVar: string | undefined,
): Promise<string> {
  if (providedRuntimeVar !== undefined && providedRuntimeVar !== '') return providedRuntimeVar
  if (input.default) return input.default
  if (!input.defaultStrategy) {
    throw new Error(`ARTIFACT_INPUT_UNRESOLVED: ${input.outputVar} (无 runtimeVar / default / defaultStrategy)`)
  }

  const all = await listArtifacts(input)
  if (all.length === 0) {
    throw new Error(`ARTIFACT_NO_MATCH: ${input.outputVar} glob=${input.glob}`)
  }

  if (input.defaultStrategy === 'first-match') {
    const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name))
    return extract(sorted[0], input.valueFrom)
  }
  // latest-by-mtime：listArtifacts 已按 mtime desc 排序
  return extract(all[0], input.valueFrom)
}
```

> **注**：`first-match` 语义固定为"按文件名字典序第一个"（确定性），避免依赖远端返回顺序。对 `PAM-Docker-6.7.0.10.tar.gz` 与 `PAM-Docker-develop.tar.gz`，字典序上 `6`(0x36) < `d`(0x64)，故 `6.7.0.10` 版本先。测试期望值即按此写。

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/unit/artifact-resolver.test.ts
```

预期：全部通过。若 first-match 期望值与实现不一致，调整**测试期望**以匹配"字典序第一"语义（实现以此为准）。

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/artifact-resolver.ts src/__tests__/unit/artifact-resolver.test.ts
git commit -m "pipeline: 新增 artifact-resolver (listArtifacts / resolveArtifact)"
```

---

## Task 7 · executor 接收 runtimeVars 并解析 artifactInputs

**Files:**
- Modify: `src/pipeline/executor.ts`
- Modify: `src/pipeline/scheduler.ts`
- Modify: `src/admin/routes/test-runs.ts`
- Modify: `src/agent/tools/autotest.ts`

- [ ] **Step 1: 修改 runPipeline 签名**

在 `src/pipeline/executor.ts` 改 `runPipeline`：

```ts
import { resolveArtifact } from './artifact-resolver.js'
import type { ArtifactInput } from './types.js'

export async function runPipeline(
  pipelineId: number,
  serverAssignment: Record<string, string[]>,
  triggerType: 'manual' | 'api' | 'scheduled',
  triggeredBy: string,
  runtimeVarsInput: Record<string, string> = {},
  onComplete?: (result: PipelineRunResult) => void
): Promise<number> {
  // ...
```

（新增参数在 `triggeredBy` 与 `onComplete` 之间以尽量少的破坏性修改适配所有调用点。）

- [ ] **Step 2: 解析 artifactInputs → 合并到 runtimeVars**

在 `const pipeline = ...` 之后、`createTestRun` 之前加：

```ts
const artifactInputs = (pipeline.artifactInputs ?? []) as ArtifactInput[]
const runtimeVars: Record<string, string> = { ...runtimeVarsInput }
for (const input of artifactInputs) {
  const provided = runtimeVars[input.outputVar]
  const value = await resolveArtifact(input, provided)
  runtimeVars[input.outputVar] = value
}
```

- [ ] **Step 3: createTestRun 传入 runtimeVars**

把现有的：

```ts
const run = await createTestRun({ pipelineId, triggerType, triggeredBy, servers: serverAssignment })
```

改为：

```ts
const run = await createTestRun({ pipelineId, triggerType, triggeredBy, servers: serverAssignment, runtimeVars })
```

- [ ] **Step 4: stage context 合并变量**

找到所有 `variables: pipeline.variables ?? {},` 那一行，改为：

```ts
variables: { ...(pipeline.variables ?? {}), ...runtimeVars },
```

（executor.ts 里大约第 190 行，approval 分支本来就不读 vars 可忽略。）

- [ ] **Step 5: 更新调用点**

`src/pipeline/scheduler.ts` 第 29 行：

```ts
await runPipeline(pipeline.id, assignment, 'scheduled', 'scheduler')
```

保持不变（第 5 个参数省略，使用默认 `{}`）—— artifact inputs 将通过 default/defaultStrategy 解析，无需 scheduler 传值。

`src/admin/routes/test-runs.ts` 第 59 行会在 Task 8 改，这里先保持不变。

`src/agent/tools/autotest.ts` 第 76 行的 `runPipeline` 调用——Agent 通过它触发时需能注入 runtimeVars。打开文件找到工具的 `inputSchema` 与 `execute`：

- 在 `inputSchema.properties` 里增加：

```ts
runtimeVars: {
  type: 'object',
  description: '运行时变量覆盖（对应 pipeline.artifactInputs 的 outputVar）',
  additionalProperties: { type: 'string' },
},
```

- 在 `execute` 中从 `params` 取 `runtimeVars` 并传入：

```ts
const runtimeVars = (params as { runtimeVars?: Record<string, string> }).runtimeVars ?? {}
// ...既有 runPipeline 调用处
const id = await runPipeline(pipelineId, serverMap, 'manual', ctx.initiatorId, runtimeVars, (result) => { /*...*/ })
```

（若该工具触发 pipeline 的调用点与本描述略有出入，按实际文件结构对齐；关键是把 `runtimeVars` 作为第 5 个参数传给 `runPipeline`。）

- [ ] **Step 6: TS 编译 + 测试**

```bash
pnpm tsc --noEmit
pnpm test
```

预期：编译通过，测试全通过。

- [ ] **Step 7: 提交**

```bash
git add src/pipeline/executor.ts
git commit -m "pipeline(executor): 接收 runtimeVars 并解析 artifactInputs"
```

---

## Task 8 · 保存期校验 + 触发接口 runtimeVars（TDD）

**Files:**
- Modify: `src/admin/routes/pipelines.ts`
- Modify: `src/admin/routes/test-runs.ts`
- Create: `src/__tests__/unit/pipeline-artifact-validation.test.ts`

- [ ] **Step 1: 写校验测试**

```ts
// src/__tests__/unit/pipeline-artifact-validation.test.ts
import { describe, it, expect } from 'vitest'
import { validateArtifactInputsForTrigger } from '../../admin/routes/pipelines.js'
import type { ArtifactInput } from '../../pipeline/types.js'

function input(partial: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    name: 't', listUrl: 'http://x', glob: '*', outputVar: 'P', valueFrom: 'url',
    ...partial,
  }
}

describe('validateArtifactInputsForTrigger', () => {
  const scheduled = { schedule: '0 * * * *', triggerParams: {} }

  it('passes when no artifactInputs', () => {
    expect(() => validateArtifactInputsForTrigger([], scheduled)).not.toThrow()
  })

  it('passes when pipeline is manual-only (no schedule, no API trigger)', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input()],
      { schedule: '', triggerParams: {} },
    )).not.toThrow()
  })

  it('requires default or defaultStrategy when scheduled', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input()],
      scheduled,
    )).toThrow(/default|defaultStrategy/)
  })

  it('accepts default present', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input({ default: 'http://x' })],
      scheduled,
    )).not.toThrow()
  })

  it('accepts defaultStrategy present', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input({ defaultStrategy: 'latest-by-mtime' })],
      scheduled,
    )).not.toThrow()
  })

  it('error message names the offending input', () => {
    expect(() => validateArtifactInputsForTrigger(
      [input({ name: '选 PAM 包' })],
      scheduled,
    )).toThrow(/选 PAM 包/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/__tests__/unit/pipeline-artifact-validation.test.ts
```

预期：FAIL（函数未导出）。

- [ ] **Step 3: 在 pipelines.ts 实现校验函数并导出**

在 `src/admin/routes/pipelines.ts` 的 `export async function registerPipelineRoutes` **外层**加：

```ts
import type { ArtifactInput } from '../../pipeline/types.js'

export function validateArtifactInputsForTrigger(
  inputs: ArtifactInput[],
  pipeline: { schedule?: string; triggerParams?: Record<string, unknown> },
): void {
  const scheduled = !!pipeline.schedule
  const apiTriggerEnabled = !!(pipeline.triggerParams && pipeline.triggerParams.apiEnabled)
  if (!scheduled && !apiTriggerEnabled) return
  for (const input of inputs) {
    const hasDefault = !!input.default || !!input.defaultStrategy
    if (!hasDefault) {
      throw new Error(
        `制品输入「${input.name}」缺少 default 或 defaultStrategy，定时/API 触发无法自动解析`,
      )
    }
  }
}
```

> 若实际 `triggerParams` 字段不是 `apiEnabled`，读 `src/admin/routes/pipelines.ts` 既有代码确认字段名，按实际情况调整。

- [ ] **Step 4: 在 PUT pipeline 路由内调用**

在 `PUT /pipelines/:id` 路由处理中，保存前调用：

```ts
const inputs = (body.artifactInputs ?? []) as ArtifactInput[]
try {
  validateArtifactInputsForTrigger(inputs, {
    schedule: body.schedule,
    triggerParams: body.triggerParams,
  })
} catch (e) {
  return reply.status(400).send({ error: (e as Error).message })
}
```

同时确保 PUT 把 `artifactInputs` 传给 `updateTestPipeline`。

- [ ] **Step 5: POST /test-runs 接收 runtimeVars**

修改 `src/admin/routes/test-runs.ts` 第 48-61 行路由：

```ts
app.post<{ Body: {
  pipelineId: number
  servers: Record<string, string[]>
  triggeredBy?: string
  runtimeVars?: Record<string, string>
} }>('/test-runs', async (req, reply) => {
  const { pipelineId, servers, triggeredBy, runtimeVars } = req.body
  if (!pipelineId || !servers) {
    return reply.status(400).send({ error: 'pipelineId and servers required' })
  }
  try {
    const runId = await runPipeline(pipelineId, servers, 'api', triggeredBy ?? 'api', runtimeVars ?? {})
    return reply.status(201).send({ runId, message: 'Pipeline started' })
  } catch (e) {
    return reply.status(400).send({ error: (e as Error).message })
  }
})
```

- [ ] **Step 6: 运行所有测试**

```bash
pnpm test
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/admin/routes/pipelines.ts src/admin/routes/test-runs.ts src/__tests__/unit/pipeline-artifact-validation.test.ts
git commit -m "admin: 保存时校验 artifactInputs 默认值 + POST /test-runs 接收 runtimeVars"
```

---

## Task 9 · 新增 `/admin/artifacts/list` 路由

**Files:**
- Create: `src/admin/routes/artifacts.ts`
- Modify: `src/admin/index.ts`

- [ ] **Step 1: 新建路由文件**

```ts
// src/admin/routes/artifacts.ts
import type { FastifyInstance } from 'fastify'
import { listArtifacts } from '../../pipeline/artifact-resolver.js'

export async function registerArtifactRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: {
    listUrl: string
    glob?: string
    authHeaders?: Record<string, string>
  } }>('/artifacts/list', async (req, reply) => {
    const { listUrl, glob, authHeaders } = req.body
    if (!listUrl) return reply.status(400).send({ error: 'listUrl required' })
    try {
      const files = await listArtifacts({ listUrl, glob: glob ?? '', authHeaders })
      return reply.send({ files })
    } catch (e) {
      return reply.status(502).send({ error: (e as Error).message })
    }
  })
}
```

- [ ] **Step 2: 注册路由**

在 `src/admin/index.ts` 找到其它 `registerXxxRoutes` 调用，紧邻处追加：

```ts
import { registerArtifactRoutes } from './routes/artifacts.js'
// ...
await registerArtifactRoutes(app)
```

若现有模式是 `app.register(...)`，对齐写法。

- [ ] **Step 3: 冒烟测试**

启动后端：

```bash
pnpm dev
```

另一窗口：

```bash
curl -s -X POST http://localhost:3000/admin/artifacts/list \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <你的 admin cookie>' \
  -d '{"listUrl":"http://10.10.2.234:8000/pam/deploy","glob":"PAM-Docker-*.tar.gz"}' | head -c 500
```

预期：JSON 响应，`files` 数组含若干条目。

- [ ] **Step 4: 提交**

```bash
git add src/admin/routes/artifacts.ts src/admin/index.ts
git commit -m "admin: 新增 POST /admin/artifacts/list 路由"
```

---

## Task 10 · MCP 工具 `list_artifacts`（TDD）

**Files:**
- Create: `src/agent/tools/list-artifacts.ts`
- Create: `src/__tests__/unit/list-artifacts-tool.test.ts`
- Modify: `src/agent/tools/types.ts`
- Modify: `src/server.ts`
- Modify: `src/agent/mcp-server.ts`

- [ ] **Step 1: 写测试**

```ts
// src/__tests__/unit/list-artifacts-tool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../pipeline/artifact-resolver.js', () => ({
  listArtifacts: vi.fn(),
}))

import { listArtifacts } from '../../pipeline/artifact-resolver.js'
import { listArtifactsTool } from '../../agent/tools/list-artifacts.js'
import type { TaskContext } from '../../agent/tools/types.js'

const mockList = vi.mocked(listArtifacts)

const ctx: TaskContext = {
  taskId: 't1', groupId: 'g1', platform: 'dingtalk',
  initiatorId: 'u1', initiatorRole: 'developer',
}

beforeEach(() => mockList.mockReset())

describe('list_artifacts tool', () => {
  it('returns top-10 files in markdown numbered list', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      name: `F${i}.tar.gz`, path: `p/F${i}.tar.gz`, size: 100, mtime: 1000 - i,
      downloadUrl: `http://x/F${i}.tar.gz`,
    }))
    mockList.mockResolvedValue(files)
    const res = await listArtifactsTool.execute(
      { listUrl: 'http://x', glob: '*.tar.gz' },
      ctx,
    )
    expect(res.success).toBe(true)
    expect(res.output).toMatch(/1\..*F0\.tar\.gz/)
    expect(res.output).toMatch(/10\..*F9\.tar\.gz/)
    expect(res.output).not.toMatch(/11\./)   // 截断
    expect(res.output).toMatch(/还有\s*2\s*个/)
    expect(res.data).toHaveProperty('truncated', true)
  })

  it('empty match returns friendly hint', async () => {
    mockList.mockResolvedValue([])
    const res = await listArtifactsTool.execute(
      { listUrl: 'http://x', glob: '*.foo' },
      ctx,
    )
    expect(res.success).toBe(true)
    expect(res.output).toContain('没有匹配')
  })

  it('propagates repo errors as success=false', async () => {
    mockList.mockRejectedValue(new Error('ARTIFACT_REPO_UNREACHABLE: http://x'))
    const res = await listArtifactsTool.execute(
      { listUrl: 'http://x', glob: '*' },
      ctx,
    )
    expect(res.success).toBe(false)
    expect(res.output).toContain('ARTIFACT_REPO_UNREACHABLE')
  })

  it('rejects missing listUrl', async () => {
    const res = await listArtifactsTool.execute({ glob: '*' }, ctx)
    expect(res.success).toBe(false)
    expect(res.output).toContain('listUrl')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/__tests__/unit/list-artifacts-tool.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现工具**

```ts
// src/agent/tools/list-artifacts.ts
import { registerTool } from './index.js'
import { listArtifacts } from '../../pipeline/artifact-resolver.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

const MAX = 10

function fmtSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`
  return `${bytes} B`
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

export const listArtifactsTool: AgentTool = {
  name: 'list_artifacts',
  description: '列出制品仓库中符合 glob 的文件（按修改时间倒序，最多 10 条）。触发流水线前让用户选包时使用。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      listUrl: { type: 'string', description: '目录列表 URL，如 http://repo/path（不带 ?json=true）' },
      glob: { type: 'string', description: '可选过滤模式，如 PAM-Docker-*.tar.gz' },
      authHeaders: { type: 'object', description: '可选鉴权头', additionalProperties: { type: 'string' } },
    },
    required: ['listUrl'],
  },

  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const p = (params ?? {}) as { listUrl?: string; glob?: string; authHeaders?: Record<string, string> }
    if (!p.listUrl) return { success: false, output: '缺少必要参数 listUrl' }

    try {
      const all = await listArtifacts({ listUrl: p.listUrl, glob: p.glob ?? '', authHeaders: p.authHeaders })
      if (all.length === 0) {
        return { success: true, output: `没有匹配 \`${p.glob ?? '*'}\` 的文件。请核对 glob 或仓库路径。` }
      }
      const head = all.slice(0, MAX)
      const truncated = all.length > MAX
      const lines = head.map((f, i) => `${i + 1}. \`${f.name}\`  ${fmtSize(f.size)}  ${fmtTime(f.mtime)}`)
      const tip = truncated ? `\n\n> 还有 ${all.length - MAX} 个未显示，如需更多请说明。` : ''
      return {
        success: true,
        output: `找到 ${all.length} 个文件，请回复编号或文件名：\n\n${lines.join('\n')}${tip}`,
        data: { files: head, truncated, total: all.length },
      }
    } catch (e) {
      return { success: false, output: (e as Error).message }
    }
  },
}

registerTool(listArtifactsTool)
```

- [ ] **Step 4: DEFAULT_TOOL_ROLES 加一项**

在 `src/agent/tools/types.ts` 的 `DEFAULT_TOOL_ROLES` 对象里加：

```ts
list_artifacts: ['developer', 'tester', 'ops', 'admin'],
```

- [ ] **Step 5: import 到 server.ts 与 mcp-server.ts**

在两个文件顶部既有的 `import './tools/...'` 块中追加：

```ts
import './tools/list-artifacts.js'
```

若 server.ts 通过 `src/agent/tools/index.ts` 统一导入，则改 index.ts。

- [ ] **Step 6: 运行所有测试**

```bash
pnpm test
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/agent/tools/list-artifacts.ts src/agent/tools/types.ts src/server.ts src/agent/mcp-server.ts src/__tests__/unit/list-artifacts-tool.test.ts
git commit -m "agent: 新增 list_artifacts MCP 工具"
```

---

## Task 11 · MCP 工具 `get_pipeline_artifact_inputs`（TDD）

**Files:**
- Create: `src/agent/tools/get-pipeline-artifact-inputs.ts`
- Create: `src/__tests__/unit/get-pipeline-artifact-inputs-tool.test.ts`
- Modify: `src/agent/tools/types.ts`
- Modify: `src/server.ts` / `src/agent/mcp-server.ts`

- [ ] **Step 1: 写测试**

```ts
// src/__tests__/unit/get-pipeline-artifact-inputs-tool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/test-pipelines.js', () => ({
  getTestPipelineById: vi.fn(),
}))

import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import { getPipelineArtifactInputsTool } from '../../agent/tools/get-pipeline-artifact-inputs.js'
import type { TaskContext } from '../../agent/tools/types.js'

const mockGet = vi.mocked(getTestPipelineById)
const ctx: TaskContext = {
  taskId: 't1', groupId: 'g1', platform: 'dingtalk',
  initiatorId: 'u1', initiatorRole: 'developer',
}

beforeEach(() => mockGet.mockReset())

function pipeline(artifactInputs: unknown[]): any {
  return { id: 1, name: 'P', productLineId: 1, artifactInputs, stages: [], variables: {} }
}

describe('get_pipeline_artifact_inputs tool', () => {
  it('returns empty array when pipeline has none', async () => {
    mockGet.mockResolvedValue(pipeline([]))
    const res = await getPipelineArtifactInputsTool.execute({ pipelineId: 1 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ inputs: [] })
    expect(res.output).toContain('无需')
  })

  it('returns inputs with user-readable markdown', async () => {
    mockGet.mockResolvedValue(pipeline([
      { name: '选 PAM 包', listUrl: 'http://x', glob: 'PAM-*.tar.gz', outputVar: 'PACKAGE_URL', valueFrom: 'url' },
    ]))
    const res = await getPipelineArtifactInputsTool.execute({ pipelineId: 1 }, ctx)
    expect(res.success).toBe(true)
    expect(res.output).toContain('选 PAM 包')
    expect(res.output).toContain('PAM-*.tar.gz')
    const data = res.data as { inputs: unknown[] }
    expect(data.inputs).toHaveLength(1)
  })

  it('returns 404-style error when pipeline missing', async () => {
    mockGet.mockResolvedValue(null)
    const res = await getPipelineArtifactInputsTool.execute({ pipelineId: 999 }, ctx)
    expect(res.success).toBe(false)
    expect(res.output).toContain('999')
  })

  it('rejects missing pipelineId', async () => {
    const res = await getPipelineArtifactInputsTool.execute({}, ctx)
    expect(res.success).toBe(false)
    expect(res.output).toContain('pipelineId')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/__tests__/unit/get-pipeline-artifact-inputs-tool.test.ts
```

预期：FAIL。

- [ ] **Step 3: 实现工具**

```ts
// src/agent/tools/get-pipeline-artifact-inputs.ts
import { registerTool } from './index.js'
import { getTestPipelineById } from '../../db/repositories/test-pipelines.js'
import type { ArtifactInput } from '../../pipeline/types.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

export const getPipelineArtifactInputsTool: AgentTool = {
  name: 'get_pipeline_artifact_inputs',
  description: '读取 pipeline 在触发前需要用户/调用方提供的制品输入需求。触发流水线前必须先调用，根据返回项引导用户选择。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: { pipelineId: { type: 'integer', description: '流水线 ID' } },
    required: ['pipelineId'],
  },

  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const p = (params ?? {}) as { pipelineId?: number }
    if (!p.pipelineId) return { success: false, output: '缺少必要参数 pipelineId' }

    const pipeline = await getTestPipelineById(p.pipelineId)
    if (!pipeline) return { success: false, output: `流水线 ${p.pipelineId} 不存在` }

    const inputs = (pipeline.artifactInputs ?? []) as ArtifactInput[]
    if (inputs.length === 0) {
      return { success: true, output: '该流水线无需制品输入，可直接触发。', data: { inputs: [] } }
    }

    const lines = inputs.map((i, idx) =>
      `${idx + 1}. **${i.name}** → var \`${i.outputVar}\`  glob: \`${i.glob}\`  仓库: \`${i.listUrl}\``,
    )
    return {
      success: true,
      output: `触发该流水线前需选择：\n\n${lines.join('\n')}\n\n对每项调用 \`list_artifacts(listUrl, glob)\` 列出候选，然后请用户选择。`,
      data: { inputs },
    }
  },
}

registerTool(getPipelineArtifactInputsTool)
```

- [ ] **Step 4: DEFAULT_TOOL_ROLES 加一项**

```ts
get_pipeline_artifact_inputs: ['developer', 'tester', 'ops', 'admin'],
```

- [ ] **Step 5: import 到 server.ts 与 mcp-server.ts**

```ts
import './tools/get-pipeline-artifact-inputs.js'
```

- [ ] **Step 6: 运行全部测试**

```bash
pnpm test
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/agent/tools/get-pipeline-artifact-inputs.ts src/agent/tools/types.ts src/server.ts src/agent/mcp-server.ts src/__tests__/unit/get-pipeline-artifact-inputs-tool.test.ts
git commit -m "agent: 新增 get_pipeline_artifact_inputs MCP 工具"
```

---

## Task 12 · 前端 API 层

**Files:**
- Modify: `web/src/api/pipelines.ts`
- Create: `web/src/api/artifacts.ts`

- [ ] **Step 1: 查看现有 pipeline API**

```bash
head -40 web/src/api/pipelines.ts
```

找到 Pipeline 类型定义与 `updatePipeline` / `runPipeline` 函数（或类似命名）。

- [ ] **Step 2: 扩展类型与接口**

在 `web/src/api/pipelines.ts` 顶部（其它类型定义附近）追加：

```ts
export interface ArtifactInput {
  name: string
  listUrl: string
  glob: string
  outputVar: string
  valueFrom: 'url' | 'name' | 'path'
  default?: string
  defaultStrategy?: 'latest-by-mtime' | 'first-match'
  authHeaders?: Record<string, string>
}
```

找到现有 `Pipeline` 接口（通常含 `stages`、`variables` 等字段），**加一行**：

```ts
artifactInputs: ArtifactInput[]
```

找到更新 / 创建 pipeline 的函数（例如 `updatePipeline` / `createPipeline`），其 body 类型里**加一行**：

```ts
artifactInputs: ArtifactInput[]
```

找到触发 pipeline 的函数（调用 POST `/admin/test-runs` 的那个），把入参从：

```ts
function runPipeline(pipelineId: number, servers: Record<string, string[]>): Promise<...>
```

扩为：

```ts
function runPipeline(
  pipelineId: number,
  servers: Record<string, string[]>,
  runtimeVars?: Record<string, string>,
): Promise<...>
```

实现里把 `runtimeVars` 加入请求 body。

- [ ] **Step 3: 新建 web/src/api/artifacts.ts**

```ts
import axios from './axios'

export interface ArtifactFile {
  name: string
  path: string
  size: number
  mtime: number
  downloadUrl: string
}

export async function listArtifacts(
  listUrl: string,
  glob?: string,
  authHeaders?: Record<string, string>,
): Promise<ArtifactFile[]> {
  const { data } = await axios.post('/admin/artifacts/list', { listUrl, glob, authHeaders })
  return data.files
}
```

> 若 `web/src/api/` 下 axios 实例导出名不同（如 `./http` 或 `./client`），按实际调整 import。

- [ ] **Step 4: 构建验证**

```bash
cd web && pnpm build
```

预期：无类型错误。

- [ ] **Step 5: 提交**

```bash
git add web/src/api/
git commit -m "web(api): 新增 artifacts.list 和 pipeline artifactInputs/runtimeVars 字段"
```

---

## Task 13 · 前端 Pipeline 编辑器「制品输入」分节

**Files:**
- Modify: `web/src/pages/Pipelines/<编辑器相关文件>`（需先探查）

- [ ] **Step 1: 定位编辑器文件**

```bash
ls web/src/pages/ | grep -i pipeline
find web/src/pages -type f -name '*.tsx' | xargs grep -l 'stages\|variables' | head -5
```

记下实际路径（例如 `web/src/pages/Pipelines/PipelineEditor.tsx`）。下面以 `<编辑器>` 代指。

- [ ] **Step 2: 新增「制品输入」分节组件**

在编辑器文件中，模仿现有"变量（variables）"或"阶段（stages）"分节的写法，新增一个 `ArtifactInputsSection` 组件：

```tsx
import { Button, Form, Input, Select, Table, Popover, message } from 'antd'
import { listArtifacts, type ArtifactFile } from '../../api/artifacts'
import type { ArtifactInput } from '../../api/pipelines'

interface Props {
  value: ArtifactInput[]
  onChange: (next: ArtifactInput[]) => void
}

export function ArtifactInputsSection({ value, onChange }: Props) {
  const update = (idx: number, patch: Partial<ArtifactInput>) =>
    onChange(value.map((v, i) => (i === idx ? { ...v, ...patch } : v)))
  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx))
  const add = () =>
    onChange([
      ...value,
      { name: '', listUrl: '', glob: '', outputVar: '', valueFrom: 'url' },
    ])

  const preview = async (row: ArtifactInput) => {
    try {
      const files = await listArtifacts(row.listUrl, row.glob)
      if (files.length === 0) return message.info('没有匹配的文件')
      message.success(`匹配 ${files.length} 个：${files.slice(0, 3).map(f => f.name).join(', ')}...`)
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? e.message)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <h4>制品输入（触发前需选择/提供）</h4>
        <Button size="small" onClick={add}>新增</Button>
      </div>
      <Table
        rowKey={(_, i) => String(i)}
        dataSource={value}
        pagination={false}
        size="small"
        columns={[
          { title: '名称', dataIndex: 'name', render: (_, r, i) =>
              <Input value={r.name} onChange={e => update(i, { name: e.target.value })} /> },
          { title: 'listUrl', dataIndex: 'listUrl', render: (_, r, i) =>
              <Input value={r.listUrl} onChange={e => update(i, { listUrl: e.target.value })} /> },
          { title: 'glob', dataIndex: 'glob', render: (_, r, i) =>
              <Input value={r.glob} onChange={e => update(i, { glob: e.target.value })} /> },
          { title: 'outputVar', dataIndex: 'outputVar', render: (_, r, i) =>
              <Input value={r.outputVar} onChange={e => update(i, { outputVar: e.target.value })} /> },
          { title: 'valueFrom', dataIndex: 'valueFrom', render: (_, r, i) =>
              <Select value={r.valueFrom} onChange={v => update(i, { valueFrom: v })} style={{ width: 90 }}
                      options={[{ value: 'url', label: 'url' }, { value: 'name', label: 'name' }, { value: 'path', label: 'path' }]} /> },
          { title: 'default', dataIndex: 'default', render: (_, r, i) =>
              <Input value={r.default ?? ''} onChange={e => update(i, { default: e.target.value || undefined })} /> },
          { title: 'strategy', dataIndex: 'defaultStrategy', render: (_, r, i) =>
              <Select value={r.defaultStrategy} allowClear onChange={v => update(i, { defaultStrategy: v })} style={{ width: 150 }}
                      options={[{ value: 'latest-by-mtime', label: 'latest-by-mtime' }, { value: 'first-match', label: 'first-match' }]} /> },
          { title: '', render: (_, r, i) =>
              <>
                <Button size="small" onClick={() => preview(r)}>预览</Button>
                <Button size="small" danger onClick={() => remove(i)} style={{ marginLeft: 4 }}>删</Button>
              </> },
        ]}
      />
    </div>
  )
}
```

- [ ] **Step 3: 在编辑器主界面挂载组件**

找到原本渲染 "variables" 分节的地方，在其下方加：

```tsx
<ArtifactInputsSection
  value={form.artifactInputs ?? []}
  onChange={next => setForm({ ...form, artifactInputs: next })}
/>
```

（`form` / `setForm` 为该编辑器现有的状态钩子，按实际命名替换。）

- [ ] **Step 4: 保存提交携带 artifactInputs**

确认保存处 body 包含 `artifactInputs`。若后端 400 错误返回（定时触发缺默认值），弹 `message.error` 显示。

- [ ] **Step 5: 手工联调**

```bash
pnpm dev          # 后端
# 新窗口
cd web && pnpm dev
```

浏览器打开 `http://localhost:5173/admin/...` → 进入一个 pipeline 编辑 → 新增一条制品输入，填入：
```
name=选 PAM 包
listUrl=http://10.10.2.234:8000/pam/deploy
glob=PAM-Docker-*.tar.gz
outputVar=PACKAGE_URL
valueFrom=url
```
点"预览"应弹出 message；保存应成功（无 schedule 时）。

再把 pipeline 的 schedule 设非空 → 清空 default/strategy → 保存 → 应弹错误。

- [ ] **Step 6: 提交**

```bash
git add web/src/pages/
git commit -m "web: pipeline 编辑器新增制品输入分节 + 预览"
```

---

## Task 14 · 前端手动运行对话框支持 runtimeVars

**Files:**
- Modify: `web/src/pages/Pipelines/<运行触发对话框文件>`

- [ ] **Step 1: 定位触发对话框**

```bash
grep -rn "POST.*test-runs\|/test-runs" web/src/ | head -10
```

定位到发起触发的组件。

- [ ] **Step 2: 运行前获取 pipeline.artifactInputs**

触发按钮打开对话框前，确保已拿到当前 pipeline 的完整配置（含 `artifactInputs`）。

- [ ] **Step 3: 对话框渲染 runtime 参数表单**

```tsx
const [runtimeVars, setRuntimeVars] = useState<Record<string, string>>({})

{pipeline.artifactInputs?.map(input => (
  <Form.Item key={input.outputVar} label={input.name} required>
    <Input.Group compact>
      <Input
        style={{ width: 'calc(100% - 96px)' }}
        placeholder={input.default ?? '从仓库选或直接粘贴 URL'}
        value={runtimeVars[input.outputVar] ?? ''}
        onChange={e => setRuntimeVars({ ...runtimeVars, [input.outputVar]: e.target.value })}
      />
      <Button onClick={async () => {
        const files = await listArtifacts(input.listUrl, input.glob)
        Modal.info({
          title: `选择：${input.name}`,
          content: (
            <List dataSource={files} renderItem={f => (
              <List.Item actions={[
                <Button size="small" onClick={() => {
                  const pickValue = input.valueFrom === 'name' ? f.name :
                                    input.valueFrom === 'path' ? f.path : f.downloadUrl
                  setRuntimeVars(prev => ({ ...prev, [input.outputVar]: pickValue }))
                  Modal.destroyAll()
                }}>选</Button>,
              ]}>
                {f.name} · {new Date(f.mtime).toISOString().slice(0, 16)}
              </List.Item>
            )} />
          ),
        })
      }}>从仓库选</Button>
    </Input.Group>
  </Form.Item>
))}
```

（细节组件按实际 Antd 版本/风格调整。）

- [ ] **Step 4: 提交触发时携带 runtimeVars**

触发 POST `/admin/test-runs` 的 body 中加入 `runtimeVars`。

- [ ] **Step 5: 联调**

在上一步创建的带 artifactInput 的 pipeline 上点"运行"。不填 runtimeVar 直接触发 → 400 错误。点"从仓库选"挑一个 → 触发成功，运行详情页的 `runtime_vars` 列能看到值。

- [ ] **Step 6: 提交**

```bash
git add web/src/pages/
git commit -m "web: 手动运行对话框支持 runtimeVars 与从仓库选"
```

---

## Task 15 · 端到端冒烟 + MEMORY 更新

**Files:**
- 无源码改动
- 可能 modify: `docs/superpowers/specs/2026-04-18-artifact-input-selection-design.md`（标记"已实现"）

- [ ] **Step 1: 完整冒烟**

后端 + 前端都启动：

```bash
pnpm migrate
pnpm dev            # 终端 1
cd web && pnpm dev  # 终端 2
```

- [ ] **Step 2: 数据准备**

从后台创建一条 pipeline，含：
- 1 个 artifactInput：PAM-Docker-*.tar.gz，outputVar=PACKAGE_URL，valueFrom=url
- stages：一个 script stage，脚本写 `echo "下载 URL: {{vars.PACKAGE_URL}}"`
- 无 schedule（先验手动场景）

- [ ] **Step 3: 手动触发（无 runtimeVar）**

点运行，不填 runtimeVar → 400 错误，含"ARTIFACT_INPUT_UNRESOLVED"。

- [ ] **Step 4: 从仓库选择并触发**

"从仓库选" → 选 PAM-Docker-develop.tar.gz → 运行 → 查看 run 详情：
- `runtime_vars` 字段值含 `PACKAGE_URL`
- stage 日志中 echo 输出实际 URL

- [ ] **Step 5: 定时触发保护**

编辑 pipeline，设 schedule `0 * * * *`，清空 default/strategy → 保存 → 应提示错误。设 `defaultStrategy=latest-by-mtime` 保存 → 成功。

- [ ] **Step 6: IM Agent 流程验证**

在钉钉/飞书测试群：

```
用户："帮我运行 <pipeline-name>"
Agent：[调 get_pipeline_artifact_inputs → list_artifacts → 展示编号列表]
用户："1"
Agent：[调 trigger 工具，runtimeVars 注入]
```

若 Agent 没主动调 `get_pipeline_artifact_inputs`，调整 `mcp-server.ts` 顶部提示词或工具 description，把"触发流水线前必须先调用"写得更明确。

- [ ] **Step 7: 更新 spec 状态**

把 spec 文件顶部 `**状态**：待实现` 改为 `**状态**：已实现 @2026-04-XX`。

- [ ] **Step 8: 提交**

```bash
git add docs/superpowers/specs/
git commit -m "docs(spec): artifactInputs 功能已实现"
```

---

## 验证清单（合并 PR 前）

- [ ] `pnpm test` 全部通过
- [ ] `pnpm tsc --noEmit` 无错误
- [ ] `cd web && pnpm build` 成功
- [ ] 手动场景：artifactInputs 缺失触发 400；从仓库选触发成功；脚本能 `{{vars.X}}` 读出 URL
- [ ] 定时场景：保存校验拦住缺默认值；带 strategy 的定时跑通（可手动 cron 触发一次验证）
- [ ] IM Agent 场景：列出 → 选择 → 触发 → 回包

---

## 说明

- `first-match` 实现固化为"按文件名字典序第一个"，确保无序响应下结果稳定（详见 Task 6）。
- gohttpserver 之外的仓库类型**不在本计划**：`authHeaders` 字段已预留，未来增仓库类型时只需扩展 `listArtifacts` 分派逻辑。
- `deploy` 系列 MCP 工具**不触动**（见 spec 第 10 节）。
