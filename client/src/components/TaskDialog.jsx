import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, Field, Icon, Modal, Spinner } from './ui.jsx';
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

const blankTask = (defaults = {}) => ({
  title: '',
  description: '',
  department_id: defaults.department_id || '',
  status_id: defaults.status_id || '',
  priority: 'medium',
  task_type: 'task',
  assignee_id: defaults.assignee_id || '',
  due_date: '',
  estimate_hours: '',
  progress: 0,
  tags: [],
});

/**
 * One dialog serves both "new card" and "open card" — the same fields, so people
 * only learn the layout once.
 */
export default function TaskDialog({ taskId, defaults, onClose, onSaved }) {
  const isNew = !taskId;
  const { user, can } = useAuth();
  const { departments, statuses, users, settings } = useRefData();
  const toast = useToast();

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(() => blankTask(defaults));
  const [comment, setComment] = useState('');
  const [checklistDraft, setChecklistDraft] = useState('');
  const [tab, setTab] = useState('details');

  const taskTypes = settings?.taskTypes || ['task'];

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    setLoading(true);
    api
      .task(taskId)
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
          due_date: toDateTimeLocal(data.task.due_date),
          estimate_hours: data.task.estimate_hours ?? '',
          progress: data.task.progress,
          tags: data.task.tags || [],
        });
      })
      .catch((err) => toast.error(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const set = (key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const canEdit = isNew ? can('task.create') : detail?.can_edit;
  const task = detail?.task;

  const payload = () => {
    const data = {
      title: form.title.trim(),
      description: form.description || null,
      department_id: Number(form.department_id),
      priority: form.priority,
      task_type: form.task_type,
      assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
      due_date: fromDateTimeLocal(form.due_date),
      estimate_hours: form.estimate_hours === '' ? null : Number(form.estimate_hours),
      progress: Number(form.progress) || 0,
      tags: form.tags,
    };
    if (form.status_id) data.status_id = Number(form.status_id);
    return data;
  };

  const save = async () => {
    if (!form.title.trim() || form.title.trim().length < 3) return toast.error('Give the task a title first');
    if (!form.department_id) return toast.error('Pick a department');

    setSaving(true);
    try {
      if (isNew) {
        const { task: created } = await api.createTask(payload());
        toast.success(`${created.ref} created`);
        onSaved?.(created);
        onClose();
      } else {
        const { task: updated } = await api.updateTask(taskId, payload());
        toast.success('Saved');
        setDetail((current) => ({ ...current, task: updated }));
        onSaved?.(updated);
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
      const { comment: created } = await api.addComment(taskId, comment.trim());
      setDetail((current) => ({ ...current, comments: [...current.comments, created] }));
      setComment('');
    } catch (err) {
      toast.error(err);
    }
  };

  const addChecklistItem = async () => {
    if (!checklistDraft.trim()) return;
    try {
      const { item } = await api.addChecklistItem(taskId, checklistDraft.trim());
      setDetail((current) => ({ ...current, checklist: [...current.checklist, item] }));
      setChecklistDraft('');
    } catch (err) {
      toast.error(err);
    }
  };

  const toggleChecklistItem = async (item) => {
    try {
      const { item: updated } = await api.updateChecklistItem(taskId, item.id, { is_done: !item.is_done });
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
      await api.archiveTask(taskId);
      toast.success('Task archived');
      onSaved?.(null);
      onClose();
    } catch (err) {
      toast.error(err);
    }
  };

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
      {!isNew && can('task.delete') && (
        <ConfirmButton label="Archive" confirmLabel="Tap again to archive" onConfirm={archive} />
      )}
      <span className="grow" />
      <button type="button" className="btn" onClick={onClose}>
        Close
      </button>
      {canEdit && (
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : isNew ? 'Create task' : 'Save changes'}
        </button>
      )}
    </>
  );

  return (
    <Modal title={title} onClose={onClose} footer={footer} size="lg">
      {loading ? (
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

                <Field label="Assignee" hint={can('task.assign') ? undefined : 'You can only assign work to yourself'}>
                  <select className="select" value={form.assignee_id} onChange={set('assignee_id')} disabled={!canEdit}>
                    <option value="">Unassigned</option>
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
                          await api.deleteChecklistItem(taskId, item.id);
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
  );
}

export { PRIORITY_LABEL, PRIORITY_TONE };
