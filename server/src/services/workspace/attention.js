/**
 * Needs attention: one queue for one person, gathered from every module
 * through one contract. Each module keeps its own rule (deadline health for
 * tasks, the next-action rules for deals, the OKR attention engine, the
 * pending-calls query); nothing is re-derived here.
 *
 * Item:
 *   { key, kind, title, reason, record: { type, id, label, url }, related,
 *     when: { at | date, dateOnly, timezone }, tier, action: { label, kind } }
 *
 * Order (no hidden score):
 *   1  fixed deadlines passed or due today, and meetings today
 *   2  overdue commitments (tasks, follow-ups, deal actions)
 *   3  decisions waiting on me
 *   4  due in the next 3 days
 *   5  records with no next action
 *   6  everything else, by date
 *
 * Every contributor reads only what the person owns or decides, so a label
 * never shows a record they cannot see. Personal snoozes hide an item from
 * this person's queue only; the record and its dates are untouched.
 */
import { query } from '../../db/pool.js';
import { hasPermission, tracksAttendance } from '../../lib/permissions.js';
import { deadlineClock } from '../deadlines.js';
import { addDays, healthLabel, localDate } from '../../../../shared/deadlineHealth.js';
import { getSettings } from '../settings.js';
import { nextActionGaps } from '../dealRules.js';
import { pendingCalls } from '../sales/phoneCalls.js';
import { analyse } from '../okrInsights.js';
import { decisionsFor } from './decisions.js';

export const TIER_WORDS = {
  1: 'Due now: deadlines passed or due today, and meetings today',
  2: 'Overdue commitments: tasks, follow-ups and deal actions',
  3: 'Decisions waiting on you',
  4: 'Due in the next 3 days',
  5: 'No next action recorded',
  6: 'Everything else, by date',
};

const item = (x) => ({ related: [], action: null, ...x });
const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/** Tasks the person owns, by deadline health; CRM follow-ups are their own kind. */
async function taskItems(user, ctx) {
  const { rows } = await query(
    `SELECT t.id, t.ref, t.title, t.due_date, t.review_date, t.deferral_id, t.followup_kind, t.crm_lead_id, t.opportunity_id,
            s.stage, l.organization_name AS lead_org, l.contact_name AS lead_contact
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
       LEFT JOIN crm_leads l ON l.id = t.crm_lead_id
      WHERE t.assignee_id = $1 AND t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled')
        AND (t.due_date IS NULL OR t.due_date < $2::timestamptz + interval '3 days' OR t.review_date <= $3::date)`,
    [user.id, ctx.c.now, ctx.c.today],
  );
  const out = [];
  for (const t of rows) {
    if (t.followup_kind && !ctx.crm) continue;
    const h = healthLabel(t, ctx.c);
    const when = t.due_date ? { at: t.due_date, dateOnly: false, timezone: ctx.c.timezone } : { date: dayOf(t.review_date), dateOnly: true };
    if (t.followup_kind) {
      const who = t.lead_org || t.lead_contact || t.title;
      if (!['OVERDUE', 'DUE_TODAY', 'DUE_SOON'].includes(h.code)) continue;
      out.push(item({
        key: `FOLLOWUP_DUE:TASK:${t.id}:${dayOf(t.due_date)}`, kind: 'FOLLOWUP_DUE', overdue: h.code === 'OVERDUE', dueToday: h.code === 'DUE_TODAY',
        title: `Follow up: ${who}`, reason: h.text,
        record: { type: 'LEAD', id: t.crm_lead_id, label: who, url: t.crm_lead_id ? `/sales/leads/${t.crm_lead_id}` : `/?task=${t.id}` },
        related: [{ type: 'TASK', id: t.id }], when, tier: h.code === 'OVERDUE' ? 2 : h.code === 'DUE_TODAY' ? 1 : 4,
        action: { label: 'Open the lead', kind: 'OPEN' },
      }));
      continue;
    }
    if (t.stage === 'blocked') continue; // shown under Waiting on others, with what it waits on
    const base = { record: { type: 'TASK', id: t.id, label: `${t.ref} ${t.title}`, url: `/?task=${t.id}` }, when };
    if (h.code === 'OVERDUE') out.push(item({ ...base, key: `TASK_OVERDUE:TASK:${t.id}:${dayOf(t.due_date)}`, kind: 'TASK_OVERDUE', overdue: true, title: 'Finish or re-date this task', reason: h.text, tier: 2, action: { label: 'Open the task', kind: 'OPEN' } }));
    else if (h.code === 'DUE_TODAY') out.push(item({ ...base, key: `TASK_DUE_TODAY:TASK:${t.id}:${dayOf(t.due_date)}`, kind: 'TASK_DUE_TODAY', dueToday: true, title: 'Due today', reason: h.text, tier: 1, action: { label: 'Open the task', kind: 'OPEN' } }));
    else if (h.code === 'DUE_SOON') out.push(item({ ...base, key: `TASK_DUE_SOON:TASK:${t.id}:${dayOf(t.due_date)}`, kind: 'TASK_DUE_SOON', title: 'Coming up', reason: h.text, tier: 4, action: { label: 'Open the task', kind: 'OPEN' } }));
    else if (h.code === 'REVIEW_DUE') out.push(item({ ...base, key: `TASK_REVIEW:TASK:${t.id}:${dayOf(t.review_date) || 'none'}`, kind: 'TASK_REVIEW', title: 'Review this deferred task', reason: h.text, tier: 6, action: { label: 'Open the task', kind: 'OPEN' } }));
  }
  return out;
}

/** Calls the person made that still need an outcome (the pending-calls query). */
async function callItems(user, ctx) {
  if (!ctx.crm || !hasPermission(user, 'crm.activity.log')) return [];
  return (await pendingCalls(user.id)).map((c) => item({
    key: `CALL_TO_DESCRIBE:CALL:${c.id}:0`, kind: 'CALL_TO_DESCRIBE',
    title: 'Say how the call went', reason: 'No outcome recorded yet',
    record: { type: 'LEAD', id: c.lead_id, label: c.about || c.contact_name || c.lead_ref || 'A call', url: c.lead_id ? `/sales/leads/${c.lead_id}` : '/sales?tab=day' },
    when: { at: c.started_at || c.dialled_at, dateOnly: false, timezone: ctx.c.timezone }, tier: 2,
    action: { label: 'Describe the call', kind: 'OPEN' },
  }));
}

/**
 * Deals the person owns: the next-action rules (missing, overdue), waiting
 * that has reached its date, and a revisit that is due. A next step tracked by
 * a task gives one item, linked to both.
 */
async function dealItems(user, ctx) {
  if (!ctx.crm) return [];
  const { rows } = await query(
    `SELECT o.id, o.name, o.account_id, o.status, o.next_step, o.next_step_due, o.next_step_owner_id, o.next_step_task_id,
            o.next_action_absent_reason, o.waiting_on, o.waiting_until, o.revisit_on, o.pipeline_id,
            a.name AS account_name, s.kind AS stage_kind, p.category AS pipeline_category,
            nt.id AS task_id, nt.ref AS task_ref, ns.stage AS task_stage, nt.due_date AS task_due
       FROM opportunities o JOIN accounts a ON a.id = o.account_id
       LEFT JOIN account_stages s ON s.id = o.stage_id
       LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id
       LEFT JOIN tasks nt ON nt.id = o.next_step_task_id AND nt.is_archived = FALSE
       LEFT JOIN workflow_statuses ns ON ns.id = nt.status_id
      WHERE o.owner_user_id = $1 AND o.is_archived = FALSE AND a.is_archived = FALSE
        AND o.status IN ('ACTIVE', 'ON_HOLD', 'NURTURE')`,
    [user.id],
  );
  const out = [];
  for (const o of rows) {
    const label = `${o.name} · ${o.account_name}`;
    const record = { type: o.pipeline_category === 'APPLICATIONS' ? 'APPLICATION' : 'DEAL', id: o.id, label, url: o.pipeline_category === 'APPLICATIONS' ? `/applications/${o.id}` : `/accounts/${o.account_id}?deal=${o.id}` };
    if (o.pipeline_category === 'APPLICATIONS') continue; // applications have their own rules (Part D)
    const taskOpen = o.task_id && !['done', 'cancelled'].includes(o.task_stage);
    const related = taskOpen ? [{ type: 'TASK', id: o.task_id }] : [];
    if (o.status === 'ACTIVE' && o.stage_kind === 'open') {
      const gaps = nextActionGaps(o, { todayDate: ctx.c.today });
      const due = dayOf(o.next_step_due);
      if (gaps.some((g) => g.kind === 'no_next_action')) {
        if (!o.next_action_absent_reason && !o.waiting_on) {
          out.push(item({ key: `DEAL_NO_NEXT_ACTION:DEAL:${o.id}:0`, kind: 'DEAL_NO_NEXT_ACTION', title: 'Choose the next action', reason: 'None recorded', record, tier: 5, when: {}, action: { label: 'Set the next action', kind: 'OPEN' } }));
        }
      } else if (gaps.some((g) => g.kind === 'next_action_overdue')) {
        out.push(item({ key: `DEAL_ACTION_DUE:DEAL:${o.id}:${due}`, kind: 'DEAL_ACTION_DUE', overdue: true, title: `Do the next action: ${o.next_step}`, reason: `Was due ${due}`, record, related, tier: 2, when: { date: due, dateOnly: true }, action: { label: 'Open the deal', kind: 'OPEN' } }));
      } else if (due && due <= addDays(ctx.c.today, 3)) {
        out.push(item({ key: `DEAL_ACTION_DUE:DEAL:${o.id}:${due}`, kind: 'DEAL_ACTION_DUE', dueToday: due === ctx.c.today, title: `Next action: ${o.next_step}`, reason: due === ctx.c.today ? 'Due today' : `Due ${due}`, record, related, tier: due === ctx.c.today ? 1 : 4, when: { date: due, dateOnly: true }, action: { label: 'Open the deal', kind: 'OPEN' } }));
      }
    }
    const waitDue = o.status === 'ACTIVE' && o.waiting_on && o.waiting_until && dayOf(o.waiting_until) <= ctx.c.today;
    if (waitDue) out.push(item({ key: `DEAL_WAITING_DUE:DEAL:${o.id}:${dayOf(o.waiting_until)}`, kind: 'DEAL_WAITING_DUE', overdue: dayOf(o.waiting_until) < ctx.c.today, dueToday: dayOf(o.waiting_until) === ctx.c.today, title: `Check in with ${o.waiting_on}`, reason: `They were expected by ${dayOf(o.waiting_until)}`, record, tier: 2, when: { date: dayOf(o.waiting_until), dateOnly: true }, action: { label: 'Open the deal', kind: 'OPEN' } }));
    const revisit = ['ON_HOLD', 'NURTURE'].includes(o.status) && o.revisit_on && dayOf(o.revisit_on) <= ctx.c.today;
    if (revisit) out.push(item({ key: `DEAL_REVISIT:DEAL:${o.id}:${dayOf(o.revisit_on)}`, kind: 'DEAL_REVISIT', overdue: dayOf(o.revisit_on) < ctx.c.today, dueToday: dayOf(o.revisit_on) === ctx.c.today, title: 'Revisit this deal', reason: `Revisit date ${dayOf(o.revisit_on)}`, record, tier: 2, when: { date: dayOf(o.revisit_on), dateOnly: true }, action: { label: 'Open the deal', kind: 'OPEN' } }));
  }
  return out;
}

/** The person's key results that need a check-in or are behind (the OKR attention engine). */
async function keyResultItems(user, ctx) {
  if (!ctx.okr || !hasPermission(user, 'okr.view')) return [];
  const { attention } = await analyse({});
  return attention.filter((s) => s.entity_type === 'KEY_RESULT' && s.owner_user_id === user.id).map((s) => item({
    key: `KR_CHECK_IN:KEY_RESULT:${s.key_result_id}:${s.kind}`, kind: 'KR_CHECK_IN',
    title: s.kind === 'key_result_stale' ? 'Check in on this key result' : 'This key result needs a look',
    reason: `It ${s.detail}`,
    record: { type: 'KEY_RESULT', id: s.key_result_id, label: s.title, url: `/goals/${s.objective_id}` },
    when: {}, tier: 6, action: { label: 'Check in', kind: 'OPEN' },
  }));
}

/** Today's standup, if the person takes part and has not posted. */
async function standupItems(user, ctx) {
  if (!tracksAttendance(user)) return [];
  const { mine } = await import('../standup.js');
  const s = await mine(user.id, ctx.c.now).catch(() => null);
  if (!s?.enabled || !s.working_day || !s.members?.length || s.submissions?.length) return [];
  return [item({
    key: `STANDUP_DUE:STANDUP:${user.id}:${s.date}`, kind: 'STANDUP_DUE', dueToday: true, title: 'Post today\'s standup', reason: `Due by ${s.deadline}`,
    record: { type: 'STANDUP', id: user.id, label: 'Daily standup', url: '/standup' }, when: { date: s.date, dateOnly: true }, tier: 1,
    action: { label: 'Post it', kind: 'OPEN' },
  })];
}

/** Decisions waiting on the person, each one item in tier 3. */
async function decisionItems(user, ctx) {
  return (await decisionsFor(user, { now: ctx.c.now })).map((d) => item({
    key: d.key, kind: 'DECISION', title: d.label, reason: d.who ? `${d.what}, asked by ${d.who}` : d.what,
    record: { type: 'DECISION', id: d.id, label: d.what, url: d.url }, when: { at: d.since, dateOnly: false }, tier: 3,
    action: { label: 'Decide', kind: 'OPEN' }, decision: d,
  }));
}

const CONTRIBUTORS = [taskItems, callItems, dealItems, keyResultItems, standupItems, decisionItems];

/** Other parts of the workspace (applications, meetings, personal reminders) add their own. */
export function addContributor(fn) { if (!CONTRIBUTORS.includes(fn)) CONTRIBUTORS.push(fn); }

/**
 * One deal or application late on a next step its task tracks: one item,
 * linked to both. The task's own item is folded into the record's.
 */
export function foldTracked(items) {
  const tracked = new Map();
  for (const it of items) for (const r of it.related || []) if (r.type === 'TASK') tracked.set(r.id, it);
  return items.filter((it) => !(it.record.type === 'TASK' && tracked.has(it.record.id)));
}

const sortTime = (it) => {
  if (it.when?.at) return new Date(it.when.at).getTime();
  if (it.when?.date) return Date.parse(`${it.when.date}T00:00:00Z`);
  return Number.MAX_SAFE_INTEGER;
};

export function orderItems(items) {
  return [...items].sort((a, b) => a.tier - b.tier || sortTime(a) - sortTime(b) || String(a.key).localeCompare(String(b.key)));
}

/** The lists a person can open; each count is the length of its list. */
export const VIEWS = {
  today: (it) => it.tier <= 3,
  coming: (it) => it.tier === 4 || (it.tier === 6 && sortTime(it) >= Date.now()),
  overdue: (it) => Boolean(it.overdue),
  due_today: (it) => Boolean(it.dueToday),
  decisions: (it) => it.kind === 'DECISION',
  all: () => true,
};
export const VIEW_LABEL = {
  today: 'Today & overdue', coming: 'Coming up', overdue: 'Overdue', due_today: 'Due today', decisions: 'Decisions', all: 'All',
};

/** Everything that needs the person, ordered, with their own snoozes applied. */
export async function attentionFor(user, { now = new Date(), view = 'all', includeSnoozed = false } = {}) {
  const settings = await getSettings();
  const c = await deadlineClock(now, settings);
  const ctx = {
    c, now,
    crm: settings.crm?.enabled !== false && hasPermission(user, 'crm.view'),
    okr: settings.okr?.enabled !== false,
  };
  const parts = await Promise.all(CONTRIBUTORS.map((fn) => fn(user, ctx).catch((err) => {
    console.error(`[taskflow] attention: ${fn.name} failed:`, err.message);
    return { failed: fn.name };
  })));
  const failed = parts.filter((p) => p && p.failed).map((p) => p.failed);
  let items = foldTracked(parts.filter(Array.isArray).flat());
  const seen = new Set();
  items = items.filter((it) => (seen.has(it.key) ? false : seen.add(it.key)));
  const { rows: snoozes } = await query('SELECT item_key, until FROM attention_snoozes WHERE user_id = $1 AND until > $2', [user.id, now]);
  const snoozed = new Map(snoozes.map((s) => [s.item_key, s.until]));
  items = items.map((it) => (snoozed.has(it.key) ? { ...it, snoozed_until: snoozed.get(it.key) } : it));
  const visible = includeSnoozed ? items : items.filter((it) => !it.snoozed_until);
  const filter = VIEWS[view] || VIEWS.all;
  const ordered = orderItems(visible.filter(filter));
  return {
    items: ordered,
    total: ordered.length,
    snoozed: items.filter((it) => it.snoozed_until).length,
    counts: Object.fromEntries(Object.entries(VIEWS).map(([k, fn]) => [k, visible.filter(fn).length])),
    tiers: TIER_WORDS,
    timezone: user.timezone || c.timezone,
    today: c.today,
    failed,
  };
}

/** A personal snooze: hides one item from this person's queue until then. */
export async function snoozeItem(user, key, until) {
  await query(
    `INSERT INTO attention_snoozes (user_id, item_key, until) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, item_key) DO UPDATE SET until = EXCLUDED.until, created_at = now()`,
    [user.id, String(key).slice(0, 200), until],
  );
}

export async function unsnoozeItem(user, key) {
  await query('UPDATE attention_snoozes SET until = now() WHERE user_id = $1 AND item_key = $2', [user.id, String(key).slice(0, 200)]);
}

export { localDate };
