import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { upload, resolveStoredFile, deleteStoredFile } from '../lib/uploads.js';
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

import {
  listContacts, opportunitiesFor, possibleDuplicateContacts, recordOwnershipChange,
} from '../services/opportunities.js';
import { ensureFolders } from '../services/resources.js';
import { crmDashboard, managerSummaries, mapView, ownershipTree } from '../services/crmDashboard.js';
import { analysePipeline } from '../services/accountInsights.js';

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

  // the organization dossier
  segment_id: z.number().int().positive().nullable().optional(),
  logo_url: z.string().max(500).nullable().optional(),
  banner_url: z.string().max(500).nullable().optional(),
  linkedin_url: z.string().max(500).nullable().optional(),
  hq_address: z.string().max(1000).nullable().optional(),
  operating_regions: z.array(z.string().max(80)).optional(),
  crops: z.array(z.string().max(80)).optional(),
  tags: z.array(z.string().max(40)).optional(),
  relationship_summary: z.string().max(20000).nullable().optional(),
  why_it_matters: z.string().max(20000).nullable().optional(),
  relationship_potential: z.number().min(0).nullable().optional(),
});

const contactInput = z.object({
  full_name: z.string().min(2).max(160),
  designation: z.string().max(160).nullable().optional(),
  department: z.string().max(160).nullable().optional(),
  // deliberately not validated as an Indian number: partners are not all here
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  whatsapp: z.string().max(60).nullable().optional(),
  linkedin_url: z.string().max(500).nullable().optional(),
  other_link: z.string().max(500).nullable().optional(),
  photo_url: z.string().max(500).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  preferred_channel: z.enum(['EMAIL', 'PHONE', 'WHATSAPP', 'LINKEDIN', 'IN_PERSON']).nullable().optional(),
  influence: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  is_primary: z.boolean().optional(),
  is_active: z.boolean().optional(),
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

// ---------------------------------------------------------------- nudges

router.get(
  '/nudges',
  asyncHandler(async (req, res) => {
    res.json(await analysePipeline({
      departmentId: req.query.department_id ? Number(req.query.department_id) : null,
    }));
  }),
);

/**
 * Putting a nudge down.
 *
 * With a reason and a date, because a nudge that can be dismissed without either
 * is a nudge that gets dismissed every time, and then the ones that matter are
 * dismissed too.
 */
router.post(
  '/nudges/snooze',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        entity_type: z.enum(['ACCOUNT', 'OPPORTUNITY', 'ENGAGEMENT', 'MEETING']),
        entity_id: z.number().int().positive(),
        kind: z.string().max(60).nullable().optional(),
        reason: z.string().min(3).max(1000),
        days: z.number().int().min(1).max(180).optional(),
      })
      .parse(req.body);

    const { rows } = await query(
      `INSERT INTO crm_nudge_snoozes (entity_type, entity_id, kind, reason, until, created_by)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval, $6)
       RETURNING *`,
      [
        data.entity_type, data.entity_id, data.kind ?? null, data.reason.trim(),
        data.days ?? 7, req.currentUser.id,
      ],
    );
    res.status(201).json({ snooze: rows[0] });
  }),
);

router.get(
  '/nudges/snoozes',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.*, u.full_name AS created_by_name
         FROM crm_nudge_snoozes s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.until > now() ORDER BY s.until`,
    );
    res.json({ snoozes: rows });
  }),
);

router.delete(
  '/nudges/snoozes/:id',
  asyncHandler(async (req, res) => {
    await query('DELETE FROM crm_nudge_snoozes WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
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

    // the organization dossier: who is there, what deals are live, where they are
    const [contacts, opportunities, locations, engagements] = await Promise.all([
      listContacts(account.id),
      opportunitiesFor(account.id),
      query('SELECT * FROM account_locations WHERE account_id = $1 ORDER BY kind, id', [account.id]),
      query(
        `SELECT e.*, u.full_name AS owner_name, u.avatar_color AS owner_color,
                o.name AS opportunity_name,
                (SELECT COUNT(*)::int FROM engagement_milestones m
                  WHERE m.engagement_id = e.id) AS milestone_total,
                (SELECT COUNT(*)::int FROM engagement_milestones m
                  WHERE m.engagement_id = e.id AND m.status = 'ACCEPTED') AS milestone_accepted
           FROM engagements e
           LEFT JOIN users u ON u.id = e.owner_user_id
           LEFT JOIN opportunities o ON o.id = e.opportunity_id
          WHERE e.account_id = $1 AND e.is_archived = FALSE ORDER BY e.id DESC`,
        [account.id],
      ),
    ]);

    res.json({
      account,
      activities,
      tasks: tasks.rows,
      goals: goals.rows,
      contacts,
      opportunities,
      locations: locations.rows,
      engagements: engagements.rows,
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

      // Every new organization starts with one opportunity, because a lead with
      // nowhere to record a deal is a contact list entry. The migration gave one
      // to every lead that already existed; this keeps that true going forward.
      const { rows: oppRows } = await client.query(
        `INSERT INTO opportunities
           (account_id, name, stage_id, owner_user_id, estimated_value, currency,
            next_step, next_step_due, created_by)
         VALUES ($1,$2,$3,$4,$5::numeric,COALESCE($6,'INR'),$7,$8::date,$9)
         RETURNING id`,
        [
          created.id,
          created.name,
          created.stage_id,
          created.owner_user_id,
          data.value ?? null,
          data.currency ?? null,
          data.next_step ?? null,
          data.next_step_due ?? null,
          req.currentUser.id,
        ],
      );
      await client.query('UPDATE accounts SET primary_opportunity_id = $1 WHERE id = $2',
        [oppRows[0].id, created.id]);

      // the contact captured on the quick-add form becomes the first stakeholder
      if ((data.contact_name || '').trim() || (data.contact_email || '').trim()
          || (data.contact_phone || '').trim()) {
        await client.query(
          `INSERT INTO account_contacts (account_id, full_name, email, phone, is_primary, created_by)
           VALUES ($1, COALESCE(NULLIF(TRIM($2), ''), 'Primary contact'),
                   NULLIF(TRIM($3), ''), NULLIF(TRIM($4), ''), TRUE, $5)`,
          [created.id, data.contact_name ?? '', data.contact_email ?? '', data.contact_phone ?? '', req.currentUser.id],
        );
      }

      // the shelves everyone ends up making by hand anyway
      await ensureFolders(client, created.id);

      await logActivity(client, {
        accountId: created.id,
        opportunityId: oppRows[0].id,
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
  // the organization dossier
  'segment_id', 'logo_url', 'banner_url', 'linkedin_url', 'hq_address',
  'operating_regions', 'crops', 'tags', 'relationship_summary', 'why_it_matters',
  'relationship_potential',
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
        // when it happened, which is not when it was typed in
        occurred_at: z.string().min(8).nullable().optional(),

        // which deal it was about, and who at the organization was on it
        opportunity_id: z.number().int().positive().nullable().optional(),
        engagement_id: z.number().int().positive().nullable().optional(),
        meeting_id: z.number().int().positive().nullable().optional(),
        contact_id: z.number().int().positive().nullable().optional(),
        channel: z.string().max(40).nullable().optional(),
        direction: z.enum(['OUTBOUND', 'INBOUND']).nullable().optional(),
        // an attempt, a message sent, a reply received and a conversation that
        // actually happened are four different facts
        outcome: z.enum(['ATTEMPTED', 'COMPLETED', 'SENT', 'RECEIVED',
                         'SCHEDULED', 'CANCELLED', 'NO_SHOW', 'NOTED']).nullable().optional(),
        external_participants: z.string().max(1000).nullable().optional(),
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
        opportunityId: data.opportunity_id ?? account.primary_opportunity_id ?? null,
        engagementId: data.engagement_id ?? null,
        meetingId: data.meeting_id ?? null,
        contactId: data.contact_id ?? null,
        channel: data.channel ?? null,
        direction: data.direction ?? null,
        outcome: data.outcome ?? null,
        externalParticipants: data.external_participants ?? null,
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

// ---------------------------------------------------------------- contacts
//
// The people at the organization. They are records, never TaskFlow users: adding
// someone here does not create an account or send them anything.

router.get(
  '/:id/contacts',
  asyncHandler(async (req, res) => {
    const account = await getAccount(Number(req.params.id));
    if (!account) throw notFound('Account not found');
    res.json({
      contacts: await listContacts(account.id, { includeInactive: req.query.all === 'true' }),
    });
  }),
);

router.post(
  '/:id/contacts',
  requirePermission('crm.create'),
  asyncHandler(async (req, res) => {
    const data = contactInput.parse(req.body);
    const id = Number(req.params.id);

    const { rows: accountRows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
    if (!accountRows[0]) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, accountRows[0])) throw forbidden('You cannot add contacts here');

    // a shared name or email domain does not prove two people are the same
    // person, so near-matches are reported and the caller decides
    const duplicates = await possibleDuplicateContacts(id, {
      email: data.email, phone: data.phone, fullName: data.full_name,
    });

    const contact = await withTransaction(async (client) => {
      if (data.is_primary) {
        await client.query(
          'UPDATE account_contacts SET is_primary = FALSE WHERE account_id = $1', [id],
        );
      }
      const { rows } = await client.query(
        `INSERT INTO account_contacts
           (account_id, full_name, designation, department, email, phone, whatsapp,
            linkedin_url, other_link, photo_url, location, preferred_channel, influence,
            notes, is_primary, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,FALSE),$16)
         RETURNING *`,
        [
          id, data.full_name.trim(), data.designation ?? null, data.department ?? null,
          data.email ?? null, data.phone ?? null, data.whatsapp ?? null,
          data.linkedin_url ?? null, data.other_link ?? null, data.photo_url ?? null,
          data.location ?? null, data.preferred_channel ?? null, data.influence ?? null,
          data.notes ?? null, data.is_primary ?? null, req.currentUser.id,
        ],
      );
      return rows[0];
    });

    res.status(201).json({ contact, possible_duplicates: duplicates });
  }),
);

router.patch(
  '/:accountId/contacts/:contactId',
  asyncHandler(async (req, res) => {
    const data = contactInput.partial().parse(req.body);
    const accountId = Number(req.params.accountId);

    const { rows: accountRows } = await query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    if (!accountRows[0]) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, accountRows[0])) throw forbidden('You cannot edit contacts here');

    const fields = [];
    const params = [];
    for (const key of ['full_name', 'designation', 'department', 'email', 'phone', 'whatsapp',
      'linkedin_url', 'other_link', 'photo_url', 'location', 'preferred_channel',
      'influence', 'notes', 'is_primary', 'is_active']) {
      if (data[key] === undefined) continue;
      params.push(data[key] === '' ? null : data[key]);
      fields.push(`${key} = $${params.length}`);
    }
    if (!fields.length) throw badRequest('Nothing to update');

    const contact = await withTransaction(async (client) => {
      if (data.is_primary) {
        await client.query(
          'UPDATE account_contacts SET is_primary = FALSE WHERE account_id = $1', [accountId],
        );
      }
      params.push(Number(req.params.contactId), accountId);
      const { rows } = await client.query(
        `UPDATE account_contacts SET ${fields.join(', ')}, updated_at = now()
          WHERE id = $${params.length - 1} AND account_id = $${params.length}
          RETURNING *`,
        params,
      );
      return rows[0];
    });

    if (!contact) throw notFound('Contact not found');
    res.json({ contact });
  }),
);

// Marking someone inactive keeps every meeting and message they were part of.
// There is no delete: erasing a person erases the history they are in.
router.delete(
  '/:accountId/contacts/:contactId',
  asyncHandler(async (req, res) => {
    const accountId = Number(req.params.accountId);
    const { rows: accountRows } = await query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    if (!accountRows[0]) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, accountRows[0])) throw forbidden('You cannot edit contacts here');

    const { rows } = await query(
      `UPDATE account_contacts SET is_active = FALSE, updated_at = now()
        WHERE id = $1 AND account_id = $2 RETURNING id`,
      [Number(req.params.contactId), accountId],
    );
    if (!rows[0]) throw notFound('Contact not found');
    res.json({ ok: true, deactivated: true });
  }),
);

// ---------------------------------------------------------------- locations

router.post(
  '/:id/locations',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        label: z.string().max(160).nullable().optional(),
        kind: z.enum(['HQ', 'OPERATING', 'SITE']).optional(),
        address: z.string().max(1000).nullable().optional(),
        city: z.string().max(120).nullable().optional(),
        state: z.string().max(120).nullable().optional(),
        country: z.string().max(120).optional(),
        // entered by hand; nothing here is geocoded or invented
        latitude: z.number().min(-90).max(90).nullable().optional(),
        longitude: z.number().min(-180).max(180).nullable().optional(),
        precision: z.enum(['EXACT', 'APPROXIMATE', 'REGION']).optional(),
      })
      .parse(req.body);
    const id = Number(req.params.id);

    const { rows: accountRows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
    if (!accountRows[0]) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, accountRows[0])) throw forbidden('You cannot edit this account');

    const { rows } = await query(
      `INSERT INTO account_locations
         (account_id, label, kind, address, city, state, country, latitude, longitude, precision, created_by)
       VALUES ($1,$2,COALESCE($3,'OPERATING'),$4,$5,$6,COALESCE($7,'India'),
               $8::numeric,$9::numeric,COALESCE($10,'APPROXIMATE'),$11)
       RETURNING *`,
      [
        id, data.label ?? null, data.kind ?? null, data.address ?? null, data.city ?? null,
        data.state ?? null, data.country ?? null, data.latitude ?? null, data.longitude ?? null,
        data.precision ?? null, req.currentUser.id,
      ],
    );
    res.status(201).json({ location: rows[0] });
  }),
);

router.delete(
  '/:accountId/locations/:locationId',
  asyncHandler(async (req, res) => {
    const accountId = Number(req.params.accountId);
    const { rows: accountRows } = await query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    if (!accountRows[0]) throw notFound('Account not found');
    if (!canEditAccount(req.currentUser, accountRows[0])) throw forbidden('You cannot edit this account');
    await query('DELETE FROM account_locations WHERE id = $1 AND account_id = $2',
      [Number(req.params.locationId), accountId]);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- the dossier's images
//
// A logo or a banner can be either a link to an image already on the web or a
// file uploaded here. Both are supported and kept apart: uploading does not
// erase a pasted logo_url, and removing the upload falls back to it.

const IMAGE_KINDS = { logo: 'LOGO', banner: 'BANNER' };
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);

async function mustEditAccount(user, id) {
  const { rows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Organization not found');
  if (!canEditAccount(user, rows[0])) throw forbidden('You cannot edit this organization');
  return rows[0];
}

router.post(
  '/:id/image/:kind',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const kind = IMAGE_KINDS[String(req.params.kind).toLowerCase()];
    if (!kind) throw badRequest('Only a logo or a banner can be uploaded');
    if (!req.file) throw badRequest('No file was uploaded');
    if (!IMAGE_MIME.has(req.file.mimetype)) {
      deleteStoredFile(req.file.filename);
      throw badRequest('That has to be an image');
    }

    const id = Number(req.params.id);
    try {
      await mustEditAccount(req.currentUser, id);
    } catch (err) {
      // do not leave an orphan on disk when the upload is refused
      deleteStoredFile(req.file.filename);
      throw err;
    }

    const replaced = await withTransaction(async (client) => {
      const { rows: old } = await client.query(
        'SELECT stored_name FROM account_images WHERE account_id = $1 AND kind = $2', [id, kind],
      );
      await client.query(
        `INSERT INTO account_images
           (account_id, kind, stored_name, file_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (account_id, kind) DO UPDATE
           SET stored_name = EXCLUDED.stored_name, file_name = EXCLUDED.file_name,
               mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes,
               uploaded_by = EXCLUDED.uploaded_by, created_at = now()`,
        [id, kind, req.file.filename, req.file.originalname, req.file.mimetype,
          req.file.size, req.currentUser.id],
      );
      return old[0]?.stored_name ?? null;
    });

    // only once the row is safely committed
    if (replaced && replaced !== req.file.filename) deleteStoredFile(replaced);

    res.status(201).json({ account: await getAccount(id) });
  }),
);

/** Streams it back. Visible to anyone who can see the organization. */
router.get(
  '/:id/image/:kind',
  asyncHandler(async (req, res) => {
    const kind = IMAGE_KINDS[String(req.params.kind).toLowerCase()];
    if (!kind) throw notFound('No such image');

    const { rows } = await query(
      'SELECT * FROM account_images WHERE account_id = $1 AND kind = $2',
      [Number(req.params.id), kind],
    );
    const image = rows[0];
    if (!image) throw notFound('No image uploaded');

    const filePath = resolveStoredFile(image.stored_name);
    if (!fs.existsSync(filePath)) throw notFound('The file is no longer on the server');

    res.setHeader('Content-Type', image.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  }),
);

router.delete(
  '/:id/image/:kind',
  asyncHandler(async (req, res) => {
    const kind = IMAGE_KINDS[String(req.params.kind).toLowerCase()];
    if (!kind) throw badRequest('Only a logo or a banner can be removed');
    const id = Number(req.params.id);
    await mustEditAccount(req.currentUser, id);

    const { rows } = await query(
      'SELECT stored_name FROM account_images WHERE account_id = $1 AND kind = $2', [id, kind],
    );
    await query('DELETE FROM account_images WHERE account_id = $1 AND kind = $2', [id, kind]);
    deleteStoredFile(rows[0]?.stored_name);

    // the pasted link, if there was one, is still there and takes over again
    res.json({ account: await getAccount(id) });
  }),
);

// ---------------------------------------------------------------- segments

router.get(
  '/meta/segments',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.*, (SELECT COUNT(*)::int FROM accounts a
                     WHERE a.segment_id = s.id AND a.is_archived = FALSE) AS account_count
         FROM crm_segments s WHERE s.is_active = TRUE ORDER BY s.position, s.id`,
    );
    res.json({ segments: rows });
  }),
);

// ---------------------------------------------------------------- the views
//
// Board, list, map and tree all read the same authorized records with the same
// filters — they are four ways of looking at one set, not four datasets.

/** Where the organizations are. Nothing is geocoded; nothing is invented. */
router.get(
  '/views/map',
  asyncHandler(async (req, res) => {
    res.json(await mapView({
      departmentId: req.query.department_id ? Number(req.query.department_id) : null,
      segmentId: req.query.segment_id ? Number(req.query.segment_id) : null,
    }));
  }),
);

/** Managers, and the organizations each of them leads. */
router.get(
  '/views/tree',
  requirePermission('report.view'),
  asyncHandler(async (req, res) => {
    res.json(await ownershipTree({
      departmentId: req.query.department_id ? Number(req.query.department_id) : null,
    }));
  }),
);

// ---------------------------------------------------------------- dashboards

router.get(
  '/dashboard/b2b',
  asyncHandler(async (req, res) => {
    res.json(await crmDashboard({
      month: req.query.month,
      ownerId: req.query.owner_id,
      departmentId: req.query.department_id,
      segmentId: req.query.segment_id,
    }));
  }),
);

/** One row per person, for the month. Needs the reporting permission. */
router.get(
  '/dashboard/people',
  requirePermission('report.view'),
  asyncHandler(async (req, res) => {
    res.json(await managerSummaries({
      month: req.query.month,
      departmentId: req.query.department_id ? Number(req.query.department_id) : null,
    }));
  }),
);

export default router;
