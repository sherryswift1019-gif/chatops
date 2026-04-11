CREATE TABLE IF NOT EXISTS user_roles (
  id          SERIAL PRIMARY KEY,
  platform    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  user_name   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('developer','tester','ops','admin')),
  group_id    TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform, user_id, group_id)
);

CREATE TABLE IF NOT EXISTS approval_rules (
  id                   SERIAL PRIMARY KEY,
  action               TEXT NOT NULL DEFAULT '*',
  env                  TEXT NOT NULL DEFAULT '*',
  primary_approvers    JSONB NOT NULL DEFAULT '[]',
  backup_approvers     JSONB NOT NULL DEFAULT '[]',
  primary_timeout_min  INT NOT NULL DEFAULT 10,
  total_timeout_min    INT NOT NULL DEFAULT 20,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL,
  platform      TEXT NOT NULL,
  initiator_id  TEXT NOT NULL,
  intent        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','pending_approval','approved',
                                    'executing','done','rejected','cancelled','timeout')),
  tool_name     TEXT,
  tool_params   JSONB,
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at   TIMESTAMPTZ,
  approved_by   TEXT,
  executed_at   TIMESTAMPTZ,
  done_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id            SERIAL PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  approver_id   TEXT NOT NULL,
  approver_type TEXT NOT NULL CHECK (approver_type IN ('primary','backup')),
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at  TIMESTAMPTZ,
  decision      TEXT CHECK (decision IN ('approved','rejected','timeout')),
  dm_message_id TEXT
);

CREATE TABLE IF NOT EXISTS deployments (
  id            SERIAL PRIMARY KEY,
  project       TEXT NOT NULL,
  env           TEXT NOT NULL,
  image_tag     TEXT NOT NULL,
  image_digest  TEXT,
  deployed_by   TEXT NOT NULL,
  approved_by   TEXT,
  deployed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'success'
                  CHECK (status IN ('success','failed','rolled_back'))
);

CREATE TABLE IF NOT EXISTS image_cache (
  id              SERIAL PRIMARY KEY,
  project         TEXT NOT NULL,
  tag             TEXT NOT NULL,
  digest          TEXT,
  built_at        TIMESTAMPTZ,
  commit_sha      TEXT,
  commit_message  TEXT,
  pipeline_id     BIGINT,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project, tag)
);

CREATE TABLE IF NOT EXISTS gitlab_events (
  id            SERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,
  project       TEXT NOT NULL,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_group_status ON tasks(group_id, status);
CREATE INDEX IF NOT EXISTS idx_image_cache_project ON image_cache(project, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
