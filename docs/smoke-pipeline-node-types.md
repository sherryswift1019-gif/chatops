# 冒烟：pipeline_node_types 注册基础设施（阶段 0）

## 验收清单

### 1. DB 状态
```bash
psql $DATABASE_URL -c "SELECT key, category, enabled FROM pipeline_node_types ORDER BY category, key;"
```
预期：5 行（script/approval/capability/wait_webhook/im_input），全部 enabled=t。

### 2. 启动日志
```bash
pnpm dev
```
预期日志包含：`[server] node-type registry verified: 5 types`。

### 3. 故意漂移
```sql
UPDATE pipeline_node_types SET enabled=false WHERE key='script';
```
重启 server，预期 throw `Node type registry mismatch:` 含 `Code only: script` 以及指向本冒烟手册的诊断提示。

恢复：
```sql
UPDATE pipeline_node_types SET enabled=true WHERE key='script';
```

### 4. API
```bash
curl http://localhost:3000/admin/pipeline-node-types | jq 'length'
```
预期：`5`（裸数组，不再是 `{items: [...]}` 包装）。

### 5. 前端
打开 pipeline 画布，新增节点 → 节点类型下拉 4 个分组（通用/流程/LLM/业务，业务为空）、5 个选项。
- API 失败时应有 visible error toast
- 节点的 stageType 如果在数据库被 disable，下拉应显示禁用提示（不会变空）

### 6. 现有 pipeline 行为零变化
触发 schema-v19 的 deploy-im-demo pipeline，跑通 IM 入口 → im_input → approval → capability 三阶段。

## 回滚
```sql
DROP TABLE IF EXISTS pipeline_node_types CASCADE;
```
（开发期，DROP 后 server 启动会因一致性检查失败 → 提示重跑 migrate）

## 故障诊断

启动时看到 `Node type registry mismatch`?
- `Code only: <key>`：说明数据库没有该节点类型，运行 `pnpm migrate` 应用最新 schema 即可
- `DB only: <key>`：说明数据库 enable 了某节点类型但代码里没有 executor 注册。检查 `src/pipeline/node-types/<key>.ts` 是否存在并被 barrel 导入；或者临时 `UPDATE pipeline_node_types SET enabled=false WHERE key='<key>'` 跳过
