import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Badge, Field, Spinner } from '../ui.jsx';
import { durationWords, exactTime, LOCATION_FIELDS } from '../../lib/crmWork.js';
import { CallDialog } from './LeadWork.jsx';

const VERDICT = {
  LIKELY_ACCIDENTAL: ['Probably saved twice', 'warning'],
  DIFFERENT_NOTES: ['Different notes', 'brand'],
  NEEDS_A_PERSON: ['Look at each', 'neutral'],
};

/**
 * Calls on the same lead, by the same person, close together: a list for a
 * manager to look at. Building it changes nothing. A call is only ever marked
 * as an accidental repeat one at a time, by a person, with a reason, and can
 * be counted again; nothing is deleted or merged.
 */
export function CallReview() {
  const [form, setForm] = useState({ leads: '', since: '', window: '120' });
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const toast = useToast();
  const run = async () => {
    setBusy(true);
    try {
      setData(await api.sales.get('/calls/review', { lead_id: form.leads.replace(/\s+/g, '') || undefined, since: form.since || undefined, window: form.window }));
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><h3>Repeated calls to review</h3></div>
        <div className="card-pad stack-sm">
          <div className="small muted">Finds calls on one lead by one person within a short time of each other. It only reads: nothing is changed, deleted or merged. Genuine repeat calls are normal and stay as they are.</div>
          <div className="grid-3">
            <Field label="Lead numbers" hint="Comma-separated, e.g. 692, 693"><input className="input" inputMode="numeric" value={form.leads} onChange={(e) => setForm({ ...form, leads: e.target.value })} /></Field>
            <Field label="Or from date"><input className="input" type="date" value={form.since} onChange={(e) => setForm({ ...form, since: e.target.value })} /></Field>
            <Field label="Within (seconds)"><input className="input" type="number" min="5" max="3600" value={form.window} onChange={(e) => setForm({ ...form, window: e.target.value })} /></Field>
          </div>
          <div><button type="button" className="btn btn-sm btn-primary" disabled={busy || (!form.leads.trim() && !form.since)} onClick={run}>{busy ? 'Looking…' : 'Build the list'}</button></div>
        </div>
      </section>
      {data && (
        <section className="card">
          <div className="card-head"><h3>{data.groups.length} group{data.groups.length === 1 ? '' : 's'} to look at</h3><span className="small muted">{data.entries.length} entries read · {exactTime(data.generated_at)}</span></div>
          <div className="card-pad stack">
            {data.groups.length === 0 && <div className="small muted">No calls close together. Nothing to review.</div>}
            {data.groups.map((g) => {
              const [label, tone] = VERDICT[g.verdict];
              return (
                <div key={`${g.lead_id}-${g.entries[0].created_at}`} className="review-group stack-xs">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <Badge tone={tone}>{label}</Badge>
                    <Link to={`/sales/leads/${g.lead_id}`}>Lead {g.lead_id}</Link>
                    <span className="small muted">{g.entries[0].agent_name || 'someone'} · {g.entries.length} entries within {g.seconds_apart}s</span>
                  </div>
                  <div className="small">{g.advice}</div>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead><tr><th>Entry</th><th>Saved at</th><th>Outcome</th><th className="num">Length</th><th>Note</th><th>How it was recorded</th><th>Counted</th></tr></thead>
                      <tbody>{g.entries.map((e) => (
                        <tr key={e.call_id ? `c${e.call_id}` : `a${e.activity_id}`}>
                          <td>{e.call_id ? <button type="button" className="btn-link tnum" onClick={() => setOpen(e.call_id)}>Call #{e.call_id}</button> : <span className="muted">Timeline entry {e.activity_id}</span>}</td>
                          <td className="tnum nowrap">{exactTime(e.created_at)}</td>
                          <td>{String(e.outcome || '').toLowerCase().replace(/_/g, ' ')}</td>
                          <td className="num tnum">{durationWords(e.duration_sec)}</td>
                          <td className="small">{e.notes_preview || <span className="muted">none</span>}</td>
                          <td className="small">{e.recorded_via}{e.request_id ? ' · with a request id' : ''}</td>
                          <td>{e.counted ? 'Yes' : 'No'}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {open && <CallDialog callId={open} onClose={() => setOpen(null)} onChanged={run} />}
    </div>
  );
}

const FIELD_WORDS = Object.fromEntries(LOCATION_FIELDS);
const SOURCE_WORDS = { IMPORT_DISTRICT_COLUMN: 'Import’s District column', NOTE_STATE: 'State named in notes', NOTE_PINCODE: 'PIN written in notes' };

/**
 * Location suggestions for existing leads, waiting for a person. Building the
 * list writes suggestions only; a lead changes only when someone accepts one,
 * and only an empty field is filled.
 */
export function LocationReview() {
  const toast = useToast();
  const [status, setStatus] = useState('PROPOSED');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.sales.get('/location-suggestions', { status, page }).then(setData).catch((err) => setData({ error: err.message }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); load(); }, [status, page]);
  const build = async () => {
    setBusy(true);
    try {
      const r = await api.sales.post('/location-suggestions/generate');
      const n = Object.values(r.added).reduce((a, b) => a + b, 0);
      toast.success(n ? `${n} new suggestion${n === 1 ? '' : 's'} to review. No lead was changed.` : 'Nothing new to suggest. No lead was changed.');
      load();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const decide = async (s, verb) => {
    try { await api.sales.post(`/location-suggestions/${s.id}/${verb}`); toast.success(verb === 'accept' ? `${s.ref}: ${FIELD_WORDS[s.field]} set to ${s.value}` : 'Dismissed'); load(); } catch (err) { toast.error(err); }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h3>Lead locations to review</h3>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={build}>{busy ? 'Looking…' : 'Look for suggestions'}</button>
      </div>
      <div className="card-pad stack-sm">
        <div className="small muted">Older imports put a District column into City, and some notes name a state or a PIN code. These are only suggestions: each one changes its lead only when someone chooses “Use it”, and never overwrites a value already there.</div>
        <div className="row" style={{ gap: 6 }} role="tablist">
          {[['PROPOSED', 'Waiting'], ['ACCEPTED', 'Used'], ['REJECTED', 'Dismissed']].map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={status === k} className={`kind-chip${status === k ? ' is-active' : ''}`} onClick={() => { setStatus(k); setPage(1); }}>{l}</button>
          ))}
        </div>
        {!data ? <Spinner /> : data.error ? <div className="critical-text small">{data.error}</div> : data.suggestions.length === 0 ? <div className="small muted">Nothing here.</div> : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Lead</th><th>Field</th><th>Suggested</th><th>From</th><th>Now recorded</th>{status === 'PROPOSED' && <th />}</tr></thead>
                <tbody>{data.suggestions.map((s) => (
                  <tr key={s.id}>
                    <td><Link to={`/sales/leads/${s.lead_id}`}>{s.ref}</Link> <span className="small muted">{s.lead_name}</span></td>
                    <td>{FIELD_WORDS[s.field]}</td>
                    <td><strong>{s.value}</strong></td>
                    <td className="small">{SOURCE_WORDS[s.source]}{s.evidence ? <div className="muted">{s.evidence}</div> : null}</td>
                    <td className="small">{[s.city, s.district, s.state, s.pincode].filter(Boolean).join(', ') || <span className="muted">Not provided</span>}</td>
                    {status === 'PROPOSED' && (
                      <td className="nowrap">
                        <button type="button" className="btn btn-sm" onClick={() => decide(s, 'accept')}>Use it</button>{' '}
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => decide(s, 'reject')}>Not right</button>
                      </td>
                    )}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="row-between small">
              <span className="muted">{data.total} in all</span>
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <button type="button" className="btn btn-sm" disabled={page * data.page_size >= data.total} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
