-- Weekly visibility: what changed since last week, deals that have stalled
-- (and those paused on purpose), what is blocking them, the correspondence that
-- already happened, and each owner's outcome-focused weekly review.
--
-- Additive only: new nullable columns and new tables. Nothing existing is
-- rewritten. Deals already paused keep exactly the dates they have.

-- ---------------------------------------------------------------- waiting, on purpose

-- A live deal can be waiting — on the customer, a third party, or us — with a
-- reason and the date to check back. Until that date it is not chased; on that
-- date it asks to be revisited. Every existing deal starts not waiting.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS waiting_on TEXT
  CHECK (waiting_on IN ('CUSTOMER', 'THIRD_PARTY', 'INTERNAL'));
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS waiting_reason TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS waiting_until DATE;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS waiting_since TIMESTAMPTZ;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS waiting_set_by INTEGER
  REFERENCES users(id) ON DELETE SET NULL;

-- How long a deal in this stage may go without hearing from the customer
-- before it counts as stalled. Blank uses the cadence in Settings.
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS quiet_after_days INTEGER
  CHECK (quiet_after_days IS NULL OR quiet_after_days > 0);

-- ---------------------------------------------------------------- what the customer said they would do

CREATE TABLE IF NOT EXISTS customer_commitments (
  id              SERIAL PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  opportunity_id  INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  activity_id     INTEGER REFERENCES account_activities(id) ON DELETE SET NULL,
  contact_id      INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  what            TEXT NOT NULL,
  due_on          DATE,
  status          TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN', 'KEPT', 'MISSED', 'WITHDRAWN')),
  resolved_at     TIMESTAMPTZ,
  resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_commitments_open_idx
  ON customer_commitments (opportunity_id, due_on) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS customer_commitments_account_idx
  ON customer_commitments (account_id, created_at DESC);

-- ---------------------------------------------------------------- the week, kept

-- One frozen record per week: what changed, what was promised, what was sold,
-- billed and collected, what slipped and what needs a decision. Written once,
-- after the week ends, and never rewritten — it is what was known at the time.
CREATE TABLE IF NOT EXISTS pipeline_snapshots (
  id            SERIAL PRIMARY KEY,
  week_start    DATE NOT NULL UNIQUE,
  week_end      DATE NOT NULL,
  data          JSONB NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- blank when the weekly job wrote it
  generated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------- blockers, structured

-- What is blocked, whether we or somebody outside holds the key, who is
-- responsible for clearing it, and by when. Blank on blockers raised before.
ALTER TABLE discussion_threads ADD COLUMN IF NOT EXISTS blocked_item TEXT;
ALTER TABLE discussion_threads ADD COLUMN IF NOT EXISTS dependency TEXT
  CHECK (dependency IN ('INTERNAL', 'EXTERNAL'));
ALTER TABLE discussion_threads ADD COLUMN IF NOT EXISTS responsible_user_id INTEGER
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE discussion_threads ADD COLUMN IF NOT EXISTS external_party TEXT;
ALTER TABLE discussion_threads ADD COLUMN IF NOT EXISTS expected_resolution DATE;

-- ---------------------------------------------------------------- correspondence

-- The email or calendar event an entry was made from, so importing it twice
-- cannot log it twice.
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS external_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS account_activities_external_ref_idx
  ON account_activities (account_id, external_ref) WHERE external_ref IS NOT NULL;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS external_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS crm_meetings_external_ref_idx
  ON crm_meetings (account_id, external_ref) WHERE external_ref IS NOT NULL;

-- A suggested update from correspondence that already happened, waiting for a
-- person to confirm or dismiss it. Nothing reaches a deal's timeline until
-- somebody confirms it.
CREATE TABLE IF NOT EXISTS crm_suggestions (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source         TEXT NOT NULL
                 CHECK (source IN ('EMAIL_IMPORT', 'CALENDAR_IMPORT', 'GMAIL', 'GOOGLE_CALENDAR')),
  external_ref   TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('EMAIL', 'MEETING')),
  account_id     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  contact_id     INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  direction      TEXT CHECK (direction IN ('OUTBOUND', 'INBOUND')),
  occurred_at    TIMESTAMPTZ,
  ends_at        TIMESTAMPTZ,
  subject        TEXT,
  snippet        TEXT,
  participants   TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'CONFIRMED', 'DISMISSED')),
  activity_id    INTEGER REFERENCES account_activities(id) ON DELETE SET NULL,
  meeting_id     INTEGER REFERENCES crm_meetings(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ,
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, external_ref)
);
CREATE INDEX IF NOT EXISTS crm_suggestions_pending_idx
  ON crm_suggestions (user_id, created_at DESC) WHERE status = 'PENDING';

-- Reading a person's own Gmail and Calendar for correspondence with known
-- contacts happens only if that person switches it on.
CREATE TABLE IF NOT EXISTS crm_mailbox_sync (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gmail_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  calendar_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at   TIMESTAMPTZ,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- the weekly review

CREATE TABLE IF NOT EXISTS weekly_reviews (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start   DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED')),
  summary      TEXT,
  submitted_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);

CREATE TABLE IF NOT EXISTS weekly_review_items (
  id                 SERIAL PRIMARY KEY,
  review_id          INTEGER NOT NULL REFERENCES weekly_reviews(id) ON DELETE CASCADE,
  opportunity_id     INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  what_changed       TEXT,
  no_change          BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_url       TEXT,
  next_milestone     TEXT,
  next_milestone_due DATE,
  help_needed        TEXT,
  help_from_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_id, opportunity_id)
);
