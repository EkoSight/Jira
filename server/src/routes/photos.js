import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { isAdmin } from '../lib/permissions.js';
import {
  MAX_UPLOAD_MB, decideProposal, myPhoto, originalPath, pendingProposals, photoPath, photoVersions, proposalPath, proposePhoto,
  removePhoto, saveOwnPhoto, withdrawProposal,
} from '../services/photos.js';

/**
 * Profile photos. Every route needs a signed-in person (router.js); the
 * pictures themselves are fetched by the app with the person's token.
 */
const router = Router();
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Not a valid id');
  return n;
};

// held in memory only long enough to be re-encoded; never written as sent
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2, fields: 4, fieldSize: 8 * 1024 },
}).fields([{ name: 'photo', maxCount: 1 }, { name: 'original', maxCount: 1 }]);
const receive = (req, res, next) => photoUpload(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return next(badRequest(`Photos are at most ${MAX_UPLOAD_MB} MB`));
  return next(err);
});
const filesOf = (req) => {
  const photo = req.files?.photo?.[0]?.buffer;
  if (!photo) throw badRequest('Attach the photo');
  let edit = {};
  if (req.body?.edit) {
    try { edit = JSON.parse(req.body.edit); } catch { throw badRequest('The editor settings could not be read'); }
  }
  return { photo, original: req.files?.original?.[0]?.buffer || null, edit, note: req.body?.note || null };
};

const sendPicture = (res, file, { immutable = false, privateOnly = false } = {}) => {
  res.set({
    'Content-Type': 'image/webp',
    'Cache-Control': privateOnly ? 'private, no-store' : immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  fs.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
};

/** Who has a photo, and its version. */
router.get('/versions', asyncHandler(async (req, res) => {
  res.json({ versions: await photoVersions() });
}));

// ---------------------------------------------------------------- my own

router.get('/me', asyncHandler(async (req, res) => res.json(await myPhoto(req.currentUser.id))));
router.post('/me', receive, asyncHandler(async (req, res) => {
  const { photo, original, edit } = filesOf(req);
  res.status(201).json(await saveOwnPhoto(req.currentUser, { photo, original, edit }));
}));
router.delete('/me', asyncHandler(async (req, res) => res.json(await removePhoto(req.currentUser.id, req.currentUser))));
/** The kept original: only its owner, never cached. */
router.get('/me/original', asyncHandler(async (req, res) => {
  const file = await originalPath(req.currentUser.id);
  if (!file) throw notFound('No original kept');
  sendPicture(res, file, { privateOnly: true });
}));
router.post('/me/suggestions/:id/accept', asyncHandler(async (req, res) => res.json(await decideProposal(id(req.params.id), req.currentUser, true))));
router.post('/me/suggestions/:id/decline', asyncHandler(async (req, res) => res.json(await decideProposal(id(req.params.id), req.currentUser, false))));

// ---------------------------------------------------------------- suggestions (administrators)

router.get('/suggestions', asyncHandler(async (req, res) => {
  if (!isAdmin(req.currentUser)) throw notFound('Not found');
  res.json({ suggestions: await pendingProposals() });
}));
router.get('/suggestions/:id/picture', asyncHandler(async (req, res) => {
  const file = await proposalPath(id(req.params.id), req.currentUser, Number(req.query.size) || 256);
  if (!file) throw notFound('Suggestion not found');
  sendPicture(res, file, { privateOnly: true });
}));
router.delete('/suggestions/:id', asyncHandler(async (req, res) => res.json(await withdrawProposal(id(req.params.id), req.currentUser))));
router.post('/:userId/suggest', receive, asyncHandler(async (req, res) => {
  const { photo, original, edit, note } = filesOf(req);
  res.status(201).json(await proposePhoto(id(req.params.userId), req.currentUser, { photo, original, edit, note }));
}));

// ---------------------------------------------------------------- anyone's, to look at

/** One size of a person's current photo. With ?v= the address is that version's, so it can be cached for good. */
router.get('/:userId/:size', asyncHandler(async (req, res) => {
  const found = await photoPath(id(req.params.userId), req.query.v ? Number(req.query.v) : null, Number(req.params.size));
  if (!found) throw notFound('No photo');
  sendPicture(res, found.file, { immutable: Boolean(req.query.v) });
}));

/** An administrator removes someone's photo, saying why; they are told. */
router.delete('/:userId', asyncHandler(async (req, res) => {
  const d = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body || {});
  res.json(await removePhoto(id(req.params.userId), req.currentUser, { reason: d.reason }));
}));

export default router;
