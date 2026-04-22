# LangGraph Pipeline 引擎冒烟手册

> 手工执行的端到端验证清单。覆盖规约 6.5 中"需要真 Postgres + 真钉钉"才能验证的场景。
> 单元测试（vitest）只覆盖 graph-builder / graph-runner / resume route 的纯逻辑，本清单负责剩下的回路（UI → 后端 → checkpointer → 钉钉 → 续跑）。

## 背景：Pipeline 引擎开关

默认使用 **LangGraph 引擎**（`compile + stream + PostgresSaver` checkpoint）。

回退到旧 for-loop 实现：设置 `PIPELINE_ENGINE=legacy` 并重启后端。
**限制**：legacy 仅在流水线 **不含** `approval` / `wait_webhook` stage 时可用；否则 `POST /admin/test-runs`（或 cron 调度）在启动阶段就会抛错（见 `src/pipeline/executor-legacy.ts` 前置校验）。

可选观测链路：设置 `LANGSMITH_API_KEY` + `LANGCHAIN_TRACING_V2=true`，每次 run 会在 LangSmith 看到 trace。

---

## 前置

1. `docker compose up -d postgres` 起本机 Postgres（compose 服务名 `postgres`，端口 5432）。
2. `.env` 至少配好：
   - `DATABASE_URL=postgres://chatops:chatops@127.0.0.1:5432/chatops`
   - `DINGTALK_CORP_ID` / `DINGTALK_AGENT_ID` / `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET`
   - `CLAUDE_CODE_OAUTH_TOKEN`（或在系统配置页面 Claude 标签填写）
3. `pnpm migrate` 跑业务表迁移。
4. `pnpm dev` 起后端（首次接到含 approval 的流水线时，`PostgresSaver.setup()` 会自动创建 `checkpoints / checkpoint_blobs / checkpoint_writes / checkpoint_migrations` 四张 LangGraph 表——这是 checkpointer 首次启用的一次性副作用）。
5. `cd web && pnpm dev` 起前端（5173 → 代理 `/admin` → 3000）。

## 冒烟流水线：script → approval → script

在 Web UI 建：

1. **产品线** > 任选一个（例：`paraview`）。
2. **服务器** > 建一台可 ssh 的机器，角色 `app`（用于 script stage 落点）。
3. **流水线** > 新建，3 个 stage：
   - Stage 1：`script`，`echo hello`，`targetRoles=[app]`，`onFailure=continue`。
   - Stage 2：`approval`，`approverIds=[<你的钉钉 userId>]`，`description=测试审批`。
   - Stage 3：`script`，`echo world`，`targetRoles=[app]`。

---

## 路径 A：钉钉卡片批准 → 续跑成功

1. UI 打开流水线详情页，点击"手动触发"。
2. 钉钉收到审批卡片（文案"测试审批"）。
3. 卡片上点"同意"。
4. ≤ 5 秒内检查：

```bash
docker exec -it chatops-postgres-1 psql -U chatops -d chatops -c \
  "SELECT id, status, current_stage, stage_results FROM test_runs ORDER BY id DESC LIMIT 1;"
```

期望：`status=success`，`stage_results` 三条全部 `status=success`。

## 路径 B：UI 续跑按钮批准

复刻路径 A 的前两步直到卡片出现，然后：

1. **不**点钉钉卡片。进到 UI 的 test-run 详情页，点页面上的"批准"按钮。
2. 前端发送 `POST /admin/test-runs/:id/resume` with `{ decision: 'approved' }`。
3. 验证与路径 A 一致。

> 路径 A 与 B 走的是同一个 `resumeRun()` 入口，区别仅在触发方——两条路径都跑一次是为了回归 Task 5 新增的 resume API 与 Task 6 新增的前端按钮联动。

## 路径 C：钉钉卡片拒绝 → 终止 + 后续 skipped

1. 触发一条新 run。
2. 钉钉卡片上点"拒绝"。
3. 查库：

```bash
docker exec -it chatops-postgres-1 psql -U chatops -d chatops -c \
  "SELECT status, stage_results FROM test_runs WHERE id = <run_id>;"
```

期望：`status=failed`；stage 2（approval）`status=failed`、`error=rejected`；stage 3 `status=skipped`（被 `skip_rest` 节点标记）。

## 路径 D：legacy 引擎的 UX 回归

1. 停后端，设置 `PIPELINE_ENGINE=legacy`，重启。
2. **用同一条** 含 approval 的流水线触发。
3. 期望：**启动时立刻** 返回 "PIPELINE_ENGINE=legacy 不支持 approval / wait_webhook 阶段..." 错误——不是在 stage 2 才 fail（这是 Task 4 前置校验修的坑）。
4. 把 `PIPELINE_ENGINE` 环境变量去掉、重启，再跑一次，应恢复正常。

---

## 观察点

- **LangGraph checkpoint 表**：首次运行 approval 流水线后，`\dt` 能看到 4 张 `checkpoints*` 表。
- **run 状态持久化**：run 处于 approval 等待时，`test_runs.status='pending'`、`current_stage=1`（0-indexed）；`checkpoints` 表有对应 thread_id 的行。
- **checkpoint 续跑只重跑挂起点之后**：单元测试已覆盖（`src/__tests__/unit/graph-builder.test.ts` 的 "checkpoint resume does not replay completed stages"），本手册只在 UI 上观察行为——stage 3 的日志时间戳应晚于 stage 1 数秒/数十秒（反映你在审批卡片上停留的时间）。
- **LangSmith trace**（若启用）：每条 run 对应一个 trace，节点名形如 `stage_0_script / stage_1_approval / stage_2_script / skip_rest_after_1`。

## 排查

- 卡片不弹出：检查 `DINGTALK_*` 配置、审批人 userId 是否正确，后端日志关键字 `approval-manager`。
- 点完批准后 run 仍 pending：检查后端进程是否被重启过（内存里的 graph 实例在进程重启时丢失，但 PostgresSaver 里的 checkpoint 还在，可以通过 `POST /admin/test-runs/:id/resume` 手动驱动一次）。
- `checkpoints` 表没被建出：确认至少跑过一条 **含 approval/webhook** 的流水线；纯 script 流水线也会走 graph-runner，但 checkpoint 在首次写入时才触发建表。

---

## 可视化画布（2026-04-21）

### 前提

- `pnpm migrate` 已执行，`test_pipelines.graph` 列存在
- 后端 `pnpm dev` 运行，前端 `cd web && pnpm dev` 运行

### 用例 1：现有线性 pipeline 打开画布

1. 列表页点击任意一条现有 pipeline 的「画布编辑」
2. 预期：画布显示为线性链（由 `linearizeStages` 自动生成），节点数与旧 stages 一致，每个节点按 stage type 着色（蓝/黄/紫/灰）
3. 点击某个节点，右侧 Drawer 出现字段，修改名称后顶栏出现 "● 未保存"
4. 点"保存" → Toast "已保存"，dirty 清除
5. 刷新页面，修改持久化

### 用例 2：条件分支 pipeline

1. 新建一条只有一个 script stage 的 pipeline（列表页旧表单）
2. 进入画布，"添加节点 → 运行脚本" 2 次，共 3 个节点 A / B / C
3. A 拖拽连线到 B（默认无条件边）；A 再连到 C
4. 点击 A→B 的边 → Popover 弹出 → 选"上游成功时" → 确定，边上出现"成功时"标签
5. 点击 A→C 的边 → 选"上游失败时"
6. "自动排版" → dagre 重新布局
7. 保存；打开 PG `select graph from test_pipelines where id = ...` → 能看到 3 nodes + 2 edges + condition
8. 列表页「执行」这条 pipeline，A 成功路径预期走 B；若 A 失败（可把脚本改成 `exit 1`）走 C

### 用例 3：校验失败

1. 画布上删除 B 节点（保留指向它的 edge）→ 保存
2. 预期：Toast 错误，details 列出 "edge ... target references missing node"
3. 前端不崩溃，dirty 仍保留

### 观察点

- 保存后，`test_pipelines.stages` 列不变；`graph` 列被更新
- runtime 读取：`pipeline.graph IS NOT NULL` 时走新路径，否则 fallback linearize stages
- 条件 expression 首版仅支持两种模板：`status === 'success'|'failed'|'skipped'` 或 `output.includes('...')`，其它一律返回 false

### 排查

- 画布打开一片空白：检查 `GET /admin/test-pipelines/:id/graph` 返回、`getTestServers` 是否有 role
- 保存一直失败：看 Response body.details；常见原因是删节点没删 edge，或连出了 cycle
