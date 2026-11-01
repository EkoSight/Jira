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

  // the manager reviews this department's leave
  await query('INSERT INTO attendance_team_access (manager_id, department_id) VALUES ($1, $2)', [ids.manager, ids.department]);

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

/** Leave through its one lifecycle: requested, then approved by a reviewer. */
async function approvedLeave(token, body, decision = 'APPROVED_UNPAID') {
  const asked = await call('POST', '/leave', { token, body: { category: 'CASUAL', reason: 'Synthetic test leave', ...body } });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const decided = await call('POST', `/leave/${asked.body.request.id}/decide`, { token: tokens.manager, body: { decision, note: 'ok' } });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  return { requestId: asked.body.request.id, decision: decided.body };
}

test('leave is requested, and once approved the whole team sees it on the calendar', async (t) => {
  if (skipIfUnavailable(t)) return;

  const start = nextMonday();
  const end = addDays(start, 4);
  // marking leave straight onto the calendar would skip approval and payroll locks (audit B)
  const direct = await call('POST', '/availability', {
    token: tokens.vartika,
    body: { status: 'ON_LEAVE', start_date: start, end_date: end, note: 'Family wedding, back after' },
  });
  assert.equal(direct.status, 409);
  assert.equal(direct.body.details.code, 'USE_LEAVE_REQUEST');

  const { requestId, decision } = await approvedLeave(tokens.vartika, { start_date: start, end_date: end });
  ids.vartikaLeaveRequest = requestId;
  // one approval, one calendar entry
  const { rows: projections } = await query('SELECT id FROM user_availability WHERE user_id = $1 AND cancelled_at IS NULL', [ids.vartika]);
  assert.equal(projections.length, 1);
  assert.equal(projections[0].id, decision.availability_id);

  const seen = await call('GET', `/availability?from=${start}&to=${end}`, { token: tokens.rahul });
  assert.equal(seen.status, 200);
  const row = seen.body.entries.find((e) => e.id === decision.availability_id);
  assert.ok(row, 'a teammate sees it on the team calendar');
  assert.equal(row.full_name, 'Vartika Gupta');
  assert.equal(row.source, 'LEAVE_REQUEST');
  assert.equal(row.leave_request_id, requestId);
  assert.equal(row.planned, true, 'booked before it starts');
  assert.equal(row.working_days, 5);
  assert.equal(row.back_on, addDays(end, 1));
  ids.vartikaLeave = row.id;

  // the calendar copy changes only through the request
  const edit = await call('PATCH', `/availability/${row.id}`, { token: tokens.vartika, body: { end_date: start } });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.details.code, 'MANAGED_BY_LEAVE_REQUEST');
  const remove = await call('DELETE', `/availability/${row.id}`, { token: tokens.manager });
  assert.equal(remove.status, 409);
});

test('half days go through leave too; unavailable is a planning note; nothing contradictory', async (t) => {
  if (skipIfUnavailable(t)) return;

  for (const body of [{ status: 'HALF_DAY', start_date: today() }, { status: 'HALF_DAY', start_date: today(), day_part: 'AFTERNOON' }]) {
    const half = await call('POST', '/availability', { token: tokens.rahul, body });
    assert.equal(half.status, 409, 'a half day is leave');
  }

  const away = await call('POST', '/availability', {
    token: tokens.rahul,
    body: { status: 'UNAVAILABLE', start_date: today(), end_date: addDays(today(), 3), note: 'At the field trial' },
  });
  assert.equal(away.status, 201, JSON.stringify(away.body));
  assert.equal(away.body.entry.is_current, true);
  assert.equal(away.body.entry.source, 'PLANNING');

  const overlapping = await call('POST', '/availability', {
    token: tokens.rahul, body: { status: 'UNAVAILABLE', start_date: today() },
  });
  assert.equal(overlapping.status, 400);
  assert.match(overlapping.body.error, /already marked/);

  const backwards = await call('POST', '/availability', {
    token: tokens.rahul,
    body: { status: 'UNAVAILABLE', start_date: addDays(today(), 10), end_date: addDays(today(), 8) },
  });
  assert.equal(backwards.status, 400);

  // a planning note can change, but cannot be turned into leave
  const toLeave = await call('PATCH', `/availability/${away.body.entry.id}`, { token: tokens.rahul, body: { status: 'ON_LEAVE' } });
  assert.equal(toLeave.status, 409);
  const shorter = await call('PATCH', `/availability/${away.body.entry.id}`, { token: tokens.rahul, body: { end_date: addDays(today(), 1) } });
  assert.equal(shorter.status, 200);

  // and it shows wherever people are listed
  const users = await call('GET', '/users', { token: tokens.manager });
  const rahul = users.body.users.find((u) => u.id === ids.rahul);
  assert.equal(rahul.away_today.status, 'UNAVAILABLE');
  assert.equal(users.body.users.find((u) => u.id === ids.manager).away_today, null);

  const summary = await call('GET', '/availability/summary', { token: tokens.vartika });
  assert.ok(summary.body.away_today.some((e) => e.user_id === ids.rahul));
  assert.ok(summary.body.upcoming.some((e) => e.user_id === ids.vartika));

  // an approved half day lands on the calendar as one half of one date
  const day = addDays(nextMonday(), 14);
  const { decision } = await approvedLeave(tokens.vartika, { start_date: day, end_date: day, day_part: 'SECOND_HALF' });
  const entry = (await call('GET', `/availability?from=${day}&to=${day}`, { token: tokens.rahul })).body.entries
    .find((e) => e.id === decision.availability_id);
  assert.equal(entry.status, 'HALF_DAY');
  assert.equal(entry.day_part, 'AFTERNOON');
  assert.equal(entry.end_date, day);
  assert.equal(entry.working_days, 0.5);
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

test('approving leave over work already assigned says which tasks, and tells whoever assigned them', async (t) => {
  if (skipIfUnavailable(t)) return;

  // a working day five to six weeks out
  let due = addDays(today(), 40);
  if (new Date(`${due}T00:00:00Z`).getUTCDay() === 0) due = addDays(due, 1);
  const task = await call('POST', '/tasks', {
    token: tokens.manager,
    body: {
      title: 'Quarterly stock audit', department_id: ids.department,
      assignee_id: ids.rahul, due_date: indiaTime(due, '17:00'),
    },
  });
  assert.equal(task.status, 201);

  const { decision } = await approvedLeave(tokens.rahul, { start_date: addDays(due, -1), end_date: addDays(due, 1) });
  assert.deepEqual(decision.tasks_due_during.map((x) => x.id), [task.body.task.id]);

  const { rows } = await query(
    `SELECT title FROM notifications WHERE user_id = $1 AND type = 'availability'`, [ids.manager],
  );
  assert.ok(rows.some((r) => /Rahul Mehta will be on leave when a task you assigned is due/.test(r.title)));
});

test('cancelled leave disappears from the calendar but is kept on record', async (t) => {
  if (skipIfUnavailable(t)) return;

  // cancelled through the request — which takes its calendar copy with it
  const cancelled = await call('POST', `/leave/${ids.vartikaLeaveRequest}/cancel`, { token: tokens.vartika, body: {} });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.request.status, 'CANCELLED');

  const start = nextMonday();
  const calendar = await call('GET', `/availability?from=${start}&to=${addDays(start, 4)}`, { token: tokens.rahul });
  assert.ok(!calendar.body.entries.some((e) => e.id === ids.vartikaLeave));

  const { rows } = await query('SELECT cancelled_at, cancelled_by FROM user_availability WHERE id = $1', [ids.vartikaLeave]);
  assert.ok(rows[0].cancelled_at, 'the row is still there');
  assert.equal(rows[0].cancelled_by, ids.vartika);

  // and with it gone, the same deadline is fine again
  const due = indiaTime(addDays(start, 2), '18:00');
  const check = await call('GET', `/availability?from=${start}&to=${start}`, { token: tokens.manager });
  assert.ok(!check.body.entries.some((e) => e.user_id === ids.vartika));
  const conflict = await call('GET', `/availability/check?user_id=${ids.vartika}&due=${encodeURIComponent(due)}`, {
    token: tokens.manager,
  });
  assert.equal(conflict.body.conflict, null);
});

test('leave marked on the calendar before requests existed: kept, cancellable, never edited, never past a payroll lock', async (t) => {
  if (skipIfUnavailable(t)) return;

  // a row as the old "Mark leave" wrote it — synthetic, inserted directly
  const insert = (start, end) => query(
    `INSERT INTO user_availability (user_id, status, start_date, end_date, created_by)
     VALUES ($1, 'ON_LEAVE', $2, $3, $1) RETURNING id`,
    [ids.rahul, start, end],
  ).then((r) => r.rows[0].id);
  const legacy = await insert(addDays(today(), 60), addDays(today(), 61));

  const listed = (await call('GET', `/availability?from=${addDays(today(), 60)}&to=${addDays(today(), 61)}`, { token: tokens.manager })).body.entries;
  assert.equal(listed.find((e) => e.id === legacy).source, 'LEGACY_LEAVE');

  const edit = await call('PATCH', `/availability/${legacy}`, { token: tokens.rahul, body: { end_date: addDays(today(), 62) } });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.details.code, 'USE_LEAVE_REQUEST');

  const other = await call('DELETE', `/availability/${legacy}`, { token: tokens.vartika });
  assert.equal(other.status, 403, 'permissions still apply');
  const ok = await call('DELETE', `/availability/${legacy}`, { token: tokens.rahul });
  assert.equal(ok.status, 200);
  const { rows: audit } = await query(`SELECT action FROM attendance_audit WHERE entity_type = 'AVAILABILITY' AND entity_id = $1`, [String(legacy)]);
  assert.deepEqual(audit.map((r) => r.action), ['LEGACY_LEAVE_CANCELLED']);
  // it was never leave in pay, and it is not turned into any now
  const { rows: requests } = await query('SELECT COUNT(*)::int AS n FROM leave_requests WHERE user_id = $1 AND start_date = $2', [ids.rahul, addDays(today(), 60)]);
  assert.equal(requests[0].n, 0);

  // in a month whose payroll is approved or locked, the calendar cannot rewrite it
  const lockedDay = addDays(today(), 90);
  const month = `${lockedDay.slice(0, 7)}-01`;
  await query(`INSERT INTO payroll_results (month, user_id, version, status) VALUES ($1, $2, 1, 'LOCKED')`, [month, ids.rahul]);
  const inLocked = await insert(lockedDay, lockedDay);
  const refused = await call('DELETE', `/availability/${inLocked}`, { token: tokens.rahul });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.code, 'PAYROLL_LOCKED');
});
