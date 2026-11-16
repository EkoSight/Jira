/**
 * To-dos and Today's plan. Every route acts for the signed-in person only;
 * another person's to-do, list, pin or step answers 404, whatever their role.
 * The one shared view is /record/:type/:id, for people who can see the record.
 */
import { Router } from 'express';
import { asyncHandler, notFound } from '../lib/errors.js';
import {
  addPin, anytime, archiveList, becameTask, createList, createMany, createTodo, doneItems, listDetail, lists,
  planSuggestions, recordSteps, removePin, removeTodo, reorder, setPrefs, sharePreview, shareTodo, todayPlan,
  unshareStep, unshareTodo, updateList, updateMyStep, updateTodo, upcoming, useListAgain,
} from '../services/todos/index.js';
import { referenceIn, searchLinks } from '../services/todos/links.js';
import { createRoutine, listRoutines, stopRoutine, updateRoutine } from '../services/todos/routines.js';
import { dayPage, getNote, monthIndex, noteLineToTodo, saveNote, weekPage } from '../services/todos/notebook.js';

const router = Router();

/** A numeric id from the address, or "not found". */
const idOf = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound('Not found');
  return n;
};

// ---------------------------------------------------------------- views

router.get('/today', asyncHandler(async (req, res) => res.json(await todayPlan(req.currentUser))));

/** The header's "3 left": the same function as Today's plan. */
router.get('/count', asyncHandler(async (req, res) => {
  const plan = await todayPlan(req.currentUser);
  res.json({ left: plan.left, day: plan.day });
}));

// ---------------------------------------------------------------- the notebook's pages

router.get('/day/:day', asyncHandler(async (req, res) => res.json(await dayPage(req.currentUser, req.params.day === 'today' ? null : req.params.day))));
router.get('/week/:day', asyncHandler(async (req, res) => res.json(await weekPage(req.currentUser, req.params.day === 'today' ? null : req.params.day))));
router.get('/month/:month', asyncHandler(async (req, res) => res.json(await monthIndex(req.currentUser, req.params.month))));
router.get('/notes/:day', asyncHandler(async (req, res) => res.json(await getNote(req.currentUser, req.params.day))));
router.put('/notes/:day', asyncHandler(async (req, res) => res.json(await saveNote(req.currentUser, req.params.day, req.body?.body))));
router.post('/notes/:day/to-todo', asyncHandler(async (req, res) => {
  res.status(201).json(await noteLineToTodo(req.currentUser, req.params.day, req.body?.line, req.body?.client_key || null));
}));

router.get('/upcoming', asyncHandler(async (req, res) => res.json(await upcoming(req.currentUser))));
router.get('/anytime', asyncHandler(async (req, res) => res.json(await anytime(req.currentUser))));
router.get('/done', asyncHandler(async (req, res) => res.json(await doneItems(req.currentUser, {
  q: req.query.q, limit: req.query.limit, whatIDid: req.query.what_i_did === '1' || req.query.what_i_did === 'true',
}))));
router.get('/plan-suggestions', asyncHandler(async (req, res) => res.json(await planSuggestions(req.currentUser))));

// ---------------------------------------------------------------- capture and linking helpers

/** The task reference in a line, shown as a removable chip before saving. */
router.get('/parse', asyncHandler(async (req, res) => {
  const ref = await referenceIn(req.currentUser, String(req.query.text || '').slice(0, 300));
  res.json({ ref: ref ? { ref: ref.ref, task: ref.task, note: ref.note } : null });
}));

router.get('/link-search', asyncHandler(async (req, res) => {
  res.json({ results: await searchLinks(req.currentUser, req.query.q, { type: req.query.type || null }) });
}));

router.put('/prefs', asyncHandler(async (req, res) => res.json(await setPrefs(req.currentUser, req.body || {}))));

router.post('/order', asyncHandler(async (req, res) => res.json(await reorder(req.currentUser, req.body?.keys))));

// ---------------------------------------------------------------- pins

router.post('/pins', asyncHandler(async (req, res) => res.status(201).json(await addPin(req.currentUser, req.body || {}))));
router.delete('/pins/:id', asyncHandler(async (req, res) => res.json(await removePin(req.currentUser, idOf(req.params.id)))));

// ---------------------------------------------------------------- my steps

router.patch('/steps/:id', asyncHandler(async (req, res) => res.json(await updateMyStep(req.currentUser, idOf(req.params.id), req.body || {}))));
router.post('/steps/:id/unshare', asyncHandler(async (req, res) => res.json(await unshareStep(req.currentUser, idOf(req.params.id)))));

// ---------------------------------------------------------------- lists

router.get('/lists', asyncHandler(async (req, res) => res.json(await lists(req.currentUser))));
router.post('/lists', asyncHandler(async (req, res) => res.status(201).json(await createList(req.currentUser, req.body || {}))));
router.get('/lists/:id', asyncHandler(async (req, res) => res.json(await listDetail(req.currentUser, idOf(req.params.id)))));
router.patch('/lists/:id', asyncHandler(async (req, res) => res.json(await updateList(req.currentUser, idOf(req.params.id), req.body || {}))));
router.post('/lists/:id/use-again', asyncHandler(async (req, res) => res.status(201).json(await useListAgain(req.currentUser, idOf(req.params.id)))));
router.delete('/lists/:id', asyncHandler(async (req, res) => res.json(await archiveList(req.currentUser, idOf(req.params.id)))));

// ---------------------------------------------------------------- routines (repeating to-dos)

router.get('/routines', asyncHandler(async (req, res) => res.json(await listRoutines(req.currentUser))));
router.post('/routines', asyncHandler(async (req, res) => res.status(201).json(await createRoutine(req.currentUser, req.body || {}))));
router.patch('/routines/:id', asyncHandler(async (req, res) => res.json(await updateRoutine(req.currentUser, idOf(req.params.id), req.body || {}))));
router.post('/routines/:id/stop', asyncHandler(async (req, res) => res.json(await stopRoutine(req.currentUser, idOf(req.params.id)))));

// ---------------------------------------------------------------- a record's steps

router.get('/record/:type/:id', asyncHandler(async (req, res) => {
  res.json(await recordSteps(req.currentUser, String(req.params.type).toUpperCase(), idOf(req.params.id)));
}));

// ---------------------------------------------------------------- one to-do

router.post('/', asyncHandler(async (req, res) => {
  const result = await createTodo(req.currentUser, req.body || {});
  res.status(result.duplicate ? 200 : 201).json(result);
}));

/** Several pasted lines, after "Add 6 to-dos?". */
router.post('/batch', asyncHandler(async (req, res) => res.status(201).json(await createMany(req.currentUser, req.body || {}))));

router.patch('/:id', asyncHandler(async (req, res) => res.json(await updateTodo(req.currentUser, idOf(req.params.id), req.body || {}))));
router.delete('/:id', asyncHandler(async (req, res) => res.json(await removeTodo(req.currentUser, idOf(req.params.id)))));
router.post('/:id/became-task', asyncHandler(async (req, res) => res.json(await becameTask(req.currentUser, idOf(req.params.id), idOf(req.body?.task_id)))));
router.get('/:id/share-preview', asyncHandler(async (req, res) => res.json(await sharePreview(req.currentUser, idOf(req.params.id)))));
router.post('/:id/share', asyncHandler(async (req, res) => res.json(await shareTodo(req.currentUser, idOf(req.params.id)))));
router.post('/:id/unshare', asyncHandler(async (req, res) => res.json(await unshareTodo(req.currentUser, idOf(req.params.id)))));

export default router;
