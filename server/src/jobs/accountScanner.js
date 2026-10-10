import { query } from '../db/pool.js';
import { getSettings } from '../services/settings.js';
import { analysePipeline, SEVERITY_RANK } from '../services/accountInsights.js';
import { addDays, statusOn } from '../services/availability.js';
import {
  allPreferences, digestDue, fingerprintOf, indiaNow, lastDigests, onlyRepeats, sendReminderOnce,
} from '../services/reminders.js';

/**
 * Turns the pipeline's signals into reminders — one digest per person, on their
 * own schedule. It reads the deal-level signals, for leads, customers and
 * partners alike, on the customer's clock; a deal paused on purpose is silent
 * until its revisit date.
 *
 * Each person's digest arrives at the time and on the days they chose (or the
 * organization's default), never while they are on leave, at most once a day,
 * and not at all when it would only repeat the last one. While someone is away,
 * next actions due before they are back go to each deal's escalation point.
 *
 * `manual` is an administrator running the scan now: it ignores the time of day
 * but nothing else. `force` also ignores the once-a-day and no-repeat rules.
 */

const DIGEST_TYPE = 'crm_digest';
const COVER_TYPE = 'crm_cover';

function digestFor(signals) {
  const ordered = [...signals].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const body = ordered.slice(0, 3).map((s) => `${s.title}: ${s.detail}`).join(' · ');
  const primary = ordered[0];
  const n = signals.length;
  const title = n === 1 ? 'A deal needs a nudge' : `${n} deals need a nudge`;
  return { title, body, accountId: primary?.account_id ?? null };
}

const isAway = (entry) => Boolean(entry) && entry.status !== 'HALF_DAY';

export async function runAccountScan({ force = false, manual = false, now = new Date() } = {}) {
  const settings = await getSettings();
  if (settings.crm?.enabled === false) return { skipped: 'module_off', notified: [] };
  const cadence = settings.crm?.cadence || {};
  if (cadence.enabled === false) return { skipped: 'cadence_off', notified: [] };

  const clock = indiaNow(now);
  const [{ attention: signals }, prefs, away, last] = await Promise.all([
    analysePipeline({}),
    allPreferences(),
    statusOn(clock.date),
    lastDigests(),
  ]);
  const cooldownHours = Number(cadence.reminderHours) || 24;
  const repeatDays = prefs.defaults.repeat_same_days;

  // group the reminders by the person leading each deal
  const byOwner = new Map();
  for (const signal of signals) {
    if (!signal.owner_user_id) continue;
    const bucket = byOwner.get(signal.owner_user_id) || [];
    bucket.push(signal);
    byOwner.set(signal.owner_user_id, bucket);
  }

  const notified = [];
  const held = [];
  for (const [userId, ownerSignals] of byOwner) {
    const pref = prefs.get(userId);
    // leave and a person's own pause hold even a forced run
    const due = digestDue(pref, clock, { away: isAway(away.get(userId)), ignoreSchedule: manual || force });
    if (!due.due) {
      held.push({ user_id: userId, why: due.why });
      continue;
    }
    const fingerprint = fingerprintOf(ownerSignals);
    if (!force) {
      // the older rule still holds: no two digests inside the cooldown
      const { rows } = await query(
        `SELECT 1 FROM notifications
          WHERE user_id = $1 AND type = $2 AND created_at > $3::timestamptz - ($4 || ' hours')::interval
          LIMIT 1`,
        [userId, DIGEST_TYPE, now.toISOString(), cooldownHours],
      );
      if (rows.length) { held.push({ user_id: userId, why: 'sent recently' }); continue; }
      if (onlyRepeats(last.get(userId), fingerprint, clock.date, repeatDays)) {
        held.push({ user_id: userId, why: 'nothing new' });
        continue;
      }
    }

    const { title, body, accountId } = digestFor(ownerSignals);
    const sent = force
      ? (await query(
        `INSERT INTO notifications (user_id, type, title, body, account_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, DIGEST_TYPE, title, body, accountId],
      )).rows[0]
      : await sendReminderOnce({
        userId, kind: 'DIGEST', sentOn: clock.date, fingerprint, signalCount: ownerSignals.length,
        type: DIGEST_TYPE, title, body, accountId,
      });
    if (sent) notified.push(userId);
  }

  // cover: someone away, with next actions due before they are back
  const covered = await coverWhileAway({ clock, away, prefs, ignoreSchedule: manual || force });
  return { notified, covered, held, signals: signals.length };
}

/**
 * Next actions owed by people who are away, due before they return, sent to
 * each deal's escalation point — once a day per person covered.
 */
async function coverWhileAway({ clock, away, prefs, ignoreSchedule }) {
  const absent = [...away.values()].filter(isAway);
  if (!absent.length) return [];
  const sent = [];
  for (const entry of absent) {
    const pref = prefs.get(entry.user_id);
    if (!pref.cover_while_away) continue;
    const backOn = entry.back_on || addDays(entry.end_date, 1);
    const { rows: owed } = await query(
      `SELECT o.id, o.name, o.next_step, o.next_step_due, o.account_id, a.name AS account_name,
              o.escalation_owner_id
         FROM opportunities o JOIN accounts a ON a.id = o.account_id
        WHERE o.status = 'ACTIVE' AND o.is_archived = FALSE AND a.is_archived = FALSE
          AND o.waiting_on IS NULL
          AND COALESCE(o.next_step_owner_id, o.owner_user_id) = $1
          AND o.next_step_due < $2::date
          AND o.escalation_owner_id IS NOT NULL AND o.escalation_owner_id <> $1`,
      [entry.user_id, backOn],
    );
    const byCover = new Map();
    for (const deal of owed) {
      const list = byCover.get(deal.escalation_owner_id) || [];
      list.push(deal);
      byCover.set(deal.escalation_owner_id, list);
    }
    for (const [coverId, deals] of byCover) {
      // the person covering must be here, and it must be a day they get reminders
      if (isAway(away.get(coverId))) continue;
      const coverPref = prefs.get(coverId);
      const due = digestDue(coverPref, clock, { ignoreSchedule });
      if (!due.due) continue;
      const lines = deals.slice(0, 3).map((d) => `${d.name}: ${d.next_step || 'no next action'} (due ${String(d.next_step_due).slice(0, 10)})`);
      const notice = await sendReminderOnce({
        userId: coverId,
        kind: 'COVER',
        sentOn: clock.date,
        coveringFor: entry.user_id,
        fingerprint: fingerprintOf(deals.map((d) => ({ entity_type: 'OPPORTUNITY', entity_id: d.id, kind: 'cover' }))),
        signalCount: deals.length,
        type: COVER_TYPE,
        title: `Covering for ${entry.full_name} (away until ${backOn}): ${deals.length} next action${deals.length === 1 ? '' : 's'} due`,
        body: lines.join(' · '),
        accountId: deals[0].account_id,
      });
      if (notice) sent.push({ user_id: coverId, covering_for: entry.user_id, deals: deals.length });
    }
  }
  return sent;
}
