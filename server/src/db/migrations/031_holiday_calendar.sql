-- Holidays planned month by month or at short notice, with approval, and the
-- reviewed reconciliation of anything a late change touches.
--
-- Additive only. Every existing holiday keeps its exact meaning: a full day,
-- for everyone or one department, in force (status APPROVED by default). It is
-- not given an approver it never had; the screen says it was added before
-- approvals were required. No attendance record, black mark, leave request,
-- standup review or task is changed by this file.

-- ---------------------------------------------------------------- the calendar

-- one person's own holiday (an ad hoc day granted to them); never both a
-- department and a person on the same entry
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
-- how much of the day: the whole day, or the half before or after the
-- policy's half-day split
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS coverage TEXT NOT NULL DEFAULT 'FULL'
  CHECK (coverage IN ('FULL', 'FIRST_HALF', 'SECOND_HALF'));
-- a planned holiday, or an unplanned closure (power cut, flood, office shut)
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'HOLIDAY'
  CHECK (kind IN ('HOLIDAY', 'CLOSURE'));
-- only APPROVED entries are used by anything. A cancelled entry is kept, with
-- who cancelled it and why; nothing is deleted.
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'APPROVED'
  CHECK (status IN ('APPROVED', 'CANCELLED'));
-- the dates added together as one range share a series
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS series_id TEXT;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS request_id INTEGER;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
-- when people were told
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS cancel_request_id INTEGER;
ALTER TABLE work_holidays ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_holidays_one_scope') THEN
    ALTER TABLE work_holidays ADD CONSTRAINT work_holidays_one_scope CHECK (department_id IS NULL OR user_id IS NULL);
  END IF;
END $$;

-- One entry in force per date and scope. The old index allowed one entry per
-- date and department ever, which would forbid adding a date back after
-- cancelling it; this one only counts entries in force. Every existing row is
-- in force and already unique on (date, department), so it holds for them.
DROP INDEX IF EXISTS work_holidays_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS work_holidays_live_idx
  ON work_holidays (holiday_date, COALESCE(department_id, 0), COALESCE(user_id, 0))
  WHERE status = 'APPROVED';
CREATE INDEX IF NOT EXISTS work_holidays_date_idx ON work_holidays (holiday_date);

-- ---------------------------------------------------------------- changes, approved by a person

-- Every addition, amendment and cancellation is a request until someone with
-- "holiday.approve" approves it. Approving writes the calendar; the request
-- keeps what was asked, who asked, who decided, and the impact they were shown.
CREATE TABLE IF NOT EXISTS holiday_requests (
  id             SERIAL PRIMARY KEY,
  action         TEXT NOT NULL CHECK (action IN ('ADD', 'AMEND', 'CANCEL')),
  -- the calendar entries an amendment replaces or a cancellation ends
  target_ids     INTEGER[] NOT NULL DEFAULT '{}',
  name           TEXT,
  kind           TEXT CHECK (kind IN ('HOLIDAY', 'CLOSURE')),
  start_date     DATE,
  end_date       DATE,
  coverage       TEXT CHECK (coverage IN ('FULL', 'FIRST_HALF', 'SECOND_HALF')),
  -- scope is kept as words too, so a later deleted department or person never
  -- turns a narrow request into a company-wide one in the history
  scope          TEXT CHECK (scope IN ('COMPANY', 'DEPARTMENT', 'PERSON')),
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PROPOSED'
                 CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  proposed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  proposed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  -- an administrator approving their own request; allowed only with a note
  self_approved  BOOLEAN NOT NULL DEFAULT FALSE,
  -- the impact preview as it stood when the decision was made
  impact         JSONB,
  -- the calendar entries approving it created
  result_ids     INTEGER[] NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS holiday_requests_status_idx ON holiday_requests (status, proposed_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_holidays_request_fk') THEN
    ALTER TABLE work_holidays ADD CONSTRAINT work_holidays_request_fk
      FOREIGN KEY (request_id) REFERENCES holiday_requests(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_holidays_cancel_request_fk') THEN
    ALTER TABLE work_holidays ADD CONSTRAINT work_holidays_cancel_request_fk
      FOREIGN KEY (cancel_request_id) REFERENCES holiday_requests(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------- reconciliation

-- A record an approved change touches: a black mark whose deadline fell on the
-- day, a standup recorded missing or late that day, an approved leave that
-- counted the day against the allowance. Each one is proposed, and changes
-- nothing until a person with the right permission applies it. Applying keeps
-- the record as it was (before) and as it became (after); reversing puts it
-- back. The unique index makes regenerating the list a no-op.
CREATE TABLE IF NOT EXISTS holiday_corrections (
  id              SERIAL PRIMARY KEY,
  request_id      INTEGER NOT NULL REFERENCES holiday_requests(id) ON DELETE CASCADE,
  holiday_id      INTEGER REFERENCES work_holidays(id) ON DELETE SET NULL,
  work_date       DATE NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('MARK_WAIVE', 'MARK_RESTORE', 'MARK_CREATE', 'STANDUP_EXCUSE', 'STANDUP_UNEXCUSE', 'LEAVE_DAY_RELEASE', 'LEAVE_DAY_RESTORE')),
  target_type     TEXT NOT NULL CHECK (target_type IN ('BLACK_MARK', 'TASK', 'STANDUP_REVIEW', 'LEAVE_REQUEST')),
  target_id       INTEGER NOT NULL,
  -- distinguishes several proposals on one target (a rule and cycle, a date)
  target_key      TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL,
  proposal        JSONB,
  status          TEXT NOT NULL DEFAULT 'PROPOSED'
                  CHECK (status IN ('PROPOSED', 'APPLIED', 'REJECTED', 'REVERSED', 'STALE')),
  before          JSONB,
  after           JSONB,
  decided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  reversed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reversed_at     TIMESTAMPTZ,
  reverse_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS holiday_corrections_once_idx
  ON holiday_corrections (request_id, kind, target_type, target_id, target_key, work_date);
CREATE INDEX IF NOT EXISTS holiday_corrections_status_idx ON holiday_corrections (status, request_id);
CREATE INDEX IF NOT EXISTS holiday_corrections_target_idx ON holiday_corrections (target_type, target_id);

-- ---------------------------------------------------------------- black mark evidence

-- What a mark was based on when it was recorded: the rule as it stood, the
-- deadline, the deadline in force after days off, and the attendance policy
-- version used to judge those days. Older marks have none and say so.
ALTER TABLE black_marks ADD COLUMN IF NOT EXISTS evidence JSONB;
