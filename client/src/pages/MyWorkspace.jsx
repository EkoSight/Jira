/**
 * My workspace: a person's own home. The layout is theirs alone and lives on
 * the server; the copy in this tab is only there so the page paints at once.
 *
 * Edit mode works on a draft: Save sends the version it started from (a
 * newer saved version is refused and the draft is kept), Cancel puts the
 * saved layout back, Reset goes back to the team's template. Nothing here
 * changes a record, a reminder or anyone else's layout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Badge, Icon, Modal, Spinner } from '../components/ui.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { WorkspaceWidget } from '../components/workspace/Widgets.jsx';
import '../components/workspace/RecordWidgets.jsx';
import { ROW_CHOICES, RANGE_CHOICES, SCOPE_LABEL, WIDGET_TYPES, widgetTitle } from '../../../shared/workspaceWidgets.js';
import {
  layoutBody, layoutChanged, longDate, moveWidget, newWidget, placeWidget, removeWidget, updateWidget, workspaceCache,
} from '../lib/workspace.js';

function AddMenu({ onTask }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const items = [
    can('task.create') && { label: 'Task', onClick: onTask },
    can('crm.create') && { label: 'Lead', to: '/sales?tab=leads&new=1' },
    can('crm.create') && { label: 'Deal', to: '/pipeline?new=1' },
    can('crm.create') && { label: 'Application', to: '/applications?new=1' },
    can('crm.activity.log') && { label: 'Meeting', to: '/meetings?new=1' },
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <div className="ws-menu" ref={ref}>
      <button type="button" className="btn btn-primary btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={13} /> Add
      </button>
      {open && (
        <div className="ws-menu-list" role="menu">
          {items.map((it) => (it.to
            ? <Link key={it.label} role="menuitem" className="ws-menu-item" to={it.to} onClick={() => setOpen(false)}>{it.label}</Link>
            : <button key={it.label} type="button" role="menuitem" className="ws-menu-item" onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>))}
        </div>
      )}
    </div>
  );
}

/** The catalogue: every widget, with why a person cannot add one. */
function Catalogue({ catalogue, onAdd, onClose }) {
  const fresh = catalogue.filter((c) => c.is_new && c.available);
  const groups = [
    fresh.length && ['New', fresh],
    ['Available to you', catalogue.filter((c) => c.available && !c.is_new)],
    ['Not available to you', catalogue.filter((c) => !c.available)],
  ].filter(Boolean);
  return (
    <Modal title="Add a widget" onClose={onClose} size="lg">
      <div className="stack">
        {groups.map(([title, list]) => list.length > 0 && (
          <section key={title} className="stack-sm" aria-label={title}>
            <h3 className="small muted" style={{ margin: 0 }}>{title}</h3>
            <ul className="ws-catalogue">
              {list.map((c) => (
                <li key={c.type} className="ws-catalogue-item">
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{c.title}</div>
                    <div className="small muted">{c.available ? c.description : c.why}</div>
                  </div>
                  {c.available && <button type="button" className="btn btn-sm" onClick={() => onAdd(c.type)}>Add<span className="sr-only"> {c.title}</span></button>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** One widget's settings, as the registry allows them. */
function WidgetSettings({ widget, catalogue, onSave, onClose }) {
  const def = WIDGET_TYPES[widget.type];
  const scopes = catalogue.find((c) => c.type === widget.type)?.scopes || ['mine'];
  const [c, setC] = useState({ ...widget.config });
  const [views, setViews] = useState(null);
  useEffect(() => { if (def.settings.includes('view_id')) api.get('/task-views').then((r) => setViews(r.views.filter((v) => v.mine))).catch(() => setViews([])); }, [def]);
  const set = (k, v) => setC((x) => ({ ...x, [k]: v === '' ? undefined : v }));
  return (
    <Modal title={`${widgetTitle(widget)}: settings`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => onSave(c)}>Apply</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>These change how this widget looks for you only. Save the layout to keep them.</p>
        {def.settings.includes('title') && (
          <label className="field"><span className="field-label">Title</span>
            <input className="input" maxLength={60} value={c.title || ''} placeholder={def.title} onChange={(e) => set('title', e.target.value)} />
          </label>
        )}
        {def.settings.includes('density') && (
          <label className="field"><span className="field-label">Density</span>
            <select className="select" value={c.density || 'compact'} onChange={(e) => set('density', e.target.value)}>
              <option value="compact">Compact</option><option value="expanded">Expanded</option>
            </select>
          </label>
        )}
        {def.settings.includes('rows') && (
          <label className="field"><span className="field-label">Rows</span>
            <select className="select" value={c.rows || 5} onChange={(e) => set('rows', Number(e.target.value))}>
              {ROW_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        {def.settings.includes('range') && (
          <label className="field"><span className="field-label">Date range</span>
            <select className="select" value={c.range || 7} onChange={(e) => set('range', Number(e.target.value))}>
              {RANGE_CHOICES.map((n) => <option key={n} value={n}>Next {n} days</option>)}
            </select>
          </label>
        )}
        {def.settings.includes('sort') && (
          <label className="field"><span className="field-label">Sort</span>
            <select className="select" value={c.sort || 'due_date'} onChange={(e) => set('sort', e.target.value)}>
              <option value="due_date">Deadline</option><option value="priority">Priority</option><option value="updated">Recently changed</option>
            </select>
          </label>
        )}
        {def.settings.includes('scope') && (
          <label className="field"><span className="field-label">Scope</span>
            <select className="select" value={c.scope || 'mine'} onChange={(e) => set('scope', e.target.value)}>
              {scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
            </select>
            {!scopes.includes('team') && def.scopes.includes('team') && <span className="field-hint">My team is offered to people whose access already shows team data.</span>}
          </label>
        )}
        {def.settings.includes('view') && (
          <label className="field"><span className="field-label">Show</span>
            <select className="select" value={c.view || 'today'} onChange={(e) => set('view', e.target.value)}>
              <option value="today">Today &amp; overdue</option><option value="coming">Coming up</option><option value="waiting">Waiting on others</option><option value="all">All</option>
            </select>
          </label>
        )}
        {def.settings.includes('view_id') && (
          <label className="field"><span className="field-label">Saved view</span>
            {views === null ? <Spinner label="Loading your saved views" /> : (
              <select className="select" value={c.view_id || ''} onChange={(e) => set('view_id', e.target.value ? Number(e.target.value) : '')}>
                <option value="">Choose a view</option>
                {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            )}
            {views && !views.length && <span className="field-hint">Save a view on the board first.</span>}
          </label>
        )}
      </div>
    </Modal>
  );
}

/** The controls a widget gets in edit mode. */
function EditBar({ widget, index, count, onMove, onWidth, onSettings, onRemove }) {
  const def = WIDGET_TYPES[widget.type];
  const title = widgetTitle(widget);
  return (
    <div className="ws-editbar" role="group" aria-label={`Arrange ${title}`}>
      <span className="ws-grip" aria-hidden="true" title="Drag to move"><Icon name="list" size={14} /></span>
      <span className="small grow truncate" style={{ fontWeight: 600 }}>{title}</span>
      <button type="button" className="btn btn-ghost btn-sm" disabled={index === 0} onClick={() => onMove(-1)}>Move up<span className="sr-only"> {title}</span></button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={index === count - 1} onClick={() => onMove(1)}>Move down<span className="sr-only"> {title}</span></button>
      {def && def.widths.length > 1 && (
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={widget.width === 'full'} onClick={onWidth}>
          {widget.width === 'full' ? 'Make half width' : 'Make full width'}<span className="sr-only"> {title}</span>
        </button>
      )}
      {def && def.settings.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={onSettings}>Settings<span className="sr-only"> for {title}</span></button>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>Remove<span className="sr-only"> {title}</span></button>
    </div>
  );
}

export default function MyWorkspace({ initial = null, onHomeChange }) {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [ws, setWs] = useState(() => initial || workspaceCache.read(user.id));
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [baseVersion, setBaseVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [confirmKeep, setConfirmKeep] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState(null);
  const [creating, setCreating] = useState(false);
  const [openTask, setOpenTask] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dragId, setDragId] = useState(null);
  const [announce, setAnnounce] = useState('');
  const editButton = useRef(null);

  const load = useCallback(() => api.get('/workspace').then((data) => {
    setWs(data);
    setError(null);
    workspaceCache.write(user.id, data);
    return data;
  }).catch((err) => { setError(err); return null; }), [user.id]);

  useEffect(() => { if (!initial) load(); else workspaceCache.write(user.id, initial); }, [initial, load, user.id]);

  // the person's own changes elsewhere (another tab) show when they come back
  useEffect(() => {
    if (editing) return undefined;
    const back = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [editing, load]);

  const startEdit = () => { setDraft(ws.widgets); setBaseVersion(ws.version); setSaveError(null); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setDraft([]); setSaveError(null); setTimeout(() => editButton.current?.focus(), 0); };

  const save = async ({ force = false } = {}) => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put('/workspace/layout', { version: baseVersion, widgets: layoutBody(draft), force });
      const fresh = await load();
      setEditing(false);
      setConflict(null);
      setConfirmKeep(false);
      if (fresh) toast.success('Layout saved');
      setTimeout(() => editButton.current?.focus(), 0);
    } catch (err) {
      if (err.status === 409) setConflict(err);
      else setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      await api.post('/workspace/layout/reset');
      await load();
      setEditing(false);
      setConfirmReset(false);
      toast.success('Your layout is back to your team\'s default');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const chooseHome = async (home) => {
    try {
      const r = await api.put('/workspace/home', { home });
      setUser((u) => (u ? { ...u, workspace_home: r.home.workspace } : u));
      await load();
      onHomeChange?.(r.home.workspace);
      toast.success(r.home.workspace ? 'My workspace is now your home' : 'The overview is your home again');
    } catch (err) { toast.error(err); }
  };

  const widgets = editing ? draft : ws?.widgets || [];
  const catalogue = ws?.catalogue || [];
  const byType = useMemo(() => new Map(catalogue.map((c) => [c.type, c])), [catalogue]);
  const withAccess = (w) => {
    const c = byType.get(w.type);
    return { ...w, available: Boolean(c?.available), why: c?.why || null, retired: !WIDGET_TYPES[w.type] };
  };
  const changed = editing && ws && layoutChanged(ws.widgets, draft);

  const move = (i, by) => {
    const next = moveWidget(draft, i, by);
    setDraft(next);
    const w = draft[i];
    setAnnounce(`${widgetTitle(w)} moved to position ${Math.min(Math.max(i + by, 0), draft.length - 1) + 1} of ${draft.length}`);
  };

  if (!ws && error) {
    return (
      <div className="card card-pad stack-sm" role="alert">
        <strong>Could not load My workspace</strong>
        <span className="muted">{error.message}</span>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={load}>Retry</button>
          <Link className="btn btn-sm" to="/overview">Open the overview</Link>
        </div>
      </div>
    );
  }
  if (!ws) return <Spinner label="Opening My workspace" />;

  return (
    <div className="stack ws-page" style={{ gap: 14 }}>
      <div className="row-between wrap ws-head">
        <div>
          <h1 style={{ margin: 0 }}>My workspace</h1>
          <div className="small muted">
            {longDate(new Date(), ws.timezone)} · Scope: {ws.scope_label}
            {ws.source === 'TEMPLATE' ? ` · ${ws.template.name} layout` : ' · Your own layout'}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {!editing && <AddMenu onTask={() => setCreating(true)} />}
          {!editing && <button ref={editButton} type="button" className="btn btn-sm" onClick={startEdit}><Icon name="settings" size={13} /> Edit</button>}
          {!editing && <Link className="btn btn-sm btn-ghost" to="/overview">Company overview</Link>}
        </div>
      </div>

      {!editing && !ws.home.workspace && (
        <div className="card card-pad row-between wrap ws-note" role="note">
          <span className="small">{ws.home.why}. The overview stays your home until you choose otherwise.</span>
          <button type="button" className="btn btn-sm" onClick={() => chooseHome('WORKSPACE')}>Make this my home</button>
        </div>
      )}

      {editing && (
        <div className="card card-pad ws-toolbar stack-sm" role="region" aria-label="Editing your layout">
          <div className="row-between wrap">
            <div className="small">
              <strong>Editing your layout.</strong> Changes are yours only and are kept when you press Save.
              {changed ? <Badge tone="warning">Not saved</Badge> : null}
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => setCatalogueOpen(true)}><Icon name="plus" size={13} /> Add a widget</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmReset(true)}>Reset my layout</button>
              <button type="button" className="btn btn-sm" onClick={cancelEdit} disabled={saving}>Cancel</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => save()} disabled={saving || !changed}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
          {saveError && (
            <div className="row wrap ws-error" role="alert" style={{ gap: 8 }}>
              <span>Not saved: {saveError.message}. Your changes are still here.</span>
              <button type="button" className="btn btn-sm" onClick={() => save()}>Retry</button>
            </div>
          )}
          <div className="sr-only" aria-live="polite">{announce}</div>
        </div>
      )}

      {!widgets.length && (
        <div className="card card-pad stack-sm">
          <strong>Your workspace is empty</strong>
          <span className="muted">Add widgets to see what needs you. Nothing else changes.</span>
          <div><button type="button" className="btn btn-sm" onClick={() => { if (!editing) startEdit(); setCatalogueOpen(true); }}>Add a widget</button></div>
        </div>
      )}

      <div className="ws-grid">
        {widgets.map((raw, i) => {
          const w = withAccess(raw);
          return (
            <div
              key={w.id}
              className={`ws-cell ws-${w.width}${editing ? ' ws-editing' : ''}${dragId === w.id ? ' ws-dragging' : ''}`}
              draggable={editing}
              onDragStart={(e) => { setDragId(w.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { if (dragId) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragId) setDraft((d) => placeWidget(d, dragId, w.id)); setDragId(null); }}
              onDragEnd={() => setDragId(null)}
            >
              {editing && (
                <EditBar widget={w} index={i} count={widgets.length}
                  onMove={(by) => move(i, by)}
                  onWidth={() => setDraft(updateWidget(draft, w.id, { width: w.width === 'full' ? 'half' : 'full' }))}
                  onSettings={() => setSettingsFor(w)}
                  onRemove={() => { setDraft(removeWidget(draft, w.id)); setAnnounce(`${widgetTitle(w)} removed from your layout`); }} />
              )}
              <WorkspaceWidget widget={w} refreshKey={refreshKey} onOpenTask={setOpenTask}
                onRemove={editing ? () => setDraft(removeWidget(draft, w.id)) : null} />
            </div>
          );
        })}
      </div>

      {!editing && ws.home.workspace && (
        <div className="small muted">
          {ws.home.why}. <button type="button" className="btn-link" onClick={() => chooseHome('OVERVIEW')}>Use the overview as my home</button>
          {ws.home_choice && <> · <button type="button" className="btn-link" onClick={() => chooseHome(null)}>Follow my team&apos;s setting</button></>}
        </div>
      )}

      {catalogueOpen && (
        <Catalogue catalogue={catalogue} onClose={() => setCatalogueOpen(false)}
          onAdd={(type) => {
            const w = newWidget(type, draft);
            setDraft([...draft, w]);
            setCatalogueOpen(false);
            setAnnounce(`${WIDGET_TYPES[type].title} added at the end of your layout`);
          }} />
      )}
      {settingsFor && (
        <WidgetSettings widget={settingsFor} catalogue={catalogue} onClose={() => setSettingsFor(null)}
          onSave={(config) => { setDraft(draft.map((w) => (w.id === settingsFor.id ? { ...w, config } : w))); setSettingsFor(null); }} />
      )}
      {confirmReset && (
        <Modal title="Reset my layout?" onClose={() => setConfirmReset(false)}
          footer={<><button type="button" className="btn" onClick={() => setConfirmReset(false)}>Keep my layout</button><button type="button" className="btn btn-primary" disabled={saving} onClick={reset}>Reset to my team&apos;s default</button></>}>
          <p style={{ margin: 0 }}>Your layout goes back to the {ws.template.name} default. Your records and reminders stay as they are.</p>
        </Modal>
      )}
      {conflict && (
        <Modal title="Your layout was changed on another device" onClose={() => setConflict(null)}
          footer={confirmKeep ? (
            <><button type="button" className="btn" onClick={() => setConfirmKeep(false)}>Back</button><button type="button" className="btn btn-danger" disabled={saving} onClick={() => save({ force: true })}>Replace it with mine</button></>
          ) : (
            <><button type="button" className="btn" onClick={() => { setConflict(null); setEditing(false); load(); }}>Reload</button><button type="button" className="btn btn-primary" onClick={() => setConfirmKeep(true)}>Keep mine</button></>
          )}>
          <p style={{ margin: 0 }}>
            {confirmKeep
              ? 'The layout saved from your other device or tab will be replaced by the one on this screen. Your records and reminders are not affected.'
              : 'It was saved from another device or tab after you started editing here. Reload to see it (your changes here are dropped), or keep yours.'}
          </p>
        </Modal>
      )}
      {creating && <TaskDialog onClose={() => setCreating(false)} onSaved={() => setRefreshKey((k) => k + 1)} />}
      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={() => setRefreshKey((k) => k + 1)} />}
    </div>
  );
}
