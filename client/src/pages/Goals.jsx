import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import ObjectiveWizard from '../components/ObjectiveWizard.jsx';
import { HEALTH_META, daysLeftLabel, health, periodPresets, STATUS_LABEL } from '../lib/okr.js';
import { formatDate } from '../lib/format.js';

/** The four numbers a goals review actually opens with. */
function HealthStrip({ summary, active, onPick }) {
  const cells = [
    { key: 'ON_TRACK', value: summary.on_track },
    { key: 'AT_RISK', value: summary.at_risk },
    { key: 'OFF_TRACK', value: summary.off_track },
    { key: 'COMPLETED', value: summary.completed },
    { key: 'NOT_STARTED', value: summary.not_started },
  ];

  return (
    <div className="stat-grid">
      <div className="stat">
        <div className="stat-label">Overall progress</div>
        <div className="stat-value tnum">
          {summary.overall_progress === null ? '—' : `${summary.overall_progress}%`}
        </div>
        <div className="stat-note">
          across {summary.total} goal{summary.total === 1 ? '' : 's'}
        </div>
      </div>

      {cells.map((cell) => {
        const meta = HEALTH_META[cell.key];
        const selected = active === cell.key;
        return (
          <button
            key={cell.key}
            type="button"
            className="stat"
            style={{ textAlign: 'left', cursor: 'pointer', borderColor: selected ? meta.color : undefined }}
            onClick={() => onPick(selected ? '' : cell.key)}
          >
            <div className="stat-label">
              <span className="stat-accent" style={{ background: meta.color }} /> {meta.label}
            </div>
            <div className="stat-value tnum">{cell.value}</div>
            <div className="stat-note">{selected ? 'showing only these' : 'click to filter'}</div>
          </button>
        );
      })}
    </div>
  );
}

function ObjectiveRow({ objective }) {
  const meta = health(objective.health);
  const progress = objective.progress_percent;
  const elapsed = objective.time_elapsed_percent;

  return (
    <Link to={`/goals/${objective.id}`} className="goal-row">
      <span className="goal-rail" style={{ background: meta.color }} />

      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="goal-title">{objective.title}</span>
          <Badge tone={meta.tone} dot={meta.color}>{meta.label}</Badge>
          {objective.status !== 'ACTIVE' && <Badge>{STATUS_LABEL[objective.status]}</Badge>}
          {objective.is_overridden && <Badge title="Set by hand, not calculated">manual</Badge>}
        </div>

        <div className="small muted row wrap" style={{ gap: 6, marginTop: 3 }}>
          <span>
            {objective.scope_type === 'COMPANY' ? 'Company-wide' : objective.department_name}
          </span>
          <span>·</span>
          <span>{objective.key_result_count} key result{objective.key_result_count === 1 ? '' : 's'}</span>
          {objective.linked_task_count > 0 && (
            <>
              <span>·</span>
              <span>{objective.linked_task_count} linked task{objective.linked_task_count === 1 ? '' : 's'}</span>
            </>
          )}
          {objective.parent_title && (
            <>
              <span>·</span>
              <span>supports {objective.parent_title}</span>
            </>
          )}
        </div>
      </div>

      <div className="goal-owner">
        <Avatar name={objective.owner_name || '?'} color={objective.owner_color} size={24} />
        <span className="small muted truncate">{objective.owner_name}</span>
      </div>

      <div className="goal-progress">
        <div className="row-between small">
          <span className="tnum" style={{ fontWeight: 650 }}>
            {progress === null ? '—' : `${progress}%`}
          </span>
          <span className="muted">{daysLeftLabel(objective.end_date)}</span>
        </div>
        {/* the pace marker is what turns a bar into a judgement */}
        <span className="goal-track">
          <span className="progress-fill" style={{ width: `${progress ?? 0}%`, background: meta.color }} />
          {elapsed !== null && (
            <span className="goal-pace" style={{ left: `${elapsed}%` }} title={`${elapsed}% of the time gone`} />
          )}
        </span>
        <div className="small muted">Ends {formatDate(objective.end_date)}</div>
      </div>
    </Link>
  );
}

export default function Goals() {
  const { user, can } = useAuth();
  const { departments } = useRefData();
  const toast = useToast();

  const presets = useMemo(() => periodPresets(), []);
  const [period, setPeriod] = useState('this-quarter');
  const [departmentId, setDepartmentId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [healthFilter, setHealthFilter] = useState('');
  const [scope, setScope] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const range = presets.find((p) => p.key === period);

  const load = () => {
    setLoading(true);
    api
      .goalsDashboard({
        from: range?.start_date,
        to: range?.end_date,
        department_id: departmentId || undefined,
        owner_id: ownerId || undefined,
        scope_type: scope || undefined,
      })
      .then(setData)
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, [period, departmentId, ownerId, scope]);

  if (loading && !data) return <Spinner label="Pulling the goals together" />;
  if (!data) return <EmptyState title="Could not load the goals" />;

  const objectives = healthFilter
    ? data.objectives.filter((o) => o.health === healthFilter)
    : data.objectives;

  // your own goals are lifted to the top and then left out of the lists below,
  // so nothing is shown twice
  const mine = objectives.filter((o) => o.owner_user_id === user.id);
  const rest = objectives.filter((o) => o.owner_user_id !== user.id);
  const company = rest.filter((o) => o.scope_type === 'COMPANY');
  const byDepartment = rest.filter((o) => o.scope_type === 'DEPARTMENT');
  const mayCreate = can('okr.create.company') || can('okr.create.department');

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row-between wrap">
        <div>
          <h1>Goals</h1>
          <div className="small muted">
            What we are trying to achieve this period, and whether the work is getting us there.
          </div>
        </div>
        {mayCreate && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New goal
          </button>
        )}
      </div>

      <div className="filters">
        <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {presets.map((preset) => (
            <option key={preset.key} value={preset.key}>{preset.label}</option>
          ))}
        </select>
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">Company and departments</option>
          <option value="COMPANY">Company-wide only</option>
          <option value="DEPARTMENT">Departments only</option>
        </select>
        <select className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <option value="">Anyone accountable</option>
          <option value={user.id}>Mine</option>
          {data.by_owner
            .filter((o) => o.owner_user_id !== user.id)
            .map((o) => (
              <option key={o.owner_user_id} value={o.owner_user_id}>{o.name}</option>
            ))}
        </select>
      </div>

      <HealthStrip summary={data.summary} active={healthFilter} onPick={setHealthFilter} />

      {data.summary.total === 0 ? (
        <EmptyState
          title="No goals for this period yet"
          action={
            mayCreate && (
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Set the first one
              </button>
            )
          }
        >
          A goal is the outcome you want. The tasks stay exactly as they are — you just link the ones
          that move the number.
        </EmptyState>
      ) : (
        <>
          {mine.length > 0 && (
            <section className="card card-pad stack">
              <div className="row-between">
                <h2>Yours</h2>
                <span className="small muted">
                  {mine.filter((o) => o.health === 'AT_RISK' || o.health === 'OFF_TRACK').length} needing attention
                </span>
              </div>
              <div className="stack-sm">
                {mine.map((objective) => (
                  <ObjectiveRow key={objective.id} objective={objective} />
                ))}
              </div>
            </section>
          )}

          {company.length > 0 && (
            <section className="card card-pad stack">
              <h2>Company-wide</h2>
              <div className="stack-sm">
                {company.map((objective) => (
                  <ObjectiveRow key={objective.id} objective={objective} />
                ))}
              </div>
            </section>
          )}

          {byDepartment.length > 0 && (
            <section className="card card-pad stack">
              <h2>By department</h2>
              <div className="stack-sm">
                {byDepartment.map((objective) => (
                  <ObjectiveRow key={objective.id} objective={objective} />
                ))}
              </div>
            </section>
          )}

          {objectives.length === 0 && (
            <EmptyState title={`Nothing is ${health(healthFilter).label.toLowerCase()} right now`} />
          )}

          <div className="grid-2" style={{ alignItems: 'start' }}>
            <section className="card table-wrap">
              <div className="card-head">
                <h2>Where the goals sit</h2>
              </div>
              <table className="data">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th className="num">Goals</th>
                    <th className="num">Needing attention</th>
                    <th className="num">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_department.map((row) => (
                    <tr key={row.department_id ?? 'company'}>
                      <td>
                        <span className="row">
                          {row.color && <span className="stat-accent" style={{ background: row.color }} />}
                          {row.name}
                        </span>
                      </td>
                      <td className="num tnum">{row.count}</td>
                      <td className="num tnum" style={{ color: row.at_risk ? 'var(--critical-text)' : 'inherit' }}>
                        {row.at_risk}
                      </td>
                      <td className="num tnum">
                        {row.progress_percent === null ? '—' : `${row.progress_percent}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card card-pad stack">
              <h2>Finishing soon</h2>
              {data.upcoming.length === 0 ? (
                <div className="small muted">Nothing lands in the next month.</div>
              ) : (
                <div className="stack-sm">
                  {data.upcoming.map((objective) => {
                    const meta = health(objective.health);
                    return (
                      <Link key={objective.id} to={`/goals/${objective.id}`} className="link-row">
                        <span className="stat-accent" style={{ background: meta.color }} />
                        <span className="grow truncate">{objective.title}</span>
                        <span className="small muted">{daysLeftLabel(objective.end_date)}</span>
                        <span className="small tnum" style={{ fontWeight: 650 }}>
                          {objective.progress_percent === null ? '—' : `${objective.progress_percent}%`}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {creating && (
        <ObjectiveWizard
          parentOptions={data.objectives.filter((o) => o.scope_type === 'COMPANY')}
          onClose={() => setCreating(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
