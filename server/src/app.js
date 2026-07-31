import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createTaskFlowRouter } from './router.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // CORS only guards the API. Static assets are same-origin, and rejecting an
  // unknown origin here means "no CORS headers", never a 500.
  const corsMiddleware = cors({
    origin: (origin, cb) => {
      const allowed =
        !origin || config.cors.origins.includes('*') || config.cors.origins.includes(origin);
      cb(null, allowed);
    },
    credentials: true,
  });

  app.use(config.apiPrefix, corsMiddleware, createTaskFlowRouter());

  // in production the built PWA is served from the same origin as the API
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^\/(?!api).*/, (req, res, next) => {
      const indexFile = path.join(clientDist, 'index.html');
      if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
      next();
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
