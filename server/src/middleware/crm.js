import { getSettings } from '../services/settings.js';
import { notFound } from '../lib/errors.js';

/**
 * The CRM module's on/off switch. Turning settings.crm.enabled off makes the
 * whole pipeline API behave as if it were never installed.
 */
export const requireCrmEnabled = async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings.crm?.enabled === false) throw notFound('The pipeline is switched off');
    next();
  } catch (err) {
    next(err);
  }
};
