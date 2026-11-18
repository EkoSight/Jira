/**
 * Task reminders by email, beside the TaskFlow bell and Google Chat
 * (docs/DEADLINES_REMINDERS.md, "Email"). The brief's tests:
 *
 *   1   the planner adds EMAIL rows by each person's choice; "the bell only"
 *       plans no Chat and no email
 *   2   checked when sent: finished, handed over or re-dated means cancelled;
 *       quiet hours, leave and a holiday mean skipped, with the reason
 *   3   TEST mode: only the test administrator's emails go
 *   4   email not set up: nothing queued, skipped with the reason; Chat and
 *       the bell still work
 *   5   reminders falling due together go as one email; the eleventh email
 *       of a day is skipped
 *   6   a provider failure retries on schedule; once it gives up, the
 *       fallback person is told, once
 *   7   bounces: hard, three soft in a row, clearing the mark; never
 *       marketing events
 *   8   the morning summary by email: only to people Chat cannot reach by
 *       default, to anyone who chose both; logged with channel EMAIL; "all
 *       clear" only when asked for
 *   9   only a person's own login email
 *   10  Chat unchanged; "Chat, or email when Chat can't reach me" with no Chat
 *       gets the email, and the log says so
 *   11  CRM follow-ups and personal reminders by email when chosen, never by
 *       default
 *   12  the words: task ID, title, owner, due time in India time, health,
 *       next action, link; the footer links to My reminders; no unsubscribe
 *
 * Made-up people (example.com); email goes to the outbox stand-in only and
 * Google Chat is a stand-in that records what it was given.
 */
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool, withTransaction } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { setChatConfig, setChatTransport } from '../src/lib/googleChat.js';
import { updateSetting, getSettings } from '../src/services/settings.js';
import { outbox, clearOutbox, failNextSends } from '../src/services/marketing/providers.js';
import { recordEvent } from '../src/services/marketing/events.js';
import { planFallback, planTaskReminders, sendDueTaskReminders } from '../src/services/taskReminders.js';
import { queueSummaries } from '../src/services/taskSummaries.js';
import { coverageReport } from '../src/services/coverage.js';
import { followUpFailedEmails, queueEmailSummaries, sendEmailOutbox, RETRY_MINUTES } from '../src/services/reminderEmail.js';
import { planReminders, saveReminderPrefs, sendDueReminders } from '../src/services/sales/followupReminders.js';
import { sendDueOccurrences, planSweep } from '../src/services/workspace/reminders.js';
import { resetLimits } from '../src/lib/limits.js';
import { addDays, weekdayOf } from '../../shared/deadlineHealth.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const st = {};
const chatSent = [];

const IST = (date, hm) => new Date(`${date}T${hm}:00+05:30`);
const MIN = 60_000;
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
// reminder emails in the outbox stand-in (account emails and marketing are not counted)
const mails = (to = null) => outbox().filter((m) => String(m.reference || '').startsWith('rem-') && (!to || m.to === to));

// working days in the future: a Wednesday at least a week ahead, then the weeks after
let D = addDays(new Date().toISOString().slice(0, 10), 8);
while (weekdayOf(D) !== 3) D = addDays(D, 1);
const day = (n) => addDays(D, 7 * n); // each test its own Wednesday, so daily limits never mix

let refN = 0;
async function mkTask({ title, owner, due, stage = 'todo', next = null, followup = null }) {
  refN += 1;
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date, original_due_date, next_action, followup_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, $8, $9) RETURNING id`,
    [`EM-${refN}`, title, ids.ops, st[stage], owner, ids.admin, due, next, followup],
  );
  return rows[0].id;
}
const plan = (taskId, now) => withTransaction((client) => planTaskReminders(client, taskId, { now }));
const rowsOf = async (taskId) => (await query('SELECT * FROM task_reminders WHERE task_id = $1 ORDER BY remind_at, kind, user_id, channel', [taskId])).rows;
const reminders = async (settings) => updateSetting('reminders', { ...(await getSettings()).reminders, ...settings }, ids.admin);
const SENDER = { senderName: 'TaskFlow', senderEmail: 'reminders@example.com', replyTo: '', expiryHours: 24, forgotPassword: true };
const emailOn = () => updateSetting('accountEmails', SENDER, ids.admin);
const emailOff = () => updateSetting('accountEmails', { ...SENDER, senderEmail: '' }, ids.admin);
const choose = (userId, taskReminders, summaries = 'CHAT_ELSE_EMAIL', allClear = false) => query(
  `INSERT INTO reminder_channel_prefs (user_id, task_reminders, summaries, summary_all_clear) VALUES ($1, $2, $3, $4)
   ON CONFLICT (user_id) DO UPDATE SET task_reminders = EXCLUDED.task_reminders, summaries = EXCLUDED.summaries, summary_all_clear = EXCLUDED.summary_all_clear`,
  [userId, taskReminders, summaries, allClear],
);
// back to the organisation's defaults
const unchoose = (userIds) => query(
  `UPDATE reminder_channel_prefs SET task_reminders = 'BOTH', summaries = 'CHAT_ELSE_EMAIL', summary_all_clear = FALSE WHERE user_id = ANY($1::int[])`,
  [userIds],
);
const channelsOf = (rows, userId, kind) => rows.filter((r) => r.user_id === userId && r.kind === kind).map((r) => r.channel).sort();

before(async () => {
  setChatConfig({ clientEmail: 'taskflow-chat@demo.iam.gserviceaccount.com', privateKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), projectId: 'demo', projectNumber: '1', audience: 'https://x.test/e' });
  setChatTransport(async (space, message) => { chatSent.push({ space, message }); return { name: `${space}/messages/${chatSent.length}` }; });
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1)`);
  ids.ops = (await query(`SELECT id FROM departments WHERE key = 'OPS'`)).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) st[r.stage] = r.id;
  const password = await hashPassword('Password123!');
  // [key, role, connected to Google Chat]
  const people = [
    ['admin', 'admin', true], ['isha', 'member', true], ['raj', 'manager', true], ['kiran', 'member', false],
    ['noa', 'member', true], ['cap', 'member', true], ['sam', 'member', false], ['ben', 'member', true], ['quiet', 'member', true],
  ];
  for (const [key, role, connected] of people) {
    const email = `${key}.sample@example.com`;
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, email, password, role, ids.ops],
    );
    ids[key] = rows[0].id;
    ids[`${key}_email`] = email;
    if (connected) await query(`INSERT INTO chat_spaces (space_name, kind, user_id, added_by_email, active) VALUES ($1, 'DM', $2, $3, TRUE)`, [`spaces/dm-${key}`, rows[0].id, email]);
  }
  // Raj is everyone's reporting manager here
  for (const key of ['isha', 'kiran', 'noa', 'cap', 'sam', 'ben', 'quiet']) {
    await query(`INSERT INTO employee_work_profiles (user_id, reporting_manager_id) VALUES ($1, $2)`, [ids[key], ids.raj]);
  }
  await updateSetting('googleChat', { ...(await getSettings()).googleChat, enabled: true }, ids.admin);
  await reminders({ mode: 'LIVE', testRecipientId: ids.admin });
  await emailOn();
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'isha', 'kiran', 'raj']) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: ids[`${key}_email`], password: 'Password123!' } })).token;
});

// each test starts clean: nothing left pending from the one before
afterEach(async () => {
  if (!available) return;
  await query(`UPDATE task_reminders SET status = 'CANCELLED', reason = 'end of test' WHERE status IN ('PENDING', 'SENDING')`);
  await query(`UPDATE email_outbox SET status = 'CANCELLED', last_error = 'end of test' WHERE status = 'PENDING'`);
  await query(`UPDATE crm_followup_reminders SET status = 'CANCELLED' WHERE status = 'PENDING'`);
  clearOutbox();
  failNextSends([]);
  resetLimits();
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('1: the planner adds EMAIL beside the bell and Chat, by each person\'s choice; "the bell only" plans neither', async (t) => {
  if (skip(t)) return;
  const d = day(0);
  // Isha: no choice made, so the organisation's default (Chat and email)
  const a = await mkTask({ title: 'Sample price list', owner: ids.isha, due: IST(d, '17:00') });
  await plan(a, IST(d, '09:00'));
  let rows = await rowsOf(a);
  assert.deepEqual(channelsOf(rows, ids.isha, 'BEFORE_DUE'), ['APP', 'CHAT', 'EMAIL']);
  assert.deepEqual(channelsOf(rows, ids.isha, 'AT_DUE'), ['APP', 'CHAT', 'EMAIL']);
  // the manager's notice after the grace period, by email too (owner decision 3)
  assert.deepEqual(channelsOf(rows, ids.raj, 'AFTER_GRACE'), ['APP', 'CHAT', 'EMAIL']);

  // "the bell only": no Chat, no email; "email only": the bell and email
  await choose(ids.ben, 'BELL');
  await choose(ids.noa, 'EMAIL');
  const b = await mkTask({ title: 'Sample stock count', owner: ids.ben, due: IST(d, '17:00') });
  const c = await mkTask({ title: 'Sample site photos', owner: ids.noa, due: IST(d, '17:00') });
  await plan(b, IST(d, '09:00'));
  await plan(c, IST(d, '09:00'));
  assert.deepEqual(channelsOf(await rowsOf(b), ids.ben, 'AT_DUE'), ['APP']);
  assert.deepEqual(channelsOf(await rowsOf(c), ids.noa, 'AT_DUE'), ['APP', 'EMAIL']);

  // manager notices by email switched off: the manager keeps the bell and Chat
  await reminders({ email: { ...(await getSettings()).reminders.email, managerNotices: false } });
  const e = await mkTask({ title: 'Sample invoice check', owner: ids.isha, due: IST(d, '16:00') });
  await plan(e, IST(d, '09:00'));
  assert.deepEqual(channelsOf(await rowsOf(e), ids.raj, 'AFTER_GRACE'), ['APP', 'CHAT']);
  await reminders({ email: { ...(await getSettings()).reminders.email, managerNotices: true } });

  // COVER: the owner is away, so their fallback person is told, by email too
  const f = await mkTask({ title: 'Sample cover job', owner: ids.isha, due: IST(d, '18:00') });
  await withTransaction(async (client) => {
    const { rows: [task] } = await client.query('SELECT * FROM tasks WHERE id = $1', [f]);
    await planFallback(client, task, 'COVER', 'on approved leave', IST(d, '10:00'));
  });
  assert.deepEqual(channelsOf(await rowsOf(f), ids.raj, 'COVER'), ['APP', 'CHAT', 'EMAIL']);
  await unchoose([ids.ben, ids.noa]);
});

test('2: an email for a finished, handed-over or re-dated task is cancelled; quiet hours, leave and a holiday skip it with the reason', async (t) => {
  if (skip(t)) return;
  const d = day(1);
  const done = await mkTask({ title: 'Sample finished task', owner: ids.isha, due: IST(d, '12:00') });
  const handed = await mkTask({ title: 'Sample handed task', owner: ids.isha, due: IST(d, '12:00') });
  const redated = await mkTask({ title: 'Sample re-dated task', owner: ids.isha, due: IST(d, '12:00') });
  for (const id of [done, handed, redated]) await plan(id, IST(d, '08:00'));
  await query('UPDATE tasks SET status_id = $2 WHERE id = $1', [done, st.done]);
  await query('UPDATE tasks SET assignee_id = $2 WHERE id = $1', [handed, ids.noa]);
  await query(`UPDATE tasks SET due_date = due_date + interval '1 day' WHERE id = $1`, [redated]);
  await sendDueTaskReminders(IST(d, '10:01'));
  const email = async (id) => (await rowsOf(id)).find((r) => r.channel === 'EMAIL' && r.kind === 'BEFORE_DUE');
  assert.equal((await email(done)).status, 'CANCELLED');
  assert.equal((await email(done)).reason, 'The task is done');
  assert.equal((await email(handed)).status, 'CANCELLED');
  assert.equal((await email(handed)).reason, 'The task was handed to someone else');
  assert.equal((await email(redated)).status, 'CANCELLED');
  assert.equal((await email(redated)).reason, 'The deadline changed');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM email_outbox WHERE local_date = $1', [d])).rows[0].n, 0, 'nothing queued');

  // finished while the email was waiting to go: left out, and the email not sent
  const late = await mkTask({ title: 'Sample closed in time', owner: ids.isha, due: IST(d, '15:00') });
  await plan(late, IST(d, '08:00'));
  await sendDueTaskReminders(IST(d, '13:00'));
  const queued = (await rowsOf(late)).find((r) => r.channel === 'EMAIL' && r.kind === 'BEFORE_DUE');
  assert.equal(queued.status, 'SENT');
  await query('UPDATE tasks SET status_id = $2 WHERE id = $1', [late, st.done]);
  const out = await sendEmailOutbox(IST(d, '13:05'));
  assert.equal(out.sent, 0);
  assert.equal(mails().length, 0, 'no email reminded anyone of a finished task');
  const after = (await query('SELECT * FROM task_reminders WHERE id = $1', [queued.id])).rows[0];
  assert.equal(after.status, 'CANCELLED');
  assert.match(after.reason, /^The task is done before the email went/);
  assert.equal((await query('SELECT status FROM email_outbox WHERE dedupe_key = $1', [queued.outbox_key])).rows[0].status, 'CANCELLED');

  // quiet hours
  const night = await mkTask({ title: 'Sample late task', owner: ids.isha, due: IST(d, '22:00') });
  await plan(night, IST(d, '08:00'));
  await sendDueTaskReminders(IST(d, '20:01'));
  const q = (await rowsOf(night)).find((r) => r.channel === 'EMAIL' && r.kind === 'BEFORE_DUE');
  assert.equal(q.status, 'SKIPPED');
  assert.match(q.reason, /^Quiet hours \(20:00–08:30\)/);

  // on leave
  const leaveDay = addDays(d, 1);
  await query(
    `INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status) VALUES ($1, 'CASUAL', $2, $2, 'Sample leave', 'APPROVED_PAID')`,
    [ids.quiet, leaveDay],
  );
  await query(`INSERT INTO user_availability (user_id, status, start_date, end_date, note) VALUES ($1, 'ON_LEAVE', $2, $2, 'Sample leave')`, [ids.quiet, leaveDay]);
  const onLeave = await mkTask({ title: 'Sample leave task', owner: ids.quiet, due: IST(leaveDay, '17:00') });
  await plan(onLeave, IST(d, '12:00'));
  await sendDueTaskReminders(IST(leaveDay, '15:01'));
  const l = (await rowsOf(onLeave)).find((r) => r.channel === 'EMAIL' && r.kind === 'BEFORE_DUE' && r.user_id === ids.quiet);
  assert.equal(l.status, 'SKIPPED');
  assert.match(l.reason, /^Away: on approved leave/);

  // a company holiday
  const holiday = addDays(d, 2);
  await query(`INSERT INTO work_holidays (holiday_date, name) VALUES ($1, 'Sample Day')`, [holiday]);
  const h = await mkTask({ title: 'Sample holiday task', owner: ids.isha, due: IST(holiday, '17:00') });
  await plan(h, IST(d, '12:00'));
  await sendDueTaskReminders(IST(holiday, '15:01'));
  const hr = (await rowsOf(h)).find((r) => r.channel === 'EMAIL' && r.kind === 'BEFORE_DUE' && r.user_id === ids.isha);
  assert.equal(hr.status, 'SKIPPED');
  assert.match(hr.reason, /^Away: a holiday \(Sample Day\)/);
  assert.equal(mails().length, 0);
});

test('3: TEST mode: only the test administrator\'s emails go; everyone else\'s are "would send" and never queued', async (t) => {
  if (skip(t)) return;
  const d = day(2);
  await reminders({ mode: 'TEST', testRecipientId: ids.admin });
  try {
    const theirs = await mkTask({ title: 'Sample member task', owner: ids.isha, due: IST(d, '12:00') });
    const mine = await mkTask({ title: 'Sample admin task', owner: ids.admin, due: IST(d, '12:00') });
    await plan(theirs, IST(d, '08:00'));
    await plan(mine, IST(d, '08:00'));
    await sendDueTaskReminders(IST(d, '10:01'));
    const isha = (await rowsOf(theirs)).find((r) => r.channel === 'EMAIL' && r.kind === 'BEFORE_DUE');
    assert.equal(isha.status, 'WOULD_SEND');
    assert.equal(isha.outbox_key, null);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM email_outbox WHERE user_id = $1 AND local_date = $2', [ids.isha, d])).rows[0].n, 0);
    await sendEmailOutbox(IST(d, '10:05'));
    assert.equal(mails(ids.isha_email).length, 0);
    const adminMail = mails(ids.admin_email);
    assert.equal(adminMail.length, 1);
    assert.match(adminMail[0].subject, /^TEST · Due in 2 hours: EM-\d+ Sample admin task$/);
  } finally {
    await reminders({ mode: 'LIVE' });
  }
});

test('4: email not set up: nothing queued, skipped with the reason and no claim of sending; Chat and the bell still go', async (t) => {
  if (skip(t)) return;
  const d = day(3);
  const id = await mkTask({ title: 'Sample setup task', owner: ids.isha, due: IST(d, '12:00') });
  await plan(id, IST(d, '08:00')); // planned while email was set up
  await emailOff();
  try {
    // planned afresh now: no email rows at all
    const other = await mkTask({ title: 'Sample no email task', owner: ids.isha, due: IST(d, '12:00') });
    await plan(other, IST(d, '08:00'));
    assert.deepEqual(channelsOf(await rowsOf(other), ids.isha, 'BEFORE_DUE'), ['APP', 'CHAT']);
    await sendDueTaskReminders(IST(d, '10:01'));
    const rows = (await rowsOf(id)).filter((r) => r.kind === 'BEFORE_DUE');
    const email = rows.find((r) => r.channel === 'EMAIL');
    assert.equal(email.status, 'SKIPPED');
    assert.match(email.reason, /^Email is not set up \(No sender address for account emails yet \(Settings → Email\)\)/);
    assert.equal(email.sent_at, null);
    assert.equal(rows.find((r) => r.channel === 'APP').status, 'SENT');
    assert.equal(rows.find((r) => r.channel === 'CHAT').status, 'SENT');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM email_outbox WHERE user_id = $1 AND local_date = $2', [ids.isha, d])).rows[0].n, 0);
    // and the summaries by email queue nothing, and log nothing
    assert.equal((await queueEmailSummaries(IST(d, '09:05'))).queued, 0);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM reminder_summary_log WHERE channel = 'EMAIL' AND summary_date = $1`, [d])).rows[0].n, 0);
  } finally {
    await emailOn();
  }
});

test('5: reminders falling due together go as one email listing each task; the eleventh email of a day is skipped', async (t) => {
  if (skip(t)) return;
  const d = day(4);
  const three = [];
  for (const n of [1, 2, 3]) three.push(await mkTask({ title: `Sample batch ${n}`, owner: ids.noa, due: IST(d, `12:0${n}`) }));
  for (const id of three) await plan(id, IST(d, '08:00'));
  // the worker ticks each minute: 10:01, 10:02, 10:03; the email waits 3 minutes for the others
  await sendDueTaskReminders(IST(d, '10:01'));
  await sendEmailOutbox(IST(d, '10:01'));
  await sendDueTaskReminders(IST(d, '10:02'));
  await sendDueTaskReminders(IST(d, '10:03'));
  await sendEmailOutbox(IST(d, '10:03'));
  assert.equal(mails(ids.noa_email).length, 0, 'still waiting for the others');
  await sendEmailOutbox(IST(d, '10:05'));
  const got = mails(ids.noa_email);
  assert.equal(got.length, 1, 'one email, not three');
  assert.match(got[0].subject, /^3 task reminders: Due in 2 hours: EM-\d+ Sample batch 1 and 2 more$/);
  for (const n of [1, 2, 3]) assert.match(got[0].text, new RegExp(`Sample batch ${n}`));
  const emailRows = [];
  for (const id of three) emailRows.push((await rowsOf(id)).find((r) => r.channel === 'EMAIL' && r.kind === 'BEFORE_DUE'));
  assert.ok(emailRows.every((r) => r.status === 'SENT'), 'one log row each');
  assert.equal(new Set(emailRows.map((r) => r.outbox_key)).size, 1, 'all in the one email');
  const log = ok(await call('GET', `/reminders/log?user_id=${ids.noa}`, { token: tokens.admin }));
  assert.equal(log.reminders.filter((r) => r.channel === 'EMAIL' && r.state === 'SENT').length, 3);

  // the daily limit (10): eleven separate emails in a day, only at the deadline
  await reminders({ beforeDueHours: 0, managerNotice: false });
  try {
    const tasks = [];
    for (let n = 0; n < 11; n += 1) {
      const hm = `${String(10 + Math.floor(n / 2)).padStart(2, '0')}:${n % 2 ? '30' : '00'}`;
      tasks.push(await mkTask({ title: `Sample capped ${n + 1}`, owner: ids.cap, due: IST(d, hm) }));
    }
    for (const id of tasks) await plan(id, IST(d, '08:00'));
    for (let n = 0; n < 11; n += 1) {
      const at = IST(d, `${String(10 + Math.floor(n / 2)).padStart(2, '0')}:${n % 2 ? '30' : '00'}`);
      await sendDueTaskReminders(new Date(at.getTime() + 1000));
      await sendEmailOutbox(new Date(at.getTime() + 4 * MIN));
    }
    assert.equal(mails(ids.cap_email).length, 10);
    const eleventh = (await rowsOf(tasks[10])).find((r) => r.channel === 'EMAIL');
    assert.equal(eleventh.status, 'SKIPPED');
    assert.equal(eleventh.reason, 'Daily email limit reached (10); the next morning summary carries it');
    assert.equal((await rowsOf(tasks[10])).find((r) => r.channel === 'APP').status, 'SENT', 'the bell still carries it');
  } finally {
    await reminders({ beforeDueHours: 2, managerNotice: true });
  }
});

test('6: a failed send retries after 1, 5, 30 and 120 minutes, then fails; the fallback person is told once', async (t) => {
  if (skip(t)) return;
  const d = day(5);
  const id = await mkTask({ title: 'Sample retry task', owner: ids.isha, due: IST(d, '14:00') });
  await plan(id, IST(d, '08:00'));
  await sendDueTaskReminders(IST(d, '12:01'));
  const r = (await rowsOf(id)).find((x) => x.channel === 'EMAIL' && x.kind === 'BEFORE_DUE');
  const row = async () => (await query('SELECT * FROM email_outbox WHERE dedupe_key = $1', [r.outbox_key])).rows[0];
  failNextSends(Array.from({ length: 5 }, () => ({ message: 'Sample service unavailable', transient: true })));
  let at = new Date(IST(d, '12:01').getTime() + 4 * MIN);
  for (const wait of RETRY_MINUTES) {
    await sendEmailOutbox(at);
    const now = await row();
    assert.equal(now.status, 'PENDING');
    assert.equal(new Date(now.next_attempt_at).getTime(), at.getTime() + wait * MIN, `retry after ${wait} minutes`);
    // nothing goes before the next attempt is due
    await sendEmailOutbox(new Date(at.getTime() + (wait * MIN) / 2));
    assert.equal((await row()).attempts, RETRY_MINUTES.indexOf(wait) + 1);
    at = new Date(at.getTime() + wait * MIN);
  }
  await sendEmailOutbox(at);
  const failed = await row();
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.attempts, 5);
  assert.equal(failed.last_error, 'Sample service unavailable');
  assert.equal((await query('SELECT status FROM task_reminders WHERE id = $1', [r.id])).rows[0].status, 'SENT', 'handed to the email service; the outbox says it failed');
  const log = ok(await call('GET', `/reminders/task/${id}`, { token: tokens.admin }));
  assert.equal(log.reminders.find((x) => x.id === r.id).state, 'FAILED');

  await followUpFailedEmails(at);
  await followUpFailedEmails(at);
  const unreached = (await rowsOf(id)).filter((x) => x.kind === 'UNREACHED');
  assert.ok(unreached.length >= 1);
  assert.ok(unreached.every((x) => x.user_id === ids.raj), 'the fallback person');
  assert.equal(new Set(unreached.map((x) => x.channel)).size, unreached.length, 'once per channel, however often it runs');
  assert.match(unreached[0].reason, /^Email: Sample service unavailable/);
  await sendDueTaskReminders(new Date(at.getTime() + MIN));
  const bell = (await query(`SELECT * FROM notifications WHERE user_id = $1 AND task_id = $2 AND type = 'task_unreached'`, [ids.raj, id])).rows;
  assert.equal(bell.length, 1);
  assert.match(bell[0].body, /could not be delivered by email \(Sample service unavailable\)/);
});

test('7: bounces: a hard bounce stops reminder emails, three soft ones do too, clearing resumes; never a marketing event', async (t) => {
  if (skip(t)) return;
  const d = day(6);
  const id = await mkTask({ title: 'Sample bounce task', owner: ids.ben, due: IST(d, '14:00') });
  await plan(id, IST(d, '08:00'));
  await sendDueTaskReminders(IST(d, '12:01'));
  await sendEmailOutbox(IST(d, '12:05'));
  const sentMail = mails(ids.ben_email)[0];
  assert.ok(sentMail);
  const mktBefore = (await query('SELECT COUNT(*)::int AS n FROM mkt_events')).rows[0].n;

  const r1 = await recordEvent({ type: 'BOUNCE_HARD', reference: sentMail.reference, email: ids.ben_email, providerEventId: 'sample:hard:1', diagnostic: '550 no such user', source: 'PROVIDER:ses' });
  assert.equal(r1.system, true);
  assert.equal(r1.effect, 'undeliverable');
  const ben = (await query('SELECT * FROM users WHERE id = $1', [ids.ben])).rows[0];
  assert.ok(ben.email_undeliverable_at);
  assert.match(ben.email_undeliverable_reason, /the address bounced: 550 no such user/);
  // the person and the administrators are told in the app
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'email_undeliverable'`, [ids.ben])).rows[0].n, 1);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'email_undeliverable'`, [ids.admin])).rows[0].n, 1);
  // the same report again changes nothing
  assert.equal((await recordEvent({ type: 'BOUNCE_HARD', reference: sentMail.reference, email: ids.ben_email, providerEventId: 'sample:hard:1' })).duplicate, true);

  // no more reminder emails: not planned, and one already planned is skipped
  const next = await mkTask({ title: 'Sample after bounce', owner: ids.ben, due: IST(d, '17:00') });
  await plan(next, IST(d, '08:00'));
  assert.deepEqual(channelsOf(await rowsOf(next), ids.ben, 'AT_DUE'), ['APP', 'CHAT']);
  const pre = (await rowsOf(id)).find((x) => x.channel === 'EMAIL' && x.kind === 'AT_DUE');
  await sendDueTaskReminders(IST(d, '14:01'));
  const skipped = (await query('SELECT * FROM task_reminders WHERE id = $1', [pre.id])).rows[0];
  assert.equal(skipped.status, 'SKIPPED');
  assert.match(skipped.reason, /^Their email address bounced/);

  // an administrator clears it on the Team page; reminder emails resume
  ok(await call('POST', `/users/${ids.ben}/clear-email-bounce`, { token: tokens.admin }));
  assert.equal((await query('SELECT email_undeliverable_at FROM users WHERE id = $1', [ids.ben])).rows[0].email_undeliverable_at, null);
  await plan(next, IST(d, '08:01'));
  assert.deepEqual(channelsOf(await rowsOf(next), ids.ben, 'AT_DUE'), ['APP', 'CHAT', 'EMAIL']);

  // three soft bounces in a row count as hard; a delivery in between resets the count
  const soft = (n) => recordEvent({ type: 'BOUNCE_SOFT', reference: sentMail.reference, email: ids.ben_email, providerEventId: `sample:soft:${n}` });
  await soft(1);
  await soft(2);
  await recordEvent({ type: 'DELIVERED', reference: sentMail.reference, email: ids.ben_email, providerEventId: 'sample:delivered:1' });
  await soft(3);
  await soft(3); // the same report twice counts once
  assert.equal((await query('SELECT email_undeliverable_at FROM users WHERE id = $1', [ids.ben])).rows[0].email_undeliverable_at, null);
  await soft(4);
  await soft(5);
  const after = (await query('SELECT * FROM users WHERE id = $1', [ids.ben])).rows[0];
  assert.ok(after.email_undeliverable_at);
  assert.match(after.email_undeliverable_reason, /^three deliveries in a row failed/);

  // by provider message id alone (no reference) it is still a system report
  await call('POST', `/users/${ids.ben}/clear-email-bounce`, { token: tokens.admin });
  const viaId = await recordEvent({ type: 'COMPLAINT', providerMessageId: sentMail.providerMessageId, email: ids.ben_email, providerEventId: 'sample:complaint:1' });
  assert.equal(viaId.system, true);
  assert.equal(viaId.effect, 'undeliverable');
  await call('POST', `/users/${ids.ben}/clear-email-bounce`, { token: tokens.admin });

  // never marketing: no marketing events, and not in marketing's outbox list
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM mkt_events')).rows[0].n, mktBefore);
  const mkt = await call('GET', '/marketing/dev/outbox', { token: tokens.admin });
  if (mkt.status === 200) assert.ok(!(mkt.body.messages || []).some((m) => /Sample bounce task/.test(m.subject || '')));
});

test('8: the morning summary by email: to people Chat cannot reach, to anyone who chose both; logged as EMAIL; all clear only when asked', async (t) => {
  if (skip(t)) return;
  const d = day(7);
  // Kiran: not connected; Noa: connected but chose both; Isha: connected, default
  const k = await mkTask({ title: 'Sample Kiran job', owner: ids.kiran, due: IST(d, '16:00') });
  await mkTask({ title: 'Sample Noa job', owner: ids.noa, due: IST(d, '16:00') });
  await mkTask({ title: 'Sample Isha job', owner: ids.isha, due: IST(d, '16:00') });
  await choose(ids.noa, 'BOTH', 'BOTH');
  await choose(ids.quiet, 'BOTH', 'CHAT_ELSE_EMAIL', true); // nothing open, asked for "all clear" (but Chat reaches them)
  await choose(ids.sam, 'BOTH', 'CHAT_ELSE_EMAIL', false); // nothing open, not connected, did not ask
  const at = IST(d, '09:05');
  await queueSummaries(at); // the Chat summaries, as the Chat worker does
  await queueEmailSummaries(at);
  await queueEmailSummaries(at); // twice: still once a person
  const logs = (await query(`SELECT * FROM reminder_summary_log WHERE summary_date = $1 AND kind = 'PERSONAL' ORDER BY user_id, channel`, [d])).rows;
  const emailed = logs.filter((l) => l.channel === 'EMAIL');
  assert.deepEqual(emailed.filter((l) => l.status === 'EMAILED').map((l) => l.user_id).sort(), [ids.kiran, ids.noa].sort());
  assert.ok(!emailed.some((l) => l.user_id === ids.isha), 'Chat carries Isha\'s; no email');
  assert.ok(!emailed.some((l) => l.user_id === ids.quiet), 'Chat reaches them, so no email at all');
  const samRow = emailed.find((l) => l.user_id === ids.sam);
  assert.equal(samRow.status, 'SKIPPED', '"all clear" is not emailed unless asked for');
  assert.match(samRow.reason, /^Nothing to say/);
  // every Chat row still reads CHAT
  assert.ok(logs.filter((l) => l.channel !== 'EMAIL').length >= 3);
  assert.ok(logs.filter((l) => !l.log_key.includes('-email:')).every((l) => l.channel === 'CHAT'));

  await sendEmailOutbox(new Date(at.getTime() + MIN));
  const kMail = mails(ids.kiran_email);
  assert.equal(kMail.length, 1);
  assert.match(kMail[0].subject, /^Your TaskFlow day: 1 due today$/);
  assert.match(kMail[0].text, /Good morning, Kiran/);
  assert.match(kMail[0].text, /Sample Kiran job/);
  assert.match(kMail[0].text, /Open My tasks: http/);
  assert.match(kMail[0].html, /<a href="[^"]+\?task=\d+"/);
  assert.equal(mails(ids.noa_email).length, 1);

  // an email summary the email service took counts in the coverage check
  const report = await coverageReport({ now: new Date(at.getTime() + 2 * MIN) });
  const entry = report.exceptions.find((e) => e.task_id === k) || null;
  assert.ok(!report.unseen_tasks.some((e) => e.task_id === k), 'Kiran\'s task is seen, by email');
  if (entry) assert.ok(entry.reached_by.includes('owner\'s summary by email'));

  // someone who asked for "all clear" and Chat cannot reach gets one
  await choose(ids.sam, 'BOTH', 'CHAT_ELSE_EMAIL', true);
  const d2 = addDays(d, 1);
  await queueEmailSummaries(IST(d2, '09:05'));
  await sendEmailOutbox(IST(d2, '09:06'));
  const allClear = mails(ids.sam_email);
  assert.equal(allClear.length, 1);
  assert.equal(allClear[0].subject, 'Your TaskFlow day: all clear');
  await unchoose([ids.noa, ids.quiet, ids.sam]);
});

test('9: reminder emails go only to the person\'s own login email, as it is when the email goes', async (t) => {
  if (skip(t)) return;
  const d = day(8);
  const id = await mkTask({ title: 'Sample address task', owner: ids.isha, due: IST(d, '14:00') });
  await plan(id, IST(d, '08:00'));
  await sendDueTaskReminders(IST(d, '12:01'));
  // the login email changes while the email waits
  const changed = (await rowsOf(id)).find((r) => r.channel === 'EMAIL' && r.kind === 'BEFORE_DUE').outbox_key;
  await query(`UPDATE users SET email = 'isha.new.sample@example.com' WHERE id = $1`, [ids.isha]);
  try {
    await sendEmailOutbox(IST(d, '12:05'));
    assert.equal(mails('isha.new.sample@example.com').length, 1);
    assert.equal(mails(ids.isha_email).length, 0);
  } finally {
    await query('UPDATE users SET email = $2 WHERE id = $1', [ids.isha, ids.isha_email]);
  }
  // every reminder email sent in these tests went to a TaskFlow user's own login email
  const { rows } = await query(`SELECT e.to_address, u.email FROM email_outbox e JOIN users u ON u.id = e.user_id WHERE e.status = 'SENT' AND e.dedupe_key <> $1`, [changed]);
  assert.ok(rows.length > 5);
  for (const r of rows) assert.equal(r.to_address.toLowerCase(), r.email.toLowerCase());
  const logins = new Set((await query('SELECT lower(email) AS e FROM users')).rows.map((r) => r.e));
  const { rows: all } = await query(`SELECT DISTINCT lower(to_address) AS a FROM email_outbox WHERE dedupe_key <> $1`, [changed]);
  for (const r of all) assert.ok(logins.has(r.a), `${r.a} is a login email`);
});

test('10: Chat unchanged; "Chat, or email when Chat can\'t reach me" with no Chat gets the email, and the log says email carried it', async (t) => {
  if (skip(t)) return;
  const d = day(9);
  await choose(ids.sam, 'CHAT_ELSE_EMAIL');
  await choose(ids.noa, 'CHAT_ELSE_EMAIL');
  const s = await mkTask({ title: 'Sample Sam job', owner: ids.sam, due: IST(d, '14:00') });
  const n = await mkTask({ title: 'Sample Noa chat job', owner: ids.noa, due: IST(d, '14:00') });
  await plan(s, IST(d, '08:00'));
  await plan(n, IST(d, '08:00'));
  await sendDueTaskReminders(IST(d, '12:01'));
  const sam = (await rowsOf(s)).filter((r) => r.kind === 'BEFORE_DUE');
  assert.equal(sam.find((r) => r.channel === 'CHAT').status, 'SKIPPED');
  assert.equal(sam.find((r) => r.channel === 'CHAT').reason, 'Not connected to Google Chat; email and the TaskFlow bell carried it');
  assert.equal(sam.find((r) => r.channel === 'EMAIL').status, 'SENT');
  // Noa is connected: Chat carries it, so no email
  const noa = (await rowsOf(n)).filter((r) => r.kind === 'BEFORE_DUE');
  assert.equal(noa.find((r) => r.channel === 'CHAT').status, 'SENT');
  assert.equal(noa.find((r) => r.channel === 'EMAIL').status, 'SKIPPED');
  assert.equal(noa.find((r) => r.channel === 'EMAIL').reason, 'Google Chat carried it');
  await sendEmailOutbox(IST(d, '12:05'));
  assert.equal(mails(ids.sam_email).length, 1);
  assert.equal(mails(ids.noa_email).length, 0);
  await unchoose([ids.sam, ids.noa]);
});

test('11: CRM follow-ups and personal reminders by email only when chosen, never by default', async (t) => {
  if (skip(t)) return;
  const d = day(10);
  const due = IST(d, '11:00');
  const fu = await mkTask({ title: 'Sample call back', owner: ids.isha, due, followup: 'CALL' });
  await withTransaction((client) => planReminders(client, fu, { now: IST(d, '08:00') }));
  let planned = (await query('SELECT channel FROM crm_followup_reminders WHERE task_id = $1 AND status = $2', [fu, 'PENDING'])).rows;
  assert.deepEqual([...new Set(planned.map((r) => r.channel))], ['APP'], 'by default: in TaskFlow only');
  await saveReminderPrefs(ids.isha, { offsets: [15], channels: ['APP', 'EMAIL'] });
  await withTransaction((client) => planReminders(client, fu, { now: IST(d, '08:00') }));
  planned = (await query('SELECT channel FROM crm_followup_reminders WHERE task_id = $1 AND status = $2 ORDER BY channel', [fu, 'PENDING'])).rows;
  assert.deepEqual(planned.map((r) => r.channel), ['APP', 'EMAIL']);
  await sendDueReminders(new Date(due.getTime() - 15 * MIN + 1000));
  const emailRow = (await query(`SELECT * FROM crm_followup_reminders WHERE task_id = $1 AND channel = 'EMAIL'`, [fu])).rows[0];
  assert.equal(emailRow.status, 'SENT', emailRow.last_error);
  await sendEmailOutbox(new Date(due.getTime() - 14 * MIN));
  const fMail = mails(ids.isha_email).filter((m) => /Sample call back/.test(m.subject));
  assert.equal(fMail.length, 1);
  assert.match(fMail[0].subject, /^In 15 min: Sample call back$/);
  await saveReminderPrefs(ids.isha, { offsets: [15], channels: ['APP'] });

  // personal reminders: the bell (and Chat) by default; email once "Email me" is on
  clearOutbox();
  const task = await mkTask({ title: 'Sample personal task', owner: ids.kiran, due: IST(d, '17:00') });
  const remindAt = new Date(Date.now() + 2 * MIN).toISOString();
  ok(await call('POST', '/workspace/reminders/personal', { token: tokens.kiran, body: { entity_type: 'TASK', entity_id: task, remind_at: remindAt } }), 201);
  await planSweep();
  await sendDueOccurrences(new Date(Date.now() + 3 * MIN));
  let occ = (await query(`SELECT * FROM reminder_occurrences WHERE recipient_id = $1 AND rule_key = 'PERSONAL' ORDER BY id DESC LIMIT 1`, [ids.kiran])).rows[0];
  assert.equal(occ.status, 'SENT');
  assert.equal(occ.email_outbox_key, null, 'not by email unless chosen');

  ok(await call('PUT', '/workspace/reminders/rules/PERSONAL', { token: tokens.kiran, body: { enabled: true, email: true } }));
  const mine = ok(await call('GET', '/workspace/reminders', { token: tokens.kiran }));
  assert.equal(mine.rules.find((r) => r.key === 'PERSONAL').email, true);
  ok(await call('POST', '/workspace/reminders/personal', { token: tokens.kiran, body: { entity_type: 'TASK', entity_id: task, remind_at: new Date(Date.now() + 2 * MIN).toISOString() } }), 201);
  await planSweep();
  await sendDueOccurrences(new Date(Date.now() + 3 * MIN));
  occ = (await query(`SELECT * FROM reminder_occurrences WHERE recipient_id = $1 AND rule_key = 'PERSONAL' ORDER BY id DESC LIMIT 1`, [ids.kiran])).rows[0];
  assert.equal(occ.status, 'SENT');
  assert.ok(occ.email_outbox_key, occ.reason);
  await sendEmailOutbox(new Date(Date.now() + 7 * MIN));
  assert.equal(mails(ids.kiran_email).length, 1);
  assert.match(mails(ids.kiran_email)[0].subject, /Sample personal task/);
  ok(await call('PUT', '/workspace/reminders/rules/PERSONAL', { token: tokens.kiran, body: { enabled: true, email: false } }));
});

test('12: the words: task ID, title, owner, due time in India time, health, next action, link; footer to My reminders; no unsubscribe', async (t) => {
  if (skip(t)) return;
  const d = day(11);
  const id = await mkTask({ title: 'Sample tender pack', owner: ids.isha, due: IST(d, '14:00'), next: 'Get the sample quote signed' });
  const ref = (await query('SELECT ref FROM tasks WHERE id = $1', [id])).rows[0].ref;
  await plan(id, IST(d, '08:00'));
  await sendDueTaskReminders(IST(d, '12:01'));
  await sendEmailOutbox(IST(d, '12:05'));
  const [m] = mails(ids.isha_email);
  assert.equal(m.subject, `Due in 2 hours: ${ref} Sample tender pack`);
  for (const body of [m.text, m.html]) {
    assert.ok(body.includes(ref) && body.includes('Sample tender pack'));
    assert.match(body, /Owner: Isha Sample/);
    assert.match(body, /Due: [^\n<]*14:00 IST/);
    assert.match(body, /Status: To Do · \S/);
    assert.match(body, /Next action: Get the sample quote signed/);
    assert.ok(body.includes(`/?task=${id}`));
    assert.match(body, /Change how you get reminders/);
    assert.ok(body.includes('/settings?tab=account#how-you-hear'));
    assert.doesNotMatch(body, /unsubscribe/i);
  }
  assert.match(m.text, /You get this because you own this task in TaskFlow\./);
  assert.match(m.text, /Open the task: http/);
  assert.equal(m.from, 'reminders@example.com');
  assert.equal(m.headers['Auto-Submitted'], 'auto-generated');
  assert.ok(!Object.keys(m.headers).some((h) => /unsubscribe/i.test(h)));
  assert.match(m.reference, /^rem-\d+$/);

  // to the manager after the grace period: how long it is overdue, and whose it is
  const late = await mkTask({ title: 'Sample overdue pack', owner: ids.isha, due: IST(d, '10:00') });
  await plan(late, IST(d, '08:00'));
  const grace = (await rowsOf(late)).find((r) => r.kind === 'AFTER_GRACE' && r.channel === 'EMAIL');
  await sendDueTaskReminders(new Date(new Date(grace.remind_at).getTime() + 1000));
  await sendEmailOutbox(new Date(new Date(grace.remind_at).getTime() + 4 * MIN));
  const [mgr] = mails(ids.raj_email).filter((x) => /Sample overdue pack/.test(x.subject));
  assert.match(mgr.subject, /^Overdue, Isha Sample's task: EM-\d+ Sample overdue pack$/);
  assert.match(mgr.text, /Overdue by 24 hours; owned by Isha Sample\./);
  assert.match(mgr.text, /You get this because you are the fallback person for Isha Sample in TaskFlow\./);

  // "Send me a sample": to my own address, marked SAMPLE
  clearOutbox();
  const sample = ok(await call('POST', '/reminders/sample-email', { token: tokens.isha }));
  assert.equal(sample.sent, true);
  assert.equal(sample.to, ids.isha_email);
  assert.match(mails(ids.isha_email)[0].subject, /^SAMPLE · /);
});

test('my choices: saved, shown, and the go-live checks list what is missing', async (t) => {
  if (skip(t)) return;
  const mine = ok(await call('GET', '/reminders/channels', { token: tokens.kiran }));
  assert.equal(mine.task_reminders, 'BOTH');
  assert.equal(mine.summaries, 'CHAT_ELSE_EMAIL');
  assert.equal(mine.chat.connected, false);
  assert.equal(mine.email.ready, true);
  assert.equal(mine.email.address, ids.kiran_email);
  ok(await call('PUT', '/reminders/channels', { token: tokens.kiran, body: { task_reminders: 'EMAIL', summaries: 'EMAIL', summary_all_clear: true } }));
  const after = ok(await call('GET', '/reminders/channels', { token: tokens.kiran }));
  assert.equal(after.task_reminders, 'EMAIL');
  assert.equal(after.summary_all_clear, true);
  assert.equal((await call('PUT', '/reminders/channels', { token: tokens.kiran, body: { task_reminders: 'NOTHING', summaries: 'EMAIL' } })).status, 400);
  ok(await call('PUT', '/reminders/channels', { token: tokens.kiran, body: { task_reminders: 'BOTH', summaries: 'CHAT_ELSE_EMAIL' } }));

  assert.equal((await call('GET', '/reminders/go-live', { token: tokens.kiran })).status, 403);
  const live = ok(await call('GET', '/reminders/go-live', { token: tokens.admin }));
  const check = (key) => live.checks.find((c) => c.key === key);
  assert.equal(check('chat_on').ok, true);
  assert.equal(check('email').ok, true);
  assert.equal(check('mode').ok, true);
  assert.equal(check('connected').ok, false, 'some people with open work are not connected');

  // "send them the steps": one email each to people not connected, no password
  const { rows: before } = await query(`SELECT COUNT(*)::int AS n FROM account_emails WHERE kind = 'CHAT_STEPS'`);
  const steps = ok(await call('POST', '/reminders/chat-steps', { token: tokens.admin, body: { user_ids: [ids.kiran, ids.isha] } }));
  assert.equal(steps.sent, 1);
  assert.equal(steps.results.find((r) => r.id === ids.isha).reason, 'Already connected');
  const stepMail = outbox().filter((m) => String(m.reference).startsWith('acct-') && m.to === ids.kiran_email);
  assert.equal(stepMail.length, 1);
  assert.match(stepMail[0].subject, /^Get TaskFlow reminders in Google Chat$/);
  assert.doesNotMatch(stepMail[0].text, /password:/i);
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM account_emails WHERE kind = 'CHAT_STEPS'`)).rows[0].n, before[0].n + 1);
});
