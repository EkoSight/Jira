/**
 * Segments: rules over contacts, compiled to SQL.
 *
 * A rule set is { match: 'all' | 'any', conditions: [ condition | rule set ] },
 * nested to any depth. Every field and operator comes from the catalogue below,
 * and every value is a bound parameter — a rule can never become SQL of its own.
 */

import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';

/** What can be filtered on, for the builder on screen and for the compiler. */
export const SEGMENT_FIELDS = [
  { key: 'email', label: 'Email address', group: 'Contact', type: 'text' },
  { key: 'email_domain', label: 'Email domain', group: 'Contact', type: 'text' },
  { key: 'first_name', label: 'First name', group: 'Contact', type: 'text' },
  { key: 'last_name', label: 'Last name', group: 'Contact', type: 'text' },
  { key: 'organization', label: 'Organization', group: 'Contact', type: 'text' },
  { key: 'designation', label: 'Designation', group: 'Contact', type: 'text' },
  { key: 'city', label: 'City', group: 'Location', type: 'text' },
  { key: 'state', label: 'State', group: 'Location', type: 'text' },
  { key: 'country', label: 'Country', group: 'Location', type: 'text' },
  { key: 'language', label: 'Language', group: 'Contact', type: 'select', options: [['en', 'English'], ['hi', 'Hindi']] },
  { key: 'source', label: 'How they were added', group: 'Contact', type: 'select', options: [['MANUAL', 'Added by hand'], ['IMPORT', 'Import'], ['FORM', 'Signup form'], ['CRM_SYNC', 'From the CRM'], ['API', 'API']] },
  { key: 'tag', label: 'Tag', group: 'Contact', type: 'tag' },
  { key: 'created_at', label: 'Added', group: 'Contact', type: 'date' },
  { key: 'custom', label: 'Custom field', group: 'Contact', type: 'custom' },
  { key: 'audience', label: 'Audience membership', group: 'Audiences', type: 'audience' },
  { key: 'topic', label: 'Subscription preference', group: 'Audiences', type: 'topic' },
  { key: 'engagement_score', label: 'Engagement score (0–100)', group: 'Engagement', type: 'number' },
  { key: 'last_opened_at', label: 'Last opened an email', group: 'Engagement', type: 'date' },
  { key: 'last_clicked_at', label: 'Last clicked a link', group: 'Engagement', type: 'date' },
  { key: 'last_sent_at', label: 'Last sent an email', group: 'Engagement', type: 'date' },
  { key: 'campaign_activity', label: 'Campaign activity', group: 'Engagement', type: 'campaign' },
  { key: 'crm_type', label: 'Pipeline type of their organization', group: 'CRM', type: 'select', options: [['LEAD', 'Lead'], ['CUSTOMER', 'Customer'], ['PARTNER', 'Partner'], ['NONE', 'Not in the pipeline']] },
  { key: 'crm_segment', label: 'Organization segment', group: 'CRM', type: 'crm_segment' },
  { key: 'crm_tag', label: 'Organization tag', group: 'CRM', type: 'tag' },
  { key: 'crm_owner', label: 'Owner in TaskFlow', group: 'CRM', type: 'user' },
  { key: 'crm_open_deal', label: 'Has an open deal', group: 'CRM', type: 'boolean' },
];

export const OPERATORS = {
  text: ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with', 'empty', 'not_empty'],
  select: ['is', 'is_not'],
  number: ['eq', 'gt', 'gte', 'lt', 'lte'],
  date: ['within_days', 'not_within_days', 'before', 'after', 'never', 'ever'],
  tag: ['has', 'not_has'],
  custom: ['is', 'is_not', 'contains', 'gt', 'lt', 'empty', 'not_empty'],
  audience: ['subscribed', 'not_subscribed', 'unsubscribed', 'pending'],
  topic: ['opted_out', 'not_opted_out'],
  campaign: ['received', 'opened', 'not_opened', 'clicked', 'not_clicked', 'replied', 'converted'],
  crm_segment: ['is', 'is_not'],
  user: ['is', 'is_not'],
  boolean: ['yes', 'no'],
};

const COLUMN = {
  email: 'c.email_normalized', first_name: 'c.first_name', last_name: 'c.last_name', organization: 'c.organization',
  designation: 'c.designation', city: 'c.city', state: 'c.state', country: 'c.country', language: 'c.language',
  source: 'c.source', created_at: 'c.created_at', engagement_score: 'c.engagement_score',
  last_opened_at: 'c.last_opened_at', last_clicked_at: 'c.last_clicked_at', last_sent_at: 'c.last_sent_at',
  email_domain: "split_part(c.email_normalized, '@', 2)",
};

const FIELD_BY_KEY = Object.fromEntries(SEGMENT_FIELDS.map((f) => [f.key, f]));
const MAX_DEPTH = 4;
const MAX_CONDITIONS = 60;

/** Compiles a rule set into a WHERE fragment over contacts aliased `c`. Pushes values into `params`. */
export function compileRules(rules, params, depth = 0, counter = { n: 0 }) {
  if (!rules || !Array.isArray(rules.conditions) || !rules.conditions.length) return 'TRUE';
  if (depth > MAX_DEPTH) throw badRequest('Segments can be nested at most four levels deep');
  const joiner = rules.match === 'any' ? ' OR ' : ' AND ';
  const parts = rules.conditions.map((cond) => {
    if (cond && Array.isArray(cond.conditions)) return `(${compileRules(cond, params, depth + 1, counter)})`;
    counter.n += 1;
    if (counter.n > MAX_CONDITIONS) throw badRequest(`A segment can have at most ${MAX_CONDITIONS} conditions`);
    return `(${compileCondition(cond, params)})`;
  });
  return parts.join(joiner);
}

const p = (params, value) => { params.push(value); return `$${params.length}`; };

function textCondition(column, op, value, params) {
  const v = String(value ?? '').trim().toLowerCase();
  const col = `lower(COALESCE(${column}, ''))`;
  switch (op) {
    case 'is': return `${col} = ${p(params, v)}`;
    case 'is_not': return `${col} <> ${p(params, v)}`;
    case 'contains': return `${col} LIKE '%' || ${p(params, v)} || '%'`;
    case 'not_contains': return `${col} NOT LIKE '%' || ${p(params, v)} || '%'`;
    case 'starts_with': return `${col} LIKE ${p(params, v)} || '%'`;
    case 'ends_with': return `${col} LIKE '%' || ${p(params, v)}`;
    case 'empty': return `${col} = ''`;
    case 'not_empty': return `${col} <> ''`;
    default: throw badRequest(`Unknown condition "${op}"`);
  }
}

function dateCondition(column, op, value, params) {
  switch (op) {
    case 'within_days': return `${column} >= now() - make_interval(days => ${p(params, Math.max(0, Number(value) || 0))}::int)`;
    case 'not_within_days': return `(${column} IS NULL OR ${column} < now() - make_interval(days => ${p(params, Math.max(0, Number(value) || 0))}::int))`;
    case 'before': return `${column} < ${p(params, String(value))}::date`;
    case 'after': return `${column} >= ${p(params, String(value))}::date + 1`;
    case 'never': return `${column} IS NULL`;
    case 'ever': return `${column} IS NOT NULL`;
    default: throw badRequest(`Unknown condition "${op}"`);
  }
}

const NUMBER_OPS = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

export function compileCondition(cond, params) {
  const field = FIELD_BY_KEY[cond?.field];
  if (!field) throw badRequest(`Unknown field "${cond?.field}"`);
  const op = cond.op;
  if (!OPERATORS[field.type].includes(op)) throw badRequest(`"${op}" does not apply to ${field.label}`);
  const value = cond.value;

  switch (field.type) {
    case 'text': return textCondition(COLUMN[field.key], op, value, params);
    case 'select':
      if (field.key === 'crm_type') {
        const v = String(value);
        const clause = v === 'NONE'
          ? 'c.account_id IS NULL'
          : `EXISTS (SELECT 1 FROM accounts a WHERE a.id = c.account_id AND a.type = ${p(params, v)})`;
        return op === 'is_not' ? `NOT (${clause})` : clause;
      }
      return op === 'is_not' ? `${COLUMN[field.key]} <> ${p(params, String(value))}` : `${COLUMN[field.key]} = ${p(params, String(value))}`;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw badRequest(`${field.label} needs a number`);
      return `${COLUMN[field.key]} ${NUMBER_OPS[op]} ${p(params, n)}`;
    }
    case 'date': return dateCondition(COLUMN[field.key], op, value, params);
    case 'tag': {
      const tag = String(value ?? '').trim().toLowerCase();
      const clause = field.key === 'crm_tag'
        ? `EXISTS (SELECT 1 FROM accounts a WHERE a.id = c.account_id AND ${p(params, tag)} = ANY(SELECT lower(x) FROM unnest(a.tags) x))`
        : `${p(params, tag)} = ANY(c.tags)`;
      return op === 'not_has' ? `NOT (${clause})` : clause;
    }
    case 'custom': {
      const key = String(cond.key || '');
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw badRequest('Choose a custom field');
      const col = `(c.custom ->> ${p(params, key)})`;
      if (op === 'gt' || op === 'lt') {
        const n = Number(value);
        if (!Number.isFinite(n)) throw badRequest('That custom field condition needs a number');
        return `(CASE WHEN ${col} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${col}::numeric ELSE NULL END) ${op === 'gt' ? '>' : '<'} ${p(params, n)}`;
      }
      return textCondition(col, op, value, params);
    }
    case 'audience': {
      const id = Number(value);
      if (!Number.isInteger(id)) throw badRequest('Choose an audience');
      const status = { subscribed: 'SUBSCRIBED', unsubscribed: 'UNSUBSCRIBED', pending: 'PENDING' }[op];
      if (op === 'not_subscribed') {
        return `NOT EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.audience_id = ${p(params, id)} AND m.status = 'SUBSCRIBED')`;
      }
      return `EXISTS (SELECT 1 FROM mkt_memberships m WHERE m.contact_id = c.id AND m.audience_id = ${p(params, id)} AND m.status = '${status}')`;
    }
    case 'topic': {
      const id = Number(value);
      const clause = `EXISTS (SELECT 1 FROM mkt_contact_topics t WHERE t.contact_id = c.id AND t.topic_id = ${p(params, id)} AND t.opted_in = FALSE)`;
      return op === 'not_opted_out' ? `NOT (${clause})` : clause;
    }
    case 'campaign': {
      const id = Number(value);
      if (!Number.isInteger(id)) throw badRequest('Choose a campaign');
      const msg = `SELECT 1 FROM mkt_messages mm WHERE mm.contact_id = c.id AND mm.campaign_id = ${p(params, id)} AND mm.kind = 'CAMPAIGN'`;
      const human = (type) => `${msg} AND EXISTS (SELECT 1 FROM mkt_events e WHERE e.message_id = mm.id AND e.type = '${type}' AND e.is_machine = FALSE)`;
      switch (op) {
        case 'received': return `EXISTS (${msg} AND mm.sent_at IS NOT NULL)`;
        case 'opened': return `EXISTS (${human('OPEN')})`;
        case 'not_opened': return `EXISTS (${msg} AND mm.sent_at IS NOT NULL) AND NOT EXISTS (${human('OPEN')})`;
        case 'clicked': return `EXISTS (${human('CLICK')})`;
        case 'not_clicked': return `EXISTS (${msg} AND mm.sent_at IS NOT NULL) AND NOT EXISTS (${human('CLICK')})`;
        case 'replied': return `EXISTS (${msg} AND mm.replied_at IS NOT NULL)`;
        case 'converted': return `EXISTS (${msg} AND mm.converted_at IS NOT NULL)`;
        default: throw badRequest(`Unknown condition "${op}"`);
      }
    }
    case 'crm_segment': {
      const clause = `EXISTS (SELECT 1 FROM accounts a WHERE a.id = c.account_id AND a.segment_id = ${p(params, Number(value))})`;
      return op === 'is_not' ? `NOT (${clause})` : clause;
    }
    case 'user': {
      const clause = `COALESCE(c.owner_user_id, (SELECT a.owner_user_id FROM accounts a WHERE a.id = c.account_id)) = ${p(params, Number(value))}`;
      return op === 'is_not' ? `NOT (${clause}) OR COALESCE(c.owner_user_id, (SELECT a.owner_user_id FROM accounts a WHERE a.id = c.account_id)) IS NULL` : clause;
    }
    case 'boolean': {
      const clause = `EXISTS (SELECT 1 FROM opportunities o WHERE o.account_id = c.account_id AND o.status IN ('ACTIVE', 'ON_HOLD', 'NURTURE'))`;
      return op === 'no' ? `NOT ${clause}` : clause;
    }
    default: throw badRequest('Unknown field');
  }
}

/** Contacts matching a rule set (optionally within one audience's subscribers). */
export async function previewSegment(rules, { audienceId = null, limit = 25 } = {}) {
  const params = [];
  const where = compileRules(rules, params);
  const audienceClause = audienceId
    ? `AND EXISTS (SELECT 1 FROM mkt_memberships m0 WHERE m0.contact_id = c.id AND m0.audience_id = ${p(params, Number(audienceId))} AND m0.status = 'SUBSCRIBED')`
    : '';
  const sql = `FROM mkt_contacts c WHERE c.is_archived = FALSE ${audienceClause} AND (${where})`;
  const [count, sample] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n ${sql}`, params),
    query(`SELECT c.id, c.email, c.first_name, c.last_name, c.organization, c.engagement_score ${sql} ORDER BY c.engagement_score DESC, c.id LIMIT ${Math.min(Number(limit) || 25, 100)}`, params),
  ]);
  return { count: count.rows[0].n, sample: sample.rows };
}

export async function listSegments() {
  const { rows } = await query(
    `SELECT s.*, a.name AS audience_name, u.full_name AS created_by_name FROM mkt_segments s
       LEFT JOIN mkt_audiences a ON a.id = s.audience_id LEFT JOIN users u ON u.id = s.created_by
      ORDER BY s.updated_at DESC`,
  );
  return rows;
}

export async function getSegment(id) {
  const { rows } = await query('SELECT * FROM mkt_segments WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Segment not found');
  return rows[0];
}

export async function saveSegment(id, { name, description, audience_id: audienceId, rules }, actor) {
  if (!name?.trim()) throw badRequest('Give the segment a name');
  compileRules(rules, []); // refuse a rule set that does not compile
  if (id) {
    const { rows } = await query(
      `UPDATE mkt_segments SET name = $2, description = $3, audience_id = $4, rules = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, name.trim(), description ?? null, audienceId ?? null, rules],
    );
    if (!rows[0]) throw notFound('Segment not found');
    return rows[0];
  }
  const { rows } = await query(
    'INSERT INTO mkt_segments (name, description, audience_id, rules, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [name.trim(), description ?? null, audienceId ?? null, rules, actor.id],
  );
  return rows[0];
}
