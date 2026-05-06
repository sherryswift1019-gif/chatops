-- src/db/schema-v1004.sql
-- e2e_playbook_drafts: AI 生成的 playbook approve 时同步进 GitLab + 创 MR，
-- 用 mr_url 跟 committed_path 记录落仓位置（PoC 阶段做）。
ALTER TABLE e2e_playbook_drafts ADD COLUMN IF NOT EXISTS mr_url TEXT;
ALTER TABLE e2e_playbook_drafts ADD COLUMN IF NOT EXISTS committed_path TEXT;
