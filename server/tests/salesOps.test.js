/**
 * The sales CRM's communications, automation, imports, exports and reports:
 *
 *   H  calls and WhatsApp against a TEST double of the providers (no real
 *      provider is contacted): signed webhooks, statuses out of order,
 *      duplicates, failed sends and retries, opt-outs, restricted recordings
 *   F  automation: off and in test mode by default, live runs, loops, retries,
 *      a reply cancelling a scheduled message, overdue versus stale
 *   G  imports: mixed categories, leading zeros, duplicate external ids, a
 *      repeated upload, invalid rows and their corrections, undo that keeps
 *      later work; exports limited to permitted columns, formulas neutralised
 *   J  reports on a small known dataset, with drill-downs that reconcile and
 *      totals limited to what the person may see; scheduled reports sent once
 *      per period, each recipient's numbers within their own access
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { processEvents, runDue, scanTimers, evaluate } from '../src/services/sales/automation.js';
import { processImports } from '../src/services/sales/imports.js';
import { reportPeriod, sendScheduledReports } from '../src/services/sales/reports.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};

// ---- the TEST double for Meta's Graph API and recording downloads: every call is recorded
const realFetch = globalThis.fetch;
const graphCalls = [];
let graphMode = 'ok';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://graph.facebook.com/')) {
    graphCalls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
    if (u.includes('/message_templates')) {
      return new Response(JSON.stringify({ data: [
        { name: 'followup_reminder', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}}, following up on {{2}}.' }] },
        { name: 'draft_promo', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Promo' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (graphMode === 'fail') {
      return new Response(JSON.stringify({ error: { code: 131026, message: 'Message undeliverable', error_user_msg: 'Recipient is not a WhatsApp user' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.TEST${graphCalls.length}` }] }), { status: 200 });
  }
  if (u.startsWith('https://recordings.test.invalid/')) return new Response(Buffer.from('ID3-fake-audio'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  return realFetch(url, init);
};

const call = async (method, path, { token, body, headers = {}, raw = false, rawBody = null, contentType = 'application/json' } = {}) => {
  const res = await realFetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const day = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400000));
const sign = (secret, text) => `sha256=${crypto.createHmac('sha256', secret).update(text).digest('hex')}`;

const WA_SECRET = 'test-app-secret';
const CALL_SECRET = 'test-call-secret';
const waHook = (payload, secret = WA_SECRET) => {
  const text = JSON.stringify(payload);
  return call('POST', '/s/whatsapp', { rawBody: text, headers: { 'x-hub-signature-256': sign(secret, text) } });
};
const inbound = (from, id, text, ts = Math.floor(Date.now() / 1000)) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Priya' } }], messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }] });
const status = (id, s, ts) => ({ entry: [{ changes: [{ value: { statuses: [{ id, status: s, timestamp: String(ts) }] } }] }] });

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  Object.assign(process.env, {
    WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1000', WHATSAPP_BUSINESS_ACCOUNT_ID: '2000',
    WHATSAPP_APP_SECRET: WA_SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me', WHATSAPP_SANDBOX: 'true', CALL_WEBHOOK_SECRET: CALL_SECRET,
  });
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('SAL', 'Sales', '#2a78d6', 1), ('OPS', 'Operations', '#7c3aed', 2)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do','to-do','todo','#3b82f6',1,TRUE), ('Done','done','done','#22c55e',2,FALSE), ('Cancelled','cancelled','cancelled','#94a3b8',3,FALSE)`);
  const { rows: depts } = await query('SELECT id, key FROM departments');
  ids.sales = depts.find((d) => d.key === 'SAL').id;
  ids.ops = depts.find((d) => d.key === 'OPS').id;
  const password = await hashPassword('Password123!');
  for (const [key, name, role, dept, phone] of [
    ['admin', 'Asha Admin', 'admin', 'sales', null], ['manager', 'Vartika Head', 'manager', 'sales', '9800000001'],
    ['rupendra', 'Rupendra Rep', 'member', 'sales', '9800000002'], ['saumya', 'Saumya Rep', 'member', 'sales', '9800000003'],
    ['outsider', 'Omar Ops', 'member', 'ops', null],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, phone) VALUES ($1,$2,$3,$4,$5,FALSE,$6) RETURNING id`,
      [name, `ops-${key}@test.local`, password, role, ids[dept], phone],
    );
    ids[key] = rows[0].id;
  }
  const { rows: stages } = await query('SELECT id, slug FROM account_stages');
  for (const s of stages) ids[`stage_${s.slug.replace(/-/g, '_')}`] = s.id;
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'manager', 'rupendra', 'saumya', 'outsider']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `ops-${key}@test.local`, password: 'Password123!' } })).body.token;
  }
  // a lead with a phone, owned by Rupendra
  const r = await call('POST', '/sales/leads', { token: tokens.rupendra, body: { category: 'B2B_CORPORATE', organization_name: 'Coromandel Agro', contact_name: 'Priya Nair', phone: '9876543210', owner_user_id: ids.rupendra } });
  ids.lead = r.body.lead.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- H: WhatsApp

test('H: WhatsApp — the 24-hour window, templates, signed webhooks, statuses out of order, failures, retries and opt-outs', async (t) => {
  if (skip(t)) return;
  // the webhook handshake
  assert.equal((await call('GET', '/s/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345')).body, 12345);
  assert.equal((await call('GET', '/s/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  // health says what is connected, and that this is a sandbox number
  const health = ok(await call('GET', '/sales/integrations', { token: tokens.manager }));
  assert.equal(health.whatsapp.configured, true);
  assert.equal(health.whatsapp.sandbox, true);
  assert.equal(health.whatsapp.state, 'Awaiting live verification');
  assert.match(health.calling.manual.note, /tel: link/);

  // free text outside the window is refused; templates are synced, only approved ones send
  const closed = await call('POST', '/sales/whatsapp/send', { token: tokens.rupendra, body: { to: '9876543210', body: 'Hi', lead_id: ids.lead } });
  assert.equal(closed.status, 400);
  assert.equal(closed.body.details?.code, 'WINDOW_CLOSED');
  assert.equal(ok(await call('POST', '/sales/whatsapp/templates/sync', { token: tokens.admin })).synced, 2);
  assert.equal((await call('POST', '/sales/whatsapp/send', { token: tokens.rupendra, body: { to: '9876543210', template_name: 'draft_promo', language: 'en', lead_id: ids.lead } })).status, 400);
  assert.equal((await call('POST', '/sales/whatsapp/send', { token: tokens.rupendra, body: { to: '9876543210', template_name: 'followup_reminder', language: 'en', variables: ['Priya'], lead_id: ids.lead } })).status, 400, 'every variable is needed');
  const sent = ok(await call('POST', '/sales/whatsapp/send', {
    token: tokens.rupendra, body: { to: '9876543210', template_name: 'followup_reminder', language: 'en', variables: ['Priya', 'soil testing'], lead_id: ids.lead, idempotency_key: 'k1' },
  }), 201);
  assert.equal(sent.message.status, 'QUEUED', 'accepted by Meta is not "sent" until Meta says so');
  assert.equal(sent.message.body, 'Hello Priya, following up on soil testing.');
  assert.deepEqual(graphCalls.at(-1).body.template.components[0].parameters.map((p) => p.text), ['Priya', 'soil testing']);
  // the same idempotency key never sends twice
  const before = graphCalls.length;
  const again = ok(await call('POST', '/sales/whatsapp/send', { token: tokens.rupendra, body: { to: '9876543210', template_name: 'followup_reminder', language: 'en', variables: ['Priya', 'soil testing'], lead_id: ids.lead, idempotency_key: 'k1' } }));
  assert.equal(again.duplicate, true);
  assert.equal(graphCalls.length, before);

  // statuses arrive out of order and twice: read, then delivered, then sent
  const wamid = sent.message.provider_message_id;
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await waHook(status(wamid, 'read', now + 30), 'wrong-secret')).status, 401, 'an unsigned webhook is refused');
  ok(await waHook(status(wamid, 'read', now + 30)));
  ok(await waHook(status(wamid, 'delivered', now + 20)));
  const dup = ok(await waHook(status(wamid, 'delivered', now + 20)));
  assert.equal(dup.duplicates, 1);
  ok(await waHook(status(wamid, 'sent', now + 10)));
  const { rows: m } = await query('SELECT status, sent_at, delivered_at, read_at FROM crm_wa_messages WHERE id = $1', [sent.message.id]);
  assert.equal(m[0].status, 'READ', 'a late "sent" does not move it back');
  assert.ok(m[0].sent_at && m[0].delivered_at && m[0].read_at);

  // they reply: it lands on the lead's timeline, and the window opens for free text
  ok(await waHook(inbound('919876543210', 'wamid.IN1', 'Yes, call me after 4')));
  ok(await waHook(inbound('919876543210', 'wamid.IN1', 'Yes, call me after 4')), 200);
  const { rows: ins } = await query(`SELECT lead_id, status FROM crm_wa_messages WHERE direction = 'INBOUND'`);
  assert.deepEqual(ins, [{ lead_id: ids.lead, status: 'RECEIVED' }], 'once, on the right lead');
  const lead = ok(await call('GET', `/sales/leads/${ids.lead}`, { token: tokens.rupendra }));
  assert.ok(lead.timeline.some((e) => e.type === 'WHATSAPP' && e.direction === 'INBOUND'));
  const reply = ok(await call('POST', '/sales/whatsapp/send', { token: tokens.rupendra, body: { to: '9876543210', body: 'Will call at 4:30', lead_id: ids.lead } }), 201);
  assert.equal(reply.message.kind, 'TEXT');

  // a failed send says why; retrying it does not resend one Meta accepted
  graphMode = 'fail';
  const failed = ok(await call('POST', '/sales/whatsapp/send', { token: tokens.rupendra, body: { to: '9876543210', body: 'Are you there?', lead_id: ids.lead } }), 201);
  assert.equal(failed.message.status, 'FAILED');
  assert.match(failed.message.error_title, /not a WhatsApp user/);
  graphMode = 'ok';
  const retried = ok(await call('POST', `/sales/whatsapp/messages/${failed.message.id}/retry`, { token: tokens.rupendra }));
  assert.ok(retried.message.provider_message_id);
  assert.equal((await call('POST', `/sales/whatsapp/messages/${failed.message.id}/retry`, { token: tokens.rupendra })).status, 400);
  assert.equal((await call('POST', `/sales/whatsapp/messages/${sent.message.id}/retry`, { token: tokens.rupendra })).status, 400);

  // STOP opts them out; nothing more is sent
  ok(await waHook(inbound('919876543210', 'wamid.IN2', 'STOP')));
  const blocked = ok(await call('POST', '/sales/whatsapp/send', { token: tokens.rupendra, body: { to: '9876543210', template_name: 'followup_reminder', language: 'en', variables: ['P', 'x'], lead_id: ids.lead } }), 201);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.message.status, 'BLOCKED');

  // an unknown number writing in becomes a lead waiting for a category, not lost
  ok(await waHook(inbound('919111111111', 'wamid.IN3', 'Do you sell kits?')));
  const { rows: newLead } = await query(`SELECT category, destination FROM crm_leads WHERE phone_normalized = '919111111111'`);
  assert.deepEqual(newLead[0], { category: 'UNCLASSIFIED', destination: 'TRIAGE' });

  // someone outside the lead cannot read the conversation
  assert.equal((await call('GET', `/sales/whatsapp/conversation?lead_id=${ids.lead}`, { token: tokens.outsider })).status, 404);
});

// ---------------------------------------------------------------- H: calls

test('H: calls — a manual log with the next step, signed provider events in any order, unknown callers, private recordings', async (t) => {
  if (skip(t)) return;
  const logged = ok(await call('POST', '/sales/calls', {
    token: tokens.rupendra,
    body: { lead_id: ids.lead, phone: '9876543210', outcome: 'CONNECTED', notes: 'Wants a demo next week', duration_sec: 240, next: { kind: 'DEMO', due_at: new Date(Date.now() + 3 * 86400000).toISOString() } },
  }), 201);
  assert.equal(logged.call.logged_manually, true);
  assert.equal(logged.next.followup_kind, 'DEMO');
  assert.equal((await call('POST', '/sales/calls', { token: tokens.rupendra, body: { lead_id: ids.lead, outcome: 'CONNECTED' } })).status, 400, 'a connected call needs notes');

  // a provider's events, completed first and ringing late, each delivered twice
  const ev = (status, extra = {}) => ({ event_id: `ev-${status}`, call_id: 'PRV-1', direction: 'inbound', status, from: '+91 98765 43210', to: '+91 80000 00000', agent_email: 'ops-saumya@test.local', ...extra });
  const post = (b) => { const text = JSON.stringify(b); return call('POST', '/s/calls/hook', { rawBody: text, headers: { 'x-taskflow-signature': sign(CALL_SECRET, text) } }); };
  assert.equal((await call('POST', '/s/calls/hook', { body: ev('completed') })).status, 401);
  ok(await post(ev('completed', { duration_sec: 95, started_at: new Date(Date.now() - 120000).toISOString(), recording_url: 'https://recordings.test.invalid/a.mp3' })));
  assert.equal(ok(await post(ev('completed', { duration_sec: 95 }))).duplicate, true);
  ok(await post(ev('ringing')));
  const { rows: calls } = await query(`SELECT * FROM crm_calls WHERE provider = 'call-webhook'`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 'COMPLETED');
  assert.equal(calls[0].lead_id, ids.lead, 'matched to the lead by phone');
  assert.equal(calls[0].agent_user_id, ids.saumya);
  const { rows: timeline } = await query(`SELECT COUNT(*)::int AS n FROM crm_lead_activities WHERE call_id = $1`, [calls[0].id]);
  assert.equal(timeline[0].n, 1, 'on the timeline once');

  // recordings: the agent and people with the permission, nobody else
  const agent = await call('GET', `/sales/calls/${calls[0].id}/recording`, { token: tokens.saumya, raw: true });
  assert.equal(agent.status, 200);
  assert.equal(agent.buffer.toString(), 'ID3-fake-audio');
  assert.equal((await call('GET', `/sales/calls/${calls[0].id}/recording`, { token: tokens.rupendra, raw: true })).status, 403);
  assert.equal((await call('GET', `/sales/calls/${calls[0].id}/recording`, { token: tokens.manager, raw: true })).status, 200);
  const list = ok(await call('GET', '/sales/calls', { token: tokens.rupendra }));
  assert.ok(!JSON.stringify(list).includes('recordings.test.invalid'), 'the provider link never leaves the server');

  // an unknown caller becomes a lead to classify
  ok(await post({ event_id: 'ev-x', call_id: 'PRV-2', direction: 'inbound', status: 'no-answer', from: '+91 90000 11111' }));
  const { rows: caller } = await query(`SELECT destination FROM crm_leads WHERE phone_normalized = '919000011111'`);
  assert.equal(caller[0].destination, 'TRIAGE');

  // click-to-call without Exotel configured says so plainly
  const ctc = await call('POST', '/sales/calls/click-to-call', { token: tokens.rupendra, body: { phone: '9876543210', lead_id: ids.lead } });
  assert.equal(ctc.status, 409);
  assert.match(ctc.body.error, /EXOTEL_ACCOUNT_SID/);
});

// ---------------------------------------------------------------- F: automation

test('F: automation is off until switched on, simulates in test mode, runs once, cannot loop, and stops on a reply', async (t) => {
  if (skip(t)) return;
  assert.equal(evaluate({ category: 'B2B_CORPORATE', score: 40 }, [{ field: 'score', op: 'gte', value: 50 }]).ok, false);
  assert.equal((await call('POST', '/sales/automation/rules', { token: tokens.manager, body: { name: 'x', trigger: 'lead.captured', actions: [{ type: 'notify' }] } })).status, 403);
  const rule = ok(await call('POST', '/sales/automation/rules', {
    token: tokens.admin,
    body: { name: 'Call new corporate leads', trigger: 'lead.captured', conditions: [{ field: 'category', op: 'eq', value: 'B2B_CORPORATE' }],
      actions: [{ type: 'create_followup', kind: 'CALL', due_in_hours: 2, title: 'First call: {{name}}' }, { type: 'notify', to: 'owner', title: 'New lead {{ref}}' }] },
  }), 201).rule;
  assert.equal(rule.is_enabled, false);
  assert.equal(rule.test_mode, true);

  const mk = async (name) => ok(await call('POST', '/sales/leads', { token: tokens.rupendra, body: { category: 'B2B_CORPORATE', organization_name: name, contact_name: 'A', owner_user_id: ids.rupendra } }), 201).lead;
  await mk('Before Rule Ltd');
  await processEvents();
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_automation_runs')).rows[0].n, 0, 'a switched-off rule schedules nothing');

  // on, in test mode: it records what it would do and changes nothing
  ok(await call('PATCH', `/sales/automation/rules/${rule.id}`, { token: tokens.admin, body: { is_enabled: true } }));
  const l1 = await mk('Test Mode Ltd');
  await processEvents();
  await runDue();
  const { rows: sim } = await query('SELECT status, result FROM crm_automation_runs WHERE entity_id = $1', [l1.id]);
  assert.equal(sim[0].status, 'SIMULATED');
  assert.match(JSON.stringify(sim[0].result), /would/);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM tasks WHERE crm_lead_id = $1', [l1.id])).rows[0].n, 0);

  // live: one follow-up, once, however often the worker runs
  ok(await call('PATCH', `/sales/automation/rules/${rule.id}`, { token: tokens.admin, body: { test_mode: false } }));
  const l2 = await mk('Live Ltd');
  await processEvents(); await processEvents();
  await runDue(); await runDue();
  const { rows: live } = await query('SELECT status FROM crm_automation_runs WHERE entity_id = $1', [l2.id]);
  assert.deepEqual(live.map((r) => r.status), ['DONE']);
  const { rows: tasks } = await query('SELECT title, followup_kind, automation_run_id FROM tasks WHERE crm_lead_id = $1', [l2.id]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'First call: Live Ltd');

  // a rule that reacts to assignment by reassigning cannot loop
  const loop = ok(await call('POST', '/sales/automation/rules', {
    token: tokens.admin, body: { name: 'Ping-pong', trigger: 'lead.reassigned', actions: [{ type: 'assign', user_id: ids.saumya }] },
  }), 201).rule;
  ok(await call('PATCH', `/sales/automation/rules/${loop.id}`, { token: tokens.admin, body: { is_enabled: true, test_mode: false } }));
  const l3 = await mk('Loop Ltd');
  ok(await call('POST', `/sales/leads/${l3.id}/assign`, { token: tokens.manager, body: { user_id: ids.manager, reason: 'test' } }));
  for (let i = 0; i < 6; i += 1) { await processEvents(); await runDue(); }
  const { rows: loopRuns } = await query('SELECT COUNT(*)::int AS n FROM crm_automation_runs WHERE rule_id = $1', [loop.id]);
  assert.equal(loopRuns[0].n, 1, 'its own reassignment does not trigger it again');
  ok(await call('PATCH', `/sales/automation/rules/${loop.id}`, { token: tokens.admin, body: { is_enabled: false } }));

  // a delayed WhatsApp nudge is cancelled when they reply; and live sends need the setting
  const nudge = ok(await call('POST', '/sales/automation/rules', {
    token: tokens.admin,
    body: { name: 'Nudge after a day', trigger: 'lead.captured', delay_minutes: 1440, cancel_on: ['reply', 'terminal'],
      actions: [{ type: 'send_whatsapp_template', template_name: 'followup_reminder', variables: ['{{contact_name}}', 'your enquiry'] }] },
  }), 201).rule;
  assert.equal((await call('PATCH', `/sales/automation/rules/${nudge.id}`, { token: tokens.admin, body: { is_enabled: true, test_mode: false } })).status, 400, 'live sends are off');
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { automation: { liveSends: true } } }));
  ok(await call('PATCH', `/sales/automation/rules/${nudge.id}`, { token: tokens.admin, body: { is_enabled: true, test_mode: false } }));
  const l4 = ok(await call('POST', '/sales/leads', { token: tokens.rupendra, body: { category: 'B2B_CORPORATE', organization_name: 'Reply Ltd', contact_name: 'Ravi', phone: '9822222222', owner_user_id: ids.rupendra } }), 201).lead;
  await processEvents();
  ok(await waHook(inbound('919822222222', 'wamid.R1', 'Got your call, thanks')));
  const { rows: cancelled } = await query('SELECT status, cancelled_reason FROM crm_automation_runs WHERE rule_id = $1 AND entity_id = $2', [nudge.id, l4.id]);
  assert.deepEqual(cancelled[0], { status: 'CANCELLED', cancelled_reason: 'They replied on WhatsApp' });

  // switching a rule off cancels what it had scheduled
  const l5 = await mk('Scheduled Ltd');
  await processEvents();
  ok(await call('PATCH', `/sales/automation/rules/${nudge.id}`, { token: tokens.admin, body: { is_enabled: false } }));
  const { rows: off } = await query('SELECT status FROM crm_automation_runs WHERE rule_id = $1 AND entity_id = $2', [nudge.id, l5.id]);
  assert.equal(off[0].status, 'CANCELLED');
  ok(await call('PUT', '/sales/settings', { token: tokens.admin, body: { automation: { liveSends: false } } }));
  ok(await call('PATCH', `/sales/automation/rules/${rule.id}`, { token: tokens.admin, body: { is_enabled: false } }));
});

test('F: overdue follow-ups and stale leads are different, each escalated once', async (t) => {
  if (skip(t)) return;
  const lead = ok(await call('POST', '/sales/leads', { token: tokens.rupendra, body: { category: 'B2B_CORPORATE', organization_name: 'Quiet Co', contact_name: 'Q', owner_user_id: ids.rupendra } }), 201).lead;
  const task = ok(await call('POST', '/sales/followups', { token: tokens.rupendra, body: { lead_id: lead.id, kind: 'CALL', due_at: new Date(Date.now() + 3600_000).toISOString() } }), 201).task;
  // time passes: the follow-up is two days overdue, and nobody has spoken to them for ten days
  await query(`UPDATE tasks SET due_date = now() - interval '2 days', reminder_at = now() - interval '2 days' WHERE id = $1`, [task.id]);
  await query(`UPDATE crm_leads SET captured_at = now() - interval '10 days' WHERE id = $1`, [lead.id]);
  const first = await scanTimers(new Date());
  assert.ok(first.overdue >= 1);
  assert.ok(first.stale_leads >= 1);
  const second = await scanTimers(new Date());
  assert.equal(second.overdue, 0, 'escalated once');
  assert.equal(second.stale_leads, 0, 'flagged once per quiet spell');
  const { rows: notes } = await query(`SELECT type, user_id FROM notifications WHERE type IN ('crm_escalation','crm_stale') AND (task_id = $1 OR crm_lead_id = $2)`, [task.id, lead.id]);
  assert.ok(notes.some((n) => n.type === 'crm_escalation' && n.user_id === ids.manager), 'the manager hears about the overdue follow-up');
  assert.ok(notes.some((n) => n.type === 'crm_stale' && n.user_id === ids.rupendra), 'the owner hears the lead went quiet');
});

// ---------------------------------------------------------------- G: imports and exports

const csv = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'));

test('G: an import with mixed categories, duplicates and bad rows; a repeat upload; corrections; undo that keeps later work', async (t) => {
  if (skip(t)) return;
  const template = await call('GET', '/sales/imports/template?entity=LEADS', { token: tokens.manager, raw: true });
  assert.equal(template.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template.buffer);
  assert.equal(wb.worksheets[0].getRow(1).getCell(1).value, 'Category');

  const file = csv([
    ['Category', 'Organization', 'Contact name', 'Email', 'Phone', 'Source', 'External ID', 'Owner email', 'Captured at'],
    ['B2B Corporate', 'Nagarjuna Fertilisers', 'Kiran', 'kiran@nfcl.example', '09848012345', 'Google Ads', 'G-1', 'ops-saumya@test.local', '2026-09-01'],
    ['CSR/NGO', 'Tata Trusts Agri', 'Meera', 'meera@trusts.example', '+91 99000 11111', 'Referral', 'G-2', '', ''],
    ['Retailer', 'Shree Krishi Kendra', 'Mahesh', '', '09811100099', 'Inbound call', 'G-3', '', ''],
    ['B2B Corporate', 'Nagarjuna Fertilisers', 'Kiran again', 'kiran@nfcl.example', '', '', 'G-1', '', ''],
    ['B2B Corporate', '', 'No Org', 'noorg@example.com', '', '', 'G-5', '', ''],
    ['B2B Corporate', 'Bad Owner Ltd', 'Bo', 'bo@bad.example', '', '', 'G-6', 'nobody@nowhere.example', ''],
  ]);
  const up = ok(await call('POST', '/sales/imports?entity=LEADS&filename=leads.csv', { token: tokens.manager, rawBody: file, contentType: 'text/csv' }), 201);
  assert.equal(up.job.total_rows, 6);
  assert.equal(up.job.mapping.phone, 'Phone');
  assert.equal((await call('POST', '/sales/imports?entity=LEADS', { token: tokens.rupendra, rawBody: file, contentType: 'text/csv' })).status, 403, 'importing needs the permission');

  const counts = ok(await call('POST', `/sales/imports/${up.job.id}/validate`, { token: tokens.manager, body: { mapping: up.job.mapping, options: { duplicate_strategy: 'SKIP' } } })).counts;
  assert.deepEqual({ valid: counts.valid, invalid: counts.invalid, duplicate: counts.duplicate, routed: counts.routed }, { valid: 2, invalid: 2, duplicate: 1, routed: 1 });
  const detail = ok(await call('GET', `/sales/imports/${up.job.id}`, { token: tokens.manager }));
  const bad = detail.rows.filter((r) => r.status === 'INVALID');
  assert.ok(bad.some((r) => r.errors.join(' ').match(/organization/i)));
  assert.ok(bad.some((r) => r.errors.join(' ').match(/not a TaskFlow user/)));

  ok(await call('POST', `/sales/imports/${up.job.id}/run`, { token: tokens.manager }), 202);
  await processImports(); await processImports();
  const job = ok(await call('GET', `/sales/imports/${up.job.id}`, { token: tokens.manager })).job;
  assert.equal(job.status, 'DONE');
  assert.deepEqual(job.counts.result, { imported: 2, routed: 1, skipped: 1, invalid: 2 });
  const { rows: imported } = await query(`SELECT l.phone, l.owner_user_id, l.entry_channel, s.key AS source, l.captured_at FROM crm_leads l LEFT JOIN crm_sources s ON s.id = l.original_source_id WHERE l.external_id = 'G-1'`);
  assert.equal(imported[0].phone, '09848012345', 'the leading zero survives');
  assert.equal(imported[0].owner_user_id, ids.saumya);
  assert.equal(imported[0].entry_channel, 'IMPORT');
  assert.equal(imported[0].source, 'google-ads', 'the original source is kept, not replaced by "import"');
  assert.equal(new Date(imported[0].captured_at).toISOString().slice(0, 10), '2026-09-01');
  const { rows: routed } = await query(`SELECT destination FROM crm_leads WHERE external_id = 'G-3'`);
  assert.equal(routed[0].destination, 'TELECRM');

  // the corrections file lists the two bad rows with reasons
  const fix = await call('GET', `/sales/imports/${up.job.id}/corrections?format=CSV`, { token: tokens.manager, raw: true });
  const text = fix.buffer.toString();
  assert.match(text, /not a TaskFlow user/);
  assert.match(text, /Bad Owner Ltd/);

  // the same file again: everything already there is a duplicate, nothing is imported twice
  const again = ok(await call('POST', '/sales/imports?entity=LEADS&filename=leads.csv', { token: tokens.manager, rawBody: file, contentType: 'text/csv' }), 201);
  assert.match(again.warnings.join(' '), /imported before/);
  const c2 = ok(await call('POST', `/sales/imports/${again.job.id}/validate`, { token: tokens.manager, body: { mapping: again.job.mapping } })).counts;
  assert.equal(c2.valid, 0);
  assert.equal(c2.duplicate, 4);

  // someone works one imported lead; undo archives the other and keeps that one
  const { rows: g2 } = await query(`SELECT id FROM crm_leads WHERE external_id = 'G-2'`);
  ok(await call('POST', `/sales/leads/${g2[0].id}/activities`, { token: tokens.admin, body: { type: 'CALL', direction: 'OUTBOUND', outcome: 'COMPLETED', subject: 'Spoke to Meera' } }), 201);
  const undo = ok(await call('POST', `/sales/imports/${up.job.id}/undo`, { token: tokens.manager })).summary;
  assert.equal(undo.archived, 2, 'G-1 and the routed G-3');
  assert.equal(undo.kept, 1);
  assert.match(JSON.stringify(undo.reasons), /worked on since/);
  const { rows: after } = await query(`SELECT external_id, is_archived FROM crm_leads WHERE external_id IN ('G-1','G-2','G-3') ORDER BY external_id`);
  assert.deepEqual(after.map((r) => [r.external_id, r.is_archived]), [['G-1', true], ['G-2', false], ['G-3', true]]);
  assert.equal((await call('POST', `/sales/imports/${up.job.id}/undo`, { token: tokens.manager })).status, 409);
});

test('G: exports carry only what the person may see and the columns they may take; formulas are neutralised', async (t) => {
  if (skip(t)) return;
  ok(await call('POST', '/sales/leads', { token: tokens.rupendra, body: { category: 'B2B_CORPORATE', organization_name: '=HYPERLINK("http://evil.example","x")', contact_name: 'F', email: 'f@formula.example', owner_user_id: ids.rupendra } }), 201);
  assert.equal((await call('GET', '/sales/exports/leads?format=CSV&view=all', { token: tokens.rupendra, raw: true })).status, 403, 'members do not export');
  const mgr = (await call('GET', '/sales/exports/leads?format=CSV&view=all', { token: tokens.manager, raw: true })).buffer.toString();
  assert.ok(!/Email|Phone/.test(mgr.split('\r\n')[0]), 'no contact columns without the sensitive-export permission');
  assert.match(mgr, /'=HYPERLINK/);
  const adm = (await call('GET', '/sales/exports/leads?format=CSV&view=all', { token: tokens.admin, raw: true })).buffer.toString();
  assert.match(adm.split('\r\n')[0], /Email/);
  const { rows: audit } = await query(`SELECT COUNT(*)::int AS n FROM crm_audit_events WHERE action = 'CRM_EXPORT'`);
  assert.ok(audit[0].n >= 2);
});

// ---------------------------------------------------------------- J: reports

test('J: reports on a known dataset reconcile with their drill-downs, keep currencies and CSR apart, and respect access', async (t) => {
  if (skip(t)) return;
  // a fresh month of data in a separate team, owned by Saumya
  const from = day(0);
  const mkDeal = async (name, body = {}) => {
    const acc = ok(await call('POST', '/accounts', { token: tokens.manager, body: { name, lead_category: body.csr ? 'CSR_NGO' : 'B2B_CORPORATE', owner_user_id: ids.saumya, department_id: ids.sales } }), 201).account;
    const d = ok(await call('POST', '/opportunities', { token: tokens.manager, body: { account_id: acc.id, name: `${name} deal`, owner_user_id: ids.saumya, estimated_value: body.value ?? 100000, currency: body.currency || 'INR', probability: body.probability ?? 50, next_step: 'Call', next_step_owner_id: ids.saumya, next_step_due: day(5), ...(body.csr ? { requested_amount: body.value } : {}) } }), 201).opportunity;
    return d;
  };
  const won1 = await mkDeal('R-Won One', { value: 200000 });
  const won2 = await mkDeal('R-Won USD', { value: 5000, currency: 'USD' });
  const lost = await mkDeal('R-Lost', { value: 50000 });
  await mkDeal('R-Open', { value: 300000, probability: 40 });
  const csr = await mkDeal('R-CSR', { value: 1000000, csr: true });
  const order = (amount) => ({ reference: `PO-${amount}`, received_on: day(0), amount });
  ok(await call('POST', `/opportunities/${won1.id}/stage`, { token: tokens.manager, body: { stage_id: ids.stage_won, order: order(180000), override_reason: 'Report fixture: moving straight to won' } }));
  ok(await call('POST', `/opportunities/${won2.id}/stage`, { token: tokens.manager, body: { stage_id: ids.stage_won, order: order(5000), override_reason: 'Report fixture: moving straight to won' } }));
  ok(await call('POST', `/opportunities/${lost.id}/stage`, { token: tokens.manager, body: { stage_id: ids.stage_lost, outcome_reason: 'Price' } }));
  ok(await call('PATCH', `/opportunities/${csr.id}`, { token: tokens.manager, body: { committed_amount: 800000 } }));
  ok(await call('POST', `/opportunities/${csr.id}/stage`, { token: tokens.manager, body: { stage_id: ids.stage_csr_won, order: { kind: 'MOU', reference: 'MOU-1', received_on: day(0), amount: 800000 }, override_reason: 'Report fixture: moving straight to won' } }));
  ok(await call('POST', `/sales/opportunities/${won1.id}/receipts`, { token: tokens.manager, body: { received_on: day(0), amount: '100000', reference: 'R-UTR-1' } }), 201);
  ok(await call('POST', `/sales/opportunities/${csr.id}/receipts`, { token: tokens.manager, body: { received_on: day(0), amount: '300000', reference: 'R-UTR-2' } }), 201);

  const q = `from=${from}&to=${from}&owner_id=${ids.saumya}`;
  const s = ok(await call('GET', `/sales/reports/summary?${q}`, { token: tokens.admin }));
  // independently: won = 3 (INR B2B, USD B2B, CSR); lost = 1; win rate 3/4
  assert.equal(s.outcomes.won, 3);
  assert.equal(s.outcomes.lost, 1);
  assert.equal(s.outcomes.win_rate, 75);
  assert.equal(s.outcomes.commercial_bookings, '180000.00', 'INR only; the USD deal is not added in');
  assert.equal(s.outcomes.csr_committed, '800000.00', 'CSR commitments are their own number');
  assert.equal(s.money.commercial_receipts, '100000.00');
  assert.equal(s.money.csr_receipts, '300000.00');
  assert.deepEqual(s.other_currencies, ['USD']);
  assert.equal(s.pipeline.value, '300000.00');
  assert.equal(s.pipeline.weighted_forecast, '120000.00', '300000 × 40%');
  assert.ok(s.unavailable.pipeline_as_of_past_dates);

  // drill-downs list exactly the records behind the numbers
  const wonRows = ok(await call('GET', `/sales/reports/drill?metric=won&${q}`, { token: tokens.admin })).rows;
  assert.equal(wonRows.length, s.outcomes.won);
  const lostRows = ok(await call('GET', `/sales/reports/drill?metric=lost&${q}`, { token: tokens.admin })).rows;
  assert.equal(lostRows.length, 1);

  // the same report for someone who cannot see Saumya's deals counts nothing
  const outsider = ok(await call('GET', `/sales/reports/summary?${q}`, { token: tokens.outsider }));
  assert.equal(outsider.outcomes.won, 0);
  assert.equal(outsider.outcomes.commercial_bookings, null);
  assert.equal(ok(await call('GET', `/sales/reports/drill?metric=won&${q}`, { token: tokens.outsider })).rows.length, 0);

  // stage, source and people reports answer
  ok(await call('GET', `/sales/reports/stages?${q}`, { token: tokens.admin }));
  ok(await call('GET', `/sales/reports/sources?${q}`, { token: tokens.admin }));
  const people = ok(await call('GET', `/sales/reports/agents?${q}`, { token: tokens.admin }));
  assert.equal(people.rows.find((r) => r.id === ids.saumya).won, 3);
});

test('J: a scheduled report reaches each recipient once per period, with numbers limited to what they may see', async (t) => {
  if (skip(t)) return;
  // periods are the last complete day, Monday–Sunday week and calendar month
  assert.deepEqual(reportPeriod('DAILY', '2026-10-30'), { start: '2026-10-30', from: '2026-10-29', to: '2026-10-29' });
  assert.deepEqual(reportPeriod('WEEKLY', '2026-10-30'), { start: '2026-10-26', from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(reportPeriod('WEEKLY', '2026-10-26'), { start: '2026-10-26', from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(reportPeriod('MONTHLY', '2026-03-01'), { start: '2026-03-01', from: '2026-02-01', to: '2026-02-28' });

  const body = { name: 'Saumya daily', report: 'summary', frequency: 'DAILY', recipient_ids: [ids.admin, ids.outsider, ids.rupendra], filters: { owner_id: ids.saumya } };
  assert.equal((await call('POST', '/sales/report-schedules', { token: tokens.rupendra, body })).status, 403, 'only CRM settings may schedule');
  const schedule = ok(await call('POST', '/sales/report-schedules', { token: tokens.admin, body }), 201).schedule;
  const list = ok(await call('GET', '/sales/report-schedules', { token: tokens.admin })).schedules;
  assert.deepEqual(list.find((x) => x.id === schedule.id).recipients.map((r) => r.id).sort(), [ids.admin, ids.outsider, ids.rupendra].sort());

  // tomorrow's run reports today, where test J left a known set of Saumya's deals
  const tomorrow = new Date(Date.now() + 86400000);
  const notices = async (userId) => (await query(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'crm_report' ORDER BY id`, [userId])).rows;
  assert.equal(await sendScheduledReports(tomorrow), 3);
  const [admin] = await notices(ids.admin);
  assert.match(admin.title, /^Saumya daily: /);
  assert.match(admin.body, /3 won, 1 lost/);
  assert.match(admin.body, /bookings ₹1,80,000/, 'INR bookings only; the USD deal is not added in');
  const [outsider] = await notices(ids.outsider);
  assert.match(outsider.body, /0 won, 0 lost/, 'someone who cannot see Saumya\'s deals is told nothing about them');
  assert.doesNotMatch(outsider.body, /bookings/);
  const [rep] = await notices(ids.rupendra);
  assert.match(rep.body, /0 won/, 'a sales agent sees only their own records by default');

  // the same period is not sent twice; a paused schedule sends nothing
  assert.equal(await sendScheduledReports(tomorrow), 0);
  assert.equal((await notices(ids.admin)).length, 1);
  ok(await call('PATCH', `/sales/report-schedules/${schedule.id}`, { token: tokens.admin, body: { is_enabled: false } }));
  assert.equal(await sendScheduledReports(new Date(Date.now() + 2 * 86400000)), 0);

  // the timer scan is what sends them
  ok(await call('PATCH', `/sales/report-schedules/${schedule.id}`, { token: tokens.admin, body: { is_enabled: true } }));
  const scan = await scanTimers(new Date(Date.now() + 2 * 86400000));
  assert.equal(scan.reports_sent, 3);
});
