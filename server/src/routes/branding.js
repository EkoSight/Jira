import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import {
  ASSET_KINDS, assetFile, brandingHistory, clearAsset, iconFile, publicBranding, resetBranding, saveBranding, undoBranding, uploadAsset,
} from '../services/branding.js';
import { ACCENT_PRESETS, checkBranding } from '../../../shared/brandTheme.js';

/**
 * Branding is public to read (the sign-in page shows the name, colours and
 * logo before anyone signs in) and changed only with settings.manage.
 */
export const publicBrandingRouter = Router();

publicBrandingRouter.get('/', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ ...(await publicBranding(config.apiPrefix)), accentPresets: ACCENT_PRESETS });
}));

publicBrandingRouter.get('/assets/:kind', asyncHandler(async (req, res) => {
  const found = await assetFile(String(req.params.kind));
  if (!found) throw notFound('No such logo');
  res.set({
    'Content-Type': found.mime,
    'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    // an SVG opened on its own could otherwise run a script: this stops it
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  });
  fs.createReadStream(found.file).on('error', () => res.status(404).end()).pipe(res);
}));

publicBrandingRouter.get('/icons/:name', asyncHandler(async (req, res) => {
  const file = await iconFile(String(req.params.name));
  if (!file) throw notFound('No such icon');
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
}));

// ---------------------------------------------------------------- changes (signed in, settings.manage)

export const brandingAdminRouter = Router();
const manage = requirePermission('settings.manage');
const assetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');

/** Checks colours without saving: what the preview shows. */
brandingAdminRouter.post('/check', manage, asyncHandler(async (req, res) => {
  const d = z.object({ primary: z.string().max(9), accent: z.string().max(9) }).parse(req.body || {});
  res.json(checkBranding(d));
}));

brandingAdminRouter.put('/', manage, asyncHandler(async (req, res) => {
  const d = z.object({
    appName: z.string().max(60).optional(), byline: z.string().max(80).optional(),
    primary: z.string().max(9).optional(), accent: z.string().max(9).optional(),
  }).parse(req.body || {});
  await saveBranding(d, req.currentUser);
  res.json(await publicBranding(config.apiPrefix));
}));
brandingAdminRouter.post('/reset', manage, asyncHandler(async (req, res) => {
  await resetBranding(req.currentUser);
  res.json(await publicBranding(config.apiPrefix));
}));
brandingAdminRouter.post('/undo', manage, asyncHandler(async (req, res) => {
  await undoBranding(req.currentUser);
  res.json(await publicBranding(config.apiPrefix));
}));
brandingAdminRouter.get('/history', manage, asyncHandler(async (req, res) => res.json({ history: await brandingHistory() })));

brandingAdminRouter.post('/assets/:kind', manage, (req, res, next) => assetUpload(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return next(badRequest('Logos are at most 2 MB'));
  return next(err);
}), asyncHandler(async (req, res) => {
  if (!ASSET_KINDS.includes(req.params.kind)) throw notFound('Unknown logo');
  await uploadAsset(req.params.kind, req.file, req.currentUser);
  res.status(201).json(await publicBranding(config.apiPrefix));
}));
brandingAdminRouter.delete('/assets/:kind', manage, asyncHandler(async (req, res) => {
  await clearAsset(req.params.kind, req.currentUser);
  res.json(await publicBranding(config.apiPrefix));
}));
