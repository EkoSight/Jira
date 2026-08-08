import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Field, Icon, Modal, Spinner } from './ui.jsx';
import { Attachments } from './TaskExtras.jsx';
import { completionPrompt } from '../lib/completion.js';
import { formatDate } from '../lib/format.js';

/**
 * The prompt shown whenever someone marks a task done. It asks — in words matched
 * to the kind of work and the person — for the outcome and any proof, and will not
 * complete the task until an outcome is written. Completing a recurring task also
 * confirms when the next one is due.
 *
 * Props:
 *   task            the task being completed (needs id, ref, title, task_type, priority, due_date, stage, recurrence)
 *   targetStatusId  the done-stage status to move it into
 *   onClose()       dismiss without completing
 *   onCompleted(result)  called after a successful completion
 */
export default function CompleteTaskDialog({ task, targetStatusId, onClose, onCompleted }) {
  const { user } = useAuth();
  const toast = useToast();

  const prompt = completionPrompt(task, user);
  const [note, setNote] = useState('');
  const [attachments, setAttachments] = useState(null);
  const [saving, setSaving] = useState(false);

  // load current attachments so proof can be added right here
  useEffect(() => {
    let cancelled = false;
    api
      .task(task.id)
      .then((data) => !cancelled && setAttachments(data.attachments))
      .catch(() => !cancelled && setAttachments([]));
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  const complete = async () => {
    if (note.trim().length < 3) return toast.error('Please describe the outcome first');
    setSaving(true);
    try {
      const result = await api.moveTask(task.id, {
        status_id: targetStatusId,
        completion_note: note.trim(),
      });
      if (result.next_occurrence) {
        toast.success(
          `Done. Next one (${result.next_occurrence.ref}) is due ${formatDate(result.next_occurrence.due_date)}.`,
        );
      } else {
        toast.success(`${task.ref} marked done`);
      }
      onCompleted?.(result);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        Not yet
      </button>
      <button type="button" className="btn btn-primary" onClick={complete} disabled={saving || note.trim().length < 3}>
        {saving ? 'Completing…' : 'Mark done'}
      </button>
    </>
  );

  return (
    <Modal
      title={
        <div className="row" style={{ gap: 8 }}>
          <Icon name="check" />
          <span>{prompt.heading}</span>
        </div>
      }
      onClose={onClose}
      footer={footer}
    >
      <div className="stack">
        <div className={`complete-intro complete-${prompt.tone}`}>
          <p style={{ margin: 0 }}>{prompt.intro}</p>
        </div>

        <Field label={prompt.ask}>
          <textarea
            className="textarea"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={prompt.placeholder}
            autoFocus
          />
        </Field>

        <div className="row small muted" style={{ gap: 6 }}>
          <Icon name="paperclip" size={13} />
          <span>{prompt.proof}</span>
        </div>

        {attachments === null ? (
          <Spinner label="Loading attachments" />
        ) : (
          <Attachments
            taskId={task.id}
            attachments={attachments}
            canEdit
            onChange={setAttachments}
          />
        )}
      </div>
    </Modal>
  );
}
