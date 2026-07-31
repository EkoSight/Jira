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

  return router;
}

export default createTaskFlowRouter;
