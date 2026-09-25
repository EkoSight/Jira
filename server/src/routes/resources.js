import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import {
  RESOURCE_STATUSES, SHARE_CHANNELS,
  assertUsableLink, canManageResource, ensureFolders, listFolders, listResources,
  listShares, sharesForAccount,
} from '../services/resources.js';
import { logActivity } from '../services/crm.js';

const router = Router();

const accountParam = (value) => {
  if (value === undefined || value === null || value === '' || value === 'global') return null;
  return Number(value);
};

async function loadAccount(accountId) {
  if (accountId === null) return null;
  const { rows } = await query('SELECT * FROM accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw notFound('Organization not found');
  return rows[0];
}

// ---------------------------------------------------------------- folders

router.get(
  '/folders',
  asyncHandler(async (req, res) => {
    const accountId = accountParam(req.query.account_id);
    if (accountId !== null) await loadAccount(accountId);
    res.json({ folders: await listFolders(accountId) });
  }),
);

router.post(
  '/folders',
  requirePermission('crm.create'),
  asyncHandler(async (req, res) => {
    const { account_id: rawAccount, name } = z
      .object({
        account_id: z.number().int().positive().nullable().optional(),
        name: z.string().min(1).max(120),
      })
      .parse(req.body);

    const accountId = rawAccount ?? null;
    if (accountId !== null) await loadAccount(accountId);
    // only someone who can manage the shared library may add a shelf to it
    if (accountId === null && !hasPermission(req.currentUser, 'crm.manage.any')) {
      throw forbidden('Only a manager can change the shared library');
    }

    const { rows } = await query(
      `INSERT INTO crm_resource_folders (account_id, name, position, created_by)
       VALUES ($1,$2,(SELECT COALESCE(MAX(position),0)+1 FROM crm_resource_folders
                       WHERE account_id IS NOT DISTINCT FROM $1),$3)
       RETURNING *`,
      [accountId, name.trim(), req.currentUser.id],
    );
    res.status(201).json({ folder: rows[0] });
  }),
);

/** Sets up the suggested shelves on a lead that has none yet. */
router.post(
  '/folders/suggest/:accountId',
  requirePermission('crm.create'),
  asyncHandler(async (req, res) => {
    const accountId = Number(req.params.accountId);
    await loadAccount(accountId);
    await withTransaction((client) => ensureFolders(client, accountId));
    res.json({ folders: await listFolders(accountId) });
  }),
);

// ---------------------------------------------------------------- resources

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const accountId = accountParam(req.query.account_id);
    if (accountId !== null) await loadAccount(accountId);
    res.json({
      resources: await listResources({
        accountId,
        folderId: req.query.folder_id,
        search: req.query.search,
        // a restricted resource is only listed for someone who can manage them
        includeRestricted: hasPermission(req.currentUser, 'crm.manage.any'),
      }),
      folders: await listFolders(accountId),
    });
  }),
);

const resourceInput = z.object({
  account_id: z.number().int().positive().nullable().optional(),
  opportunity_id: z.number().int().positive().nullable().optional(),
  engagement_id: z.number().int().positive().nullable().optional(),
  folder_id: z.number().int().positive().nullable().optional(),
  title: z.string().min(1).max(200),
  url: z.string().min(4).max(2000),
  category: z.string().max(80).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  tags: z.array(z.string().max(40)).optional(),
  version_label: z.string().max(60).nullable().optional(),
  status: z.enum(RESOURCE_STATUSES).optional(),
  is_restricted: z.boolean().optional(),
});

router.post(
  '/',
  requirePermission('crm.create'),
  asyncHandler(async (req, res) => {
    const data = resourceInput.parse(req.body);
    const accountId = data.account_id ?? null;
    const account = await loadAccount(accountId);

    if (accountId === null && !hasPermission(req.currentUser, 'crm.manage.any')) {
      throw forbidden('Only a manager can add to the shared library');
    }

    const link = assertUsableLink(data.url.trim());
    if (!link.ok) throw badRequest(link.reason);

    const created = await withTransaction(async (client) => {
      if (accountId !== null) await ensureFolders(client, accountId);

      const { rows } = await client.query(
        `INSERT INTO crm_resources
           (account_id, opportunity_id, engagement_id, folder_id, title, url, category,
            description, tags, version_label, status, is_restricted, owner_user_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::text[],'{}'::text[]),$10,
                 COALESCE($11,'CURRENT'),COALESCE($12,FALSE),$13,$13)
         RETURNING *`,
        [
          accountId, data.opportunity_id ?? null, data.engagement_id ?? null,
          data.folder_id ?? null, data.title.trim(), link.url, data.category ?? null,
          data.description ?? null, data.tags ?? null, data.version_label ?? null,
          data.status ?? null, data.is_restricted ?? null, req.currentUser.id,
        ],
      );

      // adding a link to a lead is worth a line in its history
      if (accountId !== null) {
        await logActivity(client, {
          accountId,
          opportunityId: data.opportunity_id ?? account?.primary_opportunity_id ?? null,
          type: 'NOTE',
          actorId: req.currentUser.id,
          subject: `Link added: ${data.title.trim()}`,
          // deliberately not external: saving a link is not sending it
          isExternal: false,
        });
      }
      return rows[0];
    });

    res.status(201).json({
      resource: created,
      note: 'Saved as a link. TaskFlow has not changed who can open it in the source application.',
    });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = resourceInput.partial().omit({ account_id: true }).parse(req.body);
    const id = Number(req.params.id);

    const { rows: existing } = await query('SELECT * FROM crm_resources WHERE id = $1', [id]);
    if (!existing[0]) throw notFound('Resource not found');
    const account = await loadAccount(existing[0].account_id);
    if (!canManageResource(req.currentUser, existing[0], account)) {
      throw forbidden('You cannot change this resource');
    }

    if (data.url) {
      const link = assertUsableLink(data.url.trim());
      if (!link.ok) throw badRequest(link.reason);
      data.url = link.url;
    }

    const fields = [];
    const params = [];
    for (const key of ['folder_id', 'title', 'url', 'category', 'description', 'tags',
      'version_label', 'status', 'is_restricted', 'opportunity_id', 'engagement_id']) {
      if (data[key] === undefined) continue;
      params.push(data[key] === '' ? null : data[key]);
      fields.push(`${key} = $${params.length}`);
    }
    if (!fields.length) throw badRequest('Nothing to update');

    params.push(id);
    const { rows } = await query(
      `UPDATE crm_resources SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length} RETURNING *`,
      params,
    );
    res.json({ resource: rows[0] });
  }),
);

router.post(
  '/:id/pin',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      'UPDATE crm_resources SET is_pinned = NOT is_pinned, updated_at = now() WHERE id = $1 RETURNING *',
      [id],
    );
    if (!rows[0]) throw notFound('Resource not found');
    res.json({ resource: rows[0] });
  }),
);

/**
 * Removes the resource entry. The document it points at is untouched — TaskFlow
 * never had a copy of it, and cannot delete anything in Drive or anywhere else.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { rows: existing } = await query('SELECT * FROM crm_resources WHERE id = $1', [id]);
    if (!existing[0]) throw notFound('Resource not found');
    const account = await loadAccount(existing[0].account_id);
    if (!canManageResource(req.currentUser, existing[0], account)) {
      throw forbidden('You cannot remove this resource');
    }

    await query('DELETE FROM crm_resources WHERE id = $1', [id]);
    res.json({
      ok: true,
      note: 'The link was removed from TaskFlow. The document itself is untouched.',
    });
  }),
);

// ---------------------------------------------------------------- references

/**
 * Points a lead at something in the shared library.
 *
 * A reference, not a copy: one row saying "this lead uses that resource".
 * Updating the original updates it everywhere, and removing the reference leaves
 * the original in the shared library for everyone else.
 */
router.post(
  '/:id/reference',
  requirePermission('crm.create'),
  asyncHandler(async (req, res) => {
    const { account_id: accountId, opportunity_id: opportunityId, note } = z
      .object({
        account_id: z.number().int().positive(),
        opportunity_id: z.number().int().positive().nullable().optional(),
        note: z.string().max(1000).nullable().optional(),
      })
      .parse(req.body);

    const resourceId = Number(req.params.id);
    const { rows: resource } = await query('SELECT * FROM crm_resources WHERE id = $1', [resourceId]);
    if (!resource[0]) throw notFound('Resource not found');
    if (resource[0].account_id !== null) {
      throw badRequest('That resource already belongs to an organization — only shared ones are referenced');
    }
    await loadAccount(accountId);

    const { rows } = await query(
      `INSERT INTO crm_resource_references (account_id, resource_id, opportunity_id, note, added_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (account_id, resource_id) DO UPDATE SET note = EXCLUDED.note
       RETURNING *`,
      [accountId, resourceId, opportunityId ?? null, note ?? null, req.currentUser.id],
    );
    res.status(201).json({
      reference: rows[0],
      note: 'Referenced, not copied. The shared resource is unchanged and still shared.',
    });
  }),
);

router.delete(
  '/:id/reference/:accountId',
  asyncHandler(async (req, res) => {
    await query(
      'DELETE FROM crm_resource_references WHERE resource_id = $1 AND account_id = $2',
      [Number(req.params.id), Number(req.params.accountId)],
    );
    res.json({
      ok: true,
      note: 'The reference was removed. The shared resource itself is untouched.',
    });
  }),
);

// ---------------------------------------------------------------- sharing

router.get(
  '/:id/shares',
  asyncHandler(async (req, res) => {
    res.json({ shares: await listShares(Number(req.params.id)) });
  }),
);

router.get(
  '/shares/account/:accountId',
  asyncHandler(async (req, res) => {
    const accountId = Number(req.params.accountId);
    await loadAccount(accountId);
    res.json({ shares: await sharesForAccount(accountId) });
  }),
);

/**
 * Records that something WAS shared. TaskFlow does not send it.
 *
 * This is a claim a person is making about what they did — the same kind of
 * record as logging a call. It is stored as evidence of engagement, which is why
 * it moves the follow-up clock, and it does not imply the recipient can open the
 * document: their access lives in the source application, not here.
 */
router.post(
  '/:id/shares',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        account_id: z.number().int().positive(),
        opportunity_id: z.number().int().positive().nullable().optional(),
        contact_id: z.number().int().positive().nullable().optional(),
        channel: z.enum(SHARE_CHANNELS).optional(),
        version_label: z.string().max(60).nullable().optional(),
        purpose: z.string().max(1000).nullable().optional(),
        shared_at: z.string().min(8).nullable().optional(),
      })
      .parse(req.body);

    const resourceId = Number(req.params.id);
    const { rows: resource } = await query('SELECT * FROM crm_resources WHERE id = $1', [resourceId]);
    if (!resource[0]) throw notFound('Resource not found');
    await loadAccount(data.account_id);

    const share = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO crm_resource_shares
           (resource_id, account_id, opportunity_id, contact_id, channel, version_label,
            purpose, shared_at, shared_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9)
         RETURNING *`,
        [
          resourceId, data.account_id, data.opportunity_id ?? null, data.contact_id ?? null,
          data.channel ?? null, data.version_label ?? resource[0].version_label ?? null,
          data.purpose ?? null, data.shared_at ?? null, req.currentUser.id,
        ],
      );

      // sending something IS engagement, unlike saving it
      await logActivity(client, {
        accountId: data.account_id,
        opportunityId: data.opportunity_id ?? null,
        contactId: data.contact_id ?? null,
        type: 'PROPOSAL',
        actorId: req.currentUser.id,
        subject: `Shared: ${resource[0].title}`,
        body: data.purpose ?? null,
        channel: data.channel ?? null,
        direction: 'OUTBOUND',
        outcome: 'SENT',
        isExternal: true,
      });

      return rows[0];
    });

    res.status(201).json({
      share,
      note: 'Recorded as sent by you. TaskFlow did not send anything and cannot grant access to the document.',
    });
  }),
);

export default router;
