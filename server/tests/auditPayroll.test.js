/**
 * November 2026 audit: attendance, leave and payroll against a database.
 *
 * Synthetic people and figures only — no real names, salaries, contact or
 * location data. The calendar (Monday–Saturday, 09:00–18:00, no break, no
 * holiday, Asia/Kolkata) is a test fixture, not a company policy, and the
 * policy is accepted here only inside this throwaway test schema.
 *
 * Acceptance tests from the fix prompt, by number:
 *   1  November 225:00 / October 243:00, 0:00 required on Sunday 1 November
 *   2  joining and exit dates decide who is in a month — not "active today"
 *   3  unknown joining date: unknown eligibility and a readiness blocker
 *   4  leave today and later is shown; pending/rejected/cancelled never as approved
 *   5  a missing check-out blocks the month; nothing is guessed
 *   9  list, detail and calculation agree; fixed components stay separate
 *   11 repeats change nothing; a locked snapshot ignores later edits
 *   12 a December policy does not reach November; the Asia/Kolkata boundary
 *   14 reads write nothing; the sweep is idempotent and uses each date's policy
 *   15 black marks and kudos do not touch attendance, leave or pay
 *   16 acceptance reset blocks approval with identical figures; races and retries
 *   B  the legacy-leave dry run writes nothing and proposes nothing automatic
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { pool, query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { checkIn, dateIn, settleMissingCheckouts } from '../src/services/attendance.js';
import { computePayroll, fingerprint, monthBounds, monthLedger } from '../src/services/attendanceLedger.js';
import { currentPolicy, latestPolicy, listPolicies } from '../src/services/attendancePolicy.js';
import { balance } from '../src/services/leave.js';
import { payrollExclusions, payrollPeople, payrollView, readiness, transition } from '../src/services/payroll.js';
import { recordBlackMark } from '../src/services/blackmarks.js';
import { legacyLeaveReport } from '../src/services/leaveReconciliation.js';

const TZ = 'Asia/Kolkata';
const H = 3600;
let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}/api/taskflow${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const skip = (t) => { if (!available) { t.skip('no database'); return true; } return false; };
const at = (date, time) => new Date(`${date}T${time}:00+05:30`);
const NOV_1_MIDDAY = at('2026-11-01', '12:00');

async function person(key, { joining = null, exit = null, active = true, role = 'member' } = {}) {
  const { rows } = await query(
    `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, is_active)
     VALUES ($1, $2, $3, $4, $5, FALSE, $6) RETURNING id`,
    [`Employee ${key}`, `audit-${key}@test.local`, ids.password, role, ids.dept, active],
  );
  ids[key] = rows[0].id;
  if (joining || exit) {
    await query('INSERT INTO employee_work_profiles (user_id, joining_date, exit_date) VALUES ($1, $2, $3)', [ids[key], joining, exit]);
  }
  return ids[key];
}

async function workedDay(userId, date, from = '09:00', to = '18:00') {
  await query(
    `INSERT INTO attendance_sessions (user_id, work_date, status, check_in_at, check_out_at, check_in_source, check_out_source)
     VALUES ($1, $2, 'COMPLETED', $3, $4, 'DEVICE_LOCATION', 'DEVICE_LOCATION')`,
    [userId, date, at(date, from), at(date, to)],
  );
}

/** A digest of the tables a read must never change. */
async function stateDigest() {
  const tables = ['attendance_sessions', 'attendance_audit', 'payroll_results', 'leave_requests', 'user_availability', 'notifications'];
  const out = {};
  for (const table of tables) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) AS h FROM ${table} t`);
    out[table] = `${rows[0].n}:${rows[0].h}`;
  }
  return out;
}

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('AUD', 'Audit fixture', '#2a78d6', 1)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE)`);
  ids.dept = (await query(`SELECT id FROM departments WHERE key = 'AUD'`)).rows[0].id;
  ids.password = await hashPassword('Password123!');

  await person('admin', { role: 'admin', joining: '2025-01-01' });
  await person('approver', { role: 'admin', joining: '2025-01-01' });
  // a fixture policy: tracking from 1 September 2026, every decision made — test schema only
  await listPolicies();
  await query(
    `UPDATE attendance_policies SET config = config || $1::jsonb, accepted_at = now(), accepted_by = $2`,
    [JSON.stringify({ startDate: '2026-09-01', breaksConfirmed: true, payroll: { method: 'SCHEDULED_HOURS', methodConfirmed: true, currency: 'INR', employeesSeeOwnEstimate: false } }), ids.admin],
  );
  ids.policy = (await listPolicies())[0].id;

  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of ['admin']) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `audit-${key}@test.local`, password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- 1

test('1: frozen at 1 November 2026 — November 225:00 for the whole month, 0:00 so far; October 243:00', async (t) => {
  if (skip(t)) return;
  const id = await person('steady', { joining: '2025-01-01' });
  const nov = await monthLedger(id, '2026-11', { now: NOV_1_MIDDAY });
  assert.equal(nov.totals.required, 225 * H);
  assert.equal(nov.totals.required_to_date, 0, 'Sunday 1 November is a weekly off');
  assert.equal(nov.days[0].classification, 'WEEKLY_OFF');
  assert.ok(nov.days.slice(1).filter((d) => d.R > 0).every((d) => d.classification === 'UPCOMING'));
  assert.equal(nov.totals.unpaid, 0, 'no future absence or deduction');
  assert.equal(nov.totals.unresolved, 0);

  const oct = await monthLedger(id, '2026-10', { now: NOV_1_MIDDAY });
  assert.equal(oct.totals.required, 243 * H);
  // with no attendance recorded, October is unrecorded and waiting for review — never assumed absent
  assert.ok(oct.days.filter((d) => d.R > 0).every((d) => d.classification === 'UNRECORDED_NEEDS_REVIEW'));
  assert.equal(oct.totals.non_offsettable_unpaid, 0);
});

// ---------------------------------------------------------------- 2

test('2: joining and exit dates decide the month — leavers stay, future joiners wait', async (t) => {
  if (skip(t)) return;
  await person('joinsNov10', { joining: '2026-11-10' });
  await person('leftNov12', { joining: '2025-01-01', exit: '2026-11-12', active: false });
  await person('leftOct', { joining: '2025-01-01', exit: '2026-10-20', active: false });
  await person('joinsDec', { joining: '2026-12-03' });

  const nov = await payrollPeople('2026-11');
  assert.ok(nov.includes(ids.joinsNov10));
  assert.ok(nov.includes(ids.leftNov12), 'deactivated, but employed for part of November');
  assert.ok(!nov.includes(ids.leftOct));
  assert.ok(!nov.includes(ids.joinsDec), 'joins later: not in November');
  const oct = await payrollPeople('2026-10');
  assert.ok(oct.includes(ids.leftOct), 'a deactivated account keeps the months it worked');

  const excluded = await payrollExclusions('2026-11');
  assert.equal(excluded.find((e) => e.id === ids.leftOct).reason, 'LEFT_EARLIER');
  assert.equal(excluded.find((e) => e.id === ids.joinsDec).reason, 'JOINS_LATER');

  const joiner = await monthLedger(ids.joinsNov10, '2026-11', { now: at('2026-12-02', '12:00') });
  const before10 = joiner.days.filter((d) => d.date < '2026-11-10');
  assert.ok(before10.every((d) => d.R === 0 && d.N === 0 && d.U === 0 && d.blockers.length === 0), 'no pre-joining absence');
  const leaver = await monthLedger(ids.leftNov12, '2026-11', { now: at('2026-12-02', '12:00') });
  const after12 = leaver.days.filter((d) => d.date > '2026-11-12');
  assert.ok(after12.every((d) => d.classification === 'NOT_EMPLOYED' && d.R === 0 && d.N === 0), 'no post-exit absence');
  const leaverPay = await computePayroll(ids.leftNov12, '2026-11', { now: at('2026-12-02', '12:00') });
  assert.ok(!leaverPay.setup.some((s) => s.code === 'EXIT_DATE'));
});

// ---------------------------------------------------------------- 3

test('3: no joining date — eligibility unknown, a setup exception, and a readiness blocker', async (t) => {
  if (skip(t)) return;
  const id = await person('noDates');
  const b = await balance(id, '2026-11');
  assert.equal(b.eligibility, 'UNKNOWN');
  assert.equal(b.buckets[0].allowance, null, 'no unconditional allowance');
  const pay = await computePayroll(id, '2026-11', { now: NOV_1_MIDDAY });
  assert.equal(pay.status, 'NEEDS_SETUP');
  assert.ok(pay.setup.some((s) => s.code === 'JOINING_DATE'));
  const r = await readiness('2026-11', { now: NOV_1_MIDDAY });
  const item = (key) => r.items.find((i) => i.key === key);
  assert.equal(item('EMPLOYMENT_DATES').state, 'ACTION');
  assert.ok(item('EMPLOYMENT_DATES').people.some((p) => p.id === id));
  assert.ok(item('LEAVE_ELIGIBILITY').people.some((p) => p.id === id));
  assert.equal(item('OPENING_BALANCES').state, 'NOT_TRACKED');
  assert.equal(item('HOLIDAYS').state, 'CONFIRM', 'no holidays recorded: confirmed by a person, not assumed');
  assert.equal(r.ready, false);
});

// ---------------------------------------------------------------- 4

test('4: approved leave today and later is shown; pending, rejected and cancelled never look approved', async (t) => {
  if (skip(t)) return;
  const id = await person('leaver4', { joining: '2025-01-01' });
  const leave = (start, status, paid = 1) => query(
    `INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status, day_allocation, paid_days, created_by)
     VALUES ($1, 'CASUAL', $2, $2, 'synthetic', $3, $4, $5, $1)`,
    [id, start, status, JSON.stringify([{ date: start, portion: 1, paid }]), paid],
  );
  await leave('2026-11-04', 'APPROVED_PAID');
  await leave('2026-11-06', 'APPROVED_PAID');
  await leave('2026-11-07', 'APPROVED_UNPAID', 0);
  await leave('2026-11-09', 'SUBMITTED', 0);
  await leave('2026-11-10', 'REJECTED', 0);
  await leave('2026-11-11', 'CANCELLED', 0);

  const now = at('2026-11-04', '11:00');
  const m = await monthLedger(id, '2026-11', { now });
  const day = (date) => m.days.find((d) => d.date === date);
  assert.equal(day('2026-11-04').classification, 'PAID_LEAVE', 'today: shown as leave, not "not checked in"');
  assert.equal(day('2026-11-06').classification, 'PLANNED_PAID_LEAVE');
  assert.equal(day('2026-11-06').L, 0, 'future leave is not accrued');
  assert.equal(day('2026-11-07').classification, 'PLANNED_UNPAID_LEAVE');
  assert.equal(day('2026-11-07').N, 0, 'and deducts nothing before it happens');
  assert.equal(day('2026-11-09').classification, 'UPCOMING');
  assert.ok(day('2026-11-09').flags.includes('LEAVE_PENDING'));
  for (const date of ['2026-11-10', '2026-11-11']) {
    assert.equal(day(date).classification, 'UPCOMING', `${date}: rejected/cancelled leave is no leave at all`);
    assert.ok(!day(date).flags.includes('LEAVE_PENDING'));
  }
});

// ---------------------------------------------------------------- 5 + 14

test('5 and 14: a missing check-out blocks the month without a guess; reads write nothing; the sweep runs once', async (t) => {
  if (skip(t)) return;
  const id = await person('forgot', { joining: '2025-01-01' });
  await query(
    `INSERT INTO attendance_sessions (user_id, work_date, status, check_in_at, check_in_source)
     VALUES ($1, '2026-10-05', 'OPEN', $2, 'DEVICE_LOCATION')`,
    [id, at('2026-10-05', '09:10')],
  );
  const token = (await call('POST', '/auth/login', { body: { email: 'audit-forgot@test.local', password: 'Password123!' } })).body.token;

  const before = await stateDigest();
  for (const path of ['/attendance/today', '/attendance/me?month=2026-10', '/attendance/team/month?month=2026-10', '/payroll/2026-10', `/payroll/2026-10/people/${id}`, '/payroll/2026-10/readiness', '/availability']) {
    const res = await call('GET', path, { token: path.startsWith('/attendance/today') || path.startsWith('/attendance/me') ? token : tokens.admin });
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  assert.deepEqual(await stateDigest(), before, 'GET requests changed nothing');

  const day = (await monthLedger(id, '2026-10')).days.find((d) => d.date === '2026-10-05');
  assert.equal(day.classification, 'MISSING_CHECKOUT');
  assert.equal(day.G, 10 * 60);
  assert.ok(day.C + day.L + day.G + day.N + day.U <= day.R);
  const pay = await computePayroll(id, '2026-10');
  assert.notEqual(pay.status, 'READY');
  assert.ok(pay.blockers.includes('MISSING_CHECKOUT'));
  await assert.rejects(transition({ id: ids.admin }, '2026-10', id, 'submit'), /cannot move on/);

  // the explicit sweep: once, audited with the policy that set the cutoff
  assert.equal((await settleMissingCheckouts(id)).settled, 1);
  assert.equal((await settleMissingCheckouts(id)).settled, 0);
  const { rows } = await query(`SELECT status, check_out_at FROM attendance_sessions WHERE user_id = $1`, [id]);
  assert.equal(rows[0].status, 'MISSING_CHECKOUT');
  assert.equal(rows[0].check_out_at, null);
  const audit = await query(`SELECT after FROM attendance_audit WHERE subject_user_id = $1 AND action = 'MARKED_MISSING_CHECKOUT'`, [id]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].after.policy_id, ids.policy);
});

// ---------------------------------------------------------------- 9 + 11 + 16

async function readyMonth(key) {
  // joined 28 September; worked all three working days; salary from 1 September with a fixed part
  const id = await person(key, { joining: '2026-09-28' });
  for (const d of ['2026-09-28', '2026-09-29', '2026-09-30']) await workedDay(id, d);
  await query(
    `INSERT INTO salary_basis (user_id, effective_from, attendance_sensitive, fixed_components, created_by)
     VALUES ($1, '2026-09-01', 30000, 2500, $2)`,
    [id, ids.admin],
  );
  return id;
}

test('9 and 11: list, detail and calculation agree; repeating a calculation changes nothing', async (t) => {
  if (skip(t)) return;
  const id = await readyMonth('agree');
  const a = await computePayroll(id, '2026-09');
  const b = await computePayroll(id, '2026-09');
  assert.equal(a.status, 'READY', JSON.stringify({ setup: a.setup, blockers: a.blockers }));
  assert.equal(fingerprint(a), fingerprint(b), 'same data, same answer');
  assert.equal(a.salary.fixed_components, 2500, 'fixed components shown apart, not adjusted');

  const list = await call('GET', '/payroll/2026-09', { token: tokens.admin });
  const detail = await call('GET', `/payroll/2026-09/people/${id}`, { token: tokens.admin });
  const row = list.body.people.find((p) => p.user.id === id);
  assert.equal(row.salary.attendance_adjusted_earnings, a.salary.attendance_adjusted_earnings);
  assert.equal(detail.body.salary.attendance_adjusted_earnings, a.salary.attendance_adjusted_earnings);
  assert.equal(row.totals.required, detail.body.totals.required);
  assert.ok(list.body.excluded.every((e) => e.id !== id));
});

test('16: a policy acceptance reset stops approval and locking even with identical figures', async (t) => {
  if (skip(t)) return;
  const id = await readyMonth('reset');
  const hr = { id: ids.admin };
  const approver = { id: ids.approver };
  const submitted = await transition(hr, '2026-09', id, 'submit');
  assert.equal(submitted.status, 'IN_REVIEW');
  const figures = fingerprint(await computePayroll(id, '2026-09'));

  await query('UPDATE attendance_policies SET accepted_at = NULL, accepted_by = NULL WHERE id = $1', [ids.policy]);
  assert.equal(fingerprint(await computePayroll(id, '2026-09')), figures, 'the numbers did not change');
  await assert.rejects(transition(approver, '2026-09', id, 'approve'), (err) => err.details?.code === 'NOT_READY');
  const { rows } = await query(`SELECT status FROM payroll_results WHERE user_id = $1 AND status <> 'SUPERSEDED'`, [id]);
  assert.equal(rows[0].status, 'IN_REVIEW', 'nothing moved');

  await query('UPDATE attendance_policies SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [ids.policy, ids.admin]);
  assert.equal((await transition(approver, '2026-09', id, 'approve')).status, 'APPROVED');

  // the same reset blocks locking too
  await query('UPDATE attendance_policies SET accepted_at = NULL, accepted_by = NULL WHERE id = $1', [ids.policy]);
  await assert.rejects(transition(approver, '2026-09', id, 'lock'), (err) => err.details?.code === 'NOT_READY');
  await query('UPDATE attendance_policies SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [ids.policy, ids.admin]);
});

test('16 and 11: racing approve/return/lock — one wins, none overwrites; retries do not repeat; locked stays locked', async (t) => {
  if (skip(t)) return;
  const id = await readyMonth('race');
  const hr = { id: ids.admin };
  const approver = { id: ids.approver };
  await transition(hr, '2026-09', id, 'submit');
  await transition(approver, '2026-09', id, 'approve');

  // lock and send back at the same moment, both looking at "approved v1"
  const expected = { status: 'APPROVED', version: 1 };
  const results = await Promise.allSettled([
    transition(approver, '2026-09', id, 'lock', { expected }),
    transition(hr, '2026-09', id, 'return', { reason: 'recheck', expected }),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.reason?.message || r.value)));
  assert.equal(lost[0].reason.details.code, 'STALE_STATE');
  const { rows: live } = await query(`SELECT status, version FROM payroll_results WHERE user_id = $1 AND status <> 'SUPERSEDED'`, [id]);
  assert.equal(live.length, 1);
  assert.equal(live[0].status, won[0].value.status);

  // drive it to locked, then retry the lock: answered, not repeated
  if (live[0].status === 'DRAFT') {
    await transition(hr, '2026-09', id, 'submit');
    await transition(approver, '2026-09', id, 'approve');
    await transition(approver, '2026-09', id, 'lock');
  }
  const auditBefore = (await query(`SELECT COUNT(*)::int AS n FROM attendance_audit WHERE entity_type = 'PAYROLL' AND subject_user_id = $1`, [id])).rows[0].n;
  const again = await transition(approver, '2026-09', id, 'lock', { expected: { status: 'APPROVED', version: 1 } });
  assert.equal(again.replayed, true);
  assert.equal(again.status, 'LOCKED');
  const auditAfter = (await query(`SELECT COUNT(*)::int AS n FROM attendance_audit WHERE entity_type = 'PAYROLL' AND subject_user_id = $1`, [id])).rows[0].n;
  assert.equal(auditAfter, auditBefore, 'a retry is not a second transition');
  // someone else repeating it is told the month moved on
  await assert.rejects(transition(hr, '2026-09', id, 'submit', { expected: { status: 'DRAFT', version: 1 } }), (err) => err.details?.code === 'STALE_STATE');

  // a locked snapshot ignores later edits
  const frozen = await payrollView('2026-09', id);
  await workedDay(id, '2026-09-27', '10:00', '12:00'); // a Sunday, added after locking
  await query(`UPDATE salary_basis SET note = 'edited later' WHERE user_id = $1`, [id]);
  const still = await payrollView('2026-09', id);
  assert.equal(still.frozen, true);
  assert.equal(still.fingerprint, frozen.fingerprint);
  assert.deepEqual(still.totals, frozen.totals);

  // reopening twice by the same person makes one new version, not two
  const reopened = await transition(approver, '2026-09', id, 'reopen', { reason: 'correction', expected: { status: 'LOCKED', version: 1 } });
  const repeat = await transition(approver, '2026-09', id, 'reopen', { reason: 'correction', expected: { status: 'LOCKED', version: 1 } });
  assert.equal(reopened.version, 2);
  assert.equal(repeat.replayed, true);
  const { rows: versions } = await query('SELECT version, status FROM payroll_results WHERE user_id = $1 ORDER BY version', [id]);
  assert.deepEqual(versions.map((v) => `${v.version}:${v.status}`), ['1:SUPERSEDED', '2:DRAFT']);
});

// ---------------------------------------------------------------- 15

test('15: black marks and kudos change nothing in attendance, leave or pay', async (t) => {
  if (skip(t)) return;
  const id = await readyMonth('conduct');
  const before = { pay: fingerprint(await computePayroll(id, '2026-09')), leave: await balance(id, '2026-09') };
  await recordBlackMark({ userId: id, points: 3, reason: 'synthetic: missed a deadline', source: 'manual', occurredAt: at('2026-09-29', '12:00'), occurrenceKey: `audit:${id}:1`, createdBy: ids.admin });
  await query('INSERT INTO kudos (from_user, to_user, message) VALUES ($1, $2, $3)', [ids.admin, id, 'synthetic: great work']);
  const after_ = { pay: fingerprint(await computePayroll(id, '2026-09')), leave: await balance(id, '2026-09') };
  assert.equal(after_.pay, before.pay, 'classification, totals and money unchanged');
  assert.deepEqual(after_.leave, before.leave);
});

// ---------------------------------------------------------------- B: dry run

test('B: the legacy-leave dry run reads only, and proposes nothing automatic', async (t) => {
  if (skip(t)) return;
  const id = await person('legacy', { joining: '2025-01-01' });
  await query(`INSERT INTO user_availability (user_id, status, start_date, end_date, created_by) VALUES ($1, 'ON_LEAVE', '2026-10-12', '2026-10-13', $1)`, [id]);
  await query(`INSERT INTO user_availability (user_id, status, start_date, end_date, created_by) VALUES ($1, 'UNAVAILABLE', '2026-10-20', '2026-10-20', $1)`, [id]);
  const before = await stateDigest();
  const client = await pool.connect();
  let report;
  try {
    await client.query('BEGIN READ ONLY');
    report = await legacyLeaveReport(client, { asOf: '2026-11-01T06:30:00Z' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.deepEqual(await stateDigest(), before);
  assert.equal(report.dry_run, true);
  assert.equal(report.writes, 0);
  const mine = report.legacy_calendar_leave.rows.filter((r) => r.user_id === id);
  assert.equal(mine.length, 1, 'only leave rows; "unavailable" is planning, not leave');
  assert.equal(mine[0].proposal, 'REVIEW_WITH_PERSON');
  assert.ok(!JSON.stringify(report).includes('Employee legacy'), 'ids, not names');
  for (const r of report.legacy_calendar_leave.rows) assert.ok(['COVERED_BY_APPROVED_REQUEST', 'WAIT_FOR_PENDING_REQUEST', 'REVIEW_WITH_PERSON'].includes(r.proposal));
});

// ---------------------------------------------------------------- 12 (last: it adds a December policy)

test('12: Asia/Kolkata day boundaries, year rollover and leap February', async (t) => {
  if (skip(t)) return;
  assert.equal(dateIn(TZ, new Date('2026-10-31T18:29:59.999Z')), '2026-10-31');
  assert.equal(dateIn(TZ, new Date('2026-10-31T18:30:00.000Z')), '2026-11-01');
  assert.equal(dateIn(TZ, new Date('2026-12-31T18:30:00.000Z')), '2027-01-01');
  assert.equal(monthBounds('2027-02').last, '2027-02-28');
  assert.equal(monthBounds('2028-02').last, '2028-02-29');
  const id = await person('boundary', { joining: '2025-01-01' });
  const feb = await monthLedger(id, '2028-02', { now: NOV_1_MIDDAY });
  assert.equal(feb.days.length, 29);
  assert.equal(feb.totals.required, 225 * H, 'leap February 2028: 25 working days');
  assert.equal(feb.totals.required_to_date, 0);

  // a check-in a millisecond before midnight in India belongs to that day; at midnight, to the next
  const loc = (now) => ({ latitude: 20.5, longitude: 78.9, accuracy: 30, timestamp: now.getTime(), age_ms: 500 });
  const user = { id, department_id: ids.dept };
  const late = new Date('2026-10-31T18:29:59.999Z');
  const first = await checkIn(user, { requestId: `audit-boundary-1-${id}-abcdef`, location: loc(late) }, late);
  assert.equal(first.session.work_date, '2026-10-31');
  await query(`UPDATE attendance_sessions SET status = 'COMPLETED', check_out_at = check_in_at + interval '1 minute' WHERE id = $1`, [first.session.id]);
  const midnight = new Date('2026-10-31T18:30:00.000Z');
  const second = await checkIn(user, { requestId: `audit-boundary-2-${id}-abcdef`, location: loc(midnight) }, midnight);
  assert.equal(second.session.work_date, '2026-11-01');
});

test('12: a December policy saved in November does not change November', async (t) => {
  if (skip(t)) return;
  const id = await person('policyDates', { joining: '2025-01-01' });
  const base = await currentPolicy(at('2026-11-15', '12:00'));
  const { rows } = await query(
    `INSERT INTO attendance_policies (effective_from, config, note, created_by)
     VALUES ('2026-12-01', $1, 'synthetic December change', $2) RETURNING id`,
    [JSON.stringify({ ...base.config, officeEnd: '17:00', missingCheckoutCutoff: '06:00' }), ids.admin],
  );
  const december = rows[0].id;

  assert.equal((await currentPolicy(at('2026-11-15', '12:00'))).id, base.id, 'in force in November: the November version');
  assert.equal((await currentPolicy(at('2026-11-30', '23:59'))).id, base.id);
  assert.equal((await currentPolicy(new Date('2026-11-30T18:30:00Z'))).id, december, 'from midnight 1 December in India');
  assert.equal((await latestPolicy()).id, december, 'Settings builds on the newest version');

  const nov = await monthLedger(id, '2026-11', { now: at('2026-11-15', '12:00') });
  assert.ok(nov.days.filter((d) => d.R > 0).every((d) => d.R === 9 * H && d.policy_id === base.id));
  const dec = await monthLedger(id, '2026-12', { now: at('2026-11-15', '12:00') });
  assert.ok(dec.days.filter((d) => d.R > 0).every((d) => d.R === 8 * H && d.policy_id === december));

  // the sweep judges a November session by November's cutoff (04:00), not December's (06:00)
  await query(
    `INSERT INTO attendance_sessions (user_id, work_date, status, check_in_at, check_in_source) VALUES ($1, '2026-11-20', 'OPEN', $2, 'DEVICE_LOCATION')`,
    [id, at('2026-11-20', '09:00')],
  );
  assert.equal((await settleMissingCheckouts(id, at('2026-11-21', '04:30'))).settled, 1);
  const { rows: audit } = await query(`SELECT after FROM attendance_audit WHERE subject_user_id = $1 AND action = 'MARKED_MISSING_CHECKOUT'`, [id]);
  assert.equal(audit[0].after.policy_id, base.id);
});
