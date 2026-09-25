import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Avatar, Badge, Field, Icon, Modal, Spinner } from './ui.jsx';
import { crmSignalMeta } from '../lib/crm.js';
import { formatDate } from '../lib/format.js';

/**
 * What needs a nudge, and why.
 *
 * Every line says what is wrong, what the stage expected, and what to do about
 * it — a list that only says "attention" trains people to ignore it.
 *
 * A nudge can be put down, but only with a reason and a date. That is deliberate:
 * dismiss-forever turns the whole list into noise within a fortnight, whereas "not
 * until the 14th, because their board meets then" is a real answer that somebody
 * can be held to.
 */

const ENTITY_LABEL = {
  OPPORTUNITY: 'deal',
  MEETING: 'meeting',
  ENGAGEMENT: 'delivery',
  ACCOUNT: 'organization',
};

function SnoozeDialog({ signal, onClose, onSnoozed }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(7);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (reason.trim().length < 3) {
      return toast.error('Say why — a nudge put down without a reason comes back as noise');
    }
    setSaving(true);
    try {
      await api.snoozeNudge({
        entity_type: signal.entity_type,
        entity_id: signal.entity_id,
        kind: signal.kind,
        reason: reason.trim(),
        days: Number(days),
      });
      toast.success(`Quiet for ${days} day${Number(days) === 1 ? '' : 's'}`);
      onSnoozed();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Put this down: ${signal.title}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Put it down'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          It comes back when the time is up. There is no "never" — if this really does not need
          doing, close the {ENTITY_LABEL[signal.entity_type] || 'record'} instead of silencing it.
        </div>
        <Field label="Why is this alright for now? *">
          <textarea className="textarea" rows={2} autoFocus value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Their board meets on the 14th — nothing moves before that." />
        </Field>
        <Field label="For how long">
          <select className="select" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value={3}>3 days</option>
            <option value={7}>A week</option>
            <option value={14}>A fortnight</option>
            <option value={30}>A month</option>
            <option value={90}>A quarter</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

export default function CrmNudges({ departmentId, compact = false }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [snoozes, setSnoozes] = useState([]);
  const [snoozing, setSnoozing] = useState(null);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [kindFilter, setKindFilter] = useState('');
  const [scanning, setScanning] = useState(false);

  const load = () => {
    api.crmNudges({ department_id: departmentId || undefined })
      .then(setData).catch((err) => toast.error(err));
    api.crmSnoozes().then((r) => setSnoozes(r.snoozes)).catch(() => setSnoozes([]));
  };

  useEffect(load, [departmentId]);

  if (!data) return <Spinner label="Working out what needs a nudge" />;

  const shown = kindFilter
    ? data.attention.filter((s) => s.kind === kindFilter)
    : data.attention;
  const limit = compact ? 6 : shown.length;

  if (data.summary.total === 0 && snoozes.length === 0) {
    return (
      <section className="card card-pad attention-clear">
        <div className="row" style={{ gap: 10 }}>
          <span className="sig-dot sig-good" aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 650 }}>Nothing is drifting</div>
            <div className="small muted">
              Every deal has been spoken to inside its stage's cadence, every meeting has an
              outcome, and no milestone is overdue.
            </div>
          </div>
        </div>
      </section>
    );
  }

  const kinds = [...new Set(data.attention.map((s) => s.kind))];

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>Needs a nudge</h2>
          <div className="small muted">
            {data.summary.total === 0
              ? 'Nothing outstanding right now.'
              : `${data.summary.total} thing${data.summary.total === 1 ? '' : 's'} drifting.`}
            {snoozes.length > 0 && ` ${snoozes.length} put down for now.`}
          </div>
        </div>
        <button type="button" className="btn btn-sm" disabled={scanning} onClick={async () => {
          setScanning(true);
          try {
            const result = await api.runCrmScan();
            toast.success(result.notified?.length
              ? `Reminded ${result.notified.length} ${result.notified.length === 1 ? 'person' : 'people'}`
              : 'Everyone has already been reminded today');
          } catch (err) { toast.error(err); } finally { setScanning(false); }
        }}>
          <Icon name="bell" size={13} /> {scanning ? 'Sending…' : 'Remind the owners'}
        </button>
      </div>

      {kinds.length > 1 && (
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className={`kind-chip${kindFilter === '' ? ' is-active' : ''}`}
            onClick={() => setKindFilter('')}>
            Everything ({data.summary.total})
          </button>
          {kinds.map((kind) => {
            const meta = crmSignalMeta(kind);
            const count = data.attention.filter((s) => s.kind === kind).length;
            return (
              <button key={kind} type="button"
                className={`kind-chip${kindFilter === kind ? ' is-active' : ''}`}
                onClick={() => setKindFilter(kind)}>
                {meta.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      <div className="stack-sm">
        {shown.slice(0, limit).map((signal) => {
          const meta = crmSignalMeta(signal.kind);
          return (
            <div key={`${signal.entity_type}-${signal.entity_id}-${signal.kind}`} className="nudge-row">
              <span className={`sig-dot sig-${signal.severity}`} aria-hidden="true" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <Link to={`/accounts/${signal.account_id}`} className="nudge-title">
                    {signal.title}
                  </Link>
                  <Badge tone={signal.severity === 'critical' ? 'critical' : 'warning'}>
                    {meta.label}
                  </Badge>
                  <span className="small muted">{ENTITY_LABEL[signal.entity_type]}</span>
                </div>
                <div className="small muted">
                  {signal.subtitle}
                  {signal.stage_name && ` · ${signal.stage_name}`}
                  {` — ${signal.detail}`}
                </div>
                {meta.action && (
                  <div className="small nudge-action">
                    <Icon name="chevron" size={11} /> {meta.action}
                  </div>
                )}
              </div>
              {signal.owner_name && (
                <Avatar name={signal.owner_name} color={signal.owner_color} size={22}
                  title={`${signal.owner_name} leads this`} />
              )}
              <button type="button" className="btn btn-sm btn-ghost"
                onClick={() => setSnoozing(signal)}>
                Not now
              </button>
            </div>
          );
        })}
        {compact && shown.length > limit && (
          <div className="small muted">and {shown.length - limit} more</div>
        )}
      </div>

      {!compact && data.by_person.length > 1 && (
        <div className="stack-sm">
          <div className="stat-label">Whose they are</div>
          <div className="row wrap" style={{ gap: 8 }}>
            {data.by_person.map((person) => (
              <span key={person.user_id} className="row owner-pill" style={{ gap: 6 }}>
                <Avatar name={person.name} color={person.color} size={20} />
                <span className="small">{person.name}</span>
                <Badge tone={person.critical > 0 ? 'critical' : 'warning'}>{person.total}</Badge>
              </span>
            ))}
          </div>
        </div>
      )}

      {snoozes.length > 0 && (
        <div className="stack-sm">
          <button type="button" className="disclosure" onClick={() => setShowSnoozed(!showSnoozed)}>
            <Icon name="chevron" size={12}
              style={{ transform: showSnoozed ? 'rotate(90deg)' : 'none' }} />
            Put down for now ({snoozes.length})
          </button>
          {showSnoozed && (
            <ul className="plain-list">
              {snoozes.map((snooze) => (
                <li key={snooze.id} className="row" style={{ gap: 8 }}>
                  <Icon name="clock" size={14} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 13 }}>
                      {crmSignalMeta(snooze.kind).label} on a {ENTITY_LABEL[snooze.entity_type] || 'record'}
                    </strong>
                    <div className="small muted">
                      until {formatDate(snooze.until)}
                      {snooze.created_by_name && ` · ${snooze.created_by_name}`}
                    </div>
                    <div className="small">{snooze.reason}</div>
                  </span>
                  <button type="button" className="btn btn-sm" onClick={async () => {
                    try {
                      await api.unsnoozeNudge(snooze.id);
                      toast.success('Back on the list');
                      load();
                    } catch (err) { toast.error(err); }
                  }}>
                    Bring it back
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {snoozing && (
        <SnoozeDialog signal={snoozing} onClose={() => setSnoozing(null)} onSnoozed={load} />
      )}
    </section>
  );
}
