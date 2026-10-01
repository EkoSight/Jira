-- Google Chat: alerts as direct messages, team summaries in department spaces.
--
-- Additive only. Nothing existing is altered: TaskFlow's own notifications
-- stay exactly as they are, and Chat is a second way of delivering some of
-- them. The service account credentials live in the server environment, never
-- in the database.

-- Every Chat conversation TaskFlow has been added to. A direct message belongs
-- to one person; a space can be pointed at a department by an admin.
CREATE TABLE IF NOT EXISTS chat_spaces (
  id               SERIAL PRIMARY KEY,
  -- Google's resource name, e.g. "spaces/AAAA1234"
  space_name       TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('DM', 'SPACE')),
  display_name     TEXT,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department_id    INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  -- the Google account that added the app, as Google reported it
  added_by_email   TEXT,
  team_summary     BOOLEAN NOT NULL DEFAULT TRUE,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at       TIMESTAMPTZ
);
-- one active direct message per person
CREATE UNIQUE INDEX IF NOT EXISTS chat_spaces_one_dm ON chat_spaces (user_id) WHERE kind = 'DM' AND active;

-- What each person wants in Chat. No row means the defaults: both on.
CREATE TABLE IF NOT EXISTS chat_preferences (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  instant          BOOLEAN NOT NULL DEFAULT TRUE,
  morning_summary  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every message TaskFlow means to send, so a Google outage delays a message
-- rather than losing it, and a retry never sends it twice.
CREATE TABLE IF NOT EXISTS chat_outbox (
  id               BIGSERIAL PRIMARY KEY,
  -- what makes this message unique: "n:<notification>:<space>", "digest:<user>:<date>", …
  dedupe_key       TEXT NOT NULL UNIQUE,
  space_name       TEXT NOT NULL,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notification_id  INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('ALERT', 'DIGEST', 'TEAM_SUMMARY', 'TEST')),
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  -- Google's name for the message it created
  message_name     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_outbox_due_idx ON chat_outbox (next_attempt_at) WHERE status = 'PENDING';

-- How far through the notification list Chat has got. Starts at the newest
-- notification when Chat is first switched on, so years of history are never
-- replayed into everyone's Chat.
CREATE TABLE IF NOT EXISTS chat_cursor (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  last_notification_id  INTEGER NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
