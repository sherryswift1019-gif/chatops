# 冒烟：capabilities 表瘦身 + 3 处硬编码清理（阶段 1）

## 验收清单

### 1. DB 状态

```bash
psql $DATABASE_URL -c "SELECT key, max_turns, timeout_ms, requires_worktree, requires_deploy_lock FROM capabilities ORDER BY key;"
```

预期：每行都有 4 列值；
- `deploy / rollback / restart` 三行 `requires_deploy_lock=t`
- `analyze_bug / fix_bug_l1 / fix_bug_l2 / fix_bug_l3` 四行 `requires_worktree=t`
- 其它行两个 boolean 都为 `f`
- 所有行 `max_turns=30` / `timeout_ms=1200000`（来自 DEFAULT）

### 2. 启动日志

```bash
pnpm dev
```

预期日志包含：
- `[migrate] schema-v31 applied`（首次启动）
- `NOTICE:  schema-v31 backfill 验证通过: lock=3, worktree=4`（首次启动；后续 IF NOT EXISTS 跳过 ALTER 但 UPDATE 仍会执行）
- `[server] node-type registry verified: 5 types`（phase 0 残留检查）

server 正常进入 listen 状态。

### 3. claude-runner 三处硬编码字典已不复存在

```bash
grep -nE "writeCapabilities|CODE_CAPABILITIES" src/agent/claude-runner.ts
```

预期：无输出。

### 4. Deploy lock 路径（DB 驱动验证）

模拟 IM 触发 `部署 ssh-proxy 到 dev`：

- 在 IM 触发前 `psql $DATABASE_URL -c "UPDATE capabilities SET requires_deploy_lock=false WHERE key='deploy';"`
- 触发 deploy → 预期不再尝试 acquireLock（log 中无 `[deploy-lock] acquired` 调用）
- 恢复：`psql ... SET requires_deploy_lock=true WHERE key='deploy';`

### 5. Worktree 路径（DB 驱动验证）

模拟 IM 触发 bug 分析：

- 在触发前 `psql $DATABASE_URL -c "UPDATE capabilities SET requires_worktree=false WHERE key='analyze_bug';"`
- 触发 analyze_bug → 预期 log 无 `Worktree acquired`
- 恢复：`SET requires_worktree=true WHERE key='analyze_bug';`

### 6. maxTurns / timeoutMs 路径（DB 驱动验证）

```bash
psql $DATABASE_URL -c "UPDATE capabilities SET max_turns=5 WHERE key='deploy';"
```

触发 deploy → 走到 5 轮 tool call 后 Porygon 终止（log 中应看到 maxTurns 提前命中的提示）。

恢复：`SET max_turns=30 WHERE key='deploy';`

### 7. 现有 pipeline 行为零回归

触发 schema-v19 的 `deploy-im-demo` pipeline，跑通 IM 入口 → im_input → approval → capability 三阶段。capability stage 内部的 LLM 行为现在按 capability 行的 maxTurns/timeoutMs 走，不应有可见差别。

## 回滚

```sql
ALTER TABLE capabilities
  DROP COLUMN IF EXISTS max_turns,
  DROP COLUMN IF EXISTS timeout_ms,
  DROP COLUMN IF EXISTS requires_worktree,
  DROP COLUMN IF EXISTS requires_deploy_lock;
```

⚠️ 开发期；rollback 后 server 启动会因 `capabilities.mapRow` 读不到列报 TS-runtime 错，需要先 revert 代码（`git revert <phase 1 commits>`）。

## 故障诊断

启动时看到 `schema-v31 backfill 失败: requires_deploy_lock=true 应匹配 3 行(deploy/rollback/restart),实际 N`?

- 检查 capabilities 表是否包含 deploy/rollback/restart 三个 key。如某 capability key 在你的环境下被自定义改名或删除，UPDATE 命中数会偏离。
- 处理：先恢复 seed（重新跑 `src/db/seed.sql` 或 schema 中相关 INSERT），再重跑 migrate。

启动时看到 `schema-v31 backfill 失败: requires_worktree=true 应匹配 4 行(...),实际 N`?

- 同上，但检查 analyze_bug + fix_bug_l1/l2/l3 这 4 个 key 是否存在。

测试时看到 `relation "pipeline_node_types" does not exist` 或 `column "max_turns" does not exist`?

- 检查 `src/__tests__/helpers/db.ts` 的 `SCHEMA_FILES` 数组是否包含 `'schema-v30.sql'` 和 `'schema-v31.sql'`。phase 0 引入的 forward policy：纯 ALTER + non-polluting backfill 必须加进 SCHEMA_FILES，否则 `resetTestDb()` 后表/列丢失。

## 已知 pre-existing 问题（不阻塞 phase 1）

- `src/__tests__/unit/dingtalk-sync.test.ts` 6 个 fail：mock url `https://oapi.dingtalk.com/topapi/v2/department/get` 缺失，phase 0 已记录为 pre-existing。phase 1 没引入新的 fail。
