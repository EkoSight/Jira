/**
 * The audit trail: who changed a deal's stage, value, owner or status, from
 * what, to what, when, and why — across the whole pipeline.
 *
 * It reads three append-only records: each deal's change history, the record
 * of who has led each organization, and events the deal history does not hold
 * (an organization archived, an investor summary exported, two organizations
 * confirmed as different). None of them can be edited or removed; the database
 * refuses it.
 */

import { query } from '../db/pool.js';

/** The kinds of change people ask about, and the history fields behind each. */
export const AUDIT_GROUPS = {
  stage: { label: 'Stage', fields: ['stage'] },
  status: { label: 'Status', fields: ['status', 'archived', 'waiting'] },
  owner: { label: 'Owner and handovers', fields: ['owner_user_id', 'next_step_owner_id', 'escalation_owner_id', 'account_owner'] },
  value: {
    label: 'Value',
    fields: ['estimated_value', 'proposed_value', 'agreed_value', 'collected_value', 'value_unknown', 'currency',
      'probability', 'financial_status'],
  },
  close_date: { label: 'Close date', fields: ['expected_close'] },
  next_action: { label: 'Next action', fields: ['next_step', 'next_step_due'] },
  escalation: { label: 'Escalations', fields: ['escalated_to_user_id'] },
  other: { label: 'Other events', fields: ['account_archived', 'duplicate_dismissed', 'investor_summary_exported'] },
};

const FIELD_LABEL = {
  stage: 'Stage', status: 'Status', archived: 'Archived', waiting: 'Waiting',
  owner_user_id: 'Deal owner', next_step_owner_id: 'Next action owner', escalation_owner_id: 'Escalation point',
  account_owner: 'Organization lead', estimated_value: 'Estimated value', proposed_value: 'Proposed value',
  agreed_value: 'Agreed value', collected_value: 'Collected (typed)', value_unknown: 'Value not known',
  currency: 'Currency', probability: 'Probability', financial_status: 'Money status',
  expected_close: 'Expected close', next_step: 'Next action', next_step_due: 'Next action date',
  escalated_to_user_id: 'Escalated to', created: 'Created', name: 'Name',
  account_archived: 'Organization archived', duplicate_dismissed: 'Not a duplicate',
  investor_summary_exported: 'Investor summary exported',
};

// a change to one of these that replaced an existing value should say why
const NEEDS_REASON = new Set(['owner_user_id', 'account_owner', 'estimated_value', 'proposed_value', 'agreed_value',
  'expected_close', 'status', 'archived']);
const PERSON_FIELDS = new Set(['owner_user_id', 'next_step_owner_id', 'escalation_owner_id', 'account_owner',
  'escalated_to_user_id']);

const groupOf = (field) => Object.entries(AUDIT_GROUPS).find(([, g]) => g.fields.includes(field))?.[0] || 'other';

/**
 * The trail, newest first. Filters: `group` (a key of AUDIT_GROUPS), `actorId`,
 * `accountId`, `opportunityId`, `from` / `to` (dates, India time), `search`.
 */
export async function auditLog({
  group = null, actorId = null, accountId = null, opportunityId = null, from = null, to = null,
  search = null, departmentId = null, limit = 200, offset = 0,
} = {}) {
  const params = [];
  const push = (value) => { params.push(value); return `$${params.length}`; };
  const fields = group && AUDIT_GROUPS[group] ? AUDIT_GROUPS[group].fields : null;

  const filters = [];
  if (fields) filters.push(`e.field = ANY(${push(fields)}::text[])`);
  if (actorId) filters.push(`e.actor_id = ${push(Number(actorId))}`);
  if (accountId) filters.push(`e.account_id = ${push(Number(accountId))}`);
  if (opportunityId) filters.push(`e.opportunity_id = ${push(Number(opportunityId))}`);
  if (departmentId) filters.push(`e.department_id = ${push(Number(departmentId))}`);
  if (from) filters.push(`e.at >= ${push(`${from}T00:00:00+05:30`)}::timestamptz`);
  if (to) filters.push(`e.at < (${push(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`);
  if (search) {
    const term = push(`%${search}%`);
    filters.push(`(e.opportunity_name ILIKE ${term} OR e.account_name ILIKE ${term} OR e.reason ILIKE ${term})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const page = Math.min(Number(limit) || 200, 1000);

  const trail = `
    SELECT 'deal' AS source, h.id, h.created_at AS at, h.field, h.from_value, h.to_value, h.reason,
           h.is_reversal, h.evidence_missing, h.actor_id, o.id AS opportunity_id, o.name AS opportunity_name,
           a.id AS account_id, a.name AS account_name, a.department_id
      FROM opportunity_history h
      JOIN opportunities o ON o.id = h.opportunity_id
      JOIN accounts a ON a.id = o.account_id
    UNION ALL
    SELECT 'organization', c.id, c.changed_at, 'account_owner', c.from_user_id::text, c.to_user_id::text, c.reason,
           FALSE, NULL, c.changed_by, NULL, NULL, a.id, a.name, a.department_id
      FROM crm_ownership_history c
      JOIN accounts a ON c.entity_type = 'ACCOUNT' AND a.id = c.entity_id
    UNION ALL
    SELECT 'event', v.id, v.created_at, v.action, NULL, v.summary, v.reason,
           FALSE, NULL, v.actor_id,
           CASE WHEN v.entity_type = 'OPPORTUNITY' THEN v.entity_id END, NULL,
           CASE WHEN v.entity_type = 'ACCOUNT' THEN v.entity_id END, a.name, a.department_id
      FROM crm_audit_events v
      LEFT JOIN accounts a ON v.entity_type = 'ACCOUNT' AND a.id = v.entity_id`;

  const [{ rows }, { rows: counted }, { rows: people }] = await Promise.all([
    query(
      `SELECT e.*, u.full_name AS actor_name FROM (${trail}) e
         LEFT JOIN users u ON u.id = e.actor_id
         ${where}
        ORDER BY e.at DESC, e.id DESC
        LIMIT ${page} OFFSET ${Math.max(0, Number(offset) || 0)}`,
      params,
    ),
    query(`SELECT e.field, COUNT(*)::int AS n,
                  COUNT(*) FILTER (WHERE NULLIF(TRIM(e.reason), '') IS NULL)::int AS no_reason
             FROM (${trail}) e ${where} GROUP BY e.field`, params),
    query('SELECT id, full_name FROM users'),
  ]);

  const nameOf = new Map(people.map((p) => [String(p.id), p.full_name]));
  const shown = (field, value) => {
    if (value === null || value === undefined) return null;
    return PERSON_FIELDS.has(field) ? nameOf.get(String(value)) || `#${value}` : value;
  };

  const entries = rows.map((row) => ({
    id: `${row.source}-${row.id}`,
    at: row.at,
    group: groupOf(row.field),
    field: row.field,
    what: FIELD_LABEL[row.field] || row.field.replaceAll('_', ' '),
    from: shown(row.field, row.from_value),
    to: shown(row.field, row.to_value),
    reason: row.reason || null,
    actor_id: row.actor_id,
    actor_name: row.actor_name || (row.actor_id ? null : 'TaskFlow'),
    account_id: row.account_id,
    account_name: row.account_name,
    opportunity_id: row.opportunity_id,
    opportunity_name: row.opportunity_name,
    moved_back: Boolean(row.is_reversal),
    without_evidence: row.evidence_missing || null,
    // a change that replaced something somebody relied on, with no reason given
    // (the rules ask for one now; older entries may not have it)
    no_reason: NEEDS_REASON.has(row.field) && row.from_value !== null && !String(row.reason || '').trim(),
  }));

  const byGroup = {};
  for (const row of counted) {
    const key = groupOf(row.field);
    byGroup[key] = byGroup[key] || { changes: 0, no_reason: 0 };
    byGroup[key].changes += row.n;
    if (NEEDS_REASON.has(row.field)) byGroup[key].no_reason += row.no_reason;
  }
  return {
    entries,
    groups: Object.fromEntries(Object.entries(AUDIT_GROUPS).map(([key, g]) => [key, { label: g.label, ...(byGroup[key] || { changes: 0, no_reason: 0 }) }])),
    total: counted.reduce((t, r) => t + r.n, 0),
    limit: page,
    offset: Math.max(0, Number(offset) || 0),
  };
}

/** Records an event the deal history does not hold. */
export async function recordAuditEvent(client, { action, entityType = null, entityId = null, summary = null, detail = {}, reason = null, actorId = null }) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO crm_audit_events (action, entity_type, entity_id, summary, detail, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [action, entityType, entityId, summary, JSON.stringify(detail || {}), reason, actorId],
  );
}

/** The trail as spreadsheet rows. */
export function auditRows(entries) {
  return entries.map((e) => [
    new Date(e.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    e.actor_name || '',
    e.account_name || '',
    e.opportunity_name || '',
    e.what,
    e.from ?? '',
    e.to ?? '',
    e.reason || '',
    [e.moved_back && 'moved back', e.without_evidence && `without evidence: ${e.without_evidence.join(', ')}`,
      e.no_reason && 'no reason given'].filter(Boolean).join('; '),
  ]);
}

export const AUDIT_HEADER = ['When (India time)', 'Who', 'Organization', 'Deal', 'What changed', 'From', 'To', 'Why', 'Notes'];
