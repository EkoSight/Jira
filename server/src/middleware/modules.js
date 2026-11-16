import { getSettings } from '../services/settings.js';
import { notFound } from '../lib/errors.js';

/**
 * A module's on/off switch (settings.<key>.enabled). Off makes its API answer
 * as if it were never installed; the data stays as it is.
 */
export const requireModule = (key, message) => async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (settings[key]?.enabled === false) throw notFound(message);
    next();
  } catch (err) {
    next(err);
  }
};

export const requireProjectsEnabled = requireModule('projects', 'Projects are switched off');
export const requireTodosEnabled = requireModule('todos', 'To-dos are switched off');
