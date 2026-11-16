-- To-dos everywhere (Part C): the Today's plan widget, the one-time offer,
-- and Chat's "undo". Additive only.

-- "Today's plan" at the top of every template, once. People who never
-- customised see it on their next visit; saved layouts are not touched (they
-- get a one-time offer instead, below).
UPDATE dashboard_templates
   SET layout = jsonb_set(layout, '{widgets}',
         jsonb_build_array(jsonb_build_object('id', 'td1', 'type', 'todos', 'typeVersion', 1, 'width', 'full', 'config', '{}'::jsonb))
         || COALESCE(layout->'widgets', '[]'::jsonb)),
       version = version + 1,
       updated_at = now()
 WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(layout->'widgets', '[]'::jsonb)) w WHERE w->>'type' = 'todos');

-- Answers to one-time offers ("Add Today's plan to your workspace?"), so each
-- is asked once: {"todos": "ADDED" | "DECLINED"}.
ALTER TABLE user_dashboards ADD COLUMN IF NOT EXISTS offers JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The last to-do change made from Google Chat, so "undo" can revert it once.
CREATE TABLE IF NOT EXISTS todo_chat_undo (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('ADDED', 'TICKED')),
  source      TEXT NOT NULL CHECK (source IN ('TODO', 'STEP')),
  item_id     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  -- the Chat message that made this change: the same message delivered twice acts once
  message_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
