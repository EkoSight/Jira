/**
 * What a project is linked to, and the places other records show their
 * projects: the key results it supports (context only), the deal or
 * application it came from, the CRM's delivery record, and "Start a project"
 * on a won deal or selected application.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth, useRefData, useToast } from '../../state/AppState.jsx';
import { Badge, ConfirmButton, Modal, Spinner } from '../ui.jsx';
import { HealthSignals, ProgressBar, ProjectForm, projectBody } from '../../pages/Projects.jsx';
import { STATUS_LABEL, STATUS_TONE, dateWords, progressWords } from '../../lib/projects.js';

/** "Link this project's tasks to this key result": the before and after, then confirm. */
function LinkTasks({ projectId, kr, onClose, onDone }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [chosen, setChosen] = useState([]);
  useEffect(() => {
    api.get(`/projects/${projectId}/key-results/${kr.id}/link-tasks`).then((p) => { setPreview(p); setChosen(p.tasks.map((t) => t.id)); }).catch((err) => { toast.error(err); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, kr.id]);
  const save = async () => {
    try {
      const r = await api.post(`/projects/${projectId}/key-results/${kr.id}/link-tasks`, { task_ids: chosen });
      toast.success(`${r.linked} task${r.linked === 1 ? '' : 's'} linked to the key result`);
      onDone();
    } catch (err) { toast.error(err); }
  };
  const pct = (v) => (v === null || v === undefined ? 'not measured yet' : `${v}%`);
  // the after figure for exactly the ticked tasks
  const after = preview && (() => {
    const picked = preview.tasks.filter((t) => chosen.includes(t.id));
    const n = preview.before.linked_tasks + picked.length;
    const d = preview.before.done_tasks + picked.filter((t) => t.stage === 'done').length;
    const exec = n ? Math.round((d / n) * 100) : null;
    return { linked_tasks: n, done_tasks: d, progress: preview.measured_on_its_own ? preview.before.progress : exec };
  })();
  return (
    <Modal title="Link this project's tasks to a key result" onClose={onClose} size="lg"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!chosen.length} onClick={save}>Link {chosen.length} task{chosen.length === 1 ? '' : 's'}</button></>}>
      {!preview && <Spinner label="Working out the change" />}
      {preview && (
        <div className="stack">
          <p className="small" style={{ margin: 0 }}><strong>{preview.key_result.title}</strong> <span className="muted">· {preview.key_result.objective_title}</span></p>
          <div className="pj-compare" role="group" aria-label="Before and after">
            <div><span className="field-label">Now</span><div>{preview.before.linked_tasks} linked task{preview.before.linked_tasks === 1 ? '' : 's'}, {preview.before.done_tasks} done</div><div className="small">Progress: {pct(preview.before.progress)}</div></div>
            <div><span className="field-label">After</span><div>{after.linked_tasks} linked task{after.linked_tasks === 1 ? '' : 's'}, {after.done_tasks} done</div><div className="small">Progress: {pct(after.progress)}</div></div>
          </div>
          {preview.measured_on_its_own && <p className="small muted" style={{ margin: 0 }}>This key result is measured on its own terms, so its number does not change. Linking shows the work beside it.</p>}
          {!preview.tasks.length && <p className="small muted" style={{ margin: 0 }}>Every task you can see in this project is already linked.</p>}
          <ul className="pj-pick">
            {preview.tasks.map((t) => (
              <li key={t.id}>
                <label className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, t.id] : c.filter((x) => x !== t.id)))} />
                  <span className="task-ref">{t.ref}</span> <span className="truncate">{t.title}</span>{t.stage === 'done' && <Badge tone="good">Done</Badge>}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/** The links card on a project's overview. */
export function ProjectLinksCard({ page, setPage }) {
  const toast = useToast();
  const { can } = useAuth();
  const { project: p, links, can_manage: canManage } = page;
  const [adding, setAdding] = useState(false);
  const [krOptions, setKrOptions] = useState([]);
  const [krChoice, setKrChoice] = useState('');
  const [linking, setLinking] = useState(null);
  useEffect(() => {
    if (!adding) return;
    api.get('/key-results', { status: 'ACTIVE' }).then((r) => setKrOptions(r.key_results || [])).catch(() => setKrOptions([]));
  }, [adding]);
  const act = async (fn, words) => { try { setPage(await fn()); if (words) toast.success(words); } catch (err) { toast.error(err); } };
  const linkedIds = new Set(links.key_results.map((k) => k.id));
  const hasAnything = links.okr || links.origin || links.engagement;
  if (!hasAnything) return null;
  return (
    <section className="card stack-sm">
      <h2 className="ws-title">Linked to</h2>
      {links.okr && (
        <div className="stack-sm">
          <span className="field-label">Key results it supports</span>
          {!links.key_results.length && <span className="small muted">None yet.</span>}
          <ul className="ws-list">
            {links.key_results.map((k) => (
              <li key={k.id} className="row-between wrap" style={{ gap: 8, padding: '6px 0' }}>
                <span style={{ minWidth: 0 }}>
                  <Link to={`/goals/${k.objective_id}`}>{k.title}</Link>
                  <span className="small muted"> · {k.objective_title}{k.progress !== null && k.progress !== undefined ? ` · ${k.progress}%` : ''} · {k.project_tasks_linked} of this project&apos;s tasks linked</span>
                </span>
                <span className="row" style={{ gap: 6 }}>
                  {can('okr.link.task') && <button type="button" className="btn btn-sm" onClick={() => setLinking(k)}>Link tasks…</button>}
                  {canManage && <ConfirmButton label="Unlink" confirmLabel="Unlink key result" className="btn btn-ghost btn-sm" onConfirm={() => act(() => api.del(`/projects/${p.id}/key-results/${k.id}`), 'Unlinked')} />}
                </span>
              </li>
            ))}
          </ul>
          <span className="small muted">Supporting a key result is context: it never changes the key result&apos;s value. Linking tasks is a separate step, previewed first.</span>
          {canManage && !adding && <div><button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>Add a key result it supports</button></div>}
          {canManage && adding && (
            <div className="row wrap" style={{ gap: 8 }}>
              <select className="select" aria-label="Key result" value={krChoice} onChange={(e) => setKrChoice(e.target.value)} style={{ maxWidth: 360 }}>
                <option value="">Choose a key result…</option>
                {krOptions.filter((k) => !linkedIds.has(k.id)).map((k) => <option key={k.id} value={k.id}>{k.title}{k.objective_title ? ` · ${k.objective_title}` : ''}</option>)}
              </select>
              <button type="button" className="btn btn-primary btn-sm" disabled={!krChoice} onClick={() => act(async () => { const r = await api.post(`/projects/${p.id}/key-results`, { key_result_id: Number(krChoice) }); setKrChoice(''); setAdding(false); return r; }, 'Linked')}>Add</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {links.origin && (
        <div className="pj-signal">
          <span className="field-label">{links.origin.is_application ? 'From the application' : 'From the deal'}</span>
          <Link to={links.origin.is_application ? `/applications/${links.origin.id}` : `/accounts/${links.origin.account_id}?deal=${links.origin.id}`}>{links.origin.name}</Link>
          <span className="small muted">{links.origin.account_name} · {links.origin.stage_name}</span>
          {links.origin.status === 'LOST' && <Badge tone="warning">Origin deal: lost</Badge>}
        </div>
      )}
      {links.engagement && (
        <div className="stack-sm">
          <div className="pj-signal">
            <span className="field-label">Delivery record</span>
            <span>{links.engagement.name}</span>
            <span className="small muted">{String(links.engagement.state || '').toLowerCase().replace(/_/g, ' ')}</span>
            {canManage && <ConfirmButton label="Unlink" confirmLabel="Unlink delivery record" className="btn btn-ghost btn-sm" onConfirm={() => act(() => api.patch(`/projects/${p.id}`, { engagement_id: null }), 'Unlinked')} />}
          </div>
          {links.engagement.milestones.length > 0 && (
            <div>
              <span className="field-label">Partner milestones (from the delivery record, read-only)</span>
              <ul className="ws-list">
                {links.engagement.milestones.map((m) => (
                  <li key={m.id} className="row-between" style={{ gap: 8, padding: '4px 0' }}>
                    <span>{m.title}{m.due_date ? <span className="small muted"> · {dateWords(m.due_date)}</span> : ''}</span>
                    <Badge tone={m.status === 'ACCEPTED' ? 'good' : m.status === 'BLOCKED' ? 'critical' : 'neutral'}>{String(m.status).toLowerCase().replace(/_/g, ' ')}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {links.engagement_tasks_outside.length > 0 && (
            <div className="stack-sm">
              <span className="field-label">Tasks on the delivery record, not in this project</span>
              {links.engagement_tasks_outside.map((t) => (
                <div key={t.id} className="row-between wrap" style={{ gap: 8 }}>
                  <Link to={`?task=${t.id}`}><span className="task-ref">{t.ref}</span> {t.title}</Link>
                  <button type="button" className="btn btn-sm" onClick={() => act(() => api.post(`/projects/${p.id}/tasks`, { task_ids: [t.id] }), `Added ${t.ref} to the project`)}>Add to project</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {linking && <LinkTasks projectId={p.id} kr={linking} onClose={() => setLinking(null)} onDone={() => { setLinking(null); api.get(`/projects/${p.id}`).then(setPage).catch(() => {}); }} />}
    </section>
  );
}

/** A small project line, with both health signals and progress. */
function ProjectLine({ p }) {
  return (
    <li className="stack-sm" style={{ padding: '6px 0' }}>
      <span className="row-between wrap" style={{ gap: 8 }}>
        <Link to={`/projects/${p.id}`}><strong>{p.name}</strong></Link>
        <span className="row wrap" style={{ gap: 6 }}><Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge><HealthSignals numbers={p.numbers} compact /></span>
      </span>
      <ProgressBar numbers={p.numbers} />
      <span className="small muted">{progressWords(p.numbers)}{p.lead_name ? ` · Lead: ${p.lead_name}` : ''}</span>
    </li>
  );
}

/**
 * On a deal or an application: the projects it started, and "Start a project"
 * once it is won (or selected).
 */
export function ProjectsForDeal({ opportunityId, won }) {
  const { settings } = useAuthSettings();
  const toast = useToast();
  const navigate = useNavigate();
  const [projects, setProjects] = useState(null);
  const [starting, setStarting] = useState(null);
  useEffect(() => {
    if (settings?.projects?.enabled === false) return;
    api.get(`/projects/for-deal/${opportunityId}`).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, [opportunityId, settings?.projects?.enabled]);
  if (settings?.projects?.enabled === false || projects === null) return null;
  const start = async () => {
    try { setStarting(await api.get(`/projects/from-deal/${opportunityId}/preview`)); } catch (err) { toast.error(err); }
  };
  const create = async () => {
    try {
      const r = await api.post('/projects', { ...projectBody(starting.project), opportunity_id: opportunityId });
      toast.success('Project started');
      navigate(`/projects/${r.project.id}`);
    } catch (err) { toast.error(err); }
  };
  if (!projects.length && !won) return null;
  return (
    <section className="card stack-sm" aria-label="Projects">
      <h2 className="ws-title">Projects</h2>
      {projects.length > 0 && <ul className="ws-list">{projects.map((p) => <ProjectLine key={p.id} p={p} />)}</ul>}
      {won && <div><button type="button" className="btn btn-sm" onClick={start}>Start a project</button></div>}
      {starting && (
        <Modal title={starting.is_application ? 'Start a project for this application' : 'Start a project for this deal'} onClose={() => setStarting(null)}
          footer={<><button type="button" className="btn" onClick={() => setStarting(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={!starting.can_create || starting.project.name.trim().length < 3} onClick={create}>Create project</button></>}>
          {!starting.can_create && <p className="small" role="alert">Managers and above create projects, in their own department. Ask one to start it.</p>}
          <ProjectForm value={starting.project} onChange={(project) => setStarting({ ...starting, project })} isNew canChooseDepartment={false} />
        </Modal>
      )}
    </section>
  );
}

/** On the CRM's delivery record: its project, or a way to link one. */
export function ProjectForEngagement({ engagementId }) {
  const { settings } = useAuthSettings();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [options, setOptions] = useState([]);
  const [choice, setChoice] = useState('');
  const load = () => api.get(`/projects/for-engagement/${engagementId}`).then((r) => setState(r.project)).catch(() => setState(null));
  useEffect(() => {
    if (settings?.projects?.enabled === false) return;
    load();
    api.get('/projects/options').then((r) => setOptions(r.projects || [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engagementId, settings?.projects?.enabled]);
  if (settings?.projects?.enabled === false) return null;
  const link = async () => {
    try { await api.patch(`/projects/${choice}`, { engagement_id: engagementId }); toast.success('Linked to the project'); setChoice(''); load(); } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack-sm">
      <span className="field-label">Project</span>
      {state ? <ul className="ws-list"><ProjectLine p={state} /></ul> : (
        <div className="row wrap" style={{ gap: 8 }}>
          <select className="select" aria-label="Link a project" value={choice} onChange={(e) => setChoice(e.target.value)} style={{ maxWidth: 320 }}>
            <option value="">Link a project…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.department_name}</option>)}
          </select>
          <button type="button" className="btn btn-sm" disabled={!choice} onClick={link}>Link</button>
        </div>
      )}
    </div>
  );
}

/** On a key result: the projects that support it (context only). */
export function SupportingProjects({ projects }) {
  if (!projects?.length) return null;
  return (
    <section className="stack-sm" aria-label="Projects that support it">
      <span className="field-label">Projects that support it</span>
      <ul className="ws-list">{projects.map((p) => <ProjectLine key={p.id} p={p} />)}</ul>
      <span className="small muted">Context only: a project never changes this key result&apos;s value.</span>
    </section>
  );
}

// settings live with the reference data
function useAuthSettings() { return useRefData(); }

/**
 * On the classic home: a small card for people who lead or belong to projects
 * (how many are open, how many are at risk or off track, and a link).
 */
export function MyProjectsCard() {
  const { settings } = useAuthSettings();
  const [d, setD] = useState(null);
  useEffect(() => {
    if (settings?.projects?.enabled === false) return;
    api.get('/projects', { mine: 'true', status: 'open' }).then(setD).catch(() => setD(null));
  }, [settings?.projects?.enabled]);
  if (!d?.projects?.length) return null;
  const atRisk = d.projects.filter((p) => ['AT_RISK', 'OFF_TRACK'].includes(p.numbers?.health_from_tasks?.code)).length;
  const lead = d.projects.filter((p) => p.can_manage).length;
  return (
    <div className="card card-pad row-between wrap" role="region" aria-label="My projects">
      <span className="small">
        <strong>Projects</strong> · {d.projects.length} open project{d.projects.length === 1 ? '' : 's'} you are in
        {atRisk ? <> · <span className="pj-overdue">{atRisk} at risk or off track</span></> : ' · none at risk'}
        {lead ? ` · you manage ${lead}` : ''}
      </span>
      <Link className="btn btn-sm" to="/projects">Open projects</Link>
    </div>
  );
}
