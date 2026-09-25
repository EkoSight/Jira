import { useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal } from './ui.jsx';
import { CONTACT_ROLES, PREFERRED_CHANNELS, ROLE_LABEL } from '../lib/crm.js';

/**
 * The people at the organization.
 *
 * These are records of external stakeholders. Adding someone here never creates
 * a TaskFlow user, sends an invitation, or messages them — which is why the
 * form asks for a LinkedIn profile and a WhatsApp number rather than a login.
 */

const CHANNEL_LINK = {
  EMAIL: (c) => (c.email ? `mailto:${c.email}` : null),
  PHONE: (c) => (c.phone ? `tel:${c.phone.replace(/\s/g, '')}` : null),
  WHATSAPP: (c) => (c.whatsapp ? `https://wa.me/${c.whatsapp.replace(/\D/g, '')}` : null),
  LINKEDIN: (c) => c.linkedin_url || null,
};

/** Opens the channel this person actually answers on. Nothing is sent for them. */
function ChannelLinks({ contact }) {
  const links = [
    ['EMAIL', 'link', contact.email],
    ['PHONE', 'bell', contact.phone],
    ['WHATSAPP', 'sound', contact.whatsapp],
    ['LINKEDIN', 'user', contact.linkedin_url],
  ].filter(([, , value]) => value);

  if (!links.length) return <span className="small muted">No contact details yet</span>;

  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {links.map(([channel, icon, value]) => {
        const href = CHANNEL_LINK[channel]?.(contact);
        const preferred = contact.preferred_channel === channel;
        return (
          <a
            key={channel}
            className={`channel-chip${preferred ? ' is-preferred' : ''}`}
            href={href || undefined}
            target={channel === 'LINKEDIN' ? '_blank' : undefined}
            rel="noopener noreferrer"
            title={preferred ? `${value} — prefers this channel` : value}
          >
            <Icon name={icon} size={12} />
            <span className="truncate">{value}</span>
          </a>
        );
      })}
    </div>
  );
}

function ContactDialog({ accountId, contact, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(contact);
  const [form, setForm] = useState(() => ({
    full_name: contact?.full_name || '',
    designation: contact?.designation || '',
    department: contact?.department || '',
    email: contact?.email || '',
    phone: contact?.phone || '',
    whatsapp: contact?.whatsapp || '',
    linkedin_url: contact?.linkedin_url || '',
    location: contact?.location || '',
    preferred_channel: contact?.preferred_channel || '',
    influence: contact?.influence || '',
    notes: contact?.notes || '',
    is_primary: contact?.is_primary || false,
  }));
  const [saving, setSaving] = useState(false);
  const [duplicates, setDuplicates] = useState([]);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const save = async () => {
    if (form.full_name.trim().length < 2) return toast.error('Give the contact a name');
    setSaving(true);
    try {
      const payload = {
        ...form,
        preferred_channel: form.preferred_channel || null,
        influence: form.influence || null,
      };
      if (editing) {
        await api.updateContact(accountId, contact.id, payload);
        toast.success('Contact updated');
        onSaved();
        onClose();
        return;
      }
      const result = await api.addContact(accountId, payload);
      // a near-match is shown, never merged: two people at one organization can
      // share a surname, and a shared domain proves only that they work together
      if (result.possible_duplicates?.length) {
        setDuplicates(result.possible_duplicates);
        toast.success('Contact added — check the possible duplicate below');
        onSaved();
        return;
      }
      toast.success('Contact added');
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
      title={editing ? 'Edit contact' : 'Add a contact'}
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {duplicates.length ? 'Done' : 'Cancel'}
          </button>
          {!duplicates.length && (
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Add'}
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        {duplicates.length > 0 && (
          <div className="ask-banner ask-warning">
            <Icon name="alert" size={15} />
            <div className="grow">
              <strong>Possibly the same person</strong>
              <div className="small">
                {duplicates.map((d) => d.full_name + (d.email ? ` (${d.email})` : '')).join(', ')} already
                exists here. Both records have been kept — merge them yourself if they are the same person.
              </div>
            </div>
          </div>
        )}

        <div className="small muted">
          A record of someone at the organization. They do not become a TaskFlow user and
          nothing is sent to them.
        </div>

        <div className="grid-2">
          <Field label="Name *">
            <input className="input" autoFocus value={form.full_name}
              onChange={(e) => set({ full_name: e.target.value })} placeholder="Meera Joshi" />
          </Field>
          <Field label="Designation">
            <input className="input" value={form.designation}
              onChange={(e) => set({ designation: e.target.value })} placeholder="Programme Director" />
          </Field>
          <Field label="Department">
            <input className="input" value={form.department}
              onChange={(e) => set({ department: e.target.value })} placeholder="CSR" />
          </Field>
          <Field label="Location">
            <input className="input" value={form.location}
              onChange={(e) => set({ location: e.target.value })} placeholder="Pune" />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Email">
            <input className="input" type="email" value={form.email}
              onChange={(e) => set({ email: e.target.value })} />
          </Field>
          <Field label="Phone" hint="Any country — not assumed to be Indian">
            <input className="input" value={form.phone}
              onChange={(e) => set({ phone: e.target.value })} placeholder="+91 98200 11111" />
          </Field>
          <Field label="WhatsApp">
            <input className="input" value={form.whatsapp}
              onChange={(e) => set({ whatsapp: e.target.value })} />
          </Field>
          <Field label="LinkedIn">
            <input className="input" value={form.linkedin_url}
              onChange={(e) => set({ linkedin_url: e.target.value })} placeholder="https://linkedin.com/in/…" />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Prefers to be reached by">
            <select className="select" value={form.preferred_channel}
              onChange={(e) => set({ preferred_channel: e.target.value })}>
              <option value="">Not known</option>
              {PREFERRED_CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Influence" hint="Your read on it, not something the system worked out">
            <select className="select" value={form.influence}
              onChange={(e) => set({ influence: e.target.value })}>
              <option value="">Not assessed</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
          </Field>
        </div>

        <Field label="Notes">
          <textarea className="textarea" rows={3} value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Ran the Nashik programme; wants evidence before committing budget." />
        </Field>

        <label className="checklist-item" style={{ padding: 0 }}>
          <input type="checkbox" checked={form.is_primary}
            onChange={(e) => set({ is_primary: e.target.checked })} />
          <span>Primary contact for this organization</span>
        </label>
      </div>
    </Modal>
  );
}

function RoleDialog({ contact, opportunities, onClose, onSaved }) {
  const toast = useToast();
  const [opportunityId, setOpportunityId] = useState(opportunities[0]?.id || '');
  const [role, setRole] = useState('STAKEHOLDER');
  const [involvement, setInvolvement] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!opportunityId) return toast.error('Pick the opportunity');
    setSaving(true);
    try {
      await api.linkOpportunityContact(Number(opportunityId), {
        contact_id: contact.id,
        role,
        involvement: involvement || null,
      });
      toast.success(`${contact.full_name} added as ${ROLE_LABEL[role]}`);
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
      title={`${contact.full_name}'s part in a deal`}
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Add'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          The same person can be the champion on one deal and the approver on another, so
          the role belongs to the deal rather than to them.
        </div>
        <Field label="Opportunity">
          <select className="select" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)}>
            {opportunities.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Role">
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            {CONTACT_ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </Field>
        <Field label="How involved are they?" hint="Your assessment">
          <select className="select" value={involvement} onChange={(e) => setInvolvement(e.target.value)}>
            <option value="">Not assessed</option>
            <option value="HIGH">Closely involved</option>
            <option value="MEDIUM">Somewhat involved</option>
            <option value="LOW">Barely involved</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

export default function CrmPeople({ accountId, contacts, opportunities, canEdit, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [rolesFor, setRolesFor] = useState(null);

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>People</h2>
          <div className="small muted">Who is at the organization, and what part they play.</div>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Add a contact
          </button>
        )}
      </div>

      {contacts.length === 0 ? (
        <EmptyState title="Nobody recorded yet">
          A relationship is with people, not with a company name. Add whoever you have spoken to,
          even if all you have is a first name.
        </EmptyState>
      ) : (
        <div className="stack-sm">
          {contacts.map((contact) => (
            <div key={contact.id} className="contact-card">
              <Avatar name={contact.full_name} color={contact.photo_url ? undefined : '#2a78d6'} size={34} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <strong style={{ fontSize: 13.5 }}>{contact.full_name}</strong>
                  {contact.is_primary && <Badge tone="brand">Primary</Badge>}
                  {contact.influence && (
                    <Badge tone={contact.influence === 'HIGH' ? 'good' : 'neutral'}
                      title="Entered by a person, not worked out by the system">
                      {contact.influence.toLowerCase()} influence
                    </Badge>
                  )}
                </div>
                {(contact.designation || contact.department) && (
                  <div className="small muted">
                    {[contact.designation, contact.department, contact.location].filter(Boolean).join(' · ')}
                  </div>
                )}
                <div style={{ marginTop: 5 }}><ChannelLinks contact={contact} /></div>
                {contact.roles?.length > 0 && (
                  <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
                    {contact.roles.map((r) => (
                      <span key={`${r.opportunity_id}-${r.role}`} className="role-chip"
                        title={r.opportunity_name}>
                        {ROLE_LABEL[r.role] || r.role}
                        <span className="muted"> · {r.opportunity_name}</span>
                      </span>
                    ))}
                  </div>
                )}
                {contact.notes && <div className="small" style={{ marginTop: 5 }}>{contact.notes}</div>}
              </div>

              {canEdit && (
                <div className="row" style={{ gap: 4 }}>
                  {opportunities.length > 0 && (
                    <button type="button" className="btn btn-sm" onClick={() => setRolesFor(contact)}>
                      Role
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-icon btn-sm"
                    aria-label={`Edit ${contact.full_name}`} onClick={() => setEditing(contact)}>
                    <Icon name="edit" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label={`Mark ${contact.full_name} inactive`}
                    title="Mark inactive — their history is kept"
                    onClick={async () => {
                      try {
                        await api.deactivateContact(accountId, contact.id);
                        toast.success(`${contact.full_name} marked inactive`);
                        onChanged();
                      } catch (err) {
                        toast.error(err);
                      }
                    }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(adding || editing) && (
        <ContactDialog
          accountId={accountId}
          contact={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={onChanged}
        />
      )}
      {rolesFor && (
        <RoleDialog
          contact={rolesFor}
          opportunities={opportunities}
          onClose={() => setRolesFor(null)}
          onSaved={onChanged}
        />
      )}
    </section>
  );
}
