-- Where a lead is, and what is stopping it.
--
-- Additive. One new column, one new table, one new column on threads, and two
-- CHECK constraints WIDENED to accept more values. Widening only ever lets more
-- rows in, so every existing row still satisfies the new rule exactly as it did
-- the old one; nothing is dropped, renamed or rewritten.

-- ---------------------------------------------------------------- state

-- The state a lead is based in. The office address already exists as
-- accounts.hq_address and is reused rather than duplicated.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS state TEXT;
CREATE INDEX IF NOT EXISTS accounts_state_idx ON accounts (state);

-- Existing leads get a state only where one was already written down by a
-- person: the state on their head-office location, or, failing that, the state
-- of their locations when those all agree. Nothing is parsed out of a free-text
-- address and nothing is guessed — a lead with no recorded state stays blank and
-- is listed as such.
UPDATE accounts a
   SET state = l.state
  FROM account_locations l
 WHERE l.account_id = a.id
   AND l.kind = 'HQ'
   AND NULLIF(TRIM(l.state), '') IS NOT NULL
   AND a.state IS NULL;

UPDATE accounts a
   SET state = one.state
  FROM (
    SELECT account_id, MIN(TRIM(state)) AS state
      FROM account_locations
     WHERE NULLIF(TRIM(state), '') IS NOT NULL
     GROUP BY account_id
    HAVING COUNT(DISTINCT LOWER(TRIM(state))) = 1
  ) one
 WHERE one.account_id = a.id
   AND a.state IS NULL;

-- ---------------------------------------------------------------- blockers

-- A blocker is a thread: raised, discussed, and closed with a conclusion. So the
-- existing thread tables learn two new things to be about, and one new kind.
ALTER TABLE discussion_threads DROP CONSTRAINT IF EXISTS discussion_threads_entity_type_check;
ALTER TABLE discussion_threads ADD CONSTRAINT discussion_threads_entity_type_check
  CHECK (entity_type IN ('TASK', 'KEY_RESULT', 'OBJECTIVE', 'OPPORTUNITY', 'ACCOUNT'));

ALTER TABLE discussion_threads DROP CONSTRAINT IF EXISTS discussion_threads_kind_check;
ALTER TABLE discussion_threads ADD CONSTRAINT discussion_threads_kind_check
  CHECK (kind IN ('review', 'question', 'progress', 'challenge', 'help_needed',
                  'feedback', 'discussion', 'blocker'));

-- what sort of thing is in the way, so the same obstacle can be seen recurring
ALTER TABLE discussion_threads ADD COLUMN IF NOT EXISTS category TEXT;

-- The people asked to help. A thread already tells whoever it is waiting on and
-- whoever has spoken in it; a blocker is raised to bring in people who have not
-- spoken yet, and they are recorded here so they keep hearing about it.
CREATE TABLE IF NOT EXISTS discussion_thread_participants (
  thread_id  INTEGER NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);
