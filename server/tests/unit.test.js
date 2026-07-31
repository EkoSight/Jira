import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, generateTempPassword } from '../src/lib/password.js';
import {
  ROLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  hasAnyPermission,
  PERMISSION_KEYS,
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

test('admins hold every permission', () => {
  const admin = { role: 'admin', extra_permissions: [], revoked_permissions: [] };
  assert.deepEqual(effectivePermissions(admin).sort(), [...PERMISSION_KEYS].sort());
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
