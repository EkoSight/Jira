-- 026: email templates carry their own subject and preview text, and say
-- where they came from (designed here, copied from a starter, uploaded).
--
-- Additive: three nullable columns on a table added in 025. Nothing existing
-- changes.

ALTER TABLE mkt_templates ADD COLUMN IF NOT EXISTS subject   JSONB;
ALTER TABLE mkt_templates ADD COLUMN IF NOT EXISTS preheader JSONB;
ALTER TABLE mkt_templates ADD COLUMN IF NOT EXISTS source    TEXT;
