import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import TaskCard from '../components/TaskCard.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import CompleteTaskDialog from '../components/CompleteTaskDialog.jsx';
import { PRIORITIES, PRIORITY_LABEL, PRIORITY_TONE, dueLabel, formatDate } from '../lib/format.js';

export default function Board() {
  const { can } = useAuth();
  const { departments, statuses, users } = useRefData();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openTask, setOpenTask] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [creatingIn, setCreatingIn] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [view, setView] = useState(() => localStorage.getItem('taskflow.view') || 'board');

  const filters = useMemo(
    () => ({
      department_id: params.get('department_id') || '',
      assignee_id: params.get('assignee_id') || '',
      priority: params.get('priority') || '',
      stage: params.get('stage') || '',
      status_id: params.get('status_id') || '',
      search: params.get('search') || '',
      overdue: params.get('overdue') || '',
      due_within_days: params.get('due_within_days') || '',
    }),
    [params],
  );

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const load = useCallback(() => {
    setLoading(true);
    api
      .tasks({ ...filters, sort: view === 'list' ? 'due_date' : 'position', limit: 500 })
      .then((data) => setTasks(data.tasks))
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, view]);

  useEffect(load, [load]);

  useEffect(() => localStorage.setItem('taskflow.view', view), [view]);

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

    const previous = tasks;
    setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, status_id: statusId } : t)));
    try {
      const { task: updated } = await api.moveTask(task.id, { status_id: statusId });
      setTasks((current) => current.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      setTasks(previous);
      toast.error(err);
    }
  };

  const columns = statuses.map((status) => ({
    ...status,
    tasks: tasks.filter((task) => task.status_id === status.id),
  }));

  const activeFilters = Object.entries(filters).filter(([, value]) => value).length;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>Task board</h1>
          <div className="small muted">
            {tasks.length} card{tasks.length === 1 ? '' : 's'}
            {activeFilters > 0 && ` · ${activeFilters} filter${activeFilters === 1 ? '' : 's'} applied`}
          </div>
        </div>
        <div className="row">
          <div className="row" style={{ gap: 2, background: 'var(--surface-3)', padding: 2, borderRadius: 8 }}>
            {['board', 'list'].map((mode) => (
              <button
                key={mode}
                type="button"
                className={`btn btn-sm ${view === mode ? '' : 'btn-ghost'}`}
                style={view === mode ? {} : { background: 'transparent', border: 0 }}
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
          defaultValue={filters.search}
          onKeyDown={(e) => e.key === 'Enter' && setFilter('search', e.target.value)}
          onBlur={(e) => e.target.value !== filters.search && setFilter('search', e.target.value)}
        />
        <select className="select" value={filters.department_id} onChange={(e) => setFilter('department_id', e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <select className="select" value={filters.assignee_id} onChange={(e) => setFilter('assignee_id', e.target.value)}>
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.full_name}</option>
          ))}
        </select>
        <select className="select" value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <select className="select" value={filters.overdue} onChange={(e) => setFilter('overdue', e.target.value)}>
          <option value="">Any deadline</option>
          <option value="true">Overdue only</option>
        </select>
        {activeFilters > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear
          </button>
        )}
      </div>

      {loading && tasks.length === 0 ? (
        <Spinner label="Loading the board" />
      ) : view === 'board' ? (
        <div className="board-scroll">
          {columns.map((column) => (
            <section
              key={column.id}
              className={`board-col ${dropTarget === column.id ? 'drop-target' : ''}`}
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
                <span className="board-col-count tnum">{column.tasks.length}</span>
                {can('task.create') && (
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
                      {statuses
                        .filter((s) => s.id !== task.status_id)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </div>
                ))}
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
                  <th>Assignee</th>
                  <th>Priority</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const due = dueLabel(task.due_date, { done: task.stage === 'done' });
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
                            <Avatar name={task.assignee_name} color={task.assignee_color} size={20} />
                            <span className="small">{task.assignee_name}</span>
                          </div>
                        ) : (
                          <Badge tone="warning">Unassigned</Badge>
                        )}
                      </td>
                      <td><Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</Badge></td>
                      <td>
                        {task.due_date ? (
                          <div className="stack-sm" style={{ gap: 2 }}>
                            <Badge tone={due.tone}>{due.text}</Badge>
                            <span className="small muted">{formatDate(task.due_date)}</span>
                          </div>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
