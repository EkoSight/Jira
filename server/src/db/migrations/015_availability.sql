-- Who is away, and when.
--
-- One new table. Nothing existing is touched.
--
-- "Available" is not stored: a person is available on any day nobody has said
-- otherwise. Only the exceptions are recorded — on leave, a half day, or
-- unavailable — each for one date or a range of dates.
--
-- There is deliberately no field for WHY. A leave reason is often medical or
-- personal, and this table is readable by the whole team so that work can be
-- planned around it. The only free text is a note the person chooses to share
-- with everyone ("back Monday, reachable on phone").
--
-- Cancelling keeps the row, marked cancelled, so a leave that was booked and then
-- withdrawn is still visible to whoever needs to know what was planned when.

CREATE TABLE IF NOT EXISTS user_availability (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('ON_LEAVE', 'HALF_DAY', 'UNAVAILABLE')),
  -- calendar days in the organisation's own timezone, both inclusive
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  -- which half, for a half day; a half day is always a single date
  day_part      TEXT CHECK (day_part IN ('MORNING', 'AFTERNOON')),
  note          TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at  TIMESTAMPTZ,
  cancelled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT user_availability_range CHECK (end_date >= start_date),
  CONSTRAINT user_availability_half_day CHECK (
    status <> 'HALF_DAY' OR (start_date = end_date AND day_part IS NOT NULL)
  )
);

-- the question every screen asks: who is away on these dates
CREATE INDEX IF NOT EXISTS user_availability_dates_idx
  ON user_availability (start_date, end_date) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS user_availability_user_idx
  ON user_availability (user_id, start_date) WHERE cancelled_at IS NULL;
