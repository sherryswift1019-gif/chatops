-- v38: 修 im_triggers.pipeline_id 外键 ON DELETE RESTRICT → SET NULL
-- 删产线时,它的 test_pipelines 被级联删,但 im_triggers 是全局表
-- (不挂 product_line),原 RESTRICT 阻断产线删除流程。
-- 与 v19 注释 capabilities.default_pipeline_id 的原始语义一致:
-- "ON DELETE SET NULL：pipeline 删除时,binding 自动解除,不连带删除 capability"。
-- v32 迁到 im_triggers 时无意改成 RESTRICT,本迁移把语义恢复回 SET NULL。

ALTER TABLE im_triggers
  DROP CONSTRAINT IF EXISTS im_triggers_pipeline_id_fkey;

ALTER TABLE im_triggers
  ADD CONSTRAINT im_triggers_pipeline_id_fkey
  FOREIGN KEY (pipeline_id) REFERENCES test_pipelines(id) ON DELETE SET NULL;
