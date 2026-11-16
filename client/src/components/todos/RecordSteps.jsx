/**
 * To-dos on a record's own page (a project, key result, objective, deal,
 * application or meeting; on a task, only the private part).
 *
 * - Steps: lines their owners shared onto this record, seen by everyone who
 *   can see the record (who and when; never the note). Adding here shares,
 *   and the box says who will see it. Nothing here moves a status, a stage,
 *   a date or a goal's value.
 * - My private to-dos (n): my own lines linked here. Nobody else sees them.
 */
import { useCallback, useEffect, useState } from 'react';
import { Spinner, Who } from '../ui.jsx';
import AddTodo from './AddTodo.jsx';
import TodoRow from './TodoRow.jsx';
import { useTodoActions } from './useTodoActions.jsx';
import { dayLabel, todoApi } from '../../lib/todos.js';

const ACTIVITY = { step_added: 'added a step', step_removed: 'removed a step', step_done: 'ticked a step', step_reopened: 'unticked a step' };
const WORD = { PROJECT: 'Project', KEY_RESULT: 'Key result', OBJECTIVE: 'Objective', DEAL: 'Deal', APPLICATION: 'Application', MEETING: 'Meeting', TASK: '' };

export function useRecordSteps(type, id) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!id) return;
    try { setData(await todoApi.record(type, id)); setError(null); } catch (e) { setError(e); }
  }, [type, id]);
  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener('taskflow:todos-changed', on);
    return () => window.removeEventListener('taskflow:todos-changed', on);
  }, [load]);
  return { data, error, load };
}

/** The count for a tab or a card: "Steps done 3/5". */
export function StepsCount({ type, id }) {
  const { data } = useRecordSteps(type, id);
  if (!data || !data.steps_total) return null;
  return <span className="small">Steps done {data.steps_done}/{data.steps_total}</span>;
}

export default function RecordSteps({ type, id, label, showShared = true, title = 'Steps', compact = false }) {
  const { data, error, load } = useRecordSteps(type, id);
  const [showMine, setShowMine] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const { actions, dialogs, bars } = useTodoActions({ reload: load, today });
  if (error) return error.status === 404 ? null : <p className="small" role="alert">{error.message}</p>;
  if (!data) return <Spinner label="Loading steps" />;
  const recordName = `${WORD[type] ? `${WORD[type]} ` : ''}${label}`;
  const tick = async (step, done) => {
    try { await todoApi.change(step.id, { done }); await load(); } catch (e) { /* the owner may have taken it back */ await load(); }
  };
  return (
    <section className={`td-record${compact ? ' is-compact' : ''}`} aria-label={title}>
      {showShared && type !== 'TASK' && (
        <div className="stack-sm">
          <div className="row-between">
            <h3 className="td-subhead">{title}</h3>
            {data.steps_total > 0 && <span className="small muted">Steps done {data.steps_done}/{data.steps_total}</span>}
          </div>
          {data.shared.length === 0 && <p className="small muted">No shared steps yet.</p>}
          <ul className="td-list">
            {data.shared.map((s) => (
              <li key={s.id} className={`td-row${s.done ? ' is-done' : ''}`}>
                <div className="td-row-main">
                  {s.mine
                    ? <input type="checkbox" className="td-check" checked={s.done} aria-label={s.title} onChange={(e) => tick(s, e.target.checked)} />
                    : <span className={`td-dot${s.done ? ' is-done' : ''}`} aria-hidden="true" />}
                  <div className="td-row-text">
                    <span className="td-title"><span className="td-words">{s.title}</span>{!s.mine && <span className="sr-only">{s.done ? ' (done)' : ' (open)'}</span>}</span>
                    <div className="td-meta small">
                      <Who id={s.owner.id} name={s.owner.name} size={16} />
                      {s.done && s.done_at && <span>done {dayLabel(new Date(s.done_at).toISOString().slice(0, 10), today)}</span>}
                      {!s.done && s.planned_on && <span>{dayLabel(s.planned_on, today)}</span>}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <AddTodo link={{ type, id, label }} shared placeholder="Add a step everyone here can see"
            shareWords={`People who can see ${recordName} will see this.`} label={`Add a step to ${recordName}`} onAdded={load} />
          {data.done_since_check_in && data.done_since_check_in.length > 0 && (
            <p className="small muted">Done since the last check-in: {data.done_since_check_in.map((s) => s.title).join('; ')}. Context only; the value is not changed.</p>
          )}
          {data.activity?.length > 0 && (
            <details className="small">
              <summary>Step history</summary>
              <ul className="td-history">
                {data.activity.map((a, i) => <li key={i}><Who id={a.actor_id} name={a.actor_name} size={16} fallback="Someone" /> {ACTIVITY[a.action] || a.action}: “{a.title}”, {dayLabel(new Date(a.created_at).toISOString().slice(0, 10), today)}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="td-mine">
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showMine} onClick={() => setShowMine((v) => !v)}>
          My private to-dos ({data.mine_count})
        </button>
        {showMine && (
          <div className="stack-sm">
            <p className="small muted">Only you see these.</p>
            {bars}
            <ul className="td-list">
              {data.mine.map((item) => <TodoRow key={item.key} item={item} today={today} actions={actions} showDay />)}
            </ul>
            <AddTodo link={{ type, id, label }} placeholder="Add a private to-do here" label={`Add a private to-do on ${recordName}`} onAdded={load} />
          </div>
        )}
      </div>
      {dialogs}
    </section>
  );
}
