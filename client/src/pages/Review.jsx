import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Spinner } from '../components/ui.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { formatDate, fromDateTimeLocal } from '../lib/format.js';

const ACTIONS = [
  ['', 'Choose…'],
  ['NEW_DATE', 'Keep it, with a new date'],
  ['BLOCKED', 'It is blocked'],
  ['DONE', 'It is done (with evidence)'],
  ['DEFER', 'Defer it'],
];
// What the overdue list can be filtered by. The first four are always shown.
const FILTERS = [
  { key: 'project_id', label: 'Project', all: 'All projects', none: 'No projects', main: true },
  { key: 'goal_id', label: 'Goal', all: 'All goals', none: 'No goals linked', main: true },
  { key: 'department_id', label: 'Department', all: 'All departments', none: 'No departments', main: true },
  { key: 'assignee_id', label: 'Owner', all: 'Any owner', none: 'No owners', main: true },
  { key: 'supporter_id', label: 'Supporter', all: 'Any supporter' },
  { key: 'reporter_id', label: 'Reported by', all: 'Any reporter' },
  { key: 'account_id', label: 'Lead or organisation', all: 'Any organisation' },
  { key: 'opportunity_id', label: 'Deal', all: 'Any deal' },
  { key: 'tag', label: 'Tag', all: 'Any tag' },
  { key: 'priority', label: 'Priority', all: 'Any priority' },
  { key: 'stage', label: 'Status', all: 'Any status' },
  { key: 'task_type', label: 'Type', all: 'Any type' },
];
const AGES = [['', 'Any time overdue'], ['1', 'Over a day late'], ['7', 'Over a week late'], ['30', 'Over a month late']];
const SORTS = [['', 'Oldest first'], ['newest', 'Most recent first'], ['priority', 'Highest priority first']];
const GROUPS = [['', 'No grouping'], ['project', 'Group by project'], ['goal', 'Group by goal'], ['department', 'Group by department'], ['owner', 'Group by owner']];
const SCOPES = [['mine', 'Mine'], ['team', 'My team'], ['all', 'All']];
// URL keys that only change how the page shows the list, not what the server returns
const VIEW_ONLY = ['group'];
const words = (text) => String(text).replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The group a task falls under, as [key, heading]. */
function groupOf(t, by) {
  if (by === 'project') {
    if (t.parent_task_id) return [`p${t.parent_task_id}`, `${t.parent_ref} ${t.parent_title}`];
    if (t.subtask_count > 0) return [`p${t.id}`, `${t.ref} ${t.title}`];
    return ['', 'Not in a project'];
  }
  if (by === 'goal') return t.goals?.length ? [`g${t.goals[0].id}`, t.goals[0].title] : ['', 'Not linked to a goal'];
  if (by === 'department') return [`d${t.department_id}`, t.department_name];
  if (by === 'owner') return t.assignee_id ? [`u${t.assignee_id}`, t.assignee_name] : ['', 'No owner'];
  return ['all', ''];
}

const plusDays = (n) => new Date(Date.now() + n * 86_400_000);
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** One row's choice and the fields it needs. */
function ChoiceFields({ choice, onChange }) {
  const set = (k) => (e) => onChange({ ...choice, [k]: e.target.value });
  if (!choice?.action) return null;
  return (
    <div className="review-fields">
      {choice.action === 'NEW_DATE' && (
        <>
          <label className="small">New deadline <input type="datetime-local" className="input" value={choice.due || ''} onChange={set('due')} /></label>
          <label className="small grow">Why <input className="input" value={choice.reason || ''} onChange={set('reason')} placeholder="What changed" /></label>
        </>
      )}
      {choice.action === 'BLOCKED' && (
        <label className="small grow">Waiting on <input className="input" value={choice.reason || ''} onChange={set('reason')} placeholder="What it is waiting for" /></label>
      )}
      {choice.action === 'DONE' && (
        <>
          <label className="small grow">What was done <input className="input" value={choice.evidence || ''} onChange={set('evidence')} placeholder="The evidence: what, where, when" /></label>
          <label className="small">Link (optional) <input className="input" value={choice.evidence_url || ''} onChange={set('evidence_url')} placeholder="https://…" /></label>
        </>
      )}
      {choice.action === 'DEFER' && (
        <>
          <label className="small grow">Why <input className="input" value={choice.reason || ''} onChange={set('reason')} /></label>
          <label className="small grow">Next action <input className="input" value={choice.next_action || ''} onChange={set('next_action')} /></label>
          <label className="small">Review on <input type="date" className="input" value={choice.review_date || ''} onChange={set('review_date')} /></label>
        </>
      )}
    </div>
  );
}

/**
 * The overdue review: each overdue task gets a decision — a new date, blocked,
 * done with evidence, or deferred. Every change is previewed before anything is
 * saved. Below, the requests and blocks waiting for your decision.
 */
export default function Review() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [waiting, setWaiting] = useState({ changes: [], blocks: [], my_requests: [] });
  const [choices, setChoices] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openTask, setOpenTask] = useState(null);
  const [params, setParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [reloads, setReloads] = useState(0);
  const scope = params.get('scope') || 'mine';
  const group = params.get('group') || '';
  const [search, setSearch] = useState(params.get('search') || '');
  const moreSet = FILTERS.filter((f) => !f.main && params.get(f.key)).length;
  const [showMore, setShowMore] = useState(moreSet > 0);

  // everything in the address except how the list is grouped goes to the server
  const serverQuery = useMemo(() => {
    const q = new URLSearchParams(params);
    VIEW_ONLY.forEach((k) => q.delete(k));
    q.set('scope', scope);
    return q.toString();
  }, [params, scope]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get(`/task-review/overdue?${serverQuery}`)
      .then((d) => { if (live) setData(d); })
      .catch((err) => toast.error(err))
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverQuery, reloads]);
  const load = useCallback(() => {
    setReloads((n) => n + 1);
    api.get('/task-review/waiting').then(setWaiting).catch(() => {});
  }, []);
  useEffect(() => { api.get('/task-review/waiting').then(setWaiting).catch(() => {}); }, []);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  // the search box waits for a pause in typing
  useEffect(() => {
    if (search === (params.get('search') || '')) return undefined;
    const timer = setTimeout(() => setParam('search', search.trim()), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const filtersSet = FILTERS.filter((f) => params.get(f.key)).length
    + (params.get('overdue_days') ? 1 : 0) + (params.get('waiting') ? 1 : 0) + (params.get('search') ? 1 : 0);
  const clearFilters = () => {
    const next = new URLSearchParams();
    ['scope', 'group', 'sort'].forEach((k) => params.get(k) && next.set(k, params.get(k)));
    setSearch('');
    setParams(next, { replace: true });
  };

  const tasks = useMemo(() => data?.tasks || [], [data]);
  const groups = useMemo(() => {
    const map = new Map();
    for (const t of tasks) {
      const [key, heading] = groupOf(t, group);
      if (!map.has(key)) map.set(key, { key, heading, tasks: [] });
      map.get(key).tasks.push(t);
    }
    // largest first; "not in a project" and the like last
    return [...map.values()].sort((a, b) => (a.key === '') - (b.key === '') || b.tasks.length - a.tasks.length);
  }, [tasks, group]);
  const hiddenChosen = Object.keys(choices).filter((id) => !tasks.some((t) => t.id === Number(id))).length;
  const setChoice = (taskId, value) => {
    setPreview(null);
    setChoices((c) => {
      const next = { ...c };
      if (!value?.action) delete next[taskId];
      else next[taskId] = value;
      return next;
    });
  };
  const items = Object.entries(choices).map(([taskId, c]) => ({
    task_id: Number(taskId), ...c, due: c.due ? fromDateTimeLocal(c.due) : undefined,
  }));

  const runPreview = async () => {
    setBusy(true);
    try { setPreview(await api.post('/task-review/preview', { items })); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const { results } = await api.post('/task-review/apply', { items });
      const failed = results.filter((r) => !r.ok);
      const waits = results.filter((r) => r.ok && r.status === 'PENDING').length;
      if (failed.length) toast.error(`${failed.length} could not be saved: ${failed[0].error}`);
      else toast.success(`Saved ${results.length}${waits ? `; ${waits} waiting for approval` : ''}`);
      setChoices({});
      setPreview(null);
      load();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const decide = async (path, message, needsNote = false) => {
    let note;
    if (needsNote) {
      note = window.prompt('Why? The person who asked will see this.');
      if (!note) return;
    }
    try { await api.post(path, note ? { note } : {}); toast.success(message); load(); } catch (err) { toast.error(err); }
  };

  if (!data) return <Spinner label="Loading the review" />;

  const filterSelect = (f) => {
    const options = data.facets?.[f.key] || [];
    const value = params.get(f.key) || '';
    // choices that match nothing with the other filters are left out, unless chosen
    const shown = options.filter((o) => o.count > 0 || o.value === value);
    if (!f.main && options.length === 0 && !value) return null;
    const label = (o) => (f.key === 'priority' || f.key === 'task_type' ? words(o.label) : o.label);
    return (
      <select
        key={f.key}
        className="select"
        aria-label={f.label}
        title={value ? `${f.label}: ${label(options.find((o) => o.value === value) || { label: value })}` : undefined}
        value={value}
        disabled={options.length === 0 && !value}
        onChange={(e) => setParam(f.key, e.target.value)}
      >
        <option value="">{options.length === 0 ? f.none || f.all : f.all}</option>
        {shown.map((o) => <option key={o.value} value={o.value}>{label(o)} ({o.count})</option>)}
      </select>
    );
  };
  const renderRow = (t) => {
    const choice = choices[t.id];
    const project = t.parent_task_id ? `${t.parent_ref} ${t.parent_title}` : null;
    return (
      <div key={t.id} className="review-row">
        <div className="grow stack-xs">
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" className="link-button" onClick={() => setOpenTask(t.id)}><span className="task-ref">{t.ref}</span> {t.title}</button>
            <Badge tone={t.health?.tone || 'critical'}>{t.health?.text || 'Overdue'}</Badge>
            {t.stage === 'blocked' && <Badge tone="serious">Blocked</Badge>}
            {t.stage === 'backlog' && <Badge tone="neutral">Backlog</Badge>}
            {t.pending_change && <Badge tone="warning">Request waiting</Badge>}
          </div>
          <div className="row wrap small muted" style={{ gap: 6 }}>
            {!t.mine && <><Avatar userId={t.assignee_id} name={t.assignee_name || '?'} color={t.assignee_color} size={18} /> {t.assignee_name || 'No owner'} ·{' '}</>}
            Was due {formatDate(t.due_date, { withTime: true })}
            {t.due_date_changes > 0 && ` · moved ${t.due_date_changes} time${t.due_date_changes === 1 ? '' : 's'}`}
            {t.next_action && ` · Next: ${t.next_action}`}
          </div>
          <div className="review-context small">
            <span>{t.department_name}</span>
            {group !== 'project' && project && <span>Project: {project}</span>}
            {group !== 'project' && !project && t.subtask_count > 0 && <span>Project, {t.subtask_count} subtask{t.subtask_count === 1 ? '' : 's'}</span>}
            {(t.goals || []).filter((g, i) => group !== 'goal' || i > 0).map((g) => <span key={g.id}>Goal: {g.title}</span>)}
            {t.account_name && <span>{t.account_name}{t.opportunity_name ? ` · ${t.opportunity_name}` : ''}</span>}
            {(t.tags || []).map((tag) => <span key={tag} className="kind-chip is-static kind-info">{tag}</span>)}
          </div>
          <ChoiceFields choice={choice} onChange={(v) => setChoice(t.id, v)} />
        </div>
        <label className="small">
          <span className="sr-only">Decision for {t.ref}</span>
          <select
            className="select"
            value={choice?.action || ''}
            onChange={(e) => setChoice(t.id, e.target.value ? {
              action: e.target.value,
              ...(e.target.value === 'NEW_DATE' ? { due: localInput(plusDays(2)) } : {}),
              ...(e.target.value === 'DEFER' ? { review_date: plusDays(14).toISOString().slice(0, 10), next_action: t.next_action || '' } : {}),
            } : null)}
          >
            {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
    );
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div>
        <h1>Overdue review</h1>
        <div className="small muted">
          Decide each overdue task: keep it with a new date, say it is blocked, close it with evidence, or defer it.
          Nothing is saved until you have seen the preview. Deadlines never change without a reason, and overdue history is kept.
        </div>
      </div>

      {(waiting.changes.length > 0 || waiting.blocks.length > 0) && (
        <section className="card" aria-labelledby="waiting-head">
          <div className="card-head"><h2 id="waiting-head">Waiting for your decision</h2><Badge tone="warning">{waiting.changes.length + waiting.blocks.length}</Badge></div>
          <div className="card-pad stack-sm">
            {waiting.changes.map((c) => (
              <div key={`c${c.id}`} className="review-row">
                <div className="grow">
                  <button type="button" className="link-button" onClick={() => setOpenTask(c.task_id)}>{c.ref} {c.title}</button>
                  <div className="small muted">
                    {c.kind === 'DEFER' ? `Defer, review on ${c.review_date}` : `New deadline ${formatDate(c.to_due, { withTime: true })} (was ${formatDate(c.from_due, { withTime: true })})`}
                    {' '}· asked by {c.requested_by_name}{c.owner_name && c.owner_name !== c.requested_by_name ? ` for ${c.owner_name}` : ''} · “{c.reason}”
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => decide(`/task-review/changes/${c.id}/approve`, 'Approved')}>Approve</button>
                  <button type="button" className="btn btn-sm" onClick={() => decide(`/task-review/changes/${c.id}/decline`, 'Declined', true)}>Decline…</button>
                </div>
              </div>
            ))}
            {waiting.blocks.map((b) => (
              <div key={`b${b.id}`} className="review-row">
                <div className="grow">
                  <button type="button" className="link-button" onClick={() => setOpenTask(b.task_id)}>{b.ref} {b.title}</button>
                  <div className="small muted">Blocked: {b.reason} · recorded by {b.recorded_by_name}. Accepting it pauses black marks while it lasts.</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => decide(`/task-review/blocks/${b.id}/accept`, 'Block accepted')}>Accept</button>
                  <button type="button" className="btn btn-sm" onClick={() => decide(`/task-review/blocks/${b.id}/decline`, 'Not accepted', true)}>Not accepted…</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {waiting.my_requests.length > 0 && (
        <div className="small muted">
          You are waiting on {waiting.my_requests.length} decision{waiting.my_requests.length === 1 ? '' : 's'}: {waiting.my_requests.map((r) => r.ref).join(', ')}.
        </div>
      )}

      <section className="card" aria-labelledby="overdue-head">
        <div className="card-head">
          <h2 id="overdue-head">Overdue</h2>
          <div className="row" style={{ gap: 2, background: 'var(--surface-3)', padding: 2, borderRadius: 8 }} role="group" aria-label="Whose work">
            {SCOPES.map(([key, label]) => {
              const n = key === 'mine' ? data.mine : key === 'team' ? data.team : data.mine + data.team;
              return (
                <button key={key} type="button" className={`btn btn-sm ${scope === key ? '' : 'btn-ghost'}`} aria-pressed={scope === key} onClick={() => setParam('scope', key === 'mine' ? '' : key)}>
                  {label} ({n})
                </button>
              );
            })}
          </div>
        </div>
        <div className="card-pad stack-sm review-filter-bar" role="search" aria-label="Filter the overdue list">
          <div className="filters">
            <input
              className="input review-search"
              type="search"
              placeholder="Search"
              aria-label="Search the overdue list by ID, title or next step"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {FILTERS.filter((f) => f.main).map(filterSelect)}
          </div>
          <div className="review-filter-foot">
            <div className="row wrap" style={{ gap: 8 }} aria-live="polite">
              <span>
                {loading ? 'Updating…' : filtersSet > 0
                  ? `Showing ${data.matching} of ${data.total} overdue`
                  : `${data.total} overdue`}
              </span>
              {filtersSet > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
            </div>
            <div className="filters">
              <button type="button" className="btn btn-sm" aria-expanded={showMore} aria-controls="review-more-filters" onClick={() => setShowMore((v) => !v)}>
                {showMore ? 'Fewer filters' : `More filters${moreSet ? ` (${moreSet})` : ''}`}
              </button>
              <select className="select" aria-label="Group the list" value={group} onChange={(e) => setParam('group', e.target.value)}>
                {GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select className="select" aria-label="Sort the list" value={params.get('sort') || ''} onChange={(e) => setParam('sort', e.target.value)}>
                {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          {showMore && (
            <div className="filters" id="review-more-filters">
              {FILTERS.filter((f) => !f.main).map(filterSelect)}
              <select className="select" aria-label="Overdue for" value={params.get('overdue_days') || ''} onChange={(e) => setParam('overdue_days', e.target.value)}>
                {AGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={params.get('waiting') === '1'} onChange={(e) => setParam('waiting', e.target.checked ? '1' : '')} />
                Only with a request or block waiting
              </label>
            </div>
          )}
          {data.capped && <div className="small warning-text">More than 2,000 tasks are overdue here. The choices and counts cover the oldest 2,000.</div>}
        </div>
        <div className="card-pad stack-sm">
          {tasks.length === 0 && (filtersSet > 0
            ? <EmptyState title="Nothing overdue matches these filters" action={<button type="button" className="btn btn-sm" onClick={clearFilters}>Clear filters</button>} />
            : <EmptyState title={scope === 'mine' ? 'Nothing of yours is overdue' : 'Nothing overdue in your scope'} />)}
          {group
            ? groups.map((g) => (
              <section key={g.key || 'none'} className="review-group-block" aria-label={`${g.heading}: ${g.tasks.length} overdue`}>
                <h3 className="review-group-head">{g.heading} <span className="muted">{g.tasks.length}</span></h3>
                {g.tasks.map(renderRow)}
              </section>
            ))
            : tasks.map(renderRow)}
          {data.matching > tasks.length && <div className="small muted">Showing the first {tasks.length} of {data.matching}. Narrow the filters to see the rest.</div>}
        </div>
        {items.length > 0 && (
          <div className="card-pad stack-sm review-footer">
            {preview && (
              <ul className="plain-list small stack-xs" aria-live="polite">
                {preview.items.map((p) => (
                  <li key={p.task_id} className={p.ok ? '' : 'critical-text'}>
                    <strong>{p.ref || `#${p.task_id}`}</strong>: {p.ok ? p.effect : p.error}{p.note ? ` (${p.note})` : ''}
                  </li>
                ))}
              </ul>
            )}
            <div className="row wrap" style={{ gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={runPreview}>Preview {items.length} change{items.length === 1 ? '' : 's'}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !preview?.ready} onClick={apply}>Save {items.length}</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setChoices({}); setPreview(null); }}>Clear</button>
              {!preview && <span className="small muted">Preview first: nothing is saved until you have seen what will happen.</span>}
            </div>
            {hiddenChosen > 0 && (
              <div className="small warning-text">
                {hiddenChosen} of your choices {hiddenChosen === 1 ? 'is on a task' : 'are on tasks'} hidden by the filters. {hiddenChosen === 1 ? 'It is' : 'They are'} still in the preview and will be saved too.
              </div>
            )}
          </div>
        )}
      </section>

      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
    </div>
  );
}
