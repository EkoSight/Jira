/**
 * Whether a person can see one record now, with each module's own rule. Used
 * before a reminder is sent, when a notification or deep link is opened, and
 * when a "remind me" is set. A record the person cannot see is "not
 * available", with no title or contact shown.
 */
import { query } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { getSettings } from '../settings.js';
import { canSee, crmScope } from '../sales/core.js';

export const ENTITY_TYPES = ['TASK', 'LEAD', 'DEAL', 'APPLICATION', 'MEETING', 'ACCOUNT', 'KEY_RESULT', 'OBJECTIVE'];

async function taskVisible(user, id) {
  if (hasPermission(user, 'task.view.all')) {
    const { rows } = await query('SELECT 1 FROM tasks WHERE id = $1', [id]);
    return rows.length > 0;
  }
  const { rows } = await query(
    `SELECT 1 FROM tasks t
      WHERE t.id = $1
        AND (t.assignee_id = $2 OR t.follower_id = $2 OR t.reporter_id = $2 OR t.created_by = $2
             OR t.department_id = $3
             OR EXISTS (SELECT 1 FROM task_collaborators tc WHERE tc.task_id = t.id AND tc.user_id = $2))`,
    [id, user.id, user.department_id],
  );
  return rows.length > 0;
}

/** A meeting: with an organisation, as the organisation is seen; without one, its owner, organiser and people. */
async function meetingVisible(user, id, scope, crmOn) {
  const { rows } = await query('SELECT account_id, opportunity_id, lead_id, owner_user_id, created_by, scheduling_owner_id FROM crm_meetings WHERE id = $1', [id]);
  const m = rows[0];
  if (!m) return false;
  const mine = [m.owner_user_id, m.created_by, m.scheduling_owner_id].includes(user.id);
  if (mine) return true;
  const { rows: p } = await query('SELECT 1 FROM crm_meeting_participants WHERE meeting_id = $1 AND user_id = $2', [id, user.id]);
  if (p.length) return true;
  if (!crmOn) return false;
  if (m.account_id) return canSee(scope, 'account', m.account_id);
  if (m.opportunity_id) return canSee(scope, 'opportunity', m.opportunity_id);
  if (m.lead_id) return canSee(scope, 'lead', m.lead_id);
  return false;
}

export async function canSeeRecord(user, type, id, settings = null) {
  if (!user?.is_active && user?.is_active !== undefined) return false;
  const s = settings || await getSettings();
  const crmOn = s.crm?.enabled !== false && hasPermission(user, 'crm.view');
  const okrOn = s.okr?.enabled !== false && hasPermission(user, 'okr.view');
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  switch (type) {
    case 'TASK': return taskVisible(user, n);
    case 'LEAD': return crmOn && canSee(await crmScope(user), 'lead', n);
    case 'ACCOUNT': return crmOn && canSee(await crmScope(user), 'account', n);
    case 'DEAL':
    case 'APPLICATION': {
      if (!crmOn) return false;
      const { rows } = await query('SELECT 1 FROM opportunities WHERE id = $1 AND is_archived = FALSE', [n]);
      return rows.length > 0 && canSee(await crmScope(user), 'opportunity', n);
    }
    case 'MEETING': {
      // internal meetings (no organisation) are open to the people in them, CRM or not
      return meetingVisible(user, n, crmOn ? await crmScope(user) : null, crmOn);
    }
    case 'KEY_RESULT': {
      if (!okrOn) return false;
      const { rows } = await query('SELECT 1 FROM key_results WHERE id = $1', [n]);
      return rows.length > 0;
    }
    case 'OBJECTIVE': {
      if (!okrOn) return false;
      const { rows } = await query('SELECT 1 FROM objectives WHERE id = $1', [n]);
      return rows.length > 0;
    }
    default: return false;
  }
}

/** The label and address of a record, read only after canSeeRecord said yes. */
export async function recordLabel(type, id) {
  const one = async (sql) => (await query(sql, [id])).rows[0] || null;
  switch (type) {
    case 'TASK': { const r = await one('SELECT ref, title FROM tasks WHERE id = $1'); return r && { label: `${r.ref} ${r.title}`, url: `/?task=${id}` }; }
    case 'LEAD': { const r = await one('SELECT ref, organization_name, contact_name FROM crm_leads WHERE id = $1'); return r && { label: r.organization_name || r.contact_name || r.ref, url: `/sales/leads/${id}` }; }
    case 'ACCOUNT': { const r = await one('SELECT name FROM accounts WHERE id = $1'); return r && { label: r.name, url: `/accounts/${id}` }; }
    case 'DEAL': { const r = await one('SELECT o.name, o.account_id, a.name AS account FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE o.id = $1'); return r && { label: `${r.name} · ${r.account}`, url: `/accounts/${r.account_id}?deal=${id}` }; }
    case 'APPLICATION': { const r = await one('SELECT o.name, a.name AS account FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE o.id = $1'); return r && { label: `${r.name} · ${r.account}`, url: `/applications/${id}` }; }
    case 'MEETING': { const r = await one('SELECT title FROM crm_meetings WHERE id = $1'); return r && { label: r.title, url: `/meetings?meeting=${id}` }; }
    case 'KEY_RESULT': { const r = await one('SELECT title, objective_id FROM key_results WHERE id = $1'); return r && { label: r.title, url: `/goals/${r.objective_id}` }; }
    case 'OBJECTIVE': { const r = await one('SELECT title FROM objectives WHERE id = $1'); return r && { label: r.title, url: `/goals/${id}` }; }
    default: return null;
  }
}

/** Whether a timezone name is one the platform knows (aliases such as Asia/Kolkata included). */
export function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** The list offered to people: the platform's names, with the company's own spelling included. */
export function timeZoneList(extra = []) {
  return [...new Set([...Intl.supportedValuesOf('timeZone'), 'Asia/Kolkata', ...extra.filter(Boolean)])].sort();
}
