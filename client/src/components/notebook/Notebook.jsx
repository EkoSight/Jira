/**
 * The whole notebook at /todos (Part N2, N3).
 *
 * Tabs on the page edge: Today, Week, Someday (Anytime), Lists (one tab per
 * recent list, then More) and Past pages (Done). Turning pages: the previous
 * and next day buttons, a swipe on touch screens (not from the screen's edge,
 * not while selecting text), or Alt+, and Alt+. on a keyboard. A bookmark
 * ribbon returns to today from anywhere. The page turn uses only transform and
 * opacity and is instant with reduced motion.
 *
 * Layouts come from the space the notebook is given (container queries):
 * under 600 px one page with the tabs as a bottom bar; 600-899 one large page
 * with tabs on its edge; 900-1279 a two-page spread; 1280 and wider the
 * spread with the time column and month index; from 1600 the book keeps a
 * comfortable size, centred on a plain desk.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Modal } from '../ui.jsx';
import DayPage from './DayPage.jsx';
import { MonthIndex, WeekSpread } from './WeekMonth.jsx';
import { Anytime, Done, Lists, ListDetail, Upcoming } from '../../pages/Todos.jsx';
import { addDays, longDay, pageTurnKey, swipeDirection } from '../../lib/notebook.js';
import { TODO_SHORTCUT, todoApi, typingIn } from '../../lib/todos.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function SignsAndShortcuts({ onClose }) {
  return (
    <Modal title="Signs and shortcuts" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="stack">
        <section>
          <h3 className="td-subhead">Margin signs</h3>
          <dl className="nb-signs">
            <dt aria-hidden="true">•</dt><dd>open: still to do</dd>
            <dt aria-hidden="true">×</dt><dd>done</dd>
            <dt aria-hidden="true">→</dt><dd>moved to another day (the date follows)</dd>
            <dt aria-hidden="true">○</dt><dd>a fixed time</dd>
          </dl>
          <p className="small muted">The sticky note holds lines carried over from earlier days; a paper clip marks a pinned task; the stamp on the right names the task or project a line belongs to, in its colour; a star marks what matters most.</p>
        </section>
        <section>
          <h3 className="td-subhead">Keyboard</h3>
          <ul className="nb-plain">
            <li><kbd>{TODO_SHORTCUT}</kbd> opens the pocket notebook from any page</li>
            <li><kbd>Alt+,</kbd> and <kbd>Alt+.</kbd> turn to the previous and next day</li>
            <li><kbd>Enter</kbd> on a line starts the next one</li>
            <li><kbd>Ctrl+Z</kbd> (<kbd>⌘Z</kbd> on a Mac) undoes the last change, up to 20</li>
            <li>None of these fire while you are typing in a field.</li>
          </ul>
        </section>
        <section>
          <h3 className="td-subhead">Touch</h3>
          <p className="small">Tap the empty line to write. Swipe left or right to turn the page (not from the screen’s edge). Press and hold a line to drag it to another day, or use Move to….</p>
        </section>
        <section>
          <h3 className="td-subhead">Offline</h3>
          <p className="small">Today’s page and the pocket notebook keep working without a connection: what you write is kept on this device and sent once, in order, when you are back. Other pages need a connection. Signing out clears what this device kept.</p>
        </section>
      </div>
    </Modal>
  );
}

function PageSettings({ prefs, onChange, onClose }) {
  return (
    <Modal title="Notebook settings" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="stack-sm">
        <label className="nb-switch"><input type="checkbox" checked={Boolean(prefs.handwriting)} onChange={(e) => onChange({ handwriting: e.target.checked })} /> Write my items in handwriting style</label>
        <label className="nb-switch"><input type="checkbox" checked={Boolean(prefs.haptics)} onChange={(e) => onChange({ haptics: e.target.checked })} /> A light tap when I tick a line (on phones that support it)</label>
        <label className="nb-switch"><input type="checkbox" checked={Boolean(prefs.hide_done)} onChange={(e) => onChange({ hide_done: e.target.checked })} /> Hide done lines</label>
        <p className="small muted">These are yours only. No sounds are ever played.</p>
      </div>
    </Modal>
  );
}

export default function Notebook() {
  const [params, setParams] = useSearchParams();
  const view = ['week', 'someday', 'lists', 'past', 'upcoming'].includes(params.get('view')) ? params.get('view') : 'today';
  const dayParam = DATE.test(params.get('day') || '') ? params.get('day') : null;
  const listParam = Number(params.get('list')) || null;
  const [today, setToday] = useState(null);
  const [turn, setTurn] = useState('');
  const [announce, setAnnounce] = useState('');
  const [dialog, setDialog] = useState(null);
  const [prefs, setPrefs] = useState({});
  const [lists, setLists] = useState([]);
  const addRef = useRef(null);
  const root = useRef(null);
  const touch = useRef(null);
  const focusAdd = params.get('add') === '1';

  useEffect(() => { todoApi.count().then((r) => setToday(r.day)).catch(() => setToday(new Date().toISOString().slice(0, 10))); }, []);
  useEffect(() => { todoApi.prefs({}).then(setPrefs).catch(() => {}); }, []);
  useEffect(() => { todoApi.lists().then((r) => setLists(r.lists)).catch(() => setLists([])); }, [view]);
  useEffect(() => { if (focusAdd) setTimeout(() => addRef.current?.focus(), 80); }, [focusAdd]);

  const day = dayParam || today;
  const go = useCallback((next) => {
    const p = {};
    if (next.view && next.view !== 'today') p.view = next.view;
    if (next.day && next.day !== today) p.day = next.day;
    if (next.list) p.list = String(next.list);
    setParams(p);
  }, [setParams, today]);

  const openDay = useCallback((d, direction = null) => {
    if (!d) return;
    setTurn(direction || (day && d < day ? 'previous' : 'next'));
    setAnnounce(`${longDay(d)}${d === today ? ', today' : ''}`);
    go({ view: 'today', day: d });
  }, [go, day, today]);
  const turnPage = useCallback((direction) => {
    if (!day) return;
    openDay(addDays(day, direction === 'next' ? 1 : -1), direction);
  }, [day, openDay]);

  useEffect(() => {
    const onKey = (e) => {
      const which = pageTurnKey(e);
      if (!which || typingIn(e.target) || view !== 'today') return;
      e.preventDefault();
      turnPage(which);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turnPage, view]);

  // swipe to turn the page (touch only); the phone's own edge gesture and text selection are left alone
  const onTouchStart = (e) => {
    if (view !== 'today' || e.touches.length !== 1) return;
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    const s = touch.current;
    touch.current = null;
    if (!s || !e.changedTouches[0]) return;
    const t = e.changedTouches[0];
    const sel = typeof window !== 'undefined' ? String(window.getSelection?.() || '') : '';
    const which = swipeDirection({ startX: s.x, startY: s.y, endX: t.clientX, endY: t.clientY, screenWidth: window.innerWidth, selecting: sel.length > 0 });
    if (which) turnPage(which);
  };

  const changePrefs = async (change) => {
    setPrefs((p) => ({ ...p, ...change }));
    try { setPrefs(await todoApi.prefs(change)); } catch { /* kept as shown */ }
    window.dispatchEvent(new CustomEvent('taskflow:todos-changed'));
  };

  const print = (what) => {
    document.body.dataset.print = what;
    const done = () => { delete document.body.dataset.print; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    if (what === 'week' && view !== 'week') { go({ view: 'week', day }); setTimeout(() => window.print(), 600); } else window.print();
  };

  const recent = lists.slice(0, 6);
  const tabs = [
    ['today', 'Today'], ['week', 'Week'], ['someday', 'Someday'],
    ...recent.map((l) => [`list:${l.id}`, l.name]),
    ['lists', recent.length ? 'More lists' : 'Lists'], ['past', 'Past pages'],
  ];
  const activeTab = view === 'lists' && listParam ? `list:${listParam}` : view === 'upcoming' ? 'week' : view;
  const choose = (k) => {
    if (k.startsWith('list:')) go({ view: 'lists', list: Number(k.slice(5)) });
    else go({ view: k, day: k === 'today' ? null : undefined });
  };

  return (
    <div className="nb" ref={root} data-view={view}>
      <div className="nb-desk">
        <div className="nb-toolbar" role="toolbar" aria-label="Notebook">
          {view === 'today' && day && (
            <>
              <button type="button" className="nb-tool" onClick={() => turnPage('previous')} aria-keyshortcuts="Alt+,">‹ <span className="nb-tool-words">{addDays(day, -1) === today ? 'Today' : longDay(addDays(day, -1)).split(' ').slice(0, 1).join(' ')}</span><span className="sr-only">, previous day</span></button>
              <button type="button" className="nb-tool" onClick={() => setDialog('month')}>Month</button>
              <button type="button" className="nb-tool" onClick={() => turnPage('next')} aria-keyshortcuts="Alt+.">
                <span className="nb-tool-words">{addDays(day, 1) === today ? 'Today' : longDay(addDays(day, 1)).split(' ').slice(0, 1).join(' ')}</span> ›<span className="sr-only">, next day</span>
              </button>
            </>
          )}
          <span className="nb-toolbar-gap" />
          <span className="nb-tools-inline">
            {(view === 'today' || view === 'week') && <button type="button" className="nb-tool" onClick={() => print(view === 'week' ? 'week' : 'day')}>{view === 'week' ? 'Print this week' : 'Print this page'}</button>}
            {view === 'today' && <button type="button" className="nb-tool" onClick={() => print('week')}>Print this week</button>}
            <button type="button" className="nb-tool" onClick={() => setDialog('help')}>Signs and shortcuts</button>
            <button type="button" className="nb-tool" onClick={() => setDialog('settings')}>Settings</button>
          </span>
          <details className="nb-toolmenu">
            <summary className="nb-tool">More</summary>
            <div className="td-menu nb-toolmenu-list">
              {view === 'today' && <button type="button" onClick={() => print('day')}>Print this page</button>}
              {(view === 'today' || view === 'week') && <button type="button" onClick={() => print('week')}>Print this week</button>}
              <button type="button" onClick={() => setDialog('help')}>Signs and shortcuts</button>
              <button type="button" onClick={() => setDialog('settings')}>Settings</button>
            </div>
          </details>
        </div>

        <div className="nb-book">
          <nav className="nb-tabs" aria-label="Notebook sections">
            {tabs.map(([k, l]) => (
              <button key={k} type="button" className={`nb-tab${activeTab === k ? ' is-active' : ''}`} aria-current={activeTab === k ? 'page' : undefined} onClick={() => choose(k)}>
                <span className="nb-tab-words">{l}</span>
              </button>
            ))}
          </nav>

          <div className="nb-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <div className="sr-only" role="status" aria-live="polite">{announce}</div>
            {view === 'today' && day && (
              <div key={day} className={`nb-turn${turn ? ` is-${turn}` : ''}`} onAnimationEnd={() => setTurn('')}>
                <DayPage day={dayParam} variant="full" onOpenDay={(d) => openDay(d)} addRef={addRef} autoFocus={focusAdd} />
              </div>
            )}
            {view === 'week' && (
              <>
                <div className="nb-subnav"><button type="button" className="nb-tool" onClick={() => go({ view: 'upcoming' })}>Next 14 days</button></div>
                <WeekSpread day={day} onOpenDay={(d) => openDay(d)} />
              </>
            )}
            {view === 'upcoming' && <div className="nb-page nb-plainpage"><div className="nb-subnav"><button type="button" className="nb-tool" onClick={() => go({ view: 'week' })}>This week</button></div><Upcoming /></div>}
            {view === 'someday' && <div className="nb-page nb-plainpage"><Anytime title="Someday" /></div>}
            {view === 'lists' && !listParam && <div className="nb-page nb-plainpage"><Lists onOpen={(id) => go({ view: 'lists', list: id })} /></div>}
            {view === 'lists' && listParam && <div className="nb-page nb-plainpage"><ListDetail id={listParam} onBack={() => go({ view: 'lists' })} onOpen={(id) => go({ view: 'lists', list: id })} /></div>}
            {view === 'past' && (
              <div className="nb-page nb-plainpage">
                <div className="nb-past-index"><MonthIndex day={day} today={today} onOpenDay={(d) => openDay(d)} /></div>
                <Done title="Past pages" />
              </div>
            )}
          </div>

          {day && (view !== 'today' || day !== today) && (
            <button type="button" className="nb-bookmark" onClick={() => openDay(today, day && today < day ? 'previous' : 'next')}>
              <span>Today</span><span className="sr-only">: back to today’s page</span>
            </button>
          )}
        </div>
      </div>

      {dialog === 'help' && <SignsAndShortcuts onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <PageSettings prefs={prefs} onChange={changePrefs} onClose={() => setDialog(null)} />}
      {dialog === 'month' && (
        <Modal title="Month index" onClose={() => setDialog(null)}>
          <MonthIndex day={day} today={today} onOpenDay={(d) => { setDialog(null); openDay(d); }} />
        </Modal>
      )}
    </div>
  );
}
