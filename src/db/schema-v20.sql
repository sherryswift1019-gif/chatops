-- ============================================================
-- schema-v20: 彻底删除 module_owners（2026-04-22）
-- ============================================================
-- 背景：v8 建的 module_owners 表当初作为 projects.owner_id 缺失时的
-- fallback 审批/通知对象来源。commit d022f42（2026-04-21）先做了"最小删"
-- —— 只删前端 UI，保留 DB 层兜底。本次决策 A：删 fallback，owner 必须配到
-- projects.owner_id，不再走 module_owners。
--
-- 同步改动：
--   - src/db/repositories/module-owners.ts [整个文件删]
--   - src/admin/routes/module-owners.ts [整个文件删]
--   - src/agent/approval/resolvers.ts / coordinator.ts / handover/* / notify/*
--     fallback 全部改为 `?? null`（或 `?? ''`）
--   - src/db/seed.sql 两条 INSERT 已删
-- ============================================================

DROP TABLE IF EXISTS module_owners CASCADE;
