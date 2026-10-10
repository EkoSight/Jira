import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, Field, Icon, Modal, Spinner } from './ui.jsx';
import { Thread } from './DiscussionPanel.jsx';
import { PersonSelect, dayFromToday } from './DealParts.jsx';
import { BLOCKER_CATEGORIES, BLOCKER_DEPENDENCIES, blockerCategory, blockerProblem } from '../lib/threads.js';
import { firstName, todayInIndia } from '../lib/crm.js';
import { formatDate } from '../lib/format.js';

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

const blockerBody = (facts) => ({
  blocked_item: String(facts.blocked_item).trim(),
  dependency: facts.dependency,
  external_party: facts.dependency === 'EXTERNAL' ? String(facts.external_party).trim() : null,
  responsible_user_id: Number(facts.responsible_user_id),
  expected_resolution: facts.expected_resolution,
});

function BlockerFactsFields({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="stack-sm">
      <Field label="What exactly is blocked? *">
        <input className="input" value={value.blocked_item} onChange={(e) => set({ blocked_item: e.target.value })}
          placeholder="Validation of the 12 soil samples" />
      </Field>
      <Field label="It depends on *">
        <div className="row wrap" style={{ gap: 6 }}>
          {BLOCKER_DEPENDENCIES.map((d) => (
            <button key={d.value} type="button" title={d.hint}
              className={`kind-chip${value.dependency === d.value ? ' is-active' : ''}`}
              onClick={() => set({ dependency: d.value })}>
              {d.label}
            </button>
          ))}
        </div>
      </Field>
      {value.dependency === 'EXTERNAL' && (
        <Field label="Who outside? *">
          <input className="input" value={value.external_party}
            onChange={(e) => set({ external_party: e.target.value })} placeholder="FarMart quality lab" />
        </Field>
      )}
      <div className="grid-2">
        <Field label="Who on our side clears it? *" hint="They are told, and it shows in their list">
          <PersonSelect value={value.responsible_user_id} onChange={(v) => set({ responsible_user_id: v })} />
        </Field>
        <Field label="Expected to clear by *">
          <input className="input" type="date" min={todayInIndia()} value={value.expected_resolution}
            onChange={(e) => set({ expected_resolution: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}

export function RaiseBlockerDialog({ account, opportunities = [], onClose, onRaised }) {
  const toast = useToast();
  const { user } = useAuth();
  const { users } = useRefData();
  const open = opportunities.filter((o) => o.status === 'ACTIVE' || o.status === 'ON_HOLD' || o.status === 'NURTURE');

  const [category, setCategory] = useState('');
  const [about, setAbout] = useState(() => (open[0] ? `OPPORTUNITY:${open[0].id}` : `ACCOUNT:${account.id}`));
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [facts, setFacts] = useState(() => ({
    blocked_item: '',
    dependency: '',
    external_party: '',
    // whoever leads the deal is the usual person to clear what is in its way
    responsible_user_id: String(open[0]?.owner_user_id || account.owner_user_id || user.id),
    expected_resolution: dayFromToday(7),
  }));
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

  const pickCategory = (value) => {
    setCategory(value);
    // the business's own obstacles name the blocked thing well enough to start from
    const meta = blockerCategory(value);
    if (['SAMPLE_VALIDATION', 'PRICING_APPROVAL', 'FUNDING', 'PROCUREMENT'].includes(value) && !facts.blocked_item.trim()) {
      setFacts((f) => ({ ...f, blocked_item: meta.label }));
    }
  };

  const save = async () => {
    if (!category) return toast.error('Pick what sort of thing is in the way');
    const problem = blockerProblem(facts);
    if (problem) return toast.error(problem);
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
        ...blockerBody(facts),
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
                onClick={() => pickCategory(c.value)}>
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

        <BlockerFactsFields value={facts} onChange={setFacts} />

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

/** One line: what is blocked, on whom, who clears it, by when. */
function BlockerFacts({ thread, onEdit }) {
  const recorded = thread.blocked_item && thread.dependency && thread.responsible_user_id && thread.expected_resolution;
  if (!recorded) {
    return (
      <div className="blocker-facts is-incomplete small">
        <span className="kr-flag kr-flag-warning">Not yet recorded: what is blocked, who clears it, by when</span>
        {onEdit && <button type="button" className="btn-link small" onClick={onEdit}>Add them</button>}
      </div>
    );
  }
  const due = String(thread.expected_resolution).slice(0, 10);
  const late = due < todayInIndia();
  return (
    <div className={`blocker-facts small${late ? ' is-late' : ''}`}>
      <span><span className="muted">Blocked:</span> <strong>{thread.blocked_item}</strong></span>
      <span>
        <span className="muted">on</span>{' '}
        {thread.dependency === 'EXTERNAL' ? (thread.external_party || 'someone outside') : 'us'}
      </span>
      <span className="row" style={{ gap: 4 }}>
        <Avatar name={thread.responsible_name} color={thread.responsible_color} size={16} />
        {firstName(thread.responsible_name)} clears it
      </span>
      <span className={late ? 'is-late' : ''}>
        {late ? 'was expected by ' : 'by '}{formatDate(due)}
      </span>
      {onEdit && <button type="button" className="btn-link small" onClick={onEdit}>Update</button>}
    </div>
  );
}

/** A new date, a new person, or what it now depends on — said in the thread when changed. */
function BlockerEditDialog({ thread, onClose, onSaved }) {
  const toast = useToast();
  const [facts, setFacts] = useState(() => ({
    blocked_item: thread.blocked_item || '',
    dependency: thread.dependency || '',
    external_party: thread.external_party || '',
    responsible_user_id: String(thread.responsible_user_id || ''),
    expected_resolution: thread.expected_resolution && String(thread.expected_resolution).slice(0, 10) >= todayInIndia()
      ? String(thread.expected_resolution).slice(0, 10) : '',
  }));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const moved = thread.expected_resolution && facts.expected_resolution
    && facts.expected_resolution !== String(thread.expected_resolution).slice(0, 10);

  const save = async () => {
    const problem = blockerProblem(facts);
    if (problem) return toast.error(problem);
    if (moved && note.trim().length < 5) return toast.error('Say why the date is moving');
    // only what changed, so the note in the thread says exactly what moved
    const was = {
      blocked_item: thread.blocked_item, dependency: thread.dependency,
      external_party: thread.dependency === 'EXTERNAL' ? thread.external_party : null,
      responsible_user_id: thread.responsible_user_id,
      expected_resolution: thread.expected_resolution ? String(thread.expected_resolution).slice(0, 10) : null,
    };
    const changes = Object.fromEntries(Object.entries(blockerBody(facts)).filter(([key, value]) => value !== was[key]));
    if (!Object.keys(changes).length && !note.trim()) return onClose();
    setSaving(true);
    try {
      await api.updateBlocker(thread.id, { ...changes, note: note.trim() || null });
      toast.success('Blocker updated — the change is noted in its thread');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
      setSaving(false);
    }
  };

  return (
    <Modal
      title={thread.title || 'Update the blocker'}
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">
        <BlockerFactsFields value={facts} onChange={setFacts} />
        <Field label={moved ? 'Why is the date moving? *' : 'Anything to add?'}
          hint="Posted in the blocker's thread, so everyone following it sees it">
          <textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={moved ? 'Their lab is short-staffed until the 20th' : ''} />
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
  const [editing, setEditing] = useState(null);
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
          <BlockerFacts thread={thread} onEdit={data.can_manage ? () => setEditing(thread) : null} />
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
      {editing && (
        <BlockerEditDialog thread={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
    </section>
  );
}
