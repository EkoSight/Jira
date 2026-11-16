/**
 * One line of a plan: a to-do, a step of mine, or a pinned task. A real
 * checkbox; a ticked line stays where it was, struck through. Everything else
 * (day, time, order, link, share, make it a task, remove) sits behind "More",
 * so the line itself stays one line.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { dayLabel, doneWords, fromLabel, linkWords } from '../../lib/todos.js';

export default function TodoRow({ item, today, actions, canMoveUp = false, canMoveDown = false, showDay = false }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (menu.current && !menu.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const isPin = item.source === 'PIN';
  const isStep = item.source === 'STEP';
  const run = (fn) => () => { setOpen(false); fn(); };
  const projectName = item.project?.name;

  return (
    <li className={`td-row${item.done ? ' is-done' : ''}${item.became ? ' is-became' : ''}`} data-key={item.key}>
      <div className="td-row-main">
        {isPin ? (
          <span className={`td-pin-mark${item.done ? ' is-done' : ''}`} aria-hidden="true" title="Pinned task">📌</span>
        ) : (
          <input
            id={`${id}-cb`} type="checkbox" className="td-check" checked={item.done}
            disabled={Boolean(item.became)}
            onChange={(e) => actions.tick(item, e.target.checked)}
          />
        )}
        <div className="td-row-text">
          <label htmlFor={isPin ? undefined : `${id}-cb`} className="td-title">
            {item.planned_time && <span className="td-time">{item.planned_time}</span>}
            {isPin && item.task ? <><span className="td-ref">{item.task.ref}</span> </> : null}
            <span className="td-words">{item.title}</span>
          </label>
          <div className="td-meta small">
            {item.carried_from && <span className="td-from">{fromLabel(item.carried_from, today)}</span>}
            {showDay && item.planned_on && !item.carried_from && <span>{dayLabel(item.planned_on, today)}</span>}
            {item.became && <span>Became <Link to={`/?task=${item.became.task_id}`}>{item.became.ref}</Link></span>}
            {isPin && <span className="td-status">{item.task.status_name || item.task.stage}</span>}
            {isStep && <span>Step on <Link to={`/?task=${item.task.id}`}>{item.task.ref}</Link></span>}
            {isStep && item.done && <span>{doneWords(item, today)}</span>}
            {!isStep && !isPin && item.link && (
              <span className={`td-link${item.link.visible ? '' : ' is-gone'}`}>
                {item.shared ? 'Shared on ' : ''}
                {item.link.visible ? <Link to={item.link.url}>{linkWords(item.link)}</Link> : linkWords(item.link)}
                {!item.shared && item.link.visible && <span className="muted"> · private</span>}
              </span>
            )}
            {projectName && !(item.link?.type === 'PROJECT') && <span className="td-project">{projectName}</span>}
            {item.list && <span>List: {item.list.name}</span>}
          </div>
          {item.suggestion && !item.done && (
            <div className="td-suggest small">
              <button type="button" className="td-chip td-chip-btn" onClick={() => actions.acceptSuggestion(item)}>
                Link to {item.suggestion.word} {item.suggestion.label}?
              </button>
            </div>
          )}
          {item.ask_still_want && (
            <div className="td-ask small" role="group" aria-label="Still want this?">
              <span>Still want this?</span>
              <button type="button" className="btn btn-sm" onClick={() => actions.keep(item)}>Keep it</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => actions.remove(item)}>Remove</button>
            </div>
          )}
          {item.carried_from && !item.done && (
            <div className="td-carry small" role="group" aria-label={`Move “${item.title}”`}>
              <button type="button" className="td-chip td-chip-btn" onClick={() => actions.moveDay(item, 'TODAY')}>Today</button>
              <button type="button" className="td-chip td-chip-btn" onClick={() => actions.moveDay(item, 'TOMORROW')}>Tomorrow</button>
              <button type="button" className="td-chip td-chip-btn" onClick={() => actions.pickDay(item)}>Pick a day</button>
              {!isStep && <button type="button" className="td-chip td-chip-btn" onClick={() => actions.remove(item)}>Remove</button>}
            </div>
          )}
        </div>
        {isPin && !item.done && (
          <button type="button" className="btn btn-sm" onClick={() => actions.complete(item)}>Complete…</button>
        )}
        <div className="td-more" ref={menu}>
          <button type="button" className="btn btn-ghost btn-sm td-more-btn" aria-expanded={open} aria-controls={`${id}-menu`} aria-label={`More for “${item.title}”`} onClick={() => setOpen((o) => !o)}>⋯</button>
          {open && (
            <ul id={`${id}-menu`} className="td-menu" role="list">
              {!isPin && !item.done && !item.carried_from && <>
                <li><button type="button" onClick={run(() => actions.moveDay(item, 'TODAY'))}>Today</button></li>
                <li><button type="button" onClick={run(() => actions.moveDay(item, 'TOMORROW'))}>Tomorrow</button></li>
                <li><button type="button" onClick={run(() => actions.pickDay(item))}>Pick a day…</button></li>
              </>}
              {!isPin && <li><button type="button" onClick={run(() => actions.pickTime(item))}>{item.planned_time ? 'Change the time…' : 'Add a time…'}</button></li>}
              {actions.move && canMoveUp && <li><button type="button" onClick={run(() => actions.move(item, 'up'))}>Move up</button></li>}
              {actions.move && canMoveDown && <li><button type="button" onClick={run(() => actions.move(item, 'down'))}>Move down</button></li>}
              {item.source === 'TODO' && !item.shared && <li><button type="button" onClick={run(() => actions.link(item))}>{item.link ? 'Change the link…' : 'Link…'}</button></li>}
              {item.source === 'TODO' && item.link?.visible && !item.shared && <li><button type="button" onClick={run(() => actions.share(item))}>Add to its progress…</button></li>}
              {item.source === 'TODO' && item.shared && <li><button type="button" onClick={run(() => actions.unshare(item))}>Make it private again</button></li>}
              {item.source === 'TODO' && !item.done && actions.remind && <li><button type="button" onClick={run(() => actions.remind(item))}>Remind me…</button></li>}
              {item.source === 'TODO' && actions.repeat && <li><button type="button" onClick={run(() => actions.repeat(item))}>Repeat…</button></li>}
              {item.source === 'TODO' && !item.became && <li><button type="button" onClick={run(() => actions.makeTask(item))}>Make it a task…</button></li>}
              {isStep && <li><button type="button" onClick={run(() => actions.unshareStep(item))}>Take back as a private to-do</button></li>}
              {(isStep || isPin) && <li><Link to={`/?task=${item.task.id}`} onClick={() => setOpen(false)}>Open {item.task.ref}</Link></li>}
              {isPin && <li><button type="button" onClick={run(() => actions.unpin(item))}>Unpin (the task is unchanged)</button></li>}
              {item.source === 'TODO' && <li><button type="button" onClick={run(() => actions.remove(item))}>Remove</button></li>}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}
