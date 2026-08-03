-- Collaboration, attachments, notes, feature requests and monthly recognition.
--
-- Purely additive: new tables and new nullable columns only. Nothing is dropped,
-- renamed or rewritten, so applying this to a running installation keeps every
-- existing task, user and black mark exactly as it was.

-- ---------------------------------------------------------------- sub tasks

ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id);

-- ---------------------------------------------------------------- second owner

-- assignee_id stays the accountable owner; the follower supports them and sees
-- the card, but deadline black marks stay with the owner.
ALTER TABLE tasks ADD COLUMN follower_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX tasks_follower_idx ON tasks (follower_id);

-- ---------------------------------------------------------------- tagged people

-- Anyone tagged here can see and comment on the card even when it belongs to a
-- department they are not part of.
CREATE TABLE task_collaborators (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_collaborators_user_idx ON task_collaborators (user_id);

-- ---------------------------------------------------------------- attachments

CREATE TABLE task_attachments (
  id           SERIAL PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('link', 'image', 'file')),
  title        TEXT,
  -- links
  url          TEXT,
  provider     TEXT,
  -- uploads (stored on disk under UPLOAD_DIR, never in the database)
  file_name    TEXT,
  stored_name  TEXT,
  mime_type    TEXT,
  size_bytes   INTEGER,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_attachments_task_idx ON task_attachments (task_id);

-- ---------------------------------------------------------------- personal notes

CREATE TABLE notes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#fef3c7',
  is_pinned   BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notes_user_idx ON notes (user_id, is_archived);

-- ---------------------------------------------------------------- feature requests

CREATE TABLE feature_requests (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  detail       TEXT,
  category     TEXT NOT NULL DEFAULT 'feature'
               CHECK (category IN ('feature', 'improvement', 'bug', 'other')),
  urgency      TEXT NOT NULL DEFAULT 'useful'
               CHECK (urgency IN ('nice_to_have', 'useful', 'important', 'blocking')),
  contact      TEXT,
  status       TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'reviewing', 'planned', 'in_progress', 'done', 'declined')),
  admin_note   TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feature_requests_status_idx ON feature_requests (status);

CREATE TABLE feature_request_votes (
  request_id  INTEGER NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);

-- ---------------------------------------------------------------- recognition

CREATE TABLE recognitions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_month  DATE NOT NULL,
  title         TEXT NOT NULL DEFAULT 'Performer of the Month',
  citation      TEXT,
  score         NUMERIC(7, 2),
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  awarded_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recognitions_unique_idx ON recognitions (user_id, period_month, title);
CREATE INDEX recognitions_period_idx ON recognitions (period_month);

-- Kudos: anyone can recognise anyone, shown on the recognition wall.
CREATE TABLE kudos (
  id          SERIAL PRIMARY KEY,
  from_user   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_user <> to_user)
);
CREATE INDEX kudos_to_idx ON kudos (to_user);
CREATE INDEX kudos_created_idx ON kudos (created_at DESC);
