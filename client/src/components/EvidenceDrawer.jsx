import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Modal, Spinner } from './ui.jsx';
import { formatDate, relativeTime, PRIORITY_TONE, PRIORITY_LABEL } from '../lib/format.js';

/**
 * The records behind a number on someone's review.
 *
 * A review that cannot be opened is an accusation. "8 tasks are overdue" is only
 * useful once you can see which eight, how far past the date each one is, and go
 * and do something about it — so every figure and every finding opens this.
 *
 * The list is produced by the same predicate that produced the count, so the two
 * can never disagree.
 */

const overdueTone = (days) => {
  if (days === null || days === undefined) return 'neutral';
  const n = Number(days);
  if (n >= 7) return 'critical';
  if (n >= 2) return 'warning';
  return 'neutral';
};

function TaskRow({ task, onOpen }) {
  const done = task.stage === 'done';
  const late = task.days_late !== null && task.days_late !== undefined && Number(task.days_late) > 0;
  const overdue = task.days_overdue !== null && task.days_overdue !== undefined;

  return (
    <button type="button" className="evidence-row" onClick={() => onOpen(task)}>
      <span className="evidence-main">
        <span className="row wrap" style={{ gap: 6 }}>
          <span className="task-ref">{task.ref}</span>
          <span className="evidence-title">{task.title}</span>
        </span>
        <span className="row wrap small muted" style={{ gap: 6, marginTop: 3 }}>
          <Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</Badge>
          <span>{task.department_name}</span>
          {task.due_date && <><span>·</span><span>due {formatDate(task.due_date)}</span></>}
          {task.due_date_changes > 0 && (
            <><span>·</span><span>moved {task.due_date_changes}×</span></>
          )}
          {task.marks > 0 && (
            <><span>·</span><span className="crit-count">{task.marks} black mark{task.marks === 1 ? '' : 's'}</span></>
          )}
        </span>
        {/* the note already half-answers "what went wrong here" */}
        {task.completion_note && (
          <span className="evidence-note">{task.completion_note}</span>
        )}
      </span>

      <span className="evidence-figure">
        {late && (
          <Badge tone={overdueTone(task.days_late)}>
            {Number(task.days_late).toFixed(1)} days late
          </Badge>
        )}
        {overdue && (
          <Badge tone={overdueTone(task.days_overdue)}>
            {Number(task.days_overdue).toFixed(0)} days overdue
          </Badge>
        )}
        {!late && !overdue && (
          <Badge tone={done ? 'good' : 'neutral'}>{task.status_name}</Badge>
        )}
        {done && task.completed_at && (
          <span className="small muted">finished {relativeTime(task.completed_at)}</span>
        )}
      </span>
      <Icon name="chevron" size={13} />
    </button>
  );
}

function MarkRow({ mark }) {
  return (
    <div className="evidence-row is-static">
      <span className="evidence-main">
        <span className="row wrap" style={{ gap: 6 }}>
          {mark.task_ref && <span className="task-ref">{mark.task_ref}</span>}
          <span className="evidence-title">{mark.task_title || mark.reason}</span>
        </span>
        <span className="small muted">
          {mark.rule_name ? `${mark.rule_name} · ` : ''}{mark.reason}
          {' · '}{formatDate(mark.occurred_at)}
          {mark.source === 'manual' && mark.raised_by_name ? ` · raised by ${mark.raised_by_name}` : ''}
        </span>
      </span>
      <span className="evidence-figure">
        <Badge tone="critical">{Number(mark.points)} pt{Number(mark.points) === 1 ? '' : 's'}</Badge>
      </span>
    </div>
  );
}

function KudosRow({ item }) {
  return (
    <div className="evidence-row is-static">
      <Avatar name={item.from_name || 'Someone'} color={item.from_color} size={26} />
      <span className="evidence-main">
        <span className="evidence-title">{item.message}</span>
        <span className="small muted">
          {item.from_name || 'Someone'} · {relativeTime(item.created_at)}
          {item.task_ref ? ` · ${item.task_ref}` : ''}
        </span>
      </span>
    </div>
  );
}

export default function EvidenceDrawer({ userId, userName, metric, taskType, month, title, onClose, onOpenTask }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setFailed(null);
    api
      .performanceEvidence(userId, { metric, month, task_type: taskType })
      .then((result) => live && setData(result.evidence))
      .catch((err) => {
        if (!live) return;
        // a figure with no records behind it is worth saying out loud rather
        // than showing an empty list that looks like a loading failure
        setFailed(err.status === 404 ? 'nothing' : err);
        if (err.status !== 404) toast.error(err);
      });
    return () => { live = false; };
  }, [userId, metric, taskType, month]);

  const rows = data?.tasks || data?.marks || data?.kudos || [];
  const count = rows.length;

  return (
    <Modal
      title={
        <div className="stack-sm" style={{ gap: 2 }}>
          <h2 style={{ fontSize: 15.5 }}>{title || data?.label || 'The records behind this'}</h2>
          <span className="small muted">
            {userName}
            {data && (
              <>
                {' · '}
                {data.basis === 'now'
                  ? 'as things stand right now'
                  : `between ${formatDate(data.period.start)} and ${formatDate(data.period.end)}`}
              </>
            )}
          </span>
        </div>
      }
      size="lg"
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}
    >
      {failed === 'nothing' ? (
        <EmptyState title="Nothing is recorded behind this figure">
          That usually means the number came from somewhere other than task records.
        </EmptyState>
      ) : !data ? (
        <Spinner label="Finding the records" />
      ) : count === 0 ? (
        <EmptyState title="Nothing here">
          The figure is zero, so there is nothing to look at — which is the good outcome.
        </EmptyState>
      ) : (
        <div className="stack-sm">
          <div className="small muted">
            {count} record{count === 1 ? '' : 's'}. {data.tasks ? 'Open any one to see what happened.' : ''}
          </div>
          {data.tasks?.map((task) => (
            <TaskRow key={task.id} task={task} onOpen={onOpenTask} />
          ))}
          {data.marks?.map((mark) => <MarkRow key={mark.id} mark={mark} />)}
          {data.kudos?.map((item) => <KudosRow key={item.id} item={item} />)}
        </div>
      )}
    </Modal>
  );
}
