/**
 * My workspace, Part A: personal layouts, templates, the rollout and the
 * widget catalogue. Numbers refer to the build prompt's tests (section 8).
 *
 *   1  one person's changes never touch another's layout
 *   2  a saved layout survives signing out and in, and another browser
 *   3  reset changes only that person's layout
 *   4  hiding Applications changes no application and no reminder setting
 *   5  two tabs saving from the same version: the second gets 409
 *   6  an unknown widget type stays as "no longer available"; a new type
 *      changes no existing layout
 *   7  templates reach people who never customised, and nobody else
 *   8  existing addresses keep working; the overview keeps its scoping
 *   9  no CRM: no CRM widgets, cannot add them, their data is refused
 *   32 nobody can read another person's layout or the templates' settings
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
import { normaliseLayout, taskWidgetFilters, widgetAccess } from '../../shared/workspaceWidgets.js';

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
const login = async (key) => ok(await call('POST', '/auth/login', { body: { email: `${key}.ws@test.local`, password: 'Password123!' } })).token;

before(async () => {
  assert.match(config.db.schema, /test/);
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('PRG', 'Programmes', '#2a78d6', 1), ('OPS', 'Operations', '#0a7', 2)`);
  ids.prg = (await query(`SELECT id FROM departments WHERE key = 'PRG'`)).rows[0].id;
  ids.ops = (await query(`SELECT id FROM departments WHERE key = 'OPS'`)).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`);
  const password = await hashPassword('Password123!');
  const people = [
    ['admin', 'admin', ids.ops], ['asha', 'member', ids.prg], ['bela', 'member', ids.prg],
    ['chen', 'manager', ids.ops], ['dev', 'viewer', ids.ops], ['eli', 'super_admin', null],
  ];
  for (const [key, role, dept] of people) {
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, `${key}.ws@test.local`, password, role, dept],
    );
    ids[key] = rows[0].id;
  }
  // Dev (a viewer) has CRM taken away, to see the CRM widgets refused
  await query(`UPDATE users SET revoked_permissions = ARRAY['crm.view'] WHERE id = $1`, [ids.dev]);
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'asha', 'bela', 'chen', 'dev', 'eli']) tokens[key] = await login(key);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

test('the template that applies: department first, then role, then everyone', async (t) => {
  if (skip(t)) return;
  const asha = ok(await call('GET', '/workspace', { token: tokens.asha }));
  assert.equal(asha.source, 'TEMPLATE');
  assert.equal(asha.template.key, 'everyone', 'no department has a template yet');
  assert.deepEqual(asha.widgets.map((w) => w.type), ['today', 'attention', 'my_tasks', 'deadlines']);
  assert.equal(ok(await call('GET', '/workspace', { token: tokens.chen })).template.key, 'managers', 'by role');
  assert.equal(ok(await call('GET', '/workspace', { token: tokens.eli })).template.key, 'leadership');
  // an administrator gives Programmes the partnerships template: it wins over the role
  const { templates } = ok(await call('GET', '/workspace/templates', { token: tokens.admin }));
  const p = templates.find((x) => x.key === 'partnerships');
  ok(await call('PUT', '/workspace/templates/partnerships', { token: tokens.admin, body: { name: p.name, description: p.description, layout: p.layout, applies_departments: [ids.prg], applies_roles: [] } }));
  const again = ok(await call('GET', '/workspace', { token: tokens.asha }));
  assert.equal(again.template.key, 'partnerships');
  assert.equal(again.template.matched, 'department');
  assert.deepEqual(again.widgets.map((w) => w.type), ['summary', 'attention', 'meetings', 'applications', 'deals', 'my_tasks', 'waiting']);
  assert.equal((await query('SELECT count(*)::int AS n FROM user_dashboards')).rows[0].n, 0, 'nothing is copied until someone saves');
});

test('1, 2: one person reorders and removes; nobody else changes, and it lasts across sign-ins and browsers', async (t) => {
  if (skip(t)) return;
  const a = ok(await call('GET', '/workspace', { token: tokens.asha }));
  const b = ok(await call('GET', '/workspace', { token: tokens.bela }));
  const mine = [...a.widgets].reverse().filter((w) => w.type !== 'waiting').map(({ id, type, typeVersion, width, config: c }) => ({ id, type, typeVersion, width, config: c }));
  const saved = ok(await call('PUT', '/workspace/layout', { token: tokens.asha, body: { version: a.version, widgets: mine } }));
  assert.equal(saved.version, 1);
  const fresh = await login('asha'); // a new sign-in: another browser
  const back = ok(await call('GET', '/workspace', { token: fresh }));
  assert.equal(back.source, 'CUSTOM');
  assert.deepEqual(back.widgets.map((w) => w.type), mine.map((w) => w.type));
  const bAfter = ok(await call('GET', '/workspace', { token: tokens.bela }));
  assert.deepEqual(bAfter.widgets.map((w) => w.type), b.widgets.map((w) => w.type), 'Bela, in the same department, is unchanged');
  assert.equal(bAfter.source, 'TEMPLATE');
});

test('3, 4: reset changes only the layout; hiding Applications touches no application or reminder', async (t) => {
  if (skip(t)) return;
  const acc = (await query(`INSERT INTO accounts (name, owner_user_id) VALUES ('Sample Foundation', $1) RETURNING id`, [ids.asha])).rows[0].id;
  const pipe = (await query(`SELECT id FROM crm_pipelines WHERE key = 'applications'`)).rows[0].id;
  const stage = (await query(`SELECT id FROM account_stages WHERE slug = 'app-preparing'`)).rows[0].id;
  await query(`INSERT INTO opportunities (account_id, name, owner_user_id, stage_id, pipeline_id) VALUES ($1, 'Sample seed grant', $2, $3, $4)`, [acc, ids.asha, stage, pipe]);
  await query(`INSERT INTO reminder_rule_prefs (user_id, rule_key, enabled) VALUES ($1, 'APPLICATION_DEADLINE', TRUE)`, [ids.asha]);
  const snapshot = async () => JSON.stringify([
    (await query('SELECT id, name, stage_id, owner_user_id, updated_at FROM opportunities ORDER BY id')).rows,
    (await query('SELECT * FROM reminder_rule_prefs ORDER BY user_id, rule_key')).rows,
    (await query('SELECT count(*) FROM reminder_occurrences')).rows,
  ]);
  const before1 = await snapshot();
  const cur = ok(await call('GET', '/workspace', { token: tokens.asha }));
  const without = cur.widgets.filter((w) => w.type !== 'applications');
  ok(await call('PUT', '/workspace/layout', { token: tokens.asha, body: { version: cur.version, widgets: without } }));
  assert.equal(await snapshot(), before1, 'hiding a widget changes no record and no reminder');
  const bela = (await query('SELECT * FROM user_dashboards WHERE user_id = $1', [ids.bela])).rows;
  const r = ok(await call('POST', '/workspace/layout/reset', { token: tokens.asha }));
  const after1 = ok(await call('GET', '/workspace', { token: tokens.asha }));
  assert.equal(after1.source, 'TEMPLATE');
  assert.equal(after1.version, r.version);
  assert.equal(await snapshot(), before1, 'reset changes no record and no reminder');
  assert.deepEqual((await query('SELECT * FROM user_dashboards WHERE user_id = $1', [ids.bela])).rows, bela, 'nobody else');
});

test('5: two tabs from the same version — the second is refused with 409, nothing is overwritten', async (t) => {
  if (skip(t)) return;
  const start = ok(await call('GET', '/workspace', { token: tokens.bela }));
  const tabA = start.widgets.slice(0, 2);
  const tabB = start.widgets.slice(1);
  ok(await call('PUT', '/workspace/layout', { token: tokens.bela, body: { version: start.version, widgets: tabA } }));
  const second = await call('PUT', '/workspace/layout', { token: tokens.bela, body: { version: start.version, widgets: tabB } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'Your layout was changed on another device');
  assert.equal(second.body.details.code, 'LAYOUT_CONFLICT');
  const now = ok(await call('GET', '/workspace', { token: tokens.bela }));
  assert.deepEqual(now.widgets.map((w) => w.id), tabA.map((w) => w.id), 'the first save stands');
  // "Keep mine", after confirming: the person's own choice to overwrite
  ok(await call('PUT', '/workspace/layout', { token: tokens.bela, body: { version: start.version, widgets: tabB, force: true } }));
  assert.deepEqual(ok(await call('GET', '/workspace', { token: tokens.bela })).widgets.map((w) => w.id), tabB.map((w) => w.id));
});

test('6: an unknown widget stays as "no longer available"; a new widget type changes no saved layout', async (t) => {
  if (skip(t)) return;
  // a layout saved before a widget was retired (written directly, as an old release would have)
  await query(
    `INSERT INTO user_dashboards (user_id, version, layout) VALUES ($1, 3, $2)
     ON CONFLICT (user_id) DO UPDATE SET layout = EXCLUDED.layout, version = 3`,
    [ids.chen, JSON.stringify({ widgets: [{ id: 'x1', type: 'retired_gadget', width: 'half', config: { a: 1 } }, { id: 'x2', type: 'my_tasks', width: 'full', config: {} }] })],
  );
  const ws = ok(await call('GET', '/workspace', { token: tokens.chen }));
  assert.equal(ws.widgets[0].retired, true);
  assert.equal(ws.widgets[0].why, 'This widget is no longer available');
  assert.equal(ws.widgets[1].available, true);
  // saving keeps it until the person removes it; adding an unknown type is refused
  ok(await call('PUT', '/workspace/layout', { token: tokens.chen, body: { version: 3, widgets: ws.widgets } }));
  const bad = await call('PUT', '/workspace/layout', { token: tokens.chen, body: { version: 4, widgets: [...ws.widgets, { id: 'x3', type: 'made_up', width: 'full' }] } });
  assert.equal(bad.status, 400);
  // the catalogue lists every type; a layout never gains one by itself
  assert.equal(ws.catalogue.length > 15, true);
  const again = ok(await call('GET', '/workspace', { token: tokens.chen }));
  assert.deepEqual(again.widgets.map((w) => w.type), ['retired_gadget', 'my_tasks']);
});

test('7: a template change reaches people who never customised, not those who did; reset brings the new default', async (t) => {
  if (skip(t)) return;
  // Asha reset earlier (follows the template); Bela customised
  const { templates } = ok(await call('GET', '/workspace/templates', { token: tokens.admin }));
  const p = templates.find((x) => x.key === 'partnerships');
  const changed = { ...p.layout, widgets: [p.layout.widgets[1], p.layout.widgets[0]] };
  ok(await call('PUT', '/workspace/templates/partnerships', { token: tokens.admin, body: { name: p.name, layout: changed, applies_departments: [ids.prg] } }));
  assert.deepEqual(ok(await call('GET', '/workspace', { token: tokens.asha })).widgets.map((w) => w.type), ['attention', 'summary']);
  const bela = ok(await call('GET', '/workspace', { token: tokens.bela }));
  assert.equal(bela.source, 'CUSTOM');
  assert.notDeepEqual(bela.widgets.map((w) => w.type), ['attention', 'summary']);
  ok(await call('POST', '/workspace/layout/reset', { token: tokens.bela }));
  assert.deepEqual(ok(await call('GET', '/workspace', { token: tokens.bela })).widgets.map((w) => w.type), ['attention', 'summary']);
  // a template copies presentation only: no record data, no reminders
  const stored = (await query(`SELECT layout FROM dashboard_templates WHERE key = 'partnerships'`)).rows[0].layout;
  assert.deepEqual(Object.keys(stored), ['widgets']);
  for (const w of stored.widgets) assert.deepEqual(Object.keys(w).sort(), ['config', 'id', 'type', 'typeVersion', 'width']);
});

test('the rollout: a pilot department gets My workspace as home; a person\'s own choice wins', async (t) => {
  if (skip(t)) return;
  assert.equal(ok(await call('GET', '/auth/me', { token: tokens.asha })).user.workspace_home, false, 'nobody until a department is picked');
  ok(await call('PUT', '/workspace/settings', { token: tokens.admin, body: { rollout: { mode: 'PILOT', departmentIds: [ids.prg] } } }));
  assert.equal(ok(await call('GET', '/auth/me', { token: tokens.asha })).user.workspace_home, true);
  assert.equal(ok(await call('GET', '/auth/me', { token: tokens.chen })).user.workspace_home, false, 'Operations is not in the pilot');
  ok(await call('PUT', '/workspace/home', { token: tokens.asha, body: { home: 'OVERVIEW' } }));
  assert.equal(ok(await call('GET', '/workspace', { token: tokens.asha })).home.workspace, false);
  ok(await call('PUT', '/workspace/home', { token: tokens.chen, body: { home: 'WORKSPACE' } }));
  assert.equal(ok(await call('GET', '/auth/me', { token: tokens.chen })).user.workspace_home, true);
  // members cannot change the rollout or the templates
  assert.equal((await call('PUT', '/workspace/settings', { token: tokens.asha, body: { rollout: { mode: 'EVERYONE', departmentIds: [] } } })).status, 403);
  assert.equal((await call('GET', '/workspace/templates', { token: tokens.asha })).status, 403);
  assert.equal((await call('PUT', '/workspace/templates/everyone', { token: tokens.asha, body: { name: 'x', layout: { widgets: [{ type: 'today' }] } } })).status, 403);
});

test('8: existing addresses keep working; the overview keeps today\'s scoping; Assigned by me matches the board', async (t) => {
  if (skip(t)) return;
  const st = (await query(`SELECT id FROM workflow_statuses WHERE slug = 'to-do'`)).rows[0].id;
  for (const [ref, owner, by] of [['WS-1', ids.bela, ids.asha], ['WS-2', ids.asha, ids.asha], ['WS-3', ids.bela, ids.chen]]) {
    await query(`INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date) VALUES ($1, $2, $3, $4, $5, $6, $6, now() + interval '2 days')`, [ref, `Sample ${ref}`, ids.prg, st, owner, by]);
  }
  for (const p of ['/tasks', '/tasks/mine', '/task-views', '/reports/dashboard', '/task-review/overdue']) {
    assert.equal((await call('GET', p, { token: tokens.asha })).status, 200, p);
  }
  // the widget's filters are the board's: "Assigned by me" is work Asha handed to someone else
  const f = taskWidgetFilters('my_tasks', { scope: 'assigned_by_me' }, { userId: ids.asha, departmentId: ids.prg, today: '2026-11-14', addDays: () => '' });
  const list = ok(await call('GET', `/tasks?${new URLSearchParams({ ...f, limit: '5' })}`, { token: tokens.asha }));
  assert.deepEqual(list.tasks.map((x) => x.ref), ['WS-1']);
  assert.equal(list.total, 1, 'the count is the list');
  // a member's overview is scoped to them, as today
  const dash = ok(await call('GET', '/reports/dashboard', { token: tokens.asha }));
  assert.ok('summary' in dash && 'workload' in dash);
});

test('9: without CRM, CRM widgets are not offered, cannot be added, and their data is refused; a module switched off hides them', async (t) => {
  if (skip(t)) return;
  const ws = ok(await call('GET', '/workspace', { token: tokens.dev }));
  const crm = ws.catalogue.filter((c) => ['applications', 'deals', 'leads_to_work', 'followups', 'calls_to_describe'].includes(c.type));
  assert.ok(crm.every((c) => !c.available && c.why === 'Not available to you'));
  const add = await call('PUT', '/workspace/layout', { token: tokens.dev, body: { version: ws.version, widgets: [...ws.widgets, { id: 'd1', type: 'deals', width: 'full' }] } });
  assert.equal(add.status, 400);
  assert.equal(add.body.details.code, 'WIDGET_NOT_AVAILABLE');
  assert.equal((await call('GET', '/sales/work-queue', { token: tokens.dev })).status, 403);
  // the CRM module switched off: a CRM widget already in a layout says so, gracefully
  await updateSetting('crm', { ...(await getSettings()).crm, enabled: false }, ids.admin);
  const leader = ok(await call('GET', '/workspace', { token: tokens.eli }));
  const deals = leader.widgets.find((w) => w.type === 'deals');
  assert.equal(deals.available, false);
  assert.equal(deals.why, 'This module is switched off');
  assert.equal((await call('GET', '/sales/work-queue', { token: tokens.eli })).status, 404);
  await updateSetting('crm', { ...(await getSettings()).crm, enabled: true }, ids.admin);
  // a super admin's attendance does not apply: no Today widget for them
  assert.equal(leader.catalogue.find((c) => c.type === 'today').available, false);
});

test('32: no route reads another person\'s layout; a template id never leaks data', async (t) => {
  if (skip(t)) return;
  // the layout routes take no user id: whatever is passed, the caller's own comes back
  const viaQuery = ok(await call('GET', `/workspace?user_id=${ids.bela}`, { token: tokens.chen }));
  const chenOwn = ok(await call('GET', '/workspace', { token: tokens.chen }));
  assert.deepEqual(viaQuery.widgets, chenOwn.widgets);
  assert.equal((await call('GET', `/workspace/templates/for/${ids.bela}`, { token: tokens.chen })).status, 403, 'only settings managers see whose template is whose');
  const forBela = ok(await call('GET', `/workspace/templates/for/${ids.bela}`, { token: tokens.admin }));
  assert.deepEqual(Object.keys(forBela).sort(), ['key', 'matched', 'name'], 'never the person\'s layout');
});

test('the registry cleans what is stored and guards by module, permission and role', () => {
  const l = normaliseLayout({ widgets: [
    { id: 'a', type: 'my_tasks', width: 'weird', config: { rows: 99, scope: 'team', title: ' Mine ', evil: '<x>' } },
    { id: 'a', type: 'my_tasks', width: 'half', config: {} },
  ] });
  assert.deepEqual(l.widgets[0], { id: 'a', type: 'my_tasks', typeVersion: 1, width: 'full', config: { scope: 'team', title: 'Mine' } });
  assert.equal(l.widgets[1].id, 'a-2', 'ids stay unique');
  const who = { can: (p) => p === 'crm.view', modules: { crm: true }, tracksDay: true };
  assert.equal(widgetAccess('deals', who).ok, true);
  assert.equal(widgetAccess('deals', { ...who, modules: { crm: false } }).why, 'This module is switched off');
  assert.equal(widgetAccess('pinned_notes', who).ok, false);
  assert.equal(widgetAccess('today', { ...who, tracksDay: false }).ok, false);
  assert.equal(widgetAccess('nope', who).retired, true);
});
