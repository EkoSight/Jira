import { useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Field, Modal } from './ui.jsx';

/**
 * Adding or editing a lead. Only the name is required — a lead often starts as
 * little more than a company and a hunch, and the rest is filled in as you learn.
 */
export default function AccountDialog({ account, stages = [], onClose, onSaved }) {
  const { user } = useAuth();
  const { departments, users } = useRefData();
  const toast = useToast();
  const editing = Boolean(account);

  const [form, setForm] = useState(() => ({
    name: account?.name || '',
    stage_id: account?.stage_id || stages[0]?.id || '',
    owner_user_id: account?.owner_user_id ?? user.id,
    follower_user_id: account?.follower_user_id ?? '',
    department_id: account?.department_id ?? user.department_id ?? '',
    value: account?.value ?? '',
    source: account?.source || '',
    website: account?.website || '',
    contact_name: account?.contact_name || '',
    contact_email: account?.contact_email || '',
    contact_phone: account?.contact_phone || '',
    next_step: account?.next_step || '',
    next_step_due: account?.next_step_due?.slice(0, 10) || '',
    description: account?.description || '',
  }));
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const save = async () => {
    if (form.name.trim().length < 2) return toast.error('Give the lead a name');
    const payload = {
      name: form.name.trim(),
      owner_user_id: form.owner_user_id ? Number(form.owner_user_id) : null,
      follower_user_id: form.follower_user_id ? Number(form.follower_user_id) : null,
      department_id: form.department_id ? Number(form.department_id) : null,
      value: form.value === '' ? null : Number(form.value),
      source: form.source.trim() || null,
      website: form.website.trim() || null,
      contact_name: form.contact_name.trim() || null,
      contact_email: form.contact_email.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
      next_step: form.next_step.trim() || null,
      next_step_due: form.next_step_due || null,
      description: form.description.trim() || null,
    };
    if (!editing && form.stage_id) payload.stage_id = Number(form.stage_id);

    setSaving(true);
    try {
      const result = editing
        ? await api.updateAccount(account.id, payload)
        : await api.createAccount(payload);
      toast.success(editing ? 'Saved' : 'Lead added');
      onSaved(result.account);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? 'Edit lead' : 'New lead'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add lead'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Company / lead name">
          <input className="input" value={form.name} autoFocus onChange={(e) => set({ name: e.target.value })}
            placeholder="Acme Agro Pvt Ltd" />
        </Field>

        <div className="grid-2">
          <Field label="Leading it" hint="Accountable for moving this deal">
            <select className="select" value={form.owner_user_id} onChange={(e) => set({ owner_user_id: e.target.value })}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Following it" hint="Kept in the loop on every touch">
            <select className="select" value={form.follower_user_id} onChange={(e) => set({ follower_user_id: e.target.value })}>
              <option value="">Nobody</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Department">
            <select className="select" value={form.department_id} onChange={(e) => set({ department_id: e.target.value })}>
              <option value="">None</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Deal value" hint="Roughly what it's worth — powers the pipeline total">
            <input className="input" type="number" min="0" value={form.value}
              onChange={(e) => set({ value: e.target.value })} placeholder="500000" />
          </Field>
        </div>

        {!editing && (
          <Field label="Starting stage">
            <select className="select" value={form.stage_id} onChange={(e) => set({ stage_id: e.target.value })}>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
        )}

        <div className="grid-2">
          <Field label="Contact name">
            <input className="input" value={form.contact_name} onChange={(e) => set({ contact_name: e.target.value })} />
          </Field>
          <Field label="Source" hint="Referral, event, inbound…">
            <input className="input" value={form.source} onChange={(e) => set({ source: e.target.value })} />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Contact email">
            <input className="input" value={form.contact_email} onChange={(e) => set({ contact_email: e.target.value })} />
          </Field>
          <Field label="Contact phone">
            <input className="input" value={form.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Next step" hint="What moves this forward next">
            <input className="input" value={form.next_step} onChange={(e) => set({ next_step: e.target.value })}
              placeholder="Send the intro deck" />
          </Field>
          <Field label="By when">
            <input className="input" type="date" value={form.next_step_due}
              onChange={(e) => set({ next_step_due: e.target.value })} />
          </Field>
        </div>

        <Field label="Notes">
          <textarea className="textarea" rows={2} value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="What they need, who the champion is, anything worth remembering." />
        </Field>
      </div>
    </Modal>
  );
}
