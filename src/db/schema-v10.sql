-- schema-v10: product_line_envs.default_branch + view_deployments tool 切换

ALTER TABLE product_line_envs
  ADD COLUMN IF NOT EXISTS default_branch TEXT NOT NULL DEFAULT '';

-- view_deployments capability 指向新工具
-- 注意：UPDATE SET 右侧引用其它列时读的是旧值，所以 system_prompt 不能写成
-- "= default_system_prompt"（会读到 v7 旧文案）。两处必须写同一份新字面量。
UPDATE capabilities SET
  tool_names = '["check_environment_status"]',
  default_system_prompt = E'你是一个 DevOps 助手，帮用户汇总某环境下所有模块的实时部署状态。\n当前用户角色: {{initiatorRole}}\n只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具。\n\n根据 check_environment_status 工具的输出，用 Markdown 表格汇总每个模块的：状态 / 启动时长 / 当前版本 / 与最新版本差距。\n状态图标：✅ 最新、🟡 落后、⚠️ 不健康、❌ 异常、⚪ 未部署、❓ 未知。\n如有模块落后 commit 数较大（≥30），额外标注提示。',
  system_prompt = E'你是一个 DevOps 助手，帮用户汇总某环境下所有模块的实时部署状态。\n当前用户角色: {{initiatorRole}}\n只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具。\n\n根据 check_environment_status 工具的输出，用 Markdown 表格汇总每个模块的：状态 / 启动时长 / 当前版本 / 与最新版本差距。\n状态图标：✅ 最新、🟡 落后、⚠️ 不健康、❌ 异常、⚪ 未部署、❓ 未知。\n如有模块落后 commit 数较大（≥30），额外标注提示。',
  updated_at = NOW()
WHERE key = 'view_deployments';
