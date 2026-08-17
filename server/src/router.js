import { Router } from 'express';
import { authenticate, touchActivity } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import departmentRoutes from './routes/departments.js';
import statusRoutes from './routes/statuses.js';
import taskRoutes from './routes/tasks.js';
import blackmarkRoutes from './routes/blackmarks.js';
import reportRoutes from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import notificationRoutes from './routes/notifications.js';
import noteRoutes from './routes/notes.js';
import featureRequestRoutes from './routes/featureRequests.js';
import recognitionRoutes from './routes/recognition.js';
import objectiveRoutes from './routes/objectives.js';
import keyResultRoutes from './routes/keyResults.js';
import accountRoutes from './routes/accounts.js';
import { requireOkrEnabled } from './middleware/okr.js';
import { requireCrmEnabled } from './middleware/crm.js';
import { requirePermission } from './middleware/auth.js';

/**
 * The whole TaskFlow API as a single Express router.
 *
 * Standalone:  app.use('/api/taskflow', createTaskFlowRouter())
 * Embedded:    existingApp.use('/api/taskflow', requireHostLogin, createTaskFlowRouter())
 *              with TRUST_HOST_AUTH=true so the host session is reused.
 */
export function createTaskFlowRouter() {
  const router = Router();

  router.get('/health', (req, res) => res.json({ ok: true, service: 'taskflow' }));
  router.use('/auth', authRoutes);

  // everything below needs a signed-in caller
  router.use(authenticate, touchActivity);

  router.use('/users', userRoutes);
  router.use('/departments', departmentRoutes);
  router.use('/statuses', statusRoutes);
  router.use('/tasks', taskRoutes);
  router.use('/blackmarks', blackmarkRoutes);
  router.use('/reports', reportRoutes);
  router.use('/settings', settingsRoutes);
  router.use('/notifications', notificationRoutes);
  router.use('/notes', noteRoutes);
  router.use('/feature-requests', featureRequestRoutes);
  router.use('/recognition', recognitionRoutes);

  // Goals / OKR. Mounted alongside the rest rather than woven through it, so the
  // routes above are byte-for-byte the ones that shipped before this module.
  router.use('/objectives', requireOkrEnabled, requirePermission('okr.view'), objectiveRoutes);
  router.use('/key-results', requireOkrEnabled, requirePermission('okr.view'), keyResultRoutes);

  // CRM / pipeline, mounted the same way — off cleanly when disabled
  router.use('/accounts', requireCrmEnabled, requirePermission('crm.view'), accountRoutes);

  return router;
}

export default createTaskFlowRouter;
