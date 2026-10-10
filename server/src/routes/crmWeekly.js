import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, badRequest, forbidden } from '../lib/errors.js';
import { hasAnyPermission, hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { dateIn } from '../services/availability.js';
import { getWeek, listWeeks, storeWeek, weekOf } from '../services/weekly.js';
import { reviewFor, saveReviewItem, submitReview, teamReviews } from '../services/weeklyReviews.js';
import {
  confirmSuggestion, dismissSuggestion, listSuggestions, ownDomains, parseCalendar, parseEmail,
  suggestFromEmail, suggestFromEvent,
} from '../services/correspondence.js';
import {
  mySyncSettings, setMySyncSettings, syncAvailability, syncMailbox,
} from '../services/mailboxSync.js';

/**
 * The weekly side of the pipeline: the week's record, the owners' weekly
 * reviews, and correspondence imported for confirmation.
 */
const router = Router();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-12');
const startOf = (req) => (req.query.start && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.start))
  ? String(req.query.start) : dateIn('Asia/Kolkata'));

// ---------------------------------------------------------------- the week

/** A week's record: stored if the week has ended and been written down, live otherwise. */
router.get(
  '/week',
  asyncHandler(async (req, res) => {
    res.json(await getWeek(startOf(req)));
  }),
);

router.get(
  '/weeks',
  asyncHandler(async (req, res) => {
    res.json({ weeks: await listWeeks(), current: weekOf(dateIn('Asia/Kolkata')) });
  }),
);

/** Writes a finished week down now, if the weekly job has not already. Never rewrites one. */
router.post(
  '/weeks/snapshot',
  requirePermission('crm.manage.any'),
  asyncHandler(async (req, res) => {
    const { start } = z.object({ start: day }).parse(req.body);
    const result = await storeWeek(start, { actorId: req.currentUser.id });
    if (!result.stored && result.reason === 'The week has not ended yet') throw badRequest(result.reason);
    res.json({ ...result, week: await getWeek(start) });
  }),
);

// ---------------------------------------------------------------- weekly reviews

router.get(
  '/reviews/mine',
  asyncHandler(async (req, res) => {
    res.json(await reviewFor(req.currentUser.id, startOf(req)));
  }),
);

router.put(
  '/reviews/mine/items/:opportunityId',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const fields = z.object({
      what_changed: z.string().max(4000).nullable().optional(),
      no_change: z.boolean().optional(),
      evidence_url: z.string().max(1000).nullable().optional(),
      next_milestone: z.string().max(1000).nullable().optional(),
      next_milestone_due: day.nullable().optional(),
      help_needed: z.string().max(2000).nullable().optional(),
      help_from_user_id: z.number().int().positive().nullable().optional(),
    }).parse(req.body);
    const item = await saveReviewItem(req.currentUser.id, startOf(req), Number(req.params.opportunityId), fields);
    res.json({ item });
  }),
);

router.post(
  '/reviews/mine/submit',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const { summary } = z.object({ summary: z.string().max(4000).nullable().optional() }).parse(req.body || {});
    res.json(await submitReview(req.currentUser, startOf(req), summary ?? null));
  }),
);

/** Everyone's reviews for a week, for the people who run the pipeline. */
router.get(
  '/reviews/team',
  asyncHandler(async (req, res) => {
    if (!hasAnyPermission(req.currentUser, ['crm.manage.any', 'report.view'])) {
      throw forbidden('Only pipeline managers see everyone\'s weekly reviews');
    }
    res.json(await teamReviews(startOf(req), {
      departmentId: req.query.department_id ? Number(req.query.department_id) : null,
    }));
  }),
);

// ---------------------------------------------------------------- correspondence

router.post(
  '/import/email',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const { raw, account_id: accountId } = z.object({
      raw: z.string().min(10).max(900_000),
      account_id: z.number().int().positive().nullable().optional(),
    }).parse(req.body);
    const email = parseEmail(raw);
    if (!email) {
      throw badRequest('That does not look like an email — paste it with its From, To, Date and Subject lines, or upload the .eml file');
    }
    const result = await suggestFromEmail(req.currentUser.id, email, { accountId: accountId ?? null });
    if (result.skipped === 'internal') throw badRequest('Everyone on that email is from our side, so it is not correspondence with a customer');
    res.status(result.suggestion ? 201 : 200).json(result);
  }),
);

router.post(
  '/import/calendar',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const { raw, account_id: accountId } = z.object({
      raw: z.string().min(10).max(900_000),
      account_id: z.number().int().positive().nullable().optional(),
    }).parse(req.body);
    const events = parseCalendar(raw);
    if (!events.length) throw badRequest('No events were found in that file — export an .ics calendar file and upload it');
    const domains = await ownDomains();
    const outcome = { suggested: 0, already: 0, internal: 0, cancelled: 0, unmatched: 0 };
    for (const event of events.slice(0, 500)) {
      const result = await suggestFromEvent(req.currentUser.id, event, { accountId: accountId ?? null, domains });
      if (result.suggestion) {
        outcome.suggested += 1;
        if (!result.suggestion.account_id) outcome.unmatched += 1;
      } else if (result.skipped === 'internal') outcome.internal += 1;
      else if (result.skipped === 'cancelled') outcome.cancelled += 1;
      else outcome.already += 1;
    }
    res.status(201).json({ events: events.length, ...outcome });
  }),
);

router.get(
  '/suggestions',
  asyncHandler(async (req, res) => {
    res.json({ suggestions: await listSuggestions(req.currentUser.id) });
  }),
);

router.post(
  '/suggestions/:id/confirm',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const edits = z.object({
      account_id: z.number().int().positive().nullable().optional(),
      opportunity_id: z.number().int().positive().nullable().optional(),
      direction: z.enum(['OUTBOUND', 'INBOUND']).optional(),
      subject: z.string().max(300).nullable().optional(),
      body: z.string().max(20000).nullable().optional(),
      took_place: z.boolean().optional(),
      outcome: z.string().max(20000).nullable().optional(),
      commitment: z.object({ what: z.string().max(2000), due_on: day.nullable().optional() }).nullable().optional(),
      next_step: z.string().max(2000).nullable().optional(),
      next_step_owner_id: z.number().int().positive().nullable().optional(),
      next_step_due: day.nullable().optional(),
    }).parse(req.body || {});
    res.json(await confirmSuggestion(req.currentUser, Number(req.params.id), edits));
  }),
);

router.post(
  '/suggestions/:id/dismiss',
  asyncHandler(async (req, res) => {
    res.json(await dismissSuggestion(req.currentUser, Number(req.params.id)));
  }),
);

// ---------------------------------------------------------------- reading Gmail and Calendar

router.get(
  '/mailbox-sync',
  asyncHandler(async (req, res) => {
    res.json({ availability: await syncAvailability(), mine: await mySyncSettings(req.currentUser.id) });
  }),
);

router.put(
  '/mailbox-sync',
  asyncHandler(async (req, res) => {
    const data = z.object({
      gmail_enabled: z.boolean().optional(),
      calendar_enabled: z.boolean().optional(),
    }).parse(req.body);
    const availability = await syncAvailability();
    if (!availability.available && (data.gmail_enabled || data.calendar_enabled)) throw badRequest(availability.reason);
    res.json({ availability, mine: await setMySyncSettings(req.currentUser.id, data) });
  }),
);

router.post(
  '/mailbox-sync/run',
  asyncHandler(async (req, res) => {
    if (!hasPermission(req.currentUser, 'crm.activity.log')) throw forbidden('You cannot log activity on organizations');
    // each check is a burst of calls to Google; once a minute is plenty
    const mine = await mySyncSettings(req.currentUser.id);
    if (mine.last_synced_at && Date.now() - new Date(mine.last_synced_at).getTime() < 60_000) {
      throw badRequest('Checked less than a minute ago — try again shortly');
    }
    res.json({ result: await syncMailbox(req.currentUser), suggestions: await listSuggestions(req.currentUser.id) });
  }),
);

export default router;
