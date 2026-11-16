/**
 * Projects, Part P2: connected to goals, deals and applications, the CRM's
 * delivery records and meetings. Numbers refer to the build prompt's tests.
 *
 *   13 a project supports key results as context only; linking its tasks is a
 *      separate, previewed action that creates ordinary task links
 *   14 a won deal or a selected application starts a project, linked both ways;
 *      people without CRM access see the project without the deal
 *   15 a linked delivery record: partner milestones shown, never copied; the
 *      one task sync rule; its other tasks are offered, never added
 *   16 a meeting in a project shows there; meeting visibility is unchanged
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

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('PRG', 'Programmes', '#2a78d6', 1), ('OPS', 'Operations', '#0a7', 2)`);
  for (const r of (await query('SELECT id, key FROM departments')).rows) ids[r.key] = r.id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) ids[`st_${r.stage}`] = r.id;
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of [['admin', 'admin', 'OPS'], ['mona', 'manager', 'PRG'], ['vera', 'member', 'PRG'], ['nocrm', 'member', 'PRG'], ['omar', 'member', 'OPS']]) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.pl@test.local`, password, role, ids[dept]],
    );
    ids[key] = rows[0].id;
    await query('INSERT INTO employee_work_profiles (user_id, attendance_required) VALUES ($1, FALSE)', [rows[0].id]);
  }
  await query(`UPDATE users SET revoked_permissions = ARRAY['crm.view'] WHERE id = $1`, [ids.nocrm]);

  // goals: a department objective with a task roll-up key result and a measured one
  ids.obj = (await query(`INSERT INTO objectives (title, scope_type, department_id, owner_user_id, start_date, end_date, status)
    VALUES ('Sample: win three programme grants', 'DEPARTMENT', $1, $2, current_date - 10, current_date + 80, 'ACTIVE') RETURNING id`, [ids.PRG, ids.mona])).rows[0].id;
  ids.krRollup = (await query(`INSERT INTO key_results (objective_id, title, owner_user_id, measurement_type, target_value)
    VALUES ($1, 'Sample: application work finished', $2, 'TASK_ROLLUP', NULL) RETURNING id`, [ids.obj, ids.mona])).rows[0].id;
  ids.krNumber = (await query(`INSERT INTO key_results (objective_id, title, owner_user_id, measurement_type, baseline_value, target_value, current_value)
    VALUES ($1, 'Sample: grants won', $2, 'NUMBER', 0, 3, 1) RETURNING id`, [ids.obj, ids.mona])).rows[0].id;

  // the CRM: a won deal, a lost one, and a selected application
  ids.acc = (await query(`INSERT INTO accounts (name, owner_user_id) VALUES ('Sample Organic Cooperative', $1) RETURNING id`, [ids.vera])).rows[0].id;
  const b2b = (await query(`SELECT id FROM crm_pipelines WHERE key = 'b2b'`)).rows[0].id;
  const won = (await query(`SELECT id FROM account_stages WHERE pipeline_id = $1 AND kind = 'won' LIMIT 1`, [b2b])).rows[0].id;
  const lost = (await query(`SELECT id FROM account_stages WHERE pipeline_id = $1 AND kind = 'lost' LIMIT 1`, [b2b])).rows[0].id;
  ids.wonDeal = (await query(`INSERT INTO opportunities (account_id, name, owner_user_id, stage_id, pipeline_id, status) VALUES ($1, 'Sample soil kits pilot', $2, $3, $4, 'WON') RETURNING id`, [ids.acc, ids.vera, won, b2b])).rows[0].id;
  ids.lostDeal = (await query(`INSERT INTO opportunities (account_id, name, owner_user_id, stage_id, pipeline_id, status) VALUES ($1, 'Sample lost renewal', $2, $3, $4, 'LOST') RETURNING id`, [ids.acc, ids.vera, lost, b2b])).rows[0].id;
  const apps = (await query(`SELECT id FROM crm_pipelines WHERE key = 'applications'`)).rows[0];
  if (apps) {
    const selected = (await query(`SELECT id FROM account_stages WHERE slug = 'app-selected'`)).rows[0].id;
    ids.selectedApp = (await query(`INSERT INTO opportunities (account_id, name, owner_user_id, stage_id, pipeline_id, status) VALUES ($1, 'Sample Climate Seed Grant', $2, $3, $4, 'WON') RETURNING id`, [ids.acc, ids.vera, selected, apps.id])).rows[0].id;
  }
  // its delivery record, with two partner milestones
  ids.eng = (await query(`INSERT INTO engagements (account_id, opportunity_id, name, owner_user_id) VALUES ($1, $2, 'Sample soil kits delivery', $3) RETURNING id`, [ids.acc, ids.wonDeal, ids.vera])).rows[0].id;
  await query(`INSERT INTO engagement_milestones (engagement_id, title, due_date, position) VALUES ($1, 'Sample kits delivered', current_date + 20, 1), ($1, 'Sample results shared', current_date + 40, 2)`, [ids.eng]);

  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'mona', 'vera', 'nocrm', 'omar']) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.pl@test.local`, password: 'Password123!' } })).token;
  ids.project = ok(await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample grants season', department_id: ids.PRG, lead_user_id: ids.vera, status: 'ACTIVE' } }), 201).project.id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

const task = async (token, body) => ok(await call('POST', '/tasks', { token, body: { due_date: day(5), department_id: ids.PRG, ...body } }), 201).task;

test('13: a project supports key results as context; linking its tasks is previewed and creates ordinary links', async (t) => {
  if (skip(t)) return;
  const done = await task(tokens.vera, { title: 'Sample budget annex', assignee_id: ids.vera, project_id: ids.project });
  await query('UPDATE tasks SET status_id = $1 WHERE id = $2', [ids.st_done, done.id]);
  const open = await task(tokens.vera, { title: 'Sample letters of support', assignee_id: ids.vera, project_id: ids.project });
  const krBefore = (await query('SELECT current_value, status, manual_health FROM key_results WHERE id = ANY($1::int[]) ORDER BY id', [[ids.krRollup, ids.krNumber]])).rows;
  const rollupBefore = ok(await call('GET', `/key-results/${ids.krRollup}`, { token: tokens.mona })).key_result;

  // the lead links the project to both key results
  ok(await call('POST', `/projects/${ids.project}/key-results`, { token: tokens.vera, body: { key_result_id: ids.krRollup } }), 201);
  const page = ok(await call('POST', `/projects/${ids.project}/key-results`, { token: tokens.vera, body: { key_result_id: ids.krNumber } }), 201);
  assert.deepEqual(page.links.key_results.map((k) => k.id).sort(), [ids.krRollup, ids.krNumber].sort());
  // the key result lists its supporting project, and none of its numbers moved
  const kr = ok(await call('GET', `/key-results/${ids.krRollup}`, { token: tokens.mona }));
  assert.deepEqual(kr.supporting_projects.map((p) => p.name), ['Sample grants season']);
  assert.deepEqual((await query('SELECT current_value, status, manual_health FROM key_results WHERE id = ANY($1::int[]) ORDER BY id', [[ids.krRollup, ids.krNumber]])).rows, krBefore);
  assert.equal(kr.key_result.linked_task_count ?? 0, rollupBefore.linked_task_count ?? 0, 'no task link was made');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM task_key_result_links')).rows[0].n, 0);

  // the separate action: preview first (writes nothing), then ordinary links
  const preview = ok(await call('GET', `/projects/${ids.project}/key-results/${ids.krRollup}/link-tasks`, { token: tokens.vera }));
  assert.deepEqual(preview.tasks.map((x) => x.id).sort(), [done.id, open.id].sort());
  assert.deepEqual(preview.before, { linked_tasks: 0, done_tasks: 0, progress: null });
  assert.deepEqual(preview.after, { linked_tasks: 2, done_tasks: 1, progress: 50 });
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM task_key_result_links')).rows[0].n, 0, 'the preview writes nothing');
  const measured = ok(await call('GET', `/projects/${ids.project}/key-results/${ids.krNumber}/link-tasks`, { token: tokens.vera }));
  assert.equal(measured.measured_on_its_own, true);
  assert.equal(measured.before.progress, measured.after.progress, 'a measured key result keeps its own number');
  // a viewer-level member without the goal-linking permission is refused
  await query(`UPDATE users SET revoked_permissions = ARRAY['okr.link.task'] WHERE id = $1`, [ids.omar]);
  ok(await call('POST', `/projects/${ids.project}/members`, { token: tokens.vera, body: { user_id: ids.omar } }), 201);
  assert.equal((await call('POST', `/projects/${ids.project}/key-results/${ids.krRollup}/link-tasks`, { token: tokens.omar, body: { task_ids: [open.id] } })).status, 403);
  const linked = ok(await call('POST', `/projects/${ids.project}/key-results/${ids.krRollup}/link-tasks`, { token: tokens.vera, body: { task_ids: [done.id, open.id] } }));
  assert.equal(linked.linked, 2);
  const links = (await query('SELECT task_id, is_primary FROM task_key_result_links WHERE key_result_id = $1 ORDER BY task_id', [ids.krRollup])).rows;
  assert.deepEqual(links.map((l) => l.task_id), [done.id, open.id].sort((a, b) => a - b));
  assert.ok(links.every((l) => l.is_primary === false));
  // a task outside the project cannot ride along
  const outside = await task(tokens.vera, { title: 'Sample stray task', assignee_id: ids.vera });
  assert.equal((await call('POST', `/projects/${ids.project}/key-results/${ids.krNumber}/link-tasks`, { token: tokens.vera, body: { task_ids: [outside.id] } })).status, 400);

  // the task dialog's options carry the key results a project supports
  const options = ok(await call('GET', '/projects/options', { token: tokens.vera }));
  assert.deepEqual(options.projects.find((p) => p.id === ids.project).key_results.map((k) => k.id).sort(), [ids.krRollup, ids.krNumber].sort());
});

test('14: a won deal or a selected application starts a project, linked both ways; without CRM the deal is not shown', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('GET', `/projects/from-deal/${ids.lostDeal}/preview`, { token: tokens.mona })).status, 400);
  const preview = ok(await call('GET', `/projects/from-deal/${ids.wonDeal}/preview`, { token: tokens.mona }));
  assert.equal(preview.project.name, 'Sample soil kits pilot');
  assert.equal(preview.project.lead_user_id, ids.vera, 'the deal owner leads it');
  assert.equal(preview.project.department_id, ids.PRG, 'the owner\'s department');
  const created = ok(await call('POST', '/projects', { token: tokens.mona, body: { ...preview.project, name: 'Sample soil kits delivery' } }), 201);
  assert.equal(created.links.origin.id, ids.wonDeal);
  const forDeal = ok(await call('GET', `/projects/for-deal/${ids.wonDeal}`, { token: tokens.mona }));
  assert.deepEqual(forDeal.projects.map((p) => p.id), [created.project.id]);
  ids.dealProject = created.project.id;
  if (ids.selectedApp) {
    const app = ok(await call('GET', `/projects/from-deal/${ids.selectedApp}/preview`, { token: tokens.mona }));
    assert.equal(app.is_application, true);
  }
  // a lost deal cannot be named on a project
  assert.equal((await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample from lost', department_id: ids.PRG, lead_user_id: ids.mona, opportunity_id: ids.lostDeal } })).status, 400);
  // someone without CRM access sees the project, not the deal
  const seen = ok(await call('GET', `/projects/${created.project.id}`, { token: tokens.nocrm }));
  assert.equal(seen.links.origin, null);
  assert.equal(seen.links.crm, false);
  assert.equal((await call('GET', `/projects/for-deal/${ids.wonDeal}`, { token: tokens.nocrm })).status, 404);
});

test('15: a linked delivery record — partner milestones shown, never copied; the task sync rule; other tasks offered', async (t) => {
  if (skip(t)) return;
  const pid = ids.dealProject;
  const engTask = await task(tokens.vera, { title: 'Sample kickoff call', assignee_id: ids.vera });
  await query('UPDATE tasks SET engagement_id = $1 WHERE id = $2', [ids.eng, engTask.id]);
  const milestonesBefore = (await query('SELECT COUNT(*)::int AS n FROM project_milestones')).rows[0].n;
  const page = ok(await call('PATCH', `/projects/${pid}`, { token: tokens.mona, body: { engagement_id: ids.eng } }));
  assert.equal(page.links.engagement.id, ids.eng);
  assert.deepEqual(page.links.engagement.milestones.map((m) => m.title), ['Sample kits delivered', 'Sample results shared']);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM project_milestones')).rows[0].n, milestonesBefore, 'partner milestones are not copied');
  // the engagement's own task is offered, not added
  assert.deepEqual(page.links.engagement_tasks_outside.map((x) => x.id), [engTask.id]);
  assert.equal((await query('SELECT project_id FROM tasks WHERE id = $1', [engTask.id])).rows[0].project_id, null);
  // the sync rule: a task joining the project takes the engagement when it has none
  const joined = await task(tokens.vera, { title: 'Sample shipping labels', assignee_id: ids.vera, project_id: pid });
  assert.equal((await query('SELECT engagement_id FROM tasks WHERE id = $1', [joined.id])).rows[0].engagement_id, ids.eng);
  // accepting the offer moves it in
  ok(await call('POST', `/projects/${pid}/tasks`, { token: tokens.vera, body: { task_ids: [engTask.id] } }));
  assert.equal(ok(await call('GET', `/projects/${pid}`, { token: tokens.vera })).links.engagement_tasks_outside.length, 0);
  // one delivery record, one project
  assert.equal((await call('PATCH', `/projects/${ids.project}`, { token: tokens.mona, body: { engagement_id: ids.eng } })).status, 409);
  // someone without CRM access does not see the delivery record on the project
  assert.equal(ok(await call('GET', `/projects/${pid}`, { token: tokens.nocrm })).links.engagement, null);
  assert.equal(ok(await call('GET', `/projects/for-engagement/${ids.eng}`, { token: tokens.mona })).project.id, pid);
});

test('16: a meeting in a project shows on it; meeting visibility is unchanged', async (t) => {
  if (skip(t)) return;
  const created = ok(await call('POST', '/workspace/meetings', { token: tokens.vera, body: { title: 'Sample grants planning', status: 'TO_ARRANGE', arrange_by: day(3).slice(0, 10), project_id: ids.project } }), 201);
  assert.equal((await query('SELECT project_id FROM crm_meetings WHERE id = $1', [created.meeting.id])).rows[0].project_id, ids.project);
  assert.ok(ok(await call('GET', `/projects/${ids.project}`, { token: tokens.vera })).links.meetings.some((m) => m.id === created.meeting.id));
  // an internal meeting stays with the people in it, even on a project page others can see
  assert.ok(!ok(await call('GET', `/projects/${ids.project}`, { token: tokens.mona })).links.meetings.some((m) => m.id === created.meeting.id));
  // a project nobody may see cannot be named on a meeting
  const ops = ok(await call('POST', '/projects', { token: tokens.admin, body: { name: 'Sample operations only', department_id: ids.OPS, lead_user_id: ids.admin } }), 201).project.id;
  assert.equal((await call('POST', '/workspace/meetings', { token: tokens.vera, body: { title: 'Sample stray meeting', status: 'TO_ARRANGE', project_id: ops } })).status, 400);
});
