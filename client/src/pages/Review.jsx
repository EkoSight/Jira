import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Spinner } from '../components/ui.jsx';
import TaskDialog from '../components/TaskDialog.jsx';
import { formatDate, fromDateTimeLocal } from '../lib/format.js';

const ACTIONS = [
  ['', 'Choose…'],
  ['NEW_DATE', 'Keep it, with a new date'],
  ['BLOCKED', 'It is blocked'],
  ['DONE', 'It is done (with evidence)'],
  ['DEFER', 'Defer it'],
];
const plusDays = (n) => new Date(Date.now() + n * 86_400_000);
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** One row's choice and the fields it needs. */
function ChoiceFields({ choice, onChange }) {
  const set = (k) => (e) => onChange({ ...choice, [k]: e.target.value });
  if (!choice?.action) return null;
  return (
    <div className="review-fields">
      {choice.action === 'NEW_DATE' && (
        <>
          <label className="small">New deadline <input type="datetime-local" className="input" value={choice.due || ''} onChange={set('due')} /></label>
          <label className="small grow">Why <input className="input" value={choice.reason || ''} onChange={set('reason')} placeholder="What changed" /></label>
        </>
      )}
      {choice.action === 'BLOCKED' && (
        <label className="small grow">Waiting on <input className="input" value={choice.reason || ''} onChange={set('reason')} placeholder="What it is waiting for" /></label>
      )}
      {choice.action === 'DONE' && (
        <>
          <label className="small grow">What was done <input className="input" value={choice.evidence || ''} onChange={set('evidence')} placeholder="The evidence: what, where, when" /></label>
          <label className="small">Link (optional) <input className="input" value={choice.evidence_url || ''} onChange={set('evidence_url')} placeholder="https://…" /></label>
        </>
      )}
      {choice.action === 'DEFER' && (
        <>
          <label className="small grow">Why <input className="input" value={choice.reason || ''} onChange={set('reason')} /></label>
          <label className="small grow">Next action <input className="input" value={choice.next_action || ''} onChange={set('next_action')} /></label>
          <label className="small">Review on <input type="date" className="input" value={choice.review_date || ''} onChange={set('review_date')} /></label>
        </>
      )}
    </div>
  );
}

/**
 * The overdue review: each overdue task gets a decision — a new date, blocked,
 * done with evidence, or deferred. Every change is previewed before anything is
 * saved. Below, the requests and blocks waiting for your decision.
 */
export default function Review() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [waiting, setWaiting] = useState({ changes: [], blocks: [], my_requests: [] });
  const [choices, setChoices] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openTask, setOpenTask] = useState(null);
  const [scope, setScope] = useState('mine');

  const load = useCallback(() => {
    api.get('/task-review/overdue').then(setData).catch((err) => toast.error(err));
    api.get('/task-review/waiting').then(setWaiting).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  const tasks = useMemo(() => (data?.tasks || []).filter((t) => (scope === 'mine' ? t.mine : !t.mine)), [data, scope]);
  const setChoice = (taskId, value) => {
    setPreview(null);
    setChoices((c) => {
      const next = { ...c };
      if (!value?.action) delete next[taskId];
      else next[taskId] = value;
      return next;
    });
  };
  const items = Object.entries(choices).map(([taskId, c]) => ({
    task_id: Number(taskId), ...c, due: c.due ? fromDateTimeLocal(c.due) : undefined,
  }));

  const runPreview = async () => {
    setBusy(true);
    try { setPreview(await api.post('/task-review/preview', { items })); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const { results } = await api.post('/task-review/apply', { items });
      const failed = results.filter((r) => !r.ok);
      const waits = results.filter((r) => r.ok && r.status === 'PENDING').length;
      if (failed.length) toast.error(`${failed.length} could not be saved: ${failed[0].error}`);
      else toast.success(`Saved ${results.length}${waits ? `; ${waits} waiting for approval` : ''}`);
      setChoices({});
      setPreview(null);
      load();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const decide = async (path, message, needsNote = false) => {
    let note;
    if (needsNote) {
      note = window.prompt('Why? The person who asked will see this.');
      if (!note) return;
    }
    try { await api.post(path, note ? { note } : {}); toast.success(message); load(); } catch (err) { toast.error(err); }
  };

  if (!data) return <Spinner label="Loading the review" />;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div>
        <h1>Overdue review</h1>
        <div className="small muted">
          Decide each overdue task: keep it with a new date, say it is blocked, close it with evidence, or defer it.
          Nothing is saved until you have seen the preview. Deadlines never change without a reason, and overdue history is kept.
        </div>
      </div>

      {(waiting.changes.length > 0 || waiting.blocks.length > 0) && (
        <section className="card" aria-labelledby="waiting-head">
          <div className="card-head"><h2 id="waiting-head">Waiting for your decision</h2><Badge tone="warning">{waiting.changes.length + waiting.blocks.length}</Badge></div>
          <div className="card-pad stack-sm">
            {waiting.changes.map((c) => (
              <div key={`c${c.id}`} className="review-row">
                <div className="grow">
                  <button type="button" className="link-button" onClick={() => setOpenTask(c.task_id)}>{c.ref} {c.title}</button>
                  <div className="small muted">
                    {c.kind === 'DEFER' ? `Defer, review on ${c.review_date}` : `New deadline ${formatDate(c.to_due, { withTime: true })} (was ${formatDate(c.from_due, { withTime: true })})`}
                    {' '}· asked by {c.requested_by_name}{c.owner_name && c.owner_name !== c.requested_by_name ? ` for ${c.owner_name}` : ''} · “{c.reason}”
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => decide(`/task-review/changes/${c.id}/approve`, 'Approved')}>Approve</button>
                  <button type="button" className="btn btn-sm" onClick={() => decide(`/task-review/changes/${c.id}/decline`, 'Declined', true)}>Decline…</button>
                </div>
              </div>
            ))}
            {waiting.blocks.map((b) => (
              <div key={`b${b.id}`} className="review-row">
                <div className="grow">
                  <button type="button" className="link-button" onClick={() => setOpenTask(b.task_id)}>{b.ref} {b.title}</button>
                  <div className="small muted">Blocked: {b.reason} · recorded by {b.recorded_by_name}. Accepting it pauses black marks while it lasts.</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => decide(`/task-review/blocks/${b.id}/accept`, 'Block accepted')}>Accept</button>
                  <button type="button" className="btn btn-sm" onClick={() => decide(`/task-review/blocks/${b.id}/decline`, 'Not accepted', true)}>Not accepted…</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {waiting.my_requests.length > 0 && (
        <div className="small muted">
          You are waiting on {waiting.my_requests.length} decision{waiting.my_requests.length === 1 ? '' : 's'}: {waiting.my_requests.map((r) => r.ref).join(', ')}.
        </div>
      )}

      <section className="card" aria-labelledby="overdue-head">
        <div className="card-head">
          <h2 id="overdue-head">Overdue</h2>
          <div className="row" style={{ gap: 2, background: 'var(--surface-3)', padding: 2, borderRadius: 8 }} role="group" aria-label="Whose work">
            {[['mine', `Mine (${data.mine})`], ['team', `My team (${data.team})`]].map(([key, label]) => (
              <button key={key} type="button" className={`btn btn-sm ${scope === key ? '' : 'btn-ghost'}`} aria-pressed={scope === key} onClick={() => setScope(key)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="card-pad stack-sm">
          {tasks.length === 0 && <EmptyState title={scope === 'mine' ? 'Nothing of yours is overdue' : 'Nothing overdue in your scope'} />}
          {tasks.map((t) => {
            const choice = choices[t.id];
            return (
              <div key={t.id} className="review-row">
                <div className="grow stack-xs">
                  <div className="row wrap" style={{ gap: 8 }}>
                    <button type="button" className="link-button" onClick={() => setOpenTask(t.id)}><span className="task-ref">{t.ref}</span> {t.title}</button>
                    <Badge tone={t.health?.tone || 'critical'}>{t.health?.text || 'Overdue'}</Badge>
                    {t.stage === 'blocked' && <Badge tone="serious">Blocked</Badge>}
                    {t.stage === 'backlog' && <Badge tone="neutral">Backlog</Badge>}
                    {t.pending_change && <Badge tone="warning">Request waiting</Badge>}
                  </div>
                  <div className="row small muted" style={{ gap: 6 }}>
                    {!t.mine && <><Avatar userId={t.assignee_id} name={t.assignee_name || '?'} color={t.assignee_color} size={18} /> {t.assignee_name || 'No owner'} ·</>}
                    Was due {formatDate(t.due_date, { withTime: true })}
                    {t.due_date_changes > 0 && ` · moved ${t.due_date_changes} time${t.due_date_changes === 1 ? '' : 's'}`}
                    {t.next_action && ` · Next: ${t.next_action}`}
                  </div>
                  <ChoiceFields choice={choice} onChange={(v) => setChoice(t.id, v)} />
                </div>
                <label className="small">
                  <span className="sr-only">Decision for {t.ref}</span>
                  <select
                    className="select"
                    value={choice?.action || ''}
                    onChange={(e) => setChoice(t.id, e.target.value ? {
                      action: e.target.value,
                      ...(e.target.value === 'NEW_DATE' ? { due: localInput(plusDays(2)) } : {}),
                      ...(e.target.value === 'DEFER' ? { review_date: plusDays(14).toISOString().slice(0, 10), next_action: t.next_action || '' } : {}),
                    } : null)}
                  >
                    {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
              </div>
            );
          })}
        </div>
        {items.length > 0 && (
          <div className="card-pad stack-sm review-footer">
            {preview && (
              <ul className="plain-list small stack-xs" aria-live="polite">
                {preview.items.map((p) => (
                  <li key={p.task_id} className={p.ok ? '' : 'critical-text'}>
                    <strong>{p.ref || `#${p.task_id}`}</strong>: {p.ok ? p.effect : p.error}{p.note ? ` (${p.note})` : ''}
                  </li>
                ))}
              </ul>
            )}
            <div className="row wrap" style={{ gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={runPreview}>Preview {items.length} change{items.length === 1 ? '' : 's'}</button>
              <button type="button" className="btn btn-primary" disabled={busy || !preview?.ready} onClick={apply}>Save {items.length}</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setChoices({}); setPreview(null); }}>Clear</button>
              {!preview && <span className="small muted">Preview first: nothing is saved until you have seen what will happen.</span>}
            </div>
          </div>
        )}
      </section>

      {openTask && <TaskDialog taskId={openTask} onClose={() => setOpenTask(null)} onSaved={load} />}
    </div>
  );
}
