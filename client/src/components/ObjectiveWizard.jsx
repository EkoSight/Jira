import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Field, Icon, Modal } from './ui.jsx';
import { MEASUREMENT_TYPES, OBJECTIVE_STATUSES, periodPresets } from '../lib/okr.js';

const blankKeyResult = (ownerId) => ({
  key: Math.random().toString(36).slice(2),
  title: '',
  owner_user_id: ownerId,
  measurement_type: 'NUMBER',
  direction: 'INCREASE',
  baseline_value: 0,
  target_value: '',
  current_value: '',
  unit: '',
  weight: 1,
});

/**
 * Creating a goal, in the order people think about one: what are we trying to
 * do, by when, and how will we know it happened.
 */
export default function ObjectiveWizard({ objective, parentOptions = [], onClose, onSaved }) {
  const { user, can } = useAuth();
  const { departments, users } = useRefData();
  const toast = useToast();

  const editing = Boolean(objective);
  const presets = useMemo(() => periodPresets(), []);
  const defaultPeriod = presets[0];

  const [form, setForm] = useState(() => ({
    title: objective?.title || '',
    description: objective?.description || '',
    scope_type: objective?.scope_type || (can('okr.create.department') ? 'DEPARTMENT' : 'COMPANY'),
    department_id: objective?.department_id ?? user.department_id ?? '',
    parent_objective_id: objective?.parent_objective_id ?? '',
    owner_user_id: objective?.owner_user_id ?? user.id,
    start_date: objective?.start_date?.slice(0, 10) || defaultPeriod.start_date,
    end_date: objective?.end_date?.slice(0, 10) || defaultPeriod.end_date,
    priority: objective?.priority || 'medium',
    status: objective?.status || 'ACTIVE',
  }));

  const [keyResults, setKeyResults] = useState(() => (editing ? [] : [blankKeyResult(user.id)]));
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const setKeyResult = (key, patch) =>
    setKeyResults((current) => current.map((kr) => (kr.key === key ? { ...kr, ...patch } : kr)));

  const applyPreset = (key) => {
    const preset = presets.find((p) => p.key === key);
    if (preset) set({ start_date: preset.start_date, end_date: preset.end_date });
  };

  const save = async () => {
    if (form.title.trim().length < 3) return toast.error('Give the goal a title');
    if (form.scope_type === 'DEPARTMENT' && !form.department_id) {
      return toast.error('Choose the department this goal belongs to');
    }
    if (new Date(form.end_date) < new Date(form.start_date)) {
      return toast.error('The target date cannot be before the start date');
    }

    const filled = keyResults.filter((kr) => kr.title.trim().length >= 2);
    if (!editing && filled.length === 0) {
      return toast.error('Add at least one key result — that is how you will know it worked');
    }
    // a scored key result with no target measures nothing and leaves the goal blank
    const untargeted = filled.find(
      (kr) => !['BINARY', 'TASK_ROLLUP'].includes(kr.measurement_type) && kr.target_value === '',
    );
    if (untargeted) {
      return toast.error(`Set a target for "${untargeted.title.trim()}" — otherwise it measures nothing`);
    }

    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      scope_type: form.scope_type,
      department_id: form.scope_type === 'COMPANY' ? null : Number(form.department_id),
      parent_objective_id: form.parent_objective_id ? Number(form.parent_objective_id) : null,
      owner_user_id: Number(form.owner_user_id),
      start_date: form.start_date,
      end_date: form.end_date,
      priority: form.priority,
      status: form.status,
    };

    setSaving(true);
    try {
      if (editing) {
        const { objective: saved } = await api.updateObjective(objective.id, payload);
        toast.success('Goal updated');
        onSaved(saved);
      } else {
        const { objective: saved } = await api.createObjective({
          ...payload,
          key_results: filled.map((kr) => ({
            title: kr.title.trim(),
            owner_user_id: Number(kr.owner_user_id),
            measurement_type: kr.measurement_type,
            direction: kr.direction,
            baseline_value: Number(kr.baseline_value) || 0,
            target_value:
              kr.measurement_type === 'BINARY'
                ? 1
                : kr.target_value === '' ? null : Number(kr.target_value),
            // left blank, it starts wherever the baseline is, which is 0% progress
            current_value: kr.current_value === '' ? undefined : Number(kr.current_value),
            unit: kr.unit.trim() || null,
            weight: Number(kr.weight) || 1,
          })),
        });
        toast.success('Goal created');
        onSaved(saved);
      }
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? 'Edit goal' : 'New goal'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create goal'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        <Field
          label="What are we trying to achieve?"
          hint="Write the outcome, not the activity — “Advisory reaches every dealer district”, not “run advisory calls”"
        >
          <input
            className="input"
            value={form.title}
            autoFocus
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Make advisory the reason farmers stay with us"
          />
        </Field>

        <Field label="Why it matters" hint="Optional — the context someone joining midway would need">
          <textarea
            className="textarea"
            rows={2}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>

        <div className="grid-2">
          <Field label="Whose goal is it?">
            <select
              className="select"
              value={form.scope_type}
              onChange={(e) => set({ scope_type: e.target.value })}
            >
              {can('okr.create.company') && <option value="COMPANY">The whole company</option>}
              <option value="DEPARTMENT">A department</option>
            </select>
          </Field>

          {form.scope_type === 'DEPARTMENT' ? (
            <Field label="Department">
              <select
                className="select"
                value={form.department_id}
                onChange={(e) => set({ department_id: e.target.value })}
              >
                <option value="">Choose…</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Priority">
              <select className="select" value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </Field>
          )}
        </div>

        <div className="grid-2">
          <Field label="Accountable for it" hint="One person, even when a team does the work">
            <select
              className="select"
              value={form.owner_user_id}
              onChange={(e) => set({ owner_user_id: e.target.value })}
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}{u.department_name ? ` · ${u.department_name}` : ''}
                </option>
              ))}
            </select>
          </Field>

          {form.scope_type === 'DEPARTMENT' ? (
            <Field label="Priority">
              <select className="select" value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </Field>
          ) : (
            <Field label="Status">
              <select className="select" value={form.status} onChange={(e) => set({ status: e.target.value })}>
                {OBJECTIVE_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <Field label="Over what period?">
          <div className="row wrap" style={{ marginBottom: 8 }}>
            {presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={`btn btn-sm${
                  form.start_date === preset.start_date && form.end_date === preset.end_date ? ' btn-primary' : ''
                }`}
                onClick={() => applyPreset(preset.key)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="row">
            <input
              type="date"
              className="input"
              value={form.start_date}
              onChange={(e) => set({ start_date: e.target.value })}
            />
            <span className="muted small">to</span>
            <input
              type="date"
              className="input"
              value={form.end_date}
              onChange={(e) => set({ end_date: e.target.value })}
            />
          </div>
        </Field>

        {form.scope_type === 'DEPARTMENT' && parentOptions.length > 0 && (
          <Field
            label="Rolls up to"
            hint="Optional — connects this to a company goal so the cascade is visible"
          >
            <select
              className="select"
              value={form.parent_objective_id}
              onChange={(e) => set({ parent_objective_id: e.target.value })}
            >
              <option value="">Stands on its own</option>
              {parentOptions.filter((o) => o.id !== objective?.id).map((o) => (
                <option key={o.id} value={o.id}>{o.title}</option>
              ))}
            </select>
          </Field>
        )}

        {editing && form.scope_type === 'DEPARTMENT' && (
          <Field label="Status">
            <select className="select" value={form.status} onChange={(e) => set({ status: e.target.value })}>
              {OBJECTIVE_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </Field>
        )}

        {!editing && (
          <>
            <hr className="divider" />
            <div>
              <div style={{ fontWeight: 650, fontSize: 13 }}>How will you know it worked?</div>
              <div className="small muted">
                Two or three measurable results. Each one needs a number someone can check.
              </div>
            </div>

            <div className="stack">
              {keyResults.map((kr, index) => (
                <div key={kr.key} className="kr-draft">
                  <div className="row-between">
                    <span className="small muted">Key result {index + 1}</span>
                    {keyResults.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setKeyResults((c) => c.filter((item) => item.key !== kr.key))}
                      >
                        <Icon name="close" size={13} /> Remove
                      </button>
                    )}
                  </div>

                  <input
                    className="input"
                    value={kr.title}
                    onChange={(e) => setKeyResult(kr.key, { title: e.target.value })}
                    placeholder="Onboard 100 farmers onto advisory"
                  />

                  <div className="row wrap" style={{ gap: 8 }}>
                    <select
                      className="select"
                      style={{ flex: '1 1 190px' }}
                      value={kr.measurement_type}
                      onChange={(e) => setKeyResult(kr.key, { measurement_type: e.target.value })}
                    >
                      {MEASUREMENT_TYPES.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>

                    {!['BINARY', 'TASK_ROLLUP'].includes(kr.measurement_type) && (
                      <>
                        <input
                          className="input"
                          style={{ flex: '0 1 100px' }}
                          type="number"
                          value={kr.baseline_value}
                          onChange={(e) => setKeyResult(kr.key, { baseline_value: e.target.value })}
                          placeholder="From"
                          aria-label="Starting value"
                        />
                        <input
                          className="input"
                          style={{ flex: '0 1 100px' }}
                          type="number"
                          value={kr.target_value}
                          onChange={(e) => setKeyResult(kr.key, { target_value: e.target.value })}
                          placeholder="To"
                          aria-label="Target value"
                        />
                        <input
                          className="input"
                          style={{ flex: '0 1 100px' }}
                          type="number"
                          value={kr.current_value}
                          onChange={(e) => setKeyResult(kr.key, { current_value: e.target.value })}
                          placeholder="Today"
                          aria-label="Value today"
                        />
                        <input
                          className="input"
                          style={{ flex: '0 1 110px' }}
                          value={kr.unit}
                          onChange={(e) => setKeyResult(kr.key, { unit: e.target.value })}
                          placeholder="Unit"
                          aria-label="Unit"
                        />
                      </>
                    )}
                  </div>

                  <div className="row wrap" style={{ gap: 8 }}>
                    <select
                      className="select"
                      style={{ flex: '1 1 190px' }}
                      value={kr.owner_user_id}
                      onChange={(e) => setKeyResult(kr.key, { owner_user_id: e.target.value })}
                    >
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.full_name}</option>
                      ))}
                    </select>
                    {!['BINARY', 'TASK_ROLLUP'].includes(kr.measurement_type) && (
                      <select
                        className="select"
                        style={{ flex: '0 1 170px' }}
                        value={kr.direction}
                        onChange={(e) => setKeyResult(kr.key, { direction: e.target.value })}
                      >
                        <option value="INCREASE">Should go up</option>
                        <option value="DECREASE">Should come down</option>
                      </select>
                    )}
                  </div>

                  <div className="small muted">
                    {MEASUREMENT_TYPES.find((m) => m.value === kr.measurement_type)?.hint}
                    {!['BINARY', 'TASK_ROLLUP'].includes(kr.measurement_type)
                      && ' · leave “Today” blank to start from where you are now'}
                  </div>
                </div>
              ))}

              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setKeyResults((c) => [...c, blankKeyResult(user.id)])}
              >
                <Icon name="plus" size={14} /> Add another key result
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
