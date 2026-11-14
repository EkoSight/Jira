import { Avatar, Badge, Icon } from './ui.jsx';
import { dueLabel, PRIORITY_LABEL, PRIORITY_TONE, taskHealth } from '../lib/format.js';

export default function TaskCard({ task, onOpen, onOpenParent, draggable, onDragStart, onDragEnd, compact }) {
  const done = task.stage === 'done' || task.stage === 'cancelled';
  // the same words as My Tasks and Google Chat: overdue at the due time, in the organisation's time zone
  const due = done ? dueLabel(task.due_date, { done }) : taskHealth(task);
  const checklist = task.checklist_total > 0;
  const isSubtask = Boolean(task.parent_task_id);
  const isParent = task.subtask_total > 0;

  return (
    // A click anywhere on the card opens it. For the keyboard and screen readers
    // the card's body is the button, and "Subtask of …" sits beside it rather
    // than inside, since a button inside a button cannot be reached.
    <article
      className={`task-card priority-bar-${task.priority}${isSubtask ? ' is-subtask' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task)}
    >
      {isSubtask && (
        <button
          type="button"
          className="subtask-link"
          onClick={(event) => {
            event.stopPropagation();
            onOpenParent?.(task.parent_task_id);
          }}
          title={task.parent_title ? `Part of ${task.parent_ref}: ${task.parent_title}` : `Part of ${task.parent_ref}`}
        >
          <Icon name="subtask" size={12} /> Subtask of {task.parent_ref}
        </button>
      )}

      <div
        className="task-card-open"
        role="button"
        tabIndex={0}
        aria-label={`${isSubtask ? 'Subtask ' : ''}${task.ref} ${task.title}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(task);
          }
        }}
      >
        <div className="row" style={{ gap: 6 }}>
          <span className="task-ref">{task.ref}</span>
          <Badge dot={task.department_color}>{task.department_name}</Badge>
          {isParent && (
            <Badge tone="neutral" title="This task has subtasks">
              <Icon name="subtask" size={10} /> {task.subtask_done}/{task.subtask_total}
            </Badge>
          )}
          {task.recurrence && task.recurrence !== 'none' && (
            <Badge
              tone="brand"
              title={
                task.recurrence_parent_id
                  ? `The previous occurrence is closed — this is the next one, repeating ${task.recurrence}`
                  : `Repeats ${task.recurrence}`
              }
            >
              <Icon name="clock" size={10} /> {task.recurrence_parent_id ? 'next' : 'repeats'} {task.recurrence}
            </Badge>
          )}
        </div>

        <div className="task-card-title">{task.title}</div>

        {!compact && task.progress > 0 && task.progress < 100 && (
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${task.progress}%` }} />
          </div>
        )}

        <div className="task-card-meta">
          <Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</Badge>
          {(task.due_date || !done) && (
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
              <Avatar userId={task.assignee_id} name={task.assignee_name} color={task.assignee_color} size={22} />
            ) : (
              <Badge tone="warning">Unassigned</Badge>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}
