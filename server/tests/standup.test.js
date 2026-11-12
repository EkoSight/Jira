/**
 * The daily standup, end to end, in a sandbox: a stand-in for Google Chat
 * records every message instead of sending it. Synthetic people, tasks and
 * accounts only. Fixed dates:
 *
 *   Mon 16 Nov 2026  a working day — reminder, submissions, review, correction,
 *                    a late arrival, escalation, duplicate runs
 *   Tue 17 Nov 2026  a company holiday — nothing is sent
 *   Wed 18 Nov 2026  the reminder is delayed by a Chat outage
 *   Thu 19 Nov 2026  the reminder is never delivered
 *   Fri 20 Nov 2026  TaskFlow was not running at 09:30
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { ChatError, setChatConfig, setChatTransport, setChatVerifier, setGoogleFetch } from '../src/lib/googleChat.js';
import { deliverOutbox } from '../src/services/googleChat.js';
import { updateSetting } from '../src/services/settings.js';
import { runStandup, submitFromApp, submitFromChat } from '../src/services/standup.js';

const SPACE = 'spaces/STANDUPSANDBOX1';
const at = (date, time) => new Date(`${date}T${time}${time.length === 5 ? ':00' : ''}+05:30`);
const MON = '2026-11-16';
const TUE = '2026-11-17';
const WED = '2026-11-18';
const THU = '2026-11-19';
const FRI = '2026-11-20';

let server;
let baseUrl;
let available = true;
const ids = {};
const users = {};
const tokens = {};
const sent = [];
let chatDown = null; // null: working; otherwise the ChatError to throw
let baseline;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const outbox = async (pattern) => (await query('SELECT * FROM chat_outbox WHERE dedupe_key LIKE $1 ORDER BY id', [pattern])).rows;
const review = async (date, key) => (await query('SELECT * FROM standup_reviews WHERE work_date = $1 AND member_id = $2', [date, ids[key]])).rows[0];
const sub = async (date, key) => (await query('SELECT * FROM standup_submissions WHERE work_date = $1 AND member_id = $2', [date, ids[key]])).rows[0];
/** Deliver what is waiting, then pretend Google accepted it at `when` (the outbox stamps the real clock). */
async function deliverAt(pattern, when) {
  await query("UPDATE chat_outbox SET next_attempt_at = now() WHERE status = 'PENDING'");
  const result = await deliverOutbox();
  if (when) await query(`UPDATE chat_outbox SET sent_at = $2 WHERE dedupe_key LIKE $1 AND status = 'SENT'`, [pattern, when]);
  return result;
}
const plan = (name, date, items) => [
  `${name} | ${date} | Team member`,
  ...items.map((i, n) => `${n + 1}. ${i}`),
  'Blockers: none',
].join('\n');
const GOOD_ITEMS = [
  'SLS-1 | Call the distributor in Kanpur about the delayed order | call note logged with the new delivery date | 12:30',
  'SLS-2 | Prepare the revised quotation | quotation PDF sent to the client | 15:00',
  'SLS-3 | Update the visit sheet for this week | visit sheet shared with the area lead | 17:30',
];

before(async () => {
  setChatConfig({
    clientEmail: 'taskflow-chat@demo.iam.gserviceaccount.com',
    privateKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
    projectId: 'demo', projectNumber: '1', audience: 'https://taskflow.example/api/taskflow/integrations/google-chat/events',
  });
  setChatTransport(async (space, message) => {
    if (chatDown) throw chatDown;
    sent.push({ space, message });
    const thread = message.thread?.name || `${space}/threads/${message.thread?.threadKey || `t${sent.length}`}`;
    return { name: `${space}/messages/${sent.length}`, thread };
  });
  setChatVerifier(async () => ({ email: 'chat@system.gserviceaccount.com' }));

  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('SLS', 'Sales', '#2a78d6', 1)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE)`);
  ids.dept = (await query(`SELECT id FROM departments`)).rows[0].id;
  ids.status = (await query(`SELECT id FROM workflow_statuses`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, name, role, active = true] of [
    ['admin', 'Admin Person', 'admin'], ['mgr', 'Team Manager', 'manager'], ['asha', 'Asha Rao', 'member'],
    ['ravi', 'Ravi Kumar', 'member'], ['dev', 'Dev Mehta', 'member'], ['leela', 'Leela Iyer', 'member'],
    ['former', 'Former Staffer', 'member', false], ['hr', 'HR Desk', 'member'],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, is_active)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6) RETURNING *`,
      [name, `${key}@ekosight.test`, password, role, ids.dept, active],
    );
    users[key] = rows[0];
  }
  for (let n = 1; n <= 4; n += 1) {
    await query(
      `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, reporter_id, created_by) VALUES ($1, $2, $3, $4, $5, $5, $5)`,
      [`SLS-${n}`, `Synthetic task ${n}`, ids.dept, ids.status, users.asha.id],
    );
  }
  // private chats with TaskFlow, for the private nudge and the escalation
  for (const key of ['admin', 'asha', 'ravi', 'dev']) {
    await query(`INSERT INTO chat_spaces (space_name, kind, user_id, active) VALUES ($1, 'DM', $2, TRUE)`, [`spaces/DM${key}`, users[key].id]);
  }
  const member = async (key, { name, userId = null, shared = null, email = null, status = 'VERIFIED', chatUser = null }) => {
    const { rows } = await query(
      `INSERT INTO standup_members (user_id, full_name, role_title, shared_account_id, chat_email, chat_user_name, identity_status)
       VALUES ($1, $2, 'Team member', $3, $4, $5, $6) RETURNING id`,
      [userId, name, shared, email, chatUser, status],
    );
    ids[key] = rows[0].id;
  };
  await member('asha', { name: 'Asha Rao', userId: users.asha.id });
  await member('ravi', { name: 'Ravi Kumar', userId: users.ravi.id });
  await member('dev', { name: 'Dev Mehta', userId: users.dev.id });
  await member('leela', { name: 'Leela Iyer', userId: users.leela.id });
  await member('former', { name: 'Former Staffer', userId: users.former.id });
  // two people who share the HR login and its Chat account
  await member('neha', { name: 'Neha Sharma', shared: users.hr.id, email: 'hr@ekosight.test' });
  await member('kiran', { name: 'Kiran Joshi', shared: users.hr.id, email: 'hr@ekosight.test' });
  // an outside Chat account nobody has verified yet
  await member('ext', { name: 'Outside Helper', email: 'helper@gmail.example', status: 'UNVERIFIED' });

  // Leela is on approved leave on Monday; Tuesday is a company holiday
  await query(
    `INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status, day_allocation, paid_days, created_by)
     VALUES ($1, 'CASUAL', $2, $2, 'synthetic', 'APPROVED_PAID', $3, 1, $1)`,
    [users.leela.id, MON, JSON.stringify([{ date: MON, portion: 1, paid: 1 }])],
  );
  await query(`INSERT INTO work_holidays (holiday_date, name) VALUES ($1, 'Synthetic company holiday')`, [TUE]);

  await updateSetting('standup', {
    enabled: true, spaceName: SPACE, escalateTo: [users.admin.id], companyDomains: ['ekosight.test'],
  });

  baseline = {};
  for (const table of ['attendance_sessions', 'black_marks', 'leave_requests', 'payroll_results', 'tasks']) {
    baseline[table] = (await query(`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) AS h FROM ${table} t`)).rows[0].h;
  }

  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'mgr', 'asha', 'hr']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `${key}@ekosight.test`, password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  setChatConfig(null); setChatTransport(null); setChatVerifier(null); setGoogleFetch(null);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- Monday

test('nothing before 09:30 in India; at 09:30 exactly one reminder, however many runs', async (t) => {
  if (skip(t)) return;
  // 09:29:59 India is 03:59:59 UTC
  await runStandup(new Date('2026-11-16T03:59:59Z'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM standup_days')).rows[0].n, 0);

  await Promise.all([1, 2, 3].map(() => runStandup(new Date('2026-11-16T04:00:00Z'))));
  await runStandup(at(MON, '09:30:30'));
  const reminders = await outbox(`standup:reminder:${MON}`);
  assert.equal(reminders.length, 1, 'duplicate scheduler runs queue one reminder');

  await deliverAt(`standup:reminder:${MON}`, at(MON, '09:30'));
  await deliverAt(`standup:reminder:${MON}`);
  const delivered = sent.filter((m) => m.message.thread?.threadKey === `standup-${MON}`);
  assert.equal(delivered.length, 1, 'a retry never sends it twice');
  assert.equal(delivered[0].space, SPACE);
  assert.match(delivered[0].message.text, /Name \| Date \| Role/);
  assert.match(delivered[0].message.text, /by \*09:40\*/);

  await runStandup(at(MON, '09:31'));
  const day = (await query('SELECT * FROM standup_days WHERE work_date = $1', [MON])).rows[0];
  assert.equal(new Date(day.reminder_sent_at).toISOString(), at(MON, '09:30').toISOString());
  assert.equal(new Date(day.effective_deadline_at).toISOString(), at(MON, '09:40').toISOString());
  assert.ok(day.reminder_thread, 'the reminder’s thread is on record');
});

test('submissions: the form, a private message, and a shared login that names its person', async (t) => {
  if (skip(t)) return;
  const asha = await submitFromApp(users.asha, {
    items: [
      { task: 'SLS-1', action: 'Call the distributor about the delayed order', target: 'call note logged with the new date', done_by: '12:30' },
      { task: 'SLS-2', action: 'Prepare the revised quotation', target: 'quotation PDF sent to the client', done_by: '15:00' },
      { task: 'SLS-3', action: 'Update the visit sheet', target: 'visit sheet shared with the area lead', done_by: '17:30' },
    ],
  }, at(MON, '09:35'));
  assert.deepEqual(asha.findings, [], 'a clear plan');

  const ravi = await submitFromChat({
    source: 'CHAT_DM',
    text: `standup\n${plan('Ravi Kumar', 'today', ['SLS-4 | work on | progress | 11:00', 'follow up | follow up | done |'])}`,
    sender: { name: 'users/ravi', email: 'ravi@ekosight.test' },
    message: { name: 'spaces/DMravi/messages/m1', thread: 'spaces/DMravi/threads/m1' },
    now: at(MON, '09:38'),
  });
  assert.match(ravi.text, /Got it, Ravi/);

  // the HR login is shared: the first line names the person, and that decides
  const neha = await submitFromChat({
    source: 'CHAT_SPACE', text: plan('Neha Sharma', '16 Nov 2026', GOOD_ITEMS),
    sender: { name: 'users/hrdesk', email: 'hr@ekosight.test' },
    message: { name: `${SPACE}/messages/n1`, thread: `${SPACE}/threads/n1` },
    now: at(MON, '09:39'),
  });
  assert.match(neha.text, /Got it, Neha/);
  const again = await submitFromChat({
    source: 'CHAT_SPACE', text: plan('Neha Sharma', '16 Nov 2026', GOOD_ITEMS),
    sender: { name: 'users/hrdesk', email: 'hr@ekosight.test' },
    message: { name: `${SPACE}/messages/n1`, thread: `${SPACE}/threads/n1` },
    now: at(MON, '09:39'),
  });
  assert.equal(again.duplicate, true, 'the same Chat message delivered twice is one version');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM standup_submission_versions')).rows[0].n, 3);

  // a shared account that names nobody it covers is held, not guessed
  const nobody = await submitFromChat({
    source: 'CHAT_SPACE', text: plan('Somebody Else', 'today', GOOD_ITEMS),
    sender: { email: 'hr@ekosight.test' }, message: { name: `${SPACE}/messages/x1` }, now: at(MON, '09:39'),
  });
  assert.equal(nobody.held, 'SHARED_ACCOUNT_NAME_NOT_MATCHED');
  // an outside account is not counted until someone verifies it
  const outside = await submitFromChat({
    source: 'CHAT_SPACE', text: plan('Outside Helper', 'today', GOOD_ITEMS),
    sender: { email: 'helper@gmail.example' }, message: { name: `${SPACE}/messages/x2` }, now: at(MON, '09:39'),
  });
  assert.equal(outside.held, 'IDENTITY_NOT_VERIFIED');
  const stranger = await submitFromChat({
    source: 'CHAT_SPACE', text: plan('A Stranger', 'today', GOOD_ITEMS),
    sender: { email: 'stranger@gmail.example' }, message: { name: `${SPACE}/messages/x3` }, now: at(MON, '09:39'),
  });
  assert.equal(stranger.held, 'UNKNOWN_SENDER');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM standup_unmatched WHERE work_date = $1', [MON])).rows[0].n, 3);

  // on the shared login in TaskFlow, the person must be chosen
  await assert.rejects(
    submitFromApp(users.hr, { items: [{ task: 'SLS-1', action: 'x', target: 'y', done_by: '10:00' }] }, at(MON, '09:39')),
    (err) => err.details?.code === 'CHOOSE_PERSON',
  );
});

test('the review after 09:40: everyone classified; feedback in threads; nobody named in the space', async (t) => {
  if (skip(t)) return;
  await runStandup(at(MON, '09:41'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM standup_reviews')).rows[0].n, 0, 'a moment’s grace for late deliveries');

  await Promise.all([runStandup(at(MON, '09:43')), runStandup(at(MON, '09:43')), runStandup(at(MON, '09:44'))]);
  assert.equal((await review(MON, 'asha')).status, 'ON_TIME');
  assert.equal((await review(MON, 'ravi')).status, 'ON_TIME');
  assert.equal((await review(MON, 'neha')).status, 'ON_TIME');
  assert.equal((await review(MON, 'kiran')).status, 'MISSING');
  assert.equal((await review(MON, 'dev')).status, 'MISSING');
  const leela = await review(MON, 'leela');
  assert.equal(leela.status, 'EXEMPT');
  assert.equal(leela.reason, 'LEAVE');
  assert.equal(await review(MON, 'former'), undefined, 'former staff are not reviewed');
  assert.equal(await review(MON, 'ext'), undefined, 'an unverified identity is not reviewed');

  assert.equal((await sub(MON, 'asha')).quality, 'OK');
  assert.equal((await sub(MON, 'neha')).quality, 'OK');
  const raviSub = await sub(MON, 'ravi');
  assert.equal(raviSub.quality, 'NEEDS_CORRECTION');
  assert.ok(raviSub.findings.some((f) => f.code === 'NOT_MEASURABLE'));

  const feedback = await outbox(`standup:feedback:${raviSub.id}:%`);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].space_name, SPACE);
  assert.deepEqual(feedback[0].payload.thread, { threadKey: `standup-${MON}-m${ids.ravi}` }, 'in the thread of his standup');
  // a missing person hears privately; the HR people sharing a login have no private chat
  const nudges = await outbox(`standup:nudge:${MON}:%`);
  assert.deepEqual(nudges.map((n) => n.space_name), ['spaces/DMdev']);
  assert.match(nudges[0].payload.text, /didn’t see your standup/);

  const before = (await query('SELECT COUNT(*)::int AS n FROM chat_outbox')).rows[0].n;
  await runStandup(at(MON, '09:50'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM chat_outbox')).rows[0].n, before, 'a second review sends nothing more');

  await deliverAt('standup:%');
  const inSpace = sent.filter((m) => m.space === SPACE).map((m) => m.message.text).join('\n');
  for (const name of ['Dev', 'Kiran', 'Leela']) assert.doesNotMatch(inSpace, new RegExp(name), `${name} is not named in the space`);
  assert.match(inSpace, /\*Asha Rao\* \| 2026-11-16/, 'the form’s standup is posted with the explicit name');
});

test('a corrected plan keeps its original time, and is thanked once', async (t) => {
  if (skip(t)) return;
  const corrected = await submitFromChat({
    source: 'CHAT_DM', text: `standup\n${plan('Ravi Kumar', 'today', GOOD_ITEMS)}`,
    sender: { name: 'users/ravi', email: 'ravi@ekosight.test' },
    message: { name: 'spaces/DMravi/messages/m2', thread: 'spaces/DMravi/threads/m2' },
    now: at(MON, '09:55'),
  });
  assert.match(corrected.text, /correction \(version 2\)/);
  const s = await sub(MON, 'ravi');
  assert.equal(s.current_version, 2);
  assert.equal(new Date(s.first_submitted_at).toISOString(), at(MON, '09:38').toISOString(), 'the original time stays');
  assert.equal(s.timing, 'ON_TIME');
  assert.equal(s.quality, 'CORRECTED');
  const versions = (await query('SELECT version, received_at FROM standup_submission_versions WHERE submission_id = $1 ORDER BY version', [s.id])).rows;
  assert.deepEqual(versions.map((v) => v.version), [1, 2], 'both versions are kept');
  assert.equal((await outbox(`standup:corrected:${s.id}:%`)).length, 1);
  assert.equal((await outbox(`standup:post:${s.id}:v2`)).length, 1, 'the correction is posted in the same thread');
  assert.equal((await outbox(`standup:post:${s.id}:v2`))[0].payload.thread.threadKey, `standup-${MON}-m${ids.ravi}`);

  // the same message delivered again is not a third version
  await submitFromChat({
    source: 'CHAT_DM', text: `standup\n${plan('Ravi Kumar', 'today', GOOD_ITEMS)}`,
    sender: { name: 'users/ravi', email: 'ravi@ekosight.test' },
    message: { name: 'spaces/DMravi/messages/m2' }, now: at(MON, '09:56'),
  });
  assert.equal((await sub(MON, 'ravi')).current_version, 2);
});

test('arriving after the review is late, with its own time — not missing', async (t) => {
  if (skip(t)) return;
  const result = await submitFromApp(users.hr, {
    memberId: ids.kiran,
    items: [
      { task: 'SLS-1', action: 'Collect the joining documents', target: 'document checklist complete for the two joiners', done_by: '13:00' },
      { task: 'SLS-2', action: 'Draft the November holiday notice', target: 'notice draft shared with the founders', done_by: '15:00' },
      { task: 'SLS-3', action: 'Reconcile the leave register', target: 'register sheet uploaded', done_by: '17:00' },
    ],
  }, at(MON, '10:05'));
  assert.equal(result.member.full_name, 'Kiran Joshi', 'the shared login posts for the person chosen');
  const r = await review(MON, 'kiran');
  assert.equal(r.status, 'LATE');
  assert.equal(r.reason, 'SUBMITTED_AFTER_REVIEW');
  const version = (await query('SELECT submitted_by_user_id, content FROM standup_submission_versions v JOIN standup_submissions s ON s.id = v.submission_id WHERE s.member_id = $1', [ids.kiran])).rows[0];
  assert.equal(version.submitted_by_user_id, users.hr.id, 'which login it came from is on record');
  assert.equal(version.content.name, 'Kiran Joshi', 'and whose standup it is, by name');
});

test('at 11:00 what is unresolved goes privately to the reviewers — once, counts only', async (t) => {
  if (skip(t)) return;
  await runStandup(at(MON, '10:59'));
  assert.equal((await outbox(`standup:escalation:${MON}:%`)).length, 0);
  await Promise.all([runStandup(at(MON, '11:00')), runStandup(at(MON, '11:01'))]);
  const escalations = await outbox(`standup:escalation:${MON}:%`);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].space_name, 'spaces/DMadmin', 'a private chat, not the space');
  assert.match(escalations[0].payload.text, /1 not seen/);
  assert.match(escalations[0].payload.text, /3 messages not matched to a person/);
  assert.match(escalations[0].payload.text, /not a penalty/);
  assert.doesNotMatch(escalations[0].payload.text, /Dev|Kiran|Ravi/, 'names stay in TaskFlow');
  const notes = await query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'standup_review'`, [users.admin.id]);
  assert.equal(notes.rows.length, 1);
  await runStandup(at(MON, '11:30'));
  assert.equal((await outbox(`standup:escalation:${MON}:%`)).length, 1);
});

// ---------------------------------------------------------------- the rest of the week

test('a company holiday sends nothing, and is recorded as skipped', async (t) => {
  if (skip(t)) return;
  await runStandup(at(TUE, '09:30'));
  await runStandup(at(TUE, '09:45'));
  const day = (await query('SELECT * FROM standup_days WHERE work_date = $1', [TUE])).rows[0];
  assert.equal(day.status, 'SKIPPED');
  assert.match(day.skipped_reason, /HOLIDAY: Synthetic company holiday/);
  assert.equal((await outbox(`standup:%${TUE}%`)).length, 0);
});

test('a delayed reminder gives the full ten minutes from when it arrived', async (t) => {
  if (skip(t)) return;
  chatDown = new ChatError('Google Chat: The service is currently unavailable', { status: 503 });
  await runStandup(at(WED, '09:30'));
  await deliverAt(`standup:reminder:${WED}`);
  const pending = (await outbox(`standup:reminder:${WED}`))[0];
  assert.equal(pending.status, 'PENDING', 'an outage delays, it does not lose');
  assert.equal(pending.attempts, 1);
  await runStandup(at(WED, '09:42'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM standup_reviews WHERE work_date = $1', [WED])).rows[0].n, 0, 'no review before anyone was reminded');

  chatDown = null;
  await deliverAt(`standup:reminder:${WED}`, at(WED, '09:45'));
  await runStandup(at(WED, '09:46'));
  const day = (await query('SELECT * FROM standup_days WHERE work_date = $1', [WED])).rows[0];
  assert.equal(new Date(day.effective_deadline_at).toISOString(), at(WED, '09:55').toISOString());
  assert.ok(day.notes.some((n) => n.code === 'REMINDER_DELAYED'));

  await submitFromApp(users.asha, {
    items: [
      { task: 'SLS-1', action: 'Call the distributor', target: 'call note logged', done_by: '12:00' },
      { task: 'SLS-2', action: 'Send the quotation', target: 'quotation sent', done_by: '15:00' },
      { task: 'SLS-3', action: 'Share the visit sheet', target: 'visit sheet shared', done_by: '17:00' },
    ],
  }, at(WED, '09:50'));
  await runStandup(at(WED, '09:58'));
  assert.equal((await review(WED, 'asha')).status, 'ON_TIME', 'within the window the reminder actually gave');
  assert.equal((await review(WED, 'dev')).status, 'MISSING');
});

test('a reminder never delivered, or never sent, makes nobody missing', async (t) => {
  if (skip(t)) return;
  chatDown = new ChatError('Google Chat: Permission denied', { status: 403, permanent: true });
  await runStandup(at(THU, '09:30'));
  await deliverAt(`standup:reminder:${THU}`);
  assert.equal((await outbox(`standup:reminder:${THU}`))[0].status, 'FAILED');
  chatDown = null;
  await runStandup(at(THU, '11:59'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM standup_reviews WHERE work_date = $1', [THU])).rows[0].n, 0);
  await runStandup(at(THU, '12:00'));
  const dev = await review(THU, 'dev');
  assert.equal(dev.status, 'INACCESSIBLE');
  assert.equal(dev.reason, 'REMINDER_NOT_DELIVERED');
  assert.ok((await query('SELECT notes FROM standup_days WHERE work_date = $1', [THU])).rows[0].notes.some((n) => n.code === 'REMINDER_FAILED'));
  assert.equal((await outbox(`standup:nudge:${THU}:%`)).length, 0, 'nobody is nudged about a reminder they never got');

  // TaskFlow was not running between 09:30 and 09:40 on Friday
  await runStandup(at(FRI, '09:45'));
  assert.equal((await outbox(`standup:reminder:${FRI}`)).length, 0, 'a reminder after its deadline would only confuse');
  assert.ok((await query('SELECT notes FROM standup_days WHERE work_date = $1', [FRI])).rows[0].notes.some((n) => n.code === 'REMINDER_WINDOW_MISSED'));
  await runStandup(at(FRI, '12:00'));
  assert.equal((await review(FRI, 'dev')).status, 'INACCESSIBLE');
  assert.equal((await review(FRI, 'dev')).reason, 'REMINDER_NOT_SENT');
});

test('nothing touches attendance, leave, pay, black marks or tasks', async (t) => {
  if (skip(t)) return;
  for (const [table, hash] of Object.entries(baseline)) {
    const now = (await query(`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) AS h FROM ${table} t`)).rows[0].h;
    assert.equal(now, hash, `${table} unchanged`);
  }
});

// ---------------------------------------------------------------- through the app

test('reviewers see the evidence; others do not; the private chat path works', async (t) => {
  if (skip(t)) return;
  const board = await call('GET', `/standup/days/${MON}`, { token: tokens.mgr });
  assert.equal(board.status, 200, JSON.stringify(board.body));
  const reminder = board.body.deliveries.find((d) => d.dedupe_key === `standup:reminder:${MON}`);
  assert.equal(reminder.status, 'SENT');
  assert.ok(reminder.message_name && reminder.thread_name, 'Google’s message and thread names are kept');
  assert.equal(board.body.reviews.length, 6);
  const ravi = board.body.submissions.find((s) => s.member_id === ids.ravi);
  assert.equal(ravi.versions.length, 2);
  assert.equal(board.body.unmatched.length, 3);
  assert.deepEqual(board.body.excluded.map((e) => e.reason).sort(), ['FORMER_STAFF', 'IDENTITY_NOT_VERIFIED']);
  assert.match(board.body.consequences, /do not change attendance, leave, pay or black marks/);
  assert.equal((await call('GET', `/standup/days/${MON}`, { token: tokens.asha })).status, 403);

  const resolve = await call('POST', `/standup/reviews/${(await review(MON, 'dev')).id}/resolve`, { token: tokens.mgr, body: { resolution: 'EXCUSED', note: 'Was at a client site; told the lead' } });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.body.review.resolution, 'EXCUSED');

  // a standup sent privately to TaskFlow, through the real event endpoint (today's real date)
  const res = await call('POST', '/integrations/google-chat/events', {
    body: {
      type: 'MESSAGE', space: { name: 'spaces/DMasha', type: 'DM' },
      user: { name: 'users/asha', email: 'asha@ekosight.test' },
      message: { name: 'spaces/DMasha/messages/live1', text: `standup\n${plan('Asha Rao', 'today', GOOD_ITEMS)}` },
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.text, /Got it, Asha/);
});

test('the space must pass a privacy check before the standup can be switched on', async (t) => {
  if (skip(t)) return;
  let external = true;
  setGoogleFetch(async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'sandbox', expires_in: 3600 }), { status: 200 });
    if (String(url).endsWith('/spaces/AAQAC-test01')) {
      return new Response(JSON.stringify({ name: 'spaces/AAQAC-test01', spaceType: 'SPACE', displayName: 'Standup sandbox', externalUserAllowed: external }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  const set = await call('PUT', '/standup/settings', { token: tokens.admin, body: { space: 'https://chat.google.com/app/chat/AAQAC-test01' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.settings.spaceName, 'spaces/AAQAC-test01');
  assert.equal(set.body.settings.enabled, false, 'a new space starts switched off');
  assert.equal((await call('PUT', '/standup/settings', { token: tokens.admin, body: { enabled: true } })).status, 409);

  const open = await call('POST', '/standup/settings/check-space', { token: tokens.admin });
  assert.equal(open.body.check.ok, false);
  assert.match(open.body.check.problems.join(' '), /outside the company/);
  external = false;
  const closed = await call('POST', '/standup/settings/check-space', { token: tokens.admin });
  assert.equal(closed.body.check.ok, true);
  const on = await call('PUT', '/standup/settings', { token: tokens.admin, body: { enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.settings.enabled, true);
  assert.equal((await call('PUT', '/standup/settings', { token: tokens.mgr, body: { enabled: false } })).status, 403, 'setting it up is its own permission');
});

test('a shared login is not a person: adding its people takes it off the list, and enrolling skips it', async (t) => {
  if (skip(t)) return;
  const { rows: [desk] } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ('Front Desk', 'desk@ekosight.test', 'x', 'member', $1, FALSE) RETURNING id`,
    [ids.dept],
  );
  const enrol = await call('POST', '/standup/members/enrol-active', { token: tokens.admin });
  assert.equal(enrol.status, 200);
  const deskMember = (await query('SELECT active FROM standup_members WHERE user_id = $1', [desk.id])).rows[0];
  assert.equal(deskMember.active, true, 'enrolled before anyone said it was shared');
  const add = await call('POST', '/standup/members', { token: tokens.admin, body: { full_name: 'Desk Person One', shared_account_id: desk.id, chat_email: 'desk@ekosight.test' } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.member.identity_status, 'UNVERIFIED', 'a shared account is verified by a person, not assumed');
  assert.equal((await query('SELECT active FROM standup_members WHERE user_id = $1', [desk.id])).rows[0].active, false, 'the shared login itself is no longer expected');
  await call('POST', '/standup/members/enrol-active', { token: tokens.admin });
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM standup_members WHERE user_id = $1 AND active', [desk.id])).rows[0].n, 0, 'and enrolling again skips it');
});
