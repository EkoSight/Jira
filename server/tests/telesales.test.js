/**
 * Tele-sales in TaskFlow, replacing TeleCRM:
 *
 *   T1  a TeleCRM export, read with its preset: Hindi and English answers,
 *       "-" and "_" as blank, day-first dates in India time, misspelt states,
 *       statuses and lost reasons kept, notes on the timeline, owners by email,
 *       two TeleCRM records sharing an email both kept, no alert flood; then a
 *       later export of the same leads updates them, but never a status
 *       someone has changed here since
 *   T2  calling statuses: no answer retries until the attempt limit, an
 *       interested lead that does not pick up stays interested, lost needs a
 *       reason, won closes the lead and its follow-ups, a callback replaces the
 *       retry, a status can settle an unknown category
 *   T3  the call queue: callbacks, then new leads, then retries that are due
 *   T4  retailers, FPOs and individuals worked here: an unknown lead is its
 *       owner's to classify, an individual converts into the retail pipeline,
 *       lead fields are checked and an answer sets the category; while TeleCRM
 *       is still in use they are handed over, and later brought back in
 *   T5  the calling report
 *
 * The TeleCRM file here is made up in TeleCRM's format; no real data is used.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { processImports } from '../src/services/sales/imports.js';
import { scanTimers } from '../src/services/sales/automation.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

const call = async (method, path, { token, body, rawBody = null, contentType = 'application/json' } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const csv = (rows) => Buffer.from(`﻿${rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')}`);
const status = async (key) => (await query('SELECT id FROM crm_call_statuses WHERE key = $1', [key])).rows[0].id;
const lead = async (filter, params) => (await query(`SELECT * FROM crm_leads WHERE ${filter}`, params)).rows[0];

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('TEL', 'Tele-sales', '#2a78d6', 1), ('OPS', 'Operations', '#7c3aed', 2)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do','to-do','todo','#3b82f6',1,TRUE), ('Done','done','done','#22c55e',2,FALSE), ('Cancelled','cancelled','cancelled','#94a3b8',3,FALSE)`);
  const { rows: depts } = await query('SELECT id, key FROM departments');
  const dept = Object.fromEntries(depts.map((d) => [d.key, d.id]));
  const password = await hashPassword('Password123!');
  for (const [key, email, role, d] of [['admin', 'tele-admin@test.local', 'admin', 'TEL'], ['manager', 'tele-manager@test.local', 'manager', 'TEL'],
    ['isha', 'isha@test.local', 'member', 'TEL'], ['ravi', 'ravi@test.local', 'member', 'TEL'], ['ops', 'tele-ops@test.local', 'member', 'OPS']]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, phone) VALUES ($1,$2,$3,$4,$5,FALSE,'9800000099') RETURNING id`,
      [key[0].toUpperCase() + key.slice(1), email, password, role, dept[d]],
    );
    ids[key] = rows[0].id;
    ids[`${key}_email`] = email;
  }
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'manager', 'isha', 'ravi', 'ops']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: ids[`${key}_email`], password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

const HEADER = ['Status', 'Lost Reason', 'Rating', 'Assignee name', 'Assignee emailid', 'Full Name', 'Mobile Number', 'Date', 'First Call Descripton',
  'You are associated with agriculture as', 'Service Needed', 'State Lead Belongs To', 'Company Name or Shop Name', 'Shop Duration', 'Event Name', 'District',
  'Designation', 'E-Mail Address', 'Campaign Name', 'How did you hear about us', 'Created On', 'Modified On', 'Assignee Manager name',
  'Assignee Manager emailid', 'Lead Link', 'Lead id', 'Batch Names'];
const row = (o) => HEADER.map((h) => o[h] ?? (['Full Name', 'Company Name or Shop Name', 'Shop Duration', 'District', 'Designation', 'E-Mail Address', 'How did you hear about us'].includes(h) ? '_' : '-'));
const telecrm = (overrides) => row({
  'Assignee name': 'Isha', 'Assignee emailid': 'isha@test.local', 'Lead Link': `https://next.telecrm.in/x/l/${overrides['Lead id']}`, 'Rating': '', 'Batch Names': '', ...overrides,
});

// ---------------------------------------------------------------- T1

test('T1: a TeleCRM export is read with its preset, keeps every record and status, and a later export updates without undoing work done here', async (t) => {
  if (skip(t)) return;
  const file = csv([HEADER,
    telecrm({ 'Lead id': 'T-1', Status: 'Interested', 'Full Name': 'Krishan', 'Mobile Number': '918005548643', 'First Call Descripton': 'Agri retailer, seeds and pesticide. Will discuss with partner.',
      'You are associated with agriculture as': 'कृषि विक्रेता (Agri-Retailer)', 'Service Needed': 'Soil Doctor Clinic Setup', 'State Lead Belongs To': 'Maharastra',
      'Shop Duration': '1 year', 'District': 'nagpur', 'How did you hear about us': 'इंस्टाग्राम (Instagram)', 'Campaign Name': 'Maharastra Campaign (15.09.2026)',
      'Created On': '30/10/2026 11:50:36', 'Modified On': '30/10/2026 11:51:35', 'Rating': '5', 'Batch Names': 'Form responses 1' }),
    telecrm({ 'Lead id': 'T-2', Status: 'Ringing Not Responding', 'Mobile Number': '919426366907', 'Created On': '29/10/2026 11:08:11', 'Modified On': '29/10/2026 11:19:12' }),
    telecrm({ 'Lead id': 'T-3', Status: 'Lost', 'Lost Reason': 'No Need', 'Full Name': 'Musafir', 'Mobile Number': '919752139476', 'You are associated with agriculture as': 'Farmer (किसान)',
      'Created On': '14/01/2026 16:12:21', 'Modified On': '16/03/2026 15:08:00', 'E-Mail Address': 'shared@example.com' }),
    telecrm({ 'Lead id': 'T-4', Status: 'Won', 'Full Name': 'Sahyadri FPC', 'Mobile Number': '919800000004', 'You are associated with agriculture as': 'एफपीओ / एफपीसी FPO / FPC',
      'Service Needed': 'Soil and Water Testing Service  Soil Doctor Kit', 'State Lead Belongs To': 'Gujrat', 'Created On': '01/09/2026 10:00:00', 'Modified On': '20/10/2026 10:00:00',
      'Event Name': 'Pusa Vigyan Mela', 'E-Mail Address': 'shared@example.com' }),
    telecrm({ 'Lead id': 'T-5', Status: 'Student Who Wants to Start A SDC', 'Full Name': 'Asha', 'Mobile Number': '919800000005', 'Assignee emailid': 'someone.gone@test.local',
      'How did you hear about us': 'INstargram', 'Created On': '02/10/2026 09:00:00', 'Modified On': '02/10/2026 09:30:00', 'E-Mail Address': 'not-an-email' }),
    telecrm({ 'Lead id': 'T-6', Status: 'Fresh', 'Mobile Number': '919800000006', 'Created On': '30/10/2026 12:00:00', 'Modified On': '30/10/2026 12:00:00',
      'You are associated with agriculture as': 'Other', 'Date': '19/01/2026 10:58:12' }),
  ]);
  const up = ok(await call('POST', '/sales/imports?entity=LEADS&filename=telecrm.csv', { token: tokens.manager, rawBody: file, contentType: 'text/csv' }), 201);
  assert.equal(up.preset, 'TELECRM');
  assert.deepEqual(up.preset_ignored.sort(), ['Assignee Manager emailid', 'Assignee Manager name', 'Assignee name']);
  assert.equal(up.job.mapping['cf:agri_role'], 'You are associated with agriculture as');
  assert.equal(up.job.mapping.notes, 'First Call Descripton');

  const counts = ok(await call('POST', `/sales/imports/${up.job.id}/validate`, { token: tokens.manager, body: { mapping: up.job.mapping } })).counts;
  assert.deepEqual({ valid: counts.valid, invalid: counts.invalid, duplicate: counts.duplicate }, { valid: 6, invalid: 0, duplicate: 0 }, 'two TeleCRM records sharing an email are both kept');
  ok(await call('POST', `/sales/imports/${up.job.id}/run`, { token: tokens.manager }), 202);
  await processImports(); await processImports();
  const detail = ok(await call('GET', `/sales/imports/${up.job.id}`, { token: tokens.manager }));
  assert.equal(detail.job.status, 'DONE');
  const warnings = detail.rows.flatMap((r) => r.warnings).join(' | ');
  assert.match(warnings, /someone\.gone@test\.local" is not a TaskFlow user; left unassigned/);
  assert.match(warnings, /Email "not-an-email" is not an email address; left out/);
  assert.match(warnings, /Shares an email or phone with row/);

  const t1 = await lead(`external_id = 'T-1' AND source_system = 'telecrm'`);
  assert.equal(t1.category, 'RETAILER', 'the Hindi answer says who they are');
  assert.equal(t1.destination, 'TASKFLOW');
  assert.equal(t1.status, 'QUALIFYING');
  assert.equal(t1.state, 'Maharashtra');
  assert.equal(t1.city, 'Nagpur');
  assert.equal(t1.rating, 5);
  assert.equal(t1.owner_user_id, ids.isha);
  assert.deepEqual(t1.custom_fields, { agri_role: 'agri_retailer', service_needed: ['clinic_setup'], shop_duration: '1 year', telecrm_link: 'https://next.telecrm.in/x/l/T-1' });
  assert.deepEqual(t1.tags, ['Form responses 1']);
  assert.equal(t1.captured_at.toISOString(), '2026-10-30T06:20:36.000Z', '11:50:36 in India');
  assert.equal(t1.last_contacted_at.toISOString(), '2026-10-30T06:21:35.000Z', 'they spoke: the last-modified time stands in for the last conversation');
  const { rows: [src] } = await query('SELECT s.key, c.name FROM crm_leads l JOIN crm_sources s ON s.id = l.original_source_id JOIN crm_campaigns c ON c.id = l.original_campaign_id WHERE l.id = $1', [t1.id]);
  assert.deepEqual(src, { key: 'instagram', name: 'Maharastra Campaign (15.09.2026)' }, 'the campaign is added as TeleCRM named it');
  const { rows: notes } = await query(`SELECT subject, body FROM crm_lead_activities WHERE lead_id = $1 AND type = 'IMPORT_NOTE'`, [t1.id]);
  assert.deepEqual(notes, [{ subject: 'Notes from TeleCRM', body: 'Agri retailer, seeds and pesticide. Will discuss with partner.' }]);

  const t2 = await lead(`external_id = 'T-2'`);
  assert.equal(t2.category, 'UNCLASSIFIED');
  assert.equal(t2.destination, 'TASKFLOW', 'not known yet, but worked here by its owner');
  assert.equal(t2.owner_user_id, ids.isha);
  assert.equal(t2.status, 'CONTACTED');
  assert.equal(t2.contact_name, null, '"_" is blank');
  assert.equal(t2.retry_at.toISOString(), new Date(Date.parse('2026-10-29T05:49:12Z') + 180 * 60_000).toISOString(), 'no answer: retried three hours after the last attempt');
  assert.equal(t2.last_contacted_at, null, 'nobody answered');

  const t3 = await lead(`external_id = 'T-3'`);
  assert.deepEqual([t3.category, t3.status, t3.disqualify_reason], ['INDIVIDUAL', 'DISQUALIFIED', 'No Need']);
  const t4 = await lead(`external_id = 'T-4'`);
  assert.deepEqual([t4.category, t4.status, t4.state], ['FPO', 'WON', 'Gujarat']);
  assert.deepEqual(t4.custom_fields.service_needed.sort(), ['kit', 'testing_service'], 'two services run together are both read');
  const { rows: [ev] } = await query('SELECT s.key FROM crm_sources s WHERE s.id = $1', [t4.original_source_id]);
  assert.equal(ev.key, 'event', 'an event with no other source is the source');
  const t5 = await lead(`external_id = 'T-5'`);
  assert.deepEqual([t5.category, t5.owner_user_id, t5.email], ['INDIVIDUAL', null, null], 'the status says who they are; the unknown assignee leaves it unassigned');
  const t6 = await lead(`external_id = 'T-6'`);
  assert.deepEqual([t6.category, t6.status, t6.custom_fields.agri_role, t6.custom_fields.telecrm_date], ['UNCLASSIFIED', 'NEW', 'other', '19/01/2026 10:58:12']);

  // historical leads do not set off new-lead alarms
  await scanTimers(new Date());
  const { rows: sla } = await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE type IN ('crm_sla')`);
  assert.equal(sla[0].n, 0);
  const { rows: lc } = await query(`SELECT COUNT(*)::int AS n FROM crm_events WHERE type = 'lead.captured'`);
  assert.equal(lc[0].n, 0, 'automation for new leads does not run for history');

  // Isha works T-1 here: she changes its status
  ok(await call('POST', `/sales/leads/${t1.id}/call-status`, { token: tokens.isha, body: { status_id: await status('hot'), note: 'Wants a quotation' } }));

  // a later export from TeleCRM (the last one before the subscription ends): T-1 says "Lost" there,
  // T-2 is now "Interested", T-7 is new. Its dates are earlier today, so the file is in the past whenever this runs.
  const stamp = (minutesAgo) => {
    const d = new Date(Date.now() - minutesAgo * 60_000);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
  };
  const later = csv([HEADER,
    telecrm({ 'Lead id': 'T-1', Status: 'Lost', 'Lost Reason': 'Budget Issues', 'Mobile Number': '918005548643', 'Created On': '30/10/2026 11:50:36', 'Modified On': stamp(30) }),
    telecrm({ 'Lead id': 'T-2', Status: 'Interested', 'Full Name': 'Trazo', 'Mobile Number': '919426366907', 'First Call Descripton': 'Called back, wants a kit',
      'Created On': '29/10/2026 11:08:11', 'Modified On': stamp(20) }),
    telecrm({ 'Lead id': 'T-7', Status: 'Fresh', 'Mobile Number': '919800000007', 'Created On': stamp(10), 'Modified On': stamp(10) }),
  ]);
  const up2 = ok(await call('POST', '/sales/imports?entity=LEADS&filename=telecrm-final.csv', { token: tokens.manager, rawBody: later, contentType: 'text/csv' }), 201);
  const c2 = ok(await call('POST', `/sales/imports/${up2.job.id}/validate`, { token: tokens.manager, body: { mapping: up2.job.mapping } })).counts;
  assert.deepEqual({ valid: c2.valid, duplicate: c2.duplicate }, { valid: 1, duplicate: 2 });
  ok(await call('POST', `/sales/imports/${up2.job.id}/run`, { token: tokens.manager }), 202);
  await processImports();
  const after1 = await lead('id = $1', [t1.id]);
  assert.equal(after1.status, 'QUALIFIED', 'the status Isha set here is kept');
  assert.equal(after1.call_status_id, await status('hot'));
  const after2 = await lead('id = $1', [t2.id]);
  assert.deepEqual([after2.call_status_id, after2.status, after2.contact_name], [await status('interested'), 'QUALIFYING', 'Trazo'], 'what only TeleCRM changed is brought up to date');
  const { rows: n2 } = await query(`SELECT body FROM crm_lead_activities WHERE lead_id = $1 AND type = 'IMPORT_NOTE' AND body IS NOT NULL`, [t2.id]);
  assert.deepEqual(n2.map((n) => n.body), ['Called back, wants a kit']);
  const rows2 = ok(await call('GET', `/sales/imports/${up2.job.id}`, { token: tokens.manager })).rows;
  assert.ok(rows2.find((r) => r.entity_id === t1.id).warnings.some((w) => /changed in TaskFlow since; kept/.test(w)));
  assert.ok(await lead(`external_id = 'T-7'`));
  ids.t1 = t1.id; ids.t2 = t2.id; ids.t6 = t6.id;
});

// ---------------------------------------------------------------- T2

test('T2: calling statuses count attempts, retry no answers up to a limit, keep what a conversation established, and close leads properly', async (t) => {
  if (skip(t)) return;
  const create = async (body) => ok(await call('POST', '/sales/leads', { token: tokens.isha, body: { owner_user_id: ids.isha, ...body } }), 201).lead;
  const l = await create({ category: 'RETAILER', contact_name: 'Mahesh', phone: '9811100201' });
  const rnr = await status('ringing-not-responding');
  const r1 = ok(await call('POST', `/sales/leads/${l.id}/call-status`, { token: tokens.isha, body: { status_id: rnr } }));
  assert.equal(r1.attempts, 1);
  assert.equal(r1.lead.status, 'CONTACTED');
  assert.ok(Math.abs(new Date(r1.lead.retry_at).getTime() - (Date.now() + 180 * 60_000)) < 60_000, 'tried again in three hours');
  const { rows: calls } = await query('SELECT status, outcome, agent_user_id FROM crm_calls WHERE lead_id = $1', [l.id]);
  assert.deepEqual(calls, [{ status: 'NO_ANSWER', outcome: 'NO_ANSWER', agent_user_id: ids.isha }], 'the call itself is logged');
  // five more unanswered calls reach the limit of six: no more automatic retries
  let last;
  for (let i = 0; i < 5; i += 1) last = ok(await call('POST', `/sales/leads/${l.id}/call-status`, { token: tokens.isha, body: { status_id: rnr } }));
  assert.equal(last.attempts, 6);
  assert.equal(last.exhausted, true);
  assert.equal(last.lead.retry_at, null);

  // an interested lead that does not pick up stays interested
  const keen = await create({ category: 'INDIVIDUAL', contact_name: 'Sita', phone: '9811100202' });
  ok(await call('POST', `/sales/leads/${keen.id}/call-status`, { token: tokens.isha, body: { status_id: await status('interested'), note: 'Wants the kit price' } }));
  const busy = ok(await call('POST', `/sales/leads/${keen.id}/call-status`, { token: tokens.isha, body: { status_id: await status('busy') } }));
  assert.equal(busy.lead.status, 'QUALIFYING');
  assert.equal(busy.lead.call_status_key, 'busy');
  assert.ok(busy.lead.last_contacted_at, 'the earlier conversation still counts');

  // a callback agreed on the call replaces the automatic retry
  const cb = ok(await call('POST', `/sales/leads/${keen.id}/call-status`, { token: tokens.isha, body: { status_id: await status('busy'), callback_at: new Date(Date.now() + 2 * 3600_000).toISOString() } }));
  assert.equal(cb.lead.retry_at, null);
  assert.ok(cb.callback?.id);

  // lost needs a reason; won closes the lead and its follow-ups
  const lost = await call('POST', `/sales/leads/${keen.id}/call-status`, { token: tokens.isha, body: { status_id: await status('lost') } });
  assert.equal(lost.status, 400);
  assert.equal(lost.body.details.code, 'REASON_REQUIRED');
  const won = ok(await call('POST', `/sales/leads/${keen.id}/call-status`, { token: tokens.isha, body: { status_id: await status('won'), note: 'Paid for a kit', rating: 4 } }));
  assert.equal(won.lead.status, 'WON');
  assert.equal(won.lead.rating, 4);
  const { rows: open } = await query('SELECT COUNT(*)::int AS n FROM tasks WHERE crm_lead_id = $1 AND completed_at IS NULL AND crm_cancel_reason IS NULL', [keen.id]);
  assert.equal(open[0].n, 0, 'the callback is cancelled with the reason');

  // a status that says who they are settles an unknown category
  const unknown = await create({ category: 'UNCLASSIFIED', phone: '9811100203' });
  const farmer = ok(await call('POST', `/sales/leads/${unknown.id}/call-status`, { token: tokens.isha, body: { status_id: await status('farmer-soil-testing') } }));
  assert.equal(farmer.lead.category, 'INDIVIDUAL');

  // someone else's lead is not theirs to update
  assert.equal((await call('POST', `/sales/leads/${l.id}/call-status`, { token: tokens.ravi, body: { status_id: rnr } })).status, 403);
  // a closed lead's history shows each status change
  const tl = ok(await call('GET', `/sales/leads/${keen.id}`, { token: tokens.isha })).timeline;
  assert.deepEqual(tl.filter((a) => a.type === 'CALL_STATUS').map((a) => a.subject).reverse(), ['Status: Interested', 'Status: Busy', 'Status: Busy', 'Status: Won']);
});

// ---------------------------------------------------------------- T3

test('T3: the call queue puts due callbacks first, then new leads newest first, then retries that are due', async (t) => {
  if (skip(t)) return;
  const make = async (phone, extra = {}) => (await query(
    `INSERT INTO crm_leads (ref, category, destination, routing_status, status, phone, phone_normalized, owner_user_id, captured_at, retry_at, call_attempts, last_called_at)
     VALUES ($1,'RETAILER','TASKFLOW','ACTIVE',$2,$3,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [`Q-${phone}`, extra.status || 'NEW', phone, ids.ravi, extra.captured || new Date(), extra.retry || null, extra.attempts || 0, extra.called || null],
  )).rows[0].id;
  const older = await make('9100000001', { captured: new Date(Date.now() - 3 * 86400_000) });
  const newer = await make('9100000002', { captured: new Date(Date.now() - 3600_000) });
  const retryDue = await make('9100000003', { status: 'CONTACTED', retry: new Date(Date.now() - 60_000), attempts: 1, called: new Date(Date.now() - 4 * 3600_000) });
  await make('9100000004', { status: 'CONTACTED', retry: new Date(Date.now() + 3600_000), attempts: 1, called: new Date() });
  const callback = await make('9100000005', { status: 'QUALIFYING', attempts: 2, called: new Date(Date.now() - 86400_000) });
  ok(await call('POST', '/sales/followups', { token: tokens.ravi, body: { lead_id: callback, kind: 'CALLBACK', due_at: new Date(Date.now() + 5 * 60_000).toISOString() } }), 201);
  const q = ok(await call('GET', '/sales/call-queue', { token: tokens.ravi }));
  assert.deepEqual(q.items.map((i) => [i.id, i.queue_reason]), [[callback, 'CALLBACK'], [newer, 'NEW'], [older, 'NEW'], [retryDue, 'RETRY']]);
  assert.deepEqual([q.counts.new, q.counts.retries_due, q.counts.retries_later, q.counts.callbacks_due], [2, 1, 1, 1]);
  // a manager may look at someone's queue; another agent may not
  ok(await call('GET', `/sales/call-queue?user_id=${ids.ravi}`, { token: tokens.manager }));
  assert.equal((await call('GET', `/sales/call-queue?user_id=${ids.ravi}`, { token: tokens.isha })).status, 403);
});

// ---------------------------------------------------------------- T4

test('T4: retailers, FPOs and individuals are worked here; lead fields are checked; while TeleCRM is in use they go there and later come back', async (t) => {
  if (skip(t)) return;
  // an unknown lead is in its owner's own list, and the owner says who it is
  const mine = ok(await call('GET', '/sales/leads?view=mine', { token: tokens.isha })).leads.map((l) => l.id);
  assert.ok(mine.includes(ids.t6), 'the unclassified lead is in its owner\'s list');
  const set = ok(await call('PATCH', `/sales/leads/${ids.t6}`, { token: tokens.isha, body: { custom_fields: { agri_role: 'farmer' } } }));
  assert.equal(set.lead.category, 'INDIVIDUAL', 'the answer settles the category');
  const bad = await call('PATCH', `/sales/leads/${ids.t6}`, { token: tokens.isha, body: { custom_fields: { agri_role: 'astronaut' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Associated with agriculture as: "astronaut" is not one of the choices/);
  // a choice leads hold cannot be removed from under them
  const { rows: [field] } = await query(`SELECT * FROM crm_lead_fields WHERE key = 'agri_role'`);
  const shrink = await call('PATCH', `/sales/lead-fields/${field.id}`, { token: tokens.admin, body: { options: field.options.filter((o) => o.value !== 'farmer') } });
  assert.equal(shrink.status, 409);

  // an individual farmer converts into the retail pipeline under their own name
  ok(await call('PATCH', `/sales/leads/${ids.t6}`, { token: tokens.isha, body: { contact_name: 'Ramesh Patel' } }));
  const conv = ok(await call('POST', `/sales/leads/${ids.t6}/convert`, { token: tokens.isha, body: {} }), 201);
  const { rows: [acc] } = await query('SELECT name, org_type, lead_category, routing_status FROM accounts WHERE id = $1', [conv.accountId]);
  assert.deepEqual(acc, { name: 'Ramesh Patel', org_type: 'INDIVIDUAL', lead_category: 'INDIVIDUAL', routing_status: 'ACTIVE' });
  const { rows: [deal] } = await query('SELECT p.key FROM opportunities o JOIN crm_pipelines p ON p.id = o.pipeline_id WHERE o.id = $1', [conv.opportunityId]);
  assert.equal(deal.key, 'retail');
  // and the retail board shows it
  const board = ok(await call('GET', '/opportunities/board?pipeline=retail', { token: tokens.isha }));
  assert.ok(board.stages.some((s) => s.deals.some((d) => d.id === conv.opportunityId)));

  // while TeleCRM is still in use: a new retailer is handed over
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { routing: { excludedDestination: 'TELECRM' } } }));
  const handed = ok(await call('POST', '/sales/leads', { token: tokens.isha, body: { category: 'RETAILER', contact_name: 'Gopal', phone: '9811100301' } }), 201).lead;
  assert.equal(handed.destination, 'TELECRM');
  const refusedBringIn = await call('POST', '/sales/routing/bring-in', { token: tokens.admin });
  assert.equal(refusedBringIn.status, 409, 'bringing them in waits for the setting');
  // the day TeleCRM stops: work them here, and bring the waiting ones in
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { routing: { excludedDestination: 'TASKFLOW' } } }));
  const brought = ok(await call('POST', '/sales/routing/bring-in', { token: tokens.admin }));
  assert.ok(brought.leads >= 1);
  const back = await lead('id = $1', [handed.id]);
  assert.deepEqual([back.destination, back.routing_status], ['TASKFLOW', 'ACTIVE']);
  const { rows: ho } = await query('SELECT status FROM crm_handoffs WHERE lead_id = $1', [handed.id]);
  assert.deepEqual(ho.map((h) => h.status), ['CANCELLED'], 'the hand-off is kept as history');
  assert.equal((await call('POST', '/sales/routing/bring-in', { token: tokens.isha })).status, 403);
});

// ---------------------------------------------------------------- T5

test('T5: the calling report counts statuses for the period\'s leads and each person\'s calls and connections', async (t) => {
  if (skip(t)) return;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const r = ok(await call('GET', `/sales/reports/calling?from=${today}&to=${today}&owner_id=${ids.isha}`, { token: tokens.admin }));
  const byKey = Object.fromEntries(r.statuses.map((s) => [s.label, s.leads]));
  assert.equal(byKey['Ringing Not Responding'], 1, 'Mahesh, after six unanswered calls');
  assert.equal(byKey.Won, 1);
  const isha = r.people.find((p) => p.id === ids.isha);
  // Mahesh: 6 unanswered; Sita: interested (answered), busy, busy, won (answered); the unknown farmer: answered; T-1 hot: answered
  assert.equal(isha.calls, 12);
  assert.equal(isha.connected, 4);
  assert.equal(isha.won, 1);
  const byCategory = ok(await call('GET', `/sales/reports/calling?from=${today}&to=${today}&by=category`, { token: tokens.admin })).breakdown;
  assert.ok(byCategory.some((b) => b.value === 'RETAILER'));
  const byService = ok(await call('GET', `/sales/reports/calling?from=2026-01-01&to=${today}&by=cf:service_needed`, { token: tokens.admin })).breakdown;
  assert.ok(byService.some((b) => b.value === 'clinic_setup' && b.leads >= 1));
  // an agent's report covers only their own leads once record-level access is on
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { visibility: { agents: 'OWN', enforced: true } } }));
  const ravi = ok(await call('GET', `/sales/reports/calling?from=${today}&to=${today}`, { token: tokens.ravi }));
  assert.ok(!ravi.people.some((p) => p.id === ids.isha));
});
