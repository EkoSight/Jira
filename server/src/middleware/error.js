import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import { config, isProd } from '../config.js';

/**
 * Database-level failures that are almost always a setup problem rather than a
 * bug. Returning the fix beats a bare 500 that says "Something went wrong".
 */
function databaseSetupError(err) {
  const { schema, database } = config.db;

  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    return 'Cannot reach the database. Is PostgreSQL running?';
  }
  if (err.code === '42P01') {
    return `The TaskFlow tables are missing from schema "${schema}" in database "${database}". Run: npm run migrate && npm run seed`;
  }
  if (err.code === '3D000') {
    return `The database "${database}" does not exist. Create it with: createdb ${database}`;
  }
  if (err.code === '28P01' || err.code === '28000') {
    return 'PostgreSQL rejected the credentials. Check PGUSER and PGPASSWORD in server/.env';
  }
  if (err.code === '42501') {
    return `The database user does not have access to schema "${schema}".`;
  }
  return null;
}

export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
};

// eslint-disable-next-line no-unused-vars -- express identifies error middleware by arity
export const errorHandler = (err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  // postgres unique violation
  if (err?.code === '23505') {
    return res.status(409).json({ error: 'That record already exists' });
  }
  // postgres foreign key violation
  if (err?.code === '23503') {
    return res.status(400).json({ error: 'Referenced record does not exist' });
  }

  const setupProblem = databaseSetupError(err || {});
  if (setupProblem) {
    console.error(`[taskflow] database not ready: ${setupProblem}`);
    return res.status(503).json({ error: setupProblem, setup_required: true });
  }

  console.error('[taskflow] unhandled error', err);
  res.status(500).json({
    error: 'Something went wrong',
    ...(isProd ? {} : { detail: err.message, stack: err.stack }),
  });
};
