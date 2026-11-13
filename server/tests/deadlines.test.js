/**
 * One definition of deadline health, counts that agree, and My Tasks.
 *
 *   1   "due today" means one thing everywhere, in the organisation's time
 *       zone: a task due at 10:00 is overdue at 15:00 on the board, in My
 *       Tasks and in Chat; a device in another time zone does not change it
 *   2   counts cover every matching task, not just the rows sent back
 *   3   "due within N days" and "next 7 days" never include overdue work
 *   4   My Tasks shows tagged work too, separates owning from supporting, puts
 *       each task in exactly one group, and each group's count equals the
 *       board's count with that group's filter
 *   20  saving a task without changing its deadline is not a deadline move
 *   21  an overdue task can be saved with its deadline unchanged
 *   +   the dashboard's overdue and due-soon counts equal the board's
 *   +   deferred work is never overdue
 *   +   saved views: personal, or shared with a department by its manager
 *
 * Made-up people, a throwaway schema, no messages sent anywhere.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import {
  DUE_FILTERS, MY_GROUPS, applyDueFilter, clock, groupOf, healthLabel, healthOf, localDate,
} from '../../shared/deadlineHealth.js';

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
let refCounter = 0;

/** A task straight into the database, with a deadline relative to now. */
async function mkTask({ title, owner, inMs = DAY, stage = 'todo', follower = null, tagged = [], review = null, noDue = false, priority = 'medium', dept = ids.dept }) {
  refCounter += 1;
  const due = noDue ? null : new Date(Date.now() + inMs);
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, priority, assignee_id, follower_id, created_by, reporter_id, due_date, original_due_date, review_date, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $9, $10, $11) RETURNING id`,
    [`DL-${refCounter}`, title, dept, st[stage], priority, owner, follower, ids.admin, due, review, stage === 'done' ? new Date() : null],
  );
  for (const u of tagged) await query('INSERT INTO task_collaborators (task_id, user_id) VALUES ($1, $2)', [rows[0].id, u]);
  return rows[0].id;
}

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1), ('FLD', 'Field', '#0a7', 2)`);
  ids.dept = (await query(`SELECT id FROM departments WHERE key = 'OPS'`)).rows[0].id;
  ids.dept2 = (await query(`SELECT id FROM departments WHERE key = 'FLD'`)).rows[0].id;
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
    ('Backlog', 'backlog', 'backlog', '#999', 1, FALSE), ('To Do', 'to-do', 'todo', '#3b82f6', 2, TRUE),
    ('In Progress', 'in-progress', 'in_progress', '#f59e0b', 3, FALSE), ('Blocked', 'blocked', 'blocked', '#ef4444', 4, FALSE),
    ('Done', 'done', 'done', '#22c55e', 5, FALSE)`);
  for (const r of (await query('SELECT id, stage FROM workflow_statuses')).rows) st[r.stage] = r.id;
  const password = await hashPassword('Password123!');
  for (const [key, role, dept] of [['admin', 'admin', ids.dept], ['isha', 'member', ids.dept], ['ravi', 'member', ids.dept], ['meera', 'manager', ids.dept], ['kiran', 'member', ids.dept2]]) {
    const email = `${key}.d@test.local`;
    const { rows } = await query(
      'INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password) VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id',
      [`${key[0].toUpperCase()}${key.slice(1)} Sample`, email, password, role, dept],
    );
    ids[key] = rows[0].id;
    ids[`${key}_email`] = email;
  }
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin', 'isha', 'ravi', 'meera', 'kiran']) {
    tokens[key] = ok(await call('POST', '/auth/login', { body: { email: ids[`${key}_email`], password: 'Password123!' } })).token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- the definition

test('1: a task due at 10:00 is overdue at 15:00, everywhere, in India time', () => {
  // 15:00 IST on a Friday
  const c = clock(new Date('2026-11-13T09:30:00Z'), { timezone: 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5, 6], dueSoonDays: 3 });
  const due10 = { stage: 'todo', due_date: '2026-11-13T04:30:00Z' }; // 10:00 IST
  const h = healthLabel(due10, c);
  assert.equal(h.code, 'OVERDUE');
  assert.match(h.text, /^Overdue · 5 h$/);
  assert.equal(groupOf(due10, c), 'overdue');
  // later the same day: due today, with its time
  const due18 = { stage: 'todo', due_date: '2026-11-13T12:30:00Z' }; // 18:00 IST
  assert.equal(healthLabel(due18, c).code, 'DUE_TODAY');
  assert.equal(healthLabel(due18, c).text, 'Due today 18:00');
});

test('1: the organisation\'s time zone decides, not the device\'s: 23:59 and 00:00 India time', () => {
  // 23:30 IST on the 13th, which is still the afternoon of the 13th in UTC
  const c = clock(new Date('2026-11-13T18:00:00Z'), { timezone: 'Asia/Kolkata' });
  assert.equal(c.today, '2026-11-13');
  const at2359 = { stage: 'todo', due_date: '2026-11-13T18:29:00Z' }; // 23:59 IST on the 13th
  const at0000 = { stage: 'todo', due_date: '2026-11-13T18:30:00Z' }; // 00:00 IST on the 14th
  assert.equal(healthOf(at2359, c).code, 'DUE_TODAY');
  assert.equal(healthOf(at0000, c).code, 'DUE_SOON');
  assert.equal(healthLabel(at0000, c).text, 'Due tomorrow 00:00');
  // a device on UTC would have called both "today" (both fall on the 13th there)
  assert.equal(new Date(at0000.due_date).toISOString().slice(0, 10), '2026-11-13');
  assert.equal(localDate(new Date(at0000.due_date), 'Asia/Kolkata'), '2026-11-14');
  // a device in New York is a day behind at that instant: the answer does not move
  const ny = clock(new Date('2026-11-13T18:00:00Z'), { timezone: 'Asia/Kolkata' });
  assert.equal(healthOf(at0000, ny).code, 'DUE_SOON');
});

test('3: "next 7 days" never includes overdue work; due soon counts working days', () => {
  const c = clock(new Date('2026-11-13T09:30:00Z'), { timezone: 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5, 6], dueSoonDays: 3 });
  const late = { stage: 'todo', due_date: '2026-11-12T09:30:00Z' };
  const monday = { stage: 'todo', due_date: '2026-11-16T09:30:00Z' }; // Sat 14, Mon 16, Tue 17: within 3 working days
  const wednesday = { stage: 'todo', due_date: '2026-11-18T09:30:00Z' };
  assert.equal(DUE_FILTERS.next7(late, healthOf(late, c), c), false);
  assert.equal(DUE_FILTERS.overdue(late, healthOf(late, c), c), true);
  assert.equal(healthOf(monday, c).code, 'DUE_SOON');
  assert.equal(healthOf(wednesday, c).code, 'UPCOMING');
  assert.equal(DUE_FILTERS.next7(wednesday, healthOf(wednesday, c), c), true);
});

test('deferred work is never overdue; its review date counts', () => {
  const c = clock(new Date('2026-11-13T09:30:00Z'));
  const deferredLate = { stage: 'backlog', due_date: '2026-11-01T09:30:00Z', deferral_id: 4, review_date: '2026-11-20' };
  assert.equal(healthOf(deferredLate, c).code, 'REVIEW_LATER');
  assert.match(healthLabel(deferredLate, c).text, /^Deferred · review 20 Nov$/);
  assert.equal(healthOf({ ...deferredLate, review_date: '2026-11-13' }, c).code, 'REVIEW_DUE');
  assert.equal(healthOf({ stage: 'backlog', due_date: null, review_date: null }, c).code, 'NO_DEADLINE');
  assert.equal(healthOf({ stage: 'done', due_date: '2026-11-01T09:30:00Z' }, c).code, 'DONE');
});

test('every open task falls in exactly one My Tasks group', () => {
  const c = clock(new Date('2026-11-13T09:30:00Z'));
  const tasks = [
    { stage: 'todo', due_date: '2026-11-12T00:00:00Z' },
    { stage: 'blocked', due_date: '2026-11-12T00:00:00Z' },
    { stage: 'todo', due_date: '2026-11-13T12:00:00Z' },
    { stage: 'todo', due_date: '2026-11-17T12:00:00Z' },
    { stage: 'todo', due_date: '2026-12-30T12:00:00Z' },
    { stage: 'backlog', due_date: null, review_date: null },
    { stage: 'backlog', due_date: '2026-11-01T00:00:00Z', deferral_id: 1, review_date: '2026-11-10' },
    { stage: 'backlog', due_date: '2026-11-01T00:00:00Z', deferral_id: 1, review_date: '2026-11-30' },
  ];
  for (const t of tasks) {
    const hits = MY_GROUPS.filter((g) => {
      const f = { ...g.filter };
      if (f.stage) return t.stage === f.stage;
      return applyDueFilter([t], f, c).length === 1;
    });
    assert.equal(hits.length, 1, JSON.stringify(t));
    assert.equal(hits[0].key, groupOf(t, c));
  }
});

// ---------------------------------------------------------------- the API

test('1: the board, My Tasks and the dashboard call a task overdue at the same moment', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Send the soil report', owner: ids.isha, inMs: -5 * 60_000 });
  const board = ok(await call('GET', '/tasks?due=overdue', { token: tokens.isha }));
  const card = board.tasks.find((x) => x.id === id);
  assert.ok(card, 'on the board under Overdue');
  assert.equal(card.health.code, 'OVERDUE');
  assert.match(card.health.text, /^Overdue · /);
  const mine = ok(await call('GET', '/tasks/mine', { token: tokens.isha }));
  assert.equal(mine.tasks.find((x) => x.id === id).group, 'overdue');
  assert.equal(mine.calendar.timezone, 'Asia/Kolkata');
});

test('2: counts cover every matching task, not just the rows sent', async (t) => {
  if (skip(t)) return;
  for (let i = 0; i < 4; i += 1) await mkTask({ title: `Field visit ${i}`, owner: ids.ravi, inMs: (i + 2) * DAY });
  const page = ok(await call('GET', `/tasks?assignee_id=${ids.ravi}&limit=2`, { token: tokens.admin }));
  assert.equal(page.tasks.length, 2);
  assert.equal(page.total, 4);
  assert.equal(page.truncated, true);
  assert.equal(Object.values(page.counts.by_status).reduce((a, b) => a + b, 0), 4);
});

test('3: "due within 3 days" and "next 7 days" leave out what is already overdue', async (t) => {
  if (skip(t)) return;
  const late = await mkTask({ title: 'Late invoice check', owner: ids.meera, inMs: -2 * DAY });
  const soon = await mkTask({ title: 'Vendor call', owner: ids.meera, inMs: 2 * HOUR });
  const within = ok(await call('GET', `/tasks?assignee_id=${ids.meera}&due_within_days=3`, { token: tokens.admin }));
  assert.deepEqual(within.tasks.map((x) => x.id), [soon]);
  const next7 = ok(await call('GET', `/tasks?assignee_id=${ids.meera}&due=next7`, { token: tokens.admin }));
  assert.ok(!next7.tasks.some((x) => x.id === late));
  assert.ok(next7.tasks.some((x) => x.id === soon));
});

test('4: My Tasks shows tagged work, separates owning from supporting, and its counts equal the board\'s', async (t) => {
  if (skip(t)) return;
  const followed = await mkTask({ title: 'Dealer visit plan', owner: ids.ravi, follower: ids.kiran, inMs: 3 * HOUR });
  const tagged = await mkTask({ title: 'Price list review', owner: ids.ravi, tagged: [ids.kiran], inMs: -3 * HOUR });
  const blocked = await mkTask({ title: 'Lab results', owner: ids.kiran, stage: 'blocked', inMs: -DAY });
  const undated = await mkTask({ title: 'Old backlog idea', owner: ids.kiran, stage: 'backlog', noDue: true });
  const later = await mkTask({ title: 'Annual audit prep', owner: ids.kiran, inMs: 40 * DAY });
  await mkTask({ title: 'Already done', owner: ids.kiran, stage: 'done', inMs: -DAY });

  const mine = ok(await call('GET', '/tasks/mine', { token: tokens.kiran }));
  const rel = Object.fromEntries(mine.tasks.map((x) => [x.id, x.relation]));
  assert.equal(rel[followed], 'SUPPORTING');
  assert.equal(rel[tagged], 'SUPPORTING', 'tagged work is on My Tasks now');
  assert.equal(rel[blocked], 'OWNER');
  assert.equal(mine.tasks.length, 5, 'the finished one is not there; nothing appears twice');
  const group = Object.fromEntries(mine.tasks.map((x) => [x.id, x.group]));
  assert.equal(group[blocked], 'blocked');
  assert.equal(group[undated], 'undated');
  assert.equal(group[later], 'later');
  assert.equal(group[tagged], 'overdue');

  // every group's count equals the board's with that group's filter, for the same person
  for (const relation of ['OWNER', 'SUPPORTING']) {
    for (const g of MY_GROUPS) {
      const q = new URLSearchParams(g.filter);
      q.set(relation === 'OWNER' ? 'assignee_id' : 'supporter_id', String(ids.kiran));
      q.set('exclude_stage', [g.filter.exclude_stage, 'done', 'cancelled'].filter(Boolean).join(','));
      const board = ok(await call('GET', `/tasks?${q}`, { token: tokens.kiran }));
      assert.equal(board.total, mine.counts[relation][g.key] || 0, `${relation} ${g.key}`);
    }
  }
});

test('the dashboard\'s overdue and due-soon counts equal the board\'s', async (t) => {
  if (skip(t)) return;
  const dash = ok(await call('GET', '/reports/dashboard', { token: tokens.admin }));
  const overdue = ok(await call('GET', '/tasks?due=overdue', { token: tokens.admin }));
  const soon = ok(await call('GET', '/tasks?due=soon', { token: tokens.admin }));
  assert.equal(dash.summary.overdue, overdue.total);
  assert.equal(dash.summary.due_soon, soon.total);
  assert.ok(overdue.total >= 3);
});

test('20 and 21: saving without changing the deadline is not a move, even when it has passed', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Collect samples', owner: ids.isha, inMs: -3 * DAY });
  const before = (await query('SELECT due_date, due_date_changes FROM tasks WHERE id = $1', [id])).rows[0];
  // what the task dialog sends: every field, the unchanged deadline included, as text
  const saved = ok(await call('PATCH', `/tasks/${id}`, {
    token: tokens.isha,
    body: { title: 'Collect samples from plot 4', department_id: ids.dept, due_date: new Date(before.due_date).toISOString() },
  }));
  assert.equal(saved.task.title, 'Collect samples from plot 4', 'an overdue task can be saved without pushing its deadline');
  const afterRow = (await query('SELECT due_date, due_date_changes FROM tasks WHERE id = $1', [id])).rows[0];
  assert.equal(afterRow.due_date_changes, before.due_date_changes, 'not counted as a deadline move');
  assert.equal(new Date(afterRow.due_date).getTime(), new Date(before.due_date).getTime());
});

test('saved views: personal for anyone; shared with a department only by its manager', async (t) => {
  if (skip(t)) return;
  const mineView = ok(await call('POST', '/task-views', { token: tokens.isha, body: { name: 'My overdue', query: 'due=overdue&assignee_id=5&evil=1' } }), 201);
  assert.equal(mineView.view.query, 'due=overdue&assignee_id=5', 'only the board\'s own filters are kept');
  const refused = await call('POST', '/task-views', { token: tokens.isha, body: { name: 'Team', query: 'due=today', department_id: ids.dept } });
  assert.equal(refused.status, 403);
  ok(await call('POST', '/task-views', { token: tokens.meera, body: { name: 'Team today', query: 'due=today', department_id: ids.dept } }), 201);
  const seen = ok(await call('GET', '/task-views', { token: tokens.ravi }));
  assert.deepEqual(seen.views.map((v) => v.name), ['Team today'], 'shared views reach the department; personal ones stay personal');
  const other = ok(await call('GET', '/task-views', { token: tokens.kiran }));
  assert.equal(other.views.length, 0, 'another department does not see it');
});

test('20: saving a task with a future deadline unchanged does not count a deadline move', async (t) => {
  if (skip(t)) return;
  const id = await mkTask({ title: 'Draft the newsletter', owner: ids.isha, inMs: 5 * DAY });
  const before = (await query('SELECT due_date, due_date_changes FROM tasks WHERE id = $1', [id])).rows[0];
  for (let i = 0; i < 3; i += 1) {
    ok(await call('PATCH', `/tasks/${id}`, {
      token: tokens.isha,
      body: { title: `Draft the newsletter v${i}`, department_id: ids.dept, due_date: new Date(before.due_date).toISOString() },
    }));
  }
  const afterRow = (await query('SELECT due_date_changes FROM tasks WHERE id = $1', [id])).rows[0];
  assert.equal(afterRow.due_date_changes, before.due_date_changes, 'three saves, no deadline moves');
});
