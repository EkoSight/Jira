-- My workspace: a personal home for every employee, one attention queue,
-- private reminders for any record, programme applications as a pipeline,
-- meetings still to arrange, and the origin gaps on leads and deals.
-- See docs/MY_WORKSPACE_PLAN.md.
--
-- Additive only. Every widened check keeps all of its old values. Two
-- columns on crm_meetings accept empty values from now on (scheduled_at,
-- account_id); every existing row already has both, so none changes, and a
-- new check keeps a time required for every status that had one.

-- ================================================================ layouts

-- One row per person, created the first time they save. A null layout means
-- "follow my team's template", so template edits still reach them.
CREATE TABLE IF NOT EXISTS user_dashboards (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL DEFAULT 0,
  layout      JSONB,
  -- the template the saved layout started from (shown, never enforced)
  based_on    TEXT,
  -- the person's own choice of home; null follows the rollout
  home        TEXT CHECK (home IN ('WORKSPACE', 'OVERVIEW')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Presentation only: which widgets, in which order. Never grants access.
CREATE TABLE IF NOT EXISTS dashboard_templates (
  id                   SERIAL PRIMARY KEY,
  key                  TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  description          TEXT,
  layout               JSONB NOT NULL,
  applies_departments  INTEGER[] NOT NULL DEFAULT '{}',
  applies_roles        TEXT[] NOT NULL DEFAULT '{}',
  position             INTEGER NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  version              INTEGER NOT NULL DEFAULT 1,
  updated_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO dashboard_templates (key, name, description, layout, applies_roles, position) VALUES
  ('everyone', 'Everyone', 'Today, what needs attention, my tasks and the deadlines coming up', '{"widgets":[
     {"id":"t1","type":"today","typeVersion":1,"width":"half","config":{}},
     {"id":"t2","type":"attention","typeVersion":1,"width":"half","config":{}},
     {"id":"t3","type":"my_tasks","typeVersion":1,"width":"full","config":{}},
     {"id":"t4","type":"deadlines","typeVersion":1,"width":"full","config":{}}]}', '{}', 1),
  ('partnerships', 'Partnerships and programmes', 'Applications, deals and meetings, with what is waiting on partners', '{"widgets":[
     {"id":"p1","type":"summary","typeVersion":1,"width":"full","config":{}},
     {"id":"p2","type":"attention","typeVersion":1,"width":"full","config":{}},
     {"id":"p3","type":"meetings","typeVersion":1,"width":"half","config":{}},
     {"id":"p4","type":"applications","typeVersion":1,"width":"half","config":{}},
     {"id":"p5","type":"deals","typeVersion":1,"width":"full","config":{}},
     {"id":"p6","type":"my_tasks","typeVersion":1,"width":"half","config":{}},
     {"id":"p7","type":"waiting","typeVersion":1,"width":"half","config":{}}]}', '{}', 2),
  ('callers', 'Callers', 'Calls to describe, leads to work and follow-ups', '{"widgets":[
     {"id":"c1","type":"today","typeVersion":1,"width":"half","config":{}},
     {"id":"c2","type":"calls_to_describe","typeVersion":1,"width":"half","config":{}},
     {"id":"c3","type":"leads_to_work","typeVersion":1,"width":"full","config":{}},
     {"id":"c4","type":"followups","typeVersion":1,"width":"half","config":{}},
     {"id":"c5","type":"attention","typeVersion":1,"width":"half","config":{}}]}', '{}', 3),
  ('managers', 'Managers and department heads', 'Decisions waiting, blocked and overdue work, team load', '{"widgets":[
     {"id":"m1","type":"decisions","typeVersion":1,"width":"half","config":{}},
     {"id":"m2","type":"attention","typeVersion":1,"width":"half","config":{}},
     {"id":"m3","type":"team_workload","typeVersion":1,"width":"full","config":{}},
     {"id":"m4","type":"deadlines","typeVersion":1,"width":"half","config":{"scope":"team"}},
     {"id":"m5","type":"key_results","typeVersion":1,"width":"half","config":{}}]}', '{manager}', 4),
  ('hr', 'HR and administration', 'Leave, extra time and holiday decisions, and today', '{"widgets":[
     {"id":"h1","type":"decisions","typeVersion":1,"width":"half","config":{}},
     {"id":"h2","type":"today","typeVersion":1,"width":"half","config":{}},
     {"id":"h3","type":"attention","typeVersion":1,"width":"full","config":{}},
     {"id":"h4","type":"my_tasks","typeVersion":1,"width":"full","config":{}}]}', '{admin}', 5),
  ('leadership', 'Leadership', 'The whole picture', '{"widgets":[
     {"id":"l1","type":"company_overview","typeVersion":1,"width":"full","config":{}},
     {"id":"l2","type":"decisions","typeVersion":1,"width":"half","config":{}},
     {"id":"l3","type":"key_results","typeVersion":1,"width":"half","config":{}},
     {"id":"l4","type":"deals","typeVersion":1,"width":"full","config":{}}]}', '{super_admin}', 6)
ON CONFLICT (key) DO NOTHING;

-- A personal snooze of one attention item: hides it from my queue until then.
-- The record, its dates and its state are untouched and visible elsewhere.
CREATE TABLE IF NOT EXISTS attention_snoozes (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key    TEXT NOT NULL,
  until       TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_key)
);

-- An optional personal timezone; null means the company calendar's.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;

-- ================================================================ reminders

-- A person's choices for one rule: on or off, the time of day, and Chat.
CREATE TABLE IF NOT EXISTS reminder_rule_prefs (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_key    TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL,
  at_time     TEXT CHECK (at_time IS NULL OR at_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  chat        BOOLEAN,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, rule_key)
);

-- "Remind me about this": private to its creator, kept only while they can
-- still see the record. Editing bumps the version (the old occurrence is
-- cancelled and a new one planned).
CREATE TABLE IF NOT EXISTS personal_reminders (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('TASK', 'LEAD', 'DEAL', 'APPLICATION', 'MEETING', 'ACCOUNT', 'KEY_RESULT', 'OBJECTIVE')),
  entity_id    INTEGER NOT NULL,
  remind_at    TIMESTAMPTZ NOT NULL,
  timezone     TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  note         TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DONE', 'CANCELLED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_reminders_user_idx ON personal_reminders (user_id, status, remind_at);
CREATE INDEX IF NOT EXISTS personal_reminders_entity_idx ON personal_reminders (entity_type, entity_id) WHERE status = 'ACTIVE';

-- One planned reminder for one person, record, rule and moment: the sibling of
-- task_reminders, for records other than tasks. The unique key makes a second
-- planner run, or a retry, add nothing.
CREATE TABLE IF NOT EXISTS reminder_occurrences (
  id                    BIGSERIAL PRIMARY KEY,
  recipient_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type           TEXT NOT NULL,
  entity_id             INTEGER NOT NULL,
  rule_key              TEXT NOT NULL,
  occurrence_key        TEXT NOT NULL,
  schedule_version      INTEGER NOT NULL DEFAULT 1,
  remind_at             TIMESTAMPTZ NOT NULL,
  -- what the words are built from, as planned (the date that drives it, why)
  facts                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED', 'WOULD_SEND')),
  reason                TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  sent_at               TIMESTAMPTZ,
  notification_id       INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  outbox_key            TEXT,
  personal_reminder_id  INTEGER REFERENCES personal_reminders(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipient_id, entity_type, entity_id, rule_key, occurrence_key, schedule_version)
);
CREATE INDEX IF NOT EXISTS reminder_occurrences_due_idx ON reminder_occurrences (remind_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS reminder_occurrences_entity_idx ON reminder_occurrences (entity_type, entity_id, status);
CREATE INDEX IF NOT EXISTS reminder_occurrences_recipient_idx ON reminder_occurrences (recipient_id, created_at DESC);

-- When each rule first ran: anything already due then is recorded as
-- skipped ("before launch") and never sent.
CREATE TABLE IF NOT EXISTS reminder_rule_launches (
  rule_key     TEXT PRIMARY KEY,
  launched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notifications: a link to any record, where they came from, and states
-- beyond read and unread. Every existing row stays valid (all null).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_id INTEGER;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS occurrence_id BIGINT REFERENCES reminder_occurrences(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS notifications_entity_idx ON notifications (entity_type, entity_id) WHERE entity_type IS NOT NULL;

-- Chat delivery of the new reminders; every kind allowed before still is
ALTER TABLE chat_outbox DROP CONSTRAINT IF EXISTS chat_outbox_kind_check;
ALTER TABLE chat_outbox ADD CONSTRAINT chat_outbox_kind_check
  CHECK (kind IN ('ALERT', 'DIGEST', 'TEAM_SUMMARY', 'TEST', 'WELCOME',
                  'STANDUP_REMINDER', 'STANDUP_POST', 'STANDUP_FEEDBACK', 'STANDUP_NUDGE', 'STANDUP_ESCALATION',
                  'CRM_REMINDER', 'CRM_DIGEST', 'TASK_REMINDER', 'BACKLOG_WEEKLY', 'WORKSPACE_REMINDER'));

-- ================================================================ applications

-- Programme applications are deals in their own pipeline; every category
-- allowed before still is
ALTER TABLE crm_pipelines DROP CONSTRAINT IF EXISTS crm_pipelines_category_check;
ALTER TABLE crm_pipelines ADD CONSTRAINT crm_pipelines_category_check
  CHECK (category IN ('B2B_CORPORATE', 'CSR_NGO', 'RETAILER', 'FPO', 'INDIVIDUAL', 'APPLICATIONS'));

INSERT INTO crm_pipelines (key, name, category, description, position, is_default) VALUES
  ('applications', 'Applications & programmes', 'APPLICATIONS',
   'Grants, incubators, accelerators, challenges, awards, tenders and government schemes', 4, FALSE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO account_stages (name, slug, kind, color, position, is_default, default_probability, pipeline_id, requires_contact, requires_next_action)
SELECT s.name, s.slug, s.kind, s.color, s.position, FALSE, s.prob, p.id, FALSE, FALSE
  FROM crm_pipelines p,
       (VALUES ('Considering',                    'app-considering',  'open', '#64748b', 301, 5),
               ('Preparing',                      'app-preparing',    'open', '#0ea5e9', 302, 20),
               ('Submitted (awaiting response)',  'app-submitted',    'open', '#6366f1', 303, 40),
               ('Under review',                   'app-review',       'open', '#8b5cf6', 304, 50),
               ('Further round',                  'app-further',      'open', '#f59e0b', 305, 65),
               ('Selected',                       'app-selected',     'won',  '#0ca30c', 306, 100),
               ('Not selected',                   'app-not-selected', 'lost', '#d03b3b', 307, 0),
               ('Withdrawn',                      'app-withdrawn',    'lost', '#8a8f98', 308, 0))
         AS s(name, slug, kind, color, position, prob)
 WHERE p.key = 'applications'
ON CONFLICT (slug) DO NOTHING;

-- What an application has that a deal does not
CREATE TABLE IF NOT EXISTS opportunity_applications (
  opportunity_id        INTEGER PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  application_type      TEXT NOT NULL DEFAULT 'OTHER'
                        CHECK (application_type IN ('GRANT', 'INCUBATION', 'ACCELERATION', 'CHALLENGE', 'AWARD', 'TENDER', 'GOVERNMENT_SCHEME', 'OTHER')),
  opportunity_url       TEXT,
  -- either a date (no closing time given) or an exact instant with its zone
  deadline_date         DATE,
  deadline_at           TIMESTAMPTZ,
  deadline_timezone     TEXT,
  -- set only by "Mark submitted", with the real date
  submitted_on          DATE,
  submitted_recorded_at TIMESTAMPTZ,
  submitted_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_link        TEXT,
  acknowledged_on       DATE,
  reference             TEXT,
  expected_response_on  DATE,
  next_check_on         DATE,
  next_check_source     TEXT CHECK (next_check_source IN ('PERSON', 'FOLLOW_UP')),
  last_update_at        TIMESTAMPTZ,
  last_update_type      TEXT,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (deadline_date IS NULL OR deadline_at IS NULL),
  CHECK (deadline_at IS NULL OR deadline_timezone IS NOT NULL)
);

-- What happened after submission. An acknowledgement and a follow-up we sent
-- are not substantive updates; a response or an outcome is.
CREATE TABLE IF NOT EXISTS application_updates (
  id              SERIAL PRIMARY KEY,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('ACKNOWLEDGEMENT', 'FOLLOW_UP_SENT', 'RESPONSE', 'OUTCOME')),
  happened_on     DATE NOT NULL,
  summary         TEXT,
  reference       TEXT,
  next_check_on   DATE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS application_updates_idx ON application_updates (opportunity_id, happened_on DESC);

-- Each further round keeps its own deadline and meeting; the original
-- deadline is never overwritten
CREATE TABLE IF NOT EXISTS application_rounds (
  id                 SERIAL PRIMARY KEY,
  opportunity_id     INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  deadline_date      DATE,
  deadline_at        TIMESTAMPTZ,
  deadline_timezone  TEXT,
  meeting_id         INTEGER REFERENCES crm_meetings(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUBMITTED', 'DONE', 'CANCELLED')),
  submitted_on       DATE,
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (deadline_date IS NULL OR deadline_at IS NULL),
  CHECK (deadline_at IS NULL OR deadline_timezone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS application_rounds_idx ON application_rounds (opportunity_id, created_at);

-- ================================================================ meetings

-- Still to arrange, and a time proposed but not confirmed; every status
-- allowed before still is
ALTER TABLE crm_meetings DROP CONSTRAINT IF EXISTS crm_meetings_status_check;
ALTER TABLE crm_meetings ADD CONSTRAINT crm_meetings_status_check
  CHECK (status IN ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED', 'TO_ARRANGE', 'TIME_PROPOSED'));

-- A meeting to arrange has no time yet, and an internal meeting has no
-- organisation. Every existing row has both; the check below keeps a time
-- required for every status that needed one.
ALTER TABLE crm_meetings ALTER COLUMN scheduled_at DROP NOT NULL;
ALTER TABLE crm_meetings ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE crm_meetings DROP CONSTRAINT IF EXISTS crm_meetings_time_check;
ALTER TABLE crm_meetings ADD CONSTRAINT crm_meetings_time_check
  CHECK (scheduled_at IS NOT NULL OR status IN ('TO_ARRANGE', 'TIME_PROPOSED', 'CANCELLED'));

ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS arrange_by DATE;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS scheduling_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL;
-- a time put to the other side, not yet confirmed (never shown as booked)
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS crm_meetings_arrange_idx ON crm_meetings (scheduling_owner_id, arrange_by)
  WHERE status IN ('TO_ARRANGE', 'TIME_PROPOSED');
CREATE INDEX IF NOT EXISTS crm_meetings_owner_time_idx ON crm_meetings (owner_user_id, scheduled_at);
CREATE INDEX IF NOT EXISTS crm_meetings_lead_idx ON crm_meetings (lead_id) WHERE lead_id IS NOT NULL;

-- ================================================================ leads and deals

-- Who introduced it: a colleague or a contact, beside the free-text referral
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS introduced_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS introduced_by_contact_id INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS introduced_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS introduced_by_contact_id INTEGER REFERENCES account_contacts(id) ON DELETE SET NULL;

-- The last time they reached us, kept apart from our attempts to reach them
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS last_incoming_at TIMESTAMPTZ;
-- filled once from the inbound activity already recorded, and from nothing else
UPDATE crm_leads l SET last_incoming_at = a.last_in
  FROM (SELECT lead_id, MAX(occurred_at) AS last_in FROM crm_lead_activities WHERE direction = 'INBOUND' GROUP BY lead_id) a
 WHERE a.lead_id = l.id AND l.last_incoming_at IS NULL;

-- ================================================================ indexes for the widgets

CREATE INDEX IF NOT EXISTS opportunities_owner_open_idx ON opportunities (owner_user_id, pipeline_id) WHERE is_archived = FALSE;
CREATE INDEX IF NOT EXISTS tasks_assignee_due_idx ON tasks (assignee_id, due_date) WHERE is_archived = FALSE;
CREATE INDEX IF NOT EXISTS tasks_created_by_idx ON tasks (created_by) WHERE is_archived = FALSE;
