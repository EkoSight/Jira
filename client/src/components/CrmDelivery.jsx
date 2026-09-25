import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import { exactMoney } from '../lib/crm.js';
import { formatDate } from '../lib/format.js';

/**
 * Delivery, after the deal is won.
 *
 * A win is the point at which the promise has to be kept, so this screen tracks
 * a different question from the pipeline: not "will they sign" but "are we doing
 * what we said". Delivery runs on its own states — work can be at risk while the
 * agreement itself is perfectly sound.
 *
 * The agreed money is shown here but belongs to the opportunity. It is one
 * amount, referenced, never re-recorded, so a won deal and its delivery can
 * never both report it.
 */

const STATES = [
  { value: 'PLANNING', label: 'Planning', tone: 'neutral' },
  { value: 'ONBOARDING', label: 'Onboarding', tone: 'brand' },
  { value: 'ACTIVE', label: 'Active', tone: 'good' },
  { value: 'AT_RISK', label: 'At risk', tone: 'danger' },
  { value: 'ON_HOLD', label: 'On hold', tone: 'warning' },
  { value: 'COMPLETED', label: 'Completed', tone: 'good' },
];
const STATE_META = Object.fromEntries(STATES.map((s) => [s.value, s]));

const MILESTONES = [
  { value: 'PLANNED', label: 'Planned', tone: 'neutral' },
  { value: 'IN_PROGRESS', label: 'In progress', tone: 'brand' },
  { value: 'DELIVERED', label: 'Delivered by us', tone: 'warning' },
  { value: 'ACCEPTED', label: 'Accepted by them', tone: 'good' },
  { value: 'BLOCKED', label: 'Blocked', tone: 'danger' },
];
const MILESTONE_META = Object.fromEntries(MILESTONES.map((s) => [s.value, s]));

function StartDialog({ opportunity, onClose, onStarted }) {
  const toast = useToast();
  const { users } = useRefData();
  const [form, setForm] = useState({
    name: `${opportunity.name} — delivery`,
    owner_user_id: '',
    kickoff_on: '',
    create_kickoff_tasks: true,
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const start = async () => {
    setSaving(true);
    try {
      const result = await api.startDelivery(opportunity.id, {
        name: form.name.trim() || undefined,
        owner_user_id: form.owner_user_id ? Number(form.owner_user_id) : null,
        kickoff_on: form.kickoff_on || null,
        create_kickoff_tasks: form.create_kickoff_tasks,
      });
      if (result.note) toast.error(result.note);
      else toast.success(result.created
        ? `Delivery started${result.kickoff_tasks ? ` with ${result.kickoff_tasks} kick-off tasks` : ''}`
        : 'Delivery was already running — opened it');
      onStarted();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Start delivery"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={start} disabled={saving}>
            {saving ? 'Starting…' : 'Start delivery'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          The scope and the agreement carry over from <strong>{opportunity.name}</strong>.
          The agreed amount stays on the deal — delivery refers to it rather than recording
          it a second time.
        </p>
        <Field label="What is this delivery called?">
          <input className="input" autoFocus value={form.name}
            onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <div className="grid-2">
          <Field label="Who is delivering it?">
            <select className="select" value={form.owner_user_id}
              onChange={(e) => set({ owner_user_id: e.target.value })}>
              <option value="">Same as the relationship owner</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </Field>
          <Field label="Kick-off date">
            <input className="input" type="date" value={form.kickoff_on}
              onChange={(e) => set({ kickoff_on: e.target.value })} />
          </Field>
        </div>
        <label className="checklist-item" style={{ padding: 0 }}>
          <input type="checkbox" checked={form.create_kickoff_tasks}
            onChange={(e) => set({ create_kickoff_tasks: e.target.checked })} />
          <span>Create the kick-off tasks — ordinary TaskFlow tasks in the owner's My Tasks.</span>
        </label>
      </div>
    </Modal>
  );
}

function MilestoneDialog({ engagementId, milestone, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    title: milestone?.title || '',
    description: milestone?.description || '',
    due_date: milestone?.due_date ? String(milestone.due_date).slice(0, 10) : '',
    status: milestone?.status || 'PLANNED',
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const save = async () => {
    if (form.title.trim().length < 2) return toast.error('Give the milestone a name');
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        due_date: form.due_date || null,
        status: form.status,
      };
      if (milestone) await api.updateMilestone(engagementId, milestone.id, payload);
      else await api.addMilestone(engagementId, payload);
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
      title={milestone ? 'Edit milestone' : 'Add a milestone'}
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
        <Field label="What has to be delivered? *">
          <input className="input" autoFocus value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="500 devices deployed across the three blocks" />
        </Field>
        <Field label="Any detail">
          <textarea className="textarea" rows={2} value={form.description}
            onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <div className="grid-2">
          <Field label="By when">
            <input className="input" type="date" value={form.due_date}
              onChange={(e) => set({ due_date: e.target.value })} />
          </Field>
          <Field label="Where is it" hint="Delivered and accepted are different facts">
            <select className="select" value={form.status}
              onChange={(e) => set({ status: e.target.value })}>
              {MILESTONES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function EngagementCard({ engagement, onChanged }) {
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [notes, setNotes] = useState(null);

  const load = () => {
    api.engagement(engagement.id).then(setDetail).catch((err) => toast.error(err));
  };
  useEffect(() => { if (open) load(); }, [open, engagement.id]);

  const meta = STATE_META[engagement.state] || STATE_META.PLANNING;
  const canEdit = detail?.can_edit ?? false;
  const refresh = () => { load(); onChanged?.(); };

  const setState = async (state) => {
    try {
      await api.updateEngagement(engagement.id, { state });
      toast.success(`Delivery is now ${STATE_META[state].label.toLowerCase()}`);
      refresh();
    } catch (err) { toast.error(err); }
  };

  return (
    <div className={`engagement${engagement.needs_attention ? ' needs-attention' : ''}`}>
      <button type="button" className="engagement-head" onClick={() => setOpen(!open)}>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="row wrap" style={{ gap: 6 }}>
            <strong style={{ fontSize: 14 }}>{engagement.name}</strong>
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {engagement.review_overdue && <Badge tone="warning">review overdue</Badge>}
          </span>
          <span className="small muted row wrap" style={{ gap: 6, marginTop: 3 }}>
            {engagement.milestone_total > 0 && (
              <span>{engagement.milestone_accepted}/{engagement.milestone_total} accepted</span>
            )}
            {engagement.milestone_overdue > 0 && (
              <span className="text-danger">{engagement.milestone_overdue} overdue</span>
            )}
            {engagement.milestone_blocked > 0 && (
              <span className="text-danger">{engagement.milestone_blocked} blocked</span>
            )}
            {engagement.open_tasks > 0 && <span>{engagement.open_tasks} open tasks</span>}
            {engagement.next_review_on && <span>review {formatDate(engagement.next_review_on)}</span>}
          </span>
        </span>
        {engagement.owner_name && (
          <Avatar name={engagement.owner_name} color={engagement.owner_color} size={24} />
        )}
        <Icon name="chevron" size={13} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
      </button>

      {open && (!detail ? <Spinner label="Loading delivery" /> : (
        <div className="engagement-body">
          <div className="row wrap" style={{ gap: 14 }}>
            <div className="mini-stat">
              <span className="stat-label">Agreed on the deal</span>
              <strong>
                {detail.engagement.agreed_value === null
                  ? <span className="muted">not recorded</span>
                  : exactMoney(detail.engagement.agreed_value, detail.engagement.currency)}
              </strong>
              <span className="small muted">
                {detail.engagement.opportunity_name
                  ? `held on ${detail.engagement.opportunity_name}`
                  : 'no linked deal'}
              </span>
            </div>
            {detail.engagement.agreement_type && (
              <div className="mini-stat">
                <span className="stat-label">Agreement</span>
                <strong>{detail.engagement.agreement_type.replaceAll('_', ' ').toLowerCase()}</strong>
                {detail.engagement.agreement_date && (
                  <span className="small muted">{formatDate(detail.engagement.agreement_date)}</span>
                )}
              </div>
            )}
            {detail.engagement.kickoff_on && (
              <div className="mini-stat">
                <span className="stat-label">Kicked off</span>
                <strong>{formatDate(detail.engagement.kickoff_on)}</strong>
              </div>
            )}
          </div>

          {detail.engagement.agreed_scope && (
            <div className="record-block" style={{ padding: 10 }}>
              <div className="record-block-title">What was agreed</div>
              <p className="record-text">{detail.engagement.agreed_scope}</p>
            </div>
          )}
          {detail.engagement.blockers && (
            <div className="record-block is-warning" style={{ padding: 10 }}>
              <div className="record-block-title">In the way</div>
              <p className="record-text">{detail.engagement.blockers}</p>
            </div>
          )}

          <div className="row-between wrap">
            <div className="stat-label">Milestones</div>
            {canEdit && (
              <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                <Icon name="plus" size={13} /> Add one
              </button>
            )}
          </div>
          {detail.milestones.length === 0 ? (
            <p className="small muted">
              No milestones yet. Without them, "how is delivery going" has no answer but a feeling.
            </p>
          ) : (
            <ul className="milestones">
              {detail.milestones.map((m) => {
                const mm = MILESTONE_META[m.status] || MILESTONE_META.PLANNED;
                const overdue = m.status !== 'ACCEPTED' && m.due_date
                  && new Date(m.due_date).getTime() < Date.now();
                return (
                  <li key={m.id} className={`milestone${overdue ? ' is-overdue' : ''}`}>
                    <span className={`milestone-dot tone-${mm.tone}`} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="row wrap" style={{ gap: 6 }}>
                        <strong style={{ fontSize: 13 }}>{m.title}</strong>
                        <Badge tone={mm.tone}>{mm.label}</Badge>
                      </span>
                      {m.description && <div className="small muted">{m.description}</div>}
                      <div className="small muted">
                        {m.due_date ? `due ${formatDate(m.due_date)}` : 'no date'}
                        {m.accepted_at && ` · accepted ${formatDate(m.accepted_at)}`}
                        {m.accepted_by_name && ` by ${m.accepted_by_name}`}
                      </div>
                    </span>
                    {canEdit && (
                      <span className="row" style={{ gap: 4 }}>
                        <select className="select select-sm" value={m.status}
                          onChange={async (e) => {
                            try {
                              await api.updateMilestone(engagement.id, m.id, { status: e.target.value });
                              refresh();
                            } catch (err) { toast.error(err); }
                          }}>
                          {MILESTONES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                        <button type="button" className="icon-btn" title="Edit"
                          onClick={() => setEditing(m)}>
                          <Icon name="edit" size={13} />
                        </button>
                        <ConfirmButton label="Remove" confirmLabel="Sure?"
                          className="btn btn-sm btn-ghost"
                          onConfirm={async () => {
                            try {
                              await api.deleteMilestone(engagement.id, m.id);
                              refresh();
                            } catch (err) { toast.error(err); }
                          }} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {detail.tasks.length > 0 && (
            <>
              <div className="stat-label">Delivery tasks</div>
              <ul className="plain-list">
                {detail.tasks.map((t) => (
                  <li key={t.id} className="row" style={{ gap: 8 }}>
                    <span className="mono small muted">{t.ref}</span>
                    <span className="grow" style={{
                      textDecoration: t.stage === 'done' ? 'line-through' : 'none',
                    }}>{t.title}</span>
                    <Badge tone={t.stage === 'done' ? 'good' : 'neutral'}>{t.status_name}</Badge>
                    {t.assignee_name && <Avatar name={t.assignee_name} color={t.assignee_color} size={20} />}
                  </li>
                ))}
              </ul>
            </>
          )}

          {canEdit && (
            <div className="stack-sm">
              <div className="stat-label">Where is delivery</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {STATES.map((s) => (
                  <button key={s.value} type="button"
                    className={`kind-chip${detail.engagement.state === s.value ? ' is-active' : ''}`}
                    onClick={() => setState(s.value)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <Field label="What is in the way?" hint="Saved on the delivery, visible to whoever reviews it">
                <textarea className="textarea" rows={2}
                  value={notes ?? detail.engagement.blockers ?? ''}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={async () => {
                    if (notes === null || notes === (detail.engagement.blockers ?? '')) return;
                    try {
                      await api.updateEngagement(engagement.id, { blockers: notes.trim() || null });
                      setNotes(null);
                      refresh();
                    } catch (err) { toast.error(err); }
                  }} />
              </Field>
            </div>
          )}
        </div>
      ))}

      {adding && (
        <MilestoneDialog engagementId={engagement.id}
          onClose={() => setAdding(false)} onSaved={refresh} />
      )}
      {editing && (
        <MilestoneDialog engagementId={engagement.id} milestone={editing}
          onClose={() => setEditing(null)} onSaved={refresh} />
      )}
    </div>
  );
}

export default function CrmDelivery({ accountId, opportunities, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [starting, setStarting] = useState(null);

  // deliberately returns nothing: an effect's return value is its cleanup
  const load = () => {
    api.engagements({ account_id: accountId })
      .then((result) => setData(result.engagements))
      .catch((err) => toast.error(err));
  };

  useEffect(load, [accountId]);

  if (!data) return <Spinner label="Loading delivery" />;

  const started = new Set(data.map((e) => e.opportunity_id).filter(Boolean));
  const readyToStart = opportunities.filter((o) => o.status === 'WON' && !started.has(o.id));
  const refresh = () => { load(); onChanged?.(); };

  return (
    <section className="card card-pad stack">
      <div>
        <h2>Delivery</h2>
        <div className="small muted">
          Winning was the promise. This is whether it is being kept.
        </div>
      </div>

      {readyToStart.length > 0 && (
        <div className="callout">
          <Icon name="trophy" size={16} />
          <div className="grow">
            <strong>
              {readyToStart.length === 1 ? 'A won deal has no delivery yet' : `${readyToStart.length} won deals have no delivery yet`}
            </strong>
            <div className="small muted">
              {readyToStart.map((o) => o.name).join(', ')}
            </div>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {readyToStart.map((o) => (
              <button key={o.id} type="button" className="btn btn-sm btn-primary"
                onClick={() => setStarting(o)}>
                Start: {o.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {data.length === 0 ? (
        <EmptyState title="Nothing in delivery">
          Once a deal is won, start its delivery here — scope, milestones, who is doing it, and
          what is in the way.
        </EmptyState>
      ) : (
        <div className="stack-sm">
          {data.map((e) => <EngagementCard key={e.id} engagement={e} onChanged={refresh} />)}
        </div>
      )}

      {starting && (
        <StartDialog opportunity={starting}
          onClose={() => setStarting(null)} onStarted={refresh} />
      )}
    </section>
  );
}
