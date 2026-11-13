/**
 * One reminder engine, the daily summaries, the delivery log and the
 * coverage check. Problems from the brief, each reproduced:
 *
 *   6   the due-soon notice: once, before the deadline, never in quiet hours,
 *       with the task ID, owner, due time and zone, status, next action, link;
 *       the old 24-hourly notice stops when the engine is live
 *   7   someone is told when a deadline passes: the owner at the deadline,
 *       the reporting manager after the grace period
 *   8   the personal summary covers supporting work, upcoming, blocked and
 *       review-due work; people Chat cannot reach get it in the bell and their
 *       fallback person is told
 *   9   holidays and leave are respected; work due while the owner is away goes
 *       to their fallback person
 *   10  a morning the server missed is sent later, marked late; one it could
 *       not send at all is recorded as missed
 *   11  "nothing to say" is recorded as skipped, never as sent
 *   12  a queued message about a task that was finished or handed over is
 *       cancelled, not sent
 *   13  departments with no summary space are flagged
 *   +   test mode, no double sending, a failed Chat message reaching the
 *       fallback, acknowledgement, CRM follow-ups left to their own engine,
 *       and the coverage check
 *
 * Made-up people; Google Chat is a stand-in that records what it was given.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool, withTransaction } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { ChatError, setChatConfig, setChatTransport } from '../src/lib/googleChat.js';
import { updateSetting, getSettings } from '../src/services/settings.js';
import { deliverOutbox } from '../src/services/googleChat.js';
import {
  followUpFailedChats, planTaskReminders, sendDueTaskReminders,
} from '../src/services/taskReminders.js';
import { firstWorkingDayOfWeek, personalSummary, queueBacklogReviews, queueSummaries } from '../src/services/taskSummaries.js';
import { coverageReport } from '../src/services/coverage.js';
import { runScanOnce } from '../src/jobs/deadlineScanner.js';
import { addDays, weekdayOf } from '../../shared/deadlineHealth.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const st = {};
const sent = [];
let failFor = null;

const IST = (date, hm) => new Date(`${date}T${hm}:00+05:30`);
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

// a Wednesday at least a week ahead, so every date here is a working day in the future
let D = addDays(new Date().toISOString().slice(0, 10), 8);
while (weekdayOf(D) !== 3) D = addDays(D, 1);

let refN = 0;
async function mkTask({ title, owner, due, stage = 'todo', follower = null, next = null, dept = ids.ops, review = null, followup = null }) {
  refN += 1;
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, follower_id, created_by, reporter_id, due_date, original_due_date, next_action, review_date, followup_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $8, $9, $10, $11) RETURNING id`,
    [`RM-${refN}`, title, dept, st[stage], owner, follower, ids.admin, due, next, review, followup],
  );
  return rows[0].id;
}
const plan = (taskId, now) => withTransaction((client) => planTaskReminders(client, taskId, { now }));
const reminders = async (taskId) => (await query('SELECT * FROM task_reminders WHERE task_id = $1 ORDER BY remind_at, kind, channel, user_id', [taskId])).rows;
const setMode = async (mode, extra = {}) => updateSetting('reminders', { ...(await getSettings()).reminders, mode, testRecipientId: ids.admin, ...extra }, ids.admin);

before(async () => {
  setChatConfig({ clientEmail: 'taskflow-chat@demo.iam.gserviceaccount.com', privateKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), projectId: 'demo', projectNumber: '1', audience: 'https://x.test/e' });
  setChatTransport(async (space, message) => {
    if (failFor && space === failFor) throw new ChatError('The app was removed from this chat', { permanent: true });
    sent.push({ space, message });
    return { name: `${space}/messages/${sent.length}` };
  });
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1), ('FLD', 'Field', '#0a7', 2)`);
  ids.ops = (await query(`SELECT id FROM departments WHERE key = 'OPS'`)).rows[0].id;
  ids.fld = (await query(`SELECT id FROM departments WHERE key = 'FLD'`)).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('Backlog', 'backlog', 'backlog', '#999', 1, FALSE), ('To Do', 'to-do', 'todo', '#3b82f6', 2, TRUE),
    ('Blocked', 'blocked', 'blocked', '#ef4444', 3, FALSE), ('Done', 'done', 'done', '#22c55e', 4, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) st[r.stage] = r.id;
  const password = await hashPassword('Password123!');
  const people = [
    ['admin', 'admin', ids.ops, true], ['isha', 'member', ids.ops, true], ['raj', 'member', ids.ops, true],
    ['meera', 'manager', ids.ops, true], ['ravi', 'member', ids.ops, false], ['kiran', 'member', ids.fld, false], ['noa', 'member', ids.fld, true],
  ];
  for (const [key, role, dept, connected] of people) {
    const email = `${key}.r@test.local`;
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, email, password, role, dept],
    );
    ids[key] = rows[0].id;
    ids[`${key}_email`] = email;
    if (connected) {
      await query(`INSERT INTO chat_spaces (space_name, kind, user_id, added_by_email, active) VALUES ($1, 'DM', $2, $3, TRUE)`, [`spaces/dm-${key}`, rows[0].id, email]);
    }
  }
  // Raj is Isha's reporting manager; Meera manages Operations
  await query(`INSERT INTO employee_work_profiles (user_id, reporting_manager_id) VALUES ($1, $2)`, [ids.isha, ids.raj]);
  await updateSetting('googleChat', { ...(await getSettings()).googleChat, enabled: true }, ids.admin);
  await setMode('LIVE');
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'isha', 'raj']) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: ids[`${key}_email`], password: 'Password123!' } })).token;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('6: one reminder before the deadline, with everything needed to act on it', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Send the dealer price list', owner: ids.isha, due: IST(D, '17:00'), next: 'Call the dealer first' });
  await plan(id, IST(D, '09:00'));
  await plan(id, IST(D, '09:05'));
  const planned = await reminders(id);
  assert.deepEqual(planned.map((r) => `${r.kind}:${r.channel}:${r.user_id === ids.raj ? 'raj' : 'isha'}`), [
    'BEFORE_DUE:APP:isha', 'BEFORE_DUE:CHAT:isha', 'AT_DUE:APP:isha', 'AT_DUE:CHAT:isha', 'AFTER_GRACE:APP:raj', 'AFTER_GRACE:CHAT:raj',
  ], 'planned once, however often it is re-planned');
  assert.equal(new Date(planned[0].remind_at).getTime(), IST(D, '15:00').getTime(), '2 hours before (D5)');
  assert.equal(new Date(planned[4].remind_at).getTime(), IST(D, '17:00').getTime() + 24 * 3_600_000, 'after the grace period (no rule: 24 hours)');

  sent.length = 0;
  const out = await sendDueTaskReminders(IST(D, '15:00'));
  assert.equal(out.sent, 2);
  assert.equal((await sendDueTaskReminders(IST(D, '15:01'))).sent, 0, 'never twice');
  const bell = (await query(`SELECT * FROM notifications WHERE task_id = $1 AND type = 'task_due_soon'`, [id])).rows;
  assert.equal(bell.length, 1);
  assert.match(bell[0].title, /^Due in 2 h: RM-\d+ Send the dealer price list$/);
  for (const line of ['Owner: Isha Sample', `Due: Wed ${Number(D.slice(8))} `, '17:00 IST', 'Status: To Do · Due today 17:00', 'Next action: Call the dealer first']) {
    assert.ok(bell[0].body.includes(line), `${line} in: ${bell[0].body}`);
  }
  await deliverOutbox();
  const chat = sent.find((m) => m.space === 'spaces/dm-isha');
  assert.ok(chat, 'and in Google Chat');
  assert.match(chat.message.text, /Open RM-\d+ in TaskFlow/);
  assert.match(chat.message.text, /\/\?task=\d+\|/, 'a direct link');
});

test('6: nothing in quiet hours; the old 24-hourly notice stops only when the engine is live', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Morning soil samples', owner: ids.isha, due: IST(addDays(D, 1), '08:00') });
  await plan(id, IST(D, '12:00'));
  await sendDueTaskReminders(IST(addDays(D, 1), '06:00'));
  const before = (await reminders(id)).find((r) => r.kind === 'BEFORE_DUE' && r.channel === 'APP');
  assert.equal(before.status, 'SKIPPED');
  assert.match(before.reason, /^Quiet hours \(20:00–08:30\)/);

  // the old notice: still made in test mode, not once the engine is live
  const legacy = await mkTask({ title: 'Legacy check', owner: ids.raj, due: new Date(Date.now() + 26 * 3_600_000) });
  await setMode('TEST');
  await runScanOnce();
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE task_id = $1 AND type = 'due_soon'`, [legacy])).rows[0].n, 1);
  await query(`UPDATE notifications SET created_at = now() - interval '2 days' WHERE task_id = $1`, [legacy]);
  await setMode('LIVE');
  await runScanOnce();
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE task_id = $1 AND type = 'due_soon'`, [legacy])).rows[0].n, 1, 'retired when live');
});

test('7: when a deadline passes the owner is told, and after the grace period their manager', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Submit the subsidy form', owner: ids.isha, due: IST(D, '16:00') });
  await plan(id, IST(D, '09:00'));
  await sendDueTaskReminders(IST(D, '16:00'));
  const now = (await query(`SELECT * FROM notifications WHERE task_id = $1 AND type = 'task_due_now'`, [id])).rows;
  assert.equal(now.length, 1);
  assert.equal(now[0].user_id, ids.isha);
  await sendDueTaskReminders(IST(addDays(D, 1), '16:00'));
  const manager = (await query(`SELECT * FROM notifications WHERE task_id = $1 AND type = 'task_overdue_notice'`, [id])).rows;
  assert.equal(manager.length, 1);
  assert.equal(manager[0].user_id, ids.raj, 'the reporting manager');
  assert.match(manager[0].title, /Still open after its deadline: .*Isha Sample/);
});

test('12: a finished or handed-over task cancels what was planned or queued', async (t) => {
  if (skip(t)) return;
  const done = await mkTask({ title: 'Book the hall', owner: ids.isha, due: IST(D, '18:00') });
  const moved = await mkTask({ title: 'Print leaflets', owner: ids.isha, due: IST(D, '18:00') });
  await plan(done, IST(D, '09:00'));
  await plan(moved, IST(D, '09:00'));
  await query('UPDATE tasks SET status_id = $1, completed_at = now() WHERE id = $2', [st.done, done]);
  await query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [ids.raj, moved]);
  await plan(moved, IST(D, '09:30'));
  await sendDueTaskReminders(IST(D, '16:00'));
  const d = (await reminders(done)).filter((r) => r.kind === 'BEFORE_DUE');
  assert.ok(d.every((r) => r.status === 'CANCELLED' && r.reason === 'The task is done'));
  const m = await reminders(moved);
  assert.ok(m.filter((r) => r.user_id === ids.isha).every((r) => r.status === 'CANCELLED'));
  assert.ok(m.some((r) => r.user_id === ids.raj && r.kind === 'BEFORE_DUE' && r.status === 'SENT'), 'the new owner is reminded');

  // a Chat message already queued when the task is finished is cancelled, not sent
  const late = await mkTask({ title: 'Collect the cheque', owner: ids.isha, due: IST(D, '19:00') });
  await plan(late, IST(D, '09:00'));
  await sendDueTaskReminders(IST(D, '17:00'));
  const queued = (await reminders(late)).find((r) => r.kind === 'BEFORE_DUE' && r.channel === 'CHAT');
  assert.equal(queued.status, 'SENT');
  await query('UPDATE tasks SET status_id = $1, completed_at = now() WHERE id = $2', [st.done, late]);
  sent.length = 0;
  await deliverOutbox();
  const row = (await query('SELECT status, last_error FROM chat_outbox WHERE dedupe_key = $1', [queued.outbox_key])).rows[0];
  assert.equal(row.status, 'CANCELLED');
  assert.match(row.last_error, /finished before this could be sent/);
  assert.ok(!sent.some((m) => /Collect the cheque/.test(m.message.text)), 'not sent');
});

test('9: work due while the owner is on leave goes to their fallback person', async (t) => {
  if (skip(t)) return;
  const day = addDays(D, 7);
  await query(
    `INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status) VALUES ($1, 'CASUAL', $2, $2, 'Family function', 'APPROVED_PAID')`,
    [ids.isha, day],
  );
  await query(`INSERT INTO user_availability (user_id, status, start_date, end_date, note) VALUES ($1, 'ON_LEAVE', $2, $2, 'Family function')`, [ids.isha, day]);
  const id = await mkTask({ title: 'Renew the trade licence', owner: ids.isha, due: IST(day, '17:00') });
  await plan(id, IST(addDays(day, -1), '12:00'));
  await sendDueTaskReminders(IST(day, '15:00'));
  const own = (await reminders(id)).find((r) => r.kind === 'BEFORE_DUE' && r.channel === 'APP');
  assert.equal(own.status, 'SKIPPED');
  assert.match(own.reason, /^Away: on approved leave\. Their fallback person was told instead\./);
  await sendDueTaskReminders(IST(day, '15:01'));
  const cover = (await query(`SELECT * FROM notifications WHERE task_id = $1 AND type = 'task_cover'`, [id])).rows;
  assert.equal(cover.length, 1);
  assert.equal(cover[0].user_id, ids.raj);
  assert.match(cover[0].title, /^Covering for Isha Sample/);
  assert.ok(!cover[0].body.includes('Family function'), 'never why they are away');

  // the summaries that day: Isha's is skipped (away), Raj's covers for her
  const summaries = await queueSummaries(IST(day, '08:50'));
  assert.ok(summaries.queued >= 1);
  const log = (await query(`SELECT * FROM reminder_summary_log WHERE summary_date = $1 AND kind = 'PERSONAL'`, [day])).rows;
  const isha = log.find((l) => l.user_id === ids.isha);
  assert.equal(isha.status, 'SKIPPED');
  assert.match(isha.reason, /^Away: on approved leave; their fallback person covers what is due/);
  const raj = log.find((l) => l.user_id === ids.raj);
  assert.ok(raj.covering_user_ids.includes(ids.isha));
  const text = (await query('SELECT payload FROM chat_outbox WHERE dedupe_key = $1', [raj.outbox_key])).rows[0].payload.text;
  assert.match(text, /\*Covering for Isha Sample\* \(on approved leave/);
  assert.match(text, /Renew the trade licence/);
});

test('9: a company holiday: no summaries and no reminders', async (t) => {
  if (skip(t)) return;
  const day = addDays(D, 14);
  await query(`INSERT INTO work_holidays (holiday_date, name) VALUES ($1, 'Founders Day')`, [day]);
  const id = await mkTask({ title: 'Holiday-day task', owner: ids.raj, due: IST(day, '17:00') });
  await plan(id, IST(addDays(day, -1), '12:00'));
  await sendDueTaskReminders(IST(day, '15:00'));
  const r = (await reminders(id)).find((x) => x.kind === 'BEFORE_DUE' && x.channel === 'APP');
  assert.equal(r.status, 'SKIPPED');
  assert.match(r.reason, /^Away: a holiday \(Founders Day\)/);
  await queueSummaries(IST(day, '08:50'));
  const log = (await query(`SELECT * FROM reminder_summary_log WHERE summary_date = $1 AND kind = 'PERSONAL' AND user_id = $2`, [day, ids.raj])).rows[0];
  assert.equal(log.status, 'SKIPPED');
  assert.match(log.reason, /^Away: a holiday \(Founders Day\)/);
});

test('8 and 11: the summary covers supporting, upcoming, blocked and review-due work; the unreachable get the bell; "nothing to say" is skipped', async (t) => {
  if (skip(t)) return;
  const day = addDays(D, 21);
  await mkTask({ title: 'Ravi field report', owner: ids.ravi, due: IST(day, '12:00'), follower: ids.isha });
  await mkTask({ title: 'Isha upcoming visit', owner: ids.isha, due: IST(addDays(day, 1), '12:00') });
  await mkTask({ title: 'Isha due today', owner: ids.isha, due: IST(day, '17:00') });
  await mkTask({ title: 'Isha blocked lab test', owner: ids.isha, due: IST(addDays(day, 5), '12:00'), stage: 'blocked' });
  await mkTask({ title: 'Isha old idea', owner: ids.isha, due: null, stage: 'backlog', review: addDays(day, -1) });
  const summary = await personalSummary(ids.isha, { now: IST(day, '08:50') });
  for (const heading of ['*Due today', '*Upcoming, next 3 working days', '*Blocked', '*Review due', '*Supporting (the owner carries the deadline)']) {
    assert.ok(summary.text.includes(heading), `${heading} in the summary`);
  }
  assert.match(summary.text, /Ravi field report/);

  await queueSummaries(IST(day, '08:50'));
  const log = new Map((await query(`SELECT * FROM reminder_summary_log WHERE summary_date = $1 AND kind = 'PERSONAL'`, [day])).rows.map((l) => [l.user_id, l]));
  assert.equal(log.get(ids.isha).status, 'QUEUED');
  assert.equal(log.get(ids.ravi).status, 'APP_ONLY', 'not connected: the bell carries it');
  assert.match(log.get(ids.ravi).reason, /^Not connected to Google Chat; sent to the TaskFlow bell, and their fallback person is told/);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'daily_summary'`, [ids.ravi])).rows[0].n, 1);
  assert.ok(log.get(ids.meera).covering_user_ids.includes(ids.ravi), 'Ravi\'s department manager covers for him');
  // 11: nobody's "nothing to say" is stored as sent
  assert.equal(log.get(ids.noa).status, 'SKIPPED');
  assert.equal(log.get(ids.noa).reason, 'Nothing to say: no open work and nothing waiting');
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM chat_outbox WHERE dedupe_key = $1`, [`digest:${ids.noa}:${day}`])).rows[0].n, 0);
});

test('10: a missed morning is sent later, marked late; a day the server never managed is recorded as missed', async (t) => {
  if (skip(t)) return;
  const day = addDays(D, 28);
  await mkTask({ title: 'Late-morning task', owner: ids.raj, due: IST(day, '17:00') });
  await queueSummaries(IST(day, '15:00'));
  const raj = (await query(`SELECT * FROM reminder_summary_log WHERE log_key = $1`, [`personal:${ids.raj}:${day}`])).rows[0];
  assert.equal(raj.late, true);
  assert.match((await query('SELECT payload FROM chat_outbox WHERE dedupe_key = $1', [raj.outbox_key])).rows[0].payload.text, /Sent late: TaskFlow could not send it at 08:45/);

  const missedDay = addDays(D, 29);
  await queueSummaries(IST(missedDay, '19:00'));
  const missed = (await query(`SELECT * FROM reminder_summary_log WHERE log_key = $1`, [`personal:${ids.raj}:${missedDay}`])).rows[0];
  assert.equal(missed.status, 'SKIPPED');
  assert.equal(missed.reason, 'Missed: TaskFlow could not send it between 08:45 and 18:00');
});

test('test mode: only the administrator who switched it on receives anything; the rest is "would send"', async (t) => {
  if (skip(t)) return;
  await setMode('TEST');
  const theirs = await mkTask({ title: 'Isha test-mode task', owner: ids.isha, due: IST(addDays(D, 35), '17:00') });
  const mine = await mkTask({ title: 'Admin test-mode task', owner: ids.admin, due: IST(addDays(D, 35), '17:00') });
  await plan(theirs, IST(addDays(D, 35), '09:00'));
  await plan(mine, IST(addDays(D, 35), '09:00'));
  await sendDueTaskReminders(IST(addDays(D, 35), '15:00'));
  const a = (await reminders(theirs)).find((r) => r.kind === 'BEFORE_DUE' && r.channel === 'APP');
  assert.equal(a.status, 'WOULD_SEND');
  const b = (await reminders(mine)).find((r) => r.kind === 'BEFORE_DUE' && r.channel === 'APP');
  assert.equal(b.status, 'SENT');
  const n = (await query('SELECT title FROM notifications WHERE id = $1', [b.notification_id])).rows[0];
  assert.match(n.title, /^TEST · Due in/);
  await setMode('LIVE');
});

test('two workers at once still send each reminder once', async (t) => {
  if (skip(t)) return;
  const day = addDays(D, 36);
  const id = await mkTask({ title: 'Race check', owner: ids.raj, due: IST(day, '17:00') });
  await plan(id, IST(day, '09:00'));
  const [a, b] = await Promise.all([sendDueTaskReminders(IST(day, '15:00')), sendDueTaskReminders(IST(day, '15:00'))]);
  assert.equal(a.sent + b.sent, 2);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE task_id = $1`, [id])).rows[0].n, 1);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM chat_outbox WHERE dedupe_key LIKE 'task-reminder:%' AND user_id = $1 AND payload->>'text' LIKE '%Race check%'`, [ids.raj])).rows[0].n, 1);
});

test('a Chat reminder that cannot be delivered reaches the fallback person', async (t) => {
  if (skip(t)) return;
  const day = addDays(D, 42);
  const id = await mkTask({ title: 'Pay the electricity bill', owner: ids.isha, due: IST(day, '17:00') });
  await plan(id, IST(day, '09:00'));
  await sendDueTaskReminders(IST(day, '15:00'));
  failFor = 'spaces/dm-isha';
  await deliverOutbox();
  failFor = null;
  const told = await followUpFailedChats(IST(day, '15:05'));
  assert.equal(told.told, 1);
  await sendDueTaskReminders(IST(day, '15:06'));
  const n = (await query(`SELECT * FROM notifications WHERE task_id = $1 AND type = 'task_unreached'`, [id])).rows;
  assert.equal(n.length, 1);
  assert.equal(n[0].user_id, ids.raj);
  assert.match(n[0].title, /^Could not reach Isha Sample about/);
  assert.equal((await followUpFailedChats(IST(day, '15:10'))).told, 0, 'once');
});

test('opening the task acknowledges the reminders; the log says so', async (t) => {
  if (skip(t)) return;
  const day = addDays(D, 43);
  const id = await mkTask({ title: 'Ack check', owner: ids.isha, due: IST(day, '17:00') });
  await plan(id, IST(day, '09:00'));
  await sendDueTaskReminders(IST(day, '15:00'));
  ok(await call('GET', `/tasks/${id}`, { token: tokens.isha }));
  const log = ok(await call('GET', '/reminders/log?days=60', { token: tokens.isha }));
  const app = log.reminders.find((r) => r.task_id === id && r.channel === 'APP');
  assert.equal(app.state, 'ACKNOWLEDGED');
  const other = await call('GET', `/reminders/log?user_id=${ids.raj}`, { token: tokens.isha });
  assert.equal(other.status, 403, 'only your own log');
});

test('CRM follow-ups keep their own reminders: the general engine leaves them alone', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Call back the farmer', owner: ids.isha, due: IST(addDays(D, 44), '11:00'), followup: 'CALL' });
  await plan(id, IST(addDays(D, 44), '08:00'));
  assert.equal((await reminders(id)).length, 0);
});

test('13 and the coverage check: nothing unseen is missed, and every exception has its reason', async (t) => {
  if (skip(t)) return;
  const day = addDays(D, 49);
  // Kiran (Field) is not connected and has nobody to fall back on; Field has an unowned task and no summary space
  await mkTask({ title: 'Kiran site survey', owner: ids.kiran, dept: ids.fld, due: IST(day, '17:00') });
  await mkTask({ title: 'Unowned field job', owner: null, dept: ids.fld, due: IST(day, '17:00') });
  await queueSummaries(IST(day, '08:50'));
  await deliverOutbox({ limit: 500 });
  const report = await coverageReport({ now: IST(day, '11:00'), store: true });
  const unseen = new Map(report.unseen_tasks.map((u) => [u.title, u]));
  assert.ok(unseen.has('Kiran site survey'));
  assert.deepEqual(unseen.get('Kiran site survey').reasons, ['NOT_CONNECTED', 'NO_FALLBACK']);
  assert.ok(unseen.has('Unowned field job'));
  assert.deepEqual(unseen.get('Unowned field job').reasons, ['NO_OWNER']);
  assert.ok(report.departments_without_summary.some((d) => d.name === 'Field'), '13: flagged');
  // Ravi is not connected either, but his department manager's summary covered him
  const ravi = report.exceptions.find((e) => e.owner === 'Ravi Sample');
  assert.equal(ravi.status, 'SEEN');
  assert.ok(ravi.reasons.includes('NOT_CONNECTED'));
  assert.match(ravi.reached_by.join(), /covered in Meera Sample's summary/);
  // Isha's work reached her in Chat
  const ishaTask = report.exceptions.find((e) => e.owner === 'Isha Sample');
  assert.ok(!ishaTask || ishaTask.status === 'SEEN');
  assert.equal(report.unseen, report.unseen_tasks.length);
  assert.equal((await query('SELECT unseen FROM coverage_reports WHERE report_date = $1', [day])).rows[0].unseen, report.unseen, 'stored');

  const connections = ok(await call('GET', '/reminders/connections', { token: tokens.admin }));
  assert.ok(connections.departments_without_summary.some((d) => d.name === 'Field'));
  assert.equal(connections.people.find((p) => p.id === ids.kiran).connected, false);
  assert.equal((await call('GET', '/reminders/connections', { token: tokens.isha })).status, 403);
});

test('the weekly backlog review: on the first working day, Backlog with no review date or a review that has come, once a person', async (t) => {
  if (skip(t)) return;
  // the Monday after D
  let monday = addDays(D, 1);
  while (weekdayOf(monday) !== 1) monday = addDays(monday, 1);
  assert.equal(firstWorkingDayOfWeek(monday, [1, 2, 3, 4, 5, 6]), true);
  assert.equal(firstWorkingDayOfWeek(addDays(monday, 1), [1, 2, 3, 4, 5, 6]), false);
  assert.equal(firstWorkingDayOfWeek(addDays(monday, 1), [2, 3, 4, 5, 6]), true, 'Tuesday, when Monday is not a working day');
  await mkTask({ title: 'Backlog idea without a date', owner: ids.raj, due: null, stage: 'backlog' });
  await mkTask({ title: 'Backlog idea due for a look', owner: ids.raj, due: null, stage: 'backlog', review: addDays(monday, -2) });
  await queueBacklogReviews(IST(monday, '09:00'));
  const log = (await query(`SELECT * FROM reminder_summary_log WHERE log_key = $1`, [`backlog:${ids.raj}:${monday}`])).rows[0];
  assert.equal(log.status, 'QUEUED');
  const text = (await query('SELECT payload FROM chat_outbox WHERE dedupe_key = $1', [log.outbox_key])).rows[0].payload.text;
  assert.match(text, /\*Your review dates that have come \(\d+\)\*/);
  assert.match(text, /Backlog idea due for a look/);
  assert.match(text, /\*Your Backlog with no review date \(\d+\)\*/);
  assert.equal((await queueBacklogReviews(IST(monday, '10:00'))).queued, 0, 'once');
  assert.equal((await queueBacklogReviews(IST(addDays(monday, 1), '09:00'))).queued, 0, 'not on Tuesday');
});
