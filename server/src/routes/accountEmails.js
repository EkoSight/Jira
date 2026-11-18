/**
 * Settings → Email: whether account emails can go out, a test to oneself, and
 * (development only) the account emails the outbox recorded.
 */
import { Router } from 'express';
import { asyncHandler, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { config } from '../config.js';
import { outbox, providerName } from '../services/marketing/providers.js';
import { emailReadiness, sendAccountEmail } from '../services/accountEmail.js';

const router = Router();
const manage = requirePermission('settings.manage');

router.get('/status', manage, asyncHandler(async (req, res) => {
  const readiness = await emailReadiness();
  res.json({
    ready: readiness.ready,
    reason: readiness.reason,
    provider: readiness.provider,
    provider_label: readiness.provider_label,
    delivers: readiness.delivers,
    missing: readiness.missing,
    outbox_only: readiness.provider === 'log',
  });
}));

/** A sample to the signed-in administrator's own address. It carries no password. */
router.post('/test', manage, asyncHandler(async (req, res) => {
  const result = await sendAccountEmail({ kind: 'TEST', user: req.currentUser, actor: req.currentUser });
  res.json({ email: { sent: result.sent, status: result.status, reason: result.reason, to: result.to } });
}));

// Development and staging with EMAIL_PROVIDER unset: nothing is delivered, so
// the system emails the outbox recorded (account emails, and reminder emails
// with ?include=reminders) can be read here. Never in production.
const outboxOnly = (req, res, next) => {
  if (config.env === 'production' || providerName() !== 'log') return next(notFound());
  next();
};
router.get('/dev/outbox', manage, outboxOnly, (req, res) => {
  const prefix = req.query.include === 'reminders' ? /^(acct|rem)-/ : /^acct-/;
  const list = outbox().filter((m) => prefix.test(String(m.reference || ''))).slice(-40).reverse();
  res.json({ messages: list.map(({ raw, ...m }) => ({ to: m.to, subject: m.subject, text: m.text, html: m.html, at: m.at, kind: m.headers?.['X-TaskFlow-Kind'] || null })) });
});

export default router;
