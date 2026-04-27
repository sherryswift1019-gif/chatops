-- v39: 修 internal_capability_pipelines.pipeline_id 外键 NO ACTION → CASCADE
-- v37 建表时 FK 没指定 ON DELETE 行为(默认 NO ACTION),阻止删 pipeline 所属产线。
-- pipeline_id 是 NOT NULL,不能 SET NULL,只能 CASCADE 删映射条目。
-- 删后 request_handover 触发会落到 coordinator.ts L204-209 的退化路径
-- (warn + 走 handler),不致命。

ALTER TABLE internal_capability_pipelines
  DROP CONSTRAINT IF EXISTS internal_capability_pipelines_pipeline_id_fkey;

ALTER TABLE internal_capability_pipelines
  ADD CONSTRAINT internal_capability_pipelines_pipeline_id_fkey
  FOREIGN KEY (pipeline_id) REFERENCES test_pipelines(id) ON DELETE CASCADE;
