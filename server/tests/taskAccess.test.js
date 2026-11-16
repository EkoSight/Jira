/**
 * Part 0 of the projects and to-dos build: one rule for who may see a task,
 * and the checklist (steps) routes following it.
 *
 *   1  a matrix of made-up people and tasks gets identical answers from the
 *      rule as it was (copied below) and from services/taskAccess.js, for the
 *      list, a single task, editing, and the workspace's record check
 *   2  checklist: someone who cannot see a task gets 404 for adding, ticking,
 *      renaming or removing its steps; a step from another task is 404;
 *      the people the task's rules allow can still act
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
import { hasPermission } from '../src/lib/permissions.js';
import { canEditTask, canSeeTask, taskVisibilitySql } from '../src/services/taskAccess.js';
import { canSeeRecord } from '../src/services/workspace/access.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const users = {};

const call = async (method, p, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };

const PEOPLE = [
  // key, role, department
  ['mgr', 'manager', 'OPS'], ['ann', 'member', 'OPS'], ['ben', 'member', 'OPS'],
  ['cai', 'member', 'PRG'], ['dee', 'member', 'PRG'], ['fay', 'viewer', 'PRG'], ['gus', 'member', null],
];

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#0a7', 1), ('PRG', 'Programmes', '#2a78d6', 2)`);
  for (const r of (await query('SELECT id, key FROM departments')).rows) ids[r.key] = r.id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  const st = (await query(`SELECT id FROM workflow_statuses WHERE stage = 'todo'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of PEOPLE) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING *',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.acc@test.local`, password, role, dept ? ids[dept] : null],
    );
    ids[key] = rows[0].id;
    users[key] = rows[0];
  }
  // one member who has lost "edit own"
  await query(`UPDATE users SET revoked_permissions = ARRAY['task.edit.own'] WHERE id = $1`, [ids.ben]);
  users.ben = (await query('SELECT * FROM users WHERE id = $1', [ids.ben])).rows[0];

  const task = async (ref, dept, { assignee = null, follower = null, reporter = null, creator = null } = {}) => (await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, follower_id, reporter_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [ref, `Sample task ${ref}`, ids[dept], st, assignee && ids[assignee], follower && ids[follower], reporter && ids[reporter], creator && ids[creator]],
  )).rows[0].id;
  ids.t1 = await task('OPS-1', 'OPS', { assignee: 'ann', creator: 'mgr' });
  ids.t2 = await task('PRG-1', 'PRG', { assignee: 'cai', follower: 'fay', reporter: 'ben' });
  ids.t3 = await task('PRG-2', 'PRG', { creator: 'gus' });
  ids.t4 = await task('PRG-3', 'PRG', { assignee: 'dee' });
  ids.t5 = await task('OPS-2', 'OPS', {});
  await query('INSERT INTO task_collaborators (task_id, user_id) VALUES ($1, $2)', [ids.t1, ids.dee]);
  await query('INSERT INTO task_checklist_items (task_id, title, position) VALUES ($1, $2, 1), ($3, $4, 1)',
    [ids.t1, 'Sample step on OPS-1', ids.t4, 'Sample step on PRG-3']);
  ids.s1 = (await query('SELECT id FROM task_checklist_items WHERE task_id = $1', [ids.t1])).rows[0].id;
  ids.s4 = (await query('SELECT id FROM task_checklist_items WHERE task_id = $1', [ids.t4])).rows[0].id;

  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const [key] of PEOPLE) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `${key}.acc@test.local`, password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

/** The rule exactly as it was before Part 0, kept here as the reference. */
async function oldVisibleIds(user) {
  if (hasPermission(user, 'task.view.all')) return (await query('SELECT id FROM tasks t ORDER BY id')).rows.map((r) => r.id);
  const { rows } = await query(
    `SELECT t.id FROM tasks t
      WHERE (t.assignee_id = $1 OR t.follower_id = $1 OR t.reporter_id = $1 OR t.created_by = $1
             OR t.department_id = $2
             OR EXISTS (SELECT 1 FROM task_collaborators tc WHERE tc.task_id = t.id AND tc.user_id = $1))
      ORDER BY t.id`,
    [user.id, user.department_id],
  );
  return rows.map((r) => r.id);
}
function oldCanEdit(user, task) {
  if (hasPermission(user, 'task.edit.any')) return true;
  if (!hasPermission(user, 'task.edit.own')) return false;
  return [task.assignee_id, task.follower_id, task.reporter_id, task.created_by].includes(user.id);
}

test('1: the one rule gives the same answers as the rule as it was, for every person and task', async (t) => {
  if (skip(t)) return;
  const tasks = (await query('SELECT * FROM tasks ORDER BY id')).rows;
  let compared = 0;
  for (const [key] of PEOPLE) {
    const user = users[key];
    const before = await oldVisibleIds(user);
    const params = [];
    const where = taskVisibilitySql(user, params);
    const after = (await query(`SELECT t.id FROM tasks t WHERE ${where} ORDER BY t.id`, params)).rows.map((r) => r.id);
    assert.deepEqual(after, before, `list for ${key}`);
    for (const task of tasks) {
      const expected = before.includes(task.id);
      assert.equal(await canSeeTask(user, task.id), expected, `single task ${task.ref} for ${key}`);
      assert.equal(await canSeeRecord(user, 'TASK', task.id), expected, `workspace check ${task.ref} for ${key}`);
      assert.equal(canEditTask(user, task), oldCanEdit(user, task), `edit ${task.ref} for ${key}`);
      compared += 1;
    }
  }
  assert.equal(compared, PEOPLE.length * tasks.length);
  // and the board, through the API, shows each person exactly that list
  for (const [key] of PEOPLE) {
    const res = await call('GET', '/tasks?limit=1000', { token: tokens[key] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.tasks.map((x) => x.id).sort((a, b) => a - b), await oldVisibleIds(users[key]), `board for ${key}`);
  }
});

test('2: checklist steps follow the task\'s rules; a step from another task is not found', async (t) => {
  if (skip(t)) return;
  // Cai (Programmes, not on OPS-1) cannot see OPS-1: every step action is 404
  assert.equal((await call('POST', `/tasks/${ids.t1}/checklist`, { token: tokens.cai, body: { title: 'Sample sneaky step' } })).status, 404);
  assert.equal((await call('PATCH', `/tasks/${ids.t1}/checklist/${ids.s1}`, { token: tokens.cai, body: { is_done: true } })).status, 404);
  assert.equal((await call('PATCH', `/tasks/${ids.t1}/checklist/${ids.s1}`, { token: tokens.cai, body: { title: 'Renamed' } })).status, 404);
  assert.equal((await call('DELETE', `/tasks/${ids.t1}/checklist/${ids.s1}`, { token: tokens.cai })).status, 404);
  const untouched = (await query('SELECT title, is_done FROM task_checklist_items WHERE id = $1', [ids.s1])).rows[0];
  assert.deepEqual(untouched, { title: 'Sample step on OPS-1', is_done: false });
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM task_checklist_items WHERE task_id = $1', [ids.t1])).rows[0].n, 1);

  // a step id from another task, through a task the person can see, is 404
  assert.equal((await call('PATCH', `/tasks/${ids.t1}/checklist/${ids.s4}`, { token: tokens.ann, body: { is_done: true } })).status, 404);
  assert.equal((await call('DELETE', `/tasks/${ids.t1}/checklist/${ids.s4}`, { token: tokens.mgr })).status, 404);
  assert.equal((await query('SELECT is_done FROM task_checklist_items WHERE id = $1', [ids.s4])).rows[0].is_done, false);

  // Ben sees OPS-1 through his department but cannot edit it: he may add and tick, not rename or remove
  const added = await call('POST', `/tasks/${ids.t1}/checklist`, { token: tokens.ben, body: { title: 'Sample step by Ben' } });
  assert.equal(added.status, 201);
  assert.equal((await call('PATCH', `/tasks/${ids.t1}/checklist/${ids.s1}`, { token: tokens.ben, body: { is_done: true } })).status, 200);
  assert.equal((await call('PATCH', `/tasks/${ids.t1}/checklist/${ids.s1}`, { token: tokens.ben, body: { title: 'Renamed by Ben' } })).status, 403);
  assert.equal((await call('DELETE', `/tasks/${ids.t1}/checklist/${added.body.item.id}`, { token: tokens.ben })).status, 403);

  // Dee is tagged on OPS-1 (another department): she can see it, so she may tick
  assert.equal((await call('PATCH', `/tasks/${ids.t1}/checklist/${ids.s1}`, { token: tokens.dee, body: { is_done: false } })).status, 200);

  // Ann owns OPS-1 and the manager edits anything: both may rename and remove
  assert.equal((await call('PATCH', `/tasks/${ids.t1}/checklist/${ids.s1}`, { token: tokens.ann, body: { title: 'Sample step, renamed' } })).status, 200);
  assert.equal((await call('DELETE', `/tasks/${ids.t1}/checklist/${added.body.item.id}`, { token: tokens.mgr })).status, 200);
  const steps = (await query('SELECT title FROM task_checklist_items WHERE task_id = $1 ORDER BY id', [ids.t1])).rows.map((r) => r.title);
  assert.deepEqual(steps, ['Sample step, renamed']);
});
