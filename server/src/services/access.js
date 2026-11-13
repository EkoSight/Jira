/**
 * Making and unmaking super admins outside the app: the first ones have to be
 * named by whoever runs the server, since nobody in the app can yet. No person
 * is named in the code; the command takes their sign-in emails.
 *
 * Each change is written to the audit trail with the role before and after.
 * Granting is idempotent; revoking keeps at least one active super admin.
 */

import { query, withTransaction } from '../db/pool.js';
import { audit } from './attendance.js';

const normal = (emails) => [...new Set((emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];

async function findAll(client, emails) {
  const { rows } = await client.query(
    'SELECT id, full_name, email, role, is_active FROM users WHERE lower(email) = ANY($1::text[]) ORDER BY id',
    [emails],
  );
  const missing = emails.filter((e) => !rows.some((r) => r.email.toLowerCase() === e));
  if (missing.length) throw new Error(`No account with the email ${missing.join(', ')}. Nothing was changed.`);
  const inactive = rows.filter((r) => !r.is_active);
  if (inactive.length) throw new Error(`${inactive.map((r) => r.email).join(', ')} is switched off. Nothing was changed.`);
  return rows;
}

/** Makes these accounts super admins. Returns each with its role before and after. */
export async function grantSuperAdmin(emails, { source = 'command line', actorId = null } = {}) {
  const list = normal(emails);
  if (!list.length) throw new Error('Give at least one email');
  return withTransaction(async (client) => {
    const people = await findAll(client, list);
    const out = [];
    for (const p of people) {
      if (p.role !== 'super_admin') {
        await client.query(`UPDATE users SET role = 'super_admin', token_version = token_version + 1, updated_at = now() WHERE id = $1`, [p.id]);
        await audit(client, {
          entityType: 'USER_ACCESS', entityId: p.id, subjectUserId: p.id, actorId, action: 'ROLE_CHANGED',
          before: { role: p.role }, after: { role: 'super_admin' }, reason: 'Made a super admin', source,
        });
      }
      out.push({ email: p.email, name: p.full_name, before: p.role, after: 'super_admin', changed: p.role !== 'super_admin' });
    }
    return out;
  });
}

/** Turns super admins back into admins (or another role). At least one active super admin stays. */
export async function revokeSuperAdmin(emails, { toRole = 'admin', source = 'command line', actorId = null } = {}) {
  const list = normal(emails);
  if (!list.length) throw new Error('Give at least one email');
  return withTransaction(async (client) => {
    const people = await findAll(client, list);
    const ids = people.filter((p) => p.role === 'super_admin').map((p) => p.id);
    const { rows: [left] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE role = 'super_admin' AND is_active AND NOT (id = ANY($1::int[]))`, [ids],
    );
    if (ids.length && left.n === 0) throw new Error('That would leave no active super admin. Nothing was changed.');
    const out = [];
    for (const p of people) {
      if (p.role === 'super_admin') {
        await client.query('UPDATE users SET role = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1', [p.id, toRole]);
        await audit(client, {
          entityType: 'USER_ACCESS', entityId: p.id, subjectUserId: p.id, actorId, action: 'ROLE_CHANGED',
          before: { role: 'super_admin' }, after: { role: toRole }, reason: 'No longer a super admin', source,
        });
      }
      out.push({ email: p.email, name: p.full_name, before: p.role, after: p.role === 'super_admin' ? toRole : p.role, changed: p.role === 'super_admin' });
    }
    return out;
  });
}

/** Everyone with an administrator role, for the command's listing. */
export async function administrators() {
  const { rows } = await query(
    `SELECT full_name, email, role, is_active FROM users WHERE role IN ('super_admin', 'admin') ORDER BY role DESC, full_name`,
  );
  return rows;
}
