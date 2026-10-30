/**
 * Merging duplicates: organizations, contacts and leads.
 *
 * Never automatic. A person sees why two records look alike and exactly what
 * would move, chooses which values the surviving record keeps, and confirms.
 * Everything that pointed at the merged record — deals, contacts, activities,
 * tasks, meetings, files, calls, messages — then points at the survivor; the
 * merged record is archived (not removed) with a pointer to the survivor, and
 * the merge is written to an append-only log. A blank never overwrites a value.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { recordAuditEvent } from '../audit.js';
import { refreshPrimaryOpportunity, syncAccountMirror } from '../opportunities.js';
import { companyDomain, normalizeEmail, normalizePhone } from './core.js';

const TABLE = { ACCOUNT: 'accounts', CONTACT: 'account_contacts', LEAD: 'crm_leads' };

const ACCOUNT_FIELDS = ['name', 'website', 'domain', 'linkedin_url', 'hq_address', 'state', 'city', 'pincode', 'country', 'industry',
  'segment_id', 'org_type', 'owner_user_id', 'follower_user_id', 'department_id', 'description', 'relationship_summary',
  'why_it_matters', 'relationship_potential', 'logo_url', 'banner_url', 'lead_category'];
const ACCOUNT_ARRAYS = ['tags', 'operating_regions', 'crops', 'org_roles'];
const CONTACT_FIELDS = ['full_name', 'designation', 'department', 'email', 'phone', 'whatsapp', 'linkedin_url', 'location', 'preferred_channel', 'influence', 'notes'];
const CONTACT_ARRAYS = ['decision_roles'];
const LEAD_FIELDS = ['organization_name', 'contact_name', 'designation', 'email', 'phone', 'website', 'city', 'state', 'country', 'enquiry',
  'requirement', 'budget_amount', 'timeline', 'decision_maker_engaged', 'need_clarity', 'fit', 'owner_user_id', 'priority'];
const LEAD_ARRAYS = ['tags'];

const FIELDS = { ACCOUNT: [ACCOUNT_FIELDS, ACCOUNT_ARRAYS], CONTACT: [CONTACT_FIELDS, CONTACT_ARRAYS], LEAD: [LEAD_FIELDS, LEAD_ARRAYS] };

/** Every (table, column) with a foreign key to `table`, except append-only logs and the table itself. */
async function referencing(runner, table) {
  const { rows } = await runner.query(
    `SELECT DISTINCT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema() AND ccu.table_name = $1 AND ccu.column_name = 'id'
        AND kcu.table_name NOT IN (SELECT event_object_table FROM information_schema.triggers
                                    WHERE trigger_schema = current_schema() AND trigger_name LIKE '%append_only')`,
    [table],
  );
  return rows.filter((r) => r.table_name !== table);
}

/** What would move, per table, if `mergedId` were merged into `survivorId`. */
async function movable(runner, entity, mergedId) {
  const refs = await referencing(runner, TABLE[entity]);
  const out = [];
  for (const r of refs) {
    const { rows } = await runner.query(`SELECT COUNT(*)::int AS n FROM ${r.table_name} WHERE ${r.column_name} = $1`, [mergedId]);
    if (rows[0].n) out.push({ table: r.table_name, column: r.column_name, rows: rows[0].n });
  }
  return out;
}

/** Why two records look like the same one. */
function reasonsFor(entity, a, b) {
  const reasons = [];
  if (entity === 'ACCOUNT') {
    if (a.name && b.name && a.name.trim().toLowerCase() === b.name.trim().toLowerCase()) reasons.push('Same name');
    const da = a.domain || companyDomain(a.website);
    const db = b.domain || companyDomain(b.website);
    if (da && da === db) reasons.push(`Same website domain (${da})`);
    if (normalizePhone(a.contact_phone) && normalizePhone(a.contact_phone) === normalizePhone(b.contact_phone)) reasons.push('Same phone');
  } else {
    if (normalizeEmail(a.email) && normalizeEmail(a.email) === normalizeEmail(b.email)) reasons.push('Same email');
    if (normalizePhone(a.phone) && normalizePhone(a.phone) === normalizePhone(b.phone)) reasons.push('Same phone');
    const na = a.full_name || a.contact_name;
    const nb = b.full_name || b.contact_name;
    if (na && nb && na.trim().toLowerCase() === nb.trim().toLowerCase()) reasons.push('Same name');
    if (entity === 'LEAD' && a.organization_name && b.organization_name && a.organization_name.trim().toLowerCase() === b.organization_name.trim().toLowerCase()) reasons.push('Same organization');
  }
  return reasons;
}

async function load(runner, entity, id) {
  const { rows } = await runner.query(`SELECT * FROM ${TABLE[entity]} WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** The merge, before it happens: reasons, field-by-field values, what moves. */
export async function previewMerge(entity, survivorId, mergedId) {
  if (!TABLE[entity]) throw badRequest('Unknown record type');
  if (Number(survivorId) === Number(mergedId)) throw badRequest('Choose two different records');
  const [a, b] = await Promise.all([load({ query }, entity, survivorId), load({ query }, entity, mergedId)]);
  if (!a || !b) throw notFound('Record not found');
  if (a.merged_into_id || b.merged_into_id) throw conflict('One of these was already merged');
  const [fields, arrays] = FIELDS[entity];
  const comparison = fields.map((f) => ({
    field: f, survivor: a[f] ?? null, merged: b[f] ?? null,
    differs: (a[f] ?? null) !== null && (b[f] ?? null) !== null && String(a[f]) !== String(b[f]),
    fills_blank: (a[f] === null || a[f] === undefined || a[f] === '') && b[f] !== null && b[f] !== undefined && b[f] !== '',
  }));
  const warnings = [];
  if (entity === 'LEAD' && b.status === 'CONVERTED') warnings.push('The record to merge away is converted: keep it as the survivor instead.');
  if (entity === 'CONTACT' && a.account_id !== b.account_id) warnings.push('These contacts are at different organizations; the survivor keeps its own organization.');
  if (entity === 'ACCOUNT' && a.lead_category && b.lead_category && a.lead_category !== b.lead_category) warnings.push(`Their categories differ (${a.lead_category} / ${b.lead_category}); the survivor's is kept unless you choose otherwise.`);
  return {
    entity, survivor: a, merged: b, reasons: reasonsFor(entity, a, b), comparison, arrays,
    moves: await movable({ query }, entity, mergedId), warnings,
  };
}

/**
 * Merges `mergedId` into `survivorId`. `choices` maps a field to 'merged' to
 * take the merged record's value (only when it has one).
 */
export async function mergeRecords(entity, survivorId, mergedId, { choices = {}, actor, reason = null }) {
  if (!TABLE[entity]) throw badRequest('Unknown record type');
  if (Number(survivorId) === Number(mergedId)) throw badRequest('Choose two different records');
  return withTransaction(async (client) => {
    const ids = [Number(survivorId), Number(mergedId)].sort((x, y) => x - y);
    await client.query(`SELECT id FROM ${TABLE[entity]} WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]);
    const a = await load(client, entity, survivorId);
    const b = await load(client, entity, mergedId);
    if (!a || !b) throw notFound('Record not found');
    if (a.merged_into_id || b.merged_into_id) throw conflict('One of these was already merged');
    if (entity === 'LEAD' && b.status === 'CONVERTED') throw conflict('Keep the converted lead as the survivor');

    // the survivor's values, filled or replaced only where the person chose and the merged record has a value
    const [fields, arrays] = FIELDS[entity];
    const sets = [];
    const params = [survivorId];
    const push = (v) => { params.push(v); return `$${params.length}`; };
    const taken = {};
    for (const f of fields) {
      const has = b[f] !== null && b[f] !== undefined && b[f] !== '';
      const blank = a[f] === null || a[f] === undefined || a[f] === '';
      if (has && (choices[f] === 'merged' || blank)) { sets.push(`${f} = ${push(b[f])}`); taken[f] = b[f]; }
    }
    for (const f of arrays) {
      const union = [...new Set([...(a[f] || []), ...(b[f] || [])])];
      if (union.length !== (a[f] || []).length) { sets.push(`${f} = ${push(union)}`); taken[f] = union; }
    }
    if (entity === 'CONTACT') {
      if (taken.email !== undefined) sets.push(`email_normalized = ${push(normalizeEmail(taken.email))}`);
      if (taken.phone !== undefined) sets.push(`phone_normalized = ${push(normalizePhone(taken.phone))}`);
    }
    if (entity === 'LEAD') {
      if (taken.email !== undefined) sets.push(`email_normalized = ${push(normalizeEmail(taken.email))}`);
      if (taken.phone !== undefined) sets.push(`phone_normalized = ${push(normalizePhone(taken.phone))}`);
      // the original attribution is the earliest capture's, whichever survives
      if (new Date(b.captured_at) < new Date(a.captured_at)) {
        sets.push(`original_source_id = ${push(b.original_source_id ?? a.original_source_id)}`,
          `original_campaign_id = ${push(b.original_campaign_id ?? a.original_campaign_id)}`, `captured_at = ${push(b.captured_at)}`);
      }
    }
    if (sets.length) await client.query(`UPDATE ${TABLE[entity]} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);

    // everything pointing at the merged record moves; a row that would clash
    // with one the survivor already has (the same person on the same deal) stays
    const refs = await referencing(client, TABLE[entity]);
    const moved = {};
    const kept = {};
    for (const r of refs) {
      const { rows } = await client.query(`SELECT ctid::text AS ctid FROM ${r.table_name} WHERE ${r.column_name} = $1`, [mergedId]);
      for (const row of rows) {
        await client.query('SAVEPOINT merge_row');
        try {
          await client.query(`UPDATE ${r.table_name} SET ${r.column_name} = $1 WHERE ctid = $2::tid`, [survivorId, row.ctid]);
          await client.query('RELEASE SAVEPOINT merge_row');
          moved[`${r.table_name}.${r.column_name}`] = (moved[`${r.table_name}.${r.column_name}`] || 0) + 1;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT merge_row');
          if (err.code !== '23505') throw err;
          kept[`${r.table_name}.${r.column_name}`] = (kept[`${r.table_name}.${r.column_name}`] || 0) + 1;
        }
      }
    }

    // the merged record is kept, archived, pointing at the survivor
    if (entity === 'ACCOUNT') {
      await client.query(
        `UPDATE accounts SET merged_into_id = $2, is_archived = TRUE, archived_at = now(), archived_by = $3,
                archive_reason = $4, primary_opportunity_id = NULL, updated_at = now()
          WHERE id = $1`,
        [mergedId, survivorId, actor.id, `Merged into ${a.name}`],
      );
      await refreshPrimaryOpportunity(client, survivorId);
      await syncAccountMirror(client, survivorId);
      await client.query(
        `INSERT INTO account_activities (account_id, type, actor_id, subject, body, direction, outcome, is_external, source)
         VALUES ($1,'MERGE',$2,$3,$4,'INTERNAL','NOTED',FALSE,'SYSTEM')`,
        [survivorId, actor.id, `Merged ${b.name} into this organization`, reason],
      );
    } else if (entity === 'CONTACT') {
      await client.query(`UPDATE account_contacts SET merged_into_id = $2, is_active = FALSE, is_primary = FALSE, updated_at = now() WHERE id = $1`, [mergedId, survivorId]);
    } else {
      await client.query(
        `UPDATE crm_leads SET merged_into_id = $2, is_archived = TRUE, archived_at = now(), archived_by = $3, archive_reason = $4, updated_at = now()
          WHERE id = $1`,
        [mergedId, survivorId, actor.id, `Merged into ${a.ref}`],
      );
      await client.query(
        `INSERT INTO crm_lead_activities (lead_id, type, direction, subject, body, actor_id) VALUES ($1,'MERGE','INTERNAL',$2,$3,$4)`,
        [survivorId, `Merged ${b.ref} into this lead`, reason, actor.id],
      );
    }
    const reasons = reasonsFor(entity, a, b);
    await client.query(
      `INSERT INTO crm_merges (entity_type, survivor_id, merged_id, reasons, field_choices, moved, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entity, survivorId, mergedId, JSON.stringify(reasons), JSON.stringify({ choices, taken }), JSON.stringify({ moved, kept }), actor.id],
    );
    await recordAuditEvent(client, {
      action: `${entity}_MERGED`, entityType: entity, entityId: Number(survivorId), actorId: actor.id, reason,
      summary: `${entity.toLowerCase()} ${mergedId} merged into ${survivorId}`, detail: { moved, kept, taken: Object.keys(taken) },
    });
    return { survivorId: Number(survivorId), mergedId: Number(mergedId), moved, kept, taken: Object.keys(taken) };
  });
}
