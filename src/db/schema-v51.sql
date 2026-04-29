-- v51: diagnose_and_repair 通用修复 capability
INSERT INTO capabilities (key, display_name, description, category, tool_names)
VALUES (
  'diagnose_and_repair',
  '诊断并修复',
  '分析失败步骤的日志，通过 SSH 工具施以修复并重试，最多 N 次（默认 4）',
  'ops',
  '["check_env_status", "get_logs", "run_remote_command"]'::jsonb
)
ON CONFLICT (key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description,
      category     = EXCLUDED.category;
