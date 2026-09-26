import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, Field, Icon, Modal, Spinner } from './ui.jsx';
import { Thread } from './DiscussionPanel.jsx';
import { BLOCKER_CATEGORIES, blockerCategory } from '../lib/threads.js';

/**
 * What is stopping a lead converting.
 *
 * A blocker is raised by whoever works the lead, names the people who might help,
 * is discussed in the open, and is closed with what was decided. It is the same
 * thread every task and goal already uses — not a second comment system — so the
 * people asked are told the same way and the conclusion is kept the same way.
 *
 * Raising one is an internal act. It appears on the lead's timeline as a note, and
 * it does not count as having spoken to the partner.
 */

export function RaiseBlockerDialog({ account, opportunities = [], onClose, onRaised }) {
  const toast = useToast();
  const { user } = useAuth();
  const { users } = useRefData();
  const open = opportunities.filter((o) => o.status === 'ACTIVE' || o.status === 'ON_HOLD' || o.status === 'NURTURE');

  const [category, setCategory] = useState('');
  const [about, setAbout] = useState(() => (open[0] ? `OPPORTUNITY:${open[0].id}` : `ACCOUNT:${account.id}`));
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [people, setPeople] = useState(() => new Set(
    // the lead's own people are the obvious first ones to tell
    [account.owner_user_id, account.follower_user_id].filter((id) => id && id !== user.id),
  ));
  const [saving, setSaving] = useState(false);

  const toggle = (id) => setPeople((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const save = async () => {
    if (!category) return toast.error('Pick what sort of thing is in the way');
    if (title.trim().length < 3) return toast.error('Give it a one-line headline');
    if (body.trim().length < 3) return toast.error('Say a little more — what is stopping them, and what have you tried?');
    const [entityType, entityId] = about.split(':');
    setSaving(true);
    try {
      await api.openThread({
        entity_type: entityType,
        entity_id: Number(entityId),
        kind: 'blocker',
        category,
        title: title.trim(),
        body: body.trim(),
        participant_user_ids: [...people],
      });
      toast.success(people.size
        ? `Raised — ${people.size} ${people.size === 1 ? 'person has' : 'people have'} been alerted`
        : 'Raised');
      onRaised();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const others = users.filter((u) => u.id !== user.id && u.is_active !== false);

  return (
    <Modal
      title={`What is stopping ${account.name}?`}
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Raising…' : people.size ? `Raise and alert ${people.size}` : 'Raise it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="What sort of thing is in the way? *">
          <div className="row wrap" style={{ gap: 6 }}>
            {BLOCKER_CATEGORIES.map((c) => (
              <button key={c.value} type="button" title={c.hint}
                className={`kind-chip${category === c.value ? ' is-active' : ''}`}
                onClick={() => setCategory(c.value)}>
                {c.label}
              </button>
            ))}
          </div>
          {category && blockerCategory(category)?.hint && (
            <div className="small muted" style={{ marginTop: 4 }}>{blockerCategory(category).hint}</div>
          )}
        </Field>

        {open.length > 0 && (
          <Field label="About which deal?">
            <select className="select" value={about} onChange={(e) => setAbout(e.target.value)}>
              {open.map((o) => <option key={o.id} value={`OPPORTUNITY:${o.id}`}>{o.name}</option>)}
              <option value={`ACCOUNT:${account.id}`}>The relationship as a whole</option>
            </select>
          </Field>
        )}

        <Field label="In one line *">
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Board will not approve before the co-operative audit" />
        </Field>
        <Field label="What is happening, and what have you tried? *">
          <textarea className="textarea" rows={4} value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="Their board meets after the audit in November. Could we offer a one-taluka pilot inside the CEO's own limit?" />
        </Field>

        <Field
          label="Who should hear about it?"
          hint="They are alerted now and on every reply until it is closed. Only people inside the company — the partner is never told."
        >
          <div className="row wrap" style={{ gap: 6 }}>
            {others.map((u) => (
              <button key={u.id} type="button"
                className={`kind-chip${people.has(u.id) ? ' is-active' : ''}`}
                onClick={() => toggle(u.id)}>
                {u.full_name}
                {u.id === account.owner_user_id && <span className="muted"> · leads it</span>}
                {u.id === account.follower_user_id && <span className="muted"> · follows it</span>}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function BringInDialog({ thread, onClose, onDone }) {
  const toast = useToast();
  const { users } = useRefData();
  const already = new Set((thread.participants || []).map((p) => p.id));
  const [picked, setPicked] = useState(new Set());
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!picked.size) return onClose();
    setSaving(true);
    try {
      await api.addThreadParticipants(thread.id, [...picked]);
      toast.success(`${picked.size} more ${picked.size === 1 ? 'person' : 'people'} alerted`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Bring someone else in"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !picked.size}>
            Alert them
          </button>
        </>
      }
    >
      <div className="row wrap" style={{ gap: 6 }}>
        {users.filter((u) => !already.has(u.id) && u.id !== thread.opened_by).map((u) => (
          <button key={u.id} type="button"
            className={`kind-chip${picked.has(u.id) ? ' is-active' : ''}`}
            onClick={() => setPicked((c) => {
              const next = new Set(c);
              if (next.has(u.id)) next.delete(u.id); else next.add(u.id);
              return next;
            })}>
            {u.full_name}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export default function CrmBlockers({ account, opportunities, compact = false, onChanged, raiseSignal = 0 }) {
  const toast = useToast();
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [raising, setRaising] = useState(false);
  const [bringing, setBringing] = useState(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = () => {
    api.leadThreads(account.id).then(setData).catch((err) => toast.error(err));
  };
  useEffect(load, [account.id]);
  // the header's "Raise a blocker" button opens the same dialog
  useEffect(() => { if (raiseSignal) setRaising(true); }, [raiseSignal]);

  if (!data) return compact ? null : <Spinner label="Loading blockers" />;

  const blockers = data.threads.filter((t) => t.kind === 'blocker');
  const open = blockers.filter((t) => t.status === 'open');
  const closed = blockers.filter((t) => t.status === 'resolved');
  const canRaise = data.can_manage && can('crm.activity.log');
  const refresh = () => { load(); onChanged?.(); };

  // on the overview, say nothing at all when nothing is in the way
  if (compact && open.length === 0 && !raising) return null;

  return (
    <section className={`card card-pad stack${open.length ? ' blocker-card' : ''}`}>
      <div className="row-between wrap">
        <div>
          <h2>{open.length ? `In the way (${open.length})` : 'Blockers'}</h2>
          <div className="small muted">
            What is stopping them converting, who has been asked to help, and what was decided.
          </div>
        </div>
        {canRaise && (
          <button type="button" className="btn btn-sm" onClick={() => setRaising(true)}>
            <Icon name="alert" size={13} /> Raise a blocker
          </button>
        )}
      </div>

      {open.length === 0 && (
        <p className="small muted">
          Nothing raised. If something is stopping this lead — budget, an approval, a missing proof —
          raise it here and bring in the people who can help.
        </p>
      )}

      {open.map((thread) => (
        <div key={thread.id} className="blocker">
          <div className="blocker-meta row wrap">
            {thread.category && (
              <Badge tone="warning">{blockerCategory(thread.category)?.label || thread.category}</Badge>
            )}
            <span className="small muted">
              {thread.about ? `on ${thread.about}` : 'on the relationship'}
            </span>
            {thread.participants?.length > 0 && (
              <span className="row small muted" style={{ gap: 4 }}>
                · asked:
                {thread.participants.map((p) => (
                  <Avatar key={p.id} name={p.full_name} color={p.avatar_color} size={18} title={p.full_name} />
                ))}
              </span>
            )}
            {(data.can_manage || thread.opened_by) && (
              <button type="button" className="btn-link small" onClick={() => setBringing(thread)}>
                bring someone in
              </button>
            )}
          </div>
          <Thread thread={thread} canRaiseReview={data.can_raise_review}
            canManage={data.can_manage} onChanged={refresh} />
        </div>
      ))}

      {closed.length > 0 && (
        <>
          <button type="button" className="disclosure" onClick={() => setShowClosed((v) => !v)}>
            <Icon name="chevron" size={12} style={{ transform: showClosed ? 'rotate(90deg)' : 'none' }} />
            Cleared ({closed.length})
          </button>
          {showClosed && closed.map((thread) => (
            <Thread key={thread.id} thread={thread} canRaiseReview={data.can_raise_review}
              canManage={data.can_manage} onChanged={refresh} />
          ))}
        </>
      )}

      {raising && (
        <RaiseBlockerDialog account={account} opportunities={opportunities}
          onClose={() => setRaising(false)} onRaised={refresh} />
      )}
      {bringing && (
        <BringInDialog thread={bringing} onClose={() => setBringing(null)} onDone={refresh} />
      )}
    </section>
  );
}
