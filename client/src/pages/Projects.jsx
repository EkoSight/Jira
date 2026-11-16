/**
 * Projects: each department's projects, who leads them, how far along they
 * are, whether they are on track (from the tasks, and in the lead's own
 * words), what is next and what is overdue.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, Modal, Spinner } from '../components/ui.jsx';
import {
  HEALTH_LABEL, HEALTH_TONE, STATUS_LABEL, STATUS_TONE, byDepartment, dateWords, progressWords,
} from '../lib/projects.js';

/** The two signals, side by side and labelled: from the tasks, and the lead's own word. */
export function HealthSignals({ numbers, compact = false }) {
  const fromTasks = numbers?.health_from_tasks;
  const lead = numbers?.lead_update;
  return (
    <span className="row wrap" style={{ gap: 6 }}>
      {fromTasks && (
        <span title={fromTasks.why}>
          <Badge tone={HEALTH_TONE[fromTasks.code]}>{compact ? '' : 'From the tasks: '}{HEALTH_LABEL[fromTasks.code]}</Badge>
        </span>
      )}
      {lead && (
        <span title={lead.note}>
          <Badge tone={HEALTH_TONE[lead.health]}>Lead says: {HEALTH_LABEL[lead.health]}</Badge>
        </span>
      )}
    </span>
  );
}

export function ProgressBar({ numbers, label }) {
  const pct = numbers?.total ? numbers.progress : 0;
  const words = label || progressWords(numbers);
  return (
    <div className="pj-progress" role="img" aria-label={words}>
      <div className="pj-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The fields of a project, for creating and editing. */
export function ProjectForm({ value, onChange, isNew, canChooseDepartment }) {
  const { users, departments } = useRefData();
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const activeUsers = users.filter((u) => u.is_active !== false);
  return (
    <div className="stack">
      <label className="field"><span className="field-label">Name</span>
        <input className="input" value={value.name} maxLength={160} onChange={set('name')} placeholder="What the project is" autoFocus />
      </label>
      <label className="field"><span className="field-label">What done looks like (optional)</span>
        <textarea className="textarea" rows={3} value={value.done_looks_like || ''} maxLength={4000} onChange={set('done_looks_like')} placeholder="How everyone will know it is finished" />
      </label>
      <div className="grid-2">
        <label className="field"><span className="field-label">Department</span>
          <select className="select" value={value.department_id} onChange={set('department_id')} disabled={!canChooseDepartment}>
            {departments.filter((d) => d.is_active !== false).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {!canChooseDepartment && <span className="field-hint">Projects are created in your own department</span>}
        </label>
        <label className="field"><span className="field-label">Lead</span>
          <select className="select" value={value.lead_user_id} onChange={set('lead_user_id')}>
            {activeUsers.map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.department_name ? ` · ${u.department_name}` : ''}</option>)}
          </select>
          <span className="field-hint">The lead is always a member, and manages the project</span>
        </label>
        <label className="field"><span className="field-label">Start (optional)</span>
          <input className="input" type="date" value={value.start_date || ''} onChange={set('start_date')} />
        </label>
        <label className="field"><span className="field-label">Target date (optional)</span>
          <input className="input" type="date" value={value.target_date || ''} min={value.start_date || undefined} onChange={set('target_date')} />
        </label>
        {isNew && (
          <label className="field"><span className="field-label">Status</span>
            <select className="select" value={value.status} onChange={set('status')}>
              <option value="PLANNED">Planned</option>
              <option value="ACTIVE">Active</option>
            </select>
          </label>
        )}
        <label className="field"><span className="field-label">Who can see it</span>
          <select className="select" value={value.visibility} onChange={set('visibility')}>
            <option value="DEPARTMENT">Its department and members</option>
            <option value="EVERYONE">Everyone in the company</option>
          </select>
          <span className="field-hint">Members always see every task in the project</span>
        </label>
      </div>
    </div>
  );
}

const projectBody = (f) => ({
  name: f.name.trim(),
  done_looks_like: f.done_looks_like?.trim() || null,
  department_id: Number(f.department_id),
  lead_user_id: Number(f.lead_user_id),
  start_date: f.start_date || null,
  target_date: f.target_date || null,
  visibility: f.visibility,
  ...(f.status ? { status: f.status } : {}),
});
export { projectBody };

function NewProject({ onClose }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [f, setF] = useState({ name: '', done_looks_like: '', department_id: user.department_id || '', lead_user_id: user.id, start_date: '', target_date: '', status: 'ACTIVE', visibility: 'DEPARTMENT' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post('/projects', projectBody(f));
      toast.success('Project created');
      navigate(`/projects/${r.project.id}`);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Modal title="New project" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || f.name.trim().length < 3 || !f.department_id} onClick={save}>Create project</button></>}>
      <ProjectForm value={f} onChange={setF} isNew canChooseDepartment={can('project.manage.any')} />
    </Modal>
  );
}

function ProjectCard({ p }) {
  const n = p.numbers || {};
  return (
    <li>
      <Link className="pj-card" to={`/projects/${p.id}`}>
        <span className="row-between wrap" style={{ gap: 8 }}>
          <strong className="pj-name">{p.name}</strong>
          <span className="row wrap" style={{ gap: 6 }}>
            <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
            <HealthSignals numbers={n} compact />
          </span>
        </span>
        <span className="pj-meta">
          <span className="row" style={{ gap: 6 }}><Avatar name={p.lead_name} color={p.lead_color} size={20} userId={p.lead_user_id} /> {p.lead_name}{p.lead_active === false ? ' (inactive)' : ''}</span>
          {p.target_date && <span>Target {dateWords(p.target_date)}</span>}
          {n.next_milestone && <span>Next: {n.next_milestone.name}{n.next_milestone.target_date ? `, ${dateWords(n.next_milestone.target_date)}` : ''}</span>}
        </span>
        <ProgressBar numbers={n} />
        <span className="pj-meta">
          <span>{progressWords(n)}</span>
          {n.overdue > 0 && <span className="pj-overdue">{n.overdue} overdue</span>}
          {n.health_from_tasks && <span className="muted">{n.health_from_tasks.why}</span>}
        </span>
      </Link>
    </li>
  );
}

export default function Projects() {
  const { user, can } = useAuth();
  const { departments } = useRefData();
  const [params, setParams] = useSearchParams();
  const mine = params.get('mine') !== '0';
  const status = params.get('status') || 'open';
  const dept = params.get('department_id') || '';
  const search = params.get('search') || '';
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(search);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get('/projects', { mine: mine ? 'true' : undefined, status: status === 'all' ? undefined : status, department_id: dept || undefined, search: search || undefined })
      .then((data) => !cancelled && setState({ loading: false, error: null, data }))
      .catch((error) => !cancelled && setState({ loading: false, error, data: null }));
    return () => { cancelled = true; };
  }, [mine, status, dept, search]);

  const update = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === '' || v === null) next.delete(k); else next.set(k, v); }
    setParams(next, { replace: true });
  };
  const groups = useMemo(() => byDepartment(state.data?.projects || []), [state.data]);
  const d = state.data;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap" style={{ gap: 10 }}>
        <div>
          <h1 style={{ margin: 0 }}>Projects</h1>
          <div className="small muted">Each department&apos;s projects: who leads them, how far along they are, and what is next</div>
        </div>
        {d?.can_create && <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>New project</button>}
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        <div className="ws-tabs" role="group" aria-label="Whose projects" style={{ padding: 0 }}>
          <button type="button" className={`kind-chip${mine ? ' is-active' : ''}`} aria-pressed={mine} onClick={() => update({ mine: '' })}>Mine</button>
          <button type="button" className={`kind-chip${!mine ? ' is-active' : ''}`} aria-pressed={!mine} onClick={() => update({ mine: '0' })}>All I can see</button>
        </div>
        <select className="select" aria-label="Department" value={dept} onChange={(e) => update({ department_id: e.target.value })} style={{ maxWidth: 200 }}>
          <option value="">Every department</option>
          {departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select className="select" aria-label="Status" value={status} onChange={(e) => update({ status: e.target.value === 'open' ? '' : e.target.value })} style={{ maxWidth: 180 }}>
          <option value="open">Open (planned, active, on hold)</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="all">All</option>
        </select>
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); update({ search: draft.trim() }); }}>
          <input className="input" type="search" aria-label="Search projects" placeholder="Search projects" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ maxWidth: 200 }} />
        </form>
      </div>

      {state.loading && !d && <div className="card ws-state"><Spinner label="Loading projects" /></div>}
      {state.error && <div className="card ws-state" role="alert">{state.error.status === 404 ? 'Projects are switched off.' : `Could not load projects: ${state.error.message}`}</div>}
      {d && !groups.length && (
        <div className="card ws-state ws-empty">
          {mine ? 'You lead no projects, belong to none and have no tasks in one.' : 'No projects match.'}
          {d.can_create ? ' Create one to group the work that belongs together.' : ' Managers and above create projects.'}
          {mine && <> <button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ mine: '0' })}>See all I can see</button></>}
        </div>
      )}
      {groups.map((g) => (
        <section key={g.id} className="card pj-group" aria-labelledby={`pj-dept-${g.id}`}>
          <h2 id={`pj-dept-${g.id}`} className="pj-group-title"><span className="pj-dot" style={{ background: g.color }} aria-hidden="true" />{g.name} <span className="muted small">{g.projects.length}</span></h2>
          <ul className="pj-list">{g.projects.map((p) => <ProjectCard key={p.id} p={p} />)}</ul>
        </section>
      ))}
      {creating && <NewProject onClose={() => setCreating(false)} />}
      {user && !can('project.create') && !can('project.manage.any') && d && <div className="small muted">Managers and above create projects. A project&apos;s lead manages their own.</div>}
    </div>
  );
}
