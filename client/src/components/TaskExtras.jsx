import { useEffect, useState } from 'react';
import { api, fetchBlobUrl } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, Icon } from './ui.jsx';
import { PRIORITY_TONE, PRIORITY_LABEL, dueLabel } from '../lib/format.js';

const PROVIDER_LABEL = {
  'google-docs': 'Google Doc',
  'google-sheets': 'Google Sheet',
  'google-slides': 'Google Slides',
  'google-forms': 'Google Form',
  'google-drive': 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  notion: 'Notion',
  figma: 'Figma',
  github: 'GitHub',
  link: 'Link',
};

const PROVIDER_COLOR = {
  'google-docs': '#2a78d6',
  'google-sheets': '#1baf7a',
  'google-slides': '#eda100',
  'google-forms': '#4a3aa7',
  'google-drive': '#eb6834',
};

/** Renders a protected image by fetching it with the caller's token. */
function AuthedImage({ src, alt }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl;
    let cancelled = false;
    fetchBlobUrl(src)
      .then((result) => {
        if (cancelled) return URL.revokeObjectURL(result);
        objectUrl = result;
        setUrl(result);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) return <div className="empty small">Could not load this image</div>;
  if (!url) return <div className="attachment-thumb center"><span className="spinner" /></div>;
  return <img className="attachment-thumb" src={url} alt={alt} />;
}

export function Attachments({ taskId, attachments, onChange, canEdit }) {
  const toast = useToast();
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  const addLink = async () => {
    if (!linkUrl.trim()) return;
    setBusy(true);
    try {
      const { attachment } = await api.addTaskLink(taskId, linkUrl.trim(), linkTitle.trim() || undefined);
      onChange([...attachments, attachment]);
      setLinkUrl('');
      setLinkTitle('');
      toast.success('Link attached');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const { attachment } = await api.uploadTaskFile(taskId, file);
      onChange([...attachments, attachment]);
      toast.success(`${file.name} attached`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (attachment) => {
    try {
      await api.deleteAttachment(taskId, attachment.id);
      onChange(attachments.filter((a) => a.id !== attachment.id));
    } catch (err) {
      toast.error(err);
    }
  };

  const images = attachments.filter((a) => a.kind === 'image');
  const others = attachments.filter((a) => a.kind !== 'image');

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <h3>Links & files</h3>
        <span className="small muted">{attachments.length}</span>
      </div>

      {images.length > 0 && (
        <div className="attachment-grid">
          {images.map((attachment) => (
            <figure key={attachment.id} className="attachment">
              <button
                type="button"
                onClick={() => setPreview(attachment)}
                style={{ border: 0, background: 'none', padding: 0, cursor: 'zoom-in' }}
                title="View full size"
              >
                <AuthedImage src={api.attachmentUrl(taskId, attachment.id)} alt={attachment.title || 'Attachment'} />
              </button>
              <figcaption className="row" style={{ gap: 4 }}>
                <span className="small truncate grow">{attachment.title || attachment.file_name}</span>
                {canEdit && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(attachment)} aria-label="Remove">
                    <Icon name="close" size={12} />
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {others.map((attachment) => (
        <div key={attachment.id} className="row" style={{ gap: 8 }}>
          <Icon name={attachment.kind === 'link' ? 'link' : 'paperclip'} size={14} />
          {attachment.kind === 'link' ? (
            <a
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              className="grow truncate"
              style={{ color: 'var(--brand-ink)', fontWeight: 550 }}
            >
              {attachment.title || attachment.url}
            </a>
          ) : (
            <button
              type="button"
              className="grow truncate"
              style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', color: 'var(--brand-ink)', fontWeight: 550 }}
              onClick={async () => {
                try {
                  window.open(await fetchBlobUrl(api.attachmentUrl(taskId, attachment.id)), '_blank');
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              {attachment.title || attachment.file_name}
            </button>
          )}
          {attachment.provider && attachment.provider !== 'link' && (
            <Badge dot={PROVIDER_COLOR[attachment.provider]}>{PROVIDER_LABEL[attachment.provider]}</Badge>
          )}
          {canEdit && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(attachment)} aria-label="Remove">
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      ))}

      {attachments.length === 0 && (
        <div className="small muted">
          Paste a Google Doc, Sheet or Slides link, or attach an image or PDF.
        </div>
      )}

      {canEdit && (
        <>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input grow"
              placeholder="Paste a link — Google Docs, Sheets, Slides, Drive…"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addLink()}
            />
            <input
              className="input"
              style={{ maxWidth: 150 }}
              placeholder="Label (optional)"
              value={linkTitle}
              onChange={(e) => setLinkTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addLink()}
            />
            <button type="button" className="btn" onClick={addLink} disabled={busy || !linkUrl.trim()}>
              Add
            </button>
          </div>

          <label className="btn btn-sm" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
            <Icon name="image" size={14} />
            {busy ? 'Uploading…' : 'Attach an image or file'}
            <input
              type="file"
              hidden
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt"
              onChange={(e) => {
                uploadFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        </>
      )}

      {preview && (
        <div className="modal-backdrop" onMouseDown={() => setPreview(null)} style={{ zIndex: 300, cursor: 'zoom-out' }}>
          <AuthedImage src={api.attachmentUrl(taskId, preview.id)} alt={preview.title || 'Attachment'} />
        </div>
      )}
    </div>
  );
}

/**
 * The same links-and-files panel, for a task that does not exist yet.
 * Everything is held in the browser and sent as soon as the card is created.
 */
export function PendingAttachments({ pending, onChange }) {
  const toast = useToast();
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');

  const addLink = () => {
    const url = linkUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      return toast.error('Links must start with http:// or https://');
    }
    onChange([...pending, { type: 'link', url, title: linkTitle.trim() || undefined }]);
    setLinkUrl('');
    setLinkTitle('');
  };

  const addFiles = (files) => {
    const additions = [...files].map((file) => ({ type: 'file', file }));
    onChange([...pending, ...additions]);
  };

  const remove = (index) => onChange(pending.filter((_, i) => i !== index));

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <h3>Links & files</h3>
        {pending.length > 0 && (
          <span className="small muted">{pending.length} will be attached on save</span>
        )}
      </div>

      {pending.map((item, index) => (
        <div key={`${item.type}-${index}`} className="row" style={{ gap: 8 }}>
          <Icon name={item.type === 'link' ? 'link' : 'paperclip'} size={14} />
          <span className="grow truncate">{item.title || item.url || item.file.name}</span>
          {item.type === 'link' && (
            <Badge dot={PROVIDER_COLOR[detectProviderClientSide(item.url)]}>
              {PROVIDER_LABEL[detectProviderClientSide(item.url)]}
            </Badge>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(index)} aria-label="Remove">
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}

      {pending.length === 0 && (
        <div className="small muted">
          Paste a Google Doc, Sheet or Slides link, or attach an image or PDF. They are added when you create the task.
        </div>
      )}

      <div className="row" style={{ gap: 6 }}>
        <input
          className="input grow"
          placeholder="Paste a link — Google Docs, Sheets, Slides, Drive…"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addLink();
            }
          }}
        />
        <input
          className="input"
          style={{ maxWidth: 150 }}
          placeholder="Label (optional)"
          value={linkTitle}
          onChange={(e) => setLinkTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addLink();
            }
          }}
        />
        <button type="button" className="btn" onClick={addLink} disabled={!linkUrl.trim()}>
          Add
        </button>
      </div>

      <label className="btn btn-sm" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
        <Icon name="image" size={14} />
        Attach an image or file
        <input
          type="file"
          hidden
          multiple
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt"
          onChange={(e) => {
            addFiles(e.target.files || []);
            e.target.value = '';
          }}
        />
      </label>
    </div>
  );
}

/** Mirrors the server's provider detection so the staged list looks the same. */
function detectProviderClientSide(url = '') {
  if (/docs\.google\.com\/document/i.test(url)) return 'google-docs';
  if (/docs\.google\.com\/spreadsheets/i.test(url)) return 'google-sheets';
  if (/docs\.google\.com\/presentation/i.test(url)) return 'google-slides';
  if (/docs\.google\.com\/forms/i.test(url)) return 'google-forms';
  if (/drive\.google\.com/i.test(url)) return 'google-drive';
  if (/dropbox\.com/i.test(url)) return 'dropbox';
  if (/sharepoint\.com|onedrive\.live\.com/i.test(url)) return 'onedrive';
  if (/notion\.so/i.test(url)) return 'notion';
  if (/figma\.com/i.test(url)) return 'figma';
  if (/github\.com/i.test(url)) return 'github';
  return 'link';
}

/**
 * Uploads everything staged during creation. Returns how many failed so the
 * caller can say so rather than silently dropping an attachment.
 */
export async function flushPendingAttachments(taskId, pending) {
  let failed = 0;
  for (const item of pending) {
    try {
      if (item.type === 'link') await api.addTaskLink(taskId, item.url, item.title);
      else await api.uploadTaskFile(taskId, item.file, item.title);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

/** People tagged on the card — they can see it whatever department they are in. */
export function Collaborators({ taskId, collaborators, onChange, canEdit }) {
  const { users } = useRefData();
  const toast = useToast();
  const [adding, setAdding] = useState('');

  const add = async (userId) => {
    if (!userId) return;
    try {
      const { collaborators: updated } = await api.addCollaborator(taskId, Number(userId));
      onChange(updated);
      setAdding('');
      toast.success('Tagged — they can now see this task');
    } catch (err) {
      toast.error(err);
    }
  };

  const remove = async (userId) => {
    try {
      await api.removeCollaborator(taskId, userId);
      onChange(collaborators.filter((c) => c.id !== userId));
    } catch (err) {
      toast.error(err);
    }
  };

  const taggable = users.filter((u) => !collaborators.some((c) => c.id === u.id));

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <h3>Tagged people</h3>
        <span className="small muted">see it across departments</span>
      </div>

      {collaborators.length === 0 && (
        <div className="small muted">
          Tag someone from another team and this card appears for them too.
        </div>
      )}

      <div className="row wrap" style={{ gap: 6 }}>
        {collaborators.map((person) => (
          <span key={person.id} className="badge" style={{ height: 26, paddingLeft: 3 }}>
            <Avatar name={person.full_name} color={person.avatar_color} size={20} />
            {person.full_name}
            {person.department_name && <span className="muted">· {person.department_name}</span>}
            {canEdit && (
              <button
                type="button"
                onClick={() => remove(person.id)}
                style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
                aria-label={`Remove ${person.full_name}`}
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </span>
        ))}
      </div>

      {canEdit && (
        <select className="select" value={adding} onChange={(e) => add(e.target.value)}>
          <option value="">Tag someone…</option>
          {taggable.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name}
              {u.department_name ? ` · ${u.department_name}` : ''}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Tagging on a card that does not exist yet — sent with the create request. */
export function PendingCollaborators({ selected, onChange }) {
  const { users } = useRefData();
  const [adding, setAdding] = useState('');

  const chosen = users.filter((u) => selected.includes(u.id));
  const available = users.filter((u) => !selected.includes(u.id));

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <h3>Tagged people</h3>
        <span className="small muted">see it across departments</span>
      </div>

      {chosen.length === 0 && (
        <div className="small muted">
          Tag someone from another team and this card appears for them too.
        </div>
      )}

      <div className="row wrap" style={{ gap: 6 }}>
        {chosen.map((person) => (
          <span key={person.id} className="badge" style={{ height: 26, paddingLeft: 3 }}>
            <Avatar name={person.full_name} color={person.avatar_color} size={20} />
            {person.full_name}
            {person.department_name && <span className="muted">· {person.department_name}</span>}
            <button
              type="button"
              onClick={() => onChange(selected.filter((id) => id !== person.id))}
              style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
              aria-label={`Remove ${person.full_name}`}
            >
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
      </div>

      <select
        className="select"
        value={adding}
        onChange={(e) => {
          if (e.target.value) onChange([...selected, Number(e.target.value)]);
          setAdding('');
        }}
      >
        <option value="">Tag someone…</option>
        {available.map((u) => (
          <option key={u.id} value={u.id}>
            {u.full_name}
            {u.department_name ? ` · ${u.department_name}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Sub tasks — real cards, whose completion drives the parent's progress. */
export function Subtasks({ task, subtasks, onOpen, onChanged, canEdit }) {
  const { statuses } = useRefData();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.createTask({
        title: title.trim(),
        department_id: task.department_id,
        parent_task_id: task.id,
        assignee_id: task.assignee_id,
        priority: task.priority,
      });
      setTitle('');
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (subtask) => {
    const done = statuses.find((s) => s.stage === 'done');
    const todo = statuses.find((s) => s.stage === 'todo') || statuses[0];
    const target = subtask.stage === 'done' ? todo : done;
    if (!target) return toast.error('No suitable status is configured');
    try {
      await api.moveTask(subtask.id, { status_id: target.id });
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const doneCount = subtasks.filter((s) => s.stage === 'done').length;
  const percent = subtasks.length ? Math.round((doneCount / subtasks.length) * 100) : 0;

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <h3>Sub tasks</h3>
        {subtasks.length > 0 && (
          <span className="small muted tnum">
            {doneCount}/{subtasks.length} · {percent}% of this task
          </span>
        )}
      </div>

      {subtasks.length > 0 && (
        <div className="progress-track" style={{ height: 6 }}>
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}

      {subtasks.length === 0 && (
        <div className="small muted">
          Break this down into steps. Each one is a real card, and finishing them moves this task's progress.
        </div>
      )}

      {subtasks.map((subtask) => (
        <div key={subtask.id} className={`checklist-item ${subtask.stage === 'done' ? 'done' : ''}`}>
          <input
            type="checkbox"
            checked={subtask.stage === 'done'}
            onChange={() => toggle(subtask)}
            disabled={!canEdit}
            aria-label={`Mark ${subtask.ref} done`}
          />
          <button
            type="button"
            className="grow truncate"
            style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }}
            onClick={() => onOpen(subtask.id)}
          >
            <span className="task-ref">{subtask.ref}</span> <span>{subtask.title}</span>
          </button>
          {subtask.due_date && <Badge tone={dueLabel(subtask.due_date, { done: subtask.stage === 'done' }).tone}>
            {dueLabel(subtask.due_date, { done: subtask.stage === 'done' }).text}
          </Badge>}
          {subtask.assignee_name && <Avatar name={subtask.assignee_name} color={subtask.assignee_color} size={20} />}
        </div>
      ))}

      {canEdit && (
        <div className="row">
          <input
            className="input"
            placeholder="Add a sub task…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button type="button" className="btn" onClick={add} disabled={busy || !title.trim()}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

export { PROVIDER_LABEL };
