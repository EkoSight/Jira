import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import EmailBuilder, { cleanDesign } from '../components/marketing/EmailBuilder.jsx';
import { WorkflowBadge, useMarketingMeta } from '../components/marketing/parts.jsx';
import { formatDate } from '../lib/format.js';
import {
  ACTION_LABEL, CONDITION_LABEL, NODE_LABEL, TASKFLOW_EVENT_LABEL, TRIGGER_LABEL, UNIT_LABEL, insertNode, nodeSummary, pathTree,
  personName, removeNode, triggerSummary,
} from '../lib/marketing.js';

const NODE_ICON = { email: 'mail', delay: 'clock', condition: 'filter', action: 'zap', exit: 'flag' };

function AddStep({ at, onAdd, disabled }) {
  const [open, setOpen] = useState(false);
  if (disabled) return <div className="mkt-flow-line" aria-hidden="true" />;
  return (
    <div className="mkt-flow-add">
      <div className="mkt-flow-line" aria-hidden="true" />
      <button type="button" className="mkt-flow-plus" aria-label="Add a step here" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="plus" size={13} /></button>
      {open && (
        <div className="mkt-flow-menu card">
          {Object.entries(NODE_LABEL).map(([type, label]) => (
            <button key={type} type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); onAdd(at, type); }}>
              <Icon name={NODE_ICON[type]} size={13} /> {label}
            </button>
          ))}
        </div>
      )}
      <div className="mkt-flow-line" aria-hidden="true" />
    </div>
  );
}

function StepCard({ id, node, selected, onSelect, stats }) {
  return (
    <button type="button" className={`mkt-step mkt-step-${node.type}${selected ? ' is-selected' : ''}`} onClick={() => onSelect(id)}>
      <span className="mkt-step-icon"><Icon name={NODE_ICON[node.type]} size={14} /></span>
      <span className="grow">
        <span className="mkt-step-kind">{NODE_LABEL[node.type]}</span>
        <span className="mkt-step-text">{nodeSummary(node)}</span>
        {node.type === 'email' && stats && <span className="small muted">{stats.sent} sent · {stats.opened} opened · {stats.clicked} clicked</span>}
      </span>
    </button>
  );
}

function PathView({ items, parent, branch, selected, onSelect, onAdd, locked, stats }) {
  const last = items[items.length - 1];
  return (
    <div className="mkt-path">
      <AddStep at={{ parent, branch }} onAdd={onAdd} disabled={locked} />
      {items.map((item, i) => (
        <div key={item.id} className="mkt-path-item">
          <StepCard id={item.id} node={item.node} selected={selected === item.id} onSelect={onSelect} stats={stats?.[item.id]} />
          {item.node.type === 'condition' ? (
            <div className="mkt-branches">
              {['yes', 'no'].map((b) => (
                <div key={b} className={`mkt-branch mkt-branch-${b}`}>
                  <div className="mkt-branch-label">{b === 'yes' ? 'Yes' : 'No'}</div>
                  <PathView items={item[b]} parent={item.id} branch={b} selected={selected} onSelect={onSelect} onAdd={onAdd} locked={locked} stats={stats} />
                </div>
              ))}
            </div>
          ) : item.node.type !== 'exit' && i < items.length - 1 ? (
            <AddStep at={{ parent: item.id, branch: 'next' }} onAdd={onAdd} disabled={locked} />
          ) : null}
        </div>
      ))}
      {last && !['condition', 'exit'].includes(last.node.type) && <AddStep at={{ parent: last.id, branch: 'next' }} onAdd={onAdd} disabled={locked} />}
      {(!last || !['condition'].includes(last.node.type)) && <div className="mkt-flow-end small muted">{items.length ? 'Done' : 'Nothing yet'}</div>}
    </div>
  );
}

function TriggerEditor({ trigger, onChange, meta, forms, festivals, campaigns, locked }) {
  const t = trigger || { type: 'MANUAL' };
  const set = (patch) => onChange({ ...t, ...patch });
  const dateFields = (meta.custom_fields || []).filter((f) => f.type === 'DATE');
  return (
    <fieldset disabled={locked} className="stack mkt-fieldset">
      <Field label="Starts when">
        <select className="select" value={t.type} onChange={(e) => onChange({ type: e.target.value })}>
          {meta.triggers.map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
        </select>
      </Field>
      {t.type === 'AUDIENCE_JOINED' && (
        <Field label="Audience">
          <select className="select" value={t.audience_id || ''} onChange={(e) => set({ audience_id: Number(e.target.value) || null })}>
            <option value="">Choose…</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      {t.type === 'TAG_ADDED' && <Field label="Tag"><input className="input" value={t.tag || ''} onChange={(e) => set({ tag: e.target.value.toLowerCase() })} /></Field>}
      {t.type === 'FORM_SUBMITTED' && (
        <Field label="Form">
          <select className="select" value={t.form_id || ''} onChange={(e) => set({ form_id: Number(e.target.value) || null })}>
            <option value="">Choose…</option>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
      )}
      {t.type === 'FESTIVAL' && (
        <>
          <Field label="Festivals and seasons" hint="Leave all unticked for every confirmed date. Only dates an admin has confirmed ever send.">
            <div className="stack-sm">
              {festivals.map((f) => (
                <label key={f.id} className="row small">
                  <input type="checkbox" checked={(t.festival_ids || []).includes(f.id)}
                    onChange={(e) => set({ festival_ids: e.target.checked ? [...(t.festival_ids || []), f.id] : (t.festival_ids || []).filter((x) => x !== f.id) })} />
                  {f.name} — {formatDate(f.date)} {!f.is_confirmed && <span className="badge badge-warning">date not confirmed</span>}
                </label>
              ))}
            </div>
          </Field>
          <div className="grid-2">
            <Field label="Days before"><input className="input" type="number" min={0} max={60} value={t.days_before ?? 0} onChange={(e) => set({ days_before: Number(e.target.value) })} /></Field>
            <Field label="From (hour, India time)"><input className="input" type="number" min={0} max={23} value={t.send_hour ?? 9} onChange={(e) => set({ send_hour: Number(e.target.value) })} /></Field>
          </div>
        </>
      )}
      {t.type === 'DATE_FIELD' && (
        <div className="grid-3">
          <Field label="Date field">
            <select className="select" value={t.field || ''} onChange={(e) => set({ field: e.target.value })}>
              <option value="">Choose…</option>{dateFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </Field>
          <Field label="Days before"><input className="input" type="number" min={0} max={60} value={t.days_before ?? 0} onChange={(e) => set({ days_before: Number(e.target.value) })} /></Field>
          <Field label="From (hour)"><input className="input" type="number" min={0} max={23} value={t.send_hour ?? 9} onChange={(e) => set({ send_hour: Number(e.target.value) })} /></Field>
        </div>
      )}
      {t.type === 'CAMPAIGN_ACTIVITY' && (
        <div className="grid-3">
          <Field label="Campaign">
            <select className="select" value={t.campaign_id || ''} onChange={(e) => set({ campaign_id: Number(e.target.value) || null })}>
              <option value="">Choose…</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="When they">
            <select className="select" value={t.activity || ''} onChange={(e) => set({ activity: e.target.value })}>
              <option value="">Choose…</option><option value="CLICKED">click it</option><option value="OPENED">open it</option><option value="NOT_OPENED">do not open it</option>
            </select>
          </Field>
          {t.activity === 'NOT_OPENED' && <Field label="Days to wait"><input className="input" type="number" min={1} max={30} value={t.after_days ?? 3} onChange={(e) => set({ after_days: Number(e.target.value) })} /></Field>}
        </div>
      )}
      {t.type === 'INACTIVE' && <Field label="No opens or clicks for (days)" hint="At least 14"><input className="input" type="number" min={14} max={720} value={t.days ?? 90} onChange={(e) => set({ days: Number(e.target.value) })} /></Field>}
      {t.type === 'TASKFLOW_EVENT' && (
        <div className="grid-2">
          <Field label="In TaskFlow">
            <select className="select" value={t.event || ''} onChange={(e) => set({ event: e.target.value })}>
              <option value="">Choose…</option>{meta.taskflow_events.map((k) => <option key={k} value={k}>{TASKFLOW_EVENT_LABEL[k]}</option>)}
            </select>
          </Field>
          {t.event === 'DEAL_STAGE' && <Field label="Stage name (optional)"><input className="input" value={t.stage || ''} onChange={(e) => set({ stage: e.target.value })} placeholder="Any stage" /></Field>}
        </div>
      )}
      <div className="small muted">{triggerSummary(t, { audiences: meta.audiences, forms, festivals })}. Only what happens after it is switched on starts it.</div>
    </fieldset>
  );
}

function StepEditor({ id, node, onChange, onRemove, meta, users, locked }) {
  const toast = useToast();
  const { user } = useAuth();
  const [editingEmail, setEditingEmail] = useState(false);
  const c = node.config || {};
  const set = (patch) => onChange({ ...node, config: { ...c, ...patch } });
  return (
    <div className="stack">
      <div className="row-between"><h3>{NODE_LABEL[node.type]}</h3>{!locked && <button type="button" className="btn btn-danger btn-sm" onClick={onRemove}>Remove step</button>}</div>
      <fieldset disabled={locked} className="stack mkt-fieldset">
        {node.type === 'email' && (
          <>
            <Field label="Subject"><input className="input" value={c.subject || ''} onChange={(e) => set({ subject: e.target.value })} /></Field>
            <Field label="Subject in Hindi"><input className="input" dir="auto" value={c.subject_hi || ''} onChange={(e) => set({ subject_hi: e.target.value })} /></Field>
            <Field label="Preview text"><input className="input" value={c.preheader || ''} onChange={(e) => set({ preheader: e.target.value })} /></Field>
            <div className="row wrap">
              <button type="button" className="btn" onClick={() => setEditingEmail(true)}><Icon name="edit" size={13} /> {locked ? 'View the email' : 'Edit the email'}</button>
              <button type="button" className="btn btn-ghost" disabled={false} onClick={async () => {
                try {
                  const r = await api.mkt.post('/test', { design: c.design, subject: c.subject || '(no subject)', subject_hi: c.subject_hi || null, preheader: c.preheader || null, emails: [user.email] });
                  const m = r.messages[0];
                  if (m?.status === 'SENT') toast.success(`Test sent to ${m.email}`); else toast.error(m?.last_error || m?.skip_reason || 'The test was not sent');
                } catch (err) { toast.error(err); }
              }}><Icon name="send" size={13} /> Test to me</button>
            </div>
          </>
        )}
        {node.type === 'delay' && (
          <div className="grid-2">
            <Field label="Wait"><input className="input" type="number" min={1} value={c.amount || 1} onChange={(e) => set({ amount: Number(e.target.value) })} /></Field>
            <Field label="Unit">
              <select className="select" value={c.unit || 'days'} onChange={(e) => set({ unit: e.target.value })}>
                {Object.entries(UNIT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
          </div>
        )}
        {node.type === 'condition' && (
          <>
            <Field label="If they">
              <select className="select" value={c.kind || ''} onChange={(e) => onChange({ ...node, config: { kind: e.target.value } })}>
                {meta.conditions.map((k) => <option key={k} value={k}>{CONDITION_LABEL[k]}</option>)}
              </select>
            </Field>
            {c.kind === 'tag' && <Field label="Tag"><input className="input" value={c.value || ''} onChange={(e) => set({ value: e.target.value.toLowerCase() })} /></Field>}
            {c.kind === 'engagement_at_least' && <Field label="Score (0–100)"><input className="input" type="number" min={0} max={100} value={c.value ?? 30} onChange={(e) => set({ value: Number(e.target.value) })} /></Field>}
            {c.kind === 'audience' && (
              <Field label="Audience">
                <select className="select" value={c.value || ''} onChange={(e) => set({ value: Number(e.target.value) })}>
                  <option value="">Choose…</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            )}
            {c.kind === 'crm_type' && (
              <Field label="Type">
                <select className="select" value={c.value || 'LEAD'} onChange={(e) => set({ value: e.target.value })}>
                  {[['LEAD', 'Lead'], ['CUSTOMER', 'Customer'], ['PARTNER', 'Partner'], ['NONE', 'Not in the pipeline']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
            )}
            {c.kind === 'field' && (
              <div className="grid-3">
                <Field label="Field">
                  <select className="select" value={c.key || ''} onChange={(e) => set({ key: e.target.value })}>
                    <option value="">Choose…</option>
                    {['city', 'state', 'organization', 'language'].map((k) => <option key={k} value={k}>{k}</option>)}
                    {meta.custom_fields.map((f) => <option key={f.key} value={`custom.${f.key}`}>{f.label}</option>)}
                  </select>
                </Field>
                <Field label="Test">
                  <select className="select" value={c.op || 'is'} onChange={(e) => set({ op: e.target.value })}>
                    <option value="is">is</option><option value="contains">contains</option><option value="empty">is empty</option><option value="not_empty">is filled in</option>
                  </select>
                </Field>
                {!['empty', 'not_empty'].includes(c.op) && <Field label="Value"><input className="input" value={c.value || ''} onChange={(e) => set({ value: e.target.value })} /></Field>}
              </div>
            )}
            <div className="small muted">Checked at this point in their path. Opens are counted only from emails in this automation.</div>
          </>
        )}
        {node.type === 'action' && (
          <>
            <Field label="Do">
              <select className="select" value={c.kind || ''} onChange={(e) => onChange({ ...node, config: { kind: e.target.value } })}>
                {meta.actions.map((k) => <option key={k} value={k}>{ACTION_LABEL[k]}</option>)}
              </select>
            </Field>
            {['add_tag', 'remove_tag'].includes(c.kind) && <Field label="Tag"><input className="input" value={c.value || ''} onChange={(e) => set({ value: e.target.value.toLowerCase() })} /></Field>}
            {['add_to_audience', 'remove_from_audience'].includes(c.kind) && (
              <Field label="Audience" hint={c.kind === 'add_to_audience' ? 'Nobody who unsubscribed or bounced is ever added back' : undefined}>
                <select className="select" value={c.value || ''} onChange={(e) => set({ value: Number(e.target.value) })}>
                  <option value="">Choose…</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            )}
            {c.kind === 'create_task' && (
              <>
                <Field label="Task title" hint="{{name}} becomes the person’s name"><input className="input" value={c.title || ''} placeholder="Call {{name}} about soil testing" onChange={(e) => set({ title: e.target.value })} /></Field>
                <Field label="Details"><textarea className="textarea" rows={2} value={c.detail || ''} onChange={(e) => set({ detail: e.target.value })} /></Field>
                <div className="grid-2">
                  <Field label="Assign to">
                    <select className="select" value={c.assign || 'CONTACT_OWNER'} onChange={(e) => set({ assign: e.target.value })}>
                      <option value="CONTACT_OWNER">Whoever looks after them</option><option value="WORKFLOW_OWNER">The automation’s owner</option>
                      {users.map((u) => <option key={u.id} value={String(u.id)}>{u.full_name}</option>)}
                    </select>
                  </Field>
                  <Field label="Due after (days)"><input className="input" type="number" min={0} max={30} value={c.due_days ?? 2} onChange={(e) => set({ due_days: Number(e.target.value) })} /></Field>
                </div>
              </>
            )}
            {c.kind === 'notify_owner' && <Field label="Message"><input className="input" value={c.title || ''} onChange={(e) => set({ title: e.target.value })} /></Field>}
            {c.kind === 'update_field' && (
              <div className="grid-2">
                <Field label="Field">
                  <select className="select" value={c.key || ''} onChange={(e) => set({ key: e.target.value })}>
                    <option value="">Choose…</option>{meta.custom_fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </Field>
                <Field label="Value"><input className="input" value={c.value || ''} onChange={(e) => set({ value: e.target.value })} /></Field>
              </div>
            )}
            {c.kind === 'set_language' && (
              <Field label="Language">
                <select className="select" value={c.value || 'en'} onChange={(e) => set({ value: e.target.value })}><option value="en">English</option><option value="hi">Hindi</option></select>
              </Field>
            )}
          </>
        )}
        {node.type === 'exit' && <div className="small muted">They leave the automation here.</div>}
      </fieldset>
      <div className="small muted">Step {id}</div>
      {editingEmail && (
        <Modal title="Email in this step" size="mkt-wide" onClose={() => setEditingEmail(false)} footer={<button type="button" className="btn btn-primary" onClick={() => setEditingEmail(false)}>Done</button>}>
          <EmailBuilder design={c.design} meta={meta} readOnly={locked} subject={c.subject} onChange={(d) => set({ design: cleanDesign(d) })} />
        </Modal>
      )}
    </div>
  );
}

export default function MarketingAutomation() {
  const { id } = useParams();
  const toast = useToast();
  const { user, can } = useAuth();
  const { users } = useRefData();
  const { meta } = useMarketingMeta();
  const [w, setW] = useState(null);
  const [problems, setProblems] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState('trigger');
  const [tab, setTab] = useState('path');
  const [enrollments, setEnrollments] = useState(null);
  const [lists, setLists] = useState({ forms: [], festivals: [], campaigns: [] });
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.mkt.get(`/automations/${id}`);
      setW(r.automation);
      setProblems(r.problems);
      setDirty(false);
    } catch (err) { setError(err); }
  }, [id]);
  useEffect(() => {
    load();
    Promise.all([api.mkt.get('/forms'), api.mkt.get('/festivals'), api.mkt.get('/campaigns')])
      .then(([f, fe, c]) => setLists({ forms: f.forms, festivals: fe.festivals, campaigns: c.campaigns }))
      .catch(() => {});
  }, [load]);
  useEffect(() => {
    if (tab === 'people') api.mkt.get(`/automations/${id}/enrollments`).then((r) => setEnrollments(r.enrollments)).catch((err) => toast.error(err));
  }, [tab, id]);

  if (error) return <EmptyState title="Automation not found">{error.message}</EmptyState>;
  if (!w || !meta) return <Spinner label="Opening the automation" />;

  const locked = w.status === 'ACTIVE' || !can('marketing.manage');
  const edit = (patch) => { setW((x) => ({ ...x, ...patch })); setDirty(true); };
  const graph = w.graph?.nodes ? w.graph : { start: null, nodes: {} };
  const tree = pathTree(graph);
  const approved = Boolean(w.approved_fingerprint);

  const save = async () => {
    try {
      const body = { name: w.name, description: w.description, audience_id: w.audience_id || null, topic_id: w.topic_id || null, trigger: w.trigger, graph: w.graph,
        allow_reentry: Boolean(w.allow_reentry), from_name: w.from_name || null, from_email: w.from_email || null, reply_to: w.reply_to || null };
      if (w.status === 'ACTIVE') { for (const k of ['audience_id', 'topic_id', 'trigger', 'graph', 'allow_reentry', 'from_name', 'from_email', 'reply_to']) delete body[k]; }
      await api.mkt.patch(`/automations/${id}`, body);
      await load();
      toast.success(approved ? 'Saved. It changed, so it needs approving again.' : 'Saved');
      return true;
    } catch (err) { toast.error(err); return false; }
  };
  const act = async (path, body = {}, success) => {
    if (dirty && !(await save())) return;
    try { await api.mkt.post(`/automations/${id}${path}`, body); await load(); if (success) toast.success(success); } catch (err) { toast.error(err); }
  };

  const onAdd = (at, type) => {
    const { graph: next, id: newId } = insertNode(graph, at, type);
    edit({ graph: next });
    setSelected(newId);
  };

  return (
    <div className="stack">
      <div className="row-between wrap">
        <div className="stack-sm grow">
          <Link to="/marketing?tab=automations" className="small muted"><Icon name="chevron" size={12} style={{ transform: 'rotate(180deg)' }} /> Automations</Link>
          <div className="row wrap">
            <input className="input mkt-title-input" value={w.name} disabled={!can('marketing.manage')} onChange={(e) => edit({ name: e.target.value })} aria-label="Automation name" />
            <WorkflowBadge status={w.status} />
            {approved ? <span className="badge badge-good">Approved{w.approved_by_name ? ` by ${w.approved_by_name}` : ''}</span> : w.submitted_at ? <span className="badge badge-warning">Waiting for approval</span> : null}
          </div>
        </div>
        <div className="row wrap">
          {dirty && <button type="button" className="btn btn-primary" onClick={save}>Save</button>}
          {can('marketing.manage') && w.status !== 'ACTIVE' && !approved && !w.submitted_at && <button type="button" className="btn" disabled={problems.length > 0 && !dirty} onClick={() => act('/submit', {}, 'Sent for approval')}>Send for approval</button>}
          {can('marketing.approve') && w.submitted_at && !approved && w.submitted_by !== user.id && <button type="button" className="btn btn-primary" onClick={() => act('/approve', {}, 'Approved')}>Approve</button>}
          {can('marketing.send') && approved && w.status !== 'ACTIVE' && <button type="button" className="btn btn-primary" onClick={() => act('/status', { status: 'ACTIVE' }, 'Switched on')}><Icon name="zap" size={14} /> Switch on</button>}
          {can('marketing.send') && w.status === 'ACTIVE' && <button type="button" className="btn" onClick={() => act('/status', { status: 'PAUSED' }, 'Paused; people stay where they are')}>Pause to edit</button>}
        </div>
      </div>

      {problems.length > 0 && !dirty && (
        <div className="mkt-callout is-warning small"><strong>Before it can be approved</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
      )}
      {w.review_note && !approved && <div className="mkt-callout is-warning small">{w.review_note}</div>}
      {w.status === 'ACTIVE' && <div className="small muted">Running since {formatDate(w.activated_at, { withTime: true })}. Pause it to change the path; it will need approving again.</div>}

      <div className="tabs" role="tablist">
        {[['path', 'Path'], ['settings', 'Who and from'], ['people', 'People in it']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'path' && (
        <div className="mkt-flow-layout">
          <div className="mkt-flow card card-pad">
            <button type="button" className={`mkt-step mkt-step-trigger${selected === 'trigger' ? ' is-selected' : ''}`} onClick={() => setSelected('trigger')}>
              <span className="mkt-step-icon"><Icon name="zap" size={14} /></span>
              <span className="grow"><span className="mkt-step-kind">Starts when</span><span className="mkt-step-text">{triggerSummary(w.trigger, { audiences: meta.audiences, forms: lists.forms, festivals: lists.festivals })}</span></span>
            </button>
            <PathView items={tree} parent={null} branch="next" selected={selected} onSelect={setSelected} onAdd={onAdd} locked={locked} stats={w.step_stats} />
          </div>
          <div className="mkt-props card card-pad">
            {selected === 'trigger' || !graph.nodes[selected] ? (
              <TriggerEditor trigger={w.trigger} meta={meta} forms={lists.forms} festivals={lists.festivals} campaigns={lists.campaigns} locked={locked} onChange={(trigger) => edit({ trigger })} />
            ) : (
              <StepEditor id={selected} node={graph.nodes[selected]} meta={meta} users={users} locked={locked}
                onChange={(node) => edit({ graph: { ...graph, nodes: { ...graph.nodes, [selected]: node } } })}
                onRemove={() => { edit({ graph: removeNode(graph, selected) }); setSelected('trigger'); }} />
            )}
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <fieldset disabled={locked} className="card card-pad stack mkt-fieldset">
          <Field label="Description"><textarea className="textarea" rows={2} value={w.description || ''} onChange={(e) => edit({ description: e.target.value })} /></Field>
          <div className="grid-2">
            <Field label="Only people subscribed to" hint="They leave the path if they unsubscribe">
              <select className="select" value={w.audience_id || ''} onChange={(e) => edit({ audience_id: Number(e.target.value) || null })}>
                <option value="">Any audience</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Topic" hint="People who opted out of it are not emailed">
              <select className="select" value={w.topic_id || ''} onChange={(e) => edit({ topic_id: Number(e.target.value) || null })}>
                <option value="">No particular topic</option>{meta.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Sender name"><input className="input" value={w.from_name || ''} placeholder="Default from Settings" onChange={(e) => edit({ from_name: e.target.value })} /></Field>
            <Field label="Sender address"><input className="input" value={w.from_email || ''} placeholder="Default from Settings" onChange={(e) => edit({ from_email: e.target.value })} /></Field>
            <Field label="Replies go to"><input className="input" value={w.reply_to || ''} placeholder="Default from Settings" onChange={(e) => edit({ reply_to: e.target.value })} /></Field>
          </div>
          <label className="row small"><input type="checkbox" checked={Boolean(w.allow_reentry)} onChange={(e) => edit({ allow_reentry: e.target.checked })} /> Someone can go through it more than once (festivals, dates and TaskFlow events always can, once each)</label>
        </fieldset>
      )}

      {tab === 'people' && (
        <div className="card">
          {!enrollments ? <Spinner /> : enrollments.length === 0 ? <div className="empty small">Nobody has started it yet.</div> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Person</th><th>Status</th><th>At step</th><th>Next</th><th>Started</th></tr></thead>
                <tbody>
                  {enrollments.map((e) => (
                    <tr key={e.id}>
                      <td>{personName(e)}<div className="small muted">{e.email}</div></td>
                      <td>{e.status.toLowerCase()}{e.exit_reason && <div className="small muted">{e.exit_reason}</div>}</td>
                      <td>{graph.nodes[e.current_node] ? nodeSummary(graph.nodes[e.current_node]) : '—'}</td>
                      <td>{e.next_run_at ? formatDate(e.next_run_at, { withTime: true }) : '—'}</td>
                      <td>{formatDate(e.enrolled_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
