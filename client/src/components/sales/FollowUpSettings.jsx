import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Badge, Field, Modal, Spinner } from '../ui.jsx';
import { CHANNEL_LABEL, REMINDER_OFFSETS, exactTime, reminderWords } from '../../lib/crmWork.js';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v].sort((a, b) => a - b));

/** A person's daily summary as it would read, with whether and why it would be sent today. */
function DigestPreview({ preview }) {
  const e = preview.eligibility;
  return (
    <div className="stack-sm">
      <div className="row wrap small" style={{ gap: 6 }}>
        <Badge tone={preview.would_send ? 'good' : 'neutral'}>{preview.would_send ? 'Would be sent today' : 'Would not be sent today'}</Badge>
        {!preview.would_send && (
          <span className="muted">
            {!preview.settings.enabled ? 'The daily summary is switched off.' : preview.settings.testMode ? 'Test mode is on: summaries are recorded, not sent.'
              : !e.send ? e.why : !preview.items.length ? 'Nothing is due for them today.' : ''}
          </span>
        )}
      </div>
      <div className="small muted">{preview.counts.overdue} overdue · {preview.counts.today} due today · times in {preview.timezone === 'Asia/Kolkata' ? 'IST' : preview.timezone}</div>
      <pre className="digest-preview">{preview.text}</pre>
    </div>
  );
}

/** In My account: when my follow-up reminders come, and what my morning summary would say. */
export function FollowUpReminderDefaults() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.sales.get('/reminder-prefs').then((r) => { setData(r); setForm({ offsets: r.prefs.offsets || [], channels: r.prefs.channels || [] }); }).catch(() => setData(false));
  }, []);
  if (data === false) return null;
  if (!data || !form) return <div className="card card-pad"><Spinner label="Loading your follow-up reminders" /></div>;
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.sales.put('/reminder-prefs', form);
      setForm({ offsets: r.prefs.offsets, channels: r.prefs.channels });
      toast.success('Saved. Follow-ups without their own choice now use these.');
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Follow-up reminders</h2></div>
      <div className="card-pad stack-sm">
        <div className="small muted">Before each of your sales follow-ups. A follow-up can have its own choice; these are used otherwise. Times are India time (IST).</div>
        <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Minutes before">
          {REMINDER_OFFSETS.map((m) => (
            <button key={m} type="button" aria-pressed={form.offsets.includes(m)} className={`kind-chip${form.offsets.includes(m) ? ' is-active' : ''}`}
              onClick={() => setForm({ ...form, offsets: toggle(form.offsets, m) })}>{m} min before</button>
          ))}
        </div>
        <div className="row wrap" style={{ gap: 12 }} role="group" aria-label="Where">
          {Object.entries(CHANNEL_LABEL).map(([k, l]) => {
            const blocked = k === 'CHAT' && !data.chat_allowed;
            return (
              <label key={k} className={`row small${blocked ? ' muted' : ''}`} style={{ gap: 6 }}>
                <input type="checkbox" disabled={blocked} checked={form.channels.includes(k) && !blocked}
                  onChange={() => setForm({ ...form, channels: form.channels.includes(k) ? form.channels.filter((c) => c !== k) : [...form.channels, k] })} />
                {l}{blocked ? ' (an administrator has not turned this on)' : ''}
              </label>
            );
          })}
        </div>
        <div className="small">{form.offsets.length ? reminderWords(form.offsets, form.channels.filter((c) => c !== 'CHAT' || data.chat_allowed)) : 'No reminders before follow-ups'}</div>
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-sm" onClick={() => api.sales.get('/followup-digest/preview').then(setPreview).catch(toast.error)}>Preview my morning summary</button>
        </div>
      </div>
      {preview && <Modal title="Your morning summary" size="lg" onClose={() => setPreview(null)}><DigestPreview preview={preview} /></Modal>}
    </div>
  );
}

const DELIVERY = { SENT: ['Sent', 'good'], FAILED: ['Not delivered', 'critical'], WAITING: ['Waiting to send', 'brand'], QUEUED: ['Queued', 'brand'], SKIPPED: ['Skipped', 'neutral'] };

/**
 * For administrators: Chat reminders, the daily summary (when, which days,
 * test mode), a preview of anyone's summary, a test sent only to yourself,
 * per-person exceptions, and the record of each day.
 */
export function FollowUpDigestAdmin({ meta }) {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [exceptions, setExceptions] = useState([]);
  const [log, setLog] = useState(null);
  const [date, setDate] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  const [who, setWho] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exception, setException] = useState({ user_id: '', mode: 'SKIP', until: '', reason: '' });
  const load = () => api.sales.get('/followup-digest/settings').then((r) => { setSettings(r.settings); setExceptions(r.exceptions); }).catch((err) => setSettings({ error: err.message }));
  const loadLog = () => api.sales.get('/followup-digest/log', { date }).then((r) => setLog(r.log)).catch(() => setLog([]));
  useEffect(() => { load(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadLog(); }, [date]);
  if (!settings) return <Spinner />;
  if (settings.error) return <div className="critical-text small">{settings.error}</div>;
  const people = meta.users.filter((u) => u.is_active);
  const change = async (patch, message = 'Saved') => {
    setBusy(true);
    try { const r = await api.sales.put('/followup-digest/settings', patch); setSettings(r.settings); toast.success(message); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const sendTest = async () => {
    try {
      const r = await api.sales.post('/followup-digest/test', { user_id: who ? Number(who) : undefined });
      toast.success(`Test queued to your own Google Chat (${r.items} item${r.items === 1 ? '' : 's'})`);
      loadLog();
    } catch (err) { toast.error(err); }
  };
  const saveException = async (userId, body) => {
    try { await api.sales.put(`/followup-digest/exceptions/${userId}`, body); toast.success(body.mode ? 'Exception saved' : 'Exception removed'); load(); } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><h3>Follow-up reminders in Google Chat</h3></div>
        <div className="card-pad stack-sm">
          <div className="small muted">Reminders in TaskFlow always work. Chat reminders go to each person’s own direct message with the TaskFlow app, only when they have linked Chat. Nothing goes to customers.</div>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={settings.chatReminders} disabled={busy} onChange={(e) => change({ chatReminders: e.target.checked }, e.target.checked ? 'Chat reminders allowed' : 'Chat reminders off')} />
            Allow people to get follow-up reminders in Google Chat
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Daily follow-up summary</h3>
          <Badge tone={!settings.enabled ? 'neutral' : settings.testMode ? 'warning' : 'good'}>{!settings.enabled ? 'Off' : settings.testMode ? 'Test mode: recorded, not sent' : 'Sending'}</Badge>
        </div>
        <div className="card-pad stack-sm">
          <div className="small muted">Each morning, each person gets their own overdue and today’s follow-ups in Google Chat: time, lead, the latest note, the next action and a link. Only follow-ups assigned to them, inside what they may see. One a day at most.</div>
          <div className="grid-2">
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(e) => change({ enabled: e.target.checked })} /> Run the daily summary
            </label>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={settings.testMode} disabled={busy} onChange={(e) => change({ testMode: e.target.checked }, e.target.checked ? 'Test mode on' : 'Test mode off: summaries will be sent')} /> Test mode (record who would get what; send nothing)
            </label>
            <Field label="Send at (IST)"><input className="input" type="time" value={settings.time} onChange={(e) => setSettings({ ...settings, time: e.target.value })} onBlur={() => change({ time: settings.time })} /></Field>
            <Field label="Do not send after (IST)" hint="If the server was down until later, the day is skipped rather than sent late">
              <input className="input" type="time" value={settings.lastSendTime} onChange={(e) => setSettings({ ...settings, lastSendTime: e.target.value })} onBlur={() => change({ lastSendTime: settings.lastSendTime })} />
            </Field>
          </div>
          <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Days">
            <span className="small">Days:</span>
            {DAYS.map(([d, l]) => (
              <button key={d} type="button" aria-pressed={settings.days.includes(d)} className={`kind-chip${settings.days.includes(d) ? ' is-active' : ''}`}
                onClick={() => change({ days: toggle(settings.days, d) })}>{l}</button>
            ))}
          </div>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={settings.skipHolidays} disabled={busy} onChange={(e) => change({ skipHolidays: e.target.checked })} />
            Skip holidays, weekly days off and full days of approved leave (from the holiday calendar and leave records)
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Preview and test</h3></div>
        <div className="card-pad stack-sm">
          <div className="row wrap" style={{ gap: 6 }}>
            <select className="select" style={{ width: 'auto' }} aria-label="Whose summary" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">My own</option>{people.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
            <button type="button" className="btn btn-sm" onClick={() => api.sales.get('/followup-digest/preview', { user_id: who || undefined }).then(setPreview).catch(toast.error)}>Preview</button>
            <button type="button" className="btn btn-sm" onClick={sendTest}>Send a test to my own Chat</button>
          </div>
          <div className="small muted">A test goes only to you, labelled TEST, even when it is someone else’s summary.</div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Exceptions</h3></div>
        <div className="card-pad stack-sm">
          <div className="small muted">Skip someone (for example while they are on a long visit), or include them on a day that is otherwise off.</div>
          {exceptions.length === 0 ? <div className="small muted">None.</div> : exceptions.map((x) => (
            <div key={x.user_id} className="sales-row small">
              <Badge tone={x.mode === 'SKIP' ? 'warning' : 'brand'}>{x.mode === 'SKIP' ? 'Skipped' : 'Included'}</Badge>
              <span className="grow">{x.full_name}{x.until ? ` until ${x.until}` : ''}{x.reason ? ` · ${x.reason}` : ''}</span>
              <span className="muted">set by {x.set_by_name || 'someone'}</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => saveException(x.user_id, { mode: null })}>Remove</button>
            </div>
          ))}
          <div className="row wrap" style={{ gap: 6 }}>
            <select className="select" style={{ width: 'auto' }} aria-label="Person" value={exception.user_id} onChange={(e) => setException({ ...exception, user_id: e.target.value })}>
              <option value="">Person…</option>{people.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
            <select className="select" style={{ width: 'auto' }} aria-label="Exception" value={exception.mode} onChange={(e) => setException({ ...exception, mode: e.target.value })}>
              <option value="SKIP">Skip</option><option value="INCLUDE">Include on off days</option>
            </select>
            <input className="input" type="date" aria-label="Until" style={{ width: 'auto' }} value={exception.until} onChange={(e) => setException({ ...exception, until: e.target.value })} />
            <input className="input" aria-label="Reason" placeholder="Reason" style={{ maxWidth: 220 }} value={exception.reason} onChange={(e) => setException({ ...exception, reason: e.target.value })} />
            <button type="button" className="btn btn-sm" disabled={!exception.user_id} onClick={() => saveException(exception.user_id, { mode: exception.mode, until: exception.until || null, reason: exception.reason || null })}>Save</button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Record</h3>
          <input className="input" type="date" aria-label="Day" style={{ width: 'auto' }} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="card-pad">
          {!log ? <Spinner /> : log.length === 0 ? <div className="small muted">Nothing recorded for this day.</div> : (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Person</th><th>Result</th><th className="num">Items</th><th>Why</th><th>When</th></tr></thead>
                <tbody>{log.map((g) => {
                  const [label, tone] = DELIVERY[g.delivery] || [g.delivery, 'neutral'];
                  return (
                    <tr key={g.id}>
                      <td>{g.full_name}{g.test ? <> <Badge tone="warning">Test</Badge></> : null}</td>
                      <td><Badge tone={tone}>{label}</Badge></td>
                      <td className="num tnum">{g.items}</td>
                      <td className="small">{g.chat_error || g.reason || ''}</td>
                      <td className="small tnum">{exactTime(g.chat_sent_at || g.updated_at || g.created_at)}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      {preview && <Modal title={`${preview.user.name}: morning summary`} size="lg" onClose={() => setPreview(null)}><DigestPreview preview={preview} /></Modal>}
    </div>
  );
}
