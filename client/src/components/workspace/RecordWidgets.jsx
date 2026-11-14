/**
 * The widgets built on the workspace's own endpoints: Summary, Needs
 * attention, Needs my decision, Waiting on others and Deals (and, from Part D,
 * Meetings and Applications). Imported for their side effect: each registers
 * its renderer with Widgets.jsx.
 *
 * Every count is the length of the list its "Open" link shows: the same
 * endpoint, the same view.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { Badge, Modal } from '../ui.jsx';
import { SCOPE_LABEL } from '../../../../shared/workspaceWidgets.js';
import { WidgetFrame, registerWidget, useWidgetData } from './Widgets.jsx';
import { whenWords } from '../../lib/workspace.js';

const rowsOf = (w) => w.config?.rows || 5;

const TIER_TONE = { 1: 'critical', 2: 'critical', 3: 'brand', 4: 'warning', 5: 'warning', 6: 'neutral' };
const TIER_SHORT = { 1: 'Now', 2: 'Overdue', 3: 'Decision', 4: 'Soon', 5: 'No next action', 6: 'Later' };

export const itemWhen = (it, timeZone) => {
  if (it.when?.date) return whenWords({ date: it.when.date }, { timeZone });
  if (it.when?.at) return whenWords({ at: it.when.at }, { timeZone });
  return null;
};

/** A snooze for one item in my list only. Says plainly what does not change. */
export function SnoozeDialog({ item, timezone, onClose, onDone }) {
  const [choice, setChoice] = useState('tomorrow');
  const [custom, setCustom] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const at9 = (days) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d; };
  const until = choice === 'custom' ? (custom ? new Date(custom) : null) : { tomorrow: at9(1), three: at9(3), week: at9(7) }[choice];
  const deadline = item.when?.date ? new Date(`${item.when.date}T23:59:59`) : item.when?.at ? new Date(item.when.at) : null;
  const pastDeadline = deadline && until && until > deadline && deadline > new Date();
  const save = async () => {
    setBusy(true); setError(null);
    try { await api.post('/workspace/attention/snooze', { key: item.key, until: until.toISOString() }); onDone(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Snooze in my list" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !until} onClick={save}>Snooze</button></>}>
      <div className="stack">
        <p style={{ margin: 0 }}><strong>{item.title}</strong> · {item.record.label}</p>
        <p className="small muted" style={{ margin: 0 }}>Only your list changes. The deadline, owner and status stay as they are, and the record still shows as it is everywhere else. This is not "Change the deadline".</p>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Bring it back</legend>
          {[['tomorrow', 'Tomorrow at 09:00'], ['three', 'In 3 days at 09:00'], ['week', 'In a week at 09:00'], ['custom', 'Choose a date and time']].map(([k, label]) => (
            <label key={k} className="row small" style={{ gap: 6 }}><input type="radio" name="snooze" checked={choice === k} onChange={() => setChoice(k)} />{label}</label>
          ))}
          {choice === 'custom' && <input className="input" type="datetime-local" aria-label="Bring it back on" value={custom} onChange={(e) => setCustom(e.target.value)} />}
        </fieldset>
        {pastDeadline && <p className="small" role="note" style={{ margin: 0 }}>That is after its date ({itemWhen(item, timezone)}). The date does not move; the item will show as overdue elsewhere.</p>}
        {error && <p className="ws-error small" role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
    </Modal>
  );
}

/** One attention row: what to do, why, the record, the date, and Snooze. */
export function AttentionRow({ it, timezone, onSnooze, expanded, children = null }) {
  const when = itemWhen(it, timezone);
  return (
    <li>
      <div className="ws-att">
      <Link className="ws-row" to={it.record.url}>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="row wrap" style={{ gap: 6 }}>
            <Badge tone={TIER_TONE[it.tier]}>{TIER_SHORT[it.tier]}</Badge>
            <strong className="truncate">{it.title}</strong>
          </span>
          <span className="ws-reason truncate" style={{ display: 'block' }}>{it.record.label} · {it.reason}{when ? ` · ${when}` : ''}</span>
          {expanded && it.related?.length > 0 && <span className="ws-reason" style={{ display: 'block' }}>Tracked by a task: one item for both</span>}
        </span>
      </Link>
      {onSnooze && <button type="button" className="btn btn-ghost btn-sm ws-snooze" onClick={() => onSnooze(it)}>Snooze<span className="sr-only"> {it.title}</span></button>}
      </div>
      {children}
    </li>
  );
}

function WhyOrder({ tiers }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Why this order?</button>
      {open && (
        <Modal title="Why this order?" onClose={() => setOpen(false)}>
          <ol className="stack-sm" style={{ margin: 0, paddingLeft: 18 }}>
            {Object.entries(tiers).map(([k, v]) => <li key={k}>{v}</li>)}
          </ol>
          <p className="small muted">Within each group, the earliest date comes first. There is no hidden score.</p>
        </Modal>
      )}
    </>
  );
}

const VIEW_TABS = [['today', 'Today & overdue'], ['coming', 'Coming up'], ['all', 'All']];

function AttentionWidget({ widget, refreshKey }) {
  const [view, setView] = useState(widget.config?.view === 'waiting' ? 'all' : widget.config?.view || 'today');
  const [snoozing, setSnoozing] = useState(null);
  const [bump, setBump] = useState(0);
  const state = useWidgetData(() => api.get('/workspace/attention', { view, limit: rowsOf(widget) }), [view, rowsOf(widget), refreshKey, bump]);
  const d = state.data;
  return (
    <WidgetFrame widget={widget} state={state} count={d ? d.total : null} drill={`/workspace/attention?view=${view}`}
      actions={d ? <WhyOrder tiers={d.tiers} /> : null}
      empty={d && !d.total ? (view === 'today' ? 'Nothing needs you right now' : 'Nothing here') : null}>
      <div className="ws-tabs" role="tablist" aria-label="Show">
        {VIEW_TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={`kind-chip${view === k ? ' is-active' : ''}`} onClick={() => setView(k)}>
            {label}{d?.counts?.[k] != null ? ` · ${d.counts[k]}` : ''}
          </button>
        ))}
        <Link className="kind-chip" to="/workspace/waiting">Waiting on others</Link>
      </div>
      {d && (
        <ul className="ws-list">
          {d.items.map((it) => <AttentionRow key={it.key} it={it} timezone={d.timezone} expanded={widget.config?.density === 'expanded'} onSnooze={setSnoozing} />)}
        </ul>
      )}
      {d && d.snoozed > 0 && <div className="small muted ws-more"><Link to="/workspace/attention?snoozed=1">{d.snoozed} snoozed by you</Link></div>}
      {d?.failed?.length > 0 && <div className="small muted ws-more" role="status">Part of this list could not be loaded just now.</div>}
      {snoozing && <SnoozeDialog item={snoozing} timezone={d?.timezone} onClose={() => setSnoozing(null)} onDone={() => { setSnoozing(null); setBump((b) => b + 1); }} />}
    </WidgetFrame>
  );
}

function SummaryWidget({ widget, refreshKey }) {
  const state = useWidgetData(() => api.get('/workspace/widgets/summary'), [refreshKey]);
  return (
    <WidgetFrame widget={widget} state={state}>
      {state.data && (
        <div className="ws-tiles">
          {state.data.tiles.map((t) => (
            <Link key={t.key} className="stat" to={t.url}>
              <span className="stat-label">{t.label}</span>
              <span className="stat-value tnum">{t.count}</span>
              {t.tone && t.count > 0 && <span className={`badge badge-${t.tone}`} style={{ alignSelf: 'flex-start' }}>{t.tone === 'critical' ? 'Act now' : 'Today'}</span>}
            </Link>
          ))}
        </div>
      )}
    </WidgetFrame>
  );
}

export function DecisionRow({ d }) {
  return (
    <li>
      <Link className="ws-row" to={d.url}>
        <span className="grow" style={{ minWidth: 0 }}>
          <strong className="truncate" style={{ display: 'block' }}>{d.label}: {d.what}</strong>
          <span className="ws-reason">{d.who ? `Asked by ${d.who} · ` : ''}waiting since {whenWords({ at: d.since })}</span>
        </span>
        <span className="btn btn-sm" aria-hidden="true">Open</span>
      </Link>
    </li>
  );
}

function DecisionsWidget({ widget, refreshKey }) {
  const state = useWidgetData(() => api.get('/workspace/decisions', { limit: rowsOf(widget) }), [rowsOf(widget), refreshKey]);
  const d = state.data;
  return (
    <WidgetFrame widget={widget} state={state} count={d ? d.total : null} drill="/workspace/decisions"
      empty={d && !d.total ? 'Nothing is waiting for your decision' : null}>
      <ul className="ws-list">{d?.items.map((x) => <DecisionRow key={x.key} d={x} />)}</ul>
    </WidgetFrame>
  );
}

export function WaitingRow({ w }) {
  return (
    <li>
      <Link className="ws-row" to={w.record.url}>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="row wrap" style={{ gap: 6 }}>
            {w.overdue && <Badge tone="critical">Past the promised date</Badge>}
            {!w.specific && <Badge tone="warning">Nothing recorded</Badge>}
            <strong className="truncate">{w.record.label}</strong>
          </span>
          <span className="ws-reason" style={{ display: 'block' }}>
            {w.what} · from {w.from}{w.since ? ` · since ${whenWords({ date: w.since })}` : ''}{w.promised ? ` · promised ${whenWords({ date: w.promised })}` : ''}{w.next_check ? ` · next check ${whenWords({ date: w.next_check })}` : ''}
          </span>
        </span>
      </Link>
    </li>
  );
}

function WaitingWidget({ widget, refreshKey }) {
  const state = useWidgetData(() => api.get('/workspace/waiting', { limit: rowsOf(widget) }), [rowsOf(widget), refreshKey]);
  const d = state.data;
  return (
    <WidgetFrame widget={widget} state={state} count={d ? d.total : null} drill="/workspace/waiting"
      empty={d && !d.total ? 'You are not waiting on anyone' : null}>
      <ul className="ws-list">{d?.items.map((x) => <WaitingRow key={x.key} w={x} />)}</ul>
    </WidgetFrame>
  );
}

export function DealRow({ d }) {
  return (
    <li>
      <Link className="ws-row" to={d.url}>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="row wrap" style={{ gap: 6 }}>
            {d.overdue && <Badge tone="critical">Overdue</Badge>}
            {d.no_next_action && <Badge tone="warning">No next action</Badge>}
            {d.waiting_on && <Badge tone="neutral">Waiting</Badge>}
            <strong className="truncate">{d.name} · {d.account_name}</strong>
          </span>
          <span className="ws-reason" style={{ display: 'block' }}>
            {d.stage_name}
            {d.next_step ? ` · Next: ${d.next_step}${d.next_step_due ? `, ${whenWords({ date: String(d.next_step_due).slice(0, 10) })}` : ''}` : ''}
            {d.waiting_on ? ` · Waiting on ${d.waiting_on}${d.waiting_until ? ` until ${String(d.waiting_until).slice(0, 10)}` : ''}` : ''}
            {` · Last from them: ${d.last_customer_at ? whenWords({ at: d.last_customer_at }) : 'nothing recorded'}`}
          </span>
        </span>
      </Link>
    </li>
  );
}

function DealsWidget({ widget, refreshKey }) {
  const scope = widget.config?.scope || 'mine';
  const state = useWidgetData(() => api.get('/workspace/widgets/deals', { scope, limit: rowsOf(widget) }), [scope, rowsOf(widget), refreshKey]);
  const d = state.data;
  return (
    <WidgetFrame widget={widget} state={state} count={d ? d.total : null} drill={`/workspace/deals?scope=${scope}`} scope={SCOPE_LABEL[scope]}
      empty={d && !d.total ? 'No open deals. Add a deal when there is one' : null}>
      {d && (d.counts.overdue > 0 || d.counts.no_next_action > 0) && (
        <div className="row wrap ws-pad" style={{ gap: 6 }}>
          {d.counts.overdue > 0 && <Badge tone="critical">{d.counts.overdue} overdue</Badge>}
          {d.counts.no_next_action > 0 && <Badge tone="warning">{d.counts.no_next_action} with no next action</Badge>}
        </div>
      )}
      <ul className="ws-list">{d?.items.map((x) => <DealRow key={x.id} d={x} />)}</ul>
    </WidgetFrame>
  );
}

registerWidget('summary', SummaryWidget);
registerWidget('attention', AttentionWidget);
registerWidget('decisions', DecisionsWidget);
registerWidget('waiting', WaitingWidget);
registerWidget('deals', DealsWidget);

