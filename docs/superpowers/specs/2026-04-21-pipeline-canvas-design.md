# 流水线可视化编排画布 设计文档

**日期**：2026-04-21
**状态**：设计评审

## 1 · 背景

当前 pipeline runtime 已切换到 LangGraph（`src/pipeline/graph-builder.ts`、`graph-runner.ts`，对应 commit `042b31d`），runtime 层已具备条件边、interrupt/resume、PostgresSaver checkpoint 等能力。

但前端 `web/src/pages/TestPipelinesPage.tsx`（530 行）仍是一个大 `Modal` + `Form.List`：

- 只能线性编辑 `StageDefinition[]`，无法表达分支/fan-out
- UI 选择器只暴露 `script` / `approval` 两种 stage type，runtime 已有的 `capability` / `wait_webhook` 在 UI 上隐形
- 一条 pipeline 超过 5-6 个 stage 后，Modal 的滚动体验退化严重；团队成员一眼看不到整体拓扑
- DevOps 与 QA 都需要配置 pipeline，但当前 UI 对两类人都不够友好

随着 LangGraph 能力释放（条件分支、子流程、中断），线性表单会系统性撑不住。我们需要一套可视化编排画布作为主编辑入口。

## 2 · 设计目标

- **视觉即模型**：拖拽节点、连线即保存 DAG，不引入 YAML 作为主编辑路径
- **DevOps 先，QA 后**：MVP 优先让 DevOps 能把现有线性 pipeline 无损迁到画布上，并解锁条件分支；非技术用户扩展留到 V2+
- **runtime 零语义回归**：复用 `StageDefinition` 所有已验证字段，`graph-builder` 只做 "按 edges 连线" 的局部改造，不重写节点执行逻辑
- **渐进迁移**：旧 pipeline 可在画布中打开（自动转为线性图），旧表单模式在首个版本保留作为退路
- **不过度设计**：不做 YAML 双向同步、子流程复用、版本历史、多人协同等高阶能力

## 3 · 业界方案调研与选型

### 3.1 三大流派

| 流派 | 代表 | 适用 |
|------|------|------|
| DAG 可视化画布（canvas SoT） | LangGraph Studio、n8n、Langflow、Step Functions Workflow Studio | 交互最直观，适合有分支/并行的 pipeline |
| YAML / 代码优先 + 预览图 | GitHub Actions、GitLab CI、Airflow | Git-friendly，DevOps 熟悉，但 QA 扩展差 |
| Stepper / 线性表单 | Jenkins 经典版、Zapier 简版 | 仅适合纯线性流程 |

### 3.2 选型

- **拓扑**：DAG canvas（我们的 runtime 已支持分支，未来一定用得上）
- **Source of Truth**：画布为 SoT；YAML 导出作为 V3 备份通道（不是主编辑路径）
- **实现路径**：基于 `@xyflow/react` (React Flow v12) 自建，借鉴 LangGraph Studio 的交互范式（节点形态、interrupt 标识、state 面板布局）
- **不采用**：
  - LangGraph Studio 直接嵌入——是独立桌面应用，和 Admin 割裂；无法表达 `serverRoles` / `artifactInputs` 等业务概念
  - Fork n8n / Langflow——它们的 runtime 不是 LangGraph，语义需要重接；Antd 风格融合成本高

## 4 · 数据模型

### 4.1 PipelineGraph

新增 `pipelines.graph JSONB` 列：

```ts
interface PipelineGraph {
  nodes: Array<StageDefinition & {
    id: string                    // ULID；与 stage 数组 index 解耦
    position: { x: number; y: number }  // 画布坐标，runtime 忽略
  }>
  edges: Array<{
    id: string                    // ULID
    source: string                // node.id
    target: string                // node.id
    condition?: ConditionSpec
  }>
}

type ConditionSpec =
  | { kind: 'onSuccess' }
  | { kind: 'onFailure' }
  | { kind: 'expression'; expression: string }
// expression 示例：`state.stageResults[-1].output.includes("OK")`
```

**关键不变量**：

- `StageDefinition` 原字段 100% 复用，不动既有 runtime
- `id` 是 ULID（不是 index），删/改节点不破坏未完成 run 的 checkpoint 继续性
- 无 `condition` 的 edge 等价于旧 `onSuccess: continue` 语义
- 首版禁止 cycle（循环边），`graph-builder` 构建前静态校验

### 4.2 Schema 迁移

新增 `src/db/schema-v12.sql`（幂等）：

```sql
ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS graph JSONB;

-- 新增: 校验 graph 必须包含 START 入口（画布保存时后端校验，此处不做 CHECK 约束）
COMMENT ON COLUMN pipelines.graph IS
  '可视化画布的 DAG 定义。为空时 runtime 自动将 stages 列当作线性图读取。';
```

保留 `stages` 列至少两个 release，作为"最后一次旧表单保存的快照"和退路。

## 5 · 后端改造

### 5.1 graph-builder

- 新增 `buildGraphFromPipeline(graph: PipelineGraph, ...)` 入口
- 遍历 `graph.nodes` → `addNode`（复用现有 4 个 `buildXxxNode` 工厂）
- 按 `source` 节点聚合 `edges`：
  - 该节点所有出边都无 `condition`（且只有 1 条）→ `addEdge(source, target)`
  - 该节点有 ≥1 条带 `condition` 的出边，或有多条出边 → `addConditionalEdges(source, router, routeMap)`，其中 `routeMap` 是 `{ [targetNodeName]: targetNodeName }` 的穷举映射
- Router 实现顺序：依次匹配该节点出边的 `condition`，第一个匹配的 edge 决定 next node；全部不匹配时走 skip-sink（stage 级 `onFailure: stop`）或隐式 END
- 保留旧 `buildGraphFromStages(stages)` 作为兼容入口，内部转成 `PipelineGraph` 再调新入口——**单一真实路径**

### 5.2 读取路径

`pipelineRepository.findById(id)` 返回时：

```ts
if (row.graph) return { ...row, graph: row.graph }
// fallback: 把 stages 线性串成 graph（内存转换，不回写）
return { ...row, graph: linearizeStages(row.stages) }
```

`linearizeStages` 位于 `src/pipeline/graph-migration.ts`，纯函数，单测覆盖。

### 5.3 Admin API

- `GET /admin/pipelines/:id/graph` → 返回 `PipelineGraph`（为 MVP 编辑页 + V2 运行态可视化共用）
- `PUT /admin/pipelines/:id/graph` → 保存画布结果；服务端校验：
  - 节点 id 唯一、引用存在
  - 无 cycle（Tarjan）
  - 至少一个节点无入边（entry）
  - 所有 edge.source/target 指向存在的 node
  - 校验失败返回 400 + 具体错误列表
- 现有 `POST/PUT /admin/pipelines`（全量保存）仍兼容，内部调 `PUT graph` 的同一校验逻辑

## 6 · 前端架构

### 6.1 目录结构

```
web/src/pipeline-canvas/
  PipelineCanvasPage.tsx        # 路由 /pipelines/:id/canvas 的容器
  canvas/
    PipelineCanvas.tsx          # React Flow wrapper
    nodes/
      ScriptNode.tsx
      ApprovalNode.tsx
      CapabilityNode.tsx
      WebhookNode.tsx
      nodeTypes.ts              # 统一导出给 React Flow 注册
    edges/
      ConditionalEdge.tsx       # 带条件 label 的边
  panels/
    VariablesPanel.tsx          # 右上折叠：vars / artifactInputs / serverRoles
    NodeInspector.tsx           # 右侧 Drawer：选中节点时显示详情
  toolbar/
    CanvasToolbar.tsx           # 顶栏：保存 / 触发 / 自动排版 / 回退到表单
  hooks/
    usePipelineGraph.ts         # 读写 graph、脏标记、undo 栈
    useAutoLayout.ts            # dagre 计算 position
  api/
    canvas.ts                   # GET/PUT graph
```

文件边界原则：单个组件 ≤ 200 行；超出就分拆。`NodeInspector` 内部按 stage type 分派到子组件，每种 stage type 单独一个 Inspector 文件。

### 6.2 库选型

- **画布内核**：`@xyflow/react` v12（前身 React Flow，v12 改名 xyflow）——TS 原生、节点虚拟化、Dify/n8n/Langflow 共同底座
- **自动布局**：`@dagrejs/dagre`——社区默认，配合 React Flow 有成熟 recipe
- **不引入**：Zustand / Jotai 等——画布内部 state 在 `usePipelineGraph`（`useReducer` + local state），外部仍沿用现有 axios API
- **样式**：Antd 为主，React Flow 自带样式用 CSS variable 覆盖以贴合 Antd 主题色

### 6.3 侧边栏与 Inspector 复用

- **VariablesPanel**：把 `TestPipelinesPage` 里的"自定义变量/制品输入/服务器角色"三块抽出为独立组件，**画布和旧表单共用**。避免双份实现漂移
- **NodeInspector**：把 `StageTypeFields` 组件（script 的 AI 生成、变量 tag 插入、审批人选择等）原样复用——零重写成本，只是容器从 Modal 换成 Drawer

### 6.4 列表页与路由

- `TestPipelinesPage` 保留，列表行"编辑"按钮改为跳转 `/pipelines/:id/canvas`
- 列表页提供"高级表单"二级入口（保留旧 Modal 编辑路径作为 MVP 阶段的退路）
- V2 稳定后，用一次性 migration 删掉旧 Modal 编辑代码

## 7 · 交互细节

### 7.1 MVP 必须包含

- 拖拽节点、连线、自动排版（dagre）
- 4 种 stage type 分别的节点样式（色块区分：script 蓝 / approval 黄 / capability 紫 / wait_webhook 灰）
- 条件边：连线时弹出小面板选 `onSuccess` / `onFailure` / `expression`，`expression` 用单行输入 + 提示变量语法
- 节点 Inspector：点击节点右侧 Drawer 打开，字段与旧 Modal 一致
- VariablesPanel：右上折叠，点击变量 tag 可复制到剪贴板
- 保存：顶栏按钮，脏标记提示未保存
- 触发执行：顶栏按钮，复用现有 `openTrigger` 流程
- 切回表单模式：顶栏按钮（防卡死退路）

### 7.2 MVP 明确不包含

- 运行态实时高亮（V2）
- Interrupt/resume 画布直点恢复（V2）
- YAML 导出/导入（V3）
- 子流程节点、节点模板库（V3+）
- Mini-map / 搜索 / 版本历史 / 多人协同

## 8 · 迁移与兼容

1. **Phase 1（本次 MVP）**：
   - Schema 加 `graph` 列（nullable）
   - 后端读取路径自动 fallback：`graph IS NULL` → 内存 linearize
   - 画布首次保存后写入 `graph`，旧 `stages` 快照继续保留
   - 旧 Modal 编辑路径保留；新建 pipeline 默认走画布
2. **Phase 2（V2，稳定 1-2 个 release 后）**：
   - 移除"高级表单"按钮和旧 Modal 编辑代码
   - 定时任务一次性回写所有 pipeline 的 `graph`
3. **Phase 3（V3 视需求）**：
   - 删除 `stages` 列
   - 视业界反馈决定是否上 YAML 导入导出

## 9 · 测试策略

### 9.1 单测（Vitest）

- `src/__tests__/unit/graph-migration.test.ts`：`linearizeStages` 各种长度、stage type、`onFailure: stop` 情况
- 扩展 `src/__tests__/unit/graph-builder.test.ts`：条件边（onSuccess/onFailure/expression）、多入边 fan-in、无 edge 空图、cycle 校验抛错
- 新增 `web/src/__tests__/usePipelineGraph.test.ts`：undo 栈、脏标记
- 新增 `src/__tests__/unit/pipeline-graph-validation.test.ts`：PUT 时的服务端校验（cycle、悬挂 edge、无入口等）

### 9.2 集成

- 冒烟手册 `docs/pipeline-smoke.md` 新增一节 "条件分支 pipeline"：跑一个 `script_A → (onSuccess: script_B) + (onFailure: approval)` 的图，覆盖两条路径
- 无 E2E 浏览器测试（项目无 Playwright 基建，YAGNI）

### 9.3 TDD 顺序

按 `superpowers:test-driven-development` 原则：先写 `graph-migration` + `graph-builder 条件边` 的单测 → 后端通过 → 再开前端组件测试 → 最后 UI 实现。

## 10 · 风险与缓解

| 风险 | 缓解 |
|------|------|
| React Flow + Antd 样式冲突 | 第一天做 spike demo，先跑 2-3 个节点 + Drawer 验证主题协调 |
| 自动布局在复杂图上布线难看 | 接受，提供"手动拖拽 + 重置布局"兜底按钮；不追求"一次布局到位" |
| 旧表单与画布长期并存造成代码冗余 | 明确两个 release 内收敛；Phase 2 强制删除 |
| 画布保存的 graph 过大导致 JSONB 写入慢 | 预估单 pipeline ≤ 50 节点，JSONB 足够；超过时再做 CDN/分片（YAGNI） |
| LangGraph condition expression 的 eval 安全性 | `kind: 'expression'` 用受限 JSON Path 语法，不走 `new Function`；首版只支持 `stageResults[X].status` / `stageResults[X].output.includes(Y)` 两种模板 |

## 11 · 工期估算

- MVP（DevOps 可用）：2-3 周
  - Week 1：后端数据模型 + graph-builder + API + 单测；前端 spike + 目录骨架
  - Week 2：画布节点 + Inspector + VariablesPanel + 保存链路
  - Week 3：条件边交互 + 冒烟 + 文档 + 打磨
- V2（运行态可视化）：1-2 周，MVP 稳定后开工

## 12 · 成功标准

- 所有现有 pipeline 在画布中打开，拓扑正确、字段无丢失
- 新建一条含条件分支的 pipeline，两条路径分别触发并成功执行
- 单元测试覆盖率不低于现有 pipeline 模块基线
- DevOps 团队 5 人试用 1 周后，反馈"可以替代旧 Modal 作为主编辑入口"
