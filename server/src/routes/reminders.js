/**
 * Task reminders: settings, a preview of tomorrow, the delivery log, Google
 * Chat connections, the coverage check and the 14-day audit report
 * (administrators, settings.manage), plus a person's own log and "Got it".
 * Everything here reads; only the settings and an acknowledgement write.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, forbidden, notFound } from '../lib/errors.js';
import { hasPermission } from '../lib/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { audit } from '../services/attendance.js';
import { getSettings, updateSetting } from '../services/settings.js';
import { deadlineClock } from '../services/deadlines.js';
import {
  acknowledgeTaskReminders, chatRoute, deliveryStatus, inQuietHours, offWords, awayAt, reminderSettings, reminderWords, remindersForTask, replanSweep,
} from '../services/taskReminders.js';
import { REASON_WORDS, coverageReport } from '../services/coverage.js';
import { personalSummary } from '../services/taskSummaries.js';
import { canAccess } from './tasks.js';

const router = Router();
const manage = requirePermission('settings.manage');
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// ---------------------------------------------------------------- settings

router.get('/settings', manage, asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.json({ reminders: await reminderSettings(settings), summaryTimes: { personal: settings.googleChat?.morningSummaryTime || '08:45', department: settings.googleChat?.teamSummaryTime || '09:15' } });
}));

router.put('/settings', manage, asyncHandler(async (req, res) => {
  const body = z.object({
    mode: z.enum(['OFF', 'TEST', 'LIVE']).optional(),
    beforeDueHours: z.number().min(0).max(48).optional(),
    atDue: z.boolean().optional(),
    managerNotice: z.boolean().optional(),
    quietStart: z.string().regex(TIME).optional(),
    quietEnd: z.string().regex(TIME).optional(),
    catchUpUntil: z.string().regex(TIME).optional(),
    weeklyBacklog: z.boolean().optional(),
    coverageTime: z.string().regex(TIME).optional(),
  }).parse(req.body || {});
  const current = (await getSettings()).reminders || {};
  const next = { ...current, ...body };
  // test mode sends only to the administrator who switched it on
  if (body.mode === 'TEST') next.testRecipientId = req.currentUser.id;
  await updateSetting('reminders', next, req.currentUser.id);
  await audit(null, {
    entityType: 'REMINDERS', entityId: 1, actorId: req.currentUser.id, action: 'SETTINGS_CHANGED',
    before: current, after: next, reason: body.mode && body.mode !== current.mode ? `Mode ${current.mode || 'TEST'} → ${body.mode}` : null,
  });
  await replanSweep();
  res.json({ reminders: await reminderSettings() });
}));

// ---------------------------------------------------------------- preview: who would get what tomorrow

router.get('/preview', manage, asyncHandler(async (req, res) => {
  const s = await reminderSettings();
  const now = new Date();
  const c = await deadlineClock(now);
  const day = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : c.tomorrow;
  const { rows } = await query(
    `SELECT r.*, u.full_name AS user_name, t.ref, t.title, a.full_name AS about_name
       FROM task_reminders r JOIN users u ON u.id = r.user_id JOIN tasks t ON t.id = r.task_id LEFT JOIN users a ON a.id = r.about_user_id
      WHERE r.status = 'PENDING' AND (r.remind_at AT TIME ZONE $2)::date = $1::date
      ORDER BY r.remind_at, u.full_name`,
    [day, c.timezone],
  );
  const people = [...new Set(rows.map((r) => r.user_id))];
  const out = [];
  for (const r of rows) {
    const at = new Date(r.remind_at);
    const { away } = await awayAt([r.user_id], at, c.timezone);
    const off = away.get(r.user_id);
    let would = 'send';
    if (s.mode === 'OFF') would = 'skip: reminders are off';
    else if (off) would = `skip: away (${offWords(off)})${r.role === 'OWNER' ? '; fallback told' : ''}`;
    else if (inQuietHours(at, s)) would = 'skip: quiet hours (in the morning summary)';
    else if (r.channel === 'CHAT') {
      const route = await chatRoute(r.user_id, { query }, s);
      if (!route.ok) would = `skip: ${route.why} (bell only)`;
    }
    if (s.mode === 'TEST' && would === 'send' && Number(s.testRecipientId) !== r.user_id) would = 'test mode: recorded as "would send"';
    out.push({ id: r.id, at: r.remind_at, user: r.user_name, kind: r.kind, role: r.role, channel: r.channel, task: `${r.ref} ${r.title}`, about: r.about_name, would });
  }
  res.json({ date: day, mode: s.mode, reminders: out, people: people.length });
}));

/** Any person's summary as it would be now, sent to nobody. */
router.get('/preview/summary/:userId', manage, asyncHandler(async (req, res) => {
  const summary = await personalSummary(Number(req.params.userId), { force: true });
  if (!summary) throw notFound('No active person with that id');
  res.json(summary);
}));

// ---------------------------------------------------------------- the delivery log

/** The log for one person: every reminder and summary, with what happened. Yours, or anyone's for administrators. */
router.get('/log', asyncHandler(async (req, res) => {
  const userId = req.query.user_id ? Number(req.query.user_id) : req.currentUser.id;
  if (userId !== req.currentUser.id && !hasPermission(req.currentUser, 'settings.manage')) throw forbidden('You can only see your own reminders');
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
  const { rows: reminders } = await query(
    `SELECT r.*, t.ref, t.title, a.full_name AS about_name, o.status AS chat_status, o.last_error AS chat_error
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id LEFT JOIN users a ON a.id = r.about_user_id
       LEFT JOIN chat_outbox o ON o.dedupe_key = r.outbox_key
      WHERE r.user_id = $1 AND r.remind_at > now() - ($2 || ' days')::interval AND r.status <> 'PENDING'
      ORDER BY r.remind_at DESC LIMIT 500`,
    [userId, days],
  );
  const { rows: summaries } = await query(
    `SELECT g.*, o.status AS chat_status, o.last_error AS chat_error
       FROM reminder_summary_log g LEFT JOIN chat_outbox o ON o.dedupe_key = g.outbox_key
      WHERE g.user_id = $1 AND g.summary_date > (now() - ($2 || ' days')::interval)::date
      ORDER BY g.summary_date DESC, g.kind`,
    [userId, days],
  );
  res.json({
    reminders: reminders.map(deliveryStatus),
    summaries: summaries.map((g) => ({
      ...g,
      state: g.status === 'QUEUED' ? (g.chat_status === 'SENT' ? 'SENT' : g.chat_status === 'FAILED' ? 'FAILED' : 'QUEUED') : g.status === 'APP_ONLY' ? 'SENT_BELL_ONLY' : g.status,
      reason: g.chat_status === 'FAILED' ? g.chat_error : g.reason,
    })),
  });
}));

/** "Got it": the person has seen the reminders about this task. */
router.post('/ack', asyncHandler(async (req, res) => {
  const { task_id: taskId } = z.object({ task_id: z.number().int().positive() }).parse(req.body || {});
  res.json({ acknowledged: await acknowledgeTaskReminders(taskId, req.currentUser.id) });
}));

/** One task's reminders, for anyone who can see the task. */
router.get('/task/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await canAccess(req.currentUser, id))) throw notFound('Task not found');
  res.json({ reminders: await remindersForTask(id) });
}));

// ---------------------------------------------------------------- connections

router.get('/connections', manage, asyncHandler(async (req, res) => {
  const s = await reminderSettings();
  const { rows: people } = await query(
    `SELECT u.id, u.full_name, u.email, d.name AS department, sp.space_name, sp.added_by_email, sp.updated_at AS linked_at,
            COALESCE(p.instant, TRUE) AS instant, COALESCE(p.morning_summary, TRUE) AS morning_summary,
            last.status AS last_status, last.last_error, last.created_at AS last_at
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN chat_spaces sp ON sp.kind = 'DM' AND sp.user_id = u.id AND sp.active
       LEFT JOIN chat_preferences p ON p.user_id = u.id
       LEFT JOIN LATERAL (SELECT o.status, o.last_error, o.created_at FROM chat_outbox o WHERE o.user_id = u.id ORDER BY o.id DESC LIMIT 1) last ON TRUE
      WHERE u.is_active ORDER BY u.full_name`,
  );
  const { rows: departments } = await query(
    `SELECT d.id, d.name,
            EXISTS (SELECT 1 FROM chat_spaces sp WHERE sp.kind = 'SPACE' AND sp.active AND sp.team_summary AND sp.department_id = d.id) AS has_summary_space
       FROM departments d WHERE d.is_active ORDER BY d.name`,
  );
  res.json({
    chat_enabled: s.chatEnabled,
    people: people.map((p) => ({
      ...p,
      connected: Boolean(p.space_name) && (!p.added_by_email || p.added_by_email.toLowerCase() === String(p.email).toLowerCase()),
      wrong_account: Boolean(p.space_name && p.added_by_email && p.added_by_email.toLowerCase() !== String(p.email).toLowerCase()),
      last_failed: p.last_status === 'FAILED',
    })),
    departments_without_summary: departments.filter((d) => !d.has_summary_space),
  });
}));

// ---------------------------------------------------------------- coverage

router.get('/coverage', manage, asyncHandler(async (req, res) => {
  if (req.query.refresh === '1') return res.json(await coverageReport({ store: true }));
  const c = await deadlineClock();
  const { rows } = await query('SELECT * FROM coverage_reports WHERE report_date = $1', [c.today]);
  if (!rows[0]) return res.json(await coverageReport({ store: false }));
  const r = rows[0];
  res.json({ date: c.today, stored: true, generated_at: r.generated_at, open_tasks: r.open_tasks, unseen: r.unseen, exceptions: r.exceptions, ...r.summary, reason_words: REASON_WORDS });
}));

router.get('/coverage/history', manage, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT report_date, generated_at, open_tasks, unseen, summary FROM coverage_reports ORDER BY report_date DESC LIMIT 30');
  res.json({ reports: rows });
}));

// ---------------------------------------------------------------- the 14-day audit (read only)

/**
 * For each person, the last N days of what was meant to reach them and what
 * did: summaries (sent, bell only, skipped, failed, including the old
 * "skipped stored as sent" rows read as skipped), task reminders, and other
 * Chat alerts. Nothing is written.
 */
router.get('/audit', manage, asyncHandler(async (req, res) => {
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
  const { rows } = await query(
    `WITH people AS (SELECT id, full_name FROM users WHERE is_active),
     summaries AS (
       SELECT g.user_id,
              COUNT(*) FILTER (WHERE g.status = 'QUEUED' AND o.status = 'SENT')::int AS summary_sent,
              COUNT(*) FILTER (WHERE g.status = 'QUEUED' AND o.status = 'FAILED')::int AS summary_failed,
              COUNT(*) FILTER (WHERE g.status = 'QUEUED' AND o.status = 'PENDING')::int AS summary_queued,
              COUNT(*) FILTER (WHERE g.status = 'APP_ONLY')::int AS summary_bell_only,
              COUNT(*) FILTER (WHERE g.status = 'SKIPPED')::int AS summary_skipped
         FROM reminder_summary_log g LEFT JOIN chat_outbox o ON o.dedupe_key = g.outbox_key
        WHERE g.kind = 'PERSONAL' AND g.summary_date > (now() - ($1 || ' days')::interval)::date GROUP BY g.user_id),
     legacy AS (
       SELECT o.user_id,
              COUNT(*) FILTER (WHERE o.status = 'SENT' AND NOT (o.payload ? 'skipped'))::int AS old_digest_sent,
              COUNT(*) FILTER (WHERE o.payload ? 'skipped')::int AS old_digest_skipped,
              COUNT(*) FILTER (WHERE o.status = 'FAILED')::int AS old_digest_failed
         FROM chat_outbox o
        WHERE o.kind = 'DIGEST' AND o.created_at > now() - ($1 || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM reminder_summary_log g WHERE g.outbox_key = o.dedupe_key)
        GROUP BY o.user_id),
     reminders AS (
       SELECT r.user_id,
              COUNT(*) FILTER (WHERE r.status = 'SENT' AND (r.channel = 'APP' OR o.status = 'SENT'))::int AS reminders_sent,
              COUNT(*) FILTER (WHERE r.status = 'SENT' AND r.channel = 'CHAT' AND o.status = 'FAILED')::int AS reminders_failed,
              COUNT(*) FILTER (WHERE r.status = 'SKIPPED')::int AS reminders_skipped,
              COUNT(*) FILTER (WHERE r.status = 'WOULD_SEND')::int AS reminders_would_send,
              COUNT(*) FILTER (WHERE r.acknowledged_at IS NOT NULL)::int AS reminders_acknowledged
         FROM task_reminders r LEFT JOIN chat_outbox o ON o.dedupe_key = r.outbox_key
        WHERE r.remind_at > now() - ($1 || ' days')::interval GROUP BY r.user_id),
     alerts AS (
       SELECT o.user_id, COUNT(*) FILTER (WHERE o.status = 'SENT')::int AS alerts_sent, COUNT(*) FILTER (WHERE o.status = 'FAILED')::int AS alerts_failed
         FROM chat_outbox o WHERE o.kind = 'ALERT' AND o.created_at > now() - ($1 || ' days')::interval GROUP BY o.user_id)
     SELECT p.id, p.full_name, s.*, l.*, r.*, a.*
       FROM people p LEFT JOIN summaries s ON s.user_id = p.id LEFT JOIN legacy l ON l.user_id = p.id
       LEFT JOIN reminders r ON r.user_id = p.id LEFT JOIN alerts a ON a.user_id = p.id
      ORDER BY p.full_name`,
    [days],
  );
  res.json({
    days,
    note: 'Read only. "Sent" means Google Chat accepted the message; it is not proof it was read. Old summaries skipped for having nothing to say were stored as sent; they are counted here as skipped.',
    people: rows.map((r) => {
      const clean = { id: r.id, full_name: r.full_name };
      for (const [k, v] of Object.entries(r)) if (!['id', 'full_name', 'user_id'].includes(k)) clean[k] = v ?? 0;
      return clean;
    }),
  });
}));

/** A sample reminder for one of someone's tasks, sent only to the administrator asking, labelled TEST. */
router.post('/test', manage, asyncHandler(async (req, res) => {
  const { task_id: taskId, kind } = z.object({ task_id: z.number().int().positive(), kind: z.enum(['BEFORE_DUE', 'AT_DUE', 'AFTER_GRACE']).default('BEFORE_DUE') }).parse(req.body || {});
  const { rows } = await query(
    `SELECT t.*, s.stage, s.name AS status_name, u.full_name AS owner_name FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
       LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = $1`,
    [taskId],
  );
  if (!rows[0]) throw notFound('Task not found');
  const c = await deadlineClock();
  const words = reminderWords({ kind }, rows[0], c, { test: true });
  const route = await chatRoute(req.currentUser.id);
  await query(`INSERT INTO notifications (user_id, type, title, body, task_id) VALUES ($1, $2, $3, $4, $5)`, [req.currentUser.id, words.type, words.title, words.body, taskId]);
  if (route.ok) {
    await query(
      `INSERT INTO chat_outbox (dedupe_key, space_name, user_id, kind, payload) VALUES ($1, $2, $3, 'TASK_REMINDER', $4) ON CONFLICT (dedupe_key) DO NOTHING`,
      [`task-reminder-test:${req.currentUser.id}:${Date.now()}`, route.space, req.currentUser.id, JSON.stringify(words.chat)],
    );
  }
  if (!route.ok && route.why) return res.json({ bell: true, chat: false, why: route.why, words });
  res.json({ bell: true, chat: true, words });
}));

export default router;
