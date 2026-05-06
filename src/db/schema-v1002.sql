-- src/db/schema-v1002.sql
-- 修复：部分 PoC 部署的 pipeline_node_types.invoke_target_script.enabled = FALSE
-- 原因：v1000 早期提交 INSERT 列错位（漏 category 列）导致 enabled fallback 到默认 FALSE，
-- _migrations 已记录 v1000 applied，直接修 schema-v1000.sql 无效。
-- 后果：server 启动 assertRegistryConsistent 抛 "Code only: invoke_target_script" → crash loop。
UPDATE pipeline_node_types SET enabled = TRUE WHERE key = 'invoke_target_script';
