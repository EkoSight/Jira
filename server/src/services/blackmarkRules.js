/**
 * Black-mark rules: what the live rules do (read only), and applying a rule to
 * work before it took effect, which needs a preview and an approval.
 *
 * A rule applies from its effective_from. New rules, and rules whose terms
 * change or that are switched back on, take effect from the moment they are
 * saved, so saving a rule never creates marks for the past by itself.
 * Applying one to earlier work: preview (who, which tasks, how many points),
 * then an approval with a note, which applies exactly what was previewed or
 * nothing.
 */
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from './attendance.js';
import {
  calendarForTasks, evaluateTask, fairnessContext, pickRule, recordBlackMark, scanTasks,
} from './blackmarks.js';

/** The terms that change what a rule records: editing one restarts its effective date. */
export const SUBSTANTIVE = ['trigger_type', 'points', 'grace_hours', 'priorities', 'department_ids', 'repeat_every_days', 'max_points_per_task'];

const overlaps = (a, b) => {
  const meet = (x, y) => !x?.length || !y?.length || x.some((v) => y.includes(v));
  return a.trigger_type === b.trigger_type && meet(a.priorities, b.priorities) && meet(a.department_ids, b.department_ids);
};

/**
 * The live rules in words: priorities, grace, points, caps, the overlaps, and
 * what one task missed and finished three weeks late costs under the old
 * stacking and under D2 (one rule per kind).
 */
export async function rulesReport() {
  const { rows: rules } = await query(`SELECT * FROM blackmark_rules WHERE is_active AND trigger_type <> 'manual' ORDER BY trigger_type, id`);
  const pairs = [];
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) if (overlaps(rules[i], rules[j])) pairs.push([rules[i].name, rules[j].name]);
  }
  const WORKING_DAYS_LATE = 18; // three weeks of six working days
  const escalationPoints = (r) => {
    if (!r) return 0;
    const every = Math.max(1, r.repeat_every_days || 1);
    let cycles = Math.floor(WORKING_DAYS_LATE / every);
    if (r.max_points_per_task != null && Number(r.points) > 0) cycles = Math.min(cycles, Math.floor(Number(r.max_points_per_task) / Number(r.points)));
    return cycles * Number(r.points);
  };
  const examples = ['low', 'medium', 'high', 'critical'].map((priority) => {
    const task = { priority, department_id: null };
    const matching = (trigger) => rules.filter((r) => r.trigger_type === trigger && (!r.priorities?.length || r.priorities.includes(priority)) && !r.department_ids?.length);
    const before = matching('deadline_missed').reduce((a, r) => a + Number(r.points), 0)
      + matching('overdue_escalation').reduce((a, r) => a + escalationPoints(r), 0)
      + matching('completed_late').reduce((a, r) => a + Number(r.points), 0);
    const missed = pickRule(rules, task, 'deadline_missed');
    const now = (missed ? Number(missed.points) : 0) + escalationPoints(pickRule(rules, task, 'overdue_escalation'))
      + (missed ? 0 : Number(pickRule(rules, task, 'completed_late')?.points || 0));
    return { priority, scenario: 'missed, then finished three weeks (18 working days) late', points_before: before, points_now: now };
  });
  return {
    rules: rules.map((r) => ({
      id: r.id, name: r.name, trigger_type: r.trigger_type, points: Number(r.points), grace_hours: r.grace_hours,
      priorities: r.priorities?.length ? r.priorities : 'all', departments: r.department_ids?.length ? r.department_ids : 'all',
      repeat_every: r.repeat_every_days ? `${r.repeat_every_days} working days` : null, cap: r.max_points_per_task, effective_from: r.effective_from,
    })),
    overlaps: pairs,
    examples,
    precedence: 'One rule per kind: the most specific matching rule (a priority or department filter beats none), then the narrower, then the oldest. "Delivered late" only when no missed-deadline mark was recorded.',
  };
}

/** What applying a rule to work before its effective date would record. */
async function backfillOccurrences(rule, now) {
  const { rows: rules } = await query(`SELECT * FROM blackmark_rules WHERE is_active AND trigger_type <> 'manual'`);
  const all = rules.some((r) => r.id === rule.id) ? rules : [...rules, rule];
  const tasks = await scanTasks();
  if (!tasks.length) return [];
  const fair = await fairnessContext(tasks);
  const cal = await calendarForTasks([...tasks, ...fair.people.map((id) => ({ assignee_id: id, due_date: null }))], now);
  const out = [];
  for (const task of tasks) {
    for (const o of evaluateTask(task, all, cal, now, { ...fair.for(task), backfill: true })) {
      if (o.rule.id === rule.id) out.push({ ...o, task });
    }
  }
  if (!out.length) return [];
  const { rows: existing } = await query('SELECT occurrence_key FROM black_marks WHERE occurrence_key = ANY($1::text[])', [out.map((o) => o.occurrenceKey)]);
  const taken = new Set(existing.map((r) => r.occurrence_key));
  return out.filter((o) => !taken.has(o.occurrenceKey));
}

const fingerprintOf = (list) => crypto.createHash('sha256').update(list.map((o) => o.occurrenceKey).sort().join('|')).digest('hex');

export async function previewBackfill(ruleId, user, now = new Date()) {
  const { rows } = await query('SELECT * FROM blackmark_rules WHERE id = $1', [ruleId]);
  const rule = rows[0];
  if (!rule) throw notFound('Rule not found');
  if (!rule.effective_from) throw badRequest('This rule already applies from the beginning: there is no earlier work to apply it to');
  const list = await backfillOccurrences(rule, now);
  const { rows: names } = list.length
    ? await query('SELECT id, full_name FROM users WHERE id = ANY($1::int[])', [[...new Set(list.map((o) => o.userId))]])
    : { rows: [] };
  const nameOf = new Map(names.map((n) => [n.id, n.full_name]));
  const preview = list.map((o) => ({
    key: o.occurrenceKey, user_id: o.userId, person: nameOf.get(o.userId), task_id: o.task.id, task_ref: o.task.ref,
    task_title: o.task.title, points: o.points, occurred_at: o.occurredAt, reason: o.reason,
  }));
  const fingerprint = fingerprintOf(list);
  const points = preview.reduce((a, p) => a + Number(p.points), 0);
  const { rows: saved } = await query(
    `INSERT INTO blackmark_backfills (rule_id, previewed_by, fingerprint, occurrences, people, points, preview)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, previewed_at`,
    [rule.id, user.id, fingerprint, preview.length, new Set(preview.map((p) => p.user_id)).size, points, JSON.stringify(preview)],
  );
  return { id: saved[0].id, rule: { id: rule.id, name: rule.name, effective_from: rule.effective_from }, fingerprint, occurrences: preview.length, people: new Set(preview.map((p) => p.user_id)).size, points, preview };
}

export async function applyBackfill(backfillId, user, { fingerprint, note }, now = new Date()) {
  const { rows } = await query('SELECT * FROM blackmark_backfills WHERE id = $1', [backfillId]);
  const b = rows[0];
  if (!b) throw notFound('Preview not found');
  if (b.status !== 'PREVIEWED') throw badRequest('This preview has already been used or discarded');
  if (String(note || '').trim().length < 5) throw badRequest('Say why these earlier marks are being applied');
  if (fingerprint !== b.fingerprint) throw badRequest('Approve the preview you looked at');
  const { rows: ruleRows } = await query('SELECT * FROM blackmark_rules WHERE id = $1', [b.rule_id]);
  if (!ruleRows[0]) throw notFound('The rule no longer exists');
  const list = await backfillOccurrences(ruleRows[0], now);
  if (fingerprintOf(list) !== b.fingerprint) {
    throw conflict('Things have changed since the preview (tasks, owners or rules): preview again before approving');
  }
  let created = 0;
  for (const o of list) {
    const mark = await recordBlackMark({
      userId: o.userId, taskId: o.task.id, ruleId: o.rule.id, points: o.points, reason: o.reason, occurredAt: o.occurredAt,
      occurrenceKey: o.occurrenceKey, createdBy: user.id, evidence: { ...o.evidence, backfill_id: b.id, approved_by: user.id, approval_note: note },
    });
    if (mark) created += 1;
  }
  await query(
    `UPDATE blackmark_backfills SET status = 'APPLIED', approved_by = $2, approved_at = now(), approval_note = $3, created_marks = $4 WHERE id = $1`,
    [b.id, user.id, note, created],
  );
  await audit(null, {
    entityType: 'BLACKMARK_BACKFILL', entityId: b.id, actorId: user.id, action: 'APPLIED', reason: note,
    after: { rule_id: b.rule_id, created, fingerprint: b.fingerprint, previewed_by: b.previewed_by },
  });
  return { id: b.id, created };
}
