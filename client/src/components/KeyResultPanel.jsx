import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import KeyResultEditDialog from './KeyResultEditDialog.jsx';
import DiscussionPanel from './DiscussionPanel.jsx';
import TaskDialog from './TaskDialog.jsx';
import {
  CONFIDENCE, formatValue, health, krAttention, measurementSummary, pace, worstSeverity,
} from '../lib/okr.js';
import { threadHeadline } from '../lib/threads.js';
import { formatDate, relativeTime, STAGE_LABEL } from '../lib/format.js';

/**
 * Recording where a key result stands.
 *
 * Called "Update progress" everywhere it is offered — "check in" is what the
 * system stores, not what a person thinks they are doing. The API underneath is
 * unchanged: this posts the same check-in it always did.
 *
 * On a narrow screen it comes up from the bottom as a sheet, because a centred
 * dialog with a number pad over it leaves the field under the keyboard.
 */
export function UpdateProgressDialog({ keyResult, onClose, onSaved }) {
  const toast = useToast();
  const binary = keyResult.measurement_type === 'BINARY';
  const rollup = keyResult.measurement_type === 'TASK_ROLLUP';

  const [value, setValue] = useState(binary ? Number(keyResult.current_value) >= 1 : keyResult.current_value ?? 0);
  const [confidence, setConfidence] = useState('MEDIUM');
  const [note, setNote] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { key_result: saved } = await api.checkIn(keyResult.id, {
        current_value: binary ? (value ? 1 : 0) : Number(value),
        confidence,
        note: note.trim() || undefined,
        next_action: nextAction.trim() || undefined,
      });
      toast.success('Progress updated');
      onSaved(saved);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Update progress"
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save update'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="complete-intro">
          <strong>{keyResult.title}</strong>
          <div className="small" style={{ marginTop: 3 }}>
            {measurementSummary(keyResult)}
            {keyResult.last_check_in_at
              ? ` · last updated ${relativeTime(keyResult.last_check_in_at)}`
              : ' · never updated'}
          </div>
        </div>

        {rollup ? (
          <div className="small muted">
            This key result follows its linked tasks, so the number moves on its own as work is
            finished. Use the note below to say where it really stands.
          </div>
        ) : binary ? (
          <Field label="Has it happened?">
            <label className="checklist-item">
              <input type="checkbox" checked={Boolean(value)} onChange={(e) => setValue(e.target.checked)} />
              <span>Yes, this is done</span>
            </label>
          </Field>
        ) : (
          <Field
            label="Where is it now?"
            hint={`Target ${formatValue(keyResult.target_value, keyResult)}${
              keyResult.direction === 'DECREASE' ? ' — lower is better' : ''
            }`}
          >
            <input
              className="input"
              type="number"
              step="any"
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
        )}

        <Field label="How confident are you about hitting the target?">
          <div className="row wrap">
            {CONFIDENCE.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn btn-sm${confidence === option.value ? ' btn-primary' : ''}`}
                onClick={() => setConfidence(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="What moved, or what got in the way?">
          <textarea
            className="textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Forty signed up at the Nashik field day; the dealer list is the bottleneck."
          />
        </Field>

        <Field label="What happens before the next update?">
          <input
            className="input"
            value={nextAction}
            onChange={(e) => setNextAction(e.target.value)}
            placeholder="Get the dealer list from procurement"
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Attaching existing task cards to a key result. */
function LinkTaskDialog({ keyResult, linkedIds, onClose, onSaved }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [tasks, setTasks] = useState([]);
  const [linked, setLinked] = useState(() => new Set(linkedIds));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .tasks({ search: search || undefined, limit: 40 })
      .then((all) => live && setTasks(all.tasks || []))
      .catch((err) => toast.error(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [search]);

  const toggle = async (task) => {
    try {
      if (linked.has(task.id)) {
        await api.unlinkTask(keyResult.id, task.id);
        setLinked((current) => new Set([...current].filter((id) => id !== task.id)));
      } else {
        await api.linkTask(keyResult.id, { task_id: task.id });
        setLinked((current) => new Set(current).add(task.id));
      }
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Modal
      title="Link tasks to this key result"
      size="lg"
      onClose={onClose}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}
    >
      <div className="stack">
        <div className="small muted">
          Linking does not change the task. It only says this work is what moves the number.
        </div>
        <input
          className="input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks by title or reference"
        />

        {loading ? (
          <Spinner label="Finding tasks" />
        ) : tasks.length === 0 ? (
          <EmptyState title="No tasks matched" />
        ) : (
          <div className="stack-sm">
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className={`link-row${linked.has(task.id) ? ' is-linked' : ''}`}
                onClick={() => toggle(task)}
              >
                <span className="task-ref">{task.ref}</span>
                <span className="grow truncate">{task.title}</span>
                <Badge tone={task.stage === 'done' ? 'good' : 'neutral'}>
                  {STAGE_LABEL[task.stage] || task.status_name}
                </Badge>
                <Icon name={linked.has(task.id) ? 'check' : 'plus'} size={14} />
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** One row in the linked-work list, on both the card and the drawer. */
function TaskRow({ task, onOpenTask, onUnlink }) {
  return (
    <div className={`link-row${task.is_overdue ? ' is-late' : ''}`}>
      <span className="task-ref">{task.ref}</span>
      <button type="button" className="grow truncate btn-link" onClick={() => onOpenTask?.(task.id)}>
        {task.title}
      </button>
      {task.is_overdue && <Badge tone="critical">late</Badge>}
      {task.assignee_name && (
        <Avatar name={task.assignee_name} color={task.assignee_color} size={20} title={task.assignee_name} />
      )}
      <Badge tone={task.stage === 'done' ? 'good' : 'neutral'}>
        {STAGE_LABEL[task.stage] || task.status_name}
      </Badge>
      {onUnlink && (
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-label={`Unlink ${task.ref}`}
          onClick={() => onUnlink(task)}
        >
          <Icon name="close" size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * The INVESTIGATE level: everything about one key result, behind tabs so the
 * page underneath never has to carry it.
 */
export function KeyResultDrawer({ keyResult, tasks, canEdit, onClose, onChanged, onOpenTask }) {
  const { user, can } = useAuth();
  const toast = useToast();

  const [tab, setTab] = useState('progress');
  const [checkIns, setCheckIns] = useState(null);
  const [threads, setThreads] = useState(null);
  const [canRaiseReview, setCanRaiseReview] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);

  const mine = keyResult.owner_user_id === user.id;
  const mayUpdate = can('okr.checkin') && (canEdit || mine);
  const mayEdit = canEdit || mine;
  const meta = health(keyResult.health);
  const reading = pace(keyResult.progress_percent, keyResult.time_elapsed_percent);
  const reasons = krAttention(keyResult);

  const loadHistory = () => {
    api
      .checkInHistory(keyResult.id)
      .then((data) => setCheckIns(data.check_ins || []))
      .catch((err) => toast.error(err));
  };

  const loadThreads = () => {
    api
      .threads('KEY_RESULT', keyResult.id)
      .then((data) => {
        setThreads(data.threads || []);
        setCanRaiseReview(Boolean(data.can_raise_review));
      })
      .catch((err) => toast.error(err));
  };

  useEffect(() => {
    if (tab === 'updates' && checkIns === null) loadHistory();
    if (tab === 'discussion' && threads === null) loadThreads();
  }, [tab, keyResult.id]);

  const openThreads = keyResult.open_threads || 0;
  const TABS = [
    { key: 'progress', label: 'Progress' },
    { key: 'work', label: `Work (${tasks.length})` },
    { key: 'updates', label: 'Updates' },
    { key: 'discussion', label: `Discussion${openThreads ? ` (${openThreads})` : ''}` },
  ];

  return (
    <Modal
      title={
        <div className="stack-sm" style={{ gap: 3 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <Badge tone={meta.tone} dot={meta.color}>{meta.label}</Badge>
            {keyResult.is_overridden && <Badge title="Set by hand, not calculated">manual</Badge>}
          </div>
          <h2 style={{ fontSize: 15.5, lineHeight: 1.35 }}>{keyResult.title}</h2>
        </div>
      }
      size="lg"
      onClose={onClose}
      footer={
        <>
          {mayEdit && (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              <Icon name="edit" size={13} /> Edit
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {mayUpdate && (
            <button type="button" className="btn btn-primary" onClick={() => setUpdating(true)}>
              Update progress
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'progress' && (
          <div className="stack">
            <div className="kr-figures">
              <div className="kr-figure-cell">
                <div className="stat-label">Where it stands</div>
                <div className="stat-value tnum" style={{ color: meta.color, fontSize: 22 }}>
                  {keyResult.progress_percent === null ? '—' : `${keyResult.progress_percent}%`}
                </div>
                <div className="stat-note">{measurementSummary(keyResult)}</div>
              </div>
              <div className="kr-figure-cell">
                <div className="stat-label">Time gone</div>
                <div className="stat-value tnum" style={{ fontSize: 22 }}>
                  {keyResult.time_elapsed_percent === null ? '—' : `${keyResult.time_elapsed_percent}%`}
                </div>
                <div className="stat-note">{reading.label}</div>
              </div>
              <div className="kr-figure-cell">
                <div className="stat-label">Owner</div>
                <div className="row" style={{ marginTop: 6 }}>
                  <Avatar name={keyResult.owner_name || '?'} color={keyResult.owner_color} size={26} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {keyResult.owner_name || 'Nobody yet'}
                  </span>
                </div>
                <div className="stat-note" style={{ marginTop: 4 }}>
                  {keyResult.last_check_in_at
                    ? `Updated ${relativeTime(keyResult.last_check_in_at)}`
                    : 'Never updated'}
                </div>
              </div>
            </div>

            {keyResult.description && <p className="small">{keyResult.description}</p>}

            {reasons.length > 0 && (
              <div className="stack-sm">
                {reasons.map((reason) => (
                  <div key={reason.kind} className="sig-row">
                    <span className={`sig-dot sig-${reason.severity}`} />
                    <span className="grow">
                      <strong className="small">{reason.label}</strong>{' '}
                      <span className="small muted">{reason.detail}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {keyResult.needs_target ? (
              <div className="small muted">
                No target is set, so the outcome itself cannot be scored — the percentage above is how
                much of the linked work is finished.{' '}
                {mayEdit && (
                  <button type="button" className="btn-link" onClick={() => setEditing(true)}>
                    Set a target
                  </button>
                )}
              </div>
            ) : (
              keyResult.measurement_type !== 'TASK_ROLLUP' && keyResult.execution_progress !== null && (
                <div className="small muted">
                  Linked work is {keyResult.execution_progress}% finished, and the result itself is{' '}
                  {keyResult.result_progress === null ? 'not measurable yet' : `${keyResult.result_progress}%`} —
                  finishing the work is not the same as hitting the number.
                </div>
              )
            )}

            {keyResult.is_overridden && (
              <div className="small">
                Shown as <strong>{meta.label}</strong> by hand — the numbers say{' '}
                {health(keyResult.auto_health).label}.
                {keyResult.health_override_reason && ` “${keyResult.health_override_reason}”`}
              </div>
            )}
          </div>
        )}

        {tab === 'work' && (
          <div className="stack">
            <div className="row-between wrap">
              <span className="small muted">
                The tasks that move this number. Linking does not change the task itself.
              </span>
              <div className="row wrap">
                {can('task.create') && can('okr.link.task') && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreatingTask(true)}>
                    <Icon name="plus" size={13} /> New task
                  </button>
                )}
                {can('okr.link.task') && (
                  <button type="button" className="btn btn-sm" onClick={() => setLinking(true)}>
                    <Icon name="link" size={13} /> Link existing
                  </button>
                )}
              </div>
            </div>

            {tasks.length === 0 ? (
              <EmptyState title="No tasks linked yet">
                Linking the work makes it obvious which cards are moving this number.
              </EmptyState>
            ) : (
              <div className="stack-sm">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onOpenTask={onOpenTask}
                    onUnlink={
                      can('okr.link.task')
                        ? async (t) => {
                          try {
                            await api.unlinkTask(keyResult.id, t.id);
                            onChanged?.();
                          } catch (err) {
                            toast.error(err);
                          }
                        }
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'updates' && (
          checkIns === null ? (
            <Spinner label="Loading updates" />
          ) : checkIns.length === 0 ? (
            <EmptyState title="Nothing recorded yet">
              Every update leaves a line here, so the shape of the progress survives.
            </EmptyState>
          ) : (
            <div className="stack-sm">
              {checkIns.map((entry) => (
                <div key={entry.id} className="check-in">
                  <div className="row-between wrap">
                    <div className="row">
                      <Avatar name={entry.user_name || 'Someone'} color={entry.avatar_color} size={20} />
                      <span className="small" style={{ fontWeight: 600 }}>{entry.user_name || 'Someone'}</span>
                      {/* a task roll-up has no value of its own to move, so the
                          note is the whole update */}
                      {keyResult.measurement_type === 'TASK_ROLLUP' ? (
                        <span className="small muted">
                          {entry.resulting_progress === null
                            ? ''
                            : `${Math.round(entry.resulting_progress)}% of the work done`}
                        </span>
                      ) : (
                        <span className="small muted tnum">
                          {formatValue(entry.previous_value, keyResult)} → {formatValue(entry.current_value, keyResult)}
                        </span>
                      )}
                    </div>
                    <div className="row">
                      {entry.confidence && (
                        <Badge tone={CONFIDENCE.find((c) => c.value === entry.confidence)?.tone}>
                          {CONFIDENCE.find((c) => c.value === entry.confidence)?.label}
                        </Badge>
                      )}
                      <span className="small muted">{formatDate(entry.created_at, { withTime: true })}</span>
                    </div>
                  </div>
                  {entry.note && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{entry.note}</div>}
                  {entry.next_action && <div className="small muted">Next: {entry.next_action}</div>}
                </div>
              ))}
            </div>
          )
        )}

        {tab === 'discussion' && (
          threads === null ? (
            <Spinner label="Loading the discussion" />
          ) : (
            <DiscussionPanel
              entityType="KEY_RESULT"
              entityId={keyResult.id}
              threads={threads}
              canRaiseReview={canRaiseReview}
              onChanged={() => {
                loadThreads();
                onChanged?.();
              }}
            />
          )
        )}
      </div>

      {updating && (
        <UpdateProgressDialog
          keyResult={keyResult}
          onClose={() => setUpdating(false)}
          onSaved={() => {
            onChanged?.();
            setCheckIns(null);
            if (tab === 'updates') loadHistory();
          }}
        />
      )}
      {linking && (
        <LinkTaskDialog
          keyResult={keyResult}
          linkedIds={tasks.map((t) => t.id)}
          onClose={() => setLinking(false)}
          onSaved={() => onChanged?.()}
        />
      )}
      {editing && (
        <KeyResultEditDialog
          keyResult={keyResult}
          onClose={() => setEditing(false)}
          onSaved={() => onChanged?.()}
        />
      )}
      {creatingTask && (
        // an ordinary task, created through the normal task API and already
        // pointed at this key result — so it lands on the board like any other
        <TaskDialog
          defaults={{
            key_result: keyResult,
            assignee_id: keyResult.owner_user_id || undefined,
            department_id: keyResult.department_id || undefined,
          }}
          onClose={() => setCreatingTask(false)}
          onSaved={() => onChanged?.()}
        />
      )}
    </Modal>
  );
}

/**
 * The SCAN level: one key result, readable without opening anything.
 *
 * Everything here comes from data the goal page already loaded, so a page of
 * ten key results makes no extra requests — the old accordion fetched twice per
 * key result the moment it was expanded.
 */
export default function KeyResultPanel({ keyResult, tasks = [], canEdit, onChanged, onOpenTask }) {
  const { user, can } = useAuth();

  const [updating, setUpdating] = useState(false);
  const [open, setOpen] = useState(false);

  const mine = keyResult.owner_user_id === user.id;
  const mayUpdate = can('okr.checkin') && (canEdit || mine);
  const meta = health(keyResult.health);
  const progress = keyResult.progress_percent;
  const reading = pace(progress, keyResult.time_elapsed_percent);
  const reasons = krAttention(keyResult);
  // a change asked for by a person outranks anything the system worked out
  const asked = keyResult.open_reviews
    ? { label: 'Needs improvement', severity: 'warning' }
    : keyResult.open_help
      ? { label: 'Help needed', severity: 'warning' }
      : null;
  const severity = asked?.severity || (reasons.length ? worstSeverity(reasons) : null);
  // the headline number is the work's, not the outcome's — say so rather than
  // letting it pass as a measured result
  const fromWork = keyResult.progress_source === 'execution' && keyResult.measurement_type !== 'TASK_ROLLUP';
  const openTasks = tasks.filter((t) => t.stage !== 'done' && t.stage !== 'cancelled').length;

  return (
    <>
      <div className={`kr${severity ? ` kr-${severity}` : ''}`}>
        <span className="kr-rail" style={{ background: meta.color }} aria-hidden="true" />

        <div className="kr-main">
          <button type="button" className="kr-title" onClick={() => setOpen(true)}>
            {keyResult.title}
          </button>

          <div className="kr-meta">
            <span className="kr-measure tnum">{measurementSummary(keyResult)}</span>
            {keyResult.owner_name && (
              <span className="row" style={{ gap: 5 }}>
                <Avatar name={keyResult.owner_name} color={keyResult.owner_color} size={18} />
                <span>{mine ? 'You' : keyResult.owner_name}</span>
              </span>
            )}
            {tasks.length > 0 && (
              <span>{tasks.length} task{tasks.length === 1 ? '' : 's'}{openTasks > 0 && `, ${openTasks} open`}</span>
            )}
            <span>
              {keyResult.last_check_in_at
                ? `updated ${relativeTime(keyResult.last_check_in_at)}`
                : 'never updated'}
            </span>
          </div>

          {(asked || reasons.length > 0) && (
            <div className="kr-flags">
              {asked && (
                <span
                  className={`kr-flag kr-flag-${asked.severity} kr-flag-asked`}
                  title="Someone has asked for a change here — open Details to see the thread"
                >
                  {asked.label}
                </span>
              )}
              {reasons.map((reason) => (
                <span key={reason.kind} className={`kr-flag kr-flag-${reason.severity}`} title={reason.detail}>
                  {reason.label}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="kr-score">
          <div className="kr-percent tnum" style={{ color: meta.color }}>
            {progress === null ? '—' : `${progress}%`}
          </div>
          <span className="progress-track">
            <span className="progress-fill" style={{ width: `${progress ?? 0}%`, background: meta.color }} />
            {keyResult.time_elapsed_percent !== null && (
              <span
                className="progress-pace"
                style={{ left: `${keyResult.time_elapsed_percent}%` }}
                title="Where the calendar says it should be"
              />
            )}
          </span>
          <div className="kr-score-note">
            {fromWork ? 'of the work' : reading.verdict === 'unknown' ? meta.label : reading.label}
          </div>
        </div>

        <div className="kr-actions">
          {mayUpdate && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setUpdating(true)}>
              Update progress
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
            Details
          </button>
        </div>
      </div>

      {updating && (
        <UpdateProgressDialog
          keyResult={keyResult}
          onClose={() => setUpdating(false)}
          onSaved={() => onChanged?.()}
        />
      )}
      {open && (
        <KeyResultDrawer
          keyResult={keyResult}
          tasks={tasks}
          canEdit={canEdit}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
          onOpenTask={onOpenTask}
        />
      )}
    </>
  );
}
