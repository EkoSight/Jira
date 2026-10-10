-- 022: reporting and controls.
--
-- Additive only. Every new table starts empty and no existing row is changed.
-- The one new rule is that the pipeline's history can only grow: a history row,
-- once written, can no longer be edited or removed — by the application, or by
-- accident.

-- ------------------------------------------------- each person's reminders

-- When someone's pipeline reminders arrive. A person with no row gets the
-- organization's defaults (Settings).
CREATE TABLE IF NOT EXISTS reminder_preferences (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- HH:MM, India time
  digest_time       TEXT NOT NULL DEFAULT '09:30'
                    CHECK (digest_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Monday 1 … Sunday 7
  digest_days       SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  -- a short, dated pause, with why
  paused_until      DATE,
  pause_reason      TEXT,
  -- while they are on leave, what cannot wait goes to each deal's escalation point
  cover_while_away  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every reminder sent, so the same one is never sent twice: at most one digest a
-- day for each person (one cover digest a day for each person covered), and an
-- unchanged digest is not repeated for a few days.
CREATE TABLE IF NOT EXISTS crm_reminder_log (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('DIGEST', 'COVER')),
  sent_on          DATE NOT NULL,
  covering_for     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  fingerprint      TEXT,
  signal_count     INTEGER NOT NULL DEFAULT 0,
  notification_id  INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_reminder_log_once_idx
  ON crm_reminder_log (user_id, kind, sent_on, (COALESCE(covering_for, 0)));
CREATE INDEX IF NOT EXISTS crm_reminder_log_user_idx ON crm_reminder_log (user_id, created_at DESC);

-- ------------------------------------------------- data quality

-- Two organizations that look alike and that somebody checked and said are
-- different. Nothing is ever merged automatically.
CREATE TABLE IF NOT EXISTS crm_duplicate_dismissals (
  account_a     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_b     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason        TEXT,
  dismissed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_a, account_b),
  CHECK (account_a < account_b)
);

-- ------------------------------------------------- the audit trail

-- What the deal history does not hold: an organization archived, an investor
-- summary exported, two organizations confirmed as different.
CREATE TABLE IF NOT EXISTS crm_audit_events (
  id           SERIAL PRIMARY KEY,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    INTEGER,
  summary      TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason       TEXT,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_audit_events_time_idx ON crm_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS crm_audit_events_entity_idx ON crm_audit_events (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS opportunity_history_time_idx ON opportunity_history (created_at DESC);

-- History only grows. A row of who changed what, from what, to what and why
-- cannot be edited or removed once written; neither can a week on the record.
CREATE OR REPLACE FUNCTION taskflow_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The % record is append-only: rows cannot be changed or removed (%)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_history_append_only
  BEFORE UPDATE OR DELETE ON opportunity_history
  FOR EACH ROW EXECUTE PROCEDURE taskflow_append_only();

CREATE TRIGGER crm_ownership_history_append_only
  BEFORE UPDATE OR DELETE ON crm_ownership_history
  FOR EACH ROW EXECUTE PROCEDURE taskflow_append_only();

CREATE TRIGGER crm_audit_events_append_only
  BEFORE UPDATE OR DELETE ON crm_audit_events
  FOR EACH ROW EXECUTE PROCEDURE taskflow_append_only();

CREATE TRIGGER pipeline_snapshots_append_only
  BEFORE UPDATE OR DELETE ON pipeline_snapshots
  FOR EACH ROW EXECUTE PROCEDURE taskflow_append_only();
