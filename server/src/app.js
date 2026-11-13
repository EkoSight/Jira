import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createTaskFlowRouter } from './router.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { manifest } from './services/branding.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({
    limit: '1mb',
    // provider webhooks are signed over the exact bytes sent, so those keep them
    verify: (req, res, buf) => {
      if (req.originalUrl?.startsWith(`${config.apiPrefix}/s/`)) req.rawBody = buf;
    },
  }));

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

  // the installed app's name, colour and icons follow Settings → Branding
  app.get('/manifest.webmanifest', async (req, res, next) => {
    try {
      res.set({ 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
      res.send(JSON.stringify(await manifest(config.apiPrefix)));
    } catch (err) { next(err); }
  });
  // the face finder's engine, sent compressed (it is large, and phones are often on mobile data)
  app.get(/^\/vendor\/mediapipe\/.+\.wasm$/, (req, res, next) => {
    const file = path.join(clientDist, req.path);
    const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (!file.startsWith(clientDist) || !accepts || !fs.existsSync(`${file}.gz`)) return next();
    res.set({ 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=31536000, immutable' });
    return fs.createReadStream(`${file}.gz`).pipe(res);
  });

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
