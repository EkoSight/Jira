import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import {
  ENGAGEMENT_STATES, MILESTONE_STATUSES,
  canEditEngagement, createKickoffTasks, createOrLinkEngagement, getEngagement,
  listEngagements, listMilestones,
} from '../services/engagements.js';
import { logActivity } from '../services/crm.js';

const router = Router();

async function loadRaw(id) {
  const { rows } = await query(
    `SELECT e.*, a.owner_user_id AS relationship_owner_id
       FROM engagements e JOIN accounts a ON a.id = e.account_id WHERE e.id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function mustEdit(user, id) {
  const row = await loadRaw(id);
  if (!row) throw notFound('Engagement not found');
  if (!canEditEngagement(user, row)) throw forbidden('You cannot change this engagement');
  return row;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({
      engagements: await listEngagements({
        accountId: req.query.account_id,
        ownerId: req.query.owner_id,
        state: req.query.state,
        liveOnly: req.query.live === 'true',
      }),
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const engagement = await getEngagement(id);
    if (!engagement) throw notFound('Engagement not found');

    const tasks = await query(
      `SELECT t.id, t.ref, t.title, t.due_date, t.assignee_id,
              s.name AS status_name, s.stage,
              u.full_name AS assignee_name, u.avatar_color AS assignee_color
         FROM tasks t
         JOIN workflow_statuses s ON s.id = t.status_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.engagement_id = $1 AND t.is_archived = FALSE
        ORDER BY (s.stage IN ('done','cancelled')), t.due_date NULLS LAST, t.id`,
      [id],
    );

    res.json({
      engagement,
      milestones: await listMilestones(id),
      tasks: tasks.rows,
      can_edit: canEditEngagement(req.currentUser, await loadRaw(id)),
    });
  }),
);

/**
 * Turns a won deal into delivery, or hands back the delivery already running.
 *
 * Idempotent: the unique index on opportunity_id means pressing this twice, a
 * retry, or re-winning the same deal all resolve to one engagement rather than
 * splitting the work in two. The commercial value is referenced, never copied.
 */
router.post(
  '/from-opportunity/:opportunityId',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().max(200).optional(),
        owner_user_id: z.number().int().positive().nullable().optional(),
        kickoff_on: z.string().min(8).nullable().optional(),
        create_kickoff_tasks: z.boolean().optional(),
      })
      .parse(req.body ?? {});

    const opportunityId = Number(req.params.opportunityId);
    const { rows } = await query(
      `SELECT o.*, a.owner_user_id AS relationship_owner_id
         FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE o.id = $1`,
      [opportunityId],
    );
    const opportunity = rows[0];
    if (!opportunity) throw notFound('Opportunity not found');
    if (opportunity.status !== 'WON') {
      throw badRequest('Delivery starts once the deal is won — this one is not');
    }
    if (!canEditEngagement(req.currentUser, opportunity)) {
      throw forbidden('You cannot start delivery on this deal');
    }

    const result = await withTransaction(async (client) => {
      const linked = await createOrLinkEngagement(client, {
        opportunity,
        actor: req.currentUser,
        name: data.name,
        ownerUserId: data.owner_user_id ?? undefined,
        kickoffOn: data.kickoff_on ?? undefined,
      });

      if (linked.created && data.create_kickoff_tasks !== false) {
        const { rows: fresh } = await client.query(
          'SELECT * FROM engagements WHERE id = $1', [linked.engagement_id],
        );
        await createKickoffTasks(client, fresh[0], req.currentUser);
      }
      return linked;
    });

    res.status(result.created ? 201 : 200).json({
      engagement: await getEngagement(result.engagement_id),
      created: result.created,
    });
  }),
);

const engagementInput = z.object({
  name: z.string().min(2).max(200).optional(),
  state: z.enum(ENGAGEMENT_STATES).optional(),
  agreed_scope: z.string().max(20000).nullable().optional(),
  commitments: z.string().max(20000).nullable().optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  kickoff_on: z.string().min(8).nullable().optional(),
  review_cadence: z.string().max(200).nullable().optional(),
  next_review_on: z.string().min(8).nullable().optional(),
  blockers: z.string().max(20000).nullable().optional(),
  partner_feedback: z.string().max(20000).nullable().optional(),
});

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = engagementInput.parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);

    const fields = [];
    const params = [];
    for (const key of Object.keys(engagementInput.shape)) {
      if (data[key] === undefined) continue;
      params.push(data[key] === '' ? null : data[key]);
      fields.push(`${key} = $${params.length}`);
    }
    if (!fields.length) throw badRequest('Nothing to update');

    await withTransaction(async (client) => {
      params.push(id);
      await client.query(
        `UPDATE engagements SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
        params,
      );

      // a delivery going sideways is worth putting in the relationship history
      if (data.state && data.state !== existing.state) {
        await logActivity(client, {
          accountId: existing.account_id,
          opportunityId: existing.opportunity_id,
          engagementId: id,
          type: 'NOTE',
          actorId: req.currentUser.id,
          subject: `Delivery is now ${data.state.toLowerCase().replace('_', ' ')}`,
          body: data.blockers ?? null,
        });
      }
    });

    res.json({ engagement: await getEngagement(id) });
  }),
);

// ---------------------------------------------------------------- milestones

const milestoneInput = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(4000).nullable().optional(),
  due_date: z.string().min(8).nullable().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  task_id: z.number().int().positive().nullable().optional(),
});

router.post(
  '/:id/milestones',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = milestoneInput.parse(req.body);
    const id = Number(req.params.id);
    await mustEdit(req.currentUser, id);

    const { rows } = await query(
      `INSERT INTO engagement_milestones
         (engagement_id, title, description, due_date, status, task_id, position)
       VALUES ($1,$2,$3,$4::date,COALESCE($5,'PLANNED'),$6,
               (SELECT COALESCE(MAX(position),0)+1 FROM engagement_milestones WHERE engagement_id = $1))
       RETURNING *`,
      [id, data.title.trim(), data.description ?? null, data.due_date ?? null,
        data.status ?? null, data.task_id ?? null],
    );
    res.status(201).json({ milestone: rows[0] });
  }),
);

/**
 * Accepting a milestone is the partner's word, not ours.
 * It is recorded with who marked it and when, so "delivered" and "accepted"
 * stay different facts.
 */
router.patch(
  '/:engagementId/milestones/:milestoneId',
  asyncHandler(async (req, res) => {
    const data = milestoneInput.partial().parse(req.body);
    const engagementId = Number(req.params.engagementId);
    await mustEdit(req.currentUser, engagementId);

    const fields = [];
    const params = [];
    for (const key of ['title', 'description', 'due_date', 'status', 'task_id']) {
      if (data[key] === undefined) continue;
      params.push(data[key] === '' ? null : data[key]);
      fields.push(`${key} = $${params.length}`);
    }
    if (!fields.length) throw badRequest('Nothing to update');

    if (data.status === 'ACCEPTED') {
      params.push(req.currentUser.id);
      fields.push(`accepted_by = $${params.length}`, 'accepted_at = now()');
    } else if (data.status) {
      fields.push('accepted_by = NULL', 'accepted_at = NULL');
    }

    params.push(Number(req.params.milestoneId), engagementId);
    const { rows } = await query(
      `UPDATE engagement_milestones SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length - 1} AND engagement_id = $${params.length}
        RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Milestone not found');
    res.json({ milestone: rows[0] });
  }),
);

router.delete(
  '/:engagementId/milestones/:milestoneId',
  asyncHandler(async (req, res) => {
    const engagementId = Number(req.params.engagementId);
    await mustEdit(req.currentUser, engagementId);
    await query('DELETE FROM engagement_milestones WHERE id = $1 AND engagement_id = $2',
      [Number(req.params.milestoneId), engagementId]);
    res.json({ ok: true });
  }),
);

export default router;
