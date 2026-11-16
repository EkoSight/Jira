/**
 * What every to-do surface can do to a line, in one place: tick (with 5
 * seconds to undo), move to a day, time, link, share (after saying who will
 * see it), take back, make it a task, remove, and complete a pinned task
 * through the normal completion dialog. Changes are announced for screen
 * readers, and every open plan is told to refresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useRefData, useToast } from '../../state/AppState.jsx';
import CompleteTaskDialog from '../CompleteTaskDialog.jsx';
import TaskDialog from '../TaskDialog.jsx';
import { DayDialog, LinkPicker, ReminderDialog, RoutineDialog, ShareDialog, TimeDialog } from './Pickers.jsx';
import { announceTodosChanged, todoApi } from '../../lib/todos.js';

const prefillFor = (item) => {
  const defaults = { title: item.title };
  if (item.planned_on) defaults.due_date = `${item.planned_on}T${item.planned_time || '18:00'}`;
  const link = item.link?.visible ? item.link : null;
  if (link?.type === 'PROJECT') defaults.project_id = link.id;
  if (link?.type === 'TASK') defaults.parent_task_id = link.id;
  if (link?.type === 'KEY_RESULT') defaults.key_result = { id: link.id, title: link.label };
  if (link?.type === 'DEAL' || link?.type === 'APPLICATION') defaults.opportunity_id = link.id;
  return defaults;
};

export function useTodoActions({ reload, patchLocal, today }) {
  const toast = useToast();
  const { statuses = [] } = useRefData() || {};
  const [dialog, setDialog] = useState(null);
  const [undo, setUndo] = useState(null);
  const [message, setMessage] = useState('');
  const [doneNote, setDoneNote] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const say = useCallback((words) => { setMessage(''); requestAnimationFrame(() => setMessage(words)); }, []);
  const changed = useCallback(async () => { announceTodosChanged(); await reload?.(); }, [reload]);
  const failed = useCallback((e) => toast.error(e.status === 0 ? 'Not saved: you’re offline' : e.message), [toast]);

  const setDone = useCallback(async (item, done) => {
    if (item.source === 'TODO') return todoApi.change(item.id, { done });
    if (item.source === 'STEP') return todoApi.step(item.id, { done });
    return null;
  }, []);

  const tick = useCallback(async (item, done, { offerUndo = true } = {}) => {
    patchLocal?.(item.key, { done });
    say(done ? `Ticked “${item.title}”` : `Unticked “${item.title}”`);
    try {
      const result = await setDone(item, done);
      if (offerUndo) {
        clearTimeout(timer.current);
        setUndo({ label: done ? `Ticked “${item.title}”` : `Unticked “${item.title}”`, run: () => tick(item, !done, { offerUndo: false }) });
        timer.current = setTimeout(() => setUndo(null), 5000);
      }
      if (done && item.source === 'TODO') {
        const suggestion = result?.todo?.suggestion || item.suggestion;
        if (result?.offer_share) setDoneNote({ kind: 'share', item: result.todo, words: result.offer_share });
        else if (suggestion && !item.link) setDoneNote({ kind: 'suggest', item, words: `Link it to ${suggestion.word} ${suggestion.label}?` });
      }
      if (result?.ask_complete) setDoneNote({ kind: 'complete', item, words: result.ask_complete.words, taskId: result.ask_complete.task_id });
      await changed();
    } catch (e) {
      patchLocal?.(item.key, { done: !done });
      failed(e);
    }
  }, [patchLocal, say, setDone, changed, failed]);

  const change = useCallback(async (item, body, words) => {
    try {
      if (item.source === 'STEP') await todoApi.step(item.id, body);
      else await todoApi.change(item.id, body);
      if (words) say(words);
      await changed();
    } catch (e) { failed(e); }
  }, [say, changed, failed]);

  const openCompletion = useCallback(async (taskId) => {
    const done = statuses.find((s) => s.stage === 'done');
    if (!done) { toast.error('No "done" status is configured'); return; }
    try {
      const { task } = await api.task(taskId);
      setDialog({ kind: 'complete', task, statusId: done.id });
    } catch (e) { failed(e); }
  }, [statuses, toast, failed]);

  const actions = {
    tick,
    moveDay: (item, day) => change(item, { planned_on: day }, day === 'TODAY' ? 'Moved to today' : day === 'TOMORROW' ? 'Moved to tomorrow' : 'Moved'),
    pickDay: (item) => setDialog({ kind: 'day', item }),
    pickTime: (item) => setDialog({ kind: 'time', item }),
    link: (item) => setDialog({ kind: 'link', item }),
    acceptSuggestion: (item) => change(item, { link: { type: item.suggestion.type, id: item.suggestion.id } }, `Linked to ${item.suggestion.label}`),
    share: (item) => setDialog({ kind: 'share', item }),
    unshare: async (item) => { try { await todoApi.unshare(item.id); say('Private again'); await changed(); } catch (e) { failed(e); } },
    unshareStep: async (item) => { try { await todoApi.unshareStep(item.id); say('Taken back as a private to-do'); await changed(); } catch (e) { failed(e); } },
    makeTask: (item) => setDialog({ kind: 'task', item }),
    remind: (item) => setDialog({ kind: 'remind', item }),
    repeat: (item) => setDialog({ kind: 'repeat', item }),
    keep: (item) => change(item, { still_want: true }, 'Kept'),
    remove: async (item) => { try { await todoApi.remove(item.id); say(`Removed “${item.title}”`); await changed(); } catch (e) { failed(e); } },
    complete: (item) => openCompletion(item.task.id),
    unpin: async (item) => { try { await todoApi.unpin(item.id); say('Unpinned; the task is unchanged'); await changed(); } catch (e) { failed(e); } },
  };

  const close = () => setDialog(null);
  const dialogs = (
    <>
      {dialog?.kind === 'day' && (
        <DayDialog value={dialog.item.planned_on} today={today} allowNone={dialog.item.source === 'TODO'} onClose={close}
          onPick={(d) => { close(); change(dialog.item, { planned_on: d }, d ? 'Moved' : 'Moved to Anytime'); }} />
      )}
      {dialog?.kind === 'time' && (
        <TimeDialog value={dialog.item.planned_time} onClose={close} onPick={(t) => { close(); change(dialog.item, { planned_time: t }, t ? `Time set to ${t}` : 'Time removed'); }} />
      )}
      {dialog?.kind === 'link' && (
        <LinkPicker current={dialog.item.link} onClose={close}
          onPick={(l) => { close(); change(dialog.item, { link: l ? { type: l.type, id: l.id } : null }, l ? `Linked to ${l.label}` : 'Link removed'); }} />
      )}
      {dialog?.kind === 'share' && (
        <ShareDialog item={dialog.item} onClose={close}
          onShared={async (r) => { close(); say(r.step ? 'It is a step on the task now' : 'Shared on its record'); if (r.step && !r.in_plan) toast.info('It left your plan: only the assignee or a collaborator can own a step.'); await changed(); }} />
      )}
      {dialog?.kind === 'task' && (
        <TaskDialog defaults={prefillFor(dialog.item)} onClose={close}
          onSaved={async (task) => {
            close();
            if (task?.id) {
              try { const r = await todoApi.becameTask(dialog.item.id, task.id); say(`Became ${r.todo.became?.ref || task.ref}`); } catch (e) { failed(e); }
              await changed();
            }
          }} />
      )}
      {dialog?.kind === 'repeat' && (
        <RoutineDialog initial={dialog.item} onClose={close} onSaved={() => { close(); say('It repeats now; find it under Lists → Repeating to-dos'); }} />
      )}
      {dialog?.kind === 'remind' && (
        <ReminderDialog item={dialog.item} onClose={(words) => { close(); if (words) say(words); }} />
      )}
      {dialog?.kind === 'complete' && (
        <CompleteTaskDialog task={dialog.task} targetStatusId={dialog.statusId} onClose={close} onCompleted={async () => { close(); await changed(); }} />
      )}
    </>
  );

  const bars = (
    <>
      <div className="sr-only" role="status" aria-live="polite">{message}</div>
      {undo && (
        <div className="td-undo" role="group" aria-label="Undo">
          <span>{undo.label}</span>
          <button type="button" className="btn btn-sm" onClick={() => { clearTimeout(timer.current); const u = undo; setUndo(null); u.run(); }}>Undo</button>
        </div>
      )}
      {doneNote && (
        <div className="td-donenote" role="group" aria-label="Done">
          <span>{doneNote.words}</span>
          {doneNote.kind === 'share' && <button type="button" className="btn btn-sm btn-primary" onClick={() => { setDialog({ kind: 'share', item: doneNote.item }); setDoneNote(null); }}>Add to its progress…</button>}
          {doneNote.kind === 'suggest' && <button type="button" className="btn btn-sm" onClick={() => { actions.acceptSuggestion(doneNote.item); setDoneNote(null); }}>Link it</button>}
          {doneNote.kind === 'complete' && <button type="button" className="btn btn-sm btn-primary" onClick={() => { openCompletion(doneNote.taskId); setDoneNote(null); }}>Complete…</button>}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDoneNote(null)}>{doneNote.kind === 'complete' ? 'Not now' : 'No thanks'}</button>
        </div>
      )}
    </>
  );

  return { actions, dialogs, bars, say };
}
