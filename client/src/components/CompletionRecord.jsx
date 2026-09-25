import { Avatar, Badge, EmptyState, Icon, Spinner } from './ui.jsx';
import { threadKind } from '../lib/threads.js';
import { formatDate, relativeTime, PRIORITY_LABEL, PRIORITY_TONE } from '../lib/format.js';

/**
 * What happened, rather than what the fields are.
 *
 * The task form answers "what is this task" in inputs you could change. Once the
 * work is finished the question is a different one — what was asked for, who did
 * it, how long it took, whether it landed on time, what they said they did, and
 * what it cost — and a form full of editable boxes makes the reader assemble
 * that themselves.
 *
 * Everything here was already stored as the work happened. Nothing is inferred,
 * and a task closed with nothing written says so rather than filling the gap.
 */

const DAY = 86_400_000;

const daysBetween = (from, to) => {
  if (!from || !to) return null;
  return (new Date(to).getTime() - new Date(from).getTime()) / DAY;
};

/** "took 6 days", the shape of how it went rather than two timestamps. */
function durationLabel(days) {
  if (days === null) return null;
  // a task closed before it was created is not a duration; saying "same day"
  // about it would present broken data as a fact
  if (days < 0) return null;
  if (days < 1) return 'same day';
  const whole = Math.round(days);
  return `${whole} day${whole === 1 ? '' : 's'}`;
}

function Fact({ label, children, tone }) {
  return (
    <div className={`record-fact${tone ? ` record-${tone}` : ''}`}>
      <div className="record-fact-label">{label}</div>
      <div className="record-fact-value">{children}</div>
    </div>
  );
}

export default function CompletionRecord({ data, onOpenTask }) {
  if (!data) return <Spinner label="Loading the record" />;

  const { task, timeline, closed_by: closedBy, outcome_note: note } = data;
  const marks = data.black_marks || [];
  const activeMarks = marks.filter((m) => m.status === 'active');

  const took = daysBetween(timeline.created_at, timeline.completed_at);
  const lateBy = timeline.due_date && timeline.completed_at
    ? daysBetween(timeline.due_date, timeline.completed_at)
    : null;
  const onTime = lateBy !== null && lateBy <= 0;

  const checklistDone = (data.checklist || []).filter((i) => i.is_done).length;
  const subtasksDone = (data.subtasks || []).filter((s) => s.stage === 'done').length;

  return (
    <div className="stack">
      {/* ---- the verdict, in one line ---- */}
      <div className={`record-verdict${onTime ? ' is-ontime' : lateBy !== null ? ' is-late' : ''}`}>
        <Icon name={onTime ? 'check' : lateBy !== null ? 'alert' : 'clock'} size={18} />
        <div className="grow">
          <strong>
            {lateBy === null
              ? 'Finished — there was no deadline to measure against'
              : onTime
                ? `Finished on time${took !== null ? `, ${durationLabel(took)} after it was created` : ''}`
                : `Finished ${Math.abs(lateBy).toFixed(1)} days after the deadline`}
          </strong>
          <div className="small">
            {timeline.completed_at
              ? `Closed ${relativeTime(timeline.completed_at)}`
              : 'Not closed yet'}
            {closedBy ? ` by ${closedBy.name}` : ''}
            {timeline.due_date_changes > 0
              && ` · the deadline was moved ${timeline.due_date_changes} time${timeline.due_date_changes === 1 ? '' : 's'} along the way`}
          </div>
        </div>
      </div>

      {/* ---- what was asked for ---- */}
      <section className="record-block">
        <div className="record-block-title">What was asked for</div>
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge tone={PRIORITY_TONE[task.priority]}>{PRIORITY_LABEL[task.priority]}</Badge>
          <Badge dot={task.department_color}>{task.department_name}</Badge>
          {task.task_type && <Badge>{String(task.task_type).replace(/-/g, ' ')}</Badge>}
          {task.recurrence && task.recurrence !== 'none' && <Badge>repeats {task.recurrence}</Badge>}
        </div>
        {task.description ? (
          <p className="record-text">{task.description}</p>
        ) : (
          <p className="small muted">No description was written when it was created.</p>
        )}
      </section>

      {/* ---- what was done ---- */}
      <section className="record-block">
        <div className="record-block-title">What they said was done</div>
        {note ? (
          <p className="record-text record-outcome">{note}</p>
        ) : (
          <p className="small muted">
            Nothing was recorded when this was closed, so what actually happened is not on file.
          </p>
        )}
      </section>

      {/* ---- the facts ---- */}
      <div className="record-facts">
        <Fact label="Owner">
          <span className="row" style={{ gap: 6 }}>
            <Avatar name={task.assignee_name || '?'} color={task.assignee_color} size={22} />
            <span>{task.assignee_name || 'Nobody'}</span>
          </span>
        </Fact>
        <Fact label="Created">{formatDate(timeline.created_at, { withTime: true })}</Fact>
        <Fact label="Deadline">
          {timeline.due_date ? formatDate(timeline.due_date, { withTime: true }) : 'None set'}
          {timeline.original_due_date
            && String(timeline.original_due_date) !== String(timeline.due_date) && (
            <div className="small muted">first promised {formatDate(timeline.original_due_date)}</div>
          )}
        </Fact>
        <Fact label="Closed">
          {timeline.completed_at ? formatDate(timeline.completed_at, { withTime: true }) : '—'}
        </Fact>
        <Fact label="Took">{durationLabel(took) || '—'}</Fact>
        <Fact label="Cost" tone={activeMarks.length ? 'critical' : undefined}>
          {activeMarks.length === 0
            ? 'No black marks'
            : `${activeMarks.length} black mark${activeMarks.length === 1 ? '' : 's'}`}
        </Fact>
      </div>

      {/* ---- what it cost, if anything ---- */}
      {marks.length > 0 && (
        <section className="record-block">
          <div className="record-block-title">Black marks from this task</div>
          <div className="stack-sm">
            {marks.map((mark) => (
              <div key={mark.id} className="record-mark">
                <Badge tone={mark.status === 'waived' ? 'neutral' : 'critical'}>
                  {Number(mark.points)} pt{Number(mark.points) === 1 ? '' : 's'}
                </Badge>
                <div className="grow">
                  <div className="small">{mark.reason}</div>
                  <div className="small muted">
                    {mark.rule_name ? `${mark.rule_name} · ` : ''}{formatDate(mark.occurred_at)}
                    {mark.status === 'waived' && (
                      <> · waived{mark.waived_by_name ? ` by ${mark.waived_by_name}` : ''}
                        {mark.waived_reason ? ` — ${mark.waived_reason}` : ''}</>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- what it was for ---- */}
      {(data.key_results?.length > 0 || task.account_name) && (
        <section className="record-block">
          <div className="record-block-title">What it was for</div>
          <div className="stack-sm">
            {task.account_name && (
              <div className="link-row">
                <Icon name="pipeline" size={14} />
                <span className="grow truncate">{task.account_name}</span>
              </div>
            )}
            {data.key_results?.map((kr) => (
              <div key={kr.id} className="link-row">
                <Icon name="target" size={14} />
                <span className="grow truncate">
                  {kr.title}
                  <span className="muted"> · {kr.objective_title}</span>
                </span>
                {kr.is_primary && <Badge tone="brand">primary</Badge>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- the steps ---- */}
      {(data.subtasks?.length > 0 || data.checklist?.length > 0) && (
        <section className="record-block">
          <div className="record-block-title">How it was broken down</div>
          {data.subtasks?.length > 0 && (
            <>
              <div className="small muted">
                {subtasksDone} of {data.subtasks.length} sub tasks finished
              </div>
              <div className="stack-sm">
                {data.subtasks.map((subtask) => (
                  <button
                    key={subtask.id}
                    type="button"
                    className="link-row"
                    onClick={() => onOpenTask?.(subtask.id)}
                  >
                    <Icon name={subtask.stage === 'done' ? 'check' : 'subtask'} size={13} />
                    <span className="task-ref">{subtask.ref}</span>
                    <span className="grow truncate">{subtask.title}</span>
                    <Badge tone={subtask.stage === 'done' ? 'good' : 'neutral'}>
                      {subtask.status_name}
                    </Badge>
                  </button>
                ))}
              </div>
            </>
          )}
          {data.checklist?.length > 0 && (
            <div className="small muted" style={{ marginTop: 6 }}>
              Checklist: {checklistDone} of {data.checklist.length} ticked
            </div>
          )}
        </section>
      )}

      {/* ---- what was said ---- */}
      <section className="record-block">
        <div className="record-block-title">What was said while it ran</div>
        {(data.threads || []).length === 0 ? (
          <div className="small muted">Nothing was discussed on this task.</div>
        ) : (
          <div className="stack-sm">
            {data.threads.map((thread) => {
              const meta = threadKind(thread.kind);
              return (
                <div key={thread.id} className={`thread thread-${meta.severity}`}>
                  <div className="thread-head" style={{ cursor: 'default' }}>
                    <span className={`kind-chip kind-${meta.severity} is-static`}>{meta.label}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="thread-title">
                        {thread.title || thread.messages?.[0]?.body?.slice(0, 80)}
                      </span>
                      <span className="small muted thread-sub">
                        {thread.opened_by_name || 'Someone'} · {relativeTime(thread.created_at)}
                      </span>
                    </span>
                    {thread.status === 'resolved' && <Badge tone="good">Closed</Badge>}
                  </div>
                  {thread.conclusion && (
                    <div className="thread-conclusion">
                      <Icon name="check" size={13} />
                      <span><strong>Concluded:</strong> {thread.conclusion}</span>
                    </div>
                  )}
                  <div className="thread-body">
                    {(thread.messages || []).map((message) => (
                      <div key={message.id} className="thread-message">
                        <Avatar name={message.author_name || 'Someone'}
                          color={message.avatar_color} size={22} />
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="row" style={{ gap: 7 }}>
                            <strong className="small">{message.author_name || 'Removed user'}</strong>
                            <span className="small muted">{relativeTime(message.created_at)}</span>
                          </div>
                          <div className="thread-text">{message.body}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ---- how it moved ---- */}
      <section className="record-block">
        <div className="record-block-title">How it moved</div>
        {(data.milestones || []).length === 0 ? (
          <div className="small muted">Nothing recorded.</div>
        ) : (
          <div className="stack-sm">
            {data.milestones.map((item) => (
              <div key={item.id} className="record-step">
                <span className="record-step-dot" />
                <div className="grow">
                  <div className="small">
                    <strong>{item.actor_name || 'TaskFlow'}</strong>{' '}
                    {item.action === 'created' ? 'created it'
                      : item.action === 'completed' ? 'marked it done'
                        : item.action === 'reopened' ? 'reopened it'
                          : item.action === 'moved'
                            ? `moved it to ${item.meta?.to_status || 'another column'}`
                            : item.field === 'assignee_id' ? 'handed it to someone else'
                              : item.field === 'due_date' ? 'moved the deadline'
                                : item.action.replace(/_/g, ' ')}
                  </div>
                  <div className="small muted">{formatDate(item.created_at, { withTime: true })}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {data.collaborators?.length > 0 && (
        <section className="record-block">
          <div className="record-block-title">Who else was on it</div>
          <div className="row wrap" style={{ gap: 8 }}>
            {data.collaborators.map((person) => (
              <span key={person.id} className="row" style={{ gap: 5 }}>
                <Avatar name={person.full_name} color={person.avatar_color} size={20} />
                <span className="small">{person.full_name}</span>
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
