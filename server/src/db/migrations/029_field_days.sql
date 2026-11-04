-- Field days and leave: a day away from the desk protects that day's deadlines.
--
-- Additive only. Existing sessions are not field days (they were never
-- declared as such), existing leave requests did not ask for their deadlines
-- to be moved, and no existing task or black mark is touched by this file.

-- a day worked in the field, declared by the person (at check-in or later that
-- day), or recorded when a reviewer approves a "field duty" correction
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS field_day BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS field_note TEXT;
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS field_declared_at TIMESTAMPTZ;

-- the person asked for their deadlines during the leave to be moved to the day
-- they are back: at once for emergency leave, on approval for planned leave
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS move_tasks BOOLEAN NOT NULL DEFAULT FALSE;

-- Every deadline moved because its owner was in the field or on leave. The
-- task keeps working: it is moved, never marked done. A move made this way is
-- not counted as the person pushing a deadline.
CREATE TABLE IF NOT EXISTS task_deadline_moves (
  id                SERIAL PRIMARY KEY,
  task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL CHECK (reason IN ('FIELD_DAY', 'LEAVE')),
  -- the calendar day the deadline fell on
  work_date         DATE NOT NULL,
  session_id        INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  leave_request_id  INTEGER REFERENCES leave_requests(id) ON DELETE SET NULL,
  from_due          TIMESTAMPTZ NOT NULL,
  to_due            TIMESTAMPTZ NOT NULL,
  moved_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one move per task per deadline: a retry or a second trigger does nothing
CREATE UNIQUE INDEX IF NOT EXISTS task_deadline_moves_once_idx ON task_deadline_moves (task_id, from_due);
CREATE INDEX IF NOT EXISTS task_deadline_moves_user_idx ON task_deadline_moves (user_id, work_date);
CREATE INDEX IF NOT EXISTS task_deadline_moves_leave_idx ON task_deadline_moves (leave_request_id) WHERE leave_request_id IS NOT NULL;
