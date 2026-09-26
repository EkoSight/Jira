import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import {
  CONTACT_ROLES, ENGAGEMENT_MODELS, FINANCIAL_STATUSES, OPPORTUNITY_STATUSES,
  REQUIREMENT_CATEGORIES, REQUIREMENT_IMPORTANCE, REQUIREMENT_STATUSES,
  canEditOpportunity, decorateOpportunity, getOpportunity, listHistory,
  listOpportunities, listRequirements, recordHistory, recordOwnershipChange,
  refreshPrimaryOpportunity, syncAccountMirror, topBlocker,
} from '../services/opportunities.js';
import { logActivity } from '../services/crm.js';
import { loadStageMove, moveOpportunityStage } from '../services/dealMoves.js';

const router = Router();

/** Loads the raw row plus what the permission check needs. */
async function loadOpportunity(id) {
  const { rows } = await query(
    `SELECT o.*, a.owner_user_id AS relationship_owner_id, a.name AS account_name
       FROM opportunities o JOIN accounts a ON a.id = o.account_id
      WHERE o.id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function mustEdit(user, id) {
  const row = await loadOpportunity(id);
  if (!row) throw notFound('Opportunity not found');
  if (!canEditOpportunity(user, row)) throw forbidden('You cannot change this opportunity');
  return row;
}

const opportunityInput = z.object({
  account_id: z.number().int().positive(),
  name: z.string().min(2).max(200),
  engagement_model: z.enum(ENGAGEMENT_MODELS).optional(),
  stage_id: z.number().int().positive().nullable().optional(),
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),

  estimated_value: z.number().min(0).nullable().optional(),
  proposed_value: z.number().min(0).nullable().optional(),
  agreed_value: z.number().min(0).nullable().optional(),
  collected_value: z.number().min(0).nullable().optional(),
  currency: z.string().max(8).optional(),
  value_basis: z.string().max(120).nullable().optional(),
  value_period: z.string().max(60).nullable().optional(),
  value_unknown: z.boolean().optional(),

  probability: z.number().int().min(0).max(100).nullable().optional(),
  probability_reason: z.string().max(500).nullable().optional(),
  expected_close: z.string().min(8).nullable().optional(),

  problem: z.string().max(20000).nullable().optional(),
  desired_outcome: z.string().max(20000).nullable().optional(),
  decision_process: z.string().max(20000).nullable().optional(),
  approval_dependency: z.string().max(20000).nullable().optional(),
  objections: z.string().max(20000).nullable().optional(),
  win_criteria: z.string().max(20000).nullable().optional(),
  scope_summary: z.string().max(20000).nullable().optional(),
  scope: z.record(z.any()).optional(),

  next_step: z.string().max(2000).nullable().optional(),
  next_step_due: z.string().min(8).nullable().optional(),
});

// ---------------------------------------------------------------- list

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const opportunities = await listOpportunities({
      accountId: req.query.account_id,
      ownerId: req.query.owner_id,
      stageId: req.query.stage_id,
      segmentId: req.query.segment_id,
      departmentId: req.query.department_id,
      status: req.query.status,
      model: req.query.model,
      openOnly: req.query.open === 'true',
      closingBefore: req.query.closing_before,
      search: req.query.search,
      limit: req.query.limit,
    });
    res.json({ opportunities });
  }),
);

// ---------------------------------------------------------------- detail

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const opportunity = await getOpportunity(id);
    if (!opportunity) throw notFound('Opportunity not found');

    const [requirements, history, contacts] = await Promise.all([
      listRequirements(id),
      listHistory(id),
      query(
        `SELECT oc.role, oc.involvement, oc.notes, c.*
           FROM opportunity_contacts oc
           JOIN account_contacts c ON c.id = oc.contact_id
          WHERE oc.opportunity_id = $1
          ORDER BY c.is_primary DESC, c.full_name`,
        [id],
      ),
    ]);

    res.json({
      opportunity,
      requirements,
      // the one thing most in the way, so the profile can lead with it
      top_blocker: topBlocker(requirements),
      history,
      contacts: contacts.rows,
      can_edit: canEditOpportunity(req.currentUser, await loadOpportunity(id)),
    });
  }),
);

// ---------------------------------------------------------------- create

router.post(
  '/',
  requirePermission('crm.create'),
  asyncHandler(async (req, res) => {
    const data = opportunityInput.parse(req.body);

    const { rows: accountRows } = await query('SELECT * FROM accounts WHERE id = $1', [data.account_id]);
    const account = accountRows[0];
    if (!account) throw notFound('Organization not found');

    let stageId = data.stage_id;
    if (!stageId) {
      const { rows } = await query(
        `SELECT id FROM account_stages WHERE is_active = TRUE
          ORDER BY is_default DESC, position ASC LIMIT 1`,
      );
      stageId = rows[0]?.id ?? null;
    }

    const created = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO opportunities
           (account_id, name, engagement_model, stage_id, status, owner_user_id,
            estimated_value, proposed_value, currency, value_basis, value_period, value_unknown,
            probability, probability_reason, expected_close, original_close,
            problem, desired_outcome, decision_process, approval_dependency, objections,
            win_criteria, scope_summary, scope, next_step, next_step_due, created_by)
         VALUES ($1,$2,COALESCE($3,'COMMERCIAL'),$4,COALESCE($5,'ACTIVE'),COALESCE($6::int,$27),
                 $7::numeric,$8::numeric,COALESCE($9,'INR'),$10,$11,COALESCE($12,FALSE),
                 $13::int,$14,$15::date,$15::date,
                 $16,$17,$18,$19,$20,$21,$22,COALESCE($23::jsonb,'{}'::jsonb),$24,$25::date,$26)
         RETURNING *`,
        [
          data.account_id,
          data.name.trim(),
          data.engagement_model ?? null,
          stageId,
          data.status ?? null,
          data.owner_user_id ?? null,
          data.estimated_value ?? null,
          data.proposed_value ?? null,
          data.currency ?? null,
          data.value_basis ?? null,
          data.value_period ?? null,
          data.value_unknown ?? null,
          data.probability ?? null,
          data.probability_reason ?? null,
          data.expected_close ?? null,
          data.problem ?? null,
          data.desired_outcome ?? null,
          data.decision_process ?? null,
          data.approval_dependency ?? null,
          data.objections ?? null,
          data.win_criteria ?? null,
          data.scope_summary ?? null,
          data.scope ? JSON.stringify(data.scope) : null,
          data.next_step ?? null,
          data.next_step_due ?? null,
          req.currentUser.id,
          // the relationship owner leads it unless somebody else is named
          account.owner_user_id ?? req.currentUser.id,
        ],
      );
      const opportunity = rows[0];

      await recordHistory(client, {
        opportunityId: opportunity.id,
        field: 'created',
        to: opportunity.name,
        actorId: req.currentUser.id,
      });

      // a second deal on an organization is worth seeing in its history
      await logActivity(client, {
        accountId: data.account_id,
        type: 'NOTE',
        actorId: req.currentUser.id,
        subject: `Opportunity opened: ${opportunity.name}`,
      });

      await refreshPrimaryOpportunity(client, data.account_id);
      return opportunity;
    });

    res.status(201).json({ opportunity: await getOpportunity(created.id) });
  }),
);

// ---------------------------------------------------------------- update

const TRACKED_FIELDS = [
  'name', 'engagement_model', 'owner_user_id', 'estimated_value', 'proposed_value',
  'agreed_value', 'collected_value', 'currency', 'value_basis', 'value_period',
  'value_unknown', 'probability', 'probability_reason', 'expected_close',
  'problem', 'desired_outcome', 'decision_process', 'approval_dependency',
  'objections', 'win_criteria', 'scope_summary', 'next_step', 'next_step_due', 'status',
];

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = opportunityInput.partial().omit({ account_id: true }).parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);

    await withTransaction(async (client) => {
      const fields = [];
      const params = [];
      const set = (column, value) => {
        params.push(value);
        fields.push(`${column} = $${params.length}`);
      };

      for (const key of TRACKED_FIELDS) {
        if (data[key] === undefined) continue;
        set(key, data[key] === '' ? null : data[key]);
      }
      if (data.scope !== undefined) set('scope', JSON.stringify(data.scope));

      // a slipping close date is counted, not quietly overwritten
      if (data.expected_close !== undefined
          && String(data.expected_close ?? '') !== String(existing.expected_close ?? '')) {
        fields.push('close_date_changes = close_date_changes + 1');
        if (!existing.original_close && existing.expected_close) {
          set('original_close', existing.expected_close);
        }
      }

      if (!fields.length) return;

      params.push(id);
      await client.query(
        `UPDATE opportunities SET ${fields.join(', ')}, updated_at = now()
          WHERE id = $${params.length}`,
        params,
      );

      for (const key of TRACKED_FIELDS) {
        if (data[key] === undefined) continue;
        const before = existing[key];
        const after = data[key];
        if (String(before ?? '') === String(after ?? '')) continue;
        await recordHistory(client, {
          opportunityId: id,
          field: key,
          from: before,
          to: after,
          actorId: req.currentUser.id,
        });
      }

      // handing the deal to someone else is recorded, so a reassignment cannot
      // rewrite who was accountable last quarter
      if (data.owner_user_id !== undefined && data.owner_user_id !== existing.owner_user_id) {
        await recordOwnershipChange(client, {
          entityType: 'OPPORTUNITY',
          entityId: id,
          from: existing.owner_user_id,
          to: data.owner_user_id,
          actorId: req.currentUser.id,
        });
      }

      await syncAccountMirror(client, existing.account_id);
    });

    res.json({ opportunity: await getOpportunity(id) });
  }),
);

// ---------------------------------------------------------------- stage

const stageInput = z.object({
  stage_id: z.number().int().positive(),
  reason: z.string().max(1000).optional(),
  // settlement detail, required by the rules below when the stage is terminal
  outcome_reason: z.string().max(2000).optional(),
  revisit_on: z.string().min(8).nullable().optional(),
  agreement_type: z.string().max(120).optional(),
  agreement_date: z.string().min(8).optional(),
  agreement_link: z.string().max(500).optional(),
  agreed_value: z.number().min(0).nullable().optional(),
  financial_status: z.enum(FINANCIAL_STATUSES).optional(),
});

router.post(
  '/:id/stage',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = stageInput.parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);

    const stage = await loadStageMove(data.stage_id, existing.stage_id);
    await withTransaction((client) => moveOpportunityStage(client, {
      opportunity: existing, stage, data, actor: req.currentUser,
    }));

    res.json({ opportunity: await getOpportunity(id) });
  }),
);

// ---------------------------------------------------------------- pause / revive

router.post(
  '/:id/status',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const { status, reason, revisit_on: revisitOn } = z
      .object({
        status: z.enum(OPPORTUNITY_STATUSES),
        reason: z.string().max(2000).optional(),
        revisit_on: z.string().min(8).nullable().optional(),
      })
      .parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);

    if (['ON_HOLD', 'NURTURE', 'LOST'].includes(status) && !reason?.trim()) {
      throw badRequest('Say why — a paused or lost deal with no reason cannot be picked back up');
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE opportunities SET status = $1, outcome_reason = COALESCE($2, outcome_reason),
                revisit_on = COALESCE($3::date, revisit_on), updated_at = now()
          WHERE id = $4`,
        [status, reason ?? null, revisitOn ?? null, id],
      );
      await recordHistory(client, {
        opportunityId: id, field: 'status', from: existing.status, to: status,
        reason: reason ?? null, actorId: req.currentUser.id,
      });
      await syncAccountMirror(client, existing.account_id);
    });

    res.json({ opportunity: await getOpportunity(id) });
  }),
);

// ---------------------------------------------------------------- requirements

const requirementInput = z.object({
  category: z.enum(REQUIREMENT_CATEGORIES).optional(),
  description: z.string().min(2).max(4000),
  importance: z.enum(REQUIREMENT_IMPORTANCE).optional(),
  status: z.enum(REQUIREMENT_STATUSES).optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  due_date: z.string().min(8).nullable().optional(),
  evidence_url: z.string().max(500).nullable().optional(),
  task_id: z.number().int().positive().nullable().optional(),
});

router.get(
  '/:id/requirements',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await loadOpportunity(id))) throw notFound('Opportunity not found');
    const requirements = await listRequirements(id);
    res.json({ requirements, top_blocker: topBlocker(requirements) });
  }),
);

router.post(
  '/:id/requirements',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = requirementInput.parse(req.body);
    const id = Number(req.params.id);
    await mustEdit(req.currentUser, id);

    const { rows } = await query(
      `INSERT INTO opportunity_requirements
         (opportunity_id, category, description, importance, status, owner_user_id,
          due_date, evidence_url, task_id, position, created_by)
       VALUES ($1,COALESCE($2,'OTHER'),$3,COALESCE($4,'SHOULD_HAVE'),COALESCE($5,'OPEN'),
               $6,$7::date,$8,$9,
               (SELECT COALESCE(MAX(position),0)+1 FROM opportunity_requirements WHERE opportunity_id = $1),
               $10)
       RETURNING *`,
      [
        id, data.category ?? null, data.description.trim(), data.importance ?? null,
        data.status ?? null, data.owner_user_id ?? null, data.due_date ?? null,
        data.evidence_url ?? null, data.task_id ?? null, req.currentUser.id,
      ],
    );
    res.status(201).json({ requirement: rows[0] });
  }),
);

router.patch(
  '/:opportunityId/requirements/:requirementId',
  asyncHandler(async (req, res) => {
    const data = requirementInput.partial().parse(req.body);
    const opportunityId = Number(req.params.opportunityId);
    await mustEdit(req.currentUser, opportunityId);

    const fields = [];
    const params = [];
    for (const key of ['category', 'description', 'importance', 'status',
      'owner_user_id', 'due_date', 'evidence_url', 'task_id']) {
      if (data[key] === undefined) continue;
      params.push(data[key] === '' ? null : data[key]);
      fields.push(`${key} = $${params.length}`);
    }
    if (!fields.length) throw badRequest('Nothing to update');

    params.push(Number(req.params.requirementId), opportunityId);
    const { rows } = await query(
      `UPDATE opportunity_requirements SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length - 1} AND opportunity_id = $${params.length}
        RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Requirement not found');
    res.json({ requirement: rows[0] });
  }),
);

router.delete(
  '/:opportunityId/requirements/:requirementId',
  asyncHandler(async (req, res) => {
    const opportunityId = Number(req.params.opportunityId);
    await mustEdit(req.currentUser, opportunityId);
    await query('DELETE FROM opportunity_requirements WHERE id = $1 AND opportunity_id = $2',
      [Number(req.params.requirementId), opportunityId]);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- stakeholders on a deal

router.post(
  '/:id/contacts',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const { contact_id: contactId, role, involvement, notes } = z
      .object({
        contact_id: z.number().int().positive(),
        role: z.enum(CONTACT_ROLES).optional(),
        involvement: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);

    // the contact has to belong to the organization this deal is with
    const { rows: contactRows } = await query(
      'SELECT id FROM account_contacts WHERE id = $1 AND account_id = $2',
      [contactId, existing.account_id],
    );
    if (!contactRows[0]) throw badRequest('That contact is not at this organization');

    const { rows } = await query(
      `INSERT INTO opportunity_contacts (opportunity_id, contact_id, role, involvement, notes)
       VALUES ($1,$2,COALESCE($3,'STAKEHOLDER'),$4,$5)
       ON CONFLICT (opportunity_id, contact_id, role)
         DO UPDATE SET involvement = EXCLUDED.involvement, notes = EXCLUDED.notes
       RETURNING *`,
      [id, contactId, role ?? null, involvement ?? null, notes ?? null],
    );
    res.status(201).json({ link: rows[0] });
  }),
);

router.delete(
  '/:id/contacts/:contactId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await mustEdit(req.currentUser, id);
    await query(
      `DELETE FROM opportunity_contacts WHERE opportunity_id = $1 AND contact_id = $2
        ${req.query.role ? 'AND role = $3' : ''}`,
      req.query.role
        ? [id, Number(req.params.contactId), req.query.role]
        : [id, Number(req.params.contactId)],
    );
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- archive

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);
    await withTransaction(async (client) => {
      await client.query('UPDATE opportunities SET is_archived = TRUE, updated_at = now() WHERE id = $1', [id]);
      await refreshPrimaryOpportunity(client, existing.account_id);
    });
    res.json({ ok: true, archived: true });
  }),
);

export default router;
