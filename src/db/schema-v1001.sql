-- src/db/schema-v1001.sql
-- E2E 段位 schema 升级：support pipeline-b 人审 gate（新 status awaiting_human_review）
-- + evidence_manifest 容量上限 32KB → 64KB（playbook claudeTrace 体积更大）

-- e2e_runs.status 加 'awaiting_human_review'。CHECK 约束是匿名的，先按默认命名 drop，
-- 再以显式名 e2e_runs_status_check 加回（含新 status）。
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'e2e_runs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%awaiting_fix%'
  LOOP
    EXECUTE format('ALTER TABLE e2e_runs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE e2e_runs
  ADD CONSTRAINT e2e_runs_status_check
  CHECK (status IN ('pending','running','awaiting_fix','awaiting_human_review','passed','failed','aborted'));

-- e2e_scenario_runs.evidence_manifest 容量上限：32KB → 64KB（claudeTrace 多步 + acceptance 详情）。
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'e2e_scenario_runs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%32768%'
  LOOP
    EXECUTE format('ALTER TABLE e2e_scenario_runs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE e2e_scenario_runs
  ADD CONSTRAINT e2e_scenario_runs_manifest_size_check
  CHECK (evidence_manifest IS NULL OR length(evidence_manifest::text) < 65536);
