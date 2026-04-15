-- schema-v8.sql: 新增 "查看产线模块" 能力

INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system)
VALUES (
  'list_projects',
  '查看产线模块',
  '列出当前产线下的所有业务模块及其负责人、GitLab 路径、Harbor 项目',
  'query',
  '["list_product_line_projects"]',
  false,
  true
) ON CONFLICT (key) DO NOTHING;

UPDATE capabilities SET
  default_system_prompt = E'你是一个 DevOps 助手。用户通过群聊与你交互。\n只使用提供给你的 MCP 工具。\n直接调用 list_product_line_projects 返回模块列表，不要添加额外解释。',
  system_prompt = default_system_prompt
WHERE key = 'list_projects' AND system_prompt IS NULL;
