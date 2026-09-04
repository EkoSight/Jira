import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { ProgressRing } from '../components/charts.jsx';
import KeyResultPanel from '../components/KeyResultPanel.jsx';
import ObjectiveWizard from '../components/ObjectiveWizard.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import {
  HEALTH_META, KR_FILTERS, MEASUREMENT_TYPES, STATUS_LABEL,
  byUrgency, contributors, daysLeftLabel, describeOkrActivity, filterCounts,
  health, krAttention, myContribution, pace, paceSentence,
} from '../lib/okr.js';
import { useIsNarrow } from '../lib/useMedia.js';
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
      size="sheet"
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
      size="sheet"
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

/**
 * The destructive and rarely-wanted actions.
 *
 * Archiving a goal used to sit in the header as a red button next to Edit,
 * one slip away from being pressed by someone reading a status page.
 */
function OverflowMenu({ children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="overflow" ref={ref}>
      <button
        type="button"
        className="btn btn-sm btn-icon"
        aria-label="More actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="menu" size={15} />
      </button>
      {open && <div className="overflow-menu">{children}</div>}
    </div>
  );
}

/**
 * GLANCE: everything needed to decide whether this goal is fine, in one band.
 *
 * The bar carries three things at once — how far the goal has come, where the
 * calendar says it should be, and the gap between them — because the gap is the
 * only one of the three anybody actually acts on.
 */
function ProgressBand({ objective }) {
  const meta = health(objective.health);
  const progress = objective.progress_percent;
  const elapsed = objective.time_elapsed_percent;
  const reading = pace(progress, elapsed);
  const behind = reading.delta !== null && reading.delta < 0;

  return (
    <div className="goal-band">
      <div className="goal-band-ring">
        <ProgressRing percent={progress} color={meta.color} size={78} stroke={7} />
        <div className="goal-band-ring-label">complete</div>
      </div>

      <div className="grow" style={{ minWidth: 0 }}>
        <p className="goal-verdict">{paceSentence(objective)}</p>

        <div className="goal-bar" role="img"
          aria-label={
            progress === null
              ? 'No progress recorded'
              : `${progress}% complete, ${elapsed ?? 0}% of the time gone`
          }
        >
          {/* the stretch between where it is and where it should be: the gap is
              drawn, not left to be worked out from two numbers */}
          {behind && elapsed !== null && (
            <span
              className="goal-bar-gap"
              style={{ left: `${progress ?? 0}%`, width: `${Math.max(0, elapsed - (progress ?? 0))}%` }}
            />
          )}
          <span className="goal-bar-fill" style={{ width: `${progress ?? 0}%`, background: meta.color }} />
          {elapsed !== null && (
            <span className="goal-bar-pace" style={{ left: `${elapsed}%` }} />
          )}
        </div>

        <div className="goal-bar-legend">
          <span><span className="swatch" style={{ background: meta.color }} /> {progress ?? 0}% done</span>
          {elapsed !== null && <span><span className="swatch swatch-pace" /> {elapsed}% of the time gone</span>}
          {reading.delta !== null && (
            <span className={`goal-gap goal-gap-${reading.tone}`}>
              {reading.delta >= 0 ? `${reading.delta} points ahead` : `${Math.abs(reading.delta)} points behind`}
            </span>
          )}
        </div>

        {objective.is_overridden && (
          <div className="small" style={{ marginTop: 8 }}>
            Shown as <strong>{meta.label}</strong> by hand — the numbers say{' '}
            {health(objective.auto_health).label}.
            {objective.health_override_reason && ` “${objective.health_override_reason}”`}
          </div>
        )}
      </div>
    </div>
  );
}

/** SCAN: the key results, with the ones worth looking at pulled to the front. */
function KeyResultSection({ objective, keyResults, tasksByKr, canEdit, onChanged, onOpenTask, onAdd, compact }) {
  const { user } = useAuth();
  const toast = useToast();
  const [filter, setFilter] = useState('all');

  const counts = useMemo(() => filterCounts(keyResults, user.id), [keyResults, user.id]);
  const active = KR_FILTERS.find((f) => f.key === filter) || KR_FILTERS[0];
  const shown = useMemo(
    () => keyResults.filter((kr) => active.match(kr, user.id)).sort(byUrgency),
    [keyResults, active, user.id],
  );

  return (
    <section className="card card-pad stack" id="key-results">
      {/* on the narrow layout the tab already says "Key results" and the pinned
          bar already offers to add one — repeating both wastes the first screen */}
      <div className="row-between wrap">
        {!compact && (
          <div>
            <h2>Key results</h2>
            <div className="small muted">How you will know the goal was met.</div>
          </div>
        )}
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
                    onChanged();
                  } catch (err) {
                    toast.error(err);
                  }
                }}
              >
                Even out weights
              </button>
            )}
            {!compact && (
              <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>
                <Icon name="plus" size={14} /> Add key result
              </button>
            )}
          </div>
        )}
      </div>

      {keyResults.length === 0 ? (
        <EmptyState title="No key results yet">
          A goal without a measurable result is a wish. Add at least one number someone can check.
        </EmptyState>
      ) : (
        <>
          <div className="health-chips">
            {KR_FILTERS.filter((f) => counts[f.key] > 0 || f.key === 'all').map((f) => (
              <button
                key={f.key}
                type="button"
                className={`health-chip${filter === f.key ? ' is-active' : ''}`}
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="tnum">{counts[f.key]}</span>
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="small muted">Nothing in this group.</div>
          ) : (
            <div className="stack-sm">
              {shown.map((keyResult) => (
                <KeyResultPanel
                  key={keyResult.id}
                  keyResult={keyResult}
                  tasks={tasksByKr.get(keyResult.id) || []}
                  canEdit={canEdit}
                  onChanged={onChanged}
                  onOpenTask={onOpenTask}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The short list of things a person could actually do something about today. */
function NeedsAttention({ keyResults, tasks, onJump }) {
  const flagged = useMemo(
    () => keyResults
      .map((kr) => ({ kr, reasons: krAttention(kr) }))
      .filter((row) => row.reasons.length > 0)
      .sort((a, b) => byUrgency(a.kr, b.kr)),
    [keyResults],
  );
  const lateTasks = tasks.filter((t) => t.is_overdue);

  if (!flagged.length && !lateTasks.length) {
    return (
      <section className="card card-pad attention-clear">
        <div className="row">
          <Icon name="check" size={16} />
          <div>
            <strong>Nothing is asking for attention.</strong>
            <div className="small muted">
              Every key result has been updated recently and none are behind.
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card card-pad stack">
      <div>
        <h2>Needs attention</h2>
        <div className="small muted">
          Worked out from the data on this page. Nothing here has changed a status by itself.
        </div>
      </div>

      <div className="stack-sm">
        {flagged.map(({ kr, reasons }) => (
          <button key={kr.id} type="button" className="sig-row" onClick={() => onJump(kr)}>
            <span className={`sig-dot sig-${reasons[0].severity}`} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="small truncate" style={{ fontWeight: 600, display: 'block' }}>{kr.title}</span>
              <span className="small muted">{reasons.map((r) => r.label).join(' · ')}</span>
            </span>
            <Icon name="chevron" size={13} />
          </button>
        ))}

        {lateTasks.length > 0 && (
          <div className="sig-row">
            <span className="sig-dot sig-critical" />
            <span className="grow small">
              <strong>{lateTasks.length} linked task{lateTasks.length === 1 ? ' is' : 's are'} past due</strong>
              <span className="muted"> — the work behind these numbers has slipped.</span>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

/** What the person reading this page is personally carrying. */
function MyContribution({ keyResults, tasks, onOpenTask, onJump }) {
  const { user } = useAuth();
  const mine = useMemo(() => myContribution(keyResults, tasks, user.id), [keyResults, tasks, user.id]);

  if (!mine.key_results.length && !mine.tasks.length) return null;

  return (
    <section className="card card-pad stack rail-card">
      <h3>Your part</h3>
      <div className="rail-facts">
        <div>
          <div className="rail-figure tnum">{mine.key_results.length}</div>
          <div className="rail-figure-label">key result{mine.key_results.length === 1 ? '' : 's'} you own</div>
        </div>
        <div>
          <div className="rail-figure tnum">{mine.open_tasks.length}</div>
          <div className="rail-figure-label">
            open task{mine.open_tasks.length === 1 ? '' : 's'}
            {mine.overdue_tasks.length > 0 && (
              <span className="crit-count"> · {mine.overdue_tasks.length} late</span>
            )}
          </div>
        </div>
      </div>

      {mine.needs_update.length > 0 && (
        <div className="small">
          {mine.needs_update.length === 1 ? 'One of yours has' : `${mine.needs_update.length} of yours have`}{' '}
          not been updated in a while.{' '}
          <button type="button" className="btn-link" onClick={() => onJump(mine.needs_update[0])}>
            Update {mine.needs_update.length === 1 ? 'it' : 'the first'}
          </button>
        </div>
      )}

      {mine.open_tasks.length > 0 && (
        <div className="stack-sm">
          {mine.open_tasks.slice(0, 4).map((task) => (
            <button
              key={task.id}
              type="button"
              className={`link-row${task.is_overdue ? ' is-late' : ''}`}
              onClick={() => onOpenTask(task.id)}
            >
              <span className="task-ref">{task.ref}</span>
              <span className="grow truncate">{task.title}</span>
              {task.is_overdue && <Badge tone="critical">late</Badge>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** The right rail: who, when, and what this goal sits inside. */
function GoalRail({ objective, keyResults, tasks, childGoals, canEdit, onOverride }) {
  const people = useMemo(
    () => contributors(keyResults, tasks, objective.owner_user_id),
    [keyResults, tasks, objective.owner_user_id],
  );
  const meta = health(objective.health);
  const doneTasks = tasks.filter((t) => t.stage === 'done').length;

  return (
    <>
      <section className="card card-pad stack rail-card">
        <h3>Accountable</h3>
        <div className="row">
          <Avatar name={objective.owner_name || '?'} color={objective.owner_color} size={34} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{objective.owner_name || 'Nobody yet'}</div>
            <div className="small muted">
              {objective.scope_type === 'COMPANY' ? 'Company-wide goal' : objective.department_name}
            </div>
          </div>
        </div>

        {people.length > 0 && (
          <>
            <hr className="divider" />
            <div className="stat-label">Also carrying this</div>
            <div className="stack-sm">
              {people.map((person) => (
                <div key={person.id} className="row">
                  <Avatar name={person.name} color={person.color} size={22} />
                  <span className="grow truncate small">{person.name}</span>
                  <span className="small muted">
                    {person.key_results > 0 && `${person.key_results} KR`}
                    {person.key_results > 0 && person.tasks > 0 && ' · '}
                    {person.tasks > 0 && `${person.tasks} task${person.tasks === 1 ? '' : 's'}`}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="card card-pad stack rail-card">
        <h3>Timeline</h3>
        <div className="rail-line">
          <span className="muted">Started</span>
          <span>{formatDate(objective.start_date)}</span>
        </div>
        <div className="rail-line">
          <span className="muted">Ends</span>
          <span>{formatDate(objective.end_date)}</span>
        </div>
        <div className="rail-line">
          <span className="muted">Remaining</span>
          <span style={{ fontWeight: 600 }}>{daysLeftLabel(objective.end_date) || '—'}</span>
        </div>
        <div className="rail-line">
          <span className="muted">Time gone</span>
          <span className="tnum">
            {objective.time_elapsed_percent === null ? '—' : `${objective.time_elapsed_percent}%`}
          </span>
        </div>
      </section>

      <section className="card card-pad stack rail-card">
        <h3>Health</h3>
        <div className="row">
          <Badge tone={meta.tone} dot={meta.color}>{meta.label}</Badge>
          {objective.is_overridden && <span className="small muted">set by hand</span>}
        </div>
        <div className="small muted">
          Health is a judgement about whether the goal will land. Progress is just the number.
          They move apart on purpose.
        </div>
        <div className="rail-line">
          <span className="muted">Key results</span>
          <span className="tnum">{keyResults.length}</span>
        </div>
        <div className="rail-line">
          <span className="muted">Linked work</span>
          <span className="tnum">{doneTasks}/{tasks.length} done</span>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-sm btn-block" onClick={onOverride}>
            Set status by hand
          </button>
        )}
      </section>

      {(objective.parent_title || childGoals.length > 0) && (
        <section className="card card-pad stack rail-card">
          <h3>Alignment</h3>
          {objective.parent_title && (
            <div>
              <div className="stat-label">Supports</div>
              <Link to={`/goals/${objective.parent_objective_id}`} className="link-row">
                <Icon name="target" size={14} />
                <span className="grow truncate">{objective.parent_title}</span>
              </Link>
            </div>
          )}
          {childGoals.length > 0 && (
            <div>
              <div className="stat-label">Supported by</div>
              <div className="stack-sm">
                {childGoals.map((child) => (
                  <Link key={child.id} to={`/goals/${child.id}`} className="link-row">
                    <Icon name="subtask" size={14} />
                    <span className="grow truncate">{child.title}</span>
                    <Badge>{STATUS_LABEL[child.status]}</Badge>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** Everything that has happened, goal and key results together. */
function ActivityFeed({ activity }) {
  return (
    <section className="card card-pad stack">
      <div>
        <h2>What changed</h2>
        <div className="small muted">Updates to the goal and to every key result under it.</div>
      </div>
      {activity.length === 0 ? (
        <div className="small muted">Nothing yet.</div>
      ) : (
        <div className="stack-sm">
          {activity.map((item) => (
            <div key={item.id} className="activity-row">
              <Avatar name={item.actor_name || 'TaskFlow'} color={item.actor_color} size={22} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small">
                  {/* no actor means TaskFlow itself did it, not an anonymous person */}
                  <strong>{item.actor_name || 'TaskFlow'}</strong> {describeOkrActivity(item)}
                </div>
                {item.key_result_title && (
                  <div className="small muted truncate">on “{item.key_result_title}”</div>
                )}
              </div>
              <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                {relativeTime(item.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function ObjectiveDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const narrow = useIsNarrow();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [addingKeyResult, setAddingKeyResult] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [openTask, setOpenTask] = useState(null);
  const [parents, setParents] = useState([]);
  const [tab, setTab] = useState('overview');
  const [descOpen, setDescOpen] = useState(false);

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

  const tasks = data?.tasks || [];
  const keyResults = data?.key_results || [];

  // one pass, so each card gets its own work without a request per key result
  const tasksByKr = useMemo(() => {
    const map = new Map();
    for (const task of tasks) {
      if (!map.has(task.key_result_id)) map.set(task.key_result_id, []);
      map.get(task.key_result_id).push(task);
    }
    return map;
  }, [tasks]);

  if (loading && !data) return <Spinner label="Loading the goal" />;
  if (!data) return <EmptyState title="Goal not found" />;

  const { objective, children, activity, can_edit: canEdit } = data;
  const meta = health(objective.health);
  const attentionCount = keyResults.filter((kr) => krAttention(kr).length > 0).length;

  // jumping to a key result means showing it, wherever it currently is: on the
  // narrow layout that is a different tab, not just a different scroll position
  const jumpToKeyResult = () => {
    if (narrow) setTab('results');
    requestAnimationFrame(() => {
      document.getElementById('key-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const header = (
    <>
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

      <section className="card card-pad stack goal-head">
        <span className="goal-head-rail" style={{ background: meta.color }} aria-hidden="true" />

        <div className="row-between wrap" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row wrap" style={{ gap: 6, marginBottom: 5 }}>
              <Badge tone={meta.tone} dot={meta.color}>{meta.label}</Badge>
              <Badge>{STATUS_LABEL[objective.status]}</Badge>
              <span className="small muted">
                {objective.scope_type === 'COMPANY' ? 'Company-wide' : objective.department_name}
              </span>
            </div>
            <h1 className="goal-head-title">{objective.title}</h1>
            <div className="small muted" style={{ marginTop: 4 }}>
              {formatDate(objective.start_date)} → {formatDate(objective.end_date)} ·{' '}
              {daysLeftLabel(objective.end_date)}
            </div>
          </div>

          {canEdit && !narrow && (
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                <Icon name="edit" size={13} /> Edit
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setAddingKeyResult(true)}>
                <Icon name="plus" size={14} /> Add key result
              </button>
              <OverflowMenu>
                <button type="button" className="overflow-item" onClick={() => setOverriding(true)}>
                  Set status by hand
                </button>
                <hr className="divider" />
                <ConfirmButton
                  label="Archive this goal"
                  confirmLabel="Really archive?"
                  className="overflow-item is-danger"
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
              </OverflowMenu>
            </div>
          )}
        </div>

        {objective.description && (
          narrow ? (
            // on a phone a paragraph this long pushes the tabs off the first
            // screen, so it opens on demand rather than costing everyone a scroll
            <div>
              <p className={`goal-head-desc${descOpen ? '' : ' is-clamped'}`}>{objective.description}</p>
              <button type="button" className="btn-link small" onClick={() => setDescOpen((v) => !v)}>
                {descOpen ? 'Less' : 'More'}
              </button>
            </div>
          ) : (
            <p className="goal-head-desc">{objective.description}</p>
          )
        )}

        <ProgressBand objective={objective} />
      </section>
    </>
  );

  // ------------------------------------------------------------------ mobile
  //
  // Not the desktop page stacked. The rail's contents are a tab of their own,
  // the primary action is pinned within thumb reach, and only one section is
  // mounted at a time.
  if (narrow) {
    const TABS = [
      { key: 'overview', label: 'Overview' },
      { key: 'results', label: `Key results${keyResults.length ? ` (${keyResults.length})` : ''}` },
      { key: 'activity', label: 'Activity' },
    ];

    return (
      <div className="stack" style={{ gap: 14, paddingBottom: 56 }}>
        {header}

        <div className="tabs tabs-scroll" role="tablist">
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
              {t.key === 'results' && attentionCount > 0 && (
                <span className="tab-flag">{attentionCount}</span>
              )}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <>
            <NeedsAttention keyResults={keyResults} tasks={tasks} onJump={jumpToKeyResult} />
            <MyContribution
              keyResults={keyResults}
              tasks={tasks}
              onOpenTask={setOpenTask}
              onJump={jumpToKeyResult}
            />
            <GoalRail
              objective={objective}
              keyResults={keyResults}
              tasks={tasks}
              childGoals={children}
              canEdit={canEdit}
              onOverride={() => setOverriding(true)}
            />
          </>
        )}

        {tab === 'results' && (
          <KeyResultSection
            compact
            objective={objective}
            keyResults={keyResults}
            tasksByKr={tasksByKr}
            canEdit={canEdit}
            onChanged={load}
            onOpenTask={setOpenTask}
            onAdd={() => setAddingKeyResult(true)}
          />
        )}

        {tab === 'activity' && <ActivityFeed activity={activity} />}

        {canEdit && (
          <div className="goal-actionbar">
            <button type="button" className="btn btn-block" onClick={() => setEditing(true)}>
              <Icon name="edit" size={14} /> Edit goal
            </button>
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={() => setAddingKeyResult(true)}
            >
              <Icon name="plus" size={14} /> Key result
            </button>
          </div>
        )}

        <Dialogs
          objective={objective}
          parents={parents}
          editing={editing}
          setEditing={setEditing}
          addingKeyResult={addingKeyResult}
          setAddingKeyResult={setAddingKeyResult}
          overriding={overriding}
          setOverriding={setOverriding}
          openTask={openTask}
          setOpenTask={setOpenTask}
          onSaved={load}
        />
      </div>
    );
  }

  // ----------------------------------------------------------------- desktop
  return (
    <div className="stack" style={{ gap: 16 }}>
      {header}

      <div className="goal-layout">
        <div className="stack" style={{ gap: 16 }}>
          <NeedsAttention keyResults={keyResults} tasks={tasks} onJump={jumpToKeyResult} />
          <KeyResultSection
            objective={objective}
            keyResults={keyResults}
            tasksByKr={tasksByKr}
            canEdit={canEdit}
            onChanged={load}
            onOpenTask={setOpenTask}
            onAdd={() => setAddingKeyResult(true)}
          />
          <ActivityFeed activity={activity} />
        </div>

        <aside className="goal-rail">
          <MyContribution
            keyResults={keyResults}
            tasks={tasks}
            onOpenTask={setOpenTask}
            onJump={jumpToKeyResult}
          />
          <GoalRail
            objective={objective}
            keyResults={keyResults}
            tasks={tasks}
            childGoals={children}
            canEdit={canEdit}
            onOverride={() => setOverriding(true)}
          />
        </aside>
      </div>

      <Dialogs
        objective={objective}
        parents={parents}
        editing={editing}
        setEditing={setEditing}
        addingKeyResult={addingKeyResult}
        setAddingKeyResult={setAddingKeyResult}
        overriding={overriding}
        setOverriding={setOverriding}
        openTask={openTask}
        setOpenTask={setOpenTask}
        onSaved={load}
      />
    </div>
  );
}

/** The dialogs, shared by both layouts so neither can drift from the other. */
function Dialogs({
  objective, parents, editing, setEditing, addingKeyResult, setAddingKeyResult,
  overriding, setOverriding, openTask, setOpenTask, onSaved,
}) {
  return (
    <>
      {editing && (
        <ObjectiveWizard
          objective={objective}
          parentOptions={parents}
          onClose={() => setEditing(false)}
          onSaved={onSaved}
        />
      )}
      {addingKeyResult && (
        <AddKeyResultDialog objective={objective} onClose={() => setAddingKeyResult(false)} onSaved={onSaved} />
      )}
      {overriding && (
        <HealthOverrideDialog objective={objective} onClose={() => setOverriding(false)} onSaved={onSaved} />
      )}
      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={onSaved} />}
    </>
  );
}
