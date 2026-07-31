/**
 * Permission catalogue.
 *
 * A user's effective permissions = role defaults + extra_permissions - revoked_permissions.
 * This lets an admin hand out a single extra capability (say "blackmark.waive") to a
 * team lead without inventing a new role.
 */
export const PERMISSIONS = {
  'task.view.all': 'See tasks across every department',
  'task.view.department': 'See tasks in own department',
  'task.create': 'Create task cards',
  'task.edit.any': 'Edit any task card',
  'task.edit.own': 'Edit tasks they created or are assigned',
  'task.assign': 'Assign / reassign task cards',
  'task.delete': 'Delete or archive task cards',
  'task.comment': 'Comment on task cards',

  'user.view': 'View team members',
  'user.create': 'Add team members',
  'user.edit': 'Edit team member profiles and capacity',
  'user.permissions': 'Change roles and permissions',
  'user.delete': 'Deactivate team members',

  'department.manage': 'Create and edit departments',
  'workflow.manage': 'Create and edit statuses / stages',

  'blackmark.view': 'View black marks',
  'blackmark.create': 'Raise a manual black mark',
  'blackmark.waive': 'Waive / cancel a black mark',
  'blackmark.rules': 'Create and edit black mark rules',

  'report.view': 'View dashboards and monthly reviews',
  'settings.manage': 'Change system settings',
};

export const PERMISSION_KEYS = Object.keys(PERMISSIONS);

export const ROLE_PERMISSIONS = {
  admin: PERMISSION_KEYS,

  manager: [
    'task.view.all',
    'task.view.department',
    'task.create',
    'task.edit.any',
    'task.edit.own',
    'task.assign',
    'task.delete',
    'task.comment',
    'user.view',
    'user.create',
    'user.edit',
    'blackmark.view',
    'blackmark.create',
    'blackmark.waive',
    'report.view',
  ],

  member: [
    'task.view.department',
    'task.create',
    'task.edit.own',
    'task.comment',
    'user.view',
    'blackmark.view',
  ],

  viewer: ['task.view.department', 'user.view', 'blackmark.view'],
};

export const ROLES = Object.keys(ROLE_PERMISSIONS);

export function effectivePermissions(user) {
  if (!user) return [];
  const base = new Set(ROLE_PERMISSIONS[user.role] || []);
  for (const p of user.extra_permissions || []) base.add(p);
  for (const p of user.revoked_permissions || []) base.delete(p);
  return [...base];
}

export function hasPermission(user, permission) {
  if (!user) return false;
  return effectivePermissions(user).includes(permission);
}

export function hasAnyPermission(user, permissions) {
  const effective = new Set(effectivePermissions(user));
  return permissions.some((p) => effective.has(p));
}
