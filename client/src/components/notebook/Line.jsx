/**
 * One ruled line of a notebook page. Real controls under the paper look: a
 * real checkbox (labelled with the line's words), a real text field (so
 * spellcheck, screen readers and a stylus's own handwriting-to-text work),
 * a star, the link's stamp and a "More" menu with every other action.
 *
 * Margin signs: • open, × done, → moved to another day, ○ a fixed time;
 * each also has words for screen readers.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { shortDay } from '../../lib/notebook.js';
import { doneWords } from '../../lib/todos.js';

const SIGN = { open: '•', done: '×', moved: '→', fixed: '○' };

export function PenTick() {
  return (
    <svg className="nb-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 13.5c2.2 1.6 3.6 3.2 4.8 5.2C11.6 12.4 15.4 7.6 20.5 4.5" />
    </svg>
  );
}

export function Clip() {
  return (
    <svg className="nb-clip" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 7v9a4 4 0 0 0 8 0V6a2.6 2.6 0 0 0-5.2 0v9.5a1.2 1.2 0 0 0 2.4 0V8" />
    </svg>
  );
}

/** A real text field that wraps onto the next ruled line as it grows (rows are whole lines). */
function LineText({ value, onChange, onCommit, onCancel, label }) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 32;
    el.style.height = `${Math.max(1, Math.round(el.scrollHeight / line)) * line}px`;
  };
  useEffect(fit, [value]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !ref.current) return undefined;
    const ro = new ResizeObserver(() => fit());
    ro.observe(ref.current.parentElement);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea ref={ref} className="nb-text" rows={1} value={value} maxLength={200} aria-label={label} spellCheck
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))} onBlur={onCommit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { onCancel(); e.currentTarget.blur(); } }} />
  );
}

export default function Line({ item, today, nb, actions, sync, onRetry, menu = true, onDragStart = null }) {
  const id = useId();
  const [text, setText] = useState(item.title);
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => { setText(item.title); }, [item.title]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const isPin = item.source === 'PIN';
  const isStep = item.source === 'STEP';
  const isTodo = item.source === 'TODO';
  const editable = isTodo && !item.became && !item.done && !String(item.key).startsWith('TMP:');
  const failed = sync && typeof sync === 'object' && sync.failed;
  const local = sync === 'local' || item.sync === 'local';
  const sign = item.done ? 'done' : item.planned_time ? 'fixed' : 'open';
  const run = (fn) => () => { setOpen(false); fn(); };
  const commit = () => { if (text.trim() && text !== item.title) nb.edit(item, text.trim()); else setText(item.title); };

  return (
    <li className={`nb-line${item.done ? ' is-done' : ''}${item.starred ? ' is-starred' : ''}${isPin ? ' is-pin' : ''}${item.became ? ' is-became' : ''}`}
      data-key={item.key} style={item.stamp?.color ? { '--stamp': item.stamp.color } : undefined}
      onPointerDown={onDragStart ? (e) => onDragStart(e, item) : undefined}>
      <span className="nb-margin" aria-hidden="true">
        {item.planned_time ? <span className="nb-time">{item.planned_time}</span> : <span className="nb-sign">{SIGN[sign]}</span>}
      </span>
      <span className="sr-only">{item.done ? 'Done. ' : ''}{item.planned_time ? `At ${item.planned_time}. ` : ''}</span>
      {isPin ? (
        <span className="nb-box nb-box-pin"><Clip /><span className="sr-only">Pinned task {item.task.ref}, {item.task.status_name || item.task.stage}. </span></span>
      ) : (
        <label className="nb-box">
          <input id={`${id}-cb`} type="checkbox" className="nb-check" checked={item.done} disabled={Boolean(item.became)}
            aria-label={item.title} onChange={(e) => { nb.tick(item, e.target.checked); nb.haptic?.(); }} />
          <PenTick />
        </label>
      )}
      <span className="nb-body">
        {editable ? (
          <LineText value={text} onChange={setText} onCommit={commit} onCancel={() => setText(item.title)} label={`Words of “${item.title}”`} />
        ) : (
          <span className="nb-text nb-text-static">
            {isPin && <span className="nb-ref">{item.task.ref} </span>}
            <span className="nb-words">{item.title}</span>
          </span>
        )}
        {item.carried_from && !item.done && actions && (
          <span className="nb-note-line nb-carry" role="group" aria-label={`Move “${item.title}”`}>
            <button type="button" className="nb-text-btn" onClick={() => actions.moveDay(item, 'TODAY')}>Today</button>
            <button type="button" className="nb-text-btn" onClick={() => actions.moveDay(item, 'TOMORROW')}>Tomorrow</button>
            <button type="button" className="nb-text-btn" onClick={() => actions.pickDay(item)}>Move to…</button>
            {isTodo && <button type="button" className="nb-text-btn" onClick={() => nb.removeLine(item)}>Remove</button>}
          </span>
        )}
        {(item.became || (isStep && item.done) || isPin || failed || local) && (
          <span className="nb-note-line">
            {item.became && <span>Became <Link to={`/?task=${item.became.task_id}`}>{item.became.ref}</Link></span>}
            {isStep && item.done && <span>{doneWords(item, today)}</span>}
            {isPin && <span>{item.task.status_name || item.task.stage}</span>}
            {failed && <button type="button" className="nb-retry" onClick={() => onRetry(item.key)}>{sync.message || 'Not saved · Retry'}</button>}
            {local && !failed && <span className="nb-local">Saved on this device · will sync</span>}
          </span>
        )}
      </span>
      {item.stamp && !isPin && (
        item.link?.visible && item.link.url
          ? <Link className="nb-stamp" to={item.link.url} title={item.link.label}><span className="sr-only">Linked to </span>{item.stamp.text}{!item.shared && !isStep && !isPin ? <span className="sr-only"> (private link)</span> : null}</Link>
          : <span className="nb-stamp"><span className="sr-only">Linked to </span>{item.stamp.text}</span>
      )}
      {isTodo && (
        <button type="button" className={`nb-star${item.starred ? ' is-on' : ''}`} aria-pressed={Boolean(item.starred)}
          aria-label={item.starred ? `Unstar “${item.title}”` : `Star “${item.title}”`} onClick={() => nb.star(item, !item.starred)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>
        </button>
      )}
      {isPin && !item.done && <button type="button" className="nb-text-btn is-ink" onClick={() => actions.complete(item)}>Complete…</button>}
      {menu && actions && (
        <span className="nb-more" ref={menuRef}>
          <button type="button" className="nb-more-btn" aria-expanded={open} aria-controls={`${id}-menu`} aria-label={`More for “${item.title}”`} onClick={() => setOpen((o) => !o)}>⋯</button>
          {open && (
            <ul id={`${id}-menu`} className="td-menu nb-menu">
              {!isPin && !item.done && <>
                <li><button type="button" onClick={run(() => actions.moveDay(item, 'TODAY'))}>Move to today</button></li>
                <li><button type="button" onClick={run(() => actions.moveDay(item, 'TOMORROW'))}>Move to tomorrow</button></li>
                <li><button type="button" onClick={run(() => actions.pickDay(item))}>Move to…</button></li>
              </>}
              {!isPin && <li><button type="button" onClick={run(() => actions.pickTime(item))}>{item.planned_time ? 'Change the time…' : 'Add a time…'}</button></li>}
              {actions.move && <li><button type="button" onClick={run(() => actions.move(item, 'up'))}>Move up</button></li>}
              {actions.move && <li><button type="button" onClick={run(() => actions.move(item, 'down'))}>Move down</button></li>}
              {isTodo && !item.shared && <li><button type="button" onClick={run(() => actions.link(item))}>{item.link ? 'Change the link…' : 'Link…'}</button></li>}
              {isTodo && item.link?.visible && !item.shared && <li><button type="button" onClick={run(() => actions.share(item))}>Add to its progress…</button></li>}
              {isTodo && item.shared && <li><button type="button" onClick={run(() => actions.unshare(item))}>Make it private again</button></li>}
              {isTodo && !item.done && <li><button type="button" onClick={run(() => actions.remind(item))}>Remind me…</button></li>}
              {isTodo && <li><button type="button" onClick={run(() => actions.repeat(item))}>Repeat…</button></li>}
              {isTodo && !item.became && <li><button type="button" onClick={run(() => actions.makeTask(item))}>Make it a task…</button></li>}
              {isStep && <li><button type="button" onClick={run(() => actions.unshareStep(item))}>Take back as a private to-do</button></li>}
              {(isStep || isPin) && <li><Link to={`/?task=${item.task.id}`} onClick={() => setOpen(false)}>Open {item.task.ref}</Link></li>}
              {isPin && <li><button type="button" onClick={run(() => actions.unpin(item))}>Unpin (the task is unchanged)</button></li>}
              {isTodo && <li className="nb-menu-star"><button type="button" onClick={run(() => nb.star(item, !item.starred))}>{item.starred ? 'Unstar' : 'Star'}</button></li>}
              {isTodo && <li><button type="button" onClick={run(() => nb.removeLine(item))}>Remove</button></li>}
            </ul>
          )}
        </span>
      )}
    </li>
  );
}

/** A line that moved to another day: it stays on its old page, greyed, with where it went. */
export function MovedLine({ item, onOpenDay }) {
  return (
    <li className="nb-line is-moved" data-key={item.key}>
      <span className="nb-margin" aria-hidden="true"><span className="nb-sign">→</span></span>
      <span className="nb-box" aria-hidden="true" />
      <span className="nb-body">
        <span className="nb-text nb-text-static"><span className="nb-words">{item.title}</span></span>
      </span>
      <button type="button" className="nb-moved-to" onClick={() => item.moved_to && onOpenDay?.(item.moved_to)}>
        {item.moved_to ? <><span className="sr-only">Moved to </span>→ {shortDay(item.moved_to)}</> : <>Moved to Anytime</>}
      </button>
    </li>
  );
}
