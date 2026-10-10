import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useRefData } from '../state/AppState.jsx';
import { Avatar, Badge, Field, Icon } from './ui.jsx';
import { dayLabel, describeConflict } from '../lib/availability.js';
import {
  CLOCKS, NEXT_ACTION_GAP_META, ORDER_KINDS, agoWords, clockTone, firstName, nextActionGaps,
  todayInIndia,
} from '../lib/crm.js';
import { formatDate } from '../lib/format.js';

/**
 * The small pieces every deal screen shares, so the next action, the three
 * clocks and the evidence forms read the same on the board, the deal, the
 * completion prompt and the move dialog.
 */

/** A date `days` from today in India, as YYYY-MM-DD. */
export const dayFromToday = (days) => todayInIndia(new Date(Date.now() + days * 86_400_000));

/**
 * Where a next action form starts: the deal's current one, its date only if it
 * has not already passed, and whoever owes it — or, failing that, the person
 * who leads the deal.
 */
export function nextActionDraft(opportunity, fallbackOwnerId = '') {
  const due = opportunity?.next_step_due ? String(opportunity.next_step_due).slice(0, 10) : '';
  return {
    next_step: opportunity?.next_step || '',
    next_step_owner_id: String(opportunity?.next_step_owner_id || opportunity?.owner_user_id || fallbackOwnerId || ''),
    next_step_due: due && due >= todayInIndia() ? due : dayFromToday(3),
  };
}

/** What is wrong with a next action draft, in words, or null. */
export function nextActionProblem(draft) {
  if (!String(draft.next_step || '').trim()) return 'Say what happens next';
  if (String(draft.next_step).trim().length < 3) return 'Describe the next action in a few words';
  if (!draft.next_step_owner_id) return 'Name who owes it';
  if (!draft.next_step_due) return 'Give it a date';
  if (draft.next_step_due < todayInIndia()) return 'That date has already passed';
  return null;
}

/** The draft as the API wants it. */
export const nextActionBody = (draft) => ({
  next_step: String(draft.next_step).trim(),
  next_step_owner_id: Number(draft.next_step_owner_id),
  next_step_due: draft.next_step_due,
});

/** Somebody to pick, with who is away today said beside their name. */
export function PersonSelect({ value, onChange, placeholder = 'Pick someone', allowNone = false, id }) {
  const { users } = useRefData();
  return (
    <select id={id} className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled={!allowNone}>{placeholder}</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.full_name}{u.away_today ? ' — away today' : ''}
        </option>
      ))}
    </select>
  );
}

/**
 * Said, never blocking: whoever owes it is away on the day it is due, and the
 * day they are back.
 */
function AwayOnDue({ ownerId, due, onMove }) {
  const [conflict, setConflict] = useState(null);
  useEffect(() => {
    if (!ownerId || !due) { setConflict(null); return undefined; }
    let cancelled = false;
    api.checkAvailability(ownerId, `${due}T12:00:00+05:30`)
      .then((r) => !cancelled && setConflict(r.conflict))
      .catch(() => !cancelled && setConflict(null));
    return () => { cancelled = true; };
  }, [ownerId, due]);
  const message = describeConflict(conflict);
  if (!message || !conflict?.on_due_date) return null;
  return (
    <div className="away-note small" role="status">
      <Icon name="clock" size={12} />
      <span className="grow">{message.headline}</span>
      {conflict.suggested_due_date && (
        <button type="button" className="btn-link small" onClick={() => onMove(conflict.suggested_due_date)}>
          Make it {dayLabel(conflict.suggested_due_date)}, when they are back
        </button>
      )}
    </div>
  );
}

/** What happens next, who owes it, and by when — always all three. */
export function NextActionFields({ value, onChange, error, label = 'What happens next' }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="next-action-fields">
      <Field label={`${label} *`} error={error}>
        <input className="input" value={value.next_step}
          onChange={(e) => set({ next_step: e.target.value })}
          placeholder="Send the revised rate card to their buyer" />
      </Field>
      <div className="grid-2">
        <Field label="Who owes it *">
          <PersonSelect value={value.next_step_owner_id} onChange={(v) => set({ next_step_owner_id: v })} />
        </Field>
        <Field label="By when *">
          <input className="input" type="date" min={todayInIndia()} value={value.next_step_due}
            onChange={(e) => set({ next_step_due: e.target.value })} />
        </Field>
      </div>
      <AwayOnDue ownerId={value.next_step_owner_id} due={value.next_step_due}
        onMove={(date) => set({ next_step_due: date })} />
    </div>
  );
}

/** The next action in one line, and the parts it is missing. */
export function NextActionLine({ opportunity, compact = false }) {
  const gaps = nextActionGaps(opportunity);
  const overdue = gaps.includes('next_action_overdue');
  const missing = gaps.filter((g) => g !== 'next_action_overdue');
  if (!opportunity.next_step) {
    return (
      <div className="next-action-line is-missing">
        <span className="kr-flag kr-flag-warning">No next action</span>
      </div>
    );
  }
  return (
    <div className={`next-action-line${overdue ? ' is-overdue' : ''}`}>
      <span className={compact ? 'truncate' : ''} title={opportunity.next_step}>
        <span className="muted">Next:</span> {opportunity.next_step}
      </span>
      <span className="next-action-meta">
        {opportunity.next_step_owner_name
          ? <span title={`Owed by ${opportunity.next_step_owner_name}`}>{firstName(opportunity.next_step_owner_name)}</span>
          : <span className="kr-flag kr-flag-warning">who?</span>}
        {opportunity.next_step_due
          ? (
            <span className={overdue ? 'is-late' : ''}>
              {overdue ? 'was due ' : 'by '}{formatDate(opportunity.next_step_due)}
            </span>
          )
          : <span className="kr-flag kr-flag-warning">when?</span>}
      </span>
      {!compact && missing.length > 0 && (
        <span className="row wrap" style={{ gap: 4 }}>
          {missing.map((gap) => (
            <span key={gap} className="kr-flag kr-flag-warning">{NEXT_ACTION_GAP_META[gap]?.label}</span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The three clocks. Compact on a card ("Them 5d · Us 2d"), spelled out on the
 * deal. The customer's clock comes first because it is the one that matters.
 */
export function Clocks({ opportunity, compact = false, quietAfter = 7 }) {
  if (compact) {
    return (
      <span className="clock-row">
        {CLOCKS.slice(0, 2).map((clock) => {
          const days = opportunity[clock.key];
          return (
            <span key={clock.key} className={`clock-chip clock-${clockTone(days, quietAfter)}`}
              title={`${clock.label}: ${agoWords(days)} — ${clock.hint}`}>
              {clock.short} {days === null || days === undefined ? '—' : days <= 0 ? 'today' : `${days}d`}
            </span>
          );
        })}
      </span>
    );
  }
  return (
    <div className="clock-grid">
      {CLOCKS.map((clock) => {
        const days = opportunity[clock.key];
        return (
          <div key={clock.key} className="clock-cell" title={clock.hint}>
            <div className="value-cell-label">{clock.label}</div>
            <div className={`clock-value clock-${clock.key === 'days_since_internal' ? 'neutral' : clockTone(days, quietAfter)}`}>
              {agoWords(days)}
            </div>
          </div>
        );
      })}
      {opportunity.awaiting_customer && (
        <div className="clock-note small muted">
          We have followed up since they last responded — the next move may be theirs.
        </div>
      )}
    </div>
  );
}

/** Who leads the deal, who owes the next move, who to escalate to, and who helps. */
export function DealPeople({ opportunity }) {
  const people = [
    ['Accountable owner', opportunity.owner_name, opportunity.owner_color],
    ['Owes the next move', opportunity.next_step_owner_name, opportunity.next_step_owner_color],
    ['Escalate to', opportunity.escalation_owner_name, opportunity.escalation_owner_color],
  ];
  return (
    <div className="people-grid">
      {people.map(([label, name, color]) => (
        <div key={label}>
          <div className="value-cell-label">{label}</div>
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            {name ? (
              <>
                <Avatar name={name} color={color} size={22} />
                <span className="small" style={{ fontWeight: 600 }}>{name}</span>
              </>
            ) : <span className="small muted">Nobody named</span>}
          </div>
        </div>
      ))}
      <div>
        <div className="value-cell-label">Helping</div>
        <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
          {(opportunity.collaborators || []).length === 0
            ? <span className="small muted">Nobody yet</span>
            : opportunity.collaborators.map((c) => (
              <Badge key={c.user_id} title={c.role || undefined}>{c.name}{c.role ? ` · ${c.role}` : ''}</Badge>
            ))}
        </div>
      </div>
    </div>
  );
}

/** A proposal, as the move dialog and the ledger capture it. */
export function ProposalFields({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="stack-sm">
      <div className="grid-2">
        <Field label="Sent on *">
          <input className="input" type="date" max={todayInIndia()} value={value.sent_on}
            onChange={(e) => set({ sent_on: e.target.value })} />
        </Field>
        <Field label="Amount (₹)" hint="Leave blank if it carried no price">
          <input className="input" type="number" min="0" value={value.amount}
            onChange={(e) => set({ amount: e.target.value })} />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Title or version">
          <input className="input" value={value.title} onChange={(e) => set({ title: e.target.value })}
            placeholder="Rate card, revision 2" />
        </Field>
        <Field label="Link to it">
          <input className="input" value={value.link} onChange={(e) => set({ link: e.target.value })}
            placeholder="https://drive.google.com/…" />
        </Field>
      </div>
    </div>
  );
}

export const emptyProposal = () => ({ sent_on: todayInIndia(), amount: '', title: '', link: '' });
export const proposalBody = (value) => ({
  sent_on: value.sent_on,
  amount: value.amount === '' ? null : Number(value.amount),
  title: value.title.trim() || null,
  link: value.link.trim() || null,
});

/** An accepted order or contract: a date, and something anyone can check. */
export function OrderFields({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="stack-sm">
      <div className="grid-2">
        <Field label="What they signed">
          <select className="select" value={value.kind} onChange={(e) => set({ kind: e.target.value })}>
            {ORDER_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Received on *">
          <input className="input" type="date" max={todayInIndia()} value={value.received_on}
            onChange={(e) => set({ received_on: e.target.value })} />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="PO or contract number" hint="This, or a link — something anyone can check">
          <input className="input" value={value.reference} onChange={(e) => set({ reference: e.target.value })}
            placeholder="PO/2026/0418" />
        </Field>
        <Field label="Amount (₹)" hint="Blank if the document has no amount">
          <input className="input" type="number" min="0" value={value.amount}
            onChange={(e) => set({ amount: e.target.value })} />
        </Field>
      </div>
      <Field label="Link to the document">
        <input className="input" value={value.link} onChange={(e) => set({ link: e.target.value })}
          placeholder="https://drive.google.com/…" />
      </Field>
    </div>
  );
}

export const emptyOrder = () => ({
  kind: 'PURCHASE_ORDER', reference: '', received_on: todayInIndia(), amount: '', link: '',
});
export const orderBody = (value) => ({
  kind: value.kind,
  reference: value.reference.trim() || null,
  received_on: value.received_on,
  amount: value.amount === '' ? null : Number(value.amount),
  link: value.link.trim() || null,
});
