import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { EmptyState, Icon, Spinner } from '../components/ui.jsx';
import { relativeTime } from '../lib/format.js';

const COLORS = ['#fef3c7', '#dbeafe', '#dcfce7', '#fce7f3', '#ede9fe', '#f1f5f9'];

/**
 * A private scratchpad. Nothing here is shared — it is for the half-formed
 * things you want to look back at, not for the board.
 */
export default function Notes() {
  const toast = useToast();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '', color: COLORS[0] });
  const [editing, setEditing] = useState(null);

  const load = () => {
    setLoading(true);
    api
      .notes({ search: search || undefined, archived: showArchived ? 'true' : undefined })
      .then((data) => setNotes(data.notes))
      .catch((err) => toast.error(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, [search, showArchived]);

  const create = async () => {
    if (!draft.title.trim() && !draft.body.trim()) return;
    try {
      await api.createNote({ title: draft.title.trim(), body: draft.body.trim(), color: draft.color });
      setDraft({ title: '', body: '', color: COLORS[0] });
      load();
    } catch (err) {
      toast.error(err);
    }
  };

  const update = async (id, changes) => {
    try {
      await api.updateNote(id, changes);
      load();
    } catch (err) {
      toast.error(err);
    }
  };

  const remove = async (id) => {
    try {
      await api.deleteNote(id);
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    await update(editing.id, { title: editing.title, body: editing.body, color: editing.color });
    setEditing(null);
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between wrap">
        <div>
          <h1>My notes</h1>
          <div className="small muted">
            Private to you — jot down what you are not sure about yet and come back to it.
          </div>
        </div>
        <div className="filters">
          <input
            className="input"
            placeholder="Search notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="row small dim" style={{ gap: 6 }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Archived
          </label>
        </div>
      </div>

      {!showArchived && (
        <section className="card card-pad stack-sm">
          <input
            className="input"
            placeholder="Note title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
          <textarea
            className="textarea"
            rows={3}
            placeholder="Write anything — a reminder, a number to check, a half-formed idea…"
            value={draft.body}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />
          <div className="row-between wrap">
            <div className="row" style={{ gap: 5 }}>
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, color }))}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background: color,
                    border: draft.color === color ? '2px solid var(--ink)' : '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                  aria-label={`Use colour ${color}`}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={create}
              disabled={!draft.title.trim() && !draft.body.trim()}
            >
              <Icon name="plus" size={14} /> Save note
            </button>
          </div>
        </section>
      )}

      {loading && notes.length === 0 ? (
        <Spinner label="Loading your notes" />
      ) : notes.length === 0 ? (
        <EmptyState title={showArchived ? 'Nothing archived' : 'No notes yet'}>
          {showArchived ? 'Notes you archive show up here.' : 'Anything you write above stays private to your account.'}
        </EmptyState>
      ) : (
        <div className="note-grid">
          {notes.map((note) => (
            <article key={note.id} className="note" style={{ background: note.color }}>
              <div className="row-between">
                <strong className="grow truncate">{note.title || 'Untitled'}</strong>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => update(note.id, { is_pinned: !note.is_pinned })}
                  title={note.is_pinned ? 'Unpin' : 'Pin to the top'}
                  style={{ color: note.is_pinned ? 'var(--critical)' : 'inherit' }}
                >
                  <Icon name="flag" size={14} />
                </button>
              </div>

              <p className="note-body">{note.body}</p>

              {note.task_ref && <span className="task-ref">{note.task_ref}</span>}

              <div className="row-between" style={{ marginTop: 'auto' }}>
                <span className="small" style={{ opacity: 0.65 }}>{relativeTime(note.updated_at)}</span>
                <div className="row" style={{ gap: 2 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(note)} title="Edit">
                    <Icon name="edit" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => update(note.id, { is_archived: !note.is_archived })}
                    title={note.is_archived ? 'Restore' : 'Archive'}
                  >
                    <Icon name={note.is_archived ? 'check' : 'trash'} size={13} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal">
            <div className="modal-head">
              <h2 className="grow">Edit note</h2>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setEditing(null)}>
                <Icon name="close" />
              </button>
            </div>
            <div className="modal-body stack">
              <input
                className="input"
                value={editing.title}
                onChange={(e) => setEditing((n) => ({ ...n, title: e.target.value }))}
                placeholder="Title"
              />
              <textarea
                className="textarea"
                rows={10}
                value={editing.body}
                onChange={(e) => setEditing((n) => ({ ...n, body: e.target.value }))}
              />
              <div className="row" style={{ gap: 5 }}>
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setEditing((n) => ({ ...n, color }))}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      background: color,
                      border: editing.color === color ? '2px solid var(--ink)' : '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                    aria-label={`Use colour ${color}`}
                  />
                ))}
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-danger" onClick={() => remove(editing.id)}>
                Delete
              </button>
              <span className="grow" />
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={saveEdit}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
