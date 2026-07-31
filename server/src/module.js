/**
 * Public entry point for embedding TaskFlow into the existing EkoSight application.
 *
 *   import { createTaskFlowRouter, runMigrations, startDeadlineScanner } from '@taskflow/server';
 *
 *   await runMigrations();
 *   app.use('/api/taskflow', yourAuthMiddleware, createTaskFlowRouter());
 *   startDeadlineScanner();
 *
 * See docs/INTEGRATION.md for the full checklist.
 */
export { createTaskFlowRouter } from './router.js';
export { runMigrations } from './db/migrate.js';
export { startDeadlineScanner, stopDeadlineScanner } from './jobs/deadlineScanner.js';
export { pool, query, withTransaction, closePool } from './db/pool.js';
export { authenticate, requirePermission, signToken } from './middleware/auth.js';
export { errorHandler, notFoundHandler } from './middleware/error.js';
export { PERMISSIONS, ROLE_PERMISSIONS, effectivePermissions, hasPermission } from './lib/permissions.js';
export { runBlackMarkScan, monthlyReview, recordBlackMark } from './services/blackmarks.js';
export { config } from './config.js';
