import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { useAttendance } from '../state/attendance.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import {
  BLOCKER_LABEL, CORRECTION_KINDS, CORRECTION_LABEL, CORRECTION_STATUS, DAY_PART, FLAG_LABEL, LEAVE_CATEGORIES,
  dayExtraState, extraBreakdown,
  LEAVE_STATUS, LOCATION_PROBLEM, PRIVACY_NOTICE, clockIn, dayMeta, dayName, hhmm, mapsLink, newRequestId,
  accuracyWords, readLocation, todayIn, words,
} from '../lib/attendance.js';

/**
 * Daily attendance on the client.
 *
 * Check In / Start Work and Check Out / End Work are their own actions, never
 * a side effect of signing in. Each reads the device's location fresh, says
 * plainly when it cannot, and never substitutes a guess. A request that may
 * have reached the server is checked before it is retried, and the retry
 * reuses the same request id so it can never record twice.
 */

export function PrivacyNote({ style }) {
  return (
    <div className="att-privacy small" style={style}>
      <Icon name="alert" size={13} />
      <span>{PRIVACY_NOTICE}</span>
    </div>
  );
}

export function FlagBadges({ flags = [], reviewFlags = [] }) {
  const all = [...new Set([...flags, ...reviewFlags])].filter((f) => FLAG_LABEL[f]);
  if (!all.length) return null;
  const tone = (f) => (['LATE', 'MISSING_CHECKOUT', 'EARLY_DEPARTURE'].includes(f) ? 'warning' : f === 'WITHIN_GRACE' ? 'good' : 'neutral');
  return (
    <span className="att-flags">
      {all.map((f) => <Badge key={f} tone={tone(f)}>{FLAG_LABEL[f]}</Badge>)}
    </span>
  );
}

/** The location step and the server call, shared by check in and check out. */
function useAttendanceAction(kind, { onDone }) {
  const toast = useToast();
  const { today, reload } = useAttendance();
  const [phase, setPhase] = useState('idle'); // idle | locating | sending | problem
  const [problem, setProblem] = useState(null);
  const [locationNote, setLocationNote] = useState(null);
  const requestId = useRef(null);

  const run = async () => {
    if (!requestId.current) requestId.current = newRequestId();
    setProblem(null);
    setPhase('locating');
    let location;
    try {
      location = await readLocation({ timeoutSeconds: today?.policy?.location_timeout_seconds || 15 });
      setLocationNote(location.accuracy > (today?.policy?.low_accuracy_meters || 200)
        ? `Location recorded ${accuracyWords(location.accuracy)}. That is fine — a rough fix is marked for review, never refused.`
        : null);
    } catch (err) {
      setProblem({ code: err.code, text: LOCATION_PROBLEM[err.code] || LOCATION_PROBLEM.UNAVAILABLE });
      setPhase('problem');
      return;
    }
    setPhase('sending');
    try {
      const body = { request_id: requestId.current, location };
      const result = kind === 'in' ? await api.checkIn(body) : await api.checkOut(body);
      requestId.current = null;
      toast.success(result.message || (kind === 'in' ? 'Checked in' : 'Checked out'));
      setPhase('idle');
      await reload();
      onDone?.(result);
    } catch (err) {
      if (err.status === 0) {
        // it may have landed: ask the server before offering a retry
        const fresh = await reload();
        const landed = kind === 'in' ? Boolean(fresh?.open_session || fresh?.session) : fresh?.session?.status === 'COMPLETED';
        if (landed) {
          requestId.current = null;
          setPhase('idle');
          toast.success(kind === 'in' ? 'Checked in' : 'Checked out');
          return;
        }
        setProblem({ code: 'NETWORK', text: 'The connection dropped before TaskFlow confirmed it. Nothing was recorded yet — try again.' });
      } else {
        requestId.current = null;
        setProblem({ code: err.details?.code || 'SERVER', text: err.message });
        if (['ALREADY_RECORDED', 'NOT_CHECKED_IN', 'MISSING_CHECKOUT'].includes(err.details?.code)) await reload();
      }
      setPhase('problem');
    }
  };

  return { run, phase, problem, locationNote, busy: phase === 'locating' || phase === 'sending', clear: () => { setPhase('idle'); setProblem(null); } };
}

function ActionProblem({ problem, onRetry, onCorrection }) {
  if (!problem) return null;
  return (
    <div className="callout att-problem" role="alert">
      <Icon name="alert" />
      <div className="grow stack-sm">
        <div className="small">{problem.text}</div>
        <div className="row wrap" style={{ gap: 8 }}>
          {!['ALREADY_RECORDED', 'MISSING_CHECKOUT'].includes(problem.code) && (
            <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCorrection}>Ask for a correction</button>
        </div>
      </div>
    </div>
  );
}

/** The card at the top of the dashboard, and the heart of the check-in screen. */
export function TodayAttendanceCard({ variant = 'card' }) {
  const { today, reload } = useAttendance();
  const [correction, setCorrection] = useState(null);
  const [locationOf, setLocationOf] = useState(null);
  const [tick, setTick] = useState(Date.now());
  const checkInAction = useAttendanceAction('in', {});
  const checkOutAction = useAttendanceAction('out', {});

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!today) {
    return <section className="card card-pad att-card"><Spinner label="Checking today’s attendance" /></section>;
  }

  const tz = today.policy.timezone;
  const open = today.open_session;
  const done = today.session?.status === 'COMPLETED' ? today.session : null;
  const day = today.day;
  const offDay = day && ['WEEKLY_OFF', 'HOLIDAY'].includes(day.schedule_state);
  const elapsed = open ? Math.max(0, Math.floor((tick - new Date(open.check_in_at)) / 1000)) : 0;
  const overnight = open && open.work_date !== today.today;
  const action = open ? checkOutAction : checkInAction;

  let headline;
  let tone = 'neutral';
  if (open) { headline = overnight ? `Checked in since ${dayName(open.work_date)}, ${clockIn(open.check_in_at, tz)}` : `Checked in at ${clockIn(open.check_in_at, tz)}`; tone = 'brand'; }
  else if (done) { headline = `Done for today · ${clockIn(done.check_in_at, tz)} – ${clockIn(done.check_out_at, tz)}`; tone = 'good'; }
  else if (offDay) headline = day.schedule_state === 'HOLIDAY' ? `Holiday${day.holiday ? ` — ${day.holiday}` : ''}` : 'Weekly day off';
  else if (day?.classification === 'PAID_LEAVE' || day?.classification === 'UNPAID_LEAVE') headline = 'On approved leave today';
  else headline = 'Not checked in yet';

  return (
    <section className={`card att-card ${variant === 'gate' ? 'att-card-gate' : ''}`} aria-label="Today’s attendance">
      <div className="att-card-body">
        <div className="att-card-main">
          <div className="att-eyebrow">
            Attendance · {dayName(today.today)} · office {today.policy.office_start}–{today.policy.office_end}
            {today.policy.grace_minutes ? ` · ${today.policy.grace_minutes} min grace` : ''}
          </div>
          <div className="att-headline">
            <span className={`att-dot att-dot-${tone}`} aria-hidden="true" />
            {headline}
          </div>
          <div className="att-meta small muted">
            {open && <>Recorded so far <strong className="tnum">{hhmm(elapsed)}</strong></>}
            {done && <>Recorded attendance duration <strong className="tnum">{hhmm(done.recorded_seconds)}</strong></>}
            {!open && !done && !offDay && day?.classification !== 'PAID_LEAVE' && today.policy.start_date && (
              <>Check in when you start work. Signing in to TaskFlow does not record attendance.</>
            )}
            {!today.policy.start_date && !open && !done && <>Attendance tracking has not started yet for the company — recording is optional for now.</>}
          </div>
          <FlagBadges flags={day?.flags} reviewFlags={(open || done)?.review_flags} />
        </div>

        <div className="att-card-actions">
          {!done && (
            <button
              type="button"
              className={`btn ${open ? '' : 'btn-primary'} att-action`}
              onClick={action.run}
              disabled={action.busy}
            >
              <Icon name={open ? 'logout' : 'clock'} />
              {action.phase === 'locating' ? 'Getting your location…'
                : action.phase === 'sending' ? 'Recording…'
                  : open ? 'Check Out / End Work' : 'Check In / Start Work'}
            </button>
          )}
          {(open || done) && (open || done).has_check_in_location && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLocationOf((open || done).id)}>
              View location
            </button>
          )}
        </div>
      </div>

      <div className="att-card-foot">
        <ActionProblem problem={action.problem} onRetry={action.run} onCorrection={() => setCorrection({ work_date: open?.work_date || today.today, kind: open ? 'MISSED_CHECK_OUT' : 'TECHNICAL' })} />
        {action.phase === 'locating' && (
          <div className="small muted">
            Your browser may ask to share your location — allow it. Indoors this can take up to {today.policy.location_timeout_seconds + 10} seconds;
            a rough fix is accepted.
          </div>
        )}
        {action.locationNote && action.phase === 'idle' && <div className="small muted">{action.locationNote}</div>}
        {(open || done) && (open || done).check_in_accuracy_m !== null && (open || done).check_in_accuracy_m !== undefined && (
          <div className="small muted">Check-in location {accuracyWords(Number((open || done).check_in_accuracy_m))}{done?.check_out_accuracy_m !== null && done?.check_out_accuracy_m !== undefined ? ` · check-out ${accuracyWords(Number(done.check_out_accuracy_m))}` : ''}</div>
        )}
        {today.missing_checkouts?.map((m) => (
          <div key={m.id} className="callout is-quiet att-missing">
            <Icon name="alert" />
            <div className="grow small">You did not check out on <strong>{dayName(m.work_date)}</strong>. The time is not guessed — tell us when you finished.</div>
            <button type="button" className="btn btn-sm" onClick={() => setCorrection({ work_date: m.work_date, kind: 'MISSED_CHECK_OUT' })}>Correct it</button>
          </div>
        ))}
        {today.corrections?.filter((c) => c.status === 'PENDING').length > 0 && (
          <div className="small muted">
            {today.corrections.filter((c) => c.status === 'PENDING').length} correction request(s) waiting for approval.
          </div>
        )}
        <div className="row-between wrap" style={{ gap: 8 }}>
          <PrivacyNote />
          {variant === 'card' && <Link to="/attendance?tab=month" className="btn btn-ghost btn-sm">My attendance &amp; leave <Icon name="chevron" size={13} /></Link>}
        </div>
      </div>

      {correction && <CorrectionDialog {...correction} onClose={() => setCorrection(null)} onSaved={() => { setCorrection(null); reload(); }} />}
      {locationOf && <LocationDialog sessionId={locationOf} onClose={() => setLocationOf(null)} />}
    </section>
  );
}

/** By the clock in India, not the device. */
function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * Shown in place of a work page while a check-in is required. Attendance,
 * corrections, leave and signing out are always reachable from here.
 */
export function AttendanceGate() {
  const { signOut, user } = useAuth();
  const { reload } = useAttendance();
  const [correction, setCorrection] = useState(false);
  const [leave, setLeave] = useState(false);
  return (
    <div className="att-gate">
      <div className="att-gate-intro">
        <h1>{greeting()}, {user.full_name.split(' ')[0]}</h1>
        <p className="muted">Check in to start work. Until you do, TaskFlow is read-only for you today — you can look around, but not change tasks, goals or leads.</p>
      </div>
      <TodayAttendanceCard variant="gate" />
      <div className="att-gate-links">
        <button type="button" className="btn btn-sm" onClick={() => setCorrection(true)}>
          <Icon name="edit" size={14} /> I can’t check in — ask for a correction
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setLeave(true)}>
          <Icon name="clock" size={14} /> Request leave
        </button>
        <Link to="/attendance" className="btn btn-sm btn-ghost">My attendance</Link>
        <button type="button" className="btn btn-sm btn-ghost" onClick={signOut}>
          <Icon name="logout" size={14} /> Sign out
        </button>
      </div>
      {correction && <CorrectionDialog work_date={todayIn()} kind="TECHNICAL" onClose={() => setCorrection(false)} onSaved={() => { setCorrection(false); reload(); }} />}
      {leave && <LeaveDialog onClose={() => setLeave(false)} onSaved={() => { setLeave(false); reload(); }} />}
    </div>
  );
}

/** Asking to put a day right. It goes to someone else to decide. */
export function CorrectionDialog({ work_date: initialDate, kind: initialKind = 'MISSED_CHECK_IN', onClose, onSaved }) {
  const toast = useToast();
  const [date, setDate] = useState(initialDate || todayIn());
  const [kind, setKind] = useState(initialKind);
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [nextDay, setNextDay] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const meta = CORRECTION_KINDS.find((k) => k.value === kind);
  const showIn = kind !== 'MISSED_CHECK_OUT' && kind !== 'REOPEN';
  const showOut = kind !== 'REOPEN';

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.requestCorrection({
        work_date: date, kind, reason,
        check_in: showIn && checkIn ? checkIn : null,
        check_out: showOut && checkOut ? checkOut : null,
        check_out_next_day: nextDay,
      });
      toast.success('Sent for approval. Nothing changes until someone approves it.');
      onSaved?.();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Ask for an attendance correction"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="correction-form" className="btn btn-primary" disabled={saving}>{saving ? 'Sending…' : 'Send for approval'}</button>
        </>
      )}
    >
      <form id="correction-form" className="stack" onSubmit={submit}>
        <div className="grid-2">
          <Field label="Day">
            <input className="input" type="date" value={date} max={todayIn()} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="What happened">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {CORRECTION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </Field>
        </div>
        {(showIn || showOut) && (
          <div className="grid-2">
            {showIn && (
              <Field label="Started at" hint={meta?.needs.includes('in') ? 'Required' : 'Only if it should change'}>
                <input className="input" type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required={meta?.needs.includes('in')} />
              </Field>
            )}
            {showOut && (
              <Field label="Finished at" hint={meta?.needs.includes('out') ? 'Required' : 'Leave empty if you are still working'}>
                <input className="input" type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required={meta?.needs.includes('out')} />
                <label className="check small" style={{ marginTop: 6 }}>
                  <input type="checkbox" checked={nextDay} onChange={(e) => setNextDay(e.target.checked)} /> After midnight (the next calendar day)
                </label>
              </Field>
            )}
          </div>
        )}
        <Field label="Explain" hint="Your approver sees this. The original record is kept either way.">
          <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={2000} placeholder="e.g. Phone battery died at 5:40 pm; I left the office at 6:15 pm" />
        </Field>
        <div className="callout is-quiet small">
          <Icon name="alert" />
          <span>An approved correction is marked “Manually regularised”. No location is attached to a corrected time.</span>
        </div>
      </form>
    </Modal>
  );
}

/** Coordinates for one session — never an address lookup, never sent anywhere unless the viewer opens the map. */
export function LocationDialog({ sessionId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.sessionLocation(sessionId).then(setData).catch(setError); }, [sessionId]);

  const Point = ({ label, point }) => (
    <div className="att-point">
      <div className="att-point-head">{label}</div>
      {!point ? <div className="small muted">No device location — {label.toLowerCase()} was not recorded from a device.</div> : (
        <>
          <dl className="att-dl">
            <dt>Latitude</dt><dd className="tnum">{point.latitude}</dd>
            <dt>Longitude</dt><dd className="tnum">{point.longitude}</dd>
            <dt>Accuracy</dt><dd className="tnum">± {Math.round(point.accuracy_m)} m</dd>
            <dt>Recorded</dt><dd>{clockIn(point.recorded_at)} India time, by the server clock</dd>
            <dt>Device reading</dt><dd>{point.device_time ? `${clockIn(point.device_time)} (time reported by the device)` : '—'}</dd>
          </dl>
          {data.map_links === 'GOOGLE' && (
            <a className="btn btn-sm" href={mapsLink(point.latitude, point.longitude)} target="_blank" rel="noopener noreferrer">
              Open in Google Maps
            </a>
          )}
        </>
      )}
    </div>
  );

  return (
    <Modal title="Attendance location" onClose={onClose}>
      {error && <EmptyState title="Location not available">{error.message}</EmptyState>}
      {!data && !error && <Spinner />}
      {data && (
        <div className="stack">
          <div className="grid-2">
            <Point label="Check in" point={data.check_in} />
            <Point label="Check out" point={data.check_out} />
          </div>
          <FlagBadges reviewFlags={data.review_flags} />
          <div className="callout is-quiet small">
            <Icon name="alert" />
            <span>
              {data.note} Opening the map sends these coordinates to Google, only when you click it.
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Asking for leave. Paid only if approved, and only within the monthly allowance. */
export function LeaveDialog({ onClose, onSaved }) {
  const toast = useToast();
  const { user } = useAuth();
  const { users } = useRefData();
  const today = todayIn();
  const [category, setCategory] = useState('CASUAL');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [dayPart, setDayPart] = useState('FULL');
  const [reason, setReason] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [notified, setNotified] = useState('');
  const [emailRef, setEmailRef] = useState('');
  const [meta, setMeta] = useState(null);
  const [preview, setPreview] = useState(null);
  const [balance, setBalance] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.leaveMeta().then(setMeta).catch(() => {}); }, []);
  useEffect(() => {
    if (!start || !end || end < start) { setPreview(null); return; }
    api.leavePreview({ start, end, day_part: dayPart }).then(setPreview).catch(() => setPreview(null));
    api.leaveBalance({ month: start.slice(0, 7) }).then(setBalance).catch(() => setBalance(null));
  }, [start, end, dayPart]);

  const single = start === end;
  const noticeHours = meta?.notice_hours ?? 48;
  const hoursAhead = (Date.parse(`${start}T${dayPart === 'SECOND_HALF' ? meta?.half_day_split || '13:30' : '09:00'}:00+05:30`) - Date.now()) / 3_600_000;
  const shortNotice = !emergency && hoursAhead < noticeHours;
  const others = useMemo(() => (users || []).filter((u) => u.id !== user.id && u.is_active !== false), [users, user.id]);

  const submit = async (draft) => {
    setSaving(true);
    try {
      await api.requestLeave({
        category, start_date: start, end_date: single ? start : end, day_part: single ? dayPart : 'FULL', reason,
        is_emergency: emergency, emergency_explanation: emergency ? explanation : null,
        notified_user_id: notified ? Number(notified) : null, email_reference: emailRef || null, draft,
      });
      toast.success(draft ? 'Saved as a draft' : 'Leave request sent for approval');
      onSaved?.();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Request leave"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={() => submit(true)} disabled={saving}>Save draft</button>
          <button type="button" className="btn btn-primary" onClick={() => submit(false)} disabled={saving || !reason.trim()}>
            {saving ? 'Sending…' : 'Send for approval'}
          </button>
        </>
      )}
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Type">
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              {LEAVE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          {single && (
            <Field label="Part of the day">
              <select className="select" value={dayPart} onChange={(e) => setDayPart(e.target.value)}>
                {Object.entries(DAY_PART).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="grid-2">
          <Field label="From">
            <input className="input" type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        {preview && (
          <div className="small muted">
            {preview.working_days ? `${preview.working_days} scheduled working day${preview.working_days === 1 ? '' : 's'}` : 'No scheduled working days in this range'}
            {balance && ['CASUAL', 'SICK', 'OTHER'].includes(category) && balance.buckets.map((b) => (
              <span key={b.bucket}> · {b.label}: {b.left} of {b.allowance} paid day{b.allowance === 1 ? '' : 's'} left in {start.slice(0, 7)}</span>
            ))}
          </div>
        )}
        <Field label="Reason" hint="Only you and your approvers see this.">
          <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} /> This is an emergency
        </label>
        {emergency && (
          <Field label="What is the emergency?" hint="So your approver can decide without chasing you.">
            <textarea className="textarea" value={explanation} onChange={(e) => setExplanation(e.target.value)} maxLength={2000} />
          </Field>
        )}
        {shortNotice && (
          <div className="callout small" style={{ borderLeftColor: 'var(--warning)', background: 'var(--warning-wash)' }}>
            <Icon name="alert" />
            <span>Planned leave needs at least {noticeHours} hours’ notice. This request will be marked “short notice” for your approver to decide. If it is an emergency, tick the box above.</span>
          </div>
        )}
        <details className="att-details">
          <summary className="small">Told someone already? (optional)</summary>
          <div className="grid-2" style={{ marginTop: 8 }}>
            <Field label="Who you told">
              <select className="select" value={notified} onChange={(e) => setNotified(e.target.value)}>
                <option value="">—</option>
                {others.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </Field>
            <Field label="Email reference" hint="e.g. the subject line and date">
              <input className="input" value={emailRef} onChange={(e) => setEmailRef(e.target.value)} maxLength={300} />
            </Field>
          </div>
        </details>
        <div className="callout is-quiet small">
          <Icon name="alert" />
          <span>{meta?.email_note || 'TaskFlow does not send email. Tell your manager or HR directly as well.'} Notice is counted from when TaskFlow receives this request.</span>
        </div>
      </div>
    </Modal>
  );
}

/** Approve / reject with a note, for leave and corrections alike. */
export function DecisionDialog({ title, summary, options, onDecide, onClose }) {
  const [choice, setChoice] = useState(options[0].value);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const selected = options.find((o) => o.value === choice);
  const needsNote = selected?.needsNote;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`btn ${selected?.danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={saving || (needsNote && !note.trim())}
            onClick={async () => { setSaving(true); try { await onDecide(choice, note); } finally { setSaving(false); } }}
          >
            {selected?.label}
          </button>
        </>
      )}
    >
      <div className="stack">
        {summary}
        <div className="att-choices" role="radiogroup">
          {options.map((o) => (
            <label key={o.value} className={`att-choice ${choice === o.value ? 'is-on' : ''}`}>
              <input type="radio" name="decision" value={o.value} checked={choice === o.value} onChange={() => setChoice(o.value)} />
              <span>
                <strong>{o.label}</strong>
                {o.hint && <span className="small muted"> — {o.hint}</span>}
              </span>
            </label>
          ))}
        </div>
        <Field label={needsNote ? 'Reason (required)' : 'Note (optional)'}>
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Modal>
  );
}

/** One person's month, day by day — the ledger a person can check line by line. */
export function MonthLedger({ data, onCorrect, onLocation, onReviewDay, onReviewExtra }) {
  const tz = data.policy?.timezone || 'Asia/Kolkata';
  const sessions = new Map((data.sessions || []).map((s) => [s.work_date, s]));
  const allocatedTo = new Map();
  for (const a of data.allocations || []) allocatedTo.set(a.target_date, (allocatedTo.get(a.target_date) || 0) + a.seconds);
  // what stayed unpaid on the day once extra time from any day was applied
  const unpaidOn = (d) => (d.unpaid ?? (d.N + d.remaining_short - (allocatedTo.get(d.date) || 0)));
  // how much of each day's extra time made up a shortfall, that day or later in the month
  const allocatedFrom = new Map();
  for (const a of data.allocations || []) allocatedFrom.set(a.source_date, (allocatedFrom.get(a.source_date) || 0) + a.seconds);
  const usedFrom = (d) => (d.same_day_offset || 0) + (allocatedFrom.get(d.date) || 0);
  const t = data.totals;
  const extra = extraBreakdown(t);
  return (
    <div className="stack">
      <div className="att-totals">
        {t.required_to_date !== undefined && t.required_to_date !== t.required
          ? <Total label="Required so far" value={hhmm(t.required_to_date)} hint={`${hhmm(t.required)} for the whole month`} />
          : <Total label="Required" value={hhmm(t.required)} />}
        <Total label="Within office hours" value={hhmm(t.in_schedule)} />
        <Total label="Paid leave" value={hhmm(t.paid_leave)} />
        <Total label="Grace credit" value={hhmm(t.grace)} />
        <Total
          label="Extra time"
          value={hhmm(extra.recorded)}
          hint={(
            <span className="att-extra-parts">
              {extra.parts.map((p) => <span key={p.key}><strong className="tnum">{hhmm(p.seconds)}</strong> {p.label}</span>)}
            </span>
          )}
        />
        <Total label="Unpaid" value={hhmm(t.unpaid)} tone={t.unpaid ? 'warning' : null} />
        <Total label="Unresolved" value={hhmm(t.unresolved)} tone={t.unresolved ? 'warning' : null} hint={t.unresolved ? 'Days still waiting for a record or a decision' : null} />
      </div>
      {data.days.some((d) => d.before_start) && (
        <div className="callout is-quiet small">
          <Icon name="alert" />
          <span>
            {data.policy?.start_date
              ? `Attendance tracking starts on ${dayName(data.policy.start_date)}.`
              : 'Attendance tracking has not started yet.'}
            {' '}Until then the days you check in are shown in full, days without a check-in are not counted, and nothing is unpaid.
          </span>
        </div>
      )}
      {data.days.some((d) => ['UPCOMING', 'IN_PROGRESS', 'NOT_CHECKED_IN'].includes(d.classification)) && (
        <div className="small muted">This month is still running — these are the figures so far, not a final result.</div>
      )}
      {data.blockers?.length > 0 && (
        <div className="callout is-quiet small">
          <Icon name="alert" />
          <span>Provisional: {data.blockers.map((b) => BLOCKER_LABEL[b] || b).join(' · ')}.</span>
        </div>
      )}
      <div className="card table-wrap">
        <table className="data att-ledger">
          <thead>
            <tr>
              <th>Day</th><th>Status</th><th>In</th><th>Out</th>
              <th title="Check-out minus check-in">Duration</th><th>Late</th><th>Extra</th><th>Unpaid</th><th />
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => {
              const s = sessions.get(d.date) || d.session;
              const meta = dayMeta(d.classification);
              const off = d.R === 0;
              return (
                <tr key={d.date} className={off ? 'att-off' : ''}>
                  <td className="nowrap">{dayName(d.date)}</td>
                  <td>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <FlagBadges flags={d.flags.filter((f) => f !== 'MISSING_CHECKOUT')} reviewFlags={s?.review_flags} />
                  </td>
                  <td className="tnum">{s ? clockIn(s.check_in_at, tz) : ''}{s?.check_in_source === 'MANUALLY_REGULARIZED' ? '*' : ''}</td>
                  <td className="tnum">{s?.check_out_at ? clockIn(s.check_out_at, tz) : ''}{s?.check_out_source === 'MANUALLY_REGULARIZED' ? '*' : ''}</td>
                  <td className="tnum">{d.duration ? hhmm(d.duration) : ''}</td>
                  <td className="tnum">{d.late_seconds ? hhmm(d.late_seconds) : ''}</td>
                  <td className="tnum">
                    {d.E_recorded > 0 && (() => {
                      const state = dayExtraState(d, usedFrom(d));
                      return (
                        <span className="att-extra-cell" title={state.title}>
                          {hhmm(d.E_recorded)}
                          <span className={`att-extra-state is-${state.tone}`}>{state.text}</span>
                        </span>
                      );
                    })()}
                  </td>
                  <td className="tnum">{unpaidOn(d) ? hhmm(unpaidOn(d)) : ''}</td>
                  <td className="att-row-actions">
                    {s?.has_check_in_location && onLocation && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onLocation(s.id)}>Location</button>}
                    {onCorrect && d.classification !== 'UPCOMING' && d.R + d.duration > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCorrect(d)}>Correct</button>}
                    {onReviewExtra && d.E_pending > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReviewExtra(d)}>Review extra</button>}
                    {onReviewDay && d.blockers.includes('UNRECORDED') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReviewDay(d)}>Review day</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="small muted">
        Durations are hours:minutes. “Duration” is the recorded attendance duration — check-out minus check-in — not a measure of work done.
        * marks a time set by an approved correction.
        Extra time is time after office hours. Once counted, it only makes up a shortfall in the same month — arriving after the
        grace period or leaving early. Counted time that isn’t needed stays on record; it is not paid as overtime.
      </div>
      {data.allocations?.length > 0 && (
        <details className="att-details">
          <summary className="small">How extra time was used this month</summary>
          <ul className="small" style={{ marginTop: 6 }}>
            {data.allocations.map((a, i) => (
              <li key={i}>{words(a.seconds)} from {dayName(a.source_date)} covered a shortfall on {dayName(a.target_date)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Total({ label, value, hint, tone }) {
  return (
    <div className={`att-total ${tone ? `is-${tone}` : ''}`}>
      <span className="att-total-label">{label}</span>
      <strong className="tnum">{value}</strong>
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}

/** Corrections and leave, as a person sees their own. */
export function CorrectionList({ items, onCancel, onDecide, showWho = false }) {
  if (!items.length) return <div className="empty small">Nothing here.</div>;
  return (
    <div className="stack-sm">
      {items.map((c) => {
        const st = CORRECTION_STATUS[c.status];
        return (
          <div key={c.id} className="att-item">
            {showWho && <Avatar name={c.full_name} color={c.avatar_color} size={26} />}
            <div className="grow">
              <div className="row wrap" style={{ gap: 6 }}>
                {showWho && <strong>{c.full_name}</strong>}
                <span>{dayName(c.work_date)} · {CORRECTION_LABEL[c.kind] || c.kind}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <div className="small muted">
                {c.proposed_check_in && <>Start {clockIn(c.proposed_check_in)} </>}
                {c.proposed_check_out && <>· Finish {clockIn(c.proposed_check_out)} </>}
                — “{c.reason}”
              </div>
              {c.review_note && <div className="small">Reviewer: {c.review_note}</div>}
            </div>
            {onCancel && c.status === 'PENDING' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCancel(c)}>Withdraw</button>}
            {onDecide && c.status === 'PENDING' && <button type="button" className="btn btn-sm btn-primary" onClick={() => onDecide(c)}>Decide</button>}
          </div>
        );
      })}
    </div>
  );
}

export function LeaveList({ items, onCancel, onDecide, onSubmit, showWho = false }) {
  if (!items.length) return <div className="empty small">No leave requests.</div>;
  return (
    <div className="stack-sm">
      {items.map((r) => {
        const st = LEAVE_STATUS[r.status];
        const range = r.start_date === r.end_date ? dayName(r.start_date) : `${dayName(r.start_date)} – ${dayName(r.end_date)}`;
        return (
          <div key={r.id} className="att-item">
            {showWho && <Avatar name={r.full_name} color={r.avatar_color} size={26} />}
            <div className="grow">
              <div className="row wrap" style={{ gap: 6 }}>
                {showWho && <strong>{r.full_name}</strong>}
                <span>{r.category_label} · {range}{r.day_part !== 'FULL' ? ` (${DAY_PART[r.day_part].toLowerCase()})` : ''}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
                {r.is_emergency && <Badge tone="serious">Emergency</Badge>}
                {r.notice_compliant === false && !r.is_emergency && <Badge tone="warning">Short notice</Badge>}
              </div>
              {r.reason && <div className="small muted">“{r.reason}”</div>}
              {r.emergency_explanation && <div className="small">Emergency: {r.emergency_explanation}</div>}
              {(r.paid_days > 0 || r.unpaid_days > 0) && (
                <div className="small">{r.paid_days} paid · {r.unpaid_days} unpaid</div>
              )}
              {r.email_reference && <div className="small muted">Says they told {r.notified_name || 'someone'} earlier: {r.email_reference} (their claim — TaskFlow did not send or see this email)</div>}
              {r.review_note && <div className="small">Reviewer: {r.review_note}</div>}
            </div>
            {onSubmit && r.status === 'DRAFT' && <button type="button" className="btn btn-sm" onClick={() => onSubmit(r)}>Submit</button>}
            {onCancel && !['REJECTED', 'CANCELLED'].includes(r.status) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCancel(r)}>Cancel</button>}
            {onDecide && r.can_decide && ['SUBMITTED', 'EMERGENCY_REVIEW', 'NOTICE_EXCEPTION'].includes(r.status) && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => onDecide(r)}>Decide</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Before signing out with attendance still open: a reminder, never an automatic check-out. */
export function SignOutReminder({ session, onClose, onSignOut }) {
  const { reload } = useAttendance();
  const checkOut = useAttendanceAction('out', { onDone: () => { onClose(); onSignOut(); } });
  return (
    <Modal
      title="You are still checked in"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onSignOut}>Sign out, stay checked in</button>
          <button type="button" className="btn btn-primary" onClick={checkOut.run} disabled={checkOut.busy}>
            {checkOut.busy ? 'Checking out…' : 'Check Out / End Work, then sign out'}
          </button>
        </>
      )}
    >
      <div className="stack">
        <p>
          Signing out of TaskFlow does not end your work day. You checked in at {clockIn(session.check_in_at)}.
          If you have finished for the day, check out first.
        </p>
        <ActionProblem problem={checkOut.problem} onRetry={checkOut.run} onCorrection={() => { onClose(); reload(); }} />
        <PrivacyNote />
      </div>
    </Modal>
  );
}
