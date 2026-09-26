/**
 * Leads spread across states, some with values and some without, one of them
 * blocked — in the LOCAL DEV database, through the ordinary API, so the board's
 * totals, the state-wise view and the blocker flow have something real to show.
 *
 * Development aid only. Never run this against production.
 * Run after dev-b2b-fixture.mjs and dev-b2b-workflows-fixture.mjs.
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

token = (await call('POST', '/auth/login', { email: 'admin@ekosight.com', password: 'ChangeMe123!' })).token;
const { users } = await call('GET', '/users');
const [me, second] = [users[0], users[1] || users[0]];

const { accounts } = await call('GET', '/accounts?limit=200');
const byName = (name) => accounts.find((a) => a.name === name);

// the telangana department only ever had its state in a free-text address;
// the migration rightly left it blank, so a person sets it here
const gov = byName('Department of Agriculture, Telangana');
if (gov) await call('PATCH', `/accounts/${gov.id}`, { state: 'Telangana' });

const fresh = [
  { name: 'Punjab Agro Dealers Association', state: 'Punjab', hq_address: 'Sector 17, Chandigarh Road, Ludhiana',
    value: 3200000, spoke: 5, owner: me.id },
  { name: 'Malwa Soybean Processors', state: 'Madhya Pradesh', hq_address: 'Industrial Area, Dewas',
    value: 350000, spoke: 60, owner: second.id },
  { name: 'Coastal Coconut Growers FPO', state: 'Kerala', hq_address: 'Kuttanad, Alappuzha',
    value: null, spoke: null, owner: second.id },
  { name: 'Guntur Chilli Traders', state: 'Andhra Pradesh', hq_address: 'Mirchi Yard, Guntur',
    value: 900000, spoke: 45, owner: me.id },
  { name: 'Nagpur Orange Collective', state: 'Maharashtra', hq_address: 'Katol Road, Nagpur',
    value: 1500000, spoke: 12, owner: me.id,
    pin: { latitude: 21.1458, longitude: 79.0882, city: 'Nagpur', state: 'Maharashtra' } },
];

const made = {};
for (const lead of fresh) {
  const existing = byName(lead.name);
  if (existing) await call('DELETE', `/accounts/${existing.id}`);
  const { account } = await call('POST', '/accounts', {
    name: lead.name, state: lead.state, hq_address: lead.hq_address,
    value: lead.value ?? undefined, owner_user_id: lead.owner,
  });
  made[lead.name] = account;
  if (lead.pin) {
    await call('POST', `/accounts/${account.id}/locations`, {
      label: 'Office', kind: 'HQ', precision: 'APPROXIMATE', ...lead.pin,
    });
  }
  if (lead.spoke !== null) {
    await call('POST', `/accounts/${account.id}/activities`, {
      type: 'CALL', subject: 'Call with the buyer', outcome: 'COMPLETED',
      occurred_at: new Date(Date.now() - lead.spoke * day).toISOString(),
    });
  }
}

// something is stopping the Punjab deal, and the owner asks for help
const punjab = made['Punjab Agro Dealers Association'];
const punjabDetail = await call('GET', `/accounts/${punjab.id}`);
await call('POST', '/threads', {
  entity_type: 'OPPORTUNITY',
  entity_id: punjabDetail.opportunities[0].id,
  kind: 'blocker',
  category: 'PRICING',
  title: 'They want dealer margin at 18%, we can do 12%',
  body: 'The association will only list the device if dealers get 18%. At 12% they say it will not move. Can we do volume-tiered margins, or bundle the testing service?',
  participant_user_ids: [second.id].filter((id) => id !== me.id),
});

// a lead won this month through the customer button
const guntur = made['Guntur Chilli Traders'];
const gunturDetail = await call('GET', `/accounts/${guntur.id}`);
await call('POST', `/accounts/${guntur.id}/convert`, {
  type: 'CUSTOMER',
  opportunity_id: gunturDetail.opportunities[0].id,
  agreed_value: 850000,
  agreement_type: 'Purchase order',
});

console.log(`done — Punjab ${punjab.id} (blocked), Guntur ${guntur.id} (converted)`);
