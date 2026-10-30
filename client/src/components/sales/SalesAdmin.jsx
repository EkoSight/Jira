import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadFile } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from '../ui.jsx';
import { CopyButton } from '../marketing/parts.jsx';
import { CATEGORY, ELIGIBLE, EXCLUDED, dayOf, localDay, money, when } from '../../lib/sales.js';

const SECTIONS = [
  ['setup', 'Setup checklist'], ['general', 'Visibility, routing & calendar'], ['pipelines', 'Pipelines & stages'], ['assignment', 'Assignment'],
  ['scoring', 'Scoring'], ['sources', 'Sources & campaigns'], ['capture', 'Website forms & API keys'], ['catalogue', 'Catalogue, approvals & rates'],
  ['integrations', 'Calls, WhatsApp & TeleCRM'], ['automation', 'Automation'], ['remediation', 'Existing records to classify'], ['targets', 'Targets'], ['audit', 'Audit log'],
];

const save = (toast, p, msg = 'Saved') => p.then((r) => { toast.success(msg); return r; }).catch((err) => { toast.error(err); throw err; });

// ---------------------------------------------------------------- setup checklist

function Setup({ meta, goTo }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    Promise.all([
      api.sales.get('/assignment/rules').catch(() => ({ rules: [] })), api.sales.get('/products', { all: '1' }).catch(() => ({ products: [] })),
      api.sales.get('/approval-rules').catch(() => ({ rules: [] })), api.sales.get('/capture/forms').catch(() => ({ forms: [] })),
      api.sales.get('/integrations').catch(() => null), api.sales.get('/automation/rules').catch(() => ({ rules: [] })),
      api.sales.get('/routing/remediation').catch(() => ({ organizations: [] })),
    ]).then(([rules, products, approvals, forms, integrations, automation, remediation]) => setState({ rules, products, approvals, forms, integrations, automation, remediation }));
  }, []);
  if (!state) return <Spinner />;
  const s = meta.settings;
  const items = [
    ['general', 'Decide who sees what', s.visibility?.enforced ? `Sales agents see ${s.visibility?.agents === 'ALL' ? 'everything' : s.visibility?.agents === 'TEAM' ? 'their department’s records' : 'their own and shared records'}; managers see their departments.` : 'Record-level access is off: everyone with CRM access sees every record, as before. Recommended: agents see their own and shared records.', s.visibility?.enforced === true],
    ['general', 'Confirm the calendar', s.calendar?.confirmed ? `${s.calendar.timezone}, ${s.calendar.currency}, working ${s.calendar.workStart}–${s.calendar.workEnd}` : 'Time zone, currency, financial year and working hours are proposed defaults until you confirm them.', Boolean(s.calendar?.confirmed)],
    ['remediation', 'Classify existing organizations', state.remediation.organizations.length ? `${state.remediation.organizations.length} existing organization(s) have no confirmed category yet (${state.remediation.organizations.filter((o) => o.flagged).length} look like retailers or FPOs).` : 'Every organization has a confirmed category.', state.remediation.organizations.length === 0],
    ['pipelines', 'Review the two pipelines', 'Stage names, probabilities, required fields and approval gates.', true],
    ['assignment', 'Decide who gets new leads', state.rules.rules.length ? `${state.rules.rules.filter((r) => r.is_enabled).length} rule(s) on` : s.assignment?.fallbackUserId ? 'No rules; everything goes to the fallback owner' : 'No rules and no fallback: new leads stay unassigned and the assigners are told.', state.rules.rules.length > 0 || Boolean(s.assignment?.fallbackUserId)],
    ['catalogue', 'Add products and services', `${state.products.products.length} in the catalogue`, state.products.products.length > 0],
    ['catalogue', 'Set approval rules', state.approvals.rules.length ? `${state.approvals.rules.length} rule(s)` : 'No rules: every quotation is approved on submit.', state.approvals.rules.length > 0],
    ['general', 'Fill in the quotation letterhead', s.quotes?.legalName ? s.quotes.legalName : 'Legal name, address and tax registration for the PDF.', Boolean(s.quotes?.legalName)],
    ['capture', 'Connect the website form', state.forms.forms.length ? `${state.forms.forms.length} form(s)` : 'No hosted form or API key yet.', state.forms.forms.length > 0],
    ['integrations', 'Connect calling and WhatsApp', state.integrations ? `WhatsApp: ${state.integrations.whatsapp.state}. Calling: ${state.integrations.calling.exotel.state}.` : 'Not checked', Boolean(state.integrations?.whatsapp.configured)],
    ['automation', 'Review automation', `${state.automation.rules.filter((r) => r.is_enabled).length} rule(s) on; live sends ${state.automation.live_sends ? 'on' : 'off'}.`, true],
  ];
  return (
    <div className="stack-sm">
      <div className="small muted">Work down the list; each line opens its section. Nothing here changes data until you save it there.</div>
      {items.map(([section, title, note, done], i) => (
        <button key={i} type="button" className="link-row" onClick={() => goTo(section)}>
          <Badge tone={done ? 'good' : 'warning'}>{done ? 'done' : 'to do'}</Badge>
          <div className="grow stack-xs" style={{ textAlign: 'left' }}><strong className="small">{title}</strong><span className="small muted">{note}</span></div>
          <Icon name="chevron" size={14} />
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- general settings

function General({ meta, onSaved }) {
  const toast = useToast();
  const s = meta.settings;
  const [f, setF] = useState(() => ({
    visibility: s.visibility?.agents || 'OWN', enforced: s.visibility?.enforced === true, legacy: s.routing?.legacyUnclassified || 'INCLUDE', excluded: s.routing?.excludedDestination || 'TELECRM',
    ...s.calendar, workingDays: s.calendar?.workingDays || [1, 2, 3, 4, 5, 6], ...Object.fromEntries(Object.entries(s.followUps || {}).map(([k, v]) => [`fu_${k}`, v])),
    ...Object.fromEntries(Object.entries(s.quotes || {}).map(([k, v]) => [`q_${k}`, v ?? ''])),
  }));
  const submit = () => save(toast, api.sales.put('/settings', {
    visibility: { agents: f.visibility, enforced: f.enforced }, routing: { legacyUnclassified: f.legacy, excludedDestination: f.excluded },
    calendar: { timezone: f.timezone, currency: f.currency, fyStartMonth: Number(f.fyStartMonth), workingDays: f.workingDays, workStart: f.workStart, workEnd: f.workEnd, useAttendanceHolidays: f.useAttendanceHolidays !== false, confirmed: true },
    followUps: { firstResponseHours: Number(f.fu_firstResponseHours), overdueEscalateHours: Number(f.fu_overdueEscalateHours), staleLeadDays: Number(f.fu_staleLeadDays), staleOpportunityDays: Number(f.fu_staleOpportunityDays) },
    quotes: { validityDays: Number(f.q_validityDays), terms: f.q_terms, legalName: f.q_legalName, address: f.q_address, email: f.q_email, phone: f.q_phone, website: f.q_website, taxId: f.q_taxId, taxIdLabel: f.q_taxIdLabel || 'GSTIN' },
  })).then(onSaved);
  const day = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h3>Who sees what</h3>
        {!s.visibility?.enforced && <div className="mkt-callout is-warning small">Record-level access is off: everyone with CRM access sees every organization, deal and lead, as before the sales CRM. Choose what sales agents see, switch it on and save. Tell the team first — agents and managers will then see fewer records.</div>}
        <Field label="Record-level access" hint="Off keeps what everyone saw before. On applies the choice below, and managers see their own and granted departments; administrators always see everything.">
          <select className="select" value={f.enforced ? 'on' : 'off'} onChange={(e) => setF({ ...f, enforced: e.target.value === 'on' })}>
            <option value="off">Off — everyone with CRM access sees every record</option><option value="on">On — limit what agents and managers see</option>
          </select>
        </Field>
        <Field label="Sales agents see" hint="Applies once record-level access is on. Narrowing this hides other people’s records from agents on every screen, list, report and export.">
          <select className="select" value={f.visibility} disabled={!f.enforced} onChange={(e) => setF({ ...f, visibility: e.target.value })}>
            <option value="OWN">Their own leads and deals, and ones shared with them</option><option value="TEAM">Everything in their department</option><option value="ALL">Everything</option>
          </select>
        </Field>
        <h3>The TeleCRM boundary</h3>
        <Field label="Retailer, FPO and individual leads go to">
          <select className="select" value={f.excluded} onChange={(e) => setF({ ...f, excluded: e.target.value })}><option value="TELECRM">The TeleCRM hand-off queue</option><option value="TRIAGE">The classification queue, for a person to check first</option></select>
        </Field>
        <Field label="Existing organizations with no confirmed category" hint="They are never reclassified automatically. Until someone confirms each, choose whether they count in pipelines and reports.">
          <select className="select" value={f.legacy} onChange={(e) => setF({ ...f, legacy: e.target.value })}><option value="INCLUDE">Keep them in, as they were</option><option value="EXCLUDE">Leave them out until confirmed</option></select>
        </Field>
      </div>
      <div className="card card-pad stack">
        <h3>Calendar and money</h3>
        {!s.calendar?.confirmed && <div className="mkt-callout is-warning small">These are proposed defaults (India time, rupees, April–March, Monday–Saturday 9:30–18:30). Saving confirms them.</div>}
        <div className="grid-2">
          <Field label="Time zone"><input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
          <Field label="Main currency"><input className="input" maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
          <Field label="Financial year starts in"><select className="select" value={f.fyStartMonth} onChange={(e) => setF({ ...f, fyStartMonth: e.target.value })}>{['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
          <Field label="Working hours"><div className="row" style={{ gap: 6 }}><input className="input" type="time" value={f.workStart} onChange={(e) => setF({ ...f, workStart: e.target.value })} /><span>to</span><input className="input" type="time" value={f.workEnd} onChange={(e) => setF({ ...f, workEnd: e.target.value })} /></div></Field>
        </div>
        <Field label="Working days"><div className="row wrap" style={{ gap: 4 }}>{[1, 2, 3, 4, 5, 6, 7].map((d) => <button key={d} type="button" aria-pressed={f.workingDays.includes(d)} className={`kind-chip${f.workingDays.includes(d) ? ' is-active' : ''}`} onClick={() => setF({ ...f, workingDays: f.workingDays.includes(d) ? f.workingDays.filter((x) => x !== d) : [...f.workingDays, d].sort() })}>{day[d]}</button>)}</div></Field>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.useAttendanceHolidays !== false} onChange={(e) => setF({ ...f, useAttendanceHolidays: e.target.checked })} /> Skip the company holidays from Attendance</label>
      </div>
      <div className="card card-pad stack">
        <h3>Follow-up rules</h3>
        <div className="grid-2">
          <Field label="First contact within (working hours)"><input className="input" type="number" min="0" value={f.fu_firstResponseHours} onChange={(e) => setF({ ...f, fu_firstResponseHours: e.target.value })} /></Field>
          <Field label="Tell the manager when a follow-up is overdue by (hours)"><input className="input" type="number" min="1" value={f.fu_overdueEscalateHours} onChange={(e) => setF({ ...f, fu_overdueEscalateHours: e.target.value })} /></Field>
          <Field label="A lead is stale after (days without contact)"><input className="input" type="number" min="1" value={f.fu_staleLeadDays} onChange={(e) => setF({ ...f, fu_staleLeadDays: e.target.value })} /></Field>
          <Field label="A deal is stale after (days without contact)"><input className="input" type="number" min="1" value={f.fu_staleOpportunityDays} onChange={(e) => setF({ ...f, fu_staleOpportunityDays: e.target.value })} /></Field>
        </div>
      </div>
      <div className="card card-pad stack">
        <h3>Quotation and proposal letterhead</h3>
        <div className="grid-2">
          <Field label="Legal name"><input className="input" value={f.q_legalName} onChange={(e) => setF({ ...f, q_legalName: e.target.value })} placeholder="EkoSight Private Limited" /></Field>
          <Field label="Address"><input className="input" value={f.q_address} onChange={(e) => setF({ ...f, q_address: e.target.value })} /></Field>
          <Field label="Email"><input className="input" value={f.q_email} onChange={(e) => setF({ ...f, q_email: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={f.q_phone} onChange={(e) => setF({ ...f, q_phone: e.target.value })} /></Field>
          <Field label="Website"><input className="input" value={f.q_website} onChange={(e) => setF({ ...f, q_website: e.target.value })} /></Field>
          <Field label="Tax registration" hint="Printed as given; TaskFlow does not validate it"><div className="row" style={{ gap: 6 }}><input className="input" style={{ width: 90 }} value={f.q_taxIdLabel} onChange={(e) => setF({ ...f, q_taxIdLabel: e.target.value })} /><input className="input" value={f.q_taxId} onChange={(e) => setF({ ...f, q_taxId: e.target.value })} /></div></Field>
          <Field label="Valid for (days)"><input className="input" type="number" min="1" value={f.q_validityDays} onChange={(e) => setF({ ...f, q_validityDays: e.target.value })} /></Field>
        </div>
        <Field label="Standard terms"><textarea className="textarea" rows={3} value={f.q_terms} onChange={(e) => setF({ ...f, q_terms: e.target.value })} /></Field>
      </div>
      <div><button type="button" className="btn btn-primary" onClick={submit}>Save settings</button></div>
    </div>
  );
}

// ---------------------------------------------------------------- pipelines

function Pipelines() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [retiring, setRetiring] = useState(null);
  const load = useCallback(() => api.sales.get('/pipelines').then(setData).catch(toast.error), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Spinner />;
  const move = (p, index, delta) => {
    const ids = p.stages.map((s) => s.id);
    const [x] = ids.splice(index, 1);
    ids.splice(index + delta, 0, x);
    save(toast, api.sales.put(`/pipelines/${p.id}/order`, { stage_ids: ids }), 'Order saved').then(load).catch(() => {});
  };
  return (
    <div className="stack">
      {data.pipelines.map((p) => (
        <div key={p.id} className="card">
          <div className="card-head"><h3>{p.name}</h3><button type="button" className="btn btn-sm" onClick={() => setEdit({ pipeline: p, stage: null })}><Icon name="plus" size={12} /> Stage</button></div>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>Stage</th><th>Kind</th><th className="num">Probability</th><th>Needs</th><th className="num">Ageing after</th><th className="num">Deals</th><th /></tr></thead>
            <tbody>{p.stages.map((s, i) => (
              <tr key={s.id}>
                <td><span className="badge-dot" style={{ background: s.color }} /> {s.name}</td><td>{s.kind}</td>
                <td className="num">{s.default_probability ?? '—'}%</td>
                <td className="small">{[...(s.entry_rules || []), ...(s.required_fields || []).map((f) => data.required_fields[f] || f), s.approval_gate ? 'approved quotation' : null].filter(Boolean).join(', ') || '—'}</td>
                <td className="num">{s.aging_days ? `${s.aging_days} d` : '—'}</td><td className="num">{s.open_deal_count}</td>
                <td><div className="row" style={{ gap: 2 }}>
                  <button type="button" className="btn btn-sm btn-ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(p, i, -1)}><Icon name="up" size={12} /></button>
                  <button type="button" className="btn btn-sm btn-ghost" aria-label="Move down" disabled={i === p.stages.length - 1} onClick={() => move(p, i, 1)}><Icon name="down" size={12} /></button>
                  <button type="button" className="btn btn-sm" onClick={() => setEdit({ pipeline: p, stage: s })}>Edit</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRetiring({ pipeline: p, stage: s })}>Retire</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      ))}
      {edit && <StageDialog pipeline={edit.pipeline} stage={edit.stage} requiredFields={data.required_fields} onClose={() => setEdit(null)} onSaved={load} />}
      {retiring && <RetireDialog {...retiring} onClose={() => setRetiring(null)} onDone={load} />}
    </div>
  );
}

function StageDialog({ pipeline, stage, requiredFields, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    name: stage?.name || '', kind: stage?.kind || 'open', default_probability: stage?.default_probability ?? '', aging_days: stage?.aging_days ?? '',
    required_fields: stage?.required_fields || [], allowed_to: stage?.allowed_to || [], approval_gate: stage?.approval_gate || false,
    counts_in_forecast: stage?.counts_in_forecast !== false, checklist: (stage?.checklist || []).map((c) => c.label).join('\n'),
  }));
  const submit = () => {
    const body = {
      name: f.name, default_probability: f.default_probability === '' ? null : Number(f.default_probability), aging_days: f.aging_days === '' ? null : Number(f.aging_days),
      required_fields: f.required_fields, allowed_to: f.allowed_to.length ? f.allowed_to : null, approval_gate: f.approval_gate, counts_in_forecast: f.counts_in_forecast,
      checklist: f.checklist.split('\n').map((x) => x.trim()).filter(Boolean).map((label) => ({ label })),
      ...(stage ? {} : { kind: f.kind }),
    };
    save(toast, stage ? api.sales.patch(`/stages/${stage.id}`, body) : api.sales.post(`/pipelines/${pipeline.id}/stages`, body)).then(() => { onSaved(); onClose(); }).catch(() => {});
  };
  const toggle = (key, value) => setF((x) => ({ ...x, [key]: x[key].includes(value) ? x[key].filter((v) => v !== value) : [...x[key], value] }));
  return (
    <Modal title={stage ? `Edit ${stage.name}` : `New stage in ${pipeline.name}`} size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={f.name.trim().length < 2} onClick={submit}>Save</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Name" hint={stage ? 'Renaming keeps the stage and its history' : undefined}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          {!stage && <Field label="Kind"><select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select></Field>}
          <Field label="Default probability %" hint="Used for the weighted forecast when a deal has none of its own"><input className="input" type="number" min="0" max="100" value={f.default_probability} onChange={(e) => setF({ ...f, default_probability: e.target.value })} /></Field>
          <Field label="Ageing after (days)"><input className="input" type="number" min="1" value={f.aging_days} onChange={(e) => setF({ ...f, aging_days: e.target.value })} /></Field>
        </div>
        <Field label="Fields a deal needs to enter this stage">
          <div className="row wrap" style={{ gap: 4 }}>{Object.entries(requiredFields).map(([k, l]) => <button key={k} type="button" aria-pressed={f.required_fields.includes(k)} className={`kind-chip${f.required_fields.includes(k) ? ' is-active' : ''}`} onClick={() => toggle('required_fields', k)}>{l}</button>)}</div>
        </Field>
        {stage && (
          <Field label="Can move on to" hint="None selected: any stage of this pipeline">
            <div className="row wrap" style={{ gap: 4 }}>{pipeline.stages.filter((x) => x.id !== stage.id).map((x) => <button key={x.id} type="button" aria-pressed={f.allowed_to.includes(x.id)} className={`kind-chip${f.allowed_to.includes(x.id) ? ' is-active' : ''}`} onClick={() => toggle('allowed_to', x.id)}>{x.name}</button>)}</div>
          </Field>
        )}
        <Field label="Checklist shown when a deal moves in" hint="One item per line; guidance, not enforced"><textarea className="textarea" rows={3} value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} /></Field>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.approval_gate} onChange={(e) => setF({ ...f, approval_gate: e.target.checked })} /> Needs an approved quotation or proposal</label>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.counts_in_forecast} onChange={(e) => setF({ ...f, counts_in_forecast: e.target.checked })} /> Open deals here count in the weighted forecast</label>
        <div className="small muted">A manager can still move a deal without a required field by writing why; the exception stays on the deal’s history.</div>
      </div>
    </Modal>
  );
}

function RetireDialog({ pipeline, stage, onClose, onDone }) {
  const toast = useToast();
  const [into, setInto] = useState('');
  const options = pipeline.stages.filter((s) => s.id !== stage.id && s.kind === stage.kind);
  return (
    <Modal title={`Retire ${stage.name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-danger" disabled={stage.deal_count > 0 && !into} onClick={() => save(toast, api.sales.post(`/stages/${stage.id}/retire`, { into_stage_id: into ? Number(into) : null }), 'Retired').then(() => { onDone(); onClose(); }).catch(() => {})}>Retire</button></>}>
      <div className="stack">
        <div className="small">The stage stays in history. {stage.deal_count ? `${stage.deal_count} deal(s) are in it and move to the stage you choose, each with a history line.` : 'No deals are in it.'}</div>
        {stage.deal_count > 0 && <Field label="Move its deals to"><select className="select" value={into} onChange={(e) => setInto(e.target.value)}><option value="">Choose…</option>{options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- assignment

function Assignment({ meta, onSaved }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [rule, setRule] = useState(null);
  const [sim, setSim] = useState({ category: 'B2B_CORPORATE', source_id: '', state: '' });
  const [simResult, setSimResult] = useState(null);
  const [fallback, setFallback] = useState(meta.settings.assignment?.fallbackUserId || '');
  const [keepOwner, setKeepOwner] = useState(meta.settings.assignment?.keepAccountOwner !== false);
  const load = useCallback(() => api.sales.get('/assignment/rules').then(setData).catch(toast.error), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Spinner />;
  const agentPatch = (a, body) => save(toast, api.sales.put(`/assignment/agents/${a.user_id}`, body)).then(load).catch(() => {});
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h3>Rules, in order</h3>
        <div className="small muted">The first rule that matches a lead picks its owner from the people on it. A new enquiry from an organization someone already owns goes to that owner first{keepOwner ? '' : ' (switched off)'}.</div>
        {data.rules.length === 0 ? <div className="empty small">No rules yet.</div> : data.rules.map((r) => (
          <div key={r.id} className="sales-row">
            <Badge tone={r.is_enabled ? 'good' : 'neutral'}>{r.is_enabled ? 'on' : 'off'}</Badge>
            <div className="grow stack-xs"><strong className="small">{r.priority}. {r.name}</strong>
              <span className="small muted">{r.strategy.toLowerCase().replace('_', ' ')} among {(r.user_ids || []).map((id) => meta.users.find((u) => u.id === id)?.full_name).filter(Boolean).join(', ') || 'nobody yet'}{r.conditions?.categories?.length ? ` · ${r.conditions.categories.map((c) => CATEGORY[c].short).join('/')}` : ''}{r.conditions?.states?.length ? ` · ${r.conditions.states.join(', ')}` : ''}</span></div>
            <button type="button" className="btn btn-sm" onClick={() => setRule(r)}>Edit</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => save(toast, api.sales.patch(`/assignment/rules/${r.id}`, { is_enabled: !r.is_enabled })).then(load).catch(() => {})}>{r.is_enabled ? 'Switch off' : 'Switch on'}</button>
          </div>
        ))}
        <div><button type="button" className="btn btn-sm" onClick={() => setRule({})}><Icon name="plus" size={12} /> Rule</button></div>
        <div className="grid-2">
          <Field label="When no rule matches, give it to" hint="Blank: it stays unassigned and the people who assign leads are told">
            <select className="select" value={fallback} onChange={(e) => setFallback(e.target.value)}><option value="">Nobody</option>{meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
          </Field>
          <label className="row small" style={{ gap: 6, alignSelf: 'end' }}><input type="checkbox" checked={keepOwner} onChange={(e) => setKeepOwner(e.target.checked)} /> Repeat enquiries go to the organization’s owner</label>
        </div>
        <div><button type="button" className="btn btn-sm btn-primary" onClick={() => save(toast, api.sales.put('/settings', { assignment: { fallbackUserId: fallback ? Number(fallback) : null, keepAccountOwner: keepOwner } })).then(onSaved).catch(() => {})}>Save</button></div>
      </div>
      <div className="card card-pad stack-sm">
        <h3>Try a lead</h3>
        <div className="row wrap" style={{ gap: 6 }}>
          <select className="select" style={{ width: 'auto' }} value={sim.category} onChange={(e) => setSim({ ...sim, category: e.target.value })}>{ELIGIBLE.map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}</select>
          <select className="select" style={{ width: 'auto' }} value={sim.source_id} onChange={(e) => setSim({ ...sim, source_id: e.target.value })}><option value="">Any source</option>{meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <input className="input" style={{ width: 160 }} placeholder="State" value={sim.state} onChange={(e) => setSim({ ...sim, state: e.target.value })} />
          <button type="button" className="btn btn-sm" onClick={() => api.sales.post('/assignment/simulate', { category: sim.category, source_id: sim.source_id ? Number(sim.source_id) : null, state: sim.state || null }).then(setSimResult).catch(toast.error)}>Who would get it?</button>
        </div>
        {simResult && <div className="small mkt-callout"><strong>{simResult.userId ? meta.users.find((u) => u.id === simResult.userId)?.full_name : 'Nobody'}</strong> — {simResult.explain?.decided_by?.why || 'no rule matched and there is no fallback'}{simResult.explain?.rules?.length ? <ul>{simResult.explain.rules.map((r) => <li key={r.rule_id}>{r.name}: {r.matched ? (r.chosen ? 'chose' : r.why) : `skipped — ${r.why}`}</li>)}</ul> : null}</div>}
      </div>
      <div className="card card-pad stack-sm">
        <h3>People taking leads</h3>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>Person</th><th>Takes new leads</th><th className="num">Open leads</th><th>Most open leads</th></tr></thead>
          <tbody>{data.agents.filter((a) => a.is_active).map((a) => (
            <tr key={a.user_id}><td>{a.full_name}</td>
              <td><input type="checkbox" aria-label={`${a.full_name} takes new leads`} checked={a.accepts_new_leads !== false} onChange={(e) => agentPatch(a, { accepts_new_leads: e.target.checked })} /></td>
              <td className="num">{a.open_leads}</td>
              <td><input className="input" style={{ width: 80 }} type="number" min="1" defaultValue={a.max_open_leads ?? ''} aria-label={`${a.full_name} capacity`} onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (a.max_open_leads ?? null)) agentPatch(a, { max_open_leads: v }); }} placeholder="no limit" /></td></tr>
          ))}</tbody></table></div>
        <div className="small muted">People on leave or away today (from Attendance) are skipped automatically.</div>
      </div>
      {rule && <RuleDialog meta={meta} rule={rule} onClose={() => setRule(null)} onSaved={load} />}
    </div>
  );
}

function RuleDialog({ meta, rule, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    name: rule.name || '', priority: rule.priority ?? '', strategy: rule.strategy || 'ROUND_ROBIN', user_ids: rule.user_ids || [],
    categories: rule.conditions?.categories || [], source_ids: rule.conditions?.source_ids || [], states: (rule.conditions?.states || []).join(', '), is_enabled: rule.is_enabled !== false,
  }));
  const submit = () => {
    const body = { name: f.name, priority: f.priority === '' ? undefined : Number(f.priority), strategy: f.strategy, user_ids: f.user_ids, is_enabled: f.is_enabled,
      conditions: { categories: f.categories, source_ids: f.source_ids, states: f.states.split(',').map((x) => x.trim()).filter(Boolean) } };
    save(toast, rule.id ? api.sales.patch(`/assignment/rules/${rule.id}`, body) : api.sales.post('/assignment/rules', body)).then(() => { onSaved(); onClose(); }).catch(() => {});
  };
  const toggle = (k, v) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));
  return (
    <Modal title={rule.id ? 'Edit rule' : 'New rule'} size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={f.name.trim().length < 2} onClick={submit}>Save</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="CSR leads to the CSR team" /></Field>
          <Field label="Order" hint="Lower runs first"><input className="input" type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></Field>
        </div>
        <Field label="For leads that are"><div className="row wrap" style={{ gap: 4 }}>{ELIGIBLE.map((c) => <button key={c} type="button" className={`kind-chip${f.categories.includes(c) ? ' is-active' : ''}`} onClick={() => toggle('categories', c)}>{CATEGORY[c].label}</button>)}</div></Field>
        <Field label="From sources (none: any)"><div className="row wrap" style={{ gap: 4 }}>{meta.sources.map((s) => <button key={s.id} type="button" className={`kind-chip${f.source_ids.includes(s.id) ? ' is-active' : ''}`} onClick={() => toggle('source_ids', s.id)}>{s.name}</button>)}</div></Field>
        <Field label="In states (comma-separated; blank: any)"><input className="input" value={f.states} onChange={(e) => setF({ ...f, states: e.target.value })} placeholder="Maharashtra, Karnataka" /></Field>
        <Field label="How to choose">
          <select className="select" value={f.strategy} onChange={(e) => setF({ ...f, strategy: e.target.value })}>
            <option value="ROUND_ROBIN">Take turns (equal shares)</option><option value="LEAST_LOADED">Whoever has fewest open leads</option>
            <option value="SPECIALIZATION">By region or speciality, then fewest open</option><option value="SPECIFIC_USER">Always the first available person</option><option value="ACCOUNT_OWNER">The organization’s owner</option>
          </select>
        </Field>
        <Field label="Among"><div className="row wrap" style={{ gap: 4 }}>{meta.users.filter((u) => u.is_active && u.role !== 'viewer').map((u) => <button key={u.id} type="button" className={`kind-chip${f.user_ids.includes(u.id) ? ' is-active' : ''}`} onClick={() => toggle('user_ids', u.id)}>{u.full_name}</button>)}</div></Field>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.is_enabled} onChange={(e) => setF({ ...f, is_enabled: e.target.checked })} /> On</label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- scoring, sources, capture

function Scoring() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const load = useCallback(() => api.sales.get('/scoring').then(setData).catch(toast.error), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Spinner />;
  return (
    <div className="stack">
      <div className="small muted">A score says how good a fit a lead looks, from what is recorded. It is not the chance of winning (that is the deal’s probability). Weights below add up to the maximum score.</div>
      {data.models.map((m) => <ScoringModel key={m.category} model={m} criteria={data.criteria} onSaved={load} />)}
    </div>
  );
}
function ScoringModel({ model, criteria, onSaved }) {
  const toast = useToast();
  const [rows, setRows] = useState(model.criteria);
  const total = rows.reduce((t, r) => t + Number(r.weight || 0), 0);
  return (
    <div className="card card-pad stack-sm">
      <div className="row-between"><h3>{CATEGORY[model.category].label}</h3><span className="small muted">total {total}</span></div>
      {rows.map((r, i) => (
        <div key={r.key} className="row" style={{ gap: 8 }}>
          <span className="grow small">{r.label || criteria.find((c) => c.key === r.key)?.label}</span>
          <input className="input" style={{ width: 80 }} type="number" min="0" max="100" aria-label={`Weight of ${r.label}`} value={r.weight} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))} />
        </div>
      ))}
      <div><button type="button" className="btn btn-sm btn-primary" onClick={() => save(toast, api.sales.put(`/scoring/${model.category}`, { criteria: rows }), 'Saved; open leads rescored').then(onSaved).catch(() => {})}>Save weights</button></div>
    </div>
  );
}

function Sources({ meta, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [camp, setCamp] = useState({ name: '', source_id: '', utm_campaign: '', starts_on: '', ends_on: '', spend: '' });
  return (
    <div className="grid-2">
      <div className="card card-pad stack-sm">
        <h3>Sources</h3>
        <div className="small muted">Where enquiries come from. “Imported” or “entered by hand” is how a lead came in, not its source.</div>
        {meta.sources.map((s) => <div key={s.id} className="small">{s.name} <span className="muted">· {s.channel.toLowerCase()}</span></div>)}
        <div className="row" style={{ gap: 6 }}><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Krishi expo 2026" /><button type="button" className="btn btn-sm" disabled={name.trim().length < 2} onClick={() => save(toast, api.sales.post('/sources', { name })).then(() => { setName(''); onSaved(); }).catch(() => {})}>Add</button></div>
      </div>
      <div className="card card-pad stack-sm">
        <h3>Campaigns</h3>
        {meta.campaigns.map((c) => <div key={c.id} className="small">{c.name} <span className="muted">· {c.source_name || 'no source'}{c.utm_campaign ? ` · utm ${c.utm_campaign}` : ''}{c.spend ? ` · spend ${money(c.spend, c.spend_currency)}` : ''}</span></div>)}
        <div className="grid-2">
          <input className="input" value={camp.name} onChange={(e) => setCamp({ ...camp, name: e.target.value })} placeholder="Kharif 2026 Google Ads" aria-label="Campaign name" />
          <select className="select" value={camp.source_id} onChange={(e) => setCamp({ ...camp, source_id: e.target.value })} aria-label="Source"><option value="">Source…</option>{meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <input className="input" value={camp.utm_campaign} onChange={(e) => setCamp({ ...camp, utm_campaign: e.target.value })} placeholder="utm_campaign value" aria-label="UTM campaign" />
          <input className="input" type="number" min="0" value={camp.spend} onChange={(e) => setCamp({ ...camp, spend: e.target.value })} placeholder="Spend (optional)" aria-label="Spend" />
        </div>
        <div><button type="button" className="btn btn-sm" disabled={camp.name.trim().length < 2} onClick={() => save(toast, api.sales.post('/campaigns', { ...Object.fromEntries(Object.entries(camp).filter(([, v]) => v !== '')), source_id: camp.source_id ? Number(camp.source_id) : null, spend: camp.spend ? Number(camp.spend) : null })).then(() => { setCamp({ name: '', source_id: '', utm_campaign: '', starts_on: '', ends_on: '', spend: '' }); onSaved(); }).catch(() => {})}>Add campaign</button></div>
      </div>
    </div>
  );
}

function Capture({ meta }) {
  const toast = useToast();
  const [keys, setKeys] = useState(null);
  const [forms, setForms] = useState(null);
  const [newKey, setNewKey] = useState(null);
  const [name, setName] = useState('');
  const [form, setForm] = useState({ name: '', title: 'Talk to Soil Doctor', source_id: '', consent_text: '' });
  const load = useCallback(() => {
    api.sales.get('/capture/keys').then((r) => setKeys(r.keys)).catch(() => setKeys([]));
    api.sales.get('/capture/forms').then((r) => setForms(r.forms)).catch(() => setForms([]));
  }, []);
  useEffect(load, [load]);
  const origin = window.location.origin;
  return (
    <div className="stack">
      <div className="card card-pad stack-sm">
        <h3>Hosted enquiry form</h3>
        <div className="small muted">A page you can link to or embed. Visitors say who they are; retailers, FPOs and individuals are routed to the TeleCRM queue and everyone sees the same thank-you.</div>
        {!forms ? <Spinner /> : forms.map((f) => <div key={f.id} className="sales-row small"><strong>{f.name}</strong><code className="mkt-code grow truncate">{`${origin}/api/taskflow/s/f/${f.public_id}`}</code><CopyButton text={`${origin}/api/taskflow/s/f/${f.public_id}`} /><span className="muted">{f.submissions} sent</span></div>)}
        <div className="grid-2">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Website contact form" aria-label="Form name" />
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Form title" />
          <select className="select" value={form.source_id} onChange={(e) => setForm({ ...form, source_id: e.target.value })} aria-label="Source"><option value="">Source…</option>{meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <input className="input" value={form.consent_text} onChange={(e) => setForm({ ...form, consent_text: e.target.value })} placeholder="Consent wording (optional)" aria-label="Consent text" />
        </div>
        <div><button type="button" className="btn btn-sm" disabled={form.name.trim().length < 2} onClick={() => save(toast, api.sales.post('/capture/forms', { ...form, source_id: form.source_id ? Number(form.source_id) : null, consent_text: form.consent_text || null }), 'Form created').then(load).catch(() => {})}>Create form</button></div>
      </div>
      <div className="card card-pad stack-sm">
        <h3>API keys for websites, ads and other systems</h3>
        <div className="small muted">POST leads as JSON to <code>{origin}/api/taskflow/s/leads</code> with <code>Authorization: Bearer &lt;key&gt;</code>. Send an <code>idempotency_key</code> or <code>external_id</code> so retries never make a second lead. See Help → API & webhooks.</div>
        {!keys ? <Spinner /> : keys.map((k) => <div key={k.id} className="sales-row small"><strong>{k.name}</strong><code>{k.prefix}…</code><span className="grow muted">{k.revoked_at ? 'revoked' : k.last_used_at ? `last used ${when(k.last_used_at)}` : 'not used yet'}</span>{!k.revoked_at && <button type="button" className="btn btn-sm btn-ghost" onClick={() => save(toast, api.sales.post(`/capture/keys/${k.id}/revoke`), 'Revoked').then(load).catch(() => {})}>Revoke</button>}</div>)}
        <div className="row" style={{ gap: 6 }}><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Website (WordPress)" aria-label="Key name" /><button type="button" className="btn btn-sm" disabled={name.trim().length < 2} onClick={() => save(toast, api.sales.post('/capture/keys', { name }), 'Key created').then((r) => { setNewKey(r.key); setName(''); load(); }).catch(() => {})}>Create key</button></div>
        {newKey && <div className="mkt-callout is-good small stack-sm"><strong>Copy this key now; it is not shown again.</strong><div className="row" style={{ gap: 6 }}><code className="mkt-code grow">{newKey.key}</code><CopyButton text={newKey.key} /></div></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- catalogue, approvals, rates

function Catalogue({ meta }) {
  const toast = useToast();
  const { can } = useAuth();
  const [products, setProducts] = useState(null);
  const [rules, setRules] = useState(null);
  const [rates, setRates] = useState(null);
  const [p, setP] = useState({ name: '', unit: '', unit_price: '', tax_rate: '', tax_label: 'GST', hsn_sac: '', kind: 'PRODUCT' });
  const [r, setR] = useState({ name: '', min_discount_pct: '', min_total: '', approver_user_ids: [] });
  const [fx, setFx] = useState({ currency: 'USD', rate: '', as_of: localDay(0), source: '' });
  const load = useCallback(() => {
    api.sales.get('/products', { all: '1' }).then((x) => setProducts(x.products)).catch(() => setProducts([]));
    api.sales.get('/approval-rules').then((x) => setRules(x.rules)).catch(() => setRules([]));
    api.sales.get('/fx-rates').then((x) => setRates(x.rates)).catch(() => setRates([]));
  }, []);
  useEffect(load, [load]);
  return (
    <div className="stack">
      <div className="card card-pad stack-sm">
        <h3>Products and services</h3>
        {!products ? <Spinner /> : products.map((x) => <div key={x.id} className="sales-row small"><strong className="grow">{x.name}{!x.is_active && ' (off)'}</strong><span>{money(x.unit_price, x.currency)}{x.unit ? ` / ${x.unit}` : ''}</span><span className="muted">{x.tax_rate !== null ? `${x.tax_label || 'Tax'} ${Number(x.tax_rate)}%` : 'no tax'}</span><button type="button" className="btn btn-sm btn-ghost" onClick={() => save(toast, api.sales.patch(`/products/${x.id}`, { is_active: !x.is_active })).then(load).catch(() => {})}>{x.is_active ? 'Hide' : 'Show'}</button></div>)}
        <div className="grid-3">
          <input className="input" placeholder="Soil test kit" aria-label="Name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          <input className="input" placeholder="Unit (kit, day)" aria-label="Unit" value={p.unit} onChange={(e) => setP({ ...p, unit: e.target.value })} />
          <input className="input" placeholder="Price" inputMode="decimal" aria-label="Price" value={p.unit_price} onChange={(e) => setP({ ...p, unit_price: e.target.value })} />
          <input className="input" placeholder="Tax %" inputMode="decimal" aria-label="Tax rate" value={p.tax_rate} onChange={(e) => setP({ ...p, tax_rate: e.target.value })} />
          <input className="input" placeholder="HSN/SAC" aria-label="HSN or SAC" value={p.hsn_sac} onChange={(e) => setP({ ...p, hsn_sac: e.target.value })} />
          <select className="select" aria-label="Kind" value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value })}><option value="PRODUCT">Product</option><option value="SERVICE">Service</option><option value="SUBSCRIPTION">Subscription</option><option value="PROGRAMME">Programme</option></select>
        </div>
        <div><button type="button" className="btn btn-sm" disabled={p.name.trim().length < 2} onClick={() => save(toast, api.sales.post('/products', { ...p, unit_price: p.unit_price || null, tax_rate: p.tax_rate === '' ? null : Number(p.tax_rate), hsn_sac: p.hsn_sac || null, unit: p.unit || null })).then(() => { setP({ ...p, name: '', unit_price: '' }); load(); }).catch(() => {})}>Add</button></div>
      </div>
      <div className="card card-pad stack-sm">
        <h3>Approval rules</h3>
        <div className="small muted">A quotation or proposal over a rule’s discount or value needs one of its approvers. Nobody approves their own request unless the rule allows it. Changing an approved quotation needs approval again.</div>
        {!rules ? <Spinner /> : rules.map((x) => <div key={x.id} className="sales-row small"><Badge tone={x.is_enabled ? 'good' : 'neutral'}>{x.is_enabled ? 'on' : 'off'}</Badge><strong className="grow">{x.name}</strong><span>{x.min_discount_pct !== null ? `discount ≥ ${Number(x.min_discount_pct)}%` : ''}{x.min_discount_pct !== null && x.min_total !== null ? ' or ' : ''}{x.min_total !== null ? `total ≥ ${money(x.min_total, x.currency)}` : ''}</span><span className="muted">{(x.approver_names || []).join(', ') || 'anyone who can approve'}</span></div>)}
        <div className="grid-3">
          <input className="input" placeholder="Rule name" aria-label="Rule name" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} />
          <input className="input" placeholder="Discount % or more" aria-label="Minimum discount" inputMode="decimal" value={r.min_discount_pct} onChange={(e) => setR({ ...r, min_discount_pct: e.target.value })} />
          <input className="input" placeholder={`Total or more (${meta.settings.calendar?.currency || 'INR'})`} aria-label="Minimum total" inputMode="decimal" value={r.min_total} onChange={(e) => setR({ ...r, min_total: e.target.value })} />
        </div>
        <div className="row wrap" style={{ gap: 4 }}>{meta.users.filter((u) => u.is_active && u.role !== 'member' && u.role !== 'viewer').map((u) => <button key={u.id} type="button" className={`kind-chip${r.approver_user_ids.includes(u.id) ? ' is-active' : ''}`} onClick={() => setR({ ...r, approver_user_ids: r.approver_user_ids.includes(u.id) ? r.approver_user_ids.filter((x) => x !== u.id) : [...r.approver_user_ids, u.id] })}>{u.full_name}</button>)}</div>
        <div><button type="button" className="btn btn-sm" disabled={r.name.trim().length < 2 || (r.min_discount_pct === '' && r.min_total === '')} onClick={() => save(toast, api.sales.post('/approval-rules', { name: r.name, min_discount_pct: r.min_discount_pct === '' ? null : Number(r.min_discount_pct), min_total: r.min_total === '' ? null : r.min_total, approver_user_ids: r.approver_user_ids, currency: meta.settings.calendar?.currency || 'INR' })).then(() => { setR({ name: '', min_discount_pct: '', min_total: '', approver_user_ids: [] }); load(); }).catch(() => {})}>Add rule</button></div>
      </div>
      <div className="card card-pad stack-sm">
        <h3>Currency rates</h3>
        <div className="small muted">Amounts in different currencies are never added together. A rate recorded here, with its date and source, is what a conversion would use.</div>
        {!rates ? <Spinner /> : rates.slice(0, 10).map((x) => <div key={x.id} className="small">1 {x.currency} = {Number(x.rate)} {x.base} on {dayOf(x.as_of)}{x.source ? ` · ${x.source}` : ''}</div>)}
        {can('crm.finance') ? (
          <div className="row wrap" style={{ gap: 6 }}>
            <input className="input" style={{ width: 70 }} maxLength={3} aria-label="Currency" value={fx.currency} onChange={(e) => setFx({ ...fx, currency: e.target.value.toUpperCase() })} />
            <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder="Rate" aria-label="Rate" value={fx.rate} onChange={(e) => setFx({ ...fx, rate: e.target.value })} />
            <input className="input" type="date" aria-label="As of" value={fx.as_of} onChange={(e) => setFx({ ...fx, as_of: e.target.value })} />
            <input className="input" placeholder="Source (RBI reference rate)" aria-label="Source" value={fx.source} onChange={(e) => setFx({ ...fx, source: e.target.value })} />
            <button type="button" className="btn btn-sm" disabled={!fx.rate} onClick={() => save(toast, api.sales.post('/fx-rates', { ...fx, rate: fx.rate })).then(load).catch(() => {})}>Record</button>
          </div>
        ) : <div className="small muted">Rates are recorded by finance.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- integrations

function Integrations() {
  const toast = useToast();
  const [h, setH] = useState(null);
  const load = useCallback(() => api.sales.get('/integrations').then(setH).catch(toast.error), [toast]);
  useEffect(() => { load(); }, [load]);
  if (!h) return <Spinner />;
  const origin = window.location.origin;
  const tone = (state) => (state === 'Receiving events' || state.startsWith('Working') ? 'good' : state === 'Not connected' ? 'neutral' : 'warning');
  return (
    <div className="stack">
      <div className="small muted">Connections use credentials set as environment variables on the server; they are never entered or shown here. “Awaiting live verification” means configured but not yet proven with real traffic.</div>
      <div className="card card-pad stack-sm">
        <div className="row-between"><h3>WhatsApp Business (Meta Cloud API)</h3><Badge tone={tone(h.whatsapp.state)}>{h.whatsapp.state}</Badge></div>
        {h.whatsapp.sandbox && <Badge tone="warning">Test (sandbox) number</Badge>}
        {h.whatsapp.missing.length > 0 && <div className="small">Not set on the server: <code>{h.whatsapp.missing.join(', ')}</code></div>}
        <div className="small">Webhook URL for Meta: <code>{origin}{h.whatsapp.webhook_path}</code> <CopyButton text={`${origin}${h.whatsapp.webhook_path}`} /> — verify token = <code>WHATSAPP_VERIFY_TOKEN</code>; signatures checked with <code>WHATSAPP_APP_SECRET</code>.</div>
        <div className="small muted">{h.whatsapp.events_24h} webhook events in 24 hours{h.whatsapp.last_event ? `; last ${when(h.whatsapp.last_event)}` : ''}.</div>
        {h.whatsapp.templates_sync && <div><button type="button" className="btn btn-sm" onClick={() => save(toast, api.sales.post('/whatsapp/templates/sync'), 'Templates synced').catch(() => {})}>Sync approved templates</button></div>}
      </div>
      <div className="card card-pad stack-sm">
        <div className="row-between"><h3>Calling</h3></div>
        <div className="sales-row small"><Badge tone="good">{h.calling.manual.state}</Badge><span className="grow">Manual logging. {h.calling.manual.note}</span></div>
        <div className="sales-row small"><Badge tone={tone(h.calling.exotel.state)}>{h.calling.exotel.state}</Badge><span className="grow">Exotel click-to-call{h.calling.exotel.missing.length ? ` — not set: ${h.calling.exotel.missing.join(', ')}` : ` via ${h.calling.exotel.subdomain}`}. Callback field names are confirmed during the first live test.</span></div>
        <div className="sales-row small"><Badge tone={tone(h.calling.webhook.state)}>{h.calling.webhook.state}</Badge><span className="grow">Any phone system: POST signed call events to <code>{origin}{h.calling.webhook.path}</code> (HMAC-SHA256 with <code>CALL_WEBHOOK_SECRET</code>).</span></div>
      </div>
      <div className="card card-pad stack-sm">
        <div className="row-between"><h3>TeleCRM</h3><Badge tone="good">{h.telecrm.state}</Badge></div>
        <div className="small">{h.telecrm.note}</div>
      </div>
      {h.failures.length > 0 && (
        <div className="card card-pad stack-sm"><h3>Recent failures</h3>{h.failures.map((f, i) => <div key={i} className="small">{when(f.received_at)} · {f.provider} {f.kind}: {f.error}</div>)}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- automation

const PRESETS = [
  { name: 'Call every new corporate lead within 2 working hours', trigger: 'lead.captured', conditions: [{ field: 'category', op: 'eq', value: 'B2B_CORPORATE' }], actions: [{ type: 'create_followup', kind: 'CALL', due_in_hours: 2, title: 'First call: {{name}}' }] },
  { name: 'Tell the manager when a deal goes quiet', trigger: 'opportunity.stale', conditions: [], actions: [{ type: 'escalate', to: 'escalation', title: '{{name}} has gone quiet' }] },
  { name: 'Start delivery when a deal is won', trigger: 'opportunity.won', conditions: [], actions: [{ type: 'handover' }] },
  { name: 'Remind about overdue payments', trigger: 'payment.overdue', conditions: [], actions: [{ type: 'notify', to: 'owner', title: 'Payment overdue on {{name}}' }, { type: 'create_followup', kind: 'CALL', due_in_hours: 4, title: 'Chase payment: {{name}}' }] },
  { name: 'WhatsApp a reminder a day after a lead arrives (needs an approved template)', trigger: 'lead.captured', delay_minutes: 1440, cancel_on: ['reply', 'terminal'], conditions: [], actions: [{ type: 'send_whatsapp_template', template_name: '', variables: ['{{contact_name}}'] }] },
];

function Automation() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [runs, setRuns] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => {
    api.sales.get('/automation/rules').then(setData).catch(toast.error);
    api.sales.get('/automation/runs').then((r) => setRuns(r.runs)).catch(() => setRuns([]));
  }, [toast]);
  useEffect(load, [load]);
  if (!data) return <Spinner />;
  const patch = (r, body, msg) => save(toast, api.sales.patch(`/automation/rules/${r.id}`, body), msg).then(load).catch(() => {});
  return (
    <div className="stack">
      <div className="mkt-callout small">New rules start <strong>off</strong> and in <strong>test mode</strong>: in test mode a rule writes down what it would do and does nothing. Messages are sent only when “live sends” is on (Settings → automation, by someone with the automation permission) and the rule is out of test mode. Live sends are {data.live_sends ? <strong>on</strong> : <strong>off</strong>}.</div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="small">Start from:</span>
        {PRESETS.map((p) => <button key={p.name} type="button" className="btn btn-sm" onClick={() => setEditing({ ...p })}>{p.name}</button>)}
      </div>
      {data.rules.length === 0 ? <EmptyState title="No automation yet">Pick a starting point above.</EmptyState> : data.rules.map((r) => (
        <div key={r.id} className="card card-pad stack-sm">
          <div className="row-between wrap">
            <div className="stack-xs"><strong>{r.name}</strong><span className="small muted">When {data.triggers[r.trigger]?.toLowerCase() || r.trigger}{r.delay_minutes ? `, after ${r.delay_minutes} min${r.business_hours_only ? ' of working time' : ''}` : ''} · {r.actions.map((a) => a.type.replace(/_/g, ' ')).join(', ')} · {r.runs_30d} run(s) in 30 days{r.failed ? ` · ${r.failed} failed` : ''}</span></div>
            <div className="row" style={{ gap: 4 }}>
              <Badge tone={r.is_enabled ? 'good' : 'neutral'}>{r.is_enabled ? 'on' : 'off'}</Badge>
              <Badge tone={r.test_mode ? 'warning' : 'brand'}>{r.test_mode ? 'test mode' : 'live'}</Badge>
              <button type="button" className="btn btn-sm" onClick={() => patch(r, { is_enabled: !r.is_enabled }, r.is_enabled ? 'Switched off; its scheduled runs are cancelled' : 'Switched on')}>{r.is_enabled ? 'Switch off' : 'Switch on'}</button>
              <button type="button" className="btn btn-sm" onClick={() => patch(r, { test_mode: !r.test_mode }, r.test_mode ? 'Now live' : 'Back in test mode')}>{r.test_mode ? 'Go live' : 'Test mode'}</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(r)}>Edit</button>
            </div>
          </div>
        </div>
      ))}
      <div className="card">
        <div className="card-head"><h3>Recent runs</h3></div>
        <div className="card-pad stack-sm">
          {!runs ? <Spinner /> : runs.length === 0 ? <div className="empty small">Nothing has run yet.</div> : runs.slice(0, 40).map((x) => (
            <div key={x.id} className="sales-row small">
              <Badge tone={{ DONE: 'good', SIMULATED: 'brand', FAILED: 'critical', CANCELLED: 'neutral', SKIPPED: 'neutral', SCHEDULED: 'warning' }[x.status]}>{x.status.toLowerCase()}</Badge>
              <span className="grow truncate">{x.rule_name} · {x.entity_type.toLowerCase()} #{x.entity_id}{x.cancelled_reason ? ` · ${x.cancelled_reason}` : ''}{x.last_error ? ` · ${x.last_error}` : ''}</span>
              <span className="muted">{when(x.finished_at || x.run_at)}</span>
              {x.status === 'FAILED' && <button type="button" className="btn btn-sm" onClick={() => save(toast, api.sales.post(`/automation/runs/${x.id}/retry`), 'Retrying; a message it sent before is not sent again').then(load).catch(() => {})}>Retry</button>}
            </div>
          ))}
        </div>
      </div>
      {editing && <AutomationDialog rule={editing} meta={data} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function AutomationDialog({ rule, meta, onClose, onSaved }) {
  const toast = useToast();
  const [text, setText] = useState(() => JSON.stringify({ name: rule.name, trigger: rule.trigger, conditions: rule.conditions || [], actions: rule.actions || [], delay_minutes: rule.delay_minutes || 0, business_hours_only: rule.business_hours_only || false, cancel_on: rule.cancel_on || ['terminal'] }, null, 2));
  const [test, setTest] = useState({ entity_type: 'LEAD', entity_id: '' });
  const [preview, setPreview] = useState(null);
  const parse = () => { try { return JSON.parse(text); } catch { toast.error('The rule is not valid JSON'); return null; } };
  const submit = () => { const body = parse(); if (!body) return; save(toast, rule.id ? api.sales.patch(`/automation/rules/${rule.id}`, body) : api.sales.post('/automation/rules', body), rule.id ? 'Saved' : 'Created (off, in test mode)').then(() => { onSaved(); onClose(); }).catch(() => {}); };
  const tryIt = () => { const body = parse(); if (!body || !test.entity_id) return; api.sales.post('/automation/preview', { rule: body, entity_type: test.entity_type, entity_id: Number(test.entity_id) }).then(setPreview).catch(toast.error); };
  return (
    <Modal title={rule.id ? 'Edit automation' : 'New automation'} size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={submit}>Save</button></>}>
      <div className="stack">
        <div className="small muted">Triggers: {Object.keys(meta.triggers).join(', ')}. Actions: {meta.actions.join(', ')}. Conditions compare a field (category, pipeline, stage, source, value, score, owner_id, priority, status, tags, custom.&lt;field&gt;) with eq, neq, in, nin, gte, lte, contains, empty or not_empty. Text can use {'{{name}}'}, {'{{contact_name}}'}, {'{{ref}}'}.</div>
        <textarea className="textarea mkt-code" rows={14} value={text} onChange={(e) => setText(e.target.value)} aria-label="Rule definition" spellCheck={false} />
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="small">Try it on</span>
          <select className="select" style={{ width: 'auto' }} value={test.entity_type} onChange={(e) => setTest({ ...test, entity_type: e.target.value })}><option value="LEAD">lead id</option><option value="OPPORTUNITY">deal id</option></select>
          <input className="input" style={{ width: 100 }} inputMode="numeric" value={test.entity_id} onChange={(e) => setTest({ ...test, entity_id: e.target.value })} aria-label="Record id" />
          <button type="button" className="btn btn-sm" onClick={tryIt}>Preview</button>
        </div>
        {preview && <div className="mkt-callout small">{preview.matches ? 'It matches.' : `It does not match: ${preview.failed.map((f) => f.field).join(', ')}.`} It would: {preview.actions.map((a) => a.summary).join('; ')}. Nothing was changed.</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- remediation, targets, audit

function Remediation({ meta }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const load = useCallback(() => api.sales.get('/routing/remediation').then((r) => setList(r.organizations)).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  if (!list) return <Spinner />;
  const classify = (body) => save(toast, api.sales.post('/routing/accounts/classify', { ids: [...picked], ...body })).then((r) => { toast.success(`${r.done.length} classified${r.refused.length ? `, ${r.refused.length} refused` : ''}`); setPicked(new Set()); load(); }).catch(() => {});
  return (
    <div className="stack">
      <div className="small muted">Organizations that existed before categories. Nothing is reclassified or deleted automatically; each has a suggestion with its reason. Retailers and FPOs are flagged first. Choosing a TeleCRM category keeps the organization and its history and queues it for the TeleCRM hand-off.</div>
      {list.length === 0 ? <EmptyState title="Nothing to classify">Every organization has a confirmed category.</EmptyState> : (
        <>
          {picked.size > 0 && (
            <div className="row wrap sales-bulk">
              <strong className="small">{picked.size} selected</strong>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => classify({ use_suggestion: true, reason: 'Confirmed the suggestion' })}>Confirm the suggestions</button>
              {[...ELIGIBLE, ...EXCLUDED].map((c) => <button key={c} type="button" className="btn btn-sm" onClick={() => classify({ category: c, reason: 'Classified in review' })}>{CATEGORY[c].short}</button>)}
            </div>
          )}
          <div className="table-scroll"><table className="data-table"><thead><tr><th><input type="checkbox" aria-label="Select all" onChange={(e) => setPicked(e.target.checked ? new Set(list.map((o) => o.id)) : new Set())} /></th><th>Organization</th><th>Suggestion</th><th>Why</th><th className="num">Open deals</th><th>Owner</th></tr></thead>
            <tbody>{list.map((o) => <tr key={o.id} className={o.flagged ? 'is-late' : ''}><td><input type="checkbox" aria-label={`Select ${o.name}`} checked={picked.has(o.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })} /></td>
              <td><Link to={`/accounts/${o.id}`}>{o.name}</Link></td><td>{o.suggested_category ? CATEGORY[o.suggested_category]?.label : '—'}</td><td className="small">{o.suggestion_reason}</td><td className="num">{o.open_deals}</td><td>{o.owner_name || '—'}</td></tr>)}</tbody></table></div>
        </>
      )}
      <div className="small muted">{meta.settings.routing?.legacyUnclassified === 'EXCLUDE' ? 'Until confirmed they are left out of pipelines and reports.' : 'Until confirmed they stay in pipelines and reports as before.'}</div>
    </div>
  );
}

function Targets({ meta }) {
  const toast = useToast();
  const [t, setT] = useState({ period_start: `${localDay(0).slice(0, 8)}01`, period_end: localDay(0), metric: 'WON_VALUE', target: '', user_id: '', currency: meta.settings.calendar?.currency || 'INR' });
  return (
    <div className="card card-pad stack-sm">
      <h3>Set a target</h3>
      <div className="grid-3">
        <Field label="From"><input className="input" type="date" value={t.period_start} onChange={(e) => setT({ ...t, period_start: e.target.value })} /></Field>
        <Field label="To"><input className="input" type="date" value={t.period_end} onChange={(e) => setT({ ...t, period_end: e.target.value })} /></Field>
        <Field label="Measure"><select className="select" value={t.metric} onChange={(e) => setT({ ...t, metric: e.target.value })}>{['NEW_LEADS', 'CONVERTED_LEADS', 'WON_DEALS', 'WON_VALUE', 'CSR_COMMITTED', 'RECEIPTS'].map((m) => <option key={m} value={m}>{m.toLowerCase().replace(/_/g, ' ')}</option>)}</select></Field>
        <Field label="Target"><input className="input" type="number" min="0" value={t.target} onChange={(e) => setT({ ...t, target: e.target.value })} /></Field>
        <Field label="For"><select className="select" value={t.user_id} onChange={(e) => setT({ ...t, user_id: e.target.value })}><option value="">The whole company</option>{meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></Field>
      </div>
      <div><button type="button" className="btn btn-sm btn-primary" disabled={!t.target} onClick={() => save(toast, api.sales.post('/targets', { ...t, target: Number(t.target), scope: t.user_id ? 'USER' : 'COMPANY', user_id: t.user_id ? Number(t.user_id) : null }), 'Target set; see Reports → Targets').catch(() => {})}>Save target</button></div>
    </div>
  );
}

function Audit() {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  useEffect(() => { const t = setTimeout(() => api.sales.get('/audit', { q: q || undefined }).then((r) => setList(r.events)).catch(() => setList([])), 300); return () => clearTimeout(t); }, [q]);
  return (
    <div className="stack-sm">
      <input className="input" style={{ maxWidth: 300 }} placeholder="Search actions and summaries" aria-label="Search audit" value={q} onChange={(e) => setQ(e.target.value)} />
      {!list ? <Spinner /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Summary</th><th>Why</th></tr></thead>
        <tbody>{list.map((e) => <tr key={e.id}><td>{when(e.created_at)}</td><td>{e.actor_name || 'system'}</td><td>{e.action.toLowerCase().replace(/_/g, ' ')}</td><td className="small">{e.entity_type ? `${e.entity_type.toLowerCase()} ${e.entity_id ?? ''}` : ''}</td><td className="small">{e.summary}</td><td className="small">{e.reason}</td></tr>)}</tbody></table></div>}
    </div>
  );
}

// ---------------------------------------------------------------- imports

export function Imports({ meta }) {
  const toast = useToast();
  const [jobs, setJobs] = useState(null);
  const [entity, setEntity] = useState('LEADS');
  const [job, setJob] = useState(null);
  const [mapping, setMapping] = useState({});
  const [options, setOptions] = useState({ duplicate_strategy: 'SKIP', default_owner_id: '', source_id: '' });
  const [upload, setUpload] = useState(null);
  const [detail, setDetail] = useState(null);
  const load = useCallback(() => api.sales.get('/imports').then(setJobs).catch(() => setJobs({ jobs: [], fields: {} })), []);
  useEffect(() => { load(); }, [load]);
  // a running import is followed until it finishes
  useEffect(() => {
    if (!detail || detail.job.status !== 'RUNNING') return undefined;
    const t = setInterval(() => api.sales.get(`/imports/${detail.job.id}`).then((d) => { setDetail(d); if (d.job.status !== 'RUNNING') load(); }).catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [detail, load]);
  const pick = async (file) => {
    if (!file) return;
    try {
      const r = await api.sales.send('/imports', file, file.type || 'application/octet-stream', { entity, filename: file.name });
      setUpload(r); setJob(r.job); setMapping(r.job.mapping); setDetail(null);
    } catch (err) { toast.error(err); }
  };
  const validate = async () => {
    try {
      await api.sales.post(`/imports/${job.id}/validate`, { mapping, options: { duplicate_strategy: options.duplicate_strategy, default_owner_id: options.default_owner_id ? Number(options.default_owner_id) : null, source_id: options.source_id ? Number(options.source_id) : null } });
      setDetail(await api.sales.get(`/imports/${job.id}`));
    } catch (err) { toast.error(err); }
  };
  const run = async () => { try { await api.sales.post(`/imports/${job.id}/run`); setDetail(await api.sales.get(`/imports/${job.id}`)); toast.success('Importing in the background'); } catch (err) { toast.error(err); } };
  const fields = jobs?.fields?.[entity] || [];
  const counts = detail?.job.counts || {};
  return (
    <div className="stack">
      <div className="card card-pad stack-sm">
        <h3>Import leads or organizations</h3>
        <div className="row wrap" style={{ gap: 6 }}>
          {[['LEADS', 'Leads'], ['ACCOUNTS', 'Organizations']].map(([k, l]) => <button key={k} type="button" className={`kind-chip${entity === k ? ' is-active' : ''}`} onClick={() => { setEntity(k); setJob(null); setDetail(null); }}>{l}</button>)}
          <button type="button" className="btn btn-sm" onClick={() => downloadFile(api.sales.url('/imports/template', { entity }), `taskflow-${entity.toLowerCase()}-template.xlsx`).catch(toast.error)}><Icon name="download" size={13} /> Template with examples</button>
        </div>
        <div className="small muted">Excel (.xlsx) or CSV, up to 20,000 rows. Format phone and ID columns as Text in Excel so leading zeros survive. Retailers, FPOs and individuals in the file go to the TeleCRM queue. Nothing is imported until you check the preview and press Import.</div>
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Choose a file" onChange={(e) => pick(e.target.files[0])} />
      </div>
      {job && !detail && (
        <div className="card card-pad stack-sm">
          <h3>Match the columns ({job.total_rows} rows in {job.filename})</h3>
          {upload?.warnings?.map((w) => <div key={w} className="mkt-callout is-warning small">{w}</div>)}
          <div className="grid-3">{fields.map((f) => (
            <Field key={f} label={f.replace(/_/g, ' ')}><select className="select" value={mapping[f] || ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })}><option value="">Not in the file</option>{job.header.map((h) => <option key={h} value={h}>{h}</option>)}</select></Field>
          ))}</div>
          <div className="grid-3">
            <Field label="Already in TaskFlow"><select className="select" value={options.duplicate_strategy} onChange={(e) => setOptions({ ...options, duplicate_strategy: e.target.value })}><option value="SKIP">Skip it (listed in the summary)</option><option value="UPDATE">Fill in what the existing one is missing</option><option value="CREATE">Add anyway when only email or phone matches</option></select></Field>
            <Field label="Owner when the file has none"><select className="select" value={options.default_owner_id} onChange={(e) => setOptions({ ...options, default_owner_id: e.target.value })}><option value="">The assignment rules</option>{meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></Field>
            <Field label="Source when the file has none"><select className="select" value={options.source_id} onChange={(e) => setOptions({ ...options, source_id: e.target.value })}><option value="">Leave blank</option>{meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          </div>
          <div><button type="button" className="btn btn-primary btn-sm" onClick={validate}>Check the rows</button></div>
        </div>
      )}
      {detail && (
        <div className="card card-pad stack-sm">
          <div className="row-between wrap"><h3>Import #{detail.job.id} · {detail.job.status.toLowerCase()}</h3>
            <div className="row" style={{ gap: 6 }}>
              {detail.job.status === 'VALIDATED' && <button type="button" className="btn btn-sm btn-primary" disabled={!counts.valid && !counts.routed && !(counts.duplicate && detail.job.options?.duplicate_strategy === 'UPDATE')} onClick={run}>Import {counts.valid + counts.routed} row(s)</button>}
              <button type="button" className="btn btn-sm" onClick={() => downloadFile(api.sales.url(`/imports/${detail.job.id}/corrections`), `import-${detail.job.id}-corrections.xlsx`).catch(toast.error)}>Corrections file</button>
              {detail.job.status === 'DONE' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => window.confirm('Undo this import? Records nobody has worked on since are archived (not deleted); anything worked on is kept and listed.') && api.sales.post(`/imports/${detail.job.id}/undo`).then((r) => { toast.success(`Undone: ${r.summary.archived} archived, ${r.summary.restored} restored, ${r.summary.kept} kept`); load(); api.sales.get(`/imports/${detail.job.id}`).then(setDetail); }).catch(toast.error)}>Undo</button>}
            </div>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <Badge tone="good">{counts.valid ?? 0} valid</Badge><Badge tone="critical">{counts.invalid ?? 0} with problems</Badge><Badge tone="warning">{counts.duplicate ?? 0} already there</Badge><Badge tone="warning">{counts.routed ?? 0} for TeleCRM</Badge>
            {counts.result && Object.entries(counts.result).map(([k, n]) => <Badge key={k}>{n} {k}</Badge>)}
            {detail.job.status === 'RUNNING' && <span className="small muted">{detail.job.processed_rows} of {detail.job.total_rows} applied…</span>}
          </div>
          <div className="table-scroll"><table className="data-table"><thead><tr><th>Row</th><th>Status</th><th>Problems and notes</th><th>Name</th></tr></thead>
            <tbody>{detail.rows.map((r) => <tr key={r.row_no} className={r.status === 'INVALID' ? 'is-late' : ''}><td>{r.row_no}</td><td>{r.status.toLowerCase()}</td><td className="small" style={{ whiteSpace: 'normal' }}>{[...r.errors, ...r.warnings].join('; ')}</td><td className="small">{r.data?.organization_name || r.data?.name || r.data?.contact_name}</td></tr>)}</tbody></table></div>
        </div>
      )}
      <div className="card">
        <div className="card-head"><h3>Earlier imports</h3></div>
        <div className="card-pad stack-sm">
          {!jobs ? <Spinner /> : jobs.jobs.length === 0 ? <div className="empty small">None yet.</div> : jobs.jobs.map((j) => (
            <button key={j.id} type="button" className="link-row small" onClick={() => api.sales.get(`/imports/${j.id}`).then((d) => { setJob(d.job); setDetail(d); }).catch(toast.error)}>
              <strong>#{j.id}</strong><span className="grow truncate">{j.entity.toLowerCase()} · {j.filename} · {j.created_by_name}</span><Badge>{j.status.toLowerCase()}</Badge><span className="muted">{dayOf(j.created_at)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the settings area

export function SalesSettings({ meta, onSaved, initial }) {
  const [section, setSection] = useState(initial || 'setup');
  const { can } = useAuth();
  const allowed = SECTIONS.filter(([k]) => (k === 'audit' ? can('crm.audit') : k === 'automation' ? can('crm.automation') || can('crm.settings') : k === 'remediation' ? can('crm.routing') : can('crm.settings')));
  if (!allowed.length) return <EmptyState title="Settings are for administrators">Ask an administrator to change how the sales CRM works.</EmptyState>;
  const current = allowed.some(([k]) => k === section) ? section : allowed[0][0];
  return (
    <div className="sales-settings">
      <nav className="sales-settings-nav" aria-label="Sales CRM settings">
        {allowed.map(([k, l]) => <button key={k} type="button" aria-current={current === k ? 'page' : undefined} className={`sales-settings-link${current === k ? ' is-active' : ''}`} onClick={() => setSection(k)}>{l}</button>)}
      </nav>
      <div className="grow" style={{ minWidth: 0 }}>
        {current === 'setup' && <Setup meta={meta} goTo={setSection} />}
        {current === 'general' && <General meta={meta} onSaved={onSaved} />}
        {current === 'pipelines' && <Pipelines />}
        {current === 'assignment' && <Assignment meta={meta} onSaved={onSaved} />}
        {current === 'scoring' && <Scoring />}
        {current === 'sources' && <Sources meta={meta} onSaved={onSaved} />}
        {current === 'capture' && <Capture meta={meta} />}
        {current === 'catalogue' && <Catalogue meta={meta} />}
        {current === 'integrations' && <Integrations />}
        {current === 'automation' && <Automation />}
        {current === 'remediation' && <Remediation meta={meta} />}
        {current === 'targets' && <Targets meta={meta} />}
        {current === 'audit' && <Audit />}
      </div>
    </div>
  );
}
