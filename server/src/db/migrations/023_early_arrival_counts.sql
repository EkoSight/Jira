-- 023: time before office hours counts.
--
-- People who check in before 09:00 have that time recorded and counted as
-- extra time, the same way as time after 18:00 (asked for on 12 October 2026).
--
-- Additive: one new column, and one new policy version. No existing row is
-- edited except to fill the new column, and nothing is removed.

-- ------------------------------------------------- what a review decided on

-- An extra-time review decided on the time it was shown. Reviews made while
-- time before office hours did not count were shown only the time after them;
-- this records which, so an early arrival is never counted or refused on the
-- strength of a decision that did not consider it.
ALTER TABLE extra_time_reviews
  ADD COLUMN IF NOT EXISTS covers_before_start BOOLEAN NOT NULL DEFAULT FALSE;

-- reviews made under a version that already counted early time did see it.
-- Judged by the version in force for the day when the review was made, so
-- the version added below never counts as one a reviewer saw.
UPDATE extra_time_reviews r
   SET covers_before_start = TRUE
 WHERE r.covers_before_start = FALSE
   AND COALESCE((
         SELECT (p.config->>'creditBeforeStart')::boolean
           FROM attendance_policies p
          WHERE p.effective_from <= r.work_date
            AND p.created_at <= r.reviewed_at
          ORDER BY p.effective_from DESC, p.id DESC
          LIMIT 1), FALSE);

-- ------------------------------------------------- the policy, from October 2026

-- A new version — never an edit — that counts time before office hours, copied
-- from the version in force with only that changed. It starts on 1 October
-- 2026, or after the last month whose payroll is approved or locked if that is
-- later, and never before the latest existing version. It is added only when
-- the policy does not already count early time, and like any new version it
-- waits for an administrator to accept it.
WITH latest AS (
  SELECT * FROM attendance_policies ORDER BY effective_from DESC, id DESC LIMIT 1
), closed AS (
  SELECT (date_trunc('month', MAX(month)) + interval '1 month')::date AS after
    FROM payroll_results WHERE status IN ('APPROVED', 'LOCKED')
), added AS (
  INSERT INTO attendance_policies (effective_from, config, note)
  SELECT GREATEST(DATE '2026-10-01', COALESCE(closed.after, DATE '2026-10-01'), latest.effective_from),
         latest.config || '{"creditBeforeStart": true}'::jsonb,
         'Time before office hours counts as extra time, like time after them (asked for on 12 October 2026). Copied from the version in force with only that changed.'
    FROM latest CROSS JOIN closed
   WHERE COALESCE((latest.config->>'creditBeforeStart')::boolean, FALSE) = FALSE
  RETURNING id, effective_from, note
)
INSERT INTO attendance_audit (entity_type, entity_id, action, reason, after, source)
SELECT 'POLICY', added.id::text, 'VERSION_CREATED', added.note,
       jsonb_build_object('effective_from', added.effective_from, 'creditBeforeStart', true),
       'MIGRATION 023'
  FROM added;
