import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import TaskCard from '../components/TaskCard.jsx';
import TaskDialog from '../components/TaskDialog.jsx';

const GROUPS = [
  { key: 'overdue', title: 'Overdue', tone: 'critical', note: 'Past the deadline — clear these first' },
  { key: 'today', title: 'Due today', tone: 'warning', note: null },
  { key: 'week', title: 'Next 7 days', tone: 'serious', note: null },
  { key: 'later', title: 'Later', tone: 'neutral', note: null },
  { key: 'undated', title: 'No deadline set', tone: 'neutral', note: null },
];

const bucketFor = (task) => {
  if (!task.due_date) return 'undated';
  const due = new Date(task.due_date);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (due < new Date()) return 'overdue';
  if (due <= today) return 'today';
  const week = new Date();
  week.setDate(week.getDate() + 7);
  return due <= week ? 'week' : 'later';
};

export default function MyTasks() {
  const { statuses } = useRefData();
  const toast = useToast();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openTask, setOpenTask] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .myTasks()
      .then((data) => setTasks(data.tasks))
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  const complete = async (task) => {
    const doneStatus = statuses.find((s) => s.stage === 'done');
    if (!doneStatus) return toast.error('No "done" status is configured');
    try {
      await api.moveTask(task.id, { status_id: doneStatus.id });
      toast.success(`${task.ref} marked done`);
      load();
    } catch (err) {
      toast.error(err);
    }
  };

  if (loading && tasks.length === 0) return <Spinner label="Loading your work" />;

  const grouped = GROUPS.map((group) => ({
    ...group,
    tasks: tasks.filter((task) => bucketFor(task) === group.key),
  })).filter((group) => group.tasks.length > 0);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>My tasks</h1>
        <div className="small muted">
          {tasks.length} open item{tasks.length === 1 ? '' : 's'} assigned to you, ordered by deadline
        </div>
      </div>

      {grouped.length === 0 && (
        <EmptyState title="Nothing on your plate">
          You have no open tasks assigned to you right now.
        </EmptyState>
      )}

      {grouped.map((group) => (
        <section key={group.key} className="card">
          <div className="card-head">
            <div className="row">
              <h2>{group.title}</h2>
              <Badge tone={group.tone}>{group.tasks.length}</Badge>
            </div>
            {group.note && <span className="small muted">{group.note}</span>}
          </div>
          <div className="card-pad stack-sm">
            {group.tasks.map((task) => (
              <div key={task.id} className="row" style={{ alignItems: 'stretch', gap: 8 }}>
                <div className="grow">
                  <TaskCard task={task} onOpen={() => setOpenTask(task.id)} compact />
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => complete(task)}
                  title="Mark done"
                  style={{ alignSelf: 'center' }}
                >
                  <Icon name="check" size={14} /> Done
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}

      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
    </div>
  );
}
