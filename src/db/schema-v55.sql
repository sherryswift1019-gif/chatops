-- v55: 钉钉用户离职标记
ALTER TABLE dingtalk_users ADD COLUMN IF NOT EXISTS resigned_at TIMESTAMPTZ NULL;
-- NULL = 在职；非空 = 离职时间戳
