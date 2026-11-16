-- Quick to-dos, Today's plan, personal lists and routines, and steps (Parts A, B, D).
--
-- Additive only: new tables, new nullable columns, widened checks that keep
-- every old value. No existing row is changed: old checklist items get no
-- invented owner, day or "done at" date, and no task is touched.
--
-- Privacy: every to-do, list, routine, pin and move belongs to one person
-- (owner_user_id / user_id). Only a to-do its owner shared onto a record is
-- shown to others, and only to people who can already see that record.

-- A named personal checklist ("Trade fair prep"). It can be linked as a whole;
-- its items inherit the link.
CREATE TABLE IF NOT EXISTS todo_lists (
  id              SERIAL PRIMARY KEY,
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  link_type       TEXT CHECK (link_type IN ('TASK', 'PROJECT', 'KEY_RESULT', 'OBJECTIVE', 'DEAL', 'APPLICATION', 'MEETING')),
  link_id         INTEGER,
  copied_from_id  INTEGER REFERENCES todo_lists(id) ON DELETE SET NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ,
  CHECK ((link_type IS NULL) = (link_id IS NULL))
);
CREATE INDEX IF NOT EXISTS todo_lists_owner_idx ON todo_lists (owner_user_id) WHERE archived_at IS NULL;

-- A repeating to-do (Part D). One item is made at the start of the person's
-- working day; last_made_on stops a rerun from making a second one.
CREATE TABLE IF NOT EXISTS todo_routines (
  id              SERIAL PRIMARY KEY,
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  note            TEXT,
  repeat_kind     TEXT NOT NULL CHECK (repeat_kind IN ('WORKING_DAYS', 'WEEKLY', 'MONTHLY')),
  weekdays        SMALLINT[] NOT NULL DEFAULT '{}',
  month_day       SMALLINT CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 31),
  planned_time    TEXT CHECK (planned_time IS NULL OR planned_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  link_type       TEXT CHECK (link_type IN ('TASK', 'PROJECT', 'KEY_RESULT', 'OBJECTIVE', 'DEAL', 'APPLICATION', 'MEETING')),
  link_id         INTEGER,
  starts_on       DATE NOT NULL DEFAULT CURRENT_DATE,
  last_made_on    DATE,
  stopped_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((link_type IS NULL) = (link_id IS NULL)),
  CHECK (repeat_kind <> 'WEEKLY' OR cardinality(weekdays) > 0),
  CHECK (repeat_kind <> 'MONTHLY' OR month_day IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS todo_routines_owner_idx ON todo_routines (owner_user_id) WHERE stopped_at IS NULL;

-- One line for yourself. No deadline machinery: a to-do is never overdue and
-- never feeds black marks, reviews, reports or key result values.
CREATE TABLE IF NOT EXISTS todos (
  id                          SERIAL PRIMARY KEY,
  owner_user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  note                        TEXT CHECK (note IS NULL OR char_length(note) <= 2000),
  planned_on                  DATE,
  planned_time                TEXT CHECK (planned_time IS NULL OR planned_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  position                    INTEGER NOT NULL DEFAULT 0,
  done_at                     TIMESTAMPTZ,
  list_id                     INTEGER REFERENCES todo_lists(id) ON DELETE SET NULL,
  routine_id                  INTEGER REFERENCES todo_routines(id) ON DELETE SET NULL,
  routine_day                 DATE,
  -- at most one record: the rest of the chain (project, department, goals) is
  -- worked out when read, never stored here
  link_type                   TEXT CHECK (link_type IN ('TASK', 'PROJECT', 'KEY_RESULT', 'OBJECTIVE', 'DEAL', 'APPLICATION', 'MEETING')),
  link_id                     INTEGER,
  shared                      BOOLEAN NOT NULL DEFAULT FALSE,
  shared_at                   TIMESTAMPTZ,
  became_task_id              INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  moved_to_checklist_item_id  INTEGER REFERENCES task_checklist_items(id) ON DELETE SET NULL,
  -- the same client key twice (a double tap, a retry, a Chat message delivered
  -- twice) makes one to-do
  client_key                  TEXT CHECK (client_key IS NULL OR char_length(client_key) <= 200),
  source                      TEXT NOT NULL DEFAULT 'APP' CHECK (source IN ('APP', 'PASTE', 'CHAT', 'ROUTINE', 'LIST', 'NOTE', 'SUGGESTION')),
  -- "Still want this?" is asked once, after 7 days of carrying
  carry_asked_at              TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at                 TIMESTAMPTZ,
  CHECK ((link_type IS NULL) = (link_id IS NULL)),
  CHECK (NOT shared OR link_type IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS todos_client_key_idx ON todos (owner_user_id, client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS todos_routine_day_idx ON todos (routine_id, routine_day) WHERE routine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS todos_owner_idx ON todos (owner_user_id, done_at, planned_on) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS todos_link_idx ON todos (link_type, link_id) WHERE link_type IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS todos_list_idx ON todos (list_id) WHERE list_id IS NOT NULL;

-- A task pinned to a day of Today's plan. Not a copy: it shows the task's
-- live status, and unpinning changes nothing on the task.
CREATE TABLE IF NOT EXISTS todo_pins (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, day, task_id)
);
CREATE INDEX IF NOT EXISTS todo_pins_task_idx ON todo_pins (task_id);

-- Every change of a to-do's day, so a past page can show "-> Mon 16 Nov".
-- (Planned for 040 in the plan; moving days starts in Part A, so it starts here.)
CREATE TABLE IF NOT EXISTS todo_moves (
  id        SERIAL PRIMARY KEY,
  todo_id   INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  from_day  DATE,
  to_day    DATE,
  moved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS todo_moves_todo_idx ON todo_moves (todo_id, moved_at);

-- Steps: a task's checklist items can have an owner, a day and a time, and
-- record who ticked them and when. Old items keep NULL here: they show as
-- "done (date not recorded)", never with an invented date.
ALTER TABLE task_checklist_items ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE task_checklist_items ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE task_checklist_items ADD COLUMN IF NOT EXISTS planned_on DATE;
ALTER TABLE task_checklist_items ADD COLUMN IF NOT EXISTS planned_time TEXT;
ALTER TABLE task_checklist_items ADD COLUMN IF NOT EXISTS done_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE task_checklist_items ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;
-- the owner's own order for the step in their Today's plan
ALTER TABLE task_checklist_items ADD COLUMN IF NOT EXISTS owner_position INTEGER;
DO $$ BEGIN
  ALTER TABLE task_checklist_items ADD CONSTRAINT task_checklist_items_planned_time_check
    CHECK (planned_time IS NULL OR planned_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS task_checklist_owner_idx ON task_checklist_items (owner_user_id, planned_on)
  WHERE is_done = FALSE AND owner_user_id IS NOT NULL;

-- What happened to shared steps on a deal, an application or a meeting. Kept
-- apart from account_activities on purpose: sales reports count those rows,
-- and a to-do must never feed a report.
CREATE TABLE IF NOT EXISTS record_step_activity (
  id           SERIAL PRIMARY KEY,
  record_type  TEXT NOT NULL CHECK (record_type IN ('DEAL', 'APPLICATION', 'MEETING')),
  record_id    INTEGER NOT NULL,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL CHECK (action IN ('step_added', 'step_removed', 'step_done', 'step_reopened')),
  title        TEXT NOT NULL,
  todo_id      INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS record_step_activity_idx ON record_step_activity (record_type, record_id, created_at DESC);

-- "Hide done" on Today's plan: a personal switch, like theme_mode.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notebook_hide_done BOOLEAN NOT NULL DEFAULT FALSE;

-- "Remind me" can be set on a to-do (Part C9): the record types widen, keeping every old one.
ALTER TABLE personal_reminders DROP CONSTRAINT IF EXISTS personal_reminders_entity_type_check;
ALTER TABLE personal_reminders ADD CONSTRAINT personal_reminders_entity_type_check
  CHECK (entity_type IN ('TASK', 'LEAD', 'DEAL', 'APPLICATION', 'MEETING', 'ACCOUNT', 'KEY_RESULT', 'OBJECTIVE', 'PROJECT', 'TODO'));
