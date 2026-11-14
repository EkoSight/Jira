/**
 * My workspace, Part C: the reminder engine for records other than tasks,
 * "Remind me", notification states, My reminders and the personal timezone.
 * Numbers refer to the build prompt's tests (section 8).
 *
 *   12  paused or on leave: nothing is sent; the item still shows
 *   28  planning twice or retrying: one occurrence, one notification
 *   29  sent by the worker with no browser open; a change just before
 *       delivery stops the stale reminder
 *   30  reading or snoozing completes nothing and moves no date
 *   31  losing access cancels the queued reminder and hides the record
 *   32  nobody reads another person's reminders, preferences or snoozes
 *   33  turning my rule off changes nobody else's rule and no record
 *   34  launch: nothing old is sent
 *
 * Made-up people and records; Google Chat is a stand-in that records what it
 * was given.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { setChatConfig, setChatTransport } from '../src/lib/googleChat.js';
import { getSettings, updateSetting } from '../src/services/settings.js';
import { deliverOutbox } from '../src/services/googleChat.js';
import { planSweep, sendDueOccurrences, replanRecord } from '../src/services/workspace/reminders.js';
import '../src/services/workspace/personal.js';
import { runReminderTick } from '../src/jobs/reminderWorker.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const sent = [];

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
const occ = async (where = 'TRUE', params = []) => (await query(`SELECT * FROM reminder_occurrences WHERE ${where} ORDER BY id`, params)).rows;
const inMin = (m) => new Date(Date.now() + m * 60_000).toISOString();

let refN = 0;
async function mkTask(owner, dept = null) {
  refN += 1;
  const st = (await query(`SELECT id FROM workflow_statuses WHERE slug = 'to-do'`)).rows[0].id;
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date) VALUES ($1, $2, $3, $4, $5, $5, $5, now() + interval '5 days') RETURNING *`,
    [`RM-${refN}`, `Sample task ${refN}`, dept || ids.ops, st, owner],
  );
  return rows[0];
}

before(async () => {
  setChatConfig({ clientEmail: 'taskflow-chat@demo.iam.gserviceaccount.com', privateKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), projectId: 'demo', projectNumber: '1', audience: 'https://x.test/e' });
  setChatTransport(async (space, message) => { sent.push({ space, message }); return { name: `${space}/messages/${sent.length}` }; });
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1), ('FLD', 'Field', '#0a7', 2)`);
  ids.ops = (await query(`SELECT id FROM departments WHERE key = 'OPS'`)).rows[0].id;
  ids.fld = (await query(`SELECT id FROM departments WHERE key = 'FLD'`)).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of [['admin', 'admin', ids.ops], ['isha', 'member', ids.ops], ['noa', 'member', ids.fld], ['raj', 'member', ids.ops]]) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.wr@test.local`, password, role, dept],
    );
    ids[key] = rows[0].id;
    await query(`INSERT INTO chat_spaces (space_name, kind, user_id, added_by_email, active) VALUES ($1, 'DM', $2, $3, TRUE)`, [`spaces/dm-${key}`, rows[0].id, `${key}.wr@test.local`]);
  }
  await updateSetting('googleChat', { ...(await getSettings()).googleChat, enabled: true }, ids.admin);
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'isha', 'noa', 'raj']) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.wr@test.local`, password: 'Password123!' } })).token;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('34: launch — a reminder already due when the engine first runs is recorded as skipped, never sent', async (t) => {
  if (skip(t)) return;
  const task = await mkTask(ids.isha);
  // made before the engine existed (as if from an earlier release), already due
  await query(`INSERT INTO personal_reminders (user_id, entity_type, entity_id, remind_at, note) VALUES ($1, 'TASK', $2, now() - interval '2 days', 'old one')`, [ids.isha, task.id]);
  const launch = await planSweep();
  assert.ok(launch.launched.includes('PERSONAL'));
  const rows = await occ('entity_id = $1', [task.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'SKIPPED');
  assert.match(rows[0].reason, /Before launch/);
  await sendDueOccurrences();
  assert.equal((await query(`SELECT count(*)::int AS n FROM notifications WHERE type = 'workspace_reminder'`)).rows[0].n, 0, 'nothing old is sent');
});

test('28, 29: one occurrence and one notification however often it is planned or retried; sent with no browser open', async (t) => {
  if (skip(t)) return;
  const task = await mkTask(ids.isha);
  const r = ok(await call('POST', '/workspace/reminders/personal', { token: tokens.isha, body: { entity_type: 'TASK', entity_id: task.id, remind_at: inMin(2), note: 'Call the supplier first' } }), 201);
  await replanRecord('TASK', task.id);
  await replanRecord('TASK', task.id);
  await planSweep();
  const planned = await occ('personal_reminder_id = $1', [r.reminder.id]);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].status, 'PENDING');
  // the worker's own tick, three minutes on, twice (as if it retried)
  const later = new Date(Date.now() + 3 * 60_000);
  await runReminderTick({ now: later, force: true });
  await runReminderTick({ now: later, force: true });
  const done = await occ('personal_reminder_id = $1', [r.reminder.id]);
  assert.equal(done[0].status, 'SENT');
  const bell = (await query(`SELECT * FROM notifications WHERE occurrence_id = $1`, [done[0].id])).rows;
  assert.equal(bell.length, 1, 'one notification');
  assert.equal(bell[0].user_id, ids.isha);
  assert.equal(bell[0].entity_type, 'TASK');
  assert.match(bell[0].title, /^Your reminder: RM-\d+ Sample task/);
  assert.match(bell[0].body, /"Call the supplier first"/);
  assert.equal(bell[0].reason, 'You set this reminder yourself');
  await deliverOutbox();
  assert.equal(sent.filter((m) => m.space === 'spaces/dm-isha').length, 1, 'and one Chat message');
  assert.equal((await query('SELECT status FROM personal_reminders WHERE id = $1', [r.reminder.id])).rows[0].status, 'DONE');
});

test('29: a change just before delivery stops the stale reminder (changed, then removed)', async (t) => {
  if (skip(t)) return;
  const task = await mkTask(ids.isha);
  const r = ok(await call('POST', '/workspace/reminders/personal', { token: tokens.isha, body: { entity_type: 'TASK', entity_id: task.id, remind_at: inMin(1) } }), 201).reminder;
  ok(await call('PUT', `/workspace/reminders/personal/${r.id}`, { token: tokens.isha, body: { remind_at: inMin(120), note: 'later' } }));
  const rows = await occ('personal_reminder_id = $1', [r.id]);
  assert.deepEqual(rows.map((x) => `${x.schedule_version}:${x.status}`), ['1:CANCELLED', '2:PENDING']);
  // the old version's row, claimed late by a slow worker, would still be refused at send time
  await query(`UPDATE reminder_occurrences SET status = 'PENDING' WHERE id = $1`, [rows[0].id]);
  await sendDueOccurrences(new Date(Date.now() + 5 * 60_000));
  assert.equal((await occ('id = $1', [rows[0].id]))[0].status, 'CANCELLED');
  ok(await call('POST', `/workspace/reminders/personal/${r.id}/cancel`, { token: tokens.isha }));
  assert.equal((await occ('id = $1', [rows[1].id]))[0].status, 'CANCELLED');
  assert.equal((await query('SELECT count(*)::int AS n FROM notifications WHERE occurrence_id = ANY($1::bigint[])', [rows.map((x) => x.id)])).rows[0].n, 0);
});

test('30: reading or snoozing a reminder completes nothing and moves no date; the bell hides it until then', async (t) => {
  if (skip(t)) return;
  const task = await mkTask(ids.raj);
  const before1 = (await query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0];
  ok(await call('POST', '/workspace/reminders/personal', { token: tokens.raj, body: { entity_type: 'TASK', entity_id: task.id, remind_at: inMin(1) } }), 201);
  await sendDueOccurrences(new Date(Date.now() + 2 * 60_000));
  const bell = ok(await call('GET', '/notifications', { token: tokens.raj }));
  const n = bell.notifications.find((x) => x.entity_type === 'TASK' && x.entity_id === task.id);
  assert.ok(n);
  assert.equal(bell.unread, 1);
  ok(await call('POST', '/notifications/read', { token: tokens.raj, body: { ids: [n.id] } }));
  const snooze = ok(await call('POST', `/notifications/${n.id}/snooze`, { token: tokens.raj, body: { until: inMin(60) } }));
  assert.match(snooze.note, /Only your bell changes/);
  const after1 = ok(await call('GET', '/notifications', { token: tokens.raj }));
  assert.equal(after1.notifications.some((x) => x.id === n.id), false, 'hidden until then');
  assert.equal(after1.snoozed, 1);
  assert.deepEqual((await query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0], before1, 'the task is exactly as it was');
  // someone else cannot snooze or open it
  assert.equal((await call('POST', `/notifications/${n.id}/snooze`, { token: tokens.isha, body: { until: inMin(60) } })).status, 404);
  assert.equal((await call('GET', `/notifications/${n.id}/open`, { token: tokens.isha })).status, 404);
  ok(await call('POST', `/notifications/${n.id}/unsnooze`, { token: tokens.raj }));
  const open = ok(await call('GET', `/notifications/${n.id}/open`, { token: tokens.raj }));
  assert.deepEqual(open, { available: true, url: `/?task=${task.id}`, label: `${task.ref} ${task.title}` });
});

test('31: losing access cancels a queued reminder, and the bell shows "not available" with no title', async (t) => {
  if (skip(t)) return;
  const task = await mkTask(ids.isha, ids.ops);
  // Raj sees it as a member of Operations
  const r = ok(await call('POST', '/workspace/reminders/personal', { token: tokens.raj, body: { entity_type: 'TASK', entity_id: task.id, remind_at: inMin(1) } }), 201).reminder;
  await query('UPDATE users SET department_id = $2 WHERE id = $1', [ids.raj, ids.fld]);
  await sendDueOccurrences(new Date(Date.now() + 2 * 60_000));
  const row = (await occ('personal_reminder_id = $1', [r.id]))[0];
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.reason, 'They can no longer see this record');
  assert.equal((await query('SELECT status FROM personal_reminders WHERE id = $1', [r.id])).rows[0].status, 'CANCELLED');
  // an earlier notification about it (from test 30's kind) now shows nothing about the record
  const n = (await query(`INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id) VALUES ($1, 'workspace_reminder', 'Your reminder: secret title', 'secret body', 'TASK', $2) RETURNING id`, [ids.raj, task.id])).rows[0];
  const bell = ok(await call('GET', '/notifications', { token: tokens.raj }));
  const shown = bell.notifications.find((x) => x.id === n.id);
  assert.equal(shown.title, 'This item is not available to you');
  assert.equal(shown.body, null);
  assert.deepEqual(ok(await call('GET', `/notifications/${n.id}/open`, { token: tokens.raj })), { available: false, url: null });
  // and a new reminder on it is refused without saying what it is
  const refused = await call('POST', '/workspace/reminders/personal', { token: tokens.raj, body: { entity_type: 'TASK', entity_id: task.id, remind_at: inMin(10) } });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error, 'Not available');
  await query('UPDATE users SET department_id = $2 WHERE id = $1', [ids.raj, ids.ops]);
});

test('12: paused or on leave — nothing is sent, and the item still shows in My workspace', async (t) => {
  if (skip(t)) return;
  const task = await mkTask(ids.noa, ids.fld);
  await query(`INSERT INTO reminder_preferences (user_id, paused_until, pause_reason) VALUES ($1, current_date + 3, 'Training week')`, [ids.noa]);
  ok(await call('POST', '/workspace/reminders/personal', { token: tokens.noa, body: { entity_type: 'TASK', entity_id: task.id, remind_at: inMin(1) } }), 201);
  await sendDueOccurrences(new Date(Date.now() + 2 * 60_000));
  const row = (await occ('recipient_id = $1 AND entity_id = $2', [ids.noa, task.id]))[0];
  assert.equal(row.status, 'SKIPPED');
  assert.match(row.reason, /^Paused until/);
  const att = ok(await call('GET', '/workspace/attention?limit=200', { token: tokens.noa }));
  assert.ok(att.items.some((it) => it.record.type === 'TASK' && it.record.id === task.id), 'the task still shows');
  await query('UPDATE reminder_preferences SET paused_until = NULL WHERE user_id = $1', [ids.noa]);
  // on approved leave today
  await query(`INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status) VALUES ($1, 'CASUAL', current_date - 1, current_date + 1, 'Sample leave', 'APPROVED_PAID')`, [ids.noa]);
  const t2 = await mkTask(ids.noa, ids.fld);
  ok(await call('POST', '/workspace/reminders/personal', { token: tokens.noa, body: { entity_type: 'TASK', entity_id: t2.id, remind_at: inMin(1) } }), 201);
  await sendDueOccurrences(new Date(Date.now() + 2 * 60_000));
  const row2 = (await occ('recipient_id = $1 AND entity_id = $2', [ids.noa, t2.id]))[0];
  assert.equal(row2.status, 'SKIPPED');
  assert.match(row2.reason, /^Away: on approved leave/);
});

test('32, 33: my reminders and preferences are mine; turning my rule off changes nobody else\'s and no record', async (t) => {
  if (skip(t)) return;
  const mine = ok(await call('GET', '/workspace/reminders/personal', { token: tokens.isha }));
  const theirs = ok(await call('GET', '/workspace/reminders/personal', { token: tokens.raj }));
  assert.ok(mine.reminders.every((r) => r.user_id === ids.isha));
  assert.ok(theirs.reminders.every((r) => r.user_id === ids.raj));
  const ishaTask = await mkTask(ids.isha);
  const own = ok(await call('POST', '/workspace/reminders/personal', { token: tokens.isha, body: { entity_type: 'TASK', entity_id: ishaTask.id, remind_at: inMin(300) } }), 201).reminder;
  assert.equal((await call('PUT', `/workspace/reminders/personal/${own.id}`, { token: tokens.raj, body: { remind_at: inMin(10) } })).status, 404, 'someone else\'s reminder does not exist for me');
  assert.equal((await call('POST', `/workspace/reminders/personal/${own.id}/cancel`, { token: tokens.raj })).status, 404);
  // both have a planned deal reminder; Isha turns that rule off
  for (const u of [ids.isha, ids.raj]) {
    await query(`INSERT INTO reminder_occurrences (recipient_id, entity_type, entity_id, rule_key, occurrence_key, remind_at) VALUES ($1, 'DEAL', 999, 'DEAL_REVISIT', 'd:2030-01-01', now() + interval '1 day')`, [u]);
  }
  const r = ok(await call('PUT', '/workspace/reminders/rules/DEAL_REVISIT', { token: tokens.isha, body: { enabled: false } }));
  assert.equal(r.cancelled, 1);
  assert.equal((await occ(`recipient_id = $1 AND rule_key = 'DEAL_REVISIT'`, [ids.raj]))[0].status, 'PENDING', 'Raj\'s is untouched');
  assert.equal((await query('SELECT count(*)::int AS n FROM reminder_rule_prefs WHERE user_id = $1', [ids.raj])).rows[0].n, 0, 'and so are his preferences');
  const view = ok(await call('GET', '/workspace/reminders', { token: tokens.isha }));
  assert.equal(view.rules.find((x) => x.key === 'DEAL_REVISIT').enabled, false);
  assert.equal(view.rules.find((x) => x.key === 'APPLICATION_DEADLINE_1D').enabled, false, 'opt-in rules start off');
  assert.equal(view.rules.find((x) => x.key === 'APPLICATION_DEADLINE').enabled, true);
  assert.deepEqual(view.channels, { app: true, chat: true, chat_why: null, email: false, push: false });
  assert.ok(view.existing.some((x) => x.key === 'TASK_REMINDERS') && view.existing.some((x) => x.key === 'DAILY_SUMMARY'), 'the older engines are listed too');
  assert.equal((await call('PUT', '/workspace/reminders/rules/PERSONAL', { token: tokens.isha, body: { enabled: false } })).status, 400);
  assert.equal((await call('PUT', '/workspace/reminders/rules/MEETING_START', { token: tokens.isha, body: { enabled: true, at_time: '08:00' } })).status, 400, 'a relative reminder has no time of day');
});

test('D4: a personal timezone is optional, checked, and used for my dated reminders', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('PUT', '/workspace/me/timezone', { token: tokens.isha, body: { timezone: 'Mars/Olympus' } })).status, 400);
  ok(await call('PUT', '/workspace/me/timezone', { token: tokens.isha, body: { timezone: 'Europe/London' } }));
  assert.equal(ok(await call('GET', '/auth/me', { token: tokens.isha })).user.timezone, 'Europe/London');
  const view = ok(await call('GET', '/workspace/reminders', { token: tokens.isha }));
  assert.equal(view.timezone, 'Europe/London');
  assert.equal(view.timezone_is_personal, true);
  ok(await call('PUT', '/workspace/me/timezone', { token: tokens.isha, body: { timezone: null } }));
  assert.equal(ok(await call('GET', '/workspace/reminders', { token: tokens.isha })).timezone, 'Asia/Kolkata', 'empty: the company calendar\'s');
});
