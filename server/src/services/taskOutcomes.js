/**
 * Finishing work on a deal, with evidence.
 *
 * A task linked to a lead or a deal is part of the pipeline's record, so
 * marking it done has to say what actually happened — not that the box was
 * ticked. Three things are asked for:
 *
 *   THE RESULT. Did it achieve what the task asked, in so many words? "Done"
 *   is a status, not an outcome. And an outcome that reads like a plan ("will
 *   send samples") does not complete "test samples": the person is asked to
 *   either keep the task open and record progress, or confirm in their own name
 *   that it really is done.
 *
 *   THE EVIDENCE. A link to the proof — the report, the email, the order.
 *   Asked for every time; a completion without one is allowed, and is listed
 *   later as finished without evidence.
 *
 *   WHAT HAPPENS NEXT. If finishing this leaves the deal with no valid next
 *   action — none at all, an overdue one, or this very task as the next action
 *   — the next one has to be named: what, who and by when.
 *
 * Finishing a task NEVER moves a deal to another stage. A stage needs its own
 * evidence (see dealRules.js); a follow-up being done is not a proposal, an
 * order, or a meeting that happened.
 */

import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { assertSafeUrl } from '../lib/uploads.js';
import { logActivity } from './crm.js';
import { nextActionGaps } from './dealRules.js';
import { setNextAction } from './opportunities.js';

export const OUTCOME_STATUSES = ['ACHIEVED', 'NOT_ACHIEVED'];

/** A task is pipeline work when it belongs to an organization or a deal. */
export const isDealTask = (task) => Boolean(task?.account_id || task?.opportunity_id);

// statuses, not outcomes
const BARE = new Set([
  'done', 'completed', 'complete', 'ok', 'okay', 'yes', 'finished', 'closed', 'na', 'n/a',
  'nil', 'none', 'resolved', 'fixed', 'sent', 'shared',
]);

/**
 * True when the first thing an outcome says is a plan rather than a result.
 *
 * Only the opening clause is read: "Sent the samples; will follow up Friday"
 * reports a result and then a plan, which is fine. "Will send samples" reports
 * nothing done yet.
 */
export function readsLikeAPlan(text) {
  const first = String(text || '')
    .trim()
    .split(/[.;\n!?]|,\s|\s(?:and|but|then)\s/i)
    .map((part) => part.trim())
    .find(Boolean);
  if (!first) return false;
  return /\b(will|shall|won't|going to|gonna|plan(?:ning|s)? to|intend(?:s|ing)? to|need(?:s)? to|yet to|about to|to be (?:done|sent|shared|tested|scheduled|arranged|confirmed)|pending|awaiting|waiting (?:for|on)|tbd|tomorrow|next week)\b/i.test(first)
    || /\b\w+'ll\b/i.test(first);
}

/** What is wrong with an outcome as written, or null. */
export function outcomeProblem(note) {
  const text = String(note || '').trim();
  if (!text) return 'Say what actually happened — that note becomes the record of this work';
  if (BARE.has(text.toLowerCase().replace(/[.!]+$/, ''))) {
    return `"${text}" is a status, not an outcome — say what was done and what came of it`;
  }
  if (text.length < 10) return 'Describe the outcome in a sentence — what was done and what came of it';
  return null;
}

const LIVE = ['ACTIVE', 'ON_HOLD', 'NURTURE'];

/** The deals a finished task could set the next step on, live ones first. */
async function dealsFor(task, runner = { query }) {
  if (task.opportunity_id) {
    const { rows } = await runner.query(
      `SELECT o.*, s.kind AS stage_kind, a.primary_opportunity_id, u.full_name AS next_step_owner_name
         FROM opportunities o
         JOIN accounts a ON a.id = o.account_id
         LEFT JOIN account_stages s ON s.id = o.stage_id
         LEFT JOIN users u ON u.id = o.next_step_owner_id
        WHERE o.id = $1`,
      [task.opportunity_id],
    );
    return rows;
  }
  const { rows } = await runner.query(
    `SELECT o.*, s.kind AS stage_kind, a.primary_opportunity_id, u.full_name AS next_step_owner_name
       FROM opportunities o
       JOIN accounts a ON a.id = o.account_id
       LEFT JOIN account_stages s ON s.id = o.stage_id
       LEFT JOIN users u ON u.id = o.next_step_owner_id
      WHERE o.account_id = $1 AND o.is_archived = FALSE AND o.status = ANY($2::text[])
      ORDER BY (o.id = a.primary_opportunity_id) DESC, o.expected_close NULLS LAST, o.id`,
    [task.account_id, LIVE],
  );
  return rows;
}

/** Whether finishing this task would leave the deal with no valid next action. */
export function needsNextStep(task, deal) {
  if (!deal || deal.status !== 'ACTIVE') return false;
  // getting ready for a meeting: the meeting itself is what happens next
  if (task.meeting_role === 'PREP') return false;
  if (deal.next_step_task_id === task.id) return true;
  return nextActionGaps({ ...deal, stage_kind: deal.stage_kind ?? 'open' }).length > 0;
}

/** What the completion screen needs to ask the right questions. */
export async function completionContext(task) {
  if (!isDealTask(task)) return { deal_task: false, deals: [], requires_next_step: false };
  const deals = await dealsFor(task);
  const chosen = deals[0] || null;
  return {
    deal_task: true,
    deals: deals.map((deal) => ({
      id: deal.id,
      name: deal.name,
      status: deal.status,
      next_step: deal.next_step,
      next_step_due: deal.next_step_due,
      next_step_owner_id: deal.next_step_owner_id,
      next_step_owner_name: deal.next_step_owner_name,
      owner_user_id: deal.owner_user_id,
      is_this_task: deal.next_step_task_id === task.id,
      requires_next_step: needsNextStep(task, deal),
    })),
    default_deal_id: chosen?.id ?? null,
    requires_next_step: chosen ? needsNextStep(task, chosen) : false,
  };
}

/**
 * Checks a deal task's completion before anything is written, and works out
 * what will be written. Throws a 400 whose `code` the screen understands:
 * OUTCOME_REQUIRED, OUTCOME_READS_AS_PLAN, NEXT_ACTION_REQUIRED.
 */
export async function planDealCompletion(task, input) {
  const note = String(input.completion_note || '').trim();
  const problem = outcomeProblem(note);
  if (problem) throw badRequest(problem, { code: 'OUTCOME_REQUIRED', field: 'completion_note' });

  if (!OUTCOME_STATUSES.includes(input.outcome_status)) {
    throw badRequest('Say whether this achieved what the task asked for',
      { code: 'OUTCOME_REQUIRED', field: 'outcome_status' });
  }
  if (input.outcome_status === 'ACHIEVED' && readsLikeAPlan(note) && input.confirm_intent !== true) {
    throw badRequest(
      'That reads like a plan, not a result. If it is not finished yet, keep the task open and record progress; if it really is done, confirm it.',
      { code: 'OUTCOME_READS_AS_PLAN', field: 'completion_note' },
    );
  }

  const evidence = input.outcome_evidence_url && String(input.outcome_evidence_url).trim()
    ? assertSafeUrl(String(input.outcome_evidence_url).trim())
    : null;

  const deals = await dealsFor(task);
  const wanted = input.next_step?.opportunity_id;
  const deal = wanted ? deals.find((d) => d.id === Number(wanted)) : deals[0] || null;
  if (wanted && !deal) throw badRequest('That deal is not one this task belongs to');

  const next = input.next_step && String(input.next_step.text || '').trim() ? input.next_step : null;
  if (!next && needsNextStep(task, deal)) {
    throw badRequest(
      `Finishing this leaves ${deal.name} with nothing agreed next — say what happens next, who owes it and by when`,
      { code: 'NEXT_ACTION_REQUIRED', opportunity_id: deal.id, opportunity_name: deal.name },
    );
  }
  if (next && !deal) throw badRequest('There is no live deal here to set a next step on');

  return {
    note,
    status: input.outcome_status,
    evidence,
    intentConfirmed: input.outcome_status === 'ACHIEVED' && readsLikeAPlan(note) ? true : null,
    deal,
    next,
  };
}

/**
 * Writes a planned completion, inside the same transaction as the task's move
 * to done: the outcome on the task, an entry on the organization's timeline
 * (internal work — finishing a task is not contact with the customer), and the
 * deal's next action if one was given.
 */
export async function recordDealCompletion(client, { task, plan, actor }) {
  await client.query(
    `UPDATE tasks
        SET outcome_status = $1, outcome_evidence_url = $2, outcome_next_step = $3,
            outcome_intent_confirmed = $4
      WHERE id = $5`,
    [plan.status, plan.evidence, plan.next ? String(plan.next.text).trim() : null, plan.intentConfirmed, task.id],
  );

  const accountId = task.account_id ?? plan.deal?.account_id;
  if (accountId) {
    await logActivity(client, {
      accountId,
      opportunityId: plan.deal?.id ?? task.opportunity_id ?? null,
      type: 'TASK_DONE',
      actorId: actor.id,
      taskId: task.id,
      subject: plan.status === 'ACHIEVED'
        ? `Done: ${task.title}`
        : `Closed without achieving it: ${task.title}`,
      body: plan.note,
      meta: {
        outcome_status: plan.status,
        evidence_url: plan.evidence,
        intent_confirmed: plan.intentConfirmed === true,
      },
      direction: 'INTERNAL',
      isExternal: false,
      source: 'TASK',
    });
  }

  if (plan.next && plan.deal) {
    const { rows } = await client.query('SELECT * FROM opportunities WHERE id = $1', [plan.deal.id]);
    await setNextAction(client, {
      opportunity: rows[0],
      step: plan.next.text,
      ownerId: plan.next.owner_id,
      due: plan.next.due,
      actor,
      reason: `After ${task.ref}: ${task.title}`,
    });
  } else if (plan.deal && plan.deal.next_step_task_id === task.id) {
    // the deal's next action was this task; it is done, so it no longer points here
    await client.query('UPDATE opportunities SET next_step_task_id = NULL WHERE id = $1', [plan.deal.id]);
  }
}

/**
 * Progress on deal work that is not finished. The task stays open; the note
 * goes on the task's history and, for deal work, on the organization's
 * timeline as internal work.
 */
export async function recordProgress(client, { task, note, evidenceUrl, actor }) {
  const text = String(note || '').trim();
  if (text.length < 5) throw badRequest('Say where it stands in a few words');
  const evidence = evidenceUrl && String(evidenceUrl).trim() ? assertSafeUrl(String(evidenceUrl).trim()) : null;

  await client.query(
    `INSERT INTO task_activity (task_id, actor_id, action, to_value, meta)
     VALUES ($1, $2, 'progress', $3, $4)`,
    [task.id, actor.id, text, { evidence_url: evidence }],
  );
  if (isDealTask(task)) {
    const accountId = task.account_id ?? (await dealsFor(task, client))[0]?.account_id;
    if (accountId) {
      await logActivity(client, {
        accountId,
        opportunityId: task.opportunity_id ?? null,
        type: 'NOTE',
        actorId: actor.id,
        taskId: task.id,
        subject: `Progress on ${task.ref}: ${task.title}`,
        body: text,
        meta: { evidence_url: evidence, progress: true },
        direction: 'INTERNAL',
        isExternal: false,
        source: 'TASK',
      });
    }
  }
}
