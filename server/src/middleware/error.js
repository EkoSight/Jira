import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import { isProd } from '../config.js';

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

  console.error('[taskflow] unhandled error', err);
  res.status(500).json({
    error: 'Something went wrong',
    ...(isProd ? {} : { detail: err.message, stack: err.stack }),
  });
};
