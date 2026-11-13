/**
 * Monthly and ad hoc holidays, and their reconciliation with attendance,
 * black marks, standups and leave.
 *
 * Sandbox only: a throwaway schema, synthetic people, fixed dates in October
 * 2026 (a Monday-to-Saturday company, Sundays off; office 09:00–18:00, half
 * days split at 13:30). No real employee, record, mark, payslip or deadline is
 * touched. What is guarded:
 *
 *   - a regular workday, a Sunday and a personal schedule override
 *   - a change is proposed, not in force, until someone else approves it
 *   - full and half days, company / department / one person, ranges over a
 *     month boundary, amendments and cancellations, each with its history
 *   - a late-added holiday: the preview, attendance following the calendar,
 *     and stored records changed only by reviewed, reversible corrections
 *   - a holiday cancelled after its day: no automatic marks for it
 *   - approved leave is never unexplained missed work
 *   - duplicate runs record nothing twice; a waived mark stays waived
 *   - month boundaries in India time, and thresholds that change nothing
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { listPolicies, policyTimeline, policyOn } from '../src/services/attendancePolicy.js';
import { holidaysBetween, requiredSeconds, scheduleOn } from '../src/services/attendance.js';
import { buildLedgers } from '../src/services/attendanceLedger.js';
import { leaveDays } from '../src/services/leave.js';
import { monthlyReview, recordBlackMark, runBlackMarkScan } from '../src/services/blackmarks.js';
import { companyDay, eligibility } from '../src/services/standup.js';
import { runAttendanceScan } from '../src/jobs/attendanceScanner.js';
import { updateSetting } from '../src/services/settings.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
const users = {};
let seq = 0;

// October 2026
const MON5 = '2026-10-05';
const TUE6 = '2026-10-06';
const WED7 = '2026-10-07';
const THU8 = '2026-10-08';
const FRI9 = '2026-10-09';
const SAT10 = '2026-10-10';
const SUN11 = '2026-10-11';
const MON12 = '2026-10-12';
const TUE13 = '2026-10-13';
const at = (date, time) => new Date(`${date}T${time}:00+05:30`);

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
const hash = async (table, order = 't.id') => (await query(
  `SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY ${order}), '')) AS h FROM ${table} t`,
)).rows[0].h;
const STORED = ['attendance_sessions', 'attendance_day_reviews', 'black_marks', 'leave_requests', 'standup_reviews', 'payroll_results', 'tasks'];
const snapshot = async () => {
  const out = {};
  for (const table of STORED) out[table] = await hash(table, table === 'attendance_day_reviews' ? 't.user_id, t.work_date' : 't.id');
  return out;
};

async function task(assignee, due, { title = 'Synthetic task', done = null } = {}) {
  seq += 1;
  const { rows } = await query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, reporter_id, created_by, due_date, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8) RETURNING id, ref`,
    [`HOL-${seq}`, `${title} ${seq}`, ids.deptA, done ? ids.done : ids.todo, assignee, users.mgr.id, due, done],
  );
  return rows[0];
}
const marksFor = async (taskId) => (await query('SELECT * FROM black_marks WHERE task_id = $1 ORDER BY id', [taskId])).rows;

async function propose(token, body) {
  const res = await call('POST', '/attendance/holiday-requests', { token, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.request;
}
async function approve(token, id, note) {
  const res = await call('POST', `/attendance/holiday-requests/${id}/approve`, { token, body: note ? { note } : {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
async function scheduleFor(key, date) {
  const timeline = await policyTimeline();
  const { config: policy } = policyOn(timeline, date);
  const profile = (await query('SELECT * FROM employee_work_profiles WHERE user_id = $1', [users[key].id])).rows[0] || null;
  return scheduleOn(date, { config: policy, profile, holidays: await holidaysBetween(date, date), departmentId: users[key].department_id, userId: users[key].id });
}
async function day(key, date, now) {
  const ledgers = await buildLedgers([users[key].id], date, date, { now });
  return ledgers.get(users[key].id).days[0];
}

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('HDA', 'Synthetic field team', '#2a78d6', 1), ('HDB', 'Synthetic office', '#7a5af8', 2)`);
  await query(
    `INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES
      ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE), ('Done', 'done', 'done', '#22c55e', 2, FALSE)`,
  );
  ids.deptA = (await query(`SELECT id FROM departments WHERE key = 'HDA'`)).rows[0].id;
  ids.deptB = (await query(`SELECT id FROM departments WHERE key = 'HDB'`)).rows[0].id;
  ids.todo = (await query(`SELECT id FROM workflow_statuses WHERE stage = 'todo'`)).rows[0].id;
  ids.done = (await query(`SELECT id FROM workflow_statuses WHERE stage = 'done'`)).rows[0].id;
  const password = await hashPassword('Password123!');
  for (const [key, name, role, dept, extra] of [
    ['admin', 'Synthetic Admin', 'admin', 'deptB', []],
    ['admin2', 'Second Admin', 'admin', 'deptB', []],
    // HR can propose holiday changes, not approve them
    ['hr', 'Synthetic HR Desk', 'member', 'deptB', ['attendance.policy']],
    ['mgr', 'Synthetic Manager', 'manager', 'deptB', []],
    ['ana', 'Ana Sample', 'member', 'deptA', []],
    ['bo', 'Bo Sample', 'member', 'deptA', []],
    ['cy', 'Cy Sample', 'member', 'deptB', []],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password, extra_permissions)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6) RETURNING *`,
      [name, `${key}@holiday.test`, password, role, ids[dept], extra],
    );
    users[key] = rows[0];
  }
  for (const dept of [ids.deptA, ids.deptB]) {
    await query('INSERT INTO attendance_team_access (manager_id, department_id) VALUES ($1, $2)', [users.mgr.id, dept]);
  }
  // Cy works Monday to Friday: an individual schedule override
  await query(`INSERT INTO employee_work_profiles (user_id, joining_date, working_days) VALUES ($1, '2025-01-01', '{1,2,3,4,5}')`, [users.cy.id]);
  for (const key of ['ana', 'bo']) await query(`INSERT INTO employee_work_profiles (user_id, joining_date) VALUES ($1, '2025-01-01')`, [users[key].id]);
  // attendance counted from September: days with no record are owed and reviewed
  await listPolicies();
  await query(`UPDATE attendance_policies SET config = config || '{"startDate": "2026-09-01"}'::jsonb`);
  await query(
    `INSERT INTO blackmark_rules (name, trigger_type, points, grace_hours, is_active) VALUES
      ('Missed deadline', 'deadline_missed', 1, 0, TRUE),
      ('Finished late', 'completed_late', 1, 0, TRUE)`,
  );
  await updateSetting('blackmarks', { warningPoints: 2, criticalPoints: 3, missedDeadlineLimit: 5, rollingWindowMonths: 1, notifyMember: false });

  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
  for (const key of Object.keys(users)) {
    tokens[key] = (await call('POST', '/auth/login', { body: { email: `${key}@holiday.test`, password: 'Password123!' } })).body.token;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- ordinary days

test('a regular workday is owed in full; a Sunday and a personal day off are not', async (t) => {
  if (skip(t)) return;
  const monday = await scheduleFor('ana', MON5);
  assert.equal(monday.state, 'WORKDAY');
  assert.equal(requiredSeconds(monday), 9 * 3600);
  assert.equal((await scheduleFor('ana', SUN11)).state, 'WEEKLY_OFF');
  // Cy's own schedule has no Saturday
  assert.equal((await scheduleFor('ana', SAT10)).state, 'WORKDAY');
  assert.equal((await scheduleFor('cy', SAT10)).state, 'WEEKLY_OFF');

  // a working day nobody recorded waits for a reviewer; it is not an absence
  const missing = await day('ana', MON5, at(MON12, '12:00'));
  assert.equal(missing.R, 9 * 3600);
  assert.ok(missing.blockers.includes('UNRECORDED'));
  assert.equal(missing.N, 0, 'not unpaid until a reviewer decides');
  const sunday = await day('ana', SUN11, at(MON12, '12:00'));
  assert.equal(sunday.R, 0);
  assert.deepEqual(sunday.blockers, []);
});

test('a deadline on a Sunday is in force on the next working day, with the evidence kept', async (t) => {
  if (skip(t)) return;
  const sunday = await task(users.ana.id, at(SUN11, '18:00'), { title: 'Due on a Sunday' });
  const monday = await task(users.ana.id, at(MON5, '18:00'), { title: 'Due on a Monday' });

  await runBlackMarkScan({ now: at(MON5, '18:30') });
  const [mark] = await marksFor(monday.id);
  assert.ok(mark, 'a workday deadline missed is marked');
  assert.equal(mark.evidence.effective_due, at(MON5, '18:00').toISOString());
  assert.deepEqual(mark.evidence.shifted_past, []);
  assert.equal(mark.evidence.rule.name, 'Missed deadline');
  assert.ok(mark.evidence.attendance_policy_id, 'the policy version used is recorded');
  assert.equal(mark.period_month, '2026-10-01');

  await runBlackMarkScan({ now: at(MON12, '12:00') });
  assert.equal((await marksFor(sunday.id)).length, 0, 'Monday 18:00 has not passed yet');
  await runBlackMarkScan({ now: at(MON12, '18:30') });
  const [late] = await marksFor(sunday.id);
  assert.ok(late);
  assert.equal(late.evidence.effective_due, at(MON12, '18:00').toISOString());
  assert.equal(late.evidence.shifted_past[0].code, 'WEEKLY_OFF');
  assert.equal(new Date(late.occurred_at).toISOString(), at(MON12, '18:00').toISOString());
  // the task's own deadline is never moved
  const { rows } = await query('SELECT due_date FROM tasks WHERE id = $1', [sunday.id]);
  assert.equal(new Date(rows[0].due_date).toISOString(), at(SUN11, '18:00').toISOString());
});

// ---------------------------------------------------------------- proposing and approving

test('a proposed holiday is not in force until someone else approves it, and is then published', async (t) => {
  if (skip(t)) return;
  const request = await propose(tokens.hr, {
    action: 'ADD', name: 'Synthetic festival', start_date: THU8, end_date: THU8, reason: 'Announced by the owner this month',
  });
  assert.equal(request.status, 'PROPOSED');
  assert.equal((await scheduleFor('ana', THU8)).state, 'WORKDAY', 'not in force while proposed');

  // HR may propose but not approve; nobody approves their own change without being an admin
  assert.equal((await call('POST', `/attendance/holiday-requests/${request.id}/approve`, { token: tokens.hr, body: {} })).status, 403);
  assert.equal((await call('POST', '/attendance/holiday-requests', { token: tokens.ana, body: { action: 'ADD', name: 'x', start_date: THU8, reason: 'nope' } })).status, 403);

  const detail = await call('GET', `/attendance/holiday-requests/${request.id}`, { token: tokens.admin });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.impact_is_live, true);
  assert.ok(detail.body.impact.people >= 5);

  const decided = await approve(tokens.admin, request.id);
  assert.equal(decided.request.status, 'APPROVED');
  assert.equal(decided.request.self_approved, false);
  assert.equal(decided.created.length, 1);
  const entry = decided.created[0];
  assert.equal(entry.approved_by, users.admin.id);
  assert.ok(entry.published_at, 'the effective date is published');
  assert.equal((await scheduleFor('ana', THU8)).state, 'HOLIDAY');
  assert.equal((await scheduleFor('cy', THU8)).state, 'HOLIDAY');

  // everyone it covers is told, once
  const { rows: told } = await query(`SELECT user_id, title, body FROM notifications WHERE type = 'holiday' AND title LIKE '%Synthetic festival%'`);
  assert.equal(new Set(told.map((n) => n.user_id)).size, told.length);
  assert.ok(told.some((n) => n.user_id === users.ana.id));
  assert.match(told[0].title, /Thu, 8 Oct 2026 \(full day\)/);
  assert.match(told[0].body, /Synthetic Admin/);

  // a decided request cannot be decided again
  assert.equal((await call('POST', `/attendance/holiday-requests/${request.id}/approve`, { token: tokens.admin, body: {} })).status, 409);
  // the same date for the same people cannot be added twice
  const twice = await call('POST', '/attendance/holiday-requests', { token: tokens.hr, body: { action: 'ADD', name: 'Again', start_date: THU8, reason: 'duplicate' } });
  assert.equal(twice.status, 409);

  // history: who proposed, who approved, and the audit trail
  const history = await call('GET', `/attendance/holidays/${entry.id}/history`, { token: tokens.hr });
  assert.equal(history.status, 200);
  assert.equal(history.body.requests[0].proposed_by_name, 'Synthetic HR Desk');
  assert.equal(history.body.requests[0].decided_by_name, 'Synthetic Admin');
  assert.ok(history.body.audit.some((a) => a.action === 'APPROVED'));
});

test('an administrator approving their own change has to say why', async (t) => {
  if (skip(t)) return;
  const own = await propose(tokens.admin, {
    action: 'ADD', name: 'Synthetic owner day', start_date: '2026-09-15', end_date: '2026-09-15', scope: 'PERSON', user_id: users.ana.id,
    reason: 'Granted for working the festival weekend',
  });
  const bare = await call('POST', `/attendance/holiday-requests/${own.id}/approve`, { token: tokens.admin, body: {} });
  assert.equal(bare.status, 400);
  const noted = await approve(tokens.admin, own.id, 'Only administrator on duty this week');
  assert.equal(noted.request.self_approved, true);
  assert.equal((await scheduleFor('ana', '2026-09-15')).state, 'HOLIDAY', 'a personal holiday covers that person');
  assert.equal((await scheduleFor('bo', '2026-09-15')).state, 'WORKDAY', 'and nobody else');
});

// ---------------------------------------------------------------- half days

test('a half-day holiday shortens the required hours, moves the reminder and covers the standup', async (t) => {
  if (skip(t)) return;
  // Bo has the morning of Wednesday off, on his own
  const morning = await propose(tokens.hr, {
    action: 'ADD', name: 'Synthetic personal morning', start_date: WED7, coverage: 'FIRST_HALF', scope: 'PERSON', user_id: users.bo.id,
    reason: 'Ad hoc, agreed with the owner',
  });
  await approve(tokens.admin, morning.id);
  const bo = await scheduleFor('bo', WED7);
  assert.equal(bo.state, 'WORKDAY');
  assert.equal(bo.holidayHalf, 'FIRST_HALF');
  assert.equal(requiredSeconds(bo), 4.5 * 3600, '13:30 to 18:00');
  assert.equal(requiredSeconds(await scheduleFor('ana', WED7)), 9 * 3600, 'Ana works the whole day');

  // full-day leave on that date only counts the working half
  const { days } = await leaveDays(users.bo.id, users.bo.department_id, WED7, WED7, 'FULL');
  assert.deepEqual(days, [{ date: WED7, portion: 0.5 }]);
  const firstHalf = await leaveDays(users.bo.id, users.bo.department_id, WED7, WED7, 'FIRST_HALF');
  assert.deepEqual(firstHalf.days, [], 'the morning is already a holiday');

  // the check-in reminder follows each person's own start
  await runAttendanceScan(at(WED7, '10:00'));
  const reminded = async (key) => (await query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'attendance_reminder' AND title LIKE $2`,
    [users[key].id, `%${WED7}%`],
  )).rows[0].n;
  assert.equal(await reminded('ana'), 1);
  assert.equal(await reminded('bo'), 0, 'his day starts at 13:30');
  await runAttendanceScan(at(WED7, '14:05'));
  await runAttendanceScan(at(WED7, '14:10'));
  assert.equal(await reminded('bo'), 1, 'once, after his start');

  // the standup: a department morning off excuses its members; a company
  // afternoon off leaves the morning standup in place
  const dept = await propose(tokens.hr, {
    action: 'ADD', name: 'Synthetic team morning', start_date: TUE13, coverage: 'FIRST_HALF', scope: 'DEPARTMENT', department_id: ids.deptA,
    reason: 'Team outing',
  });
  await approve(tokens.admin, dept.id);
  const afternoon = await propose(tokens.hr, {
    action: 'ADD', name: 'Synthetic company afternoon', start_date: TUE13, coverage: 'SECOND_HALF', reason: 'Early close',
  });
  await approve(tokens.admin, afternoon.id);
  for (const key of ['ana', 'cy']) {
    await query(`INSERT INTO standup_members (user_id, full_name, identity_status) VALUES ($1, $2, 'VERIFIED')`, [users[key].id, users[key].full_name]);
  }
  assert.deepEqual(await companyDay(TUE13), { working: true });
  const who = await eligibility(TUE13);
  // Ana's team has the morning off (and with the company afternoon, the whole day)
  assert.ok(who.exempt.some((e) => e.member.user_id === users.ana.id && /HOLIDAY: Synthetic team morning/.test(e.reason)));
  assert.ok(who.expected.some((m) => m.user_id === users.cy.id));

  // both halves for the same person make a full day
  const both = await scheduleFor('ana', TUE13);
  assert.equal(both.state, 'HOLIDAY');
});

// ---------------------------------------------------------------- late-added

test('a holiday added after the day: preview first, attendance follows, stored records only by review', async (t) => {
  if (skip(t)) return;
  // Friday the 9th as it happened: Ana missed a deadline (she finished it on
  // Saturday morning) and her standup, Bo was on approved paid leave, Cy was
  // confirmed absent by a reviewer
  const due = await task(users.ana.id, at(FRI9, '17:00'), { title: 'Friday report' });
  await runBlackMarkScan({ now: at(FRI9, '18:00') });
  await query('UPDATE tasks SET status_id = $2, completed_at = $3 WHERE id = $1', [due.id, ids.done, at(SAT10, '10:00')]);
  await runBlackMarkScan({ now: at(SAT10, '12:00') });
  const [mark, lateMark] = await marksFor(due.id);
  assert.equal(mark.status, 'active');
  assert.equal(lateMark.reason, `Completed ${due.ref} after the deadline`);
  // a task still not done by the next working day keeps its mark: the holiday
  // only moves the deadline in force by a day
  const stillOpen = await task(users.bo.id, at(FRI9, '12:00'), { title: 'Never finished' });
  await runBlackMarkScan({ now: at(FRI9, '13:00') });
  assert.equal((await marksFor(stillOpen.id)).length, 1);
  const { rows: [leave] } = await query(
    `INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status, day_allocation, paid_days, created_by)
     VALUES ($1, 'CASUAL', $2, $2, 'synthetic', 'APPROVED_PAID', $3, 1, $1) RETURNING *`,
    [users.bo.id, FRI9, JSON.stringify([{ date: FRI9, portion: 1, paid: 1 }])],
  );
  await query(`INSERT INTO attendance_day_reviews (user_id, work_date, decision, note, reviewer_id) VALUES ($1, $2, 'UNAPPROVED_ABSENCE', 'synthetic', $3)`, [users.cy.id, FRI9, users.mgr.id]);
  const { rows: [member] } = await query('SELECT id FROM standup_members WHERE user_id = $1', [users.ana.id]);
  const { rows: [review] } = await query(`INSERT INTO standup_reviews (work_date, member_id, status) VALUES ($1, $2, 'MISSING') RETURNING *`, [FRI9, member.id]);
  const before = await snapshot();
  const anaBefore = await day('ana', FRI9, at(MON12, '12:00'));
  assert.ok(anaBefore.blockers.includes('UNRECORDED'));

  const request = await propose(tokens.hr, {
    action: 'ADD', kind: 'CLOSURE', name: 'Synthetic power cut', start_date: FRI9, reason: 'Office closed by the landlord without notice',
  });

  // the preview, read only
  const preview = await call('GET', `/attendance/holiday-requests/${request.id}`, { token: tokens.admin });
  assert.equal(preview.status, 200);
  const impact = preview.body.impact;
  assert.equal(impact.late, true);
  assert.equal(impact.summary.marks_to_waive, 2, 'both of Ana\'s marks; finished before Saturday 17:00');
  assert.ok(!impact.marks.some((m) => m.task_id === stillOpen.id), 'Bo\'s task stayed late after the moved deadline too');
  assert.equal(impact.summary.standup_to_excuse, 1);
  assert.equal(impact.summary.leave_days_to_release, 1);
  assert.ok(impact.attendance.changes.some((c) => c.user_id === users.ana.id && c.before.blockers.includes('UNRECORDED') && c.after.state === 'HOLIDAY'));
  assert.equal(impact.attendance.absences_lifted, 1, 'Cy\'s confirmed absence no longer counts');
  assert.deepEqual(await snapshot(), before, 'previewing changes nothing');

  const decided = await approve(tokens.admin, request.id);
  assert.equal(decided.corrections.length, 4);
  assert.ok(decided.corrections.every((c) => c.status === 'PROPOSED'));
  assert.deepEqual(await snapshot(), before, 'approving changes no stored record: every one waits for review');
  // attendance is worked out from the calendar, so it follows at once — the
  // check-in record and the reviewer's decision are kept as they were
  const anaAfter = await day('ana', FRI9, at(MON12, '12:00'));
  assert.equal(anaAfter.schedule_state, 'HOLIDAY');
  assert.deepEqual(anaAfter.holiday_ids, decided.created.map((c) => c.id), 'linked to the calendar entry');
  assert.equal((await day('cy', FRI9, at(MON12, '12:00'))).N, 0);

  const correction = (kind) => decided.corrections.find((c) => c.kind === kind && (kind !== 'MARK_WAIVE' || c.target_id === mark.id));
  // the manager's queue lists what they may decide; someone without a reviewer permission sees none of it
  const queue = await call('GET', '/attendance/holiday-corrections?status=PROPOSED', { token: tokens.mgr });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.corrections.filter((c) => c.request_id === request.id).length, 4);
  assert.equal((await call('GET', '/attendance/holiday-corrections', { token: tokens.ana })).status, 403);
  // each correction needs the permission for the record it touches
  assert.equal((await call('POST', `/attendance/holiday-corrections/${correction('MARK_WAIVE').id}/apply`, { token: tokens.hr, body: {} })).status, 403);
  const waived = await call('POST', `/attendance/holiday-corrections/${correction('MARK_WAIVE').id}/apply`, { token: tokens.mgr, body: { note: 'Closure confirmed' } });
  assert.equal(waived.status, 200, JSON.stringify(waived.body));
  assert.equal(waived.body.correction.status, 'APPLIED');
  const [after, lateStill] = await marksFor(due.id);
  assert.equal(after.status, 'waived');
  assert.equal(lateStill.status, 'active', 'the other proposal is not applied by this one');
  assert.equal(after.waived_by, users.mgr.id);
  assert.match(after.waived_reason, new RegExp(`Holiday correction #${correction('MARK_WAIVE').id}`));
  // applying twice does nothing more
  assert.equal((await call('POST', `/attendance/holiday-corrections/${correction('MARK_WAIVE').id}/apply`, { token: tokens.mgr, body: {} })).status, 409);

  const excused = await call('POST', `/attendance/holiday-corrections/${correction('STANDUP_EXCUSE').id}/apply`, { token: tokens.mgr, body: {} });
  assert.equal(excused.status, 200, JSON.stringify(excused.body));
  const { rows: [reviewNow] } = await query('SELECT * FROM standup_reviews WHERE id = $1', [review.id]);
  assert.equal(reviewNow.status, 'MISSING', 'what was recorded stays recorded');
  assert.equal(reviewNow.resolution, 'EXCUSED');

  const released = await call('POST', `/attendance/holiday-corrections/${correction('LEAVE_DAY_RELEASE').id}/apply`, { token: tokens.mgr, body: {} });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const { rows: [leaveNow] } = await query('SELECT day_allocation, paid_days FROM leave_requests WHERE id = $1', [leave.id]);
  assert.deepEqual(leaveNow.day_allocation, []);
  assert.equal(Number(leaveNow.paid_days), 0, 'the paid day goes back to the allowance');

  // reversing puts the record back exactly
  const reversed = await call('POST', `/attendance/holiday-corrections/${correction('LEAVE_DAY_RELEASE').id}/reverse`, { token: tokens.mgr, body: { reason: 'Bo was travelling anyway; HR to decide' } });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
  assert.equal(reversed.body.correction.status, 'REVERSED');
  const { rows: [leaveBack] } = await query('SELECT day_allocation, paid_days FROM leave_requests WHERE id = $1', [leave.id]);
  assert.deepEqual(leaveBack.day_allocation, [{ date: FRI9, portion: 1, paid: 1 }]);
  assert.equal(Number(leaveBack.paid_days), 1);

  // the mark's own history links back to the source event and the correction
  const history = await call('GET', `/blackmarks/${mark.id}/history`, { token: tokens.mgr });
  assert.equal(history.status, 200);
  assert.equal(history.body.evidence.task_ref, due.ref);
  assert.equal(history.body.corrections[0].request_id, request.id);
  assert.equal(history.body.corrections[0].holiday_name, 'Synthetic power cut');
  assert.ok(history.body.audit.some((a) => a.action === 'WAIVED' && a.source === `holiday_correction:${correction('MARK_WAIVE').id}`));

  // a rerun of the scan does not bring the mark back or add another
  await runBlackMarkScan({ now: at(MON12, '12:00') });
  const again = await marksFor(due.id);
  assert.equal(again.length, 2);
  assert.equal(again[0].status, 'waived');

  // the request keeps the impact the approver saw
  const stored = await call('GET', `/attendance/holiday-requests/${request.id}`, { token: tokens.hr });
  assert.equal(stored.body.impact_is_live, false);
  assert.equal(stored.body.impact.summary.marks_to_waive, 2);
});

// ---------------------------------------------------------------- cancelled

test('a holiday cancelled after its day: no automatic marks, and earlier corrections offered back', async (t) => {
  if (skip(t)) return;
  // Tuesday the 6th is a department holiday for Ana's team; she finishes the
  // Tuesday work on Wednesday morning, which the holiday made on time
  const tuesday = await propose(tokens.hr, {
    action: 'ADD', name: 'Synthetic team day', start_date: TUE6, scope: 'DEPARTMENT', department_id: ids.deptA, reason: 'Team holiday',
  });
  const added = await approve(tokens.admin, tuesday.id);
  const work = await task(users.ana.id, at(TUE6, '16:00'), { title: 'Tuesday work', done: at(WED7, '10:00') });
  await runBlackMarkScan({ now: at(WED7, '12:00') });
  assert.equal((await marksFor(work.id)).length, 0, 'finished before the deadline in force');

  const cancel = await propose(tokens.hr, { action: 'CANCEL', target_ids: added.created.map((c) => c.id), reason: 'Entered for the wrong team' });
  const preview = (await call('GET', `/attendance/holiday-requests/${cancel.id}`, { token: tokens.admin })).body.impact;
  const create = preview.marks.find((m) => m.kind === 'MARK_CREATE' && m.task_id === work.id);
  assert.ok(create, 'the late finish is offered as a mark for someone to decide');
  assert.equal(create.trigger, 'completed_late');
  const cancelled = await approve(tokens.admin2, cancel.id);
  assert.equal(cancelled.cancelled[0].status, 'CANCELLED');
  assert.equal(cancelled.cancelled[0].cancel_reason, 'Entered for the wrong team');
  assert.equal((await scheduleFor('ana', TUE6)).state, 'WORKDAY');

  // the scan does not record it on its own, however often it runs
  await runBlackMarkScan({ now: at(MON12, '12:00') });
  await runBlackMarkScan();
  assert.equal((await marksFor(work.id)).length, 0);

  const proposal = cancelled.corrections.find((c) => c.kind === 'MARK_CREATE' && c.target_id === work.id);
  const applied = await call('POST', `/attendance/holiday-corrections/${proposal.id}/apply`, { token: tokens.mgr, body: { note: 'Agreed with Ana' } });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const [created] = await marksFor(work.id);
  assert.equal(created.status, 'active');
  assert.equal(created.evidence.recorded_by_correction, proposal.id);
  const undone = await call('POST', `/attendance/holiday-corrections/${proposal.id}/reverse`, { token: tokens.mgr, body: { reason: 'Changed my mind after talking to HR' } });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal((await marksFor(work.id))[0].status, 'waived');

  // cancelling the Friday closure offers back what its corrections did
  const { rows: [closure] } = await query(`SELECT id FROM work_holidays WHERE name = 'Synthetic power cut' AND status = 'APPROVED'`);
  const reopen = await propose(tokens.hr, { action: 'CANCEL', target_ids: [closure.id], reason: 'The landlord says the office was open' });
  const back = await approve(tokens.admin, reopen.id);
  const kinds = back.corrections.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['MARK_RESTORE', 'STANDUP_UNEXCUSE']);
  // the closure's proposal nobody applied relied on it, so it is no longer offered
  const { rows: leftover } = await query(
    `SELECT c.status, c.decision_note FROM holiday_corrections c JOIN holiday_requests r ON r.id = c.request_id
      WHERE r.name = 'Synthetic power cut' AND r.action = 'ADD' AND c.kind = 'MARK_WAIVE' AND c.status <> 'APPLIED'`,
  );
  assert.equal(leftover.length, 1);
  assert.equal(leftover[0].status, 'STALE');
  assert.match(leftover[0].decision_note, new RegExp(`request #${reopen.id}`));
  // the leave release was already reversed, so there is no leave to restore
  assert.equal(back.summary.leave_days_to_restore, 0);
  // the entry stays on record as cancelled, with both requests in its history
  const history = await call('GET', `/attendance/holidays/${closure.id}/history`, { token: tokens.admin });
  assert.equal(history.body.entry.status, 'CANCELLED');
  assert.equal(history.body.requests.length, 2);
});

test('an amendment replaces dates across a month boundary and keeps the old ones on record', async (t) => {
  if (skip(t)) return;
  const range = await propose(tokens.hr, {
    action: 'ADD', name: 'Synthetic month-end break', start_date: '2026-09-30', end_date: '2026-10-01', scope: 'DEPARTMENT',
    department_id: ids.deptB, reason: 'Two days over the month end',
  });
  const added = await approve(tokens.admin, range.id);
  assert.equal(added.created.length, 2);
  assert.equal(added.created[0].series_id, added.created[1].series_id, 'one range, one series');
  const oct1 = added.created.find((c) => c.holiday_date === '2026-10-01');
  const amend = await propose(tokens.hr, {
    action: 'AMEND', target_ids: [oct1.id], start_date: '2026-10-01', coverage: 'SECOND_HALF', reason: 'Only the afternoon after all',
  });
  const amended = await approve(tokens.admin, amend.id);
  assert.equal(amended.cancelled[0].id, oct1.id);
  assert.equal(amended.created[0].coverage, 'SECOND_HALF');
  assert.equal(amended.created[0].name, 'Synthetic month-end break', 'unchanged fields carry over');
  assert.equal((await scheduleFor('cy', '2026-09-30')).state, 'HOLIDAY');
  const thursday = await scheduleFor('cy', '2026-10-01');
  assert.equal(thursday.holidayHalf, 'SECOND_HALF');
  assert.equal(requiredSeconds(thursday), 4.5 * 3600);

  // the managed view lists all three entries; only two are in force
  const view = await call('GET', '/attendance/holidays/manage?from=2026-09-30&to=2026-10-01', { token: tokens.hr });
  const mine = view.body.entries.filter((e) => e.name === 'Synthetic month-end break');
  assert.equal(mine.length, 3);
  assert.equal(mine.filter((e) => e.status === 'APPROVED').length, 2);
  const published = await call('GET', '/attendance/holidays?year=2026', { token: tokens.ana });
  assert.equal(published.body.holidays.filter((h) => h.name === 'Synthetic month-end break').length, 2);
});

// ---------------------------------------------------------------- leave

test('approved leave is not unexplained missed work; leave approved later is listed for a recheck', async (t) => {
  if (skip(t)) return;
  await query(
    `INSERT INTO leave_requests (user_id, category, start_date, end_date, reason, status, day_allocation, paid_days, created_by)
     VALUES ($1, 'SICK', $2, $2, 'synthetic', 'APPROVED_PAID', $3, 1, $1)`,
    [users.cy.id, MON12, JSON.stringify([{ date: MON12, portion: 1, paid: 1 }])],
  );
  const onLeave = await task(users.cy.id, at(MON12, '15:00'), { title: 'Due during leave' });
  await runBlackMarkScan({ now: at(MON12, '18:00') });
  assert.equal((await marksFor(onLeave.id)).length, 0);
  // Tuesday afternoon is a company half holiday, so 15:00 moves on to Wednesday
  await runBlackMarkScan({ now: at(TUE13, '16:00') });
  assert.equal((await marksFor(onLeave.id)).length, 0);
  await runBlackMarkScan({ now: at('2026-10-14', '16:00') });
  const [mark] = await marksFor(onLeave.id);
  assert.ok(mark, 'still not done on the next working time');
  assert.deepEqual(mark.evidence.shifted_past.map((s) => s.code), ['LEAVE', 'HOLIDAY_HALF']);

  // a mark recorded before leave was approved for that day is listed, not changed
  const earlier = await task(users.bo.id, at('2026-10-02', '12:00'), { title: 'Before late leave' });
  await runBlackMarkScan({ now: at('2026-10-02', '13:00') });
  const [recorded] = await marksFor(earlier.id);
  // finished the next morning
  await query('UPDATE tasks SET status_id = $2, completed_at = $3 WHERE id = $1', [earlier.id, ids.done, at('2026-10-03', '10:00')]);
  await query(
    `INSERT INTO leave_requests (user_id, category, start_date, end_date, day_part, reason, status, day_allocation, paid_days, created_by)
     VALUES ($1, 'SICK', '2026-10-02', '2026-10-02', 'FIRST_HALF', 'synthetic', 'APPROVED_PAID', $2, 0.5, $1)`,
    [users.bo.id, JSON.stringify([{ date: '2026-10-02', portion: 0.5, paid: 0.5 }])],
  );
  const recheck = await call('GET', '/blackmarks/recheck', { token: tokens.mgr });
  assert.equal(recheck.status, 200);
  const listed = recheck.body.marks.find((m) => m.mark_id === recorded.id);
  assert.ok(listed, 'the morning was on leave, so the 12:00 deadline moved to Saturday, and it was done by then');
  assert.equal(listed.because[0].code, 'LEAVE_HALF');
  assert.equal((await marksFor(earlier.id))[0].status, 'active', 'listing changes nothing');
});

// ---------------------------------------------------------------- waived marks, thresholds, month boundaries

test('a waived mark keeps its history through restore, and never comes back on a rerun', async (t) => {
  if (skip(t)) return;
  const slip = await task(users.bo.id, at(MON5, '11:00'), { title: 'Slipped' });
  await runBlackMarkScan({ now: at(MON5, '12:00') });
  const [mark] = await marksFor(slip.id);
  const waive = await call('POST', `/blackmarks/${mark.id}/waive`, { token: tokens.mgr, body: { reason: 'Client moved the meeting' } });
  assert.equal(waive.status, 200);
  await runBlackMarkScan({ now: at(TUE13, '12:00') });
  assert.equal((await marksFor(slip.id)).length, 1);
  assert.equal((await marksFor(slip.id))[0].status, 'waived');
  const restore = await call('POST', `/blackmarks/${mark.id}/restore`, { token: tokens.mgr, body: {} });
  assert.equal(restore.status, 200);
  const history = await call('GET', `/blackmarks/${mark.id}/history`, { token: tokens.bo });
  assert.equal(history.status, 200, 'a person can see their own mark\'s history');
  const waivedEntry = history.body.audit.find((a) => a.action === 'WAIVED');
  assert.equal(waivedEntry.reason, 'Client moved the meeting');
  assert.equal(waivedEntry.actor_name, 'Synthetic Manager');
  assert.equal(history.body.audit.find((a) => a.action === 'RESTORED').before.waived_reason, 'Client moved the meeting');
  assert.equal((await call('GET', `/blackmarks/${mark.id}/history`, { token: tokens.ana })).status, 403);
});

test('months run in India time, thresholds flag people, and nothing converts marks into absence', async (t) => {
  if (skip(t)) return;
  const stored = { sessions: await hash('attendance_sessions'), reviews: await hash('attendance_day_reviews', 't.user_id, t.work_date'), leave: await hash('leave_requests'), payroll: await hash('payroll_results') };
  // 01:30 on 1 October in India is still 30 September in UTC
  const boundary = new Date('2026-09-30T20:00:00Z');
  const edge = await recordBlackMark({ userId: users.cy.id, points: 1, reason: 'Synthetic boundary mark', source: 'manual', occurredAt: boundary, occurrenceKey: 'synthetic:boundary' });
  assert.equal(edge.period_month, '2026-10-01');
  for (let n = 1; n <= 2; n += 1) {
    await recordBlackMark({ userId: users.cy.id, points: 1, reason: `Synthetic mark ${n}`, source: 'manual', occurredAt: at('2026-10-20', '12:00'), occurrenceKey: `synthetic:${n}` });
  }
  const waived = await recordBlackMark({ userId: users.cy.id, points: 1, reason: 'Synthetic waived', source: 'manual', occurredAt: at('2026-10-21', '12:00'), occurrenceKey: 'synthetic:waived' });
  await query(`UPDATE black_marks SET status = 'waived', waived_reason = 'synthetic' WHERE id = $1`, [waived.id]);
  // a duplicate key is one mark
  assert.equal(await recordBlackMark({ userId: users.cy.id, points: 1, reason: 'again', source: 'manual', occurredAt: boundary, occurrenceKey: 'synthetic:boundary' }), null);

  const october = await monthlyReview({ month: '2026-10', now: at('2026-10-31', '12:00') });
  const cy = october.members.find((m) => m.user_id === users.cy.id);
  assert.equal(october.period.start, '2026-09-30T18:30:00.000Z', 'midnight in India');
  assert.ok(cy.total_points >= 3);
  assert.equal(cy.severity, 'critical');
  assert.equal(cy.waived_count, 1, 'a waived mark does not count');
  assert.match(october.consequences, /no rule converts marks into absence/);
  const september = await monthlyReview({ month: '2026-09', now: at('2026-10-31', '12:00') });
  assert.equal(september.members.find((m) => m.user_id === users.cy.id).mark_count, 0, 'the boundary mark is October\'s');

  // reaching a threshold changed no attendance, leave or pay record
  assert.equal(await hash('attendance_sessions'), stored.sessions);
  assert.equal(await hash('attendance_day_reviews', 't.user_id, t.work_date'), stored.reviews);
  assert.equal(await hash('leave_requests'), stored.leave);
  assert.equal(await hash('payroll_results'), stored.payroll);
});

test('nothing in this feature marks a task done or moves its deadline', async (t) => {
  if (skip(t)) return;
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
      WHERE (s.stage = 'done') <> (t.completed_at IS NOT NULL) OR t.due_date_changes > 0`,
  );
  assert.equal(rows[0].n, 0);
  const { rows: moves } = await query('SELECT COUNT(*)::int AS n FROM task_deadline_moves');
  assert.equal(moves[0].n, 0);
});
