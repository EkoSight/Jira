import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import KeyResultPanel from '../components/KeyResultPanel.jsx';
import ObjectiveWizard from '../components/ObjectiveWizard.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { HEALTH_META, MEASUREMENT_TYPES, daysLeftLabel, describeOkrActivity, health, STATUS_LABEL } from '../lib/okr.js';
import { formatDate, relativeTime } from '../lib/format.js';

function AddKeyResultDialog({ objective, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    title: '',
    owner_user_id: objective.owner_user_id,
    measurement_type: 'NUMBER',
    direction: 'INCREASE',
    baseline_value: 0,
    target_value: '',
    current_value: '',
    unit: '',
    weight: 1,
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));
  const simple = ['BINARY', 'TASK_ROLLUP'].includes(form.measurement_type);

  const save = async () => {
    if (form.title.trim().length < 2) return toast.error('Give the key result a title');
    // without a target there is no number to measure against, and the goal ends up
    // reporting nothing at all
    if (!simple && form.target_value === '') {
      return toast.error('Set a target — otherwise there is no number to measure against');
    }
    setSaving(true);
    try {
      await api.addKeyResult(objective.id, {
        title: form.title.trim(),
        owner_user_id: Number(form.owner_user_id),
        measurement_type: form.measurement_type,
        direction: form.direction,
        baseline_value: Number(form.baseline_value) || 0,
        target_value: simple ? (form.measurement_type === 'BINARY' ? 1 : null)
          : form.target_value === '' ? null : Number(form.target_value),
        current_value: form.current_value === '' ? undefined : Number(form.current_value),
        unit: form.unit.trim() || null,
        weight: Number(form.weight) || 1,
      });
      toast.success('Key result added');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add a key result"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Add'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="What gets measured?">
          <input
            className="input"
            autoFocus
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Onboard 100 farmers onto advisory"
          />
        </Field>
        <Field
          label="How is it measured?"
          hint={MEASUREMENT_TYPES.find((m) => m.value === form.measurement_type)?.hint}
        >
          <select
            className="select"
            value={form.measurement_type}
            onChange={(e) => set({ measurement_type: e.target.value })}
          >
            {MEASUREMENT_TYPES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </Field>

        {!simple && (
          <div className="row wrap" style={{ gap: 8 }}>
            <Field label="From">
              <input
                className="input"
                type="number"
                value={form.baseline_value}
                onChange={(e) => set({ baseline_value: e.target.value })}
              />
            </Field>
            <Field label="To">
              <input
                className="input"
                type="number"
                value={form.target_value}
                onChange={(e) => set({ target_value: e.target.value })}
              />
            </Field>
            <Field label="Today" hint="Blank starts at the “From” value">
              <input
                className="input"
                type="number"
                value={form.current_value}
                onChange={(e) => set({ current_value: e.target.value })}
              />
            </Field>
            <Field label="Unit">
              <input className="input" value={form.unit} onChange={(e) => set({ unit: e.target.value })} />
            </Field>
          </div>
        )}

        <Field label="Weight" hint="How much this one counts towards the goal. Leave at 1 unless it dominates.">
          <input
            className="input"
            type="number"
            min="0"
            step="0.5"
            value={form.weight}
            onChange={(e) => set({ weight: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}

function HealthOverrideDialog({ objective, onClose, onSaved }) {
  const toast = useToast();
  const [value, setValue] = useState(objective.manual_health || '');
  const [reason, setReason] = useState(objective.health_override_reason || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (value && reason.trim().length < 3) return toast.error('Say why — the calculated status disagrees');
    setSaving(true);
    try {
      await api.setObjectiveHealth(objective.id, value || null, reason.trim() || undefined);
      toast.success(value ? 'Status set by hand' : 'Back to the calculated status');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Set the status by hand"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          The numbers say <strong>{health(objective.auto_health).label}</strong>. Overriding that is
          fine when you know something the data does not — it stays visible either way.
        </div>
        <Field label="Show it as">
          <select className="select" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Whatever the numbers say</option>
            {Object.entries(HEALTH_META).map(([key, meta]) => (
              <option key={key} value={key}>{meta.label}</option>
            ))}
          </select>
        </Field>
        {value && (
          <Field label="Why?">
            <textarea
              className="textarea"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="The dealer contracts are signed but the numbers land next month."
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export default function ObjectiveDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [addingKeyResult, setAddingKeyResult] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [openTask, setOpenTask] = useState(null);
  const [parents, setParents] = useState([]);

  const load = () => {
    api
      .objective(id)
      .then(setData)
      .catch((err) => {
        toast.error(err);
        if (err.status === 404) navigate('/goals');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    load();
    api.objectives({ scope_type: 'COMPANY' }).then((d) => setParents(d.objectives)).catch(() => {});
  }, [id]);

  if (loading && !data) return <Spinner label="Loading the goal" />;
  if (!data) return <EmptyState title="Goal not found" />;

  const { objective, key_results: keyResults, children, activity, can_edit: canEdit } = data;
  const meta = health(objective.health);
  const progress = objective.progress_percent;
  const elapsed = objective.time_elapsed_percent;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row small muted">
        <Link to="/goals" className="btn-link">Goals</Link>
        <span>/</span>
        {objective.parent_title && (
          <>
            <Link to={`/goals/${objective.parent_objective_id}`} className="btn-link truncate">
              {objective.parent_title}
            </Link>
            <span>/</span>
          </>
        )}
        <span className="truncate">{objective.title}</span>
      </div>

      <section className="card card-pad stack">
        <div className="row-between wrap" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row wrap" style={{ gap: 6 }}>
              <h1 style={{ fontSize: 22 }}>{objective.title}</h1>
              <Badge tone={meta.tone} dot={meta.color}>{meta.label}</Badge>
              <Badge>{STATUS_LABEL[objective.status]}</Badge>
            </div>
            <div className="small muted row wrap" style={{ gap: 6, marginTop: 4 }}>
              <span>{objective.scope_type === 'COMPANY' ? 'Company-wide' : objective.department_name}</span>
              <span>·</span>
              <span>{formatDate(objective.start_date)} → {formatDate(objective.end_date)}</span>
              <span>·</span>
              <span>{daysLeftLabel(objective.end_date)}</span>
            </div>
          </div>

          <div className="row wrap">
            {canEdit && (
              <>
                <button type="button" className="btn btn-sm" onClick={() => setOverriding(true)}>
                  Set status
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                  <Icon name="edit" size={13} /> Edit
                </button>
                <ConfirmButton
                  label="Archive"
                  confirmLabel="Really archive?"
                  className="btn btn-danger btn-sm"
                  onConfirm={async () => {
                    try {
                      await api.archiveObjective(objective.id);
                      toast.success('Goal archived');
                      navigate('/goals');
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                />
              </>
            )}
          </div>
        </div>

        {objective.description && <p style={{ fontSize: 13.5 }}>{objective.description}</p>}

        <div className="goal-hero">
          <div>
            <div className="stat-label">Progress</div>
            <div className="stat-value tnum" style={{ color: meta.color }}>
              {progress === null ? '—' : `${progress}%`}
            </div>
            <div className="stat-note">
              {elapsed === null ? '' : `${elapsed}% of the period has gone`}
            </div>
          </div>

          <div className="grow" style={{ minWidth: 200 }}>
            <span className="goal-track" style={{ height: 12 }}>
              <span className="progress-fill" style={{ width: `${progress ?? 0}%`, background: meta.color }} />
              {elapsed !== null && (
                <span className="goal-pace" style={{ left: `${elapsed}%` }} title="Where the calendar says you should be" />
              )}
            </span>
            <div className="small muted" style={{ marginTop: 6 }}>
              The marker is today's pace. Behind it means the goal is slipping.
            </div>
            {objective.is_overridden && (
              <div className="small" style={{ marginTop: 6 }}>
                Shown as <strong>{meta.label}</strong> by hand — the numbers say{' '}
                {health(objective.auto_health).label}.
                {objective.health_override_reason && ` “${objective.health_override_reason}”`}
              </div>
            )}
          </div>

          <div>
            <div className="stat-label">Accountable</div>
            <div className="row" style={{ marginTop: 6 }}>
              <Avatar name={objective.owner_name || '?'} color={objective.owner_color} size={28} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{objective.owner_name}</div>
                <div className="small muted">
                  {objective.linked_task_count} linked task{objective.linked_task_count === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="card card-pad stack">
        <div className="row-between wrap">
          <div>
            <h2>Key results</h2>
            <div className="small muted">How you will know the goal was met.</div>
          </div>
          {canEdit && (
            <div className="row">
              {keyResults.length > 1 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    try {
                      await api.equaliseWeights(objective.id);
                      toast.success('Weights evened out');
                      load();
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                >
                  Even out weights
                </button>
              )}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setAddingKeyResult(true)}>
                <Icon name="plus" size={14} /> Add key result
              </button>
            </div>
          )}
        </div>

        {keyResults.length === 0 ? (
          <EmptyState title="No key results yet">
            A goal without a measurable result is a wish. Add at least one number someone can check.
          </EmptyState>
        ) : (
          <div className="stack-sm">
            {keyResults.map((keyResult) => (
              <KeyResultPanel
                key={keyResult.id}
                keyResult={keyResult}
                canEdit={canEdit}
                onChanged={load}
                onOpenTask={setOpenTask}
              />
            ))}
          </div>
        )}
      </section>

      {children.length > 0 && (
        <section className="card card-pad stack">
          <h2>Supported by</h2>
          <div className="stack-sm">
            {children.map((child) => (
              <Link key={child.id} to={`/goals/${child.id}`} className="link-row">
                <Icon name="subtask" size={14} />
                <span className="grow truncate">{child.title}</span>
                <Badge>{STATUS_LABEL[child.status]}</Badge>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="card card-pad stack">
        <h2>History</h2>
        {activity.length === 0 ? (
          <div className="small muted">Nothing yet.</div>
        ) : (
          <div className="stack-sm">
            {activity.map((item) => (
              <div key={item.id} className="activity-line">
                {/* no actor means TaskFlow itself did it, not an anonymous person */}
                <strong>{item.actor_name || 'TaskFlow'}</strong> {describeOkrActivity(item)}
                <span className="muted"> · {relativeTime(item.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <ObjectiveWizard
          objective={objective}
          parentOptions={parents}
          onClose={() => setEditing(false)}
          onSaved={load}
        />
      )}
      {addingKeyResult && (
        <AddKeyResultDialog objective={objective} onClose={() => setAddingKeyResult(false)} onSaved={load} />
      )}
      {overriding && (
        <HealthOverrideDialog objective={objective} onClose={() => setOverriding(false)} onSaved={load} />
      )}
      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
    </div>
  );
}
