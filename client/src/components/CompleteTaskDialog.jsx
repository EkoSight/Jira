import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Field, Icon, Modal, Spinner } from './ui.jsx';
import { Attachments } from './TaskExtras.jsx';
import { NextActionFields, nextActionDraft, nextActionProblem } from './DealParts.jsx';
import { completionPrompt, outcomeProblem, readsLikeAPlan } from '../lib/completion.js';
import { formatDate } from '../lib/format.js';

/**
 * The prompt shown whenever someone marks a task done. It asks — in words matched
 * to the kind of work and the person — for the outcome and any proof, and will not
 * complete the task until an outcome is written. Completing a recurring task also
 * confirms when the next one is due.
 *
 * Work on a lead or a deal asks for more, because it is part of the pipeline's
 * record: whether it achieved what the task asked, a link to the evidence, and —
 * when finishing it would leave the deal with nothing agreed next — the next
 * step. "Will send samples" is not "tested the samples": that is progress, and
 * the prompt offers to record it as progress with the task kept open.
 *
 * Props:
 *   task            the task being completed (needs id, ref, title, task_type, priority, due_date, stage, recurrence)
 *   targetStatusId  the done-stage status to move it into
 *   onClose()       dismiss without completing
 *   onCompleted(result)  called after a successful completion (or after progress was recorded)
 */
export default function CompleteTaskDialog({ task, targetStatusId, onClose, onCompleted }) {
  const { user } = useAuth();
  const toast = useToast();

  const prompt = completionPrompt(task, user);
  const [note, setNote] = useState('');
  const [attachments, setAttachments] = useState(null);
  const [context, setContext] = useState(null);
  const [result, setResult] = useState('ACHIEVED');
  const [evidence, setEvidence] = useState('');
  const [dealId, setDealId] = useState('');
  const [next, setNext] = useState(() => nextActionDraft(null, user?.id));
  const [nextError, setNextError] = useState(null);
  const [confirmPlan, setConfirmPlan] = useState(false);
  const [planRefused, setPlanRefused] = useState(false);
  // offering a new next step when the deal does not strictly need one
  const [giveNext, setGiveNext] = useState(false);
  const [saving, setSaving] = useState(false);

  // load current attachments so proof can be added right here, and what this
  // task's completion should ask
  useEffect(() => {
    let cancelled = false;
    api
      .task(task.id)
      .then((data) => !cancelled && setAttachments(data.attachments))
      .catch(() => !cancelled && setAttachments([]));
    api
      .taskCompletionContext(task.id)
      .then((data) => {
        if (cancelled) return;
        setContext(data);
        const first = data.deals?.find((d) => d.id === data.default_deal_id) || data.deals?.[0];
        if (first) {
          setDealId(String(first.id));
          // start from the deal's own next action, unless it was this very task
          setNext(first.is_this_task ? nextActionDraft({ owner_user_id: first.owner_user_id }, user?.id) : nextActionDraft(first, user?.id));
        }
      })
      .catch(() => !cancelled && setContext({ deal_task: false, deals: [] }));
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  const dealTask = Boolean(context?.deal_task);
  const deal = context?.deals?.find((d) => String(d.id) === dealId) || null;
  const needsNext = dealTask && Boolean(deal?.requires_next_step) && result !== 'PROGRESS';
  const askingNext = needsNext || giveNext;
  const looksLikePlan = dealTask && result === 'ACHIEVED' && readsLikeAPlan(note);

  const pickDeal = (value) => {
    setDealId(value);
    const chosen = context.deals.find((d) => String(d.id) === value);
    if (chosen) setNext(chosen.is_this_task ? nextActionDraft({ owner_user_id: chosen.owner_user_id }, user?.id) : nextActionDraft(chosen, user?.id));
  };

  const recordProgress = async () => {
    if (note.trim().length < 5) return toast.error('Say where it stands in a few words');
    setSaving(true);
    try {
      await api.taskProgress(task.id, { note: note.trim(), evidence_url: evidence.trim() || null });
      toast.success(`Progress recorded — ${task.ref} stays open`);
      onCompleted?.({ task, progress: true });
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
    return undefined;
  };

  const complete = async () => {
    if (dealTask && result === 'PROGRESS') return recordProgress();
    if (dealTask) {
      const problem = outcomeProblem(note);
      if (problem) return toast.error(problem);
      if (looksLikePlan && !confirmPlan) {
        setPlanRefused(true);
        return toast.error('That reads like a plan, not a result — record it as progress, or confirm it really is done');
      }
      if (askingNext) {
        const nextProblem = nextActionProblem(next);
        setNextError(nextProblem);
        if (nextProblem) return undefined;
      }
    } else if (note.trim().length < 3) {
      return toast.error('Please describe the outcome first');
    }

    setSaving(true);
    try {
      const body = { status_id: targetStatusId, completion_note: note.trim() };
      if (dealTask) {
        body.outcome_status = result;
        body.outcome_evidence_url = evidence.trim() || null;
        if (looksLikePlan && confirmPlan) body.confirm_intent = true;
        if (askingNext && deal) {
          body.next_step = {
            opportunity_id: deal.id,
            text: next.next_step.trim(),
            owner_id: Number(next.next_step_owner_id),
            due: next.next_step_due,
          };
        }
      }
      const response = await api.moveTask(task.id, body);
      if (response.next_occurrence) {
        toast.success(
          `Done. Next one (${response.next_occurrence.ref}) is due ${formatDate(response.next_occurrence.due_date)}.`,
        );
      } else {
        toast.success(`${task.ref} marked done`);
      }
      onCompleted?.(response);
      onClose();
    } catch (err) {
      const code = err.details?.code;
      if (code === 'OUTCOME_READS_AS_PLAN') setPlanRefused(true);
      if (code === 'NEXT_ACTION_REQUIRED') {
        setGiveNext(true);
        setNextError(err.message);
      }
      toast.error(err);
    } finally {
      setSaving(false);
    }
    return undefined;
  };

  const progressMode = dealTask && result === 'PROGRESS';
  const footer = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {dealTask ? 'Cancel' : 'Not yet'}
      </button>
      <button type="button" className="btn btn-primary" onClick={complete} disabled={saving || !context}>
        {saving ? 'Saving…' : progressMode ? 'Record progress, keep it open'
          : result === 'NOT_ACHIEVED' ? 'Close it, not achieved' : 'Mark done'}
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

        {dealTask && (
          <div className="outcome-choice" role="radiogroup" aria-label="Did it achieve what the task asked?">
            {[
              ['ACHIEVED', 'Yes — it is done', 'It achieved what the task asked'],
              ['PROGRESS', 'Not yet — record progress', 'The task stays open; the note goes on its history and the timeline'],
              ['NOT_ACHIEVED', 'It cannot be done', 'Close it as not achieved, and say why'],
            ].map(([value, label, hint]) => (
              <label key={value} className={`outcome-option${result === value ? ' is-active' : ''}`}>
                <input type="radio" name="outcome" value={value} checked={result === value}
                  onChange={() => { setResult(value); setPlanRefused(false); }} />
                <span>
                  <strong>{label}</strong>
                  <span className="small muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        <Field
          label={progressMode ? 'Where does it stand?' : result === 'NOT_ACHIEVED' ? 'Why can it not be done?' : prompt.ask}
          hint={progressMode
            ? 'Recorded as progress. The task is not marked done.'
            : 'Needed to close the task — this note becomes the record of what was done.'}
        >
          <textarea
            className="textarea"
            rows={4}
            value={note}
            onChange={(e) => { setNote(e.target.value); setPlanRefused(false); }}
            placeholder={progressMode ? 'Samples are packed; courier booked for Monday.' : prompt.placeholder}
            autoFocus
          />
        </Field>

        {looksLikePlan && (
          <div className={`ask-banner ${planRefused ? 'ask-critical' : 'ask-warning'}`}>
            <Icon name="alert" size={15} />
            <div className="grow small">
              <strong>That reads like a plan, not a result.</strong> If the work is not finished, choose
              “Not yet — record progress” and the task stays open.
              <label className="checklist-item" style={{ padding: '6px 0 0' }}>
                <input type="checkbox" checked={confirmPlan} onChange={(e) => setConfirmPlan(e.target.checked)} />
                <span>It really is done — record this as my confirmation</span>
              </label>
            </div>
          </div>
        )}

        {dealTask && (
          <Field label="Link to the evidence" hint="The report, the email, the signed document. Finished deal work without one is listed for follow-up.">
            <input className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)}
              placeholder="https://drive.google.com/…" />
          </Field>
        )}

        {dealTask && !progressMode && context.deals.length > 0 && (
          <div className="evidence-form">
            {context.deals.length > 1 && (
              <Field label="Which deal is this for?">
                <select className="select" value={dealId} onChange={(e) => pickDeal(e.target.value)}>
                  {context.deals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </Field>
            )}
            {askingNext ? (
              <>
                {needsNext && (
                  <div className="small muted">
                    {deal?.is_this_task
                      ? `This task was ${deal.name}'s next action. Finishing it means saying what happens next.`
                      : `${deal?.name} has no valid next action. Say what happens next.`}
                  </div>
                )}
                <NextActionFields value={next} onChange={(v) => { setNext(v); setNextError(null); }} error={nextError}
                  label={`What happens next on ${deal?.name || 'the deal'}`} />
              </>
            ) : (
              <div className="row-between wrap small">
                <span className="muted">
                  Next on {deal?.name}: {deal?.next_step || 'nothing set'}
                  {deal?.next_step_owner_name ? ` · ${deal.next_step_owner_name}` : ''}
                  {deal?.next_step_due ? ` · by ${formatDate(deal.next_step_due)}` : ''}
                </span>
                <button type="button" className="btn-link small" onClick={() => setGiveNext(true)}>Change it</button>
              </div>
            )}
          </div>
        )}

        {!progressMode && (
          <div className="row small muted" style={{ gap: 6 }}>
            <Icon name="paperclip" size={13} />
            <span>{prompt.proof}</span>
          </div>
        )}

        {!progressMode && (attachments === null || !context ? (
          <Spinner label="Loading attachments" />
        ) : (
          <Attachments
            taskId={task.id}
            attachments={attachments}
            canEdit
            onChange={setAttachments}
          />
        ))}
      </div>
    </Modal>
  );
}
