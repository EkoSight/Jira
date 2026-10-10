import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { notify } from '../services/activity.js';
import {
  CONTACT_ROLES, ENGAGEMENT_MODELS, FINANCIAL_STATUSES, OPPORTUNITY_STATUSES,
  REQUIREMENT_CATEGORIES, REQUIREMENT_IMPORTANCE, REQUIREMENT_STATUSES,
  acknowledgeHandover, canWorkOnOpportunity, dealBoard, getOpportunity, listHandovers,
  listHistory, listOpportunities, listRequirements, mustBeActiveUser, pendingHandoversFor,
  recordHandover, recordHistory, recordOwnershipChange, refreshPrimaryOpportunity,
  setNextAction, syncAccountMirror, topBlocker,
} from '../services/opportunities.js';
import { logActivity } from '../services/crm.js';
import { ORDER_KINDS, addOrder, addProposal, applyStageMove } from '../services/dealMoves.js';
import { RULE_KEYS, STAGE_RULES, problemWithNextAction } from '../services/dealRules.js';
import {
  PROPOSAL_STATUSES, addInvoice, addPayment, cancelInvoice, cancelOrder, commercialRecord,
  setProposalStatus, voidPayment,
} from '../services/commercial.js';
import { WAITING_ON, clearWaiting, problemWithRevisit, setWaiting } from '../services/dealPauses.js';
import { COMMITMENT_OUTCOMES, addCommitment, listCommitments, resolveCommitment } from '../services/commitments.js';

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

/**
 * The deal, if this person may work on it: whoever owns it, owes its next
 * move, is its escalation point, helps on it, leads the relationship, created
 * it, or manages the pipeline.
 */
async function mustEdit(user, id) {
  const row = await loadOpportunity(id);
  if (!row) throw notFound('Opportunity not found');
  if (!(await canWorkOnOpportunity(user, row))) throw forbidden('You cannot change this opportunity');
  return row;
}

/**
 * Who may hand the deal itself to someone else, or archive it: its owner, the
 * relationship owner, whoever created it, or a pipeline manager. Owing the next
 * move, or helping, is not the same as deciding who leads.
 */
const mayReassign = (user, row) =>
  hasPermission(user, 'crm.manage.any')
  || row.owner_user_id === user.id
  || row.relationship_owner_id === user.id
  || row.created_by === user.id;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use a date like 2026-10-14');
const link = z.string().max(500).nullable().optional();

const proposalInput = z.object({
  title: z.string().max(200).nullable().optional(),
  sent_on: day,
  amount: z.number().min(0).nullable().optional(),
  currency: z.string().max(8).optional(),
  valid_until: day.nullable().optional(),
  link,
  notes: z.string().max(4000).nullable().optional(),
});

const orderInput = z.object({
  kind: z.enum(ORDER_KINDS).optional(),
  reference: z.string().max(200).nullable().optional(),
  received_on: day,
  amount: z.number().min(0).nullable().optional(),
  currency: z.string().max(8).optional(),
  link,
  notes: z.string().max(4000).nullable().optional(),
});

const invoiceInput = z.object({
  order_id: z.number().int().positive().nullable().optional(),
  number: z.string().max(120).nullable().optional(),
  issued_on: day,
  amount: z.number().min(0),
  currency: z.string().max(8).optional(),
  due_on: day.nullable().optional(),
  link,
  notes: z.string().max(4000).nullable().optional(),
});

const paymentInput = z.object({
  invoice_id: z.number().int().positive().nullable().optional(),
  received_on: day,
  amount: z.number().positive(),
  currency: z.string().max(8).optional(),
  reference: z.string().max(200).nullable().optional(),
  link,
  notes: z.string().max(4000).nullable().optional(),
});

const opportunityInput = z.object({
  account_id: z.number().int().positive(),
  name: z.string().min(2).max(200),
  engagement_model: z.enum(ENGAGEMENT_MODELS).optional(),
  stage_id: z.number().int().positive().nullable().optional(),
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  escalation_owner_id: z.number().int().positive().nullable().optional(),

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
  next_step_owner_id: z.number().int().positive().nullable().optional(),

  // why a value or an owner changed, kept on the deal's history
  reason: z.string().max(2000).nullable().optional(),
});

// ---------------------------------------------------------------- list

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const opportunities = await listOpportunities({
      accountId: req.query.account_id,
      ownerId: req.query.owner_id,
      nextOwnerId: req.query.next_owner_id,
      stageId: req.query.stage_id,
      segmentId: req.query.segment_id,
      departmentId: req.query.department_id,
      status: req.query.status,
      model: req.query.model,
      openOnly: req.query.open === 'true',
      closingBefore: req.query.closing_before,
      search: req.query.search,
      involving: req.query.mine === 'true' ? req.currentUser.id : undefined,
      limit: req.query.limit,
    });
    res.json({ opportunities });
  }),
);

/**
 * The board: one card per live deal, for every kind of organization. A
 * customer's second deal is on it like any lead's first.
 */
router.get(
  '/board',
  asyncHandler(async (req, res) => {
    res.json(await dealBoard({
      ownerId: req.query.owner_id,
      nextOwnerId: req.query.next_owner_id,
      departmentId: req.query.department_id,
      segmentId: req.query.segment_id,
      accountType: req.query.account_type,
      state: req.query.state,
      search: req.query.search,
      involving: req.query.mine === 'true' ? req.currentUser.id : undefined,
    }));
  }),
);

/** What a stage rule means, so every screen words it the same way. */
router.get(
  '/stage-rules',
  asyncHandler(async (req, res) => {
    res.json({ rules: RULE_KEYS.map((key) => ({ key, ...STAGE_RULES[key] })) });
  }),
);

/** Handovers waiting for the signed-in person to say they have it. */
router.get(
  '/handovers/mine',
  asyncHandler(async (req, res) => {
    res.json({ handovers: await pendingHandoversFor(req.currentUser.id) });
  }),
);

router.post(
  '/handovers/:handoverId/acknowledge',
  asyncHandler(async (req, res) => {
    const handover = await acknowledgeHandover(Number(req.params.handoverId), req.currentUser);
    res.json({ handover });
  }),
);

// ---------------------------------------------------------------- detail

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const opportunity = await getOpportunity(id);
    if (!opportunity) throw notFound('Opportunity not found');

    const [requirements, history, contacts, handovers, commercial, commitments] = await Promise.all([
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
      listHandovers(id),
      commercialRecord(id),
      listCommitments({ opportunityId: id }),
    ]);

    res.json({
      opportunity,
      requirements,
      // the one thing most in the way, so the profile can lead with it
      top_blocker: topBlocker(requirements),
      history,
      contacts: contacts.rows,
      handovers,
      commercial,
      commitments,
      can_edit: await canWorkOnOpportunity(req.currentUser, await loadOpportunity(id)),
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

    // a next action is all three parts or none: half of one is a guess
    const givesNextAction = data.next_step || data.next_step_owner_id || data.next_step_due;
    if (givesNextAction) {
      const problem = problemWithNextAction({
        step: data.next_step, ownerId: data.next_step_owner_id, due: data.next_step_due,
      });
      if (problem) throw badRequest(problem, { code: 'NEXT_ACTION_INVALID' });
      await mustBeActiveUser(data.next_step_owner_id);
    }
    if (data.owner_user_id) await mustBeActiveUser(data.owner_user_id);
    if (data.escalation_owner_id) await mustBeActiveUser(data.escalation_owner_id);

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
          givesNextAction ? data.next_step.trim() : null,
          givesNextAction ? data.next_step_due : null,
          req.currentUser.id,
          // the relationship owner leads it unless somebody else is named
          account.owner_user_id ?? req.currentUser.id,
        ],
      );
      const opportunity = rows[0];

      // the parts this release added, set after the insert so the insert above
      // stays exactly as it shipped
      await client.query(
        `UPDATE opportunities
            SET next_step_owner_id = $2,
                next_step_set_at = CASE WHEN $2::int IS NOT NULL THEN now() END,
                next_step_set_by = CASE WHEN $2::int IS NOT NULL THEN $3::int END,
                escalation_owner_id = $4
          WHERE id = $1`,
        [opportunity.id, givesNextAction ? data.next_step_owner_id : null, req.currentUser.id,
          data.escalation_owner_id ?? null],
      );

      await recordHistory(client, {
        opportunityId: opportunity.id,
        field: 'created',
        to: opportunity.name,
        actorId: req.currentUser.id,
      });

      // a second deal on an organization is worth seeing in its history
      await logActivity(client, {
        accountId: data.account_id,
        opportunityId: opportunity.id,
        type: 'NOTE',
        actorId: req.currentUser.id,
        subject: `Opportunity opened: ${opportunity.name}`,
        source: 'MANUAL',
      });

      if (givesNextAction && data.next_step_owner_id !== req.currentUser.id) {
        await notify(client, {
          userId: data.next_step_owner_id,
          type: 'crm_next_action',
          title: `${opportunity.name}: the next move is yours`,
          body: `${data.next_step.trim()} — by ${String(data.next_step_due).slice(0, 10)}`,
          accountId: data.account_id,
        });
      }

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
  'objections', 'win_criteria', 'scope_summary', 'status', 'escalation_owner_id',
];

const VALUE_LABELS = {
  estimated_value: 'estimated value',
  proposed_value: 'proposed value',
  agreed_value: 'agreed value',
  collected_value: 'collected amount',
};

const NEXT_ACTION_FIELDS = ['next_step', 'next_step_due', 'next_step_owner_id'];
const amount = (value) => (value === null || value === undefined ? null : Number(value));

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = opportunityInput.partial().omit({ account_id: true }).parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);
    const reason = data.reason?.trim() || null;
    const live = ['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(existing.status);

    // ---- the changes that need a person to say why
    const ownerChanging = data.owner_user_id !== undefined && data.owner_user_id !== existing.owner_user_id;
    const escalationChanging = data.escalation_owner_id !== undefined
      && data.escalation_owner_id !== existing.escalation_owner_id;
    if ((ownerChanging || escalationChanging) && !mayReassign(req.currentUser, existing)) {
      throw forbidden('Only the deal owner, the relationship owner or a pipeline manager can change who leads it');
    }
    if (ownerChanging) {
      if (!data.owner_user_id && live) {
        throw badRequest('A live deal needs an owner — hand it to someone rather than leaving it with nobody');
      }
      if (existing.owner_user_id && !reason) {
        throw badRequest('Say why the deal is changing hands — the reason stays on its history',
          { code: 'REASON_REQUIRED', field: 'owner_user_id' });
      }
      if (data.owner_user_id) await mustBeActiveUser(data.owner_user_id);
    }
    if (escalationChanging && data.escalation_owner_id) await mustBeActiveUser(data.escalation_owner_id);

    for (const [key, label] of Object.entries(VALUE_LABELS)) {
      if (data[key] === undefined) continue;
      const before = amount(existing[key]);
      // filling in a blank needs no explanation; changing a figure somebody
      // relied on does
      if (before !== null && before !== amount(data[key]) && !reason) {
        throw badRequest(`Say why the ${label} changed — the reason stays on the deal's history`,
          { code: 'REASON_REQUIRED', field: key });
      }
    }
    if (data.collected_value !== undefined) {
      const { rows } = await query(
        'SELECT 1 FROM opportunity_payments WHERE opportunity_id = $1 LIMIT 1', [id],
      );
      if (rows[0]) {
        throw badRequest('Collected is worked out from the payments recorded — record or void a payment instead');
      }
    }

    const touchesNextAction = NEXT_ACTION_FIELDS.some((key) => data[key] !== undefined);
    if (touchesNextAction && live && NEXT_ACTION_FIELDS.some((key) => data[key] === null || data[key] === '')) {
      throw badRequest('A live deal always has a next action — change it rather than clearing it',
        { code: 'NEXT_ACTION_INVALID' });
    }

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
      // a settled deal's next step is history, written as given
      if (touchesNextAction && !live) {
        for (const key of NEXT_ACTION_FIELDS) {
          if (data[key] !== undefined) set(key, data[key] === '' ? null : data[key]);
        }
      }

      // a slipping close date is counted, not quietly overwritten
      if (data.expected_close !== undefined
          && String(data.expected_close ?? '') !== String(existing.expected_close ?? '')) {
        fields.push('close_date_changes = close_date_changes + 1');
        if (!existing.original_close && existing.expected_close) {
          set('original_close', existing.expected_close);
        }
      }

      if (fields.length) {
        params.push(id);
        await client.query(
          `UPDATE opportunities SET ${fields.join(', ')}, updated_at = now()
            WHERE id = $${params.length}`,
          params,
        );

        for (const key of [...TRACKED_FIELDS, ...(live ? [] : NEXT_ACTION_FIELDS)]) {
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
            reason,
          });
        }
      }

      // handing the deal to someone else is recorded, so a reassignment cannot
      // rewrite who was accountable last quarter — and the new owner is told
      if (ownerChanging) {
        await recordOwnershipChange(client, {
          entityType: 'OPPORTUNITY',
          entityId: id,
          from: existing.owner_user_id,
          to: data.owner_user_id,
          actorId: req.currentUser.id,
          reason,
        });
        if (data.owner_user_id) {
          await recordHandover(client, {
            opportunity: existing, role: 'OWNER', fromUserId: existing.owner_user_id,
            toUserId: data.owner_user_id, reason, owed: existing.next_step ?? null, actor: req.currentUser,
          });
        }
      }
      if (escalationChanging && data.escalation_owner_id) {
        await recordHandover(client, {
          opportunity: existing, role: 'ESCALATION', fromUserId: existing.escalation_owner_id,
          toUserId: data.escalation_owner_id, reason, actor: req.currentUser,
        });
      }

      if (touchesNextAction && live) {
        const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1', [id]);
        await setNextAction(client, {
          opportunity: rows[0],
          step: data.next_step !== undefined ? data.next_step : rows[0].next_step,
          ownerId: data.next_step_owner_id !== undefined ? data.next_step_owner_id : rows[0].next_step_owner_id,
          due: data.next_step_due !== undefined ? data.next_step_due : rows[0].next_step_due,
          actor: req.currentUser,
          reason,
        });
      }

      await syncAccountMirror(client, existing.account_id);
    });

    res.json({ opportunity: await getOpportunity(id) });
  }),
);

// ---------------------------------------------------------------- next action

/** Sets what happens next, who owes it and by when — all three. */
router.post(
  '/:id/next-action',
  asyncHandler(async (req, res) => {
    const data = z.object({
      next_step: z.string().max(2000),
      next_step_owner_id: z.number().int().positive(),
      next_step_due: day,
      reason: z.string().max(2000).nullable().optional(),
    }).parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);

    await withTransaction((client) => setNextAction(client, {
      opportunity: existing,
      step: data.next_step,
      ownerId: data.next_step_owner_id,
      due: data.next_step_due,
      actor: req.currentUser,
      reason: data.reason?.trim() || null,
    }));
    res.json({ opportunity: await getOpportunity(id) });
  }),
);

// ---------------------------------------------------------------- people

router.post(
  '/:id/collaborators',
  asyncHandler(async (req, res) => {
    const { user_id: userId, role } = z.object({
      user_id: z.number().int().positive(),
      role: z.string().max(200).nullable().optional(),
    }).parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);
    const person = await mustBeActiveUser(userId);

    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO opportunity_collaborators (opportunity_id, user_id, role, added_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (opportunity_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING (xmax = 0) AS inserted`,
        [id, userId, role?.trim() || null, req.currentUser.id],
      );
      if (rows[0].inserted) {
        await logActivity(client, {
          accountId: existing.account_id, opportunityId: id, type: 'NOTE', actorId: req.currentUser.id,
          subject: `${person.full_name} is helping on ${existing.name}`,
          body: role?.trim() || null, source: 'MANUAL',
        });
        if (userId !== req.currentUser.id) {
          await notify(client, {
            userId, type: 'crm_collaborator',
            title: `You are helping on ${existing.name}`,
            body: role?.trim() || null, accountId: existing.account_id,
          });
        }
      }
    });
    res.status(201).json({ opportunity: await getOpportunity(id) });
  }),
);

router.delete(
  '/:id/collaborators/:userId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);
    const userId = Number(req.params.userId);
    await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM opportunity_collaborators WHERE opportunity_id = $1 AND user_id = $2', [id, userId],
      );
      if (rowCount) {
        await logActivity(client, {
          accountId: existing.account_id, opportunityId: id, type: 'NOTE', actorId: req.currentUser.id,
          subject: 'A collaborator was taken off the deal', meta: { user_id: userId }, source: 'MANUAL',
        });
      }
    });
    res.json({ opportunity: await getOpportunity(id) });
  }),
);

router.get(
  '/:id/handovers',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await loadOpportunity(id))) throw notFound('Opportunity not found');
    res.json({ handovers: await listHandovers(id) });
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
  // what happens next, set in the same step as the move
  next_step: z.string().max(2000).nullable().optional(),
  next_step_owner_id: z.number().int().positive().nullable().optional(),
  next_step_due: z.string().min(8).nullable().optional(),
  // the evidence the stage asks for, recorded in the same step
  proposal: proposalInput.optional(),
  order: orderInput.optional(),
  // a manager moving a deal without the evidence, and saying why
  override_reason: z.string().max(2000).optional(),
});

router.post(
  '/:id/stage',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = stageInput.parse(req.body);
    const id = Number(req.params.id);
    await mustEdit(req.currentUser, id);

    await withTransaction((client) => applyStageMove(client, {
      opportunityId: id, stageId: data.stage_id, data, actor: req.currentUser,
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
    // a pause comes back on a date, rather than being flagged every day or forgotten
    if (['ON_HOLD', 'NURTURE'].includes(status)) {
      const problem = problemWithRevisit(revisitOn);
      if (problem) throw badRequest(problem, { code: 'REVISIT_REQUIRED' });
    }

    await withTransaction(async (client) => {
      if (existing.waiting_on && status !== 'ACTIVE') {
        await clearWaiting(client, { opportunity: existing, actor: req.currentUser, reason: `Status changed to ${status}` });
      }
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

// ---------------------------------------------------------------- waiting, on purpose

/**
 * Pauses a live deal until a date: waiting on the customer, a third party, or
 * us. It is not chased until then, and comes back on the date. Its next action
 * becomes checking back.
 */
router.post(
  '/:id/waiting',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = z.object({
      waiting_on: z.enum(WAITING_ON),
      reason: z.string().max(2000),
      until: day,
      owner_id: z.number().int().positive().nullable().optional(),
    }).parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);
    await withTransaction((client) => setWaiting(client, {
      opportunity: existing, waitingOn: data.waiting_on, reason: data.reason, until: data.until,
      ownerId: data.owner_id ?? null, actor: req.currentUser,
    }));
    res.json({ opportunity: await getOpportunity(id) });
  }),
);

router.delete(
  '/:id/waiting',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);
    const reason = typeof req.query.reason === 'string' ? req.query.reason.slice(0, 2000) : null;
    await withTransaction((client) => clearWaiting(client, { opportunity: existing, actor: req.currentUser, reason }));
    res.json({ opportunity: await getOpportunity(id) });
  }),
);

// ---------------------------------------------------------------- what the customer committed to

router.get(
  '/:id/commitments',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await loadOpportunity(id))) throw notFound('Opportunity not found');
    res.json({ commitments: await listCommitments({ opportunityId: id }) });
  }),
);

router.post(
  '/:id/commitments',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = z.object({
      what: z.string().max(2000),
      due_on: day.nullable().optional(),
      contact_id: z.number().int().positive().nullable().optional(),
    }).parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);
    if (data.contact_id) {
      const { rows } = await query('SELECT 1 FROM account_contacts WHERE id = $1 AND account_id = $2',
        [data.contact_id, existing.account_id]);
      if (!rows[0]) throw badRequest('That contact is not at this organization');
    }
    const commitment = await withTransaction((client) => addCommitment(client, {
      accountId: existing.account_id, opportunityId: id, contactId: data.contact_id ?? null,
      what: data.what, dueOn: data.due_on ?? null, actor: req.currentUser,
    }));
    res.status(201).json({ commitment, commitments: await listCommitments({ opportunityId: id }) });
  }),
);

router.post(
  '/commitments/:commitmentId/resolve',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = z.object({
      status: z.enum(COMMITMENT_OUTCOMES),
      note: z.string().max(2000).nullable().optional(),
    }).parse(req.body);
    const { rows } = await query('SELECT * FROM customer_commitments WHERE id = $1', [Number(req.params.commitmentId)]);
    if (!rows[0]) throw notFound('Commitment not found');
    // whoever may work the deal (or, for one on no deal, the organization) may close it
    if (rows[0].opportunity_id) await mustEdit(req.currentUser, rows[0].opportunity_id);
    else if (!hasPermission(req.currentUser, 'crm.manage.any')) {
      const { rows: account } = await query('SELECT * FROM accounts WHERE id = $1', [rows[0].account_id]);
      if (![account[0]?.owner_user_id, account[0]?.follower_user_id, account[0]?.created_by].includes(req.currentUser.id)) {
        throw forbidden('You cannot change this organization');
      }
    }
    const commitment = await withTransaction((client) => resolveCommitment(client, {
      commitmentId: rows[0].id, status: data.status, note: data.note?.trim() || null, actor: req.currentUser,
    }));
    res.json({ commitment });
  }),
);

// ---------------------------------------------------------------- the commercial record

router.get(
  '/:id/commercial',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await loadOpportunity(id))) throw notFound('Opportunity not found');
    res.json(await commercialRecord(id));
  }),
);

/** Records a step in the commercial record and answers with the whole record. */
const commercialStep = (handler) => asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await mustEdit(req.currentUser, id);
  await withTransaction((client) => handler(client, existing, req));
  res.status(201).json({ ...(await commercialRecord(id)), opportunity: await getOpportunity(id) });
});

router.post('/:id/proposals', requirePermission('crm.activity.log'), commercialStep(
  (client, opportunity, req) => addProposal(client, {
    opportunity, proposal: proposalInput.parse(req.body), actor: req.currentUser,
  }),
));

router.post('/:id/proposals/:proposalId/status', requirePermission('crm.activity.log'), commercialStep(
  (client, opportunity, req) => {
    const data = z.object({
      status: z.enum(PROPOSAL_STATUSES), notes: z.string().max(4000).nullable().optional(),
    }).parse(req.body);
    return setProposalStatus(client, {
      opportunity, proposalId: Number(req.params.proposalId), status: data.status,
      notes: data.notes?.trim() || null, actor: req.currentUser,
    });
  },
));

router.post('/:id/orders', requirePermission('crm.activity.log'), commercialStep(
  (client, opportunity, req) => addOrder(client, {
    opportunity, order: orderInput.parse(req.body), actor: req.currentUser,
  }),
));

router.post('/:id/orders/:orderId/cancel', requirePermission('crm.activity.log'), commercialStep(
  (client, opportunity, req) => cancelOrder(client, {
    opportunity, orderId: Number(req.params.orderId),
    reason: z.object({ reason: z.string().max(2000) }).parse(req.body).reason, actor: req.currentUser,
  }),
));

router.post('/:id/invoices', requirePermission('crm.activity.log'), commercialStep(
  (client, opportunity, req) => addInvoice(client, {
    opportunity, invoice: invoiceInput.parse(req.body), actor: req.currentUser,
  }),
));

router.post('/:id/invoices/:invoiceId/cancel', requirePermission('crm.activity.log'), commercialStep(
  (client, opportunity, req) => cancelInvoice(client, {
    opportunity, invoiceId: Number(req.params.invoiceId),
    reason: z.object({ reason: z.string().max(2000) }).parse(req.body).reason, actor: req.currentUser,
  }),
));

router.post('/:id/payments', requirePermission('crm.activity.log'), commercialStep(
  (client, opportunity, req) => addPayment(client, {
    opportunity, payment: paymentInput.parse(req.body), actor: req.currentUser,
  }),
));

router.post('/:id/payments/:paymentId/void', requirePermission('crm.activity.log'), commercialStep(
  (client, opportunity, req) => voidPayment(client, {
    opportunity, paymentId: Number(req.params.paymentId),
    reason: z.object({ reason: z.string().max(2000) }).parse(req.body).reason, actor: req.currentUser,
  }),
));

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
    if (!mayReassign(req.currentUser, existing)) {
      throw forbidden('Only the deal owner, the relationship owner or a pipeline manager can archive it');
    }
    await withTransaction(async (client) => {
      await client.query('UPDATE opportunities SET is_archived = TRUE, updated_at = now() WHERE id = $1', [id]);
      await refreshPrimaryOpportunity(client, existing.account_id);
    });
    res.json({ ok: true, archived: true });
  }),
);

export default router;
