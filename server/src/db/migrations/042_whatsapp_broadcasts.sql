-- WhatsApp broadcasts: one approved template to a filtered list of CRM leads,
-- only to numbers that agreed to WhatsApp messages (docs/WHATSAPP_BROADCASTS.md).
-- Additive only: new tables, new nullable columns, new indexes.

-- Who agreed to get WhatsApp messages from us, by number, with how and when.
-- A WhatsApp opt-out (crm_optouts) always wins over an opt-in. Someone who
-- wrote to us on WhatsApp first also counts; that is read from the messages,
-- not stored here.
CREATE TABLE IF NOT EXISTS crm_wa_optins (
  id                SERIAL PRIMARY KEY,
  phone_normalized  TEXT NOT NULL,
  lead_id           INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  how               TEXT NOT NULL CHECK (how IN ('ON_CALL', 'IN_PERSON', 'FORM', 'IMPORT', 'OTHER')),
  note              TEXT,
  recorded_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at        TIMESTAMPTZ,
  removed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  removed_reason    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_wa_optins_active_idx ON crm_wa_optins (phone_normalized) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_wa_optins_lead_idx ON crm_wa_optins (lead_id);

-- A broadcast: the list (the lead list's own filters), the template and what
-- fills each of its blanks. Approval is of exactly that, by its fingerprint.
CREATE TABLE IF NOT EXISTS crm_wa_broadcasts (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'SENDING', 'PAUSED', 'SENT', 'CANCELLED')),
  filters               JSONB NOT NULL DEFAULT '{}'::jsonb,
  template_name         TEXT,
  template_language     TEXT,
  variables             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- whose view of the CRM the list is taken from
  owner_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at          TIMESTAMPTZ,
  approved_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMPTZ,
  approved_fingerprint  TEXT,
  approved_count        INTEGER,
  review_note           TEXT,
  send_at               TIMESTAMPTZ,
  started_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at            TIMESTAMPTZ,
  paused_at             TIMESTAMPTZ,
  pause_reason          TEXT,
  finished_at           TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_wa_broadcasts_status_idx ON crm_wa_broadcasts (status);

-- Who a broadcast went to, or why not: worked out when sending starts.
CREATE TABLE IF NOT EXISTS crm_wa_broadcast_recipients (
  id                SERIAL PRIMARY KEY,
  broadcast_id      INTEGER NOT NULL REFERENCES crm_wa_broadcasts(id),
  lead_id           INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  phone_normalized  TEXT,
  variables         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  reason            TEXT,
  message_id        INTEGER REFERENCES crm_wa_messages(id) ON DELETE SET NULL,
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_wa_broadcast_recipients_lead_idx ON crm_wa_broadcast_recipients (broadcast_id, lead_id);
-- one message per number per broadcast
CREATE UNIQUE INDEX IF NOT EXISTS crm_wa_broadcast_recipients_phone_idx
  ON crm_wa_broadcast_recipients (broadcast_id, phone_normalized) WHERE status <> 'SKIPPED';
CREATE INDEX IF NOT EXISTS crm_wa_broadcast_recipients_status_idx ON crm_wa_broadcast_recipients (broadcast_id, status);

-- the broadcast a message belongs to (none for one-to-one messages)
ALTER TABLE crm_wa_messages ADD COLUMN IF NOT EXISTS broadcast_id INTEGER REFERENCES crm_wa_broadcasts(id);
CREATE INDEX IF NOT EXISTS crm_wa_messages_broadcast_idx ON crm_wa_messages (broadcast_id, created_at) WHERE broadcast_id IS NOT NULL;

-- an optional "Send me updates on WhatsApp" tick box on a hosted enquiry form
ALTER TABLE crm_capture_forms ADD COLUMN IF NOT EXISTS whatsapp_optin_text TEXT;
