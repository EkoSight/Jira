/**
 * Pipelines and their stages.
 *
 * Two pipelines ship: B2B Corporate (the stages TaskFlow always had, plus
 * Approval / Contracting) and CSR / NGO. A deal belongs to one pipeline and
 * moves only between that pipeline's stages. Stages keep their id when they
 * are renamed, so history and reports stay joined; a stage that still holds
 * deals can only be retired into another stage of the same pipeline, and every
 * deal moved that way gets a history line saying so.
 *
 * What a stage can ask of a deal moving in, on top of the evidence rules the
 * deal screen already enforced:
 *   required_fields  deal fields that must be filled (from REQUIRED_FIELD_KEYS)
 *   allowed_to       the stages a deal may move to from here (blank: any)
 *   approval_gate    an approved quotation or proposal must exist
 *   checklist        items shown to the person moving the deal (guidance)
 *   aging_days       days in the stage before the deal counts as ageing
 *   counts_in_forecast  whether open deals here count in the weighted forecast
 */
import { query } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { PIPELINE_FOR_CATEGORY } from './core.js';

/** Deal fields a stage may require, with the label the person sees. */
export const REQUIRED_FIELD_KEYS = {
  estimated_value: 'Estimated value',
  proposed_value: 'Proposed value',
  agreed_value: 'Agreed value',
  expected_close: 'Expected close date',
  probability: 'Probability',
  problem: 'The problem they want solved',
  decision_process: 'How they decide',
  win_criteria: 'What winning looks like',
  scope_summary: 'Scope summary',
  primary_contact: 'A contact on the deal',
  decision_maker: 'The decision maker',
  thematic_focus: 'Thematic focus',
  proposed_project: 'Proposed project',
  project_geography: 'Project geography',
  beneficiaries: 'Intended beneficiaries',
  requested_amount: 'Requested funding',
  committed_amount: 'Committed funding',
  funding_cycle: 'Funding cycle',
  proposal_deadline: 'Proposal deadline',
  agreement_status: 'Agreement status',
  funder: 'The funder',
  implementing_partner: 'The implementing partner',
};

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim());

export async function listPipelines({ withStages = true, includeRetired = false } = {}) {
  const { rows: pipelines } = await query('SELECT * FROM crm_pipelines ORDER BY position, id');
  if (!withStages) return pipelines;
  const { rows: stages } = await query(
    `SELECT s.*, (SELECT COUNT(*)::int FROM opportunities o WHERE o.stage_id = s.id AND o.is_archived = FALSE) AS deal_count,
            (SELECT COUNT(*)::int FROM opportunities o WHERE o.stage_id = s.id AND o.is_archived = FALSE AND o.status = 'ACTIVE') AS open_deal_count
       FROM account_stages s
      WHERE s.pipeline_id IS NOT NULL ${includeRetired ? '' : 'AND s.retired_at IS NULL'}
      ORDER BY s.position, s.id`,
  );
  return pipelines.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) }));
}

export async function getPipeline(keyOrId) {
  const byId = /^\d+$/.test(String(keyOrId));
  const { rows } = await query(`SELECT * FROM crm_pipelines WHERE ${byId ? 'id' : 'key'} = $1`, [byId ? Number(keyOrId) : String(keyOrId)]);
  return rows[0] || null;
}

/** The pipeline a stage belongs to (legacy stages without one are B2B's). */
export async function stagePipelineId(stageId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT COALESCE(s.pipeline_id, (SELECT id FROM crm_pipelines ORDER BY is_default DESC, position LIMIT 1)) AS pipeline_id
       FROM account_stages s WHERE s.id = $1`, [stageId],
  );
  return rows[0]?.pipeline_id ?? null;
}

/** The pipeline for an organization's category; B2B when it has none. */
export async function pipelineForCategory(category, runner = { query }) {
  const key = PIPELINE_FOR_CATEGORY[category] || null;
  const { rows } = await runner.query(
    key ? 'SELECT id FROM crm_pipelines WHERE key = $1' : 'SELECT id FROM crm_pipelines ORDER BY is_default DESC, position LIMIT 1',
    key ? [key] : [],
  );
  return rows[0]?.id ?? null;
}

/** The first open stage of a pipeline: where a new deal starts. */
export async function firstStage(pipelineIdValue, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT id FROM account_stages
      WHERE pipeline_id = $1 AND is_active = TRUE AND retired_at IS NULL AND kind = 'open'
      ORDER BY is_default DESC, position ASC LIMIT 1`,
    [pipelineIdValue],
  );
  return rows[0]?.id ?? null;
}

/** The stage of `kind` ('won' | 'lost') in a pipeline. */
export async function terminalStage(pipelineIdValue, kind, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT id FROM account_stages
      WHERE kind = $2 AND is_active = TRUE AND retired_at IS NULL
        AND ($1::int IS NULL OR pipeline_id = $1 OR pipeline_id IS NULL)
      ORDER BY (pipeline_id = $1) DESC NULLS LAST, position LIMIT 1`,
    [pipelineIdValue ?? null, kind],
  );
  return rows[0]?.id ?? null;
}

/**
 * Works out the pipeline and stage for a new deal: the stage named, else the
 * pipeline named, else the organization's category.
 */
export async function placeNewDeal(runner, { stageId = null, pipeline = null, category = null }) {
  if (stageId) {
    const { rows } = await runner.query('SELECT id, pipeline_id, retired_at, is_active FROM account_stages WHERE id = $1', [stageId]);
    if (!rows[0]) throw badRequest('Stage not found');
    if (rows[0].retired_at) throw badRequest('That stage has been retired; choose another');
    const pid = rows[0].pipeline_id ?? await pipelineForCategory(null, runner);
    if (pipeline) {
      const wanted = await resolvePipelineId(pipeline, runner);
      if (wanted && wanted !== pid) throw badRequest('That stage belongs to another pipeline');
    }
    return { pipelineId: pid, stageId: rows[0].id };
  }
  const pid = pipeline ? await resolvePipelineId(pipeline, runner) : await pipelineForCategory(category, runner);
  if (!pid) throw badRequest('Pipeline not found');
  return { pipelineId: pid, stageId: await firstStage(pid, runner) };
}

export async function resolvePipelineId(keyOrId, runner = { query }) {
  if (keyOrId === null || keyOrId === undefined || keyOrId === '') return null;
  const byId = /^\d+$/.test(String(keyOrId));
  const { rows } = await runner.query(`SELECT id FROM crm_pipelines WHERE ${byId ? 'id' : 'key'} = $1`, [byId ? Number(keyOrId) : String(keyOrId)]);
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------- the checks a move makes

/** What the deal still lacks for the stage's required fields. */
export async function missingRequiredFields(client, opportunity, stage) {
  const required = Array.isArray(stage.required_fields) ? stage.required_fields : [];
  if (!required.length) return [];
  const missing = [];
  let contacts = null;
  let parties = null;
  const loadContacts = async () => {
    if (!contacts) {
      const { rows } = await client.query(
        `SELECT oc.role, ac.decision_roles FROM opportunity_contacts oc JOIN account_contacts ac ON ac.id = oc.contact_id
          WHERE oc.opportunity_id = $1`, [opportunity.id],
      );
      contacts = rows;
    }
    return contacts;
  };
  const loadParties = async () => {
    if (!parties) parties = (await client.query('SELECT role FROM opportunity_parties WHERE opportunity_id = $1', [opportunity.id])).rows;
    return parties;
  };
  for (const key of required) {
    if (!REQUIRED_FIELD_KEYS[key]) continue;
    let ok;
    if (key === 'primary_contact') ok = (await loadContacts()).length > 0;
    else if (key === 'decision_maker') {
      ok = (await loadContacts()).some((c) => c.role === 'DECISION_MAKER' || (c.decision_roles || []).includes('DECISION_MAKER'));
    } else if (key === 'funder') ok = (await loadParties()).some((p) => p.role === 'FUNDER') || opportunity.engagement_model === 'CSR_PROJECT';
    else if (key === 'implementing_partner') ok = (await loadParties()).some((p) => p.role === 'IMPLEMENTING_PARTNER');
    else ok = !blank(opportunity[key]);
    if (!ok) missing.push({ rule: `field:${key}`, label: REQUIRED_FIELD_KEYS[key], hint: `Fill in ${REQUIRED_FIELD_KEYS[key].toLowerCase()} before moving on` });
  }
  return missing;
}

/** Whether the deal has a quotation or proposal approved (or accepted) at its current content. */
export async function hasApprovedQuote(client, opportunityId) {
  const { rows } = await client.query(
    `SELECT 1 FROM crm_quotes WHERE opportunity_id = $1 AND status IN ('APPROVED', 'SENT', 'ACCEPTED')
        AND (approval_required = FALSE OR approved_hash IS NOT NULL) LIMIT 1`, [opportunityId],
  );
  return rows.length > 0;
}

/**
 * The pipeline-level checks for a move: same pipeline, stage not retired, the
 * transition allowed, required fields present, approval gate passed. Returns
 * { hard: [...], soft: [...] } — hard problems refuse the move outright, soft
 * ones (fields, approvals) can be overridden by a manager with a reason, like
 * missing evidence.
 */
export async function checkPipelineMove(client, { opportunity, from, to }) {
  const hard = [];
  const soft = [];
  if (to.retired_at) hard.push('That stage has been retired');
  const dealPipeline = opportunity.pipeline_id ?? from?.pipeline_id ?? null;
  if (dealPipeline && to.pipeline_id && dealPipeline !== to.pipeline_id) {
    hard.push('That stage belongs to another pipeline; a deal moves only within its own');
  }
  if (from && Array.isArray(from.allowed_to) && from.allowed_to.length && from.id !== to.id && !from.allowed_to.includes(to.id)) {
    hard.push(`${from.name} cannot move straight to ${to.name}`);
  }
  if (to.kind !== 'lost') {
    soft.push(...await missingRequiredFields(client, opportunity, to));
    if (to.approval_gate && !(await hasApprovedQuote(client, opportunity.id))) {
      soft.push({ rule: 'approval', label: 'An approved quotation or proposal', hint: 'Get the quotation or proposal approved before this stage' });
    }
  }
  return { hard, soft };
}

// ---------------------------------------------------------------- configuration

const STAGE_FIELDS = ['name', 'color', 'position', 'kind', 'default_probability', 'required_fields', 'checklist', 'allowed_to',
  'aging_days', 'approval_gate', 'counts_in_forecast', 'entry_rules', 'exit_rules', 'quiet_after_days', 'entry_expectations', 'is_active'];

/** Validates and applies a stage change; the id (and its slug) never change. */
export async function updateStage(client, stageId, data) {
  const { rows } = await client.query('SELECT * FROM account_stages WHERE id = $1 FOR UPDATE', [stageId]);
  const stage = rows[0];
  if (!stage) throw badRequest('Stage not found');
  if (data.required_fields) {
    const unknown = data.required_fields.filter((k) => !REQUIRED_FIELD_KEYS[k]);
    if (unknown.length) throw badRequest(`Unknown required fields: ${unknown.join(', ')}`);
  }
  if (data.allowed_to) {
    const { rows: same } = await client.query('SELECT id FROM account_stages WHERE id = ANY($1::int[]) AND pipeline_id = $2', [data.allowed_to, stage.pipeline_id]);
    if (same.length !== new Set(data.allowed_to).size) throw badRequest('A stage can only lead to stages of its own pipeline');
  }
  if (data.kind && data.kind !== stage.kind) {
    const { rows: held } = await client.query('SELECT COUNT(*)::int AS n FROM opportunities WHERE stage_id = $1 AND is_archived = FALSE', [stageId]);
    if (held[0].n) throw badRequest(`${held[0].n} deal(s) are in this stage; move them before changing whether it is open, won or lost`);
  }
  if (data.is_active === false) {
    const { rows: held } = await client.query(
      `SELECT COUNT(*)::int AS n FROM opportunities WHERE stage_id = $1 AND is_archived = FALSE AND status = 'ACTIVE'`, [stageId],
    );
    if (held[0].n) throw badRequest(`${held[0].n} open deal(s) are in this stage; retire it into another stage instead`);
  }
  const sets = [];
  const params = [];
  for (const key of STAGE_FIELDS) {
    if (data[key] === undefined) continue;
    params.push(key === 'checklist' ? JSON.stringify(data[key]) : data[key]);
    sets.push(`${key} = $${params.length}${key === 'checklist' ? '::jsonb' : ''}`);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  params.push(stageId);
  const { rows: updated } = await client.query(
    `UPDATE account_stages SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
  );
  return { before: stage, after: updated[0] };
}

export async function addStage(client, pipelineIdValue, data) {
  const { rows: p } = await client.query('SELECT id FROM crm_pipelines WHERE id = $1', [pipelineIdValue]);
  if (!p[0]) throw badRequest('Pipeline not found');
  const slugBase = String(data.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stage';
  const { rows: taken } = await client.query('SELECT slug FROM account_stages WHERE slug LIKE $1', [`${slugBase}%`]);
  const used = new Set(taken.map((r) => r.slug));
  let slug = slugBase;
  for (let i = 2; used.has(slug); i += 1) slug = `${slugBase}-${i}`;
  const { rows } = await client.query(
    `INSERT INTO account_stages (name, slug, kind, color, position, pipeline_id, default_probability, required_fields,
                                 checklist, aging_days, approval_gate, counts_in_forecast)
     VALUES ($1,$2,COALESCE($3,'open'),COALESCE($4,'#64748b'),
             COALESCE($5,(SELECT COALESCE(MAX(position),0)+1 FROM account_stages WHERE pipeline_id = $6)),
             $6,$7,COALESCE($8::text[],'{}'),COALESCE($9::jsonb,'[]'::jsonb),$10,COALESCE($11,FALSE),COALESCE($12,TRUE))
     RETURNING *`,
    [data.name.trim(), slug, data.kind ?? null, data.color ?? null, data.position ?? null, pipelineIdValue,
      data.default_probability ?? null, data.required_fields ?? null, data.checklist ? JSON.stringify(data.checklist) : null,
      data.aging_days ?? null, data.approval_gate ?? null, data.counts_in_forecast ?? null],
  );
  return rows[0];
}

/**
 * Retires a stage. Deals still in it move to `intoStageId` (same pipeline,
 * not retired), each with a history line; the stage keeps its id so old
 * history still points at it.
 */
export async function retireStage(client, stageId, { intoStageId = null, actor, recordHistory }) {
  const { rows } = await client.query('SELECT * FROM account_stages WHERE id = $1 FOR UPDATE', [stageId]);
  const stage = rows[0];
  if (!stage) throw badRequest('Stage not found');
  if (stage.retired_at) throw badRequest('That stage is already retired');
  const { rows: held } = await client.query(
    'SELECT id, name, account_id FROM opportunities WHERE stage_id = $1 AND is_archived = FALSE FOR UPDATE', [stageId],
  );
  let into = null;
  if (held.length) {
    if (!intoStageId) throw badRequest(`${held.length} deal(s) are in ${stage.name}; choose the stage they move to`, { code: 'STAGE_MAPPING_REQUIRED', count: held.length });
    const { rows: target } = await client.query('SELECT * FROM account_stages WHERE id = $1', [intoStageId]);
    into = target[0];
    if (!into || into.retired_at || into.id === stage.id) throw badRequest('Choose a live stage to move the deals into');
    if (into.pipeline_id !== stage.pipeline_id) throw badRequest('Deals can only move to a stage of the same pipeline');
    if (into.kind !== stage.kind) throw badRequest(`Choose another ${stage.kind} stage, so no deal changes from open to closed by a settings change`);
    for (const deal of held) {
      await client.query('UPDATE opportunities SET stage_id = $1, updated_at = now() WHERE id = $2', [into.id, deal.id]);
      await recordHistory(client, {
        opportunityId: deal.id, field: 'stage', from: stage.name, to: into.name,
        reason: `Stage ${stage.name} retired by ${actor.name || 'an administrator'}`, actorId: actor.id,
      });
    }
  }
  await client.query(
    'UPDATE account_stages SET retired_at = now(), retired_into = $2, is_active = FALSE, updated_at = now() WHERE id = $1',
    [stageId, into?.id ?? null],
  );
  return { stage, into, moved: held.length };
}
