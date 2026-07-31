import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { effectivePermissions, hasPermission } from '../lib/permissions.js';

const USER_COLUMNS = `
  id, full_name, email, role, department_id, job_title, avatar_color,
  weekly_capacity_hours, max_concurrent_tasks, extra_permissions, revoked_permissions,
  is_active, must_change_password, token_version
`;

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, tv: user.token_version },
    config.auth.jwtSecret,
    { expiresIn: config.auth.tokenTtl },
  );
}

export async function loadUser(id) {
  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Resolves the caller.
 *
 * Standalone mode: reads the TaskFlow bearer token.
 * Embedded mode (TRUST_HOST_AUTH=true): the host application has already
 * authenticated the request and left an id on req.user / req.taskflowUserId — we
 * look the matching TaskFlow member up by id or by external_user_id / email.
 */
export const authenticate = async (req, res, next) => {
  try {
    let userId = null;

    if (config.auth.trustHostAuth && (req.taskflowUserId || req.user)) {
      const hostUser = req.user || {};
      const lookup = req.taskflowUserId ?? hostUser.taskflowUserId ?? null;
      if (lookup) {
        userId = lookup;
      } else if (hostUser.id || hostUser.email) {
        const { rows } = await query(
          `SELECT id FROM users WHERE external_user_id = $1 OR lower(email) = lower($2) LIMIT 1`,
          [hostUser.id ? String(hostUser.id) : null, hostUser.email || ''],
        );
        userId = rows[0]?.id ?? null;
      }
    }

    if (!userId) {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) throw unauthorized();

      let payload;
      try {
        payload = jwt.verify(token, config.auth.jwtSecret);
      } catch {
        throw unauthorized('Session expired, please sign in again');
      }
      userId = payload.sub;
      req.tokenVersion = payload.tv;
    }

    const user = await loadUser(userId);
    if (!user) throw unauthorized('Account not found');
    if (!user.is_active) throw forbidden('This account has been deactivated');
    if (req.tokenVersion !== undefined && req.tokenVersion !== user.token_version) {
      throw unauthorized('Session is no longer valid, please sign in again');
    }

    req.currentUser = user;
    req.permissions = effectivePermissions(user);
    next();
  } catch (err) {
    next(err);
  }
};

/** Route guard: caller must hold at least one of the listed permissions. */
export const requirePermission = (...permissions) => (req, res, next) => {
  const ok = permissions.some((p) => hasPermission(req.currentUser, p));
  if (!ok) return next(forbidden(`Requires permission: ${permissions.join(' or ')}`));
  next();
};

export const touchActivity = (req, res, next) => {
  if (req.currentUser) {
    query('UPDATE users SET last_activity_at = now() WHERE id = $1', [req.currentUser.id]).catch(() => {});
  }
  next();
};
