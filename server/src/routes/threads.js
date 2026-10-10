import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { canAccess } from './tasks.js';
import { logActivity, notify } from '../services/activity.js';
import { logOkrActivity } from '../services/okr.js';
import { canEditAccount, logActivity as logCrmActivity } from '../services/crm.js';
import { today } from '../services/dealRules.js';
import {
  BLOCKER_CATEGORIES, BLOCKER_DEPENDENCIES, CRM_ENTITY_TYPES, ENTITY_TYPES, THREAD_KINDS,
  addMessage, addParticipants, canRaiseReview, canResolveThread, createThread, getThread,
  listMessages, listParticipants, listThreads, notifyThread, reopenThread, resolveThread,
} from '../services/threads.js';

const router = Router();

/**
 * Threads about tasks, key results and objectives.
 *
 * Access is never decided here. Each entity type already has a rule for who may
 * see it, and this asks that rule — so a thread can never become a way to read
 * something you could not otherwise read, or to comment on work that is not
 * yours to see.
 */
async function resolveEntity(user, entityType, entityId) {
  switch (entityType) {
    case 'TASK': {
      const { rows } = await query(
        'SELECT id, ref, title, assignee_id, follower_id FROM tasks WHERE id = $1',
        [entityId],
      );
      if (!rows[0]) throw notFound('Task not found');
      if (!(await canAccess(user, entityId))) throw forbidden('You cannot see this task');
      return {
        row: rows[0],
        label: `${rows[0].ref} ${rows[0].title}`,
        ownerId: rows[0].assignee_id,
        taskId: rows[0].id,
        objectiveId: null,
      };
    }
    case 'KEY_RESULT': {
      const { rows } = await query(
        `SELECT kr.id, kr.title, kr.owner_user_id, kr.objective_id, o.owner_user_id AS objective_owner_id
           FROM key_results kr JOIN objectives o ON o.id = kr.objective_id
          WHERE kr.id = $1`,
        [entityId],
      );
      if (!rows[0]) throw notFound('Key result not found');
      if (!hasPermission(user, 'okr.view')) throw forbidden('You cannot see goals');
      return {
        row: rows[0],
        label: rows[0].title,
        ownerId: rows[0].owner_user_id || rows[0].objective_owner_id,
        taskId: null,
        objectiveId: rows[0].objective_id,
      };
    }
    case 'OBJECTIVE': {
      const { rows } = await query(
        'SELECT id, title, owner_user_id FROM objectives WHERE id = $1',
        [entityId],
      );
      if (!rows[0]) throw notFound('Goal not found');
      if (!hasPermission(user, 'okr.view')) throw forbidden('You cannot see goals');
      return {
        row: rows[0],
        label: rows[0].title,
        ownerId: rows[0].owner_user_id,
        taskId: null,
        objectiveId: rows[0].id,
      };
    }
    case 'OPPORTUNITY':
    case 'ACCOUNT': {
      if (!hasPermission(user, 'crm.view')) throw forbidden('You cannot see the pipeline');
      const { rows } = entityType === 'OPPORTUNITY'
        ? await query(
          `SELECT o.id, o.name AS title, o.owner_user_id, o.account_id, a.name AS account_name,
                  a.owner_user_id AS account_owner_id, a.follower_user_id, a.created_by
             FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE o.id = $1`,
          [entityId],
        )
        : await query(
          `SELECT a.id, a.name AS title, a.owner_user_id, a.id AS account_id, a.name AS account_name,
                  a.owner_user_id AS account_owner_id, a.follower_user_id, a.created_by
             FROM accounts a WHERE a.id = $1`,
          [entityId],
        );
      if (!rows[0]) throw notFound(entityType === 'OPPORTUNITY' ? 'Deal not found' : 'Lead not found');
      const row = rows[0];
      return {
        row,
        label: entityType === 'OPPORTUNITY' ? `${row.account_name} — ${row.title}` : row.account_name,
        ownerId: row.owner_user_id || row.account_owner_id,
        taskId: null,
        objectiveId: null,
        accountId: row.account_id,
        // may this person work the lead, and so say its obstacle is cleared
        canManage: canEditAccount(user, {
          owner_user_id: row.account_owner_id,
          follower_user_id: row.follower_user_id,
          created_by: row.created_by,
        }) || row.owner_user_id === user.id,
      };
    }
    default:
      throw badRequest('Unknown thing to discuss');
  }
}

/** Leaves a trace on the item itself, so its own history shows the conversation. */
async function traceOnEntity(client, { entityType, entity, actor, action, kind, text }) {
  if (CRM_ENTITY_TYPES.includes(entityType)) {
    // an internal note on the lead's own timeline: it is bookkeeping, so it does
    // not count as having spoken to the partner and does not move that clock
    if (kind !== 'blocker') return;
    await logCrmActivity(client, {
      accountId: entity.accountId,
      opportunityId: entityType === 'OPPORTUNITY' ? entity.row.id : null,
      type: 'NOTE',
      actorId: actor.id,
      subject: action === 'thread_opened' ? `Blocker raised: ${text}`
        : action === 'thread_resolved' ? `Blocker cleared: ${text}` : `Blocker: ${text}`,
      outcome: 'NOTED',
    });
    return;
  }
  if (entityType === 'TASK') {
    await logActivity(client, {
      taskId: entity.taskId,
      actorId: actor.id,
      action,
      field: kind,
    });
    return;
  }
  await logOkrActivity(client, {
    entityType,
    entityId: entity.row.id,
    actorId: actor.id,
    action,
    field: kind,
  });
}

const listQuery = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.coerce.number().int().positive(),
});

/**
 * Every thread about one lead: the lead itself and each of its deals, in one
 * list, so its blockers are seen together rather than one deal at a time.
 */
router.get(
  '/lead/:accountId',
  asyncHandler(async (req, res) => {
    const accountId = Number(req.params.accountId);
    const entity = await resolveEntity(req.currentUser, 'ACCOUNT', accountId);

    const { rows } = await query(
      `SELECT t.id FROM discussion_threads t
         LEFT JOIN opportunities o ON t.entity_type = 'OPPORTUNITY' AND o.id = t.entity_id
        WHERE (t.entity_type = 'ACCOUNT' AND t.entity_id = $1)
           OR (t.entity_type = 'OPPORTUNITY' AND o.account_id = $1)
        ORDER BY (t.status = 'open') DESC, t.updated_at DESC`,
      [accountId],
    );
    const ids = rows.map((r) => r.id);
    const participants = await listParticipants(ids);
    const threads = await Promise.all(ids.map(async (id) => {
      const thread = await getThread(id);
      let about = null;
      if (thread.entity_type === 'OPPORTUNITY') {
        const { rows: opp } = await query('SELECT name FROM opportunities WHERE id = $1', [thread.entity_id]);
        about = opp[0]?.name ?? null;
      }
      return {
        ...thread,
        about,
        participants: participants.get(id) || [],
        messages: await listMessages(id),
      };
    }));

    res.json({
      threads,
      categories: BLOCKER_CATEGORIES,
      can_manage: entity.canManage,
      can_raise_review: canRaiseReview(req.currentUser),
    });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { entity_type: entityType, entity_id: entityId } = listQuery.parse(req.query);
    await resolveEntity(req.currentUser, entityType, entityId);

    const threads = await listThreads(entityType, entityId);
    // the messages come with them: a conversation is unreadable one request at
    // a time, and these are small
    const withMessages = await Promise.all(
      threads.map(async (thread) => ({ ...thread, messages: await listMessages(thread.id) })),
    );

    res.json({
      threads: withMessages,
      can_raise_review: canRaiseReview(req.currentUser),
    });
  }),
);

const createInput = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.number().int().positive(),
  kind: z.enum(THREAD_KINDS),
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
  awaiting_user_id: z.number().int().positive().nullable().optional(),
  // a blocker: what sort of obstacle, and who is being asked to help
  category: z.enum(BLOCKER_CATEGORIES).nullable().optional(),
  participant_user_ids: z.array(z.number().int().positive()).max(30).optional(),
  // and what exactly is blocked, who holds the key, who is chasing it, by when
  blocked_item: z.string().max(500).nullable().optional(),
  dependency: z.enum(BLOCKER_DEPENDENCIES).nullable().optional(),
  responsible_user_id: z.number().int().positive().nullable().optional(),
  external_party: z.string().max(300).nullable().optional(),
  expected_resolution: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullable().optional(),
});

/**
 * A blocker says what is blocked, whether we or someone outside holds the key,
 * who on our side is responsible for clearing it, and by when — so it can be
 * chased, counted, and raised again when the date passes.
 */
const BLOCKER_KEYS = ['blocked_item', 'dependency', 'responsible_user_id', 'external_party', 'expected_resolution'];

/**
 * Checks the blocker fields being set. `only` lists the ones being changed (an
 * update); without it every field is required (a new blocker). `data` carries
 * the blocker as it will be, so a check can see the other fields.
 */
async function blockerFields(data, { only = null } = {}) {
  const checking = (key) => only === null || only.includes(key);
  const out = {};
  if (checking('blocked_item')) {
    const item = String(data.blocked_item || '').trim();
    if (item.length < 3) throw badRequest('Say what exactly is blocked — the sample validation, the pricing approval…');
    out.blockedItem = item;
  }
  if (checking('dependency')) {
    if (!BLOCKER_DEPENDENCIES.includes(data.dependency)) {
      throw badRequest('Say whether it depends on us or on someone outside');
    }
    out.dependency = data.dependency;
  }
  if (checking('dependency') || checking('external_party')) {
    const party = String(data.external_party || '').trim();
    if (data.dependency === 'EXTERNAL' && party.length < 2) {
      throw badRequest('Say who outside holds it up — their procurement team, the lab…');
    }
    out.externalParty = data.dependency === 'EXTERNAL' ? party : null;
  }
  if (checking('responsible_user_id')) {
    if (!data.responsible_user_id) throw badRequest('Name who on our side is responsible for clearing it');
    const { rows } = await query('SELECT id, is_active FROM users WHERE id = $1', [data.responsible_user_id]);
    if (!rows[0]?.is_active) throw badRequest('The person responsible must be an active user');
    out.responsibleUserId = data.responsible_user_id;
  }
  if (checking('expected_resolution')) {
    const day = data.expected_resolution ? String(data.expected_resolution).slice(0, 10) : null;
    if (!day) throw badRequest('Give the date it is expected to clear');
    if (day < today()) throw badRequest('The date it is expected to clear has already passed');
    out.expectedResolution = day;
  }
  return out;
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = createInput.parse(req.body);
    const entity = await resolveEntity(req.currentUser, data.entity_type, data.entity_id);

    // asking someone to change their work is a management act; saying you are
    // blocked, or answering, is not
    if (data.kind === 'review' && !canRaiseReview(req.currentUser)) {
      throw forbidden('You cannot ask for changes — only a manager or admin can raise a review');
    }
    if (data.entity_type === 'TASK' && !hasPermission(req.currentUser, 'task.comment')) {
      throw forbidden('You cannot comment on tasks');
    }
    if (data.kind === 'blocker' && !CRM_ENTITY_TYPES.includes(data.entity_type)) {
      throw badRequest('A blocker is raised on a lead or one of its deals');
    }
    // raising a blocker says the lead is stuck, so it is for whoever works it
    if (data.kind === 'blocker' && !entity.canManage) {
      throw forbidden('Only whoever works this lead, or a manager, can raise a blocker on it');
    }
    if (CRM_ENTITY_TYPES.includes(data.entity_type) && !hasPermission(req.currentUser, 'crm.activity.log')) {
      throw forbidden('You cannot write on leads');
    }
    const blocker = data.kind === 'blocker' ? await blockerFields(data) : null;

    // a review is aimed at whoever owns the thing unless someone else is named;
    // the other kinds are aimed at nobody in particular by default
    const awaiting = data.awaiting_user_id !== undefined
      ? data.awaiting_user_id
      : data.kind === 'review' ? entity.ownerId : null;

    const thread = await withTransaction(async (client) => {
      const created = await createThread(client, {
        entityType: data.entity_type,
        entityId: data.entity_id,
        kind: data.kind,
        title: data.title,
        body: data.body,
        actor: req.currentUser,
        awaitingUserId: awaiting,
        category: data.category ?? null,
        // the person responsible for clearing a blocker keeps hearing about it
        participantIds: [...(data.participant_user_ids ?? []),
          ...(blocker && blocker.responsibleUserId !== req.currentUser.id ? [blocker.responsibleUserId] : [])],
        blocker,
      });

      await traceOnEntity(client, {
        entityType: data.entity_type,
        entity,
        actor: req.currentUser,
        action: 'thread_opened',
        kind: data.kind,
        text: data.title || data.body.slice(0, 120),
      });

      await notifyThread(client, {
        thread: created,
        actor: req.currentUser,
        body: data.body,
        entityLabel: entity.label,
        taskId: entity.taskId,
        objectiveId: entity.objectiveId,
        accountId: entity.accountId ?? null,
      });

      return created;
    });

    const full = await getThread(thread.id);
    res.status(201).json({ thread: { ...full, messages: await listMessages(thread.id) } });
  }),
);

router.post(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const { body } = z.object({ body: z.string().min(1).max(5000) }).parse(req.body);
    const thread = await getThread(Number(req.params.id));
    if (!thread) throw notFound('Thread not found');

    const entity = await resolveEntity(req.currentUser, thread.entity_type, thread.entity_id);
    if (thread.entity_type === 'TASK' && !hasPermission(req.currentUser, 'task.comment')) {
      throw forbidden('You cannot comment on tasks');
    }
    if (CRM_ENTITY_TYPES.includes(thread.entity_type) && !hasPermission(req.currentUser, 'crm.activity.log')) {
      throw forbidden('You cannot write on leads');
    }

    const message = await withTransaction(async (client) => {
      const created = await addMessage(client, {
        threadId: thread.id,
        actor: req.currentUser,
        body,
      });
      await notifyThread(client, {
        thread,
        actor: req.currentUser,
        body,
        entityLabel: entity.label,
        taskId: entity.taskId,
        objectiveId: entity.objectiveId,
        accountId: entity.accountId ?? null,
      });
      return created;
    });

    res.status(201).json({
      message: {
        ...message,
        author_name: req.currentUser.full_name,
        avatar_color: req.currentUser.avatar_color,
      },
    });
  }),
);

const resolveInput = z.object({
  conclusion: z.string().min(3).max(2000),
});

/**
 * Closing a thread requires saying what it concluded.
 *
 * A thread that ends silently makes the next reader work through the whole
 * argument to find out how it came out, which is exactly the cost this feature
 * exists to remove.
 */
router.post(
  '/:id/resolve',
  asyncHandler(async (req, res) => {
    const { conclusion } = resolveInput.parse(req.body);
    const thread = await getThread(Number(req.params.id));
    if (!thread) throw notFound('Thread not found');
    if (thread.status === 'resolved') throw badRequest('That thread is already closed');

    const entity = await resolveEntity(req.currentUser, thread.entity_type, thread.entity_id);
    if (!canResolveThread(req.currentUser, thread, entity)) {
      throw forbidden('Only the person who opened this, or a manager, can close it');
    }

    const updated = await withTransaction(async (client) => {
      const closed = await resolveThread(client, {
        threadId: thread.id,
        actor: req.currentUser,
        conclusion,
      });
      await traceOnEntity(client, {
        entityType: thread.entity_type,
        entity,
        actor: req.currentUser,
        action: 'thread_resolved',
        kind: thread.kind,
        text: conclusion,
      });
      await notifyThread(client, {
        thread,
        actor: req.currentUser,
        body: `Closed: ${conclusion}`,
        entityLabel: entity.label,
        taskId: entity.taskId,
        objectiveId: entity.objectiveId,
        accountId: entity.accountId ?? null,
      });
      return closed;
    });

    res.json({ thread: { ...(await getThread(updated.id)), messages: await listMessages(updated.id) } });
  }),
);

/** Brings more people into a blocker after it was raised. */
router.post(
  '/:id/participants',
  asyncHandler(async (req, res) => {
    const { user_ids: userIds } = z
      .object({ user_ids: z.array(z.number().int().positive()).min(1).max(30) })
      .parse(req.body);
    const thread = await getThread(Number(req.params.id));
    if (!thread) throw notFound('Thread not found');
    const entity = await resolveEntity(req.currentUser, thread.entity_type, thread.entity_id);
    if (!canResolveThread(req.currentUser, thread, entity)) {
      throw forbidden('Only the person who raised this, or whoever works the lead, can bring people in');
    }

    await withTransaction(async (client) => {
      const { rows: before } = await client.query(
        'SELECT user_id FROM discussion_thread_participants WHERE thread_id = $1', [thread.id],
      );
      const already = new Set(before.map((r) => r.user_id));
      await addParticipants(client, { threadId: thread.id, userIds, actor: req.currentUser });
      // only the newcomers are told; everyone else already knows
      for (const userId of userIds) {
        if (already.has(userId) || userId === req.currentUser.id) continue;
        await notify(client, {
          userId,
          type: thread.kind === 'blocker' ? 'crm_blocker' : 'comment',
          title: `${req.currentUser.full_name} asked for your help on ${entity.label}`,
          body: (thread.title || '').slice(0, 140) || null,
          accountId: entity.accountId ?? null,
        });
      }
    });

    const participants = await listParticipants([thread.id]);
    res.json({ participants: participants.get(thread.id) || [] });
  }),
);

/**
 * Changes what a blocker records: who is responsible, the date it should clear,
 * what it depends on. The person newly made responsible is told.
 */
router.patch(
  '/:id/blocker',
  asyncHandler(async (req, res) => {
    const data = createInput.pick({
      blocked_item: true, dependency: true, responsible_user_id: true,
      external_party: true, expected_resolution: true,
    }).extend({ note: z.string().max(2000).nullable().optional() }).parse(req.body);
    const thread = await getThread(Number(req.params.id));
    if (!thread || thread.kind !== 'blocker') throw notFound('Blocker not found');
    if (thread.status !== 'open') throw badRequest('This blocker is closed — reopen it to change it');
    const entity = await resolveEntity(req.currentUser, thread.entity_type, thread.entity_id);
    if (!canResolveThread(req.currentUser, thread, entity)) {
      throw forbidden('Only the person who raised this, or whoever works the lead, can change it');
    }
    const changing = BLOCKER_KEYS.filter((key) => data[key] !== undefined);
    const fields = await blockerFields({ ...thread, ...data }, { only: changing });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE discussion_threads
            SET blocked_item = COALESCE($1, blocked_item),
                dependency = COALESCE($2, dependency),
                responsible_user_id = COALESCE($3, responsible_user_id),
                external_party = CASE WHEN $6 THEN $4 ELSE external_party END,
                expected_resolution = COALESCE($5::date, expected_resolution),
                updated_at = now()
          WHERE id = $7`,
        [fields.blockedItem ?? null, fields.dependency ?? null, fields.responsibleUserId ?? null,
          fields.externalParty ?? null, fields.expectedResolution ?? null,
          'externalParty' in fields, thread.id],
      );
      const wasDue = thread.expected_resolution ? String(thread.expected_resolution).slice(0, 10) : null;
      const dependency = fields.dependency ?? thread.dependency;
      const party = 'externalParty' in fields ? fields.externalParty : thread.external_party;
      const dependencyChanged = dependency !== thread.dependency || (party ?? null) !== (thread.external_party ?? null);
      const changes = [
        data.blocked_item !== undefined && fields.blockedItem !== thread.blocked_item && `blocked: ${fields.blockedItem}`,
        data.expected_resolution !== undefined && fields.expectedResolution !== wasDue
          && `expected to clear by ${fields.expectedResolution}`,
        data.responsible_user_id !== undefined && data.responsible_user_id !== thread.responsible_user_id
          && 'a new person is responsible',
        dependencyChanged && `depends on ${dependency === 'EXTERNAL' ? (party || 'someone outside') : 'us'}`,
      ].filter(Boolean);
      if (changes.length || data.note) {
        await addMessage(client, {
          threadId: thread.id,
          actor: req.currentUser,
          body: [changes.length ? `Updated: ${changes.join('; ')}.` : null, data.note || null].filter(Boolean).join(' '),
        });
      }
      if (data.responsible_user_id && data.responsible_user_id !== thread.responsible_user_id) {
        await addParticipants(client, { threadId: thread.id, userIds: [data.responsible_user_id], actor: req.currentUser });
        if (data.responsible_user_id !== req.currentUser.id) {
          await notify(client, {
            userId: data.responsible_user_id,
            type: 'crm_blocker',
            title: `You are now responsible for clearing a blocker on ${entity.label}`,
            body: (thread.title || '').slice(0, 140) || null,
            accountId: entity.accountId ?? null,
          });
        }
      }
    });

    res.json({ thread: { ...(await getThread(thread.id)), messages: await listMessages(thread.id) } });
  }),
);

router.post(
  '/:id/reopen',
  asyncHandler(async (req, res) => {
    const thread = await getThread(Number(req.params.id));
    if (!thread) throw notFound('Thread not found');
    const entity = await resolveEntity(req.currentUser, thread.entity_type, thread.entity_id);
    if (!canResolveThread(req.currentUser, thread, entity)) {
      throw forbidden('Only the person who opened this, or a manager, can reopen it');
    }

    const updated = await withTransaction((client) =>
      reopenThread(client, { threadId: thread.id, actor: req.currentUser }));

    res.json({ thread: { ...(await getThread(updated.id)), messages: await listMessages(updated.id) } });
  }),
);

export default router;
