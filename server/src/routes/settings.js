import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { getSettings, updateSetting, DEFAULT_SETTINGS } from '../services/settings.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS });
  }),
);

router.put(
  '/:key',
  requirePermission('settings.manage'),
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    if (!(key in DEFAULT_SETTINGS)) throw badRequest(`Unknown settings key "${key}"`);
    const value = z.any().parse(req.body?.value);
    if (value === undefined) throw badRequest('Body must be { "value": ... }');
    const saved = await updateSetting(key, value, req.currentUser.id);
    res.json({ setting: saved, settings: await getSettings() });
  }),
);

export default router;
