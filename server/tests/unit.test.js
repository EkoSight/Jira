import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, generateTempPassword } from '../src/lib/password.js';
import {
  ROLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  hasAnyPermission,
  PERMISSION_KEYS,
  SUPER_ADMIN_ONLY,
  canAssignRole,
  canGrantPermission,
  canManageAccount,
  tracksAttendance,
} from '../src/lib/permissions.js';

test('password hashing round trips and rejects the wrong password', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});

test('two hashes of the same password differ (salted)', async () => {
  const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
  assert.notEqual(a, b);
});

test('generated temporary passwords are unique and url safe', () => {
  const values = new Set(Array.from({ length: 50 }, generateTempPassword));
  assert.equal(values.size, 50);
  for (const value of values) assert.match(value, /^[A-Za-z0-9_-]+$/);
});

test('super admins hold every permission, and none can be revoked from them', () => {
  const founder = { role: 'super_admin', extra_permissions: [], revoked_permissions: ['payroll.approve', 'user.permissions'] };
  assert.deepEqual(effectivePermissions(founder).sort(), [...PERMISSION_KEYS].sort());
});

test('admins hold every permission except the ones kept for super admins', () => {
  const admin = { role: 'admin', extra_permissions: [], revoked_permissions: [] };
  const expected = PERMISSION_KEYS.filter((p) => !SUPER_ADMIN_ONLY.includes(p));
  assert.deepEqual(effectivePermissions(admin).sort(), [...expected].sort());
  assert.deepEqual(SUPER_ADMIN_ONLY.sort(), ['payroll.approve', 'payroll.reopen', 'payroll.salary.edit']);
  // a super admin can hand one over to a named person
  assert.equal(hasPermission({ ...admin, extra_permissions: ['payroll.approve'] }, 'payroll.approve'), true);
});

test('who may manage whose account, and give which role', () => {
  const founder = { role: 'super_admin' };
  const admin = { role: 'admin' };
  const manager = { role: 'manager' };
  assert.equal(canManageAccount(founder, { role: 'super_admin' }), true, 'one founder may act for the other');
  assert.equal(canManageAccount(admin, { role: 'super_admin' }), false);
  assert.equal(canManageAccount(admin, { role: 'admin' }), false, 'not a peer');
  assert.equal(canManageAccount(admin, manager), true);
  assert.equal(canManageAccount(manager, admin), false, 'a manager cannot reset an admin');
  assert.equal(canAssignRole(admin, 'admin'), false);
  assert.equal(canAssignRole(admin, 'super_admin'), false);
  assert.equal(canAssignRole(admin, 'manager'), true);
  assert.equal(canAssignRole(founder, 'super_admin'), true);
  assert.equal(canAssignRole(founder, 'nonsense'), false);
  assert.equal(canGrantPermission(admin, 'payroll.approve'), false);
  assert.equal(canGrantPermission(admin, 'blackmark.waive'), true);
  assert.equal(canGrantPermission(founder, 'payroll.approve'), true);
  assert.equal(tracksAttendance(founder), false);
  assert.equal(tracksAttendance(admin), true);
});

test('a member cannot edit anyone else’s cards or change permissions', () => {
  const member = { role: 'member', extra_permissions: [], revoked_permissions: [] };
  assert.equal(hasPermission(member, 'task.edit.own'), true);
  assert.equal(hasPermission(member, 'task.edit.any'), false);
  assert.equal(hasPermission(member, 'user.permissions'), false);
  assert.equal(hasPermission(member, 'blackmark.waive'), false);
});

test('extra permissions add to the role, revoked ones subtract', () => {
  const lead = {
    role: 'member',
    extra_permissions: ['blackmark.waive', 'task.assign'],
    revoked_permissions: ['task.create'],
  };
  const permissions = effectivePermissions(lead);
  assert.ok(permissions.includes('blackmark.waive'));
  assert.ok(permissions.includes('task.assign'));
  assert.ok(!permissions.includes('task.create'));
  assert.ok(permissions.includes('task.comment'), 'other role defaults survive');
});

test('revoking wins over the role default even when also listed as extra', () => {
  const user = {
    role: 'manager',
    extra_permissions: ['task.delete'],
    revoked_permissions: ['task.delete'],
  };
  assert.equal(hasPermission(user, 'task.delete'), false);
});

test('hasAnyPermission matches on any of the listed permissions', () => {
  const viewer = { role: 'viewer', extra_permissions: [], revoked_permissions: [] };
  assert.equal(hasAnyPermission(viewer, ['task.view.all', 'task.view.department']), true);
  assert.equal(hasAnyPermission(viewer, ['task.create', 'task.delete']), false);
});

test('no role grants a permission that is not in the catalogue', () => {
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permission of permissions) {
      assert.ok(PERMISSION_KEYS.includes(permission), `${role} references unknown ${permission}`);
    }
  }
});

test('nobody is granted anything without a user', () => {
  assert.deepEqual(effectivePermissions(null), []);
  assert.equal(hasPermission(null, 'task.create'), false);
});
