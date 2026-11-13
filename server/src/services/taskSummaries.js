/**
 * The daily summaries in Google Chat (and in the TaskFlow bell for anyone
 * Chat cannot reach), and the weekly backlog review.
 *
 *   Personal     every working day, to everyone with open work: Overdue, Today,
 *                Upcoming (3 working days), Blocked, Review due, Needs a date,
 *                what they support, what they cover for someone who cannot be
 *                reached, work in their departments that needs an owner, and
 *                what waits for their decision. Later and deferred work is
 *                counted, so every open task is mentioned.
 *   Department   overdue work by owner, work that needs an owner, work due
 *                today, who is away (never why) and who is not connected.
 *   Backlog      on the first working day of the week: review dates that have
 *                come, Backlog without a review date, Backlog without an owner.
 *
 * Holidays, leave and each person's own days off are respected. A morning the
 * server missed is sent later the same day, marked late; one it could not
 * send at all is recorded as missed. Every summary has one log row per
 * recipient and day (reminder_summary_log): queued, bell only, skipped (with
 * the reason) or "would send"; whether Chat delivered it is read from the
 * outbox. "Skipped" is never stored as "sent".
 */
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { effectivePermissions } from '../lib/permissions.js';
import { chatLink as chatAnchor, chatText } from '../lib/googleChat.js';
import { getSettings } from './settings.js';
import { currentPolicy } from './attendancePolicy.js';
import { visibleUserIds } from './attendance.js';
import { deadlineClock } from './deadlines.js';
import { addDays, healthLabel, healthOf, weekdayOf } from '../../../shared/deadlineHealth.js';
import { awayAt, chatRoute, hhmm, offWords, reminderSettings, taskUrl } from './taskReminders.js';
import { fallbackPeople, managedDepartmentIds, waitingForDecision } from './taskPeople.js';

const app = (path = '/') => `${config.publicUrl}${path}`;
const MAX = 6;

const TASK_COLUMNS = `t.id, t.ref, t.title, t.due_date, t.review_date, t.deferral_id, t.next_action, t.assignee_id, t.department_id,
  t.follower_id, s.stage, s.name AS status_name, u.full_name AS owner_name, u.is_active AS owner_active`;

/** One line for a task: the link, its deadline health, and what is next. */
export function summaryLine(t, c, { owner = false } = {}) {
  const h = healthLabel(t, c);
  const ref = t.ref ? `${t.ref} ` : '';
  const extra = [h.text, t.stage === 'blocked' ? 'blocked' : null, owner ? (t.owner_name || 'no owner') : null].filter(Boolean).join(' · ');
  return `• ${chatAnchor(taskUrl(t.id), `${ref}${t.title}`)} — ${chatText(extra)}${t.next_action ? `\n   Next: ${chatText(String(t.next_action).slice(0, 120))}` : ''}`;
}

const section = (title, tasks, c, opts = {}) => {
  if (!tasks.length) return [];
  const lines = [`\n*${title} (${tasks.length})*`, ...tasks.slice(0, opts.max || MAX).map((t) => summaryLine(t, c, opts))];
  if (tasks.length > (opts.max || MAX)) lines.push(`…and ${tasks.length - (opts.max || MAX)} more: ${app(opts.more || '/my-tasks')}`);
  return lines;
};

/** Splits a person's open tasks into the summary's sections (one each). */
export function sortForSummary(tasks, c) {
  const out = { overdue: [], today: [], soon: [], blocked: [], review: [], undated: [], later: [], deferred: [] };
  for (const t of tasks) {
    const code = healthOf(t, c).code;
    if (code === 'DONE') continue;
    if (t.stage === 'blocked') out.blocked.push(t);
    else if (code === 'OVERDUE') out.overdue.push(t);
    else if (code === 'DUE_TODAY') out.today.push(t);
    else if (code === 'DUE_SOON') out.soon.push(t);
    else if (code === 'REVIEW_DUE') out.review.push(t);
    else if (code === 'NO_DEADLINE') out.undated.push(t);
    else if (code === 'REVIEW_LATER') out.deferred.push(t);
    else out.later.push(t);
  }
  return out;
}

async function openTasksWhere(where, params) {
  const { rows } = await query(
    `SELECT ${TASK_COLUMNS} FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.is_archived = FALSE AND s.stage NOT IN ('done', 'cancelled') AND ${where}
      ORDER BY t.due_date NULLS LAST, t.id`,
    params,
  );
  return rows;
}

/**
 * One person's summary for today. `covering` lists the people this person is
 * the fallback for today, with why. Returns null when there is nothing to say.
 */
export async function personalSummary(userId, { now = new Date(), c = null, covering = [], force = false } = {}) {
  const { rows: users } = await query(
    'SELECT id, full_name, role, extra_permissions, revoked_permissions, department_id FROM users WHERE id = $1 AND is_active',
    [userId],
  );
  const user = users[0];
  if (!user) return null;
  const clock = c || await deadlineClock(now);
  const tz = clock.timezone;
  const today = clock.today;

  const owned = sortForSummary(await openTasksWhere('t.assignee_id = $1', [userId]), clock);
  const supporting = await openTasksWhere(
    `t.assignee_id IS DISTINCT FROM $1 AND (t.follower_id = $1 OR EXISTS (SELECT 1 FROM task_collaborators tc WHERE tc.task_id = t.id AND tc.user_id = $1))`,
    [userId],
  );
  const supportSplit = sortForSummary(supporting, clock);
  const supportUrgent = [...supportSplit.overdue, ...supportSplit.today, ...supportSplit.blocked];

  // work in the departments this person manages that has nobody to carry it
  const managed = await managedDepartmentIds(user);
  const unowned = managed.length
    ? await openTasksWhere('t.department_id = ANY($1::int[]) AND (t.assignee_id IS NULL OR u.is_active = FALSE)', [managed])
    : [];

  // people this person covers today: what needs attention before they are back
  const coverBlocks = [];
  const coveredIds = [];
  for (const p of covering) {
    const theirs = sortForSummary(await openTasksWhere('t.assignee_id = $1', [p.id]), clock);
    const urgent = [...theirs.overdue, ...theirs.today, ...theirs.blocked, ...(p.away ? theirs.soon.filter((t) => !p.back || new Date(t.due_date) < new Date(`${p.back}T00:00:00Z`)) : [])];
    const all = Object.values(theirs).flat();
    coveredIds.push(...all.map((t) => t.id));
    coverBlocks.push(`\n*Covering for ${chatText(p.full_name)}* (${chatText(p.why)})`);
    if (urgent.length) coverBlocks.push(...urgent.slice(0, MAX).map((t) => summaryLine(t, clock)));
    else coverBlocks.push('Nothing needs attention before they are back.');
    if (all.length > urgent.length) coverBlocks.push(`${all.length - urgent.length} more of theirs, not due yet: ${app(`/board?assignee_id=${p.id}`)}`);
  }

  // decisions waiting on this person
  const perms = effectivePermissions(user);
  let leaveWaiting = 0;
  let correctionsWaiting = 0;
  if (perms.includes('leave.approve') || perms.includes('attendance.approve')) {
    const ids = await visibleUserIds(user);
    if (perms.includes('leave.approve')) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM leave_requests WHERE status IN ('SUBMITTED', 'EMERGENCY_REVIEW', 'NOTICE_EXCEPTION')
            AND user_id <> $1 AND ($2::int[] IS NULL OR user_id = ANY($2::int[]))`,
        [userId, ids],
      );
      leaveWaiting = rows[0].n;
    }
    if (perms.includes('attendance.approve')) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM attendance_corrections WHERE status = 'PENDING'
            AND user_id <> $1 AND ($2::int[] IS NULL OR user_id = ANY($2::int[]))`,
        [userId, ids],
      );
      correctionsWaiting = rows[0].n;
    }
  }
  const waiting = await waitingForDecision(user);

  // a check-in nudge only once attendance has started, and only if not done
  let checkIn = false;
  const policy = (await currentPolicy()).config;
  if (policy.startDate && today >= policy.startDate && policy.workingDays.includes(weekdayOf(today))) {
    const { rows } = await query(
      `SELECT
         EXISTS (SELECT 1 FROM attendance_sessions WHERE user_id = $1 AND work_date = $2) AS checked_in,
         COALESCE((SELECT attendance_required FROM employee_work_profiles WHERE user_id = $1), TRUE) AS required,
         EXISTS (SELECT 1 FROM leave_requests WHERE user_id = $1 AND status IN ('APPROVED_PAID', 'APPROVED_UNPAID')
                  AND $2::date BETWEEN start_date AND end_date) AS on_leave`,
      [userId, today],
    );
    checkIn = rows[0].required && !rows[0].checked_in && !rows[0].on_leave && user.role !== 'super_admin';
  }

  const ownedAll = Object.values(owned).flat();
  const decisions = leaveWaiting + correctionsWaiting + waiting.changes + waiting.blocks + waiting.appeals;
  if (!force && !ownedAll.length && !supporting.length && !covering.length && !unowned.length && !decisions && !checkIn) return null;

  const first = user.full_name.split(' ')[0];
  const lines = [`*Good morning, ${chatText(first)}* — ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(now)}`];
  if (checkIn) lines.push(`\n⏱ Remember to *Check In / Start Work*: ${app('/')}`);
  lines.push(
    ...section('Overdue', owned.overdue, clock),
    ...section('Due today', owned.today, clock),
    ...section('Upcoming, next 3 working days', owned.soon, clock),
    ...section('Blocked', owned.blocked, clock),
    ...section('Review due', owned.review, clock),
    ...section('Needs a date', owned.undated, clock),
  );
  if (supportUrgent.length) {
    lines.push(...section('Supporting (the owner carries the deadline)', supportUrgent, clock, { owner: true, max: 4 }));
  }
  if (supporting.length > supportUrgent.length) lines.push(`You also support ${supporting.length - supportUrgent.length} other open task(s).`);
  lines.push(...coverBlocks);
  if (unowned.length) lines.push(...section('Needs an owner in your departments', unowned, clock, { owner: true, max: 5, more: '/board?assignee_id=none' }));
  const decisionParts = [
    leaveWaiting && `${leaveWaiting} leave request${leaveWaiting === 1 ? '' : 's'}`,
    correctionsWaiting && `${correctionsWaiting} attendance correction${correctionsWaiting === 1 ? '' : 's'}`,
    waiting.changes && `${waiting.changes} deadline change${waiting.changes === 1 ? '' : 's'} or deferral${waiting.changes === 1 ? '' : 's'}`,
    waiting.blocks && `${waiting.blocks} block${waiting.blocks === 1 ? '' : 's'} to accept`,
    waiting.appeals && `${waiting.appeals} black-mark appeal${waiting.appeals === 1 ? '' : 's'}`,
  ].filter(Boolean);
  if (decisionParts.length) {
    lines.push(`\n*Waiting for your decision:* ${decisionParts.join(', ')} — ${chatAnchor(app('/review'), 'review')}`);
  }
  if (owned.later.length) {
    lines.push(`\nLater: ${owned.later.length} more open task${owned.later.length === 1 ? '' : 's'}, the next due ${healthLabel(owned.later[0], clock).text.replace(/^Due /, '')}.`);
  }
  if (owned.deferred.length) lines.push(`Deferred or scheduled for review: ${owned.deferred.length}.`);
  if (lines.length === 1 || (ownedAll.length === 0 && !supporting.length && !covering.length && !unowned.length && !decisionParts.length && !checkIn)) {
    lines.push('\nNothing due today, nothing overdue, and nothing waiting for you.');
  }
  lines.push(`\nYour day in TaskFlow: ${app('/my-tasks')}`);
  return {
    text: lines.join('\n'),
    items: ownedAll.length + supportUrgent.length + unowned.length,
    task_ids: [...new Set([...ownedAll.map((t) => t.id), ...supporting.map((t) => t.id), ...unowned.map((t) => t.id), ...coveredIds])],
    covering_user_ids: covering.map((p) => p.id),
    counts: Object.fromEntries(Object.entries(owned).map(([k, v]) => [k, v.length])),
  };
}

/** The department's morning in one message. Who is away is shown by name only, never why. */
export async function departmentSummary(departmentId, { now = new Date(), c = null } = {}) {
  const clock = c || await deadlineClock(now);
  const today = clock.today;
  const { rows: dept } = await query('SELECT name FROM departments WHERE id = $1', [departmentId]);
  if (!dept[0]) return null;
  const { rows: away } = await query(
    `SELECT u.full_name, a.status, a.day_part, a.end_date
       FROM user_availability a JOIN users u ON u.id = a.user_id
      WHERE a.cancelled_at IS NULL AND u.is_active AND u.department_id = $1 AND $2::date BETWEEN a.start_date AND a.end_date
      ORDER BY u.full_name`,
    [departmentId, today],
  );
  const tasks = await openTasksWhere('t.department_id = $1', [departmentId]);
  const overdue = tasks.filter((t) => healthOf(t, clock).code === 'OVERDUE');
  const dueToday = tasks.filter((t) => healthOf(t, clock).code === 'DUE_TODAY');
  const unowned = tasks.filter((t) => !t.assignee_id || t.owner_active === false);
  const { rows: notConnected } = await query(
    `SELECT u.full_name FROM users u
      WHERE u.is_active AND u.department_id = $1
        AND NOT EXISTS (SELECT 1 FROM chat_spaces s WHERE s.kind = 'DM' AND s.user_id = u.id AND s.active)
      ORDER BY u.full_name`,
    [departmentId],
  );
  const awayText = (a) => (a.status === 'HALF_DAY'
    ? `${chatText(a.full_name)} (half day, ${a.day_part === 'MORNING' ? 'morning' : 'afternoon'})`
    : `${chatText(a.full_name)}${a.end_date > today ? ` (back after ${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${a.end_date}T00:00:00Z`))})` : ''}`);

  const lines = [`*${chatText(dept[0].name)} — ${new Intl.DateTimeFormat('en-GB', { timeZone: clock.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(now)}*`];
  lines.push(away.length ? `\n*Away today:* ${away.map(awayText).join(', ')}` : '\nEveryone is in today.');
  if (overdue.length) {
    lines.push(`\n*Overdue (${overdue.length})*`);
    const byOwner = new Map();
    for (const t of overdue) {
      const key = t.assignee_id && t.owner_active !== false ? t.owner_name : 'No owner';
      byOwner.set(key, [...(byOwner.get(key) || []), t]);
    }
    let shown = 0;
    for (const [owner, list] of byOwner) {
      if (shown >= 10) break;
      lines.push(`_${chatText(owner)}_ (${list.length})`, ...list.slice(0, 3).map((t) => summaryLine(t, clock)));
      shown += Math.min(3, list.length);
    }
    if (overdue.length > shown) lines.push(`…and ${overdue.length - shown} more: ${app(`/board?due=overdue&department_id=${departmentId}`)}`);
  }
  if (unowned.length) lines.push(...section('Needs an owner', unowned, clock, { max: 5, more: `/board?assignee_id=none&department_id=${departmentId}` }));
  if (dueToday.length) lines.push(...section('Due today', dueToday, clock, { owner: true, max: 8, more: `/board?due=today&department_id=${departmentId}` }));
  if (!dueToday.length && !overdue.length && !unowned.length) lines.push('Nothing due today and nothing overdue.');
  if (notConnected.length) {
    lines.push(`\n*Not connected to Google Chat:* ${notConnected.map((u) => chatText(u.full_name)).join(', ')}. They get reminders only in the TaskFlow bell.`);
  }
  return { text: lines.join('\n'), task_ids: [...new Set([...overdue, ...dueToday, ...unowned].map((t) => t.id))], items: overdue.length + dueToday.length + unowned.length };
}

// ---------------------------------------------------------------- queueing

const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

async function logSummary(row) {
  const { rowCount } = await query(
    `INSERT INTO reminder_summary_log (log_key, kind, user_id, department_id, space_name, summary_date, status, reason, items, task_ids, covering_user_ids, outbox_key, late)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (log_key) DO NOTHING`,
    [row.key, row.kind, row.userId ?? null, row.departmentId ?? null, row.space ?? null, row.date, row.status, row.reason ?? null,
      row.items ?? 0, row.taskIds ?? [], row.covering ?? [], row.outboxKey ?? null, Boolean(row.late)],
  );
  return rowCount > 0;
}

async function enqueue(key, space, userId, kind, payload) {
  await query(
    `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [key, space, userId, kind, JSON.stringify(payload)],
  );
}

/** A plain-text copy of a Chat summary for the TaskFlow bell. */
const plain = (text) => text.replace(/<([^|>]+)\|([^>]+)>/g, '$2').replace(/[*_]/g, '');

/**
 * Who cannot be reached today and who covers for them. Everyone is looked at
 * once: away (their own calendar), or not reachable in Chat.
 */
export async function reachability(now, { s = null } = {}) {
  const settings = s || await reminderSettings();
  const { rows: people } = await query('SELECT id, full_name, department_id FROM users WHERE is_active ORDER BY id');
  const ids = people.map((p) => p.id);
  const { away, backOn } = ids.length ? await awayAt(ids, now, settings.timezone) : { away: new Map(), backOn: () => null };
  const out = new Map();
  for (const p of people) {
    const off = away.get(p.id);
    const route = await chatRoute(p.id, { query }, settings);
    let unreachable = null;
    if (off && ['WEEKLY_OFF', 'HOLIDAY', 'LEAVE'].includes(off.code)) unreachable = { away: true, why: offWords(off), back: backOn(p.id) };
    else if (!route.ok) unreachable = { away: false, why: route.why };
    else if (!route.morningSummary) unreachable = { away: false, why: 'switched the morning summary off' };
    out.set(p.id, { ...p, off, route, unreachable });
  }
  // fallback people for everyone who cannot be reached
  const covers = new Map();
  for (const p of out.values()) {
    if (!p.unreachable) continue;
    const fallback = await fallbackPeople(p.id, p.department_id);
    const chosen = (fallback[0]?.why === 'reporting manager' ? [fallback[0]] : fallback).filter((f) => out.get(f.id) && !out.get(f.id).unreachable?.away);
    p.coveredBy = chosen.map((f) => f.id);
    for (const f of chosen) covers.set(f.id, [...(covers.get(f.id) || []), { id: p.id, full_name: p.full_name, why: p.unreachable.why + (p.unreachable.back ? `, back on ${p.unreachable.back}` : ''), away: p.unreachable.away, back: p.unreachable.back }]);
  }
  return { people: out, covers };
}

/**
 * The morning messages: once per person and per department space a working
 * day, from the configured time until the catch-up limit, late ones marked.
 */
export async function queueSummaries(now = new Date()) {
  const settings = await getSettings();
  const chat = settings.googleChat || {};
  if (!chat.enabled) return { queued: 0 };
  const s = await reminderSettings(settings);
  const c = await deadlineClock(now, settings);
  const today = c.today;
  const tz = c.timezone;
  const workingDays = settings.organisation?.workingDays || [1, 2, 3, 4, 5, 6];
  if (!workingDays.includes(weekdayOf(today))) return { queued: 0 };
  const local = hhmm(now, tz);
  const personalAt = chat.morningSummaryTime || '08:45';
  const teamAt = chat.teamSummaryTime || '09:15';
  let queued = 0;

  if (local >= personalAt) {
    const { rows: due } = await query(
      `SELECT u.id FROM users u WHERE u.is_active
          AND NOT EXISTS (SELECT 1 FROM reminder_summary_log g WHERE g.log_key = 'personal:' || u.id || ':' || $1)`,
      [today],
    );
    if (due.length) {
      if (local >= s.catchUpUntil) {
        // too late in the day to be a morning summary: recorded as missed, not silently lost
        for (const u of due) {
          await logSummary({ key: `personal:${u.id}:${today}`, kind: 'PERSONAL', userId: u.id, date: today, status: 'SKIPPED', reason: `Missed: TaskFlow could not send it between ${personalAt} and ${s.catchUpUntil}` });
        }
      } else {
        const late = minutes(local) - minutes(personalAt) > 60;
        const { people, covers } = await reachability(now, { s });
        for (const u of due) {
          const p = people.get(u.id);
          if (!p) continue;
          const key = `personal:${u.id}:${today}`;
          if (p.unreachable?.away) {
            await logSummary({ key, kind: 'PERSONAL', userId: u.id, date: today, status: 'SKIPPED', reason: `Away: ${p.unreachable.why}${p.coveredBy?.length ? '; their fallback person covers what is due' : '; nobody to cover'}`, covering: [] });
            continue;
          }
          const summary = await personalSummary(u.id, { now, c, covering: covers.get(u.id) || [] });
          if (!summary) {
            await logSummary({ key, kind: 'PERSONAL', userId: u.id, date: today, status: 'SKIPPED', reason: 'Nothing to say: no open work and nothing waiting' });
            continue;
          }
          const text = late ? `${summary.text}\n\n_Sent late: TaskFlow could not send it at ${personalAt}._` : summary.text;
          const base = { key, kind: 'PERSONAL', userId: u.id, date: today, items: summary.items, taskIds: summary.task_ids, covering: summary.covering_user_ids, late };
          if (p.route.ok && p.route.morningSummary) {
            const outboxKey = `digest:${u.id}:${today}`;
            await enqueue(outboxKey, p.route.space, u.id, 'DIGEST', { text });
            if (await logSummary({ ...base, status: 'QUEUED', space: p.route.space, outboxKey })) queued += 1;
          } else {
            // not reachable in Chat: the bell carries it, and their fallback person is told
            await query(
              `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'daily_summary', $2, $3)`,
              [u.id, `Your day: ${summary.counts.overdue} overdue, ${summary.counts.today} due today`, plain(text).slice(0, 4000)],
            );
            await logSummary({ ...base, status: 'APP_ONLY', reason: `${p.unreachable?.why || 'Not reachable in Chat'}; sent to the TaskFlow bell${p.coveredBy?.length ? ', and their fallback person is told' : ''}` });
          }
        }
      }
    }
  }

  if (local >= teamAt && local < s.catchUpUntil) {
    const { rows } = await query(
      `SELECT space_name, department_id FROM chat_spaces
        WHERE kind = 'SPACE' AND active AND team_summary AND department_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM reminder_summary_log g WHERE g.log_key = 'department:' || space_name || ':' || $1)`,
      [today],
    );
    const late = minutes(local) - minutes(teamAt) > 60;
    for (const row of rows) {
      const summary = await departmentSummary(row.department_id, { now, c });
      if (!summary) continue;
      const outboxKey = `team:${row.space_name}:${today}`;
      await enqueue(outboxKey, row.space_name, null, 'TEAM_SUMMARY', { text: late ? `${summary.text}\n\n_Sent late._` : summary.text });
      if (await logSummary({ key: `department:${row.space_name}:${today}`, kind: 'DEPARTMENT', departmentId: row.department_id, space: row.space_name, date: today, status: 'QUEUED', items: summary.items, taskIds: summary.task_ids, outboxKey, late })) queued += 1;
    }
  }
  return { queued };
}

// ---------------------------------------------------------------- weekly backlog review

/** Whether today is the first working day of its week (Monday unless Monday is off). */
export function firstWorkingDayOfWeek(date, workingDays) {
  if (!workingDays.includes(weekdayOf(date))) return false;
  let d = date;
  for (let i = 0; i < 6; i += 1) {
    d = addDays(d, -1);
    const wd = weekdayOf(d);
    if (wd === 0) return true; // reached Sunday: nothing earlier this week worked
    if (workingDays.includes(wd)) return false;
  }
  return true;
}

/** The weekly backlog review for one person: their Backlog and deferred work, and (managers) Backlog with nobody on it. */
export async function backlogReview(userId, { now = new Date(), c = null } = {}) {
  const clock = c || await deadlineClock(now);
  const { rows: users } = await query('SELECT id, full_name, role, department_id FROM users WHERE id = $1 AND is_active', [userId]);
  if (!users[0]) return null;
  const mine = await openTasksWhere(`t.assignee_id = $1 AND (s.stage = 'backlog' OR t.deferral_id IS NOT NULL)`, [userId]);
  const managed = await managedDepartmentIds(users[0]);
  const unowned = managed.length
    ? await openTasksWhere(`t.department_id = ANY($1::int[]) AND s.stage = 'backlog' AND (t.assignee_id IS NULL OR u.is_active = FALSE)`, [managed])
    : [];
  const team = managed.length
    ? await openTasksWhere(`t.department_id = ANY($1::int[]) AND (s.stage = 'backlog' OR t.deferral_id IS NOT NULL) AND t.assignee_id IS DISTINCT FROM $2 AND u.is_active`, [managed, userId])
    : [];
  if (!mine.length && !unowned.length && !team.length) return null;
  const reviewDue = (list) => list.filter((t) => healthOf(t, clock).reviewDue || healthOf(t, clock).code === 'REVIEW_DUE');
  const noReview = (list) => list.filter((t) => !t.review_date && !t.due_date);
  const lines = [`*Backlog review — week of ${new Intl.DateTimeFormat('en-GB', { timeZone: clock.timezone, day: 'numeric', month: 'long' }).format(now)}*`];
  lines.push(...section('Your review dates that have come', reviewDue(mine), clock));
  lines.push(...section('Your Backlog with no review date', noReview(mine), clock));
  if (mine.length) lines.push(`You have ${mine.length} item(s) in Backlog or deferred: ${app(`/board?stage=backlog&assignee_id=${userId}`)}`);
  if (team.length) {
    lines.push(...section('Your departments: review dates that have come', reviewDue(team), clock, { owner: true }));
    lines.push(...section('Your departments: Backlog with no review date', noReview(team), clock, { owner: true }));
  }
  lines.push(...section('Backlog with no owner', unowned, clock, { more: '/board?stage=backlog&assignee_id=none' }));
  return { text: lines.join('\n'), task_ids: [...new Set([...mine, ...unowned, ...team].map((t) => t.id))], items: mine.length + unowned.length };
}

/** Sends the weekly backlog review on the first working day of the week, once a person. */
export async function queueBacklogReviews(now = new Date()) {
  const settings = await getSettings();
  const s = await reminderSettings(settings);
  if (!s.weeklyBacklog || s.mode === 'OFF') return { queued: 0 };
  const c = await deadlineClock(now, settings);
  const workingDays = settings.organisation?.workingDays || [1, 2, 3, 4, 5, 6];
  if (!firstWorkingDayOfWeek(c.today, workingDays)) return { queued: 0 };
  const at = settings.googleChat?.morningSummaryTime || '08:45';
  const local = hhmm(now, c.timezone);
  if (local < at || local >= s.catchUpUntil || s.mode === 'OFF') return { queued: 0 };
  const { rows: due } = await query(
    `SELECT u.id FROM users u WHERE u.is_active
        AND NOT EXISTS (SELECT 1 FROM reminder_summary_log g WHERE g.log_key = 'backlog:' || u.id || ':' || $1)`,
    [c.today],
  );
  const { people } = due.length ? await reachability(now, { s }) : { people: new Map() };
  let queued = 0;
  for (const u of due) {
    const key = `backlog:${u.id}:${c.today}`;
    const review = await backlogReview(u.id, { now, c });
    const p = people.get(u.id);
    if (!review) { await logSummary({ key, kind: 'BACKLOG_WEEKLY', userId: u.id, date: c.today, status: 'SKIPPED', reason: 'Nothing in Backlog' }); continue; }
    const base = { key, kind: 'BACKLOG_WEEKLY', userId: u.id, date: c.today, items: review.items, taskIds: review.task_ids };
    if (p?.unreachable?.away) { await logSummary({ ...base, status: 'SKIPPED', reason: `Away: ${p.unreachable.why}` }); continue; }
    const test = s.mode === 'TEST';
    if (test && Number(s.testRecipientId) !== u.id) { await logSummary({ ...base, status: 'WOULD_SEND', reason: 'Test mode: would have been sent' }); continue; }
    const text = `${test ? '*TEST* · ' : ''}${review.text}`;
    if (p?.route?.ok) {
      const outboxKey = `backlog:${u.id}:${c.today}`;
      await enqueue(outboxKey, p.route.space, u.id, 'BACKLOG_WEEKLY', { text });
      if (await logSummary({ ...base, status: 'QUEUED', space: p.route.space, outboxKey })) queued += 1;
    } else {
      await query(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'backlog_review', $2, $3)`, [u.id, `${test ? 'TEST · ' : ''}Backlog review for the week`, plain(text).slice(0, 4000)]);
      await logSummary({ ...base, status: 'APP_ONLY', reason: `${p?.unreachable?.why || 'Not reachable in Chat'}; sent to the TaskFlow bell` });
    }
  }
  return { queued };
}

