-- 036: calling leads from company Android phones and SIMs.
--
-- Additive only. Nothing existing is changed or removed:
--   * crm_calls gains columns for a call started from TaskFlow ("a session"),
--     the call length the phone measured and where a length came from, and the
--     phone it was made on. Existing calls keep every value; the new columns
--     are empty for them and every reader treats empty as "as before".
--   * the status check gains DIALLED (a call started from TaskFlow that has not
--     been reported yet), keeping every earlier value.
--   * new tables hold company phones, the people signed in on them, recordings
--     kept by TaskFlow, the phone policy acknowledgements, complaints and the
--     weekly calling review.
--   * provider (Exotel) rows and their recording links are not touched.

-- ---------------------------------------------------------------- calls

ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS talk_sec INTEGER CHECK (talk_sec IS NULL OR talk_sec >= 0);
-- where the length came from: the phone's call log, the recording's own length,
-- typed by the person, estimated from the time away from TaskFlow, or corrected
-- by a person afterwards (corrections keep their history in crm_call_edits)
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS duration_source TEXT
  CHECK (duration_source IS NULL OR duration_source IN ('DEVICE_LOG', 'RECORDING', 'TYPED', 'ESTIMATED', 'CORRECTED'));
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS connected BOOLEAN;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS device_id INTEGER;
-- one call-log entry from one phone is one call, however often it is sent
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS device_log_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS crm_calls_device_log_idx ON crm_calls (device_log_key) WHERE device_log_key IS NOT NULL;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS sim_label TEXT;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS dialled_at TIMESTAMPTZ;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ;
-- set once the lead's attempt count has counted this call, so a call reported
-- by the phone and then described by the person is counted exactly once
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS attempt_counted BOOLEAN NOT NULL DEFAULT FALSE;
-- why a call outside calling hours was made (a callback the lead asked for is
-- labelled in callback_reason instead)
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS hours_override_reason TEXT;
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS callback_reason TEXT;
-- the person on the other end asked not to be recorded on this call
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS no_recording BOOLEAN NOT NULL DEFAULT FALSE;
-- a started call nobody described by the end of the day is closed as
-- "Dialled, outcome not given"
ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS session_closed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS crm_calls_open_session_idx ON crm_calls (agent_user_id, dialled_at)
  WHERE outcome_at IS NULL AND session_closed_at IS NULL AND provider = 'device';

ALTER TABLE crm_calls DROP CONSTRAINT IF EXISTS crm_calls_status_check;
ALTER TABLE crm_calls ADD CONSTRAINT crm_calls_status_check
  CHECK (status IN ('QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED', 'DIALLED'));

-- ---------------------------------------------------------------- company phones

CREATE TABLE IF NOT EXISTS crm_call_devices (
  id                SERIAL PRIMARY KEY,
  -- a random id the app makes when it is first installed
  install_id        TEXT NOT NULL UNIQUE,
  maker             TEXT,
  model             TEXT,
  android_version   TEXT,
  app_version       TEXT,
  dialler_package   TEXT,
  asset_label       TEXT,
  sim_number        TEXT,
  work_sim          TEXT,
  permissions       JSONB NOT NULL DEFAULT '{}'::jsonb,
  folder_chosen     BOOLEAN NOT NULL DEFAULT FALSE,
  setup             JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  signed_in_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_seen_at      TIMESTAMPTZ,
  last_sync_at      TIMESTAMPTZ,
  last_error        TEXT,
  revoked_at        TIMESTAMPTZ,
  revoked_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- each person signed in on a phone, with that sign-in's device token (stored
-- hashed). Ending a sign-in (signing out, handing the phone over) keeps it so
-- calls made before can still be sent; revoking refuses everything.
CREATE TABLE IF NOT EXISTS crm_call_device_sessions (
  id           SERIAL PRIMARY KEY,
  device_id    INTEGER NOT NULL REFERENCES crm_call_devices(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  end_reason   TEXT CHECK (end_reason IS NULL OR end_reason IN ('SIGNED_OUT', 'HANDED_OVER', 'REPLACED', 'REVOKED')),
  ended_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_call_device_sessions_open_idx ON crm_call_device_sessions (device_id) WHERE ended_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_calls_device_fk' AND conrelid = 'crm_calls'::regclass) THEN
    ALTER TABLE crm_calls ADD CONSTRAINT crm_calls_device_fk FOREIGN KEY (device_id) REFERENCES crm_call_devices(id) ON DELETE SET NULL;
  END IF;
END $$;

-- how each dialler app's recordings reach TaskFlow, as confirmed by an
-- administrator after testing that phone model
CREATE TABLE IF NOT EXISTS crm_dialler_modes (
  package      TEXT PRIMARY KEY,
  mode         TEXT NOT NULL CHECK (mode IN ('AUTOMATIC', 'SHARE_BY_HAND', 'NONE')),
  folder_hint  TEXT,
  note         TEXT,
  confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- recordings kept by TaskFlow

CREATE TABLE IF NOT EXISTS crm_call_recordings (
  id             SERIAL PRIMARY KEY,
  call_id        INTEGER NOT NULL REFERENCES crm_calls(id) ON DELETE CASCADE,
  storage_path   TEXT NOT NULL,
  mime           TEXT NOT NULL,
  bytes          INTEGER NOT NULL CHECK (bytes > 0),
  sha256         TEXT NOT NULL,
  length_sec     INTEGER CHECK (length_sec IS NULL OR length_sec >= 0),
  source         TEXT NOT NULL CHECK (source IN ('DEVICE_SYNC', 'SHARED', 'ATTACHED')),
  original_name  TEXT,
  device_id      INTEGER REFERENCES crm_call_devices(id) ON DELETE SET NULL,
  uploaded_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- "keep: needed for a dispute" stops the retention rule until it is removed
  hold_reason    TEXT,
  hold_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  hold_at        TIMESTAMPTZ,
  -- the audio file is deleted; this row stays as the record that it existed
  deleted_at     TIMESTAMPTZ,
  delete_reason  TEXT,
  deleted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_call_recordings_live_idx ON crm_call_recordings (call_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_call_recordings_retention_idx ON crm_call_recordings (created_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- people who object

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS do_not_record BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS do_not_record BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE crm_optouts ADD COLUMN IF NOT EXISTS call_id INTEGER REFERENCES crm_calls(id) ON DELETE SET NULL;
ALTER TABLE crm_optouts ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL;
ALTER TABLE crm_optouts ADD COLUMN IF NOT EXISTS complaint BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE crm_optouts ADD COLUMN IF NOT EXISTS complaint_text TEXT;
ALTER TABLE crm_optouts ADD COLUMN IF NOT EXISTS lift_reason TEXT;

-- each complaint, as said by the customer: counted for the early warning
CREATE TABLE IF NOT EXISTS crm_call_complaints (
  id               SERIAL PRIMARY KEY,
  phone_normalized TEXT NOT NULL,
  lead_id          INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  account_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id       INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  call_id          INTEGER REFERENCES crm_calls(id) ON DELETE SET NULL,
  what_they_said   TEXT NOT NULL,
  recorded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_call_complaints_time_idx ON crm_call_complaints (created_at DESC);

-- ---------------------------------------------------------------- the phone policy, and reviews

CREATE TABLE IF NOT EXISTS crm_policy_acks (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_key       TEXT NOT NULL,
  version          INTEGER NOT NULL,
  device_id        INTEGER REFERENCES crm_call_devices(id) ON DELETE SET NULL,
  acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, policy_key, version)
);

-- the weekly calling review and the complaint warning, each sent once per period
CREATE TABLE IF NOT EXISTS crm_calling_alerts (
  kind     TEXT NOT NULL CHECK (kind IN ('WEEKLY_REVIEW', 'COMPLAINT_WARNING')),
  period   TEXT NOT NULL,
  summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period)
);
