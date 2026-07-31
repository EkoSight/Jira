import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Badge, ConfirmButton, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { PRIORITIES } from '../lib/format.js';

const STAGES = [
  ['backlog', 'Backlog — captured, not started'],
  ['todo', 'To do — ready to pick up'],
  ['in_progress', 'In progress — being worked on'],
  ['blocked', 'Blocked — waiting on someone'],
  ['review', 'In review — being checked'],
  ['done', 'Done — counts as completed'],
  ['cancelled', 'Cancelled — dropped, no penalty'],
];

const TRIGGERS = [
  ['deadline_missed', 'A deadline passes and the task is not done'],
  ['completed_late', 'The task is finished, but after the deadline'],
  ['overdue_escalation', 'The task stays overdue — repeats every N days'],
  ['task_reopened', 'A task marked done has to be reopened'],
  ['manual', 'Only raised by hand'],
];

const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948', '#64748b'];

function ColorPicker({ value, onChange }) {
  return (
    <div className="row wrap" style={{ gap: 5 }}>
      {PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: color,
            border: value === color ? '3px solid var(--ink)' : '1px solid var(--border)',
            cursor: 'pointer',
          }}
          aria-label={color}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------ departments

function DepartmentsTab({ onChanged }) {
  const { can } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();
  const [editing, setEditing] = useState(undefined);

  const save = async (form) => {
    try {
      if (form.id) await api.updateDepartment(form.id, form);
      else await api.createDepartment(form);
      toast.success('Saved');
      setEditing(undefined);
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="stack">
      <div className="row-between">
        <p className="small muted" style={{ margin: 0 }}>
          Every card belongs to a department. The department key becomes the card reference, e.g. MKT-14.
        </p>
        {can('department.manage') && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> Department
          </button>
        )}
      </div>

      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Department</th>
              <th>Key</th>
              <th className="num">Cards</th>
              <th className="num">People</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {departments.map((department) => (
              <tr key={department.id}>
                <td>
                  <div className="row">
                    <span className="badge-dot" style={{ background: department.color, width: 10, height: 10 }} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{department.name}</div>
                      {department.description && <div className="small muted">{department.description}</div>}
                    </div>
                  </div>
                </td>
                <td><span className="task-ref">{department.key}</span></td>
                <td className="num tnum">{department.task_count}</td>
                <td className="num tnum">{department.member_count}</td>
                <td className="num">
                  {can('department.manage') && (
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(department)}>Edit</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== undefined && (
        <RecordDialog
          title={editing ? `Edit ${editing.name}` : 'New department'}
          initial={
            editing || { name: '', key: '', description: '', color: PALETTE[0], is_active: true }
          }
          onClose={() => setEditing(undefined)}
          onSave={save}
        >
          {(form, set) => (
            <>
              <Field label="Name">
                <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
              </Field>
              <Field label="Key" hint="2–5 letters, used in card references. Leave blank to generate one.">
                <input
                  className="input"
                  value={form.key || ''}
                  onChange={(e) => set('key', e.target.value.toUpperCase())}
                  maxLength={10}
                />
              </Field>
              <Field label="Description">
                <input className="input" value={form.description || ''} onChange={(e) => set('description', e.target.value)} />
              </Field>
              <Field label="Colour">
                <ColorPicker value={form.color} onChange={(c) => set('color', c)} />
              </Field>
              {editing && (
                <label className="row small dim" style={{ gap: 6 }}>
                  <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
                  Active
                </label>
              )}
            </>
          )}
        </RecordDialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------ statuses

function StatusesTab({ onChanged }) {
  const { can } = useAuth();
  const { statuses } = useRefData();
  const toast = useToast();
  const [editing, setEditing] = useState(undefined);

  const save = async (form) => {
    try {
      const payload = {
        name: form.name,
        stage: form.stage,
        color: form.color,
        wip_limit: form.wip_limit ? Number(form.wip_limit) : null,
        is_default: Boolean(form.is_default),
      };
      if (form.id) await api.updateStatus(form.id, { ...payload, is_active: form.is_active });
      else await api.createStatus(payload);
      toast.success('Saved');
      setEditing(undefined);
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const remove = async (status) => {
    const fallback = statuses.find((s) => s.id !== status.id);
    try {
      await api.deleteStatus(status.id, fallback?.id);
      toast.success('Status removed');
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const reorder = async (status, direction) => {
    const ordered = [...statuses].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((s) => s.id === status.id);
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const swapped = [...ordered];
    [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
    try {
      await api.reorderStatuses(swapped.map((s) => s.id));
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="stack">
      <div className="row-between">
        <p className="small muted" style={{ margin: 0 }}>
          Statuses are your board columns. Each maps to a fixed stage so the dashboard always knows what counts as
          open, blocked or done.
        </p>
        {can('workflow.manage') && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> Status
          </button>
        )}
      </div>

      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Status</th>
              <th>Stage</th>
              <th className="num">Cards</th>
              <th className="num">WIP limit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...statuses].sort((a, b) => a.position - b.position).map((status) => (
              <tr key={status.id}>
                <td>
                  <div className="row">
                    <span className="badge-dot" style={{ background: status.color, width: 10, height: 10 }} />
                    <span style={{ fontWeight: 600 }}>{status.name}</span>
                    {status.is_default && <Badge tone="brand">Default</Badge>}
                  </div>
                </td>
                <td className="small dim">{STAGES.find(([key]) => key === status.stage)?.[1]}</td>
                <td className="num tnum">{status.task_count}</td>
                <td className="num tnum">{status.wip_limit || '—'}</td>
                <td>
                  {can('workflow.manage') && (
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => reorder(status, -1)} aria-label="Move left">←</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => reorder(status, 1)} aria-label="Move right">→</button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(status)}>Edit</button>
                      <ConfirmButton label="Delete" confirmLabel="Tap again" onConfirm={() => remove(status)} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== undefined && (
        <RecordDialog
          title={editing ? `Edit ${editing.name}` : 'New status'}
          initial={editing || { name: '', stage: 'todo', color: PALETTE[0], wip_limit: '', is_default: false, is_active: true }}
          onClose={() => setEditing(undefined)}
          onSave={save}
        >
          {(form, set) => (
            <>
              <Field label="Name">
                <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
              </Field>
              <Field label="Stage" hint="Decides how the dashboard counts cards in this column">
                <select className="select" value={form.stage} onChange={(e) => set('stage', e.target.value)}>
                  {STAGES.map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Colour">
                <ColorPicker value={form.color} onChange={(c) => set('color', c)} />
              </Field>
              <Field label="WIP limit" hint="Optional — blocks moving more than this many cards into the column">
                <input
                  type="number"
                  min="1"
                  className="input"
                  value={form.wip_limit || ''}
                  onChange={(e) => set('wip_limit', e.target.value)}
                />
              </Field>
              <label className="row small dim" style={{ gap: 6 }}>
                <input type="checkbox" checked={form.is_default} onChange={(e) => set('is_default', e.target.checked)} />
                New cards land here by default
              </label>
            </>
          )}
        </RecordDialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------ black mark rules

function RulesTab() {
  const { can } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(undefined);

  const load = () => {
    setLoading(true);
    api
      .rules()
      .then((data) => setRules(data.rules))
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const save = async (form) => {
    try {
      const payload = {
        name: form.name,
        description: form.description || null,
        trigger_type: form.trigger_type,
        points: Number(form.points),
        grace_hours: Number(form.grace_hours) || 0,
        priorities: form.priorities || [],
        department_ids: (form.department_ids || []).map(Number),
        repeat_every_days: form.repeat_every_days ? Number(form.repeat_every_days) : null,
        max_points_per_task: form.max_points_per_task ? Number(form.max_points_per_task) : null,
        severity: form.severity || 'normal',
        is_active: form.is_active !== false,
      };
      if (form.id) await api.updateRule(form.id, payload);
      else await api.createRule(payload);
      toast.success('Rule saved');
      setEditing(undefined);
      load();
    } catch (err) {
      toast.error(err);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="stack">
      <div className="row-between">
        <p className="small muted" style={{ margin: 0 }}>
          Rules decide when a black mark is recorded and how heavily it counts. They run automatically in the
          background and again whenever a card is completed.
        </p>
        {can('blackmark.rules') && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(null)}>
            <Icon name="plus" size={14} /> Rule
          </button>
        )}
      </div>

      {rules.length === 0 && <EmptyState title="No rules yet">Add one to start tracking missed deadlines.</EmptyState>}

      <div className="stack-sm">
        {rules.map((rule) => (
          <div key={rule.id} className="card card-pad">
            <div className="row-between wrap" style={{ gap: 8 }}>
              <div className="grow">
                <div className="row wrap" style={{ gap: 8 }}>
                  <strong>{rule.name}</strong>
                  <Badge tone={rule.is_active ? 'good' : 'neutral'}>{rule.is_active ? 'Active' : 'Paused'}</Badge>
                  <Badge tone="brand">{rule.points} point{rule.points === 1 ? '' : 's'}</Badge>
                  {rule.marks_generated > 0 && <Badge>{rule.marks_generated} recorded</Badge>}
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>
                  {TRIGGERS.find(([key]) => key === rule.trigger_type)?.[1]}
                  {rule.grace_hours > 0 && ` · ${rule.grace_hours}h grace`}
                  {rule.repeat_every_days && ` · repeats every ${rule.repeat_every_days} days`}
                  {rule.max_points_per_task && ` · capped at ${rule.max_points_per_task} per task`}
                  {rule.priorities?.length > 0 && ` · only ${rule.priorities.join(', ')}`}
                  {rule.department_ids?.length > 0 &&
                    ` · only ${rule.department_ids
                      .map((id) => departments.find((d) => d.id === id)?.name || id)
                      .join(', ')}`}
                </div>
                {rule.description && <div className="small dim" style={{ marginTop: 4 }}>{rule.description}</div>}
              </div>
              {can('blackmark.rules') && (
                <div className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(rule)}>Edit</button>
                  <ConfirmButton
                    label="Delete"
                    confirmLabel="Tap again"
                    onConfirm={async () => {
                      await api.deleteRule(rule.id);
                      load();
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {editing !== undefined && (
        <RecordDialog
          title={editing ? `Edit ${editing.name}` : 'New black mark rule'}
          initial={
            editing || {
              name: '',
              description: '',
              trigger_type: 'deadline_missed',
              points: 1,
              grace_hours: 24,
              priorities: [],
              department_ids: [],
              repeat_every_days: '',
              max_points_per_task: '',
              severity: 'normal',
              is_active: true,
            }
          }
          onClose={() => setEditing(undefined)}
          onSave={save}
        >
          {(form, set) => (
            <>
              <Field label="Rule name">
                <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
              </Field>
              <Field label="What triggers it">
                <select className="select" value={form.trigger_type} onChange={(e) => set('trigger_type', e.target.value)}>
                  {TRIGGERS.map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </Field>
              <div className="grid-2">
                <Field label="Points" hint="Weight at the monthly review">
                  <input type="number" min="0" step="0.5" className="input" value={form.points} onChange={(e) => set('points', e.target.value)} />
                </Field>
                <Field label="Grace period (hours)" hint="Slack before the rule fires">
                  <input type="number" min="0" className="input" value={form.grace_hours} onChange={(e) => set('grace_hours', e.target.value)} />
                </Field>
              </div>

              {form.trigger_type === 'overdue_escalation' && (
                <div className="grid-2">
                  <Field label="Repeat every (days)">
                    <input type="number" min="1" className="input" value={form.repeat_every_days || ''} onChange={(e) => set('repeat_every_days', e.target.value)} />
                  </Field>
                  <Field label="Maximum points per task">
                    <input type="number" min="0" step="0.5" className="input" value={form.max_points_per_task || ''} onChange={(e) => set('max_points_per_task', e.target.value)} />
                  </Field>
                </div>
              )}

              <Field label="Only these priorities" hint="Leave all unticked to apply to every priority">
                <div className="row wrap" style={{ gap: 10 }}>
                  {PRIORITIES.map((priority) => (
                    <label key={priority.value} className="row small dim" style={{ gap: 5 }}>
                      <input
                        type="checkbox"
                        checked={(form.priorities || []).includes(priority.value)}
                        onChange={(e) => {
                          const current = new Set(form.priorities || []);
                          if (e.target.checked) current.add(priority.value);
                          else current.delete(priority.value);
                          set('priorities', [...current]);
                        }}
                      />
                      {priority.label}
                    </label>
                  ))}
                </div>
              </Field>

              <Field label="Only these departments" hint="Leave all unticked to apply everywhere">
                <div className="row wrap" style={{ gap: 10 }}>
                  {departments.map((department) => (
                    <label key={department.id} className="row small dim" style={{ gap: 5 }}>
                      <input
                        type="checkbox"
                        checked={(form.department_ids || []).map(Number).includes(department.id)}
                        onChange={(e) => {
                          const current = new Set((form.department_ids || []).map(Number));
                          if (e.target.checked) current.add(department.id);
                          else current.delete(department.id);
                          set('department_ids', [...current]);
                        }}
                      />
                      {department.name}
                    </label>
                  ))}
                </div>
              </Field>

              <Field label="Notes">
                <input className="input" value={form.description || ''} onChange={(e) => set('description', e.target.value)} />
              </Field>

              <label className="row small dim" style={{ gap: 6 }}>
                <input type="checkbox" checked={form.is_active !== false} onChange={(e) => set('is_active', e.target.checked)} />
                Rule is active
              </label>
            </>
          )}
        </RecordDialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------ thresholds

function ThresholdsTab({ onChanged }) {
  const { can } = useAuth();
  const { settings } = useRefData();
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) setForm({ blackmarks: { ...settings.blackmarks }, workload: { ...settings.workload } });
  }, [settings]);

  if (!form) return <Spinner />;

  const set = (group, key) => (event) => {
    const raw = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [group]: { ...current[group], [key]: raw } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings('blackmarks', {
        ...form.blackmarks,
        missedDeadlineLimit: Number(form.blackmarks.missedDeadlineLimit),
        warningPoints: Number(form.blackmarks.warningPoints),
        criticalPoints: Number(form.blackmarks.criticalPoints),
        rollingWindowMonths: Number(form.blackmarks.rollingWindowMonths),
      });
      await api.updateSettings('workload', {
        ...form.workload,
        idleDays: Number(form.workload.idleDays),
        overloadedPercent: Number(form.workload.overloadedPercent),
        dueSoonDays: Number(form.workload.dueSoonDays),
      });
      toast.success('Settings saved');
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const disabled = !can('settings.manage');

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Black mark thresholds</h2></div>
        <div className="card-pad grid-2">
          <Field label="Missed deadlines before a member is flagged" hint="Your rule of thumb is 3">
            <input type="number" min="1" className="input" value={form.blackmarks.missedDeadlineLimit} onChange={set('blackmarks', 'missedDeadlineLimit')} disabled={disabled} />
          </Field>
          <Field label="Rolling window (months)" hint="1 = calendar month, 3 = last quarter">
            <input type="number" min="1" max="12" className="input" value={form.blackmarks.rollingWindowMonths} onChange={set('blackmarks', 'rollingWindowMonths')} disabled={disabled} />
          </Field>
          <Field label="Points that raise a warning">
            <input type="number" min="0" step="0.5" className="input" value={form.blackmarks.warningPoints} onChange={set('blackmarks', 'warningPoints')} disabled={disabled} />
          </Field>
          <Field label="Points that need action">
            <input type="number" min="0" step="0.5" className="input" value={form.blackmarks.criticalPoints} onChange={set('blackmarks', 'criticalPoints')} disabled={disabled} />
          </Field>
          <label className="row small dim" style={{ gap: 6 }}>
            <input type="checkbox" checked={form.blackmarks.notifyMember} onChange={set('blackmarks', 'notifyMember')} disabled={disabled} />
            Notify the member when a black mark is recorded
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Workload and deadlines</h2></div>
        <div className="card-pad grid-2">
          <Field label="Days without movement before a member counts as stalled">
            <input type="number" min="1" className="input" value={form.workload.idleDays} onChange={set('workload', 'idleDays')} disabled={disabled} />
          </Field>
          <Field label="Capacity % at which someone is overloaded">
            <input type="number" min="50" max="300" className="input" value={form.workload.overloadedPercent} onChange={set('workload', 'overloadedPercent')} disabled={disabled} />
          </Field>
          <Field label="Days ahead that count as 'due soon'" hint="Also drives the deadline reminder">
            <input type="number" min="1" className="input" value={form.workload.dueSoonDays} onChange={set('workload', 'dueSoonDays')} disabled={disabled} />
          </Field>
        </div>
      </div>

      {!disabled && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ shared record dialog

function RecordDialog({ title, initial, onClose, onSave, children }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !form.name}
            onClick={async () => {
              setSaving(true);
              await onSave(form);
              setSaving(false);
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">{children(form, set)}</div>
    </Modal>
  );
}

// ------------------------------------------------------------ page

const TABS = [
  ['departments', 'Departments'],
  ['statuses', 'Statuses & stages'],
  ['rules', 'Black mark rules'],
  ['thresholds', 'Thresholds'],
  ['account', 'My account'],
];

function AccountTab() {
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const change = async () => {
    if (next.length < 8) return toast.error('Use at least 8 characters');
    setBusy(true);
    try {
      const data = await api.changePassword(current, next);
      localStorage.setItem('taskflow.token', data.token);
      toast.success('Password changed');
      setCurrent('');
      setNext('');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="card card-pad stack-sm">
        <h3>{user.full_name}</h3>
        <div className="small muted">{user.email} · {user.role}</div>
        <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
          {user.permissions.map((permission) => (
            <Badge key={permission}>{permission}</Badge>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Change password</h2></div>
        <div className="card-pad stack">
          <Field label="Current password">
            <input type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 8 characters">
            <input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={change} disabled={busy || !current || !next}>
              Update password
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const { refresh } = useRefData();
  const [tab, setTab] = useState('departments');

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div>
        <h1>Settings</h1>
        <div className="small muted">Departments, board columns, and the rules that generate black marks.</div>
      </div>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'departments' && <DepartmentsTab onChanged={refresh} />}
      {tab === 'statuses' && <StatusesTab onChanged={refresh} />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'thresholds' && <ThresholdsTab onChanged={refresh} />}
      {tab === 'account' && <AccountTab />}
    </div>
  );
}
