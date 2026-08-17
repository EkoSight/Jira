/** Shared OKR vocabulary. Kept in one place so no thresholds live as magic numbers. */

export const OBJECTIVE_SCOPES = ['COMPANY', 'DEPARTMENT'];
export const OBJECTIVE_STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
export const KEY_RESULT_STATUSES = OBJECTIVE_STATUSES;
export const MEASUREMENT_TYPES = ['NUMBER', 'PERCENTAGE', 'CURRENCY', 'BINARY', 'MILESTONE', 'TASK_ROLLUP'];
export const DIRECTIONS = ['INCREASE', 'DECREASE'];
export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];

export const HEALTH = {
  NOT_STARTED: 'NOT_STARTED',
  ON_TRACK: 'ON_TRACK',
  AT_RISK: 'AT_RISK',
  OFF_TRACK: 'OFF_TRACK',
  COMPLETED: 'COMPLETED',
};

export const HEALTH_STATUSES = Object.values(HEALTH);

/**
 * How far behind the expected pace a goal may fall before it stops being "on
 * track". Percentage points, overridable through settings.okr.health.
 */
export const DEFAULT_HEALTH_THRESHOLDS = {
  atRiskBehindPoints: 10,
  offTrackBehindPoints: 25,
};
