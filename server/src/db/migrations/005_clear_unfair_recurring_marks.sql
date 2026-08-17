-- Remove black marks that were never the person's fault.
--
-- A recurring task used to spawn its successor at "previous due date + one
-- interval". When someone completed a late occurrence, the new task was created
-- already past that date and immediately collected a missed-deadline black mark —
-- a penalty for doing the work, not for missing anything.
--
-- Those marks are identified narrowly: they sit on a task that is part of a
-- recurring series (it has a recurrence parent), and the deadline they "missed"
-- was already in the past when the task was created. A person cannot miss a
-- deadline that expired before the task existed.
--
-- They are waived rather than deleted, so the record of what happened survives and
-- the correction is visible to the person it affected. Marks a manager already
-- waived are left untouched.

UPDATE black_marks bm
   SET status = 'waived',
       waived_reason = 'Waived automatically: the task was created already past this deadline, '
                       || 'so the deadline could not have been met. Caused by a scheduling defect '
                       || 'in recurring tasks, since fixed.',
       waived_at = now()
  FROM tasks t
 WHERE bm.task_id = t.id
   AND bm.status = 'active'
   AND bm.source = 'auto'
   AND t.recurrence_parent_id IS NOT NULL
   AND t.due_date IS NOT NULL
   AND t.due_date <= t.created_at;

-- Bring any surviving occurrence that is still stuck in the past onto a sensible
-- schedule, so the same marks are not recreated by the next scan. The original
-- time of day is kept; only the date moves to the next one still ahead. Open,
-- unfinished occurrences only.
UPDATE tasks t
   SET due_date = CASE
         WHEN date_trunc('day', now()) + t.due_date::time > now()
           THEN date_trunc('day', now()) + t.due_date::time
         ELSE date_trunc('day', now()) + interval '1 day' + t.due_date::time
       END
  FROM workflow_statuses s
 WHERE s.id = t.status_id
   AND t.recurrence_parent_id IS NOT NULL
   AND t.due_date IS NOT NULL
   AND t.due_date <= t.created_at
   AND s.stage NOT IN ('done', 'cancelled')
   AND t.is_archived = FALSE;
