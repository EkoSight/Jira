/**
 * Settings → Workspace (settings.manage): who has My workspace as their home,
 * the reminder mode for the workspace rules, and the templates.
 *
 * A template is presentation only. Changing one reaches everyone who has not
 * customised their layout; people who did keep theirs (and can reset to the
 * new default themselves).
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Badge, Modal, Spinner } from './ui.jsx';
import { WIDGET_TYPES } from '../../../shared/workspaceWidgets.js';
import { moveWidget, newWidget, removeWidget } from '../lib/workspace.js';

const ROLE_WORDS = { super_admin: 'Super admins', admin: 'Admins', manager: 'Managers', member: 'Members', viewer: 'Viewers' };

function TemplateEditor({ template, catalogue, onClose, onSaved }) {
  const { departments } = useRefData();
  const toast = useToast();
  const [t, setT] = useState(() => ({
    name: template?.name || '', description: template?.description || '',
    widgets: template?.layout?.widgets || [],
    applies_departments: template?.applies_departments || [], applies_roles: template?.applies_roles || [],
  }));
  const [key, setKey] = useState(template?.key || '');
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = async () => {
    setBusy(true);
    try {
      const k = template?.key || key.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
      await api.put(`/workspace/templates/${k}`, {
        name: t.name, description: t.description || null,
        layout: { widgets: t.widgets }, applies_departments: t.applies_departments, applies_roles: t.applies_roles,
      });
      toast.success('Template saved. People who never customised their layout see it on their next visit');
      onSaved();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={template ? `Edit template: ${template.name}` : 'New template'} size="lg" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !t.name || !t.widgets.length} onClick={save}>Save template</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>A template only chooses widgets and their order. It never gives anyone access: a widget whose data a person cannot see is not shown to them.</p>
        <label className="field"><span className="field-label">Name</span><input className="input" value={t.name} maxLength={80} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
        {!template && <label className="field"><span className="field-label">Short key</span><input className="input" value={key} maxLength={40} placeholder="for example programmes" onChange={(e) => setKey(e.target.value)} /></label>}
        <label className="field"><span className="field-label">Description</span><input className="input" value={t.description || ''} maxLength={300} onChange={(e) => setT({ ...t, description: e.target.value })} /></label>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Applies to these departments</legend>
          <div className="row wrap" style={{ gap: 10 }}>
            {departments.map((d) => (
              <label key={d.id} className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={t.applies_departments.includes(d.id)} onChange={() => setT({ ...t, applies_departments: toggle(t.applies_departments, d.id) })} />{d.name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Or to these roles (a department match comes first)</legend>
          <div className="row wrap" style={{ gap: 10 }}>
            {Object.entries(ROLE_WORDS).map(([r, label]) => (
              <label key={r} className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={t.applies_roles.includes(r)} onChange={() => setT({ ...t, applies_roles: toggle(t.applies_roles, r) })} />{label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="stack-sm">
          <span className="field-label">Widgets, top to bottom</span>
          <ol className="ws-catalogue" style={{ paddingLeft: 0 }}>
            {t.widgets.map((w, i) => (
              <li key={w.id} className="ws-catalogue-item">
                <span className="grow">{i + 1}. {WIDGET_TYPES[w.type]?.title || w.type} <span className="small muted">({w.width === 'half' ? 'half width' : 'full width'})</span></span>
                <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => setT({ ...t, widgets: moveWidget(t.widgets, i, -1) })}>Move up</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={i === t.widgets.length - 1} onClick={() => setT({ ...t, widgets: moveWidget(t.widgets, i, 1) })}>Move down</button>
                {WIDGET_TYPES[w.type]?.widths.length > 1 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setT({ ...t, widgets: t.widgets.map((x) => (x.id === w.id ? { ...x, width: x.width === 'full' ? 'half' : 'full' } : x)) })}>{w.width === 'full' ? 'Half width' : 'Full width'}</button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setT({ ...t, widgets: removeWidget(t.widgets, w.id) })}>Remove</button>
              </li>
            ))}
          </ol>
          <div className="row wrap" style={{ gap: 8 }}>
            <select className="select" aria-label="Widget to add" value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose a widget</option>
              {catalogue.map((c) => <option key={c.type} value={c.type}>{c.title}</option>)}
            </select>
            <button type="button" className="btn btn-sm" disabled={!adding} onClick={() => { setT({ ...t, widgets: [...t.widgets, newWidget(adding, t.widgets)] }); setAdding(''); }}>Add</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function WorkspaceSettings() {
  const { departments } = useRefData();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => Promise.all([api.get('/workspace/templates'), api.get('/workspace/settings')])
    .then(([t, s]) => { setData(t); setCfg(s); })
    .catch((err) => toast.error(err));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveRollout = async (rollout) => {
    try { setCfg(await api.put('/workspace/settings', { rollout })); toast.success('Saved'); } catch (err) { toast.error(err); }
  };
  const saveMode = async (reminderMode) => {
    try { setCfg(await api.put('/workspace/settings', { reminderMode })); toast.success(reminderMode === 'TEST' ? 'Test mode: only you receive workspace reminders' : 'Saved'); } catch (err) { toast.error(err); }
  };
  if (!data || !cfg) return <Spinner label="Loading the workspace settings" />;
  const ids = cfg.rollout.departmentIds;
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><h2>Who has My workspace as their home</h2></div>
        <div className="card-pad stack">
          <p className="small muted" style={{ margin: 0 }}>Everyone can open My workspace and make it their home. Today&apos;s overview stays at its own address and in the menu. A person&apos;s own choice always wins.</p>
          <div className="row wrap" style={{ gap: 14 }} role="radiogroup" aria-label="Rollout">
            {[['PILOT', 'A first group of departments'], ['EVERYONE', 'Everyone'], ['OFF', 'Nobody (only people who choose it)']].map(([m, label]) => (
              <label key={m} className="row small" style={{ gap: 6 }}>
                <input type="radio" name="rollout" checked={cfg.rollout.mode === m} onChange={() => saveRollout({ ...cfg.rollout, mode: m })} />{label}
              </label>
            ))}
          </div>
          {cfg.rollout.mode === 'PILOT' && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">Departments in the first group</legend>
              <div className="row wrap" style={{ gap: 10 }}>
                {departments.map((d) => (
                  <label key={d.id} className="row small" style={{ gap: 4 }}>
                    <input type="checkbox" checked={ids.includes(d.id)} onChange={() => saveRollout({ ...cfg.rollout, departmentIds: ids.includes(d.id) ? ids.filter((x) => x !== d.id) : [...ids, d.id] })} />{d.name}
                  </label>
                ))}
              </div>
              {!ids.length && <span className="field-hint">None chosen yet: nobody&apos;s home has changed.</span>}
            </fieldset>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Workspace reminders</h2><Badge tone={cfg.reminderMode === 'LIVE' ? 'good' : 'warning'}>{cfg.reminderMode === 'LIVE' ? 'Live' : cfg.reminderMode === 'TEST' ? 'Test mode' : 'Off'}</Badge></div>
        <div className="card-pad stack-sm">
          <p className="small muted" style={{ margin: 0 }}>The rules for applications, meetings and deals. In test mode only you receive them; everyone else&apos;s are recorded as &quot;would send&quot; in the delivery log. A person&apos;s own &quot;Remind me&quot; always reaches them. Email and push are not available; reminders go to the TaskFlow bell, and to Google Chat for people who connected it.</p>
          <div className="row wrap" style={{ gap: 8 }}>
            {['OFF', 'TEST', 'LIVE'].map((m) => (
              <button key={m} type="button" className={`btn btn-sm${cfg.reminderMode === m ? ' btn-primary' : ''}`} aria-pressed={cfg.reminderMode === m} onClick={() => saveMode(m)}>
                {{ OFF: 'Off', TEST: 'Test mode', LIVE: 'Live' }[m]}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Templates</h2><button type="button" className="btn btn-sm" onClick={() => setEditing('new')}>New template</button></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Template</th><th>Applies to</th><th>Widgets</th><th className="num">Following</th><th className="num">Customised</th><th /></tr></thead>
            <tbody>
              {data.templates.map((t) => {
                const u = data.usage[t.key] || { following: 0, customised: 0 };
                const to = [...(t.department_names || []), ...t.applies_roles.map((r) => ROLE_WORDS[r])];
                return (
                  <tr key={t.key}>
                    <td><strong>{t.name}</strong><div className="small muted">{t.description}</div></td>
                    <td className="small">{to.length ? to.join(', ') : t.key === 'everyone' ? 'Everyone else' : 'Nobody yet: choose departments'}</td>
                    <td className="small">{t.layout.widgets.map((w) => WIDGET_TYPES[w.type]?.title || w.type).join(' · ')}</td>
                    <td className="num tnum">{u.following}</td>
                    <td className="num tnum">{u.customised}</td>
                    <td><button type="button" className="btn btn-sm" onClick={() => setEditing(t)}>Edit<span className="sr-only"> {t.name}</span></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <TemplateEditor template={editing === 'new' ? null : editing} catalogue={data.catalogue}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}
