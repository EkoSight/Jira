import { getSettings } from '../services/settings.js';
import { notFound } from '../lib/errors.js';

/**
 * Email marketing's on/off switch. Turning settings.marketing.enabled off makes
 * its staff API behave as if it were never installed. The public addresses in
 * emails already sent (unsubscribe, preferences) keep working regardless.
 */
export const requireMarketingEnabled = async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings.marketing?.enabled === false) throw notFound('Email marketing is switched off');
    next();
  } catch (err) {
    next(err);
  }
};
