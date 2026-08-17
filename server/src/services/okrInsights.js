import { query } from '../db/pool.js';
import { getSettings } from './settings.js';
import {
  RESULT_PROGRESS,
  EXECUTION_PROGRESS,
  EFFECTIVE_PROGRESS,
  LINKED_TASK_COUNT,
  healthThresholds,
  decorateKeyResult,
  listObjectives,
} from './okr.js';

/**
 * The OKR attention engine.
 *
 * It answers, from data that already exists, the questions a manager would
 * otherwise have to chase by hand: which goals are not moving, which key results
 * are stuck, which departments have gone quiet, and who is behind. Everything is
 * derived — there is no separate "status" anyone has to keep up to date, so the
 * system can never be more out of date than the last check-in.
 *
 * Deterministic on purpose. The same data always yields the same signals, which
 * is what lets the scanner remind people without an LLM in the loop.
 */

const DAY = 86_400_000;

// higher wins when one entity could raise several signals
export const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

const daysBetween = (from, to = Date.now()) =>
  from ? Math.floor((to - new Date(from).getTime()) / DAY) : null;

/**
 * Every non-archived key result on an ACTIVE goal, decorated with health and
 * with the two facts the engine adds: how long since anyone touched it, and
 * whether the last check-in actually moved the number.
 */
async function gatherKeyResults(filters, thresholds) {
  const params = [];
  const where = ['kr.is_archived = FALSE', 'o.is_archived = FALSE', "o.status = 'ACTIVE'"];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.departmentId) where.push(`o.department_id = ${push(Number(filters.departmentId))}`);
  if (filters.ownerId) where.push(`o.owner_user_id = ${push(Number(filters.ownerId))}`);
  if (filters.scopeType) where.push(`o.scope_type = ${push(filters.scopeType)}`);
  if (filters.from) where.push(`o.end_date >= ${push(filters.from)}`);
  if (filters.to) where.push(`o.start_date <= ${push(filters.to)}`);

  const { rows } = await query(
    `SELECT kr.*,
            u.full_name AS owner_name, u.avatar_color AS owner_color,
            o.title AS objective_title, o.status AS objective_status,
            o.owner_user_id AS objective_owner_id, o.scope_type,
            o.start_date AS objective_start_date, o.end_date AS objective_end_date,
            o.department_id, d.name AS department_name, d.color AS department_color,
            ${RESULT_PROGRESS}    AS result_progress,
            ${EXECUTION_PROGRESS} AS execution_progress,
            ${EFFECTIVE_PROGRESS} AS effective_progress,
            ${LINKED_TASK_COUNT}  AS linked_task_count,
            COALESCE(kr.last_check_in_at, kr.created_at) AS last_activity_at,
            (SELECT COUNT(*)::int FROM key_result_check_ins c WHERE c.key_result_id = kr.id) AS checkin_count,
            (SELECT (c.previous_value IS NOT DISTINCT FROM c.current_value)
               FROM key_result_check_ins c
              WHERE c.key_result_id = kr.id
              ORDER BY c.created_at DESC LIMIT 1) AS last_checkin_flat
       FROM key_results kr
       JOIN objectives o ON o.id = kr.objective_id
       LEFT JOIN users u ON u.id = kr.owner_user_id
       LEFT JOIN departments d ON d.id = o.department_id
      WHERE ${where.join(' AND ')}`,
    params,
  );

  return rows.map((row) => ({
    ...decorateKeyResult(row, null, thresholds),
    days_since_activity: daysBetween(row.last_activity_at),
    checkin_count: row.checkin_count,
    last_checkin_flat: row.last_checkin_flat === true,
  }));
}

/** The single most important thing wrong with one key result, or nothing. */
function keyResultSignal(kr, attention) {
  if (kr.status === 'COMPLETED' || kr.status === 'CANCELLED') return null;

  const base = {
    entity_type: 'KEY_RESULT',
    key_result_id: kr.id,
    objective_id: kr.objective_id,
    objective_title: kr.objective_title,
    title: kr.title,
    owner_user_id: kr.owner_user_id,
    owner_name: kr.owner_name,
    owner_color: kr.owner_color,
    department_id: kr.department_id,
    department_name: kr.department_name || 'Company-wide',
    days: kr.days_since_activity,
  };

  if (kr.health === 'OFF_TRACK') {
    return {
      ...base,
      kind: 'key_result_off_track',
      severity: 'critical',
      detail: `is off track — ${kr.progress_percent ?? '—'}% with ${100 - (kr.time_elapsed_percent ?? 0)}% of the time left`,
    };
  }
  if (kr.days_since_activity !== null && kr.days_since_activity >= attention.staleKeyResultDays) {
    return {
      ...base,
      kind: 'key_result_stale',
      severity: 'warning',
      detail:
        kr.checkin_count === 0
          ? 'has never been checked in'
          : `hasn't been checked in for ${kr.days_since_activity} days`,
    };
  }
  // being updated, but the number is not moving and it is already behind
  if (kr.checkin_count >= 2 && kr.last_checkin_flat && (kr.health === 'AT_RISK' || kr.health === 'OFF_TRACK')) {
    return { ...base, kind: 'key_result_flat', severity: 'warning', detail: 'is being updated but not moving' };
  }
  return null;
}

/** The single most important thing wrong with one objective, or nothing. */
function objectiveSignal(objective, activityByObjective, attention, now) {
  if (objective.status !== 'ACTIVE') return null;

  const base = {
    entity_type: 'OBJECTIVE',
    objective_id: objective.id,
    objective_title: objective.title,
    title: objective.title,
    owner_user_id: objective.owner_user_id,
    owner_name: objective.owner_name,
    owner_color: objective.owner_color,
    department_id: objective.department_id,
    department_name: objective.department_name || 'Company-wide',
  };

  const overdue = new Date(objective.end_date).getTime() < now && objective.health !== 'COMPLETED';
  if (overdue) {
    return {
      ...base,
      kind: 'objective_overdue',
      severity: 'critical',
      days: daysBetween(objective.end_date),
      detail: `is past its deadline at ${objective.progress_percent ?? '—'}% and not finished`,
    };
  }
  if (objective.key_result_count === 0) {
    return { ...base, kind: 'objective_no_key_results', severity: 'warning', days: null, detail: 'has no key results, so nothing is being measured' };
  }
  if (objective.health === 'OFF_TRACK') {
    return {
      ...base,
      kind: 'objective_off_track',
      severity: 'critical',
      days: null,
      detail: `is off track at ${objective.progress_percent ?? '—'}%`,
    };
  }

  // "not making progress": nobody has checked in on any of its results in a while
  const lastActivity = activityByObjective.get(objective.id);
  const idleDays = lastActivity !== undefined ? daysBetween(lastActivity) : null;
  if (idleDays !== null && idleDays >= attention.stalledObjectiveDays && objective.health !== 'COMPLETED') {
    return { ...base, kind: 'objective_stalled', severity: 'warning', days: idleDays, detail: `has had no check-in for ${idleDays} days` };
  }
  if (objective.health === 'AT_RISK') {
    return {
      ...base,
      kind: 'objective_at_risk',
      severity: 'warning',
      days: null,
      detail: `is slipping — ${objective.progress_percent ?? '—'}% with ${objective.time_elapsed_percent ?? 0}% of the time gone`,
    };
  }
  return null;
}

/**
 * The whole picture: the raw signal list plus the three roll-ups the dashboard
 * shows — by goal, by person, by department.
 */
export async function analyse(filters = {}) {
  const settings = await getSettings();
  const attention = settings.okr?.attention || {};
  const thresholds = await healthThresholds();
  const now = Date.now();

  const [keyResults, objectivesRaw] = await Promise.all([
    gatherKeyResults(filters, thresholds),
    listObjectives({ ...filters, limit: 500 }),
  ]);
  const objectives = objectivesRaw.filter((o) => o.status === 'ACTIVE');

  // last time anyone touched each objective, and each department
  const activityByObjective = new Map();
  const activityByDepartment = new Map();
  for (const kr of keyResults) {
    const at = kr.last_activity_at ? new Date(kr.last_activity_at).getTime() : null;
    if (at !== null) {
      const prev = activityByObjective.get(kr.objective_id);
      if (prev === undefined || at > prev) activityByObjective.set(kr.objective_id, at);
      if (kr.department_id) {
        const dprev = activityByDepartment.get(kr.department_id);
        if (dprev === undefined || at > dprev) activityByDepartment.set(kr.department_id, at);
      }
    }
  }

  const signals = [];
  for (const objective of objectives) {
    const signal = objectiveSignal(objective, activityByObjective, attention, now);
    if (signal) signals.push(signal);
  }
  for (const kr of keyResults) {
    const signal = keyResultSignal(kr, attention);
    if (signal) signals.push(signal);
  }

  // ---- by person: who is not meeting their key results
  const people = new Map();
  const bumpPerson = (userId, name, color, kind) => {
    if (!userId) return;
    const entry = people.get(userId) || {
      user_id: userId, name, color, behind: 0, stale: 0, flat: 0, off_track: 0, total: 0,
    };
    entry.total += 1;
    if (kind === 'key_result_off_track') entry.off_track += 1;
    if (kind === 'key_result_off_track' || kind === 'objective_off_track' || kind === 'objective_at_risk') entry.behind += 1;
    if (kind === 'key_result_stale' || kind === 'objective_stalled') entry.stale += 1;
    if (kind === 'key_result_flat') entry.flat += 1;
    people.set(userId, entry);
  };
  for (const signal of signals) {
    if (signal.entity_type === 'KEY_RESULT') bumpPerson(signal.owner_user_id, signal.owner_name, signal.owner_color, signal.kind);
    if (signal.entity_type === 'OBJECTIVE') bumpPerson(signal.owner_user_id, signal.owner_name, signal.owner_color, signal.kind);
  }

  // ---- by department: which departments have goals, and which have gone quiet
  const departments = new Map();
  for (const objective of objectives) {
    if (!objective.department_id) continue;
    const entry = departments.get(objective.department_id) || {
      department_id: objective.department_id,
      name: objective.department_name,
      color: objective.department_color,
      objectives: 0, off_track: 0, at_risk: 0, last_activity_at: null,
    };
    entry.objectives += 1;
    if (objective.health === 'OFF_TRACK') entry.off_track += 1;
    if (objective.health === 'AT_RISK') entry.at_risk += 1;
    const at = activityByDepartment.get(objective.department_id);
    entry.last_activity_at = at ? new Date(at).toISOString() : entry.last_activity_at;
    departments.set(objective.department_id, entry);
  }
  const byDepartment = [...departments.values()].map((entry) => {
    const idleDays = entry.last_activity_at ? daysBetween(entry.last_activity_at) : null;
    return {
      ...entry,
      idle_days: idleDays,
      is_idle: idleDays === null || idleDays >= (attention.idleDepartmentDays ?? 10),
    };
  });

  for (const department of byDepartment) {
    if (department.is_idle) {
      signals.push({
        entity_type: 'DEPARTMENT',
        kind: 'department_inactive',
        severity: 'warning',
        title: department.name,
        department_id: department.department_id,
        department_name: department.name,
        days: department.idle_days,
        detail:
          department.idle_days === null
            ? `has ${department.objectives} active goal(s) but no check-ins yet`
            : `has ${department.objectives} active goal(s) but no check-in for ${department.idle_days} days`,
      });
    }
  }

  signals.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.days ?? 0) - (a.days ?? 0),
  );

  const byPerson = [...people.values()]
    .filter((p) => p.behind + p.stale + p.flat > 0)
    .sort((a, b) => b.off_track - a.off_track || b.behind + b.stale - (a.behind + a.stale));

  const count = (predicate) => signals.filter(predicate).length;

  return {
    summary: {
      total_signals: signals.length,
      critical: count((s) => s.severity === 'critical'),
      warning: count((s) => s.severity === 'warning'),
      goals_off_track: count((s) => s.kind === 'objective_off_track' || s.kind === 'objective_overdue'),
      goals_stalled: count((s) => s.kind === 'objective_stalled'),
      key_results_stuck: count((s) => s.kind === 'key_result_stale' || s.kind === 'key_result_flat' || s.kind === 'key_result_off_track'),
      people_behind: byPerson.length,
      departments_idle: byDepartment.filter((d) => d.is_idle).length,
    },
    attention: signals,
    by_person: byPerson,
    by_department: byDepartment.sort((a, b) => Number(b.is_idle) - Number(a.is_idle) || b.off_track - a.off_track),
  };
}
