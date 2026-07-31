import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, unauthorized, badRequest } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { effectivePermissions } from '../lib/permissions.js';
import { authenticate, signToken, loadUser } from '../middleware/auth.js';

const router = Router();

const publicUser = (user) => ({
  id: user.id,
  full_name: user.full_name,
  email: user.email,
  role: user.role,
  department_id: user.department_id,
  job_title: user.job_title,
  avatar_color: user.avatar_color,
  must_change_password: user.must_change_password,
  permissions: effectivePermissions(user),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const { rows } = await query(
      `SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    const user = rows[0];
    // constant-ish response regardless of which half failed
    const ok = user && user.is_active && (await verifyPassword(password, user.password_hash));
    if (!ok) throw unauthorized('Email or password is incorrect');

    await query('UPDATE users SET last_login_at = now(), last_activity_at = now() WHERE id = $1', [user.id]);

    res.json({ token: signToken(user), user: publicUser(user) });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.currentUser) });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.currentUser.id]);
    if (!(await verifyPassword(currentPassword, rows[0]?.password_hash))) {
      throw badRequest('Current password is incorrect');
    }

    await query(
      `UPDATE users
          SET password_hash = $1, must_change_password = FALSE, token_version = token_version + 1, updated_at = now()
        WHERE id = $2`,
      [await hashPassword(newPassword), req.currentUser.id],
    );

    const fresh = await loadUser(req.currentUser.id);
    res.json({ token: signToken(fresh), user: publicUser(fresh) });
  }),
);

export default router;
export { publicUser };
