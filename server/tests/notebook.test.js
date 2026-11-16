/**
 * The notebook's server side (Part N). Numbers refer to the build prompt's
 * tests (section 8). Company timezone Asia/Kolkata; dates are illustrative.
 * Made-up people only.
 *
 *   46 (server part) an offline change carries its client key and when it was made:
 *      sent twice it applies once; text changed on two devices, the later change wins
 *   47 past pages: a moved line shows "-> Mon 16 Nov" on Friday's page; done lines stay;
 *      looking changes nothing; ticking an old line records when it was really done
 *   48 day notes: private (another user, a manager, an admin: 404 / nothing);
 *      "Make this a to-do" makes the to-do and keeps the note line
 *   and: stars, stamps in the project's colour (else the department's), the month index, the switches
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';

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

const PEOPLE = [['admin', 'admin', 'PRG'], ['mona', 'manager', 'PRG'], ['vera', 'member', 'PRG'], ['wes', 'member', 'PRG'], ['eli', 'super_admin', null]];

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('PRG', 'Programmes', '#2a78d6', 1)`);
  ids.PRG = (await query("SELECT id FROM departments WHERE key = 'PRG'")).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE)`);
  ids.st_todo = (await query('SELECT id FROM workflow_statuses')).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of PEOPLE) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING *',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.nb@test.local`, password, role, dept ? ids[dept] : null],
    );
    ids[key] = rows[0].id;
    await query('INSERT INTO employee_work_profiles (user_id, attendance_required) VALUES ($1, FALSE)', [rows[0].id]);
  }
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const [key] of PEOPLE) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.nb@test.local`, password: 'Password123!' } })).token;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('47: Friday\'s page shows a moved line with "-> Mon 16 Nov"; done lines stay; looking changes nothing', async (t) => {
  if (skip(t)) return;
  const a = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample thank the hosts', planned_on: '2026-11-13' } }), 201).todo;
  const b = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample file receipts', planned_on: '2026-11-13' } }), 201).todo;
  ok(await call('PATCH', `/todos/${b.id}`, { token: tokens.vera, body: { done: true } }));
  ok(await call('PATCH', `/todos/${a.id}`, { token: tokens.vera, body: { planned_on: '2026-11-16' } }));
  const before = (await query('SELECT * FROM todos WHERE owner_user_id = $1 ORDER BY id', [ids.vera])).rows;
  const friday = ok(await call('GET', '/todos/day/2026-11-13', { token: tokens.vera }));
  assert.equal(friday.day, '2026-11-13');
  assert.equal(friday.week, 46);
  assert.deepEqual(friday.moved.map((m) => [m.title, m.moved_to]), [['Sample thank the hosts', '2026-11-16']]);
  const done = friday.items.find((i) => i.id === b.id);
  assert.equal(done.done, true, 'struck through, still on its page');
  assert.ok(!friday.items.some((i) => i.id === a.id), 'the moved line is not listed twice');
  const monday = ok(await call('GET', '/todos/day/2026-11-16', { token: tokens.vera }));
  assert.ok([...monday.carried, ...monday.items].some((i) => i.id === a.id), 'and is on the page it moved to');
  assert.deepEqual((await query('SELECT * FROM todos WHERE owner_user_id = $1 ORDER BY id', [ids.vera])).rows, before, 'looking changed nothing');

  // ticking an old line records when it was really done (now), not the page's date
  const c = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample old line', planned_on: '2026-11-02' } }), 201).todo;
  const t0 = Date.now();
  const ticked = ok(await call('PATCH', `/todos/${c.id}`, { token: tokens.vera, body: { done: true } })).todo;
  assert.ok(new Date(ticked.done_at).getTime() >= t0 - 1000, 'the real time of ticking');
  assert.equal(ticked.planned_on, '2026-11-02', 'it stays on its own page');
});

test('48: day notes are private; "Make this a to-do" makes the to-do and keeps the note line', async (t) => {
  if (skip(t)) return;
  const body = 'Sample: call the printer about badges\nSample: ask Wes for the guest list\n';
  const saved = ok(await call('PUT', '/todos/notes/2026-11-16', { token: tokens.vera, body: { body } }));
  assert.equal(saved.note.body, body);
  for (const who of ['wes', 'mona', 'admin', 'eli']) {
    assert.equal(ok(await call('GET', '/todos/notes/2026-11-16', { token: tokens[who] })).note.body, '', `${who} sees only their own (empty) notes`);
    assert.ok(!JSON.stringify(ok(await call('GET', '/todos/day/2026-11-16', { token: tokens[who] }))).includes('printer'), who);
    assert.equal((await call('POST', '/todos/notes/2026-11-16/to-todo', { token: tokens[who], body: { line: 'Sample: call the printer about badges' } })).status, 404, `${who} cannot reach Vera's note`);
  }
  const made = ok(await call('POST', '/todos/notes/2026-11-16/to-todo', { token: tokens.vera, body: { line: 'Sample: call the printer about badges', client_key: 'note-1' } }), 201);
  assert.equal(made.todo.title, 'Sample: call the printer about badges');
  assert.equal(made.todo.planned_on, '2026-11-16');
  assert.equal(made.todo.origin, 'NOTE');
  const again = ok(await call('POST', '/todos/notes/2026-11-16/to-todo', { token: tokens.vera, body: { line: 'Sample: call the printer about badges', client_key: 'note-1' } }), 201);
  assert.equal(again.todo.id, made.todo.id, 'the same tap twice makes one');
  assert.equal(ok(await call('GET', '/todos/notes/2026-11-16', { token: tokens.vera })).note.body, body, 'the note keeps the line');
  assert.equal(ok(await call('GET', '/todos/day/2026-11-16', { token: tokens.vera })).note.body, body);
});

test('stars, stamps in the project\'s colour (else the department\'s), the month index and the switches', async (t) => {
  if (skip(t)) return;
  const project = ok(await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample Seed Grant 2027', department_id: ids.PRG, lead_user_id: ids.mona, status: 'ACTIVE', color: '#7A3E9D' } }), 201).project;
  assert.equal(project.color, '#7A3E9D');
  const task = ok(await call('POST', '/tasks', { token: tokens.mona, body: { title: 'Sample budget annex', department_id: ids.PRG, status_id: ids.st_todo, assignee_id: ids.vera, due_date: new Date(Date.now() + 86_400_000).toISOString() } }), 201).task;
  const onTask = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample check figures', link_type: 'TASK', link_id: task.id, planned_on: 'TODAY' } }), 201).todo;
  assert.deepEqual(onTask.stamp, { text: task.ref, color: '#2a78d6' }, 'no project: the department\'s colour');
  ok(await call('PATCH', `/tasks/${task.id}`, { token: tokens.mona, body: { project_id: project.id } }));
  const onProject = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample logos', link_type: 'PROJECT', link_id: project.id } }), 201).todo;
  assert.deepEqual(onProject.stamp, { text: 'Sample Seed Grant 2027', color: '#7A3E9D' });
  const page = ok(await call('GET', `/todos/day/${onTask.planned_on}`, { token: tokens.vera }));
  assert.deepEqual(page.items.find((i) => i.id === onTask.id).stamp, { text: task.ref, color: '#7A3E9D' }, 'in its project now: the project\'s colour');
  assert.equal((await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample bad colour', department_id: ids.PRG, lead_user_id: ids.mona, color: 'purple' } })).status, 400);

  const starred = ok(await call('PATCH', `/todos/${onTask.id}`, { token: tokens.vera, body: { starred: true } })).todo;
  assert.equal(starred.starred, true);

  const month = ok(await call('GET', '/todos/month/2026-11', { token: tokens.vera }));
  const days = Object.fromEntries(month.days.map((d) => [d.day, d]));
  assert.equal(days['2026-11-13'].total, 1, 'Friday: the done line (the moved one is counted on Monday)');
  assert.equal(days['2026-11-16'].note, true);
  assert.ok(!month.days.some((d) => d.day < '2026-11-01'), 'only this month');

  assert.deepEqual(ok(await call('PUT', '/todos/prefs', { token: tokens.vera, body: { handwriting: true, haptics: true } })), { hide_done: false, handwriting: true, haptics: true });
  assert.deepEqual(ok(await call('PUT', '/todos/prefs', { token: tokens.wes, body: {} })), { hide_done: false, handwriting: false, haptics: false }, 'off by default, per person');
});

test('46 (server part): an offline change sent twice applies once; text changed on two devices, the later change wins', async (t) => {
  if (skip(t)) return;
  const key = 'offline-add-1';
  const first = ok(await call('POST', '/todos', { token: tokens.wes, body: { title: 'Sample written offline', planned_on: 'TODAY', client_key: key } }), 201);
  const replay = ok(await call('POST', '/todos', { token: tokens.wes, body: { title: 'Sample written offline', planned_on: 'TODAY', client_key: key } }));
  assert.equal(replay.todo.id, first.todo.id);
  assert.equal(replay.duplicate, true);

  // another device renamed it after the offline edit was made: the later change (the other device's) wins
  const madeOffline = new Date(Date.now() - 60_000).toISOString();
  ok(await call('PATCH', `/todos/${first.todo.id}`, { token: tokens.wes, body: { title: 'Sample renamed on the laptop' } }));
  const late = ok(await call('PATCH', `/todos/${first.todo.id}`, { token: tokens.wes, body: { title: 'Sample renamed on the phone, offline', changed_at: madeOffline } }));
  assert.equal(late.todo.title, 'Sample renamed on the laptop');
  assert.equal(late.stale, 'Changed on another device · showing the latest');
  // an offline edit made after the other device's change wins
  const newer = ok(await call('PATCH', `/todos/${first.todo.id}`, { token: tokens.wes, body: { title: 'Sample renamed later', changed_at: new Date(Date.now() + 1000).toISOString() } }));
  assert.equal(newer.todo.title, 'Sample renamed later');
  assert.equal(newer.stale, undefined);
  // a line deleted on another device: the offline change is refused (the client drops it, with a notice)
  ok(await call('DELETE', `/todos/${first.todo.id}`, { token: tokens.wes }));
  assert.equal((await call('PATCH', `/todos/${first.todo.id}`, { token: tokens.wes, body: { done: true } })).status, 404);
});
