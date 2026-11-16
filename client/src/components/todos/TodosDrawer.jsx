/**
 * To-dos on every page: a header button with today's remaining count ("3
 * left") that opens a side drawer with the add box, then Today's plan.
 *
 * Shortcut: Alt+N (Option+N on a Mac) opens the drawer with the add box
 * focused. It never fires while typing in a field, does not use a key the
 * browsers or screen readers here rely on, and is shown on the button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useRefData } from '../../state/AppState.jsx';
import { Icon } from '../ui.jsx';
import TodayPlan from './TodayPlan.jsx';
import { TODO_SHORTCUT, isTodoShortcut, todoApi, typingIn } from '../../lib/todos.js';

export { TODO_SHORTCUT, typingIn, isTodoShortcut };

export function useTodoCount() {
  const [left, setLeft] = useState(null);
  const load = useCallback(() => todoApi.count().then((r) => setLeft(r.left)).catch(() => {}), []);
  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener('taskflow:todos-changed', on);
    window.addEventListener('focus', on);
    const timer = setInterval(load, 120_000);
    return () => { window.removeEventListener('taskflow:todos-changed', on); window.removeEventListener('focus', on); clearInterval(timer); };
  }, [load]);
  return left;
}

export default function TodosHeaderButton() {
  const { settings } = useRefData() || {};
  const on = settings?.todos?.enabled !== false;
  const [open, setOpen] = useState(false);
  const button = useRef(null);
  const left = useTodoCount();

  useEffect(() => {
    if (!on) return undefined;
    const onKey = (e) => {
      if (!isTodoShortcut(e) || typingIn(e.target)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);

  if (!on) return null;
  const words = left == null ? 'To-dos' : `${left} left`;
  return (
    <>
      <button ref={button} type="button" className="btn btn-ghost btn-sm td-head-btn" onClick={() => setOpen(true)}
        aria-haspopup="dialog" aria-keyshortcuts={TODO_SHORTCUT} title={`To-dos: ${words} today (${TODO_SHORTCUT})`}
        aria-label={`To-dos, ${left == null ? 'today’s plan' : `${words} today`}. Shortcut ${TODO_SHORTCUT}`}>
        <Icon name="check" size={15} />
        <span className="td-head-label">To-dos</span>
        {left != null && <span className={`td-head-count${left ? '' : ' is-zero'}`}>{left}<span className="td-head-left"> left</span></span>}
      </button>
      {open && <TodosDrawer onClose={() => { setOpen(false); requestAnimationFrame(() => button.current?.focus()); }} />}
    </>
  );
}

export function TodosDrawer({ onClose }) {
  const panel = useRef(null);
  const addRef = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => addRef.current?.focus(), 30);
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) { e.stopPropagation(); onClose(); }
      // keep Tab inside the drawer
      if (e.key === 'Tab' && panel.current) {
        const focusable = [...panel.current.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  // rendered at the end of the page, above the top bar and the phone's bottom navigation
  return createPortal(
    <div className="td-drawer-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={panel} className="td-drawer" role="dialog" aria-modal="true" aria-labelledby="td-drawer-title">
        <div className="td-drawer-head">
          <h2 id="td-drawer-title" className="td-plan-title">To-dos</h2>
          <div className="row" style={{ gap: 6 }}>
            <Link to="/todos" className="btn btn-sm btn-ghost" onClick={onClose}>Open the full page</Link>
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close to-dos"><Icon name="close" /></button>
          </div>
        </div>
        <div className="td-drawer-body">
          <TodayPlan compact addRef={addRef} />
          <p className="small muted">Shortcut: {TODO_SHORTCUT} opens this from any page (not while typing in a field).</p>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
