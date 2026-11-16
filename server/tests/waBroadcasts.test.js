/**
 * WhatsApp broadcasts and opt-ins, against a TEST double of Meta's Graph API
 * (no real provider is contacted; every number here is made up):
 *
 *   1  opt-ins: recorded on a lead, removed with a reason, refused after a
 *      STOP reply; "wrote to us first" counts; the lead list's WhatsApp filter
 *   2  the list: equal to the lead list for the same filters, each person
 *      skipped with a reason (no opt-in, opted out, same number, no phone,
 *      nothing to fill a blank); unusable templates refused
 *   3  approval like email campaigns: another person approves; a change
 *      after approval starts it again; permissions
 *   4  sending: only the agreed numbers, the blanks filled, one message per
 *      number, never twice, finished and counted; lead timeline
 *   5  hours, daily limit, "got one recently", a STOP between approval and
 *      sending, pause, resume, cancel
 *   6  failures: retried without duplicates; ten refusals in a row pause it
 *   7  scheduled sending, a test to one's own phone, the switch
 *   8  the enquiry form's tick box and the import column record opt-ins
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { getSettings, updateSetting } from '../src/services/settings.js';
import { runBroadcasts } from '../src/services/sales/broadcasts.js';
import { processImports } from '../src/services/sales/imports.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

// ---- the TEST double for Meta's Graph API: every call is recorded
const realFetch = globalThis.fetch;
const graphCalls = [];
let graphMode = 'ok';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://graph.facebook.com/')) {
    graphCalls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.includes('/message_templates')) {
      return new Response(JSON.stringify({ data: [
        { name: 'seed_offer', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Namaste {{1}}, your {{2}} kit offer is open in {{3}}.' }] },
        { name: 'with_picture', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'See the new kit, {{1}}.' }] },
        { name: 'not_yet', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Soon' }] },
        { name: 'plain_news', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Sample news for {{1}}.' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (graphMode === 'fail') {
      return new Response(JSON.stringify({ error: { code: 131026, message: 'Message undeliverable', error_user_msg: 'Recipient is not a WhatsApp user' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.BC${graphCalls.length}` }] }), { status: 200 });
  }
  return realFetch(url, init);
};
const sends = () => graphCalls.filter((c) => c.url.endsWith('/messages'));

const call = async (method, path, { token, body, headers = {}, rawBody = null, contentType = 'application/json' } = {}) => {
  const res = await realFetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const day = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400000));
const IST = (d, hhmm) => new Date(`${d}T${hhmm}:00+05:30`);
const IN_HOURS = () => IST(day(0), '10:00');

const WA_SECRET = 'test-app-secret';
const waHook = (payload) => {
  const text = JSON.stringify(payload);
  return call('POST', '/s/whatsapp', { rawBody: text, headers: { 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', WA_SECRET).update(text).digest('hex')}` } });
};
// a reply is stamped a few seconds on, as a real one would be
const inbound = (from, id, text, later = 0) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Sample' } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000) + later), type: 'text', text: { body: text } }] } }] }] });

async function setBroadcasts(patch) {
  const all = await getSettings();
  const crm = all.crm;
  await updateSetting('crm', { ...crm, sales: { ...crm.sales, whatsapp: { ...crm.sales.whatsapp, broadcasts: { ...crm.sales.whatsapp.broadcasts, ...patch } } } }, ids.admin);
}
const lead = async (body, token = tokens.mona) => {
  const r = await call('POST', '/sales/leads', { token, body });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return r.body.lead;
};
const optIn = (leadId, how = 'ON_CALL', token = tokens.mona) => call('POST', `/sales/leads/${leadId}/whatsapp-optin`, { token, body: { how } });
const SEED_VARS = [{ source: 'first_name', fallback: 'farmer' }, { source: 'fixed', text: 'soil test' }, { source: 'district' }];

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  Object.assign(process.env, {
    WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1000', WHATSAPP_BUSINESS_ACCOUNT_ID: '2000',
    WHATSAPP_APP_SECRET: WA_SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me', WHATSAPP_SANDBOX: 'true',
  });
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('SAL', 'Sales', '#2a78d6', 1)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do','to-do','todo','#3b82f6',1,TRUE), ('Done','done','done','#22c55e',2,FALSE)`);
  ids.sales = (await query(`SELECT id FROM departments WHERE key = 'SAL'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, name, role, phone] of [
    ['admin', 'Admin Sample', 'admin', null], ['mona', 'Mona Sample', 'manager', '9800000101'],
    ['milo', 'Milo Sample', 'manager', null], ['vera', 'Vera Sample', 'member', null],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, phone) VALUES ($1,$2,$3,$4,$5,FALSE,$6) RETURNING id`,
      [name, `bc-${key}@example.com`, password, role, ids.sales, phone],
    );
    ids[key] = rows[0].id;
  }
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'mona', 'milo', 'vera']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `bc-${key}@example.com`, password: 'Password123!' } })).body.token;
  }
  ok(await call('POST', '/sales/whatsapp/templates/sync', { token: tokens.admin }));

  // eight retailers: who can get a broadcast, and why the others cannot
  const L = async (key, body) => { ids[key] = (await lead({ category: 'RETAILER', owner_user_id: ids.mona, ...body })).id; };
  await L('asha', { contact_name: 'Asha Sample', phone: '9800011001', district: 'Sample District' });
  await L('bhanu', { contact_name: 'Bhanu Sample', phone: '9800011002' });
  await L('chitra', { contact_name: 'Chitra Sample', phone: '9800011003', district: 'Sample District' });
  await L('dev', { contact_name: 'Dev Sample', phone: '9800011004', district: 'Sample District' });
  await L('esha', { contact_name: 'Esha Sample', phone: '+91 98000 11001', district: 'Sample District' });
  await L('nophone', { contact_name: 'Noor Sample', email: 'noor@example.com', district: 'Sample District' });
  await L('farid', { contact_name: 'Farid Sample', phone: '9800011007', district: 'Sample District' });
  await L('gita', { organization_name: 'Gita Sample Agro', phone: '9800011008', district: 'Sample District' });
  // and one FPO, not in the retailers' list
  ids.fpo = (await lead({ category: 'FPO', organization_name: 'Sample FPO', contact_name: 'Hari Sample', phone: '9800011009', district: 'Sample District' })).id;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('1: opt-ins are recorded on the lead, removed with a reason, and lose to an opt-out; writing first counts', async (t) => {
  if (skip(t)) return;
  let page = ok(await call('GET', `/sales/leads/${ids.asha}`, { token: tokens.mona }));
  assert.equal(page.whatsapp.can_broadcast, false);
  assert.equal(page.whatsapp.why, 'No WhatsApp opt-in recorded');

  const first = ok(await optIn(ids.asha), 201);
  assert.equal(first.whatsapp.can_broadcast, true);
  assert.equal(first.whatsapp.optin.how, 'ON_CALL');
  assert.equal(first.whatsapp.optin.recorded_by_name, 'Mona Sample');
  assert.equal(ok(await optIn(ids.asha)).already, true, 'a second opt-in for the number is not stored');
  // the same number on another lead shares the opt-in: it is the number that agreed
  assert.equal(ok(await call('GET', `/sales/leads/${ids.esha}`, { token: tokens.mona })).whatsapp.can_broadcast, true);
  page = ok(await call('GET', `/sales/leads/${ids.asha}`, { token: tokens.mona }));
  assert.ok(page.timeline.some((a) => a.subject === 'WhatsApp opt-in recorded'), 'the lead timeline says so');
  assert.equal((await call('POST', `/sales/leads/${ids.asha}/whatsapp-optin`, { token: tokens.mona, body: { how: 'FORM' } })).status, 400, 'a person records on a call, in person or other');

  // removed by mistake, then recorded again
  assert.equal((await call('POST', `/sales/leads/${ids.bhanu}/whatsapp-optin/remove`, { token: tokens.mona, body: { reason: 'Recorded by mistake' } })).status, 404);
  ok(await optIn(ids.bhanu), 201);
  const removed = ok(await call('POST', `/sales/leads/${ids.bhanu}/whatsapp-optin/remove`, { token: tokens.mona, body: { reason: 'Recorded by mistake' } }));
  assert.equal(removed.whatsapp.can_broadcast, false);
  ok(await optIn(ids.bhanu), 201);

  // a STOP reply wins, and a new opt-in is refused until an administrator lifts the opt-out
  ok(await optIn(ids.dev), 201);
  ok(await waHook(inbound('919800011004', 'wamid.in.dev', 'STOP')));
  page = ok(await call('GET', `/sales/leads/${ids.dev}`, { token: tokens.mona }));
  assert.equal(page.whatsapp.can_broadcast, false);
  assert.equal(page.whatsapp.why, 'Opted out of WhatsApp');
  assert.equal((await optIn(ids.dev)).status, 409);

  // writing to us on WhatsApp first counts as agreeing
  ok(await waHook(inbound('919800011007', 'wamid.in.farid', 'Is the kit available?')));
  page = ok(await call('GET', `/sales/leads/${ids.farid}`, { token: tokens.mona }));
  assert.equal(page.whatsapp.can_broadcast, true);
  assert.ok(page.whatsapp.wrote_first_at);

  ok(await optIn(ids.gita), 201);
  ok(await optIn(ids.fpo), 201);
  assert.equal((await optIn(ids.nophone)).status, 400, 'no phone, nothing to record');

  // the lead list's WhatsApp filter
  const yes = ok(await call('GET', '/sales/leads?view=all&category=RETAILER&wa_optin=yes', { token: tokens.mona }));
  assert.deepEqual(yes.leads.map((l) => l.id).sort((a, b) => a - b), [ids.asha, ids.bhanu, ids.esha, ids.farid, ids.gita].sort((a, b) => a - b));
  const no = ok(await call('GET', '/sales/leads?view=all&category=RETAILER&wa_optin=no', { token: tokens.mona }));
  assert.equal(yes.total + no.total, ok(await call('GET', '/sales/leads?view=all&category=RETAILER', { token: tokens.mona })).total);
});

test('2: the list is the lead list for the same filters, each person skipped with a reason', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('GET', '/sales/broadcasts', { token: tokens.vera })).status, 403, 'seeing broadcasts needs marketing.view');
  assert.equal((await call('POST', '/sales/broadcasts', { token: tokens.vera, body: { name: 'Nope' } })).status, 403);
  const options = ok(await call('GET', '/sales/broadcasts/options', { token: tokens.mona }));
  const byName = Object.fromEntries(options.templates.map((x) => [x.name, x]));
  assert.equal(byName.seed_offer.usable, true);
  assert.match(byName.with_picture.why_not, /header image/);
  assert.match(byName.not_yet.why_not, /not approved/);

  const made = ok(await call('POST', '/sales/broadcasts', { token: tokens.mona, body: {
    name: 'Sample retailer kit offer', filters: { view: 'all', category: 'RETAILER', page: '3', sort: 'x' },
    template_name: 'seed_offer', template_language: 'en', variables: SEED_VARS,
  } }), 201);
  ids.b1 = made.broadcast.id;
  assert.deepEqual(made.broadcast.filters, { view: 'all', category: 'RETAILER' }, 'only the lead list\'s filters are kept');
  const leadList = ok(await call('GET', '/sales/leads?view=all&category=RETAILER', { token: tokens.mona }));
  assert.equal(made.list.matched, leadList.total, 'the same count as the lead list');
  assert.equal(made.list.matched, 8);
  assert.equal(made.list.will_send, 3, 'Asha, Farid and Gita Sample Agro');
  const skipped = Object.fromEntries(made.list.skipped.map((s) => [s.code, s.n]));
  assert.deepEqual(skipped, { MISSING_VALUE: 1, NO_OPTIN: 1, OPTED_OUT: 1, SAME_NUMBER: 1, NO_PHONE: 1 });
  assert.equal(made.sample[0].text, 'Namaste Asha, your soil test kit offer is open in Sample District.');

  const who = ok(await call('GET', `/sales/broadcasts/${ids.b1}?people=1&reason=MISSING_VALUE`, { token: tokens.mona }));
  assert.equal(who.people[0].lead_id, ids.bhanu);
  assert.equal(who.people[0].why, 'Nothing to fill {{3}}');
  const same = ok(await call('GET', `/sales/broadcasts/${ids.b1}?people=1&reason=SAME_NUMBER`, { token: tokens.mona }));
  assert.match(same.people[0].why, /^Same number as /);
  const going = ok(await call('GET', `/sales/broadcasts/${ids.b1}?people=1&reason=SEND`, { token: tokens.mona }));
  assert.deepEqual(going.people.map((p) => p.lead_id).sort((a, b) => a - b), [ids.asha, ids.farid, ids.gita].sort((a, b) => a - b));

  // a template it cannot use is refused at submission, with the reason
  const pic = ok(await call('POST', '/sales/broadcasts', { token: tokens.mona, body: { name: 'Sample picture', filters: { view: 'all' }, template_name: 'with_picture', variables: [{ source: 'first_name' }] } }), 201);
  const refused = await call('POST', `/sales/broadcasts/${pic.broadcast.id}/submit`, { token: tokens.mona });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /header image/);
  ok(await call('POST', `/sales/broadcasts/${pic.broadcast.id}/cancel`, { token: tokens.mona, body: { reason: 'Test' } }));
});

test('3: approval is like email campaigns: someone else approves exactly what they saw', async (t) => {
  if (skip(t)) return;
  const submitted = ok(await call('POST', `/sales/broadcasts/${ids.b1}/submit`, { token: tokens.mona }));
  assert.equal(submitted.broadcast.status, 'IN_REVIEW');
  const { rows: notes } = await query(`SELECT user_id FROM notifications WHERE title = 'A WhatsApp broadcast is waiting for your approval'`);
  assert.ok(notes.some((n) => n.user_id === ids.milo) && !notes.some((n) => n.user_id === ids.mona), 'approvers other than the sender are told');
  assert.equal((await call('POST', `/sales/broadcasts/${ids.b1}/approve`, { token: tokens.mona })).status, 403, 'not the person who sent it for approval');
  assert.equal((await call('POST', `/sales/broadcasts/${ids.b1}/approve`, { token: tokens.vera })).status, 403);
  assert.equal((await call('POST', `/sales/broadcasts/${ids.b1}/send`, { token: tokens.mona })).status, 409, 'not approved yet');
  const approved = ok(await call('POST', `/sales/broadcasts/${ids.b1}/approve`, { token: tokens.milo, body: { note: 'Looks right' } }));
  assert.equal(approved.broadcast.status, 'APPROVED');
  assert.equal(approved.broadcast.approved_count, 3);

  // a change to the list after approval sends it back to draft
  const changed = ok(await call('PATCH', `/sales/broadcasts/${ids.b1}`, { token: tokens.mona, body: { filters: { view: 'all', category: 'RETAILER', district: 'Sample District' } } }));
  assert.equal(changed.broadcast.status, 'DRAFT');
  assert.match(changed.broadcast.review_note, /approve it again/);
  // a new name alone keeps it as it is
  ok(await call('PATCH', `/sales/broadcasts/${ids.b1}`, { token: tokens.mona, body: { filters: { view: 'all', category: 'RETAILER' } } }));
  ok(await call('POST', `/sales/broadcasts/${ids.b1}/submit`, { token: tokens.mona }));
  const asked = ok(await call('POST', `/sales/broadcasts/${ids.b1}/request-changes`, { token: tokens.milo, body: { note: 'Say "Sample" in the name' } }));
  assert.equal(asked.broadcast.status, 'DRAFT');
  ok(await call('PATCH', `/sales/broadcasts/${ids.b1}`, { token: tokens.mona, body: { name: 'Sample retailer kit offer (Nov)' } }));
  ok(await call('POST', `/sales/broadcasts/${ids.b1}/submit`, { token: tokens.mona }));
  ok(await call('POST', `/sales/broadcasts/${ids.b1}/approve`, { token: tokens.milo }));
  const renamed = ok(await call('PATCH', `/sales/broadcasts/${ids.b1}`, { token: tokens.mona, body: { name: 'Sample retailer kit offer, November' } }));
  assert.equal(renamed.broadcast.status, 'APPROVED', 'a new name is not a new message');

  // not connected: it cannot go out
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  const notConnected = await call('POST', `/sales/broadcasts/${ids.b1}/send`, { token: tokens.mona });
  process.env.WHATSAPP_ACCESS_TOKEN = token;
  assert.equal(notConnected.status, 409);
  assert.match(notConnected.body.error, /not connected/);
  assert.equal((await call('POST', `/sales/broadcasts/${ids.b1}/send`, { token: tokens.vera })).status, 403);
});

test('4: sending goes only to the agreed numbers, fills the blanks, and never sends twice', async (t) => {
  if (skip(t)) return;
  const started = ok(await call('POST', `/sales/broadcasts/${ids.b1}/send`, { token: tokens.mona }));
  assert.equal(started.broadcast.status, 'SENDING');
  assert.equal(started.progress.pending, 3);
  assert.equal(started.progress.skipped, 5);
  assert.equal((await call('PATCH', `/sales/broadcasts/${ids.b1}`, { token: tokens.mona, body: { name: 'Too late' } })).status, 409);

  const before = sends().length;
  const pass = await runBroadcasts(IN_HOURS());
  assert.equal(pass.sent, 3);
  const mine = sends().slice(before);
  assert.deepEqual(mine.map((c) => c.body.to).sort(), ['919800011001', '919800011007', '919800011008']);
  const params = Object.fromEntries(mine.map((c) => [c.body.to, c.body.template.components[0].parameters.map((p) => p.text)]));
  assert.deepEqual(params['919800011001'], ['Asha', 'soil test', 'Sample District']);
  assert.deepEqual(params['919800011008'], ['farmer', 'soil test', 'Sample District'], 'no first name: the fallback');
  assert.equal(mine[0].body.template.name, 'seed_offer');

  // a second pass sends nothing more, and the broadcast is finished and counted
  await runBroadcasts(IN_HOURS());
  assert.equal(sends().length, before + 3);
  const done = ok(await call('GET', `/sales/broadcasts/${ids.b1}`, { token: tokens.mona }));
  assert.equal(done.broadcast.status, 'SENT');
  assert.equal(done.progress.sent, 3);
  assert.equal(done.progress.skipped, 5);
  const { rows: msgs } = await query('SELECT lead_id, broadcast_id, idempotency_key FROM crm_wa_messages WHERE broadcast_id = $1', [ids.b1]);
  assert.equal(msgs.length, 3);
  assert.ok(msgs.every((m) => m.idempotency_key.startsWith(`wa-broadcast:${ids.b1}:`)));
  const page = ok(await call('GET', `/sales/leads/${ids.asha}`, { token: tokens.mona }));
  assert.ok(page.timeline.some((a) => a.type === 'WHATSAPP' && /seed_offer/.test(a.subject)), 'the message is on the lead\'s timeline');
  const { rows: told } = await query(`SELECT user_id FROM notifications WHERE title LIKE 'WhatsApp broadcast sent:%'`);
  assert.ok(told.some((n) => n.user_id === ids.mona));

  // a reply and a STOP after the broadcast are counted
  ok(await waHook(inbound('919800011001', 'wamid.in.asha', 'Yes, interested', 5)));
  ok(await waHook(inbound('919800011008', 'wamid.in.gita', 'stop', 5)));
  const report = ok(await call('GET', `/sales/broadcasts/${ids.b1}`, { token: tokens.mona })).progress;
  assert.equal(report.replied, 2);
  assert.equal(report.opted_out_after, 1);
});

/** A broadcast to the retailers with a recorded opt-in, approved and started. */
async function approvedBroadcast(name, filters = { view: 'all', category: 'RETAILER' }, template = 'plain_news') {
  const b = ok(await call('POST', '/sales/broadcasts', { token: tokens.mona, body: { name, filters, template_name: template, variables: [{ source: 'contact_name', fallback: 'friend' }] } }), 201);
  ok(await call('POST', `/sales/broadcasts/${b.broadcast.id}/submit`, { token: tokens.mona }));
  ok(await call('POST', `/sales/broadcasts/${b.broadcast.id}/approve`, { token: tokens.milo }));
  return b.broadcast.id;
}

test('5: hours, the daily limit, "got one recently", a STOP before sending, pause, resume and cancel', async (t) => {
  if (skip(t)) return;
  // the numbers that just got one are skipped for the next 3 days
  const id = await approvedBroadcast('Sample retailer news');
  const look = ok(await call('GET', `/sales/broadcasts/${id}`, { token: tokens.mona }));
  const why = Object.fromEntries(look.list.skipped.map((s) => [s.code, s.n]));
  assert.equal(why.RECENT, 2, 'Asha and Farid got the last one; Gita has opted out since');
  assert.equal(look.list.will_send, 1, 'Bhanu now: no blank is missing in this template');
  await setBroadcasts({ minDaysBetween: 0 });
  assert.equal(ok(await call('GET', `/sales/broadcasts/${id}`, { token: tokens.mona })).list.will_send, 3);
  ok(await call('POST', `/sales/broadcasts/${id}/send`, { token: tokens.mona }));

  // outside the hours nothing goes
  const before = sends().length;
  const night = await runBroadcasts(IST(day(0), '22:00'));
  assert.match(night.waiting, /Outside sending hours/);
  assert.equal(sends().length, before);

  // a STOP after it started: checked again just before the message
  ok(await waHook(inbound('919800011007', 'wamid.in.farid.stop', 'STOP')));
  // the daily limit: one more today
  const room = await query(`SELECT COUNT(*)::int AS n FROM crm_wa_messages WHERE broadcast_id IS NOT NULL AND direction = 'OUTBOUND' AND created_at > now() - interval '24 hours'`);
  await setBroadcasts({ dailyLimit: room.rows[0].n + 1 });
  const p1 = await runBroadcasts(IN_HOURS());
  assert.equal(p1.sent, 1);
  const p2 = await runBroadcasts(IN_HOURS());
  assert.equal(p2.waiting, 'Daily limit reached');
  await setBroadcasts({ dailyLimit: 250 });

  // pause, resume
  ok(await call('POST', `/sales/broadcasts/${id}/pause`, { token: tokens.mona }));
  assert.equal((await runBroadcasts(IN_HOURS())).sent, 0);
  ok(await call('POST', `/sales/broadcasts/${id}/resume`, { token: tokens.mona }));
  await runBroadcasts(IN_HOURS());
  const after = ok(await call('GET', `/sales/broadcasts/${id}?people=1`, { token: tokens.mona }));
  assert.equal(after.broadcast.status, 'SENT');
  const farid = after.people.find((p) => p.lead_id === ids.farid);
  assert.equal(farid.status, 'SKIPPED');
  assert.equal(farid.reason, 'Opted out of WhatsApp');
  assert.equal(sends().filter((c) => c.body.to === '919800011007').length, 1, 'Farid got only the first broadcast');

  // cancel: what had not gone is skipped, with the reason
  const c = await approvedBroadcast('Sample cancelled news');
  ok(await call('POST', `/sales/broadcasts/${c}/send`, { token: tokens.mona }));
  const cancelled = ok(await call('POST', `/sales/broadcasts/${c}/cancel`, { token: tokens.mona, body: { reason: 'Wrong week' } }));
  assert.equal(cancelled.broadcast.status, 'CANCELLED');
  assert.equal(cancelled.progress.pending, 0);
  const n = sends().length;
  await runBroadcasts(IN_HOURS());
  assert.equal(sends().length, n);
  assert.equal((await call('POST', `/sales/broadcasts/${c}/cancel`, { token: tokens.mona })).status, 409);
});

test('6: failures are retried without duplicates; ten refusals in a row pause the broadcast', async (t) => {
  if (skip(t)) return;
  const id = await approvedBroadcast('Sample failing news');
  ok(await call('POST', `/sales/broadcasts/${id}/send`, { token: tokens.mona }));
  graphMode = 'fail';
  const pass = await runBroadcasts(IN_HOURS());
  graphMode = 'ok';
  assert.ok(pass.failed >= 1);
  let b = ok(await call('GET', `/sales/broadcasts/${id}`, { token: tokens.mona }));
  assert.equal(b.broadcast.status, 'SENT');
  assert.equal(b.progress.failed, pass.failed);
  assert.deepEqual(b.progress.reasons.filter((r) => r.status === 'FAILED').map((r) => r.reason), ['Recipient is not a WhatsApp user']);
  const retry = ok(await call('POST', `/sales/broadcasts/${id}/retry-failed`, { token: tokens.mona }));
  assert.equal(retry.retrying, pass.failed);
  await runBroadcasts(IN_HOURS());
  b = ok(await call('GET', `/sales/broadcasts/${id}`, { token: tokens.mona }));
  assert.equal(b.progress.failed, 0);
  assert.equal(b.progress.sent, pass.failed);
  const { rows } = await query('SELECT COUNT(*)::int AS n, COUNT(DISTINCT phone_normalized)::int AS numbers FROM crm_wa_messages WHERE broadcast_id = $1', [id]);
  assert.equal(rows[0].n, rows[0].numbers, 'one message per number, even after a retry');

  // ten refusals in a row: it stops and tells the sender
  for (let i = 0; i < 11; i += 1) {
    const l = await lead({ category: 'INDIVIDUAL', contact_name: `Sample Farmer ${i}`, phone: `98000220${String(i).padStart(2, '0')}` });
    ok(await optIn(l.id), 201);
  }
  const many = await approvedBroadcast('Sample farmers', { view: 'all', category: 'INDIVIDUAL' });
  ok(await call('POST', `/sales/broadcasts/${many}/send`, { token: tokens.mona }));
  graphMode = 'fail';
  await runBroadcasts(IN_HOURS());
  graphMode = 'ok';
  const paused = ok(await call('GET', `/sales/broadcasts/${many}`, { token: tokens.mona }));
  assert.equal(paused.broadcast.status, 'PAUSED');
  assert.match(paused.broadcast.pause_reason, /refused 10 messages in a row/);
  assert.equal(paused.progress.pending, 1);
  ok(await call('POST', `/sales/broadcasts/${many}/cancel`, { token: tokens.mona }));
});

test('7: scheduled sending, a test to one\'s own phone, and the switch', async (t) => {
  if (skip(t)) return;
  await setBroadcasts({ minDaysBetween: 0 });
  const id = await approvedBroadcast('Sample scheduled news', { view: 'all', category: 'FPO' });
  const at = IST(day(1), '10:00');
  const scheduled = ok(await call('POST', `/sales/broadcasts/${id}/send`, { token: tokens.mona, body: { send_at: at.toISOString() } }));
  assert.equal(scheduled.broadcast.status, 'SCHEDULED');
  const n = sends().length;
  await runBroadcasts(IST(day(0), '11:00'));
  assert.equal(sends().length, n, 'not before its time');
  const pass = await runBroadcasts(new Date(at.getTime() + 60_000));
  assert.equal(pass.started, 1);
  assert.equal(pass.sent, 1);
  assert.equal(sends().at(-1).body.to, '919800011009');

  // a test goes to the person's own phone, never to a lead
  const b = ok(await call('POST', '/sales/broadcasts', { token: tokens.mona, body: { name: 'Sample test send', filters: { view: 'all', category: 'RETAILER' }, template_name: 'seed_offer', variables: SEED_VARS } }), 201);
  const tested = ok(await call('POST', `/sales/broadcasts/${b.broadcast.id}/test`, { token: tokens.mona }));
  assert.equal(sends().at(-1).body.to, '919800000101');
  assert.equal(tested.values.length, 3);
  assert.equal((await call('POST', `/sales/broadcasts/${b.broadcast.id}/test`, { token: tokens.milo })).status, 400, 'no phone on the profile');
  assert.equal((await call('POST', `/sales/broadcasts/${b.broadcast.id}/test`, { token: tokens.vera })).status, 403);

  // switched off: 404, and nothing is lost
  await setBroadcasts({ enabled: false });
  assert.equal((await call('GET', '/sales/broadcasts', { token: tokens.mona })).status, 404);
  assert.deepEqual(await runBroadcasts(IN_HOURS()), { skipped: 'switched off' });
  await setBroadcasts({ enabled: true });
  assert.ok(ok(await call('GET', '/sales/broadcasts', { token: tokens.mona })).broadcasts.length >= 6);
});

test('8: the enquiry form\'s tick box and the import column record opt-ins', async (t) => {
  if (skip(t)) return;
  const form = ok(await call('POST', '/sales/capture/forms', { token: tokens.admin, body: { name: 'Sample kit form', title: 'Ask about the kit', whatsapp_optin_text: 'Send me updates on WhatsApp' } }), 201).form;
  assert.equal(form.whatsapp_optin_text, 'Send me updates on WhatsApp');
  const page = await realFetch(`${baseUrl}/api/taskflow/s/f/${form.public_id}`);
  assert.match(await page.text(), /name="whatsapp_optin"/);
  const post = (fields) => realFetch(`${baseUrl}/api/taskflow/s/f/${form.public_id}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  await post({ name: 'Ira Sample', phone: '9800033001', who: 'INDIVIDUAL', whatsapp_optin: '1', submission_id: 's1' });
  await post({ name: 'Jai Sample', phone: '9800033002', who: 'INDIVIDUAL', submission_id: 's2' });
  const { rows: optins } = await query(`SELECT phone_normalized, how, note FROM crm_wa_optins WHERE phone_normalized IN ('919800033001', '919800033002') AND removed_at IS NULL`);
  assert.deepEqual(optins.map((o) => [o.phone_normalized, o.how, o.note]), [['919800033001', 'FORM', 'Send me updates on WhatsApp']], 'only the person who ticked it');

  const csv = ['Category,Contact name,Phone,WhatsApp opt-in', 'Retailer,Kavi Sample,9800044001,Yes', 'Retailer,Lata Sample,9800044002,No', 'Retailer,Manu Sample,9800044003,maybe'].join('\n');
  const up = ok(await call('POST', '/sales/imports?entity=LEADS&filename=sample.csv', { token: tokens.admin, rawBody: csv, contentType: 'text/csv' }), 201);
  assert.equal(up.job.mapping.whatsapp_optin, 'WhatsApp opt-in');
  assert.equal(up.job.mapping.phone, 'Phone', 'the phone column is still the phone');
  ok(await call('POST', `/sales/imports/${up.job.id}/validate`, { token: tokens.admin, body: { mapping: up.job.mapping, options: { duplicate_strategy: 'SKIP' } } }));
  const detail = ok(await call('GET', `/sales/imports/${up.job.id}`, { token: tokens.admin }));
  assert.ok(detail.rows.some((r) => (r.warnings || []).some((w) => /"maybe" is not yes or no/.test(w))));
  ok(await call('POST', `/sales/imports/${up.job.id}/run`, { token: tokens.admin }), 202);
  await processImports(); await processImports();
  const { rows: imported } = await query(`SELECT phone_normalized, how FROM crm_wa_optins WHERE phone_normalized LIKE '91980004400%' AND removed_at IS NULL`);
  assert.deepEqual(imported.map((o) => [o.phone_normalized, o.how]), [['919800044001', 'IMPORT']]);
});
