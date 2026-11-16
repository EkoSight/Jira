/**
 * Quick to-dos, Today's plan, steps, private and shared (Parts A and B).
 * Numbers refer to the build prompt's tests (section 8). Company timezone
 * Asia/Kolkata; dates are illustrative. Made-up people and records only.
 *
 *   22 one line and Enter; a 5-line paste; the same client key twice
 *   23 typed task references link privately, only when visible; no date guessing
 *   24 carried over: labelled with its day, never overdue, private
 *   25 the person's own timezone; reordering; the header count equals the plan
 *   26 a pinned task shows its live status; nothing completes silently
 *   27 privacy: nobody else, whatever their role, gets anything of mine
 *   28 sharing: who will see it first; on a task a step (2/4 -> 2/5); on a project the Steps tab, progress unchanged
 *   29 ticking a shared step in my plan ticks the same row, with who and when
 *   30 steps never change the task; when all are done only the assignee is asked
 *   31 the chain in "What I did": project, parent task, key result, objective, department
 *   32 moving the parent to another project moves the to-do's derived project; the row is unchanged
 *   33 "Make it a task" from a project to-do: the task is in that project; "Became WS-40"
 *   and: old steps get no invented owner or date; lists ("Use again"); module off answers 404
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { todayPlan, createTodo, updateTodo } from '../src/services/todos/index.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const refs = {};
let oldStep = null;
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

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
const userRow = async (key) => (await query('SELECT * FROM users WHERE id = $1', [ids[key]])).rows[0];
const keys = (plan) => [...plan.carried, ...plan.items].map((i) => i.key);

const PEOPLE = [
  ['admin', 'admin', 'OPS'], ['mona', 'manager', 'WS'], ['vera', 'member', 'WS'], ['wes', 'member', 'WS'],
  ['omar', 'member', 'OPS'], ['eli', 'super_admin', null],
];

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  // up to 038 (the site before to-dos), an existing ticked step, then 039 onwards
  await query(`CREATE SCHEMA "${config.db.schema}"`);
  await query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql') && f < '039').sort()) {
    await query('BEGIN');
    await query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await query('COMMIT');
  }
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('WS', 'Programmes', '#2a78d6', 1), ('OPS', 'Operations', '#0a7', 2)`);
  for (const r of (await query('SELECT id, key FROM departments')).rows) ids[r.key] = r.id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Doing', 'doing', 'in_progress', '#f59e0b', 2, FALSE),
    ('Done', 'done', 'done', '#22c55e', 3, FALSE), ('Cancelled', 'cancelled', 'cancelled', '#94a3b8', 4, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) ids[`st_${r.stage}`] = r.id;
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of PEOPLE) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING *',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.td@test.local`, password, role, dept ? ids[dept] : null],
    );
    ids[key] = rows[0].id;
    await query('INSERT INTO employee_work_profiles (user_id, attendance_required) VALUES ($1, FALSE)', [rows[0].id]);
  }
  await query(`INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date)
    VALUES ('OPS-1', 'Sample existing task', $1, $2, $3, $3, $3, now() + interval '3 days')`, [ids.OPS, ids.st_todo, ids.omar]);
  await query(`INSERT INTO task_checklist_items (task_id, title, position, is_done) SELECT id, 'Sample old ticked step', 1, TRUE FROM tasks WHERE ref = 'OPS-1'`);
  oldStep = (await query('SELECT * FROM task_checklist_items')).rows[0];
  await runMigrations({ verbose: false });
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const [key] of PEOPLE) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.td@test.local`, password: 'Password123!' } })).token;

  // a project of Programmes, a parent task in it with a subtask, both seen by Vera
  ids.p1 = ok(await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample Seed Grant 2027', department_id: ids.WS, lead_user_id: ids.mona, status: 'ACTIVE' } }), 201).project.id;
  ids.p2 = ok(await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample Partner Day', department_id: ids.WS, lead_user_id: ids.mona, status: 'ACTIVE' } }), 201).project.id;
  const task = async (token, body) => ok(await call('POST', '/tasks', { token, body: { due_date: day(5), department_id: ids.WS, status_id: ids.st_todo, ...body } }), 201).task;
  const parent = await task(tokens.mona, { title: 'Sample pilot agreements', assignee_id: ids.vera, project_id: ids.p1 });
  const sub = await task(tokens.mona, { title: 'Sample budget annex', assignee_id: ids.vera, parent_task_id: parent.id });
  const plain = await task(tokens.mona, { title: 'Sample partner letters', assignee_id: ids.vera });
  Object.assign(ids, { parent: parent.id, sub: sub.id, plain: plain.id });
  Object.assign(refs, { parent: parent.ref, sub: sub.ref, plain: plain.ref });
  // a goal the parent task supports
  ids.obj = (await query(`INSERT INTO objectives (title, scope_type, department_id, owner_user_id, start_date, end_date, status)
    VALUES ('Sample: grow the pilot network', 'DEPARTMENT', $1, $2, current_date - 10, current_date + 80, 'ACTIVE') RETURNING id`, [ids.WS, ids.mona])).rows[0].id;
  ids.kr = (await query(`INSERT INTO key_results (objective_id, title, owner_user_id, measurement_type, target_value)
    VALUES ($1, 'Sign 3 pilots', $2, 'TASK_ROLLUP', NULL) RETURNING id`, [ids.obj, ids.mona])).rows[0].id;
  await query('INSERT INTO task_key_result_links (task_id, key_result_id, is_primary) VALUES ($1, $2, TRUE)', [ids.parent, ids.kr]);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('the migration gives old steps no invented owner, day or "done at" date', async (t) => {
  if (skip(t)) return;
  const row = (await query('SELECT * FROM task_checklist_items WHERE id = $1', [oldStep.id])).rows[0];
  for (const [key, value] of Object.entries(oldStep)) assert.deepEqual(row[key], value, key);
  for (const key of ['owner_user_id', 'created_by', 'planned_on', 'planned_time', 'done_by', 'done_at']) assert.equal(row[key], null, key);
  const detail = ok(await call('GET', `/tasks/${row.task_id}`, { token: tokens.omar }));
  const shown = detail.checklist.find((c) => c.id === row.id);
  assert.equal(shown.is_done, true);
  assert.equal(shown.done_at, null, 'shown as "done (date not recorded)", never with a date');
});

test('22: a title and Enter make one to-do in Today\'s plan; a 5-line paste makes 5; the same client key twice makes one', async (t) => {
  if (skip(t)) return;
  const made = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample call the venue', planned_on: 'TODAY', client_key: 'k-1' } }), 201);
  assert.equal(made.todo.title, 'Sample call the venue');
  assert.equal(made.todo.link, null);
  const again = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample call the venue', planned_on: 'TODAY', client_key: 'k-1' } }));
  assert.equal(again.duplicate, true);
  assert.equal(again.todo.id, made.todo.id);
  let plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  assert.equal(plan.items.filter((i) => i.title === 'Sample call the venue').length, 1);

  const lines = ['Sample book hall', 'Sample print badges', 'Sample order tea', 'Sample brief volunteers', 'Sample test projector'];
  const pasted = ok(await call('POST', '/todos/batch', { token: tokens.vera, body: { lines, planned_on: 'TODAY', client_key: 'paste-1' } }), 201);
  assert.equal(pasted.created, 5);
  const retry = ok(await call('POST', '/todos/batch', { token: tokens.vera, body: { lines, planned_on: 'TODAY', client_key: 'paste-1' } }), 201);
  assert.equal(retry.created, 0, 'a retried paste makes nothing new');
  plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  const order = plan.items.filter((i) => lines.includes(i.title)).map((i) => i.title);
  assert.deepEqual(order, lines, 'in the order they were pasted');
  // with no day said, a to-do is "Anytime"
  const loose = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample idea for later' } }), 201);
  assert.equal(loose.todo.planned_on, null);
  assert.ok(ok(await call('GET', '/todos/anytime', { token: tokens.vera })).items.some((i) => i.id === loose.todo.id));
});

test('23: a typed reference links privately only when the task is visible; no date is guessed', async (t) => {
  if (skip(t)) return;
  const parsed = ok(await call('GET', `/todos/parse?text=${encodeURIComponent(`${refs.sub} send the budget annex`)}`, { token: tokens.vera }));
  assert.equal(parsed.ref.task.id, ids.sub, 'shown as a chip before saving');
  const linked = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: `${refs.sub} send the budget annex`, planned_on: 'TODAY' } }), 201);
  assert.equal(linked.todo.link.type, 'TASK');
  assert.equal(linked.todo.link.id, ids.sub);
  assert.equal(linked.todo.shared, false, 'private by default');
  ids.subTodo = linked.todo.id;
  // Omar (Operations) cannot see the task: saved unlinked, and told so
  const blind = ok(await call('POST', '/todos', { token: tokens.omar, body: { title: `${refs.sub} send the budget annex` } }), 201);
  assert.equal(blind.todo.link, null);
  assert.equal(blind.ref_note, `No task ${refs.sub} you can see`);
  // the chip can be removed before saving
  const unlinked = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: `${refs.plain} wording only`, read_ref: false } }), 201);
  assert.equal(unlinked.todo.link, null);
  const monday = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Prepare Monday report' } }), 201);
  assert.equal(monday.todo.planned_on, null, 'no natural-language date guessing');
});

test('24: carried over from Fri 15 Jan to Mon 18 Jan, never overdue, and private; asked once after 7 days', async (t) => {
  if (skip(t)) return;
  const vera = await userRow('vera');
  const friday = (await createTodo(vera, { title: 'Sample thank the hosts', planned_on: '2027-01-15' })).todo;
  const old = (await createTodo(vera, { title: 'Sample file the receipts', planned_on: '2027-01-08' })).todo;
  const monday = new Date('2027-01-18T05:00:00Z'); // 10:30 in Kolkata
  const plan = await todayPlan(vera, { now: monday });
  assert.equal(plan.day, '2027-01-18');
  const carried = plan.carried.find((i) => i.id === friday.id);
  assert.equal(carried.carried_from, '2027-01-15');
  assert.ok(!JSON.stringify(plan).toLowerCase().includes('overdue'), 'nothing in the plan is called overdue');
  assert.equal(carried.ask_still_want, false);
  assert.equal(plan.carried.find((i) => i.id === old.id).ask_still_want, true, '10 days carried: asked');
  await updateTodo(vera, old.id, { still_want: true });
  assert.equal((await todayPlan(vera, { now: monday })).carried.find((i) => i.id === old.id).ask_still_want, false, 'asked once only');
  const other = await todayPlan(await userRow('mona'), { now: monday });
  assert.ok(![...other.carried, ...other.items].some((i) => i.id === friday.id), 'nobody else sees it');
  // moving it on records the move, for the past page
  ok(await call('PATCH', `/todos/${friday.id}`, { token: tokens.vera, body: { planned_on: '2027-01-18' } }));
  const moves = (await query('SELECT from_day, to_day FROM todo_moves WHERE todo_id = $1', [friday.id])).rows;
  assert.deepEqual(moves, [{ from_day: '2027-01-15', to_day: '2027-01-18' }]);
  await query('UPDATE todos SET archived_at = now() WHERE id = ANY($1::int[])', [[friday.id, old.id]]);
});

test('25: the person\'s own timezone sets "today"; reordering lasts; the header count equals the open items', async (t) => {
  if (skip(t)) return;
  const instant = new Date('2027-01-18T20:00:00Z'); // 01:30 on the 19th in Kolkata, noon on the 18th in Los Angeles
  const vera = await userRow('vera');
  assert.equal((await todayPlan(vera, { now: instant })).day, '2027-01-19', 'the company\'s timezone');
  assert.equal((await todayPlan({ ...vera, timezone: 'America/Los_Angeles' }, { now: instant })).day, '2027-01-18', 'the person\'s own');

  let plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  const order = keys(plan).filter((k) => k.startsWith('TODO:')).reverse();
  ok(await call('POST', '/todos/order', { token: tokens.vera, body: { keys: order } }));
  plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  assert.deepEqual(plan.items.filter((i) => i.source === 'TODO' && !i.planned_time).map((i) => i.key), order.filter((k) => plan.items.some((i) => i.key === k)));
  // a time sorts timed items first
  const timed = plan.items.find((i) => i.title === 'Sample order tea');
  ok(await call('PATCH', `/todos/${timed.id}`, { token: tokens.vera, body: { planned_time: '15:00' } }));
  plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  assert.equal(plan.items[0].title, 'Sample order tea');
  ok(await call('PATCH', `/todos/${plan.items[1].id}`, { token: tokens.vera, body: { done: true } }));
  plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  const count = ok(await call('GET', '/todos/count', { token: tokens.vera }));
  assert.equal(count.left, [...plan.carried, ...plan.items].filter((i) => !i.done).length);
  assert.equal(count.left, plan.left);
  assert.equal(plan.done_count, 1);
  assert.ok(plan.items.some((i) => i.done), 'a ticked item stays on the page');
});

test('26: a pinned task shows its live status; Complete opens the normal completion; unpinning changes nothing', async (t) => {
  if (skip(t)) return;
  const suggestions = ok(await call('GET', '/todos/plan-suggestions', { token: tokens.vera }));
  assert.ok(Array.isArray(suggestions.tasks));
  const before = (await query('SELECT * FROM tasks WHERE id = $1', [ids.plain])).rows[0];
  const pin = ok(await call('POST', '/todos/pins', { token: tokens.vera, body: { task_id: ids.plain } }), 201).pin;
  let plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  let item = plan.items.find((i) => i.key === `PIN:${pin.id}`);
  assert.equal(item.task.stage, 'todo');
  assert.equal(item.done, false);
  await query('UPDATE tasks SET status_id = $1 WHERE id = $2', [ids.st_in_progress, ids.plain]);
  plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  item = plan.items.find((i) => i.key === `PIN:${pin.id}`);
  assert.equal(item.task.stage, 'in_progress', 'live, not a copy');
  await query('UPDATE tasks SET status_id = $1 WHERE id = $2', [before.status_id, ids.plain]);
  ok(await call('DELETE', `/todos/pins/${pin.id}`, { token: tokens.vera }));
  const after1 = (await query('SELECT * FROM tasks WHERE id = $1', [ids.plain])).rows[0];
  for (const key of ['status_id', 'due_date', 'assignee_id', 'completed_at']) assert.deepEqual(after1[key], before[key], key);
  assert.equal((await call('DELETE', `/todos/pins/${pin.id}`, { token: tokens.vera })).status, 404);
});

test('27: privacy: another member, the manager, an admin and a super admin get nothing of my private to-dos', async (t) => {
  if (skip(t)) return;
  const mine = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample private thought', planned_on: 'TODAY', note: 'Sample private note' } }), 201).todo;
  const list = ok(await call('POST', '/todos/lists', { token: tokens.vera, body: { name: 'Sample private list' } }), 201).list;
  for (const who of ['wes', 'mona', 'admin', 'eli']) {
    const token = tokens[who];
    for (const view of ['/todos/today', '/todos/upcoming', '/todos/anytime', '/todos/done?q=Sample', '/todos/lists', `/todos/record/TASK/${ids.sub}`]) {
      const body = ok(await call('GET', view, { token }));
      const text = JSON.stringify(body);
      assert.ok(!text.includes('Sample private thought') && !text.includes('Sample private list') && !text.includes(refs.sub + ' send'), `${who} ${view}`);
    }
    assert.equal((await call('PATCH', `/todos/${mine.id}`, { token, body: { done: true } })).status, 404, who);
    assert.equal((await call('DELETE', `/todos/${mine.id}`, { token })).status, 404, who);
    assert.equal((await call('GET', `/todos/${mine.id}/share-preview`, { token })).status, 404, who);
    assert.equal((await call('POST', `/todos/${mine.id}/share`, { token })).status, 404, who);
    assert.equal((await call('GET', `/todos/lists/${list.id}`, { token })).status, 404, who);
    assert.equal((await call('POST', `/todos/lists/${list.id}/use-again`, { token })).status, 404, who);
    assert.equal(ok(await call('GET', '/todos/count', { token })).left >= 0, true);
  }
  // my own private to-do on a record shows on that record's page, for me only
  const onTask = ok(await call('GET', `/todos/record/TASK/${ids.sub}`, { token: tokens.vera }));
  assert.equal(onTask.mine_count, 1, '"My private to-dos (1)"');
  assert.equal((await query('SELECT done_at FROM todos WHERE id = $1', [mine.id])).rows[0].done_at, null, 'their attempts changed nothing');
});

test('28: sharing says who will see it first; on a task it becomes a step (2/4 -> 2/5); on a project it shows in Steps, progress unchanged', async (t) => {
  if (skip(t)) return;
  // the plain task has 4 steps, 2 ticked
  for (const [title, done] of [['Sample a', true], ['Sample b', true], ['Sample c', false], ['Sample d', false]]) {
    const { item } = ok(await call('POST', `/tasks/${ids.plain}/checklist`, { token: tokens.vera, body: { title } }), 201);
    if (done) ok(await call('PATCH', `/tasks/${ids.plain}/checklist/${item.id}`, { token: tokens.vera, body: { is_done: true } }));
  }
  const counts = async () => {
    const board = ok(await call('GET', '/tasks', { token: tokens.vera }));
    const card = board.tasks.find((x) => x.id === ids.plain);
    return `${card.checklist_done}/${card.checklist_total}`;
  };
  assert.equal(await counts(), '2/4');
  const todo = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample send the signed letters', link_type: 'TASK', link_id: ids.plain, planned_on: 'TODAY' } }), 201).todo;
  assert.equal(todo.shared, false);
  assert.equal(await counts(), '2/4', 'a private link changes nothing on the task');
  const preview = ok(await call('GET', `/todos/${todo.id}/share-preview`, { token: tokens.vera }));
  assert.match(preview.words, new RegExp(`People who can see ${refs.plain}`));
  assert.equal(preview.becomes, 'STEP');
  assert.equal(await counts(), '2/4', 'the preview writes nothing');
  const shared = ok(await call('POST', `/todos/${todo.id}/share`, { token: tokens.vera }));
  assert.equal(shared.step.owner_user_id, ids.vera, 'the assignee owns it and keeps it in their plan');
  assert.equal(await counts(), '2/5');
  ids.sharedStep = shared.step.id;
  const plan = ok(await call('GET', '/todos/today', { token: tokens.vera }));
  assert.ok(plan.items.some((i) => i.key === `STEP:${shared.step.id}`), 'the step is in my plan');
  assert.ok(!plan.items.some((i) => i.key === `TODO:${todo.id}`), 'once, not twice');

  // a project: the Steps tab shows it to people who can see the project; progress counts tasks only
  const before = ok(await call('GET', `/projects/${ids.p1}`, { token: tokens.mona })).numbers;
  const pTodo = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample collect the logos', link_type: 'PROJECT', link_id: ids.p1 } }), 201).todo;
  const pPreview = ok(await call('GET', `/todos/${pTodo.id}/share-preview`, { token: tokens.vera }));
  assert.equal(pPreview.words, 'People who can see Project Sample Seed Grant 2027 will see this.');
  assert.equal(ok(await call('GET', `/todos/record/PROJECT/${ids.p1}`, { token: tokens.mona })).steps_total, 0, 'private until shared');
  ok(await call('POST', `/todos/${pTodo.id}/share`, { token: tokens.vera }));
  const steps = ok(await call('GET', `/todos/record/PROJECT/${ids.p1}`, { token: tokens.mona }));
  assert.equal(steps.shared[0].title, 'Sample collect the logos');
  assert.equal(steps.shared[0].owner.name, 'Vera Sample');
  assert.equal(steps.shared[0].note, undefined, 'the note stays private');
  assert.equal(`${steps.steps_done}/${steps.steps_total}`, '0/1');
  assert.equal((await call('GET', `/todos/record/PROJECT/${ids.p1}`, { token: tokens.omar })).status, 404, 'not for people who cannot see the project');
  ok(await call('PATCH', `/todos/${pTodo.id}`, { token: tokens.vera, body: { done: true } }));
  assert.deepEqual(ok(await call('GET', `/projects/${ids.p1}`, { token: tokens.mona })).numbers, before, 'project progress counts tasks only');
  const activity = (await query("SELECT action FROM project_activity WHERE project_id = $1 AND action LIKE 'step_%' ORDER BY id", [ids.p1])).rows.map((r) => r.action);
  assert.deepEqual(activity, ['step_added', 'step_done']);
  // unsharing takes it back to private; the activity keeps "removed a step"
  ok(await call('POST', `/todos/${pTodo.id}/unshare`, { token: tokens.vera }));
  assert.equal(ok(await call('GET', `/todos/record/PROJECT/${ids.p1}`, { token: tokens.mona })).steps_total, 0);
  assert.equal((await query("SELECT count(*)::int AS n FROM project_activity WHERE project_id = $1 AND action = 'step_removed'", [ids.p1])).rows[0].n, 1);
});

test('29, 30: ticking a shared step in my plan ticks the task\'s row; steps never change the task; only the assignee is asked', async (t) => {
  if (skip(t)) return;
  const before = (await query('SELECT status_id, due_date, completed_at FROM tasks WHERE id = $1', [ids.plain])).rows[0];
  const ticked = ok(await call('PATCH', `/todos/steps/${ids.sharedStep}`, { token: tokens.vera, body: { done: true } }));
  assert.equal(ticked.step.is_done, true);
  const detail = ok(await call('GET', `/tasks/${ids.plain}`, { token: tokens.mona }));
  const row = detail.checklist.find((c) => c.id === ids.sharedStep);
  assert.equal(row.is_done, true, 'the same row on the task');
  assert.equal(row.done_by, ids.vera);
  assert.ok(row.done_at);
  assert.equal(row.done_by_name, 'Vera Sample');
  assert.ok(detail.activity.some((a) => a.action === 'step_done' && a.to_value === 'Sample send the signed letters'));
  assert.equal(ticked.ask_complete, null, 'two steps are still open');
  // Wes ticks the remaining steps: the assignee (Vera) is notified, Wes is not asked
  const open = detail.checklist.filter((c) => !c.is_done);
  let last = null;
  for (const c of open) last = ok(await call('PATCH', `/tasks/${ids.plain}/checklist/${c.id}`, { token: tokens.wes, body: { is_done: true } }));
  assert.equal(last.ask_complete, null, 'only the assignee is asked');
  const notes = (await query("SELECT title FROM notifications WHERE user_id = $1 AND title LIKE 'All steps on %'", [ids.vera])).rows;
  assert.equal(notes.length, 1);
  const after1 = (await query('SELECT status_id, due_date, completed_at FROM tasks WHERE id = $1', [ids.plain])).rows[0];
  assert.deepEqual(after1, before, 'status, dates and completion unchanged');
  // Vera reopens one and ticks it again: she is asked, and nothing completes
  const one = open[0];
  ok(await call('PATCH', `/tasks/${ids.plain}/checklist/${one.id}`, { token: tokens.vera, body: { is_done: false } }));
  const asked = ok(await call('PATCH', `/tasks/${ids.plain}/checklist/${one.id}`, { token: tokens.vera, body: { is_done: true } }));
  assert.equal(asked.ask_complete.words, `All steps on ${refs.plain} are done. Complete ${refs.plain}?`);
  assert.deepEqual((await query('SELECT status_id, due_date, completed_at FROM tasks WHERE id = $1', [ids.plain])).rows[0], before);
  assert.equal((await query('SELECT count(*)::int AS n FROM black_marks')).rows[0].n, 0);
  // a step owner must be the assignee or a collaborator
  const bad = await call('POST', `/tasks/${ids.plain}/checklist`, { token: tokens.mona, body: { title: 'Sample x', owner_user_id: ids.omar } });
  assert.equal(bad.status, 400);
});

test('31, 32: the chain in "What I did" (project, parent, key result, objective, department); moving the parent moves it', async (t) => {
  if (skip(t)) return;
  ok(await call('PATCH', `/todos/${ids.subTodo}`, { token: tokens.vera, body: { done: true } }));
  const row = (await query('SELECT * FROM todos WHERE id = $1', [ids.subTodo])).rows[0];
  const done = ok(await call('GET', '/todos/done?what_i_did=1', { token: tokens.vera }));
  const item = done.items.find((i) => i.key === `TODO:${ids.subTodo}`);
  assert.equal(item.chain.project.name, 'Sample Seed Grant 2027');
  assert.deepEqual(item.chain.tasks.map((x) => x.ref), [refs.sub, refs.parent]);
  assert.deepEqual(item.chain.key_results.map((k) => k.title), ['Sign 3 pilots']);
  assert.deepEqual(item.chain.objectives.map((o) => o.title), ['Sample: grow the pilot network']);
  assert.deepEqual(item.chain.departments.map((d) => d.name), ['Programmes']);
  const under = (dim, label) => done.groups[dim].find((g) => g.label === label)?.items.includes(item.key);
  assert.ok(under('project', 'Sample Seed Grant 2027'));
  assert.ok(under('task', `${refs.parent} Sample pilot agreements`));
  assert.ok(under('goal', 'Sign 3 pilots'));
  assert.ok(under('goal', 'Sample: grow the pilot network'));
  assert.ok(under('department', 'Programmes'));
  // for Vera only
  const mona = ok(await call('GET', '/todos/done?what_i_did=1', { token: tokens.mona }));
  assert.ok(!mona.items.some((i) => i.key === item.key));

  // 32: the parent moves to another project; the subtask follows; the to-do follows by itself
  ok(await call('PATCH', `/tasks/${ids.parent}`, { token: tokens.mona, body: { project_id: ids.p2 } }));
  const moved = ok(await call('GET', '/todos/done?what_i_did=1', { token: tokens.vera })).items.find((i) => i.key === item.key);
  assert.equal(moved.project.name, 'Sample Partner Day');
  assert.equal(moved.chain.project.name, 'Sample Partner Day');
  const rowAfter = (await query('SELECT * FROM todos WHERE id = $1', [ids.subTodo])).rows[0];
  assert.deepEqual(rowAfter, row, 'no change to the to-do row');
});

test('33: "Make it a task" from a project to-do: the task is in the project, and the to-do shows "Became"', async (t) => {
  if (skip(t)) return;
  const todo = ok(await call('POST', '/todos', { token: tokens.mona, body: { title: 'Sample invite the minister', link_type: 'PROJECT', link_id: ids.p1, planned_on: 'TOMORROW' } }), 201).todo;
  // the client opens the normal New task dialog pre-filled from the to-do; the normal rules apply
  const created = ok(await call('POST', '/tasks', { token: tokens.mona, body: {
    title: todo.title, due_date: `${todo.planned_on}T12:00:00.000Z`, department_id: ids.WS, status_id: ids.st_todo, assignee_id: ids.vera, project_id: ids.p1,
  } }), 201).task;
  assert.equal(created.project_id, ids.p1);
  const closed = ok(await call('POST', `/todos/${todo.id}/became-task`, { token: tokens.mona, body: { task_id: created.id } }));
  assert.equal(closed.todo.became.ref, created.ref);
  assert.equal(closed.todo.done, true);
  // a task someone else made cannot close my to-do
  const veras = ok(await call('POST', '/tasks', { token: tokens.vera, body: { title: 'Sample by Vera', due_date: day(3), department_id: ids.WS, status_id: ids.st_todo, assignee_id: ids.vera } }), 201).task;
  const other = ok(await call('POST', '/todos', { token: tokens.mona, body: { title: 'Sample other' } }), 201).todo;
  assert.equal((await call('POST', `/todos/${other.id}/became-task`, { token: tokens.mona, body: { task_id: veras.id } })).status, 403);
});

test('lists: linked as a whole, items inherit the link; "Use again" copies every item unticked', async (t) => {
  if (skip(t)) return;
  const list = ok(await call('POST', '/todos/lists', { token: tokens.vera, body: { name: 'Sample trade fair prep', link_type: 'PROJECT', link_id: ids.p1 } }), 201).list;
  ok(await call('POST', '/todos/batch', { token: tokens.vera, body: { lines: ['Sample banner', 'Sample brochures', 'Sample samples'], list_id: list.id } }), 201);
  let detail = ok(await call('GET', `/todos/lists/${list.id}`, { token: tokens.vera }));
  assert.equal(detail.items.length, 3);
  assert.ok(detail.items.every((i) => i.link?.type === 'PROJECT' && i.link_inherited));
  ok(await call('PATCH', `/todos/${detail.items[0].id}`, { token: tokens.vera, body: { done: true } }));
  const copy = ok(await call('POST', `/todos/lists/${list.id}/use-again`, { token: tokens.vera }), 201);
  assert.equal(copy.items.length, 3);
  assert.ok(copy.items.every((i) => !i.done), 'unticked');
  assert.equal(copy.list.copied_from_id, list.id);
  detail = ok(await call('GET', `/todos/lists/${list.id}`, { token: tokens.vera }));
  assert.equal(detail.items.filter((i) => i.done).length, 1, 'the original is unchanged');
  const all = ok(await call('GET', '/todos/lists', { token: tokens.vera }));
  assert.equal(all.lists.find((l) => l.id === list.id).left, 2);
  // list items are not loose "Anytime" lines
  assert.ok(!ok(await call('GET', '/todos/anytime', { token: tokens.vera })).items.some((i) => i.list));
});

test('suggestions: one plain word match, shown on the item, never applied', async (t) => {
  if (skip(t)) return;
  const made = ok(await call('POST', '/todos', { token: tokens.vera, body: { title: 'Draft the pilot agreements cover note', planned_on: 'TODAY', read_ref: false } }), 201).todo;
  assert.equal(made.link, null, 'nothing is linked from a guess');
  assert.equal(made.suggestion?.type, 'TASK');
  assert.equal(made.suggestion.id, ids.parent);
  const done = ok(await call('PATCH', `/todos/${made.id}`, { token: tokens.vera, body: { link: { type: made.suggestion.type, id: made.suggestion.id } } }));
  assert.equal(done.todo.link.id, ids.parent, 'one tap accepts it');
  const search = ok(await call('GET', '/todos/link-search?q=pilot', { token: tokens.vera }));
  assert.ok(search.results.some((r) => r.type === 'TASK' && r.id === ids.parent));
  const omar = ok(await call('GET', '/todos/link-search?q=pilot', { token: tokens.omar }));
  assert.ok(!omar.results.some((r) => r.type === 'TASK'), 'only what the person can already see');
});

test('recurring tasks carry steps forward unticked, with owners and times', async (t) => {
  if (skip(t)) return;
  const rec = ok(await call('POST', '/tasks', { token: tokens.mona, body: { title: 'Sample weekly report', due_date: day(1), department_id: ids.WS, status_id: ids.st_todo, assignee_id: ids.vera, recurrence: 'weekly' } }), 201).task;
  const step = ok(await call('POST', `/tasks/${rec.id}/checklist`, { token: tokens.mona, body: { title: 'Sample collect numbers', owner_user_id: ids.vera, planned_time: '10:00' } }), 201).item;
  ok(await call('PATCH', `/tasks/${rec.id}/checklist/${step.id}`, { token: tokens.vera, body: { is_done: true } }));
  ok(await call('PATCH', `/tasks/${rec.id}`, { token: tokens.vera, body: { status_id: ids.st_done, completion_note: 'Sample: sent the weekly report to the team with the numbers' } }));
  const next = (await query("SELECT id FROM tasks WHERE title = 'Sample weekly report' AND id <> $1", [rec.id])).rows[0];
  assert.ok(next, 'the next occurrence was made');
  const carried = (await query('SELECT * FROM task_checklist_items WHERE task_id = $1', [next.id])).rows;
  assert.equal(carried.length, 1);
  assert.equal(carried[0].is_done, false);
  assert.equal(carried[0].owner_user_id, ids.vera);
  assert.equal(carried[0].planned_time, '10:00');
  assert.equal(carried[0].done_at, null);
});

test('the to-dos switch: off hides the API (404) and keeps the data', async (t) => {
  if (skip(t)) return;
  const before = (await query('SELECT count(*)::int AS n FROM todos')).rows[0].n;
  ok(await call('PUT', '/workspace/settings', { token: tokens.admin, body: { modules: { todos: false } } }));
  assert.equal((await call('GET', '/todos/today', { token: tokens.vera })).status, 404);
  assert.equal((await call('POST', '/todos', { token: tokens.vera, body: { title: 'Sample while off' } })).status, 404);
  ok(await call('PUT', '/workspace/settings', { token: tokens.admin, body: { modules: { todos: true } } }));
  assert.equal((await query('SELECT count(*)::int AS n FROM todos')).rows[0].n, before);
  ok(await call('GET', '/todos/today', { token: tokens.vera }));
});
