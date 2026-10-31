/**
 * Sales automation: rules an administrator writes ("when a CSR lead arrives
 * from the website, give it to the CSR team and schedule a call in 2 working
 * hours"), and the time-based checks that keep the pipeline honest (reminders,
 * overdue follow-ups, stale leads and deals, deadlines, payments, renewals).
 *
 * Safety, in order of importance:
 *   - A rule is created switched off and in test mode. In test mode it records
 *     what it would have done and does nothing. Sending messages also needs
 *     the "live sends" setting, which only a person with crm.automation sets.
 *   - Each rule runs at most once per event (a unique run key), so retries,
 *     restarts and two workers cannot double it.
 *   - Events caused by automation carry their depth; past the configured depth
 *     nothing runs, and a rule never reacts to its own output. That stops loops.
 *   - A scheduled run is checked again when it is due: a switched-off rule, a
 *     closed lead or deal, an opt-out or a reply cancels it, with the reason.
 *   - Failures retry with backoff up to three times, then wait for a person.
 *     A retried send reuses its idempotency key, so a message is never sent twice.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { notify } from '../activity.js';
import { expireQuotes } from './quotes.js';
import { sendScheduledReports } from './reports.js';
import { autoAssignLead, reassignLead } from './assignment.js';
import { createFollowUp } from './followups.js';
import { startHandover } from './deals.js';
import { sendWhatsApp } from './comms.js';
import { emitEvent, localDate, salesSettings, workCalendar } from './core.js';

export const TRIGGERS = {
  'lead.captured': 'A lead is captured',
  'lead.assigned': 'A lead is assigned',
  'lead.reassigned': 'A lead is reassigned',
  'lead.converted': 'A lead becomes a deal',
  'lead.stale': 'A lead has had no contact for the stale period',
  'lead.first_response_overdue': 'A new lead has not been contacted in time',
  'lead.call_status_changed': 'A lead\'s calling status changes',
  'followup.overdue': 'A follow-up is overdue past the escalation threshold',
  'opportunity.stage_changed': 'A deal changes stage',
  'opportunity.stale': 'A deal has had no activity for the stale period',
  'opportunity.won': 'A deal is won',
  'opportunity.lost': 'A deal is lost',
  'proposal.deadline_approaching': 'A CSR proposal deadline is within 7 days',
  'proposal.accepted': 'A quotation or proposal is accepted',
  'payment.overdue': 'A scheduled payment is overdue',
  'renewal.approaching': 'A renewal or next cycle is within 30 days',
  'message.received': 'A WhatsApp message is received',
  'call.logged': 'A call is logged',
};

export const ACTIONS = ['assign', 'create_followup', 'notify', 'escalate', 'update_field', 'send_whatsapp_template', 'handover'];
const UPDATABLE = { LEAD: ['priority', 'tags_add'], OPPORTUNITY: ['forecast_category', 'priority'] };
export const CANCEL_ON = ['reply', 'terminal', 'reassigned'];

// ---------------------------------------------------------------- context and conditions

/** What conditions can look at, for a lead or a deal. */
export async function entityContext(entityType, entityId, runner = { query }) {
  if (entityType === 'LEAD') {
    const { rows } = await runner.query(
      `SELECT l.*, s.key AS source_key, c.name AS campaign_name, COALESCE(l.score_override, l.score) AS effective_score,
              u.department_id AS owner_department_id, cs.key AS call_status_key
         FROM crm_leads l LEFT JOIN crm_sources s ON s.id = COALESCE(l.source_id, l.original_source_id)
         LEFT JOIN crm_call_statuses cs ON cs.id = l.call_status_id
         LEFT JOIN crm_campaigns c ON c.id = COALESCE(l.campaign_id, l.original_campaign_id) LEFT JOIN users u ON u.id = l.owner_user_id
        WHERE l.id = $1`, [entityId],
    );
    const l = rows[0];
    if (!l) return null;
    return {
      entity_type: 'LEAD', id: l.id, ref: l.ref, name: l.organization_name || l.contact_name, contact_name: l.contact_name, phone: l.phone,
      category: l.category, destination: l.destination, status: l.status, priority: l.priority, source: l.source_key, campaign: l.campaign_name,
      score: l.effective_score, owner_id: l.owner_user_id, department_id: l.department_id ?? l.owner_department_id, tags: l.tags || [],
      state: l.state, value: l.budget_amount, closed: ['CONVERTED', 'DISQUALIFIED', 'WON'].includes(l.status) || l.is_archived,
      call_status: l.call_status_key, call_attempts: l.call_attempts, rating: l.rating,
      custom: l.custom_fields || {}, lead_id: l.id, account_id: l.account_id, opportunity_id: l.converted_opportunity_id,
    };
  }
  if (entityType === 'OPPORTUNITY') {
    const { rows } = await runner.query(
      `SELECT o.*, a.name AS account_name, a.lead_category, a.department_id, p.key AS pipeline_key, st.slug AS stage_slug, s.key AS source_key,
              (SELECT c.phone FROM opportunity_contacts oc JOIN account_contacts c ON c.id = oc.contact_id
                WHERE oc.opportunity_id = o.id ORDER BY (oc.role = 'PRIMARY') DESC LIMIT 1) AS phone,
              (SELECT c.full_name FROM opportunity_contacts oc JOIN account_contacts c ON c.id = oc.contact_id
                WHERE oc.opportunity_id = o.id ORDER BY (oc.role = 'PRIMARY') DESC LIMIT 1) AS contact_name
         FROM opportunities o JOIN accounts a ON a.id = o.account_id
         LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id LEFT JOIN account_stages st ON st.id = o.stage_id
         LEFT JOIN crm_sources s ON s.id = o.source_id
        WHERE o.id = $1`, [entityId],
    );
    const o = rows[0];
    if (!o) return null;
    return {
      entity_type: 'OPPORTUNITY', id: o.id, name: o.name, account_name: o.account_name, contact_name: o.contact_name, phone: o.phone,
      category: o.lead_category, pipeline: o.pipeline_key, stage: o.stage_slug, status: o.status, source: o.source_key,
      value: o.estimated_value, owner_id: o.owner_user_id, escalation_id: o.escalation_owner_id, department_id: o.department_id,
      closed: ['WON', 'LOST'].includes(o.status) || o.is_archived, custom: o.custom_fields || {}, opportunity_id: o.id, account_id: o.account_id,
      type: o.opportunity_type, forecast_category: o.forecast_category,
    };
  }
  return null;
}

const fieldValue = (ctx, field) => (String(field).startsWith('custom.') ? ctx.custom?.[field.slice(7)] : ctx[field]);

/** One condition: { field, op, value }. */
export function conditionHolds(ctx, { field, op = 'eq', value }) {
  const v = fieldValue(ctx, field);
  const list = Array.isArray(value) ? value.map(String) : [String(value)];
  switch (op) {
    case 'eq': return String(v ?? '') === String(value ?? '');
    case 'neq': return String(v ?? '') !== String(value ?? '');
    case 'in': return Array.isArray(v) ? v.some((x) => list.includes(String(x))) : list.includes(String(v ?? ''));
    case 'nin': return Array.isArray(v) ? !v.some((x) => list.includes(String(x))) : !list.includes(String(v ?? ''));
    case 'gte': return v !== null && v !== undefined && Number(v) >= Number(value);
    case 'lte': return v !== null && v !== undefined && Number(v) <= Number(value);
    case 'contains': return Array.isArray(v) ? v.map(String).includes(String(value)) : String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
    case 'empty': return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    case 'not_empty': return !(v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length));
    default: return false;
  }
}

export function evaluate(ctx, conditions = []) {
  const failed = (conditions || []).filter((c) => !conditionHolds(ctx, c));
  return { ok: failed.length === 0, failed };
}

/** "{{name}}" style placeholders in templates and notification text. */
export const fill = (text, ctx) => String(text ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
  const v = fieldValue(ctx, k);
  return v === null || v === undefined ? '' : String(v);
});

// ---------------------------------------------------------------- validation

export function validateRule(rule) {
  if (!TRIGGERS[rule.trigger]) throw badRequest('Choose a trigger from the list');
  if (!Array.isArray(rule.actions) || !rule.actions.length) throw badRequest('Add at least one action');
  for (const a of rule.actions) {
    if (!ACTIONS.includes(a.type)) throw badRequest(`Unknown action "${a.type}"`);
    if (a.type === 'update_field') {
      const allowed = [...UPDATABLE.LEAD, ...UPDATABLE.OPPORTUNITY];
      if (!allowed.includes(a.field)) throw badRequest(`Automation can change only: ${allowed.join(', ')}`);
    }
    if (a.type === 'send_whatsapp_template' && !a.template_name) throw badRequest('Choose the WhatsApp template to send');
    if (a.type === 'create_followup' && !(Number(a.due_in_hours) >= 0)) throw badRequest('Say when the follow-up is due (hours from the trigger)');
  }
  for (const c of rule.conditions || []) {
    if (!c.field || !['eq', 'neq', 'in', 'nin', 'gte', 'lte', 'contains', 'empty', 'not_empty'].includes(c.op || 'eq')) throw badRequest('A condition needs a field and a valid comparison');
  }
  for (const c of rule.cancel_on || []) if (!CANCEL_ON.includes(c)) throw badRequest(`Unknown cancel condition "${c}"`);
}

// ---------------------------------------------------------------- events into runs

/** Reads new events and schedules the runs they trigger. */
export async function processEvents({ limit = 200 } = {}) {
  const settings = await salesSettings();
  const maxDepth = Number(settings.automation?.maxDepth) || 3;
  const cal = await workCalendar();
  let scheduled = 0;
  await withTransaction(async (client) => {
    const { rows: events } = await client.query(
      'SELECT * FROM crm_events WHERE processed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED', [limit],
    );
    if (!events.length) return;
    const { rows: rules } = await client.query('SELECT * FROM crm_automation_rules WHERE is_enabled = TRUE ORDER BY priority, id');
    for (const ev of events) {
      for (const rule of rules.filter((r) => r.trigger === ev.type)) {
        if (ev.origin === 'AUTOMATION' && (ev.origin_rule_id === rule.id || ev.depth >= maxDepth)) continue;
        if (!['LEAD', 'OPPORTUNITY'].includes(ev.entity_type) && !ev.payload?.lead_id && !ev.payload?.opportunity_id) continue;
        const entityType = ['LEAD', 'OPPORTUNITY'].includes(ev.entity_type) ? ev.entity_type : (ev.payload.lead_id ? 'LEAD' : 'OPPORTUNITY');
        const entityId = ['LEAD', 'OPPORTUNITY'].includes(ev.entity_type) ? ev.entity_id : (ev.payload.lead_id || ev.payload.opportunity_id);
        let runAt = new Date(new Date(ev.created_at).getTime() + rule.delay_minutes * 60_000);
        if (rule.business_hours_only) runAt = rule.delay_minutes ? cal.addWorkingHours(new Date(ev.created_at), rule.delay_minutes / 60) : cal.nextWorking(runAt);
        const { rowCount } = await client.query(
          `INSERT INTO crm_automation_runs (rule_id, event_id, entity_type, entity_id, run_key, run_at, depth)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (run_key) DO NOTHING`,
          [rule.id, ev.id, entityType, entityId, `${rule.id}:${ev.id}`, runAt, ev.depth],
        );
        scheduled += rowCount;
      }
      await client.query('UPDATE crm_events SET processed_at = now() WHERE id = $1', [ev.id]);
    }
  });
  return { scheduled };
}

/** Runs that are due, each in its own transaction. */
export async function runDue({ limit = 50, fetchImpl } = {}) {
  const out = { done: 0, simulated: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (let i = 0; i < limit; i += 1) {
    const r = await runOne({ fetchImpl });
    if (!r) break;
    out[r] = (out[r] || 0) + 1;
  }
  return out;
}

async function runOne({ fetchImpl } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT r.*, ru.name AS rule_name, ru.is_enabled, ru.test_mode, ru.conditions, ru.actions, ru.cancel_on, ru.owner_user_id AS rule_owner
         FROM crm_automation_runs r JOIN crm_automation_rules ru ON ru.id = r.rule_id
        WHERE r.status = 'SCHEDULED' AND r.run_at <= now()
        ORDER BY r.run_at, r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
    );
    const run = rows[0];
    if (!run) return null;
    const finish = async (status, result, extra = {}) => {
      await client.query(
        `UPDATE crm_automation_runs SET status = $2, result = $3, finished_at = now(), cancelled_reason = $4, last_error = $5,
                attempts = attempts + $6, run_at = COALESCE($7, run_at) WHERE id = $1`,
        [run.id, status, JSON.stringify(result ?? []), extra.reason ?? null, extra.error ?? null, extra.attempt ? 1 : 0, extra.runAt ?? null],
      );
      return { DONE: 'done', SIMULATED: 'simulated', FAILED: 'failed', CANCELLED: 'cancelled', SKIPPED: 'skipped', SCHEDULED: 'failed' }[status];
    };
    if (!run.is_enabled) return finish('CANCELLED', [], { reason: 'The rule was switched off before this was due' });
    const ctx = await entityContext(run.entity_type, run.entity_id, client);
    if (!ctx) return finish('CANCELLED', [], { reason: 'The record no longer exists' });
    if (ctx.closed && (run.cancel_on || []).includes('terminal')) return finish('CANCELLED', [], { reason: `The ${run.entity_type.toLowerCase()} is closed` });
    if (run.entity_type === 'LEAD' && ctx.destination !== 'TASKFLOW') return finish('CANCELLED', [], { reason: 'The lead is not in Taskflow’s pipeline (TeleCRM or awaiting classification)' });
    const check = evaluate(ctx, run.conditions);
    if (!check.ok) return finish('SKIPPED', [], { reason: `No longer true: ${check.failed.map((c) => `${c.field} ${c.op || 'eq'} ${JSON.stringify(c.value ?? '')}`).join('; ')}` });

    const settings = await salesSettings();
    const live = !run.test_mode;
    const results = [];
    try {
      for (const [index, action] of (run.actions || []).entries()) {
        results.push(await perform(client, { run, action, index, ctx, live, liveSends: settings.automation?.liveSends === true, fetchImpl }));
      }
    } catch (err) {
      // three tries, a few minutes apart; then it waits for a person
      if (run.attempts + 1 < 3) {
        return finish('SCHEDULED', results, { error: err.message, attempt: true, runAt: new Date(Date.now() + 2 ** (run.attempts + 1) * 60_000) });
      }
      return finish('FAILED', results, { error: err.message, attempt: true });
    }
    return finish(live ? 'DONE' : 'SIMULATED', results);
  });
}

async function recipients(client, ctx, who) {
  if (Array.isArray(who)) return who.map(Number).filter(Boolean);
  if (who === 'owner') return ctx.owner_id ? [ctx.owner_id] : [];
  if (who === 'escalation') return ctx.escalation_id ? [ctx.escalation_id] : await recipients(client, ctx, 'manager');
  if (who === 'manager') {
    const { rows } = await client.query(
      `SELECT DISTINCT u.id FROM users u
        WHERE u.is_active = TRUE AND u.role IN ('manager', 'admin')
          AND (u.department_id = $1 OR EXISTS (SELECT 1 FROM attendance_team_access t WHERE t.manager_id = u.id AND t.department_id = $1))
        ORDER BY u.id`, [ctx.department_id ?? -1],
    );
    return rows.map((r) => r.id);
  }
  if (Number(who)) return [Number(who)];
  return [];
}

/** One action. In test mode it describes itself and changes nothing. */
async function perform(client, { run, action, index, ctx, live, liveSends, fetchImpl }) {
  const label = { type: action.type };
  // what this action causes is marked as this rule's, so the rule never reacts to it
  const origin = { origin: 'AUTOMATION', depth: run.depth + 1, causeRuleId: run.rule_id };
  switch (action.type) {
    case 'assign': {
      if (run.entity_type !== 'LEAD') return { ...label, skipped: 'Only leads are assigned by automation' };
      if (!live) return { ...label, would: action.user_id ? `assign to user ${action.user_id}` : 'assign by the assignment rules' };
      if (action.user_id) {
        if (ctx.owner_id === Number(action.user_id)) return { ...label, unchanged: true };
        await reassignLead(client, run.entity_id, { toUserId: Number(action.user_id), reason: `Automation: ${run.rule_name}`, actor: null, ...origin });
      } else if (!ctx.owner_id) await autoAssignLead(client, run.entity_id, { actor: null, ...origin });
      return { ...label, done: true };
    }
    case 'create_followup': {
      const cal = await workCalendar();
      const due = action.business_hours === false
        ? new Date(Date.now() + Number(action.due_in_hours) * 3600_000)
        : cal.addWorkingHours(new Date(), Number(action.due_in_hours));
      const assignee = (await recipients(client, ctx, action.assignee || 'owner'))[0] ?? null;
      if (!live) return { ...label, would: `a ${String(action.kind || 'CALL').toLowerCase()} due ${due.toISOString()} for user ${assignee ?? '(owner not set)'}` };
      if (!assignee) return { ...label, skipped: 'Nobody to give it to (no owner)' };
      const task = await createFollowUp(client, {
        leadId: ctx.lead_id && run.entity_type === 'LEAD' ? ctx.lead_id : null, accountId: ctx.account_id ?? null,
        opportunityId: run.entity_type === 'OPPORTUNITY' ? run.entity_id : null, kind: action.kind || 'CALL',
        title: fill(action.title || `${action.kind || 'Call'}: {{name}}`, ctx), dueAt: due.toISOString(), assigneeId: assignee,
        priority: action.priority || 'MEDIUM', notes: `Created by automation "${run.rule_name}"`, actor: null, automationRunId: run.id, ...origin,
      });
      return { ...label, task_id: task.id };
    }
    case 'notify':
    case 'escalate': {
      const to = await recipients(client, ctx, action.to || (action.type === 'escalate' ? 'escalation' : 'owner'));
      const title = fill(action.title || (action.type === 'escalate' ? 'Needs attention: {{name}}' : '{{name}}'), ctx);
      if (!live) return { ...label, would: `tell ${to.length} person(s): ${title}` };
      for (const userId of to) {
        await notify(client, { userId, type: action.type === 'escalate' ? 'crm_escalation' : 'crm_automation', title, body: fill(action.body || '', ctx) || null, leadId: run.entity_type === 'LEAD' ? run.entity_id : null, accountId: ctx.account_id ?? null });
      }
      return { ...label, notified: to.length };
    }
    case 'update_field': {
      const allowed = UPDATABLE[run.entity_type] || [];
      if (!allowed.includes(action.field)) return { ...label, skipped: `${action.field} cannot be changed on a ${run.entity_type.toLowerCase()}` };
      if (!live) return { ...label, would: `set ${action.field} to ${action.value}` };
      if (run.entity_type === 'LEAD' && action.field === 'tags_add') {
        await client.query('UPDATE crm_leads SET tags = ARRAY(SELECT DISTINCT unnest(tags || $2::text[])), updated_at = now() WHERE id = $1', [run.entity_id, [String(action.value).slice(0, 40)]]);
      } else if (run.entity_type === 'LEAD' && action.field === 'priority') {
        await client.query('UPDATE crm_leads SET priority = $2, updated_at = now() WHERE id = $1', [run.entity_id, String(action.value)]);
      } else if (run.entity_type === 'OPPORTUNITY' && action.field === 'forecast_category') {
        await client.query('UPDATE opportunities SET forecast_category = $2, updated_at = now() WHERE id = $1', [run.entity_id, String(action.value)]);
      }
      return { ...label, done: true };
    }
    case 'send_whatsapp_template': {
      if (!ctx.phone) return { ...label, skipped: 'No phone number on the record' };
      const vars = (action.variables || []).map((v) => fill(v, ctx));
      if (!live || !liveSends) return { ...label, would: `send "${action.template_name}" to ${ctx.phone}`, held: !liveSends ? 'Live sends are switched off in Settings' : undefined };
      const r = await sendWhatsApp({
        to: ctx.phone, template_name: action.template_name, language: action.language || 'en', variables: vars,
        lead_id: run.entity_type === 'LEAD' ? run.entity_id : null, opportunity_id: run.entity_type === 'OPPORTUNITY' ? run.entity_id : null,
        // the same run and action never send twice, however often it is retried
        idempotency_key: `auto:${run.id}:${index}`,
      }, { automationRunId: run.id, fetchImpl });
      if (r.message?.status === 'FAILED') throw new Error(`WhatsApp: ${r.message.error_title || 'failed'}`);
      return { ...label, message_id: r.message?.id, status: r.message?.status, duplicate: r.duplicate || false, blocked: r.blocked || false };
    }
    case 'handover': {
      if (run.entity_type !== 'OPPORTUNITY' || ctx.status !== 'WON') return { ...label, skipped: 'Only a won deal is handed over' };
      if (!live) return { ...label, would: 'start delivery for the won deal' };
      // recorded as the deal owner's handover, so the delivery tasks have a reporter
      const { rows: owner } = await client.query('SELECT id, department_id, role FROM users WHERE id = $1', [ctx.owner_id ?? run.rule_owner ?? 0]);
      const r = await startHandover(client, { opportunityId: run.entity_id, actor: owner[0] || { id: null, department_id: null }, input: {} });
      return { ...label, engagement_id: r.engagement_id, created: r.created };
    }
    default:
      return { ...label, skipped: 'Unknown action' };
  }
}

/** What a rule would do for one record, with nothing changed. */
export async function previewRule(rule, entityType, entityId) {
  validateRule(rule);
  const ctx = await entityContext(entityType, entityId);
  if (!ctx) throw notFound('Record not found');
  const check = evaluate(ctx, rule.conditions);
  return {
    matches: check.ok,
    failed: check.failed,
    context: { name: ctx.name, category: ctx.category, status: ctx.status, stage: ctx.stage, pipeline: ctx.pipeline, source: ctx.source, owner_id: ctx.owner_id, score: ctx.score },
    actions: rule.actions.map((a) => ({ type: a.type, summary: a.type === 'send_whatsapp_template' ? `send "${a.template_name}"${ctx.phone ? ` to ${ctx.phone}` : ' (no phone)'}` : a.type === 'notify' || a.type === 'escalate' ? fill(a.title || '{{name}}', ctx) : a.type })),
  };
}

/** A failed run, tried again by a person. Sends reuse their keys, so nothing goes twice. */
export async function retryRun(runId) {
  const { rows } = await query(`UPDATE crm_automation_runs SET status = 'SCHEDULED', run_at = now(), last_error = NULL WHERE id = $1 AND status = 'FAILED' RETURNING id`, [runId]);
  if (!rows[0]) throw badRequest('Only a failed run can be retried');
  return rows[0].id;
}

// ---------------------------------------------------------------- the clock

/** An event that should happen once per record per occasion (`key`). */
async function emitOnce(client, type, entityType, entityId, key, payload = {}) {
  const { rows } = await client.query(
    `SELECT 1 FROM crm_events WHERE type = $1 AND entity_type = $2 AND entity_id = $3 AND payload->>'key' = $4 LIMIT 1`,
    [type, entityType, entityId, key],
  );
  if (rows[0]) return false;
  await emitEvent(client, { type, entityType, entityId, origin: 'SYSTEM', payload: { ...payload, key } });
  return true;
}

/**
 * The time-based checks. Overdue (a scheduled follow-up whose time has
 * passed) and stale (no meaningful activity for a while, whatever is
 * scheduled) are different and reported separately.
 */
export async function scanTimers(now = new Date()) {
  const settings = await salesSettings();
  const f = settings.followUps || {};
  const out = { reminders: 0, overdue: 0, stale_leads: 0, stale_deals: 0, first_response: 0, deadlines: 0, payments: 0, renewals: 0, expired_quotes: 0, recordings_cleared: 0, reports_sent: 0 };
  await withTransaction(async (client) => {
    // reminders before a follow-up is due
    const { rows: due } = await client.query(
      `UPDATE tasks t SET reminder_sent_at = now()
        WHERE t.followup_kind IS NOT NULL AND t.reminder_at <= $1 AND t.reminder_sent_at IS NULL AND t.completed_at IS NULL
          AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL AND (t.snoozed_until IS NULL OR t.snoozed_until <= $1)
        RETURNING t.id, t.title, t.assignee_id, t.due_date, t.crm_lead_id, t.account_id`, [now],
    );
    for (const t of due) {
      if (!t.assignee_id) continue;
      await notify(client, { userId: t.assignee_id, type: 'crm_reminder', title: `Coming up: ${t.title}`, taskId: t.id, leadId: t.crm_lead_id, accountId: t.account_id });
      out.reminders += 1;
    }
    // follow-ups overdue past the escalation threshold: the owner's manager is told, once
    const { rows: overdue } = await client.query(
      `UPDATE tasks t SET escalated_at = now()
        WHERE t.followup_kind IS NOT NULL AND t.completed_at IS NULL AND t.is_archived = FALSE AND t.crm_cancel_reason IS NULL
          AND t.escalated_at IS NULL AND t.due_date < $1::timestamptz - make_interval(hours => $2::int)
          AND (t.snoozed_until IS NULL OR t.snoozed_until <= $1)
        RETURNING t.id, t.title, t.assignee_id, t.crm_lead_id, t.opportunity_id, t.account_id`,
      [now, Number(f.overdueEscalateHours) || 24],
    );
    for (const t of overdue) {
      await emitEvent(client, { type: 'followup.overdue', entityType: t.crm_lead_id ? 'LEAD' : 'OPPORTUNITY', entityId: t.crm_lead_id || t.opportunity_id || t.account_id, origin: 'SYSTEM', payload: { task_id: t.id } });
      const { rows: mgr } = await client.query(
        `SELECT DISTINCT m.id FROM users a JOIN users m ON m.is_active = TRUE AND m.role IN ('manager','admin')
            AND (m.department_id = a.department_id OR EXISTS (SELECT 1 FROM attendance_team_access x WHERE x.manager_id = m.id AND x.department_id = a.department_id))
          WHERE a.id = $1 AND m.id <> a.id`, [t.assignee_id ?? 0],
      );
      for (const m of mgr) await notify(client, { userId: m.id, type: 'crm_escalation', title: `Overdue follow-up: ${t.title}`, taskId: t.id, leadId: t.crm_lead_id, accountId: t.account_id });
      out.overdue += 1;
    }
    // new leads nobody has contacted within the first-response time (working hours)
    const cal = await workCalendar();
    const { rows: fresh } = await client.query(
      `SELECT id, ref, owner_user_id, captured_at FROM crm_leads
        WHERE destination = 'TASKFLOW' AND status = 'NEW' AND first_response_at IS NULL AND is_archived = FALSE AND captured_at > $1::timestamptz - interval '30 days'
          AND entry_channel <> 'IMPORT'`, [now],
    );
    for (const l of fresh) {
      const deadline = cal.addWorkingHours(new Date(l.captured_at), Number(f.firstResponseHours) || 4);
      if (deadline > now) continue;
      if (await emitOnce(client, 'lead.first_response_overdue', 'LEAD', l.id, 'first')) {
        if (l.owner_user_id) await notify(client, { userId: l.owner_user_id, type: 'crm_sla', title: `${l.ref}: not contacted yet`, leadId: l.id });
        out.first_response += 1;
      }
    }
    // stale: no two-way contact for the stale period, whatever is scheduled
    const leadDays = Number(f.staleLeadDays) || 7;
    const { rows: staleLeads } = await client.query(
      `SELECT id, ref, owner_user_id, COALESCE(last_contacted_at, captured_at) AS since FROM crm_leads
        WHERE destination = 'TASKFLOW' AND status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED') AND is_archived = FALSE
          AND COALESCE(last_contacted_at, captured_at) < $1::timestamptz - make_interval(days => $2::int)`, [now, leadDays],
    );
    const newlyStale = new Map();
    for (const l of staleLeads) {
      // once per stale spell: the key is the date contact stopped
      if (await emitOnce(client, 'lead.stale', 'LEAD', l.id, new Date(l.since).toISOString().slice(0, 10))) {
        if (l.owner_user_id) newlyStale.set(l.owner_user_id, [...(newlyStale.get(l.owner_user_id) || []), l]);
        out.stale_leads += 1;
      }
    }
    // a few are named one by one; many at once (after an import, a holiday) are one notice pointing at the list
    for (const [userId, list] of newlyStale) {
      if (list.length <= 3) {
        for (const l of list) await notify(client, { userId, type: 'crm_stale', title: `${l.ref}: no contact for ${leadDays}+ days`, leadId: l.id });
      } else {
        await notify(client, { userId, type: 'crm_stale_digest', title: `${list.length} of your leads have had no contact for ${leadDays}+ days`, body: 'Sales CRM → Leads → Stale lists them.' });
      }
    }
    const dealDays = Number(f.staleOpportunityDays) || 14;
    const { rows: staleDeals } = await client.query(
      `SELECT * FROM (
         SELECT o.id, o.name, o.owner_user_id, o.account_id,
                COALESCE((SELECT MAX(x.occurred_at) FROM account_activities x
                           WHERE x.opportunity_id = o.id AND x.is_external = TRUE
                             AND x.outcome NOT IN ('ATTEMPTED','CANCELLED','NO_SHOW','SCHEDULED')), o.created_at) AS since
           FROM opportunities o
          WHERE o.status = 'ACTIVE' AND o.is_archived = FALSE) d
        WHERE d.since < $1::timestamptz - make_interval(days => $2::int)`,
      [now, dealDays],
    );
    for (const o of staleDeals) {
      if (await emitOnce(client, 'opportunity.stale', 'OPPORTUNITY', o.id, new Date(o.since).toISOString().slice(0, 10))) {
        if (o.owner_user_id) await notify(client, { userId: o.owner_user_id, type: 'crm_stale', title: `${o.name}: no customer contact for ${dealDays}+ days`, accountId: o.account_id });
        out.stale_deals += 1;
      }
    }
    // CSR proposal deadlines within a week
    const { rows: deadlines } = await client.query(
      `SELECT id, name, owner_user_id, account_id, proposal_deadline FROM opportunities
        WHERE status = 'ACTIVE' AND is_archived = FALSE AND proposal_deadline BETWEEN $1::date AND $1::date + 7`, [localDate(now)],
    );
    for (const o of deadlines) {
      if (await emitOnce(client, 'proposal.deadline_approaching', 'OPPORTUNITY', o.id, String(o.proposal_deadline))) {
        if (o.owner_user_id) await notify(client, { userId: o.owner_user_id, type: 'crm_deadline', title: `${o.name}: proposal due ${o.proposal_deadline}`, accountId: o.account_id });
        out.deadlines += 1;
      }
    }
    // payment lines past due with something outstanding
    const { rows: lines } = await client.query(
      `SELECT s.id, s.opportunity_id, s.label, s.due_on, o.owner_user_id, o.account_id, o.name
         FROM crm_payment_schedules s JOIN opportunities o ON o.id = s.opportunity_id
        WHERE s.is_cancelled = FALSE AND s.due_on < $1::date AND o.is_archived = FALSE
          AND s.amount > COALESCE((SELECT SUM(CASE WHEN p.kind = 'REFUND' THEN -p.amount ELSE p.amount END) FROM opportunity_payments p
                                    WHERE p.schedule_id = s.id AND p.is_void = FALSE), 0)`, [localDate(now)],
    );
    for (const s of lines) {
      if (await emitOnce(client, 'payment.overdue', 'OPPORTUNITY', s.opportunity_id, `schedule:${s.id}`, { schedule_id: s.id })) {
        if (s.owner_user_id) await notify(client, { userId: s.owner_user_id, type: 'crm_payment', title: `${s.name}: ${s.label} was due ${s.due_on}`, accountId: s.account_id });
        out.payments += 1;
      }
    }
    // renewals within 30 days that have no renewal deal yet
    const { rows: renewals } = await client.query(
      `SELECT o.id, o.name, o.owner_user_id, o.account_id, o.renewal_due_on FROM opportunities o
        WHERE o.status = 'WON' AND o.renewal_due_on BETWEEN $1::date AND $1::date + 30
          AND NOT EXISTS (SELECT 1 FROM opportunities r WHERE r.renewal_of_id = o.id)`, [localDate(now)],
    );
    for (const o of renewals) {
      if (await emitOnce(client, 'renewal.approaching', 'OPPORTUNITY', o.id, String(o.renewal_due_on))) {
        if (o.owner_user_id) await notify(client, { userId: o.owner_user_id, type: 'crm_renewal', title: `${o.name}: renewal due ${o.renewal_due_on}`, accountId: o.account_id });
        out.renewals += 1;
      }
    }
    // recordings past the retention period are no longer served (the provider's copy is the provider's)
    const days = Number(settings.calls?.recordingRetentionDays) || 365;
    const { rowCount } = await client.query(
      `UPDATE crm_calls SET recording_ref = NULL, notes = COALESCE(notes || E'\\n', '') || 'Recording link removed after the retention period'
        WHERE recording_ref IS NOT NULL AND COALESCE(ended_at, created_at) < $1::timestamptz - make_interval(days => $2::int)`, [now, days],
    );
    out.recordings_cleared = rowCount;
  });
  out.expired_quotes = await expireQuotes();
  out.reports_sent = await sendScheduledReports(now);
  return out;
}
