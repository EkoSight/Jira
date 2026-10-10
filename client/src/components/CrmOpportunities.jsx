import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import DealMoveDialog from './DealMoveDialog.jsx';
import {
  Clocks, DealPeople, NextActionFields, NextActionLine, OrderFields, PersonSelect, ProposalFields,
  emptyOrder, emptyProposal, nextActionBody, nextActionDraft, nextActionProblem, orderBody, proposalBody,
} from './DealParts.jsx';
import {
  ENGAGEMENT_MODELS, IMPORTANCE_META, LEDGER_FIGURES, OPPORTUNITY_STATUS_META, ORDER_KIND_LABEL,
  PROPOSAL_STATUS_META, REQUIREMENT_CATEGORIES, REQUIREMENT_STATUS_META, VALUE_BASIS_LABEL, VALUE_FIELDS,
  describeForecast, exactMoney, formatMoney, modelLabel, todayInIndia,
} from '../lib/crm.js';
import { formatDate, relativeTime } from '../lib/format.js';

/**
 * The deals inside a relationship.
 *
 * Money is the thing this screen is most careful about. The amounts are kept
 * apart — what we guessed, what we proposed, what was signed, what was billed,
 * what arrived — because adding them together, or reading a blank one as zero,
 * is how a pipeline starts reporting money that does not exist.
 *
 * And progress is the other: every live deal shows what happens next, who owes
 * it and by when, and when the customer last actually responded — which is not
 * the same as when somebody last touched the record.
 */

function NewOpportunityDialog({ accountId, stages, relationshipOwnerId, onClose, onSaved }) {
  const { user } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    engagement_model: 'COMMERCIAL',
    stage_id: '',
    estimated_value: '',
    expected_close: '',
    owner_user_id: String(relationshipOwnerId || user?.id || ''),
  });
  const [next, setNext] = useState(() => nextActionDraft(null, relationshipOwnerId || user?.id));
  const [nextError, setNextError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));
  const model = ENGAGEMENT_MODELS.find((m) => m.value === form.engagement_model);

  const save = async () => {
    if (form.name.trim().length < 2) return toast.error('Give the opportunity a name');
    const problem = nextActionProblem(next);
    setNextError(problem);
    if (problem) return undefined;
    setSaving(true);
    try {
      await api.createOpportunity({
        account_id: accountId,
        name: form.name.trim(),
        engagement_model: form.engagement_model,
        stage_id: form.stage_id ? Number(form.stage_id) : undefined,
        estimated_value: form.estimated_value === '' ? null : Number(form.estimated_value),
        expected_close: form.expected_close || null,
        owner_user_id: form.owner_user_id ? Number(form.owner_user_id) : undefined,
        ...nextActionBody(next),
      });
      toast.success('Opportunity added');
      onSaved();
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
          value, owner and next action — winning it does not close the relationship.
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
              {stages.filter((s) => s.kind === 'open').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Expected close">
            <input className="input" type="date" value={form.expected_close}
              onChange={(e) => set({ expected_close: e.target.value })} />
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Accountable owner" hint="One person answers for this deal">
            <PersonSelect value={form.owner_user_id} onChange={(v) => set({ owner_user_id: v })} />
          </Field>
          <Field label="Estimated value (₹)" hint="Blank if genuinely not known — blank is not zero">
            <input className="input" type="number" min="0" value={form.estimated_value}
              onChange={(e) => set({ estimated_value: e.target.value })} />
          </Field>
        </div>
        <NextActionFields value={next} onChange={(v) => { setNext(v); setNextError(null); }} error={nextError} />
      </div>
    </Modal>
  );
}

/** The amounts on the deal, side by side and never summed. Changing one somebody relied on asks why. */
function ValuePanel({ opportunity, ledger, canEdit, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const editable = VALUE_FIELDS.filter((f) => f.key !== 'collected_value');
  const [form, setForm] = useState(() =>
    Object.fromEntries(editable.map((f) => [f.key, opportunity[f.key] ?? ''])));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const forecast = describeForecast(opportunity);

  const changed = editable.filter((f) => String(form[f.key]) !== String(opportunity[f.key] ?? ''));
  // filling in a blank needs no explanation; changing a figure somebody relied on does
  const needsReason = changed.some((f) => opportunity[f.key] !== null && opportunity[f.key] !== undefined);

  const save = async () => {
    if (!changed.length) return setEditing(false);
    if (needsReason && reason.trim().length < 3) return toast.error('Say why the value changed — it stays on the history');
    setSaving(true);
    try {
      await api.updateOpportunity(opportunity.id, {
        ...Object.fromEntries(changed.map((f) => [f.key, form[f.key] === '' ? null : Number(form[f.key])])),
        ...(needsReason ? { reason: reason.trim() } : {}),
      });
      toast.success('Values updated');
      setEditing(false);
      setReason('');
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
    return undefined;
  };

  // what has actually arrived comes from the payments recorded; a figure typed
  // before the ledger existed is shown as exactly that
  const cash = ledger?.totals?.cash_received ?? opportunity.cash_received ?? null;
  const typedCollected = opportunity.collected_value;

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
            {editable.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <input className="input" type="number" min="0" value={form[field.key]}
                  onChange={(e) => setForm((c) => ({ ...c, [field.key]: e.target.value }))} />
              </Field>
            ))}
          </div>
          {needsReason && (
            <Field label="Why did it change? *" hint="Kept on the deal's history beside the old and new figures">
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="They added two more districts to the scope" />
            </Field>
          )}
          <div className="small muted">Leave a box empty if the number is not known. Empty is not zero.</div>
          <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save amounts'}
          </button>
        </div>
      ) : (
        <>
          <div className="value-grid">
            {editable.map((field) => {
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
            <div className="value-cell" title="Payments recorded as received, voids excluded">
              <div className="value-cell-label">Cash received</div>
              <div className={`value-cell-amount tnum${cash === null ? ' is-unknown' : ''}`}>
                {cash === null ? 'none recorded' : formatMoney(cash, opportunity.currency)}
              </div>
              {cash === null && typedCollected !== null && typedCollected !== undefined && (
                <div className="value-cell-exact" title="Typed on the deal before payments were recorded one by one">
                  {exactMoney(typedCollected, opportunity.currency)} typed by hand, no payment on record
                </div>
              )}
            </div>
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

/** What happens next, who owes it and by when — and changing it. */
function NextActionPanel({ opportunity, canEdit, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState(() => nextActionDraft(opportunity, user?.id));
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const live = ['ACTIVE', 'ON_HOLD', 'NURTURE'].includes(opportunity.status);

  const start = () => {
    setNext(nextActionDraft(opportunity, user?.id));
    setReason('');
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const problem = nextActionProblem(next);
    setError(problem);
    if (problem) return;
    setSaving(true);
    try {
      await api.setNextAction(opportunity.id, { ...nextActionBody(next), reason: reason.trim() || null });
      toast.success('Next action set');
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const ownerChanging = editing && opportunity.next_step_owner_id
    && String(opportunity.next_step_owner_id) !== String(next.next_step_owner_id);

  return (
    <div className="stack-sm">
      <div className="row-between wrap">
        <span className="stat-label">Next action</span>
        {canEdit && live && !editing && (
          <button type="button" className="btn-link small" onClick={start}>
            {opportunity.next_step ? 'Change' : 'Set it'}
          </button>
        )}
      </div>
      {editing ? (
        <div className="stack-sm">
          <NextActionFields value={next} onChange={(v) => { setNext(v); setError(null); }} error={error} label="What happens next" />
          <Field label={ownerChanging ? 'Why is it moving to someone else?' : 'Note (optional)'}
            hint={ownerChanging ? 'They are told, and asked to confirm they have it' : undefined}>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={ownerChanging ? 'Rupendra is travelling this week' : ''} />
          </Field>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save next action'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <NextActionLine opportunity={opportunity} />
          {opportunity.next_step && opportunity.next_step_age_days !== null && opportunity.next_step_age_days > 14 && (
            <div className="small muted">Agreed {opportunity.next_step_age_days} days ago — is it still what happens next?</div>
          )}
        </>
      )}
    </div>
  );
}

/** One accountable owner, the person owing the next move, the escalation point, and the helpers. */
function PeoplePanel({ opportunity, handovers, canEdit, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ owner_user_id: '', escalation_owner_id: '', reason: '' });
  const [helper, setHelper] = useState({ user_id: '', role: '' });
  const [saving, setSaving] = useState(false);

  const pendingForMe = (handovers || []).filter((h) => !h.acknowledged_at && h.to_user_id === user?.id);
  const pendingOthers = (handovers || []).filter((h) => !h.acknowledged_at && h.to_user_id !== user?.id);

  const start = () => {
    setForm({
      owner_user_id: String(opportunity.owner_user_id || ''),
      escalation_owner_id: String(opportunity.escalation_owner_id || ''),
      reason: '',
    });
    setEditing(true);
  };

  const ownerChanging = editing && opportunity.owner_user_id
    && String(opportunity.owner_user_id) !== form.owner_user_id;

  const save = async () => {
    const body = {};
    if (form.owner_user_id !== String(opportunity.owner_user_id || '')) body.owner_user_id = Number(form.owner_user_id);
    if (form.escalation_owner_id !== String(opportunity.escalation_owner_id || '')) {
      body.escalation_owner_id = form.escalation_owner_id ? Number(form.escalation_owner_id) : null;
    }
    if (!Object.keys(body).length) return setEditing(false);
    if (ownerChanging && form.reason.trim().length < 3) return toast.error('Say why the deal is changing hands');
    if (form.reason.trim()) body.reason = form.reason.trim();
    setSaving(true);
    try {
      await api.updateOpportunity(opportunity.id, body);
      toast.success('Saved — anyone newly named has been told');
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
    return undefined;
  };

  const addHelper = async () => {
    if (!helper.user_id) return;
    try {
      await api.addDealCollaborator(opportunity.id, { user_id: Number(helper.user_id), role: helper.role.trim() || null });
      setHelper({ user_id: '', role: '' });
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const removeHelper = async (userId) => {
    try {
      await api.removeDealCollaborator(opportunity.id, userId);
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const acknowledge = async (handover) => {
    try {
      await api.acknowledgeHandover(handover.id);
      toast.success('Confirmed — it is with you');
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  const ROLE = { OWNER: 'the deal', NEXT_ACTION: 'the next move', ESCALATION: 'escalations' };

  return (
    <div className="stack-sm">
      <div className="row-between wrap">
        <span className="stat-label">People</span>
        {canEdit && !editing && (
          <button type="button" className="btn-link small" onClick={start}>Change owner or escalation</button>
        )}
      </div>

      {pendingForMe.map((h) => (
        <div key={h.id} className="ask-banner ask-info">
          <Icon name="user" size={15} />
          <div className="grow small">
            <strong>{ROLE[h.role]} {h.role === 'OWNER' ? 'was' : 'were'} handed to you</strong>
            {h.from_name ? ` by ${h.handed_by_name || h.from_name}` : ''}
            {h.owed ? ` · owed next: ${h.owed}` : ''}{h.reason ? ` · why: ${h.reason}` : ''}
          </div>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => acknowledge(h)}>I have it</button>
        </div>
      ))}
      {pendingOthers.map((h) => (
        <div key={h.id} className="small muted">
          Handed to {h.to_name} ({ROLE[h.role]}) {relativeTime(h.created_at)} — not yet confirmed.
        </div>
      ))}

      {editing ? (
        <div className="stack-sm">
          <div className="grid-2">
            <Field label="Accountable owner" hint="One person answers for this deal">
              <PersonSelect value={form.owner_user_id} onChange={(v) => setForm((c) => ({ ...c, owner_user_id: v }))} />
            </Field>
            <Field label="Escalate to" hint="Who to go to when it is stuck">
              <PersonSelect value={form.escalation_owner_id} allowNone placeholder="Nobody named"
                onChange={(v) => setForm((c) => ({ ...c, escalation_owner_id: v }))} />
            </Field>
          </div>
          <Field label={ownerChanging ? 'Why is it changing hands? *' : 'Note (optional)'}
            hint="Kept on the history; the people newly named are told and asked to confirm">
            <input className="input" value={form.reason} onChange={(e) => setForm((c) => ({ ...c, reason: e.target.value }))} />
          </Field>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <DealPeople opportunity={opportunity} />
      )}

      {canEdit && (
        <div className="row wrap helper-add" style={{ gap: 6 }}>
          <PersonSelect value={helper.user_id} placeholder="Add someone helping…" allowNone
            onChange={(v) => setHelper((c) => ({ ...c, user_id: v }))} />
          <input className="input" style={{ maxWidth: 200 }} value={helper.role} placeholder="Helping with…"
            onChange={(e) => setHelper((c) => ({ ...c, role: e.target.value }))} />
          <button type="button" className="btn btn-sm" onClick={addHelper} disabled={!helper.user_id}>Add</button>
          {(opportunity.collaborators || []).map((c) => (
            <button key={c.user_id} type="button" className="kind-chip"
              title="Take them off the deal" onClick={() => removeHelper(c.user_id)}>
              {c.name} <Icon name="close" size={10} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LEDGER_FORMS = {
  proposal: 'Record a proposal',
  order: 'Record an order or contract',
  invoice: 'Record an invoice',
  payment: 'Record a payment received',
};

/**
 * The commercial record: proposals, orders, invoices and payments, each a
 * different claim. A mistake is withdrawn, cancelled or voided with a reason —
 * nothing here is ever deleted.
 */
function CommercialPanel({ opportunity, ledger, canEdit, onChanged }) {
  const toast = useToast();
  const [adding, setAdding] = useState(null);
  const [proposal, setProposal] = useState(emptyProposal);
  const [order, setOrder] = useState(emptyOrder);
  const [invoice, setInvoice] = useState({ number: '', issued_on: todayInIndia(), amount: '', due_on: '', link: '', order_id: '' });
  const [payment, setPayment] = useState({ received_on: todayInIndia(), amount: '', reference: '', link: '', invoice_id: '' });
  const [saving, setSaving] = useState(false);

  if (!ledger) return <Spinner label="Loading the commercial record" />;

  const run = async (call, message) => {
    setSaving(true);
    try {
      await call();
      toast.success(message);
      setAdding(null);
      setProposal(emptyProposal());
      setOrder(emptyOrder());
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (adding === 'proposal') return run(() => api.addProposal(opportunity.id, proposalBody(proposal)), 'Proposal recorded');
    if (adding === 'order') return run(() => api.addOrder(opportunity.id, orderBody(order)), 'Order recorded');
    if (adding === 'invoice') {
      return run(() => api.addInvoice(opportunity.id, {
        number: invoice.number.trim() || null,
        issued_on: invoice.issued_on,
        amount: invoice.amount === '' ? undefined : Number(invoice.amount),
        due_on: invoice.due_on || null,
        link: invoice.link.trim() || null,
        order_id: invoice.order_id ? Number(invoice.order_id) : null,
      }), 'Invoice recorded');
    }
    return run(() => api.addPayment(opportunity.id, {
      received_on: payment.received_on,
      amount: payment.amount === '' ? undefined : Number(payment.amount),
      reference: payment.reference.trim() || null,
      link: payment.link.trim() || null,
      invoice_id: payment.invoice_id ? Number(payment.invoice_id) : null,
    }), 'Payment recorded');
  };

  const withReason = (label, call) => {
    const reason = window.prompt(`${label} — why? (the record stays, with your reason)`);
    if (!reason || !reason.trim()) return;
    run(() => call(reason.trim()), 'Recorded');
  };

  const { totals } = ledger;
  const money = (value) => (value === null || value === undefined ? null : formatMoney(value, opportunity.currency));

  return (
    <div className="stack-sm">
      <div className="row-between wrap">
        <span className="stat-label">Commercial record</span>
        {canEdit && (
          <span className="row wrap" style={{ gap: 6 }}>
            {Object.entries(LEDGER_FORMS).map(([key, label]) => (
              <button key={key} type="button" className={`kind-chip${adding === key ? ' is-active' : ''}`}
                onClick={() => setAdding(adding === key ? null : key)}>
                <Icon name="plus" size={10} /> {label.replace('Record ', '')}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className="value-grid">
        {LEDGER_FIGURES.map((figure) => (
          <div key={figure.key} className="value-cell" title={figure.hint}>
            <div className="value-cell-label">{figure.label}</div>
            <div className={`value-cell-amount tnum${totals[figure.key] === null ? ' is-unknown' : ''}`}>
              {money(totals[figure.key]) || 'none recorded'}
            </div>
            {figure.key === 'booked' && totals.booked_incomplete && (
              <div className="value-cell-exact">an order has no amount</div>
            )}
          </div>
        ))}
      </div>

      {adding && (
        <div className="evidence-form">
          <div className="small" style={{ fontWeight: 650 }}>{LEDGER_FORMS[adding]}</div>
          {adding === 'proposal' && <ProposalFields value={proposal} onChange={setProposal} />}
          {adding === 'order' && <OrderFields value={order} onChange={setOrder} />}
          {adding === 'invoice' && (
            <div className="stack-sm">
              <div className="grid-2">
                <Field label="Invoice number">
                  <input className="input" value={invoice.number} onChange={(e) => setInvoice((c) => ({ ...c, number: e.target.value }))} />
                </Field>
                <Field label="Issued on *">
                  <input className="input" type="date" max={todayInIndia()} value={invoice.issued_on}
                    onChange={(e) => setInvoice((c) => ({ ...c, issued_on: e.target.value }))} />
                </Field>
                <Field label="Amount (₹) *">
                  <input className="input" type="number" min="0" value={invoice.amount}
                    onChange={(e) => setInvoice((c) => ({ ...c, amount: e.target.value }))} />
                </Field>
                <Field label="Payment due">
                  <input className="input" type="date" value={invoice.due_on}
                    onChange={(e) => setInvoice((c) => ({ ...c, due_on: e.target.value }))} />
                </Field>
              </div>
              <div className="grid-2">
                <Field label="Against order">
                  <select className="select" value={invoice.order_id} onChange={(e) => setInvoice((c) => ({ ...c, order_id: e.target.value }))}>
                    <option value="">Not linked</option>
                    {ledger.orders.filter((o) => o.status === 'ACCEPTED').map((o) => (
                      <option key={o.id} value={o.id}>{o.reference || ORDER_KIND_LABEL[o.kind]} · {formatDate(o.received_on)}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Link">
                  <input className="input" value={invoice.link} onChange={(e) => setInvoice((c) => ({ ...c, link: e.target.value }))} />
                </Field>
              </div>
            </div>
          )}
          {adding === 'payment' && (
            <div className="stack-sm">
              <div className="grid-2">
                <Field label="Received on *" hint="The day the money arrived, not when it was promised">
                  <input className="input" type="date" max={todayInIndia()} value={payment.received_on}
                    onChange={(e) => setPayment((c) => ({ ...c, received_on: e.target.value }))} />
                </Field>
                <Field label="Amount (₹) *">
                  <input className="input" type="number" min="1" value={payment.amount}
                    onChange={(e) => setPayment((c) => ({ ...c, amount: e.target.value }))} />
                </Field>
                <Field label="Bank reference" hint="UTR or cheque number">
                  <input className="input" value={payment.reference} onChange={(e) => setPayment((c) => ({ ...c, reference: e.target.value }))} />
                </Field>
                <Field label="Against invoice">
                  <select className="select" value={payment.invoice_id} onChange={(e) => setPayment((c) => ({ ...c, invoice_id: e.target.value }))}>
                    <option value="">Not linked</option>
                    {ledger.invoices.filter((i) => i.status === 'ISSUED').map((i) => (
                      <option key={i.id} value={i.id}>{i.number || `Invoice ${i.id}`} · {formatMoney(i.amount, i.currency)}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>
          )}
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </div>
      )}

      {[...ledger.proposals.map((p) => ({ ...p, kind_of: 'proposal', on: p.sent_on })),
        ...ledger.orders.map((o) => ({ ...o, kind_of: 'order', on: o.received_on })),
        ...ledger.invoices.map((i) => ({ ...i, kind_of: 'invoice', on: i.issued_on })),
        ...ledger.payments.map((p) => ({ ...p, kind_of: 'payment', on: p.received_on }))]
        .sort((a, b) => String(b.on).localeCompare(String(a.on)) || b.id - a.id)
        .map((row) => {
          const struck = (row.kind_of === 'order' && row.status === 'CANCELLED')
            || (row.kind_of === 'invoice' && row.status === 'CANCELLED')
            || (row.kind_of === 'payment' && row.is_void)
            || (row.kind_of === 'proposal' && row.status === 'WITHDRAWN');
          return (
            <div key={`${row.kind_of}-${row.id}`} className={`ledger-row${struck ? ' is-struck' : ''}`}>
              <span className="ledger-kind">{row.kind_of === 'order' ? ORDER_KIND_LABEL[row.kind] : row.kind_of}</span>
              <span className="grow small">
                {row.kind_of === 'proposal' && (row.title || 'Proposal')}
                {row.kind_of === 'order' && (row.reference || 'no number')}
                {row.kind_of === 'invoice' && (row.number || 'no number')}
                {row.kind_of === 'payment' && (row.reference || 'no reference')}
                {row.link && <> · <a className="btn-link" href={row.link} target="_blank" rel="noopener noreferrer">open</a></>}
                {row.kind_of === 'proposal' && (
                  <> · <Badge tone={PROPOSAL_STATUS_META[row.status]?.tone}>{PROPOSAL_STATUS_META[row.status]?.label}</Badge></>
                )}
                {row.kind_of === 'invoice' && row.paid !== null && row.paid !== undefined && (
                  <span className="muted"> · {formatMoney(row.paid, row.currency)} paid</span>
                )}
                {struck && (row.cancel_reason || row.void_reason) && (
                  <span className="muted"> · {row.cancel_reason || row.void_reason}</span>
                )}
              </span>
              <span className="small muted">{formatDate(row.on)}</span>
              <span className="small tnum" style={{ minWidth: 70, textAlign: 'right' }}>
                {row.amount === null ? <span className="muted">no amount</span> : formatMoney(row.amount, row.currency)}
              </span>
              {canEdit && !struck && row.kind_of === 'proposal' && (
                <select className="select" style={{ width: 'auto' }} value=""
                  onChange={(e) => e.target.value && run(
                    () => api.setProposalStatus(opportunity.id, row.id, { status: e.target.value }), 'Proposal updated',
                  )}>
                  <option value="">Mark…</option>
                  {Object.entries(PROPOSAL_STATUS_META).filter(([k]) => k !== row.status).map(([k, meta]) => (
                    <option key={k} value={k}>{meta.label}</option>
                  ))}
                </select>
              )}
              {canEdit && !struck && row.kind_of === 'order' && (
                <button type="button" className="btn-link small"
                  onClick={() => withReason('Cancel this order', (reason) => api.cancelOrder(opportunity.id, row.id, reason))}>cancel</button>
              )}
              {canEdit && !struck && row.kind_of === 'invoice' && (
                <button type="button" className="btn-link small"
                  onClick={() => withReason('Cancel this invoice', (reason) => api.cancelInvoice(opportunity.id, row.id, reason))}>cancel</button>
              )}
              {canEdit && !struck && row.kind_of === 'payment' && (
                <button type="button" className="btn-link small"
                  onClick={() => withReason('Void this payment', (reason) => api.voidPayment(opportunity.id, row.id, reason))}>void</button>
              )}
            </div>
          );
        })}
      {ledger.proposals.length + ledger.orders.length + ledger.invoices.length + ledger.payments.length === 0 && (
        <div className="small muted">
          Nothing recorded yet. A proposal, an order, an invoice and a payment are four different
          facts — record each when it happens, and the totals above stay honest.
        </div>
      )}
    </div>
  );
}

const HISTORY_FIELD = {
  stage: 'Stage', status: 'Status', owner_user_id: 'Owner', escalation_owner_id: 'Escalation',
  next_step: 'Next action', next_step_due: 'Next action date', next_step_owner_id: 'Next action owner',
  estimated_value: 'Estimated value', proposed_value: 'Proposed value', agreed_value: 'Agreed value',
  collected_value: 'Collected (typed)', expected_close: 'Expected close', financial_status: 'Money status',
  created: 'Created', name: 'Name', probability: 'Probability',
};

/** Who changed what, from what, to what — and why. */
function HistoryPanel({ history }) {
  const { userById } = useRefData();
  const [all, setAll] = useState(false);
  if (!history?.length) return null;
  const shown = all ? history : history.slice(0, 6);
  // people by name and money as money, so a change reads the way it was meant
  const person = (field, value) => {
    if (value === null || value === undefined) return value;
    if (/_id$/.test(field)) return userById[Number(value)]?.full_name || `#${value}`;
    if (/_value$/.test(field) && !Number.isNaN(Number(value))) return formatMoney(Number(value)) || value;
    return value;
  };
  return (
    <div className="stack-sm">
      <span className="stat-label">What changed</span>
      {shown.map((h) => (
        <div key={h.id} className="history-row small">
          <span className="history-what">
            <strong>{HISTORY_FIELD[h.field] || h.field.replaceAll('_', ' ')}</strong>
            {h.field !== 'created' && (
              <> {h.from_value !== null ? <span className="muted">{person(h.field, h.from_value)} → </span> : ''}{person(h.field, h.to_value) ?? 'cleared'}</>
            )}
            {h.is_reversal && <Badge tone="warning">moved back</Badge>}
            {h.evidence_missing?.length > 0 && <Badge tone="critical">moved without evidence</Badge>}
          </span>
          {h.reason && <span className="history-why">“{h.reason}”</span>}
          <span className="muted">{h.actor_name || 'Someone'} · {relativeTime(h.created_at)}</span>
        </div>
      ))}
      {history.length > 6 && (
        <button type="button" className="btn-link small" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all ${history.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * The scope questions that matter for this kind of partner.
 *
 * The fields come from the organization's segment, so a CSR team is asked about
 * budget cycles and impact reporting while an input manufacturer is asked about
 * territories and dealer networks. They are prompts: an unanswered one stays
 * blank rather than being filled with a guess, and a partner who does not fit the
 * template is still recorded — the free-text summary is always there.
 */
function ScopePanel({ opportunity, template, segmentName, canEdit, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [summary, setSummary] = useState('');
  const [saving, setSaving] = useState(false);

  const scope = opportunity.scope || {};
  const answered = template.filter((f) => scope[f.key]);

  const startEdit = () => {
    setForm(Object.fromEntries(template.map((f) => [f.key, scope[f.key] ?? ''])));
    setSummary(opportunity.scope_summary || '');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      // anything already in scope that the template does not cover is preserved —
      // a segment change must not silently discard what somebody wrote
      const next = { ...scope };
      for (const field of template) {
        const value = String(form[field.key] ?? '').trim();
        if (value) next[field.key] = value;
        else delete next[field.key];
      }
      await api.updateOpportunity(opportunity.id, {
        scope: next,
        scope_summary: summary.trim() || null,
      });
      toast.success('Scope saved');
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const extras = Object.keys(scope).filter((key) => !template.some((f) => f.key === key));

  return (
    <div className="stack-sm">
      <div className="row-between wrap">
        <span className="stat-label">
          Scope{segmentName ? ` · what matters for a ${segmentName.toLowerCase()}` : ''}
        </span>
        {canEdit && (
          <button type="button" className="btn-link small" onClick={() => (editing ? setEditing(false) : startEdit())}>
            {editing ? 'Cancel' : 'Edit scope'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="stack-sm">
          {template.length === 0 && (
            <div className="small muted">
              This organization has no segment set, so there are no tailored prompts. Set one on the
              "Who they are" tab and the right questions appear here.
            </div>
          )}
          <div className="grid-2">
            {template.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <input className="input" value={form[field.key] ?? ''}
                  onChange={(e) => setForm((c) => ({ ...c, [field.key]: e.target.value }))} />
              </Field>
            ))}
          </div>
          <Field label="Anything the prompts do not cover">
            <textarea className="textarea" rows={2} value={summary}
              onChange={(e) => setSummary(e.target.value)} />
          </Field>
          <div className="small muted">
            Leave a prompt blank if you do not know. Blank means unknown, and unknown is worth
            recording honestly.
          </div>
          <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save scope'}
          </button>
        </div>
      ) : (
        <>
          {answered.length === 0 && extras.length === 0 && !opportunity.scope_summary ? (
            <div className="small muted">
              {template.length > 0
                ? `Nothing pinned down yet. ${template.length} question${template.length === 1 ? '' : 's'} worth asking: ${template.map((f) => f.label.toLowerCase()).join(', ')}.`
                : 'Nothing recorded, and no segment set to suggest what to ask.'}
            </div>
          ) : (
            <dl className="scope-grid">
              {answered.map((field) => (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{scope[field.key]}</dd>
                </div>
              ))}
              {extras.map((key) => (
                <div key={key}>
                  <dt>{key.replaceAll('_', ' ')}</dt>
                  <dd>{String(scope[key])}</dd>
                </div>
              ))}
            </dl>
          )}
          {answered.length > 0 && answered.length < template.length && (
            <div className="small muted">
              Still open: {template.filter((f) => !scope[f.key]).map((f) => f.label.toLowerCase()).join(', ')}.
            </div>
          )}
          {opportunity.scope_summary && (
            <p className="small">{opportunity.scope_summary}</p>
          )}
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

/** One deal, opened: everything about it that decides what happens next. */
function DealBody({ summary, canEditList, onChanged, onMove }) {
  const [detail, setDetail] = useState(null);
  const toast = useToast();

  const load = useCallback(() => {
    api.opportunity(summary.id).then(setDetail).catch((err) => toast.error(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.id]);
  useEffect(load, [load, summary]);

  const opportunity = detail?.opportunity || summary;
  const canEdit = detail ? detail.can_edit : canEditList;
  const changed = () => {
    load();
    onChanged();
  };

  return (
    <div className="opportunity-body">
      <div className="deal-top">
        <NextActionPanel opportunity={opportunity} canEdit={canEdit} onChanged={changed} />
        <div className="stack-sm">
          <span className="stat-label">Last heard, last chased, last touched</span>
          <Clocks opportunity={opportunity} />
        </div>
      </div>
      <hr className="divider" />
      <PeoplePanel opportunity={opportunity} handovers={detail?.handovers} canEdit={canEdit} onChanged={changed} />
      <hr className="divider" />
      <ValuePanel opportunity={opportunity} ledger={detail?.commercial} canEdit={canEdit} onChanged={changed} />
      <hr className="divider" />
      <CommercialPanel opportunity={opportunity} ledger={detail?.commercial} canEdit={canEdit} onChanged={changed} />
      <hr className="divider" />
      <ScopePanel opportunity={opportunity} template={summary.segmentTemplate || []}
        segmentName={summary.segmentName} canEdit={canEdit} onChanged={changed} />
      <hr className="divider" />
      <RequirementsPanel opportunity={opportunity} canEdit={canEdit} onChanged={changed} />
      {detail?.history?.length > 0 && (
        <>
          <hr className="divider" />
          <HistoryPanel history={detail.history} />
        </>
      )}
      {canEdit && (
        <div className="row wrap">
          <button type="button" className="btn btn-sm" onClick={() => onMove(opportunity)}>
            Move stage
          </button>
        </div>
      )}
    </div>
  );
}

export default function CrmOpportunities({
  accountId, opportunities, stages, canEdit, onChanged, segmentTemplate = [], segmentName = null,
  relationshipOwnerId = null, focusId = null,
}) {
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(null);
  const [open, setOpen] = useState(() => focusId ?? opportunities[0]?.id ?? null);

  useEffect(() => {
    if (!focusId) return;
    setOpen(focusId);
    // the board sent us to one deal; bring it into view
    const node = document.getElementById(`deal-${focusId}`);
    if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusId]);

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>Opportunities & scope</h2>
          <div className="small muted">
            Each deal has its own stage, value, owner and next action. Winning one does not end the relationship.
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
            const live = opportunity.status === 'ACTIVE';
            return (
              <div key={opportunity.id} id={`deal-${opportunity.id}`}
                className={`opportunity${live ? '' : ' is-settled'}`}>
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
                      {live && <Clocks opportunity={opportunity} compact />}
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
                    {live && <NextActionLine opportunity={opportunity} compact />}
                    {opportunity.gaps?.length > 0 && (
                      <span className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                        {opportunity.gaps
                          .filter((gap) => gap.kind !== 'no_next_step' && gap.kind !== 'no_next_step_date')
                          .map((gap) => (
                            <span key={gap.kind} className="kr-flag kr-flag-warning">{gap.label}</span>
                          ))}
                      </span>
                    )}
                  </span>
                  <Icon name="chevron" size={13}
                    style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />
                </button>

                {expanded && (
                  <DealBody
                    summary={{ ...opportunity, segmentTemplate, segmentName }}
                    canEditList={canEdit}
                    onChanged={onChanged}
                    onMove={setMoving}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <NewOpportunityDialog accountId={accountId} stages={stages} relationshipOwnerId={relationshipOwnerId}
          onClose={() => setAdding(false)} onSaved={onChanged} />
      )}
      {moving && (
        <DealMoveDialog opportunity={moving} stages={stages}
          onClose={() => setMoving(null)} onMoved={onChanged} />
      )}
    </section>
  );
}
