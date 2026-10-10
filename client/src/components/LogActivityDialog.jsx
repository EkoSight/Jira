import { useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Field, Icon, Modal } from './ui.jsx';
import { NextActionFields, nextActionBody, nextActionDraft, nextActionProblem } from './DealParts.jsx';
import { activityMeta } from '../lib/crm.js';
import { fromDateTimeLocal } from '../lib/format.js';

/**
 * Logging a touch on a deal.
 *
 * It asks which way it went, because "we emailed them" and "they emailed us"
 * are different facts: one is chasing, the other is the customer responding.
 * An internal note is said to be internal, so it can never read as contact.
 *
 * If it leaves a next step, that becomes the deal's next action — what, who and
 * by when — and the dialog can turn it into a follow-up task in the same step.
 */

const TWO_WAY = new Set(['CALL', 'MEETING', 'DEMO', 'IN_PERSON']);

/** The directions that make sense for each kind of touch, and what each means. */
function directionsFor(type) {
  if (type === 'NOTE' || type === 'SUMMARY') {
    return [['INTERNAL', 'Internal — for our side only'], ['INBOUND', 'Something they told us'], ['OUTBOUND', 'Something we told them']];
  }
  if (TWO_WAY.has(type)) {
    return [['OUTBOUND', 'We reached out'], ['INBOUND', 'They reached out to us'], ['INTERNAL', 'Internal, without them']];
  }
  return [['OUTBOUND', 'We sent it'], ['INBOUND', 'They sent it to us'], ['INTERNAL', 'Internal, without them']];
}

/** What came of it, by direction — sending is not being answered. */
function outcomesFor(type, direction) {
  if (direction === 'INTERNAL') return [['NOTED', 'Noted']];
  if (direction === 'INBOUND') return [['RECEIVED', 'Received from them'], ...(TWO_WAY.has(type) ? [['COMPLETED', 'It took place']] : [])];
  if (TWO_WAY.has(type)) return [['COMPLETED', 'It took place'], ['ATTEMPTED', 'Tried, did not connect']];
  return [['SENT', 'Sent'], ['ATTEMPTED', 'Tried, did not go through']];
}

export default function LogActivityDialog({ account, opportunities = [], type = 'NOTE', onClose, onSaved }) {
  const { user } = useAuth();
  const toast = useToast();
  const meta = activityMeta(type);
  const liveDeals = opportunities.filter((o) => ['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(o.status));
  const primary = liveDeals.find((o) => o.id === account.primary_opportunity_id) || liveDeals[0] || null;

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [direction, setDirection] = useState(() => directionsFor(type)[0][0]);
  const [outcome, setOutcome] = useState(() => outcomesFor(type, directionsFor(type)[0][0])[0][0]);
  const [dealId, setDealId] = useState(primary ? String(primary.id) : '');
  const [when, setWhen] = useState('');
  const [withNext, setWithNext] = useState(false);
  const [next, setNext] = useState(() => nextActionDraft(primary, user?.id));
  const [nextError, setNextError] = useState(null);
  const [makeTask, setMakeTask] = useState(false);
  const [saving, setSaving] = useState(false);

  const deal = liveDeals.find((o) => String(o.id) === dealId) || null;
  const meetingish = TWO_WAY.has(type) || type === 'SUMMARY';

  const pickDirection = (value) => {
    setDirection(value);
    setOutcome(outcomesFor(type, value)[0][0]);
  };

  const pickDeal = (value) => {
    setDealId(value);
    const chosen = liveDeals.find((o) => String(o.id) === value);
    setNext(nextActionDraft(chosen, user?.id));
  };

  const save = async () => {
    if (withNext) {
      const problem = nextActionProblem(next);
      setNextError(problem);
      if (problem) return undefined;
    }
    setSaving(true);
    try {
      let taskId = null;

      // the follow-up task is created first, then the activity records it —
      // matching how the offer reads: "log this, and here's the next task"
      if (withNext && makeTask) {
        if (!account.department_id) {
          toast.error('Set a department on the organization before creating a task for it');
          setSaving(false);
          return undefined;
        }
        const { task } = await api.createTask({
          title: next.next_step.trim(),
          department_id: account.department_id,
          assignee_id: Number(next.next_step_owner_id),
          account_id: account.id,
          opportunity_id: deal?.id ?? undefined,
          due_date: fromDateTimeLocal(`${next.next_step_due}T17:00`),
        });
        taskId = task.id;
      }

      await api.logAccountActivity(account.id, {
        type,
        subject: subject.trim() || meta.label,
        body: body.trim() || null,
        direction,
        outcome,
        opportunity_id: deal?.id ?? null,
        occurred_at: when ? fromDateTimeLocal(when) : null,
        task_id: taskId,
        ...(withNext ? nextActionBody(next) : {}),
      });

      toast.success(taskId ? `${meta.label} logged, next action set, follow-up task created`
        : withNext ? `${meta.label} logged, next action set` : `${meta.label} logged`);
      onSaved();
      onClose();
    } catch (err) {
      if (err.details?.code === 'NEXT_ACTION_INVALID') setNextError(err.message);
      toast.error(err);
    } finally {
      setSaving(false);
    }
    return undefined;
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

        <div className="grid-2">
          <Field label="Which way?" hint="Hearing from them and chasing them are different facts">
            <select className="select" value={direction} onChange={(e) => pickDirection(e.target.value)}>
              {directionsFor(type).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="What came of it?">
            <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}
              disabled={direction === 'INTERNAL'}>
              {outcomesFor(type, direction).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>

        {liveDeals.length > 1 && (
          <Field label="Which deal was it about?">
            <select className="select" value={dealId} onChange={(e) => pickDeal(e.target.value)}>
              {liveDeals.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              <option value="">The organization in general</option>
            </select>
          </Field>
        )}

        <Field label="Summary">
          <input className="input" value={subject} autoFocus onChange={(e) => setSubject(e.target.value)}
            placeholder={meetingish ? 'What was discussed in a line' : `${meta.label} — a short headline`} />
        </Field>

        <Field label={meetingish ? 'Notes / meeting summary' : 'Details'}>
          <textarea className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="What happened, what they said, where it stands." />
        </Field>

        <Field label="When did it happen?" hint="Leave blank for now. Logging it late does not make it new.">
          <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>

        {deal ? (
          <div className="alignment" style={{ gap: 10 }}>
            <label className="checklist-item" style={{ padding: 0 }}>
              <input type="checkbox" checked={withNext} onChange={(e) => setWithNext(e.target.checked)} />
              <span>This changes what happens next on {deal.name}</span>
            </label>
            {withNext && (
              <>
                <NextActionFields value={next} onChange={(v) => { setNext(v); setNextError(null); }} error={nextError} />
                <label className="checklist-item" style={{ padding: 0 }}>
                  <input type="checkbox" checked={makeTask} onChange={(e) => setMakeTask(e.target.checked)} />
                  <span>Also create it as a task for whoever owes it</span>
                </label>
              </>
            )}
          </div>
        ) : (
          <div className="small muted">No live deal is picked, so this does not change any next action.</div>
        )}
      </div>
    </Modal>
  );
}
