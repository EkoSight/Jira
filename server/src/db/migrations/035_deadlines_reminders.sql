-- No missed tasks: deadline changes with reasons and approval, deferral,
-- accepted blocks, who owned a task when, saved views, one planned reminder
-- engine for every task, a per-recipient summary log, the daily coverage
-- check, black-mark rules that apply from a date, appeals, and reviewed
-- application of a rule to past tasks.
--
-- Additive only: new tables, new nullable columns, one widened CHECK that keeps
-- every value it allowed, and a trigger that only writes to its own new table.
-- No existing row is changed: deadlines, statuses, marks and history stay as
-- they are, and no mark is created or waived here.

-- ---------------------------------------------------------------- tasks

-- the date Backlog or deferred work is looked at again, and the next step
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_date DATE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_action TEXT;
-- the approved deferral in force, if any (its deadline is paused while set)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deferral_id INTEGER;

-- ---------------------------------------------------------------- deadline changes

-- Every request to move a deadline or to defer a task, and its decision.
-- D1: the owner may move their own deadline once, before it passes, with a
-- reason (recorded here as approved automatically); anything else waits for
-- the reporter or the owner's manager.
CREATE TABLE IF NOT EXISTS task_deadline_changes (
  id                  SERIAL PRIMARY KEY,
  task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('EXTEND', 'DEFER')),
  requested_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason              TEXT NOT NULL,
  -- the deadline when asked, and (EXTEND) the one asked for
  from_due            TIMESTAMPTZ,
  to_due              TIMESTAMPTZ,
  -- whether it was asked before the deadline had passed
  before_deadline     BOOLEAN NOT NULL DEFAULT TRUE,
  -- DEFER: the status it was in, when to look again, the next step, what it waits on
  from_status_id      INTEGER REFERENCES workflow_statuses(id) ON DELETE SET NULL,
  review_date         DATE,
  next_action         TEXT,
  dependency_task_id  INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  dependency_text     TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN', 'ENDED')),
  auto_approved       BOOLEAN NOT NULL DEFAULT FALSE,
  decided_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT,
  -- DEFER: when the deferral was brought to an end (resumed, done, cancelled)
  ended_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ended_at            TIMESTAMPTZ,
  end_note            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_deadline_changes_task_idx ON task_deadline_changes (task_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS task_deadline_changes_pending_idx ON task_deadline_changes (task_id) WHERE status = 'PENDING';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_deferral_fk' AND conrelid = 'tasks'::regclass) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_deferral_fk FOREIGN KEY (deferral_id) REFERENCES task_deadline_changes(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------- blocks

-- What a task is waiting on. D3: a block an approver has accepted pauses
-- black marks for the deadlines it covers, until it is cleared.
CREATE TABLE IF NOT EXISTS task_blocks (
  id                  SERIAL PRIMARY KEY,
  task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reason              TEXT NOT NULL,
  dependency_task_id  INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  dependency_text     TEXT,
  recorded_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CLEARED')),
  decided_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT,
  cleared_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cleared_at          TIMESTAMPTZ,
  clear_note          TEXT
);
CREATE INDEX IF NOT EXISTS task_blocks_task_idx ON task_blocks (task_id, recorded_at DESC);

-- ---------------------------------------------------------------- who owned it when

-- Every change of owner, from every code path: the black mark belongs to
-- whoever owned the task at its effective deadline, not to whoever owns it
-- when the scan happens to run. User ids carry no foreign key so that history
-- copied from the activity log never fails on an account that is gone.
CREATE TABLE IF NOT EXISTS task_owner_changes (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_user_id  INTEGER,
  to_user_id    INTEGER,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT NOT NULL DEFAULT 'TRIGGER' CHECK (source IN ('TRIGGER', 'ACTIVITY'))
);
CREATE INDEX IF NOT EXISTS task_owner_changes_task_idx ON task_owner_changes (task_id, changed_at);

CREATE OR REPLACE FUNCTION taskflow_record_owner_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
    INSERT INTO task_owner_changes (task_id, from_user_id, to_user_id, changed_at, source)
    VALUES (NEW.id, OLD.assignee_id, NEW.assignee_id, now(), 'TRIGGER');
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tasks_owner_change_trg' AND tgrelid = 'tasks'::regclass) THEN
    CREATE TRIGGER tasks_owner_change_trg AFTER UPDATE OF assignee_id ON tasks
      FOR EACH ROW EXECUTE FUNCTION taskflow_record_owner_change();
  END IF;
END $$;

-- the changes made before this release, from the task activity history
INSERT INTO task_owner_changes (task_id, from_user_id, to_user_id, changed_at, source)
SELECT a.task_id,
       CASE WHEN a.from_value ~ '^[0-9]+$' THEN a.from_value::int END,
       CASE WHEN a.to_value ~ '^[0-9]+$' THEN a.to_value::int END,
       a.created_at, 'ACTIVITY'
  FROM task_activity a
 WHERE a.action = 'updated' AND a.field = 'assignee_id'
   AND NOT EXISTS (SELECT 1 FROM task_owner_changes c WHERE c.source = 'ACTIVITY' AND c.task_id = a.task_id AND c.changed_at = a.created_at);

-- ---------------------------------------------------------------- saved views

CREATE TABLE IF NOT EXISTS task_saved_views (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- the board's URL query, e.g. "due=overdue&department_id=3"
  query          TEXT NOT NULL,
  -- shared with everyone in this department; NULL is personal
  department_id  INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_saved_views_user_idx ON task_saved_views (user_id);

-- ---------------------------------------------------------------- reminders

-- Every reminder planned for a task: one row per task, person, moment and
-- channel. Re-planned when the task changes, so a reminder for an old time or
-- an old owner is cancelled, never sent. Claimed before sending.
CREATE TABLE IF NOT EXISTS task_reminders (
  id                SERIAL PRIMARY KEY,
  task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('BEFORE_DUE', 'AT_DUE', 'AFTER_GRACE', 'COVER', 'UNREACHED')),
  -- OWNER: the person responsible; FALLBACK: told because the owner could not be
  role              TEXT NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER', 'FALLBACK')),
  -- for a fallback: whose task it is
  about_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_at            TIMESTAMPTZ NOT NULL,
  remind_at         TIMESTAMPTZ NOT NULL,
  channel           TEXT NOT NULL CHECK (channel IN ('APP', 'CHAT')),
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED', 'WOULD_SEND')),
  reason            TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  sent_at           TIMESTAMPTZ,
  notification_id   INTEGER,
  outbox_key        TEXT,
  acknowledged_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, user_id, kind, due_at, channel)
);
CREATE INDEX IF NOT EXISTS task_reminders_due_idx ON task_reminders (remind_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS task_reminders_task_idx ON task_reminders (task_id);
CREATE INDEX IF NOT EXISTS task_reminders_user_idx ON task_reminders (user_id, created_at DESC);

-- One row per summary per recipient per day, whatever happened to it. Whether
-- a queued message reached Chat is read from the outbox by its key.
CREATE TABLE IF NOT EXISTS reminder_summary_log (
  id                 SERIAL PRIMARY KEY,
  log_key            TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL CHECK (kind IN ('PERSONAL', 'DEPARTMENT', 'BACKLOG_WEEKLY')),
  user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
  department_id      INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  space_name         TEXT,
  summary_date       DATE NOT NULL,
  -- QUEUED for Chat; APP_ONLY when Chat could not be used and the bell carried
  -- it; SKIPPED with the reason; WOULD_SEND in test mode
  status             TEXT NOT NULL CHECK (status IN ('QUEUED', 'APP_ONLY', 'SKIPPED', 'WOULD_SEND')),
  reason             TEXT,
  items              INTEGER NOT NULL DEFAULT 0,
  -- the open tasks it told the reader about, and whose (for covering)
  task_ids           INTEGER[] NOT NULL DEFAULT '{}',
  covering_user_ids  INTEGER[] NOT NULL DEFAULT '{}',
  outbox_key         TEXT,
  late               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminder_summary_log_date_idx ON reminder_summary_log (summary_date, kind);
CREATE INDEX IF NOT EXISTS reminder_summary_log_user_idx ON reminder_summary_log (user_id, summary_date DESC);

-- The daily answer to "which open tasks will nobody hear about today?"
CREATE TABLE IF NOT EXISTS coverage_reports (
  id            SERIAL PRIMARY KEY,
  report_date   DATE NOT NULL UNIQUE,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  open_tasks    INTEGER NOT NULL DEFAULT 0,
  unseen        INTEGER NOT NULL DEFAULT 0,
  exceptions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- the new Chat message kinds, keeping every kind already allowed
ALTER TABLE chat_outbox DROP CONSTRAINT IF EXISTS chat_outbox_kind_check;
ALTER TABLE chat_outbox ADD CONSTRAINT chat_outbox_kind_check
  CHECK (kind IN ('ALERT', 'DIGEST', 'TEAM_SUMMARY', 'TEST', 'WELCOME',
                  'STANDUP_REMINDER', 'STANDUP_POST', 'STANDUP_FEEDBACK', 'STANDUP_NUDGE', 'STANDUP_ESCALATION',
                  'CRM_REMINDER', 'CRM_DIGEST', 'TASK_REMINDER', 'BACKLOG_WEEKLY'));

-- a queued message whose task has moved on (finished, handed over, re-dated)
-- is cancelled rather than sent; every status allowed before still is
ALTER TABLE chat_outbox DROP CONSTRAINT IF EXISTS chat_outbox_status_check;
ALTER TABLE chat_outbox ADD CONSTRAINT chat_outbox_status_check
  CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED'));

-- ---------------------------------------------------------------- black marks

-- A rule applies to deadlines (and completions) from this moment on. NULL is
-- how every rule worked before: from the beginning. New rules, and rules whose
-- terms change, start from the moment they are saved; applying one to earlier
-- work needs a preview and an approval (blackmark_backfills).
ALTER TABLE blackmark_rules ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS black_mark_appeals (
  id               SERIAL PRIMARY KEY,
  mark_id          INTEGER NOT NULL REFERENCES black_marks(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL,
  evidence_url     TEXT,
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UPHELD', 'WAIVED', 'WITHDRAWN')),
  decided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ,
  decision_reason  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS black_mark_appeals_mark_idx ON black_mark_appeals (mark_id);
CREATE UNIQUE INDEX IF NOT EXISTS black_mark_appeals_one_open ON black_mark_appeals (mark_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS blackmark_backfills (
  id              SERIAL PRIMARY KEY,
  rule_id         INTEGER REFERENCES blackmark_rules(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'PREVIEWED' CHECK (status IN ('PREVIEWED', 'APPLIED', 'DISCARDED')),
  previewed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  previewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- what the preview showed, so an approval applies exactly that
  fingerprint     TEXT NOT NULL,
  occurrences     INTEGER NOT NULL DEFAULT 0,
  people          INTEGER NOT NULL DEFAULT 0,
  points          NUMERIC(8, 2) NOT NULL DEFAULT 0,
  preview         JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  approval_note   TEXT,
  created_marks   INTEGER
);
