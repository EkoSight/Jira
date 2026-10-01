import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadFile } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import { MonthLedger } from '../components/Attendance.jsx';
import {
  PAYROLL_STATUS, RECORD_STATUS, dayName, hhmm, money, monthName, shiftMonth, todayIn,
} from '../lib/attendance.js';

/**
 * The monthly salary estimate: Draft → In review → Approved → Locked → Export.
 *
 * An estimate for payroll to use. TaskFlow does not pay anyone, transfer money,
 * or calculate tax, PF or ESI.
 */
export default function Payroll() {
  const toast = useToast();
  const { can } = useAuth();
  const [month, setMonth] = useState(shiftMonth(todayIn().slice(0, 7), -1));
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const manage = can('payroll.manage');

  const load = useCallback(() => {
    setData(null);
    setSelected(new Set());
    api.payrollMonth(month).then(setData).catch(toast.error);
  }, [month, toast]);
  useEffect(load, [load]);

  const policySetup = useMemo(() => {
    const items = new Map();
    for (const p of data?.people || []) for (const s of p.setup) if (s.code.startsWith('POLICY_') || s.code === 'MONTH_BEFORE_START') items.set(s.code, s.label);
    return [...items.values()];
  }, [data]);

  const bulk = async (action) => {
    setBusy(true);
    try {
      const res = await api.payrollBulk(month, { action, user_ids: [...selected] });
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) toast.error(`${res.results.length - failed.length} done; ${failed.length} could not move — open each to see why`);
      else toast.success(`${res.results.length} moved on`);
      load();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const totals = (data?.people || []).reduce((acc, p) => {
    if (p.salary?.status === 'CALCULATED') {
      acc.earnings += p.salary.attendance_adjusted_earnings;
      acc.adjustment += p.salary.attendance_adjustment;
    }
    return acc;
  }, { earnings: 0, adjustment: 0 });

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>Payroll estimate</h1>
          <div className="small muted">Attendance-adjusted earnings for payroll to use. TaskFlow does not pay anyone, and does not calculate tax, PF or ESI.</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm btn-icon" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="chevron" style={{ transform: 'rotate(180deg)' }} /></button>
          <strong className="att-month">{monthName(month)}</strong>
          <button type="button" className="btn btn-sm btn-icon" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month" disabled={month >= todayIn().slice(0, 7)}><Icon name="chevron" /></button>
        </div>
      </div>

      {policySetup.length > 0 && (
        <div className="callout" style={{ borderLeftColor: 'var(--serious)', background: 'var(--serious-wash)' }}>
          <Icon name="alert" />
          <div className="grow small">
            <strong>Before any month can be finalised:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{policySetup.map((s) => <li key={s}>{s}</li>)}</ul>
            {can('attendance.policy') && <Link to="/settings?tab=attendance" className="btn btn-sm" style={{ marginTop: 8 }}>Open attendance &amp; pay settings</Link>}
          </div>
        </div>
      )}

      {!data ? <Spinner label="Working out the month" /> : data.people.length === 0 ? <EmptyState title="Nobody in payroll" /> : (
        <>
          <div className="row-between wrap" style={{ gap: 8 }}>
            <div className="small muted">
              Estimated total: <strong className="tnum">{money(totals.earnings)}</strong> after <strong className="tnum">{money(totals.adjustment)}</strong> attendance adjustment (calculated rows only)
            </div>
            {manage && (
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="small muted">{selected.size} selected</span>
                <button type="button" className="btn btn-sm" disabled={!selected.size || busy} onClick={() => bulk('submit')}>Submit for review</button>
                {can('payroll.approve') && <button type="button" className="btn btn-sm" disabled={!selected.size || busy} onClick={() => bulk('approve')}>Approve</button>}
                {can('payroll.approve') && <button type="button" className="btn btn-sm" disabled={!selected.size || busy} onClick={() => bulk('lock')}>Lock</button>}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => downloadFile(api.payrollExportUrl(month), `payroll-${month}.csv`).then(load).catch(toast.error)}
                >
                  Export locked CSV
                </button>
              </div>
            )}
          </div>
          <div className="card table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {manage && (
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select everyone"
                        checked={selected.size === data.people.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(data.people.map((p) => p.user.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th>Person</th><th>Stage</th><th>Required</th><th>Unpaid</th><th>Entitlement</th><th>Adjustment</th><th>Estimated earnings</th><th>Waiting on</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => {
                  const st = PAYROLL_STATUS[p.status] || { label: p.status, tone: 'neutral' };
                  const rec = p.record ? RECORD_STATUS[p.record.status] : null;
                  const waiting = [...p.setup.filter((s) => !s.code.startsWith('POLICY_')).map((s) => s.label), ...p.blockers.map((b) => b.label)];
                  return (
                    <tr key={p.user.id} className="clickable" onClick={() => setOpen(p.user)}>
                      {manage && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${p.user.full_name}`} checked={selected.has(p.user.id)} onChange={() => toggle(p.user.id)} />
                        </td>
                      )}
                      <td>
                        <div className="row" style={{ gap: 8 }}><Avatar name={p.user.full_name} color={p.user.avatar_color} size={24} /> {p.user.full_name}</div>
                      </td>
                      <td>{rec && p.record.status !== 'DRAFT' ? <Badge tone={rec.tone}>{rec.label}{p.record.version > 1 ? ` v${p.record.version}` : ''}</Badge> : <Badge tone={st.tone}>{st.label}</Badge>}</td>
                      <td className="tnum">{hhmm(p.totals.required)}</td>
                      <td className="tnum">{hhmm(p.totals.unpaid)}</td>
                      <td className="tnum">{p.salary?.status === 'CALCULATED' ? money(p.salary.entitlement, p.salary.currency) : '—'}</td>
                      <td className="tnum">{p.salary?.status === 'CALCULATED' ? money(p.salary.attendance_adjustment, p.salary.currency) : '—'}</td>
                      <td className="tnum"><strong>{p.salary?.status === 'CALCULATED' ? money(p.salary.attendance_adjusted_earnings, p.salary.currency) : '—'}</strong></td>
                      <td className="small">{waiting.length ? waiting.join(' · ') : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="small muted">
            Method (proposed, needs HR confirmation): adjustment = attendance-sensitive monthly amount × unpaid time ÷ required time.
            Fixed components are shown in the detail and are not adjusted.
          </div>
        </>
      )}

      {open && <PayrollPerson month={month} user={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function PayrollPerson({ month, user, onClose, onChanged }) {
  const toast = useToast();
  const { can, user: me } = useAuth();
  const [data, setData] = useState(null);
  const [basis, setBasis] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api.payrollPerson(month, user.id).then(setData).catch(toast.error);
    api.salaryBasis(user.id).then((d) => setBasis(d.basis)).catch(() => {});
  }, [month, user.id, toast]);
  useEffect(load, [load]);

  const act = async (action, reason) => {
    try {
      await api.payrollAction(month, user.id, action, reason);
      toast.success('Done');
      setReasonFor(null);
      load();
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const record = data?.record;
  const stage = record?.status || 'DRAFT';
  const manage = can('payroll.manage');
  const self = user.id === me.id;
  const pay = data?.salary;

  return (
    <Modal title={`${user.full_name} · ${monthName(month)}`} onClose={onClose} size="lg">
      {!data ? <Spinner /> : (
        <div className="stack">
          <div className="row wrap" style={{ gap: 8 }}>
            <Badge tone={(RECORD_STATUS[stage] || {}).tone}>{(RECORD_STATUS[stage] || {}).label}{record?.version > 1 ? ` · version ${record.version}` : ''}</Badge>
            {!data.frozen && <Badge tone={(PAYROLL_STATUS[data.status] || {}).tone}>{(PAYROLL_STATUS[data.status] || {}).label}</Badge>}
            {data.frozen && <span className="small muted">Showing the figures frozen when it was approved.</span>}
          </div>

          {(data.setup.length > 0 || data.blockers.length > 0) && (
            <div className="callout is-quiet small">
              <Icon name="alert" />
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {data.setup.map((s) => <li key={s.code}>{s.label}</li>)}
                {data.blockers.map((b) => <li key={b.code}>{b.label}</li>)}
              </ul>
            </div>
          )}
          {data.assumptions?.map((a) => <div key={a} className="small muted">Assumption: {a}</div>)}

          <div className="att-totals">
            <div className="att-total"><span className="att-total-label">Attendance-sensitive entitlement</span><strong className="tnum">{pay?.status === 'CALCULATED' ? money(pay.entitlement, pay.currency) : '—'}</strong></div>
            <div className="att-total"><span className="att-total-label">Attendance adjustment</span><strong className="tnum">{pay?.status === 'CALCULATED' ? `− ${money(pay.attendance_adjustment, pay.currency)}` : '—'}</strong></div>
            <div className="att-total"><span className="att-total-label">Estimated earnings</span><strong className="tnum">{pay?.status === 'CALCULATED' ? money(pay.attendance_adjusted_earnings, pay.currency) : '—'}</strong></div>
            <div className="att-total"><span className="att-total-label">Fixed components (not adjusted)</span><strong className="tnum">{pay?.fixed_components !== undefined ? money(pay.fixed_components, pay.currency) : '—'}</strong></div>
          </div>
          {pay?.status && pay.status !== 'CALCULATED' && <div className="small muted">{pay.reason}</div>}
          {pay?.segments?.length > 1 && (
            <div className="small">
              {pay.segments.map((s) => (
                <div key={s.from}>{dayName(s.from)} – {dayName(s.to)}: {money(s.monthly_base)} a month → {money(s.prorated_entitlement)}, adjustment {money(s.adjustment)}</div>
              ))}
            </div>
          )}

          {(manage || can('payroll.approve') || can('payroll.reopen')) && (
            <div className="row wrap" style={{ gap: 6 }}>
              {manage && stage === 'DRAFT' && <button type="button" className="btn btn-sm btn-primary" disabled={data.status !== 'READY'} onClick={() => act('submit')}>Submit for review</button>}
              {can('payroll.approve') && stage === 'IN_REVIEW' && <button type="button" className="btn btn-sm btn-primary" disabled={self} onClick={() => act('approve')}>Approve</button>}
              {can('payroll.approve') && stage === 'APPROVED' && <button type="button" className="btn btn-sm btn-primary" disabled={self} onClick={() => act('lock')}>Lock</button>}
              {manage && ['IN_REVIEW', 'APPROVED'].includes(stage) && <button type="button" className="btn btn-sm" onClick={() => setReasonFor('return')}>Send back</button>}
              {can('payroll.reopen') && stage === 'LOCKED' && <button type="button" className="btn btn-sm" onClick={() => setReasonFor('reopen')}>Reopen</button>}
              {self && ['IN_REVIEW', 'APPROVED'].includes(stage) && <span className="small muted">Someone else approves and locks your own pay.</span>}
            </div>
          )}

          <section className="stack-sm">
            <div className="row-between">
              <h3>Salary basis</h3>
              {can('payroll.salary.edit') && <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add from a date</button>}
            </div>
            {!basis ? <Spinner /> : basis.length === 0 ? <div className="small muted">No salary recorded.</div> : (
              <table className="data">
                <thead><tr><th>From</th><th>Attendance-sensitive</th><th>Fixed</th><th>Note</th><th>By</th></tr></thead>
                <tbody>
                  {basis.map((b) => (
                    <tr key={b.id}>
                      <td>{dayName(b.effective_from)} {b.effective_from.slice(0, 4)}</td>
                      <td className="tnum">{money(b.attendance_sensitive, b.currency)}</td>
                      <td className="tnum">{money(b.fixed_components, b.currency)}</td>
                      <td className="small">{b.note}</td>
                      <td className="small muted">{b.created_by_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="stack-sm">
            <h3>Day by day</h3>
            <MonthLedger data={data} />
          </section>

          {data.versions?.length > 0 && (
            <section className="stack-sm">
              <h3>History</h3>
              <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
                {data.versions.map((v) => (
                  <li key={v.id}>
                    Version {v.version}: {(RECORD_STATUS[v.status] || {}).label}
                    {v.submitted_by_name && ` · submitted by ${v.submitted_by_name}`}
                    {v.approved_by_name && ` · approved by ${v.approved_by_name}`}
                    {v.locked_by_name && ` · locked by ${v.locked_by_name}`}
                    {v.reopened_by_name && ` · reopened by ${v.reopened_by_name}: “${v.reopen_reason}”`}
                    {v.export_count > 0 && ` · exported ${v.export_count}×`}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {reasonFor && (
        <ReasonDialog
          title={reasonFor === 'reopen' ? 'Reopen a locked month' : 'Send back to draft'}
          hint={reasonFor === 'reopen' ? 'The locked version is kept; a new version starts as a draft.' : 'It returns to draft so it can be corrected and submitted again.'}
          onClose={() => setReasonFor(null)}
          onConfirm={(reason) => act(reasonFor, reason)}
        />
      )}
      {adding && <SalaryDialog userId={user.id} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); onChanged(); }} />}
    </Modal>
  );
}

function ReasonDialog({ title, hint, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!reason.trim()} onClick={() => onConfirm(reason)}>Confirm</button>
        </>
      )}
    >
      <Field label="Reason (kept in the audit log)" hint={hint}>
        <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Field>
    </Modal>
  );
}

function SalaryDialog({ userId, onClose, onSaved }) {
  const toast = useToast();
  const [from, setFrom] = useState(`${todayIn().slice(0, 7)}-01`);
  const [sensitive, setSensitive] = useState('');
  const [fixed, setFixed] = useState('0');
  const [note, setNote] = useState('');
  const save = async () => {
    try {
      await api.addSalaryBasis(userId, { effective_from: from, attendance_sensitive: Number(sensitive), fixed_components: Number(fixed || 0), note });
      toast.success('Saved. Earlier amounts are kept.');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal
      title="Salary from a date"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!sensitive} onClick={save}>Save</button>
        </>
      )}
    >
      <div className="stack">
        <Field label="Effective from"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <div className="grid-2">
          <Field label="Attendance-sensitive monthly amount (₹)" hint="The part reduced for unpaid time. Not total CTC.">
            <input className="input" type="number" min="0" step="0.01" value={sensitive} onChange={(e) => setSensitive(e.target.value)} />
          </Field>
          <Field label="Fixed components (₹)" hint="Shown for reference, never adjusted.">
            <input className="input" type="number" min="0" step="0.01" value={fixed} onChange={(e) => setFixed(e.target.value)} />
          </Field>
        </div>
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}
