/**
 * To-dos everywhere and routines (Parts C and D). Numbers refer to the build
 * prompt's tests (section 8). Company timezone Asia/Kolkata; dates are
 * illustrative. Made-up people only; Chat replies are returned to the test,
 * nothing is sent to anyone.
 *
 *   34 the workspace widget tops every template; a saved layout changes only on "Add"
 *   35 Chat: todo, +, todos, done 2, undo; existing commands unchanged; a message delivered twice acts once
 *   37 routines: one item per working day; none on a weekly off, a holiday or leave; no backfill;
 *      editing changes future items only; stopping keeps the history
 *   38 a to-do's reminder is cancelled by ticking it
 *   and: the morning summary's plan line, for the person only
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { handleChatEvent } from '../src/services/googleChat.js';
import { personalSummary } from '../src/services/taskSummaries.js';
import { makeRoutineTodos } from '../src/services/todos/routines.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};

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
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
// 10:30 in Kolkata on a given date
const morningOf = (date) => new Date(`${date}T05:00:00Z`);

const PEOPLE = [['admin', 'admin', 'OPS'], ['vera', 'member', 'PRG'], ['omar', 'member', 'OPS'], ['rita', 'member', 'PRG']];

let msg = 0;
const dm = (key, text, name = null) => handleChatEvent({
  type: 'MESSAGE',
  space: { name: `spaces/DM-${key.toUpperCase()}`, spaceType: 'DIRECT_MESSAGE' },
  user: { name: `users/${key}`, email: `${key}.ev@test.local` },
  message: { name: name || `spaces/DM-${key.toUpperCase()}/messages/m${(msg += 1)}`, text, argumentText: text },
});

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#0a7', 1), ('PRG', 'Programmes', '#2a78d6', 2)`);
  for (const r of (await query('SELECT id, key FROM departments')).rows) ids[r.key] = r.id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) ids[`st_${r.stage}`] = r.id;
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of PEOPLE) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING *',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.ev@test.local`, password, role, ids[dept]],
    );
    ids[key] = rows[0].id;
    await query('INSERT INTO employee_work_profiles (user_id, attendance_required) VALUES ($1, FALSE)', [rows[0].id]);
    await query(`INSERT INTO chat_spaces (space_name, kind, user_id, active) VALUES ($1, 'DM', $2, TRUE)`, [`spaces/DM-${key.toUpperCase()}`, rows[0].id]);
  }
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const [key] of PEOPLE) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.ev@test.local`, password: 'Password123!' } })).token;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('34: Today\'s plan tops every template; a saved layout changes only when the person says Add', async (t) => {
  if (skip(t)) return;
  const { rows } = await query('SELECT key, layout FROM dashboard_templates ORDER BY key');
  assert.ok(rows.length >= 3);
  for (const r of rows) assert.equal(r.layout.widgets[0].type, 'todos', `${r.key} starts with Today's plan`);
  const fresh = ok(await call('GET', '/workspace', { token: tokens.vera }));
  assert.equal(fresh.source, 'TEMPLATE');
  assert.equal(fresh.widgets[0].type, 'todos');
  assert.deepEqual(fresh.offers, {}, 'a template layout needs no offer');

  // Rita saved her own layout before: it is not changed, she is asked once
  const own = fresh.widgets.filter((w) => w.type !== 'todos').map(({ id, type, typeVersion, width, config: c }) => ({ id, type, typeVersion, width, config: c }));
  ok(await call('PUT', '/workspace/layout', { token: tokens.rita, body: { version: 0, widgets: own } }));
  const saved = ok(await call('GET', '/workspace', { token: tokens.rita }));
  assert.equal(saved.source, 'CUSTOM');
  assert.ok(!saved.widgets.some((w) => w.type === 'todos'), 'never added silently');
  assert.equal(saved.offers.todos.question, 'Add Today’s plan to your workspace?');
  ok(await call('POST', '/workspace/offers/todos', { token: tokens.rita, body: { answer: 'NO' } }));
  const declined = ok(await call('GET', '/workspace', { token: tokens.rita }));
  assert.deepEqual(declined.offers, {}, 'the choice is remembered');
  assert.equal(declined.version, saved.version, '"No thanks" changes nothing');
  assert.ok(!declined.widgets.some((w) => w.type === 'todos'));

  // Omar too, and he adds it: at the top, as a new version of his own layout
  ok(await call('PUT', '/workspace/layout', { token: tokens.omar, body: { version: 0, widgets: own } }));
  const before_ = ok(await call('GET', '/workspace', { token: tokens.omar }));
  ok(await call('POST', '/workspace/offers/todos', { token: tokens.omar, body: { answer: 'ADD' } }));
  const added = ok(await call('GET', '/workspace', { token: tokens.omar }));
  assert.equal(added.widgets[0].type, 'todos');
  assert.equal(added.version, before_.version + 1);
  assert.deepEqual(added.widgets.slice(1).map((w) => w.id), before_.widgets.map((w) => w.id), 'the rest of his layout is as he left it');
  assert.deepEqual(added.offers, {});
});

test('35: Chat: todo, +, todos, done 2, undo; a message delivered twice acts once; old commands unchanged', async (t) => {
  if (skip(t)) return;
  const first = await dm('vera', 'todo Sample book the hall', 'spaces/DM-VERA/messages/fixed-1');
  assert.match(first.text, /^Added “Sample book the hall” to today’s plan\. 1 left\. Reply `undo`/);
  const twice = await dm('vera', 'todo Sample book the hall', 'spaces/DM-VERA/messages/fixed-1');
  assert.match(twice.text, /1 left/, 'the same message delivered again');
  assert.equal((await query("SELECT count(*)::int AS n FROM todos WHERE owner_user_id = $1 AND title = 'Sample book the hall'", [ids.vera])).rows[0].n, 1);
  await dm('vera', '+ Sample Print Badges');
  await dm('vera', '+Sample order tea');
  const titles = (await query('SELECT title, source, planned_on FROM todos WHERE owner_user_id = $1 ORDER BY id', [ids.vera])).rows;
  assert.deepEqual(titles.map((r) => r.title), ['Sample book the hall', 'Sample Print Badges', 'Sample order tea'], 'the words keep their case');
  assert.ok(titles.every((r) => r.source === 'CHAT' && r.planned_on), 'private to-dos for today');

  const list = await dm('vera', 'todos');
  assert.match(list.text, /^\*Today’s plan\*: 3 left/);
  assert.match(list.text, /\n1\. Sample book the hall\n2\. Sample Print Badges\n3\. Sample order tea\n/);
  const done = await dm('vera', 'done 2', 'spaces/DM-VERA/messages/fixed-2');
  assert.match(done.text, /^Ticked “Sample Print Badges”\. 2 left\./);
  const again = await dm('vera', 'done 2', 'spaces/DM-VERA/messages/fixed-2');
  assert.match(again.text, /Ticked “Sample Print Badges”/, 'a duplicate delivery ticks nothing new');
  assert.equal((await query('SELECT count(*)::int AS n FROM todos WHERE owner_user_id = $1 AND done_at IS NOT NULL', [ids.vera])).rows[0].n, 1);
  assert.match((await dm('vera', 'done 9')).text, /There is no line 9/);
  const undone = await dm('vera', 'undo');
  assert.equal(undone.text, 'Unticked “Sample Print Badges”.');
  assert.equal((await query('SELECT count(*)::int AS n FROM todos WHERE owner_user_id = $1 AND done_at IS NOT NULL', [ids.vera])).rows[0].n, 0);
  assert.equal((await dm('vera', 'undo')).text, 'Nothing to undo.');
  await dm('vera', 'todo Sample take this back');
  assert.equal((await dm('vera', 'undo')).text, 'Took back “Sample take this back”.');
  assert.equal((await query("SELECT archived_at IS NOT NULL AS gone FROM todos WHERE title = 'Sample take this back'")).rows[0].gone, true);

  // another person's list is their own
  assert.match((await dm('omar', 'todos')).text, /nothing left/);
  // the existing commands answer as before; help lists the new ones
  assert.match((await dm('vera', 'tasks')).text, /no open tasks/i);
  assert.match((await dm('vera', 'stop')).text, /^Instant alerts paused/);
  assert.match((await dm('vera', 'start')).text, /^Instant alerts are on/);
  const help = (await dm('vera', 'help')).text;
  assert.match(help, /`tasks`/);
  assert.match(help, /`todo <words>` or `\+ <words>`/);
  assert.match(help, /`done 2`/);
});

test('the morning summary carries one plan line, for the person only', async (t) => {
  if (skip(t)) return;
  // a task makes the summary worth sending; the plan line rides along
  await query(`INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date)
    VALUES ('PRG-1', 'Sample grant draft', $1, $2, $3, $3, $3, now() + interval '1 day')`, [ids.PRG, ids.st_todo, ids.vera]);
  await query("INSERT INTO todos (owner_user_id, title, planned_on) VALUES ($1, 'Sample from yesterday', (now() AT TIME ZONE 'Asia/Kolkata')::date - 1)", [ids.vera]);
  const summary = await personalSummary(ids.vera, { force: true });
  assert.match(summary.text, /Today’s plan: 4 to-dos \(1 carried over\)/);
  assert.ok(!summary.text.includes('Sample book the hall'), 'a count, never the words');
  const omar = await personalSummary(ids.omar, { force: true });
  assert.ok(!/Today’s plan/.test(omar.text), 'nothing for someone with nothing planned');
});

test('37: routines: one item per working day; none on a weekly off, a holiday or leave; no backfill', async (t) => {
  if (skip(t)) return;
  const r = ok(await call('POST', '/todos/routines', { token: tokens.rita, body: { title: 'Sample check the inbox', repeat_kind: 'WORKING_DAYS', planned_time: '09:30' } }), 201).routine;
  const weekly = ok(await call('POST', '/todos/routines', { token: tokens.rita, body: { title: 'Sample weekly sync notes', repeat_kind: 'WEEKLY', weekdays: [1, 4] } }), 201).routine;
  await query("UPDATE todo_routines SET starts_on = '2027-01-01' WHERE owner_user_id = $1", [ids.rita]);
  // Wed 20 Jan 2027 is a company holiday; Thu 21 Jan Rita is on approved leave; Sun 24 Jan is the weekly off
  await query(`INSERT INTO work_holidays (holiday_date, name) VALUES ('2027-01-20', 'Sample holiday')`);
  await query(`INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status, day_allocation, paid_days, created_by)
    VALUES ($1, 'CASUAL', '2027-01-21', '2027-01-21', 'sample', 'APPROVED_PAID', $2, 1, $1)`, [ids.rita, JSON.stringify([{ date: '2027-01-21', portion: 1, paid: 1 }])]);
  for (const d of ['2027-01-18', '2027-01-19', '2027-01-20', '2027-01-21', '2027-01-22', '2027-01-23', '2027-01-24']) {
    await makeRoutineTodos({ now: morningOf(d) });
    await makeRoutineTodos({ now: new Date(morningOf(d).getTime() + 3 * 3_600_000) }); // a rerun later the same day
  }
  const days = (await query('SELECT planned_on, planned_time FROM todos WHERE routine_id = $1 ORDER BY planned_on', [r.id])).rows;
  assert.deepEqual(days.map((x) => x.planned_on), ['2027-01-18', '2027-01-19', '2027-01-22', '2027-01-23'],
    'Mon, Tue, Fri, Sat: not the holiday, the leave day or Sunday; one each, reruns included');
  assert.ok(days.every((x) => x.planned_time === '09:30'));
  const weeklyDays = (await query('SELECT planned_on FROM todos WHERE routine_id = $1 ORDER BY planned_on', [weekly.id])).rows.map((x) => x.planned_on);
  assert.deepEqual(weeklyDays, ['2027-01-18'], 'Monday; Thursday was her leave');

  // downtime: nothing ran from the 25th to the 28th; only the 29th is made
  await makeRoutineTodos({ now: morningOf('2027-01-29') });
  const after1 = (await query('SELECT planned_on FROM todos WHERE routine_id = $1 ORDER BY planned_on', [r.id])).rows.map((x) => x.planned_on);
  assert.deepEqual(after1.slice(-1), ['2027-01-29']);
  assert.equal(after1.length, 5, 'no backfill');

  // editing changes future items only; stopping keeps the history
  ok(await call('PATCH', `/todos/routines/${r.id}`, { token: tokens.rita, body: { title: 'Sample check the shared inbox' } }));
  assert.equal((await query('SELECT count(*)::int AS n FROM todos WHERE routine_id = $1 AND title = $2', [r.id, 'Sample check the inbox'])).rows[0].n, 5);
  await makeRoutineTodos({ now: morningOf('2027-01-30') });
  assert.equal((await query("SELECT title FROM todos WHERE routine_id = $1 AND planned_on = '2027-01-30'", [r.id])).rows[0].title, 'Sample check the shared inbox');
  ok(await call('POST', `/todos/routines/${r.id}/stop`, { token: tokens.rita }));
  await makeRoutineTodos({ now: morningOf('2027-02-01') });
  assert.equal((await query('SELECT count(*)::int AS n FROM todos WHERE routine_id = $1', [r.id])).rows[0].n, 6, 'stopped: nothing new, history kept');
  // private: another person sees nothing of Rita's routines
  assert.deepEqual(ok(await call('GET', '/todos/routines', { token: tokens.vera })).routines, []);
  assert.equal((await call('POST', `/todos/routines/${weekly.id}/stop`, { token: tokens.vera })).status, 404);
});

test('38: a to-do\'s own reminder is cancelled by ticking it; another person cannot set one on it', async (t) => {
  if (skip(t)) return;
  const todo = ok(await call('POST', '/todos', { token: tokens.omar, body: { title: 'Sample call the printer', planned_on: 'TODAY' } }), 201).todo;
  const r = ok(await call('POST', '/workspace/reminders/personal', { token: tokens.omar, body: { entity_type: 'TODO', entity_id: todo.id, remind_at: day(1) } }), 201);
  const reminderId = r.reminder?.id || r.id;
  assert.ok(reminderId);
  const planned = (await query("SELECT status FROM reminder_occurrences WHERE entity_type = 'TODO' AND entity_id = $1", [todo.id])).rows;
  assert.deepEqual(planned.map((p) => p.status), ['PENDING']);
  assert.equal((await call('POST', '/workspace/reminders/personal', { token: tokens.vera, body: { entity_type: 'TODO', entity_id: todo.id, remind_at: day(1) } })).status, 404, 'not available to anyone else');
  ok(await call('PATCH', `/todos/${todo.id}`, { token: tokens.omar, body: { done: true } }));
  assert.equal((await query('SELECT status FROM personal_reminders WHERE id = $1', [reminderId])).rows[0].status, 'CANCELLED');
  assert.deepEqual((await query("SELECT status FROM reminder_occurrences WHERE entity_type = 'TODO' AND entity_id = $1", [todo.id])).rows.map((p) => p.status), ['CANCELLED']);
});
