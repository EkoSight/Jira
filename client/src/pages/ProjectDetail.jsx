/**
 * One project: what done looks like, both health signals, progress, its
 * milestones and tasks, the lead's updates, the people on it and what
 * happened. Every number comes from the tasks this person can see.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, Modal, Spinner } from '../components/ui.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { HealthSignals, ProgressBar, ProjectForm, projectBody } from './Projects.jsx';
import { ProjectLinksCard } from '../components/projects/ProjectLinks.jsx';
import {
  HEALTH_LABEL, HEALTH_TONE, OPEN_STATUSES, STATUS_LABEL, STATUS_TONE, activityWords, byMilestone, dateWords, progressWords,
} from '../lib/projects.js';
import { shortDateTime } from '../lib/workspace.js';

const TABS = [['overview', 'Overview'], ['tasks', 'Tasks'], ['milestones', 'Milestones'], ['updates', 'Updates'], ['people', 'People'], ['meetings', 'Meetings'], ['activity', 'Activity']];

function TaskRow({ t }) {
  return (
    <li>
      <Link className="ws-row" to={`?task=${t.id}`}>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="row wrap" style={{ gap: 6 }}>
            <span className="task-ref">{t.ref}</span>
            <strong className="truncate">{t.title}</strong>
          </span>
          <span className="ws-reason">
            {t.assignee_name || 'No owner'}{t.department_name ? ` · ${t.department_name}` : ''}{t.health?.text ? ` · ${t.health.label}` : ''}
          </span>
        </span>
        <Badge tone={t.stage === 'done' ? 'good' : t.health?.code === 'OVERDUE' ? 'critical' : 'neutral'}>{t.status_name}</Badge>
      </Link>
    </li>
  );
}

function OverviewTab({ page, setPage }) {
  const { project: p, numbers: n } = page;
  return (
    <div className="pj-overview">
      <section className="card stack-sm">
        <h2 className="ws-title">What done looks like</h2>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{p.done_looks_like || <span className="muted">Not written yet.</span>}</p>
      </section>
      <section className="card stack-sm">
        <h2 className="ws-title">How it is going</h2>
        {p.status !== 'ACTIVE' && <p className="small muted" style={{ margin: 0 }}>Health from the tasks is worked out for active projects. This one is {STATUS_LABEL[p.status].toLowerCase()}.</p>}
        {n.health_from_tasks && (
          <div className="pj-signal">
            <span className="field-label">From the tasks</span>
            <Badge tone={HEALTH_TONE[n.health_from_tasks.code]}>{HEALTH_LABEL[n.health_from_tasks.code]}</Badge>
            <span className="small">{n.health_from_tasks.why}</span>
          </div>
        )}
        <div className="pj-signal">
          <span className="field-label">Lead&apos;s update</span>
          {n.lead_update ? (
            <>
              <Badge tone={HEALTH_TONE[n.lead_update.health]}>{HEALTH_LABEL[n.lead_update.health]}</Badge>
              <span className="small">{n.lead_update.note} <span className="muted">— {n.lead_update.author_name}, {shortDateTime(n.lead_update.at)}</span></span>
            </>
          ) : <span className="small muted">No update yet</span>}
        </div>
      </section>
      <section className="card stack-sm">
        <h2 className="ws-title">Progress</h2>
        <ProgressBar numbers={n} />
        <div className="small">{progressWords(n)}{n.overdue ? ` · ${n.overdue} overdue` : ''}{n.unassigned ? ` · ${n.unassigned} with no owner` : ''}</div>
        {n.next_milestone && <div className="small">Next milestone: <strong>{n.next_milestone.name}</strong>{n.next_milestone.target_date ? `, ${dateWords(n.next_milestone.target_date)}` : ''} ({n.next_milestone.open} open)</div>}
        <div className="small muted">Counted from the tasks you can see. Cancelled tasks are not counted.</div>
      </section>
      <ProjectLinksCard page={page} setPage={setPage} />
    </div>
  );
}

function MeetingsTab({ page }) {
  const meetings = page.links.meetings || [];
  return (
    <div className="stack">
      <div><Link className="btn btn-sm" to={`/meetings?new=1&project_id=${page.project.id}`}>Add a meeting to this project</Link></div>
      {!meetings.length && <div className="card ws-state ws-empty">No meetings in this project that you can see.</div>}
      {meetings.length > 0 && (
        <ul className="card ws-list">
          {meetings.map((m) => (
            <li key={m.id}>
              <Link className="ws-row" to={`/meetings?meeting=${m.id}`}>
                <span className="grow truncate">{m.title}</span>
                <span className="small muted">{m.scheduled_at ? shortDateTime(m.scheduled_at) : m.arrange_by ? `To arrange by ${dateWords(m.arrange_by)}` : ''}</span>
                <Badge>{String(m.status).toLowerCase().replace(/_/g, ' ')}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddExisting({ projectId, onClose, onDone }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [found, setFound] = useState([]);
  const [chosen, setChosen] = useState([]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.tasks({ project_id: 'none', open: 'true', search: search || undefined, limit: 50 }).then((r) => setFound(r.tasks.filter((x) => !x.parent_task_id))).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  const save = async () => {
    try {
      const r = await api.post(`/projects/${projectId}/tasks`, { task_ids: chosen });
      toast.success(`${r.moved.length} task${r.moved.length === 1 ? '' : 's'} added${r.subtasks ? `, with ${r.subtasks} subtask${r.subtasks === 1 ? '' : 's'}` : ''}`);
      onDone();
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Add existing tasks" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!chosen.length} onClick={save}>Add {chosen.length || ''}</button></>}>
      <div className="stack">
        <input className="input" type="search" aria-label="Find tasks in no project" placeholder="Find open tasks in no project" value={search} onChange={(e) => setSearch(e.target.value)} />
        <p className="small muted" style={{ margin: 0 }}>Subtasks come with their parent. Only tasks you can edit can be moved.</p>
        <ul className="pj-pick">
          {found.map((t) => (
            <li key={t.id}>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, t.id] : c.filter((x) => x !== t.id)))} />
                <span className="task-ref">{t.ref}</span> <span className="truncate">{t.title}</span>
              </label>
            </li>
          ))}
          {!found.length && <li className="small muted">No open tasks in no project match.</li>}
        </ul>
      </div>
    </Modal>
  );
}

function TasksTab({ page, reload }) {
  const { project: p, numbers: n, can_add_tasks: canAdd, can_manage: canManage } = page;
  const [tasks, setTasks] = useState(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => { api.tasks({ project_id: p.id, limit: 1000 }).then((r) => setTasks(r.tasks)).catch(() => setTasks([])); }, [p.id]);
  useEffect(load, [load]);
  const groups = useMemo(() => byMilestone((tasks || []).filter((t) => t.stage !== 'cancelled'), n.milestones), [tasks, n.milestones]);
  const cancelled = (tasks || []).filter((t) => t.stage === 'cancelled');
  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 8 }}>
        {canAdd && <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>New task in this project</button>}
        {canAdd && <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>Add existing tasks</button>}
        <Link className="btn btn-ghost btn-sm" to={`/board?project_id=${p.id}`}>Open on the board</Link>
        {!OPEN_STATUSES.includes(p.status) && <span className="small muted">This project is {STATUS_LABEL[p.status].toLowerCase()}: reopen it to add tasks.</span>}
      </div>
      {!tasks && <div className="card ws-state"><Spinner label="Loading tasks" /></div>}
      {tasks && !tasks.length && <div className="card ws-state ws-empty">No tasks you can see are in this project yet.</div>}
      {groups.map((g) => (
        <section key={g.id ?? 'none'} className="card pj-taskgroup" aria-label={g.name}>
          <h2 className="ws-title row-between">
            <span>{g.name}{g.target_date ? <span className="muted small"> · {dateWords(g.target_date)}</span> : ''}{g.reached_at ? <> <Badge tone="good">Reached</Badge></> : ''}</span>
            <span className="small muted">{g.tasks.filter((t) => t.stage === 'done').length} of {g.tasks.length} done</span>
          </h2>
          <ul className="ws-list">{g.tasks.map((t) => <TaskRow key={t.id} t={t} />)}</ul>
        </section>
      ))}
      {cancelled.length > 0 && <div className="small muted">{cancelled.length} cancelled task{cancelled.length === 1 ? '' : 's'} not counted.</div>}
      {creating && (
        <TaskDialog
          defaults={{ project_id: p.id, department_id: p.department_id }}
          onClose={() => { setCreating(false); load(); reload(); }}
          onSaved={() => { load(); reload(); }}
        />
      )}
      {adding && <AddExisting projectId={p.id} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); reload(); }} />}
      {canManage && <p className="small muted" style={{ margin: 0 }}>To take a task out, open it and choose No project.</p>}
    </div>
  );
}

function MilestonesTab({ page, setPage }) {
  const toast = useToast();
  const { project: p, numbers: n, can_manage: canManage } = page;
  const [draft, setDraft] = useState({ name: '', target_date: '' });
  const act = async (fn) => { try { setPage(await fn()); } catch (err) { toast.error(err); } };
  return (
    <div className="stack">
      {!n.milestones.length && <div className="card ws-state ws-empty">No milestones yet.{canManage ? ' Add dated checkpoints to see how each part is going.' : ''}</div>}
      {n.milestones.length > 0 && (
        <ul className="card ws-list">
          {n.milestones.map((m) => (
            <li key={m.id} className="pj-milestone">
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="row wrap" style={{ gap: 6 }}>
                  <strong>{m.name}</strong>
                  {m.target_date && <span className="small muted">{dateWords(m.target_date)}</span>}
                  {m.reached_at && <Badge tone="good">Reached</Badge>}
                </span>
                <ProgressBar numbers={m.stats} />
                <span className="small">{progressWords(m.stats)}{m.stats.overdue ? ` · ${m.stats.overdue} overdue` : ''}{!m.reached_at && m.stats.total && m.stats.done === m.stats.total ? ' · all its tasks are done: mark it reached?' : ''}</span>
              </span>
              {canManage && (
                <span className="row wrap" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-sm" onClick={() => act(() => api.patch(`/projects/${p.id}/milestones/${m.id}`, { reached: !m.reached_at }))}>{m.reached_at ? 'Reopen' : 'Mark reached'}</button>
                  <ConfirmButton label="Remove" confirmLabel="Remove milestone" className="btn btn-ghost btn-sm" onConfirm={() => act(() => api.del(`/projects/${p.id}/milestones/${m.id}`))} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form className="card row wrap" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); act(async () => { const r = await api.post(`/projects/${p.id}/milestones`, { name: draft.name.trim(), target_date: draft.target_date || null }); setDraft({ name: '', target_date: '' }); return r; }); }}>
          <input className="input grow" aria-label="New milestone" placeholder="New milestone" value={draft.name} maxLength={160} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="input" type="date" aria-label="Its date" value={draft.target_date} onChange={(e) => setDraft({ ...draft, target_date: e.target.value })} style={{ maxWidth: 170 }} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={draft.name.trim().length < 2}>Add milestone</button>
        </form>
      )}
      <p className="small muted" style={{ margin: 0 }}>A milestone is reached when the lead marks it, never by itself. Removing one keeps its tasks, without it.</p>
    </div>
  );
}

function UpdatesTab({ page, setPage }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const { project: p } = page;
  const mayPost = p.lead_user_id === user.id || can('project.manage.any');
  const [f, setF] = useState({ health: 'ON_TRACK', note: '' });
  const post = async () => {
    try { setPage(await api.post(`/projects/${p.id}/updates`, f)); setF({ health: f.health, note: '' }); toast.success('Update posted'); } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack">
      {mayPost && (
        <section className="card stack-sm">
          <h2 className="ws-title">Post an update</h2>
          <fieldset className="row wrap" style={{ gap: 12, border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">How it is going, in your words</legend>
            {Object.entries(HEALTH_LABEL).map(([k, v]) => (
              <label key={k} className="row small" style={{ gap: 6 }}><input type="radio" name="pj-health" checked={f.health === k} onChange={() => setF({ ...f, health: k })} />{v}</label>
            ))}
          </fieldset>
          <textarea className="textarea" rows={3} aria-label="What is happening" placeholder="What is happening, and what is next" value={f.note} maxLength={4000} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <div><button type="button" className="btn btn-primary btn-sm" disabled={f.note.trim().length < 3} onClick={post}>Post update</button></div>
        </section>
      )}
      {!page.updates.length && <div className="card ws-state ws-empty">No updates yet.{mayPost ? '' : ' The lead posts them.'}</div>}
      {page.updates.length > 0 && (
        <ul className="card ws-list">
          {page.updates.map((u) => (
            <li key={u.id} className="pj-update">
              <Badge tone={HEALTH_TONE[u.health]}>{HEALTH_LABEL[u.health]}</Badge>
              <span className="grow" style={{ whiteSpace: 'pre-wrap' }}>{u.note}</span>
              <span className="small muted">{u.author_name}, {shortDateTime(u.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PeopleTab({ page, setPage }) {
  const toast = useToast();
  const { users } = useRefData();
  const { project: p, can_manage: canManage } = page;
  const [adding, setAdding] = useState('');
  const memberIds = new Set(page.members.map((m) => m.id));
  const act = async (fn) => { try { setPage(await fn()); } catch (err) { toast.error(err); } };
  return (
    <div className="pj-overview">
      <section className="card stack-sm">
        <h2 className="ws-title">Members <span className="muted small">{page.members.length}</span></h2>
        <p className="small muted" style={{ margin: 0 }}>Members see every task in the project, whichever department it is in.</p>
        <ul className="ws-list">
          {page.members.map((m) => (
            <li key={m.id} className="row-between" style={{ gap: 8, padding: '6px 0' }}>
              <span className="row" style={{ gap: 8 }}><Avatar name={m.full_name} color={m.avatar_color} size={24} userId={m.id} /> {m.full_name}{m.is_lead ? <Badge tone="brand">Lead</Badge> : ''}<span className="small muted">{m.department_name}</span></span>
              {canManage && !m.is_lead && <ConfirmButton label="Remove" confirmLabel={`Remove ${m.full_name}`} className="btn btn-ghost btn-sm" onConfirm={() => act(() => api.del(`/projects/${p.id}/members/${m.id}`))} />}
            </li>
          ))}
        </ul>
        {canManage && (
          <div className="row" style={{ gap: 8 }}>
            <select className="select" aria-label="Add a member" value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Add a member…</option>
              {users.filter((u) => u.is_active !== false && !memberIds.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.department_name ? ` · ${u.department_name}` : ''}</option>)}
            </select>
            <button type="button" className="btn btn-sm" disabled={!adding} onClick={() => act(async () => { const r = await api.post(`/projects/${p.id}/members`, { user_id: Number(adding) }); setAdding(''); return r; })}>Add</button>
          </div>
        )}
      </section>
      <section className="card stack-sm">
        <h2 className="ws-title">Work in it, by person</h2>
        {!page.contributors.length && <div className="small muted">Nobody owns a task in it yet.</div>}
        {page.contributors.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Person</th><th scope="col">Open</th><th scope="col">Overdue</th><th scope="col">Done</th></tr></thead>
              <tbody>
                {page.contributors.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/board?project_id=${p.id}&assignee_id=${c.id}`}>{c.full_name}</Link></td>
                    <td>{c.open}</td><td>{c.overdue ? <span className="pj-overdue">{c.overdue}</span> : 0}</td><td>{c.done}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ActivityTab({ projectId }) {
  const { users } = useRefData();
  const people = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.full_name])), [users]);
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get(`/projects/${projectId}/activity`).then((r) => setRows(r.activity)).catch(() => setRows([])); }, [projectId]);
  if (!rows) return <div className="card ws-state"><Spinner label="Loading activity" /></div>;
  if (!rows.length) return <div className="card ws-state ws-empty">Nothing yet.</div>;
  return (
    <ul className="card ws-list">
      {rows.map((a) => (
        <li key={a.id} className="pj-activity">
          <span className="small muted">{shortDateTime(a.created_at)}</span>
          <span className="grow"><strong>{a.actor_name || 'TaskFlow'}</strong> {activityWords(a, people)}{a.task_label ? <>: <Link to={`?task=${a.task_id}`}>{a.task_label}</Link></> : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/** Completing or cancelling with open tasks: the person chooses for each one. */
function CloseProject({ page, status, openTasks, onClose, onDone }) {
  const toast = useToast();
  const [options, setOptions] = useState([]);
  const [choices, setChoices] = useState(() => Object.fromEntries(openTasks.map((t) => [t.id, { action: 'KEEP', to: '' }])));
  useEffect(() => { api.get('/projects/options').then((r) => setOptions(r.projects.filter((x) => x.id !== page.project.id))).catch(() => {}); }, [page.project.id]);
  const save = async () => {
    try {
      const open_task_actions = openTasks.map((t) => ({ task_id: t.id, action: choices[t.id].action, ...(choices[t.id].action === 'MOVE' ? { to_project_id: Number(choices[t.id].to) } : {}) }));
      onDone(await api.patch(`/projects/${page.project.id}`, { status, open_task_actions }));
      toast.success(`Project ${STATUS_LABEL[status].toLowerCase()}`);
    } catch (err) { toast.error(err); }
  };
  const incomplete = openTasks.some((t) => choices[t.id].action === 'MOVE' && !choices[t.id].to);
  return (
    <Modal title={`${status === 'COMPLETED' ? 'Complete' : 'Cancel'} the project`} onClose={onClose} size="lg"
      footer={<><button type="button" className="btn" onClick={onClose}>Back</button><button type="button" className="btn btn-primary" disabled={incomplete} onClick={save}>{status === 'COMPLETED' ? 'Complete project' : 'Cancel project'}</button></>}>
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>{openTasks.length} task{openTasks.length === 1 ? ' is' : 's are'} still open. Choose what happens to each. Nothing is closed or cancelled for you: tasks keep their owners and deadlines.</p>
        <ul className="pj-pick">
          {openTasks.map((t) => (
            <li key={t.id} className="stack-sm">
              <span><span className="task-ref">{t.ref}</span> {t.title}</span>
              <span className="row wrap" style={{ gap: 8 }}>
                <select className="select" aria-label={`What happens to ${t.ref}`} value={choices[t.id].action} onChange={(e) => setChoices({ ...choices, [t.id]: { ...choices[t.id], action: e.target.value } })} style={{ maxWidth: 260 }}>
                  <option value="KEEP">Keep it open, in this project</option>
                  <option value="MOVE">Move it to another project</option>
                  <option value="REMOVE">Take it out of the project</option>
                </select>
                {choices[t.id].action === 'MOVE' && (
                  <select className="select" aria-label={`Project for ${t.ref}`} value={choices[t.id].to} onChange={(e) => setChoices({ ...choices, [t.id]: { ...choices[t.id], to: e.target.value } })} style={{ maxWidth: 260 }}>
                    <option value="">Choose a project…</option>
                    {options.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.department_name}</option>)}
                  </select>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** On hold: nothing changes on its own; the open tasks are listed to reschedule through the normal flow. */
function OnHoldPanel({ projectId }) {
  const [tasks, setTasks] = useState(null);
  useEffect(() => { api.get(`/projects/${projectId}/open-tasks`).then((r) => setTasks(r.tasks)).catch(() => setTasks([])); }, [projectId]);
  if (!tasks?.length) return null;
  return (
    <section className="card stack-sm" aria-label="Open tasks while on hold">
      <h2 className="ws-title">On hold: its open tasks keep their deadlines</h2>
      <p className="small muted" style={{ margin: 0 }}>Putting a project on hold pauses nothing by itself. Open a task to move its deadline through the usual change, with a reason.</p>
      <ul className="ws-list">{tasks.map((t) => <TaskRow key={t.id} t={{ ...t, status_name: t.health?.text || 'Open' }} />)}</ul>
    </section>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const [state, setState] = useState({ loading: true, error: null, page: null });
  const [editing, setEditing] = useState(null);
  const [closing, setClosing] = useState(null);

  const load = useCallback(() => {
    api.get(`/projects/${id}`).then((page) => setState({ loading: false, error: null, page })).catch((error) => setState({ loading: false, error, page: null }));
  }, [id]);
  useEffect(load, [load]);
  const setPage = (page) => setState((s) => ({ ...s, page }));

  if (state.loading) return <div className="card ws-state"><Spinner label="Loading the project" /></div>;
  if (state.error) {
    return (
      <div className="card ws-state" role="alert">
        {state.error.status === 404 ? 'This project is not available to you.' : `Could not load it: ${state.error.message}`} <Link to="/projects">Back to projects</Link>
      </div>
    );
  }
  const page = state.page;
  const { project: p, numbers: n, can_manage: canManage } = page;

  const changeStatus = async (status) => {
    try {
      setPage(await api.patch(`/projects/${p.id}`, { status }));
      toast.success(`Project is now ${STATUS_LABEL[status].toLowerCase()}`);
    } catch (err) {
      if (err.status === 409 && err.details?.code === 'OPEN_TASKS') setClosing({ status, openTasks: err.details.open_tasks });
      else toast.error(err);
    }
  };
  const saveEdit = async () => {
    try { setPage(await api.patch(`/projects/${p.id}`, projectBody(editing))); setEditing(null); toast.success('Saved'); } catch (err) { toast.error(err); }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="stack-sm">
        <Link to="/projects" className="small">← Projects</Link>
        <div className="row-between wrap" style={{ gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0 }}>{p.name}</h1>
            <div className="row wrap small" style={{ gap: 8, marginTop: 4 }}>
              <Badge dot={p.department_color}>{p.department_name}</Badge>
              <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
              <span className="row" style={{ gap: 6 }}><Avatar name={p.lead_name} color={p.lead_color} size={20} userId={p.lead_user_id} /> Lead: {p.lead_name}{p.lead_active === false ? ' (inactive)' : ''}</span>
              {(p.start_date || p.target_date) && <span className="muted">{p.start_date ? dateWords(p.start_date) : '…'} → {p.target_date ? dateWords(p.target_date) : 'no target date'}</span>}
              {p.visibility === 'EVERYONE' && <span className="muted">Visible to everyone</span>}
            </div>
          </div>
          {canManage && (
            <div className="row" style={{ gap: 8, flex: 'none', alignItems: 'center' }}>
              <button type="button" className="btn btn-sm" onClick={() => setEditing({ ...p, done_looks_like: p.done_looks_like || '', start_date: p.start_date || '', target_date: p.target_date || '' })}>Edit</button>
              <select className="select select-sm" aria-label="Change status" value="" onChange={(e) => e.target.value && changeStatus(e.target.value)} style={{ maxWidth: 170 }}>
                <option value="">Change status…</option>
                {Object.entries(STATUS_LABEL).filter(([k]) => k !== p.status).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          )}
        </div>
        <ProgressBar numbers={n} />
        <div className="row wrap small" style={{ gap: 10 }}>
          <span>{progressWords(n)}</span>
          {n.overdue > 0 && <span className="pj-overdue">{n.overdue} overdue</span>}
          <HealthSignals numbers={n} />
        </div>
      </div>

      {p.status === 'ON_HOLD' && <OnHoldPanel projectId={p.id} />}

      <div className="ws-tabs" role="group" aria-label="Project sections" style={{ padding: 0 }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={`kind-chip${tab === k ? ' is-active' : ''}`} aria-pressed={tab === k} onClick={() => setParams(k === 'overview' ? {} : { tab: k }, { replace: true })}>{label}</button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab page={page} setPage={setPage} />}
      {tab === 'tasks' && <TasksTab page={page} reload={load} />}
      {tab === 'milestones' && <MilestonesTab page={page} setPage={setPage} />}
      {tab === 'updates' && <UpdatesTab page={page} setPage={setPage} />}
      {tab === 'people' && <PeopleTab page={page} setPage={setPage} />}
      {tab === 'meetings' && <MeetingsTab page={page} />}
      {tab === 'activity' && <ActivityTab projectId={p.id} />}

      {editing && (
        <Modal title="Edit project" onClose={() => setEditing(null)}
          footer={<><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={editing.name.trim().length < 3} onClick={saveEdit}>Save</button></>}>
          <ProjectForm value={editing} onChange={setEditing} canChooseDepartment={can('project.manage.any')} />
        </Modal>
      )}
      {closing && <CloseProject page={page} status={closing.status} openTasks={closing.openTasks} onClose={() => setClosing(null)} onDone={(pg) => { setPage(pg); setClosing(null); }} />}
    </div>
  );
}
