import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import KeyResultEditDialog from './KeyResultEditDialog.jsx';
import TaskDialog from './TaskDialog.jsx';
import { CONFIDENCE, formatValue, health, measurementSummary } from '../lib/okr.js';
import { formatDate, relativeTime, STAGE_LABEL } from '../lib/format.js';

/** Posting a check-in: the number, how it feels, and what happens next. */
function CheckInDialog({ keyResult, onClose, onSaved }) {
  const toast = useToast();
  const binary = keyResult.measurement_type === 'BINARY';

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
      toast.success('Check-in recorded');
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
      title="Check in"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Post check-in'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="complete-intro">
          <strong>{keyResult.title}</strong>
          <div className="small" style={{ marginTop: 3 }}>
            {measurementSummary(keyResult)}
            {keyResult.last_check_in_at && ` · last checked ${relativeTime(keyResult.last_check_in_at)}`}
          </div>
        </div>

        {keyResult.measurement_type === 'TASK_ROLLUP' ? (
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

        <Field label="What happens before the next check-in?">
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
function LinkTaskDialog({ keyResult, onClose, onSaved }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [tasks, setTasks] = useState([]);
  const [linked, setLinked] = useState(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([api.tasks({ search: search || undefined, limit: 40 }), api.keyResultTasks(keyResult.id)])
      .then(([all, existing]) => {
        if (!live) return;
        setTasks(all.tasks || []);
        setLinked(new Set((existing.tasks || []).map((t) => t.id)));
      })
      .catch((err) => toast.error(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [search, keyResult.id]);

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

export default function KeyResultPanel({ keyResult, canEdit, onChanged, onOpenTask }) {
  const { user, can } = useAuth();
  const toast = useToast();

  const [expanded, setExpanded] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [linking, setLinking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [detail, setDetail] = useState(null);
  const [tasks, setTasks] = useState([]);

  const mine = keyResult.owner_user_id === user.id;
  const mayCheckIn = can('okr.checkin') && (canEdit || mine);
  const mayEdit = canEdit || mine;
  const meta = health(keyResult.health);
  const progress = keyResult.progress_percent;
  // the headline number is the work's, not the outcome's — say so rather than
  // letting it pass as a measured result
  const fromWork = keyResult.progress_source === 'execution' && keyResult.measurement_type !== 'TASK_ROLLUP';

  const loadDetail = () => {
    Promise.all([api.keyResult(keyResult.id), api.keyResultTasks(keyResult.id)])
      .then(([data, taskData]) => {
        setDetail(data);
        setTasks(taskData.tasks || []);
      })
      .catch((err) => toast.error(err));
  };

  useEffect(() => {
    if (expanded) loadDetail();
  }, [expanded, keyResult.id]);

  return (
    <div className="kr">
      <div className="kr-head">
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <Icon name="chevron" size={14} style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />
        </button>

        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>{keyResult.title}</span>
            <Badge tone={meta.tone} dot={meta.color}>{meta.label}</Badge>
            {keyResult.is_overridden && <Badge title="Set by hand, not calculated">manual</Badge>}
            {keyResult.needs_target && (
              <Badge tone="warning" title="Without a target the outcome cannot be scored">
                needs a target
              </Badge>
            )}
          </div>
          <div className="small muted">
            {measurementSummary(keyResult)}
            {keyResult.owner_name && ` · ${keyResult.owner_name}`}
            {keyResult.last_check_in_at
              ? ` · checked ${relativeTime(keyResult.last_check_in_at)}`
              : ' · never checked in'}
          </div>
        </div>

        <div className="kr-figure">
          <div className="kr-percent tnum">{progress === null ? '—' : `${progress}%`}</div>
          <span className="progress-track" style={{ width: 92 }}>
            <span
              className="progress-fill"
              style={{ width: `${progress ?? 0}%`, background: meta.color }}
            />
          </span>
          {fromWork && <span className="small muted" style={{ fontSize: 10.5 }}>of the work</span>}
        </div>

        {mayCheckIn && (
          <button type="button" className="btn btn-sm" onClick={() => setCheckingIn(true)}>
            Check in
          </button>
        )}
      </div>

      {expanded && (
        <div className="kr-body">
          {keyResult.description && <p className="small">{keyResult.description}</p>}

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

          <div className="row-between wrap">
            <span className="small" style={{ fontWeight: 650 }}>
              Linked tasks {tasks.length > 0 && <span className="muted">({tasks.length})</span>}
            </span>
            <div className="row wrap">
              {mayEdit && (
                <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                  <Icon name="edit" size={13} /> Edit
                </button>
              )}
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
            <div className="small muted">
              No tasks linked yet. Linking the work makes it obvious which cards are moving this number.
            </div>
          ) : (
            <div className="stack-sm">
              {tasks.map((task) => (
                <div key={task.id} className="link-row">
                  <span className="task-ref">{task.ref}</span>
                  <button
                    type="button"
                    className="grow truncate btn-link"
                    onClick={() => onOpenTask?.(task.id)}
                  >
                    {task.title}
                  </button>
                  {task.assignee_name && (
                    <Avatar name={task.assignee_name} color={task.assignee_color} size={20} />
                  )}
                  <Badge tone={task.stage === 'done' ? 'good' : 'neutral'}>
                    {STAGE_LABEL[task.stage] || task.status_name}
                  </Badge>
                  {can('okr.link.task') && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      aria-label={`Unlink ${task.ref}`}
                      onClick={async () => {
                        try {
                          await api.unlinkTask(keyResult.id, task.id);
                          loadDetail();
                          onChanged?.();
                        } catch (err) {
                          toast.error(err);
                        }
                      }}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <hr className="divider" />

          <span className="small" style={{ fontWeight: 650 }}>Check-in history</span>
          {!detail ? (
            <Spinner label="Loading" />
          ) : detail.check_ins.length === 0 ? (
            <div className="small muted">Nothing recorded yet.</div>
          ) : (
            <div className="stack-sm">
              {detail.check_ins.map((entry) => (
                <div key={entry.id} className="check-in">
                  <div className="row-between wrap">
                    <div className="row">
                      <Avatar name={entry.user_name || 'Someone'} color={entry.avatar_color} size={20} />
                      <span className="small" style={{ fontWeight: 600 }}>{entry.user_name || 'Someone'}</span>
                      {/* a task roll-up has no value of its own to move, so the
                          note is the whole check-in */}
                      {keyResult.measurement_type === 'TASK_ROLLUP' ? (
                        <span className="small muted">
                          {entry.resulting_progress === null ? '' : `${Math.round(entry.resulting_progress)}% of the work done`}
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
                  {entry.next_action && (
                    <div className="small muted">Next: {entry.next_action}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {checkingIn && (
        <CheckInDialog
          keyResult={keyResult}
          onClose={() => setCheckingIn(false)}
          onSaved={() => {
            onChanged?.();
            if (expanded) loadDetail();
          }}
        />
      )}
      {linking && (
        <LinkTaskDialog
          keyResult={keyResult}
          onClose={() => setLinking(false)}
          onSaved={() => {
            onChanged?.();
            if (expanded) loadDetail();
          }}
        />
      )}
      {editing && (
        <KeyResultEditDialog
          keyResult={keyResult}
          onClose={() => setEditing(false)}
          onSaved={() => {
            onChanged?.();
            if (expanded) loadDetail();
          }}
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
          onSaved={() => {
            onChanged?.();
            if (expanded) loadDetail();
          }}
        />
      )}
    </div>
  );
}
