/**
 * The daily standup, in the company's Google Chat space.
 *
 *   09:30  one reminder, on the company's working days only
 *   09:40  submissions due — counted from when the reminder actually arrived,
 *          so a delayed reminder never shortens anyone's ten minutes
 *   after  every eligible member is reviewed: on time, late, missing, exempt
 *          or could not be reached, each kept apart; vague plans get a
 *          specific, polite request in their own thread
 *   11:00  anything still unresolved goes privately to the reviewers
 *
 * What it never does: post who is missing in the space, change attendance,
 * leave or pay, or create black marks. A missing or vague standup is not proof
 * of anything; it is recorded for a person to look at.
 *
 * Duplicate runs, retries and restarts are safe: each day is one row, each
 * Chat message has a stable outbox key, and the review claims its day before
 * it starts.
 */

import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { chatText, listSpaceMessages } from '../lib/googleChat.js';
import {
  correctedText, feedbackText, looksLikeStandup, normaliseForm, parseStandupText, postText, reminderText,
  reviewContent, taskReference,
} from '../lib/standup.js';
import { getSettings } from './settings.js';
import { getPolicyFor } from './attendancePolicy.js';
import { addDays, dateIn, holidaysBetween, instantAt, scheduleOn, secondsInto } from './attendance.js';
import { notify } from './activity.js';


const app = (path = '/') => `${config.publicUrl}${path}`;
const formLink = () => app('/standup');
const clock = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 3600 + m * 60; };
const SETTLE_MS = 2 * 60 * 1000;
const STALE_CLAIM = "interval '5 minutes'";

/** The standup settings (defaults in settings.js), with the organisation's timezone. */
export async function standupSettings() {
  const settings = await getSettings();
  return { ...(settings.standup || {}), timezone: settings.organisation?.timezone || 'Asia/Kolkata' };
}

const norm = (name) => String(name || '').toLowerCase().replace(/[^a-zऀ-ॿ ]/g, ' ').replace(/\s+/g, ' ').trim();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';

/** A local outbox insert — the same table and guarantees as every other Chat message. */
async function enqueue(runner, { dedupeKey, spaceName, userId = null, kind, payload }) {
  const { rowCount } = await (runner || { query }).query(
    `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [dedupeKey, spaceName, userId, kind, JSON.stringify(payload)],
  );
  return rowCount > 0;
}

async function directSpace(userId) {
  if (!userId) return null;
  const { rows } = await query(`SELECT space_name FROM chat_spaces WHERE kind = 'DM' AND user_id = $1 AND active`, [userId]);
  return rows[0]?.space_name || null;
}

// ---------------------------------------------------------------- the calendar

/**
 * Whether the company works on a date: its weekly days and company-wide
 * holidays, from the same calendar attendance uses. A company holiday that
 * takes the morning off covers the standup, so the day is skipped; one that
 * takes only the afternoon off does not.
 */
export async function companyDay(date) {
  const { config: policy } = await getPolicyFor(date);
  const holidays = await holidaysBetween(date, date);
  const schedule = scheduleOn(date, {
    config: { ...policy, workingDays: policy.workingDays || [1, 2, 3, 4, 5, 6] },
    profile: null, holidays, departmentId: null, userId: null, ignoreStart: true, ignoreEmployment: true,
  });
  if (schedule.state === 'WEEKLY_OFF') return { working: false, reason: 'WEEKLY_OFF' };
  if (schedule.state === 'HOLIDAY') return { working: false, reason: `HOLIDAY: ${schedule.holiday}` };
  if (schedule.holidayHalf === 'FIRST_HALF') return { working: false, reason: `HOLIDAY: ${schedule.holiday} (morning)` };
  return { working: true };
}

/**
 * Who is expected on a date, and who is excused and why. Members with an
 * unverified identity, and former staff, are left out entirely — listed, not
 * counted — until someone resolves them.
 */
export async function eligibility(date) {
  const { rows: members } = await query(
    `SELECT m.*, u.is_active AS user_active, u.email AS user_email, u.role AS user_role, p.joining_date::text AS joining_date,
            p.exit_date::text AS exit_date, p.working_days, COALESCE(m.department_id, u.department_id) AS dept
       FROM standup_members m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN employee_work_profiles p ON p.user_id = m.user_id
      WHERE m.active
      ORDER BY m.full_name`,
  );
  const holidays = await holidaysBetween(date, date);
  const userIds = members.filter((m) => m.user_id).map((m) => m.user_id);
  const { rows: leave } = userIds.length ? await query(
    `SELECT user_id, status, day_part FROM leave_requests
      WHERE user_id = ANY($1::int[]) AND $2::date BETWEEN start_date AND end_date
        AND status IN ('APPROVED_PAID', 'APPROVED_UNPAID', 'SUBMITTED', 'EMERGENCY_REVIEW', 'NOTICE_EXCEPTION')`,
    [userIds, date],
  ) : { rows: [] };
  const { config: policy } = await getPolicyFor(date);
  const config = { ...policy, workingDays: policy.workingDays || [1, 2, 3, 4, 5, 6] };

  const expected = [];
  const exempt = [];
  const excluded = [];
  for (const m of members) {
    if (m.identity_status !== 'VERIFIED') { excluded.push({ member: m, reason: 'IDENTITY_NOT_VERIFIED' }); continue; }
    if (m.user_id && m.user_active === false) { excluded.push({ member: m, reason: 'FORMER_STAFF' }); continue; }
    // the founders are outside daily work tracking: welcome to post, never expected
    if (m.user_role === 'super_admin') { excluded.push({ member: m, reason: 'NOT_TRACKED' }); continue; }
    if (m.exit_date && m.exit_date < date) { excluded.push({ member: m, reason: 'FORMER_STAFF' }); continue; }
    if (m.joining_date && m.joining_date > date) { exempt.push({ member: m, reason: 'NOT_YET_JOINED' }); continue; }
    const mine = leave.filter((l) => l.user_id === m.user_id);
    const approved = mine.find((l) => l.status.startsWith('APPROVED') && l.day_part !== 'SECOND_HALF');
    if (approved) { exempt.push({ member: m, reason: approved.day_part === 'FIRST_HALF' ? 'LEAVE_MORNING' : 'LEAVE' }); continue; }
    const pending = mine.find((l) => !l.status.startsWith('APPROVED') && l.day_part !== 'SECOND_HALF');
    if (pending) { exempt.push({ member: m, reason: 'LEAVE_PENDING' }); continue; }
    // the person's own schedule: weekly days, and department or personal holidays
    const schedule = scheduleOn(date, {
      config, profile: { working_days: m.working_days }, holidays, departmentId: m.dept ?? null,
      userId: m.user_id ?? null, ignoreStart: true, ignoreEmployment: true,
    });
    if (schedule.state === 'WEEKLY_OFF') { exempt.push({ member: m, reason: 'WEEKLY_OFF' }); continue; }
    if (schedule.state === 'HOLIDAY') { exempt.push({ member: m, reason: `HOLIDAY: ${schedule.holiday}` }); continue; }
    if (schedule.holidayHalf === 'FIRST_HALF') { exempt.push({ member: m, reason: `HOLIDAY: ${schedule.holiday} (morning)` }); continue; }
    expected.push(m);
  }
  return { expected, exempt, excluded };
}

// ---------------------------------------------------------------- the day

/**
 * Today's row, created once the reminder is due. A day the company does not
 * work is recorded as skipped, so the evidence shows it was considered.
 */
export async function ensureDay(now = new Date()) {
  const s = await standupSettings();
  if (!s.enabled || !s.spaceName) return null;
  const date = dateIn(s.timezone, now);
  const reminderAt = instantAt(date, clock(s.reminderTime), s.timezone);
  if (now < reminderAt) return null;
  const day = await companyDay(date);
  await query(
    `INSERT INTO standup_days (work_date, space_name, timezone, reminder_due_at, deadline_at, status, skipped_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (work_date) DO NOTHING`,
    [date, s.spaceName, s.timezone, reminderAt, instantAt(date, clock(s.deadline), s.timezone),
      day.working ? 'OPEN' : 'SKIPPED', day.working ? null : day.reason],
  );
  const { rows } = await query('SELECT * FROM standup_days WHERE work_date = $1', [date]);
  return rows[0];
}

async function addNote(dayId, note) {
  await query(
    `UPDATE standup_days SET notes = notes || $2::jsonb, updated_at = now()
      WHERE id = $1 AND NOT (notes @> $2::jsonb)`,
    [dayId, JSON.stringify([note])],
  );
}

const dateLabel = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
  .format(new Date(`${date}T00:00:00Z`));

/** The one reminder: only between its time and the deadline. Too late is recorded, not sent. */
export async function queueReminder(day, now = new Date()) {
  if (day.status !== 'OPEN' || day.reminder_key) return false;
  const s = await standupSettings();
  if (now >= new Date(day.deadline_at)) {
    await addNote(day.id, { code: 'REMINDER_WINDOW_MISSED', at: day.deadline_at, text: 'TaskFlow was not running between the reminder time and the deadline, so no reminder was sent.' });
    return false;
  }
  const key = `standup:reminder:${day.work_date}`;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE standup_days SET reminder_key = $2, reminder_queued_at = $3, updated_at = now()
        WHERE id = $1 AND reminder_key IS NULL RETURNING id`,
      [day.id, key, now],
    );
    if (!rows[0]) return false;
    await enqueue(client, {
      dedupeKey: key, spaceName: day.space_name, kind: 'STANDUP_REMINDER',
      payload: {
        text: reminderText({ dateLabel: dateLabel(day.work_date), deadline: s.deadline, link: formLink(), minItems: s.minItems, maxItems: s.maxItems }),
        thread: { threadKey: `standup-${day.work_date}` },
      },
    });
    return true;
  });
}

/**
 * Reads the reminder's delivery back from the outbox. Once it is out, the
 * deadline in force is the reminder's own window counted from delivery.
 */
export async function syncReminder(day) {
  if (!day.reminder_key || day.reminder_sent_at) return day;
  const { rows } = await query('SELECT status, sent_at, thread_name, last_error FROM chat_outbox WHERE dedupe_key = $1', [day.reminder_key]);
  const row = rows[0];
  if (row?.status === 'SENT' && row.sent_at) {
    const windowMs = new Date(day.deadline_at) - new Date(day.reminder_due_at);
    const effective = new Date(Math.max(new Date(day.deadline_at).getTime(), new Date(row.sent_at).getTime() + windowMs));
    const { rows: updated } = await query(
      `UPDATE standup_days SET reminder_sent_at = $2, reminder_thread = $3, effective_deadline_at = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [day.id, row.sent_at, row.thread_name, effective],
    );
    if (effective > new Date(day.deadline_at)) {
      await addNote(day.id, { code: 'REMINDER_DELAYED', at: row.sent_at, text: `The reminder was delivered late, so the deadline moved to give the full window.` });
    }
    return updated[0];
  }
  if (row?.status === 'FAILED') {
    await addNote(day.id, { code: 'REMINDER_FAILED', text: `Google Chat did not accept the reminder: ${String(row.last_error || '').slice(0, 200)}` });
  }
  return day;
}

/** The instant a submission counts as on time until. */
const deadlineOf = (day) => new Date(day.effective_deadline_at || day.deadline_at);

// ---------------------------------------------------------------- members and identity

export async function memberById(id) {
  const { rows } = await query('SELECT * FROM standup_members WHERE id = $1', [id]);
  return rows[0] || null;
}

/** The member a TaskFlow login can submit for: their own, or one of the people sharing it. */
export async function membersForLogin(userId) {
  const { rows } = await query(
    `SELECT * FROM standup_members WHERE active AND (user_id = $1 OR shared_account_id = $1) ORDER BY (user_id = $1) DESC NULLS LAST, full_name`,
    [userId],
  );
  return rows;
}

/**
 * Which member a Chat message is from. A shared account must name one of the
 * people who share it; an account outside the company, or not yet verified,
 * is never guessed.
 */
export async function matchSender({ chatName, email, namedPerson }, s) {
  const { rows } = await query(
    `SELECT m.*, u.email AS user_email FROM standup_members m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN users sa ON sa.id = m.shared_account_id
       LEFT JOIN chat_preferences cp ON cp.user_id = m.user_id
      WHERE m.active AND (
            ($1::text IS NOT NULL AND (m.chat_user_name = $1 OR cp.google_user_name = $1))
         OR ($2::text IS NOT NULL AND (lower(m.chat_email) = lower($2) OR lower(u.email) = lower($2) OR lower(sa.email) = lower($2))))`,
    [chatName || null, email || null],
  );
  if (!rows.length) return { reason: 'UNKNOWN_SENDER' };
  let candidates = rows;
  if (rows.length > 1) {
    // a shared account: the name on the first line decides, exactly
    const named = norm(namedPerson);
    candidates = rows.filter((m) => norm(m.full_name) === named);
    if (candidates.length !== 1) return { reason: 'SHARED_ACCOUNT_NAME_NOT_MATCHED' };
  } else if (namedPerson && norm(namedPerson) !== norm(rows[0].full_name) && norm(firstName(namedPerson)) !== norm(firstName(rows[0].full_name))) {
    // someone posting under another person's name is not attributed to either
    return { reason: 'NAME_DOES_NOT_MATCH_ACCOUNT' };
  }
  const member = candidates[0];
  if (member.identity_status !== 'VERIFIED') return { reason: 'IDENTITY_NOT_VERIFIED', member };
  const external = email && !s.companyDomains.includes(domainOf(email));
  if (external && !(member.chat_email && member.chat_email.toLowerCase() === email.toLowerCase())) {
    return { reason: 'EXTERNAL_ACCOUNT_NOT_MAPPED', member };
  }
  return { member };
}

// ---------------------------------------------------------------- submissions

async function taskLookups(content) {
  const out = new Map();
  for (const item of content.items || []) {
    const ref = taskReference(item.task);
    if (!ref || out.has(item.task)) continue;
    const { rows } = ref.ref
      ? await query('SELECT t.id, t.ref, t.title, t.is_archived, s.stage FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id WHERE t.ref = $1', [ref.ref])
      : await query('SELECT t.id, t.ref, t.title, t.is_archived, s.stage FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id WHERE t.id = $1', [ref.taskId]);
    out.set(item.task, rows[0] ? { exists: true, id: rows[0].id, ref: rows[0].ref, title: rows[0].title, stage: rows[0].stage, archived: rows[0].is_archived } : { exists: false });
  }
  return out;
}

/** What the reviewer would say about this content now — shown in the form as you type. */
export async function checkContent(content, { submittedAt = new Date() } = {}) {
  const s = await standupSettings();
  const today = dateIn(s.timezone, submittedAt);
  return reviewContent(content, {
    minItems: s.minItems, maxItems: s.maxItems,
    submittedAtSeconds: secondsInto(today, submittedAt, s.timezone),
    tasks: await taskLookups(content),
  });
}

/**
 * Records one version of a member's standup. The first arrival time is kept
 * for good; a later version is a correction, never a replacement.
 */
async function recordVersion({ member, content, source, now, submittedByUserId = null, submittedByChat = null, chatMessage = null, rawText = null }) {
  const s = await standupSettings();
  const date = dateIn(s.timezone, now);
  return withTransaction(async (client) => {
    if (chatMessage?.name) {
      const { rows: seen } = await client.query(
        'SELECT submission_id, version FROM standup_submission_versions WHERE chat_message_name = $1', [chatMessage.name],
      );
      if (seen[0]) return { submissionId: seen[0].submission_id, version: seen[0].version, duplicate: true };
    }
    // only a message posted in the standup space is the standup's home thread;
    // one sent privately gets its home when TaskFlow posts it in the space
    const inSpace = source === 'CHAT_SPACE' ? chatMessage : null;
    await client.query(
      `INSERT INTO standup_submissions (work_date, member_id, first_submitted_at, first_source, current_version, chat_message_name, chat_thread_name)
       VALUES ($1, $2, $3, $4, 0, $5, $6) ON CONFLICT (work_date, member_id) DO NOTHING`,
      [date, member.id, now, source, inSpace?.name || null, inSpace?.thread || null],
    );
    const { rows } = await client.query(
      'SELECT * FROM standup_submissions WHERE work_date = $1 AND member_id = $2 FOR UPDATE', [date, member.id],
    );
    const sub = rows[0];
    const version = sub.current_version + 1;
    await client.query(
      `INSERT INTO standup_submission_versions (submission_id, version, source, submitted_by_user_id, submitted_by_chat,
          chat_message_name, received_at, content, raw_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [sub.id, version, source, submittedByUserId, submittedByChat, chatMessage?.name || null, now,
        JSON.stringify({ ...content, name: member.full_name, named_as: content.name || null }), rawText],
    );
    await client.query(
      `UPDATE standup_submissions SET current_version = $2,
              chat_thread_name = COALESCE(chat_thread_name, $3), chat_message_name = COALESCE(chat_message_name, $4), updated_at = now()
        WHERE id = $1`,
      [sub.id, version, inSpace?.thread || null, inSpace?.name || null],
    );
    return { submissionId: sub.id, version, date, first: version === 1 };
  });
}

const threadFor = (sub) => (sub.chat_thread_name ? { name: sub.chat_thread_name } : { threadKey: `standup-${sub.work_date}-m${sub.member_id}` });

/**
 * A version that came from the form or a direct message is posted in the
 * space: the first in its own thread, a correction as a reply in that thread,
 * so the original stays visible. A version posted in the space is already there.
 */
async function postToSpace(submissionId, version) {
  const { rows } = await query(
    `SELECT s.*, v.content, v.source AS version_source, d.space_name FROM standup_submissions s
       JOIN standup_submission_versions v ON v.submission_id = s.id AND v.version = $2
       LEFT JOIN standup_days d ON d.work_date = s.work_date
      WHERE s.id = $1`,
    [submissionId, version],
  );
  const row = rows[0];
  const s = await standupSettings();
  const space = row?.space_name || s.spaceName;
  if (!row || !space || row.version_source === 'CHAT_SPACE') return;
  const text = version === 1 ? postText(row.content, { link: formLink() })
    : `*Corrected (version ${version})*\n${postText(row.content, { link: formLink() })}`;
  await enqueue(null, {
    dedupeKey: `standup:post:${submissionId}:v${version}`, spaceName: space, kind: 'STANDUP_POST',
    payload: { text, thread: threadFor(row) },
  });
}


/**
 * Reviews the current version of one submission: feedback in its thread when
 * the plan needs sharpening, thanks once it has been corrected. Each version
 * is reviewed once; a retry sends nothing twice.
 */
export async function reviewSubmission(submissionId, now = new Date()) {
  const { rows } = await query(
    `SELECT s.*, v.content, v.received_at, m.full_name, m.user_id, d.space_name, d.status AS day_status
       FROM standup_submissions s
       JOIN standup_submission_versions v ON v.submission_id = s.id AND v.version = s.current_version
       JOIN standup_members m ON m.id = s.member_id
       LEFT JOIN standup_days d ON d.work_date = s.work_date
      WHERE s.id = $1`,
    [submissionId],
  );
  const sub = rows[0];
  if (!sub || sub.reviewed_version === sub.current_version) return sub;
  const s = await standupSettings();
  const findings = reviewContent(sub.content, {
    minItems: s.minItems, maxItems: s.maxItems,
    submittedAtSeconds: secondsInto(sub.work_date, sub.received_at, s.timezone),
    tasks: await taskLookups(sub.content),
  });
  const space = sub.space_name || s.spaceName;
  const wasWaiting = sub.quality === 'NEEDS_CORRECTION';
  const quality = findings.length ? 'NEEDS_CORRECTION' : (wasWaiting ? 'CORRECTED' : 'OK');
  const { rowCount } = await query(
    `UPDATE standup_submissions SET quality = $2, findings = $3, reviewed_version = $4, updated_at = now()
      WHERE id = $1 AND (reviewed_version IS DISTINCT FROM $4)`,
    [sub.id, quality, JSON.stringify(findings), sub.current_version],
  );
  if (!rowCount || !space) return { ...sub, quality, findings };
  if (findings.length) {
    await enqueue(null, {
      dedupeKey: `standup:feedback:${sub.id}:v${sub.current_version}`, spaceName: space, userId: sub.user_id, kind: 'STANDUP_FEEDBACK',
      payload: { text: feedbackText({ firstName: chatText(firstName(sub.full_name)), findings, link: formLink() }), thread: threadFor(sub) },
    });
  } else if (wasWaiting) {
    await enqueue(null, {
      dedupeKey: `standup:corrected:${sub.id}:v${sub.current_version}`, spaceName: space, userId: sub.user_id, kind: 'STANDUP_FEEDBACK',
      payload: { text: correctedText({ firstName: chatText(firstName(sub.full_name)) }), thread: threadFor(sub) },
    });
  }
  return { ...sub, quality, findings };
}

/**
 * After a submission lands: if the day has already been reviewed, it is
 * reviewed now (late, or a correction) and its review row is brought up to date.
 */
async function afterSubmission(submissionId, now) {
  const { rows } = await query(
    `SELECT s.*, d.status AS day_status, d.deadline_at, d.effective_deadline_at
       FROM standup_submissions s LEFT JOIN standup_days d ON d.work_date = s.work_date WHERE s.id = $1`,
    [submissionId],
  );
  const sub = rows[0];
  if (!sub || !['REVIEWED', 'ESCALATED'].includes(sub.day_status)) return;
  const timing = new Date(sub.first_submitted_at) <= deadlineOf(sub) ? 'ON_TIME' : 'LATE';
  await query('UPDATE standup_submissions SET timing = $2 WHERE id = $1', [sub.id, timing]);
  // was missing at the review, or reviewed before this arrived
  await query(
    `INSERT INTO standup_reviews (work_date, member_id, status, reason, submission_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (work_date, member_id) DO UPDATE SET
       status = CASE WHEN standup_reviews.status IN ('MISSING', 'INACCESSIBLE') THEN EXCLUDED.status ELSE standup_reviews.status END,
       reason = CASE WHEN standup_reviews.status IN ('MISSING', 'INACCESSIBLE') THEN 'SUBMITTED_AFTER_REVIEW' ELSE standup_reviews.reason END,
       submission_id = EXCLUDED.submission_id`,
    [sub.work_date, sub.member_id, timing, null, sub.id],
  );
  await reviewSubmission(sub.id, now);
}

/** A standup from the TaskFlow form — for the person signed in, or someone they share a login with. */
export async function submitFromApp(actor, { memberId = null, ...input }, now = new Date()) {
  const s = await standupSettings();
  if (!s.enabled) throw conflict('The daily standup is not switched on');
  const options = await membersForLogin(actor.id);
  let member = memberId ? options.find((m) => m.id === Number(memberId)) : null;
  if (memberId && !member) throw forbidden('You can post a standup only for yourself, or for someone who shares your login');
  if (!member) {
    if (options.length > 1) throw badRequest('This login is shared — choose whose standup this is', { code: 'CHOOSE_PERSON', members: options.map((m) => ({ id: m.id, full_name: m.full_name })) });
    member = options[0];
  }
  if (!member) throw notFound('You are not on the standup list yet — ask an admin to add you');
  const today = dateIn(s.timezone, now);
  const content = normaliseForm({ ...input, name: member.full_name, role: input.role || member.role_title }, { today });
  if (!content.items.length) throw badRequest('Add at least one item');
  const result = await recordVersion({ member, content, source: 'APP', now, submittedByUserId: actor.id });
  await postToSpace(result.submissionId, result.version);
  await afterSubmission(result.submissionId, now);
  return { ...result, member: { id: member.id, full_name: member.full_name }, findings: await checkContent(content, { submittedAt: now }) };
}

/**
 * A standup that arrived in Chat — a direct message starting "standup", or a
 * message in the standup space that mentions TaskFlow (or was read from the
 * space). Returns the reply to show the sender. Never attributes a message it
 * cannot be sure of: those are held for a person.
 */
export async function submitFromChat({ source, text, sender = {}, message = {}, now = new Date() }) {
  const s = await standupSettings();
  if (!s.enabled) return { text: 'The daily standup is not switched on in TaskFlow yet.' };
  const today = dateIn(s.timezone, now);
  const parsed = parseStandupText(text, { today });
  if (!looksLikeStandup(parsed)) {
    return {
      text: 'I couldn’t read that as a standup. The first line is `Name | Date | Role`, then one line per item: '
        + '`TaskFlow ID | what you will do | what will exist when done | HH:MM`, then `Blockers: … | Owner: … | By: HH:MM` (or `Blockers: none`). '
        + `Or use the form: ${formLink()}`,
      handled: false,
    };
  }
  if (parsed.date && parsed.date !== today) {
    return { text: `This standup is dated ${parsed.date}, but today is ${today}. Please post today’s.`, handled: false };
  }
  const match = await matchSender({ chatName: sender.name, email: sender.email, namedPerson: parsed.name }, s);
  if (!match.member || match.reason) {
    await query(
      `INSERT INTO standup_unmatched (work_date, source, chat_message_name, chat_thread_name, sender_chat, sender_email, named_person, reason, raw_text, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (chat_message_name) DO NOTHING`,
      [today, source, message.name || null, message.thread || null, sender.name || null, sender.email || null, parsed.name, match.reason, String(text).slice(0, 4000), now],
    );
    return {
      text: 'Thanks — I couldn’t match this standup to one person on the standup list'
        + `${match.reason === 'SHARED_ACCOUNT_NAME_NOT_MATCHED' ? ' (this account is shared, so the first line must carry your full name exactly as it is on the list)' : ''}. `
        + 'An admin will check it; nothing is counted for anyone until then.',
      handled: true, held: match.reason,
    };
  }
  let result;
  try {
    result = await recordVersion({
      member: match.member, content: parsed, source, now,
      submittedByUserId: null, submittedByChat: sender.name || sender.email || null,
      chatMessage: message.name ? { name: message.name, thread: message.thread || null } : null, rawText: String(text).slice(0, 4000),
    });
  } catch (err) {
    // the same message delivered twice at the same moment: one of them wins
    if (err?.code === '23505') return { text: 'Already recorded.', handled: true, duplicate: true };
    throw err;
  }
  if (result.duplicate) return { text: 'Already recorded.', handled: true, duplicate: true };
  if (source === 'CHAT_DM') await postToSpace(result.submissionId, result.version);
  await afterSubmission(result.submissionId, now);
  const at = new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return {
    text: `Got it, ${chatText(firstName(match.member.full_name))} — ${result.version > 1 ? `correction (version ${result.version})` : 'standup'} recorded at ${at}.`,
    handled: true, submissionId: result.submissionId,
  };
}

/** Optional: read standups people simply posted in the space. Each message is recorded once. */
export async function syncSpace(day, now = new Date()) {
  const s = await standupSettings();
  if (!s.readSpaceAs || !day || day.status === 'SKIPPED') return { read: 0 };
  const since = new Date(new Date(day.reminder_due_at).getTime() - 30 * 60 * 1000);
  const cutoff = instantAt(day.work_date, clock(s.reviewCutoff), s.timezone);
  if (now > new Date(cutoff.getTime() + 60 * 60 * 1000)) return { read: 0 };
  const messages = await listSpaceMessages(day.space_name, { since, readAs: s.readSpaceAs });
  let read = 0;
  for (const m of messages) {
    if (m.sender?.type && m.sender.type !== 'HUMAN') continue;
    const text = m.text || '';
    if (!/\|/.test(text)) continue;
    const result = await submitFromChat({
      source: 'CHAT_SPACE', text,
      sender: { name: m.sender?.name || null, email: null },
      message: { name: m.name, thread: m.thread?.name || null },
      now: m.createTime ? new Date(m.createTime) : now,
    });
    if (result.handled && !result.duplicate) read += 1;
  }
  return { read };
}

// ---------------------------------------------------------------- the review

/**
 * After the deadline: every eligible member, classified. Runs once per day —
 * the day is claimed first — and every message it sends has a stable key.
 */
export async function reviewDay(day, now = new Date()) {
  const s = await standupSettings();
  if (day.status !== 'OPEN' && day.status !== 'REVIEWING') return { reviewed: false };
  const cutoff = instantAt(day.work_date, clock(s.reviewCutoff), s.timezone);
  const reminderOut = Boolean(day.reminder_sent_at);
  const due = reminderOut ? new Date(deadlineOf(day).getTime() + SETTLE_MS) : cutoff;
  if (now < due) return { reviewed: false, waitingUntil: due };

  const { rows: claimed } = await query(
    `UPDATE standup_days SET status = 'REVIEWING', updated_at = now()
      WHERE id = $1 AND (status = 'OPEN' OR (status = 'REVIEWING' AND updated_at < now() - ${STALE_CLAIM}))
      RETURNING *`,
    [day.id],
  );
  if (!claimed[0]) return { reviewed: false, claimedElsewhere: true };
  const deadline = deadlineOf(claimed[0]);

  const { expected, exempt } = await eligibility(day.work_date);
  const { rows: subs } = await query('SELECT * FROM standup_submissions WHERE work_date = $1', [day.work_date]);
  const byMember = new Map(subs.map((x) => [x.member_id, x]));
  const counts = { ON_TIME: 0, LATE: 0, MISSING: 0, EXEMPT: 0, INACCESSIBLE: 0 };
  const write = async (memberId, status, reason, submissionId = null) => {
    counts[status] += 1;
    await query(
      `INSERT INTO standup_reviews (work_date, member_id, status, reason, submission_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (work_date, member_id) DO NOTHING`,
      [day.work_date, memberId, status, reason, submissionId],
    );
  };

  for (const { member, reason } of exempt) {
    const sub = byMember.get(member.id);
    // someone on leave who posted anyway is not marked late for it
    await write(member.id, 'EXEMPT', reason, sub?.id || null);
  }
  for (const member of expected) {
    const sub = byMember.get(member.id);
    if (sub) {
      const timing = new Date(sub.first_submitted_at) <= deadline ? 'ON_TIME' : 'LATE';
      await query('UPDATE standup_submissions SET timing = $2 WHERE id = $1', [sub.id, timing]);
      await write(member.id, timing, null, sub.id);
    } else if (!reminderOut) {
      // nobody can be called missing for a reminder that never reached them
      await write(member.id, 'INACCESSIBLE', day.reminder_key ? 'REMINDER_NOT_DELIVERED' : 'REMINDER_NOT_SENT');
    } else {
      await write(member.id, 'MISSING', null);
      // a private, friendly word to the person — never a public list
      const dm = await directSpace(member.user_id);
      if (dm) {
        await enqueue(null, {
          dedupeKey: `standup:nudge:${day.work_date}:m${member.id}`, spaceName: dm, userId: member.user_id, kind: 'STANDUP_NUDGE',
          payload: {
            text: `Hi ${chatText(firstName(member.full_name))} — I didn’t see your standup for today. If you’re on leave, in the field or it just slipped, that’s fine: you can still post it here (start with “standup”) or in TaskFlow: ${formLink()}`,
          },
        });
      }
    }
  }
  // every submission of the day gets its quality review, eligible or not
  for (const sub of subs) await reviewSubmission(sub.id, now);

  await query(
    `UPDATE standup_days SET status = 'REVIEWED', reviewed_at = $2, updated_at = now() WHERE id = $1`,
    [day.id, now],
  );
  return { reviewed: true, counts };
}

/** What still needs a person, for a day. */
export async function unresolved(date) {
  const { rows: reviews } = await query(
    `SELECT r.status, r.reason, r.member_id, m.full_name FROM standup_reviews r JOIN standup_members m ON m.id = r.member_id
      WHERE r.work_date = $1 AND r.resolution IS NULL AND r.status IN ('MISSING', 'INACCESSIBLE')`,
    [date],
  );
  const { rows: corrections } = await query(
    `SELECT s.id, s.member_id, m.full_name FROM standup_submissions s JOIN standup_members m ON m.id = s.member_id
      WHERE s.work_date = $1 AND s.quality = 'NEEDS_CORRECTION'`,
    [date],
  );
  const { rows: unmatched } = await query(
    'SELECT id, reason, named_person FROM standup_unmatched WHERE work_date = $1 AND resolved_at IS NULL', [date],
  );
  return {
    missing: reviews.filter((r) => r.status === 'MISSING'),
    inaccessible: reviews.filter((r) => r.status === 'INACCESSIBLE'),
    corrections,
    unmatched,
  };
}

/**
 * At the escalation time: one private message to each reviewer, with counts
 * and a link — names stay in TaskFlow, behind permissions.
 */
export async function escalateDay(day, now = new Date()) {
  const s = await standupSettings();
  if (day.status !== 'REVIEWED') return { escalated: false };
  if (now < instantAt(day.work_date, clock(s.escalationTime), s.timezone)) return { escalated: false };
  const { rows: claimed } = await query(
    `UPDATE standup_days SET status = 'ESCALATED', escalated_at = $2, updated_at = now() WHERE id = $1 AND status = 'REVIEWED' RETURNING id`,
    [day.id, now],
  );
  if (!claimed[0]) return { escalated: false };
  const open = await unresolved(day.work_date);
  const total = open.missing.length + open.inaccessible.length + open.corrections.length + open.unmatched.length;
  if (!total) return { escalated: true, sent: 0 };
  const { rows: reviewers } = await query(
    'SELECT id, full_name, role, extra_permissions, revoked_permissions FROM users WHERE id = ANY($1::int[]) AND is_active',
    [(s.escalateTo || []).map(Number)],
  );
  const parts = [];
  if (open.missing.length) parts.push(`${open.missing.length} not seen`);
  if (open.corrections.length) parts.push(`${open.corrections.length} waiting for a correction`);
  if (open.inaccessible.length) parts.push(`${open.inaccessible.length} could not be reached`);
  if (open.unmatched.length) parts.push(`${open.unmatched.length} message${open.unmatched.length === 1 ? '' : 's'} not matched to a person`);
  const text = `*Standup follow-up — ${dateLabel(day.work_date)}*\n${parts.join(' · ')}.\n`
    + 'For a person to look at — not a penalty, and not proof of anything about anyone’s work. '
    + `Details: ${app(`/standup?tab=review&date=${day.work_date}`)}`;
  let sent = 0;
  for (const reviewer of reviewers) {
    if (!hasPermission(reviewer, 'standup.review')) continue;
    await notify(null, { userId: reviewer.id, type: 'standup_review', title: `Standup follow-up for ${day.work_date}`, body: `${parts.join(' · ')}.` });
    const dm = await directSpace(reviewer.id);
    if (dm && await enqueue(null, { dedupeKey: `standup:escalation:${day.work_date}:u${reviewer.id}`, spaceName: dm, userId: reviewer.id, kind: 'STANDUP_ESCALATION', payload: { text } })) sent += 1;
  }
  return { escalated: true, sent };
}

/** One pass of the standup — the Chat worker calls this every minute. */
export async function runStandup(now = new Date()) {
  let day = await ensureDay(now);
  if (!day || day.status === 'SKIPPED') return { day: day?.work_date || null, status: day?.status || null };
  await queueReminder(day, now);
  ({ rows: [day] } = await query('SELECT * FROM standup_days WHERE id = $1', [day.id]));
  day = await syncReminder(day);
  let read = null;
  try { read = await syncSpace(day, now); } catch (err) { await addNote(day.id, { code: 'SPACE_READ_FAILED', text: String(err.message).slice(0, 200) }); }
  const review = await reviewDay(day, now);
  ({ rows: [day] } = await query('SELECT * FROM standup_days WHERE id = $1', [day.id]));
  const escalation = await escalateDay(day, now);
  return { day: day.work_date, status: day.status, read, review, escalation };
}

// ---------------------------------------------------------------- what people see

export async function dayBoard(date) {
  const { rows: days } = await query('SELECT * FROM standup_days WHERE work_date = $1', [date]);
  const day = days[0] || null;
  const keys = day ? [day.reminder_key].filter(Boolean) : [];
  const { rows: outbox } = await query(
    `SELECT dedupe_key, kind, status, attempts, last_error, created_at, sent_at, message_name, thread_name
       FROM chat_outbox WHERE dedupe_key = ANY($1::text[]) OR dedupe_key LIKE $2 ORDER BY id`,
    [keys, `standup:%${date}%`],
  );
  const { rows: subs } = await query(
    `SELECT s.*, m.full_name FROM standup_submissions s JOIN standup_members m ON m.id = s.member_id WHERE s.work_date = $1`,
    [date],
  );
  const subIds = subs.map((x) => x.id);
  const { rows: subOutbox } = subIds.length ? await query(
    `SELECT dedupe_key, kind, status, attempts, last_error, created_at, sent_at, message_name, thread_name
       FROM chat_outbox WHERE dedupe_key ~ $1 ORDER BY id`,
    [`^standup:(post|feedback|corrected):(${subIds.join('|')}):`],
  ) : { rows: [] };
  const { rows: versions } = subIds.length ? await query(
    `SELECT v.submission_id, v.version, v.source, v.received_at, v.content, v.submitted_by_chat, v.chat_message_name, u.full_name AS submitted_by
       FROM standup_submission_versions v LEFT JOIN users u ON u.id = v.submitted_by_user_id
      WHERE v.submission_id = ANY($1::int[]) ORDER BY v.submission_id, v.version`,
    [subIds],
  ) : { rows: [] };
  const { rows: reviews } = await query(
    `SELECT r.*, m.full_name, m.role_title, rb.full_name AS resolved_by_name
       FROM standup_reviews r JOIN standup_members m ON m.id = r.member_id LEFT JOIN users rb ON rb.id = r.resolved_by
      WHERE r.work_date = $1 ORDER BY m.full_name`,
    [date],
  );
  const { rows: unmatched } = await query('SELECT * FROM standup_unmatched WHERE work_date = $1 ORDER BY received_at', [date]);
  const { excluded } = await eligibility(date);
  return {
    date,
    day,
    deliveries: [...outbox, ...subOutbox.filter((o) => !outbox.some((x) => x.dedupe_key === o.dedupe_key))],
    reviews,
    submissions: subs.map((x) => ({ ...x, versions: versions.filter((v) => v.submission_id === x.id) })),
    unmatched,
    excluded: excluded.map(({ member, reason }) => ({ id: member.id, full_name: member.full_name, reason })),
    consequences: 'Standups do not change attendance, leave, pay or black marks.',
  };
}

/** A reviewer's follow-up on a review row — recorded, never a penalty. */
export async function resolveReview(actor, id, { resolution, note }) {
  if (!['EXCUSED', 'FOLLOWED_UP', 'NO_ACTION', 'IDENTITY_FIXED'].includes(resolution)) throw badRequest('Choose how it was resolved');
  const { rows } = await query(
    `UPDATE standup_reviews SET resolution = $2, resolution_note = $3, resolved_by = $4, resolved_at = now()
      WHERE id = $1 RETURNING *`,
    [id, resolution, String(note || '').trim().slice(0, 500) || null, actor.id],
  );
  if (!rows[0]) throw notFound('Review not found');
  return rows[0];
}

/** Attribute a held Chat message to a member, once a person has checked who wrote it. */
export async function resolveUnmatched(actor, id, { memberId }) {
  const { rows } = await query('SELECT * FROM standup_unmatched WHERE id = $1', [id]);
  const held = rows[0];
  if (!held) throw notFound('Message not found');
  if (held.resolved_at) throw conflict('Already resolved');
  if (memberId === null) {
    await query('UPDATE standup_unmatched SET resolved_by = $2, resolved_at = now() WHERE id = $1', [id, actor.id]);
    return { dismissed: true };
  }
  const member = await memberById(memberId);
  if (!member || !member.active) throw notFound('Member not found');
  const s = await standupSettings();
  const parsed = parseStandupText(held.raw_text, { today: dateIn(s.timezone, new Date(held.received_at)) });
  const result = await recordVersion({
    member, content: parsed, source: held.source, now: new Date(held.received_at),
    submittedByChat: held.sender_chat || held.sender_email,
    chatMessage: held.chat_message_name ? { name: held.chat_message_name, thread: held.chat_thread_name } : null,
    rawText: held.raw_text,
  });
  await query('UPDATE standup_unmatched SET resolved_member_id = $2, resolved_by = $3, resolved_at = now() WHERE id = $1', [id, member.id, actor.id]);
  await afterSubmission(result.submissionId, new Date());
  return { submissionId: result.submissionId };
}

/** Today for one login: who they can post for, and what is already in. */
export async function mine(userId, now = new Date()) {
  const s = await standupSettings();
  const today = dateIn(s.timezone, now);
  const members = await membersForLogin(userId);
  const { rows: subs } = members.length ? await query(
    `SELECT s.*, v.content FROM standup_submissions s
       JOIN standup_submission_versions v ON v.submission_id = s.id AND v.version = s.current_version
      WHERE s.work_date = $1 AND s.member_id = ANY($2::int[])`,
    [today, members.map((m) => m.id)],
  ) : { rows: [] };
  const day = await companyDay(today);
  const { rows: days } = await query('SELECT status, deadline_at, effective_deadline_at, reminder_sent_at FROM standup_days WHERE work_date = $1', [today]);
  return {
    enabled: Boolean(s.enabled),
    date: today,
    working_day: day.working,
    not_working_reason: day.reason || null,
    reminder_time: s.reminderTime,
    deadline: s.deadline,
    effective_deadline_at: days[0]?.effective_deadline_at || null,
    min_items: s.minItems,
    max_items: s.maxItems,
    members: members.map((m) => ({ id: m.id, full_name: m.full_name, role_title: m.role_title, shared: m.user_id !== userId, identity_status: m.identity_status })),
    submissions: subs,
    consequences: 'A standup does not change attendance, leave, pay or black marks.',
  };
}

export { addDays };
