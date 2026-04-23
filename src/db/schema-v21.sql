-- v21: 新增 view_branches 能力
--
-- 作用：让用户在 IM 中直接查询某个模块的可用分支清单，
-- 避免"先记错分支名、部署 404 后才看到提示"的返工。
-- 能力内部调用 list_gitlab_branches 工具（tool_names 字段引用）。
--
-- 与 deploy 能力共享 listProjectBranches() helper（在
-- src/agent/tools/list-gitlab-branches.ts），deploy 404 时仍会自动附上分支清单。

INSERT INTO capabilities
  (key, display_name, description, category, tool_names, needs_approval, is_system,
   system_prompt, default_system_prompt)
VALUES (
  'view_branches',
  '查看分支',
  '列出指定模块在 GitLab 上的所有可用分支',
  'query',
  '["list_gitlab_branches"]',
  false,
  true,
  E'你是一个 DevOps 助手。用户通过群聊与你交互。\n当前用户角色: {{initiatorRole}}\n只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具。\n\n用户想查看某个模块的可用分支清单。调用 list_gitlab_branches 后把结果原样以列表形式展示给用户，便于复制分支名。如果用户给的模块名有歧义，工具会返回已注册模块列表，直接转述给用户。',
  E'你是一个 DevOps 助手。用户通过群聊与你交互。\n当前用户角色: {{initiatorRole}}\n只使用提供给你的 MCP 工具，不要使用 Bash 等内置工具。\n\n用户想查看某个模块的可用分支清单。调用 list_gitlab_branches 后把结果原样以列表形式展示给用户，便于复制分支名。如果用户给的模块名有歧义，工具会返回已注册模块列表，直接转述给用户。'
)
ON CONFLICT (key) DO NOTHING;
