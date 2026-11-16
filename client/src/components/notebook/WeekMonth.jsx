/**
 * The week spread and the month index (Part N2).
 *
 * Week: Monday to Wednesday on the left page; Thursday to Sunday, then the
 * week's notes, on the right. On narrow screens the days follow one another.
 * Lines move between days by dragging (a long press starts it on touch) or
 * with "Move to…", which works with a keyboard and on touch.
 *
 * Month index: a small calendar with a dot on days that have lines.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '../ui.jsx';
import { addMonths, longDay, monthGrid, monthLabel, shortDay } from '../../lib/notebook.js';
import { announceTodosChanged, todoApi } from '../../lib/todos.js';
import { PenTick } from './Line.jsx';

/**
 * Drag a line to another day: a mouse drags at once; a finger after a long
 * press (then the page stops scrolling under it). Every drag also has
 * "Move to…", for keyboards and for anyone who prefers it.
 */
export function useDragToDay(onDrop) {
  const state = useRef(null);
  const [ghost, setGhost] = useState(null);
  const end = useCallback(() => {
    clearTimeout(state.current?.timer);
    state.current = null;
    setGhost(null);
  }, []);
  const drop = useCallback((x, y) => {
    const s = state.current;
    if (s?.active) {
      const target = document.elementFromPoint(x, y)?.closest('[data-drop-day]');
      const day = target?.getAttribute('data-drop-day');
      if (day && day !== s.item.planned_on) onDrop(s.item, day);
    }
    end();
  }, [onDrop, end]);
  useEffect(() => {
    // the mouse
    const move = (e) => {
      const s = state.current;
      if (!s || s.touch) return;
      if (!s.active) { if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 6) return; s.active = true; }
      e.preventDefault();
      s.last = [e.clientX, e.clientY];
      setGhost({ x: e.clientX, y: e.clientY, title: s.item.title });
    };
    const up = (e) => { if (state.current && !state.current.touch) drop(e.clientX, e.clientY); };
    // a finger: a long press starts the drag; until then, moving is scrolling
    const tmove = (e) => {
      const s = state.current;
      if (!s?.touch) return;
      const t = e.touches[0];
      if (!s.active) { if (Math.hypot(t.clientX - s.x, t.clientY - s.y) > 10) end(); return; }
      e.preventDefault();
      s.last = [t.clientX, t.clientY];
      setGhost({ x: t.clientX, y: t.clientY, title: s.item.title });
    };
    const tend = () => { const s = state.current; if (s?.touch) { if (s.active && s.last) drop(s.last[0], s.last[1]); else end(); } };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('touchmove', tmove, { passive: false });
    window.addEventListener('touchend', tend);
    window.addEventListener('touchcancel', end);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('touchmove', tmove); window.removeEventListener('touchend', tend); window.removeEventListener('touchcancel', end);
    };
  }, [drop, end]);
  const skip = (e) => e.target.closest('input, button, a, textarea, select');
  /** For pointer-down: the mouse (and a pen used like a mouse). */
  const start = useCallback((e, item) => {
    if (e.pointerType === 'touch' || (e.button && e.button !== 0) || skip(e)) return;
    state.current = { item, x: e.clientX, y: e.clientY, touch: false, active: false };
  }, []);
  /** For touch-start: a long press (380 ms) picks the line up. */
  const startTouch = useCallback((e, item) => {
    if (skip(e) || e.touches.length !== 1) return;
    const t = e.touches[0];
    state.current = { item, x: t.clientX, y: t.clientY, touch: true, active: false, last: [t.clientX, t.clientY] };
    state.current.timer = setTimeout(() => {
      if (state.current) { state.current.active = true; setGhost({ x: t.clientX, y: t.clientY, title: item.title }); }
    }, 380);
  }, []);
  const ghostEl = ghost ? <div className="nb-ghost" style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }} aria-hidden="true">{ghost.title}</div> : null;
  return { start, startTouch, ghostEl };
}

function WeekDay({ day, nbToday, onTick, onMove, onOpenDay, dragStart, dragTouch }) {
  return (
    <section className={`nb-weekday${day.is_today ? ' is-today' : ''}`} data-drop-day={day.day} aria-labelledby={`wd-${day.day}`}>
      <h3 id={`wd-${day.day}`} className="nb-hand nb-weekday-title">
        <button type="button" className="nb-link-btn" onClick={() => onOpenDay(day.day)}>{longDay(day.day)}</button>
        {day.is_today && <span className="nb-ribbon is-small">Today</span>}
      </h3>
      <ul className="nb-lines nb-week-lines">
        {day.items.length === 0 && <li className="nb-line nb-empty-line"><span className="sr-only">Nothing planned</span></li>}
        {day.items.map((item) => (
          <li key={item.key} className={`nb-line${item.done ? ' is-done' : ''}`} onPointerDown={(e) => dragStart(e, item)} onTouchStart={(e) => dragTouch(e, item)}
            style={item.stamp?.color ? { '--stamp': item.stamp.color } : undefined}>
            <span className="nb-margin" aria-hidden="true">{item.planned_time ? <span className="nb-time">{item.planned_time}</span> : <span className="nb-sign">{item.done ? '×' : '•'}</span>}</span>
            <label className="nb-box">
              <input type="checkbox" className="nb-check" checked={item.done} aria-label={item.title} disabled={item.source === 'PIN'}
                onChange={(e) => onTick(item, e.target.checked)} />
              <PenTick />
            </label>
            <span className="nb-body"><span className="nb-text nb-text-static"><span className="nb-words">{item.title}</span></span></span>
            {item.stamp && <span className="nb-stamp">{item.stamp.text}</span>}
            {!item.done && item.source !== 'PIN' && (
              <label className="nb-moveto">
                <span className="sr-only">Move “{item.title}” to</span>
                <select value="" onChange={(e) => e.target.value && onMove(item, e.target.value)} aria-label={`Move “${item.title}” to…`}>
                  <option value="">Move to…</option>
                  {[...Array(7)].map((_, i) => {
                    const d = new Date(Date.parse(`${nbToday.monday}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
                    return d === day.day ? null : <option key={d} value={d}>{shortDay(d)}</option>;
                  })}
                  <option value={new Date(Date.parse(`${nbToday.monday}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)}>Next Monday</option>
                </select>
              </label>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WeekSpread({ day, onOpenDay }) {
  const [week, setWeek] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try { setWeek(await todoApi.week(day)); setError(null); } catch (e) { setError(e); }
  }, [day]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const on = () => load();
    window.addEventListener('taskflow:todos-changed', on);
    return () => window.removeEventListener('taskflow:todos-changed', on);
  }, [load]);
  const move = useCallback(async (item, to) => {
    try {
      if (item.source === 'STEP') await todoApi.step(item.id, { planned_on: to });
      else await todoApi.change(item.id, { planned_on: to });
      setMessage(`Moved “${item.title}” to ${shortDay(to)}`);
      announceTodosChanged();
      load();
    } catch (e) { setMessage(e.status === 0 ? 'Not saved: you’re offline' : e.message); }
  }, [load]);
  const tick = async (item, done) => {
    setWeek((w) => ({ ...w, days: w.days.map((d) => ({ ...d, items: d.items.map((i) => (i.key === item.key ? { ...i, done } : i)) })) }));
    try {
      if (item.source === 'STEP') await todoApi.step(item.id, { done }); else await todoApi.change(item.id, { done });
      announceTodosChanged();
    } catch (e) { setMessage(e.message); load(); }
  };
  const { start, startTouch, ghostEl } = useDragToDay(move);
  if (error) return <p className="nb-status" role="alert">{error.status === 0 ? 'The week needs a connection. Today’s page works offline.' : error.message}</p>;
  if (!week) return <Spinner label="Opening the week" />;
  const left = week.days.slice(0, 3);
  const right = week.days.slice(3);
  const props = { nbToday: week, onTick: tick, onMove: move, onOpenDay, dragStart: start, dragTouch: startTouch };
  return (
    <div className="nb-spread nb-week" role="region" aria-label={`Week ${week.week}, ${shortDay(week.monday)} to ${shortDay(week.sunday)}`}>
      <div className="sr-only" role="status" aria-live="polite">{message}</div>
      <div className="nb-page nb-leaf is-left">
        <header className="nb-head"><h2 className="nb-date nb-hand">Week {week.week}</h2><span className="nb-week">{shortDay(week.monday)} – {shortDay(week.sunday)}</span></header>
        {left.map((d) => <WeekDay key={d.day} day={d} {...props} />)}
      </div>
      <div className="nb-gutter" aria-hidden="true" />
      <div className="nb-page nb-leaf is-right">
        {right.map((d) => <WeekDay key={d.day} day={d} {...props} />)}
        <section className="nb-weekday nb-week-notes" aria-labelledby="wk-notes">
          <h3 id="wk-notes" className="nb-hand nb-weekday-title">Notes</h3>
          {week.notes.length === 0 ? <p className="nb-status">No notes this week.</p> : (
            <ul className="nb-plain">
              {week.notes.map((n) => <li key={n.day}><button type="button" className="nb-link-btn" onClick={() => onOpenDay(n.day)}>{shortDay(n.day)}</button>: {n.body.split('\n')[0].slice(0, 80)}</li>)}
            </ul>
          )}
        </section>
      </div>
      {ghostEl}
    </div>
  );
}

export function MonthIndex({ day, today, onOpenDay }) {
  const [month, setMonth] = useState((day || today).slice(0, 7));
  const [data, setData] = useState(null);
  useEffect(() => { setMonth((day || today).slice(0, 7)); }, [day, today]);
  useEffect(() => {
    let alive = true;
    setData(null);
    todoApi.month(month).then((r) => alive && setData(r)).catch(() => alive && setData({ days: [] }));
    return () => { alive = false; };
  }, [month]);
  const byDay = new Map((data?.days || []).map((d) => [d.day, d]));
  return (
    <section className="nb-month" aria-label={`Month index, ${monthLabel(month)}`}>
      <div className="nb-month-head">
        <button type="button" className="nb-small-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">‹</button>
        <h3 className="nb-hand">{monthLabel(month)}</h3>
        <button type="button" className="nb-small-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">›</button>
      </div>
      <table className="nb-month-grid">
        <thead><tr>{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w, i) => <th key={i} scope="col" abbr={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i]}>{w}</th>)}</tr></thead>
        <tbody>
          {monthGrid(month).map((week, i) => (
            <tr key={i}>
              {week.map((d, j) => {
                if (!d) return <td key={j} />;
                const info = byDay.get(d);
                const words = `${longDay(d)}${info ? `, ${info.total} line${info.total === 1 ? '' : 's'}${info.open ? `, ${info.open} open` : ''}` : ''}${info?.note ? ', notes' : ''}${d === today ? ', today' : ''}`;
                return (
                  <td key={j}>
                    <button type="button" className={`nb-month-day${d === today ? ' is-today' : ''}${d === day ? ' is-open' : ''}`}
                      aria-label={words} aria-current={d === day ? 'date' : undefined} onClick={() => onOpenDay(d)}>
                      {Number(d.slice(8))}
                      {(info?.total || info?.note) ? <span className={`nb-dot${info?.open ? '' : ' is-done'}`} aria-hidden="true" /> : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
