/**
 * Field days and emergency leave protect that day's deadlines.
 *
 * Synthetic people and tasks only. What is guarded:
 *   - checking in from the field marks the day and moves today's open
 *     deadlines to the next working day — never marks them done;
 *   - a move is recorded, told to whoever assigned the work, not counted as
 *     the person pushing a deadline, and happens once however often asked;
 *   - the black-mark scan then judges the new deadline, not the old one;
 *   - a field-duty correction, once approved, does the same for a day gone,
 *     and waives that day's deadline marks if the reviewer may waive marks;
 *   - emergency leave moves the work at once; planned leave on approval;
 *     approval waives the marks for moved deadlines, or leaves them for
 *     someone who may waive them.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { addDays, dateIn } from '../src/services/attendance.js';
import { runBlackMarkScan } from '../src/services/blackmarks.js';
import { nextWorkingDay } from '../src/services/dayProtection.js';

const TZ = 'Asia/Kolkata';
let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
let seq = 0;

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
const today = () => dateIn(TZ);
const at = (date, time) => new Date(`${date}T${time}:00+05:30`);
const here = () => ({ latitude: 20.5, longitude: 78.9, accuracy: 25, timestamp: Date.now(), age_ms: 500 });
const rid = () => `field-${Date.now()}-${(seq += 1)}-abcdef`;

async function task(assignee, due, { title = 'Synthetic task', status = 'todo', reporter = ids.manager } = {}) {
  seq += 1;
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, reporter_id, created_by, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7) RETURNING id`,
    [`FLD-${seq}`, `${title} ${seq}`, ids.dept, ids[status], assignee, reporter, due],
  );
  return rows[0].id;
}
const taskRow = async (id) => (await query(
  `SELECT t.due_date, t.original_due_date, t.due_date_changes, s.stage FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id WHERE t.id = $1`,
  [id],
)).rows[0];

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('FLD', 'Field team', '#2a78d6', 1)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );
  ids.dept = (await query(`SELECT id FROM departments WHERE key = 'FLD'`)).rows[0].id;
  ids.todo = (await query(`SELECT id FROM workflow_statuses WHERE stage = 'todo'`)).rows[0].id;
  ids.done = (await query(`SELECT id FROM workflow_statuses WHERE stage = 'done'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, role, revoked] of [
    ['admin', 'admin', []],
    ['manager', 'manager', []],
    // reviews leave, but may not waive black marks
    ['lead', 'manager', ['blackmark.waive']],
    ['agent', 'member', []],
    ['rep', 'member', []],
    ['sales', 'member', []],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, revoked_permissions)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6) RETURNING id`,
      [`Field ${key}`, `field-${key}@test.local`, password, role, ids.dept, revoked],
    );
    ids[key] = rows[0].id;
  }
  for (const key of ['manager', 'lead']) {
    await query('INSERT INTO attendance_team_access (manager_id, department_id) VALUES ($1, $2)', [ids[key], ids.dept]);
  }
  await query(
    `INSERT INTO blackmark_rules (name, trigger_type, points, grace_hours, is_active) VALUES ('Missed deadline', 'deadline_missed', 1, 0, TRUE)`,
  );
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'manager', 'lead', 'agent', 'rep', 'sales']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `field-${key}@test.local`, password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- field day

test('a field day needs a check-in first', async (t) => {
  if (skip(t)) return;
  const res = await call('POST', '/attendance/field-day', { token: tokens.rep, body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.details.code, 'NOT_CHECKED_IN');
});

test('checking in from the field moves today\'s open deadlines — never marks them done', async (t) => {
  if (skip(t)) return;
  const d = today();
  const afternoon = await task(ids.agent, at(d, '17:00'));
  const morning = await task(ids.agent, at(d, '10:00'));
  const finished = await task(ids.agent, at(d, '12:00'), { status: 'done' });
  const tomorrow = await task(ids.agent, at(addDays(d, 1), '12:00'));
  const ownTask = await task(ids.agent, at(d, '15:00'), { reporter: ids.agent });

  const preview = await call('GET', '/attendance/field-day/preview', { token: tokens.agent });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.tasks.length, 3, 'open tasks due today');

  const res = await call('POST', '/attendance/check-in', {
    token: tokens.agent,
    body: { request_id: rid(), location: here(), field: true, field_note: 'Dealer visits' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.session.field_day, true);
  assert.equal(res.body.session.field_note, 'Dealer visits');
  const back = await nextWorkingDay(ids.agent, ids.dept, d);
  assert.equal(res.body.field.moved_to, back);
  assert.deepEqual(res.body.field.moved.map((m) => m.task_id).sort(), [afternoon, morning, ownTask].sort());

  for (const [id, time] of [[afternoon, '17:00'], [morning, '10:00']]) {
    const row = await taskRow(id);
    assert.equal(row.stage, 'todo', 'still open — moved, not done');
    assert.equal(new Date(row.due_date).toISOString(), at(back, time).toISOString(), 'same time, next working day');
    assert.equal(new Date(row.original_due_date).toISOString(), at(d, time).toISOString(), 'the original is kept');
    assert.equal(row.due_date_changes, 0, 'not counted as the person pushing a deadline');
  }
  assert.equal(new Date((await taskRow(finished)).due_date).toISOString(), at(d, '12:00').toISOString(), 'done work is left alone');
  assert.equal(new Date((await taskRow(tomorrow)).due_date).toISOString(), at(addDays(d, 1), '12:00').toISOString(), 'other days are left alone');

  const { rows: history } = await query(
    `SELECT meta FROM task_activity WHERE task_id = $1 AND field = 'due_date'`, [afternoon],
  );
  assert.equal(history[0].meta.reason, 'FIELD_DAY');
  assert.equal(history[0].meta.counted_as_push, false);

  // whoever assigned the work hears once, with both tasks
  const { rows: told } = await query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'deadline_moved'`, [ids.manager]);
  assert.equal(told.length, 1);
  assert.match(told[0].title, /Field agent is working in the field today — 2 tasks you assigned moved/);

  // asking again moves nothing more
  const again = await call('POST', '/attendance/field-day', { token: tokens.agent, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.moved.length, 0);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM task_deadline_moves WHERE user_id = $1', [ids.agent])).rows[0].n, 3);

  // the black-mark scan judges the new deadline: no mark for the old one
  await runBlackMarkScan({ now: at(d, '23:00') });
  const marks = await query('SELECT COUNT(*)::int AS n FROM black_marks WHERE user_id = $1', [ids.agent]);
  assert.equal(marks.rows[0].n, 0);

  // the team sees who is in the field
  const team = await call('GET', `/attendance/team/today?date=${d}`, { token: tokens.manager });
  assert.equal(team.body.counts.in_field, 1);
});

test('a field day can be marked without moving anything, and later in the day', async (t) => {
  if (skip(t)) return;
  const d = today();
  const due = await task(ids.rep, at(d, '18:00'));
  const checked = await call('POST', '/attendance/check-in', { token: tokens.rep, body: { request_id: rid(), location: here() } });
  assert.equal(checked.status, 201);
  assert.equal(checked.body.session.field_day, false);
  const res = await call('POST', '/attendance/field-day', { token: tokens.rep, body: { note: 'Plans changed', move_tasks: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.field_day, true);
  assert.equal(res.body.moved.length, 0);
  assert.equal(new Date((await taskRow(due)).due_date).toISOString(), at(d, '18:00').toISOString());
});

// ---------------------------------------------------------------- field duty, after the fact

test('an approved field-duty correction protects that day and waives its deadline marks', async (t) => {
  if (skip(t)) return;
  // the most recent working day before today
  let day = addDays(today(), -1);
  while (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) day = addDays(day, -1);
  const missed = await task(ids.sales, at(day, '11:00'));
  await runBlackMarkScan({ now: new Date() });
  const marked = await query(`SELECT id, status FROM black_marks WHERE task_id = $1`, [missed]);
  assert.equal(marked.rows[0].status, 'active', 'the missed deadline was marked');

  const ask = await call('POST', '/attendance/corrections', {
    token: tokens.sales,
    body: { work_date: day, kind: 'FIELD_DUTY', check_in: '09:30', reason: 'At farmer meetings all day, no signal to check in' },
  });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  const decided = await call('POST', `/attendance/corrections/${ask.body.correction.id}/decide`, {
    token: tokens.manager, body: { decision: 'APPROVED', note: 'Confirmed with the area lead' },
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.moved_tasks.length, 1);
  assert.equal(decided.body.marks_waived, 1);

  const session = await query('SELECT field_day FROM attendance_sessions WHERE user_id = $1 AND work_date = $2', [ids.sales, day]);
  assert.equal(session.rows[0].field_day, true);
  const mark = await query('SELECT status, waived_by, waived_reason FROM black_marks WHERE id = $1', [marked.rows[0].id]);
  assert.equal(mark.rows[0].status, 'waived');
  assert.equal(mark.rows[0].waived_by, ids.manager, 'waived by the reviewer, on record');
  assert.match(mark.rows[0].waived_reason, /Field duty/);
  const row = await taskRow(missed);
  assert.equal(row.stage, 'todo');
  assert.ok(new Date(row.due_date) > new Date(), 'the work is due again, in the future');
});

// ---------------------------------------------------------------- emergency leave

test('emergency leave moves the work at once; approval waives marks only for someone who may', async (t) => {
  if (skip(t)) return;
  let yesterday = addDays(today(), -1);
  while (new Date(`${yesterday}T00:00:00Z`).getUTCDay() === 0) yesterday = addDays(yesterday, -1);
  const overdue = await task(ids.rep, at(yesterday, '12:00'));
  const later = await task(ids.rep, at(addDays(today(), 1), '16:00'));
  await runBlackMarkScan({ now: new Date() });
  assert.equal((await query('SELECT status FROM black_marks WHERE task_id = $1', [overdue])).rows[0].status, 'active');

  // what the form shows before sending
  const preview = await call('GET', `/leave/preview?start=${yesterday}&end=${addDays(today(), 1)}`, { token: tokens.rep });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.tasks_due.some((x) => x.id === overdue));
  assert.ok(preview.body.back_on > addDays(today(), 1));

  const asked = await call('POST', '/leave', {
    token: tokens.rep,
    body: {
      category: 'CASUAL', start_date: yesterday, end_date: addDays(today(), 1), reason: 'Family emergency',
      is_emergency: true, emergency_explanation: 'Had to travel at once', move_tasks: true,
    },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.equal(asked.body.request.status, 'EMERGENCY_REVIEW');
  const movedIds = asked.body.request.moved_tasks.map((m) => m.task_id);
  assert.ok(movedIds.includes(overdue) && movedIds.includes(later), 'moved before any approval');
  const back = asked.body.request.moved_to;
  assert.ok(back > addDays(today(), 1), 'to the first working day after the leave');
  for (const id of [overdue, later]) {
    const row = await taskRow(id);
    assert.equal(row.stage, 'todo');
    assert.equal(dateIn(TZ, new Date(row.due_date)), back);
  }
  assert.equal((await query('SELECT status FROM black_marks WHERE task_id = $1', [overdue])).rows[0].status, 'active', 'the person cannot clear their own mark');

  // a reviewer without the right to waive approves: the mark waits for someone who has it
  const decided = await call('POST', `/leave/${asked.body.request.id}/decide`, { token: tokens.lead, body: { decision: 'APPROVED_UNPAID', note: 'ok' } });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.moved_tasks.length, 0, 'nothing moves twice');
  assert.equal(decided.body.marks_waived, 0);
  assert.equal(decided.body.marks_waiting, 1);
  assert.equal((await query('SELECT status FROM black_marks WHERE task_id = $1', [overdue])).rows[0].status, 'active');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM task_deadline_moves WHERE leave_request_id = $1', [asked.body.request.id])).rows[0].n, movedIds.length);
});

test('planned leave moves its deadlines when approved, and approval by someone who may waive clears the marks', async (t) => {
  if (skip(t)) return;
  // a working day two weeks out
  let start = addDays(today(), 14);
  while (new Date(`${start}T00:00:00Z`).getUTCDay() === 0) start = addDays(start, 1);
  const due = await task(ids.sales, at(start, '13:00'));
  const asked = await call('POST', '/leave', {
    token: tokens.sales,
    body: { category: 'CASUAL', start_date: start, end_date: start, reason: 'Wedding', move_tasks: true },
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.equal(asked.body.request.moved_tasks.length, 0, 'planned leave waits for approval');
  assert.equal(dateIn(TZ, new Date((await taskRow(due)).due_date)), start);

  const decided = await call('POST', `/leave/${asked.body.request.id}/decide`, { token: tokens.manager, body: { decision: 'APPROVED_UNPAID', note: 'ok' } });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.moved_tasks.length, 1);
  assert.ok(dateIn(TZ, new Date((await taskRow(due)).due_date)) > start);
});

test('a half day does not move deadlines, and leave without the option moves nothing', async (t) => {
  if (skip(t)) return;
  let start = addDays(today(), 21);
  while (new Date(`${start}T00:00:00Z`).getUTCDay() === 0) start = addDays(start, 1);
  const due = await task(ids.agent, at(start, '16:00'));
  const half = await call('POST', '/leave', {
    token: tokens.agent,
    body: { category: 'CASUAL', start_date: start, end_date: start, day_part: 'FIRST_HALF', reason: 'Doctor', move_tasks: true },
  });
  assert.equal(half.status, 201, JSON.stringify(half.body));
  assert.equal(half.body.request.move_tasks, false, 'the other half is worked');
  await call('POST', `/leave/${half.body.request.id}/decide`, { token: tokens.manager, body: { decision: 'APPROVED_UNPAID', note: 'ok' } });
  assert.equal(dateIn(TZ, new Date((await taskRow(due)).due_date)), start);
});
