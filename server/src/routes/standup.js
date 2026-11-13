import { Router } from 'express';
import { z } from 'zod';

import { query } from '../db/pool.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { getSpace } from '../lib/googleChat.js';
import { requirePermission } from '../middleware/auth.js';
import { normaliseForm } from '../lib/standup.js';
import { getSettings, updateSetting } from '../services/settings.js';
import { dateIn } from '../services/attendance.js';
import {
  checkContent, dayBoard, mine, resolveReview, resolveUnmatched, runStandup, standupSettings, submitFromApp,
} from '../services/standup.js';

const router = Router();

/**
 * The daily standup. Everyone posts their own (or, on a shared login, the
 * person they choose by name). Reviewing is its own permission, and setting
 * it up another. Nothing here touches attendance, leave, pay or black marks.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-12');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30');

const itemInput = z.object({
  task: z.string().max(300).default(''),
  action: z.string().max(300).default(''),
  target: z.string().max(300).default(''),
  done_by: z.string().max(20).nullable().optional(),
});
const blockerInput = z.object({
  text: z.string().max(500).default(''),
  owner: z.string().max(120).nullable().optional(),
  needed_by: z.string().max(20).nullable().optional(),
});
const standupInput = z.object({
  member_id: z.number().int().positive().nullable().optional(),
  role: z.string().max(120).nullable().optional(),
  items: z.array(itemInput).min(1).max(10),
  blockers: z.array(blockerInput).max(5).default([]),
});

// ---------------------------------------------------------------- one's own

router.get('/me', asyncHandler(async (req, res) => res.json(await mine(req.currentUser.id))));

/** The reviewer's checks on a draft, before posting — guidance only. */
router.post(
  '/check',
  asyncHandler(async (req, res) => {
    const body = standupInput.parse(req.body);
    const s = await standupSettings();
    const content = normaliseForm(body, { today: dateIn(s.timezone) });
    res.json({ findings: await checkContent(content) });
  }),
);

router.post(
  '/me',
  asyncHandler(async (req, res) => {
    const body = standupInput.parse(req.body);
    const result = await submitFromApp(req.currentUser, { memberId: body.member_id ?? null, ...body });
    res.status(201).json(result);
  }),
);

// ---------------------------------------------------------------- the review

const canReview = (req) => hasPermission(req.currentUser, 'standup.review') || hasPermission(req.currentUser, 'standup.manage');

router.get(
  '/days',
  asyncHandler(async (req, res) => {
    if (!canReview(req)) throw forbidden('Requires permission: standup.review');
    const { rows } = await query(
      `SELECT d.work_date::text AS work_date, d.status, d.skipped_reason, d.reminder_sent_at, d.effective_deadline_at, d.reviewed_at, d.escalated_at,
              COUNT(r.*) FILTER (WHERE r.status = 'ON_TIME')::int AS on_time,
              COUNT(r.*) FILTER (WHERE r.status = 'LATE')::int AS late,
              COUNT(r.*) FILTER (WHERE r.status = 'MISSING')::int AS missing,
              COUNT(r.*) FILTER (WHERE r.status = 'EXEMPT')::int AS exempt,
              COUNT(r.*) FILTER (WHERE r.status = 'INACCESSIBLE')::int AS inaccessible
         FROM standup_days d LEFT JOIN standup_reviews r ON r.work_date = d.work_date
        GROUP BY d.id ORDER BY d.work_date DESC LIMIT 60`,
    );
    res.json({ days: rows });
  }),
);

router.get(
  '/days/:date',
  asyncHandler(async (req, res) => {
    if (!canReview(req)) throw forbidden('Requires permission: standup.review');
    res.json(await dayBoard(isoDate.parse(req.params.date)));
  }),
);

router.post(
  '/reviews/:id/resolve',
  asyncHandler(async (req, res) => {
    if (!canReview(req)) throw forbidden('Requires permission: standup.review');
    const body = z.object({
      resolution: z.enum(['EXCUSED', 'FOLLOWED_UP', 'NO_ACTION', 'IDENTITY_FIXED']),
      note: z.string().max(500).nullable().optional(),
    }).parse(req.body);
    res.json({ review: await resolveReview(req.currentUser, Number(req.params.id), body) });
  }),
);

/** A held Chat message: attribute it to the member who wrote it, or dismiss it. */
router.post(
  '/unmatched/:id/resolve',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => {
    const body = z.object({ member_id: z.number().int().positive().nullable() }).parse(req.body);
    res.json(await resolveUnmatched(req.currentUser, Number(req.params.id), { memberId: body.member_id }));
  }),
);

// ---------------------------------------------------------------- who takes part

router.get(
  '/members',
  asyncHandler(async (req, res) => {
    if (!canReview(req)) throw forbidden('Requires permission: standup.review');
    const { rows } = await query(
      `SELECT m.*, u.full_name AS user_name, u.email AS user_email, u.is_active AS user_active,
              sa.full_name AS shared_account_name, sa.email AS shared_account_email,
              vb.full_name AS verified_by_name, cp.google_user_name AS linked_chat_user
         FROM standup_members m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN users sa ON sa.id = m.shared_account_id
         LEFT JOIN users vb ON vb.id = m.identity_verified_by
         LEFT JOIN chat_preferences cp ON cp.user_id = m.user_id
        ORDER BY m.active DESC, m.full_name`,
    );
    res.json({ members: rows });
  }),
);

const memberInput = z.object({
  user_id: z.number().int().positive().nullable().optional(),
  full_name: z.string().trim().min(2).max(120),
  role_title: z.string().trim().max(120).nullable().optional(),
  department_id: z.number().int().positive().nullable().optional(),
  shared_account_id: z.number().int().positive().nullable().optional(),
  chat_email: z.string().trim().email().max(200).nullable().optional(),
  chat_user_name: z.string().trim().regex(/^users\/[A-Za-z0-9_-]+$/, 'A Chat user looks like users/1234…').nullable().optional(),
});

/** Company accounts whose own Google sign-in is their TaskFlow email are verified at once; anything else waits for a person. */
async function initialIdentity(input) {
  const s = await standupSettings();
  if (input.user_id && !input.chat_email && !input.shared_account_id) {
    const { rows } = await query('SELECT email FROM users WHERE id = $1 AND is_active', [input.user_id]);
    const domain = String(rows[0]?.email || '').toLowerCase().split('@')[1];
    if (rows[0] && s.companyDomains.includes(domain)) return 'VERIFIED';
  }
  return 'UNVERIFIED';
}

router.post(
  '/members',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => {
    const body = memberInput.parse(req.body);
    if (!body.user_id && !body.shared_account_id && !body.chat_email) {
      throw badRequest('Link a TaskFlow login, a shared login, or a Chat email — someone has to be able to post');
    }
    if (body.user_id) {
      const { rows } = await query('SELECT 1 FROM standup_members WHERE user_id = $1 AND active', [body.user_id]);
      if (rows[0]) throw conflict('That person is already on the standup list');
    }
    const status = await initialIdentity(body);
    const { rows } = await query(
      `INSERT INTO standup_members (user_id, full_name, role_title, department_id, shared_account_id, chat_email, chat_user_name,
          identity_status, identity_verified_by, identity_verified_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [body.user_id ?? null, body.full_name, body.role_title ?? null, body.department_id ?? null, body.shared_account_id ?? null,
        body.chat_email ?? null, body.chat_user_name ?? null, status,
        status === 'VERIFIED' ? req.currentUser.id : null, status === 'VERIFIED' ? new Date() : null, req.currentUser.id],
    );
    // a login that several people share is not a person: it stops being expected itself
    if (body.shared_account_id) {
      await query(
        `UPDATE standup_members SET active = FALSE, ended_at = now(), identity_note = 'Shared login — its people are listed by name', updated_at = now()
          WHERE user_id = $1 AND active`,
        [body.shared_account_id],
      );
    }
    res.status(201).json({ member: rows[0] });
  }),
);

/** Everyone active, at once — each with their own company login, verified by that login. Shared logins are skipped. */
router.post(
  '/members/enrol-active',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => {
    const s = await standupSettings();
    const { rows: users } = await query(
      `SELECT u.id, u.full_name, u.email, u.job_title, u.department_id FROM users u
        WHERE u.is_active AND u.role <> 'super_admin'
          AND NOT EXISTS (SELECT 1 FROM standup_members m WHERE m.user_id = u.id AND m.active)
          AND NOT EXISTS (SELECT 1 FROM standup_members m WHERE m.shared_account_id = u.id AND m.active)
        ORDER BY u.full_name`,
    );
    let added = 0;
    const waiting = [];
    for (const u of users) {
      const company = s.companyDomains.includes(String(u.email).toLowerCase().split('@')[1]);
      await query(
        `INSERT INTO standup_members (user_id, full_name, role_title, department_id, identity_status, identity_verified_by, identity_verified_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [u.id, u.full_name, u.job_title, u.department_id, company ? 'VERIFIED' : 'UNVERIFIED',
          company ? req.currentUser.id : null, company ? new Date() : null, req.currentUser.id],
      );
      added += 1;
      if (!company) waiting.push(u.full_name);
    }
    res.json({ added, waiting_for_verification: waiting });
  }),
);

router.patch(
  '/members/:id',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => {
    const body = memberInput.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    const { rows: before } = await query('SELECT * FROM standup_members WHERE id = $1', [Number(req.params.id)]);
    if (!before[0]) throw notFound('Member not found');
    const next = { ...before[0], ...body };
    // a changed Chat identity has to be verified again
    const identityChanged = (body.chat_email !== undefined && body.chat_email !== before[0].chat_email)
      || (body.chat_user_name !== undefined && body.chat_user_name !== before[0].chat_user_name)
      || (body.shared_account_id !== undefined && body.shared_account_id !== before[0].shared_account_id);
    const { rows } = await query(
      `UPDATE standup_members SET full_name = $2, role_title = $3, department_id = $4, shared_account_id = $5, chat_email = $6,
              chat_user_name = $7, active = $8, ended_at = CASE WHEN $8 THEN NULL ELSE COALESCE(ended_at, now()) END,
              identity_status = CASE WHEN $9 THEN 'UNVERIFIED' ELSE identity_status END,
              identity_verified_by = CASE WHEN $9 THEN NULL ELSE identity_verified_by END,
              identity_verified_at = CASE WHEN $9 THEN NULL ELSE identity_verified_at END,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [before[0].id, next.full_name, next.role_title, next.department_id, next.shared_account_id, next.chat_email, next.chat_user_name,
        next.active, identityChanged],
    );
    res.json({ member: rows[0] });
  }),
);

/** A person confirms who a Chat account belongs to (or that it does not). */
router.post(
  '/members/:id/verify',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => {
    const body = z.object({ decision: z.enum(['VERIFIED', 'REJECTED']), note: z.string().trim().min(3).max(300) }).parse(req.body);
    const { rows } = await query(
      `UPDATE standup_members SET identity_status = $2, identity_note = $3, identity_verified_by = $4, identity_verified_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [Number(req.params.id), body.decision, body.note, req.currentUser.id],
    );
    if (!rows[0]) throw notFound('Member not found');
    res.json({ member: rows[0] });
  }),
);

// ---------------------------------------------------------------- set-up

/** "https://chat.google.com/app/chat/AAQA…", "…#chat/space/AAQA…" or "spaces/AAQA…" → "spaces/AAQA…". */
export function spaceNameFrom(value) {
  const text = String(value || '').trim();
  const m = text.match(/(?:^spaces\/|\/chat\/(?:space\/)?|#chat\/space\/|\/app\/chat\/)([A-Za-z0-9_-]{6,})\/?$/);
  return m ? `spaces/${m[1]}` : null;
}

router.get(
  '/settings',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => {
    const s = await standupSettings();
    const { rows: reviewers } = await query(
      'SELECT id, full_name FROM users WHERE id = ANY($1::int[])', [(s.escalateTo || []).map(Number)],
    );
    res.json({ settings: s, reviewers });
  }),
);

router.put(
  '/settings',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => {
    const body = z.object({
      enabled: z.boolean().optional(),
      space: z.string().max(300).nullable().optional(),
      reminderTime: hhmm.optional(),
      deadline: hhmm.optional(),
      escalationTime: hhmm.optional(),
      reviewCutoff: hhmm.optional(),
      minItems: z.number().int().min(1).max(10).optional(),
      maxItems: z.number().int().min(1).max(10).optional(),
      escalateTo: z.array(z.number().int().positive()).max(20).optional(),
      readSpaceAs: z.string().trim().email().nullable().optional(),
    }).parse(req.body);
    const current = (await getSettings()).standup;
    const next = { ...current };
    for (const key of ['enabled', 'reminderTime', 'deadline', 'escalationTime', 'reviewCutoff', 'minItems', 'maxItems', 'escalateTo', 'readSpaceAs']) {
      if (body[key] !== undefined) next[key] = body[key];
    }
    if (body.space !== undefined) {
      const name = body.space ? spaceNameFrom(body.space) : null;
      if (body.space && !name) throw badRequest('That does not look like a Google Chat space link or name');
      if (name !== current.spaceName) { next.spaceName = name; next.spaceCheck = null; next.enabled = false; }
    }
    if (next.minItems > next.maxItems) throw badRequest('The fewest items cannot be more than the most');
    if (!(next.reminderTime < next.deadline && next.deadline < next.escalationTime && next.deadline <= next.reviewCutoff)) {
      throw badRequest('The times must run in order: reminder, deadline, then follow-up and the latest review time');
    }
    // switched on only for a space that passed the privacy check
    if (next.enabled && !(next.spaceName && next.spaceCheck?.ok && next.spaceCheck.space === next.spaceName)) {
      throw conflict('Check the space first: the standup is posted only in a private company space that TaskFlow has been added to', { code: 'SPACE_NOT_CHECKED' });
    }
    await updateSetting('standup', next, req.currentUser.id);
    res.json({ settings: await standupSettings() });
  }),
);

/**
 * Asks Google about the space: is TaskFlow in it, is it a space (not a DM),
 * and is it closed to people outside the company? Recorded with the time.
 */
router.post(
  '/settings/check-space',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => {
    const current = (await getSettings()).standup;
    if (!current.spaceName) throw badRequest('Set the space first');
    let check;
    try {
      const space = await getSpace(current.spaceName);
      const problems = [];
      if (space.spaceType && space.spaceType !== 'SPACE') problems.push('It is not a space (it is a direct message or group chat)');
      if (space.externalUserAllowed === true) problems.push('People outside the company can be added to it');
      if (space.accessSettings?.audience) problems.push('It is discoverable by a wider audience than its members');
      check = {
        space: current.spaceName, ok: problems.length === 0, problems, display_name: space.displayName || null,
        external_allowed: space.externalUserAllowed === true, threading: space.spaceThreadingState || null,
        checked_at: new Date().toISOString(), checked_by: req.currentUser.id,
      };
    } catch (err) {
      check = {
        space: current.spaceName, ok: false, checked_at: new Date().toISOString(), checked_by: req.currentUser.id,
        problems: [err.status === 404 || err.status === 403
          ? 'TaskFlow is not in that space, or it does not exist — add the TaskFlow app to the space first'
          : `Google Chat could not be asked: ${err.message}`],
      };
    }
    await updateSetting('standup', { ...current, spaceCheck: check, enabled: check.ok ? current.enabled : false }, req.currentUser.id);
    res.json({ check });
  }),
);

/** One pass now, for an admin checking the set-up. Safe to repeat: nothing is sent twice. */
router.post(
  '/run',
  requirePermission('standup.manage'),
  asyncHandler(async (req, res) => res.json(await runStandup())),
);

export default router;
