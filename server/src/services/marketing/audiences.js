/**
 * Audiences and who is on them.
 *
 * A contact can be on any number of audiences, each with its own status. Two
 * rules protect people's choices:
 *   - once someone unsubscribes, or their address bounces, no import, CRM sync
 *     or colleague can put them back — only their own action (a form they
 *     submit and confirm) can;
 *   - an address on the suppression list is never subscribed to anything.
 * Every change is written to the consent record.
 */

import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  isSuppressed, logContactActivity, newToken, recordConsent, suppress,
} from './core.js';

const slugify = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'audience';

export const AUDIENCE_KINDS = ['CUSTOMERS', 'LEADS', 'FPOS', 'STUDENTS', 'FARMERS', 'PARTNERS', 'DEALERS', 'CUSTOM'];

export async function listAudiences({ includeArchived = false } = {}) {
  const { rows } = await query(
    `SELECT a.*,
            COUNT(m.contact_id) FILTER (WHERE m.status = 'SUBSCRIBED' AND c.is_archived = FALSE)::int AS subscribed,
            COUNT(m.contact_id) FILTER (WHERE m.status = 'PENDING')::int AS pending,
            COUNT(m.contact_id) FILTER (WHERE m.status = 'UNSUBSCRIBED')::int AS unsubscribed,
            COUNT(m.contact_id) FILTER (WHERE m.status = 'CLEANED')::int AS cleaned,
            COUNT(m.contact_id) FILTER (WHERE m.status = 'SUBSCRIBED' AND m.subscribed_at > now() - interval '30 days')::int AS joined_30d
       FROM mkt_audiences a
       LEFT JOIN mkt_memberships m ON m.audience_id = a.id
       LEFT JOIN mkt_contacts c ON c.id = m.contact_id
      WHERE ($1 OR a.is_archived = FALSE)
      GROUP BY a.id ORDER BY a.is_archived, a.id`,
    [includeArchived],
  );
  return rows;
}

export async function getAudience(id) {
  const { rows } = await query('SELECT * FROM mkt_audiences WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Audience not found');
  return rows[0];
}

function syncRule(rule) {
  if (!rule) return null;
  const types = (rule.account_types || []).filter((t) => ['LEAD', 'CUSTOMER', 'PARTNER'].includes(t));
  const tags = (rule.account_tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const segments = (rule.segment_ids || []).map(Number).filter(Number.isInteger);
  if (!types.length && !tags.length && !segments.length) return null;
  return { account_types: types, account_tags: tags, segment_ids: segments };
}

export async function saveAudience(id, input, actor) {
  if (input.kind && !AUDIENCE_KINDS.includes(input.kind)) throw badRequest('Unknown kind of audience');
  const fields = {
    name: input.name?.trim(),
    kind: input.kind,
    description: input.description ?? undefined,
    purpose: input.purpose ?? undefined,
    double_opt_in: input.double_opt_in,
    crm_sync: input.crm_sync === undefined ? undefined : syncRule(input.crm_sync),
    crm_sync_status: input.crm_sync_status,
    from_name: input.from_name ?? undefined,
    from_email: input.from_email ?? undefined,
    reply_to: input.reply_to ?? undefined,
    color: input.color ?? undefined,
    is_archived: input.is_archived,
  };
  if (!id) {
    if (!fields.name) throw badRequest('Give the audience a name');
    let slug = slugify(fields.name);
    const { rows: taken } = await query('SELECT slug FROM mkt_audiences WHERE slug LIKE $1', [`${slug}%`]);
    if (taken.some((r) => r.slug === slug)) slug = `${slug}-${taken.length + 1}`;
    const { rows } = await query(
      `INSERT INTO mkt_audiences (name, slug, kind, description, purpose, double_opt_in, crm_sync, crm_sync_status,
                                  from_name, from_email, reply_to, color, created_by)
       VALUES ($1,$2,COALESCE($3,'CUSTOM'),$4,$5,COALESCE($6,TRUE),$7,COALESCE($8,'SUBSCRIBED'),$9,$10,$11,$12,$13) RETURNING *`,
      [fields.name, slug, fields.kind, fields.description ?? null, fields.purpose ?? null, fields.double_opt_in,
        fields.crm_sync ?? null, fields.crm_sync_status, fields.from_name ?? null, fields.from_email ?? null,
        fields.reply_to ?? null, fields.color ?? null, actor.id],
    );
    return rows[0];
  }
  await getAudience(id);
  const sets = [];
  const params = [id];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'name' && !value) throw badRequest('Give the audience a name');
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  if (sets.length) await query(`UPDATE mkt_audiences SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  return getAudience(id);
}

async function liftUnsubscribeAll(c, person, { source, basis = null, consentText = null, ip = null, userAgent = null, actorId = null, meta = {} }) {
  await c.query(`UPDATE mkt_contacts SET unsubscribed_all_at = NULL, email_status = CASE WHEN email_status = 'UNSUBSCRIBED' THEN 'ACTIVE' ELSE email_status END, updated_at = now() WHERE id = $1`, [person.id]);
  await c.query(`DELETE FROM mkt_suppressions WHERE email_normalized = $1 AND reason = 'UNSUBSCRIBED_ALL'`, [person.email_normalized]);
  await recordConsent(c, { contactId: person.id, action: 'UNSUPPRESS', source, basis, consentText, ip, userAgent, actorId, meta: { ...meta, note: 'Asked to hear from us again' } });
}

/**
 * Whether someone joining through a form must confirm by email first: always
 * when the audience asks for it, and always when this address once said stop —
 * so nobody can undo another person's unsubscribe by typing their address.
 */
export async function mustConfirm(client, contactId, audience) {
  if (audience.double_opt_in) return true;
  const runner = client || { query };
  const { rows } = await runner.query(
    `SELECT c.unsubscribed_all_at IS NOT NULL
            OR EXISTS (SELECT 1 FROM mkt_suppressions s WHERE s.email_normalized = c.email_normalized AND s.reason = 'UNSUBSCRIBED_ALL')
            OR EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.audience_id = $2 AND m.status = 'UNSUBSCRIBED') AS said_stop
       FROM mkt_contacts c WHERE c.id = $1`,
    [contactId, audience.id],
  );
  return Boolean(rows[0]?.said_stop);
}

/**
 * Puts a contact on an audience.
 *   status            SUBSCRIBED | PENDING (waits for them to confirm by email)
 *   allowResubscribe  only for the person's own action (a form they submitted)
 * Returns { result: SUBSCRIBED | PENDING | ALREADY | KEPT_UNSUBSCRIBED | SUPPRESSED, confirmToken? }
 */
export async function addToAudience(client, contactId, audienceId, {
  status = 'SUBSCRIBED', source = 'MANUAL', basis = null, consentText = null, ip = null, userAgent = null,
  actorId = null, meta = {}, synced = false, allowResubscribe = false,
} = {}) {
  const run = async (c) => {
    const { rows: people } = await c.query('SELECT id, email_normalized, unsubscribed_all_at, email_status FROM mkt_contacts WHERE id = $1', [contactId]);
    const person = people[0];
    if (!person) throw notFound('Contact not found');
    const suppressed = await isSuppressed(c, person.email_normalized);
    // their own new request lifts an earlier "unsubscribe from everything", nothing else does
    if (suppressed && !(allowResubscribe && suppressed === 'UNSUBSCRIBED_ALL')) return { result: 'SUPPRESSED', reason: suppressed };
    if (person.unsubscribed_all_at && !allowResubscribe) return { result: 'KEPT_UNSUBSCRIBED' };

    const { rows: memberships } = await c.query(
      'SELECT * FROM mkt_memberships WHERE audience_id = $1 AND contact_id = $2 FOR UPDATE', [audienceId, contactId],
    );
    const current = memberships[0];
    const confirmToken = status === 'PENDING' ? newToken() : null;

    if (current?.status === 'SUBSCRIBED') {
      if (synced && !current.synced) await c.query('UPDATE mkt_memberships SET synced = TRUE WHERE audience_id = $1 AND contact_id = $2', [audienceId, contactId]);
      return { result: 'ALREADY' };
    }
    if (current?.status === 'PENDING' && status === 'PENDING') {
      // a second form submission sends a fresh confirmation, not a second membership
      await c.query('UPDATE mkt_memberships SET confirm_token = $3, updated_at = now() WHERE audience_id = $1 AND contact_id = $2', [audienceId, contactId, confirmToken]);
      return { result: 'PENDING', confirmToken };
    }
    if (current && ['UNSUBSCRIBED', 'CLEANED'].includes(current.status) && !allowResubscribe) return { result: 'KEPT_UNSUBSCRIBED' };

    const resubscribing = current && ['UNSUBSCRIBED', 'CLEANED'].includes(current.status);
    if (current) {
      await c.query(
        `UPDATE mkt_memberships
            SET status = $3, source = $4, synced = $5, confirm_token = $6,
                subscribed_at = CASE WHEN $3 = 'SUBSCRIBED' THEN now() ELSE subscribed_at END,
                unsubscribed_at = NULL, unsubscribe_reason = NULL, updated_at = now()
          WHERE audience_id = $1 AND contact_id = $2`,
        [audienceId, contactId, status, source, synced, confirmToken],
      );
    } else {
      await c.query(
        `INSERT INTO mkt_memberships (audience_id, contact_id, status, source, synced, confirm_token, subscribed_at)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $3 = 'SUBSCRIBED' THEN now() END)`,
        [audienceId, contactId, status, source, synced, confirmToken],
      );
    }
    // an earlier "stop everything" is lifted only once they are subscribed
    // again; a pending signup waits for them to confirm by email
    if (allowResubscribe && person.unsubscribed_all_at && status === 'SUBSCRIBED') {
      await liftUnsubscribeAll(c, person, { source, basis, consentText, ip, userAgent, actorId, meta });
    }
    await recordConsent(c, {
      contactId, audienceId, action: resubscribing ? 'RESUBSCRIBE' : status === 'PENDING' ? 'PENDING' : 'SUBSCRIBE',
      source, basis, consentText, ip, userAgent, actorId, meta,
    });
    if (status === 'SUBSCRIBED') await logContactActivity(c, contactId, 'JOINED', { audienceId, data: { source }, actorId });
    return { result: status, confirmToken };
  };
  return client ? run(client) : withTransaction(run);
}

/** The person clicked the link in their confirmation email. */
export async function confirmMembership(token, { ip = null, userAgent = null } = {}) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `SELECT m.*, a.name AS audience_name FROM mkt_memberships m JOIN mkt_audiences a ON a.id = m.audience_id
        WHERE m.confirm_token = $1 FOR UPDATE OF m`, [token],
    );
    const membership = rows[0];
    if (!membership) return { ok: false, reason: 'This confirmation link is not valid, or has already been used.' };
    if (membership.status === 'SUBSCRIBED') return { ok: true, already: true, audience: membership.audience_name };
    if (membership.status !== 'PENDING') return { ok: false, reason: 'This subscription was ended, so the link no longer works.' };
    const { rows: people } = await c.query('SELECT * FROM mkt_contacts WHERE id = $1 FOR UPDATE', [membership.contact_id]);
    const suppressed = await isSuppressed(c, people[0].email_normalized);
    // a bounce or spam complaint since they signed up still wins
    if (suppressed && suppressed !== 'UNSUBSCRIBED_ALL') return { ok: false, reason: 'This address cannot be subscribed.' };
    await c.query(
      `UPDATE mkt_memberships SET status = 'SUBSCRIBED', confirmed_at = now(), subscribed_at = now(), confirm_token = NULL, updated_at = now()
        WHERE audience_id = $1 AND contact_id = $2`,
      [membership.audience_id, membership.contact_id],
    );
    if (people[0].unsubscribed_all_at || suppressed === 'UNSUBSCRIBED_ALL') {
      await liftUnsubscribeAll(c, people[0], { source: 'DOUBLE_OPT_IN', basis: 'Consent, confirmed by email', ip, userAgent });
    }
    await recordConsent(c, {
      contactId: membership.contact_id, audienceId: membership.audience_id, action: 'CONFIRM', source: 'DOUBLE_OPT_IN',
      basis: 'Consent, confirmed by email', ip, userAgent,
    });
    await logContactActivity(c, membership.contact_id, 'JOINED', { audienceId: membership.audience_id, data: { source: 'DOUBLE_OPT_IN' } });
    return { ok: true, audience: membership.audience_name, contactId: membership.contact_id };
  });
}

/**
 * Takes someone off an audience, or off everything.
 *   audienceId null + all true  every audience, plus the suppression list
 */
export async function unsubscribe(client, contactId, {
  audienceId = null, all = false, source, reason = null, ip = null, userAgent = null, actorId = null, messageId = null,
}) {
  const run = async (c) => {
    const { rows } = await c.query('SELECT * FROM mkt_contacts WHERE id = $1 FOR UPDATE', [contactId]);
    const person = rows[0];
    if (!person) throw notFound('Contact not found');
    if (all) {
      const { rows: left } = await c.query(
        `UPDATE mkt_memberships SET status = 'UNSUBSCRIBED', unsubscribed_at = now(), unsubscribe_reason = $2, confirm_token = NULL, updated_at = now()
          WHERE contact_id = $1 AND status IN ('SUBSCRIBED', 'PENDING') RETURNING audience_id`,
        [contactId, reason],
      );
      await c.query(
        `UPDATE mkt_contacts SET unsubscribed_all_at = COALESCE(unsubscribed_all_at, now()),
                email_status = CASE WHEN email_status = 'ACTIVE' THEN 'UNSUBSCRIBED' ELSE email_status END, updated_at = now()
          WHERE id = $1`,
        [contactId],
      );
      await suppress(c, person.email_normalized, { reason: 'UNSUBSCRIBED_ALL', source, actorId });
      await recordConsent(c, { contactId, action: 'UNSUBSCRIBE_ALL', source, ip, userAgent, actorId, meta: { reason, message_id: messageId } });
      for (const row of left) await logContactActivity(c, contactId, 'LEFT', { audienceId: row.audience_id, data: { source, all: true }, actorId });
      return { left: left.map((r) => r.audience_id), all: true };
    }
    if (!audienceId) throw badRequest('Say which audience to leave');
    const { rowCount } = await c.query(
      `UPDATE mkt_memberships SET status = 'UNSUBSCRIBED', unsubscribed_at = now(), unsubscribe_reason = $3, confirm_token = NULL, updated_at = now()
        WHERE contact_id = $1 AND audience_id = $2 AND status IN ('SUBSCRIBED', 'PENDING')`,
      [contactId, audienceId, reason],
    );
    if (rowCount) {
      await recordConsent(c, { contactId, audienceId, action: 'UNSUBSCRIBE', source, ip, userAgent, actorId, meta: { reason, message_id: messageId } });
      await logContactActivity(c, contactId, 'LEFT', { audienceId, data: { source }, actorId });
    }
    return { left: rowCount ? [audienceId] : [], all: false };
  };
  return client ? run(client) : withTransaction(run);
}

/** Staff take someone off an audience without it being their choice (not an unsubscribe). */
export async function removeFromAudience(contactId, audienceId, actor) {
  await withTransaction(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE mkt_memberships SET status = 'ARCHIVED', updated_at = now()
        WHERE contact_id = $1 AND audience_id = $2 AND status IN ('SUBSCRIBED', 'PENDING')`,
      [contactId, audienceId],
    );
    if (rowCount) {
      await recordConsent(c, { contactId, audienceId, action: 'ARCHIVE', source: 'MANUAL', actorId: actor.id });
      await logContactActivity(c, contactId, 'LEFT', { audienceId, data: { source: 'MANUAL' }, actorId: actor.id });
    }
  });
}

// ---------------------------------------------------------------- topics (subscription preferences)

export async function listTopics() {
  const { rows } = await query(
    `SELECT t.*, (SELECT COUNT(*)::int FROM mkt_contact_topics ct WHERE ct.topic_id = t.id AND ct.opted_in = FALSE) AS opted_out
       FROM mkt_topics t ORDER BY t.position, t.id`,
  );
  return rows;
}

export async function saveTopic(id, input) {
  if (id) {
    const { rows } = await query(
      `UPDATE mkt_topics SET name = COALESCE($2, name), name_hi = COALESCE($3, name_hi), description = COALESCE($4, description),
              is_active = COALESCE($5, is_active), position = COALESCE($6, position) WHERE id = $1 RETURNING *`,
      [id, input.name ?? null, input.name_hi ?? null, input.description ?? null, input.is_active ?? null, input.position ?? null],
    );
    if (!rows[0]) throw notFound('Topic not found');
    return rows[0];
  }
  if (!input.name?.trim()) throw badRequest('Give the topic a name');
  const key = slugify(input.name).replace(/-/g, '_');
  const { rows } = await query(
    `INSERT INTO mkt_topics (key, name, name_hi, description, position) VALUES ($1,$2,$3,$4,COALESCE($5, 100))
     ON CONFLICT (key) DO NOTHING RETURNING *`,
    [key, input.name.trim(), input.name_hi ?? null, input.description ?? null, input.position ?? null],
  );
  if (!rows[0]) throw badRequest('A topic with that name exists already');
  return rows[0];
}

/** { topicId: true | false } — what the person wants to hear about. */
export async function setTopics(client, contactId, choices, { source, ip = null, userAgent = null, actorId = null } = {}) {
  const runner = client || { query };
  for (const [topicId, wanted] of Object.entries(choices || {})) {
    const id = Number(topicId);
    if (!Number.isInteger(id)) continue;
    const { rows } = await runner.query('SELECT opted_in FROM mkt_contact_topics WHERE contact_id = $1 AND topic_id = $2', [contactId, id]);
    const before = rows[0] ? rows[0].opted_in : true;
    if (before === Boolean(wanted) && rows[0]) continue;
    await runner.query(
      `INSERT INTO mkt_contact_topics (contact_id, topic_id, opted_in) VALUES ($1,$2,$3)
       ON CONFLICT (contact_id, topic_id) DO UPDATE SET opted_in = EXCLUDED.opted_in, updated_at = now()`,
      [contactId, id, Boolean(wanted)],
    );
    if (before !== Boolean(wanted)) {
      await recordConsent(runner, { contactId, topicId: id, action: wanted ? 'TOPIC_IN' : 'TOPIC_OUT', source, ip, userAgent, actorId });
    }
  }
}

/** Members of an audience, newest first, with a search. */
export async function listMembers(audienceId, { status = null, search = '', limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT c.id, c.email, c.first_name, c.last_name, c.organization, c.engagement_score, c.language,
            m.status, m.source, m.subscribed_at, m.unsubscribed_at, m.synced
       FROM mkt_memberships m JOIN mkt_contacts c ON c.id = m.contact_id
      WHERE m.audience_id = $1 AND ($2::text IS NULL OR m.status = $2)
        AND ($3 = '' OR c.email_normalized LIKE '%' || lower($3) || '%' OR lower(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) LIKE '%' || lower($3) || '%')
      ORDER BY m.created_at DESC LIMIT $4 OFFSET $5`,
    [audienceId, status, search, Math.min(limit, 500), offset],
  );
  return rows;
}
