-- TaskFlow initial schema.
-- All objects are created inside the configured schema (default: taskflow) so the
-- module can be dropped into the existing EkoSight database without name clashes.

CREATE TABLE departments (
  id            SERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT NOT NULL DEFAULT '#64748b',
  position      INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                       SERIAL PRIMARY KEY,
  full_name                TEXT NOT NULL,
  email                    TEXT NOT NULL,
  password_hash            TEXT,
  role                     TEXT NOT NULL DEFAULT 'member'
                           CHECK (role IN ('admin', 'manager', 'member', 'viewer')),
  department_id            INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  job_title                TEXT,
  phone                    TEXT,
  avatar_color             TEXT NOT NULL DEFAULT '#3b82f6',
  -- capacity is used for the bandwidth / idle calculations on the dashboard
  weekly_capacity_hours    NUMERIC(6, 2) NOT NULL DEFAULT 40,
  max_concurrent_tasks     INTEGER NOT NULL DEFAULT 8,
  -- fine grained overrides layered on top of the role's default permission set
  extra_permissions        TEXT[] NOT NULL DEFAULT '{}',
  revoked_permissions      TEXT[] NOT NULL DEFAULT '{}',
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password     BOOLEAN NOT NULL DEFAULT TRUE,
  token_version            INTEGER NOT NULL DEFAULT 1,
  last_login_at            TIMESTAMPTZ,
  last_activity_at         TIMESTAMPTZ,
  -- reserved for mapping a TaskFlow member onto a user of the existing application
  external_user_id         TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email));
CREATE INDEX users_department_idx ON users (department_id);

CREATE TABLE workflow_statuses (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  -- the fixed lifecycle stage a custom status belongs to; dashboards group by this
  stage         TEXT NOT NULL DEFAULT 'todo'
                CHECK (stage IN ('backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled')),
  color         TEXT NOT NULL DEFAULT '#64748b',
  position      INTEGER NOT NULL DEFAULT 0,
  wip_limit     INTEGER,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id                    SERIAL PRIMARY KEY,
  ref                   TEXT NOT NULL UNIQUE,
  title                 TEXT NOT NULL,
  description           TEXT,
  department_id         INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  status_id             INTEGER NOT NULL REFERENCES workflow_statuses(id) ON DELETE RESTRICT,
  priority              TEXT NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  task_type             TEXT NOT NULL DEFAULT 'task',
  assignee_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reporter_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start_date            DATE,
  due_date              TIMESTAMPTZ,
  original_due_date     TIMESTAMPTZ,
  due_date_changes      INTEGER NOT NULL DEFAULT 0,
  completed_at          TIMESTAMPTZ,
  estimate_hours        NUMERIC(7, 2),
  spent_hours           NUMERIC(7, 2) NOT NULL DEFAULT 0,
  progress              INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  blocked_reason        TEXT,
  position              NUMERIC NOT NULL DEFAULT 1000,
  is_archived           BOOLEAN NOT NULL DEFAULT FALSE,
  -- set once the deadline breach has been evaluated so black marks are not duplicated
  breach_evaluated_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tasks_status_idx     ON tasks (status_id);
CREATE INDEX tasks_assignee_idx   ON tasks (assignee_id);
CREATE INDEX tasks_department_idx ON tasks (department_id);
CREATE INDEX tasks_due_date_idx   ON tasks (due_date);
CREATE INDEX tasks_archived_idx   ON tasks (is_archived);

CREATE TABLE task_checklist_items (
  id          SERIAL PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  is_done     BOOLEAN NOT NULL DEFAULT FALSE,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_checklist_task_idx ON task_checklist_items (task_id);

CREATE TABLE task_comments (
  id          SERIAL PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_comments_task_idx ON task_comments (task_id);

CREATE TABLE task_activity (
  id          SERIAL PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  field       TEXT,
  from_value  TEXT,
  to_value    TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_activity_task_idx    ON task_activity (task_id);
CREATE INDEX task_activity_created_idx ON task_activity (created_at DESC);

CREATE TABLE blackmark_rules (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  description          TEXT,
  trigger_type         TEXT NOT NULL
                       CHECK (trigger_type IN ('deadline_missed', 'overdue_escalation', 'completed_late', 'task_reopened', 'manual')),
  points               NUMERIC(5, 2) NOT NULL DEFAULT 1,
  -- hours of slack after the due date before the rule fires
  grace_hours          INTEGER NOT NULL DEFAULT 0,
  -- empty array means "applies to everything"
  priorities           TEXT[] NOT NULL DEFAULT '{}',
  department_ids       INTEGER[] NOT NULL DEFAULT '{}',
  -- for overdue_escalation: re-apply every N days while the task stays overdue
  repeat_every_days    INTEGER,
  max_points_per_task  NUMERIC(5, 2),
  severity             TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high')),
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE black_marks (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id        INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  rule_id        INTEGER REFERENCES blackmark_rules(id) ON DELETE SET NULL,
  points         NUMERIC(5, 2) NOT NULL DEFAULT 1,
  reason         TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waived')),
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_month   DATE NOT NULL,
  -- de-duplication key, e.g. "rule:3:task:41:cycle:2" so a scan is idempotent
  occurrence_key TEXT NOT NULL,
  waived_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  waived_reason  TEXT,
  waived_at      TIMESTAMPTZ,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX black_marks_occurrence_idx ON black_marks (occurrence_key);
CREATE INDEX black_marks_user_idx   ON black_marks (user_id);
CREATE INDEX black_marks_period_idx ON black_marks (period_month);

CREATE TABLE notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, is_read);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
