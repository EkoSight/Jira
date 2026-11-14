/**
 * Applications to grants, programmes, challenges, awards, tenders and
 * schemes: a list (preparing, submitted and waiting, decided) and one
 * application's page. They are deals in their own pipeline, so their tasks,
 * meetings and history are the same records shown everywhere else.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Badge, Modal, Spinner } from '../components/ui.jsx';
import RemindMe from '../components/workspace/RemindMe.jsx';
import { OriginPanel } from '../components/workspace/OriginPanel.jsx';
import { useWidgetData } from '../components/workspace/Widgets.jsx';
import { whenWords } from '../lib/workspace.js';

const GROUPS = [['PREPARING', 'Preparing'], ['SUBMITTED', 'Submitted, waiting'], ['DECIDED', 'Decided']];
const DEADLINE_TONE = { PASSED: 'critical', TODAY: 'warning', OPEN: 'neutral', NONE: 'neutral' };
const today = () => new Date().toISOString().slice(0, 10);

function DeadlineInputs({ value, onChange }) {
  const exact = value.mode === 'exact';
  return (
    <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="field-label">Deadline</legend>
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="row small" style={{ gap: 6 }}><input type="radio" name="dl-mode" checked={value.mode === 'none'} onChange={() => onChange({ ...value, mode: 'none' })} />None yet</label>
        <label className="row small" style={{ gap: 6 }}><input type="radio" name="dl-mode" checked={value.mode === 'date'} onChange={() => onChange({ ...value, mode: 'date' })} />A date (no closing time given)</label>
        <label className="row small" style={{ gap: 6 }}><input type="radio" name="dl-mode" checked={exact} onChange={() => onChange({ ...value, mode: 'exact' })} />An exact closing time</label>
      </div>
      {value.mode === 'date' && <input className="input" type="date" aria-label="Deadline date" value={value.date || ''} onChange={(e) => onChange({ ...value, date: e.target.value })} />}
      {exact && (
        <div className="row wrap" style={{ gap: 8 }}>
          <input className="input" type="datetime-local" aria-label="Closing time, in the organiser's timezone" value={value.local || ''} onChange={(e) => onChange({ ...value, local: e.target.value })} />
          <input className="input" aria-label="The organiser's timezone" placeholder="e.g. Europe/London" value={value.tz || ''} onChange={(e) => onChange({ ...value, tz: e.target.value })} style={{ maxWidth: 220 }} />
        </div>
      )}
      {value.mode === 'date' && <span className="field-hint">Shown as &quot;Closing time not specified&quot;. TaskFlow never invents a time.</span>}
    </fieldset>
  );
}
const deadlineBody = (d) => (d.mode === 'date' ? { deadline_date: d.date || null } : d.mode === 'exact' ? { deadline_at_local: d.local || null, deadline_timezone: d.tz || null } : { deadline_date: null });

function NewApplication({ onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { users } = useRefData();
  const { user } = useAuth();
  const [f, setF] = useState({ name: '', organiser_name: '', application_type: 'GRANT', opportunity_url: '', owner_user_id: user.id, stage: 'preparing' });
  const [dl, setDl] = useState({ mode: 'date', date: '' });
  const [types, setTypes] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/applications', { limit: 1 }).then((r) => setTypes(r.types)).catch(() => {}); }, []);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post('/applications', { ...f, opportunity_url: f.opportunity_url || null, owner_user_id: Number(f.owner_user_id), ...deadlineBody(dl) });
      toast.success('Application added');
      navigate(`/applications/${r.application.id}`);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Modal title="New application" onClose={onClose} size="lg"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || f.name.length < 2 || f.organiser_name.length < 2} onClick={save}>Add application</button></>}>
      <div className="stack">
        <label className="field"><span className="field-label">What you are applying for</span><input className="input" value={f.name} maxLength={200} placeholder="Programme and year" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span className="field-label">Organising institution</span><input className="input" value={f.organiser_name} maxLength={200} onChange={(e) => setF({ ...f, organiser_name: e.target.value })} /></label>
        <div className="grid-2">
          <label className="field"><span className="field-label">Type</span>
            <select className="select" value={f.application_type} onChange={(e) => setF({ ...f, application_type: e.target.value })}>
              {Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">Owner</span>
            <select className="select" value={f.owner_user_id} onChange={(e) => setF({ ...f, owner_user_id: e.target.value })}>
              {users.filter((u) => u.is_active !== false).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span className="field-label">Link to the call (optional)</span><input className="input" type="url" value={f.opportunity_url} onChange={(e) => setF({ ...f, opportunity_url: e.target.value })} /></label>
        <DeadlineInputs value={dl} onChange={setDl} />
      </div>
    </Modal>
  );
}

export function ApplicationRow({ a, timezone }) {
  return (
    <li>
      <Link className="ws-row" to={`/applications/${a.id}`}>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="row wrap" style={{ gap: 6 }}>
            <Badge>{a.type_label}</Badge>
            {a.deadline && a.group === 'PREPARING' && <Badge tone={DEADLINE_TONE[a.deadline.words.state]}>{a.deadline.words.state === 'PASSED' ? 'Deadline passed' : a.deadline.words.text.split(' · ').pop()}</Badge>}
            {a.status_check && <Badge tone="warning">Check {whenWords({ date: a.status_check.date }, { timeZone: timezone })}</Badge>}
            <strong className="truncate">{a.name}</strong>
          </span>
          <span className="ws-reason" style={{ display: 'block' }}>
            {a.account_name} · {a.stage_name}
            {a.deadline ? ` · ${a.deadline.words.text}` : ' · No deadline recorded'}
            {a.submitted_on ? ` · Submitted ${String(a.submitted_on).slice(0, 10)}` : ''}
          </span>
        </span>
      </Link>
    </li>
  );
}

export default function Applications() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const group = params.get('group') || 'PREPARING';
  const scope = params.get('scope') === 'team' ? 'team' : 'mine';
  const [creating, setCreating] = useState(params.get('new') === '1');
  const state = useWidgetData(() => api.get('/applications', { scope, group }), [scope, group]);
  const d = state.data;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1 style={{ margin: 0 }}>Applications</h1>
          <div className="small muted">Grants, incubators, accelerators, challenges, awards, tenders and schemes</div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <select className="select" aria-label="Whose applications" value={scope} onChange={(e) => setParams({ group, scope: e.target.value })}>
            <option value="mine">Mine</option><option value="team">My team</option>
          </select>
          {can('crm.create') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>New application</button>}
        </div>
      </div>
      <div className="ws-tabs" role="group" aria-label="Applications by state" style={{ padding: 0 }}>
        {GROUPS.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={group === k} className={`kind-chip${group === k ? ' is-active' : ''}`} onClick={() => setParams({ group: k, scope })}>
            {label}{d ? ` · ${d.counts[k]}` : ''}
          </button>
        ))}
      </div>
      <section className="card">
        {state.loading && !d && <div className="ws-state"><Spinner label="Loading applications" /></div>}
        {state.error && <div className="ws-state" role="alert">{state.error.status === 404 || state.error.status === 403 ? 'Not available to you' : `Could not load this: ${state.error.message}`}</div>}
        {d && !d.applications.length && <div className="ws-state ws-empty">Nothing here.{can('crm.create') && group === 'PREPARING' ? ' Add an application to track its deadline and submission.' : ''}</div>}
        {d && <ul className="ws-list">{d.applications.map((a) => <ApplicationRow key={a.id} a={a} timezone={d.timezone} />)}</ul>}
      </section>
      {creating && <NewApplication onClose={() => setCreating(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- one application

function SubmitDialog({ app, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ submitted_on: today(), submitted_link: app.submitted_link || '', reference: app.reference || '', correction_reason: '' });
  const correcting = Boolean(app.submitted_on);
  const save = async () => {
    try {
      await api.post(`/applications/${app.id}/submitted`, { submitted_on: f.submitted_on, submitted_link: f.submitted_link || null, reference: f.reference || null, ...(correcting ? { correction_reason: f.correction_reason } : {}) });
      toast.success(correcting ? 'Submitted date corrected' : 'Marked submitted. Deadline reminders stop; the outcome is tracked from here');
      onDone();
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title={correcting ? 'Correct the submitted date' : 'Mark submitted'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={correcting && f.correction_reason.trim().length < 3}>{correcting ? 'Correct it' : 'Mark submitted'}</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Use the real date it went in. It stays open for the outcome; the status check counts from this date.</p>
        <label className="field"><span className="field-label">Submitted on</span><input className="input" type="date" max={today()} value={f.submitted_on} onChange={(e) => setF({ ...f, submitted_on: e.target.value })} /></label>
        <label className="field"><span className="field-label">Submitted document or link (optional)</span><input className="input" value={f.submitted_link} onChange={(e) => setF({ ...f, submitted_link: e.target.value })} /></label>
        <label className="field"><span className="field-label">Reference (optional)</span><input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
        {correcting && <label className="field"><span className="field-label">Why the date is being corrected</span><input className="input" value={f.correction_reason} onChange={(e) => setF({ ...f, correction_reason: e.target.value })} /></label>}
      </div>
    </Modal>
  );
}

function UpdateDialog({ app, kinds, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ kind: 'ACKNOWLEDGEMENT', happened_on: today(), summary: '', reference: '', next_check_on: '', result: 'SELECTED', onboarding_task_title: '' });
  const save = async () => {
    try {
      const r = await api.post(`/applications/${app.id}/updates`, {
        kind: f.kind, happened_on: f.happened_on, summary: f.summary || null, reference: f.reference || null,
        ...(f.kind === 'FOLLOW_UP_SENT' && f.next_check_on ? { next_check_on: f.next_check_on } : {}),
        ...(f.kind === 'OUTCOME' ? { result: f.result, onboarding_task_title: f.onboarding_task_title || null } : {}),
      });
      if (r.ask_next_check) toast.success(`Logged. The next status check is ${r.ask_next_check}; change it on the application if you need to`);
      else if (r.ask_next_action) toast.success('Logged. Now set the next action for this application');
      else toast.success('Logged');
      onDone(r);
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Log an update" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Log it</button></>}>
      <div className="stack">
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">What happened</legend>
          {Object.entries(kinds).map(([k, label]) => (
            <label key={k} className="row small" style={{ gap: 6 }}><input type="radio" name="kind" checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} />{label}</label>
          ))}
        </fieldset>
        <label className="field"><span className="field-label">On</span><input className="input" type="date" max={today()} value={f.happened_on} onChange={(e) => setF({ ...f, happened_on: e.target.value })} /></label>
        {f.kind === 'OUTCOME' && (
          <label className="field"><span className="field-label">Outcome</span>
            <select className="select" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
              <option value="SELECTED">Selected</option><option value="NOT_SELECTED">Not selected</option><option value="WITHDRAWN">Withdrawn</option>
            </select>
          </label>
        )}
        <label className="field"><span className="field-label">Summary{f.kind === 'OUTCOME' && f.result !== 'SELECTED' ? '' : ' (optional)'}</span><input className="input" value={f.summary} maxLength={2000} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
        {f.kind === 'ACKNOWLEDGEMENT' && <label className="field"><span className="field-label">Their reference (optional)</span><input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>}
        {f.kind === 'FOLLOW_UP_SENT' && <label className="field"><span className="field-label">Check again on (default: 7 days later)</span><input className="input" type="date" value={f.next_check_on} onChange={(e) => setF({ ...f, next_check_on: e.target.value })} /></label>}
        {f.kind === 'OUTCOME' && f.result === 'SELECTED' && <label className="field"><span className="field-label">Start an onboarding task (optional)</span><input className="input" value={f.onboarding_task_title} onChange={(e) => setF({ ...f, onboarding_task_title: e.target.value })} placeholder="e.g. Sign the programme agreement" /></label>}
        <p className="small muted" style={{ margin: 0 }}>An acknowledgement or a follow-up you sent is not a decision: the status check stays. Open tasks are never closed by an outcome.</p>
      </div>
    </Modal>
  );
}

export function ApplicationDetail() {
  const { id } = useParams();
  const toast = useToast();
  const [bump, setBump] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [round, setRound] = useState({ name: '', date: '' });
  const [edit, setEdit] = useState(null);
  const state = useWidgetData(() => api.get(`/applications/${id}`), [id, bump]);
  const d = state.data;
  const reload = () => setBump((b) => b + 1);
  if (state.loading && !d) return <Spinner label="Opening the application" />;
  if (state.error) return <div className="card card-pad" role="alert">{state.error.status === 404 || state.error.status === 403 ? 'This application is not available to you.' : state.error.message} <Link to="/applications">Back to applications</Link></div>;
  const a = d.application;
  const saveEdit = async () => {
    try {
      await api.patch(`/applications/${a.id}`, { expected_response_on: edit.expected_response_on || null, next_check_on: edit.next_check_on || null, opportunity_url: edit.opportunity_url || null });
      toast.success('Saved'); setEdit(null); reload();
    } catch (err) { toast.error(err); }
  };
  const addTask = async () => {
    try { await api.post(`/applications/${a.id}/tasks`, { title: taskTitle }); setTaskTitle(''); toast.success('Task added: it is on the board and in My tasks too'); reload(); } catch (err) { toast.error(err); }
  };
  const addRound = async () => {
    try { await api.post(`/applications/${a.id}/rounds`, { name: round.name, deadline_date: round.date || null }); setRound({ name: '', date: '' }); toast.success('Round added; the original deadline is kept'); reload(); } catch (err) { toast.error(err); }
  };
  const roundDone = async (r) => {
    try { await api.patch(`/applications/${a.id}/rounds/${r.id}`, { status: 'SUBMITTED', submitted_on: today() }); reload(); } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <div className="small"><Link className="crumb-link" to="/applications">Applications</Link></div>
          <h1 style={{ margin: 0 }}>{a.name}</h1>
          <div className="small muted">{a.account_name} · {a.type_label} · {a.stage_name} · Owner: {a.owner_name || 'nobody'}</div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          <RemindMe entityType="APPLICATION" entityId={a.id} />
          {d.can_edit && a.group !== 'DECIDED' && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog('submit')}>{a.submitted_on ? 'Correct submitted date' : 'Mark submitted'}</button>}
          {d.can_edit && <button type="button" className="btn btn-sm" onClick={() => setDialog('update')}>Log an update</button>}
          <Link className="btn btn-sm btn-ghost" to={`/accounts/${a.account_id}?deal=${a.id}`}>Open as a deal</Link>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card" aria-labelledby="app-dates">
          <div className="card-head"><h2 id="app-dates">Dates</h2>{d.can_edit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit({ expected_response_on: a.expected_response_on ? String(a.expected_response_on).slice(0, 10) : '', next_check_on: a.next_check_on ? String(a.next_check_on).slice(0, 10) : '', opportunity_url: a.opportunity_url || '' })}>Edit</button>}</div>
          <dl className="card-pad stack-sm" style={{ margin: 0 }}>
            <div><dt className="field-label">Deadline</dt><dd style={{ margin: 0 }}>{a.deadline ? <Badge tone={DEADLINE_TONE[a.deadline.words.state]}>{a.deadline.words.text}</Badge> : 'No deadline recorded'}</dd></div>
            <div><dt className="field-label">Submitted</dt><dd style={{ margin: 0 }}>{a.submitted_on ? `${String(a.submitted_on).slice(0, 10)}${a.reference ? ` · reference ${a.reference}` : ''}` : 'Not yet'}{a.submitted_link ? <> · <a href={a.submitted_link} target="_blank" rel="noreferrer">submitted document</a></> : null}</dd></div>
            <div><dt className="field-label">Acknowledged</dt><dd style={{ margin: 0 }}>{a.acknowledged_on ? String(a.acknowledged_on).slice(0, 10) : '—'}</dd></div>
            <div><dt className="field-label">Status check</dt><dd style={{ margin: 0 }}>{a.status_check ? `${whenWords({ date: a.status_check.date }, { timeZone: d.timezone })} (set by ${a.status_check.words})` : a.submitted_on ? 'None: an update was recorded' : 'After submission'}</dd></div>
            <div><dt className="field-label">Last update</dt><dd style={{ margin: 0 }}>{a.last_update_type ? `${a.last_update_type === 'RESPONSE' ? 'A response' : 'The outcome'} on ${String(a.last_update_at).slice(0, 10)}` : 'No update recorded'}</dd></div>
            {a.opportunity_url && <div><dt className="field-label">The call</dt><dd style={{ margin: 0 }}><a href={a.opportunity_url} target="_blank" rel="noreferrer">{a.opportunity_url}</a></dd></div>}
          </dl>
        </section>

        <section className="card" aria-labelledby="app-rounds">
          <div className="card-head"><h2 id="app-rounds">Rounds</h2></div>
          <div className="card-pad stack-sm">
            {!d.rounds.length && <div className="small muted">No further rounds. Each round keeps its own deadline; the original deadline is never overwritten.</div>}
            <ul className="ws-list">
              {d.rounds.map((r) => (
                <li key={r.id} className="ws-row ws-static">
                  <span className="grow"><strong>{r.name}</strong> <span className="ws-reason">{r.deadline ? r.deadline.words.text : 'No deadline'} · {r.status.toLowerCase()}</span></span>
                  {d.can_edit && r.status === 'OPEN' && <button type="button" className="btn btn-sm" onClick={() => roundDone(r)}>Mark this round submitted</button>}
                </li>
              ))}
            </ul>
            {d.can_edit && (
              <div className="row wrap" style={{ gap: 6 }}>
                <input className="input" aria-label="Round name" placeholder="e.g. Interview with the jury" value={round.name} onChange={(e) => setRound({ ...round, name: e.target.value })} />
                <input className="input" type="date" aria-label="Round deadline" value={round.date} onChange={(e) => setRound({ ...round, date: e.target.value })} />
                <button type="button" className="btn btn-sm" disabled={round.name.length < 2} onClick={addRound}>Add a round</button>
              </div>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="app-tasks">
          <div className="card-head"><h2 id="app-tasks">Tasks</h2></div>
          <div className="card-pad stack-sm">
            {!d.tasks.length && <div className="small muted">No tasks yet.</div>}
            <ul className="ws-list">
              {d.tasks.map((t) => (
                <li key={t.id}><Link className="ws-row" to={`/applications/${a.id}?task=${t.id}`}><span className="grow truncate"><span className="task-ref">{t.ref}</span> {t.title}</span><Badge tone={t.stage === 'done' ? 'good' : 'neutral'}>{t.status_name}</Badge></Link></li>
              ))}
            </ul>
            {d.can_edit && (
              <div className="row wrap" style={{ gap: 6 }}>
                <input className="input grow" aria-label="New task" placeholder="Add a task for this application" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
                <button type="button" className="btn btn-sm" disabled={taskTitle.length < 3} onClick={addTask}>Add task</button>
              </div>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="app-updates">
          <div className="card-head"><h2 id="app-updates">Updates and meetings</h2></div>
          <div className="card-pad stack-sm">
            {!d.updates.length && !d.meetings.length && <div className="small muted">No update recorded.</div>}
            <ul className="ws-list">
              {d.updates.map((u) => (
                <li key={`u${u.id}`} className="ws-row ws-static"><span className="grow"><strong>{d.update_kinds[u.kind]}</strong> <span className="ws-reason">{String(u.happened_on).slice(0, 10)}{u.summary ? ` · ${u.summary}` : ''}{u.by_name ? ` · ${u.by_name}` : ''}</span></span></li>
              ))}
              {d.meetings.map((m) => (
                <li key={`m${m.id}`}><Link className="ws-row" to={`/meetings?meeting=${m.id}`}><span className="grow">{m.title} <span className="ws-reason">{m.scheduled_at ? whenWords({ at: m.scheduled_at }, { timeZone: d.timezone }) : 'Time not confirmed'}</span></span></Link></li>
              ))}
            </ul>
            <Link className="btn btn-sm btn-ghost" to={`/meetings?new=1&opportunity_id=${a.id}`}>Add a meeting</Link>
          </div>
        </section>
      </div>

      <OriginPanel kind="application" id={a.id} canEdit={d.can_edit} accountId={a.account_id} />

      {dialog === 'submit' && <SubmitDialog app={a} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {dialog === 'update' && <UpdateDialog app={a} kinds={d.update_kinds} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {edit && (
        <Modal title="Dates and link" onClose={() => setEdit(null)}
          footer={<><button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={saveEdit}>Save</button></>}>
          <div className="stack">
            <label className="field"><span className="field-label">Response date the organiser gave (optional)</span><input className="input" type="date" value={edit.expected_response_on} onChange={(e) => setEdit({ ...edit, expected_response_on: e.target.value })} /></label>
            <label className="field"><span className="field-label">My next check date (optional)</span><input className="input" type="date" value={edit.next_check_on} onChange={(e) => setEdit({ ...edit, next_check_on: e.target.value })} /></label>
            <label className="field"><span className="field-label">Link to the call</span><input className="input" type="url" value={edit.opportunity_url} onChange={(e) => setEdit({ ...edit, opportunity_url: e.target.value })} /></label>
            <p className="small muted" style={{ margin: 0 }}>Either date replaces the 15-day status check. There is only ever one check.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
