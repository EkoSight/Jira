import { Router } from 'express';
import { asyncHandler } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import {
  taskSummary,
  breakdowns,
  workload,
  throughput,
  upcomingDeadlines,
  recentActivity,
} from '../services/metrics.js';
import { getSettings } from '../services/settings.js';

const router = Router();

/** Members without the org-wide view only ever see their own numbers. */
const scopeFor = (req) => {
  const scope = {};
  if (req.query.department_id) scope.departmentId = Number(req.query.department_id);
  if (req.query.assignee_id) scope.assigneeId = Number(req.query.assignee_id);
  if (!hasPermission(req.currentUser, 'report.view')) {
    scope.assigneeId = req.currentUser.id;
    delete scope.departmentId;
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
      canSeeTeam ? workload({ departmentId: scope.departmentId }) : Promise.resolve([]),
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

router.get(
  '/workload',
  asyncHandler(async (req, res) => {
    if (!hasPermission(req.currentUser, 'report.view')) {
      return res.json({ workload: await workload({ userId: req.currentUser.id }) });
    }
    res.json({
      workload: await workload({
        departmentId: req.query.department_id ? Number(req.query.department_id) : null,
      }),
    });
  }),
);

router.get(
  '/throughput',
  asyncHandler(async (req, res) => {
    res.json({ trend: await throughput({ days: Number(req.query.days) || 30, ...scopeFor(req) }) });
  }),
);

export default router;
