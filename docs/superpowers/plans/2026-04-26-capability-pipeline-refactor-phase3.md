# 能力(Capability)与流水线(Pipeline)分工重构 — phase 3 sub-plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pipeline DSL 增强 + 7 个新节点类型 + 表达式解析器 + fan_out 子运行调度器 + 前端 P1 动态参数表单 + capability 节点重命名为 llm_agent。phase 3 完成后 pipeline 表达力达到生产级。

**Architecture:** 五条主线并进——(1) DB schema-v34 注册 7 新节点类型；(2) variables.ts + expressions.ts 提供 DSL 解析能力；(3) graph-runner 接管 NodeExecutor.execute 替换 graph-builder switch dispatch；(4) 5 现有 wrapper 从空壳改真实实现 + 7 新 executor 实现；(5) capability → llm_agent 重命名 + 前端 P1 改造。

**Tech Stack:** TypeScript (ES2022, NodeNext), Vitest, PostgreSQL 16 (raw SQL), LangGraph (graph-runner), React 18 + Ant Design 5.

**Spec:** [`../specs/2026-04-26-capability-pipeline-refactor-design.md`](../specs/2026-04-26-capability-pipeline-refactor-design.md) §4
**Master plan:** [`./2026-04-26-capability-pipeline-refactor.md`](./2026-04-26-capability-pipeline-refactor.md) §D
**Phase 0/1/2 + cleanup:** main = `78fc2b5` (capabilities 表瘦身完毕,im_triggers 接管 IM 入口,只剩 HANDLER_CAPABILITIES 一处硬编码)

---

## 阶段 3 范围与不动的部分

| 范围 | 在本 plan 内 | 不在本 plan 内 |
|------|------------|--------------|
| schema-v34 + 7 节点类型 INSERT | ✅ T1 | — |
| variables.ts 扩展（点记法 + JSONPath 子集 + 过滤器） | ✅ T2 | — |
| expressions.ts 表达式解析器 | ✅ T3 | — |
| 5 现有 wrapper 从空壳改真实实现 + dispatch 切换 | ✅ T4-T8 | — |
| 7 新 executor (http/dm/db_update/sql_query/file_read/template_render/fan_out) | ✅ T9-T15 | — |
| graph-validation 扩展 | ✅ T16 | — |
| capability → llm_agent 重命名 | ✅ T17 | — |
| 前端 P1 动态参数表单 | ✅ T18 | — |
| 前端 retry/fan_out 高级配置 UI | ✅ T19 | — |
| 冒烟手册 + 验收 | ✅ T20 | — |
| HANDLER_CAPABILITIES (claude-runner.ts:366) | ✅ T17 顺带处理 | — |
| 变量插值 IntelliSense (前端) | ❌ | P2 推迟 |
| fan_out 嵌套 fan_out | ❌ | spec §4.4 v1 不支持 |
| 完整表达式语言 (函数 / map / filter) | ❌ | spec §4.7 v1 不引 |

20 task。预计 2-3 周。

## 关键约束

- **每 task 跑一次全套** `pnpm test` —— graph-runner 改造影响面大，每提交后必须确认 baseline (6 dingtalk-sync) 不变
- **现有 5 wrapper 改实现的逻辑大部分是 graph-builder.ts:649 switch case 内代码搬过去** —— 不重新设计，搬代码 + 把对 helper 的依赖通过 ExecutionContext 传入
- **graph-builder.ts:649 switch dispatch 完全移除** 是 T8 的尾工——所有 5 wrapper 都改完后移除
- **capability → llm_agent 重命名是破坏性变更**——T17 必须在 T4-T16 全 ship + 测试全绿后再做，且伴随 test_pipelines.graph 数据迁移
- **前端 NodeInspector 改 stageType → nodeTypeKey** 是核心组件改动——T18 前小心 review

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema-v34.sql` | 创建 | INSERT 7 新节点类型行 + DO $$ 断言 12 类型存在 |
| `src/db/migrate.ts` | 修改 | 追加 v34 块 |
| `src/__tests__/helpers/db.ts` | 修改 | SCHEMA_FILES 加 v34 |
| `src/pipeline/variables.ts` | 修改 | 扩展 resolvePath：点记法 / JSONPath 子集 / 内置过滤器 |
| `src/pipeline/expressions.ts` | 创建 | 手写 PEG parser；exports `evalExpression(expr, ctx)` |
| `src/pipeline/graph-runner.ts` | 修改 | dispatch 改用 `getExecutor(nodeTypeKey).execute()` + fan_out 子运行调度 |
| `src/pipeline/graph-builder.ts` | 修改 | 移除 switch dispatch (T8 尾工) |
| `src/pipeline/graph-validation.ts` | 修改 | fan_out body / retry_when 表达式预解析 / steps 引用 DFS |
| `src/pipeline/types.ts` | 修改 | T17 末尾：StageDefinition.stageType → nodeTypeKey 改名 |
| `src/pipeline/node-types/script.ts` | 修改 | T4：从空壳 throw 改真实 SSH 执行 |
| `src/pipeline/node-types/approval.ts` | 修改 | T5 |
| `src/pipeline/node-types/capability.ts` → `llm-agent.ts` | 改名 + 修改 | T6 / T17 |
| `src/pipeline/node-types/wait-webhook.ts` | 修改 | T7 |
| `src/pipeline/node-types/im-input.ts` | 修改 | T8 |
| `src/pipeline/node-types/http.ts` | 创建 | T9 — HTTP executor |
| `src/pipeline/node-types/dm.ts` | 创建 | T10 — IM 私聊 executor |
| `src/pipeline/node-types/db-update.ts` | 创建 | T11 — 业务 DB 写入 executor |
| `src/pipeline/node-types/sql-query.ts` | 创建 | T12 — 业务 DB 查询 executor |
| `src/pipeline/node-types/file-read.ts` | 创建 | T13 — 文件读取 executor |
| `src/pipeline/node-types/template-render.ts` | 创建 | T14 — 模板渲染 executor |
| `src/pipeline/node-types/fan-out.ts` | 创建 | T15 — fan_out executor + 子运行调度（与 graph-runner 协作） |
| `src/pipeline/node-types/index.ts` | 修改 | barrel 加 7 新 import + 改 capability → llm-agent |
| `src/agent/claude-runner.ts` | 修改 | T17：HANDLER_CAPABILITIES 集合处理 |
| `web/src/pipeline-canvas/panels/NodeInspector.tsx` | 修改 | T18 + T19：动态参数表单 + retry/fan_out UI |
| `web/src/pipeline-canvas/types.ts` | 修改 | T17 节点类型 key 加 llm_agent + 7 新类型 |
| `docs/smoke-pipeline-dsl.md` | 创建 | T20 冒烟手册 |

## 执行前提

- [ ] **Worktree**：`EnterWorktree` 后立刻 `git rebase main`（phase 0/1/2 都遇到 EnterWorktree base 偏旧问题）
- [ ] **依赖**：`pnpm migrate` 应用到 v33；`pnpm test` baseline 6 dingtalk-sync fail；前置阶段无 regression

---

## Task 1: schema-v34 + 7 节点类型 INSERT + SCHEMA_FILES

**Files:**
- Create: `src/db/schema-v34.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`

- [ ] **Step 1: schema-v34.sql**

```sql
-- v34: phase 3 — 7 个新节点类型 INSERT 到 pipeline_node_types
-- 现有 5 种(script/approval/capability/wait_webhook/im_input)从 v30 起就在;
-- 新增 7 种,共 12 种。spec §4.1 节点类型清单。

INSERT INTO pipeline_node_types (key, display_name, description, category, param_schema, output_schema)
VALUES
  ('http', 'HTTP 调用', '发起 HTTP 请求', 'general',
    '{"type":"object","required":["method","url"],"properties":{"method":{"type":"string","enum":["GET","POST","PUT","DELETE","PATCH"]},"url":{"type":"string"},"headers":{"type":"object"},"body":{"type":"object"},"timeoutMs":{"type":"number","default":30000}}}'::jsonb,
    '{"type":"object","properties":{"statusCode":{"type":"number"},"headers":{"type":"object"},"body":{"type":"object"}}}'::jsonb),

  ('dm', 'IM 私聊', '通过 IM adapter 发私聊消息', 'general',
    '{"type":"object","required":["platform","userId"],"properties":{"platform":{"type":"string","enum":["dingtalk","feishu"]},"userId":{"type":"string"},"text":{"type":"string"},"card":{"type":"object"}}}'::jsonb,
    '{"type":"object","properties":{"messageId":{"type":"string"},"deliveredAt":{"type":"string"}}}'::jsonb),

  ('db_update', 'DB 写入', '内部 DB 写入(支持变量插值)', 'general',
    '{"type":"object","required":["sqlTemplate"],"properties":{"sqlTemplate":{"type":"string","format":"textarea"},"params":{"type":"array"}}}'::jsonb,
    '{"type":"object","properties":{"rowsAffected":{"type":"number"}}}'::jsonb),

  ('sql_query', 'DB 查询', '内部 DB 查询(返回 rows 数组)', 'general',
    '{"type":"object","required":["sqlTemplate"],"properties":{"sqlTemplate":{"type":"string","format":"textarea"},"params":{"type":"array"}}}'::jsonb,
    '{"type":"object","properties":{"rows":{"type":"array"}}}'::jsonb),

  ('file_read', '文件读取', '读取远程或本地文件内容', 'general',
    '{"type":"object","required":["path"],"properties":{"target":{"type":"string","description":"local 或 ssh server name"},"path":{"type":"string"},"maxBytes":{"type":"number","default":1048576}}}'::jsonb,
    '{"type":"object","properties":{"content":{"type":"string"},"size":{"type":"number"}}}'::jsonb),

  ('template_render', '模板渲染', '字符串模板渲染(为下游 description / sqlTemplate 用)', 'general',
    '{"type":"object","required":["template"],"properties":{"template":{"type":"string","format":"textarea"},"vars":{"type":"object"}}}'::jsonb,
    '{"type":"object","properties":{"text":{"type":"string"}}}'::jsonb),

  ('fan_out', '数组扇出', '把上游数组扇成多个并行子运行', 'flow',
    '{"type":"object","required":["source","as","body"],"properties":{"source":{"type":"string","description":"如 {{steps.x.output.items}}"},"as":{"type":"string"},"parallel":{"type":"number","default":3},"onItemFailure":{"type":"string","enum":["continue","stop","aggregate"],"default":"continue"},"body":{"type":"array","items":{"type":"string"}}}}'::jsonb,
    '{"type":"object","properties":{"items":{"type":"array"},"failed":{"type":"array"}}}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 断言: 12 种节点类型存在
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pipeline_node_types WHERE enabled = TRUE;
  IF v_count <> 12 THEN
    RAISE EXCEPTION 'schema-v34: pipeline_node_types 应有 12 行(5 phase 0 + 7 phase 3),实际 %', v_count;
  END IF;
  RAISE NOTICE 'schema-v34: 12 节点类型注册完成';
END $$;
```

- [ ] **Step 2: migrate.ts** 追加 v34 块（参考 v32/v33 模式）

- [ ] **Step 3: SCHEMA_FILES 加 v34**

- [ ] **Step 4: 跑 `pnpm migrate` 验证 + 跑 `pnpm test`**：基线保持

⚠️ 这一步增加 7 行节点类型到 DB，但 server 启动一致性检查（phase 0 加的）会要求代码端 register 这 12 个 key —— 每个新节点的 wrapper 还没创建。**所以 server 此时启动会 fail**。这是预期：T9-T15 的 7 个新 executor 文件加上后才会通过。临时跑 `pnpm dev` 报错，不是阻塞——T9-T15 完成后修复。

为避免 phase 中段 dev 不能跑，T1 临时方案：**新增 7 行节点类型先全部 enabled=FALSE**，T9-T15 每完成一个 executor 后通过 `UPDATE pipeline_node_types SET enabled=TRUE WHERE key='...'` 启用。或者简单点：T1 把这 7 行 enabled=TRUE，T9-T15 的每个 task 末尾 server 才能正常启动。

**决策**：T1 全部 enabled=TRUE。中段 dev 不可启动是预期；test 不受影响（启动一致性只在 server.ts 启动时跑，test 不调）。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v34.sql src/db/migrate.ts src/__tests__/helpers/db.ts
git commit -m "feat(db): pipeline_node_types 加 7 个新节点类型(schema-v34)"
```

---

## Task 2: variables.ts 扩展（点记法 + JSONPath 子集 + 过滤器）

**Files:**
- Modify: `src/pipeline/variables.ts`
- Create: `src/__tests__/unit/variables-extended.test.ts`

- [ ] **Step 1: 写测试**（覆盖以下 case）

Create `src/__tests__/unit/variables-extended.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveVariables, type VariableContext } from '../../pipeline/variables.js'

describe('variables — phase 3 扩展', () => {
  const ctx: VariableContext = {
    triggerParams: { project: 'ssh-proxy', env: 'dev' },
    vars: { branch: 'main' },
    steps: {
      load_config: { status: 'success', output: { rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] } },
      build: { status: 'failed', output: { error: 'timeout', statusCode: 504 } },
    },
    server: { host: '10.0.0.1', port: 22 },
    run: { id: 42, startedAt: '2026-04-26T00:00:00Z' },
  } as any

  it('triggerParams.x', () => {
    expect(resolveVariables('{{triggerParams.project}}', ctx)).toBe('ssh-proxy')
  })

  it('vars.x', () => {
    expect(resolveVariables('{{vars.branch}}', ctx)).toBe('main')
  })

  it('steps.<id>.status', () => {
    expect(resolveVariables('{{steps.load_config.status}}', ctx)).toBe('success')
    expect(resolveVariables('{{steps.build.status}}', ctx)).toBe('failed')
  })

  it('steps.<id>.output.<field>', () => {
    expect(resolveVariables('{{steps.build.output.error}}', ctx)).toBe('timeout')
    expect(resolveVariables('{{steps.build.output.statusCode}}', ctx)).toBe('504')
  })

  it('JSONPath: array index', () => {
    expect(resolveVariables('{{steps.load_config.output.rows[0].id}}', ctx)).toBe('1')
    expect(resolveVariables('{{steps.load_config.output.rows[1].name}}', ctx)).toBe('b')
  })

  it('server.host / run.id', () => {
    expect(resolveVariables('{{server.host}}', ctx)).toBe('10.0.0.1')
    expect(resolveVariables('{{run.id}}', ctx)).toBe('42')
  })

  it('builtin filter: urlEncode', () => {
    expect(resolveVariables('{{triggerParams.project | urlEncode}}', { ...ctx, triggerParams: { project: 'a/b c' } } as any))
      .toBe('a%2Fb%20c')
  })

  it('builtin filter: lower / upper / jsonStringify', () => {
    expect(resolveVariables('{{triggerParams.project | upper}}', ctx)).toBe('SSH-PROXY')
    expect(resolveVariables('{{triggerParams.project | lower}}', { ...ctx, triggerParams: { project: 'SSH-PROXY' } } as any)).toBe('ssh-proxy')
    const out = resolveVariables('{{steps.load_config.output | jsonStringify}}', ctx)
    expect(JSON.parse(out)).toEqual({ rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
  })

  it('unresolved variable returns literal placeholder', () => {
    expect(resolveVariables('{{vars.nonexistent}}', ctx)).toBe('{{vars.nonexistent}}')
  })

  it('scopes (fan_out 注入) 优先级最高', () => {
    const ctxWithScope = { ...ctx, scopes: { item: { project: 'overridden' } } } as any
    expect(resolveVariables('{{item.project}}', ctxWithScope)).toBe('overridden')
  })
})
```

Run: `pnpm test src/__tests__/unit/variables-extended.test.ts`
Expected: FAIL（功能未实现）。

- [ ] **Step 2: 扩展 variables.ts**

Read current `src/pipeline/variables.ts` (76 lines) — preserve `VariableContext` / `VariableDefinition` / `VARIABLE_CATALOG` exports. Replace `resolveVariables` and `resolvePath` with extended versions:

```typescript
const FILTERS: Record<string, (v: unknown) => string> = {
  urlEncode: (v) => encodeURIComponent(String(v)),
  jsonStringify: (v) => JSON.stringify(v),
  lower: (v) => String(v).toLowerCase(),
  upper: (v) => String(v).toUpperCase(),
}

export function resolveVariables(template: string, ctx: VariableContext): string {
  return template.replace(/\{\{\s*([^}|]+?)(?:\s*\|\s*(\w+))?\s*\}\}/g, (raw, expr: string, filter?: string) => {
    const value = resolvePath(ctx as unknown as Record<string, unknown>, expr.trim())
    if (value === undefined) return raw  // 未解析保留 {{...}}
    if (filter) {
      const fn = FILTERS[filter]
      if (!fn) throw new Error(`unknown variable filter: ${filter}`)
      return fn(value)
    }
    return typeof value === 'string' ? value : JSON.stringify(value).replace(/^"|"$/g, '')
  })
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  // 优先级: scopes > steps > vars > triggerParams (spec §4.5)
  // path 形如 "steps.x.output.field" 或 "scopes.item.project" 或 "triggerParams.env"
  // 先按字面 path 解析,如果命中 scopes.<key>.<rest> 转 path 为 <key>.<rest>(scopes 无前缀就近)
  // 简化实现:先尝试 obj.scopes[<head>] 命中,再退到 obj[<head>]
  const parts = parsePath(path)
  if (parts.length === 0) return undefined

  // scope-injection: 如果 obj.scopes 有 head key,则从 scopes 取 head
  const scopes = (obj.scopes ?? {}) as Record<string, unknown>
  const head = parts[0]
  let cursor: unknown = (head.kind === 'name' && head.name in scopes)
    ? scopes
    : obj

  for (const p of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    if (p.kind === 'name') cursor = (cursor as Record<string, unknown>)[p.name]
    else if (p.kind === 'index') cursor = (cursor as unknown[])[p.index]
  }
  return cursor
}

interface PathPart {
  kind: 'name' | 'index'
  name?: string
  index?: number
}

function parsePath(path: string): PathPart[] {
  const parts: PathPart[] = []
  let i = 0
  while (i < path.length) {
    if (path[i] === '.') { i++; continue }
    if (path[i] === '[') {
      const j = path.indexOf(']', i)
      if (j === -1) return []
      parts.push({ kind: 'index', index: parseInt(path.slice(i + 1, j), 10) })
      i = j + 1
      continue
    }
    let j = i
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++
    parts.push({ kind: 'name', name: path.slice(i, j) })
    i = j
  }
  return parts
}
```

⚠️ The `array[*].field` glob pattern from spec §4.2 is **not supported in v1**——添加注释说明 phase 3 v1 不支持，超出后必须再扩展。

- [ ] **Step 3: 跑测试 expect 10 PASS**

⚠️ 如果 `array[*]` 的测试失败，那是因为 v1 不支持；删除该测试或保留为 expectFail。

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/variables.ts src/__tests__/unit/variables-extended.test.ts
git commit -m "feat(pipeline): variables 扩展(点记法 + JSONPath 子集 + 4 内置过滤器)"
```

---

## Task 3: expressions.ts 表达式解析器

**Files:**
- Create: `src/pipeline/expressions.ts`
- Create: `src/__tests__/unit/expressions.test.ts`

- [ ] **Step 1: 写测试**

Create `src/__tests__/unit/expressions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { evalExpression, parseExpression } from '../../pipeline/expressions.js'

describe('expressions — phase 3', () => {
  const ctx = {
    status: 'failed',
    output: { error: 'timeout', statusCode: 504, retries: 3 },
    steps: {
      a: { status: 'success', output: { count: 10 } },
    },
  }

  it('status == literal string', () => {
    expect(evalExpression("status == 'failed'", ctx)).toBe(true)
    expect(evalExpression("status == 'success'", ctx)).toBe(false)
  })

  it('output.<path> == literal', () => {
    expect(evalExpression("output.error == 'timeout'", ctx)).toBe(true)
    expect(evalExpression("output.statusCode == 504", ctx)).toBe(true)
    expect(evalExpression("output.statusCode != 200", ctx)).toBe(true)
  })

  it('numeric comparison', () => {
    expect(evalExpression("output.statusCode >= 500", ctx)).toBe(true)
    expect(evalExpression("output.statusCode < 500", ctx)).toBe(false)
    expect(evalExpression("output.retries > 2", ctx)).toBe(true)
  })

  it('contains operator', () => {
    expect(evalExpression("output.error contains 'time'", ctx)).toBe(true)
    expect(evalExpression("output.error contains 'permanent'", ctx)).toBe(false)
  })

  it('logical && / || / !', () => {
    expect(evalExpression("status == 'failed' && output.statusCode >= 500", ctx)).toBe(true)
    expect(evalExpression("status == 'success' || output.statusCode >= 500", ctx)).toBe(true)
    expect(evalExpression("!output.permanent", ctx)).toBe(true)
  })

  it('steps.<id>.output.<path>', () => {
    expect(evalExpression("steps.a.output.count > 5", ctx)).toBe(true)
    expect(evalExpression("steps.a.status == 'success'", ctx)).toBe(true)
  })

  it('parens', () => {
    expect(evalExpression("(status == 'failed') && (output.statusCode >= 500 || output.retries < 3)", ctx)).toBe(true)
  })

  it('parseExpression validates syntax', () => {
    expect(() => parseExpression("status ==")).toThrow(/parse/)
    expect(() => parseExpression("status @ 'failed'")).toThrow(/parse|operator/)
    expect(parseExpression("status == 'failed'")).toBeDefined()  // 不抛
  })
})
```

Run: `pnpm test src/__tests__/unit/expressions.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 expressions.ts**

Create `src/pipeline/expressions.ts` 手写 PEG/parser combinator. 关键点:
- Tokenizer: `==` `!=` `<=` `>=` `<` `>` `&&` `||` `!` `contains` `(` `)` + identifier (a-z, _, ., \[, \], digits) + literal (string with single quotes / number / boolean true/false)
- Parser: precedence — `||` < `&&` < `!` < comparison ( ==/!= /< /> ... ) < primary
- Eval: 接受 `(ast, ctx)`, 返回 boolean

骨架:

```typescript
export type Expr =
  | { type: 'literal'; value: string | number | boolean }
  | { type: 'path'; segments: string[] }
  | { type: 'binop'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | 'contains'; left: Expr; right: Expr }
  | { type: 'not'; expr: Expr }

export function parseExpression(src: string): Expr {
  // Tokenize then recursive descent
  const tokens = tokenize(src)
  let pos = 0

  function peek(): Token | undefined { return tokens[pos] }
  function consume(type: Token['type'], value?: string): Token {
    const t = tokens[pos]
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`parse error at ${pos}: expected ${type}${value ? `(${value})` : ''}, got ${t?.type ?? 'EOF'}(${t?.value ?? ''})`)
    }
    pos++
    return t
  }
  // ... parseOr / parseAnd / parseNot / parseCompare / parsePrimary
  function parseOr(): Expr { /* ... */ }
  function parseAnd(): Expr { /* ... */ }
  function parseNot(): Expr { /* ... */ }
  function parseCompare(): Expr { /* ... */ }
  function parsePrimary(): Expr { /* literal / path / parens */ }

  const expr = parseOr()
  if (pos !== tokens.length) throw new Error(`parse error: trailing tokens at ${pos}`)
  return expr
}

interface Token { type: 'op' | 'lparen' | 'rparen' | 'string' | 'number' | 'bool' | 'ident'; value: string }

function tokenize(src: string): Token[] {
  // ... 略, regex 驱动
}

export function evalExpression(src: string | Expr, ctx: Record<string, unknown>): boolean {
  const ast = typeof src === 'string' ? parseExpression(src) : src
  return Boolean(evalNode(ast, ctx))
}

function evalNode(e: Expr, ctx: Record<string, unknown>): unknown {
  switch (e.type) {
    case 'literal': return e.value
    case 'path': return resolvePathInExpr(ctx, e.segments)
    case 'not': return !evalNode(e.expr, ctx)
    case 'binop':
      const l = evalNode(e.left, ctx); const r = evalNode(e.right, ctx)
      switch (e.op) {
        case '==': return l === r
        case '!=': return l !== r
        case '<': return (l as number) < (r as number)
        case '<=': return (l as number) <= (r as number)
        case '>': return (l as number) > (r as number)
        case '>=': return (l as number) >= (r as number)
        case '&&': return Boolean(l) && Boolean(r)
        case '||': return Boolean(l) || Boolean(r)
        case 'contains': return String(l).includes(String(r))
      }
  }
}

function resolvePathInExpr(ctx: Record<string, unknown>, segments: string[]): unknown {
  let cursor: unknown = ctx
  for (const s of segments) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[s]
  }
  return cursor
}
```

参考实现细节：tokenizer 用 regex 一遍扫；recursive descent 标准写法；不引外部 lib。

- [ ] **Step 3: 跑测试 expect 8+ PASS**

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/expressions.ts src/__tests__/unit/expressions.test.ts
git commit -m "feat(pipeline): 表达式解析器(retry_when/边 when/shortCircuitWhen 共用)"
```

---

## Task 4: graph-runner 接管 NodeExecutor — script wrapper 改真实实现（首例）

**目标**：把 phase 0 空壳 `src/pipeline/node-types/script.ts` 改为真实实现，graph-runner / graph-builder 在 dispatch 时优先用 NodeExecutor.execute。其它 4 个 wrapper 仿此处理（T5-T8）。

**Files:**
- Modify: `src/pipeline/node-types/script.ts`
- Modify: `src/pipeline/graph-runner.ts` 或 `src/pipeline/graph-builder.ts`（dispatch 切换点）

- [ ] **Step 1: 读现有 graph-builder.ts:649 switch 的 'script' case**

Run: `sed -n '640,690p' src/pipeline/graph-builder.ts`，找 'script' case 的 handler 代码。这段代码可能调 SSH executor + retryCount + onFailure 等。

- [ ] **Step 2: 把这段代码搬到 src/pipeline/node-types/script.ts 的 execute()**

```typescript
import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
// import 其它 dependencies (sshExec / 等)

registerNodeType({
  key: 'script',
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<NodeExecutionResult> {
    const commands = params.commands as string | undefined
    const script = params.script as string | undefined
    // ... 原 graph-builder 'script' case 逻辑搬过来 ...
    // 用 ctx.server.host / ctx.vars / 等
    // 返回 { status: 'success'|'failed', output: {exitCode, stdout, stderr}, error? }
  },
})
```

- [ ] **Step 3: graph-builder 'script' case 改委托给 NodeExecutor**

```typescript
case 'script': {
  const executor = getExecutor('script')
  if (!executor) throw new Error('script executor not registered')
  // 把 graph-builder 当前的 LangGraph node 包装成调用 executor.execute(node.params, ctx)
  // 这里需要适配 LangGraph 的 invoke 协议
  break
}
```

⚠️ 这一步会涉及 graph-runner / graph-builder 内部如何把 ExecutionContext 对接 LangGraph 的 RunnableConfig。具体做法看现有 graph-builder 'script' case 怎么访问 ctx —— 大概率是通过 LangGraph 的 state，需要搬到 ExecutionContext 里。

⚠️ 如果对接复杂，T4 可以分两步：先让 graph-builder 'script' case **额外调用** executor.execute（双重执行，结果取一致），通过测试后再切到只调 executor.execute。但这增加复杂度，建议直接切。

- [ ] **Step 4: 跑全套测试**：现有 pipeline (deploy-im-demo) 仍跑通。

⚠️ 如果有现有 pipeline 跑 'script' stage 失败，回滚 step 3，分析差异，再调试 executor 实现。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/node-types/script.ts src/pipeline/graph-builder.ts src/pipeline/graph-runner.ts
git commit -m "refactor(pipeline): script 节点从空壳改真实实现 + graph-runner 通过 NodeExecutor 调度"
```

---

## Task 5: approval wrapper 改真实实现

**Files:**
- Modify: `src/pipeline/node-types/approval.ts`
- Modify: `src/pipeline/graph-builder.ts`（'approval' case 切换）

T4 同模式：把 graph-builder.ts:649 'approval' case 搬到 approval.ts 的 execute()。approval 是 interrupt 类型节点，execute 内部需要支持 interrupt + resume —— 看现有 case 怎么做。

⚠️ approval 节点跟 LangGraph 的 interrupt 机制深度耦合（spec §5.3 提到的 `interrupt()`）。如果搬过来后 LangGraph 的 interrupt 不工作，可能需要 NodeExecutor 接口扩展（增加 `interrupt?(): Promise<...>` 之类）。如果真要扩展接口，先报告 BLOCKED，让 controller 决定。

- [ ] **Step 1-5：同 T4 模式，commit message:**

```
refactor(pipeline): approval 节点真实实现 + graph-runner 调度
```

---

## Task 6: capability wrapper 改真实实现（暂保留 capability 名，T17 改 llm_agent）

T4 同模式。capability 节点的 execute() 调 ClaudeRunner.executeCapabilityDirect 或类似（看现有 graph-builder 'capability' case 调什么）。

```
refactor(pipeline): capability 节点真实实现
```

---

## Task 7: wait_webhook wrapper 改真实实现

```
refactor(pipeline): wait_webhook 节点真实实现
```

---

## Task 8: im_input wrapper 改真实实现 + graph-builder switch 完全移除

T8 是 5 wrapper 改造的终点：
1. 把 'im_input' case 搬过来
2. **完全移除** graph-builder.ts:649 switch dispatch（5 case 都已委托给 NodeExecutor）
3. 改 dispatch 为统一调用 `getExecutor(node.stageType).execute(...)` 模式
4. graph-builder 的 'unknown' default `const unknown: never = node.stageType` 改为运行时 throw（"node type not registered"）

```
refactor(pipeline): im_input 节点真实实现 + graph-builder switch 完全移除
```

---

## Task 9-15: 7 个新 executor

每个新 executor 一个 task，模板相同：

**T9 — http**:
- File: `src/pipeline/node-types/http.ts`
- File: `src/pipeline/node-types/index.ts`（barrel 加 import）
- File: `src/__tests__/unit/http-executor.test.ts`
- Logic: 接 params.method/url/headers/body/timeoutMs，用 native fetch 或现有 http util；返回 `{statusCode, headers, body}` 或 `{error: '...'}` (status: 'failed')
- 测试: success / 4xx / 5xx / timeout

**T10 — dm**:
- File: `src/pipeline/node-types/dm.ts`
- Logic: 接 params.platform/userId/text/card；调 src/adapters/im 的 sendDirectMessage；返回 `{messageId, deliveredAt}`
- 测试: 通过 mock IM adapter

**T11 — db_update**:
- File: `src/pipeline/node-types/db-update.ts`
- Logic: 接 params.sqlTemplate/params；调 resolveVariables 注入 ctx 变量到 sqlTemplate；getPool().query；返回 `{rowsAffected}`
- 安全: SQL 模板支持 $1,$2 占位符（params 数组）；不允许字符串拼接 SQL（变量插值前做 SQL 关键字检查 / 限制只支持 placeholder 模板）
- 测试: 临时表 INSERT / UPDATE 跑通

**T12 — sql_query**:
- File: `src/pipeline/node-types/sql-query.ts`
- Logic: 同 T11 但 SELECT，返回 `{rows}`
- 测试: 临时表 SELECT 跑通

**T13 — file_read**:
- File: `src/pipeline/node-types/file-read.ts`
- Logic: 接 params.target ('local' | server name) / path / maxBytes；local 用 fs/promises.readFile，远程用 sshExec `cat`；返回 `{content, size}`
- 测试: 读 /etc/hostname 之类

**T14 — template_render**:
- File: `src/pipeline/node-types/template-render.ts`
- Logic: 接 params.template/vars；调 resolveVariables (variables.ts 的 extended)；params.vars 合并到 ctx 临时上下文；返回 `{text}`
- 测试: 模板带 `{{vars.x}}` + `{{steps.x.output.y}}` 渲染

每 T9-T14 单 commit:
```
feat(pipeline): <type> 节点 executor + 单测
```

---

## Task 15: fan_out 调度器 + executor

**Files:**
- Create: `src/pipeline/node-types/fan-out.ts`
- Modify: `src/pipeline/graph-runner.ts`（fan_out 子运行调度）
- Create: `src/__tests__/unit/fan-out.test.ts`

最复杂的新 executor。fan_out 节点本质上是个 **子图调度器**：
- 接 params.source（变量引用，应解析为数组） / params.as / params.parallel / params.body（子图节点 id 列表）
- 对 source 数组每个 item，把 item 注入 ctx.scopes[as]，然后跑 body 子图
- parallel=N 控制并发上限
- onItemFailure: 'continue' (默认) 不阻断 / 'stop' 任意 item failed 则整个 fan_out failed / 'aggregate' 收集所有失败 item 但 fan_out status='success'
- 返回 `{items: [<each subgraph 末节点 output>], failed: [<failed items>]}`

⚠️ 这个 task 单独 1-2 小时，建议拆 spec/code review 严格做。

```
feat(pipeline): fan_out 节点 executor + 子运行调度器
```

---

## Task 16: graph-validation 扩展

**Files:**
- Modify: `src/pipeline/graph-validation.ts`

新增 3 类校验：

1. **fan_out 节点必须有 body 字段且非空**：
   ```typescript
   if (node.stageType === 'fan_out') {
     const body = (node.params as any)?.body
     if (!Array.isArray(body) || body.length === 0) {
       errors.push(`fan_out node "${node.id}" must have non-empty body array`)
     }
   }
   ```

2. **retry_when / shortCircuitWhen 表达式语法预解析**：
   ```typescript
   import { parseExpression } from './expressions.js'
   if (node.retryWhen) {
     try { parseExpression(node.retryWhen) } catch (e) {
       errors.push(`node "${node.id}" retry_when 语法错误: ${e.message}`)
     }
   }
   ```

3. **{{steps.<id>.output.<path>}} 中 <id> 必须是上游节点**：
   - DFS 计算每个节点的 ancestors
   - 扫节点 params 里的 `{{steps.X.output...}}` 模板，X 必须在 ancestors 集合里
   - X 不在 → error

加测试 `src/__tests__/unit/graph-validation-extended.test.ts` 覆盖 3 类校验。

```
feat(pipeline): graph-validation 加 fan_out body / retry_when 语法 / steps 引用 DFS 校验
```

---

## Task 17: capability → llm_agent 重命名 + HANDLER_CAPABILITIES 处理

**Files:**
- Create: `src/pipeline/node-types/llm-agent.ts`（从 capability.ts 改名）
- Delete: `src/pipeline/node-types/capability.ts`
- Modify: `src/pipeline/node-types/index.ts`（barrel 改名）
- Modify: `src/pipeline/types.ts`（StageDefinition.stageType → nodeTypeKey；'capability' value → 'llm_agent'）
- Modify: `src/pipeline/graph-builder.ts` / `graph-runner.ts` / `executor-hooks.ts`：所有 'capability' 字符串引用改 'llm_agent'
- Create: `src/db/schema-v35.sql`：UPDATE pipeline_node_types SET key='llm_agent' WHERE key='capability'; UPDATE test_pipelines SET graph = jsonb_set ... WHERE ...
- Modify: `src/db/migrate.ts` / `src/__tests__/helpers/db.ts`
- Modify: `src/agent/claude-runner.ts`：HANDLER_CAPABILITIES 集合处理（详见下文）
- Modify: `web/src/pipeline-canvas/types.ts`：StageType union 改

⚠️ 这是破坏性变更，非常仔细。建议拆 3 个 commit:

**Commit 1**: 新增 llm-agent.ts + barrel 加注册（双注册期：'capability' 和 'llm_agent' 都注册）+ schema-v35 数据迁移（UPDATE pipeline_node_types + test_pipelines.graph）

**Commit 2**: 代码替换所有 'capability' 字符串引用为 'llm_agent'（包括 types.ts, graph-builder, graph-runner, executor-hooks, NodeInspector, 等）

**Commit 3**: 删除 capability.ts、移除 'capability' 注册、StageDefinition.stageType → nodeTypeKey 类型重命名

**HANDLER_CAPABILITIES 处理**: 这个集合（claude-runner.ts:366）原本判断"capability 走 handler-path 还是通用对话"。phase 3 后，capability 不再表示节点，而是 LLM agent 配置库。这个集合的逻辑仍合理（决定 agent 走哪条入口路径），但**变量名应改**：

- 改名 `HANDLER_CAPABILITIES` → `HANDLER_AGENT_KEYS` 或 `DIRECT_HANDLER_AGENTS`
- 注释更新："这些 agent 走 handler-path（直接调对应代码 handler），其它走 IM 通用对话路径"
- 内容不变（analyze_bug / fix_bug_l* / ai_review_mr / search_knowledge / prd_submit）

```
feat(pipeline): capability 节点重命名为 llm_agent + HANDLER_CAPABILITIES 改名
```

---

## Task 18: 前端 NodeInspector 动态参数表单（JSON Schema 驱动）

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

T18 是前端 P1 主体：从 hardcoded stage-specific 字段改为按 `paramSchema` 动态渲染。

逻辑骨架：

```tsx
function DynamicParamsForm({ schema, value, onChange }: { schema: any, value: any, onChange: (v: any) => void }) {
  if (!schema || schema.type !== 'object') return null
  const props = schema.properties ?? {}
  return (
    <Form layout="vertical">
      {Object.entries(props).map(([key, fieldSchema]: [string, any]) => (
        <Form.Item key={key} label={fieldSchema.title ?? key} required={schema.required?.includes(key)}>
          {renderField(fieldSchema, value?.[key], (v: any) => onChange({ ...value, [key]: v }))}
        </Form.Item>
      ))}
    </Form>
  )
}

function renderField(fieldSchema: any, value: any, onChange: (v: any) => void) {
  if (fieldSchema.enum) return <Select value={value} onChange={onChange} options={fieldSchema.enum.map((e: string) => ({label: e, value: e}))} />
  if (fieldSchema.type === 'string' && fieldSchema.format === 'textarea') return <Input.TextArea value={value} onChange={e => onChange(e.target.value)} rows={4} />
  if (fieldSchema.type === 'string' && fieldSchema['x-source']) return <DynamicSourceSelect source={fieldSchema['x-source']} value={value} onChange={onChange} />
  if (fieldSchema.type === 'string') return <Input value={value} onChange={e => onChange(e.target.value)} />
  if (fieldSchema.type === 'number') return <InputNumber value={value} onChange={onChange} />
  if (fieldSchema.type === 'boolean') return <Switch checked={value} onChange={onChange} />
  if (fieldSchema.type === 'array' && fieldSchema.items?.type === 'string') return <Select mode="tags" value={value ?? []} onChange={onChange} />
  if (fieldSchema.type === 'object') return <Input.TextArea value={JSON.stringify(value ?? {}, null, 2)} onChange={e => { try { onChange(JSON.parse(e.target.value)) } catch { /* keep typing */ } }} rows={6} />
  return <Input value={JSON.stringify(value)} disabled />
}

function DynamicSourceSelect({ source, value, onChange }: any) {
  const [options, setOptions] = useState<{label: string, value: string}[]>([])
  useEffect(() => {
    if (source === 'capabilities') listCapabilities().then(c => setOptions(c.map(x => ({label: x.displayName, value: x.key}))))
    if (source === 'pipelines') /* listPipelines() */
  }, [source])
  return <Select value={value} onChange={onChange} options={options} showSearch />
}
```

接入 NodeInspector：选中节点后，从 nodeTypes 列表查到当前 nodeType 的 paramSchema → 用 DynamicParamsForm 渲染 → onChange 写回 node.params。

⚠️ 现有 NodeInspector 有大量 stage-specific 字段（比如 capability 的 capabilityKey 选择器、approval 的 approverIdsResolver 选择器）。**保留这些专用字段作为 fallback**——当 paramSchema 不能完整表达时（比如 approval 的动态 resolver），仍走专用 UI。逻辑：先按 paramSchema 渲染，特殊字段额外覆盖。

⚠️ stale 兼容（CLAUDE.md "前端表单：枚举字段下拉规范"）：DynamicSourceSelect 应包含 stale-value compat（值不在列表时显示警告 tag）。

```
feat(canvas): NodeInspector 动态参数表单(JSON Schema 驱动)
```

---

## Task 19: 前端 retry/fan_out 高级配置 UI

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

加折叠面板"重试与流程控制":
- retryCount: InputNumber, 默认 0
- retryWhen: Input, placeholder `output.statusCode >= 500`
- retryDelayMs: InputNumber, 默认 1000
- onFailure: Select 'stop' | 'continue'

fan_out 节点专用 inspector（当 nodeTypeKey === 'fan_out' 时显示）:
- source: Input, placeholder `{{steps.x.output.items}}`
- as: Input, placeholder `item`
- parallel: InputNumber, 默认 3
- onItemFailure: Select continue/stop/aggregate
- body: 从画布上未连入主图的"游离"节点 + 拖入子图边界（具体 UI 看 PipelineCanvasPage 的现有结构）

```
feat(canvas): NodeInspector retry / fan_out 高级配置 UI
```

---

## Task 20: 集成测试 + 冒烟手册

**Files:**
- Create: `docs/smoke-pipeline-dsl.md`

冒烟手册覆盖 6 项：
1. **DB 状态**：12 节点类型存在；test_pipelines.graph 内 'capability' 都已迁为 'llm_agent'
2. **现有 pipeline 行为零回归**：跑 deploy-im-demo pipeline 三阶段（im_input + approval + llm_agent）
3. **写一条 demo pipeline 串新节点**：fan_out + http + sql_query + dm 各节点联动
4. **retry_when 表达式**：节点失败后按表达式判断是否重试
5. **fan_out 子运行**：3 项数组扇出，parallel=2，验证并发 + 输出聚合
6. **前端**：节点选择器 12 类型；切换不同类型，参数表单按 paramSchema 动态渲染

```
docs(smoke): phase 3 DSL 增强冒烟手册
```

---

## phase 3 Definition of Done

- [ ] schema-v34 + v35 应用，pipeline_node_types 12 行
- [ ] `pnpm test` baseline 6 fail（dingtalk-sync）保持
- [ ] `pnpm typecheck` 干净
- [ ] `cd web && pnpm build` 干净
- [ ] `grep -nE "writeCapabilities|CODE_CAPABILITIES|FAILURE_MSGS|CAP_NAMES|HANDLER_CAPABILITIES" src/agent/claude-runner.ts`：HANDLER_CAPABILITIES 已改名 HANDLER_AGENT_KEYS（或类似）
- [ ] `grep -n "switch (node.stageType)" src/pipeline/graph-builder.ts`：无输出（dispatch 已切到 NodeExecutor）
- [ ] `grep -rn "'capability'" src/pipeline/`：无输出（节点 key 全部 'llm_agent'）
- [ ] 20 commit 清晰提交
- [ ] 冒烟手册 6 项全过

phase 3 完成后启动 phase 4 sub-plan（handler 迁移：create_mr / notify_bug / request_handover 改成 pipeline DAG，feature flag 双轨切）。
