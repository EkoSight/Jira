/**
 * Meetings, delivery, the link library and enough organizations to make the map
 * and the manager tree worth looking at — built in the LOCAL DEV database through
 * the ordinary API, so nothing here can be in a shape the app could not produce.
 *
 * Development aid only. Never run this against production.
 *
 * Run `dev-b2b-fixture.mjs` first: this builds on the organization it creates.
 */
const API = 'http://localhost:4000/api/taskflow';
let token = null;

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
};

const day = 86_400_000;
const isoDate = (offset) => new Date(Date.now() + offset * day).toISOString().slice(0, 10);
const at = (offsetDays, hour = 11) => {
  const date = new Date(Date.now() + offsetDays * day);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

token = (await call('POST', '/auth/login', { email: 'admin@ekosight.com', password: 'ChangeMe123!' })).token;

const { users } = await call('GET', '/users');
const me = users[0];
const second = users[1] || me;
const { segments } = await call('GET', '/accounts/meta/segments');
const segment = (slug) => segments.find((s) => s.slug === slug)?.id;
const { stages } = await call('GET', '/accounts/stages');
const stage = (slug) => stages.find((s) => s.slug === slug);

const { accounts } = await call('GET', '/accounts?limit=200');
const kvf = accounts.find((a) => a.name === 'Krishi Vikas Foundation');
if (!kvf) throw new Error('run dev-b2b-fixture.mjs first');

const detail = await call('GET', `/accounts/${kvf.id}`);
const pilot = detail.opportunities.find((o) => o.engagement_model === 'PAID_PILOT');
const contactId = (name) => detail.contacts.find((c) => c.full_name === name)?.id;

// ---------------------------------------------------------------- meetings

// one that happened and was written up properly
const held = (await call('POST', '/meetings', {
  account_id: kvf.id,
  opportunity_id: pilot.id,
  kind: 'DEMO',
  mode: 'IN_PERSON',
  title: 'Soil Doctor demo at their Pune office',
  objective: 'Show the device and the advisory flow end to end',
  scheduled_at: at(-11, 10),
  duration_min: 90,
  location: 'KVF head office, Pune',
  demo_type: 'Device + advisory app, full flow',
  prerequisites: 'Charged device, sample soil from Nashik, offline mode tested',
  participant_contact_ids: [contactId('Dr Anita Rao'), contactId('Meera Joshi')].filter(Boolean),
  participant_user_ids: [me.id],
  create_prep_tasks: false,
})).meeting;

await call('POST', `/meetings/${held.id}/outcome`, {
  status: 'COMPLETED',
  outcome: 'Showed the device and the advisory flow. Dr Rao followed the sampling closely and '
    + 'asked twice about repeatability across soil types.',
  objections_raised: 'Not convinced the readings hold on the black cotton soils in Jalgaon.',
  validations_requested: 'Third-party lab correlation on 200 samples, across all three districts.',
  next_decision: 'Whether to fund a 2,000-farmer pilot this financial year.',
  attended_contact_ids: [contactId('Dr Anita Rao')].filter(Boolean),
  follow_up: { title: 'Send the lab correlation report to Dr Rao', due_date: isoDate(3) },
});

// one coming up, with its preparation work
await call('POST', '/meetings', {
  account_id: kvf.id,
  opportunity_id: pilot.id,
  kind: 'REVIEW',
  mode: 'VIRTUAL',
  title: 'Proposal walkthrough with the programme team',
  objective: 'Take them through the ₹14.5 lakh proposal line by line',
  scheduled_at: at(5, 15),
  duration_min: 60,
  meeting_url: 'https://meet.example.com/kvf-proposal',
  participant_contact_ids: [contactId('Meera Joshi'), contactId('Rahul Deshpande')].filter(Boolean),
  participant_user_ids: [me.id, second.id],
});

// and one that has been and gone with nothing recorded, which is its own problem
const forgotten = (await call('POST', '/meetings', {
  account_id: kvf.id,
  kind: 'MEETING',
  mode: 'VIRTUAL',
  title: 'Costing discussion with Rahul',
  scheduled_at: at(-3, 16),
  create_prep_tasks: false,
})).meeting;

// one that slipped twice, so the pattern is visible
const slipped = (await call('POST', '/meetings', {
  account_id: kvf.id,
  kind: 'SITE_VISIT',
  mode: 'IN_PERSON',
  title: 'Field visit to the Jalgaon block',
  scheduled_at: at(2, 9),
  location: 'Jalgaon',
  create_prep_tasks: false,
})).meeting;
await call('POST', `/meetings/${slipped.id}/reschedule`, {
  scheduled_at: at(9, 9), reason: 'Their field team is on a government survey that week',
});
await call('POST', `/meetings/${slipped.id}/reschedule`, {
  scheduled_at: at(18, 9), reason: 'Unseasonal rain — the plots are not accessible',
});

// ---------------------------------------------------------------- the library

// the shared library first, so referencing it can be shown
const shared = [];
for (const resource of [
  { title: 'Soil Doctor — standard introduction deck', url: 'https://docs.google.com/presentation/d/intro-deck',
    version_label: 'v7', status: 'CURRENT', tags: ['pitch', 'english'],
    description: 'Start here for any first meeting. Slide 9 pricing is indicative only.' },
  { title: 'Validation report — Rabi 2025 (three states)', url: 'https://drive.google.com/file/d/validation-rabi-2025',
    version_label: 'final', status: 'CURRENT', tags: ['validation', 'evidence'],
    description: 'The report technical evaluators actually ask for.' },
  { title: 'Price list — FY26', url: 'https://docs.google.com/spreadsheets/d/price-list-fy26',
    version_label: 'FY26', status: 'CURRENT', tags: ['pricing'], is_restricted: true },
]) {
  shared.push((await call('POST', '/resources', { ...resource, account_id: null })).resource);
}

// the organization's own shelf
const { folders } = await call('GET', `/resources/folders?account_id=${kvf.id}`);
const folder = (name) => folders.find((f) => f.name === name)?.id;

const proposal = (await call('POST', '/resources', {
  account_id: kvf.id,
  opportunity_id: pilot.id,
  folder_id: folder('Proposals & Offers'),
  title: 'KVF advisory pilot proposal — ₹14.5 lakh',
  url: 'https://docs.google.com/document/d/kvf-pilot-proposal',
  version_label: 'v3',
  status: 'CURRENT',
  tags: ['proposal', 'nashik'],
  description: 'v3 is the one sent. v2 had the old per-farmer costing.',
})).resource;

await call('POST', '/resources', {
  account_id: kvf.id,
  folder_id: folder('Requirements'),
  title: 'Their programme requirements note (from Meera)',
  url: 'https://drive.google.com/file/d/kvf-requirements-note',
  status: 'CURRENT',
  description: 'In their words — worth rereading before the proposal walkthrough.',
});

// referenced from the shared library, not copied into it
for (const resource of shared.slice(0, 2)) {
  await call('POST', `/resources/${resource.id}/reference`, {
    account_id: kvf.id,
    opportunity_id: pilot.id,
    note: 'Used in the first meeting',
  });
}

// what was actually sent, which is not the same as what exists
await call('POST', `/resources/${proposal.id}/shares`, {
  account_id: kvf.id,
  opportunity_id: pilot.id,
  contact_id: contactId('Meera Joshi'),
  channel: 'EMAIL',
  version_label: 'v3',
  purpose: 'The proposal itself, after the board date was confirmed',
  shared_at: new Date(Date.now() - 5 * day).toISOString(),
});
await call('POST', `/resources/${shared[1].id}/shares`, {
  account_id: kvf.id,
  contact_id: contactId('Dr Anita Rao'),
  channel: 'WHATSAPP',
  purpose: 'She asked for the Rabi validation report right after the demo',
  shared_at: new Date(Date.now() - 10 * day).toISOString(),
});

// ---------------------------------------------------------------- a won deal in delivery

const customer = (await call('POST', '/accounts', {
  name: 'Sahyadri Farmer Producer Company',
  owner_user_id: second.id,
  source: 'Inbound from the Nashik event',
  contact_name: 'Sanjay Patil',
  contact_email: 'sanjay@sahyadri.example.org',
})).account;

await call('PATCH', `/accounts/${customer.id}`, {
  segment_id: segment('agri-business'),
  hq_address: 'Mohadi, Dindori taluka, Nashik',
  operating_regions: ['Nashik', 'Ahmednagar'],
  crops: ['Grapes', 'Tomato'],
  tags: ['fpo', 'export'],
  relationship_summary: 'An FPO federating 12,000 grape and tomato growers, exporting to the EU.',
  why_it_matters: 'Their export buyers demand traceability, which is exactly what the advisory record gives them.',
  relationship_potential: 15000000,
});
await call('POST', `/accounts/${customer.id}/locations`, {
  label: 'Collection centre', kind: 'HQ', city: 'Dindori', state: 'Maharashtra',
  latitude: 20.2, longitude: 73.83, precision: 'APPROXIMATE',
});

const sahyadriDetail = await call('GET', `/accounts/${customer.id}`);
const deal = sahyadriDetail.opportunities[0];
await call('PATCH', `/opportunities/${deal.id}`, {
  name: 'Advisory for 5,000 grape growers — season one',
  engagement_model: 'COMMERCIAL',
  estimated_value: 2800000,
  proposed_value: 3100000,
  expected_close: isoDate(-8),
  scope_summary: 'Advisory for 5,000 growers across two talukas, one season, Marathi only.',
  scope: {
    crops: 'Grapes, tomato',
    farmer_base: '12,000 members, 5,000 in scope for season one',
    acreage: 'about 9,000 acres',
    advisory_needs: 'Fertiliser and irrigation timing, pre-harvest residue checks',
    traceability: 'EU buyer requires a per-plot record',
    seasons: 'Rabi, then reviewed',
  },
});
await call('POST', `/opportunities/${deal.id}/stage`, {
  stage_id: stage('won').id,
  agreement_type: 'Signed service agreement',
  agreement_date: isoDate(-8),
  agreed_value: 2950000,
  financial_status: 'PART_PAID',
  outcome_reason: 'Advisory for 5,000 growers, one season, with a per-plot record for their buyer.',
});
await call('PATCH', `/opportunities/${deal.id}`, { collected_value: 1475000 });

const engagement = (await call('POST', `/engagements/from-opportunity/${deal.id}`, {
  name: 'Sahyadri season one delivery',
  owner_user_id: second.id,
  kickoff_on: isoDate(-6),
  create_kickoff_tasks: true,
})).engagement;

await call('PATCH', `/engagements/${engagement.id}`, {
  state: 'AT_RISK',
  commitments: 'Advisory within 48 hours of each sample; Marathi only; per-plot record for the EU buyer.',
  review_cadence: 'Fortnightly with Sanjay',
  next_review_on: isoDate(-1),
  blockers: 'Two of the four field coordinators have not been trained, and sampling has started.',
  partner_feedback: 'Sanjay is happy with the turnaround but wants the per-plot record in their own format.',
});

for (const milestone of [
  { title: '4 field coordinators trained on sampling', due_date: isoDate(-4), status: 'BLOCKED',
    description: 'Two done. The Ahmednagar pair could not travel.' },
  { title: '500 plots sampled and recorded', due_date: isoDate(-2), status: 'IN_PROGRESS' },
  { title: 'First advisory batch delivered in Marathi', due_date: isoDate(6), status: 'PLANNED' },
  { title: 'Per-plot record exported in the buyer format', due_date: isoDate(20), status: 'PLANNED' },
  { title: 'Kick-off workshop with the FPO board', due_date: isoDate(-6), status: 'ACCEPTED' },
]) {
  await call('POST', `/engagements/${engagement.id}/milestones`, milestone);
}

// ---------------------------------------------------------------- a third, to fill the tree

const gov = (await call('POST', '/accounts', {
  name: 'Department of Agriculture, Telangana',
  owner_user_id: me.id,
  source: 'Empanelment enquiry',
})).account;
await call('PATCH', `/accounts/${gov.id}`, {
  segment_id: segment('institution'),
  hq_address: 'Hyderabad, Telangana',
  operating_regions: ['Telangana'],
  relationship_summary: 'State department exploring soil health cards through empanelled vendors.',
  // deliberately no coordinates, so the map has something honest to say
});

const govDeal = (await call('GET', `/accounts/${gov.id}`)).opportunities[0];
await call('PATCH', `/opportunities/${govDeal.id}`, {
  name: 'Soil health card empanelment — Telangana',
  engagement_model: 'INSTITUTIONAL_PROJECT',
  value_unknown: true,
  expected_close: isoDate(90),
  scope: { scheme: 'Soil Health Card Scheme', procurement_route: 'GeM after empanelment' },
});

// a lead with nothing on it yet, which is what a trade-show card really is
await call('POST', '/accounts', {
  name: 'Bharat Agri Inputs Ltd',
  source: 'Trade show card',
});

console.log(`done — meetings on /accounts/${kvf.id}, delivery on /accounts/${customer.id}`);
console.log(`unrecorded meeting ${forgotten.id} · slipped meeting ${slipped.id} · engagement ${engagement.id}`);
