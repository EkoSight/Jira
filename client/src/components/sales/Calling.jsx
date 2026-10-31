import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { EmptyState, Field, Icon, Spinner } from '../ui.jsx';
import { fieldValueLabel, phoneLabel, toIso, when } from '../../lib/sales.js';
import { CategoryBadge, CallStatusBadge, Stars } from './parts.jsx';

const GROUPS = [
  ['NOT_CONNECTED', 'Didn’t connect'],
  ['CONNECTED', 'Spoke to them'],
  ['CLOSE', 'Close the lead'],
];
const groupOf = (s) => (['WON', 'DISQUALIFIED'].includes(s.lifecycle) ? 'CLOSE' : s.outcome === 'NONE' ? null : s.outcome);

/** Times a callback is usually booked for, in the person's own clock. */
function callbackChoices() {
  const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
  const inHour = new Date(Date.now() + 3600_000);
  const tomorrow = at(1, 10, 30);
  const evening = at(0, 17, 30);
  return [
    ['In an hour', inHour],
    ...(evening > new Date(Date.now() + 30 * 60_000) ? [['This evening', evening]] : []),
    ['Tomorrow morning', tomorrow],
    ['In 3 days', at(3, 10, 30)],
  ];
}

/**
 * How the call went, in one form: the calling status, a note, a lost reason
 * when the lead is lost, a callback if one was agreed, and stars. Saving logs
 * the call (unless the status means nobody was called).
 */
export function CallStatusForm({ lead, meta, onDone, submitLabel = 'Save' }) {
  const toast = useToast();
  const statuses = (meta.call_statuses || []).filter((s) => s.is_active && groupOf(s));
  const [statusId, setStatusId] = useState(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [otherReason, setOtherReason] = useState('');
  const [callback, setCallback] = useState('');
  const [rating, setRating] = useState(lead.rating || null);
  const [saving, setSaving] = useState(false);
  const status = statuses.find((s) => s.id === statusId);
  const reasons = meta.settings?.calling?.lostReasons || [];
  const lostReason = reason === '__other' ? otherReason.trim() : reason;
  const closes = status && ['WON', 'DISQUALIFIED'].includes(status.lifecycle);
  useEffect(() => { setStatusId(null); setNote(''); setReason(''); setOtherReason(''); setCallback(''); setRating(lead.rating || null); }, [lead.id, lead.rating]);

  const save = async () => {
    if (!status) return;
    setSaving(true);
    try {
      const r = await api.sales.post(`/leads/${lead.id}/call-status`, {
        status_id: status.id, note: note.trim() || null, lost_reason: status.needs_reason ? lostReason : null,
        callback_at: callback && !closes ? toIso(callback) : null, rating: rating || null,
      });
      toast.success(r.exhausted ? `${status.label} — tried ${r.attempts} times; no more automatic retries. Close it or book a callback.`
        : r.lead.retry_at ? `${status.label} — will come up again ${when(r.lead.retry_at)}` : status.label);
      onDone?.(r);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="stack-sm call-form">
      {GROUPS.map(([g, label]) => {
        const list = statuses.filter((s) => groupOf(s) === g);
        if (!list.length) return null;
        return (
          <div key={g} className="stack-xs">
            <span className="small muted">{label}</span>
            <div className="row wrap" style={{ gap: 6 }} role="radiogroup" aria-label={label}>
              {list.map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={statusId === s.id}
                  className={`kind-chip call-chip${statusId === s.id ? ' is-active' : ''}`} style={{ '--status-color': s.color || 'var(--brand)' }}
                  onClick={() => setStatusId(s.id)}>{s.label}</button>
              ))}
            </div>
          </div>
        );
      })}
      {status?.needs_reason && (
        <Field label="Why? *">
          <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason</option>{reasons.map((r) => <option key={r} value={r}>{r}</option>)}<option value="__other">Something else…</option>
          </select>
          {reason === '__other' && <input className="input" style={{ marginTop: 6 }} value={otherReason} onChange={(e) => setOtherReason(e.target.value)} placeholder="What happened" />}
        </Field>
      )}
      <Field label="What was said">
        <textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={status?.outcome === 'NOT_CONNECTED' ? 'Optional' : 'Crops, shop, what they want, objections…'} />
      </Field>
      {status && !closes && (
        <Field label="Call back" hint={status.retry_after_minutes && !callback ? `Left blank, it comes up again in ${status.retry_after_minutes >= 120 ? `${Math.round(status.retry_after_minutes / 60)} hours` : `${status.retry_after_minutes} minutes`}` : 'They asked to be called at a time'}>
          <div className="row wrap" style={{ gap: 6 }}>
            {callbackChoices().map(([label, d]) => {
              const v = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
              return <button key={label} type="button" aria-pressed={callback === v} className={`kind-chip${callback === v ? ' is-active' : ''}`} onClick={() => setCallback(callback === v ? '' : v)}>{label}</button>;
            })}
            <input className="input" type="datetime-local" aria-label="Call back at" style={{ maxWidth: 220 }} value={callback} onChange={(e) => setCallback(e.target.value)} />
          </div>
        </Field>
      )}
      <div className="row-between wrap" style={{ gap: 8 }}>
        <span className="row small" style={{ gap: 6 }}>Rating <Stars value={rating} onChange={setRating} /></span>
        <button type="button" className="btn btn-primary" disabled={!status || saving || (status.needs_reason && !lostReason)} onClick={save}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

const REASON = { CALLBACK: ['Call back', 'brand'], NEW: ['New lead', 'good'], RETRY: ['Try again', 'warning'] };

/** The day's calling, one lead at a time, as TeleCRM's dialler list did. */
export function Calling({ meta }) {
  const { user, can } = useAuth();
  const [who, setWho] = useState(user.id);
  const [data, setData] = useState(null);
  const [skipped, setSkipped] = useState(new Set());
  const load = useCallback(() => {
    api.sales.get('/call-queue', { user_id: who, limit: 60 }).then(setData).catch((err) => setData({ error: err.message }));
  }, [who]);
  useEffect(() => { setData(null); load(); }, [load]);
  const items = useMemo(() => (data?.items || []).filter((i) => !skipped.has(i.id)), [data, skipped]);
  const current = items[0];
  const rowFields = (meta.lead_fields || []).filter((f) => f.is_active && f.show_in_list);
  const fieldsOf = (l) => rowFields.map((f) => fieldValueLabel(f, l.custom_fields?.[f.key])).filter(Boolean).join(' · ');
  const others = can('crm.assign') || can('crm.view.team');

  if (!data) return <Spinner label="Finding who to call" />;
  if (data.error) return <EmptyState title="The call list could not load">{data.error}</EmptyState>;
  const c = data.counts;
  return (
    <div className="stack">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <div className="row wrap small call-counts">
          <span><strong className="tnum">{c.callbacks_due}</strong> callbacks due</span>
          <span><strong className="tnum">{c.new}</strong> new</span>
          <span><strong className="tnum">{c.retries_due}</strong> to try again</span>
          <span className="muted"><strong className="tnum">{c.retries_later}</strong> later</span>
          <span className="muted"><strong className="tnum">{c.calls_today}</strong> calls today</span>
        </div>
        {others && (
          <select className="select" style={{ width: 'auto' }} aria-label="Whose calls" value={who} onChange={(e) => { setSkipped(new Set()); setWho(Number(e.target.value)); }}>
            <option value={user.id}>My calls</option>
            {meta.users.filter((u) => u.is_active && u.id !== user.id).map((u) => <option key={u.id} value={u.id}>{u.full_name}’s calls</option>)}
          </select>
        )}
      </div>
      {!current ? (
        <EmptyState title={skipped.size ? 'You have skipped the rest' : 'Nobody to call right now'}>
          {skipped.size ? <button type="button" className="btn btn-sm" onClick={() => setSkipped(new Set())}>Show the skipped ones again</button>
            : c.retries_later ? `${c.retries_later} lead${c.retries_later === 1 ? '' : 's'} will come up again later. New leads and callbacks appear here as they arrive.` : 'New leads and callbacks appear here as they arrive.'}
        </EmptyState>
      ) : (
        <section className="card call-card" aria-label="Lead to call now">
          <div className="card-pad stack-sm">
            <div className="row-between wrap" style={{ gap: 6 }}>
              <span className={`badge badge-${REASON[current.queue_reason][1]}`}>{REASON[current.queue_reason][0]}{current.queue_reason === 'CALLBACK' && current.callback_due ? ` · ${when(current.callback_due)}` : ''}</span>
              <span className="small muted">{items.length} in the list{current.call_attempts ? ` · tried ${current.call_attempts}×` : ''}</span>
            </div>
            <div className="stack-xs">
              <Link to={`/sales/leads/${current.id}`} className="call-name">{current.display_name === current.phone ? phoneLabel(current.phone) : current.display_name}</Link>
              <div className="row wrap small" style={{ gap: 6 }}>
                <CategoryBadge category={current.category} /><CallStatusBadge lead={current} /><Stars value={current.rating} />
                <span className="muted">{[current.contact_name !== current.display_name && current.contact_name, current.city, current.state].filter(Boolean).join(' · ')}</span>
              </div>
              {fieldsOf(current) && <div className="small">{fieldsOf(current)}</div>}
              {current.requirement && <div className="small">{current.requirement}</div>}
              {current.last_note && <blockquote className="call-note small">{current.last_note}</blockquote>}
            </div>
            {current.phone ? (
              <a className="btn btn-primary call-dial" href={`tel:${current.phone.replace(/[^\d+]/g, '')}`}>
                <Icon name="phone" size={16} /> Call {phoneLabel(current.phone)}
              </a>
            ) : <div className="small critical-text">No phone number on this lead.</div>}
            <div className="small muted">Your phone dials; TaskFlow does not record the call. Afterwards, say how it went.</div>
            <CallStatusForm lead={current} meta={meta} submitLabel="Save and next" onDone={() => load()} />
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSkipped((s) => new Set([...s, current.id]))}>Skip for now</button>
              <Link to={`/sales/leads/${current.id}`} className="btn btn-sm btn-ghost">Open the lead</Link>
            </div>
          </div>
        </section>
      )}
      {items.length > 1 && (
        <section className="card">
          <div className="card-head"><h3>Next up</h3></div>
          <div className="card-pad stack-xs">
            {items.slice(1, 12).map((l) => (
              <div key={l.id} className="sales-row small">
                <span className={`badge badge-${REASON[l.queue_reason][1]}`}>{REASON[l.queue_reason][0]}</span>
                <Link to={`/sales/leads/${l.id}`} className="grow truncate">{l.display_name}</Link>
                <CallStatusBadge lead={l} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
