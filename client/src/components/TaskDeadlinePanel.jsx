import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Badge, Field } from './ui.jsx';
import { formatDate, fromDateTimeLocal, taskHealth } from '../lib/format.js';

const KIND_WORDS = { BEFORE_DUE: 'Before the deadline', AT_DUE: 'At the deadline', AFTER_GRACE: 'After the grace period (manager)', COVER: 'Covering (owner away)', UNREACHED: 'Owner could not be reached' };
const STATE_TONE = { SENT: 'good', ACKNOWLEDGED: 'good', QUEUED: 'brand', PLANNED: 'neutral', SKIPPED: 'warning', FAILED: 'critical', CANCELLED: 'neutral', WOULD_SEND: 'neutral' };
const STATUS_TONE = { PENDING: 'warning', APPROVED: 'good', DECLINED: 'critical', WITHDRAWN: 'neutral', ENDED: 'neutral', ACCEPTED: 'good', CLEARED: 'neutral' };
const todayPlus = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Deadline and reminders on a task: its history (every deadline change,
 * deferral and block, with who and why), anything waiting for a decision,
 * defer / mark blocked / resume, and every reminder planned or sent for it.
 */
export default function TaskDeadlinePanel({ task, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const open = task && task.stage !== 'done' && task.stage !== 'cancelled';

  const load = useCallback(() => {
    if (!task?.id) return;
    api.get(`/task-review/task/${task.id}`).then(setData).catch(() => setData({ changes: [], blocks: [], can_approve: false }));
    api.get(`/reminders/task/${task.id}`).then((r) => setReminders(r.reminders)).catch(() => setReminders([]));
  }, [task?.id]);
  useEffect(load, [load]);

  const act = async (fn, message) => {
    setBusy(true);
    try {
      const result = await fn();
      toast.success(typeof message === 'function' ? message(result) : message);
      setForm(null);
      load();
      onChanged?.();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const pendingWords = (r) => (r?.status === 'PENDING' ? `Sent for approval${r.why ? `: ${r.why}` : ''}` : 'Done');

  if (!task || !data) return null;
  const pending = data.changes.filter((c) => c.status === 'PENDING');
  const openBlock = data.blocks.find((b) => b.status === 'PENDING' || b.status === 'ACCEPTED');
  const health = taskHealth(task);

  return (
    <section className="card deadline-panel" aria-labelledby={`deadline-${task.id}`}>
      <div className="card-head">
        <h3 id={`deadline-${task.id}`} style={{ margin: 0 }}>Deadline and reminders</h3>
        <Badge tone={health.tone}>{health.text}</Badge>
      </div>
      <div className="card-pad stack-sm">
        <div className="small muted">
          {task.original_due_date && task.due_date && new Date(task.original_due_date).getTime() !== new Date(task.due_date).getTime()
            ? <>First deadline {formatDate(task.original_due_date, { withTime: true })} · moved {task.due_date_changes} time{task.due_date_changes === 1 ? '' : 's'}</>
            : task.due_date ? <>Deadline {formatDate(task.due_date, { withTime: true })}</> : 'No deadline yet'}
          {task.next_action && <> · Next: {task.next_action}</>}
        </div>

        {pending.map((c) => (
          <div key={c.id} className="mkt-callout is-warning small stack-xs" role="status">
            <strong>{c.kind === 'DEFER' ? 'A deferral' : 'A new deadline'} is waiting for a decision</strong>
            <span>
              {c.kind === 'DEFER' ? `Review on ${c.review_date}` : `${formatDate(c.from_due, { withTime: true })} → ${formatDate(c.to_due, { withTime: true })}`}
              {' '}· asked by {c.requested_by_name} · “{c.reason}”
            </span>
            <div className="row wrap" style={{ gap: 6 }}>
              {data.can_approve && (
                <>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => api.post(`/task-review/changes/${c.id}/approve`, {}), 'Approved')}>Approve</button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => {
                    const note = window.prompt('Why is it declined? The owner will see this.');
                    if (note) act(() => api.post(`/task-review/changes/${c.id}/decline`, { note }), 'Declined');
                  }}
                  >Decline…</button>
                </>
              )}
              {c.requested_by === user.id && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.post(`/task-review/changes/${c.id}/withdraw`, {}), 'Withdrawn')}>Withdraw</button>}
            </div>
          </div>
        ))}

        {openBlock && (
          <div className={`mkt-callout ${openBlock.status === 'ACCEPTED' ? '' : 'is-warning'} small stack-xs`}>
            <strong>Blocked: {openBlock.reason}</strong>
            <span>
              {openBlock.status === 'ACCEPTED' ? `Accepted by ${openBlock.decided_by_name}: black marks are paused while it lasts` : 'Waiting for someone to accept it (until then, black marks are not paused)'}
              {openBlock.dependency_text ? ` · waits on ${openBlock.dependency_text}` : ''}
            </span>
            <div className="row wrap" style={{ gap: 6 }}>
              {openBlock.status === 'PENDING' && data.can_approve && (
                <>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => api.post(`/task-review/blocks/${openBlock.id}/accept`, {}), 'Block accepted')}>Accept</button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(() => api.post(`/task-review/blocks/${openBlock.id}/decline`, {}), 'Not accepted')}>Not accepted</button>
                </>
              )}
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.post(`/task-review/blocks/${openBlock.id}/clear`, {}), 'Block cleared: move the card on when you are ready')}>It is cleared</button>
            </div>
          </div>
        )}

        {open && !form && (
          <div className="row wrap" style={{ gap: 6 }}>
            {task.deferral_id
              ? <button type="button" className="btn btn-sm" onClick={() => setForm({ kind: 'resume', due: '', reason: '' })}>Resume with a new deadline…</button>
              : <button type="button" className="btn btn-sm" onClick={() => setForm({ kind: 'defer', reason: '', next_action: task.next_action || '', review_date: todayPlus(14), dependency_text: '' })}>Defer…</button>}
            {!openBlock && <button type="button" className="btn btn-sm" onClick={() => setForm({ kind: 'block', reason: '', dependency_text: '' })}>Mark blocked…</button>}
          </div>
        )}

        {form?.kind === 'defer' && (
          <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/task-review/task/${task.id}/defer`, form), pendingWords); }}>
            <div className="small muted">The deadline is kept and paused while the deferral is approved: not overdue, no reminders, no black marks. The task waits in Backlog until its review date.</div>
            <div className="grid-2">
              <Field label="Why defer it?"><input className="input" required minLength={5} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
              <Field label="Next action"><input className="input" required minLength={3} value={form.next_action} onChange={(e) => setForm({ ...form, next_action: e.target.value })} /></Field>
              <Field label="Look at it again on"><input type="date" className="input" required min={todayPlus(0)} value={form.review_date} onChange={(e) => setForm({ ...form, review_date: e.target.value })} /></Field>
              <Field label="Waiting on (optional)"><input className="input" value={form.dependency_text} onChange={(e) => setForm({ ...form, dependency_text: e.target.value })} /></Field>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>Defer</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        )}
        {form?.kind === 'block' && (
          <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/task-review/task/${task.id}/block`, form), (r) => (r.status === 'ACCEPTED' ? 'Marked blocked and accepted' : 'Marked blocked: waiting for someone to accept it')); }}>
            <div className="grid-2">
              <Field label="What is it waiting on?"><input className="input" required minLength={5} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
              <Field label="Who or what (optional)"><input className="input" value={form.dependency_text} onChange={(e) => setForm({ ...form, dependency_text: e.target.value })} /></Field>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>Mark blocked</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        )}
        {form?.kind === 'resume' && (
          <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/task-review/task/${task.id}/resume`, { due: fromDateTimeLocal(form.due), reason: form.reason }), pendingWords); }}>
            <div className="grid-2">
              <Field label="New deadline"><input type="datetime-local" className="input" required value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} /></Field>
              <Field label="Why now?"><input className="input" required minLength={5} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>Resume</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        )}

        {(data.changes.length > 0 || data.blocks.length > 0) && (
          <details>
            <summary className="small">History: {data.changes.length} deadline change{data.changes.length === 1 ? '' : 's'} or deferral{data.changes.length === 1 ? '' : 's'}, {data.blocks.length} block{data.blocks.length === 1 ? '' : 's'}</summary>
            <ul className="plain-list small stack-xs" style={{ marginTop: 6 }}>
              {data.changes.map((c) => (
                <li key={`c${c.id}`}>
                  <Badge tone={STATUS_TONE[c.status]}>{c.status.toLowerCase()}</Badge>{' '}
                  {c.kind === 'DEFER' ? `Deferred (review ${c.review_date})` : `Deadline ${formatDate(c.from_due, { withTime: true })} → ${formatDate(c.to_due, { withTime: true })}`}
                  {' '}· {c.requested_by_name}: “{c.reason}”
                  {c.auto_approved ? ' · the owner\'s one move' : c.decided_by_name ? ` · decided by ${c.decided_by_name}${c.decision_note ? `: ${c.decision_note}` : ''}` : ''}
                  {c.ended_at ? ` · ended ${formatDate(c.ended_at)}` : ''}
                </li>
              ))}
              {data.blocks.map((b) => (
                <li key={`b${b.id}`}>
                  <Badge tone={STATUS_TONE[b.status]}>{b.status.toLowerCase()}</Badge> Blocked: {b.reason} · {b.recorded_by_name}
                  {b.decided_by_name ? ` · decided by ${b.decided_by_name}` : ''}{b.cleared_by_name ? ` · cleared by ${b.cleared_by_name}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}

        {reminders.length > 0 && (
          <details>
            <summary className="small">Reminders: {reminders.length} planned or sent</summary>
            <table className="data small" style={{ marginTop: 6 }}>
              <thead><tr><th>When</th><th>To</th><th>What</th><th>Where</th><th>What happened</th></tr></thead>
              <tbody>
                {reminders.map((r) => (
                  <tr key={r.id}>
                    <td className="tnum">{formatDate(r.remind_at, { withTime: true })}</td>
                    <td>{r.user_name}</td>
                    <td>{KIND_WORDS[r.kind]}</td>
                    <td>{r.channel === 'CHAT' ? 'Google Chat' : 'TaskFlow bell'}</td>
                    <td><Badge tone={STATE_TONE[r.state]}>{r.state.toLowerCase().replace('_', ' ')}</Badge>{r.reason ? <span className="muted"> {r.reason}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </section>
  );
}
