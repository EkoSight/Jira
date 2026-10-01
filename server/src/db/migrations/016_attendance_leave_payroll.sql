-- Attendance, working hours, leave approval and the monthly salary summary.
--
-- Additive only: new tables, nothing existing touched. Task, goal and CRM
-- tables are not altered, and nothing here is named "check-in" without
-- "attendance" in front of it, so it cannot be confused with a key-result
-- check-in.
--
-- Times are TIMESTAMPTZ (stored in UTC). Work dates are DATE in the
-- organisation's attendance timezone (Asia/Kolkata by default). Durations are
-- integer seconds — never "8.30 hours".

-- ---------------------------------------------------------------- policy

-- Effective-dated. The policy for a date is the latest version whose
-- effective_from is on or before it. A version is never edited once a locked
-- payroll period has used it; a change is a new version.
--
-- accepted_by / accepted_at record an administrator accepting the version,
-- including its PROPOSED defaults. Payroll cannot be finalised on a version
-- nobody accepted.
CREATE TABLE IF NOT EXISTS attendance_policies (
  id              SERIAL PRIMARY KEY,
  effective_from  DATE NOT NULL,
  config          JSONB NOT NULL,
  note            TEXT,
  accepted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  accepted_at     TIMESTAMPTZ,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_policies_effective_idx ON attendance_policies (effective_from DESC, id DESC);

-- Paid holidays. Company-wide when department_id is null.
CREATE TABLE IF NOT EXISTS work_holidays (
  id             SERIAL PRIMARY KEY,
  holiday_date   DATE NOT NULL,
  name           TEXT NOT NULL,
  department_id  INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS work_holidays_unique_idx
  ON work_holidays (holiday_date, COALESCE(department_id, 0));

-- Each person's working terms, where they differ from the policy. A person
-- with no row is treated as on the policy's calendar, but payroll needs a
-- joining date before it can be finalised.
CREATE TABLE IF NOT EXISTS employee_work_profiles (
  user_id               INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  joining_date          DATE,
  exit_date             DATE,
  -- null = the policy's working days
  working_days          INTEGER[],
  attendance_required   BOOLEAN NOT NULL DEFAULT TRUE,
  work_mode             TEXT NOT NULL DEFAULT 'OFFICE' CHECK (work_mode IN ('OFFICE', 'REMOTE', 'FIELD', 'HYBRID')),
  reporting_manager_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_work_profiles_dates CHECK (exit_date IS NULL OR joining_date IS NULL OR exit_date >= joining_date)
);

-- Which departments a manager may see attendance for. Explicit, so being a
-- manager does not on its own open everyone's attendance and location.
CREATE TABLE IF NOT EXISTS attendance_team_access (
  manager_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id  INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  granted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manager_id, department_id)
);

-- ---------------------------------------------------------------- attendance

-- One session per person per work date (first version: one shift a day).
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date                 DATE NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'OPEN'
                            CHECK (status IN ('OPEN', 'COMPLETED', 'MISSING_CHECKOUT')),

  check_in_at               TIMESTAMPTZ,
  check_in_lat              NUMERIC(9, 6),
  check_in_lng              NUMERIC(9, 6),
  check_in_accuracy_m       NUMERIC(10, 2),
  check_in_location_at      TIMESTAMPTZ,
  check_in_source           TEXT CHECK (check_in_source IN ('DEVICE_LOCATION', 'MANUALLY_REGULARIZED')),
  check_in_request_id       TEXT,

  check_out_at              TIMESTAMPTZ,
  check_out_lat             NUMERIC(9, 6),
  check_out_lng             NUMERIC(9, 6),
  check_out_accuracy_m      NUMERIC(10, 2),
  check_out_location_at     TIMESTAMPTZ,
  check_out_source          TEXT CHECK (check_out_source IN ('DEVICE_LOCATION', 'MANUALLY_REGULARIZED')),
  check_out_request_id      TEXT,

  regularized               BOOLEAN NOT NULL DEFAULT FALSE,
  review_flags              TEXT[] NOT NULL DEFAULT '{}',
  check_in_user_agent       TEXT,
  check_out_user_agent      TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT attendance_sessions_order CHECK (check_out_at IS NULL OR check_in_at IS NULL OR check_out_at >= check_in_at),
  CONSTRAINT attendance_sessions_lat CHECK (check_in_lat IS NULL OR check_in_lat BETWEEN -90 AND 90),
  CONSTRAINT attendance_sessions_lng CHECK (check_in_lng IS NULL OR check_in_lng BETWEEN -180 AND 180),
  CONSTRAINT attendance_sessions_out_lat CHECK (check_out_lat IS NULL OR check_out_lat BETWEEN -90 AND 90),
  CONSTRAINT attendance_sessions_out_lng CHECK (check_out_lng IS NULL OR check_out_lng BETWEEN -180 AND 180)
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_one_per_day ON attendance_sessions (user_id, work_date);
-- across every device: at most one open session per person
CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_one_open ON attendance_sessions (user_id) WHERE status = 'OPEN';
-- a retried request finds its first result instead of making a second
CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_in_request ON attendance_sessions (user_id, check_in_request_id) WHERE check_in_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attendance_sessions_date_idx ON attendance_sessions (work_date);

-- Requests to put a session right. The original values are kept in `before`,
-- the applied values in `after`; nobody overwrites or deletes an event.
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id           INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  work_date            DATE NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('MISSED_CHECK_IN', 'MISSED_CHECK_OUT', 'WRONG_TIME', 'TECHNICAL', 'FIELD_DUTY', 'REOPEN')),
  proposed_check_in    TIMESTAMPTZ,
  proposed_check_out   TIMESTAMPTZ,
  reason               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at          TIMESTAMPTZ,
  review_note          TEXT,
  before               JSONB,
  after                JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_corrections_user_idx ON attendance_corrections (user_id, work_date);
CREATE INDEX IF NOT EXISTS attendance_corrections_pending_idx ON attendance_corrections (status) WHERE status = 'PENDING';

-- A reviewer's decision about a scheduled day nobody recorded. Without one,
-- the day is "Unrecorded — needs review", never an assumed absence.
CREATE TABLE IF NOT EXISTS attendance_day_reviews (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date    DATE NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('UNAPPROVED_ABSENCE')),
  note         TEXT,
  reviewer_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, work_date)
);

-- Whether a day's post-18:00 time may be used to offset a shortfall. The raw
-- time is never discarded; this only says how much of it counts.
CREATE TABLE IF NOT EXISTS extra_time_reviews (
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date         DATE NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ELIGIBLE', 'REJECTED')),
  eligible_seconds  INTEGER CHECK (eligible_seconds IS NULL OR eligible_seconds >= 0),
  reason            TEXT,
  reviewer_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, work_date)
);

-- ---------------------------------------------------------------- leave

CREATE TABLE IF NOT EXISTS leave_requests (
  id                      SERIAL PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category                TEXT NOT NULL CHECK (category IN ('CASUAL', 'SICK', 'UNPAID', 'STATUTORY', 'OTHER')),
  start_date              DATE NOT NULL,
  end_date                DATE NOT NULL,
  -- a single-day request can be for half of it
  day_part                TEXT NOT NULL DEFAULT 'FULL' CHECK (day_part IN ('FULL', 'FIRST_HALF', 'SECOND_HALF')),
  reason                  TEXT NOT NULL,
  is_emergency            BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_explanation   TEXT,
  status                  TEXT NOT NULL DEFAULT 'SUBMITTED'
                          CHECK (status IN ('DRAFT', 'SUBMITTED', 'EMERGENCY_REVIEW', 'NOTICE_EXCEPTION',
                                            'APPROVED_PAID', 'APPROVED_UNPAID', 'REJECTED', 'CANCELLED')),
  submitted_at            TIMESTAMPTZ,
  -- when the manager or HR was first told, and the evidence for it
  first_notified_at       TIMESTAMPTZ,
  notified_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email_reference         TEXT,
  -- TaskFlow has no mail service configured; this stays false until one is
  email_sent_by_taskflow  BOOLEAN NOT NULL DEFAULT FALSE,
  notice_seconds          INTEGER,
  notice_compliant        BOOLEAN,
  paid_days               NUMERIC(5, 1) NOT NULL DEFAULT 0,
  unpaid_days             NUMERIC(5, 1) NOT NULL DEFAULT 0,
  -- fixed at approval, day by day: [{ date, portion, paid }] in half-day units,
  -- so a request that crosses a month boundary draws on each month's allowance
  day_allocation          JSONB,
  -- an earlier notification the employee says they sent outside TaskFlow; shown
  -- to the reviewer as their claim, never used to backdate the notice
  claimed_notified_at     TIMESTAMPTZ,
  override_reason         TEXT,
  reviewer_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at             TIMESTAMPTZ,
  review_note             TEXT,
  -- the calendar entry everyone sees, created on approval and cancelled with it
  availability_id         INTEGER REFERENCES user_availability(id) ON DELETE SET NULL,
  created_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leave_requests_range CHECK (end_date >= start_date),
  CONSTRAINT leave_requests_half CHECK (day_part = 'FULL' OR start_date = end_date)
);
CREATE INDEX IF NOT EXISTS leave_requests_user_idx ON leave_requests (user_id, start_date);
CREATE INDEX IF NOT EXISTS leave_requests_status_idx ON leave_requests (status);

-- ---------------------------------------------------------------- payroll

-- The attendance-sensitive part of a salary, effective-dated. Not total CTC,
-- not reimbursements, not employer contributions.
CREATE TABLE IF NOT EXISTS salary_basis (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effective_from           DATE NOT NULL,
  attendance_sensitive     NUMERIC(12, 2) NOT NULL CHECK (attendance_sensitive >= 0),
  fixed_components         NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (fixed_components >= 0),
  currency                 TEXT NOT NULL DEFAULT 'INR',
  note                     TEXT,
  created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS salary_basis_unique_idx ON salary_basis (user_id, effective_from);

-- One row per person per month per version. Locking freezes a snapshot of the
-- inputs and the result; reopening starts a new version and keeps the old.
CREATE TABLE IF NOT EXISTS payroll_results (
  id                  SERIAL PRIMARY KEY,
  month               DATE NOT NULL,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'LOCKED', 'SUPERSEDED')),
  policy_id           INTEGER REFERENCES attendance_policies(id) ON DELETE SET NULL,
  snapshot            JSONB,
  submitted_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at        TIMESTAMPTZ,
  approved_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at         TIMESTAMPTZ,
  locked_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_at           TIMESTAMPTZ,
  reopened_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reopened_at         TIMESTAMPTZ,
  reopen_reason       TEXT,
  export_count        INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_results_version_idx ON payroll_results (month, user_id, version);
-- only one live (not superseded) row per person per month
CREATE UNIQUE INDEX IF NOT EXISTS payroll_results_live_idx ON payroll_results (month, user_id) WHERE status <> 'SUPERSEDED';

-- ---------------------------------------------------------------- audit

-- Every approval, rejection, manual credit, salary change, correction, policy
-- edit and payroll transition: who, when, why, and the values before and after.
CREATE TABLE IF NOT EXISTS attendance_audit (
  id           BIGSERIAL PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  subject_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason       TEXT,
  before       JSONB,
  after        JSONB,
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_audit_entity_idx ON attendance_audit (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS attendance_audit_subject_idx ON attendance_audit (subject_user_id, created_at);
