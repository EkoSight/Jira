-- Discussion and review threads, and subtasks that belong to a routine.
--
-- Purely additive: two new tables, two new nullable-or-defaulted columns, and a
-- backfill that COPIES existing comments forward without removing them. Nothing
-- is dropped, renamed or rewritten, so applying this to the running installation
-- keeps every task, comment, goal and black mark exactly as it was.

-- ---------------------------------------------------------------- threads

-- One conversation about one thing. The thing can be a task, a key result or an
-- objective, so a manager can say "this is too vague to measure" in the same
-- shape wherever the vagueness is, and everyone answers in the same place.
--
-- Deliberately NOT a second comment system: the task comment endpoints keep
-- working and now write here, and the old rows are copied in below.
CREATE TABLE discussion_threads (
  id            SERIAL PRIMARY KEY,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('TASK', 'KEY_RESULT', 'OBJECTIVE')),
  entity_id     INTEGER NOT NULL,

  -- what kind of conversation this is. 'review' is the one that asks for a
  -- change; the rest are how the work is talked about while it happens.
  kind          TEXT NOT NULL DEFAULT 'discussion'
                CHECK (kind IN ('review', 'question', 'progress', 'challenge',
                                'help_needed', 'feedback', 'discussion')),
  title         TEXT,

  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'resolved')),

  opened_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- who is being asked to do something about it; usually the item's owner
  awaiting_user INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- the conclusion the thread reached, written when it is closed. A thread that
  -- ends without one leaves the next reader guessing what was decided.
  resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  conclusion    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the lookup every screen does: "what is being discussed about this item"
CREATE INDEX discussion_threads_entity_idx
  ON discussion_threads (entity_type, entity_id, status);
CREATE INDEX discussion_threads_awaiting_idx
  ON discussion_threads (awaiting_user) WHERE status = 'open';

CREATE TABLE discussion_messages (
  id          SERIAL PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  -- set when this message was carried over from the old flat task comments, so
  -- the copy is always distinguishable from something typed here
  legacy_comment_id INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX discussion_messages_thread_idx ON discussion_messages (thread_id, created_at);
-- a second run of this migration must not duplicate the copied comments
CREATE UNIQUE INDEX discussion_messages_legacy_idx
  ON discussion_messages (legacy_comment_id) WHERE legacy_comment_id IS NOT NULL;

-- ------------------------------------------------- subtasks that repeat

-- A repeating task recreates its checklist every cycle but never its subtasks,
-- so a routine built out of subtasks quietly lost them. This says which ones are
-- part of the routine.
--
-- FALSE for every existing row on purpose: turning this on retrospectively would
-- start minting cards nobody asked for on series that are already running.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS repeats_with_parent BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------- backfill
--
-- Every existing task comment is COPIED into a thread of its own task. The
-- task_comments rows are left exactly where they are: this migration adds a
-- place to read them from, it does not move them, so rolling back the code
-- leaves the old screens working on untouched data.

INSERT INTO discussion_threads (entity_type, entity_id, kind, title, status, opened_by, created_at, updated_at)
SELECT 'TASK',
       c.task_id,
       'discussion',
       'Discussion',
       'open',
       -- the thread belongs to whoever spoke first
       (SELECT c2.author_id FROM task_comments c2
         WHERE c2.task_id = c.task_id ORDER BY c2.created_at, c2.id LIMIT 1),
       MIN(c.created_at),
       MAX(c.created_at)
  FROM task_comments c
 GROUP BY c.task_id;

INSERT INTO discussion_messages (thread_id, author_id, body, legacy_comment_id, created_at, updated_at)
SELECT t.id, c.author_id, c.body, c.id, c.created_at, c.updated_at
  FROM task_comments c
  JOIN discussion_threads t
    ON t.entity_type = 'TASK' AND t.entity_id = c.task_id AND t.kind = 'discussion';
