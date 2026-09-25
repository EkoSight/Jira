import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import {
  MEETING_KINDS, MEETING_MODES,
  canEditMeeting, createFollowUpTask, createPrepTasks, getMeeting, listMeetings,
  loadMeeting, logMeetingActivity, notifyInternal, setParticipants, shiftPrepTasks,
} from '../services/meetings.js';

const router = Router();

async function mustEdit(user, id) {
  const row = await loadMeeting(id);
  if (!row) throw notFound('Meeting not found');
  if (!canEditMeeting(user, row)) throw forbidden('You cannot change this meeting');
  return row;
}

const meetingInput = z.object({
  account_id: z.number().int().positive(),
  opportunity_id: z.number().int().positive().nullable().optional(),
  kind: z.enum(MEETING_KINDS).optional(),
  mode: z.enum(MEETING_MODES).optional(),
  title: z.string().min(2).max(200),
  objective: z.string().max(4000).nullable().optional(),
  agenda: z.string().max(20000).nullable().optional(),
  scheduled_at: z.string().min(8),
  duration_min: z.number().int().min(5).max(1440).nullable().optional(),
  timezone: z.string().max(60).optional(),
  location: z.string().max(500).nullable().optional(),
  meeting_url: z.string().max(500).nullable().optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  demo_type: z.string().max(120).nullable().optional(),
  products: z.array(z.string().max(80)).optional(),
  prerequisites: z.string().max(4000).nullable().optional(),
  material_checklist: z.string().max(4000).nullable().optional(),
  participant_user_ids: z.array(z.number().int().positive()).optional(),
  participant_contact_ids: z.array(z.number().int().positive()).optional(),
  // preparation work is offered, not imposed
  create_prep_tasks: z.boolean().optional(),
});

// ---------------------------------------------------------------- list

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({
      meetings: await listMeetings({
        accountId: req.query.account_id,
        opportunityId: req.query.opportunity_id,
        ownerId: req.query.owner_id,
        status: req.query.status,
        kind: req.query.kind,
        from: req.query.from,
        to: req.query.to,
        awaitingOutcome: req.query.awaiting_outcome === 'true',
        limit: req.query.limit,
      }),
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const meeting = await getMeeting(Number(req.params.id));
    if (!meeting) throw notFound('Meeting not found');
    const tasks = await query(
      `SELECT t.id, t.ref, t.title, t.due_date, t.meeting_role, t.assignee_id,
              s.name AS status_name, s.stage,
              u.full_name AS assignee_name, u.avatar_color AS assignee_color
         FROM tasks t
         JOIN workflow_statuses s ON s.id = t.status_id
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.meeting_id = $1 AND t.is_archived = FALSE
        ORDER BY t.meeting_role, t.due_date NULLS LAST, t.id`,
      [meeting.id],
    );
    res.json({
      meeting,
      tasks: tasks.rows,
      can_edit: canEditMeeting(req.currentUser, await loadMeeting(meeting.id)),
    });
  }),
);

// ---------------------------------------------------------------- schedule

router.post(
  '/',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = meetingInput.parse(req.body);

    const { rows: accountRows } = await query('SELECT * FROM accounts WHERE id = $1', [data.account_id]);
    if (!accountRows[0]) throw notFound('Organization not found');

    const created = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO crm_meetings
           (account_id, opportunity_id, kind, mode, title, objective, agenda, scheduled_at,
            first_scheduled_at, duration_min, timezone, location, meeting_url, owner_user_id,
            demo_type, products, prerequisites, material_checklist, created_by)
         VALUES ($1,$2,COALESCE($3,'MEETING'),COALESCE($4,'VIRTUAL'),$5,$6,$7,$8::timestamptz,
                 $8::timestamptz,$9,COALESCE($10,'Asia/Kolkata'),$11,$12,COALESCE($13::int,$19),
                 $14,COALESCE($15::text[],'{}'::text[]),$16,$17,$18)
         RETURNING *`,
        [
          data.account_id, data.opportunity_id ?? null, data.kind ?? null, data.mode ?? null,
          data.title.trim(), data.objective ?? null, data.agenda ?? null, data.scheduled_at,
          data.duration_min ?? null, data.timezone ?? null, data.location ?? null,
          data.meeting_url ?? null, data.owner_user_id ?? null, data.demo_type ?? null,
          data.products ?? null, data.prerequisites ?? null, data.material_checklist ?? null,
          req.currentUser.id, accountRows[0].owner_user_id ?? req.currentUser.id,
        ],
      );
      const meeting = rows[0];

      await setParticipants(client, meeting.id, {
        userIds: data.participant_user_ids ?? [],
        contactIds: data.participant_contact_ids ?? [],
      });

      if (data.create_prep_tasks !== false) {
        await createPrepTasks(client, meeting, req.currentUser);
      }

      // Booking a meeting is recorded, and recorded as SCHEDULED — it is not
      // evidence that anyone was spoken to, so it does not move the engagement
      // clock. That only happens when an outcome says it actually took place.
      await logMeetingActivity(client, meeting, {
        actorId: req.currentUser.id,
        subject: `${meeting.kind === 'DEMO' ? 'Demo' : 'Meeting'} scheduled: ${meeting.title}`,
        outcome: 'SCHEDULED',
      });

      await notifyInternal(client, meeting, {
        actorId: req.currentUser.id,
        title: `You are on: ${meeting.title}`,
        body: `${accountRows[0].name} · ${new Date(meeting.scheduled_at).toISOString()}`,
      });

      return meeting;
    });

    res.status(201).json({
      meeting: await getMeeting(created.id),
      // said plainly, because an internal record is not an invitation
      note: 'Recorded in TaskFlow. No calendar invitation or message was sent to anyone outside.',
    });
  }),
);

// ---------------------------------------------------------------- reschedule

/**
 * Moves the existing meeting. Never creates a second one — the whole point of
 * tracking a reschedule is that the event keeps its identity, its participants
 * and its preparation work.
 */
router.post(
  '/:id/reschedule',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const { scheduled_at: scheduledAt, reason } = z
      .object({ scheduled_at: z.string().min(8), reason: z.string().max(1000).optional() })
      .parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);

    if (existing.status === 'COMPLETED') {
      throw badRequest('That meeting already happened — record a new one instead of moving it');
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE crm_meetings
            SET scheduled_at = $1::timestamptz, status = 'SCHEDULED',
                reschedule_count = reschedule_count + 1,
                first_scheduled_at = COALESCE(first_scheduled_at, scheduled_at),
                updated_at = now()
          WHERE id = $2`,
        [scheduledAt, id],
      );
      // the prep work moves with it rather than being duplicated
      await shiftPrepTasks(client, id, scheduledAt);

      await logMeetingActivity(client, existing, {
        actorId: req.currentUser.id,
        subject: `Moved: ${existing.title}`,
        body: reason ?? null,
        outcome: 'SCHEDULED',
      });
    });

    res.json({ meeting: await getMeeting(id) });
  }),
);

// ---------------------------------------------------------------- outcome

const outcomeInput = z.object({
  status: z.enum(['COMPLETED', 'CANCELLED', 'NO_SHOW']),
  outcome: z.string().max(20000).optional(),
  questions_raised: z.string().max(20000).optional(),
  objections_raised: z.string().max(20000).optional(),
  validations_requested: z.string().max(20000).optional(),
  next_decision: z.string().max(4000).optional(),
  cancel_reason: z.string().max(1000).optional(),
  attended_user_ids: z.array(z.number().int().positive()).optional(),
  attended_contact_ids: z.array(z.number().int().positive()).optional(),
  // the work that came out of it, created through the ordinary task engine
  follow_up: z.object({
    title: z.string().min(2).max(200),
    assignee_id: z.number().int().positive().nullable().optional(),
    due_date: z.string().min(8).nullable().optional(),
  }).optional(),
});

/**
 * What came of it.
 *
 * This is the only route that can turn a scheduled meeting into evidence that
 * something happened, and only COMPLETED does so. A cancellation or a no-show is
 * recorded just as carefully and counts for nothing.
 */
router.post(
  '/:id/outcome',
  requirePermission('crm.activity.log'),
  asyncHandler(async (req, res) => {
    const data = outcomeInput.parse(req.body);
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);

    if (data.status === 'COMPLETED' && !data.outcome?.trim()) {
      throw badRequest('Say what came of it — a demo with no outcome recorded is the same as one that never happened');
    }
    if (data.status === 'CANCELLED' && !data.cancel_reason?.trim() && !data.outcome?.trim()) {
      throw badRequest('Say why it was cancelled');
    }

    const followUp = await withTransaction(async (client) => {
      await client.query(
        `UPDATE crm_meetings
            SET status = $1,
                completed_at = CASE WHEN $1 = 'COMPLETED' THEN now() ELSE NULL END,
                outcome = COALESCE($2, outcome),
                questions_raised = COALESCE($3, questions_raised),
                objections_raised = COALESCE($4, objections_raised),
                validations_requested = COALESCE($5, validations_requested),
                next_decision = COALESCE($6, next_decision),
                cancel_reason = COALESCE($7, cancel_reason),
                updated_at = now()
          WHERE id = $8`,
        [
          data.status, data.outcome ?? null, data.questions_raised ?? null,
          data.objections_raised ?? null, data.validations_requested ?? null,
          data.next_decision ?? null, data.cancel_reason ?? null, id,
        ],
      );

      // who actually turned up, which is not who was invited
      if (data.attended_user_ids || data.attended_contact_ids) {
        await client.query(
          'UPDATE crm_meeting_participants SET attended = FALSE WHERE meeting_id = $1', [id],
        );
        for (const userId of data.attended_user_ids ?? []) {
          await client.query(
            'UPDATE crm_meeting_participants SET attended = TRUE WHERE meeting_id = $1 AND user_id = $2',
            [id, userId],
          );
        }
        for (const contactId of data.attended_contact_ids ?? []) {
          await client.query(
            'UPDATE crm_meeting_participants SET attended = TRUE WHERE meeting_id = $1 AND contact_id = $2',
            [id, contactId],
          );
        }
      }

      await logMeetingActivity(client, existing, {
        actorId: req.currentUser.id,
        subject: `${existing.title} — ${data.status.toLowerCase().replace('_', ' ')}`,
        body: data.outcome ?? data.cancel_reason ?? null,
        outcome: data.status === 'COMPLETED' ? 'COMPLETED'
          : data.status === 'CANCELLED' ? 'CANCELLED' : 'NO_SHOW',
      });

      // one follow-up per call, and the flag stops a repeated submit adding more
      if (data.follow_up && !existing.followup_tasks_created) {
        const task = await createFollowUpTask(client, existing, {
          title: data.follow_up.title.trim(),
          assigneeId: data.follow_up.assignee_id ?? null,
          dueDate: data.follow_up.due_date ?? null,
        }, req.currentUser);
        await client.query(
          'UPDATE crm_meetings SET followup_tasks_created = TRUE WHERE id = $1', [id],
        );
        return task;
      }
      return null;
    });

    res.json({ meeting: await getMeeting(id), follow_up_task: followUp });
  }),
);

// ---------------------------------------------------------------- edit

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = meetingInput.partial().omit({ account_id: true }).parse(req.body);
    const id = Number(req.params.id);
    await mustEdit(req.currentUser, id);

    const fields = [];
    const params = [];
    for (const key of ['kind', 'mode', 'title', 'objective', 'agenda', 'duration_min', 'timezone',
      'location', 'meeting_url', 'owner_user_id', 'demo_type', 'products', 'prerequisites',
      'material_checklist']) {
      if (data[key] === undefined) continue;
      params.push(data[key] === '' ? null : data[key]);
      fields.push(`${key} = $${params.length}`);
    }

    await withTransaction(async (client) => {
      if (fields.length) {
        params.push(id);
        await client.query(
          `UPDATE crm_meetings SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
          params,
        );
      }
      if (data.participant_user_ids || data.participant_contact_ids) {
        await setParticipants(client, id, {
          userIds: data.participant_user_ids ?? [],
          contactIds: data.participant_contact_ids ?? [],
        });
      }
    });

    res.json({ meeting: await getMeeting(id) });
  }),
);

/** Adds the preparation work later, if it was declined at scheduling time. */
router.post(
  '/:id/prep-tasks',
  requirePermission('task.create'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await mustEdit(req.currentUser, id);
    const created = await withTransaction((client) =>
      createPrepTasks(client, existing, req.currentUser));
    res.json({ created: created.length, tasks: created, meeting: await getMeeting(id) });
  }),
);

export default router;
