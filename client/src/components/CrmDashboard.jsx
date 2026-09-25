import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Icon, Spinner } from './ui.jsx';
import { exactMoney, formatMoney, modelLabel, VALUE_BASIS_LABEL } from '../lib/crm.js';
import { formatDate, monthKey, monthLabel } from '../lib/format.js';

/**
 * The pipeline from above.
 *
 * Two rules the whole screen is built on.
 *
 * Every figure carries its definition and its date basis. A number nobody can
 * interrogate is a number nobody trusts, and "wins this month" and "pipeline
 * right now" answer different questions — so they sit in different blocks and are
 * never added together.
 *
 * Every figure is a way in. A count with no route to the records behind it tells
 * you something is wrong and leaves you unable to do anything about it.
 */

const BASIS_NOTE = {
  now: 'as things stand right now',
  month: 'what happened during the month',
  all: 'everything on record',
};

function Metric({ id, definitions, value, sub, tone, onClick }) {
  const definition = definitions?.[id];
  const [open, setOpen] = useState(false);
  const Tag = onClick ? 'button' : 'div';

  return (
    <div className={`metric${tone ? ` metric-${tone}` : ''}`}>
      <Tag
        type={onClick ? 'button' : undefined}
        className="metric-main"
        onClick={onClick}
        title={onClick ? 'Show the records behind this' : undefined}
      >
        <span className="metric-label">
          {definition?.label || id}
          {definition?.basis && (
            <span className="metric-basis">{definition.basis === 'now' ? 'now' : definition.basis}</span>
          )}
        </span>
        <span className="metric-value tnum">{value}</span>
        {sub && <span className="metric-sub small muted">{sub}</span>}
      </Tag>
      {definition?.detail && (
        <>
          <button type="button" className="metric-def-toggle" aria-expanded={open}
            onClick={() => setOpen(!open)}>
            what this counts
          </button>
          {open && (
            <div className="metric-def small">
              {definition.detail}
              <div className="muted">Basis: {BASIS_NOTE[definition.basis] || definition.basis}.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StageBars({ byStage, currency }) {
  const max = Math.max(1, ...byStage.map((s) => s.eligible));
  if (byStage.length === 0) return <p className="small muted">No open deals to break down.</p>;

  return (
    <div className="stack-sm">
      {byStage.map((stage) => (
        <div key={stage.slug} className="stage-bar-row">
          <span className="stage-bar-label small">
            <span className="badge-dot" style={{ background: stage.color }} />
            {stage.name}
          </span>
          <span className="stage-bar-track">
            <span className="stage-bar-fill"
              style={{ width: `${(stage.eligible / max) * 100}%`, background: stage.color }} />
            {/* the same colour, solid, so it reads the same way in either theme */}
            <span className="stage-bar-weighted"
              style={{ width: `${(stage.weighted / max) * 100}%`, background: stage.color }} />
          </span>
          <span className="small tnum stage-bar-value">
            {stage.count} · {formatMoney(stage.eligible, currency) || '—'}
          </span>
        </div>
      ))}
      <div className="small muted">
        The pale bar is the eligible value; the solid bar inside it is that same value weighted by
        the stage's probability. Deals with no value recorded contribute nothing to either.
      </div>
    </div>
  );
}

export default function CrmDashboard({ departmentId, ownerId, segmentId }) {
  const toast = useToast();
  const { can } = useAuth();
  const [month, setMonth] = useState(() => monthKey());
  const [data, setData] = useState(null);
  const [people, setPeople] = useState(null);
  const [drill, setDrill] = useState(null);

  useEffect(() => {
    setData(null);
    api.crmDashboard({
      month,
      department_id: departmentId || undefined,
      owner_id: ownerId || undefined,
      segment_id: segmentId || undefined,
    }).then(setData).catch((err) => toast.error(err));
  }, [month, departmentId, ownerId, segmentId]);

  useEffect(() => {
    if (!can('report.view')) return;
    setPeople(null);
    api.crmPeople({ month, department_id: departmentId || undefined })
      .then(setPeople).catch(() => setPeople({ summaries: [] }));
  }, [month, departmentId, can]);

  if (!data) return <Spinner label="Working out the numbers" />;

  const { portfolio, activity, definitions } = data;
  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - index);
    return monthKey(date);
  });

  return (
    <div className="stack">
      <div className="row-between wrap">
        <div>
          <h2>Where the pipeline stands</h2>
          <div className="small muted">
            Every figure says what it counts and from when. Nothing here is added across the two
            blocks — one is now, the other is a month.
          </div>
        </div>
        <select className="select" style={{ width: 'auto' }} value={month}
          onChange={(e) => setMonth(e.target.value)}>
          {months.map((key) => <option key={key} value={key}>{monthLabel(key)}</option>)}
        </select>
      </div>

      <section className="card card-pad stack">
        <div className="row-between wrap">
          <h3>As things stand</h3>
          <span className="small muted">not tied to {monthLabel(data.month)}</span>
        </div>
        <div className="metric-grid">
          <Metric id="open_opportunities" definitions={definitions}
            value={portfolio.open_opportunities}
            sub={`across ${portfolio.organizations} organization${portfolio.organizations === 1 ? '' : 's'}`}
            onClick={() => setDrill({ title: 'Open deals closing soonest', rows: data.closing_soon })} />
          <Metric id="eligible_pipeline" definitions={definitions}
            value={formatMoney(portfolio.eligible_pipeline) || '—'}
            sub={portfolio.without_value > 0
              ? `${portfolio.without_value} deal${portfolio.without_value === 1 ? '' : 's'} with no value — not counted, not zeroed`
              : 'every open deal has a value'} />
          <Metric id="weighted_forecast" definitions={definitions}
            value={formatMoney(portfolio.weighted_forecast) || '—'}
            sub="an estimate, not a prediction" />
          <Metric id="closing_soon" definitions={definitions}
            value={portfolio.closing_soon}
            sub={portfolio.closing_soon === 0
              ? 'nothing inside 30 days'
              : formatMoney(portfolio.closing_soon_value) || 'no value recorded'}
            tone={portfolio.closing_soon > 0 ? 'brand' : undefined}
            onClick={() => setDrill({ title: 'Closing inside 30 days', rows: data.closing_soon })} />
          <Metric id="overdue_next_actions" definitions={definitions}
            value={portfolio.overdue_next_actions}
            tone={portfolio.overdue_next_actions > 0 ? 'warning' : undefined} />
          <Metric id="missing_next_action" definitions={definitions}
            value={portfolio.missing_next_action}
            tone={portfolio.missing_next_action > 0 ? 'warning' : undefined} />
          <Metric id="unresolved_blockers" definitions={definitions}
            value={portfolio.unresolved_blockers}
            tone={portfolio.unresolved_blockers > 0 ? 'warning' : undefined} />
          <Metric id="engagements_attention" definitions={definitions}
            value={`${portfolio.engagements_attention} of ${portfolio.engagements_live}`}
            sub="live delivery"
            tone={portfolio.engagements_attention > 0 ? 'warning' : undefined}
            onClick={data.engagements_attention.length
              ? () => setDrill({ title: 'Delivery needing attention', engagements: data.engagements_attention })
              : undefined} />
        </div>
      </section>

      <section className="card card-pad stack">
        <div className="row-between wrap">
          <h3>What happened in {monthLabel(data.month)}</h3>
          <span className="small muted">
            {formatDate(data.period.start)} to {formatDate(data.period.end)}
          </span>
        </div>
        <div className="metric-grid">
          <Metric id="won_this_month" definitions={definitions} value={activity.won}
            sub={formatMoney(activity.value_won) || 'no agreed amounts recorded'} />
          <Metric id="lost_this_month" definitions={definitions} value={activity.lost} />
          <Metric id="value_won" definitions={definitions}
            value={formatMoney(activity.value_won) || '—'}
            sub="signed, not collected" />
          <Metric id="value_collected" definitions={definitions}
            value={formatMoney(activity.value_collected) || '—'}
            sub="entered by hand — TaskFlow has no accounting feed" />
          <Metric id="demos_completed" definitions={definitions} value={activity.demos_completed}
            sub={activity.meetings_awaiting_outcome > 0
              ? `${activity.meetings_awaiting_outcome} meeting${activity.meetings_awaiting_outcome === 1 ? '' : 's'} still with no outcome recorded`
              : 'every past meeting has an outcome'}
            tone={activity.meetings_awaiting_outcome > 0 ? 'warning' : undefined} />
          <Metric id="meetings_completed" definitions={definitions} value={activity.meetings_completed}
            sub={`${activity.meetings_upcoming} coming up`} />
          <Metric id="conversations" definitions={definitions} value={activity.conversations}
            sub={activity.attempts > 0
              ? `${activity.attempts} attempt${activity.attempts === 1 ? '' : 's'} that did not connect — counted apart`
              : 'no unanswered attempts'} />
          <Metric id="proposals_shared" definitions={definitions} value={activity.proposals_shared}
            sub="recorded as sent by a person" />
        </div>
      </section>

      <section className="card card-pad stack">
        <h3>Where the open value sits</h3>
        <StageBars byStage={data.by_stage} />
      </section>

      {people && people.summaries?.length > 0 && (
        <section className="card card-pad stack">
          <div>
            <h3>Per person, in {monthLabel(people.month)}</h3>
            <div className="small muted">
              Attributed to whoever was recorded as doing the thing. A blank row says nothing is on
              file — which is a statement about the record, not about the person.
            </div>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Open</th>
                  <th>Won</th>
                  <th>Lost</th>
                  <th>Signed</th>
                  <th>Conversations</th>
                  <th>Demos</th>
                  <th>Sent</th>
                  <th>Overdue</th>
                </tr>
              </thead>
              <tbody>
                {people.summaries.map((row) => (
                  <tr key={row.user.id} className={row.nothing_recorded ? 'is-quiet-row' : ''}>
                    <td>
                      <Link to={`/team/${row.user.id}`} className="row" style={{ gap: 6 }}>
                        <Avatar name={row.user.full_name} color={row.user.avatar_color} size={22} />
                        <span className="small">{row.user.full_name}</span>
                      </Link>
                      {row.nothing_recorded && (
                        <div className="small muted">nothing recorded this month</div>
                      )}
                    </td>
                    <td className="tnum">{row.metrics.open_deals}</td>
                    <td className="tnum">{row.metrics.won}</td>
                    <td className="tnum">{row.metrics.lost}</td>
                    <td className="tnum">{formatMoney(row.metrics.value_won) || '—'}</td>
                    <td className="tnum">
                      {row.metrics.conversations}
                      {row.metrics.attempts > 0 && (
                        <span className="muted small"> (+{row.metrics.attempts} tried)</span>
                      )}
                    </td>
                    <td className="tnum">{row.metrics.demos_completed}</td>
                    <td className="tnum">{row.metrics.proposals_shared}</td>
                    <td className="tnum">
                      {row.metrics.overdue_tasks > 0
                        ? <Badge tone="warning">{row.metrics.overdue_tasks}</Badge>
                        : '0'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {drill && (
        <section className="card card-pad stack">
          <div className="row-between">
            <h3>{drill.title}</h3>
            <button type="button" className="btn btn-sm" onClick={() => setDrill(null)}>Close</button>
          </div>
          {drill.rows?.length > 0 && (
            <ul className="plain-list">
              {drill.rows.map((row) => (
                <li key={row.id} className="row" style={{ gap: 8 }}>
                  <Link to={`/accounts/${row.account_id}`} className="btn-link grow truncate">
                    {row.name}
                  </Link>
                  <span className="small muted">{row.account_name}</span>
                  <Badge dot={row.stage_color}>{row.stage_name}</Badge>
                  <span className="small tnum">
                    {row.eligible_value === null
                      ? VALUE_BASIS_LABEL[row.eligible_basis]
                      : exactMoney(row.eligible_value, row.currency)}
                  </span>
                  {row.expected_close && (
                    <Badge tone={row.close_overdue ? 'critical' : 'neutral'}>
                      {formatDate(row.expected_close)}
                    </Badge>
                  )}
                  <span className="small muted">{modelLabel(row.engagement_model)}</span>
                </li>
              ))}
            </ul>
          )}
          {drill.engagements?.length > 0 && (
            <ul className="plain-list">
              {drill.engagements.map((row) => (
                <li key={row.id} className="row" style={{ gap: 8 }}>
                  <Link to={`/accounts/${row.account_id}`} className="btn-link grow truncate">
                    {row.name}
                  </Link>
                  <span className="small muted">{row.account_name}</span>
                  <Badge tone={row.state === 'AT_RISK' ? 'danger' : 'neutral'}>
                    {row.state.replaceAll('_', ' ').toLowerCase()}
                  </Badge>
                  {row.milestone_overdue > 0 && (
                    <Badge tone="warning">{row.milestone_overdue} overdue</Badge>
                  )}
                  {row.milestone_blocked > 0 && (
                    <Badge tone="critical">{row.milestone_blocked} blocked</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!drill.rows?.length && !drill.engagements?.length && (
            <EmptyState title="Nothing behind this figure">
              <Icon name="check" size={14} /> Which is the good outcome.
            </EmptyState>
          )}
        </section>
      )}
    </div>
  );
}
