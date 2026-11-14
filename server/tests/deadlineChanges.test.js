/**
 * Deadline changes, deferrals, blocks and the overdue review screen.
 *
 *   5   a deadline cannot be moved silently to avoid a black mark: a reason is
 *       always needed; the owner may move it once, before it passes (D1);
 *       anything else waits for an approver, and the deadline stays as it is
 *       until then; the owner never approves their own
 *   +   approvals and declines are recorded with who and why; the history
 *       keeps the original deadline and every change
 *   +   deferral: reason, next action, review date, dependency; the deadline is
 *       kept and paused (never overdue, no reminders); resuming needs a new,
 *       approved deadline
 *   +   blocks (D3): recorded, accepted by an approver, cleared
 *   +   the overdue review screen: owners see theirs, approvers their scope;
 *       preview writes nothing; apply records everything
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { updateSetting, getSettings } from '../src/services/settings.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};
const st = {};

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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();
let refN = 0;

async function mkTask({ title, owner = ids.isha, reporter = ids.lead, inMs = 3 * DAY, stage = 'todo', account = null }) {
  refN += 1;
  const due = new Date(Date.now() + inMs);
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date, original_due_date, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, $8) RETURNING id`,
    [`DC-${refN}`, title, ids.dept, st[stage], owner, reporter, due, account],
  );
  return rows[0].id;
}
const task = async (id) => (await query('SELECT t.*, s.stage FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id WHERE t.id = $1', [id])).rows[0];

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1)`);
  ids.dept = (await query('SELECT id FROM departments')).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('Backlog', 'backlog', 'backlog', '#999', 1, FALSE), ('To Do', 'to-do', 'todo', '#3b82f6', 2, TRUE),
    ('Blocked', 'blocked', 'blocked', '#ef4444', 3, FALSE), ('Done', 'done', 'done', '#22c55e', 4, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) st[r.stage] = r.id;
  const password = await hashPassword('Password123!');
  // Lead reports tasks; Mohan is Isha's reporting manager; Ravi is a colleague
  for (const [key, role] of [['admin', 'admin'], ['isha', 'member'], ['lead', 'member'], ['mohan', 'member'], ['ravi', 'member']]) {
    const email = `${key}.c@test.local`;
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, email, password, role, ids.dept],
    );
    ids[key] = rows[0].id;
    ids[`${key}_email`] = email;
  }
  await query('INSERT INTO employee_work_profiles (user_id, reporting_manager_id) VALUES ($1, $2)', [ids.isha, ids.mohan]);
  await updateSetting('reminders', { ...(await getSettings()).reminders, mode: 'LIVE' }, ids.admin);
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'isha', 'lead', 'mohan', 'ravi']) {
    tokens[key] = ok(await call('POST', '/auth/login', { body: { email: ids[`${key}_email`], password: 'Password123!' } })).token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('5: a reason is needed, and a refused edit changes nothing', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Order seed packets' });
  const before = await task(id);
  const refused = await call('PATCH', `/tasks/${id}`, { token: tokens.isha, body: { title: 'Order seed packets now', department_id: ids.dept, due_date: inDays(6) } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Say why the deadline is moving/);
  const after1 = await task(id);
  assert.equal(after1.title, before.title, 'the whole edit is refused, not half of it');
  assert.equal(new Date(after1.due_date).getTime(), new Date(before.due_date).getTime());
});

test('5 / D1: the owner moves their own deadline once, before it passes; the next move waits for approval', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Prepare the field kit' });
  const due5 = inDays(5);
  const first = ok(await call('PATCH', `/tasks/${id}`, { token: tokens.isha, body: { due_date: due5, deadline_reason: 'The van is booked for Friday' } }));
  assert.equal(first.deadline_request.status, 'APPROVED');
  assert.equal(first.deadline_request.auto_approved, true);
  assert.equal(new Date(first.task.due_date).getTime(), new Date(due5).getTime(), 'applied');
  const due1 = (await task(id)).due_date;

  const due9 = inDays(9);
  const second = ok(await call('PATCH', `/tasks/${id}`, { token: tokens.isha, body: { due_date: due9, deadline_reason: 'Still waiting on the van' } }));
  assert.equal(second.deadline_request.status, 'PENDING');
  assert.match(second.deadline_request.why, /already moved this deadline once/);
  assert.equal(new Date((await task(id)).due_date).getTime(), new Date(due1).getTime(), 'unchanged until approved');
  // the approvers were told
  const told = (await query(`SELECT user_id FROM notifications WHERE task_id = $1 AND type = 'deadline_request'`, [id])).rows.map((r) => r.user_id).sort();
  assert.deepEqual(told, [ids.lead, ids.mohan].sort(), 'the reporter and the reporting manager');

  // the owner cannot approve their own request; a colleague cannot either
  const changeId = second.deadline_request.id;
  assert.equal((await call('POST', `/task-review/changes/${changeId}/approve`, { token: tokens.isha })).status, 403);
  assert.equal((await call('POST', `/task-review/changes/${changeId}/approve`, { token: tokens.ravi })).status, 403);
  ok(await call('POST', `/task-review/changes/${changeId}/approve`, { token: tokens.mohan, body: { note: 'Fine, the van is the bottleneck' } }));
  const now = await task(id);
  assert.equal(new Date(now.due_date).getTime(), new Date(due9).getTime(), 'applied once approved');
  assert.equal(now.due_date_changes, 2);
  assert.ok(now.original_due_date, 'the original deadline is kept');
  const history = ok(await call('GET', `/task-review/task/${id}`, { token: tokens.isha }));
  assert.deepEqual(history.changes.map((c) => [c.status, c.auto_approved, c.decided_by_name]), [['APPROVED', false, 'Mohan Sample'], ['APPROVED', true, null]]);
  const activity = (await query(`SELECT meta FROM task_activity WHERE task_id = $1 AND field = 'due_date' ORDER BY id`, [id])).rows;
  assert.deepEqual(activity.map((a) => a.meta.reason), ['The van is booked for Friday', 'Still waiting on the van']);
});

test('5 / D1: after the deadline has passed, even the owner\'s first move needs approval; a decline needs a reason', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'File the monthly report', inMs: -2 * HOUR });
  const asked = ok(await call('PATCH', `/tasks/${id}`, { token: tokens.isha, body: { due_date: inDays(2), deadline_reason: 'The figures came late' } }));
  assert.equal(asked.deadline_request.status, 'PENDING');
  assert.match(asked.deadline_request.why, /The deadline has passed/);
  assert.equal((await call('POST', `/task-review/changes/${asked.deadline_request.id}/decline`, { token: tokens.lead, body: {} })).status, 400);
  ok(await call('POST', `/task-review/changes/${asked.deadline_request.id}/decline`, { token: tokens.lead, body: { note: 'Send what you have today' } }));
  const n = (await query(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'deadline_decision' AND task_id = $2`, [ids.isha, id])).rows[0];
  assert.match(n.title, /was declined/);
  assert.equal(n.body, 'Send what you have today');
});

test('an approver moves a deadline directly, with a reason, and it is recorded as theirs', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Plan the farmer meeting', inMs: -DAY });
  const moved = ok(await call('PATCH', `/tasks/${id}`, { token: tokens.lead, body: { due_date: inDays(3), deadline_reason: 'The venue moved the date' } }));
  assert.equal(moved.deadline_request.status, 'APPROVED');
  assert.equal(moved.deadline_request.decided_by, ids.lead);
});

test('defer: the deadline is kept and paused, the task waits in Backlog, and resuming needs an approved date', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Redesign the soil kit label' });
  const deferred = ok(await call('POST', `/task-review/task/${id}/defer`, {
    token: tokens.isha,
    body: { reason: 'Waiting for the new brand guide', next_action: 'Ask design for the guide', review_date: inDays(10).slice(0, 10), dependency_text: 'Brand guide' },
  }), 201);
  assert.equal(deferred.status, 'APPROVED', 'the owner\'s one change, before the deadline');
  const d = await task(id);
  assert.equal(d.stage, 'backlog');
  assert.equal(d.deferral_id, deferred.id);
  assert.equal(new Date(d.due_date).getTime(), new Date(deferred.from_due).getTime(), 'the deadline is kept');
  const listed = ok(await call('GET', `/tasks/${id}`, { token: tokens.isha }));
  assert.equal(listed.task.health.code, 'REVIEW_LATER');
  assert.match(listed.task.health.text, /^Deferred · review/);
  const pending = (await query(`SELECT COUNT(*)::int AS n FROM task_reminders WHERE task_id = $1 AND status = 'PENDING'`, [id])).rows[0].n;
  assert.equal(pending, 0, 'no reminders while deferred');

  // resuming: a new deadline, and the owner has used their one move, so it waits for approval
  const resume = ok(await call('POST', `/task-review/task/${id}/resume`, { token: tokens.isha, body: { due: inDays(14), reason: 'The guide arrived' } }));
  assert.equal(resume.status, 'PENDING');
  assert.ok((await task(id)).deferral_id, 'still deferred until approved');
  ok(await call('POST', `/task-review/changes/${resume.id}/approve`, { token: tokens.mohan }));
  const r = await task(id);
  assert.equal(r.deferral_id, null);
  assert.equal(r.stage, 'todo', 'back where it was');
  const ended = (await query('SELECT status, ended_by FROM task_deadline_changes WHERE id = $1', [deferred.id])).rows[0];
  assert.deepEqual(ended, { status: 'ENDED', ended_by: ids.mohan });
});

test('D3: a block is recorded, accepted by an approver, and cleared', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Install the moisture sensors' });
  const block = ok(await call('POST', `/task-review/task/${id}/block`, { token: tokens.isha, body: { reason: 'The sensors are stuck at customs', dependency_text: 'Customs clearance' } }), 201);
  assert.equal(block.status, 'PENDING');
  assert.equal((await task(id)).stage, 'blocked');
  assert.equal((await call('POST', `/task-review/blocks/${block.id}/accept`, { token: tokens.isha })).status, 403, 'not by the owner');
  ok(await call('POST', `/task-review/blocks/${block.id}/accept`, { token: tokens.mohan, body: { note: 'Agreed' } }));
  const cleared = ok(await call('POST', `/task-review/blocks/${block.id}/clear`, { token: tokens.isha, body: { note: 'Cleared customs' } }));
  assert.equal(cleared.status, 'CLEARED');
  const history = ok(await call('GET', `/task-review/task/${id}`, { token: tokens.isha }));
  assert.equal(history.blocks[0].decided_by_name, 'Mohan Sample');
  assert.equal(history.blocks[0].cleared_by_name, 'Isha Sample');
});

test('the overdue review screen: mine and my scope; the preview writes nothing; apply records each change', async (t) => {
  if (skip(t)) return;
  const late1 = await mkTask({ title: 'Late: calibrate the meter', inMs: -3 * DAY });
  const late2 = await mkTask({ title: 'Late: send the photos', inMs: -DAY });
  const late3 = await mkTask({ title: 'Late: update the price sheet', inMs: -5 * HOUR });
  const dealTask = await mkTask({ title: 'Late: deal follow-up', inMs: -DAY, account: null });
  const mine = ok(await call('GET', '/task-review/overdue', { token: tokens.isha }));
  assert.ok([late1, late2, late3].every((x) => mine.tasks.some((t2) => t2.id === x && t2.mine)));
  const manager = ok(await call('GET', '/task-review/overdue', { token: tokens.mohan }));
  assert.ok(manager.tasks.some((t2) => t2.id === late1 && !t2.mine), 'the reporting manager sees the team\'s');
  const colleague = ok(await call('GET', '/task-review/overdue', { token: tokens.ravi }));
  assert.ok(!colleague.tasks.some((t2) => t2.id === late1), 'a colleague does not');

  const items = [
    { task_id: late1, action: 'NEW_DATE', due: inDays(2), reason: 'Waiting for the calibration weights' },
    { task_id: late2, action: 'DONE', evidence: 'Sent to the dealer by email on Monday' },
    { task_id: late3, action: 'DEFER', reason: 'The price list is frozen until April', review_date: inDays(20).slice(0, 10), next_action: 'Check the new list' },
    { task_id: dealTask, action: 'BLOCKED', reason: 'Waiting for the customer' },
  ];
  const snapshot = (await query('SELECT id, due_date, status_id, deferral_id FROM tasks WHERE id = ANY($1::int[]) ORDER BY id', [items.map((i) => i.task_id)])).rows;
  const preview = ok(await call('POST', '/task-review/preview', { token: tokens.isha, body: { items } }));
  assert.equal(preview.ready, true);
  assert.match(preview.items[0].effect, /after approval/, 'past the deadline: needs approval');
  assert.match(preview.items[1].effect, /Moved to Done with your note\. It was finished after its deadline/);
  assert.match(preview.items[2].effect, /^To Backlog, deadline .* paused, review on/);
  assert.deepEqual((await query('SELECT id, due_date, status_id, deferral_id FROM tasks WHERE id = ANY($1::int[]) ORDER BY id', [items.map((i) => i.task_id)])).rows, snapshot, 'the preview wrote nothing');
  assert.equal((await call('POST', '/task-review/preview', { token: tokens.isha, body: { items: [{ task_id: late2, action: 'DONE', evidence: '' }] } })).body.ready, false, 'done needs evidence');

  const applied = ok(await call('POST', '/task-review/apply', { token: tokens.isha, body: { items } }));
  assert.deepEqual(applied.results.map((r) => r.status), ['PENDING', 'APPLIED', 'PENDING', 'PENDING']);
  assert.equal((await task(late2)).stage, 'done');
  assert.match((await task(late2)).completion_note, /Sent to the dealer/);
  const waiting = ok(await call('GET', '/task-review/waiting', { token: tokens.mohan }));
  assert.ok(waiting.changes.some((c) => c.task_id === late1));
  assert.ok(waiting.changes.some((c) => c.task_id === late3 && c.kind === 'DEFER'));
  assert.ok(waiting.blocks.some((b) => b.task_id === dealTask));
});

test('the overdue review filters by project, goal, department, person, tag and age, and lists every choice with its count', async (t) => {
  if (skip(t)) return;
  // a second department, a project (parent task) with two late subtasks, a goal, tags and a supporter
  const { rows: [field] } = await query(`INSERT INTO departments (key, name, color, position) VALUES ('FLD', 'Field', '#2a9d6a', 2) RETURNING id`);
  const project = await mkTask({ title: 'Project: launch the soil kit', inMs: -2 * DAY });
  const sub1 = await mkTask({ title: 'Kit: print the leaflets', inMs: -10 * DAY });
  const sub2 = await mkTask({ title: 'Kit: book the stall', inMs: -HOUR, owner: ids.ravi });
  await query('UPDATE tasks SET parent_task_id = $1 WHERE id = ANY($2::int[])', [project, [sub1, sub2]]);
  const fieldTask = await mkTask({ title: 'Field: visit the trial plots', inMs: -2 * DAY });
  await query(`UPDATE tasks SET department_id = $1, tags = '{monsoon,trial}', priority = 'high', follower_id = $2 WHERE id = $3`, [field.id, ids.lead, fieldTask]);
  await query('INSERT INTO task_collaborators (task_id, user_id) VALUES ($1, $2)', [sub1, ids.ravi]);
  const { rows: [goal] } = await query(
    `INSERT INTO objectives (title, scope_type, owner_user_id, start_date, end_date) VALUES ('Grow kit sales', 'COMPANY', $1, now(), now() + interval '90 days') RETURNING id`,
    [ids.admin],
  );
  const { rows: [kr] } = await query(`INSERT INTO key_results (objective_id, title, owner_user_id) VALUES ($1, 'Sell 500 kits', $2) RETURNING id`, [goal.id, ids.admin]);
  await query('INSERT INTO task_key_result_links (task_id, key_result_id, is_primary) VALUES ($1, $2, TRUE), ($3, $2, TRUE)', [sub1, kr.id, fieldTask]);

  const get = async (qs, token = tokens.admin) => ok(await call('GET', `/task-review/overdue${qs}`, { token }));
  const ids_ = (r) => r.tasks.map((x) => x.id).sort((a, b) => a - b);
  const all = await get('');
  assert.equal(all.matching, all.total, 'no filter: everything in scope');

  // every choice is listed with its count, over the unfiltered list
  const option = (key, label) => all.facets[key].find((o) => o.label === label);
  assert.equal(option('department_id', 'Field').count, 1);
  assert.equal(option('project_id', `DC-${refN - 3} Project: launch the soil kit`).count, 3, 'the project and its two subtasks');
  assert.equal(option('goal_id', 'Grow kit sales').count, 2);
  assert.equal(option('tag', 'monsoon').count, 1);
  assert.ok(option('supporter_id', 'Lead Sample') && option('supporter_id', 'Ravi Sample'), 'followed and tagged both count as supporting');
  assert.deepEqual(all.facets.priority.map((o) => o.value).filter((v) => ['high', 'medium'].includes(v)), ['high', 'medium'], 'priorities in their own order');

  // each filter narrows to exactly what it says
  assert.deepEqual(ids_(await get(`?department_id=${field.id}`)), [fieldTask]);
  assert.deepEqual(ids_(await get(`?project_id=${project}`)), [project, sub1, sub2].sort((a, b) => a - b));
  assert.deepEqual(ids_(await get(`?goal_id=${goal.id}`)), [sub1, fieldTask].sort((a, b) => a - b));
  assert.deepEqual(ids_(await get('?tag=trial')), [fieldTask]);
  assert.deepEqual(ids_(await get(`?supporter_id=${ids.ravi}`)), [sub1]);
  assert.ok((await get(`?assignee_id=${ids.ravi}`)).tasks.every((x) => x.assignee_id === ids.ravi));
  assert.ok((await get('?overdue_days=7')).tasks.every((x) => Date.now() - new Date(x.due_date).getTime() >= 7 * DAY));
  assert.ok((await get('?overdue_days=7')).tasks.some((x) => x.id === sub1));
  // several filters together: all must hold; several values of one filter: any of them
  assert.deepEqual(ids_(await get(`?goal_id=${goal.id}&department_id=${ids.dept}`)), [sub1]);
  assert.deepEqual(ids_(await get(`?department_id=${field.id}&project_id=${project}`)), []);
  const either = await get(`?tag=trial&project_id=${project}`);
  assert.equal(either.matching, 0, 'different filters are "and"');
  assert.deepEqual(ids_(await get(`?assignee_id=${ids.ravi},${ids.isha}&project_id=${project}`)), [project, sub1, sub2].sort((a, b) => a - b));
  assert.deepEqual(ids_(await get('?search=trial plots')), [fieldTask]);
  // each filter's counts follow the other filters: within Field, only Field's owner is counted
  const inField = await get(`?department_id=${field.id}`);
  assert.deepEqual(inField.facets.assignee_id.filter((o) => o.count > 0).map((o) => [o.label, o.count]), [['Isha Sample', 1]]);
  assert.ok(inField.facets.department_id.find((o) => o.label === 'Operations').count > 0, 'a filter does not count against its own choices');
  // the Mine / My team switch: Isha's own work, and the counts on each side
  const ishaAll = await get(`?goal_id=${goal.id}`, tokens.isha);
  const ishaMine = await get(`?goal_id=${goal.id}&scope=mine`, tokens.isha);
  assert.equal(ishaMine.matching, ishaAll.mine);
  assert.ok(ishaMine.tasks.every((x) => x.mine));
  assert.equal(ishaMine.facets.goal_id[0].count, ishaMine.matching);
  const sorted = await get('?sort=newest');
  assert.ok(sorted.tasks.every((x, i, a) => i === 0 || new Date(a[i - 1].due_date) >= new Date(x.due_date)));

  // filters never widen what a person may see: a colleague asking for the project sees only their own subtask
  assert.deepEqual(ids_(await get(`?project_id=${project}`, tokens.ravi)), [sub2]);
  // the goal list leaves out archived goals
  await query('UPDATE objectives SET is_archived = TRUE WHERE id = $1', [goal.id]);
  assert.equal((await get('')).facets.goal_id.length, 0);
  assert.equal((await get(`?goal_id=${goal.id}`)).matching, 0);
});
