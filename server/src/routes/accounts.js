import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { notify } from '../services/activity.js';
import { ACCOUNT_TYPES, ACCOUNT_STATUSES, STAGE_KINDS, ACTIVITY_TYPES } from '../lib/crmConstants.js';
import {
  listAccounts,
  getAccount,
  listStages,
  pipeline,
  listActivities,
  logActivity,
  canEditAccount,
} from '../services/crm.js';
import { analyseAccounts } from '../services/accountInsights.js';
import { runAccountScan } from '../jobs/accountScanner.js';

const router = Router();

const slugify = (value) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const accountInput = z.object({
  name: z.string().min(2).max(200),
  type: z.enum(ACCOUNT_TYPES).optional(),
  stage_id: z.number().int().positive().nullable().optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  follower_user_id: z.number().int().positive().nullable().optional(),
  department_id: z.number().int().positive().nullable().optional(),
  value: z.number().min(0).nullable().optional(),
  currency: z.string().max(8).optional(),
  source: z.string().max(120).nullable().optional(),
  website: z.string().max(300).nullable().optional(),
  contact_name: z.string().max(160).nullable().optional(),
  contact_email: z.string().max(200).nullable().optional(),
  contact_phone: z.string().max(60).nullable().optional(),
  description: z.string().max(20000).nullable().optional(),
  next_step: z.string().max(2000).nullable().optional(),
  next_step_due: z.string().min(8).nullable().optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
});

// ---------------------------------------------------------------- pipeline & insights

router.get(
  '/pipeline',
  asyncHandler(async (req, res) => {
    res.json(
      await pipeline({
        ownerId: req.query.owner_id,
        departmentId: req.query.department_id,
        type: req.query.type || 'LEAD',
        involving: req.query.mine === 'true' ? req.currentUser.id : undefined,
        search: req.query.search,
      }),
    );
  }),
);

router.get(
  '/insights',
  asyncHandler(async (req, res) => {
    res.json(
      await analyseAccounts({
        ownerId: req.query.owner_id,
        departmentId: req.query.department_id,
      }),
    );
  }),
);

router.post(
  '/scan',
  asyncHandler(async (req, res) => {
    if (!hasPermission(req.currentUser, 'settings.manage')) {
      throw forbidden('Only an administrator can run the scan');
    }
    res.json(await runAccountScan({ force: req.body?.force === true }));
  }),
);

// ---------------------------------------------------------------- stages

router.get(
  '/stages',
  asyncHandler(async (req, res) => {
    res.json({ stages: await listStages({ activeOnly: req.query.active !== 'all' }) });
  }),
);

router.post(
  '/stages',
  requirePermission('crm.stages.manage'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().min(2).max(60),
        kind: z.enum(STAGE_KINDS).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        position: z.number().int().optional(),
      })
      .parse(req.body);

    const { rows } = await query(
      `INSERT INTO account_stages (name, slug, kind, color, position)
       VALUES ($1,$2,COALESCE($3,'open'),COALESCE($4,'#64748b'),
               COALESCE($5,(SELECT COALESCE(MAX(position),0)+1 FROM account_stages)))
       RETURNING *`,
      [data.name, slugify(data.name), data.kind ?? null, data.color ?? null, data.position ?? null],
    );
    res.status(201).json({ stage: rows[0] });
  }),
);

router.patch(
  '/stages/:id',
  requirePermission('crm.stages.manage'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().min(2).max(60).optional(),
        kind: z.enum(STAGE_KINDS).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        position: z.number().int().optional(),
        is_active: z.boolean().optional(),
      })
      .parse(req.body);

    const fields = [];
    const params = [];
    for (const key of ['name', 'kind', 'color', 'position', 'is_active']) {
      if (data[key] !== undefined) {
        params.push(data[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (data.name !== undefined) {
      params.push(slugify(data.name));
      fields.push(`slug = $${params.length}`);
    }
    if (!fields.length) throw badRequest('Nothing to update');
    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE account_stages SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!rows[0]) throw notFound('Stage not found');
    res.json({ stage: rows[0] });
  }),
);

// ---------------------------------------------------------------- list & detail

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const accounts = await listAccounts({
      type: req.query.type,
      stageId: req.query.stage_id,
      ownerId: req.query.owner_id,
      departmentId: req.query.department_id,
      status: req.query.status,
      involving: req.query.mine === 'true' ? req.currentUser.id : undefined,
      search: req.query.search,
      limit: req.query.limit,
    });
    res.json({ accounts });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const account = await getAccount(Number(req.params.id));
    if (!account) throw notFound('Account not found');

    const [activities, tasks, goals] = await Promise.all([
      listActivities(account.id),
      query(
        `SELECT t.id, t.ref, t.title, t.due_date, t.priority, t.assignee_id, t.progress,
                s.name AS status_name, s.stage, s.color AS status_color,
                u.full_name AS assignee_name, u.avatar_color AS assignee_color
           FROM tasks t
           JOIN workflow_statuses s ON s.id = t.status_id
           LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.account_id = $1 AND t.is_archived = FALSE
          ORDER BY (s.stage IN ('done','cancelled')), t.due_date NULLS LAST, t.id`,
        [account.id],
      ),
      query(
        `SELECT id, title, status FROM objectives
          WHERE account_id = $1 AND is_archived = FALSE ORDER BY id`,
        [account.id],
      ),
    ]);

    res.json({
      account,
      activities,
      tasks: tasks.rows,
      goals: goals.rows,
      can_edit: canEditAccount(req.currentUser, account),
    });
  }),
);

// ---------------------------------------------------------------- create

router.post(
  '/',
  requirePermission('crm.create'),
  asyncHandler(async (req, res) => {
    const data = accountInput.parse(req.body);

    // a new lead lands in the first open stage unless one is named
    let stageId = data.stage_id;
    if (!stageId) {
      const { rows } = await query(
        `SELECT id FROM account_stages WHERE is_active = TRUE ORDER BY is_default DESC, position ASC LIMIT 1`,
      );
      stageId = rows[0]?.id ?? null;
    }

    const account = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO accounts
           (name, type, stage_id, owner_user_id, follower_user_id, department_id, value, currency,
            source, website, contact_name, contact_email, contact_phone, description,
            next_step, next_step_due, created_by, last_activity_at)
         VALUES ($1,COALESCE($2,'LEAD'),$3,COALESCE($4::int,$17),$5,COALESCE($6::int,$18),$7::numeric,COALESCE($8,'INR'),
                 $9,$10,$11,$12,$13,$14,$15,$16,$17,now())
         RETURNING *`,
        [
          data.name.trim(),
          data.type ?? null,
          stageId,
          data.owner_user_id ?? null,
          data.follower_user_id ?? null,
          data.department_id ?? null,
          data.value ?? null,
          data.currency ?? null,
          data.source ?? null,
          data.website ?? null,
          data.contact_name ?? null,
          data.contact_email ?? null,
          data.contact_phone ?? null,
          data.description ?? null,
          data.next_step ?? null,
          data.next_step_due ?? null,
          req.currentUser.id,
          req.currentUser.department_id,
        ],
      );
      const created = rows[0];
      await logActivity(client, {
        accountId: created.id,
        type: 'NOTE',
        actorId: req.currentUser.id,
        subject: 'Lead created',
        body: data.source ? `Source: ${data.source}` : null,
      });
      return created;
    });

    res.status(201).json({ account: await getAccount(account.id) });
  }),
);

// ---------------------------------------------------------------- update

const TRACKED = [
  'name', 'owner_user_id', 'follower_user_id', 'department_id', 'value', 'currency',
  'source', 'website', 'contact_name', 'contact_email', 'contact_phone', 'description',
  'next_step', 'next_step_due', 'status',
];

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = accountInput.partial().parse(req.body);
    const id = Number(req.params.id);

    const { rows: existingRows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
    const existing = existingRows[0];
    if (!existing) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, existing)) throw forbidden('You cannot edit this account');

    const fields = [];
    const params = [];
    for (const key of TRACKED) {
      if (data[key] === undefined) continue;
      params.push(data[key] === '' ? null : data[key]);
      fields.push(`${key} = $${params.length}`);
    }
    if (!fields.length) throw badRequest('Nothing to update');
    params.push(id);
    await query(
      `UPDATE accounts SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params,
    );

    // handing a lead to someone else tells them
    if (data.owner_user_id !== undefined && data.owner_user_id !== existing.owner_user_id) {
      await notify(null, {
        userId: data.owner_user_id,
        type: 'crm_assigned',
        title: `You are now leading ${existing.name}`,
        accountId: id,
      });
    }

    res.json({ account: await getAccount(id) });
  }),
);

// ---------------------------------------------------------------- move stage

router.post(
  '/:id/stage',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const { stage_id: stageId } = z.object({ stage_id: z.number().int().positive() }).parse(req.body);
    const id = Number(req.params.id);

    const { rows: existingRows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
    const existing = existingRows[0];
    if (!existing) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, existing)) throw forbidden('You cannot move this account');

    const { rows: stageRows } = await query(
      'SELECT s.*, (SELECT name FROM account_stages WHERE id = $2) AS from_name FROM account_stages s WHERE s.id = $1',
      [stageId, existing.stage_id],
    );
    const stage = stageRows[0];
    if (!stage) throw badRequest('Stage not found');

    // reaching a won/lost stage settles the deal's status; an open stage revives it
    const status = stage.kind === 'won' ? 'WON' : stage.kind === 'lost' ? 'LOST' : 'ACTIVE';

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE accounts SET stage_id = $1, status = $2, stage_changed_at = now(), updated_at = now() WHERE id = $3`,
        [stageId, status, id],
      );
      await logActivity(client, {
        accountId: id,
        type: 'STAGE_CHANGE',
        actorId: req.currentUser.id,
        subject: `Moved to ${stage.name}`,
        meta: { from: stage.from_name, to: stage.name },
      });
    });

    res.json({ account: await getAccount(id) });
  }),
);

// ---------------------------------------------------------------- convert

router.post(
  '/:id/convert',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const { type } = z.object({ type: z.enum(['CUSTOMER', 'PARTNER']) }).parse(req.body);
    const id = Number(req.params.id);

    const { rows: existingRows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
    const existing = existingRows[0];
    if (!existing) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, existing)) throw forbidden('You cannot convert this account');

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE accounts
            SET type = $1,
                converted_at = COALESCE(converted_at, now()),
                updated_at = now()
          WHERE id = $2`,
        [type, id],
      );
      await logActivity(client, {
        accountId: id,
        type: 'CONVERTED',
        actorId: req.currentUser.id,
        subject: type === 'CUSTOMER' ? 'Became a customer' : 'Became a partner',
        meta: { from: existing.type, to: type },
      });
    });

    res.json({ account: await getAccount(id) });
  }),
);

// ---------------------------------------------------------------- archive

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM accounts WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, rows[0])) throw forbidden('You cannot archive this account');

    await query('UPDATE accounts SET is_archived = TRUE, updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true, archived: true });
  }),
);

// ---------------------------------------------------------------- activities

router.get(
  '/:id/activities',
  asyncHandler(async (req, res) => {
    const account = await getAccount(Number(req.params.id));
    if (!account) throw notFound('Account not found');
    res.json({ activities: await listActivities(account.id) });
  }),
);

router.post(
  '/:id/activities',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        type: z.enum(ACTIVITY_TYPES),
        subject: z.string().max(300).nullable().optional(),
        body: z.string().max(20000).nullable().optional(),
        next_step: z.string().max(2000).nullable().optional(),
        next_step_due: z.string().min(8).nullable().optional(),
        task_id: z.number().int().positive().nullable().optional(),
        occurred_at: z.string().min(8).nullable().optional(),
      })
      .parse(req.body);
    const id = Number(req.params.id);

    const { rows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
    const account = rows[0];
    if (!account) throw notFound('Account not found');

    const activity = await withTransaction(async (client) => {
      const created = await logActivity(client, {
        accountId: id,
        type: data.type,
        actorId: req.currentUser.id,
        subject: data.subject ?? null,
        body: data.body ?? null,
        nextStep: data.next_step ?? null,
        taskId: data.task_id ?? null,
        occurredAt: data.occurred_at ?? null,
      });
      // recording a next step with a date sets it on the account too
      if (data.next_step_due !== undefined) {
        await client.query('UPDATE accounts SET next_step_due = $1 WHERE id = $2', [data.next_step_due, id]);
      }
      return created;
    });

    // the follower hears about real touches on a deal they are watching
    if (account.follower_user_id && account.follower_user_id !== req.currentUser.id && data.type !== 'NOTE') {
      await notify(null, {
        userId: account.follower_user_id,
        type: 'crm_activity',
        title: `${account.name}: ${data.subject || data.type.toLowerCase()}`,
        body: data.next_step ? `Next: ${data.next_step}` : null,
        accountId: id,
      });
    }

    res.status(201).json({ activity, account: await getAccount(id) });
  }),
);

export default router;
