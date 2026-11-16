/**
 * /todos: Today's plan, Upcoming (14 days), Anytime, Lists and Done (with
 * "What I did", for the person's own updates). Everything here is private
 * to the person signed in, unless they shared a line onto a record.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Spinner } from '../components/ui.jsx';
import Notebook from '../components/notebook/Notebook.jsx';
import AddTodo from '../components/todos/AddTodo.jsx';
import TodoRow from '../components/todos/TodoRow.jsx';
import { LinkPicker, RoutineDialog } from '../components/todos/Pickers.jsx';
import { useTodoActions } from '../components/todos/useTodoActions.jsx';
import { api } from '../api/client.js';
import { WHAT_I_DID, announceTodosChanged, dayLabel, relativeDay, todoApi } from '../lib/todos.js';

const VIEWS = [
  ['today', 'Today’s plan'],
  ['upcoming', 'Upcoming'],
  ['anytime', 'Anytime'],
  ['lists', 'Lists'],
  ['done', 'Done'],
];

/** Load a view and reload it whenever any to-do changes anywhere. */
function useView(loader) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try { setData(await loader()); setError(null); } catch (e) { setError(e); }
  }, [loader]);
  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener('taskflow:todos-changed', on);
    return () => window.removeEventListener('taskflow:todos-changed', on);
  }, [load]);
  return { data, error, load };
}

function ViewState({ error, data, children }) {
  if (error) return <p role="alert" className="small">{error.status === 0 ? 'You’re offline. This view needs a connection.' : error.message}</p>;
  if (!data) return <Spinner label="Loading" />;
  return children;
}

/** /todos is the notebook (Part N); the views below are its Week, Someday, Lists and Past pages tabs. */
export default function Todos() {
  return (
    <div className="page td-page">
      <h1 className="sr-only">To-dos</h1>
      <Notebook />
    </div>
  );
}

export function Upcoming() {
  const loader = useCallback(() => todoApi.upcoming(), []);
  const { data, error, load } = useView(loader);
  const { actions, dialogs, bars } = useTodoActions({ reload: load, today: data?.today });
  return (
    <div className="card card-pad stack">
      <h2 className="td-plan-title nb-hand">Next 14 days</h2>
      <p className="small muted">The next 14 days{data ? `, ${dayLabel(data.from, data.today)} to ${dayLabel(data.to, data.today)}` : ''}.</p>
      {bars}
      <ViewState error={error} data={data}>
        {data?.days.length === 0 && <p className="small muted">Nothing planned for the next 14 days.</p>}
        {data?.days.map((d) => (
          <section key={d.day} className="td-section">
            <h3 className="td-subhead">{relativeDay(d.day, data.today)}</h3>
            <ul className="td-list">{d.items.map((item) => <TodoRow key={item.key} item={item} today={data.today} actions={actions} />)}</ul>
          </section>
        ))}
      </ViewState>
      {dialogs}
    </div>
  );
}

export function Anytime({ title = 'Anytime' }) {
  const loader = useCallback(() => todoApi.anytime(), []);
  const { data, error, load } = useView(loader);
  const { actions, dialogs, bars } = useTodoActions({ reload: load, today: data?.today });
  return (
    <div className="card card-pad stack">
      <h2 className="td-plan-title nb-hand">{title}</h2>
      <p className="small muted">Lines with no day. Give one a day from its menu when it is time.</p>
      <AddTodo placeholder="Add a to-do with no day" onAdded={load} today={data?.today} />
      {bars}
      <ViewState error={error} data={data}>
        {data?.items.length === 0 && <p className="small muted">Nothing without a day.</p>}
        <ul className="td-list">{data?.items.map((item) => <TodoRow key={item.key} item={item} today={data.today} actions={actions} />)}</ul>
      </ViewState>
      {dialogs}
    </div>
  );
}

export function Lists({ onOpen = null }) {
  const [openState, setOpenState] = useState(null);
  const open = onOpen ? null : openState;
  const setOpen = onOpen || setOpenState;
  const loader = useCallback(() => todoApi.lists(), []);
  const { data, error, load } = useView(loader);
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const add = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    try { const r = await todoApi.addList({ name }); setName(''); await load(); setOpen(r.list.id); } catch (x) { setErr(x.message); }
  };
  if (open) return <ListDetail id={open} onBack={() => { setOpen(null); load(); }} onOpen={setOpen} />;
  return (
    <div className="stack">
    <div className="card card-pad stack">
      <h2 className="td-plan-title">Lists</h2>
      <p className="small muted">
        A list is your own checklist, such as “Trade fair prep”, and only you see it. A checklist that several people tick belongs on a task (its steps).
        A set of related tasks is a project.
      </p>
      <form className="td-add-row" onSubmit={add}>
        <label className="sr-only" htmlFor="td-new-list">New list</label>
        <input id="td-new-list" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="New list, for example “Trade fair prep”" />
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Create</button>
      </form>
      {err && <p role="alert" className="small">{err}</p>}
      <ViewState error={error} data={data}>
        {data?.lists.length === 0 && <p className="small muted">No lists yet.</p>}
        <ul className="td-lists">
          {data?.lists.map((l) => (
            <li key={l.id}>
              <button type="button" className="td-list-card" onClick={() => setOpen(l.id)}>
                <strong>{l.name}</strong>
                <span className="small muted">{l.left} left of {l.total}{l.link ? ` · ${l.link.label}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </ViewState>
    </div>
    <Routines />
    </div>
  );
}

/** Repeating to-dos: made on the person's own working days, never backfilled. */
function Routines() {
  const loader = useCallback(() => api.get('/todos/routines'), []);
  const { data, error, load } = useView(loader);
  const [editing, setEditing] = useState(null);
  const stop = async (r) => { await api.post(`/todos/routines/${r.id}/stop`); await load(); };
  return (
    <div className="card card-pad stack">
      <div className="row-between wrap">
        <h2 className="td-plan-title">Repeating to-dos</h2>
        <button type="button" className="btn btn-sm" onClick={() => setEditing({})}>New routine</button>
      </div>
      <p className="small muted">One item on each of your working days that matches; nothing on your weekly off, holidays or leave, and missed days are not filled in. A routine others must tick, or a manager must see, is a recurring task with steps.</p>
      <ViewState error={error} data={data}>
        {data?.routines.length === 0 && <p className="small muted">No routines yet.</p>}
        <ul className="td-list">
          {data?.routines.map((r) => (
            <li key={r.id} className={`td-row${r.stopped ? ' is-done' : ''}`}>
              <div className="td-row-main">
                <div className="td-row-text">
                  <span className="td-title"><span className="td-words">{r.title}</span></span>
                  <div className="td-meta small">
                    <span>{r.words}{r.planned_time ? `, ${r.planned_time}` : ''}</span>
                    <span>{r.made} made</span>
                    {r.stopped && <span>Stopped; its items are kept</span>}
                  </div>
                </div>
                {!r.stopped && (
                  <span className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing({ routine: r })}>Change</button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => stop(r)}>Stop</button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ViewState>
      {editing && (
        <RoutineDialog routine={editing.routine || null} onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); announceTodosChanged(); }} />
      )}
    </div>
  );
}

export function ListDetail({ id, onBack, onOpen }) {
  const loader = useCallback(() => todoApi.list(id), [id]);
  const { data, error, load } = useView(loader);
  const [linking, setLinking] = useState(false);
  const { actions, dialogs, bars, say } = useTodoActions({ reload: load, today: null });
  const again = async () => {
    try { const r = await todoApi.useAgain(id); say('A fresh copy, every item unticked'); announceTodosChanged(); onOpen(r.list.id); } catch (e) { say(e.message); }
  };
  const remove = async () => { await todoApi.removeList(id); onBack(); };
  return (
    <div className="card card-pad stack">
      <button type="button" className="btn btn-ghost btn-sm td-back" onClick={onBack}>← All lists</button>
      <ViewState error={error} data={data}>
        {data && <>
          <div className="row-between">
            <h2 className="td-plan-title">{data.list.name}</h2>
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={again}>Use again</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={remove}>Remove list</button>
            </div>
          </div>
          <div className="small">
            {data.list.link ? <>Linked to <a href={data.list.link.url}>{data.list.link.label}</a>; its items follow it (privately). </> : 'Not linked. '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLinking(true)}>{data.list.link ? 'Change' : 'Link the whole list…'}</button>
          </div>
          <AddTodo listId={id} placeholder="Add an item" onAdded={load} />
          {bars}
          <ul className="td-list">{data.items.map((item) => <TodoRow key={item.key} item={item} today={null} actions={actions} showDay />)}</ul>
        </>}
      </ViewState>
      {linking && (
        <LinkPicker current={data?.list.link} onClose={() => setLinking(false)}
          onPick={async (l) => { setLinking(false); await todoApi.changeList(id, { link: l ? { type: l.type, id: l.id } : null }); await load(); }} />
      )}
      {dialogs}
    </div>
  );
}

export function Done({ title = 'Done' }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [whatIDid, setWhatIDid] = useState(false);
  const loader = useCallback(() => todoApi.done({ q: query || undefined, what_i_did: whatIDid ? 1 : undefined }), [query, whatIDid]);
  const { data, error, load } = useView(loader);
  const { actions, dialogs, bars } = useTodoActions({ reload: load, today: null });
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const byKey = new Map((data?.items || []).map((i) => [i.key, i]));
  return (
    <div className="card card-pad stack">
      <div className="row-between">
        <h2 className="td-plan-title nb-hand">{title}</h2>
        <label className="td-switch small"><input type="checkbox" checked={whatIDid} onChange={(e) => setWhatIDid(e.target.checked)} /> What I did</label>
      </div>
      <label className="td-field">
        <span className="sr-only">Search what you did</span>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search what you did" />
      </label>
      {whatIDid && <p className="small muted">Grouped by project, task, goal, department and record, for your own updates. Only you see this.</p>}
      {bars}
      <ViewState error={error} data={data}>
        {data?.items.length === 0 && <p className="small muted">{query ? `Nothing done matches “${query}”.` : 'Nothing done yet.'}</p>}
        {!whatIDid && <ul className="td-list">{data?.items.map((item) => <TodoRow key={item.key} item={item} today={null} actions={actions} showDay />)}</ul>}
        {whatIDid && data?.groups && (
          <div className="stack">
            {WHAT_I_DID.map(([dim, heading]) => data.groups[dim].length > 0 && (
              <section key={dim} className="td-section">
                <h3 className="td-subhead">{heading}</h3>
                {data.groups[dim].map((g) => (
                  <div key={g.key} className="td-group">
                    <h4 className="td-group-title">{g.url ? <Link to={g.url}>{g.label}</Link> : g.label} <span className="small muted">· {g.items.length}</span></h4>
                    <ul className="td-plain">{g.items.map((k) => <li key={k}>{byKey.get(k)?.title}</li>)}</ul>
                  </div>
                ))}
              </section>
            ))}
            {data.groups.unlinked.length > 0 && (
              <section className="td-section">
                <h3 className="td-subhead">Not linked</h3>
                <ul className="td-plain">{data.groups.unlinked.map((k) => <li key={k}>{byKey.get(k)?.title}</li>)}</ul>
              </section>
            )}
          </div>
        )}
      </ViewState>
      {dialogs}
    </div>
  );
}
