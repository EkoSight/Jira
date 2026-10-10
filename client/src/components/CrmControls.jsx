import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, downloadFile } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Spinner } from './ui.jsx';
import EscalateDialog from './EscalateDialog.jsx';
import { exactMoney, financialPeriod, formatMoney, todayInIndia } from '../lib/crm.js';
import { WORKLOAD_STATUS, formatDate, loadSummary } from '../lib/format.js';

/**
 * Reporting and controls for the pipeline.
 *
 *   Data quality — what is missing or inconsistent, deal by deal, and who can fix it.
 *   Workload — what each person owes and what is blocked, and what needs taking higher.
 *   Investor summary — only what the record supports, estimates marked, no contact details.
 *   Audit history — who changed stage, value or owner, from what, to what, and why.
 */

const SEVERITY_TONE = { critical: 'critical', warning: 'warning', info: 'neutral' };

/** Where an item opens: its deal, its organization, or its task's organization. */
function useOpen() {
  const navigate = useNavigate();
  return (item) => {
    if (!item.account_id) return;
    navigate(`/accounts/${item.account_id}${item.opportunity_id ? `?deal=${item.opportunity_id}` : ''}`);
  };
}

// ================================================================ data quality

function DuplicateCluster({ item, canDismiss, onDismissed }) {
  const toast = useToast();
  const open = useOpen();
  const [pair, setPair] = useState(null);
  const [reason, setReason] = useState('');
  const pairs = [];
  for (let i = 0; i < item.accounts.length; i += 1) {
    for (let j = i + 1; j < item.accounts.length; j += 1) pairs.push([item.accounts[i], item.accounts[j]]);
  }

  const dismiss = async () => {
    try {
      await api.dismissDuplicate(pair.map((a) => a.id), reason.trim());
      toast.success(`${pair[0].name} and ${pair[1].name} are kept apart from now on`);
      setPair(null);
      setReason('');
      onDismissed();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="dq-item">
      <div className="grow stack-sm" style={{ gap: 4 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          {item.accounts.map((a, index) => (
            <span key={a.id} className="row" style={{ gap: 6 }}>
              {index > 0 && <span className="muted">·</span>}
              <button type="button" className="btn-link" onClick={() => open({ account_id: a.id })}>{a.name}</button>
              <span className="small muted">{a.deals} deal{a.deals === 1 ? '' : 's'}{a.owner_name ? ` · ${a.owner_name}` : ''}</span>
            </span>
          ))}
        </div>
        <div className="small muted">{item.detail}</div>
        {pair && (
          <div className="row wrap" style={{ gap: 6 }}>
            <input className="input" style={{ maxWidth: 360 }} autoFocus value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={`How do you know ${pair[0].name} and ${pair[1].name} are different?`} />
            <button type="button" className="btn btn-sm btn-primary" onClick={dismiss} disabled={reason.trim().length < 5}>Keep them apart</button>
            <button type="button" className="btn btn-sm" onClick={() => setPair(null)}>Cancel</button>
          </div>
        )}
      </div>
      {canDismiss && !pair && (
        <select className="select select-sm" value="" aria-label="Mark two of these as different organizations"
          onChange={(e) => e.target.value !== '' && setPair(pairs[Number(e.target.value)])}>
          <option value="">These are different…</option>
          {pairs.map(([a, b], index) => <option key={`${a.id}-${b.id}`} value={index}>{a.name} ≠ {b.name}</option>)}
        </select>
      )}
    </div>
  );
}

function QualityCheck({ check, expanded, onToggle, canDismiss, onChanged }) {
  const open = useOpen();
  const passing = check.count === 0;
  return (
    <section className={`card dq-check dq-${passing ? 'pass' : check.severity}`}>
      <button type="button" className="dq-head" onClick={onToggle} aria-expanded={expanded} disabled={passing}>
        <span className="grow">
          <span className="dq-title">{check.label}</span>
          {!passing && <span className="small muted dq-why">{check.why}</span>}
        </span>
        {passing
          ? <Badge tone="good"><Icon name="check" size={10} /> none</Badge>
          : <Badge tone={SEVERITY_TONE[check.severity]}>{check.count}</Badge>}
        {!passing && <Icon name="chevron" size={12} style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />}
      </button>
      {expanded && !passing && (
        <div className="dq-body stack-sm">
          <div className="small"><strong>To fix:</strong> {check.fix}</div>
          {check.items.map((item) => (item.entity_type === 'ACCOUNT_GROUP' ? (
            <DuplicateCluster key={`dup-${item.entity_id}`} item={item} canDismiss={canDismiss} onDismissed={onChanged} />
          ) : (
            <div key={`${item.entity_type}-${item.entity_id}`} className="dq-item">
              <div className="grow" style={{ minWidth: 0 }}>
                <button type="button" className="btn-link" onClick={() => open(item)}>{item.title}</button>
                {item.subtitle && item.subtitle !== item.title && <span className="small muted"> · {item.subtitle}</span>}
                {item.stage_name && <span className="small muted"> · {item.stage_name}</span>}
                <div className="small">{item.detail}</div>
              </div>
              <span className="small muted dq-owner">
                {item.owner_name ? `${item.owner_name} can fix it` : 'nobody named to fix it'}
              </span>
            </div>
          )))}
          {check.truncated && <div className="small muted">Showing the first {check.items.length} of {check.count}.</div>}
        </div>
      )}
    </section>
  );
}

export function DataQuality() {
  const { can } = useAuth();
  const toast = useToast();
  const [mine, setMine] = useState(false);
  const [taskDays, setTaskDays] = useState(90);
  const [report, setReport] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(() => {
    api.dataQuality({ mine: mine ? 'true' : undefined, task_days: taskDays })
      .then((r) => {
        setReport(r);
        setExpanded((current) => current ?? r.checks.find((c) => c.count > 0)?.key ?? null);
      })
      .catch((err) => toast.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, taskDays]);
  useEffect(() => { setReport(null); load(); }, [load]);

  if (!report) return <Spinner label="Checking the pipeline" />;
  const failing = report.checks.filter((c) => c.count > 0);
  const passing = report.checks.filter((c) => c.count === 0);
  const pct = report.summary.clean_percent;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-between wrap" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 6 }} role="group" aria-label="Whose records">
          <button type="button" className={`kind-chip${!mine ? ' is-active' : ''}`} onClick={() => setMine(false)}>Everything</button>
          <button type="button" className={`kind-chip${mine ? ' is-active' : ''}`} onClick={() => setMine(true)}>What I can fix</button>
        </div>
        <label className="row small" style={{ gap: 6 }}>
          <span className="muted">Finished tasks from the last</span>
          <select className="select select-sm" value={taskDays} onChange={(e) => setTaskDays(Number(e.target.value))}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>year</option>
          </select>
        </label>
      </div>

      <section className="card card-pad dq-summary">
        <div className="dq-score">
          <span className="dq-score-value tnum">{pct === null ? '—' : `${pct}%`}</span>
          <span className="small muted">of live deals have nothing missing</span>
        </div>
        <div className="small">
          <strong className="tnum">{report.summary.clean_deals}</strong> of <strong className="tnum">{report.summary.live_deals}</strong> live deals are complete.
          {' '}{failing.length ? `${failing.length} check${failing.length === 1 ? '' : 's'} found something — ${report.summary.issues} in all.` : 'Every check passes.'}
          <div className="muted">Nothing here changes data. Each item opens where it can be fixed.</div>
        </div>
      </section>

      {failing.map((check) => (
        <QualityCheck key={check.key} check={check} expanded={expanded === check.key}
          onToggle={() => setExpanded(expanded === check.key ? null : check.key)}
          canDismiss={can('crm.manage.any')} onChanged={load} />
      ))}
      {passing.length > 0 && (
        <div className="stack-sm">
          <div className="stat-label">Passing</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {passing.map((check) => (
              <span key={check.key} className="kind-chip is-static"><Icon name="check" size={10} /> {check.label}</span>
            ))}
          </div>
        </div>
      )}
      <div className="small muted">Checked {formatDate(report.as_of, { withTime: true })}.</div>
    </div>
  );
}

// ================================================================ workload

const ITEM_KIND = {
  next_action: 'Next action', task: 'Task', meeting_outcome: 'Meeting', handover: 'Handover',
  commitment: 'Their commitment', blocker: 'Blocker', blocked_task: 'Blocked task',
};

function WorkItem({ item, todayDate }) {
  const open = useOpen();
  const late = item.due && item.due < todayDate;
  return (
    <div className={`work-item${late ? ' is-late' : ''}`}>
      <span className="work-kind">{ITEM_KIND[item.kind] || item.kind}</span>
      <span className="grow" style={{ minWidth: 0 }}>
        {item.account_id
          ? <button type="button" className="btn-link work-title" onClick={() => open(item)}>{item.title}</button>
          : <span className="work-title">{item.title}</span>}
        <span className="small muted">
          {[item.deal, item.account_name].filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join(' · ')}
          {item.on ? ` · on ${item.on}` : ''}
          {item.why ? ` · ${item.why}` : ''}
          {item.waiting ? ' · waiting on purpose' : ''}
        </span>
      </span>
      {item.due && <span className={`small tnum ${late ? 'work-late' : 'muted'}`}>{late ? 'was due ' : ''}{formatDate(item.due)}</span>}
    </div>
  );
}

function PersonLoad({ person, todayDate }) {
  const [showWeek, setShowWeek] = useState(false);
  const state = person.capacity ? WORKLOAD_STATUS[person.capacity.status] : null;
  const pressing = [...person.due.overdue, ...person.due.today];
  const mineBlocked = person.blocked.filter((b) => b.mine !== false);
  return (
    <section className="card card-pad stack-sm person-load">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <span className="row" style={{ gap: 8 }}>
          <Avatar name={person.user.full_name} color={person.user.avatar_color} size={26} />
          <span>
            <strong>{person.user.full_name}</strong>
            {person.user.department && <span className="small muted"> · {person.user.department}</span>}
          </span>
          {person.away_today && (
            <Badge tone="warning">away until {formatDate(person.away_today.back_on || person.away_today.end_date)}</Badge>
          )}
        </span>
        {state && (
          <span className="row small" style={{ gap: 6 }} title={state.note}>
            <Badge tone={state.tone}>{state.label}</Badge>
            <span className="muted">{loadSummary(person.capacity)}</span>
          </span>
        )}
      </div>
      <div className="load-counts small">
        <span className={person.counts.overdue ? 'work-late' : ''}><strong className="tnum">{person.counts.overdue}</strong> overdue</span>
        <span><strong className="tnum">{person.counts.today}</strong> due today</span>
        <span><strong className="tnum">{person.counts.this_week}</strong> later this week</span>
        <span className={person.counts.blocked ? 'work-blocked' : ''}><strong className="tnum">{person.counts.blocked}</strong> blocked</span>
        <span className="muted" title="Outcome, not effort: forward stage moves this week on deals they own">
          {person.moved_forward_this_week} moved forward this week
        </span>
      </div>
      {person.leave_ahead.filter((l) => !person.away_today || l.start_date !== person.away_today.start_date).slice(0, 2).map((l) => (
        <div key={`${l.start_date}-${l.status}`} className="small muted">
          <Icon name="clock" size={11} /> {l.status === 'HALF_DAY' ? 'Half day' : 'Away'} {formatDate(l.start_date)}{l.end_date !== l.start_date ? ` – ${formatDate(l.end_date)}` : ''}
        </div>
      ))}
      {pressing.map((item, index) => <WorkItem key={`p-${index}`} item={item} todayDate={todayDate} />)}
      {mineBlocked.map((item, index) => <WorkItem key={`b-${index}`} item={item.kind === 'blocker' ? item : { ...item, kind: 'blocked_task' }} todayDate={todayDate} />)}
      {person.due.this_week.length > 0 && (
        <>
          <button type="button" className="disclosure" onClick={() => setShowWeek((v) => !v)}>
            <Icon name="chevron" size={12} style={{ transform: showWeek ? 'rotate(90deg)' : 'none' }} />
            Later this week ({person.due.this_week.length})
          </button>
          {showWeek && person.due.this_week.map((item, index) => <WorkItem key={`w-${index}`} item={item} todayDate={todayDate} />)}
        </>
      )}
      {!pressing.length && !mineBlocked.length && !person.due.this_week.length && (
        <div className="small muted">Nothing due this week or blocked.</div>
      )}
    </section>
  );
}

export function PipelineWorkload() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [escalating, setEscalating] = useState(null);

  const load = useCallback(() => {
    api.pipelineWorkload().then(setData).catch((err) => toast.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  if (!data) return <Spinner label="Working out who owes what" />;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="callout is-quiet small">
        <Icon name="alert" />
        <span>
          Counts say how much is on someone’s plate, not how well they are doing — outcomes are on <strong>This week</strong>.
          People are listed by name, never ranked. Open work with no estimate is shown as capacity not known, never as spare time.
        </span>
      </div>

      <section className="card card-pad stack-sm">
        <div className="row-between wrap">
          <h3>Needs taking higher ({data.escalations.length})</h3>
          <span className="small muted">Next actions or customer commitments {data.escalate_after_days}+ days late, blockers past their date, unconfirmed handovers, and work owed by someone on leave</span>
        </div>
        {data.escalations.length === 0 ? <div className="small muted">Nothing needs escalating.</div> : data.escalations.map((item, index) => (
          <div key={index} className={`escalation-row${item.cover_needed ? ' is-cover' : ''}`}>
            <div className="grow" style={{ minWidth: 0 }}>
              <WorkItem item={item} todayDate={data.today} />
              <div className="small muted" style={{ paddingLeft: 2 }}>
                {item.reason}{item.owner_name ? ` · owed by ${item.owner_name}` : ''}
                {' · '}{item.escalate_to_name ? `escalates to ${item.escalate_to_name}` : 'no escalation point set'}
              </div>
            </div>
            {item.opportunity_id && (item.escalated_today
              ? <Badge tone="neutral">escalated today</Badge>
              : (
                <button type="button" className="btn btn-sm"
                  onClick={() => setEscalating({
                    id: item.opportunity_id, name: item.deal || item.account_name, escalation_owner_id: item.escalate_to,
                    suggested_reason: `${item.title} — ${item.reason}`,
                  })}>
                  Escalate…
                </button>
              ))}
          </div>
        ))}
      </section>

      {data.people.length === 0 && <EmptyState title="Nobody owes anything in the pipeline right now" />}
      {data.people.map((person) => (
        <PersonLoad key={person.user.id} person={person} todayDate={data.today} />
      ))}
      {escalating && <EscalateDialog deal={escalating} onClose={() => setEscalating(null)} onDone={load} />}
    </div>
  );
}

// ================================================================ the investor summary

const PRESETS = [['year', 'This financial year'], ['quarter', 'This quarter'], ['last_quarter', 'Last quarter'], ['last_year', 'Last financial year']];

const rupees = (value) => (value === null || value === undefined ? '—' : exactMoney(value));

export function InvestorSummary() {
  const toast = useToast();
  const [preset, setPreset] = useState('year');
  const [period, setPeriod] = useState(() => financialPeriod('year'));
  const [anonymise, setAnonymise] = useState(false);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    setSummary(null);
    api.investorSummary({ ...period, anonymise: anonymise ? 'true' : undefined })
      .then(setSummary).catch((err) => toast.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.from, period.to, anonymise]);

  const pick = (key) => { setPreset(key); setPeriod(financialPeriod(key)); };
  const params = { ...period, anonymise: anonymise ? 'true' : undefined };
  const download = async () => {
    try {
      await downloadFile(api.investorSummaryCsvUrl(params), `pipeline-summary-${period.from}-to-${period.to}.csv`);
    } catch (err) {
      toast.error(err);
    }
  };
  const print = async () => {
    try {
      await api.investorSummaryPrinted({ from: period.from, to: period.to, anonymise });
    } catch { /* printing still works; the record of it is best effort */ }
    // only the summary itself goes to paper
    document.body.classList.add('print-investor');
    const done = () => {
      document.body.classList.remove('print-investor');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-between wrap no-print" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          {PRESETS.map(([key, label]) => (
            <button key={key} type="button" className={`kind-chip${preset === key ? ' is-active' : ''}`} onClick={() => pick(key)}>{label}</button>
          ))}
          <button type="button" className={`kind-chip${preset === 'custom' ? ' is-active' : ''}`} onClick={() => setPreset('custom')}>Custom</button>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <label className="check small">
            <input type="checkbox" checked={anonymise} onChange={(e) => setAnonymise(e.target.checked)} /> Hide organization names
          </label>
          <button type="button" className="btn btn-sm" onClick={download} disabled={!summary}>Download CSV</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={print} disabled={!summary}>Print or save as PDF</button>
        </div>
      </div>
      {preset === 'custom' && (
        <div className="row wrap no-print" style={{ gap: 8 }}>
          <Field label="From">
            <input className="input" type="date" value={period.from} max={todayInIndia()}
              onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, from: e.target.value }))} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={period.to} max={todayInIndia()}
              onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, to: e.target.value }))} />
          </Field>
        </div>
      )}

      {!summary ? <Spinner label="Adding up what the record supports" /> : <SummaryDocument summary={summary} />}
    </div>
  );
}

function SummaryDocument({ summary }) {
  const v = summary.verified;
  const p = summary.pipeline;
  const d = summary.definitions;
  return (
    <article className="card card-pad investor-doc">
      <header className="investor-head">
        <div>
          <div className="stat-label">EkoSight</div>
          <h2>Pipeline summary</h2>
          <div className="small muted">
            {formatDate(summary.period.from)} – {formatDate(summary.period.to)} · as recorded on {formatDate(summary.as_of_date)}
          </div>
        </div>
        <div className="small muted investor-note">
          Only what the record supports. Estimates are marked. No contact details.
          {summary.anonymised ? ' Organization names hidden.' : ''}
        </div>
      </header>

      <section className="investor-section">
        <h3>Verified in the period</h3>
        <div className="metric-grid">
          <div className="metric metric-good">
            <span className="metric-label">Bookings</span>
            <span className="metric-value tnum">{rupees(v.bookings.amount)}</span>
            <span className="metric-sub small muted">{v.bookings.orders} accepted order{v.bookings.orders === 1 ? '' : 's'}{v.bookings.orders_without_amount ? ` · ${v.bookings.orders_without_amount} without an amount, not in the total` : ''}</span>
          </div>
          <div className="metric">
            <span className="metric-label">Invoiced</span>
            <span className="metric-value tnum">{rupees(v.invoiced.amount)}</span>
            <span className="metric-sub small muted">{v.invoiced.invoices} invoice{v.invoiced.invoices === 1 ? '' : 's'} · revenue billed</span>
          </div>
          <div className="metric metric-good">
            <span className="metric-label">Collections</span>
            <span className="metric-value tnum">{rupees(v.collections.amount)}</span>
            <span className="metric-sub small muted">{v.collections.payments} payment{v.collections.payments === 1 ? '' : 's'} · cash received</span>
          </div>
          <div className="metric">
            <span className="metric-label">Receivable</span>
            <span className="metric-value tnum">{rupees(v.receivable.amount)}</span>
            <span className="metric-sub small muted">invoiced, not yet collected, as of {formatDate(summary.as_of_date)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">Wins backed by an order</span>
            <span className="metric-value tnum">{v.wins.deals}</span>
          </div>
          <div className="metric">
            <span className="metric-label">Stage moves</span>
            <span className="metric-value tnum">{v.movements.forward}</span>
            <span className="metric-sub small muted">forward with evidence · {v.movements.back} back · {v.movements.new_deals} new · {v.movements.lost} lost</span>
          </div>
        </div>
      </section>

      <section className="investor-section">
        <h3>Open pipeline, {formatDate(summary.as_of_date)}</h3>
        <div className="small muted">
          {p.counted_deals} of {p.live_deals} live deals, at stages the record supports{p.paused_deals ? ` · ${p.paused_deals} paused or nurtured, not counted` : ''}.
        </div>
        <div className="table-scroll">
          <table className="data-table investor-table">
            <thead>
              <tr><th>Stage</th><th className="num">Deals</th><th className="num">Proposed</th><th className="num">Estimate <span className="estimate-tag">unverified</span></th></tr>
            </thead>
            <tbody>
              {p.by_stage.map((stage) => (
                <tr key={stage.stage}>
                  <td>{stage.stage}</td>
                  <td className="num tnum">{stage.deals}</td>
                  <td className="num tnum">{stage.proposed_deals ? exactMoney(stage.proposed) : '—'}</td>
                  <td className="num tnum estimate-cell">{stage.estimated_deals ? exactMoney(stage.estimated) : '—'}</td>
                </tr>
              ))}
              <tr className="investor-total">
                <td>Total</td>
                <td className="num tnum">{p.counted_deals}</td>
                <td className="num tnum">{exactMoney(p.proposed_total)}</td>
                <td className="num tnum estimate-cell">{exactMoney(p.estimated_total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="small muted">Proposed and estimated amounts are not commitments and are never added to bookings.</div>
      </section>

      {summary.customers.length > 0 && (
        <section className="investor-section">
          <h3>Bookings by organization</h3>
          <div className="table-scroll">
            <table className="data-table investor-table">
              <thead><tr><th>Organization</th><th className="num">Orders</th><th className="num">Booked</th></tr></thead>
              <tbody>
                {summary.customers.map((c) => (
                  <tr key={c.organization}>
                    <td>{c.organization}{c.won_in_period ? <span className="small muted"> · won in the period</span> : ''}</td>
                    <td className="num tnum">{c.orders}</td>
                    <td className="num tnum">{c.booked === null ? '—' : exactMoney(c.booked)}{c.orders_without_amount ? <span className="small muted"> +{c.orders_without_amount} unpriced</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="investor-section">
        <h3>Left out</h3>
        <ul className="investor-list small">
          {summary.excluded.map((item) => (
            <li key={item.what}>{item.what}{item.count !== null && item.count !== undefined ? ` — ${item.count}` : ''}</li>
          ))}
        </ul>
      </section>

      <section className="investor-section">
        <h3>Definitions</h3>
        <dl className="investor-defs small">
          {Object.entries(d).map(([key, text]) => (
            <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{text}</dd></div>
          ))}
        </dl>
        <div className="small muted">Amounts in Indian rupees. Prepared {formatDate(summary.as_of, { withTime: true })} from TaskFlow.</div>
      </section>
    </article>
  );
}

// ================================================================ the audit trail

const AUDIT_FILTERS = [
  ['', 'Everything'], ['stage', 'Stage'], ['status', 'Status'], ['owner', 'Owner'], ['value', 'Value'],
  ['close_date', 'Close date'], ['next_action', 'Next action'], ['escalation', 'Escalations'], ['other', 'Other'],
];

export function AuditTrail() {
  const toast = useToast();
  const { users } = useRefData();
  const open = useOpen();
  const [group, setGroup] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [more, setMore] = useState([]);

  const params = useMemo(() => ({
    group: group || undefined, actor_id: actor || undefined, from: from || undefined, to: to || undefined,
    search: search.trim() || undefined,
  }), [group, actor, from, to, search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.auditLog(params).then((r) => { setData(r); setMore([]); }).catch((err) => toast.error(err));
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const loadMore = async () => {
    try {
      const r = await api.auditLog({ ...params, offset: data.entries.length + more.length });
      setMore((m) => [...m, ...r.entries]);
    } catch (err) {
      toast.error(err);
    }
  };
  const download = async () => {
    try {
      await downloadFile(api.auditCsvUrl(params), `pipeline-audit-${todayInIndia()}.csv`);
    } catch (err) {
      toast.error(err);
    }
  };

  const entries = data ? [...data.entries, ...more] : [];
  const missingReasons = data ? Object.values(data.groups).reduce((t, g) => t + g.no_reason, 0) : 0;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        {AUDIT_FILTERS.map(([key, label]) => (
          <button key={key || 'all'} type="button" className={`kind-chip${group === key ? ' is-active' : ''}`} onClick={() => setGroup(key)}>
            {label}{data && key && data.groups[key]?.changes ? ` (${data.groups[key].changes})` : ''}
          </button>
        ))}
      </div>
      <div className="filters">
        <select className="select" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Changed by">
          <option value="">Anyone</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
        <input className="input" type="date" value={from} max={todayInIndia()} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input className="input" type="date" value={to} max={todayInIndia()} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <input className="input" style={{ maxWidth: 220 }} placeholder="Organization, deal or reason" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn btn-sm" onClick={download} disabled={!data}>Download CSV</button>
      </div>
      {data && (
        <div className="small muted">
          {data.total} change{data.total === 1 ? '' : 's'} recorded{missingReasons ? ` · ${missingReasons} replaced an earlier value with no reason given (older entries, from before reasons were asked for)` : ''}.
          History can only be added to — nothing here can be edited or removed.
        </div>
      )}
      {!data ? <Spinner label="Reading the history" /> : entries.length === 0 ? <EmptyState title="No changes match" /> : (
        <div className="card audit-list">
          {entries.map((e) => (
            <div key={e.id} className="audit-row">
              <div className="audit-when small muted tnum" title={new Date(e.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}>
                {formatDate(e.at, { withTime: true })}
              </div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="audit-what">
                  <strong>{e.what}</strong>
                  {(e.from !== null || e.to !== null) && (
                    <span>
                      {e.from !== null && <span className="muted">{shownValue(e.field, e.from)} → </span>}
                      {shownValue(e.field, e.to) ?? 'cleared'}
                    </span>
                  )}
                  {e.moved_back && <Badge tone="warning">moved back</Badge>}
                  {e.without_evidence && <Badge tone="critical">without evidence</Badge>}
                  {e.no_reason && <Badge tone="neutral">no reason given</Badge>}
                </div>
                <div className="small">
                  {(e.opportunity_name || e.account_name) && (
                    <button type="button" className="btn-link" onClick={() => open(e)}>
                      {e.opportunity_name || e.account_name}
                    </button>
                  )}
                  {e.opportunity_name && e.account_name && e.account_name !== e.opportunity_name && (
                    <span className="muted"> · {e.account_name}</span>
                  )}
                  <span className="muted"> · {e.actor_name || 'Someone'}</span>
                </div>
                {e.reason && <div className="small history-why">“{e.reason}”</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {data && entries.length < data.total && (
        <button type="button" className="btn btn-sm" onClick={loadMore}>Show more ({data.total - entries.length} left)</button>
      )}
    </div>
  );
}

/** Money as money; everything else as written. */
function shownValue(field, value) {
  if (value === null || value === undefined) return value;
  if (/_value$/.test(field) && value !== '' && !Number.isNaN(Number(value))) return formatMoney(Number(value)) || value;
  return value;
}

// ================================================================ the controls tab

export default function CrmControls() {
  const { can } = useAuth();
  const reporting = can('crm.manage.any') || can('report.view');
  const views = [
    ['quality', 'Data quality'],
    ['workload', 'Workload & escalations'],
    ...(reporting ? [['investor', 'Investor summary'], ['audit', 'Audit history']] : []),
  ];
  const [view, setView] = useState('quality');

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row wrap no-print" style={{ gap: 6 }} role="group" aria-label="Controls">
        {views.map(([key, label]) => (
          <button key={key} type="button" className={`kind-chip${view === key ? ' is-active' : ''}`} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>
      {view === 'quality' && <DataQuality />}
      {view === 'workload' && <PipelineWorkload />}
      {view === 'investor' && reporting && <InvestorSummary />}
      {view === 'audit' && reporting && <AuditTrail />}
    </div>
  );
}
