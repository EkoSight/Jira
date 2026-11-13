/**
 * Who owns what, for an administrator to review. Read only: it runs inside a
 * READ ONLY transaction and changes nothing, not even a permission.
 *
 *   npm run crm:owner-review
 *
 * Lists:
 *   1. open leads owned by switched-off accounts
 *   2. open follow-ups assigned to switched-off accounts
 *   3. enabled assignment rules that name a switched-off account, or nobody
 *   4. enabled approval rules whose approvers are switched off, or that let
 *      people approve their own quotes
 *   5. people who can change CRM settings, assign, export sensitive fields or
 *      read the audit log
 *   6. names shared by more than one account, which make owner lists ambiguous
 */
import { pool } from './pool.js';
import { hasPermission } from '../lib/permissions.js';

const POWERS = ['crm.settings', 'crm.assign', 'crm.export.sensitive', 'crm.audit', 'crm.merge'];

async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    const q = async (sql, params) => (await c.query(sql, params)).rows;
    const users = await q('SELECT id, full_name, email, role, is_active, extra_permissions, revoked_permissions FROM users ORDER BY full_name');
    const name = Object.fromEntries(users.map((u) => [u.id, `${u.full_name}${u.is_active ? '' : ' (switched off)'}`]));
    const off = new Set(users.filter((u) => !u.is_active).map((u) => u.id));
    const out = [];
    const section = (title, lines) => out.push(`\n${title}\n${lines.length ? lines.map((l) => `  - ${l}`).join('\n') : '  none'}`);

    section('1. Open leads owned by switched-off accounts', (await q(
      `SELECT owner_user_id, COUNT(*)::int AS n FROM crm_leads
        WHERE owner_user_id = ANY($1::int[]) AND is_archived = FALSE AND merged_into_id IS NULL AND status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED','NURTURE')
        GROUP BY owner_user_id ORDER BY n DESC`, [[...off]],
    )).map((r) => `${name[r.owner_user_id]}: ${r.n} open lead${r.n === 1 ? '' : 's'}`));

    section('2. Open follow-ups assigned to switched-off accounts', (await q(
      `SELECT assignee_id, COUNT(*)::int AS n FROM tasks
        WHERE assignee_id = ANY($1::int[]) AND followup_kind IS NOT NULL AND completed_at IS NULL AND is_archived = FALSE AND crm_cancel_reason IS NULL
        GROUP BY assignee_id ORDER BY n DESC`, [[...off]],
    )).map((r) => `${name[r.assignee_id]}: ${r.n}`));

    const rules = await q('SELECT id, name, strategy, user_ids FROM crm_assignment_rules WHERE is_enabled ORDER BY priority, id');
    section('3. Enabled assignment rules to check', rules.flatMap((r) => {
      const gone = (r.user_ids || []).filter((id) => off.has(id) || !name[id]);
      if (gone.length) return [`"${r.name}" (#${r.id}) names ${gone.map((id) => name[id] || `a deleted account #${id}`).join(', ')}`];
      if (['SPECIFIC_USER', 'ROUND_ROBIN', 'LEAST_LOADED'].includes(r.strategy) && !(r.user_ids || []).length) return [`"${r.name}" (#${r.id}) uses ${r.strategy.toLowerCase().replace(/_/g, ' ')} but names nobody`];
      return [];
    }));

    const approvals = await q('SELECT id, name, approver_user_ids, allow_self_approval FROM crm_approval_rules WHERE is_enabled ORDER BY position, id');
    section('4. Enabled approval rules to check', approvals.flatMap((r) => {
      const lines = [];
      const ids = r.approver_user_ids || [];
      const live = ids.filter((id) => name[id] && !off.has(id));
      if (!live.length) lines.push(`"${r.name}" (#${r.id}) has no active approver${ids.length ? ` (names ${ids.map((id) => name[id] || `#${id}`).join(', ')})` : ''}`);
      else if (live.length < ids.length) lines.push(`"${r.name}" (#${r.id}) still names ${ids.filter((id) => !live.includes(id)).map((id) => name[id] || `#${id}`).join(', ')}`);
      if (r.allow_self_approval) lines.push(`"${r.name}" (#${r.id}) lets people approve their own quotes`);
      return lines;
    }));

    section('5. Active people with CRM administration powers', users.filter((u) => u.is_active).flatMap((u) => {
      const has = POWERS.filter((p) => hasPermission(u, p));
      return has.length ? [`${u.full_name} (${u.role}): ${has.join(', ')}${(u.extra_permissions || []).some((p) => POWERS.includes(p)) ? ' — partly granted individually' : ''}`] : [];
    }));

    const byName = {};
    for (const u of users) (byName[u.full_name.trim().toLowerCase()] ||= []).push(u);
    section('6. Names shared by more than one account', Object.values(byName).filter((l) => l.length > 1)
      .map((l) => l.map((u) => `${u.full_name} <${u.email}>${u.is_active ? '' : ' switched off'}`).join(' / ')));

    await c.query('ROLLBACK');
    console.log(`Owner and access review — read only, nothing was changed.${out.join('\n')}`);
    console.log('\nNothing here is fixed automatically. Reassign leads and follow-ups, or change rules and permissions, in TaskFlow after review.');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

main().then(() => pool.end()).catch(async (err) => { console.error(err.message); process.exitCode = 1; await pool.end(); });
