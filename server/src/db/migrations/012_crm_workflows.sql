-- Meetings, delivery and nudges: the bookkeeping that makes them idempotent.
--
-- Migration 011 created the tables. This adds the flags that stop a repeated
-- save, a retry or a reschedule from creating the same task twice, and the
-- snooze state the nudge engine needs.
--
-- Additive: new nullable-or-defaulted columns and one new table.

-- ------------------------------------------------- meetings

-- Preparation and follow-up work is created through the ordinary task engine,
-- once. Without these, saving a meeting twice — or a retry after a timeout —
-- mints a second set of "Prepare for…" cards nobody asked for.
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS prep_tasks_created BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS followup_tasks_created BOOLEAN NOT NULL DEFAULT FALSE;

-- Rescheduling moves the existing event rather than making a new one, so the
-- history of how often it moved has to live on the event itself.
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS first_scheduled_at TIMESTAMPTZ;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- a meeting's own tasks are told apart from ordinary linked work
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS meeting_role TEXT
  CHECK (meeting_role IN ('PREP', 'FOLLOW_UP'));

UPDATE crm_meetings SET first_scheduled_at = scheduled_at WHERE first_scheduled_at IS NULL;

-- ------------------------------------------------- delivery

ALTER TABLE engagements ADD COLUMN IF NOT EXISTS kickoff_tasks_created BOOLEAN NOT NULL DEFAULT FALSE;
-- what was carried over from the deal, so a reader can see it was not retyped
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS carried_from_opportunity JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ------------------------------------------------- nudges

-- A nudge that cannot be put down becomes noise, and noise gets ignored. A
-- snooze is a decision with a reason and an expiry, not a dismissal.
CREATE TABLE crm_nudge_snoozes (
  id           SERIAL PRIMARY KEY,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('ACCOUNT', 'OPPORTUNITY', 'ENGAGEMENT', 'MEETING')),
  entity_id    INTEGER NOT NULL,
  -- NULL means every signal on this thing; a kind means just that one
  kind         TEXT,
  reason       TEXT NOT NULL,
  until        TIMESTAMPTZ NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_nudge_snoozes_entity_idx
  ON crm_nudge_snoozes (entity_type, entity_id, until);

-- One row per reminder actually sent, so a retry, a second scan inside the
-- cooldown, or two scanners running at once cannot send the same nudge twice.
CREATE TABLE crm_nudge_events (
  id            SERIAL PRIMARY KEY,
  event_key     TEXT NOT NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT,
  entity_type   TEXT,
  entity_id     INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crm_nudge_events_key_idx ON crm_nudge_events (event_key);
CREATE INDEX crm_nudge_events_user_idx ON crm_nudge_events (user_id, created_at DESC);
