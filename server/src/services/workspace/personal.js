/**
 * "Remind me about this": a reminder a person sets for themselves on any
 * record they can see. Private: nobody else can read it, and it reaches only
 * them. It is kept while they can still see the record; when they cannot,
 * it is cancelled at its time and nothing about the record is shown.
 *
 * Setting one never changes the record: "Change my reminder" is not
 * "Change the deadline".
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { ENTITY_TYPES, canSeeRecord, recordLabel } from './access.js';
import { planRecord, registerPlanner } from './reminders.js';
import { workspaceSettings } from './layout.js';
import { addContributor } from './attention.js';

const fmt = (at, tz) => `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)}${tz === 'Asia/Kolkata' ? ' IST' : ` (${tz})`}`;

registerPlanner({
  name: 'personal',
  entityType: '*',
  rules: ['PERSONAL'],
  // a delivered reminder has done its job; it is not "resolved" by being done
  resolvesSent: false,
  async plan(runner, entityId, { entityType }) {
    const { rows } = await runner.query(
      `SELECT * FROM personal_reminders WHERE entity_type = $1 AND entity_id = $2 AND status = 'ACTIVE'`, [entityType, entityId],
    );
    return {
      desired: rows.map((r) => ({
        recipientId: r.user_id, ruleKey: 'PERSONAL', occurrenceKey: `p${r.id}`, scheduleVersion: r.version,
        at: r.remind_at, facts: { note: r.note || null, timezone: r.timezone }, personalReminderId: r.id,
      })),
      why: 'You removed or changed this reminder',
    };
  },
  async sweep(runner, { forUser = null } = {}) {
    const { rows } = await runner.query(
      `SELECT DISTINCT entity_type, entity_id FROM personal_reminders WHERE status = 'ACTIVE' AND ($1::int IS NULL OR user_id = $1)`, [forUser],
    );
    return rows;
  },
  async words(runner, o, { tz, label }) {
    return {
      title: `Your reminder: ${label?.label || 'a record'}`,
      body: [o.facts?.note ? `"${o.facts.note}"` : null, `You asked to be reminded on ${fmt(new Date(o.remind_at), tz)}.`].filter(Boolean).join('\n'),
      why: 'You set this reminder yourself',
    };
  },
});

function clean(input, { requireFuture = true } = {}) {
  const at = new Date(input.remind_at);
  if (Number.isNaN(at.getTime())) throw badRequest('Choose a date and time');
  if (requireFuture && at.getTime() < Date.now() - 60_000) throw badRequest('Choose a time in the future');
  if (at.getTime() > Date.now() + 400 * 86_400_000) throw badRequest('Choose a time within the next year');
  const note = input.note ? String(input.note).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 500) : null;
  return { at, note };
}

export async function myPersonalReminders(user, { entityType = null, entityId = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM personal_reminders WHERE user_id = $1 AND status = 'ACTIVE'
       AND ($2::text IS NULL OR entity_type = $2) AND ($3::int IS NULL OR entity_id = $3)
     ORDER BY remind_at`,
    [user.id, entityType, entityId],
  );
  const out = [];
  for (const r of rows) {
    // a record the person can no longer see shows as "not available", with nothing about it
    const visible = await canSeeRecord(user, r.entity_type, r.entity_id);
    const label = visible ? await recordLabel(r.entity_type, r.entity_id) : null;
    out.push({ ...r, available: visible, record: label || { label: 'Not available', url: null } });
  }
  return out;
}

export async function addPersonalReminder(user, input) {
  if (!ENTITY_TYPES.includes(input.entity_type)) throw badRequest('Choose what to be reminded about');
  if (!(await canSeeRecord(user, input.entity_type, input.entity_id))) throw notFound('Not available');
  const { at, note } = clean(input);
  const ws = await workspaceSettings();
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO personal_reminders (user_id, entity_type, entity_id, remind_at, timezone, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.id, input.entity_type, Number(input.entity_id), at, user.timezone || ws.timezone, note],
    );
    await planRecord(client, input.entity_type, Number(input.entity_id));
    return rows[0];
  });
}

async function mine(user, id, client) {
  const { rows } = await client.query('SELECT * FROM personal_reminders WHERE id = $1 FOR UPDATE', [id]);
  // someone else's reminder is "not found", never "forbidden": its existence is private too
  if (!rows[0] || rows[0].user_id !== user.id) throw notFound('Reminder not found');
  return rows[0];
}

/** "Change my reminder": a new time or note; the old occurrence is cancelled. */
export async function changePersonalReminder(user, id, input) {
  const { at, note } = clean(input);
  return withTransaction(async (client) => {
    const r = await mine(user, id, client);
    if (r.status !== 'ACTIVE') throw badRequest('This reminder is no longer active');
    if (!(await canSeeRecord(user, r.entity_type, r.entity_id))) throw forbidden('Not available');
    const { rows } = await client.query(
      `UPDATE personal_reminders SET remind_at = $2, note = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, at, note],
    );
    await planRecord(client, r.entity_type, r.entity_id);
    return rows[0];
  });
}

export async function cancelPersonalReminder(user, id) {
  return withTransaction(async (client) => {
    const r = await mine(user, id, client);
    await client.query(`UPDATE personal_reminders SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [id]);
    await planRecord(client, r.entity_type, r.entity_id);
    return { ok: true };
  });
}

/** My own reminders, in my attention list: due now, or coming in the next 3 days. */
addContributor(async function personalItems(user, ctx) {
  const { rows } = await query(
    `SELECT * FROM personal_reminders WHERE user_id = $1 AND status = 'ACTIVE' AND remind_at < $2::timestamptz + interval '3 days'`,
    [user.id, ctx.c.now],
  );
  const out = [];
  for (const r of rows) {
    if (!(await canSeeRecord(user, r.entity_type, r.entity_id))) continue;
    const label = await recordLabel(r.entity_type, r.entity_id);
    if (!label) continue;
    const due = new Date(r.remind_at) <= ctx.c.now;
    out.push({
      key: `PERSONAL_REMINDER:${r.entity_type}:${r.entity_id}:p${r.id}v${r.version}`, kind: 'PERSONAL_REMINDER',
      title: 'Your reminder', reason: r.note || 'You asked to be reminded',
      record: { type: r.entity_type, id: r.entity_id, label: label.label, url: label.url },
      related: [], when: { at: r.remind_at, dateOnly: false }, tier: due ? 1 : 4, dueToday: due,
      action: { label: 'Open', kind: 'OPEN' },
    });
  }
  return out;
});
