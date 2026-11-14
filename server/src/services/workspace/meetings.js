/**
 * Meetings still to arrange, internal meetings (no organisation), and one
 * person's meetings for My workspace. Built on crm_meetings and
 * services/meetings.js; nothing here sends an invitation to anyone (there is
 * no invitation flow, and the screens say so).
 *
 *   TO_ARRANGE      someone has to find a time, by the arrange-by date
 *   TIME_PROPOSED   a time was put to the other side, not confirmed
 *   SCHEDULED       confirmed: date, time and timezone
 *
 * An unconfirmed meeting is never shown as a booked event and never gets a
 * start-time reminder.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { getSettings } from '../settings.js';
import { canSee, crmScope, localDate } from '../sales/core.js';
import {
  MEETING_KINDS, MEETING_MODES, UNCONFIRMED, canEditMeeting, createPrepTasks, decorateMeeting, getMeeting, loadMeeting,
  logMeetingActivity, notifyInternal, setParticipants, shiftPrepTasks, MEETING_SELECT, createFollowUpTask,
} from '../meetings.js';
import { addContributor } from './attention.js';
import { replanRecord } from './reminders.js';
import { canSeeRecord, validTimeZone } from './access.js';

const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

async function crmOn(user) {
  const s = await getSettings();
  return s.crm?.enabled !== false && hasPermission(user, 'crm.view');
}

/** Links to CRM records need the CRM and the right to log activity on records the person can see. */
async function checkLinks(user, input) {
  const linked = input.account_id || input.opportunity_id || input.lead_id;
  if (!linked) return {};
  if (!(await crmOn(user)) || !hasPermission(user, 'crm.activity.log')) throw forbidden('Linking a meeting to a CRM record needs permission to log CRM activity');
  const scope = await crmScope(user);
  let accountId = input.account_id || null;
  if (input.opportunity_id) {
    if (!(await canSee(scope, 'opportunity', input.opportunity_id))) throw notFound('Not available');
    const { rows } = await query('SELECT account_id FROM opportunities WHERE id = $1', [input.opportunity_id]);
    accountId = accountId || rows[0]?.account_id || null;
  }
  if (accountId && !(await canSee(scope, 'account', accountId))) throw notFound('Not available');
  if (input.lead_id && !(await canSee(scope, 'lead', input.lead_id))) throw notFound('Not available');
  return { accountId };
}

export async function createMeeting(user, input) {
  const status = input.status || 'SCHEDULED';
  if (!['SCHEDULED', 'TO_ARRANGE', 'TIME_PROPOSED'].includes(status)) throw badRequest('Choose whether the time is confirmed');
  if (input.kind && !MEETING_KINDS.includes(input.kind)) throw badRequest('Choose the kind of meeting');
  if (input.mode && !MEETING_MODES.includes(input.mode)) throw badRequest('Choose in person or online');
  const title = String(input.title || '').trim();
  if (title.length < 2) throw badRequest('Say what the meeting is about');
  if (status === 'SCHEDULED' && !input.scheduled_at) throw badRequest('Choose the confirmed date and time, or mark it as still to arrange');
  if (status !== 'SCHEDULED' && input.scheduled_at) throw badRequest('A meeting still to arrange has no confirmed time');
  if (status === 'TIME_PROPOSED' && !input.proposed_at) throw badRequest('Say which time was proposed');
  if (input.timezone && !validTimeZone(input.timezone)) throw badRequest('Choose a timezone from the list');
  const { accountId } = await checkLinks(user, input);
  const id = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO crm_meetings (account_id, opportunity_id, lead_id, kind, mode, title, objective, status, scheduled_at, first_scheduled_at,
                                 duration_min, timezone, location, meeting_url, owner_user_id, scheduling_owner_id, arrange_by, proposed_at, created_by)
       VALUES ($1, $2, $3, COALESCE($4, 'MEETING'), COALESCE($5, 'VIRTUAL'), $6, $7, $8, $9::timestamptz, $9::timestamptz,
               $10, COALESCE($11, 'Asia/Kolkata'), $12, $13, COALESCE($14::int, $18), $15, $16, $17, $18) RETURNING *`,
      [accountId || null, input.opportunity_id || null, input.lead_id || null, input.kind || null, input.mode || null, title.slice(0, 200),
        input.objective || null, status, status === 'SCHEDULED' ? input.scheduled_at : null, input.duration_min || null, input.timezone || null,
        input.location || null, input.meeting_url || null, input.owner_user_id || null,
        status === 'SCHEDULED' ? null : (input.scheduling_owner_id || user.id), input.arrange_by || null, input.proposed_at || null, user.id],
    );
    const m = rows[0];
    await setParticipants(client, m.id, { userIds: input.participant_user_ids || [], contactIds: [] });
    if (status === 'SCHEDULED' && m.account_id && input.create_prep_tasks) await createPrepTasks(client, m, user);
    if (m.account_id) {
      await logMeetingActivity(client, m, { actorId: user.id, subject: `Meeting ${status === 'SCHEDULED' ? 'scheduled' : 'to arrange'}: ${m.title}`, outcome: 'SCHEDULED' });
    }
    await notifyInternal(client, m, { actorId: user.id, title: `You are on: ${m.title}`, body: status === 'SCHEDULED' ? null : 'No time confirmed yet' });
    return m.id;
  });
  await replanRecord('MEETING', id);
  return getMeeting(id);
}

async function mustEdit(user, id) {
  const row = await loadMeeting(id);
  if (!row || !(await canSeeRecord(user, 'MEETING', id))) throw notFound('Not available');
  if (!canEditMeeting(user, row)) throw forbidden('Only the meeting\'s owner or the person arranging it can change it');
  return row;
}

export async function proposeTime(user, id, { proposed_at: at }) {
  const m = await mustEdit(user, id);
  if (!UNCONFIRMED.has(m.status)) throw badRequest('This meeting already has a confirmed time');
  if (!at || Number.isNaN(Date.parse(at))) throw badRequest('Say which time was proposed');
  await query(`UPDATE crm_meetings SET status = 'TIME_PROPOSED', proposed_at = $2, updated_at = now() WHERE id = $1`, [id, at]);
  await replanRecord('MEETING', id);
  return getMeeting(id);
}

/** The time is agreed: it becomes a booked meeting, with its preparation and start reminders. */
export async function confirmMeeting(user, id, { scheduled_at: at, timezone = null }) {
  const m = await mustEdit(user, id);
  if (!UNCONFIRMED.has(m.status)) throw badRequest('This meeting already has a confirmed time; reschedule it instead');
  if (!at || Number.isNaN(Date.parse(at))) throw badRequest('Choose the confirmed date and time');
  if (timezone && !validTimeZone(timezone)) throw badRequest('Choose a timezone from the list');
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE crm_meetings SET status = 'SCHEDULED', scheduled_at = $2::timestamptz, first_scheduled_at = COALESCE(first_scheduled_at, $2::timestamptz),
              timezone = COALESCE($3, timezone), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, at, timezone],
    );
    if (rows[0].account_id) await logMeetingActivity(client, rows[0], { actorId: user.id, subject: `Meeting confirmed: ${rows[0].title}`, outcome: 'SCHEDULED' });
  });
  await replanRecord('MEETING', id);
  return getMeeting(id);
}

/** A new time for a confirmed meeting: the old reminders are cancelled, new ones planned. */
export async function rescheduleMeeting(user, id, { scheduled_at: at, reason = null }) {
  const m = await mustEdit(user, id);
  if (m.status !== 'SCHEDULED') throw badRequest('Only a confirmed meeting can be rescheduled');
  if (!at || Number.isNaN(Date.parse(at))) throw badRequest('Choose the new date and time');
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE crm_meetings SET scheduled_at = $2::timestamptz, reschedule_count = reschedule_count + 1, updated_at = now() WHERE id = $1`, [id, at],
    );
    await shiftPrepTasks(client, id, at);
    if (m.account_id) await logMeetingActivity(client, { ...m, scheduled_at: at }, { actorId: user.id, subject: `Meeting moved: ${m.title}`, body: reason, outcome: 'SCHEDULED' });
  });
  await replanRecord('MEETING', id);
  return getMeeting(id);
}

export async function cancelMeeting(user, id, { reason }) {
  const m = await mustEdit(user, id);
  if (!['SCHEDULED', 'TO_ARRANGE', 'TIME_PROPOSED'].includes(m.status)) throw badRequest('This meeting is already closed');
  if (String(reason || '').trim().length < 3) throw badRequest('Say why it is cancelled');
  await query(`UPDATE crm_meetings SET status = 'CANCELLED', cancel_reason = $2, updated_at = now() WHERE id = $1`, [id, String(reason).slice(0, 500)]);
  await replanRecord('MEETING', id);
  return getMeeting(id);
}

/**
 * How it went, and what comes next. Only what the person writes is recorded:
 * no commitment is ever read out of the notes.
 */
export async function recordOutcome(user, id, { status, outcome, follow_up_title: followUp = null, follow_up_due: due = null }) {
  const m = await mustEdit(user, id);
  if (m.status !== 'SCHEDULED') throw badRequest('Only a confirmed meeting has an outcome');
  if (!['COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(status)) throw badRequest('Say whether it took place');
  if (status === 'COMPLETED' && String(outcome || '').trim().length < 3) throw badRequest('Say what came of it, in a few words');
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE crm_meetings SET status = $2, outcome = $3, completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END,
              cancel_reason = CASE WHEN $2 = 'CANCELLED' THEN $3 ELSE cancel_reason END, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, status, outcome ? String(outcome).slice(0, 4000) : null],
    );
    if (followUp) {
      await createFollowUpTask(client, rows[0], { title: String(followUp).slice(0, 200), assigneeId: user.id, dueDate: due || null }, user);
    }
    if (rows[0].account_id) await logMeetingActivity(client, rows[0], { actorId: user.id, subject: `${rows[0].title}: ${status.toLowerCase().replace('_', ' ')}`, body: outcome || null, outcome: status === 'COMPLETED' ? 'COMPLETED' : status });
  });
  await replanRecord('MEETING', id);
  return getMeeting(id);
}

/** One person's meetings: confirmed and coming, still to arrange, and past ones with no outcome. */
export async function myMeetings(user, { now = new Date(), graceHours = 24 } = {}) {
  const { rows } = await query(
    `${MEETING_SELECT}
      WHERE (m.owner_user_id = $1 OR m.scheduling_owner_id = $1 OR m.created_by = $1
             OR EXISTS (SELECT 1 FROM crm_meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $1))
        AND (m.status IN ('TO_ARRANGE', 'TIME_PROPOSED')
             OR (m.status = 'SCHEDULED' AND m.scheduled_at > $2::timestamptz - interval '30 days'))
      ORDER BY m.scheduled_at NULLS LAST, m.arrange_by NULLS LAST, m.id
      LIMIT 300`,
    [user.id, now],
  );
  const crm = await crmOn(user);
  const out = { upcoming: [], to_arrange: [], awaiting_outcome: [] };
  for (const r of rows) {
    // a meeting about a CRM record is shown only while the person can see it
    if ((r.account_id || r.opportunity_id || r.lead_id) && !crm && r.owner_user_id !== user.id) continue;
    const m = decorateMeeting(r, now.getTime());
    if (m.unconfirmed) { if ([m.scheduling_owner_id, m.owner_user_id, m.created_by].includes(user.id)) out.to_arrange.push(m); continue; }
    if (m.is_upcoming) out.upcoming.push(m);
    else if (m.awaiting_outcome && m.owner_user_id === user.id && new Date(m.scheduled_at).getTime() < now.getTime() - graceHours * 3_600_000) out.awaiting_outcome.push(m);
  }
  return out;
}

addContributor(async function meetingItems(user, ctx) {
  const mine = await myMeetings(user, { now: ctx.now });
  const tz = user.timezone || ctx.c.timezone;
  const today = localDate(ctx.now, tz);
  const out = [];
  for (const m of mine.upcoming) {
    if (localDate(new Date(m.scheduled_at), tz) !== today) continue;
    out.push({
      key: `MEETING_TODAY:MEETING:${m.id}:${new Date(m.scheduled_at).toISOString()}`, kind: 'MEETING_TODAY', dueToday: true,
      title: 'Meeting today', reason: m.account_name || m.opportunity_name || m.lead_name || 'Internal',
      record: { type: 'MEETING', id: m.id, label: m.title, url: `/meetings?meeting=${m.id}` }, related: [],
      when: { at: m.scheduled_at, dateOnly: false, timezone: m.timezone }, tier: 1, action: { label: 'Open', kind: 'OPEN' },
    });
  }
  for (const m of mine.to_arrange) {
    const by = dayOf(m.arrange_by);
    const days = by ? Math.round((Date.parse(`${by}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
    const tier = days === null ? 5 : days < 0 ? 2 : days === 0 ? 1 : days <= 3 ? 4 : 6;
    out.push({
      key: `MEETING_TO_ARRANGE:MEETING:${m.id}:${by || 'none'}`, kind: 'MEETING_TO_ARRANGE', overdue: Boolean(by && by < today), dueToday: by === today,
      title: m.status === 'TIME_PROPOSED' ? 'Confirm the proposed time' : 'Arrange this meeting',
      reason: by ? `To arrange by ${by}` : 'No date to arrange it by',
      record: { type: 'MEETING', id: m.id, label: m.title, url: `/meetings?meeting=${m.id}` }, related: [],
      when: by ? { date: by, dateOnly: true } : {}, tier, action: { label: 'Open', kind: 'OPEN' },
    });
  }
  for (const m of mine.awaiting_outcome) {
    out.push({
      key: `MEETING_OUTCOME_MISSING:MEETING:${m.id}:${new Date(m.scheduled_at).toISOString()}`, kind: 'MEETING_OUTCOME_MISSING', overdue: true,
      title: 'Record how the meeting went', reason: 'No outcome or next actions recorded yet',
      record: { type: 'MEETING', id: m.id, label: m.title, url: `/meetings?meeting=${m.id}` }, related: [],
      when: { at: m.scheduled_at, dateOnly: false }, tier: 2, action: { label: 'Record the outcome', kind: 'OPEN' },
    });
  }
  return out;
});
