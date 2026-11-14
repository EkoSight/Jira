/**
 * Reminders for records other than tasks: applications, meetings, deals and
 * a person's own "remind me". A sibling of the task reminder engine
 * (services/taskReminders.js), built the same way:
 *
 *   - **Planned, with a stable identity.** One row per recipient, record,
 *     rule, occurrence and schedule version (reminder_occurrences, unique),
 *     so planning twice or retrying adds nothing. Whatever no longer fits
 *     (a new date, a new owner, a submission, the person turning the rule
 *     off) is cancelled, and a reminder already sent is marked resolved.
 *   - **Checked when sent.** Each row is claimed (SKIP LOCKED), then the
 *     record is re-read and the person's access re-checked. A warning that
 *     no longer applies is cancelled, not sent.
 *   - **One catch-up.** After downtime, at most one still-relevant reminder
 *     per person, record and rule goes; older ones are skipped.
 *   - **People's time.** Nothing while paused or away (the dashboard still
 *     shows the item); deal and application reminders go to the deal's
 *     escalation point while the owner is away, if they chose "cover while
 *     away". Quiet hours hold a reminder until they end.
 *   - **Launch.** The first full run of a rule records anything already due
 *     as skipped ("before launch"); nothing old is sent.
 *   - **Safe start.** TEST until an administrator switches it LIVE (only the
 *     test recipient receives anything; the rest are "would send"). A
 *     person's own "remind me" always reaches them: it reaches nobody else.
 *
 * Channels: the TaskFlow bell, and Google Chat for people who connected it.
 * Email and push are not available.
 */
import { query, withTransaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { chatLink as chatAnchor, chatText } from '../../lib/googleChat.js';
import { getSettings } from '../settings.js';
import { localDate, zonedInstant } from '../sales/core.js';
import { awayAt, chatRoute, hhmm, inQuietHours, offWords, reminderSettings } from '../taskReminders.js';
import { workspaceSettings } from './layout.js';
import { canSeeRecord, recordLabel } from './access.js';

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Every rule a person can turn on or off, with its defaults (D6). `optIn`
 * rules are never on until the person turns them on.
 */
export const RULES = {
  APPLICATION_DEADLINE: {
    group: 'Applications', label: 'Application deadline, 3 days before',
    description: 'While the submission is outstanding: one reminder 3 calendar days before the deadline, to the owner.',
    defaults: { enabled: true, at: '09:00', chat: true }, entity: 'APPLICATION', coverable: true,
  },
  APPLICATION_DEADLINE_1D: {
    group: 'Applications', label: 'Application deadline, 1 day before', optIn: true,
    description: 'An extra reminder the day before the deadline. Off unless you turn it on.',
    defaults: { enabled: false, at: '09:00', chat: true }, entity: 'APPLICATION', coverable: true,
  },
  APPLICATION_DEADLINE_SAME_DAY: {
    group: 'Applications', label: 'Application deadline, on the day', optIn: true,
    description: 'An extra reminder on the morning of the deadline. Off unless you turn it on.',
    defaults: { enabled: false, at: '09:00', chat: true }, entity: 'APPLICATION', coverable: true,
  },
  APPLICATION_STATUS_CHECK: {
    group: 'Applications', label: 'Check application status',
    description: '15 calendar days after the submitted date if no update is recorded, or on the response date the organiser gave, or on the next check date you chose.',
    defaults: { enabled: true, at: '09:00', chat: true }, entity: 'APPLICATION', coverable: true,
  },
  MEETING_TO_ARRANGE: {
    group: 'Meetings', label: 'Meeting still to arrange',
    description: 'On the arrange-by date, to the person arranging it. Never a start-time reminder without a confirmed time.',
    defaults: { enabled: true, at: '09:00', chat: true }, entity: 'MEETING',
  },
  MEETING_PREP: {
    group: 'Meetings', label: 'Meeting tomorrow: prepare',
    description: 'The day before a confirmed meeting, to its owner and to colleagues taking part.',
    defaults: { enabled: true, at: '09:00', chat: true }, entity: 'MEETING',
  },
  MEETING_START: {
    group: 'Meetings', label: 'Meeting starts in 30 minutes',
    description: '30 minutes before a confirmed meeting, to its owner and to colleagues taking part.',
    defaults: { enabled: true, at: null, chat: true }, entity: 'MEETING', relative: true,
  },
  DEAL_NEXT_STEP: {
    group: 'Deals', label: 'Deal next action due',
    description: 'On the next action\'s date, to the deal\'s owner. A next action tracked by a task is reminded by the task reminders instead.',
    defaults: { enabled: true, at: '09:00', chat: true }, entity: 'DEAL', coverable: true,
  },
  DEAL_WAITING_UNTIL: {
    group: 'Deals', label: 'Deal waiting: their date has come',
    description: 'On the date you were told to expect their move, to the deal\'s owner.',
    defaults: { enabled: true, at: '09:00', chat: true }, entity: 'DEAL', coverable: true,
  },
  DEAL_REVISIT: {
    group: 'Deals', label: 'Revisit a deal on hold',
    description: 'On the revisit date of a deal on hold or nurture, to its owner.',
    defaults: { enabled: true, at: '09:00', chat: true }, entity: 'DEAL', coverable: true,
  },
  PERSONAL: {
    group: 'Your own', label: 'Remind me about this',
    description: 'Reminders you set yourself on a record you can see. Private to you.',
    defaults: { enabled: true, at: null, chat: true }, entity: '*', personal: true,
  },
};
export const RULE_KEYS = Object.keys(RULES);

// ---------------------------------------------------------------- preferences

/** A person's choice for each rule, over the defaults. */
export async function rulePrefs(userIds, runner = { query }) {
  const ids = [...new Set(userIds)].filter(Boolean);
  const out = new Map(ids.map((id) => [id, {}]));
  if (!ids.length) return out;
  const { rows } = await runner.query('SELECT * FROM reminder_rule_prefs WHERE user_id = ANY($1::int[])', [ids]);
  for (const r of rows) out.get(r.user_id)[r.rule_key] = r;
  return out;
}

export function effectivePref(prefsForUser, ruleKey) {
  const rule = RULES[ruleKey];
  const p = prefsForUser?.[ruleKey];
  return {
    enabled: rule.personal ? true : (p ? p.enabled : rule.defaults.enabled),
    at: p?.at_time && TIME.test(p.at_time) ? p.at_time : rule.defaults.at,
    chat: p?.chat ?? rule.defaults.chat,
    chosen: Boolean(p),
  };
}

// ---------------------------------------------------------------- planners

/**
 * A planner knows one kind of record. plan(runner, id, ctx) returns
 *   { desired: [{ recipientId, ruleKey, occurrenceKey, scheduleVersion?, date? | at?,
 *                 until?, facts }], why }
 * where `date` is a local calendar date in the recipient's timezone (the
 * person's chosen time is added) and `at` an exact instant; `until` is when
 * it stops being relevant; `why` says why nothing is wanted, when nothing is.
 * sweep(runner, ctx) lists the ids worth planning now.
 */
const PLANNERS = [];
export function registerPlanner(p) { if (!PLANNERS.some((x) => x.name === p.name)) PLANNERS.push(p); }
const plannersFor = (entityType) => PLANNERS.filter((p) => p.entityType === entityType || p.entityType === '*');

const tzOf = (user, fallback) => user?.timezone || fallback;

async function usersById(ids, runner) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return new Map();
  const { rows } = await runner.query(
    `SELECT id, full_name, email, role, department_id, timezone, is_active, extra_permissions, revoked_permissions FROM users WHERE id = ANY($1::int[])`, [list],
  );
  return new Map(rows.map((u) => [u.id, u]));
}

async function launchedRules(runner) {
  const { rows } = await runner.query('SELECT rule_key, launched_at FROM reminder_rule_launches');
  return new Map(rows.map((r) => [r.rule_key, r.launched_at]));
}

/** When a wanted occurrence should be sent, for its recipient. */
function remindAt(w, user, pref, companyTz) {
  if (w.at) return new Date(w.at);
  return zonedInstant(w.date, pref.at || '09:00', tzOf(user, companyTz));
}

/**
 * Plans one record now: inserts what is wanted, cancels what is not, and
 * marks reminders already sent for what no longer applies as resolved.
 */
export async function planRecord(runner, entityType, entityId, { now = new Date(), launching = null } = {}) {
  const ws = await workspaceSettings();
  const launched = await launchedRules(runner);
  const result = { planned: 0, cancelled: 0, skipped: 0 };
  for (const planner of plannersFor(entityType)) {
    const { desired = [], why = null } = await planner.plan(runner, entityId, { now, entityType });
    const users = await usersById(desired.map((d) => d.recipientId), runner);
    const prefs = await rulePrefs(desired.map((d) => d.recipientId), runner);
    // a person's own reminder on the same day covers a rule's
    const personal = new Map();
    if (planner.name !== 'personal' && desired.length) {
      const { rows } = await runner.query(
        `SELECT user_id, remind_at, timezone FROM personal_reminders WHERE entity_type = $1 AND entity_id = $2 AND status = 'ACTIVE'`,
        [entityType, entityId],
      );
      for (const r of rows) {
        const u = users.get(r.user_id);
        const day = localDate(new Date(r.remind_at), tzOf(u, ws.timezone));
        personal.set(`${r.user_id}:${day}`, true);
      }
    }
    const keep = [];
    for (const w of desired) {
      const u = users.get(w.recipientId);
      if (!u || !u.is_active) continue;
      const pref = effectivePref(prefs.get(w.recipientId), w.ruleKey);
      if (!pref.enabled) continue;
      const at = remindAt(w, u, pref, ws.timezone);
      if (planner.name !== 'personal' && personal.has(`${w.recipientId}:${localDate(at, tzOf(u, ws.timezone))}`)) continue;
      keep.push({ ...w, at, scheduleVersion: w.scheduleVersion || 1 });
    }
    // what is pending (or already sent) for this record and these rules, and no longer wanted
    const { rows: existing } = await runner.query(
      `SELECT * FROM reminder_occurrences WHERE entity_type = $1 AND entity_id = $2 AND rule_key = ANY($3::text[])
         AND status IN ('PENDING', 'SENT', 'WOULD_SEND')`,
      [entityType, entityId, planner.rules],
    );
    const wanted = (o) => keep.some((w) => w.recipientId === o.recipient_id && w.ruleKey === o.rule_key
      && w.occurrenceKey === o.occurrence_key && w.scheduleVersion === o.schedule_version);
    for (const o of existing) {
      if (wanted(o)) continue;
      const sameRule = desired.find((w) => w.ruleKey === o.rule_key);
      const reason = !sameRule ? (why || 'No longer needed')
        : sameRule.recipientId !== o.recipient_id ? 'Now someone else\'s'
          : !keep.some((w) => w.ruleKey === o.rule_key && w.recipientId === o.recipient_id) ? 'Turned off, or covered by your own reminder'
            : 'The date changed';
      if (o.status === 'PENDING') {
        await runner.query(`UPDATE reminder_occurrences SET status = 'CANCELLED', reason = $2, updated_at = now() WHERE id = $1 AND status = 'PENDING'`, [o.id, reason]);
        result.cancelled += 1;
      } else if (o.notification_id && planner.resolvesSent !== false) {
        // already delivered: the alert is resolved, never repeated
        await runner.query(`UPDATE notifications SET resolved_at = COALESCE(resolved_at, now()), updated_at = now() WHERE id = $1`, [o.notification_id]);
      }
    }
    for (const w of keep) {
      const isLaunching = launching ? launching.has(w.ruleKey) : !launched.has(w.ruleKey);
      let status = 'PENDING';
      let reason = null;
      let at = w.at;
      if (at.getTime() < now.getTime() - 60_000) {
        if (isLaunching) {
          // D7: nothing old is sent when a rule starts; the dashboard shows it
          status = 'SKIPPED'; reason = 'Before launch: shown in My workspace, not sent';
        } else if (w.until && new Date(w.until).getTime() <= now.getTime()) {
          status = 'SKIPPED'; reason = 'Its moment had passed when it was planned';
        } else {
          // added or assigned inside the window: one alert now, with the real time left
          at = now;
        }
      }
      const { rows } = await runner.query(
        `INSERT INTO reminder_occurrences (recipient_id, entity_type, entity_id, rule_key, occurrence_key, schedule_version, remind_at, facts, status, reason, personal_reminder_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (recipient_id, entity_type, entity_id, rule_key, occurrence_key, schedule_version) DO NOTHING RETURNING id`,
        [w.recipientId, entityType, entityId, w.ruleKey, w.occurrenceKey, w.scheduleVersion, at, JSON.stringify({ ...(w.facts || {}), until: w.until || null }), status, reason, w.personalReminderId || null],
      );
      if (rows[0]) result[status === 'SKIPPED' ? 'skipped' : 'planned'] += 1;
      else if (status === 'PENDING' && at.getTime() >= now.getTime()) {
        // the same reminder at another time of day (a new preferred time or timezone)
        await runner.query(
          `UPDATE reminder_occurrences SET remind_at = $7, updated_at = now()
            WHERE recipient_id = $1 AND entity_type = $2 AND entity_id = $3 AND rule_key = $4 AND occurrence_key = $5 AND schedule_version = $6
              AND status = 'PENDING' AND remind_at <> $7`,
          [w.recipientId, entityType, entityId, w.ruleKey, w.occurrenceKey, w.scheduleVersion, at],
        );
      }
    }
  }
  return result;
}

/** Plans one record in its own transaction; never fails the caller. */
export async function replanRecord(entityType, entityId, opts = {}) {
  try {
    return await withTransaction((client) => planRecord(client, entityType, entityId, opts));
  } catch (err) {
    console.error(`[taskflow] workspace reminders: planning ${entityType} ${entityId} failed:`, err.message);
    return null;
  }
}

/**
 * Plans every record worth planning, and every record with something
 * pending. A rule's first full run is its launch: anything already due is
 * recorded as skipped, and the launch is stored.
 */
export async function planSweep({ now = new Date() } = {}) {
  const launched = await launchedRules({ query });
  const launching = new Set(RULE_KEYS.filter((k) => !launched.has(k)));
  const seen = new Set();
  let records = 0;
  for (const planner of PLANNERS) {
    const ids = new Set(await planner.sweep({ query }, { now }));
    const types = planner.entityType === '*' ? null : [planner.entityType];
    const { rows } = await query(
      `SELECT DISTINCT entity_type, entity_id FROM reminder_occurrences WHERE status = 'PENDING' AND rule_key = ANY($1::text[])`, [planner.rules],
    );
    const pairs = [...ids].map((x) => (typeof x === 'object' ? x : { entity_type: planner.entityType, entity_id: x }));
    for (const r of rows) if (!types || types.includes(r.entity_type)) pairs.push(r);
    for (const p of pairs) {
      const key = `${p.entity_type}:${p.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await withTransaction((client) => planRecord(client, p.entity_type, p.entity_id, { now, launching }));
      records += 1;
    }
  }
  for (const k of launching) await query('INSERT INTO reminder_rule_launches (rule_key, launched_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [k, now]);
  return { records, launched: [...launching] };
}

// ---------------------------------------------------------------- sending

const appUrl = (path) => `${config.publicUrl}${path}`;

/** Re-reads the record: is this occurrence still wanted, and if not, why. */
async function stillWanted(runner, o, now) {
  const planner = PLANNERS.find((p) => p.rules.includes(o.rule_key) && (p.entityType === o.entity_type || p.entityType === '*'));
  if (!planner) return { ok: false, why: 'This kind of reminder no longer exists' };
  const { desired = [], why = null } = await planner.plan(runner, o.entity_id, { now, entityType: o.entity_type });
  const match = desired.find((w) => w.recipientId === o.recipient_id && w.ruleKey === o.rule_key
    && w.occurrenceKey === o.occurrence_key && (w.scheduleVersion || 1) === o.schedule_version);
  if (match) return { ok: true, planner, wanted: match };
  const same = desired.find((w) => w.ruleKey === o.rule_key);
  return { ok: false, why: !same ? (why || 'No longer needed') : same.recipientId !== o.recipient_id ? 'Now someone else\'s' : 'The date changed' };
}

/** The deal's escalation point, for cover while away (deals and applications only). */
async function coverPerson(runner, o) {
  if (!['DEAL', 'APPLICATION'].includes(o.entity_type)) return null;
  const { rows } = await runner.query(
    `SELECT u.* FROM opportunities op JOIN users u ON u.id = op.escalation_owner_id
      WHERE op.id = $1 AND u.is_active AND u.id <> $2`, [o.entity_id, o.recipient_id],
  );
  return rows[0] || null;
}

async function wantsCover(runner, userId) {
  const { rows } = await runner.query('SELECT cover_while_away FROM reminder_preferences WHERE user_id = $1', [userId]);
  return rows[0] ? rows[0].cover_while_away !== false : true;
}

async function pausedUntil(runner, userId, today) {
  const { rows } = await runner.query('SELECT paused_until FROM reminder_preferences WHERE user_id = $1', [userId]);
  const p = rows[0]?.paused_until ? String(rows[0].paused_until instanceof Date ? rows[0].paused_until.toISOString() : rows[0].paused_until).slice(0, 10) : null;
  return p && p >= today ? p : null;
}

/** The end of quiet hours after an instant, in a timezone. */
function quietEnds(now, { quietEnd }, tz) {
  const today = localDate(now, tz);
  const end = zonedInstant(today, quietEnd, tz);
  return end > now ? end : zonedInstant(localDate(new Date(now.getTime() + 86_400_000), tz), quietEnd, tz);
}

export async function sendDueOccurrences(now = new Date(), { limit = 300 } = {}) {
  const ws = await workspaceSettings();
  const ts = await reminderSettings();
  const out = { sent: 0, would_send: 0, cancelled: 0, skipped: 0, held: 0, covered: 0 };
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE reminder_occurrences r SET status = 'SENDING', attempts = attempts + 1, updated_at = now()
        WHERE r.id IN (SELECT id FROM reminder_occurrences WHERE status = 'PENDING' AND remind_at <= $1
                        ORDER BY remind_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING r.*`,
      [now, limit],
    );
    if (!rows.length) return;
    rows.sort((a, b) => new Date(a.remind_at) - new Date(b.remind_at) || Number(a.id) - Number(b.id));
    // after downtime, only the latest per person, record and rule goes
    const latest = new Map();
    for (const r of rows) latest.set(`${r.recipient_id}:${r.entity_type}:${r.entity_id}:${r.rule_key}`, r.id);
    const users = await usersById(rows.map((r) => r.recipient_id), client);
    const prefs = await rulePrefs(rows.map((r) => r.recipient_id), client);

    for (const o of rows) {
      const finish = async (status, reason = null, extra = {}) => {
        await client.query(
          `UPDATE reminder_occurrences SET status = $2, reason = $3, sent_at = CASE WHEN $2 = 'SENT' THEN $4::timestamptz ELSE sent_at END,
                  notification_id = COALESCE($5, notification_id), outbox_key = COALESCE($6, outbox_key),
                  remind_at = COALESCE($7, remind_at), updated_at = now()
            WHERE id = $1`,
          [o.id, status, reason, now, extra.notificationId ?? null, extra.outboxKey ?? null, extra.remindAt ?? null],
        );
        if (o.personal_reminder_id && ['SENT', 'CANCELLED'].includes(status)) {
          await client.query(`UPDATE personal_reminders SET status = $2, updated_at = now() WHERE id = $1 AND status = 'ACTIVE' AND version = $3`, [o.personal_reminder_id, status === 'SENT' ? 'DONE' : 'CANCELLED', o.schedule_version]);
        }
        const k = { SENT: 'sent', WOULD_SEND: 'would_send', CANCELLED: 'cancelled', SKIPPED: 'skipped', PENDING: 'held' }[status];
        out[k] += 1;
      };
      const rule = RULES[o.rule_key];
      const u = users.get(o.recipient_id);
      if (!rule) { await finish('CANCELLED', 'This kind of reminder no longer exists'); continue; }
      if (!u || !u.is_active) { await finish('CANCELLED', 'Their account is switched off'); continue; }
      const pref = effectivePref(prefs.get(o.recipient_id), o.rule_key);
      if (!pref.enabled) { await finish('CANCELLED', 'You turned this reminder off'); continue; }
      // the record, as it is now
      const check = await stillWanted(client, o, now);
      if (!check.ok) { await finish('CANCELLED', check.why); continue; }
      // and whether the person can still see it
      const fullUser = { ...u, permissions: undefined };
      if (!(await canSeeRecord(fullUser, o.entity_type, o.entity_id))) { await finish('CANCELLED', 'They can no longer see this record'); continue; }
      if (latest.get(`${o.recipient_id}:${o.entity_type}:${o.entity_id}:${o.rule_key}`) !== o.id) {
        await finish('SKIPPED', 'A later reminder for the same thing was due at the same time; only that one was sent'); continue;
      }
      const until = o.facts?.until ? new Date(o.facts.until) : null;
      if (until && until.getTime() <= now.getTime()) { await finish('SKIPPED', 'Its moment passed before it could be sent; My workspace shows it'); continue; }
      const tz = tzOf(u, ws.timezone);
      const today = localDate(now, tz);
      const paused = await pausedUntil(client, o.recipient_id, today);
      if (paused) { await finish('SKIPPED', `Paused until ${paused}; My workspace still shows it`); continue; }
      let recipient = u;
      let coverNote = null;
      const { away } = await awayAt([o.recipient_id], now, ws.timezone);
      const off = away.get(o.recipient_id);
      if (off) {
        const cover = rule.coverable && (await wantsCover(client, o.recipient_id)) ? await coverPerson(client, o) : null;
        if (cover && await canSeeRecord(cover, o.entity_type, o.entity_id)) {
          recipient = cover;
          coverNote = `${u.full_name} is ${offWords(off)}; you are covering`;
          out.covered += 1;
        } else {
          await finish('SKIPPED', `Away: ${offWords(off)}. My workspace still shows it`); continue;
        }
      }
      if (!rule.personal && o.rule_key !== 'MEETING_START' && inQuietHours(now, { ...ts, timezone: tz })) {
        await finish('PENDING', `Held until quiet hours end (${ts.quietStart}–${ts.quietEnd})`, { remindAt: quietEnds(now, ts, tz) }); continue;
      }
      const test = ws.reminderMode !== 'LIVE' && !rule.personal;
      if (ws.reminderMode === 'OFF' && !rule.personal) { await finish('SKIPPED', 'Workspace reminders are switched off'); continue; }
      if (test && Number(ws.testRecipientId) !== recipient.id) { await finish('WOULD_SEND', 'Test mode: would have been sent'); continue; }

      const label = await recordLabel(o.entity_type, o.entity_id);
      const words = await check.planner.words(client, o, { now, tz: tzOf(recipient, ws.timezone), label, recipient, owner: u });
      const reason = coverNote || words.why;
      const title = `${test ? 'TEST · ' : ''}${words.title}`;
      const body = [words.body, reason ? `Why you: ${reason}` : null].filter(Boolean).join('\n');
      const { rows: n } = await client.query(
        `INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, occurrence_id, reason, updated_at,
                                    task_id, crm_lead_id, account_id)
         VALUES ($1, 'workspace_reminder', $2, $3, $4, $5, $6, $7, now(), $8, $9, $10) RETURNING id`,
        [recipient.id, title, body, o.entity_type, o.entity_id, o.id, reason,
          o.entity_type === 'TASK' ? o.entity_id : null, o.entity_type === 'LEAD' ? o.entity_id : null, o.entity_type === 'ACCOUNT' ? o.entity_id : null],
      );
      let outboxKey = null;
      if (pref.chat !== false) {
        const route = await chatRoute(recipient.id, client, ts);
        if (route.ok && route.instant) {
          outboxKey = `ws-reminder:${o.id}`;
          const text = [`${test ? '*TEST* · ' : ''}⏰ *${chatText(title)}*`, ...body.split('\n').map(chatText), chatAnchor(appUrl(label?.url || '/'), 'Open in TaskFlow')].join('\n');
          await client.query(
            `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload) VALUES ($1, $2, $3, 'WORKSPACE_REMINDER', $4)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [outboxKey, route.space, recipient.id, JSON.stringify({ text })],
          );
        }
      }
      await finish('SENT', coverNote, { notificationId: n[0].id, outboxKey });
    }
  });
  return out;
}

// ---------------------------------------------------------------- the person's own view

/** Cancels this person's pending occurrences of one rule (they turned it off). */
export async function cancelMine(userId, ruleKey, reason = 'You turned this reminder off') {
  const { rowCount } = await query(
    `UPDATE reminder_occurrences SET status = 'CANCELLED', reason = $3, updated_at = now()
      WHERE recipient_id = $1 AND rule_key = $2 AND status = 'PENDING'`, [userId, ruleKey, reason],
  );
  return rowCount;
}

/** Re-plans every record that has, or could have, an occurrence of a rule for this person. */
export async function replanMine(userId, ruleKey) {
  const planner = PLANNERS.find((p) => p.rules.includes(ruleKey));
  if (!planner) return 0;
  const ids = await planner.sweep({ query }, { now: new Date(), forUser: userId });
  let n = 0;
  for (const x of ids) {
    const pair = typeof x === 'object' ? x : { entity_type: planner.entityType, entity_id: x };
    await replanRecord(pair.entity_type, pair.entity_id);
    n += 1;
  }
  return n;
}

/** One person's occurrences, newest first, with Chat delivery where it applies. */
export async function occurrencesFor(userId, { days = 14 } = {}) {
  const { rows } = await query(
    `SELECT r.id, r.entity_type, r.entity_id, r.rule_key, r.remind_at, r.status, r.reason, r.sent_at, r.facts,
            o.status AS chat_status, o.last_error AS chat_error
       FROM reminder_occurrences r LEFT JOIN chat_outbox o ON o.dedupe_key = r.outbox_key
      WHERE r.recipient_id = $1 AND (r.remind_at > now() - ($2 || ' days')::interval OR r.status = 'PENDING')
      ORDER BY r.remind_at DESC LIMIT 300`,
    [userId, days],
  );
  return rows.map((r) => {
    let state = r.status === 'PENDING' || r.status === 'SENDING' ? 'PLANNED' : r.status;
    if (r.status === 'SENT' && r.chat_status) state = r.chat_status === 'FAILED' ? 'SENT_BELL_ONLY' : 'SENT';
    return { ...r, state, rule_label: RULES[r.rule_key]?.label || r.rule_key };
  });
}

export { hhmm };
