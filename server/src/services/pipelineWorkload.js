/**
 * Who owes what in the pipeline, what is blocked, and what needs taking higher.
 *
 * Per person: the next actions they owe, their deal tasks, meetings waiting for
 * an outcome, handovers waiting for them to confirm, customer commitments on
 * their deals, and the blockers they are responsible for — each by when it is
 * due. Beside it, whether they are away, and their capacity as measured: open
 * work with no estimate is never read as spare time.
 *
 * Counts here say how much is on someone's plate. They are not a measure of how
 * well anyone is doing; outcomes are on the week's record, and people are listed
 * by name, never ranked by load.
 */

import { query } from '../db/pool.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { notify } from './activity.js';
import { logActivity } from './crm.js';
import { addDays, listAvailability } from './availability.js';
import { getSettings } from './settings.js';
import { today } from './dealRules.js';
import { workload as taskWorkload } from './metrics.js';
import { weekOf } from './weekly.js';
import { recordHistory } from './opportunities.js';

const dayOf = (value) => (value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : null);
const daysLate = (due, todayDate) => {
  if (!due || due >= todayDate) return 0;
  return Math.round((new Date(`${todayDate}T00:00:00Z`) - new Date(`${due}T00:00:00Z`)) / 86_400_000);
};

/** When something is due, in the buckets a person plans by. */
function bucketOf(due, todayDate, weekEnd) {
  if (!due) return 'undated';
  if (due < todayDate) return 'overdue';
  if (due === todayDate) return 'today';
  if (due <= weekEnd) return 'this_week';
  return 'later';
}

/**
 * The workload of everyone who answers for pipeline work, with the things that
 * need escalating. `departmentId` narrows it to a department.
 */
export async function pipelineWorkload({ departmentId = null } = {}) {
  const settings = await getSettings();
  const todayDate = today();
  const weekEnd = addDays(todayDate, 6);
  const escalateAfter = Number(settings.crm?.escalation?.afterDays) || 3;
  const confirmDays = Number(settings.crm?.handoverConfirmDays) || 2;
  const dept = departmentId ? Number(departmentId) : null;

  const [
    { rows: people }, { rows: actions }, { rows: tasks }, { rows: meetings }, { rows: handovers },
    { rows: commitments }, { rows: blockers }, leave, capacity, { rows: outcomes },
  ] = await Promise.all([
    query(
      `SELECT u.id, u.full_name, u.avatar_color, u.department_id, d.name AS department
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.is_active = TRUE AND ($1::int IS NULL OR u.department_id = $1::int)
        ORDER BY u.full_name`,
      [dept],
    ),
    // the next move on each live deal, owed by one person
    query(
      `SELECT o.id AS opportunity_id, o.name, o.account_id, a.name AS account_name, o.next_step,
              o.next_step_due, COALESCE(o.next_step_owner_id, o.owner_user_id) AS user_id,
              o.owner_user_id, o.escalation_owner_id, a.owner_user_id AS relationship_owner_id,
              o.waiting_on, o.waiting_until
         FROM opportunities o JOIN accounts a ON a.id = o.account_id
        WHERE o.is_archived = FALSE AND a.is_archived = FALSE AND o.status = 'ACTIVE'
          AND COALESCE(o.next_step_owner_id, o.owner_user_id) IS NOT NULL
          AND ($1::int IS NULL OR a.department_id = $1::int)`,
      [dept],
    ),
    query(
      `SELECT t.id, t.ref, t.title, t.due_date, t.assignee_id AS user_id, t.estimate_hours, t.blocked_reason,
              ws.stage, COALESCE(t.account_id, o.account_id) AS account_id, t.opportunity_id,
              a.name AS account_name, o.escalation_owner_id
         FROM tasks t
         JOIN workflow_statuses ws ON ws.id = t.status_id
         LEFT JOIN opportunities o ON o.id = t.opportunity_id
         LEFT JOIN accounts a ON a.id = COALESCE(t.account_id, o.account_id)
        WHERE t.is_archived = FALSE AND ws.stage NOT IN ('done','cancelled')
          AND (t.account_id IS NOT NULL OR t.opportunity_id IS NOT NULL)
          AND t.assignee_id IS NOT NULL
          AND ($1::int IS NULL OR a.department_id = $1::int)`,
      [dept],
    ),
    query(
      `SELECT m.id, m.title, m.scheduled_at, m.owner_user_id AS user_id, m.account_id, m.opportunity_id,
              a.name AS account_name
         FROM crm_meetings m JOIN accounts a ON a.id = m.account_id
        WHERE m.status = 'SCHEDULED' AND m.scheduled_at < now()
          AND ($1::int IS NULL OR a.department_id = $1::int)`,
      [dept],
    ),
    query(
      `SELECT h.id, h.role, h.created_at, h.to_user_id AS user_id, h.from_user_id, o.id AS opportunity_id,
              o.name, o.account_id, a.name AS account_name, o.escalation_owner_id, f.full_name AS from_name
         FROM opportunity_handovers h JOIN opportunities o ON o.id = h.opportunity_id
         JOIN accounts a ON a.id = o.account_id
         LEFT JOIN users f ON f.id = h.from_user_id
        WHERE h.acknowledged_at IS NULL AND h.to_user_id IS NOT NULL
          AND o.is_archived = FALSE AND o.status IN ('ACTIVE','ON_HOLD','NURTURE')
          AND ($1::int IS NULL OR a.department_id = $1::int)`,
      [dept],
    ),
    query(
      `SELECT c.id, c.what, c.due_on, c.account_id, c.opportunity_id, a.name AS account_name,
              o.name AS opportunity_name, COALESCE(o.owner_user_id, a.owner_user_id) AS user_id,
              o.escalation_owner_id
         FROM customer_commitments c JOIN accounts a ON a.id = c.account_id
         LEFT JOIN opportunities o ON o.id = c.opportunity_id
        WHERE c.status = 'OPEN' AND c.due_on IS NOT NULL AND a.is_archived = FALSE
          AND ($1::int IS NULL OR a.department_id = $1::int)`,
      [dept],
    ),
    query(
      `SELECT t.id, t.title, t.blocked_item, t.dependency, t.external_party, t.expected_resolution,
              t.responsible_user_id, t.entity_type, t.entity_id,
              COALESCE(o.account_id, CASE WHEN t.entity_type = 'ACCOUNT' THEN t.entity_id END) AS account_id,
              CASE WHEN t.entity_type = 'OPPORTUNITY' THEN t.entity_id END AS opportunity_id,
              a.name AS account_name, o.name AS opportunity_name,
              COALESCE(o.owner_user_id, a.owner_user_id) AS deal_owner_id, o.escalation_owner_id
         FROM discussion_threads t
         LEFT JOIN opportunities o ON t.entity_type = 'OPPORTUNITY' AND o.id = t.entity_id
         JOIN accounts a ON a.id = COALESCE(o.account_id, CASE WHEN t.entity_type = 'ACCOUNT' THEN t.entity_id END)
        WHERE t.kind = 'blocker' AND t.status = 'open' AND a.is_archived = FALSE
          AND ($1::int IS NULL OR a.department_id = $1::int)`,
      [dept],
    ),
    listAvailability({ from: todayDate, to: addDays(todayDate, 14) }),
    taskWorkload({ departmentId: dept }),
    // what moved this week on the deals each person owns: outcomes, beside the load
    query(
      `SELECT o.owner_user_id AS user_id,
              COUNT(*) FILTER (WHERE h.field = 'stage' AND h.is_reversal = FALSE)::int AS moved_forward
         FROM opportunity_history h JOIN opportunities o ON o.id = h.opportunity_id
        WHERE h.created_at >= $1 AND o.owner_user_id IS NOT NULL
        GROUP BY o.owner_user_id`,
      [`${weekOf(todayDate).start}T00:00:00+05:30`],
    ),
  ]);

  const byPerson = new Map(people.map((p) => [p.id, {
    user: p,
    away_today: null,
    leave_ahead: [],
    due: { overdue: [], today: [], this_week: [], later: [], undated: [] },
    blocked: [],
    capacity: null,
    moved_forward_this_week: 0,
  }]));
  const entryFor = (userId) => byPerson.get(userId) || null;

  for (const entry of leave) {
    const person = entryFor(entry.user_id);
    if (!person) continue;
    const coversToday = entry.start_date <= todayDate && entry.end_date >= todayDate;
    if (coversToday && entry.status !== 'HALF_DAY') person.away_today = entry;
    person.leave_ahead.push({
      status: entry.status, start_date: entry.start_date, end_date: entry.end_date, back_on: entry.back_on ?? null,
    });
  }
  for (const row of capacity) {
    const person = entryFor(row.id);
    if (!person) continue;
    person.capacity = {
      status: row.status, load_basis: row.load_basis, load_percent: row.load_percent,
      committed_hours: row.committed_hours, capacity_hours: row.capacity_hours,
      open_tasks: row.open_tasks, unestimated_tasks: row.unestimated_tasks,
    };
  }
  for (const row of outcomes) {
    const person = entryFor(row.user_id);
    if (person) person.moved_forward_this_week = row.moved_forward;
  }

  const escalations = [];
  const escalateTo = (row) => row.escalation_owner_id
    ?? (row.relationship_owner_id && row.relationship_owner_id !== row.user_id ? row.relationship_owner_id : null);

  const add = (userId, item) => {
    const person = entryFor(userId);
    if (!person) return;
    person.due[bucketOf(item.due, todayDate, weekEnd)].push(item);
  };

  for (const row of actions) {
    const due = dayOf(row.next_step_due);
    const item = {
      kind: 'next_action', title: row.next_step || 'No next action set', due, waiting: Boolean(row.waiting_on),
      opportunity_id: row.opportunity_id, account_id: row.account_id, deal: row.name, account_name: row.account_name,
      escalation_owner_id: escalateTo(row),
    };
    add(row.user_id, item);
    const late = daysLate(due, todayDate);
    if (late >= escalateAfter && !row.waiting_on) {
      escalations.push({ ...item, reason: `next action ${late} days overdue`, owner_user_id: row.user_id,
        escalate_to: item.escalation_owner_id });
    }
  }
  for (const row of tasks) {
    const item = {
      kind: 'task', title: `${row.ref} ${row.title}`, due: dayOf(row.due_date), task_id: row.id,
      opportunity_id: row.opportunity_id, account_id: row.account_id, account_name: row.account_name,
      estimated: Number(row.estimate_hours) > 0, escalation_owner_id: row.escalation_owner_id ?? null,
    };
    if (row.stage === 'blocked' || row.blocked_reason) {
      entryFor(row.user_id)?.blocked.push({ ...item, kind: 'blocked_task', why: row.blocked_reason || 'marked blocked' });
    }
    add(row.user_id, item);
  }
  for (const row of meetings) {
    add(row.user_id, {
      kind: 'meeting_outcome', title: `Say what came of: ${row.title}`, due: dayOf(row.scheduled_at),
      account_id: row.account_id, opportunity_id: row.opportunity_id, account_name: row.account_name,
    });
  }
  for (const row of handovers) {
    const since = dayOf(row.created_at);
    const item = {
      kind: 'handover', title: `Confirm you have ${row.role === 'OWNER' ? 'the deal' : row.role === 'NEXT_ACTION' ? 'the next move' : 'escalations'}${row.from_name ? ` from ${row.from_name}` : ''}`,
      due: addDays(since, confirmDays), opportunity_id: row.opportunity_id, account_id: row.account_id,
      deal: row.name, account_name: row.account_name,
    };
    add(row.user_id, item);
    if (daysLate(item.due, todayDate) > 0) {
      escalations.push({ ...item, reason: 'handover not confirmed', owner_user_id: row.user_id,
        escalate_to: row.escalation_owner_id ?? row.from_user_id ?? null });
    }
  }
  for (const row of commitments) {
    const due = dayOf(row.due_on);
    const item = {
      kind: 'commitment', title: `They committed to: ${row.what}`, due, opportunity_id: row.opportunity_id,
      account_id: row.account_id, deal: row.opportunity_name, account_name: row.account_name,
      escalation_owner_id: row.escalation_owner_id ?? null,
    };
    add(row.user_id, item);
    const late = daysLate(due, todayDate);
    if (late >= escalateAfter) {
      escalations.push({ ...item, reason: `customer commitment ${late} days overdue`, owner_user_id: row.user_id,
        escalate_to: row.escalation_owner_id ?? null });
    }
  }
  for (const row of blockers) {
    const due = dayOf(row.expected_resolution);
    const item = {
      kind: 'blocker', title: row.blocked_item || row.title || 'A blocker', due,
      on: row.dependency === 'EXTERNAL' ? (row.external_party || 'someone outside') : row.dependency === 'INTERNAL' ? 'us' : null,
      opportunity_id: row.opportunity_id, account_id: row.account_id, deal: row.opportunity_name,
      account_name: row.account_name, thread_id: row.id,
    };
    const responsible = row.responsible_user_id ?? row.deal_owner_id;
    entryFor(responsible)?.blocked.push(item);
    if (row.deal_owner_id && row.deal_owner_id !== responsible) entryFor(row.deal_owner_id)?.blocked.push({ ...item, mine: false });
    if (daysLate(due, todayDate) > 0) {
      escalations.push({ ...item, reason: 'blocker past its expected date', owner_user_id: responsible,
        escalate_to: row.escalation_owner_id ?? null });
    }
  }

  // someone away with work falling due while they are gone: cover is needed
  for (const person of byPerson.values()) {
    if (!person.away_today) continue;
    const backOn = person.away_today.back_on || addDays(person.away_today.end_date, 1);
    const pressing = [...person.due.overdue, ...person.due.today, ...person.due.this_week]
      .filter((item) => item.due && item.due < backOn && item.kind !== 'handover');
    for (const item of pressing) {
      escalations.push({ ...item, reason: `owed by ${person.user.full_name}, away until ${backOn}`,
        owner_user_id: person.user.id, cover_needed: true, escalate_to: item.escalation_owner_id ?? null });
    }
  }

  // who escalations go to, by name; and what was already taken higher today
  const names = new Map(people.map((p) => [p.id, p.full_name]));
  const { rows: sentToday } = await query(
    `SELECT entity_id, event_key FROM crm_nudge_events
      WHERE kind = 'escalation' AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`,
  );
  const escalatedToday = new Set(sentToday.map((r) => r.entity_id));
  for (const item of escalations) {
    item.owner_name = names.get(item.owner_user_id) || null;
    item.escalate_to_name = item.escalate_to ? names.get(item.escalate_to) || null : null;
    item.escalated_today = Boolean(item.opportunity_id && escalatedToday.has(item.opportunity_id));
  }
  escalations.sort((a, b) => (a.due || '').localeCompare(b.due || ''));

  const sortDue = (list) => list.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  const result = [...byPerson.values()].map((person) => {
    for (const key of Object.keys(person.due)) sortDue(person.due[key]);
    return {
      ...person,
      counts: {
        overdue: person.due.overdue.length,
        today: person.due.today.length,
        this_week: person.due.this_week.length,
        blocked: person.blocked.filter((b) => b.mine !== false).length,
      },
    };
  }).filter((person) => Object.values(person.due).some((list) => list.length) || person.blocked.length);

  return {
    as_of: new Date().toISOString(),
    today: todayDate,
    escalate_after_days: escalateAfter,
    people: result,
    escalations,
  };
}

/**
 * Takes a deal to its escalation point (or someone named): they are told once a
 * day at most, and the deal's history says who escalated it, to whom, and why.
 */
export async function escalateDeal(client, { opportunity, toUserId = null, reason, actor }) {
  const why = String(reason || '').trim();
  if (why.length < 5) throw badRequest('Say what needs deciding or unblocking');
  const target = toUserId ?? opportunity.escalation_owner_id ?? null;
  if (!target) throw badRequest('This deal has no escalation point — name who to take it to');
  if (target === actor.id) throw badRequest('You cannot escalate to yourself');
  const { rows: people } = await client.query('SELECT id, full_name, is_active FROM users WHERE id = $1', [target]);
  if (!people[0]?.is_active) throw badRequest('The person to escalate to must be an active user');

  const day = today();
  const { rows: fresh } = await client.query(
    `INSERT INTO crm_nudge_events (event_key, user_id, kind, entity_type, entity_id)
     VALUES ($1, $2, 'escalation', 'OPPORTUNITY', $3)
     ON CONFLICT (event_key) DO NOTHING RETURNING id`,
    [`escalation:${opportunity.id}:${target}:${day}`, target, opportunity.id],
  );
  if (!fresh[0]) throw badRequest(`Already escalated to ${people[0].full_name} today`);

  await recordHistory(client, {
    opportunityId: opportunity.id, field: 'escalated_to_user_id', from: null, to: target,
    reason: why, actorId: actor.id,
  });
  await logActivity(client, {
    accountId: opportunity.account_id, opportunityId: opportunity.id, type: 'NOTE', actorId: actor.id,
    subject: `${opportunity.name}: escalated to ${people[0].full_name}`, body: why,
    direction: 'INTERNAL', isExternal: false, source: 'MANUAL',
  });
  await notify(client, {
    userId: target,
    type: 'crm_escalation',
    title: `${actor.full_name} escalated ${opportunity.name} to you`,
    body: why.slice(0, 280),
    accountId: opportunity.account_id,
  });
  return { escalated_to: { id: target, full_name: people[0].full_name } };
}

/** Whether this person may take a deal higher: whoever works on it, or a pipeline manager. */
export function mustBeAbleToEscalate(user, canWork) {
  if (canWork || hasPermission(user, 'crm.manage.any')) return;
  throw forbidden('Only someone working on this deal, or a pipeline manager, can escalate it');
}
