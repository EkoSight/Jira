import { useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Field, Icon, Modal } from './ui.jsx';
import { activityMeta } from '../lib/crm.js';
import { fromDateTimeLocal } from '../lib/format.js';

/**
 * Logging a touch on a deal. If it leaves a next step, the dialog offers to turn
 * that into a follow-up task then and there — pre-filled, owner defaulted, so it
 * is one tick rather than a separate errand.
 */
export default function LogActivityDialog({ account, type = 'NOTE', onClose, onSaved }) {
  const { user } = useAuth();
  const toast = useToast();
  const meta = activityMeta(type);

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [nextStepDue, setNextStepDue] = useState('');
  const [makeTask, setMakeTask] = useState(false);
  // a follow-up needs a deadline; three days out is the usual answer, and editable
  const [taskDue, setTaskDue] = useState(() =>
    new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  const meetingish = ['MEETING', 'CALL', 'DEMO', 'IN_PERSON', 'SUMMARY'].includes(type);

  const save = async () => {
    setSaving(true);
    try {
      let taskId = null;

      // the follow-up task is created first, then the activity records it —
      // matching how the offer reads: "log this, and here's the next task"
      if (makeTask && nextStep.trim()) {
        if (!taskDue) {
          toast.error('Give the follow-up task a deadline');
          setSaving(false);
          return;
        }
        if (!account.department_id) {
          toast.error('Set a department on the lead before creating a task for it');
          setSaving(false);
          return;
        }
        const { task } = await api.createTask({
          title: nextStep.trim(),
          department_id: account.department_id,
          assignee_id: account.owner_user_id || user.id,
          account_id: account.id,
          due_date: fromDateTimeLocal(`${taskDue}T17:00`),
        });
        taskId = task.id;
      }

      await api.logAccountActivity(account.id, {
        type,
        subject: subject.trim() || meta.label,
        body: body.trim() || null,
        next_step: nextStep.trim() || null,
        next_step_due: nextStepDue || null,
        task_id: taskId,
      });

      toast.success(taskId ? `${meta.label} logged, follow-up task created` : `${meta.label} logged`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        <span className="row" style={{ gap: 8 }}>
          <Icon name={meta.icon} size={16} /> Log: {meta.label}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Log it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">On <strong>{account.name}</strong></div>

        <Field label="Summary">
          <input className="input" value={subject} autoFocus onChange={(e) => setSubject(e.target.value)}
            placeholder={meetingish ? 'What was discussed in a line' : `${meta.label} — a short headline`} />
        </Field>

        <Field label={meetingish ? 'Notes / meeting summary' : 'Details'}>
          <textarea className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="What happened, what they said, where it stands." />
        </Field>

        <Field label="Next step" hint="The one thing that moves this deal forward next">
          <input className="input" value={nextStep} onChange={(e) => setNextStep(e.target.value)}
            placeholder="Send the proposal by Friday" />
        </Field>

        {nextStep.trim() && (
          <div className="alignment" style={{ gap: 10 }}>
            <label className="checklist-item" style={{ padding: 0 }}>
              <input type="checkbox" checked={makeTask} onChange={(e) => setMakeTask(e.target.checked)} />
              <span>Create a follow-up task for this, assigned to the lead's owner</span>
            </label>
            {makeTask && (
              <Field label="Due by">
                <input className="input" type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
              </Field>
            )}
            {!makeTask && (
              <Field label="Or just note it's due by">
                <input className="input" type="date" value={nextStepDue} onChange={(e) => setNextStepDue(e.target.value)} />
              </Field>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
