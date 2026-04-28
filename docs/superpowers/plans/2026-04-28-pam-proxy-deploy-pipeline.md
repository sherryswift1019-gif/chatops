# PAM Proxy 部署流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付三项能力：① llm_agent 节点支持自定义 prompt + 工具的 custom 模式；② 通用 diagnose_and_repair capability；③ PAM Proxy 部署流水线 DB 种子。

**Architecture:** custom agent 模式在 `StageHooks` 中新增 `runCustomAgent` 钩子，`buildCapabilityNode` 根据 `stage.agentMode` 分支路由；`diagnose_and_repair` 是一个标准 capability handler，通过 `registerCapabilityHandler` 注册；流水线通过 schema 迁移写入 `test_pipelines.graph` JSONB。

**Tech Stack:** TypeScript + Fastify 5 + React 18 + Ant Design 5 + PostgreSQL（raw SQL）+ @snack-kit/porygon（Claude CLI 调用）

---

## 文件地图

**创建：**
- `src/agent/repair/diagnose-repair-handler.ts` — diagnose_and_repair capability 的 handler
- `src/db/schema-v51.sql` — INSERT diagnose_and_repair capability 记录
- `src/db/schema-v52.sql` — INSERT PAM Proxy 部署流水线（graph JSONB）
- `src/__tests__/unit/custom-agent-node.test.ts` — custom agent 模式类型 + 验证单测
- `src/__tests__/unit/diagnose-repair-handler.test.ts` — diagnose_and_repair handler 单测

**修改：**
- `src/pipeline/types.ts` — StageDefinition 加 `agentMode / customPrompt / allowedTools`
- `src/pipeline/graph-validation.ts` — custom 模式验证规则
- `src/pipeline/graph-builder.ts` — StageHooks 加 `runCustomAgent`；`buildCapabilityNode` 分支路由
- `src/pipeline/executor-hooks.ts` — 实现 `runCustomAgent` 钩子（porygon 直调）
- `src/pipeline/dryrun-hash.ts` — hash 计算加入新字段
- `src/pipeline/executor.ts` — triggerParams 注入 `imPlatform / imGroupId / imUserId`
- `src/db/migrate.ts` — SCHEMA_FILES 追加 schema-v51、schema-v52
- `src/__tests__/helpers/db.ts` — SCHEMA_FILES 追加 schema-v51（schema-v52 含业务种子，不加测试库）
- `src/server.ts` — import diagnose-repair-handler
- `web/src/pipeline-canvas/panels/NodeInspector.tsx` — llm_agent 节点加模式切换 UI

---

## Task 1：StageDefinition 类型 + 验证

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/pipeline/graph-validation.ts`
- Create: `src/__tests__/unit/custom-agent-node.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/unit/custom-agent-node.test.ts
import { describe, it, expect } from 'vitest'
import { validatePipelineGraph } from '../../pipeline/graph-validation.js'
import type { PipelineGraph } from '../../pipeline/types.js'

function makeNode(overrides: Record<string, unknown>) {
  return {
    id: 'node-1',
    position: { x: 0, y: 0 },
    name: 'test',
    stageType: 'llm_agent',
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 60,
    retryCount: 0,
    onFailure: 'stop',
    ...overrides,
  }
}

describe('llm_agent custom mode validation', () => {
  it('capability 模式：capabilityKey 必填', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'capability' }) as any], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/capabilityKey/)
  })

  it('capability 模式：capabilityKey 存在则通过', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'capability', capabilityKey: 'deploy' }) as any], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(true)
  })

  it('custom 模式：customPrompt 必填', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'custom' }) as any], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/customPrompt/)
  })

  it('custom 模式：customPrompt 存在则通过，capabilityKey 可为空', () => {
    const g: PipelineGraph = { nodes: [makeNode({ agentMode: 'custom', customPrompt: 'hello' }) as any], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(true)
  })

  it('agentMode 缺省时走 capability 路径（向后兼容）', () => {
    const g: PipelineGraph = { nodes: [makeNode({ capabilityKey: 'deploy' }) as any], edges: [] }
    const r = validatePipelineGraph(g)
    expect(r.valid).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npx vitest run src/__tests__/unit/custom-agent-node.test.ts
```
Expected: 编译错误或测试失败（类型/函数缺失）

- [ ] **Step 3: 在 types.ts 的 StageDefinition 接口加新字段**

在 `src/pipeline/types.ts` 第 28 行 `export interface StageDefinition {` 内部、`outputFormat` 字段之后加：

```typescript
  // llm_agent custom 模式
  agentMode?: 'capability' | 'custom'
  customPrompt?: string
  allowedTools?: string[]
```

- [ ] **Step 4: 在 graph-validation.ts 更新 llm_agent 验证规则**

找到 `graph-validation.ts` 中校验 `llm_agent` 节点的代码段（约在 `capabilityKey is required` 附近，grep `capabilityKey`），将原有验证替换为：

```typescript
// 原代码（约第 228-233 行）：
//   if (!n.capabilityKey || !n.capabilityKey.trim()) {
//     return `${prefix}: capabilityKey is required`
//   }
// 替换为：
const mode = n.agentMode ?? 'capability'
if (mode === 'capability') {
  if (!n.capabilityKey || !n.capabilityKey.trim()) {
    return `${prefix}: capabilityKey is required for agentMode='capability'`
  }
} else if (mode === 'custom') {
  if (!n.customPrompt || !n.customPrompt.trim()) {
    return `${prefix}: customPrompt is required for agentMode='custom'`
  }
} else {
  return `${prefix}: agentMode must be 'capability' or 'custom'`
}
```

- [ ] **Step 5: 跑测试，确认全通过**

```bash
npx vitest run src/__tests__/unit/custom-agent-node.test.ts
```
Expected: 5 passed

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/graph-validation.ts src/__tests__/unit/custom-agent-node.test.ts
git commit -m "feat(pipeline): llm_agent 节点增加 agentMode/customPrompt/allowedTools 类型 + 验证"
```

---

## Task 2：Custom Agent 执行路径（后端）

**Files:**
- Modify: `src/pipeline/graph-builder.ts`（StageHooks + buildCapabilityNode）
- Modify: `src/pipeline/executor-hooks.ts`（runCustomAgent 实现）
- Modify: `src/pipeline/dryrun-hash.ts`

- [ ] **Step 1: 在 StageHooks 接口加 runCustomAgent**

在 `src/pipeline/graph-builder.ts` 的 `StageHooks` 接口（约第 59 行）中，在 `runCapability?` 之后加：

```typescript
  runCustomAgent?(
    stage: StageDefinition,
    ctx: StageContext,
    triggerParams?: Record<string, unknown>,
    runtimeVars?: Record<string, unknown>,
  ): Promise<StageExecutionResult>
```

- [ ] **Step 2: 在 buildCapabilityNode 分支路由**

在 `buildCapabilityNode`（约第 315 行）将 `if (!hooks.runCapability)` 分支替换为：

```typescript
    const mode = stage.agentMode ?? 'capability'
    if (mode === 'custom') {
      if (!hooks.runCustomAgent) {
        exec = { status: 'failed', output: 'custom agent hook not configured', error: 'no_hook' }
      } else {
        exec = await hooks.runCustomAgent(stage, ctx, triggerParams, runtimeVars)
      }
    } else {
      if (!hooks.runCapability) {
        exec = { status: 'failed', output: 'capability hook not configured', error: 'no_hook' }
      } else {
        exec = await hooks.runCapability(stage, ctx, triggerParams, runtimeVars)
      }
    }
```

- [ ] **Step 3: 在 executor-hooks.ts 实现 runCustomAgent**

在 `executor-hooks.ts` 文件顶部 import 区新增：

```typescript
import { createPorygon } from '@snack-kit/porygon'
import { buildClaudeEnv } from '../agent/claude-config.js'
```

在 `export function createStageHooks(...)` 返回对象内、`runCapability` 之后，新增 `runCustomAgent` 方法：

```typescript
    async runCustomAgent(
      stage: StageDefinition,
      ctx: StageContext,
      triggerParams: Record<string, unknown> = {},
      runtimeVars: Record<string, unknown> = {},
    ): Promise<StageExecutionResult> {
      const rawPrompt = stage.customPrompt ?? ''
      if (!rawPrompt.trim()) {
        return { status: 'failed', output: '', error: 'customPrompt is empty' }
      }
      // 展开 {{triggerParams.xxx}} / {{vars.xxx}} 模板
      const resolvedParams = resolveCapabilityParams({ _prompt: rawPrompt }, triggerParams, runtimeVars)
      const prompt = String(resolvedParams._prompt ?? rawPrompt)

      const allowedTools = Array.isArray(stage.allowedTools) && stage.allowedTools.length > 0
        ? stage.allowedTools
        : undefined

      const timeoutMs = (stage.timeoutSeconds ?? 120) * 1000

      const porygon = createPorygon({
        defaultBackend: 'claude',
        backends: {
          claude: {
            model: 'sonnet',
            interactive: false,
            cliPath: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin', 'claude'),
          },
        },
        defaults: { timeoutMs, maxTurns: 10 },
      })

      try {
        const result = await porygon.run({
          prompt,
          ...(allowedTools ? { onlyTools: allowedTools } : {
            disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
          }),
          envVars: await buildClaudeEnv(),
        })
        return { status: 'success', output: result.trim() }
      } catch (err) {
        return { status: 'failed', output: '', error: String(err) }
      }
    },
```

> 注：`join / dirname / fileURLToPath` 在该文件顶部已有 import（跟 sshExec log 目录同一模式），如无则补充：`import { dirname, join } from 'path'; import { fileURLToPath } from 'url'`。

- [ ] **Step 4: 更新 dryrun-hash.ts，将新字段纳入 hash**

在 `src/pipeline/dryrun-hash.ts` 中，找到节点 hash 计算处（grep `capabilityKey`），在同一处追加：

```typescript
agentMode: (n as { agentMode?: string }).agentMode,
customPrompt: (n as { customPrompt?: string }).customPrompt,
allowedTools: (n as { allowedTools?: string[] }).allowedTools,
```

- [ ] **Step 5: 验证类型编译无错**

```bash
cd /Users/yan/Documents/Code/chatops && npx tsc --noEmit 2>&1 | head -30
```
Expected: 无错误（或只有已有的已知警告）

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/graph-builder.ts src/pipeline/executor-hooks.ts src/pipeline/dryrun-hash.ts
git commit -m "feat(pipeline): custom agent 执行路径——runCustomAgent hook + buildCapabilityNode 路由"
```

---

## Task 3：Frontend NodeInspector custom agent UI

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

- [ ] **Step 1: 找到 llm_agent 节点在 NodeInspector 中的渲染位置**

```bash
grep -n "llm_agent\|capabilityKey\|capability" web/src/pipeline-canvas/panels/NodeInspector.tsx | head -20
```

记录 `capabilityKey` 的 Form.Item 所在行号（后续替换该区块）。

- [ ] **Step 2: 将 capabilityKey 字段区块替换为带模式切换的表单**

在 NodeInspector.tsx 中，找到 `llm_agent` 对应的 `capabilityKey` Select 字段块（大概是一个 `case 'llm_agent':` 或 `stageType === 'llm_agent'` 条件分支）。将原有 capabilityKey Select 替换为：

```tsx
{/* agentMode 切换 */}
<Form.Item label="模式" name="agentMode" initialValue="capability">
  <Radio.Group>
    <Radio.Button value="capability">已有能力</Radio.Button>
    <Radio.Button value="custom">自定义</Radio.Button>
  </Radio.Group>
</Form.Item>

<Form.Item noStyle shouldUpdate={(prev, curr) => prev.agentMode !== curr.agentMode}>
  {({ getFieldValue }) => {
    const mode = getFieldValue('agentMode') ?? 'capability'
    if (mode === 'custom') {
      return (
        <>
          <Form.Item
            label="系统提示词"
            name="customPrompt"
            rules={[{ required: true, message: '自定义模式必须填写提示词' }]}
          >
            <Input.TextArea rows={6} placeholder="告诉 Claude 要做什么。支持 {{triggerParams.xxx}} 模板变量。" />
          </Form.Item>
          <Form.Item label="可用工具" name="allowedTools">
            <Select
              mode="multiple"
              placeholder="不选则继承默认（禁用文件读写）"
              options={[
                { value: 'WebFetch', label: 'WebFetch（HTTP 抓取）' },
                { value: 'WebSearch', label: 'WebSearch（搜索）' },
              ]}
            />
          </Form.Item>
          <Form.Item label="输出格式" name="outputFormat" initialValue="string">
            <Select options={[
              { value: 'string', label: 'string（原始文本）' },
              { value: 'json', label: 'json（解析为对象，供下游 {{steps.X.output.field}} 引用）' },
            ]} />
          </Form.Item>
        </>
      )
    }
    // 原有 capability 模式
    return (
      <Form.Item
        label="能力"
        name="capabilityKey"
        rules={[{ required: true, message: '请选择 capability' }]}
      >
        {/* 原有 capabilityKey Select，保持不变 */}
        {existingCapabilityKeySelect}
      </Form.Item>
    )
  }}
</Form.Item>
```

> `existingCapabilityKeySelect` 是原有的 capabilityKey Select 组件（含 stale 兼容逻辑），按现有代码保留，不改内容，只移入此 `if` 分支。

> `Radio.Group / Input.TextArea / Select` 来自 `antd`，如未 import 则在文件顶部补充。

- [ ] **Step 3: 前端类型检查**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```
Expected: 无新增错误

- [ ] **Step 4: 启动前端 dev server 手工验证**

```bash
cd web && pnpm dev
```
在画布里添加一个 `llm_agent` 节点，Inspector 里应能看到「已有能力/自定义」切换，切到「自定义」后出现提示词 TextArea 和工具多选。

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/panels/NodeInspector.tsx
git commit -m "feat(frontend): llm_agent 节点 NodeInspector 增加 custom 模式 UI（提示词 + 工具白名单）"
```

---

## Task 4：triggerParams 注入 IM 上下文

**Files:**
- Modify: `src/pipeline/executor.ts`

- [ ] **Step 1: 找到 triggerParams 赋值处**

```bash
grep -n "triggerParams\|imContext" src/pipeline/executor.ts | head -20
```

定位到约第 71-73 行：
```typescript
const triggerParams = trigger.params
const imContext: ImTriggerContext | undefined = extractImContext(trigger)
```

- [ ] **Step 2: 将 triggerParams 扩展以注入 IM 上下文**

将上述两行替换为：

```typescript
const imContext: ImTriggerContext | undefined = extractImContext(trigger)
const triggerParams: Record<string, unknown> = {
  ...trigger.params,
  ...(imContext
    ? {
        imPlatform: imContext.platform,
        imGroupId: imContext.groupId,
        imUserId: imContext.userId,
      }
    : {}),
}
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "executor.ts" | head -10
```
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/executor.ts
git commit -m "fix(pipeline): IM 触发时将 imPlatform/imGroupId/imUserId 注入 triggerParams，供 dm 节点模板引用"
```

---

## Task 5：diagnose_and_repair Capability

**Files:**
- Create: `src/agent/repair/diagnose-repair-handler.ts`
- Create: `src/db/schema-v51.sql`
- Create: `src/__tests__/unit/diagnose-repair-handler.test.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: 写失败测试（handler 单元测试，mock triggerCapability）**

```typescript
// src/__tests__/unit/diagnose-repair-handler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// handler 会 registerCapabilityHandler，我们只测 buildPrompt 逻辑（纯函数）
// 从 handler 文件 export buildDiagnosePrompt 供测试

import { buildDiagnosePrompt } from '../../agent/repair/diagnose-repair-handler.js'

describe('buildDiagnosePrompt', () => {
  it('包含 failedCommand', () => {
    const p = buildDiagnosePrompt({
      failedCommand: 'PAM_ADDRESS=x ./install.sh',
      stdout: 'starting...',
      stderr: 'error: port in use',
      serverHost: '10.0.0.1',
      maxRetries: 4,
    })
    expect(p).toContain('PAM_ADDRESS=x ./install.sh')
    expect(p).toContain('10.0.0.1')
    expect(p).toContain('port in use')
    expect(p).toContain('4')
  })

  it('maxRetries 默认值为 4', () => {
    const p = buildDiagnosePrompt({
      failedCommand: 'cmd',
      stdout: '',
      stderr: '',
      serverHost: 'host',
    })
    expect(p).toContain('4')
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npx vitest run src/__tests__/unit/diagnose-repair-handler.test.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 handler 文件**

```typescript
// src/agent/repair/diagnose-repair-handler.ts
import { registerCapabilityHandler } from '../coordinator.js'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { createPorygon } from '@snack-kit/porygon'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildClaudeEnv } from '../claude-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface DiagnoseParams {
  failedCommand: string
  stdout: string
  stderr: string
  serverHost: string
  maxRetries?: number
}

export function buildDiagnosePrompt(params: DiagnoseParams): string {
  const { failedCommand, stdout, stderr, serverHost, maxRetries = 4 } = params
  return `你是一个 DevOps 故障修复专家。以下命令在服务器 ${serverHost} 上执行失败，请分析原因并施以修复，然后重新执行该命令，最多重试 ${maxRetries} 次。

## 失败的命令
\`\`\`
${failedCommand}
\`\`\`

## 标准输出（stdout）
\`\`\`
${stdout || '（空）'}
\`\`\`

## 错误输出（stderr）
\`\`\`
${stderr || '（空）'}
\`\`\`

## 执行要求
1. 使用 check_env_status 或 get_logs 工具 SSH 到 ${serverHost} 诊断根因
2. 施以修复（清残留文件 / 停冲突进程 / 修复依赖等）
3. 重新执行上述命令，检查退出码
4. 若仍失败则再次分析修复，最多重试 ${maxRetries} 次
5. 最终以 JSON 格式返回：{"success": true/false, "attempts": N, "summary": "修复摘要"}`
}

async function handleDiagnoseAndRepair(opts: TriggerOptions): Promise<TriggerResult> {
  const p = (opts.extraParams ?? {}) as Partial<DiagnoseParams>
  const params: DiagnoseParams = {
    failedCommand: String(p.failedCommand ?? ''),
    stdout: String(p.stdout ?? ''),
    stderr: String(p.stderr ?? ''),
    serverHost: String(p.serverHost ?? ''),
    maxRetries: typeof p.maxRetries === 'number' ? p.maxRetries : 4,
  }

  if (!params.failedCommand || !params.serverHost) {
    return { success: false, error: 'diagnose_and_repair: failedCommand 和 serverHost 必填' }
  }

  const porygon = createPorygon({
    defaultBackend: 'claude',
    backends: {
      claude: {
        model: 'sonnet',
        interactive: false,
        cliPath: join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'claude'),
      },
    },
    defaults: { timeoutMs: (params.maxRetries + 1) * 5 * 60_000, maxTurns: 30 },
  })

  try {
    const result = await porygon.run({
      prompt: buildDiagnosePrompt(params),
      disallowedTools: ['Edit', 'Write', 'Glob', 'Grep', 'Read'],
      envVars: await buildClaudeEnv(),
    })
    return { success: true, output: result.trim() }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

registerCapabilityHandler('diagnose_and_repair', handleDiagnoseAndRepair)
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
npx vitest run src/__tests__/unit/diagnose-repair-handler.test.ts
```
Expected: 2 passed

- [ ] **Step 5: 创建 schema-v51.sql**

```sql
-- v51: diagnose_and_repair 通用修复 capability
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval)
VALUES (
  'diagnose_and_repair',
  '诊断并修复',
  '分析失败步骤的日志，通过 SSH 工具施以修复并重试，最多 N 次（默认 4）',
  'action',
  '["check_env_status", "get_logs"]'::jsonb,
  false
)
ON CONFLICT (key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description;
```

- [ ] **Step 6: 在 migrate.ts 追加 schema-v51**

在 `src/db/migrate.ts` 的 `SCHEMA_FILES` 数组末尾追加：
```typescript
'schema-v51.sql',
```

- [ ] **Step 7: 在 db.ts 测试辅助文件追加 schema-v51**

在 `src/__tests__/helpers/db.ts` 的测试库 `SCHEMA_FILES` 末尾追加：
```typescript
'schema-v51.sql',
```

- [ ] **Step 8: 在 server.ts import handler**

在 `src/server.ts` 中，找到其他 handler 的 import 区域（grep `repair\|analyze\|notify.*handler`），追加：

```typescript
import './agent/repair/diagnose-repair-handler.js'
```

- [ ] **Step 9: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: 无新增错误

- [ ] **Step 10: Commit**

```bash
git add src/agent/repair/diagnose-repair-handler.ts \
        src/db/schema-v51.sql \
        src/db/migrate.ts \
        src/__tests__/helpers/db.ts \
        src/__tests__/unit/diagnose-repair-handler.test.ts \
        src/server.ts
git commit -m "feat: diagnose_and_repair capability——handler + DB 迁移 + server 注册"
```

---

## Task 6：PAM Proxy 部署流水线 DB 种子

**Files:**
- Create: `src/db/schema-v52.sql`
- Modify: `src/db/migrate.ts`

> schema-v52 含业务种子数据，**不加入** `src/__tests__/helpers/db.ts`（避免污染测试库）。

- [ ] **Step 1: 生成 8 个节点的固定 ULID**

以下 ULID 在种子中固定使用（生产环境通过画布自动分配，种子用固定值保证幂等）：

| 节点 | ULID |
|------|------|
| IM 参数采集 | `01HPAM00000000000000000001` |
| 清理旧部署 | `01HPAM00000000000000000002` |
| 分析选择安装包 | `01HPAM00000000000000000003` |
| 下载并解压 | `01HPAM00000000000000000004` |
| 执行安装 | `01HPAM00000000000000000005` |
| 诊断修复 | `01HPAM00000000000000000006` |
| 通知成功 | `01HPAM00000000000000000007` |
| 通知失败 | `01HPAM00000000000000000008` |

- [ ] **Step 2: 创建 schema-v52.sql**

```sql
-- v52: PAM Proxy 部署流水线种子
-- 绑定到第一个产线（生产运维请在管理后台手动移动到正确产线）
-- 幂等：同名已存在则更新 graph
DO $$
DECLARE
  v_pl_id   INTEGER;
  v_pipe_id INTEGER;
  v_graph   JSONB;
BEGIN
  SELECT id INTO v_pl_id FROM product_lines ORDER BY id LIMIT 1;
  IF v_pl_id IS NULL THEN
    RAISE NOTICE 'schema-v52: no product_lines found, skipping PAM Proxy pipeline seed';
    RETURN;
  END IF;

  v_graph := $graph${
    "nodes": [
      {
        "id": "01HPAM00000000000000000001",
        "name": "IM 参数采集",
        "stageType": "im_input",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 600,
        "retryCount": 0,
        "onFailure": "stop",
        "position": {"x": 100, "y": 100},
        "imInputConfig": {
          "prompt": "请提供 PAM Proxy 部署信息：\n- branch（分支名，如 main）\n- env（环境，如 staging / prod）\n- pam_address（PAM 服务地址，如 192.168.1.100:8080）",
          "paramSchema": {
            "type": "object",
            "required": ["branch", "env", "pam_address"],
            "properties": {
              "branch":      {"type": "string", "title": "分支"},
              "env":         {"type": "string", "title": "环境", "enum": ["staging", "prod"]},
              "pam_address": {"type": "string", "title": "PAM_ADDRESS"}
            }
          },
          "timeoutSeconds": 600
        }
      },
      {
        "id": "01HPAM00000000000000000002",
        "name": "清理旧部署",
        "stageType": "script",
        "targetRoles": ["proxy"],
        "parallel": false,
        "timeoutSeconds": 120,
        "retryCount": 0,
        "onFailure": "stop",
        "position": {"x": 100, "y": 250},
        "script": "# TODO: 清理脚本待提供\necho '清理完成（placeholder）'"
      },
      {
        "id": "01HPAM00000000000000000003",
        "name": "分析选择安装包",
        "stageType": "llm_agent",
        "agentMode": "custom",
        "allowedTools": ["WebFetch"],
        "outputFormat": "json",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 60,
        "retryCount": 0,
        "onFailure": "stop",
        "position": {"x": 100, "y": 400},
        "customPrompt": "请访问以下 URL 获取安装包文件列表：\nhttp://10.10.2.234:8000/pam/deploy/Proxy-Deploy/{{triggerParams.branch}}?json=true\n\n从返回的 files 数组中，找出 mtime 最大的、文件名不以 .sha256 结尾的文件。\n\n只返回以下 JSON，不要任何其他内容：\n{\"filename\": \"<文件名>\", \"downloadUrl\": \"http://10.10.2.234:8000/pam/deploy/Proxy-Deploy/{{triggerParams.branch}}/<文件名>\"}"
      },
      {
        "id": "01HPAM00000000000000000004",
        "name": "下载并解压",
        "stageType": "script",
        "targetRoles": ["proxy"],
        "parallel": false,
        "timeoutSeconds": 300,
        "retryCount": 0,
        "onFailure": "stop",
        "position": {"x": 100, "y": 550},
        "script": "curl -fSL \"{{steps.01HPAM00000000000000000003.output.downloadUrl}}\" -o /tmp/pam-proxy-deploy.tar.gz\nmkdir -p /tmp/pam-proxy-deploy\ntar -xzf /tmp/pam-proxy-deploy.tar.gz -C /tmp/pam-proxy-deploy --strip-components=1"
      },
      {
        "id": "01HPAM00000000000000000005",
        "name": "执行安装",
        "stageType": "script",
        "targetRoles": ["proxy"],
        "parallel": false,
        "timeoutSeconds": 300,
        "retryCount": 0,
        "onFailure": "continue",
        "position": {"x": 100, "y": 700},
        "script": "cd /tmp/pam-proxy-deploy\nPAM_ADDRESS={{triggerParams.pam_address}} ./install.sh"
      },
      {
        "id": "01HPAM00000000000000000006",
        "name": "诊断修复",
        "stageType": "llm_agent",
        "agentMode": "capability",
        "capabilityKey": "diagnose_and_repair",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 1200,
        "retryCount": 0,
        "onFailure": "continue",
        "position": {"x": 350, "y": 700},
        "capabilityParams": {
          "failedCommand": "cd /tmp/pam-proxy-deploy && PAM_ADDRESS={{triggerParams.pam_address}} ./install.sh",
          "stdout": "{{steps.01HPAM00000000000000000005.output.stdout}}",
          "stderr": "{{steps.01HPAM00000000000000000005.output.stderr}}",
          "serverHost": "{{server.host}}",
          "maxRetries": 4
        }
      },
      {
        "id": "01HPAM00000000000000000007",
        "name": "通知成功",
        "stageType": "dm",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 30,
        "retryCount": 0,
        "onFailure": "continue",
        "position": {"x": 100, "y": 850},
        "params": {
          "platform": "{{triggerParams.imPlatform}}",
          "userId": "{{triggerParams.imUserId}}",
          "text": "✅ PAM Proxy 部署成功 | 分支: {{triggerParams.branch}} | 环境: {{triggerParams.env}} | 地址: {{triggerParams.pam_address}}"
        }
      },
      {
        "id": "01HPAM00000000000000000008",
        "name": "通知失败",
        "stageType": "dm",
        "targetRoles": [],
        "parallel": false,
        "timeoutSeconds": 30,
        "retryCount": 0,
        "onFailure": "continue",
        "position": {"x": 350, "y": 850},
        "params": {
          "platform": "{{triggerParams.imPlatform}}",
          "userId": "{{triggerParams.imUserId}}",
          "text": "❌ PAM Proxy 部署失败，已重试 4 次，请人工介入 | 分支: {{triggerParams.branch}} | 环境: {{triggerParams.env}}"
        }
      }
    ],
    "edges": [
      {"id": "e01", "source": "01HPAM00000000000000000001", "target": "01HPAM00000000000000000002"},
      {"id": "e02", "source": "01HPAM00000000000000000002", "target": "01HPAM00000000000000000003"},
      {"id": "e03", "source": "01HPAM00000000000000000003", "target": "01HPAM00000000000000000004"},
      {"id": "e04", "source": "01HPAM00000000000000000004", "target": "01HPAM00000000000000000005"},
      {"id": "e05", "source": "01HPAM00000000000000000005", "target": "01HPAM00000000000000000007", "condition": {"kind": "onSuccess"}},
      {"id": "e06", "source": "01HPAM00000000000000000005", "target": "01HPAM00000000000000000006", "condition": {"kind": "onFailure"}},
      {"id": "e07", "source": "01HPAM00000000000000000006", "target": "01HPAM00000000000000000007", "condition": {"kind": "onSuccess"}},
      {"id": "e08", "source": "01HPAM00000000000000000006", "target": "01HPAM00000000000000000008", "condition": {"kind": "onFailure"}}
    ]
  }$graph$::jsonb;

  -- 查重或插入
  SELECT id INTO v_pipe_id
    FROM test_pipelines
    WHERE product_line_id = v_pl_id AND name = 'PAM Proxy部署';

  IF v_pipe_id IS NULL THEN
    INSERT INTO test_pipelines (product_line_id, name, description, stages, graph, enabled)
    VALUES (
      v_pl_id,
      'PAM Proxy部署',
      'IM 驱动的 PAM Proxy 部署：参数采集 → 清理 → 选包 → 下载解压 → 安装（LLM 修复重试）→ 通知',
      '[]'::jsonb,
      v_graph,
      true
    )
    RETURNING id INTO v_pipe_id;
    RAISE NOTICE 'schema-v52: PAM Proxy部署 pipeline created id=%', v_pipe_id;
  ELSE
    UPDATE test_pipelines SET graph = v_graph, updated_at = NOW() WHERE id = v_pipe_id;
    RAISE NOTICE 'schema-v52: PAM Proxy部署 pipeline updated id=%', v_pipe_id;
  END IF;
END $$;
```

- [ ] **Step 3: 在 migrate.ts 追加 schema-v52**

在 `src/db/migrate.ts` 的 `SCHEMA_FILES` 数组末尾追加：
```typescript
'schema-v52.sql',
```

- [ ] **Step 4: 验证迁移 SQL 语法（本地）**

```bash
pnpm migrate 2>&1 | tail -20
```
Expected: `schema-v51.sql` 和 `schema-v52.sql` 应用成功，无 SQL 错误。若无 product_lines 则输出 NOTICE 跳过（正常）。

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v52.sql src/db/migrate.ts
git commit -m "feat(db): PAM Proxy部署流水线 DB 种子（schema-v52）"
```

---

## Task 7：完整回归验证

- [ ] **Step 1: 跑全量单测**

```bash
./test.sh 2>&1 | tail -30
```
Expected: 全部通过，无新增失败。

- [ ] **Step 2: 前端类型检查**

```bash
cd web && pnpm build 2>&1 | tail -20
```
Expected: 构建成功，无 TypeScript 错误。

- [ ] **Step 3: 验证自定义 agent 节点端到端（画布）**

1. 启动 `pnpm dev`
2. 打开管理后台 → 流水线 → 找到「PAM Proxy部署」
3. 打开画布，点击节点「分析选择安装包」，Inspector 应显示「自定义」模式、提示词、工具为 WebFetch
4. 点击节点「诊断修复」，Inspector 应显示「已有能力」模式、capabilityKey=diagnose_and_repair

- [ ] **Step 4: Final commit（如有改动）**

```bash
git add -p  # 只 stage 本次改动
git commit -m "chore: PAM Proxy 部署流水线 -- 回归验证完成"
```

---

## 已知限制与后续事项

| 项 | 说明 |
|----|------|
| 清理脚本 | 节点 2「清理旧部署」脚本为 placeholder，待运维提供后直接在画布编辑 |
| WebFetch HTTP 支持 | Claude CLI `WebFetch` 工具是否支持 `http://` 需在测试环境验证；若不支持需额外添加 `fetch_url` MCP 工具 |
| PAM Proxy 流水线产线绑定 | schema-v52 绑到第一个产线，生产环境应在管理后台手动移到正确产线，并在 IM trigger 里绑定 capability key |
| dm 节点群消息 | 当前 dm 节点发私信给触发用户，群消息能力待 dm 节点扩展后补充 |
| 审批节点 | pipeline 未含审批，后续由审批规则 capability 统一处理 |
