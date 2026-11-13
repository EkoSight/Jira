-- Sales CRM: calls that are recorded once, a lead's full location, follow-up
-- reminders a person chooses, and a daily follow-up summary in Google Chat.
--
-- Additive only. No existing row is changed: city and state keep their
-- values and meaning (city is the city, town or village); every existing call
-- keeps its id and history; follow-ups made before this keep their single
-- reminder until they are moved. Rolling back is deploying the previous
-- version: these columns and tables are then simply not used.

-- ================================================================ calls

-- the form submission that made the call; a repeat of the same submission
-- (a double tap, a retry after a dropped response) finds it instead of
-- making another
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS crm_calls_request_idx ON crm_calls (created_by, request_id) WHERE request_id IS NOT NULL;
-- which way it was recorded: the outcome form, the Log call form, a completed
-- follow-up, a telephony provider (older rows: unknown)
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS recorded_via TEXT;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS edit_count INTEGER NOT NULL DEFAULT 0;
-- a call a manager marked as an accidental repeat after reviewing it: kept
-- and shown, not counted; undoable
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS void_reason TEXT;
-- a Call follow-up closed by logging the call it asked for
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_call_id INTEGER REFERENCES crm_calls(id) ON DELETE SET NULL;

-- every change to a call after it was recorded, with what it said before
CREATE TABLE IF NOT EXISTS crm_call_edits (
  id          SERIAL PRIMARY KEY,
  call_id     INTEGER NOT NULL REFERENCES crm_calls(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  before      TEXT,
  after       TEXT,
  reason      TEXT,
  edited_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  edited_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_call_edits_call_idx ON crm_call_edits (call_id, edited_at);

-- one row per form submission: the same submission twice returns the first answer
CREATE TABLE IF NOT EXISTS crm_submissions (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  lead_id     INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  call_id     INTEGER REFERENCES crm_calls(id) ON DELETE SET NULL,
  response    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

-- ================================================================ location

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS district TEXT;
-- block or tehsil
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS block TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS pincode TEXT;
CREATE INDEX IF NOT EXISTS crm_leads_state_district_idx ON crm_leads (lower(state), lower(district)) WHERE is_archived = FALSE;
CREATE INDEX IF NOT EXISTS crm_leads_pincode_idx ON crm_leads (pincode) WHERE pincode IS NOT NULL;

-- a value a lead's location might take, waiting for a person: from an
-- import's District column (stored as the city before), or a state or PIN
-- written in a note. Never applied by itself.
CREATE TABLE IF NOT EXISTS crm_location_suggestions (
  id            SERIAL PRIMARY KEY,
  lead_id       INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  field         TEXT NOT NULL CHECK (field IN ('state', 'district', 'city', 'block', 'pincode')),
  value         TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('IMPORT_DISTRICT_COLUMN', 'NOTE_STATE', 'NOTE_PINCODE')),
  evidence      TEXT,
  status        TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED')),
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, field, value)
);
CREATE INDEX IF NOT EXISTS crm_location_suggestions_open_idx ON crm_location_suggestions (lead_id) WHERE status = 'PROPOSED';

-- ================================================================ reminders

-- a follow-up's own choice; empty means the person's defaults
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_offsets INTEGER[];
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_channels TEXT[];

-- each person's default reminders
CREATE TABLE IF NOT EXISTS crm_reminder_prefs (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  offsets     INTEGER[] NOT NULL DEFAULT '{15}',
  channels    TEXT[] NOT NULL DEFAULT '{APP}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- every reminder planned for a follow-up. Planned for one follow-up time and
-- one person: moving, handing over, finishing or cancelling the follow-up
-- cancels what is pending and plans afresh, so an old reminder is never sent.
CREATE TABLE IF NOT EXISTS crm_followup_reminders (
  id               SERIAL PRIMARY KEY,
  task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at           TIMESTAMPTZ NOT NULL,
  offset_minutes   INTEGER NOT NULL CHECK (offset_minutes IN (5, 10, 15, 30)),
  channel          TEXT NOT NULL CHECK (channel IN ('APP', 'CHAT')),
  remind_at        TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  notification_id  INTEGER,
  outbox_key       TEXT,
  cancel_reason    TEXT,
  acknowledged_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, user_id, due_at, offset_minutes, channel)
);
CREATE INDEX IF NOT EXISTS crm_followup_reminders_due_idx ON crm_followup_reminders (remind_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS crm_followup_reminders_task_idx ON crm_followup_reminders (task_id);

-- ================================================================ the daily follow-up summary

-- an administrator's exception for one person: never send, or send even
-- though the organization default is off
CREATE TABLE IF NOT EXISTS crm_digest_exceptions (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('SKIP', 'INCLUDE')),
  until       DATE,
  reason      TEXT,
  set_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one summary a person a day, whatever happened to it
CREATE TABLE IF NOT EXISTS crm_digest_log (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_date  DATE NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'SKIPPED')),
  reason       TEXT,
  items        INTEGER NOT NULL DEFAULT 0,
  outbox_key   TEXT,
  test         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, digest_date, test)
);

-- the new Chat message kinds, keeping every kind already allowed
ALTER TABLE chat_outbox DROP CONSTRAINT IF EXISTS chat_outbox_kind_check;
ALTER TABLE chat_outbox ADD CONSTRAINT chat_outbox_kind_check
  CHECK (kind IN ('ALERT', 'DIGEST', 'TEAM_SUMMARY', 'TEST', 'WELCOME',
                  'STANDUP_REMINDER', 'STANDUP_POST', 'STANDUP_FEEDBACK', 'STANDUP_NUDGE', 'STANDUP_ESCALATION',
                  'CRM_REMINDER', 'CRM_DIGEST'));
