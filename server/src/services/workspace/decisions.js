/**
 * Needs my decision: every approval waiting on one person, each from its own
 * module, with that module's own rule for who decides. Nothing is approved
 * here; each row opens the place where the decision is made.
 *
 *   deadline changes and blocks   APPROVER_SQL (the overdue review's rule)
 *   leave                         leave.approve, people they can see, not themselves
 *   attendance corrections        attendance.approve, people they can see
 *   extra time and unrecorded days attendance.approve / attendance.extra.review (the review queue)
 *   holiday changes               holiday.approve, proposed by someone else
 *   quotations                    a named approver (crm_approvals.approver_ids)
 *   deal handovers                handed to them, not yet confirmed
 *   black-mark appeals            blackmark.waive, not their own
 *   standup reviews               standup.review: today's unresolved reviews
 */
import { query } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { APPROVER_SQL } from '../taskPeople.js';
import { visibleUserIds } from '../attendance.js';
import { PENDING_LEAVE } from '../attendanceLedger.js';
import { pendingHandoversFor } from '../opportunities.js';
import { getSettings } from '../settings.js';

/** One row of the list: what, who asked, since when, and where to decide. */
const row = (kind, { id, what, who = null, since, url, module, detail = null }) => ({
  key: `DECISION:${kind}:${id}`, kind, id, what, who, since, url, module, detail,
});

const LABEL = {
  DEADLINE_CHANGE: 'Deadline change',
  BLOCK: 'Block to accept',
  LEAVE: 'Leave request',
  CORRECTION: 'Attendance correction',
  ATTENDANCE_REVIEW: 'Attendance to review',
  HOLIDAY: 'Holiday change',
  QUOTATION: 'Quotation approval',
  HANDOVER: 'Deal handed to you',
  APPEAL: 'Black-mark appeal',
  STANDUP: 'Standup follow-up',
};
export const DECISION_LABEL = LABEL;

export async function decisionsFor(user, { now = new Date() } = {}) {
  const settings = await getSettings();
  const crmOn = settings.crm?.enabled !== false && hasPermission(user, 'crm.view');
  const out = [];
  const all = hasPermission(user, 'task.edit.any');

  const { rows: changes } = await query(
    `SELECT c.id, c.requested_at, c.reason, t.id AS task_id, t.ref, t.title, u.full_name AS who
       FROM task_deadline_changes c JOIN tasks t ON t.id = c.task_id LEFT JOIN users u ON u.id = c.requested_by
      WHERE c.status = 'PENDING' AND ${APPROVER_SQL} ORDER BY c.requested_at`,
    [user.id, all],
  );
  for (const c of changes) out.push(row('DEADLINE_CHANGE', { id: c.id, what: `${c.ref} ${c.title}`, who: c.who, since: c.requested_at, url: `/review?task=${c.task_id}`, module: 'tasks', detail: c.reason }));

  const { rows: blocks } = await query(
    `SELECT b.id, b.recorded_at, b.reason, t.id AS task_id, t.ref, t.title, u.full_name AS who
       FROM task_blocks b JOIN tasks t ON t.id = b.task_id LEFT JOIN users u ON u.id = b.recorded_by
      WHERE b.status = 'PENDING' AND ${APPROVER_SQL} ORDER BY b.recorded_at`,
    [user.id, all],
  );
  for (const b of blocks) out.push(row('BLOCK', { id: b.id, what: `${b.ref} ${b.title}`, who: b.who, since: b.recorded_at, url: `/review?task=${b.task_id}`, module: 'tasks', detail: b.reason }));

  if (hasPermission(user, 'leave.approve')) {
    const ids = await visibleUserIds(user);
    const { rows } = await query(
      `SELECT l.id, COALESCE(l.submitted_at, l.created_at) AS created_at, l.start_date, l.end_date, u.full_name AS who
         FROM leave_requests l JOIN users u ON u.id = l.user_id
        WHERE l.status = ANY($1::text[]) AND l.user_id <> $2 AND ($3::int[] IS NULL OR l.user_id = ANY($3::int[]))
        ORDER BY 2`,
      [PENDING_LEAVE, user.id, ids],
    );
    for (const l of rows) {
      const days = String(l.start_date).slice(0, 10) === String(l.end_date).slice(0, 10) ? String(l.start_date).slice(0, 10) : `${String(l.start_date).slice(0, 10)} to ${String(l.end_date).slice(0, 10)}`;
      out.push(row('LEAVE', { id: l.id, what: `Leave ${days}`, who: l.who, since: l.created_at, url: '/attendance?tab=approvals', module: 'attendance' }));
    }
  }

  if (hasPermission(user, 'attendance.approve')) {
    const ids = await visibleUserIds(user);
    const { rows } = await query(
      `SELECT c.id, c.created_at, c.work_date, c.kind, u.full_name AS who
         FROM attendance_corrections c JOIN users u ON u.id = c.user_id
        WHERE c.status = 'PENDING' AND c.user_id <> $1 AND ($2::int[] IS NULL OR c.user_id = ANY($2::int[]))
        ORDER BY c.created_at`,
      [user.id, ids],
    );
    for (const c of rows) out.push(row('CORRECTION', { id: c.id, what: `Correction for ${String(c.work_date).slice(0, 10)}`, who: c.who, since: c.created_at, url: '/attendance?tab=approvals', module: 'attendance' }));
  }

  if (hasPermission(user, 'attendance.approve') || hasPermission(user, 'attendance.extra.review')) {
    // the review queue's own list, this month
    const { reviewQueueItems } = await import('../../routes/attendance.js');
    const { items } = await reviewQueueItems(user, null);
    for (const it of items) {
      const what = it.kind === 'EXTRA_PENDING' ? `Extra time on ${it.date}` : `${String(it.kind).replace(/_/g, ' ').toLowerCase()} on ${it.date}`;
      out.push(row('ATTENDANCE_REVIEW', { id: `${it.user.id}-${it.date}-${it.kind}`, what: what.charAt(0).toUpperCase() + what.slice(1), who: it.user.full_name, since: `${it.date}T00:00:00Z`, url: '/attendance?tab=approvals', module: 'attendance' }));
    }
  }

  if (hasPermission(user, 'holiday.approve')) {
    const { rows } = await query(
      `SELECT h.id, h.proposed_at, h.action, h.name, h.start_date, u.full_name AS who
         FROM holiday_requests h LEFT JOIN users u ON u.id = h.proposed_by
        WHERE h.status = 'PROPOSED' AND h.proposed_by IS DISTINCT FROM $1 ORDER BY h.proposed_at`,
      [user.id],
    );
    for (const h of rows) out.push(row('HOLIDAY', { id: h.id, what: `${{ ADD: 'Add', AMEND: 'Change', CANCEL: 'Cancel' }[h.action]} holiday${h.name ? `: ${h.name}` : ''}`, who: h.who, since: h.proposed_at, url: '/attendance?tab=approvals', module: 'attendance' }));
  }

  if (crmOn) {
    const { rows: quotes } = await query(
      `SELECT ap.id, ap.requested_at, ap.quote_id, q.number, u.full_name AS who
         FROM crm_approvals ap LEFT JOIN crm_quotes q ON q.id = ap.quote_id LEFT JOIN users u ON u.id = ap.requested_by
        WHERE ap.status = 'PENDING' AND $1 = ANY(ap.approver_ids) AND ap.requested_by IS DISTINCT FROM $1
        ORDER BY ap.requested_at`,
      [user.id],
    );
    for (const q of quotes) out.push(row('QUOTATION', { id: q.id, what: `Quotation ${q.number || q.quote_id}`, who: q.who, since: q.requested_at, url: '/sales?tab=approvals', module: 'crm' }));
    for (const h of await pendingHandoversFor(user.id)) {
      out.push(row('HANDOVER', { id: h.id, what: `${h.opportunity_name} · ${h.account_name}`, who: h.handed_by_name || h.from_name, since: h.created_at, url: `/accounts/${h.account_id}?deal=${h.opportunity_id}`, module: 'crm' }));
    }
  }

  if (hasPermission(user, 'blackmark.waive')) {
    const { rows } = await query(
      `SELECT ap.id, ap.created_at, u.full_name AS who FROM black_mark_appeals ap JOIN users u ON u.id = ap.user_id
        WHERE ap.status = 'OPEN' AND ap.user_id <> $1 ORDER BY ap.created_at`,
      [user.id],
    );
    for (const a of rows) out.push(row('APPEAL', { id: a.id, what: 'Appeal against a black mark', who: a.who, since: a.created_at, url: '/black-marks?tab=appeals', module: 'blackmarks' }));
  }

  if (hasPermission(user, 'standup.review')) {
    const { rows } = await query(
      `SELECT r.id, r.status, r.work_date, m.full_name AS who FROM standup_reviews r JOIN standup_members m ON m.id = r.member_id
        WHERE r.resolution IS NULL AND r.status IN ('MISSING', 'INACCESSIBLE') AND r.work_date >= $1::date - 7
        ORDER BY r.work_date`,
      [now.toISOString().slice(0, 10)],
    );
    for (const r of rows) out.push(row('STANDUP', { id: r.id, what: `Standup ${r.status === 'MISSING' ? 'missing' : 'could not be read'} on ${String(r.work_date).slice(0, 10)}`, who: r.who, since: `${String(r.work_date).slice(0, 10)}T00:00:00Z`, url: '/standup?tab=review', module: 'standup' }));
  }

  out.sort((a, b) => new Date(a.since) - new Date(b.since));
  return out.map((d) => ({ ...d, label: LABEL[d.kind] }));
}
