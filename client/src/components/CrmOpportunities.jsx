import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData, useToast } from '../state/AppState.jsx';
import { Avatar, Badge, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import {
  ENGAGEMENT_MODELS, IMPORTANCE_META, OPPORTUNITY_STATUS_META, REQUIREMENT_CATEGORIES,
  REQUIREMENT_STATUS_META, VALUE_BASIS_LABEL, VALUE_FIELDS,
  describeForecast, exactMoney, formatMoney, modelLabel,
} from '../lib/crm.js';
import { formatDate } from '../lib/format.js';

/**
 * The deals inside a relationship.
 *
 * Money is the thing this screen is most careful about. Four amounts are kept
 * apart — what we guessed, what we proposed, what was signed, what arrived —
 * because adding them together, or reading a blank one as zero, is how a
 * pipeline starts reporting money that does not exist.
 */

function NewOpportunityDialog({ accountId, stages, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    engagement_model: 'COMMERCIAL',
    stage_id: '',
    estimated_value: '',
    expected_close: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));
  const model = ENGAGEMENT_MODELS.find((m) => m.value === form.engagement_model);

  const save = async () => {
    if (form.name.trim().length < 2) return toast.error('Give the opportunity a name');
    setSaving(true);
    try {
      await api.createOpportunity({
        account_id: accountId,
        name: form.name.trim(),
        engagement_model: form.engagement_model,
        stage_id: form.stage_id ? Number(form.stage_id) : undefined,
        estimated_value: form.estimated_value === '' ? null : Number(form.estimated_value),
        expected_close: form.expected_close || null,
      });
      toast.success('Opportunity added');
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
      title="Add an opportunity"
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
          A specific agreement being pursued with this organization. It has its own stage,
          value and outcome — winning it does not close the relationship.
        </div>
        <Field label="What is the opportunity? *">
          <input className="input" autoFocus value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Soil testing contract 2027" />
        </Field>
        <Field
          label="What kind of agreement?"
          hint={model && !model.commercial
            ? 'Not commercial work — it will not be counted in the pipeline value'
            : 'Counted towards the pipeline value'}
        >
          <select className="select" value={form.engagement_model}
            onChange={(e) => set({ engagement_model: e.target.value })}>
            {ENGAGEMENT_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="Stage">
            <select className="select" value={form.stage_id}
              onChange={(e) => set({ stage_id: e.target.value })}>
              <option value="">First stage</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Expected close">
            <input className="input" type="date" value={form.expected_close}
              onChange={(e) => set({ expected_close: e.target.value })} />
          </Field>
        </div>
        <Field label="Estimated value" hint="Leave blank if it is genuinely not known — blank is not zero">
          <input className="input" type="number" min="0" value={form.estimated_value}
            onChange={(e) => set({ estimated_value: e.target.value })} placeholder="₹" />
        </Field>
      </div>
    </Modal>
  );
}

/** Moving a deal on, and settling it properly when it reaches the end. */
function StageDialog({ opportunity, stages, onClose, onSaved }) {
  const toast = useToast();
  const [stageId, setStageId] = useState('');
  const [form, setForm] = useState({
    outcome_reason: '', revisit_on: '', agreement_type: '', agreement_date: '',
    agreement_link: '', agreed_value: '', financial_status: 'UNPAID',
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const target = stages.find((s) => String(s.id) === String(stageId));
  const isWon = target?.kind === 'won';
  const isLost = target?.kind === 'lost';

  const save = async () => {
    if (!stageId) return toast.error('Pick a stage');
    if (isLost && form.outcome_reason.trim().length < 3) {
      return toast.error('Say why it was lost — that is the only thing a closed deal can still teach anyone');
    }
    setSaving(true);
    try {
      await api.moveOpportunityStage(opportunity.id, {
        stage_id: Number(stageId),
        outcome_reason: form.outcome_reason.trim() || undefined,
        revisit_on: form.revisit_on || undefined,
        ...(isWon ? {
          agreement_type: form.agreement_type.trim() || undefined,
          agreement_date: form.agreement_date || undefined,
          agreement_link: form.agreement_link.trim() || undefined,
          agreed_value: form.agreed_value === '' ? undefined : Number(form.agreed_value),
          financial_status: form.financial_status,
        } : {}),
      });
      toast.success(`Moved to ${target.name}`);
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
      title={`Move: ${opportunity.name}`}
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Move it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Move to">
          <select className="select" value={stageId} autoFocus onChange={(e) => setStageId(e.target.value)}>
            <option value="">Pick a stage…</option>
            {stages.filter((s) => s.id !== opportunity.stage_id).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>

        {opportunity.gaps?.length > 0 && target?.kind === 'open' && (
          <div className="ask-banner ask-warning">
            <Icon name="alert" size={15} />
            <div className="grow">
              <strong>Still missing</strong>
              <div className="small">
                {opportunity.gaps.map((g) => g.label).join(' · ')}. You can move it anyway — this is
                a reminder, not a gate.
              </div>
            </div>
          </div>
        )}

        {isWon && (
          <>
            <div className="small muted">
              What was actually agreed. A signed agreement is not the same as money received,
              so those stay separate.
            </div>
            <div className="grid-2">
              <Field label="Agreement type">
                <input className="input" value={form.agreement_type}
                  onChange={(e) => set({ agreement_type: e.target.value })}
                  placeholder="Signed pilot agreement" />
              </Field>
              <Field label="Agreement date">
                <input className="input" type="date" value={form.agreement_date}
                  onChange={(e) => set({ agreement_date: e.target.value })} />
              </Field>
              <Field label="Agreed value">
                <input className="input" type="number" min="0" value={form.agreed_value}
                  onChange={(e) => set({ agreed_value: e.target.value })} />
              </Field>
              <Field label="Money status">
                <select className="select" value={form.financial_status}
                  onChange={(e) => set({ financial_status: e.target.value })}>
                  <option value="NOT_APPLICABLE">No money involved</option>
                  <option value="UNPAID">Nothing invoiced yet</option>
                  <option value="INVOICED">Invoiced</option>
                  <option value="PART_PAID">Part paid</option>
                  <option value="PAID">Paid in full</option>
                </select>
              </Field>
            </div>
            <Field label="Evidence link" hint="Where the signed agreement lives">
              <input className="input" value={form.agreement_link}
                onChange={(e) => set({ agreement_link: e.target.value })}
                placeholder="https://drive.example/…" />
            </Field>
            <Field label="Accepted scope, in a line">
              <textarea className="textarea" rows={2} value={form.outcome_reason}
                onChange={(e) => set({ outcome_reason: e.target.value })} />
            </Field>
          </>
        )}

        {isLost && (
          <>
            <Field label="Why was it lost? *"
              hint="The only thing a closed deal can still teach anyone">
              <textarea className="textarea" rows={3} value={form.outcome_reason}
                onChange={(e) => set({ outcome_reason: e.target.value })}
                placeholder="Budget moved to next financial year; they liked the evidence." />
            </Field>
            <Field label="Worth coming back to on" hint="Leave blank if there is no point">
              <input className="input" type="date" value={form.revisit_on}
                onChange={(e) => set({ revisit_on: e.target.value })} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The four amounts, side by side and never summed. */
function ValuePanel({ opportunity, canEdit, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() =>
    Object.fromEntries(VALUE_FIELDS.map((f) => [f.key, opportunity[f.key] ?? ''])));
  const [saving, setSaving] = useState(false);
  const forecast = describeForecast(opportunity);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateOpportunity(opportunity.id, Object.fromEntries(
        VALUE_FIELDS.map((f) => [f.key, form[f.key] === '' ? null : Number(form[f.key])]),
      ));
      toast.success('Values updated');
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="value-panel">
      <div className="row-between wrap">
        <span className="stat-label">Value</span>
        {canEdit && (
          <button type="button" className="btn-link small" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Cancel' : 'Edit amounts'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="stack-sm">
          <div className="grid-2">
            {VALUE_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <input className="input" type="number" min="0" value={form[field.key]}
                  onChange={(e) => setForm((c) => ({ ...c, [field.key]: e.target.value }))} />
              </Field>
            ))}
          </div>
          <div className="small muted">Leave a box empty if the number is not known. Empty is not zero.</div>
          <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save amounts'}
          </button>
        </div>
      ) : (
        <>
          <div className="value-grid">
            {VALUE_FIELDS.map((field) => {
              const amount = opportunity[field.key];
              return (
                <div key={field.key} className="value-cell" title={field.hint}>
                  <div className="value-cell-label">{field.label}</div>
                  <div className={`value-cell-amount tnum${amount === null ? ' is-unknown' : ''}`}>
                    {amount === null ? 'not known' : formatMoney(amount, opportunity.currency)}
                  </div>
                  {amount !== null && (
                    <div className="value-cell-exact tnum">{exactMoney(amount, opportunity.currency)}</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="forecast-line">
            {forecast.amount === null ? (
              <span className="small muted">Not in the forecast — {forecast.note}.</span>
            ) : (
              <span className="small">
                Forecast uses <strong>{formatMoney(forecast.amount, opportunity.currency)}</strong>
                {forecast.weighted !== null && (
                  <> → <strong>{formatMoney(forecast.weighted, opportunity.currency)}</strong> weighted</>
                )}
                <span className="muted"> — {forecast.note}. An estimate, not a prediction.</span>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RequirementsPanel({ opportunity, canEdit, onChanged }) {
  const toast = useToast();
  const { users } = useRefData();
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ description: '', category: 'TECHNICAL', importance: 'MUST_HAVE' });

  const load = () => {
    api.opportunityRequirements(opportunity.id)
      .then(setData)
      .catch((err) => toast.error(err));
  };

  useEffect(load, [opportunity.id]);

  const add = async () => {
    if (draft.description.trim().length < 2) return toast.error('Say what has to happen');
    try {
      await api.addRequirement(opportunity.id, { ...draft, description: draft.description.trim() });
      setDraft({ description: '', category: 'TECHNICAL', importance: 'MUST_HAVE' });
      setAdding(false);
      load();
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const setStatus = async (requirement, status) => {
    try {
      await api.updateRequirement(opportunity.id, requirement.id, { status });
      load();
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  if (!data) return <Spinner label="Loading requirements" />;

  return (
    <div className="stack-sm">
      <div className="row-between wrap">
        <span className="stat-label">What must happen to win</span>
        {canEdit && (
          <button type="button" className="btn-link small" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add a requirement'}
          </button>
        )}
      </div>

      {data.top_blocker && (
        <div className="ask-banner ask-critical">
          <Icon name="alert" size={15} />
          <div className="grow">
            <strong>Top blocker</strong>
            <div className="small">{data.top_blocker.description}</div>
          </div>
        </div>
      )}

      {adding && (
        <div className="composer">
          <textarea className="textarea" rows={2} autoFocus value={draft.description}
            onChange={(e) => setDraft((c) => ({ ...c, description: e.target.value }))}
            placeholder="Third-party lab correlation on 200 samples" />
          <div className="row wrap" style={{ gap: 8 }}>
            <select className="select" style={{ width: 'auto' }} value={draft.category}
              onChange={(e) => setDraft((c) => ({ ...c, category: e.target.value }))}>
              {REQUIREMENT_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <select className="select" style={{ width: 'auto' }} value={draft.importance}
              onChange={(e) => setDraft((c) => ({ ...c, importance: e.target.value }))}>
              <option value="MUST_HAVE">Must have</option>
              <option value="SHOULD_HAVE">Should have</option>
              <option value="NICE_TO_HAVE">Nice to have</option>
            </select>
            <button type="button" className="btn btn-sm btn-primary" onClick={add}>Add</button>
          </div>
        </div>
      )}

      {data.requirements.length === 0 ? (
        <div className="small muted">
          Nothing recorded yet. Writing down what they actually need is what turns a conversation
          into a deal you can work.
        </div>
      ) : (
        data.requirements.map((requirement) => {
          const importance = IMPORTANCE_META[requirement.importance] || IMPORTANCE_META.SHOULD_HAVE;
          const status = REQUIREMENT_STATUS_META[requirement.status] || REQUIREMENT_STATUS_META.OPEN;
          return (
            <div key={requirement.id} className="requirement-row">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small" style={{ fontWeight: 550 }}>{requirement.description}</div>
                <div className="row wrap small muted" style={{ gap: 6, marginTop: 3 }}>
                  <Badge tone={importance.tone}>{importance.label}</Badge>
                  <span>{requirement.category.toLowerCase()}</span>
                  {requirement.owner_name && <><span>·</span><span>{requirement.owner_name}</span></>}
                  {requirement.due_date && <><span>·</span><span>by {formatDate(requirement.due_date)}</span></>}
                  {requirement.evidence_url && (
                    <a className="btn-link" href={requirement.evidence_url} target="_blank" rel="noopener noreferrer">
                      evidence
                    </a>
                  )}
                </div>
              </div>
              {canEdit ? (
                <select className="select" style={{ width: 'auto' }} value={requirement.status}
                  onChange={(e) => setStatus(requirement, e.target.value)}>
                  {Object.entries(REQUIREMENT_STATUS_META).map(([value, meta]) => (
                    <option key={value} value={value}>{meta.label}</option>
                  ))}
                </select>
              ) : (
                <Badge tone={status.tone}>{status.label}</Badge>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

export default function CrmOpportunities({ accountId, opportunities, stages, canEdit, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(null);
  const [open, setOpen] = useState(() => opportunities[0]?.id ?? null);

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>Opportunities & scope</h2>
          <div className="small muted">
            Each deal has its own stage, value and outcome. Winning one does not end the relationship.
          </div>
        </div>
        {canEdit && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Add an opportunity
          </button>
        )}
      </div>

      {opportunities.length === 0 ? (
        <EmptyState title="No opportunities yet">
          Add the specific agreement you are working towards.
        </EmptyState>
      ) : (
        <div className="stack-sm">
          {opportunities.map((opportunity) => {
            const status = OPPORTUNITY_STATUS_META[opportunity.status] || OPPORTUNITY_STATUS_META.ACTIVE;
            const expanded = open === opportunity.id;
            return (
              <div key={opportunity.id}
                className={`opportunity${opportunity.status === 'ACTIVE' ? '' : ' is-settled'}`}>
                <button type="button" className="opportunity-head"
                  onClick={() => setOpen(expanded ? null : opportunity.id)}>
                  <span className="opportunity-rail" style={{ background: opportunity.stage_color }} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="row wrap" style={{ gap: 6 }}>
                      <strong style={{ fontSize: 13.5 }}>{opportunity.name}</strong>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {opportunity.stage_name && (
                        <Badge dot={opportunity.stage_color}>{opportunity.stage_name}</Badge>
                      )}
                    </span>
                    <span className="small muted row wrap" style={{ gap: 6, marginTop: 2 }}>
                      <span>{modelLabel(opportunity.engagement_model)}</span>
                      <span>·</span>
                      <span>
                        {opportunity.eligible_value === null
                          ? VALUE_BASIS_LABEL[opportunity.eligible_basis]
                          : formatMoney(opportunity.eligible_value, opportunity.currency)}
                      </span>
                      {opportunity.expected_close && (
                        <><span>·</span><span>closes {formatDate(opportunity.expected_close)}</span></>
                      )}
                      {opportunity.owner_name && (
                        <><span>·</span><span>{opportunity.owner_name}</span></>
                      )}
                    </span>
                    {opportunity.gaps?.length > 0 && (
                      <span className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                        {opportunity.gaps.map((gap) => (
                          <span key={gap.kind} className="kr-flag kr-flag-warning">{gap.label}</span>
                        ))}
                      </span>
                    )}
                  </span>
                  <Icon name="chevron" size={13}
                    style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />
                </button>

                {expanded && (
                  <div className="opportunity-body">
                    <ValuePanel opportunity={opportunity} canEdit={canEdit} onChanged={onChanged} />
                    <hr className="divider" />
                    <RequirementsPanel opportunity={opportunity} canEdit={canEdit} onChanged={onChanged} />
                    {canEdit && (
                      <div className="row wrap">
                        <button type="button" className="btn btn-sm" onClick={() => setMoving(opportunity)}>
                          Move stage
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <NewOpportunityDialog accountId={accountId} stages={stages}
          onClose={() => setAdding(false)} onSaved={onChanged} />
      )}
      {moving && (
        <StageDialog opportunity={moving} stages={stages}
          onClose={() => setMoving(null)} onSaved={onChanged} />
      )}
    </section>
  );
}
