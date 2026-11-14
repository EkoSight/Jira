/**
 * Applications to grants, incubators, accelerators, challenges, awards,
 * tenders and government schemes: deals in the "Applications & programmes"
 * pipeline, with what a deal lacks kept in opportunity_applications.
 *
 * Reused from deals: the organising institution (the organisation) and its
 * contacts, owner and collaborators, stages with history, next step, waiting
 * on, tasks, meetings, documents and activity.
 *
 * "Mark submitted" is a business event with the real date: a checklist item
 * never sets it, and an acknowledgement is not a review outcome. After it,
 * preparation alerts stop and the application stays open for the outcome.
 * Selected, Not selected and Withdrawn stop follow-up reminders; open
 * obligations (ordinary tasks) are never closed by it.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { addDays } from '../../../../shared/deadlineHealth.js';
import { canSee, crmScope, localDate, scopeCondition, zonedInstant } from '../sales/core.js';
import { canWorkOnOpportunity, recordHistory } from '../opportunities.js';
import { loadStageMove, moveOpportunityStage } from '../dealMoves.js';
import { logActivity } from '../crm.js';
import { nextTaskRef } from '../../lib/taskRef.js';
import { getSettings } from '../settings.js';
import { addContributor } from './attention.js';
import { addWaitingSource } from './waiting.js';
import { replanRecord } from './reminders.js';
import { validTimeZone } from './access.js';

export const APPLICATION_TYPES = {
  GRANT: 'Grant', INCUBATION: 'Incubation', ACCELERATION: 'Acceleration', CHALLENGE: 'Challenge',
  AWARD: 'Award', TENDER: 'Tender / RFP', GOVERNMENT_SCHEME: 'Government scheme', OTHER: 'Other',
};
export const UPDATE_KINDS = {
  ACKNOWLEDGEMENT: 'Acknowledgement received (not a decision)',
  FOLLOW_UP_SENT: 'We followed up (not a reply)',
  RESPONSE: 'A response from the organiser',
  OUTCOME: 'The outcome',
};
export const OUTCOMES = { SELECTED: 'app-selected', NOT_SELECTED: 'app-not-selected', WITHDRAWN: 'app-withdrawn' };
const PREPARING = ['app-considering', 'app-preparing'];

const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

// ---------------------------------------------------------------- dates (pure)

/** The deadline as stored: a date with no closing time, or an exact instant with its zone. */
export function deadlineOf(row) {
  if (row.deadline_at) return { at: new Date(row.deadline_at), timezone: row.deadline_timezone, dateOnly: false };
  if (row.deadline_date) return { date: dayOf(row.deadline_date), dateOnly: true };
  return null;
}

/** The deadline's calendar date for someone in `tz`. */
export const deadlineDay = (dl, tz) => (dl.dateOnly ? dl.date : localDate(dl.at, tz));

/** The moment a deadline is over for someone in `tz` (the end of a date-only day). */
export const deadlineEnds = (dl, tz) => (dl.dateOnly ? zonedInstant(addDays(dl.date, 1), '00:00', tz) : dl.at);

const partsOf = (date, timeZone, withTime) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
}).formatToParts(date).map((p) => [p.type, p.value]));
/** "Mon 29 Mar 2027, 21:30 IST": an instant in a zone, with the zone. */
const fmtAt = (at, tz) => { const p = partsOf(at, tz, true); return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${tz === 'Asia/Kolkata' ? 'IST' : tz}`; };
/** "Wed 20 Jan 2027": a calendar date, never given a time. */
const fmtDay = (d) => { const p = partsOf(new Date(`${d}T00:00:00Z`), 'UTC', false); return `${p.weekday} ${p.day} ${p.month} ${p.year}`; };

/**
 * The deadline in words for someone in `tz`, now. A date-only deadline never
 * gets a made-up time: "Closing time not specified".
 */
export function deadlineWords(dl, tz, now = new Date()) {
  if (!dl) return { text: 'No deadline recorded', state: 'NONE' };
  const today = localDate(now, tz);
  const day = deadlineDay(dl, tz);
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (dl.dateOnly) {
    const base = `${fmtDay(dl.date)} · Closing time not specified`;
    if (days < 0) return { text: `${base} · Deadline passed`, state: 'PASSED', days };
    if (days === 0) return { text: `${base} · Due today`, state: 'TODAY', days };
    return { text: `${base} · ${days === 1 ? '1 day left' : `${days} days left`}`, state: 'OPEN', days };
  }
  const shown = fmtAt(dl.at, tz);
  const original = dl.timezone && dl.timezone !== tz ? ` (${fmtAt(dl.at, dl.timezone)})` : '';
  const ms = dl.at.getTime() - now.getTime();
  if (ms <= 0) return { text: `${shown}${original} · Deadline passed`, state: 'PASSED', days };
  const hours = Math.floor(ms / 3_600_000);
  const left = hours < 24 ? `${Math.max(1, hours)} hour${hours === 1 ? '' : 's'} left` : days === 1 ? '1 day left' : `${days} days left`;
  return { text: `${shown}${original} · ${left}`, state: days === 0 ? 'TODAY' : 'OPEN', days };
}

/**
 * The date the status check is for, and what sets it: a next check the
 * person chose (or set by logging a follow-up), else the organiser's response
 * date, else 15 calendar days after the submitted date. A substantive update
 * (a response or the outcome) ends the default; there is never more than one.
 */
export function statusCheck(row) {
  if (!row.submitted_on || row.stage_kind === 'won' || row.stage_kind === 'lost') return null;
  if (row.next_check_on) {
    return { date: dayOf(row.next_check_on), source: row.next_check_source === 'FOLLOW_UP' ? 'FOLLOW_UP' : 'PERSON',
      words: row.next_check_source === 'FOLLOW_UP' ? 'the next check you set when you followed up' : 'the next check date you chose' };
  }
  const substantive = ['RESPONSE', 'OUTCOME'].includes(row.last_update_type) && row.last_update_at && dayOf(row.last_update_at) >= dayOf(row.submitted_on);
  if (substantive) return null;
  if (row.expected_response_on) return { date: dayOf(row.expected_response_on), source: 'ORGANISER', words: 'the response date the organiser gave' };
  return { date: addDays(dayOf(row.submitted_on), 15), source: 'DEFAULT', words: '15 days after the submitted date' };
}

// ---------------------------------------------------------------- reading

export const APPLICATION_SELECT = `
  SELECT o.id, o.name, o.account_id, o.owner_user_id, o.status, o.stage_id, o.pipeline_id, o.next_step, o.next_step_due,
         o.next_step_owner_id, o.next_step_task_id, o.waiting_on, o.waiting_reason, o.waiting_since, o.waiting_until,
         o.escalation_owner_id, o.created_at, o.created_by, o.introduced_by_user_id, o.introduced_by_contact_id, o.is_archived,
         a.name AS account_name, s.name AS stage_name, s.slug AS stage_slug, s.kind AS stage_kind, s.position AS stage_position,
         u.full_name AS owner_name, ib.full_name AS introduced_by_user_name, ic.full_name AS introduced_by_contact_name,
         x.application_type, x.opportunity_url, x.deadline_date, x.deadline_at, x.deadline_timezone,
         x.submitted_on, x.submitted_recorded_at, x.submitted_by, x.submitted_link, x.acknowledged_on, x.reference,
         x.expected_response_on, x.next_check_on, x.next_check_source, x.last_update_at, x.last_update_type
    FROM opportunities o
    JOIN crm_pipelines p ON p.id = o.pipeline_id AND p.category = 'APPLICATIONS'
    JOIN accounts a ON a.id = o.account_id
    LEFT JOIN account_stages s ON s.id = o.stage_id
    LEFT JOIN users u ON u.id = o.owner_user_id
    LEFT JOIN users ib ON ib.id = o.introduced_by_user_id
    LEFT JOIN account_contacts ic ON ic.id = o.introduced_by_contact_id
    LEFT JOIN opportunity_applications x ON x.opportunity_id = o.id`;

export function groupOf(row) {
  if (row.stage_kind === 'won' || row.stage_kind === 'lost') return 'DECIDED';
  if (row.submitted_on) return 'SUBMITTED';
  return 'PREPARING';
}

export function decorateApplication(row, tz, now = new Date()) {
  const dl = deadlineOf(row);
  const check = statusCheck(row);
  return {
    ...row,
    deadline: dl ? { ...dl, at: dl.at || null, words: deadlineWords(dl, tz, now) } : null,
    status_check: check,
    group: groupOf(row),
    type_label: APPLICATION_TYPES[row.application_type] || 'Other',
    url: `/applications/${row.id}`,
  };
}

async function crmOn(user) {
  const s = await getSettings();
  return s.crm?.enabled !== false && hasPermission(user, 'crm.view');
}

/** The applications a person may see: their own, or (scope team) what their CRM access shows of their department. */
export async function listApplications(user, { scope = 'mine', group = null, now = new Date() } = {}) {
  if (!(await crmOn(user))) throw notFound('The pipeline is switched off');
  const s = await crmScope(user);
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['o.is_archived = FALSE', scopeCondition(s, 'opportunity', 'o', push)];
  if (scope === 'team') where.push(`(u.department_id = ${push(user.department_id || -1)} OR o.owner_user_id = ${push(user.id)})`);
  else where.push(`o.owner_user_id = ${push(user.id)}`);
  const { rows } = await query(`${APPLICATION_SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(x.deadline_at, x.deadline_date::timestamptz) NULLS LAST, o.id`, params);
  const tz = user.timezone || (await getSettings()).organisation?.timezone || 'Asia/Kolkata';
  const all = rows.map((r) => decorateApplication(r, tz, now));
  const counts = { PREPARING: 0, SUBMITTED: 0, DECIDED: 0 };
  for (const a of all) counts[a.group] += 1;
  return { applications: group ? all.filter((a) => a.group === group) : all, counts, timezone: tz, types: APPLICATION_TYPES };
}

export async function loadApplication(id, runner = { query }) {
  const { rows } = await runner.query(`${APPLICATION_SELECT} WHERE o.id = $1`, [id]);
  return rows[0] || null;
}

async function mustSee(user, id) {
  if (!(await crmOn(user))) throw notFound('The pipeline is switched off');
  const row = await loadApplication(id);
  if (!row || row.is_archived || !(await canSee(await crmScope(user), 'opportunity', id))) throw notFound('Not available');
  return row;
}

async function mustWork(user, id) {
  const row = await mustSee(user, id);
  const { rows } = await query('SELECT o.*, a.owner_user_id AS relationship_owner_id FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE o.id = $1', [id]);
  if (!hasPermission(user, 'crm.activity.log') || !(await canWorkOnOpportunity(user, rows[0]))) {
    throw forbidden('Only the people working on this application can change it');
  }
  return row;
}

export async function getApplication(user, id, { now = new Date() } = {}) {
  const row = await mustSee(user, id);
  const tz = user.timezone || (await getSettings()).organisation?.timezone || 'Asia/Kolkata';
  const [updates, rounds, tasks, meetings, history] = await Promise.all([
    query(`SELECT u.*, us.full_name AS by_name FROM application_updates u LEFT JOIN users us ON us.id = u.created_by WHERE u.opportunity_id = $1 ORDER BY u.happened_on DESC, u.id DESC`, [id]),
    query(`SELECT * FROM application_rounds WHERE opportunity_id = $1 ORDER BY created_at, id`, [id]),
    // the very tasks, by id: the same ones on the board and in My tasks
    query(`SELECT t.id, t.ref, t.title, t.due_date, t.assignee_id, us.full_name AS assignee_name, s.stage, s.name AS status_name
             FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id LEFT JOIN users us ON us.id = t.assignee_id
            WHERE t.opportunity_id = $1 AND t.is_archived = FALSE ORDER BY (s.stage IN ('done','cancelled')), t.due_date NULLS LAST, t.id`, [id]),
    query(`SELECT id, title, status, scheduled_at, timezone, arrange_by, proposed_at, owner_user_id FROM crm_meetings WHERE opportunity_id = $1 ORDER BY scheduled_at NULLS FIRST, id`, [id]),
    query(`SELECT h.*, u.full_name AS actor_name FROM opportunity_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.opportunity_id = $1 ORDER BY h.created_at DESC LIMIT 50`, [id]),
  ]);
  const { rows: stages } = await query(`SELECT id, name, slug, kind, position FROM account_stages WHERE pipeline_id = $1 AND is_active AND retired_at IS NULL ORDER BY position`, [row.pipeline_id]);
  const { rows: raw } = await query('SELECT o.*, a.owner_user_id AS relationship_owner_id FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE o.id = $1', [id]);
  return {
    application: decorateApplication(row, tz, now),
    rounds: rounds.rows.map((r) => ({ ...r, deadline: deadlineOf(r) ? { ...deadlineOf(r), words: deadlineWords(deadlineOf(r), tz, now) } : null })),
    updates: updates.rows, tasks: tasks.rows, meetings: meetings.rows, history: history.rows, stages,
    can_edit: hasPermission(user, 'crm.activity.log') && await canWorkOnOpportunity(user, raw[0]),
    types: APPLICATION_TYPES, update_kinds: UPDATE_KINDS, timezone: tz,
  };
}

// ---------------------------------------------------------------- writing

function cleanDeadline(input) {
  if (input.deadline_at) {
    const at = new Date(input.deadline_at);
    if (Number.isNaN(at.getTime())) throw badRequest('The deadline time is not a valid date and time');
    const tz = input.deadline_timezone;
    if (!tz || !validTimeZone(tz)) throw badRequest('Say which timezone the closing time is in');
    return { deadline_date: null, deadline_at: at, deadline_timezone: tz };
  }
  if (input.deadline_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deadline_date)) throw badRequest('Use a date like 2027-01-20');
    return { deadline_date: input.deadline_date, deadline_at: null, deadline_timezone: null };
  }
  return { deadline_date: null, deadline_at: null, deadline_timezone: null };
}

/** An exact closing time given as a local wall-clock time in its own zone. */
export function exactDeadline(localDateTime, timezone) {
  const [d, t] = String(localDateTime).split('T');
  return zonedInstant(d, t.slice(0, 5), timezone);
}

export async function createApplication(user, input) {
  if (!(await crmOn(user)) || !hasPermission(user, 'crm.create')) throw forbidden('Adding applications needs permission to add CRM records');
  const name = String(input.name || '').trim();
  if (name.length < 2) throw badRequest('Name the application, for example the programme and year');
  if (!APPLICATION_TYPES[input.application_type || 'OTHER']) throw badRequest('Choose the type of application');
  const dl = cleanDeadline(input.deadline_at_local ? { deadline_at: exactDeadline(input.deadline_at_local, input.deadline_timezone), deadline_timezone: input.deadline_timezone } : input);
  const id = await withTransaction(async (client) => {
    let accountId = input.account_id || null;
    if (accountId) {
      if (!(await canSee(await crmScope(user), 'account', accountId))) throw notFound('Organisation not found');
    } else {
      const org = String(input.organiser_name || '').trim();
      if (org.length < 2) throw badRequest('Name the organising institution');
      const { rows } = await client.query(
        `INSERT INTO accounts (name, type, org_type, owner_user_id, created_by) VALUES ($1, 'PARTNER', 'OTHER', $2, $2) RETURNING id`, [org.slice(0, 200), user.id],
      );
      accountId = rows[0].id;
    }
    const { rows: pipe } = await client.query(`SELECT p.id, s.id AS stage_id FROM crm_pipelines p JOIN account_stages s ON s.pipeline_id = p.id
      WHERE p.key = 'applications' AND s.slug = $1`, [input.stage === 'considering' ? 'app-considering' : 'app-preparing']);
    if (!pipe[0]) throw badRequest('The applications pipeline is not set up');
    const owner = input.owner_user_id || user.id;
    const { rows } = await client.query(
      `INSERT INTO opportunities (account_id, name, stage_id, status, owner_user_id, created_by, pipeline_id, introduced_by_user_id, introduced_by_contact_id)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, $7, $8) RETURNING id`,
      [accountId, name.slice(0, 200), pipe[0].stage_id, owner, user.id, pipe[0].id, input.introduced_by_user_id || null, input.introduced_by_contact_id || null],
    );
    const oid = rows[0].id;
    await client.query(
      `INSERT INTO opportunity_applications (opportunity_id, application_type, opportunity_url, deadline_date, deadline_at, deadline_timezone, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [oid, input.application_type || 'OTHER', input.opportunity_url || null, dl.deadline_date, dl.deadline_at, dl.deadline_timezone, user.id],
    );
    await recordHistory(client, { opportunityId: oid, field: 'created', to: name, actorId: user.id });
    await logActivity(client, { accountId, opportunityId: oid, type: 'NOTE', actorId: user.id, subject: `Application opened: ${name}`, source: 'MANUAL' });
    return oid;
  });
  await replanRecord('APPLICATION', id);
  return id;
}

const EDITABLE = ['application_type', 'opportunity_url', 'submitted_link', 'reference', 'expected_response_on'];

export async function updateApplication(user, id, input) {
  const before = await mustWork(user, id);
  if (input.application_type && !APPLICATION_TYPES[input.application_type]) throw badRequest('Choose the type of application');
  await withTransaction(async (client) => {
    const sets = [];
    const params = [id];
    for (const k of EDITABLE) {
      if (input[k] !== undefined) { params.push(input[k] || null); sets.push(`${k} = $${params.length}`); }
    }
    const touchesDeadline = ['deadline_date', 'deadline_at', 'deadline_at_local'].some((k) => input[k] !== undefined);
    if (touchesDeadline) {
      const dl = cleanDeadline(input.deadline_at_local ? { deadline_at: exactDeadline(input.deadline_at_local, input.deadline_timezone), deadline_timezone: input.deadline_timezone } : input);
      for (const [k, v] of Object.entries(dl)) { params.push(v); sets.push(`${k} = $${params.length}`); }
      const was = deadlineOf(before);
      const fmt = (d) => (!d ? 'none' : d.dateOnly ? `${d.date} (no closing time)` : `${d.at.toISOString()} ${d.timezone}`);
      await recordHistory(client, { opportunityId: id, field: 'deadline', from: fmt(was), to: fmt(deadlineOf(dl)), actorId: user.id, reason: input.reason || null });
    }
    if (input.next_check_on !== undefined) {
      params.push(input.next_check_on || null); sets.push(`next_check_on = $${params.length}`);
      sets.push(`next_check_source = ${input.next_check_on ? "'PERSON'" : 'NULL'}`);
    }
    if (input.introduced_by_user_id !== undefined || input.introduced_by_contact_id !== undefined) {
      await client.query('UPDATE opportunities SET introduced_by_user_id = $2, introduced_by_contact_id = $3, updated_at = now() WHERE id = $1',
        [id, input.introduced_by_user_id || null, input.introduced_by_contact_id || null]);
      await recordHistory(client, { opportunityId: id, field: 'introduced_by', from: before.introduced_by_user_name || before.introduced_by_contact_name || null, to: input.introduced_by_user_id ? `user ${input.introduced_by_user_id}` : input.introduced_by_contact_id ? `contact ${input.introduced_by_contact_id}` : null, actorId: user.id });
    }
    if (sets.length) {
      await client.query(`INSERT INTO opportunity_applications (opportunity_id, created_by) VALUES ($1, NULL) ON CONFLICT DO NOTHING`, [id]);
      await client.query(`UPDATE opportunity_applications SET ${sets.join(', ')}, updated_at = now() WHERE opportunity_id = $1`, params);
    }
  });
  await replanRecord('APPLICATION', id);
  return getApplication(user, id);
}

/**
 * "Mark submitted", with the real date. Moves a preparing application to
 * Submitted; it stays open for the outcome. Correcting the date later is
 * allowed only with a reason, and is recorded.
 */
export async function markSubmitted(user, id, { submitted_on: on, submitted_link: link = null, reference = null, correction_reason: why = null }, { now = new Date() } = {}) {
  const row = await mustWork(user, id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on || ''))) throw badRequest('Say on which date it was submitted');
  const tz = user.timezone || (await getSettings()).organisation?.timezone || 'Asia/Kolkata';
  if (on > localDate(now, tz)) throw badRequest('The submitted date cannot be in the future');
  if (row.stage_kind === 'won' || row.stage_kind === 'lost') throw badRequest('This application already has its outcome');
  if (row.submitted_on && !why) throw conflict('Already marked submitted. To correct the date, say why', { code: 'ALREADY_SUBMITTED' });
  await withTransaction(async (client) => {
    await client.query(`INSERT INTO opportunity_applications (opportunity_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    await client.query(
      `UPDATE opportunity_applications SET submitted_on = $2, submitted_recorded_at = now(), submitted_by = $3,
              submitted_link = COALESCE($4, submitted_link), reference = COALESCE($5, reference), updated_at = now()
        WHERE opportunity_id = $1`,
      [id, on, user.id, link, reference],
    );
    await recordHistory(client, { opportunityId: id, field: 'submitted', from: dayOf(row.submitted_on), to: on, actorId: user.id, reason: why });
    if (PREPARING.includes(row.stage_slug)) {
      const { rows: s } = await client.query(`SELECT id FROM account_stages WHERE slug = 'app-submitted'`);
      const { rows: raw } = await client.query('SELECT * FROM opportunities WHERE id = $1', [id]);
      await moveOpportunityStage(client, { opportunity: raw[0], stage: await loadStageMove(s[0].id, row.stage_id, client), data: { reason: `Submitted on ${on}` }, actor: user });
    }
  });
  await replanRecord('APPLICATION', id);
  return getApplication(user, id);
}

/**
 * Something that happened after submission. An acknowledgement and a
 * follow-up we sent are not substantive: the follow-up sets the next check
 * (7 days later unless chosen). A response or the outcome is substantive and
 * ends the status check; the person is asked for the next action if it is
 * still open.
 */
export async function logUpdate(user, id, input, { now = new Date() } = {}) {
  const row = await mustWork(user, id);
  const kind = input.kind;
  if (!UPDATE_KINDS[kind]) throw badRequest('Choose what happened');
  const on = input.happened_on || localDate(now, user.timezone || 'Asia/Kolkata');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw badRequest('Use a date like 2027-02-10');
  if (!row.submitted_on && kind !== 'OUTCOME') throw badRequest('Mark it submitted first');
  let nextCheck = null;
  if (kind === 'FOLLOW_UP_SENT') nextCheck = input.next_check_on || addDays(on, 7);
  if (kind === 'OUTCOME' && !OUTCOMES[input.result]) throw badRequest('Choose the outcome: selected, not selected or withdrawn');
  if (kind === 'OUTCOME' && input.result !== 'SELECTED' && !String(input.summary || '').trim()) throw badRequest('Say what the outcome was, in a few words');
  await withTransaction(async (client) => {
    await client.query(`INSERT INTO opportunity_applications (opportunity_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    await client.query(
      `INSERT INTO application_updates (opportunity_id, kind, happened_on, summary, reference, next_check_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, kind, on, input.summary ? String(input.summary).slice(0, 2000) : null, input.reference || null, nextCheck, user.id],
    );
    if (kind === 'ACKNOWLEDGEMENT') {
      await client.query(`UPDATE opportunity_applications SET acknowledged_on = $2, reference = COALESCE($3, reference), updated_at = now() WHERE opportunity_id = $1`, [id, on, input.reference || null]);
    } else if (kind === 'FOLLOW_UP_SENT') {
      await client.query(`UPDATE opportunity_applications SET next_check_on = $2, next_check_source = 'FOLLOW_UP', updated_at = now() WHERE opportunity_id = $1`, [id, nextCheck]);
    } else {
      await client.query(
        `UPDATE opportunity_applications SET last_update_at = $2::date, last_update_type = $3, next_check_on = NULL, next_check_source = NULL, updated_at = now() WHERE opportunity_id = $1`,
        [id, on, kind],
      );
    }
    await logActivity(client, { accountId: row.account_id, opportunityId: id, type: 'NOTE', actorId: user.id, subject: `${row.name}: ${UPDATE_KINDS[kind].toLowerCase()}`, body: input.summary || null, source: 'MANUAL' });
    if (kind === 'OUTCOME') {
      const { rows: s } = await client.query('SELECT id FROM account_stages WHERE slug = $1', [OUTCOMES[input.result]]);
      const { rows: raw } = await client.query('SELECT * FROM opportunities WHERE id = $1', [id]);
      await moveOpportunityStage(client, {
        opportunity: raw[0], stage: await loadStageMove(s[0].id, row.stage_id, client),
        data: { outcome_reason: input.summary || (input.result === 'SELECTED' ? 'Selected' : null), reason: input.summary || null }, actor: user,
      });
      // Selected may start onboarding work; nothing already open is closed
      if (input.result === 'SELECTED' && input.onboarding_task_title) {
        await createLinkedTask(client, user, id, { title: input.onboarding_task_title, due_date: input.onboarding_due || null });
      }
    }
  });
  await replanRecord('APPLICATION', id);
  const fresh = await getApplication(user, id);
  return {
    ...fresh,
    ask_next_check: kind === 'FOLLOW_UP_SENT' ? nextCheck : null,
    ask_next_action: ['RESPONSE'].includes(kind) && fresh.application.group !== 'DECIDED',
  };
}

/** One task on the application: the same task everywhere (board, My tasks, here). */
export async function createLinkedTask(client, user, id, { title, due_date: due = null, assignee_id: assignee = null }) {
  const { rows: st } = await client.query(`SELECT id FROM workflow_statuses WHERE is_default = TRUE ORDER BY position LIMIT 1`);
  const { rows: d } = await client.query('SELECT department_id FROM users WHERE id = $1', [assignee || user.id]);
  const dept = d[0]?.department_id || user.department_id || (await client.query('SELECT id FROM departments ORDER BY position, id LIMIT 1')).rows[0]?.id;
  const ref = await nextTaskRef(client, dept);
  const { rows } = await client.query(
    `INSERT INTO tasks (ref, title, department_id, status_id, assignee_id, created_by, reporter_id, due_date, original_due_date, opportunity_id, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, $8, (SELECT account_id FROM opportunities WHERE id = $8)) RETURNING id, ref`,
    [ref, String(title).slice(0, 200), dept, st[0].id, assignee || user.id, user.id, due, id],
  );
  return rows[0];
}

export async function addTask(user, id, input) {
  await mustWork(user, id);
  if (String(input.title || '').trim().length < 3) throw badRequest('Say what the task is');
  return withTransaction((client) => createLinkedTask(client, user, id, input));
}

export async function addRound(user, id, input) {
  await mustWork(user, id);
  const name = String(input.name || '').trim();
  if (name.length < 2) throw badRequest('Name the round, for example "Pitch to the jury"');
  const dl = cleanDeadline(input.deadline_at_local ? { deadline_at: exactDeadline(input.deadline_at_local, input.deadline_timezone), deadline_timezone: input.deadline_timezone } : input);
  const { rows } = await query(
    `INSERT INTO application_rounds (opportunity_id, name, deadline_date, deadline_at, deadline_timezone, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [id, name.slice(0, 200), dl.deadline_date, dl.deadline_at, dl.deadline_timezone, input.notes || null, user.id],
  );
  await recordHistory(null, { opportunityId: id, field: 'round', to: name, actorId: user.id });
  await replanRecord('APPLICATION', id);
  return rows[0];
}

export async function updateRound(user, id, roundId, input) {
  await mustWork(user, id);
  const { rows: r } = await query('SELECT * FROM application_rounds WHERE id = $1 AND opportunity_id = $2', [roundId, id]);
  if (!r[0]) throw notFound('Round not found');
  const status = input.status && ['OPEN', 'SUBMITTED', 'DONE', 'CANCELLED'].includes(input.status) ? input.status : r[0].status;
  const touches = ['deadline_date', 'deadline_at', 'deadline_at_local'].some((k) => input[k] !== undefined);
  const dl = touches ? cleanDeadline(input.deadline_at_local ? { deadline_at: exactDeadline(input.deadline_at_local, input.deadline_timezone), deadline_timezone: input.deadline_timezone } : input) : r[0];
  const { rows } = await query(
    `UPDATE application_rounds SET status = $3, deadline_date = $4, deadline_at = $5, deadline_timezone = $6,
            submitted_on = CASE WHEN $3 = 'SUBMITTED' THEN COALESCE($7::date, submitted_on, current_date) ELSE submitted_on END,
            meeting_id = COALESCE($8, meeting_id), updated_at = now()
      WHERE id = $1 AND opportunity_id = $2 RETURNING *`,
    [roundId, id, status, dl.deadline_date, dl.deadline_at, dl.deadline_timezone, input.submitted_on || null, input.meeting_id || null],
  );
  await replanRecord('APPLICATION', id);
  return rows[0];
}

// ---------------------------------------------------------------- attention and waiting

async function myOpenApplications(user) {
  const { rows } = await query(
    `${APPLICATION_SELECT} WHERE o.owner_user_id = $1 AND o.is_archived = FALSE AND o.status = 'ACTIVE' AND s.kind = 'open'`, [user.id],
  );
  return rows;
}

addContributor(async function applicationItems(user, ctx) {
  if (!ctx.crm) return [];
  const tz = user.timezone || ctx.c.timezone;
  const today = localDate(ctx.now, tz);
  const out = [];
  for (const a of await myOpenApplications(user)) {
    const record = { type: 'APPLICATION', id: a.id, label: `${a.name} · ${a.account_name}`, url: `/applications/${a.id}` };
    const dl = deadlineOf(a);
    if (dl && !a.submitted_on) {
      const words = deadlineWords(dl, tz, ctx.now);
      const day = deadlineDay(dl, tz);
      const inDays = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (inDays <= 14) {
        const tier = words.state === 'PASSED' || words.state === 'TODAY' ? 1 : inDays <= 3 ? 4 : 6;
        out.push({
          key: `APPLICATION_DEADLINE:APPLICATION:${a.id}:${dl.dateOnly ? dl.date : dl.at.toISOString()}`, kind: 'APPLICATION_DEADLINE',
          title: words.state === 'PASSED' ? 'Deadline passed: submit or record what happened' : 'Finish and submit the application', reason: words.text,
          record, related: [], when: dl.dateOnly ? { date: dl.date, dateOnly: true } : { at: dl.at, dateOnly: false, timezone: dl.timezone },
          tier, overdue: words.state === 'PASSED', dueToday: words.state === 'TODAY', action: { label: 'Open the application', kind: 'OPEN' },
        });
      }
    }
    const check = statusCheck(a);
    if (check && check.date <= addDays(today, 3)) {
      out.push({
        key: `APPLICATION_STATUS_CHECK:APPLICATION:${a.id}:${check.date}`, kind: 'APPLICATION_STATUS_CHECK',
        title: 'Check application status',
        reason: `Submitted ${dayOf(a.submitted_on)}${a.acknowledged_on ? ', acknowledged' : ''}; no update recorded. Check date: ${check.words}`,
        record, related: [], when: { date: check.date, dateOnly: true },
        tier: check.date < today ? 2 : check.date === today ? 1 : 4, overdue: check.date < today, dueToday: check.date === today,
        action: { label: 'Log an update', kind: 'OPEN' },
      });
    }
    if (!a.submitted_on && !a.next_step && !a.waiting_on) {
      out.push({ key: `APPLICATION_NO_NEXT_ACTION:APPLICATION:${a.id}:0`, kind: 'APPLICATION_NO_NEXT_ACTION', title: 'Choose the next action', reason: 'None recorded', record, related: [], when: {}, tier: 5, action: { label: 'Open the application', kind: 'OPEN' } });
    }
    // round deadlines
    const { rows: rounds } = await query(`SELECT * FROM application_rounds WHERE opportunity_id = $1 AND status = 'OPEN'`, [a.id]);
    for (const r of rounds) {
      const rd = deadlineOf(r);
      if (!rd) continue;
      const words = deadlineWords(rd, tz, ctx.now);
      const day = deadlineDay(rd, tz);
      const inDays = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (inDays > 14) continue;
      out.push({
        key: `APPLICATION_DEADLINE:APPLICATION:${a.id}:round${r.id}:${rd.dateOnly ? rd.date : rd.at.toISOString()}`, kind: 'APPLICATION_DEADLINE',
        title: `${r.name}: get it in`, reason: words.text, record, related: [],
        when: rd.dateOnly ? { date: rd.date, dateOnly: true } : { at: rd.at, dateOnly: false },
        tier: words.state === 'PASSED' || words.state === 'TODAY' ? 1 : inDays <= 3 ? 4 : 6, overdue: words.state === 'PASSED', dueToday: words.state === 'TODAY',
        action: { label: 'Open the application', kind: 'OPEN' },
      });
    }
  }
  return out;
});

addWaitingSource(async (user, { crm, c }) => {
  if (!crm) return [];
  const out = [];
  for (const a of await myOpenApplications(user)) {
    if (!a.submitted_on || a.waiting_on) continue;
    const check = statusCheck(a);
    out.push({
      key: `WAITING:APPLICATION:${a.id}`, kind: 'APPLICATION_SUBMITTED', specific: true,
      what: a.acknowledged_on ? 'A decision (acknowledged, no update recorded)' : 'A reply (no update recorded)',
      from: a.account_name, since: dayOf(a.submitted_on), promised: dayOf(a.expected_response_on), next_check: check?.date || null,
      record: { type: 'APPLICATION', id: a.id, label: `${a.name} · ${a.account_name}`, url: `/applications/${a.id}` },
      overdue: Boolean(check && check.date < c.today),
    });
  }
  return out;
});
