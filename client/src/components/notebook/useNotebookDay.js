/**
 * One day's page, with the notebook's feel (Part N4, N6):
 *
 * - every change (add, tick, untick, edit, star, notes) shows at once and is
 *   sent in the background with its client key;
 * - a failed save shows "Not saved · Retry" on the line and keeps the text;
 *   a retry sends the same key, so it never makes a duplicate;
 * - offline, today's page keeps working from this device: changes are kept in
 *   order and sent once, in that order, when the connection is back. Until
 *   the server confirms, the page says "Saved on this device · will sync";
 * - undo (Ctrl/Cmd+Z or the Undo button) for the last 20 changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../state/AppState.jsx';
import { announceTodosChanged, newClientKey } from '../../lib/todos.js';
import { applyQueue, pushUndo, queueAdd, resolveTemp } from '../../lib/notebook.js';
import { deviceStore } from '../../lib/notebookDevice.js';

const OFFLINE = (e) => e && (e.status === 0 || e.status === undefined);

export function useNotebookDay(day = null) {
  const { user } = useAuth();
  const store = useMemo(() => (user ? deviceStore(user.id) : null), [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [offline, setOffline] = useState(false);
  const [sync, setSync] = useState({});
  const [notice, setNotice] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const queueRef = useRef([]);
  const pageRef = useRef(null);
  const flushing = useRef(false);
  pageRef.current = page;

  const setLine = useCallback((key, change) => {
    setPage((p) => p && ({
      ...p,
      carried: p.carried.map((i) => (i.key === key ? { ...i, ...change } : i)),
      items: p.items.map((i) => (i.key === key ? { ...i, ...change } : i)),
    }));
  }, []);
  const mark = useCallback((key, state) => setSync((s) => ({ ...s, [key]: state })), []);

  const saveQueue = useCallback(async (q) => { queueRef.current = q; await store?.set('queue', q); }, [store]);

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/todos/day/${day || 'today'}`);
      setOffline(false);
      setError(null);
      if (data.is_today && store) {
        await store.set('today', data);
        const q = (await store.get('queue')) || [];
        queueRef.current = q;
        setPage(q.length ? applyQueue(data, q) : data);
      } else setPage(data);
    } catch (e) {
      if (OFFLINE(e) && store) {
        const cached = await store.get('today');
        if (cached && (!day || day === cached.day)) {
          const q = (await store.get('queue')) || [];
          queueRef.current = q;
          setOffline(true);
          setPage(applyQueue(cached, q));
          return;
        }
      }
      setError(e);
    }
  }, [day, store]);

  useEffect(() => { setPage(null); load(); }, [load]);
  useEffect(() => {
    const on = () => load();
    window.addEventListener('taskflow:todos-changed', on);
    return () => window.removeEventListener('taskflow:todos-changed', on);
  }, [load]);

  /** Send one change to the server. */
  const send = useCallback(async (op) => {
    const [source, raw] = String(op.target).split(':');
    switch (op.kind) {
      case 'add': return api.post('/todos', { ...op.body, client_key: op.client_key });
      case 'tick':
        if (source === 'STEP') return api.patch(`/todos/steps/${raw}`, { done: op.body.done });
        return api.patch(`/todos/${raw}`, { done: op.body.done, changed_at: op.at });
      case 'edit': return api.patch(`/todos/${raw}`, { title: op.body.title, changed_at: op.at });
      case 'star': return api.patch(`/todos/${raw}`, { starred: op.body.starred });
      case 'remove': return api.del(`/todos/${raw}`);
      case 'note': return api.put(`/todos/notes/${op.body.day}`, { body: op.body.body });
      default: return null;
    }
  }, []);

  /** Changes kept on this device, sent once each, in order, when the connection is back. */
  const flush = useCallback(async () => {
    if (flushing.current || !queueRef.current.length) return;
    flushing.current = true;
    let changedElsewhere = false;
    let dropped = 0;
    try {
      while (queueRef.current.length) {
        const op = queueRef.current[0];
        if (String(op.target).startsWith('TMP:') && op.kind !== 'add') {
          // its add never reached the server: nothing to change
          await saveQueue(queueRef.current.slice(1));
          continue;
        }
        try {
          const r = await send(op);
          let rest = queueRef.current.slice(1);
          if (op.kind === 'add' && r?.todo) rest = resolveTemp(rest, op.target, r.todo.id);
          if (r?.stale) changedElsewhere = true;
          await saveQueue(rest);
        } catch (e) {
          if (OFFLINE(e)) break;
          // deleted on another device (or no longer allowed): the offline change is dropped
          dropped += 1;
          await saveQueue(queueRef.current.slice(1));
        }
      }
    } finally {
      flushing.current = false;
    }
    if (!queueRef.current.length) {
      setSync({});
      if (dropped) setNotice(`${dropped === 1 ? 'A line was' : `${dropped} lines were`} deleted on another device, so the change made here was dropped.`);
      else if (changedElsewhere) setNotice('Changed on another device · showing the latest');
      announceTodosChanged();
      await load();
    }
  }, [send, saveQueue, load]);

  useEffect(() => {
    const on = () => flush();
    window.addEventListener('online', on);
    const timer = setInterval(() => { if (navigator.onLine !== false) flush(); }, 20_000);
    return () => { window.removeEventListener('online', on); clearInterval(timer); };
  }, [flush]);
  useEffect(() => { if (page && navigator.onLine !== false && queueRef.current.length) flush(); }, [page?.day]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Do one change: show it now, send it, and on failure keep it (today's page,
   * offline) or offer Retry. Returns the server's answer when there is one.
   */
  const perform = useCallback(async (op, { quiet = false } = {}) => {
    const full = { ...op, at: op.at || new Date().toISOString() };
    mark(full.target, 'saving');
    try {
      const r = await send(full);
      mark(full.target, null);
      if (!quiet) announceTodosChanged();
      return r;
    } catch (e) {
      const p = pageRef.current;
      if (OFFLINE(e) && p?.is_today) {
        await saveQueue(queueAdd(queueRef.current, full));
        await store?.set('today', p);
        mark(full.target, 'local');
        setOffline(true);
        return null;
      }
      mark(full.target, { failed: true, op: full, message: OFFLINE(e) ? 'Not saved · Retry' : `Not saved: ${e.message} · Retry` });
      return null;
    }
  }, [send, mark, saveQueue, store]);

  const remember = useCallback((entry) => setUndoStack((s) => pushUndo(s, entry)), []);

  // ---------------------------------------------------------------- the changes

  const add = useCallback(async (title, extra = {}) => {
    const p = pageRef.current;
    const clientKey = newClientKey();
    const temp = `TMP:${clientKey}`;
    setPage((x) => x && ({
      ...x,
      items: [...x.items, { source: 'TODO', key: temp, id: null, title, done: false, planned_on: x.day, planned_time: null, position: 1e9, starred: false, created_at: new Date().toISOString(), link: null, stamp: null }],
      left: (x.left || 0) + 1,
    }));
    const r = await perform({ kind: 'add', target: temp, client_key: clientKey, body: { title, planned_on: p?.day || 'TODAY', ...extra } });
    if (r?.todo) {
      setPage((x) => x && ({ ...x, items: x.items.map((i) => (i.key === temp ? { ...r.todo, carried_from: null } : i)) }));
      remember({ label: `Added “${title}”`, run: () => removeLine({ ...r.todo }, { noUndo: true }) });
    }
    return r;
  }, [perform, remember]); // eslint-disable-line react-hooks/exhaustive-deps

  const tick = useCallback(async (item, done, { noUndo = false } = {}) => {
    setLine(item.key, { done });
    setPage((x) => x && ({ ...x, left: Math.max(0, (x.left || 0) + (done ? -1 : 1)), done_count: (x.done_count || 0) + (done ? 1 : -1) }));
    const r = await perform({ kind: 'tick', target: item.key, body: { done } });
    if (!noUndo) remember({ label: `${done ? 'Ticked' : 'Unticked'} “${item.title}”`, run: () => tick(item, !done, { noUndo: true }) });
    return r;
  }, [setLine, perform, remember]);

  const edit = useCallback(async (item, title, { noUndo = false } = {}) => {
    const before = item.title;
    if (!title.trim() || title === before) return null;
    setLine(item.key, { title });
    const r = await perform({ kind: 'edit', target: item.key, body: { title } });
    if (r?.stale) { setNotice(r.stale); setLine(item.key, { title: r.todo.title }); }
    if (!noUndo) remember({ label: `Changed “${before}”`, run: () => edit({ ...item, title }, before, { noUndo: true }) });
    return r;
  }, [setLine, perform, remember]);

  const star = useCallback(async (item, starred, { noUndo = false } = {}) => {
    setLine(item.key, { starred });
    const r = await perform({ kind: 'star', target: item.key, body: { starred } });
    if (!noUndo) remember({ label: starred ? `Starred “${item.title}”` : `Unstarred “${item.title}”`, run: () => star(item, !starred, { noUndo: true }) });
    return r;
  }, [setLine, perform, remember]);

  const removeLine = useCallback(async (item) => {
    setPage((x) => x && ({ ...x, items: x.items.filter((i) => i.key !== item.key), carried: x.carried.filter((i) => i.key !== item.key) }));
    return perform({ kind: 'remove', target: item.key, body: {} });
  }, [perform]);

  const saveNote = useCallback(async (body) => {
    const p = pageRef.current;
    if (!p) return null;
    setPage((x) => x && ({ ...x, note: { ...(x.note || {}), body } }));
    const r = await perform({ kind: 'note', target: `NOTE:${p.day}`, body: { day: p.day, body } }, { quiet: true });
    return r;
  }, [perform]);

  const retry = useCallback(async (key) => {
    const s = sync[key];
    if (!s?.op) return;
    const r = await perform(s.op);
    if (r?.todo && String(key).startsWith('TMP:')) setPage((x) => x && ({ ...x, items: x.items.map((i) => (i.key === key ? r.todo : i)) }));
  }, [sync, perform]);

  const undo = useCallback(async () => {
    const last = undoStack.at(-1);
    if (!last) return null;
    setUndoStack((s) => s.slice(0, -1));
    await last.run();
    return last.label;
  }, [undoStack]);

  return {
    page, error, offline, sync, notice, setNotice, load, setPage,
    add, tick, edit, star, removeLine, saveNote, retry, undo,
    undoLabel: undoStack.at(-1)?.label || null, pending: queueRef.current.length,
  };
}
