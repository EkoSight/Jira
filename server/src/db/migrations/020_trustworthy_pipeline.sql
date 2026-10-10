-- Progress that can be trusted.
--
-- An audit found real work happening while the pipeline still showed old
-- stages and old next steps. This migration gives the pipeline what it needs to
-- tell the truth: who owes the next move and by when, what actually happened
-- (and in which direction), the evidence behind a stage, and the commercial
-- record — proposals, orders, invoices and payments — kept apart.
--
-- Additive only. New nullable columns, new tables, and three CHECK constraints
-- WIDENED to accept more values (every existing row still satisfies them). No
-- existing value is rewritten except where noted below, and those notes say
-- exactly which facts the new value is read from.

-- ---------------------------------------------------------------- next action

-- The next action already had a "what" and a "by when". It now has a "who",
-- and a record of when it was last agreed, so an old next step can be seen to
-- be old. Existing deals get no owner: nobody said who owes the move, so the
-- deal is flagged until somebody does.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS next_step_owner_id INTEGER
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS next_step_set_at TIMESTAMPTZ;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS next_step_set_by INTEGER
  REFERENCES users(id) ON DELETE SET NULL;

-- When the current next step was agreed, read only from the change history
-- that already records it. A deal whose next step was never changed through
-- the history stays blank ("not known when this was agreed"), never guessed.
UPDATE opportunities o
   SET next_step_set_at = h.changed_at
  FROM (
    SELECT opportunity_id, MAX(created_at) AS changed_at
      FROM opportunity_history
     WHERE field IN ('next_step', 'next_step_due')
     GROUP BY opportunity_id
  ) h
 WHERE h.opportunity_id = o.id
   AND o.next_step IS NOT NULL
   AND o.next_step_set_at IS NULL;

-- ---------------------------------------------------------------- people

-- One accountable owner (opportunities.owner_user_id, unchanged), and beside
-- them: who to escalate to, and who is helping.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS escalation_owner_id INTEGER
  REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS opportunity_collaborators (
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- what they help with, in their colleague's words
  role           TEXT,
  added_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, user_id)
);
CREATE INDEX IF NOT EXISTS opportunity_collaborators_user_idx
  ON opportunity_collaborators (user_id);

-- A handover is explicit: who handed what to whom, why, what is owed next, and
-- whether the new person has said they have it. Handing a deal over without
-- the recipient knowing is how a next move falls between two people.
CREATE TABLE IF NOT EXISTS opportunity_handovers (
  id              SERIAL PRIMARY KEY,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('OWNER', 'NEXT_ACTION', 'ESCALATION')),
  from_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason          TEXT,
  owed            TEXT,
  handed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS opportunity_handovers_waiting_idx
  ON opportunity_handovers (to_user_id) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS opportunity_handovers_opportunity_idx
  ON opportunity_handovers (opportunity_id, created_at DESC);

-- ---------------------------------------------------------------- what happened

-- A third direction: work on our side that the customer never saw. Recorded
-- so it shows on the timeline, and labelled so it can never read as a reply.
ALTER TABLE account_activities DROP CONSTRAINT IF EXISTS account_activities_direction_check;
ALTER TABLE account_activities ADD CONSTRAINT account_activities_direction_check
  CHECK (direction IN ('OUTBOUND', 'INBOUND', 'INTERNAL'));

-- New things the timeline records: a finished task, the commercial events, a
-- handover, and a change of next action.
ALTER TABLE account_activities DROP CONSTRAINT IF EXISTS account_activities_type_check;
ALTER TABLE account_activities ADD CONSTRAINT account_activities_type_check
  CHECK (type IN ('NOTE', 'EMAIL', 'CALL', 'PPT', 'PROPOSAL', 'MEETING', 'DEMO',
                  'IN_PERSON', 'SUMMARY', 'STAGE_CHANGE', 'CONVERTED',
                  'TASK_DONE', 'ORDER', 'INVOICE', 'PAYMENT', 'HANDOVER', 'NEXT_ACTION'));

-- Where an entry came from. Blank on every existing row: nobody recorded it at
-- the time, and it is not inferred now.
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS source TEXT
  CHECK (source IN ('MANUAL', 'TASK', 'MEETING', 'SYSTEM', 'EMAIL_IMPORT', 'CALENDAR_IMPORT'));

-- the per-deal timeline lookups the board now makes
CREATE INDEX IF NOT EXISTS account_activities_opportunity_idx
  ON account_activities (opportunity_id, occurred_at DESC);

-- ---------------------------------------------------------------- task outcomes

-- What a finished task actually achieved. Blank on every existing task — the
-- completion note written at the time is kept exactly as it was.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS outcome_status TEXT
  CHECK (outcome_status IN ('ACHIEVED', 'NOT_ACHIEVED'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS outcome_evidence_url TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS outcome_next_step TEXT;
-- set when the person confirmed the task was done although the outcome reads
-- like a plan ("will send samples"), so the claim is theirs and visible
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS outcome_intent_confirmed BOOLEAN;

-- ---------------------------------------------------------------- stage evidence

-- What a stage needs to see before a deal comes in, and before it goes on.
-- Rules are short names the server knows how to check (see dealRules.js).
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS entry_rules TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS exit_rules TEXT[] NOT NULL DEFAULT '{}';

-- The two the business asked for, and one that follows from them. Applied only
-- to the standard stages, and only where nobody has set rules yet; an admin can
-- change all of them in Settings. They apply to moves from now on and never
-- move or relabel a deal that is already where it is.
UPDATE account_stages SET entry_rules = ARRAY['proposal']
 WHERE slug IN ('proposal', 'negotiation') AND entry_rules = '{}';
UPDATE account_stages SET entry_rules = ARRAY['order']
 WHERE kind = 'won' AND entry_rules = '{}';
UPDATE account_stages SET exit_rules = ARRAY['meeting_completed']
 WHERE slug = 'meeting-demo' AND exit_rules = '{}';

-- Which evidence was missing when a manager moved a deal anyway, so an
-- exception is visible later rather than looking like any other move.
ALTER TABLE opportunity_history ADD COLUMN IF NOT EXISTS evidence_missing TEXT[];

-- ---------------------------------------------------------------- the commercial record

-- Four kinds of commercial fact, kept apart because they are different claims:
-- a proposal is an offer, an order is a commitment (a booking), an invoice is
-- revenue billed, and a payment is cash received. Amounts that are not known
-- stay blank. Nothing here is ever removed: a mistake is cancelled or voided
-- with a reason, and the original stays on the record.

CREATE TABLE IF NOT EXISTS opportunity_proposals (
  id             SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  title          TEXT,
  sent_on        DATE NOT NULL,
  amount         NUMERIC(16, 2) CHECK (amount IS NULL OR amount >= 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  valid_until    DATE,
  link           TEXT,
  status         TEXT NOT NULL DEFAULT 'SENT'
                 CHECK (status IN ('SENT', 'ACCEPTED', 'DECLINED', 'SUPERSEDED', 'WITHDRAWN')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_proposals_idx ON opportunity_proposals (opportunity_id, sent_on DESC);

CREATE TABLE IF NOT EXISTS opportunity_orders (
  id             SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'PURCHASE_ORDER'
                 CHECK (kind IN ('PURCHASE_ORDER', 'CONTRACT', 'WORK_ORDER', 'MOU', 'OTHER')),
  -- the PO or contract number
  reference      TEXT,
  received_on    DATE NOT NULL,
  amount         NUMERIC(16, 2) CHECK (amount IS NULL OR amount >= 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  link           TEXT,
  status         TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED', 'CANCELLED')),
  cancel_reason  TEXT,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_orders_idx ON opportunity_orders (opportunity_id, received_on DESC);

CREATE TABLE IF NOT EXISTS opportunity_invoices (
  id             SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  order_id       INTEGER REFERENCES opportunity_orders(id) ON DELETE SET NULL,
  number         TEXT,
  issued_on      DATE NOT NULL,
  amount         NUMERIC(16, 2) NOT NULL CHECK (amount >= 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  due_on         DATE,
  link           TEXT,
  status         TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'CANCELLED')),
  cancel_reason  TEXT,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_invoices_idx ON opportunity_invoices (opportunity_id, issued_on DESC);

CREATE TABLE IF NOT EXISTS opportunity_payments (
  id             SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  invoice_id     INTEGER REFERENCES opportunity_invoices(id) ON DELETE SET NULL,
  received_on    DATE NOT NULL,
  amount         NUMERIC(16, 2) NOT NULL CHECK (amount > 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  -- the bank reference (UTR, cheque number)
  reference      TEXT,
  link           TEXT,
  notes          TEXT,
  is_void        BOOLEAN NOT NULL DEFAULT FALSE,
  void_reason    TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_payments_idx ON opportunity_payments (opportunity_id, received_on DESC);
