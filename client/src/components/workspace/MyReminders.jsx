/**
 * Settings → My account → My reminders: how I hear about my tasks (the bell,
 * Google Chat, email), every reminder rule that can reach me, old and new,
 * with its default, my choice, the channels and the time; my own "remind me"
 * reminders; my timezone; and what was sent.
 *
 * Changing a reminder here changes when I am told, never a record's date:
 * "Change my reminder" is not "Change the deadline".
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, Modal, Spinner } from '../ui.jsx';
import { shortDateTime, whenWords } from '../../lib/workspace.js';
import { CHOICES } from '../TaskReminderSettings.jsx';

const STATE_TONE = { SENT: 'good', PLANNED: 'brand', WOULD_SEND: 'warning', SKIPPED: 'neutral', CANCELLED: 'neutral', FAILED: 'critical', SENT_BELL_ONLY: 'warning' };
const STATE_WORDS = { SENT: 'Sent', PLANNED: 'Planned', WOULD_SEND: 'Would send (test mode)', SKIPPED: 'Skipped', CANCELLED: 'Cancelled', FAILED: 'Failed', SENT_BELL_ONLY: 'Bell only (Chat failed)' };

/**
 * How I hear about my own tasks and my morning summary: my choice over the
 * organisation's default, whether Chat and email can reach me, and a sample.
 */
function HowYouHear() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/reminders/channels').then((d) => { setData(d); setForm({ task_reminders: d.task_reminders, summaries: d.summaries, summary_all_clear: d.summary_all_clear }); }).catch(() => {});
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (data && window.location.hash === '#how-you-hear') document.getElementById('how-you-hear')?.scrollIntoView({ block: 'start' });
  }, [Boolean(data)]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !form) return null;
  const changed = form.task_reminders !== data.task_reminders || form.summaries !== data.summaries || form.summary_all_clear !== data.summary_all_clear;
  const save = async () => {
    setBusy(true);
    try { await api.put('/reminders/channels', form); toast.success('Saved. Your next reminders follow it'); await load(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const sample = async () => {
    setBusy(true);
    try {
      const r = await api.post('/reminders/sample-email');
      if (r.sent) toast.success(`Sample sent to ${r.to}`); else toast.error(r.reason || 'It could not be sent');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const defaultWord = (v) => CHOICES.find(([k]) => k === v)?.[1] || v;
  return (
    <div className="stack-sm" id="how-you-hear">
      <h3 style={{ margin: 0, fontSize: 14 }}>How you hear about your tasks</h3>
      <div className="how-hear">
        <label className="field">
          <span className="field-label">Task reminders</span>
          <select className="select" value={form.task_reminders} onChange={(e) => setForm({ ...form, task_reminders: e.target.value })}>
            {CHOICES.map(([v, l]) => <option key={v} value={v}>{l}{v === data.defaults.task_reminders ? ' (default)' : ''}</option>)}
          </select>
          <span className="field-hint">Before, at and after a deadline, and when you cover for someone. The TaskFlow bell always carries them. Today: {data.now.task_reminders}.</span>
        </label>
        <label className="field">
          <span className="field-label">Morning summary and weekly backlog review</span>
          <select className="select" value={form.summaries} onChange={(e) => setForm({ ...form, summaries: e.target.value })}>
            {CHOICES.map(([v, l]) => <option key={v} value={v}>{l}{v === data.defaults.summaries ? ' (default)' : ''}</option>)}
          </select>
          <label className="row small" style={{ gap: 6, marginTop: 6 }}>
            <input type="checkbox" checked={form.summary_all_clear} onChange={(e) => setForm({ ...form, summary_all_clear: e.target.checked })} />
            Email me &quot;all clear&quot; on days with nothing open
          </label>
        </label>
      </div>
      <div className="reach-row small">
        <span>Google Chat:</span>
        {data.chat.connected ? <Badge tone="good">connected</Badge> : <Badge tone="warning">not connected</Badge>}
        {!data.chat.connected && <span className="muted">{data.chat.enabled ? 'In Google Chat choose New chat, search for TaskFlow under Apps, and send it a message.' : data.chat.why}</span>}
      </div>
      <div className="reach-row small">
        <span>Email ({data.email.address}):</span>
        {data.email.bounced ? <Badge tone="critical">bounced</Badge> : data.email.ready ? <Badge tone="good">reachable</Badge> : <Badge tone="neutral">not set up</Badge>}
        {data.email.bounced && <span className="muted">Emails to you bounced ({data.email.bounced_reason}). Ask an administrator to check your address and clear it.</span>}
        {!data.email.bounced && !data.email.ready && <span className="muted">{data.email.why}</span>}
      </div>
      {data.mode !== 'LIVE' && <div className="small muted">Task reminders are {data.mode === 'TEST' ? 'in test mode: only the administrator testing them receives anything yet' : 'switched off'}.</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !changed} onClick={save}>Save how I hear</button>
        <button type="button" className="btn btn-sm" disabled={busy || !data.email.ready || data.email.bounced} onClick={sample}>Send me a sample reminder email</button>
        {!changed && <span className="small muted">Defaults: {defaultWord(data.defaults.task_reminders)} · {defaultWord(data.defaults.summaries)}</span>}
      </div>
    </div>
  );
}

function RuleRow({ r, chatOk, emailOk, onSave }) {
  const [busy, setBusy] = useState(false);
  const save = async (patch) => {
    setBusy(true);
    try { await onSave(r.key, { enabled: r.enabled, at_time: r.chosen ? r.at : null, chat: r.chat, email: r.email, ...patch }); } finally { setBusy(false); }
  };
  const id = `rule-${r.key}`;
  return (
    <tr>
      <td>
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }} htmlFor={id}>
          <input id={id} type="checkbox" checked={r.enabled} disabled={busy || r.personal} onChange={(e) => save({ enabled: e.target.checked })} style={{ marginTop: 3 }} />
          <span>
            <strong>{r.label}</strong>{r.opt_in && <> <Badge>Only if you turn it on</Badge></>}
            <span className="small muted" style={{ display: 'block' }}>{r.description}</span>
            <span className="small muted" style={{ display: 'block' }}>Default: {r.default.enabled ? 'on' : 'off'}{r.default.at ? `, ${r.default.at}` : ''}</span>
          </span>
        </label>
      </td>
      <td>
        {r.relative ? <span className="small">30 min before</span> : r.personal ? <span className="small">The time you choose</span> : (
          <input className="input" type="time" aria-label={`Time for ${r.label}`} value={r.at || '09:00'} disabled={busy || !r.enabled}
            onChange={(e) => e.target.value && save({ at_time: e.target.value })} style={{ maxWidth: 120 }} />
        )}
      </td>
      <td>
        <div className="small">TaskFlow bell</div>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={chatOk && r.chat !== false} disabled={busy || !chatOk || !r.enabled} onChange={(e) => save({ chat: e.target.checked })} />
          Google Chat{!chatOk ? ' (not connected)' : ''}
        </label>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={emailOk && r.email === true} disabled={busy || !emailOk || !r.enabled} onChange={(e) => save({ email: e.target.checked })} />
          Email me{!emailOk ? ' (not available)' : ''}
        </label>
      </td>
    </tr>
  );
}

function ChangeReminder({ reminder, onClose, onSaved }) {
  const toast = useToast();
  const local = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const [when, setWhen] = useState(local(reminder.remind_at));
  const [note, setNote] = useState(reminder.note || '');
  const save = async () => {
    try {
      await api.put(`/workspace/reminders/personal/${reminder.id}`, { remind_at: new Date(when).toISOString(), note: note || null });
      toast.success('Your reminder is changed. The record is not');
      onSaved();
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Change my reminder" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save my reminder</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>This changes when you are reminded, not the record&apos;s deadline or any date on it.</p>
        <label className="field"><span className="field-label">Remind me on</span><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        <label className="field"><span className="field-label">Note to yourself (optional)</span><input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

export default function MyReminders() {
  const { setUser } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [log, setLog] = useState(null);
  const [zones, setZones] = useState(null);
  const [changing, setChanging] = useState(null);
  const load = () => Promise.all([api.get('/workspace/reminders'), api.get('/workspace/reminders/log')])
    .then(([d, l]) => { setData(d); setLog(l.occurrences); })
    .catch((err) => toast.error(err));
  useEffect(() => { load(); api.get('/workspace/timezones').then((r) => setZones(r.timezones)).catch(() => setZones([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveRule = async (key, body) => {
    try {
      const r = await api.put(`/workspace/reminders/rules/${key}`, body);
      toast.success(body.enabled ? 'Saved. Only your reminders changed' : `Turned off for you${r.cancelled ? `: ${r.cancelled} planned reminder${r.cancelled === 1 ? '' : 's'} cancelled` : ''}`);
      load();
    } catch (err) { toast.error(err); }
  };
  const setZone = async (tz) => {
    try {
      const r = await api.put('/workspace/me/timezone', { timezone: tz || null });
      setUser((u) => (u ? { ...u, timezone: r.timezone } : u));
      toast.success(tz ? `Your timezone is ${tz}` : 'You follow the company timezone again');
      load();
    } catch (err) { toast.error(err); }
  };
  const cancel = async (id) => {
    try { await api.post(`/workspace/reminders/personal/${id}/cancel`); toast.success('Reminder removed'); load(); } catch (err) { toast.error(err); }
  };

  useEffect(() => {
    if (data && window.location.hash === '#my-reminders') document.getElementById('my-reminders')?.scrollIntoView({ block: 'start' });
  }, [Boolean(data)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <section className="card" id="my-reminders"><div className="card-pad"><Spinner label="Loading your reminders" /></div></section>;
  const groups = [...new Set(data.rules.map((r) => r.group))];
  return (
    <section className="card" id="my-reminders" aria-labelledby="my-reminders-title">
      <div className="card-head">
        <h2 id="my-reminders-title">My reminders</h2>
        {data.mode !== 'LIVE' && <Badge tone="warning">{data.mode === 'TEST' ? 'Workspace reminders are in test mode' : 'Workspace reminders are off'}</Badge>}
      </div>
      <div className="card-pad stack">
        <p className="small muted" style={{ margin: 0 }}>
          These change when you are told, for you only. They never change a deadline or anyone else&apos;s reminders.
          Reminders reach you in the TaskFlow bell{data.channels.chat ? ', in Google Chat' : ''}{data.channels.email ? ', and by email where you turn it on' : ''}. Push is not available.
          {!data.channels.chat && data.channels.chat_why ? ` Google Chat: ${data.channels.chat_why}.` : ''}
          {!data.channels.email && data.email_why ? ` Email: ${data.email_why}.` : ''}
        </p>

        <HowYouHear />

        <label className="field" style={{ maxWidth: 360 }}>
          <span className="field-label">My timezone</span>
          <select className="select" value={data.timezone_is_personal ? data.timezone : ''} onChange={(e) => setZone(e.target.value)} disabled={!zones}>
            <option value="">The company&apos;s ({data.company_timezone})</option>
            {(zones || []).map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          <span className="field-hint">Reminders at a time of day use this. Exact deadlines are shown in it too.</span>
        </label>

        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Reminder</th><th>When</th><th>Where</th></tr></thead>
            {groups.map((g) => (
              <tbody key={g}>
                <tr><th colSpan={3} scope="colgroup" className="small muted" style={{ textAlign: 'left' }}>{g}</th></tr>
                {data.rules.filter((r) => r.group === g).map((r) => <RuleRow key={r.key} r={r} chatOk={data.channels.chat} emailOk={data.channels.email} onSave={saveRule} />)}
              </tbody>
            ))}
            <tbody>
              <tr><th colSpan={3} scope="colgroup" className="small muted" style={{ textAlign: 'left' }}>Set elsewhere (unchanged)</th></tr>
              {data.existing.map((x) => (
                <tr key={x.key}>
                  <td><strong>{x.label}</strong><span className="small muted" style={{ display: 'block' }}>{x.description}</span></td>
                  <td className="small">{x.choice}</td>
                  {/* positioned, so the hidden label stays inside the table's scroll box at phone width */}
                  <td style={{ position: 'relative' }}>{x.manage.endsWith('#how-you-hear')
                    ? <a className="btn btn-sm btn-ghost" href="#how-you-hear" onClick={(e) => { e.preventDefault(); document.getElementById('how-you-hear')?.scrollIntoView({ block: 'start' }); }}>Change<span className="sr-only"> {x.label}</span></a>
                    : <Link className="btn btn-sm btn-ghost" to={x.manage}>Manage<span className="sr-only"> {x.label}</span></Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="stack-sm">
          <h3 style={{ margin: 0, fontSize: 14 }}>My own reminders</h3>
          {!data.personal.length && <div className="small muted">None. Use &quot;Remind me&quot; on a task, lead, deal, application or meeting.</div>}
          <ul className="ws-list">
            {data.personal.map((p) => (
              <li key={p.id} className="ws-row ws-static">
                <span className="grow" style={{ minWidth: 0 }}>
                  {p.available ? <Link to={p.record.url}>{p.record.label}</Link> : <span className="muted">Not available</span>}
                  <span className="ws-reason" style={{ display: 'block' }}>{whenWords({ at: p.remind_at }, { timeZone: data.timezone })}{p.note ? ` · ${p.note}` : ''}</span>
                </span>
                {p.available && <button type="button" className="btn btn-sm" onClick={() => setChanging(p)}>Change my reminder</button>}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => cancel(p.id)}>Remove</button>
              </li>
            ))}
          </ul>
        </div>

        <div className="stack-sm">
          <h3 style={{ margin: 0, fontSize: 14 }}>Sent and planned (last 14 days)</h3>
          {log && !log.length && <div className="small muted">Nothing yet.</div>}
          {log && log.length > 0 && (
            <div className="table-wrap">
              <table className="data small">
                <thead><tr><th>When ({data.timezone})</th><th>Reminder</th><th>What happened</th></tr></thead>
                <tbody>
                  {log.map((o) => (
                    <tr key={o.id}>
                      <td className="tnum">{shortDateTime(o.remind_at, data.timezone)}</td>
                      <td>{o.rule_label}</td>
                      <td><Badge tone={STATE_TONE[o.state] || 'neutral'}>{STATE_WORDS[o.state] || o.state}</Badge>{o.email_status ? <span className="muted"> · email {o.email_status.toLowerCase()}</span> : null}{o.reason ? <span className="muted"> {o.reason}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {changing && <ChangeReminder reminder={changing} onClose={() => setChanging(null)} onSaved={() => { setChanging(null); load(); }} />}
    </section>
  );
}
