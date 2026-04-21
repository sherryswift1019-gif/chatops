# 冒烟：IM 驱动的 Pipeline

本次改造让 IM 对话式触发具备 Pipeline 的容错/审批/回滚能力。核心路径：
IM 消息 → Capability 绑定的 Pipeline → `im_input` 参数澄清 Stage → 审批 → 执行。

## 前置

- 数据库已 migrate 到 v15（`pnpm migrate`）
- `deploy` capability 已绑 `deploy-im-demo` pipeline（schema-v15 自动 seed；
  若环境无 `product_lines` 记录需先建产线再重跑 migrate 让 seed 生效）
- 钉钉 / 飞书 adapter 正常启动
- 已在 ChatOps 所在群把机器人加进去

## 场景 1：一次性填完所有参数（happy path）

**步骤**：群里 @机器人 "deploy"

**预期链路**：
1. `coordinator.triggerCapability` 读到 `deploy.default_pipeline_id`
2. 启动 pipeline，返回 `runId`
3. 首个 `im_input` stage `interrupt()`，`graph-runner` 注册 IM waiter 到 im-router
4. `notifyImGroup` 把 prompt 推到群：
   > 请告诉我：模块 / 环境 / 分支。可以一次性写 `project=xxx env=dev branch=main`，也可以分条回。

**步骤**：群里回："project=demo env=dev branch=main"

**预期**：
- `session-manager` 发现 IM waiter，调 `resumeFromImInput` 把消息喂回 graph
- `consultImInputAgent` 解析 → 参数齐全 → stage 标 success
- 参数合入 `runtimeVars`，graph 进入下一 stage（审批）
- 群里收到部署审批卡片

## 场景 2：分轮澄清（多次 interrupt）

**步骤**：

1. `@机器人 deploy` → 收到首 prompt
2. 回 `project=demo` → 机器人追问 env
3. 回 `env=production` → 机器人提示"环境 的取值必须是：dev / staging / prod"
4. 回 `env=dev` → 机器人追问 branch
5. 回 `main`（裸值——因为只剩一个必填） → 参数齐全，进入审批

**预期**：
- 每轮消息都走 `resumeFromImInput`
- 4 次 interrupt 后 stage 成功，downstream stage 激活

## 场景 3：用户取消

**步骤**：`@机器人 deploy` → 收到 prompt → 回 "取消"

**预期**：
- `consultImInputAgent.aborted=true`
- im_input stage failed，`error='user_cancelled'`
- `onFailure='stop'` → 下游 stage skipped
- pipeline run finishTestRun status='failed'

## 场景 4：超时

**步骤**：`@机器人 deploy` → 收到 prompt → 10 分钟（`imInputConfig.timeoutSeconds`）不回

**预期**：
- `graph-runner` 的 setTimeout 触发，调 `resumeRun(runId, Command({resume: IM_INPUT_TIMEOUT_SENTINEL}))`
- handler 识别 sentinel → stage failed `error='im_input_timeout'`
- 群里收到 "IM 输入超时..." 的 stage 失败消息（可选，看 finalize report）
- run 终态 failed

## 场景 5：降级（未绑定 pipeline）

给未绑 `default_pipeline_id` 的 capability（如 `view_deployments`）发消息。

**预期**：`coordinator.triggerCapability` 走 `handlers.get(key)` 分支，表现与改造前完全一致（走 Agent 直接处理）。这保证**零回归**。

## 验证工具

```bash
# 查看 capability ↔ pipeline 绑定
docker compose exec postgres psql -U chatops -c \
  "SELECT c.key, c.default_pipeline_id, p.name
   FROM capabilities c LEFT JOIN test_pipelines p ON p.id = c.default_pipeline_id
   WHERE c.default_pipeline_id IS NOT NULL;"

# 查看最近 IM 触发的 run
docker compose exec postgres psql -U chatops -c \
  "SELECT id, pipeline_id, status, current_stage, trigger_type, triggered_by
   FROM test_runs WHERE trigger_type='im' ORDER BY id DESC LIMIT 5;"

# 查看 im-router 当前 waiter（需调用进程内 listWaiters；调试可临时加 admin route）
```

## 关键日志 grep

```
[AgentCoordinator] pipeline run #N started
[graph-runner] dispatchInterrupt... IM_INPUT
[SessionManager] Routing to pipeline run=... stage=...
[im-notifier] send failed ...
```

## 已知限制（v1）

- 进程重启时 `im-router` 内存丢失。Checkpoint 里的 interrupt payload 还在，
  但群里新消息无法路由到 run——v1 由超时兜底；v2 可做"启动时扫描 pending
  interrupt 重建 waiter"。
- 同群并发两条 pipeline 时，`registerImWaiter` 只保留最新一条（会清前一条
  的映射，但前一条的 run 仍挂在 interrupt 等超时）。v1 接受。
- `im-input-agent` 只做启发式 key=value / 单字段模式；若 `imInputConfig.
  capabilityKey` 设置了也暂未走 Claude fallback，留给下一轮迭代。
