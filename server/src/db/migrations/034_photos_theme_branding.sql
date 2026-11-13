-- Profile photos, each person's light/dark choice, and the organisation's
-- branding history. Additive only: no existing row or column changes meaning.

-- the current photo's version (part of its address, so caches never show an
-- old one); null when the person has no photo
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_version INTEGER;

-- the person's own choice: LIGHT, DARK or SYSTEM (match the device); null =
-- not chosen yet (the app keeps the browser's earlier choice)
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_mode TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_theme_mode_check;
ALTER TABLE users ADD CONSTRAINT users_theme_mode_check CHECK (theme_mode IS NULL OR theme_mode IN ('LIGHT', 'DARK', 'SYSTEM'));
-- one of the pre-approved accent colours, by key; null = the organisation's
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_accent TEXT;

-- one row per person who has, or had, a photo
CREATE TABLE IF NOT EXISTS user_photos (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED', 'REMOVED')),
  version         INTEGER NOT NULL,
  sizes           INTEGER[] NOT NULL DEFAULT '{}',
  has_original    BOOLEAN NOT NULL DEFAULT FALSE,
  -- the editor's settings (crop, straightening, fixes), to re-open it on the original
  edit            JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- when the person agreed: their own upload, or accepting a suggested photo
  consent_at      TIMESTAMPTZ,
  consent_notice  TEXT,
  removed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  removed_reason  TEXT,
  removed_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- a photo an administrator suggested for someone: theirs only if they accept
CREATE TABLE IF NOT EXISTS user_photo_proposals (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note          TEXT,
  edit          JSONB NOT NULL DEFAULT '{}'::jsonb,
  has_original  BOOLEAN NOT NULL DEFAULT FALSE,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN')),
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_photo_proposals_pending_idx ON user_photo_proposals (user_id) WHERE status = 'PENDING';

-- every saved branding value, newest last: Undo restores the one before
CREATE TABLE IF NOT EXISTS branding_history (
  id         SERIAL PRIMARY KEY,
  value      JSONB NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('SAVE', 'RESET', 'UNDO', 'ASSET')),
  saved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
