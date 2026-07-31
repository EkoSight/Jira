import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../lib/errors.js';
import { hashPassword, generateTempPassword } from '../lib/password.js';
import { PERMISSIONS, PERMISSION_KEYS, ROLES, ROLE_PERMISSIONS, effectivePermissions } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';

const router = Router();

const SELECT_USER = `
  SELECT u.id, u.full_name, u.email, u.role, u.department_id, u.job_title, u.phone,
         u.avatar_color, u.weekly_capacity_hours, u.max_concurrent_tasks,
         u.extra_permissions, u.revoked_permissions, u.is_active, u.must_change_password,
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
  res.json({ permissions: PERMISSIONS, roles: ROLES, rolePermissions: ROLE_PERMISSIONS });
});

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
    res.json({ users: rows.map(withPermissions) });
  }),
);

router.get(
  '/:id',
  requirePermission('user.view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(`${SELECT_USER} WHERE u.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound('Team member not found');
    res.json({ user: withPermissions(rows[0]) });
  }),
);

router.post(
  '/',
  requirePermission('user.create'),
  asyncHandler(async (req, res) => {
    const data = userInput.parse(req.body);

    // only someone who can manage permissions may mint admins or hand out overrides
    const escalating =
      data.role === 'admin' || data.extra_permissions?.length || data.revoked_permissions?.length;
    if (escalating && !req.permissions.includes('user.permissions')) {
      throw forbidden('You cannot assign roles or permission overrides');
    }

    const tempPassword = data.password || generateTempPassword();
    const { rows } = await query(
      `INSERT INTO users
         (full_name, email, password_hash, role, department_id, job_title, phone, avatar_color,
          weekly_capacity_hours, max_concurrent_tasks, extra_permissions, revoked_permissions,
          external_user_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'#3b82f6'),COALESCE($9,40),COALESCE($10,8),
               COALESCE($11::text[],'{}'::text[]),COALESCE($12::text[],'{}'::text[]),$13,$14)
       RETURNING id`,
      [
        data.full_name,
        data.email,
        await hashPassword(tempPassword),
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
      ],
    );

    const { rows: created } = await query(`${SELECT_USER} WHERE u.id = $1`, [rows[0].id]);
    res.status(201).json({
      user: withPermissions(created[0]),
      // shown once so the admin can hand it over; it is never retrievable again
      temporary_password: data.password ? undefined : tempPassword,
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

    const touchesPermissions =
      data.role !== undefined || data.extra_permissions !== undefined || data.revoked_permissions !== undefined;
    if (touchesPermissions && !req.permissions.includes('user.permissions')) {
      throw forbidden('You cannot change roles or permissions');
    }

    // never let the last active admin be demoted or switched off
    if ((data.role && data.role !== 'admin') || data.is_active === false) {
      if (existing[0].role === 'admin') {
        const { rows: admins } = await query(
          `SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active = TRUE AND id <> $1`,
          [id],
        );
        if (admins[0].n === 0) throw badRequest('At least one active admin must remain');
      }
    }

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
      fields.push('token_version = token_version + 1');
    }

    if (fields.length === 0) throw badRequest('Nothing to update');

    params.push(id);
    await query(`UPDATE users SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);

    const { rows } = await query(`${SELECT_USER} WHERE u.id = $1`, [id]);
    res.json({ user: withPermissions(rows[0]) });
  }),
);

router.post(
  '/:id/reset-password',
  requirePermission('user.edit'),
  asyncHandler(async (req, res) => {
    const tempPassword = generateTempPassword();
    const { rowCount } = await query(
      `UPDATE users
          SET password_hash = $1, must_change_password = TRUE, token_version = token_version + 1, updated_at = now()
        WHERE id = $2`,
      [await hashPassword(tempPassword), req.params.id],
    );
    if (!rowCount) throw notFound('Team member not found');
    res.json({ temporary_password: tempPassword });
  }),
);

router.delete(
  '/:id',
  requirePermission('user.delete'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.currentUser.id) throw badRequest('You cannot deactivate your own account');

    const { rows } = await query('SELECT role FROM users WHERE id = $1', [id]);
    if (!rows[0]) throw notFound('Team member not found');
    if (rows[0].role === 'admin') {
      const { rows: admins } = await query(
        `SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active = TRUE AND id <> $1`,
        [id],
      );
      if (admins[0].n === 0) throw badRequest('At least one active admin must remain');
    }

    // deactivate rather than delete so task history stays intact
    await query('UPDATE users SET is_active = FALSE, token_version = token_version + 1 WHERE id = $1', [id]);
    res.json({ ok: true });
  }),
);

export default router;
