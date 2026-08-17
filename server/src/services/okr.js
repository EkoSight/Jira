import { query } from '../db/pool.js';
import { getSettings } from './settings.js';
import { HEALTH, DEFAULT_HEALTH_THRESHOLDS } from '../lib/okrConstants.js';

/**
 * The OKR engine.
 *
 * Progress and health are DERIVED, never stored. Every input they depend on
 * (current value, weights, task links, dates) is stored, so the numbers cannot
 * drift out of date the way a cached percentage would when a task is completed
 * or the clock passes midnight.
 */

// ---------------------------------------------------------------- progress SQL

/**
 * Result progress: has the outcome actually been achieved?
 * Returns NULL rather than 0 when it cannot be measured, so "not measurable" is
 * never mistaken for "no progress".
 */
const RESULT_PROGRESS = `
  CASE
    WHEN kr.measurement_type = 'BINARY'
      THEN CASE WHEN kr.current_value >= 1 THEN 100 ELSE 0 END
    WHEN kr.target_value IS NULL THEN NULL
    WHEN kr.direction = 'DECREASE' THEN
      CASE WHEN (kr.baseline_value - kr.target_value) = 0 THEN NULL
           ELSE ((kr.baseline_value - kr.current_value)
                 / (kr.baseline_value - kr.target_value)) * 100 END
    ELSE
      CASE WHEN (kr.target_value - kr.baseline_value) = 0 THEN NULL
           ELSE ((kr.current_value - kr.baseline_value)
                 / (kr.target_value - kr.baseline_value)) * 100 END
  END
`;

/** Execution progress: how much of the linked work is finished? */
const EXECUTION_PROGRESS = `
  (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
               ELSE (COUNT(*) FILTER (WHERE ws.stage = 'done')::numeric / COUNT(*)) * 100 END
     FROM task_key_result_links l
     JOIN tasks t ON t.id = l.task_id AND t.is_archived = FALSE
     JOIN workflow_statuses ws ON ws.id = t.status_id
    WHERE l.key_result_id = kr.id)
`;

const LINKED_TASK_COUNT = `
  (SELECT COUNT(*)::int FROM task_key_result_links l
     JOIN tasks t ON t.id = l.task_id AND t.is_archived = FALSE
    WHERE l.key_result_id = kr.id)
`;

/**
 * The number that drives an objective's roll-up. TASK_ROLLUP key results are the
 * one type where finishing the work IS the outcome, so they fall back to
 * execution progress; everything else must be measured on its own terms.
 */
const EFFECTIVE_PROGRESS = `
  CASE WHEN kr.measurement_type = 'TASK_ROLLUP'
       THEN ${EXECUTION_PROGRESS}
       ELSE ${RESULT_PROGRESS}
  END
`;

export const KEY_RESULT_SELECT = `
  SELECT kr.*,
         u.full_name AS owner_name, u.avatar_color AS owner_color,
         o.title AS objective_title, o.scope_type, o.department_id,
         o.start_date AS objective_start_date, o.end_date AS objective_end_date,
         ${RESULT_PROGRESS}    AS result_progress,
         ${EXECUTION_PROGRESS} AS execution_progress,
         ${EFFECTIVE_PROGRESS} AS effective_progress,
         ${LINKED_TASK_COUNT}  AS linked_task_count
    FROM key_results kr
    JOIN objectives o ON o.id = kr.objective_id
    LEFT JOIN users u ON u.id = kr.owner_user_id
`;

/**
 * Objective progress is the weighted mean of its key results. A key result whose
 * progress cannot be measured is left out of both sums rather than counted as
 * zero, so one unmeasurable metric does not drag the objective down.
 */
const OBJECTIVE_PROGRESS = `
  (SELECT CASE WHEN COALESCE(SUM(k.weight) FILTER (WHERE p.value IS NOT NULL), 0) = 0 THEN NULL
               ELSE SUM(p.value * k.weight) FILTER (WHERE p.value IS NOT NULL)
                    / SUM(k.weight) FILTER (WHERE p.value IS NOT NULL) END
     FROM key_results k
     CROSS JOIN LATERAL (
       SELECT CASE WHEN k.measurement_type = 'TASK_ROLLUP' THEN (
                     SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                                 ELSE (COUNT(*) FILTER (WHERE ws2.stage = 'done')::numeric / COUNT(*)) * 100 END
                       FROM task_key_result_links l2
                       JOIN tasks t2 ON t2.id = l2.task_id AND t2.is_archived = FALSE
                       JOIN workflow_statuses ws2 ON ws2.id = t2.status_id
                      WHERE l2.key_result_id = k.id)
                   WHEN k.measurement_type = 'BINARY'
                     THEN CASE WHEN k.current_value >= 1 THEN 100 ELSE 0 END
                   WHEN k.target_value IS NULL THEN NULL
                   WHEN k.direction = 'DECREASE' THEN
                     CASE WHEN (k.baseline_value - k.target_value) = 0 THEN NULL
                          ELSE ((k.baseline_value - k.current_value)
                                / (k.baseline_value - k.target_value)) * 100 END
                   ELSE
                     CASE WHEN (k.target_value - k.baseline_value) = 0 THEN NULL
                          ELSE ((k.current_value - k.baseline_value)
                                / (k.target_value - k.baseline_value)) * 100 END
              END AS value
     ) p
    WHERE k.objective_id = o.id AND k.is_archived = FALSE
      AND k.status NOT IN ('CANCELLED'))
`;

export const OBJECTIVE_SELECT = `
  SELECT o.*,
         u.full_name AS owner_name, u.avatar_color AS owner_color,
         d.name AS department_name, d.color AS department_color,
         p.title AS parent_title,
         ${OBJECTIVE_PROGRESS} AS raw_progress,
         (SELECT COUNT(*)::int FROM key_results k
           WHERE k.objective_id = o.id AND k.is_archived = FALSE) AS key_result_count,
         (SELECT COUNT(DISTINCT l.task_id)::int
            FROM key_results k
            JOIN task_key_result_links l ON l.key_result_id = k.id
            JOIN tasks t ON t.id = l.task_id AND t.is_archived = FALSE
           WHERE k.objective_id = o.id) AS linked_task_count
    FROM objectives o
    LEFT JOIN users u ON u.id = o.owner_user_id
    LEFT JOIN departments d ON d.id = o.department_id
    LEFT JOIN objectives p ON p.id = o.parent_objective_id
`;

// ---------------------------------------------------------------- health

const clamp = (value) => (value == null ? null : Math.max(0, Math.min(100, Number(value))));

const dayMs = 86400000;

/** How far through its period a goal is, 0–100. */
export function timeElapsedPercent(startDate, endDate, now = new Date()) {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (end <= start) return now.getTime() >= end ? 100 : 0;

  const elapsed = ((now.getTime() - start) / (end - start)) * 100;
  return Math.max(0, Math.min(100, elapsed));
}

/**
 * Compares progress against the pace the calendar expects.
 * Returns both the automatic verdict and the one being displayed, so an override
 * never hides what the numbers actually say.
 */
export function calculateHealth(
  { progress, startDate, endDate, status, manualHealth },
  thresholds = DEFAULT_HEALTH_THRESHOLDS,
  now = new Date(),
) {
  const value = clamp(progress);
  const elapsed = timeElapsedPercent(startDate, endDate, now);

  let auto;
  if (status === 'COMPLETED' || value === 100) {
    auto = HEALTH.COMPLETED;
  } else if (startDate && now < new Date(startDate)) {
    auto = HEALTH.NOT_STARTED;
  } else if (endDate && now > new Date(new Date(endDate).getTime() + dayMs)) {
    // the deadline has passed and it is not finished
    auto = HEALTH.OFF_TRACK;
  } else if (value === null || elapsed === null) {
    auto = HEALTH.NOT_STARTED;
  } else {
    const behind = elapsed - value;
    if (behind <= thresholds.atRiskBehindPoints) auto = HEALTH.ON_TRACK;
    else if (behind <= thresholds.offTrackBehindPoints) auto = HEALTH.AT_RISK;
    else auto = HEALTH.OFF_TRACK;
  }

  return {
    auto_health: auto,
    health: manualHealth || auto,
    is_overridden: Boolean(manualHealth),
    time_elapsed_percent: elapsed === null ? null : Math.round(elapsed),
  };
}

export async function healthThresholds() {
  const settings = await getSettings();
  return { ...DEFAULT_HEALTH_THRESHOLDS, ...(settings.okr?.health || {}) };
}

/** Attaches derived progress and health to a raw objective row. */
export function decorateObjective(row, thresholds, now = new Date()) {
  const progress = row.raw_progress === null ? null : Math.round(Number(row.raw_progress));
  return {
    ...row,
    raw_progress: undefined,
    progress_percent: clamp(progress),
    ...calculateHealth(
      {
        progress,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.status,
        manualHealth: row.manual_health,
      },
      thresholds,
      now,
    ),
  };
}

/** Attaches derived progress and health to a raw key result row. */
export function decorateKeyResult(row, objective, thresholds, now = new Date()) {
  const result = row.result_progress === null ? null : Math.round(Number(row.result_progress));
  const execution = row.execution_progress === null ? null : Math.round(Number(row.execution_progress));
  const effective = row.effective_progress === null ? null : Math.round(Number(row.effective_progress));

  return {
    ...row,
    // both numbers are surfaced: finishing the work is not the same as achieving
    // the outcome, and the UI shows them side by side
    result_progress: clamp(result),
    execution_progress: clamp(execution),
    progress_percent: clamp(effective),
    ...calculateHealth(
      {
        progress: effective,
        // a key result without its own dates inherits the objective's period
        startDate: row.start_date || objective?.start_date || row.objective_start_date,
        endDate: row.end_date || objective?.end_date || row.objective_end_date,
        status: row.status,
        manualHealth: row.manual_health,
      },
      thresholds,
      now,
    ),
  };
}

// ---------------------------------------------------------------- audit

export async function logOkrActivity(client, { entityType, entityId, actorId, action, field = null, from = null, to = null, meta = {} }) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO okr_activity (entity_type, entity_id, actor_id, action, field, from_value, to_value, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entityType,
      entityId,
      actorId,
      action,
      field,
      from === null || from === undefined ? null : String(from),
      to === null || to === undefined ? null : String(to),
      meta,
    ],
  );
}

// ---------------------------------------------------------------- fetching

export async function listObjectives(filters = {}) {
  const thresholds = await healthThresholds();
  const params = [];
  const where = ['o.is_archived = FALSE'];

  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.departmentId) where.push(`o.department_id = ${push(Number(filters.departmentId))}`);
  if (filters.scopeType) where.push(`o.scope_type = ${push(filters.scopeType)}`);
  if (filters.ownerId) where.push(`o.owner_user_id = ${push(Number(filters.ownerId))}`);
  if (filters.status) where.push(`o.status = ${push(filters.status)}`);
  if (filters.priority) where.push(`o.priority = ${push(filters.priority)}`);
  if (filters.parentId) where.push(`o.parent_objective_id = ${push(Number(filters.parentId))}`);
  if (filters.search) {
    const term = push(`%${filters.search}%`);
    where.push(`(o.title ILIKE ${term} OR o.description ILIKE ${term})`);
  }

  // an objective matches a date range when its period OVERLAPS that range
  if (filters.from) where.push(`o.end_date >= ${push(filters.from)}`);
  if (filters.to) where.push(`o.start_date <= ${push(filters.to)}`);

  const limit = Math.min(Number(filters.limit) || 200, 500);

  const { rows } = await query(
    `${OBJECTIVE_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY o.end_date ASC, o.id DESC
      LIMIT ${limit}`,
    params,
  );

  const decorated = rows.map((row) => decorateObjective(row, thresholds));
  return filters.health ? decorated.filter((row) => row.health === filters.health) : decorated;
}

export async function getObjective(id) {
  const thresholds = await healthThresholds();
  const { rows } = await query(`${OBJECTIVE_SELECT} WHERE o.id = $1`, [id]);
  if (!rows[0]) return null;
  return decorateObjective(rows[0], thresholds);
}

export async function listKeyResults(objectiveId, objective = null) {
  const thresholds = await healthThresholds();
  const { rows } = await query(
    `${KEY_RESULT_SELECT} WHERE kr.objective_id = $1 AND kr.is_archived = FALSE ORDER BY kr.id`,
    [objectiveId],
  );
  return rows.map((row) => decorateKeyResult(row, objective, thresholds));
}

export async function getKeyResult(id) {
  const thresholds = await healthThresholds();
  const { rows } = await query(`${KEY_RESULT_SELECT} WHERE kr.id = $1`, [id]);
  if (!rows[0]) return null;
  return decorateKeyResult(rows[0], null, thresholds);
}

/** Everything the Goals dashboard needs, in one round trip. */
export async function dashboard(filters = {}) {
  const objectives = await listObjectives({ ...filters, limit: 500 });

  const counts = { ON_TRACK: 0, AT_RISK: 0, OFF_TRACK: 0, COMPLETED: 0, NOT_STARTED: 0 };
  let progressSum = 0;
  let progressCount = 0;

  for (const objective of objectives) {
    counts[objective.health] = (counts[objective.health] || 0) + 1;
    if (objective.progress_percent !== null) {
      progressSum += objective.progress_percent;
      progressCount += 1;
    }
  }

  const byDepartment = new Map();
  const byOwner = new Map();

  for (const objective of objectives) {
    const departmentKey = objective.department_id ?? 'company';
    const department = byDepartment.get(departmentKey) || {
      department_id: objective.department_id,
      name: objective.department_name || 'Company-wide',
      color: objective.department_color || null,
      count: 0,
      at_risk: 0,
      progress_sum: 0,
      progress_count: 0,
    };
    department.count += 1;
    if (objective.health === 'AT_RISK' || objective.health === 'OFF_TRACK') department.at_risk += 1;
    if (objective.progress_percent !== null) {
      department.progress_sum += objective.progress_percent;
      department.progress_count += 1;
    }
    byDepartment.set(departmentKey, department);

    const owner = byOwner.get(objective.owner_user_id) || {
      owner_user_id: objective.owner_user_id,
      name: objective.owner_name,
      color: objective.owner_color,
      count: 0,
      at_risk: 0,
    };
    owner.count += 1;
    if (objective.health === 'AT_RISK' || objective.health === 'OFF_TRACK') owner.at_risk += 1;
    byOwner.set(objective.owner_user_id, owner);
  }

  const summarise = (entry) => ({
    ...entry,
    progress_sum: undefined,
    progress_count: undefined,
    progress_percent: entry.progress_count ? Math.round(entry.progress_sum / entry.progress_count) : null,
  });

  const now = Date.now();
  const upcoming = objectives
    .filter((o) => o.status === 'ACTIVE' && o.health !== 'COMPLETED')
    .filter((o) => new Date(o.end_date).getTime() - now < 30 * dayMs)
    .sort((a, b) => new Date(a.end_date) - new Date(b.end_date))
    .slice(0, 10);

  return {
    summary: {
      total: objectives.length,
      on_track: counts.ON_TRACK,
      at_risk: counts.AT_RISK,
      off_track: counts.OFF_TRACK,
      completed: counts.COMPLETED,
      not_started: counts.NOT_STARTED,
      overall_progress: progressCount ? Math.round(progressSum / progressCount) : null,
    },
    by_department: [...byDepartment.values()].map(summarise).sort((a, b) => b.count - a.count),
    by_owner: [...byOwner.values()].sort((a, b) => b.count - a.count),
    upcoming,
    objectives,
  };
}
