-- Google Chat installed by an administrator for everyone.
--
-- An admin install creates a direct message between TaskFlow and each person
-- without anyone opening it, so TaskFlow finds those chats itself and links
-- them by Google user id. Additive only.

-- Google's id for the person in a direct message ("users/1234567890")
ALTER TABLE chat_spaces ADD COLUMN IF NOT EXISTS google_user_name TEXT;
-- whether Google reported the chat as created by an administrator install
ALTER TABLE chat_spaces ADD COLUMN IF NOT EXISTS admin_installed BOOLEAN NOT NULL DEFAULT FALSE;
-- when TaskFlow posted its one-time hello into a chat it could not match to anyone
ALTER TABLE chat_spaces ADD COLUMN IF NOT EXISTS welcomed_at TIMESTAMPTZ;

-- a person's Google id, once known, so they are looked up in the directory once
ALTER TABLE chat_preferences ADD COLUMN IF NOT EXISTS google_user_name TEXT;

-- the last time TaskFlow looked for new chats, and what it found
CREATE TABLE IF NOT EXISTS chat_sync_runs (
  id           SERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  mode         TEXT,
  result       JSONB,
  error        TEXT
);

-- the hello TaskFlow sends when a chat is set up for someone
ALTER TABLE chat_outbox DROP CONSTRAINT IF EXISTS chat_outbox_kind_check;
ALTER TABLE chat_outbox ADD CONSTRAINT chat_outbox_kind_check
  CHECK (kind IN ('ALERT', 'DIGEST', 'TEAM_SUMMARY', 'TEST', 'WELCOME'));
