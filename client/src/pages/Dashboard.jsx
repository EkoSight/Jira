import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import { BarList, LoadMeter, Ring, TrendChart, STATUS_COLOR } from '../components/charts.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import {
  PRIORITY_LABEL,
  PRIORITY_TONE,
  WORKLOAD_STATUS,
  loadSummary,
  describeActivity,
  dueLabel,
  relativeTime,
} from '../lib/format.js';

/** One tile = one number the manager acts on. */
function Stat({ label, value, note, tone, onClick }) {
  return (
    <button type="button" className="stat" onClick={onClick}>
      <span className="stat-label">
        {tone && <span className="stat-accent" style={{ background: STATUS_COLOR[tone] }} />}
        {label}
      </span>
      <span className="stat-value tnum">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </button>
  );
}

export default function Dashboard() {
  const { user, can } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [departmentId, setDepartmentId] = useState('');
  const [openTask, setOpenTask] = useState(null);

  const load = () => {
    setLoading(true);
    api
      .dashboard({ department_id: departmentId || undefined })
      .then(setData)
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, [departmentId]);

  if (loading && !data) return <Spinner label="Building your summary" />;
  if (!data) return <EmptyState title="Could not load the dashboard" />;

  const { summary, byDepartment, byPriority, byStatus, upcoming, activity, trend, workload } = data;

  const goToBoard = (params) => navigate(`/board?${new URLSearchParams(params)}`);

  const priorityRows = ['critical', 'high', 'medium', 'low'].map((priority) => ({
    id: priority,
    label: PRIORITY_LABEL[priority],
    value: byPriority.find((p) => p.priority === priority)?.count || 0,
    color: STATUS_COLOR[PRIORITY_TONE[priority] === 'brand' ? 'brand' : PRIORITY_TONE[priority]] || STATUS_COLOR.neutral,
  }));

  const idle = workload.filter((w) => w.status === 'idle');
  const stalled = workload.filter((w) => w.status === 'stalled');
  const overloaded = workload.filter((w) => w.status === 'overloaded');

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row-between wrap">
        <div>
          <h1>Good to see you, {user.full_name.split(' ')[0]}</h1>
          <div className="small muted">
            {summary.pending} open item{summary.pending === 1 ? '' : 's'} across the business right now
          </div>
        </div>
        <div className="filters">
          <select className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-sm" onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Open" value={summary.open} note="Backlog and to do" onClick={() => goToBoard({ stage: 'todo' })} />
        <Stat label="In progress" value={summary.in_progress} note="Being worked on now" onClick={() => goToBoard({ stage: 'in_progress' })} />
        <Stat label="Overdue" value={summary.overdue} note="Past the deadline" tone="critical" onClick={() => goToBoard({ overdue: 'true' })} />
        <Stat label="Due soon" value={summary.due_soon} note="Next few days" tone="warning" onClick={() => goToBoard({ due_within_days: 3 })} />
        <Stat label="Critical" value={summary.critical} note="Highest priority open" tone="serious" onClick={() => goToBoard({ priority: 'critical' })} />
        <Stat label="Unassigned" value={summary.unassigned} note="Nobody owns these" onClick={() => goToBoard({ assignee_id: 'none' })} />
        <Stat label="Done this month" value={summary.completed_this_month} note={`${summary.completed_this_week} this week`} tone="good" onClick={() => goToBoard({ stage: 'done' })} />
        <Stat label="Blocked" value={summary.blocked} note="Waiting on something" tone="serious" onClick={() => goToBoard({ stage: 'blocked' })} />
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <div className="card-head">
            <h2>Created vs completed</h2>
            <span className="small muted">last {trend.length} days</span>
          </div>
          <div className="card-pad">
            <TrendChart data={trend} />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Deadlines coming up</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToBoard({ due_within_days: 7 })}>
              See all <Icon name="chevron" size={13} />
            </button>
          </div>
          <div className="card-pad stack-sm" style={{ maxHeight: 320, overflowY: 'auto' }}>
            {upcoming.length === 0 && <div className="empty small">Nothing due in the next week</div>}
            {upcoming.map((task) => {
              const due = dueLabel(task.due_date);
              return (
                <button
                  key={task.id}
                  type="button"
                  className="row"
                  style={{ background: 'none', border: 0, padding: '6px 0', width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setOpenTask(task.id)}
                >
                  <span className="stat-accent" style={{ background: task.status_color }} />
                  <span className="grow truncate">
                    <span className="task-ref">{task.ref}</span> {task.title}
                  </span>
                  {task.assignee && <Avatar name={task.assignee} color={task.avatar_color} size={20} />}
                  <Badge tone={due.tone}>{due.text}</Badge>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {workload.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Who is working on what</h2>
            <div className="row small muted wrap" style={{ gap: 10 }}>
              {overloaded.length > 0 && <Badge tone="critical">{overloaded.length} overloaded</Badge>}
              {stalled.length > 0 && <Badge tone="serious">{stalled.length} stalled</Badge>}
              {idle.length > 0 && <Badge>{idle.length} idle</Badge>}
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Bandwidth</th>
                  <th className="num">Open</th>
                  <th className="num">Active</th>
                  <th className="num">Overdue</th>
                  <th className="num">Critical</th>
                  <th className="num">Done 30d</th>
                  <th>Last movement</th>
                </tr>
              </thead>
              <tbody>
                {workload.map((member) => {
                  const state = WORKLOAD_STATUS[member.status];
                  return (
                    <tr
                      key={member.id}
                      className="clickable"
                      onClick={() => goToBoard({ assignee_id: member.id })}
                    >
                      <td>
                        <div className="row">
                          <Avatar name={member.full_name} color={member.avatar_color} size={26} />
                          <div>
                            <div style={{ fontWeight: 600 }}>{member.full_name}</div>
                            <div className="small muted">{member.department || 'No department'}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ minWidth: 190 }}>
                        <LoadMeter percent={member.load_percent} status={member.status} />
                        <div className="row" style={{ gap: 6, marginTop: 2 }}>
                          <Badge tone={state.tone}>{state.label}</Badge>
                          <span className="small muted">{loadSummary(member)}</span>
                        </div>
                      </td>
                      <td className="num tnum">{member.open_tasks}</td>
                      <td className="num tnum">{member.active_tasks}</td>
                      <td className="num tnum">
                        {member.overdue_tasks > 0 ? (
                          <strong style={{ color: 'var(--critical-text)' }}>{member.overdue_tasks}</strong>
                        ) : (
                          0
                        )}
                      </td>
                      <td className="num tnum">{member.critical_tasks}</td>
                      <td className="num tnum">{member.completed_30d}</td>
                      <td className="small muted">
                        {member.days_since_activity == null ? '—' : `${member.days_since_activity}d ago`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="grid-3" style={{ alignItems: 'start' }}>
        <section className="card">
          <div className="card-head"><h2>By department</h2></div>
          <div className="card-pad">
            <BarList
              items={byDepartment.map((d) => ({ id: d.id, label: d.name, value: d.pending }))}
              onSelect={(item) => goToBoard({ department_id: item.id })}
              emptyText="No open work"
            />
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>By priority</h2></div>
          <div className="card-pad">
            <BarList items={priorityRows} onSelect={(item) => goToBoard({ priority: item.id })} />
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Completion</h2></div>
          <div className="card-pad stack">
            <Ring value={summary.done} total={summary.total} label="Completed overall" />
            <BarList
              items={byStatus.map((s) => ({ id: s.id, label: s.name, value: s.count }))}
              onSelect={(item) => goToBoard({ status_id: item.id })}
              emptyText="No cards yet"
            />
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Recent activity</h2></div>
        <div className="card-pad">
          {activity.length === 0 && <div className="empty small">No activity recorded yet</div>}
          {activity.map((item) => (
            <button
              key={item.id}
              type="button"
              className="activity-line"
              style={{ background: 'none', border: 0, width: '100%', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => setOpenTask(item.task_id)}
            >
              <Avatar name={item.actor || '?'} color={item.avatar_color || '#94a3b8'} size={22} />
              <span className="grow truncate">
                <strong>{item.actor || 'System'}</strong> {describeActivity(item)} on{' '}
                <span className="task-ref">{item.ref}</span> {item.title}
              </span>
              <span className="small muted">{relativeTime(item.created_at)}</span>
            </button>
          ))}
        </div>
      </section>

      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
    </div>
  );
}
