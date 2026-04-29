-- v58: capability_invocations.status 新增 'not_executed' 枚举值
--
-- 触发场景：claude-runner 走 executeWithPorygon 让 Agent 决定是否调 MCP 工具，
-- 但 Agent 只用文本回问参数（如"PAM Proxy部署"缺分支）没调任何工具。
-- 现状是只要 Porygon 不抛异常一律记 success，与"实际未执行"语义不符。
-- 新增 not_executed 让前端能区分"用户提交但 agent 未触发实际操作"的会话。

ALTER TABLE capability_invocations
  DROP CONSTRAINT IF EXISTS capability_invocations_status_check;

ALTER TABLE capability_invocations
  ADD CONSTRAINT capability_invocations_status_check
  CHECK (status IN ('running','success','failed','not_executed'));
