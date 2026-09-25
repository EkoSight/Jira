/**
 * The link library.
 *
 * A resource is a POINTER to something that lives somewhere else — a Google Doc,
 * a Drive file, a Canva deck, a validation report. TaskFlow stores the link, the
 * title and where it belongs. It never downloads the file, never copies its
 * contents, and never crawls it.
 *
 * Two consequences that are easy to get wrong and matter a great deal:
 *
 *   Adding a global resource to a lead creates a REFERENCE, not a copy. Deleting
 *   the reference removes the pointer and leaves the original alone.
 *
 *   Saving or referencing a link says nothing about who can open it. TaskFlow
 *   does not and cannot change sharing permissions in Google Drive or anywhere
 *   else, so the UI says so rather than implying access was granted.
 *
 * Having a link is also not the same as having sent it. What was actually shared
 * with which contact, when and how, is recorded separately — as a claim someone
 * made, never as something inferred from the file existing.
 */

import { query } from '../db/pool.js';
import { hasPermission } from '../lib/permissions.js';

export const RESOURCE_STATUSES = ['DRAFT', 'CURRENT', 'SUPERSEDED', 'ARCHIVED'];
export const SHARE_CHANNELS = ['EMAIL', 'WHATSAPP', 'LINKEDIN', 'IN_PERSON', 'CALL', 'OTHER'];

/** The folders a new organization library is suggested to have. */
export const SUGGESTED_FOLDERS = [
  'Pitch & Introduction', 'Proposals & Offers', 'Requirements',
  'Validation & Evidence', 'Demos & Videos', 'Agreements', 'Delivery',
];

const RESOURCE_SELECT = `
  SELECT r.*,
         f.name AS folder_name,
         u.full_name AS owner_name, u.avatar_color AS owner_color,
         c.full_name AS added_by_name,
         o.name AS opportunity_name,
         (SELECT COUNT(*)::int FROM crm_resource_shares s WHERE s.resource_id = r.id) AS share_count,
         (SELECT MAX(s.shared_at) FROM crm_resource_shares s WHERE s.resource_id = r.id) AS last_shared_at,
         (SELECT COUNT(*)::int FROM crm_resource_references ref WHERE ref.resource_id = r.id) AS reference_count
    FROM crm_resources r
    LEFT JOIN crm_resource_folders f ON f.id = r.folder_id
    LEFT JOIN users u ON u.id = r.owner_user_id
    LEFT JOIN users c ON c.id = r.created_by
    LEFT JOIN opportunities o ON o.id = r.opportunity_id
`;

/**
 * Only http(s), and never a link to somewhere inside this network.
 * A stored link is clicked by people, so the same care applies as anywhere else
 * a URL is accepted from a user.
 */
export function assertUsableLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'That does not look like a web address' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Only http and https links can be saved' };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')
      || /^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return { ok: false, reason: 'That address is not reachable outside this machine' };
  }
  return { ok: true, url: parsed.toString() };
}

export const canManageResource = (user, resource, account) =>
  hasPermission(user, 'crm.manage.any')
  || resource.created_by === user.id
  || resource.owner_user_id === user.id
  || (account && account.owner_user_id === user.id);

/**
 * Everything in one library: the resources that live here, plus the global ones
 * that have been referenced into it. A referenced resource is marked as such so
 * nobody edits it thinking it belongs to this lead alone.
 */
export async function listResources({ accountId = null, folderId, search, includeRestricted = true }) {
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const where = accountId === null
    ? ['r.account_id IS NULL']
    : [`r.account_id = ${push(Number(accountId))}`];
  if (folderId) where.push(`r.folder_id = ${push(Number(folderId))}`);
  if (search) {
    const term = push(`%${search}%`);
    // the metadata is searched, never the contents of the document itself
    where.push(`(r.title ILIKE ${term} OR r.description ILIKE ${term}
                 OR EXISTS (SELECT 1 FROM unnest(r.tags) tag WHERE tag ILIKE ${term}))`);
  }
  if (!includeRestricted) where.push('r.is_restricted = FALSE');

  const { rows: own } = await query(
    `${RESOURCE_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY r.is_pinned DESC, f.position NULLS LAST, r.created_at DESC LIMIT 500`,
    params,
  );

  const resources = own.map((row) => ({ ...row, is_reference: false }));

  if (accountId !== null) {
    const { rows: referenced } = await query(
      `${RESOURCE_SELECT.replace('FROM crm_resources r', `
         FROM crm_resource_references ref
         JOIN crm_resources r ON r.id = ref.resource_id`)}
        WHERE ref.account_id = $1
        ORDER BY r.is_pinned DESC, r.created_at DESC`,
      [Number(accountId)],
    );
    for (const row of referenced) {
      resources.push({ ...row, is_reference: true, from_global: true });
    }
  }

  return resources;
}

export async function listFolders(accountId = null) {
  const { rows } = await query(
    accountId === null
      ? `SELECT f.*, (SELECT COUNT(*)::int FROM crm_resources r WHERE r.folder_id = f.id) AS resource_count
           FROM crm_resource_folders f WHERE f.account_id IS NULL ORDER BY f.position, f.id`
      : `SELECT f.*, (SELECT COUNT(*)::int FROM crm_resources r WHERE r.folder_id = f.id) AS resource_count
           FROM crm_resource_folders f WHERE f.account_id = $1 ORDER BY f.position, f.id`,
    accountId === null ? [] : [Number(accountId)],
  );
  return rows;
}

/** Gives a lead the suggested shelf layout the first time it needs one. */
export async function ensureFolders(client, accountId) {
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM crm_resource_folders WHERE account_id = $1', [accountId],
  );
  if (rows[0].n > 0) return;
  for (const [index, name] of SUGGESTED_FOLDERS.entries()) {
    await client.query(
      'INSERT INTO crm_resource_folders (account_id, name, position) VALUES ($1, $2, $3)',
      [accountId, name, index + 1],
    );
  }
}

export async function listShares(resourceId) {
  const { rows } = await query(
    `SELECT s.*, c.full_name AS contact_name, u.full_name AS shared_by_name,
            a.name AS account_name
       FROM crm_resource_shares s
       LEFT JOIN account_contacts c ON c.id = s.contact_id
       LEFT JOIN users u ON u.id = s.shared_by
       LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.resource_id = $1
      ORDER BY s.shared_at DESC`,
    [resourceId],
  );
  return rows;
}

/** Everything actually sent to one organization, newest first. */
export async function sharesForAccount(accountId) {
  const { rows } = await query(
    `SELECT s.*, r.title AS resource_title, r.url,
            c.full_name AS contact_name, u.full_name AS shared_by_name
       FROM crm_resource_shares s
       JOIN crm_resources r ON r.id = s.resource_id
       LEFT JOIN account_contacts c ON c.id = s.contact_id
       LEFT JOIN users u ON u.id = s.shared_by
      WHERE s.account_id = $1
      ORDER BY s.shared_at DESC LIMIT 200`,
    [accountId],
  );
  return rows;
}
