import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import {
  taskSummary,
  breakdowns,
  workload,
  throughput,
  upcomingDeadlines,
  recentActivity,
} from '../services/metrics.js';
import {
  evidenceFor, kudosEvidence, markEvidence, performanceReview, teamReview,
} from '../services/performance.js';
import { notify } from '../services/activity.js';
import { getSettings } from '../services/settings.js';

const router = Router();

/** Members without the org-wide view only ever see their own numbers. */
const scopeFor = (req) => {
  const scope = {};
  if (req.query.department_id) scope.departmentId = Number(req.query.department_id);
  if (req.query.assignee_id) scope.assigneeId = Number(req.query.assignee_id);
  if (!hasPermission(req.currentUser, 'report.view')) {
    // their own numbers cover what they own and what they follow
    delete scope.assigneeId;
    delete scope.departmentId;
    scope.mineUserId = req.currentUser.id;
  }
  return scope;
};

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const scope = scopeFor(req);
    const canSeeTeam = hasPermission(req.currentUser, 'report.view');

    const [summary, breakdown, deadlines, activity, trend, settings, team] = await Promise.all([
      taskSummary(scope),
      breakdowns(scope),
      upcomingDeadlines({ days: Number(req.query.deadline_days) || 7, ...scope }),
      recentActivity({ limit: 15, ...scope }),
      throughput({ days: Number(req.query.trend_days) || 14, ...scope }),
      getSettings(),
      // the team's workload is visible to everyone, not just report viewers
      workload({ departmentId: scope.departmentId }),
    ]);

    res.json({
      summary,
      ...breakdown,
      upcoming: deadlines,
      activity,
      trend,
      workload: team,
      settings: { workload: settings.workload, blackmarks: settings.blackmarks },
      scope: { departmentId: scope.departmentId ?? null, assigneeId: scope.assigneeId ?? null, teamVisible: canSeeTeam },
    });
  }),
);

/**
 * Who is carrying what. This is open to everyone: bandwidth, open and overdue
 * counts and last activity are how the team sees where the load actually sits, so
 * they are deliberately transparent rather than a manager-only view.
 */
router.get(
  '/workload',
  asyncHandler(async (req, res) => {
    res.json({
      workload: await workload({
        departmentId: req.query.department_id ? Number(req.query.department_id) : null,
      }),
    });
  }),
);

/**
 * One person's review. Everyone can read their own; seeing someone else's needs
 * the reporting permission.
 */
router.get(
  '/performance/:userId',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (userId !== req.currentUser.id && !hasPermission(req.currentUser, 'report.view')) {
      throw forbidden('You can only view your own review');
    }

    const review = await performanceReview({ userId, month: req.query.month });
    if (!review) throw notFound('Team member not found');
    res.json({ review });
  }),
);

/**
 * The records behind one figure on a review.
 *
 * A review that cannot be opened up is an accusation: "8 tasks are overdue" is
 * only useful if you can see which eight and go and do something about them.
 * Same permission rule as the review itself — being able to read a number and
 * being able to read the rows it came from are the same permission.
 */
router.get(
  '/performance/:userId/evidence',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (userId !== req.currentUser.id && !hasPermission(req.currentUser, 'report.view')) {
      throw forbidden('You can only view your own review');
    }

    const metric = String(req.query.metric || '');
    const options = { month: req.query.month, taskType: req.query.task_type };

    if (metric === 'markCount' || metric === 'markPoints') {
      return res.json({ evidence: await markEvidence(userId, options) });
    }
    if (metric === 'kudos') {
      return res.json({ evidence: await kudosEvidence(userId, options) });
    }

    const evidence = await evidenceFor(userId, metric, options);
    if (!evidence) throw notFound('There is nothing recorded behind that figure');
    return res.json({ evidence });
  }),
);

/** Everyone's review at once, worst standing first — the monthly review list. */
router.get(
  '/performance',
  requirePermission('report.view'),
  asyncHandler(async (req, res) => {
    const reviews = await teamReview({
      month: req.query.month,
      departmentId: req.query.department_id ? Number(req.query.department_id) : null,
    });
    res.json({ reviews });
  }),
);

/**
 * Sends a review to the person it is about, with an optional note from the
 * manager. Feedback they cannot see is not feedback.
 */
router.post(
  '/performance/:userId/share',
  requirePermission('report.view'),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    const { message, month } = z
      .object({ message: z.string().max(2000).optional(), month: z.string().optional() })
      .parse(req.body ?? {});

    const review = await performanceReview({ userId, month });
    if (!review) throw notFound('Team member not found');

    const body = [
      review.summary,
      message?.trim(),
      review.suggestions.length ? `Suggested focus: ${review.suggestions[0].title}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    await notify(null, {
      userId,
      type: 'performance_review',
      title: `Your ${review.month} review from ${req.currentUser.full_name}`,
      body,
    });

    res.json({ ok: true, shared_with: review.user.full_name });
  }),
);

router.get(
  '/throughput',
  asyncHandler(async (req, res) => {
    res.json({ trend: await throughput({ days: Number(req.query.days) || 30, ...scopeFor(req) }) });
  }),
);

export default router;
