# Pipeline Switch 节点设计

**日期**：2026-04-27
**状态**：spec 待 review → implementation
**作者**：与用户共商（brainstorming 流程）
**上游讨论**：用户提出现有流水线缺分支节点；现状是边上挂 condition + 白名单 2 模板（`status === 'X'` / `output.includes('X')`），LLM 结构化产出无法路由

## 1. 目标

在 pipeline 引擎里新增一个独立的 **switch 分支节点**，让流水线能基于上游节点（特别是 LLM agent）的结构化产出做条件路由。

**核心使用场景**：LLM 节点识别意图后产出 JSON（如 `{ intent: 'rollback', score: 90 }`），switch 节点按表达式自动路由到回滚 / 部署 / 人工复核等不同下游分支。

**非目标（v1 不做）**：
- 并行 gateway（多分支同时进入下游）
- case 重叠 / 死分支 / 可达性等高级静态分析
- 把现有 edge.condition 模型彻底废弃（仍保留作辅助控制流）

## 2. 关键决策摘要（来自用户决策）

| # | 决策点 | 选定方案 |
|---|--------|---------|
| 2.1 | 配置范式：节点驱动 vs 边驱动 | **Switch 节点**：cases 数组挂在节点 params 里，出边由系统自动派生 |
| 2.2 | default 字段 | **必填**，graph-validation 在保存阶段拦截缺失 |
| 2.3 | LLM 节点结构化产出 | **llm_agent 加 outputFormat 字段**，运行时尝试 JSON.parse 写入 stepOutputs |
| 2.4 | outputFormat 默认层级 | **stage 级默认 'json'**，配套 jsonb migration 给现存所有 llm_agent 节点显式补 'string' 保现状 |
| 2.5 | 节点视觉 | **菱形 + 紫底 + ✦ 图标** |
| 2.6 | case 拖拽排序 | **v1 必备**（first-match-wins 顺序敏感） |
| 2.7 | edge.condition.expression 引擎升级 | **本次一并改掉**：白名单 2 模板下线，统一用 parseExpression；v44 jsonb migration 同时归一化老语法 |
| 2.8 | switch 节点形态 | **standalone NodeExecutor**（与 fan_out 同列入 ExecutorNodeStageType union），但出边路由特化（读 stepOutputs.matchedTarget） |
| 2.9 | v44 迁移合并 vs 拆分 | **合并**：一个 v44 迁移塞三件事 |
| 2.10 | 集成测试 mock 策略 | **真 mock capability hook**（端到端走 graph runner） |
| 2.11 | 前端测试基础设施 | **本次不搭建**，到 implementation 阶段再判断 |

## 3. 数据模型

> **本文档伪代码约定**：`msg(e)` 表示标准错误信息提取惯用式 `e instanceof Error ? e.message : String(e)`，与现有代码（如 [graph-validation.ts:91](../../src/pipeline/graph-validation.ts#L91)）一致。

### 3.1 stageType 扩展

[`src/pipeline/types.ts`](../../src/pipeline/types.ts)：

- `ExecutorNodeStageType` union 加入 `'switch'`（与 `sql_query | http | db_update | dm | file_read | template_render | fan_out` 同列），让 switch 复用通用 buildExecutorNode dispatcher
- `StageDefinition.outputFormat?: 'string' | 'json'`（仅对 llm_agent 节点有意义；运行时默认 `'json'`）

### 3.2 switch 节点 params shape

```ts
interface SwitchParams {
  cases: Array<{
    when: string   // parseExpression 表达式
    target: string // 图内某个节点 id
  }>
  default: string  // 必填，未命中时的目标节点 id
}
```

走 `PipelineNode.params` 松散字段（与 fan_out 的 body 同样处理方式），不在 StageDefinition 上加专属字段。

### 3.3 求值上下文

`case.when` 与升级后的 `edge.condition.expression` 共享同一套求值 ctx：

```ts
{
  status?: 'success' | 'failed' | 'skipped',  // 上游 stage result（switch 自身没有，仅 edge 路由用）
  output?: unknown,                            // 上游 stage result（同上）
  steps: state.stepOutputs,                    // 主要数据源：steps.<id>.output.<field>
  vars: state.runtimeVars,
  triggerParams,
}
```

switch 节点没有 `status`/`output`（路由节点自身无业务输出），表达式典型只用 `steps.<上游>.output.<field>`。

### 3.4 switch 节点的 output

写入 stageResults + stepOutputs，shape 一致：

```ts
{
  matchedCaseIndex: number | null,  // null 表示走 default
  matchedTarget: string,            // 实际跳转的节点 id
  matchedWhen: string | null,       // 命中的 when 表达式原文（debug 友好）
}
```

stageResults.output 走 JSON.stringify（按现有 schema 是 string）；stepOutputs.output 直接是 object。

## 4. 运行时（graph-builder）

落点：[`src/pipeline/graph-builder.ts`](../../src/pipeline/graph-builder.ts)。

### 4.1 节点执行 — standalone NodeExecutor

新增 [`src/pipeline/node-types/switch.ts`](../../src/pipeline/node-types/switch.ts)：

```ts
registerNodeType({
  key: 'switch',
  async execute(rawParams, ctx) {
    const { cases, default: defaultTarget } = rawParams as SwitchParams
    // 校验 cases 非空数组、default 非空字符串（详见 §5 graph-validation 已守门，这里仍兜底）

    const evalCtx = { steps: ctx.steps, vars: ctx.vars, triggerParams: ctx.triggerParams }

    for (let i = 0; i < cases.length; i++) {
      try {
        if (evalExpression(cases[i].when, evalCtx)) {
          return {
            status: 'success',
            output: { matchedCaseIndex: i, matchedTarget: cases[i].target, matchedWhen: cases[i].when },
          }
        }
      } catch (e) {
        return { status: 'failed', output: {}, error: `switch cases[${i}].when 求值错误: ${msg(e)}` }
      }
    }
    return {
      status: 'success',
      output: { matchedCaseIndex: null, matchedTarget: defaultTarget, matchedWhen: null },
    }
  },
})
```

barrel 注册：[`src/pipeline/node-types/index.ts`](../../src/pipeline/node-types/index.ts) 加 `import './switch.js'`。

graph-builder switch dispatch（[graph-builder.ts:894](../../src/pipeline/graph-builder.ts#L894)）只多一行 `case 'switch':`，复用 `buildExecutorNode`。output 自动写入 `state.stepOutputs[switchId]`（[graph-builder.ts:766](../../src/pipeline/graph-builder.ts#L766)）。

### 4.2 出边路由特化

graph-builder 边接线循环（[graph-builder.ts:938-973](../../src/pipeline/graph-builder.ts#L938)）给 switch 节点开专用 router 分支：

```ts
if (node.stageType === 'switch') {
  builder.addConditionalEdges(name, (state) => {
    const result = state.stageResults.find(r => r.name === lookupName)
    if (result && shouldStopAfter(node, result)) return skipName
    const matchedTarget = state.stepOutputs[node.id]?.output?.matchedTarget
    const targetName = idToName.get(matchedTarget)
    return targetName && routeMap[targetName] ? targetName : END  // END 是防御
  }, routeMap)
  builder.addEdge(skipName, END)
  continue
}
// 其它节点：现有 conditionMatches 路径
```

设计要点：路由决策 = switch 节点 stepOutputs.matchedTarget。switch 自身 failed 时（表达式求值错），走 skip-rest sink；表达式都不命中走 default 仍是 success。

### 4.3 conditionMatches 重写（普通节点边路由）

[graph-builder.ts:858-863](../../src/pipeline/graph-builder.ts#L858) 老白名单 2 模板下线：

```ts
function conditionMatches(
  cond: ConditionSpec | undefined,
  result: StageResult,
  state: PipelineState,
  triggerParams: Record<string, unknown> | undefined,
): boolean {
  if (!cond) return true
  if (cond.kind === 'onSuccess') return result.status === 'success'
  if (cond.kind === 'onFailure') return result.status === 'failed'
  // expression：直接调 evalExpression
  const ctx = {
    status: result.status,
    output: result.output,
    steps: state.stepOutputs,
    vars: state.runtimeVars,
    triggerParams: triggerParams ?? {},
  }
  try {
    return evalExpression(cond.expression, ctx)
  } catch {
    return false  // 解析/求值错统一 false（与现有兜底一致）
  }
}
```

调用点（router 闭包）相应扩 state + triggerParams 参数。

### 4.4 buildCapabilityNode：outputFormat='json' 落地

[graph-builder.ts:217-244](../../src/pipeline/graph-builder.ts#L217) 在 `hooks.runCapability(...)` 返回后增加：

```ts
const outputFormat = stage.outputFormat ?? 'json'
let stepOutput: StepOutput | null = null

if (outputFormat === 'json' && exec.status === 'success') {
  try {
    const parsed = JSON.parse(exec.output)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // 非 object（数字/字符串/数组/null）：switch 表达式无法下钻，统一算失败
      exec = { status: 'failed', output: exec.output, error: 'outputFormat=json: 输出必须是 JSON 对象' }
    } else {
      stepOutput = { status: 'success', output: parsed }
    }
  } catch (e) {
    exec = { status: 'failed', output: exec.output, error: `outputFormat=json: parse 失败: ${msg(e)}` }
  }
}

return {
  currentStageIndex: index,
  stageResults: finishedResult(stage, startedAt, startedMs, exec),
  ...(stepOutput ? { stepOutputs: { [(stage as PipelineNode).id ?? stage.name]: stepOutput } } : {}),
}
```

`outputFormat === 'string'` 时整段 `if` 块跳过，buildCapabilityNode 行为与现状一字不变。

## 5. 静态校验（graph-validation）

落在 [`src/pipeline/graph-validation.ts`](../../src/pipeline/graph-validation.ts)。

### 5.1 switch 必备字段（[checkRequiredFields](../../src/pipeline/graph-validation.ts#L136) 加 case）

- `params.cases` 必须是非空数组 → `node "X" (stageType=switch): cases is required (non-empty array)`
- `params.default` 必须是非空字符串 → `node "X" (stageType=switch): default is required`
- 每个 `cases[i]`：`when` 与 `target` 都必须是非空字符串

### 5.2 target 引用合法性（独立循环）

- `cases[].target` 与 `params.default` 必须指向 `nodeIds` 已存在的节点 → `switch "X" cases[2].target references unknown node: Y`
- 不允许指向 switch 自己（`target !== n.id`）→ `switch "X" cases[N].target 不能指向自己`

### 5.3 case.when 表达式预解析

```ts
try { parseExpression(cases[i].when) }
catch (e) { errors.push(`switch "X" cases[i].when 语法错误: ${msg(e)}`) }
```

### 5.4 edge.condition.expression 预解析（顺手升级）

[graph-validation.ts:34](../../src/pipeline/graph-validation.ts#L34) 已校验 expression 非空；本次再加 parseExpression 预解析（与 §5.3 同一处理）。

### 5.5 outputFormat enum 校验

llm_agent 节点 `outputFormat` 字段如果设置，必须是 `'string'` 或 `'json'`。

### 5.6 自动复用（无需改动）

- 已有的 [DFS cycle 检测](../../src/pipeline/graph-validation.ts#L45) → 自动覆盖 switch 出边
- 已有的 [ancestor 检测](../../src/pipeline/graph-validation.ts#L112) → 自动覆盖 switch 引用 `steps.<id>` 的合法性

### 5.7 v1 不做的检测（YAGNI）

- case 重叠（多 case 永远命中同一 target）
- case 死分支（when 是 `false` 字面量）
- target 是否可达 default 之外的 sink
- cases ↔ edges 双向一致性（前端单向同步即可）

## 6. 前端画布

落在 [`web/src/pipeline-canvas/`](../../web/src/pipeline-canvas/)。核心是 cases 单一事实源 + edges 单向同步。

### 6.1 节点视觉

- 自定义 React Flow node type `'switch'`：菱形（diamond）形状 + 浅紫底 + ✦ 图标
- 节点 body 渲染 `<Tag>{cases.length} cases</Tag><Tag>default → {defaultTarget displayName}</Tag>`
- 与普通矩形 stage 节点视觉区分

### 6.2 类型扩展（[types.ts](../../web/src/pipeline-canvas/types.ts)）

```ts
StageFields {
  ...
  outputFormat?: 'string' | 'json'  // 仅 llm_agent 用
  params?: {
    ...
    cases?: Array<{ when: string; target: string }>
    default?: string
  }
}
```

### 6.3 Inspector 面板（[panels/NodeInspector.tsx](../../web/src/pipeline-canvas/panels/NodeInspector.tsx)）

**switch 节点**：
- 顶部 `cases[]` 表格，**支持拖拽排序**（顺序敏感，first-match-wins）。列：序号 / when (Input + 表达式语法 hint：`steps.q.output.score > 80`) / target (Select 下游节点) / ✗ 删除
- 「+ 添加 case」按钮置于表格底部
- 底部 `default` Select（必填）
- target Select 数据源：图内除当前 switch 外所有节点
- 按 [CLAUDE.md§Stale 兼容](../../CLAUDE.md) 约定：target 指向已不存在节点时显示 `<ExclamationCircleTwoTone />` 提示

**llm_agent 节点**（顺手补）：
- 加一个 `outputFormat` 单选（Radio.Group）：`JSON` / `字符串`，默认 `JSON`
- 字段下方 `extra`：`JSON 模式下 capability 输出必须是 JSON 对象，否则该节点失败`

### 6.4 cases ↔ edges 单向同步（[hooks/usePipelineGraph.ts](../../web/src/pipeline-canvas/hooks/usePipelineGraph.ts)）

- 用户改 cases / default 时，自动 `replaceSwitchEdges(switchId, cases, default)`：删所有 source=switchId 的现有 edges，按 cases 顺序重建（每条 edge 不挂 condition；最后一条标记 `isDefault: true` 仅前端视觉）
- React Flow `isValidConnection` 钩子拦截：用户**不能**手动从 switch 节点拖拽连接出边
- 用户**可以**改 switch 节点的入边（switch 可以有多个上游）

### 6.5 Edge 视觉差异

- switch 节点出边在画布上加 `case#N` / `default` 标签（React Flow `EdgeLabelRenderer`）
- 普通 edge 仍可右键编辑 condition（[EdgeConditionPopover](../../web/src/pipeline-canvas/panels/EdgeConditionPopover.tsx)）；switch 出边的右键菜单**禁用** condition 编辑

### 6.6 EdgeConditionPopover 顺手更新

- expression 模式的 `extra` 文字从「首版仅支持两种模板」改成「parseExpression 引擎，支持 ==/!=/</>/>=/&&/||/!/contains，路径访问 steps.x.output.y」
- `<Input>` 占位符从 `output.includes('RETRY')` 改成 `steps.upstream.output.score > 80`

## 7. DB 迁移（schema-v44）

新增 `src/db/schema-v44.sql`，加进 [`src/db/migrate.ts`](../../src/db/migrate.ts) 的 SCHEMA_FILES 数组。沿用 v36 jsonb-rewrite 套路，**一次 migration 塞三件事**：

### 7.1 注册新节点类型

```sql
INSERT INTO pipeline_node_types (key, display_name, description)
VALUES ('switch', 'Switch 分支', '按 cases 表达式路由到不同下游节点')
ON CONFLICT (key) DO NOTHING;
```

### 7.2 给现存 llm_agent 节点显式补 outputFormat='string'

扫 `test_pipelines.graph.nodes[]` 与 `test_pipelines.stages[]`（旧 linear stages 字段，与 v36 双扫一致）。守门：仅 `stageType='llm_agent'` 且**未设** outputFormat 的节点。SQL 范式：

```sql
UPDATE test_pipelines tp
   SET graph = (
     SELECT jsonb_set(tp.graph, '{nodes}', new_nodes)
     FROM (
       SELECT jsonb_agg(
         CASE WHEN n->>'stageType' = 'llm_agent' AND NOT (n ? 'outputFormat')
              THEN jsonb_set(n, '{outputFormat}', '"string"'::jsonb)
              ELSE n
         END
       ) AS new_nodes
       FROM jsonb_array_elements(tp.graph->'nodes') n
     ) sub
   )
 WHERE tp.graph IS NOT NULL
   AND jsonb_typeof(tp.graph->'nodes') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.graph->'nodes') n
     WHERE n->>'stageType' = 'llm_agent' AND NOT (n ? 'outputFormat')
   );
```

(`stages[]` 同形 SQL，扫第二遍。)

### 7.3 edge.condition.expression 语法归一化

扫 `test_pipelines.graph.edges[]`，对 `condition.kind='expression'` 的 edge：

- `status === 'X'` → `status == 'X'`（`X` 取 success/failed/skipped）
- `output.includes('Y')` → `output contains 'Y'`

SQL 用 `regexp_replace(...)` 链式：

```sql
UPDATE test_pipelines tp
   SET graph = (
     SELECT jsonb_set(tp.graph, '{edges}', new_edges)
     FROM (
       SELECT jsonb_agg(
         CASE WHEN e->'condition'->>'kind' = 'expression'
              THEN jsonb_set(
                     e,
                     '{condition,expression}',
                     to_jsonb(
                       regexp_replace(
                         regexp_replace(
                           e->'condition'->>'expression',
                           '\.includes\(([^)]+)\)', ' contains \1', 'g'
                         ),
                         '===', '==', 'g'
                       )
                     )
                   )
              ELSE e
         END
       ) AS new_edges
       FROM jsonb_array_elements(tp.graph->'edges') e
     ) sub
   )
 WHERE tp.graph IS NOT NULL
   AND jsonb_typeof(tp.graph->'edges') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(tp.graph->'edges') e
     WHERE e->'condition'->>'kind' = 'expression'
       AND (e->'condition'->>'expression' LIKE '%===%'
            OR e->'condition'->>'expression' LIKE '%.includes(%')
   );
```

### 7.4 幂等性

三段都用 `WHERE EXISTS` 守门：第二次执行 v44 是 no-op。

### 7.5 回滚策略

v44 与 v36 一样是单向 migration（无 down migration）。问题修复走 v45 反向迁移，与现有 `_migrations` 版本登记表习惯一致。

## 8. 测试覆盖

落在 [`src/__tests__/`](../../src/__tests__/) 既有结构。

### 8.1 单元测试（unit/）

1. **`switch-node.test.ts`**（新）
   - 命中第 1 / 中间 / 最后 case → matchedCaseIndex 正确
   - 全 false → 走 default，matchedCaseIndex=null
   - case.when 求值抛错 → stage failed，error 带 case 序号
   - cases 缺失 / default 缺失 → status='failed'（运行时兜底，graph-validation 已守门但仍要测兜底）
   - first-match-wins：多 case 同时 true 取第一个

2. **`graph-validation-switch.test.ts`**（新或并入既有 graph-validation 测试）
   - cases 非数组 / 空数组 → 报错
   - default 缺失 / 空字符串 → 报错
   - cases[i].target 指向不存在节点 → 报错
   - cases[i].target === switchId（自环）→ 报错
   - cases[i].when 语法错误 → 报错
   - outputFormat 非 enum → 报错
   - edge.condition.expression 语法错误 → 报错（覆盖 §5.4 升级）

3. **`llm-agent-output-format.test.ts`**（新）
   - outputFormat 默认 'json'：合法 JSON object → 写 stepOutputs；非 object（数字/数组/字符串/null）→ stage failed
   - outputFormat='json' + JSON.parse 抛错 → stage failed，error 带 reason
   - outputFormat='string'：保持现状，不写 stepOutputs

4. **`condition-matches-parse-expr.test.ts`**（新或并入既有）
   - `status == 'success'` 等价 onSuccess
   - `output contains 'foo'` 等价（旧）`output.includes('foo')`
   - `steps.upstream.output.score > 80` 能正常访问 stepOutputs
   - 解析失败 / 求值失败 统一 false（不抛）

### 8.2 集成测试（integration/）

5. **`switch-routing-e2e.test.ts`**（新）
   - 真 mock capability hook + 真 graph runner（不替身），构造最小 graph：`llm_agent (outputFormat='json') → switch → { rollback / deploy / manual }`
   - 第一组：mock 返回 `{ intent: 'rollback', score: 90 }` → 只走 rollback；deploy/manual 节点未执行
   - 第二组：mock 返回 `{ intent: 'unknown' }` → 走 default
   - 第三组：mock 返回非 JSON 字符串 → llm_agent stage failed，switch 不被执行

6. **`v44-migration.test.ts`**（新，db 测试套件）
   - fixture：含老 graph_json（edge.condition.expression 是 `status === 'success'`、llm_agent 节点无 outputFormat）
   - 跑 v44 → 断言：edge.expression 变成 `status == 'success'`、llm_agent 节点显式 outputFormat='string'
   - 跑两次 v44 → 第二次 no-op

### 8.3 前端测试

本次 spec 不强求；implementation 阶段决定是否搭建 vitest+react-testing-library。功能列表（不强制写测）：
- cases 拖拽排序后 graph.edges 同步生效
- target Select 在节点被删除后显示 stale 标记
- switch 节点拖拽出边连接被 `isValidConnection` 拦截

### 8.4 v1 不写的测试

与 §5.7 unfulfilled checks 对齐：case 重叠 / 死分支 / 不可达检测均不做静态校验，自然不需要测。

## 9. 实施次序建议

写 plan 时拆分参考（最终以 writing-plans 输出为准）：

1. **后端基础**：types.ts union 扩展 + node-types/switch.ts + buildExecutorNode 已存在所以零改动 dispatcher
2. **graph-builder 路由特化**：switch 出边 router + conditionMatches 重写（带 state）
3. **llm_agent outputFormat 落地**：buildCapabilityNode 改造 + JSON.parse 兜底
4. **graph-validation §5 全部规则**
5. **schema-v44 migration**（三段 SQL + migrate.ts SCHEMA_FILES 追加）
6. **前端 types + switch 节点视觉 + Inspector cases 表格 + outputFormat Radio**
7. **cases ↔ edges 单向同步 + isValidConnection 拦截**
8. **EdgeConditionPopover hint 文案更新**
9. **测试三层**（unit → integration → migration）

每一步都应该能独立验证（unit 测先于集成测）。前端 6-8 步可以串行也可以与后端 1-5 步并行。

## 10. 未来工作（明确不在本次范围）

- **并行 gateway 节点**（多分支同时进入）：用户后续若有"AB 测试同时走两条分支再 join"诉求，单独 spec
- **case 高级静态分析**（重叠 / 死分支 / 可达性）：需要先有几次实战经验再决定是否引入
- **expression 引擎 v2**（正则 / in 集合 / null 检查 / 函数调用）：parseExpression v1 满足 LLM 路由场景；进一步扩展按需
- **capability 级 default_output_format**：本次走 stage 级；如果未来出现"同一 capability 被 N 个 pipeline 引用、每次都要在 stage 上勾 json"的痛点，再考虑 P2 方案
