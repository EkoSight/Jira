/**
 * Settings → My account → My reminders: every reminder rule that can reach
 * me, old and new, with its default, my choice, the channels and the time;
 * my own "remind me" reminders; my timezone; and what was sent.
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

const STATE_TONE = { SENT: 'good', PLANNED: 'brand', WOULD_SEND: 'warning', SKIPPED: 'neutral', CANCELLED: 'neutral', FAILED: 'critical', SENT_BELL_ONLY: 'warning' };
const STATE_WORDS = { SENT: 'Sent', PLANNED: 'Planned', WOULD_SEND: 'Would send (test mode)', SKIPPED: 'Skipped', CANCELLED: 'Cancelled', FAILED: 'Failed', SENT_BELL_ONLY: 'Bell only (Chat failed)' };

function RuleRow({ r, chatOk, onSave }) {
  const [busy, setBusy] = useState(false);
  const save = async (patch) => {
    setBusy(true);
    try { await onSave(r.key, { enabled: r.enabled, at_time: r.chosen ? r.at : null, chat: r.chat, ...patch }); } finally { setBusy(false); }
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
          Reminders reach you in the TaskFlow bell{data.channels.chat ? ' and in Google Chat' : ''}. Email and push are not available.
          {!data.channels.chat && data.channels.chat_why ? ` Google Chat: ${data.channels.chat_why}.` : ''}
        </p>

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
                {data.rules.filter((r) => r.group === g).map((r) => <RuleRow key={r.key} r={r} chatOk={data.channels.chat} onSave={saveRule} />)}
              </tbody>
            ))}
            <tbody>
              <tr><th colSpan={3} scope="colgroup" className="small muted" style={{ textAlign: 'left' }}>Set elsewhere (unchanged)</th></tr>
              {data.existing.map((x) => (
                <tr key={x.key}>
                  <td><strong>{x.label}</strong><span className="small muted" style={{ display: 'block' }}>{x.description}</span></td>
                  <td className="small">{x.choice}</td>
                  <td><Link className="btn btn-sm btn-ghost" to={x.manage}>Manage<span className="sr-only"> {x.label}</span></Link></td>
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
                      <td><Badge tone={STATE_TONE[o.state] || 'neutral'}>{STATE_WORDS[o.state] || o.state}</Badge>{o.reason ? <span className="muted"> {o.reason}</span> : null}</td>
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
