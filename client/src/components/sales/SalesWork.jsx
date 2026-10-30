import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, downloadFile, postDownload } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from '../ui.jsx';
import {
  CATEGORY, ELIGIBLE, EXCLUDED, FOLLOWUP_KIND, PRIORITY, dayOf, money, when,
} from '../../lib/sales.js';
import { CategoryBadge, DestinationBadge, FollowUpActions, LeadStatusBadge, LogCallDialog } from './parts.jsx';

// ---------------------------------------------------------------- my day

const BUCKETS = [
  ['missed', 'Missed', 'critical', 'Overdue past the escalation time: your manager has been told'],
  ['overdue', 'Overdue', 'warning', 'Past their time, not yet escalated'],
  ['today', 'Today', 'brand', null],
  ['upcoming', 'Coming up', null, null],
  ['snoozed', 'Snoozed', null, null],
  ['done_today', 'Done today', 'good', null],
];

function FollowUpRow({ task, onOpen, onCall }) {
  const about = task.lead_name || task.opportunity_name || task.account_name;
  const to = task.crm_lead_id ? `/sales/leads/${task.crm_lead_id}` : task.account_id ? `/accounts/${task.account_id}${task.opportunity_id ? `?deal=${task.opportunity_id}` : ''}` : null;
  return (
    <div className="sales-row">
      <div className="grow stack-xs" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          <Badge>{FOLLOWUP_KIND[task.followup_kind] || 'Follow-up'}</Badge>
          <span className="truncate" style={{ fontWeight: 600 }}>{task.title}</span>
        </div>
        <div className="small muted row wrap" style={{ gap: 6 }}>
          <span>{task.completed_at ? `done ${when(task.completed_at)}` : when(task.due_date)}</span>
          {to && <Link to={to} className="btn-link truncate">{about}</Link>}
          {task.assignee_name && <span>· {task.assignee_name}</span>}
          {task.due_date_changes > 0 && <span title="Times its date was moved">· moved {task.due_date_changes}×</span>}
        </div>
      </div>
      {!task.completed_at && (
        <div className="row" style={{ gap: 4 }}>
          {task.phone && <a className="btn btn-sm btn-icon" href={`tel:${task.phone}`} title={`Call ${task.phone} (opens your dialler; log it after)`} onClick={onCall}><Icon name="sound" size={14} /></a>}
          <button type="button" className="btn btn-sm" onClick={() => onOpen(task, 'complete')}>Done</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpen(task, 'reschedule')}>Move</button>
        </div>
      )}
    </div>
  );
}

export function MyDay({ meta }) {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [team, setTeam] = useState(params.get('team') === '1');
  const [person, setPerson] = useState('');
  const [day, setDay] = useState(null);
  const [acting, setActing] = useState(null);
  const [logging, setLogging] = useState(null);
  const canTeam = can('crm.view.team') || can('crm.view.all');
  const load = useCallback(() => {
    setDay(null);
    api.sales.get('/my-day', { team: team ? 'true' : undefined, user_id: person || undefined }).then(setDay).catch((err) => setDay({ error: err.message }));
  }, [team, person]);
  useEffect(load, [load]);
  if (!day) return <Spinner label="Loading your day" />;
  if (day.error) return <EmptyState title="Could not load the day">{day.error}</EmptyState>;
  const open = ['missed', 'overdue', 'today'].reduce((n, k) => n + day[k].length, 0);
  return (
    <div className="stack">
      <div className="row-between wrap">
        <div className="small muted">{open ? `${open} to do now` : 'Nothing due now'} · times in {day.timezone}</div>
        {canTeam && (
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className={`kind-chip${!team && !person ? ' is-active' : ''}`} onClick={() => { setTeam(false); setPerson(''); }}>My day</button>
            <button type="button" className={`kind-chip${team ? ' is-active' : ''}`} onClick={() => { setTeam(true); setPerson(''); }}>Team</button>
            <select className="select" style={{ width: 'auto' }} value={person} aria-label="Someone's day" onChange={(e) => { setPerson(e.target.value); setTeam(false); }}>
              <option value="">Someone’s day…</option>
              {meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </div>
        )}
      </div>
      {day.awaiting_first_response.length > 0 && (
        <div className="card">
          <div className="card-head"><h3>New leads waiting for a first contact</h3><span className="small muted">{day.awaiting_first_response.length}</span></div>
          <div className="card-pad stack-sm">
            {day.awaiting_first_response.map((l) => (
              <div key={l.id} className="sales-row">
                <CategoryBadge category={l.category} />
                <div className="grow stack-xs" style={{ minWidth: 140 }}>
                  <Link to={`/sales/leads/${l.id}`} className="truncate" style={{ fontWeight: 600 }}>{l.name}</Link>
                  <span className="small muted">arrived {when(l.captured_at)}</span>
                </div>
                {l.phone && <a className="btn btn-sm" href={`tel:${l.phone}`}><Icon name="sound" size={13} /> Call</a>}
                <button type="button" className="btn btn-sm" onClick={() => setLogging({ lead_id: l.id, phone: l.phone })}>Log call</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {day.meetings_today.length > 0 && (
        <div className="card card-pad stack-sm">
          <h3>Meetings today</h3>
          {day.meetings_today.map((m) => <Link key={m.id} to={`/accounts/${m.account_id}`} className="sales-row"><Badge tone="brand">{when(m.scheduled_at)}</Badge><span className="grow truncate">{m.title}</span><span className="small muted">{m.account_name}</span></Link>)}
        </div>
      )}
      {BUCKETS.map(([key, label, tone, note]) => (day[key].length > 0 || key === 'today') && (
        <div key={key} className="card">
          <div className="card-head"><h3>{tone && <span className="badge-dot" style={{ background: `var(--${tone})`, marginRight: 6 }} />}{label}</h3><span className="small muted">{day[key].length}{note ? ` · ${note}` : ''}</span></div>
          <div className="card-pad stack-sm">
            {day[key].length === 0 ? <div className="empty small">Nothing scheduled for today. New follow-ups appear here.</div>
              : day[key].map((t) => <FollowUpRow key={t.id} task={t} onOpen={(task, mode) => setActing({ task, mode })} />)}
          </div>
        </div>
      ))}
      {acting && <FollowUpActions task={acting.task} initial={acting.mode} users={meta.users} onClose={() => setActing(null)} onDone={load} />}
      {logging && <LogCallDialog target={{ lead_id: logging.lead_id }} phone={logging.phone} users={meta.users} onClose={() => setLogging(null)} onSaved={load} />}
    </div>
  );
}

// ---------------------------------------------------------------- new lead

export function NewLeadDialog({ meta, onClose, onSaved }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    category: 'B2B_CORPORATE', organization_name: '', contact_name: '', designation: '', email: '', phone: '', website: '', city: '', state: '',
    requirement: '', source_id: '', campaign_id: '', priority: 'MEDIUM', owner_user_id: '', budget_amount: '',
  });
  const [more, setMore] = useState(false);
  const [dupes, setDupes] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));
  const excluded = EXCLUDED.includes(form.category);

  // possible duplicates, with why, as the person types
  useEffect(() => {
    const probe = { email: form.email, phone: form.phone, website: form.website, organization_name: form.organization_name };
    if (!probe.email && (!probe.phone || probe.phone.length < 8) && !probe.website) { setDupes(null); return undefined; }
    const timer = setTimeout(() => api.sales.post('/leads/duplicates', probe).then(setDupes).catch(() => {}), 450);
    return () => clearTimeout(timer);
  }, [form.email, form.phone, form.website, form.organization_name]);

  const save = async () => {
    setSaving(true);
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v !== null));
      for (const k of ['source_id', 'campaign_id', 'owner_user_id']) if (body[k]) body[k] = Number(body[k]);
      if (body.budget_amount) body.budget_amount = Number(body.budget_amount);
      const r = await api.sales.post('/leads', body);
      toast.success(r.lead.destination === 'TASKFLOW' ? `${r.lead.ref} added${r.lead.owner_name ? ` for ${r.lead.owner_name}` : ''}`
        : r.lead.destination === 'TELECRM' ? `${r.lead.ref} queued for TeleCRM` : `${r.lead.ref} is waiting for classification`);
      onSaved(r.lead);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  const hits = dupes ? [...dupes.leads, ...dupes.accounts.map((a) => ({ ...a, isAccount: true }))] : [];
  return (
    <Modal title="New lead" size="lg" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : excluded ? 'Send to TeleCRM queue' : 'Add lead'}</button></>}>
      <div className="stack">
        <Field label="Who is it? *">
          <div className="row wrap" role="radiogroup" style={{ gap: 6 }}>
            {[...ELIGIBLE, ...EXCLUDED].map((k) => (
              <button key={k} type="button" role="radio" aria-checked={form.category === k} className={`kind-chip${form.category === k ? ' is-active' : ''}`} onClick={() => set({ category: k })}>{CATEGORY[k].label}</button>
            ))}
          </div>
        </Field>
        {excluded && <div className="mkt-callout is-warning small">{CATEGORY[form.category].label} enquiries are handled in TeleCRM. This is kept and queued for the TeleCRM hand-off; it does not enter Taskflow’s pipeline. A person who works at a company is a B2B contact, not an individual.</div>}
        <div className="grid-2">
          <Field label={form.category === 'INDIVIDUAL' ? 'Organization (if any)' : 'Organization *'}><input className="input" autoFocus value={form.organization_name} onChange={(e) => set({ organization_name: e.target.value })} placeholder="Coromandel Agro Inputs" /></Field>
          <Field label="Contact person"><input className="input" value={form.contact_name} onChange={(e) => set({ contact_name: e.target.value })} placeholder="Priya Nair" /></Field>
          <Field label="Phone"><input className="input" type="tel" inputMode="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="98765 43210" /></Field>
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        </div>
        <Field label="What do they need?"><textarea className="textarea" rows={2} value={form.requirement} onChange={(e) => set({ requirement: e.target.value })} placeholder="Soil testing for 400 dealers before kharif" /></Field>
        <div className="grid-2">
          <Field label="Source" hint="Where the enquiry came from (not how it was typed in)">
            <select className="select" value={form.source_id} onChange={(e) => set({ source_id: e.target.value })}>
              <option value="">Not known</option>{meta.sources.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          {!excluded && (can('crm.assign') ? (
            <Field label="Owner" hint="Blank: the assignment rules choose">
              <select className="select" value={form.owner_user_id} onChange={(e) => set({ owner_user_id: e.target.value })}>
                <option value="">Assign automatically</option>{meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </Field>
          ) : (
            <Field label="Owner">
              <select className="select" value={form.owner_user_id} onChange={(e) => set({ owner_user_id: e.target.value })}>
                <option value="">Assign automatically</option><option value={user.id}>Me</option>
              </select>
            </Field>
          ))}
        </div>
        <button type="button" className="btn-link small" aria-expanded={more} onClick={() => setMore((v) => !v)}>{more ? 'Fewer details' : 'More details (designation, website, place, budget, campaign, priority)'}</button>
        {more && (
          <div className="grid-2">
            <Field label="Designation"><input className="input" value={form.designation} onChange={(e) => set({ designation: e.target.value })} /></Field>
            <Field label="Website"><input className="input" value={form.website} onChange={(e) => set({ website: e.target.value })} placeholder="https://" /></Field>
            <Field label="City"><input className="input" value={form.city} onChange={(e) => set({ city: e.target.value })} /></Field>
            <Field label="State"><input className="input" value={form.state} onChange={(e) => set({ state: e.target.value })} /></Field>
            <Field label="Budget (if they said)"><input className="input" type="number" min="0" value={form.budget_amount} onChange={(e) => set({ budget_amount: e.target.value })} /></Field>
            <Field label="Campaign">
              <select className="select" value={form.campaign_id} onChange={(e) => set({ campaign_id: e.target.value })}>
                <option value="">None</option>{meta.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select className="select" value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                {Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
          </div>
        )}
        {hits.length > 0 && (
          <div className="mkt-callout small">
            <strong>Possible duplicates</strong> — check before adding; nothing is merged automatically.
            <ul>{hits.slice(0, 5).map((h, i) => (
              <li key={i}>{h.hidden ? `A record you cannot open${h.owner_name ? ` (owned by ${h.owner_name})` : ''}` : h.isAccount
                ? <Link to={`/accounts/${h.id}`}>{h.name}</Link> : <Link to={`/sales/leads/${h.id}`}>{h.ref} {h.organization_name || h.contact_name}</Link>}
                {' — '}{(h.reasons || []).join(', ')}</li>
            ))}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the lead list

const VIEW_LABEL = {
  open: 'Open', mine: 'Mine', team: 'Team', unassigned: 'Unassigned', new: 'New', overdue: 'Overdue', stale: 'Stale',
  nurture: 'Nurture', converted: 'Converted', disqualified: 'Disqualified', all: 'All', needs_classification: 'Needs classification',
  telecrm: 'TeleCRM queue', archived: 'Archived',
};

export function Leads({ meta }) {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'open';
  const [filters, setFilters] = useState({ q: '', category: '', status: '', owner_id: '', source_id: '', sort: 'newest' });
  const [data, setData] = useState(null);
  const [counts, setCounts] = useState({});
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [creating, setCreating] = useState(false);
  const [bulk, setBulk] = useState(null);
  const [savedViews, setSavedViews] = useState([]);
  const routing = can('crm.routing');

  const query = useMemo(() => ({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), view, page, page_size: 50 }), [filters, view, page]);
  const load = useCallback(() => {
    api.sales.get('/leads', query).then((r) => { setData(r); setSelected(new Set()); }).catch((err) => setData({ error: err.message }));
    api.sales.get('/leads/counts').then((r) => setCounts(r.counts)).catch(() => {});
  }, [query]);
  useEffect(() => { const t = setTimeout(load, filters.q ? 300 : 0); return () => clearTimeout(t); }, [load, filters.q]);
  useEffect(() => { api.sales.get('/views', { area: 'leads' }).then((r) => setSavedViews(r.views)).catch(() => {}); }, []);

  const views = ['open', 'mine', ...(can('crm.view.team') ? ['team'] : []), 'unassigned', 'new', 'overdue', 'stale', 'nurture', 'converted', 'disqualified',
    ...(routing ? ['needs_classification', 'telecrm'] : []), 'all', 'archived'];
  const setView = (v) => { setPage(1); setParams({ tab: 'leads', view: v }, { replace: true }); };
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const runBulk = async (action, value, reason) => {
    try {
      const r = await api.sales.post('/leads/bulk', { ids: [...selected], action, value, reason });
      toast.success(`${r.done.length} changed${r.refused.length ? `, ${r.refused.length} refused (${r.refused[0].error})` : ''}`);
      setBulk(null);
      load();
    } catch (err) { toast.error(err); }
  };
  const saveView = async () => {
    const name = window.prompt('Name this view');
    if (!name) return;
    try {
      const { view: v } = await api.sales.post('/views', { area: 'leads', name, filters: { ...filters, view } });
      setSavedViews((s) => [...s, v]);
      toast.success('View saved');
    } catch (err) { toast.error(err); }
  };

  return (
    <div className="stack">
      <div className="row-between wrap">
        <div className="tabs tabs-scroll" role="tablist" aria-label="Lead views">
          {views.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={`tab${view === v ? ' active' : ''}`} onClick={() => setView(v)}>
              {VIEW_LABEL[v]}{counts[v] !== undefined ? ` (${counts[v]})` : v === 'telecrm' && counts.telecrm_pending !== undefined ? ` (${counts.telecrm_pending})` : ''}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {can('crm.export') && <button type="button" className="btn btn-sm" onClick={() => downloadFile(api.sales.url('/exports/leads', { ...query, format: 'XLSX' }), 'leads.xlsx').catch(toast.error)}><Icon name="download" size={13} /> Export</button>}
          {can('crm.create') && <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={13} /> New lead</button>}
        </div>
      </div>
      <div className="filters">
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search name, phone, email, ref" aria-label="Search leads" value={filters.q} onChange={(e) => { setPage(1); setFilters({ ...filters, q: e.target.value }); }} />
        <select className="select" aria-label="Category" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
          <option value="">Every category</option>{Object.entries(CATEGORY).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
        </select>
        <select className="select" aria-label="Owner" value={filters.owner_id} onChange={(e) => setFilters({ ...filters, owner_id: e.target.value })}>
          <option value="">Any owner</option><option value="none">Nobody</option>{meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
        <select className="select" aria-label="Source" value={filters.source_id} onChange={(e) => setFilters({ ...filters, source_id: e.target.value })}>
          <option value="">Any source</option>{meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="select" aria-label="Sort" value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })}>
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="score">Highest score</option>
          <option value="follow_up">Next follow-up</option><option value="activity">Recent activity</option><option value="organization">Organization A–Z</option>
        </select>
        {savedViews.length > 0 && (
          <select className="select" aria-label="Saved views" value="" onChange={(e) => { const v = savedViews.find((x) => String(x.id) === e.target.value); if (v) { const { view: vv, ...f } = v.filters; setFilters({ ...filters, ...f }); if (vv) setView(vv); } }}>
            <option value="">Saved views…</option>{savedViews.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={saveView}>Save this view</button>
      </div>
      {view === 'telecrm' && routing && <TeleCrmQueue onChanged={load} />}
      {view === 'needs_classification' && routing && <div className="mkt-callout small">These arrived without a category we could trust. Open one to classify it: B2B or CSR/NGO enters Taskflow (and is assigned), retailer, FPO and individual go to the TeleCRM queue. Nothing here is lost or deleted.</div>}
      {selected.size > 0 && (
        <div className="row wrap sales-bulk" role="region" aria-label="Bulk actions">
          <strong className="small">{selected.size} selected</strong>
          {can('crm.assign') && <button type="button" className="btn btn-sm" onClick={() => setBulk('assign')}>Assign…</button>}
          <button type="button" className="btn btn-sm" onClick={() => setBulk('priority')}>Priority…</button>
          <button type="button" className="btn btn-sm" onClick={() => setBulk('tag')}>Tag…</button>
          {routing && <button type="button" className="btn btn-sm" onClick={() => setBulk('category')}>Category…</button>}
          <button type="button" className="btn btn-sm" onClick={() => setBulk('archive')}>Archive…</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      {!data ? <Spinner /> : data.error ? <EmptyState title="Could not load leads">{data.error}</EmptyState> : data.leads.length === 0 ? (
        <EmptyState title={view === 'open' ? 'No open leads' : 'Nothing in this view'}>
          {view === 'open' ? 'New enquiries from forms, imports, the API and people appear here.' : 'Try another view or clear the filters.'}
        </EmptyState>
      ) : (
        <>
          <div className="table-scroll sales-table-wrap">
            <table className="data-table sales-table">
              <thead><tr>
                <th><input type="checkbox" aria-label="Select all on this page" checked={selected.size === data.leads.length} onChange={(e) => setSelected(e.target.checked ? new Set(data.leads.map((l) => l.id)) : new Set())} /></th>
                <th>Lead</th><th>Category</th><th>Status</th><th>Owner</th><th>Score</th><th>Next follow-up</th><th>Last activity</th><th>Source</th>
              </tr></thead>
              <tbody>{data.leads.map((l) => (
                <tr key={l.id} className={l.overdue_followups ? 'is-late' : ''}>
                  <td><input type="checkbox" aria-label={`Select ${l.ref}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} /></td>
                  <td className="sales-lead-cell">
                    <Link to={`/sales/leads/${l.id}`} style={{ fontWeight: 600 }}>{l.organization_name || l.contact_name || l.ref}</Link>
                    <div className="small muted">{l.ref}{l.contact_name && l.organization_name ? ` · ${l.contact_name}` : ''}</div>
                  </td>
                  <td><CategoryBadge category={l.category} />{l.destination !== 'TASKFLOW' && <> <DestinationBadge destination={l.destination} /></>}</td>
                  <td><LeadStatusBadge status={l.status} />{l.is_stale && <> <Badge tone="warning">stale</Badge></>}</td>
                  <td>{l.owner_name || <span className="muted">Nobody</span>}</td>
                  <td className="tnum">{l.effective_score ?? '—'}</td>
                  <td>{l.next_followup_due ? <span className={new Date(l.next_followup_due) < new Date() ? 'critical-text' : ''}>{when(l.next_followup_due)}</span> : <span className="muted">none</span>}</td>
                  <td className="small">{l.last_activity_at ? when(l.last_activity_at) : '—'}</td>
                  <td className="small">{l.original_source_name || l.source_name || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="sales-cards">
            {data.leads.map((l) => (
              <button key={l.id} type="button" className="link-row sales-card" onClick={() => navigate(`/sales/leads/${l.id}`)}>
                <div className="grow stack-xs" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}><CategoryBadge category={l.category} /><span className="truncate" style={{ fontWeight: 600 }}>{l.organization_name || l.contact_name}</span></div>
                  <div className="small muted">{l.ref} · {l.owner_name || 'unassigned'} · {l.next_followup_due ? `next ${when(l.next_followup_due)}` : 'no follow-up'}</div>
                </div>
                <LeadStatusBadge status={l.status} />
              </button>
            ))}
          </div>
          <div className="row-between small">
            <span className="muted">{data.total} lead{data.total === 1 ? '' : 's'}</span>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {page} of {Math.max(1, Math.ceil(data.total / data.page_size))}</span>
              <button type="button" className="btn btn-sm" disabled={page * data.page_size >= data.total} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
        </>
      )}
      {creating && <NewLeadDialog meta={meta} onClose={() => setCreating(false)} onSaved={(lead) => (lead.destination === 'TASKFLOW' ? navigate(`/sales/leads/${lead.id}`) : load())} />}
      {bulk && <BulkDialog kind={bulk} meta={meta} count={selected.size} onClose={() => setBulk(null)} onRun={runBulk} />}
    </div>
  );
}

function BulkDialog({ kind, meta, count, onClose, onRun }) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const needsReason = ['assign', 'category', 'archive'].includes(kind);
  return (
    <Modal title={`${{ assign: 'Assign', priority: 'Set priority of', tag: 'Tag', category: 'Reclassify', archive: 'Archive' }[kind]} ${count} lead${count === 1 ? '' : 's'}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={(kind !== 'archive' && !value) || (needsReason && reason.trim().length < 3)} onClick={() => onRun(kind, kind === 'assign' ? Number(value) : value, reason)}>Apply</button></>}>
      <div className="stack">
        {kind === 'assign' && <select className="select" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Choose…</option>{meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>}
        {kind === 'priority' && <select className="select" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Choose…</option>{Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
        {kind === 'tag' && <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="kharif-2026" />}
        {kind === 'category' && <select className="select" value={value} onChange={(e) => setValue(e.target.value)}><option value="">Choose…</option>{Object.entries(CATEGORY).filter(([k]) => k !== 'UNCLASSIFIED').map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</select>}
        {needsReason && <Field label="Why (kept on each lead's history) *"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <div className="small muted">Each lead is checked on its own; any you may not change are listed as refused.</div>
      </div>
    </Modal>
  );
}

/** The TeleCRM hand-off: export, then confirm each one in TeleCRM. */
function TeleCrmQueue({ onChanged }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [status, setStatus] = useState('PENDING');
  const load = useCallback(() => api.sales.get('/routing/handoffs', { status }).then((r) => setList(r.handoffs)).catch(() => setList([])), [status]);
  useEffect(() => { load(); }, [load]);
  const exportNow = async () => {
    if (!list?.length) return;
    try {
      await postDownload(api.sales.url('/routing/handoffs/export'), { ids: list.map((h) => h.id), format: 'XLSX' }, `telecrm-handoff-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success('Exported. Upload the file to TeleCRM, then confirm each lead here.');
      load(); onChanged();
    } catch (err) { toast.error(err); }
  };
  const confirm = async (h, failed = false) => {
    const note = window.prompt(failed ? 'What went wrong?' : 'TeleCRM reference (optional)') ?? null;
    if (failed && !note) return;
    try {
      await api.sales.post(`/routing/handoffs/${h.id}/confirm`, failed ? { failed: true, error: note } : { external_id: note || null });
      toast.success(failed ? 'Marked as failed' : 'Confirmed in TeleCRM');
      load(); onChanged();
    } catch (err) { toast.error(err); }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>TeleCRM hand-off</h3>
        <div className="row" style={{ gap: 6 }}>
          <select className="select" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Hand-off status">
            <option value="PENDING">Waiting to export</option><option value="EXPORTED">Exported, to confirm</option><option value="CONFIRMED">Confirmed</option><option value="FAILED">Failed</option>
          </select>
          {status === 'PENDING' && <button type="button" className="btn btn-sm btn-primary" disabled={!list?.length} onClick={exportNow}>Export {list?.length || 0} for TeleCRM</button>}
        </div>
      </div>
      <div className="card-pad stack-sm">
        <div className="small muted">No TeleCRM API is connected: leads are handed over by exporting this file and uploading it to TeleCRM. Only a person confirming it marks a lead as handed over.</div>
        {!list ? <Spinner /> : list.length === 0 ? <div className="empty small">Nothing here.</div> : list.slice(0, 50).map((h) => (
          <div key={h.id} className="sales-row small">
            <Badge tone="warning">{CATEGORY[h.lead_category || h.account_category]?.short || 'TeleCRM'}</Badge>
            {h.lead_id ? <Link to={`/sales/leads/${h.lead_id}`} className="grow truncate">{h.lead_ref} {h.organization_name || h.contact_name}</Link>
              : <Link to={`/accounts/${h.account_id}`} className="grow truncate">{h.account_name}</Link>}
            <span className="muted">{h.status.toLowerCase()}{h.exported_at ? ` · exported ${dayOf(h.exported_at)}` : ''}{h.external_id ? ` · ${h.external_id}` : ''}</span>
            {status === 'EXPORTED' && <><button type="button" className="btn btn-sm" onClick={() => confirm(h)}>Confirm</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => confirm(h, true)}>Failed</button></>}
          </div>
        ))}
      </div>
    </div>
  );
}

export { money };
