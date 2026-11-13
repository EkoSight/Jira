/**
 * My Day as one prioritised queue. Each group is exactly a view of the Leads
 * list (same query, same filters), so its count is the number of leads that
 * list shows and "Open in Leads" lands on the same records. Every group pages;
 * nothing is capped.
 *
 *   1  fu_overdue      a follow-up of theirs is overdue
 *   2  fu_today        a follow-up of theirs is due later today
 *   3  retry           a lead of theirs is due to be tried again now
 *   4  new_uncalled    a new lead of theirs nobody has called
 *   5  no_next_action  a lead of theirs already worked, with nothing planned
 *   6  unassigned      open leads with no owner (for people who assign)
 *   7  stale           a lead of theirs with no contact for a while
 *
 * A lead can be in more than one group (an overdue follow-up and a retry due);
 * each group counts it once.
 */
import { query } from '../../db/pool.js';
import { hasPermission } from '../../lib/permissions.js';
import { crmScope, salesSettings } from './core.js';
import { listLeads } from './leads.js';

export const WORK_BUCKETS = ['fu_overdue', 'fu_today', 'retry', 'new_uncalled', 'no_next_action', 'unassigned', 'stale'];

const LABEL = {
  fu_overdue: ['Overdue follow-ups', 'critical', 'Their time has passed'],
  fu_today: ['Due later today', 'brand', 'Scheduled follow-ups still ahead today'],
  retry: ['Try again now', 'warning', 'No answer or busy earlier; their retry time has come'],
  new_uncalled: ['New, not called yet', 'good', 'Nobody has called them'],
  no_next_action: ['No next step', 'warning', 'Worked before, with no follow-up or retry planned'],
  unassigned: ['Unassigned', 'neutral', 'Open leads nobody owns'],
  stale: ['Gone quiet', 'neutral', 'No contact for a while'],
};

/** The list filters a group means, for a person: the Leads list uses the very same. */
export function bucketFilters(bucket, userId) {
  switch (bucket) {
    case 'fu_overdue': return { view: 'fu_overdue', for_user: userId, sort: 'follow_up' };
    case 'fu_today': return { view: 'fu_today', for_user: userId, sort: 'follow_up' };
    case 'retry': return { view: 'retry', owner_id: userId, sort: 'retry' };
    case 'new_uncalled': return { view: 'new_uncalled', owner_id: userId, sort: 'newest' };
    case 'no_next_action': return { view: 'no_next_action', owner_id: userId, sort: 'activity' };
    case 'unassigned': return { view: 'unassigned', sort: 'oldest' };
    case 'stale': return { view: 'stale', owner_id: userId, sort: 'activity' };
    default: return null;
  }
}

/**
 * What a person needs on each row to act without opening the lead: the next
 * open follow-up (theirs first) and the latest thing written about the lead,
 * marked when it came in with an import.
 */
async function rowContext(leadIds, userId) {
  if (!leadIds.length) return new Map();
  const { rows } = await query(
    `SELECT l.id,
            (SELECT json_build_object('id', t.id, 'title', t.title, 'kind', t.followup_kind, 'due_date', t.due_date,
                                      'assignee_id', t.assignee_id, 'assignee_name', u.full_name)
               FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
              WHERE t.crm_lead_id = l.id AND t.followup_kind IS NOT NULL AND t.completed_at IS NULL AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL
              ORDER BY (t.assignee_id = $2) DESC NULLS LAST, t.due_date LIMIT 1) AS next_followup,
            n.body AS latest_note, n.type = 'IMPORT_NOTE' AS latest_note_imported, n.occurred_at AS latest_note_at
       FROM crm_leads l
       LEFT JOIN LATERAL (
         SELECT a.body, a.type, a.occurred_at FROM crm_lead_activities a
          WHERE a.lead_id = l.id AND a.body IS NOT NULL AND a.type IN ('CALL', 'NOTE', 'CALL_STATUS', 'IMPORT_NOTE')
          ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) n ON TRUE
      WHERE l.id = ANY($1::int[])`,
    [leadIds, userId],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The counts of every group, and one page of one group (the first non-empty
 * one unless a group is asked for).
 */
export async function workQueue(viewer, { userId, bucket = null, page = 1, pageSize = 25 } = {}) {
  const scope = await crmScope(viewer);
  const settings = await salesSettings();
  const size = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
  const assigns = hasPermission(viewer, 'crm.assign');
  const buckets = WORK_BUCKETS.filter((b) => b !== 'unassigned' || assigns);
  const counts = {};
  for (const b of buckets) {
    const r = await listLeads({ ...bucketFilters(b, userId), page: 1, page_size: 1, userId }, scope);
    counts[b] = r.total;
  }
  const chosen = bucket && buckets.includes(bucket) ? bucket : buckets.find((b) => counts[b] > 0) || buckets[0];
  const list = await listLeads({ ...bucketFilters(chosen, userId), page, page_size: size, userId }, scope);
  const context = await rowContext(list.leads.map((l) => l.id), userId);
  return {
    timezone: settings.calendar?.timezone || 'Asia/Kolkata',
    user_id: userId,
    groups: buckets.map((b, i) => ({
      key: b, order: i + 1, label: LABEL[b][0], tone: LABEL[b][1], note: LABEL[b][2], count: counts[b],
      // the Leads list showing the same records
      filters: Object.fromEntries(Object.entries(bucketFilters(b, userId)).filter(([k]) => k !== 'sort')),
    })),
    bucket: chosen,
    page: list.page,
    page_size: list.page_size,
    total: list.total,
    leads: list.leads.map((l) => {
      const c = context.get(l.id) || {};
      return {
        ...l, next_followup: c.next_followup || null,
        latest_note: c.latest_note ? String(c.latest_note).slice(0, 300) : null, latest_note_imported: Boolean(c.latest_note_imported), latest_note_at: c.latest_note_at || null,
      };
    }),
  };
}
