import { getSettings } from '../services/settings.js';
import { notFound } from '../lib/errors.js';

/**
 * The module's on/off switch.
 *
 * Turning settings.okr.enabled off makes the whole Goals API behave as if it
 * were never installed — no separate feature-flag framework, no deploy, and
 * nothing else in TaskFlow changes either way.
 */
export const requireOkrEnabled = async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings.okr?.enabled === false) throw notFound('Goals are switched off');
    next();
  } catch (err) {
    next(err);
  }
};
