/**
 * A realistic B2B relationship in the LOCAL DEV database, built through the
 * ordinary API so it cannot end up in a shape the app could not produce.
 * Development aid only — never run against production.
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

token = (await call('POST', '/auth/login', { email: 'admin@ekosight.com', password: 'ChangeMe123!' })).token;

const { users } = await call('GET', '/users');
const me = users[0];
const { segments } = await call('GET', '/accounts/meta/segments');
const { stages } = await call('GET', '/accounts/stages');
const stage = (slug) => stages.find((s) => s.slug === slug);

// clear any previous run so the fixture does not pile up
for (const existing of (await call('GET', '/accounts?limit=200')).accounts) {
  if (existing.name === 'Krishi Vikas Foundation') await call('DELETE', `/accounts/${existing.id}`);
}

const org = (await call('POST', '/accounts', {
  name: 'Krishi Vikas Foundation',
  owner_user_id: me.id,
  source: 'Referral from ICAR',
  website: 'https://kvf.example.org',
  contact_name: 'Meera Joshi',
  contact_email: 'meera@kvf.example.org',
})).account;

await call('PATCH', `/accounts/${org.id}`, {
  segment_id: segments.find((s) => s.slug === 'foundation')?.id,
  hq_address: 'Pune, Maharashtra',
  operating_regions: ['Nashik', 'Dhule', 'Jalgaon'],
  crops: ['Grapes', 'Onion', 'Cotton'],
  tags: ['csr', 'multi-year'],
  linkedin_url: 'https://linkedin.com/company/kvf',
  relationship_summary:
    'Runs farmer welfare programmes across three districts on CSR funding from two manufacturers.',
  why_it_matters:
    'They already have the farmer relationships we would otherwise spend two seasons building.',
  relationship_potential: 8000000,
});

await call('POST', `/accounts/${org.id}/locations`, {
  label: 'Head office', kind: 'HQ', city: 'Pune', state: 'Maharashtra',
  latitude: 18.5204, longitude: 73.8567, precision: 'EXACT',
});
await call('POST', `/accounts/${org.id}/locations`, {
  label: 'Field operations', kind: 'OPERATING', city: 'Nashik', state: 'Maharashtra',
  latitude: 19.9975, longitude: 73.7898, precision: 'APPROXIMATE',
});

// the people who actually decide
const contacts = {};
for (const person of [
  { full_name: 'Meera Joshi', designation: 'Programme Director', email: 'meera@kvf.example.org',
    whatsapp: '+91 98200 11111', preferred_channel: 'WHATSAPP', influence: 'HIGH', is_primary: true,
    notes: 'Ran the Nashik programme. Wants third-party evidence before committing budget.' },
  { full_name: 'Rahul Deshpande', designation: 'Finance Controller', email: 'rahul@kvf.example.org',
    phone: '+91 98200 22222', preferred_channel: 'EMAIL', influence: 'MEDIUM' },
  { full_name: 'Dr Anita Rao', designation: 'Technical Advisor', email: 'anita@kvf.example.org',
    linkedin_url: 'https://linkedin.com/in/anitarao', preferred_channel: 'LINKEDIN', influence: 'HIGH',
    notes: 'Soil scientist. The evaluation will go through her.' },
]) {
  const { contact } = await call('POST', `/accounts/${org.id}/contacts`, person);
  contacts[person.full_name] = contact.id;
}

// the first deal came with the organization; make it real
const detail = await call('GET', `/accounts/${org.id}`);
const first = detail.opportunities[0];
await call('PATCH', `/opportunities/${first.id}`, {
  name: 'Advisory pilot — Nashik, 2,000 farmers',
  engagement_model: 'PAID_PILOT',
  estimated_value: 1250000,
  proposed_value: 1450000,
  expected_close: isoDate(35),
  problem: 'Farmers get soil advice too late in the season to act on it.',
  desired_outcome: 'Advice in hand before sowing, for 2,000 farmers across 40 villages.',
  decision_process: 'Programme director recommends; board approves amounts above ₹10 lakh.',
  win_criteria: 'Third-party lab correlation above 0.85, and a per-farmer cost under ₹700.',
  next_step: 'Share the lab correlation report with Dr Rao',
  next_step_due: isoDate(4),
});
await call('POST', `/opportunities/${first.id}/stage`, { stage_id: stage('proposal').id });

for (const [name, role, involvement] of [
  ['Meera Joshi', 'CHAMPION', 'HIGH'],
  ['Dr Anita Rao', 'TECHNICAL_EVALUATOR', 'HIGH'],
  ['Rahul Deshpande', 'FINANCE', 'MEDIUM'],
]) {
  await call('POST', `/opportunities/${first.id}/contacts`, {
    contact_id: contacts[name], role, involvement,
  });
}

for (const requirement of [
  { category: 'VALIDATION', description: 'Third-party lab correlation on 200 samples above 0.85',
    importance: 'MUST_HAVE', owner_user_id: me.id, due_date: isoDate(14), status: 'IN_PROGRESS' },
  { category: 'COMMERCIAL', description: 'Per-farmer cost under ₹700 including the device',
    importance: 'MUST_HAVE', status: 'BLOCKED' },
  { category: 'OPERATIONAL', description: 'Marathi advisory scripts reviewed by their field team',
    importance: 'SHOULD_HAVE', status: 'OPEN' },
  { category: 'LEGAL', description: 'Data sharing agreement for farmer records',
    importance: 'NICE_TO_HAVE', status: 'OPEN' },
]) {
  await call('POST', `/opportunities/${first.id}/requirements`, requirement);
}

// a second, independent deal with the same organization
const second = (await call('POST', '/opportunities', {
  account_id: org.id,
  name: 'Soil testing contract 2027',
  engagement_model: 'TESTING_CONTRACT',
  stage_id: stage('discovery').id,
  estimated_value: 4200000,
  expected_close: isoDate(120),
})).opportunity;

// and one that is explicitly not commercial, to show it stays out of the forecast
await call('POST', '/opportunities', {
  account_id: org.id,
  name: 'Joint MoU on farmer data standards',
  engagement_model: 'PARTNERSHIP',
  stage_id: stage('scope-alignment').id,
  estimated_value: 0,
  expected_close: isoDate(60),
});

// a history worth reading
for (const activity of [
  { type: 'CALL', subject: 'Intro call with Meera', outcome: 'COMPLETED', direction: 'OUTBOUND',
    contact_id: contacts['Meera Joshi'], occurred_at: new Date(Date.now() - 28 * day).toISOString(),
    body: 'Explained the advisory model. They run three districts already.' },
  { type: 'CALL', subject: 'Tried Rahul about budget cycle', outcome: 'ATTEMPTED',
    contact_id: contacts['Rahul Deshpande'], occurred_at: new Date(Date.now() - 21 * day).toISOString() },
  { type: 'PPT', subject: 'Sent the programme deck', outcome: 'SENT', direction: 'OUTBOUND',
    contact_id: contacts['Meera Joshi'], occurred_at: new Date(Date.now() - 19 * day).toISOString() },
  { type: 'DEMO', subject: 'Soil Doctor demo at their Pune office', outcome: 'COMPLETED',
    contact_id: contacts['Dr Anita Rao'], occurred_at: new Date(Date.now() - 11 * day).toISOString(),
    body: 'Dr Rao asked for lab correlation data before recommending.' },
  { type: 'PROPOSAL', subject: 'Pilot proposal, ₹14.5 lakh', outcome: 'SENT', direction: 'OUTBOUND',
    occurred_at: new Date(Date.now() - 5 * day).toISOString() },
  { type: 'NOTE', subject: 'Internal: check per-farmer costing again', outcome: 'NOTED',
    occurred_at: new Date(Date.now() - 2 * day).toISOString() },
]) {
  await call('POST', `/accounts/${org.id}/activities`, { ...activity, opportunity_id: first.id });
}

console.log(`done — /pipeline/${org.id}  (org ${org.id}, deals ${first.id} & ${second.id})`);
