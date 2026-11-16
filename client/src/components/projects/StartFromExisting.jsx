/**
 * Reviewed tools for starting a project from work that already exists (P1.8),
 * and for taking tasks out again. Nothing changes until the person confirms:
 * each shows what would happen first, and task references never change.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth, useRefData, useToast } from '../../state/AppState.jsx';
import { Modal, Spinner } from '../ui.jsx';

function LeadSelect({ value, onChange }) {
  const { users } = useRefData();
  return (
    <label className="field"><span className="field-label">Lead</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {users.filter((u) => u.is_active !== false).map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.department_name ? ` · ${u.department_name}` : ''}</option>)}
      </select>
      <span className="field-hint">The lead is always a member, and manages the project</span>
    </label>
  );
}

/** "Turn this task into a project": the parent and its subtasks become the project's tasks. */
export function FromParentTask({ taskId, onClose, onCreated }) {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [lead, setLead] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/projects/from-task/${taskId}/preview`)
      .then((p) => { setPreview(p); setName(p.project.name); setLead(String(p.project.lead_user_id || user.id)); })
      .catch(setError);
  }, [taskId, user.id]);
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/projects/from-task/${taskId}`, { name: name.trim(), lead_user_id: Number(lead) });
      toast.success(`Project created with ${preview.tasks.length} task${preview.tasks.length === 1 ? '' : 's'}`);
      // the task's own dialog closes too, so the project page is not left under it
      (onCreated || onClose)();
      navigate(`/projects/${r.project.id}?tab=tasks`);
    } catch (err) { toast.error(err); setBusy(false); }
  };
  return (
    <Modal title="Turn this task into a project" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!preview || busy || name.trim().length < 3} onClick={confirm}>Create the project</button></>}>
      {error && <div role="alert">{error.message}</div>}
      {!preview && !error && <Spinner label="Working out what would change" />}
      {preview && (
        <div className="stack">
          <p className="small" style={{ margin: 0 }}>
            Nothing changes until you confirm. The project is made in <strong>{preview.project.department_name}</strong>,
            and these tasks join it. Their references, owners and deadlines stay as they are.
          </p>
          <label className="field"><span className="field-label">Project name</span>
            <input className="input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          </label>
          <LeadSelect value={lead} onChange={setLead} />
          <div>
            <div className="field-label">Tasks that join the project ({preview.tasks.length})</div>
            <ul className="pj-pick">
              {preview.tasks.map((t, i) => (
                <li key={t.id} className="small"><span className="task-ref">{t.ref}</span> {t.title}{i === 0 ? <span className="muted"> · the parent</span> : ''}</li>
              ))}
            </ul>
          </div>
          {preview.already_in_projects?.length > 0 && (
            <p className="small" role="note" style={{ margin: 0 }}>
              {preview.already_in_projects.join(', ')} {preview.already_in_projects.length === 1 ? 'is' : 'are'} in another project now, and will move here with the parent.
            </p>
          )}
          <p className="small muted" style={{ margin: 0 }}>To undo, open the project&apos;s Tasks tab and take the tasks out again.</p>
        </div>
      )}
    </Modal>
  );
}

/** "Make a project from a tag": the open tasks with the tag, ticked one by one. */
export function FromTag({ onClose }) {
  const { user, can } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();
  const navigate = useNavigate();
  const [tag, setTag] = useState('');
  const [preview, setPreview] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [target, setTarget] = useState('new');
  const [options, setOptions] = useState([]);
  const [existing, setExisting] = useState('');
  const [name, setName] = useState('');
  const [dept, setDept] = useState(String(user.department_id || ''));
  const [lead, setLead] = useState(String(user.id));
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/projects/options').then((r) => setOptions(r.projects || [])).catch(() => setOptions([])); }, []);
  const look = async (e) => {
    e.preventDefault();
    const t = tag.trim().replace(/^#/, '');
    if (!t) return;
    try {
      const p = await api.get('/projects/from-tag/preview', { tag: t });
      setPreview(p);
      setChosen(p.tasks.filter((x) => x.can_move).map((x) => x.id));
      setName((n) => n || t);
    } catch (err) { toast.error(err); }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const body = target === 'new'
        ? { tag: preview.tag, task_ids: chosen, project: { name: name.trim(), department_id: Number(dept), lead_user_id: Number(lead) } }
        : { tag: preview.tag, task_ids: chosen, project_id: Number(existing) };
      const r = await api.post('/projects/from-tag', body);
      toast.success(`${r.moved.length} task${r.moved.length === 1 ? '' : 's'} added to ${r.project.name}`);
      onClose();
      navigate(`/projects/${r.project.id}?tab=tasks`);
    } catch (err) { toast.error(err); setBusy(false); }
  };
  const ready = preview && chosen.length > 0 && (target === 'new' ? name.trim().length >= 3 && dept : existing);
  return (
    <Modal title="Make a project from a tag" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={confirm}>{target === 'new' ? 'Create the project' : 'Add the tasks'}</button></>}>
      <div className="stack">
        <form className="row" style={{ gap: 6 }} onSubmit={look}>
          <input className="input" aria-label="Tag" placeholder="A tag, like expo-2027" value={tag} maxLength={40} onChange={(e) => setTag(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={!tag.trim()}>Find tasks</button>
        </form>
        <p className="small muted" style={{ margin: 0 }}>Lists the open tasks you can see with that tag. Nothing changes until you confirm.</p>
        {preview && !preview.tasks.length && <p className="small" style={{ margin: 0 }}>No open tasks you can see carry the tag &quot;{preview.tag}&quot;.</p>}
        {preview && preview.tasks.length > 0 && (
          <>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">Tasks to include ({chosen.length} of {preview.tasks.length})</legend>
              <ul className="pj-pick">
                {preview.tasks.map((t) => (
                  <li key={t.id}>
                    <label className="row small" style={{ gap: 8 }}>
                      <input type="checkbox" disabled={!t.can_move} checked={chosen.includes(t.id)}
                        onChange={(e) => setChosen((c) => (e.target.checked ? [...c, t.id] : c.filter((x) => x !== t.id)))} />
                      <span className="task-ref">{t.ref}</span> <span className="truncate">{t.title}</span>
                      {t.why_not && <span className="muted"> · {t.why_not}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">Put them in</legend>
              <label className="row small" style={{ gap: 6 }}><input type="radio" name="pj-target" checked={target === 'new'} onChange={() => setTarget('new')} /> A new project</label>
              <label className="row small" style={{ gap: 6 }}><input type="radio" name="pj-target" checked={target === 'existing'} disabled={!options.length} onChange={() => setTarget('existing')} /> A project that exists</label>
            </fieldset>
            {target === 'new' ? (
              <div className="grid-2">
                <label className="field"><span className="field-label">Project name</span>
                  <input className="input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field"><span className="field-label">Department</span>
                  <select className="select" value={dept} onChange={(e) => setDept(e.target.value)} disabled={!can('project.manage.any')}>
                    {departments.filter((d) => d.is_active !== false).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </label>
                <LeadSelect value={lead} onChange={setLead} />
              </div>
            ) : (
              <label className="field"><span className="field-label">Project</span>
                <select className="select" value={existing} onChange={(e) => setExisting(e.target.value)}>
                  <option value="">Choose…</option>
                  {options.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.department_name}</option>)}
                </select>
              </label>
            )}
            <p className="small muted" style={{ margin: 0 }}>References, owners and deadlines stay as they are. To undo, take the tasks out again from the project&apos;s Tasks tab.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Take tasks out of a project (subtasks go with their parent). Undoes the tools above. */
export function TakeOut({ projectId, tasks, onClose, onDone }) {
  const toast = useToast();
  const top = tasks.filter((t) => !t.parent_task_id);
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/projects/${projectId}/tasks/remove`, { task_ids: chosen });
      toast.success(`${r.moved.length} task${r.moved.length === 1 ? '' : 's'} taken out of the project`);
      onDone();
    } catch (err) { toast.error(err); setBusy(false); }
  };
  return (
    <Modal title="Take tasks out of the project" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!chosen.length || busy} onClick={confirm}>Take {chosen.length || ''} out</button></>}>
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>The tasks stay as they are, in no project. Their subtasks come out with them, and their milestone is cleared.</p>
        <ul className="pj-pick">
          {top.map((t) => (
            <li key={t.id}>
              <label className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, t.id] : c.filter((x) => x !== t.id)))} />
                <span className="task-ref">{t.ref}</span> <span className="truncate">{t.title}</span>
              </label>
            </li>
          ))}
          {!top.length && <li className="small muted">No tasks you can see are in this project.</li>}
        </ul>
      </div>
    </Modal>
  );
}
