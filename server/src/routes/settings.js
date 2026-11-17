import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { getSettings, updateSetting, DEFAULT_SETTINGS } from '../services/settings.js';

const router = Router();

// Settings → Email: the sender of account emails and how long a temporary password works
const emailOrEmpty = z.union([z.literal(''), z.string().trim().email('Enter a valid email address').max(320)]);
const ACCOUNT_EMAILS = z.object({
  senderName: z.string().trim().min(1, 'Give the sender a name').max(80).regex(/^[^\r\n<>]*$/, 'No line breaks or angle brackets').optional(),
  senderEmail: emailOrEmpty.optional(),
  replyTo: emailOrEmpty.optional(),
  expiryHours: z.number().int().min(1, 'At least 1 hour').max(168, 'At most 7 days (168 hours)').optional(),
  forgotPassword: z.boolean().optional(),
}).strict();

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
    if (key === 'accountEmails') ACCOUNT_EMAILS.parse(value);
    const saved = await updateSetting(key, value, req.currentUser.id);
    res.json({ setting: saved, settings: await getSettings() });
  }),
);

export default router;
