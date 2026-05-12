-- v64: requirements.skip_e2e — 触发时勾选「跳过 E2E 测试」，dev_push 后直接到 final_approval

ALTER TABLE requirements
  ADD COLUMN IF NOT EXISTS skip_e2e BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN requirements.skip_e2e IS
  '触发时勾选「跳过 E2E 测试」；QI 拓扑 v14 起 dev_push 后由 e2e_skip_router 按此字段分流';
