-- 025: email marketing.
--
-- One deduplicated contact database (one row per email address), linked to the
-- CRM's organizations and people where they exist; audiences a contact can
-- belong to several of; consent and suppression records; templates, campaigns,
-- automations, every message sent and every event that came back.
--
-- Additive: new tables only, plus one more allowed value in the timeline's
-- activity types. Nothing existing is changed, removed or rewritten.

-- ------------------------------------------------- contacts

CREATE TABLE IF NOT EXISTS mkt_contacts (
  id                 SERIAL PRIMARY KEY,
  email              TEXT NOT NULL,
  -- lower-cased and trimmed: the one key a person is deduplicated on
  email_normalized   TEXT NOT NULL,
  first_name         TEXT,
  last_name          TEXT,
  phone              TEXT,
  organization       TEXT,
  designation        TEXT,
  city               TEXT,
  state              TEXT,
  country            TEXT,
  -- which language they read: content written in both is sent in this one
  language           TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi')),
  tags               TEXT[] NOT NULL DEFAULT '{}',
  custom             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- where they are in TaskFlow, when they are there
  account_id         INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  crm_contact_id     INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL,
  owner_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source             TEXT NOT NULL DEFAULT 'MANUAL'
                     CHECK (source IN ('MANUAL', 'IMPORT', 'FORM', 'CRM_SYNC', 'API')),
  -- whether the address itself can be mailed, across every audience
  email_status       TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK (email_status IN ('ACTIVE', 'BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED', 'INVALID')),
  unsubscribed_all_at TIMESTAMPTZ,
  soft_bounces       INTEGER NOT NULL DEFAULT 0,
  engagement_score   INTEGER NOT NULL DEFAULT 0 CHECK (engagement_score BETWEEN 0 AND 100),
  best_send_hour     SMALLINT CHECK (best_send_hour BETWEEN 0 AND 23),
  last_sent_at       TIMESTAMPTZ,
  last_opened_at     TIMESTAMPTZ,
  last_clicked_at    TIMESTAMPTZ,
  last_replied_at    TIMESTAMPTZ,
  last_converted_at  TIMESTAMPTZ,
  is_archived        BOOLEAN NOT NULL DEFAULT FALSE,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_contacts_email_idx ON mkt_contacts (email_normalized);
CREATE INDEX IF NOT EXISTS mkt_contacts_account_idx ON mkt_contacts (account_id);
CREATE INDEX IF NOT EXISTS mkt_contacts_crm_contact_idx ON mkt_contacts (crm_contact_id);
CREATE INDEX IF NOT EXISTS mkt_contacts_tags_idx ON mkt_contacts USING GIN (tags);

-- custom fields: the definitions; the values live in mkt_contacts.custom
CREATE TABLE IF NOT EXISTS mkt_fields (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'TEXT' CHECK (type IN ('TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN')),
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,
  position    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mkt_fields (key, label, type, options, position) VALUES
  ('district',        'District',               'TEXT',   '[]', 1),
  ('crops',           'Crops grown',            'TEXT',   '[]', 2),
  ('land_acres',      'Land (acres)',           'NUMBER', '[]', 3),
  ('fpo_name',        'FPO name',               'TEXT',   '[]', 4),
  ('college',         'College / institute',    'TEXT',   '[]', 5),
  ('course',          'Course',                 'TEXT',   '[]', 6),
  ('graduation_year', 'Graduation year',        'NUMBER', '[]', 7),
  ('interest',        'Interested in',          'SELECT', '["Jobs","Internships","Training"]', 8),
  ('dealer_code',     'Dealer code',            'TEXT',   '[]', 9),
  ('birthday',        'Birthday',               'DATE',   '[]', 10)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------- audiences

CREATE TABLE IF NOT EXISTS mkt_audiences (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL DEFAULT 'CUSTOM'
                 CHECK (kind IN ('CUSTOMERS', 'LEADS', 'FPOS', 'STUDENTS', 'FARMERS', 'PARTNERS', 'DEALERS', 'CUSTOM')),
  description    TEXT,
  -- what people on it are sent, said on forms and the preference page
  purpose        TEXT,
  -- confirm by email before anyone joining through a form is mailed
  double_opt_in  BOOLEAN NOT NULL DEFAULT TRUE,
  -- who the CRM keeps on it: { account_types: [...], account_tags: [...], segment_ids: [...] }
  crm_sync       JSONB,
  -- the status a contact the CRM adds starts in
  crm_sync_status TEXT NOT NULL DEFAULT 'SUBSCRIBED' CHECK (crm_sync_status IN ('SUBSCRIBED', 'PENDING')),
  from_name      TEXT,
  from_email     TEXT,
  reply_to       TEXT,
  color          TEXT,
  is_archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mkt_audiences (name, slug, kind, description, purpose, double_opt_in, crm_sync, color) VALUES
  ('Customers', 'customers', 'CUSTOMERS', 'People at organizations that are customers in the pipeline',
   'Festival and seasonal greetings, newsletters and product news', FALSE, '{"account_types":["CUSTOMER"]}', '#16a34a'),
  ('Leads', 'leads', 'LEADS', 'People at organizations that are leads in the pipeline',
   'Follow-ups, product information and case studies', FALSE, '{"account_types":["LEAD"]}', '#2a78d6'),
  ('FPOs', 'fpos', 'FPOS', 'Farmer producer organizations',
   'Industry updates, schemes and soil-health advisories', FALSE, '{"account_tags":["fpo"]}', '#ca8a04'),
  ('Students', 'students', 'STUDENTS', 'Students and graduates who signed up',
   'Jobs, internships and training programmes', TRUE, NULL, '#7c3aed'),
  ('Farmers', 'farmers', 'FARMERS', 'Farmers who asked to hear from us',
   'Soil-health tips, seasonal crop advice and offers', TRUE, NULL, '#0d9488'),
  ('Partners', 'partners', 'PARTNERS', 'People at partner organizations in the pipeline',
   'Partner updates and joint programmes', FALSE, '{"account_types":["PARTNER"]}', '#db2777'),
  ('Dealers', 'dealers', 'DEALERS', 'Dealers and distributors',
   'Stock, pricing and scheme updates', FALSE, '{"account_tags":["dealer","distributor"]}', '#ea580c')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS mkt_memberships (
  audience_id      INTEGER NOT NULL REFERENCES mkt_audiences(id) ON DELETE CASCADE,
  contact_id       INTEGER NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  -- ARCHIVED: the CRM no longer puts them on this audience (not an unsubscribe)
  status           TEXT NOT NULL DEFAULT 'SUBSCRIBED'
                   CHECK (status IN ('SUBSCRIBED', 'PENDING', 'UNSUBSCRIBED', 'CLEANED', 'ARCHIVED')),
  source           TEXT NOT NULL DEFAULT 'MANUAL',
  synced           BOOLEAN NOT NULL DEFAULT FALSE,
  subscribed_at    TIMESTAMPTZ,
  confirmed_at     TIMESTAMPTZ,
  unsubscribed_at  TIMESTAMPTZ,
  unsubscribe_reason TEXT,
  confirm_token    TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (audience_id, contact_id)
);
CREATE INDEX IF NOT EXISTS mkt_memberships_contact_idx ON mkt_memberships (contact_id);

-- subscription preferences: what a contact may be emailed about
CREATE TABLE IF NOT EXISTS mkt_topics (
  id           SERIAL PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  name_hi      TEXT,
  description  TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mkt_topics (key, name, name_hi, description, position) VALUES
  ('newsletter',  'Newsletter',                      'न्यूज़लेटर',                'News from EkoSight and Soil Doctor', 1),
  ('greetings',   'Festival and seasonal greetings', 'त्योहार और मौसमी शुभकामनाएँ', 'Greetings on festivals and at the start of each season', 2),
  ('product',     'Product updates and offers',      'उत्पाद जानकारी और ऑफ़र',     'New features, devices and offers', 3),
  ('industry',    'Industry updates',                'उद्योग समाचार',              'Schemes, policy and soil-health news for FPOs and partners', 4),
  ('careers',     'Jobs, internships and training',  'नौकरी, इंटर्नशिप और प्रशिक्षण', 'Openings and training programmes', 5),
  ('advisory',    'Crop and soil advisories',        'फसल और मिट्टी सलाह',          'Seasonal advice for farmers', 6)
ON CONFLICT (key) DO NOTHING;

-- absent row: on (they receive the topic while subscribed)
CREATE TABLE IF NOT EXISTS mkt_contact_topics (
  contact_id  INTEGER NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  topic_id    INTEGER NOT NULL REFERENCES mkt_topics(id) ON DELETE CASCADE,
  opted_in    BOOLEAN NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, topic_id)
);

-- consent: every subscribe, confirmation and unsubscribe, with how it happened.
-- Append only.
CREATE TABLE IF NOT EXISTS mkt_consents (
  id           BIGSERIAL PRIMARY KEY,
  contact_id   INTEGER NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  audience_id  INTEGER REFERENCES mkt_audiences(id) ON DELETE SET NULL,
  topic_id     INTEGER REFERENCES mkt_topics(id) ON DELETE SET NULL,
  action       TEXT NOT NULL CHECK (action IN (
                 'SUBSCRIBE', 'PENDING', 'CONFIRM', 'UNSUBSCRIBE', 'UNSUBSCRIBE_ALL', 'RESUBSCRIBE',
                 'TOPIC_IN', 'TOPIC_OUT', 'SUPPRESS', 'UNSUPPRESS', 'ARCHIVE')),
  source       TEXT NOT NULL,
  -- the legal basis claimed, in plain words
  basis        TEXT,
  consent_text TEXT,
  ip           TEXT,
  user_agent   TEXT,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_consents_contact_idx ON mkt_consents (contact_id, created_at DESC);

-- addresses that are never mailed again by any campaign or automation
CREATE TABLE IF NOT EXISTS mkt_suppressions (
  email_normalized TEXT PRIMARY KEY,
  reason      TEXT NOT NULL CHECK (reason IN ('HARD_BOUNCE', 'SOFT_BOUNCES', 'COMPLAINT', 'UNSUBSCRIBED_ALL', 'MANUAL', 'INVALID')),
  source      TEXT NOT NULL,
  note        TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mkt_segments (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  audience_id  INTEGER REFERENCES mkt_audiences(id) ON DELETE SET NULL,
  rules        JSONB NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mkt_forms (
  id              SERIAL PRIMARY KEY,
  -- the public address of the form; random so forms cannot be enumerated
  public_id       TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  audience_id     INTEGER NOT NULL REFERENCES mkt_audiences(id) ON DELETE CASCADE,
  title           TEXT,
  intro           TEXT,
  fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
  topic_ids       INTEGER[] NOT NULL DEFAULT '{}',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  language        TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi')),
  consent_text    TEXT NOT NULL,
  success_message TEXT,
  redirect_url    TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  submissions     INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mkt_imports (
  id            SERIAL PRIMARY KEY,
  filename      TEXT,
  audience_id   INTEGER REFERENCES mkt_audiences(id) ON DELETE SET NULL,
  status_given  TEXT NOT NULL,
  basis         TEXT NOT NULL,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  totals        JSONB NOT NULL DEFAULT '{}'::jsonb,
  problems      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- images used in emails: kept in the database, so a deploy never loses them,
-- and served from a public address because mail clients fetch them
CREATE TABLE IF NOT EXISTS mkt_assets (
  id          SERIAL PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  data        BYTEA NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------- content

CREATE TABLE IF NOT EXISTS mkt_templates (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'GENERAL',
  description  TEXT,
  design       JSONB NOT NULL,
  is_archived  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mkt_campaigns (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'SENDING', 'TESTING',
                                     'SENT', 'PAUSED', 'CANCELLED')),
  audience_id      INTEGER REFERENCES mkt_audiences(id) ON DELETE SET NULL,
  segment_id       INTEGER REFERENCES mkt_segments(id) ON DELETE SET NULL,
  topic_id         INTEGER REFERENCES mkt_topics(id) ON DELETE SET NULL,
  subject          TEXT,
  subject_hi       TEXT,
  preheader        TEXT,
  preheader_hi     TEXT,
  from_name        TEXT,
  from_email       TEXT,
  reply_to         TEXT,
  design           JSONB NOT NULL DEFAULT '{"blocks":[]}'::jsonb,
  -- who is responsible, the work it belongs to, and when it must go out by
  owner_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  task_id          INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  deadline         TIMESTAMPTZ,
  scheduled_at     TIMESTAMPTZ,
  -- NOW | SCHEDULED | OPTIMIZED (each person at the hour they usually open)
  send_strategy    TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (send_strategy IN ('NOW', 'SCHEDULED', 'OPTIMIZED')),
  ab_test          JSONB,
  follow_up        JSONB NOT NULL DEFAULT '{"on_click":false,"on_reply":true,"on_conversion":true,"assign":"CONTACT_OWNER","due_days":2}'::jsonb,
  conversion_window_days INTEGER NOT NULL DEFAULT 30,
  track_opens      BOOLEAN NOT NULL DEFAULT TRUE,
  track_clicks     BOOLEAN NOT NULL DEFAULT TRUE,
  submitted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at     TIMESTAMPTZ,
  approved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  review_note      TEXT,
  -- what the approver saw: a later edit sends it back for review
  approved_fingerprint TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  recipient_count  INTEGER,
  is_archived      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_campaigns_status_idx ON mkt_campaigns (status, scheduled_at);

-- A/B and multivariate versions of a campaign: each may change the subject,
-- the sender name, the preview text and the content
CREATE TABLE IF NOT EXISTS mkt_campaign_variants (
  id           SERIAL PRIMARY KEY,
  campaign_id  INTEGER NOT NULL REFERENCES mkt_campaigns(id) ON DELETE CASCADE,
  key          TEXT NOT NULL CHECK (key ~ '^[A-H]$'),
  subject      TEXT,
  subject_hi   TEXT,
  preheader    TEXT,
  from_name    TEXT,
  design       JSONB,
  UNIQUE (campaign_id, key)
);

-- ------------------------------------------------- automations

CREATE TABLE IF NOT EXISTS mkt_workflows (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED')),
  audience_id   INTEGER REFERENCES mkt_audiences(id) ON DELETE SET NULL,
  topic_id      INTEGER REFERENCES mkt_topics(id) ON DELETE SET NULL,
  trigger       JSONB NOT NULL,
  graph         JSONB NOT NULL DEFAULT '{"start":null,"nodes":{}}'::jsonb,
  -- whether someone can go through it again (each run has its own key)
  allow_reentry BOOLEAN NOT NULL DEFAULT FALSE,
  from_name     TEXT,
  from_email    TEXT,
  reply_to      TEXT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- the same review as a campaign before it can start mailing anyone
  submitted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at  TIMESTAMPTZ,
  approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at   TIMESTAMPTZ,
  approved_fingerprint TEXT,
  review_note   TEXT,
  activated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  activated_at  TIMESTAMPTZ,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mkt_enrollments (
  id            BIGSERIAL PRIMARY KEY,
  workflow_id   INTEGER NOT NULL REFERENCES mkt_workflows(id) ON DELETE CASCADE,
  contact_id    INTEGER NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  -- one run per key: 'once', 'festival:12', 'event:340' — so nobody goes through twice by accident
  run_key       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED', 'EXITED', 'FAILED')),
  current_node  TEXT,
  next_run_at   TIMESTAMPTZ,
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  history       JSONB NOT NULL DEFAULT '[]'::jsonb,
  exit_reason   TEXT,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  UNIQUE (workflow_id, contact_id, run_key)
);
CREATE INDEX IF NOT EXISTS mkt_enrollments_due_idx ON mkt_enrollments (next_run_at) WHERE status = 'ACTIVE';

-- festival and season dates, set per year. A date nobody has confirmed never
-- starts an automation.
CREATE TABLE IF NOT EXISTS mkt_festivals (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  name_hi       TEXT,
  date          DATE NOT NULL,
  region        TEXT,
  is_confirmed  BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, date)
);

-- fixed-date days are confirmed; lunar-calendar festivals move every year and
-- wait for a person to check the date
INSERT INTO mkt_festivals (name, name_hi, date, region, is_confirmed, notes) VALUES
  ('Christmas',        'क्रिसमस',          '2026-12-25', 'All India', TRUE,  NULL),
  ('New Year',         'नया साल',          '2027-01-01', 'All India', TRUE,  NULL),
  ('Republic Day',     'गणतंत्र दिवस',      '2027-01-26', 'All India', TRUE,  NULL),
  ('Independence Day', 'स्वतंत्रता दिवस',     '2027-08-15', 'All India', TRUE,  NULL),
  ('Diwali',           'दीपावली',          '2026-11-08', 'All India', FALSE, 'Lunar calendar: check the date before confirming'),
  ('Makar Sankranti / Pongal', 'मकर संक्रांति / पोंगल', '2027-01-14', 'All India', FALSE, 'Check the date for the year and region'),
  ('Holi',             'होली',             '2027-03-22', 'North India', FALSE, 'Lunar calendar: check the date before confirming'),
  ('Kharif sowing season', 'खरीफ बुवाई',      '2027-06-01', 'All India', FALSE, 'Season start; set to suit the region'),
  ('Rabi sowing season',   'रबी बुवाई',       '2026-10-15', 'All India', FALSE, 'Season start; set to suit the region')
ON CONFLICT (name, date) DO NOTHING;

-- ------------------------------------------------- messages and what came back

CREATE TABLE IF NOT EXISTS mkt_messages (
  id                  BIGSERIAL PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('CAMPAIGN', 'AUTOMATION', 'TEST', 'CONFIRMATION')),
  campaign_id         INTEGER REFERENCES mkt_campaigns(id) ON DELETE CASCADE,
  variant             TEXT,
  workflow_id         INTEGER REFERENCES mkt_workflows(id) ON DELETE CASCADE,
  workflow_node       TEXT,
  enrollment_id       BIGINT REFERENCES mkt_enrollments(id) ON DELETE CASCADE,
  audience_id         INTEGER REFERENCES mkt_audiences(id) ON DELETE SET NULL,
  contact_id          INTEGER REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  -- HELD: waiting for an A/B test to pick the version it gets
  status              TEXT NOT NULL DEFAULT 'QUEUED'
                      CHECK (status IN ('HELD', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED',
                                        'COMPLAINED', 'FAILED', 'SKIPPED', 'CANCELLED')),
  skip_reason         TEXT,
  -- in links and the unsubscribe address; random, never a sequence
  token               TEXT NOT NULL UNIQUE,
  -- in the Reply-To address, so a reply is matched to the message it answers
  reply_code          TEXT NOT NULL UNIQUE,
  language            TEXT,
  subject             TEXT,
  scheduled_for       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ,
  locked_until        TIMESTAMPTZ,
  last_error          TEXT,
  provider            TEXT,
  provider_message_id TEXT,
  test_payload        JSONB,
  queued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  first_opened_at     TIMESTAMPTZ,
  first_clicked_at    TIMESTAMPTZ,
  replied_at          TIMESTAMPTZ,
  converted_at        TIMESTAMPTZ,
  unsubscribed_at     TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  complained_at       TIMESTAMPTZ,
  open_count          INTEGER NOT NULL DEFAULT 0,
  click_count         INTEGER NOT NULL DEFAULT 0
);
-- one copy of a campaign per person, however often it is started
CREATE UNIQUE INDEX IF NOT EXISTS mkt_messages_campaign_contact_idx
  ON mkt_messages (campaign_id, contact_id) WHERE kind = 'CAMPAIGN';
-- one email per step of an automation run
CREATE UNIQUE INDEX IF NOT EXISTS mkt_messages_enrollment_node_idx
  ON mkt_messages (enrollment_id, workflow_node) WHERE kind = 'AUTOMATION';
CREATE INDEX IF NOT EXISTS mkt_messages_queue_idx ON mkt_messages (scheduled_for) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS mkt_messages_provider_idx ON mkt_messages (provider_message_id);
CREATE INDEX IF NOT EXISTS mkt_messages_contact_idx ON mkt_messages (contact_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS mkt_links (
  id           SERIAL PRIMARY KEY,
  campaign_id  INTEGER REFERENCES mkt_campaigns(id) ON DELETE CASCADE,
  workflow_id  INTEGER REFERENCES mkt_workflows(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_links_owner_url_idx
  ON mkt_links (COALESCE(campaign_id, 0), COALESCE(workflow_id, 0), md5(url));

CREATE TABLE IF NOT EXISTS mkt_events (
  id                 BIGSERIAL PRIMARY KEY,
  type               TEXT NOT NULL CHECK (type IN (
                       'SENT', 'DELIVERED', 'DEFERRED', 'BOUNCE_HARD', 'BOUNCE_SOFT', 'COMPLAINT', 'REJECTED',
                       'FAILED', 'OPEN', 'CLICK', 'UNSUBSCRIBE', 'REPLY', 'CONVERSION')),
  message_id         BIGINT REFERENCES mkt_messages(id) ON DELETE CASCADE,
  contact_id         INTEGER REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  campaign_id        INTEGER REFERENCES mkt_campaigns(id) ON DELETE CASCADE,
  workflow_id        INTEGER REFERENCES mkt_workflows(id) ON DELETE CASCADE,
  link_id            INTEGER REFERENCES mkt_links(id) ON DELETE SET NULL,
  url                TEXT,
  -- where the fact came from: the provider's own report, our tracking, a mailbox, the CRM, a person
  source             TEXT NOT NULL,
  provider_event_id  TEXT,
  -- an open or click a mail system or link scanner made, not a person
  is_machine         BOOLEAN NOT NULL DEFAULT FALSE,
  ip                 TEXT,
  user_agent         TEXT,
  value              NUMERIC(16, 2),
  meta               JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- a provider retrying a webhook does not record the same thing twice
CREATE UNIQUE INDEX IF NOT EXISTS mkt_events_provider_idx ON mkt_events (provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mkt_events_campaign_idx ON mkt_events (campaign_id, type, occurred_at);
CREATE INDEX IF NOT EXISTS mkt_events_contact_idx ON mkt_events (contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS mkt_events_message_idx ON mkt_events (message_id);

-- follow-up tasks made from campaign activity: one per person, campaign and reason
CREATE TABLE IF NOT EXISTS mkt_followups (
  id           SERIAL PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,
  contact_id   INTEGER REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  campaign_id  INTEGER REFERENCES mkt_campaigns(id) ON DELETE SET NULL,
  workflow_id  INTEGER REFERENCES mkt_workflows(id) ON DELETE SET NULL,
  message_id   BIGINT REFERENCES mkt_messages(id) ON DELETE SET NULL,
  reason       TEXT NOT NULL,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- what happened to a contact outside email: joined or left an audience, a tag,
-- a form, a field, and TaskFlow events about their organization. Automations
-- start from these, read in order.
CREATE TABLE IF NOT EXISTS mkt_contact_activity (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('CREATED', 'JOINED', 'LEFT', 'TAG_ADDED', 'TAG_REMOVED', 'FORM_SUBMITTED',
                                            'FIELD_UPDATED', 'TASKFLOW_EVENT', 'ENROLLED', 'NOTE')),
  audience_id INTEGER REFERENCES mkt_audiences(id) ON DELETE SET NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_contact_activity_contact_idx ON mkt_contact_activity (contact_id, created_at DESC);

-- how far the worker has read: TaskFlow's own changes (by time) and contact
-- activity (by position)
CREATE TABLE IF NOT EXISTS mkt_cursors (
  key         TEXT PRIMARY KEY,
  value       TIMESTAMPTZ,
  position    BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------- the CRM timeline

-- Campaign activity appears in an organization's history as its own type, so
-- it is never counted as a salesperson's touch or moves a deal's clocks.
ALTER TABLE account_activities DROP CONSTRAINT IF EXISTS account_activities_type_check;
ALTER TABLE account_activities ADD CONSTRAINT account_activities_type_check
  CHECK (type IN ('NOTE', 'EMAIL', 'CALL', 'PPT', 'PROPOSAL', 'MEETING', 'DEMO',
                  'IN_PERSON', 'SUMMARY', 'STAGE_CHANGE', 'CONVERTED',
                  'TASK_DONE', 'ORDER', 'INVOICE', 'PAYMENT', 'HANDOVER', 'NEXT_ACTION',
                  'CAMPAIGN'));

-- Start the TaskFlow cursors now: changes from before this upgrade are history,
-- not new events, and never start an automation.
INSERT INTO mkt_cursors (key, value, position) VALUES
  ('lead_created', now(), NULL), ('became_customer', now(), NULL), ('deal_stage', now(), NULL),
  ('task_completed', now(), NULL), ('crm_contacts', to_timestamp(0), NULL), ('activity', NULL, 0)
ON CONFLICT (key) DO NOTHING;
