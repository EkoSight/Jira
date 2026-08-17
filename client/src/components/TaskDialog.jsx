import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, Field, Icon, Modal, Spinner } from './ui.jsx';
import {
  Attachments,
  Collaborators,
  PendingAttachments,
  PendingCollaborators,
  Subtasks,
  flushPendingAttachments,
} from './TaskExtras.jsx';
import CompleteTaskDialog from './CompleteTaskDialog.jsx';
import {
  PRIORITIES,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  describeActivity,
  dueLabel,
  formatDate,
  fromDateTimeLocal,
  relativeTime,
  toDateTimeLocal,
} from '../lib/format.js';
import { measurementSummary } from '../lib/okr.js';

/**
 * Loads every objective and its key results once, so the picker can offer the
 * goal first and then only the key results defined under it.
 */
function useGoalCatalogue(active) {
  const toast = useToast();
  const [catalogue, setCatalogue] = useState(null);

  useEffect(() => {
    if (!active || catalogue) return;
    let live = true;
    Promise.all([api.objectives(), api.keyResults()])
      .then(([objectiveData, keyResultData]) => {
        if (!live) return;
        const keyResults = keyResultData.key_results || [];
        const byObjective = new Map();
        for (const keyResult of keyResults) {
          if (!byObjective.has(keyResult.objective_id)) byObjective.set(keyResult.objective_id, []);
          byObjective.get(keyResult.objective_id).push(keyResult);
        }
        setCatalogue({ objectives: objectiveData.objectives || [], byObjective });
      })
      .catch((err) => toast.error(err));
    return () => {
      live = false;
    };
  }, [active, catalogue]);

  return catalogue;
}

/**
 * Pick a goal, then a key result under it. Two steps rather than one long list,
 * because people know which goal they are serving before they know which number.
 */
function GoalPicker({ catalogue, alreadyLinked, onPick, onCancel }) {
  const [objectiveId, setObjectiveId] = useState('');

  const keyResults = catalogue?.byObjective.get(Number(objectiveId)) || [];
  const available = keyResults.filter((keyResult) => !alreadyLinked.includes(keyResult.id));

  if (!catalogue) return <div className="small muted">Loading goals…</div>;

  if (catalogue.objectives.length === 0) {
    return (
      <div className="small muted">
        No goals have been set yet. Once someone creates one under Goals, you can point work at it.
      </div>
    );
  }

  return (
    <div className="stack-sm">
      <Field label="Which goal does this serve?">
        <select className="select" value={objectiveId} onChange={(e) => setObjectiveId(e.target.value)}>
          <option value="">Choose a goal…</option>
          {catalogue.objectives.map((objective) => (
            <option key={objective.id} value={objective.id}>
              {objective.scope_type === 'COMPANY' ? 'Company' : objective.department_name} · {objective.title}
            </option>
          ))}
        </select>
      </Field>

      {objectiveId && (
        <Field
          label="And which key result does it move?"
          hint={
            keyResults.length === 0
              ? 'That goal has no key results yet, so there is no number to attach this to.'
              : undefined
          }
        >
          <select
            className="select"
            value=""
            disabled={available.length === 0}
            onChange={(e) => {
              const chosen = available.find((keyResult) => String(keyResult.id) === e.target.value);
              if (chosen) {
                onPick(chosen);
                setObjectiveId('');
              }
            }}
          >
            <option value="">
              {keyResults.length === 0
                ? 'Nothing to choose'
                : available.length === 0
                  ? 'All of them are linked already'
                  : 'Choose a key result…'}
            </option>
            {available.map((keyResult) => (
              <option key={keyResult.id} value={keyResult.id}>
                {keyResult.title} — {measurementSummary(keyResult)}
              </option>
            ))}
          </select>
        </Field>
      )}

      {onCancel && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** One linked key result, shown under the goal it belongs to. */
function AlignmentRow({ keyResult, primary, onRemove }) {
  return (
    <div className="alignment">
      <div className="small muted truncate">{keyResult.objective_title}</div>
      <div className="row-between wrap" style={{ gap: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{keyResult.title}</span>
        <div className="row">
          {primary && <Badge tone="brand">primary</Badge>}
          {onRemove && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`Unlink ${keyResult.title}`}
              onClick={onRemove}
            >
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Staged alignment for a card that does not exist yet. The links are sent the
 * moment the task is created — see flushPendingAlignment below.
 */
function PendingAlignment({ selected, onChange }) {
  const [picking, setPicking] = useState(true);
  const catalogue = useGoalCatalogue(true);

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <h3>Goal this supports</h3>
        {!picking && (
          <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
            <Icon name="target" size={13} /> {selected.length ? 'Link another' : 'Link a goal'}
          </button>
        )}
      </div>

      {selected.map((keyResult, index) => (
        <AlignmentRow
          key={keyResult.id}
          keyResult={keyResult}
          primary={index === 0 && selected.length > 1}
          onRemove={() => onChange(selected.filter((item) => item.id !== keyResult.id))}
        />
      ))}

      {picking && (
        <GoalPicker
          catalogue={catalogue}
          alreadyLinked={selected.map((keyResult) => keyResult.id)}
          onPick={(keyResult) => {
            onChange([...selected, keyResult]);
            setPicking(false);
          }}
          onCancel={selected.length > 0 ? () => setPicking(false) : undefined}
        />
      )}

      {selected.length === 0 && catalogue?.objectives.length > 0 && (
        <div className="small muted">Optional. Most cards are day-to-day work and support no goal directly.</div>
      )}
    </div>
  );
}

/** Sends the staged links once the card has an id. Returns how many failed. */
async function flushPendingAlignment(taskId, keyResults) {
  let failed = 0;
  for (const [index, keyResult] of keyResults.entries()) {
    try {
      await api.linkTask(keyResult.id, { task_id: taskId, is_primary: index === 0 });
    } catch {
      failed += 1;
    }
  }
  return failed;
}

/**
 * Alignment on a card that already exists.
 *
 * A card that supports no goal shows one line offering to link one, so nothing
 * about an ordinary task changes.
 */
function Alignment({ taskId, keyResults, canLink, onChanged }) {
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const catalogue = useGoalCatalogue(picking);

  const link = async (keyResult) => {
    try {
      await api.linkTask(keyResult.id, { task_id: taskId, is_primary: keyResults.length === 0 });
      setPicking(false);
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  if (!keyResults.length && !canLink) return null;

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <h3>Goal this supports</h3>
        {canLink && !picking && (
          <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
            <Icon name="target" size={13} /> Link a goal
          </button>
        )}
      </div>

      {keyResults.length === 0 && !picking && (
        <div className="small muted">Not linked to a goal. That is fine — most cards are not.</div>
      )}

      {keyResults.map((keyResult) => (
        <AlignmentRow
          key={keyResult.id}
          keyResult={keyResult}
          primary={keyResult.is_primary}
          onRemove={
            canLink
              ? async () => {
                  try {
                    await api.unlinkTask(keyResult.id, taskId);
                    onChanged();
                  } catch (err) {
                    toast.error(err);
                  }
                }
              : undefined
          }
        />
      ))}

      {picking && (
        <GoalPicker
          catalogue={catalogue}
          alreadyLinked={keyResults.map((keyResult) => keyResult.id)}
          onPick={link}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  );
}

const blankTask = (defaults = {}) => ({
  title: '',
  description: '',
  department_id: defaults.department_id || '',
  status_id: defaults.status_id || '',
  priority: 'medium',
  task_type: 'task',
  assignee_id: defaults.assignee_id || '',
  follower_id: '',
  due_date: '',
  estimate_hours: '',
  progress: 0,
  tags: [],
  recurrence: 'none',
});

const RECURRENCE_OPTIONS = [
  ['none', 'Does not repeat'],
  ['daily', 'Every day'],
  ['weekdays', 'Every weekday (Mon–Sat)'],
  ['weekly', 'Every week'],
  ['monthly', 'Every month'],
];

/**
 * One dialog serves both "new card" and "open card" — the same fields, so people
 * only learn the layout once.
 */
export default function TaskDialog({ taskId, defaults, onClose, onSaved, onOpenTask }) {
  // once a new card is created the dialog stays open on it, so attachments,
  // sub tasks and the checklist are reachable without hunting for it again
  const [activeId, setActiveId] = useState(taskId ?? null);
  const isNew = !activeId;

  const { user, can } = useAuth();
  const { departments, statuses, users, settings } = useRefData();
  const toast = useToast();

  const [loading, setLoading] = useState(Boolean(taskId));
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(() => blankTask(defaults));
  const [comment, setComment] = useState('');
  const [checklistDraft, setChecklistDraft] = useState('');
  const [tab, setTab] = useState('details');
  // staged while the task does not exist yet
  const [pending, setPending] = useState([]);
  const [pendingTags, setPendingTags] = useState([]);
  const [pendingGoals, setPendingGoals] = useState([]);
  // set when a done-transition needs the completion prompt
  const [completing, setCompleting] = useState(null);

  const taskTypes = settings?.taskTypes || ['task'];
  // one condition for both the staged and the live alignment sections
  const goalsAvailable = settings?.okr?.enabled !== false && can('okr.view') && can('okr.link.task');

  const reload = () => {
    if (!activeId) return;
    api
      .task(activeId)
      .then(setDetail)
      .catch((err) => toast.error(err));
  };

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setLoading(true);
    api
      .task(activeId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setForm({
          title: data.task.title,
          description: data.task.description || '',
          department_id: data.task.department_id,
          status_id: data.task.status_id,
          priority: data.task.priority,
          task_type: data.task.task_type,
          assignee_id: data.task.assignee_id || '',
          follower_id: data.task.follower_id || '',
          due_date: toDateTimeLocal(data.task.due_date),
          estimate_hours: data.task.estimate_hours ?? '',
          progress: data.task.progress,
          tags: data.task.tags || [],
          recurrence: data.task.recurrence || 'none',
        });
      })
      .catch((err) => toast.error(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const set = (key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const canEdit = isNew ? can('task.create') : detail?.can_edit;
  // handing the task to someone else stays open even on a task you are not part of
  const canReassign = isNew ? can('task.create') : Boolean(detail?.can_edit || detail?.can_reassign);
  const handOverOnly = !isNew && !canEdit && canReassign;
  const task = detail?.task;

  const payload = () => {
    const data = {
      title: form.title.trim(),
      description: form.description || null,
      department_id: Number(form.department_id),
      priority: form.priority,
      task_type: form.task_type,
      assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
      follower_id: form.follower_id ? Number(form.follower_id) : null,
      due_date: fromDateTimeLocal(form.due_date),
      estimate_hours: form.estimate_hours === '' ? null : Number(form.estimate_hours),
      progress: Number(form.progress) || 0,
      tags: form.tags,
      recurrence: form.recurrence || 'none',
    };
    if (form.status_id) data.status_id = Number(form.status_id);
    return data;
  };

  const save = async () => {
    if (!form.title.trim() || form.title.trim().length < 3) return toast.error('Give the task a title first');
    if (!form.department_id) return toast.error('Pick a department');
    if (isNew && !form.assignee_id) return toast.error('Select a task owner before creating the task');

    setSaving(true);
    try {
      if (isNew) {
        const body = payload();
        if (pendingTags.length) body.collaborator_ids = pendingTags;

        const { task: created } = await api.createTask(body);

        // the card exists now, so anything staged can finally be sent
        const failed = pending.length ? await flushPendingAttachments(created.id, pending) : 0;
        const goalsFailed = pendingGoals.length
          ? await flushPendingAlignment(created.id, pendingGoals)
          : 0;

        if (failed > 0 || goalsFailed > 0) {
          const problems = [
            failed > 0 && `${failed} attachment(s)`,
            goalsFailed > 0 && `${goalsFailed} goal link(s)`,
          ].filter(Boolean);
          toast.error(`${created.ref} created, but ${problems.join(' and ')} could not be added`);
        } else {
          const extras = [
            pending.length && `${pending.length} attachment(s)`,
            pendingGoals.length && `${pendingGoals.length} goal link(s)`,
          ].filter(Boolean);
          toast.success(extras.length ? `${created.ref} created with ${extras.join(' and ')}` : `${created.ref} created`);
        }

        setPending([]);
        setPendingTags([]);
        setPendingGoals([]);
        onSaved?.(created);
        // keep the dialog open on the new card so sub tasks and files are to hand
        setActiveId(created.id);
      } else {
        // marking done through the status dropdown must still capture an outcome:
        // persist any other edits now (keeping the current status), then hand off
        // to the completion prompt to do the actual move into the done column
        const target = statuses.find((s) => String(s.id) === String(form.status_id));
        const goingDone = target?.stage === 'done' && detail?.task?.stage !== 'done';
        if (goingDone) {
          const body = payload();
          body.status_id = detail.task.status_id;
          const { task: updated } = await api.updateTask(activeId, body);
          setDetail((current) => ({ ...current, task: updated }));
          setCompleting({ statusId: target.id });
        } else {
          // someone who may only hand the task over sends just those two fields —
          // the server rejects anything wider from them
          const body = handOverOnly
            ? {
                assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
                follower_id: form.follower_id ? Number(form.follower_id) : null,
              }
            : payload();

          const { task: updated } = await api.updateTask(activeId, body);
          toast.success(handOverOnly ? 'Task handed over' : 'Saved');
          setDetail((current) => ({ ...current, task: updated }));
          onSaved?.(updated);
        }
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const postComment = async () => {
    if (!comment.trim()) return;
    try {
      const { comment: created } = await api.addComment(activeId, comment.trim());
      setDetail((current) => ({ ...current, comments: [...current.comments, created] }));
      setComment('');
    } catch (err) {
      toast.error(err);
    }
  };

  const addChecklistItem = async () => {
    if (!checklistDraft.trim()) return;
    try {
      const { item } = await api.addChecklistItem(activeId, checklistDraft.trim());
      setDetail((current) => ({ ...current, checklist: [...current.checklist, item] }));
      setChecklistDraft('');
    } catch (err) {
      toast.error(err);
    }
  };

  const toggleChecklistItem = async (item) => {
    try {
      const { item: updated } = await api.updateChecklistItem(activeId, item.id, { is_done: !item.is_done });
      setDetail((current) => ({
        ...current,
        checklist: current.checklist.map((c) => (c.id === updated.id ? updated : c)),
      }));
    } catch (err) {
      toast.error(err);
    }
  };

  const archive = async () => {
    try {
      await api.archiveTask(activeId);
      toast.success('Task archived');
      onSaved?.(null);
      onClose();
    } catch (err) {
      toast.error(err);
    }
  };

  const deleteTask = async () => {
    try {
      await api.deleteTask(activeId);
      toast.success('Task deleted');
      onSaved?.(null);
      onClose();
    } catch (err) {
      toast.error(err);
    }
  };

  // whoever created a task can delete it outright — the fix for accidental
  // duplicates. Managers keep the softer "Archive".
  const isCreator = task && task.created_by === user.id;
  const subtaskCount = detail?.subtasks?.length || 0;

  const title = isNew ? (
    'New task'
  ) : task ? (
    <div className="row" style={{ gap: 8 }}>
      <span className="task-ref">{task.ref}</span>
      <Badge dot={task.status_color}>{task.status_name}</Badge>
      {task.is_overdue && <Badge tone="critical"><Icon name="alert" size={11} /> Overdue</Badge>}
    </div>
  ) : (
    'Task'
  );

  const footer = (
    <>
      {!isNew && isCreator && (
        <ConfirmButton
          label="Delete"
          confirmLabel={subtaskCount ? `Delete this and ${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}?` : 'Tap again to delete'}
          onConfirm={deleteTask}
        />
      )}
      {!isNew && !isCreator && can('task.delete') && (
        <ConfirmButton label="Archive" confirmLabel="Tap again to archive" onConfirm={archive} />
      )}
      <span className="grow" />
      <button type="button" className="btn" onClick={onClose}>
        Close
      </button>
      {(canEdit || handOverOnly) && (
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : isNew ? 'Create task' : handOverOnly ? 'Hand over' : 'Save changes'}
        </button>
      )}
    </>
  );

  return (
    <>
    <Modal title={title} onClose={onClose} footer={footer} size="lg">
      {/* a freshly created card has an id but no loaded detail yet, so wait for it
          rather than rendering the sections that read from it */}
      {loading || (!isNew && !detail) ? (
        <Spinner />
      ) : (
        <div className="stack">
          {!isNew && (
            <div className="tabs">
              {['details', `comments${detail?.comments?.length ? ` (${detail.comments.length})` : ''}`, 'history'].map(
                (label) => {
                  const key = label.split(' ')[0];
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`tab ${tab === key ? 'active' : ''}`}
                      onClick={() => setTab(key)}
                    >
                      {label}
                    </button>
                  );
                },
              )}
            </div>
          )}

          {tab === 'details' && (
            <div className="stack">
              <Field label="Title">
                <input
                  className="input"
                  value={form.title}
                  onChange={set('title')}
                  disabled={!canEdit}
                  placeholder="What needs doing?"
                  autoFocus={isNew}
                />
              </Field>

              <Field label="Description" hint="Context, links, acceptance criteria — anything the assignee needs.">
                <textarea
                  className="textarea"
                  value={form.description}
                  onChange={set('description')}
                  disabled={!canEdit}
                  rows={4}
                />
              </Field>

              <div className="grid-2">
                <Field label="Department">
                  <select className="select" value={form.department_id} onChange={set('department_id')} disabled={!canEdit}>
                    <option value="">Select…</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Status / stage">
                  <select className="select" value={form.status_id} onChange={set('status_id')} disabled={!canEdit}>
                    {isNew && <option value="">Default (first column)</option>}
                    {statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label="Task owner *"
                  hint={
                    handOverOnly
                      ? 'You can hand this task to someone else'
                      : can('task.assign')
                        ? 'Required — accountable for the deadline'
                        : 'You can only assign work to yourself'
                  }
                >
                  <select
                    className="select"
                    value={form.assignee_id}
                    onChange={set('assignee_id')}
                    disabled={!canReassign}
                  >
                    <option value="">Select an owner…</option>
                    {users
                      .filter((u) => can('task.assign') || u.id === user.id)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.full_name}
                          {u.department_name ? ` · ${u.department_name}` : ''}
                        </option>
                      ))}
                  </select>
                </Field>

                <Field
                  label="Second person (follower)"
                  hint="Works on it too, but the owner carries the deadline"
                >
                  <select
                    className="select"
                    value={form.follower_id}
                    onChange={set('follower_id')}
                    disabled={!canReassign}
                  >
                    <option value="">Nobody</option>
                    {users
                      .filter((u) => String(u.id) !== String(form.assignee_id))
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.full_name}
                          {u.department_name ? ` · ${u.department_name}` : ''}
                        </option>
                      ))}
                  </select>
                </Field>

                <Field label="Priority">
                  <select className="select" value={form.priority} onChange={set('priority')} disabled={!canEdit}>
                    {PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label="Deadline"
                  hint={
                    !isNew && task?.due_date_changes > 0
                      ? `Moved ${task.due_date_changes} time${task.due_date_changes === 1 ? '' : 's'}`
                      : 'Missing this date is what triggers a black mark'
                  }
                >
                  <input
                    type="datetime-local"
                    className="input"
                    value={form.due_date}
                    onChange={set('due_date')}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Type">
                  <select className="select" value={form.task_type} onChange={set('task_type')} disabled={!canEdit}>
                    {taskTypes.map((type) => (
                      <option key={type} value={type}>
                        {type.replace(/-/g, ' ')}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label="Repeats"
                  hint={
                    form.recurrence !== 'none'
                      ? 'Completing this creates the next one automatically'
                      : 'Turn a daily/weekly routine into a repeating task'
                  }
                >
                  <select className="select" value={form.recurrence} onChange={set('recurrence')} disabled={!canEdit}>
                    {RECURRENCE_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Estimate (hours)" hint="Feeds the team bandwidth view">
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    className="input"
                    value={form.estimate_hours}
                    onChange={set('estimate_hours')}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label={`Progress — ${form.progress}%`}>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={form.progress}
                    onChange={set('progress')}
                    disabled={!canEdit}
                    style={{ width: '100%', accentColor: 'var(--brand)' }}
                  />
                </Field>
              </div>

              <Field label="Tags" hint="Comma separated">
                <input
                  className="input"
                  value={form.tags.join(', ')}
                  onChange={(e) =>
                    setForm((c) => ({
                      ...c,
                      tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean),
                    }))
                  }
                  disabled={!canEdit}
                  placeholder="vendor, q3, escalation"
                />
              </Field>

              {isNew && goalsAvailable && (
                <PendingAlignment selected={pendingGoals} onChange={setPendingGoals} />
              )}
              {isNew && <PendingAttachments pending={pending} onChange={setPending} />}
              {isNew && <PendingCollaborators selected={pendingTags} onChange={setPendingTags} />}
              {isNew && (
                <div className="small muted">
                  Sub tasks, comments and the checklist open up as soon as the card is created.
                </div>
              )}

              {!isNew && (
                <Subtasks
                  task={detail.task}
                  subtasks={detail.subtasks}
                  canEdit={canEdit}
                  onOpen={(id) => onOpenTask?.(id)}
                  onChanged={reload}
                />
              )}

              {!isNew && settings?.okr?.enabled !== false && can('okr.view') && (
                <Alignment
                  taskId={activeId}
                  keyResults={detail.key_results || []}
                  canLink={can('okr.link.task')}
                  onChanged={reload}
                />
              )}

              {!isNew && (
                <Attachments
                  taskId={activeId}
                  attachments={detail.attachments}
                  canEdit={canEdit}
                  onChange={(attachments) => setDetail((c) => ({ ...c, attachments }))}
                />
              )}

              {!isNew && (
                <Collaborators
                  taskId={activeId}
                  collaborators={detail.collaborators}
                  canEdit={canEdit}
                  onChange={(collaborators) => setDetail((c) => ({ ...c, collaborators }))}
                />
              )}

              {!isNew && (
                <div className="card card-pad stack-sm">
                  <div className="row-between">
                    <h3>Checklist</h3>
                    <span className="small muted tnum">
                      {detail.checklist.filter((c) => c.is_done).length}/{detail.checklist.length}
                    </span>
                  </div>
                  {detail.checklist.map((item) => (
                    <label key={item.id} className={`checklist-item ${item.is_done ? 'done' : ''}`}>
                      <input type="checkbox" checked={item.is_done} onChange={() => toggleChecklistItem(item)} />
                      <span className="grow">{item.title}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={async () => {
                          await api.deleteChecklistItem(activeId, item.id);
                          setDetail((c) => ({ ...c, checklist: c.checklist.filter((i) => i.id !== item.id) }));
                        }}
                        aria-label="Remove item"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </label>
                  ))}
                  <div className="row">
                    <input
                      className="input"
                      placeholder="Add a step…"
                      value={checklistDraft}
                      onChange={(e) => setChecklistDraft(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addChecklistItem()}
                    />
                    <button type="button" className="btn" onClick={addChecklistItem}>
                      Add
                    </button>
                  </div>
                </div>
              )}

              {!isNew && task?.completion_note && (
                <div>
                  <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
                    Outcome recorded on completion
                  </div>
                  <div className="outcome-box">{task.completion_note}</div>
                </div>
              )}

              {!isNew && task && (
                <div className="row wrap small muted" style={{ gap: 14 }}>
                  <span>Created by {task.created_by_name || 'someone'} · {formatDate(task.created_at)}</span>
                  {task.completed_at && <span>Completed {formatDate(task.completed_at, { withTime: true })}</span>}
                  {task.due_date && <span>Deadline status: {dueLabel(task.due_date, { done: task.stage === 'done' }).text}</span>}
                </div>
              )}
            </div>
          )}

          {tab === 'comments' && (
            <div className="stack">
              <div>
                {detail.comments.length === 0 && <div className="empty small">No comments yet</div>}
                {detail.comments.map((c) => (
                  <div key={c.id} className="comment">
                    <Avatar name={c.author_name} color={c.avatar_color} size={28} />
                    <div className="grow">
                      <div className="row" style={{ gap: 8 }}>
                        <strong className="small">{c.author_name || 'Removed user'}</strong>
                        <span className="small muted">{relativeTime(c.created_at)}</span>
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <textarea
                  className="textarea"
                  rows={2}
                  placeholder="Add a comment…"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  style={{ minHeight: 44 }}
                />
                <button type="button" className="btn btn-primary" onClick={postComment} disabled={!comment.trim()}>
                  Post
                </button>
              </div>
            </div>
          )}

          {tab === 'history' && (
            <div>
              {detail.activity.length === 0 && <div className="empty small">Nothing recorded yet</div>}
              {detail.activity.map((item) => (
                <div key={item.id} className="activity-line">
                  <Avatar name={item.actor_name || '?'} color={item.avatar_color || '#94a3b8'} size={22} />
                  <div className="grow">
                    <strong>{item.actor_name || 'System'}</strong> {describeActivity(item)}
                    {item.field && item.to_value && (
                      <span className="muted">
                        {' '}
                        → {String(item.to_value).slice(0, 60)}
                      </span>
                    )}
                  </div>
                  <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                    {relativeTime(item.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>

    {completing && detail?.task && (
      <CompleteTaskDialog
        task={detail.task}
        targetStatusId={completing.statusId}
        onClose={() => setCompleting(null)}
        onCompleted={(result) => {
          setCompleting(null);
          reload();
          onSaved?.(result.task);
        }}
      />
    )}
    </>
  );
}

export { PRIORITY_LABEL, PRIORITY_TONE };
