-- OKR / Goals module.
--
-- Strictly additive: this migration CREATEs new tables and indexes and does not
-- ALTER, DROP, RENAME or write to a single existing table. In particular the
-- tasks table gains no columns — the only connection between a task and the OKR
-- hierarchy is the task_key_result_links join table below, so every existing task
-- keeps behaving exactly as it does today whether or not it is ever linked.

-- ---------------------------------------------------------------- objectives

CREATE TABLE objectives (
  id                     SERIAL PRIMARY KEY,
  title                  TEXT NOT NULL,
  description            TEXT,
  -- COMPANY objectives belong to the whole business, DEPARTMENT ones to a team
  scope_type             TEXT NOT NULL DEFAULT 'DEPARTMENT'
                         CHECK (scope_type IN ('COMPANY', 'DEPARTMENT')),
  department_id          INTEGER REFERENCES departments(id) ON DELETE RESTRICT,
  -- optional cascade: a department objective may roll up to a company one
  parent_objective_id    INTEGER REFERENCES objectives(id) ON DELETE SET NULL,
  owner_user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- the period is the source of truth; any duration is allowed
  start_date             DATE NOT NULL,
  end_date               DATE NOT NULL,
  priority               TEXT NOT NULL DEFAULT 'medium'
                         CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  -- status is what someone decided; health is what the numbers say. Never mixed.
  status                 TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
  manual_health          TEXT
                         CHECK (manual_health IN ('NOT_STARTED', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETED')),
  health_override_reason TEXT,
  health_override_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  health_override_at     TIMESTAMPTZ,
  -- matches the archive convention used by tasks and notes
  is_archived            BOOLEAN NOT NULL DEFAULT FALSE,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- a company objective has no department; a department objective must have one
  CONSTRAINT objectives_scope_department_ck CHECK (
    (scope_type = 'COMPANY' AND department_id IS NULL)
    OR (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL)
  ),
  CONSTRAINT objectives_period_ck CHECK (end_date >= start_date)
);

CREATE INDEX objectives_department_idx ON objectives (department_id);
CREATE INDEX objectives_owner_idx      ON objectives (owner_user_id);
CREATE INDEX objectives_dates_idx      ON objectives (start_date, end_date);
CREATE INDEX objectives_status_idx     ON objectives (status) WHERE is_archived = FALSE;
CREATE INDEX objectives_parent_idx     ON objectives (parent_objective_id);

-- ---------------------------------------------------------------- key results

CREATE TABLE key_results (
  id                     SERIAL PRIMARY KEY,
  objective_id           INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  description            TEXT,
  owner_user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  start_date             DATE,
  end_date               DATE,
  measurement_type       TEXT NOT NULL DEFAULT 'NUMBER'
                         CHECK (measurement_type IN
                           ('NUMBER', 'PERCENTAGE', 'CURRENCY', 'BINARY', 'MILESTONE', 'TASK_ROLLUP')),
  direction              TEXT NOT NULL DEFAULT 'INCREASE'
                         CHECK (direction IN ('INCREASE', 'DECREASE')),
  baseline_value         NUMERIC(16, 4) NOT NULL DEFAULT 0,
  target_value           NUMERIC(16, 4),
  current_value          NUMERIC(16, 4) NOT NULL DEFAULT 0,
  unit                   TEXT,
  weight                 NUMERIC(8, 2) NOT NULL DEFAULT 1 CHECK (weight >= 0),
  status                 TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
  manual_health          TEXT
                         CHECK (manual_health IN ('NOT_STARTED', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETED')),
  health_override_reason TEXT,
  health_override_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  health_override_at     TIMESTAMPTZ,
  last_check_in_at       TIMESTAMPTZ,
  is_archived            BOOLEAN NOT NULL DEFAULT FALSE,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX key_results_objective_idx ON key_results (objective_id);
CREATE INDEX key_results_owner_idx     ON key_results (owner_user_id);

-- ---------------------------------------------------------------- check-ins

-- Append only. A check-in never overwrites the previous one, so the progression
-- of a key result over time stays readable.
CREATE TABLE key_result_check_ins (
  id                 SERIAL PRIMARY KEY,
  key_result_id      INTEGER NOT NULL REFERENCES key_results(id) ON DELETE CASCADE,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  previous_value     NUMERIC(16, 4),
  current_value      NUMERIC(16, 4),
  resulting_progress NUMERIC(7, 2),
  confidence         TEXT CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  health_status      TEXT,
  note               TEXT,
  next_action        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX check_ins_kr_idx ON key_result_check_ins (key_result_id, created_at DESC);

-- ---------------------------------------------------------------- task links

-- The whole task <-> OKR relationship. No objective id is stored here: the
-- objective is always reached through the key result, so there is one source of
-- truth for that relationship.
CREATE TABLE task_key_result_links (
  id                  SERIAL PRIMARY KEY,
  task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  key_result_id       INTEGER NOT NULL REFERENCES key_results(id) ON DELETE CASCADE,
  is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
  contribution_weight NUMERIC(8, 2),
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, key_result_id)
);

CREATE INDEX tkr_task_idx ON task_key_result_links (task_id);
CREATE INDEX tkr_kr_idx   ON task_key_result_links (key_result_id);
-- a task may support several key results but only one of them is the primary
CREATE UNIQUE INDEX tkr_one_primary_idx ON task_key_result_links (task_id) WHERE is_primary;

-- ---------------------------------------------------------------- audit

-- Mirrors task_activity. A separate table is used because task_activity.task_id
-- is NOT NULL with a foreign key to tasks, so it cannot carry objective or key
-- result events without altering an existing table.
CREATE TABLE okr_activity (
  id          SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('OBJECTIVE', 'KEY_RESULT', 'LINK')),
  entity_id   INTEGER NOT NULL,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  field       TEXT,
  from_value  TEXT,
  to_value    TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX okr_activity_entity_idx ON okr_activity (entity_type, entity_id, created_at DESC);
