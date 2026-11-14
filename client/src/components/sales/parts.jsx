import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, Field, Icon, Modal, Spinner } from '../ui.jsx';
import {
  CALL_OUTCOME, CATEGORY, COMPLETE_OUTCOME, DESTINATION, FOLLOWUP_KIND, LEAD_STATUS, PRIORITY, WA_STATUS, inHours, toIso, when,
} from '../../lib/sales.js';
import { newRequestId } from '../../lib/attendance.js';
import {
  CHANNEL_LABEL, REMINDER_OFFSETS, REMINDER_STATUS, dueState, exactTime, reminderWords,
} from '../../lib/crmWork.js';
import { CallAction, useCallSession } from './PhoneCall.jsx';
import { estimateMinutes, lengthWords } from '../../lib/phoneCalls.js';

export function CategoryBadge({ category }) {
  const c = CATEGORY[category] || CATEGORY.UNCLASSIFIED;
  return <Badge tone={c.tone} title={c.label}>{c.short}</Badge>;
}

/** The lead's calling status, in its own colour. */
export function CallStatusBadge({ lead }) {
  if (!lead.call_status_label) return null;
  return (
    <span className="call-status" style={{ '--status-color': lead.call_status_color || 'var(--ink-muted)' }}>
      <span className="call-status-dot" aria-hidden="true" />{lead.call_status_label}
    </span>
  );
}

/** One to five stars; tapping the current rating clears it. */
export function Stars({ value, onChange, label = 'Rating' }) {
  if (!onChange) {
    return value ? <span className="stars" aria-label={`${value} of 5 stars`}>{'★'.repeat(value)}<span className="stars-off">{'★'.repeat(5 - value)}</span></span> : null;
  }
  return (
    <span className="stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`}
          className={`star${value >= n ? ' is-on' : ''}`} onClick={() => onChange(value === n ? null : n)}>★</button>
      ))}
    </span>
  );
}

/** Inputs for the lead's own questions (Settings → Lead fields). */
export function LeadFieldInputs({ fields, values, onChange }) {
  const set = (key, v) => onChange({ ...values, [key]: v });
  return (
    <div className="grid-2">
      {fields.map((f) => {
        const v = values?.[f.key];
        if (f.type === 'SELECT') {
          return (
            <Field key={f.key} label={f.label} hint={f.help || undefined}>
              <select className="select" value={v || ''} onChange={(e) => set(f.key, e.target.value || null)}>
                <option value="">Not asked yet</option>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          );
        }
        if (f.type === 'MULTI_SELECT') {
          const list = Array.isArray(v) ? v : [];
          return (
            <Field key={f.key} label={f.label} hint={f.help || undefined}>
              <div className="row wrap" style={{ gap: 6 }}>
                {f.options.map((o) => (
                  <button key={o.value} type="button" aria-pressed={list.includes(o.value)} className={`kind-chip${list.includes(o.value) ? ' is-active' : ''}`}
                    onClick={() => set(f.key, list.includes(o.value) ? list.filter((x) => x !== o.value) : [...list, o.value])}>{o.label}</button>
                ))}
              </div>
            </Field>
          );
        }
        return (
          <Field key={f.key} label={f.label} hint={f.help || undefined}>
            {f.type === 'LONG_TEXT'
              ? <textarea className="textarea" rows={2} value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} />
              : <input className="input" type={{ NUMBER: 'number', DATE: 'date', URL: 'url' }[f.type] || 'text'} value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} />}
          </Field>
        );
      })}
    </div>
  );
}
export function LeadStatusBadge({ status }) {
  const s = LEAD_STATUS[status] || { label: status, tone: 'neutral' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
export function DestinationBadge({ destination }) {
  const d = DESTINATION[destination];
  return d ? <Badge tone={d.tone}>{d.label}</Badge> : null;
}
export function WaStatus({ status }) {
  const s = WA_STATUS[status] || { label: status, tone: 'neutral' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** A labelled number, with what it counts one tap away. */
export function Metric({ label, value, note, define, tone, onDrill }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stat sales-metric">
      <span className="stat-label">
        {tone && <span className="stat-accent" style={{ background: `var(--${tone})` }} />}{label}
        {define && (
          <button type="button" className="btn-link sales-define" aria-expanded={open} aria-label={`What "${label}" counts`} onClick={() => setOpen((v) => !v)}>?</button>
        )}
      </span>
      {onDrill
        ? <button type="button" className="stat-value tnum btn-link" title="See the records behind this number" onClick={onDrill}>{value}</button>
        : <span className="stat-value tnum">{value}</span>}
      {note && <span className="stat-note">{note}</span>}
      {open && <span className="stat-note sales-definition">{define}</span>}
    </div>
  );
}

/** Next follow-up fields used by several dialogs. */
function NextStep({ value, onChange, users, allowAssign }) {
  return (
    <div className="stack-sm sales-next">
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        Schedule the next step
      </label>
      {value.on && (
        <div className="grid-2">
          <Field label="What">
            <select className="select" value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value })}>
              {Object.entries(FOLLOWUP_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="When">
            <input className="input" type="datetime-local" value={value.due} onChange={(e) => onChange({ ...value, due: e.target.value })} />
          </Field>
          {allowAssign && users && (
            <Field label="Who">
              <select className="select" value={value.assignee_id} onChange={(e) => onChange({ ...value, assignee_id: e.target.value })}>
                <option value="">Me</option>
                {users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Note for then (optional)">
            <input className="input" value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="Send the revised quote" />
          </Field>
        </div>
      )}
    </div>
  );
}
const nextDraft = (on = true) => ({ on, kind: 'CALL', due: inHours(24), assignee_id: '', title: '' });
const nextBody = (n) => (n.on ? { kind: n.kind, due_at: toIso(n.due), title: n.title || null, assignee_id: n.assignee_id ? Number(n.assignee_id) : null } : null);

/**
 * Logging a call: what happened, what was said, and what happens next, in one
 * step. Works for a lead, an organization or a deal.
 */
export function LogCallDialog({ target, phone, users, onClose, onSaved, call = null }) {
  const toast = useToast();
  const { can } = useAuth();
  // a call started from TaskFlow for this record (or one picked from the
  // "Dialled: say how it went" list): the log fills it in instead of adding another
  const callSession = useCallSession();
  const session = callSession.activeFor(target);
  const active = call ? { callId: call.id, dialledAt: call.dialled_at || call.started_at, live: call, estimate: null }
    : session;
  const measured = active?.live?.duration_source === 'DEVICE_LOG' ? active.live.talk_sec : null;
  const [form, setForm] = useState(() => ({
    outcome: active?.live?.connected === false ? 'NO_ANSWER' : 'CONNECTED', notes: '', direction: 'OUTBOUND',
    minutes: measured === null && active?.estimate ? String(estimateMinutes(active.estimate)) : '',
  }));
  const [minutesTyped, setMinutesTyped] = useState(false);
  const [next, setNext] = useState(nextDraft());
  const [saving, setSaving] = useState(false);
  // one id per call being logged: pressing Save twice, or again after a slow
  // or lost answer, is recognised by the server as the same call
  const requestId = useRef(newRequestId());
  const busy = useRef(false);
  const reached = ['CONNECTED', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK_REQUESTED'].includes(form.outcome);
  const save = async () => {
    if (busy.current) return undefined;
    if (reached && !form.notes.trim()) return toast.error('Note what was said, so the next person can follow up');
    busy.current = true;
    setSaving(true);
    try {
      const sendLength = measured === null && form.minutes !== '';
      const r = await api.sales.post('/calls', {
        ...target, phone: phone || null, direction: active ? 'OUTBOUND' : form.direction, outcome: form.outcome, notes: form.notes.trim() || null,
        duration_sec: sendLength ? Math.round(Number(form.minutes) * 60) : null,
        duration_source: sendLength && !minutesTyped && active?.estimate ? 'ESTIMATED' : 'TYPED',
        call_id: active?.callId || null, next: nextBody(next), request_id: requestId.current,
      });
      if (session && (!call || session.callId === call.id)) callSession.finish();
      const ref = r.call?.id ? `Call #${r.call.id}` : 'Call';
      toast.success(r.duplicate ? `${ref} was already saved; nothing was added twice` : next.on ? `${ref} logged and the next step scheduled` : `${ref} logged`);
      onSaved?.(r);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      busy.current = false;
      setSaving(false);
    }
    return undefined;
  };
  return (
    <Modal title="Log a call" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}>
      <div className="stack">
        {active ? (
          <div className="call-for small" role="status">
            For the call started <span className="tnum">{exactTime(active.dialledAt)}</span>
            {measured !== null ? <> · {lengthWords(measured, 'DEVICE_LOG')}</> : active.live?.connected === false ? ' · the phone says nobody answered' : ''}
          </div>
        ) : phone && <div className="small muted">With {phone}. Logged by hand: TaskFlow records what you enter here.</div>}
        <div className="grid-2">
          <Field label="How did it go?">
            <select className="select" value={form.outcome} autoFocus onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
              {Object.entries(CALL_OUTCOME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          {!active && (
            <Field label="Who called whom">
              <select className="select" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                <option value="OUTBOUND">I called them</option>
                <option value="INBOUND">They called me</option>
              </select>
            </Field>
          )}
        </div>
        <Field label={reached ? 'What was said? *' : 'Notes'}>
          <textarea className="textarea" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder={reached ? 'They want a demo for the procurement head next week' : 'Optional'} />
        </Field>
        {measured === null && (
          <Field label="Minutes (optional)" hint={!minutesTyped && active?.estimate ? 'Estimated from the time away from TaskFlow (it includes ringing). Change it if you know better.' : undefined}>
            <input className="input" type="number" min="0" step="0.5" inputMode="decimal" value={form.minutes} onChange={(e) => { setForm({ ...form, minutes: e.target.value }); setMinutesTyped(true); }} style={{ maxWidth: 140 }} />
          </Field>
        )}
        <NextStep value={next} onChange={setNext} users={users} allowAssign={can('crm.assign')} />
      </div>
    </Modal>
  );
}

const localZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your time zone'; } catch { return 'your time zone'; }
};
/** "Asia/Kolkata (IST)" style label for the person's own clock. */
export const zoneLabel = () => { const z = localZone(); return z === 'Asia/Kolkata' ? 'India time (IST)' : z; };

/** The reminder defaults and what this server allows, loaded once per dialog. */
export function useReminderPrefs() {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => { api.sales.get('/reminder-prefs').then(setPrefs).catch(() => setPrefs({ prefs: { offsets: [15], channels: ['APP'] }, chat_allowed: false })); }, []);
  return prefs;
}

/**
 * When to be reminded before a follow-up: the person's defaults, or a choice
 * for this one (any of 30, 15, 10 and 5 minutes before; in TaskFlow, and in
 * Google Chat where an administrator has turned that on).
 */
export function ReminderChoice({ value, onChange, prefs }) {
  const own = value.custom;
  const defaults = prefs?.prefs || { offsets: [15], channels: ['APP'] };
  const offsets = own ? value.offsets : defaults.offsets;
  const channels = own ? value.channels : defaults.channels;
  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <fieldset className="reminder-choice stack-xs">
      <legend className="small">Remind {value.who || 'the person doing it'}</legend>
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={!own} onChange={(e) => onChange(e.target.checked ? { ...value, custom: false } : { ...value, custom: true, offsets: defaults.offsets, channels: defaults.channels })} />
        Use their usual reminders <span className="muted">({reminderWords(defaults.offsets, defaults.channels)})</span>
      </label>
      {own && (
        <div className="stack-xs">
          <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Minutes before">
            {REMINDER_OFFSETS.map((m) => (
              <button key={m} type="button" aria-pressed={offsets.includes(m)} className={`kind-chip${offsets.includes(m) ? ' is-active' : ''}`}
                onClick={() => onChange({ ...value, offsets: toggle(offsets, m) })}>{m} min before</button>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 10 }} role="group" aria-label="Where">
            {Object.entries(CHANNEL_LABEL).map(([k, l]) => {
              const blocked = k === 'CHAT' && !prefs?.chat_allowed;
              return (
                <label key={k} className={`row small${blocked ? ' muted' : ''}`} style={{ gap: 6 }} title={blocked ? 'An administrator has not turned on Google Chat reminders' : undefined}>
                  <input type="checkbox" disabled={blocked} checked={channels.includes(k) && !blocked} onChange={() => onChange({ ...value, channels: toggle(channels, k) })} />{l}
                  {blocked && ' (not turned on)'}
                </label>
              );
            })}
          </div>
          <span className="small muted">{offsets.length ? reminderWords(offsets, channels.filter((c) => c !== 'CHAT' || prefs?.chat_allowed)) : 'No reminders for this one'}</span>
        </div>
      )}
    </fieldset>
  );
}
const reminderDraft = () => ({ custom: false, offsets: [], channels: [] });
/** What to send: nothing (their defaults) or this follow-up's own choice. */
const reminderBody = (r) => (r.custom ? { reminder_offsets: r.offsets, reminder_channels: r.channels } : {});

/** Scheduling a follow-up on a lead, organization or deal. */
export function FollowUpDialog({ target, users, onClose, onSaved }) {
  const toast = useToast();
  const { can } = useAuth();
  const [form, setForm] = useState({ kind: 'CALL', due: inHours(24), title: '', priority: 'MEDIUM', assignee_id: '', notes: '', recurrence: 'none' });
  const [reminders, setReminders] = useState(reminderDraft());
  const prefs = useReminderPrefs();
  const [saving, setSaving] = useState(false);
  const late = form.due && new Date(form.due) < new Date();
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.sales.post('/followups', {
        ...target, kind: form.kind, due_at: toIso(form.due), title: form.title || null, priority: form.priority,
        assignee_id: form.assignee_id ? Number(form.assignee_id) : null, notes: form.notes || null, recurrence: form.recurrence,
        ...reminderBody(reminders),
      });
      toast.success('Follow-up scheduled');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Schedule a follow-up" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={saving || !form.due} onClick={save}>Schedule</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="What">
            <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {Object.entries(FOLLOWUP_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="When" hint={late ? 'That time has already passed: it will show as overdue' : `In ${zoneLabel()}`}>
            <input className="input" type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
          </Field>
        </div>
        <Field label="Title (optional)"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Call about the pilot results" /></Field>
        <div className="grid-2">
          <Field label="Priority">
            <select className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Repeats">
            <select className="select" value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })}>
              <option value="none">Does not repeat</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
          </Field>
        </div>
        {can('crm.assign') && (
          <Field label="Who does it">
            <select className="select" value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
              <option value="">The owner (or me)</option>
              {(users || []).filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Notes"><textarea className="textarea" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <ReminderChoice value={reminders} onChange={setReminders} prefs={prefs} />
      </div>
    </Modal>
  );
}

/** The reminders planned or sent for one follow-up, with what became of each. */
export function ReminderStatus({ taskId }) {
  const [list, setList] = useState(null);
  useEffect(() => { api.sales.get(`/followups/${taskId}/reminders`).then((r) => setList(r.reminders)).catch(() => setList([])); }, [taskId]);
  if (!list) return null;
  if (!list.length) return <div className="small muted">No reminders planned for this one.</div>;
  return (
    <ul className="reminder-list small" aria-label="Reminders">
      {list.map((r) => {
        const [label, tone] = REMINDER_STATUS[r.status] || [r.status, 'neutral'];
        return (
          <li key={r.id} className="row wrap" style={{ gap: 6 }}>
            <Badge tone={tone}>{label}</Badge>
            <span>{r.offset_minutes} min before, {CHANNEL_LABEL[r.channel] || r.channel}</span>
            <span className="muted tnum">{r.sent_at ? `sent ${exactTime(r.sent_at)}` : `at ${exactTime(r.remind_at)}`}</span>
            {r.channel === 'CHAT' && r.chat_status && <span className="muted">Chat delivery: {String(r.chat_status).toLowerCase()}</span>}
            {(r.last_error || r.chat_error) && <span className="critical-text">{r.last_error || r.chat_error}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** "Due now" or "Overdue" beside a follow-up's time; nothing when it is ahead. */
export function DueBadge({ dueAt }) {
  const state = dueState(dueAt);
  if (state === 'OVERDUE') return <Badge tone="critical">Overdue</Badge>;
  if (state === 'DUE_NOW') return <Badge tone="warning">Due now</Badge>;
  return null;
}

/** Completing, rescheduling, snoozing or handing off one follow-up. */
export function FollowUpActions({ task, users, onClose, onDone, initial = 'complete' }) {
  const toast = useToast();
  const { can } = useAuth();
  const [mode, setMode] = useState(initial);
  const [outcome, setOutcome] = useState('CONNECTED');
  const [notes, setNotes] = useState('');
  const [noNext, setNoNext] = useState('');
  const [next, setNext] = useState(nextDraft(true));
  const [due, setDue] = useState(inHours(24));
  const [reason, setReason] = useState('');
  const [toUser, setToUser] = useState('');
  const [busy, setBusy] = useState(false);
  const [reminders, setReminders] = useState(reminderDraft());
  const prefs = useReminderPrefs();
  const running = useRef(false);
  const run = async (fn, message) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try { await fn(); toast.success(message); onDone?.(); onClose(); } catch (err) { toast.error(err); } finally { running.current = false; setBusy(false); }
  };
  const quiet = ['NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'LEFT_MESSAGE'].includes(outcome);
  const actions = {
    complete: () => run(() => api.sales.post(`/followups/${task.id}/complete`, {
      outcome, notes: notes || null, next: nextBody(next), no_next_reason: next.on ? null : noNext || null,
    }), next.on ? 'Done, and the next step is scheduled' : 'Marked done'),
    reschedule: () => run(() => api.sales.post(`/followups/${task.id}/reschedule`, { due_at: toIso(due), reason: reason || null, ...reminderBody(reminders) }),
      'Rescheduled; its reminders moved with it'),
    snooze: () => run(() => api.sales.post(`/followups/${task.id}/snooze`, { until: toIso(due) }), 'Snoozed'),
    handoff: () => run(() => api.sales.post(`/followups/${task.id}/handoff`, { user_id: Number(toUser), reason }), 'Handed over'),
  };
  return (
    <Modal title={task.title} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || (mode === 'handoff' && (!toUser || reason.trim().length < 3))} onClick={actions[mode]}>
          {{ complete: 'Mark done', reschedule: 'Reschedule', snooze: 'Snooze', handoff: 'Hand over' }[mode]}
        </button></>}>
      <div className="stack">
        <div className="row wrap" role="tablist" style={{ gap: 4 }}>
          {[['complete', 'Done'], ['reschedule', 'Reschedule'], ['snooze', 'Snooze'], ...(can('crm.assign') ? [['handoff', 'Hand over']] : [])].map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={mode === k} className={`kind-chip${mode === k ? ' is-active' : ''}`} onClick={() => setMode(k)}>{l}</button>
          ))}
        </div>
        <div className="row wrap small" style={{ gap: 6 }}>
          <span className="muted">Due <span className="tnum">{exactTime(task.due_date)}</span>{task.about ? ` · ${task.about}` : ''}</span>
          <DueBadge dueAt={task.due_date} />
        </div>
        {mode === 'complete' && (
          <>
            <Field label="Outcome">
              <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                {Object.entries(COMPLETE_OUTCOME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label={quiet ? 'Notes (optional)' : 'What happened? *'}>
              <textarea className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <NextStep value={next} onChange={setNext} users={users} allowAssign={can('crm.assign')} />
            {!next.on && (
              <Field label="Why is there no next step?" hint="Required when this was the deal's next action">
                <input className="input" value={noNext} onChange={(e) => setNoNext(e.target.value)} placeholder="Waiting for their board meeting on the 20th" />
              </Field>
            )}
          </>
        )}
        {(mode === 'reschedule' || mode === 'snooze') && (
          <>
            <Field label={mode === 'snooze' ? 'Remind me again at' : 'New time'}><input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
            {mode === 'reschedule' && <Field label="Why (kept on its history)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="They asked for Monday" /></Field>}
            {mode === 'reschedule' && <ReminderChoice value={reminders} onChange={setReminders} prefs={prefs} />}
            <div className="small muted">Reminders not yet sent are replaced: nobody is reminded about the old time.</div>
          </>
        )}
        {mode === 'complete' && ['CALL', 'CALLBACK'].includes(task.followup_kind) && (
          <div className="small muted">Choosing how the call went records the call itself (it counts once). Choose “Done” for anything that was not a call.</div>
        )}
        <details className="small">
          <summary>Reminders for this follow-up</summary>
          <ReminderStatus taskId={task.id} />
        </details>
        {mode === 'handoff' && (
          <>
            <Field label="To">
              <select className="select" value={toUser} onChange={(e) => setToUser(e.target.value)}>
                <option value="">Choose…</option>
                {(users || []).filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </Field>
            <Field label="Why *"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/** A WhatsApp conversation with sending, inside the 24-hour window or by template. */
export function WhatsAppPanel({ target, phone }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [body, setBody] = useState('');
  const [tpl, setTpl] = useState('');
  const [vars, setVars] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = () => api.sales.get('/whatsapp/conversation', target).then(setData).catch((err) => setData({ error: err.message }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); api.sales.get('/whatsapp/templates').then((r) => setTemplates(r.templates.filter((t) => t.status === 'APPROVED'))).catch(() => {}); }, [JSON.stringify(target)]);
  if (!data) return <Spinner />;
  if (data.error) return <div className="small muted">{data.error}</div>;
  const st = data.status;
  if (!st.configured) {
    return <div className="mkt-callout small">WhatsApp is not connected on this server ({st.missing.join(', ')} not set). Calls and notes still work; an administrator connects WhatsApp in Settings → Sales CRM → Integrations.</div>;
  }
  const windowOpen = data.window_open_until && new Date(data.window_open_until) > new Date();
  const chosen = templates.find((t) => `${t.name}|${t.language}` === tpl);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.sales.post('/whatsapp/send', chosen
        ? { to: phone, template_name: chosen.name, language: chosen.language, variables: vars, ...target, idempotency_key: `${Date.now()}` }
        : { to: phone, body, ...target, idempotency_key: `${Date.now()}` });
      if (r.blocked) toast.error('Not sent: this number has opted out of WhatsApp');
      else if (r.message?.status === 'FAILED') toast.error(`Not sent: ${r.message.error_title}`);
      else toast.success('Handed to WhatsApp; its status updates here');
      setBody('');
      load();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <div className="stack-sm">
      {st.sandbox && <div className="small"><Badge tone="warning">Test number</Badge> <span className="muted">WhatsApp is connected to a sandbox number; messages go only to registered test phones.</span></div>}
      <div className="wa-thread" aria-live="polite">
        {data.messages.length === 0 && <div className="small muted">No WhatsApp messages yet.</div>}
        {data.messages.map((m) => (
          <div key={m.id} className={`wa-msg ${m.direction === 'INBOUND' ? 'is-in' : 'is-out'}`}>
            <div className="small">{m.body || (m.template_name ? `Template: ${m.template_name}` : `(${String(m.kind).toLowerCase()})`)}</div>
            <div className="row small muted" style={{ gap: 6 }}>
              <span>{when(m.created_at)}</span>
              {m.direction === 'OUTBOUND' && <WaStatus status={m.status} />}
              {m.error_title && <span className="critical-text">{m.error_title}</span>}
              {m.status === 'FAILED' && !m.accepted && (
                <button type="button" className="btn-link small" onClick={() => api.sales.post(`/whatsapp/messages/${m.id}/retry`).then(load).catch(toast.error)}>Retry</button>
              )}
            </div>
          </div>
        ))}
      </div>
      {!phone ? <div className="small muted">Add a phone number to message them.</div> : (
        <div className="stack-sm">
          <div className="small muted">{windowOpen ? `They wrote recently: free text is allowed until ${when(data.window_open_until)}.` : 'More than 24 hours since they last wrote: only an approved template can be sent.'}</div>
          <select className="select" value={tpl} onChange={(e) => { setTpl(e.target.value); const t = templates.find((x) => `${x.name}|${x.language}` === e.target.value); setVars(Array(t?.variable_count || 0).fill('')); }}>
            <option value="">{windowOpen ? 'Write a message' : 'Choose a template…'}</option>
            {templates.map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language})</option>)}
          </select>
          {chosen ? (
            <>
              {vars.map((v, i) => <input key={i} className="input" placeholder={`Value for {{${i + 1}}}`} value={v} onChange={(e) => setVars(vars.map((x, j) => (j === i ? e.target.value : x)))} />)}
              <div className="small mkt-callout">{(chosen.components.find((c) => String(c.type).toUpperCase() === 'BODY')?.text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => vars[n - 1] || m)}</div>
            </>
          ) : windowOpen && <textarea className="textarea" rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type a reply" />}
          <div><button type="button" className="btn btn-sm btn-primary" disabled={busy || (chosen ? vars.some((v) => !v.trim()) : !(windowOpen && body.trim()))} onClick={send}><Icon name="send" size={13} /> Send</button></div>
        </div>
      )}
    </div>
  );
}

/**
 * The Call button (it records the call on TaskFlow first, then the phone
 * dials); with Exotel connected, a real click-to-call as well. What happened
 * is saved afterwards, through onLog (a lead's "How did the call go?", or Log
 * call elsewhere), onto the same call.
 */
export function CallButtons({ phone, target, label, onLog, logLabel = 'Log call', exotel }) {
  const toast = useToast();
  if (!phone) return null;
  return (
    <span className="row wrap" style={{ gap: 4 }}>
      <CallAction phone={phone} target={target} label={label} />
      {exotel && (
        <button type="button" className="btn btn-sm" title="Exotel rings your phone first, then connects them; the call is logged automatically"
          onClick={() => api.sales.post('/calls/click-to-call', { phone, ...target }).then(() => toast.success('Exotel is ringing your phone')).catch(toast.error)}>
          Ring via Exotel
        </button>
      )}
      {onLog && <button type="button" className="btn btn-sm" onClick={onLog}>{logLabel}</button>}
    </span>
  );
}
