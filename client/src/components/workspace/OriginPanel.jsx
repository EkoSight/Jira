/**
 * Where a lead, deal or application came from, kept apart: the original and
 * latest source, the free-text referral, who introduced it (a colleague or a
 * contact), who created it and when, the owner, and every assignment with who
 * made it. Changing "introduced by" is recorded; nothing here rewrites the
 * source or the record's age.
 *
 * Also: on a deal changing hands, the work on it that belongs to someone else
 * (HandoverCheck). Nothing moves until the person chooses.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useRefData, useToast } from '../../state/AppState.jsx';
import { Modal, Spinner } from '../ui.jsx';
import { whenWords } from '../../lib/workspace.js';

export function OriginPanel({ kind, id, canEdit = false, accountId = null }) {
  const toast = useToast();
  const { users } = useRefData();
  const [o, setO] = useState(null);
  const [editing, setEditing] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [form, setForm] = useState({ who: 'none', user: '', contact: '', reason: '' });
  const load = () => api.get(`/workspace/origin/${kind}/${id}`).then(setO).catch(() => setO(false));
  useEffect(() => { load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (editing && accountId) api.accountContacts(accountId).then((r) => setContacts(r.contacts || [])).catch(() => setContacts([])); }, [editing, accountId]);
  if (o === null) return <Spinner label="Loading where it came from" />;
  if (o === false) return null;
  const introduced = o.introduced_by_user_name ? `${o.introduced_by_user_name} (colleague)` : o.introduced_by_contact_name ? `${o.introduced_by_contact_name} (contact)` : 'Not recorded';
  const save = async () => {
    try {
      await api.put(`/workspace/origin/${kind}/${id}`, {
        introduced_by_user_id: form.who === 'user' && form.user ? Number(form.user) : null,
        introduced_by_contact_id: form.who === 'contact' && form.contact ? Number(form.contact) : null,
        reason: form.reason || null,
      });
      toast.success('Saved, and recorded in the history');
      setEditing(false);
      load();
    } catch (err) { toast.error(err); }
  };
  const rows = [
    kind === 'lead' && ['Original source', o.original_source || 'Not recorded'],
    kind === 'lead' && ['Latest source', [o.latest_source, o.latest_campaign].filter(Boolean).join(' · ') || 'Not recorded'],
    kind !== 'lead' && ['Source', o.source || 'Not recorded'],
    ['Referral (as written)', o.referral || '—'],
    ['Introduced by', introduced],
    ['Created', `${o.created_by_name || 'Unknown'} · ${whenWords({ at: o.created_at })}`],
    ['Owner now', o.owner_name || 'Nobody'],
    kind !== 'lead' && o.helpers?.length && ['Helping', o.helpers.join(', ')],
    kind === 'lead' && ['Last time they reached us', o.last_incoming_at ? whenWords({ at: o.last_incoming_at }) : 'None recorded'],
    kind === 'lead' && ['Last two-way contact', o.last_contacted_at ? whenWords({ at: o.last_contacted_at }) : 'None recorded'],
  ].filter(Boolean);
  return (
    <section className="card" aria-labelledby={`origin-${kind}-${id}`}>
      <div className="card-head">
        <h2 id={`origin-${kind}-${id}`}>Where it came from</h2>
        {canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setForm({ who: o.introduced_by_user_id ? 'user' : o.introduced_by_contact_id ? 'contact' : 'none', user: o.introduced_by_user_id || '', contact: o.introduced_by_contact_id || '', reason: '' }); setEditing(true); }}>Change introduced by</button>}
      </div>
      <dl className="card-pad stack-sm" style={{ margin: 0 }}>
        {rows.map(([k, v]) => <div key={k} className="row-between wrap"><dt className="small muted">{k}</dt><dd style={{ margin: 0 }} className="small">{v}</dd></div>)}
        {o.assignments?.length > 0 && (
          <div>
            <dt className="small muted">Changes of owner</dt>
            <dd style={{ margin: 0 }}>
              <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {o.assignments.map((a, i) => <li key={i}>{a.from_name || a.from_value || 'nobody'} → {a.to_name || a.to_value} · by {a.by_name || 'the system'} · {whenWords({ at: a.created_at })}{a.reason ? ` · ${a.reason}` : ''}</li>)}
              </ul>
            </dd>
          </div>
        )}
      </dl>
      {editing && (
        <Modal title="Who introduced it" onClose={() => setEditing(false)}
          footer={<><button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>The source and the free-text referral stay as they are. This change is recorded.</p>
            <div className="row wrap" role="radiogroup" aria-label="Introduced by" style={{ gap: 12 }}>
              {[['none', 'Nobody recorded'], ['user', 'A colleague'], ['contact', 'A contact']].map(([k, label]) => (
                <label key={k} className="row small" style={{ gap: 6 }}><input type="radio" name="who" checked={form.who === k} disabled={k === 'contact' && !accountId} onChange={() => setForm({ ...form, who: k })} />{label}</label>
              ))}
            </div>
            {form.who === 'user' && (
              <select className="select" aria-label="Colleague" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })}>
                <option value="">Choose a colleague</option>
                {users.filter((u) => u.is_active !== false).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            )}
            {form.who === 'contact' && (
              <select className="select" aria-label="Contact" value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })}>
                <option value="">Choose a contact</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
              </select>
            )}
            <label className="field"><span className="field-label">Why (optional)</span><input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function HandoverCheck({ opportunityId, toUserId, toName, onClose }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [meetings, setMeetings] = useState([]);
  useEffect(() => {
    api.get('/workspace/handover-check', { opportunity_id: opportunityId, to_user_id: toUserId }).then((r) => {
      if (!r.tasks.length && !r.meetings.length) { onClose(); return; }
      setD(r);
    }).catch(() => onClose());
  }, [opportunityId, toUserId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  const toggle = (list, setList, id) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const move = async () => {
    try {
      const r = await api.post('/workspace/handover-reassign', { opportunity_id: opportunityId, to_user_id: toUserId, task_ids: tasks, meeting_ids: meetings });
      toast.success(`Moved ${r.moved.tasks.length} task${r.moved.tasks.length === 1 ? '' : 's'} and ${r.moved.meetings.length} meeting${r.moved.meetings.length === 1 ? '' : 's'} to ${toName}`);
      onClose();
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title={`Work on this deal not owned by ${toName}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Leave them as they are</button><button type="button" className="btn btn-primary" disabled={!tasks.length && !meetings.length} onClick={move}>Move the chosen ones to {toName}</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{d.note} Personal reminders stay with the people who set them.</p>
        {d.tasks.length > 0 && <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}><legend className="field-label">Open tasks</legend>
          {d.tasks.map((t) => <label key={t.id} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={tasks.includes(t.id)} onChange={() => toggle(tasks, setTasks, t.id)} />{t.ref} {t.title} · {t.assignee_name || 'nobody'}</label>)}
        </fieldset>}
        {d.meetings.length > 0 && <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}><legend className="field-label">Meetings</legend>
          {d.meetings.map((m) => <label key={m.id} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={meetings.includes(m.id)} onChange={() => toggle(meetings, setMeetings, m.id)} />{m.title} · {m.owner_name || 'nobody'}</label>)}
        </fieldset>}
      </div>
    </Modal>
  );
}
