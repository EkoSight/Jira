/**
 * Attendance, leave and the monthly salary estimate, end to end.
 *
 * What is guarded here: the server's clock decides attendance times; retries
 * and second devices never create a second record; locations are validated and
 * only shown to people entitled to see them; the check-in requirement is
 * enforced on the server and never locks anyone out of their own attendance;
 * corrections keep the original; leave is paid only when approved and only up
 * to the allowance; and a locked month cannot quietly change.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { addDays, checkOut, dateIn, instantAt } from '../src/services/attendance.js';
import { csvCell } from '../src/lib/csv.js';
import { monthBounds } from '../src/services/attendanceLedger.js';

let server;
let baseUrl;
let available = true;
const tokens = {};
const ids = {};
const TZ = 'Asia/Kolkata';
const PRIVACY = 'Task Flow records your current location when you check in and check out for attendance. It does not continuously track your location.';

const call = async (method, path, { token, body, raw = false } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const skip = (t) => {
  if (!available) { t.skip('no database'); return true; }
  return false;
};

let seq = 0;
const rid = () => `req-${Date.now()}-${(seq += 1)}-abcdef`;
const here = (over = {}) => ({ latitude: 28.6139, longitude: 77.209, accuracy: 25, timestamp: Date.now(), ...over });
const today = () => dateIn(TZ);
const at = (date, time) => `${date}T${time}:00+05:30`;
const firstOfPrevMonth = () => {
  const d = today();
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};
const lastOf = (first) => monthBounds(first).last;
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });

  await query(`INSERT INTO departments (key, name, color, position) VALUES ('OPS', 'Operations', '#2a78d6', 1), ('SAL', 'Sales', '#d62a6a', 2)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );
  const { rows: depts } = await query('SELECT id, key FROM departments');
  ids.ops = depts.find((d) => d.key === 'OPS').id;
  ids.sales = depts.find((d) => d.key === 'SAL').id;

  const password = await hashPassword('Password123!');
  for (const [key, name, role, dept] of [
    ['admin', 'Asha Admin', 'admin', ids.ops],
    ['manager', 'Meera Manager', 'manager', ids.ops],
    ['lead', 'Lalit Lead', 'manager', ids.sales],
    ['vartika', 'Vartika Gupta', 'member', ids.ops],
    ['rahul', 'Rahul Mehta', 'member', ids.ops],
    ['nina', 'Nina Rao', 'member', ids.ops],
    ['sam', 'Sam Iyer', 'member', ids.sales],
    ['payee', 'Pavan Kumar', 'member', ids.sales],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id`,
      [name, `att-${key}@test.local`, password, role, dept],
    );
    ids[key] = rows[0].id;
  }

  await new Promise((resolve) => {
    server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  for (const key of ['admin', 'manager', 'lead', 'vartika', 'rahul', 'nina', 'sam', 'payee']) {
    const login = await call('POST', '/auth/login', { body: { email: `att-${key}@test.local`, password: 'Password123!' } });
    tokens[key] = login.body.token;
  }
  // the manager is granted Operations; the lead is granted nothing
  const grant = await call('PUT', `/attendance/team-access/${ids.manager}`, { token: tokens.admin, body: { department_ids: [ids.ops] } });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- dormant until configured

test('the privacy notice is the agreed wording, and nothing is enforced until a start date is set', async (t) => {
  if (skip(t)) return;
  const notice = await call('GET', '/attendance/privacy', { token: tokens.sam });
  assert.equal(notice.body.notice, PRIVACY);

  const todayRes = await call('GET', '/attendance/today', { token: tokens.sam });
  assert.equal(todayRes.status, 200);
  assert.equal(todayRes.body.gate.satisfied, true);
  assert.equal(todayRes.body.gate.reason, 'NOT_ENFORCED');
  assert.equal(todayRes.body.privacy_notice, PRIVACY);

  // existing work goes on exactly as before
  const task = await call('POST', '/tasks', { token: tokens.sam, body: { title: 'Call the dealer back', department_id: ids.sales, assignee_id: ids.sam, due_date: at(addDays(today(), 7), '17:00') } });
  assert.equal(task.status, 201, JSON.stringify(task.body));
});

// ---------------------------------------------------------------- location validation

test('check-in needs a real, fresh location reading — none is invented', async (t) => {
  if (skip(t)) return;
  const tries = [
    [undefined, 'LOCATION_REQUIRED'],
    [here({ latitude: 95 }), 'LOCATION_INVALID'],
    [here({ longitude: -181 }), 'LOCATION_INVALID'],
    [here({ accuracy: 0 }), 'LOCATION_INVALID'],
    [here({ accuracy: 'about here' }), 'LOCATION_INVALID'],
    [here({ timestamp: Date.now() - 10 * 60 * 1000 }), 'LOCATION_STALE'],
    [here({ timestamp: Date.now() + 10 * 60 * 1000 }), 'LOCATION_STALE'],
  ];
  for (const [location, code] of tries) {
    const res = await call('POST', '/attendance/check-in', { token: tokens.vartika, body: { request_id: rid(), location } });
    assert.equal(res.status, 400, `${JSON.stringify(location)} should be refused`);
    assert.equal(res.body.details.code, code);
  }
  const noId = await call('POST', '/attendance/check-in', { token: tokens.vartika, body: { location: here() } });
  assert.equal(noId.status, 400, 'every action carries a request id');
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM attendance_sessions WHERE user_id = $1', [ids.vartika]);
  assert.equal(rows[0].n, 0, 'nothing was recorded from a bad reading');
});

// ---------------------------------------------------------------- check in / out

test('check-in uses the server clock; a retry or a second device never makes a second record', async (t) => {
  if (skip(t)) return;
  const requestId = rid();
  const deviceTime = Date.now() - 30_000;
  const first = await call('POST', '/attendance/check-in', {
    token: tokens.vartika,
    // a client that claims an earlier time is ignored
    body: { request_id: requestId, location: here({ timestamp: deviceTime }), check_in_at: '2020-01-01T03:30:00Z' },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const session = first.body.session;
  assert.equal(session.status, 'OPEN');
  assert.equal(session.work_date, today());
  assert.ok(Math.abs(new Date(session.check_in_at) - Date.now()) < 10_000, 'the server time is recorded, not the client claim');
  assert.equal(new Date(session.check_in_location_at).getTime(), deviceTime, 'the device time is kept as metadata');
  assert.equal(session.check_in_source, 'DEVICE_LOCATION');
  assert.equal(Number(session.check_in_lat), 28.6139);

  const replay = await call('POST', '/attendance/check-in', { token: tokens.vartika, body: { request_id: requestId, location: here() } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.session.id, session.id);
  assert.equal(replay.body.session.check_in_at, session.check_in_at, 'a replay returns the original, unchanged');

  const otherDevice = await call('POST', '/attendance/check-in', { token: tokens.vartika, body: { request_id: rid(), location: here({ latitude: 19.07 }) } });
  assert.equal(otherDevice.status, 200);
  assert.equal(otherDevice.body.already, true);
  assert.equal(otherDevice.body.session.id, session.id);
  assert.equal(Number(otherDevice.body.session.check_in_lat), 28.6139, 'the second device did not move the record');

  // signing in again is not attendance
  await call('POST', '/auth/login', { body: { email: 'att-vartika@test.local', password: 'Password123!' } });
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM attendance_sessions WHERE user_id = $1', [ids.vartika]);
  assert.equal(rows[0].n, 1);
});

test('simultaneous check-ins from several devices leave exactly one session', async (t) => {
  if (skip(t)) return;
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    call('POST', '/attendance/check-in', { token: tokens.rahul, body: { request_id: rid(), location: here() } })));
  for (const r of results) assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  assert.equal(results.filter((r) => r.status === 201).length, 1, 'one device made it');
  assert.equal(new Set(results.map((r) => r.body.session.id)).size, 1, 'everyone sees the same session');
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM attendance_sessions WHERE user_id = $1', [ids.rahul]);
  assert.equal(rows[0].n, 1);
});

test('a low-accuracy reading is accepted and flagged for review, not rejected', async (t) => {
  if (skip(t)) return;
  const res = await call('POST', '/attendance/check-in', { token: tokens.nina, body: { request_id: rid(), location: here({ accuracy: 1500 }) } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.session.review_flags, ['LOW_ACCURACY']);
});

test('check-out completes the session once; checking in again the same day needs a correction', async (t) => {
  if (skip(t)) return;
  const requestId = rid();
  const out = await call('POST', '/attendance/check-out', { token: tokens.vartika, body: { request_id: requestId, location: here() } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.session.status, 'COMPLETED');
  assert.ok(out.body.session.recorded_seconds >= 0);

  const replay = await call('POST', '/attendance/check-out', { token: tokens.vartika, body: { request_id: requestId, location: here() } });
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.session.check_out_at, out.body.session.check_out_at);

  const again = await call('POST', '/attendance/check-out', { token: tokens.vartika, body: { request_id: rid(), location: here() } });
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);

  const reIn = await call('POST', '/attendance/check-in', { token: tokens.vartika, body: { request_id: rid(), location: here() } });
  assert.equal(reIn.status, 409);
  assert.equal(reIn.body.details.code, 'ALREADY_RECORDED');
});

test('a check-out after midnight, before the cutoff, completes the original session', async (t) => {
  if (skip(t)) return;
  const yesterday = addDays(today(), -1);
  await query(
    `INSERT INTO attendance_sessions (user_id, work_date, status, check_in_at, check_in_source, check_in_lat, check_in_lng, check_in_accuracy_m)
     VALUES ($1, $2, 'OPEN', $3, 'DEVICE_LOCATION', 12.97, 77.59, 20)`,
    [ids.sam, yesterday, at(yesterday, '20:00')],
  );
  // 01:30 today in India — after midnight, before the 04:00 cutoff
  const now = instantAt(today(), 90 * 60, TZ);
  const user = { id: ids.sam, full_name: 'Sam Iyer' };
  const result = await checkOut(user, { requestId: rid(), location: here({ timestamp: now.getTime() }) }, now);
  assert.equal(result.completed, true);
  assert.equal(result.session.work_date, yesterday, 'it stays on the day it started');
  assert.equal(result.session.status, 'COMPLETED');
  assert.equal((new Date(result.session.check_out_at) - new Date(result.session.check_in_at)) / 1000, 5.5 * 3600);
});

test('a session left open past the cutoff becomes a missing check-out; the time is never guessed', async (t) => {
  if (skip(t)) return;
  const day = addDays(today(), -3);
  // nina is checked in today (the low-accuracy test); finish that first — one open session at a time
  await call('POST', '/attendance/check-out', { token: tokens.nina, body: { request_id: rid(), location: here() } });
  await query(
    `INSERT INTO attendance_sessions (user_id, work_date, status, check_in_at, check_in_source)
     VALUES ($1, $2, 'OPEN', $3, 'DEVICE_LOCATION')`,
    [ids.nina, day, at(day, '09:05')],
  );

  const me = await call('GET', '/attendance/today', { token: tokens.nina });
  assert.equal(me.status, 200);
  const { rows } = await query('SELECT status, check_out_at FROM attendance_sessions WHERE user_id = $1 AND work_date = $2', [ids.nina, day]);
  assert.equal(rows[0].status, 'MISSING_CHECKOUT');
  assert.equal(rows[0].check_out_at, null, 'no check-out time was invented');
  assert.ok(me.body.missing_checkouts.some((m) => m.work_date === day));

  const audit = await query(`SELECT action, source FROM attendance_audit WHERE subject_user_id = $1 AND action = 'MARKED_MISSING_CHECKOUT'`, [ids.nina]);
  assert.equal(audit.rows[0].source, 'SYSTEM');
});

// ---------------------------------------------------------------- corrections

test('a correction keeps the original, marks the result regularised, and nobody approves their own', async (t) => {
  if (skip(t)) return;
  const day = addDays(today(), -3);
  const future = await call('POST', '/attendance/corrections', {
    token: tokens.nina,
    body: { work_date: day, kind: 'MISSED_CHECK_OUT', check_out: '23:59', check_out_next_day: true, reason: 'Forgot to check out' },
  });
  assert.equal(future.status, 400, 'a finish past the cutoff is refused');

  const ask = await call('POST', '/attendance/corrections', {
    token: tokens.nina,
    body: { work_date: day, kind: 'MISSED_CHECK_OUT', check_out: '18:15', reason: 'Phone battery died before I could check out' },
  });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  const id = ask.body.correction.id;

  const dup = await call('POST', '/attendance/corrections', {
    token: tokens.nina, body: { work_date: day, kind: 'MISSED_CHECK_OUT', check_out: '18:20', reason: 'Asking again' },
  });
  assert.equal(dup.status, 409, 'one pending request per day');

  // a pending request changes nothing
  let { rows } = await query('SELECT status FROM attendance_sessions WHERE user_id = $1 AND work_date = $2', [ids.nina, day]);
  assert.equal(rows[0].status, 'MISSING_CHECKOUT');

  const peer = await call('POST', `/attendance/corrections/${id}/decide`, { token: tokens.rahul, body: { decision: 'APPROVED' } });
  assert.equal(peer.status, 403, 'a colleague cannot approve');
  const outsider = await call('POST', `/attendance/corrections/${id}/decide`, { token: tokens.lead, body: { decision: 'APPROVED' } });
  assert.equal(outsider.status, 403, 'a manager of another team cannot approve');

  const ok = await call('POST', `/attendance/corrections/${id}/decide`, { token: tokens.manager, body: { decision: 'APPROVED', note: 'Confirmed with her' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  ({ rows } = await query('SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date = $2', [ids.nina, day]));
  assert.equal(rows[0].status, 'COMPLETED');
  assert.equal(rows[0].regularized, true);
  assert.equal(rows[0].check_out_source, 'MANUALLY_REGULARIZED');
  assert.equal(rows[0].check_in_source, 'DEVICE_LOCATION', 'the untouched check-in keeps its source');
  assert.equal(new Date(rows[0].check_out_at).toISOString(), new Date(at(day, '18:15')).toISOString());

  const stored = await query('SELECT before, after, status FROM attendance_corrections WHERE id = $1', [id]);
  assert.equal(stored.rows[0].before.status, 'MISSING_CHECKOUT', 'the original is kept');
  assert.equal(stored.rows[0].after.status, 'COMPLETED');

  // the manager's own request goes to someone else
  const mine = await call('POST', '/attendance/corrections', {
    token: tokens.manager, body: { work_date: day, kind: 'MISSED_CHECK_IN', check_in: '09:00', check_out: '18:00', reason: 'Was at a client site all day' },
  });
  const self = await call('POST', `/attendance/corrections/${mine.body.correction.id}/decide`, { token: tokens.manager, body: { decision: 'APPROVED' } });
  assert.equal(self.status, 403);

  const ledger = await call('GET', `/attendance/me?month=${day.slice(0, 7)}`, { token: tokens.nina });
  const d = ledger.body.days.find((x) => x.date === day);
  if (d.schedule_state === 'WORKDAY') assert.ok(d.flags.includes('MANUALLY_REGULARIZED'));
});

test('a correction cannot propose a time in the future', async (t) => {
  if (skip(t)) return;
  const res = await call('POST', '/attendance/corrections', {
    token: tokens.rahul, body: { work_date: today(), kind: 'WRONG_TIME', check_out: '23:58', reason: 'Testing a future time' },
  });
  // late in the day this can be valid; it must never be accepted when still ahead
  const ahead = instantAt(today(), 23 * 3600 + 58 * 60, TZ) > new Date();
  assert.equal(res.status === 400, ahead);
});

// ---------------------------------------------------------------- who sees what

test('locations are shown only to the person and to managers authorised for their team', async (t) => {
  if (skip(t)) return;
  const { rows } = await query('SELECT id FROM attendance_sessions WHERE user_id = $1 AND work_date = $2', [ids.rahul, today()]);
  const path = `/attendance/sessions/${rows[0].id}/location`;

  assert.equal((await call('GET', path, { token: tokens.rahul })).status, 200, 'their own');
  assert.equal((await call('GET', path, { token: tokens.vartika })).status, 403, 'a colleague');
  assert.equal((await call('GET', path, { token: tokens.sam })).status, 403, 'another team');
  assert.equal((await call('GET', path, { token: tokens.lead })).status, 403, 'a manager without access to that team');

  const seen = await call('GET', path, { token: tokens.manager });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.check_in.latitude, 28.6139);
  const audit = await query(`SELECT actor_id FROM attendance_audit WHERE action = 'LOCATION_VIEWED' AND subject_user_id = $1`, [ids.rahul]);
  assert.ok(audit.rows.some((r) => r.actor_id === ids.manager), 'someone else looking is logged');

  // the team view follows the same rule
  const team = await call('GET', '/attendance/team/today', { token: tokens.manager });
  const names = team.body.people.map((p) => p.user.full_name);
  assert.ok(names.includes('Rahul Mehta'));
  assert.ok(!names.includes('Sam Iyer'), 'sales is not the manager’s team');
  assert.equal((await call('GET', '/attendance/team/today', { token: tokens.vartika })).status, 403);
  const leadTeam = await call('GET', '/attendance/team/today', { token: tokens.lead });
  assert.deepEqual(leadTeam.body.people.map((p) => p.user.full_name), ['Lalit Lead'], 'a manager with no grant sees only themselves');
  assert.equal((await call('GET', `/attendance/people/${ids.rahul}`, { token: tokens.lead })).status, 403);

  // a colleague's record over the API carries no coordinates for someone not entitled
  const asLead = await call('GET', `/attendance/export.csv?user_id=${ids.rahul}&include_location=1`, { token: tokens.lead, raw: true });
  assert.equal(asLead.status, 403);
});

test('a manager reporting line opens that one person, nobody else', async (t) => {
  if (skip(t)) return;
  const set = await call('PUT', `/attendance/profiles/${ids.payee}`, { token: tokens.admin, body: { reporting_manager_id: ids.lead, joining_date: '2025-01-01' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const team = await call('GET', '/attendance/team/today', { token: tokens.lead });
  assert.deepEqual(team.body.people.map((p) => p.user.full_name).sort(), ['Lalit Lead', 'Pavan Kumar']);
  assert.equal((await call('GET', `/attendance/people/${ids.sam}`, { token: tokens.lead })).status, 403);
});

test('pay is behind its own permission', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('GET', '/payroll/2026-01', { token: tokens.manager })).status, 403);
  assert.equal((await call('GET', '/payroll/2026-01', { token: tokens.vartika })).status, 403);
  assert.equal((await call('POST', `/payroll/salary/${ids.vartika}`, { token: tokens.manager, body: { effective_from: '2025-01-01', attendance_sensitive: 1 } })).status, 403);

  // preparing payroll is not approving or reopening it
  await query(`UPDATE users SET extra_permissions = ARRAY['payroll.view', 'payroll.manage'] WHERE id = $1`, [ids.nina]);
  for (const action of ['approve', 'lock', 'reopen']) {
    const res = await call('POST', `/payroll/2026-01/people/${ids.rahul}/${action}`, { token: tokens.nina, body: { reason: 'x' } });
    assert.equal(res.status, 403, `${action} needs its own permission`);
    assert.match(res.body.error, /payroll\.(approve|reopen)/);
  }
  const bulk = await call('POST', '/payroll/2026-01/bulk', { token: tokens.nina, body: { action: 'approve', user_ids: [ids.rahul] } });
  assert.equal(bulk.status, 403);
  await query(`UPDATE users SET extra_permissions = '{}' WHERE id = $1`, [ids.nina]);
});

// ---------------------------------------------------------------- the requirement

test('once started, work changes need a check-in — enforced on the server — while attendance stays open', async (t) => {
  if (skip(t)) return;
  const versions = await call('GET', '/attendance/policy', { token: tokens.admin });
  const policyId = versions.body.versions[0].id;
  assert.equal((await call('PATCH', `/attendance/policy/${policyId}`, { token: tokens.vartika, body: { config: { startDate: today() } } })).status, 403);
  const start = await call('PATCH', `/attendance/policy/${policyId}`, { token: tokens.admin, body: { config: { startDate: firstOfPrevMonth() } } });
  assert.equal(start.status, 200, JSON.stringify(start.body));

  // make every day a working day for this test, so it holds on a Sunday too
  await call('PUT', `/attendance/profiles/${ids.sam}`, { token: tokens.admin, body: { working_days: [0, 1, 2, 3, 4, 5, 6] } });

  const blocked = await call('POST', '/tasks', { token: tokens.sam, body: { title: 'Update the price list', department_id: ids.sales, assignee_id: ids.sam, due_date: at(addDays(today(), 7), '17:00') } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.details.code, 'ATTENDANCE_REQUIRED');
  const blockedThread = await call('PATCH', '/tasks/1', { token: tokens.sam, body: { title: 'Changed' } });
  assert.equal(blockedThread.status, 403);

  // reading, attendance, corrections and leave stay open
  assert.equal((await call('GET', '/tasks', { token: tokens.sam })).status, 200);
  const gate = await call('GET', '/attendance/today', { token: tokens.sam });
  assert.equal(gate.body.gate.satisfied, false);
  assert.equal((await call('GET', '/leave/mine', { token: tokens.sam })).status, 200);
  assert.equal((await call('GET', '/attendance/corrections', { token: tokens.sam })).status, 200);

  const checkIn = await call('POST', '/attendance/check-in', { token: tokens.sam, body: { request_id: rid(), location: here() } });
  assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
  const allowed = await call('POST', '/tasks', { token: tokens.sam, body: { title: 'Update the price list', department_id: ids.sales, assignee_id: ids.sam, due_date: at(addDays(today(), 7), '17:00') } });
  assert.equal(allowed.status, 201);

  // someone who does not need to record attendance is never blocked
  await call('PUT', `/attendance/profiles/${ids.lead}`, { token: tokens.admin, body: { attendance_required: false } });
  const lead = await call('POST', '/tasks', { token: tokens.lead, body: { title: 'Plan the quarter', department_id: ids.sales, assignee_id: ids.lead, due_date: at(addDays(today(), 7), '17:00') } });
  assert.equal(lead.status, 201);
});

// ---------------------------------------------------------------- leave

/** A Monday at least `minDays` ahead whose Monday–Thursday stay in one month. */
function plannedMonday(minDays) {
  let d = addDays(today(), minDays);
  while (weekday(d) !== 1 || d.slice(0, 7) !== addDays(d, 3).slice(0, 7)) d = addDays(d, 1);
  return d;
}

test('leave: notice is measured from when TaskFlow received it, emergencies take their own path', async (t) => {
  if (skip(t)) return;
  const monday = plannedMonday(10);
  const planned = await call('POST', '/leave', {
    token: tokens.vartika,
    body: { category: 'CASUAL', start_date: monday, end_date: addDays(monday, 2), reason: 'Family function in Jaipur' },
  });
  assert.equal(planned.status, 201, JSON.stringify(planned.body));
  assert.equal(planned.body.request.status, 'SUBMITTED');
  assert.equal(planned.body.request.notice_compliant, true);
  assert.equal(planned.body.email.sent, false, 'TaskFlow says plainly it sent no email');
  ids.plannedLeave = planned.body.request.id;

  const overlap = await call('POST', '/leave', {
    token: tokens.vartika, body: { category: 'SICK', start_date: addDays(monday, 1), end_date: addDays(monday, 1), reason: 'Overlap' },
  });
  assert.equal(overlap.status, 409);

  // a claimed earlier email does not backdate the notice
  const tomorrow = addDays(today(), 1);
  const short = await call('POST', '/leave', {
    token: tokens.rahul,
    body: {
      category: 'CASUAL', start_date: tomorrow, end_date: tomorrow, reason: 'Bank work',
      email_reference: 'Email to Meera, subject “Leave”', claimed_notified_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    },
  });
  if (short.status === 400) {
    // tomorrow is a weekly off: nothing to request
    assert.match(short.body.error, /no scheduled working days/);
  } else {
    assert.equal(short.body.request.status, 'NOTICE_EXCEPTION');
    assert.equal(short.body.request.notice_compliant, false);
    assert.equal(short.body.request.email_reference, 'Email to Meera, subject “Leave”');
  }

  const vague = await call('POST', '/leave', {
    token: tokens.nina, body: { category: 'SICK', start_date: today(), end_date: today(), reason: 'Unwell', is_emergency: true },
  });
  assert.equal(vague.status, 400, 'an emergency needs an explanation');
});

test('leave: paid only on approval and only up to the monthly allowance; the rest is unpaid and says so', async (t) => {
  if (skip(t)) return;
  const self = await call('POST', '/leave', {
    token: tokens.manager, body: { category: 'CASUAL', start_date: plannedMonday(20), end_date: plannedMonday(20), reason: 'Personal' },
  });
  const selfDecide = await call('POST', `/leave/${self.body.request.id}/decide`, { token: tokens.manager, body: { decision: 'APPROVED_PAID' } });
  assert.equal(selfDecide.status, 403, 'no approving your own leave');

  // nothing about pending leave is paid
  const monday = plannedMonday(10);
  const before = await call('GET', `/leave/balance?month=${monday.slice(0, 7)}`, { token: tokens.vartika });
  assert.equal(before.body.buckets[0].allowance, 2);
  assert.equal(before.body.buckets[0].used, 0);

  const peer = await call('POST', `/leave/${ids.plannedLeave}/decide`, { token: tokens.rahul, body: { decision: 'APPROVED_PAID' } });
  assert.equal(peer.status, 403);

  const ok = await call('POST', `/leave/${ids.plannedLeave}/decide`, { token: tokens.manager, body: { decision: 'APPROVED_PAID' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.paid_days, 2, 'two paid days, the allowance');
  assert.equal(ok.body.unpaid_days, 1, 'the third is unpaid');

  const after_ = await call('GET', `/leave/balance?month=${monday.slice(0, 7)}`, { token: tokens.vartika });
  assert.equal(after_.body.buckets[0].used, 2);
  assert.equal(after_.body.buckets[0].left, 0);

  // it appears on the team calendar everyone already uses
  const { rows } = await query('SELECT availability_id FROM leave_requests WHERE id = $1', [ids.plannedLeave]);
  const cal = await query('SELECT status, start_date, end_date, cancelled_at FROM user_availability WHERE id = $1', [rows[0].availability_id]);
  assert.equal(cal.rows[0].status, 'ON_LEAVE');
  assert.equal(cal.rows[0].start_date, monday);

  // the reason is private to the person and approvers
  assert.equal((await call('GET', `/leave/${ids.plannedLeave}`, { token: tokens.rahul })).status, 403);
  const asManager = await call('GET', `/leave/${ids.plannedLeave}`, { token: tokens.manager });
  assert.equal(asManager.body.request.reason, 'Family function in Jaipur');

  // a second paid request in the same month gets nothing paid
  const more = await call('POST', '/leave', {
    token: tokens.vartika, body: { category: 'SICK', start_date: addDays(monday, 3), end_date: addDays(monday, 3), reason: 'Dentist' },
  });
  const decided = await call('POST', `/leave/${more.body.request.id}/decide`, { token: tokens.manager, body: { decision: 'APPROVED_PAID' } });
  assert.equal(decided.body.status, 'APPROVED_UNPAID');

  // cancelling approved leave takes it off the calendar too
  const noReason = await call('POST', `/leave/${more.body.request.id}/cancel`, { token: tokens.manager, body: {} });
  assert.equal(noReason.status, 400);
  const cancel = await call('POST', `/leave/${more.body.request.id}/cancel`, { token: tokens.manager, body: { reason: 'Appointment moved' } });
  assert.equal(cancel.status, 200);
  const { rows: r2 } = await query('SELECT u.cancelled_at FROM leave_requests l JOIN user_availability u ON u.id = l.availability_id WHERE l.id = $1', [more.body.request.id]);
  assert.ok(r2[0].cancelled_at);
});

// ---------------------------------------------------------------- payroll

test('payroll: drafts say what is missing; a clean month moves to locked; changes after submitting are caught', async (t) => {
  if (skip(t)) return;
  const first = firstOfPrevMonth();
  const last = lastOf(first);
  const month = first.slice(0, 7);
  const workdays = [];
  for (let d = first; d <= last; d = addDays(d, 1)) if (weekday(d) !== 0) workdays.push(d);
  const [lateDay, extraDay, missingDay, ...rest] = workdays;

  const insert = (date, from, to) => query(
    `INSERT INTO attendance_sessions (user_id, work_date, status, check_in_at, check_out_at, check_in_source, check_out_source)
     VALUES ($1, $2, 'COMPLETED', $3, $4, 'DEVICE_LOCATION', 'DEVICE_LOCATION')`,
    [ids.payee, date, at(date, from), at(date, to)],
  );
  await insert(lateDay, '09:30', '18:00');
  await insert(extraDay, '09:00', '18:45');
  for (const d of rest) await insert(d, '09:00', '18:00');
  void missingDay;

  let view = await call('GET', `/payroll/${month}/people/${ids.payee}`, { token: tokens.admin });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.status, 'NEEDS_SETUP');
  const codes = view.body.setup.map((s) => s.code);
  for (const code of ['POLICY_ACCEPTED', 'POLICY_BREAKSCONFIRMED', 'POLICY_METHODCONFIRMED', 'SALARY_BASIS']) {
    assert.ok(codes.includes(code), `${code} is listed`);
  }
  const blocked = await call('POST', `/payroll/${month}/people/${ids.payee}/submit`, { token: tokens.admin });
  assert.equal(blocked.status, 409);

  // the admin settles the open decisions and accepts the policy
  const policyId = (await call('GET', '/attendance/policy', { token: tokens.admin })).body.versions[0].id;
  await call('PATCH', `/attendance/policy/${policyId}`, { token: tokens.admin, body: { config: { breaksConfirmed: true, payroll: { methodConfirmed: true } } } });
  assert.equal((await call('POST', `/attendance/policy/${policyId}/accept`, { token: tokens.admin })).status, 200);
  const salary = await call('POST', `/payroll/salary/${ids.payee}`, { token: tokens.admin, body: { effective_from: '2025-01-01', attendance_sensitive: 30000, fixed_components: 2000 } });
  assert.equal(salary.status, 201, JSON.stringify(salary.body));

  view = await call('GET', `/payroll/${month}/people/${ids.payee}`, { token: tokens.admin });
  assert.equal(view.body.status, 'PROVISIONAL');
  const blockerCodes = view.body.blockers.map((b) => b.code);
  assert.ok(blockerCodes.includes('UNRECORDED'), 'the day with no record waits for review');
  assert.ok(blockerCodes.includes('EXTRA_PENDING'), 'extra time waits for review');
  assert.equal(view.body.days.find((d) => d.date === missingDay).classification, 'UNRECORDED_NEEDS_REVIEW', 'never assumed absent');

  // the reviewer decides: the payee reports to the lead, so the lead may; a manager of another team may not
  const other = await call('POST', '/attendance/reviews/extra', { token: tokens.manager, body: { user_id: ids.payee, work_date: extraDay, status: 'ELIGIBLE' } });
  assert.equal(other.status, 403);
  const own = await call('POST', '/attendance/reviews/extra', { token: tokens.lead, body: { user_id: ids.payee, work_date: extraDay, status: 'ELIGIBLE' } });
  assert.equal(own.status, 200, JSON.stringify(own.body));
});

test('payroll: the full closing cycle with a known answer', async (t) => {
  if (skip(t)) return;
  const first = firstOfPrevMonth();
  const last = lastOf(first);
  const month = first.slice(0, 7);
  const workdays = [];
  for (let d = first; d <= last; d = addDays(d, 1)) if (weekday(d) !== 0) workdays.push(d);
  const [lateDay, extraDay, missingDay] = workdays;

  const extra = await call('POST', '/attendance/reviews/extra', { token: tokens.admin, body: { user_id: ids.payee, work_date: extraDay, status: 'ELIGIBLE' } });
  assert.equal(extra.status, 200, JSON.stringify(extra.body));
  const absent = await call('POST', '/attendance/reviews/day', { token: tokens.admin, body: { user_id: ids.payee, work_date: missingDay, decision: 'UNAPPROVED_ABSENCE' } });
  assert.equal(absent.status, 400, 'a confirmed absence needs a note');
  await call('POST', '/attendance/reviews/day', { token: tokens.admin, body: { user_id: ids.payee, work_date: missingDay, decision: 'UNAPPROVED_ABSENCE', note: 'No contact all day; confirmed with the team' } });

  let view = await call('GET', `/payroll/${month}/people/${ids.payee}`, { token: tokens.admin });
  assert.equal(view.body.status, 'READY', JSON.stringify(view.body.blockers));
  const R = workdays.length * 9 * 3600;
  assert.equal(view.body.totals.required, R);
  // 30 minutes late (beyond grace) offset by 30 of the 45 eligible extra minutes
  assert.equal(view.body.totals.cross_day_offset, 30 * 60);
  assert.equal(view.body.totals.unused_extra, 15 * 60);
  assert.equal(view.body.allocations[0].source_date, extraDay);
  assert.equal(view.body.allocations[0].target_date, lateDay);
  // the confirmed absence is unpaid and extra time cannot buy it back
  assert.equal(view.body.totals.unpaid, 9 * 3600);
  const expected = Math.round(3_000_000 / workdays.length) / 100;
  assert.equal(view.body.salary.attendance_adjustment, expected);
  assert.equal(view.body.salary.attendance_adjusted_earnings, Math.round((30000 - expected) * 100) / 100);
  assert.equal(view.body.salary.fixed_components, 2000, 'fixed components are shown, not adjusted');

  // nobody approves their own pay
  await call('PUT', `/attendance/profiles/${ids.admin}`, { token: tokens.admin, body: { joining_date: '2025-01-01' } });
  const ownApprove = await call('POST', `/payroll/${month}/people/${ids.admin}/approve`, { token: tokens.admin });
  assert.equal(ownApprove.status, 403);

  const submit = await call('POST', `/payroll/${month}/people/${ids.payee}/submit`, { token: tokens.admin });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));

  // something changes underneath the submitted numbers
  await call('POST', '/attendance/reviews/extra', { token: tokens.admin, body: { user_id: ids.payee, work_date: extraDay, status: 'REJECTED', reason: 'Not pre-approved' } });
  const stale = await call('POST', `/payroll/${month}/people/${ids.payee}/approve`, { token: tokens.admin });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'CHANGED_SINCE_SUBMIT');
  await call('POST', '/attendance/reviews/extra', { token: tokens.admin, body: { user_id: ids.payee, work_date: extraDay, status: 'ELIGIBLE' } });

  const back = await call('POST', `/payroll/${month}/people/${ids.payee}/return`, { token: tokens.admin, body: { reason: 'Recheck extra time' } });
  assert.equal(back.status, 200);
  assert.equal((await call('POST', `/payroll/${month}/people/${ids.payee}/submit`, { token: tokens.admin })).status, 200);
  assert.equal((await call('POST', `/payroll/${month}/people/${ids.payee}/approve`, { token: tokens.admin })).status, 200);
  const lock = await call('POST', `/payroll/${month}/people/${ids.payee}/lock`, { token: tokens.admin });
  assert.equal(lock.status, 200, JSON.stringify(lock.body));

  // a locked month does not move
  const lateFix = await call('POST', '/attendance/reviews/extra', { token: tokens.admin, body: { user_id: ids.payee, work_date: extraDay, status: 'REJECTED', reason: 'Late change' } });
  assert.equal(lateFix.status, 409);
  const lateSalary = await call('POST', `/payroll/salary/${ids.payee}`, { token: tokens.admin, body: { effective_from: `${month}-15`, attendance_sensitive: 40000 } });
  assert.equal(lateSalary.status, 409);
  const policyId = (await call('GET', '/attendance/policy', { token: tokens.admin })).body.versions[0].id;
  const policyEdit = await call('PATCH', `/attendance/policy/${policyId}`, { token: tokens.admin, body: { config: { graceMinutes: 30 } } });
  assert.equal(policyEdit.status, 409, 'a policy a closed month used is not edited');
  const backdated = await call('POST', '/attendance/policy', { token: tokens.admin, body: { effective_from: first, config: { graceMinutes: 30 } } });
  assert.equal(backdated.status, 409);

  // the export: locked figures only, no coordinates, no leave reasons, formulas neutralised
  await query(`UPDATE users SET full_name = '=HYPERLINK("http://x")' WHERE id = $1`, [ids.payee]);
  const csv = await call('GET', `/payroll/${month}/export.csv`, { token: tokens.admin, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(!/latitude|longitude/i.test(csv.text));
  assert.ok(csv.text.includes(`"'=HYPERLINK(""http://x"")"`), 'the formula is shown as text');
  assert.ok(csv.text.includes(String(expected)));
  await query(`UPDATE users SET full_name = 'Pavan Kumar' WHERE id = $1`, [ids.payee]);
  const counted = await query(`SELECT export_count FROM payroll_results WHERE user_id = $1 AND status = 'LOCKED'`, [ids.payee]);
  assert.equal(counted.rows[0].export_count, 1);

  // reopening needs a reason and keeps the old version
  assert.equal((await call('POST', `/payroll/${month}/people/${ids.payee}/reopen`, { token: tokens.admin, body: {} })).status, 400);
  const reopen = await call('POST', `/payroll/${month}/people/${ids.payee}/reopen`, { token: tokens.admin, body: { reason: 'Salary revision agreed late' } });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.body.version, 2);
  const versions = await query('SELECT version, status FROM payroll_results WHERE user_id = $1 ORDER BY version', [ids.payee]);
  assert.deepEqual(versions.rows, [{ version: 1, status: 'SUPERSEDED' }, { version: 2, status: 'DRAFT' }]);

  const trail = await query(`SELECT action FROM attendance_audit WHERE entity_type = 'PAYROLL' AND subject_user_id = $1 ORDER BY id`, [ids.payee]);
  assert.deepEqual(trail.rows.map((r) => r.action), ['SUBMITTED', 'RETURNED', 'SUBMITTED', 'APPROVED', 'LOCKED', 'REOPENED']);
});

test('attendance CSV leaves out coordinates unless asked, and only for people the viewer may locate', async (t) => {
  if (skip(t)) return;
  await query(`UPDATE users SET full_name = '+cmd|calc' WHERE id = $1`, [ids.rahul]);
  const plain = await call('GET', `/attendance/export.csv?from=${today()}&to=${today()}`, { token: tokens.manager, raw: true });
  assert.equal(plain.status, 200);
  assert.ok(!/latitude/i.test(plain.text));
  assert.ok(plain.text.includes("'+cmd|calc"));
  const located = await call('GET', `/attendance/export.csv?from=${today()}&to=${today()}&include_location=1`, { token: tokens.manager, raw: true });
  assert.ok(/Check-in latitude/.test(located.text));
  assert.ok(located.text.includes('28.6139'));
  const own = await call('GET', `/attendance/export.csv?from=${today()}&to=${today()}`, { token: tokens.vartika, raw: true });
  assert.ok(!own.text.includes('cmd|calc'), 'a member exports only their own record');
  await query(`UPDATE users SET full_name = 'Rahul Mehta' WHERE id = $1`, [ids.rahul]);
});

test('csv cells: formulas are neutralised, numbers stay numbers', () => {
  assert.equal(csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell(-2.5), '-2.5');
  assert.equal(csvCell('Gupta, Vartika'), '"Gupta, Vartika"');
});
