import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { recordAuditEvent } from '../services/audit.js';
import { getSettings, updateSetting } from '../services/settings.js';
import { assertVisible, canSee, crmScope, salesSettings } from '../services/sales/core.js';
import { callById } from '../services/sales/callRecords.js';
import { deleteRecording, holdRecording, incomingDir, recordingLink, storeRecording } from '../services/sales/callRecordings.js';
import {
  NOTICE_LANGS, acknowledgePolicy, applyOptOutImport, callingReview, callingTexts, lastWeek, listOptOuts, liftCallOptOut, noticeDraftChanged,
  noticeHtml, noticeMissing, policyStatus, previewOptOutImport, publishedNotice, recordComplaint, recordingBlockers,
} from '../services/sales/callingCare.js';
import { callingHoursCheck } from '../services/sales/callRules.js';
import { liveCall, pendingCalls, recentCalls, startCall } from '../services/sales/phoneCalls.js';
import {
  RECORDING_MODES, appLink, confirmDiallerMode, handOverDevice, labelDevice, listDevices, registerDevice, revokeDevice, saveAppRelease,
} from '../services/sales/phoneDevices.js';
import { canWorkLead, visibleLead } from './sales.js';

/**
 * Calls on company phones: starting a call, what happened on it, recordings,
 * the company phone policy, opt-outs and complaints, Settings → Calling, and
 * the phones themselves. Mounted under /sales, after sign-in and crm.view.
 */
const router = Router();
const settingsOnly = requirePermission('crm.settings');
const logsCalls = requirePermission('crm.activity.log');
const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

// recordings and app releases arrive as files on disk, checked by the services
const diskUpload = (maxMb) => multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, incomingDir()); } catch (err) { cb(err); }
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 8).replace(/[^.\w]/g, '')}`),
  }),
  limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
});
const recordingUpload = diskUpload(200);
const appUpload = diskUpload(300);

/** The record a call is for must be one the person may see. */
async function assertTarget(req, { lead_id: leadId, account_id: accountId, opportunity_id: opportunityId, contact_id: contactId }) {
  if (leadId) await visibleLead(req, leadId);
  if (accountId) await assertVisible(req.currentUser, 'account', accountId, 'Organization');
  if (opportunityId) await assertVisible(req.currentUser, 'opportunity', opportunityId, 'Opportunity');
  if (contactId && !accountId) {
    const { rows } = await query('SELECT account_id FROM account_contacts WHERE id = $1', [contactId]);
    if (!rows[0]) throw notFound('Contact not found');
    await assertVisible(req.currentUser, 'account', rows[0].account_id, 'Organization');
  }
}

/** A call the person may see: their own, or one on a record they may see. */
async function visibleCall(req, callId) {
  const call = await callById(callId);
  if (!call) throw notFound('Call not found');
  if (call.agent_user_id === req.currentUser.id) return call;
  if (call.lead_id) await visibleLead(req, call.lead_id);
  else {
    const scope = await crmScope(req.currentUser);
    const ok = (call.account_id && await canSee(scope, 'account', call.account_id)) || (call.opportunity_id && await canSee(scope, 'opportunity', call.opportunity_id));
    if (!ok) throw notFound('Call not found');
  }
  return call;
}

// ---------------------------------------------------------------- starting a call

router.post('/calls/start', logsCalls, asyncHandler(async (req, res) => {
  const d = z.object({
    lead_id: z.number().int().positive().nullable().optional(), account_id: z.number().int().positive().nullable().optional(),
    contact_id: z.number().int().positive().nullable().optional(), opportunity_id: z.number().int().positive().nullable().optional(),
    phone: z.string().max(40).nullable().optional(), via: z.enum(['DIALLER', 'ANDROID_APP']).default('DIALLER'),
    request_id: z.string().min(8).max(80).nullable().optional(), override_reason: z.string().max(300).nullable().optional(),
    // a call started while the phone was offline arrives later with the time it was dialled
    dialled_at: z.string().max(40).nullable().optional(),
  }).parse(req.body || {});
  await assertTarget(req, d);
  let at = new Date();
  if (d.dialled_at) {
    const when = new Date(d.dialled_at);
    if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 2 * 60_000 || when.getTime() < Date.now() - 12 * 3600_000) {
      throw badRequest('A call sent late must have been dialled in the last 12 hours');
    }
    at = when;
  }
  res.status(201).json(await startCall({
    actor: req.currentUser, phone: d.phone ?? null, leadId: d.lead_id ?? null, accountId: d.account_id ?? null, contactId: d.contact_id ?? null,
    opportunityId: d.opportunity_id ?? null, via: d.via, requestId: d.request_id ?? null, overrideReason: d.override_reason ?? null, at,
  }));
}));

/** Whether calling is allowed right now, for the Call button's hint. */
router.get('/calls/hours', asyncHandler(async (req, res) => res.json(await callingHoursCheck(new Date()))));

router.get('/calls/pending', asyncHandler(async (req, res) => res.json({ calls: await pendingCalls(req.currentUser.id) })));
router.get('/calls/recent', asyncHandler(async (req, res) => {
  res.json({ calls: await recentCalls(req.currentUser.id, { hours: Math.min(Math.max(Number(req.query.hours) || 24, 1), 72) }) });
}));

router.get('/calls/:id/live', asyncHandler(async (req, res) => {
  const call = await visibleCall(req, id(req.params.id));
  res.json({ call: await liveCall(call.id) });
}));

// ---------------------------------------------------------------- not recorded

/** "They don't want this recorded": the lead (or contact) is marked, this call's recording is not kept. */
router.post('/calls/:id/no-recording', logsCalls, asyncHandler(async (req, res) => {
  const call = await visibleCall(req, id(req.params.id));
  if (call.agent_user_id !== req.currentUser.id && !hasPermission(req.currentUser, 'crm.manage.any')) throw forbidden('Only the person who made the call can say this');
  const result = await withTransaction(async (client) => {
    await client.query('UPDATE crm_calls SET no_recording = TRUE, updated_at = now() WHERE id = $1', [call.id]);
    if (call.lead_id) await client.query('UPDATE crm_leads SET do_not_record = TRUE, updated_at = now() WHERE id = $1', [call.lead_id]);
    if (call.contact_id) await client.query('UPDATE account_contacts SET do_not_record = TRUE WHERE id = $1', [call.contact_id]);
    const deleted = await deleteRecording(client, call.id, { reason: 'ASKED_NOT_TO_BE_RECORDED', actorId: req.currentUser.id });
    await recordAuditEvent(client, {
      action: 'ASKED_NOT_TO_BE_RECORDED', entityType: 'CALL', entityId: call.id, actorId: req.currentUser.id,
      detail: { lead_id: call.lead_id, contact_id: call.contact_id, recording_deleted: deleted },
    });
    return { not_recorded: true, recording_deleted: deleted > 0 };
  });
  res.json(result);
}));

async function setDoNotRecord(req, table, entityType, rowId, value) {
  await query(`UPDATE ${table} SET do_not_record = $2 WHERE id = $1`, [rowId, value]);
  await recordAuditEvent(null, {
    action: value ? 'DO_NOT_RECORD_SET' : 'DO_NOT_RECORD_CLEARED', entityType, entityId: rowId, actorId: req.currentUser.id,
    summary: req.body?.reason ? String(req.body.reason).slice(0, 300) : null,
  });
}

router.post('/leads/:id/do-not-record', logsCalls, asyncHandler(async (req, res) => {
  const lead = await visibleLead(req, id(req.params.id));
  if (!canWorkLead(req.currentUser, lead)) throw forbidden('Only the lead\'s owner, or someone who can assign leads, can change this');
  const { value } = z.object({ value: z.boolean(), reason: z.string().max(300).nullable().optional() }).parse(req.body || {});
  await setDoNotRecord(req, 'crm_leads', 'LEAD', lead.id, value);
  res.json({ do_not_record: value });
}));

router.post('/contacts/:id/do-not-record', logsCalls, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT id, account_id FROM account_contacts WHERE id = $1', [id(req.params.id)]);
  if (!rows[0]) throw notFound('Contact not found');
  await assertVisible(req.currentUser, 'account', rows[0].account_id, 'Organization');
  const { value } = z.object({ value: z.boolean(), reason: z.string().max(300).nullable().optional() }).parse(req.body || {});
  await setDoNotRecord(req, 'account_contacts', 'CONTACT', rows[0].id, value);
  res.json({ do_not_record: value });
}));

// ---------------------------------------------------------------- recordings

/** Attach a recording to your own call: chosen by hand, or shared to TaskFlow from the phone. */
router.post('/calls/:id/recording', logsCalls, recordingUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Choose the recording file');
  let call;
  try {
    call = await visibleCall(req, id(req.params.id));
  } catch (err) {
    fs.rm(req.file.path, { force: true }, () => {});
    throw err;
  }
  const source = req.body?.source === 'SHARED' ? 'SHARED' : 'ATTACHED';
  const out = await storeRecording({ callId: call.id, filePath: req.file.path, originalName: req.file.originalname, source, userId: req.currentUser.id });
  res.status(out.duplicate ? 200 : 201).json(out);
}));

router.post('/calls/:id/recording/link', asyncHandler(async (req, res) => {
  const call = await visibleCall(req, id(req.params.id));
  res.json(await recordingLink(call.id, req.currentUser, { download: req.body?.download === true }));
}));

router.post('/calls/:id/recording/hold', asyncHandler(async (req, res) => {
  const call = await visibleCall(req, id(req.params.id));
  res.json(await holdRecording(call.id, { reason: req.body?.reason }, req.currentUser));
}));
router.post('/calls/:id/recording/release', asyncHandler(async (req, res) => {
  const call = await visibleCall(req, id(req.params.id));
  res.json(await holdRecording(call.id, { reason: req.body?.reason }, req.currentUser, { release: true }));
}));

// ---------------------------------------------------------------- complaints

router.post('/calls/complaint', logsCalls, asyncHandler(async (req, res) => {
  const d = z.object({
    lead_id: z.number().int().positive().nullable().optional(), contact_id: z.number().int().positive().nullable().optional(),
    call_id: z.number().int().positive().nullable().optional(), what_they_said: z.string().min(3).max(2000),
  }).parse(req.body || {});
  if (d.call_id) await visibleCall(req, d.call_id);
  else await assertTarget(req, { lead_id: d.lead_id, contact_id: d.contact_id });
  res.status(201).json(await recordComplaint({ leadId: d.lead_id ?? null, contactId: d.contact_id ?? null, callId: d.call_id ?? null, whatTheySaid: d.what_they_said, actor: req.currentUser }));
}));

// ---------------------------------------------------------------- the policy and the texts

/** The opening sentence and the phone policy for this person, and whether they have acknowledged it. */
router.get('/calling/policy', asyncHandler(async (req, res) => {
  const settings = await salesSettings();
  res.json({ texts: callingTexts(settings, req.currentUser), policy: await policyStatus(req.currentUser.id, settings) });
}));
router.post('/calling/policy/ack', asyncHandler(async (req, res) => {
  const d = z.object({ version: z.number().int().positive(), device_id: z.number().int().positive().nullable().optional() }).parse(req.body || {});
  res.json(await acknowledgePolicy(req.currentUser.id, d.version, d.device_id ?? null));
}));

// ---------------------------------------------------------------- Settings → Calling

const text2 = z.object({ en: z.string().max(4000), hi: z.string().max(4000) });
const setupInput = z.object({
  deviceRecordings: z.boolean().optional(),
  recordingRetentionMonths: z.number().int().min(1).max(60).optional(),
  removePhoneCopy: z.boolean().optional(),
  callingHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), workingDaysOnly: z.boolean() }).optional(),
  dailyAttemptCap: z.number().int().min(0).max(20).optional(),
  maxRecordingMb: z.number().int().min(1).max(200).optional(),
  deviceSync: z.boolean().optional(),
  companyName: z.string().max(120).optional(),
  openingSentence: text2.optional(),
  staffPolicy: text2.optional(),
  privacyNotice: z.object({
    legalName: z.string().max(200).optional(), address: z.string().max(500).optional(), contactName: z.string().max(120).optional(),
    contactPhone: z.string().max(60).optional(), contactEmail: z.string().max(200).optional(),
    en: z.string().max(20000).optional(), hi: z.string().max(20000).optional(), formLine: text2.optional(),
  }).optional(),
});

async function callsSettings() {
  return (await salesSettings()).calls || {};
}

async function saveCalls(next, actor, action, detail) {
  const all = await getSettings();
  const sales = all.crm?.sales || {};
  await updateSetting('crm', { ...all.crm, sales: { ...sales, calls: next } }, actor.id);
  await recordAuditEvent(null, { action, entityType: 'SETTINGS', actorId: actor.id, summary: Object.keys(detail || {}).join(', ') || null, detail });
}

router.get('/calling/setup', settingsOnly, asyncHandler(async (req, res) => {
  const calls = await callsSettings();
  res.json({
    settings: calls,
    texts_preview: callingTexts({ calls }, req.currentUser),
    recording_blockers: recordingBlockers(calls),
    notice_missing: noticeMissing(calls),
    notice_published: publishedNotice(calls),
    notice_draft_changed: noticeDraftChanged(calls),
    languages: NOTICE_LANGS,
  });
}));

router.put('/calling/setup', settingsOnly, asyncHandler(async (req, res) => {
  const data = setupInput.parse(req.body || {});
  const before = await callsSettings();
  const next = { ...before, ...data };
  if (data.privacyNotice) next.privacyNotice = { ...before.privacyNotice, ...data.privacyNotice };
  // the staff policy gets a new version when its words change: everyone is asked again
  if (data.staffPolicy) {
    const changed = NOTICE_LANGS.some((l) => (data.staffPolicy[l] || '') !== (before.staffPolicy?.[l] || ''));
    next.staffPolicy = { ...data.staffPolicy, version: (Number(before.staffPolicy?.version) || 1) + (changed ? 1 : 0) };
  }
  if (next.deviceRecordings === true) {
    const blockers = recordingBlockers(next);
    if (blockers.length) throw conflict(`Recordings can be switched on once these are done: ${blockers.join('; ')}`, { code: 'RECORDING_BLOCKED', blockers });
  }
  await saveCalls(next, req.currentUser, 'CALLING_SETTINGS_CHANGED', { changed: Object.keys(data), recordings: { before: before.deviceRecordings === true, after: next.deviceRecordings === true } });
  res.json({ settings: next, recording_blockers: recordingBlockers(next), notice_missing: noticeMissing(next), notice_draft_changed: noticeDraftChanged(next) });
}));

/** The notice as the draft now reads (for the administrator's preview), in both languages. */
router.get('/calling/notice/preview', settingsOnly, asyncHandler(async (req, res) => {
  const calls = await callsSettings();
  res.json(Object.fromEntries(NOTICE_LANGS.map((l) => [l, noticeHtml(l, calls, { draft: true })])));
}));

/** Publishes the privacy notice as the draft now reads. Its details must be complete. */
router.post('/calling/notice/publish', settingsOnly, asyncHandler(async (req, res) => {
  const calls = await callsSettings();
  const missing = noticeMissing(calls);
  if (missing.length) throw conflict(`Fill in ${missing.join(', ')} first`, { code: 'NOTICE_INCOMPLETE', missing });
  const version = (Number(publishedNotice(calls)?.version) || 0) + 1;
  const snapshot = { ...calls.privacyNotice, companyName: calls.companyName, publishedAt: new Date().toISOString(), version };
  const next = { ...calls, privacyNoticePublished: snapshot, privacyNotice: { ...calls.privacyNotice, publishedAt: snapshot.publishedAt, version } };
  await saveCalls(next, req.currentUser, 'PRIVACY_NOTICE_PUBLISHED', { version });
  res.json({ settings: next, notice_draft_changed: false });
}));

router.get('/calling/review', settingsOnly, asyncHandler(async (req, res) => {
  const settings = await salesSettings();
  const week = lastWeek(new Date(), settings.calendar?.timezone || 'Asia/Kolkata');
  const from = req.query.from ? new Date(String(req.query.from)) : week.from;
  const to = req.query.to ? new Date(String(req.query.to)) : week.to;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw badRequest('Give a from date before the to date');
  res.json(await callingReview({ from, to }));
}));

// ---------------------------------------------------------------- opt-outs

router.get('/calling/optouts', settingsOnly, asyncHandler(async (req, res) => res.json(await listOptOuts({ includeLifted: req.query.all === '1' }))));
router.post('/calling/optouts/lift', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({ address: z.string().min(6).max(40), reason: z.string().min(3).max(500) }).parse(req.body || {});
  res.json(await liftCallOptOut({ address: d.address, reason: d.reason, actor: req.currentUser }));
}));
router.post('/calling/optouts/import/preview', settingsOnly, asyncHandler(async (req, res) => {
  const { text } = z.object({ text: z.string().min(1).max(2_000_000) }).parse(req.body || {});
  res.json(await previewOptOutImport(text));
}));
router.post('/calling/optouts/import/apply', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({ text: z.string().min(1).max(2_000_000), fingerprint: z.string().min(8).max(64) }).parse(req.body || {});
  res.json(await applyOptOutImport(d.text, d.fingerprint, req.currentUser));
}));

// ---------------------------------------------------------------- phones

/** The app's page registers the phone it runs on, for the signed-in person. The device token is returned once. */
router.post('/calling/devices/register', logsCalls, asyncHandler(async (req, res) => {
  const d = z.object({
    install_id: z.string().min(8).max(80),
    info: z.object({
      maker: z.string().max(120).optional(), model: z.string().max(120).optional(), android_version: z.string().max(40).optional(),
      app_version: z.string().max(40).optional(), dialler_package: z.string().max(120).optional(),
    }).default({}),
    asset_label: z.string().max(80).nullable().optional(), sim_number: z.string().max(40).nullable().optional(),
  }).parse(req.body || {});
  res.status(201).json(await registerDevice({ actor: req.currentUser, installId: d.install_id, info: d.info, assetLabel: d.asset_label ?? null, simNumber: d.sim_number ?? null }));
}));

router.get('/calling/devices', settingsOnly, asyncHandler(async (req, res) => res.json(await listDevices())));
router.post('/calling/devices/:id/hand-over', settingsOnly, asyncHandler(async (req, res) => res.json(await handOverDevice(id(req.params.id), req.currentUser))));
router.post('/calling/devices/:id/revoke', settingsOnly, asyncHandler(async (req, res) => res.json(await revokeDevice(id(req.params.id), { reason: req.body?.reason }, req.currentUser))));
router.post('/calling/devices/:id/allow', settingsOnly, asyncHandler(async (req, res) => res.json(await revokeDevice(id(req.params.id), {}, req.currentUser, { restore: true }))));
router.patch('/calling/devices/:id', settingsOnly, asyncHandler(async (req, res) => {
  const { asset_label: label } = z.object({ asset_label: z.string().max(80).nullable() }).parse(req.body || {});
  res.json(await labelDevice(id(req.params.id), label, req.currentUser));
}));
router.put('/calling/dialler-modes', settingsOnly, asyncHandler(async (req, res) => {
  const d = z.object({ package: z.string().min(3).max(120), mode: z.enum(RECORDING_MODES), folder_hint: z.string().max(300).nullable().optional(), note: z.string().max(500).nullable().optional() }).parse(req.body || {});
  res.json(await confirmDiallerMode({ package: d.package, mode: d.mode, folderHint: d.folder_hint ?? null, note: d.note ?? null }, req.currentUser));
}));

// ---------------------------------------------------------------- the Android app

router.post('/calling/app', settingsOnly, appUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Choose the app file (.apk)');
  res.status(201).json({ release: await saveAppRelease({ filePath: req.file.path, originalName: req.file.originalname, version: req.body?.version, notes: req.body?.notes }, req.currentUser) });
}));
router.post('/calling/app/link', logsCalls, asyncHandler(async (req, res) => res.json(await appLink())));

export default router;
