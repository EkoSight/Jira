import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import {
  PERMISSIONS, PERMISSION_KEYS, ROLES, ROLE_LABELS, ROLE_PERMISSIONS, SUPER_ADMIN_ONLY, canAssignRole, canGrantPermission,
  canManageAccount, effectivePermissions, isSuperAdmin,
} from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { dateIn, orgCalendar, statusOn } from '../services/availability.js';
import { audit } from '../services/attendance.js';
import { accessStatus, claimFirstSuperAdmin } from '../services/access.js';
import { chatRoute } from '../services/taskReminders.js';
import { CHOICE_WORDS, channelPref, emailChannel } from '../services/reminderChannels.js';
import { clearUndeliverable } from '../services/reminderEmail.js';
import {
  accountEmailsOf, cancelResetRequests, emailReadiness, newTempPassword, sendAccountEmail,
} from '../services/accountEmail.js';

/**
 * Who may change whose access. Roles, permissions, passwords, sign-in emails
 * and switching an account off are only for someone ranked above the person
 * (a super admin may act on anyone). Nobody changes their own role or
 * permissions. Only a super admin makes admins or super admins, or hands out
 * the powers kept for super admins. Every change of role or permissions is
 * written to the audit trail.
 */
const ADMIN_ROLES = ['admin', 'super_admin'];

async function assertKeepsAdmins(target, { role, active }) {
  // at least one active super admin, and at least one active administrator of either kind
  const losing = (wasRole) => target.role === wasRole && (active === false || (role !== undefined && role !== wasRole));
  if (losing('super_admin')) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'super_admin' AND is_active AND id <> $1`, [target.id]);
    if (rows[0].n === 0) throw badRequest('At least one active super admin must remain');
  }
  if (ADMIN_ROLES.includes(target.role) && (active === false || (role !== undefined && !ADMIN_ROLES.includes(role)))) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE role = ANY($2::text[]) AND is_active AND id <> $1`, [target.id, ADMIN_ROLES]);
    if (rows[0].n === 0) throw badRequest('At least one active admin must remain');
  }
}

function assertMayGrant(actor, { role, extra }) {
  if (role !== undefined && !canAssignRole(actor, role)) {
    throw forbidden(role === 'super_admin' || role === 'admin'
      ? `Only a super admin can make someone ${ROLE_LABELS[role].toLowerCase()}`
      : `You cannot give the ${ROLE_LABELS[role] || role} role`);
  }
  const kept = (extra || []).filter((p) => !canGrantPermission(actor, p));
  if (kept.length) throw forbidden(`Only a super admin can grant ${kept.join(', ')}`);
}

const accessOf = (u) => ({ role: u.role, extra_permissions: u.extra_permissions || [], revoked_permissions: u.revoked_permissions || [], is_active: u.is_active });

async function awayToday() {
  const { timezone } = await orgCalendar();
  return statusOn(dateIn(timezone));
}

const router = Router();

const SELECT_USER = `
  SELECT u.id, u.full_name, u.email, u.role, u.department_id, u.job_title, u.phone,
         u.avatar_color, u.photo_version, u.weekly_capacity_hours, u.max_concurrent_tasks,
         u.extra_permissions, u.revoked_permissions, u.is_active, u.must_change_password, u.temp_password_expires_at,
         u.external_user_id, u.last_login_at, u.last_activity_at, u.created_at,
         d.name AS department_name, d.color AS department_color
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
`;

const withPermissions = (row) => ({ ...row, permissions: effectivePermissions(row) });

const userInput = z.object({
  full_name: z.string().min(2).max(120),
  email: z.string().email(),
  role: z.enum(ROLES),
  department_id: z.number().int().positive().nullable().optional(),
  job_title: z.string().max(120).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  avatar_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  weekly_capacity_hours: z.number().min(0).max(168).optional(),
  max_concurrent_tasks: z.number().int().min(1).max(100).optional(),
  extra_permissions: z.array(z.enum(PERMISSION_KEYS)).optional(),
  revoked_permissions: z.array(z.enum(PERMISSION_KEYS)).optional(),
  is_active: z.boolean().optional(),
  external_user_id: z.string().max(120).nullable().optional(),
  password: z.string().min(8).optional(),
});

router.get('/permissions/catalogue', (req, res) => {
  const actor = req.currentUser;
  res.json({
    permissions: PERMISSIONS,
    roles: ROLES,
    roleLabels: ROLE_LABELS,
    rolePermissions: ROLE_PERMISSIONS,
    superAdminOnly: SUPER_ADMIN_ONLY,
    // what this person may hand out, so the screen offers nothing it would refuse
    assignableRoles: ROLES.filter((r) => canAssignRole(actor, r)),
    grantable: PERMISSION_KEYS.filter((p) => canGrantPermission(actor, p)),
  });
});

/** Whether a super admin exists yet, and whether this person may become the first. */
router.get(
  '/access/status',
  asyncHandler(async (req, res) => {
    res.json(await accessStatus(req.currentUser));
  }),
);

/** Whether account emails can go out, for the tick boxes on the Team page. */
router.get(
  '/account-email-status',
  asyncHandler(async (req, res) => {
    if (!req.permissions.includes('user.create') && !req.permissions.includes('user.edit')) {
      throw forbidden('You do not have permission to do that');
    }
    const readiness = await emailReadiness();
    res.json({ ready: readiness.ready, reason: readiness.reason, expiry_hours: readiness.settings.expiryHours });
  }),
);

router.post(
  '/access/claim-super-admin',
  asyncHandler(async (req, res) => {
    const { password } = z.object({ password: z.string().min(1) }).parse(req.body || {});
    await claimFirstSuperAdmin(req.currentUser, password);
    const { rows } = await query(`${SELECT_USER} WHERE u.id = $1`, [req.currentUser.id]);
    res.json({ user: withPermissions(rows[0]) });
  }),
);

router.get(
  '/',
  requirePermission('user.view'),
  asyncHandler(async (req, res) => {
    const params = [];
    const filters = [];

    if (req.query.department_id) {
      params.push(Number(req.query.department_id));
      filters.push(`u.department_id = $${params.length}`);
    }
    if (req.query.role) {
      params.push(req.query.role);
      filters.push(`u.role = $${params.length}`);
    }
    if (req.query.active !== 'all') {
      filters.push('u.is_active = TRUE');
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      filters.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await query(`${SELECT_USER} ${where} ORDER BY u.full_name`, params);
    // who is away today travels with the list, so every picker can show it
    const away = await awayToday();
    res.json({ users: rows.map((row) => ({ ...withPermissions(row), away_today: away.get(row.id) || null })) });
  }),
);

router.get(
  '/:id',
  requirePermission('user.view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`${SELECT_USER} WHERE u.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound('Team member not found');
    const away = await awayToday();
    res.json({ user: { ...withPermissions(rows[0]), away_today: away.get(rows[0].id) || null } });
  }),
);

router.post(
  '/',
  requirePermission('user.create'),
  asyncHandler(async (req, res) => {
    const data = userInput.parse(req.body);

    // only someone who can manage permissions may mint admins or hand out overrides
    const escalating =
      ['admin', 'super_admin'].includes(data.role) || data.extra_permissions?.length || data.revoked_permissions?.length;
    if (escalating && !req.permissions.includes('user.permissions')) {
      throw forbidden('You cannot assign roles or permission overrides');
    }
    assertMayGrant(req.currentUser, { role: data.role, extra: data.extra_permissions });

    // a password the administrator typed is theirs to pass on; otherwise TaskFlow issues a temporary one
    const emailDetails = req.body?.email_details === true;
    const issued = data.password ? null : await newTempPassword();
    const { rows } = await query(
      `INSERT INTO users
         (full_name, email, password_hash, role, department_id, job_title, phone, avatar_color,
          weekly_capacity_hours, max_concurrent_tasks, extra_permissions, revoked_permissions,
          external_user_id, must_change_password, temp_password_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'#3b82f6'),COALESCE($9,40),COALESCE($10,8),
               COALESCE($11::text[],'{}'::text[]),COALESCE($12::text[],'{}'::text[]),$13,$14,$15)
       RETURNING id`,
      [
        data.full_name,
        data.email,
        issued ? issued.hash : await hashPassword(data.password),
        data.role,
        data.department_id ?? null,
        data.job_title ?? null,
        data.phone ?? null,
        data.avatar_color ?? null,
        data.weekly_capacity_hours ?? null,
        data.max_concurrent_tasks ?? null,
        data.extra_permissions ?? null,
        data.revoked_permissions ?? null,
        data.external_user_id ?? null,
        !data.password,
        issued ? issued.expiresAt : null,
      ],
    );

    const { rows: created } = await query(`${SELECT_USER} WHERE u.id = $1`, [rows[0].id]);
    if (data.role !== 'member' || data.extra_permissions?.length || data.revoked_permissions?.length) {
      await audit(null, {
        entityType: 'USER_ACCESS', entityId: rows[0].id, subjectUserId: rows[0].id, actorId: req.currentUser.id,
        action: 'CREATED', after: accessOf(created[0]), source: 'team_page',
      });
    }
    // the welcome email: with the temporary password only when TaskFlow issued it
    let email;
    if (emailDetails) {
      email = await sendAccountEmail({
        kind: 'WELCOME', user: created[0], actor: req.currentUser,
        password: issued ? issued.password : null, expiresAt: issued ? issued.expiresAt : null,
      });
      await audit(null, {
        entityType: 'USER_ACCESS', entityId: rows[0].id, subjectUserId: rows[0].id, actorId: req.currentUser.id,
        action: 'WELCOME_EMAIL', after: { status: email.status, with_password: Boolean(issued) }, source: 'team_page',
      });
    }
    res.status(201).json({
      user: withPermissions(created[0]),
      // shown once so the admin can hand it over, unless it was emailed; never retrievable again
      temporary_password: issued && !email?.sent ? issued.password : undefined,
      temporary_password_expires_at: issued ? issued.expiresAt : undefined,
      email: email ? { sent: email.sent, status: email.status, reason: email.reason, to: email.to } : undefined,
    });
  }),
);

router.patch(
  '/:id',
  requirePermission('user.edit'),
  asyncHandler(async (req, res) => {
    const data = userInput.partial().parse(req.body);
    const id = Number(req.params.id);

    const { rows: existing } = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (!existing[0]) throw notFound('Team member not found');

    // a field sent back unchanged (a form saves everything) is not a change
    const same = (a, b) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...(b || [])].sort() : b);
    for (const key of ['role', 'extra_permissions', 'revoked_permissions', 'is_active', 'email']) {
      if (data[key] !== undefined && same(data[key], existing[0][key])) delete data[key];
    }
    const touchesPermissions =
      data.role !== undefined || data.extra_permissions !== undefined || data.revoked_permissions !== undefined;
    if (touchesPermissions && !req.permissions.includes('user.permissions')) {
      throw forbidden('You cannot change roles or permissions');
    }
    const self = id === req.currentUser.id;
    if (self && (touchesPermissions || data.is_active === false)) {
      throw forbidden('You cannot change your own role, permissions or access; ask another administrator');
    }
    // the account itself: who signs in, with what, and what they may do
    const touchesAccount = touchesPermissions || data.is_active !== undefined || data.email !== undefined || data.password !== undefined;
    if (!self) {
      // a super admin's record is theirs and the other super admin's alone
      if (existing[0].role === 'super_admin' && !isSuperAdmin(req.currentUser)) {
        throw forbidden('Only a super admin can change a super admin\'s account');
      }
      if (touchesAccount && !canManageAccount(req.currentUser, existing[0])) {
        throw forbidden('You can only change the role, permissions, email, password or access of people below your own role');
      }
      if (touchesAccount) assertMayGrant(req.currentUser, { role: data.role, extra: data.extra_permissions });
    }

    // never let the last active admin, or the last super admin, be demoted or switched off
    await assertKeepsAdmins(existing[0], { role: data.role, active: data.is_active });

    const fields = [];
    const params = [];
    const set = (column, value) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };

    for (const key of [
      'full_name', 'email', 'role', 'department_id', 'job_title', 'phone', 'avatar_color',
      'weekly_capacity_hours', 'max_concurrent_tasks', 'extra_permissions', 'revoked_permissions',
      'is_active', 'external_user_id',
    ]) {
      if (data[key] !== undefined) set(key, data[key]);
    }

    if (data.password) {
      set('password_hash', await hashPassword(data.password));
      set('must_change_password', true);
      // typed by an administrator, not issued by TaskFlow: no expiry
      set('temp_password_expires_at', null);
      fields.push('token_version = token_version + 1');
    }

    if (fields.length === 0) throw badRequest('Nothing to update');

    params.push(id);
    await query(`UPDATE users SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);

    const { rows } = await query(`${SELECT_USER} WHERE u.id = $1`, [id]);
    if (touchesPermissions || data.is_active !== undefined) {
      const before = accessOf(existing[0]);
      const after = accessOf(rows[0]);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await audit(null, {
          entityType: 'USER_ACCESS', entityId: id, subjectUserId: id, actorId: req.currentUser.id,
          action: before.role !== after.role ? 'ROLE_CHANGED' : before.is_active !== after.is_active ? (after.is_active ? 'REACTIVATED' : 'DEACTIVATED') : 'PERMISSIONS_CHANGED',
          before, after, source: 'team_page',
        });
      }
    }
    res.json({ user: withPermissions(rows[0]) });
  }),
);

router.post(
  '/:id/reset-password',
  requirePermission('user.edit'),
  asyncHandler(async (req, res) => {
    const { rows: [target] } = await query('SELECT id, role FROM users WHERE id = $1', [Number(req.params.id)]);
    if (!target) throw notFound('Team member not found');
    // a reset hands over the account, so it follows the same rule as a role change
    if (target.id !== req.currentUser.id && !canManageAccount(req.currentUser, target)) {
      throw forbidden(target.role === 'super_admin' ? 'Only a super admin can reset a super admin\'s password' : 'You can only reset passwords for people below your own role');
    }
    res.json(await issueAndSend(req, target.id, { kind: 'RESET', emailDetails: req.body?.email_details === true }));
  }),
);

/**
 * "Resend sign-in details", while the person has not yet chosen their own
 * password. Only a hash is kept, so the earlier password cannot be resent: a
 * new one replaces it. Nothing changes when email cannot go out.
 */
router.post(
  '/:id/resend-sign-in',
  requirePermission('user.edit'),
  asyncHandler(async (req, res) => {
    const { rows: [target] } = await query('SELECT id, role, must_change_password, is_active FROM users WHERE id = $1', [Number(req.params.id)]);
    if (!target) throw notFound('Team member not found');
    if (target.id !== req.currentUser.id && !canManageAccount(req.currentUser, target)) {
      throw forbidden('You can only send sign-in details to people below your own role');
    }
    if (!target.is_active) throw badRequest('This account is deactivated');
    if (!target.must_change_password) throw badRequest('They have already chosen their own password. Use Reset password instead.');
    const readiness = await emailReadiness();
    if (!readiness.ready) throw badRequest(`Email is not set up: ${readiness.reason}`);
    res.json(await issueAndSend(req, target.id, { kind: 'WELCOME', emailDetails: true, resend: true }));
  }),
);

/**
 * How reminders reach this person: Chat connected or not, and whether their
 * email works (bounced, when and why), for the Team page.
 */
router.get(
  '/:id/reminder-reach',
  requirePermission('user.edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { rows: [u] } = await query('SELECT id, email, email_undeliverable_at, email_undeliverable_reason, email_soft_bounces FROM users WHERE id = $1', [id]);
    if (!u) throw notFound('Team member not found');
    const [route, pref, channel] = await Promise.all([chatRoute(id), channelPref(id), emailChannel()]);
    res.json({
      chat: { connected: route.ok, why: route.ok ? null : route.why },
      email: {
        ready: channel.ready, why: channel.ready ? null : channel.reason,
        bounced: Boolean(u.email_undeliverable_at), bounced_at: u.email_undeliverable_at, bounced_reason: u.email_undeliverable_reason,
        soft_bounces: u.email_soft_bounces,
      },
      task_reminders: pref?.taskReminders, summaries: pref?.summaries, words: { task_reminders: CHOICE_WORDS[pref?.taskReminders], summaries: CHOICE_WORDS[pref?.summaries] },
    });
  }),
);

/** "Clear the bounce": once the address is fixed, reminder emails to it resume. */
router.post(
  '/:id/clear-email-bounce',
  requirePermission('user.edit'),
  asyncHandler(async (req, res) => {
    const { rows: [target] } = await query('SELECT id, role, email, email_undeliverable_at, email_undeliverable_reason FROM users WHERE id = $1', [Number(req.params.id)]);
    if (!target) throw notFound('Team member not found');
    if (target.id !== req.currentUser.id && !canManageAccount(req.currentUser, target)) {
      throw forbidden('You can only change this for people below your own role');
    }
    if (!target.email_undeliverable_at) return res.json({ cleared: false, note: 'Their address is not marked as bouncing' });
    await clearUndeliverable(target.id);
    await audit(null, {
      entityType: 'USER_ACCESS', entityId: target.id, subjectUserId: target.id, actorId: req.currentUser.id, action: 'EMAIL_BOUNCE_CLEARED',
      before: { undeliverable_at: target.email_undeliverable_at, reason: target.email_undeliverable_reason }, after: { email: target.email }, source: 'team_page',
    });
    res.json({ cleared: true });
  }),
);

/** The person's account emails: what went, when, whether it went and who sent it. Never a password. */
router.get(
  '/:id/account-emails',
  requirePermission('user.edit'),
  asyncHandler(async (req, res) => {
    res.json({ emails: await accountEmailsOf(Number(req.params.id)) });
  }),
);

/**
 * A new temporary password for this person: their old one stops working, they
 * are signed out everywhere, open "Forgot password?" requests end, and,
 * when asked, it is emailed to them. The password is in the answer only when
 * it was not emailed.
 */
async function issueAndSend(req, userId, { kind, emailDetails, resend = false }) {
  const issued = await newTempPassword();
  const { rows: [person] } = await query(
    `UPDATE users
        SET password_hash = $1, must_change_password = TRUE, temp_password_expires_at = $2,
            token_version = token_version + 1, updated_at = now()
      WHERE id = $3 RETURNING id, full_name, email`,
    [issued.hash, issued.expiresAt, userId],
  );
  if (!person) throw notFound('Team member not found');
  await cancelResetRequests(null, userId);
  let email;
  if (emailDetails) {
    email = await sendAccountEmail({ kind, user: person, actor: req.currentUser, password: issued.password, expiresAt: issued.expiresAt, resend });
  }
  await audit(null, {
    entityType: 'USER_ACCESS', entityId: userId, subjectUserId: userId, actorId: req.currentUser.id,
    action: resend ? 'SIGN_IN_DETAILS_RESENT' : 'PASSWORD_RESET',
    after: { emailed: Boolean(email?.sent), status: email?.status ?? 'SHOWN_ON_SCREEN' }, source: 'team_page',
  });
  return {
    temporary_password: email?.sent ? undefined : issued.password,
    temporary_password_expires_at: issued.expiresAt,
    email: email ? { sent: email.sent, status: email.status, reason: email.reason, to: email.to } : undefined,
  };
}

router.delete(
  '/:id',
  requirePermission('user.delete'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.currentUser.id) throw badRequest('You cannot deactivate your own account');

    const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Team member not found');
    if (!canManageAccount(req.currentUser, rows[0])) {
      throw forbidden(rows[0].role === 'super_admin' ? 'Only a super admin can deactivate a super admin' : 'You can only deactivate people below your own role');
    }
    await assertKeepsAdmins(rows[0], { active: false });

    // deactivate rather than delete so task history stays intact
    await query('UPDATE users SET is_active = FALSE, token_version = token_version + 1 WHERE id = $1', [id]);
    if (rows[0].is_active) {
      await audit(null, {
        entityType: 'USER_ACCESS', entityId: id, subjectUserId: id, actorId: req.currentUser.id, action: 'DEACTIVATED',
        before: accessOf(rows[0]), after: { ...accessOf(rows[0]), is_active: false }, source: 'team_page',
      });
    }
    res.json({ ok: true });
  }),
);

export default router;
