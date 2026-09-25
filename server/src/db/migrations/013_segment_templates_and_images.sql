-- The dossier, finished.
--
-- Two things the profile needs and did not have:
--
--   1. Segment templates. A CSR team and an input manufacturer are not asked the
--      same questions, so each segment carries the handful of scope fields that
--      actually matter for that kind of partner. They are PROMPTS, not required
--      fields — a partner who does not fit the template is still a partner, and
--      an unanswered prompt is left blank rather than guessed at.
--
--   2. A place for an uploaded logo or banner. The existing logo_url and
--      banner_url columns stay exactly as they are and still hold a pasted
--      external address; an upload is recorded here instead, so a lead can have
--      either without one silently overwriting the other.
--
-- Additive only. No existing column is touched, and a segment somebody has
-- already customised is left alone.

-- ---------------------------------------------------------------- templates

UPDATE crm_segments SET scope_template = $json$[
  {"key":"budget_cycle","label":"Budget cycle","hint":"Which financial year, and when it is committed"},
  {"key":"districts","label":"Districts or blocks","hint":"Where the programme runs"},
  {"key":"farmers","label":"Farmers to reach","hint":"Their number, not our estimate"},
  {"key":"impact_metrics","label":"Impact they must report","hint":"What their CSR report has to show"},
  {"key":"reporting_cadence","label":"Reporting cadence","hint":"Monthly, quarterly, end of programme"},
  {"key":"co_branding","label":"Co-branding expected","hint":"Whose name appears on what"}
]$json$::jsonb
WHERE slug = 'csr' AND scope_template = '[]'::jsonb;

UPDATE crm_segments SET scope_template = $json$[
  {"key":"programme_theme","label":"Programme theme","hint":"Soil health, water, livelihoods…"},
  {"key":"grant_cycle","label":"Grant cycle","hint":"When proposals are accepted and decided"},
  {"key":"districts","label":"Districts or blocks","hint":"Where it would run"},
  {"key":"farmers","label":"Farmers to reach","hint":""},
  {"key":"me_requirements","label":"Monitoring & evaluation","hint":"What evidence they need, and who verifies it"},
  {"key":"partners","label":"Implementation partners","hint":"Who else is involved on the ground"}
]$json$::jsonb
WHERE slug = 'foundation' AND scope_template = '[]'::jsonb;

UPDATE crm_segments SET scope_template = $json$[
  {"key":"districts","label":"Districts or blocks","hint":"Where they already work"},
  {"key":"field_staff","label":"Field staff available","hint":"Who would actually hold the device"},
  {"key":"farmer_groups","label":"Farmer groups or FPOs","hint":"How farmers are organised"},
  {"key":"training_needs","label":"Training needed","hint":"How much, in which language"},
  {"key":"languages","label":"Languages","hint":"What the advisory has to be in"},
  {"key":"funding_source","label":"Who is funding it","hint":"Their own funds, a donor, a scheme"}
]$json$::jsonb
WHERE slug = 'ngo' AND scope_template = '[]'::jsonb;

UPDATE crm_segments SET scope_template = $json$[
  {"key":"territories","label":"Territories","hint":"Where their dealers sell"},
  {"key":"dealer_network","label":"Dealers or retailers","hint":"How many outlets this would reach"},
  {"key":"crops","label":"Crops","hint":"What their inputs are sold for"},
  {"key":"device_volume","label":"Devices per year","hint":"Their number, once they give one"},
  {"key":"retailer_training","label":"Retailer training","hint":"Who trains the counter staff"},
  {"key":"co_branding","label":"Co-branding","hint":"Whose brand the farmer sees"}
]$json$::jsonb
WHERE slug = 'input-mfr' AND scope_template = '[]'::jsonb;

UPDATE crm_segments SET scope_template = $json$[
  {"key":"integration","label":"What has to talk to what","hint":"Their app, our advisory, a dashboard"},
  {"key":"data_sharing","label":"Data sharing","hint":"What crosses, in which direction, under what terms"},
  {"key":"pilot_size","label":"Pilot size","hint":"Farmers or tests in the first phase"},
  {"key":"white_label","label":"White-label?","hint":"Whose name is on the output"},
  {"key":"crops","label":"Crops","hint":""},
  {"key":"technical_contact","label":"Technical owner on their side","hint":"Who signs off the integration"}
]$json$::jsonb
WHERE slug = 'agritech' AND scope_template = '[]'::jsonb;

UPDATE crm_segments SET scope_template = $json$[
  {"key":"crops","label":"Crops","hint":"What they grow or procure"},
  {"key":"farmer_base","label":"Farmer base","hint":"How many growers they work with"},
  {"key":"acreage","label":"Acreage","hint":"Under their programme"},
  {"key":"advisory_needs","label":"Advisory they want","hint":"Fertiliser, irrigation, soil health"},
  {"key":"traceability","label":"Traceability requirement","hint":"What their buyer demands"},
  {"key":"seasons","label":"Seasons","hint":"Kharif, Rabi, year-round"}
]$json$::jsonb
WHERE slug = 'agri-business' AND scope_template = '[]'::jsonb;

UPDATE crm_segments SET scope_template = $json$[
  {"key":"scheme","label":"Scheme or tender","hint":"Which one this sits under"},
  {"key":"procurement_route","label":"How they buy","hint":"GeM, tender, empanelment, direct"},
  {"key":"districts","label":"Districts or blocks","hint":""},
  {"key":"empanelment","label":"Empanelment needed","hint":"What we must be on the list of first"},
  {"key":"compliance_docs","label":"Documents required","hint":"Certificates, test reports, registrations"},
  {"key":"approval_chain","label":"Approval chain","hint":"Every desk this has to cross"}
]$json$::jsonb
WHERE slug = 'institution' AND scope_template = '[]'::jsonb;

UPDATE crm_segments SET scope_template = $json$[
  {"key":"what_they_want","label":"What they want from us","hint":"In their words"},
  {"key":"where","label":"Where","hint":"Districts, states, regions"},
  {"key":"scale","label":"Scale","hint":"Farmers, devices, tests — whichever they measure in"},
  {"key":"constraints","label":"Constraints","hint":"Budget, season, approvals, anything else"}
]$json$::jsonb
WHERE slug = 'other' AND scope_template = '[]'::jsonb;

-- ---------------------------------------------------------------- images

-- One row per organization per kind. The file lives on disk like a task
-- attachment; this row is the record of it. logo_url and banner_url are left
-- untouched and still hold an externally hosted image, so replacing one never
-- destroys the other.
CREATE TABLE IF NOT EXISTS account_images (
  id          SERIAL PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('LOGO', 'BANNER')),
  stored_name TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_images_one_per_kind
  ON account_images (account_id, kind);
