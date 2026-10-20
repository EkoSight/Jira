import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { EmptyState, Field, Icon, Modal, Spinner } from '../ui.jsx';
import { OPERATOR_WORDS, emptyRules, needsValue, newCondition, personName } from '../../lib/marketing.js';
import { AudienceReport } from './MarketingReports.jsx';
import { forgetMarketingMeta, MembershipBadge } from './parts.jsx';

const KIND_WORDS = { CUSTOMERS: 'Customers', LEADS: 'Leads', FPOS: 'FPOs', STUDENTS: 'Students', FARMERS: 'Farmers', PARTNERS: 'Partners', DEALERS: 'Dealers', CUSTOM: 'Other' };

function AudienceDialog({ audience, meta, onClose, onSaved }) {
  const toast = useToast();
  const { can } = useAuth();
  const [a, setA] = useState(audience || { name: '', kind: 'CUSTOM', description: '', purpose: '', double_opt_in: true, color: '#2a78d6', crm_sync: null, crm_sync_status: 'SUBSCRIBED' });
  const set = (k, v) => setA((x) => ({ ...x, [k]: v }));
  const rule = a.crm_sync || {};
  const setRule = (patch) => {
    const next = { ...rule, ...patch };
    const empty = !next.account_types?.length && !next.account_tags?.length && !next.segment_ids?.length;
    set('crm_sync', empty ? null : next);
  };
  const save = async () => {
    try {
      const body = { name: a.name, kind: a.kind, description: a.description, purpose: a.purpose, double_opt_in: a.double_opt_in, color: a.color,
        from_name: a.from_name || null, from_email: a.from_email || null, reply_to: a.reply_to || null };
      if (can('marketing.settings')) Object.assign(body, { crm_sync: a.crm_sync, crm_sync_status: a.crm_sync_status });
      const r = audience ? await api.mkt.patch(`/audiences/${audience.id}`, body) : await api.mkt.post('/audiences', body);
      forgetMarketingMeta();
      toast.success('Saved');
      onSaved(r.audience);
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title={audience ? `Edit ${audience.name}` : 'New audience'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!a.name?.trim()} onClick={save}>Save</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Name"><input className="input" value={a.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Kind">
            <select className="select" value={a.kind} onChange={(e) => set('kind', e.target.value)}>{Object.entries(KIND_WORDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
        </div>
        <Field label="What they get" hint="Shown on signup forms and the preference page"><input className="input" value={a.purpose || ''} onChange={(e) => set('purpose', e.target.value)} /></Field>
        <Field label="Note for the team"><input className="input" value={a.description || ''} onChange={(e) => set('description', e.target.value)} /></Field>
        <label className="row small"><input type="checkbox" checked={Boolean(a.double_opt_in)} onChange={(e) => set('double_opt_in', e.target.checked)} /> People joining through a form confirm by email first (double opt-in)</label>
        <div className="grid-3">
          <Field label="Sender name"><input className="input" value={a.from_name || ''} placeholder="Default" onChange={(e) => set('from_name', e.target.value)} /></Field>
          <Field label="Sender address"><input className="input" value={a.from_email || ''} placeholder="Default" onChange={(e) => set('from_email', e.target.value)} /></Field>
          <Field label="Colour"><input className="input" type="color" style={{ padding: 2 }} value={a.color || '#2a78d6'} onChange={(e) => set('color', e.target.value)} /></Field>
        </div>
        <fieldset disabled={!can('marketing.settings')} className="mkt-subcard stack-sm mkt-fieldset">
          <strong>Kept in step with the pipeline</strong>
          <div className="small muted">People at organizations matching any of these join automatically (when the pipeline sync is on in Settings), and leave — archived, not unsubscribed — when the organization stops matching. Nobody who unsubscribed is put back.{!can('marketing.settings') && ' Only someone with Settings access can change this.'}</div>
          <div className="row wrap">
            {['LEAD', 'CUSTOMER', 'PARTNER'].map((t) => (
              <label key={t} className="row small mkt-chip-check"><input type="checkbox" checked={(rule.account_types || []).includes(t)}
                onChange={(e) => setRule({ account_types: e.target.checked ? [...(rule.account_types || []), t] : (rule.account_types || []).filter((x) => x !== t) })} /> {t.toLowerCase()}s</label>
            ))}
          </div>
          <Field label="Or organizations tagged" hint="Comma-separated, e.g. fpo, dealer">
            <input className="input" value={(rule.account_tags || []).join(', ')} onChange={(e) => setRule({ account_tags: e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) })} />
          </Field>
          {meta.crm_segments?.length > 0 && (
            <Field label="Or in organization segments">
              <div className="row wrap">
                {meta.crm_segments.map((sg) => (
                  <label key={sg.id} className="row small mkt-chip-check"><input type="checkbox" checked={(rule.segment_ids || []).includes(sg.id)}
                    onChange={(e) => setRule({ segment_ids: e.target.checked ? [...(rule.segment_ids || []), sg.id] : (rule.segment_ids || []).filter((x) => x !== sg.id) })} /> {sg.name}</label>
                ))}
              </div>
            </Field>
          )}
          {a.crm_sync && (
            <Field label="They join as">
              <select className="select" value={a.crm_sync_status} onChange={(e) => set('crm_sync_status', e.target.value)}>
                <option value="SUBSCRIBED">Subscribed (an existing business relationship)</option><option value="PENDING">Waiting to confirm</option>
              </select>
            </Field>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}

function AudienceDetail({ audience, onClose, onEdit }) {
  const [data, setData] = useState(null);
  const [members, setMembers] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => { api.mkt.get(`/audiences/${audience.id}`).then(setData).catch(() => {}); }, [audience.id]);
  useEffect(() => {
    const t = setTimeout(() => api.mkt.get(`/audiences/${audience.id}/members`, { search, status }).then((r) => setMembers(r.members)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [audience.id, search, status]);
  return (
    <Modal size="lg" title={audience.name} onClose={onClose} footer={onEdit && <button type="button" className="btn" onClick={onEdit}><Icon name="edit" size={13} /> Edit audience</button>}>
      <div className="stack">
        {audience.purpose && <div className="small dim">{audience.purpose}</div>}
        {!data ? <Spinner /> : <AudienceReport report={data.report} />}
        <div className="card">
          <div className="card-head">
            <h3>Members</h3>
            <div className="row">
              <input className="input" style={{ width: 180, height: 30 }} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select className="select select-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any status</option><option value="SUBSCRIBED">Subscribed</option><option value="PENDING">Waiting to confirm</option>
                <option value="UNSUBSCRIBED">Unsubscribed</option><option value="CLEANED">Bounced</option><option value="ARCHIVED">Removed</option>
              </select>
            </div>
          </div>
          {!members ? <Spinner /> : members.length === 0 ? <div className="empty small">Nobody matches.</div> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Person</th><th>Status</th><th>How</th><th className="num">Engagement</th></tr></thead>
                <tbody>{members.map((m) => (
                  <tr key={m.id}><td>{personName(m)}<div className="small muted">{m.email}</div></td><td><MembershipBadge status={m.status} /></td>
                    <td className="small">{m.synced ? 'From the pipeline' : m.source?.toLowerCase()}</td><td className="num">{m.engagement_score}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- segment builder

function ConditionRow({ cond, meta, campaigns, onChange, onRemove }) {
  const field = meta.segment_fields.find((f) => f.key === cond.field) || meta.segment_fields[0];
  const ops = meta.operators[field.type] || [];
  const valueInput = () => {
    if (!needsValue(cond.op)) return null;
    switch (field.type) {
      case 'select': return <select className="select" value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value })}>{field.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
      case 'audience': return <select className="select" value={cond.value || ''} onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}><option value="">Choose…</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>;
      case 'topic': return <select className="select" value={cond.value || ''} onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}><option value="">Choose…</option>{meta.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>;
      case 'campaign': return <select className="select" value={cond.value || ''} onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}><option value="">Choose…</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>;
      case 'crm_segment': return <select className="select" value={cond.value || ''} onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}><option value="">Choose…</option>{(meta.crm_segments || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>;
      case 'user': return <select className="select" value={cond.value || ''} onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}><option value="">Choose…</option>{meta.users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>;
      case 'number': return <input className="input" type="number" value={cond.value} onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })} />;
      case 'date': return ['within_days', 'not_within_days'].includes(cond.op)
        ? <input className="input" type="number" min={0} value={cond.value} onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })} />
        : <input className="input" type="date" value={cond.value || ''} onChange={(e) => onChange({ ...cond, value: e.target.value })} />;
      default: return <input className="input" value={cond.value ?? ''} onChange={(e) => onChange({ ...cond, value: e.target.value })} />;
    }
  };
  return (
    <div className="mkt-rule">
      <select className="select" value={cond.field} onChange={(e) => onChange(newCondition(meta.segment_fields.find((f) => f.key === e.target.value), meta.operators))}>
        {[...new Set(meta.segment_fields.map((f) => f.group))].map((g) => (
          <optgroup key={g} label={g}>{meta.segment_fields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>
        ))}
      </select>
      {field.type === 'custom' && (
        <select className="select" value={cond.key || ''} onChange={(e) => onChange({ ...cond, key: e.target.value })}>
          <option value="">Which field…</option>{meta.custom_fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      )}
      <select className="select" value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value })}>{ops.map((o) => <option key={o} value={o}>{OPERATOR_WORDS[o] || o}</option>)}</select>
      {valueInput()}
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove condition" onClick={onRemove}><Icon name="close" size={14} /></button>
    </div>
  );
}

function RuleGroup({ rules, meta, campaigns, onChange, depth = 0 }) {
  const add = () => onChange({ ...rules, conditions: [...rules.conditions, newCondition(meta.segment_fields.find((f) => f.key === 'tag'), meta.operators)] });
  return (
    <div className={`mkt-rule-group${depth ? ' is-nested' : ''}`}>
      <div className="row small">
        Match
        <select className="select select-sm" value={rules.match} onChange={(e) => onChange({ ...rules, match: e.target.value })}><option value="all">all</option><option value="any">any</option></select>
        of these
      </div>
      {rules.conditions.map((c, i) => (c.conditions ? (
        <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
          <RuleGroup rules={c} meta={meta} campaigns={campaigns} depth={depth + 1} onChange={(nc) => onChange({ ...rules, conditions: rules.conditions.map((x, j) => (j === i ? nc : x)) })} />
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Remove group" onClick={() => onChange({ ...rules, conditions: rules.conditions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
        </div>
      ) : (
        <ConditionRow key={i} cond={c} meta={meta} campaigns={campaigns}
          onChange={(nc) => onChange({ ...rules, conditions: rules.conditions.map((x, j) => (j === i ? nc : x)) })}
          onRemove={() => onChange({ ...rules, conditions: rules.conditions.filter((_, j) => j !== i) })} />
      )))}
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={add}><Icon name="plus" size={13} /> Condition</button>
        {depth < 2 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...rules, conditions: [...rules.conditions, { match: 'any', conditions: [] }] })}>Group</button>}
      </div>
    </div>
  );
}

function SegmentDialog({ segment, meta, onClose, onSaved }) {
  const toast = useToast();
  const [s, setS] = useState(segment || { name: '', description: '', audience_id: null, rules: emptyRules() });
  const [preview, setPreview] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  useEffect(() => { api.mkt.get('/campaigns').then((r) => setCampaigns(r.campaigns)).catch(() => {}); }, []);
  useEffect(() => {
    const t = setTimeout(() => api.mkt.post('/segments/preview', { rules: s.rules, audience_id: s.audience_id }).then(setPreview).catch((err) => setPreview({ error: err.message })), 300);
    return () => clearTimeout(t);
  }, [s.rules, s.audience_id]);
  const save = async () => {
    try {
      const r = segment ? await api.mkt.patch(`/segments/${segment.id}`, s) : await api.mkt.post('/segments', s);
      toast.success('Segment saved');
      onSaved(r.segment);
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal size="lg" title={segment ? 'Edit segment' : 'New segment'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!s.name.trim()} onClick={save}>Save segment</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Name"><input className="input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
          <Field label="Within">
            <select className="select" value={s.audience_id || ''} onChange={(e) => setS({ ...s, audience_id: Number(e.target.value) || null })}>
              <option value="">All contacts</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name} subscribers</option>)}
            </select>
          </Field>
        </div>
        <RuleGroup rules={s.rules} meta={meta} campaigns={campaigns} onChange={(rules) => setS({ ...s, rules })} />
        <div className="mkt-subcard">
          {!preview ? <Spinner label="Counting" /> : preview.error ? <div className="field-error">{preview.error}</div> : (
            <div className="stack-sm">
              <strong>{preview.count} contact{preview.count === 1 ? '' : 's'} match now</strong>
              <div className="small muted">Worked out again whenever it is used, so it is always current.</div>
              {preview.sample.slice(0, 8).map((c) => <div key={c.id} className="small">{personName(c)} <span className="muted">{c.email}</span></div>)}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function MarketingAudiences({ meta, onMetaChanged }) {
  const { can } = useAuth();
  const toast = useToast();
  const [audiences, setAudiences] = useState(meta.audiences);
  const [segments, setSegments] = useState(null);
  const [topics, setTopics] = useState(meta.topics);
  const [fields, setFields] = useState(meta.custom_fields);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [segmentEdit, setSegmentEdit] = useState(null);
  const [newField, setNewField] = useState({ key: '', label: '', type: 'TEXT', options: '' });
  const [newTopic, setNewTopic] = useState({ name: '', name_hi: '' });

  const load = useCallback(() => {
    api.mkt.get('/audiences').then((r) => setAudiences(r.audiences)).catch(() => {});
    api.mkt.get('/segments').then((r) => setSegments(r.segments)).catch(() => {});
    api.mkt.get('/topics').then((r) => setTopics(r.topics)).catch(() => {});
    api.mkt.get('/fields').then((r) => setFields(r.fields)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const changed = () => { forgetMarketingMeta(); onMetaChanged?.(); load(); };

  return (
    <div className="stack">
      <div className="row-between">
        <div className="small muted">A contact can be on any number of audiences. Each audience keeps its own subscription status.</div>
        {can('marketing.manage') && <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={13} /> New audience</button>}
      </div>
      <div className="mkt-audience-grid">
        {audiences.map((a) => (
          <button key={a.id} type="button" className="card card-pad mkt-audience" onClick={() => setViewing(a)}>
            <div className="row"><span className="chip-dot" style={{ background: a.color || 'var(--axis)' }} /><strong className="grow truncate">{a.name}</strong>{a.crm_sync && <span className="badge" title="Kept in step with the pipeline">pipeline</span>}</div>
            <div className="mkt-audience-count tnum">{a.subscribed}</div>
            <div className="small muted">subscribed{a.pending ? ` · ${a.pending} waiting to confirm` : ''}{a.joined_30d ? ` · ${a.joined_30d} new in 30 days` : ''}</div>
            <div className="small dim mkt-audience-purpose">{a.purpose}</div>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-head"><h3>Segments</h3>{can('marketing.manage') && <button type="button" className="btn btn-sm" onClick={() => setSegmentEdit('new')}><Icon name="plus" size={13} /> New segment</button>}</div>
        {!segments ? <Spinner /> : segments.length === 0 ? <div className="empty small">A segment picks people by rules — tags, fields, location, engagement, campaign activity, or their organization in the pipeline. Use one to send a campaign to part of an audience.</div> : (
          <div className="table-wrap"><table className="data"><thead><tr><th>Segment</th><th>Within</th><th>Made by</th><th /></tr></thead>
            <tbody>{segments.map((s) => (
              <tr key={s.id}><td>{s.name}</td><td>{s.audience_name || 'All contacts'}</td><td className="small">{s.created_by_name}</td>
                <td>{can('marketing.manage') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSegmentEdit(s)}>Edit</button>}</td></tr>
            ))}</tbody></table></div>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>Subscription topics</h3></div>
          <div className="card-pad stack-sm">
            <div className="small muted">People choose these on their preference page; a campaign about a topic skips anyone who opted out of it.</div>
            {topics.map((t) => <div key={t.id} className="row-between small"><span>{t.name} {t.name_hi && <span className="muted">· {t.name_hi}</span>}</span><span className="muted">{t.opted_out} opted out</span></div>)}
            {can('marketing.manage') && (
              <div className="row">
                <input className="input" placeholder="New topic" value={newTopic.name} onChange={(e) => setNewTopic({ ...newTopic, name: e.target.value })} />
                <input className="input" placeholder="हिन्दी नाम" dir="auto" value={newTopic.name_hi} onChange={(e) => setNewTopic({ ...newTopic, name_hi: e.target.value })} />
                <button type="button" className="btn btn-sm" disabled={!newTopic.name.trim()} onClick={async () => { try { await api.mkt.post('/topics', newTopic); setNewTopic({ name: '', name_hi: '' }); changed(); } catch (err) { toast.error(err); } }}>Add</button>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Custom fields</h3></div>
          <div className="card-pad stack-sm">
            <div className="small muted">Extra details on every contact, for personalization ({'{{custom.key}}'}) and segments.</div>
            {fields.map((f) => <div key={f.id} className="row-between small"><span>{f.label} <span className="muted">· {f.key}</span></span><span className="muted">{f.type.toLowerCase()}</span></div>)}
            {can('marketing.manage') && (
              <div className="stack-sm">
                <div className="row">
                  <input className="input" placeholder="Label" value={newField.label} onChange={(e) => setNewField({ ...newField, label: e.target.value, key: newField.key || '' })} />
                  <input className="input" placeholder="key" value={newField.key} onChange={(e) => setNewField({ ...newField, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
                  <select className="select" style={{ width: 110 }} value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value })}>
                    {['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN'].map((t) => <option key={t} value={t}>{t.toLowerCase()}</option>)}
                  </select>
                </div>
                {newField.type === 'SELECT' && <input className="input" placeholder="Choices, comma-separated" value={newField.options} onChange={(e) => setNewField({ ...newField, options: e.target.value })} />}
                <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} disabled={!newField.label.trim() || !/^[a-z][a-z0-9_]*$/.test(newField.key)}
                  onClick={async () => { try { await api.mkt.post('/fields', { ...newField, options: newField.options.split(',').map((o) => o.trim()).filter(Boolean) }); setNewField({ key: '', label: '', type: 'TEXT', options: '' }); changed(); } catch (err) { toast.error(err); } }}>Add field</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {editing && <AudienceDialog audience={editing === 'new' ? null : editing} meta={meta} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); changed(); }} />}
      {viewing && <AudienceDetail audience={viewing} onClose={() => setViewing(null)} onEdit={can('marketing.manage') ? () => { setEditing(viewing); setViewing(null); } : null} />}
      {segmentEdit && <SegmentDialog segment={segmentEdit === 'new' ? null : segmentEdit} meta={meta} onClose={() => setSegmentEdit(null)} onSaved={() => { setSegmentEdit(null); load(); }} />}
      {audiences.length === 0 && <EmptyState title="No audiences" />}
    </div>
  );
}
