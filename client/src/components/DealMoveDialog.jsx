import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Field, Icon, Modal } from './ui.jsx';
import {
  NextActionFields, OrderFields, ProposalFields, emptyOrder, emptyProposal, nextActionBody,
  nextActionDraft, nextActionProblem, orderBody, proposalBody,
} from './DealParts.jsx';
import { evidenceNeeds, stageEntryGaps } from '../lib/crm.js';

/**
 * Moving a deal — the one dialog every screen uses.
 *
 * It asks for exactly what the move needs and nothing else:
 *
 *   - the evidence the stage asks for (a dated proposal, an accepted order),
 *     captured right here so it is one step and not an errand;
 *   - what happens next, who owes it and by when, for any live stage — moving
 *     a deal is exactly when its old next step stops being true;
 *   - why it was lost, or what was signed.
 *
 * The server checks the same things and has the final word. When it refuses,
 * the dialog shows its list; a pipeline manager can then move it anyway by
 * writing down why, and that stays on the deal's history.
 */
export default function DealMoveDialog({ opportunity, stages, initialStageId = '', onClose, onMoved }) {
  const { user } = useAuth();
  const toast = useToast();
  const [stageId, setStageId] = useState(initialStageId ? String(initialStageId) : '');
  const [next, setNext] = useState(() => nextActionDraft(opportunity, user?.id));
  const [proposal, setProposal] = useState(emptyProposal);
  const [order, setOrder] = useState(emptyOrder);
  const [settle, setSettle] = useState({
    outcome_reason: '', revisit_on: '', agreement_type: '', agreement_date: '', agreed_value: '',
    financial_status: 'UNPAID',
  });
  const [serverMissing, setServerMissing] = useState(null);
  const [canOverride, setCanOverride] = useState(false);
  const [override, setOverride] = useState('');
  const [nextError, setNextError] = useState(null);
  const [saving, setSaving] = useState(false);

  const from = stages.find((s) => s.id === opportunity.stage_id) || null;
  const to = stages.find((s) => String(s.id) === String(stageId)) || null;
  const isWon = to?.kind === 'won';
  const isLost = to?.kind === 'lost';
  const isLive = to?.kind === 'open';

  const needs = useMemo(() => evidenceNeeds({ opportunity, from, to }), [opportunity, from, to]);
  const needsProposal = needs.some((n) => n.rule === 'proposal' && !n.met);
  const needsOrder = needs.some((n) => n.rule === 'order' && !n.met);
  // what the stage usually expects, said but not enforced
  const advisory = to?.kind === 'open' ? stageEntryGaps(opportunity, to)
    .filter((gap) => !['no_next_step', 'no_next_step_date'].includes(gap.kind)) : [];

  const setSettleField = (patch) => setSettle((current) => ({ ...current, ...patch }));

  const move = async () => {
    if (!to) return toast.error('Pick a stage');
    if (isLost && settle.outcome_reason.trim().length < 3) {
      return toast.error('Say why it was lost — that is the only thing a closed deal can still teach anyone');
    }
    if (isLive) {
      const problem = nextActionProblem(next);
      setNextError(problem);
      if (problem) return undefined;
    }

    const body = { stage_id: to.id };
    if (isLive) Object.assign(body, nextActionBody(next));
    if (needsProposal) body.proposal = proposalBody(proposal);
    if (needsOrder) body.order = orderBody(order);
    if (isLost) {
      body.outcome_reason = settle.outcome_reason.trim();
      if (settle.revisit_on) body.revisit_on = settle.revisit_on;
    }
    if (isWon) {
      if (settle.agreement_type.trim()) body.agreement_type = settle.agreement_type.trim();
      if (settle.agreement_date) body.agreement_date = settle.agreement_date;
      if (settle.agreed_value !== '') body.agreed_value = Number(settle.agreed_value);
      body.financial_status = settle.financial_status;
      if (settle.outcome_reason.trim()) body.outcome_reason = settle.outcome_reason.trim();
    }
    if (override.trim()) body.override_reason = override.trim();

    setSaving(true);
    try {
      await api.moveOpportunityStage(opportunity.id, body);
      toast.success(`${opportunity.name}: moved to ${to.name}`);
      onMoved?.();
      onClose();
    } catch (err) {
      const code = err.details?.code;
      if (code === 'STAGE_EVIDENCE_REQUIRED') {
        setServerMissing(err.details.missing || []);
        setCanOverride(Boolean(err.details.can_override));
        if (err.details.override_problem) toast.error(err.details.override_problem);
      } else if (code === 'NEXT_ACTION_REQUIRED' || code === 'NEXT_ACTION_INVALID') {
        setNextError(err.message);
      } else {
        toast.error(err);
      }
    } finally {
      setSaving(false);
    }
    return undefined;
  };

  return (
    <Modal
      title={`Move: ${opportunity.name}`}
      size="sheet"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={move} disabled={saving || !to}>
            {saving ? 'Moving…' : override.trim() ? 'Move it anyway' : to ? `Move to ${to.name}` : 'Move it'}
          </button>
        </>
      )}
    >
      <div className="stack">
        {opportunity.account_name && (
          <div className="small muted">
            {opportunity.account_name} · now in <strong>{from?.name || 'no stage'}</strong>
          </div>
        )}

        <Field label="Move to">
          <select className="select" value={stageId} autoFocus={!initialStageId}
            onChange={(e) => { setStageId(e.target.value); setServerMissing(null); setOverride(''); }}>
            <option value="">Pick a stage…</option>
            {stages.filter((s) => s.id !== opportunity.stage_id).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>

        {needs.length > 0 && !serverMissing?.length && (
          <div className="evidence-list">
            <div className="stat-label">Evidence this move needs</div>
            {needs.map((need) => (
              <div key={`${need.phase}-${need.rule}`} className={`evidence-need${need.met ? ' is-met' : ''}`}>
                <Icon name={need.met ? 'check' : 'alert'} size={14} />
                <div className="grow">
                  <div className="small" style={{ fontWeight: 600 }}>{need.label}</div>
                  <div className="small muted">
                    {need.met ? 'On record.' : need.hint}
                    {' '}({need.phase === 'exit' ? `to leave ${need.stage}` : `to enter ${need.stage}`})
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {needsProposal && (
          <div className="evidence-form">
            <div className="small" style={{ fontWeight: 650 }}>Record the proposal</div>
            <ProposalFields value={proposal} onChange={setProposal} />
          </div>
        )}

        {needsOrder && (
          <div className="evidence-form">
            <div className="small" style={{ fontWeight: 650 }}>Record the accepted order or contract</div>
            <OrderFields value={order} onChange={setOrder} />
          </div>
        )}

        {serverMissing && serverMissing.length > 0 && (
          <div className="ask-banner ask-critical">
            <Icon name="alert" size={15} />
            <div className="grow">
              <strong>{to?.name} needs this first</strong>
              <ul className="gap-list">
                {serverMissing.map((m) => <li key={`${m.phase}-${m.rule}`}>{m.label}{m.hint ? ` — ${m.hint}` : ''}</li>)}
              </ul>
              {canOverride ? (
                <Field label="Move it anyway — say why"
                  hint="As a pipeline manager you can. Your reason stays on the deal's history, and the move is listed as made without evidence.">
                  <textarea className="textarea" rows={2} value={override}
                    onChange={(e) => setOverride(e.target.value)}
                    placeholder="Why it is moving without this, in a sentence" />
                </Field>
              ) : (
                <div className="small muted">Add it, or ask a pipeline manager if this deal really is an exception.</div>
              )}
            </div>
          </div>
        )}

        {advisory.length > 0 && (
          <div className="ask-banner ask-warning">
            <Icon name="alert" size={15} />
            <div className="grow">
              <strong>{to.name} usually expects these too</strong>
              <ul className="gap-list">
                {advisory.map((gap) => <li key={gap.kind}>{gap.label}</li>)}
              </ul>
              <div className="small muted">Worth fixing, but not required to move.</div>
            </div>
          </div>
        )}

        {isLive && (
          <NextActionFields value={next} onChange={(v) => { setNext(v); setNextError(null); }} error={nextError} />
        )}

        {isWon && (
          <>
            <div className="small muted">
              What was actually agreed. A signed agreement is not money received — that is recorded
              as payments, separately.
            </div>
            <div className="grid-2">
              <Field label="Agreement type">
                <input className="input" value={settle.agreement_type}
                  onChange={(e) => setSettleField({ agreement_type: e.target.value })}
                  placeholder="Signed pilot agreement" />
              </Field>
              <Field label="Agreement date">
                <input className="input" type="date" value={settle.agreement_date}
                  onChange={(e) => setSettleField({ agreement_date: e.target.value })} />
              </Field>
              <Field label="Agreed value (₹)" hint="Blank keeps what is on the deal">
                <input className="input" type="number" min="0" value={settle.agreed_value}
                  onChange={(e) => setSettleField({ agreed_value: e.target.value })} />
              </Field>
              <Field label="Money status">
                <select className="select" value={settle.financial_status}
                  onChange={(e) => setSettleField({ financial_status: e.target.value })}>
                  <option value="NOT_APPLICABLE">No money involved</option>
                  <option value="UNPAID">Nothing invoiced yet</option>
                  <option value="INVOICED">Invoiced</option>
                  <option value="PART_PAID">Part paid</option>
                  <option value="PAID">Paid in full</option>
                </select>
              </Field>
            </div>
          </>
        )}

        {isLost && (
          <>
            <Field label="Why was it lost? *" hint="The only thing a closed deal can still teach anyone">
              <textarea className="textarea" rows={3} value={settle.outcome_reason}
                onChange={(e) => setSettleField({ outcome_reason: e.target.value })}
                placeholder="Budget moved to next financial year; they liked the evidence." />
            </Field>
            <Field label="Worth coming back to on" hint="Leave blank if there is no point">
              <input className="input" type="date" value={settle.revisit_on}
                onChange={(e) => setSettleField({ revisit_on: e.target.value })} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
