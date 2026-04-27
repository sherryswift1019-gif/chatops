# 能力(Capability)与流水线(Pipeline)分工重构 — phase 4 sub-plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 把 3 个非 LLM 决策类 handler（create_mr / notify_bug / request_handover）迁移为 pipeline DAG，feature flag `PIPELINE_DAG_HANDLERS` 双轨灰度切换，最终删除旧 handler。

**Architecture:** 过渡期保留旧 handler；coordinator.triggerCapability 检查 feature flag 决定走 handler 路径还是 pipeline 路径；通过 `internal_capability_pipelines` 过渡表把 capability key → pipeline_id 映射。

**Spec:** §6 / 主 plan §E
**Phase 3 merge:** main = `b509c10` (12 节点类型完整,fan_out 可用,capability→llm_agent 重命名)

---

## 范围

| 范围 | 在本 plan 内 |
|------|------------|
| schema-v37: internal_capability_pipelines 表 | ✅ T1 |
| coordinator + runPipelineAsCapability 双轨基础设施 | ✅ T1 |
| L1 request_handover 迁移 + 行为对等测试 | ✅ T2 |
| L2 notify_bug 迁移 + 行为对等测试 | ✅ T3 |
| L3 create_mr 迁移 + 行为对等测试 | ✅ T4 |
| 删除 3 旧 handler + 过渡表 | ✅ T5 |
| 冒烟手册 + 阶段验收 | ✅ T6 |

6 task，预计 3-4 周（plan 估算）。

## 关键约束

- **handler 路径完整保留**——直到 T5 才删
- **每个 L 单独灰度**——L1 灰度稳定后再切 L2，依次类推
- **行为对等测试**：每个 handler 用相同 reportId 跑两次（handler vs pipeline），对比 bug_fix_events / DB / outbound HTTP（nock 拦截）
- **feature flag 默认空字符串**——所有 capability key 默认走 handler 路径
- **回滚机制**：`PIPELINE_DAG_HANDLERS=""` 立刻回到 handler 路径，无 DB 状态变化

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db/schema-v37.sql` | 创建 | internal_capability_pipelines 表 + L1 pipeline 种子 |
| `src/db/migrate.ts` | 修改 | 追加 v37 |
| `src/__tests__/helpers/db.ts` | 修改 | SCHEMA_FILES 加 v37 |
| `src/db/repositories/internal-capability-pipelines.ts` | 创建 | CRUD |
| `src/agent/coordinator.ts` | 修改 | feature flag + runPipelineAsCapability |
| `src/__tests__/integration/handler-vs-pipeline-{handover,notify,mr}.test.ts` | 创建 | 行为对等测试 |
| `docs/smoke-handler-migration.md` | 创建 | 冒烟手册 |

---

## Task 1: schema-v37 + coordinator feature flag + L1 pipeline 种子

**Files:**
- Create: `src/db/schema-v37.sql`
- Create: `src/db/repositories/internal-capability-pipelines.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/__tests__/helpers/db.ts`
- Modify: `src/agent/coordinator.ts`

### Step 1: schema-v37.sql

```sql
-- v37: phase 4 — internal_capability_pipelines 过渡表 + L1 (request_handover) pipeline 种子
-- 见 spec §6.5 / 主 plan §E

CREATE TABLE IF NOT EXISTS internal_capability_pipelines (
  capability_key  TEXT PRIMARY KEY,
  pipeline_id     INTEGER NOT NULL REFERENCES test_pipelines(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- L1: request_handover pipeline (4 节点 DAG: idempotency_check → load_report → gitlab_label → write_event → update_status)
DO $$
DECLARE v_pipeline_id INTEGER;
BEGIN
  -- 跳过如已存在
  IF EXISTS (SELECT 1 FROM test_pipelines WHERE name='handover-internal') THEN
    SELECT id INTO v_pipeline_id FROM test_pipelines WHERE name='handover-internal';
    RAISE NOTICE 'schema-v37: handover-internal pipeline 已存在 id=%', v_pipeline_id;
  ELSE
    INSERT INTO test_pipelines (name, description, graph, trigger_params, enabled, server_roles, schedule, variables)
    VALUES (
      'handover-internal',
      'phase 4: request_handover handler 迁移 — 5 节点 DAG',
      '{"nodes":[
        {"id":"idempotency_check","stageType":"sql_query","params":{"sqlTemplate":"SELECT 1 FROM bug_fix_events WHERE report_id={{triggerParams.reportId}} AND code=''handover'' AND status=''success'' LIMIT 1","shortCircuitWhen":"steps.idempotency_check.output.rows.length > 0"}},
        {"id":"load_report","stageType":"sql_query","params":{"sqlTemplate":"SELECT issue_iid, primary_project_path FROM bug_analysis_reports WHERE id={{triggerParams.reportId}}"}},
        {"id":"gitlab_label","stageType":"http","params":{"method":"POST","url":"{{vars.gitlabUrl}}/api/v4/projects/{{steps.load_report.output.rows[0].primary_project_path | urlEncode}}/issues/{{steps.load_report.output.rows[0].issue_iid}}/labels","headers":{"PRIVATE-TOKEN":"{{vars.gitlabToken}}"},"body":{"labels":"needs-manual"}},"onFailure":"continue"},
        {"id":"write_event","stageType":"db_update","params":{"sqlTemplate":"INSERT INTO bug_fix_events (report_id, code, status, project_path, data) VALUES ({{triggerParams.reportId}}, ''handover'', ''success'', {{steps.load_report.output.rows[0].primary_project_path}}, {{triggerParams.reason}}::jsonb)"}},
        {"id":"update_status","stageType":"db_update","params":{"sqlTemplate":"UPDATE bug_analysis_reports SET status=''pending_manual'', updated_at=NOW() WHERE id={{triggerParams.reportId}}"}}
      ],"edges":[
        {"from":"idempotency_check","to":"load_report"},
        {"from":"load_report","to":"gitlab_label"},
        {"from":"gitlab_label","to":"write_event"},
        {"from":"write_event","to":"update_status"}
      ]}'::jsonb,
      '{"reportId":{"type":"integer","required":true},"reason":{"type":"string","required":true}}'::jsonb,
      TRUE,
      '{}'::jsonb,
      '',
      '{}'::jsonb
    )
    RETURNING id INTO v_pipeline_id;
    RAISE NOTICE 'schema-v37: handover-internal pipeline 创建 id=%', v_pipeline_id;
  END IF;

  -- 注册到 internal_capability_pipelines
  INSERT INTO internal_capability_pipelines (capability_key, pipeline_id)
  VALUES ('request_handover', v_pipeline_id)
  ON CONFLICT (capability_key) DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id;
END $$;

-- 断言
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_capability_pipelines WHERE capability_key='request_handover') THEN
    RAISE EXCEPTION 'schema-v37: request_handover 未注册到 internal_capability_pipelines';
  END IF;
END $$;
```

### Step 2: repository

Create `src/db/repositories/internal-capability-pipelines.ts`:
```typescript
import { getPool } from '../client.js'

export interface InternalCapabilityPipeline {
  capabilityKey: string
  pipelineId: number
  createdAt: Date
}

export async function getInternalPipelineId(capabilityKey: string): Promise<number | null> {
  const { rows } = await getPool().query(
    'SELECT pipeline_id FROM internal_capability_pipelines WHERE capability_key = $1',
    [capabilityKey],
  )
  return rows[0]?.pipeline_id ?? null
}
```

### Step 3: coordinator feature flag

Edit `src/agent/coordinator.ts`. 在 `triggerCapability` 函数顶部、handler 查找之前，加：

```typescript
import { getInternalPipelineId } from '../db/repositories/internal-capability-pipelines.js'
import { runPipeline, apiTrigger } from '../pipeline/executor.js'

const PIPELINE_DAG_HANDLERS = (process.env.PIPELINE_DAG_HANDLERS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

// 在 capability 查询和 imTrigger 路由之后,handler 路径之前:
if (PIPELINE_DAG_HANDLERS.includes(opts.capabilityKey)) {
  const pipelineId = await getInternalPipelineId(opts.capabilityKey)
  if (pipelineId) {
    return await runPipelineAsCapability(pipelineId, opts)
  }
  console.warn(`[coordinator] flag enabled for ${opts.capabilityKey} but no internal pipeline mapping`)
  // fall through to handler path
}

// 后面是原 handler 路径
```

`runPipelineAsCapability` 实现：
```typescript
async function runPipelineAsCapability(pipelineId: number, opts: TriggerOptions): Promise<TriggerResult> {
  try {
    const runId = await runPipeline(
      pipelineId,
      {},
      apiTrigger({ triggeredBy: opts.context.initiatorId, params: opts.extraParams ?? {} }),
      opts.extraParams as Record<string, string> ?? {},
      undefined,
    )
    console.log(`[coordinator] pipeline run #${runId} started for ${opts.capabilityKey} (via PIPELINE_DAG_HANDLERS flag)`)
    return { success: true, output: `Pipeline run #${runId} started`, data: { runId, pipelineId } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
```

### Step 4-7: migrate.ts / SCHEMA_FILES / 测试 / commit

```bash
git commit -m "feat(coordinator): PIPELINE_DAG_HANDLERS feature flag + internal_capability_pipelines 表 + L1 handover pipeline 种子(schema-v37)"
```

---

## Task 2: L1 (request_handover) 行为对等测试 + 灰度上线

**Files:**
- Create: `src/__tests__/integration/handler-vs-pipeline-handover.test.ts`

行为对等测试：用 nock 拦截 GitLab API，构造一个 reportId fixture，分别用 `handler` 路径和 `pipeline` 路径触发，断言：
- bug_fix_events 表新增的 'handover' 行内容一致（report_id / code / status / project_path / data）
- bug_analysis_reports.status 都被改为 'pending_manual'
- GitLab API outbound calls 一致（POST /api/v4/projects/.../issues/.../labels）

```typescript
describe('L1: request_handover handler vs pipeline behavior parity', () => {
  it('两条路径产生一致的 bug_fix_events 行', async () => {
    // 准备 reportId fixture
    // ...
    
    // 路径 A: handler 路径 (PIPELINE_DAG_HANDLERS 不含 request_handover)
    delete process.env.PIPELINE_DAG_HANDLERS
    await triggerCapability({ capabilityKey: 'request_handover', context: ..., extraParams: { reportId, reason: 'fix_exhausted' } })
    const handlerEvents = await findByReportCode(reportId, 'handover')
    
    // 重置 fixture
    await getPool().query('DELETE FROM bug_fix_events WHERE report_id = $1', [reportId])
    
    // 路径 B: pipeline 路径
    process.env.PIPELINE_DAG_HANDLERS = 'request_handover'
    await triggerCapability({ capabilityKey: 'request_handover', context: ..., extraParams: { reportId, reason: 'fix_exhausted' } })
    const pipelineEvents = await findByReportCode(reportId, 'handover')
    
    // 断言
    expect(pipelineEvents.length).toBe(handlerEvents.length)
    expect(pipelineEvents[0]).toMatchObject({ /* same shape */ })
  })
})
```

如对等测试通过 → 灰度策略：
- staging 环境 export `PIPELINE_DAG_HANDLERS=request_handover` 跑 24-48h
- 监控 bug_fix_events 写入 / GitLab label 调用是否符合预期
- 全绿 → 提 PR 把 flag 设为 default (在 .env.example 加 `PIPELINE_DAG_HANDLERS=request_handover`)

```bash
git commit -m "test(handover): L1 handler-vs-pipeline 行为对等测试"
```

---

## Task 3: L2 (notify_bug) 迁移

类似 T2，但 pipeline DAG 复杂得多——8 种 scenario 多分支 fan_out。

**实现方案**：用 `sql_query` 节点决策 scenario kind，然后用条件边路由到对应的 fan_out（每个 fan_out 处理一种 scenario 的 owner 列表 + dm 发送）。

```sql
-- schema-v38.sql: notify_bug pipeline 种子
INSERT INTO test_pipelines (name, ..., graph)
VALUES ('notify-internal', '...', '{
  "nodes": [
    {"id":"load_state","stageType":"sql_query","params":{"sqlTemplate":"SELECT (SELECT level FROM bug_analysis_reports WHERE id={{triggerParams.reportId}}) AS level, EXISTS(...) AS is_handover, ..."}},
    {"id":"collect_owners","stageType":"sql_query","params":{"sqlTemplate":"SELECT DISTINCT p.owner_id FROM bug_fix_events e JOIN projects p ON p.gitlab_path=e.project_path WHERE e.report_id={{triggerParams.reportId}}"}},
    
    {"id":"fanout_handover","stageType":"fan_out","when":"steps.load_state.output.rows[0].is_handover == true","params":{
      "source":"{{steps.collect_owners.output.rows}}",
      "as":"owner",
      "parallel":5,
      "body":[{"id":"send_handover_dm","stageType":"dm","params":{"platform":"dingtalk","userId":"{{owner.owner_id}}","text":"Bug #{{triggerParams.reportId}} 转人工..."}}]
    }},
    
    {"id":"fanout_fix_success","stageType":"fan_out","when":"steps.load_state.output.rows[0].fix_success == true && steps.load_state.output.rows[0].is_handover == false","params":{...}},
    
    // ...其余 6 种 scenario
  ],
  "edges":[
    {"from":"load_state","to":"collect_owners"},
    {"from":"collect_owners","to":"fanout_handover"},
    {"from":"collect_owners","to":"fanout_fix_success"},
    // ...
  ]
}'::jsonb)
```

⚠️ scenario 边 `when` 条件需要 phase 3 的 expression parser 支持 —— spec §4.3 已经规定。

行为对等测试：构造每种 scenario 的 reportId fixture，对比 handler vs pipeline 的 DM 发送数量 + content。

```bash
git commit -m "feat(pipeline): L2 notify_bug pipeline DAG + 行为对等测试(schema-v38)"
```

---

## Task 4: L3 (create_mr) 迁移

最复杂，多 project fan_out + 主从仓库 description 不同。

```sql
-- schema-v39.sql
INSERT INTO test_pipelines (name, ..., graph)
VALUES ('create-mr-internal', '...', '{
  "nodes":[
    {"id":"load_primary_issue","stageType":"sql_query","params":{...}},
    {"id":"find_success_projects","stageType":"sql_query","params":{...}},
    {"id":"create_each_mr","stageType":"fan_out","params":{
      "source":"{{steps.find_success_projects.output.rows}}",
      "as":"proj",
      "parallel":3,
      "onItemFailure":"aggregate",
      "body":[
        {"id":"build_description","stageType":"template_render","params":{"template":"...","vars":{"is_primary":"{{proj.project_path == steps.load_primary_issue.output.rows[0].project_path}}"}}},
        {"id":"create_mr_call","stageType":"http","params":{"method":"POST","url":"...","body":{"description":"{{steps.build_description.output.text}}"}},"retryCount":3,"retryWhen":"output.statusCode >= 500 || output.error contains 'timeout'"},
        {"id":"write_mr_event","stageType":"db_update","params":{...}}
      ]
    }}
  ],
  "edges":[...]
}'::jsonb)
```

行为对等测试：构造多 project（主仓库 + 2 从仓库）的 reportId fixture，对比 GitLab API outbound 调用数 + body description（主仓库 `Closes #X` vs 从仓库 `Related to ... #X`）。

```bash
git commit -m "feat(pipeline): L3 create_mr pipeline DAG + 行为对等测试(schema-v39)"
```

---

## Task 5: 删除旧 handler + 过渡表

待 L1+L2+L3 全量稳定 1-2 周后：

- 删除 `src/agent/mr/mr-handler.ts` / `src/agent/notify/notify-handler.ts` / `src/agent/handover/request-handover-handler.ts`
- 删除对应的 `registerCapabilityHandler('create_mr', ...)` / 等
- 删除 `internal_capability_pipelines` 表（schema-v40）
- 修改 coordinator.ts: PIPELINE_DAG_HANDLERS 检查改为"无条件走 pipeline 路径（这 3 个 capability 现在永远走 pipeline）"

```bash
git commit -m "refactor(coordinator): 删除 3 旧 handler + internal_capability_pipelines 过渡表(schema-v40)"
```

---

## Task 6: 冒烟手册 + 阶段验收

`docs/smoke-handler-migration.md`：
1. 各 internal_capability_pipelines 行存在
2. PIPELINE_DAG_HANDLERS 各种值的路由验证
3. 行为对等测试运行
4. 灰度切换流程
5. 回滚演练
6. 全部稳定后删 handler 的 checklist

```bash
git commit -m "docs(smoke): phase 4 handler 迁移冒烟手册"
```

---

## phase 4 Definition of Done

- [ ] schema-v37/38/39/40 全部应用
- [ ] 3 个 handler-vs-pipeline 行为对等测试全绿
- [ ] feature flag PIPELINE_DAG_HANDLERS 默认 'request_handover,notify_bug,create_mr'
- [ ] 旧 handler 代码完全删除
- [ ] coordinator.triggerCapability 不再有 PIPELINE_DAG_HANDLERS feature flag 检查（这 3 个 capability 永远走 pipeline）
- [ ] internal_capability_pipelines 表删除
- [ ] 冒烟手册全部验收
- [ ] baseline 6 dingtalk-sync fail 保持

phase 4 完成 = 整个 capability/pipeline 重构项目（spec §8.1 5 阶段路线图）正式收尾。
