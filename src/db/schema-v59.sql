-- v59: 给已部署库的 diagnose_and_repair capability 补上 run_remote_command 工具
--
-- 历史背景：v51 注册 diagnose_and_repair 时只挂了 check_env_status / get_logs
-- 两个查询型工具，LLM 没有任何能在远端 server 执行命令的能力，无法落实 prompt
-- 中"诊断并修复并重试"的设计意图（参见 src/agent/repair/diagnose-repair-handler.ts
-- 改动）。新加的 run_remote_command MCP 工具走 SSH 到 test_servers 中已注册的
-- 主机执行 shell，本迁移把它挂到 capability 的 tool_names 里。
--
-- 注意 v51 的 ON CONFLICT 子句故意不更新 tool_names（避免把人手调过的关联抹掉），
-- 所以单改 v51.sql 对已 applied 的库不生效，必须独立的 UPDATE migration。

UPDATE capabilities
SET tool_names = (
  SELECT jsonb_agg(DISTINCT t)
  FROM jsonb_array_elements_text(
    tool_names || '["run_remote_command"]'::jsonb
  ) AS t
)
WHERE key = 'diagnose_and_repair'
  AND NOT (tool_names @> '"run_remote_command"');
