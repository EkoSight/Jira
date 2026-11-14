/**
 * My workspace widgets. Each one loads its own data from an endpoint that
 * checks permissions itself, so one failing widget never blanks the page,
 * and each has a loading, empty, error and "not available" state.
 *
 * A widget's count comes from the same request as the list its "Open" link
 * shows: the task widgets ask /tasks with exactly the board's filters, the CRM
 * widgets ask the same work queue as Sales → My Day.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../state/AppState.jsx';
import { Badge, Icon, Spinner } from '../ui.jsx';
import { TodayAttendanceCard } from '../Attendance.jsx';
import { OverviewStats, WorkloadCard } from '../../pages/Dashboard.jsx';
import { healthLabel } from '../../../../shared/deadlineHealth.js';
import { SCOPE_LABEL, WIDGET_TYPES, boardLink, taskWidgetFilters, widgetTitle } from '../../../../shared/workspaceWidgets.js';
import { addDays } from '../../../../shared/deadlineHealth.js';
import { deadlineClock } from '../../lib/format.js';
import { localDay, whenWords } from '../../lib/workspace.js';

/** Loads a widget's data; `retry` loads it again. */
export function useWidgetData(loader, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const load = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(loader)
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((error) => { if (alive) setState({ loading: false, data: null, error }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(load, [load]);
  return { ...state, retry: load };
}

/** The frame every widget shares: heading, scope, count, Open, and the states. */
export function WidgetFrame({ widget, count = null, drill = null, scope = null, state = null, empty = null, children, actions = null }) {
  const title = widgetTitle(widget);
  const headingId = `w-${widget.id}`;
  let body = children;
  if (state?.loading && !state.data) body = <div className="ws-state"><Spinner label={`Loading ${title.toLowerCase()}`} /></div>;
  else if (state?.error) {
    const forbidden = state.error.status === 403 || state.error.status === 404;
    body = (
      <div className="ws-state" role="status">
        {forbidden ? (
          <span className="muted">Not available to you</span>
        ) : (
          <>
            <span>Could not load this: {state.error.message}</span>
            <button type="button" className="btn btn-sm" onClick={state.retry}>Retry</button>
          </>
        )}
      </div>
    );
  } else if (empty) body = <div className="ws-state ws-empty">{empty}</div>;
  return (
    <section className="card ws-widget" aria-labelledby={headingId}>
      <div className="card-head">
        <h2 id={headingId} className="row" style={{ gap: 8 }}>
          {title}
          {count != null && <span className="ws-count tnum" aria-label={`${count} items`}>{count}</span>}
        </h2>
        <div className="row" style={{ gap: 6 }}>
          {scope && <span className="small muted">{scope}</span>}
          {actions}
          {drill && <Link className="btn btn-ghost btn-sm" to={drill}>Open<span className="sr-only"> {title}</span> <Icon name="chevron" size={13} /></Link>}
        </div>
      </div>
      <div className="ws-body">{body}</div>
    </section>
  );
}

/** A widget the person cannot use, or one the product no longer has. */
export function UnavailableWidget({ widget, onRemove }) {
  const retired = widget.retired;
  return (
    <section className="card ws-widget ws-unavailable" aria-label={retired ? 'A widget that is no longer available' : `${widgetTitle(widget)}: not available`}>
      <div className="card-pad row-between wrap">
        <span className="muted">{retired ? 'This widget is no longer available' : `${widgetTitle(widget)}: ${widget.why || 'Not available to you'}`}</span>
        {onRemove && <button type="button" className="btn btn-sm" onClick={onRemove}>Remove</button>}
      </div>
    </section>
  );
}

const rowsOf = (w) => w.config?.rows || 5;
const scopeWords = (w) => SCOPE_LABEL[w.config?.scope || 'mine'];

// ---------------------------------------------------------------- tasks

function TaskRows({ tasks, onOpenTask }) {
  const c = deadlineClock();
  return (
    <ul className="ws-list">
      {tasks.map((t) => {
        const h = healthLabel(t, c);
        return (
          <li key={t.id}>
            <button type="button" className="ws-row" onClick={() => onOpenTask?.(t.id)}>
              <span className="grow truncate"><span className="task-ref">{t.ref}</span> {t.title}</span>
              <Badge tone={h.tone}>{h.label}</Badge>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** My tasks and Deadlines coming up: the board's own query, so the count is the board's. */
function TaskListWidget({ widget, onOpenTask, refreshKey }) {
  const { user } = useAuth();
  const tz = deadlineClock().timezone;
  const filters = taskWidgetFilters(widget.type, widget.config || {}, {
    userId: user.id, departmentId: user.department_id, today: localDay(new Date(), tz), addDays,
  });
  const key = JSON.stringify(filters);
  const state = useWidgetData(
    () => api.tasks({ ...filters, sort: widget.config?.sort || 'due_date', limit: rowsOf(widget) }),
    [key, rowsOf(widget), widget.config?.sort, refreshKey],
  );
  const d = state.data;
  const words = widget.type === 'deadlines' ? `No deadlines in the next ${widget.config?.range || 7} days` : 'Nothing open here. Add a task when there is work to track';
  return (
    <WidgetFrame widget={widget} state={state} count={d ? d.total : null} drill={boardLink(filters)} scope={scopeWords(widget)}
      empty={d && !d.tasks.length ? words : null}>
      {d && <TaskRows tasks={d.tasks} onOpenTask={onOpenTask} />}
      {d && d.total > d.tasks.length && <div className="small muted ws-more">{d.total - d.tasks.length} more on the board</div>}
    </WidgetFrame>
  );
}

/** One of the person's saved task views, compact. */
function SavedViewWidget({ widget, onOpenTask, refreshKey }) {
  const viewId = widget.config?.view_id;
  const state = useWidgetData(async () => {
    const { views } = await api.get('/task-views');
    const view = views.find((v) => v.id === viewId) || null;
    if (!view) return { view: null };
    const q = Object.fromEntries(new URLSearchParams(view.query));
    const list = await api.tasks({ ...q, limit: rowsOf(widget), hide_done: 'true' });
    return { view, list };
  }, [viewId, rowsOf(widget), refreshKey]);
  const d = state.data;
  if (d && !d.view) {
    return <WidgetFrame widget={widget} state={state} empty={viewId ? 'That saved view is gone. Choose another in this widget\'s settings' : 'Choose one of your saved views in this widget\'s settings'} />;
  }
  return (
    <WidgetFrame widget={{ ...widget, config: { ...widget.config, title: widget.config?.title || d?.view?.name } }} state={state}
      count={d ? d.list.total : null} drill={d ? `/board?${d.view.query}` : null}
      empty={d && !d.list.tasks.length ? 'No tasks match this view' : null}>
      {d && <TaskRows tasks={d.list.tasks} onOpenTask={onOpenTask} />}
    </WidgetFrame>
  );
}

// ---------------------------------------------------------------- today

function TodayWidget({ widget }) {
  const state = useWidgetData(() => api.standupMe().catch(() => null), []);
  const s = state.data;
  const posted = s?.submissions?.length > 0;
  return (
    <WidgetFrame widget={widget} drill="/attendance">
      <div className="stack-sm">
        <TodayAttendanceCard variant="widget" hideWhenUntracked />
        {s?.enabled && s.members?.length > 0 && (
          <div className="row-between wrap ws-line">
            <span>Daily standup: {s.working_day ? (posted ? 'posted' : 'not posted yet') : `not a working day${s.not_working_reason ? ` (${s.not_working_reason})` : ''}`}</span>
            {s.working_day && <Badge tone={posted ? 'good' : 'warning'}>{posted ? 'Posted' : 'To do'}</Badge>}
            <Link className="btn btn-sm" to="/standup">{posted ? 'See it' : 'Post it'}</Link>
          </div>
        )}
      </div>
    </WidgetFrame>
  );
}

// ---------------------------------------------------------------- goals, people, overview

function KeyResultsWidget({ widget }) {
  const state = useWidgetData(() => api.get('/workspace/widgets/key_results'), []);
  const d = state.data;
  const items = d?.items?.slice(0, rowsOf(widget)) || [];
  return (
    <WidgetFrame widget={widget} state={state} count={d ? d.total : null} drill="/goals"
      empty={d && !d.total ? 'None of your key results need a check-in' : null}>
      <ul className="ws-list">
        {items.map((k) => (
          <li key={k.key_result_id}>
            <Link className="ws-row" to={k.url}>
              <span className="grow truncate">{k.title} <span className="small muted">· {k.objective_title}</span></span>
              <Badge tone={k.severity === 'critical' ? 'critical' : 'warning'}>{k.detail}</Badge>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}

function DashboardWidget({ widget, part }) {
  const state = useWidgetData(() => api.dashboard({}), []);
  const goToBoard = (params) => { window.location.assign(`/board?${new URLSearchParams(params)}`); };
  const d = state.data;
  return (
    <WidgetFrame widget={widget} state={state} drill={part === 'workload' ? '/team' : '/overview'}
      empty={d && part === 'workload' && !d.workload.length ? 'Nobody to show yet' : null}>
      {d && part === 'overview' && <div className="ws-pad"><OverviewStats summary={d.summary} goToBoard={goToBoard} /></div>}
      {d && part === 'workload' && <WorkloadCard workload={d.workload} goToBoard={goToBoard} title="By person" />}
    </WidgetFrame>
  );
}

function RecognitionWidget({ widget }) {
  const { user } = useAuth();
  const state = useWidgetData(() => api.kudos({ user_id: user.id }), [user.id]);
  const list = state.data?.kudos?.slice(0, rowsOf(widget)) || [];
  return (
    <WidgetFrame widget={widget} state={state} drill="/recognition" empty={state.data && !list.length ? 'No kudos yet' : null}>
      <ul className="ws-list">
        {list.map((k) => (
          <li key={k.id} className="ws-row ws-static">
            <span className="grow truncate">{k.from_name}: {k.message}</span>
            <span className="small muted">{whenWords({ date: localDay(k.created_at, 'Asia/Kolkata') })}</span>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}

const MARK_TONE = { active: 'critical', waived: 'good' };
function BlackMarksWidget({ widget }) {
  const { user } = useAuth();
  const state = useWidgetData(() => api.blackMarks({ user_id: user.id }), [user.id]);
  const marks = (state.data?.marks || []).filter((m) => m.user_id === user.id);
  return (
    <WidgetFrame widget={widget} state={state} count={state.data ? marks.length : null} drill="/black-marks" scope="Yours only"
      empty={state.data && !marks.length ? 'You have no black marks' : null}>
      <ul className="ws-list">
        {marks.slice(0, rowsOf(widget)).map((m) => (
          <li key={m.id} className="ws-row ws-static">
            <span className="grow truncate">{m.reason}{m.task_ref ? ` · ${m.task_ref}` : ''}</span>
            <Badge tone={MARK_TONE[m.status] || 'neutral'}>{m.status === 'waived' ? 'Waived' : 'Active'}</Badge>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}

function NotesWidget({ widget }) {
  const state = useWidgetData(() => api.notes({}), []);
  const pinned = (state.data?.notes || []).filter((n) => n.is_pinned);
  return (
    <WidgetFrame widget={widget} state={state} count={state.data ? pinned.length : null} drill="/notes"
      empty={state.data && !pinned.length ? 'No pinned notes. Pin a note to keep it here' : null}>
      <ul className="ws-list">
        {pinned.slice(0, rowsOf(widget)).map((n) => (
          <li key={n.id} className="ws-row ws-static"><span className="grow truncate"><strong>{n.title || 'Untitled'}</strong> <span className="muted">{String(n.body || '').slice(0, 80)}</span></span></li>
        ))}
      </ul>
    </WidgetFrame>
  );
}

// ---------------------------------------------------------------- CRM (the same queue as Sales → My Day)

function LeadsToWorkWidget({ widget }) {
  const state = useWidgetData(() => api.sales.get('/work-queue', { page_size: rowsOf(widget) }), [rowsOf(widget)]);
  const d = state.data;
  const total = d ? d.groups.reduce((s, g) => s + g.count, 0) : null;
  return (
    <WidgetFrame widget={widget} state={state} count={d ? d.groups.find((g) => g.key === d.bucket)?.count ?? 0 : null} drill={d ? `/sales?tab=day&bucket=${d.bucket}` : '/sales?tab=day'}
      empty={d && total === 0 ? 'No leads waiting on you' : null}>
      {d && (
        <>
          <div className="row wrap ws-pad" style={{ gap: 6 }}>
            {d.groups.filter((g) => g.count).map((g) => (
              <Link key={g.key} className={`badge badge-${g.tone}`} to={`/sales?tab=day&bucket=${g.key}`}>{g.label}: {g.count}</Link>
            ))}
          </div>
          <div className="small muted ws-pad">Showing: {d.groups.find((g) => g.key === d.bucket)?.label}</div>
          <ul className="ws-list">
            {d.leads.map((l) => (
              <li key={l.id}><Link className="ws-row" to={`/sales/leads/${l.id}`}><span className="grow truncate">{l.display_name || l.organization_name || l.full_name || `Lead ${l.id}`}</span>{l.next_followup && <span className="small muted">{whenWords({ at: l.next_followup.due_date })}</span>}</Link></li>
            ))}
          </ul>
        </>
      )}
    </WidgetFrame>
  );
}

function FollowupsWidget({ widget }) {
  const state = useWidgetData(async () => {
    const overdue = await api.sales.get('/work-queue', { bucket: 'fu_overdue', page_size: rowsOf(widget) });
    const today = overdue.groups.find((g) => g.key === 'fu_today');
    return { overdue, todayCount: today?.count || 0 };
  }, [rowsOf(widget)]);
  const d = state.data;
  const overdueCount = d?.overdue.groups.find((g) => g.key === 'fu_overdue')?.count || 0;
  return (
    <WidgetFrame widget={widget} state={state} count={d ? overdueCount + d.todayCount : null} drill="/sales?tab=day&bucket=fu_overdue"
      empty={d && !overdueCount && !d.todayCount ? 'No follow-ups overdue or due today' : null}>
      {d && (
        <>
          <div className="row wrap ws-pad" style={{ gap: 6 }}>
            <Link className="badge badge-critical" to="/sales?tab=day&bucket=fu_overdue">Overdue: {overdueCount}</Link>
            <Link className="badge badge-brand" to="/sales?tab=day&bucket=fu_today">Due later today: {d.todayCount}</Link>
          </div>
          <ul className="ws-list">
            {d.overdue.leads.map((l) => (
              <li key={l.id}><Link className="ws-row" to={`/sales/leads/${l.id}`}><span className="grow truncate">{l.display_name || l.organization_name || `Lead ${l.id}`}</span>{l.next_followup && <span className="small muted">{whenWords({ at: l.next_followup.due_date })}</span>}</Link></li>
            ))}
          </ul>
        </>
      )}
    </WidgetFrame>
  );
}

function CallsWidget({ widget }) {
  const state = useWidgetData(() => api.sales.get('/calls/pending'), []);
  const calls = state.data?.calls || [];
  return (
    <WidgetFrame widget={widget} state={state} count={state.data ? calls.length : null} drill="/sales?tab=day"
      empty={state.data && !calls.length ? 'Every call you made has an outcome' : null}>
      <ul className="ws-list">
        {calls.slice(0, rowsOf(widget)).map((c) => (
          <li key={c.id}><Link className="ws-row" to={c.lead_id ? `/sales/leads/${c.lead_id}` : '/sales?tab=day'}><span className="grow truncate">{c.about || c.contact_name || c.lead_ref || 'A call'}</span><span className="small muted">{whenWords({ at: c.started_at || c.dialled_at })}</span></Link></li>
        ))}
      </ul>
    </WidgetFrame>
  );
}

// ---------------------------------------------------------------- the registry of renderers

const RENDERERS = {
  today: TodayWidget,
  my_tasks: TaskListWidget,
  deadlines: TaskListWidget,
  saved_view: SavedViewWidget,
  key_results: KeyResultsWidget,
  team_workload: (p) => <DashboardWidget {...p} part="workload" />,
  company_overview: (p) => <DashboardWidget {...p} part="overview" />,
  recognition: RecognitionWidget,
  my_black_marks: BlackMarksWidget,
  pinned_notes: NotesWidget,
  leads_to_work: LeadsToWorkWidget,
  followups: FollowupsWidget,
  calls_to_describe: CallsWidget,
};

/** Adds renderers from other parts of the workspace (attention, records). */
export function registerWidget(type, component) { RENDERERS[type] = component; }

/** One widget, whatever its type and state. */
export function WorkspaceWidget({ widget, onRemove, onOpenTask, refreshKey }) {
  if (widget.retired || !WIDGET_TYPES[widget.type] || !widget.available) return <UnavailableWidget widget={widget} onRemove={onRemove} />;
  const Render = RENDERERS[widget.type];
  if (!Render) return <UnavailableWidget widget={{ ...widget, why: 'Not available in this version' }} onRemove={onRemove} />;
  return <Render widget={widget} onOpenTask={onOpenTask} refreshKey={refreshKey} />;
}
