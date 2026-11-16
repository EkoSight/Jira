/**
 * Projects, Part P3: in My workspace and across the app. Numbers refer to the
 * build prompt's tests (section 8).
 *
 *   18 My projects groups my open tasks by project, "No project" last; the
 *      lead also sees unowned and late work; every count is the board's
 *   19 the three project reminder rules reach only the lead, follow the
 *      launch policy, can be turned off per person, and are cancelled when the
 *      reason goes away
 *   and: Needs attention for leads and for managers (no active lead); the
 *   templates; the overdue review's Project (real projects) and Parent task
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
import { planSweep, replanRecord } from '../src/services/workspace/reminders.js';
import { attentionFor } from '../src/services/workspace/attention.js';
import '../src/services/projects/workspace.js';

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
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const day = (n) => new Date(Date.now() + n * 86_400_000);
const dateIn = (n) => day(n).toISOString().slice(0, 10);
const occ = async (where, params = []) => (await query(`SELECT * FROM reminder_occurrences WHERE entity_type = 'PROJECT' AND ${where} ORDER BY id`, params)).rows;

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
  for (const [key, role, dept] of [['admin', 'admin', 'OPS'], ['mona', 'manager', 'PRG'], ['vera', 'member', 'PRG'], ['omar', 'member', 'OPS'], ['gone', 'member', 'PRG']]) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING *',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.pw@test.local`, password, role, ids[dept]],
    );
    ids[key] = rows[0].id;
    users[key] = rows[0];
    await query('INSERT INTO employee_work_profiles (user_id, attendance_required) VALUES ($1, FALSE)', [rows[0].id]);
  }
  await updateSetting('workspace', { ...(await getSettings()).workspace, reminderMode: 'LIVE' }, ids.admin);
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'mona', 'vera', 'omar', 'gone']) tokens[key] = ok(await call('POST', '/auth/login', { body: { email: `${key}.pw@test.local`, password: 'Password123!' } })).token;

  // Vera leads a Programmes project; Omar (Operations) is a member
  ids.p1 = ok(await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample grants season', department_id: ids.PRG, lead_user_id: ids.vera, status: 'ACTIVE', target_date: dateIn(30) } }), 201).project.id;
  ok(await call('POST', `/projects/${ids.p1}/members`, { token: tokens.vera, body: { user_id: ids.omar } }), 201);
  const mk = async (title, assignee, extra = {}) => (await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date, project_id, milestone_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9) RETURNING id`,
    [`PW-${Math.floor(Math.random() * 1e6)}`, title, extra.dept || ids.PRG, ids.st_todo, assignee, ids.mona, extra.due || day(4), extra.project ?? null, extra.milestone ?? null],
  )).rows[0].id;
  ids.late = await mk('Sample late annex', ids.vera, { project: ids.p1, due: day(-2) });
  ids.mine2 = await mk('Sample letters', ids.vera, { project: ids.p1 });
  ids.omarTask = await mk('Sample photos', ids.omar, { project: ids.p1, dept: ids.OPS });
  ids.unowned = await mk('Sample nobody yet', null, { project: ids.p1 });
  ids.loose = await mk('Sample expense report', ids.vera);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('18: My projects groups my open tasks by project, "No project" last; the lead sees unowned and late work; counts are the board\'s', async (t) => {
  if (skip(t)) return;
  const w = ok(await call('GET', '/workspace/widgets/projects?rows=10', { token: tokens.vera }));
  assert.deepEqual(w.groups.map((g) => g.project.name), ['Sample grants season']);
  const g = w.groups[0];
  assert.deepEqual(g.tasks.map((x) => x.id).sort(), [ids.late, ids.mine2].sort(), 'only my open tasks in it');
  assert.equal(g.tasks[0].id, ids.late, 'the late one first');
  assert.deepEqual(g.lead_extras, { unassigned: 1, overdue: 1 });
  assert.deepEqual(w.no_project.tasks.map((x) => x.id), [ids.loose]);
  // every count is the board's for the same filters
  for (const [count, link] of [[g.count, g.link], [w.no_project.count, w.no_project.link]]) {
    const board = ok(await call('GET', `/tasks?${link.split('?')[1]}`, { token: tokens.vera }));
    assert.equal(board.total, count, link);
  }
  // Omar, a member who does not lead it: his own task, and no lead extras
  const o = ok(await call('GET', '/workspace/widgets/projects', { token: tokens.omar }));
  assert.deepEqual(o.groups[0].tasks.map((x) => x.id), [ids.omarTask]);
  assert.equal(o.groups[0].lead_extras, null);
  // the department scope is for managers and above
  assert.equal((await call('GET', '/workspace/widgets/projects?scope=department', { token: tokens.vera })).status, 403);
  const dept = ok(await call('GET', '/workspace/widgets/projects?scope=department&rows=10', { token: tokens.mona }));
  assert.equal(dept.groups[0].count, 4, 'every open task in the project');
  // the widget is in the managers' template, and not in everyone's
  const tpl = (await query(`SELECT key, layout FROM dashboard_templates WHERE key IN ('managers', 'leadership', 'partnerships', 'everyone') ORDER BY key`)).rows;
  for (const row of tpl) {
    const has = row.layout.widgets.some((x) => x.type === 'projects');
    assert.equal(has, row.key !== 'everyone', row.key);
  }
  // switched off: the widget is refused, the data kept
  await updateSetting('projects', { enabled: false }, ids.admin);
  assert.notEqual((await call('GET', '/workspace/widgets/projects', { token: tokens.vera })).status, 200);
  await updateSetting('projects', { enabled: true }, ids.admin);
});

test('19: the project reminder rules reach only the lead, follow the launch policy, can be turned off, and end with their reason', async (t) => {
  if (skip(t)) return;
  // a target date already inside its 7-day window when the rules first run, and a milestone further out
  await query('UPDATE projects SET target_date = $2 WHERE id = $1', [ids.p1, dateIn(5)]);
  const ms = ok(await call('POST', `/projects/${ids.p1}/milestones`, { token: tokens.vera, body: { name: 'Sample draft ready', target_date: dateIn(10) } }), 201);
  const milestone = ms.numbers.milestones.find((m) => m.name === 'Sample draft ready');
  await query('UPDATE tasks SET milestone_id = $1 WHERE id = $2', [milestone.id, ids.mine2]);
  const launch = await planSweep();
  assert.ok(['PROJECT_MILESTONE_DUE', 'PROJECT_TARGET_DATE', 'PROJECT_UPDATE_DUE'].every((k) => launch.launched.includes(k)));
  const all = await occ('entity_id = $1', [ids.p1]);
  assert.ok(all.length >= 3);
  assert.ok(all.every((o) => o.recipient_id === ids.vera), 'only the lead');
  // the first target-date reminder (for the old date) was cancelled when the date changed; this is the current one
  assert.equal(all.filter((o) => o.rule_key === 'PROJECT_TARGET_DATE' && o.occurrence_key === `target:${dateIn(30)}`)[0]?.status, 'CANCELLED');
  const target = all.find((o) => o.rule_key === 'PROJECT_TARGET_DATE' && o.occurrence_key === `target:${dateIn(5)}`);
  assert.equal(target.status, 'SKIPPED', 'already due at launch');
  assert.match(target.reason, /Before launch/);
  const msOcc = all.find((o) => o.rule_key === 'PROJECT_MILESTONE_DUE');
  assert.equal(msOcc.status, 'PENDING');
  assert.equal(new Date(msOcc.remind_at).toISOString().slice(0, 10), dateIn(7), '3 calendar days before');
  // the reason goes away: the milestone is reached
  ok(await call('PATCH', `/projects/${ids.p1}/milestones/${milestone.id}`, { token: tokens.vera, body: { reached: true } }));
  assert.equal((await occ('id = $1', [msOcc.id]))[0].status, 'CANCELLED');
  // a new update moves the "time for an update" reminder
  const before = (await occ(`entity_id = $1 AND rule_key = 'PROJECT_UPDATE_DUE' AND status = 'PENDING'`, [ids.p1]))[0];
  await query(`UPDATE project_updates SET created_at = created_at WHERE project_id = $1`, [ids.p1]);
  ok(await call('POST', `/projects/${ids.p1}/updates`, { token: tokens.vera, body: { health: 'ON_TRACK', note: 'Moving well' } }), 201);
  await query(`UPDATE project_updates SET created_at = now() + interval '1 day' WHERE project_id = $1`, [ids.p1]);
  await replanRecord('PROJECT', ids.p1);
  const pending = await occ(`entity_id = $1 AND rule_key = 'PROJECT_UPDATE_DUE' AND status = 'PENDING'`, [ids.p1]);
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].occurrence_key, before.occurrence_key);
  // turned off by the lead: her pending ones of that rule are cancelled
  ok(await call('PUT', '/workspace/reminders/rules/PROJECT_UPDATE_DUE', { token: tokens.vera, body: { enabled: false } }));
  assert.equal((await occ(`entity_id = $1 AND rule_key = 'PROJECT_UPDATE_DUE' AND status = 'PENDING'`, [ids.p1])).length, 0);
  // completing the project ends the rest
  await query(`UPDATE tasks SET project_id = NULL WHERE project_id = $1`, [ids.p1]);
  ok(await call('PATCH', `/projects/${ids.p1}`, { token: tokens.vera, body: { status: 'COMPLETED' } }));
  assert.equal((await occ(`entity_id = $1 AND status = 'PENDING'`, [ids.p1])).length, 0);
  await query(`UPDATE tasks SET project_id = $1 WHERE id = ANY($2::int[])`, [ids.p1, [ids.late, ids.mine2, ids.omarTask, ids.unowned]]);
  await query(`UPDATE projects SET status = 'ACTIVE', completed_at = NULL WHERE id = $1`, [ids.p1]);
});

test('Needs attention: the lead sees a milestone coming up and unowned work; managers see a project with no active lead', async (t) => {
  if (skip(t)) return;
  const soon = (await query(`INSERT INTO project_milestones (project_id, name, target_date, position) VALUES ($1, 'Sample tomorrow milestone', $2, 99) RETURNING id`, [ids.p1, dateIn(1)])).rows[0].id;
  await query('UPDATE tasks SET milestone_id = $1 WHERE id = $2', [soon, ids.mine2]);
  const items = (await attentionFor(users.vera)).items;
  const kinds = items.filter((i) => i.record?.type === 'PROJECT').map((i) => i.kind);
  assert.ok(kinds.includes('PROJECT_MILESTONE'), kinds.join(','));
  assert.ok(kinds.includes('PROJECT_UNASSIGNED'));
  assert.ok(!(await attentionFor(users.omar)).items.some((i) => i.record?.type === 'PROJECT'), 'only the lead');
  // a project whose lead has left: its department's manager is told, a member is not
  const p2 = ok(await call('POST', '/projects', { token: tokens.mona, body: { name: 'Sample orphan', department_id: ids.PRG, lead_user_id: ids.gone, status: 'ACTIVE' } }), 201).project.id;
  await query('UPDATE users SET is_active = FALSE WHERE id = $1', [ids.gone]);
  const forMona = (await attentionFor(users.mona)).items.filter((i) => i.kind === 'PROJECT_NO_LEAD');
  assert.deepEqual(forMona.map((i) => i.record.id), [p2]);
  assert.ok(!(await attentionFor(users.vera)).items.some((i) => i.kind === 'PROJECT_NO_LEAD'));
  assert.ok((await attentionFor((await query('SELECT * FROM users WHERE id = $1', [ids.admin])).rows[0])).items.some((i) => i.kind === 'PROJECT_NO_LEAD'), 'admins too');
});

test('the overdue review: Project means real projects; the parent-task grouping is Parent task', async (t) => {
  if (skip(t)) return;
  const r = ok(await call('GET', '/task-review/overdue', { token: tokens.vera }));
  const project = r.facets.project_id.find((f) => f.value === String(ids.p1));
  assert.equal(project.label, 'Sample grants season');
  assert.ok(Array.isArray(r.facets.parent_id));
  const filtered = ok(await call('GET', `/task-review/overdue?project_id=${ids.p1}`, { token: tokens.vera }));
  assert.deepEqual(filtered.tasks.map((x) => x.id), [ids.late]);
});
