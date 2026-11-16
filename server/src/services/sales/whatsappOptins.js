/**
 * WhatsApp opt-ins: who agreed to get WhatsApp messages from us, by number,
 * and how. A broadcast goes only to a number that agreed and has not opted
 * out. Agreeing is one of:
 *   - an opt-in recorded by a person (asked on a call, in person, other), with a note;
 *   - the "Send me updates on WhatsApp" tick box on an enquiry form;
 *   - a "yes" in an import's WhatsApp opt-in column;
 *   - having written to us on WhatsApp first (read from the messages).
 * A WhatsApp opt-out (a STOP reply, or one recorded by staff) always wins.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { recordAuditEvent } from '../audit.js';
import { logLeadActivity } from './leads.js';
import { normalizePhone } from './core.js';

export const OPTIN_HOW = ['ON_CALL', 'IN_PERSON', 'FORM', 'IMPORT', 'OTHER'];
export const OPTIN_WORDS = {
  ON_CALL: 'agreed on a call', IN_PERSON: 'agreed in person', FORM: 'ticked the box on an enquiry form',
  IMPORT: 'marked as agreed in an import', OTHER: 'agreed',
};

/** Where a number stands for WhatsApp: agreed (and how), wrote to us first, or opted out. */
export async function whatsappStanding(phone, runner = { query }) {
  const number = normalizePhone(phone);
  if (!number) return { phone: null, agreed: false, can_broadcast: false, why: 'No phone number' };
  const [optin, wrote, optout] = await Promise.all([
    runner.query(
      `SELECT o.id, o.how, o.note, o.recorded_at, o.lead_id, u.full_name AS recorded_by_name
         FROM crm_wa_optins o LEFT JOIN users u ON u.id = o.recorded_by
        WHERE o.phone_normalized = $1 AND o.removed_at IS NULL`, [number]),
    runner.query(`SELECT MIN(created_at) AS at FROM crm_wa_messages WHERE phone_normalized = $1 AND direction = 'INBOUND'`, [number]),
    runner.query(`SELECT created_at, reason, source FROM crm_optouts WHERE channel = 'WHATSAPP' AND address = $1 AND lifted_at IS NULL`, [number]),
  ]);
  const o = optin.rows[0] || null;
  const wroteAt = wrote.rows[0]?.at || null;
  const out = optout.rows[0] || null;
  const agreed = Boolean(o || wroteAt);
  return {
    phone: number,
    optin: o ? { ...o, words: OPTIN_WORDS[o.how] } : null,
    wrote_first_at: wroteAt,
    opted_out: out ? { at: out.created_at, reason: out.reason, source: out.source } : null,
    agreed,
    can_broadcast: agreed && !out,
    why: out ? 'Opted out of WhatsApp' : agreed ? null : 'No WhatsApp opt-in recorded',
  };
}

/**
 * Records that a number agreed to WhatsApp messages. Inside the caller's
 * transaction when one is given. One active opt-in per number: a second is
 * not stored (the first stands). A number that opted out is refused: the
 * opt-out is lifted first, by an administrator, if they asked to hear from us again.
 */
export async function recordOptin(client, { phone, leadId = null, how, note = null, actorId = null }) {
  const runner = client || { query };
  const number = normalizePhone(phone);
  if (!number) throw badRequest('There is no phone number to record an opt-in for');
  if (!OPTIN_HOW.includes(how)) throw badRequest('Say how they agreed');
  const { rows: out } = await runner.query(`SELECT 1 FROM crm_optouts WHERE channel = 'WHATSAPP' AND address = $1 AND lifted_at IS NULL`, [number]);
  if (out.length) throw conflict('This number opted out of WhatsApp. If they have asked to get messages again, an administrator lifts the opt-out first.');
  const { rows } = await runner.query(
    `INSERT INTO crm_wa_optins (phone_normalized, lead_id, how, note, recorded_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (phone_normalized) WHERE removed_at IS NULL DO NOTHING RETURNING *`,
    [number, leadId, how, note ? String(note).trim().slice(0, 500) || null : null, actorId],
  );
  return { optin: rows[0] || null, already: !rows[0] };
}

/** "Record WhatsApp opt-in" on a lead, by a person. */
export async function recordLeadOptin(lead, { how, note }, actor) {
  if (!['ON_CALL', 'IN_PERSON', 'OTHER'].includes(how)) throw badRequest('Say how they agreed: on a call, in person, or other');
  if (how === 'OTHER' && !String(note || '').trim()) throw badRequest('Say how they agreed');
  return withTransaction(async (client) => {
    const r = await recordOptin(client, { phone: lead.phone, leadId: lead.id, how, note, actorId: actor.id });
    if (!r.already) {
      await logLeadActivity(client, lead.id, {
        type: 'NOTE', subject: 'WhatsApp opt-in recorded', body: `${OPTIN_WORDS[how]}${note ? `: ${String(note).trim()}` : ''}`, actorId: actor.id,
      });
      await recordAuditEvent(client, { action: 'WA_OPTIN_RECORDED', entityType: 'LEAD', entityId: lead.id, actorId: actor.id, summary: OPTIN_WORDS[how], detail: { how } });
    }
    return r;
  });
}

/** Removes a recorded opt-in (recorded by mistake, or they changed their mind), with a reason. */
export async function removeLeadOptin(lead, { reason }, actor) {
  const why = String(reason || '').trim();
  if (why.length < 3) throw badRequest('Say why the opt-in is removed');
  const number = normalizePhone(lead.phone);
  if (!number) throw notFound('No opt-in recorded for this number');
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE crm_wa_optins SET removed_at = now(), removed_by = $2, removed_reason = $3
        WHERE phone_normalized = $1 AND removed_at IS NULL RETURNING id`, [number, actor.id, why.slice(0, 500)]);
    if (!rows[0]) throw notFound('No opt-in recorded for this number');
    await logLeadActivity(client, lead.id, { type: 'NOTE', subject: 'WhatsApp opt-in removed', body: why, actorId: actor.id });
    await recordAuditEvent(client, { action: 'WA_OPTIN_REMOVED', entityType: 'LEAD', entityId: lead.id, actorId: actor.id, summary: why });
    return { removed: true };
  });
}
