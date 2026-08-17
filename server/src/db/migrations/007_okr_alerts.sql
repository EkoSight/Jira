-- OKR attention layer.
--
-- Strictly additive. The intelligence engine derives everything it reports from
-- data that already exists (check-in timestamps, dates, progress), so it needs
-- no new tables of its own. The one thing missing is a way for a notification to
-- point at a goal instead of a task — added here as a nullable column, so every
-- existing notification keeps reading exactly as before.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS objective_id INTEGER REFERENCES objectives(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS notifications_objective_idx ON notifications (objective_id);
