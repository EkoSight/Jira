import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Field, Icon, Modal, Spinner } from './ui.jsx';
import { OrderFields, emptyOrder, orderBody } from './DealParts.jsx';
import { exactMoney, formatMoney } from '../lib/crm.js';

/**
 * The moment a lead becomes a customer or partner.
 *
 * It used to be one click that changed a label and nothing else, so a lead
 * marked as a customer never showed up as a win. It now asks what makes the
 * record true: which deal did they sign — and, because Won needs it, the
 * accepted order or contract itself. (Moving a deal to Won or Lost from the
 * board goes through the deal move dialog, with the same checks.)
 */

/** Marking a lead as a customer (or partner), and naming the deal they signed. */
export function ConvertDialog({ account, type = 'CUSTOMER', onClose, onDone }) {
  const toast = useToast();
  const [deals, setDeals] = useState(null);
  const [dealId, setDealId] = useState('');
  const [agreed, setAgreed] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [agreementType, setAgreementType] = useState('');
  const [order, setOrder] = useState(emptyOrder);
  const [missing, setMissing] = useState(null);
  const [override, setOverride] = useState('');
  const [canOverride, setCanOverride] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.account(account.id)
      .then((detail) => {
        const open = (detail.opportunities || []).filter((o) => o.status !== 'WON' && o.status !== 'LOST');
        setDeals(open);
        // the headline deal is almost always the one that was signed
        const primary = open.find((o) => o.id === detail.account.primary_opportunity_id) || open[0];
        if (primary) {
          setDealId(String(primary.id));
          const hint = primary.proposed_value ?? primary.estimated_value;
          if (hint !== null && hint !== undefined) setAgreed(String(hint));
        }
      })
      .catch((err) => { toast.error(err); setDeals([]); });
  }, [account.id]);

  const chosen = deals?.find((d) => String(d.id) === dealId);
  // the Won stage asks for the accepted order; one already on the deal will do
  const needsOrder = Boolean(chosen) && !(chosen.order_count > 0);

  const save = async () => {
    setSaving(true);
    try {
      await api.convertAccount(account.id, type, {
        opportunity_id: dealId ? Number(dealId) : null,
        agreed_value: dealId && agreed !== '' ? Number(agreed) : null,
        agreement_date: dealId ? date || null : null,
        agreement_type: dealId ? agreementType.trim() || null : null,
        ...(needsOrder ? { order: orderBody({ ...order, amount: order.amount === '' ? agreed : order.amount }) } : {}),
        ...(override.trim() ? { override_reason: override.trim() } : {}),
      });
      toast.success(dealId
        ? `${account.name} is a ${type === 'CUSTOMER' ? 'customer' : 'partner'} — counted as won this month`
        : `${account.name} is a ${type === 'CUSTOMER' ? 'customer' : 'partner'}`);
      onDone();
      onClose();
    } catch (err) {
      if (err.details?.code === 'STAGE_EVIDENCE_REQUIRED') {
        setMissing(err.details.missing || []);
        setCanOverride(Boolean(err.details.can_override));
      } else {
        toast.error(err);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Mark ${account.name} as a ${type === 'CUSTOMER' ? 'customer' : 'partner'}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !deals}>
            {saving ? 'Saving…' : type === 'CUSTOMER' ? 'Mark as customer' : 'Mark as partner'}
          </button>
        </>
      }
    >
      {!deals ? <Spinner label="Loading their deals" /> : (
        <div className="stack">
          <Field
            label="Which deal did they sign?"
            hint="That deal is marked won today, which is what the dashboard's Won count and this month's list read."
          >
            <select className="select" value={dealId} onChange={(e) => setDealId(e.target.value)}>
              {deals.map((deal) => (
                <option key={deal.id} value={deal.id}>
                  {deal.name}
                  {deal.eligible_value !== null && deal.eligible_value !== undefined
                    ? ` — ${formatMoney(deal.eligible_value, deal.currency)}` : ''}
                </option>
              ))}
              <option value="">None of these — no deal to mark as won</option>
            </select>
          </Field>

          {dealId ? (
            <>
              <div className="grid-2">
                <Field label="Agreed amount (₹)" hint="What they signed for. Not the same as money received.">
                  <input className="input" type="number" min="0" value={agreed}
                    onChange={(e) => setAgreed(e.target.value)} />
                </Field>
                <Field label="Signed on">
                  <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
              </div>
              <Field label="What did they sign?" hint="Purchase order, service agreement, MoU…">
                <input className="input" value={agreementType}
                  onChange={(e) => setAgreementType(e.target.value)} placeholder="Purchase order" />
              </Field>
              {chosen && agreed !== '' && (
                <div className="small muted">
                  Recorded as {exactMoney(Number(agreed), chosen.currency)} agreed on “{chosen.name}”.
                </div>
              )}
              {needsOrder ? (
                <div className="evidence-form">
                  <div className="small" style={{ fontWeight: 650 }}>The accepted order or contract</div>
                  <div className="small muted">Won needs it on record — its date, and its number or a link.</div>
                  <OrderFields value={order} onChange={setOrder} />
                </div>
              ) : chosen && (
                <div className="small muted"><Icon name="check" size={12} /> The order for this deal is already on record.</div>
              )}
              {missing && missing.length > 0 && (
                <div className="ask-banner ask-critical">
                  <Icon name="alert" size={15} />
                  <div className="grow">
                    <strong>Won needs this first</strong>
                    <ul className="gap-list">
                      {missing.map((m) => <li key={`${m.phase}-${m.rule}`}>{m.label}{m.hint ? ` — ${m.hint}` : ''}</li>)}
                    </ul>
                    {canOverride && (
                      <Field label="Mark it won anyway — say why" hint="Kept on the deal's history as a move made without evidence">
                        <textarea className="textarea" rows={2} value={override} onChange={(e) => setOverride(e.target.value)} />
                      </Field>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="callout is-quiet small">
              They will be listed among this month's new customers, but no deal will count as won.
              Use this only when the deal really is not in TaskFlow.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
