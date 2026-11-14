import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import TaskCard from '../components/TaskCard.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import CompleteTaskDialog from '../components/CompleteTaskDialog.jsx';
import { PRIORITIES, PRIORITY_LABEL, PRIORITY_TONE, STAGE_LABEL, dueLabel, formatDate, setDeadlineCalendar, taskHealth } from '../lib/format.js';

// the filters that live in the address, so a link shows someone exactly this
const FILTER_KEYS = ['department_id', 'assignee_id', 'supporter_id', 'assigned_by', 'priority', 'stage', 'status_id', 'search', 'due', 'due_from', 'due_to', 'exclude_stage'];

const DUE_OPTIONS = [
  ['', 'Any deadline'],
  ['overdue', 'Overdue'],
  ['today', 'Due today'],
  ['tomorrow', 'Due tomorrow'],
  ['soon', 'Due soon (today + 3 working days)'],
  ['next7', 'Next 7 days'],
  ['next30', 'Next 30 days'],
  ['none', 'No deadline'],
  ['review', 'Review due'],
  ['range', 'Date range…'],
];

const SORTS = [
  ['position', 'Board order'],
  ['due_date', 'Earliest deadline'],
  ['overdue_age', 'Longest overdue'],
  ['priority', 'Priority'],
];

export default function Board() {
  const { can, user } = useAuth();
  const { departments, statuses, users } = useRefData();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [data, setData] = useState({ tasks: [], total: 0, counts: { by_status: {}, by_health: {} }, truncated: false });
  const [loading, setLoading] = useState(true);
  const [openTask, setOpenTask] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [creatingIn, setCreatingIn] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('taskflow.view') || 'board'; } catch { return 'board'; }
  });
  const [views, setViews] = useState({ views: [], can_share: [] });
  const tasks = data.tasks;

  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || ''])), [params]);
  const sort = params.get('sort') || (view === 'list' ? 'due_date' : 'position');
  // finished work is collapsed until asked for, never hidden for good
  const showDone = params.get('show_done') === '1';

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'due' && value !== 'range') { next.delete('due_from'); next.delete('due_to'); }
    setParams(next, { replace: true });
  };

  const load = useCallback(() => {
    setLoading(true);
    api
      .tasks({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), sort, hide_done: showDone ? undefined : 'true', limit: 500 })
      .then((result) => {
        setDeadlineCalendar(result.calendar);
        setData(result);
      })
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, view]);

  useEffect(load, [load]);
  useEffect(() => {
    try { localStorage.setItem('taskflow.view', view); } catch { /* private window */ }
  }, [view]);

  const loadViews = () => api.get('/task-views').then(setViews).catch(() => {});
  useEffect(() => { loadViews(); }, []);

  const move = async (task, statusId) => {
    if (task.status_id === statusId) return;
    // moving a card into a done column asks for the outcome first, rather than
    // closing it silently — the completion dialog performs the move itself
    const target = statuses.find((s) => s.id === statusId);
    const wasDone = task.stage === 'done' || task.stage === 'cancelled';
    if (target?.stage === 'done' && !wasDone) {
      setCompleting({ task, statusId });
      return;
    }
    const previous = data;
    setData((current) => ({ ...current, tasks: current.tasks.map((t) => (t.id === task.id ? { ...t, status_id: statusId } : t)) }));
    try {
      await api.moveTask(task.id, { status_id: statusId });
      load();
    } catch (err) {
      setData(previous);
      toast.error(err);
    }
  };

  const columns = statuses.map((status) => ({
    ...status,
    tasks: tasks.filter((task) => task.status_id === status.id),
    count: data.counts?.by_status?.[status.id] || 0,
    collapsed: !showDone && (status.stage === 'done' || status.stage === 'cancelled'),
  }));

  const activeFilters = FILTER_KEYS.filter((k) => filters[k] && k !== 'due_from' && k !== 'due_to').length;
  const currentQuery = () => {
    const q = new URLSearchParams(params);
    q.delete('show_done');
    return q.toString();
  };

  const saveView = async () => {
    const name = window.prompt('Name this view (for example "My overdue work")');
    if (!name) return;
    let departmentId = null;
    if (views.can_share?.length) {
      const share = window.confirm('Share this view with everyone in your department? (Cancel keeps it to yourself.)');
      if (share) departmentId = views.can_share[0];
    }
    try {
      await api.post('/task-views', { name, query: currentQuery(), department_id: departmentId });
      toast.success(departmentId ? 'View saved and shared with the department' : 'View saved');
      loadViews();
    } catch (err) { toast.error(err); }
  };
  const applyView = (id) => {
    const v = views.views.find((x) => String(x.id) === String(id));
    if (v) setParams(new URLSearchParams(v.query), { replace: true });
  };
  const removeView = async (v) => {
    if (!window.confirm(`Remove the saved view "${v.name}"?`)) return;
    try { await api.del(`/task-views/${v.id}`); loadViews(); } catch (err) { toast.error(err); }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied: it opens the board with these filters');
    } catch { toast.error('Could not copy; the address bar has the same link'); }
  };

  const overdue = data.counts?.by_health?.OVERDUE || 0;
  const dueToday = data.counts?.by_health?.DUE_TODAY || 0;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>Task board</h1>
          <div className="small muted tnum" aria-live="polite">
            {data.total} card{data.total === 1 ? '' : 's'}
            {overdue > 0 && <> · <span className="critical-text">{overdue} overdue</span></>}
            {dueToday > 0 && <> · {dueToday} due today</>}
            {activeFilters > 0 && ` · ${activeFilters} filter${activeFilters === 1 ? '' : 's'} applied`}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <select className="select" aria-label="Saved views" value="" onChange={(e) => applyView(e.target.value)}>
            <option value="">Saved views{views.views.length ? ` (${views.views.length})` : ''}</option>
            {views.views.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.department_name ? ` · shared with ${v.department_name}` : ''}{!v.mine ? ` · from ${v.owner_name}` : ''}</option>
            ))}
          </select>
          <button type="button" className="btn btn-sm" onClick={saveView} disabled={activeFilters === 0}>Save view</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={copyLink}><Icon name="link" size={14} /> Copy link</button>
          <div className="row" style={{ gap: 2, background: 'var(--surface-3)', padding: 2, borderRadius: 8 }}>
            {['board', 'list'].map((mode) => (
              <button
                key={mode}
                type="button"
                className={`btn btn-sm ${view === mode ? '' : 'btn-ghost'}`}
                style={view === mode ? {} : { background: 'transparent', border: 0 }}
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
              >
                <Icon name={mode === 'board' ? 'board' : 'list'} size={14} />
                {mode === 'board' ? 'Board' : 'List'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="filters">
        <input
          className="input"
          placeholder="Search cards…"
          aria-label="Search cards"
          defaultValue={filters.search}
          onKeyDown={(e) => e.key === 'Enter' && setFilter('search', e.target.value)}
          onBlur={(e) => e.target.value !== filters.search && setFilter('search', e.target.value)}
        />
        <select className="select" aria-label="Deadline" value={filters.due} onChange={(e) => setFilter('due', e.target.value)}>
          {DUE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {filters.due === 'range' && (
          <>
            <input type="date" className="input" aria-label="Due from" value={filters.due_from} onChange={(e) => setFilter('due_from', e.target.value)} />
            <input type="date" className="input" aria-label="Due to" value={filters.due_to} onChange={(e) => setFilter('due_to', e.target.value)} />
          </>
        )}
        <select className="select" aria-label="Status" value={filters.stage} onChange={(e) => setFilter('stage', e.target.value)}>
          <option value="">Any status</option>
          <option value="backlog,todo">Backlog and to do</option>
          {Object.entries(STAGE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className="select" aria-label="Owner" value={filters.assignee_id} onChange={(e) => setFilter('assignee_id', e.target.value)}>
          <option value="">Any owner</option>
          <option value={String(user?.id)}>Me</option>
          <option value="none">No owner</option>
          <option value="inactive">Owner switched off</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
        <select className="select" aria-label="Supporting" value={filters.supporter_id} onChange={(e) => setFilter('supporter_id', e.target.value)}>
          <option value="">Any supporter</option>
          <option value={String(user?.id)}>I'm supporting</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
        <select className="select" aria-label="Department" value={filters.department_id} onChange={(e) => setFilter('department_id', e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="select" aria-label="Priority" value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select className="select" aria-label="Sort" value={sort} onChange={(e) => setFilter('sort', e.target.value)}>
          {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {filters.assigned_by && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter('assigned_by', '')}>
            Assigned by {String(filters.assigned_by) === String(user?.id) ? 'me' : (users.find((u) => String(u.id) === String(filters.assigned_by))?.full_name || 'someone')} ×
          </button>
        )}
        {filters.exclude_stage && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter('exclude_stage', '')}>
            Without {filters.exclude_stage.split(',').map((x) => STAGE_LABEL[x] || x).join(', ').toLowerCase()} ×
          </button>
        )}
        {activeFilters > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear
          </button>
        )}
      </div>

      {views.views.some((v) => v.mine) && (
        <div className="row wrap small" style={{ gap: 6 }}>
          <span className="muted">Your views:</span>
          {views.views.filter((v) => v.mine).map((v) => (
            <span key={v.id} className="chip-pair">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => applyView(v.id)}>{v.name}</button>
              <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove the view ${v.name}`} onClick={() => removeView(v)}><Icon name="close" size={12} /></button>
            </span>
          ))}
        </div>
      )}

      {data.truncated && (
        <div className="mkt-callout is-warning small" role="status">
          Showing the first {data.shown} of {data.total} cards. The counts cover all {data.total}; narrow the filters to see the rest.
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <Spinner label="Loading the board" />
      ) : view === 'board' ? (
        <div className="board-scroll">
          {columns.map((column) => (
            <section
              key={column.id}
              className={`board-col ${dropTarget === column.id ? 'drop-target' : ''}`}
              aria-label={`${column.name}: ${column.count}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDropTarget(column.id);
              }}
              onDragLeave={() => setDropTarget((current) => (current === column.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setDropTarget(null);
                if (dragging) move(dragging, column.id);
              }}
            >
              <header className="board-col-head">
                <span className="badge-dot" style={{ background: column.color }} />
                <span className="board-col-title">{column.name}</span>
                <span className="board-col-count tnum">{column.count}</span>
                {can('task.create') && !column.collapsed && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '0 6px' }}
                    onClick={() => setCreatingIn(column.id)}
                    aria-label={`Add a card to ${column.name}`}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                )}
              </header>

              <div className="board-col-body">
                {column.collapsed ? (
                  <div className="center stack-sm" style={{ padding: 14 }}>
                    <span className="small muted">{column.count} finished card{column.count === 1 ? '' : 's'}, collapsed</span>
                    {column.count > 0 && <button type="button" className="btn btn-sm" onClick={() => setFilter('show_done', '1')}>Show</button>}
                  </div>
                ) : (
                  <>
                    {column.tasks.length === 0 && <div className="small muted center" style={{ padding: 14 }}>Empty</div>}
                    {column.tasks.map((task) => (
                      <div key={task.id}>
                        <TaskCard
                          task={task}
                          onOpen={() => setOpenTask(task.id)}
                          onOpenParent={(parentId) => setOpenTask(parentId)}
                          draggable
                          onDragStart={() => setDragging(task)}
                          onDragEnd={() => {
                            setDragging(null);
                            setDropTarget(null);
                          }}
                        />
                        {/* touch devices cannot use HTML5 drag, so cards carry a move control there */}
                        <select
                          className="select card-move"
                          value=""
                          onChange={(e) => e.target.value && move(task, Number(e.target.value))}
                          aria-label={`Move ${task.ref} to another column`}
                        >
                          <option value="">Move to…</option>
                          {statuses.filter((s) => s.id !== task.status_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </div>
                    ))}
                    {(column.stage === 'done' || column.stage === 'cancelled') && showDone && (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter('show_done', '')}>Collapse</button>
                    )}
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="card table-wrap">
          {tasks.length === 0 ? (
            <EmptyState title="No cards match these filters" />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Department</th>
                  <th>Status</th>
                  <th>Owner</th>
                  <th>Priority</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const done = task.stage === 'done' || task.stage === 'cancelled';
                  const due = done ? dueLabel(task.due_date, { done }) : taskHealth(task);
                  return (
                    <tr
                      key={task.id}
                      className={`clickable${task.parent_task_id ? ' subtask-row' : ''}`}
                      onClick={() => setOpenTask(task.id)}
                    >
                      <td>
                        {task.parent_task_id && (
                          <button
                            type="button"
                            className="subtask-link"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenTask(task.parent_task_id);
                            }}
                            title={task.parent_title ? `Part of ${task.parent_ref}: ${task.parent_title}` : undefined}
                          >
                            <Icon name="subtask" size={12} /> Subtask of {task.parent_ref}
                          </button>
                        )}
                        <div className="row" style={{ gap: 8 }}>
                          <span className="task-ref">{task.ref}</span>
                          <span className="truncate" style={{ maxWidth: 340 }}>{task.title}</span>
                          {task.subtask_total > 0 && (
                            <Badge tone="neutral" title="Has subtasks">
                              <Icon name="subtask" size={10} /> {task.subtask_done}/{task.subtask_total}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td><Badge dot={task.department_color}>{task.department_name}</Badge></td>
                      <td><Badge dot={task.status_color}>{task.status_name}</Badge></td>
                      <td>
                        {task.assignee_name ? (
                          <div className="row" style={{ gap: 6 }}>
                            <Avatar userId={task.assignee_id} name={task.assignee_name} color={task.assignee_color} size={20} />
                            <span className="small">{task.assignee_name}</span>
                          </div>
                        ) : (
                          <Badge tone="warning">No owner</Badge>
                        )}
                      </td>
                      <td><Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</Badge></td>
                      <td>
                        <div className="stack-sm" style={{ gap: 2 }}>
                          <Badge tone={due.tone}>{due.text}</Badge>
                          {task.due_date && <span className="small muted">{formatDate(task.due_date)}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!showDone && (data.counts?.by_stage?.done || 0) > 0 && (
            <div className="card-pad small muted">
              {data.counts.by_stage.done} finished card{data.counts.by_stage.done === 1 ? '' : 's'} collapsed.{' '}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFilter('show_done', '1')}>Show</button>
            </div>
          )}
        </div>
      )}

      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
      {completing && (
        <CompleteTaskDialog
          task={completing.task}
          targetStatusId={completing.statusId}
          onClose={() => setCompleting(null)}
          onCompleted={load}
        />
      )}
      {creatingIn && (
        <TaskDialog
          defaults={{ status_id: creatingIn, department_id: filters.department_id || undefined }}
          onClose={() => setCreatingIn(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
