-- 027: the sales CRM — inbound leads and the Taskflow / TeleCRM boundary,
-- assignment, scoring, sources and campaigns, a second (CSR / NGO) pipeline,
-- organization roles, catalogue, quotations and approvals, payment schedules,
-- calls and WhatsApp, automation, imports, targets and merges.
--
-- Additive throughout. Existing rows keep their ids, owners, stages, values and
-- history. Nothing is reclassified: every existing organization is marked as
-- legacy, awaiting an administrator's confirmation of its category, with a
-- suggestion stored beside it; confirming is a separate, recorded act.

-- ================================================================ counters

CREATE TABLE IF NOT EXISTS crm_counters (
  key    TEXT PRIMARY KEY,
  value  BIGINT NOT NULL DEFAULT 0
);

-- ================================================================ pipelines

CREATE TABLE IF NOT EXISTS crm_pipelines (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('B2B_CORPORATE', 'CSR_NGO')),
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO crm_pipelines (key, name, category, description, position, is_default) VALUES
  ('b2b', 'B2B Corporate', 'B2B_CORPORATE', 'Product and service sales to companies and institutions', 1, TRUE),
  ('csr', 'CSR / NGO', 'CSR_NGO', 'CSR funding, foundation grants and NGO purchases or partnerships', 2, FALSE)
ON CONFLICT (key) DO NOTHING;

-- every existing stage belongs to the B2B pipeline; ids, slugs and names stay
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS pipeline_id INTEGER REFERENCES crm_pipelines(id) ON DELETE SET NULL;
UPDATE account_stages SET pipeline_id = (SELECT id FROM crm_pipelines WHERE key = 'b2b') WHERE pipeline_id IS NULL;
CREATE INDEX IF NOT EXISTS account_stages_pipeline_idx ON account_stages (pipeline_id, position);

-- what a stage asks of a deal entering it, which stages it may move to (NULL:
-- any), how long it may sit before it is called stale, whether entering it
-- needs an approved quotation or proposal, and whether it counts in forecasts
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS required_fields TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS allowed_to INTEGER[];
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS aging_days INTEGER CHECK (aging_days IS NULL OR aging_days > 0);
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS approval_gate BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS counts_in_forecast BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE account_stages ADD COLUMN IF NOT EXISTS retired_into INTEGER REFERENCES account_stages(id) ON DELETE SET NULL;

-- one new B2B stage before Won, for approvals and contracting. Won and Lost
-- keep their ids and slugs; only their place in the order moves.
UPDATE account_stages SET position = 10 WHERE slug = 'won' AND position = 9;
UPDATE account_stages SET position = 11 WHERE slug = 'lost' AND position = 10;
INSERT INTO account_stages (name, slug, kind, color, position, is_default, default_probability, pipeline_id, requires_contact, requires_next_action, approval_gate)
SELECT 'Approval / Contracting', 'approval-contracting', 'open', '#0f766e', 9, FALSE, 90, p.id, TRUE, TRUE, FALSE
  FROM crm_pipelines p WHERE p.key = 'b2b'
ON CONFLICT (slug) DO NOTHING;

-- the CSR / NGO pipeline, editable like any other
INSERT INTO account_stages (name, slug, kind, color, position, is_default, default_probability, pipeline_id, requires_contact, requires_next_action)
SELECT s.name, s.slug, s.kind, s.color, s.position, FALSE, s.prob, p.id, s.contact, s.nextaction
  FROM crm_pipelines p,
       (VALUES ('New Enquiry',          'csr-new',       'open', '#64748b', 101, 5,   FALSE, FALSE),
               ('Fit Assessment',       'csr-fit',       'open', '#0ea5e9', 102, 15,  TRUE,  TRUE),
               ('Concept / Proposal',   'csr-concept',   'open', '#6366f1', 103, 35,  TRUE,  TRUE),
               ('Review',               'csr-review',    'open', '#8b5cf6', 104, 50,  TRUE,  TRUE),
               ('Budget Discussion',    'csr-budget',    'open', '#f59e0b', 105, 65,  TRUE,  TRUE),
               ('Agreement / Approval', 'csr-agreement', 'open', '#0f766e', 106, 85,  TRUE,  TRUE),
               ('Won / Committed',      'csr-won',       'won',  '#0ca30c', 107, 100, FALSE, FALSE),
               ('Lost',                 'csr-lost',      'lost', '#d03b3b', 108, 0,   FALSE, FALSE))
         AS s(name, slug, kind, color, position, prob, contact, nextaction)
 WHERE p.key = 'csr'
ON CONFLICT (slug) DO NOTHING;

UPDATE account_stages SET entry_rules = ARRAY['proposal']
 WHERE slug IN ('csr-review', 'csr-budget') AND entry_rules = '{}';
-- a funding commitment is won on a signed agreement or MoU, as a sale is on an order
UPDATE account_stages SET entry_rules = ARRAY['order']
 WHERE slug = 'csr-won' AND entry_rules = '{}';

-- ================================================================ sources, campaigns, capture

CREATE TABLE IF NOT EXISTS crm_sources (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'OTHER'
              CHECK (channel IN ('WEBSITE', 'ADS', 'SOCIAL', 'REFERRAL', 'EVENT', 'EMAIL', 'PHONE',
                                 'WHATSAPP', 'PARTNER', 'MARKETPLACE', 'DIRECT', 'OTHER')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO crm_sources (key, name, channel, position) VALUES
  ('website',      'Website enquiry',    'WEBSITE',  1),
  ('google-ads',   'Google Ads',         'ADS',      2),
  ('meta-ads',     'Facebook / Instagram ads', 'ADS', 3),
  ('linkedin',     'LinkedIn',           'SOCIAL',   4),
  ('referral',     'Referral',           'REFERRAL', 5),
  ('event',        'Event or exhibition','EVENT',    6),
  ('inbound-call', 'Inbound call',       'PHONE',    7),
  ('inbound-email','Inbound email',      'EMAIL',    8),
  ('whatsapp',     'WhatsApp',           'WHATSAPP', 9),
  ('partner',      'Partner',            'PARTNER',  10),
  ('outbound',     'Our own outreach',   'DIRECT',   11),
  ('other',        'Other',              'OTHER',    12)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS crm_campaigns (
  id             SERIAL PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  channel        TEXT,
  source_id      INTEGER REFERENCES crm_sources(id) ON DELETE SET NULL,
  utm_campaign   TEXT,
  starts_on      DATE,
  ends_on        DATE,
  -- optional; never added to revenue and never mixed across currencies
  spend          NUMERIC(16, 2) CHECK (spend IS NULL OR spend >= 0),
  spend_currency TEXT NOT NULL DEFAULT 'INR',
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PLANNED', 'ACTIVE', 'ENDED')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_campaigns_utm_idx ON crm_campaigns (lower(utm_campaign));

-- keys for websites, ad platforms and other systems that post leads. Only a
-- hash is stored; the key itself is shown once, when it is created.
CREATE TABLE IF NOT EXISTS crm_capture_keys (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  prefix           TEXT NOT NULL,
  key_hash         TEXT NOT NULL UNIQUE,
  source_id        INTEGER REFERENCES crm_sources(id) ON DELETE SET NULL,
  campaign_id      INTEGER REFERENCES crm_campaigns(id) ON DELETE SET NULL,
  entry_channel    TEXT NOT NULL DEFAULT 'API' CHECK (entry_channel IN ('API', 'WEBHOOK')),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at     TIMESTAMPTZ,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMPTZ,
  revoked_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS crm_capture_forms (
  id               SERIAL PRIMARY KEY,
  public_id        TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  title            TEXT NOT NULL,
  intro            TEXT,
  -- which optional fields the form shows; organization, name, email/phone and
  -- the "who are you" question are always there
  fields           JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_id        INTEGER REFERENCES crm_sources(id) ON DELETE SET NULL,
  campaign_id      INTEGER REFERENCES crm_campaigns(id) ON DELETE SET NULL,
  consent_text     TEXT,
  success_message  TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  submissions      INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ================================================================ the boundary on organizations

-- Eligible in TaskFlow: B2B_CORPORATE, CSR_NGO. TeleCRM's: RETAILER, FPO,
-- INDIVIDUAL. UNCLASSIFIED waits in a restricted queue. NULL on an existing
-- organization means "legacy, not yet confirmed" — see routing_status.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lead_category TEXT
  CHECK (lead_category IN ('B2B_CORPORATE', 'CSR_NGO', 'RETAILER', 'FPO', 'INDIVIDUAL', 'UNCLASSIFIED'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS routing_status TEXT
  CHECK (routing_status IN ('ACTIVE', 'LEGACY_UNCONFIRMED', 'NEEDS_CLASSIFICATION', 'EXCLUDED'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS category_source TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS category_set_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS category_set_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- a suggestion for the administrator, never applied by itself
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suggested_category TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suggestion_reason TEXT;

-- what kind of organization it is, and the roles it plays for us; both are
-- independent of any pipeline
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS org_type TEXT
  CHECK (org_type IN ('COMPANY', 'CSR_FOUNDATION', 'NGO', 'GOVERNMENT', 'ACADEMIC', 'FPO', 'RETAILER', 'INDIVIDUAL', 'OTHER'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS org_roles TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pincode TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS domain TEXT;
-- registration / tax identifiers (CIN, GSTIN, PAN, CSR-1, NGO Darpan…): shown
-- only to people allowed to see them
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS registration_ids JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS original_source_id INTEGER REFERENCES crm_sources(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS original_campaign_id INTEGER REFERENCES crm_campaigns(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE INDEX IF NOT EXISTS accounts_category_idx ON accounts (lead_category, routing_status);
CREATE INDEX IF NOT EXISTS accounts_domain_idx ON accounts (lower(domain)) WHERE domain IS NOT NULL;

-- Existing organizations: legacy, awaiting confirmation. The website domain is
-- copied in its plain form (a copy, not an interpretation) to support duplicate
-- checks.
UPDATE accounts SET routing_status = 'LEGACY_UNCONFIRMED', category_source = 'LEGACY'
 WHERE routing_status IS NULL AND lead_category IS NULL;

UPDATE accounts
   SET domain = lower(regexp_replace(regexp_replace(website, '^[a-zA-Z]+://', ''), '^www\.|[/?#].*$', '', 'g'))
 WHERE domain IS NULL AND website IS NOT NULL AND website ~ '\.';

-- suggestions for the remediation queue: name patterns first, then segment
UPDATE accounts a
   SET suggested_category = s.cat, suggestion_reason = s.why
  FROM (
    SELECT acc.id,
           CASE
             WHEN acc.name ~* '(\mfpo\M|\mfpc\M|farmer[s'']? producer|producer company|producer organi[sz]ation)' THEN 'FPO'
             WHEN acc.name ~* '(\mretail|\mtraders?\M|agro (centre|center|agency|agencies|kendra|store|services)|krishi kendra|seeds? (and|&) fertili[sz]ers?|fertili[sz]er (shop|store|depot)|\mdealers?\M)' THEN 'RETAILER'
             WHEN seg.slug IN ('csr', 'foundation', 'ngo') THEN 'CSR_NGO'
             ELSE 'B2B_CORPORATE'
           END AS cat,
           CASE
             WHEN acc.name ~* '(\mfpo\M|\mfpc\M|farmer[s'']? producer|producer company|producer organi[sz]ation)' THEN 'The name reads like a farmer producer organization'
             WHEN acc.name ~* '(\mretail|\mtraders?\M|agro (centre|center|agency|agencies|kendra|store|services)|krishi kendra|seeds? (and|&) fertili[sz]ers?|fertili[sz]er (shop|store|depot)|\mdealers?\M)' THEN 'The name reads like a retailer or dealer'
             WHEN seg.slug IN ('csr', 'foundation', 'ngo') THEN 'Its segment is ' || seg.name
             WHEN seg.slug IS NOT NULL THEN 'Its segment is ' || seg.name
             ELSE 'No segment recorded; corporate is the most common category'
           END AS why
      FROM accounts acc LEFT JOIN crm_segments seg ON seg.id = acc.segment_id
  ) s
 WHERE s.id = a.id AND a.suggested_category IS NULL AND a.lead_category IS NULL;

-- ================================================================ contacts

ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS decision_roles TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS email_normalized TEXT;
ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS phone_normalized TEXT;
ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS consent JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_contacts ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL;

UPDATE account_contacts SET email_normalized = lower(trim(email))
 WHERE email_normalized IS NULL AND email IS NOT NULL AND trim(email) <> '';
-- digits only; a 10-digit Indian mobile gets its country code
UPDATE account_contacts
   SET phone_normalized = CASE
         WHEN length(regexp_replace(phone, '\D', '', 'g')) = 10 THEN '91' || regexp_replace(phone, '\D', '', 'g')
         WHEN regexp_replace(phone, '\D', '', 'g') ~ '^0\d{10}$' THEN '91' || substr(regexp_replace(phone, '\D', '', 'g'), 2)
         ELSE regexp_replace(phone, '\D', '', 'g') END
 WHERE phone_normalized IS NULL AND phone IS NOT NULL AND length(regexp_replace(phone, '\D', '', 'g')) >= 6;

CREATE INDEX IF NOT EXISTS account_contacts_email_idx ON account_contacts (email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_contacts_phone_idx ON account_contacts (phone_normalized) WHERE phone_normalized IS NOT NULL;

ALTER TABLE opportunity_contacts DROP CONSTRAINT IF EXISTS opportunity_contacts_role_check;
ALTER TABLE opportunity_contacts ADD CONSTRAINT opportunity_contacts_role_check
  CHECK (role IN ('PRIMARY', 'DECISION_MAKER', 'CHAMPION', 'TECHNICAL_EVALUATOR', 'PROCUREMENT', 'FINANCE',
                  'APPROVER', 'STAKEHOLDER', 'BLOCKER', 'INFLUENCER', 'CSR_CONTACT', 'IMPLEMENTING_CONTACT', 'USER'));

-- addresses that asked not to be contacted on a channel; applies to every
-- record carrying the address
CREATE TABLE IF NOT EXISTS crm_optouts (
  id          SERIAL PRIMARY KEY,
  channel     TEXT NOT NULL CHECK (channel IN ('WHATSAPP', 'CALL', 'EMAIL', 'SMS')),
  address     TEXT NOT NULL,
  reason      TEXT,
  source      TEXT NOT NULL DEFAULT 'MANUAL',
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_at   TIMESTAMPTZ,
  lifted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_optouts_active_idx ON crm_optouts (channel, address) WHERE lifted_at IS NULL;

-- ================================================================ inbound leads

CREATE TABLE IF NOT EXISTS crm_leads (
  id                       SERIAL PRIMARY KEY,
  ref                      TEXT NOT NULL UNIQUE,
  category                 TEXT NOT NULL DEFAULT 'UNCLASSIFIED'
                           CHECK (category IN ('B2B_CORPORATE', 'CSR_NGO', 'RETAILER', 'FPO', 'INDIVIDUAL', 'UNCLASSIFIED')),
  destination              TEXT NOT NULL DEFAULT 'TRIAGE' CHECK (destination IN ('TASKFLOW', 'TELECRM', 'TRIAGE')),
  routing_status           TEXT NOT NULL DEFAULT 'NEEDS_CLASSIFICATION'
                           CHECK (routing_status IN ('ACTIVE', 'NEEDS_CLASSIFICATION', 'HANDOFF_PENDING', 'HANDOFF_EXPORTED',
                                                     'HANDED_OFF', 'HANDOFF_FAILED')),
  status                   TEXT NOT NULL DEFAULT 'NEW'
                           CHECK (status IN ('NEW', 'CONTACTED', 'QUALIFYING', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED', 'NURTURE')),
  priority                 TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),

  organization_name        TEXT,
  account_id               INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  contact_name             TEXT,
  designation              TEXT,
  email                    TEXT,
  phone                    TEXT,
  email_normalized         TEXT,
  phone_normalized         TEXT,
  website                  TEXT,
  domain                   TEXT,
  contact_id               INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  city                     TEXT,
  state                    TEXT,
  country                  TEXT,
  enquiry                  TEXT,
  requirement              TEXT,

  -- qualification, answered by a person; blank is "not known", never "no"
  budget_amount            NUMERIC(16, 2) CHECK (budget_amount IS NULL OR budget_amount >= 0),
  currency                 TEXT NOT NULL DEFAULT 'INR',
  budget_confirmed         BOOLEAN,
  timeline                 TEXT CHECK (timeline IN ('IMMEDIATE', 'QUARTER', 'HALF_YEAR', 'YEAR', 'UNKNOWN')),
  decision_maker_engaged   BOOLEAN,
  need_clarity             TEXT CHECK (need_clarity IN ('CLEAR', 'PARTIAL', 'VAGUE')),
  fit                      TEXT CHECK (fit IN ('STRONG', 'PARTIAL', 'WEAK')),
  qualification            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- attribution: the business source is kept apart from how the record arrived
  source_id                INTEGER REFERENCES crm_sources(id) ON DELETE SET NULL,
  campaign_id              INTEGER REFERENCES crm_campaigns(id) ON DELETE SET NULL,
  original_source_id       INTEGER REFERENCES crm_sources(id) ON DELETE SET NULL,
  original_campaign_id     INTEGER REFERENCES crm_campaigns(id) ON DELETE SET NULL,
  utm                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  referral                 TEXT,
  landing_page             TEXT,
  entry_channel            TEXT NOT NULL DEFAULT 'MANUAL'
                           CHECK (entry_channel IN ('MANUAL', 'IMPORT', 'FORM', 'API', 'WEBHOOK', 'EMAIL', 'CALL',
                                                    'WHATSAPP', 'ORGANIZATION_FORM')),
  source_system            TEXT,
  external_id              TEXT,
  consent                  JSONB NOT NULL DEFAULT '{}'::jsonb,

  owner_user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department_id            INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  assigned_at              TIMESTAMPTZ,
  assignment_rule_id       INTEGER,

  score                    INTEGER,
  score_breakdown          JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_computed_at        TIMESTAMPTZ,
  score_override           INTEGER CHECK (score_override IS NULL OR score_override BETWEEN 0 AND 100),
  score_override_reason    TEXT,
  score_override_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,

  next_follow_up_at        TIMESTAMPTZ,
  last_activity_at         TIMESTAMPTZ,
  last_contacted_at        TIMESTAMPTZ,
  first_response_at        TIMESTAMPTZ,
  escalated_at             TIMESTAMPTZ,

  disqualify_reason        TEXT,
  converted_at             TIMESTAMPTZ,
  converted_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  converted_account_id     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  converted_opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  converted_contact_id     INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  merged_into_id           INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,

  tags                     TEXT[] NOT NULL DEFAULT '{}',
  custom_fields            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- a retried submission returns the record it already made
  idempotency_key          TEXT,
  import_job_id            INTEGER,

  is_archived              BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at              TIMESTAMPTZ,
  archived_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  archive_reason           TEXT,
  captured_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_idempotency_idx ON crm_leads (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_external_idx ON crm_leads (source_system, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_owner_idx ON crm_leads (owner_user_id, status) WHERE is_archived = FALSE;
CREATE INDEX IF NOT EXISTS crm_leads_routing_idx ON crm_leads (routing_status, destination);
CREATE INDEX IF NOT EXISTS crm_leads_email_idx ON crm_leads (email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_phone_idx ON crm_leads (phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_domain_idx ON crm_leads (domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_captured_idx ON crm_leads (captured_at DESC);
CREATE INDEX IF NOT EXISTS crm_leads_followup_idx ON crm_leads (next_follow_up_at) WHERE is_archived = FALSE;

-- the lead's own timeline, before and after conversion
CREATE TABLE IF NOT EXISTS crm_lead_activities (
  id            SERIAL PRIMARY KEY,
  lead_id       INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  direction     TEXT CHECK (direction IN ('OUTBOUND', 'INBOUND', 'INTERNAL')),
  outcome       TEXT,
  subject       TEXT,
  body          TEXT,
  actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  call_id       INTEGER,
  message_id    INTEGER,
  external_ref  TEXT,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_lead_activities_lead_idx ON crm_lead_activities (lead_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS crm_lead_activities_ref_idx ON crm_lead_activities (lead_id, external_ref) WHERE external_ref IS NOT NULL;

-- every classification and destination decision, append-only
CREATE TABLE IF NOT EXISTS crm_routing_events (
  id                SERIAL PRIMARY KEY,
  lead_id           INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  account_id        INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  from_category     TEXT,
  to_category       TEXT,
  from_destination  TEXT,
  to_destination    TEXT,
  routing_status    TEXT,
  entry_channel     TEXT,
  reason            TEXT,
  actor_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_routing_events_lead_idx ON crm_routing_events (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_routing_events_account_idx ON crm_routing_events (account_id, created_at DESC);

-- handing a lead to TeleCRM: nothing is claimed until a person confirms it
CREATE TABLE IF NOT EXISTS crm_handoff_batches (
  id          SERIAL PRIMARY KEY,
  target      TEXT NOT NULL DEFAULT 'TELECRM',
  format      TEXT NOT NULL CHECK (format IN ('CSV', 'XLSX')),
  row_count   INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_handoffs (
  id                 SERIAL PRIMARY KEY,
  lead_id            INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  account_id         INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  target             TEXT NOT NULL DEFAULT 'TELECRM',
  method             TEXT NOT NULL DEFAULT 'MANUAL_EXPORT' CHECK (method IN ('MANUAL_EXPORT', 'API')),
  status             TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'EXPORTED', 'CONFIRMED', 'FAILED', 'CANCELLED')),
  batch_id           INTEGER REFERENCES crm_handoff_batches(id) ON DELETE SET NULL,
  external_id        TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  exported_at        TIMESTAMPTZ,
  exported_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at       TIMESTAMPTZ,
  confirmed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmation_note  TEXT,
  cancelled_reason   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one live hand-off per record and target
CREATE UNIQUE INDEX IF NOT EXISTS crm_handoffs_lead_idx ON crm_handoffs (lead_id, target)
  WHERE lead_id IS NOT NULL AND status <> 'CANCELLED';
CREATE UNIQUE INDEX IF NOT EXISTS crm_handoffs_account_idx ON crm_handoffs (account_id, target)
  WHERE account_id IS NOT NULL AND status <> 'CANCELLED';

-- people following a record without owning it
CREATE TABLE IF NOT EXISTS crm_watchers (
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('LEAD', 'ACCOUNT', 'OPPORTUNITY')),
  entity_id    INTEGER NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, user_id)
);
CREATE INDEX IF NOT EXISTS crm_watchers_user_idx ON crm_watchers (user_id, entity_type);

-- ================================================================ assignment and scoring

CREATE TABLE IF NOT EXISTS crm_agent_profiles (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  accepts_new_leads  BOOLEAN NOT NULL DEFAULT TRUE,
  max_open_leads     INTEGER CHECK (max_open_leads IS NULL OR max_open_leads > 0),
  categories         TEXT[] NOT NULL DEFAULT '{}',
  states             TEXT[] NOT NULL DEFAULT '{}',
  specializations    TEXT[] NOT NULL DEFAULT '{}',
  updated_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_assignment_rules (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  priority          INTEGER NOT NULL DEFAULT 100,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  -- {categories, pipelines, source_ids, campaign_ids, states, tags, min_score}
  conditions        JSONB NOT NULL DEFAULT '{}'::jsonb,
  strategy          TEXT NOT NULL DEFAULT 'ROUND_ROBIN'
                    CHECK (strategy IN ('SPECIFIC_USER', 'ROUND_ROBIN', 'LEAST_LOADED', 'ACCOUNT_OWNER', 'SPECIALIZATION')),
  user_ids          INTEGER[] NOT NULL DEFAULT '{}',
  department_id     INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  respect_capacity  BOOLEAN NOT NULL DEFAULT TRUE,
  skip_unavailable  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_assignment_cursor (
  rule_id       INTEGER PRIMARY KEY REFERENCES crm_assignment_rules(id) ON DELETE CASCADE,
  last_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned      BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- who got what, why, from whom — append-only
CREATE TABLE IF NOT EXISTS crm_assignments (
  id            SERIAL PRIMARY KEY,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('LEAD', 'ACCOUNT', 'OPPORTUNITY')),
  entity_id     INTEGER NOT NULL,
  from_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rule_id       INTEGER,
  method        TEXT NOT NULL CHECK (method IN ('AUTO', 'MANUAL', 'BULK', 'IMPORT', 'LEAVER', 'FALLBACK', 'AUTOMATION')),
  reason        TEXT,
  explain       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_assignments_entity_idx ON crm_assignments (entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_scoring_models (
  id          SERIAL PRIMARY KEY,
  category    TEXT NOT NULL UNIQUE CHECK (category IN ('B2B_CORPORATE', 'CSR_NGO')),
  is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  criteria    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO crm_scoring_models (category, criteria) VALUES
  ('B2B_CORPORATE', '[
    {"key":"fit","label":"Fit with what we sell","weight":25},
    {"key":"need_clarity","label":"Requirement clarity","weight":15},
    {"key":"budget","label":"Budget known","weight":15},
    {"key":"decision_maker","label":"Decision maker engaged","weight":15},
    {"key":"timeline","label":"Buying timeline","weight":15},
    {"key":"recency","label":"Recent two-way contact","weight":10},
    {"key":"proposal_ready","label":"Ready for a proposal","weight":5}
  ]'::jsonb),
  ('CSR_NGO', '[
    {"key":"fit","label":"Thematic and geographic fit","weight":25},
    {"key":"need_clarity","label":"Project clarity","weight":15},
    {"key":"budget","label":"Funding range known","weight":15},
    {"key":"decision_maker","label":"CSR head or trustee engaged","weight":15},
    {"key":"timeline","label":"Funding cycle timing","weight":15},
    {"key":"recency","label":"Recent two-way contact","weight":10},
    {"key":"proposal_ready","label":"Ready for a concept note","weight":5}
  ]'::jsonb)
ON CONFLICT (category) DO NOTHING;

-- ================================================================ opportunities

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS pipeline_id INTEGER REFERENCES crm_pipelines(id) ON DELETE SET NULL;
UPDATE opportunities SET pipeline_id = (SELECT id FROM crm_pipelines WHERE key = 'b2b') WHERE pipeline_id IS NULL;
CREATE INDEX IF NOT EXISTS opportunities_pipeline_idx ON opportunities (pipeline_id) WHERE is_archived = FALSE;

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS opportunity_type TEXT
  CHECK (opportunity_type IN ('NEW_BUSINESS', 'REPEAT', 'RENEWAL', 'UPSELL', 'CSR_FUNDING', 'NGO_PURCHASE', 'PARTNERSHIP'));
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source_lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES crm_sources(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES crm_campaigns(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS renewal_of_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS renewal_due_on DATE;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS forecast_category TEXT
  CHECK (forecast_category IN ('PIPELINE', 'BEST_CASE', 'COMMIT', 'OMITTED'));
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS lost_reason_code TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS reopened_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS next_action_absent_reason TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
-- a partnership with no money in it is not a zero; it is left out of money totals
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS is_monetary BOOLEAN NOT NULL DEFAULT TRUE;

-- CSR / NGO: configurable in Settings, stored where reports can read them
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS thematic_focus TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS proposed_project TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS project_geography TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS beneficiaries TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS beneficiary_count INTEGER CHECK (beneficiary_count IS NULL OR beneficiary_count >= 0);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS requested_amount NUMERIC(16, 2) CHECK (requested_amount IS NULL OR requested_amount >= 0);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS committed_amount NUMERIC(16, 2) CHECK (committed_amount IS NULL OR committed_amount >= 0);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS funding_cycle TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS proposal_deadline DATE;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS agreement_status TEXT
  CHECK (agreement_status IN ('NOT_STARTED', 'DRAFTING', 'UNDER_REVIEW', 'SIGNED', 'NOT_REQUIRED'));
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS reporting_commitments TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS required_documents JSONB NOT NULL DEFAULT '[]'::jsonb;

-- one renewal per deal: asking again returns the same one
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_renewal_idx ON opportunities (renewal_of_id) WHERE renewal_of_id IS NOT NULL;

-- the organizations on a deal and what each does: funder, the one who signs,
-- the one who pays, the implementing partner…
CREATE TABLE IF NOT EXISTS opportunity_parties (
  id              SERIAL PRIMARY KEY,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('FUNDER', 'CONTRACTING', 'PAYING', 'IMPLEMENTING_PARTNER', 'BUYER',
                                               'REFERRAL', 'PARTNER', 'OTHER')),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, account_id, role)
);
CREATE INDEX IF NOT EXISTS opportunity_parties_account_idx ON opportunity_parties (account_id);

-- ================================================================ catalogue, quotations, approvals

CREATE TABLE IF NOT EXISTS crm_products (
  id           SERIAL PRIMARY KEY,
  sku          TEXT UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  kind         TEXT NOT NULL DEFAULT 'PRODUCT' CHECK (kind IN ('PRODUCT', 'SERVICE', 'SUBSCRIPTION', 'PROGRAMME')),
  unit         TEXT,
  unit_price   NUMERIC(16, 2) CHECK (unit_price IS NULL OR unit_price >= 0),
  currency     TEXT NOT NULL DEFAULT 'INR',
  tax_rate     NUMERIC(5, 2) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_label    TEXT,
  hsn_sac      TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_quotes (
  id                       SERIAL PRIMARY KEY,
  opportunity_id           INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL DEFAULT 'QUOTATION' CHECK (kind IN ('QUOTATION', 'CSR_PROPOSAL')),
  number                   TEXT NOT NULL,
  version                  INTEGER NOT NULL DEFAULT 1,
  -- the first version's id; versions of one quotation share it
  family_id                INTEGER,
  title                    TEXT,
  status                   TEXT NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'SENT', 'ACCEPTED',
                                             'DECLINED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN')),
  currency                 TEXT NOT NULL DEFAULT 'INR',
  subtotal                 NUMERIC(16, 2) NOT NULL DEFAULT 0,
  discount_total           NUMERIC(16, 2) NOT NULL DEFAULT 0,
  tax_total                NUMERIC(16, 2) NOT NULL DEFAULT 0,
  total                    NUMERIC(16, 2) NOT NULL DEFAULT 0,
  max_discount_pct         NUMERIC(5, 2) NOT NULL DEFAULT 0,
  valid_until              DATE,
  terms                    TEXT,
  notes                    TEXT,
  -- a CSR proposal / concept note
  project_scope            TEXT,
  objectives               TEXT,
  outcomes                 TEXT,
  deliverables             TEXT,
  timeline                 TEXT,
  beneficiaries            TEXT,
  geography                TEXT,
  reporting_plan           TEXT,
  budget_notes             TEXT,
  -- approval: what was approved is pinned by a hash of its content
  approval_required        BOOLEAN NOT NULL DEFAULT FALSE,
  approval_reasons         TEXT[] NOT NULL DEFAULT '{}',
  approved_hash            TEXT,
  approved_at              TIMESTAMPTZ,
  approved_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- sending and the customer's answer; acceptance is a record of how it was
  -- obtained, not a verified electronic signature
  sent_at                  TIMESTAMPTZ,
  sent_via                 TEXT,
  sent_to                  TEXT,
  sent_by                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_on               DATE,
  acceptance_method        TEXT CHECK (acceptance_method IN ('EMAIL_REPLY', 'PURCHASE_ORDER', 'SIGNED_COPY', 'VERBAL',
                                                             'MEETING', 'WHATSAPP', 'OTHER')),
  acceptance_note          TEXT,
  acceptance_evidence_url  TEXT,
  decision_recorded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decline_reason           TEXT,
  proposal_record_id       INTEGER REFERENCES opportunity_proposals(id) ON DELETE SET NULL,
  created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (number, version)
);
CREATE INDEX IF NOT EXISTS crm_quotes_opportunity_idx ON crm_quotes (opportunity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_quote_lines (
  id            SERIAL PRIMARY KEY,
  quote_id      INTEGER NOT NULL REFERENCES crm_quotes(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  product_id    INTEGER REFERENCES crm_products(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  quantity      NUMERIC(14, 3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit          TEXT,
  unit_price    NUMERIC(16, 2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  discount_pct  NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  tax_rate      NUMERIC(5, 2) CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100)),
  tax_label     TEXT,
  line_subtotal NUMERIC(16, 2) NOT NULL DEFAULT 0,
  line_discount NUMERIC(16, 2) NOT NULL DEFAULT 0,
  line_tax      NUMERIC(16, 2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(16, 2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS crm_quote_lines_quote_idx ON crm_quote_lines (quote_id, position);

CREATE TABLE IF NOT EXISTS crm_approval_rules (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL DEFAULT 'ANY' CHECK (kind IN ('ANY', 'QUOTATION', 'CSR_PROPOSAL')),
  pipeline_id          INTEGER REFERENCES crm_pipelines(id) ON DELETE SET NULL,
  -- either threshold triggers the rule; a blank one is not used
  min_discount_pct     NUMERIC(5, 2),
  min_total            NUMERIC(16, 2),
  currency             TEXT NOT NULL DEFAULT 'INR',
  approver_user_ids    INTEGER[] NOT NULL DEFAULT '{}',
  allow_self_approval  BOOLEAN NOT NULL DEFAULT FALSE,
  is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  position             INTEGER NOT NULL DEFAULT 0,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_approvals (
  id            SERIAL PRIMARY KEY,
  quote_id      INTEGER NOT NULL REFERENCES crm_quotes(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  reasons       TEXT[] NOT NULL DEFAULT '{}',
  approver_ids  INTEGER[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  comment       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_approvals_pending_idx ON crm_approvals (quote_id) WHERE status = 'PENDING';

-- ================================================================ payments

CREATE TABLE IF NOT EXISTS crm_payment_schedules (
  id              SERIAL PRIMARY KEY,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'COMMERCIAL' CHECK (kind IN ('COMMERCIAL', 'CSR_TRANCHE')),
  label           TEXT NOT NULL,
  due_on          DATE NOT NULL,
  amount          NUMERIC(16, 2) NOT NULL CHECK (amount >= 0),
  currency        TEXT NOT NULL DEFAULT 'INR',
  milestone_id    INTEGER REFERENCES engagement_milestones(id) ON DELETE SET NULL,
  invoice_id      INTEGER REFERENCES opportunity_invoices(id) ON DELETE SET NULL,
  notes           TEXT,
  is_cancelled    BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_reason   TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_payment_schedules_opp_idx ON crm_payment_schedules (opportunity_id, due_on);

-- receipts and refunds: a refund is its own record, never a negative receipt
ALTER TABLE opportunity_payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'RECEIPT'
  CHECK (kind IN ('RECEIPT', 'REFUND'));
ALTER TABLE opportunity_payments ADD COLUMN IF NOT EXISTS schedule_id INTEGER REFERENCES crm_payment_schedules(id) ON DELETE SET NULL;
ALTER TABLE opportunity_payments ADD COLUMN IF NOT EXISTS mode TEXT
  CHECK (mode IN ('BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'ONLINE', 'GRANT_DISBURSEMENT', 'OTHER'));
-- the same payment event (a bank reference, a provider id) is applied once
ALTER TABLE opportunity_payments ADD COLUMN IF NOT EXISTS event_key TEXT;
ALTER TABLE opportunity_payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE opportunity_payments ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE opportunity_payments ADD COLUMN IF NOT EXISTS corrects_id INTEGER REFERENCES opportunity_payments(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_payments_event_idx ON opportunity_payments (event_key) WHERE event_key IS NOT NULL;

-- conversion rates entered by an administrator, with their date; nothing is
-- converted without one
CREATE TABLE IF NOT EXISTS crm_fx_rates (
  id          SERIAL PRIMARY KEY,
  currency    TEXT NOT NULL,
  base        TEXT NOT NULL DEFAULT 'INR',
  rate        NUMERIC(18, 8) NOT NULL CHECK (rate > 0),
  as_of       DATE NOT NULL,
  source      TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (currency, base, as_of)
);

-- ================================================================ handover into delivery

ALTER TABLE engagements ADD COLUMN IF NOT EXISTS handover_status TEXT
  CHECK (handover_status IN ('IN_REVIEW', 'ACCEPTED', 'RETURNED'));
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS handover_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS handover_reviewed_at TIMESTAMPTZ;
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS handover_note TEXT;
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS deliverables TEXT;
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS reporting_schedule JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE engagements ADD COLUMN IF NOT EXISTS ends_on DATE;

-- ================================================================ follow-ups are tasks

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS crm_lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS followup_kind TEXT
  CHECK (followup_kind IN ('CALL', 'CALLBACK', 'MEETING', 'EMAIL', 'WHATSAPP', 'DEMO', 'DOCUMENT', 'VISIT', 'OTHER'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS followup_outcome TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS crm_cancel_reason TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS automation_run_id INTEGER;
CREATE INDEX IF NOT EXISTS tasks_crm_lead_idx ON tasks (crm_lead_id) WHERE crm_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_followup_idx ON tasks (assignee_id, due_date) WHERE followup_kind IS NOT NULL;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS crm_lead_id INTEGER REFERENCES crm_leads(id) ON DELETE CASCADE;

-- ================================================================ calls and WhatsApp

CREATE TABLE IF NOT EXISTS crm_calls (
  id                   SERIAL PRIMARY KEY,
  provider             TEXT NOT NULL DEFAULT 'manual',
  provider_call_id     TEXT,
  direction            TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  status               TEXT NOT NULL DEFAULT 'COMPLETED'
                       CHECK (status IN ('QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'BUSY',
                                         'FAILED', 'CANCELLED')),
  from_number          TEXT,
  to_number            TEXT,
  counterpart_normalized TEXT,
  agent_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  lead_id              INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  account_id           INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id           INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  opportunity_id       INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  started_at           TIMESTAMPTZ,
  answered_at          TIMESTAMPTZ,
  ended_at             TIMESTAMPTZ,
  duration_sec         INTEGER CHECK (duration_sec IS NULL OR duration_sec >= 0),
  -- the provider's address for the recording; served only through TaskFlow,
  -- to people allowed to hear recordings
  recording_ref        TEXT,
  outcome              TEXT,
  notes                TEXT,
  follow_up_task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  logged_manually      BOOLEAN NOT NULL DEFAULT FALSE,
  last_event_at        TIMESTAMPTZ,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_calls_provider_idx ON crm_calls (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_calls_lead_idx ON crm_calls (lead_id, started_at DESC);
CREATE INDEX IF NOT EXISTS crm_calls_account_idx ON crm_calls (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS crm_calls_agent_idx ON crm_calls (agent_user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS crm_wa_templates (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  language         TEXT NOT NULL,
  category         TEXT,
  status           TEXT,
  components       JSONB NOT NULL DEFAULT '[]'::jsonb,
  variable_count   INTEGER NOT NULL DEFAULT 0,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, language)
);

CREATE TABLE IF NOT EXISTS crm_wa_messages (
  id                    SERIAL PRIMARY KEY,
  provider              TEXT NOT NULL DEFAULT 'meta',
  provider_message_id   TEXT,
  direction             TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  phone                 TEXT NOT NULL,
  phone_normalized      TEXT NOT NULL,
  lead_id               INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  account_id            INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id            INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  opportunity_id        INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  agent_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind                  TEXT NOT NULL DEFAULT 'TEXT',
  template_name         TEXT,
  template_language     TEXT,
  variables             JSONB NOT NULL DEFAULT '[]'::jsonb,
  body                  TEXT,
  media                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                TEXT NOT NULL DEFAULT 'QUEUED'
                        CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED', 'BLOCKED')),
  status_at             TIMESTAMPTZ,
  error_code            TEXT,
  error_title           TEXT,
  sent_at               TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  read_at               TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  attempts              INTEGER NOT NULL DEFAULT 0,
  automation_run_id     INTEGER,
  idempotency_key       TEXT,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_wa_messages_provider_idx ON crm_wa_messages (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_wa_messages_idem_idx ON crm_wa_messages (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_wa_messages_phone_idx ON crm_wa_messages (phone_normalized, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_wa_messages_lead_idx ON crm_wa_messages (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_wa_messages_account_idx ON crm_wa_messages (account_id, created_at DESC);

-- every webhook received, once: the provider's event id makes retries and
-- out-of-order deliveries harmless
CREATE TABLE IF NOT EXISTS crm_integration_events (
  id            SERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  event_key     TEXT NOT NULL,
  kind          TEXT,
  status        TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  error         TEXT,
  summary       JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  UNIQUE (provider, event_key)
);
CREATE INDEX IF NOT EXISTS crm_integration_events_time_idx ON crm_integration_events (provider, received_at DESC);

-- the unified timeline points at what each entry is about
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS call_id INTEGER REFERENCES crm_calls(id) ON DELETE SET NULL;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS message_id INTEGER REFERENCES crm_wa_messages(id) ON DELETE SET NULL;
ALTER TABLE account_activities ADD COLUMN IF NOT EXISTS quote_id INTEGER REFERENCES crm_quotes(id) ON DELETE SET NULL;

ALTER TABLE account_activities DROP CONSTRAINT IF EXISTS account_activities_type_check;
ALTER TABLE account_activities ADD CONSTRAINT account_activities_type_check
  CHECK (type IN ('NOTE', 'EMAIL', 'CALL', 'PPT', 'PROPOSAL', 'MEETING', 'DEMO',
                  'IN_PERSON', 'SUMMARY', 'STAGE_CHANGE', 'CONVERTED',
                  'TASK_DONE', 'ORDER', 'INVOICE', 'PAYMENT', 'HANDOVER', 'NEXT_ACTION',
                  'CAMPAIGN',
                  'WHATSAPP', 'QUOTE', 'APPROVAL', 'ASSIGNMENT', 'LEAD', 'REFUND', 'RENEWAL', 'MERGE'));

ALTER TABLE account_activities DROP CONSTRAINT IF EXISTS account_activities_source_check;
ALTER TABLE account_activities ADD CONSTRAINT account_activities_source_check
  CHECK (source IN ('MANUAL', 'TASK', 'MEETING', 'SYSTEM', 'EMAIL_IMPORT', 'CALENDAR_IMPORT',
                    'CALL_PROVIDER', 'WHATSAPP', 'AUTOMATION', 'IMPORT', 'CAPTURE', 'LEAD'));

ALTER TABLE crm_ownership_history DROP CONSTRAINT IF EXISTS crm_ownership_history_entity_type_check;
ALTER TABLE crm_ownership_history ADD CONSTRAINT crm_ownership_history_entity_type_check
  CHECK (entity_type IN ('ACCOUNT', 'OPPORTUNITY', 'ENGAGEMENT', 'LEAD', 'CONTACT'));

-- ================================================================ automation

CREATE TABLE IF NOT EXISTS crm_events (
  id              BIGSERIAL PRIMARY KEY,
  type            TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       INTEGER NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- what caused it, so automation never feeds on its own output forever
  origin          TEXT NOT NULL DEFAULT 'USER' CHECK (origin IN ('USER', 'AUTOMATION', 'SYSTEM', 'INTEGRATION')),
  origin_rule_id  INTEGER,
  depth           INTEGER NOT NULL DEFAULT 0,
  actor_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_events_pending_idx ON crm_events (id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS crm_automation_rules (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  description          TEXT,
  owner_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  -- in test mode a rule records what it would do and does nothing
  test_mode            BOOLEAN NOT NULL DEFAULT TRUE,
  priority             INTEGER NOT NULL DEFAULT 100,
  trigger              TEXT NOT NULL,
  conditions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions              JSONB NOT NULL DEFAULT '[]'::jsonb,
  delay_minutes        INTEGER NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
  business_hours_only  BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_on            TEXT[] NOT NULL DEFAULT '{}',
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_automation_runs (
  id               SERIAL PRIMARY KEY,
  rule_id          INTEGER NOT NULL REFERENCES crm_automation_rules(id) ON DELETE CASCADE,
  event_id         BIGINT,
  entity_type      TEXT NOT NULL,
  entity_id        INTEGER NOT NULL,
  -- a rule runs once per entity per triggering occurrence
  run_key          TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'SCHEDULED'
                   CHECK (status IN ('SCHEDULED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED', 'CANCELLED', 'SIMULATED')),
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  result           JSONB NOT NULL DEFAULT '[]'::jsonb,
  depth            INTEGER NOT NULL DEFAULT 0,
  cancelled_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_automation_runs_due_idx ON crm_automation_runs (run_at) WHERE status = 'SCHEDULED';
CREATE INDEX IF NOT EXISTS crm_automation_runs_entity_idx ON crm_automation_runs (entity_type, entity_id);

-- ================================================================ imports

CREATE TABLE IF NOT EXISTS crm_import_jobs (
  id              SERIAL PRIMARY KEY,
  entity          TEXT NOT NULL CHECK (entity IN ('LEADS', 'ACCOUNTS', 'CONTACTS')),
  filename        TEXT,
  file_kind       TEXT NOT NULL CHECK (file_kind IN ('CSV', 'XLSX')),
  file_hash       TEXT,
  status          TEXT NOT NULL DEFAULT 'UPLOADED'
                  CHECK (status IN ('UPLOADED', 'VALIDATED', 'RUNNING', 'DONE', 'FAILED', 'UNDONE')),
  header          TEXT[] NOT NULL DEFAULT '{}',
  mapping         JSONB NOT NULL DEFAULT '{}'::jsonb,
  options         JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts          JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_rows      INTEGER NOT NULL DEFAULT 0,
  processed_rows  INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  undone_at       TIMESTAMPTZ,
  undone_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  undo_summary    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS crm_import_rows (
  id          BIGSERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES crm_import_jobs(id) ON DELETE CASCADE,
  row_no      INTEGER NOT NULL,
  raw         JSONB NOT NULL DEFAULT '{}'::jsonb,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING', 'VALID', 'INVALID', 'DUPLICATE', 'ROUTED', 'IMPORTED', 'UPDATED', 'SKIPPED',
                                'UNDONE', 'KEPT')),
  errors      TEXT[] NOT NULL DEFAULT '{}',
  warnings    TEXT[] NOT NULL DEFAULT '{}',
  duplicate_of INTEGER,
  entity_id   INTEGER,
  before      JSONB,
  applied_at  TIMESTAMPTZ,
  UNIQUE (job_id, row_no)
);
CREATE INDEX IF NOT EXISTS crm_import_rows_status_idx ON crm_import_rows (job_id, status);

-- ================================================================ reporting

CREATE TABLE IF NOT EXISTS crm_targets (
  id             SERIAL PRIMARY KEY,
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'COMPANY' CHECK (scope IN ('COMPANY', 'TEAM', 'USER')),
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  department_id  INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  pipeline_id    INTEGER REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  metric         TEXT NOT NULL CHECK (metric IN ('NEW_LEADS', 'CONVERTED_LEADS', 'WON_DEALS', 'WON_VALUE',
                                                 'CSR_COMMITTED', 'RECEIPTS', 'ACTIVITIES')),
  target         NUMERIC(16, 2) NOT NULL CHECK (target >= 0),
  currency       TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE TABLE IF NOT EXISTS crm_report_schedules (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  report         TEXT NOT NULL,
  filters        JSONB NOT NULL DEFAULT '{}'::jsonb,
  frequency      TEXT NOT NULL CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  recipient_ids  INTEGER[] NOT NULL DEFAULT '{}',
  is_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_on   DATE,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_saved_views (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area        TEXT NOT NULL,
  name        TEXT NOT NULL,
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_shared   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_saved_views_user_idx ON crm_saved_views (user_id, area);

-- ================================================================ merges

CREATE TABLE IF NOT EXISTS crm_merges (
  id             SERIAL PRIMARY KEY,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('ACCOUNT', 'CONTACT', 'LEAD')),
  survivor_id    INTEGER NOT NULL,
  merged_id      INTEGER NOT NULL,
  reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  field_choices  JSONB NOT NULL DEFAULT '{}'::jsonb,
  moved          JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the decisions that must never be rewritten
CREATE TRIGGER crm_routing_events_append_only
  BEFORE UPDATE OR DELETE ON crm_routing_events
  FOR EACH ROW EXECUTE PROCEDURE taskflow_append_only();
CREATE TRIGGER crm_assignments_append_only
  BEFORE UPDATE OR DELETE ON crm_assignments
  FOR EACH ROW EXECUTE PROCEDURE taskflow_append_only();
CREATE TRIGGER crm_merges_append_only
  BEFORE UPDATE OR DELETE ON crm_merges
  FOR EACH ROW EXECUTE PROCEDURE taskflow_append_only();
