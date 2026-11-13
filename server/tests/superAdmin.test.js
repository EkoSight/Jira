/**
 * Super admins: the founders. Sandbox only — a throwaway schema and made-up
 * people; nobody real is named here or anywhere in the code.
 *
 * What is guarded:
 *   - the first super admins are named by email from the command line, once,
 *     with an audit entry; unknown emails change nothing; at least one stays
 *   - a super admin has every permission; an admin lacks the kept ones and
 *     cannot make admins, hand out kept powers, or touch a super admin
 *   - nobody changes their own role; a manager cannot reset an admin
 *   - a super admin is outside daily tracking: no check-in gate, no check-in
 *     or check-out, no reminders, not in team attendance, payroll or standup
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { listPolicies } from '../src/services/attendancePolicy.js';
import { attendanceGate } from '../src/services/attendance.js';
import { grantSuperAdmin, revokeSuperAdmin } from '../src/services/access.js';
import { payrollExclusions, payrollPeople } from '../src/services/payroll.js';
import { eligibility } from '../src/services/standup.js';
import { runAttendanceScan } from '../src/jobs/attendanceScanner.js';

let server;
let baseUrl;
let available = true;
const ids = {};
const tokens = {};
// a Monday, with attendance counted from September
const MON = '2026-10-05';
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
const login = async (key) => (await call('POST', '/auth/login', { body: { email: `${key}@access.test`, password: 'Password123!' } })).body.token;

before(async () => {
  assert.match(config.db.schema, /test/, 'refusing to run outside a test schema');
  try { await query('SELECT 1'); } catch { available = false; return; }
  await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`);
  await runMigrations({ verbose: false });
  await query(`INSERT INTO departments (key, name, color, position) VALUES ('ACC', 'Synthetic team', '#2a78d6', 1)`);
  await query(`INSERT INTO workflow_statuses (name, slug, stage, color, position, is_default) VALUES ('To Do', 'to-do', 'todo', '#3b82f6', 1, TRUE)`);
  ids.dept = (await query(`SELECT id FROM departments`)).rows[0].id;
  const password = await hashPassword('Password123!');
  // the founders start as admins, as they are today
  for (const [key, name, role] of [
    ['founder1', 'First Founder', 'admin'], ['founder2', 'Second Founder', 'admin'], ['admin', 'Ops Admin', 'admin'], ['peer', 'Peer Admin', 'admin'],
    ['manager', 'Team Manager', 'manager'], ['member', 'Field Member', 'member'],
  ]) {
    const { rows } = await query(
      `INSERT INTO users (full_name, email, password_hash, role, department_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id`,
      [name, `${key}@access.test`, password, role, ids.dept],
    );
    ids[key] = rows[0].id;
    await query(`INSERT INTO employee_work_profiles (user_id, joining_date) VALUES ($1, '2025-01-01')`, [rows[0].id]);
  }
  await listPolicies();
  await query(`UPDATE attendance_policies SET config = config || '{"startDate": "2026-09-01", "enforcement": "REQUIRE"}'::jsonb`);
  await new Promise((resolve) => { server = createApp().listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (available) await query(`DROP SCHEMA IF EXISTS "${config.db.schema}" CASCADE`).catch(() => {});
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------- naming them

test('the founders are made super admins by email, once, on the record', async (t) => {
  if (skip(t)) return;
  await assert.rejects(grantSuperAdmin(['founder1@access.test', 'nobody@access.test']), /No account with the email nobody@access.test/);
  assert.equal((await query('SELECT role FROM users WHERE id = $1', [ids.founder1])).rows[0].role, 'admin', 'nothing changed');

  const made = await grantSuperAdmin(['FOUNDER1@access.test', 'founder2@access.test']);
  assert.deepEqual(made.map((r) => [r.before, r.after, r.changed]), [['admin', 'super_admin', true], ['admin', 'super_admin', true]]);
  const again = await grantSuperAdmin(['founder1@access.test']);
  assert.equal(again[0].changed, false, 'running it twice changes nothing');
  const { rows: trail } = await query(
    `SELECT entity_id, action, before, after, source FROM attendance_audit WHERE entity_type = 'USER_ACCESS' ORDER BY id`,
  );
  assert.equal(trail.length, 2);
  assert.deepEqual(trail[0].before, { role: 'admin' });
  assert.deepEqual(trail[0].after, { role: 'super_admin' });
  assert.equal(trail[0].source, 'command line');

  for (const key of ['founder1', 'founder2', 'admin', 'manager', 'member']) tokens[key] = await login(key);
  const me = await call('GET', '/auth/me', { token: tokens.founder1 });
  assert.equal(me.body.user.role, 'super_admin');
  assert.ok(me.body.user.permissions.includes('payroll.approve'));
  const admin = await call('GET', '/auth/me', { token: tokens.admin });
  assert.ok(!admin.body.user.permissions.includes('payroll.approve'), 'payroll approval is kept for super admins');
  assert.ok(!admin.body.user.permissions.includes('payroll.salary.edit'));
  assert.ok(admin.body.user.permissions.includes('user.permissions'), 'admins still run the team');
});

test('an admin cannot make admins, hand out kept powers, or touch a super admin', async (t) => {
  if (skip(t)) return;
  const create = (token, body) => call('POST', '/users', { token, body: { full_name: 'New Person', email: `new${Date.now()}${Math.random()}@access.test`, ...body } });
  assert.equal((await create(tokens.admin, { role: 'admin' })).status, 403);
  assert.equal((await create(tokens.admin, { role: 'super_admin' })).status, 403);
  assert.equal((await create(tokens.admin, { role: 'member', extra_permissions: ['payroll.approve'] })).status, 403);
  assert.equal((await create(tokens.admin, { role: 'manager' })).status, 201, 'roles below their own are fine');
  assert.equal((await call('PATCH', `/users/${ids.member}`, { token: tokens.admin, body: { role: 'admin' } })).status, 403);
  assert.equal((await call('PATCH', `/users/${ids.member}`, { token: tokens.admin, body: { role: 'manager' } })).status, 200);
  assert.equal((await call('PATCH', `/users/${ids.member}`, { token: tokens.admin, body: { role: 'member' } })).status, 200);

  // a super admin's account
  assert.equal((await call('PATCH', `/users/${ids.founder1}`, { token: tokens.admin, body: { job_title: 'x' } })).status, 403);
  assert.equal((await call('POST', `/users/${ids.founder1}/reset-password`, { token: tokens.admin })).status, 403);
  assert.equal((await call('DELETE', `/users/${ids.founder1}`, { token: tokens.admin })).status, 403);
  // nor a fellow admin's password: that would hand over the account
  assert.equal((await call('POST', `/users/${ids.peer}/reset-password`, { token: tokens.admin })).status, 403);
  assert.equal((await call('PATCH', `/users/${ids.peer}`, { token: tokens.admin, body: { role: 'manager' } })).status, 403);
  assert.equal((await call('PATCH', `/users/${ids.peer}`, { token: tokens.admin, body: { job_title: 'Accounts' } })).status, 200, 'profile details are fine');
  // a manager could reset an admin's password before; not any more
  assert.equal((await call('POST', `/users/${ids.admin}/reset-password`, { token: tokens.manager })).status, 403);
  assert.equal((await call('POST', `/users/${ids.member}/reset-password`, { token: tokens.manager })).status, 200);
});

test('a super admin makes admins and hands over kept powers; every change is audited', async (t) => {
  if (skip(t)) return;
  const promote = await call('PATCH', `/users/${ids.manager}`, { token: tokens.founder1, body: { role: 'admin', extra_permissions: ['payroll.approve'] } });
  assert.equal(promote.status, 200, JSON.stringify(promote.body));
  assert.ok(promote.body.user.permissions.includes('payroll.approve'));
  const { rows: [entry] } = await query(
    `SELECT action, before, after, actor_id FROM attendance_audit WHERE entity_type = 'USER_ACCESS' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
    [String(ids.manager)],
  );
  assert.equal(entry.action, 'ROLE_CHANGED');
  assert.equal(entry.before.role, 'manager');
  assert.equal(entry.after.role, 'admin');
  assert.equal(entry.actor_id, ids.founder1);
  await call('PATCH', `/users/${ids.manager}`, { token: tokens.founder1, body: { role: 'manager', extra_permissions: [] } });

  // one founder may act for the other; nobody changes their own role
  assert.equal((await call('PATCH', `/users/${ids.founder1}`, { token: tokens.founder1, body: { role: 'admin' } })).status, 403);
  assert.equal((await call('PATCH', `/users/${ids.founder1}`, { token: tokens.founder1, body: { role: 'super_admin', job_title: 'Co-founder' } })).status, 200, 'an unchanged role is not a change');
  // a super admin's powers cannot be revoked
  const revoked = await call('PATCH', `/users/${ids.founder2}`, { token: tokens.founder1, body: { revoked_permissions: ['payroll.approve'] } });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.user.permissions.includes('payroll.approve'));
});

test('at least one super admin always remains', async (t) => {
  if (skip(t)) return;
  const back = await revokeSuperAdmin(['founder2@access.test']);
  assert.equal(back[0].after, 'admin');
  await assert.rejects(revokeSuperAdmin(['founder1@access.test']), /no active super admin/);
  // through the app too: the last one cannot be switched off by anyone
  await grantSuperAdmin(['founder2@access.test']);
  tokens.founder2 = await login('founder2');
  assert.equal((await call('DELETE', `/users/${ids.founder1}`, { token: tokens.founder2 })).status, 200, 'with another left, allowed');
  await query('UPDATE users SET is_active = TRUE WHERE id = $1', [ids.founder1]);
  tokens.founder1 = await login('founder1');
});

// ---------------------------------------------------------------- outside daily tracking

test('a super admin is never asked to check in, and cannot check in or out', async (t) => {
  if (skip(t)) return;
  const founder = (await query('SELECT * FROM users WHERE id = $1', [ids.founder1])).rows[0];
  const member = (await query('SELECT * FROM users WHERE id = $1', [ids.member])).rows[0];
  const gate = await attendanceGate(founder, at(MON, '11:00'));
  assert.equal(gate.required, false);
  assert.equal(gate.reason, 'NOT_TRACKED');
  assert.equal((await attendanceGate(member, at(MON, '11:00'))).required, true, 'everyone else still checks in');

  const today = await call('GET', '/attendance/today', { token: tokens.founder1 });
  assert.equal(today.body.tracked, false);
  const checkIn = await call('POST', '/attendance/check-in', {
    token: tokens.founder1, body: { request_id: 'founder-check-in-0001', location: { latitude: 20.5, longitude: 78.9, accuracy: 20, timestamp: Date.now() } },
  });
  assert.equal(checkIn.status, 409);
  assert.equal(checkIn.body.details.code, 'NOT_TRACKED');
  assert.equal((await call('POST', '/attendance/check-out', { token: tokens.founder1, body: { request_id: 'founder-check-out-0001' } })).status, 409);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM attendance_sessions WHERE user_id = $1', [ids.founder1])).rows[0].n, 0);
});

test('no reminders, no team attendance row, no payroll month, no standup expectation', async (t) => {
  if (skip(t)) return;
  await runAttendanceScan(at(MON, '10:00'));
  const reminded = async (id) => (await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'attendance_reminder'`, [id])).rows[0].n;
  assert.equal(await reminded(ids.founder1), 0);
  assert.equal(await reminded(ids.founder2), 0);
  assert.equal(await reminded(ids.member), 1);

  const team = await call('GET', `/attendance/team/today?date=${MON}`, { token: tokens.admin });
  assert.equal(team.status, 200);
  const shown = team.body.people.map((p) => p.user.id);
  assert.ok(shown.includes(ids.member));
  assert.ok(!shown.includes(ids.founder1) && !shown.includes(ids.founder2));

  const people = await payrollPeople('2026-10-01');
  assert.ok(!people.includes(ids.founder1));
  const excluded = await payrollExclusions('2026-10-01');
  assert.equal(excluded.find((e) => e.id === ids.founder1)?.reason, 'NOT_TRACKED', 'left out with a reason, not silently');

  await query(`INSERT INTO standup_members (user_id, full_name, identity_status) VALUES ($1, 'First Founder', 'VERIFIED'), ($2, 'Field Member', 'VERIFIED')`, [ids.founder1, ids.member]);
  const who = await eligibility(MON);
  assert.ok(who.excluded.some((e) => e.member.user_id === ids.founder1 && e.reason === 'NOT_TRACKED'));
  assert.ok(who.expected.some((m) => m.user_id === ids.member));
});

// ---------------------------------------------------------------- the first one, from inside the app

test('with no super admin at all, an admin can take the first place by confirming their password, once', async (t) => {
  if (skip(t)) return;
  // the state just after the release: the founders are still admins
  await query(`UPDATE users SET role = 'admin' WHERE role = 'super_admin'`);
  // (the member's password was reset by an earlier test; the manager stands in)
  for (const key of ['founder1', 'founder2', 'admin', 'manager']) tokens[key] = await login(key);

  const status = await call('GET', '/users/access/status', { token: tokens.founder1 });
  assert.deepEqual(status.body, { super_admins: 0, can_claim: true });
  assert.equal((await call('GET', '/users/access/status', { token: tokens.manager })).body.can_claim, false, 'only admins are offered it');

  assert.equal((await call('POST', '/users/access/claim-super-admin', { token: tokens.manager, body: { password: 'Password123!' } })).status, 403);
  assert.equal((await call('POST', '/users/access/claim-super-admin', { token: tokens.founder1, body: { password: 'wrong-password' } })).status, 403);
  assert.equal((await query('SELECT role FROM users WHERE id = $1', [ids.founder1])).rows[0].role, 'admin', 'a wrong password changes nothing');

  const claimed = await call('POST', '/users/access/claim-super-admin', { token: tokens.founder1, body: { password: 'Password123!' } });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.user.role, 'super_admin');
  // the same session carries on, with the new powers
  const me = await call('GET', '/auth/me', { token: tokens.founder1 });
  assert.ok(me.body.user.permissions.includes('payroll.approve'));

  // closed now: the second founder is made one by the first, not by claiming
  const second = await call('POST', '/users/access/claim-super-admin', { token: tokens.founder2, body: { password: 'Password123!' } });
  assert.equal(second.status, 409);
  const made = await call('PATCH', `/users/${ids.founder2}`, { token: tokens.founder1, body: { role: 'super_admin' } });
  assert.equal(made.status, 200);

  const { rows: [entry] } = await query(
    `SELECT source, actor_id, after FROM attendance_audit WHERE entity_type = 'USER_ACCESS' AND source = 'in_app_first_claim'`,
  );
  assert.equal(entry.actor_id, ids.founder1);
  assert.equal(entry.after.role, 'super_admin');
  const { rows: told } = await query(`SELECT user_id FROM notifications WHERE type = 'access_change'`);
  assert.ok(told.some((n) => n.user_id === ids.admin), 'the other admins are told');
});
