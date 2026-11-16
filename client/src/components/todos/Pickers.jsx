/**
 * The small dialogs a to-do needs: choosing the one record it belongs to,
 * sharing it (always saying first who will see it), and picking a day.
 */
import { useEffect, useRef, useState } from 'react';
import { Modal, Spinner } from '../ui.jsx';
import { todoApi } from '../../lib/todos.js';
import { api } from '../../api/client.js';

const TYPE_LABEL = {
  TASK: 'Tasks', PROJECT: 'Projects', KEY_RESULT: 'Key results', OBJECTIVE: 'Objectives',
  DEAL: 'Deals', APPLICATION: 'Applications', MEETING: 'Meetings',
};

/** Search what the person can already see, and pick at most one record. */
export function LinkPicker({ current, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setResults(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      todoApi.search(q.trim())
        .then((r) => alive && (setResults(r.results), setError(null)))
        .catch((e) => alive && setError(e.message));
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  const groups = {};
  for (const r of results || []) (groups[r.type] ||= []).push(r);
  return (
    <Modal title="Link to…" onClose={onClose} footer={
      <>
        {current && <button type="button" className="btn btn-ghost" onClick={() => onPick(null)}>Remove the link</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </>
    }>
      <div className="stack">
        <label className="td-field">
          <span className="small muted">A task, project, key result, objective, deal, application or meeting you can see</span>
          <input ref={input} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type two letters or more" aria-describedby="td-link-hint" />
        </label>
        <div id="td-link-hint" className="small muted">Linked privately: only you see the link until you share it.</div>
        {error && <div className="small" role="alert">{error}</div>}
        {results === null && q.trim().length >= 2 && <Spinner label="Searching" />}
        {results && results.length === 0 && <div className="small muted">Nothing you can see matches “{q.trim()}”.</div>}
        {Object.entries(groups).map(([type, rows]) => (
          <section key={type} aria-label={TYPE_LABEL[type]}>
            <h3 className="td-subhead">{TYPE_LABEL[type]}</h3>
            <ul className="td-pick-list">
              {rows.map((r) => (
                <li key={`${r.type}:${r.id}`}>
                  <button type="button" className="td-pick" onClick={() => onPick({ type: r.type, id: r.id, label: r.label })}>{r.label}</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** Before anything is shared, the screen says who will see it. Sharing is an explicit tap. */
export function ShareDialog({ item, onShared, onClose }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    todoApi.sharePreview(item.id).then(setPreview).catch((e) => setError(e.message));
  }, [item.id]);
  const share = async () => {
    setSaving(true);
    try { onShared(await todoApi.share(item.id)); } catch (e) { setError(e.message); setSaving(false); }
  };
  return (
    <Modal title="Add to its progress" onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Keep it private</button>
        <button type="button" className="btn btn-primary" disabled={!preview || saving} onClick={share}>{saving ? 'Sharing…' : 'Share'}</button>
      </>
    }>
      <div className="stack-sm">
        <p className="td-quote">“{item.title}”</p>
        {!preview && !error && <Spinner label="Checking who will see it" />}
        {preview && <p><strong>{preview.words}</strong></p>}
        {preview?.note && <p className="small">{preview.note}</p>}
        {preview && <p className="small muted">It never changes a status, a date or a goal's value. You can take it back later.</p>}
        {error && <p role="alert" className="small">{error}</p>}
      </div>
    </Modal>
  );
}

/** Pick a day (or none: Anytime). */
export function DayDialog({ title = 'Pick a day', value, today, onPick, onClose, allowNone = true }) {
  const [day, setDay] = useState(value || today);
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        {allowNone && <button type="button" className="btn btn-ghost" onClick={() => onPick(null)}>No day (Anytime)</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => onPick(day)} disabled={!day}>Move</button>
      </>
    }>
      <label className="td-field">
        <span>Day</span>
        <input ref={input} type="date" className="input" value={day || ''} onChange={(e) => setDay(e.target.value)} />
      </label>
    </Modal>
  );
}

/** A time for a line ("15:00"), or none. */
export function TimeDialog({ value, onPick, onClose }) {
  const [time, setTime] = useState(value || '');
  return (
    <Modal title="Time" onClose={onClose} footer={
      <>
        {value && <button type="button" className="btn btn-ghost" onClick={() => onPick(null)}>No time</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!time} onClick={() => onPick(time)}>Set</button>
      </>
    }>
      <label className="td-field">
        <span>Time (timed lines sort first)</span>
        <input type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} autoFocus />
      </label>
    </Modal>
  );
}

const localValue = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

/**
 * "Remind me" on a to-do: a private reminder at a time, through the same
 * personal reminders as everywhere else. Ticking or removing the to-do
 * cancels it; changing the reminder's time plans it again. Off unless set.
 */
export function ReminderDialog({ item, onClose }) {
  const [current, setCurrent] = useState(undefined);
  const [when, setWhen] = useState(() => {
    if (item.planned_on) return `${item.planned_on}T${item.planned_time || '09:00'}`;
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return localValue(d);
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get('/workspace/reminders/personal', { entity_type: 'TODO', entity_id: item.id })
      .then((r) => { const r0 = r.reminders?.[0] || null; setCurrent(r0); if (r0) setWhen(localValue(r0.remind_at)); })
      .catch(() => setCurrent(null));
  }, [item.id]);
  const save = async () => {
    setSaving(true);
    try {
      const body = { remind_at: new Date(when).toISOString() };
      if (current) await api.put(`/workspace/reminders/personal/${current.id}`, body);
      else await api.post('/workspace/reminders/personal', { entity_type: 'TODO', entity_id: item.id, ...body });
      onClose(current ? 'Reminder moved' : 'Reminder set. Only you will get it');
    } catch (e) { setError(e.message); setSaving(false); }
  };
  const cancel = async () => {
    try { await api.post(`/workspace/reminders/personal/${current.id}/cancel`); onClose('Reminder cancelled'); } catch (e) { setError(e.message); }
  };
  return (
    <Modal title="Remind me" onClose={() => onClose()} footer={
      <>
        {current && <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel the reminder</button>}
        <button type="button" className="btn" onClick={() => onClose()}>Close</button>
        <button type="button" className="btn btn-primary" disabled={!when || saving || current === undefined} onClick={save}>{current ? 'Move it' : 'Set reminder'}</button>
      </>
    }>
      <div className="stack-sm">
        <p className="td-quote">“{item.title}”</p>
        <label className="td-field">
          <span>When</span>
          <input type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <p className="small muted">Only you get it, in TaskFlow and in Chat if you use it. Ticking or removing the to-do cancels it.</p>
        {error && <p role="alert" className="small">{error}</p>}
      </div>
    </Modal>
  );
}

const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

/**
 * A repeating to-do. Its items appear on the person's own working days only,
 * one per day, never backfilled. Editing changes future items only.
 */
export function RoutineDialog({ initial = {}, routine = null, onSaved, onClose }) {
  const [title, setTitle] = useState(routine?.title || initial.title || '');
  const [kind, setKind] = useState(routine?.repeat_kind || 'WORKING_DAYS');
  const [days, setDays] = useState(routine?.weekdays || [1]);
  const [monthDay, setMonthDay] = useState(routine?.month_day || 1);
  const [time, setTime] = useState(routine?.planned_time || initial.planned_time || '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const body = { title, repeat_kind: kind, weekdays: days, month_day: monthDay, planned_time: time || null };
    try {
      if (routine) await api.patch(`/todos/routines/${routine.id}`, body);
      else await api.post('/todos/routines', { ...body, ...(initial.link?.visible ? { link_type: initial.link.type, link_id: initial.link.id } : {}) });
      onSaved?.();
    } catch (e) { setError(e.message); setSaving(false); }
  };
  const toggleDay = (d) => setDays((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d].sort()));
  return (
    <Modal title={routine ? 'Change the routine' : 'Repeat'} onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!title.trim() || saving || (kind === 'WEEKLY' && !days.length)} onClick={save}>{routine ? 'Save for future days' : 'Repeat it'}</button>
      </>
    }>
      <div className="stack-sm">
        <label className="td-field"><span>What repeats</span><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
        <fieldset className="td-fieldset">
          <legend>How often</legend>
          <label className="td-switch"><input type="radio" name="td-repeat" checked={kind === 'WORKING_DAYS'} onChange={() => setKind('WORKING_DAYS')} /> Every working day</label>
          <label className="td-switch"><input type="radio" name="td-repeat" checked={kind === 'WEEKLY'} onChange={() => setKind('WEEKLY')} /> Weekly on chosen days</label>
          {kind === 'WEEKLY' && (
            <div className="td-chips" role="group" aria-label="Days of the week">
              {WEEKDAYS.map(([d, w]) => (
                <label key={d} className="td-chip"><input type="checkbox" checked={days.includes(d)} onChange={() => toggleDay(d)} /> {w}</label>
              ))}
            </div>
          )}
          <label className="td-switch"><input type="radio" name="td-repeat" checked={kind === 'MONTHLY'} onChange={() => setKind('MONTHLY')} /> Monthly on a date</label>
          {kind === 'MONTHLY' && (
            <label className="td-field"><span>Date of the month (the month’s last day when it is shorter)</span>
              <input type="number" className="input" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))} />
            </label>
          )}
        </fieldset>
        <label className="td-field"><span>Time (optional)</span><input type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        <p className="small muted">
          Items appear on your own working days only: never on your weekly off, a holiday or approved leave, and missed days are not filled in.
          A routine that others must tick, or a manager must see, is a recurring task with steps.
        </p>
        {routine && <p className="small muted">Changes apply from the next item; what was already made stays as it is.</p>}
        {error && <p role="alert" className="small">{error}</p>}
      </div>
    </Modal>
  );
}
