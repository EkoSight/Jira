-- Tele-sales: the work TeleCRM did, inside TaskFlow.
--
-- Retailers, FPOs and individual farmers or consumers can now be worked here
-- (a setting; the TeleCRM hand-off stays available for the transition). This
-- adds what that work needs:
--
--   calling statuses   TeleCRM-style statuses ("Ringing Not Responding",
--                      "Interested", "Lost"…) each mapped onto the lead's
--                      lifecycle, with automatic retries for no answer and busy
--   lead fields        custom questions on a lead ("Associated with agriculture
--                      as", "Service needed"…); an answer can set the category
--   a third pipeline   for retailer, FPO and individual deals
--   a won lead         a sale closed on the lead itself, without a deal record
--   rating             one to five stars, as TeleCRM had
--
-- Additive only: three CHECK constraints are widened (every value they allowed
-- is still allowed), everything else is a new table, a new nullable or
-- defaulted column, or a new row. No existing row is changed.

-- ================================================================ lead lifecycle: WON

ALTER TABLE crm_leads DROP CONSTRAINT IF EXISTS crm_leads_status_check;
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_status_check
  CHECK (status IN ('NEW', 'CONTACTED', 'QUALIFYING', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED', 'NURTURE', 'WON'));

-- ================================================================ calling statuses

CREATE TABLE IF NOT EXISTS crm_call_statuses (
  id                   SERIAL PRIMARY KEY,
  key                  TEXT NOT NULL UNIQUE,
  label                TEXT NOT NULL,
  -- what the status means for the lead's lifecycle
  lifecycle            TEXT NOT NULL CHECK (lifecycle IN ('NEW', 'CONTACTED', 'QUALIFYING', 'QUALIFIED', 'NURTURE', 'WON', 'DISQUALIFIED')),
  -- whether reaching this status means someone spoke to them
  outcome              TEXT NOT NULL DEFAULT 'CONNECTED' CHECK (outcome IN ('NONE', 'NOT_CONNECTED', 'CONNECTED')),
  -- try again automatically after this long (no answer, busy)
  retry_after_minutes  INTEGER CHECK (retry_after_minutes IS NULL OR retry_after_minutes > 0),
  -- after this many attempts, stop retrying and suggest closing the lead
  max_attempts         INTEGER CHECK (max_attempts IS NULL OR max_attempts > 0),
  needs_reason         BOOLEAN NOT NULL DEFAULT FALSE,
  -- a status that also says who the lead is ("Farmer interested in soil testing")
  implies_category     TEXT CHECK (implies_category IN ('B2B_CORPORATE', 'CSR_NGO', 'RETAILER', 'FPO', 'INDIVIDUAL')),
  color                TEXT,
  position             INTEGER NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TeleCRM's statuses, with their exact labels, so the team keeps its words
INSERT INTO crm_call_statuses (key, label, lifecycle, outcome, retry_after_minutes, max_attempts, needs_reason, implies_category, color, position) VALUES
  ('fresh',                     'Fresh',                                 'NEW',          'NONE',          NULL, NULL, FALSE, NULL,         '#64748b', 1),
  ('ringing-not-responding',    'Ringing Not Responding',                'CONTACTED',    'NOT_CONNECTED', 180,  6,    FALSE, NULL,         '#f59e0b', 2),
  ('busy',                      'Busy',                                  'CONTACTED',    'NOT_CONNECTED', 60,   6,    FALSE, NULL,         '#f97316', 3),
  ('just-curious',              'Just Curious',                          'NURTURE',      'CONNECTED',     NULL, NULL, FALSE, NULL,         '#94a3b8', 4),
  ('interested',                'Interested',                            'QUALIFYING',   'CONNECTED',     NULL, NULL, FALSE, NULL,         '#0ea5e9', 5),
  ('farmer-soil-testing',       'Farmer Interested in Soil Testing',     'QUALIFYING',   'CONNECTED',     NULL, NULL, FALSE, 'INDIVIDUAL', '#22c55e', 6),
  ('student-sdc',               'Student Who Wants to Start A SDC',      'QUALIFYING',   'CONNECTED',     NULL, NULL, FALSE, 'INDIVIDUAL', '#6366f1', 7),
  ('explore-partnership',       'Explore Partnership',                   'QUALIFYING',   'CONNECTED',     NULL, NULL, FALSE, NULL,         '#8b5cf6', 8),
  ('hot',                       'Hot',                                   'QUALIFIED',    'CONNECTED',     NULL, NULL, FALSE, NULL,         '#dc2626', 9),
  ('under-negotiation',         'Under Negotiation',                     'QUALIFIED',    'CONNECTED',     NULL, NULL, FALSE, NULL,         '#0f766e', 10),
  ('purchase-rabi-2026',        'Will Purchase the Device in Rabi 2026', 'NURTURE',      'CONNECTED',     NULL, NULL, FALSE, NULL,         '#a3a3a3', 11),
  ('won',                       'Won',                                   'WON',          'CONNECTED',     NULL, NULL, FALSE, NULL,         '#0ca30c', 12),
  ('job-seeker',                'Job Seeker',                            'DISQUALIFIED', 'CONNECTED',     NULL, NULL, FALSE, 'INDIVIDUAL', '#78716c', 13),
  ('lost',                      'Lost',                                  'DISQUALIFIED', 'CONNECTED',     NULL, NULL, TRUE,  NULL,         '#d03b3b', 14)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS call_status_id INTEGER REFERENCES crm_call_statuses(id) ON DELETE SET NULL;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS call_status_at TIMESTAMPTZ;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS call_status_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- who set it last: a person, automation, or an import (an import may update
-- only a status that an import set)
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS call_status_source TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS call_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS last_called_at TIMESTAMPTZ;
-- when to try again after no answer or busy; cleared when someone answers
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5);

CREATE INDEX IF NOT EXISTS crm_leads_call_status_idx ON crm_leads (call_status_id) WHERE is_archived = FALSE;
CREATE INDEX IF NOT EXISTS crm_leads_retry_idx ON crm_leads (owner_user_id, retry_at) WHERE is_archived = FALSE AND retry_at IS NOT NULL;

-- ================================================================ lead fields

CREATE TABLE IF NOT EXISTS crm_lead_fields (
  id            SERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label         TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('TEXT', 'LONG_TEXT', 'SELECT', 'MULTI_SELECT', 'NUMBER', 'DATE', 'URL')),
  -- for choices: [{ "value", "label", "aliases": [...], "category": optional }]
  options       JSONB NOT NULL DEFAULT '[]'::jsonb,
  help          TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  show_in_list  BOOLEAN NOT NULL DEFAULT FALSE,
  filterable    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the questions the enquiry forms ask today, with the answers' Hindi and
-- English wordings as aliases; who someone is decides the lead's category
INSERT INTO crm_lead_fields (key, label, type, options, help, position, show_in_list, filterable) VALUES
  ('agri_role', 'Associated with agriculture as', 'SELECT', '[
     {"value":"agri_retailer","label":"Agri retailer / shop owner","category":"RETAILER",
      "aliases":["Agri Retailer or Shop Owner","कृषि विक्रेता (Agri-Retailer)","Agri Retailer / Shop Owner (खुद की खाद-बीज-दवा की दुकान)","Agri-Retailer","Retailer","Shop owner"]},
     {"value":"farmer","label":"Farmer","category":"INDIVIDUAL","aliases":["Farmer (किसान)","किसान (Farmer)","किसान","Farmer"]},
     {"value":"fpo_member","label":"FPO / farmer group member","category":"FPO","aliases":["FPO or Farmer Group Member","एफपीओ / एफपीसी FPO / FPC","FPO","FPC"]},
     {"value":"student","label":"Student / job seeker","category":"INDIVIDUAL","aliases":["छात्र (Student)","Student or Job Seeker","Student","छात्र"]},
     {"value":"agri_entrepreneur","label":"Agri-entrepreneur","category":"INDIVIDUAL","aliases":["कृषि उद्यमी (Agri-Entrepreneur)","Agri-Entrepreneur","Agri Entrepreneur"]},
     {"value":"input_company","label":"Agri-input company or distributor","aliases":["Agri-Input Company or Agri-Input Distributor"]},
     {"value":"other","label":"Other","aliases":["Other","अन्य (Other)","अन्य"]}
   ]'::jsonb, 'Who they are. Retailer, farmer, FPO, student and entrepreneur answers also set the lead''s category; company or distributor and Other leave it for a person to decide.', 1, TRUE, TRUE),
  ('service_needed', 'Service needed', 'MULTI_SELECT', '[
     {"value":"clinic_setup","label":"Soil Doctor Clinic Setup","aliases":["Soil Doctor Clinic Setup","Clinic Setup","SDC"]},
     {"value":"kit","label":"Soil Doctor Kit","aliases":["Soil Doctor Kit","Kit"]},
     {"value":"testing_service","label":"Soil and water testing service","aliases":["Soil and Water Testing Service","Soil & Water Testing Service (मिट्टी पानी जाँच सेवा)","Soil & Water Testing Service","मिट्टी पानी जाँच सेवा"]},
     {"value":"agri_tools","label":"Agriculture tools","aliases":["Agriculture Tools","Agriculture Too"]},
     {"value":"other","label":"Other","aliases":["Others","Other"]}
   ]'::jsonb, NULL, 2, TRUE, TRUE),
  ('shop_duration', 'Shop running for', 'TEXT', '[]'::jsonb, 'As they said it ("5 years", "since 2010").', 3, FALSE, FALSE),
  ('event_name', 'Event', 'TEXT', '[]'::jsonb, 'The event or exhibition where they enquired.', 4, FALSE, TRUE),
  ('telecrm_link', 'TeleCRM record', 'URL', '[]'::jsonb, 'The lead in TeleCRM, for reference until the subscription ends.', 90, FALSE, FALSE),
  ('telecrm_date', 'TeleCRM "Date" field', 'TEXT', '[]'::jsonb, 'Kept exactly as TeleCRM had it; its meaning varied.', 91, FALSE, FALSE)
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS crm_leads_custom_fields_idx ON crm_leads USING gin (custom_fields);

-- ================================================================ the retail pipeline

ALTER TABLE crm_pipelines DROP CONSTRAINT IF EXISTS crm_pipelines_category_check;
ALTER TABLE crm_pipelines ADD CONSTRAINT crm_pipelines_category_check
  CHECK (category IN ('B2B_CORPORATE', 'CSR_NGO', 'RETAILER', 'FPO', 'INDIVIDUAL'));

INSERT INTO crm_pipelines (key, name, category, description, position, is_default) VALUES
  ('retail', 'Retail, FPO & farmers', 'RETAILER', 'Retailers, FPOs, farmers and other individuals: kits, clinic set-ups and testing services', 3, FALSE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO account_stages (name, slug, kind, color, position, is_default, default_probability, pipeline_id, requires_contact, requires_next_action)
SELECT s.name, s.slug, s.kind, s.color, s.position, FALSE, s.prob, p.id, FALSE, s.nextaction
  FROM crm_pipelines p,
       (VALUES ('New',             'retail-new',         'open', '#64748b', 201, 10,  FALSE),
               ('Interested',      'retail-interested',  'open', '#0ea5e9', 202, 30,  TRUE),
               ('Demo / visit',    'retail-demo',        'open', '#6366f1', 203, 50,  TRUE),
               ('Quotation sent',  'retail-quote',       'open', '#8b5cf6', 204, 65,  TRUE),
               ('Negotiation',     'retail-negotiation', 'open', '#f59e0b', 205, 80,  TRUE),
               ('Won',             'retail-won',         'won',  '#0ca30c', 206, 100, FALSE),
               ('Lost',            'retail-lost',        'lost', '#d03b3b', 207, 0,   FALSE))
         AS s(name, slug, kind, color, position, prob, nextaction)
 WHERE p.key = 'retail'
ON CONFLICT (slug) DO NOTHING;

-- ================================================================ scoring for the new categories

ALTER TABLE crm_scoring_models DROP CONSTRAINT IF EXISTS crm_scoring_models_category_check;
ALTER TABLE crm_scoring_models ADD CONSTRAINT crm_scoring_models_category_check
  CHECK (category IN ('B2B_CORPORATE', 'CSR_NGO', 'RETAILER', 'FPO', 'INDIVIDUAL'));

INSERT INTO crm_scoring_models (category, criteria)
SELECT c.category, '[
    {"key":"fit","label":"Right fit for a kit, clinic or service","weight":25},
    {"key":"need_clarity","label":"Knows what they need","weight":15},
    {"key":"budget","label":"Can invest","weight":15},
    {"key":"decision_maker","label":"Spoke to the person who decides","weight":15},
    {"key":"timeline","label":"When they want to start","weight":15},
    {"key":"recency","label":"Recent two-way contact","weight":10},
    {"key":"proposal_ready","label":"Ready for a quotation","weight":5}
  ]'::jsonb
  FROM (VALUES ('RETAILER'), ('FPO'), ('INDIVIDUAL')) AS c(category)
ON CONFLICT (category) DO NOTHING;

-- ================================================================ sources the enquiry forms name

INSERT INTO crm_sources (key, name, channel, position) VALUES
  ('instagram', 'Instagram', 'SOCIAL', 20),
  ('facebook',  'Facebook',  'SOCIAL', 21),
  ('google',    'Google search', 'WEBSITE', 22)
ON CONFLICT (key) DO NOTHING;

-- ================================================================ imports remember which preset read them

ALTER TABLE crm_import_jobs ADD COLUMN IF NOT EXISTS preset TEXT;
