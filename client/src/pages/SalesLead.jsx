import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import {
  CallButtons, CallStatusBadge, CategoryBadge, DestinationBadge, FollowUpActions, FollowUpDialog, LeadFieldInputs, LeadStatusBadge, LogCallDialog,
  Stars, WhatsAppPanel,
} from '../components/sales/parts.jsx';
import { CallStatusForm } from '../components/sales/Calling.jsx';
import {
  CATEGORY, CHOOSABLE, FOLLOWUP_KIND, LEAD_STATUS, PRIORITY, ROUTING_STATUS, dayOf, editableFields, fieldValueLabel, handedOut, money, phoneLabel, useSalesMeta, when,
} from '../lib/sales.js';

const EDITABLE = [
  ['organization_name', 'Organization'], ['contact_name', 'Contact person'], ['designation', 'Designation'], ['email', 'Email'],
  ['phone', 'Phone'], ['website', 'Website'], ['city', 'City'], ['state', 'State'], ['requirement', 'Requirement'],
];

function EditLead({ lead, meta, onClose, onSaved }) {
  const toast = useToast();
  const fields = editableFields(meta);
  const [custom, setCustom] = useState(() => ({ ...(lead.custom_fields || {}) }));
  const [form, setForm] = useState(() => Object.fromEntries([...EDITABLE.map(([k]) => [k, lead[k] || '']), ['priority', lead.priority],
    ['budget_amount', lead.budget_amount ?? ''], ['fit', lead.fit || ''], ['need_clarity', lead.need_clarity || ''], ['timeline', lead.timeline || ''],
    ['budget_confirmed', lead.budget_confirmed ?? ''], ['decision_maker_engaged', lead.decision_maker_engaged ?? '']]));
  const save = async () => {
    const body = {};
    for (const [k, v] of Object.entries(form)) {
      const before = lead[k] ?? '';
      if (String(v) === String(before)) continue;
      body[k] = v === '' ? null : ['budget_confirmed', 'decision_maker_engaged'].includes(k) ? v === 'true' : k === 'budget_amount' ? Number(v) : v;
    }
    const changedFields = Object.fromEntries(fields.map((f) => f.key).filter((k) => JSON.stringify(custom[k] ?? null) !== JSON.stringify(lead.custom_fields?.[k] ?? null))
      .map((k) => [k, custom[k] === '' || (Array.isArray(custom[k]) && !custom[k].length) ? null : custom[k]]));
    if (Object.keys(changedFields).length) body.custom_fields = changedFields;
    if (!Object.keys(body).length) return onClose();
    try { await api.sales.patch(`/leads/${lead.id}`, body); toast.success('Saved'); onSaved(); onClose(); } catch (err) { toast.error(err); }
    return undefined;
  };
  const yesNo = (k, label) => (
    <Field label={label}><select className="select" value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
      <option value="">Not known</option><option value="true">Yes</option><option value="false">No</option></select></Field>
  );
  return (
    <Modal title={`Edit ${lead.ref}`} size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="stack">
        <div className="grid-2">{EDITABLE.map(([k, label]) => <Field key={k} label={label}><input className="input" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>)}</div>
        {fields.length > 0 && <><h3 className="small">Their answers</h3><LeadFieldInputs fields={fields} values={custom} onChange={setCustom} /></>}
        <h3 className="small">Qualification (feeds the score)</h3>
        <div className="grid-2">
          <Field label="Fit"><select className="select" value={form.fit} onChange={(e) => setForm({ ...form, fit: e.target.value })}><option value="">Not known</option><option value="STRONG">Strong</option><option value="PARTIAL">Partial</option><option value="WEAK">Weak</option></select></Field>
          <Field label="How clear is the need?"><select className="select" value={form.need_clarity} onChange={(e) => setForm({ ...form, need_clarity: e.target.value })}><option value="">Not known</option><option value="CLEAR">Clear</option><option value="PARTIAL">Partly clear</option><option value="VAGUE">Vague</option></select></Field>
          <Field label="Timeline"><select className="select" value={form.timeline} onChange={(e) => setForm({ ...form, timeline: e.target.value })}><option value="">Not known</option><option value="IMMEDIATE">Now</option><option value="QUARTER">This quarter</option><option value="HALF_YEAR">Within six months</option><option value="YEAR">Within a year</option><option value="UNKNOWN">They do not know</option></select></Field>
          <Field label="Budget"><input className="input" type="number" min="0" value={form.budget_amount} onChange={(e) => setForm({ ...form, budget_amount: e.target.value })} /></Field>
          {yesNo('budget_confirmed', 'Budget confirmed?')}
          {yesNo('decision_maker_engaged', 'Decision maker engaged?')}
          <Field label="Priority"><select className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
      </div>
    </Modal>
  );
}

function ConvertDialog({ lead, onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const csr = lead.category === 'CSR_NGO';
  const [form, setForm] = useState({
    account_mode: lead.account_id ? 'existing' : 'new', name: `${lead.organization_name || lead.contact_name} — ${csr ? 'CSR' : 'enquiry'}`,
    estimated_value: lead.budget_amount ?? '', next_step: csr ? 'Fit assessment call' : 'Discovery call', next_step_due: '', decision_maker: false,
  });
  const go = async () => {
    try {
      const r = await api.sales.post(`/leads/${lead.id}/convert`, {
        account: form.account_mode === 'existing' && lead.account_id ? { id: lead.account_id } : { mode: 'new' },
        contact: form.decision_maker ? { decision_roles: ['DECISION_MAKER'] } : undefined,
        opportunity: {
          name: form.name, ...(form.estimated_value !== '' ? (csr ? { requested_amount: Number(form.estimated_value) } : { estimated_value: Number(form.estimated_value) }) : {}),
          ...(form.next_step && form.next_step_due ? { next_step: form.next_step, next_step_due: form.next_step_due } : {}),
        },
      });
      toast.success(r.already ? 'Already converted' : 'Converted: the organization, contact and deal are linked to this lead');
      navigate(`/accounts/${r.accountId}?deal=${r.opportunityId}`);
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Convert to a deal" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={go}>Convert</button></>}>
      <div className="stack">
        <div className="small muted">The lead keeps its record, source and history, and points at what it becomes. Its follow-ups, calls and messages move with it.</div>
        {lead.account_id ? (
          <Field label="Organization">
            <select className="select" value={form.account_mode} onChange={(e) => setForm({ ...form, account_mode: e.target.value })}>
              <option value="existing">Use {lead.account_name} (already linked)</option><option value="new">Create a new organization</option>
            </select>
          </Field>
        ) : <div className="small">A new organization is created: <strong>{lead.organization_name || lead.contact_name}</strong> ({CATEGORY[lead.category].label}).</div>}
        <Field label="Deal name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={csr ? 'Funding requested (if known)' : 'Estimated value (if known)'}><input className="input" type="number" min="0" value={form.estimated_value} onChange={(e) => setForm({ ...form, estimated_value: e.target.value })} /></Field>
        <div className="grid-2">
          <Field label="Next action"><input className="input" value={form.next_step} onChange={(e) => setForm({ ...form, next_step: e.target.value })} /></Field>
          <Field label="By"><input className="input" type="date" value={form.next_step_due} onChange={(e) => setForm({ ...form, next_step_due: e.target.value })} /></Field>
        </div>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={form.decision_maker} onChange={(e) => setForm({ ...form, decision_maker: e.target.checked })} /> {lead.contact_name || 'The contact'} is the decision maker</label>
      </div>
    </Modal>
  );
}

function MergeDialog({ lead, other, onClose, onDone }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [survivor, setSurvivor] = useState(lead.id);
  const merged = survivor === lead.id ? other.id : lead.id;
  useEffect(() => { api.sales.get('/merge/preview', { entity: 'LEAD', survivor, merged }).then(setPreview).catch((err) => setPreview({ error: err.message })); }, [survivor, merged]);
  const go = async () => {
    try { await api.sales.post('/merge', { entity: 'LEAD', survivor_id: survivor, merged_id: merged, reason: 'Duplicate enquiry' }); toast.success('Merged; the other record is archived and points here'); onDone(survivor); } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Merge duplicate leads" size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!preview || preview.error} onClick={go}>Merge</button></>}>
      {!preview ? <Spinner /> : preview.error ? <div className="critical-text small">{preview.error}</div> : (
        <div className="stack">
          <div className="row" style={{ gap: 6 }}>
            <span className="small">Keep:</span>
            {[lead, other].map((x) => <button key={x.id} type="button" className={`kind-chip${survivor === x.id ? ' is-active' : ''}`} onClick={() => setSurvivor(x.id)}>{x.ref}</button>)}
          </div>
          <div className="small muted">Why they look the same: {preview.reasons.join(', ') || 'chosen by you'}. Blank fields are filled from the other record; nothing good is overwritten with a blank. Activities, follow-ups, calls and messages all move to the one you keep.</div>
          {preview.warnings.map((w) => <div key={w} className="mkt-callout is-warning small">{w}</div>)}
          <div className="table-scroll"><table className="data-table"><thead><tr><th>Field</th><th>Kept</th><th>Other</th><th /></tr></thead>
            <tbody>{preview.comparison.filter((c) => c.survivor !== null || c.merged !== null).map((c) => (
              <tr key={c.field}><td>{c.field.replace(/_/g, ' ')}</td><td>{String(c.survivor ?? '—')}</td><td>{String(c.merged ?? '—')}</td><td className="small">{c.fills_blank ? 'fills a blank' : c.differs ? 'differs: kept stays' : ''}</td></tr>
            ))}</tbody></table></div>
          <div className="small">Moves: {Object.entries(preview.moves || {}).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing else'}</div>
        </div>
      )}
    </Modal>
  );
}

export default function SalesLead() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const { meta } = useSalesMeta();
  const [data, setData] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [tab, setTab] = useState('timeline');
  const load = useCallback(() => api.sales.get(`/leads/${id}`).then(setData).catch((err) => setData({ error: err })), [id]);
  useEffect(() => { load(); }, [load]);

  if (!data || !meta) return <Spinner label="Opening the lead" />;
  if (data.error) return <EmptyState title={data.error.status === 404 ? 'Lead not found' : 'Could not open the lead'}>{data.error.status === 404 ? 'It does not exist, or it is outside your book.' : data.error.message}</EmptyState>;
  const { lead } = data;
  const inTaskflow = lead.destination === 'TASKFLOW';
  const target = { lead_id: lead.id };
  const update = async (body, message) => { try { await api.sales.patch(`/leads/${lead.id}`, body); toast.success(message); load(); } catch (err) { toast.error(err); } };
  const setStatus = (status) => {
    const reason = ['DISQUALIFIED', 'NURTURE'].includes(status) ? window.prompt(status === 'DISQUALIFIED' ? 'Why is it disqualified?' : 'Why nurture, and when to come back?') : null;
    if (['DISQUALIFIED', 'NURTURE'].includes(status) && !reason) return;
    update({ status, disqualify_reason: reason, reason }, `Marked ${LEAD_STATUS[status].label.toLowerCase()}`);
  };
  const route = async (category) => {
    const reason = window.prompt(`Classify as ${CATEGORY[category].label}. Why?`) || '';
    try { await api.sales.post(`/routing/leads/${lead.id}/route`, { category, reason }); toast.success(handedOut(meta, category) ? 'Queued for TeleCRM' : 'Now worked in TaskFlow'); load(); } catch (err) { toast.error(err); }
  };
  // the owner says who an unknown lead is, from what they heard on the call
  const settle = (category) => update({ category, reason: 'Said on the call' }, `Now ${CATEGORY[category].label}`);
  const canCall = inTaskflow && lead.status !== 'CONVERTED' && !lead.is_archived && !lead.merged_into_id && (data.can.edit || !lead.owner_user_id);
  const nextOpen = data.followups.filter((f) => !f.completed_at && !f.crm_cancel_reason);
  const score = data.score;

  return (
    <div className="stack">
      <div className="row-between wrap">
        <div className="stack-xs">
          <div className="small"><Link to="/sales?tab=leads" className="btn-link">Leads</Link> / {lead.ref}</div>
          <h1 className="row wrap" style={{ gap: 8 }}>{lead.display_name}</h1>
          <div className="row wrap" style={{ gap: 6 }}>
            <CategoryBadge category={lead.category} /><CallStatusBadge lead={lead} /><LeadStatusBadge status={lead.status} />
            {!inTaskflow && <DestinationBadge destination={lead.destination} />}<Stars value={lead.rating} />
            <Badge>{PRIORITY[lead.priority]}</Badge>
            {lead.is_archived && <Badge tone="critical">Archived{lead.archive_reason ? `: ${lead.archive_reason}` : ''}</Badge>}
            {lead.merged_into_id && <Link to={`/sales/leads/${lead.merged_into_id}`}><Badge tone="warning">Merged into another lead</Badge></Link>}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {data.can.edit && <button type="button" className="btn btn-sm" onClick={() => setDialog('edit')}>Edit</button>}
          {data.can.edit && inTaskflow && lead.status !== 'CONVERTED' && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog('convert')}>Convert to deal</button>}
          {lead.converted_opportunity_id && <Link className="btn btn-sm" to={`/accounts/${lead.converted_account_id}?deal=${lead.converted_opportunity_id}`}>Open the deal</Link>}
          {data.can.edit && (lead.is_archived
            ? <button type="button" className="btn btn-sm" onClick={() => api.sales.post(`/leads/${lead.id}/restore`).then(load).catch(toast.error)}>Restore</button>
            : <button type="button" className="btn btn-sm btn-ghost" onClick={() => { const r = window.prompt('Why archive it? (it stays, with its history)'); if (r) api.sales.post(`/leads/${lead.id}/archive`, { reason: r }).then(load).catch(toast.error); }}>Archive</button>)}
        </div>
      </div>

      {!inTaskflow && (
        <div className={`mkt-callout ${lead.destination === 'TRIAGE' ? 'is-warning' : ''} small stack-sm`}>
          <div><strong>{lead.destination === 'TELECRM' ? `${CATEGORY[lead.category].label}: handled in TeleCRM.` : 'Waiting for classification.'}</strong> {ROUTING_STATUS[lead.routing_status] || ''}. It is not in Taskflow’s pipeline, assignment or sales totals.</div>
          {data.can.route && (
            <div className="row wrap" style={{ gap: 4 }}>
              <span>Classify as:</span>
              {CHOOSABLE.filter((c) => c !== lead.category).map((c) => <button key={c} type="button" className="btn btn-sm" onClick={() => route(c)}>{CATEGORY[c].label}</button>)}
            </div>
          )}
        </div>
      )}
      {inTaskflow && lead.category === 'UNCLASSIFIED' && (
        <div className="mkt-callout is-warning small stack-sm">
          <div><strong>Who is it?</strong> Not known yet. Ask on the call; until then it is not in the pipeline, scoring or the sales totals.</div>
          {(data.can.edit || data.can.route) && (
            <div className="row wrap" style={{ gap: 4 }}>
              {CHOOSABLE.map((c) => <button key={c} type="button" className="btn btn-sm" onClick={() => settle(c)}>{CATEGORY[c].label}</button>)}
            </div>
          )}
        </div>
      )}

      <div className="grid-3 sales-facts">
        <div className="card card-pad stack-xs">
          <span className="stat-label">Owner</span>
          <strong>{lead.owner_name || 'Nobody yet'}</strong>
          {data.can.assign && inTaskflow && (
            <select className="select" aria-label="Reassign" value="" onChange={(e) => {
              const v = e.target.value; if (!v) return;
              const reason = window.prompt('Why is it changing hands?');
              if (reason === null) return;
              api.sales.post(`/leads/${lead.id}/assign`, v === 'auto' ? {} : { user_id: Number(v), reason }).then(() => { toast.success('Assigned'); load(); }).catch(toast.error);
            }}>
              <option value="">Reassign…</option><option value="auto">By the assignment rules</option>
              {meta.users.filter((u) => u.is_active && u.id !== lead.owner_user_id).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          )}
        </div>
        <div className="card card-pad stack-xs">
          <span className="stat-label">Next follow-up</span>
          {nextOpen.length ? <strong className={new Date(nextOpen[0].due_date) < new Date() ? 'critical-text' : ''}>{FOLLOWUP_KIND[nextOpen[0].followup_kind]} · {when(nextOpen[0].due_date)}</strong>
            : <strong className="warning-text">None scheduled</strong>}
          <span className="small muted">Last activity {lead.last_activity_at ? when(lead.last_activity_at) : 'none yet'}{lead.is_stale ? ' · gone quiet' : ''}</span>
        </div>
        <div className="card card-pad stack-xs">
          <span className="stat-label">Score</span>
          <strong className="tnum">{lead.effective_score ?? '—'}{lead.score_override !== null && lead.score_override !== undefined ? ' (set by hand)' : ''}</strong>
          <span className="small muted">
            {data.score.missing?.length ? `${data.score.missing.length} of ${data.score.breakdown.length} inputs not known yet · ` : ''}How well it fits; not the chance of winning.
          </span>
        </div>
      </div>

      {canCall && (
        <section className="card">
          <div className="card-head">
            <h3>How did the call go?</h3>
            <span className="small muted">
              {lead.call_attempts ? `${lead.call_attempts} call${lead.call_attempts === 1 ? '' : 's'}` : 'Not called yet'}
              {lead.last_called_at ? ` · last ${when(lead.last_called_at)}` : ''}{lead.retry_at ? ` · tries again ${when(lead.retry_at)}` : ''}
            </span>
          </div>
          <div className="card-pad stack-sm">
            {lead.phone && <a className="btn btn-sm call-dial-inline" href={`tel:${lead.phone.replace(/[^\d+]/g, '')}`}><Icon name="phone" size={13} /> Call {phoneLabel(lead.phone)}</a>}
            <CallStatusForm lead={lead} meta={meta} onDone={load} />
          </div>
        </section>
      )}

      {inTaskflow && (
        <div className="row wrap" style={{ gap: 6 }}>
          <CallButtons phone={lead.phone} target={target} onLog={() => setDialog('call')} />
          <button type="button" className="btn btn-sm" onClick={() => setDialog('followup')}><Icon name="calendar" size={13} /> Follow-up</button>
          <button type="button" className="btn btn-sm" onClick={() => setDialog('note')}><Icon name="note" size={13} /> Note</button>
          {data.can.edit && lead.status !== 'CONVERTED' && (
            <select className="select" style={{ width: 'auto' }} aria-label="Status" value="" onChange={(e) => e.target.value && setStatus(e.target.value)}>
              <option value="">Set stage…</option>{['CONTACTED', 'QUALIFYING', 'QUALIFIED', 'NURTURE', 'WON', 'DISQUALIFIED'].filter((s) => s !== lead.status).map((s) => <option key={s} value={s}>{LEAD_STATUS[s].label}</option>)}
            </select>
          )}
        </div>
      )}

      <div className="tabs tabs-scroll" role="tablist">
        {[['timeline', 'Timeline'], ['followups', `Follow-ups (${data.followups.length})`], ['whatsapp', 'WhatsApp'], ['details', 'Details'], ['score', 'Score'], ['routing', 'Routing & owners'],
          ...(data.duplicates.leads.length || data.duplicates.accounts.length ? [['duplicates', `Possible duplicates (${data.duplicates.leads.length + data.duplicates.accounts.length})`]] : [])].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'timeline' && (
        <div className="card card-pad stack-sm">
          {data.timeline.length === 0 ? <div className="empty small">Nothing yet.</div> : data.timeline.map((a) => (
            <div key={a.id} className="sales-timeline-item">
              <Badge tone={a.direction === 'INBOUND' ? 'good' : a.direction === 'OUTBOUND' ? 'brand' : 'neutral'}>{String(a.type).toLowerCase().replace(/_/g, ' ')}</Badge>
              <div className="grow">
                <div className="small" style={{ fontWeight: 600 }}>{a.subject}</div>
                {a.body && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>}
                <div className="small muted">{when(a.occurred_at)}{a.actor_name ? ` · ${a.actor_name}` : ''}{a.meta?.provider && !a.meta.logged_manually ? ` · from ${a.meta.provider}` : ''}</div>
              </div>
            </div>
          ))}
          {data.calls.length > 0 && <div className="small muted">Calls: {data.calls.length} ({data.calls.filter((c) => c.has_recording).length} with a recording{data.calls.some((c) => c.can_play) ? '' : ' you cannot open'}).</div>}
        </div>
      )}
      {tab === 'followups' && (
        <div className="card card-pad stack-sm">
          {data.followups.length === 0 ? <div className="empty small">No follow-ups.</div> : data.followups.map((f) => (
            <div key={f.id} className="sales-row">
              <Badge tone={f.completed_at ? 'good' : f.crm_cancel_reason ? 'neutral' : new Date(f.due_date) < new Date() ? 'critical' : 'brand'}>{f.completed_at ? 'done' : f.crm_cancel_reason ? 'cancelled' : FOLLOWUP_KIND[f.followup_kind]}</Badge>
              <span className="grow truncate">{f.title}</span>
              <span className="small muted">{f.completed_at ? `${String(f.followup_outcome || '').toLowerCase().replace(/_/g, ' ')} ${when(f.completed_at)}` : f.crm_cancel_reason || when(f.due_date)}</span>
              {!f.completed_at && !f.crm_cancel_reason && <button type="button" className="btn btn-sm" onClick={() => setDialog({ task: f })}>Done / move</button>}
            </div>
          ))}
        </div>
      )}
      {tab === 'whatsapp' && <div className="card card-pad"><WhatsAppPanel target={target} phone={lead.phone} /></div>}
      {tab === 'details' && (
        <div className="card card-pad">
          <dl className="sales-dl">
            {[['Contact', lead.contact_name], ['Designation', lead.designation], ['Phone', lead.phone], ['Email', lead.email], ['Website', lead.website],
              ['Place', [lead.city, lead.state, lead.country].filter(Boolean).join(', ')], ['Requirement', lead.requirement], ['Enquiry', lead.enquiry],
              ['Budget', lead.budget_amount ? money(lead.budget_amount, lead.currency) : null], ['Original source', lead.original_source_name], ['Latest source', lead.source_name],
              ['Campaign', lead.original_campaign_name || lead.campaign_name], ['UTM', Object.entries(lead.utm || {}).map(([k, v]) => `${k}=${v}`).join(' · ')],
              ['Came in by', `${String(lead.entry_channel).toLowerCase().replace('_', ' ')}${lead.source_system ? ` (${lead.source_system})` : ''}`],
              ['External id', lead.external_id], ['Captured', when(lead.captured_at)], ['Organization', lead.account_name],
              ['Consent', lead.consent?.given ? `given ${dayOf(lead.consent.at)}${lead.consent.channel ? ` via ${lead.consent.channel.toLowerCase()}` : ''}` : null],
              ['Lost because', lead.status === 'DISQUALIFIED' ? lead.disqualify_reason : null], ['Tags', (lead.tags || []).join(', ')],
              ...(meta.lead_fields || []).map((f) => [f.label, fieldValueLabel(f, lead.custom_fields?.[f.key]), f]),
            ].filter(([, v]) => v).map(([k, v, f]) => (
              <div key={k} className="sales-dl-row"><dt>{k}</dt><dd>{k === 'Organization' ? <Link to={`/accounts/${lead.account_id}`}>{v}</Link>
                : f?.type === 'URL' ? <a href={v} target="_blank" rel="noreferrer noopener">{f.key === 'telecrm_link' ? 'Open in TeleCRM' : v}</a> : v}</dd></div>
            ))}
          </dl>
        </div>
      )}
      {tab === 'score' && (
        <div className="card card-pad stack-sm">
          {score.score === null ? <div className="small muted">Scoring is not used for this category.</div> : (
            <>
              <div className="small muted">Each part says what it looked at. Missing information scores nothing and is listed, so a low score can mean “we do not know yet”.</div>
              <div className="table-scroll"><table className="data-table"><thead><tr><th>Criterion</th><th className="num">Points</th><th>Why</th></tr></thead>
                <tbody>{score.breakdown.map((b) => <tr key={b.key}><td>{b.label}</td><td className="num tnum">{b.points} / {b.weight}</td><td className="small">{b.missing ? <span className="warning-text">Not known yet</span> : b.note}</td></tr>)}</tbody></table></div>
              {score.missing.length > 0 && <div className="small">Missing: {score.missing.join(', ')}. Fill them in under Edit.</div>}
              {data.can.assign && (
                <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => {
                  const v = window.prompt('Set the score by hand (0–100), or leave blank to go back to the calculated score');
                  if (v === null) return;
                  const reason = v === '' ? 'Back to the calculated score' : window.prompt('Why?');
                  if (v !== '' && !reason) return;
                  update({ score_override: v === '' ? null : Number(v), score_override_reason: reason }, 'Score updated');
                }}>Override score…</button>
              )}
            </>
          )}
        </div>
      )}
      {tab === 'routing' && (
        <div className="card card-pad stack-sm">
          <h3 className="small">Category and routing decisions</h3>
          {data.routing.events.map((e) => <div key={e.id} className="small">{when(e.created_at)} · {e.from_category ? `${CATEGORY[e.from_category]?.short} → ` : ''}{CATEGORY[e.to_category]?.short} ({e.to_destination?.toLowerCase()}) {e.reason ? `· ${e.reason}` : ''} {e.actor_name ? `· ${e.actor_name}` : '· automatic'}</div>)}
          <h3 className="small">Ownership</h3>
          {data.routing.assignments.length === 0 ? <div className="small muted">Never assigned.</div> : data.routing.assignments.map((a) => (
            <div key={a.id} className="small">{when(a.created_at)} · {a.from_name ? `${a.from_name} → ` : ''}{a.to_name || 'nobody'} · {String(a.method).toLowerCase()}{a.rule_name ? ` by rule “${a.rule_name}”` : ''}{a.reason ? ` · ${a.reason}` : ''}{a.actor_name ? ` · ${a.actor_name}` : ''}</div>
          ))}
          {data.routing.handoff && <div className="small">TeleCRM hand-off: {data.routing.handoff.status.toLowerCase()}{data.routing.handoff.external_id ? ` (${data.routing.handoff.external_id})` : ''}</div>}
        </div>
      )}
      {tab === 'duplicates' && (
        <div className="card card-pad stack-sm">
          <div className="small muted">Shared company domains and repeat enquiries are normal; merge only the same enquiry entered twice.</div>
          {data.duplicates.leads.map((d) => (
            <div key={d.id} className="sales-row small">
              <Link to={`/sales/leads/${d.id}`} className="grow">{d.ref} {d.organization_name || d.contact_name}</Link>
              <span className="muted">{d.reasons.join(', ')}</span>
              {can('crm.merge') && <button type="button" className="btn btn-sm" onClick={() => setDialog({ merge: d })}>Compare & merge</button>}
            </div>
          ))}
          {data.duplicates.accounts.map((a) => <div key={a.id} className="small">Organization <Link to={`/accounts/${a.id}`}>{a.name}</Link> · {a.reasons.join(', ')}</div>)}
        </div>
      )}

      {dialog === 'edit' && <EditLead lead={lead} meta={meta} onClose={() => setDialog(null)} onSaved={load} />}
      {dialog === 'convert' && <ConvertDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === 'call' && <LogCallDialog target={target} phone={lead.phone} users={meta.users} onClose={() => setDialog(null)} onSaved={load} />}
      {dialog === 'followup' && <FollowUpDialog target={target} users={meta.users} onClose={() => setDialog(null)} onSaved={load} />}
      {dialog === 'note' && <NoteDialog leadId={lead.id} onClose={() => setDialog(null)} onSaved={load} />}
      {dialog?.task && <FollowUpActions task={dialog.task} users={meta.users} onClose={() => setDialog(null)} onDone={load} />}
      {dialog?.merge && <MergeDialog lead={lead} other={dialog.merge} onClose={() => setDialog(null)} onDone={(sid) => { setDialog(null); navigate(`/sales/leads/${sid}`); load(); }} />}
    </div>
  );
}

function NoteDialog({ leadId, onClose, onSaved }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const save = async () => {
    try { await api.sales.post(`/leads/${leadId}/activities`, { type: 'NOTE', subject: body.split('\n')[0].slice(0, 120), body }); toast.success('Note added'); onSaved(); onClose(); } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Add a note" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!body.trim()} onClick={save}>Add</button></>}>
      <textarea className="textarea" rows={4} autoFocus value={body} onChange={(e) => setBody(e.target.value)} placeholder="Met at the Krishi expo; wants pricing for 50 kits" />
    </Modal>
  );
}
