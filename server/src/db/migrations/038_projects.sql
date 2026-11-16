-- 038: Projects.
--
-- Every department can run several projects. A project groups the tasks,
-- milestones, people, meetings and goals that belong together. Additive only:
-- no existing row changes, and no task is put in a project by this migration.
-- Each relationship is stored once; numbers (progress, health, overdue, the
-- next milestone) are worked out when read and never stored.

CREATE TABLE IF NOT EXISTS projects (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  done_looks_like  TEXT,
  department_id    INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  lead_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status           TEXT NOT NULL DEFAULT 'PLANNED'
                   CHECK (status IN ('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
  -- "Department and members" (the default) or everyone in the company
  visibility       TEXT NOT NULL DEFAULT 'DEPARTMENT' CHECK (visibility IN ('DEPARTMENT', 'EVERYONE')),
  start_date       DATE,
  target_date      DATE,
  completed_at     TIMESTAMPTZ,
  -- where it came from (a won deal or a selected application), and the CRM's
  -- partner-facing delivery record it is linked to (one each way)
  opportunity_id   INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  engagement_id    INTEGER REFERENCES engagements(id) ON DELETE SET NULL,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at      TIMESTAMPTZ,
  CONSTRAINT projects_period_ck CHECK (target_date IS NULL OR start_date IS NULL OR target_date >= start_date)
);
CREATE INDEX IF NOT EXISTS projects_department_idx ON projects (department_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_lead_idx ON projects (lead_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_engagement_idx ON projects (engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS projects_opportunity_idx ON projects (opportunity_id) WHERE opportunity_id IS NOT NULL;

-- The people working on a project. Members see every task in it.
CREATE TABLE IF NOT EXISTS project_members (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members (user_id);

-- Dated checkpoints inside one project. "Reached" is marked by the lead.
CREATE TABLE IF NOT EXISTS project_milestones (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  target_date  DATE,
  position     INTEGER NOT NULL DEFAULT 0,
  reached_at   TIMESTAMPTZ,
  reached_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_milestones_project_idx ON project_milestones (project_id, position);

-- The lead's own word on how it is going, kept as a history.
CREATE TABLE IF NOT EXISTS project_updates (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  health      TEXT NOT NULL CHECK (health IN ('ON_TRACK', 'AT_RISK', 'OFF_TRACK')),
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_updates_project_idx ON project_updates (project_id, created_at DESC);

-- "This project supports this key result": context only. Key result values and
-- TASK_ROLLUP progress keep coming from task_key_result_links alone.
CREATE TABLE IF NOT EXISTS project_key_result_links (
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_result_id  INTEGER NOT NULL REFERENCES key_results(id) ON DELETE CASCADE,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, key_result_id)
);
CREATE INDEX IF NOT EXISTS project_kr_links_kr_idx ON project_key_result_links (key_result_id);

-- What happened to the project, in order (tasks moving in and out, members,
-- status, milestones, links). Task-level history stays in task_activity.
CREATE TABLE IF NOT EXISTS project_activity (
  id          BIGSERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_activity_project_idx ON project_activity (project_id, created_at DESC);

-- A task belongs to at most one project, and optionally to one of its milestones.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS milestone_id INTEGER REFERENCES project_milestones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id) WHERE is_archived = FALSE AND project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_milestone_idx ON tasks (milestone_id) WHERE milestone_id IS NOT NULL;

-- A meeting can belong to a project.
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS crm_meetings_project_idx ON crm_meetings (project_id) WHERE project_id IS NOT NULL;

-- "Remind me" can be set on a project: the record types widen, keeping every old one.
ALTER TABLE personal_reminders DROP CONSTRAINT IF EXISTS personal_reminders_entity_type_check;
ALTER TABLE personal_reminders ADD CONSTRAINT personal_reminders_entity_type_check
  CHECK (entity_type IN ('TASK', 'LEAD', 'DEAL', 'APPLICATION', 'MEETING', 'ACCOUNT', 'KEY_RESULT', 'OBJECTIVE', 'PROJECT'));

-- "My projects" in the Managers, Leadership and Partnerships templates (added at
-- the end, once): people who never customised get it on their next visit;
-- customised layouts are not touched (they see it under "New" in the catalogue).
UPDATE dashboard_templates
   SET layout = jsonb_set(layout, '{widgets}', COALESCE(layout->'widgets', '[]'::jsonb)
         || jsonb_build_array(jsonb_build_object('id', 'pj1', 'type', 'projects', 'typeVersion', 1, 'width', 'full', 'config', '{}'::jsonb))),
       version = version + 1,
       updated_at = now()
 WHERE key IN ('managers', 'leadership', 'partnerships')
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(layout->'widgets', '[]'::jsonb)) w WHERE w->>'type' = 'projects');
