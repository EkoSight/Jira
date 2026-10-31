import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Field, Modal } from './ui.jsx';
import { NextActionFields, nextActionBody, nextActionDraft, nextActionProblem } from './DealParts.jsx';
import { INDIAN_STATES } from '../lib/crm.js';
import { CATEGORY, ELIGIBLE, EXCLUDED, handedOut, useSalesMeta } from '../lib/sales.js';

const PIPELINE_KEY = { B2B_CORPORATE: 'b2b', CSR_NGO: 'csr', RETAILER: 'retail', FPO: 'retail', INDIVIDUAL: 'retail' };

/**
 * Adding or editing a lead. A lead often starts as little more than a company
 * and a hunch, so little is required — but its first deal starts with a next
 * action, who owes it and by when, because a deal with nothing owed next is how
 * a pipeline goes stale.
 *
 * Editing does not touch the next action: that belongs to each deal, and is
 * changed on the deal, so there is one place it lives.
 */
export default function AccountDialog({ account, stages: given = [], onClose, onSaved }) {
  // every pipeline's stages, so the starting stage follows the category chosen
  const [stages, setStages] = useState(given);
  useEffect(() => {
    if (account) return;
    api.accountStages().then((d) => {
      setStages(d.stages);
      // keep the chosen stage only if it belongs to the category's pipeline
      setForm((c) => {
        const key = PIPELINE_KEY[c.lead_category] || 'b2b';
        if (d.stages.some((x) => String(x.id) === String(c.stage_id) && x.pipeline_key === key)) return c;
        const first = d.stages.find((x) => x.kind === 'open' && !x.retired_at && x.pipeline_key === key);
        return { ...c, stage_id: first?.id || '' };
      });
    }).catch(() => {});
  }, [account]);
  const { user } = useAuth();
  const { meta } = useSalesMeta();
  const { departments, users } = useRefData();
  const toast = useToast();
  const navigate = useNavigate();
  const editing = Boolean(account);

  const [form, setForm] = useState(() => ({
    // which side of the TeleCRM boundary it is on; existing records may not have one yet
    lead_category: account?.lead_category || (editing ? '' : 'B2B_CORPORATE'),
    name: account?.name || '',
    stage_id: account?.stage_id || stages.find((x) => !x.pipeline_key || x.pipeline_key === 'b2b')?.id || stages[0]?.id || '',
    owner_user_id: account?.owner_user_id ?? user.id,
    follower_user_id: account?.follower_user_id ?? '',
    department_id: account?.department_id ?? user.department_id ?? '',
    value: account?.value ?? '',
    source: account?.source || '',
    website: account?.website || '',
    contact_name: account?.contact_name || '',
    contact_email: account?.contact_email || '',
    contact_phone: account?.contact_phone || '',
    description: account?.description || '',
    state: account?.state || '',
    hq_address: account?.hq_address || '',
  }));
  const [next, setNext] = useState(() => ({
    ...nextActionDraft(null, account?.owner_user_id ?? user.id),
    next_step: 'Make first contact',
  }));
  const [nextError, setNextError] = useState(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  // a change somebody relied on — who leads it, or an expected value already
  // set — is kept on the history with why
  const ownerChanging = editing && account.owner_user_id
    && String(form.owner_user_id) !== String(account.owner_user_id);
  const valueChanging = editing && account.value !== null && account.value !== undefined
    && String(form.value) !== String(account.value);
  const needsReason = ownerChanging || valueChanging;

  const save = async () => {
    if (form.name.trim().length < 2) return toast.error('Give the lead a name');
    if (!editing) {
      const problem = nextActionProblem(next);
      setNextError(problem);
      if (problem) return undefined;
    }
    if (needsReason && reason.trim().length < 3) {
      return toast.error(ownerChanging ? 'Say why it is changing hands' : 'Say why the expected value changed');
    }
    if (!editing && !form.lead_category) return toast.error('Choose what kind of organization this is');
    const payload = {
      ...(form.lead_category && form.lead_category !== (account?.lead_category || '') ? { lead_category: form.lead_category } : {}),
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
      description: form.description.trim() || null,
      state: form.state || null,
      hq_address: form.hq_address.trim() || null,
    };
    if (!editing && form.stage_id) payload.stage_id = Number(form.stage_id);
    if (!editing) Object.assign(payload, nextActionBody(next));
    if (needsReason) payload.reason = reason.trim();
    // The box shows the lead's headline value, which may be a proposed or signed
    // amount. Saving it untouched must not copy that into the estimate, so the
    // value is only sent when somebody actually changed it.
    if (editing && String(form.value) === String(account.value ?? '')) delete payload.value;

    setSaving(true);
    try {
      const result = editing
        ? await api.updateAccount(account.id, payload)
        : await api.createAccount(payload);
      // a retailer, FPO or individual is not added here: it goes to the TeleCRM queue as a lead
      if (result.routed) {
        toast.success(result.message || 'Sent to the TeleCRM queue');
        onClose();
        if (result.lead?.id) navigate(`/sales/leads/${result.lead.id}`);
        return undefined;
      }
      toast.success(editing ? 'Saved' : 'Lead added');
      onSaved(result.account);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
    return undefined;
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
        <Field label="What kind of organization is this? *"
          hint={handedOut(meta, form.lead_category)
            ? `${CATEGORY[form.lead_category].label} enquiries still go to TeleCRM. Saving sends this to the TeleCRM queue instead of the pipeline.`
            : editing && !account?.lead_category ? 'An existing organization: confirming its category keeps it in the right pipeline and reports.'
              : EXCLUDED.includes(form.lead_category) ? 'Worked in the Retail, FPO & farmers pipeline.' : 'Worked in its own pipeline: B2B corporate or CSR / NGO.'}>
          <select className="select" value={form.lead_category} onChange={(e) => {
            const category = e.target.value;
            const first = stages.find((x) => x.kind === 'open' && x.pipeline_key === (PIPELINE_KEY[category] || 'b2b'));
            set({ lead_category: category, ...(first && !editing ? { stage_id: first.id } : {}) });
          }}>
            {editing && !account?.lead_category && <option value="">Not confirmed yet</option>}
            {ELIGIBLE.map((k) => <option key={k} value={k}>{CATEGORY[k].label}</option>)}
            <optgroup label={EXCLUDED.some((k) => handedOut(meta, k)) ? 'Handed to TeleCRM' : 'Retail, FPO & farmers'}>
              {EXCLUDED.map((k) => <option key={k} value={k}>{CATEGORY[k].label}</option>)}
            </optgroup>
          </select>
        </Field>
        <Field label="Company / lead name">
          <input className="input" value={form.name} autoFocus onChange={(e) => set({ name: e.target.value })}
            placeholder="Acme Agro Pvt Ltd" />
        </Field>

        <div className="grid-2">
          <Field label="Leading it" hint="Accountable for moving this deal">
            <select className="select" value={form.owner_user_id} onChange={(e) => {
              const value = e.target.value;
              if (!editing && String(next.next_step_owner_id) === String(form.owner_user_id)) {
                setNext((c) => ({ ...c, next_step_owner_id: value }));
              }
              set({ owner_user_id: value });
            }}>
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
          <Field
            label="Expected revenue (₹)"
            hint={editing
              ? 'Your estimate for the main deal. A proposed or signed amount on the deal takes precedence.'
              : 'What you expect this deal to bring in. Leave blank if you genuinely do not know yet — blank is not zero.'}
          >
            <input className="input" type="number" min="0" value={form.value}
              onChange={(e) => set({ value: e.target.value })} placeholder="500000" />
          </Field>
        </div>

        {!editing && !handedOut(meta, form.lead_category) && (
          <Field label="Starting stage">
            <select className="select" value={form.stage_id} onChange={(e) => set({ stage_id: e.target.value })}>
              {stages.filter((x) => !x.retired_at && x.kind === 'open' && (!x.pipeline_key || x.pipeline_key === (PIPELINE_KEY[form.lead_category] || 'b2b'))).map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </select>
          </Field>
        )}

        <div className="grid-2">
          <Field label="State" hint="Where they are based — it drives the state-wise view">
            <select className="select" value={form.state} onChange={(e) => set({ state: e.target.value })}>
              <option value="">Not recorded yet</option>
              {/* an older value typed before the pick list existed is kept, not lost */}
              {form.state && !INDIAN_STATES.includes(form.state) && (
                <option value={form.state}>{form.state}</option>
              )}
              {INDIAN_STATES.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label="Office address">
            <input className="input" value={form.hq_address} onChange={(e) => set({ hq_address: e.target.value })}
              placeholder="Plot 12, MIDC Ambad, Nashik" />
          </Field>
        </div>

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

        {!editing && (
          <NextActionFields value={next} onChange={(v) => { setNext(v); setNextError(null); }}
            error={nextError} label="What happens next on this lead" />
        )}
        {editing && (
          <div className="small muted">
            Next actions belong to each deal — change them on the deal, under Opportunities.
          </div>
        )}

        {needsReason && (
          <Field label={`Why ${ownerChanging ? 'is it changing hands' : 'did the expected value change'}? *`}
            hint="Kept on the history beside the old and new">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}

        <Field label="Notes">
          <textarea className="textarea" rows={2} value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="What they need, who the champion is, anything worth remembering." />
        </Field>
      </div>
    </Modal>
  );
}
