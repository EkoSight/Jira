import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, unauthorized, badRequest, notFound, HttpError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { effectivePermissions } from '../lib/permissions.js';
import { authenticate, signToken, loadUser } from '../middleware/auth.js';
import { ACCENT_PRESETS } from '../../../shared/brandTheme.js';
import { homeFor } from '../services/workspace/layout.js';
import { makeLimiter } from '../lib/limits.js';
import {
  accountEmailSettings, cancelResetRequests, emailReadiness, sendAccountEmail, startForgotPassword,
} from '../services/accountEmail.js';
import { audit } from '../services/attendance.js';

// Failed sign-ins, per typed email (docs/ACCOUNT_EMAILS.md): 10 in 15 minutes,
// then a wait. Counted the same whether or not the account exists.
const LOGIN_FAILURES = makeLimiter({ max: 10, windowMs: 15 * 60_000 });
// "Forgot password?": 3 per address and 20 per IP address in an hour
const FORGOT_BY_ADDRESS = makeLimiter({ max: 3, windowMs: 60 * 60_000 });
const FORGOT_BY_IP = makeLimiter({ max: 20, windowMs: 60 * 60_000 });
const FORGOT_ANSWER = "If that email has a TaskFlow account, we've sent instructions. Check your inbox (and spam folder).";

// checked against when the account does not exist, so the answer takes as long
let dummyHash = null;
const dummy = async () => { dummyHash ||= await hashPassword(`no-account-${Date.now()}`); return dummyHash; };

/** A "Forgot password?" temporary password: it becomes the password, to be changed now, and every other session ends. */
async function useResetRequest(user, password) {
  const { rows } = await query(
    `SELECT id, password_hash, expires_at FROM password_reset_requests
      WHERE user_id = $1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > now()
      ORDER BY id DESC LIMIT 3`,
    [user.id],
  );
  for (const request of rows) {
    if (!(await verifyPassword(password, request.password_hash))) continue;
    return withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'UPDATE password_reset_requests SET used_at = now() WHERE id = $1 AND used_at IS NULL AND cancelled_at IS NULL',
        [request.id],
      );
      if (!rowCount) return null; // used a moment ago
      await cancelResetRequests(client, user.id);
      const { rows: [fresh] } = await client.query(
        `UPDATE users SET password_hash = $2, must_change_password = TRUE, temp_password_expires_at = $3,
                token_version = token_version + 1, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [user.id, request.password_hash, request.expires_at],
      );
      await audit(client, {
        entityType: 'USER_ACCESS', entityId: user.id, subjectUserId: user.id, actorId: user.id,
        action: 'SIGNED_IN_WITH_RESET', source: 'forgot_password',
      });
      return fresh;
    });
  }
  return null;
}

/** Whether My workspace is the person's home (for the navigation); never fails sign-in. */
async function withHome(user) {
  try {
    const { rows } = await query('SELECT home FROM user_dashboards WHERE user_id = $1', [user.id]);
    return { ...publicUser(user), workspace_home: (await homeFor(user, rows[0] || null)).workspace };
  } catch {
    return publicUser(user);
  }
}

const router = Router();

const publicUser = (user) => ({
  id: user.id,
  full_name: user.full_name,
  email: user.email,
  role: user.role,
  department_id: user.department_id,
  job_title: user.job_title,
  avatar_color: user.avatar_color,
  photo_version: user.photo_version ?? null,
  theme_mode: user.theme_mode ?? null,
  theme_accent: user.theme_accent ?? null,
  timezone: user.timezone ?? null,
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
    const key = email.trim().toLowerCase();
    if (LOGIN_FAILURES.blocked(key)) {
      const wait = LOGIN_FAILURES.waitMinutes(key);
      throw new HttpError(429, `Too many sign-in attempts. Wait ${wait} minute${wait === 1 ? '' : 's'} and try again.`);
    }

    const { rows } = await query(
      `SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    let user = rows[0];
    // the same work whether or not the account exists, so the answer cannot tell
    const matches = await verifyPassword(password, user ? user.password_hash : await dummy());
    let ok = Boolean(user && user.is_active && matches);
    // a temporary password from "Forgot password?" works alongside the current one
    if (!ok && user?.is_active) {
      const reset = await useResetRequest(user, password);
      if (reset) { user = reset; ok = true; }
    }
    if (!ok) {
      LOGIN_FAILURES.hit(key);
      throw unauthorized('Email or password is incorrect');
    }
    // a temporary password TaskFlow issued works for a limited time (NULL: issued before this rule, no limit)
    if (user.must_change_password && user.temp_password_expires_at && new Date(user.temp_password_expires_at) <= new Date()) {
      throw unauthorized('This temporary password has expired. Ask your administrator to send a new one.');
    }
    LOGIN_FAILURES.clear(key);

    await query('UPDATE users SET last_login_at = now(), last_activity_at = now() WHERE id = $1', [user.id]);

    res.json({ token: signToken(user), user: await withHome(user) });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: await withHome(req.currentUser) });
  }),
);

/** The person's own look: light, dark or match the device, and an optional accent. Follows them to every device. */
router.put(
  '/me/preferences',
  authenticate,
  asyncHandler(async (req, res) => {
    const d = z.object({
      theme_mode: z.enum(['LIGHT', 'DARK', 'SYSTEM']).optional(),
      theme_accent: z.string().max(30).nullable().optional(),
    }).parse(req.body || {});
    if (d.theme_accent && !ACCENT_PRESETS.some((p) => p.key === d.theme_accent)) throw badRequest('Choose one of the offered colours');
    const { rows } = await query(
      `UPDATE users SET theme_mode = COALESCE($2, theme_mode),
              theme_accent = CASE WHEN $3::boolean THEN $4 ELSE theme_accent END
        WHERE id = $1 RETURNING theme_mode, theme_accent`,
      [req.currentUser.id, d.theme_mode ?? null, d.theme_accent !== undefined, d.theme_accent ?? null],
    );
    res.json(rows[0]);
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

    if (currentPassword === newPassword) throw badRequest('Choose a password different from the current one');

    await withTransaction(async (client) => {
      // one use: the temporary password and every "Forgot password?" request stop working
      await client.query(
        `UPDATE users
            SET password_hash = $1, must_change_password = FALSE, temp_password_expires_at = NULL,
                token_version = token_version + 1, updated_at = now()
          WHERE id = $2`,
        [await hashPassword(newPassword), req.currentUser.id],
      );
      await cancelResetRequests(client, req.currentUser.id);
    });

    const fresh = await loadUser(req.currentUser.id);
    // "your password was changed": to their own address, never with a password
    try {
      await sendAccountEmail({ kind: 'PASSWORD_CHANGED', user: fresh, actor: fresh });
    } catch (err) {
      console.error('[taskflow] password changed email:', err?.message || err);
    }
    res.json({ token: signToken(fresh), user: publicUser(fresh) });
  }),
);

/** What the sign-in page may offer before anyone signs in. */
router.get(
  '/options',
  asyncHandler(async (req, res) => {
    const [settings, readiness] = await Promise.all([accountEmailSettings(), emailReadiness()]);
    res.json({ forgot_password: settings.forgotPassword && readiness.ready });
  }),
);

/**
 * "Forgot password?". Always the same answer, whether or not the address has
 * an account; the work happens after the answer. Never changes the current
 * password: the emailed one works alongside it until used or expired.
 */
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().trim().email().max(320) }).parse(req.body || {});
    const [settings, readiness] = await Promise.all([accountEmailSettings(), emailReadiness()]);
    if (!settings.forgotPassword || !readiness.ready) throw notFound('Ask your administrator to reset your password');
    const byAddress = FORGOT_BY_ADDRESS.hit(email.toLowerCase());
    const byIp = FORGOT_BY_IP.hit(String(req.ip || 'unknown'));
    if (byAddress && byIp) startForgotPassword(email, req.ip);
    res.json({ message: FORGOT_ANSWER });
  }),
);

export default router;
export { publicUser };
