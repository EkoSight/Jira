import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { acknowledgePolicy } from '../services/sales/callingCare.js';
import { incomingDir } from '../services/sales/callRecordings.js';
import {
  appLink, deviceConfig, deviceContext, deviceHeartbeat, deviceNumbers, deviceRecording, ingestCallLog, signOutDevice,
} from '../services/sales/phoneDevices.js';

/**
 * What the TaskFlow Android app reaches on its own (in the background, without
 * the web page): its settings, the numbers it may send, the call log, the
 * recordings, and signing out. Every request carries the phone's device token
 * ("Authorization: Device <token>"), which reaches nothing else in TaskFlow.
 * Mounted before the normal sign-in.
 */
const router = Router();
const json = express.json({ limit: '512kb' });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, incomingDir()); } catch (err) { cb(err); }
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 8).replace(/[^.\w]/g, '')}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
});

router.use(asyncHandler(async (req, res, next) => {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Device ') ? header.slice(7).trim() : null;
  req.deviceCtx = await deviceContext(token);
  next();
}));

router.get('/config', asyncHandler(async (req, res) => res.json(await deviceConfig(req.deviceCtx))));

router.post('/heartbeat', json, asyncHandler(async (req, res) => res.json(await deviceHeartbeat(req.deviceCtx, req.body || {}))));

router.get('/numbers', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await deviceNumbers(req.deviceCtx));
}));

const entry = z.object({
  log_id: z.union([z.string().min(1).max(80), z.number()]).transform(String),
  number: z.string().min(3).max(40),
  type: z.string().max(20),
  started_at: z.string().min(10).max(40),
  duration_sec: z.number().int().min(0).max(86400),
  sim: z.string().max(80).nullable().optional(),
  call_id: z.number().int().positive().nullable().optional(),
});

router.post('/call-log', json, asyncHandler(async (req, res) => {
  const { entries } = z.object({ entries: z.array(entry).min(1).max(200) }).parse(req.body || {});
  res.json(await ingestCallLog(req.deviceCtx, entries));
}));

router.post('/recordings', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Send the recording file');
  const callId = Number(req.body?.call_id) || null;
  const logKey = req.body?.log_key ? String(req.body.log_key).slice(0, 120) : null;
  if (!callId && !logKey) {
    fs.rm(req.file.path, { force: true }, () => {});
    throw badRequest('Say which call the recording is for');
  }
  const out = await deviceRecording(req.deviceCtx, { callId, logKey, filePath: req.file.path, originalName: req.file.originalname });
  res.status(out.duplicate ? 200 : 201).json(out);
}));

router.post('/policy/ack', json, asyncHandler(async (req, res) => {
  const { version } = z.object({ version: z.number().int().positive() }).parse(req.body || {});
  res.json(await acknowledgePolicy(req.deviceCtx.user.id, version, req.deviceCtx.device.id));
}));

router.post('/sign-out', asyncHandler(async (req, res) => res.json(await signOutDevice(req.deviceCtx))));

router.get('/app', asyncHandler(async (req, res) => res.json(await appLink())));

export default router;
