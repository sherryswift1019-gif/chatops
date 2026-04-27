# 流水线（Pipeline）跟产线解绑设计

- **日期**：2026-04-27
- **状态**：brainstorming 通过，待 plan
- **关联**：phase 4 capability/pipeline 重构（[2026-04-26 spec](./2026-04-26-capability-pipeline-refactor-design.md)）已 ship；本 spec 把 phase 4 的"internal pipeline 跨产线共享"语义推广到所有 pipeline

## 0. 决策摘要

| # | 决策 | 选择 |
|---|------|------|
| 1 | 跨产线复用范围 | 所有 pipeline（含 deploy / 业务类，不仅 bugfix） |
| 2 | 复用语义模型 | Pipeline 池 + 产线引用（多对多） |
| 3 | server 处理方式 | Pipeline 不带 server_roles，binding 提供具体 server id 列表（可选，bugfix 不填） |
| 4 | 关联表设计 | 新表 `pipeline_bindings(product_line_id, ref_key, pipeline_id, server_role_assignments)`，PK 复合 |
| 5 | 老 server_roles 数据迁移 | 自动转换 count → server id 列表（取产线 server pool 前 N 台 by id ASC） |
| 6 | 定时触发 (scheduler) | 整体删除（pipeline 跨产线后 owner 不明，转外部 cron / IM trigger） |

---

## 1. 背景与目标

### 1.1 现状问题

- `test_pipelines.product_line_id` 是 NOT NULL 外键 + ON DELETE CASCADE：每条 pipeline 强制属于唯一产线，**不能跨产线复用**
- bugfix 类 pipeline（L1/L2/L3）逻辑跟产线无关（纯 SQL/HTTP/DB_UPDATE 节点），但每个产线必须各自 seed 一份，违反 DRY
- internal pipeline（phase 4 的 `handover-internal` / `notify-internal` / `create-mr-internal`）已经做到全局共享，但用 hack 绑定最小产线满足 NOT NULL 约束，schema 语义混乱
- `test_pipelines.server_roles` 与 `test_pipelines.product_line_id` 强耦合：executor 用 `listTestServers(pipeline.productLineId)` 拿 server pool，再按 role 分配 → 跨产线无法工作

### 1.2 目标

| 目标 | 落地手段 |
|------|---------|
| pipeline 解绑产线 | `test_pipelines.product_line_id` 改 NULL；server_roles 迁出 |
| 多产线复用同条 pipeline | 新表 `pipeline_bindings (product_line_id, ref_key, pipeline_id)` 表达多对多 |
| Server 分配产线维度 | binding 携带 `server_role_assignments`（具体 server id 列表） |
| Bugfix 类 pipeline 0 配置 | binding 的 `server_role_assignments` 可空（pipeline 不依赖 server 时） |
| Scheduler 模块退出 | 整体删除，cron 触发改外部 |

### 1.3 非目标

- 不动 `internal_capability_pipelines` 表（它是「全局 capability_key → pipeline_id」映射，跟「产线 → pipeline」正交）
- 不引入"全局默认 pipeline + 产线 override" 二级路由（产线必须显式建 binding）
- 不支持产线级 role 重命名（pipeline 的 script 节点 `targetRoles` 是跨产线约定 key，binding 在该 key 下提供 server id list）

---

## 2. 整体架构

### 2.1 数据流

```
                                           ┌─────────────────────────┐
                                           │ test_pipelines (Pipeline 池) │
                                           │ - graph (DAG 定义)       │
                                           │ - variables / triggerParams │
                                           │ - product_line_id (NULL) │
                                           │ - server_roles (deprecated)  │
                                           └────────┬────────────────┘
                                                    │ pipeline_id
                                                    │
   ┌──────────────────────────────────────────────────────────────┐
   │ pipeline_bindings (新表)                                     │
   │ - product_line_id  FK ─────────────────────────┐             │
   │ - ref_key          TEXT                        │             │
   │ - pipeline_id      FK ───────────────────────────────────────┘
   │ - server_role_assignments  JSONB               │
   │   {} 或 {"web": ["srv-1"], "db": ["srv-3"]}    │
   │ PK (product_line_id, ref_key)                  │
   └────────────────────────────────────────────────┼─────────────┘
                                                    │
                                                    ↓
                                          产线维度 server pool

# 触发流（产线维度）：
analyze_bug → coordinator.handleAnalysisComplete(reportId, level, ...)
            → resolvePipelineForTrigger(report.productLineId, `fix_bug_${level}`)
            → 拿 binding {pipelineId, serverRoleAssignments}
            → runPipeline(pipelineId, serverRoleAssignments, triggerCtx, runtimeVars)
            → executor hydrate ServerInfo[] from server id list
            → stage 执行
```

### 2.2 触发器路由优先级

```
1. im_triggers.pipeline_id                    (IM 触发，全局，phase 2 ship)
2. internal_capability_pipelines.pipeline_id  (PIPELINE_DAG_HANDLERS 命中的全局 capability，phase 4 ship)
3. pipeline_bindings (productLineId, ref_key) (产线维度，本期新增)
4. handler 路径
```

### 2.3 关键不变量

1. **pipeline 池纯净**：`test_pipelines` 表行不感知产线 / server，仅持有 graph / variables / triggerParams
2. **binding 是产线 × ref_key 唯一**：PK `(product_line_id, ref_key)` 保证一个产线对某个 ref_key 只能引用一条 pipeline
3. **`server_role_assignments` 可空**：bugfix 类 / 纯数据流类 pipeline 引用时填空对象 `{}`，executor 跑非 script 节点时不查；script 节点 + 空 binding → stage failed (`error: 'no_server_assignments'`)

---

## 3. 数据模型变更

### 3.1 新表：`pipeline_bindings`

```sql
CREATE TABLE pipeline_bindings (
  product_line_id          INT      NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  ref_key                  TEXT     NOT NULL,
  pipeline_id              INT      NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  server_role_assignments  JSONB    NOT NULL DEFAULT '{}'::jsonb,
  description              TEXT     NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_line_id, ref_key)
);
CREATE INDEX idx_pipeline_bindings_pipeline ON pipeline_bindings(pipeline_id);
```

字段语义：

- `ref_key`：产线维度的 pipeline 引用键
  - **约定保留**：`fix_bug_l1` / `fix_bug_l2` / `fix_bug_l3` / `fix_bug_l4`（替代 `coordinator.PIPELINE_NAMES` 字典）
  - **自由文本**：`deploy-staging` / `regression-prod` 等业务约定
- `server_role_assignments`：JSONB，shape `{role: [serverId, ...]}`
  - `{}`：pipeline 不依赖 server（bugfix / 纯数据流），executor 不查
  - 非空：executor hydrate 为 `ServerInfo[]` 后注入 stage 上下文

### 3.2 `test_pipelines` 表改造

| 字段 | 处理 | 原因 |
|------|------|------|
| `product_line_id` | NULL，ON DELETE 改为 SET NULL | 解绑产线，老数据兼容 |
| `server_roles` | 保留作为 deprecated（阶段 1）；阶段 4 DROP | 迁出到 binding，老 pipeline 兼容期保留 |
| `schedule` | DROP（阶段 1） | scheduler 模块删除 |
| 其他（graph / variables / triggerParams / name / description / enabled） | 保留 | pipeline 核心定义 |

### 3.3 老数据迁移（schema-v42）

```sql
-- v42: pipeline 解绑产线，新建 pipeline_bindings 关联表

-- 1. 新表
CREATE TABLE pipeline_bindings (...);  -- 见 §3.1
CREATE INDEX idx_pipeline_bindings_pipeline ON pipeline_bindings(pipeline_id);

-- 2. test_pipelines 字段改造
ALTER TABLE test_pipelines DROP CONSTRAINT test_pipelines_product_line_id_fkey;
ALTER TABLE test_pipelines ALTER COLUMN product_line_id DROP NOT NULL;
ALTER TABLE test_pipelines ADD CONSTRAINT test_pipelines_product_line_id_fkey
  FOREIGN KEY (product_line_id) REFERENCES product_lines(id) ON DELETE SET NULL;

-- 3. 老 pipeline 自动建 binding（每条非 internal pipeline 一条）
DO $$
DECLARE
  rec RECORD;
  v_role TEXT;
  v_count INT;
  v_server_ids JSONB;
  v_assignments JSONB;
BEGIN
  FOR rec IN
    SELECT p.id, p.product_line_id, p.name, p.server_roles
    FROM test_pipelines p
    WHERE p.product_line_id IS NOT NULL
      AND p.id NOT IN (SELECT pipeline_id FROM internal_capability_pipelines)
  LOOP
    -- server_roles count → server id 列表（取产线 server pool 前 N 台 by id ASC）
    v_assignments := '{}'::jsonb;
    IF rec.server_roles IS NOT NULL AND rec.server_roles != '{}'::jsonb THEN
      FOR v_role, v_count IN SELECT * FROM jsonb_each_text(rec.server_roles) LOOP
        SELECT COALESCE(jsonb_agg(s.id ORDER BY s.id), '[]'::jsonb)
          INTO v_server_ids
        FROM (
          SELECT id FROM test_servers
          WHERE product_line_id = rec.product_line_id AND role = v_role
          ORDER BY id ASC LIMIT v_count::int
        ) s;
        v_assignments := v_assignments || jsonb_build_object(v_role, v_server_ids);
        RAISE NOTICE 'v42 migrate: pipeline=% role=% count=% picked=%',
                     rec.id, v_role, v_count, v_server_ids;
      END LOOP;
    END IF;

    INSERT INTO pipeline_bindings (
      product_line_id, ref_key, pipeline_id, server_role_assignments, description
    )
    VALUES (
      rec.product_line_id,
      CASE rec.name
        WHEN 'L1-配置类'   THEN 'fix_bug_l1'
        WHEN 'L2-代码缺陷' THEN 'fix_bug_l2'
        WHEN 'L3-业务逻辑' THEN 'fix_bug_l3'
        WHEN 'L4-复杂问题' THEN 'fix_bug_l4'
        ELSE rec.name
      END,
      rec.id,
      v_assignments,
      '从 schema-v3 ~ v41 自动迁移'
    )
    ON CONFLICT (product_line_id, ref_key) DO NOTHING;
  END LOOP;
END $$;

-- 4. internal pipeline 解绑产线（保持「全局共享」语义，不建 binding）
UPDATE test_pipelines
SET product_line_id = NULL
WHERE id IN (SELECT pipeline_id FROM internal_capability_pipelines);

-- 5. test_pipelines.schedule DROP
ALTER TABLE test_pipelines DROP COLUMN schedule;

-- 6. test_pipelines.server_roles 标 deprecated（不删，阶段 4 才 DROP）
COMMENT ON COLUMN test_pipelines.server_roles IS
  'DEPRECATED v42: server 分配迁到 pipeline_bindings.server_role_assignments。本字段保留兼容老 pipeline，新 pipeline 应填空对象。阶段 4 删除。';

-- 7. 断言：每条非 internal 的产线绑定 pipeline 都有 binding
DO $$
DECLARE
  v_pipeline_count INT;
  v_binding_count INT;
BEGIN
  SELECT COUNT(*) INTO v_pipeline_count
  FROM test_pipelines
  WHERE product_line_id IS NOT NULL
    AND id NOT IN (SELECT pipeline_id FROM internal_capability_pipelines);
  SELECT COUNT(*) INTO v_binding_count FROM pipeline_bindings;
  IF v_pipeline_count != v_binding_count THEN
    RAISE EXCEPTION 'v42 migrate: pipeline count mismatch (% pipelines vs % bindings)',
                    v_pipeline_count, v_binding_count;
  END IF;
END $$;
```

### 3.4 server_role_assignments 老数据自动转换说明

老 `test_pipelines.server_roles` shape：`{web: 2, db: 1}`（"我要 2 台 web，1 台 db"）。

新 `pipeline_bindings.server_role_assignments` shape：`{web: ["srv-id-1", "srv-id-2"], db: ["srv-id-3"]}`（具体 server）。

迁移转换规则：
- 对每个 (role, count) 对，从 `test_servers WHERE product_line_id = pipeline.productLineId AND role = X` 按 `id ASC` 取前 `count` 台
- 取到几台填几台（pool 不够 count 就填能拿到的）
- 迁移日志逐条 `RAISE NOTICE` 打印 `(pipeline_id, role, count, picked_server_ids)`，管理员事后审计

**一致性风险**：迁移时刻产线 server pool 状态决定结果，扩缩容后 binding 不会自动调整。**接受作为已知差异**，由管理员手动 update binding。

### 3.5 internal_capability_pipelines 不动

phase 4 ship 的全局 capability 路由表保持原样：
- 表结构不变（`capability_key TEXT PRIMARY KEY, pipeline_id INTEGER NOT NULL REFERENCES test_pipelines(id)`）
- 它持有的 3 条 internal pipeline（handover/notify/create_mr）在 schema-v42 后 `product_line_id = NULL`，符合"全局共享"语义
- coordinator.triggerCapability 路由优先级见 §2.2

---

## 4. 后端改造

### 4.1 新增 repository: `src/db/repositories/pipeline-bindings.ts`

```typescript
export interface PipelineBinding {
  productLineId: number
  refKey: string
  pipelineId: number
  serverRoleAssignments: Record<string, string[]>
  description: string
  createdAt: Date
  updatedAt: Date
}

export async function getPipelineBinding(productLineId: number, refKey: string): Promise<PipelineBinding | null>
export async function listPipelineBindings(filter?: { productLineId?: number; pipelineId?: number }): Promise<PipelineBinding[]>
export async function upsertPipelineBinding(b: Omit<PipelineBinding, 'createdAt'|'updatedAt'>): Promise<PipelineBinding>
export async function deletePipelineBinding(productLineId: number, refKey: string): Promise<void>

// 触发器路由专用（performance critical）
export async function resolvePipelineForTrigger(
  productLineId: number,
  refKey: string,
): Promise<{ pipelineId: number; serverRoleAssignments: Record<string, string[]> } | null>
```

### 4.2 `coordinator.ts` 改造

- 删 `PIPELINE_NAMES` 字典（行 284-289）
- 删 `findPipelineByLevel` 函数（行 291-316）
- `handleAnalysisComplete(reportId, level, ...)` 改造：

```typescript
// 改前
const pipeline = await findPipelineByLevel(report.productLineId, level)
const runId = await runPipeline(pipeline.id, {}, apiTrigger(...), { reportId: ... }, onComplete)

// 改后
const binding = await resolvePipelineForTrigger(report.productLineId, `fix_bug_${level}`)
if (!binding) {
  console.error(`[AgentCoordinator] no pipeline binding for productLine=${report.productLineId} ref_key=fix_bug_${level}`)
  await updateReportStatus(reportId, 'aborted')
  return
}
const runId = await runPipeline(
  binding.pipelineId,
  binding.serverRoleAssignments,
  apiTrigger(...),
  { reportId: ... },
  onComplete,
)
```

### 4.3 `executor.ts` 改造

`runPipeline` 第 2 个参数从 `Record<string, ServerInfo[]>` 改为 `Record<string, string[]>`（server id list），内部 hydrate：

```typescript
async function runPipeline(
  pipelineId: number,
  serverRoleAssignments: Record<string, string[]>,
  trigger: TriggerContext,
  runtimeVars: Record<string, string>,
  onComplete?: OnCompleteHook,
): Promise<number> {
  const pipeline = await getTestPipelineById(pipelineId)

  let resolved: Record<string, ServerInfo[]>
  if (Object.keys(serverRoleAssignments).length > 0) {
    // 新路径：binding 提供 server id 列表，hydrate 为 ServerInfo[]
    resolved = await hydrateServerAssignments(serverRoleAssignments)
  } else if (pipeline.productLineId && Object.keys(pipeline.serverRoles ?? {}).length > 0) {
    // 老路径兼容（阶段 4 删除）：pipeline 还带 serverRoles + productLineId
    const allServers = await listTestServers(pipeline.productLineId)
    resolved = allocateByRole(allServers, pipeline.serverRoles)
  } else {
    // bugfix / 纯数据流 pipeline：无需 server
    resolved = {}
  }
  // ...后续 stage 执行用 resolved，跟 phase 4 前一致
}
```

新增 helper `hydrateServerAssignments(assignments)`：批量按 server id 查 `test_servers` 表。

### 4.4 `scheduler.ts` 删除

- 删 `src/pipeline/scheduler.ts` 整个文件
- 删 `src/server.ts` 里 scheduler 启动代码（搜 `import.*scheduler` 找位置）
- 删 admin API 的 schedule 参数（test-pipelines.ts 的 POST/PUT 表单）
- 删 `src/db/repositories/test-pipelines.ts` 的 schedule 列处理

**保留不动**：MR reconcile cron / Bug analysis 并发控制（独立模块）。

### 4.5 admin routes 改造

- `POST /admin/api/test-pipelines` 入参不再要 `productLineId` / `serverRoles` / `schedule`（schedule 已删，其他两个标 deprecated 但仍接受老格式）
- 新增 `/admin/api/pipeline-bindings` 路由：
  - `GET /admin/api/pipeline-bindings?productLineId=X` 列产线下所有 binding
  - `GET /admin/api/pipeline-bindings/:productLineId/:refKey` 详情
  - `POST /admin/api/pipeline-bindings` 创建
  - `PUT /admin/api/pipeline-bindings/:productLineId/:refKey` 更新
  - `DELETE /admin/api/pipeline-bindings/:productLineId/:refKey` 删除
- 老 `syncPipelineCapability` (test-pipelines.ts) 改造：现在写 `pipeline_bindings` 而不是 `product_line_capabilities`

### 4.6 internal_capability_pipelines / im_triggers 路径不动

phase 4 ship 的全局 capability 路由 + im trigger 路由保持原样。pipeline_bindings 是补一个产线维度路由。

---

## 5. 前端改造

### 5.1 `TestPipelinesPage.tsx`（pipeline 池管理）

从「产线维度的 pipeline 列表」改为「全局 pipeline 池」：

- **删列**：产线名称、schedule
- **删表单字段**：产线下拉、server_roles 编辑、schedule cron 输入
- **保留**：name / description / graph (画布) / variables / triggerParams / enabled
- **列表标题**：改为"流水线（全局池）"
- **新增列**："被引用产线数" — 统计 `pipeline_bindings WHERE pipeline_id=$1` 行数
- **详情面板底部**：加"被以下产线引用"列表（点击跳转产线详情页 binding tab）
- **删手动触发按钮**：触发改从产线 binding tab 入口

### 5.2 `ProductLineDetailPage.tsx` 新增「Pipeline 绑定」Tab

布局：

```
┌────────────────────────────────────────────────────────────────┐
│ 产线: PAM                                                        │
│ ├─ 概览 ├─ 项目 ├─ 服务器 ├─ IM 触发器 ├─ Pipeline 绑定 ├─ ... │
└────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ ref_key            │ 引用 pipeline   │ Server 分配 │ 操作         │
├─────────────────────────────────────────────────────────────────┤
│ fix_bug_l1         │ L1 配置类修复   │ —          │ 编辑 / 解绑   │
│ fix_bug_l3         │ L3 业务逻辑修复  │ web×2 db×1 │ 编辑 / 解绑   │
│ deploy-staging     │ 标准部署流程    │ web×2      │ 编辑 / 解绑   │
└─────────────────────────────────────────────────────────────────┘
                                                       [+ 新增绑定]
```

**编辑/新增 binding 表单**：

- `ref_key` Input（创建后只读；约定保留 `fix_bug_l1/l2/l3/l4` 在 Select 列出，自由文本通过"自定义"模式）
- `pipeline_id`：Select 下拉，列全局 pipeline 池（按 CLAUDE.md "前端表单：枚举字段下拉规范"，搜索 + stale 兼容）
- 选完 pipeline 后，**前端解析该 pipeline.graph**，扫所有 `nodeTypeKey === 'script'` 的节点的 `targetRoles`，去重得到 role 列表
  - role 列表为空 → 不显示 server 控件，提示"此 pipeline 无需 server 分配"
  - 非空 → 为每个 role 显示一个产线 server 多选控件（按当前产线 server pool，按 role 过滤）

```
Server 分配 (该 pipeline 用到 role: web / db)
┌────────────────────────────────────────────────────┐
│ web │ Select mode="multiple" 列产线 pool 里 role=web 的 server │
│ db  │ Select mode="multiple" 列产线 pool 里 role=db 的 server  │
└────────────────────────────────────────────────────┘
```

### 5.3 路由 / 菜单调整

```
admin 菜单
  ├ 总览
  ├ 产品线（详情含 Pipeline 绑定 Tab，新增）
  ├ IM 触发器
  ├ 能力库
  ├ Pipelines（pipeline 池管理，简化）
  ├ 节点类型
  ├ 工具
  ├ 审批规则
  └ 系统配置
```

### 5.4 i18n 与术语

| UI 术语 | DB 表 | 含义 |
|---------|-------|------|
| 流水线 | `test_pipelines` | DAG 资源池，全局共享 |
| 流水线绑定 | `pipeline_bindings` | 产线 × ref_key → pipeline + server 分配 |
| ref_key | `pipeline_bindings.ref_key` | 产线管理员说"我们 fix_bug_l1 用哪条" |

---

## 6. 实施顺序与风险

### 6.1 实施顺序（4 阶段，每阶段独立可 ship）

```
阶段 1: schema-v42 + repository (1-2 天)
  ├ 新建 pipeline_bindings 表
  ├ test_pipelines.product_line_id 改 NULLable + ON DELETE SET NULL
  ├ 老数据迁移 + server_roles 自动转换 (count → server id 列表)
  ├ DROP test_pipelines.schedule 字段
  ├ 新建 pipeline-bindings repository
  └ 验证: 老 pipeline 仍可触发

阶段 2: 后端路由 + executor 改造 (2-3 天)
  ├ coordinator.findPipelineByLevel → resolvePipelineForTrigger
  ├ runPipeline 入参变更
  ├ executor 跑 script stage 时 hydrate ServerInfo from binding
  ├ scheduler 模块整体删除
  ├ admin API 改造
  └ 验证: bugfix L1/L2/L3 触发链路全绿；现有 IM trigger / capability 触发不破

阶段 3: 前端改造 (3-5 天)
  ├ TestPipelinesPage 简化
  ├ ProductLineDetailPage Pipeline 绑定 Tab + binding 编辑表单
  ├ Server 分配控件按 pipeline.graph 解析 script 节点 targetRoles
  ├ 删手动触发 from pipeline pool
  └ 验证: 浏览器手测 binding CRUD + 产线详情页 + pipeline 池页

阶段 4: 老 server_roles 字段下线 (1 天，可选 / 推迟)
  ├ test_pipelines.server_roles DROP (schema-v43)
  ├ executor 老兼容路径删除
  └ 验证: 全量稳定 1 周后做
```

### 6.2 测试矩阵

| 层 | 范围 | 阶段 |
|----|------|------|
| 单元 | pipeline-bindings repository CRUD + resolvePipelineForTrigger | 1 |
| 单元 | schema-v42 数据迁移正确性（fixture：3 产线 × 4 pipeline + server_roles count→ids） | 1 |
| 集成 | bugfix L1/L2/L3 全链路：analyze_bug → handleAnalysisComplete → resolve binding → runPipeline | 2 |
| 集成 | runPipeline 跨产线复用：同一 pipeline 被 2 个产线引用，server_role_assignments 各自独立 | 2 |
| 集成 | 老 pipeline 兼容：pipeline.serverRoles 非空 + binding 入参为空 → 走老逻辑 | 2 |
| 集成 | 删 scheduler 后无现有 cron 测试残留 | 2 |
| 浏览器手测 | binding CRUD + Server 分配控件按 pipeline graph 动态显示 | 3 |
| 冒烟 | docs/smoke-pipeline-decoupling.md | 全程 |

### 6.3 风险清单

| 风险 | 等级 | 缓解 |
|------|------|------|
| 阶段 1 数据迁移漏一条 pipeline (无 binding) | 高 | 迁移末尾断言 (§3.3 步骤 7) |
| server_role_assignments 自动转换选错 server | 中 | 迁移日志逐条打印；管理员事后 review |
| 老 pipeline.serverRoles 与新 binding.server_role_assignments 双数据源不同步 | 中 | 阶段 4 删 server_roles 前用 SQL 查"两边不一致" |
| executor 改造破坏现有 deploy pipeline | 高 | 阶段 2 改 runPipeline 时保留老 fallback；集成测试覆盖老 pipeline 路径 |
| 删 scheduler 后某个生产 cron 任务断了 | 高 | 上线前 grep 生产 `test_pipelines WHERE schedule != ''` 列清单；逐个迁移到外部 cron / IM trigger |
| 前端 binding 表单解析 pipeline.graph 出错 | 低 | 防御性 try/catch，graph 异常时 fallback 空 role 列表 + 警告 |

### 6.4 回滚策略

| 阶段 | 出问题怎么回滚 |
|------|--------------|
| 1 | 新表 + product_line_id NULLable 是 backward-compatible。回滚：`ALTER COLUMN product_line_id SET NOT NULL` + `DROP TABLE pipeline_bindings`。schedule DROP 是 breaking，需迁移前 dump |
| 2 | runPipeline 入参兼容老 pipeline，回滚 = revert coordinator/executor/scheduler 代码 |
| 3 | 前端纯增量，回滚 = revert 前端代码 |
| 4 | server_roles 字段删除是 breaking，需迁移前 dump |

**关键原则**：阶段 1 的 `DROP test_pipelines.schedule` 与阶段 4 的 `DROP test_pipelines.server_roles` 必须各自迁移前 dump 全表，落地一份 backup SQL。

### 6.5 Definition of Done（每阶段）

1. ✓ 单元 + 集成测试 ≥90% 通过率
2. ✓ 对应冒烟手册执行通过
3. ✓ 生产环境跑 ≥3 天，bugfix L1/L2/L3 触发链路无错误日志
4. ✓ 前端 binding 管理 UI 浏览器手测通过
5. ✓ 文档 PR 合并

整个 spec 收尾的判定：

1. ✓ 4 阶段全 ship 到 main
2. ✓ pipeline_bindings 表里有 N 条记录覆盖所有现存 pipeline（与生产 grep 一致）
3. ✓ test_pipelines.schedule + server_roles 字段已 DROP（阶段 4 完成后）
4. ✓ scheduler 模块从代码库删除
5. ✓ 老 pipeline 兼容路径（runPipeline fallback）从代码库删除
6. ✓ 前端 TestPipelinesPage / ProductLineDetailPage / Pipeline 绑定 Tab 浏览器手测通过

---

## 附录 A：与历史 spec 的关系

- **2026-04-26 capability/pipeline 重构 spec**：phase 4 已 ship 的 internal pipeline 跨产线共享是本 spec 的雏形。internal_capability_pipelines 表保留不动，作为「全局 capability_key → pipeline」路由；本 spec 加 pipeline_bindings 作为「产线 × ref_key → pipeline」路由，两者正交
- **2026-04-22 im-trigger-toggle**：im_triggers 全局表已存在，跟本 spec 的 pipeline_bindings 互不干扰（IM 触发已有自己的产线维度 `product_line_im_triggers` 表）
