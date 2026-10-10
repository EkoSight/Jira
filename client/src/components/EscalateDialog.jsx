import { useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Field, Modal } from './ui.jsx';
import { PersonSelect } from './DealParts.jsx';

/**
 * Taking a deal higher: to its escalation point, or someone named, with what
 * needs deciding or unblocking. They are told once a day at most, and the
 * deal's history keeps who escalated it, to whom and why.
 */
export default function EscalateDialog({ deal, onClose, onDone }) {
  const toast = useToast();
  const [to, setTo] = useState(String(deal.escalation_owner_id || ''));
  const [reason, setReason] = useState(deal.suggested_reason || '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const send = async () => {
    if (!to) return setError('Name who to take it to');
    if (reason.trim().length < 5) return setError('Say what needs deciding or unblocking');
    setSaving(true);
    try {
      const result = await api.escalateDeal(deal.id, {
        reason: reason.trim(),
        to_user_id: String(to) === String(deal.escalation_owner_id || '') ? null : Number(to),
      });
      toast.success(`Escalated to ${result.escalated_to.full_name}`);
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
    return undefined;
  };

  return (
    <Modal
      title={`Escalate ${deal.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={saving}>
            {saving ? 'Sending…' : 'Escalate'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="To *" hint={deal.escalation_owner_id ? 'The deal’s escalation point, unless you pick someone else' : 'This deal has no escalation point — name someone'}>
          <PersonSelect value={to} onChange={(v) => { setTo(v); setError(null); }} placeholder="Pick someone" />
        </Field>
        <Field label="What needs deciding or unblocking? *" error={error}>
          <textarea className="textarea" rows={3} autoFocus value={reason}
            onChange={(e) => { setReason(e.target.value); setError(null); }}
            placeholder="Their CFO wants a call with someone senior before approving the rate" />
        </Field>
      </div>
    </Modal>
  );
}
