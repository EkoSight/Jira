/**
 * The daily follow-up summary in Google Chat: one internal message a day to
 * each person, with their own follow-ups — what is overdue and what is due
 * today, at what time, for which lead, the latest context, the next action and
 * a link. Never sent to customers.
 *
 *   - **Theirs only:** follow-ups they owe, on leads and organizations their
 *     CRM access lets them open.
 *   - **When:** at the organization's time on its working days. Company,
 *     department and personal holidays from the attendance calendar are
 *     skipped. Administrators can skip or include a person.
 *   - **Who:** only people whose Google Chat direct message is linked to their
 *     TaskFlow login (Google reported the same email). Anyone else is listed
 *     as not reachable, never guessed.
 *   - **Once:** one row a person a day; the Chat message has a stable key. A
 *     restart, a retry or two servers cannot send it twice.
 *   - **Safe start:** off until switched on, and in test mode until an
 *     administrator turns that off. In test mode nothing reaches employees:
 *     who would get what is recorded, and any summary can be sent to the
 *     administrator themselves.
 */
import { config } from '../../config.js';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { getSettings, updateSetting } from '../settings.js';
import { policyOn, policyTimeline } from '../attendancePolicy.js';
import { holidaysBetween, scheduleOn } from '../attendance.js';
import { crmScope, scopeCondition, salesSettings } from './core.js';

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, weekday: DAY[p.weekday] };
}

export async function digestSettings() {
  const s = (await getSettings()).crmFollowUps || {};
  const d = s.digest || {};
  const timeline = await policyTimeline();
  const working = (policyOn(timeline, new Date().toISOString().slice(0, 10))?.config?.workingDays || [1, 2, 3, 4, 5, 6]).map((x) => (x === 0 ? 7 : x));
  return {
    chatReminders: s.chatReminders === true,
    enabled: d.enabled === true,
    testMode: d.testMode !== false,
    time: TIME.test(String(d.time)) ? d.time : '09:00',
    lastSendTime: TIME.test(String(d.lastSendTime)) ? d.lastSendTime : '13:00',
    days: Array.isArray(d.days) && d.days.length ? d.days : working,
    daysFromCalendar: !(Array.isArray(d.days) && d.days.length),
    skipHolidays: d.skipHolidays !== false,
  };
}

export async function saveDigestSettings(changes, actorId) {
  const current = (await getSettings()).crmFollowUps || {};
  const digest = { ...(current.digest || {}) };
  for (const k of ['enabled', 'testMode', 'skipHolidays']) if (changes[k] !== undefined) digest[k] = Boolean(changes[k]);
  for (const k of ['time', 'lastSendTime']) {
    if (changes[k] !== undefined) {
      if (!TIME.test(String(changes[k]))) throw badRequest('Give times as HH:MM, India time');
      digest[k] = changes[k];
    }
  }
  if (changes.days !== undefined) {
    const days = [...new Set((changes.days || []).map(Number))].filter((n) => n >= 1 && n <= 7).sort();
    digest.days = days;
  }
  if ((digest.time || '09:00') >= (digest.lastSendTime || '13:00')) throw badRequest('The latest sending time must be after the sending time');
  const next = { ...current, digest, ...(changes.chatReminders !== undefined ? { chatReminders: Boolean(changes.chatReminders) } : {}) };
  await updateSetting('crmFollowUps', next, actorId);
  return digestSettings();
}

/** Whether a person's direct message is linked to their login, and where it is. */
async function chatLink(userId) {
  const { rows } = await query(
    `SELECT s.space_name, s.added_by_email, u.email FROM chat_spaces s JOIN users u ON u.id = s.user_id
      WHERE s.kind = 'DM' AND s.user_id = $1 AND s.active`,
    [userId],
  );
  const r = rows[0];
  if (!r) return { linked: false, why: 'Not linked to Google Chat: they have not messaged TaskFlow in Chat yet' };
  if (r.added_by_email && r.added_by_email.toLowerCase() !== String(r.email).toLowerCase()) {
    return { linked: false, why: 'The Chat account that added TaskFlow is not this person\'s login email; an administrator should check it' };
  }
  return { linked: true, space: r.space_name };
}

/**
 * One person's summary for a day: their open follow-ups that are overdue or
 * due by the end of the day, inside their CRM access, with the latest note.
 */
export async function buildDigest(userId, { now = new Date() } = {}) {
  const sales = await salesSettings();
  const tz = sales.calendar?.timezone || 'Asia/Kolkata';
  const { rows: users } = await query('SELECT id, full_name, role, department_id, extra_permissions, revoked_permissions, is_active, email FROM users WHERE id = $1', [userId]);
  const user = users[0];
  if (!user) throw badRequest('No such person');
  const scope = await crmScope(user);
  const params = [userId, now, tz];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const leadOk = scopeCondition(scope, 'lead', 'l', push);
  const accountOk = scopeCondition(scope, 'account', 'a', push);
  const { rows } = await query(
    `SELECT t.id, t.title, t.description, t.followup_kind, t.due_date, t.crm_lead_id, t.account_id, t.opportunity_id,
            l.ref AS lead_ref, COALESCE(l.organization_name, l.contact_name, l.phone) AS lead_name, a.name AS account_name,
            (SELECT x.body FROM crm_lead_activities x WHERE x.lead_id = t.crm_lead_id AND x.body IS NOT NULL
                AND x.type IN ('CALL', 'NOTE', 'CALL_STATUS', 'IMPORT_NOTE') ORDER BY x.occurred_at DESC, x.id DESC LIMIT 1) AS last_note
       FROM tasks t LEFT JOIN crm_leads l ON l.id = t.crm_lead_id LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.assignee_id = $1 AND t.followup_kind IS NOT NULL AND t.completed_at IS NULL AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL
        AND t.due_date < (date_trunc('day', $2::timestamptz AT TIME ZONE $3) + interval '1 day') AT TIME ZONE $3
        AND (t.crm_lead_id IS NULL OR (l.merged_into_id IS NULL AND l.is_archived = FALSE AND ${leadOk}))
        AND (t.crm_lead_id IS NOT NULL OR t.account_id IS NULL OR ${accountOk})
      ORDER BY t.due_date ASC, t.id ASC`,
    params,
  );
  const fmt = (d) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d));
  const day = (d) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(d));
  const items = rows.map((t) => ({
    id: t.id, title: t.title, kind: t.followup_kind, due_at: t.due_date,
    overdue: new Date(t.due_date) < now,
    about: t.lead_name || t.account_name || 'Follow-up',
    ref: t.lead_ref,
    context: t.last_note ? String(t.last_note).replace(/\s+/g, ' ').slice(0, 140) : null,
    next_action: t.description ? String(t.description).replace(/\s+/g, ' ').slice(0, 140) : t.title,
    link: `${config.publicUrl}${t.crm_lead_id ? `/sales/leads/${t.crm_lead_id}` : t.account_id ? `/accounts/${t.account_id}` : '/sales?tab=day'}`,
  }));
  const overdue = items.filter((i) => i.overdue);
  const today = items.filter((i) => !i.overdue);
  const line = (i) => `• ${i.overdue ? `${day(i.due_at)} ${fmt(i.due_at)}` : fmt(i.due_at)} — *${i.about}*${i.ref ? ` (${i.ref})` : ''}: ${i.next_action}`
    + `${i.context ? `\n   Last: ${i.context}` : ''}\n   ${i.link}`;
  const first = String(user.full_name || '').split(' ')[0] || 'there';
  const text = [
    `Good morning ${first}. Your follow-ups for today (times in ${tz === 'Asia/Kolkata' ? 'IST' : tz}):`,
    overdue.length ? `\n*Overdue (${overdue.length})*\n${overdue.map(line).join('\n')}` : '',
    today.length ? `\n*Due today (${today.length})*\n${today.map(line).join('\n')}` : '',
    !items.length ? '\nNothing is due today.' : '',
    `\nYour day in TaskFlow: ${config.publicUrl}/sales?tab=day`,
    '\n_Internal summary for you only. Nothing is sent to customers._',
  ].filter(Boolean).join('\n');
  return { user: { id: user.id, name: user.full_name }, date: localNow(tz, now).date, timezone: tz, items, counts: { overdue: overdue.length, today: today.length }, text };
}

/** Whether a person gets a summary on a date, and if not, why. */
export async function digestEligibility(userId, date, settings) {
  const { rows } = await query(
    `SELECT u.id, u.is_active, u.department_id, e.mode, e.until, e.reason FROM users u LEFT JOIN crm_digest_exceptions e ON e.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u?.is_active) return { send: false, why: 'Account switched off' };
  const exception = u.mode && (!u.until || u.until >= date) ? u : null;
  if (exception?.mode === 'SKIP') return { send: false, why: `Skipped by an administrator${exception.reason ? `: ${exception.reason}` : ''}` };
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  if (!settings.days.includes(weekday) && exception?.mode !== 'INCLUDE') return { send: false, why: 'Not a working day' };
  if (settings.skipHolidays && exception?.mode !== 'INCLUDE') {
    const timeline = await policyTimeline();
    const { config: policy } = policyOn(timeline, date);
    const profile = (await query('SELECT * FROM employee_work_profiles WHERE user_id = $1', [userId])).rows[0] || null;
    const s = scheduleOn(date, { config: policy, profile, holidays: await holidaysBetween(date, date), departmentId: u.department_id, userId, ignoreStart: true, ignoreEmployment: true });
    if (s.state === 'HOLIDAY') return { send: false, why: `Holiday: ${s.holiday}` };
    if (s.state === 'WEEKLY_OFF') return { send: false, why: 'Their weekly day off' };
    const leave = await query(
      `SELECT 1 FROM leave_requests WHERE user_id = $1 AND status IN ('APPROVED_PAID', 'APPROVED_UNPAID') AND day_part = 'FULL' AND $2::date BETWEEN start_date AND end_date`,
      [userId, date],
    );
    if (leave.rows.length) return { send: false, why: 'On approved leave' };
  }
  const link = await chatLink(userId);
  if (!link.linked) return { send: false, why: link.why, unreachable: true };
  return { send: true, space: link.space };
}

/** A preview of one person's summary, and whether and why it would be sent today. */
export async function previewDigest(userId, { now = new Date() } = {}) {
  const settings = await digestSettings();
  const digest = await buildDigest(userId, { now });
  const eligibility = await digestEligibility(userId, digest.date, settings);
  return { ...digest, would_send: settings.enabled && !settings.testMode && eligibility.send && digest.items.length > 0, eligibility, settings };
}

/** Sends any person's summary to the administrator's own Chat, labelled as a test. */
export async function sendTestDigest(adminId, userId, { now = new Date() } = {}) {
  const digest = await buildDigest(userId, { now });
  const link = await chatLink(adminId);
  if (!link.linked) throw badRequest(`Your own Google Chat is not linked: ${link.why}`);
  const key = `crm-digest-test:${adminId}:${userId}:${now.getTime()}`;
  await query(
    `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload) VALUES ($1, $2, $3, 'CRM_DIGEST', $4) ON CONFLICT (dedupe_key) DO NOTHING`,
    [key, link.space, adminId, JSON.stringify({ text: `*TEST — ${digest.user.name}'s summary, sent only to you*\n\n${digest.text}` })],
  );
  await query(
    `INSERT INTO crm_digest_log (user_id, digest_date, status, reason, items, outbox_key, test) VALUES ($1, $2, 'QUEUED', $3, $4, $5, TRUE)
     ON CONFLICT (user_id, digest_date, test) DO UPDATE SET status = 'QUEUED', reason = EXCLUDED.reason, items = EXCLUDED.items, outbox_key = EXCLUDED.outbox_key, updated_at = now()`,
    [userId, digest.date, `Test sent to user ${adminId}`, digest.items.length, key],
  );
  return { queued: true, key, items: digest.items.length };
}

/**
 * The scheduled run: at or after the time, on a working day, each person with
 * something due gets one summary. A day is claimed per person before anything
 * is queued, so it happens once whatever the number of runs.
 */
export async function runFollowUpDigests(now = new Date()) {
  const settings = await digestSettings();
  if (!settings.enabled) return { skipped: 'off' };
  const tz = (await salesSettings()).calendar?.timezone || 'Asia/Kolkata';
  const local = localNow(tz, now);
  if (local.time < settings.time) return { skipped: 'not yet' };
  const late = local.time >= settings.lastSendTime;
  const { rows: people } = await query(
    `SELECT DISTINCT t.assignee_id AS id FROM tasks t JOIN users u ON u.id = t.assignee_id AND u.is_active
      WHERE t.followup_kind IS NOT NULL AND t.completed_at IS NULL AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL
        AND t.due_date < (date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2
        AND NOT EXISTS (SELECT 1 FROM crm_digest_log g WHERE g.user_id = t.assignee_id AND g.digest_date = $3 AND g.test = FALSE)`,
    [now, tz, local.date],
  );
  const out = { queued: 0, skipped: 0 };
  for (const p of people) {
    const eligibility = await digestEligibility(p.id, local.date, settings);
    const digest = eligibility.send ? await buildDigest(p.id, { now }) : null;
    let status = 'SKIPPED';
    let reason = eligibility.why || null;
    if (eligibility.send && !digest.items.length) reason = 'Nothing due';
    else if (eligibility.send && late) reason = `Not sent by ${settings.lastSendTime}; skipped rather than sent late`;
    else if (eligibility.send && settings.testMode) reason = 'Test mode: recorded, not sent';
    else if (eligibility.send) { status = 'QUEUED'; reason = null; }
    const key = status === 'QUEUED' ? `crm-digest:${p.id}:${local.date}` : null;
    await withTransaction(async (client) => {
      const { rows: claimed } = await client.query(
        `INSERT INTO crm_digest_log (user_id, digest_date, status, reason, items, outbox_key, test) VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         ON CONFLICT (user_id, digest_date, test) DO NOTHING RETURNING id`,
        [p.id, local.date, status, reason, digest?.items.length ?? 0, key],
      );
      if (!claimed[0] || status !== 'QUEUED') return;
      await client.query(
        `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload) VALUES ($1, $2, $3, 'CRM_DIGEST', $4) ON CONFLICT (dedupe_key) DO NOTHING`,
        [key, eligibility.space, p.id, JSON.stringify({ text: digest.text })],
      );
    });
    out[status === 'QUEUED' ? 'queued' : 'skipped'] += 1;
  }
  return out;
}

/** The record for a day: who was sent what, who was skipped and why, and the Chat delivery result. */
export async function digestLog(date) {
  const { rows } = await query(
    `SELECT g.*, u.full_name, o.status AS chat_status, o.last_error AS chat_error, o.sent_at AS chat_sent_at
       FROM crm_digest_log g JOIN users u ON u.id = g.user_id LEFT JOIN chat_outbox o ON o.dedupe_key = g.outbox_key
      WHERE g.digest_date = $1 ORDER BY g.test, u.full_name`,
    [date],
  );
  return rows.map((r) => ({ ...r, delivery: r.outbox_key ? (r.chat_status === 'SENT' ? 'SENT' : r.chat_status === 'FAILED' ? 'FAILED' : 'WAITING') : r.status }));
}

export async function digestExceptions() {
  const { rows } = await query(
    `SELECT e.*, u.full_name, s.full_name AS set_by_name FROM crm_digest_exceptions e JOIN users u ON u.id = e.user_id LEFT JOIN users s ON s.id = e.set_by ORDER BY u.full_name`,
  );
  return rows;
}

export async function setDigestException(userId, { mode, until = null, reason = null }, actorId) {
  if (mode === null) {
    await query('DELETE FROM crm_digest_exceptions WHERE user_id = $1', [userId]);
    return null;
  }
  if (!['SKIP', 'INCLUDE'].includes(mode)) throw badRequest('Choose skip or include');
  const { rows } = await query(
    `INSERT INTO crm_digest_exceptions (user_id, mode, until, reason, set_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, until = EXCLUDED.until, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()
     RETURNING *`,
    [userId, mode, until, reason ? String(reason).slice(0, 300) : null, actorId],
  );
  return rows[0];
}
