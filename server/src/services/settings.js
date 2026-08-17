import { query } from '../db/pool.js';

export const DEFAULT_SETTINGS = {
  blackmarks: {
    // a member with this many missed deadlines in a month is flagged for review
    missedDeadlineLimit: 3,
    // point thresholds used to colour the monthly review
    warningPoints: 3,
    criticalPoints: 6,
    // notify the member when a black mark is recorded
    notifyMember: true,
    // notify their department manager too
    notifyManagers: true,
    // black marks older than this many months drop out of the rolling review
    rollingWindowMonths: 1,
  },
  workload: {
    // a member with no activity for this many days shows up as idle
    idleDays: 3,
    // % of weekly capacity above which a member is considered overloaded
    overloadedPercent: 100,
    // due within this many days counts as "due soon" on the dashboard
    dueSoonDays: 3,
  },
  taskTypes: [
    'task',
    'bug',
    'feature',
    'enhancement',
    'customer-query',
    'procurement',
    'content',
    'campaign',
    'advisory',
    'documentation',
    'compliance',
  ],
  organisation: {
    name: 'EkoSight',
    workingDays: [1, 2, 3, 4, 5, 6],
  },
  okr: {
    // the module's on/off switch — no separate feature-flag framework needed,
    // since this settings store already exists and is editable without a deploy
    enabled: true,
    health: {
      // percentage points behind the expected pace before a goal changes state
      atRiskBehindPoints: 10,
      offTrackBehindPoints: 25,
    },
    // the intelligence layer: what "not moving" and "not active" mean, in days,
    // and how often the system is allowed to nudge the person accountable
    attention: {
      // watch and remind, or stay silent
      enabled: true,
      // a key result nobody has touched for this long is going stale
      staleKeyResultDays: 7,
      // a whole goal with no check-in on any of its results for this long has stalled
      stalledObjectiveDays: 10,
      // a department with active goals but no check-in activity for this long is idle
      idleDepartmentDays: 10,
      // at most one reminder to the same person inside this many hours
      reminderHours: 24,
      // also copy the objective owner's manager on a reminder
      notifyManagers: false,
    },
  },
  crm: {
    // the module's on/off switch, like Goals
    enabled: true,
    // keep every deal moving, and keep every deal warm
    cadence: {
      // watch and remind, or stay silent
      enabled: true,
      // a lead that hasn't advanced a stage in this long needs a push
      stageStaleDays: 7,
      // a lead with no logged activity in this long has gone cold
      engagementDays: 7,
      // at most one reminder to the same person inside this many hours
      reminderHours: 24,
    },
  },
};

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const deepMerge = (base, override) => {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
};

export async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return deepMerge(DEFAULT_SETTINGS, stored);
}

export async function getSetting(key) {
  const all = await getSettings();
  return all[key];
}

export async function updateSetting(key, value, userId) {
  if (!(key in DEFAULT_SETTINGS)) {
    throw new Error(`Unknown settings key: ${key}`);
  }
  const merged = isPlainObject(DEFAULT_SETTINGS[key]) ? deepMerge(DEFAULT_SETTINGS[key], value) : value;
  const { rows } = await query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING key, value`,
    [key, JSON.stringify(merged), userId || null],
  );
  return rows[0];
}
