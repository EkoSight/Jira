import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useToast } from '../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import EmailBuilder, { cleanDesign } from '../components/marketing/EmailBuilder.jsx';
import MarketingContacts from '../components/marketing/MarketingContacts.jsx';
import MarketingAudiences from '../components/marketing/MarketingAudiences.jsx';
import MarketingSettings from '../components/marketing/MarketingSettings.jsx';
import MarketingTemplates from '../components/marketing/MarketingTemplates.jsx';
import { CampaignBadge, CopyButton, PreviewFrame, Stat, WorkflowBadge, forgetMarketingMeta, useMarketingMeta } from '../components/marketing/parts.jsx';
import { formatDate } from '../lib/format.js';
import { istDay, monthGrid, percent, personName, triggerSummary } from '../lib/marketing.js';

const TABS = [
  ['overview', 'Overview'], ['campaigns', 'Campaigns'], ['calendar', 'Calendar'], ['automations', 'Automations'], ['contacts', 'Contacts'],
  ['audiences', 'Audiences & segments'], ['forms', 'Signup forms'], ['templates', 'Templates'], ['settings', 'Settings'],
];

// ---------------------------------------------------------------- overview

function Overview({ goTo }) {
  const [o, setO] = useState(null);
  const [followups, setFollowups] = useState(null);
  useEffect(() => {
    api.mkt.get('/overview').then(setO).catch(() => {});
    api.mkt.get('/followups').then((r) => setFollowups(r.followups.slice(0, 8))).catch(() => {});
  }, []);
  if (!o) return <Spinner />;
  const l = o.last30;
  return (
    <div className="stack">
      {!o.provider.configured && <div className="mkt-callout is-critical small">Sending is not set up on the server: {o.provider.missing.join(', ')}. See Settings.</div>}
      {o.provider.configured && !o.provider.delivers && <div className="mkt-callout is-warning small">The server is set to the outbox: emails are built and recorded but not delivered. Set EMAIL_PROVIDER to send for real.</div>}
      <div className="small dim">Last 30 days, campaigns and automations</div>
      <div className="stat-grid">
        <Stat label="Sent" value={l.sent} />
        <Stat label="Opened" value={percent(l.open_rate)} note={`${l.opened} ${l.opened === 1 ? 'person' : 'people'} · an estimate`} />
        <Stat label="Clicked" value={percent(l.click_rate)} note={`${l.clicked} ${l.clicked === 1 ? 'person' : 'people'}`} />
        <Stat label="Replied" value={l.replied} />
        <Stat label="Converted" value={l.converted} />
        <Stat label="Bounced" value={percent(l.bounce_rate)} note={`${l.bounced} emails`} tone={l.bounce_rate > 2 ? 'critical' : undefined} />
        <Stat label="Spam complaints" value={percent(l.complaint_rate)} note="Keep under 0.1%" tone={l.complaint_rate >= 0.1 ? 'critical' : undefined} />
        <Stat label="Unsubscribed" value={l.unsubscribed} />
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>Needs attention</h3></div>
          <div className="card-pad stack-sm">
            {o.waiting_for_review.map((c) => <Link key={c.id} to={`/marketing/campaigns/${c.id}`} className="row small"><Badge tone="warning">Approve</Badge><span className="grow truncate">{c.name}</span><span className="muted">{formatDate(c.submitted_at)}</span></Link>)}
            {o.deadlines.map((c) => <Link key={c.id} to={`/marketing/campaigns/${c.id}`} className="row small"><Badge tone={new Date(c.deadline) < new Date() ? 'critical' : 'warning'}>Due {formatDate(c.deadline)}</Badge><span className="grow truncate">{c.name}</span><CampaignBadge status={c.status} /></Link>)}
            {o.health.failed_7d > 0 && <div className="row small"><Badge tone="critical">{o.health.failed_7d} failed</Badge> emails could not be handed to the provider this week</div>}
            {!o.waiting_for_review.length && !o.deadlines.length && !o.health.failed_7d && <div className="empty small">Nothing waiting on you.</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Coming up</h3><button type="button" className="btn btn-ghost btn-sm" onClick={() => goTo('calendar')}>Calendar</button></div>
          <div className="card-pad stack-sm">
            {o.upcoming.length === 0 ? <div className="empty small">Nothing scheduled.</div> : o.upcoming.map((c) => (
              <Link key={c.id} to={`/marketing/campaigns/${c.id}`} className="row small"><CampaignBadge status={c.status} /><span className="grow truncate">{c.name}</span><span className="muted">{c.scheduled_at ? formatDate(c.scheduled_at, { withTime: true }) : ''}</span></Link>
            ))}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>Follow-up tasks from email</h3><span className="small muted">{o.followups.open} open of {o.followups.total} in 30 days</span></div>
          <div className="card-pad stack-sm">
            {!followups ? <Spinner /> : followups.length === 0 ? <div className="empty small">Replies, conversions and clicks you choose become tasks here.</div> : followups.map((f) => (
              <div key={f.id} className="row small"><Link className="task-ref" to={`?task=${f.task_id}`}>{f.task_ref}</Link><span className="grow truncate">{personName(f)} — {f.reason.toLowerCase()} · {f.campaign_name || f.workflow_name}</span><span className="muted">{f.assignee_name}</span></div>
            ))}
          </div>
        </div>
        <div className="card card-pad stack-sm">
          <h3>Contacts</h3>
          <div className="row wrap small"><Badge tone="brand">{o.contacts.total} contacts</Badge><Badge tone="good">{o.contacts.subscribed} subscribed</Badge><Badge>{o.contacts.new_30d} new in 30 days</Badge><Badge>{o.health.suppressed} never emailed</Badge></div>
          <div className="small muted">Open rates are estimates: Apple Mail opens every email automatically, and many apps block the images that count opens. Clicks, replies and conversions are firmer.</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- campaigns

function NewCampaign({ meta, onClose }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', audience_id: '', template: '', create_task: true, deadline: '' });
  const [templates, setTemplates] = useState(null);
  useEffect(() => { api.mkt.get('/templates').then(setTemplates).catch(() => setTemplates({ starters: [], saved: [] })); }, []);
  const all = templates ? [...templates.saved.map((t) => ({ ...t, ref: `t${t.id}` })), ...templates.starters.map((t) => ({ ...t, ref: `s${t.key}` }))] : [];
  const create = async () => {
    const t = all.find((x) => x.ref === form.template);
    try {
      const { campaign } = await api.mkt.post('/campaigns', {
        name: form.name, audience_id: form.audience_id ? Number(form.audience_id) : null, create_task: form.create_task,
        deadline: form.deadline ? new Date(`${form.deadline}T18:00:00+05:30`).toISOString() : null,
        ...(t ? {
          design: t.design, subject: t.subject?.en || null, subject_hi: t.subject?.hi || null, preheader: t.preheader?.en || null, preheader_hi: t.preheader?.hi || null,
        } : { design: { settings: { header: 'light', ground: 'sand' }, blocks: [] } }),
      });
      navigate(`/marketing/campaigns/${campaign.id}`);
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="New campaign" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!form.name.trim()} onClick={create}>Create</button></>}>
      <div className="stack">
        <Field label="Name"><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Diwali greetings 2026" /></Field>
        <Field label="Audience">
          <select className="select" value={form.audience_id} onChange={(e) => setForm({ ...form, audience_id: e.target.value })}>
            <option value="">Choose later</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.subscribed} subscribed)</option>)}
          </select>
        </Field>
        <Field label="Start from">
          <select className="select" value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
            <option value="">A blank email</option>{all.map((t) => <option key={t.ref} value={t.ref}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Must go out by (optional)"><input className="input" type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} /></Field>
        <label className="row small"><input type="checkbox" checked={form.create_task} onChange={(e) => setForm({ ...form, create_task: e.target.checked })} /> Make a TaskFlow task for preparing it, assigned to me</label>
      </div>
    </Modal>
  );
}

function Campaigns({ meta }) {
  const { can } = useAuth();
  const [list, setList] = useState(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => { const t = setTimeout(() => api.mkt.get('/campaigns', { status, search }).then((r) => setList(r.campaigns)).catch(() => {}), 200); return () => clearTimeout(t); }, [status, search]);
  return (
    <div className="stack">
      <div className="filters">
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search campaigns" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="select" style={{ width: 190 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'SENDING', 'TESTING', 'SENT', 'PAUSED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s.toLowerCase().replace('_', ' ')}</option>)}
        </select>
        <div className="grow" />
        {can('marketing.manage') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} /> New campaign</button>}
      </div>
      <div className="card">
        {!list ? <Spinner /> : list.length === 0 ? <EmptyState title="No campaigns yet">Create one from a template: a newsletter, a festival greeting, a product update, jobs for students, an industry update for FPOs.</EmptyState> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th>When</th><th className="num">Sent</th><th className="num">Opened</th><th className="num">Clicked</th><th className="num">Replied</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/marketing/campaigns/${c.id}`} style={{ fontWeight: 600 }}>{c.name}</Link>{c.is_ab && <span className="badge" style={{ marginLeft: 6 }}>A/B</span>}<div className="small muted truncate" style={{ maxWidth: 320 }}>{c.subject}{c.owner_name ? ` · ${c.owner_name}` : ''}{c.task_ref ? ` · ${c.task_ref}` : ''}</div></td>
                    <td><CampaignBadge status={c.status} /></td>
                    <td className="small">{c.audience_name || 'All subscribed'}</td>
                    <td className="small">{c.started_at ? formatDate(c.started_at, { withTime: true }) : c.scheduled_at ? formatDate(c.scheduled_at, { withTime: true }) : c.deadline ? `Due ${formatDate(c.deadline)}` : '—'}</td>
                    <td className="num">{c.sent}</td>
                    <td className="num">{c.sent ? percent((c.opened / c.sent) * 100) : '—'}</td>
                    <td className="num">{c.sent ? percent((c.clicked / c.sent) * 100) : '—'}</td>
                    <td className="num">{c.replied}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <NewCampaign meta={meta} onClose={() => setCreating(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- calendar

function Calendar() {
  const now = new Date();
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [data, setData] = useState(null);
  const weeks = useMemo(() => monthGrid(month.y, month.m), [month]);
  useEffect(() => {
    setData(null);
    api.mkt.get('/calendar', { from: weeks[0][0].date, to: weeks.at(-1)[6].date }).then(setData).catch(() => setData({ campaigns: [], festivals: [], automations: [] }));
  }, [weeks]);
  const byDay = useMemo(() => {
    const map = {};
    const add = (day, item) => { if (day) (map[day] ||= []).push(item); };
    for (const c of data?.campaigns || []) add(istDay(c.scheduled_at || c.started_at || c.deadline), { kind: 'campaign', id: c.id, label: c.name, status: c.status, due: !c.scheduled_at && !c.started_at });
    for (const f of data?.festivals || []) add(f.date, { kind: 'festival', id: `f${f.id}`, label: f.name, confirmed: f.is_confirmed });
    for (const a of data?.automations || []) add(a.date, { kind: 'automation', id: `a${a.workflow_id}-${a.festival_id}`, label: a.workflow_name, workflow_id: a.workflow_id });
    return map;
  }, [data]);
  const title = new Date(Date.UTC(month.y, month.m, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const step = (d) => setMonth(({ y, m }) => { const n = new Date(Date.UTC(y, m + d, 1)); return { y: n.getUTCFullYear(), m: n.getUTCMonth() }; });
  const today = istDay(new Date());
  return (
    <div className="stack">
      <div className="row-between">
        <div className="row"><button type="button" className="btn btn-sm" onClick={() => step(-1)} aria-label="Previous month"><Icon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} /></button><h2>{title}</h2><button type="button" className="btn btn-sm" onClick={() => step(1)} aria-label="Next month"><Icon name="chevron" size={13} /></button></div>
        <div className="row small wrap"><span className="mkt-cal-key is-campaign">Campaign</span><span className="mkt-cal-key is-festival">Festival</span><span className="mkt-cal-key is-automation">Festival automation</span></div>
      </div>
      <div className="mkt-cal card">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="mkt-cal-head small">{d}</div>)}
        {weeks.flat().map((day) => (
          <div key={day.date} className={`mkt-cal-day${day.inMonth ? '' : ' is-out'}${day.date === today ? ' is-today' : ''}`}>
            <div className="mkt-cal-date small tnum">{Number(day.date.slice(8))}</div>
            {(byDay[day.date] || []).map((item) => (item.kind === 'campaign' ? (
              <Link key={item.id} to={`/marketing/campaigns/${item.id}`} className="mkt-cal-item is-campaign" title={`${item.label} — ${item.status.toLowerCase()}`}>{item.due ? 'Due: ' : ''}{item.label}</Link>
            ) : item.kind === 'automation' ? (
              <Link key={item.id} to={`/marketing/automations/${item.workflow_id}`} className="mkt-cal-item is-automation" title={item.label}>{item.label}</Link>
            ) : (
              <span key={item.id} className="mkt-cal-item is-festival" title={item.confirmed ? 'Date confirmed' : 'Date not confirmed yet — automations will not send'}>{item.label}{!item.confirmed && ' ?'}</span>
            )))}
          </div>
        ))}
      </div>
      {!data && <Spinner />}
      <div className="small muted">A “?” marks a festival whose date nobody has confirmed yet; automations never send on it. Confirm dates in Settings.</div>
    </div>
  );
}

// ---------------------------------------------------------------- automations

const RECIPES = [
  { key: 'welcome', name: 'Welcome series', note: 'When someone joins an audience: a welcome, then a nudge if they did not open it.', build: (t, aud) => ({
    trigger: { type: 'AUDIENCE_JOINED', audience_id: aud }, audience_id: aud,
    graph: { start: 's1', nodes: {
      s1: { type: 'email', config: { subject: 'Welcome to Soil Doctor, {{first_name|friend}}', subject_hi: 'Soil Doctor में आपका स्वागत है, {{first_name|मित्र}}', design: t.welcome }, next: 's2' },
      s2: { type: 'delay', config: { amount: 3, unit: 'days' }, next: 's3' },
      s3: { type: 'condition', config: { kind: 'opened' }, yes: 's4', no: 's5' },
      s4: { type: 'action', config: { kind: 'add_tag', value: 'engaged' }, next: null },
      s5: { type: 'email', config: { subject: 'Good decisions start with your soil', subject_hi: 'अच्छे फ़ैसले आपकी मिट्टी से शुरू होते हैं', design: t.welcome }, next: null },
    } },
  }) },
  { key: 'lead', name: 'Lead nurturing', note: 'When a lead is added in the pipeline: an introduction; a call task for whoever clicks, a follow-up for the rest.', build: (t) => ({
    trigger: { type: 'TASKFLOW_EVENT', event: 'LEAD_CREATED' },
    graph: { start: 's1', nodes: {
      s1: { type: 'email', config: { subject: 'Soil testing for {{organization|your farms}}', design: t.product }, next: 's2' },
      s2: { type: 'delay', config: { amount: 3, unit: 'days' }, next: 's3' },
      s3: { type: 'condition', config: { kind: 'clicked' }, yes: 's4', no: 's5' },
      s4: { type: 'action', config: { kind: 'create_task', title: 'Call {{name}} — clicked the introduction', due_days: 1 }, next: null },
      s5: { type: 'email', config: { subject: 'Following up on soil testing for {{organization|your farms}}', design: t.follow_up }, next: null },
    } },
  }) },
  { key: 'festival', name: 'Festival greetings', note: 'On each confirmed festival, a greeting in English or Hindi to an audience.', build: (t, aud) => ({
    trigger: { type: 'FESTIVAL', days_before: 0, send_hour: 9 }, audience_id: aud,
    graph: { start: 's1', nodes: { s1: { type: 'email', config: { subject: 'Warm wishes on {{festival|this festival}}', subject_hi: '{{festival|त्योहार}} की हार्दिक शुभकामनाएँ', design: t.festival }, next: null } } },
  }) },
  { key: 'reengage', name: 'Re-engagement', note: 'For people quiet for 90 days: one email asking if they want to stay; tags those who do not respond.', build: (t, aud) => ({
    trigger: { type: 'INACTIVE', days: 90 }, audience_id: aud,
    graph: { start: 's1', nodes: {
      s1: { type: 'email', config: { subject: 'Do you still want to hear from us?', subject_hi: 'क्या आप हमसे जुड़े रहना चाहते हैं?', design: t.reengage }, next: 's2' },
      s2: { type: 'delay', config: { amount: 7, unit: 'days' }, next: 's3' },
      s3: { type: 'condition', config: { kind: 'clicked' }, yes: 's4', no: 's5' },
      s4: { type: 'action', config: { kind: 'add_tag', value: 'reengaged' }, next: null },
      s5: { type: 'action', config: { kind: 'add_tag', value: 'inactive' }, next: null },
    } },
  }) },
  { key: 'customer', name: 'New customer onboarding', note: 'When a lead becomes a customer: a welcome, and an onboarding call task for their owner.', build: (t) => ({
    trigger: { type: 'TASKFLOW_EVENT', event: 'BECAME_CUSTOMER' },
    graph: { start: 's1', nodes: {
      s1: { type: 'email', config: { subject: 'Welcome to Soil Doctor, {{first_name|friend}}', subject_hi: 'Soil Doctor में आपका स्वागत है, {{first_name|मित्र}}', design: t.welcome }, next: 's2' },
      s2: { type: 'action', config: { kind: 'create_task', title: 'Onboarding call with {{name}}', due_days: 3 }, next: null },
    } },
  }) },
  { key: 'blank', name: 'Start from scratch', note: 'Choose the trigger and steps yourself.', build: () => ({ trigger: { type: 'MANUAL' }, graph: { start: null, nodes: {} } }) },
];

function NewAutomation({ meta, onClose }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [recipe, setRecipe] = useState('welcome');
  const [name, setName] = useState('');
  const [audience, setAudience] = useState(meta.audiences[0]?.id || '');
  const create = async () => {
    try {
      const { starters } = await api.mkt.get('/templates');
      const designs = Object.fromEntries(starters.map((s) => [s.key, s.design]));
      const r = RECIPES.find((x) => x.key === recipe);
      const body = { name: name || r.name, ...r.build(designs, audience ? Number(audience) : null) };
      const { automation } = await api.mkt.post('/automations', body);
      navigate(`/marketing/automations/${automation.id}`);
    } catch (err) { toast.error(err); }
  };
  const needsAudience = ['welcome', 'festival', 'reengage'].includes(recipe);
  return (
    <Modal title="New automation" size="lg" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={create}>Create</button></>}>
      <div className="stack">
        <div className="mkt-template-grid">
          {RECIPES.map((r) => (
            <button key={r.key} type="button" className={`mkt-template card${recipe === r.key ? ' is-selected' : ''}`} aria-pressed={recipe === r.key} onClick={() => setRecipe(r.key)}>
              <span className="mkt-template-name">{r.name}</span><span className="small muted">{r.note}</span>
            </button>
          ))}
        </div>
        <div className="grid-2">
          <Field label="Name"><input className="input" value={name} placeholder={RECIPES.find((r) => r.key === recipe).name} onChange={(e) => setName(e.target.value)} /></Field>
          {needsAudience && (
            <Field label="Audience">
              <select className="select" value={audience} onChange={(e) => setAudience(e.target.value)}>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </Field>
          )}
        </div>
        <div className="small muted">Nothing sends until it is approved by a second person and switched on. You can change every step first.</div>
      </div>
    </Modal>
  );
}

function Automations({ meta }) {
  const { can } = useAuth();
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { api.mkt.get('/automations').then((r) => setList(r.automations)).catch(() => {}); }, []);
  return (
    <div className="stack">
      <div className="row-between">
        <div className="small muted">Paths people go through on their own: welcome series, lead nurturing, festival greetings, re-engagement, and steps started by events in TaskFlow.</div>
        {can('marketing.manage') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} /> New automation</button>}
      </div>
      <div className="card">
        {!list ? <Spinner /> : list.length === 0 ? <EmptyState title="No automations yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Automation</th><th>Status</th><th>Starts when</th><th className="num">Started</th><th className="num">In progress</th><th className="num">Emails sent</th></tr></thead>
              <tbody>{list.map((w) => (
                <tr key={w.id}>
                  <td><Link to={`/marketing/automations/${w.id}`} style={{ fontWeight: 600 }}>{w.name}</Link><div className="small muted">{w.audience_name || 'Any audience'}{w.owner_name ? ` · ${w.owner_name}` : ''}</div></td>
                  <td><WorkflowBadge status={w.status} />{!w.approved_fingerprint && w.submitted_at && <Badge tone="warning">waiting for approval</Badge>}</td>
                  <td className="small">{triggerSummary(w.trigger, { audiences: meta.audiences })}</td>
                  <td className="num">{w.enrolled}</td><td className="num">{w.in_progress}</td><td className="num">{w.emails_sent}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <NewAutomation meta={meta} onClose={() => setCreating(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- forms

const STANDARD_FIELDS = [['email', 'Email address'], ['first_name', 'First name'], ['last_name', 'Last name'], ['phone', 'Phone'], ['organization', 'Organization'], ['designation', 'Designation'], ['city', 'City or village'], ['state', 'State']];

function FormDialog({ form, meta, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(form || { name: '', audience_id: meta.audiences[0]?.id, title: '', intro: '', language: 'en', fields: [{ key: 'email', required: true }, { key: 'first_name', required: false }], topic_ids: [], tags: [], consent_text: '', success_message: '', redirect_url: '', is_active: true });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const has = (key) => f.fields.some((x) => x.key === key);
  const toggleField = (key, on) => set('fields', on ? [...f.fields, { key, required: false }] : f.fields.filter((x) => x.key !== key));
  const save = async () => {
    try {
      const body = { ...f, consent_text: f.consent_text || undefined, redirect_url: f.redirect_url || null };
      const r = form ? await api.mkt.patch(`/forms/${form.id}`, body) : await api.mkt.post('/forms', body);
      toast.success('Form saved');
      onSaved(r.form);
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal size="lg" title={form ? 'Edit signup form' : 'New signup form'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!f.name.trim() || !f.audience_id} onClick={save}>Save</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Name (for your team)"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Adds people to">
            <select className="select" value={f.audience_id || ''} onChange={(e) => set('audience_id', Number(e.target.value))}>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}{a.double_opt_in ? ' (confirm by email)' : ''}</option>)}</select>
          </Field>
          <Field label="Heading on the form"><input className="input" value={f.title || ''} onChange={(e) => set('title', e.target.value)} /></Field>
          <Field label="Language of the form">
            <select className="select" value={f.language} onChange={(e) => set('language', e.target.value)}><option value="en">English</option><option value="hi">Hindi</option></select>
          </Field>
        </div>
        <Field label="A line under the heading"><input className="input" value={f.intro || ''} onChange={(e) => set('intro', e.target.value)} /></Field>
        <Field label="Questions">
          <div className="stack-sm">
            {[...STANDARD_FIELDS, ...meta.custom_fields.map((c) => [`custom.${c.key}`, c.label])].map(([key, label]) => (
              <div key={key} className="row small">
                <label className="row grow"><input type="checkbox" checked={has(key)} disabled={key === 'email'} onChange={(e) => toggleField(key, e.target.checked)} /> {label}</label>
                {has(key) && key !== 'email' && <label className="row"><input type="checkbox" checked={f.fields.find((x) => x.key === key).required} onChange={(e) => set('fields', f.fields.map((x) => (x.key === key ? { ...x, required: e.target.checked } : x)))} /> required</label>}
              </div>
            ))}
          </div>
        </Field>
        <Field label="Let them choose topics">
          <div className="row wrap">{meta.topics.map((t) => <label key={t.id} className="row small mkt-chip-check"><input type="checkbox" checked={f.topic_ids.includes(t.id)} onChange={(e) => set('topic_ids', e.target.checked ? [...f.topic_ids, t.id] : f.topic_ids.filter((x) => x !== t.id))} /> {t.name}</label>)}</div>
        </Field>
        <Field label="Tag everyone who signs up" hint="Comma-separated"><input className="input" value={(f.tags || []).join(', ')} onChange={(e) => set('tags', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>
        <Field label="What they agree to" hint="Shown next to the tick box and kept, word for word, in their consent record. Leave blank for the standard wording.">
          <textarea className="textarea" rows={2} dir="auto" value={f.consent_text || ''} onChange={(e) => set('consent_text', e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Thank-you message"><input className="input" value={f.success_message || ''} onChange={(e) => set('success_message', e.target.value)} /></Field>
          <Field label="Or go to this page afterwards" hint="https only"><input className="input" value={f.redirect_url || ''} onChange={(e) => set('redirect_url', e.target.value)} placeholder="https://soildoctor.in/thanks" /></Field>
        </div>
        {form && <label className="row small"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Accepting signups</label>}
      </div>
    </Modal>
  );
}

function Forms({ meta }) {
  const { can } = useAuth();
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [embed, setEmbed] = useState(null);
  const load = useCallback(() => api.mkt.get('/forms').then((r) => setList(r.forms)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="stack">
      <div className="row-between">
        <div className="small muted">A hosted page you can link to, or HTML to paste into soildoctor.in. Consent is required and recorded; a hidden field and rate limits stop bots.</div>
        {can('marketing.manage') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={13} /> New form</button>}
      </div>
      <div className="card">
        {!list ? <Spinner /> : list.length === 0 ? <EmptyState title="No signup forms yet">Make one for students (jobs and internships), farmers (advice), or your newsletter.</EmptyState> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Form</th><th>Audience</th><th className="num">Signups</th><th>Address</th><th /></tr></thead>
              <tbody>{list.map((f) => (
                <tr key={f.id}>
                  <td style={{ fontWeight: 600 }}>{f.name}{!f.is_active && <Badge>off</Badge>}</td>
                  <td>{f.audience_name}</td><td className="num">{f.submissions}</td>
                  <td className="small"><a href={f.url} target="_blank" rel="noreferrer" className="mkt-link">Open the form</a></td>
                  <td><div className="row" style={{ gap: 4 }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.mkt.get(`/forms/${f.id}/embed`).then(setEmbed)}>Embed code</button>
                    {can('marketing.manage') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(f)}>Edit</button>}
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <FormDialog form={editing === 'new' ? null : editing} meta={meta} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {embed && (
        <Modal title="Put this form on a website" onClose={() => setEmbed(null)}>
          <div className="stack">
            <Field label="Link to the hosted form"><div className="row"><code className="mkt-code grow small">{embed.url}</code><CopyButton text={embed.url} /></div></Field>
            <Field label="HTML to paste into a page" hint="A plain form that posts to TaskFlow; style it with your site’s CSS.">
              <textarea className="textarea mkt-code" rows={10} readOnly value={embed.html} />
            </Field>
            <CopyButton text={embed.html} label="Copy HTML" />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the page

export default function Marketing() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const goTo = (key) => setParams({ tab: key }, { replace: true });
  const [version, setVersion] = useState(0);
  const { meta, error } = useMarketingMeta(version);
  const refreshMeta = () => { forgetMarketingMeta(); setVersion((v) => v + 1); };

  if (error) return <EmptyState title="Email marketing could not load">{error.message}</EmptyState>;
  if (!meta) return <Spinner label="Opening email marketing" />;
  return (
    <div className="stack">
      <div className="tabs tabs-scroll" role="tablist">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => goTo(k)}>{l}</button>)}
      </div>
      {tab === 'overview' && <Overview goTo={goTo} />}
      {tab === 'campaigns' && <Campaigns meta={meta} />}
      {tab === 'calendar' && <Calendar />}
      {tab === 'automations' && <Automations meta={meta} />}
      {tab === 'contacts' && <MarketingContacts meta={meta} />}
      {tab === 'audiences' && <MarketingAudiences meta={meta} onMetaChanged={refreshMeta} />}
      {tab === 'forms' && <Forms meta={meta} />}
      {tab === 'templates' && <MarketingTemplates meta={meta} />}
      {tab === 'settings' && <MarketingSettings onSaved={refreshMeta} />}
    </div>
  );
}
