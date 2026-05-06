-- src/db/schema-v1005.sql
-- PoC e2e 测试：取消首次登录强制改密。
-- schema-v9 INSERT admin user 时写了 must_change_password=TRUE，导致沙盒里
-- admin/admin 第一次登录被强制跳改密页，e2e scenario 没法直接验登录跳转。
-- 这里 UPDATE 现有 admin_users 全部置 FALSE；后续 v9 不会重跑（_migrations 已 applied），
-- 但每次新沙盒跑全套 migrate 时 v1005 一定会接在 v9 后跑，把那行 admin 重写成 FALSE。
UPDATE admin_users SET must_change_password = FALSE WHERE must_change_password = TRUE;
