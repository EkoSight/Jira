import { Avatar, Badge, Icon } from './ui.jsx';
import { dueLabel, PRIORITY_LABEL, PRIORITY_TONE } from '../lib/format.js';

export default function TaskCard({ task, onOpen, draggable, onDragStart, onDragEnd, compact }) {
  const done = task.stage === 'done' || task.stage === 'cancelled';
  const due = dueLabel(task.due_date, { done });
  const checklist = task.checklist_total > 0;

  return (
    <article
      className={`task-card priority-bar-${task.priority}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(task);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${task.ref} ${task.title}`}
    >
      <div className="row" style={{ gap: 6 }}>
        <span className="task-ref">{task.ref}</span>
        <Badge dot={task.department_color}>{task.department_name}</Badge>
      </div>

      <div className="task-card-title">{task.title}</div>

      {!compact && task.progress > 0 && task.progress < 100 && (
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${task.progress}%` }} />
        </div>
      )}

      <div className="task-card-meta">
        <Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</Badge>
        {task.due_date && (
          <Badge tone={due.tone === 'neutral' ? 'neutral' : due.tone}>
            <Icon name={due.tone === 'critical' ? 'alert' : 'clock'} size={11} />
            {due.text}
          </Badge>
        )}
        {checklist && (
          <span className="small muted tnum">
            <Icon name="check" size={11} style={{ verticalAlign: -1 }} /> {task.checklist_done}/{task.checklist_total}
          </span>
        )}
        {task.comment_count > 0 && <span className="small muted">{task.comment_count} 💬</span>}

        <span style={{ marginLeft: 'auto' }}>
          {task.assignee_name ? (
            <Avatar name={task.assignee_name} color={task.assignee_color} size={22} />
          ) : (
            <Badge tone="warning">Unassigned</Badge>
          )}
        </span>
      </div>
    </article>
  );
}
