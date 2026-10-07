import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadFile } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { useAttendance } from '../state/attendance.jsx';
import { Avatar, Badge, EmptyState, Icon, Modal, Spinner } from '../components/ui.jsx';
import {
  CorrectionDialog, CorrectionList, DecisionDialog, FlagBadges, LeaveDialog, LeaveList, LocationDialog,
  MonthLedger, TodayAttendanceCard,
} from '../components/Attendance.jsx';
import {
  BLOCKER_LABEL, clockIn, dayMeta, dayName, hhmm, monthName, shiftMonth, todayIn, words,
} from '../lib/attendance.js';

/**
 * Attendance and leave. Everyone has Today, My month and My leave. Team and
 * Approvals appear only for people authorised to see others' attendance —
 * and then only for the teams they have been granted.
 */
export default function Attendance() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const teamView = can('attendance.team') || can('attendance.all');
  const approver = can('attendance.approve') || can('attendance.extra.review') || can('leave.approve');
  const tabs = [
    ['today', 'Today'],
    ['month', 'My month'],
    ['leave', 'My leave'],
    ...(teamView ? [['team', 'Team']] : []),
    ...(approver ? [['approvals', 'Approvals']] : []),
  ];
  const tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'today';
  const setTab = (key) => setParams(key === 'today' ? {} : { tab: key }, { replace: true });

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div>
        <h1>Attendance</h1>
        <div className="small muted">Check in and out, see your month, ask for leave or a correction.</div>
      </div>
      <div className="tabs tabs-scroll">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'today' && <TodayTab />}
      {tab === 'month' && <MyMonthTab />}
      {tab === 'leave' && <MyLeaveTab />}
      {tab === 'team' && <TeamTab />}
      {tab === 'approvals' && <ApprovalsTab />}
    </div>
  );
}

function TodayTab() {
  const toast = useToast();
  const [corrections, setCorrections] = useState(null);
  const load = useCallback(() => { api.corrections({ scope: 'mine' }).then((d) => setCorrections(d.corrections)).catch(toast.error); }, [toast]);
  useEffect(load, [load]);
  return (
    <div className="stack">
      <TodayAttendanceCard />
      <section className="card">
        <div className="card-head"><h2>My correction requests</h2></div>
        <div className="card-pad">
          {!corrections ? <Spinner /> : (
            <CorrectionList
              items={corrections.slice(0, 20)}
              onCancel={async (c) => { try { await api.cancelCorrection(c.id); load(); } catch (err) { toast.error(err); } }}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function MonthPicker({ month, onChange }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <button type="button" className="btn btn-sm btn-icon" onClick={() => onChange(shiftMonth(month, -1))} aria-label="Previous month">
        <Icon name="chevron" style={{ transform: 'rotate(180deg)' }} />
      </button>
      <strong className="att-month">{monthName(month)}</strong>
      <button type="button" className="btn btn-sm btn-icon" onClick={() => onChange(shiftMonth(month, 1))} aria-label="Next month" disabled={month >= todayIn().slice(0, 7)}>
        <Icon name="chevron" />
      </button>
    </div>
  );
}

function MyMonthTab() {
  const toast = useToast();
  const { reload } = useAttendance();
  const [month, setMonth] = useState(todayIn().slice(0, 7));
  const [data, setData] = useState(null);
  const [correction, setCorrection] = useState(null);
  const [locationOf, setLocationOf] = useState(null);
  const load = useCallback(() => { setData(null); api.myAttendance(month).then(setData).catch(toast.error); }, [month, toast]);
  useEffect(load, [load]);

  return (
    <div className="stack">
      <div className="row-between wrap">
        <MonthPicker month={month} onChange={setMonth} />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => downloadFile(api.attendanceExportUrl({ from: `${month}-01`, to: data?.days.at(-1)?.date }), `my-attendance-${month}.csv`).catch(toast.error)}
          disabled={!data}
        >
          Download CSV
        </button>
      </div>
      {!data ? <Spinner /> : (
        <>
          {data.salary && (
            <div className="callout is-quiet small">
              <Icon name="alert" />
              <span>Estimated attendance-adjusted earnings: <strong>{data.salary.attendance_adjusted_earnings}</strong> ({data.salary_status === 'READY' ? 'ready for payroll' : 'provisional'}). Payroll confirms the final figure.</span>
            </div>
          )}
          <MonthLedger
            data={data}
            onCorrect={(d) => setCorrection({ work_date: d.date, kind: d.session ? (d.session.status === 'COMPLETED' ? 'WRONG_TIME' : 'MISSED_CHECK_OUT') : 'MISSED_CHECK_IN' })}
            onLocation={setLocationOf}
          />
        </>
      )}
      {correction && <CorrectionDialog {...correction} onClose={() => setCorrection(null)} onSaved={() => { setCorrection(null); load(); reload(); }} />}
      {locationOf && <LocationDialog sessionId={locationOf} onClose={() => setLocationOf(null)} />}
    </div>
  );
}

function MyLeaveTab() {
  const toast = useToast();
  const [requests, setRequests] = useState(null);
  const [balance, setBalance] = useState(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(() => {
    api.myLeave().then((d) => setRequests(d.requests)).catch(toast.error);
    api.leaveBalance({}).then(setBalance).catch(() => {});
  }, [toast]);
  useEffect(load, [load]);

  return (
    <div className="stack">
      <div className="row-between wrap">
        <div className="att-balance">
          {balance?.buckets.map((b) => (
            <div key={b.bucket} className="att-total">
              <span className="att-total-label">{b.label} · {monthName(balance.month)}</span>
              <strong className="tnum">{b.left} of {b.allowance} left</strong>
              <span className="small muted">Paid only once approved</span>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setAsking(true)}><Icon name="plus" /> Request leave</button>
      </div>
      <section className="card">
        <div className="card-head"><h2>My requests</h2></div>
        <div className="card-pad">
          {!requests ? <Spinner /> : (
            <LeaveList
              items={requests}
              onSubmit={async (r) => { try { await api.submitLeave(r.id); toast.success('Sent for approval'); load(); } catch (err) { toast.error(err); } }}
              onCancel={async (r) => { try { await api.cancelLeave(r.id); toast.success('Cancelled'); load(); } catch (err) { toast.error(err); } }}
            />
          )}
        </div>
      </section>
      {asking && <LeaveDialog onClose={() => setAsking(false)} onSaved={() => { setAsking(false); load(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- team

function TeamTab() {
  const toast = useToast();
  const { can } = useAuth();
  const { departments } = useRefData();
  const [date, setDate] = useState(todayIn());
  const [departmentId, setDepartmentId] = useState('');
  const [data, setData] = useState(null);
  const [view, setView] = useState('day');
  const [month, setMonth] = useState(todayIn().slice(0, 7));
  const [monthData, setMonthData] = useState(null);
  const [person, setPerson] = useState(null);
  const [locationOf, setLocationOf] = useState(null);
  const [withLocation, setWithLocation] = useState(false);

  useEffect(() => {
    if (view !== 'day') return;
    setData(null);
    api.teamToday({ date, department_id: departmentId || undefined }).then(setData).catch(toast.error);
  }, [date, departmentId, view, toast]);
  useEffect(() => {
    if (view !== 'month') return;
    setMonthData(null);
    api.teamMonth({ month, department_id: departmentId || undefined }).then(setMonthData).catch(toast.error);
  }, [month, departmentId, view, toast]);

  const exportCsv = () => {
    const from = view === 'day' ? date : `${month}-01`;
    const to = view === 'day' ? date : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    downloadFile(api.attendanceExportUrl({ from, to, department_id: departmentId || undefined, include_location: withLocation ? 1 : undefined }), `attendance-${from}-to-${to}.csv`).catch(toast.error);
  };

  const c = data?.counts;
  return (
    <div className="stack">
      <div className="row-between wrap" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="seg">
            <button type="button" className={view === 'day' ? 'is-on' : ''} onClick={() => setView('day')}>Day</button>
            <button type="button" className={view === 'month' ? 'is-on' : ''} onClick={() => setView('month')}>Month</button>
          </div>
          {view === 'day'
            ? <input className="input" type="date" value={date} max={todayIn()} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
            : <MonthPicker month={month} onChange={setMonth} />}
          <select className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All teams I can see</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {can('attendance.location') && (
            <label className="check small"><input type="checkbox" checked={withLocation} onChange={(e) => setWithLocation(e.target.checked)} /> Include coordinates</label>
          )}
          <button type="button" className="btn btn-sm" onClick={exportCsv}>Download CSV</button>
        </div>
      </div>

      {view === 'day' && (!data ? <Spinner /> : (
        <>
          <div className="att-counts">
            <Count label="Checked in" value={c.checked_in} tone="brand" />
            <Count label="Checked out" value={c.checked_out} tone="good" />
            <Count label="Not checked in" value={c.not_checked_in} tone={c.not_checked_in ? 'warning' : null} />
            <Count label="On leave" value={c.on_leave} />
            <Count label="Late" value={c.late} tone={c.late ? 'warning' : null} />
            <Count label="Missing check-out" value={c.missing_checkout} tone={c.missing_checkout ? 'critical' : null} />
            <Count label="Needs a look" value={c.needs_review} hint="Low accuracy, long sessions" />
            <Count label="Off today" value={c.off} />
          </div>
          {data.people.length === 0 ? (
            <EmptyState title="Nobody to show">You have not been given any team’s attendance yet. An admin grants it in Settings → Attendance &amp; pay.</EmptyState>
          ) : (
            <div className="card table-wrap">
              <table className="data">
                <thead><tr><th>Person</th><th>Status</th><th>In</th><th>Out</th><th>Duration</th><th>Mode</th><th /></tr></thead>
                <tbody>
                  {data.people.map((p) => {
                    const meta = dayMeta(p.day.classification);
                    const s = p.day.session;
                    return (
                      <tr key={p.user.id} className="clickable" onClick={() => setPerson(p.user)}>
                        <td>
                          <div className="row" style={{ gap: 8 }}>
                            <Avatar name={p.user.full_name} color={p.user.avatar_color} size={24} />
                            <div>
                              <div>{p.user.full_name}</div>
                              <div className="small muted">{p.user.department_name}</div>
                            </div>
                          </div>
                        </td>
                        <td><Badge tone={meta.tone}>{meta.label}</Badge> <FlagBadges flags={p.day.flags} reviewFlags={s?.review_flags} /></td>
                        <td className="tnum">{s ? clockIn(s.check_in_at) : ''}</td>
                        <td className="tnum">{s?.check_out_at ? clockIn(s.check_out_at) : ''}</td>
                        <td className="tnum">{p.day.duration ? hhmm(p.day.duration) : ''}</td>
                        <td className="small muted">{p.attendance_required ? p.work_mode.toLowerCase() : 'not required'}</td>
                        <td>
                          {p.can_view_location && (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setLocationOf(s.id); }}>Location</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ))}

      {view === 'month' && (!monthData ? <Spinner /> : (
        <div className="card table-wrap">
          <table className="data">
            <thead>
              <tr><th>Person</th><th>Required so far</th><th>In office hours</th><th>Paid leave</th><th>Late days</th><th>Extra (pending)</th><th>Unpaid</th><th>Open items</th></tr>
            </thead>
            <tbody>
              {monthData.people.map((p) => (
                <tr key={p.user.id} className="clickable" onClick={() => setPerson(p.user)}>
                  <td>
                    <div className="row" style={{ gap: 8 }}><Avatar name={p.user.full_name} color={p.user.avatar_color} size={24} /> {p.user.full_name}</div>
                  </td>
                  <td className="tnum">{hhmm(p.totals.required_to_date ?? p.totals.required)}</td>
                  <td className="tnum">{hhmm(p.totals.in_schedule)}</td>
                  <td className="tnum">{hhmm(p.totals.paid_leave)}</td>
                  <td className="tnum">{p.day_counts.late}</td>
                  <td className="tnum">{hhmm(p.totals.extra_recorded)}{p.totals.extra_pending ? ` (${hhmm(p.totals.extra_pending)})` : ''}</td>
                  <td className="tnum">{hhmm(p.totals.unpaid)}</td>
                  <td className="small">{p.blockers.length ? p.blockers.map((b) => BLOCKER_LABEL[b] || b).join(', ') : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {person && <PersonMonth user={person} initialMonth={view === 'month' ? month : date.slice(0, 7)} onClose={() => setPerson(null)} />}
      {locationOf && <LocationDialog sessionId={locationOf} onClose={() => setLocationOf(null)} />}
    </div>
  );
}

function Count({ label, value, tone, hint }) {
  return (
    <div className={`att-count ${tone ? `is-${tone}` : ''}`} title={hint}>
      <strong className="tnum">{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/** A team member's month, for the people authorised to see it. */
function PersonMonth({ user, initialMonth, onClose }) {
  const toast = useToast();
  const { can, user: me } = useAuth();
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState(null);
  const [locationOf, setLocationOf] = useState(null);
  const [reviewDay, setReviewDay] = useState(null);
  const [reviewExtra, setReviewExtra] = useState(null);
  const load = useCallback(() => { setData(null); api.personAttendance(user.id, month).then(setData).catch(toast.error); }, [user.id, month, toast]);
  useEffect(load, [load]);
  const reviewer = can('attendance.approve') && user.id !== me.id;

  return (
    <Modal title={user.full_name} onClose={onClose} size="lg">
      <div className="stack">
        <MonthPicker month={month} onChange={setMonth} />
        {!data ? <Spinner /> : (
          <MonthLedger
            data={data}
            onLocation={setLocationOf}
            onReviewDay={reviewer && !data.locked ? setReviewDay : null}
            onReviewExtra={can('attendance.extra.review') && user.id !== me.id && !data.locked ? setReviewExtra : null}
          />
        )}
      </div>
      {locationOf && <LocationDialog sessionId={locationOf} onClose={() => setLocationOf(null)} />}
      {reviewDay && (
        <DecisionDialog
          title={`${user.full_name} · ${dayName(reviewDay.date)}`}
          summary={<p className="small">No attendance and no leave recorded on a scheduled day. Until you decide, it stays “Unrecorded — needs review” and is not treated as an absence.</p>}
          options={[{ value: 'UNAPPROVED_ABSENCE', label: 'Confirm unapproved absence', hint: 'unpaid; extra time cannot offset it', needsNote: true, danger: true }]}
          onClose={() => setReviewDay(null)}
          onDecide={async (decision, note) => {
            try { await api.reviewDay({ user_id: user.id, work_date: reviewDay.date, decision, note }); setReviewDay(null); load(); } catch (err) { toast.error(err); }
          }}
        />
      )}
      {reviewExtra && <ExtraDialog user={user} day={reviewExtra} onClose={() => setReviewExtra(null)} onSaved={() => { setReviewExtra(null); load(); }} />}
    </Modal>
  );
}

function ExtraDialog({ user, day, onClose, onSaved }) {
  const toast = useToast();
  return (
    <DecisionDialog
      title={`Extra time · ${user.full_name} · ${dayName(day.date || day.work_date)}`}
      summary={<p className="small">{words(day.E_recorded ?? day.extra_seconds)} recorded after office hours. Eligible time can offset a shortfall elsewhere in the same month; it is never paid as overtime.</p>}
      options={[
        { value: 'ELIGIBLE', label: 'Count it', hint: 'may offset a shortfall' },
        { value: 'REJECTED', label: 'Do not count it', needsNote: true, danger: true },
      ]}
      onClose={onClose}
      onDecide={async (status, reason) => {
        try { await api.reviewExtra({ user_id: user.id, work_date: day.date || day.work_date, status, reason }); onSaved(); } catch (err) { toast.error(err); }
      }}
    />
  );
}

// ---------------------------------------------------------------- approvals

function ApprovalsTab() {
  const toast = useToast();
  const { can } = useAuth();
  const [leave, setLeave] = useState(null);
  const [corrections, setCorrections] = useState(null);
  const [queue, setQueue] = useState(null);
  const [month, setMonth] = useState(todayIn().slice(0, 7));
  const [deciding, setDeciding] = useState(null);
  const [extraFor, setExtraFor] = useState(null);
  const [dayFor, setDayFor] = useState(null);

  const load = useCallback(() => {
    if (can('leave.approve')) api.teamLeave({ status: 'pending' }).then((d) => setLeave(d.requests)).catch(toast.error);
    if (can('attendance.approve')) api.corrections({ scope: 'team', status: 'PENDING' }).then((d) => setCorrections(d.corrections)).catch(toast.error);
    if (can('attendance.approve') || can('attendance.extra.review')) api.reviewQueue(month).then((d) => setQueue(d.items)).catch(toast.error);
  }, [can, toast, month]);
  useEffect(load, [load]);

  const extras = (queue || []).filter((i) => i.kind === 'EXTRA_PENDING');
  const unrecorded = (queue || []).filter((i) => i.kind === 'UNRECORDED');
  const missing = (queue || []).filter((i) => i.kind === 'MISSING_CHECKOUT');

  return (
    <div className="stack">
      {can('leave.approve') && (
        <section className="card">
          <div className="card-head"><h2>Leave waiting for a decision</h2></div>
          <div className="card-pad">{!leave ? <Spinner /> : <LeaveList items={leave} showWho onDecide={(r) => setDeciding({ type: 'leave', item: r })} />}</div>
        </section>
      )}
      {can('attendance.approve') && (
        <section className="card">
          <div className="card-head"><h2>Correction requests</h2></div>
          <div className="card-pad">{!corrections ? <Spinner /> : <CorrectionList items={corrections} showWho onDecide={(c) => setDeciding({ type: 'correction', item: c })} />}</div>
        </section>
      )}
      {(can('attendance.approve') || can('attendance.extra.review')) && (
        <>
          <section className="card">
            <div className="card-head">
              <h2>Days that need a decision</h2>
              <MonthPicker month={month} onChange={setMonth} />
            </div>
            <div className="card-pad stack">
              {!queue ? <Spinner /> : (
                <>
                  <QueueGroup
                    title="Extra time after hours"
                    note="Captured automatically; it only offsets a shortfall once you count it."
                    items={extras}
                    render={(i) => <>{words(i.extra_seconds)} after office hours · checked out {clockIn(i.check_out_at)}{i.long_session ? ' · unusually long session' : ''}</>}
                    action={can('attendance.extra.review') ? (i) => <button type="button" className="btn btn-sm" onClick={() => setExtraFor(i)}>Review</button> : null}
                    bulk={can('attendance.extra.review') && extras.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          try {
                            const res = await api.reviewExtra({ items: extras.filter((i) => !i.long_session).map((i) => ({ user_id: i.user.id, work_date: i.date, status: 'ELIGIBLE' })) });
                            const failed = res.results.filter((r) => !r.ok);
                            toast.success(`Counted ${res.results.length - failed.length}${failed.length ? `, ${failed.length} could not be` : ''}`);
                            load();
                          } catch (err) { toast.error(err); }
                        }}
                      >
                        Count all (except unusually long)
                      </button>
                    )}
                  />
                  <QueueGroup
                    title="Scheduled days with nothing recorded"
                    note="Not an absence until you confirm it. The person can still apply for leave or a correction."
                    items={unrecorded}
                    action={can('attendance.approve') ? (i) => <button type="button" className="btn btn-sm" onClick={() => setDayFor(i)}>Review</button> : null}
                  />
                  <QueueGroup title="Missing check-outs" note="Waiting for the person to request a correction." items={missing} />
                </>
              )}
            </div>
          </section>
        </>
      )}

      {deciding?.type === 'leave' && (
        <DecisionDialog
          title={`Leave · ${deciding.item.full_name}`}
          summary={<LeaveList items={[deciding.item]} />}
          options={[
            { value: 'APPROVED_PAID', label: 'Approve as paid', hint: 'within the monthly allowance; any excess is unpaid', needsNote: deciding.item.status !== 'SUBMITTED' },
            { value: 'APPROVED_UNPAID', label: 'Approve as unpaid' },
            { value: 'REJECTED', label: 'Do not approve', needsNote: true, danger: true },
          ]}
          onClose={() => setDeciding(null)}
          onDecide={async (decision, note) => {
            try {
              const res = await api.decideLeave(deciding.item.id, { decision, note });
              toast.success(res.status === 'REJECTED' ? 'Not approved' : `Approved: ${res.paid_days} paid, ${res.unpaid_days} unpaid`);
              setDeciding(null);
              load();
            } catch (err) { toast.error(err); }
          }}
        />
      )}
      {deciding?.type === 'correction' && (
        <DecisionDialog
          title={`Correction · ${deciding.item.full_name}`}
          summary={<CorrectionList items={[deciding.item]} />}
          options={[
            { value: 'APPROVED', label: 'Approve', hint: 'the original is kept and the result marked manually regularised' },
            { value: 'REJECTED', label: 'Do not approve', needsNote: true, danger: true },
          ]}
          onClose={() => setDeciding(null)}
          onDecide={async (decision, note) => {
            try { await api.decideCorrection(deciding.item.id, { decision, note }); toast.success('Decided'); setDeciding(null); load(); } catch (err) { toast.error(err); }
          }}
        />
      )}
      {extraFor && <ExtraDialog user={extraFor.user} day={{ ...extraFor, E_recorded: extraFor.extra_seconds }} onClose={() => setExtraFor(null)} onSaved={() => { setExtraFor(null); load(); }} />}
      {dayFor && (
        <DecisionDialog
          title={`${dayFor.user.full_name} · ${dayName(dayFor.date)}`}
          summary={<p className="small">No attendance and no leave on a scheduled day.</p>}
          options={[{ value: 'UNAPPROVED_ABSENCE', label: 'Confirm unapproved absence', hint: 'unpaid; extra time cannot offset it', needsNote: true, danger: true }]}
          onClose={() => setDayFor(null)}
          onDecide={async (decision, note) => {
            try { await api.reviewDay({ user_id: dayFor.user.id, work_date: dayFor.date, decision, note }); setDayFor(null); load(); } catch (err) { toast.error(err); }
          }}
        />
      )}
    </div>
  );
}

function QueueGroup({ title, note, items, render, action, bulk }) {
  return (
    <div className="stack-sm">
      <div className="row-between wrap">
        <div>
          <strong>{title}</strong> <span className="small muted">({items.length})</span>
          <div className="small muted">{note}</div>
        </div>
        {bulk}
      </div>
      {items.length === 0 ? <div className="small muted">None.</div> : (
        <div className="att-queue">
          {items.map((i) => (
            <div key={`${i.user.id}-${i.date}-${i.kind}`} className="att-item">
              <Avatar name={i.user.full_name} color={i.user.avatar_color} size={24} />
              <div className="grow">
                <strong>{i.user.full_name}</strong> <span className="small muted">· {dayName(i.date)}</span>
                {render && <div className="small">{render(i)}</div>}
              </div>
              {action?.(i)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

