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
import threadRoutes from './routes/threads.js';
import opportunityRoutes from './routes/opportunities.js';
import crmWeeklyRoutes from './routes/crmWeekly.js';
import crmControlsRoutes from './routes/crmControls.js';
import meetingRoutes from './routes/meetings.js';
import engagementRoutes from './routes/engagements.js';
import resourceRoutes from './routes/resources.js';
import availabilityRoutes from './routes/availability.js';
import attendanceRoutes from './routes/attendance.js';
import leaveRoutes from './routes/leave.js';
import payrollRoutes from './routes/payroll.js';
import { requireAttendance } from './services/attendance.js';
import chatRoutes, { chatEventsRouter } from './routes/googleChat.js';
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
  // Google Chat calls this itself, with a token Google signs — not a TaskFlow login
  router.use('/integrations/google-chat/events', chatEventsRouter);

  // everything below needs a signed-in caller
  router.use(authenticate, touchActivity);

  router.use('/users', userRoutes);
  router.use('/departments', departmentRoutes);
  router.use('/statuses', statusRoutes);
  router.use('/tasks', requireAttendance, taskRoutes);
  router.use('/blackmarks', blackmarkRoutes);
  router.use('/reports', reportRoutes);
  router.use('/settings', settingsRoutes);
  router.use('/notifications', notificationRoutes);
  router.use('/notes', noteRoutes);
  router.use('/feature-requests', featureRequestRoutes);
  router.use('/recognition', recognitionRoutes);
  // who is away and when — open to everyone signed in, so work is planned around it
  router.use('/availability', availabilityRoutes);

  // Attendance, leave and payroll. Attendance and leave are never behind the
  // check-in requirement — someone who cannot check in can always reach their
  // own record, ask for a correction or leave, and sign out.
  router.use('/attendance', attendanceRoutes);
  router.use('/leave', leaveRoutes);
  router.use('/payroll', payrollRoutes);
  // your own Google Chat link and alerts; the admin's view of the set-up
  router.use('/chat', chatRoutes);

  // Discussion and review threads. One mount for tasks, key results and goals,
  // because the conversation is the same shape wherever the work sits — and each
  // request asks that entity's own access rule before it answers.
  router.use('/threads', requireAttendance, threadRoutes);

  // Goals / OKR. Mounted alongside the rest rather than woven through it, so the
  // routes above are byte-for-byte the ones that shipped before this module.
  router.use('/objectives', requireAttendance, requireOkrEnabled, requirePermission('okr.view'), objectiveRoutes);
  router.use('/key-results', requireAttendance, requireOkrEnabled, requirePermission('okr.view'), keyResultRoutes);

  // CRM / pipeline, mounted the same way — off cleanly when disabled
  router.use('/accounts', requireAttendance, requireCrmEnabled, requirePermission('crm.view'), accountRoutes);
  // deals live alongside the organizations that hold them, behind the same gate
  router.use('/opportunities', requireAttendance, requireCrmEnabled, requirePermission('crm.view'), opportunityRoutes);
  router.use('/meetings', requireAttendance, requireCrmEnabled, requirePermission('crm.view'), meetingRoutes);
  router.use('/engagements', requireAttendance, requireCrmEnabled, requirePermission('crm.view'), engagementRoutes);
  router.use('/resources', requireAttendance, requireCrmEnabled, requirePermission('crm.view'), resourceRoutes);
  // the week's record, weekly reviews and imported correspondence
  router.use('/crm', requireAttendance, requireCrmEnabled, requirePermission('crm.view'), crmWeeklyRoutes);
  router.use('/crm', requireAttendance, requireCrmEnabled, requirePermission('crm.view'), crmControlsRoutes);

  return router;
}

export default createTaskFlowRouter;
