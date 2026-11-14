/**
 * The full lists behind My workspace's widgets and summary counts:
 * /workspace/attention, /workspace/decisions, /workspace/waiting and
 * /workspace/deals. Each asks the same endpoint as its widget, so the number
 * on the widget is the number of rows here.
 */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Spinner } from '../components/ui.jsx';
import { useWidgetData } from '../components/workspace/Widgets.jsx';
import { shortDateTime } from '../lib/workspace.js';
import { AttentionRow, DealRow, DecisionRow, SnoozeDialog, WaitingRow } from '../components/workspace/RecordWidgets.jsx';

const ATTENTION_VIEWS = [['today', 'Today & overdue'], ['coming', 'Coming up'], ['overdue', 'Overdue'], ['due_today', 'Due today'], ['decisions', 'Decisions'], ['all', 'All']];
const TITLES = { attention: 'Needs attention', decisions: 'Needs my decision', waiting: 'Waiting on others', deals: 'My deals' };
const ENDPOINT = { attention: '/workspace/attention', decisions: '/workspace/decisions', waiting: '/workspace/waiting', deals: '/workspace/widgets/deals' };

export default function WorkspaceList() {
  const { list } = useParams();
  const [params, setParams] = useSearchParams();
  const [snoozing, setSnoozing] = useState(null);
  const [bump, setBump] = useState(0);
  const view = params.get('view') || 'all';
  const snoozed = params.get('snoozed') === '1';
  const scope = params.get('scope') || 'mine';
  const known = Boolean(ENDPOINT[list]);
  const state = useWidgetData(() => (known ? api.get(ENDPOINT[list], {
    limit: 200,
    ...(list === 'attention' ? { view, snoozed: snoozed ? '1' : undefined } : {}),
    ...(list === 'deals' ? { scope } : {}),
  }) : Promise.resolve(null)), [list, view, snoozed, scope, bump]);
  const d = state.data;
  if (!known) return <div className="card card-pad">There is no such list. <Link to="/">Back to My workspace</Link></div>;

  const unsnooze = async (key) => { await api.post('/workspace/attention/unsnooze', { key }); setBump((b) => b + 1); };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <div className="small"><Link className="crumb-link" to="/">My workspace</Link></div>
          <h1 style={{ margin: 0 }}>{TITLES[list]}{list === 'deals' && scope === 'team' ? ' (my team)' : ''}</h1>
          {d && <div className="small muted">{d.total} {d.total === 1 ? 'item' : 'items'}</div>}
        </div>
      </div>
      {list === 'attention' && (
        <div className="ws-tabs" role="group" aria-label="Show" style={{ padding: 0 }}>
          {ATTENTION_VIEWS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={!snoozed && view === k} className={`kind-chip${!snoozed && view === k ? ' is-active' : ''}`} onClick={() => setParams({ view: k })}>
              {label}{d?.counts?.[k] != null ? ` · ${d.counts[k]}` : ''}
            </button>
          ))}
          <button type="button" aria-pressed={snoozed} className={`kind-chip${snoozed ? ' is-active' : ''}`} onClick={() => setParams({ view: 'all', snoozed: '1' })}>Including snoozed</button>
        </div>
      )}
      <section className="card">
        {state.loading && !d && <div className="ws-state"><Spinner label="Loading" /></div>}
        {state.error && <div className="ws-state" role="alert">Could not load this: {state.error.message} <button type="button" className="btn btn-sm" onClick={state.retry}>Retry</button></div>}
        {d && !d.items.length && <div className="ws-state ws-empty">Nothing here.</div>}
        {d && (
          <ul className="ws-list">
            {list === 'attention' && d.items.map((it) => (
              <AttentionRow key={it.key} it={it} timezone={d.timezone} expanded onSnooze={it.snoozed_until ? null : setSnoozing}>
                {it.snoozed_until && <div className="small muted row" style={{ gap: 8, padding: '0 16px 8px' }}>Snoozed by you until {shortDateTime(it.snoozed_until)} <button type="button" className="btn btn-ghost btn-sm" onClick={() => unsnooze(it.key)}>Bring back now</button></div>}
              </AttentionRow>
            ))}
            {list === 'decisions' && d.items.map((x) => <DecisionRow key={x.key} d={x} />)}
            {list === 'waiting' && d.items.map((x) => <WaitingRow key={x.key} w={x} />)}
            {list === 'deals' && d.items.map((x) => <DealRow key={x.id} d={x} />)}
          </ul>
        )}
      </section>
      {snoozing && <SnoozeDialog item={snoozing} timezone={d?.timezone} onClose={() => setSnoozing(null)} onDone={() => { setSnoozing(null); setBump((b) => b + 1); }} />}
    </div>
  );
}
