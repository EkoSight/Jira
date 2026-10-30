import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, Field, Icon, Modal, Spinner } from '../ui.jsx';
import {
  CALL_OUTCOME, CATEGORY, COMPLETE_OUTCOME, DESTINATION, FOLLOWUP_KIND, LEAD_STATUS, PRIORITY, WA_STATUS, inHours, toIso, when,
} from '../../lib/sales.js';

export function CategoryBadge({ category }) {
  const c = CATEGORY[category] || CATEGORY.UNCLASSIFIED;
  return <Badge tone={c.tone} title={`${c.label} · worked in ${c.where}`}>{c.short}</Badge>;
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
export function LogCallDialog({ target, phone, users, onClose, onSaved }) {
  const toast = useToast();
  const { can } = useAuth();
  const [form, setForm] = useState({ outcome: 'CONNECTED', notes: '', minutes: '', direction: 'OUTBOUND' });
  const [next, setNext] = useState(nextDraft());
  const [saving, setSaving] = useState(false);
  const reached = ['CONNECTED', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK_REQUESTED'].includes(form.outcome);
  const save = async () => {
    if (reached && !form.notes.trim()) return toast.error('Note what was said, so the next person can follow up');
    setSaving(true);
    try {
      await api.sales.post('/calls', {
        ...target, phone: phone || null, direction: form.direction, outcome: form.outcome, notes: form.notes.trim() || null,
        duration_sec: form.minutes ? Math.round(Number(form.minutes) * 60) : null, next: nextBody(next),
      });
      toast.success(next.on ? 'Call logged and next step scheduled' : 'Call logged');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
    return undefined;
  };
  return (
    <Modal title="Log a call" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}>
      <div className="stack">
        {phone && <div className="small muted">With {phone}. Logged by hand: TaskFlow records what you enter here.</div>}
        <div className="grid-2">
          <Field label="How did it go?">
            <select className="select" value={form.outcome} autoFocus onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
              {Object.entries(CALL_OUTCOME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Who called whom">
            <select className="select" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
              <option value="OUTBOUND">I called them</option>
              <option value="INBOUND">They called me</option>
            </select>
          </Field>
        </div>
        <Field label={reached ? 'What was said? *' : 'Notes'}>
          <textarea className="textarea" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder={reached ? 'They want a demo for the procurement head next week' : 'Optional'} />
        </Field>
        <Field label="Minutes (optional)">
          <input className="input" type="number" min="0" step="0.5" inputMode="decimal" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} style={{ maxWidth: 140 }} />
        </Field>
        <NextStep value={next} onChange={setNext} users={users} allowAssign={can('crm.assign')} />
      </div>
    </Modal>
  );
}

/** Scheduling a follow-up on a lead, organization or deal. */
export function FollowUpDialog({ target, users, onClose, onSaved }) {
  const toast = useToast();
  const { can } = useAuth();
  const [form, setForm] = useState({ kind: 'CALL', due: inHours(24), title: '', priority: 'MEDIUM', assignee_id: '', notes: '', recurrence: 'none' });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.sales.post('/followups', {
        ...target, kind: form.kind, due_at: toIso(form.due), title: form.title || null, priority: form.priority,
        assignee_id: form.assignee_id ? Number(form.assignee_id) : null, notes: form.notes || null, recurrence: form.recurrence,
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
          <Field label="When" hint="Your local time">
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
      </div>
    </Modal>
  );
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
  const run = async (fn, message) => {
    setBusy(true);
    try { await fn(); toast.success(message); onDone?.(); onClose(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const quiet = ['NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'LEFT_MESSAGE'].includes(outcome);
  const actions = {
    complete: () => run(() => api.sales.post(`/followups/${task.id}/complete`, {
      outcome, notes: notes || null, next: nextBody(next), no_next_reason: next.on ? null : noNext || null,
    }), next.on ? 'Done, and the next step is scheduled' : 'Marked done'),
    reschedule: () => run(() => api.sales.post(`/followups/${task.id}/reschedule`, { due_at: toIso(due), reason: reason || null }), 'Rescheduled'),
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
        <div className="small muted">Due {when(task.due_date)}{task.about ? ` · ${task.about}` : ''}</div>
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
          </>
        )}
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

/** A tel: link, labelled honestly; with Exotel connected, a real click-to-call as well. */
export function CallButtons({ phone, target, onLog, exotel }) {
  const toast = useToast();
  if (!phone) return null;
  return (
    <span className="row" style={{ gap: 4 }}>
      <a className="btn btn-sm" href={`tel:${phone}`} title="Opens your phone's dialler. It does not record the call: log it afterwards.">
        <Icon name="sound" size={13} /> Call
      </a>
      {exotel && (
        <button type="button" className="btn btn-sm" title="Exotel rings your phone first, then connects them; the call is logged automatically"
          onClick={() => api.sales.post('/calls/click-to-call', { phone, ...target }).then(() => toast.success('Exotel is ringing your phone')).catch(toast.error)}>
          Ring via Exotel
        </button>
      )}
      <button type="button" className="btn btn-sm" onClick={onLog}>Log call</button>
    </span>
  );
}
