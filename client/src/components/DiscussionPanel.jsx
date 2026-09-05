import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon } from './ui.jsx';
import { kindsFor, replyCount, threadKind } from '../lib/threads.js';
import { relativeTime } from '../lib/format.js';

/**
 * The conversation about a piece of work.
 *
 * The same panel serves a task, a key result and a goal, because the thing
 * people need to say — "this is too vague", "I am stuck", "here is where it got
 * to" — does not change with what it is said about.
 *
 * A thread is opened with a kind, discussed, and closed with a conclusion. The
 * conclusion is the point: a card whose comments trail off makes the next reader
 * work through the whole argument to find out how it came out.
 */

function Composer({ canRaiseReview, defaultKind, onPost, busy }) {
  const [kind, setKind] = useState(defaultKind || 'progress');
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');

  const kinds = useMemo(() => kindsFor(canRaiseReview), [canRaiseReview]);
  const meta = threadKind(kind);

  const post = async () => {
    if (!body.trim()) return;
    await onPost({ kind, body: body.trim(), title: title.trim() || undefined });
    setBody('');
    setTitle('');
  };

  return (
    <div className="composer">
      <div className="kind-picker" role="radiogroup" aria-label="What kind of update is this?">
        {kinds.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={kind === option.value}
            className={`kind-chip kind-${option.severity}${kind === option.value ? ' is-active' : ''}`}
            onClick={() => setKind(option.value)}
            title={option.hint}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="small muted">{meta.hint}</div>

      {meta.asking && (
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="A short headline — what needs to change or happen"
        />
      )}

      <textarea
        className="textarea"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={meta.placeholder}
      />

      <div className="row-between">
        <span className="small muted">
          {meta.asking
            ? 'The owner is told, and this stays flagged until it is answered.'
            : 'Everyone following this is told.'}
        </span>
        <button type="button" className="btn btn-primary btn-sm" onClick={post} disabled={busy || !body.trim()}>
          {busy ? 'Posting…' : meta.verb}
        </button>
      </div>
    </div>
  );
}

function ResolveBox({ onResolve, busy }) {
  const [open, setOpen] = useState(false);
  const [conclusion, setConclusion] = useState('');

  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        <Icon name="check" size={13} /> Close with a conclusion
      </button>
    );
  }

  return (
    <div className="stack-sm" style={{ width: '100%' }}>
      <Field
        label="What did this conclude?"
        hint="The next person to read this should not have to work it out from the replies"
      >
        <textarea
          className="textarea"
          rows={2}
          autoFocus
          value={conclusion}
          onChange={(e) => setConclusion(e.target.value)}
          placeholder="Target and date added; measured from the dealer app."
        />
      </Field>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || conclusion.trim().length < 3}
          onClick={() => onResolve(conclusion.trim())}
        >
          Close it
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function Thread({ thread, canRaiseReview, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(thread.status === 'open');

  const meta = threadKind(thread.kind);
  const resolved = thread.status === 'resolved';
  const mayClose = thread.opened_by === user.id || canRaiseReview;
  const replies = replyCount(thread);

  const run = async (fn, done) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`thread${resolved ? ' is-resolved' : ''} thread-${meta.severity}`}>
      <button type="button" className="thread-head" onClick={() => setExpanded((v) => !v)}>
        <span className={`kind-chip kind-${meta.severity} is-static`}>{meta.label}</span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="thread-title">
            {thread.title || thread.messages?.[0]?.body?.slice(0, 80) || meta.label}
          </span>
          <span className="small muted thread-sub">
            {thread.opened_by_name || 'Someone'} · {relativeTime(thread.created_at)}
            {replies && ` · ${replies}`}
            {thread.awaiting_name && !resolved && ` · waiting on ${thread.awaiting_name}`}
          </span>
        </span>
        {resolved && <Badge tone="good">Closed</Badge>}
        <Icon name="chevron" size={13} style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />
      </button>

      {resolved && thread.conclusion && (
        <div className="thread-conclusion">
          <Icon name="check" size={13} />
          <span>
            <strong>Concluded:</strong> {thread.conclusion}
            <span className="muted"> — {thread.resolved_by_name || 'someone'}, {relativeTime(thread.resolved_at)}</span>
          </span>
        </div>
      )}

      {expanded && (
        <div className="thread-body">
          {(thread.messages || []).map((message) => (
            <div key={message.id} className="thread-message">
              <Avatar name={message.author_name || 'Someone'} color={message.avatar_color} size={24} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 7 }}>
                  <strong className="small">{message.author_name || 'Removed user'}</strong>
                  <span className="small muted">{relativeTime(message.created_at)}</span>
                </div>
                <div className="thread-text">{message.body}</div>
              </div>
            </div>
          ))}

          {!resolved && (
            <div className="thread-actions">
              <textarea
                className="textarea"
                rows={2}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Reply…"
                style={{ minHeight: 42 }}
              />
              <div className="row-between wrap">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !reply.trim()}
                  onClick={() => run(async () => {
                    await api.replyToThread(thread.id, reply.trim());
                    setReply('');
                  })}
                >
                  Reply
                </button>
                {mayClose && (
                  <ResolveBox
                    busy={busy}
                    onResolve={(conclusion) => run(
                      () => api.resolveThread(thread.id, conclusion),
                      // otherwise the thread simply disappears into the closed
                      // list and it is not obvious the conclusion was kept
                      'Closed — the conclusion is on the record',
                    )}
                  />
                )}
              </div>
            </div>
          )}

          {resolved && mayClose && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => run(() => api.reopenThread(thread.id), 'Reopened')}
            >
              Reopen
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function DiscussionPanel({
  entityType, entityId, threads = [], canRaiseReview = false, onChanged, defaultKind,
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const open = threads.filter((t) => t.status === 'open');
  const closed = threads.filter((t) => t.status === 'resolved');

  const post = async ({ kind, body, title }) => {
    setBusy(true);
    try {
      await api.openThread({
        entity_type: entityType,
        entity_id: entityId,
        kind,
        title,
        body,
      });
      toast.success(threadKind(kind).asking ? 'Asked — the owner has been told' : 'Posted');
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Composer
        canRaiseReview={canRaiseReview}
        defaultKind={defaultKind}
        onPost={post}
        busy={busy}
      />

      {open.length === 0 && closed.length === 0 && (
        <EmptyState title="Nothing discussed yet">
          This is where the work gets talked about — progress, what is in the way, and what was
          decided.
        </EmptyState>
      )}

      {open.length > 0 && (
        <div className="stack-sm">
          {open.map((thread) => (
            <Thread
              key={thread.id}
              thread={thread}
              canRaiseReview={canRaiseReview}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <>
          <button type="button" className="btn-link small" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Hide' : 'Show'} {closed.length} closed {closed.length === 1 ? 'thread' : 'threads'}
          </button>
          {showClosed && (
            <div className="stack-sm">
              {closed.map((thread) => (
                <Thread
                  key={thread.id}
                  thread={thread}
                  canRaiseReview={canRaiseReview}
                  onChanged={onChanged}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
