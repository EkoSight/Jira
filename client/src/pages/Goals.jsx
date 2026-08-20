import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from '../components/ui.jsx';
import { ProgressRing, Sparkline } from '../components/charts.jsx';
import ObjectiveWizard from '../components/ObjectiveWizard.jsx';
import AttentionPanel, { PeopleBehind } from '../components/AttentionPanel.jsx';
import { HEALTH_META, daysLeftLabel, health, periodPresets, STATUS_LABEL } from '../lib/okr.js';
import { formatDate } from '../lib/format.js';

/** How many cards a team shows before "View all". */
const PREVIEW = 4;

/**
 * The band across the top: where we are, whether we are moving, and what all of
 * it is in aid of.
 */
function Destination({ summary, momentum, destination }) {
  const pillars = destination?.pillars || [];
  const checkIns = (momentum || []).reduce((sum, week) => sum + (Number(week.value) || 0), 0);
  return (
    <section className="goal-hero-band">
      <div className="ghb-cell">
        <span className="ghb-icon" style={{ background: 'var(--brand-wash)', color: 'var(--brand-ink)' }}>
          <Icon name="target" size={18} />
        </span>
        <div>
          <div className="ghb-label">Overall progress</div>
          <div className="row" style={{ gap: 10 }}>
            <div className="ghb-value tnum">
              {summary.overall_progress === null ? '—' : `${summary.overall_progress}%`}
            </div>
            <ProgressRing percent={summary.overall_progress} size={44} stroke={4.5} showValue={false} />
          </div>
          <div className="ghb-note">across all goals</div>
        </div>
      </div>

      <div className="ghb-cell">
        <span className="ghb-icon" style={{ background: 'var(--good-wash)', color: 'var(--good-text)' }}>
          <Icon name="check" size={18} />
        </span>
        <div>
          <div className="ghb-label">Active goals</div>
          <div className="row" style={{ gap: 10 }}>
            <div className="ghb-value tnum">{summary.active ?? summary.total}</div>
            <Sparkline data={momentum || []} />
          </div>
          {/* the sparkline is the shape of that number, so name the number */}
          <div className="ghb-note">
            {checkIns} check-in{checkIns === 1 ? '' : 's'} in the last 8 weeks
          </div>
        </div>
      </div>

      {destination?.line && (
        <div className="ghb-cell ghb-destination">
          <span className="ghb-icon ghb-icon-plain">
            <Icon name="target" size={18} />
          </span>
          <div>
            <div className="ghb-label">Our destination</div>
            <div className="ghb-sentence">
              {destination.line}
              {pillars.length > 0 && ' '}
              {pillars.map((word, index) => (
                <span key={word}>
                  <strong>{word}</strong>
                  {index < pillars.length - 2 ? ', ' : index === pillars.length - 2 ? ' and ' : '.'}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** One goal, as a card. */
function GoalCard({ objective }) {
  const meta = health(objective.health);
  const keyResults = objective.key_results || [];
  // the single most important company goal, called out
  const isNorthStar = objective.scope_type === 'COMPANY' && objective.priority === 'critical';

  return (
    <Link to={`/goals/${objective.id}`} className="goal-card">
      {isNorthStar && (
        <span className="goal-northstar">
          <Icon name="trophy" size={11} /> North Star
        </span>
      )}

      <div className="goal-card-top">
        <div className="grow" style={{ minWidth: 0 }}>
          <h3 className="goal-card-title">{objective.title}</h3>
          {objective.description && (
            <p className="goal-card-outcome">
              <span className="muted">Outcome:</span> {objective.description}
            </p>
          )}
        </div>
        <div className="goal-card-ring">
          <ProgressRing
            percent={objective.progress_percent}
            color={meta.color}
            size={52}
            muted={objective.progress_percent === null}
          />
          <span className="goal-card-krcount">
            {objective.key_result_count} Key Result{objective.key_result_count === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="goal-card-foot">
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <Avatar name={objective.owner_name || '?'} color={objective.owner_color} size={20} />
          <span className="small truncate">{objective.owner_name}</span>
        </span>
        <span className="row small muted" style={{ gap: 5 }}>
          <Icon name="clock" size={12} />
          {formatDate(objective.end_date)}
        </span>
      </div>

      <div className="goal-card-pips" title={`${keyResults.length} key results`}>
        {keyResults.map((kr) => (
          <span
            key={kr.id}
            className="goal-pip"
            style={{ background: health(kr.health).color }}
            title={`${kr.title} — ${health(kr.health).label}`}
          />
        ))}
        {objective.status !== 'ACTIVE' && (
          <Badge tone="neutral" title="Status">{STATUS_LABEL[objective.status]}</Badge>
        )}
        <span className="grow" />
        <span className="small muted">{daysLeftLabel(objective.end_date)}</span>
      </div>
    </Link>
  );
}

/** A team's goals, behind its name and purpose. */
function GoalGroup({ group }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.objectives : group.objectives.slice(0, PREVIEW);
  const more = group.objectives.length - PREVIEW;

  return (
    <section className="goal-group">
      <header className="goal-group-head">
        <span className="goal-group-tile" style={{ background: group.color || 'var(--brand)' }}>
          {group.isCompany ? <Icon name="target" size={14} /> : group.key || group.name.slice(0, 2).toUpperCase()}
        </span>
        <h2 className="goal-group-name">{group.name}</h2>
        {group.purpose && (
          <span className="goal-group-purpose truncate">
            <span className="muted">Purpose:</span> {group.purpose}
          </span>
        )}
        <span className="grow" />
        {more > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : `View all (${group.objectives.length})`}
            <Icon name="chevron" size={13} />
          </button>
        )}
      </header>

      <div className="goal-grid">
        {shown.map((objective) => (
          <GoalCard key={objective.id} objective={objective} />
        ))}
      </div>
    </section>
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
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const range = presets.find((p) => p.key === period);

  const load = () => {
    setLoading(true);
    const filters = {
      from: range?.start_date,
      to: range?.end_date,
      department_id: departmentId || undefined,
      owner_id: ownerId || undefined,
      status: status || undefined,
    };
    api
      .goalsDashboard(filters)
      .then(setData)
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
    api.goalInsights(filters).then(setInsights).catch(() => setInsights(null));
  };

  useEffect(load, [period, departmentId, ownerId, status]);

  const runScan = async () => {
    try {
      const result = await api.runGoalScan();
      toast.success(
        result.notified?.length
          ? `Reminded ${result.notified.length} ${result.notified.length === 1 ? 'person' : 'people'}`
          : 'Everyone up to date has already been reminded today',
      );
    } catch (err) {
      toast.error(err);
    }
  };

  if (loading && !data) return <Spinner label="Pulling the goals together" />;
  if (!data) return <EmptyState title="Could not load the goals" />;

  const objectives = healthFilter
    ? data.objectives.filter((o) => o.health === healthFilter)
    : data.objectives;

  // company first, then each department in the order the department list defines
  const groups = [];
  const company = objectives.filter((o) => o.scope_type === 'COMPANY');
  if (company.length) {
    groups.push({
      id: 'company',
      name: 'Company-wide',
      purpose: 'The goals the whole business is judged on.',
      color: 'var(--brand)',
      isCompany: true,
      objectives: company,
    });
  }
  const seen = new Map();
  for (const objective of objectives) {
    if (objective.scope_type === 'COMPANY') continue;
    const key = objective.department_id;
    if (!seen.has(key)) {
      seen.set(key, {
        id: key,
        name: objective.department_name || 'No department',
        purpose: objective.department_purpose,
        color: objective.department_color,
        key: objective.department_key,
        objectives: [],
      });
    }
    seen.get(key).objectives.push(objective);
  }
  // teams appear in the order the department list defines, not the order their
  // goals happened to load in
  const order = new Map(departments.map((d, index) => [d.id, index]));
  groups.push(
    ...[...seen.values()].sort(
      (a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999),
    ),
  );

  const mayCreate = can('okr.create.company') || can('okr.create.department');

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row-between wrap">
        <div>
          <h1>Goals</h1>
          <div className="small muted">The direction of the company, organized by team.</div>
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
        <select className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {['ACTIVE', 'DRAFT', 'ON_HOLD', 'COMPLETED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <option value="">Any owner</option>
          <option value={user.id}>Mine</option>
          {data.by_owner
            .filter((o) => o.owner_user_id !== user.id)
            .map((o) => (
              <option key={o.owner_user_id} value={o.owner_user_id}>{o.name}</option>
            ))}
        </select>
        {healthFilter && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setHealthFilter('')}>
            Clear “{health(healthFilter).label}”
          </button>
        )}
      </div>

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
          <Destination
            summary={data.summary}
            momentum={data.momentum}
            destination={data.destination}
          />

          <div className="health-chips">
            {['ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETED', 'NOT_STARTED'].map((key) => {
              const meta = HEALTH_META[key];
              const count = data.objectives.filter((o) => o.health === key).length;
              if (!count) return null;
              const active = healthFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`health-chip${active ? ' is-active' : ''}`}
                  onClick={() => setHealthFilter(active ? '' : key)}
                >
                  <span className="goal-pip" style={{ background: meta.color }} />
                  {meta.label}
                  <span className="tnum" style={{ fontWeight: 700 }}>{count}</span>
                </button>
              );
            })}
          </div>

          <AttentionPanel insights={insights} onRunScan={runScan} canScan={can('settings.manage')} />

          {groups.length === 0 ? (
            <EmptyState title={`Nothing is ${health(healthFilter).label.toLowerCase()} right now`} />
          ) : (
            groups.map((group) => <GoalGroup key={group.id} group={group} />)
          )}

          {insights?.by_person?.length > 0 && <PeopleBehind people={insights.by_person} />}
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
