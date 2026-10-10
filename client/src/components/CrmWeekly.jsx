import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Spinner } from './ui.jsx';
import { NextActionFields, PersonSelect, nextActionBody, nextActionDraft, nextActionProblem } from './DealParts.jsx';
import {
  ORDER_KIND_LABEL, activityMeta, effortWords, exactMoney, formatMoney, shiftWeek, todayInIndia, weekLabel, weekOf,
} from '../lib/crm.js';
import { formatDate, relativeTime } from '../lib/format.js';

/**
 * The pipeline's week.
 *
 * Three things, each answering a different question:
 *
 *   The week on the record — what moved, what customers promised and whether
 *   they kept it, what was proposed, booked, billed and collected, what slipped,
 *   and what is waiting on a decision. A week that has ended is written down
 *   once and never rewritten.
 *
 *   The weekly review — each owner says, deal by deal, what changed, the
 *   evidence, the next milestone and any help they need. Beside it, what the
 *   record shows moved; apart from it, how much was logged.
 *
 *   Correspondence — emails and calendar entries brought in from outside, which
 *   become part of the record only when somebody confirms them.
 */

/** Opens a deal (or its organization) from anywhere on these screens. */
function DealLink({ accountId, opportunityId, name, accountName }) {
  const navigate = useNavigate();
  if (!accountId) return <span>{name || accountName}</span>;
  return (
    <span className="deal-link">
      <button type="button" className="btn-link"
        onClick={() => navigate(`/accounts/${accountId}${opportunityId ? `?deal=${opportunityId}` : ''}`)}>
        {name || accountName}
      </button>
      {name && accountName && name !== accountName && <span className="muted"> · {accountName}</span>}
    </span>
  );
}

const money = (value) => (value === null || value === undefined ? null : exactMoney(value));

/** Back and forward by a week; never into weeks that have not started. */
function WeekPicker({ start, onChange }) {
  const current = weekOf();
  const last = shiftWeek(current.start, -1);
  const prefix = start === current.start ? 'This week' : start === last ? 'Last week' : 'Week of';
  return (
    <div className="week-picker" role="group" aria-label="Choose the week">
      <button type="button" className="btn btn-sm btn-ghost" aria-label="The week before"
        onClick={() => onChange(shiftWeek(start, -1))}>
        <Icon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} />
      </button>
      <span className="week-picker-label">
        <span className="muted">{prefix}</span> <strong className="tnum">{weekLabel(start)}</strong>
      </span>
      <button type="button" className="btn btn-sm btn-ghost" aria-label="The week after"
        disabled={start >= current.start} onClick={() => onChange(shiftWeek(start, 1))}>
        <Icon name="chevron" size={13} />
      </button>
      {start !== current.start && (
        <button type="button" className="btn-link small" onClick={() => onChange(current.start)}>Back to this week</button>
      )}
    </div>
  );
}

// ================================================================ the week on the record

function Figure({ label, value, sub, tone, target }) {
  const jump = () => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className={`metric${tone ? ` metric-${tone}` : ''}`}>
      <button type="button" className="metric-main" onClick={jump} title="Show the records behind this">
        <span className="metric-label">{label}</span>
        <span className="metric-value tnum">{value}</span>
        {sub && <span className="metric-sub small muted">{sub}</span>}
      </button>
    </div>
  );
}

function WeekSection({ id, title, count, definition, children }) {
  return (
    <section id={id} className="card card-pad stack-sm week-section">
      <div className="row-between wrap">
        <h3>{title}{count !== undefined && <span className="muted tnum"> · {count}</span>}</h3>
      </div>
      {definition && <div className="small muted">{definition}</div>}
      {children}
    </section>
  );
}

function Nothing({ children = 'None.' }) {
  return <div className="small muted">{children}</div>;
}

function SubList({ title, rows, render, empty }) {
  return (
    <div className="stack-sm">
      <div className="stat-label">{title}{rows.length ? ` (${rows.length})` : ''}</div>
      {rows.length ? rows.map(render) : <Nothing>{empty}</Nothing>}
    </div>
  );
}

const MOVE_TONE = { forward: 'good', back: 'warning', lost: 'critical' };

/** The week's record: stored once the week has ended, worked out live while it runs. */
export function WeekRecord() {
  const { can } = useAuth();
  const { userById } = useRefData();
  const toast = useToast();
  const [start, setStart] = useState(() => weekOf().start);
  const [week, setWeek] = useState(null);
  const [weeks, setWeeks] = useState([]);
  const [storing, setStoring] = useState(false);

  const load = useCallback(() => {
    setWeek(null);
    api.crmWeek(start).then(setWeek).catch((err) => toast.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  useEffect(load, [load]);
  const loadWeeks = useCallback(() => {
    api.crmWeeks().then((r) => setWeeks(r.weeks)).catch(() => setWeeks([]));
  }, []);
  useEffect(loadWeeks, [loadWeeks]);

  const store = async () => {
    setStoring(true);
    try {
      await api.snapshotWeek(start);
      toast.success('The week is on the record');
      load();
      loadWeeks();
    } catch (err) {
      toast.error(err);
    } finally {
      setStoring(false);
    }
  };

  const ended = weekOf().start > start;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-between wrap" style={{ gap: 10 }}>
        <WeekPicker start={start} onChange={setStart} />
        {week && (
          <div className="row wrap small" style={{ gap: 6 }}>
            {week.stored ? (
              <>
                <Badge tone="good">On the record</Badge>
                <span className="muted">
                  written {formatDate(week.generated_at, { withTime: true })}
                  {week.generated_by ? ` by ${userById[week.generated_by]?.full_name || 'a manager'}` : ' automatically'}
                  {' '}— later edits to the deals do not change it
                </span>
              </>
            ) : week.running ? (
              <>
                <Badge tone="brand">In progress</Badge>
                <span className="muted">worked out live; written down once the week ends</span>
              </>
            ) : (
              <>
                <Badge tone="warning">Not yet written down</Badge>
                <span className="muted">worked out from today’s data</span>
                {ended && can('crm.manage.any') && (
                  <button type="button" className="btn btn-sm" onClick={store} disabled={storing}>
                    {storing ? 'Writing…' : 'Write it down now'}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {!week ? <Spinner label="Working out the week" /> : <WeekBody week={week} />}

      {weeks.length > 0 && (
        <section className="card card-pad stack-sm">
          <h3>Weeks on the record</h3>
          <div className="small muted">Each written down after it ended and never changed since.</div>
          <div className="table-scroll">
            <table className="data-table week-history">
              <thead>
                <tr>
                  <th>Week</th>
                  <th className="num">Moved forward</th>
                  <th className="num">Proposals</th>
                  <th className="num">Booked</th>
                  <th className="num">Cash received</th>
                  <th className="num">Commitments kept / missed</th>
                  <th className="num">Slipped</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => {
                  const s = w.summary || {};
                  const first = String(w.week_start).slice(0, 10);
                  return (
                    <tr key={w.id} className={first === start ? 'is-current' : ''}>
                      <td><button type="button" className="btn-link" onClick={() => setStart(first)}>{weekLabel(first)}</button></td>
                      <td className="num tnum">{s.moved_forward ?? 0}</td>
                      <td className="num tnum">{s.proposals ?? 0}</td>
                      <td className="num tnum">{s.booked === null || s.booked === undefined ? '—' : formatMoney(s.booked)}</td>
                      <td className="num tnum">{s.cash_received === null || s.cash_received === undefined ? '—' : formatMoney(s.cash_received)}</td>
                      <td className="num tnum">{s.commitments_kept ?? 0} / {s.commitments_missed ?? 0}</td>
                      <td className="num tnum">{(s.missed_next_actions ?? 0) + (s.missed_tasks ?? 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function WeekBody({ week }) {
  const s = week.summary;
  const d = week.definitions || {};
  const slipped = s.missed_next_actions + s.missed_tasks;
  const amount = (value, count) => {
    if (value !== null && value !== undefined) return formatMoney(value);
    return count ? 'amount not recorded' : '—';
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="stack-sm">
        <div className="stat-label">Customer outcomes</div>
        <div className="metric-grid">
          <Figure label="Moved forward" value={s.moved_forward} target="week-stages"
            sub={s.moved_back ? `${s.moved_back} moved back` : 'none moved back'} tone={s.moved_forward ? 'good' : undefined} />
          <Figure label="Customer commitments" value={s.commitments_made} target="week-commitments"
            sub={`${s.commitments_kept} kept · ${s.commitments_missed} missed · ${s.commitments_overdue} overdue`}
            tone={s.commitments_overdue || s.commitments_missed ? 'warning' : undefined} />
          <Figure label="Proposals sent" value={s.proposals} target="week-money"
            sub={s.proposals ? (s.proposals_value === null ? 'no amounts recorded' : formatMoney(s.proposals_value)) : null} />
          <Figure label="Booked (orders)" value={amount(s.booked, s.orders)} target="week-money"
            sub={`${s.orders} order${s.orders === 1 ? '' : 's'} — a commitment, not money`} />
          <Figure label="Invoiced" value={amount(s.invoiced, week.invoices.length)} target="week-money"
            sub="revenue billed, not cash" />
          <Figure label="Cash received" value={amount(s.cash_received, week.payments.length)} target="week-money"
            sub="money that actually arrived" tone={s.cash_received ? 'good' : undefined} />
          <Figure label="Slipped" value={slipped} target="week-slipped"
            sub={`${s.missed_next_actions} next action${s.missed_next_actions === 1 ? '' : 's'} · ${s.missed_tasks} task${s.missed_tasks === 1 ? '' : 's'}`}
            tone={slipped ? 'warning' : undefined} />
          <Figure label="Needs a decision" value={s.decisions} target="week-decisions" tone={s.decisions ? 'warning' : undefined} />
        </div>
      </div>

      <WeekSection id="week-stages" title="Stage changes" count={week.stage_changes.length} definition={d.stage_changes}>
        {week.stage_changes.length === 0 ? <Nothing>No deal changed stage.</Nothing> : week.stage_changes.map((c, index) => (
          <div key={`${c.opportunity_id}-${index}`} className="week-row">
            <Badge tone={MOVE_TONE[c.direction]}>{c.direction}</Badge>
            <span className="grow">
              <DealLink accountId={c.account_id} opportunityId={c.opportunity_id} name={c.name} accountName={c.account_name} />
              {' — '}{c.from_value || 'new'} → <strong>{c.to_value}</strong>
              {c.evidence_missing?.length > 0 && <> <Badge tone="critical">moved without evidence</Badge></>}
              {c.reason && <div className="small muted">“{c.reason}”</div>}
            </span>
            <span className="small muted">{c.actor_name || 'Someone'} · {formatDate(c.created_at)}</span>
          </div>
        ))}
      </WeekSection>

      <WeekSection id="week-commitments" title="What customers committed to" definition={d.commitments}>
        <div className="week-columns">
          <SubList title="Committed this week" rows={week.commitments.made} empty="Nothing recorded."
            render={(c) => (
              <div key={c.id} className="week-row small">
                <span className="grow"><strong>{c.what}</strong>{c.due_on ? ` · by ${formatDate(c.due_on)}` : ''}
                  <div className="muted"><DealLink accountId={c.account_id} opportunityId={c.opportunity_id} name={c.opportunity_name} accountName={c.account_name} /></div>
                </span>
              </div>
            )} />
          <SubList title="Kept" rows={week.commitments.kept} empty="None kept this week."
            render={(c) => (
              <div key={c.id} className="week-row small">
                <Badge tone="good">kept</Badge>
                <span className="grow">{c.what}<div className="muted">{c.opportunity_name || c.account_name}</div></span>
              </div>
            )} />
          <SubList title="Missed" rows={week.commitments.missed} empty="None missed this week."
            render={(c) => (
              <div key={c.id} className="week-row small">
                <Badge tone="critical">missed</Badge>
                <span className="grow">{c.what}<div className="muted">{c.opportunity_name || c.account_name}{c.resolution_note ? ` — ${c.resolution_note}` : ''}</div></span>
              </div>
            )} />
          <SubList title="Still open and overdue" rows={week.commitments.overdue} empty="Nothing overdue."
            render={(c) => (
              <div key={c.id} className="week-row small">
                <Badge tone="warning">due {formatDate(c.due_on)}</Badge>
                <span className="grow">{c.what}
                  <div className="muted"><DealLink accountId={c.account_id} opportunityId={c.opportunity_id} name={c.opportunity_name} accountName={c.account_name} /></div>
                </span>
              </div>
            )} />
        </div>
      </WeekSection>

      <WeekSection id="week-money" title="Proposals, orders, invoices and cash" definition="Four different claims, never added together.">
        <div className="week-columns">
          <SubList title="Proposals" rows={week.proposals} empty="No proposals sent."
            render={(p) => (
              <div key={p.id} className="ledger-row">
                <span className="grow small"><DealLink accountId={p.account_id} opportunityId={p.opportunity_id} name={p.name} accountName={p.account_name} />
                  {p.title && <span className="muted"> · {p.title}</span>}</span>
                <span className="small muted">{formatDate(p.sent_on)}</span>
                <span className="tnum small">{money(p.amount) ?? <span className="muted">no amount</span>}</span>
              </div>
            )} />
          <SubList title="Orders and contracts (bookings)" rows={week.orders} empty="No orders received."
            render={(o) => (
              <div key={o.id} className="ledger-row">
                <span className="grow small"><DealLink accountId={o.account_id} opportunityId={o.opportunity_id} name={o.name} accountName={o.account_name} />
                  <span className="muted"> · {ORDER_KIND_LABEL[o.kind] || 'Order'}{o.reference ? ` ${o.reference}` : ''}</span></span>
                <span className="small muted">{formatDate(o.received_on)}</span>
                <span className="tnum small">{money(o.amount) ?? <span className="muted">no amount</span>}</span>
              </div>
            )} />
          <SubList title="Invoices (revenue billed)" rows={week.invoices} empty="No invoices issued."
            render={(i) => (
              <div key={i.id} className="ledger-row">
                <span className="grow small"><DealLink accountId={i.account_id} opportunityId={i.opportunity_id} name={i.name} accountName={i.account_name} />
                  {i.number && <span className="muted"> · {i.number}</span>}</span>
                <span className="small muted">{formatDate(i.issued_on)}</span>
                <span className="tnum small">{money(i.amount)}</span>
              </div>
            )} />
          <SubList title="Payments (cash received)" rows={week.payments} empty="No money arrived."
            render={(p) => (
              <div key={p.id} className="ledger-row">
                <span className="grow small"><DealLink accountId={p.account_id} opportunityId={p.opportunity_id} name={p.name} accountName={p.account_name} />
                  {p.reference && <span className="muted"> · {p.reference}</span>}</span>
                <span className="small muted">{formatDate(p.received_on)}</span>
                <span className="tnum small">{money(p.amount)}</span>
              </div>
            )} />
        </div>
      </WeekSection>

      <WeekSection id="week-slipped" title="What slipped" count={slipped}>
        <div className="week-columns">
          <SubList title="Next actions past their date" rows={week.missed.next_actions} empty="Every next action was done or re-agreed."
            render={(m) => (
              <div key={m.opportunity_id} className="week-row small">
                <span className="grow">
                  <DealLink accountId={m.account_id} opportunityId={m.opportunity_id} name={m.name} accountName={m.account_name} />
                  <div>{m.next_step || <span className="muted">no next action</span>}</div>
                </span>
                <span className="muted">{m.owner_name || 'nobody'} · was due {formatDate(m.next_step_due)}</span>
              </div>
            )} />
          <SubList title="Deal tasks not finished on time" rows={week.missed.tasks} empty="None."
            render={(t) => (
              <div key={t.id} className="week-row small">
                <span className="task-ref">{t.ref}</span>
                <span className="grow">{t.title}<div className="muted">{t.account_name}</div></span>
                <span className="muted">
                  {t.assignee_name || 'unassigned'} · due {formatDate(t.due_date)}
                  {t.completed_at ? ` · finished ${formatDate(t.completed_at)}` : ' · not finished'}
                </span>
              </div>
            )} />
        </div>
        {d.missed_next_actions && <div className="small muted">{d.missed_next_actions} {d.missed_tasks}</div>}
      </WeekSection>

      <WeekSection id="week-decisions" title="Waiting on a decision" count={s.decisions} definition={d.decisions}>
        <div className="week-columns">
          <SubList title="Blockers" rows={week.decisions.blockers} empty="Nothing blocked."
            render={(b) => (
              <div key={b.id} className="week-row small">
                {b.overdue ? <Badge tone="critical">past its date</Badge> : <Badge tone="warning">open</Badge>}
                <span className="grow">
                  <strong>{b.blocked_item || b.title}</strong>
                  {b.dependency && <span className="muted"> · on {b.dependency === 'EXTERNAL' ? (b.external_party || 'someone outside') : 'us'}</span>}
                  <div className="muted">
                    <DealLink accountId={b.account_id} opportunityId={null} name={b.opportunity_name} accountName={b.account_name} />
                    {b.responsible_name ? ` · ${b.responsible_name} clears it` : ''}
                    {b.expected_resolution ? ` · by ${formatDate(b.expected_resolution)}` : ''}
                  </div>
                </span>
              </div>
            )} />
          <SubList title="Past their expected close date" rows={week.decisions.past_close} empty="None."
            render={(p) => (
              <div key={p.opportunity_id} className="week-row small">
                <span className="grow"><DealLink accountId={p.account_id} opportunityId={p.opportunity_id} name={p.name} accountName={p.account_name} /></span>
                <span className="muted">{p.owner_name || 'nobody'} · was to close {formatDate(p.expected_close)}</span>
              </div>
            )} />
          <SubList title="Handovers nobody has confirmed" rows={week.decisions.unconfirmed_handovers} empty="None."
            render={(h) => (
              <div key={h.id} className="week-row small">
                <span className="grow"><DealLink accountId={h.account_id} opportunityId={h.opportunity_id} name={h.name} accountName={h.account_name} /></span>
                <span className="muted">to {h.to_name} · {relativeTime(h.created_at)}</span>
              </div>
            )} />
          <SubList title="Moved without evidence" rows={week.decisions.moved_without_evidence} empty="None."
            render={(m, index) => (
              <div key={`${m.opportunity_id}-${index}`} className="week-row small">
                <span className="grow">
                  <DealLink accountId={m.account_id} opportunityId={m.opportunity_id} name={m.name} accountName={m.account_name} /> → {m.to_value}
                  {m.reason && <div className="muted">“{m.reason}”</div>}
                </span>
                <span className="muted">{m.actor_name}</span>
              </div>
            )} />
          <SubList title="Help asked for in reviews" rows={week.decisions.help_requested} empty="Nobody asked for help."
            render={(h, index) => (
              <div key={`${h.opportunity_id}-${index}`} className="week-row small">
                <span className="grow"><strong>{h.help_needed}</strong>
                  <div className="muted"><DealLink accountId={h.account_id} opportunityId={h.opportunity_id} name={h.name} /> · asked by {h.asked_by}{h.help_from_name ? ` of ${h.help_from_name}` : ''}</div>
                </span>
              </div>
            )} />
        </div>
      </WeekSection>

      <WeekSection id="week-effort" title="Activity logged (effort, not outcomes)" definition={d.activity_counts}>
        {Object.keys(week.activity_counts || {}).length === 0 ? <Nothing>Nothing logged with customers.</Nothing> : (
          <div className="effort-chips">
            {Object.entries(week.activity_counts).map(([type, c]) => (
              <span key={type} className="effort-chip">
                {activityMeta(type).label} <strong className="tnum">{c.logged}</strong>
                {c.from_them > 0 && <span className="muted"> · {c.from_them} from them</span>}
              </span>
            ))}
          </div>
        )}
      </WeekSection>

      <details className="small muted week-definitions">
        <summary>What each part counts</summary>
        <dl>
          {Object.entries(d).map(([key, text]) => (
            <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{text}</dd></div>
          ))}
        </dl>
        <div>
          {week.stored
            ? `Counted to the end of the week. Next actions, close dates, blockers and handovers are as they stood when it was written, ${formatDate(week.generated_at, { withTime: true })}.`
            : `Worked out ${formatDate(week.as_of, { withTime: true })}, from the record as it stands.`}
        </div>
      </details>
    </div>
  );
}

// ================================================================ the weekly review

const blankDraft = (item) => ({
  what_changed: item?.what_changed || '',
  no_change: Boolean(item?.no_change),
  evidence_url: item?.evidence_url || '',
  next_milestone: item?.next_milestone || '',
  next_milestone_due: item?.next_milestone_due ? String(item.next_milestone_due).slice(0, 10) : '',
  help_needed: item?.help_needed || '',
  help_from_user_id: item?.help_from_user_id ? String(item.help_from_user_id) : '',
});

const draftBody = (draft) => ({
  what_changed: draft.no_change ? null : (draft.what_changed.trim() || null),
  no_change: draft.no_change,
  evidence_url: draft.evidence_url.trim() || null,
  next_milestone: draft.next_milestone.trim() || null,
  next_milestone_due: draft.next_milestone_due || null,
  help_needed: draft.help_needed.trim() || null,
  help_from_user_id: draft.help_needed.trim() && draft.help_from_user_id ? Number(draft.help_from_user_id) : null,
});

const OUTCOME_TONE = { stage: 'brand', proposal: 'brand', order: 'good', payment: 'good', commitment: 'neutral', response: 'good' };

/** What the record shows moved on a deal this week. */
function RecordShows({ outcomes }) {
  if (!outcomes.length) return <div className="small muted">Nothing on the record moved this week.</div>;
  return (
    <ul className="record-list">
      {outcomes.map((o, index) => (
        <li key={index} className="small">
          <Badge tone={OUTCOME_TONE[o.kind] || 'neutral'}>{o.kind}</Badge> {o.text}
          {o.amount !== undefined && o.amount !== null && <span className="tnum"> · {exactMoney(o.amount)}</span>}
        </li>
      ))}
    </ul>
  );
}

function ReviewAnswer({ item, unsent = false }) {
  if (!item) return <div className="small muted">{unsent ? 'Not sent yet.' : 'Not answered.'}</div>;
  return (
    <div className="stack-sm small">
      <div>
        <span className="value-cell-label">What changed</span>
        <div>{item.no_change ? <span className="muted">Nothing changed this week</span> : (item.what_changed || <span className="muted">—</span>)}</div>
      </div>
      {item.evidence_url && (
        <div><a className="btn-link" href={item.evidence_url} target="_blank" rel="noopener noreferrer">Evidence</a></div>
      )}
      <div>
        <span className="value-cell-label">Next milestone</span>
        <div>{item.next_milestone || <span className="muted">—</span>}{item.next_milestone_due ? ` · by ${formatDate(item.next_milestone_due)}` : ''}</div>
      </div>
      {item.help_needed && (
        <div className="review-help">
          <span className="value-cell-label">Help needed{item.help_from_name ? ` from ${item.help_from_name}` : ''}</span>
          <div>{item.help_needed}</div>
        </div>
      )}
    </div>
  );
}

function ReviewForm({ draft, onChange, onSave, dirty, saved, saving, missing }) {
  const set = (patch) => onChange({ ...draft, ...patch });
  return (
    <div className="stack-sm">
      <Field label="What changed? *" error={missing === 'what changed' ? 'Say what changed, or tick that nothing did' : null}>
        <textarea className="textarea" rows={2} value={draft.what_changed} disabled={draft.no_change}
          onChange={(e) => set({ what_changed: e.target.value })}
          placeholder="Lab validated 9 of 12 samples; their procurement asked for the revised rate card" />
      </Field>
      <label className="check small">
        <input type="checkbox" checked={draft.no_change} onChange={(e) => set({ no_change: e.target.checked })} />
        Nothing changed this week
      </label>
      <Field label="Evidence" hint="A link to the email, document or record that shows it">
        <input className="input" value={draft.evidence_url} onChange={(e) => set({ evidence_url: e.target.value })}
          placeholder="https://drive.google.com/…" />
      </Field>
      <div className="grid-2">
        <Field label="Next milestone *" error={missing === 'the next milestone and its date' ? 'Name the next milestone and its date' : null}>
          <input className="input" value={draft.next_milestone} onChange={(e) => set({ next_milestone: e.target.value })}
            placeholder="Validation report signed off" />
        </Field>
        <Field label="By *">
          <input className="input" type="date" min={todayInIndia()} value={draft.next_milestone_due}
            onChange={(e) => set({ next_milestone_due: e.target.value })} />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Help needed">
          <input className="input" value={draft.help_needed} onChange={(e) => set({ help_needed: e.target.value })}
            placeholder="Pricing approval for 40 centres" />
        </Field>
        <Field label="From whom" hint="Told when you send the review">
          <PersonSelect value={draft.help_from_user_id} onChange={(v) => set({ help_from_user_id: v })}
            allowNone placeholder="Nobody in particular" />
        </Field>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-sm" onClick={onSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {(dirty || saved) && <span className="small muted">{dirty ? 'Not saved yet' : 'Saved'}</span>}
      </div>
    </div>
  );
}

/** One owner's review for a week: per deal, the record beside what they say. */
export function WeeklyReview() {
  const toast = useToast();
  const [start, setStart] = useState(() => weekOf().start);
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [dirty, setDirty] = useState(() => new Set());
  const [saved, setSaved] = useState(() => new Set());
  const [missing, setMissing] = useState({});
  const [summary, setSummary] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    setData(null);
    api.myWeeklyReview(start).then((r) => {
      setData(r);
      setDrafts(Object.fromEntries(r.deals.map((deal) => [deal.id, blankDraft(deal.item)])));
      setDirty(new Set());
      setSaved(new Set(r.deals.filter((deal) => deal.item).map((deal) => deal.id)));
      setMissing({});
      setSummary(r.review.summary || '');
    }).catch((err) => toast.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  useEffect(load, [load]);

  if (!data) return <Spinner label="Loading your review" />;

  const sent = data.review.status === 'SUBMITTED';
  const live = data.deals.filter((d) => ['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(d.status));
  const closed = data.deals.filter((d) => !['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(d.status));

  const change = (id, draft) => {
    setDrafts((all) => ({ ...all, [id]: draft }));
    setDirty((set) => new Set(set).add(id));
    setMissing((m) => { const next = { ...m }; delete next[id]; return next; });
  };

  const saveOne = async (id) => {
    setSavingId(id);
    try {
      await api.saveWeeklyReviewItem(id, draftBody(drafts[id]), start);
      setDirty((set) => { const next = new Set(set); next.delete(id); return next; });
      setSaved((set) => new Set(set).add(id));
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setSavingId(null);
    }
  };

  const send = async () => {
    setSending(true);
    try {
      for (const id of dirty) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await saveOne(id))) return;
      }
      const result = await api.submitWeeklyReview(summary.trim() || null, start);
      setData(result);
      toast.success('Review sent — anyone you asked for help has been told');
    } catch (err) {
      if (err.details?.code === 'REVIEW_INCOMPLETE') {
        setMissing(Object.fromEntries(err.details.missing.map((m) => [m.opportunity_id, m.missing])));
        document.getElementById(`review-${err.details.missing[0].opportunity_id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      toast.error(err);
    } finally {
      setSending(false);
    }
  };

  const card = (deal, optional = false) => (
    <div key={deal.id} id={`review-${deal.id}`} className={`card card-pad review-item${missing[deal.id] ? ' is-missing' : ''}`}>
      <div className="row wrap" style={{ gap: 6 }}>
        <DealLink accountId={deal.account_id} opportunityId={deal.id} name={deal.name} accountName={deal.account_name} />
        {deal.stage_name && <Badge dot={deal.stage_color}>{deal.stage_name}</Badge>}
        {deal.status !== 'ACTIVE' && <Badge>{deal.status.replace('_', ' ').toLowerCase()}</Badge>}
        {optional && <span className="small muted">closed this week — optional</span>}
      </div>
      <div className="review-grid">
        <div className="stack-sm review-record">
          <span className="stat-label">What the record shows</span>
          <RecordShows outcomes={deal.outcomes} />
          <div className="small muted review-effort">
            Logged by you: {effortWords(deal.activity) || 'nothing'}
          </div>
        </div>
        <div>
          {sent ? <ReviewAnswer item={deal.item} /> : (
            <ReviewForm draft={drafts[deal.id] || blankDraft(null)} onChange={(d) => change(deal.id, d)}
              onSave={() => saveOne(deal.id)} dirty={dirty.has(deal.id)} saved={saved.has(deal.id)}
              saving={savingId === deal.id}
              missing={missing[deal.id]} />
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-between wrap" style={{ gap: 10 }}>
        <WeekPicker start={start} onChange={setStart} />
        <div className="row small" style={{ gap: 6 }}>
          {sent ? <Badge tone="good">Sent {formatDate(data.review.submitted_at, { withTime: true })}</Badge>
            : data.review.status === 'DRAFT' ? <Badge tone="warning">Started, not sent</Badge>
              : <Badge>Not started</Badge>}
        </div>
      </div>
      <div className="small muted">
        For each of your deals: what changed, the evidence, the next milestone, and any help you need. Beside each is
        what the record shows moved; how much you logged is shown apart, because effort is not an outcome.
      </div>

      {data.deals.length === 0 ? (
        <EmptyState title="No deals to review">You do not own or owe the next move on any live deal this week.</EmptyState>
      ) : (
        <>
          {live.map((deal) => card(deal))}
          {closed.map((deal) => card(deal, true))}
          <section className="card card-pad stack-sm">
            <Field label="Anything else about the week?">
              {sent ? <div className="small">{data.review.summary || <span className="muted">—</span>}</div> : (
                <textarea className="textarea" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
              )}
            </Field>
            {!sent && (
              <div className="row wrap" style={{ gap: 8 }}>
                <button type="button" className="btn btn-primary" onClick={send} disabled={sending}>
                  {sending ? 'Sending…' : 'Send my review'}
                </button>
                <span className="small muted">Once sent it is not rewritten. Every live deal needs an answer.</span>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Everyone's reviews, for the people who run the pipeline. */
export function TeamReviews({ departmentId }) {
  const toast = useToast();
  const [start, setStart] = useState(() => weekOf().start);
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
    api.teamWeeklyReviews({ start, department_id: departmentId || undefined })
      .then(setData).catch((err) => toast.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, departmentId]);

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-between wrap" style={{ gap: 10 }}>
        <WeekPicker start={start} onChange={setStart} />
        {data && (
          <span className="small">
            <strong className="tnum">{data.sent}</strong> of {data.reviews.length} sent
            {data.waiting.length > 0 && <span className="muted"> · waiting on {data.waiting.map((u) => u.full_name).join(', ')}</span>}
          </span>
        )}
      </div>
      {!data ? <Spinner label="Loading the team's reviews" /> : (
        <>
          {data.help_requested.length > 0 && (
            <section className="card card-pad stack-sm review-help-card">
              <h3>Help asked for</h3>
              {data.help_requested.map((h, index) => (
                <div key={index} className="week-row small">
                  <span className="grow"><strong>{h.help}</strong>
                    <div className="muted">{h.deal} · {h.account_name} — {h.from}{h.help_from_name ? ` asks ${h.help_from_name}` : ''}</div>
                  </span>
                </div>
              ))}
            </section>
          )}
          {data.reviews.length === 0 && <EmptyState title="Nobody has live deals this week" />}
          {data.reviews.map((r) => (
            <section key={r.user.id} className="card card-pad stack-sm">
              <div className="row-between wrap">
                <span className="row" style={{ gap: 8 }}>
                  <Avatar name={r.user.full_name} color={r.user.avatar_color} size={24} />
                  <strong>{r.user.full_name}</strong>
                </span>
                {r.review.status === 'SUBMITTED' ? <Badge tone="good">Sent {formatDate(r.review.submitted_at)}</Badge>
                  : r.review.status === 'DRAFT' ? <Badge tone="warning">Started, not sent</Badge> : <Badge>Not started</Badge>}
              </div>
              {r.review.summary && <div className="small">“{r.review.summary}”</div>}
              {r.deals.map((deal) => {
                const claims = deal.item && !deal.item.no_change && deal.item.what_changed;
                return (
                  <div key={deal.id} className="team-review-deal">
                    <div className="row wrap" style={{ gap: 6 }}>
                      <DealLink accountId={deal.account_id} opportunityId={deal.id} name={deal.name} accountName={deal.account_name} />
                      {deal.stage_name && <Badge dot={deal.stage_color}>{deal.stage_name}</Badge>}
                    </div>
                    <div className="review-grid">
                      <div className="stack-sm">
                        <span className="stat-label">The record</span>
                        <RecordShows outcomes={deal.outcomes} />
                        {claims && deal.outcomes.length === 0 && (
                          <div className="small review-mismatch">Says something changed; nothing on the record moved.</div>
                        )}
                        <div className="small muted">Logged: {effortWords(deal.activity) || 'nothing'}</div>
                      </div>
                      <div>
                        <span className="stat-label">What they say</span>
                        <ReviewAnswer item={r.review.status === 'SUBMITTED' ? deal.item : null}
                          unsent={r.review.status !== 'SUBMITTED'} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

// ================================================================ correspondence

const isLive = (deal) => ['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(deal.status);

/** Picking the organization when nothing matched, or a different one. */
function OrganizationPicker({ onPick }) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (search.trim().length < 2) { setResults([]); return undefined; }
    const timer = setTimeout(() => {
      api.accounts({ search: search.trim(), limit: 8 }).then((r) => setResults(r.accounts)).catch(() => setResults([]));
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);
  return (
    <div className="stack-sm">
      <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type to find the organization" />
      {results.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {results.map((a) => (
            <button key={a.id} type="button" className="kind-chip" onClick={() => onPick(a)}>{a.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ suggestion, onDone }) {
  const { user } = useAuth();
  const toast = useToast();
  const [account, setAccount] = useState(suggestion.account_id ? { id: suggestion.account_id, name: suggestion.account_name } : null);
  const [picking, setPicking] = useState(!suggestion.account_id);
  const [deals, setDeals] = useState([]);
  const [dealId, setDealId] = useState(suggestion.opportunity_id ? String(suggestion.opportunity_id) : '');
  const [direction, setDirection] = useState(suggestion.direction || 'INBOUND');
  const [tookPlace, setTookPlace] = useState(null);
  const [outcome, setOutcome] = useState('');
  const [withCommitment, setWithCommitment] = useState(false);
  const [commitment, setCommitment] = useState({ what: '', due_on: '' });
  const [withNext, setWithNext] = useState(false);
  const [next, setNext] = useState(() => nextActionDraft(null, user?.id));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const meeting = suggestion.kind === 'MEETING';
  const past = meeting && suggestion.occurred_at && new Date(suggestion.occurred_at).getTime() < Date.now();
  const deal = deals.find((d) => String(d.id) === dealId) || null;

  useEffect(() => {
    if (!account) { setDeals([]); return; }
    api.opportunities({ account_id: account.id }).then((r) => setDeals(r.opportunities.filter(isLive))).catch(() => setDeals([]));
  }, [account]);
  useEffect(() => { if (deal) setNext(nextActionDraft(deal, user?.id)); }, [deal?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async () => {
    setError(null);
    if (!account) return setError('Pick the organization this belongs to');
    if (past && tookPlace !== true) return setError('Say whether it took place — or dismiss it if it did not');
    if (past && outcome.trim().length < 3) return setError('Say what came of the meeting');
    if (withCommitment && commitment.what.trim().length < 3) return setError('Say what they committed to');
    if (withNext) {
      const problem = nextActionProblem(next);
      if (problem) return setError(problem);
    }
    setBusy(true);
    try {
      await api.confirmSuggestion(suggestion.id, {
        account_id: account.id,
        opportunity_id: dealId ? Number(dealId) : null,
        ...(meeting ? { took_place: past ? true : undefined, outcome: past ? outcome.trim() : undefined } : { direction }),
        ...(withCommitment ? { commitment: { what: commitment.what.trim(), due_on: commitment.due_on || null } } : {}),
        ...(withNext && dealId ? nextActionBody(next) : {}),
      });
      toast.success(meeting
        ? (past ? 'Logged as a meeting that took place' : 'Booked as a scheduled meeting')
        : 'Added to the timeline');
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
    return undefined;
  };

  const dismiss = async () => {
    setBusy(true);
    try {
      await api.dismissSuggestion(suggestion.id);
      onDone();
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  const canCommit = meeting ? past && tookPlace === true : direction === 'INBOUND';

  return (
    <div className="card card-pad stack-sm suggestion-card">
      <div className="row-between wrap" style={{ alignItems: 'flex-start' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <Badge tone={meeting ? 'brand' : 'neutral'}>{meeting ? (past ? 'Past meeting' : 'Upcoming meeting') : 'Email'}</Badge>
            <strong>{suggestion.subject || (meeting ? 'Meeting' : '(no subject)')}</strong>
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>
            {suggestion.occurred_at ? formatDate(suggestion.occurred_at, { withTime: true }) : 'no date'}
            {' · '}{suggestion.source === 'GMAIL' ? 'from Gmail' : suggestion.source === 'GOOGLE_CALENDAR' ? 'from Google Calendar' : 'imported'}
          </div>
          <div className="small muted truncate" title={suggestion.participants}>{suggestion.participants}</div>
        </div>
      </div>
      {suggestion.snippet && (
        <button type="button" className={`suggestion-snippet small${open ? ' is-open' : ''}`} onClick={() => setOpen((v) => !v)}>
          {suggestion.snippet}
        </button>
      )}

      <div className="grid-2">
        <Field label="Organization *">
          {account && !picking ? (
            <div className="row wrap" style={{ gap: 6 }}>
              <strong className="small">{account.name}</strong>
              <span className="small muted">
                {account.id === suggestion.account_id
                  ? (suggestion.contact_name ? `matched to ${suggestion.contact_name}` : 'matched by their email domain')
                  : 'chosen by you'}
              </span>
              <button type="button" className="btn-link small" onClick={() => setPicking(true)}>change</button>
            </div>
          ) : (
            <OrganizationPicker onPick={(a) => { setAccount(a); setDealId(''); setPicking(false); }} />
          )}
        </Field>
        <Field label="Which deal">
          <select className="select" value={dealId} onChange={(e) => setDealId(e.target.value)} disabled={!account}>
            <option value="">The organization in general</option>
            {deals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </div>

      {!meeting && (
        <Field label="Which way?">
          <select className="select" value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="INBOUND">They wrote to us — counts as hearing from them</option>
            <option value="OUTBOUND">We wrote to them — counts as chasing</option>
          </select>
        </Field>
      )}

      {meeting && past && (
        <Field label="Did it take place? *">
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className={`kind-chip${tookPlace === true ? ' is-active' : ''}`} onClick={() => setTookPlace(true)}>Yes, it happened</button>
            <button type="button" className={`kind-chip${tookPlace === false ? ' is-active' : ''}`} onClick={() => setTookPlace(false)}>No</button>
          </div>
          {tookPlace === false && <div className="small muted" style={{ marginTop: 4 }}>Then dismiss it — a calendar entry is not a meeting.</div>}
        </Field>
      )}
      {meeting && past && tookPlace === true && (
        <Field label="What came of it? *">
          <textarea className="textarea" rows={2} value={outcome} onChange={(e) => setOutcome(e.target.value)}
            placeholder="Agreed the rate card; they want 40 centres from November" />
        </Field>
      )}
      {meeting && !past && (
        <div className="small muted">Will be booked as a scheduled meeting. Its outcome is asked for after it happens.</div>
      )}

      {canCommit && (
        <label className="check small">
          <input type="checkbox" checked={withCommitment} onChange={(e) => setWithCommitment(e.target.checked)} />
          They committed to doing something
        </label>
      )}
      {canCommit && withCommitment && (
        <div className="grid-2">
          <Field label="What? *">
            <input className="input" value={commitment.what} onChange={(e) => setCommitment({ ...commitment, what: e.target.value })}
              placeholder="Confirm volumes for the second season" />
          </Field>
          <Field label="By when">
            <input className="input" type="date" value={commitment.due_on} onChange={(e) => setCommitment({ ...commitment, due_on: e.target.value })} />
          </Field>
        </div>
      )}
      {dealId && (
        <label className="check small">
          <input type="checkbox" checked={withNext} onChange={(e) => setWithNext(e.target.checked)} />
          This changes what happens next on the deal
        </label>
      )}
      {dealId && withNext && <NextActionFields value={next} onChange={setNext} />}

      {error && <div className="field-error small">{error}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={confirm} disabled={busy || (meeting && past && tookPlace === false)}>
          {meeting ? (past ? 'Log it' : 'Book it') : 'Add to the timeline'}
        </button>
        <button type="button" className="btn btn-sm" onClick={dismiss} disabled={busy}>Dismiss</button>
      </div>
    </div>
  );
}

/** Reading my own Gmail and Calendar: only if an admin allows it and I switch it on. */
function MailboxSync({ onSuggestions }) {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.mailboxSync().then(setState).catch(() => setState(null)); }, []);
  if (!state) return null;
  const { availability, mine } = state;

  if (!availability.available) {
    return (
      <div className="small muted">
        Reading your Gmail and Calendar is not available: {availability.reason.charAt(0).toLowerCase() + availability.reason.slice(1)}.
        You can still import emails and calendar files below.
      </div>
    );
  }

  const set = async (patch) => {
    setBusy(true);
    try {
      setState(await api.setMailboxSync(patch));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.runMailboxSync();
      onSuggestions(r.suggestions);
      toast.success(`Found ${r.result.emails} email${r.result.emails === 1 ? '' : 's'} and ${r.result.events} event${r.result.events === 1 ? '' : 's'} with pipeline organizations`);
      setState(await api.mailboxSync());
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <div className="row wrap" style={{ gap: 14 }}>
        <label className="check small">
          <input type="checkbox" checked={mine.gmail_enabled} disabled={busy} onChange={(e) => set({ gmail_enabled: e.target.checked })} />
          Read my Gmail
        </label>
        <label className="check small">
          <input type="checkbox" checked={mine.calendar_enabled} disabled={busy} onChange={(e) => set({ calendar_enabled: e.target.checked })} />
          Read my Calendar
        </label>
        {(mine.gmail_enabled || mine.calendar_enabled) && (
          <button type="button" className="btn btn-sm" onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Check now'}</button>
        )}
      </div>
      <div className="small muted">
        Only correspondence with the pipeline’s contacts and organization domains, from the last {availability.lookbackDays} days —
        subject, sender and a short preview. Checked about hourly while it is on. Nothing is logged until you confirm it.
        {mine.last_synced_at && ` Last checked ${relativeTime(mine.last_synced_at)}.`}
      </div>
      {mine.last_error && <div className="small field-error">The last check failed: {mine.last_error}</div>}
    </div>
  );
}

/** Correspondence brought in from outside, waiting to be confirmed or dismissed. */
export function Correspondence({ onCount }) {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  const show = useCallback((list) => {
    setSuggestions(list);
    onCount?.(list.length);
  }, [onCount]);
  const load = useCallback(() => {
    api.crmSuggestions().then((r) => show(r.suggestions)).catch((err) => toast.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);
  useEffect(load, [load]);

  const importText = async (raw, name = '') => {
    const calendar = /\.ics$/i.test(name) || /BEGIN:VCALENDAR/.test(raw);
    if (calendar) {
      const r = await api.importCalendar({ raw });
      const parts = [
        `${r.suggested} to confirm`,
        r.already && `${r.already} already on the record or waiting`,
        r.internal && `${r.internal} internal`,
        r.cancelled && `${r.cancelled} cancelled`,
      ].filter(Boolean);
      toast.success(`${r.events} event${r.events === 1 ? '' : 's'} read: ${parts.join(', ')}`);
      return;
    }
    const r = await api.importEmail({ raw });
    if (r.suggestion) {
      toast.success(r.suggestion.account_id ? 'Matched — confirm it below' : 'No organization matched — pick one below');
    } else {
      toast.success(r.skipped === 'already_logged' ? 'That email is already on the timeline' : 'That email is already waiting below');
    }
  };

  const importFiles = async (files) => {
    setBusy(true);
    try {
      for (const file of files) {
        if (file.size > 850_000) {
          toast.error(`${file.name} is too large — save the email without attachments`);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await importText(await file.text(), file.name);
      }
      load();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const importPasted = async () => {
    if (pasted.trim().length < 10) return toast.error('Paste the whole email, with its From, To, Date and Subject lines');
    setBusy(true);
    try {
      await importText(pasted);
      setPasted('');
      setPasting(false);
      load();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <section className="card card-pad stack-sm">
        <h3>Bring in correspondence</h3>
        <div className="small muted">
          Emails and calendar entries become suggestions. Each one is checked against the pipeline’s contacts and
          organizations, and lands on a timeline only when you confirm it — dated when it happened, not when it was imported.
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Icon name="paperclip" size={13} /> Import .eml or .ics files
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setPasting((v) => !v)} disabled={busy}>
            <Icon name="note" size={13} /> Paste an email
          </button>
          <input ref={fileInput} type="file" multiple hidden accept=".eml,.ics,message/rfc822,text/calendar,text/plain"
            onChange={(e) => importFiles([...e.target.files])} />
        </div>
        {pasting && (
          <div className="stack-sm">
            <textarea className="textarea mono" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)}
              placeholder={'In Gmail: ⋮ → Show original → Copy to clipboard, then paste here.\n\nFrom: Rajesh Kumar <rajesh@farmart.co>\nTo: you@ekosight.com\nDate: …\nSubject: …'} />
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" onClick={importPasted} disabled={busy}>Read it</button>
              <button type="button" className="btn btn-sm" onClick={() => setPasting(false)}>Cancel</button>
            </div>
          </div>
        )}
        <hr className="divider" />
        <MailboxSync onSuggestions={show} />
      </section>

      {!suggestions ? <Spinner label="Loading suggestions" /> : suggestions.length === 0 ? (
        <EmptyState title="Nothing waiting">Imported emails and calendar entries appear here to confirm.</EmptyState>
      ) : (
        <div className="stack-sm">
          <div className="stat-label">{suggestions.length} waiting to be confirmed</div>
          {suggestions.map((s) => <SuggestionCard key={s.id} suggestion={s} onDone={load} />)}
        </div>
      )}
    </div>
  );
}
