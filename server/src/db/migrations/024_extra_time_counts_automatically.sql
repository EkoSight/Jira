-- 024: extra time counts automatically.
--
-- Time outside office hours — before 09:00 and after 18:00 — counts as extra
-- time without anyone approving it (asked for on 12 October 2026). A reviewer
-- can still mark a day's time as not counted, and a session longer than the
-- policy's limit is still held for a person to look at.
--
-- Additive: one new policy version. Nothing existing is edited. Every review
-- already made stands exactly as it was decided.

-- A new version — never an edit — copied from the version in force with only
-- this changed. It starts on 1 October 2026, or after the last month whose
-- payroll is approved or locked if that is later, and never before the latest
-- existing version. It is added only while the policy still waits for a
-- reviewer, and like any new version it waits for an administrator to accept
-- it before a month that uses it can be finalised.
WITH latest AS (
  SELECT * FROM attendance_policies ORDER BY effective_from DESC, id DESC LIMIT 1
), closed AS (
  SELECT (date_trunc('month', MAX(month)) + interval '1 month')::date AS after
    FROM payroll_results WHERE status IN ('APPROVED', 'LOCKED')
), added AS (
  INSERT INTO attendance_policies (effective_from, config, note)
  SELECT GREATEST(DATE '2026-10-01', COALESCE(closed.after, DATE '2026-10-01'), latest.effective_from),
         latest.config || '{"extraRequiresReview": false}'::jsonb,
         'Extra time before and after office hours counts automatically; nobody has to approve it (asked for on 12 October 2026). Copied from the version in force with only that changed.'
    FROM latest CROSS JOIN closed
   WHERE COALESCE((latest.config->>'extraRequiresReview')::boolean, TRUE) = TRUE
  RETURNING id, effective_from, note
)
INSERT INTO attendance_audit (entity_type, entity_id, action, reason, after, source)
SELECT 'POLICY', added.id::text, 'VERSION_CREATED', added.note,
       jsonb_build_object('effective_from', added.effective_from, 'extraRequiresReview', false),
       'MIGRATION 024'
  FROM added;
