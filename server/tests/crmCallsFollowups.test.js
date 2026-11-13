/**
 * Acceptance tests for calls, lead locations, the My Day queue, follow-up
 * reminders and the daily Chat summary:
 *
 *   K1  two rapid submissions of one call make one call; two genuine calls
 *       stay two; a retry after a lost answer returns the first call
 *   K2  correcting a call's note never makes a call; its history is kept;
 *       counts, the Calls list, the timeline and the export agree by call id
 *   K3  a manager marks a reviewed accidental repeat: kept, not counted, and
 *       restorable; nobody else can; the review list itself changes nothing
 *   K4  saving how a call went closes the call-back it answered; completing a
 *       call follow-up records the call once
 *   L1  a full location is saved, reloaded, filtered, searched and exported;
 *       a bad PIN or state is refused; existing city and state are kept
 *   L2  an import with District, Block and PIN columns fills them
 *   L3  location suggestions from notes wait for a person; nothing is filled
 *       by itself, and a filled field is never overwritten
 *   Q1  My Day groups count exactly what the Leads list shows; a retry due
 *       now is visible; a group with more than 50 leads pages through all
 *   R1  reminders at each chosen offset, once each, even with two senders
 *   R2  rescheduling, handing over, completing and cancelling replace or
 *       cancel what was planned; a time that passed is never sent late
 *   R3  Chat reminders only when allowed, only to the person's own linked Chat
 *   D1  the daily summary: off and in test mode by default; when live, each
 *       person gets only their own items, once a day; exceptions and preview
 *       permissions; a test goes only to the administrator
 *
 * Everything runs in a throwaway test schema with made-up people and leads.
 * Nothing is sent outside: Chat messages stop in the outbox table.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { processImports } from '../src/services/sales/imports.js';
import { sendDueReminders } from '../src/services/sales/followupReminders.js';
import { runFollowUpDigests } from '../src/services/sales/followupDigest.js';
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
const statusId = async (key) => (await query('SELECT id FROM crm_call_statuses WHERE key = $1', [key])).rows[0].id;
const leadRow = async (id) => (await query('SELECT * FROM crm_leads WHERE id = $1', [id])).rows[0];
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
let phoneSeq = 9700000000;
const newLead = async (overrides = {}, token = tokens.manager) => ok(await call('POST', '/sales/leads', {
  token,
  body: { category: 'B2B_CORPORATE', organization_name: `Sample Agro ${phoneSeq}`, phone: String(phoneSeq++), owner_user_id: ids.isha, ...overrides },
}), 201).lead;
const csvRows = (text) => text.replace(/^﻿/, '').trim().split(/\r?\n/).map((line) => {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
});
const exportCsv = async (params, token = tokens.manager) => {
  const res = await fetch(`${baseUrl}/api/taskflow/sales/exports/leads?${qs({ ...params, format: 'CSV' })}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const [header, ...rows] = csvRows(await res.text());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
};

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
  for (const [key, role, d] of [['admin', 'admin', 'TEL'], ['manager', 'manager', 'TEL'], ['isha', 'member', 'TEL'], ['ravi', 'member', 'TEL'], ['meera', 'member', 'TEL']]) {
    const email = `${key}.k@test.local`;
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, email, password, role, dept[d]],
    );
    ids[key] = rows[0].id;
    ids[`${key}_email`] = email;
  }
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'manager', 'isha', 'ravi', 'meera']) {
    tokens[key] = ok(await call('POST', '/auth/login', { body: { email: ids[`${key}_email`], password: 'Password123!' } })).token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- K1

test('K1: two rapid submissions make one call; two genuine calls stay two; a retry returns the first call', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const busy = await statusId('busy');
  const body = (requestId, note = 'Asked to call after lunch') => ({ status_id: busy, note, request_id: requestId });

  // a double tap: the same request twice at the same moment
  const [a, b] = await Promise.all([
    call('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: body('double-tap-0001') }),
    call('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: body('double-tap-0001') }),
  ]);
  ok(a); ok(b);
  assert.equal(a.body.call.id, b.body.call.id, 'both answers name the same call');
  assert.equal([a.body.duplicate, b.body.duplicate].filter(Boolean).length, 1, 'one of them is recognised as the repeat');
  let calls = (await query('SELECT id FROM crm_calls WHERE lead_id = $1', [lead.id])).rows;
  assert.equal(calls.length, 1);
  assert.equal((await leadRow(lead.id)).call_attempts, 1);

  // the answer was lost and the person pressed Save again: same id, same call
  const retry = ok(await call('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: body('double-tap-0001') }));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.call.id, a.body.call.id);
  assert.equal((await leadRow(lead.id)).call_attempts, 1);

  // two real calls, a minute apart in life, same words: two calls
  ok(await call('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: body('genuine-0002') }));
  ok(await call('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: body('genuine-0003') }));
  calls = (await query('SELECT id FROM crm_calls WHERE lead_id = $1 ORDER BY id', [lead.id])).rows;
  assert.equal(calls.length, 3);
  assert.equal((await leadRow(lead.id)).call_attempts, 3);

  // an older screen without request ids still saves (each press counts, as before)
  ok(await call('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: { status_id: busy, note: null } }));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_calls WHERE lead_id = $1', [lead.id])).rows[0].n, 4);

  // Log call (organizations, deals, or a lead from the old screen) is protected the same way
  const logged = await Promise.all([1, 2].map(() => call('POST', '/sales/calls', {
    token: tokens.isha, body: { lead_id: lead.id, direction: 'OUTBOUND', outcome: 'NO_ANSWER', notes: null, request_id: 'log-call-0004' },
  })));
  logged.forEach((r) => ok(r, r.status === 201 ? 201 : 200));
  assert.equal(new Set(logged.map((r) => r.body.call.id)).size, 1);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_calls WHERE lead_id = $1', [lead.id])).rows[0].n, 5);
  assert.equal((await leadRow(lead.id)).call_attempts, 5, 'a logged outbound call counts as an attempt too');

  // the same request id from another person is their own submission, not a repeat
  const other = await newLead({ owner_user_id: ids.ravi });
  const r1 = ok(await call('POST', `/sales/leads/${other.id}/call-status`, { token: tokens.ravi, body: body('double-tap-0001') }));
  assert.ok(!r1.duplicate);
  ids.k1Lead = lead.id;
});

// ---------------------------------------------------------------- K2

test('K2: correcting a note keeps the call and its count, records the change, and every list agrees by call id', async (t) => {
  if (skip(t)) return;
  const leadId = ids.k1Lead;
  const before = (await query('SELECT id, notes FROM crm_calls WHERE lead_id = $1 ORDER BY id', [leadId])).rows;
  const target = before[0];
  const edited = ok(await call('PATCH', `/sales/calls/${target.id}`, { token: tokens.isha, body: { notes: 'Asked to call after lunch; wants the kit price', reason: 'Added what they asked' } }));
  assert.equal(edited.call?.id ?? edited.id ?? target.id, target.id);
  const afterRows = (await query('SELECT id, notes, edit_count FROM crm_calls WHERE lead_id = $1 ORDER BY id', [leadId])).rows;
  assert.equal(afterRows.length, before.length, 'no new call');
  assert.equal(afterRows[0].notes, 'Asked to call after lunch; wants the kit price');
  assert.equal(afterRows[0].edit_count, 1);
  const edits = (await query('SELECT field, before, after, reason FROM crm_call_edits WHERE call_id = $1', [target.id])).rows;
  assert.deepEqual(edits.map((e) => [e.field, e.before, e.after, e.reason]), [['notes', 'Asked to call after lunch', 'Asked to call after lunch; wants the kit price', 'Added what they asked']]);
  assert.equal((await leadRow(leadId)).call_attempts, 5, 'the count did not move');

  // a teammate can see the call but cannot correct it
  ok(await call('PATCH', `/sales/calls/${target.id}`, { token: tokens.ravi, body: { notes: 'x' } }), 403);

  // the call detail shows its history
  const detail = ok(await call('GET', `/sales/calls/${target.id}`, { token: tokens.isha }));
  assert.equal(detail.edits.length, 1);

  // Calls list, timeline, lead detail and export agree by id
  const listIds = ok(await call('GET', `/sales/leads/${leadId}/calls`, { token: tokens.isha })).calls.map((c) => c.id).sort((x, y) => x - y);
  const timelineIds = (await query(`SELECT call_id FROM crm_lead_activities WHERE lead_id = $1 AND type = 'CALL' ORDER BY call_id`, [leadId])).rows.map((r) => r.call_id);
  const detailIds = ok(await call('GET', `/sales/leads/${leadId}`, { token: tokens.isha })).calls.map((c) => c.id).sort((x, y) => x - y);
  assert.deepEqual(listIds, afterRows.map((r) => r.id));
  assert.deepEqual(timelineIds, listIds, 'one timeline entry per call, no more');
  assert.deepEqual(detailIds, listIds);
  const timelineBody = (await query(`SELECT body, meta FROM crm_lead_activities WHERE call_id = $1`, [target.id])).rows[0];
  assert.equal(timelineBody.body, 'Asked to call after lunch; wants the kit price');
  const ref = (await leadRow(leadId)).ref;
  const exported = (await exportCsv({ view: 'all', q: ref })).find((r) => r.Ref === ref);
  assert.equal(Number(exported['Calls logged (by id)']), listIds.length);
  assert.equal(Number(exported['Last call id']), listIds[listIds.length - 1]);
  assert.equal(Number(exported['Attempts recorded before TaskFlow (imported, no call record)']), 0);
});

// ---------------------------------------------------------------- K3

test('K3: a reviewed accidental repeat is kept, uncounted and restorable; the review list changes nothing', async (t) => {
  if (skip(t)) return;
  const leadId = ids.k1Lead;
  const snapshot = async () => (await query('SELECT id, notes, voided_at, edit_count FROM crm_calls WHERE lead_id = $1 ORDER BY id', [leadId])).rows;
  const beforeReview = await snapshot();

  // members cannot see the review list; a manager can, and it changes nothing
  ok(await call('GET', `/sales/calls/review?lead_id=${leadId}`, { token: tokens.isha }), 403);
  const review = ok(await call('GET', `/sales/calls/review?lead_id=${leadId}`, { token: tokens.admin }));
  assert.equal(review.changed_nothing, true);
  assert.ok(review.groups.length >= 1, 'calls close together are listed');
  assert.ok(review.groups.every((g) => ['LIKELY_ACCIDENTAL', 'DIFFERENT_NOTES', 'NEEDS_A_PERSON'].includes(g.verdict)));
  assert.deepEqual(await snapshot(), beforeReview);

  const [, second] = beforeReview;
  ok(await call('POST', `/sales/calls/${second.id}/void`, { token: tokens.isha, body: { reason: 'Saved twice' } }), 403);
  ok(await call('POST', `/sales/calls/${second.id}/void`, { token: tokens.manager, body: { reason: 'Saved twice by a double tap' } }));
  const voided = (await snapshot()).find((c) => c.id === second.id);
  assert.ok(voided.voided_at, 'kept, marked');
  assert.equal((await snapshot()).length, beforeReview.length, 'nothing deleted');
  assert.equal((await leadRow(leadId)).call_attempts, 4);
  const listed = ok(await call('GET', `/sales/leads/${leadId}/calls`, { token: tokens.isha })).calls.find((c) => c.id === second.id);
  assert.equal(listed.counted, false, 'still listed, shown as not counted');
  const timeline = (await query(`SELECT meta FROM crm_lead_activities WHERE call_id = $1`, [second.id])).rows[0];
  assert.equal(timeline.meta.voided, true);

  ok(await call('POST', `/sales/calls/${second.id}/restore`, { token: tokens.manager, body: { reason: 'It was a real call after all' } }));
  assert.equal((await snapshot()).find((c) => c.id === second.id).voided_at, null);
  assert.equal((await leadRow(leadId)).call_attempts, 5);
  const history = (await query(`SELECT field, before, after FROM crm_call_edits WHERE call_id = $1 ORDER BY id`, [second.id])).rows;
  assert.deepEqual(history.map((h) => [h.field, h.before, h.after]), [['counted', 'yes', 'no'], ['counted', 'no', 'yes']]);
});

// ---------------------------------------------------------------- K4

test('K4: saving how a call went closes the call-back it answered; completing a call follow-up records the call once', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const fu = ok(await call('POST', '/sales/followups', {
    token: tokens.isha, body: { lead_id: lead.id, kind: 'CALLBACK', due_at: new Date(Date.now() + 5 * 60_000).toISOString(), title: 'Call back about the kit' },
  }), 201);
  const taskId = fu.task?.id ?? fu.id;
  const queueBefore = ok(await call('GET', '/sales/call-queue', { token: tokens.isha }));
  assert.equal(queueBefore.items[0].id, lead.id, 'the due call-back is first');
  const saved = ok(await call('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: { status_id: await statusId('interested'), note: 'Spoke; sending the price', request_id: 'callback-done-01' } }));
  assert.deepEqual(saved.closed_followups.map((f) => f.id), [taskId]);
  const task = (await query('SELECT completed_at, completion_call_id FROM tasks WHERE id = $1', [taskId])).rows[0];
  assert.ok(task.completed_at);
  assert.equal(task.completion_call_id, saved.call.id);
  const queueAfter = ok(await call('GET', '/sales/call-queue', { token: tokens.isha }));
  assert.ok(!queueAfter.items.some((i) => i.id === lead.id && i.queue_reason === 'CALLBACK'), 'the same lead does not come straight back');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_calls WHERE lead_id = $1', [lead.id])).rows[0].n, 1);

  // completing a Call follow-up with how the call went records exactly one call
  const fu2 = ok(await call('POST', '/sales/followups', { token: tokens.isha, body: { lead_id: lead.id, kind: 'CALL', due_at: new Date(Date.now() + 3600_000).toISOString() } }), 201);
  const t2 = fu2.task?.id ?? fu2.id;
  const done = await Promise.all([1, 2].map(() => call('POST', `/sales/followups/${t2}/complete`, { token: tokens.isha, body: { outcome: 'NO_ANSWER', notes: null, no_next_reason: 'Will retry from the queue' } })));
  done.forEach((r) => ok(r));
  const calls = (await query(`SELECT id, recorded_via FROM crm_calls WHERE lead_id = $1 ORDER BY id`, [lead.id])).rows;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].recorded_via, 'FOLLOWUP');
  assert.equal((await query('SELECT completion_call_id FROM tasks WHERE id = $1', [t2])).rows[0].completion_call_id, calls[1].id);

  // "Done" for something that was not a call records no call
  const fu3 = ok(await call('POST', '/sales/followups', { token: tokens.isha, body: { lead_id: lead.id, kind: 'CALL', due_at: new Date(Date.now() + 7200_000).toISOString() } }), 201);
  ok(await call('POST', `/sales/followups/${fu3.task?.id ?? fu3.id}/complete`, { token: tokens.isha, body: { outcome: 'DONE', notes: 'Sent the brochure on WhatsApp instead', no_next_reason: 'Waiting for them' } }));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_calls WHERE lead_id = $1', [lead.id])).rows[0].n, 2);
});

// ---------------------------------------------------------------- L1

test('L1: a full location is saved, reloaded, filtered, searched and exported; bad PIN or state is refused', async (t) => {
  if (skip(t)) return;
  const full = await newLead({
    organization_name: 'Sample Krishi Kendra', state: 'maharastra', district: 'nagpur', city: 'kalmeshwar', block: 'Kalmeshwar Tehsil',
    address_line1: 'Near the bus stand', address_line2: 'Ward 4', pincode: '441 501',
  });
  const reloaded = ok(await call('GET', `/sales/leads/${full.id}`, { token: tokens.isha })).lead;
  assert.deepEqual(
    ['state', 'district', 'city', 'block', 'address_line1', 'address_line2', 'pincode'].map((k) => reloaded[k]),
    ['Maharashtra', 'Nagpur', 'Kalmeshwar', 'Kalmeshwar Tehsil', 'Near the bus stand', 'Ward 4', '441501'],
  );
  const bare = await newLead({ organization_name: 'Sample Unknown Place' });
  const cityOnly = await newLead({ organization_name: 'Sample City Only', city: 'Indore', state: 'Madhya Pradesh' });

  // shape checks only: a PIN must be six digits, a state must be a state
  const badPin = await call('POST', '/sales/leads', { token: tokens.manager, body: { category: 'B2B_CORPORATE', organization_name: 'Sample Bad Pin', phone: String(phoneSeq++), pincode: '04411' } });
  assert.equal(badPin.status, 400);
  assert.equal(badPin.body.details?.code, 'BAD_PINCODE');
  assert.match(badPin.body.error, /six digits/);
  const badState = await call('POST', '/sales/leads', { token: tokens.manager, body: { category: 'B2B_CORPORATE', organization_name: 'Sample Bad State', phone: String(phoneSeq++), state: 'Atlantis' } });
  assert.equal(badState.status, 400);

  // editing changes only what was changed; blanking a field removes it; the city and state already there stay
  ok(await call('PATCH', `/sales/leads/${full.id}`, { token: tokens.isha, body: { district: 'Nagpur Rural', block: null } }));
  const edited = await leadRow(full.id);
  assert.equal(edited.district, 'Nagpur Rural');
  assert.equal(edited.block, null);
  assert.equal(edited.city, 'Kalmeshwar');
  assert.equal((await leadRow(cityOnly.id)).city, 'Indore');

  const list = async (params) => ok(await call('GET', `/sales/leads?${qs({ view: 'all', page_size: 100, ...params })}`, { token: tokens.manager })).leads.map((l) => l.id);
  assert.deepEqual(await list({ state: 'Maharashtra' }), [full.id]);
  assert.deepEqual(await list({ district: 'Nagpur Rural' }), [full.id]);
  assert.deepEqual(await list({ pincode: '4415' }), [full.id]);
  assert.ok((await list({ state: 'none' })).includes(bare.id));
  assert.ok(!(await list({ state: 'none' })).includes(full.id));
  assert.ok((await list({ district: 'none' })).includes(cityOnly.id));
  assert.deepEqual(await list({ q: '441501' }), [full.id]);
  assert.deepEqual(await list({ q: 'Kalmeshwar' }), [full.id]);
  const missing = ok(await call('GET', `/sales/leads?${qs({ view: 'location_missing', page_size: 200 })}`, { token: tokens.manager })).leads.map((l) => l.id);
  assert.ok(missing.includes(bare.id));
  assert.ok(!missing.includes(cityOnly.id));

  // districts already recorded for a state are offered
  const districts = ok(await call('GET', `/sales/location/districts?${qs({ state: 'Maharashtra', q: 'nag' })}`, { token: tokens.isha })).districts;
  assert.ok(districts.some((d) => d.name === 'Nagpur Rural'));

  const row = (await exportCsv({ view: 'all', state: 'Maharashtra' }))[0];
  assert.equal(row.State, 'Maharashtra');
  assert.equal(row.District, 'Nagpur Rural');
  assert.equal(row['City / town / village'], 'Kalmeshwar');
  assert.equal(row['Block / tehsil'], '');
  assert.equal(row.Address, 'Near the bus stand');
  assert.equal(row['PIN code'], '441501');
  assert.ok('Calling status' in row && 'Lead stage' in row && 'Next follow-up' in row && 'Latest note' in row);
});

// ---------------------------------------------------------------- L2

test('L2: an import with District, Block and PIN columns fills them; a malformed PIN is left out with a warning', async (t) => {
  if (skip(t)) return;
  const file = Buffer.from([
    'Organization,Phone,Category,State,District,City,Block,Address,Pincode',
    `Sample Import One,${phoneSeq++},B2B corporate,Rajasthan,Jaipur,Chomu,Govindgarh,Main road,303702`,
    `Sample Import Two,${phoneSeq++},B2B corporate,UP,Lucknow,Lucknow,,Hazratganj,22600`,
  ].join('\n'));
  const up = ok(await call('POST', '/sales/imports?entity=LEADS&filename=sample.csv', { token: tokens.manager, rawBody: file, contentType: 'text/csv' }), 201);
  assert.equal(up.job.mapping.district, 'District');
  assert.equal(up.job.mapping.block, 'Block');
  assert.equal(up.job.mapping.pincode, 'Pincode');
  ok(await call('POST', `/sales/imports/${up.job.id}/validate`, { token: tokens.manager, body: { mapping: up.job.mapping } }));
  ok(await call('POST', `/sales/imports/${up.job.id}/run`, { token: tokens.manager }), 202);
  await processImports(); await processImports();
  const one = (await query(`SELECT * FROM crm_leads WHERE organization_name = 'Sample Import One'`)).rows[0];
  assert.deepEqual([one.state, one.district, one.city, one.block, one.address_line1, one.pincode], ['Rajasthan', 'Jaipur', 'Chomu', 'Govindgarh', 'Main road', '303702']);
  const two = (await query(`SELECT * FROM crm_leads WHERE organization_name = 'Sample Import Two'`)).rows[0];
  assert.equal(two.state, 'Uttar Pradesh');
  assert.equal(two.pincode, null);
  const rows = (await query('SELECT warnings FROM crm_import_rows WHERE job_id = $1', [up.job.id])).rows;
  assert.ok(JSON.stringify(rows).includes('PIN code'), 'the bad PIN is reported');
});

// ---------------------------------------------------------------- L3

test('L3: suggestions from notes wait for a person, never fill a field by themselves, never overwrite', async (t) => {
  if (skip(t)) return;
  const lead = await newLead({ organization_name: 'Sample Note Lead' });
  ok(await call('POST', `/sales/leads/${lead.id}/activities`, { token: tokens.isha, body: { type: 'NOTE', subject: 'Note', body: 'Dealer from Madhya Pradesh, pin 452001, wants 10 kits' } }), 201);
  const two = await newLead({ organization_name: 'Sample Two States' });
  ok(await call('POST', `/sales/leads/${two.id}/activities`, { token: tokens.isha, body: { type: 'NOTE', subject: 'Note', body: 'Moving from Gujarat to Rajasthan next month' } }), 201);

  ok(await call('POST', '/sales/location-suggestions/generate', { token: tokens.isha }), 403);
  const generated = ok(await call('POST', '/sales/location-suggestions/generate', { token: tokens.admin }));
  assert.ok(generated.added.NOTE_STATE >= 1 && generated.added.NOTE_PINCODE >= 1);
  const untouched = await leadRow(lead.id);
  assert.equal(untouched.state, null, 'nothing filled by itself');
  assert.equal(untouched.pincode, null);
  const forTwo = ok(await call('GET', `/sales/leads/${two.id}/location-suggestions`, { token: tokens.isha })).suggestions;
  assert.equal(forTwo.filter((s) => s.field === 'state').length, 0, 'two states named: no guess');

  const mine = ok(await call('GET', `/sales/leads/${lead.id}/location-suggestions`, { token: tokens.isha })).suggestions;
  const state = mine.find((s) => s.field === 'state');
  const pin = mine.find((s) => s.field === 'pincode');
  assert.equal(state.value, 'Madhya Pradesh');
  assert.equal(pin.value, '452001');
  ok(await call('POST', `/sales/location-suggestions/${state.id}/accept`, { token: tokens.ravi }), 403);
  ok(await call('POST', `/sales/location-suggestions/${state.id}/accept`, { token: tokens.isha }));
  assert.equal((await leadRow(lead.id)).state, 'Madhya Pradesh');
  const logged = (await query(`SELECT subject, body FROM crm_lead_activities WHERE lead_id = $1 AND type = 'LOCATION'`, [lead.id])).rows[0];
  assert.match(logged.body, /confirmed by a person/);
  ok(await call('POST', `/sales/location-suggestions/${state.id}/accept`, { token: tokens.isha }), 409);

  // a PIN typed in by hand meanwhile is never overwritten by a suggestion
  ok(await call('PATCH', `/sales/leads/${lead.id}`, { token: tokens.isha, body: { pincode: '452010' } }));
  ok(await call('POST', `/sales/location-suggestions/${pin.id}/accept`, { token: tokens.isha }), 409);
  assert.equal((await leadRow(lead.id)).pincode, '452010');
  ok(await call('POST', `/sales/location-suggestions/${pin.id}/reject`, { token: tokens.isha }));
  const waiting = ok(await call('GET', '/sales/location-suggestions', { token: tokens.admin }));
  assert.ok(!waiting.suggestions.some((s) => s.lead_id === lead.id));
});

// ---------------------------------------------------------------- Q1

test('Q1: My Day groups count exactly what the Leads list shows, a retry due now is visible, and every lead pages through', async (t) => {
  if (skip(t)) return;
  const make = (n, extra = {}) => Promise.all(Array.from({ length: n }, (_, i) => newLead({ organization_name: `Sample Queue ${extra.tag || 'x'} ${i}`, owner_user_id: ids.meera, ...extra.body })));
  const fresh = [];
  for (let i = 0; i < 6; i += 1) fresh.push(...await make(10, { tag: `new${i}` }));
  const [retryDue, retryLater, worked, overdue, later] = await make(5, { tag: 'mix' });
  await query(`UPDATE crm_leads SET status = 'CONTACTED', call_attempts = 1, last_called_at = now() - interval '2 hours', retry_at = now() - interval '5 minutes' WHERE id = $1`, [retryDue.id]);
  await query(`UPDATE crm_leads SET status = 'CONTACTED', call_attempts = 1, last_called_at = now() - interval '2 hours', retry_at = now() + interval '3 hours' WHERE id = $1`, [retryLater.id]);
  await query(`UPDATE crm_leads SET status = 'CONTACTED', call_attempts = 2, last_called_at = now() - interval '1 day' WHERE id = $1`, [worked.id]);
  for (const [lead, minutes] of [[overdue, -90], [later, 2]]) {
    ok(await call('POST', '/sales/followups', { token: tokens.meera, body: { lead_id: lead.id, kind: 'CALL', due_at: new Date(Date.now() + 3600_000).toISOString(), reminder_offsets: [] } }), 201);
    await query(`UPDATE tasks SET due_date = now() + ($2 || ' minutes')::interval WHERE crm_lead_id = $1`, [lead.id, String(minutes)]);
    await query(`UPDATE crm_leads SET status = 'CONTACTED', call_attempts = 1, last_called_at = now() - interval '1 day' WHERE id = $1`, [lead.id]);
  }

  const queue = ok(await call('GET', '/sales/work-queue?page_size=25', { token: tokens.meera }));
  const count = Object.fromEntries(queue.groups.map((g) => [g.key, g.count]));
  assert.equal(count.retry, 1, 'a retry due now is in My Day');
  assert.equal(count.fu_overdue, 1);
  assert.equal(count.new_uncalled, 60);
  assert.equal(count.no_next_action, 1);
  assert.ok(!('unassigned' in count), 'unassigned is for people who assign');
  // each group's count is what the Leads list returns for the same filters
  for (const g of queue.groups) {
    const r = ok(await call('GET', `/sales/leads?${qs({ ...g.filters, page_size: 1 })}`, { token: tokens.meera }));
    assert.equal(r.total, g.count, `${g.key}: My Day says ${g.count}, the list says ${r.total}`);
  }
  // the Leads list keeps retries due now apart from those later
  const retryIds = ok(await call('GET', `/sales/leads?${qs({ view: 'retry', owner_id: ids.meera })}`, { token: tokens.meera })).leads.map((l) => l.id);
  assert.deepEqual(retryIds, [retryDue.id]);
  const laterIds = ok(await call('GET', `/sales/leads?${qs({ view: 'retry_later', owner_id: ids.meera })}`, { token: tokens.meera })).leads.map((l) => l.id);
  assert.deepEqual(laterIds, [retryLater.id]);
  // later today: only when "today" still has two minutes left in India
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  if (ist.getUTCHours() < 23 || ist.getUTCMinutes() < 55) assert.equal(count.fu_today, 1);

  // sixty new leads page through in threes of 25, each once
  const seen = [];
  for (let page = 1; page <= 3; page += 1) {
    const p = ok(await call('GET', `/sales/work-queue?${qs({ bucket: 'new_uncalled', page, page_size: 25 })}`, { token: tokens.meera }));
    assert.equal(p.total, 60);
    seen.push(...p.leads.map((l) => l.id));
  }
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen).size, 60);
  assert.deepEqual([...seen].sort((a, b) => a - b), fresh.map((l) => l.id).sort((a, b) => a - b));
  // each row carries what is needed to act on it
  const fuRow = ok(await call('GET', `/sales/work-queue?${qs({ bucket: 'fu_overdue' })}`, { token: tokens.meera })).leads[0];
  assert.equal(fuRow.id, overdue.id);
  assert.equal(fuRow.next_followup.kind, 'CALL');

  // someone else's queue needs team access
  ok(await call('GET', `/sales/work-queue?user_id=${ids.meera}`, { token: tokens.ravi }), 403);
  const forManager = ok(await call('GET', `/sales/work-queue?user_id=${ids.meera}`, { token: tokens.manager }));
  assert.equal(forManager.groups.find((g) => g.key === 'new_uncalled').count, 60);
  assert.ok(forManager.groups.some((g) => g.key === 'unassigned'));
});

// ---------------------------------------------------------------- R1

const MIN = 60_000;
const reminders = async (taskId) => (await query('SELECT * FROM crm_followup_reminders WHERE task_id = $1 ORDER BY offset_minutes DESC, channel, id', [taskId])).rows;
const followUp = async (body, token = tokens.isha) => {
  const r = ok(await call('POST', '/sales/followups', { token, body: { kind: 'CALL', ...body } }), 201);
  return r.task?.id ?? r.id;
};
const at = (ms) => new Date(Math.floor(ms / 1000) * 1000);

test('R1: each chosen reminder is sent once, at its time, with the lead, the time in IST and a link; two senders never double it', async (t) => {
  if (skip(t)) return;
  const lead = await newLead({ organization_name: 'Sample Reminder Farm' });
  const due = at(Date.now() + 2 * 3600_000);
  const taskId = await followUp({ lead_id: lead.id, due_at: due.toISOString(), title: 'Call about the soil kit', notes: 'Confirm the delivery address', reminder_offsets: [30, 15, 10, 5], reminder_channels: ['APP'] });
  const planned = await reminders(taskId);
  assert.deepEqual(planned.map((r) => [r.offset_minutes, r.channel, r.status]), [[30, 'APP', 'PENDING'], [15, 'APP', 'PENDING'], [10, 'APP', 'PENDING'], [5, 'APP', 'PENDING']]);
  planned.forEach((r) => assert.equal(new Date(r.remind_at).getTime(), due.getTime() - r.offset_minutes * MIN));

  const mine = async () => (await query(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'crm_reminder' AND task_id = $2 ORDER BY id`, [ids.isha, taskId])).rows;
  await sendDueReminders(new Date(due.getTime() - 31 * MIN));
  assert.equal((await mine()).length, 0, 'nothing early');
  await sendDueReminders(new Date(due.getTime() - 30 * MIN + 1000));
  await sendDueReminders(new Date(due.getTime() - 30 * MIN + 2000));
  let sent = await mine();
  assert.equal(sent.length, 1, 'the 30-minute reminder, once');
  assert.equal(sent[0].title, 'In 30 min: Call about the soil kit');
  assert.match(sent[0].body, /Sample Reminder Farm/);
  assert.match(sent[0].body, /IST/);
  assert.match(sent[0].body, /Confirm the delivery address/);

  // two workers at once (or a restart mid-run): each reminder still goes once
  await Promise.all([sendDueReminders(new Date(due.getTime() - 15 * MIN + 1000)), sendDueReminders(new Date(due.getTime() - 15 * MIN + 1000))]);
  assert.equal((await mine()).length, 2);
  await sendDueReminders(new Date(due.getTime() - 10 * MIN + 1000));
  await sendDueReminders(new Date(due.getTime() - 5 * MIN + 1000));
  sent = await mine();
  assert.deepEqual(sent.map((n) => n.title.split(':')[0]), ['In 30 min', 'In 15 min', 'In 10 min', 'In 5 min']);
  assert.ok((await reminders(taskId)).every((r) => r.status === 'SENT' && r.sent_at));

  // the older built-in reminder does not add a fifth
  await scanTimers(new Date(due.getTime() - 2 * MIN));
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE task_id = $1 AND title LIKE 'Coming up:%'`, [taskId])).rows[0].n, 0);

  // the person saw it
  const ack = ok(await call('POST', `/sales/followups/${taskId}/acknowledge`, { token: tokens.isha }));
  assert.equal(ack.acknowledged, 4);
  ok(await call('GET', `/sales/followups/${taskId}/reminders`, { token: tokens.isha }));
});

// ---------------------------------------------------------------- R2

test('R2: moving, handing over, finishing or cancelling a follow-up replaces or cancels its reminders; nothing is sent late', async (t) => {
  if (skip(t)) return;
  // defaults: 30 and 10 minutes before, in TaskFlow
  const prefs = ok(await call('PUT', '/sales/reminder-prefs', { token: tokens.isha, body: { offsets: [10, 30], channels: ['APP'] } }));
  assert.deepEqual(prefs.prefs.offsets, [30, 10]);
  ok(await call('PUT', '/sales/reminder-prefs', { token: tokens.isha, body: { offsets: [45], channels: ['APP'] } }), 400);

  const lead = await newLead({ organization_name: 'Sample Moving Farm' });
  const due = at(Date.now() + 3 * 3600_000);
  const taskId = await followUp({ lead_id: lead.id, due_at: due.toISOString() });
  assert.deepEqual((await reminders(taskId)).map((r) => [r.offset_minutes, r.status]), [[30, 'PENDING'], [10, 'PENDING']]);

  // rescheduled: the old times are cancelled, the new ones planned
  const moved = at(due.getTime() + 24 * 3600_000);
  ok(await call('POST', `/sales/followups/${taskId}/reschedule`, { token: tokens.isha, body: { due_at: moved.toISOString(), reason: 'They asked for tomorrow' } }));
  let rows = await reminders(taskId);
  assert.equal(rows.filter((r) => r.status === 'CANCELLED').length, 2);
  assert.ok(rows.filter((r) => r.status === 'PENDING').every((r) => new Date(r.due_at).getTime() === moved.getTime()));
  await sendDueReminders(new Date(due.getTime() - 10 * MIN + 1000));
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE task_id = $1`, [taskId])).rows[0].n, 0, 'nothing for the old time');

  // handed over: Isha's reminders stop; Ravi's own defaults apply
  ok(await call('POST', `/sales/followups/${taskId}/handoff`, { token: tokens.manager, body: { user_id: ids.ravi, reason: 'Ravi covers Nagpur this week' } }));
  rows = await reminders(taskId);
  assert.ok(rows.filter((r) => r.user_id === ids.isha).every((r) => r.status !== 'PENDING'));
  assert.deepEqual(rows.filter((r) => r.status === 'PENDING').map((r) => [r.user_id, r.offset_minutes]), [[ids.ravi, 15]]);

  // finished: nothing left to send
  ok(await call('POST', `/sales/followups/${taskId}/complete`, { token: tokens.ravi, body: { outcome: 'CONNECTED', notes: 'Spoke; order next week', no_next_reason: 'They will call back' } }));
  assert.ok((await reminders(taskId)).every((r) => r.status !== 'PENDING'));

  // cancelled because the lead was closed as lost
  const lost = (await query(`SELECT id FROM crm_call_statuses WHERE lifecycle = 'DISQUALIFIED' AND is_active ORDER BY position LIMIT 1`)).rows[0].id;
  const lead2 = await newLead({ organization_name: 'Sample Lost Farm' });
  const t2 = await followUp({ lead_id: lead2.id, due_at: at(Date.now() + 5 * 3600_000).toISOString() });
  ok(await call('POST', `/sales/leads/${lead2.id}/call-status`, { token: tokens.isha, body: { status_id: lost, lost_reason: 'No need', request_id: 'lost-lead-0001' } }));
  assert.ok((await reminders(t2)).every((r) => r.status === 'CANCELLED'));

  // set too close to remind 30, 15 or 10 minutes before: those are recorded as skipped, not sent late
  const soon = at(Date.now() + 7 * MIN);
  const lead2b = await newLead({ organization_name: 'Sample Soon Farm' });
  const t3 = await followUp({ lead_id: lead2b.id, due_at: soon.toISOString(), reminder_offsets: [30, 15, 10, 5] });
  assert.deepEqual((await reminders(t3)).map((r) => [r.offset_minutes, r.status]), [[30, 'SKIPPED'], [15, 'SKIPPED'], [10, 'SKIPPED'], [5, 'PENDING']]);
  // the worker was behind: of the reminders due together only the latest goes, with the minutes really left
  const lead5 = await newLead({ organization_name: 'Sample Catch-up Farm' });
  const due6 = at(Date.now() + 2 * 3600_000);
  const t6 = await followUp({ lead_id: lead5.id, due_at: due6.toISOString(), title: 'Confirm the visit', reminder_offsets: [30, 15, 10, 5] });
  await sendDueReminders(new Date(due6.getTime() - 4.5 * MIN));
  assert.deepEqual((await reminders(t6)).map((r) => [r.offset_minutes, r.status]), [[30, 'SKIPPED'], [15, 'SKIPPED'], [10, 'SKIPPED'], [5, 'SENT']]);
  const caught = (await query(`SELECT title FROM notifications WHERE task_id = $1`, [t6])).rows;
  assert.deepEqual(caught.map((n) => n.title), ['In 5 min: Confirm the visit']);

  // the server was down past the follow-up time: the reminder is skipped, the follow-up shows as overdue
  const lead3 = await newLead({ organization_name: 'Sample Downtime Farm' });
  const due4 = at(Date.now() + 40 * MIN);
  const t4 = await followUp({ lead_id: lead3.id, due_at: due4.toISOString(), reminder_offsets: [30] });
  await sendDueReminders(new Date(due4.getTime() + MIN));
  const [r4] = await reminders(t4);
  assert.equal(r4.status, 'SKIPPED');
  assert.match(r4.last_error, /had passed/);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE task_id = $1`, [t4])).rows[0].n, 0);

  // just after midnight: a 10-minute reminder falls the evening before, by the clock
  const lead4 = await newLead({ organization_name: 'Sample Midnight Farm' });
  const istMidnight = new Date(`${new Date(Date.now() + 2 * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10)}T00:05:00+05:30`);
  const t5 = await followUp({ lead_id: lead4.id, due_at: istMidnight.toISOString(), reminder_offsets: [10] });
  const [r5] = await reminders(t5);
  assert.equal(new Date(r5.remind_at).toISOString(), new Date(istMidnight.getTime() - 10 * MIN).toISOString());
});

// ---------------------------------------------------------------- R3

test('R3: Chat reminders only when allowed, only to the person’s own linked Chat, through the outbox once', async (t) => {
  if (skip(t)) return;
  const make = async (name) => {
    const lead = await newLead({ organization_name: name });
    const due = at(Date.now() + 2 * 3600_000);
    return { due, taskId: await followUp({ lead_id: lead.id, due_at: due.toISOString(), reminder_offsets: [30], reminder_channels: ['CHAT'] }) };
  };
  const off = await make('Sample Chat Off');
  await sendDueReminders(new Date(off.due.getTime() - 30 * MIN + 1000));
  let [r] = await reminders(off.taskId);
  assert.equal(r.status, 'SKIPPED');
  assert.match(r.last_error, /switched off/);

  ok(await call('PUT', '/sales/followup-digest/settings', { token: tokens.isha, body: { chatReminders: true } }), 403);
  ok(await call('PUT', '/sales/followup-digest/settings', { token: tokens.admin, body: { chatReminders: true } }));
  const unlinked = await make('Sample Chat Unlinked');
  await sendDueReminders(new Date(unlinked.due.getTime() - 30 * MIN + 1000));
  [r] = await reminders(unlinked.taskId);
  assert.equal(r.status, 'FAILED');
  assert.match(r.last_error, /Not linked/);

  // a Chat account that is not this person's login is not trusted
  await query(`INSERT INTO chat_spaces (space_name, kind, user_id, added_by_email, active) VALUES ('spaces/DM-SAMPLE-ISHA', 'DM', $1, 'someone.else@test.local', TRUE)`, [ids.isha]);
  const wrong = await make('Sample Chat Wrong Account');
  await sendDueReminders(new Date(wrong.due.getTime() - 30 * MIN + 1000));
  [r] = await reminders(wrong.taskId);
  assert.equal(r.status, 'FAILED');
  assert.match(r.last_error, /not their login/);

  await query(`UPDATE chat_spaces SET added_by_email = $1 WHERE space_name = 'spaces/DM-SAMPLE-ISHA'`, [ids.isha_email]);
  const good = await make('Sample Chat Linked');
  await sendDueReminders(new Date(good.due.getTime() - 30 * MIN + 1000));
  await sendDueReminders(new Date(good.due.getTime() - 30 * MIN + 2000));
  [r] = await reminders(good.taskId);
  assert.equal(r.status, 'SENT');
  const outbox = (await query(`SELECT space_name, kind, payload FROM chat_outbox WHERE dedupe_key = $1`, [`crm-reminder:${r.id}`])).rows;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].space_name, 'spaces/DM-SAMPLE-ISHA');
  assert.equal(outbox[0].kind, 'CRM_REMINDER');
  const text = (typeof outbox[0].payload === 'string' ? JSON.parse(outbox[0].payload) : outbox[0].payload).text;
  assert.match(text, /Sample Chat Linked/);
  assert.match(text, /\/sales\/leads\/\d+/);
  const status = ok(await call('GET', `/sales/followups/${good.taskId}/reminders`, { token: tokens.isha })).reminders[0];
  assert.equal(status.chat_status, 'PENDING', 'waiting in the outbox; delivery is reported from there');
});

// ---------------------------------------------------------------- D1

test('D1: the daily summary is off and in test mode by default; live, each person gets only their own items, once a day', async (t) => {
  if (skip(t)) return;
  assert.deepEqual(await runFollowUpDigests(new Date()), { skipped: 'off' });
  const settings = ok(await call('GET', '/sales/followup-digest/settings', { token: tokens.admin })).settings;
  assert.equal(settings.enabled, false);
  assert.equal(settings.testMode, true);

  const isha = await newLead({ organization_name: 'Sample Digest Isha' });
  const ravi = await newLead({ organization_name: 'Sample Digest Ravi', owner_user_id: ids.ravi });
  const ti = await followUp({ lead_id: isha.id, due_at: at(Date.now() + 3600_000).toISOString(), title: 'Send the price list', reminder_offsets: [] });
  const tr = await followUp({ lead_id: ravi.id, due_at: at(Date.now() + 3600_000).toISOString(), title: 'Visit the shop', reminder_offsets: [] }, tokens.ravi);
  await query(`UPDATE tasks SET due_date = now() - interval '2 hours' WHERE id = ANY($1::int[])`, [[ti, tr]]);

  ok(await call('PUT', '/sales/followup-digest/settings', { token: tokens.admin, body: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], skipHolidays: false, time: '00:00', lastSendTime: '23:59' } }));
  const digestOutbox = async () => (await query(`SELECT dedupe_key, space_name, user_id, payload FROM chat_outbox WHERE kind = 'CRM_DIGEST' ORDER BY id`)).rows;

  // test mode: who would get what is recorded; nothing is sent
  await runFollowUpDigests(new Date());
  assert.equal((await digestOutbox()).length, 0);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const log = ok(await call('GET', `/sales/followup-digest/log?date=${today}`, { token: tokens.admin })).log;
  assert.match(log.find((g) => g.user_id === ids.isha).reason, /Test mode/);
  assert.match(log.find((g) => g.user_id === ids.ravi).reason, /Not linked/);

  // live, on the next day: Isha's summary, with only her items, once
  ok(await call('PUT', '/sales/followup-digest/settings', { token: tokens.admin, body: { testMode: false } }));
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  await runFollowUpDigests(tomorrow);
  await runFollowUpDigests(new Date(tomorrow.getTime() + 60_000));
  const sent = await digestOutbox();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].user_id, ids.isha);
  assert.equal(sent[0].space_name, 'spaces/DM-SAMPLE-ISHA');
  const text = (typeof sent[0].payload === 'string' ? JSON.parse(sent[0].payload) : sent[0].payload).text;
  assert.match(text, /Sample Digest Isha/);
  assert.match(text, /Send the price list/);
  assert.doesNotMatch(text, /Sample Digest Ravi/);
  assert.match(text, /\/sales\/leads\//);
  assert.match(text, /Nothing is sent to customers/);

  // an administrator's exception
  ok(await call('PUT', `/sales/followup-digest/exceptions/${ids.isha}`, { token: tokens.isha, body: { mode: 'SKIP' } }), 403);
  ok(await call('PUT', `/sales/followup-digest/exceptions/${ids.isha}`, { token: tokens.admin, body: { mode: 'SKIP', reason: 'On a field visit' } }));
  const later = new Date(Date.now() + 48 * 3600_000);
  await runFollowUpDigests(later);
  assert.equal((await digestOutbox()).length, 1);
  const laterDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(later);
  assert.match(ok(await call('GET', `/sales/followup-digest/log?date=${laterDay}`, { token: tokens.admin })).log.find((g) => g.user_id === ids.isha).reason, /Skipped by an administrator/);

  // previews: your own, or anyone's with the settings permission
  assert.equal(ok(await call('GET', '/sales/followup-digest/preview', { token: tokens.isha })).user.id, ids.isha);
  ok(await call('GET', `/sales/followup-digest/preview?user_id=${ids.ravi}`, { token: tokens.isha }), 403);
  const ravisPreview = ok(await call('GET', `/sales/followup-digest/preview?user_id=${ids.ravi}`, { token: tokens.admin }));
  assert.ok(ravisPreview.items.some((i) => i.about === 'Sample Digest Ravi'));
  assert.ok(!ravisPreview.items.some((i) => i.about === 'Sample Digest Isha'));
  assert.equal(ravisPreview.would_send, false);

  // a test goes to the administrator's own Chat only
  ok(await call('POST', '/sales/followup-digest/test', { token: tokens.admin, body: { user_id: ids.ravi } }), 400);
  await query(`INSERT INTO chat_spaces (space_name, kind, user_id, added_by_email, active) VALUES ('spaces/DM-SAMPLE-ADMIN', 'DM', $1, $2, TRUE)`, [ids.admin, ids.admin_email]);
  ok(await call('POST', '/sales/followup-digest/test', { token: tokens.admin, body: { user_id: ids.ravi } }));
  const all = await digestOutbox();
  assert.equal(all.length, 2);
  assert.equal(all[1].space_name, 'spaces/DM-SAMPLE-ADMIN');
  assert.match((typeof all[1].payload === 'string' ? JSON.parse(all[1].payload) : all[1].payload).text, /^\*TEST/);
  assert.ok(!all.some((o) => o.space_name === null || o.user_id === ids.ravi), 'nothing went to Ravi');
});
