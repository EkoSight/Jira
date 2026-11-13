import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import TaskCard from '../components/TaskCard.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import CompleteTaskDialog from '../components/CompleteTaskDialog.jsx';
import { MY_GROUPS } from '../../../shared/deadlineHealth.js';
import { setDeadlineCalendar } from '../lib/format.js';

const TONE = { overdue: 'critical', today: 'warning', upcoming: 'serious', blocked: 'critical', review: 'warning', undated: 'warning', later: 'neutral', deferred: 'neutral' };
const NOTE = {
  overdue: 'Past the deadline: clear these first, or ask for a new date',
  blocked: 'Waiting on something: say what, so it can be cleared',
  review: 'Deferred or Backlog work that is due a look',
  undated: 'No deadline and no review date: give each one a date',
};

/** The board link that shows exactly a group's tasks, for the same person. */
const boardLink = (group, relation, userId) => {
  const q = new URLSearchParams(group.filter);
  q.set(relation === 'OWNER' ? 'assignee_id' : 'supporter_id', String(userId));
  return `/board?${q.toString()}`;
};

function Section({ title, relation, tasks, counts, userId, onOpen, onDone, note }) {
  const [open, setOpen] = useState({});
  const groups = MY_GROUPS.map((g) => ({ ...g, tasks: tasks.filter((t) => t.group === g.key) })).filter((g) => g.tasks.length);
  const total = tasks.length;
  return (
    <section className="stack" style={{ gap: 10 }} aria-labelledby={`mine-${relation}`}>
      <div className="row-between wrap">
        <h2 id={`mine-${relation}`} style={{ margin: 0 }}>{title} <span className="muted tnum">· {total}</span></h2>
        {note && <span className="small muted">{note}</span>}
      </div>
      {/* the day at a glance: each count is the same as the board's with that filter */}
      <div className="row wrap" style={{ gap: 6 }}>
        {MY_GROUPS.filter((g) => counts?.[g.key]).map((g) => (
          <Link key={g.key} className={`badge badge-${TONE[g.key]}`} to={boardLink(g, relation, userId)}>
            {g.title} <strong className="tnum">{counts[g.key]}</strong>
          </Link>
        ))}
      </div>
      {groups.map((group) => {
        const collapsed = group.collapsed && !open[group.key];
        return (
          <section key={group.key} className="card">
            <div className="card-head">
              <div className="row">
                <h3 style={{ margin: 0 }}>{group.title}</h3>
                <Badge tone={TONE[group.key]}>{group.tasks.length}</Badge>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {NOTE[group.key] && <span className="small muted">{NOTE[group.key]}</span>}
                <Link className="small" to={boardLink(group, relation, userId)}>On the board</Link>
                {group.collapsed && (
                  <button type="button" className="btn btn-sm btn-ghost" aria-expanded={!collapsed} onClick={() => setOpen((o) => ({ ...o, [group.key]: !o[group.key] }))}>
                    {collapsed ? 'Show' : 'Hide'}
                  </button>
                )}
              </div>
            </div>
            {!collapsed && (
              <div className="card-pad stack-sm">
                {group.tasks.map((task) => (
                  <div key={task.id} className="row" style={{ alignItems: 'stretch', gap: 8 }}>
                    <div className="grow">
                      {relation === 'SUPPORTING' && (
                        <div className="row small muted" style={{ gap: 5, marginBottom: 3 }}>
                          <Icon name="team" size={12} />
                          Supporting {task.assignee_name || 'nobody yet'}: {task.assignee_name ? 'they own the deadline' : 'this task needs an owner'}
                        </div>
                      )}
                      {task.recurrence_parent_id && (
                        <div className="row small muted" style={{ gap: 5, marginBottom: 3 }}>
                          <Icon name="clock" size={12} />
                          Next in the {task.recurrence} series: the previous one is closed
                        </div>
                      )}
                      {task.next_action && (
                        <div className="small" style={{ marginBottom: 3 }}><span className="muted">Next:</span> {task.next_action}</div>
                      )}
                      <TaskCard task={task} onOpen={() => onOpen(task.id)} onOpenParent={(parentId) => onOpen(parentId)} compact />
                    </div>
                    {relation === 'OWNER' && (
                      <button type="button" className="btn btn-sm" onClick={() => onDone(task)} title="Mark done" style={{ alignSelf: 'center' }}>
                        <Icon name="check" size={14} /> Done
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}

/** My Tasks: the daily starting point. What I own, then what I support. */
export default function MyTasks() {
  const { statuses } = useRefData();
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState({ tasks: [], counts: { OWNER: {}, SUPPORTING: {} } });
  const [loading, setLoading] = useState(true);
  const [openTask, setOpenTask] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .myTasks()
      .then((result) => {
        setDeadlineCalendar(result.calendar);
        setData(result);
      })
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  // marking done opens the completion prompt rather than closing silently
  const [completing, setCompleting] = useState(null);
  const startComplete = (task) => {
    const doneStatus = statuses.find((s) => s.stage === 'done');
    if (!doneStatus) return toast.error('No "done" status is configured');
    setCompleting({ task, statusId: doneStatus.id });
  };

  if (loading && data.tasks.length === 0) return <Spinner label="Loading your work" />;

  const owned = data.tasks.filter((t) => t.relation === 'OWNER');
  const supporting = data.tasks.filter((t) => t.relation === 'SUPPORTING');

  return (
    <div className="stack" style={{ gap: 22 }}>
      <div>
        <h1>My tasks</h1>
        <div className="small muted">
          {owned.length} you own · {supporting.length} you support. Every open task appears once, in one group.
        </div>
      </div>

      {data.tasks.length === 0 && (
        <EmptyState title="Nothing on your plate">You have no open tasks to own or support right now.</EmptyState>
      )}

      {owned.length > 0 && (
        <Section title="I own" relation="OWNER" tasks={owned} counts={data.counts.OWNER} userId={user.id} onOpen={setOpenTask} onDone={startComplete} note="You carry these deadlines" />
      )}
      {supporting.length > 0 && (
        <Section title="I'm supporting" relation="SUPPORTING" tasks={supporting} counts={data.counts.SUPPORTING} userId={user.id} onOpen={setOpenTask} onDone={startComplete} note="Following or tagged: the owner carries the deadline" />
      )}

      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
      {completing && (
        <CompleteTaskDialog task={completing.task} targetStatusId={completing.statusId} onClose={() => setCompleting(null)} onCompleted={load} />
      )}
    </div>
  );
}
