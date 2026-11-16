/**
 * Projects, Part P1. Numbers refer to the build prompt's tests (section 8).
 *
 *   3  creating and editing projects: managers and above, in their own
 *      department; admins anywhere; a lead edits their own project only
 *   4  who can see a project (department, members, contributors, everyone)
 *   5  members see every task in the project; removing them ends that access
 *   6  a task in a project: reference, department, deadline unchanged
 *   7  subtasks always follow their parent's project
 *   8  milestones belong to one project; moving clears; deleting clears only that
 *   9  a recurring task's next occurrence keeps its project and open milestone
 *   10 progress and health, counted from each viewer's own task list
 *   11 completing a project with open tasks needs a choice for each
 *   12 on hold changes no task
 *   17 departments with projects deactivate; inactive ones get no projects
 *   20 starting from a parent task or a tag: preview first, nothing automatic
 *   21 the migration changes no existing row
 *
 * Made-up people and records only.
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
import { canSeeRecord } from '../src/services/workspace/access.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const users = {};
let before037 = null;
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
const dateIn = (n) => day(n).slice(0, 10);

const PEOPLE = [
  ['admin', 'admin', 'OPS'], ['mona', 'manager', 'PRG'], ['mike', 'manager', 'OPS'], ['vera', 'member', 'PRG'],
  ['omar', 'member', 'OPS'], ['nina', 'viewer', 'SAL'], ['sam', 'member', 'SAL'], ['eli', 'super_admin', null],
];

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  // migrate up to 037 (as the site stands before projects), put data in, then run 038
  await query(`CREATE SCHEMA "${config.db.schema}"`);
  await query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql') && f < '038').sort()) {
    await query('BEGIN');
    await query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await query('COMMIT');
  }
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#0a7', 1), ('PRG', 'Programmes', '#2a78d6', 2), ('SAL', 'Sales', '#a50', 3), ('OLD', 'Old team', '#777', 4)`);
  for (const r of (await query('SELECT id, key FROM departments')).rows) ids[r.key] = r.id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Doing', 'doing', 'in_progress', '#f59e0b', 2, FALSE),
    ('Done', 'done', 'done', '#22c55e', 3, FALSE), ('Cancelled', 'cancelled', 'cancelled', '#94a3b8', 4, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) ids[`st_${r.stage}`] = r.id;
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of PEOPLE) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING *',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.pj@test.local`, password, role, dept ? ids[dept] : null],
    );
    ids[key] = rows[0].id;
    users[key] = rows[0];
    await query('INSERT INTO employee_work_profiles (user_id, attendance_required) VALUES ($1, FALSE)', [rows[0].id]);
  }
  // tasks that exist before projects do
  await query(`INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date, tags)
    VALUES ('OPS-1', 'Sample existing task', $1, $2, $3, $3, $3, now() + interval '3 days', ARRAY['sample-fair'])`, [ids.OPS, ids.st_todo, ids.omar]);
  await query(`INSERT INTO task_checklist_items (task_id, title, position) SELECT id, 'Sample existing step', 1 FROM tasks WHERE ref = 'OPS-1'`);
  before037 = {
    tasks: (await query('SELECT * FROM tasks ORDER BY id')).rows,
    steps: (await query('SELECT * FROM task_checklist_items ORDER BY id')).rows,
    departments: (await query('SELECT * FROM departments ORDER BY id')).rows,
  };
  await runMigrations({ verbose: false });
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const [key] of PEOPLE) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.pj@test.local`, password: 'Password123!' } })).token;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

const newTask = async (token, body) => ok(await call('POST', '/tasks', { token, body: { due_date: day(5), ...body } }), 201).task;

test('21: the migration changes no existing row; existing tasks are in no project', async (t) => {
  if (skip(t)) return;
  const tasks = (await query('SELECT * FROM tasks ORDER BY id')).rows;
  assert.equal(tasks.length, before037.tasks.length);
  for (const [i, row] of tasks.entries()) {
    for (const [key, value] of Object.entries(before037.tasks[i])) assert.deepEqual(row[key], value, `tasks.${key}`);
    assert.equal(row.project_id, null);
    assert.equal(row.milestone_id, null);
  }
  assert.deepEqual((await query('SELECT * FROM task_checklist_items ORDER BY id')).rows, before037.steps);
  assert.deepEqual((await query('SELECT * FROM departments ORDER BY id')).rows, before037.departments);
  // and the board shows the existing task to its owner exactly as before
  const board = ok(await call('GET', '/tasks', { token: tokens.omar }));
  assert.equal(board.tasks.find((x) => x.ref === 'OPS-1').project_id, null);
});

test('3: managers and above create projects in their own department; admins anywhere; a lead edits only their own', async (t) => {
  if (skip(t)) return;
  const body = (dept, lead, name) => ({ name, department_id: ids[dept], lead_user_id: ids[lead], status: 'ACTIVE' });
  assert.equal((await call('POST', '/projects', { token: tokens.vera, body: body('PRG', 'vera', 'Sample by a member') })).status, 403);
  assert.equal((await call('POST', '/projects', { token: tokens.nina, body: body('SAL', 'nina', 'Sample by a viewer') })).status, 403);
  const created = ok(await call('POST', '/projects', { token: tokens.mona, body: { ...body('PRG', 'vera', 'Sample Seed Grant 2027'), target_date: dateIn(40) } }), 201);
  ids.p1 = created.project.id;
  assert.equal(created.project.lead_user_id, ids.vera);
  assert.ok(created.members.some((m) => m.id === ids.vera && m.is_lead), 'the lead is a member');
  assert.equal((await call('POST', '/projects', { token: tokens.mona, body: body('OPS', 'mona', 'Sample in another department') })).status, 403);
  ids.pOps = ok(await call('POST', '/projects', { token: tokens.admin, body: body('OPS', 'mike', 'Sample warehouse move') }), 201).project.id;
  ids.pSuper = ok(await call('POST', '/projects', { token: tokens.eli, body: body('SAL', 'sam', 'Sample sales kit') }), 201).project.id;
  ids.pMona = ok(await call('POST', '/projects', { token: tokens.mona, body: body('PRG', 'mona', 'Sample partner day') }), 201).project.id;

  // Vera, a member, leads p1: she may edit it, and not Mona's project in the same department
  ok(await call('PATCH', `/projects/${ids.p1}`, { token: tokens.vera, body: { done_looks_like: 'The application is submitted and acknowledged' } }));
  assert.equal((await call('PATCH', `/projects/${ids.pMona}`, { token: tokens.vera, body: { name: 'Renamed by Vera' } })).status, 403);
  // Mona edits any project of her department; not Operations'
  ok(await call('PATCH', `/projects/${ids.p1}`, { token: tokens.mona, body: { visibility: 'DEPARTMENT' } }));
  assert.notEqual((await call('PATCH', `/projects/${ids.pOps}`, { token: tokens.mona, body: { name: 'x y z' } })).status, 200);
  // admins and super admins edit anywhere
  ok(await call('PATCH', `/projects/${ids.pOps}`, { token: tokens.admin, body: { target_date: dateIn(60) } }));
  ok(await call('PATCH', `/projects/${ids.pOps}`, { token: tokens.eli, body: { start_date: dateIn(-5) } }));

  // revoking project.create from one manager removes their ability, and nobody else's
  await query(`UPDATE users SET revoked_permissions = ARRAY['project.create'] WHERE id = $1`, [ids.mona]);
  assert.equal((await call('POST', '/projects', { token: tokens.mona, body: body('PRG', 'mona', 'Sample after revoke') })).status, 403);
  ok(await call('POST', '/projects', { token: tokens.mike, body: body('OPS', 'mike', 'Sample still allowed') }), 201);
  await query(`UPDATE users SET revoked_permissions = '{}' WHERE id = $1`, [ids.mona]);
});

test('4: who can see a project — department, members, contributors, everyone; nobody else, anywhere', async (t) => {
  if (skip(t)) return;
  // Sam (Sales) is not in Programmes and not a member: p1 is invisible everywhere
  assert.equal((await call('GET', `/projects/${ids.p1}`, { token: tokens.sam })).status, 404);
  assert.ok(!ok(await call('GET', '/projects', { token: tokens.sam })).projects.some((p) => p.id === ids.p1));
  assert.ok(!ok(await call('GET', '/projects/options', { token: tokens.sam })).projects.some((p) => p.id === ids.p1));
  assert.equal((await call('GET', `/projects/${ids.p1}/activity`, { token: tokens.sam })).status, 404);
  assert.equal(await canSeeRecord(users.sam, 'PROJECT', ids.p1), false);
  // a department member sees it
  assert.ok(ok(await call('GET', '/projects', { token: tokens.vera })).projects.some((p) => p.id === ids.p1));
  assert.equal(await canSeeRecord(users.vera, 'PROJECT', ids.p1), true);
  // "Everyone in the company" opens it to all
  const pub = ok(await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample open day', department_id: ids.PRG, lead_user_id: ids.mona, visibility: 'EVERYONE' } }), 201).project.id;
  ok(await call('GET', `/projects/${pub}`, { token: tokens.sam }));
  assert.ok(ok(await call('GET', '/projects', { token: tokens.nina })).projects.some((p) => p.id === pub));
  // a contributor (a task in it) sees it
  const task = await newTask(tokens.mona, { title: 'Sample task for Sam', department_id: ids.SAL, assignee_id: ids.sam, project_id: ids.p1 });
  ok(await call('GET', `/projects/${ids.p1}`, { token: tokens.sam }));
  await query('UPDATE tasks SET project_id = NULL WHERE id = $1', [task.id]);
  assert.equal((await call('GET', `/projects/${ids.p1}`, { token: tokens.sam })).status, 404);
});

test('5: members see every task in the project, even in another department; removing them ends that access everywhere at once', async (t) => {
  if (skip(t)) return;
  // a Programmes task in p1, owned by Vera: Omar (Operations) cannot see it
  const prgTask = await newTask(tokens.vera, { title: 'Sample budget annex', department_id: ids.PRG, assignee_id: ids.vera, project_id: ids.p1 });
  ids.prgTask = prgTask.id;
  assert.equal((await call('GET', `/tasks/${prgTask.id}`, { token: tokens.omar })).status, 404);
  assert.ok(!ok(await call('GET', `/tasks?project_id=${ids.p1}`, { token: tokens.omar })).tasks.some((x) => x.id === prgTask.id));
  // Vera, as lead, adds Omar
  ok(await call('POST', `/projects/${ids.p1}/members`, { token: tokens.vera, body: { user_id: ids.omar } }), 201);
  ok(await call('GET', `/tasks/${prgTask.id}`, { token: tokens.omar }));
  assert.ok(ok(await call('GET', `/tasks?project_id=${ids.p1}`, { token: tokens.omar })).tasks.some((x) => x.id === prgTask.id));
  assert.equal(await canSeeRecord(users.omar, 'TASK', prgTask.id), true);
  const notice = (await query(`SELECT * FROM notifications WHERE user_id = $1 AND type = 'project' ORDER BY id DESC LIMIT 1`, [ids.omar])).rows[0];
  assert.match(notice.title, /added to the project Sample Seed Grant 2027/);
  assert.equal(notice.entity_type, 'PROJECT');
  // removed: gone from the page, the board and the record check at once; Operations work is still his
  ok(await call('DELETE', `/projects/${ids.p1}/members/${ids.omar}`, { token: tokens.vera }));
  assert.equal((await call('GET', `/tasks/${prgTask.id}`, { token: tokens.omar })).status, 404);
  assert.equal(await canSeeRecord(users.omar, 'TASK', prgTask.id), false);
  assert.ok(ok(await call('GET', '/tasks', { token: tokens.omar })).tasks.some((x) => x.ref === 'OPS-1'));
  // the lead cannot be removed
  assert.equal((await call('DELETE', `/projects/${ids.p1}/members/${ids.vera}`, { token: tokens.mona })).status, 400);
  // giving a project task to someone from another department asks; with yes they become a member
  const handed = ok(await call('PATCH', `/tasks/${prgTask.id}`, { token: tokens.vera, body: { assignee_id: ids.omar, add_assignee_to_project: true } }));
  assert.equal(handed.task.assignee_id, ids.omar);
  assert.ok((await query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [ids.p1, ids.omar])).rows.length);
  ok(await call('PATCH', `/tasks/${prgTask.id}`, { token: tokens.vera, body: { assignee_id: ids.vera } }));
});

test('6: a task joins a project — on the project, the board filter, a saved view; reference, department and deadline unchanged', async (t) => {
  if (skip(t)) return;
  const existing = (await query(`SELECT * FROM tasks WHERE ref = 'OPS-1'`)).rows[0];
  const moved = ok(await call('PATCH', `/tasks/${existing.id}`, { token: tokens.omar, body: { project_id: ids.pOps } }));
  assert.equal(moved.task.project_id, ids.pOps);
  assert.equal(moved.task.project_name, 'Sample warehouse move');
  const after = (await query('SELECT * FROM tasks WHERE id = $1', [existing.id])).rows[0];
  assert.equal(after.ref, existing.ref);
  assert.equal(after.department_id, existing.department_id);
  assert.equal(new Date(after.due_date).getTime(), new Date(existing.due_date).getTime());
  assert.equal(after.due_date_changes, existing.due_date_changes);
  assert.ok(ok(await call('GET', `/tasks?project_id=${ids.pOps}`, { token: tokens.omar })).tasks.some((x) => x.id === existing.id));
  assert.ok(!ok(await call('GET', '/tasks?project_id=none', { token: tokens.omar })).tasks.some((x) => x.id === existing.id));
  const view = ok(await call('POST', '/task-views', { token: tokens.omar, body: { name: 'Sample warehouse view', query: `project_id=${ids.pOps}&stage=todo` } }), 201);
  assert.match(view.view.query, new RegExp(`project_id=${ids.pOps}`));
  const activity = (await query(`SELECT action FROM project_activity WHERE project_id = $1 AND task_id = $2`, [ids.pOps, existing.id])).rows.map((r) => r.action);
  assert.ok(activity.includes('task_added'));
  const history = (await query(`SELECT field FROM task_activity WHERE task_id = $1 AND field = 'project_id'`, [existing.id])).rows;
  assert.equal(history.length, 1);
});

test('7: subtasks always follow their parent\'s project', async (t) => {
  if (skip(t)) return;
  const parent = await newTask(tokens.vera, { title: 'Sample parent', department_id: ids.PRG, assignee_id: ids.vera, project_id: ids.p1 });
  // a subtask with no project given goes into its parent's
  const sub = await newTask(tokens.vera, { title: 'Sample child', department_id: ids.PRG, assignee_id: ids.vera, parent_task_id: parent.id });
  assert.equal(sub.project_id, ids.p1);
  // a different project is refused
  assert.equal((await call('POST', '/tasks', { token: tokens.vera, body: { title: 'Sample stray child', department_id: ids.PRG, assignee_id: ids.vera, parent_task_id: parent.id, project_id: ids.pMona, due_date: day(4) } })).status, 400);
  assert.equal((await call('PATCH', `/tasks/${sub.id}`, { token: tokens.vera, body: { project_id: ids.pMona } })).status, 400);
  // moving the parent moves the child, and says how many
  const grand = await newTask(tokens.vera, { title: 'Sample grandchild', department_id: ids.PRG, assignee_id: ids.vera, parent_task_id: sub.id });
  const res = ok(await call('PATCH', `/tasks/${parent.id}`, { token: tokens.vera, body: { project_id: ids.pMona } }));
  assert.equal(res.project_move.subtasks, 2);
  const rows = (await query('SELECT id, project_id FROM tasks WHERE id = ANY($1::int[])', [[parent.id, sub.id, grand.id]])).rows;
  assert.ok(rows.every((r) => r.project_id === ids.pMona));
  ids.parentTask = parent.id;
});

test('8: a milestone belongs to its project; moving clears it with a notice; deleting clears only that', async (t) => {
  if (skip(t)) return;
  const page = ok(await call('POST', `/projects/${ids.p1}/milestones`, { token: tokens.vera, body: { name: 'Sample draft ready', target_date: dateIn(10) } }), 201);
  const m1 = page.numbers.milestones.find((m) => m.name === 'Sample draft ready');
  ok(await call('POST', `/projects/${ids.pMona}/milestones`, { token: tokens.mona, body: { name: 'Sample venue booked', target_date: dateIn(20) } }), 201);
  const m2 = (await query(`SELECT id FROM project_milestones WHERE name = 'Sample venue booked'`)).rows[0];
  const task = await newTask(tokens.vera, { title: 'Sample milestone task', department_id: ids.PRG, assignee_id: ids.vera, project_id: ids.p1, milestone_id: m1.id });
  assert.equal(task.milestone_id, m1.id);
  assert.equal(task.milestone_name, 'Sample draft ready');
  // another project's milestone is refused
  assert.equal((await call('PATCH', `/tasks/${task.id}`, { token: tokens.vera, body: { milestone_id: m2.id } })).status, 400);
  // moving the task to another project clears its milestone, and says so
  const moved = ok(await call('PATCH', `/tasks/${task.id}`, { token: tokens.vera, body: { project_id: ids.pMona } }));
  assert.equal(moved.task.milestone_id, null);
  assert.equal(moved.project_move.milestone_cleared, true);
  // back, with its milestone; then the milestone is deleted: only the milestone goes
  ok(await call('PATCH', `/tasks/${task.id}`, { token: tokens.vera, body: { project_id: ids.p1, milestone_id: m1.id } }));
  const beforeDelete = (await query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0];
  ok(await call('DELETE', `/projects/${ids.p1}/milestones/${m1.id}`, { token: tokens.vera }));
  const afterDelete = (await query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0];
  assert.equal(afterDelete.milestone_id, null);
  for (const key of ['title', 'project_id', 'assignee_id', 'status_id', 'ref']) assert.deepEqual(afterDelete[key], beforeDelete[key]);
});

test('9: a recurring task\'s next occurrence keeps its project and its open milestone; key result links stay as before', async (t) => {
  if (skip(t)) return;
  ok(await call('POST', `/projects/${ids.pOps}/milestones`, { token: tokens.mike, body: { name: 'Sample racks in', target_date: dateIn(30) } }), 201);
  const ms = (await query(`SELECT id FROM project_milestones WHERE name = 'Sample racks in'`)).rows[0];
  const daily = await newTask(tokens.mike, { title: 'Sample daily stock check', department_id: ids.OPS, assignee_id: ids.omar, project_id: ids.pOps, milestone_id: ms.id, recurrence: 'daily' });
  ok(await call('PATCH', `/tasks/${daily.id}`, { token: tokens.mike, body: { status_id: ids.st_done } }));
  const next = (await query('SELECT * FROM tasks WHERE recurrence_parent_id = $1 OR (recurrence_parent_id IS NULL AND id <> $1 AND title = $2) ORDER BY id DESC LIMIT 1', [daily.id, daily.title])).rows[0];
  assert.ok(next, 'a next occurrence was made');
  assert.equal(next.project_id, ids.pOps);
  assert.equal(next.milestone_id, ms.id);
  assert.notEqual(next.ref, daily.ref);
});

test('10: progress and health come from the tasks each viewer can see, and equal the project\'s task list', async (t) => {
  if (skip(t)) return;
  const pid = ok(await call('POST', '/projects', { token: tokens.mike, body: { name: 'Sample count check', department_id: ids.OPS, lead_user_id: ids.mike, status: 'ACTIVE', target_date: dateIn(30) } }), 201).project.id;
  const mk = (title, extra) => newTask(tokens.mike, { title, department_id: ids.OPS, assignee_id: ids.omar, project_id: pid, ...extra });
  const a = await mk('Sample done one');
  const b = await mk('Sample done two');
  const c = await mk('Sample cancelled');
  await mk('Sample open');
  const late = await mk('Sample late');
  await query(`UPDATE tasks SET status_id = $1 WHERE id = ANY($2::int[])`, [ids.st_done, [a.id, b.id]]);
  await query(`UPDATE tasks SET status_id = $1 WHERE id = $2`, [ids.st_cancelled, c.id]);
  await query(`UPDATE tasks SET due_date = now() - interval '2 days' WHERE id = $1`, [late.id]);
  // a Sales task in the same project: Omar (Operations, not a member) cannot see it
  await newTask(tokens.mike, { title: 'Sample hidden sales task', department_id: ids.SAL, assignee_id: ids.sam, project_id: pid });

  const forMike = ok(await call('GET', `/projects/${pid}`, { token: tokens.mike }));
  const listMike = ok(await call('GET', `/tasks?project_id=${pid}`, { token: tokens.mike })).tasks;
  assert.equal(forMike.numbers.total, listMike.filter((x) => x.stage !== 'cancelled').length);
  assert.equal(forMike.numbers.done, listMike.filter((x) => x.stage === 'done').length);
  assert.deepEqual([forMike.numbers.total, forMike.numbers.done, forMike.numbers.overdue], [5, 2, 1]);
  assert.equal(forMike.numbers.progress, 40);
  assert.equal(forMike.numbers.health_from_tasks.code, 'AT_RISK');
  assert.match(forMike.numbers.health_from_tasks.why, /1 overdue task/);

  const forOmar = ok(await call('GET', `/projects/${pid}`, { token: tokens.omar }));
  const listOmar = ok(await call('GET', `/tasks?project_id=${pid}`, { token: tokens.omar })).tasks;
  assert.equal(forOmar.numbers.total, listOmar.filter((x) => x.stage !== 'cancelled').length);
  assert.equal(forOmar.numbers.total, 4, 'the Sales task he cannot see is not counted for him');

  // the lead's own update sits beside it, labelled, and only the lead posts it
  assert.equal((await call('POST', `/projects/${pid}/updates`, { token: tokens.omar, body: { health: 'ON_TRACK', note: 'Sample note' } })).status, 403);
  const posted = ok(await call('POST', `/projects/${pid}/updates`, { token: tokens.mike, body: { health: 'ON_TRACK', note: 'Racks arrive Friday' } }), 201);
  assert.equal(posted.numbers.lead_update.health, 'ON_TRACK');
  assert.equal(posted.numbers.health_from_tasks.code, 'AT_RISK', 'the two signals stay separate');

  // past its target date: off track
  await query(`UPDATE projects SET target_date = current_date - 1 WHERE id = $1`, [pid]);
  assert.equal(ok(await call('GET', `/projects/${pid}`, { token: tokens.mike })).numbers.health_from_tasks.code, 'OFF_TRACK');
  ids.countProject = pid;
});

test('11: completing a project with open tasks needs a choice for each; nothing is cancelled; a completed project takes no new tasks', async (t) => {
  if (skip(t)) return;
  const pid = ids.countProject;
  const open = (await query(`SELECT t.id FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id WHERE t.project_id = $1 AND s.stage NOT IN ('done', 'cancelled') ORDER BY t.id`, [pid])).rows.map((r) => r.id);
  const refused = await call('PATCH', `/projects/${pid}`, { token: tokens.mike, body: { status: 'COMPLETED' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details?.code || refused.body.code, 'OPEN_TASKS');
  assert.equal((await query('SELECT status FROM projects WHERE id = $1', [pid])).rows[0].status, 'ACTIVE', 'a refusal changes nothing');
  const stagesBefore = (await query('SELECT id, status_id FROM tasks WHERE id = ANY($1::int[]) ORDER BY id', [open])).rows;
  const [keep, move, ...rest] = open;
  const actions = [
    { task_id: keep, action: 'KEEP' },
    { task_id: move, action: 'MOVE', to_project_id: ids.pOps },
    ...rest.map((id) => ({ task_id: id, action: 'REMOVE' })),
  ];
  ok(await call('PATCH', `/projects/${pid}`, { token: tokens.mike, body: { status: 'COMPLETED', open_task_actions: actions } }));
  const after = (await query('SELECT id, status_id, project_id FROM tasks WHERE id = ANY($1::int[]) ORDER BY id', [open])).rows;
  assert.deepEqual(after.map((r) => r.status_id), stagesBefore.map((r) => r.status_id), 'no task changed status');
  assert.equal(after.find((r) => r.id === keep).project_id, pid);
  assert.equal(after.find((r) => r.id === move).project_id, ids.pOps);
  for (const id of rest) assert.equal(after.find((r) => r.id === id).project_id, null);
  assert.ok((await query('SELECT completed_at FROM projects WHERE id = $1', [pid])).rows[0].completed_at);
  // no new tasks into a completed project, by creating or moving
  const create = await call('POST', '/tasks', { token: tokens.mike, body: { title: 'Sample too late', department_id: ids.OPS, assignee_id: ids.mike, project_id: pid, due_date: day(3) } });
  assert.equal(create.status, 409);
  assert.equal((await call('PATCH', `/tasks/${move}`, { token: tokens.mike, body: { project_id: pid } })).status, 409);
});

test('12: on hold changes no task; its open tasks are listed for rescheduling through the normal flow', async (t) => {
  if (skip(t)) return;
  const beforeHold = (await query('SELECT id, due_date, status_id, due_date_changes FROM tasks WHERE project_id = $1 ORDER BY id', [ids.p1])).rows;
  ok(await call('PATCH', `/projects/${ids.p1}`, { token: tokens.vera, body: { status: 'ON_HOLD' } }));
  const afterHold = (await query('SELECT id, due_date, status_id, due_date_changes FROM tasks WHERE project_id = $1 ORDER BY id', [ids.p1])).rows;
  assert.deepEqual(afterHold, beforeHold);
  const open = ok(await call('GET', `/projects/${ids.p1}/open-tasks`, { token: tokens.vera }));
  assert.ok(open.tasks.length > 0 && open.tasks.every((x) => x.health));
  ok(await call('PATCH', `/projects/${ids.p1}`, { token: tokens.vera, body: { status: 'ACTIVE' } }));
});

test('17: a department with projects deactivates instead of being deleted; an inactive one gets no new projects', async (t) => {
  if (skip(t)) return;
  ok(await call('POST', '/projects', { token: tokens.admin, body: { name: 'Sample legacy work', department_id: ids.OLD, lead_user_id: ids.admin } }), 201);
  const res = ok(await call('DELETE', `/departments/${ids.OLD}`, { token: tokens.admin }));
  assert.equal(res.deactivated, true);
  assert.match(res.message, /projects/);
  assert.equal((await query('SELECT is_active FROM departments WHERE id = $1', [ids.OLD])).rows[0].is_active, false);
  assert.equal((await call('POST', '/projects', { token: tokens.admin, body: { name: 'Sample new in old', department_id: ids.OLD, lead_user_id: ids.admin } })).status, 400);
});

test('20: starting from a parent task or a tag previews first, changes nothing until confirmed, keeps references, and can be undone', async (t) => {
  if (skip(t)) return;
  const parent = await newTask(tokens.mike, { title: 'Sample trade fair', department_id: ids.OPS, assignee_id: ids.mike });
  const kid = await newTask(tokens.mike, { title: 'Sample stand booking', department_id: ids.OPS, assignee_id: ids.omar, parent_task_id: parent.id });
  const countBefore = (await query('SELECT COUNT(*)::int AS n FROM projects')).rows[0].n;
  const preview = ok(await call('GET', `/projects/from-task/${parent.id}/preview`, { token: tokens.mike }));
  assert.deepEqual(preview.tasks.map((x) => x.ref), [parent.ref, kid.ref]);
  assert.equal(preview.project.lead_user_id, ids.mike);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM projects')).rows[0].n, countBefore, 'the preview writes nothing');
  assert.equal((await query('SELECT project_id FROM tasks WHERE id = $1', [parent.id])).rows[0].project_id, null);
  // members cannot turn tasks into projects
  assert.equal((await call('POST', `/projects/from-task/${parent.id}`, { token: tokens.omar, body: {} })).status, 403);
  const made = ok(await call('POST', `/projects/from-task/${parent.id}`, { token: tokens.mike, body: {} }), 201);
  const rows = (await query('SELECT ref, project_id FROM tasks WHERE id = ANY($1::int[]) ORDER BY id', [[parent.id, kid.id]])).rows;
  assert.deepEqual(rows.map((r) => r.ref), [parent.ref, kid.ref]);
  assert.ok(rows.every((r) => r.project_id === made.project.id));
  assert.ok((await query(`SELECT 1 FROM project_activity WHERE project_id = $1 AND action = 'created_from_task'`, [made.project.id])).rows.length);
  // undo: take the tasks out again
  ok(await call('POST', `/projects/${made.project.id}/tasks/remove`, { token: tokens.mike, body: { task_ids: [parent.id] } }));
  assert.ok((await query('SELECT project_id FROM tasks WHERE id = ANY($1::int[])', [[parent.id, kid.id]])).rows.every((r) => r.project_id === null));

  // a tag: preview lists, nothing changes; confirm moves only the chosen tasks
  const tagged1 = await newTask(tokens.mike, { title: 'Sample fair banner', department_id: ids.OPS, assignee_id: ids.omar, tags: ['sample-expo'] });
  const tagged2 = await newTask(tokens.mike, { title: 'Sample fair leaflets', department_id: ids.OPS, assignee_id: ids.omar, tags: ['sample-expo'] });
  const tp = ok(await call('GET', '/projects/from-tag/preview?tag=sample-expo', { token: tokens.mike }));
  assert.deepEqual(tp.tasks.map((x) => x.id).sort(), [tagged1.id, tagged2.id].sort());
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM tasks WHERE project_id IS NOT NULL AND id = ANY($1::int[])', [[tagged1.id, tagged2.id]])).rows[0].n, 0);
  const fromTag = ok(await call('POST', '/projects/from-tag', { token: tokens.mike, body: { tag: 'sample-expo', task_ids: [tagged1.id], project: { name: 'Sample expo 2027' } } }), 201);
  assert.equal((await query('SELECT project_id FROM tasks WHERE id = $1', [tagged1.id])).rows[0].project_id, fromTag.project.id);
  assert.equal((await query('SELECT project_id FROM tasks WHERE id = $1', [tagged2.id])).rows[0].project_id, null);
  // a task without the tag cannot ride along
  assert.equal((await call('POST', '/projects/from-tag', { token: tokens.mike, body: { tag: 'sample-expo', task_ids: [parent.id], project_id: fromTag.project.id } })).status, 400);
});

test('the module switch: off hides the projects API, keeps the data, and tasks keep working', async (t) => {
  if (skip(t)) return;
  const { updateSetting } = await import('../src/services/settings.js');
  await updateSetting('projects', { enabled: false }, ids.admin);
  assert.equal((await call('GET', '/projects', { token: tokens.admin })).status, 404);
  assert.equal((await call('GET', `/projects/${ids.p1}`, { token: tokens.vera })).status, 404);
  assert.ok((await query('SELECT COUNT(*)::int AS n FROM projects')).rows[0].n > 0);
  ok(await call('GET', '/tasks', { token: tokens.vera }));
  await updateSetting('projects', { enabled: true }, ids.admin);
  ok(await call('GET', '/projects', { token: tokens.admin }));
});
