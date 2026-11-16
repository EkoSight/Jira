/**
 * A day's page (Part N1). The same component is the full notebook's page,
 * the header drawer's pocket notebook and the snippet in the workspace widget
 * and the overview card; container queries decide how it is laid out.
 *
 * Top to bottom: the date, written large, with the week number and a "Today"
 * ribbon; the meetings strip; the sticky note of lines carried over; the
 * ruled lines, with the next empty line always ready to write on; lines that
 * moved away (greyed, "-> Mon 16 Nov"); the day's notes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../ui.jsx';
import { useTodoActions } from '../todos/useTodoActions.jsx';
import { useNotebookDay } from './useNotebookDay.js';
import Line, { MovedLine, PenTick as PenTickRef } from './Line.jsx';
import { MonthIndex } from './WeekMonth.jsx';
import { isUndoKey, longDay, shortDay } from '../../lib/notebook.js';
import { announceTodosChanged, moveKey, splitLines, todoApi, typingIn } from '../../lib/todos.js';

const REF_HINT = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/;

/** The next empty line: write, Enter, and the next empty line is ready. Pasting several lines asks once. */
export function NewLine({ onAdd, onAddMany, label = 'Write a new line', placeholder = 'Write here…', inputRef = null, autoFocus = false }) {
  const [text, setText] = useState('');
  const [pasted, setPasted] = useState(null);
  const [chip, setChip] = useState(null);
  const [ignoreRef, setIgnoreRef] = useState(false);
  const own = useRef(null);
  const input = inputRef || own;
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus, input]);
  useEffect(() => {
    if (ignoreRef || !REF_HINT.test(text)) { setChip(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => todoApi.parse(text).then((r) => alive && setChip(r.ref)).catch(() => alive && setChip(null)), 250);
    return () => { alive = false; clearTimeout(t); };
  }, [text, ignoreRef]);
  // the line being written stays above the on-screen keyboard
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return undefined;
    const keep = () => { if (document.activeElement === input.current) input.current.scrollIntoView({ block: 'nearest' }); };
    vv.addEventListener('resize', keep);
    return () => vv.removeEventListener('resize', keep);
  }, [input]);
  const submit = () => {
    const words = text.trim();
    if (!words) return;
    onAdd(words, ignoreRef ? { read_ref: false } : {});
    setText('');
    setChip(null);
    setIgnoreRef(false);
  };
  return (
    <li className="nb-line nb-new">
      <span className="nb-margin" aria-hidden="true"><span className="nb-sign">•</span></span>
      <span className="nb-box" aria-hidden="true"><span className="nb-box-empty" /></span>
      <span className="nb-body">
        <input ref={input} className="nb-text nb-write" value={text} maxLength={200} placeholder={placeholder} aria-label={label}
          enterKeyHint="next" autoComplete="off" spellCheck
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          onPaste={(e) => { const lines = splitLines(e.clipboardData?.getData('text') || ''); if (lines.length > 1) { e.preventDefault(); setPasted(lines.slice(0, 50)); } }} />
        {chip && (
          <span className="nb-note-line" aria-live="polite">
            {chip.task
              ? <span className="nb-chip">Links to {chip.task.ref} (private) <button type="button" aria-label={`Don't link to ${chip.task.ref}`} onClick={() => setIgnoreRef(true)}>×</button></span>
              : <span className="nb-chip">{chip.note}</span>}
          </span>
        )}
        {pasted && (
          <span className="nb-note-line nb-confirm" role="group" aria-label="Add several lines">
            <span>Add {pasted.length} to-dos?</span>
            <button type="button" className="nb-small-btn is-ink" onClick={() => { onAddMany(pasted); setPasted(null); }}>Add {pasted.length}</button>
            <button type="button" className="nb-small-btn" onClick={() => setPasted(null)}>Cancel</button>
          </span>
        )}
      </span>
    </li>
  );
}

/** Lines carried over from earlier days, on a sticky note. Never called overdue. */
function StickyNote({ items, today, actions, nb, sync, onRetry }) {
  if (!items.length) return null;
  const days = [...new Set(items.map((i) => i.carried_from))];
  const from = days.length === 1 ? `From ${shortDay(days[0])}` : 'From earlier days';
  return (
    <aside className="nb-sticky" aria-labelledby="nb-sticky-title">
      <h3 id="nb-sticky-title" className="nb-hand nb-sticky-title">{from} · {items.length}<span className="sr-only">, carried over</span></h3>
      <ul className="nb-lines nb-sticky-lines">
        {items.map((item) => <Line key={item.key} item={item} today={today} nb={nb} actions={actions} sync={sync[item.key]} onRetry={onRetry} />)}
      </ul>
      <p className="nb-sticky-hint">Use Today, Tomorrow or Move to… on a line, or drag it onto the page.</p>
    </aside>
  );
}

/** Today's meetings, read-only: a strip under the header, or a time column on wide pages. */
function Meetings({ meetings }) {
  if (!meetings?.length) return null;
  return (
    <section className="nb-meetings" aria-label="Fixed times: today's meetings">
      <h3 className="nb-hand nb-meetings-title">Appointments</h3>
      <ul>
        {meetings.map((m) => (
          <li key={m.id}><span className="nb-sign" aria-hidden="true">○</span> <span className="nb-time">{m.time}</span> <a href={m.url}>{m.title}</a>{m.status === 'COMPLETED' ? ' (held)' : ''}</li>
        ))}
      </ul>
    </section>
  );
}

/** The day's notes: plain text, private, saved as you type. A line can become a to-do. */
function DayNotes({ page, nb, compact = false }) {
  const [body, setBody] = useState(page.note?.body || '');
  const [state, setState] = useState('');
  const timer = useRef(null);
  const area = useRef(null);
  const day = page.day;
  useEffect(() => { setBody(page.note?.body || ''); }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (value) => {
    setBody(value);
    setState('');
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await nb.saveNote(value);
      setState(nb.offline ? 'Saved on this device · will sync' : 'Saved');
    }, 700);
  };
  const lineAtCaret = () => {
    const el = area.current;
    if (!el) return '';
    const before = el.value.slice(0, el.selectionStart);
    const start = before.lastIndexOf('\n') + 1;
    const end = el.value.indexOf('\n', el.selectionStart);
    return el.value.slice(start, end === -1 ? undefined : end).trim();
  };
  const toTodo = async () => {
    const line = lineAtCaret();
    if (!line) { setState('Put the cursor on a line first'); return; }
    clearTimeout(timer.current);
    await nb.saveNote(body);
    try {
      await todoApi.addFromNote(day, line);
      setState(`“${line}” is a to-do now; the note keeps the line`);
      announceTodosChanged();
    } catch (e) { setState(e.message); }
  };
  if (compact) return null;
  return (
    <section className="nb-notes" aria-labelledby={`nb-notes-${day}`}>
      <div className="nb-notes-head">
        <h3 id={`nb-notes-${day}`} className="nb-hand">Notes</h3>
        <button type="button" className="nb-small-btn" onClick={toTodo}>Make this line a to-do</button>
      </div>
      <textarea ref={area} className="nb-notes-area" value={body} onChange={(e) => change(e.target.value)}
        aria-label={`Notes for ${longDay(day)}. Private, saved as you type`} spellCheck rows={6} />
      <div className="nb-status" aria-live="polite">{state}</div>
    </section>
  );
}

/** The right page's "week glance": each day of this week with what is still open. */
function WeekGlance({ day, onOpenDay }) {
  const [week, setWeek] = useState(null);
  useEffect(() => {
    let alive = true;
    todoApi.week(day).then((w) => alive && setWeek(w)).catch(() => alive && setWeek({ days: [], failed: true }));
    return () => { alive = false; };
  }, [day]);
  if (!week) return <Spinner label="Opening the week" />;
  if (week.failed) return <p className="nb-status">The week needs a connection.</p>;
  return (
    <ul className="nb-glance">
      {week.days.map((d) => {
        const open = d.items.filter((i) => !i.done);
        return (
          <li key={d.day} className={d.day === day ? 'is-open' : ''}>
            <button type="button" className="nb-link-btn nb-hand" onClick={() => onOpenDay(d.day)}>{shortDay(d.day)}</button>
            <span className="nb-status">{d.items.length ? `${open.length} open of ${d.items.length}` : 'nothing yet'}</span>
            {open.slice(0, 2).map((i) => <span key={i.key} className="nb-glance-line">{i.title}</span>)}
          </li>
        );
      })}
    </ul>
  );
}

/** The right page's list: one of the person's lists, to tick from. */
function ListGlance() {
  const [lists, setLists] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [detail, setDetail] = useState(null);
  useEffect(() => { todoApi.lists().then((r) => { setLists(r.lists); if (r.lists[0]) setChosen(r.lists[0].id); }).catch(() => setLists([])); }, []);
  useEffect(() => { if (chosen) todoApi.list(chosen).then(setDetail).catch(() => setDetail(null)); }, [chosen]);
  if (!lists) return <Spinner label="Opening lists" />;
  if (!lists.length) return <p className="nb-status">No lists yet. Make one under Lists.</p>;
  const tick = async (item, done) => {
    setDetail((d) => ({ ...d, items: d.items.map((i) => (i.key === item.key ? { ...i, done } : i)) }));
    try { await todoApi.change(item.id, { done }); announceTodosChanged(); } catch { todoApi.list(chosen).then(setDetail); }
  };
  return (
    <div className="nb-listglance">
      <label className="nb-field"><span className="sr-only">List</span>
        <select value={chosen || ''} onChange={(e) => setChosen(Number(e.target.value))}>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.left} left)</option>)}
        </select>
      </label>
      <ul className="nb-lines">
        {(detail?.items || []).map((i) => (
          <li key={i.key} className={`nb-line${i.done ? ' is-done' : ''}`}>
            <span className="nb-margin" aria-hidden="true"><span className="nb-sign">{i.done ? '×' : '•'}</span></span>
            <label className="nb-box"><input type="checkbox" className="nb-check" checked={i.done} aria-label={i.title} onChange={(e) => tick(i, e.target.checked)} /><PenTickRef /></label>
            <span className="nb-body"><span className="nb-text nb-text-static"><span className="nb-words">{i.title}</span></span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SIDE = [['notes', 'Notes'], ['week', 'Week glance'], ['list', 'A list']];
const SIDE_KEY = 'taskflow.notebook.side';
const readSide = () => { try { return localStorage.getItem(SIDE_KEY) || 'notes'; } catch { return 'notes'; } };

export default function DayPage({ day = null, variant = 'full', onOpenDay, addRef = null, autoFocus = false, limit = null }) {
  const nb = useNotebookDay(day);
  const { page, error } = nb;
  const reload = nb.load;
  const { actions, dialogs, bars } = useTodoActions({ reload, today: page?.today });
  const [message, setMessage] = useState('');
  const [side, setSide] = useState(readSide);
  const chooseSide = (k) => { setSide(k); try { localStorage.setItem(SIDE_KEY, k); } catch { /* a convenience only */ } };
  const pocket = variant === 'pocket';
  const snippet = variant === 'snippet';

  // undo: Ctrl/Cmd+Z, never while typing in a field (the field's own undo works there)
  useEffect(() => {
    if (snippet) return undefined;
    const onKey = async (e) => {
      if (!isUndoKey(e) || typingIn(e.target)) return;
      e.preventDefault();
      const label = await nb.undo();
      if (label) setMessage(`Undone: ${label}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nb, snippet]);

  const haptic = useCallback(() => {
    if (page?.prefs?.haptics && typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(8);
  }, [page?.prefs?.haptics]);
  const nbx = { ...nb, haptic };

  const move = async (item, dir) => {
    const keys = page.items.filter((i) => !i.planned_time && !i.done && !String(i.key).startsWith('TMP:')).map((i) => i.key);
    const next = moveKey(keys, item.key, dir);
    if (next === keys) return;
    const timed = page.items.filter((i) => i.planned_time || i.done).map((i) => i.key);
    const order = [...next, ...timed];
    nb.setPage((p) => ({ ...p, items: [...p.items].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) }));
    setMessage(`Moved ${dir}: “${item.title}”, ${next.indexOf(item.key) + 1} of ${next.length}`);
    try { await todoApi.order(next); } catch { reload(); }
  };

  if (error && !page) {
    return (
      <div className={`nb-page nb-${variant}`} role="region" aria-label="Notebook page">
        <p className="nb-status" role="alert">{error.status === 0 ? 'You’re offline, and this page has not been kept on this device. Today’s page works offline once it has been opened here.' : error.message}</p>
        <button type="button" className="nb-small-btn" onClick={reload}>Try again</button>
      </div>
    );
  }
  if (!page) return <div className={`nb-page nb-${variant}`}><Spinner label="Opening the page" /></div>;

  const hide = page.hide_done;
  const visible = (list) => (hide ? list.filter((i) => !i.done) : list);
  const carried = visible(page.carried || []);
  let lines = visible(page.items || []);
  if (limit) lines = lines.slice(0, limit);
  const movable = (page.items || []).filter((i) => !i.planned_time && !i.done).map((i) => i.key);
  const label = `${longDay(page.day)}, ${page.is_today ? 'Today’s plan' : page.is_past ? 'past page' : 'planned page'}`;
  const addMany = async (titles) => { for (const t of titles) await nb.add(t); setMessage(`Added ${titles.length} lines`); };

  const full = variant === 'full';
  return (
    <section className={`nb-page nb-${variant}${page.prefs?.handwriting ? ' nb-hand-items' : ''}`} role="region" aria-label={label}>
      <div className="nb-leaf nb-main">
      <header className="nb-head">
        <div className="nb-head-date">
          <h2 className="nb-date nb-hand">{longDay(page.day)}</h2>
          <span className="nb-week">Week {page.week}</span>
        </div>
        {page.is_today && <span className="nb-ribbon" aria-label="This is today’s page">Today</span>}
        {!snippet && (
          <span className="nb-count" aria-live="polite">{page.left ? `${page.left} left` : 'Nothing left'}{page.done_count ? ` · ${page.done_count} done` : ''}</span>
        )}
      </header>
      {nb.offline && <p className="nb-banner" role="status">Offline: today’s page is kept on this device and will sync when you are back.</p>}
      {nb.notice && <p className="nb-banner" role="status">{nb.notice} <button type="button" className="nb-small-btn" onClick={() => nb.setNotice(null)}>OK</button></p>}
      {!snippet && <div className="sr-only" role="status" aria-live="polite">{message}</div>}
      {!snippet && bars}
      {!snippet && <div className="nb-strip"><Meetings meetings={page.meetings} /></div>}
      {!snippet && <StickyNote items={carried} today={page.today} actions={actions} nb={nbx} sync={nb.sync} onRetry={nb.retry} />}
      <ul className="nb-lines" aria-label={`Lines for ${longDay(page.day)}`} data-drop-day={page.day}>
        {lines.map((item) => (
          <Line key={item.key} item={item} today={page.today} nb={nbx} sync={nb.sync[item.key]} onRetry={nb.retry} menu={!snippet}
            actions={{ ...actions, move: movable.includes(item.key) && !snippet ? move : null }} />
        ))}
        {(page.moved || []).map((m) => <MovedLine key={m.key} item={m} onOpenDay={onOpenDay} />)}
        <NewLine onAdd={(t, extra) => nb.add(t, extra)} onAddMany={addMany} inputRef={addRef} autoFocus={autoFocus}
          label={`Write a new line for ${longDay(page.day)}`} placeholder={lines.length ? 'Write the next line…' : 'Write your first line…'} />
      </ul>
      {snippet && page.items.length > lines.length && <p className="nb-status">and {page.items.length - lines.length} more</p>}
      {snippet && <Link className="nb-open" to="/todos">Open notebook</Link>}
      {pocket && <DayNotes page={page} nb={nb} />}
      {!snippet && (
        <footer className="nb-foot">
          <span>{page.done_count ? `${page.done_count} done` : ''}</span>
          {nb.undoLabel && <button type="button" className="nb-small-btn" onClick={async () => { const l = await nb.undo(); if (l) setMessage(`Undone: ${l}`); }}>Undo <span className="sr-only">{nb.undoLabel}</span></button>}
          <label className="nb-switch"><input type="checkbox" checked={Boolean(hide)} onChange={async () => { nb.setPage((p) => ({ ...p, hide_done: !hide })); try { await todoApi.prefs({ hide_done: !hide }); } catch { reload(); } }} /> Hide done</label>
        </footer>
      )}
      </div>
      {full && <div className="nb-gutter" aria-hidden="true" />}
      {full && (
        <div className={`nb-leaf nb-side is-${side}`}>
          <div className="nb-side-tabs" role="group" aria-label="The right page shows">
            {SIDE.map(([k, l]) => <button key={k} type="button" className="nb-side-tab" aria-pressed={side === k} onClick={() => chooseSide(k)}>{l}</button>)}
          </div>
          <div className="nb-side-week">{side === 'week' && <WeekGlance day={page.day} onOpenDay={onOpenDay} />}</div>
          <div className="nb-side-list">{side === 'list' && <ListGlance />}</div>
          <DayNotes page={page} nb={nb} />
          <div className="nb-timecol"><Meetings meetings={page.meetings} /></div>
          <div className="nb-side-month"><MonthIndex day={page.day} today={page.today} onOpenDay={onOpenDay} /></div>
        </div>
      )}
      {dialogs}
    </section>
  );
}
