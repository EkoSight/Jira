/**
 * My meetings: confirmed and coming, still to arrange (or a time proposed),
 * and past ones with no outcome. A meeting still to arrange is never shown as
 * a booked event. Nothing here sends an invitation or touches a calendar.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Badge, Modal, Spinner } from '../components/ui.jsx';
import RemindMe from '../components/workspace/RemindMe.jsx';
import { useWidgetData } from '../components/workspace/Widgets.jsx';
import { whenWords } from '../lib/workspace.js';

const iso = (local) => (local ? new Date(local).toISOString() : null);

function NewMeeting({ onClose, onDone, defaults = {} }) {
  const toast = useToast();
  const { users } = useRefData();
  const { user } = useAuth();
  const [f, setF] = useState({ title: '', objective: '', confirmed: false, when: '', arrange_by: '', location: '', meeting_url: '', participants: [] });
  const save = async () => {
    try {
      await api.post('/workspace/meetings', {
        title: f.title, objective: f.objective || null,
        status: f.confirmed ? 'SCHEDULED' : 'TO_ARRANGE',
        scheduled_at: f.confirmed ? iso(f.when) : null,
        arrange_by: f.confirmed ? null : (f.arrange_by || null),
        location: f.location || null, meeting_url: f.meeting_url || null,
        participant_user_ids: f.participants.map(Number),
        ...(defaults.opportunity_id ? { opportunity_id: Number(defaults.opportunity_id) } : {}),
        ...(defaults.lead_id ? { lead_id: Number(defaults.lead_id) } : {}),
      });
      toast.success('Meeting added. No invitation was sent to anyone');
      onDone();
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="New meeting" onClose={onClose} size="lg"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={f.title.length < 2 || (f.confirmed && !f.when)} onClick={save}>Add meeting</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>This is a TaskFlow record. It sends no invitation and adds nothing to a calendar.</p>
        <label className="field"><span className="field-label">What it is about</span><input className="input" maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field"><span className="field-label">Purpose (optional)</span><input className="input" maxLength={500} value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} /></label>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Time</legend>
          <label className="row small" style={{ gap: 6 }}><input type="radio" name="confirmed" checked={!f.confirmed} onChange={() => setF({ ...f, confirmed: false })} />Still to arrange</label>
          <label className="row small" style={{ gap: 6 }}><input type="radio" name="confirmed" checked={f.confirmed} onChange={() => setF({ ...f, confirmed: true })} />Confirmed time</label>
        </fieldset>
        {f.confirmed
          ? <label className="field"><span className="field-label">Date and time (your timezone)</span><input className="input" type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></label>
          : <label className="field"><span className="field-label">Arrange it by (optional)</span><input className="input" type="date" value={f.arrange_by} onChange={(e) => setF({ ...f, arrange_by: e.target.value })} /></label>}
        <div className="grid-2">
          <label className="field"><span className="field-label">Place (optional)</span><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
          <label className="field"><span className="field-label">Online link (optional)</span><input className="input" value={f.meeting_url} onChange={(e) => setF({ ...f, meeting_url: e.target.value })} /></label>
        </div>
        <label className="field"><span className="field-label">Colleagues taking part</span>
          <select className="select" multiple size={5} value={f.participants} onChange={(e) => setF({ ...f, participants: [...e.target.selectedOptions].map((o) => o.value) })}>
            {users.filter((u) => u.id !== user.id && u.is_active !== false).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </label>
      </div>
    </Modal>
  );
}

function Act({ meeting, onClose, onDone }) {
  const toast = useToast();
  const [when, setWhen] = useState('');
  const [text, setText] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [mode, setMode] = useState(meeting.unconfirmed ? 'confirm' : meeting.awaiting_outcome ? 'outcome' : 'reschedule');
  const go = async () => {
    try {
      if (mode === 'confirm') await api.post(`/workspace/meetings/${meeting.id}/confirm`, { scheduled_at: iso(when) });
      if (mode === 'propose') await api.post(`/workspace/meetings/${meeting.id}/propose`, { proposed_at: iso(when) });
      if (mode === 'reschedule') await api.post(`/workspace/meetings/${meeting.id}/reschedule`, { scheduled_at: iso(when), reason: text || null });
      if (mode === 'cancel') await api.post(`/workspace/meetings/${meeting.id}/cancel`, { reason: text });
      if (mode === 'outcome') await api.post(`/workspace/meetings/${meeting.id}/outcome`, { status: 'COMPLETED', outcome: text, follow_up_title: followUp || null });
      if (mode === 'no_show') await api.post(`/workspace/meetings/${meeting.id}/outcome`, { status: 'NO_SHOW', outcome: text || null });
      toast.success('Saved');
      onDone();
    } catch (err) { toast.error(err); }
  };
  const modes = meeting.unconfirmed
    ? [['confirm', 'Confirm a time'], ['propose', 'A time was proposed'], ['cancel', 'Cancel it']]
    : meeting.awaiting_outcome ? [['outcome', 'It took place'], ['no_show', 'They did not come'], ['cancel', 'It was cancelled']]
      : [['reschedule', 'Move it'], ['cancel', 'Cancel it']];
  const needsTime = ['confirm', 'propose', 'reschedule'].includes(mode);
  return (
    <Modal title={meeting.title} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn btn-primary" disabled={(needsTime && !when) || (['cancel', 'outcome'].includes(mode) && text.trim().length < 3)} onClick={go}>Save</button></>}>
      <div className="stack">
        <div className="row wrap" role="radiogroup" aria-label="What to do" style={{ gap: 12 }}>
          {modes.map(([k, label]) => <label key={k} className="row small" style={{ gap: 6 }}><input type="radio" name="act" checked={mode === k} onChange={() => setMode(k)} />{label}</label>)}
        </div>
        {needsTime && <label className="field"><span className="field-label">{mode === 'propose' ? 'Proposed time' : 'Date and time'}</span><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>}
        {['cancel', 'reschedule', 'outcome', 'no_show'].includes(mode) && (
          <label className="field"><span className="field-label">{mode === 'outcome' ? 'What came of it' : mode === 'cancel' ? 'Why it is cancelled' : 'Note (optional)'}</span><input className="input" value={text} onChange={(e) => setText(e.target.value)} /></label>
        )}
        {mode === 'outcome' && <label className="field"><span className="field-label">Next action, as a task for you (optional)</span><input className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="Only what you write is recorded" /></label>}
      </div>
    </Modal>
  );
}

function MeetingRow({ m, tz, onAct }) {
  return (
    <li className="ws-att" id={`meeting-${m.id}`}>
      <div className="ws-row ws-static">
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="row wrap" style={{ gap: 6 }}>
            {m.status === 'TO_ARRANGE' && <Badge tone="warning">To arrange</Badge>}
            {m.status === 'TIME_PROPOSED' && <Badge tone="warning">Time proposed, not confirmed</Badge>}
            {m.awaiting_outcome && <Badge tone="critical">No outcome recorded</Badge>}
            <strong className="truncate">{m.title}</strong>
          </span>
          <span className="ws-reason" style={{ display: 'block' }}>
            {m.scheduled_at ? `${whenWords({ at: m.scheduled_at }, { timeZone: tz })}${m.timezone && m.timezone !== tz ? ` (${m.timezone})` : ''}` : m.arrange_by ? `Arrange by ${whenWords({ date: String(m.arrange_by).slice(0, 10) }, { timeZone: tz })}` : 'No time yet'}
            {` · ${m.account_name || m.opportunity_name || m.lead_name || 'Internal'}`}
            {m.objective ? ` · ${m.objective}` : ''}
            {m.meeting_url || m.location ? ` · ${m.meeting_url || m.location}` : ''}
          </span>
        </span>
      </div>
      <RemindMe entityType="MEETING" entityId={m.id} label="Remind me" />
      <button type="button" className="btn btn-sm ws-snooze" onClick={() => onAct(m)}>{m.unconfirmed ? 'Arrange' : m.awaiting_outcome ? 'Record outcome' : 'Change'}<span className="sr-only"> {m.title}</span></button>
    </li>
  );
}

export default function Meetings() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [acting, setActing] = useState(null);
  const [bump, setBump] = useState(0);
  const focused = useRef(false);
  const state = useWidgetData(() => api.get('/workspace/meetings'), [bump]);
  const d = state.data;
  const tz = user.timezone || 'Asia/Kolkata';
  useEffect(() => {
    const id = params.get('meeting');
    if (d && id && !focused.current) { focused.current = true; document.getElementById(`meeting-${id}`)?.scrollIntoView({ block: 'center' }); }
  }, [d, params]);
  const sections = d ? [
    ['Coming up', d.upcoming, 'No confirmed meetings coming up.'],
    ['To arrange', d.to_arrange, 'No meetings to arrange. Add a meeting when one is needed.'],
    ['Past, with no outcome recorded', d.awaiting_outcome, 'Every past meeting has its outcome.'],
  ] : [];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1 style={{ margin: 0 }}>Meetings</h1>
          <div className="small muted">{d?.note || 'Meetings are TaskFlow records. No invitation is sent.'}</div>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>New meeting</button>
      </div>
      {state.loading && !d && <Spinner label="Loading meetings" />}
      {state.error && <div className="card card-pad" role="alert">Could not load meetings: {state.error.message} <button type="button" className="btn btn-sm" onClick={state.retry}>Retry</button></div>}
      {sections.map(([title, list, empty]) => (
        <section key={title} className="card" aria-label={title}>
          <div className="card-head"><h2>{title} <span className="muted tnum">· {list.length}</span></h2></div>
          {!list.length ? <div className="ws-state ws-empty">{empty}</div> : (
            <ul className="ws-list">{list.map((m) => <MeetingRow key={m.id} m={m} tz={tz} onAct={setActing} />)}</ul>
          )}
        </section>
      ))}
      {creating && <NewMeeting defaults={{ opportunity_id: params.get('opportunity_id'), lead_id: params.get('lead_id') }} onClose={() => setCreating(false)} onDone={() => { setCreating(false); setBump((b) => b + 1); }} />}
      {acting && <Act meeting={acting} onClose={() => setActing(null)} onDone={() => { setActing(null); setBump((b) => b + 1); }} />}
    </div>
  );
}
