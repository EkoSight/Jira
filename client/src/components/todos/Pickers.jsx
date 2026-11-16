/**
 * The small dialogs a to-do needs: choosing the one record it belongs to,
 * sharing it (always saying first who will see it), and picking a day.
 */
import { useEffect, useRef, useState } from 'react';
import { Modal, Spinner } from '../ui.jsx';
import { todoApi } from '../../lib/todos.js';

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
