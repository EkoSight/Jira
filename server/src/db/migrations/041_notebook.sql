-- The notebook (Part N): day notes, stars, project colours and two personal
-- switches. Additive only; nothing existing changes.

-- A free Notes area under each day's page. One per person per day; private.
CREATE TABLE IF NOT EXISTS todo_day_notes (
  id             SERIAL PRIMARY KEY,
  owner_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day            DATE NOT NULL,
  body           TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 10000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, day)
);

-- A highlighter mark for what matters most on a page.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE;

-- A project's own colour for its stamps; without one, its department's colour is used.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS color TEXT;
DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_color_check CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Personal switches, like theme_mode: write my items in handwriting style; a light tap on tick.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notebook_handwriting BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notebook_haptics BOOLEAN NOT NULL DEFAULT FALSE;

-- Month index dots and past pages read by day.
CREATE INDEX IF NOT EXISTS todo_moves_from_idx ON todo_moves (from_day);
