/**
 * Linked records (Part D) and the meeting and deal rules (Part E3, E4).
 * Numbers refer to the build prompt's tests (section 8).
 *
 *   23  original source, introduced by, assigned by and owner are kept and
 *       shown apart; reassignment keeps the source and the history
 *   24  a deal with no dated next action is flagged; finishing its tracked
 *       action asks for the next one and never closes the deal
 *   25  our calls never move a lead's last-incoming time
 *   27  a meeting to arrange has no start reminder; confirming plans the
 *       preparation and start reminders; rescheduling and cancelling remove
 *       the old ones; the migration changed no existing meeting
 *   C8  a deal changing hands lists the work owned by others; nothing moves
 *       until chosen
 *   D5  an internal meeting (no organisation) for anyone, without the CRM
 *
 * Made-up people and records only.
 */
import test, { before, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool, withTransaction } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { getSettings, updateSetting } from '../src/services/settings.js';
import { planSweep, replanRecord, sendDueOccurrences } from '../src/services/workspace/reminders.js';
import '../src/services/workspace/rules.js';
import { logLeadActivity } from '../src/services/sales/leads.js';
import { attentionFor } from '../src/services/workspace/attention.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};

const IST = (date, hm = '09:00') => new Date(`${date}T${hm}:00+05:30`);
const call = async (method, p, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const occ = async (type, id) => (await query(`SELECT * FROM reminder_occurrences WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`, [type, id])).rows;
const user = async (key) => (await query('SELECT * FROM users WHERE id = $1', [ids[key]])).rows[0];

let fingerprintBefore = null;
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  // migrate up to 036 (as the live site stands), put meetings in, then run 037: they must not change
  await query(`CREATE SCHEMA "${config.db.schema}"`);
  await query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql') && f < '037').sort()) {
    await query('BEGIN');
    await query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await query('COMMIT');
  }
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('PRG', 'Programmes', '#2a78d6', 1)`);
  ids.prg = (await query(`SELECT id FROM departments WHERE key = 'PRG'`)).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  const password = await hashPassword('Password123!');
  for (const [key, role] of [['admin', 'admin'], ['vera', 'member'], ['omar', 'member'], ['tara', 'member'], ['nina', 'viewer']]) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.rc@test.local`, password, role, ids.prg],
    );
    ids[key] = rows[0].id;
  }
  ids.acc = (await query(`INSERT INTO accounts (name, owner_user_id) VALUES ('Sample Cooperative', $1) RETURNING id`, [ids.vera])).rows[0].id;
  await query(`INSERT INTO crm_meetings (account_id, title, scheduled_at, first_scheduled_at, owner_user_id, created_by, status) VALUES
    ($1, 'Sample existing review', '2026-12-02T05:30:00Z', '2026-12-02T05:30:00Z', $2, $2, 'SCHEDULED'),
    ($1, 'Sample past demo', '2026-10-02T05:30:00Z', '2026-10-02T05:30:00Z', $2, $2, 'COMPLETED')`, [ids.acc, ids.vera]);
  fingerprintBefore = (await query('SELECT * FROM crm_meetings ORDER BY id')).rows;
  await runMigrations({ verbose: false });
  await updateSetting('workspace', { ...(await getSettings()).workspace, reminderMode: 'LIVE' }, ids.admin);
  await planSweep({ now: IST('2026-11-14') });
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'vera', 'omar', 'tara', 'nina']) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.rc@test.local`, password: 'Password123!' } })).token;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('27: the migration changed no existing meeting; a meeting to arrange has no start reminder; confirming plans prep and start; moving and cancelling remove the old ones', async (t) => {
  if (skip(t)) return;
  const now = (await query('SELECT * FROM crm_meetings WHERE id = ANY($1::int[]) ORDER BY id', [fingerprintBefore.map((m) => m.id)])).rows;
  for (let i = 0; i < now.length; i += 1) {
    for (const [k, v] of Object.entries(fingerprintBefore[i])) assert.deepEqual(now[i][k], v, `meeting ${now[i].id}: ${k}`);
  }
  // to arrange: no time, so the API refuses one
  const bad = await call('POST', '/workspace/meetings', { token: tokens.vera, body: { title: 'Sample pitch', status: 'TO_ARRANGE', scheduled_at: '2027-01-12T05:30:00Z' } });
  assert.equal(bad.status, 400);
  const m = ok(await call('POST', '/workspace/meetings', { token: tokens.vera, body: {
    title: 'Sample pitch to the fund', status: 'TO_ARRANGE', arrange_by: '2027-01-08', account_id: ids.acc, participant_user_ids: [ids.omar],
  } }), 201).meeting;
  assert.equal(m.scheduled_at, null);
  assert.equal(m.unconfirmed, true);
  assert.equal(m.is_upcoming, false, 'never shown as booked');
  await replanRecord('MEETING', m.id, { now: IST('2026-12-01') });
  assert.deepEqual((await occ('MEETING', m.id)).map((o) => `${o.rule_key}:${o.recipient_id === ids.vera ? 'vera' : 'other'}`), ['MEETING_TO_ARRANGE:vera'], 'only the person arranging it, on the arrange-by date');
  // a time proposed, then confirmed for 12 Jan 2027 11:00 IST
  ok(await call('POST', `/workspace/meetings/${m.id}/propose`, { token: tokens.vera, body: { proposed_at: '2027-01-12T05:30:00Z' } }));
  ok(await call('POST', `/workspace/meetings/${m.id}/confirm`, { token: tokens.vera, body: { scheduled_at: '2027-01-12T05:30:00Z', timezone: 'Asia/Kolkata' } }));
  await replanRecord('MEETING', m.id, { now: IST('2026-12-01') });
  let rows = (await occ('MEETING', m.id)).filter((o) => o.status === 'PENDING');
  const plan = rows.map((o) => `${o.rule_key}:${o.recipient_id === ids.vera ? 'vera' : 'omar'}:${new Date(o.remind_at).toISOString()}`).sort();
  assert.deepEqual(plan, [
    `MEETING_PREP:omar:${IST('2027-01-11').toISOString()}`, `MEETING_PREP:vera:${IST('2027-01-11').toISOString()}`,
    `MEETING_START:omar:${IST('2027-01-12', '10:30').toISOString()}`, `MEETING_START:vera:${IST('2027-01-12', '10:30').toISOString()}`,
  ], 'the owner and the colleague taking part; prep the day before, start 30 minutes before');
  assert.equal((await occ('MEETING', m.id)).find((o) => o.rule_key === 'MEETING_TO_ARRANGE').status, 'CANCELLED');
  // moved to 13 Jan: the old ones are cancelled
  ok(await call('POST', `/workspace/meetings/${m.id}/reschedule`, { token: tokens.vera, body: { scheduled_at: '2027-01-13T05:30:00Z' } }));
  await replanRecord('MEETING', m.id, { now: IST('2026-12-01') });
  rows = await occ('MEETING', m.id);
  assert.ok(rows.filter((o) => o.occurrence_key.includes('2027-01-12')).every((o) => o.status === 'CANCELLED'));
  assert.equal(rows.filter((o) => o.occurrence_key.includes('2027-01-13') && o.status === 'PENDING').length, 4);
  // sent at the right times, once
  assert.equal((await sendDueOccurrences(IST('2027-01-12', '09:00'))).sent, 2);
  assert.equal((await sendDueOccurrences(IST('2027-01-13', '10:30'))).sent, 2);
  const n = (await query(`SELECT title, user_id FROM notifications WHERE entity_type = 'MEETING' AND entity_id = $1 ORDER BY id`, [m.id])).rows;
  assert.deepEqual(n.map((x) => x.title), ['Meeting tomorrow: Sample pitch to the fund', 'Meeting tomorrow: Sample pitch to the fund', 'Starts in 30 minutes: Sample pitch to the fund', 'Starts in 30 minutes: Sample pitch to the fund']);
  // cancelled: nothing left
  const m2 = ok(await call('POST', '/workspace/meetings', { token: tokens.vera, body: { title: 'Sample site visit', scheduled_at: '2027-02-01T05:30:00Z', account_id: ids.acc } }), 201).meeting;
  await replanRecord('MEETING', m2.id, { now: IST('2026-12-01') });
  ok(await call('POST', `/workspace/meetings/${m2.id}/cancel`, { token: tokens.vera, body: { reason: 'The visit moved to next quarter' } }));
  assert.ok((await occ('MEETING', m2.id)).every((o) => o.status === 'CANCELLED'));
});

test('D5: an internal meeting needs no organisation and no CRM; people outside it cannot see it', async (t) => {
  if (skip(t)) return;
  await query(`UPDATE users SET revoked_permissions = ARRAY['crm.view'] WHERE id = $1`, [ids.tara]);
  const m = ok(await call('POST', '/workspace/meetings', { token: tokens.tara, body: { title: 'Sample planning huddle', status: 'TO_ARRANGE', arrange_by: '2026-11-20', participant_user_ids: [ids.omar] } }), 201).meeting;
  assert.equal(m.account_id, null);
  const mine = ok(await call('GET', '/workspace/meetings', { token: tokens.tara }));
  assert.ok(mine.to_arrange.some((x) => x.id === m.id));
  assert.match(mine.note, /No invitation is sent/);
  assert.equal((await call('GET', `/workspace/meetings/${m.id}`, { token: tokens.omar })).status, 200, 'a colleague taking part can see it');
  assert.equal((await call('GET', `/workspace/meetings/${m.id}`, { token: tokens.nina })).status, 404, 'someone else cannot');
  // linking a meeting to a CRM record still needs the CRM
  assert.equal((await call('POST', '/workspace/meetings', { token: tokens.tara, body: { title: 'Sample linked', status: 'TO_ARRANGE', account_id: ids.acc } })).status, 403);
  await query(`UPDATE users SET revoked_permissions = '{}' WHERE id = $1`, [ids.tara]);
});

test('25: our calls, answered or not, never move a lead\'s last incoming time; their call does', async (t) => {
  if (skip(t)) return;
  const lead = (await query(`INSERT INTO crm_leads (ref, organization_name, owner_user_id, created_by, category) VALUES ('L-1', 'Sample Farmers Group', $1, $1, 'B2B_CORPORATE') RETURNING *`, [ids.vera])).rows[0];
  await withTransaction(async (client) => {
    await logLeadActivity(client, lead.id, { type: 'CALL', direction: 'OUTBOUND', outcome: 'NO_ANSWER', actorId: ids.vera, occurredAt: '2026-11-10T05:00:00Z' });
    await logLeadActivity(client, lead.id, { type: 'CALL', direction: 'OUTBOUND', outcome: 'COMPLETED', actorId: ids.vera, occurredAt: '2026-11-11T05:00:00Z' });
  });
  let l = (await query('SELECT * FROM crm_leads WHERE id = $1', [lead.id])).rows[0];
  assert.equal(l.last_incoming_at, null);
  assert.ok(l.last_contacted_at, 'an answered outgoing call is contact, not an incoming one');
  await withTransaction((client) => logLeadActivity(client, lead.id, { type: 'CALL', direction: 'INBOUND', outcome: 'COMPLETED', occurredAt: '2026-11-12T05:00:00Z' }));
  l = (await query('SELECT * FROM crm_leads WHERE id = $1', [lead.id])).rows[0];
  assert.equal(new Date(l.last_incoming_at).toISOString(), '2026-11-12T05:00:00.000Z');
  ids.lead = lead.id;
});

test('23: source, introduced by, assigned by and owner are kept apart; reassignment keeps the source and history', async (t) => {
  if (skip(t)) return;
  const src = (await query(`SELECT id FROM crm_sources ORDER BY id LIMIT 2`)).rows;
  await query('UPDATE crm_leads SET original_source_id = $2, source_id = $3, referral = $4 WHERE id = $1', [ids.lead, src[0].id, src[1].id, 'Met at a sample trade fair']);
  const contact = (await query(`INSERT INTO account_contacts (account_id, full_name) VALUES ($1, 'Sample Contact') RETURNING id`, [ids.acc])).rows[0].id;
  const set = ok(await call('PUT', `/workspace/origin/lead/${ids.lead}`, { token: tokens.vera, body: { introduced_by_contact_id: contact, reason: 'She introduced us' } }));
  assert.equal(set.introduced_by_contact_name, 'Sample Contact');
  assert.equal(set.referral, 'Met at a sample trade fair', 'the free-text referral stays');
  const audit = (await query(`SELECT * FROM crm_audit_events WHERE action = 'INTRODUCED_BY_CHANGED' AND entity_id = $1`, [ids.lead])).rows;
  assert.equal(audit.length, 1, 'the change is recorded');
  const before1 = ok(await call('GET', `/workspace/origin/lead/${ids.lead}`, { token: tokens.vera }));
  // reassigned to Omar, by the administrator
  await query(`UPDATE crm_leads SET owner_user_id = $2 WHERE id = $1`, [ids.lead, ids.omar]);
  await query(`INSERT INTO crm_assignments (entity_type, entity_id, from_user_id, to_user_id, method, reason, actor_id) VALUES ('LEAD', $1, $2, $3, 'MANUAL', 'Territory change', $4)`, [ids.lead, ids.vera, ids.omar, ids.admin]);
  const after1 = ok(await call('GET', `/workspace/origin/lead/${ids.lead}`, { token: tokens.admin }));
  assert.equal(after1.original_source, before1.original_source);
  assert.equal(after1.latest_source, before1.latest_source);
  assert.equal(after1.created_at, before1.created_at, 'the record\'s age is unchanged');
  assert.equal(after1.created_by_name, 'Vera Sample');
  assert.equal(after1.owner_name, 'Omar Sample');
  assert.deepEqual(after1.assignments.map((a) => `${a.from_name}->${a.to_name} by ${a.by_name}`), ['Vera Sample->Omar Sample by Admin Sample']);
  assert.equal(after1.introduced_by_contact_name, 'Sample Contact');
  // someone without a part in it cannot change where it came from
  assert.equal((await call('PUT', `/workspace/origin/lead/${ids.lead}`, { token: tokens.tara, body: { introduced_by_user_id: ids.tara } })).status, 403);
});

test('24: no dated next action is flagged; finishing the tracked action asks for the next one and never closes the deal', async (t) => {
  if (skip(t)) return;
  const stage = (await query(`SELECT id FROM account_stages WHERE slug = 'qualified'`)).rows[0].id;
  const pipe = (await query(`SELECT id FROM crm_pipelines WHERE key = 'b2b'`)).rows[0].id;
  const st = (await query(`SELECT id FROM workflow_statuses WHERE slug = 'to-do'`)).rows[0].id;
  const task = (await query(`INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date) VALUES ('RC-1', 'Send the sample quote', $1, $2, $3, $3, $3, now() + interval '1 day') RETURNING id`, [ids.prg, st, ids.vera])).rows[0].id;
  const deal = (await query(
    `INSERT INTO opportunities (account_id, name, owner_user_id, stage_id, pipeline_id, next_step, next_step_due, next_step_owner_id, next_step_task_id)
     VALUES ($1, 'Sample kits order', $2, $3, $4, 'Send the quote', current_date + 1, $2, $5) RETURNING id`, [ids.acc, ids.vera, stage, pipe, task],
  )).rows[0].id;
  await query('UPDATE tasks SET opportunity_id = $1 WHERE id = $2', [deal, task]);
  const undated = (await query(`INSERT INTO opportunities (account_id, name, owner_user_id, stage_id, pipeline_id) VALUES ($1, 'Sample undated deal', $2, $3, $4) RETURNING id`, [ids.acc, ids.vera, stage, pipe])).rows[0].id;
  const vera = await user('vera');
  let items = (await attentionFor(vera)).items;
  assert.equal(items.find((x) => x.record.id === undated).kind, 'DEAL_NO_NEXT_ACTION');
  // the next step is tracked by a task: the task reminders cover it, not a second rule
  await replanRecord('DEAL', deal);
  assert.equal((await occ('DEAL', deal)).length, 0);
  const ctx = ok(await call('GET', `/tasks/${task}/completion-context`, { token: tokens.vera }));
  assert.equal(ctx.deal_task, true);
  assert.equal(ctx.deals[0].requires_next_step, true, 'finishing it asks for the next action');
  const done = (await query(`SELECT id FROM workflow_statuses WHERE stage = 'done'`)).rows[0].id;
  await query('UPDATE tasks SET status_id = $2, completed_at = now() WHERE id = $1', [task, done]);
  assert.equal((await query('SELECT status FROM opportunities WHERE id = $1', [deal])).rows[0].status, 'ACTIVE', 'the deal stays open');
  items = (await attentionFor(vera)).items;
  const next = items.find((x) => x.record.id === deal);
  assert.equal(next.kind, 'DEAL_NO_NEXT_ACTION');
  assert.match(next.reason, /"Send the quote" is done; nothing is planned after it/);
  ids.deal = deal;
  ids.dealTask = task;
});

test('C8: a deal changing hands lists the work owned by others; only what is chosen moves', async (t) => {
  if (skip(t)) return;
  const st = (await query(`SELECT id FROM workflow_statuses WHERE slug = 'to-do'`)).rows[0].id;
  const a = (await query(`INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, opportunity_id) VALUES ('RC-2', 'Sample delivery plan', $1, $2, $3, $3, $3, $4) RETURNING id`, [ids.prg, st, ids.vera, ids.deal])).rows[0].id;
  const b = (await query(`INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, opportunity_id) VALUES ('RC-3', 'Sample invoice check', $1, $2, $3, $3, $3, $4) RETURNING id`, [ids.prg, st, ids.omar, ids.deal])).rows[0].id;
  const check = ok(await call('GET', `/workspace/handover-check?opportunity_id=${ids.deal}&to_user_id=${ids.omar}`, { token: tokens.vera }));
  assert.deepEqual(check.tasks.map((x) => x.id), [a], 'Omar\'s own task is not listed; the finished one is not either');
  assert.match(check.note, /Nothing is moved unless you choose it/);
  const moved = ok(await call('POST', '/workspace/handover-reassign', { token: tokens.vera, body: { opportunity_id: ids.deal, to_user_id: ids.omar, task_ids: [a, ids.dealTask + 999] } }));
  assert.deepEqual(moved.moved.tasks, [a], 'only tasks of this deal, only those chosen');
  assert.equal((await query('SELECT assignee_id FROM tasks WHERE id = $1', [b])).rows[0].assignee_id, ids.omar);
  assert.equal((await call('POST', '/workspace/handover-reassign', { token: tokens.nina, body: { opportunity_id: ids.deal, to_user_id: ids.nina, task_ids: [a] } })).status, 403);
});
