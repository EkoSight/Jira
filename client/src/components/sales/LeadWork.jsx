import { useEffect, useId, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, Field, Modal, Spinner } from '../ui.jsx';
import { CALL_OUTCOME } from '../../lib/sales.js';
import {
  INDIAN_STATES, LOCATION_FIELDS, NOT_PROVIDED, RECORDED_VIA, exactTime, locationRows, pinProblem,
} from '../../lib/crmWork.js';
import { CALLBACK_REASON, lengthWords } from '../../lib/phoneCalls.js';
import { AttachRecording, ComplaintDialog, RecordingPlayer } from './PhoneCall.jsx';

// ---------------------------------------------------------------- location

export const emptyLocation = (lead = {}) => Object.fromEntries(LOCATION_FIELDS.map(([k]) => [k, lead?.[k] || '']));

/** The location fields that changed, blank meaning "remove it". */
export function locationChanges(form, lead = {}) {
  const out = {};
  for (const [k] of LOCATION_FIELDS) {
    const v = String(form[k] ?? '').trim();
    if (v !== String(lead?.[k] ?? '')) out[k] = v || null;
  }
  return out;
}

/**
 * Where the lead is. State is chosen from the list (or left blank); district
 * offers the districts recorded for that state and accepts a new one; a PIN
 * code is checked for shape only.
 */
export function LocationFields({ value, onChange, legacyState }) {
  const listId = useId();
  const [districts, setDistricts] = useState([]);
  const set = (k, v) => onChange({ ...value, [k]: v });
  useEffect(() => {
    if (!value.state) { setDistricts([]); return undefined; }
    let gone = false;
    const t = setTimeout(() => {
      api.sales.get('/location/districts', { state: value.state, q: value.district || '' })
        .then((r) => { if (!gone) setDistricts(r.districts || []); }).catch(() => {});
    }, 200);
    return () => { gone = true; clearTimeout(t); };
  }, [value.state, value.district]);
  const pin = pinProblem(value.pincode);
  // a state saved before the list existed, and not in it, stays visible until changed
  const unknownState = value.state && !INDIAN_STATES.includes(value.state);
  return (
    <fieldset className="location-fields stack-sm">
      <legend className="h3-like">Location</legend>
      <p className="small muted">Fill in what they told you. Leave anything you do not know blank; it shows as “{NOT_PROVIDED}”.</p>
      <div className="grid-2">
        <Field label="State or union territory">
          <select className="select" value={value.state} onChange={(e) => onChange({ ...value, state: e.target.value })}>
            <option value="">Not known</option>
            {unknownState && <option value={value.state}>{value.state} (as recorded)</option>}
            {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {legacyState && unknownState && <span className="small warning-text">“{value.state}” is not on the list of states; choose the right one.</span>}
        </Field>
        <Field label="District" hint={value.state ? 'Type to search; a district not listed can be typed in' : 'Choose the state first to see its districts'}>
          <input className="input" list={listId} value={value.district} autoComplete="off" onChange={(e) => set('district', e.target.value)} />
          <datalist id={listId}>{districts.map((d) => <option key={d.name} value={d.name}>{d.source === 'RECORDED' ? `${d.leads} lead${d.leads === 1 ? '' : 's'}` : ''}</option>)}</datalist>
        </Field>
        <Field label="City, town or village"><input className="input" value={value.city} onChange={(e) => set('city', e.target.value)} /></Field>
        <Field label="Block or tehsil"><input className="input" value={value.block} onChange={(e) => set('block', e.target.value)} /></Field>
        <Field label="Address"><input className="input" value={value.address_line1} autoComplete="address-line1" onChange={(e) => set('address_line1', e.target.value)} placeholder="House, street, landmark" /></Field>
        <Field label="Address (line 2)"><input className="input" value={value.address_line2} autoComplete="address-line2" onChange={(e) => set('address_line2', e.target.value)} /></Field>
        <Field label="PIN code" hint={pin ? undefined : 'Six digits. Checked for shape only; it does not prove where they are.'}>
          <input className="input" inputMode="numeric" maxLength={7} autoComplete="postal-code" aria-invalid={Boolean(pin)} value={value.pincode} onChange={(e) => set('pincode', e.target.value)} style={{ maxWidth: 160 }} />
          {pin && <span className="small critical-text" role="alert">{pin}</span>}
        </Field>
      </div>
    </fieldset>
  );
}

const SOURCE_WORDS = { IMPORT_DISTRICT_COLUMN: 'From an import’s District column', NOTE_STATE: 'Named in the lead’s notes', NOTE_PINCODE: 'Written in the lead’s notes' };
const FIELD_WORDS = Object.fromEntries(LOCATION_FIELDS);

/** The lead's location, every field shown, missing ones as "Not provided"; with suggestions to confirm. */
export function LocationDetails({ lead, canEdit, onChanged }) {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState(null);
  const load = () => api.sales.get(`/leads/${lead.id}/location-suggestions`).then((r) => setSuggestions(r.suggestions)).catch(() => setSuggestions([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [lead.id]);
  const open = (suggestions || []).filter((s) => s.status === 'PROPOSED');
  const decide = async (s, verb) => {
    try {
      await api.sales.post(`/location-suggestions/${s.id}/${verb}`);
      toast.success(verb === 'accept' ? `${FIELD_WORDS[s.field]} set to ${s.value}` : 'Suggestion dismissed');
      load();
      if (verb === 'accept') onChanged?.();
    } catch (err) { toast.error(err); }
  };
  return (
    <section className="stack-sm" aria-labelledby={`loc-${lead.id}`}>
      <h3 id={`loc-${lead.id}`} className="small">Location</h3>
      <dl className="sales-dl">
        {locationRows(lead).map(([label, v, missing]) => (
          <div key={label} className="sales-dl-row"><dt>{label}</dt><dd className={missing ? 'muted' : ''}>{v}</dd></div>
        ))}
        {lead.country && lead.country !== 'India' && <div className="sales-dl-row"><dt>Country</dt><dd>{lead.country}</dd></div>}
      </dl>
      {open.length > 0 && (
        <div className="mkt-callout small stack-xs">
          <strong>Suggested, not applied</strong>
          <span className="muted">These were found in the lead’s records. Nothing changes until someone confirms it.</span>
          {open.map((s) => (
            <div key={s.id} className="row wrap" style={{ gap: 6 }}>
              <span><strong>{FIELD_WORDS[s.field]}:</strong> {s.value}</span>
              <span className="muted">{SOURCE_WORDS[s.source]}{s.evidence ? ` (${s.evidence})` : ''}</span>
              {canEdit && (
                <span className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn btn-sm" onClick={() => decide(s, 'accept')}>Use it</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => decide(s, 'reject')}>Not right</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- calls

const outcomeLabel = (c) => {
  if (c.outcome === 'NOT_GIVEN') return 'Dialled, outcome not given';
  if (c.status === 'DIALLED' && !c.outcome) return 'Dialled: how it went is not saved yet';
  return CALL_OUTCOME[c.outcome] || (c.outcome ? String(c.outcome).toLowerCase().replace(/_/g, ' ') : String(c.status || '').toLowerCase());
};

/** A call's length and where it came from: "3m 12s · from the phone", "About 4 min · estimated". */
const callLength = (c) => lengthWords(c.talk_sec ?? c.duration_sec, c.duration_source);

const DELETED_BECAUSE = {
  RETENTION: 'kept for the set number of months, then deleted',
  ASKED_NOT_TO_BE_RECORDED: 'they asked not to be recorded',
};

/** Every call on a lead, each with its number and time to the second; repeats marked after review stay listed. */
export function LeadCalls({ calls, importedAttempts = 0, onOpen }) {
  const counted = calls.filter((c) => !c.voided_at);
  return (
    <div className="stack-sm">
      <div className="small muted">
        {counted.length} call{counted.length === 1 ? '' : 's'} recorded
        {calls.length > counted.length ? `, plus ${calls.length - counted.length} marked as a repeat (listed, not counted)` : ''}
        {importedAttempts > 0 ? `. ${importedAttempts} earlier attempt${importedAttempts === 1 ? '' : 's'} came from an import, with no call record.` : '.'}
      </div>
      {calls.length === 0 ? <div className="empty small">No calls recorded yet.</div> : (
        <div className="table-scroll">
          <table className="data-table calls-table">
            <thead><tr><th>Call</th><th>When</th><th>By</th><th>Outcome</th><th className="num">Length</th><th>Notes</th></tr></thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className={c.voided_at ? 'is-voided' : ''}>
                  <td><button type="button" className="btn-link tnum" onClick={() => onOpen(c.id)} aria-label={`Open call ${c.id}`}>#{c.id}</button></td>
                  <td className="tnum nowrap">{exactTime(c.started_at || c.created_at)}</td>
                  <td>{c.agent_name || '—'}</td>
                  <td>
                    <span className="row wrap" style={{ gap: 4 }}>
                      {outcomeLabel(c)}
                      {c.voided_at && <Badge tone="warning">Repeat, not counted</Badge>}
                      {c.edit_count > 0 && <Badge>Edited</Badge>}
                      {c.direction === 'INBOUND' && <Badge tone="good">They called</Badge>}
                      {c.connected === false && c.direction !== 'INBOUND' && <Badge>Not answered</Badge>}
                      {c.recording_kind === 'STORED' && <Badge tone="brand">Recorded</Badge>}
                    </span>
                  </td>
                  <td className="num tnum nowrap">{callLength(c)}</td>
                  <td className="small calls-note">{c.notes || <span className="muted">No note</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * One call: when, who, how it went, how it was recorded, every correction
 * with what it said before, and the follow-ups it closed. Correcting a note
 * never makes a new call; marking a reviewed repeat keeps it, uncounted.
 */
export function CallDialog({ callId, onClose, onChanged }) {
  const toast = useToast();
  const { can, user } = useAuth();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ notes: '', minutes: '', reason: '' });
  const [shownMinutes, setShownMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [complaint, setComplaint] = useState(false);
  const load = () => api.sales.get(`/calls/${callId}`).then((r) => {
    const sec = r.call.talk_sec ?? r.call.duration_sec;
    const minutes = sec ? String(Math.round(sec / 6) / 10) : '';
    setData(r); setShownMinutes(minutes); setForm({ notes: r.call.notes || '', minutes, reason: '' });
  })
    .catch((err) => setData({ error: err.message }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [callId]);
  const c = data?.call;
  const mine = c && (c.agent_user_id === user.id || c.created_by === user.id);
  const mayEdit = c && can('crm.activity.log') && (mine || can('crm.assign') || can('crm.manage.any'));
  const mayVoid = c && (can('crm.audit') || can('crm.assign'));
  const act = async (fn, message) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      toast.success(typeof message === 'function' ? message(r) : message);
      setEditing(false); await load(); onChanged?.();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  // only what the person changed is sent: a length shown rounded to minutes is not rewritten by itself
  const saveEdit = () => act(() => api.sales.patch(`/calls/${callId}`, {
    ...(form.notes.trim() !== (c.notes || '') ? { notes: form.notes.trim() || null } : {}),
    ...(form.minutes !== shownMinutes ? { duration_sec: form.minutes === '' ? null : Math.round(Number(form.minutes) * 60) } : {}),
    reason: form.reason.trim() || null,
  }), (r) => (r?.changed === false ? 'Nothing was changed' : 'Correction saved; the earlier wording is kept in its history'));
  const voidIt = () => {
    const reason = window.prompt('Why is this an accidental repeat? (It stays listed and can be restored.)');
    if (reason && reason.trim().length >= 3) act(() => api.sales.post(`/calls/${callId}/void`, { reason: reason.trim() }), 'Marked as a repeat: kept, not counted');
  };
  const restore = () => act(() => api.sales.post(`/calls/${callId}/restore`, { reason: 'Restored after review' }), 'Counted again');
  const hold = () => {
    const reason = window.prompt('Why must this recording be kept past the usual time? (For example: a complaint or dispute.)');
    if (reason && reason.trim().length >= 3) act(() => api.sales.post(`/calls/${callId}/recording/hold`, { reason: reason.trim() }), 'Kept: it will not be deleted until the mark is removed');
  };
  const release = () => {
    const reason = window.prompt('Why is it no longer needed?');
    if (reason && reason.trim().length >= 3) act(() => api.sales.post(`/calls/${callId}/recording/release`, { reason: reason.trim() }), 'The mark is removed: the usual time applies again');
  };
  const canHear = c && c.recording_kind === 'STORED' && (mine || can('crm.recordings'));
  return (
    <Modal title={c ? `Call #${c.id}` : 'Call'} size="lg" onClose={onClose}
      footer={editing
        ? <><button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={saveEdit}>Save correction</button></>
        : <button type="button" className="btn" onClick={onClose}>Close</button>}>
      {!data ? <Spinner /> : data.error ? <div className="critical-text small">{data.error}</div> : (
        <div className="stack">
          {c.voided_at && (
            <div className="mkt-callout is-warning small">
              Marked as an accidental repeat by {c.voided_by_name || 'someone'} on {exactTime(c.voided_at)}: {c.void_reason}. It is kept here and not counted.
            </div>
          )}
          <dl className="sales-dl">
            <div className="sales-dl-row"><dt>When</dt><dd className="tnum">{exactTime(c.started_at || c.created_at)}</dd></div>
            <div className="sales-dl-row"><dt>Saved</dt><dd className="tnum">{exactTime(c.created_at)}</dd></div>
            <div className="sales-dl-row"><dt>By</dt><dd>{c.agent_name || '—'}</dd></div>
            <div className="sales-dl-row"><dt>Outcome</dt><dd>{outcomeLabel(c)}</dd></div>
            <div className="sales-dl-row"><dt>Direction</dt><dd>{c.direction === 'INBOUND' ? 'They called' : 'We called'}</dd></div>
            {c.dialled_at && <div className="sales-dl-row"><dt>Dialled</dt><dd className="tnum">{exactTime(c.dialled_at)}</dd></div>}
            <div className="sales-dl-row"><dt>Length</dt><dd className="tnum">{callLength(c)}{c.connected === false ? ' · the phone says nobody answered' : ''}</dd></div>
            <div className="sales-dl-row"><dt>Recorded through</dt><dd>{RECORDED_VIA[c.recorded_via] || (c.provider && c.provider !== 'manual' ? c.provider : 'Logged by hand')}</dd></div>
            {c.callback_reason && <div className="sales-dl-row"><dt>Allowed because</dt><dd>{CALLBACK_REASON[c.callback_reason] || c.callback_reason}</dd></div>}
            {c.hours_override_reason && <div className="sales-dl-row"><dt>Outside calling hours</dt><dd>{c.hours_override_reason}</dd></div>}
            {c.lead_ref && <div className="sales-dl-row"><dt>Lead</dt><dd>{c.lead_ref} {c.lead_name}</dd></div>}
          </dl>
          {editing ? (
            <div className="stack-sm">
              <Field label="What was said"><textarea className="textarea" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
              <div className="grid-2">
                <Field label="Minutes"><input className="input" type="number" min="0" step="0.5" inputMode="decimal" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} /></Field>
                <Field label="Why the correction (kept)"><input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Typo in the crop name" /></Field>
              </div>
              <div className="small muted">This corrects call #{c.id}. It does not add a call or change the count.</div>
            </div>
          ) : (
            <div className="stack-xs">
              <span className="stat-label">Notes</span>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.notes || <span className="muted">No note</span>}</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {mayEdit && !c.voided_at && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Correct the note or length</button>}
                {mayVoid && !c.voided_at && <button type="button" className="btn btn-sm btn-ghost" onClick={voidIt}>Mark as an accidental repeat…</button>}
                {mayVoid && c.voided_at && <button type="button" className="btn btn-sm" onClick={restore}>Count it again</button>}
              </div>
            </div>
          )}
          <section className="stack-xs call-recording" aria-label="Recording">
            <h3 className="small">Recording</h3>
            {c.recording_kind === 'STORED' ? (
              <>
                <div className="small muted">
                  {lengthWords(c.recording_length_sec)} · {c.recording_source === 'DEVICE_SYNC' ? 'picked up from the phone' : c.recording_source === 'SHARED' ? 'shared from the phone' : 'attached by hand'} · added <span className="tnum">{exactTime(c.recording_added_at)}</span>
                </div>
                {canHear ? <RecordingPlayer call={c} canDownload={can('crm.recordings')} />
                  : <div className="small muted">Only the caller, and people allowed to hear recordings, can play it.</div>}
                {c.recording_hold_at ? (
                  <div className="row wrap small" style={{ gap: 6 }}>
                    <Badge tone="warning">Kept: needed for a dispute</Badge><span className="muted">{c.recording_hold_reason}</span>
                    {can('crm.settings') && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={release}>Remove the mark…</button>}
                  </div>
                ) : can('crm.settings') && <div><button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={hold}>Keep: needed for a dispute…</button></div>}
              </>
            ) : c.recording_kind === 'PROVIDER' ? <div className="small muted">Held by the calling provider.</div>
              : c.no_recording ? <div className="small muted">Not recorded: they asked not to be.</div>
                : c.recording_deleted_at ? <div className="small muted">Deleted <span className="tnum">{exactTime(c.recording_deleted_at)}</span>: {DELETED_BECAUSE[c.recording_delete_reason] || String(c.recording_delete_reason || '').toLowerCase()}. The call, its notes and outcome stay.</div>
                  : <div className="small muted">None.</div>}
            {c.agent_user_id === user.id && !c.recording_kind && !c.no_recording && !c.voided_at && (
              <div><AttachRecording callId={c.id} onDone={() => { load(); onChanged?.(); }} /></div>
            )}
          </section>
          {(c.lead_id || c.contact_id) && !c.voided_at && can('crm.activity.log') && (
            <div><button type="button" className="btn btn-sm btn-ghost" onClick={() => setComplaint(true)}>Customer complained…</button></div>
          )}
          {complaint && <ComplaintDialog leadId={c.lead_id} contactId={c.contact_id} callId={c.id} onClose={() => setComplaint(false)} onDone={() => { load(); onChanged?.(); }} />}
          {data.edits.length > 0 && (
            <section className="stack-xs">
              <h3 className="small">Corrections</h3>
              <ul className="call-edits small">
                {data.edits.map((e) => (
                  <li key={e.id}>
                    <span className="tnum muted">{exactTime(e.edited_at)}</span> · {e.edited_by_name || 'someone'} changed {e.field === 'duration_sec' ? 'the length' : e.field === 'counted' ? 'whether it counts' : 'the note'}
                    {e.reason ? ` (${e.reason})` : ''}
                    <div className="call-edit-diff"><del>{e.before || '(empty)'}</del> → <ins>{e.after || '(empty)'}</ins></div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.followups.length > 0 && (
            <section className="stack-xs">
              <h3 className="small">Follow-ups it answered</h3>
              {data.followups.map((t) => <div key={t.id} className="small">{t.title} · due {exactTime(t.due_date)}{t.completed_at ? ` · done ${exactTime(t.completed_at)}` : ''}</div>)}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
