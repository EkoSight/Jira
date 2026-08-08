-- Recurring tasks and completion notes.
--
-- Additive only: new columns with defaults, nothing dropped or rewritten, so this
-- applies cleanly to the running site and leaves every existing task as it was.

-- How often a task repeats. 'none' (the default) is a normal one-off task, so
-- every existing row keeps its current behaviour.
ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'
  CHECK (recurrence IN ('none', 'daily', 'weekdays', 'weekly', 'monthly'));

-- Links every generated occurrence back to the first task in the series, so a
-- recurring task's history ("done 12 times") can be followed.
ALTER TABLE tasks ADD COLUMN recurrence_parent_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX tasks_recurrence_parent_idx ON tasks (recurrence_parent_id);

-- What the assignee wrote when they marked the task done: the outcome, and any
-- reasoning that goes with the proof attached to the card.
ALTER TABLE tasks ADD COLUMN completion_note TEXT;
