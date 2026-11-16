/**
 * "Add a to-do": one line, Enter saves. Minimum input: the words.
 *
 * - Pasting several lines asks once ("Add 6 to-dos?") and adds them in order.
 * - The only thing read from the words is a task reference ("WS-12 …"), shown
 *   as a removable chip before saving. No dates are guessed.
 * - Every add carries a client key, kept until it is saved, so a double tap or
 *   a retry makes one to-do.
 * - A failed save keeps the words: "Not saved: you're offline".
 * - After saving, small chips offer Today · Tomorrow · Pick a day · Link…
 */
import { useEffect, useId, useRef, useState } from 'react';
import { DayDialog, LinkPicker } from './Pickers.jsx';
import { announceTodosChanged, newClientKey, splitLines, todoApi } from '../../lib/todos.js';

const REF_HINT = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/;

export default function AddTodo({
  day = null, listId = null, link = null, shared = false, shareWords = null,
  placeholder = 'Add a to-do', onAdded, autoFocus = false, label = 'Add a to-do', today = null, inputRef = null,
}) {
  const [text, setText] = useState('');
  const [chip, setChip] = useState(null);
  const [ignoreRef, setIgnoreRef] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [pasted, setPasted] = useState(null);
  const [last, setLast] = useState(null);
  const [dialog, setDialog] = useState(null);
  const key = useRef(newClientKey());
  const ownRef = useRef(null);
  const input = inputRef || ownRef;
  const hintId = useId();

  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus, input]);

  // the typed task reference, checked against what this person can see
  useEffect(() => {
    if (link || ignoreRef || !REF_HINT.test(text)) { setChip(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      todoApi.parse(text).then((r) => alive && setChip(r.ref)).catch(() => alive && setChip(null));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [text, link, ignoreRef]);

  const base = () => ({
    planned_on: day, list_id: listId || undefined,
    ...(link ? { link_type: link.type, link_id: link.id, shared } : {}),
    ...(ignoreRef ? { read_ref: false } : {}),
  });

  const fail = (e) => setError(e.status === 0 ? 'Not saved: you’re offline. Your words are kept; press Enter to try again.' : e.message);

  const save = async () => {
    const words = text.trim();
    if (!words || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await todoApi.add({ ...base(), title: words, client_key: key.current });
      key.current = newClientKey();
      setText('');
      setChip(null);
      setIgnoreRef(false);
      setLast(result.todo || null);
      announceTodosChanged();
      onAdded?.(result);
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  const saveMany = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await todoApi.addMany({ ...base(), lines: pasted, client_key: key.current });
      key.current = newClientKey();
      setPasted(null);
      setText('');
      setLast(null);
      announceTodosChanged();
      onAdded?.(result);
    } catch (e) { fail(e); } finally { setSaving(false); }
  };

  const onPaste = (e) => {
    const lines = splitLines(e.clipboardData?.getData('text') || '');
    if (lines.length > 1) { e.preventDefault(); setPasted(lines.slice(0, 50)); }
  };

  const changeLast = async (body) => {
    try {
      const r = await todoApi.change(last.id, body);
      setLast(r.todo);
      announceTodosChanged();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="td-add">
      <form className="td-add-row" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="sr-only" htmlFor={`${hintId}-in`}>{label}</label>
        <input
          id={`${hintId}-in`} ref={input} className="input td-add-input" value={text} maxLength={200}
          placeholder={placeholder} onChange={(e) => { setText(e.target.value); setError(null); }}
          onPaste={onPaste} aria-describedby={`${hintId}-hint`} enterKeyHint="done" autoComplete="off"
        />
        <button type="submit" className="btn btn-primary td-add-btn" disabled={!text.trim() || saving}>{saving ? 'Adding…' : 'Add'}</button>
      </form>
      <div id={`${hintId}-hint`} className="td-add-hint small muted">
        {shared && link ? (shareWords || `People who can see ${link.label} will see this.`) : 'Enter adds it. Paste a list to add each line.'}
      </div>
      {chip && (
        <div className="td-chips" aria-live="polite">
          {chip.task ? (
            <span className="td-chip td-chip-ref">
              Links to {chip.task.ref} {chip.task.title} (private)
              <button type="button" className="td-chip-x" aria-label={`Don't link to ${chip.task.ref}`} onClick={() => setIgnoreRef(true)}>×</button>
            </span>
          ) : <span className="td-chip">{chip.note}</span>}
        </div>
      )}
      {pasted && (
        <div className="td-confirm" role="group" aria-label="Add several to-dos">
          <span>Add {pasted.length} to-dos?</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={saveMany} disabled={saving}>Add {pasted.length}</button>
          <button type="button" className="btn btn-sm" onClick={() => setPasted(null)}>Cancel</button>
        </div>
      )}
      {error && <div className="td-error small" role="alert">{error}</div>}
      {last && !last.shared && (
        <div className="td-chips" aria-label={`Added “${last.title}”`}>
          <span className="small muted">Added. Optional:</span>
          <button type="button" className="td-chip td-chip-btn" onClick={() => changeLast({ planned_on: 'TODAY' })} aria-pressed={last.planned_on === today}>Today</button>
          <button type="button" className="td-chip td-chip-btn" onClick={() => changeLast({ planned_on: 'TOMORROW' })}>Tomorrow</button>
          <button type="button" className="td-chip td-chip-btn" onClick={() => setDialog('day')}>Pick a day</button>
          <button type="button" className="td-chip td-chip-btn" onClick={() => setDialog('link')}>{last.link ? `Linked: ${last.link.label}` : 'Link…'}</button>
        </div>
      )}
      {dialog === 'day' && (
        <DayDialog value={last?.planned_on} today={today} onClose={() => setDialog(null)} onPick={(d) => { setDialog(null); changeLast({ planned_on: d }); }} />
      )}
      {dialog === 'link' && (
        <LinkPicker current={last?.link} onClose={() => setDialog(null)} onPick={(l) => { setDialog(null); changeLast({ link: l ? { type: l.type, id: l.id } : null }); }} />
      )}
    </div>
  );
}
