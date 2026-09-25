import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import { formatDate } from '../lib/format.js';

/**
 * Meetings and demos.
 *
 * The screen is built around one distinction: a meeting in the diary and a
 * meeting that happened are different things. A scheduled demo shows as
 * scheduled, a past one with nothing written shows as waiting for its outcome,
 * and only recording that outcome turns it into evidence.
 *
 * Nothing here sends anything. TaskFlow does not issue calendar invitations, and
 * the screen says so rather than letting anyone assume it did.
 */

const KINDS = [
  { value: 'MEETING', label: 'Meeting' },
  { value: 'DEMO', label: 'Demo' },
  { value: 'SITE_VISIT', label: 'Site visit' },
  { value: 'WORKSHOP', label: 'Workshop' },
  { value: 'REVIEW', label: 'Review' },
];

const STATUS_META = {
  SCHEDULED: { label: 'Scheduled', tone: 'brand' },
  COMPLETED: { label: 'Completed', tone: 'good' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  NO_SHOW: { label: 'No show', tone: 'warning' },
  RESCHEDULED: { label: 'Moved', tone: 'neutral' },
};

/** The clock people read it in, which may not be the browser's. */
const inZone = (value, timezone) => {
  try {
    return new Date(value).toLocaleString(undefined, {
      timeZone: timezone || 'Asia/Kolkata',
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return formatDate(value, { withTime: true });
  }
};

function ScheduleDialog({ accountId, opportunities, contacts, meeting, onClose, onSaved }) {
  const toast = useToast();
  const { users } = useRefData();
  const rescheduling = Boolean(meeting);

  const [form, setForm] = useState(() => ({
    kind: meeting?.kind || 'DEMO',
    mode: meeting?.mode || 'IN_PERSON',
    title: meeting?.title || '',
    objective: meeting?.objective || '',
    scheduled_at: '',
    duration_min: meeting?.duration_min || 60,
    location: meeting?.location || '',
    meeting_url: meeting?.meeting_url || '',
    opportunity_id: meeting?.opportunity_id || opportunities[0]?.id || '',
    demo_type: meeting?.demo_type || '',
    prerequisites: meeting?.prerequisites || '',
    create_prep_tasks: true,
    reason: '',
  }));
  const [participants, setParticipants] = useState(new Set());
  const [internal, setInternal] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const toggle = (setState) => (id) => setState((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const save = async () => {
    if (!form.scheduled_at) return toast.error('Pick a date and time');
    if (!rescheduling && form.title.trim().length < 2) return toast.error('Give it a title');
    setSaving(true);
    try {
      if (rescheduling) {
        await api.rescheduleMeeting(meeting.id, {
          scheduled_at: new Date(form.scheduled_at).toISOString(),
          reason: form.reason.trim() || undefined,
        });
        toast.success('Moved — the same meeting, with its preparation work');
      } else {
        await api.scheduleMeeting({
          account_id: accountId,
          opportunity_id: form.opportunity_id ? Number(form.opportunity_id) : null,
          kind: form.kind,
          mode: form.mode,
          title: form.title.trim(),
          objective: form.objective.trim() || null,
          scheduled_at: new Date(form.scheduled_at).toISOString(),
          duration_min: Number(form.duration_min) || null,
          location: form.location.trim() || null,
          meeting_url: form.meeting_url.trim() || null,
          demo_type: form.demo_type.trim() || null,
          prerequisites: form.prerequisites.trim() || null,
          participant_contact_ids: [...participants],
          participant_user_ids: [...internal],
          create_prep_tasks: form.create_prep_tasks,
        });
        toast.success('Scheduled in TaskFlow — nothing was sent to anyone outside');
      }
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
      title={rescheduling ? `Move: ${meeting.title}` : 'Schedule a meeting or demo'}
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : rescheduling ? 'Move it' : 'Schedule it'}
          </button>
        </>
      }
    >
      <div className="stack">
        {!rescheduling && (
          <>
            <div className="grid-2">
              <Field label="What kind?">
                <select className="select" value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
                  {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </Field>
              <Field label="Where?">
                <select className="select" value={form.mode} onChange={(e) => set({ mode: e.target.value })}>
                  <option value="IN_PERSON">In person</option>
                  <option value="VIRTUAL">Online</option>
                </select>
              </Field>
            </div>
            <Field label="Title *">
              <input className="input" autoFocus value={form.title}
                onChange={(e) => set({ title: e.target.value })}
                placeholder="Soil Doctor demo at their Pune office" />
            </Field>
            <Field label="What is it for?" hint="One line on what you want out of it">
              <input className="input" value={form.objective}
                onChange={(e) => set({ objective: e.target.value })}
                placeholder="Show the device and the advisory flow end to end" />
            </Field>
            {opportunities.length > 0 && (
              <Field label="Which deal?">
                <select className="select" value={form.opportunity_id}
                  onChange={(e) => set({ opportunity_id: e.target.value })}>
                  <option value="">Not about a specific deal</option>
                  {opportunities.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </Field>
            )}
          </>
        )}

        <div className="grid-2">
          <Field label={rescheduling ? 'New date and time *' : 'When *'}>
            <input className="input" type="datetime-local" value={form.scheduled_at}
              onChange={(e) => set({ scheduled_at: e.target.value })} />
          </Field>
          {!rescheduling && (
            <Field label="How long (minutes)">
              <input className="input" type="number" min="5" step="15" value={form.duration_min}
                onChange={(e) => set({ duration_min: e.target.value })} />
            </Field>
          )}
        </div>

        {rescheduling && (
          <Field label="Why is it moving?" hint="Kept on the record so a pattern of slipping is visible">
            <input className="input" value={form.reason}
              onChange={(e) => set({ reason: e.target.value })}
              placeholder="Dr Rao is travelling that week" />
          </Field>
        )}

        {!rescheduling && (
          <>
            {form.mode === 'IN_PERSON' ? (
              <Field label="Where exactly">
                <input className="input" value={form.location}
                  onChange={(e) => set({ location: e.target.value })}
                  placeholder="KVF head office, Pune" />
              </Field>
            ) : (
              <Field label="Joining link">
                <input className="input" value={form.meeting_url}
                  onChange={(e) => set({ meeting_url: e.target.value })}
                  placeholder="https://meet.example.com/…" />
              </Field>
            )}

            {form.kind === 'DEMO' && (
              <>
                <Field label="What are you demonstrating?">
                  <input className="input" value={form.demo_type}
                    onChange={(e) => set({ demo_type: e.target.value })}
                    placeholder="Device + advisory app, full flow" />
                </Field>
                <Field label="What has to be ready first?">
                  <textarea className="textarea" rows={2} value={form.prerequisites}
                    onChange={(e) => set({ prerequisites: e.target.value })}
                    placeholder="Charged device, sample soil, offline mode tested" />
                </Field>
              </>
            )}

            {contacts.length > 0 && (
              <Field label="Who from their side?">
                <div className="row wrap" style={{ gap: 6 }}>
                  {contacts.map((contact) => (
                    <button key={contact.id} type="button"
                      className={`kind-chip${participants.has(contact.id) ? ' is-active' : ''}`}
                      onClick={() => toggle(setParticipants)(contact.id)}>
                      {contact.full_name}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            <Field label="Who from ours?">
              <div className="row wrap" style={{ gap: 6 }}>
                {users.slice(0, 12).map((user) => (
                  <button key={user.id} type="button"
                    className={`kind-chip${internal.has(user.id) ? ' is-active' : ''}`}
                    onClick={() => toggle(setInternal)(user.id)}>
                    {user.full_name}
                  </button>
                ))}
              </div>
            </Field>

            <label className="checklist-item" style={{ padding: 0 }}>
              <input type="checkbox" checked={form.create_prep_tasks}
                onChange={(e) => set({ create_prep_tasks: e.target.checked })} />
              <span>
                Create the preparation tasks. They are ordinary TaskFlow tasks and appear in
                the owner's My Tasks.
              </span>
            </label>

            <div className="small muted">
              This is a record in TaskFlow. No calendar invitation or message is sent to anyone
              outside — send those yourself.
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** What came of it — the only thing that turns a booking into evidence. */
function OutcomeDialog({ meeting, contacts, onClose, onSaved }) {
  const toast = useToast();
  const [status, setStatus] = useState('COMPLETED');
  const [form, setForm] = useState({
    outcome: '', objections_raised: '', validations_requested: '',
    questions_raised: '', next_decision: '', cancel_reason: '',
    follow_up_title: '',
  });
  const [attended, setAttended] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const save = async () => {
    if (status === 'COMPLETED' && form.outcome.trim().length < 3) {
      return toast.error('Say what came of it — a demo with no outcome recorded is the same as one that never happened');
    }
    if (status === 'CANCELLED' && !form.cancel_reason.trim()) {
      return toast.error('Say why it was cancelled');
    }
    setSaving(true);
    try {
      await api.recordMeetingOutcome(meeting.id, {
        status,
        outcome: form.outcome.trim() || undefined,
        objections_raised: form.objections_raised.trim() || undefined,
        validations_requested: form.validations_requested.trim() || undefined,
        questions_raised: form.questions_raised.trim() || undefined,
        next_decision: form.next_decision.trim() || undefined,
        cancel_reason: form.cancel_reason.trim() || undefined,
        attended_contact_ids: [...attended],
        follow_up: form.follow_up_title.trim()
          ? { title: form.follow_up_title.trim() }
          : undefined,
      });
      toast.success(status === 'COMPLETED' ? 'Recorded' : `Marked ${status.toLowerCase().replace('_', ' ')}`);
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
      title={`What came of: ${meeting.title}`}
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Record it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="What happened?">
          <div className="row wrap" style={{ gap: 6 }}>
            {[['COMPLETED', 'It happened'], ['CANCELLED', 'Cancelled'], ['NO_SHOW', 'They did not turn up']]
              .map(([value, label]) => (
                <button key={value} type="button"
                  className={`kind-chip${status === value ? ' is-active' : ''}`}
                  onClick={() => setStatus(value)}>
                  {label}
                </button>
              ))}
          </div>
        </Field>

        {status === 'COMPLETED' ? (
          <>
            <Field label="How did it go? *">
              <textarea className="textarea" rows={3} autoFocus value={form.outcome}
                onChange={(e) => set({ outcome: e.target.value })}
                placeholder="Showed the device and the advisory flow. Dr Rao wants lab correlation data before recommending." />
            </Field>
            {contacts.length > 0 && (
              <Field label="Who actually turned up?" hint="Not the same as who was invited">
                <div className="row wrap" style={{ gap: 6 }}>
                  {contacts.map((contact) => (
                    <button key={contact.id} type="button"
                      className={`kind-chip${attended.has(contact.id) ? ' is-active' : ''}`}
                      onClick={() => setAttended((c) => {
                        const next = new Set(c);
                        if (next.has(contact.id)) next.delete(contact.id); else next.add(contact.id);
                        return next;
                      })}>
                      {contact.full_name}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            <div className="grid-2">
              <Field label="What did they push back on?">
                <textarea className="textarea" rows={2} value={form.objections_raised}
                  onChange={(e) => set({ objections_raised: e.target.value })} />
              </Field>
              <Field label="What proof did they ask for?">
                <textarea className="textarea" rows={2} value={form.validations_requested}
                  onChange={(e) => set({ validations_requested: e.target.value })} />
              </Field>
            </div>
            <Field label="What are they deciding next?">
              <input className="input" value={form.next_decision}
                onChange={(e) => set({ next_decision: e.target.value })}
                placeholder="Whether to fund a 2,000-farmer pilot" />
            </Field>
          </>
        ) : (
          <Field label="Why? *">
            <textarea className="textarea" rows={2} autoFocus value={form.cancel_reason}
              onChange={(e) => set({ cancel_reason: e.target.value })}
              placeholder="They postponed to after the harvest" />
          </Field>
        )}

        <Field
          label="What happens next?"
          hint="Creates one ordinary TaskFlow task, assigned to the meeting owner"
        >
          <input className="input" value={form.follow_up_title}
            onChange={(e) => set({ follow_up_title: e.target.value })}
            placeholder="Send the lab correlation report to Dr Rao" />
        </Field>
      </div>
    </Modal>
  );
}

export default function CrmMeetings({ accountId, opportunities, contacts, canEdit, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [scheduling, setScheduling] = useState(false);
  const [moving, setMoving] = useState(null);
  const [recording, setRecording] = useState(null);
  const [open, setOpen] = useState(null);

  const load = () => {
    api.meetings({ account_id: accountId })
      .then((result) => setData(result.meetings))
      .catch((err) => toast.error(err));
  };

  useEffect(load, [accountId]);

  if (!data) return <Spinner label="Loading meetings" />;

  const awaiting = data.filter((m) => m.awaiting_outcome);
  const upcoming = data.filter((m) => m.is_upcoming);
  const past = data.filter((m) => !m.awaiting_outcome && !m.is_upcoming);

  const refresh = () => { load(); onChanged?.(); };

  const Card = ({ meeting }) => {
    const meta = STATUS_META[meeting.status] || STATUS_META.SCHEDULED;
    const expanded = open === meeting.id;
    return (
      <div className={`meeting${meeting.awaiting_outcome ? ' is-awaiting' : ''}`}>
        <button type="button" className="meeting-head" onClick={() => setOpen(expanded ? null : meeting.id)}>
          <span className={`meeting-icon meeting-${meeting.kind.toLowerCase()}`}>
            <Icon name={meeting.kind === 'DEMO' ? 'board' : 'team'} size={14} />
          </span>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="row wrap" style={{ gap: 6 }}>
              <strong style={{ fontSize: 13.5 }}>{meeting.title}</strong>
              <Badge tone={meta.tone}>{meta.label}</Badge>
              {meeting.was_rescheduled && (
                <Badge tone="neutral" title={`First set for ${formatDate(meeting.first_scheduled_at)}`}>
                  moved {meeting.reschedule_count}×
                </Badge>
              )}
            </span>
            <span className="small muted row wrap" style={{ gap: 6, marginTop: 2 }}>
              <span>{inZone(meeting.scheduled_at, meeting.timezone)}</span>
              <span>·</span>
              <span>{meeting.mode === 'IN_PERSON' ? meeting.location || 'In person' : 'Online'}</span>
              {meeting.prep_total > 0 && (
                <><span>·</span><span>prep {meeting.prep_done}/{meeting.prep_total}</span></>
              )}
              {meeting.opportunity_name && <><span>·</span><span>{meeting.opportunity_name}</span></>}
            </span>
          </span>
          <Icon name="chevron" size={13} style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />
        </button>

        {meeting.awaiting_outcome && (
          <div className="meeting-awaiting">
            <Icon name="alert" size={14} />
            <span className="grow small">
              This has been and gone with nothing recorded. Until somebody says what came of it,
              it counts as neither having happened nor not.
            </span>
            {canEdit && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setRecording(meeting)}>
                Record it
              </button>
            )}
          </div>
        )}

        {expanded && (
          <div className="meeting-body">
            {meeting.objective && <p className="small"><strong>For:</strong> {meeting.objective}</p>}
            {meeting.participants?.length > 0 && (
              <div className="row wrap" style={{ gap: 8 }}>
                {meeting.participants.map((p, index) => (
                  <span key={`${p.user_id || 'c'}-${p.contact_id || index}`} className="row" style={{ gap: 5 }}>
                    <Avatar name={p.name || '?'} color={p.color} size={20} />
                    <span className="small">
                      {p.name}
                      {p.external && <span className="muted"> · theirs</span>}
                      {p.attended === true && <span className="attended"> · attended</span>}
                      {p.attended === false && meeting.happened && <span className="muted"> · did not</span>}
                    </span>
                  </span>
                ))}
              </div>
            )}

            {meeting.outcome && (
              <div className="record-block" style={{ padding: 10 }}>
                <div className="record-block-title">What came of it</div>
                <p className="record-text">{meeting.outcome}</p>
                {meeting.objections_raised && (
                  <div className="small"><strong>Pushed back on:</strong> {meeting.objections_raised}</div>
                )}
                {meeting.validations_requested && (
                  <div className="small"><strong>Proof asked for:</strong> {meeting.validations_requested}</div>
                )}
                {meeting.next_decision && (
                  <div className="small"><strong>Deciding next:</strong> {meeting.next_decision}</div>
                )}
              </div>
            )}
            {meeting.cancel_reason && (
              <div className="small muted">Cancelled: {meeting.cancel_reason}</div>
            )}

            {canEdit && (
              <div className="row wrap">
                {meeting.status === 'SCHEDULED' && (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => setMoving(meeting)}>
                      Move it
                    </button>
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => setRecording(meeting)}>
                      Record the outcome
                    </button>
                  </>
                )}
                {!meeting.prep_total && meeting.status === 'SCHEDULED' && (
                  <button type="button" className="btn btn-sm" onClick={async () => {
                    try {
                      const result = await api.addMeetingPrepTasks(meeting.id);
                      if (result.created) toast.success(`${result.created} preparation tasks created`);
                      else toast.error(result.note || 'Nothing was created');
                      refresh();
                    } catch (err) { toast.error(err); }
                  }}>
                    Add preparation tasks
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>Meetings & demos</h2>
          <div className="small muted">
            A meeting in the diary and a meeting that happened are different things.
          </div>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setScheduling(true)}>
            <Icon name="plus" size={14} /> Schedule one
          </button>
        )}
      </div>

      {data.length === 0 ? (
        <EmptyState title="Nothing scheduled or recorded">
          In-person meetings and demos are what move these relationships. Schedule one, or record
          one that already happened.
        </EmptyState>
      ) : (
        <div className="stack-sm">
          {awaiting.length > 0 && (
            <>
              <div className="stat-label">Waiting for an outcome</div>
              {awaiting.map((m) => <Card key={m.id} meeting={m} />)}
            </>
          )}
          {upcoming.length > 0 && (
            <>
              <div className="stat-label" style={{ marginTop: 6 }}>Coming up</div>
              {upcoming.map((m) => <Card key={m.id} meeting={m} />)}
            </>
          )}
          {past.length > 0 && (
            <>
              <div className="stat-label" style={{ marginTop: 6 }}>Already happened</div>
              {past.map((m) => <Card key={m.id} meeting={m} />)}
            </>
          )}
        </div>
      )}

      {scheduling && (
        <ScheduleDialog accountId={accountId} opportunities={opportunities} contacts={contacts}
          onClose={() => setScheduling(false)} onSaved={refresh} />
      )}
      {moving && (
        <ScheduleDialog accountId={accountId} opportunities={opportunities} contacts={contacts}
          meeting={moving} onClose={() => setMoving(null)} onSaved={refresh} />
      )}
      {recording && (
        <OutcomeDialog meeting={recording} contacts={contacts}
          onClose={() => setRecording(null)} onSaved={refresh} />
      )}
    </section>
  );
}
