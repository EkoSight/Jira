/**
 * Waiting on others: what one person is waiting for, from whom, since when,
 * the promised date and the next check. Only the person's own records and
 * requests are read.
 *
 *   deals marked waiting       deals they own with waiting_on set
 *   customer commitments       open, on deals or organisations they own
 *   work they handed out       tasks they created for someone else that are
 *                              blocked or overdue; a recorded block (with what
 *                              it waits on) is told apart from a task merely
 *                              moved to Blocked
 *   their own requests         deadline changes, leave, corrections, holiday
 *                              changes, quotations and appeals still pending
 *
 * Applications add submitted-and-waiting rows (services/workspace/applications.js).
 */
import { query } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { getSettings } from '../settings.js';
import { deadlineClock } from '../deadlines.js';
import { healthLabel } from '../../../../shared/deadlineHealth.js';
import { PENDING_LEAVE } from '../attendanceLedger.js';

const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const EXTRA = [];
/** Other parts of the workspace add their own rows (applications). */
export function addWaitingSource(fn) { if (!EXTRA.includes(fn)) EXTRA.push(fn); }

export async function waitingFor(user, { now = new Date() } = {}) {
  const settings = await getSettings();
  const crm = settings.crm?.enabled !== false && hasPermission(user, 'crm.view');
  const c = await deadlineClock(now, settings);
  const out = [];

  if (crm) {
    const { rows: deals } = await query(
      `SELECT o.id, o.name, o.account_id, a.name AS account_name, o.waiting_on, o.waiting_reason, o.waiting_since, o.waiting_until, p.category
         FROM opportunities o JOIN accounts a ON a.id = o.account_id LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id
        WHERE o.owner_user_id = $1 AND o.is_archived = FALSE AND o.status = 'ACTIVE' AND o.waiting_on IS NOT NULL`,
      [user.id],
    );
    for (const d of deals) {
      const app = d.category === 'APPLICATIONS';
      out.push({
        key: `WAITING:DEAL:${d.id}`, kind: 'DEAL_WAITING', specific: true,
        what: d.waiting_reason || (app ? 'A reply on the application' : 'Their next move'), from: d.waiting_on,
        since: dayOf(d.waiting_since), promised: dayOf(d.waiting_until), next_check: dayOf(d.waiting_until),
        record: { type: app ? 'APPLICATION' : 'DEAL', id: d.id, label: `${d.name} · ${d.account_name}`, url: app ? `/applications/${d.id}` : `/accounts/${d.account_id}?deal=${d.id}` },
        overdue: Boolean(d.waiting_until && dayOf(d.waiting_until) < c.today),
      });
    }
    const { rows: commitments } = await query(
      `SELECT cc.id, cc.what, cc.due_on, cc.created_at, cc.opportunity_id, cc.account_id, a.name AS account_name,
              ac.full_name AS contact_name, o.name AS deal_name
         FROM customer_commitments cc JOIN accounts a ON a.id = cc.account_id
         LEFT JOIN opportunities o ON o.id = cc.opportunity_id
         LEFT JOIN account_contacts ac ON ac.id = cc.contact_id
        WHERE cc.status = 'OPEN' AND (o.owner_user_id = $1 OR (cc.opportunity_id IS NULL AND a.owner_user_id = $1))`,
      [user.id],
    );
    for (const k of commitments) {
      out.push({
        key: `WAITING:COMMITMENT:${k.id}`, kind: 'COMMITMENT', specific: true,
        what: k.what, from: k.contact_name ? `${k.contact_name}, ${k.account_name}` : k.account_name,
        since: dayOf(k.created_at), promised: dayOf(k.due_on), next_check: dayOf(k.due_on),
        record: { type: k.opportunity_id ? 'DEAL' : 'ACCOUNT', id: k.opportunity_id || k.account_id, label: k.deal_name ? `${k.deal_name} · ${k.account_name}` : k.account_name, url: `/accounts/${k.account_id}${k.opportunity_id ? `?deal=${k.opportunity_id}` : ''}` },
        overdue: Boolean(k.due_on && dayOf(k.due_on) < c.today),
      });
    }
  }

  // work handed to someone else that is stuck or late
  const { rows: tasks } = await query(
    `SELECT t.id, t.ref, t.title, t.due_date, t.review_date, t.deferral_id, s.stage, u.full_name AS owner_name, t.updated_at,
            b.id AS block_id, b.reason AS block_reason, b.dependency_text, b.status AS block_status, b.recorded_at AS block_since
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN LATERAL (SELECT * FROM task_blocks tb WHERE tb.task_id = t.id AND tb.status IN ('PENDING', 'ACCEPTED') ORDER BY tb.recorded_at DESC LIMIT 1) b ON TRUE
      WHERE t.created_by = $1 AND t.assignee_id IS DISTINCT FROM $1 AND t.is_archived = FALSE
        AND s.stage NOT IN ('done', 'cancelled')
        AND (s.stage = 'blocked' OR b.id IS NOT NULL OR (t.due_date IS NOT NULL AND t.due_date < $2 AND t.deferral_id IS NULL))`,
    [user.id, now],
  );
  for (const t of tasks) {
    const h = healthLabel(t, c);
    const blocked = t.stage === 'blocked' || t.block_id;
    out.push({
      key: `WAITING:TASK:${t.id}`, kind: blocked ? 'TASK_BLOCKED' : 'TASK_OVERDUE',
      // a recorded block says what it waits on; a plain Blocked status does not
      specific: Boolean(t.block_id),
      what: t.block_id ? (t.dependency_text || t.block_reason) : blocked ? 'Marked Blocked, with nothing recorded about what it waits on' : 'Past its deadline',
      from: t.owner_name || 'Nobody owns it',
      since: dayOf(t.block_since) || (blocked ? dayOf(t.updated_at) : dayOf(t.due_date)),
      promised: dayOf(t.due_date), next_check: dayOf(t.review_date),
      record: { type: 'TASK', id: t.id, label: `${t.ref} ${t.title}`, url: `/?task=${t.id}` },
      overdue: h.code === 'OVERDUE', health: h.text,
    });
  }

  // the person's own requests still waiting for someone's decision
  const mine = [];
  const { rows: changes } = await query(
    `SELECT c.id, c.requested_at, t.id AS task_id, t.ref, t.title FROM task_deadline_changes c JOIN tasks t ON t.id = c.task_id
      WHERE c.requested_by = $1 AND c.status = 'PENDING'`, [user.id],
  );
  for (const x of changes) mine.push({ key: `WAITING:REQUEST:CHANGE:${x.id}`, what: `New deadline for ${x.ref} ${x.title}`, since: x.requested_at, url: `/?task=${x.task_id}` });
  const { rows: leave } = await query(
    `SELECT id, start_date, COALESCE(submitted_at, created_at) AS since FROM leave_requests WHERE user_id = $1 AND status = ANY($2::text[])`, [user.id, PENDING_LEAVE],
  );
  for (const x of leave) mine.push({ key: `WAITING:REQUEST:LEAVE:${x.id}`, what: `Leave from ${dayOf(x.start_date)}`, since: x.since, url: '/attendance?tab=leave' });
  const { rows: corrections } = await query(
    `SELECT id, work_date, created_at FROM attendance_corrections WHERE user_id = $1 AND status = 'PENDING'`, [user.id],
  );
  for (const x of corrections) mine.push({ key: `WAITING:REQUEST:CORRECTION:${x.id}`, what: `Attendance correction for ${dayOf(x.work_date)}`, since: x.created_at, url: '/attendance?tab=month' });
  const { rows: holidays } = await query(
    `SELECT id, name, proposed_at FROM holiday_requests WHERE proposed_by = $1 AND status = 'PROPOSED'`, [user.id],
  );
  for (const x of holidays) mine.push({ key: `WAITING:REQUEST:HOLIDAY:${x.id}`, what: `Holiday change${x.name ? `: ${x.name}` : ''}`, since: x.proposed_at, url: '/attendance?tab=approvals' });
  if (crm) {
    const { rows: quotes } = await query(
      `SELECT ap.id, ap.requested_at, q.number FROM crm_approvals ap LEFT JOIN crm_quotes q ON q.id = ap.quote_id WHERE ap.requested_by = $1 AND ap.status = 'PENDING'`, [user.id],
    );
    for (const x of quotes) mine.push({ key: `WAITING:REQUEST:QUOTE:${x.id}`, what: `Approval of quotation ${x.number || ''}`.trim(), since: x.requested_at, url: '/sales?tab=approvals' });
  }
  const { rows: appeals } = await query(`SELECT id, created_at FROM black_mark_appeals WHERE user_id = $1 AND status = 'OPEN'`, [user.id]);
  for (const x of appeals) mine.push({ key: `WAITING:REQUEST:APPEAL:${x.id}`, what: 'Your appeal against a black mark', since: x.created_at, url: '/black-marks?tab=appeals' });
  for (const r of mine) {
    out.push({ key: r.key, kind: 'MY_REQUEST', specific: true, what: r.what, from: 'An approver', since: dayOf(r.since), promised: null, next_check: null, record: { type: 'REQUEST', id: r.key, label: r.what, url: r.url }, overdue: false });
  }

  for (const fn of EXTRA) {
    try { out.push(...await fn(user, { c, crm, now })); } catch (err) { console.error('[taskflow] waiting:', err.message); }
  }
  // the longest wait first
  out.sort((a, b) => String(a.since || '9999').localeCompare(String(b.since || '9999')) || a.key.localeCompare(b.key));
  return { items: out, total: out.length, today: c.today };
}
