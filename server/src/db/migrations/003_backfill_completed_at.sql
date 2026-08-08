-- Reconcile completion figures.
--
-- Before this, a task could sit in a done-stage status with completed_at = NULL
-- (created directly into "Done", or in a status whose stage was later switched to
-- done). Such a task was counted by the all-time "Completed overall" ring but was
-- invisible to "Done this month", so the two disagreed.
--
-- Backfill completed_at from the best timestamp we have, so every done task has a
-- completion date and the monthly figure is a true subset of the overall count.
-- Idempotent and non-destructive: it only fills values that are currently NULL.

UPDATE tasks t
   SET completed_at = COALESCE(t.updated_at, t.created_at, now())
  FROM workflow_statuses s
 WHERE s.id = t.status_id
   AND s.stage = 'done'
   AND t.completed_at IS NULL;

-- A done task should also read as fully progressed.
UPDATE tasks t
   SET progress = 100
  FROM workflow_statuses s
 WHERE s.id = t.status_id
   AND s.stage = 'done'
   AND t.progress <> 100;
