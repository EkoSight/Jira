-- Daily standup: a 09:30 reminder in a company Chat space, submissions due at
-- 09:40, and a review with threaded, respectful feedback.
--
-- Additive only. The individual and department summaries are untouched. No
-- table here changes attendance, leave, pay or black marks: a missing or vague
-- standup is recorded for a person to look at, never turned into a penalty.

-- Who is expected to post a standup. A member is a person, not a login: people
-- who share one account (an HR login, say) are separate members, each with
-- their own explicit name.
CREATE TABLE IF NOT EXISTS standup_members (
  id                     SERIAL PRIMARY KEY,
  -- their own TaskFlow account, when they have one
  user_id                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- the explicit name every standup of theirs carries
  full_name              TEXT NOT NULL,
  role_title             TEXT,
  department_id          INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  -- a TaskFlow login they share with others, when they have none of their own
  shared_account_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- the Google Chat identity their messages arrive from
  chat_user_name         TEXT,
  chat_email             TEXT,
  -- VERIFIED: their Chat identity is confirmed. Anything else is held for a
  -- person to resolve and never counted as theirs.
  identity_status        TEXT NOT NULL DEFAULT 'UNVERIFIED'
                         CHECK (identity_status IN ('VERIFIED', 'UNVERIFIED', 'REJECTED')),
  identity_verified_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  identity_verified_at   TIMESTAMPTZ,
  identity_note          TEXT,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  ended_at               TIMESTAMPTZ,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT standup_members_has_login CHECK (user_id IS NOT NULL OR shared_account_id IS NOT NULL OR chat_email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS standup_members_user_idx ON standup_members (user_id) WHERE user_id IS NOT NULL AND active;
CREATE INDEX IF NOT EXISTS standup_members_chat_idx ON standup_members (lower(chat_email)) WHERE active;

-- One row per working day the standup ran: the evidence of what was sent and
-- when, and how far the review got. A second scheduler run finds the row and
-- does nothing.
CREATE TABLE IF NOT EXISTS standup_days (
  id                     SERIAL PRIMARY KEY,
  work_date              DATE NOT NULL UNIQUE,
  space_name             TEXT NOT NULL,
  timezone               TEXT NOT NULL,
  reminder_due_at        TIMESTAMPTZ NOT NULL,
  deadline_at            TIMESTAMPTZ NOT NULL,
  -- the reminder's outbox key; delivery time and Google's message name are read from the outbox
  reminder_key           TEXT,
  reminder_queued_at     TIMESTAMPTZ,
  reminder_sent_at       TIMESTAMPTZ,
  reminder_thread        TEXT,
  -- the deadline actually applied: the reminder's window, counted from its delivery
  effective_deadline_at  TIMESTAMPTZ,
  status                 TEXT NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN', 'REVIEWING', 'REVIEWED', 'ESCALATED', 'SKIPPED')),
  skipped_reason         TEXT,
  reviewed_at            TIMESTAMPTZ,
  escalated_at           TIMESTAMPTZ,
  notes                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A member's standup for a day. The first arrival time is kept for good; each
-- change is a new version below.
CREATE TABLE IF NOT EXISTS standup_submissions (
  id                     SERIAL PRIMARY KEY,
  work_date              DATE NOT NULL,
  member_id              INTEGER NOT NULL REFERENCES standup_members(id) ON DELETE CASCADE,
  first_submitted_at     TIMESTAMPTZ NOT NULL,
  first_source           TEXT NOT NULL CHECK (first_source IN ('APP', 'CHAT_DM', 'CHAT_SPACE')),
  current_version        INTEGER NOT NULL DEFAULT 1,
  -- where in Chat it lives, so feedback can reply in its thread
  chat_message_name      TEXT,
  chat_thread_name       TEXT,
  -- ON_TIME / LATE against the effective deadline, once known
  timing                 TEXT CHECK (timing IN ('ON_TIME', 'LATE')),
  quality                TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (quality IN ('PENDING', 'OK', 'NEEDS_CORRECTION', 'CORRECTED')),
  findings               JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewed_version       INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_date, member_id)
);

CREATE TABLE IF NOT EXISTS standup_submission_versions (
  id                     SERIAL PRIMARY KEY,
  submission_id          INTEGER NOT NULL REFERENCES standup_submissions(id) ON DELETE CASCADE,
  version                INTEGER NOT NULL,
  source                 TEXT NOT NULL CHECK (source IN ('APP', 'CHAT_DM', 'CHAT_SPACE')),
  -- the TaskFlow login or Chat account it came from — for a shared login, not the person
  submitted_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_by_chat      TEXT,
  chat_message_name      TEXT,
  received_at            TIMESTAMPTZ NOT NULL,
  content                JSONB NOT NULL,
  raw_text               TEXT,
  UNIQUE (submission_id, version)
);
-- the same Chat message is one version, however often it is delivered
CREATE UNIQUE INDEX IF NOT EXISTS standup_versions_message_idx ON standup_submission_versions (chat_message_name) WHERE chat_message_name IS NOT NULL;

-- The review of each eligible member for a day. One row each.
CREATE TABLE IF NOT EXISTS standup_reviews (
  id                     SERIAL PRIMARY KEY,
  work_date              DATE NOT NULL,
  member_id              INTEGER NOT NULL REFERENCES standup_members(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL CHECK (status IN ('ON_TIME', 'LATE', 'MISSING', 'EXEMPT', 'INACCESSIBLE')),
  reason                 TEXT,
  submission_id          INTEGER REFERENCES standup_submissions(id) ON DELETE SET NULL,
  reviewed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a person's follow-up; nothing here is a penalty
  resolution             TEXT CHECK (resolution IN ('EXCUSED', 'FOLLOWED_UP', 'NO_ACTION', 'IDENTITY_FIXED')),
  resolution_note        TEXT,
  resolved_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at            TIMESTAMPTZ,
  UNIQUE (work_date, member_id)
);

-- Messages that looked like a standup but could not be safely attributed: an
-- unknown or unverified account, or a shared account naming nobody it covers.
-- Held for a person; never counted for anyone.
CREATE TABLE IF NOT EXISTS standup_unmatched (
  id                     SERIAL PRIMARY KEY,
  work_date              DATE NOT NULL,
  source                 TEXT NOT NULL CHECK (source IN ('CHAT_DM', 'CHAT_SPACE')),
  chat_message_name      TEXT UNIQUE,
  chat_thread_name       TEXT,
  sender_chat            TEXT,
  sender_email           TEXT,
  named_person           TEXT,
  reason                 TEXT NOT NULL,
  raw_text               TEXT,
  received_at            TIMESTAMPTZ NOT NULL,
  resolved_member_id     INTEGER REFERENCES standup_members(id) ON DELETE SET NULL,
  resolved_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat messages for the standup go through the same outbox; widened, keeping
-- every kind it already allowed.
ALTER TABLE chat_outbox DROP CONSTRAINT IF EXISTS chat_outbox_kind_check;
ALTER TABLE chat_outbox ADD CONSTRAINT chat_outbox_kind_check
  CHECK (kind IN ('ALERT', 'DIGEST', 'TEAM_SUMMARY', 'TEST', 'WELCOME',
                  'STANDUP_REMINDER', 'STANDUP_POST', 'STANDUP_FEEDBACK', 'STANDUP_NUDGE', 'STANDUP_ESCALATION'));
-- the thread Google put a message in, so later replies can follow it
ALTER TABLE chat_outbox ADD COLUMN IF NOT EXISTS thread_name TEXT;
