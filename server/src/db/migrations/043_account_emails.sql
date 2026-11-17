-- Account emails: a person's sign-in details by email when an administrator
-- creates their account or resets their password, and "Forgot password?"
-- (docs/ACCOUNT_EMAILS.md). Additive only: one new nullable column, new tables,
-- new indexes. No password, and no email body, is ever kept here.

-- When a temporary password TaskFlow issued stops working. NULL means it never
-- expires, which is how every temporary password issued before this release
-- keeps working exactly as it did.
ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_password_expires_at TIMESTAMPTZ;

-- One row per account email: who it went to, why, and whether it went.
CREATE TABLE IF NOT EXISTS account_emails (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('WELCOME', 'RESET', 'FORGOT', 'PASSWORD_CHANGED', 'TEST')),
  to_address           TEXT NOT NULL,
  triggered_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status               TEXT NOT NULL CHECK (status IN ('SENT', 'FAILED', 'NOT_SET_UP')),
  provider             TEXT,
  provider_message_id  TEXT,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_emails_user_idx ON account_emails (user_id, created_at DESC);

-- A "Forgot password?" request. Its temporary password (kept only as a hash)
-- works alongside the person's current one until it is used, cancelled or
-- expires, so a request from someone else can never lock them out.
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  requested_ip   TEXT
);
CREATE INDEX IF NOT EXISTS password_reset_requests_open_idx
  ON password_reset_requests (user_id, expires_at) WHERE used_at IS NULL AND cancelled_at IS NULL;
