/**
 * Who gets a new lead.
 *
 * Administrators keep an ordered list of rules. The first enabled rule whose
 * conditions match the lead and which has an eligible person decides; each
 * rule says how to choose among its people (round robin, least loaded, a
 * specific person, the account's owner, or by specialization). People who are
 * inactive, on leave or at capacity are skipped, and every skip is explained.
 * Nobody eligible: the fallback owner, else the lead stays unassigned and the
 * people who can assign are told.
 *
 * Safe under concurrency and retries: the lead row is locked while it is
 * assigned, a lead that already has an owner keeps it, and round robin takes a
 * row lock on its cursor so two leads arriving together go to two people.
 */
import { query } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { notify } from '../activity.js';
import { statusOn } from '../availability.js';
import { OPEN_LEAD_STATUSES, emitEvent, localDate, salesSettings } from './core.js';

export const STRATEGIES = ['ROUND_ROBIN', 'LEAST_LOADED', 'SPECIFIC_USER', 'ACCOUNT_OWNER', 'SPECIALIZATION'];

const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

/** Whether a rule's conditions hold for a lead; returns [matches, why-not]. */
export function ruleMatches(rule, lead, { score = null } = {}) {
  const c = rule.conditions || {};
  const fail = (why) => [false, why];
  if (arr(c.categories).length && !arr(c.categories).includes(lead.category)) return fail('category does not match');
  if (arr(c.source_ids).length && !arr(c.source_ids).map(Number).includes(Number(lead.source_id))) return fail('source does not match');
  if (arr(c.campaign_ids).length && !arr(c.campaign_ids).map(Number).includes(Number(lead.campaign_id))) return fail('campaign does not match');
  if (arr(c.states).length && !arr(c.states).map((s) => s.toLowerCase()).includes(String(lead.state || '').toLowerCase())) return fail('state does not match');
  if (arr(c.tags).length && !arr(c.tags).some((t) => (lead.tags || []).includes(t))) return fail('no matching tag');
  if (c.min_score !== undefined && c.min_score !== null && c.min_score !== '' && (score ?? -1) < Number(c.min_score)) return fail('score below the minimum');
  if (c.priority && arr(c.priority).length && !arr(c.priority).includes(lead.priority)) return fail('priority does not match');
  return [true, null];
}

/** Everything the engine needs to know about the people it might choose. */
async function candidatePool(runner, userIds, { departmentId = null } = {}) {
  const params = [];
  let where;
  if (userIds.length) { params.push(userIds); where = 'u.id = ANY($1::int[])'; } else if (departmentId) { params.push(departmentId); where = 'u.department_id = $1'; } else return [];
  const { rows } = await runner.query(
    `SELECT u.id, u.full_name, u.is_active, u.role, u.department_id,
            p.accepts_new_leads, p.max_open_leads, p.categories, p.states, p.specializations,
            (SELECT COUNT(*)::int FROM crm_leads l
              WHERE l.owner_user_id = u.id AND l.is_archived = FALSE AND l.destination = 'TASKFLOW'
                AND l.status = ANY($${params.length + 1}::text[])) AS open_leads
       FROM users u LEFT JOIN crm_agent_profiles p ON p.user_id = u.id
      WHERE ${where} AND u.role <> 'viewer'
      ORDER BY u.id`,
    [...params, OPEN_LEAD_STATUSES],
  );
  return rows;
}

/** Splits candidates into eligible and skipped (with the reason for each). */
function screen(candidates, lead, rule, away) {
  const eligible = [];
  const skipped = [];
  for (const c of candidates) {
    if (!c.is_active) { skipped.push({ user_id: c.id, name: c.full_name, why: 'inactive' }); continue; }
    if (c.accepts_new_leads === false) { skipped.push({ user_id: c.id, name: c.full_name, why: 'not taking new leads' }); continue; }
    if (rule.skip_unavailable !== false && away.has(c.id)) { skipped.push({ user_id: c.id, name: c.full_name, why: `away today (${away.get(c.id).status.toLowerCase().replace('_', ' ')})` }); continue; }
    if (rule.respect_capacity !== false && c.max_open_leads && c.open_leads >= c.max_open_leads) {
      skipped.push({ user_id: c.id, name: c.full_name, why: `at capacity (${c.open_leads} of ${c.max_open_leads} open leads)` }); continue;
    }
    if ((c.categories || []).length && !c.categories.includes(lead.category)) { skipped.push({ user_id: c.id, name: c.full_name, why: 'does not take this category' }); continue; }
    eligible.push(c);
  }
  return { eligible, skipped };
}

async function awayToday(userIds) {
  if (!userIds.length) return new Map();
  const today = localDate(new Date(), (await salesSettings()).calendar?.timezone || 'Asia/Kolkata');
  const map = await statusOn(today, userIds);
  // a half day is still a working day
  return new Map([...map].filter(([, e]) => e.status !== 'HALF_DAY'));
}

/**
 * Chooses an owner. With `client` (inside a transaction) round robin advances
 * its cursor; without, it only predicts (the simulator).
 */
export async function chooseOwner(lead, { client = null, account = null } = {}) {
  const runner = client || { query };
  const settings = await salesSettings();
  const explain = { rules: [], decided_by: null };
  const score = lead.score_override ?? lead.score ?? null;

  // a new enquiry from an organization someone already owns goes to them
  if (settings.assignment?.keepAccountOwner !== false && account?.owner_user_id) {
    const pool = await candidatePool(runner, [account.owner_user_id]);
    const away = await awayToday(pool.map((p) => p.id));
    const { eligible, skipped } = screen(pool, lead, { respect_capacity: false }, away);
    if (eligible[0]) {
      explain.decided_by = { kind: 'ACCOUNT_OWNER', why: `${eligible[0].full_name} already owns ${account.name}` };
      return { userId: eligible[0].id, ruleId: null, method: 'AUTO', explain };
    }
    explain.account_owner_skipped = skipped;
  }

  const { rows: rules } = await runner.query(
    'SELECT * FROM crm_assignment_rules WHERE is_enabled = TRUE ORDER BY priority, id',
  );
  for (const rule of rules) {
    const [matches, whyNot] = ruleMatches(rule, lead, { score });
    if (!matches) { explain.rules.push({ rule_id: rule.id, name: rule.name, matched: false, why: whyNot }); continue; }
    let pool = await candidatePool(runner, rule.user_ids || [], { departmentId: rule.department_id });
    if (rule.strategy === 'ACCOUNT_OWNER') pool = account?.owner_user_id ? pool.filter((p) => p.id === account.owner_user_id) : [];
    const away = await awayToday(pool.map((p) => p.id));
    const { eligible, skipped } = screen(pool, lead, rule, away);
    if (!eligible.length) {
      explain.rules.push({ rule_id: rule.id, name: rule.name, matched: true, chosen: null, skipped, why: pool.length ? 'nobody eligible' : 'no people on this rule' });
      continue;
    }
    let chosen;
    let why;
    if (rule.strategy === 'SPECIFIC_USER' || rule.strategy === 'ACCOUNT_OWNER') {
      [chosen] = eligible;
      why = rule.strategy === 'ACCOUNT_OWNER' ? 'the account owner' : 'the first eligible person on the rule';
    } else if (rule.strategy === 'SPECIALIZATION') {
      const fits = eligible.filter((c) => ((c.states || []).length && (c.states || []).map((s) => s.toLowerCase()).includes(String(lead.state || '').toLowerCase()))
        || (c.specializations || []).some((s) => (lead.tags || []).includes(s) || String(lead.requirement || lead.enquiry || '').toLowerCase().includes(String(s).toLowerCase())));
      const from = fits.length ? fits : eligible;
      chosen = [...from].sort((a, b) => a.open_leads - b.open_leads || a.id - b.id)[0];
      why = fits.length ? 'their region or specialization matches, and they have the fewest open leads among those' : 'no specialization matched; fewest open leads';
    } else {
      // round robin and least loaded both rotate through a cursor, so ties move on
      let cur;
      if (client) {
        await client.query('INSERT INTO crm_assignment_cursor (rule_id) VALUES ($1) ON CONFLICT (rule_id) DO NOTHING', [rule.id]);
        ({ rows: cur } = await client.query('SELECT last_user_id, assigned FROM crm_assignment_cursor WHERE rule_id = $1 FOR UPDATE', [rule.id]));
      } else {
        ({ rows: cur } = await query('SELECT last_user_id, assigned FROM crm_assignment_cursor WHERE rule_id = $1', [rule.id]));
      }
      const last = cur[0]?.last_user_id ?? 0;
      const ordered = [...eligible].sort((a, b) => a.id - b.id);
      if (rule.strategy === 'LEAST_LOADED') {
        const min = Math.min(...ordered.map((c) => c.open_leads));
        const lightest = ordered.filter((c) => c.open_leads === min);
        chosen = lightest.find((c) => c.id > last) || lightest[0];
        why = `fewest open leads (${min})`;
      } else {
        chosen = ordered.find((c) => c.id > last) || ordered[0];
        why = 'next in turn';
      }
      if (client) {
        await client.query(
          'UPDATE crm_assignment_cursor SET last_user_id = $2, assigned = assigned + 1, updated_at = now() WHERE rule_id = $1',
          [rule.id, chosen.id],
        );
      }
    }
    explain.rules.push({ rule_id: rule.id, name: rule.name, matched: true, chosen: { user_id: chosen.id, name: chosen.full_name }, skipped, why });
    explain.decided_by = { kind: 'RULE', rule_id: rule.id, name: rule.name, strategy: rule.strategy, why: `${chosen.full_name}: ${why}` };
    return { userId: chosen.id, ruleId: rule.id, method: 'AUTO', explain };
  }

  const fallback = Number(settings.assignment?.fallbackUserId) || null;
  if (fallback) {
    const pool = await candidatePool(runner, [fallback]);
    if (pool[0]?.is_active) {
      explain.decided_by = { kind: 'FALLBACK', why: `No rule placed it; ${pool[0].full_name} is the fallback owner` };
      return { userId: fallback, ruleId: null, method: 'FALLBACK', explain };
    }
  }
  explain.decided_by = { kind: 'NONE', why: rules.length ? 'No rule had an eligible person and there is no fallback owner' : 'There are no assignment rules and no fallback owner' };
  return { userId: null, ruleId: null, method: 'AUTO', explain };
}

/** Records an assignment (or reassignment) and tells the new owner. */
export async function recordAssignment(client, {
  entityType = 'LEAD', entityId, fromUserId = null, toUserId, ruleId = null, method, reason = null, explain = {}, actorId = null,
  title = null, leadId = null, accountId = null,
}) {
  await client.query(
    `INSERT INTO crm_assignments (entity_type, entity_id, from_user_id, to_user_id, rule_id, method, reason, explain, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entityType, entityId, fromUserId, toUserId, ruleId, method, reason, JSON.stringify(explain || {}), actorId],
  );
  if (toUserId && toUserId !== actorId) {
    await notify(client, {
      userId: toUserId, type: 'crm_lead_assigned', title: title || 'A lead was assigned to you',
      body: reason || explain?.decided_by?.why || null, leadId, accountId,
    });
  }
}

/**
 * Assigns an eligible lead that has no owner. A lead that already has one
 * keeps it — retries and duplicate submissions do not move it.
 */
export async function autoAssignLead(client, leadId, { actor = null, origin = 'USER', depth = 0 } = {}) {
  const { rows } = await client.query('SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE', [leadId]);
  const lead = rows[0];
  if (!lead || lead.owner_user_id || lead.destination !== 'TASKFLOW' || lead.is_archived) {
    return { userId: lead?.owner_user_id ?? null, unchanged: true };
  }
  const settings = await salesSettings();
  if (settings.assignment?.enabled === false) return { userId: null, unchanged: true, disabled: true };
  let account = null;
  if (lead.account_id) account = (await client.query('SELECT id, name, owner_user_id FROM accounts WHERE id = $1', [lead.account_id])).rows[0] || null;
  const choice = await chooseOwner(lead, { client, account });
  if (!choice.userId) {
    await client.query(
      `INSERT INTO crm_lead_activities (lead_id, type, direction, subject, body, meta) VALUES ($1,'ASSIGNMENT','INTERNAL',$2,$3,$4)`,
      [leadId, 'Not assigned', choice.explain.decided_by.why, { explain: choice.explain }],
    );
    // the people who can assign hear about it once
    const { rows: assigners } = await client.query(
      `SELECT id FROM users WHERE is_active = TRUE AND (role = 'admin' OR (role = 'manager' AND NOT ('crm.assign' = ANY(revoked_permissions)))
          OR 'crm.assign' = ANY(extra_permissions))`,
    );
    for (const a of assigners) {
      await notify(client, { userId: a.id, type: 'crm_lead_unassigned', title: `Unassigned lead: ${lead.organization_name || lead.contact_name || lead.ref}`, body: choice.explain.decided_by.why, leadId });
    }
    return { userId: null, explain: choice.explain };
  }
  const { rows: owner } = await client.query('SELECT department_id, full_name FROM users WHERE id = $1', [choice.userId]);
  await client.query(
    `UPDATE crm_leads SET owner_user_id = $2, assigned_at = now(), assignment_rule_id = $3,
            department_id = COALESCE(department_id, $4), updated_at = now()
      WHERE id = $1`,
    [leadId, choice.userId, choice.ruleId, owner[0]?.department_id ?? null],
  );
  await recordAssignment(client, {
    entityId: leadId, toUserId: choice.userId, ruleId: choice.ruleId, method: choice.method,
    reason: choice.explain.decided_by?.why, explain: choice.explain, actorId: actor?.id ?? null,
    title: `New lead for you: ${lead.organization_name || lead.contact_name || lead.ref}`, leadId,
  });
  await client.query(
    `INSERT INTO crm_lead_activities (lead_id, type, direction, subject, body, actor_id, meta) VALUES ($1,'ASSIGNMENT','INTERNAL',$2,$3,$4,$5)`,
    [leadId, `Assigned to ${owner[0]?.full_name}`, choice.explain.decided_by?.why, actor?.id ?? null, { explain: choice.explain }],
  );
  await emitEvent(client, { type: 'lead.assigned', entityType: 'LEAD', entityId: leadId, origin, depth, actorId: actor?.id ?? null, payload: { owner_user_id: choice.userId } });
  return { userId: choice.userId, explain: choice.explain };
}

/** A person moves a lead to someone else, with a reason; the history keeps both. */
export async function reassignLead(client, leadId, { toUserId, reason = null, actor, method = 'MANUAL', origin = 'USER', depth = 0 }) {
  const { rows } = await client.query('SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE', [leadId]);
  const lead = rows[0];
  if (!lead) return null;
  if (lead.owner_user_id === toUserId) return lead;
  const { rows: users } = await client.query('SELECT id, full_name, is_active, department_id FROM users WHERE id = $1', [toUserId]);
  if (!users[0]?.is_active) throw badRequest('Choose an active person');
  await client.query(
    `UPDATE crm_leads SET owner_user_id = $2, assigned_at = now(), assignment_rule_id = NULL,
            department_id = COALESCE($3, department_id), updated_at = now(), updated_by = $4
      WHERE id = $1`,
    [leadId, toUserId, users[0].department_id, actor?.id ?? null],
  );
  await recordAssignment(client, {
    entityId: leadId, fromUserId: lead.owner_user_id, toUserId, method, reason, actorId: actor?.id ?? null,
    title: `${lead.organization_name || lead.contact_name || lead.ref} is now yours`, leadId,
  });
  await client.query(
    `INSERT INTO crm_ownership_history (entity_type, entity_id, from_user_id, to_user_id, reason, changed_by)
     VALUES ('LEAD', $1, $2, $3, $4, $5)`,
    [leadId, lead.owner_user_id, toUserId, reason, actor?.id ?? null],
  );
  await client.query(
    `INSERT INTO crm_lead_activities (lead_id, type, direction, subject, body, actor_id) VALUES ($1,'ASSIGNMENT','INTERNAL',$2,$3,$4)`,
    [leadId, `Reassigned to ${users[0].full_name}`, reason, actor?.id ?? null],
  );
  // pending follow-ups move with the lead: whoever owns it owes them
  await client.query(
    `UPDATE tasks SET assignee_id = $2, updated_at = now()
      WHERE crm_lead_id = $1 AND followup_kind IS NOT NULL AND completed_at IS NULL AND is_archived = FALSE
        AND assignee_id IS NOT DISTINCT FROM $3`,
    [leadId, toUserId, lead.owner_user_id],
  );
  await emitEvent(client, { type: 'lead.reassigned', entityType: 'LEAD', entityId: leadId, origin, depth, actorId: actor?.id ?? null, payload: { from: lead.owner_user_id, to: toUserId } });
  return { ...lead, owner_user_id: toUserId };
}

/** When someone leaves: their open leads go to one person, each recorded. */
export async function reassignAllFrom(client, fromUserId, toUserId, { actor, reason }) {
  const { rows } = await client.query(
    `SELECT id FROM crm_leads WHERE owner_user_id = $1 AND is_archived = FALSE AND status = ANY($2::text[])`,
    [fromUserId, OPEN_LEAD_STATUSES],
  );
  for (const r of rows) await reassignLead(client, r.id, { toUserId, reason, actor, method: 'LEAVER' });
  return rows.length;
}
