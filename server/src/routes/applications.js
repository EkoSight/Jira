/**
 * Applications to programmes, grants, tenders and similar: deals in the
 * "Applications & programmes" pipeline. Behind the CRM module switch and
 * crm.view, like the rest of the pipeline; changes need crm.activity.log and
 * a part in the application (owner, collaborator, relationship owner or
 * crm.manage.any), exactly as for deals.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import {
  addRound, addTask, createApplication, getApplication, listApplications, logUpdate, markSubmitted, updateApplication, updateRound,
} from '../services/workspace/applications.js';

const router = Router();
const id = (v) => z.coerce.number().int().positive().parse(v);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-01-20');

router.get('/', asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'team' ? 'team' : 'mine';
  const group = ['PREPARING', 'SUBMITTED', 'DECIDED'].includes(req.query.group) ? req.query.group : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const data = await listApplications(req.currentUser, { scope, group });
  res.json({ ...data, total: data.applications.length, applications: data.applications.slice(0, limit), scope });
}));

router.get('/:id', asyncHandler(async (req, res) => res.json(await getApplication(req.currentUser, id(req.params.id)))));

const deadline = {
  deadline_date: date.nullable().optional(),
  deadline_at_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).nullable().optional(),
  deadline_timezone: z.string().max(64).nullable().optional(),
};

router.post('/', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(2).max(200),
    account_id: z.number().int().positive().nullable().optional(),
    organiser_name: z.string().max(200).nullable().optional(),
    application_type: z.string().max(40).optional(),
    opportunity_url: z.string().url().max(1000).nullable().optional(),
    owner_user_id: z.number().int().positive().nullable().optional(),
    stage: z.enum(['considering', 'preparing']).optional(),
    introduced_by_user_id: z.number().int().positive().nullable().optional(),
    introduced_by_contact_id: z.number().int().positive().nullable().optional(),
    ...deadline,
  }).parse(req.body || {});
  const newId = await createApplication(req.currentUser, body);
  res.status(201).json(await getApplication(req.currentUser, newId));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = z.object({
    application_type: z.string().max(40).optional(),
    opportunity_url: z.string().url().max(1000).nullable().optional(),
    submitted_link: z.string().max(1000).nullable().optional(),
    reference: z.string().max(200).nullable().optional(),
    expected_response_on: date.nullable().optional(),
    next_check_on: date.nullable().optional(),
    introduced_by_user_id: z.number().int().positive().nullable().optional(),
    introduced_by_contact_id: z.number().int().positive().nullable().optional(),
    reason: z.string().max(500).optional(),
    ...deadline,
  }).parse(req.body || {});
  res.json(await updateApplication(req.currentUser, id(req.params.id), body));
}));

/** "Mark submitted", with the real date. Nothing else sets it. */
router.post('/:id/submitted', asyncHandler(async (req, res) => {
  const body = z.object({
    submitted_on: date,
    submitted_link: z.string().max(1000).nullable().optional(),
    reference: z.string().max(200).nullable().optional(),
    correction_reason: z.string().min(3).max(500).optional(),
  }).parse(req.body || {});
  res.json(await markSubmitted(req.currentUser, id(req.params.id), body));
}));

router.post('/:id/updates', asyncHandler(async (req, res) => {
  const body = z.object({
    kind: z.enum(['ACKNOWLEDGEMENT', 'FOLLOW_UP_SENT', 'RESPONSE', 'OUTCOME']),
    happened_on: date.optional(),
    summary: z.string().max(2000).nullable().optional(),
    reference: z.string().max(200).nullable().optional(),
    next_check_on: date.nullable().optional(),
    result: z.enum(['SELECTED', 'NOT_SELECTED', 'WITHDRAWN']).optional(),
    onboarding_task_title: z.string().max(200).nullable().optional(),
    onboarding_due: z.string().nullable().optional(),
  }).parse(req.body || {});
  res.json(await logUpdate(req.currentUser, id(req.params.id), body));
}));

router.post('/:id/tasks', asyncHandler(async (req, res) => {
  const body = z.object({ title: z.string().min(3).max(200), due_date: z.string().nullable().optional(), assignee_id: z.number().int().positive().nullable().optional() }).parse(req.body || {});
  res.status(201).json({ task: await addTask(req.currentUser, id(req.params.id), body) });
}));

router.post('/:id/rounds', asyncHandler(async (req, res) => {
  const body = z.object({ name: z.string().min(2).max(200), notes: z.string().max(2000).nullable().optional(), ...deadline }).parse(req.body || {});
  res.status(201).json({ round: await addRound(req.currentUser, id(req.params.id), body) });
}));

router.patch('/:id/rounds/:roundId', asyncHandler(async (req, res) => {
  const body = z.object({
    status: z.enum(['OPEN', 'SUBMITTED', 'DONE', 'CANCELLED']).optional(),
    submitted_on: date.optional(), meeting_id: z.number().int().positive().nullable().optional(), ...deadline,
  }).parse(req.body || {});
  res.json({ round: await updateRound(req.currentUser, id(req.params.id), id(req.params.roundId), body) });
}));

export default router;
