import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import {
  AVAILABILITY_STATUSES, DAY_PART_LABEL, STATUS_META,
  addDays, dayLabel, describeConflict, describeEntry, formatDays, moveDeadlineTo, rangeLabel,
  todayIn, weekdayOf,
} from '../lib/availability.js';
import { formatDate } from '../lib/format.js';

/**
 * Leave and availability.
 *
 * Only the exceptions are recorded — on leave, a half day, unavailable — and
 * everyone can see them, because the point is that work gets planned around
 * them. There is deliberately no box for the reason: it is often medical or
 * personal, and it is nobody else's business. The note is what the person
 * chooses to tell the team.
 */

/** A small badge wherever a person is shown. Renders nothing when they are in. */
export function AwayBadge({ entry, today, compact = false }) {
  if (!entry) return null;
  const meta = STATUS_META[entry.status] || STATUS_META.ON_LEAVE;
  const label = compact
    ? (entry.status === 'HALF_DAY' ? `Half day (${DAY_PART_LABEL[entry.day_part] || ''})` : meta.label)
    : describeEntry(entry, today || todayIn());
  return (
    <Badge tone={meta.tone} title={entry.note ? `${describeEntry(entry, today || todayIn())} — ${entry.note}` : describeEntry(entry, today || todayIn())}>
      <Icon name="clock" size={10} /> {label}
    </Badge>
  );
}

const WHEN = [
  { value: 'today', label: 'Today' },
  { value: 'date', label: 'A specific date' },
  { value: 'range', label: 'A date range' },
];

/** Marking leave: today, one date, or a range; planned ahead or not. */
export function AvailabilityDialog({ entry = null, forUserId = null, initialDate = null, onClose, onSaved }) {
  const toast = useToast();
  const { user, can } = useAuth();
  const { users } = useRefData();
  const today = todayIn();
  const editing = Boolean(entry);
  const manager = can('user.edit');

  const [who, setWho] = useState(entry?.user_id ?? forUserId ?? user.id);
  const [when, setWhen] = useState(() => {
    if (!entry) return initialDate && initialDate !== today ? 'date' : 'today';
    if (entry.start_date === entry.end_date) return entry.start_date === today ? 'today' : 'date';
    return 'range';
  });
  const [status, setStatus] = useState(entry?.status ?? 'ON_LEAVE');
  const [start, setStart] = useState(entry?.start_date ?? initialDate ?? addDays(today, 1));
  const [end, setEnd] = useState(entry?.end_date ?? initialDate ?? addDays(today, 1));
  const [dayPart, setDayPart] = useState(entry?.day_part ?? 'AFTERNOON');
  const [note, setNote] = useState(entry?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  // a half day is always one date, so "a date range" makes no sense for it
  useEffect(() => { if (status === 'HALF_DAY' && when === 'range') setWhen('date'); }, [status]);

  const first = when === 'today' ? today : start;
  const last = when === 'range' ? end : first;
  const planned = first > today;

  const save = async () => {
    if (when === 'range' && last < first) return toast.error('The last day cannot be before the first');
    setSaving(true);
    try {
      const body = {
        status,
        start_date: first,
        end_date: last,
        day_part: status === 'HALF_DAY' ? dayPart : null,
        note: note.trim() || null,
      };
      const saved = editing
        ? await api.updateAvailability(entry.id, body)
        : await api.addAvailability({ ...body, user_id: Number(who) });
      onSaved?.();
      // if work is already due while they are away, say so before closing
      if (saved.tasks_due_during?.length) {
        setResult(saved);
      } else {
        toast.success(planned ? 'Planned — the team can see it' : 'Marked — the team can see it');
        onClose();
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (result) {
    const tasks = result.tasks_due_during;
    const mine = result.entry.user_id === user.id;
    return (
      <Modal
        title="Saved — some work falls due while away"
        onClose={onClose}
        footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}
      >
        <div className="stack">
          <p className="small">
            {tasks.length === 1 ? 'This task is' : `These ${tasks.length} tasks are`} due
            between {rangeLabel(result.entry.start_date, result.entry.end_date)}.
            {mine ? ' Hand them over or move the deadlines before you go.' : ' They may need handing over or moving.'}
            {' '}Whoever assigned them has been told.
          </p>
          <ul className="plain-list">
            {tasks.map((task) => (
              <li key={task.id} className="row" style={{ gap: 8 }}>
                <span className="task-ref">{task.ref}</span>
                <span className="grow truncate">{task.title}</span>
                <Badge tone="warning">due {dayLabel(task.due_day)}</Badge>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    );
  }

  const person = users.find((u) => u.id === Number(who));

  return (
    <Modal
      title={editing ? 'Change this entry' : who === user.id ? 'Mark yourself away' : `Mark ${person?.full_name || 'someone'} away`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : planned && status === 'ON_LEAVE' ? 'Plan this leave' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">
        {manager && !editing && (
          <Field label="Who" hint="Recording it for someone else tells them it was recorded">
            <select className="select" value={who} onChange={(e) => setWho(Number(e.target.value))}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.id === user.id ? `${u.full_name} (you)` : u.full_name}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="What">
          <div className="row wrap" style={{ gap: 6 }} role="radiogroup">
            {AVAILABILITY_STATUSES.map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={status === option.value}
                title={option.hint}
                className={`kind-chip${status === option.value ? ' is-active' : ''}`}
                onClick={() => setStatus(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {AVAILABILITY_STATUSES.find((o) => o.value === status)?.hint}
          </div>
        </Field>

        <Field label="When">
          <div className="row wrap" style={{ gap: 6 }} role="radiogroup">
            {WHEN.filter((w) => status !== 'HALF_DAY' || w.value !== 'range').map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={when === option.value}
                className={`kind-chip${when === option.value ? ' is-active' : ''}`}
                onClick={() => setWhen(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </Field>

        {when !== 'today' && (
          <div className="grid-2">
            <Field label={when === 'range' ? 'First day' : 'Date'}>
              <input className="input" type="date" value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  if (end < e.target.value) setEnd(e.target.value);
                }} />
            </Field>
            {when === 'range' && (
              <Field label="Last day" hint="Included">
                <input className="input" type="date" value={end} min={start}
                  onChange={(e) => setEnd(e.target.value)} />
              </Field>
            )}
          </div>
        )}

        {status === 'HALF_DAY' && (
          <Field label="Which half">
            <div className="row" style={{ gap: 6 }}>
              {['MORNING', 'AFTERNOON'].map((part) => (
                <button key={part} type="button"
                  className={`kind-chip${dayPart === part ? ' is-active' : ''}`}
                  onClick={() => setDayPart(part)}>
                  {part === 'MORNING' ? 'Morning' : 'Afternoon'}
                </button>
              ))}
            </div>
          </Field>
        )}

        <Field label="Note for the team (optional)"
          hint="Everyone can read this. There is no need to give a reason — just what they should know.">
          <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)}
            placeholder="Back Monday — reachable on phone for anything urgent" />
        </Field>

        <div className="callout is-quiet small">
          <Icon name="clock" size={14} />
          <span>
            {first === last ? dayLabel(first) : rangeLabel(first, last)}
            {planned ? ' · planned in advance' : first === today ? ' · starting today' : ''}
            {' · '}anyone assigning work due on {first === last ? 'that day' : 'those days'} will see a warning.
          </span>
        </div>
      </div>
    </Modal>
  );
}

/** One's own entries, with change and cancel. */
export function MyAvailability({ entries, today, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  if (!entries.length) return null;
  return (
    <ul className="plain-list">
      {entries.map((entry) => (
        <li key={entry.id} className="row" style={{ gap: 8 }}>
          <AwayBadge entry={entry} today={today} compact />
          <span className="grow small">
            {rangeLabel(entry.start_date, entry.end_date)}
            {entry.note && <span className="muted"> · {entry.note}</span>}
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(entry)}>Change</button>
          <ConfirmButton label="Cancel" confirmLabel="Cancel it?" className="btn btn-sm btn-ghost"
            onConfirm={async () => {
              try {
                await api.cancelAvailability(entry.id);
                toast.success('Cancelled');
                onChanged();
              } catch (err) { toast.error(err); }
            }} />
        </li>
      ))}
      {editing && (
        <AvailabilityDialog entry={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      )}
    </ul>
  );
}

/** The dashboard card: who is away today, who is next, and one's own. */
export function AwayCard({ onChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [marking, setMarking] = useState(false);

  const load = () => {
    api.availabilitySummary({ days: 14 }).then(setData).catch((err) => toast.error(err));
  };
  useEffect(load, []);

  const refresh = () => { load(); onChanged?.(); };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Who is away</h2>
        <button type="button" className="btn btn-sm" onClick={() => setMarking(true)}>
          <Icon name="clock" size={13} /> Mark leave
        </button>
      </div>
      <div className="card-pad stack-sm">
        {!data ? <Spinner label="Checking the calendar" /> : (
          <>
            <div className="stat-label">Today</div>
            {data.away_today.length === 0 ? (
              <div className="small muted">Everyone is in.</div>
            ) : (
              <ul className="plain-list">
                {data.away_today.map((entry) => (
                  <li key={entry.id} className="row" style={{ gap: 8 }}>
                    <Avatar name={entry.full_name} color={entry.avatar_color} size={22} />
                    <span className="grow small">
                      <strong>{entry.user_id === user.id ? 'You' : entry.full_name}</strong>
                      <span className="muted"> · {describeEntry(entry, data.today)}</span>
                      {entry.note && <div className="muted">{entry.note}</div>}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="stat-label" style={{ marginTop: 6 }}>Next two weeks</div>
            {data.upcoming.length === 0 ? (
              <div className="small muted">No leave planned.</div>
            ) : (
              <ul className="plain-list">
                {data.upcoming.map((entry) => (
                  <li key={entry.id} className="row" style={{ gap: 8 }}>
                    <Avatar name={entry.full_name} color={entry.avatar_color} size={22} />
                    <span className="grow small">
                      <strong>{entry.user_id === user.id ? 'You' : entry.full_name}</strong>
                      <span className="muted"> · {describeEntry(entry, data.today)}</span>
                    </span>
                    <span className="small muted tnum">{formatDays(entry.working_days)}</span>
                  </li>
                ))}
              </ul>
            )}

            {data.mine.length > 0 && (
              <>
                <div className="stat-label" style={{ marginTop: 6 }}>Yours</div>
                <MyAvailability entries={data.mine} today={data.today} onChanged={refresh} />
              </>
            )}
          </>
        )}
      </div>
      {marking && <AvailabilityDialog onClose={() => setMarking(false)} onSaved={refresh} />}
    </section>
  );
}

/**
 * The team calendar: people down the side, days across the top.
 * Everyone can see everyone's — that is what makes it useful for planning.
 */
export function TeamCalendar({ departmentId = '' }) {
  const toast = useToast();
  const { user, can } = useAuth();
  const { users } = useRefData();
  const [start, setStart] = useState(() => {
    // begin on the Monday of this week, so a fortnight reads as two working weeks
    const today = todayIn();
    const dow = weekdayOf(today);
    return addDays(today, dow === 0 ? -6 : 1 - dow);
  });
  const [data, setData] = useState(null);
  const [marking, setMarking] = useState(null);
  const scroller = useRef(null);
  const DAYS = 21;

  // on a narrow screen the grid scrolls sideways; open it on today, not on Monday
  useEffect(() => {
    const box = scroller.current;
    const cell = box?.querySelector('.cal-day.is-today');
    const pinned = box?.querySelector('th.cal-person');
    if (box && cell && pinned && box.scrollWidth > box.clientWidth) {
      // measured, because the sticky name column overlays whatever scrolls under it
      const gap = cell.getBoundingClientRect().left - pinned.getBoundingClientRect().right;
      box.scrollLeft = Math.max(0, box.scrollLeft + gap);
    }
  }, [data]);

  const load = () => {
    api.availability({ from: start, to: addDays(start, DAYS - 1) })
      .then(setData).catch((err) => toast.error(err));
  };
  useEffect(load, [start]);

  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(start, i)), [start]);
  const people = users.filter((u) => !departmentId || String(u.department_id) === String(departmentId));

  if (!data) return <Spinner label="Loading the team calendar" />;

  const entryFor = (userId, day) => data.entries.find(
    (e) => e.user_id === userId && e.start_date <= day && e.end_date >= day,
  );
  const awayCount = (day) => data.entries.filter((e) => e.start_date <= day && e.end_date >= day).length;

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>Team availability</h2>
          <div className="small muted">
            Planned and current leave for everyone. Blank means in.
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={() => setStart(addDays(start, -7))}>
            <Icon name="chevron" size={12} style={{ transform: 'rotate(180deg)' }} /> Earlier
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setStart(addDays(start, 7))}>
            Later <Icon name="chevron" size={12} />
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setMarking({ userId: user.id })}>
            <Icon name="clock" size={13} /> Mark leave
          </button>
        </div>
      </div>

      <div className="row wrap small" style={{ gap: 10 }}>
        {AVAILABILITY_STATUSES.map((s) => (
          <span key={s.value} className="row" style={{ gap: 5 }}>
            <span className={`cal-swatch cal-${s.value.toLowerCase()}`} /> {s.label}
          </span>
        ))}
      </div>

      {people.length === 0 ? <EmptyState title="Nobody to show" /> : (
        <div className="table-scroll" ref={scroller}>
          <table className="cal-table">
            <thead>
              <tr>
                <th className="cal-person">Person</th>
                {days.map((day) => {
                  const dow = weekdayOf(day);
                  return (
                    <th key={day} className={`cal-day${day === data.today ? ' is-today' : ''}${dow === 0 ? ' is-off' : ''}`}
                      title={dayLabel(day)}>
                      <span className="cal-dow">{dayLabel(day).slice(0, 2)}</span>
                      <span className="cal-num">{Number(day.slice(8))}</span>
                      {awayCount(day) > 0 && <span className="cal-count">{awayCount(day)}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id}>
                  <td className="cal-person">
                    <span className="row" style={{ gap: 6 }}>
                      <Avatar name={person.full_name} color={person.avatar_color} size={20} />
                      <span className="small truncate">{person.id === user.id ? `${person.full_name} (you)` : person.full_name}</span>
                    </span>
                  </td>
                  {days.map((day) => {
                    const entry = entryFor(person.id, day);
                    const dow = weekdayOf(day);
                    const canMark = person.id === user.id || can('user.edit');
                    return (
                      <td key={day}
                        className={`cal-cell${entry ? ` cal-${entry.status.toLowerCase()}` : ''}${entry?.day_part ? ` part-${entry.day_part.toLowerCase()}` : ''}${day === data.today ? ' is-today' : ''}${dow === 0 ? ' is-off' : ''}`}
                        title={entry
                          ? `${person.full_name}: ${describeEntry(entry, data.today)}${entry.note ? ` — ${entry.note}` : ''}`
                          : `${person.full_name}: in, ${dayLabel(day)}`}
                      >
                        {!entry && canMark && day >= data.today && (
                          <button type="button" className="cal-add" aria-label={`Mark ${person.full_name} away on ${dayLabel(day)}`}
                            onClick={() => setMarking({ userId: person.id, day })} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.entries.length > 0 && (
        <details className="small">
          <summary className="disclosure">Listed ({data.entries.length})</summary>
          <ul className="plain-list" style={{ marginTop: 6 }}>
            {data.entries.map((entry) => (
              <li key={entry.id} className="row" style={{ gap: 8 }}>
                <Avatar name={entry.full_name} color={entry.avatar_color} size={20} />
                <span className="grow">
                  <strong>{entry.full_name}</strong>
                  <span className="muted"> · {describeEntry(entry, data.today)}</span>
                  {entry.note && <span className="muted"> · {entry.note}</span>}
                </span>
                <span className="muted">
                  {entry.created_by !== entry.user_id && entry.created_by_name ? `recorded by ${entry.created_by_name} · ` : ''}
                  {formatDate(entry.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {marking && (
        <AvailabilityDialog forUserId={marking.userId} initialDate={marking.day || null}
          onClose={() => setMarking(null)} onSaved={load} />
      )}
    </section>
  );
}

/** On someone's profile: where they are today and what they have planned. */
export function PersonAvailability({ userId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const today = todayIn();
    api.availability({ user_id: userId, from: today, to: addDays(today, 90) })
      .then(setData).catch(() => setData(null));
  }, [userId]);
  if (!data) return null;
  const current = data.entries.find((e) => e.is_current);
  const upcoming = data.entries.filter((e) => e.is_upcoming);
  return (
    <div className="row wrap small" style={{ gap: 6 }}>
      {current ? <AwayBadge entry={current} today={data.today} /> : <Badge tone="good">Available today</Badge>}
      {upcoming.slice(0, 3).map((entry) => (
        <Badge key={entry.id} tone="neutral" title={entry.note || undefined}>
          {describeEntry(entry, data.today)}
        </Badge>
      ))}
      {upcoming.length > 3 && <span className="muted">and {upcoming.length - 3} more</span>}
    </div>
  );
}

/**
 * Who is away on a given instant (a deadline), as { userId: entry }.
 * With no instant, today.
 */
export function useAwayOn(atIso) {
  const [away, setAway] = useState({});
  useEffect(() => {
    let cancelled = false;
    const params = atIso ? { at: atIso } : { date: todayIn() };
    api.availabilityOn(params)
      .then((r) => !cancelled && setAway(r.away || {}))
      .catch(() => !cancelled && setAway({}));
    return () => { cancelled = true; };
  }, [atIso]);
  return away;
}

/**
 * The warning before a task is given to someone who will be away when it is due.
 *
 * It never blocks the save — a manager may know something the calendar does not
 * — but it offers the two obvious ways out: give it to someone who is in, or move
 * the deadline to the day they are back.
 */
export function AvailabilityWarning({
  assigneeId, dueIso, dueLocal, departmentId, away, canReassign, canEdit, onReassign, onMoveDeadline,
}) {
  const { users } = useRefData();
  const [conflict, setConflict] = useState(null);

  useEffect(() => {
    if (!assigneeId || !dueIso) {
      setConflict(null);
      return undefined;
    }
    let cancelled = false;
    api.checkAvailability(assigneeId, dueIso)
      .then((r) => !cancelled && setConflict(r.conflict))
      .catch(() => !cancelled && setConflict(null));
    return () => { cancelled = true; };
  }, [assigneeId, dueIso]);

  const message = describeConflict(conflict);
  if (!message) return null;

  // people who are in on the deadline, the same department first
  const alternatives = users
    .filter((u) => String(u.id) !== String(assigneeId) && !away[u.id])
    .sort((a, b) => (String(b.department_id) === String(departmentId)) - (String(a.department_id) === String(departmentId))
      || a.full_name.localeCompare(b.full_name));

  return (
    <div className={`ask-banner ${message.severity === 'warning' ? 'ask-warning' : 'ask-info'} availability-warning`}
      role="status">
      <Icon name="clock" size={15} />
      <div className="grow stack-sm" style={{ gap: 6 }}>
        <div>
          <strong>{message.headline}</strong>
          {message.detail && <div className="small">{message.detail}</div>}
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {canReassign && alternatives.length > 0 && (
            <select className="select select-sm" value="" aria-label="Give it to someone who is in"
              onChange={(e) => e.target.value && onReassign(e.target.value)}>
              <option value="">Give it to someone who is in…</option>
              {alternatives.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}{u.department_name ? ` · ${u.department_name}` : ''}
                </option>
              ))}
            </select>
          )}
          {canEdit && conflict.suggested_due_date && (
            <button type="button" className="btn btn-sm"
              onClick={() => onMoveDeadline(moveDeadlineTo(dueLocal, conflict.suggested_due_date))}>
              Move the deadline to {dayLabel(conflict.suggested_due_date)}, when they are back
            </button>
          )}
          <span className="small muted">Or keep it — saving is not blocked.</span>
        </div>
      </div>
    </div>
  );
}
