import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadFile, fetchBlobUrl } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { EmptyState, Icon, Modal, Spinner } from '../ui.jsx';
import { CALL_OUTCOME, CATEGORY, dayOf, localDay, money, when } from '../../lib/sales.js';
import { Metric } from './parts.jsx';

// what each number counts, in the words docs/CRM_METRICS.md uses
const DEFINE = {
  captured: 'Leads that arrived in the period (by the date they were captured), in Taskflow categories. TeleCRM and unclassified leads are not counted.',
  cohort: 'Of the leads captured in the period, the share already converted to a deal. A cohort figure: it rises as those leads convert later.',
  converted: 'Leads converted to a deal during the period, whenever they arrived.',
  unassigned: 'Open Taskflow leads with no owner, right now.',
  pipeline: 'Open deals with money in them, at their estimated value (or the CSR amount requested), in the chosen currency only.',
  weighted: 'Each open deal’s value × its probability (the deal’s own, else its stage’s). Stages set not to count, and deals marked “omitted”, are left out.',
  closing: 'Open deals whose expected close date falls in the period.',
  won: 'Deals marked won with a close date in the period, B2B and CSR together.',
  winrate: 'Won ÷ (won + lost), among deals closed in the period. Paused and open deals are not in it.',
  cycle: 'Average days from a won deal’s creation to its close, for deals won in the period.',
  bookings: 'Agreed value of B2B deals won in the period, in the chosen currency. A booking is not cash and not accounting revenue.',
  csr: 'Funding committed on CSR deals won in the period. A commitment is not money received.',
  receipts: 'Money received in the period (receipts, not counting refunds), in the chosen currency.',
  refunds: 'Refunds paid in the period.',
  outstanding: 'For won deals with a payment schedule: scheduled minus received (net of refunds), now.',
  invoiced: 'Invoices issued in the period.',
  stale: 'Open deals with no two-way contact for the stale period set in Settings, whatever is scheduled. Different from an overdue follow-up.',
  overdue: 'Open follow-ups whose time has passed.',
};

function Drill({ metric, filters, onClose }) {
  const toast = useToast();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  useEffect(() => { api.sales.get('/reports/drill', { ...filters, metric }).then(setData).catch((err) => setData({ error: err.message })); }, [metric, filters]);
  return (
    <Modal title="The records behind this number" size="lg" onClose={onClose}
      footer={can('crm.export') && <button type="button" className="btn btn-sm" onClick={() => downloadFile(api.sales.url('/exports/report', { ...filters, metric, format: 'XLSX' }), `${metric}.xlsx`).catch(toast.error)}><Icon name="download" size={13} /> Export</button>}>
      {!data ? <Spinner /> : data.error ? <div className="small critical-text">{data.error}</div> : data.rows.length === 0 ? <div className="empty small">No records.</div> : (
        <div className="table-scroll">
          <table className="data-table">
            {data.kind === 'lead' ? (
              <><thead><tr><th>Lead</th><th>Category</th><th>Status</th><th>Owner</th><th>Source</th><th>Captured</th></tr></thead>
                <tbody>{data.rows.map((r) => <tr key={r.id}><td><Link to={`/sales/leads/${r.id}`}>{r.ref} {r.organization_name || r.contact_name}</Link></td><td>{CATEGORY[r.category]?.short}</td><td>{r.status.toLowerCase()}</td><td>{r.owner_name || '—'}</td><td>{r.source_name || '—'}</td><td>{dayOf(r.captured_at)}</td></tr>)}</tbody></>
            ) : (
              <><thead><tr><th>Deal</th><th>Organization</th><th>Pipeline</th><th>Stage</th><th className="num">Value</th><th>Owner</th><th>Closed / expected</th></tr></thead>
                <tbody>{data.rows.map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.account_name}</td><td>{r.pipeline}</td><td>{r.stage}</td>
                  <td className="num tnum">{!r.is_monetary ? 'non-monetary' : money(r.status === 'WON' ? (r.agreed_value ?? r.committed_amount) : r.open_value, r.currency)}</td><td>{r.owner_name}</td><td>{dayOf(r.closed_at || r.expected_close)}</td></tr>)}</tbody></>
            )}
          </table>
        </div>
      )}
    </Modal>
  );
}

export function Reports({ meta }) {
  const toast = useToast();
  const [filters, setFilters] = useState({ from: `${localDay(0).slice(0, 8)}01`, to: localDay(0), currency: meta.settings.calendar?.currency || 'INR', owner_id: '', category: '', pipeline: '', source_id: '' });
  const [tab, setTab] = useState('summary');
  const [data, setData] = useState(null);
  const [drill, setDrill] = useState(null);
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
  const key = JSON.stringify(clean);
  const load = useCallback(() => {
    setData(null);
    api.sales.get(`/reports/${tab}`, clean).then(setData).catch((err) => { setData({ error: err.message }); toast.error(err); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, key]);
  useEffect(load, [load]);
  const preset = (kind) => {
    const today = localDay(0);
    if (kind === 'today') setFilters({ ...filters, from: today, to: today });
    if (kind === 'week') setFilters({ ...filters, from: localDay(-6), to: today });
    if (kind === 'month') setFilters({ ...filters, from: `${today.slice(0, 8)}01`, to: today });
    if (kind === 'fy') { const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7)); const start = m >= (meta.settings.calendar?.fyStartMonth || 4) ? y : y - 1; setFilters({ ...filters, from: `${start}-${String(meta.settings.calendar?.fyStartMonth || 4).padStart(2, '0')}-01`, to: today }); }
  };
  const c = filters.currency;
  return (
    <div className="stack">
      <div className="filters">
        {[['today', 'Today'], ['week', '7 days'], ['month', 'This month'], ['fy', 'Financial year']].map(([k, l]) => <button key={k} type="button" className="btn btn-sm" onClick={() => preset(k)}>{l}</button>)}
        <input className="input" type="date" aria-label="From" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        <input className="input" type="date" aria-label="To" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        <select className="select" aria-label="Category" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">B2B and CSR/NGO</option><option value="B2B_CORPORATE">B2B corporate</option><option value="CSR_NGO">CSR / NGO</option></select>
        <select className="select" aria-label="Owner" value={filters.owner_id} onChange={(e) => setFilters({ ...filters, owner_id: e.target.value })}><option value="">Everyone I can see</option>{meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
        <select className="select" aria-label="Source" value={filters.source_id} onChange={(e) => setFilters({ ...filters, source_id: e.target.value })}><option value="">Any source</option>{meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input className="input" aria-label="Currency" style={{ width: 70 }} maxLength={3} value={filters.currency} onChange={(e) => setFilters({ ...filters, currency: e.target.value.toUpperCase() })} />
      </div>
      <div className="tabs tabs-scroll" role="tablist">
        {[['summary', 'Summary'], ['sources', 'Sources & campaigns'], ['agents', 'People'], ['stages', 'Stages'], ['targets', 'Targets']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {!data ? <Spinner /> : data.error ? <EmptyState title="Could not load the report">{data.error}</EmptyState> : (
        <>
          {tab === 'summary' && (
            <div className="stack">
              <div className="small muted">{dayOf(data.filters.from)} – {dayOf(data.filters.to)} · money in {c}{data.other_currencies.length ? `; deals in ${data.other_currencies.join(', ')} are counted separately, never added in` : ''} · only records you may see</div>
              <h3 className="small">Leads</h3>
              <div className="stat-grid">
                <Metric label="Captured" value={data.leads.captured} define={DEFINE.captured} onDrill={() => setDrill('captured')} />
                <Metric label="Captured today" value={data.leads.captured_today} />
                <Metric label="Cohort conversion" value={data.leads.cohort_conversion_rate === null ? '—' : `${data.leads.cohort_conversion_rate}%`} note={`${data.leads.cohort_converted} of ${data.leads.captured}`} define={DEFINE.cohort} onDrill={() => setDrill('cohort_converted')} />
                <Metric label="Converted in period" value={data.leads.converted_in_period} define={DEFINE.converted} onDrill={() => setDrill('converted_in_period')} />
                <Metric label="Unassigned now" value={data.leads.unassigned_now} tone={data.leads.unassigned_now ? 'warning' : undefined} define={DEFINE.unassigned} onDrill={() => setDrill('unassigned_now')} />
                <Metric label="First response (median)" value={data.leads.median_first_response_hours === null ? '—' : `${data.leads.median_first_response_hours} h`} />
              </div>
              <h3 className="small">Pipeline (open now)</h3>
              <div className="stat-grid">
                <Metric label="Open deals" value={data.pipeline.open_count} note={`${data.pipeline.open_non_monetary} non-monetary`} onDrill={() => setDrill('open_deals')} />
                <Metric label="Pipeline value" value={money(data.pipeline.value, c)} note={`${data.pipeline.open_valued} with a value`} define={DEFINE.pipeline} />
                <Metric label="Weighted forecast" value={money(data.pipeline.weighted_forecast, c)} define={DEFINE.weighted} />
                <Metric label="Expected to close" value={data.pipeline.expected_to_close} note={money(data.pipeline.expected_to_close_value, c)} define={DEFINE.closing} onDrill={() => setDrill('expected_to_close')} />
                <Metric label="Stale deals" value={data.pipeline.stale} tone={data.pipeline.stale ? 'warning' : undefined} define={DEFINE.stale} />
              </div>
              <h3 className="small">Outcomes in the period</h3>
              <div className="stat-grid">
                <Metric label="Won" value={data.outcomes.won} define={DEFINE.won} onDrill={() => setDrill('won')} tone="good" />
                <Metric label="Lost" value={data.outcomes.lost} onDrill={() => setDrill('lost')} />
                <Metric label="Win rate" value={data.outcomes.win_rate === null ? '—' : `${data.outcomes.win_rate}%`} define={DEFINE.winrate} />
                <Metric label="Average cycle" value={data.outcomes.avg_cycle_days === null ? '—' : `${data.outcomes.avg_cycle_days} days`} define={DEFINE.cycle} />
              </div>
              <h3 className="small">Money — kept apart on purpose</h3>
              <div className="stat-grid">
                <Metric label="Commercial bookings" value={money(data.outcomes.commercial_bookings, c)} define={DEFINE.bookings} />
                <Metric label="CSR committed" value={money(data.outcomes.csr_committed, c)} note={data.outcomes.csr_non_monetary_won ? `+${data.outcomes.csr_non_monetary_won} non-monetary` : undefined} define={DEFINE.csr} />
                <Metric label="Invoiced" value={money(data.money.invoiced, c)} define={DEFINE.invoiced} />
                <Metric label="Received (commercial)" value={money(data.money.commercial_receipts, c)} define={DEFINE.receipts} />
                <Metric label="Received (CSR)" value={money(data.money.csr_receipts, c)} define={DEFINE.receipts} />
                <Metric label="Refunds" value={money(data.money.refunds, c)} define={DEFINE.refunds} />
                <Metric label="Outstanding on schedules" value={money(data.money.outstanding_on_schedules, c)} define={DEFINE.outstanding} />
              </div>
              <h3 className="small">Follow-ups</h3>
              <div className="stat-grid">
                <Metric label="Open" value={data.work.followups_open} />
                <Metric label="Due today" value={data.work.followups_today} />
                <Metric label="Overdue" value={data.work.followups_overdue} tone={data.work.followups_overdue ? 'critical' : undefined} define={DEFINE.overdue} />
                <Metric label="Completed in period" value={data.work.followups_completed} />
                <Metric label="No answer / not done" value={data.work.followups_missed} />
              </div>
              <div className="small muted">{data.unavailable.pipeline_as_of_past_dates}</div>
            </div>
          )}
          {tab === 'sources' && (
            <div className="stack-sm">
              <div className="small muted">{data.attribution}</div>
              <div className="table-scroll"><table className="data-table"><thead><tr><th>Source</th><th>Campaign</th><th className="num">Leads</th><th className="num">Converted</th><th className="num">Conversion</th><th className="num">Won deals</th><th className="num">Bookings</th><th className="num">CSR committed</th><th className="num">Spend</th></tr></thead>
                <tbody>{data.rows.map((r, i) => <tr key={i}><td>{r.source_name || 'Not recorded'}</td><td>{r.campaign_name || '—'}</td><td className="num">{r.leads}</td><td className="num">{r.converted}</td><td className="num">{r.conversion_rate === null ? '—' : `${r.conversion_rate}%`}</td><td className="num">{r.won}</td><td className="num tnum">{money(r.won_value, c)}</td><td className="num tnum">{money(r.csr_committed, c)}</td><td className="num tnum">{r.spend === null ? '—' : money(r.spend, r.spend_currency)}</td></tr>)}</tbody></table></div>
            </div>
          )}
          {tab === 'agents' && (
            <div className="table-scroll"><table className="data-table"><thead><tr><th>Person</th><th className="num">Leads received</th><th className="num">Converted</th><th className="num">Calls, messages, meetings</th><th className="num">Follow-ups done</th><th className="num">Overdue now</th><th className="num">Open deals</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Win rate</th><th className="num">Bookings</th><th className="num">CSR committed</th></tr></thead>
              <tbody>{data.rows.map((r) => <tr key={r.id}><td>{r.full_name}</td><td className="num">{r.leads_received}</td><td className="num">{r.leads_converted}</td><td className="num">{r.activities}</td><td className="num">{r.followups_done}</td><td className={`num${r.followups_overdue ? ' critical-text' : ''}`}>{r.followups_overdue}</td><td className="num">{r.open_deals}</td><td className="num">{r.won}</td><td className="num">{r.lost}</td><td className="num">{r.win_rate === null ? '—' : `${r.win_rate}%`}</td><td className="num tnum">{money(r.bookings, c)}</td><td className="num tnum">{money(r.csr_committed, c)}</td></tr>)}</tbody></table></div>
          )}
          {tab === 'stages' && (
            <div className="stack-sm">
              <div className="row" style={{ gap: 6 }}>{[['b2b', 'B2B'], ['csr', 'CSR / NGO']].map(([k, l]) => <button key={k} type="button" className={`kind-chip${(filters.pipeline || 'b2b') === k ? ' is-active' : ''}`} onClick={() => setFilters({ ...filters, pipeline: k })}>{l}</button>)}</div>
              <div className="small muted">{data.note}</div>
              <div className="table-scroll"><table className="data-table"><thead><tr><th>Stage</th><th className="num">Open deals</th><th className="num">Value</th><th className="num">Ageing</th><th className="num">Stays ended in period</th><th className="num">Average days in stage</th></tr></thead>
                <tbody>{data.stages.map((s) => <tr key={s.id}><td>{s.name}</td><td className="num">{s.open_deals}</td><td className="num tnum">{money(s.open_value, c)}</td><td className="num">{s.aging_days ? s.ageing : '—'}</td><td className="num">{s.stays_ended}</td><td className="num">{s.avg_days_in_stage ?? '—'}</td></tr>)}</tbody></table></div>
            </div>
          )}
          {tab === 'targets' && (
            data.targets.length === 0 ? <EmptyState title="No targets for this period">An administrator sets targets in Settings → Sales CRM → Targets.</EmptyState> : (
              <div className="table-scroll"><table className="data-table"><thead><tr><th>Period</th><th>For</th><th>Measure</th><th className="num">Target</th><th className="num">Actual</th><th className="num">Attainment</th></tr></thead>
                <tbody>{data.targets.map((t) => <tr key={t.id}><td>{dayOf(t.period_start)} – {dayOf(t.period_end)}</td><td>{t.user_name || t.department_name || 'Company'}{t.pipeline_key ? ` · ${t.pipeline_key.toUpperCase()}` : ''}</td><td>{t.metric.toLowerCase().replace(/_/g, ' ')}</td><td className="num tnum">{t.currency ? money(t.target, t.currency) : t.target}</td><td className="num tnum">{t.actual === null ? '—' : t.currency ? money(t.actual, t.currency) : t.actual}</td><td className="num">{t.attainment === null ? '—' : `${t.attainment}%`}</td></tr>)}</tbody></table></div>
            )
          )}
        </>
      )}
      {drill && <Drill metric={drill} filters={clean} onClose={() => setDrill(null)} />}
    </div>
  );
}

export function Approvals() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => api.sales.get('/approvals').then((r) => setList(r.approvals)).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const decide = (a, decision) => {
    const comment = decision === 'REJECTED' ? window.prompt('What needs to change?') : null;
    if (decision === 'REJECTED' && !comment) return;
    api.sales.post(`/approvals/${a.id}/decide`, { decision, comment }).then(() => { toast.success(decision === 'APPROVED' ? 'Approved' : 'Returned'); load(); }).catch(toast.error);
  };
  if (!list) return <Spinner />;
  if (!list.length) return <EmptyState title="Nothing waiting for your approval">Quotations and proposals that need your sign-off appear here.</EmptyState>;
  return (
    <div className="stack-sm">
      {list.map((a) => (
        <div key={a.id} className="card card-pad stack-sm">
          <div className="row-between wrap">
            <div><strong>{a.number} v{a.version}</strong> · {a.account_name} · <Link to={`/accounts/${a.account_id}?deal=${a.opportunity_id}`} className="btn-link">{a.opportunity_name}</Link></div>
            <strong className="tnum">{money(a.total, a.currency)}</strong>
          </div>
          <div className="small muted">Asked by {a.requested_by_name} on {when(a.requested_at)} · {a.reasons.join('; ')}</div>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => decide(a, 'APPROVED')}>Approve</button>
            <button type="button" className="btn btn-sm" onClick={() => decide(a, 'REJECTED')}>Return for changes</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Calls() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [mine, setMine] = useState(false);
  const [playing, setPlaying] = useState({});
  useEffect(() => { setData(null); api.sales.get('/calls', { mine: mine ? '1' : undefined }).then(setData).catch(() => setData({ calls: [] })); }, [mine]);
  const play = async (c) => {
    try {
      const url = await fetchBlobUrl(api.sales.url(`/calls/${c.id}/recording`));
      setPlaying((p) => ({ ...p, [c.id]: url }));
    } catch (err) { toast.error(err); }
  };
  if (!data) return <Spinner />;
  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 6 }}><button type="button" className={`kind-chip${!mine ? ' is-active' : ''}`} onClick={() => setMine(false)}>All I can see</button><button type="button" className={`kind-chip${mine ? ' is-active' : ''}`} onClick={() => setMine(true)}>My calls</button></div>
      {data.calls.length === 0 ? <EmptyState title="No calls yet">Calls logged by hand, and calls from a connected phone system, appear here.</EmptyState> : (
        <div className="table-scroll"><table className="data-table"><thead><tr><th>When</th><th>About</th><th>Who</th><th>Direction</th><th>Outcome</th><th className="num">Length</th><th>Source</th><th>Recording</th></tr></thead>
          <tbody>{data.calls.map((c) => (
            <tr key={c.id}>
              <td>{when(c.started_at)}</td>
              <td>{c.lead_id ? <Link to={`/sales/leads/${c.lead_id}`}>{c.about}</Link> : c.account_id ? <Link to={`/accounts/${c.account_id}`}>{c.about}</Link> : c.about}</td>
              <td>{c.agent_name || '—'}</td><td>{c.direction.toLowerCase()}</td>
              <td>{CALL_OUTCOME[c.outcome] || String(c.status).toLowerCase().replace('_', ' ')}</td>
              <td className="num">{c.duration_sec ? `${Math.floor(c.duration_sec / 60)}:${String(c.duration_sec % 60).padStart(2, '0')}` : '—'}</td>
              <td className="small">{c.logged_manually ? 'logged by hand' : c.provider}</td>
              <td>{playing[c.id] ? <audio controls src={playing[c.id]} /> : c.can_play ? <button type="button" className="btn btn-sm" onClick={() => play(c)}>Play</button> : c.has_recording ? <span className="small muted">restricted</span> : '—'}</td>
            </tr>
          ))}</tbody></table></div>
      )}
    </div>
  );
}

