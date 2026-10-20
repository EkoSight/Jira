/**
 * The contact database: one row per email address, however many audiences,
 * imports, forms and CRM records it arrives from.
 *
 * A second sighting of an address never makes a second contact. By default it
 * only fills what is blank ("fill"); an import can choose to overwrite. Tags
 * and custom values are merged, never thrown away.
 */

import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { isValidEmail, logContactActivity, normalizeEmail, recordConsent, requireEmail } from './core.js';

export const CONTACT_FIELDS = ['first_name', 'last_name', 'phone', 'organization', 'designation', 'city', 'state', 'country', 'language'];

const cleanTag = (tag) => String(tag ?? '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
export const cleanTags = (tags) => [...new Set((tags || []).map(cleanTag).filter(Boolean))];

const text = (value, max = 200) => {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t ? t.slice(0, max) : null;
};

/** Splits "Ramesh Kumar Singh" into first and last name. */
export function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: null, last_name: null };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') || null };
}

/**
 * Adds a contact or updates the one with this address.
 *   mode 'fill'       blank fields are filled, nothing is overwritten (default)
 *   mode 'overwrite'  given fields replace what is there
 * Returns { contact, created }.
 */
export async function upsertContact(client, input, { source = 'MANUAL', actorId = null, mode = 'fill' } = {}) {
  const runner = client || { query };
  const email = requireEmail(input.email);
  const values = {};
  for (const key of CONTACT_FIELDS) if (input[key] !== undefined) values[key] = text(input[key]);
  if (values.language && !['en', 'hi'].includes(values.language)) values.language = null;
  if (input.full_name && !input.first_name && !input.last_name) Object.assign(values, splitName(input.full_name));
  const tags = cleanTags(input.tags);
  const custom = input.custom && typeof input.custom === 'object' ? input.custom : {};

  const { rows: existing } = await runner.query('SELECT * FROM mkt_contacts WHERE email_normalized = $1 FOR UPDATE', [email]);
  if (!existing[0]) {
    const { rows } = await runner.query(
      `INSERT INTO mkt_contacts (email, email_normalized, first_name, last_name, phone, organization, designation,
                                 city, state, country, language, tags, custom, account_id, crm_contact_id,
                                 owner_user_id, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'en'),$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (email_normalized) DO NOTHING
       RETURNING *`,
      [String(input.email).trim(), email, values.first_name ?? null, values.last_name ?? null, values.phone ?? null,
        values.organization ?? null, values.designation ?? null, values.city ?? null, values.state ?? null,
        values.country ?? null, values.language ?? null, tags, custom, input.account_id ?? null,
        input.crm_contact_id ?? null, input.owner_user_id ?? null, source, actorId],
    );
    if (rows[0]) {
      await logContactActivity(runner, rows[0].id, 'CREATED', { data: { source }, actorId });
      for (const tag of tags) await logContactActivity(runner, rows[0].id, 'TAG_ADDED', { data: { tag }, actorId });
      return { contact: rows[0], created: true };
    }
    // someone else added the same address a moment ago: treat as an update
    return upsertContact(client, input, { source, actorId, mode });
  }

  const current = existing[0];
  const next = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null) continue;
    // a language is always set, so "fill" never changes the one they have
    if (key === 'language') {
      if (mode === 'overwrite' && value !== current.language) next.language = value;
      continue;
    }
    if (mode === 'overwrite' || current[key] === null || current[key] === '') next[key] = value;
  }
  const mergedCustom = mode === 'overwrite'
    ? { ...current.custom, ...custom }
    : { ...custom, ...Object.fromEntries(Object.entries(current.custom || {}).filter(([, v]) => v !== null && v !== '')) };
  const mergedTags = cleanTags([...(current.tags || []), ...tags]);
  const links = {};
  for (const key of ['account_id', 'crm_contact_id', 'owner_user_id']) {
    if (input[key] !== undefined && input[key] !== null && (mode === 'overwrite' || current[key] === null)) links[key] = input[key];
  }

  const sets = [];
  const params = [current.id];
  const add = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
  for (const [key, value] of Object.entries({ ...next, ...links })) add(key, value);
  if (JSON.stringify(mergedCustom) !== JSON.stringify(current.custom || {})) add('custom', mergedCustom);
  if (mergedTags.join(',') !== (current.tags || []).join(',')) add('tags', mergedTags);
  // someone archived and now re-added on purpose comes back
  if (current.is_archived && source !== 'CRM_SYNC') add('is_archived', false);
  if (!sets.length) return { contact: current, created: false, changed: false };
  const { rows } = await runner.query(
    `UPDATE mkt_contacts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    params,
  );
  for (const tag of mergedTags.filter((t) => !(current.tags || []).includes(t))) {
    await logContactActivity(runner, current.id, 'TAG_ADDED', { data: { tag }, actorId });
  }
  return { contact: rows[0], created: false, changed: true };
}

/**
 * Contacts for the list on screen: a search, filters and a page.
 *   status  SUBSCRIBED (on at least one audience) | UNSUBSCRIBED | BOUNCED | SUPPRESSED | ARCHIVED
 */
export async function listContacts({ search = '', audienceId = null, tag = null, status = null, rules = null, compile = null, limit = 50, offset = 0 } = {}) {
  const params = [];
  const p = (value) => { params.push(value); return `$${params.length}`; };
  const where = [status === 'ARCHIVED' ? 'c.is_archived = TRUE' : 'c.is_archived = FALSE'];
  const term = String(search || '').trim().toLowerCase();
  if (term) {
    const t = p(term);
    where.push(`(c.email_normalized LIKE '%' || ${t} || '%' OR lower(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) LIKE '%' || ${t} || '%'
                 OR lower(COALESCE(c.organization,'')) LIKE '%' || ${t} || '%' OR COALESCE(c.phone,'') LIKE '%' || ${t} || '%')`);
  }
  if (audienceId) where.push(`EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.audience_id = ${p(Number(audienceId))} AND m.status IN ('SUBSCRIBED', 'PENDING'))`);
  if (tag) where.push(`${p(String(tag).toLowerCase())} = ANY(c.tags)`);
  if (status === 'SUBSCRIBED') where.push(`EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.status = 'SUBSCRIBED')`);
  if (status === 'UNSUBSCRIBED') where.push('c.unsubscribed_all_at IS NOT NULL');
  if (status === 'BOUNCED') where.push(`c.email_status IN ('BOUNCED', 'COMPLAINED', 'INVALID')`);
  if (status === 'SUPPRESSED') where.push('EXISTS (SELECT 1 FROM mkt_suppressions s WHERE s.email_normalized = c.email_normalized)');
  if (rules && compile) where.push(`(${compile(rules, params)})`);
  const sql = `FROM mkt_contacts c WHERE ${where.join(' AND ')}`;
  const countParams = [...params];
  const [count, rows] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n ${sql}`, countParams),
    query(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.organization, c.phone, c.city, c.state, c.language, c.tags,
              c.email_status, c.engagement_score, c.last_opened_at, c.last_clicked_at, c.created_at, c.source, c.account_id,
              c.unsubscribed_all_at, c.is_archived,
              (SELECT a.name FROM accounts a WHERE a.id = c.account_id) AS account_name,
              (SELECT COALESCE(json_agg(json_build_object('id', au.id, 'name', au.name, 'status', m.status, 'color', au.color) ORDER BY au.name), '[]'::json)
                 FROM mkt_memberships m JOIN mkt_audiences au ON au.id = m.audience_id
                WHERE m.contact_id = c.id AND m.status IN ('SUBSCRIBED', 'PENDING')) AS audiences
         ${sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ${p(Math.min(Number(limit) || 50, 500))} OFFSET ${p(Math.max(Number(offset) || 0, 0))}`,
      params,
    ),
  ]);
  return { total: count.rows[0].n, contacts: rows.rows };
}

export async function getContact(id) {
  const { rows } = await query(
    `SELECT c.*, a.name AS account_name, a.type AS account_type, o.full_name AS owner_name,
            (SELECT full_name FROM account_contacts ac WHERE ac.id = c.crm_contact_id) AS crm_contact_name
       FROM mkt_contacts c
       LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN users o ON o.id = c.owner_user_id
      WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Contact not found');
  return rows[0];
}

/** Everything about one person: memberships, preferences, consent, what they received and did. */
export async function contactDetail(id) {
  const contact = await getContact(id);
  const [memberships, topics, consents, messages, events, followups, suppression] = await Promise.all([
    query(`SELECT m.*, a.name AS audience_name, a.color FROM mkt_memberships m JOIN mkt_audiences a ON a.id = m.audience_id
            WHERE m.contact_id = $1 ORDER BY a.name`, [id]),
    query(`SELECT t.id, t.key, t.name, COALESCE(ct.opted_in, TRUE) AS opted_in FROM mkt_topics t
             LEFT JOIN mkt_contact_topics ct ON ct.topic_id = t.id AND ct.contact_id = $1
            WHERE t.is_active ORDER BY t.position`, [id]),
    query(`SELECT k.*, a.name AS audience_name, t.name AS topic_name, u.full_name AS actor_name FROM mkt_consents k
             LEFT JOIN mkt_audiences a ON a.id = k.audience_id LEFT JOIN mkt_topics t ON t.id = k.topic_id
             LEFT JOIN users u ON u.id = k.actor_id
            WHERE k.contact_id = $1 ORDER BY k.created_at DESC LIMIT 100`, [id]),
    query(`SELECT m.id, m.kind, m.status, m.skip_reason, m.subject, m.variant, m.sent_at, m.delivered_at, m.first_opened_at,
                  m.first_clicked_at, m.replied_at, m.converted_at, m.bounced_at, m.unsubscribed_at, m.open_count, m.click_count,
                  m.campaign_id, c.name AS campaign_name, m.workflow_id, w.name AS workflow_name
             FROM mkt_messages m LEFT JOIN mkt_campaigns c ON c.id = m.campaign_id LEFT JOIN mkt_workflows w ON w.id = m.workflow_id
            WHERE m.contact_id = $1 AND m.kind IN ('CAMPAIGN', 'AUTOMATION') ORDER BY m.queued_at DESC LIMIT 100`, [id]),
    query(`SELECT e.id, e.type, e.url, e.source, e.is_machine, e.occurred_at, e.meta, e.campaign_id, c.name AS campaign_name
             FROM mkt_events e LEFT JOIN mkt_campaigns c ON c.id = e.campaign_id
            WHERE e.contact_id = $1 ORDER BY e.occurred_at DESC LIMIT 150`, [id]),
    query(`SELECT f.*, t.ref AS task_ref, t.title AS task_title, ws.stage AS task_stage
             FROM mkt_followups f LEFT JOIN tasks t ON t.id = f.task_id LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
            WHERE f.contact_id = $1 ORDER BY f.created_at DESC`, [id]),
    query('SELECT * FROM mkt_suppressions WHERE email_normalized = $1', [contact.email_normalized]),
  ]);
  return {
    contact,
    memberships: memberships.rows,
    topics: topics.rows,
    consents: consents.rows,
    messages: messages.rows,
    events: events.rows,
    followups: followups.rows,
    suppression: suppression.rows[0] || null,
  };
}

export async function updateContact(id, input, actor) {
  const current = await getContact(id);
  const sets = [];
  const params = [id];
  const add = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
  for (const key of CONTACT_FIELDS) if (input[key] !== undefined) add(key, key === 'language' ? (['en', 'hi'].includes(input.language) ? input.language : 'en') : text(input[key]));
  if (input.tags !== undefined) add('tags', cleanTags(input.tags));
  if (input.custom !== undefined) add('custom', { ...current.custom, ...input.custom });
  if (input.owner_user_id !== undefined) add('owner_user_id', input.owner_user_id || null);
  if (input.email !== undefined && normalizeEmail(input.email) !== current.email_normalized) {
    const email = requireEmail(input.email);
    const { rows } = await query('SELECT id FROM mkt_contacts WHERE email_normalized = $1', [email]);
    if (rows[0]) throw badRequest('Another contact already has that address. Open that contact instead of creating a duplicate.');
    add('email', String(input.email).trim());
    add('email_normalized', email);
  }
  if (!sets.length) return current;
  await query(`UPDATE mkt_contacts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  if (input.tags !== undefined) {
    const next = cleanTags(input.tags);
    for (const tag of next.filter((t) => !current.tags.includes(t))) await logContactActivity(null, id, 'TAG_ADDED', { data: { tag }, actorId: actor?.id });
    for (const tag of current.tags.filter((t) => !next.includes(t))) await logContactActivity(null, id, 'TAG_REMOVED', { data: { tag }, actorId: actor?.id });
  }
  return getContact(id);
}

export async function archiveContact(id, archived = true) {
  const { rowCount } = await query('UPDATE mkt_contacts SET is_archived = $2, updated_at = now() WHERE id = $1', [id, archived]);
  if (!rowCount) throw notFound('Contact not found');
}

export async function changeTags(contactIds, { add = [], remove = [] }, actorId = null) {
  const plus = cleanTags(add);
  const minus = cleanTags(remove);
  // only real changes are history: adding a tag someone already has is not an event
  const { rows: before } = await query('SELECT id, tags FROM mkt_contacts WHERE id = ANY($1::int[])', [contactIds]);
  await query(
    `UPDATE mkt_contacts
        SET tags = ARRAY(SELECT DISTINCT t FROM unnest(array_cat(tags, $2::text[])) t WHERE NOT (t = ANY($3::text[]))),
            updated_at = now()
      WHERE id = ANY($1::int[])`,
    [contactIds, plus, minus],
  );
  for (const row of before) {
    for (const tag of plus.filter((t) => !row.tags.includes(t))) await logContactActivity(null, row.id, 'TAG_ADDED', { data: { tag }, actorId });
    for (const tag of minus.filter((t) => row.tags.includes(t))) await logContactActivity(null, row.id, 'TAG_REMOVED', { data: { tag }, actorId });
  }
  return { added: plus, removed: minus };
}

export async function allTags() {
  const { rows } = await query(
    `SELECT t AS tag, COUNT(*)::int AS contacts FROM mkt_contacts, unnest(tags) t
      WHERE is_archived = FALSE GROUP BY t ORDER BY COUNT(*) DESC, t`,
  );
  return rows;
}

// ---------------------------------------------------------------- CSV import

/** RFC 4180 CSV, with quoted fields, doubled quotes and newlines inside quotes. */
export function parseCsv(input) {
  const source = String(input ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// headers people actually use, mapped to fields
const HEADER_GUESS = {
  email: /^(e-?mail|email address|mail)$/i,
  first_name: /^(first ?name|given name|fname)$/i,
  last_name: /^(last ?name|surname|family name|lname)$/i,
  full_name: /^(name|full ?name|contact ?name)$/i,
  phone: /^(phone|mobile|contact number|whatsapp|phone number)$/i,
  organization: /^(organi[sz]ation|company|org|fpo|institute)$/i,
  designation: /^(designation|title|job title|role)$/i,
  city: /^(city|town|village)$/i,
  state: /^(state|province)$/i,
  country: /^country$/i,
  language: /^(language|lang)$/i,
  tags: /^tags?$/i,
};

/** The suggested field for each column, from its heading. */
export function guessMapping(headers, customKeys = []) {
  return headers.map((h) => {
    const label = String(h || '').trim();
    for (const [field, pattern] of Object.entries(HEADER_GUESS)) if (pattern.test(label)) return field;
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (customKeys.includes(key)) return `custom.${key}`;
    return null;
  });
}

const LANGUAGE_WORDS = { en: 'en', english: 'en', hi: 'hi', hindi: 'hi', 'हिंदी': 'hi', 'हिन्दी': 'hi' };

/**
 * Imports rows into the contact database and, optionally, an audience.
 *
 * The person importing must say why these people may be emailed (`basis`);
 * it is written into each contact's consent record with the file name. Rows
 * whose address is suppressed, or who unsubscribed from the audience, are added
 * or updated but never re-subscribed.
 */
export async function importContacts({
  csv, mapping, audienceId = null, status = 'SUBSCRIBED', basis, tags = [], mode = 'fill', filename = null, actor,
}, { addToAudience }) {
  if (!basis || String(basis).trim().length < 5) throw badRequest('Say how these people agreed to hear from you (the consent basis)');
  if (!['SUBSCRIBED', 'PENDING', 'NONE'].includes(status)) throw badRequest('Choose subscribed, pending or not subscribed');
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('The file needs a heading row and at least one contact');
  if (rows.length > 50_001) throw badRequest('Import at most 50,000 contacts at a time');
  const [header, ...data] = rows;
  const map = mapping || guessMapping(header);
  const emailColumn = map.indexOf('email');
  if (emailColumn < 0) throw badRequest('Choose which column holds the email address');

  const totals = { rows: data.length, created: 0, updated: 0, unchanged: 0, invalid: 0, duplicate_in_file: 0, subscribed: 0, not_resubscribed: 0, suppressed: 0 };
  const problems = [];
  const seen = new Set();
  const importTags = cleanTags(tags);

  await withTransaction(async (client) => {
    const { rows: imp } = await client.query(
      `INSERT INTO mkt_imports (filename, audience_id, status_given, basis, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [filename, audienceId, status, basis, importTags, actor.id],
    );
    const importId = imp[0].id;
    for (const [index, cells] of data.entries()) {
      const line = index + 2;
      const rawEmail = cells[emailColumn];
      if (!isValidEmail(rawEmail)) {
        totals.invalid += 1;
        if (problems.length < 200) problems.push({ line, email: String(rawEmail || '').slice(0, 80), problem: 'Not an email address' });
        continue;
      }
      const email = normalizeEmail(rawEmail);
      if (seen.has(email)) {
        totals.duplicate_in_file += 1;
        continue;
      }
      seen.add(email);

      const input = { email: String(rawEmail).trim(), custom: {}, tags: [...importTags] };
      map.forEach((field, i) => {
        if (!field || i === emailColumn) return;
        const value = cells[i];
        if (value === undefined || String(value).trim() === '') return;
        if (field === 'tags') input.tags.push(...String(value).split(/[;,|]/));
        else if (field === 'language') input.language = LANGUAGE_WORDS[String(value).trim().toLowerCase()] || null;
        else if (field.startsWith('custom.')) input.custom[field.slice(7)] = String(value).trim().slice(0, 500);
        else input[field] = value;
      });
      const result = await upsertContact(client, input, { source: 'IMPORT', actorId: actor.id, mode });
      if (result.created) totals.created += 1;
      else if (result.changed) totals.updated += 1;
      else totals.unchanged += 1;

      if (audienceId && status !== 'NONE') {
        const joined = await addToAudience(client, result.contact.id, audienceId, {
          status, source: 'IMPORT', basis, actorId: actor.id, meta: { import_id: importId, filename, line },
        });
        if (joined.result === 'SUBSCRIBED' || joined.result === 'PENDING') totals.subscribed += 1;
        else if (joined.result === 'SUPPRESSED') totals.suppressed += 1;
        else if (joined.result === 'KEPT_UNSUBSCRIBED') totals.not_resubscribed += 1;
      } else if (result.created) {
        await recordConsent(client, {
          contactId: result.contact.id, action: 'SUBSCRIBE', source: 'IMPORT', basis, actorId: actor.id,
          meta: { import_id: importId, filename, line, note: 'Added to the contact database only, not to an audience' },
        });
      }
    }
    await client.query('UPDATE mkt_imports SET totals = $2, problems = $3 WHERE id = $1', [importId, totals, JSON.stringify(problems)]);
    totals.import_id = importId;
  });
  return { totals, problems };
}
