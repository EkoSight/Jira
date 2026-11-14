/**
 * Calling leads from company phones (docs/SIM_CALLING.md).
 *
 *   A  one record per call: a call started from TaskFlow is filled in by "How
 *      did the call go?" (or Log call), never added twice; a double tap is one
 *      call; an offline start keeps its time; older screens still work
 *   L  the length: the phone's call log, then the recording, then typed, then
 *      estimated; a person's correction is kept as corrected
 *   R  recordings: off until switched on (which needs the opening sentence and
 *      a published notice); "do not record"; types, size, a wrong file, the
 *      length measured here; who may play or download; audit; ranges;
 *      retention after six calendar months, except one kept for a dispute;
 *      provider rows untouched
 *   B  the Android app's side: device tokens, the policy first, salted numbers
 *      (in scope only, never an opted-out number), call-log entries attached or
 *      created once, numbers that are not leads refused and not stored,
 *      incoming and missed calls, a blocked phone, handing a phone over
 *   C  opt-outs from the outcome form and from complaints, enforced on every
 *      path; lifting needs a reason; the daily cap; calling hours; the privacy
 *      notice; the weekly review; importing a do-not-call list
 *
 * Made-up people and numbers in a throwaway schema; audio is generated here.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { getSettings, updateSetting } from '../src/services/settings.js';
import { closeStaleSessions } from '../src/services/sales/phoneCalls.js';
import { runRecordingRetention } from '../src/services/sales/callRecordings.js';
import { runWeeklyCallingReview, parseNumberList } from '../src/services/sales/callingCare.js';
import { daySalt, hashNumber } from '../src/services/sales/phoneDevices.js';
import { amrSeconds } from '../src/services/sales/audioLength.js';
import { localDate, normalizePhone } from '../src/services/sales/core.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

const api = async (method, p, { token, body, form = null, device = null, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (device) h.authorization = `Device ${device}`;
  if (body !== undefined && !form) h['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/taskflow${p}`, { method, headers: h, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
};
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const statusId = async (key) => (await query('SELECT id FROM crm_call_statuses WHERE key = $1', [key])).rows[0].id;
const leadRow = async (id) => (await query('SELECT * FROM crm_leads WHERE id = $1', [id])).rows[0];
const callRow = async (id) => (await query('SELECT * FROM crm_calls WHERE id = $1', [id])).rows[0];
let phoneSeq = 9811000000;
const nextPhone = () => String(phoneSeq++);
const newLead = async (overrides = {}) => ok(await api('POST', '/sales/leads', {
  token: tokens.manager,
  body: { category: 'B2B_CORPORATE', organization_name: `Sample Farms ${phoneSeq}`, phone: nextPhone(), owner_user_id: ids.isha, ...overrides },
}), 201).lead;
let reqSeq = 0;
const rid = (tag = 'r') => `${tag}-${Date.now().toString(36)}-${(reqSeq += 1)}`;
const start = (lead, token = tokens.isha, extra = {}) => api('POST', '/sales/calls/start', { token, body: { lead_id: lead.id, request_id: rid('start'), ...extra } });

/** A mono 8 kHz WAV of silence, `seconds` long. */
function wav(seconds) {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const fileForm = (buffer, name, fields = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
  f.append('file', new Blob([buffer]), name);
  return f;
};

async function setCalls(patch) {
  const all = await getSettings();
  const sales = all.crm?.sales || {};
  await updateSetting('crm', { ...all.crm, sales: { ...sales, calls: { ...(sales.calls || {}), ...patch } } }, ids.admin);
}

/** The privacy notice filled in and published, and recordings on, through the administrator's screens. */
async function recordingsOn() {
  ok(await api('PUT', '/sales/calling/setup', {
    token: tokens.admin,
    body: { companyName: 'Sample Agri', privacyNotice: { legalName: 'Sample Agri Private Limited', address: '1 Test Road, Test Town 110000', contactName: 'Asha Sample', contactPhone: '+91 99999 00000' } },
  }));
  ok(await api('POST', '/sales/calling/notice/publish', { token: tokens.admin }));
  ok(await api('PUT', '/sales/calling/setup', { token: tokens.admin, body: { deviceRecordings: true } }));
}

/** A phone signed in for a person, with the policy acknowledged. */
async function phone(userKey, installId) {
  const reg = ok(await api('POST', '/sales/calling/devices/register', {
    token: tokens[userKey], body: { install_id: installId, info: { maker: 'samsung', model: 'Test A1', android_version: '14', app_version: '1.0.0', dialler_package: 'com.samsung.android.dialer' } },
  }), 201);
  const pol = ok(await api('GET', '/sales/calling/policy', { token: tokens[userKey] }));
  if (!pol.policy.acknowledged) ok(await api('POST', '/device/policy/ack', { device: reg.token, body: { version: pol.policy.version } }));
  return reg;
}

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('TEL', 'Tele-sales', '#2a78d6', 1)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do','to-do','todo','#3b82f6',1,TRUE), ('Done','done','done','#22c55e',2,FALSE), ('Cancelled','cancelled','cancelled','#94a3b8',3,FALSE)`);
  const dept = (await query('SELECT id FROM departments')).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, role] of [['admin', 'admin'], ['manager', 'manager'], ['isha', 'member'], ['ravi', 'member']]) {
    const email = `${key}.sim@test.local`;
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, email, password, role, dept],
    );
    ids[key] = rows[0].id;
    ids[`${key}_email`] = email;
  }
  // calls may go out at any hour while testing; the hours test narrows this itself
  await setCalls({ callingHours: { start: '00:00', end: '24:00', workingDaysOnly: false } });
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'manager', 'isha', 'ravi']) {
    tokens[key] = ok(await api('POST', '/auth/login', { body: { email: ids[`${key}_email`], password: 'Password123!' } })).token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- A: one record per call

test('A: a started call is filled in by "How did the call go?": one row, one attempt, on the timeline once; a double tap is one call', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const id = rid('tap');
  const [a, b] = await Promise.all([
    api('POST', '/sales/calls/start', { token: tokens.isha, body: { lead_id: lead.id, request_id: id } }),
    api('POST', '/sales/calls/start', { token: tokens.isha, body: { lead_id: lead.id, request_id: id } }),
  ]);
  ok(a, 201); ok(b, 201);
  assert.equal(a.body.call.id, b.body.call.id, 'a double tap is one call');
  const session = await callRow(a.body.call.id);
  assert.equal(session.status, 'DIALLED');
  assert.equal(session.provider, 'device');
  assert.equal((await leadRow(lead.id)).call_attempts, 0, 'dialling alone is not yet an attempt');

  const pending = ok(await api('GET', '/sales/calls/pending', { token: tokens.isha }));
  assert.ok(pending.calls.some((c) => c.id === session.id), 'it waits for "say how it went"');

  const saved = ok(await api('POST', `/sales/leads/${lead.id}/call-status`, {
    token: tokens.isha, body: { status_id: await statusId('interested'), note: 'Wants a soil kit demo', call_id: session.id, duration_sec: 240, duration_source: 'ESTIMATED', request_id: rid('out') },
  }));
  assert.equal(saved.call.id, session.id, 'the outcome is saved onto the started call');
  const rows = (await query('SELECT * FROM crm_calls WHERE lead_id = $1', [lead.id])).rows;
  assert.equal(rows.length, 1, 'one call, not two');
  assert.equal(rows[0].outcome, 'CONNECTED');
  assert.equal(rows[0].talk_sec, 240);
  assert.equal(rows[0].duration_source, 'ESTIMATED');
  assert.equal((await leadRow(lead.id)).call_attempts, 1, 'one attempt');
  const timeline = (await query('SELECT * FROM crm_lead_activities WHERE lead_id = $1 AND call_id = $2', [lead.id, session.id])).rows;
  assert.equal(timeline.length, 1, 'on the timeline once');
  assert.ok(!ok(await api('GET', '/sales/calls/pending', { token: tokens.isha })).calls.some((c) => c.id === session.id));

  // describing it a second time is refused; corrections go through the call
  const again = await api('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: { status_id: await statusId('interested'), note: 'again', call_id: session.id, request_id: rid('again') } });
  assert.equal(again.status, 409);
  assert.equal(again.body.details?.code, 'ALREADY_DESCRIBED');
});

test('A: an offline start keeps its time; a form saved without the call id still fills in the open call; older screens still add a call', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const dialled = new Date(Date.now() - 40 * 60_000).toISOString();
  const s = ok(await start(lead, tokens.isha, { dialled_at: dialled }), 201);
  assert.equal(new Date((await callRow(s.call.id)).dialled_at).toISOString(), dialled, 'the time it was dialled, not the time it arrived');
  assert.equal((await api('POST', '/sales/calls/start', { token: tokens.isha, body: { lead_id: lead.id, request_id: rid('old'), dialled_at: new Date(Date.now() - 20 * 3600_000).toISOString() } })).status, 400);

  // the form without the call id (an older page) fills in the open call rather than adding one
  const saved = ok(await api('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: { status_id: await statusId('busy'), request_id: rid('nocall') } }));
  assert.equal(saved.call.id, s.call.id);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_calls WHERE lead_id = $1', [lead.id])).rows[0].n, 1);

  // with no started call, the form records a call as it always has
  const typed = ok(await api('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: { status_id: await statusId('busy'), request_id: rid('typed') } }));
  assert.notEqual(typed.call.id, s.call.id);
  assert.equal((await callRow(typed.call.id)).recorded_via, 'OUTCOME_FORM');
  assert.equal((await leadRow(lead.id)).call_attempts, 2);

  // Log call on an organization fills in the call started on it
  const acct = (await query(`INSERT INTO accounts (name, owner_user_id) VALUES ('Sample Cooperative', $1) RETURNING id`, [ids.isha])).rows[0].id;
  const contact = (await query(`INSERT INTO account_contacts (account_id, full_name, phone, phone_normalized) VALUES ($1, 'Kiran Sample', $2, $3) RETURNING id`, [acct, '9822000001', '919822000001'])).rows[0].id;
  const s2 = ok(await api('POST', '/sales/calls/start', { token: tokens.isha, body: { account_id: acct, contact_id: contact, request_id: rid('acct') } }), 201);
  const logged = ok(await api('POST', '/sales/calls', { token: tokens.isha, body: { account_id: acct, outcome: 'CONNECTED', notes: 'Spoke about the season', call_id: s2.call.id, duration_sec: 90, request_id: rid('log') } }), 201);
  assert.equal(logged.call.id, s2.call.id);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_calls WHERE account_id = $1', [acct])).rows[0].n, 1);
});

test('A: a started call nobody described closes at the end of the day as "outcome not given", without counting an attempt', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const s = ok(await start(lead), 201);
  await query(`UPDATE crm_calls SET dialled_at = now() - interval '2 days', started_at = now() - interval '2 days' WHERE id = $1`, [s.call.id]);
  assert.ok(await closeStaleSessions(new Date()) >= 1);
  const c = await callRow(s.call.id);
  assert.ok(c.session_closed_at);
  assert.equal(c.outcome, 'NOT_GIVEN');
  assert.equal((await leadRow(lead.id)).call_attempts, 0, 'not counted: nobody said it rang, and the phone did not report it');
  assert.ok(!ok(await api('GET', '/sales/calls/pending', { token: tokens.isha })).calls.some((x) => x.id === s.call.id));
});

// ---------------------------------------------------------------- C: rules before a call

test('C: an opted-out number, the daily limit and calling hours are checked before every call', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  // the daily limit: three attempts, then only a callback the lead asked for
  for (let i = 0; i < 3; i += 1) ok(await start(lead), 201);
  const fourth = await start(lead);
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.details.code, 'DAILY_CAP');
  const queue = ok(await api('GET', '/sales/call-queue', { token: tokens.isha }));
  assert.ok(!queue.items.some((i) => i.id === lead.id), 'the call list leaves it out for today');
  const fu = ok(await api('POST', '/sales/followups', { token: tokens.isha, body: { lead_id: lead.id, kind: 'CALLBACK', due_at: new Date(Date.now() + 10 * 60_000).toISOString() } }), 201);
  void fu;
  const asked = ok(await start(lead), 201);
  assert.equal(asked.callback_reason, 'ASKED_CALLBACK');

  // calling hours: outside them a call needs a reason
  const other = await newLead();
  const nowIst = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const hh = Number(nowIst.slice(0, 2));
  const closed = { start: `${String((hh + 2) % 24).padStart(2, '0')}:00`, end: `${String((hh + 3) % 24).padStart(2, '0')}:00`, workingDaysOnly: false };
  await setCalls({ callingHours: closed });
  try {
    const refused = await start(other);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.details.code, 'OUTSIDE_HOURS');
    const why = ok(await start(other, tokens.isha, { override_reason: 'They asked for an evening call on WhatsApp' }), 201);
    assert.equal(why.hours_override_reason, 'They asked for an evening call on WhatsApp');
  } finally {
    await setCalls({ callingHours: { start: '00:00', end: '24:00', workingDaysOnly: false } });
  }

  // an opted-out number is refused on every path
  const quiet = await newLead();
  ok(await api('POST', '/sales/optouts', { token: tokens.isha, body: { channel: 'CALL', address: quiet.phone } }), 201);
  const refused = await start(quiet);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.code, 'OPTED_OUT');
});

test('C: "Asked not to be called again" opts the number out and stops retries, call-backs and the call list; "and no WhatsApp or SMS" too', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  ok(await api('POST', '/sales/followups', { token: tokens.isha, body: { lead_id: lead.id, kind: 'CALL', due_at: new Date(Date.now() + 3600_000).toISOString() } }), 201);
  const s = ok(await start(lead), 201);
  const saved = ok(await api('POST', `/sales/leads/${lead.id}/call-status`, {
    token: tokens.isha, body: { status_id: await statusId('not-interested').catch(() => null) || await statusId('busy'), note: 'Please stop calling', call_id: s.call.id, opt_out: { calls: true, messages: true }, request_id: rid('stop') },
  }));
  assert.ok(saved.opted_out);
  const out = (await query(`SELECT * FROM crm_optouts WHERE address = $1 AND lifted_at IS NULL ORDER BY channel`, [normalizePhone(lead.phone)])).rows;
  assert.deepEqual(out.map((o) => o.channel), ['CALL', 'SMS', 'WHATSAPP']);
  const callOut = out.find((o) => o.channel === 'CALL');
  assert.equal(callOut.source, 'CALL_OUTCOME');
  assert.equal(callOut.call_id, s.call.id);
  const l = await leadRow(lead.id);
  assert.equal(l.retry_at, null, 'no retry');
  const open = (await query(`SELECT COUNT(*)::int AS n FROM tasks WHERE crm_lead_id = $1 AND followup_kind IN ('CALL','CALLBACK') AND completed_at IS NULL AND crm_cancel_reason IS NULL`, [lead.id])).rows[0].n;
  assert.equal(open, 0, 'call follow-ups cancelled');
  assert.equal((await start(lead)).status, 409);
  const myDay = ok(await api('GET', '/sales/leads', { token: tokens.isha, body: undefined, headers: {} }).then(() => api('GET', `/sales/leads?view=retry&owner_id=${ids.isha}`, { token: tokens.isha })));
  assert.ok(!myDay.leads.some((x) => x.id === lead.id));

  // lifting needs a reason, and is recorded
  assert.equal((await api('POST', '/sales/calling/optouts/lift', { token: tokens.admin, body: { address: lead.phone, reason: '' } })).status, 400);
  ok(await api('POST', '/sales/calling/optouts/lift', { token: tokens.admin, body: { address: lead.phone, reason: 'The customer asked us to call them back' } }));
  const audit = (await query(`SELECT * FROM crm_audit_events WHERE action = 'CALL_OPT_OUT_LIFTED' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(audit.summary, 'The customer asked us to call them back');
  assert.equal((await api('POST', '/sales/calling/optouts/lift', { token: tokens.isha, body: { address: lead.phone, reason: 'x x x' } })).status, 403, 'members cannot lift');
});

test('C: a complaint opts the number out and tells administrators; three in ten days raise one warning', async (t) => {
  if (skip(t)) return;
  const leads = [await newLead(), await newLead(), await newLead()];
  const before = (await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'crm_calling'`, [ids.admin])).rows[0].n;
  for (const lead of leads) {
    ok(await api('POST', '/sales/calls/complaint', { token: tokens.isha, body: { lead_id: lead.id, what_they_said: 'Said they never enquired and asked us to stop' } }), 201);
    const o = (await query(`SELECT * FROM crm_optouts WHERE channel = 'CALL' AND address = $1 AND lifted_at IS NULL`, [normalizePhone(lead.phone)])).rows[0];
    assert.equal(o.complaint, true);
    assert.equal(o.source, 'COMPLAINT');
  }
  const notes = (await query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'crm_calling' ORDER BY id`, [ids.admin])).rows.slice(before);
  assert.equal(notes.filter((n) => /^Complaint from/.test(n.title)).length, 3);
  assert.equal(notes.filter((n) => /call complaints in the last 10 days/.test(n.title)).length, 1, 'one warning, not one per complaint');
  ok(await api('POST', '/sales/calls/complaint', { token: tokens.isha, body: { lead_id: (await newLead()).id, what_they_said: 'Asked to stop' } }), 201);
  const after = (await query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'crm_calling' AND title ~ 'complaints in the last 10 days'`, [ids.admin])).rows;
  assert.equal(after.length, 1, 'still one warning today');
  const list = ok(await api('GET', '/sales/calling/optouts', { token: tokens.admin }));
  assert.ok(list.complaints.length >= 4);
  assert.ok(list.complaints_10_days >= 4);
});

test('C: a do-not-call list is previewed, then applied exactly as previewed', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const text = `phone\n${lead.phone}\n+91 98330 00001\n98330 00001\nnot a number\n09833000002`;
  const parsed = parseNumberList(text);
  assert.equal(parsed.numbers.length, 3);
  assert.equal(parsed.duplicates, 1);
  const preview = ok(await api('POST', '/sales/calling/optouts/import/preview', { token: tokens.admin, body: { text } }));
  assert.equal(preview.new_numbers, 3);
  assert.equal(preview.invalid_count, 1);
  assert.equal(preview.leads_matched, 1);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_optouts WHERE source = 'IMPORT'`)).rows[0].n, 0, 'the preview changes nothing');
  assert.equal((await api('POST', '/sales/calling/optouts/import/apply', { token: tokens.admin, body: { text: `${text}\n9833000009`, fingerprint: preview.fingerprint } })).status, 409, 'a changed list is refused');
  const applied = ok(await api('POST', '/sales/calling/optouts/import/apply', { token: tokens.admin, body: { text, fingerprint: preview.fingerprint } }));
  assert.equal(applied.added, 3);
  assert.equal((await start(lead)).status, 409);
});

// ---------------------------------------------------------------- R: recordings

test('R: recordings stay off until switched on, which needs the opening sentence and a published privacy notice', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const s = ok(await start(lead), 201);
  const off = await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(5), 'call.wav') });
  assert.equal(off.status, 409);
  assert.equal(off.body.details.code, 'RECORDINGS_OFF');

  const blocked = await api('PUT', '/sales/calling/setup', { token: tokens.admin, body: { deviceRecordings: true } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.details.code, 'RECORDING_BLOCKED');
  assert.ok(blocked.body.details.blockers.some((b) => /published privacy notice/.test(b)));

  // the public page is not there until published
  assert.equal((await fetch(`${baseUrl}/api/taskflow/s/privacy`)).status, 404);
  assert.equal((await api('POST', '/sales/calling/notice/publish', { token: tokens.admin })).status, 409, 'not without the company details');
  await recordingsOn();
  const page = await (await fetch(`${baseUrl}/api/taskflow/s/privacy`)).text();
  assert.match(page, /Sample Agri Private Limited/);
  assert.match(page, /6 months/);
  const hindi = await (await fetch(`${baseUrl}/api/taskflow/s/privacy?lang=hi`)).text();
  assert.match(hindi, /रिकॉर्डिंग/);
  // a change is a draft: leads keep seeing the published words until it is published again
  const draft = ok(await api('PUT', '/sales/calling/setup', { token: tokens.admin, body: { privacyNotice: { address: '2 Test Road, Test Town 110000' } } }));
  assert.equal(draft.notice_draft_changed, true);
  assert.match(await (await fetch(`${baseUrl}/api/taskflow/s/privacy`)).text(), /1 Test Road/);
  assert.match(ok(await api('GET', '/sales/calling/notice/preview', { token: tokens.admin })).en, /2 Test Road/);
  ok(await api('POST', '/sales/calling/notice/publish', { token: tokens.admin }));
  assert.match(await (await fetch(`${baseUrl}/api/taskflow/s/privacy`)).text(), /2 Test Road/);
  // the hosted form carries the line and the link
  await query(`INSERT INTO crm_capture_forms (public_id, name, title) VALUES ('sample-form', 'Sample', 'Ask us')`);
  const formPage = await (await fetch(`${baseUrl}/api/taskflow/s/f/sample-form`)).text();
  assert.match(formPage, /Calls may be recorded/);
  assert.match(formPage, /href="\.\.\/privacy"/);
  // members cannot change calling settings
  assert.equal((await api('PUT', '/sales/calling/setup', { token: tokens.manager, body: { deviceRecordings: false } })).status, 403);
});

test('R: a recording is checked, measured here, kept privately, played through a short link with ranges, and audited', async (t) => {
  if (skip(t)) return;
  await recordingsOn();
  const lead = await newLead();
  const s = ok(await start(lead), 201);
  // not audio, too long for the call, too large
  assert.equal((await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(Buffer.from('hello'), 'notes.txt') })).body.details.code, 'TYPE');
  assert.equal((await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(Buffer.from('not really audio at all'), 'call.m4a') })).body.details.code, 'UNREADABLE');
  const tooLong = await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(600), 'call.wav') });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.details.code, 'WRONG_FILE');
  await setCalls({ maxRecordingMb: 1 });
  assert.equal((await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(70), 'call.wav') })).body.details.code, 'TOO_LARGE');
  await setCalls({ maxRecordingMb: 50 });
  // someone else's call
  assert.equal((await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.ravi, form: fileForm(wav(5), 'call.wav') })).status, 403);

  const added = ok(await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(7), 'Call 98110.wav', { source: 'SHARED' }) }), 201);
  assert.equal(added.recording.length_sec, 7, 'measured from the file');
  assert.equal(added.recording.source, 'SHARED');
  const c = await callRow(s.call.id);
  assert.equal(c.talk_sec, 7);
  assert.equal(c.duration_source, 'RECORDING');
  const stored = (await query('SELECT * FROM crm_call_recordings WHERE call_id = $1', [s.call.id])).rows[0];
  assert.ok(stored.storage_path.startsWith('call-recordings'));
  assert.ok(fs.existsSync(path.join(config.uploads.dir, stored.storage_path)));
  // the same file again is not a second recording
  const again = ok(await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(7), 'call.wav') }));
  assert.equal(again.duplicate, true);

  // who may play: the caller, or someone with the recordings permission; download needs the permission
  assert.equal((await api('POST', `/sales/calls/${s.call.id}/recording/link`, { token: tokens.ravi, body: {} })).status, 403);
  assert.equal((await api('POST', `/sales/calls/${s.call.id}/recording/link`, { token: tokens.isha, body: { download: true } })).status, 403);
  const link = ok(await api('POST', `/sales/calls/${s.call.id}/recording/link`, { token: tokens.isha, body: {} }));
  const full = await fetch(`${baseUrl}${link.url}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('cache-control'), 'no-store, private');
  const range = await fetch(`${baseUrl}${link.url}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(range.status, 206, 'ranges are served for seeking');
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  const dl = ok(await api('POST', `/sales/calls/${s.call.id}/recording/link`, { token: tokens.manager, body: { download: true } }));
  assert.match((await fetch(`${baseUrl}${dl.url}`)).headers.get('content-disposition'), /attachment/);
  const audits = (await query(`SELECT action FROM crm_audit_events WHERE entity_type = 'CALL' AND entity_id = $1 ORDER BY id`, [s.call.id])).rows.map((r) => r.action);
  assert.ok(audits.includes('CALL_RECORDING_ADDED'));
  assert.ok(audits.includes('CALL_RECORDING_PLAYED'));
  assert.ok(audits.includes('CALL_RECORDING_DOWNLOADED'));
  assert.equal((await fetch(`${baseUrl}/api/taskflow/s/recordings/not-a-token`)).status, 404);

  // the calls list says there is a recording, and of which kind
  const listed = ok(await api('GET', '/sales/calls?mine=1', { token: tokens.isha })).calls.find((x) => x.id === s.call.id);
  assert.equal(listed.has_recording, true);
  assert.equal(listed.recording_kind, 'STORED');
});

test('R: "They don\'t want this recorded" deletes the kept recording and refuses later ones for that lead', async (t) => {
  if (skip(t)) return;
  await recordingsOn();
  const lead = await newLead();
  const s = ok(await start(lead), 201);
  ok(await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(4), 'call.wav') }), 201);
  const stored = (await query('SELECT * FROM crm_call_recordings WHERE call_id = $1', [s.call.id])).rows[0];
  const r = ok(await api('POST', `/sales/calls/${s.call.id}/no-recording`, { token: tokens.isha, body: {} }));
  assert.equal(r.recording_deleted, true);
  assert.equal((await leadRow(lead.id)).do_not_record, true);
  assert.ok(!fs.existsSync(path.join(config.uploads.dir, stored.storage_path)), 'the file is gone');
  assert.equal((await query('SELECT delete_reason FROM crm_call_recordings WHERE id = $1', [stored.id])).rows[0].delete_reason, 'ASKED_NOT_TO_BE_RECORDED');
  const s2 = ok(await start(lead), 201);
  assert.equal(s2.recording.objected, true);
  const refused = await api('POST', `/sales/calls/${s2.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(4), 'call.wav') });
  assert.equal(refused.body.details.code, 'DO_NOT_RECORD');
});

test('R: recordings go after six calendar months; one kept for a dispute stays; provider rows are untouched', async (t) => {
  if (skip(t)) return;
  await recordingsOn();
  const old = await newLead();
  const held = await newLead();
  const recent = await newLead();
  const add = async (lead) => {
    const s = ok(await start(lead), 201);
    ok(await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(3), 'call.wav') }), 201);
    return s.call.id;
  };
  const [a, b, c] = [await add(old), await add(held), await add(recent)];
  await query(`UPDATE crm_calls SET started_at = now() - interval '6 months 2 days', dialled_at = now() - interval '6 months 2 days' WHERE id = ANY($1::int[])`, [[a, b]]);
  await query(`UPDATE crm_calls SET started_at = now() - interval '5 months 25 days' WHERE id = $1`, [c]);
  assert.equal((await api('POST', `/sales/calls/${b}/recording/hold`, { token: tokens.manager, body: { reason: 'Complaint under review' } })).status, 403, 'administrators only');
  ok(await api('POST', `/sales/calls/${b}/recording/hold`, { token: tokens.admin, body: { reason: 'Complaint under review' } }));
  // a provider recording link from before is not touched by this rule
  const provider = (await query(`INSERT INTO crm_calls (provider, direction, status, recording_ref, started_at, created_at) VALUES ('exotel', 'OUTBOUND', 'COMPLETED', 'https://example.test/rec.mp3', now() - interval '8 months', now() - interval '8 months') RETURNING id`)).rows[0].id;
  const fileA = (await query('SELECT storage_path FROM crm_call_recordings WHERE call_id = $1', [a])).rows[0].storage_path;
  const deleted = await runRecordingRetention(new Date());
  assert.ok(deleted >= 1);
  const state = Object.fromEntries((await query('SELECT call_id, deleted_at, delete_reason FROM crm_call_recordings WHERE call_id = ANY($1::int[])', [[a, b, c]])).rows.map((r) => [r.call_id, r]));
  assert.equal(state[a].delete_reason, 'RETENTION');
  assert.equal(state[b].deleted_at, null, 'kept for the dispute');
  assert.equal(state[c].deleted_at, null, 'not six months yet');
  assert.ok(!fs.existsSync(path.join(config.uploads.dir, fileA)));
  assert.ok(await callRow(a), 'the call itself stays');
  assert.equal((await callRow(provider)).recording_ref, 'https://example.test/rec.mp3');
});

// ---------------------------------------------------------------- L: the length

test('L: the best length wins (call log > recording > typed > estimated) and a correction is kept as corrected', async (t) => {
  if (skip(t)) return;
  await recordingsOn();
  const lead = await newLead();
  const s = ok(await start(lead), 201);
  ok(await api('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: { status_id: await statusId('interested'), note: 'Kit price', call_id: s.call.id, duration_sec: 300, duration_source: 'TYPED', request_id: rid('len') } }));
  assert.deepEqual([(await callRow(s.call.id)).talk_sec, (await callRow(s.call.id)).duration_source], [300, 'TYPED']);
  ok(await api('POST', `/sales/calls/${s.call.id}/recording`, { token: tokens.isha, form: fileForm(wav(9), 'call.wav') }), 201);
  assert.deepEqual([(await callRow(s.call.id)).talk_sec, (await callRow(s.call.id)).duration_source], [9, 'RECORDING']);
  const dev = await phone('isha', 'len-phone-0001');
  ok(await api('POST', '/device/call-log', { device: dev.token, body: { entries: [{ log_id: 'L1', number: lead.phone, type: 'OUTGOING', started_at: new Date().toISOString(), duration_sec: 11, call_id: s.call.id }] } }));
  assert.deepEqual([(await callRow(s.call.id)).talk_sec, (await callRow(s.call.id)).duration_source], [11, 'DEVICE_LOG']);
  ok(await api('PATCH', `/sales/calls/${s.call.id}`, { token: tokens.isha, body: { duration_sec: 12, reason: 'Counted from my notes' } }));
  const c = await callRow(s.call.id);
  assert.deepEqual([c.talk_sec, c.duration_source], [12, 'CORRECTED']);
  const edits = (await query(`SELECT field, before, after FROM crm_call_edits WHERE call_id = $1`, [s.call.id])).rows;
  assert.deepEqual(edits.map((e) => [e.field, e.before, e.after]), [['duration_sec', '11', '12']]);
  const listed = ok(await api('GET', '/sales/calls?mine=1', { token: tokens.isha })).calls.find((x) => x.id === s.call.id);
  assert.equal(listed.duration_source, 'CORRECTED', 'the list says where the length came from');
});

// ---------------------------------------------------------------- B: the Android app's side

test('B: a phone signs in, accepts the policy first, and gets only its numbers, salted, never an opted-out one', async (t) => {
  if (skip(t)) return;
  const mine = await newLead();
  const stopped = await newLead();
  ok(await api('POST', '/sales/optouts', { token: tokens.isha, body: { channel: 'CALL', address: stopped.phone } }), 201);
  // Ravi has not used a phone yet, so has not accepted the policy
  const reg = ok(await api('POST', '/sales/calling/devices/register', { token: tokens.ravi, body: { install_id: 'policy-phone-01', info: { maker: 'OPPO', dialler_package: 'com.example.unknown.dialer' } } }), 201);
  assert.ok(reg.token.length > 30);
  assert.equal((await api('GET', '/device/config')).status, 401, 'no token, nothing');
  assert.equal((await api('GET', '/sales/calls/pending', { device: reg.token })).status, 401, 'a device token reaches nothing else');
  const cfg = ok(await api('GET', '/device/config', { device: reg.token }));
  assert.equal(cfg.recording_mode.mode, 'UNKNOWN', 'an unknown dialler is not confirmed');
  // nothing is accepted before the policy is acknowledged; a new policy version asks again
  const early = await api('POST', '/device/call-log', { device: reg.token, body: { entries: [{ log_id: '1', number: mine.phone, type: 'OUTGOING', started_at: new Date().toISOString(), duration_sec: 5 }] } });
  assert.equal(early.body.details.code, 'POLICY_NOT_ACKNOWLEDGED');
  ok(await api('POST', '/device/policy/ack', { device: reg.token, body: { version: cfg.policy.version } }));
  const policy = ok(await api('GET', '/sales/calling/setup', { token: tokens.admin })).settings.staffPolicy;
  ok(await api('PUT', '/sales/calling/setup', { token: tokens.admin, body: { staffPolicy: { en: `${policy.en} Ask your manager if unsure.`, hi: policy.hi } } }));
  assert.equal((await api('POST', '/device/call-log', { device: reg.token, body: { entries: [{ log_id: '2', number: mine.phone, type: 'OUTGOING', started_at: new Date().toISOString(), duration_sec: 5 }] } })).body.details.code, 'POLICY_NOT_ACKNOWLEDGED');
  const v = ok(await api('GET', '/device/config', { device: reg.token })).policy.version;
  ok(await api('POST', '/device/policy/ack', { device: reg.token, body: { version: v } }));

  const nums = ok(await api('GET', '/device/numbers', { device: reg.token }));
  const settings = await getSettings();
  const day = localDate(new Date(), settings.crm.sales.calendar?.timezone || 'Asia/Kolkata');
  assert.equal(nums.salt, daySalt(ids.ravi, day));
  assert.ok(nums.numbers.includes(hashNumber(nums.salt, normalizePhone(mine.phone))));
  assert.ok(!nums.numbers.includes(hashNumber(nums.salt, normalizePhone(stopped.phone))), 'never an opted-out number');
  assert.ok(nums.opted_out.includes(hashNumber(nums.salt, normalizePhone(stopped.phone))));
  assert.ok(!nums.numbers.some((h) => /^\d+$/.test(h)), 'hashes, not numbers');
  assert.notEqual(daySalt(ids.isha, day), daySalt(ids.ravi, day), 'a salt per person');
});

test('B: call-log entries attach to the started call or make one call, once; numbers that are not leads are refused and not stored', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const dev = await phone('isha', 'sync-phone-0001');
  const s = ok(await start(lead, tokens.isha, { via: 'ANDROID_APP' }), 201);
  const at = new Date().toISOString();
  const r1 = ok(await api('POST', '/device/call-log', { device: dev.token, body: { entries: [{ log_id: 'A1', number: `+91 ${lead.phone}`, type: 'OUTGOING', started_at: at, duration_sec: 192, call_id: s.call.id, sim: 'Work SIM' }] } }));
  assert.equal(r1.results[0].status, 'ATTACHED');
  assert.equal(r1.results[0].call_id, s.call.id);
  const c = await callRow(s.call.id);
  assert.equal(c.status, 'COMPLETED');
  assert.equal(c.connected, true);
  assert.equal(c.talk_sec, 192);
  assert.equal(c.duration_source, 'DEVICE_LOG');
  assert.equal(c.sim_label, 'Work SIM');
  assert.equal((await leadRow(lead.id)).call_attempts, 1, 'the phone counted the attempt');
  // the same entry again changes nothing
  const r2 = ok(await api('POST', '/device/call-log', { device: dev.token, body: { entries: [{ log_id: 'A1', number: lead.phone, type: 'OUTGOING', started_at: at, duration_sec: 192 }] } }));
  assert.equal(r2.results[0].status, 'DUPLICATE');
  // then the person says how it went: the same call, and no second attempt
  ok(await api('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: { status_id: await statusId('interested'), note: 'Wants prices', call_id: s.call.id, request_id: rid('after') } }));
  assert.equal((await leadRow(lead.id)).call_attempts, 1);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_calls WHERE lead_id = $1', [lead.id])).rows[0].n, 1);

  // a call to the lead made from the normal dialler: one new call
  const r3 = ok(await api('POST', '/device/call-log', { device: dev.token, body: { entries: [{ log_id: 'A2', number: lead.phone, type: 'OUTGOING', started_at: new Date(Date.now() - 3600_000).toISOString(), duration_sec: 0 }] } }));
  assert.equal(r3.results[0].status, 'CREATED');
  const created = await callRow(r3.results[0].call_id);
  assert.equal(created.recorded_via, 'DEVICE_SYNC');
  assert.equal(created.status, 'NO_ANSWER');
  assert.equal((await leadRow(lead.id)).call_attempts, 2);

  // a personal call: refused, and nothing about it is stored
  const before = (await query('SELECT COUNT(*)::int AS n FROM crm_calls')).rows[0].n;
  const r4 = ok(await api('POST', '/device/call-log', { device: dev.token, body: { entries: [{ log_id: 'P1', number: '9000011111', type: 'OUTGOING', started_at: new Date().toISOString(), duration_sec: 60 }] } }));
  assert.deepEqual([r4.results[0].status, r4.results[0].reason], ['REFUSED', 'NOT_A_LEAD']);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_calls')).rows[0].n, before);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_calls WHERE counterpart_normalized = '919000011111'`)).rows[0].n, 0);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_audit_events WHERE detail::text LIKE '%9000011111%'`)).rows[0].n, 0);
});

test('B: incoming calls from leads are kept; a missed one becomes a "Call back" for the owner, labelled when the number had opted out', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const quiet = await newLead();
  ok(await api('POST', '/sales/optouts', { token: tokens.isha, body: { channel: 'CALL', address: quiet.phone } }), 201);
  const dev = await phone('ravi', 'inbound-phone-01');
  const r = ok(await api('POST', '/device/call-log', {
    device: dev.token,
    body: { entries: [
      { log_id: 'I1', number: lead.phone, type: 'INCOMING', started_at: new Date(Date.now() - 600_000).toISOString(), duration_sec: 75 },
      { log_id: 'M1', number: lead.phone, type: 'MISSED', started_at: new Date(Date.now() - 300_000).toISOString(), duration_sec: 0 },
      { log_id: 'M2', number: quiet.phone, type: 'MISSED', started_at: new Date(Date.now() - 200_000).toISOString(), duration_sec: 0 },
    ] },
  }));
  assert.deepEqual(r.results.map((x) => x.status), ['CREATED', 'CREATED', 'CREATED']);
  const inbound = await callRow(r.results[0].call_id);
  assert.deepEqual([inbound.direction, inbound.connected, inbound.talk_sec], ['INBOUND', true, 75]);
  const fu = (await query(`SELECT * FROM tasks WHERE crm_lead_id = $1 AND followup_kind = 'CALLBACK' AND completed_at IS NULL`, [lead.id])).rows;
  assert.equal(fu.length, 1);
  assert.equal(fu[0].assignee_id, ids.isha, 'for the lead\'s owner');
  const quietFu = (await query(`SELECT title FROM tasks WHERE crm_lead_id = $1 AND followup_kind = 'CALLBACK'`, [quiet.id])).rows[0];
  assert.match(quietFu.title, /^Opted out earlier: they called you/);
  // they called: calling them back is allowed for a day, and labelled
  const back = ok(await start(quiet, tokens.isha), 201);
  assert.equal(back.callback_reason, 'THEY_CALLED');
});

test('B: a blocked phone is refused; handing a phone over keeps earlier calls with the first person and refuses later ones', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  const first = await phone('isha', 'handover-phone-1');
  const devId = first.device.id;
  const early = new Date(Date.now() - 20 * 60_000).toISOString();
  ok(await api('POST', '/device/call-log', { device: first.token, body: { entries: [{ log_id: 'H1', number: lead.phone, type: 'OUTGOING', started_at: early, duration_sec: 30 }] } }));
  assert.equal((await api('POST', `/sales/calling/devices/${devId}/hand-over`, { token: tokens.manager })).status, 403, 'administrators only');
  ok(await api('POST', `/sales/calling/devices/${devId}/hand-over`, { token: tokens.admin }));
  // a call made before the hand-over, sent late, still counts for the first person
  const late = ok(await api('POST', '/device/call-log', { device: first.token, body: { entries: [{ log_id: 'H2', number: lead.phone, type: 'OUTGOING', started_at: new Date(Date.now() - 10 * 60_000).toISOString(), duration_sec: 40 }] } }));
  assert.equal(late.results[0].status, 'CREATED');
  assert.equal((await callRow(late.results[0].call_id)).agent_user_id, ids.isha);
  // one made after it is refused for the first person's token
  const after = ok(await api('POST', '/device/call-log', { device: first.token, body: { entries: [{ log_id: 'H3', number: lead.phone, type: 'OUTGOING', started_at: new Date(Date.now() + 1000).toISOString(), duration_sec: 50 }] } }));
  assert.deepEqual([after.results[0].status, after.results[0].reason], ['REFUSED', 'SIGNED_OUT']);
  assert.equal((await api('GET', '/device/numbers', { device: first.token })).status, 401);
  // the second person signs in on the same phone: their calls are theirs
  const second = await phone('manager', 'handover-phone-1');
  assert.equal(second.device.id, devId);
  const theirs = ok(await api('POST', '/device/call-log', { device: second.token, body: { entries: [{ log_id: 'H4', number: lead.phone, type: 'OUTGOING', started_at: new Date().toISOString(), duration_sec: 20 }] } }));
  assert.equal((await callRow(theirs.results[0].call_id)).agent_user_id, ids.manager);
  // blocked: everything is refused, even with a fresh sign-in
  ok(await api('POST', `/sales/calling/devices/${devId}/revoke`, { token: tokens.admin, body: { reason: 'Lost on the field visit' } }));
  const blocked = await api('GET', '/device/config', { device: second.token });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.body.details?.code, 'DEVICE_REVOKED');
  assert.equal((await api('POST', '/sales/calling/devices/register', { token: tokens.manager, body: { install_id: 'handover-phone-1' } })).status, 409);
  const list = ok(await api('GET', '/sales/calling/devices', { token: tokens.admin }));
  const row = list.devices.find((d) => d.id === devId);
  assert.ok(row.revoked_at);
  assert.equal(row.revoke_reason, 'Lost on the field visit');
  ok(await api('POST', `/sales/calling/devices/${devId}/allow`, { token: tokens.admin }));
});

test('B: the app sends a recording for its call; a dialler\'s mode is confirmed by an administrator; three calls without one raise a warning', async (t) => {
  if (skip(t)) return;
  await recordingsOn();
  const lead = await newLead();
  const dev = await phone('isha', 'rec-phone-00001');
  const entry = { log_id: 'R1', number: lead.phone, type: 'OUTGOING', started_at: new Date(Date.now() - 60_000).toISOString(), duration_sec: 6 };
  const r = ok(await api('POST', '/device/call-log', { device: dev.token, body: { entries: [entry] } }));
  const key = `R1:${Math.floor(new Date(entry.started_at).getTime() / 1000)}`;
  const up = ok(await api('POST', '/device/recordings', { device: dev.token, form: fileForm(wav(6), 'Call recording 98110.m4a.wav', { log_key: key }) }), 201);
  assert.equal(up.recording.source, 'DEVICE_SYNC');
  assert.equal(up.recording.call_id, r.results[0].call_id);
  assert.match(up.sha256, /^[0-9a-f]{64}$/, 'the app compares this before removing its copy');
  // modes: Samsung is only expected until an administrator confirms it
  assert.equal(ok(await api('GET', '/device/config', { device: dev.token })).recording_mode.confirmed, false);
  ok(await api('PUT', '/sales/calling/dialler-modes', { token: tokens.admin, body: { package: 'com.samsung.android.dialer', mode: 'AUTOMATIC', folder_hint: 'Recordings/Call' } }));
  const mode = ok(await api('GET', '/device/config', { device: dev.token })).recording_mode;
  assert.deepEqual([mode.mode, mode.confirmed, mode.folder_hint], ['AUTOMATIC', true, 'Recordings/Call']);
  // three connected calls older than half an hour, none with a recording
  const old = (m) => new Date(Date.now() - m * 60_000).toISOString();
  ok(await api('POST', '/device/call-log', { device: dev.token, body: { entries: [61, 62, 63].map((m) => ({ log_id: `W${m}`, number: lead.phone, type: 'OUTGOING', started_at: old(m), duration_sec: 30 })) } }));
  const warnings = (await query('SELECT warnings FROM crm_call_devices WHERE id = $1', [dev.device.id])).rows[0].warnings;
  assert.ok(warnings.some((w) => w.code === 'NO_RECORDINGS'));
  const told = (await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'crm_calling' AND title ~ 'last 3 connected calls had no recording'`)).rows[0].n;
  assert.ok(told >= 2, 'the person and the administrators');
});

// ---------------------------------------------------------------- the weekly review, and the files themselves

test('C: the weekly calling review goes to administrators on Monday morning, once', async (t) => {
  if (skip(t)) return;
  // a Monday at 10:30 in India
  const monday = new Date('2026-11-16T05:00:00Z');
  const first = await runWeeklyCallingReview(monday);
  assert.equal(first.sent, true);
  assert.ok('opt_outs' in first.review && 'leads_at_daily_cap' in first.review && Array.isArray(first.review.calls_outside_hours));
  assert.equal((await runWeeklyCallingReview(new Date('2026-11-16T07:00:00Z'))).sent, false, 'not twice');
  assert.equal((await runWeeklyCallingReview(new Date('2026-11-17T05:00:00Z'))).sent, false, 'not on Tuesday');
  const preview = ok(await api('GET', '/sales/calling/review', { token: tokens.admin }));
  assert.ok('complaints' in preview);
});

test('the screens get what they show: the lead\'s opt-out and recording choice, which recent calls have a recording, talk time by source, the share target', async (t) => {
  if (skip(t)) return;
  const lead = await newLead();
  let page = ok(await api('GET', `/sales/leads/${lead.id}`, { token: tokens.isha }));
  assert.deepEqual(page.calling, { opted_out: null, no_messages: false, do_not_record: false });
  ok(await api('POST', `/sales/leads/${lead.id}/do-not-record`, { token: tokens.isha, body: { value: true } }));
  ok(await api('POST', '/sales/calls/complaint', { token: tokens.isha, body: { lead_id: lead.id, what_they_said: 'Too many calls' } }), 201);
  page = ok(await api('GET', `/sales/leads/${lead.id}`, { token: tokens.isha }));
  assert.equal(page.calling.do_not_record, true);
  assert.equal(page.calling.opted_out.complaint, true);

  // "Which call is this?" sees which calls already have a recording, and which are not to be recorded
  const other = await newLead();
  const s = ok(await start(other), 201);
  const recent = ok(await api('GET', '/sales/calls/recent', { token: tokens.isha })).calls.find((c) => c.id === s.call.id);
  assert.equal(recent.has_recording, false);
  assert.equal(recent.do_not_record, false);

  // talk time is split by where it came from: never measured and typed added up silently
  ok(await api('POST', `/sales/leads/${other.id}/call-status`, {
    token: tokens.isha, body: { status_id: await statusId('busy'), call_id: s.call.id, duration_sec: 120, duration_source: 'ESTIMATED', request_id: rid('est') },
  }));
  const typed = await newLead();
  ok(await api('POST', `/sales/leads/${typed.id}/call-status`, { token: tokens.isha, body: { status_id: await statusId('busy'), duration_sec: 60, request_id: rid('typed') } }));
  const report = ok(await api('GET', '/sales/reports/calling', { token: tokens.admin, query: undefined }));
  const isha = report.people.find((p) => p.id === ids.isha);
  assert.ok(isha.talk_estimated_seconds >= 120, JSON.stringify(isha));
  assert.ok(isha.talk_typed_seconds >= 60);
  assert.equal(isha.talk_seconds, isha.talk_measured_seconds + isha.talk_typed_seconds + isha.talk_estimated_seconds, 'the parts add up to the total');

  // the phone's setup is told how its dialler records
  const reg = ok(await api('POST', '/sales/calling/devices/register', { token: tokens.isha, body: { install_id: 'screens-phone-01', info: { maker: 'motorola', dialler_package: 'com.google.android.dialer' } } }), 201);
  assert.deepEqual(reg.recording_mode, { mode: 'SHARE_BY_HAND', confirmed: false });

  // the installed app accepts recordings shared from the phone
  const res = await fetch(`${baseUrl}/manifest.webmanifest`);
  const manifest = await res.json();
  assert.equal(manifest.share_target.action, '/share-recording');
  assert.equal(manifest.share_target.method, 'POST');
  assert.equal(manifest.share_target.params.files[0].name, 'recording');
});

test('the call length of an AMR recording is counted from its frames; migration 036 run again changes no existing call', async (t) => {
  if (skip(t)) return;
  const frames = Buffer.alloc(250 * 32);
  for (let i = 0; i < 250; i += 1) frames[i * 32] = (7 << 3) | 0x04;
  assert.equal(amrSeconds(Buffer.concat([Buffer.from('#!AMR\n'), frames])), 5);
  assert.equal(amrSeconds(Buffer.from('RIFF....WAVE')), null);
  const lead = await newLead();
  ok(await api('POST', `/sales/leads/${lead.id}/call-status`, { token: tokens.isha, body: { status_id: await statusId('busy'), request_id: rid('legacy') } }));
  const snapshot = (await query('SELECT id, provider, direction, status, duration_sec, outcome, notes, started_at, recording_ref FROM crm_calls ORDER BY id')).rows;
  const sql = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/db/migrations/036_sim_calling.sql'), 'utf8');
  await query(sql);
  const again = (await query('SELECT id, provider, direction, status, duration_sec, outcome, notes, started_at, recording_ref FROM crm_calls ORDER BY id')).rows;
  assert.deepEqual(again, snapshot);
});

test('B: a recording shared into the app goes on the call the person chose, marked as shared', async (t) => {
  if (skip(t)) return;
  await recordingsOn();
  const lead = await newLead();
  const dev = await phone('isha', 'share-phone-0001');
  const s = ok(await start(lead, tokens.isha, { via: 'ANDROID_APP' }), 201);
  ok(await api('POST', '/device/call-log', { device: dev.token, body: { entries: [{ log_id: 'S1', number: lead.phone, type: 'OUTGOING', started_at: new Date().toISOString(), duration_sec: 8, call_id: s.call.id }] } }));
  const up = ok(await api('POST', '/device/recordings', { device: dev.token, form: fileForm(wav(4), 'shared.wav', { call_id: s.call.id, source: 'SHARED' }) }), 201);
  assert.equal(up.recording.source, 'SHARED');
  assert.equal(up.recording.call_id, s.call.id);
  // anything else from the app is its own pick-up; and a call that is not this person's is refused
  const other = await newLead({ owner_user_id: ids.ravi });
  const r = ok(await start(other, tokens.ravi), 201);
  assert.equal((await api('POST', '/device/recordings', { device: dev.token, form: fileForm(wav(2), 'x.wav', { call_id: r.call.id, source: 'SHARED' }) })).status, 404);
});

test('the phone-number rules match the shared answers the Android app is tested against', () => {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '../../shared/callingVectors.json');
  const vectors = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const v of vectors.normalise) assert.equal(normalizePhone(v.input), v.expected, `normalise ${JSON.stringify(v.input)}`);
  for (const v of vectors.hash.cases) assert.equal(hashNumber(vectors.hash.salt, v.number), v.expected);
  assert.ok(vectors.hash.cases.length >= 8);
});
