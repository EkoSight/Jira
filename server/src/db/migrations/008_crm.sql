-- CRM: leads, pipeline and the activities that move a deal along.
--
-- Additive. New tables, plus three nullable link columns on existing tables so a
-- task, a goal or a notification can point at an account. Nothing is renamed,
-- dropped or rewritten, and every existing row keeps behaving exactly as before —
-- a task with a NULL account_id is an ordinary task.

-- ---------------------------------------------------------------- pipeline stages

CREATE TABLE account_stages (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  -- open stages are in flight; won/lost are terminal, the way done/cancelled are
  kind        TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost')),
  color       TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO account_stages (name, slug, kind, color, position, is_default) VALUES
  ('New',          'new',          'open', '#64748b', 1, TRUE),
  ('Contacted',    'contacted',    'open', '#3b82f6', 2, FALSE),
  ('Qualified',    'qualified',    'open', '#2a78d6', 3, FALSE),
  ('Proposal',     'proposal',     'open', '#8b5cf6', 4, FALSE),
  ('Negotiation',  'negotiation',  'open', '#f59e0b', 5, FALSE),
  ('Won',          'won',          'won',  '#0ca30c', 6, FALSE),
  ('Lost',         'lost',         'lost', '#d03b3b', 7, FALSE)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------- accounts

CREATE TABLE accounts (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  -- a lead becomes a customer, then a partner — one row, its type advances
  type              TEXT NOT NULL DEFAULT 'LEAD' CHECK (type IN ('LEAD', 'CUSTOMER', 'PARTNER')),
  stage_id          INTEGER REFERENCES account_stages(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WON', 'LOST', 'ON_HOLD')),
  -- who is leading it, and who is following it
  owner_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  follower_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department_id     INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  value             NUMERIC(16, 2),
  currency          TEXT NOT NULL DEFAULT 'INR',
  source            TEXT,
  website           TEXT,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  description       TEXT,
  -- the one thing that keeps a deal moving: what happens next, and by when
  next_step         TEXT,
  next_step_due     DATE,
  last_activity_at  TIMESTAMPTZ,
  -- when the stage last advanced, so "hasn't moved in a week" is measurable
  stage_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_at      TIMESTAMPTZ,
  is_archived       BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX accounts_owner_idx      ON accounts (owner_user_id);
CREATE INDEX accounts_follower_idx   ON accounts (follower_user_id);
CREATE INDEX accounts_department_idx ON accounts (department_id);
CREATE INDEX accounts_type_idx       ON accounts (type);
CREATE INDEX accounts_stage_idx      ON accounts (stage_id) WHERE is_archived = FALSE;

-- ---------------------------------------------------------------- activity timeline

-- Every touch on a deal: an email, a call, a deck, a proposal, a meeting, a demo,
-- a summary. Append only, so the history of how a lead was worked stays readable.
CREATE TABLE account_activities (
  id           SERIAL PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type         TEXT NOT NULL
               CHECK (type IN ('NOTE', 'EMAIL', 'CALL', 'PPT', 'PROPOSAL', 'MEETING',
                               'DEMO', 'IN_PERSON', 'SUMMARY', 'STAGE_CHANGE', 'CONVERTED')),
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject      TEXT,
  body         TEXT,
  next_step    TEXT,
  -- the follow-up task this activity spun off, if any
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX account_activities_account_idx ON account_activities (account_id, occurred_at DESC);
CREATE INDEX account_activities_task_idx    ON account_activities (task_id);

-- ---------------------------------------------------------------- links on existing tables

-- A task may belong to one account (the deal it is helping to close, or the
-- partner it is serving). NULL is the normal case and changes nothing.
ALTER TABLE tasks       ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_account_idx ON tasks (account_id);

-- A success goal can be scoped to a partner account (Phase 2 uses this; the
-- column is added now so it is already there, harmless while unused).
ALTER TABLE objectives  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS objectives_account_idx ON objectives (account_id);

-- A reminder can point at an account, the way it can already point at a task or goal.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS notifications_account_idx ON notifications (account_id);
