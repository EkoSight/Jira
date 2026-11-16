/**
 * Today's plan, top to bottom:
 *   1. Carried over: unfinished lines from earlier days, "From Fri 13 Nov",
 *      never called overdue;
 *   2. Today: my to-dos, my steps and pinned tasks, in my order (timed lines
 *      first). Move up / Move down, announced;
 *   3. Fixed times: today's meetings I am in, read-only;
 *   4. Done today: ticked lines stay where they were, struck through, with a
 *      count; "Hide done" folds them away (a personal switch).
 * "Group by project" groups by each line's derived project, "No project" last.
 *
 * The same component serves /todos, the header drawer, the overview card and
 * the workspace widget (`compact`).
 */
import { useCallback, useEffect, useState } from 'react';
import { Modal, Spinner } from '../ui.jsx';
import AddTodo from './AddTodo.jsx';
import TodoRow from './TodoRow.jsx';
import { useTodoActions } from './useTodoActions.jsx';
import { announceTodosChanged, dayLabel, groupByProject, leftWords, moveKey, todoApi } from '../../lib/todos.js';

const GROUP_KEY = 'taskflow.todos.groupByProject';
const readGroup = () => { try { return localStorage.getItem(GROUP_KEY) === '1'; } catch { return false; } };

export function useTodayPlan() {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try { setPlan(await todoApi.today()); setError(null); } catch (e) { setError(e); }
  }, []);
  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener('taskflow:todos-changed', on);
    return () => window.removeEventListener('taskflow:todos-changed', on);
  }, [load]);
  const patchLocal = useCallback((key, change) => {
    setPlan((p) => p && ({
      ...p,
      carried: p.carried.map((i) => (i.key === key ? { ...i, ...change } : i)),
      items: p.items.map((i) => (i.key === key ? { ...i, ...change } : i)),
    }));
  }, []);
  return { plan, error, load, patchLocal, setPlan };
}

export default function TodayPlan({ compact = false, showAdd = true, autoFocusAdd = false, addRef = null, limit = null, showTitle = true }) {
  const { plan, error, load, patchLocal, setPlan } = useTodayPlan();
  const [grouped, setGrouped] = useState(readGroup);
  const [planning, setPlanning] = useState(false);
  const { actions, dialogs, bars, say } = useTodoActions({ reload: load, patchLocal, today: plan?.today });

  if (error && !plan) {
    return (
      <div className="td-plan">
        <p role="alert" className="small">{error.status === 0 ? 'You’re offline, and today’s plan has not been loaded on this device yet.' : error.message}</p>
        <button type="button" className="btn btn-sm" onClick={load}>Try again</button>
      </div>
    );
  }
  if (!plan) return <div className="td-plan"><Spinner label="Loading today’s plan" /></div>;

  const hideDone = plan.hide_done;
  const visible = (list) => (hideDone ? list.filter((i) => !i.done) : list);
  const todayItems = visible(plan.items);
  const carried = visible(plan.carried);
  const movable = plan.items.filter((i) => !i.planned_time && !i.done);
  const moveOrder = movable.map((i) => i.key);

  const move = async (item, dir) => {
    const next = moveKey(moveOrder, item.key, dir);
    if (next === moveOrder) return;
    const timed = plan.items.filter((i) => i.planned_time || i.done).map((i) => i.key);
    const all = [...next, ...timed];
    setPlan((p) => ({ ...p, items: [...p.items].sort((a, b) => all.indexOf(a.key) - all.indexOf(b.key)) }));
    say(`Moved ${dir}: “${item.title}”, ${next.indexOf(item.key) + 1} of ${next.length}`);
    try { await todoApi.order(next); announceTodosChanged(); } catch (e) { load(); }
  };

  const toggleHide = async () => {
    setPlan((p) => ({ ...p, hide_done: !p.hide_done }));
    try { await todoApi.prefs({ hide_done: !hideDone }); } catch { load(); }
  };
  const toggleGroup = () => {
    setGrouped((g) => { try { localStorage.setItem(GROUP_KEY, g ? '0' : '1'); } catch { /* a convenience only */ } return !g; });
  };

  const rowsFor = (list, { movableKeys = [] } = {}) => list.map((item) => (
    <TodoRow key={item.key} item={item} today={plan.today}
      actions={{ ...actions, move: movableKeys.includes(item.key) ? move : null }}
      canMoveUp={movableKeys.indexOf(item.key) > 0}
      canMoveDown={movableKeys.includes(item.key) && movableKeys.indexOf(item.key) < movableKeys.length - 1} />
  ));

  const shownToday = limit ? todayItems.slice(0, limit) : todayItems;
  const groups = grouped ? groupByProject(shownToday) : null;

  return (
    <div className={`td-plan${compact ? ' is-compact' : ''}`}>
      <div className="td-plan-head">
        <div>
          {showTitle && <h2 className="td-plan-title">Today’s plan</h2>}
          <div className="small muted">{dayLabel(plan.today, plan.today)} · <span className="td-left">{leftWords(plan.left)}</span>{plan.done_count ? ` · ${plan.done_count} done` : ''}</div>
        </div>
        <div className="td-plan-tools">
          <button type="button" className="btn btn-sm" onClick={() => setPlanning(true)}>Plan my day</button>
        </div>
      </div>
      {showAdd && <AddTodo day="TODAY" today={plan.today} autoFocus={autoFocusAdd} inputRef={addRef} placeholder="Add a to-do for today" />}
      {bars}

      {carried.length > 0 && (
        <section className="td-section" aria-labelledby="td-carried">
          <h3 id="td-carried" className="td-subhead">Carried over</h3>
          <ul className="td-list">{rowsFor(carried)}</ul>
        </section>
      )}

      <section className="td-section" aria-labelledby="td-today">
        <div className="td-section-head">
          <h3 id="td-today" className="td-subhead">Today</h3>
          {!compact && (
            <label className="td-switch small">
              <input type="checkbox" checked={grouped} onChange={toggleGroup} /> Group by project
            </label>
          )}
        </div>
        {shownToday.length === 0 && (
          <p className="small muted td-empty">{plan.items.length ? 'Everything is done. Done lines are hidden.' : 'Nothing planned yet. Write one line above, or use Plan my day.'}</p>
        )}
        {groups ? groups.map((g) => (
          <div key={g.key} className="td-group">
            <h4 className="td-group-title">{g.label}</h4>
            <ul className="td-list">{rowsFor(g.items, { movableKeys: moveOrder })}</ul>
          </div>
        )) : <ul className="td-list">{rowsFor(shownToday, { movableKeys: moveOrder })}</ul>}
        {limit && todayItems.length > limit && <p className="small muted">and {todayItems.length - limit} more on the full page</p>}
      </section>

      {plan.meetings.length > 0 && (
        <section className="td-section" aria-labelledby="td-fixed">
          <h3 id="td-fixed" className="td-subhead">Fixed times</h3>
          <ul className="td-list td-fixed">
            {plan.meetings.map((m) => (
              <li key={m.id} className="td-row is-fixed">
                <span className="td-time">{m.time}</span> <a href={m.url}>{m.title}</a>{m.status === 'COMPLETED' ? <span className="small muted"> · held</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="td-done-bar small">
        <span>Done today: {plan.done_count}</span>
        <label className="td-switch"><input type="checkbox" checked={hideDone} onChange={toggleHide} /> Hide done</label>
      </div>
      {planning && <PlanMyDay today={plan.today} onClose={() => setPlanning(false)} onChanged={load} />}
      {dialogs}
    </div>
  );
}

/** Suggestions for the day. Nothing is added unless chosen. */
export function PlanMyDay({ today, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState({});
  useEffect(() => { todoApi.suggestions().then(setData).catch((e) => setError(e.message)); }, []);
  const mark = (key) => setAdded((a) => ({ ...a, [key]: true }));
  const pin = async (task) => {
    try { await todoApi.pin(task.id); mark(`t${task.id}`); announceTodosChanged(); onChanged?.(); } catch (e) { setError(e.message); }
  };
  const planStep = async (step) => {
    try { await todoApi.step(step.id, { planned_on: 'TODAY' }); mark(`s${step.id}`); announceTodosChanged(); onChanged?.(); } catch (e) { setError(e.message); }
  };
  const meeting = async (m) => {
    try {
      await todoApi.add({ title: `Prepare: ${m.title}`, planned_on: 'TODAY', link_type: 'MEETING', link_id: m.id, client_key: `meeting-${m.id}-${today}` });
      mark(`m${m.id}`); announceTodosChanged(); onChanged?.();
    } catch (e) { setError(e.message); }
  };
  const due = (t) => (t.overdue ? `Overdue since ${dayLabel(t.due_day, today)}` : t.due_today ? 'Due today' : `Due ${dayLabel(t.due_day, today)}`);
  const empty = data && !data.tasks.length && !data.steps.length && !data.milestones.length && !data.meetings.length;
  return (
    <Modal title="Plan my day" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Back to today’s plan</button>}>
      <div className="stack">
        <p className="small muted">Pick what goes on today’s plan. A pinned task shows its own live status; pinning changes nothing on it.</p>
        {error && <p role="alert" className="small">{error}</p>}
        {!data && !error && <Spinner label="Finding suggestions" />}
        {empty && <p className="small muted">Nothing due soon, no steps waiting and no meetings today.</p>}
        {data?.tasks.length > 0 && (
          <section>
            <h3 className="td-subhead">My tasks due soon</h3>
            <ul className="td-pick-list">
              {data.tasks.map((t) => (
                <li key={t.id} className="td-suggest-row">
                  <span><strong>{t.ref}</strong> {t.title} <span className="small muted">· {due(t)}</span></span>
                  <button type="button" className="btn btn-sm" disabled={added[`t${t.id}`]} onClick={() => pin(t)}>{added[`t${t.id}`] ? 'Pinned' : 'Pin to today'}</button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {data?.steps.length > 0 && (
          <section>
            <h3 className="td-subhead">My steps</h3>
            <ul className="td-pick-list">
              {data.steps.map((s) => (
                <li key={s.id} className="td-suggest-row">
                  <span>{s.title} <span className="small muted">· {s.task.ref}{s.planned_on ? ` · ${dayLabel(s.planned_on, today)}` : ''}</span></span>
                  <button type="button" className="btn btn-sm" disabled={added[`s${s.id}`]} onClick={() => planStep(s)}>{added[`s${s.id}`] ? 'Planned' : 'Do today'}</button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {data?.milestones.map((m) => (
          <section key={m.id}>
            <h3 className="td-subhead">{m.project.name}: milestone “{m.name}”, {dayLabel(m.target_date, today)}</h3>
            <ul className="td-pick-list">
              {m.tasks.map((t) => (
                <li key={t.id} className="td-suggest-row">
                  <span><strong>{t.ref}</strong> {t.title}</span>
                  <button type="button" className="btn btn-sm" disabled={added[`t${t.id}`]} onClick={() => pin(t)}>{added[`t${t.id}`] ? 'Pinned' : 'Pin to today'}</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {data?.meetings.length > 0 && (
          <section>
            <h3 className="td-subhead">Meetings today</h3>
            <ul className="td-pick-list">
              {data.meetings.map((m) => (
                <li key={m.id} className="td-suggest-row">
                  <span>{m.time} {m.title}</span>
                  <button type="button" className="btn btn-sm" disabled={added[`m${m.id}`]} onClick={() => meeting(m)}>{added[`m${m.id}`] ? 'Added' : 'Add a line to prepare'}</button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
