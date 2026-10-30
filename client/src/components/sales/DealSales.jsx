import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fetchBlobUrl } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, Field, Icon, Modal, Spinner } from '../ui.jsx';
import {
  ACCEPTANCE, PARTY_ROLE, PAYMENT_MODE, QUOTE_STATUS, dayOf, localDay, money, useSalesMeta,
} from '../../lib/sales.js';
import { CallButtons, FollowUpDialog, LogCallDialog, WhatsAppPanel } from './parts.jsx';

const AGREEMENT = { NOT_STARTED: 'Not started', DRAFTING: 'Drafting', UNDER_REVIEW: 'Under review', SIGNED: 'Signed', NOT_REQUIRED: 'Not required' };

// ---------------------------------------------------------------- CSR / NGO

function CsrPanel({ deal, csr, canWork, onChanged }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const edit = () => setForm({
    thematic_focus: (csr.thematic_focus || []).join(', '), proposed_project: csr.proposed_project || '', project_geography: csr.project_geography || '',
    beneficiaries: csr.beneficiaries || '', beneficiary_count: csr.beneficiary_count ?? '', requested_amount: csr.requested_amount ?? '',
    committed_amount: csr.committed_amount ?? '', funding_cycle: csr.funding_cycle || '', proposal_deadline: csr.proposal_deadline || '',
    agreement_status: csr.agreement_status || '', reporting_commitments: csr.reporting_commitments || '', reason: '',
  });
  const save = async () => {
    const body = {
      thematic_focus: form.thematic_focus.split(',').map((s) => s.trim()).filter(Boolean), proposed_project: form.proposed_project || null,
      project_geography: form.project_geography || null, beneficiaries: form.beneficiaries || null,
      beneficiary_count: form.beneficiary_count === '' ? null : Number(form.beneficiary_count),
      requested_amount: form.requested_amount === '' ? null : Number(form.requested_amount),
      committed_amount: form.committed_amount === '' ? null : Number(form.committed_amount),
      funding_cycle: form.funding_cycle || null, proposal_deadline: form.proposal_deadline || null, agreement_status: form.agreement_status || null,
      reporting_commitments: form.reporting_commitments || null, reason: form.reason || undefined,
    };
    try { await api.updateOpportunity(deal.id, body); toast.success('Saved'); setForm(null); onChanged(); } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack-sm">
      <div className="row-between"><h3 className="small">CSR / NGO details</h3>{canWork && <button type="button" className="btn btn-sm btn-ghost" onClick={edit}>Edit</button>}</div>
      <dl className="sales-dl">
        {[['Thematic focus', (csr.thematic_focus || []).join(', ')], ['Proposed project', csr.proposed_project], ['Geography', csr.project_geography],
          ['Beneficiaries', [csr.beneficiaries, csr.beneficiary_count ? `${Number(csr.beneficiary_count).toLocaleString('en-IN')} people` : null].filter(Boolean).join(' · ')],
          ['Funding requested', csr.requested_amount !== null ? money(csr.requested_amount, deal.currency) : null],
          ['Funding committed', csr.committed_amount !== null ? money(csr.committed_amount, deal.currency) : null],
          ['Funding cycle', csr.funding_cycle], ['Proposal deadline', csr.proposal_deadline ? dayOf(csr.proposal_deadline) : null],
          ['Agreement', AGREEMENT[csr.agreement_status]], ['Reporting', csr.reporting_commitments],
        ].map(([k, v]) => <div key={k} className="sales-dl-row"><dt>{k}</dt><dd>{v || <span className="muted">—</span>}</dd></div>)}
      </dl>
      <div className="small muted">A commitment is not money received: receipts are recorded under Payments.</div>
      {form && (
        <Modal title="CSR / NGO details" size="lg" onClose={() => setForm(null)} footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
          <div className="grid-2">
            <Field label="Thematic focus" hint="Comma-separated"><input className="input" value={form.thematic_focus} onChange={(e) => setForm({ ...form, thematic_focus: e.target.value })} placeholder="Soil health, Farmer livelihoods" /></Field>
            <Field label="Funding cycle"><input className="input" value={form.funding_cycle} onChange={(e) => setForm({ ...form, funding_cycle: e.target.value })} placeholder="FY 2026-27" /></Field>
            <Field label="Proposed project"><textarea className="textarea" rows={2} value={form.proposed_project} onChange={(e) => setForm({ ...form, proposed_project: e.target.value })} /></Field>
            <Field label="Geography"><input className="input" value={form.project_geography} onChange={(e) => setForm({ ...form, project_geography: e.target.value })} /></Field>
            <Field label="Intended beneficiaries"><input className="input" value={form.beneficiaries} onChange={(e) => setForm({ ...form, beneficiaries: e.target.value })} /></Field>
            <Field label="How many"><input className="input" type="number" min="0" value={form.beneficiary_count} onChange={(e) => setForm({ ...form, beneficiary_count: e.target.value })} /></Field>
            <Field label="Funding requested"><input className="input" type="number" min="0" value={form.requested_amount} onChange={(e) => setForm({ ...form, requested_amount: e.target.value })} /></Field>
            <Field label="Funding committed" hint="Only once the funder has committed"><input className="input" type="number" min="0" value={form.committed_amount} onChange={(e) => setForm({ ...form, committed_amount: e.target.value })} /></Field>
            <Field label="Proposal deadline"><input className="input" type="date" value={form.proposal_deadline} onChange={(e) => setForm({ ...form, proposal_deadline: e.target.value })} /></Field>
            <Field label="Agreement"><select className="select" value={form.agreement_status} onChange={(e) => setForm({ ...form, agreement_status: e.target.value })}><option value="">Not recorded</option>{Object.entries(AGREEMENT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Reporting commitments"><textarea className="textarea" rows={2} value={form.reporting_commitments} onChange={(e) => setForm({ ...form, reporting_commitments: e.target.value })} /></Field>
            <Field label="Why the amounts changed (if they did)"><input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- organizations on the deal

function Parties({ deal, parties, canWork, onChanged }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState([]);
  const [role, setRole] = useState('IMPLEMENTING_PARTNER');
  useEffect(() => {
    if (!adding || search.trim().length < 2) { setFound([]); return undefined; }
    const t = setTimeout(() => api.accounts({ search }).then((r) => setFound(r.accounts.slice(0, 8))).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [search, adding]);
  const add = (accountId) => api.sales.post(`/opportunities/${deal.id}/parties`, { account_id: accountId, role }).then(() => { toast.success('Linked'); setAdding(false); onChanged(); }).catch(toast.error);
  return (
    <div className="stack-sm">
      <div className="row-between"><h3 className="small">Organizations on this deal</h3>{canWork && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(true)}><Icon name="plus" size={12} /> Link</button>}</div>
      {parties.length === 0 ? <div className="small muted">Only {deal.account_name}. Link a funder, the one who signs or pays, or an implementing partner — the same organization is never created twice.</div>
        : parties.map((p) => (
          <div key={p.id} className="sales-row small">
            <Badge tone="brand">{PARTY_ROLE[p.role]}</Badge><Link to={`/accounts/${p.account_id}`} className="grow">{p.account_name}</Link>
            {canWork && <button type="button" className="btn btn-sm btn-ghost" onClick={() => api.sales.del(`/opportunities/${deal.id}/parties/${p.id}`).then(onChanged).catch(toast.error)}>Remove</button>}
          </div>
        ))}
      {adding && (
        <Modal title="Link an organization" onClose={() => setAdding(false)}>
          <div className="stack">
            <Field label="Role"><select className="select" value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(PARTY_ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Organization"><input className="input" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a name" /></Field>
            {found.map((a) => <button key={a.id} type="button" className="link-row" onClick={() => add(a.id)}>{a.name}</button>)}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- quotations and proposals

const blankLine = { product_id: '', description: '', quantity: '1', unit_price: '', discount_pct: '0', tax_rate: '' };

function QuoteEditor({ deal, quote, csr, onClose, onSaved }) {
  const toast = useToast();
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState(() => ({
    title: quote?.title || '', valid_until: quote?.valid_until ? String(quote.valid_until).slice(0, 10) : '', terms: quote?.terms || '', notes: quote?.notes || '',
    project_scope: quote?.project_scope || '', objectives: quote?.objectives || '', outcomes: quote?.outcomes || '', deliverables: quote?.deliverables || '',
    timeline: quote?.timeline || '', reporting_plan: quote?.reporting_plan || '', budget_notes: quote?.budget_notes || '',
    lines: quote?.lines?.length ? quote.lines.map((l) => ({ product_id: l.product_id || '', description: l.description, quantity: String(l.quantity), unit_price: String(l.unit_price), discount_pct: String(l.discount_pct), tax_rate: l.tax_rate === null ? (l.product_id ? '0' : '') : String(l.tax_rate) })) : [{ ...blankLine }],
  }));
  useEffect(() => { api.sales.get('/products').then((r) => setProducts(r.products)).catch(() => {}); }, []);
  const setLine = (i, patch) => setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const save = async () => {
    const lines = form.lines.filter((l) => l.description.trim()).map((l) => ({
      product_id: l.product_id ? Number(l.product_id) : null, description: l.description, quantity: l.quantity || '1',
      // a blank price or tax takes the catalogue's; type 0 for no tax
      ...(l.unit_price !== '' ? { unit_price: l.unit_price } : {}), discount_pct: l.discount_pct || '0',
      ...(l.tax_rate !== '' ? { tax_rate: l.tax_rate } : !l.product_id ? { tax_rate: null } : {}),
    }));
    const body = { ...Object.fromEntries(Object.entries(form).filter(([k, v]) => k !== 'lines' && v !== '')), lines };
    try {
      if (quote) await api.sales.patch(`/quotes/${quote.id}`, body);
      else await api.sales.post(`/opportunities/${deal.id}/quotes`, body);
      toast.success(quote?.status === 'APPROVED' ? 'Saved — it changed after approval, so it needs approving again' : 'Saved');
      onSaved();
      onClose();
    } catch (err) { toast.error(err); }
  };
  // a rough running total for the person typing; the server's exact figures are what is saved
  const est = form.lines.reduce((t, l) => {
    const p = products.find((x) => String(x.id) === String(l.product_id));
    const price = Number(l.unit_price !== '' ? l.unit_price : p?.unit_price || 0);
    const sub = price * Number(l.quantity || 0);
    const after = sub * (1 - Number(l.discount_pct || 0) / 100);
    const rate = l.tax_rate !== '' ? Number(l.tax_rate) : p?.tax_rate !== null && p?.tax_rate !== undefined ? Number(p.tax_rate) : 0;
    return t + after * (1 + rate / 100);
  }, 0);
  return (
    <Modal title={`${quote ? 'Edit' : 'New'} ${csr ? 'proposal' : 'quotation'}`} size="lg" onClose={onClose}
      footer={<><span className="small muted grow">About {money(est.toFixed(2), deal.currency)} — exact total when saved</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save draft</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Title"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={csr ? 'Soil health cards for 5,000 farmers' : 'Dealer soil-testing programme'} /></Field>
          <Field label="Valid until" hint="Blank: the default validity from Settings"><input className="input" type="date" value={form.valid_until} onChange={(e) => setForm({ ...form, valid_until: e.target.value })} /></Field>
        </div>
        {csr && (
          <div className="grid-2">
            {[['project_scope', 'Project scope'], ['objectives', 'Objectives'], ['deliverables', 'Deliverables'], ['outcomes', 'Expected outcomes'], ['timeline', 'Timeline'], ['reporting_plan', 'Reporting']].map(([k, l]) => (
              <Field key={k} label={l}><textarea className="textarea" rows={2} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>
            ))}
          </div>
        )}
        <h3 className="small">{csr ? 'Budget lines' : 'Lines'}</h3>
        <div className="table-scroll">
          <table className="data-table sales-lines">
            <thead><tr><th>Item</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Disc. %</th><th>Tax %</th><th /></tr></thead>
            <tbody>{form.lines.map((l, i) => (
              <tr key={i}>
                <td><select className="select" aria-label="Catalogue item" value={l.product_id} onChange={(e) => { const p = products.find((x) => String(x.id) === e.target.value); setLine(i, { product_id: e.target.value, description: p ? p.name : l.description, unit_price: '', tax_rate: '' }); }}>
                  <option value="">Free text</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
                <td><input className="input" aria-label="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                <td><input className="input" aria-label="Quantity" inputMode="decimal" style={{ width: 70 }} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                <td><input className="input" aria-label="Unit price" inputMode="decimal" style={{ width: 100 }} value={l.unit_price} placeholder={products.find((x) => String(x.id) === String(l.product_id))?.unit_price ?? ''} onChange={(e) => setLine(i, { unit_price: e.target.value })} /></td>
                <td><input className="input" aria-label="Discount percent" inputMode="decimal" style={{ width: 60 }} value={l.discount_pct} onChange={(e) => setLine(i, { discount_pct: e.target.value })} /></td>
                <td><input className="input" aria-label="Tax percent" title="Blank: the catalogue’s rate. 0: no tax." inputMode="decimal" style={{ width: 60 }} value={l.tax_rate} placeholder={products.find((x) => String(x.id) === String(l.product_id))?.tax_rate ?? ''} onChange={(e) => setLine(i, { tax_rate: e.target.value })} /></td>
                <td><button type="button" className="btn btn-sm btn-ghost" aria-label="Remove line" onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}><Icon name="trash" size={13} /></button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, { ...blankLine }] }))}><Icon name="plus" size={12} /> Add a line</button>
        <Field label="Terms"><textarea className="textarea" rows={2} value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} placeholder="Blank: the standard terms from Settings" /></Field>
        {csr && <Field label="Budget notes"><textarea className="textarea" rows={2} value={form.budget_notes} onChange={(e) => setForm({ ...form, budget_notes: e.target.value })} /></Field>}
      </div>
    </Modal>
  );
}

function QuoteView({ deal, quoteId, csr, canWork, onClose, onChanged }) {
  const toast = useToast();
  const { user, can } = useAuth();
  const [q, setQ] = useState(null);
  const [editing, setEditing] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const load = useCallback(() => api.sales.get(`/quotes/${quoteId}`).then((r) => setQ(r.quote)).catch(toast.error), [quoteId, toast]);
  useEffect(() => { load(); }, [load]);
  if (!q) return <Modal title="Quotation" onClose={onClose}><Spinner /></Modal>;
  const step = (path, body, message) => api.sales.post(`/quotes/${q.id}/${path}`, body).then((r) => { toast.success(message); setQ(r.quote); onChanged(); }).catch(toast.error);
  const pending = q.approvals.find((a) => a.status === 'PENDING');
  const st = QUOTE_STATUS[q.status];
  const openPdf = async () => { try { window.open(await fetchBlobUrl(api.sales.url(`/quotes/${q.id}/pdf`)), '_blank', 'noopener'); } catch (err) { toast.error(err); } };
  return (
    <Modal title={`${q.number} · version ${q.version}`} size="lg" onClose={onClose}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge tone={st.tone}>{st.label}</Badge>
          <strong className="tnum">{money(q.total, q.currency)}</strong>
          <span className="small muted">valid until {dayOf(q.valid_until)}</span>
          {q.approval_required && q.approval_current && <Badge tone="good">Approved{q.approved_by_name ? ` by ${q.approved_by_name}` : ''}</Badge>}
        </div>
        {q.approval_reasons?.length > 0 && <div className="small muted">Needs approval because: {q.approval_reasons.join('; ')}</div>}
        {pending && <div className="mkt-callout is-warning small">Waiting for {pending.approver_names?.join(' or ') || 'an approver'}.</div>}
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Disc.</th><th className="num">Tax</th><th className="num">Total</th></tr></thead>
          <tbody>{q.lines.map((l) => <tr key={l.id}><td>{l.description}</td><td className="num tnum">{Number(l.quantity)}</td><td className="num tnum">{money(l.unit_price, q.currency)}</td><td className="num">{Number(l.discount_pct) ? `${Number(l.discount_pct)}%` : ''}</td><td className="num">{l.tax_rate !== null ? `${Number(l.tax_rate)}%` : ''}</td><td className="num tnum">{money(l.line_total, q.currency)}</td></tr>)}</tbody>
        </table></div>
        <div className="small">Subtotal {money(q.subtotal, q.currency)} · discount {money(q.discount_total, q.currency)} · tax {money(q.tax_total, q.currency)}</div>
        {q.acceptance_method && <div className="small">Accepted {dayOf(q.decided_on)} by {ACCEPTANCE[q.acceptance_method].toLowerCase()}{q.acceptance_note ? ` — ${q.acceptance_note}` : ''}. This records how they said yes; it is not an electronic signature.</div>}
        {q.decline_reason && <div className="small critical-text">{q.status === 'WITHDRAWN' ? 'Withdrawn' : 'Declined'}: {q.decline_reason}</div>}
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={openPdf}><Icon name="eye" size={13} /> PDF</button>
          {canWork && ['DRAFT', 'CHANGES_REQUESTED', 'APPROVED', 'IN_REVIEW'].includes(q.status) && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>}
          {canWork && ['DRAFT', 'CHANGES_REQUESTED'].includes(q.status) && <button type="button" className="btn btn-sm btn-primary" onClick={() => step('submit', {}, 'Submitted')}>Submit for approval</button>}
          {pending && can('crm.approve') && (pending.approver_ids || []).includes(user.id) && (
            <>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => api.sales.post(`/approvals/${pending.id}/decide`, { decision: 'APPROVED' }).then((r) => { setQ(r.quote); onChanged(); toast.success('Approved'); }).catch(toast.error)}>Approve</button>
              <button type="button" className="btn btn-sm" onClick={() => { const c = window.prompt('What needs to change?'); if (c) api.sales.post(`/approvals/${pending.id}/decide`, { decision: 'REJECTED', comment: c }).then((r) => { setQ(r.quote); onChanged(); }).catch(toast.error); }}>Return for changes</button>
            </>
          )}
          {canWork && q.status === 'APPROVED' && <button type="button" className="btn btn-sm btn-primary" onClick={() => { const to = window.prompt('Sent to (email or name)', ''); if (to !== null) step('send', { via: 'EMAIL', to }, 'Recorded as sent; it is now the deal’s proposal'); }}>Mark as sent</button>}
          {canWork && q.status === 'SENT' && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDeciding(true)}>Record their answer</button>}
          {canWork && !['ACCEPTED', 'WITHDRAWN', 'SUPERSEDED'].includes(q.status) && q.status !== 'DRAFT' && <button type="button" className="btn btn-sm" onClick={() => step('revise', {}, 'New version created')}>Revise</button>}
          {canWork && ['DRAFT', 'IN_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'SENT'].includes(q.status) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { const r = window.prompt('Why withdraw it?'); if (r) step('withdraw', { reason: r }, 'Withdrawn'); }}>Withdraw</button>}
        </div>
        {q.approvals.length > 0 && (
          <div className="stack-xs">
            <h3 className="small">Approval history</h3>
            {q.approvals.map((a) => <div key={a.id} className="small muted">{dayOf(a.requested_at)} · asked by {a.requested_by_name} · {a.status.toLowerCase()}{a.decided_by_name ? ` by ${a.decided_by_name}` : ''}{a.comment ? ` — ${a.comment}` : ''}</div>)}
          </div>
        )}
      </div>
      {editing && <QuoteEditor deal={deal} quote={q} csr={csr} onClose={() => setEditing(false)} onSaved={() => { load(); onChanged(); }} />}
      {deciding && <DecisionDialog quote={q} onClose={() => setDeciding(false)} onSaved={(r) => { setQ(r.quote); onChanged(); }} />}
    </Modal>
  );
}

function DecisionDialog({ quote, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ decision: 'ACCEPTED', decided_on: localDay(0), acceptance_method: 'PURCHASE_ORDER', note: '', decline_reason: '', evidence_url: '' });
  const save = () => api.sales.post(`/quotes/${quote.id}/decision`, { ...form, evidence_url: form.evidence_url || null }).then((r) => { toast.success('Recorded'); onSaved(r); onClose(); }).catch(toast.error);
  return (
    <Modal title="Their answer" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <div className="row" style={{ gap: 6 }}>{['ACCEPTED', 'DECLINED'].map((d) => <button key={d} type="button" className={`kind-chip${form.decision === d ? ' is-active' : ''}`} onClick={() => setForm({ ...form, decision: d })}>{d === 'ACCEPTED' ? 'Accepted' : 'Declined'}</button>)}</div>
        <Field label="On"><input className="input" type="date" value={form.decided_on} max={localDay(0)} onChange={(e) => setForm({ ...form, decided_on: e.target.value })} /></Field>
        {form.decision === 'ACCEPTED' ? (
          <>
            <Field label="How they said yes"><select className="select" value={form.acceptance_method} onChange={(e) => setForm({ ...form, acceptance_method: e.target.value })}>{Object.entries(ACCEPTANCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Link to the evidence (optional)" hint="The email, the PO or the signed copy in your files"><input className="input" value={form.evidence_url} onChange={(e) => setForm({ ...form, evidence_url: e.target.value })} /></Field>
            <Field label="Note"><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
            <div className="small muted">This records how acceptance was obtained. It is not a verified electronic signature.</div>
          </>
        ) : <Field label="Why *"><input className="input" value={form.decline_reason} onChange={(e) => setForm({ ...form, decline_reason: e.target.value })} /></Field>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- payments

function Payments({ deal, canWork, onChanged }) {
  const toast = useToast();
  const [p, setP] = useState(null);
  const [form, setForm] = useState(null);
  const load = useCallback(() => api.sales.get(`/opportunities/${deal.id}/payments`).then(setP).catch(() => setP({ error: true })), [deal.id]);
  useEffect(() => { load(); }, [load]);
  if (!p) return <Spinner />;
  if (p.error) return null;
  const run = (path, body, message) => api.sales.post(`/opportunities/${deal.id}/${path}`, body).then((r) => { toast.success(r.result?.duplicate ? 'Already recorded: that payment reference was applied before' : message); setForm(null); setP(r); onChanged(); }).catch(toast.error);
  return (
    <div className="stack-sm">
      <div className="row-between">
        <h3 className="small">Payments</h3>
        {canWork && deal.is_monetary && (
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm({ kind: 'schedule', label: '', due_on: '', amount: '', currency: deal.currency })}>Add due date</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm({ kind: 'receipt', received_on: localDay(0), amount: '', mode: 'BANK_TRANSFER', reference: '', schedule_id: '', currency: deal.currency })}>Record payment</button>
            {p.can_finance && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm({ kind: 'refund', received_on: localDay(0), amount: '', mode: 'BANK_TRANSFER', reference: '', currency: deal.currency, corrects_id: '' })}>Refund</button>}
          </div>
        )}
      </div>
      {!deal.is_monetary && <div className="small muted">A non-monetary partnership: no money is tracked or counted in totals.</div>}
      {p.currencies.map((c) => (
        <div key={c.currency} className="row wrap small" style={{ gap: 6 }}>
          {c.scheduled !== null && <Badge>Scheduled {money(c.scheduled, c.currency)}</Badge>}
          <Badge tone="good">Received {money(c.received, c.currency)}</Badge>
          {Number(c.refunds) > 0 && <Badge tone="warning">Refunded {money(c.refunds, c.currency)}</Badge>}
          {c.balance !== null && <Badge tone="brand">Balance {money(c.balance, c.currency)}</Badge>}
          {Number(c.overdue) > 0 && <Badge tone="critical">Overdue {money(c.overdue, c.currency)}</Badge>}
        </div>
      ))}
      {p.schedule.length > 0 && (
        <div className="table-scroll"><table className="data-table"><thead><tr><th>Due</th><th>For</th><th className="num">Amount</th><th className="num">Received</th><th className="num">Outstanding</th></tr></thead>
          <tbody>{p.schedule.map((s) => <tr key={s.id} className={s.overdue ? 'is-late' : ''}><td>{dayOf(s.due_on)}</td><td>{s.label}{s.is_cancelled ? ' (cancelled)' : ''}</td><td className="num tnum">{money(s.amount, s.currency)}</td><td className="num tnum">{money(s.received, s.currency)}</td><td className="num tnum">{s.is_cancelled ? '—' : money(s.outstanding, s.currency)}</td></tr>)}</tbody></table></div>
      )}
      {p.payments.map((x) => (
        <div key={x.id} className="sales-row small">
          <Badge tone={x.is_void ? 'neutral' : x.kind === 'REFUND' ? 'warning' : 'good'}>{x.is_void ? 'voided' : x.kind === 'REFUND' ? 'refund' : 'received'}</Badge>
          <span className="tnum">{money(x.amount, x.currency)}</span>
          <span className="grow muted">{dayOf(x.received_on)} · {PAYMENT_MODE[x.mode] || 'mode not recorded'}{x.reference ? ` · ${x.reference}` : ''}{x.void_reason ? ` · ${x.void_reason}` : ''}</span>
          {x.verified_at ? <Badge tone="good">verified</Badge> : !x.is_void && p.can_finance && <button type="button" className="btn btn-sm" onClick={() => run(`payments/${x.id}/verify`, {}, 'Verified')}>Verify</button>}
          {!x.is_void && (p.can_finance || (!x.verified_at && x.kind !== 'REFUND')) && canWork && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { const r = window.prompt('Why void it? (it stays visible with your reason)'); if (r) run(`payments/${x.id}/void`, { reason: r }, 'Voided'); }}>Void</button>}
        </div>
      ))}
      {form && (
        <Modal title={{ schedule: 'Add a due date', receipt: 'Record a payment received', refund: 'Record a refund' }[form.kind]} onClose={() => setForm(null)}
          footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => {
            const { kind, ...rest } = form;
            const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== ''));
            for (const k of ['schedule_id', 'corrects_id']) if (body[k]) body[k] = Number(body[k]);
            run(kind === 'schedule' ? 'schedule' : kind === 'receipt' ? 'receipts' : 'refunds', body, kind === 'schedule' ? 'Added' : 'Recorded');
          }}>Save</button></>}>
          <div className="stack">
            {form.kind === 'schedule' && <Field label="For"><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={deal.pipeline_key === 'csr' ? 'Tranche 1' : 'Advance 50%'} /></Field>}
            <div className="grid-2">
              <Field label={form.kind === 'schedule' ? 'Due on' : 'On'}><input className="input" type="date" value={form.kind === 'schedule' ? form.due_on : form.received_on} max={form.kind === 'schedule' ? undefined : localDay(0)} onChange={(e) => setForm({ ...form, [form.kind === 'schedule' ? 'due_on' : 'received_on']: e.target.value })} /></Field>
              <Field label="Amount"><input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="250000" /></Field>
              <Field label="Currency"><input className="input" value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field>
              {form.kind !== 'schedule' && <Field label="Mode"><select className="select" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>{Object.entries(PAYMENT_MODE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
              {form.kind !== 'schedule' && <Field label="Bank reference (UTR, cheque no.)" hint="The same reference is only ever applied once"><input className="input" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>}
              {form.kind === 'receipt' && p.schedule.length > 0 && <Field label="Pays"><select className="select" value={form.schedule_id} onChange={(e) => setForm({ ...form, schedule_id: e.target.value })}><option value="">The oldest due first</option>{p.schedule.filter((s) => !s.is_cancelled).map((s) => <option key={s.id} value={s.id}>{s.label} ({dayOf(s.due_on)})</option>)}</select></Field>}
              {form.kind === 'refund' && <Field label="Refund of"><select className="select" value={form.corrects_id} onChange={(e) => setForm({ ...form, corrects_id: e.target.value })}><option value="">Not tied to one payment</option>{p.payments.filter((x) => x.kind !== 'REFUND' && !x.is_void).map((x) => <option key={x.id} value={x.id}>{money(x.amount, x.currency)} on {dayOf(x.received_on)}</option>)}</select></Field>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the panel

/** The sales CRM's part of a deal, shown inside the existing deal view. */
export default function DealSales({ opportunity, onChanged }) {
  const toast = useToast();
  const { meta } = useSalesMeta();
  const [s, setS] = useState(null);
  const [dialog, setDialog] = useState(null);
  const load = useCallback(() => api.sales.get(`/opportunities/${opportunity.id}/sales`).then(setS).catch(() => setS({ error: true })), [opportunity.id]);
  useEffect(() => { load(); }, [load, opportunity.status, opportunity.stage_id]);
  if (!s) return <Spinner />;
  if (s.error) return null;
  const changed = () => { load(); onChanged?.(); };
  const csr = s.pipeline?.key === 'csr';
  const deal = { ...opportunity, is_monetary: s.is_monetary, pipeline_key: s.pipeline?.key, account_name: opportunity.account_name };
  const phone = s.contact?.phone || null;
  const target = { opportunity_id: opportunity.id };
  const handover = async () => {
    try {
      const r = await api.sales.post(`/opportunities/${opportunity.id}/handover`, {});
      toast.success(r.created ? 'Delivery started: kickoff tasks created for the delivery owner' : 'Delivery was already started; nothing was duplicated');
      changed();
    } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack sales-deal">
      <div className="row wrap" style={{ gap: 6 }}>
        <Badge tone="brand">{s.pipeline?.name || 'Pipeline'}</Badge>
        {s.opportunity_type_label && <Badge>{s.opportunity_type_label}</Badge>}
        {!s.is_monetary && <Badge>Non-monetary</Badge>}
        {s.renewal_of && <Link to={`/accounts/${opportunity.account_id}?deal=${s.renewal_of.id}`} className="small">Renews: {s.renewal_of.name}</Link>}
      </div>
      {s.can_work && (
        <div className="row wrap" style={{ gap: 6 }}>
          <CallButtons phone={phone} target={target} onLog={() => setDialog('call')} />
          {!phone && <button type="button" className="btn btn-sm" onClick={() => setDialog('call')}>Log call</button>}
          <button type="button" className="btn btn-sm" onClick={() => setDialog('followup')}>Follow-up</button>
          <button type="button" className="btn btn-sm" onClick={() => setDialog('whatsapp')}>WhatsApp</button>
        </div>
      )}
      {csr && <CsrPanel deal={deal} csr={s.csr} canWork={s.can_work} onChanged={changed} />}
      <Parties deal={deal} parties={s.parties} canWork={s.can_work} onChanged={changed} />
      <div className="stack-sm">
        <div className="row-between">
          <h3 className="small">{csr ? 'Proposals' : 'Quotations'}</h3>
          {s.can_work && opportunity.status === 'ACTIVE' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog('newquote')}><Icon name="plus" size={12} /> New {csr ? 'proposal' : 'quotation'}</button>}
        </div>
        {s.quotes.length === 0 ? <div className="small muted">None yet. A sent {csr ? 'proposal' : 'quotation'} is recorded as the deal’s proposal, which the proposal stages ask for.</div>
          : s.quotes.map((q) => (
            <button key={q.id} type="button" className="link-row" onClick={() => setDialog({ quote: q.id })}>
              <span className="tnum small">{q.number} v{q.version}</span>
              <span className="grow truncate small">{q.title || ''}</span>
              <span className="tnum small">{money(q.total, q.currency)}</span>
              <Badge tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</Badge>
            </button>
          ))}
      </div>
      <Payments deal={deal} canWork={s.can_work} onChanged={changed} />
      {opportunity.status === 'WON' && (
        <div className="stack-sm">
          <h3 className="small">Delivery and what comes next</h3>
          {s.engagement ? (
            <div className="sales-row small">
              <Badge tone={s.engagement.handover_status === 'ACCEPTED' ? 'good' : s.engagement.handover_status === 'RETURNED' ? 'critical' : 'warning'}>
                {s.engagement.handover_status === 'ACCEPTED' ? 'Handover accepted' : s.engagement.handover_status === 'RETURNED' ? 'Handover returned' : s.engagement.handover_status === 'IN_REVIEW' ? 'Handover in review' : 'Delivery started'}
              </Badge>
              <span className="grow">{s.engagement.name} · {s.engagement.state.toLowerCase()} · {s.engagement.open_tasks} open task{s.engagement.open_tasks === 1 ? '' : 's'}</span>
              {s.engagement.handover_status === 'IN_REVIEW' && <button type="button" className="btn btn-sm" onClick={() => setDialog('review')}>Review</button>}
            </div>
          ) : s.can_work && <button type="button" className="btn btn-sm btn-primary" style={{ alignSelf: 'flex-start' }} onClick={handover}>Start delivery (handover)</button>}
          {s.renewal ? <Link to={`/accounts/${opportunity.account_id}?deal=${s.renewal.id}`} className="small">Next cycle: {s.renewal.name} ({s.renewal.status.toLowerCase()})</Link>
            : s.can_work && <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => api.sales.post(`/opportunities/${opportunity.id}/renewal`, {}).then(() => { toast.success(csr ? 'Next funding cycle opened as a new deal' : 'Renewal opened as a new deal'); changed(); }).catch(toast.error)}>
              Open {csr ? 'the next funding cycle' : 'a renewal'}
            </button>}
        </div>
      )}
      {dialog === 'call' && <LogCallDialog target={target} phone={phone} users={meta?.users} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog === 'followup' && <FollowUpDialog target={target} users={meta?.users} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog === 'whatsapp' && <Modal title="WhatsApp" onClose={() => setDialog(null)}><WhatsAppPanel target={target} phone={phone} /></Modal>}
      {dialog === 'newquote' && <QuoteEditor deal={deal} csr={csr} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog?.quote && <QuoteView deal={deal} quoteId={dialog.quote} csr={csr} canWork={s.can_work} onClose={() => setDialog(null)} onChanged={changed} />}
      {dialog === 'review' && <ReviewHandover engagement={s.engagement} onClose={() => setDialog(null)} onDone={changed} />}
    </div>
  );
}

function ReviewHandover({ engagement, onClose, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const decide = (decision) => api.sales.post(`/handovers/${engagement.id}/review`, { decision, note: note || null }).then(() => { toast.success(decision === 'ACCEPTED' ? 'Handover accepted' : 'Returned with your note'); onDone(); onClose(); }).catch(toast.error);
  return (
    <Modal title="Review the handover" onClose={onClose} footer={<><button type="button" className="btn" onClick={() => decide('RETURNED')} disabled={!note.trim()}>Return</button><button type="button" className="btn btn-primary" onClick={() => decide('ACCEPTED')}>Accept</button></>}>
      <div className="stack">
        <div className="small">{engagement.name}: agreed scope {engagement.agreed_scope ? 'recorded' : 'missing'}, deliverables {engagement.deliverables ? 'recorded' : 'missing'}, {engagement.milestone_total} milestone(s).</div>
        <Field label="Note (needed to return it)"><textarea className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
