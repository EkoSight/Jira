import { useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Field, Modal } from './ui.jsx';
import { MEASUREMENT_TYPES, OBJECTIVE_STATUSES } from '../lib/okr.js';

/**
 * Editing a key result after the fact — most often to give one the target it was
 * created without, which is the difference between a goal that reports progress
 * and one that reads as dead.
 */
export default function KeyResultEditDialog({ keyResult, onClose, onSaved }) {
  const { users } = useRefData();
  const toast = useToast();

  const [form, setForm] = useState(() => ({
    title: keyResult.title || '',
    description: keyResult.description || '',
    owner_user_id: keyResult.owner_user_id ?? '',
    measurement_type: keyResult.measurement_type || 'NUMBER',
    direction: keyResult.direction || 'INCREASE',
    baseline_value: keyResult.baseline_value ?? 0,
    target_value: keyResult.target_value ?? '',
    unit: keyResult.unit || '',
    weight: keyResult.weight ?? 1,
    status: keyResult.status || 'ACTIVE',
  }));
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const scored = !['BINARY', 'TASK_ROLLUP'].includes(form.measurement_type);

  const save = async () => {
    if (form.title.trim().length < 2) return toast.error('Give the key result a title');
    if (scored && form.target_value === '') {
      return toast.error('Set a target — without one there is no number to measure against');
    }

    setSaving(true);
    try {
      await api.updateKeyResult(keyResult.id, {
        title: form.title.trim(),
        description: form.description.trim() || null,
        owner_user_id: Number(form.owner_user_id),
        measurement_type: form.measurement_type,
        direction: form.direction,
        baseline_value: Number(form.baseline_value) || 0,
        target_value: scored ? Number(form.target_value) : form.measurement_type === 'BINARY' ? 1 : null,
        unit: form.unit.trim() || null,
        weight: Number(form.weight) || 1,
        status: form.status,
      });
      toast.success('Key result updated');
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
      title="Edit key result"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="stack">
        {keyResult.needs_target && (
          <div className="complete-intro complete-late">
            This key result has no target, so its own outcome cannot be scored — the percentage you
            see is how much of its linked work is finished. Set a target below to measure the result
            itself.
          </div>
        )}

        <Field label="What gets measured?">
          <input className="input" value={form.title} autoFocus onChange={(e) => set({ title: e.target.value })} />
        </Field>

        <Field
          label="How is it measured?"
          hint={MEASUREMENT_TYPES.find((m) => m.value === form.measurement_type)?.hint}
        >
          <select className="select" value={form.measurement_type}
            onChange={(e) => set({ measurement_type: e.target.value })}>
            {MEASUREMENT_TYPES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </Field>

        {scored && (
          <>
            <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label="From">
                <input className="input" type="number" step="any" value={form.baseline_value}
                  onChange={(e) => set({ baseline_value: e.target.value })} />
              </Field>
              <Field label="To (target)">
                <input className="input" type="number" step="any" value={form.target_value}
                  onChange={(e) => set({ target_value: e.target.value })} placeholder="Required" />
              </Field>
              <Field label="Unit">
                <input className="input" value={form.unit} onChange={(e) => set({ unit: e.target.value })} />
              </Field>
            </div>
            <Field label="Direction">
              <select className="select" value={form.direction} onChange={(e) => set({ direction: e.target.value })}>
                <option value="INCREASE">Should go up</option>
                <option value="DECREASE">Should come down</option>
              </select>
            </Field>
          </>
        )}

        <div className="grid-2">
          <Field label="Owner">
            <select className="select" value={form.owner_user_id}
              onChange={(e) => set({ owner_user_id: e.target.value })}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select className="select" value={form.status} onChange={(e) => set({ status: e.target.value })}>
              {OBJECTIVE_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Weight" hint="How much this one counts towards the goal">
          <input className="input" type="number" min="0" step="0.5" value={form.weight}
            onChange={(e) => set({ weight: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
