-- B2B CRM: organizations, opportunities, stakeholders, delivery.
--
-- The shape this replaces: one `accounts` row carried the organization AND the
-- deal — its stage, its value, its outcome. That works until a partner has two
-- deals, at which point winning one closes the relationship and the second has
-- nowhere to live.
--
-- So: an account becomes the ORGANIZATION, and an OPPORTUNITY becomes the deal.
-- Every existing account is backfilled with exactly one opportunity carrying its
-- current stage, value, status and next step, so no lead, history or task link
-- changes hands.
--
-- accounts.stage_id / value / status are KEPT and kept in sync with the primary
-- opportunity, so every query, board and nudge that reads them today keeps
-- working untouched. They are a mirror now, not the truth.
--
-- Additive throughout: new tables, new nullable-or-defaulted columns, and
-- position renumbering on a lookup table. Nothing is dropped, renamed or
-- rewritten.

-- ------------------------------------------------- stages the pipeline needs

-- Existing stages keep their ids, slugs and names — only their order shifts to
-- make room. Any account already sitting in one is unaffected.
UPDATE account_stages SET position = 7 WHERE slug = 'proposal';
UPDATE account_stages SET position = 8 WHERE slug = 'negotiation';
UPDATE account_stages SET position = 9 WHERE slug = 'won';
UPDATE account_stages SET position = 10 WHERE slug = 'lost';

INSERT INTO account_stages (name, slug, kind, color, position, is_default) VALUES
  ('Discovery & Requirements', 'discovery',       'open', '#0ea5e9', 4, FALSE),
  ('Meeting / Demo',           'meeting-demo',    'open', '#14b8a6', 5, FALSE),
  ('Scope Alignment',          'scope-alignment', 'open', '#6366f1', 6, FALSE)
ON CONFLICT (slug) DO NOTHING;

-- What a stage expects before an opportunity may leave it. Advisory by default:
-- the UI shows what is missing rather than refusing the move.
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS entry_expectations TEXT;
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS requires_contact BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS requires_next_action BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS requires_value BOOLEAN NOT NULL DEFAULT FALSE;
-- the default probability used for the weighted forecast, as a percentage
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS default_probability INTEGER;

UPDATE account_stages SET default_probability = CASE slug
  WHEN 'new' THEN 5 WHEN 'contacted' THEN 10 WHEN 'qualified' THEN 20
  WHEN 'discovery' THEN 30 WHEN 'meeting-demo' THEN 45 WHEN 'scope-alignment' THEN 60
  WHEN 'proposal' THEN 70 WHEN 'negotiation' THEN 85
  WHEN 'won' THEN 100 WHEN 'lost' THEN 0 ELSE default_probability END
WHERE default_probability IS NULL;

UPDATE account_stages SET requires_contact = TRUE, requires_next_action = TRUE
 WHERE slug IN ('discovery', 'meeting-demo', 'scope-alignment', 'proposal', 'negotiation');
UPDATE account_stages SET requires_value = TRUE WHERE slug IN ('proposal', 'negotiation');

-- ------------------------------------------------- the organization

-- Segments are configurable rather than a hard-coded sales model: a CSR team,
-- an input manufacturer and an NGO are not worked the same way.
CREATE TABLE crm_segments (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  color       TEXT,
  -- which scope fields matter for this kind of partner; suggestions, not rules
  scope_template JSONB NOT NULL DEFAULT '[]'::jsonb,
  position    INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO crm_segments (name, slug, color, position) VALUES
  ('CSR team',                  'csr',           '#8b5cf6', 1),
  ('Foundation',                'foundation',    '#6366f1', 2),
  ('NGO',                       'ngo',           '#14b8a6', 3),
  ('Input manufacturer',        'input-mfr',     '#eb6834', 4),
  ('Agri-tech company',         'agritech',      '#2a78d6', 5),
  ('Agri enterprise',           'agri-business', '#0ca30c', 6),
  ('Government / institution',  'institution',   '#f59e0b', 7),
  ('Other',                     'other',         '#64748b', 8)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS segment_id INTEGER REFERENCES crm_segments(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banner_url TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS hq_address TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS operating_regions TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS crops TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS relationship_summary TEXT;
-- why this relationship matters to us, in plain words
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS why_it_matters TEXT;
-- the enduring, organization-level estimate. NOT a forecastable number.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS relationship_potential NUMERIC(16, 2);
-- the opportunity the board and the mirror columns follow
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS primary_opportunity_id INTEGER;
-- the last time somebody actually spoke to THEM. Editing a banner or finishing
-- an internal task must not reset the follow-up clock, so this is kept apart
-- from last_activity_at, which moves on any recorded event.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_external_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS accounts_segment_idx ON accounts (segment_id);

-- ------------------------------------------------- stakeholders

CREATE TABLE account_contacts (
  id                SERIAL PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  full_name         TEXT NOT NULL,
  designation       TEXT,
  department        TEXT,
  email             TEXT,
  phone             TEXT,
  whatsapp          TEXT,
  linkedin_url      TEXT,
  other_link        TEXT,
  photo_url         TEXT,
  location          TEXT,
  -- how they prefer to be reached, so nobody emails someone who only answers WhatsApp
  preferred_channel TEXT CHECK (preferred_channel IN
                      ('EMAIL', 'PHONE', 'WHATSAPP', 'LINKEDIN', 'IN_PERSON')),
  -- a person's read on the relationship, entered by hand and labelled as such —
  -- never inferred from message counts
  influence         TEXT CHECK (influence IN ('LOW', 'MEDIUM', 'HIGH')),
  notes             TEXT,
  is_primary        BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_contacts_account_idx ON account_contacts (account_id, is_active);

-- ------------------------------------------------- the deal

CREATE TABLE opportunities (
  id                SERIAL PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  -- an unpaid pilot, a partnership and signed commercial work are not the same
  -- money, so they are not the same kind of agreement
  engagement_model  TEXT NOT NULL DEFAULT 'COMMERCIAL'
                    CHECK (engagement_model IN ('PAID_PILOT', 'UNPAID_PILOT', 'DEVICE_PURCHASE',
                                                'TESTING_CONTRACT', 'CLINIC_PARTNERSHIP',
                                                'INSTITUTIONAL_PROJECT', 'CSR_PROJECT',
                                                'PARTNERSHIP', 'COMMERCIAL', 'OTHER')),
  stage_id          INTEGER REFERENCES account_stages(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'WON', 'LOST', 'ON_HOLD', 'NURTURE')),

  owner_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- Five separate amounts, never added together and never defaulted to zero.
  -- A blank one means "not known", which is not the same as nothing.
  estimated_value   NUMERIC(16, 2),   -- our guess, early
  proposed_value    NUMERIC(16, 2),   -- what we put in front of them
  agreed_value      NUMERIC(16, 2),   -- what they signed
  collected_value   NUMERIC(16, 2),   -- what actually arrived
  currency          TEXT NOT NULL DEFAULT 'INR',
  value_basis       TEXT,             -- "per device", "per season", "total contract"
  value_period      TEXT,             -- "one-off", "annual", "per season"
  value_unknown     BOOLEAN NOT NULL DEFAULT FALSE,

  -- a disclosed estimate, not a prediction. NULL falls back to the stage default.
  probability       INTEGER CHECK (probability BETWEEN 0 AND 100),
  probability_reason TEXT,

  expected_close    DATE,
  -- so a slipping close date is visible rather than quietly rewritten
  original_close    DATE,
  close_date_changes INTEGER NOT NULL DEFAULT 0,

  -- what must be true to win, in the partner's words
  problem           TEXT,
  desired_outcome   TEXT,
  decision_process  TEXT,
  approval_dependency TEXT,
  objections        TEXT,
  win_criteria      TEXT,
  scope_summary     TEXT,
  -- segment-shaped scope: crops, geography, farmer counts, testing volumes…
  scope             JSONB NOT NULL DEFAULT '{}'::jsonb,

  next_step         TEXT,
  next_step_due     DATE,
  next_step_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,

  -- settlement
  outcome_reason    TEXT,
  revisit_on        DATE,
  agreement_type    TEXT,
  agreement_date    DATE,
  agreement_link    TEXT,
  financial_status  TEXT CHECK (financial_status IN
                      ('NOT_APPLICABLE', 'UNPAID', 'INVOICED', 'PART_PAID', 'PAID')),

  stage_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_external_at  TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  is_archived       BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX opportunities_account_idx ON opportunities (account_id) WHERE is_archived = FALSE;
CREATE INDEX opportunities_stage_idx   ON opportunities (stage_id)   WHERE is_archived = FALSE;
CREATE INDEX opportunities_owner_idx   ON opportunities (owner_user_id);
CREATE INDEX opportunities_close_idx   ON opportunities (expected_close) WHERE is_archived = FALSE;

-- the same person can be the champion on one deal and the blocker on another
CREATE TABLE opportunity_contacts (
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  contact_id      INTEGER NOT NULL REFERENCES account_contacts(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'STAKEHOLDER'
                  CHECK (role IN ('PRIMARY', 'DECISION_MAKER', 'CHAMPION', 'TECHNICAL_EVALUATOR',
                                  'PROCUREMENT', 'FINANCE', 'APPROVER', 'STAKEHOLDER', 'BLOCKER')),
  involvement     TEXT CHECK (involvement IN ('LOW', 'MEDIUM', 'HIGH')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, contact_id, role)
);

-- "what must happen to win", one row per thing
CREATE TABLE opportunity_requirements (
  id              SERIAL PRIMARY KEY,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  category        TEXT NOT NULL DEFAULT 'OTHER'
                  CHECK (category IN ('COMMERCIAL', 'TECHNICAL', 'VALIDATION', 'LEGAL',
                                      'OPERATIONAL', 'APPROVAL', 'DATA', 'OTHER')),
  description     TEXT NOT NULL,
  importance      TEXT NOT NULL DEFAULT 'SHOULD_HAVE'
                  CHECK (importance IN ('MUST_HAVE', 'SHOULD_HAVE', 'NICE_TO_HAVE')),
  status          TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'MET', 'BLOCKED', 'WAIVED')),
  owner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date        DATE,
  evidence_url    TEXT,
  task_id         INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_requirements_opp_idx ON opportunity_requirements (opportunity_id, status);

-- ------------------------------------------------- after the win

CREATE TABLE engagements (
  id              SERIAL PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- the deal it came from. Its value is NOT copied here: one agreed amount,
  -- recorded once, on the opportunity.
  opportunity_id  INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'PLANNING'
                  CHECK (state IN ('PLANNING', 'ONBOARDING', 'ACTIVE', 'AT_RISK',
                                   'COMPLETED', 'ON_HOLD')),
  agreed_scope    TEXT,
  commitments     TEXT,
  owner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kickoff_on      DATE,
  review_cadence  TEXT,
  next_review_on  DATE,
  blockers        TEXT,
  partner_feedback TEXT,
  is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX engagements_account_idx ON engagements (account_id) WHERE is_archived = FALSE;
-- one engagement per opportunity, so a repeated "create the engagement" is a no-op
CREATE UNIQUE INDEX engagements_opportunity_idx ON engagements (opportunity_id)
  WHERE opportunity_id IS NOT NULL;

CREATE TABLE engagement_milestones (
  id              SERIAL PRIMARY KEY,
  engagement_id   INTEGER NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'PLANNED'
                  CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'DELIVERED', 'ACCEPTED', 'BLOCKED')),
  accepted_at     TIMESTAMPTZ,
  accepted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  task_id         INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX engagement_milestones_idx ON engagement_milestones (engagement_id, status);

-- ------------------------------------------------- meetings and demos

CREATE TABLE crm_meetings (
  id              SERIAL PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  opportunity_id  INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'MEETING'
                  CHECK (kind IN ('MEETING', 'DEMO', 'SITE_VISIT', 'WORKSHOP', 'REVIEW')),
  mode            TEXT NOT NULL DEFAULT 'VIRTUAL' CHECK (mode IN ('VIRTUAL', 'IN_PERSON')),
  title           TEXT NOT NULL,
  objective       TEXT,
  agenda          TEXT,
  -- stored as an instant; the timezone is what it should be shown in
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_min    INTEGER,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  location        TEXT,
  meeting_url     TEXT,

  -- a scheduled demo is not a completed demo, and the difference is the whole
  -- point of tracking them
  status          TEXT NOT NULL DEFAULT 'SCHEDULED'
                  CHECK (status IN ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED')),
  completed_at    TIMESTAMPTZ,

  demo_type       TEXT,
  products        TEXT[] NOT NULL DEFAULT '{}',
  prerequisites   TEXT,
  material_checklist TEXT,
  outcome         TEXT,
  questions_raised TEXT,
  objections_raised TEXT,
  validations_requested TEXT,
  next_decision   TEXT,

  owner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_meetings_account_idx ON crm_meetings (account_id, scheduled_at DESC);
CREATE INDEX crm_meetings_status_idx  ON crm_meetings (status, scheduled_at);

CREATE TABLE crm_meeting_participants (
  meeting_id  INTEGER NOT NULL REFERENCES crm_meetings(id) ON DELETE CASCADE,
  -- exactly one of these two: an internal colleague or an external contact
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  contact_id  INTEGER REFERENCES account_contacts(id) ON DELETE CASCADE,
  attended    BOOLEAN,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (contact_id IS NULL))
);
CREATE UNIQUE INDEX crm_meeting_user_idx    ON crm_meeting_participants (meeting_id, user_id)    WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX crm_meeting_contact_idx ON crm_meeting_participants (meeting_id, contact_id) WHERE contact_id IS NOT NULL;

-- ------------------------------------------------- the link library

CREATE TABLE crm_resource_folders (
  id          SERIAL PRIMARY KEY,
  -- NULL account_id means the global shared library
  account_id  INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_resource_folders_account_idx ON crm_resource_folders (account_id, position);

-- the suggested shape of a library, created once for the global one
INSERT INTO crm_resource_folders (account_id, name, position) VALUES
  (NULL, 'Pitch & Introduction', 1),
  (NULL, 'Proposals & Offers',   2),
  (NULL, 'Requirements',         3),
  (NULL, 'Validation & Evidence',4),
  (NULL, 'Demos & Videos',       5),
  (NULL, 'Agreements',           6),
  (NULL, 'Delivery',             7);

-- A resource is a LINK to something that lives elsewhere — a Doc, a Drive file,
-- a Canva deck. Its contents are never downloaded, copied or crawled.
CREATE TABLE crm_resources (
  id              SERIAL PRIMARY KEY,
  account_id      INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  opportunity_id  INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  engagement_id   INTEGER REFERENCES engagements(id) ON DELETE SET NULL,
  folder_id       INTEGER REFERENCES crm_resource_folders(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  url             TEXT,
  -- for the rare small file that genuinely belongs here; uses the existing
  -- upload mechanism, never base64 in a column
  attachment_id   INTEGER REFERENCES task_attachments(id) ON DELETE SET NULL,
  category        TEXT,
  description     TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  version_label   TEXT,
  status          TEXT NOT NULL DEFAULT 'CURRENT'
                  CHECK (status IN ('DRAFT', 'CURRENT', 'SUPERSEDED', 'ARCHIVED')),
  is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  -- restricted resources stay out of the general library listing
  is_restricted   BOOLEAN NOT NULL DEFAULT FALSE,
  owner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR attachment_id IS NOT NULL)
);
CREATE INDEX crm_resources_account_idx ON crm_resources (account_id, folder_id);
CREATE INDEX crm_resources_global_idx  ON crm_resources (folder_id) WHERE account_id IS NULL;

-- A global resource referenced by a lead. A reference, not a copy: deleting it
-- removes the pointer and leaves the original library entry alone.
CREATE TABLE crm_resource_references (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  resource_id   INTEGER NOT NULL REFERENCES crm_resources(id) ON DELETE CASCADE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  note          TEXT,
  added_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, resource_id)
);

-- Saving a link is not sending it. This records what was actually shared, with
-- whom, through which channel — a claim a person makes, not one TaskFlow infers.
CREATE TABLE crm_resource_shares (
  id            SERIAL PRIMARY KEY,
  resource_id   INTEGER NOT NULL REFERENCES crm_resources(id) ON DELETE CASCADE,
  account_id    INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  contact_id    INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  channel       TEXT CHECK (channel IN ('EMAIL', 'WHATSAPP', 'LINKEDIN', 'IN_PERSON', 'CALL', 'OTHER')),
  version_label TEXT,
  purpose       TEXT,
  shared_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_resource_shares_account_idx ON crm_resource_shares (account_id, shared_at DESC);

-- ------------------------------------------------- the map

CREATE TABLE account_locations (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label         TEXT,
  kind          TEXT NOT NULL DEFAULT 'OPERATING'
                CHECK (kind IN ('HQ', 'OPERATING', 'SITE')),
  address       TEXT,
  city          TEXT,
  state         TEXT,
  country       TEXT NOT NULL DEFAULT 'India',
  latitude      NUMERIC(9, 6),
  longitude     NUMERIC(9, 6),
  -- an entered pin and a precise one are not the same claim, and the map says which
  precision     TEXT NOT NULL DEFAULT 'APPROXIMATE'
                CHECK (precision IN ('EXACT', 'APPROXIMATE', 'REGION')),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_locations_account_idx ON account_locations (account_id);

-- ------------------------------------------------- history that must survive

-- Reassigning a lead must not rewrite who did the work last quarter.
CREATE TABLE crm_ownership_history (
  id            SERIAL PRIMARY KEY,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('ACCOUNT', 'OPPORTUNITY', 'ENGAGEMENT')),
  entity_id     INTEGER NOT NULL,
  from_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT,
  changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crm_ownership_history_idx ON crm_ownership_history (entity_type, entity_id, changed_at DESC);

CREATE TABLE opportunity_history (
  id              SERIAL PRIMARY KEY,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  field           TEXT NOT NULL,
  from_value      TEXT,
  to_value        TEXT,
  -- a move backwards down the pipeline is worth being able to find
  is_reversal     BOOLEAN NOT NULL DEFAULT FALSE,
  reason          TEXT,
  actor_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_history_idx ON opportunity_history (opportunity_id, created_at DESC);

-- ------------------------------------------------- the timeline, enriched

ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS engagement_id INTEGER REFERENCES engagements(id) ON DELETE SET NULL;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS meeting_id INTEGER REFERENCES crm_meetings(id) ON DELETE SET NULL;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS direction TEXT
  CHECK (direction IN ('OUTBOUND', 'INBOUND'));

-- The distinction the whole engagement record hangs on: an attempted call and a
-- completed conversation are different facts, and only one of them is evidence.
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS outcome TEXT
  CHECK (outcome IN ('ATTEMPTED', 'COMPLETED', 'SENT', 'RECEIVED',
                     'SCHEDULED', 'CANCELLED', 'NO_SHOW', 'NOTED'));

-- whether this counts as having actually engaged them. An internal note or a
-- stage change does not.
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS external_participants TEXT;

CREATE INDEX IF NOT EXISTS account_activities_external_idx
  ON account_activities (account_id, occurred_at DESC) WHERE is_external = TRUE;

-- existing rows: the touch types were genuinely external; the bookkeeping ones were not
UPDATE account_activities
   SET is_external = TRUE,
       outcome = CASE
         WHEN type IN ('EMAIL', 'PPT', 'PROPOSAL') THEN 'SENT'
         WHEN type IN ('CALL', 'MEETING', 'DEMO', 'IN_PERSON') THEN 'COMPLETED'
         ELSE 'NOTED' END
 WHERE type IN ('EMAIL', 'CALL', 'PPT', 'PROPOSAL', 'MEETING', 'DEMO', 'IN_PERSON')
   AND outcome IS NULL;

UPDATE account_activities SET outcome = 'NOTED'
 WHERE outcome IS NULL;

-- ------------------------------------------------- task links

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS engagement_id INTEGER REFERENCES engagements(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS meeting_id INTEGER REFERENCES crm_meetings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_opportunity_idx ON tasks (opportunity_id);
CREATE INDEX IF NOT EXISTS tasks_engagement_idx  ON tasks (engagement_id);
-- a meeting's preparation tasks are created once; rescheduling reuses them
CREATE INDEX IF NOT EXISTS tasks_meeting_idx     ON tasks (meeting_id);

-- ------------------------------------------------- backfill
--
-- Every existing account gets exactly one opportunity carrying the deal it was
-- already holding. Ids, names, owners, tasks and activity links are untouched;
-- the lead simply gains a place to put a second deal later.

INSERT INTO opportunities
  (account_id, name, stage_id, status, owner_user_id, estimated_value, currency,
   next_step, next_step_due, stage_changed_at, created_by, created_at, updated_at)
SELECT a.id,
       a.name,
       a.stage_id,
       -- the account's own status carries across verbatim
       CASE a.status WHEN 'WON' THEN 'WON' WHEN 'LOST' THEN 'LOST'
                     WHEN 'ON_HOLD' THEN 'ON_HOLD' ELSE 'ACTIVE' END,
       a.owner_user_id,
       a.value,
       COALESCE(a.currency, 'INR'),
       a.next_step,
       a.next_step_due,
       a.stage_changed_at,
       a.created_by,
       a.created_at,
       a.updated_at
  FROM accounts a
 WHERE NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.account_id = a.id);

-- point each account at the opportunity that now carries its deal
UPDATE accounts a
   SET primary_opportunity_id = o.id
  FROM opportunities o
 WHERE o.account_id = a.id AND a.primary_opportunity_id IS NULL;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_primary_opportunity_fk
  FOREIGN KEY (primary_opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL;

-- the existing single contact becomes the first stakeholder, so nobody loses a
-- phone number they had before the upgrade
INSERT INTO account_contacts (account_id, full_name, email, phone, is_primary, created_at)
SELECT a.id,
       COALESCE(NULLIF(TRIM(a.contact_name), ''), 'Primary contact'),
       NULLIF(TRIM(a.contact_email), ''),
       NULLIF(TRIM(a.contact_phone), ''),
       TRUE,
       a.created_at
  FROM accounts a
 WHERE (COALESCE(TRIM(a.contact_name), '') <> ''
     OR COALESCE(TRIM(a.contact_email), '') <> ''
     OR COALESCE(TRIM(a.contact_phone), '') <> '')
   AND NOT EXISTS (SELECT 1 FROM account_contacts c WHERE c.account_id = a.id);

-- existing activities belong to the deal that was in flight when they happened
UPDATE account_activities act
   SET opportunity_id = a.primary_opportunity_id
  FROM accounts a
 WHERE act.account_id = a.id AND act.opportunity_id IS NULL;

UPDATE tasks t
   SET opportunity_id = a.primary_opportunity_id
  FROM accounts a
 WHERE t.account_id = a.id AND t.opportunity_id IS NULL;

-- the external clock starts from the last touch that was genuinely external
UPDATE accounts a
   SET last_external_at = x.last_at
  FROM (SELECT account_id, MAX(occurred_at) AS last_at
          FROM account_activities WHERE is_external = TRUE GROUP BY account_id) x
 WHERE x.account_id = a.id AND a.last_external_at IS NULL;

UPDATE opportunities o
   SET last_external_at = a.last_external_at
  FROM accounts a
 WHERE a.id = o.account_id AND o.last_external_at IS NULL;
