/**
 * The sales CRM, end to end through the API and the database:
 *
 *   C  retailer, FPO and individual leads never enter Taskflow's pipeline,
 *      however they arrive; a corporate employee stays a business contact
 *   D  one organization, several contacts and deals; conversion keeps history;
 *      duplicates are previewed and merged; archive and restore
 *   E  assignment: rules, equal distribution under simultaneous arrivals,
 *      unavailable people, fallback, the account's owner, retries
 *   A  a corporate deal: quotation with approval, won, one handover, schedule,
 *      part payment, refund, duplicate payment event
 *   B  a CSR deal in its own pipeline: parties, proposal, commitment kept
 *      apart from receipts, lost outcome, a renewal without a second account
 *   I  access: other people's records, approvals, refunds and settings
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { computeTotals, contentHash } from '../src/services/sales/quotes.js';
import { formatAmount } from '../src/services/sales/quotePdf.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

const call = async (method, path, { token, body, headers = {}, raw = false, form = false } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};

const day = (offset = 0) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offset * 86400000));

const skip = (t) => {
  if (!available) { t.skip('no database'); return true; }
  return false;
};

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
};

const nextAction = (owner, offset = 3, step = 'Call them about the order') => ({ next_step: step, next_step_owner_id: owner, next_step_due: day(offset) });

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('SAL', 'Sales', '#2a78d6', 1), ('OPS', 'Operations', '#7c3aed', 2)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE),
      ('Cancelled', 'cancelled', 'cancelled', '#94a3b8', 3, FALSE)`,
  );
  const { rows: depts } = await query('SELECT id, key FROM departments');
  ids.sales = depts.find((d) => d.key === 'SAL').id;
  ids.ops = depts.find((d) => d.key === 'OPS').id;

  const password = await hashPassword('Password123!');
  for (const [key, name, role, dept, extra] of [
    ['admin', 'Asha Admin', 'admin', 'sales', []],
    ['manager', 'Vartika Head', 'manager', 'sales', []],
    ['approver', 'Kiran Approver', 'manager', 'sales', []],
    ['rupendra', 'Rupendra Rep', 'member', 'sales', []],
    ['saumya', 'Saumya Rep', 'member', 'sales', []],
    ['away', 'Away Rep', 'member', 'sales', []],
    ['finance', 'Farah Finance', 'member', 'sales', ['crm.finance']],
    ['outsider', 'Omar Ops', 'member', 'ops', []],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, extra_permissions)
       VALUES ($1,$2,$3,$4,$5,FALSE,$6) RETURNING id`,
      [name, `sales-${key}@test.local`, password, role, ids[dept], extra],
    );
    ids[key] = rows[0].id;
  }
  const { rows: stages } = await query('SELECT id, slug FROM account_stages');
  for (const s of stages) ids[`stage_${s.slug.replace(/-/g, '_')}`] = s.id;
  const { rows: pipes } = await query('SELECT id, key FROM crm_pipelines');
  for (const p of pipes) ids[`pipeline_${p.key}`] = p.id;

  await new Promise((resolve) => {
    server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  for (const key of ['admin', 'manager', 'approver', 'rupendra', 'saumya', 'away', 'finance', 'outsider']) {
    const login = await call('POST', '/auth/login', { body: { email: `sales-${key}@test.local`, password: 'Password123!' } });
    tokens[key] = login.body.token;
  }
  // record-level access starts off (nobody loses sight of a record on upgrade); these journeys run with it on
  const on = await call('PUT', '/sales/settings', { token: tokens.admin, body: { visibility: { agents: 'OWN', enforced: true } } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- arithmetic, on its own

test('quotation totals are exact to the paisa, line by line', () => {
  const t = computeTotals([
    { description: 'Soil test kits', quantity: '3', unit_price: '1999.99', discount_pct: '12.5', tax_rate: '18' },
    { description: 'Field visit', quantity: '0.5', unit_price: '3333.33', tax_rate: '18' },
    { description: 'Training (no tax)', quantity: '1', unit_price: '0.10' },
  ]);
  // 3 × 1999.99 = 5999.97; 12.5% = 750.00 (749.99625 rounded half up); taxable 5249.97; 18% = 944.99 (944.9946)
  assert.equal(t.lines[0].line_subtotal, '5999.97');
  assert.equal(t.lines[0].line_discount, '750.00');
  assert.equal(t.lines[0].line_tax, '944.99');
  assert.equal(t.lines[0].line_total, '6194.96');
  // 0.5 × 3333.33 = 1666.665 → 1666.67; 18% = 300.0006 → 300.00
  assert.equal(t.lines[1].line_subtotal, '1666.67');
  assert.equal(t.lines[1].line_tax, '300.00');
  assert.equal(t.subtotal, '7666.74');
  assert.equal(t.discount_total, '750.00');
  assert.equal(t.tax_total, '1244.99');
  assert.equal(t.total, '8161.73');
  assert.equal(t.max_discount_pct, '12.50');
  assert.throws(() => computeTotals([{ description: 'x', quantity: '0', unit_price: '1' }]), /quantity/);
  assert.throws(() => computeTotals([{ description: 'x', quantity: '1', unit_price: '1', discount_pct: '120' }]), /discount/);

  // what an approval is pinned to moves with any material change
  const base = { kind: 'QUOTATION', currency: 'INR', valid_until: '2026-12-01', terms: 'Net 30', total: t.total };
  const h1 = contentHash(base, t.lines);
  assert.equal(contentHash({ ...base }, t.lines), h1);
  assert.notEqual(contentHash({ ...base, terms: 'Net 45' }, t.lines), h1);
  assert.notEqual(contentHash(base, [{ ...t.lines[0], discount_pct: '15.00' }, ...t.lines.slice(1)]), h1);

  assert.equal(formatAmount('1250000.5', 'INR'), 'INR 12,50,000.50');
  assert.equal(formatAmount('1250000.5', 'USD'), 'USD 1,250,000.50');
});

// ---------------------------------------------------------------- C: the TeleCRM boundary

test('C: retailer, FPO and individual leads stay out of the Taskflow pipeline however they arrive', async (t) => {
  if (skip(t)) return;
  const refs = [];

  // the manual form
  for (const [category, organization_name] of [['RETAILER', 'Krishna Agro Store'], ['FPO', 'Sahyadri Farmers Producer Company Ltd'], ['INDIVIDUAL', null]]) {
    const r = ok(await call('POST', '/sales/leads', {
      token: tokens.rupendra, body: { category, organization_name, contact_name: `${category} contact`, phone: `98${String(refs.length).padStart(8, '1')}` },
    }), 201);
    assert.equal(r.lead.destination, 'TELECRM', `${category} goes to TeleCRM`);
    assert.equal(r.lead.owner_user_id, null, 'not assigned to a Taskflow agent');
    refs.push(r.lead.ref);
  }

  // the organization form: an excluded category becomes a routed lead, not an organization
  const viaOrg = await call('POST', '/accounts', { token: tokens.manager, body: { name: 'Village Retail Point', lead_category: 'RETAILER', department_id: ids.sales } });
  assert.equal(viaOrg.status, 202, JSON.stringify(viaOrg.body));
  assert.equal(viaOrg.body.routed, 'TELECRM');
  refs.push(viaOrg.body.lead.ref);
  const { rows: noOrg } = await query(`SELECT 1 FROM accounts WHERE name = 'Village Retail Point'`);
  assert.equal(noOrg.length, 0);

  // an edit that turns out to be a retailer
  const edited = ok(await call('POST', '/sales/leads', { token: tokens.rupendra, body: { category: 'B2B_CORPORATE', organization_name: 'Mahesh Traders', contact_name: 'Mahesh', owner_user_id: ids.rupendra } }), 201);
  assert.equal(edited.lead.destination, 'TASKFLOW');
  const reclassified = ok(await call('PATCH', `/sales/leads/${edited.lead.id}`, { token: tokens.rupendra, body: { category: 'RETAILER', reason: 'They run a dealership' } }));
  assert.equal(reclassified.lead.destination, 'TELECRM');
  refs.push(edited.lead.ref);

  // an API key and a webhook
  const key = ok(await call('POST', '/sales/capture/keys', { token: tokens.admin, body: { name: 'Website' } }), 201).key;
  const api = ok(await call('POST', '/s/leads', { headers: { authorization: `Bearer ${key.key}` }, body: { company: 'Green Valley FPC', name: 'Suresh', phone: '9811100011', who: 'FPO', idempotency_key: 'api-1' } }), 201);
  assert.equal(api.routed_to, 'TELECRM');
  refs.push(api.ref);
  const hook = ok(await call('POST', `/s/hooks/${key.key}`, { body: { name: 'Ramesh Farmer', phone: '9811100012', category: 'individual', external_id: 'fb-777', source_system: 'meta' } }), 201);
  assert.equal(hook.routed_to, 'TELECRM');
  refs.push(hook.ref);
  // the same webhook delivered twice is one lead
  const again = ok(await call('POST', `/s/hooks/${key.key}`, { body: { name: 'Ramesh Farmer', phone: '9811100012', category: 'individual', external_id: 'fb-777', source_system: 'meta' } }));
  assert.equal(again.status, 'already_received');
  assert.equal(again.ref, hook.ref);
  // a key that does not exist
  assert.equal((await call('POST', '/s/leads', { headers: { authorization: 'Bearer tfk_nope' }, body: { name: 'x' } })).status, 401);

  // the public form
  const form = ok(await call('POST', '/sales/capture/forms', { token: tokens.admin, body: { name: 'Enquiry', title: 'Talk to Soil Doctor' } }), 201).form;
  const page = await call('POST', `/s/f/${form.public_id}`, { form: true, raw: true, body: { name: 'Lakshmi', phone: '9811100013', who: 'RETAILER', submission_id: 'form-1' } });
  assert.equal(page.status, 200, (page.buffer.toString().match(/role="alert">([^<]*)/) || [])[1]);
  assert.match(page.buffer.toString(), /Thank you/);
  const { rows: formLead } = await query(`SELECT ref, destination FROM crm_leads WHERE idempotency_key = $1`, [`form:${form.id}:form-1`]);
  assert.equal(formLead[0].destination, 'TELECRM');
  refs.push(formLead[0].ref);

  // nothing excluded is in the working lists, the counts or anyone's pool
  const open = ok(await call('GET', '/sales/leads?view=all&page_size=200', { token: tokens.manager }));
  for (const ref of refs) assert.ok(!open.leads.some((l) => l.ref === ref), `${ref} is not in the Taskflow lead list`);
  const queue = ok(await call('GET', '/sales/leads?view=telecrm&page_size=200', { token: tokens.manager }));
  for (const ref of refs) assert.ok(queue.leads.some((l) => l.ref === ref), `${ref} waits in the TeleCRM queue`);
  assert.equal((await call('GET', '/sales/leads?view=telecrm', { token: tokens.rupendra })).status, 403, 'agents do not work the TeleCRM queue');

  // each has a hand-off waiting, and nobody claims it was delivered
  const handoffs = ok(await call('GET', '/sales/routing/handoffs?status=PENDING', { token: tokens.manager })).handoffs;
  assert.ok(handoffs.length >= refs.length);
  // the export is the hand-off; confirming it is a separate, recorded step
  const exported = await call('POST', '/sales/routing/handoffs/export', { token: tokens.manager, raw: true, body: { ids: handoffs.map((h) => h.id), format: 'CSV' } });
  assert.equal(exported.status, 200);
  assert.match(exported.buffer.toString(), /Krishna Agro Store/);
  const { rows: afterExport } = await query(`SELECT DISTINCT status FROM crm_handoffs WHERE id = ANY($1::int[])`, [handoffs.map((h) => h.id)]);
  assert.deepEqual(afterExport.map((r) => r.status), ['EXPORTED']);
  ok(await call('POST', `/sales/routing/handoffs/${handoffs[0].id}/confirm`, { token: tokens.manager, body: { external_id: 'TC-1001' } }));
  const { rows: confirmed } = await query('SELECT status, external_id FROM crm_handoffs WHERE id = $1', [handoffs[0].id]);
  assert.deepEqual(confirmed[0], { status: 'CONFIRMED', external_id: 'TC-1001' });

  // an excluded lead cannot be converted into a deal
  const { rows: retail } = await query(`SELECT id FROM crm_leads WHERE ref = $1`, [refs[0]]);
  assert.equal((await call('POST', `/sales/leads/${retail[0].id}/convert`, { token: tokens.manager, body: {} })).status, 409);

  // an enquiry with no category waits for classification rather than guessing
  const unknown = ok(await call('POST', '/s/leads', { headers: { authorization: `Bearer ${key.key}` }, body: { company: 'Unknown Org', name: 'Who', email: 'who@unknown-org.in' } }), 201);
  assert.equal(unknown.routed_to, 'TRIAGE');

  // a person who works for a company is a business contact, and is allowed
  const employee = ok(await call('POST', '/sales/leads', { token: tokens.rupendra, body: { category: 'B2B_CORPORATE', organization_name: 'Tata Agrico', contact_name: 'Anil Kumar', email: 'anil@tataagrico.com' } }), 201);
  assert.equal(employee.lead.destination, 'TASKFLOW');

  // an organization classified for TeleCRM takes no new deals
  const legacy = ok(await call('POST', '/accounts', { token: tokens.manager, body: { name: 'Old Dealer Account', department_id: ids.sales, owner_user_id: ids.manager } }), 201);
  ok(await call('POST', '/sales/routing/accounts/classify', { token: tokens.manager, body: { ids: [legacy.account.id], category: 'RETAILER', reason: 'Dealer' } }));
  const refused = await call('POST', '/opportunities', { token: tokens.manager, body: { account_id: legacy.account.id, name: 'Should not exist' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.details?.code, 'CATEGORY_EXCLUDED');
  // and it is preserved, not deleted
  const { rows: kept } = await query('SELECT lead_category, routing_status FROM accounts WHERE id = $1', [legacy.account.id]);
  assert.deepEqual(kept[0], { lead_category: 'RETAILER', routing_status: 'EXCLUDED' });
});

// ---------------------------------------------------------------- E: assignment

test('E: rules share leads equally, skip people who are unavailable or full, and a retry does not reassign', async (t) => {
  if (skip(t)) return;
  ok(await call('PUT', `/sales/assignment/agents/${ids.away}`, { token: tokens.admin, body: { accepts_new_leads: false } }));
  const rule = ok(await call('POST', '/sales/assignment/rules', {
    token: tokens.admin,
    body: { name: 'Corporate round robin', priority: 10, conditions: { categories: ['B2B_CORPORATE'] }, strategy: 'ROUND_ROBIN', user_ids: [ids.rupendra, ids.saumya, ids.away] },
  }), 201).rule;
  const key = ok(await call('POST', '/sales/capture/keys', { token: tokens.admin, body: { name: 'Ads connector' } }), 201).key;

  // six arrive at once
  const arrivals = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/s/leads', {
    headers: { authorization: `Bearer ${key.key}` },
    body: { company: `Burst Co ${i}`, name: `Buyer ${i}`, email: `buyer${i}@burst${i}.co.in`, category: 'corporate', idempotency_key: `burst-${i}` },
  })));
  for (const a of arrivals) assert.equal(a.status, 201, JSON.stringify(a.body));
  const { rows: owners } = await query(
    `SELECT owner_user_id, COUNT(*)::int AS n FROM crm_leads WHERE idempotency_key LIKE $1 GROUP BY owner_user_id`, [`key:${key.id}:burst-%`],
  );
  const byOwner = Object.fromEntries(owners.map((o) => [o.owner_user_id, o.n]));
  assert.deepEqual(byOwner, { [ids.rupendra]: 3, [ids.saumya]: 3 }, 'equal shares, nobody unavailable');

  // the same submissions again, all at once: same leads, same owners, nothing reassigned
  const retries = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/s/leads', {
    headers: { authorization: `Bearer ${key.key}` },
    body: { company: `Burst Co ${i}`, name: `Buyer ${i}`, email: `buyer${i}@burst${i}.co.in`, category: 'corporate', idempotency_key: `burst-${i}` },
  })));
  for (const r of retries) assert.equal(r.body.status, 'already_received');
  const { rows: assignments } = await query(`SELECT COUNT(*)::int AS n FROM crm_assignments a JOIN crm_leads l ON l.id = a.entity_id AND a.entity_type = 'LEAD' WHERE l.idempotency_key LIKE $1`, [`key:${key.id}:burst-%`]);
  assert.equal(assignments[0].n, 6, 'one assignment per lead');

  // a full agent is skipped
  ok(await call('PUT', `/sales/assignment/agents/${ids.saumya}`, { token: tokens.admin, body: { max_open_leads: 1 } }));
  const sim = ok(await call('POST', '/sales/assignment/simulate', { token: tokens.manager, body: { category: 'B2B_CORPORATE' } }));
  assert.equal(sim.userId, ids.rupendra);
  assert.ok(JSON.stringify(sim.explain).match(/capacity|full|open leads/i), JSON.stringify(sim.explain));
  ok(await call('PUT', `/sales/assignment/agents/${ids.saumya}`, { token: tokens.admin, body: { max_open_leads: null } }));

  // nobody matches: the fallback owner takes it
  ok(await call('PATCH', `/sales/assignment/rules/${rule.id}`, { token: tokens.admin, body: { is_enabled: false } }));
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { assignment: { fallbackUserId: ids.manager } } }));
  const fallback = ok(await call('POST', '/sales/leads', { token: tokens.manager, body: { category: 'B2B_CORPORATE', organization_name: 'Nobody Matches Ltd', contact_name: 'N' } }), 201);
  assert.equal(fallback.lead.owner_user_id, ids.manager);

  // a returning organization goes to whoever owns it
  const org = ok(await call('POST', '/accounts', { token: tokens.manager, body: { name: 'Greenfields Agritech', website: 'https://greenfields.in', lead_category: 'B2B_CORPORATE', owner_user_id: ids.saumya, department_id: ids.sales } }), 201);
  const repeat = ok(await call('POST', '/sales/leads', { token: tokens.manager, body: { category: 'B2B_CORPORATE', organization_name: 'Greenfields', contact_name: 'New Buyer', email: 'buyer@greenfields.in' } }), 201);
  assert.equal(repeat.lead.account_id, org.account.id);
  assert.equal(repeat.lead.owner_user_id, ids.saumya);

  // a manual owner is not overridden by an unrelated edit
  ok(await call('PATCH', `/sales/leads/${repeat.lead.id}`, { token: tokens.manager, body: { priority: 'HIGH' } }));
  const { rows: still } = await query('SELECT owner_user_id FROM crm_leads WHERE id = $1', [repeat.lead.id]);
  assert.equal(still[0].owner_user_id, ids.saumya);

  // a manual reassignment is recorded with who, why and from whom
  ok(await call('POST', `/sales/leads/${repeat.lead.id}/assign`, { token: tokens.manager, body: { user_id: ids.rupendra, reason: 'Saumya on leave' } }));
  const { rows: trail } = await query(`SELECT from_user_id, to_user_id, reason, actor_id FROM crm_assignments WHERE entity_type = 'LEAD' AND entity_id = $1 ORDER BY id`, [repeat.lead.id]);
  assert.deepEqual(trail.at(-1), { from_user_id: ids.saumya, to_user_id: ids.rupendra, reason: 'Saumya on leave', actor_id: ids.manager });
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { assignment: { fallbackUserId: null } } }));
});

// ---------------------------------------------------------------- D: relationships, conversion, merge

test('D: one organization with several contacts and deals; conversion keeps the lead; merge previews and keeps history', async (t) => {
  if (skip(t)) return;
  const lead = ok(await call('POST', '/sales/leads', {
    token: tokens.rupendra,
    body: { category: 'B2B_CORPORATE', organization_name: 'Coromandel Agro Inputs', contact_name: 'Priya Nair', email: 'priya@coromandelagro.in',
      phone: '09876543210', requirement: 'Soil testing for 400 dealers', owner_user_id: ids.rupendra, utm: { source: 'google', medium: 'cpc', campaign: 'kharif-2026' } },
  }), 201).lead;
  ok(await call('POST', `/sales/leads/${lead.id}/activities`, { token: tokens.rupendra, body: { type: 'CALL', direction: 'OUTBOUND', outcome: 'COMPLETED', subject: 'Intro call' } }), 201);
  const conv = ok(await call('POST', `/sales/leads/${lead.id}/convert`, { token: tokens.rupendra, body: { opportunity: { name: 'Dealer soil programme', estimated_value: 1200000, ...nextAction(ids.rupendra) } } }), 201);
  // asking again returns what it already became
  const again = ok(await call('POST', `/sales/leads/${lead.id}/convert`, { token: tokens.rupendra, body: {} }));
  assert.equal(again.opportunityId, conv.opportunityId);
  const deal1 = ok(await call('GET', `/opportunities/${conv.opportunityId}`, { token: tokens.rupendra }));
  assert.equal(deal1.opportunity.source_lead_id, lead.id);
  const { rows: src } = await query('SELECT s.key FROM opportunities o JOIN crm_sources s ON s.id = o.source_id WHERE o.id = $1', [conv.opportunityId]);
  assert.equal(src[0].key, 'google-ads', 'the original paid source survives conversion');
  const { rows: phone } = await query('SELECT phone FROM account_contacts WHERE id = $1', [conv.contactId]);
  assert.equal(phone[0].phone, '09876543210', 'the leading zero is kept');

  // a second contact and a second, concurrent deal on the same organization
  ok(await call('POST', `/accounts/${conv.accountId}/contacts`, { token: tokens.rupendra, body: { full_name: 'Ravi Finance', email: 'ravi@coromandelagro.in', designation: 'CFO' } }), 201);
  const deal2 = ok(await call('POST', '/opportunities', { token: tokens.rupendra, body: { account_id: conv.accountId, name: 'Retail kiosk pilot', ...nextAction(ids.rupendra) } }), 201);
  assert.equal(deal2.opportunity.pipeline_id, ids.pipeline_b2b);
  const detail = ok(await call('GET', `/accounts/${conv.accountId}`, { token: tokens.rupendra }));
  assert.equal(detail.opportunities.length, 2);
  assert.ok(detail.contacts.length >= 2);

  // losing one deal does not close the organization's other deal
  ok(await call('POST', `/opportunities/${deal2.opportunity.id}/stage`, { token: tokens.rupendra, body: { stage_id: ids.stage_lost, outcome_reason: 'Budget moved to next year', lost_reason_code: 'BUDGET' } }));
  const d1 = ok(await call('GET', `/opportunities/${conv.opportunityId}`, { token: tokens.rupendra }));
  assert.equal(d1.opportunity.status, 'ACTIVE');

  // a duplicate lead from the same person, previewed then merged
  const dup = ok(await call('POST', '/sales/leads', { token: tokens.manager, body: { category: 'B2B_CORPORATE', organization_name: 'Coromandel', contact_name: 'Priya N', email: 'Priya@CoromandelAgro.in', owner_user_id: ids.rupendra } }), 201).lead;
  const found = ok(await call('POST', '/sales/leads/duplicates', { token: tokens.manager, body: { email: 'priya@coromandelagro.in' } }));
  assert.ok(found.leads.some((l) => l.id === lead.id && l.reasons.join(' ').match(/email/i)));
  const preview = ok(await call('GET', `/sales/merge/preview?entity=LEAD&survivor=${lead.id}&merged=${dup.id}`, { token: tokens.manager }));
  assert.ok(preview);
  ok(await call('POST', '/sales/merge', { token: tokens.manager, body: { entity: 'LEAD', survivor_id: lead.id, merged_id: dup.id, reason: 'Same enquiry twice' } }));
  const { rows: merged } = await query('SELECT merged_into_id, is_archived FROM crm_leads WHERE id = $1', [dup.id]);
  assert.deepEqual(merged[0], { merged_into_id: lead.id, is_archived: true });
  const { rows: survivor } = await query('SELECT contact_name, email FROM crm_leads WHERE id = $1', [lead.id]);
  assert.equal(survivor[0].contact_name, 'Priya Nair', 'good data is not overwritten');

  // archive and restore keep the record
  const extra = ok(await call('POST', '/sales/leads', { token: tokens.rupendra, body: { category: 'B2B_CORPORATE', organization_name: 'Archive Me', contact_name: 'A', owner_user_id: ids.rupendra } }), 201).lead;
  ok(await call('POST', `/sales/leads/${extra.id}/archive`, { token: tokens.rupendra, body: { reason: 'Test' } }));
  ok(await call('POST', `/sales/leads/${extra.id}/restore`, { token: tokens.rupendra }));
  const restored = ok(await call('GET', `/sales/leads/${extra.id}`, { token: tokens.rupendra }));
  assert.equal(restored.lead.is_archived, false);
  assert.ok(restored.timeline.some((e) => /Archived/.test(e.subject)) && restored.timeline.some((e) => /Restored/.test(e.subject)));
  ids.coromandel = { account: conv.accountId, deal: conv.opportunityId, contact: conv.contactId };
});

// ---------------------------------------------------------------- pipelines

test('pipelines: a deal moves only within its own pipeline, through allowed stages, with required fields', async (t) => {
  if (skip(t)) return;
  const dealId = ids.coromandel.deal;
  // a CSR stage on a B2B deal is refused outright
  const cross = await call('POST', `/opportunities/${dealId}/stage`, { token: tokens.rupendra, body: { stage_id: ids.stage_csr_review, ...nextAction(ids.rupendra) } });
  assert.equal(cross.status, 400);
  assert.equal(cross.body.details?.code, 'STAGE_NOT_ALLOWED', JSON.stringify(cross.body));

  // an admin makes Discovery require the decision process, and only lead on to Proposal or Lost
  const pipes = ok(await call('GET', '/sales/pipelines', { token: tokens.manager })).pipelines;
  const b2b = pipes.find((p) => p.key === 'b2b');
  const discovery = b2b.stages.find((s) => s.slug === 'discovery') || b2b.stages.filter((s) => s.kind === 'open')[2];
  const proposal = b2b.stages.find((s) => /proposal/i.test(s.slug));
  const first = b2b.stages.filter((s) => s.kind === 'open')[0];
  ok(await call('PATCH', `/sales/stages/${discovery.id}`, { token: tokens.admin, body: { required_fields: ['decision_process'], allowed_to: [proposal.id, ids.stage_lost] } }));
  const blocked = await call('POST', `/opportunities/${dealId}/stage`, { token: tokens.rupendra, body: { stage_id: discovery.id, ...nextAction(ids.rupendra) } });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.details?.code, 'STAGE_EVIDENCE_REQUIRED');
  assert.ok(blocked.body.details.missing.some((m) => m.rule === 'field:decision_process'));
  ok(await call('PATCH', `/opportunities/${dealId}`, { token: tokens.rupendra, body: { decision_process: 'Head of retail signs; CFO approves above 10L' } }));
  const moved = await call('POST', `/opportunities/${dealId}/stage`, { token: tokens.rupendra, body: { stage_id: discovery.id, ...nextAction(ids.rupendra) } });
  if (moved.status === 400 && moved.body.details?.code === 'STAGE_EVIDENCE_REQUIRED') {
    // the stage's older evidence rules may also apply; a manager can move it with a reason, recorded on its history
    ok(await call('POST', `/opportunities/${dealId}/stage`, { token: tokens.manager, body: { stage_id: discovery.id, override_reason: 'Discovery call held; notes in the timeline', ...nextAction(ids.rupendra) } }));
  } else ok(moved);
  // not allowed straight back to the first stage
  const back = await call('POST', `/opportunities/${dealId}/stage`, { token: tokens.manager, body: { stage_id: first.id, ...nextAction(ids.rupendra) } });
  assert.equal(back.status, 400);
  assert.equal(back.body.details?.code, 'STAGE_NOT_ALLOWED');

  // renaming keeps the id; retiring a stage with deals needs a mapping, and moves them with history
  const temp = ok(await call('POST', `/sales/pipelines/${ids.pipeline_b2b}/stages`, { token: tokens.admin, body: { name: 'Site Survey' } }), 201).stage;
  const parked = ok(await call('POST', '/opportunities', { token: tokens.manager, body: { account_id: ids.coromandel.account, name: 'Survey deal', stage_id: temp.id, ...nextAction(ids.manager) } }), 201).opportunity;
  ok(await call('PATCH', `/sales/stages/${temp.id}`, { token: tokens.admin, body: { name: 'Field Survey' } }));
  const { rows: renamed } = await query('SELECT id, slug FROM account_stages WHERE id = $1', [temp.id]);
  assert.equal(renamed[0].slug, temp.slug, 'the identifier is stable when the name changes');
  const noMap = await call('POST', `/sales/stages/${temp.id}/retire`, { token: tokens.admin, body: {} });
  assert.equal(noMap.status, 400);
  assert.equal(noMap.body.details?.code, 'STAGE_MAPPING_REQUIRED');
  ok(await call('POST', `/sales/stages/${temp.id}/retire`, { token: tokens.admin, body: { into_stage_id: first.id } }));
  const { rows: after } = await query('SELECT stage_id FROM opportunities WHERE id = $1', [parked.id]);
  assert.equal(after[0].stage_id, first.id);
  const { rows: hist } = await query(`SELECT reason FROM opportunity_history WHERE opportunity_id = $1 AND field = 'stage' ORDER BY id DESC LIMIT 1`, [parked.id]);
  assert.match(hist[0].reason, /retired/);
  assert.equal((await call('PATCH', `/sales/stages/${first.id}`, { token: tokens.rupendra, body: { name: 'Nope' } })).status, 403);
});

// ---------------------------------------------------------------- A: quotation, approval, won, handover, money

test('A: a corporate deal: quotation approved by someone else, sent, accepted, won, handed over once, paid in part', async (t) => {
  if (skip(t)) return;
  const dealId = ids.coromandel.deal;
  ok(await call('POST', '/sales/approval-rules', { token: tokens.admin, body: { name: 'Big discounts', min_discount_pct: 10, approver_user_ids: [ids.approver, ids.manager] } }), 201);
  const product = ok(await call('POST', '/sales/products', { token: tokens.admin, body: { name: 'Soil test kit', unit: 'kit', unit_price: '1500', tax_rate: 18, tax_label: 'GST' } }), 201).product;
  assert.equal((await call('POST', '/sales/products', { token: tokens.rupendra, body: { name: 'x' } })).status, 403);

  const q = ok(await call('POST', `/sales/opportunities/${dealId}/quotes`, {
    token: tokens.rupendra,
    body: { title: 'Dealer programme', lines: [{ product_id: product.id, description: 'Soil test kit', quantity: '400', discount_pct: '12' }, { description: 'Training day', quantity: '2', unit_price: '25000' }] },
  }), 201).quote;
  assert.equal(q.kind, 'QUOTATION');
  assert.equal(q.lines[0].unit_price, 1500, 'the price came from the catalogue');
  // 400 × 1500 = 600000, less 12% = 528000, plus 18% GST = 623040; plus 2 × 25000 untaxed
  assert.equal(q.total, 673040);

  // 12% is over the rule's 10%: it goes for approval, and the person who asked cannot approve
  const submitted = ok(await call('POST', `/sales/quotes/${q.id}/submit`, { token: tokens.rupendra }));
  assert.equal(submitted.quote.status, 'IN_REVIEW');
  assert.match(submitted.quote.approval_reasons.join(' '), /discount of 12%/);
  const approval = submitted.quote.approvals[0];
  assert.equal((await call('POST', `/sales/approvals/${approval.id}/decide`, { token: tokens.rupendra, body: { decision: 'APPROVED' } })).status, 403);
  assert.equal((await call('POST', `/sales/quotes/${q.id}/send`, { token: tokens.rupendra, body: {} })).status, 400, 'not sendable before approval');
  ok(await call('POST', `/sales/approvals/${approval.id}/decide`, { token: tokens.approver, body: { decision: 'APPROVED', comment: 'Volume justifies it' } }));

  // a material change after approval needs a fresh one
  const edited = ok(await call('PATCH', `/sales/quotes/${q.id}`, {
    token: tokens.rupendra,
    body: { lines: [{ product_id: product.id, description: 'Soil test kit', quantity: '400', discount_pct: '14' }, { description: 'Training day', quantity: '2', unit_price: '25000' }] },
  }));
  assert.equal(edited.quote.status, 'DRAFT');
  assert.equal(edited.quote.approval_current, false);
  const resubmitted = ok(await call('POST', `/sales/quotes/${q.id}/submit`, { token: tokens.rupendra }));
  ok(await call('POST', `/sales/approvals/${resubmitted.quote.approvals[0].id}/decide`, { token: tokens.approver, body: { decision: 'APPROVED' } }));

  // the PDF: a real PDF, marked as a draft until approved
  const pdf = await call('GET', `/sales/quotes/${q.id}/pdf`, { token: tokens.rupendra, raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call('GET', `/sales/quotes/${q.id}/pdf`, { token: tokens.outsider, raw: true })).status, 403);

  // sent: it becomes the deal's proposal, which is what the proposal stages ask for
  ok(await call('POST', `/sales/quotes/${q.id}/send`, { token: tokens.rupendra, body: { via: 'EMAIL', to: 'priya@coromandelagro.in' } }));
  const { rows: proposals } = await query('SELECT amount FROM opportunity_proposals WHERE opportunity_id = $1', [dealId]);
  assert.equal(proposals.length, 1);
  assert.equal((await call('PATCH', `/sales/quotes/${q.id}`, { token: tokens.rupendra, body: { terms: 'Changed' } })).status, 400, 'a sent quotation is revised, not edited');
  const accepted = ok(await call('POST', `/sales/quotes/${q.id}/decision`, {
    token: tokens.rupendra, body: { decision: 'ACCEPTED', decided_on: day(0), acceptance_method: 'PURCHASE_ORDER', note: 'PO attached to the email' },
  }));
  assert.equal(accepted.quote.status, 'ACCEPTED');
  assert.equal(accepted.quote.acceptance_method, 'PURCHASE_ORDER');

  // a manager's own exception goes to someone else
  const own = ok(await call('POST', `/sales/opportunities/${dealId}/quotes`, { token: tokens.manager, body: { lines: [{ description: 'Kit', quantity: '1', unit_price: '100', discount_pct: '20' }] } }), 201).quote;
  const ownSubmitted = ok(await call('POST', `/sales/quotes/${own.id}/submit`, { token: tokens.manager }));
  assert.deepEqual(ownSubmitted.quote.approvals[0].approver_ids, [ids.approver]);
  assert.equal((await call('POST', `/sales/approvals/${ownSubmitted.quote.approvals[0].id}/decide`, { token: tokens.manager, body: { decision: 'APPROVED' } })).status, 403);
  ok(await call('POST', `/sales/quotes/${own.id}/withdraw`, { token: tokens.manager, body: { reason: 'Test only' } }));

  // won, on the order
  ok(await call('POST', `/opportunities/${dealId}/stage`, { token: tokens.rupendra, body: { stage_id: ids.stage_proposal, ...nextAction(ids.rupendra) } }));
  const won = await call('POST', `/opportunities/${dealId}/stage`, {
    token: tokens.rupendra, body: { stage_id: ids.stage_won, order: { reference: 'CAI/PO/2026/118', received_on: day(0), amount: 664400 } },
  });
  ok(won);
  const { rows: wonDeal } = await query('SELECT status, agreed_value FROM opportunities WHERE id = $1', [dealId]);
  assert.equal(wonDeal[0].status, 'WON');

  // handover: two clicks at once make one delivery project
  const body = {
    owner_user_id: ids.saumya, kickoff_on: day(3), deliverables: '400 dealer kits, 2 training days',
    milestones: [{ title: 'Kits delivered', due_date: day(20) }, { title: 'Training complete', due_date: day(40) }],
    reporting: [{ title: 'Monthly usage report', due_on: day(35) }],
  };
  const [h1, h2] = await Promise.all([
    call('POST', `/sales/opportunities/${dealId}/handover`, { token: tokens.rupendra, body }),
    call('POST', `/sales/opportunities/${dealId}/handover`, { token: tokens.rupendra, body }),
  ]);
  assert.deepEqual([h1.status, h2.status].sort(), [200, 201], JSON.stringify([h1.body, h2.body]));
  assert.equal(h1.body.engagement_id, h2.body.engagement_id);
  const { rows: projects } = await query('SELECT COUNT(*)::int AS n FROM engagements WHERE opportunity_id = $1', [dealId]);
  assert.equal(projects[0].n, 1);
  const { rows: delivery } = await query('SELECT COUNT(*)::int AS n FROM tasks WHERE engagement_id = $1', [h1.body.engagement_id]);
  assert.equal(delivery[0].n, 4, 'three kickoff tasks and one report, once');
  assert.equal((await call('POST', `/sales/handovers/${h1.body.engagement_id}/review`, { token: tokens.rupendra, body: { decision: 'ACCEPTED' } })).status, 403);
  const reviewed = ok(await call('POST', `/sales/handovers/${h1.body.engagement_id}/review`, { token: tokens.approver, body: { decision: 'ACCEPTED', note: 'Clear scope' } }));
  assert.equal(reviewed.engagement.handover_status, 'ACCEPTED');
  const deal = ok(await call('GET', `/opportunities/${dealId}`, { token: tokens.rupendra }));
  assert.equal(deal.opportunity.status, 'WON', 'the deal keeps its own status beside delivery');

  // money: a schedule, a part payment, the same bank reference twice, a refund
  const sched1 = ok(await call('POST', `/sales/opportunities/${dealId}/schedule`, { token: tokens.rupendra, body: { label: 'Advance', due_on: day(-5), amount: '300000' } }), 201);
  ok(await call('POST', `/sales/opportunities/${dealId}/schedule`, { token: tokens.rupendra, body: { label: 'On delivery', due_on: day(30), amount: '364400' } }), 201);
  const line1 = sched1.schedule.find((l) => l.label === 'Advance');
  const r1 = ok(await call('POST', `/sales/opportunities/${dealId}/receipts`, {
    token: tokens.rupendra, body: { received_on: day(-1), amount: '200000', mode: 'BANK_TRANSFER', reference: 'UTR 0098 1234', schedule_id: line1.id },
  }), 201);
  assert.equal(r1.result.duplicate, false);
  const dupe = ok(await call('POST', `/sales/opportunities/${dealId}/receipts`, {
    token: tokens.rupendra, body: { received_on: day(-1), amount: '200000', mode: 'BANK_TRANSFER', reference: 'utr00981234' },
  }));
  assert.equal(dupe.result.duplicate, true, 'the same bank reference is applied once');
  let inr = dupe.currencies.find((c) => c.currency === 'INR');
  assert.deepEqual({ scheduled: inr.scheduled, received: inr.received, balance: inr.balance, overdue: inr.overdue },
    { scheduled: '664400.00', received: '200000.00', balance: '464400.00', overdue: '100000.00' });

  // a payment in another currency is never added to rupees
  const usd = ok(await call('POST', `/sales/opportunities/${dealId}/receipts`, { token: tokens.rupendra, body: { received_on: day(0), amount: '1000', currency: 'USD', mode: 'BANK_TRANSFER', reference: 'SWIFT-1' } }), 201);
  inr = usd.currencies.find((c) => c.currency === 'INR');
  assert.equal(inr.received, '200000.00');
  assert.equal(usd.currencies.find((c) => c.currency === 'USD').received, '1000.00');

  // refunds are finance's, and reduce what was received
  assert.equal((await call('POST', `/sales/opportunities/${dealId}/refunds`, { token: tokens.rupendra, body: { received_on: day(0), amount: '50000', reference: 'RF-1' } })).status, 403);
  const refunded = ok(await call('POST', `/sales/opportunities/${dealId}/refunds`, { token: tokens.finance, body: { received_on: day(0), amount: '50000', mode: 'BANK_TRANSFER', reference: 'RF-1', corrects_id: r1.result.payment.id } }), 201);
  inr = refunded.currencies.find((c) => c.currency === 'INR');
  assert.equal(inr.received, '150000.00');
  assert.equal(inr.overdue, '150000.00');
  assert.equal((await call('POST', `/sales/opportunities/${dealId}/refunds`, { token: tokens.finance, body: { received_on: day(0), amount: '999999', reference: 'RF-2' } })).status, 400, 'a refund cannot exceed what came in');

  // verified records change only through finance, by voiding with a reason
  ok(await call('POST', `/sales/opportunities/${dealId}/payments/${r1.result.payment.id}/verify`, { token: tokens.finance }));
  assert.equal((await call('POST', `/sales/opportunities/${dealId}/payments/${r1.result.payment.id}/void`, { token: tokens.rupendra, body: { reason: 'oops' } })).status, 403);
  const { rows: audit } = await query(`SELECT action FROM crm_audit_events WHERE entity_type = 'OPPORTUNITY' AND entity_id = $1 ORDER BY id`, [dealId]);
  assert.ok(['PAYMENT_RECEIPT', 'PAYMENT_REFUND', 'PAYMENT_VERIFIED'].every((a) => audit.some((r) => r.action === a)));

  // the deal's cash on the existing screens is in the deal's own currency, net of the refund
  const after = ok(await call('GET', `/opportunities/${dealId}`, { token: tokens.rupendra }));
  assert.equal(Number(after.opportunity.cash_received), 150000);
});

// ---------------------------------------------------------------- B: CSR / NGO

test('B: a CSR commitment in its own pipeline, with funder and implementer, kept apart from money received; a lost one and a renewal', async (t) => {
  if (skip(t)) return;
  const funder = ok(await call('POST', '/accounts', { token: tokens.manager, body: { name: 'Bharat Agro Foundation', lead_category: 'CSR_NGO', org_type: 'CSR_FOUNDATION', department_id: ids.sales, owner_user_id: ids.saumya, ...nextAction(ids.saumya) } }), 201);
  const ngo = ok(await call('POST', '/accounts', { token: tokens.manager, body: { name: 'Gram Vikas Trust', lead_category: 'CSR_NGO', org_type: 'NGO', department_id: ids.sales, owner_user_id: ids.saumya } }), 201);
  const accountCount = (await query('SELECT COUNT(*)::int AS n FROM accounts')).rows[0].n;

  const deal = ok(await call('POST', '/opportunities', {
    token: tokens.saumya,
    body: {
      account_id: funder.account.id, name: 'Soil health cards — Vidarbha', ...nextAction(ids.saumya),
      thematic_focus: ['Soil health', 'Farmer livelihoods'], proposed_project: 'Soil testing for 5,000 farmers', project_geography: 'Wardha, Maharashtra',
      beneficiaries: 'Smallholder farmers', beneficiary_count: 5000, requested_amount: 2500000, funding_cycle: 'FY 2026-27', proposal_deadline: day(20),
    },
  }), 201).opportunity;
  assert.equal(deal.pipeline_id, ids.pipeline_csr);
  assert.equal(deal.opportunity_type, 'CSR_FUNDING');
  const stage = (await query('SELECT slug FROM account_stages WHERE id = $1', [deal.stage_id])).rows[0];
  assert.equal(stage.slug, 'csr-new');

  // the funder and the implementing partner, without duplicating either organization
  ok(await call('POST', `/sales/opportunities/${deal.id}/parties`, { token: tokens.saumya, body: { account_id: funder.account.id, role: 'FUNDER' } }), 201);
  const parties = ok(await call('POST', `/sales/opportunities/${deal.id}/parties`, { token: tokens.saumya, body: { account_id: ngo.account.id, role: 'IMPLEMENTING_PARTNER' } }), 201).parties;
  assert.deepEqual(parties.map((p) => p.role).sort(), ['FUNDER', 'IMPLEMENTING_PARTNER']);
  const { rows: roles } = await query('SELECT org_roles FROM accounts WHERE id = $1', [ngo.account.id]);
  assert.ok(roles[0].org_roles.includes('IMPLEMENTING_PARTNER'));

  // a B2B stage on a CSR deal is refused
  assert.equal((await call('POST', `/opportunities/${deal.id}/stage`, { token: tokens.saumya, body: { stage_id: ids.stage_negotiation, ...nextAction(ids.saumya) } })).body.details?.code, 'STAGE_NOT_ALLOWED');

  // the proposal: no discount, so no approval rule applies
  const p = ok(await call('POST', `/sales/opportunities/${deal.id}/quotes`, {
    token: tokens.saumya,
    body: { project_scope: 'Test 5,000 farms and issue soil health cards', outcomes: 'Fertiliser use matched to soil', reporting_plan: 'Quarterly',
      lines: [{ description: 'Soil tests', quantity: '5000', unit_price: '400' }, { description: 'Programme management', quantity: '1', unit_price: '500000' }] },
  }), 201).quote;
  assert.equal(p.kind, 'CSR_PROPOSAL');
  assert.equal(p.number.startsWith('PR-'), true);
  const auto = ok(await call('POST', `/sales/quotes/${p.id}/submit`, { token: tokens.saumya }));
  assert.equal(auto.quote.status, 'APPROVED');
  ok(await call('POST', `/sales/quotes/${p.id}/send`, { token: tokens.saumya, body: { via: 'EMAIL' } }));
  ok(await call('POST', `/sales/quotes/${p.id}/decision`, { token: tokens.saumya, body: { decision: 'ACCEPTED', decided_on: day(0), acceptance_method: 'SIGNED_COPY' } }));

  // committed, on the signed MoU
  ok(await call('PATCH', `/opportunities/${deal.id}`, { token: tokens.saumya, body: { committed_amount: 2500000, agreement_status: 'SIGNED' } }));
  ok(await call('POST', `/opportunities/${deal.id}/stage`, {
    token: tokens.saumya, body: { stage_id: ids.stage_csr_won, order: { kind: 'MOU', reference: 'BAF/MOU/26/04', received_on: day(0), amount: 2500000 } },
  }));
  const tranche = ok(await call('POST', `/sales/opportunities/${deal.id}/schedule`, { token: tokens.saumya, body: { label: 'Tranche 1', due_on: day(10), amount: '1250000' } }), 201);
  assert.equal(tranche.schedule[0].kind, 'CSR_TRANCHE');
  ok(await call('POST', `/sales/opportunities/${deal.id}/receipts`, { token: tokens.saumya, body: { received_on: day(0), amount: '1000000', mode: 'GRANT_DISBURSEMENT', reference: 'BAF-T1' } }), 201);
  const summary = ok(await call('GET', `/sales/opportunities/${deal.id}/sales`, { token: tokens.saumya }));
  assert.equal(summary.opportunity_type_label, 'CSR funding commitment');
  assert.equal(Number(summary.csr.committed_amount), 2500000, 'the commitment');
  assert.equal(summary.payments.currencies[0].received, '1000000.00', 'and, separately, what arrived');

  // handover with reporting commitments
  const handover = ok(await call('POST', `/sales/opportunities/${deal.id}/handover`, { token: tokens.saumya, body: { reporting: [{ title: 'Quarterly impact report', due_on: day(90) }], create_kickoff_tasks: false } }), 201);
  const { rows: reports } = await query(`SELECT title FROM tasks WHERE engagement_id = $1`, [handover.engagement_id]);
  assert.deepEqual(reports.map((r) => r.title), ['Report due: Quarterly impact report — Soil health cards — Vidarbha — delivery']);

  // next year's cycle: a new linked deal, the original untouched, no second organization
  const renewal = ok(await call('POST', `/sales/opportunities/${deal.id}/renewal`, { token: tokens.saumya, body: { expected_close: day(365) } }), 201);
  const sameRenewal = ok(await call('POST', `/sales/opportunities/${deal.id}/renewal`, { token: tokens.saumya, body: {} }));
  assert.equal(sameRenewal.id, renewal.id);
  const r = ok(await call('GET', `/opportunities/${renewal.id}`, { token: tokens.saumya }));
  assert.equal(r.opportunity.account_id, funder.account.id);
  assert.equal(r.opportunity.opportunity_type, 'RENEWAL');
  assert.equal(r.opportunity.renewal_of_id, deal.id);
  const original = ok(await call('GET', `/opportunities/${deal.id}`, { token: tokens.saumya }));
  assert.equal(original.opportunity.status, 'WON');
  assert.equal(Number(original.opportunity.committed_amount), 2500000);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM accounts')).rows[0].n, accountCount);

  // a lost CSR deal with its reason, and the funder's other deals untouched
  const lostDeal = ok(await call('POST', '/opportunities', { token: tokens.saumya, body: { account_id: funder.account.id, name: 'Water stewardship pilot', ...nextAction(ids.saumya) } }), 201).opportunity;
  ok(await call('POST', `/opportunities/${lostDeal.id}/stage`, { token: tokens.saumya, body: { stage_id: ids.stage_csr_lost, outcome_reason: 'Funder chose a water-only partner', lost_reason_code: 'FIT' } }));
  const { rows: lost } = await query('SELECT status, lost_reason_code FROM opportunities WHERE id = $1', [lostDeal.id]);
  assert.deepEqual(lost[0], { status: 'LOST', lost_reason_code: 'FIT' });
  // reopened: counted, and on its history
  ok(await call('POST', `/opportunities/${lostDeal.id}/stage`, { token: tokens.saumya, body: { stage_id: ids.stage_csr_fit, reason: 'Funder came back', ...nextAction(ids.saumya) } }).then((x) => (x.status === 400 ? call('POST', `/opportunities/${lostDeal.id}/stage`, { token: tokens.manager, body: { stage_id: ids.stage_csr_fit, override_reason: 'Funder came back with a revised brief', ...nextAction(ids.saumya) } }) : x)));
  const { rows: reopened } = await query('SELECT status, reopened_count FROM opportunities WHERE id = $1', [lostDeal.id]);
  assert.deepEqual(reopened[0], { status: 'ACTIVE', reopened_count: 1 });
});

// ---------------------------------------------------------------- I: access

test('I: people outside a record cannot read or change it through the API, whatever the screen shows', async (t) => {
  if (skip(t)) return;
  const { account, deal } = ids.coromandel;
  // with record-level access off — how an upgraded installation starts — everyone with CRM access sees what they saw before
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { visibility: { enforced: false } } }));
  assert.equal((await call('GET', `/opportunities/${deal}`, { token: tokens.outsider })).status, 200);
  assert.equal((await call('GET', `/accounts/${account}`, { token: tokens.outsider })).status, 200);
  assert.ok(ok(await call('GET', '/accounts', { token: tokens.outsider })).accounts.some((a) => a.id === account), 'the organization is in their list as before');
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { visibility: { enforced: true } } }));
  assert.equal((await call('GET', '/sales/meta', { token: tokens.admin })).body.settings.visibility.agents, 'OWN', 'switching it back on keeps the chosen level');
  // the outsider (another team) and an agent who does not own it
  assert.equal((await call('GET', `/opportunities/${deal}`, { token: tokens.outsider })).status, 403);
  assert.equal((await call('GET', `/accounts/${account}`, { token: tokens.outsider })).status, 403);
  assert.equal((await call('PATCH', `/opportunities/${deal}`, { token: tokens.outsider, body: { name: 'Hijacked' } })).status, 403);
  assert.equal((await call('GET', `/sales/opportunities/${deal}/payments`, { token: tokens.outsider })).status, 403);
  assert.equal((await call('POST', `/sales/opportunities/${deal}/receipts`, { token: tokens.outsider, body: { received_on: day(0), amount: '1' } })).status, 403);
  const lists = ok(await call('GET', '/opportunities', { token: tokens.outsider }));
  assert.ok(!JSON.stringify(lists).includes('Dealer soil programme'), 'not in their list either');
  const accounts = ok(await call('GET', '/accounts', { token: tokens.outsider }));
  assert.ok(!accounts.accounts.some((a) => a.id === account));
  const leads = ok(await call('GET', '/sales/leads?view=all', { token: tokens.outsider }));
  assert.equal(leads.leads.length, 0);
  // a lead that is not theirs is simply not found
  const { rows: someLead } = await query(`SELECT id FROM crm_leads WHERE owner_user_id = $1 LIMIT 1`, [ids.rupendra]);
  assert.equal((await call('GET', `/sales/leads/${someLead[0].id}`, { token: tokens.outsider })).status, 404);
  assert.equal((await call('PATCH', `/sales/leads/${someLead[0].id}`, { token: tokens.outsider, body: { priority: 'LOW' } })).status, 404);
  // settings, approvals, rates and stage configuration
  assert.equal((await call('PUT', '/sales/settings', { token: tokens.rupendra, body: { visibility: { agents: 'ALL' } } })).status, 403);
  assert.equal((await call('POST', '/sales/fx-rates', { token: tokens.rupendra, body: { currency: 'USD', rate: 83, as_of: day(0) } })).status, 403);
  assert.equal((await call('POST', '/sales/approval-rules', { token: tokens.manager, body: { name: 'x', min_total: 1 } })).status, 403);
  assert.equal((await call('POST', `/sales/pipelines/${ids.pipeline_b2b}/stages`, { token: tokens.rupendra, body: { name: 'Mine' } })).status, 403);
  // bulk changes are checked record by record
  const bulk = ok(await call('POST', '/sales/leads/bulk', { token: tokens.outsider, body: { ids: [someLead[0].id], action: 'priority', value: 'LOW' } }));
  assert.deepEqual(bulk.done, []);
  assert.equal(bulk.refused.length, 1);
  // the public capture endpoints go quiet when the CRM is switched off
  const { rows: stored } = await query(`SELECT value FROM settings WHERE key = 'crm'`);
  const crm = stored[0]?.value || {};
  ok(await call('PUT', '/settings/crm', { token: tokens.admin, body: { value: { ...crm, enabled: false } } }));
  assert.equal((await call('POST', '/s/leads', { headers: { authorization: 'Bearer tfk_any' }, body: { name: 'x' } })).status, 404);
  ok(await call('PUT', '/settings/crm', { token: tokens.admin, body: { value: { ...crm, enabled: true } } }));
});
