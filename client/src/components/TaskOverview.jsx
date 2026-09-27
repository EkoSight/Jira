import { useState } from 'react';
import { useRefData } from '../state/AppState.jsx';
import { Avatar, Badge, Icon } from './ui.jsx';
import { AwayBadge } from './Availability.jsx';
import { threadKind, replyCount } from '../lib/threads.js';
import {
  PRIORITY_LABEL, PRIORITY_TONE, dueLabel, formatDate, relativeTime,
} from '../lib/format.js';

/**
 * An existing task, as something to read and work on — not a form.
 *
 * The creation form asks every question at once because a new card needs the
 * answers. Once the card exists, the people opening it mostly want to know what
 * it is, whose it is, when it is due and where it has got to — and then to move
 * it on, tick a step off, or say something about it. So that is what opens.
 * Changing the task's attributes is still one click away, on "Edit details".
 */

const RECURRENCE_LABEL = {
  daily: 'Every day',
  weekdays: 'Every weekday',
  weekly: 'Every week',
  monthly: 'Every month',
};

function Fact({ label, children }) {
  return (
    <div className="task-fact">
      <div className="task-fact-label">{label}</div>
      <div className="task-fact-value">{children}</div>
    </div>
  );
}

function Person({ name, color, awayEntry }) {
  if (!name) return <span className="muted">Nobody</span>;
  return (
    <span className="row wrap" style={{ gap: 6 }}>
      <Avatar name={name} color={color} size={22} />
      <span>{name}</span>
      <AwayBadge entry={awayEntry} compact />
    </span>
  );
}

/** Links in a description are the thing people most often need to click. */
function RichText({ text }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <div className="task-description">
      {parts.map((part, index) => (/^https?:\/\//.test(part)
        ? <a key={index} href={part} target="_blank" rel="noreferrer noopener" className="btn-link">{part}</a>
        : <span key={index}>{part}</span>))}
    </div>
  );
}

export default function TaskOverview({
  detail, canEdit, canMove, headline, onStatus, onEdit, onOpenDiscussion, onPostUpdate, children,
}) {
  const { statuses, users } = useRefData();
  const [statusBusy, setStatusBusy] = useState(false);
  const task = detail.task;
  const due = task.due_date ? dueLabel(task.due_date, { done: task.stage === 'done' }) : null;
  const away = (id) => users.find((u) => u.id === id)?.away_today || null;
  const progress = Math.round(Number(task.effective_progress ?? task.progress) || 0);

  const threads = detail.threads || [];
  const openThreads = threads.filter((t) => t.status === 'open');
  const latest = [...threads]
    .sort((a, b) => new Date(b.last_message_at || b.updated_at || b.created_at)
      - new Date(a.last_message_at || a.updated_at || a.created_at))
    .slice(0, 2);

  const doneStatus = statuses.find((s) => s.stage === 'done');
  const isDone = task.stage === 'done';

  const change = async (statusId) => {
    setStatusBusy(true);
    try {
      await onStatus(Number(statusId));
    } finally {
      setStatusBusy(false);
    }
  };

  return (
    <div className="stack task-overview">
      <div className="stack-sm">
        <h2 className="task-overview-title">{task.title}</h2>
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]} priority</Badge>
          {due && <Badge tone={due.tone}><Icon name="clock" size={10} /> {due.text}</Badge>}
          {task.recurrence && task.recurrence !== 'none' && (
            <Badge tone="neutral">{RECURRENCE_LABEL[task.recurrence] || 'Repeats'}</Badge>
          )}
          {task.parent_ref && (
            <span className="small muted">Subtask of <span className="task-ref">{task.parent_ref}</span> {task.parent_title}</span>
          )}
        </div>
      </div>

      {headline && (
        <div className={`ask-banner ask-${headline.severity}`}>
          <Icon name="alert" size={15} />
          <div className="grow">
            <strong>{headline.label}</strong>
            <div className="small">
              Someone is waiting on this card.{' '}
              <button type="button" className="btn-link" onClick={onOpenDiscussion}>Open the discussion</button>
            </div>
          </div>
        </div>
      )}

      {/* the things people act on, before anything else */}
      {!isDone && (canMove || canEdit) && (
        <div className="task-actions">
          {canMove && (
            <label className="row" style={{ gap: 6 }}>
              <span className="small muted">Move to</span>
              <select className="select select-sm" value={task.status_id} disabled={statusBusy}
                onChange={(e) => change(e.target.value)} aria-label="Change status">
                {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {canMove && doneStatus && (
            <button type="button" className="btn btn-sm btn-primary" disabled={statusBusy}
              onClick={() => change(doneStatus.id)}>
              <Icon name="check" size={13} /> Mark done
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onPostUpdate}>
            <Icon name="note" size={13} /> Post an update
          </button>
        </div>
      )}

      <div className="task-facts">
        <Fact label="Owner">
          <Person name={task.assignee_name} color={task.assignee_color} awayEntry={away(task.assignee_id)} />
        </Fact>
        <Fact label="Deadline">
          {task.due_date ? (
            <>
              <div>{formatDate(task.due_date, { withTime: true })}</div>
              {task.due_date_changes > 0 && (
                <div className="small muted">moved {task.due_date_changes} time{task.due_date_changes === 1 ? '' : 's'}</div>
              )}
            </>
          ) : <span className="muted">None set</span>}
        </Fact>
        <Fact label="Progress">
          <div className="task-progress" aria-label={`${progress}% done`}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="small muted tnum">
            {progress}%
            {task.checklist_total > 0 && ` · ${task.checklist_done}/${task.checklist_total} steps`}
            {task.subtask_total > 0 && ` · ${task.subtask_done}/${task.subtask_total} subtasks`}
          </div>
        </Fact>
        {task.follower_name && (
          <Fact label="Also working on it">
            <Person name={task.follower_name} color={task.follower_color} awayEntry={away(task.follower_id)} />
          </Fact>
        )}
        <Fact label="Department">
          <span className="row" style={{ gap: 6 }}>
            {task.department_color && <span className="badge-dot" style={{ background: task.department_color }} />}
            {task.department_name || <span className="muted">None</span>}
          </span>
        </Fact>
        <Fact label="Type">
          <span style={{ textTransform: 'capitalize' }}>{String(task.task_type || 'task').replace(/-/g, ' ')}</span>
          {task.estimate_hours ? <span className="small muted"> · {Number(task.estimate_hours)}h estimated</span> : null}
        </Fact>
        {task.account_name && (
          <Fact label="Part of the work on">{task.account_name}</Fact>
        )}
      </div>

      <section className="stack-sm">
        <div className="stat-label">What this is</div>
        {task.description?.trim()
          ? <RichText text={task.description} />
          : (
            <p className="small muted">
              No description.{canEdit && (
                <> <button type="button" className="btn-link" onClick={onEdit}>Add one</button> so whoever picks this up knows what done looks like.</>
              )}
            </p>
          )}
        {task.tags?.length > 0 && (
          <div className="row wrap" style={{ gap: 4 }}>
            {task.tags.map((tag) => <span key={tag} className="tag-chip">{tag}</span>)}
          </div>
        )}
      </section>

      {children}

      <section className="stack-sm">
        <div className="row-between">
          <div className="stat-label">
            Latest conversation{openThreads.length ? ` · ${openThreads.length} open` : ''}
          </div>
          <button type="button" className="btn-link small" onClick={onOpenDiscussion}>
            {threads.length ? 'Open the discussion' : 'Start one'}
          </button>
        </div>
        {latest.length === 0 ? (
          <p className="small muted">
            Nothing said yet. Progress, a challenge, a question — post it here and everyone following
            the task sees it.
          </p>
        ) : latest.map((thread) => {
          const meta = threadKind(thread.kind);
          const last = thread.messages?.[thread.messages.length - 1];
          return (
            <button key={thread.id} type="button" className="task-thread-preview" onClick={onOpenDiscussion}>
              <span className={`kind-chip kind-${meta.severity} is-static`}>{meta.label}</span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                  {thread.title || thread.messages?.[0]?.body || meta.label}
                </span>
                {last && (
                  <span className="small muted truncate" style={{ display: 'block' }}>
                    {last.author_name}: {last.body}
                  </span>
                )}
              </span>
              <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                {replyCount(thread) || ''} {relativeTime(thread.last_message_at || thread.created_at)}
              </span>
            </button>
          );
        })}
      </section>

      <div className="row wrap small muted" style={{ gap: 14 }}>
        <span>Created by {task.created_by_name || 'someone'} · {formatDate(task.created_at)}</span>
        {task.reporter_name && task.reporter_name !== task.created_by_name && <span>Reported by {task.reporter_name}</span>}
        {task.completed_at && <span>Completed {formatDate(task.completed_at, { withTime: true })}</span>}
      </div>
    </div>
  );
}
