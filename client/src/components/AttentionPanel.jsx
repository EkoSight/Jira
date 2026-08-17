import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Badge, Icon } from './ui.jsx';
import { SEVERITY_TONE, signalMeta } from '../lib/okr.js';

/**
 * What the system has noticed on its own. Critical first, because a review opens
 * with what is on fire, not with a full list.
 */
function SignalRow({ signal }) {
  const meta = signalMeta(signal.kind);
  const tone = SEVERITY_TONE[signal.severity] || 'neutral';
  const inner = (
    <>
      <span className={`sig-dot sig-${signal.severity}`} aria-hidden="true" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }} className="truncate">{signal.title}</span>
          <Badge tone={tone}>{meta.label}</Badge>
        </div>
        <div className="small muted">
          {signal.entity_type === 'KEY_RESULT' && signal.objective_title
            ? `${signal.objective_title} — ${signal.detail}`
            : signal.detail}
        </div>
      </div>
      {signal.owner_name && signal.entity_type !== 'DEPARTMENT' && (
        <span className="row" style={{ gap: 6 }}>
          <Avatar name={signal.owner_name} color={signal.owner_color} size={22} />
        </span>
      )}
    </>
  );

  if (signal.objective_id) {
    return <Link to={`/goals/${signal.objective_id}`} className="sig-row">{inner}</Link>;
  }
  return <div className="sig-row">{inner}</div>;
}

export default function AttentionPanel({ insights, onRunScan, canScan }) {
  const [showAll, setShowAll] = useState(false);
  const [scanning, setScanning] = useState(false);

  if (!insights) return null;
  const { summary, attention } = insights;

  if (summary.total_signals === 0) {
    return (
      <section className="card card-pad attention-clear">
        <div className="row" style={{ gap: 10 }}>
          <span className="sig-dot sig-good" aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 650 }}>Nothing needs attention</div>
            <div className="small muted">
              Every active goal is moving and nobody is behind. The system is watching — you will hear if that changes.
            </div>
          </div>
        </div>
      </section>
    );
  }

  const shown = showAll ? attention : attention.slice(0, 6);

  const runScan = async () => {
    setScanning(true);
    try {
      await onRunScan();
    } finally {
      setScanning(false);
    }
  };

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>Needs attention</h2>
          <div className="small muted">
            {summary.critical > 0 && <span className="crit-count">{summary.critical} critical</span>}
            {summary.critical > 0 && summary.warning > 0 && ' · '}
            {summary.warning > 0 && `${summary.warning} to watch`}
          </div>
        </div>
        {canScan && (
          <button type="button" className="btn btn-sm" onClick={runScan} disabled={scanning}>
            <Icon name="bell" size={13} /> {scanning ? 'Sending…' : 'Remind owners now'}
          </button>
        )}
      </div>

      <div className="stack-sm">
        {shown.map((signal, index) => (
          <SignalRow key={`${signal.kind}-${signal.objective_id ?? ''}-${signal.key_result_id ?? signal.department_id ?? index}`} signal={signal} />
        ))}
      </div>

      {attention.length > 6 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show less' : `Show all ${attention.length}`}
        </button>
      )}
    </section>
  );
}

/** "Who is behind" — the people roll-up, its own small card. */
export function PeopleBehind({ people }) {
  if (!people?.length) return null;
  return (
    <section className="card table-wrap">
      <div className="card-head">
        <h2>Who is behind</h2>
        <span className="small muted">{people.length} people</span>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Person</th>
            <th className="num">Off track</th>
            <th className="num">Behind</th>
            <th className="num">Not moving</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <tr key={person.user_id}>
              <td>
                <span className="row">
                  <Avatar name={person.name} color={person.color} size={24} />
                  <span style={{ fontWeight: 600 }}>{person.name}</span>
                </span>
              </td>
              <td className="num tnum" style={{ color: person.off_track ? 'var(--critical-text)' : 'inherit' }}>
                {person.off_track || '—'}
              </td>
              <td className="num tnum">{person.behind || '—'}</td>
              <td className="num tnum">{person.stale + person.flat || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
