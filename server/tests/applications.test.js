/**
 * Applications (Part D1) and their reminder rules (Part E1, E2). Numbers refer
 * to the build prompt's tests (section 8). A fixed clock throughout; the
 * company timezone is Asia/Kolkata.
 *
 *   14  a date-only deadline of 20 Jan 2027: one alert for the owner on
 *       17 Jan 2027 at 09:00 IST; nobody else is told
 *   15  added on 19 Jan: one immediate "1 day left"; added on 21 Jan:
 *       "Deadline passed", and no alert
 *   16  Mark submitted cancels the deadline alerts and clears the attention
 *       item; the application stays open for the outcome
 *   17  submitted 1 Feb 2027 with only an acknowledgement: one status check
 *       on 16 Feb 2027
 *   18  the organiser's response date (25 Feb) replaces it; one occurrence,
 *       which says what drives it
 *   19  a follow-up we sent is not a reply and sets the next check; a
 *       response clears the "no update" item
 *   20  editing, opening an alert or finishing an unrelated task never marks
 *       it submitted or reviewed
 *   21  a new deadline cancels the old alert; an outcome stops the reminders
 *   22  an exact deadline of 29 Mar 2027 17:00 London is 21:30 IST, and its
 *       3-day alert is 26 Mar 09:00 IST (not 72 hours earlier)
 *   26  a task created from an application is the same task on the board,
 *       in My tasks and on the application
 *
 * Made-up people and records only.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { getSettings, updateSetting } from '../src/services/settings.js';
import { planSweep, replanRecord, sendDueOccurrences } from '../src/services/workspace/reminders.js';
import '../src/services/workspace/rules.js';
import {
  createApplication, deadlineWords, exactDeadline, getApplication, logUpdate, markSubmitted, updateApplication,
} from '../src/services/workspace/applications.js';
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
const user = async (key) => (await query('SELECT * FROM users WHERE id = $1', [ids[key]])).rows[0];
const occ = async (appId, rule = null) => (await query(
  `SELECT * FROM reminder_occurrences WHERE entity_type = 'APPLICATION' AND entity_id = $1 AND ($2::text IS NULL OR rule_key = $2) ORDER BY id`, [appId, rule],
)).rows;
const bell = async (appId) => (await query(`SELECT * FROM notifications WHERE entity_type = 'APPLICATION' AND entity_id = $1 ORDER BY id`, [appId])).rows;

async function newApp(name, { deadline_date = null, deadline_at_local = null, deadline_timezone = null, owner = 'vera' } = {}) {
  return createApplication(await user(owner), { name, organiser_name: 'Sample Innovation Fund', application_type: 'GRANT', deadline_date, deadline_at_local, deadline_timezone });
}

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('PRG', 'Programmes', '#2a78d6', 1)`);
  ids.prg = (await query(`SELECT id FROM departments WHERE key = 'PRG'`)).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  const password = await hashPassword('Password123!');
  for (const [key, role] of [['admin', 'admin'], ['vera', 'member'], ['omar', 'member'], ['lead', 'manager']]) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.ap@test.local`, password, role, ids.prg],
    );
    ids[key] = rows[0].id;
  }
  // reminders live, and every rule already launched (as after the first run)
  await updateSetting('workspace', { ...(await getSettings()).workspace, reminderMode: 'LIVE' }, ids.admin);
  await planSweep({ now: IST('2026-12-01') });
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'vera', 'omar']) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.ap@test.local`, password: 'Password123!' } })).token;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('14: a date-only deadline of 20 Jan 2027 gives one alert, to the owner only, on 17 Jan at 09:00 IST', async (t) => {
  if (skip(t)) return;
  const id = await newApp('Sample seed grant 2027', { deadline_date: '2027-01-20' });
  await replanRecord('APPLICATION', id, { now: IST('2027-01-10') });
  await replanRecord('APPLICATION', id, { now: IST('2027-01-11') });
  const planned = await occ(id, 'APPLICATION_DEADLINE');
  assert.equal(planned.length, 1, 'planned once');
  assert.equal(new Date(planned[0].remind_at).getTime(), IST('2027-01-17').getTime(), '17 Jan 2027 09:00 IST');
  assert.equal((await occ(id, 'APPLICATION_DEADLINE_1D')).length, 0, 'the 1-day alert is opt-in');
  assert.equal((await sendDueOccurrences(IST('2027-01-17', '08:59'))).sent, 0);
  const out = await sendDueOccurrences(IST('2027-01-17', '09:00'));
  assert.equal(out.sent, 1, JSON.stringify([out, await occ(id, 'APPLICATION_DEADLINE')]));
  assert.equal((await sendDueOccurrences(IST('2027-01-17', '09:05'))).sent, 0, 'never twice');
  const n = await bell(id);
  assert.equal(n.length, 1);
  assert.equal(n[0].user_id, ids.vera, 'only the owner');
  assert.equal(n[0].title, '3 days left to submit: Sample seed grant 2027 · Sample Innovation Fund');
  assert.match(n[0].body, /Wed 20 Jan 2027 · Closing time not specified · 3 days left/);
  assert.equal(n[0].reason, 'You own this application');
  assert.equal((await query(`SELECT count(*)::int AS n FROM notifications WHERE type = 'workspace_reminder' AND user_id <> $1`, [ids.vera])).rows[0].n, 0, 'nobody else');
});

test('15: added on 19 Jan, one immediate "1 day left"; added on 21 Jan, "Deadline passed" and no alert', async (t) => {
  if (skip(t)) return;
  const late = await newApp('Sample late entry', { deadline_date: '2027-01-20' });
  await replanRecord('APPLICATION', late, { now: IST('2027-01-19', '10:00') });
  const out = await sendDueOccurrences(IST('2027-01-19', '10:01'));
  assert.equal(out.sent, 1);
  const n = await bell(late);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /^1 day left to submit/);
  const passed = await newApp('Sample missed entry', { deadline_date: '2027-01-20' });
  await replanRecord('APPLICATION', passed, { now: IST('2027-01-21', '10:00') });
  await sendDueOccurrences(IST('2027-01-21', '10:01'));
  assert.equal((await bell(passed)).length, 0, 'no alert after the deadline');
  const row = (await occ(passed, 'APPLICATION_DEADLINE'))[0];
  assert.equal(row.status, 'SKIPPED');
  const w = deadlineWords({ date: '2027-01-20', dateOnly: true }, 'Asia/Kolkata', IST('2027-01-21', '10:00'));
  assert.equal(w.text, 'Wed 20 Jan 2027 · Closing time not specified · Deadline passed');
  assert.equal(deadlineWords({ date: '2027-01-20', dateOnly: true }, 'Asia/Kolkata', IST('2027-01-20', '23:00')).text, 'Wed 20 Jan 2027 · Closing time not specified · Due today');
  // and the dashboard shows it
  const { items } = await attentionFor(await user('vera'), { now: IST('2027-01-21', '10:00') });
  const it = items.find((x) => x.record.id === passed && x.kind === 'APPLICATION_DEADLINE');
  assert.match(it.reason, /Deadline passed$/);
  assert.equal(it.tier, 1);
});

test('16: Mark submitted cancels pending deadline alerts and clears the item; the application stays open', async (t) => {
  if (skip(t)) return;
  const id = await newApp('Sample accelerator cohort', { deadline_date: '2027-02-10' });
  await replanRecord('APPLICATION', id, { now: IST('2027-02-01') });
  assert.equal((await occ(id, 'APPLICATION_DEADLINE'))[0].status, 'PENDING');
  const done = await markSubmitted(await user('vera'), id, { submitted_on: '2027-02-05', reference: 'APP-0042' }, { now: IST('2027-02-05', '12:00') });
  const row = (await occ(id, 'APPLICATION_DEADLINE'))[0];
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.reason, 'Submitted on 2027-02-05');
  assert.equal(done.application.status, 'ACTIVE');
  assert.equal(done.application.stage_slug, 'app-submitted');
  assert.equal(done.application.group, 'SUBMITTED');
  const { items } = await attentionFor(await user('vera'), { now: IST('2027-02-06') });
  assert.equal(items.some((x) => x.record.id === id && x.kind === 'APPLICATION_DEADLINE'), false, 'the deadline item is gone');
  // only "Mark submitted" sets it, and only once without a reason
  await assert.rejects(markSubmitted(await user('vera'), id, { submitted_on: '2027-02-06' }, { now: IST('2027-02-06') }), /Already marked submitted/);
  // a correction needs a reason, and is recorded
  await markSubmitted(await user('vera'), id, { submitted_on: '2027-02-04', correction_reason: 'The portal shows the 4th' }, { now: IST('2027-02-06') });
  const h = (await query(`SELECT * FROM opportunity_history WHERE opportunity_id = $1 AND field = 'submitted' ORDER BY id`, [id])).rows;
  assert.equal(h.length, 2);
  assert.equal(h[0].to_value, '2027-02-05');
  assert.deepEqual([h[1].from_value, h[1].to_value, h[1].reason], ['2027-02-05', '2027-02-04', 'The portal shows the 4th']);
});

test('17, 18: one status check 15 days after submission; the organiser\'s date replaces it, and says so', async (t) => {
  if (skip(t)) return;
  const id = await newApp('Sample challenge 2027', { deadline_date: '2027-01-31' });
  const vera = await user('vera');
  await markSubmitted(vera, id, { submitted_on: '2027-02-01' }, { now: IST('2027-02-01', '15:00') });
  await logUpdate(vera, id, { kind: 'ACKNOWLEDGEMENT', happened_on: '2027-02-02', reference: 'ACK-7' }, { now: IST('2027-02-02') });
  await replanRecord('APPLICATION', id, { now: IST('2027-02-03') });
  let checks = await occ(id, 'APPLICATION_STATUS_CHECK');
  assert.deepEqual(checks.map((c) => `${c.occurrence_key}:${c.status}`), ['check:2027-02-16:PENDING'], 'an acknowledgement is not an update');
  assert.equal(new Date(checks[0].remind_at).getTime(), IST('2027-02-16').getTime());
  await updateApplication(vera, id, { expected_response_on: '2027-02-25' });
  checks = await occ(id, 'APPLICATION_STATUS_CHECK');
  assert.deepEqual(checks.map((c) => `${c.occurrence_key}:${c.status}`), ['check:2027-02-16:CANCELLED', 'check:2027-02-25:PENDING']);
  assert.equal(checks[1].facts.words, 'the response date the organiser gave');
  await sendDueOccurrences(IST('2027-02-25', '09:00'));
  const n = await bell(id);
  assert.equal(n.length, 1, 'never more than one');
  assert.equal(n[0].title, 'Check application status: Sample challenge 2027 · Sample Innovation Fund');
  assert.match(n[0].body, /No update recorded\./);
  assert.doesNotMatch(n[0].body, /No response received/);
  assert.match(n[0].body, /This date comes from the response date the organiser gave/);
});

test('19: a follow-up we sent is not a reply and sets the next check; a response clears the item and asks for the next action', async (t) => {
  if (skip(t)) return;
  const id = await newApp('Sample incubator intake');
  const vera = await user('vera');
  await markSubmitted(vera, id, { submitted_on: '2027-03-01' }, { now: IST('2027-03-01', '12:00') });
  const f = await logUpdate(vera, id, { kind: 'FOLLOW_UP_SENT', happened_on: '2027-03-20', summary: 'Emailed the programme team' }, { now: IST('2027-03-20') });
  assert.equal(f.ask_next_check, '2027-03-27', 'next check defaults to 7 days later');
  assert.equal(f.application.status_check.date, '2027-03-27');
  assert.equal(f.application.status_check.source, 'FOLLOW_UP');
  const before1 = await attentionFor(vera, { now: IST('2027-03-27', '10:00') });
  assert.ok(before1.items.some((x) => x.record.id === id && x.kind === 'APPLICATION_STATUS_CHECK'));
  const r = await logUpdate(vera, id, { kind: 'RESPONSE', happened_on: '2027-03-28', summary: 'Shortlisted for interview' }, { now: IST('2027-03-28') });
  assert.equal(r.ask_next_action, true);
  assert.equal(r.application.status_check, null);
  assert.equal((await occ(id, 'APPLICATION_STATUS_CHECK')).filter((o) => o.status === 'PENDING').length, 0);
  const after1 = await attentionFor(vera, { now: IST('2027-03-28', '10:00') });
  assert.equal(after1.items.some((x) => x.record.id === id && x.kind === 'APPLICATION_STATUS_CHECK'), false);
});

test('20: editing, opening an alert or finishing an unrelated task never marks it submitted or reviewed', async (t) => {
  if (skip(t)) return;
  const id = await newApp('Sample award entry', { deadline_date: '2027-04-30' });
  const vera = await user('vera');
  await updateApplication(vera, id, { opportunity_url: 'https://example.com/award', reference: 'DRAFT-1' });
  ok(await call('POST', `/applications/${id}/tasks`, { token: tokens.vera, body: { title: 'Collect the sample letters' } }), 201);
  const st = (await query(`SELECT id FROM workflow_statuses WHERE stage = 'done'`)).rows[0].id;
  await query(`UPDATE tasks SET status_id = $2, completed_at = now() WHERE opportunity_id = $1`, [id, st]);
  await query(`UPDATE notifications SET is_read = TRUE WHERE user_id = $1`, [ids.vera]);
  const a = (await getApplication(vera, id)).application;
  assert.equal(a.submitted_on, null);
  assert.equal(a.group, 'PREPARING');
  assert.equal(a.status_check, null);
  assert.equal(a.last_update_type, null);
});

test('21: a new deadline cancels the old alert; Selected, Not selected and Withdrawn stop reminders', async (t) => {
  if (skip(t)) return;
  const vera = await user('vera');
  const id = await newApp('Sample scheme application', { deadline_date: '2027-05-20' });
  await updateApplication(vera, id, { deadline_date: '2027-05-27', reason: 'The organiser extended it' });
  const rows = await occ(id, 'APPLICATION_DEADLINE');
  assert.deepEqual(rows.map((r) => `${r.occurrence_key}:${r.status}`), ['date:2027-05-20:CANCELLED', 'date:2027-05-27:PENDING']);
  assert.equal(rows[0].reason, 'The date changed');
  const hist = (await query(`SELECT * FROM opportunity_history WHERE opportunity_id = $1 AND field = 'deadline'`, [id])).rows;
  assert.equal(hist.length, 1);
  for (const [result, name] of [['SELECTED', 'Sample tender A'], ['NOT_SELECTED', 'Sample tender B'], ['WITHDRAWN', 'Sample tender C']]) {
    const x = await newApp(name);
    await markSubmitted(vera, x, { submitted_on: '2026-11-01' }, { now: IST('2026-11-02') });
    await replanRecord('APPLICATION', x, { now: IST('2026-11-03') });
    assert.equal((await occ(x, 'APPLICATION_STATUS_CHECK')).filter((o) => o.status === 'PENDING').length, 1);
    await logUpdate(vera, x, { kind: 'OUTCOME', result, summary: result === 'SELECTED' ? null : 'Not this year', onboarding_task_title: result === 'SELECTED' ? 'Sample onboarding call' : null });
    const pending = (await occ(x)).filter((o) => o.status === 'PENDING');
    assert.equal(pending.length, 0, `${result}: no reminder left`);
    const cancelled = (await occ(x, 'APPLICATION_STATUS_CHECK'))[0];
    assert.match(cancelled.reason, /^Outcome recorded: /);
  }
  // Selected created the onboarding task, linked; nothing open was closed
  const sel = (await query(`SELECT id FROM opportunities WHERE name = 'Sample tender A'`)).rows[0].id;
  assert.equal((await query(`SELECT count(*)::int AS n FROM tasks WHERE opportunity_id = $1 AND title = 'Sample onboarding call'`, [sel])).rows[0].n, 1);
});

test('22: an exact deadline in London is shown in IST, and its 3-day alert is by calendar days', async (t) => {
  if (skip(t)) return;
  const at = exactDeadline('2027-03-29T17:00', 'Europe/London');
  assert.equal(at.toISOString(), '2027-03-29T16:00:00.000Z', 'after the UK clock change: 17:00 BST');
  const id = await newApp('Sample UK challenge', { deadline_at_local: '2027-03-29T17:00', deadline_timezone: 'Europe/London' });
  await replanRecord('APPLICATION', id, { now: IST('2027-03-01') });
  const row = (await occ(id, 'APPLICATION_DEADLINE'))[0];
  assert.equal(new Date(row.remind_at).toISOString(), IST('2027-03-26').toISOString(), '26 Mar 2027 09:00 IST');
  assert.notEqual(new Date(row.remind_at).getTime(), at.getTime() - 72 * 3_600_000, 'not 72 hours earlier');
  const w = deadlineWords({ at, timezone: 'Europe/London', dateOnly: false }, 'Asia/Kolkata', IST('2027-03-26'));
  assert.equal(w.text, 'Mon 29 Mar 2027, 21:30 IST (Mon 29 Mar 2027, 17:00 Europe/London) · 3 days left');
  const shown = (await getApplication(await user('vera'), id)).application.deadline;
  assert.equal(shown.dateOnly, false);
  assert.match(shown.words.text, /21:30 IST/);
});

test('26: a task created from an application is the same task everywhere', async (t) => {
  if (skip(t)) return;
  const id = await newApp('Sample fellowship');
  const { task } = ok(await call('POST', `/applications/${id}/tasks`, { token: tokens.vera, body: { title: 'Write the sample budget note', due_date: '2027-06-01T12:00:00Z' } }), 201);
  const detail = ok(await call('GET', `/applications/${id}`, { token: tokens.vera }));
  assert.deepEqual(detail.tasks.map((x) => x.id), [task.id]);
  const board = ok(await call('GET', `/tasks?assignee_id=${ids.vera}&limit=100`, { token: tokens.vera }));
  assert.ok(board.tasks.some((x) => x.id === task.id && x.opportunity_id === id));
  const mine = ok(await call('GET', '/tasks/mine', { token: tokens.vera }));
  assert.ok(mine.tasks.some((x) => x.id === task.id));
  // nobody outside the CRM sees the application, or can add tasks to it
  await query(`UPDATE users SET revoked_permissions = ARRAY['crm.view'] WHERE id = $1`, [ids.omar]);
  assert.equal((await call('GET', `/applications/${id}`, { token: tokens.omar })).status, 403);
  await query(`UPDATE users SET revoked_permissions = '{}' WHERE id = $1`, [ids.omar]);
  assert.equal((await call('POST', `/applications/${id}/tasks`, { token: tokens.omar, body: { title: 'Not my application' } })).status, 403);
});
