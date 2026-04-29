-- v55: 钉钉用户离职标记
ALTER TABLE dingtalk_users ADD COLUMN IF NOT EXISTS resigned_at TIMESTAMPTZ NULL;
-- NULL = 在职；非空 = 离职时间戳

-- v28 中 email 列可能因测试库不加载 v28 而缺失（v28 含 seed 数据被排除）
-- 此处补全，保证测试库可用 upsertDingTalkUser 的 email 参数
ALTER TABLE dingtalk_users ADD COLUMN IF NOT EXISTS email TEXT;
CREATE INDEX IF NOT EXISTS idx_dingtalk_users_email_lower
  ON dingtalk_users (LOWER(email));
