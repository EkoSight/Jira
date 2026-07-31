/**
 * A worked example of mounting TaskFlow inside an existing Express application.
 *
 * Run it directly to try the pattern:
 *   node docs/examples/mount-in-existing-app.js
 *
 * It stands in for the real EkoSight app with a fake session, so you can see
 * exactly which pieces the host has to supply.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTaskFlowRouter,
  runMigrations,
  startDeadlineScanner,
  errorHandler,
} from '../../server/src/module.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// ---------------------------------------------------------------------------
// 1. The host application's own routes and authentication, unchanged.
// ---------------------------------------------------------------------------

app.get('/api/existing/whoami', (req, res) => res.json({ app: 'ekosight-main' }));

/** Stand-in for the real session middleware. */
const requireLogin = (req, res, next) => {
  // in the real app this comes from the session / JWT / passport
  req.user = { id: 42, email: 'admin@ekosight.com', name: 'Administrator' };
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  next();
};

// ---------------------------------------------------------------------------
// 2. TaskFlow, mounted behind that same authentication.
//
//    With TRUST_HOST_AUTH=true, TaskFlow resolves the caller from req.user:
//    by req.taskflowUserId if you set it, otherwise by matching req.user.id
//    against external_user_id, or falling back to the email address.
// ---------------------------------------------------------------------------

await runMigrations();

app.use(
  process.env.API_PREFIX || '/api/taskflow',
  requireLogin,
  (req, res, next) => {
    // Optional: if the host keeps an explicit mapping, hand it over directly.
    // req.taskflowUserId = req.session.user.taskflowUserId;
    next();
  },
  createTaskFlowRouter(),
);

// ---------------------------------------------------------------------------
// 3. Serve the built PWA from a sub-path of the main site.
//    Build it first with:  VITE_BASE=/taskflow/ npm --workspace client run build
// ---------------------------------------------------------------------------

const clientDist = path.resolve(here, '../../client/dist');
app.use('/taskflow', express.static(clientDist));
app.get(/^\/taskflow(?!\/api).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

// ---------------------------------------------------------------------------
// 4. Background work: run the deadline / black mark scan on exactly one instance.
// ---------------------------------------------------------------------------

if (process.env.ENABLE_SCANNER !== 'false') startDeadlineScanner();

// TaskFlow's error handler understands its own error types; mount it last, or
// translate them in the host application's handler.
app.use(errorHandler);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`example host app listening on http://localhost:${port}`);
  console.log(`  TaskFlow API  -> http://localhost:${port}/api/taskflow/health`);
  console.log(`  TaskFlow PWA  -> http://localhost:${port}/taskflow/`);
});
