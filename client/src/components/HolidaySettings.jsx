import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import { formatDate } from '../lib/format.js';
import { todayIn } from '../lib/attendance.js';
import {
  ACTION_LABEL, CORRECTION_LABEL, CORRECTION_PERMISSION, CORRECTION_STATUS, COVERAGE_LABEL, KIND_LABEL, REQUEST_STATUS,
  groupByMonth, impactLines, rangeWords, scopeWords, shortDate,
} from '../lib/holidays.js';

/**
 * Settings → Attendance & pay → Holidays.
 *
 * Holidays are planned month by month or at short notice. Every change is
 * proposed, approved by someone else, and published to the people it covers.
 * A change to a day already past lists the records it touches as corrections,
 * each waiting for a person with the right permission.
 */
export default function HolidaySettings() {
  const toast = useToast();
  const { can } = useAuth();
  const [year, setYear] = useState(Number(todayIn().slice(0, 4)));
  const [data, setData] = useState(null);
  const [proposing, setProposing] = useState(null);
  const [reviewing, setReviewing] = useState(null);
  const [history, setHistory] = useState(null);

  const load = useCallback(() => {
    api.holidayCalendar({ year }).then(setData).catch(toast.error);
  }, [year, toast]);
  useEffect(load, [load]);

  if (!data) return <Spinner label="Loading the holiday calendar" />;
  const months = groupByMonth(data.entries);
  const waiting = data.requests.filter((r) => r.status === 'PROPOSED');
  const toReconcile = data.requests.filter((r) => r.status === 'APPROVED' && r.open_corrections > 0);
  // decided ones not already listed above for their corrections
  const decided = data.requests.filter((r) => r.status !== 'PROPOSED' && !toReconcile.includes(r)).slice(0, 12);

  return (
    <div className="stack">
      <section className="card card-pad stack-sm">
        <div className="row-between wrap">
          <div>
            <h2>Holidays and closures</h2>
            <div className="small muted">Planned month by month or at short notice. A change takes effect once someone else approves it.</div>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => setYear(year - 1)} aria-label={`Show ${year - 1}`}>{year - 1}</button>
            <strong className="tnum">{year}</strong>
            <button type="button" className="btn btn-sm" onClick={() => setYear(year + 1)} aria-label={`Show ${year + 1}`}>{year + 1}</button>
            {data.can.propose && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setProposing({ action: 'ADD' })}>
                <Icon name="plus" size={14} /> Propose a holiday
              </button>
            )}
          </div>
        </div>
        <ul className="hol-steps small">
          <li><strong>Propose</strong> with HR or attendance permission: dates, who it covers, full day or half, and why.</li>
          <li><strong>Approve</strong> with holiday approval: you see what it changes first. It is then announced to everyone it covers.</li>
          <li><strong>Reconcile</strong> a day already past: black marks, standups and leave it touches wait for a reviewer. Nothing is changed by itself, and every correction can be reversed.</li>
        </ul>
      </section>

      {waiting.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Waiting for approval</h3><Badge tone="warning">{waiting.length}</Badge></div>
          <div className="hol-list">
            {waiting.map((r) => <RequestRow key={r.id} request={r} onOpen={() => setReviewing(r.id)} />)}
          </div>
        </section>
      )}

      {toReconcile.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Corrections waiting for review</h3><Badge tone="warning">{toReconcile.reduce((n, r) => n + r.open_corrections, 0)}</Badge></div>
          <div className="hol-list">
            {toReconcile.map((r) => (
              <RequestRow key={r.id} request={r} onOpen={() => setReviewing(r.id)} note={`${r.open_corrections} of ${r.all_corrections} waiting`} />
            ))}
          </div>
        </section>
      )}

      {months.length === 0 ? (
        <section className="card card-pad"><EmptyState title={`No holidays in ${year} yet`}>Holidays are added a month or so ahead, or on the day for an unplanned closure.</EmptyState></section>
      ) : months.map((m) => (
        <section key={m.month} className="card">
          <div className="card-head">
            <h3>{m.label}</h3>
            <span className="small muted">{m.inForce} day{m.inForce === 1 ? '' : 's'} in force</span>
          </div>
          <div className="table-wrap">
            <table className="data hol-table">
              <thead><tr><th>Dates</th><th>Name</th><th>For</th><th>Coverage</th><th>Status</th><th /></tr></thead>
              <tbody>
                {m.rows.map((row) => (
                  <tr key={row.key} className={row.status === 'CANCELLED' ? 'is-cancelled' : ''}>
                    <td className="nowrap">{rangeWords(row.start, row.end)}</td>
                    <td>
                      {row.name} {row.kind === 'CLOSURE' && <Badge tone="serious">Closure</Badge>}
                    </td>
                    <td className="small">{scopeWords(row)}</td>
                    <td className="small">{COVERAGE_LABEL[row.coverage]}</td>
                    <td className="small"><EntryStatus row={row} /></td>
                    <td className="nowrap">
                      {row.status === 'APPROVED' && data.can.propose && (
                        <>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setProposing({ action: 'AMEND', row })}>Change</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setProposing({ action: 'CANCEL', row })}>Cancel</button>
                        </>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHistory(row.entries[0].id)}>History</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {decided.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Recent decisions</h3></div>
          <div className="hol-list">
            {decided.map((r) => <RequestRow key={r.id} request={r} onOpen={() => setReviewing(r.id)} />)}
          </div>
        </section>
      )}

      {proposing && (
        <ProposeDialog
          {...proposing}
          onClose={() => setProposing(null)}
          onSaved={(request) => { setProposing(null); load(); if (can('holiday.approve')) setReviewing(request.id); }}
        />
      )}
      {reviewing && <RequestDialog id={reviewing} onClose={() => setReviewing(null)} onChanged={load} />}
      {history && <EntryHistoryDialog id={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function EntryStatus({ row }) {
  if (row.status === 'CANCELLED') {
    return (
      <span>
        <Badge>Cancelled</Badge>
        <span className="muted"> by {row.cancelled_by_name || 'someone'}{row.cancel_reason ? ` — ${row.cancel_reason}` : ''}</span>
      </span>
    );
  }
  return (
    <span>
      <Badge tone="good">In force</Badge>
      <span className="muted">
        {row.approved_by_name
          ? ` approved by ${row.approved_by_name}${row.published_at ? `, announced ${formatDate(row.published_at)}` : ''}`
          : ' added before approvals were required'}
      </span>
    </span>
  );
}

function requestWhat(r) {
  if (r.action === 'CANCEL') return `Cancel ${r.target_ids.length} date${r.target_ids.length === 1 ? '' : 's'}`;
  const what = `${r.name} · ${rangeWords(r.start_date, r.end_date)} · ${COVERAGE_LABEL[r.coverage] || 'Full day'} · ${scopeWords(r)}`;
  return r.action === 'AMEND' ? `Change to ${what}` : what;
}

function RequestRow({ request: r, onOpen, note }) {
  const status = REQUEST_STATUS[r.status];
  return (
    <div className="hol-row">
      <div className="grow">
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge tone={status.tone}>{status.label}</Badge>
          <strong>{ACTION_LABEL[r.action]}</strong>
          <span>{requestWhat(r)}</span>
          {r.kind === 'CLOSURE' && <Badge tone="serious">Closure</Badge>}
        </div>
        <div className="small muted">
          #{r.id} · proposed by {r.proposed_by_name || 'someone'} {formatDate(r.proposed_at)} — “{r.reason}”
          {r.decided_by_name ? ` · ${r.status.toLowerCase()} by ${r.decided_by_name}` : ''}
          {r.self_approved ? ' (their own change)' : ''}
          {note ? ` · ${note}` : ''}
        </div>
      </div>
      <button type="button" className="btn btn-sm" onClick={onOpen}>{r.status === 'PROPOSED' ? 'Review' : 'Open'}</button>
    </div>
  );
}

// ---------------------------------------------------------------- proposing

function ProposeDialog({ action, row, onClose, onSaved }) {
  const toast = useToast();
  const { departments, users } = useRefData();
  const scope0 = row ? (row.user_id ? 'PERSON' : row.department_id ? 'DEPARTMENT' : 'COMPANY') : 'COMPANY';
  const [form, setForm] = useState({
    name: row?.name || '',
    kind: row?.kind || 'HOLIDAY',
    start_date: row?.start || '',
    end_date: row?.end || '',
    coverage: row?.coverage || 'FULL',
    scope: scope0,
    department_id: row?.department_id ? String(row.department_id) : '',
    user_id: row?.user_id ? String(row.user_id) : '',
    reason: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const past = form.start_date && form.start_date <= todayIn();

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const target_ids = row ? row.entries.map((x) => x.id) : undefined;
      const body = action === 'CANCEL'
        ? { action, target_ids, reason: form.reason }
        : {
          action, target_ids, name: form.name, kind: form.kind, start_date: form.start_date, end_date: form.end_date || form.start_date,
          coverage: form.coverage, scope: form.scope, reason: form.reason,
          department_id: form.scope === 'DEPARTMENT' ? Number(form.department_id) || null : null,
          user_id: form.scope === 'PERSON' ? Number(form.user_id) || null : null,
        };
      const { request } = await api.proposeHoliday(body);
      toast.success('Proposed. It takes effect once someone else approves it.');
      onSaved(request);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const title = action === 'ADD' ? 'Propose a holiday or closure' : action === 'AMEND' ? `Change ${row.name}` : `Cancel ${row.name}`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="submit" form="hol-propose" className="btn btn-primary" disabled={saving}>{saving ? 'Sending…' : 'Send for approval'}</button>
        </>
      )}
    >
      <form id="hol-propose" className="stack" onSubmit={save}>
        {action === 'CANCEL' ? (
          <div className="callout is-quiet small">
            <Icon name="calendar" />
            <span>{rangeWords(row.start, row.end)} becomes a working day again for {scopeWords(row)}. Once approved, anything already recorded for those dates is listed for review; nothing is changed by itself.</span>
          </div>
        ) : (
          <>
            <div className="grid-2">
              <Field label="Name"><input className="input" value={form.name} onChange={set('name')} required maxLength={120} placeholder="Diwali" /></Field>
              <Field label="Type">
                <select className="select" value={form.kind} onChange={set('kind')}>
                  <option value="HOLIDAY">Holiday (planned)</option>
                  <option value="CLOSURE">Closure (unplanned: power cut, weather)</option>
                </select>
              </Field>
            </div>
            <div className="grid-2">
              <Field label="From"><input className="input" type="date" value={form.start_date} onChange={set('start_date')} required /></Field>
              <Field label="To" hint="Leave empty for one day"><input className="input" type="date" value={form.end_date} min={form.start_date} onChange={set('end_date')} /></Field>
            </div>
            <div className="grid-2">
              <Field label="How much of the day">
                <select className="select" value={form.coverage} onChange={set('coverage')}>
                  <option value="FULL">Full day</option>
                  <option value="FIRST_HALF">Morning off (works from the half-day split)</option>
                  <option value="SECOND_HALF">Afternoon off (works until the half-day split)</option>
                </select>
              </Field>
              <Field label="For">
                <select className="select" value={form.scope} onChange={set('scope')}>
                  <option value="COMPANY">Everyone</option>
                  <option value="DEPARTMENT">One department</option>
                  <option value="PERSON">One person</option>
                </select>
              </Field>
            </div>
            {form.scope === 'DEPARTMENT' && (
              <Field label="Department">
                <select className="select" value={form.department_id} onChange={set('department_id')} required>
                  <option value="">Choose…</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </Field>
            )}
            {form.scope === 'PERSON' && (
              <Field label="Person">
                <select className="select" value={form.user_id} onChange={set('user_id')} required>
                  <option value="">Choose…</option>
                  {users.filter((u) => u.is_active !== false).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </select>
              </Field>
            )}
            {past && (
              <div className="callout is-quiet small">
                <Icon name="alert" />
                <span>This date has already started. Whoever approves it sees what it changes first, and records it touches wait for review.</span>
              </div>
            )}
          </>
        )}
        <Field label="Why" hint="Kept with the change and shown to whoever approves it, and in the announcement">
          <textarea className="textarea" rows={2} value={form.reason} onChange={set('reason')} required minLength={3} maxLength={500} />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- reviewing

function RequestDialog({ id, onClose, onChanged }) {
  const toast = useToast();
  const { user, can } = useAuth();
  const [data, setData] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.holidayRequest(id).then(setData).catch(toast.error); }, [id, toast]);
  useEffect(load, [load]);

  const act = async (fn, done) => {
    setBusy(true);
    try { await fn(); toast.success(done); load(); onChanged(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  if (!data) return <Modal title="Holiday change" onClose={onClose} size="lg"><Spinner /></Modal>;
  const { request: r, impact } = data;
  const own = r.proposed_by === user?.id;
  const canDecide = r.status === 'PROPOSED' && can('holiday.approve') && (!own || user?.role === 'admin');
  const lines = impactLines(impact);

  return (
    <Modal
      title={`${ACTION_LABEL[r.action]}: ${r.action === 'CANCEL' ? (data.targets[0]?.name || 'holiday') : r.name}`}
      onClose={onClose}
      size="lg"
      footer={r.status === 'PROPOSED' ? (
        <div className="row wrap grow" style={{ gap: 8 }}>
          {(own || can('holiday.approve')) && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act(() => api.withdrawHoliday(r.id, note), 'Withdrawn')}>Withdraw</button>
          )}
          <span className="grow" />
          {canDecide && (
            <>
              <button type="button" className="btn" disabled={busy || note.trim().length < 3} onClick={() => act(() => api.rejectHoliday(r.id, note.trim()), 'Rejected')}>Reject</button>
              <button type="button" className="btn btn-primary" disabled={busy || (own && note.trim().length < 3)} onClick={() => act(() => api.approveHoliday(r.id, note.trim()), 'Approved and announced')}>Approve</button>
            </>
          )}
        </div>
      ) : <button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      <div className="stack">
        <div className="hol-summary">
          <Badge tone={REQUEST_STATUS[r.status].tone}>{REQUEST_STATUS[r.status].label}</Badge>
          <div>{requestWhat(r)}</div>
          {data.targets.length > 0 && (
            <div className="small muted">
              {r.action === 'CANCEL' ? 'Ends' : 'Replaces'}: {data.targets.map((t) => `${shortDate(t.holiday_date)} ${t.name} (${COVERAGE_LABEL[t.coverage]}, ${scopeWords(t)})`).join('; ')}
            </div>
          )}
          <div className="small">“{r.reason}” — {r.proposed_by_name}, {formatDate(r.proposed_at, { withTime: true })}</div>
          {r.decided_by_name && (
            <div className="small muted">
              {REQUEST_STATUS[r.status].label} by {r.decided_by_name}, {formatDate(r.decided_at, { withTime: true })}
              {r.self_approved ? ' — their own change' : ''}{r.decision_note ? `: “${r.decision_note}”` : ''}
            </div>
          )}
        </div>

        <section className="stack-sm">
          <h3>{data.impact_is_live ? 'What approving changes' : 'What it changed, as the approver saw it'}</h3>
          {!impact ? <div className="small muted">Decided before impact previews were kept.</div> : lines.length === 0 ? (
            <div className="small muted">Nothing recorded so far is affected: the dates are ahead, or nobody had anything on them.</div>
          ) : (
            <table className="data">
              <tbody>
                {lines.map((l) => (
                  <tr key={l.area}><th scope="row" className="nowrap">{l.area}</th><td>{l.text}<div className="small muted">{l.applies}</div></td></tr>
                ))}
              </tbody>
            </table>
          )}
          {(impact?.notes || []).map((n, i) => (
            <div key={i} className="callout is-quiet small"><Icon name="alert" /><span>{n.text}</span></div>
          ))}
          {impact?.attendance?.changes?.length > 0 && (
            <details className="hol-details">
              <summary className="small">Attendance, day by day ({impact.attendance.changes.length})</summary>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Person</th><th>Date</th><th>Before</th><th>After</th></tr></thead>
                  <tbody>
                    {impact.attendance.changes.slice(0, 80).map((c) => (
                      <tr key={`${c.user_id}-${c.date}`}>
                        <td>{c.name}</td>
                        <td className="nowrap">{shortDate(c.date)}</td>
                        <td className="small">{dayWords(c.before)}</td>
                        <td className="small">{dayWords(c.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {data.impact_is_live && [...(impact?.marks || []), ...(impact?.standup || []), ...(impact?.leave || [])].length > 0 && (
            <details className="hol-details">
              <summary className="small">Records that will wait for review</summary>
              <ul className="small">
                {[...impact.marks, ...impact.standup, ...impact.leave].map((x, i) => (
                  <li key={i}>{x.kind ? <strong>{CORRECTION_LABEL[x.kind]}: </strong> : null}{x.summary}</li>
                ))}
              </ul>
            </details>
          )}
        </section>

        {r.status === 'PROPOSED' && canDecide && (
          <Field label="Note" hint={own ? 'Approving your own change needs a note saying why nobody else could' : 'Needed to reject; optional to approve'}>
            <textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
        )}
        {r.status === 'PROPOSED' && !canDecide && (
          <div className="small muted">{own ? 'Someone else with holiday approval has to approve your change.' : 'Approving needs holiday approval permission.'}</div>
        )}

        {data.corrections.length > 0 && (
          <section className="stack-sm">
            <h3>Corrections</h3>
            <div className="small muted">Each one changes a stored record only when someone with the right permission applies it. An applied correction can be reversed.</div>
            {data.corrections.map((c) => (
              <CorrectionRow
                key={c.id}
                c={c}
                mayAct={can(CORRECTION_PERMISSION[c.kind]) && c.user_id !== user?.id}
                busy={busy}
                act={act}
              />
            ))}
          </section>
        )}

        {data.audit.length > 0 && (
          <details className="hol-details">
            <summary className="small">Audit trail ({data.audit.length})</summary>
            <ul className="small hol-audit">
              {data.audit.map((a) => (
                <li key={a.id}>{formatDate(a.created_at, { withTime: true })} — {a.actor_name || 'TaskFlow'}: {a.action.toLowerCase().replace(/_/g, ' ')} {a.entity_type === 'HOLIDAY_CORRECTION' ? `correction #${a.entity_id}` : ''}{a.reason ? ` — “${a.reason}”` : ''}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}

const STATE_WORDS = { WORKDAY: 'Working day', WEEKLY_OFF: 'Weekly day off', HOLIDAY: 'Holiday', NOT_EMPLOYED: 'Not employed' };

function dayWords(d) {
  if (!d) return '';
  const parts = [d.half ? `${STATE_WORDS[d.state]}, ${COVERAGE_LABEL[d.half].toLowerCase()}` : STATE_WORDS[d.state] || d.state];
  if (d.state === 'WORKDAY') parts.push(`${Math.round((d.required_seconds / 3600) * 10) / 10}h required`);
  if (d.blockers.includes('UNRECORDED')) parts.push('unrecorded, waiting for a reviewer');
  if (d.absence_decision && d.unpaid_seconds > 0) parts.push('confirmed absence');
  return parts.join(' · ');
}

function CorrectionRow({ c, mayAct, busy, act }) {
  const status = CORRECTION_STATUS[c.status];
  const ask = (label) => {
    const text = window.prompt(label);
    return text && text.trim().length >= 3 ? text.trim() : null;
  };
  return (
    <div className="hol-row">
      <div className="grow">
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge tone={status.tone}>{status.label}</Badge>
          <strong>{CORRECTION_LABEL[c.kind]}</strong>
          <span className="small muted">{shortDate(c.work_date)}</span>
        </div>
        <div className="small">{c.summary}</div>
        {(c.decided_by_name || c.decision_note) && (
          <div className="small muted">
            {c.decided_by_name ? `${status.label} by ${c.decided_by_name} ${formatDate(c.decided_at)}` : ''}{c.decision_note ? ` — ${c.decision_note}` : ''}
          </div>
        )}
        {c.reversed_by_name && <div className="small muted">Reversed by {c.reversed_by_name} {formatDate(c.reversed_at)} — {c.reverse_reason}</div>}
      </div>
      {mayAct && c.status === 'PROPOSED' && (
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { const n = ask('Why is this correction not right?'); if (n) act(() => api.rejectHolidayCorrection(c.id, n), 'Rejected'); }}>Reject</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => api.applyHolidayCorrection(c.id), 'Applied')}>Apply</button>
        </div>
      )}
      {mayAct && c.status === 'APPLIED' && (
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { const n = ask('Why reverse it? The record goes back exactly as it was.'); if (n) act(() => api.reverseHolidayCorrection(c.id, n), 'Reversed'); }}>Reverse</button>
      )}
    </div>
  );
}

/**
 * Holiday corrections this person may decide, wherever they review work — the
 * Approvals tab shows it to managers who cannot open Settings. Renders nothing
 * when there is nothing for them.
 */
export function HolidayCorrectionsQueue() {
  const toast = useToast();
  const { user, can } = useAuth();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.holidayCorrections({ status: 'PROPOSED' }).then((d) => setItems(d.corrections)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  const mine = (items || []).filter((c) => can(CORRECTION_PERMISSION[c.kind]) && c.user_id !== user?.id);
  if (!mine.length) return null;
  const act = async (fn, done) => {
    setBusy(true);
    try { await fn(); toast.success(done); load(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <div className="card-head"><h2>Holiday corrections</h2><Badge tone="warning">{mine.length}</Badge></div>
      <div className="card-pad stack-sm" style={{ paddingTop: 0 }}>
        <div className="small muted">A holiday was added, changed or cancelled after these records were made. Each changes only if you apply it, and can be reversed.</div>
        {mine.map((c) => (
          <div key={c.id}>
            <div className="small muted">{c.user_name || 'Someone'} · holiday request #{c.request_id}</div>
            <CorrectionRow c={c} mayAct busy={busy} act={act} />
          </div>
        ))}
      </div>
    </section>
  );
}

function EntryHistoryDialog({ id, onClose }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  useEffect(() => { api.holidayHistory(id).then(setData).catch(toast.error); }, [id, toast]);
  return (
    <Modal title="Holiday history" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {!data ? <Spinner /> : (
        <div className="stack">
          <div>
            <strong>{data.entry.name}</strong> · {shortDate(data.entry.holiday_date)} · {COVERAGE_LABEL[data.entry.coverage]} · {scopeWords(data.entry)} · {KIND_LABEL[data.entry.kind]}
          </div>
          {data.requests.length === 0 && <div className="small muted">Added before approvals were required, by {data.entry.created_by ? 'an administrator' : 'TaskFlow'}.</div>}
          <ul className="small hol-audit">
            {data.requests.map((r) => (
              <li key={`r${r.id}`}>Request #{r.id} ({ACTION_LABEL[r.action].toLowerCase()}): proposed by {r.proposed_by_name} {formatDate(r.proposed_at)} — “{r.reason}”; {REQUEST_STATUS[r.status].label.toLowerCase()}{r.decided_by_name ? ` by ${r.decided_by_name} ${formatDate(r.decided_at)}` : ''}</li>
            ))}
            {data.audit.map((a) => (
              <li key={`a${a.id}`}>{formatDate(a.created_at, { withTime: true })} — {a.actor_name || 'TaskFlow'}: {a.action.toLowerCase()}{a.reason ? ` — “${a.reason}”` : ''}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

