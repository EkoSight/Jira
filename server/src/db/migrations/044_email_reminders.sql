-- Task reminders by email (docs/DEADLINES_REMINDERS.md, "Email"), beside the
-- TaskFlow bell and Google Chat. Additive only: new tables, new nullable or
-- defaulted columns, and CHECKs widened with every value they allowed before.
-- Nothing existing changes meaning, and nobody gets an email until an
-- administrator has set up email and switched reminders to LIVE.

-- a third channel for task reminders and sales follow-up reminders
ALTER TABLE task_reminders DROP CONSTRAINT IF EXISTS task_reminders_channel_check;
ALTER TABLE task_reminders ADD CONSTRAINT task_reminders_channel_check
  CHECK (channel IN ('APP', 'CHAT', 'EMAIL'));
ALTER TABLE crm_followup_reminders DROP CONSTRAINT IF EXISTS crm_followup_reminders_channel_check;
ALTER TABLE crm_followup_reminders ADD CONSTRAINT crm_followup_reminders_channel_check
  CHECK (channel IN ('APP', 'CHAT', 'EMAIL'));

-- summaries by email: their own log rows, one per channel. Every existing row
-- is a Chat (or bell) row, which the default keeps.
ALTER TABLE reminder_summary_log ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'CHAT';
ALTER TABLE reminder_summary_log DROP CONSTRAINT IF EXISTS reminder_summary_log_status_check;
ALTER TABLE reminder_summary_log ADD CONSTRAINT reminder_summary_log_status_check
  CHECK (status IN ('QUEUED', 'APP_ONLY', 'SKIPPED', 'WOULD_SEND', 'EMAILED'));

-- "send them the steps to connect Google Chat", by email
ALTER TABLE account_emails DROP CONSTRAINT IF EXISTS account_emails_kind_check;
ALTER TABLE account_emails ADD CONSTRAINT account_emails_kind_check
  CHECK (kind IN ('WELCOME', 'RESET', 'FORGOT', 'PASSWORD_CHANGED', 'TEST', 'CHAT_STEPS'));

-- Reminder and summary emails waiting to go, like chat_outbox. What to say is
-- kept (reminder ids or the summary text), not the rendered email: it is
-- rendered when sent, so a task closed in the meantime is never reminded about.
CREATE TABLE IF NOT EXISTS email_outbox (
  id                   BIGSERIAL PRIMARY KEY,
  dedupe_key           TEXT NOT NULL UNIQUE,
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_address           TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('REMINDER', 'SUMMARY', 'FOLLOW_UP', 'WORKSPACE')),
  payload              JSONB NOT NULL DEFAULT '{}',
  items                INTEGER NOT NULL DEFAULT 1,
  -- reminders falling due close together wait this long to go as one email
  hold_until           TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject              TEXT,
  provider_message_id  TEXT,
  local_date           DATE,
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS email_outbox_user_idx ON email_outbox (user_id, local_date);

-- How each person hears about their own tasks. No row: the organisation's
-- defaults (Settings → Reminders → Channels).
CREATE TABLE IF NOT EXISTS reminder_channel_prefs (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  task_reminders     TEXT NOT NULL CHECK (task_reminders IN ('BOTH', 'CHAT_ELSE_EMAIL', 'EMAIL', 'CHAT', 'BELL')),
  summaries          TEXT NOT NULL CHECK (summaries IN ('BOTH', 'CHAT_ELSE_EMAIL', 'EMAIL', 'CHAT', 'BELL')),
  summary_all_clear  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An address that bounced: reminder emails to it stop until an administrator
-- clears it, once it is fixed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_undeliverable_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_undeliverable_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_soft_bounces INTEGER NOT NULL DEFAULT 0;

-- workspace and personal reminders by email: off unless the person turns it on
ALTER TABLE reminder_rule_prefs ADD COLUMN IF NOT EXISTS email BOOLEAN;
ALTER TABLE reminder_occurrences ADD COLUMN IF NOT EXISTS email_outbox_key TEXT;

-- Delivery reports for system emails (account emails and reminder emails),
-- kept apart from marketing's events. One row per provider report, so a report
-- the email service sends twice is counted once.
CREATE TABLE IF NOT EXISTS system_email_events (
  id                 BIGSERIAL PRIMARY KEY,
  provider_event_id  TEXT UNIQUE,
  reference          TEXT,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type               TEXT NOT NULL,
  email              TEXT,
  diagnostic         TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_email_events_user_idx ON system_email_events (user_id, occurred_at);
