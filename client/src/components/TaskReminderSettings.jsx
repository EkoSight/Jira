import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Badge, Field } from './ui.jsx';
import { formatDate } from '../lib/format.js';

const MODE_WORDS = {
  OFF: 'Off: no task reminders are planned',
  TEST: 'Test: only you receive them, labelled TEST; everyone else\'s are recorded as "would send"',
  LIVE: 'Live: everyone receives them, and the old daily "deadline approaching" notice stops',
};
const STATE_TONE = { SENT: 'good', ACKNOWLEDGED: 'good', SENT_BELL_ONLY: 'warning', QUEUED: 'brand', PLANNED: 'neutral', SKIPPED: 'warning', FAILED: 'critical', CANCELLED: 'neutral', WOULD_SEND: 'neutral' };
const KIND = { BEFORE_DUE: 'Before the deadline', AT_DUE: 'At the deadline', AFTER_GRACE: 'After grace (manager)', COVER: 'Covering', UNREACHED: 'Could not reach owner' };
const SUMMARY = { PERSONAL: 'Morning summary', DEPARTMENT: 'Department summary', BACKLOG_WEEKLY: 'Weekly backlog review' };

/** One person's delivery log: every reminder and summary, and what happened to it. */
export function DeliveryLog({ userId = null, days = 14 }) {
  const [log, setLog] = useState(null);
  useEffect(() => {
    api.get('/reminders/log', { user_id: userId || undefined, days }).then(setLog).catch(() => setLog({ reminders: [], summaries: [] }));
  }, [userId, days]);
  if (!log) return <div className="small muted">Loading…</div>;
  if (!log.reminders.length && !log.summaries.length) return <div className="small muted">Nothing in the last {days} days.</div>;
  return (
    <div className="table-wrap">
      <table className="data small">
        <thead><tr><th>When</th><th>What</th><th>Where</th><th>What happened</th></tr></thead>
        <tbody>
          {log.summaries.map((s) => (
            <tr key={`s${s.id}`}>
              <td className="tnum">{s.summary_date}</td>
              <td>{SUMMARY[s.kind]}{s.late ? ' (late)' : ''}{s.items ? ` · ${s.items} item${s.items === 1 ? '' : 's'}` : ''}</td>
              <td>{s.status === 'APP_ONLY' ? 'TaskFlow bell' : s.space_name ? 'Google Chat' : '—'}</td>
              <td><Badge tone={STATE_TONE[s.state]}>{s.state.toLowerCase().replace(/_/g, ' ')}</Badge>{s.reason ? <span className="muted"> {s.reason}</span> : null}</td>
            </tr>
          ))}
          {log.reminders.map((r) => (
            <tr key={`r${r.id}`}>
              <td className="tnum">{formatDate(r.remind_at, { withTime: true })}</td>
              <td>{KIND[r.kind]}: {r.ref} {r.title}{r.about_name ? ` (${r.about_name})` : ''}</td>
              <td>{r.channel === 'CHAT' ? 'Google Chat' : 'TaskFlow bell'}</td>
              <td><Badge tone={STATE_TONE[r.state]}>{r.state.toLowerCase().replace(/_/g, ' ')}</Badge>{r.reason ? <span className="muted"> {r.reason}</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Coverage() {
  const toast = useToast();
  const [report, setReport] = useState(null);
  const load = (refresh = false) => api.get('/reminders/coverage', refresh ? { refresh: 1 } : {}).then(setReport).catch((err) => toast.error(err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  if (!report) return null;
  if (report.skipped) return <div className="small muted">{report.skipped}.</div>;
  const words = report.reason_words || {};
  const unseen = (report.exceptions || []).filter((e) => e.status === 'UNSEEN');
  return (
    <div className="stack-sm">
      <div className="row wrap" style={{ gap: 8 }}>
        <Badge tone={report.unseen ? 'critical' : 'good'}>{report.unseen ? `${report.unseen} open task${report.unseen === 1 ? '' : 's'} nobody will hear about today` : 'Every open task reaches someone today'}</Badge>
        <span className="small muted">{report.open_tasks} open · {report.seen ?? '—'} reached · {report.pending ?? 0} still sending · {report.not_needed ?? 0} not needed today (owner away, nothing due) · checked {report.generated_at ? formatDate(report.generated_at, { withTime: true }) : 'now'}</span>
        <button type="button" className="btn btn-sm" onClick={() => load(true)}>Check again</button>
      </div>
      {report.by_reason && Object.keys(report.by_reason).length > 0 && (
        <div className="row wrap small" style={{ gap: 6 }}>
          {Object.entries(report.by_reason).map(([k, n]) => <Badge key={k} tone="neutral">{(words[k] || k)}: {n}</Badge>)}
        </div>
      )}
      {unseen.length > 0 && (
        <table className="data small">
          <thead><tr><th>Task</th><th>Owner</th><th>Why nobody hears about it</th></tr></thead>
          <tbody>
            {unseen.slice(0, 50).map((e) => (
              <tr key={e.task_id}>
                <td><a href={`/?task=${e.task_id}`}>{e.ref} {e.title}</a></td>
                <td>{e.owner || 'No owner'} · {e.department}</td>
                <td>{e.reasons.map((r) => words[r] || r).join('; ') || 'No summary reached anyone'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.departments_without_summary?.length > 0 && (
        <div className="small">Departments with open work and no summary space in Chat: {report.departments_without_summary.map((d) => d.name).join(', ')}</div>
      )}
    </div>
  );
}

function Connections() {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/reminders/connections').then(setData).catch(() => {}); }, []);
  if (!data) return null;
  const missing = data.people.filter((p) => !p.connected);
  const failed = data.people.filter((p) => p.last_failed);
  return (
    <div className="stack-sm">
      {!data.chat_enabled && <div className="mkt-callout is-warning small">Google Chat is switched off for the organisation (Settings → Google Chat): no morning summaries go out, and reminders reach only the TaskFlow bell.</div>}
      <div className="small">
        <strong>{data.people.length - missing.length}</strong> of {data.people.length} people connected.
        {missing.length > 0 && <> Not connected: {missing.map((p) => `${p.full_name}${p.wrong_account ? ' (wrong Google account)' : ''}`).join(', ')}.</>}
      </div>
      {failed.length > 0 && <div className="small critical-text">Last message failed for: {failed.map((p) => `${p.full_name} (${p.last_error || 'unknown error'})`).join('; ')}</div>}
      {data.departments_without_summary.length > 0 && <div className="small">No department summary space: {data.departments_without_summary.map((d) => d.name).join(', ')}.</div>}
      <details>
        <summary className="small">Everyone</summary>
        <table className="data small">
          <thead><tr><th>Person</th><th>Department</th><th>Chat</th><th>Instant alerts</th><th>Morning summary</th><th>Last message</th></tr></thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.id}>
                <td>{p.full_name}</td>
                <td>{p.department || '—'}</td>
                <td><Badge tone={p.connected ? 'good' : 'warning'}>{p.connected ? 'connected' : p.wrong_account ? 'wrong account' : 'not connected'}</Badge></td>
                <td>{p.instant ? 'on' : 'off'}</td>
                <td>{p.morning_summary ? 'on' : 'off'}</td>
                <td>{p.last_status ? <Badge tone={p.last_status === 'FAILED' ? 'critical' : p.last_status === 'SENT' ? 'good' : 'neutral'}>{p.last_status.toLowerCase()}</Badge> : '—'} {p.last_at ? formatDate(p.last_at, { withTime: true }) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Tomorrow() {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/reminders/preview').then(setData).catch(() => {}); }, []);
  if (!data) return null;
  if (!data.reminders.length) return <div className="small muted">No task reminders are planned for {data.date}.</div>;
  return (
    <table className="data small">
      <thead><tr><th>Time</th><th>To</th><th>Reminder</th><th>Where</th><th>Would it go?</th></tr></thead>
      <tbody>
        {data.reminders.map((r) => (
          <tr key={r.id}>
            <td className="tnum">{formatDate(r.at, { withTime: true })}</td>
            <td>{r.user}{r.about ? ` (for ${r.about})` : ''}</td>
            <td>{KIND[r.kind]}: {r.task}</td>
            <td>{r.channel === 'CHAT' ? 'Google Chat' : 'Bell'}</td>
            <td>{r.would}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Audit() {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/reminders/audit', { days: 14 }).then(setData).catch(() => {}); }, []);
  if (!data) return null;
  return (
    <div className="stack-sm">
      <div className="small muted">{data.note}</div>
      <div className="table-wrap">
        <table className="data small">
          <thead><tr><th>Person</th><th>Summaries sent</th><th>Bell only</th><th>Skipped</th><th>Failed</th><th>Old: sent / skipped</th><th>Reminders sent</th><th>Seen</th><th>Failed</th><th>Would send</th></tr></thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.id}>
                <td>{p.full_name}</td>
                <td className="tnum">{p.summary_sent}</td>
                <td className="tnum">{p.summary_bell_only}</td>
                <td className="tnum">{p.summary_skipped}</td>
                <td className="tnum">{p.summary_failed}</td>
                <td className="tnum">{p.old_digest_sent} / {p.old_digest_skipped}</td>
                <td className="tnum">{p.reminders_sent}</td>
                <td className="tnum">{p.reminders_acknowledged}</td>
                <td className="tnum">{p.reminders_failed}</td>
                <td className="tnum">{p.reminders_would_send}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Settings → Reminders (administrators): the engine, who it reaches, and proof. */
export default function TaskReminderSettings() {
  const toast = useToast();
  const { users } = useRefData();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [person, setPerson] = useState('');
  const [section, setSection] = useState('coverage');
  const load = useCallback(() => api.get('/reminders/settings').then((d) => { setData(d); setForm(d.reminders); }).catch((err) => toast.error(err)), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!data || !form) return null;
  const save = async (changes) => {
    try {
      const r = await api.put('/reminders/settings', changes);
      setForm(r.reminders);
      setData((d) => ({ ...d, reminders: r.reminders }));
      toast.success('Saved');
    } catch (err) { toast.error(err); }
  };
  const setMode = (mode) => {
    if (mode === 'LIVE' && !window.confirm('Switch task reminders on for everyone? The old daily "deadline approaching" notice stops at the same time.')) return;
    save({ mode });
  };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Task reminders</h2><Badge tone={form.mode === 'LIVE' ? 'good' : form.mode === 'TEST' ? 'warning' : 'neutral'}>{form.mode.toLowerCase()}</Badge></div>
        <div className="card-pad stack">
          <div className="row wrap" role="radiogroup" aria-label="Reminder mode" style={{ gap: 6 }}>
            {['OFF', 'TEST', 'LIVE'].map((m) => (
              <label key={m} className={`kind-chip${form.mode === m ? ' is-active' : ''}`}>
                <input type="radio" className="sr-only" name="reminder-mode" checked={form.mode === m} onChange={() => setMode(m)} />
                {m === 'OFF' ? 'Off' : m === 'TEST' ? 'Test' : 'Live'}
              </label>
            ))}
          </div>
          <div className="small muted">{MODE_WORDS[form.mode]}</div>
          <div className="grid-2">
            <Field label="Reminder before the deadline (hours)" hint="D5: once, if the task is still open. 0 switches it off.">
              <input type="number" className="input" min={0} max={48} value={form.beforeDueHours} onChange={(e) => setForm({ ...form, beforeDueHours: Number(e.target.value) })} />
            </Field>
            <Field label="Quiet hours (India time)" hint="Nothing is sent between these times; the next morning summary carries it">
              <div className="row" style={{ gap: 6 }}>
                <input type="time" className="input" aria-label="Quiet from" value={form.quietStart} onChange={(e) => setForm({ ...form, quietStart: e.target.value })} />
                <span>to</span>
                <input type="time" className="input" aria-label="Quiet until" value={form.quietEnd} onChange={(e) => setForm({ ...form, quietEnd: e.target.value })} />
              </div>
            </Field>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={form.atDue} onChange={(e) => setForm({ ...form, atDue: e.target.checked })} /> Tell the owner at the deadline</label>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={form.managerNotice} onChange={(e) => setForm({ ...form, managerNotice: e.target.checked })} /> After the grace period, tell the reporting manager (or the department's managers)</label>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={form.weeklyBacklog} onChange={(e) => setForm({ ...form, weeklyBacklog: e.target.checked })} /> Weekly backlog review on the first working day</label>
            <Field label="A late morning summary is still sent until">
              <input type="time" className="input" value={form.catchUpUntil} onChange={(e) => setForm({ ...form, catchUpUntil: e.target.value })} />
            </Field>
          </div>
          <div className="small muted">
            Morning summary at {data.summaryTimes.personal}, department summary at {data.summaryTimes.department} (Settings → Google Chat).
            Holidays, leave and each person's days off are respected.
          </div>
          <div><button type="button" className="btn btn-primary" onClick={() => save({ beforeDueHours: form.beforeDueHours, quietStart: form.quietStart, quietEnd: form.quietEnd, atDue: form.atDue, managerNotice: form.managerNotice, weeklyBacklog: form.weeklyBacklog, catchUpUntil: form.catchUpUntil })}>Save</button></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="row wrap" role="tablist" aria-label="Reminder records" style={{ gap: 4 }}>
            {[['coverage', 'Coverage today'], ['connections', 'Connections'], ['tomorrow', 'Tomorrow'], ['log', 'Delivery log'], ['audit', '14-day audit']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={section === key} className={`btn btn-sm ${section === key ? '' : 'btn-ghost'}`} onClick={() => setSection(key)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="card-pad">
          {section === 'coverage' && <Coverage />}
          {section === 'connections' && <Connections />}
          {section === 'tomorrow' && <Tomorrow />}
          {section === 'log' && (
            <div className="stack-sm">
              <select className="select" aria-label="Whose log" value={person} onChange={(e) => setPerson(e.target.value)} style={{ maxWidth: 280 }}>
                <option value="">Choose a person…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
              {person && <DeliveryLog userId={Number(person)} />}
            </div>
          )}
          {section === 'audit' && <Audit />}
        </div>
      </div>
    </div>
  );
}
