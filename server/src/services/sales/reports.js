/**
 * Sales reports. Every number states what it counts (docs/CRM_METRICS.md has
 * the full definitions), is limited to what the person may see, and leaves out
 * TeleCRM's categories and leads waiting for classification.
 *
 * Money is reported in one currency at a time. Deals in other currencies are
 * counted separately and never added in; a conversion needs a recorded rate.
 * Commercial bookings, CSR commitments, invoices, receipts and refunds are
 * separate numbers; none of them is accounting revenue.
 *
 * Nothing here claims history it does not have. Pipeline "as of" a past date
 * would need snapshots the CRM does not keep, so it is not offered.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import { notify } from '../activity.js';
import { crmScope, localDate, money, salesSettings, scopeCondition } from './core.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Filters shared by every report. */
export async function reportFilters(input = {}) {
  const settings = await salesSettings();
  const tz = settings.calendar?.timezone || 'Asia/Kolkata';
  const today = localDate(new Date(), tz);
  const from = DAY.test(input.from || '') ? input.from : `${today.slice(0, 8)}01`;
  const to = DAY.test(input.to || '') ? input.to : today;
  if (from > to) throw badRequest('The start date is after the end date');
  return {
    from, to, today, tz,
    currency: /^[A-Z]{3}$/.test(input.currency || '') ? input.currency : settings.calendar?.currency || 'INR',
    ownerId: input.owner_id ? Number(input.owner_id) : null,
    departmentId: input.department_id ? Number(input.department_id) : null,
    category: ['B2B_CORPORATE', 'CSR_NGO'].includes(input.category) ? input.category : null,
    pipeline: input.pipeline ? String(input.pipeline) : null,
    sourceId: input.source_id ? Number(input.source_id) : null,
    campaignId: input.campaign_id ? Number(input.campaign_id) : null,
  };
}

/**
 * Builds the WHERE parts for leads (alias l) and deals (alias o, account a).
 * `kind` says which the query uses ('lead', 'deal' or 'both'), so no
 * parameter is pushed that the query does not reference.
 */
function builder(f, scope, kind = 'both') {
  const params = [f.from, f.to, f.tz, f.currency];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const wantLead = kind !== 'deal';
  const wantDeal = kind !== 'lead';
  // dates are local days: [from 00:00, to + 1 day 00:00) in the report's timezone
  const inRange = (col) => `(${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3)`;
  // every query names the four shared parameters, so none is left untyped when a query does not use one
  const shared = '($1::date IS NOT NULL AND $2::date IS NOT NULL AND $3::text IS NOT NULL AND $4::text IS NOT NULL)';
  const lead = [shared];
  const deal = [shared];
  if (wantLead) lead.push("l.destination = 'TASKFLOW'", 'l.merged_into_id IS NULL', scopeCondition(scope, 'lead', 'l', push));
  if (wantDeal) {
    deal.push('o.is_archived = FALSE', 'a.is_archived = FALSE',
      "(a.lead_category IN ('B2B_CORPORATE','CSR_NGO') OR a.lead_category IS NULL AND COALESCE(a.routing_status,'LEGACY_UNCONFIRMED') = 'LEGACY_UNCONFIRMED')",
      scopeCondition(scope, 'opportunity', 'o', push));
  }
  const both = (leadSql, dealSql, value) => {
    const p = push(value);
    if (wantLead) lead.push(leadSql(p));
    if (wantDeal) deal.push(dealSql(p));
  };
  if (f.ownerId) both((p) => `l.owner_user_id = ${p}`, (p) => `o.owner_user_id = ${p}`, f.ownerId);
  if (f.departmentId) both((p) => `l.department_id = ${p}`, (p) => `a.department_id = ${p}`, f.departmentId);
  if (f.category) both((p) => `l.category = ${p}`, (p) => `COALESCE(a.lead_category, 'B2B_CORPORATE') = ${p}`, f.category);
  if (f.pipeline) both((p) => `l.category = (SELECT category FROM crm_pipelines WHERE key = ${p})`, (p) => `o.pipeline_id = (SELECT id FROM crm_pipelines WHERE key = ${p})`, f.pipeline);
  if (f.sourceId) both((p) => `COALESCE(l.original_source_id, l.source_id) = ${p}`, (p) => `o.source_id = ${p}`, f.sourceId);
  if (f.campaignId) both((p) => `COALESCE(l.original_campaign_id, l.campaign_id) = ${p}`, (p) => `o.campaign_id = ${p}`, f.campaignId);
  return { params, push, inRange, lead: lead.join(' AND '), deal: deal.join(' AND ') };
}

const DEAL_FROM = 'opportunities o JOIN accounts a ON a.id = o.account_id LEFT JOIN account_stages st ON st.id = o.stage_id LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id';
// the value a deal is reported at while open: its estimate, or the CSR amount asked for
const OPEN_VALUE = 'COALESCE(o.estimated_value, o.requested_amount)';
const PROB = 'COALESCE(o.probability, st.default_probability, 0)';
const num = (v) => (v === null || v === undefined ? null : Number(v));
const fmt = (v) => (v === null || v === undefined ? null : money.format(money.parse(String(v))));
const ratio = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

export async function salesSummary(input, scope) {
  const f = await reportFilters(input);
  const bl = builder(f, scope, 'lead');
  const bd = builder(f, scope, 'deal');
  const bb = builder(f, scope, 'both');
  const ql = (sql) => query(sql, bl.params).then((r) => r.rows);
  const qd = (sql) => query(sql, bd.params).then((r) => r.rows);
  const qb = (sql) => query(sql, bb.params).then((r) => r.rows);
  let b = bl;

  const [leads] = await ql(`
    SELECT COUNT(*) FILTER (WHERE ${b.inRange('l.captured_at')})::int AS captured,
           COUNT(*) FILTER (WHERE ${b.inRange('l.captured_at')} AND l.status = 'CONVERTED')::int AS cohort_converted,
           COUNT(*) FILTER (WHERE ${b.inRange('l.captured_at')} AND l.status = 'DISQUALIFIED')::int AS cohort_disqualified,
           COUNT(*) FILTER (WHERE ${b.inRange('l.converted_at')})::int AS converted_in_period,
           COUNT(*) FILTER (WHERE (l.captured_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date)::int AS captured_today,
           COUNT(*) FILTER (WHERE l.owner_user_id IS NULL AND l.is_archived = FALSE AND l.status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED'))::int AS unassigned_now,
           COUNT(*) FILTER (WHERE l.is_archived = FALSE AND l.status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED'))::int AS open_now,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (l.first_response_at - l.captured_at)) / 3600)
             FILTER (WHERE ${b.inRange('l.captured_at')} AND l.first_response_at IS NOT NULL) AS median_first_response_hours
      FROM crm_leads l WHERE ${b.lead}`);

  b = bd;
  const [deals] = await qd(`
    SELECT COUNT(*) FILTER (WHERE o.status = 'ACTIVE')::int AS open_count,
           COUNT(*) FILTER (WHERE o.status = 'ACTIVE' AND o.is_monetary AND o.currency = $4 AND ${OPEN_VALUE} IS NOT NULL)::int AS open_valued,
           COUNT(*) FILTER (WHERE o.status = 'ACTIVE' AND o.is_monetary AND o.currency <> $4)::int AS open_other_currency,
           COUNT(*) FILTER (WHERE o.status = 'ACTIVE' AND NOT o.is_monetary)::int AS open_non_monetary,
           SUM(${OPEN_VALUE}) FILTER (WHERE o.status = 'ACTIVE' AND o.is_monetary AND o.currency = $4) AS pipeline_value,
           SUM(${OPEN_VALUE} * ${PROB} / 100.0) FILTER (WHERE o.status = 'ACTIVE' AND o.is_monetary AND o.currency = $4
             AND COALESCE(st.counts_in_forecast, TRUE) AND COALESCE(o.forecast_category, 'PIPELINE') <> 'OMITTED') AS weighted_forecast,
           COUNT(*) FILTER (WHERE o.status = 'ACTIVE' AND o.expected_close BETWEEN $1::date AND $2::date)::int AS expected_to_close,
           SUM(${OPEN_VALUE}) FILTER (WHERE o.status = 'ACTIVE' AND o.is_monetary AND o.currency = $4 AND o.expected_close BETWEEN $1::date AND $2::date) AS expected_to_close_value,
           COUNT(*) FILTER (WHERE o.status = 'WON' AND ${b.inRange('o.closed_at')})::int AS won,
           COUNT(*) FILTER (WHERE o.status = 'LOST' AND ${b.inRange('o.closed_at')})::int AS lost,
           SUM(o.agreed_value) FILTER (WHERE o.status = 'WON' AND ${b.inRange('o.closed_at')} AND o.is_monetary AND o.currency = $4
             AND COALESCE(p.key, 'b2b') = 'b2b') AS commercial_bookings,
           SUM(o.committed_amount) FILTER (WHERE o.status = 'WON' AND ${b.inRange('o.closed_at')} AND o.is_monetary AND o.currency = $4
             AND p.key = 'csr') AS csr_committed,
           COUNT(*) FILTER (WHERE o.status = 'WON' AND ${b.inRange('o.closed_at')} AND p.key = 'csr' AND NOT o.is_monetary)::int AS csr_non_monetary_won,
           AVG(EXTRACT(EPOCH FROM (o.closed_at - o.created_at)) / 86400) FILTER (WHERE o.status = 'WON' AND ${b.inRange('o.closed_at')}) AS avg_cycle_days,
           COUNT(*) FILTER (WHERE o.status = 'ACTIVE' AND o.reopened_count > 0)::int AS reopened_open
      FROM ${DEAL_FROM} WHERE ${b.deal}`);

  const [money_] = await qd(`
    SELECT (SELECT SUM(i.amount) FROM opportunity_invoices i JOIN (${DEAL_FROM}) ON o.id = i.opportunity_id
             WHERE ${b.deal} AND i.status = 'ISSUED' AND i.currency = $4 AND i.issued_on BETWEEN $1::date AND $2::date) AS invoiced,
           (SELECT SUM(pm.amount) FILTER (WHERE pm.kind <> 'REFUND') FROM opportunity_payments pm JOIN (${DEAL_FROM}) ON o.id = pm.opportunity_id
             WHERE ${b.deal} AND pm.is_void = FALSE AND pm.currency = $4 AND pm.received_on BETWEEN $1::date AND $2::date AND COALESCE(p.key,'b2b') = 'b2b') AS commercial_receipts,
           (SELECT SUM(pm.amount) FILTER (WHERE pm.kind <> 'REFUND') FROM opportunity_payments pm JOIN (${DEAL_FROM}) ON o.id = pm.opportunity_id
             WHERE ${b.deal} AND pm.is_void = FALSE AND pm.currency = $4 AND pm.received_on BETWEEN $1::date AND $2::date AND p.key = 'csr') AS csr_receipts,
           (SELECT SUM(pm.amount) FROM opportunity_payments pm JOIN (${DEAL_FROM}) ON o.id = pm.opportunity_id
             WHERE ${b.deal} AND pm.is_void = FALSE AND pm.kind = 'REFUND' AND pm.currency = $4 AND pm.received_on BETWEEN $1::date AND $2::date) AS refunds,
           (SELECT SUM(GREATEST(sch.scheduled - COALESCE(paid.net, 0), 0)) FROM ${DEAL_FROM}
              JOIN (SELECT opportunity_id, SUM(amount) AS scheduled FROM crm_payment_schedules WHERE is_cancelled = FALSE AND currency = $4 GROUP BY opportunity_id) sch ON sch.opportunity_id = o.id
              LEFT JOIN (SELECT opportunity_id, SUM(CASE WHEN kind = 'REFUND' THEN -amount ELSE amount END) AS net FROM opportunity_payments
                          WHERE is_void = FALSE AND currency = $4 GROUP BY opportunity_id) paid ON paid.opportunity_id = o.id
             WHERE ${b.deal} AND o.status = 'WON') AS outstanding`);

  b = bb;
  const [work] = await qb(`
    SELECT COUNT(*) FILTER (WHERE t.completed_at IS NULL AND t.crm_cancel_reason IS NULL AND t.is_archived = FALSE)::int AS followups_open,
           COUNT(*) FILTER (WHERE t.completed_at IS NULL AND t.crm_cancel_reason IS NULL AND t.is_archived = FALSE AND t.due_date < now())::int AS followups_overdue,
           COUNT(*) FILTER (WHERE t.completed_at IS NULL AND t.crm_cancel_reason IS NULL AND t.is_archived = FALSE
                              AND (t.due_date AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date)::int AS followups_today,
           COUNT(*) FILTER (WHERE ${b.inRange('t.completed_at')})::int AS followups_completed,
           COUNT(*) FILTER (WHERE ${b.inRange('t.completed_at')} AND t.followup_outcome IN ('NO_ANSWER','BUSY','WRONG_NUMBER','NOT_DONE'))::int AS followups_missed
      FROM tasks t
      LEFT JOIN crm_leads l ON l.id = t.crm_lead_id
      LEFT JOIN opportunities o ON o.id = t.opportunity_id LEFT JOIN accounts a ON a.id = COALESCE(o.account_id, t.account_id)
     WHERE t.followup_kind IS NOT NULL
       AND ((t.crm_lead_id IS NOT NULL AND ${b.lead}) OR (t.crm_lead_id IS NULL AND t.opportunity_id IS NOT NULL AND ${b.deal}))`);

  const stale = await staleDealCount(f, bd);
  const otherCurrencies = (await qd(`SELECT DISTINCT o.currency FROM ${DEAL_FROM} WHERE ${bd.deal} AND o.currency <> $4`)).map((r) => r.currency);

  return {
    filters: f,
    leads: {
      captured: leads.captured, captured_today: leads.captured_today, open_now: leads.open_now, unassigned_now: leads.unassigned_now,
      cohort_converted: leads.cohort_converted, cohort_disqualified: leads.cohort_disqualified,
      cohort_conversion_rate: ratio(leads.cohort_converted, leads.captured),
      converted_in_period: leads.converted_in_period,
      median_first_response_hours: leads.median_first_response_hours === null ? null : Math.round(Number(leads.median_first_response_hours) * 10) / 10,
    },
    pipeline: {
      open_count: deals.open_count, open_valued: deals.open_valued, open_non_monetary: deals.open_non_monetary,
      open_other_currency: deals.open_other_currency, value: fmt(deals.pipeline_value), weighted_forecast: fmt(deals.weighted_forecast),
      expected_to_close: deals.expected_to_close, expected_to_close_value: fmt(deals.expected_to_close_value),
      stale: stale, reopened_open: deals.reopened_open,
    },
    outcomes: {
      won: deals.won, lost: deals.lost, win_rate: ratio(deals.won, deals.won + deals.lost),
      avg_cycle_days: deals.avg_cycle_days === null ? null : Math.round(Number(deals.avg_cycle_days)),
      commercial_bookings: fmt(deals.commercial_bookings), csr_committed: fmt(deals.csr_committed), csr_non_monetary_won: deals.csr_non_monetary_won,
    },
    money: {
      invoiced: fmt(money_.invoiced), commercial_receipts: fmt(money_.commercial_receipts), csr_receipts: fmt(money_.csr_receipts),
      refunds: fmt(money_.refunds), outstanding_on_schedules: fmt(money_.outstanding),
    },
    work: work,
    other_currencies: otherCurrencies,
    unavailable: {
      pipeline_as_of_past_dates: 'Not kept: the CRM records stage changes, not daily pipeline snapshots, so past pipeline totals cannot be stated.',
    },
  };
}

async function staleDealCount(f, b) {
  const settings = await salesSettings();
  const days = Number(settings.followUps?.staleOpportunityDays) || 14;
  const params = [...b.params];
  params.push(days);
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM ${DEAL_FROM}
      WHERE ${b.deal} AND o.status = 'ACTIVE'
        AND COALESCE((SELECT MAX(x.occurred_at) FROM account_activities x WHERE x.opportunity_id = o.id AND x.is_external = TRUE
                       AND x.outcome NOT IN ('ATTEMPTED','CANCELLED','NO_SHOW','SCHEDULED')), o.created_at) < now() - make_interval(days => $${params.length}::int)`,
    params,
  );
  return rows[0].n;
}

/** Leads, conversions, won deals and value by original source and campaign. */
export async function sourcePerformance(input, scope) {
  const f = await reportFilters(input);
  const b = builder(f, scope);
  const { rows } = await query(
    `WITH ld AS (
       SELECT COALESCE(l.original_source_id, l.source_id) AS source_id, COALESCE(l.original_campaign_id, l.campaign_id) AS campaign_id,
              COUNT(*)::int AS leads, COUNT(*) FILTER (WHERE l.status = 'CONVERTED')::int AS converted
         FROM crm_leads l WHERE ${b.lead} AND ${b.inRange('l.captured_at')} GROUP BY 1, 2),
     dl AS (
       SELECT o.source_id, o.campaign_id, COUNT(*) FILTER (WHERE o.status = 'WON')::int AS won,
              SUM(o.agreed_value) FILTER (WHERE o.status = 'WON' AND o.currency = $4 AND COALESCE(p.key,'b2b') = 'b2b') AS won_value,
              SUM(o.committed_amount) FILTER (WHERE o.status = 'WON' AND o.currency = $4 AND p.key = 'csr') AS csr_committed
         FROM ${DEAL_FROM} WHERE ${b.deal} AND ${b.inRange('o.closed_at')} GROUP BY 1, 2)
     SELECT COALESCE(ld.source_id, dl.source_id) AS source_id, COALESCE(ld.campaign_id, dl.campaign_id) AS campaign_id,
            s.name AS source_name, c.name AS campaign_name, c.spend, c.spend_currency,
            COALESCE(ld.leads, 0) AS leads, COALESCE(ld.converted, 0) AS converted, COALESCE(dl.won, 0) AS won, dl.won_value, dl.csr_committed
       FROM ld FULL JOIN dl ON COALESCE(ld.source_id, -1) = COALESCE(dl.source_id, -1) AND COALESCE(ld.campaign_id, -1) = COALESCE(dl.campaign_id, -1)
       LEFT JOIN crm_sources s ON s.id = COALESCE(ld.source_id, dl.source_id)
       LEFT JOIN crm_campaigns c ON c.id = COALESCE(ld.campaign_id, dl.campaign_id)
      ORDER BY leads DESC NULLS LAST`,
    b.params,
  );
  return {
    filters: f,
    attribution: 'Original source: the source and campaign recorded when the lead first arrived, carried to the deal it became. Won deals count in the period they were won.',
    rows: rows.map((r) => ({ ...r, won_value: fmt(r.won_value), csr_committed: fmt(r.csr_committed), spend: num(r.spend), conversion_rate: ratio(r.converted, r.leads) })),
  };
}

/** Per person: leads they own, activity, follow-ups and outcomes in the period. */
export async function agentPerformance(input, scope) {
  const f = await reportFilters(input);
  const b = builder(f, scope);
  const { rows } = await query(
    `SELECT u.id, u.full_name,
            (SELECT COUNT(*)::int FROM crm_leads l WHERE ${b.lead} AND l.owner_user_id = u.id AND ${b.inRange('l.captured_at')}) AS leads_received,
            (SELECT COUNT(*)::int FROM crm_leads l WHERE ${b.lead} AND l.owner_user_id = u.id AND ${b.inRange('l.converted_at')}) AS leads_converted,
            (SELECT COUNT(*)::int FROM crm_lead_activities x WHERE x.actor_id = u.id AND x.type IN ('CALL','EMAIL','WHATSAPP','MEETING','VISIT') AND ${b.inRange('x.occurred_at')})
          + (SELECT COUNT(*)::int FROM account_activities x WHERE x.actor_id = u.id AND x.type IN ('CALL','EMAIL','WHATSAPP','MEETING','DEMO','IN_PERSON') AND ${b.inRange('x.occurred_at')}) AS activities,
            (SELECT COUNT(*)::int FROM tasks t WHERE t.assignee_id = u.id AND t.followup_kind IS NOT NULL AND ${b.inRange('t.completed_at')}) AS followups_done,
            (SELECT COUNT(*)::int FROM tasks t WHERE t.assignee_id = u.id AND t.followup_kind IS NOT NULL AND t.completed_at IS NULL AND t.crm_cancel_reason IS NULL
               AND t.is_archived = FALSE AND t.due_date < now()) AS followups_overdue,
            (SELECT COUNT(*)::int FROM ${DEAL_FROM} WHERE ${b.deal} AND o.owner_user_id = u.id AND o.status = 'WON' AND ${b.inRange('o.closed_at')}) AS won,
            (SELECT COUNT(*)::int FROM ${DEAL_FROM} WHERE ${b.deal} AND o.owner_user_id = u.id AND o.status = 'LOST' AND ${b.inRange('o.closed_at')}) AS lost,
            (SELECT SUM(o.agreed_value) FROM ${DEAL_FROM} WHERE ${b.deal} AND o.owner_user_id = u.id AND o.status = 'WON' AND o.currency = $4
               AND COALESCE(p.key,'b2b') = 'b2b' AND ${b.inRange('o.closed_at')}) AS bookings,
            (SELECT SUM(o.committed_amount) FROM ${DEAL_FROM} WHERE ${b.deal} AND o.owner_user_id = u.id AND o.status = 'WON' AND o.currency = $4
               AND p.key = 'csr' AND ${b.inRange('o.closed_at')}) AS csr_committed,
            (SELECT COUNT(*)::int FROM ${DEAL_FROM} WHERE ${b.deal} AND o.owner_user_id = u.id AND o.status = 'ACTIVE') AS open_deals
       FROM users u
      WHERE u.is_active = TRUE AND u.role <> 'viewer' ${f.ownerId ? 'AND u.id = $' + (b.params.indexOf(f.ownerId) + 1) : ''}
      ORDER BY u.full_name`,
    b.params,
  );
  return {
    filters: f,
    rows: rows.filter((r) => r.leads_received || r.activities || r.won || r.lost || r.open_deals || r.followups_done || r.followups_overdue)
      .map((r) => ({ ...r, bookings: fmt(r.bookings), csr_committed: fmt(r.csr_committed), win_rate: ratio(r.won, r.won + r.lost) })),
  };
}

/** Per stage of a pipeline: open deals, value, and the average time spent there (from stage history). */
export async function stageReport(input, scope) {
  const f = await reportFilters(input);
  const b = builder({ ...f, pipeline: f.pipeline || 'b2b' }, scope, 'deal');
  const { rows } = await query(
    `SELECT st.id, st.name, st.kind, st.position, st.aging_days,
            COUNT(o.id) FILTER (WHERE o.status = 'ACTIVE')::int AS open_deals,
            SUM(${OPEN_VALUE}) FILTER (WHERE o.status = 'ACTIVE' AND o.is_monetary AND o.currency = $4) AS open_value,
            COUNT(o.id) FILTER (WHERE o.status = 'ACTIVE' AND st.aging_days IS NOT NULL AND o.stage_changed_at < now() - make_interval(days => st.aging_days))::int AS ageing
       FROM account_stages st
       LEFT JOIN (opportunities o JOIN accounts a ON a.id = o.account_id LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id) ON o.stage_id = st.id AND ${b.deal}
      WHERE st.pipeline_id = (SELECT id FROM crm_pipelines WHERE key = $${b.params.indexOf(f.pipeline || 'b2b') + 1}) AND st.retired_at IS NULL
      GROUP BY st.id ORDER BY st.position`,
    b.params,
  );
  // time in stage: from one stage-change line to the next, for stays that ended in the period
  const { rows: stays } = await query(
    `WITH h AS (
       SELECT h.opportunity_id, h.to_value AS stage, h.created_at AS entered,
              LEAD(h.created_at) OVER (PARTITION BY h.opportunity_id ORDER BY h.created_at, h.id) AS left_at
         FROM opportunity_history h WHERE h.field = 'stage')
     SELECT stage, COUNT(*)::int AS stays, AVG(EXTRACT(EPOCH FROM (left_at - entered)) / 86400) AS avg_days
       FROM h JOIN opportunities o ON o.id = h.opportunity_id JOIN accounts a ON a.id = o.account_id
       LEFT JOIN account_stages st ON st.id = o.stage_id LEFT JOIN crm_pipelines p ON p.id = o.pipeline_id
      WHERE left_at IS NOT NULL AND ${b.inRange('left_at')} AND ${b.deal}
      GROUP BY stage`,
    b.params,
  );
  const byName = new Map(stays.map((s) => [s.stage, s]));
  return {
    filters: { ...f, pipeline: f.pipeline || 'b2b' },
    note: 'Time in stage is measured from the stage-change history; a stage renamed later keeps its old name in older history lines.',
    stages: rows.map((r) => ({ ...r, open_value: fmt(r.open_value), stays_ended: byName.get(r.name)?.stays ?? 0, avg_days_in_stage: byName.get(r.name)?.avg_days ? Math.round(Number(byName.get(r.name).avg_days) * 10) / 10 : null })),
  };
}

/** Targets for the period against the same measures as the summary. */
export async function targetsVsActuals(input, scope) {
  const f = await reportFilters(input);
  const { rows: targets } = await query(
    `SELECT t.*, u.full_name AS user_name, d.name AS department_name, p.key AS pipeline_key
       FROM crm_targets t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN crm_pipelines p ON p.id = t.pipeline_id
      WHERE t.period_start <= $2::date AND t.period_end >= $1::date ORDER BY t.period_start, t.metric`, [f.from, f.to],
  );
  const out = [];
  for (const t of targets) {
    const scoped = { from: String(t.period_start).slice(0, 10), to: String(t.period_end).slice(0, 10), currency: t.currency || f.currency,
      owner_id: t.user_id, department_id: t.department_id, pipeline: t.pipeline_key };
    const s = await salesSummary(scoped, scope);
    const actual = {
      NEW_LEADS: s.leads.captured, CONVERTED_LEADS: s.leads.converted_in_period, WON_DEALS: s.outcomes.won,
      WON_VALUE: s.outcomes.commercial_bookings, CSR_COMMITTED: s.outcomes.csr_committed,
      RECEIPTS: s.money.commercial_receipts === null && s.money.csr_receipts === null ? null
        : money.format((money.parse(s.money.commercial_receipts || '0') + money.parse(s.money.csr_receipts || '0')) - money.parse(s.money.refunds || '0')),
      ACTIVITIES: null,
    }[t.metric];
    out.push({ ...t, target: num(t.target), actual: actual === null || actual === undefined ? null : Number(actual), attainment: actual === null || actual === undefined || !Number(t.target) ? null : ratio(Number(actual), Number(t.target)) });
  }
  return { filters: f, targets: out };
}

// ---------------------------------------------------------------- drill-down

export const DRILLS = {
  captured: { kind: 'lead', where: (b) => b.inRange('l.captured_at') },
  cohort_converted: { kind: 'lead', where: (b) => `${b.inRange('l.captured_at')} AND l.status = 'CONVERTED'` },
  converted_in_period: { kind: 'lead', where: (b) => b.inRange('l.converted_at') },
  unassigned_now: { kind: 'lead', where: () => `l.owner_user_id IS NULL AND l.is_archived = FALSE AND l.status IN ('NEW','CONTACTED','QUALIFYING','QUALIFIED')` },
  open_deals: { kind: 'deal', where: () => `o.status = 'ACTIVE'` },
  expected_to_close: { kind: 'deal', where: () => `o.status = 'ACTIVE' AND o.expected_close BETWEEN $1::date AND $2::date` },
  won: { kind: 'deal', where: (b) => `o.status = 'WON' AND ${b.inRange('o.closed_at')}` },
  lost: { kind: 'deal', where: (b) => `o.status = 'LOST' AND ${b.inRange('o.closed_at')}` },
};

/** The records behind a number, with the same filters and the same visibility. */
export async function drill(metric, input, scope, { limit = 5000 } = {}) {
  const d = DRILLS[metric];
  if (!d) throw badRequest('Unknown measure');
  const f = await reportFilters(input);
  const b = builder(f, scope, d.kind === 'lead' ? 'lead' : 'deal');
  if (d.kind === 'lead') {
    const { rows } = await query(
      `SELECT l.id, l.ref, l.category, l.status, l.organization_name, l.contact_name, l.captured_at, l.converted_at, u.full_name AS owner_name,
              s.name AS source_name
         FROM crm_leads l LEFT JOIN users u ON u.id = l.owner_user_id LEFT JOIN crm_sources s ON s.id = COALESCE(l.original_source_id, l.source_id)
        WHERE ${b.lead} AND ${d.where(b)} ORDER BY l.captured_at DESC LIMIT ${Number(limit)}`, b.params,
    );
    return { kind: 'lead', filters: f, rows };
  }
  const { rows } = await query(
    `SELECT o.id, o.name, a.name AS account_name, p.name AS pipeline, st.name AS stage, o.status, o.currency, ${OPEN_VALUE} AS open_value,
            o.agreed_value, o.committed_amount, ${PROB} AS probability, o.expected_close, o.closed_at, o.is_monetary, u.full_name AS owner_name
       FROM ${DEAL_FROM} LEFT JOIN users u ON u.id = o.owner_user_id
      WHERE ${b.deal} AND ${d.where(b)} ORDER BY o.closed_at DESC NULLS LAST, o.expected_close NULLS LAST LIMIT ${Number(limit)}`, b.params,
  );
  return { kind: 'deal', filters: f, rows };
}

// ---------------------------------------------------------------- scheduled reports

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayLabel = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const REPORT_LABELS = { summary: 'Summary', sources: 'Sources & campaigns', agents: 'People', stages: 'Stages' };

/**
 * The last complete period for a schedule, and the day the current one began:
 * a schedule is due once its last delivery is before that day. A weekly report
 * covers Monday–Sunday, a monthly one the calendar month.
 */
export function reportPeriod(frequency, today) {
  if (frequency === 'DAILY') return { start: today, from: addDays(today, -1), to: addDays(today, -1) };
  if (frequency === 'WEEKLY') {
    const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
    return { start: monday, from: addDays(monday, -7), to: addDays(monday, -1) };
  }
  const first = `${today.slice(0, 8)}01`;
  const last = addDays(first, -1);
  return { start: first, from: `${last.slice(0, 8)}01`, to: last };
}

function headline(s) {
  const c = s.filters.currency;
  const cash = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(Number(v));
  const parts = [
    `${s.leads.captured} lead${s.leads.captured === 1 ? '' : 's'} in, ${s.leads.converted_in_period} converted`,
    `${s.outcomes.won} won, ${s.outcomes.lost} lost`,
  ];
  if (s.outcomes.commercial_bookings !== null) parts.push(`bookings ${cash(s.outcomes.commercial_bookings)}`);
  if (s.outcomes.csr_committed !== null) parts.push(`CSR committed ${cash(s.outcomes.csr_committed)}`);
  if (s.money.commercial_receipts !== null || s.money.csr_receipts !== null) {
    parts.push(`received ${cash(Number(s.money.commercial_receipts || 0) + Number(s.money.csr_receipts || 0))}`);
  }
  parts.push(`${s.work.followups_overdue} follow-up${s.work.followups_overdue === 1 ? '' : 's'} overdue now`);
  return parts.join(' · ');
}

/**
 * Sends each schedule that is due as an in-app notice to each recipient. The
 * numbers in a notice are computed with that recipient's own visibility, so a
 * schedule never shows anyone records they could not open themselves; people
 * who are inactive or have no CRM access are skipped. One delivery per period:
 * the row is locked while it is sent and marked in the same transaction.
 */
export async function sendScheduledReports(now = new Date()) {
  const settings = await salesSettings();
  const today = localDate(now, settings.calendar?.timezone || 'Asia/Kolkata');
  const { rows: candidates } = await query('SELECT id FROM crm_report_schedules WHERE is_enabled = TRUE ORDER BY id');
  let sent = 0;
  for (const { id } of candidates) {
    await withTransaction(async (client) => {
      const { rows: [s] } = await client.query('SELECT * FROM crm_report_schedules WHERE id = $1 AND is_enabled = TRUE FOR UPDATE SKIP LOCKED', [id]);
      if (!s) return;
      const period = reportPeriod(s.frequency, today);
      if (s.last_sent_on && s.last_sent_on >= period.start) return;
      const { rows: people } = await client.query(
        `SELECT id, role, department_id, extra_permissions, revoked_permissions FROM users WHERE id = ANY($1::int[]) AND is_active = TRUE`, [s.recipient_ids],
      );
      const range = period.from === period.to ? dayLabel(period.from) : `${dayLabel(period.from)} – ${dayLabel(period.to)}`;
      for (const person of people) {
        if (!hasPermission(person, 'crm.view')) continue;
        const summary = await salesSummary({ ...s.filters, from: period.from, to: period.to }, await crmScope(person));
        const more = s.report === 'summary' ? '' : ` Open Sales CRM → Reports → ${REPORT_LABELS[s.report] || s.report} for the detail.`;
        await notify(client, { userId: person.id, type: 'crm_report', title: `${s.name}: ${range}`, body: `${headline(summary)}.${more}` });
        sent += 1;
      }
      await client.query('UPDATE crm_report_schedules SET last_sent_on = $2, updated_at = now() WHERE id = $1', [s.id, today]);
    });
  }
  return sent;
}
