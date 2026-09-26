/**
 * Leave and availability.
 *
 * The things worth guarding: a manager is told before handing work to someone
 * who will be away on the deadline; "away on the 14th" means the 14th in India,
 * not on the server's clock; nobody can mark somebody else away without the
 * standing to; and leave that is booked or cancelled is never silently lost.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import {
  addDays, dateIn, nextWorkingDay, workingDaysBetween,
} from '../src/services/availability.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};
const TZ = 'Asia/Kolkata';
const WORKING = [1, 2, 3, 4, 5, 6];

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const skipIfUnavailable = (t) => {
  if (!available) {
    t.skip('no database');
    return true;
  }
  return false;
};

const today = () => dateIn(TZ);
/** The next Monday strictly after today, as YYYY-MM-DD. */
const nextMonday = () => {
  const d = today();
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return addDays(d, ((8 - dow) % 7) || 7);
};
/** An instant at a given wall-clock time in India on a date. */
const indiaTime = (date, time) => `${date}T${time}:00+05:30`;

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try {
    await query('SELECT 1');
  } catch {
    available = false;
    return;
  }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE),
      ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );
  const { rows: dept } = await query(`SELECT id FROM departments WHERE key = 'OPS'`);
  ids.department = dept[0].id;

  const password = await hashPassword('Password123!');
  for (const [key, name, role] of [
    ['manager', 'Team Manager', 'manager'],
    ['vartika', 'Vartika Gupta', 'member'],
    ['rahul', 'Rahul Mehta', 'member'],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [name, `avail-${key}@test.local`, password, role, ids.department],
    );
    ids[key] = rows[0].id;
  }

  await new Promise((resolve) => {
    server = createApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  for (const key of ['manager', 'vartika', 'rahul']) {
    const login = await call('POST', '/auth/login', {
      body: { email: `avail-${key}@test.local`, password: 'Password123!' },
    });
    tokens[key] = login.body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- calendar maths

test('working days and the day someone is back skip the weekly day off', () => {
  // 2026-10-05 is a Monday; the week runs Monday to Saturday
  assert.equal(workingDaysBetween('2026-10-05', '2026-10-11', WORKING), 6, 'Sunday is not counted');
  assert.equal(nextWorkingDay('2026-10-10', WORKING), '2026-10-12', 'back Monday after a Saturday');
  assert.equal(nextWorkingDay('2026-10-07', WORKING), '2026-10-08');
});

test('a date is read in India, not on the server clock', () => {
  // 00:30 on the 15th in India is still the 14th in UTC
  assert.equal(dateIn(TZ, new Date('2026-10-14T19:00:00Z')), '2026-10-15');
  assert.equal(dateIn('UTC', new Date('2026-10-14T19:00:00Z')), '2026-10-14');
});

// ---------------------------------------------------------------- recording

test('anyone can mark their own leave, planned ahead, and the whole team can see it', async (t) => {
  if (skipIfUnavailable(t)) return;

  const start = nextMonday();
  const end = addDays(start, 4);
  const res = await call('POST', '/availability', {
    token: tokens.vartika,
    body: { status: 'ON_LEAVE', start_date: start, end_date: end, note: 'Family wedding, back after' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const entry = res.body.entry;
  assert.equal(entry.user_id, ids.vartika);
  assert.equal(entry.planned, true, 'booked before it starts');
  assert.equal(entry.working_days, 5);
  assert.equal(entry.back_on, addDays(end, 1));
  ids.vartikaLeave = entry.id;

  // a teammate sees it on the team calendar
  const seen = await call('GET', `/availability?from=${start}&to=${end}`, { token: tokens.rahul });
  assert.equal(seen.status, 200);
  const row = seen.body.entries.find((e) => e.id === entry.id);
  assert.ok(row);
  assert.equal(row.full_name, 'Vartika Gupta');
  assert.equal(row.note, 'Family wedding, back after');
});

test('today, a half day, and nothing contradictory', async (t) => {
  if (skipIfUnavailable(t)) return;

  const halfNoPart = await call('POST', '/availability', {
    token: tokens.rahul, body: { status: 'HALF_DAY', start_date: today() },
  });
  assert.equal(halfNoPart.status, 400, 'which half has to be said');

  const half = await call('POST', '/availability', {
    token: tokens.rahul,
    body: { status: 'HALF_DAY', start_date: today(), end_date: addDays(today(), 3), day_part: 'AFTERNOON' },
  });
  assert.equal(half.status, 201);
  assert.equal(half.body.entry.end_date, today(), 'a half day is one date, whatever else was sent');
  assert.equal(half.body.entry.is_current, true);
  assert.equal(half.body.entry.working_days, 0.5);

  const overlapping = await call('POST', '/availability', {
    token: tokens.rahul, body: { status: 'ON_LEAVE', start_date: today() },
  });
  assert.equal(overlapping.status, 400);
  assert.match(overlapping.body.error, /already marked/);

  const backwards = await call('POST', '/availability', {
    token: tokens.rahul,
    body: { status: 'ON_LEAVE', start_date: addDays(today(), 10), end_date: addDays(today(), 8) },
  });
  assert.equal(backwards.status, 400);

  // and it shows wherever people are listed
  const users = await call('GET', '/users', { token: tokens.manager });
  const rahul = users.body.users.find((u) => u.id === ids.rahul);
  assert.equal(rahul.away_today.status, 'HALF_DAY');
  assert.equal(users.body.users.find((u) => u.id === ids.manager).away_today, null);

  const summary = await call('GET', '/availability/summary', { token: tokens.vartika });
  assert.ok(summary.body.away_today.some((e) => e.user_id === ids.rahul));
  assert.ok(summary.body.upcoming.some((e) => e.user_id === ids.vartika));
});

test('only a manager can mark somebody else away, and that person is told', async (t) => {
  if (skipIfUnavailable(t)) return;

  const denied = await call('POST', '/availability', {
    token: tokens.rahul,
    body: { user_id: ids.vartika, status: 'UNAVAILABLE', start_date: addDays(today(), 20) },
  });
  assert.equal(denied.status, 403);

  const byManager = await call('POST', '/availability', {
    token: tokens.manager,
    body: { user_id: ids.vartika, status: 'UNAVAILABLE', start_date: addDays(today(), 20) },
  });
  assert.equal(byManager.status, 201);

  const { rows } = await query(
    `SELECT title FROM notifications WHERE user_id = $1 AND type = 'availability'`, [ids.vartika],
  );
  assert.ok(rows.some((r) => /marked you unavailable/.test(r.title)));

  // and nobody else can cancel it for her
  const cancelDenied = await call('DELETE', `/availability/${byManager.body.entry.id}`, { token: tokens.rahul });
  assert.equal(cancelDenied.status, 403);
});

// ---------------------------------------------------------------- assigning

test('assigning work due while someone is away is warned about, with a better date', async (t) => {
  if (skipIfUnavailable(t)) return;

  const start = nextMonday();
  const lastDay = addDays(start, 4); // Friday
  // due at 6pm India time on the Wednesday of her leave
  const due = indiaTime(addDays(start, 2), '18:00');

  const check = await call('GET', `/availability/check?user_id=${ids.vartika}&due=${encodeURIComponent(due)}`, {
    token: tokens.manager,
  });
  assert.equal(check.status, 200);
  const conflict = check.body.conflict;
  assert.ok(conflict.on_due_date, 'on leave on the deadline');
  assert.equal(conflict.on_due_date.status, 'ON_LEAVE');
  assert.equal(conflict.suggested_due_date, addDays(lastDay, 1), 'the first day she is back');
  assert.ok(conflict.working_days_away >= 3);

  // the same check travels with the saved task, for anything that skips the dialog
  const created = await call('POST', '/tasks', {
    token: tokens.manager,
    body: {
      title: 'Prepare dealer training deck', department_id: ids.department,
      assignee_id: ids.vartika, due_date: due,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.availability_warning?.on_due_date, 'saving is never refused, but it is said');
  ids.clashTask = created.body.task.id;

  // someone available gets no warning
  const fine = await call('GET', `/availability/check?user_id=${ids.manager}&due=${encodeURIComponent(due)}`, {
    token: tokens.manager,
  });
  assert.equal(fine.body.conflict, null);
});

test('the deadline is judged by the date in India', async (t) => {
  if (skipIfUnavailable(t)) return;

  const start = nextMonday();
  const lastDay = addDays(start, 4);

  // 23:30 on her last day of leave in India is still during her leave …
  const late = await call('GET', `/availability/check?user_id=${ids.vartika}&due=${encodeURIComponent(indiaTime(lastDay, '23:30'))}`, {
    token: tokens.manager,
  });
  assert.ok(late.body.conflict?.on_due_date);

  // … and 00:30 the next morning in India is not, though UTC would say otherwise
  const nextMorning = await call('GET', `/availability/check?user_id=${ids.vartika}&due=${encodeURIComponent(indiaTime(addDays(lastDay, 1), '00:30'))}`, {
    token: tokens.manager,
  });
  assert.equal(nextMorning.body.conflict?.on_due_date ?? null, null);
});

test('booking leave over work already assigned says which tasks, and tells whoever assigned them', async (t) => {
  if (skipIfUnavailable(t)) return;

  const due = addDays(today(), 40);
  const task = await call('POST', '/tasks', {
    token: tokens.manager,
    body: {
      title: 'Quarterly stock audit', department_id: ids.department,
      assignee_id: ids.rahul, due_date: indiaTime(due, '17:00'),
    },
  });
  assert.equal(task.status, 201);

  const leave = await call('POST', '/availability', {
    token: tokens.rahul,
    body: { status: 'ON_LEAVE', start_date: addDays(due, -1), end_date: addDays(due, 1) },
  });
  assert.equal(leave.status, 201);
  assert.deepEqual(leave.body.tasks_due_during.map((x) => x.id), [task.body.task.id]);

  const { rows } = await query(
    `SELECT title FROM notifications WHERE user_id = $1 AND type = 'availability'`, [ids.manager],
  );
  assert.ok(rows.some((r) => /Rahul Mehta will be on leave when a task you assigned is due/.test(r.title)));
});

test('cancelled leave disappears from the calendar but is kept on record', async (t) => {
  if (skipIfUnavailable(t)) return;

  const cancelled = await call('DELETE', `/availability/${ids.vartikaLeave}`, { token: tokens.vartika });
  assert.equal(cancelled.status, 200);

  const start = nextMonday();
  const calendar = await call('GET', `/availability?from=${start}&to=${addDays(start, 4)}`, { token: tokens.rahul });
  assert.ok(!calendar.body.entries.some((e) => e.id === ids.vartikaLeave));

  const { rows } = await query('SELECT cancelled_at, cancelled_by FROM user_availability WHERE id = $1', [ids.vartikaLeave]);
  assert.ok(rows[0].cancelled_at, 'the row is still there');
  assert.equal(rows[0].cancelled_by, ids.vartika);

  // and with it gone, the same deadline is fine again
  const due = indiaTime(addDays(start, 2), '18:00');
  const check = await call('GET', `/availability/check?user_id=${ids.vartika}&due=${encodeURIComponent(due)}`, {
    token: tokens.manager,
  });
  assert.equal(check.body.conflict, null);
});
