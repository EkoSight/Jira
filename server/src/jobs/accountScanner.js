import { query } from '../db/pool.js';
import { getSettings } from '../services/settings.js';
import { analyseAccounts, SEVERITY_RANK } from '../services/accountInsights.js';

/**
 * Turns the CRM momentum signals into reminders — one digest per person leading
 * a drifting deal, at most once inside the cooldown. The same shape as the Goals
 * scanner: owners get the nudge, everyone gets the pipeline board.
 */

const DIGEST_TYPE = 'crm_digest';

function digestFor(signals) {
  const ordered = [...signals].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const body = ordered.slice(0, 3).map((s) => `${s.title} ${s.detail}`).join(' · ');
  const primary = ordered[0];
  const n = signals.length;
  const title = n === 1 ? 'A lead needs a nudge' : `${n} leads need a nudge`;
  return { title, body, accountId: primary?.account_id ?? null };
}

export async function runAccountScan({ force = false } = {}) {
  const settings = await getSettings();
  if (settings.crm?.enabled === false) return { skipped: 'module_off', notified: [] };
  const cadence = settings.crm?.cadence || {};
  if (cadence.enabled === false) return { skipped: 'cadence_off', notified: [] };

  const { attention: signals } = await analyseAccounts({});
  const cooldownHours = Number(cadence.reminderHours) || 24;

  // group the reminders by the person leading each deal
  const byOwner = new Map();
  for (const signal of signals) {
    if (!signal.owner_user_id) continue;
    const bucket = byOwner.get(signal.owner_user_id) || [];
    bucket.push(signal);
    byOwner.set(signal.owner_user_id, bucket);
  }

  const notified = [];
  for (const [userId, ownerSignals] of byOwner) {
    if (!force) {
      const { rows } = await query(
        `SELECT 1 FROM notifications
          WHERE user_id = $1 AND type = $2 AND created_at > now() - ($3 || ' hours')::interval
          LIMIT 1`,
        [userId, DIGEST_TYPE, cooldownHours],
      );
      if (rows.length) continue;
    }

    const { title, body, accountId } = digestFor(ownerSignals);
    await query(
      `INSERT INTO notifications (user_id, type, title, body, account_id) VALUES ($1, $2, $3, $4, $5)`,
      [userId, DIGEST_TYPE, title, body, accountId],
    );
    notified.push(userId);
  }

  return { notified, signals: signals.length };
}
