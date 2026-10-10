import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, forbidden } from '../lib/errors.js';
import { hasAnyPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { sendCsv } from '../lib/csv.js';
import { dataQuality, dismissDuplicate } from '../services/dataQuality.js';
import { pipelineWorkload } from '../services/pipelineWorkload.js';
import { investorSummary, summaryRows } from '../services/investorSummary.js';
import { AUDIT_GROUPS, AUDIT_HEADER, auditLog, auditRows, recordAuditEvent } from '../services/audit.js';
import { myPreferences, recentReminders, reminderDefaults, setMyPreferences } from '../services/reminders.js';
import { today } from '../services/dealRules.js';

/**
 * Reporting and controls for the pipeline: data quality, who owes what, the
 * investor summary, the audit trail, and each person's reminder schedule.
 */
const router = Router();

const isDay = /^\d{4}-\d{2}-\d{2}$/;
const mustReport = (req) => {
  if (!hasAnyPermission(req.currentUser, ['crm.manage.any', 'report.view'])) {
    throw forbidden('Only pipeline managers and people with reports access can see this');
  }
};

// ---------------------------------------------------------------- data quality

router.get(
  '/data-quality',
  asyncHandler(async (req, res) => {
    res.json(await dataQuality({
      departmentId: req.query.department_id || null,
      ownerId: req.query.mine === 'true' ? req.currentUser.id : (req.query.owner_id || null),
      taskDays: Math.min(Math.max(Number(req.query.task_days) || 90, 1), 730),
    }));
  }),
);

/** Two organizations checked and found to be different; never merged automatically. */
router.post(
  '/data-quality/duplicates/dismiss',
  requirePermission('crm.manage.any'),
  asyncHandler(async (req, res) => {
    const data = z.object({
      account_ids: z.array(z.number().int().positive()).length(2),
      reason: z.string().max(2000),
    }).parse(req.body);
    res.json(await dismissDuplicate({ accountIds: data.account_ids, reason: data.reason, actor: req.currentUser }));
  }),
);

// ---------------------------------------------------------------- workload

router.get(
  '/workload',
  asyncHandler(async (req, res) => {
    res.json(await pipelineWorkload({ departmentId: req.query.department_id || null }));
  }),
);

// ---------------------------------------------------------------- the investor summary

const summaryInput = (req) => ({
  from: isDay.test(String(req.query.from || '')) ? String(req.query.from) : null,
  to: isDay.test(String(req.query.to || '')) ? String(req.query.to) : null,
  anonymise: req.query.anonymise === 'true',
});

const logSummary = (req, summary, how) => recordAuditEvent(null, {
  action: 'investor_summary_exported',
  summary: `Pipeline summary for ${summary.period.from} to ${summary.period.to} ${how}${summary.anonymised ? ', names hidden' : ''}`,
  detail: {
    period: summary.period, anonymised: summary.anonymised, how,
    figures: {
      bookings: summary.verified.bookings.amount,
      invoiced: summary.verified.invoiced.amount,
      collections: summary.verified.collections.amount,
    },
  },
  actorId: req.currentUser.id,
});

router.get(
  '/investor-summary',
  asyncHandler(async (req, res) => {
    mustReport(req);
    res.json(await investorSummary(summaryInput(req)));
  }),
);

router.get(
  '/investor-summary.csv',
  asyncHandler(async (req, res) => {
    mustReport(req);
    const summary = await investorSummary(summaryInput(req));
    await logSummary(req, summary, 'downloaded');
    sendCsv(res, `pipeline-summary-${summary.period.from}-to-${summary.period.to}.csv`,
      ['Section', 'Measure', 'Value', 'What it means'], summaryRows(summary));
  }),
);

/** The screen tells the server when the summary is printed, so the audit trail has it. */
router.post(
  '/investor-summary/printed',
  asyncHandler(async (req, res) => {
    mustReport(req);
    const summary = await investorSummary({
      from: isDay.test(String(req.body?.from || '')) ? req.body.from : null,
      to: isDay.test(String(req.body?.to || '')) ? req.body.to : null,
      anonymise: req.body?.anonymise === true,
    });
    await logSummary(req, summary, 'printed');
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- the audit trail

const auditInput = (req, limit) => ({
  group: AUDIT_GROUPS[req.query.group] ? String(req.query.group) : null,
  actorId: req.query.actor_id || null,
  accountId: req.query.account_id || null,
  opportunityId: req.query.opportunity_id || null,
  departmentId: req.query.department_id || null,
  from: isDay.test(String(req.query.from || '')) ? String(req.query.from) : null,
  to: isDay.test(String(req.query.to || '')) ? String(req.query.to) : null,
  search: req.query.search ? String(req.query.search).slice(0, 100) : null,
  limit: limit ?? req.query.limit,
  offset: req.query.offset,
});

router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    mustReport(req);
    res.json(await auditLog(auditInput(req)));
  }),
);

router.get(
  '/audit.csv',
  asyncHandler(async (req, res) => {
    mustReport(req);
    const { entries } = await auditLog(auditInput(req, 1000));
    sendCsv(res, `pipeline-audit-${today()}.csv`, AUDIT_HEADER, auditRows(entries));
  }),
);

// ---------------------------------------------------------------- my reminders

router.get(
  '/reminders/mine',
  asyncHandler(async (req, res) => {
    const [preferences, defaults, recent] = await Promise.all([
      myPreferences(req.currentUser.id), reminderDefaults(), recentReminders(req.currentUser.id),
    ]);
    res.json({ preferences, defaults, recent });
  }),
);

router.put(
  '/reminders/mine',
  asyncHandler(async (req, res) => {
    const data = z.object({
      digest_time: z.string().max(5).optional(),
      digest_days: z.array(z.number().int()).max(7).optional(),
      paused_until: z.string().regex(isDay).nullable().optional(),
      pause_reason: z.string().max(500).nullable().optional(),
      cover_while_away: z.boolean().optional(),
    }).parse(req.body);
    const todayDate = today();
    const current = await myPreferences(req.currentUser.id);
    // a pause that has run out is not carried into the new choices
    const live = current.paused_until && current.paused_until >= todayDate;
    const merged = {
      digest_time: current.digest_time,
      digest_days: current.digest_days,
      paused_until: live ? current.paused_until : null,
      pause_reason: live ? current.pause_reason : null,
      cover_while_away: current.cover_while_away,
      ...data,
    };
    res.json({ preferences: await setMyPreferences(req.currentUser.id, merged, { todayDate }) });
  }),
);

export default router;
