# 冒烟：im_triggers 表 + 路由层重构（阶段 2）

## 验收清单

### 1. DB 迁移正确性

```bash
psql $DATABASE_URL -c "
SELECT
  (SELECT COUNT(*) FROM im_triggers) AS triggers,
  (SELECT COUNT(*) FROM product_line_im_triggers) AS pl_triggers,
  (SELECT COUNT(*) FROM approval_rules WHERE im_trigger_key IS NOT NULL) AS rules;"
```

预期：
- `triggers ≥ 5`（spec §3.1 下限；实际 ~28，从入口类 capability 迁移过来）
- `pl_triggers` 与原 `product_line_capabilities` 入口类行数一致（实际 ~56）
- `rules` 全部 `im_trigger_key` 非空（schema-v32 RENAME 完成）

### 2. claude-runner 字典已清除

```bash
grep -nE "writeCapabilities|CODE_CAPABILITIES|FAILURE_MSGS|CAP_NAMES" src/agent/claude-runner.ts
```

预期：无输出（phase 1 + phase 2 累计清除 4 个字典）。

`HANDLER_CAPABILITIES` 仍存在（line ~359），phase 3 处理。

### 3. 启动日志

```bash
pnpm dev
```

预期日志包含：
- `[migrate] schema-v32 applied`
- `NOTICE: schema-v32 数据迁移验证通过: im_triggers=28 / 入口类 capabilities=28`（具体数字看 seed）
- `[server] node-type registry verified: 5 types`（phase 0 残留检查）

server 正常进入 listen 状态。

### 4. IM greet 列表

群聊发 "help"（或机器人收到任意打招呼）→ 预期 `sendGreeting` 渲染的 markdown 列表来自 `im_triggers`，每个 trigger 后带 `examples[0]`（如果该 trigger 配置了 examples；初始迁移时 examples 为 `[]`，list 不带例子，需 admin 后台手工填充）。

### 5. IM 触发链路

群聊发"部署 ssh-proxy 到 dev"：

- `detectIntent` 识别为 `'deploy'`（output 空间来自 `listIMTriggers()`）
- `checkIMTriggerAccess(productLineId, 'deploy', 'dev', userRole, 'im')` 通过
- 入口审批 `router.route('deploy', 'dev')` 命中规则
- pipeline 启动

### 6. 拒绝路径

```sql
UPDATE product_line_im_triggers SET enabled=false WHERE im_trigger_key='deploy';
```

群聊触发 → 预期看到拒绝文案（含 `imTrigger.displayName` "部署服务"），不进入 pipeline。

恢复：
```sql
UPDATE product_line_im_triggers SET enabled=true WHERE im_trigger_key='deploy';
```

### 7. 失败文案（im_triggers.failure_messages 驱动）

模拟某 capability 报错（如 `analyze_bug` 触发后内部 fail）→ `buildFailureReply` 从 `im_triggers.failure_messages` 读取错误码对应文案。

初始迁移 `failure_messages={}`；要测试可先：
```sql
UPDATE im_triggers SET failure_messages='{"claude_invalid_json":"分析用时过长,未能输出完整结论"}'::jsonb
 WHERE key='analyze_bug';
```

恢复：`UPDATE ... SET failure_messages='{}'::jsonb WHERE key='analyze_bug';`

### 8. 前端 P0

- 访问 `/admin/im-triggers` → 看到 IM 触发器列表（28 行），可创建 / 编辑 / 删除 / 启用禁用
- 访问 `/admin/capabilities` → 不再展示 `default_pipeline_id` / `category` 字段（保留 LLM agent 配置：systemPrompt / toolNames / maxTurns / timeoutMs / requiresWorktree / requiresDeployLock）
- 访问 `/admin/approval-rules` → 字段名是 "IM 触发器"（不是 "Action"），下拉源是 im_triggers，含通配符 `*`，含 stale-value 兼容
- 产线详情页（`/admin/product-lines/:id`）→ 看到两个 Tab：「IM 触发器」（新）+ 「能力库 (LLM agent)」（重命名）
- admin 菜单含 "IM 触发器" 项

## 回滚

```sql
ALTER TABLE approval_rules RENAME COLUMN im_trigger_key TO action;
DROP TABLE IF EXISTS product_line_im_triggers CASCADE;
DROP TABLE IF EXISTS im_triggers CASCADE;
```

⚠️ 开发期；rollback 后 server 启动会因 router.ts / claude-runner.ts 等读 `imTriggerKey` 字段失败 → 必须先 revert 代码（`git revert <phase 2 commits>`）。

## 故障诊断

`schema-v32 数据迁移失败: im_triggers 行数 < 入口类 capability 数`?
- 检查 capabilities 表里 `category IN ('query','action','admin')` 的行
- 如果某些 capability 的 `default_pipeline_id` 引用了不存在的 pipeline_id → FK 约束失败 → 修 seed

`router.route is not a function` 或 `imTriggerKey is undefined`?
- 检查 src/approval/router.ts 是否完成改名
- 检查 admin POST /admin/approval-rules 的 body 是否传 `imTriggerKey`（不是 `action`）

claude-runner 路由层报错 detectIntent 无候选?
- 看 `listIMTriggers()` 返回是否非空
- 如果 im_triggers 表为空 → 重跑 migrate 触发数据迁移

前端 ApprovalRulesPage 报 400 / 422?
- 后端 POST /admin/approval-rules 现在期望 `imTriggerKey` 字段（不是 `action`）
- 如果前端没更新（phase 2 T9 之前），就会 400。phase 2 T9 已修复

## 已知非阻塞问题

- `src/__tests__/unit/dingtalk-sync.test.ts` 6 个 fail 是 pre-existing（phase 0 时已记录），mock URL 缺失，不阻塞 phase 2 验收

## phase 2 之后清理（独立 PR）

phase 2 完成后单独的 cleanup PR 处理：
- DROP COLUMN `capabilities.default_pipeline_id` / `category` / `param_schema` / `playbook` / `needs_approval`
- DROP CONSTRAINT 旧的 `product_line_capabilities` FK 如果不再引用

但 `product_line_capabilities` 表本身**保留**（LLM agent RBAC 仍用）。
