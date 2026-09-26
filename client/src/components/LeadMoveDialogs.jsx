import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Field, Modal, Spinner } from './ui.jsx';
import { exactMoney, formatMoney } from '../lib/crm.js';

/**
 * The two moments a lead's outcome is decided from the board or its header.
 *
 * Both used to be one click that changed a label and nothing else, so a lead
 * marked as a customer never showed up as a win. Each now asks the one question
 * that makes the record true — which deal did they sign, or why did we lose it —
 * and nothing more.
 */

/** Marking a lead as a customer (or partner), and naming the deal they signed. */
export function ConvertDialog({ account, type = 'CUSTOMER', onClose, onDone }) {
  const toast = useToast();
  const [deals, setDeals] = useState(null);
  const [dealId, setDealId] = useState('');
  const [agreed, setAgreed] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [agreementType, setAgreementType] = useState('');
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

  const save = async () => {
    setSaving(true);
    try {
      await api.convertAccount(account.id, type, {
        opportunity_id: dealId ? Number(dealId) : null,
        agreed_value: dealId && agreed !== '' ? Number(agreed) : null,
        agreement_date: dealId ? date || null : null,
        agreement_type: dealId ? agreementType.trim() || null : null,
      });
      toast.success(dealId
        ? `${account.name} is a ${type === 'CUSTOMER' ? 'customer' : 'partner'} — counted as won this month`
        : `${account.name} is a ${type === 'CUSTOMER' ? 'customer' : 'partner'}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err);
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

/**
 * Moving a lead into Won or Lost from the board or its header.
 * A loss needs a reason; a win can carry what was agreed.
 */
export function SettleDialog({ account, stage, onClose, onDone }) {
  const toast = useToast();
  const lost = stage.kind === 'lost';
  const [reason, setReason] = useState('');
  const [agreed, setAgreed] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (lost && reason.trim().length < 3) {
      return toast.error('Say why it was lost — that is the only thing a closed deal can still teach anyone');
    }
    setSaving(true);
    try {
      await api.moveAccountStage(account.id, stage.id, lost
        ? { reason: reason.trim() }
        : { agreed_value: agreed === '' ? null : Number(agreed) });
      toast.success(`Moved to ${stage.name}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${account.name}: ${stage.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : `Move to ${stage.name}`}
          </button>
        </>
      }
    >
      {lost ? (
        <Field label="Why was it lost? *" hint="The only thing a closed deal can still teach anyone">
          <textarea className="textarea" rows={3} autoFocus value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Budget moved to next financial year; they liked the evidence." />
        </Field>
      ) : (
        <div className="stack">
          <div className="small muted">
            Their main deal is marked won today and counts in this month's Won figure.
          </div>
          <Field label="Agreed amount (₹)" hint="Leave blank if it is not settled yet">
            <input className="input" type="number" min="0" autoFocus value={agreed}
              onChange={(e) => setAgreed(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
