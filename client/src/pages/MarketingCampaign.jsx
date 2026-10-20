import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth, useRefData, useToast } from '../state/AppState.jsx';
import { Badge, ConfirmButton, EmptyState, Field, Icon, Modal, Spinner } from '../components/ui.jsx';
import EmailBuilder, { cleanDesign } from '../components/marketing/EmailBuilder.jsx';
import { AiAssist, CampaignBadge, LangSwitch, useMarketingMeta } from '../components/marketing/parts.jsx';
import { CampaignReport } from '../components/marketing/MarketingReports.jsx';
import { formatDate, fromDateTimeLocal, toDateTimeLocal } from '../lib/format.js';
import { withIds } from '../lib/marketing.js';

const EDITABLE = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED'];
const STARTED = ['SENDING', 'TESTING', 'SENT', 'PAUSED', 'CANCELLED'];
const VERSION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function TemplatePicker({ onPick, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.mkt.get('/templates').then(setData).catch(() => setData({ starters: [], saved: [] })); }, []);
  return (
    <Modal title="Start from a template" onClose={onClose} size="lg">
      {!data ? <Spinner /> : (
        <div className="stack">
          {[['Your templates', data.saved], ['Starter templates', data.starters]].map(([title, list]) => list.length > 0 && (
            <div key={title} className="stack-sm">
              <h3>{title}</h3>
              <div className="mkt-template-grid">
                {list.map((t) => (
                  <button key={t.id || t.key} type="button" className="mkt-template card" onClick={() => onPick(t)}>
                    <span className="mkt-template-name">{t.name}</span>
                    <span className="small muted">{t.description || t.category}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Checks({ checks }) {
  if (!checks) return <Spinner label="Checking" />;
  return (
    <div className="stack-sm">
      <div className="row wrap">
        <Badge tone={checks.recipients ? 'brand' : 'critical'}>{checks.recipients} recipient{checks.recipients === 1 ? '' : 's'} now</Badge>
        {checks.sender?.from && <span className="small dim">From {checks.sender.fromName} &lt;{checks.sender.from}&gt;{checks.sender.replyTo ? ` · replies to ${checks.sender.replyTo}` : ''}</span>}
      </div>
      {checks.problems.length > 0 && (
        <div className="mkt-callout is-critical">
          <strong>Fix before it can go</strong>
          <ul>{checks.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {checks.warnings.length > 0 && (
        <div className="mkt-callout is-warning">
          <strong>Worth a look</strong>
          <ul>{checks.warnings.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {!checks.problems.length && !checks.warnings.length && <div className="mkt-callout is-good">Everything checks out.</div>}
      <div className="small muted">Recipients are worked out again when sending starts, and each person is checked once more as their email goes: anyone who unsubscribes, bounces or complains in between is not sent it.</div>
    </div>
  );
}

function VariantEditor({ variant, index, meta, onChange, onRemove, readOnly, baseDesign }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="mkt-subcard stack-sm">
      <div className="row-between">
        <strong>Version {VERSION_KEYS[index]}</strong>
        {!readOnly && index > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>Remove</button>}
      </div>
      <div className="grid-2">
        <Field label="Subject"><input className="input" value={variant.subject || ''} onChange={(e) => onChange({ ...variant, subject: e.target.value })} disabled={readOnly} /></Field>
        <Field label="Subject in Hindi"><input className="input" dir="auto" value={variant.subject_hi || ''} onChange={(e) => onChange({ ...variant, subject_hi: e.target.value })} disabled={readOnly} /></Field>
        <Field label="Preview text"><input className="input" value={variant.preheader || ''} onChange={(e) => onChange({ ...variant, preheader: e.target.value })} disabled={readOnly} /></Field>
        <Field label="Sender name"><input className="input" value={variant.from_name || ''} placeholder="Same as the campaign" onChange={(e) => onChange({ ...variant, from_name: e.target.value })} disabled={readOnly} /></Field>
      </div>
      <div className="row wrap">
        <label className="row small"><input type="checkbox" checked={Boolean(variant.design)} disabled={readOnly}
          onChange={(e) => onChange({ ...variant, design: e.target.checked ? structuredClone(baseDesign) : null })} /> Different content in this version</label>
        {variant.design && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}><Icon name="edit" size={13} /> Edit this version’s content</button>}
      </div>
      {editing && (
        <Modal title={`Version ${VERSION_KEYS[index]} content`} size="mkt-wide" onClose={() => setEditing(false)}
          footer={<button type="button" className="btn btn-primary" onClick={() => setEditing(false)}>Done</button>}>
          <EmailBuilder design={variant.design} meta={meta} readOnly={readOnly} subject={variant.subject}
            onChange={(d) => onChange({ ...variant, design: cleanDesign(d) })} />
        </Modal>
      )}
    </div>
  );
}

export default function MarketingCampaign() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, can } = useAuth();
  const { users } = useRefData();
  const { meta } = useMarketingMeta();
  const [campaign, setCampaign] = useState(null);
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(() => new Set());
  const [tab, setTab] = useState('setup');
  const [segments, setSegments] = useState([]);
  const [checks, setChecks] = useState(null);
  const [subjectLang, setSubjectLang] = useState('en');
  const [builderKey, setBuilderKey] = useState(0);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState(user.email);
  const [testContact, setTestContact] = useState('');
  const [testVariant, setTestVariant] = useState('');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [strategy, setStrategy] = useState('NOW');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { campaign: c } = await api.mkt.get(`/campaigns/${id}`);
      setCampaign(c);
      setDraft({ ...c, design: withIds(c.design) });
      setDirty(new Set());
      setBuilderKey((k) => k + 1);
      if (STARTED.includes(c.status)) setTab((t) => (t === 'setup' ? 'report' : t));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => { load(); api.mkt.get('/segments').then((r) => setSegments(r.segments)).catch(() => {}); }, [load]);
  useEffect(() => {
    if (tab !== 'review' || !campaign) return;
    setChecks(null);
    api.mkt.get(`/campaigns/${id}/checks`).then(setChecks).catch((err) => toast.error(err));
  }, [tab, campaign, id]);

  const set = (field, value) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setDirty((s) => new Set(s).add(field));
  };

  const readOnly = campaign ? !EDITABLE.includes(campaign.status) || !can('marketing.manage') : true;
  const approvedOrLater = campaign && ['IN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(campaign.status);

  const save = async () => {
    if (!dirty.size) return true;
    setSaving(true);
    try {
      const body = {};
      for (const f of dirty) {
        if (f === 'design') body.design = cleanDesign(draft.design);
        else if (f === 'variants') body.variants = draft.variants.map(({ subject, subject_hi: sh, preheader, from_name: fn, design }) => ({ subject, subject_hi: sh, preheader, from_name: fn, design: design || null }));
        else body[f] = draft[f] === '' ? null : draft[f];
      }
      const { campaign: saved } = await api.mkt.patch(`/campaigns/${id}`, body);
      setCampaign(saved);
      setDraft((d) => ({ ...saved, design: d.design }));
      setDirty(new Set());
      toast.success(saved.status === 'DRAFT' && approvedOrLater ? 'Saved. It changed, so it needs approving again.' : 'Saved');
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const act = async (path, body = {}, success) => {
    if (dirty.size && !(await save())) return;
    try {
      const result = await api.mkt.post(`/campaigns/${id}${path}`, body);
      if (success) toast.success(success);
      if (result.campaign) { setCampaign(result.campaign); setDraft((d) => ({ ...result.campaign, design: d.design })); } else await load();
      if (path === '/schedule' || path === '/finish-test' || path === '/resume') await load();
      return result;
    } catch (err) {
      toast.error(err);
      return null;
    }
  };

  const useTemplate = (t) => {
    set('design', withIds(t.design));
    if (t.subject && !draft.subject) { set('subject', t.subject.en || ''); set('subject_hi', t.subject.hi || ''); }
    setBuilderKey((k) => k + 1);
    setPicking(false);
    toast.info(`Using “${t.name}” — remember to save`);
  };

  const saveAsTemplate = async () => {
    try {
      await api.mkt.post('/templates', { name: draft.name, category: 'GENERAL', description: draft.subject || '', design: cleanDesign(draft.design) });
      toast.success('Saved as a template');
    } catch (err) { toast.error(err); }
  };

  const designLinks = useMemo(() => {
    const found = new Set();
    for (const b of draft.design?.blocks || []) {
      if (b.href) found.add(b.href);
      for (const m of JSON.stringify(b.text || '').matchAll(/\]\((https?:[^)\s"]+)\)/g)) found.add(m[1]);
    }
    return [...found].filter((u) => /^https?:/.test(u));
  }, [draft.design]);

  if (error) return <EmptyState title="Campaign not found">{error.message}</EmptyState>;
  if (!campaign || !meta) return <Spinner label="Opening the campaign" />;

  const followUp = draft.follow_up || {};
  const ab = draft.ab_test;
  const variants = draft.variants || [];
  const isSubmitter = campaign.submitted_by === user.id;
  const tabs = [
    ['setup', 'Setup'], ['content', 'Content'], ['ab', ab ? `A/B test (${variants.length})` : 'A/B test'], ['followups', 'Follow-ups'],
    ['review', STARTED.includes(campaign.status) ? 'Sending' : 'Review & send'], ...(STARTED.includes(campaign.status) || campaign.started_at ? [['report', 'Report']] : []),
  ];

  return (
    <div className="stack">
      <div className="row-between wrap">
        <div className="stack-sm grow">
          <Link to="/marketing?tab=campaigns" className="small muted"><Icon name="chevron" size={12} style={{ transform: 'rotate(180deg)' }} /> Campaigns</Link>
          <div className="row wrap">
            <h1 className="truncate">{draft.name}</h1>
            <CampaignBadge status={campaign.status} />
            {campaign.task_ref && <Link className="task-ref" to={`?task=${campaign.task_id}`} title={campaign.task_title}>{campaign.task_ref}</Link>}
          </div>
          <div className="small muted">
            {campaign.owner_name && <>Owner {campaign.owner_name} · </>}
            {campaign.deadline && <>Due {formatDate(campaign.deadline, { withTime: true })} · </>}
            {campaign.scheduled_at && campaign.status === 'SCHEDULED' && <>Goes {formatDate(campaign.scheduled_at, { withTime: true })} · </>}
            {campaign.approved_by_name && <>Approved by {campaign.approved_by_name} · </>}
            {campaign.recipient_count !== null && campaign.recipient_count !== undefined && <>{campaign.recipient_count} recipients</>}
          </div>
          {campaign.review_note && campaign.status === 'DRAFT' && <div className="mkt-callout is-warning small">{campaign.review_note}</div>}
        </div>
        <div className="row wrap">
          {dirty.size > 0 && <span className="small muted">Unsaved changes</span>}
          {!readOnly && <button type="button" className="btn btn-primary" disabled={!dirty.size || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}
          {can('marketing.manage') && (
            <button type="button" className="btn" onClick={async () => { try { const r = await api.mkt.post(`/campaigns/${id}/duplicate`); navigate(`/marketing/campaigns/${r.campaign.id}`); toast.success('Copied as a new draft'); } catch (err) { toast.error(err); } }}>
              <Icon name="copy" size={14} /> Duplicate
            </button>
          )}
        </div>
      </div>

      {approvedOrLater && !readOnly && <div className="mkt-callout is-warning small">This campaign is {campaign.status === 'IN_REVIEW' ? 'waiting for approval' : 'approved'}. Changing its content, sender or recipients sends it back to draft for approving again.</div>}

      <div className="tabs tabs-scroll" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'setup' && (
        <fieldset disabled={readOnly} className="card card-pad stack mkt-fieldset">
          <div className="grid-2">
            <Field label="Campaign name" hint="Only your team sees this"><input className="input" value={draft.name || ''} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Owner" hint="Responsible for it, and gets follow-ups when a contact has nobody else">
              <select className="select" value={draft.owner_user_id || ''} onChange={(e) => set('owner_user_id', Number(e.target.value) || null)}>
                {users.filter((u) => u.is_active !== false).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </Field>
            <Field label="Audience">
              <select className="select" value={draft.audience_id || ''} onChange={(e) => set('audience_id', Number(e.target.value) || null)}>
                <option value="">All subscribed contacts</option>
                {meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.subscribed ?? 0} subscribed)</option>)}
              </select>
            </Field>
            <Field label="Only people in a segment (optional)">
              <select className="select" value={draft.segment_id || ''} onChange={(e) => set('segment_id', Number(e.target.value) || null)}>
                <option value="">Everyone subscribed to the audience</option>
                {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Topic" hint="People who opted out of this topic are left out">
              <select className="select" value={draft.topic_id || ''} onChange={(e) => set('topic_id', Number(e.target.value) || null)}>
                <option value="">No particular topic</option>
                {meta.topics.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Must go out by" hint="The campaign’s own task is due then">
              <input className="input" type="datetime-local" value={toDateTimeLocal(draft.deadline)} onChange={(e) => set('deadline', fromDateTimeLocal(e.target.value))} />
            </Field>
            <Field label="Sender name"><input className="input" value={draft.from_name || ''} placeholder="Default from Settings" onChange={(e) => set('from_name', e.target.value)} /></Field>
            <Field label="Sender address" hint="Only approved senders can be used">
              <input className="input" value={draft.from_email || ''} placeholder="Default from Settings" onChange={(e) => set('from_email', e.target.value)} />
            </Field>
            <Field label="Replies go to"><input className="input" value={draft.reply_to || ''} placeholder="Default from Settings" onChange={(e) => set('reply_to', e.target.value)} /></Field>
            <Field label="Count a conversion for (days after a click)">
              <input className="input" type="number" min={1} max={365} value={draft.conversion_window_days || 30} onChange={(e) => set('conversion_window_days', Number(e.target.value))} />
            </Field>
          </div>
          <div className="row wrap">
            <label className="row small"><input type="checkbox" checked={draft.track_opens !== false} onChange={(e) => set('track_opens', e.target.checked)} /> Track opens</label>
            <label className="row small"><input type="checkbox" checked={draft.track_clicks !== false} onChange={(e) => set('track_clicks', e.target.checked)} /> Track clicks</label>
            {!campaign.task_id && <label className="row small"><input type="checkbox" checked={Boolean(draft.create_task)} onChange={(e) => set('create_task', e.target.checked)} /> Make a TaskFlow task for preparing it</label>}
          </div>
        </fieldset>
      )}

      {tab === 'content' && (
        <div className="stack">
          <fieldset disabled={readOnly} className="card card-pad stack mkt-fieldset">
            <div className="row-between wrap">
              <LangSwitch value={subjectLang} onChange={setSubjectLang} hasHindi={Boolean(draft.subject_hi)} />
              <div className="row wrap">
                {!readOnly && <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}><Icon name="mail" size={13} /> Use a template</button>}
                {can('marketing.manage') && <button type="button" className="btn btn-sm" onClick={saveAsTemplate}>Save as template</button>}
              </div>
            </div>
            <div className="grid-2">
              <Field label={subjectLang === 'hi' ? 'Subject in Hindi' : 'Subject'} hint="Personalize with {{first_name|there}}">
                <div className="stack-sm">
                  <input className="input" dir="auto" aria-label={subjectLang === 'hi' ? 'Subject in Hindi' : 'Subject'} value={(subjectLang === 'hi' ? draft.subject_hi : draft.subject) || ''}
                    onChange={(e) => set(subjectLang === 'hi' ? 'subject_hi' : 'subject', e.target.value)} />
                  <AiAssist available={meta.ai} tasks={subjectLang === 'hi' ? ['translate_hi'] : ['subjects', 'translate_hi']}
                    text={draft.subject || JSON.stringify((draft.design?.blocks || []).map((b) => b.text?.en || b.text).filter(Boolean)).slice(0, 2000)}
                    context={draft.name} language={subjectLang}
                    onPick={(s, task) => set(task === 'translate_hi' || subjectLang === 'hi' ? 'subject_hi' : 'subject', s)} />
                </div>
              </Field>
              <Field label={subjectLang === 'hi' ? 'Preview text in Hindi' : 'Preview text'} hint="Shown after the subject in most inboxes">
                <div className="stack-sm">
                  <input className="input" dir="auto" aria-label={subjectLang === 'hi' ? 'Preview text in Hindi' : 'Preview text'} value={(subjectLang === 'hi' ? draft.preheader_hi : draft.preheader) || ''}
                    onChange={(e) => set(subjectLang === 'hi' ? 'preheader_hi' : 'preheader', e.target.value)} />
                  <AiAssist available={meta.ai} tasks={['preheader']} text={draft.subject || ''} context={draft.name} language={subjectLang}
                    onPick={(s) => set(subjectLang === 'hi' ? 'preheader_hi' : 'preheader', s)} />
                </div>
              </Field>
            </div>
          </fieldset>
          <EmailBuilder key={builderKey} design={draft.design} meta={meta} readOnly={readOnly} subject={draft.subject} preheader={draft.preheader}
            aiContext={`${draft.name}. ${draft.subject || ''}`} onChange={(d) => set('design', d)} />
        </div>
      )}

      {tab === 'ab' && (
        <fieldset disabled={readOnly} className="card card-pad stack mkt-fieldset">
          <label className="row"><input type="checkbox" checked={Boolean(ab)} onChange={(e) => {
            if (e.target.checked) {
              set('ab_test', { metric: 'CLICKS', test_percent: 20, wait_hours: 4 });
              if (variants.length < 2) set('variants', [{ subject: draft.subject }, { subject: '' }]);
            } else set('ab_test', null);
          }} /> <strong>Test versions against each other first</strong></label>
          <div className="small muted">A share of the audience gets each version; after the waiting time the version that did best goes to everyone else. Up to eight versions (multivariate): change the subject, preview text, sender name or the whole content.</div>
          {ab && (
            <>
              <div className="grid-3">
                <Field label="Winner decided by">
                  <select className="select" value={ab.metric} onChange={(e) => set('ab_test', { ...ab, metric: e.target.value })}>
                    <option value="CLICKS">Most clicks</option><option value="OPENS">Most opens</option><option value="REPLIES">Most replies</option><option value="MANUAL">I will choose</option>
                  </select>
                </Field>
                <Field label="Share in the test (%)" hint="Split evenly across the versions">
                  <input className="input" type="number" min={5} max={100} value={ab.test_percent} onChange={(e) => set('ab_test', { ...ab, test_percent: Number(e.target.value) })} />
                </Field>
                <Field label="Wait before deciding (hours)">
                  <input className="input" type="number" min={1} max={168} value={ab.wait_hours} onChange={(e) => set('ab_test', { ...ab, wait_hours: Number(e.target.value) })} />
                </Field>
              </div>
              {ab.metric === 'OPENS' && <div className="mkt-callout is-warning small">Opens are inflated by Apple Mail Privacy Protection; clicks are a more reliable measure.</div>}
              {variants.map((v, i) => (
                <VariantEditor key={i} variant={v} index={i} meta={meta} readOnly={readOnly} baseDesign={cleanDesign(draft.design)}
                  onChange={(nv) => set('variants', variants.map((x, j) => (j === i ? nv : x)))}
                  onRemove={() => set('variants', variants.filter((_, j) => j !== i))} />
              ))}
              {variants.length < 8 && !readOnly && (
                <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => set('variants', [...variants, { subject: '' }])}>
                  <Icon name="plus" size={13} /> Add version {VERSION_KEYS[variants.length]}
                </button>
              )}
            </>
          )}
        </fieldset>
      )}

      {tab === 'followups' && (
        <fieldset disabled={!can('marketing.manage') || campaign.status === 'CANCELLED'} className="card card-pad stack mkt-fieldset">
          <div className="small muted">When someone acts on this campaign, TaskFlow makes one follow-up task for them — an ordinary task, linked to their organization in the pipeline, due at 6 pm after the days you choose. A second action is added to the same task, never a second task. Their organization’s history records it without moving any of the pipeline’s clocks.</div>
          <label className="row"><input type="checkbox" checked={Boolean(followUp.on_reply)} onChange={(e) => set('follow_up', { ...followUp, on_reply: e.target.checked })} /> When they reply</label>
          <label className="row"><input type="checkbox" checked={Boolean(followUp.on_conversion)} onChange={(e) => set('follow_up', { ...followUp, on_conversion: e.target.checked })} /> When they convert</label>
          <label className="row"><input type="checkbox" checked={Boolean(followUp.on_click)} onChange={(e) => set('follow_up', { ...followUp, on_click: e.target.checked })} /> When a person (not a link scanner) clicks</label>
          {followUp.on_click && designLinks.length > 0 && (
            <Field label="Only for clicks on these links" hint="Leave all unticked for any link">
              <div className="stack-sm">
                {designLinks.map((u) => (
                  <label key={u} className="row small"><input type="checkbox" checked={(followUp.link_urls || []).includes(u)}
                    onChange={(e) => set('follow_up', { ...followUp, link_urls: e.target.checked ? [...(followUp.link_urls || []), u] : (followUp.link_urls || []).filter((x) => x !== u) })} /> {u}</label>
                ))}
              </div>
            </Field>
          )}
          <div className="grid-2">
            <Field label="Assign it to">
              <select className="select" value={followUp.assign || 'CONTACT_OWNER'} onChange={(e) => set('follow_up', { ...followUp, assign: e.target.value })}>
                <option value="CONTACT_OWNER">Whoever looks after the contact or their organization</option>
                <option value="CAMPAIGN_OWNER">The campaign’s owner</option>
                {users.filter((u) => u.is_active !== false).map((u) => <option key={u.id} value={String(u.id)}>{u.full_name}</option>)}
              </select>
            </Field>
            <Field label="Due after (days)" hint="A missed follow-up counts like any other missed task">
              <input className="input" type="number" min={0} max={30} value={followUp.due_days ?? 2} onChange={(e) => set('follow_up', { ...followUp, due_days: Number(e.target.value) })} />
            </Field>
          </div>
          {readOnly && can('marketing.manage') && (
            <div className="row wrap">
              <span className="small muted">Follow-up rules can still change while the campaign is sending.</span>
              <button type="button" className="btn btn-primary btn-sm" disabled={!dirty.has('follow_up')} onClick={save}>Save follow-up rules</button>
            </div>
          )}
        </fieldset>
      )}

      {tab === 'review' && (
        <div className="stack">
          {!STARTED.includes(campaign.status) && <div className="card card-pad"><Checks checks={checks} /></div>}

          {can('marketing.manage') && campaign.status !== 'CANCELLED' && (
            <div className="card card-pad stack-sm">
              <h3>Send a test</h3>
              <div className="small muted">Goes only to the addresses you give, marked [Test], and is not counted in the results. Its unsubscribe link changes nothing.</div>
              <div className="grid-3">
                <Field label="To (comma-separated)"><input className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field>
                <Field label="Personalize as contact id (optional)"><input className="input" value={testContact} onChange={(e) => setTestContact(e.target.value.replace(/\D/g, ''))} /></Field>
                <Field label="Version">
                  <select className="select" disabled={!variants.length} value={testVariant} onChange={(e) => setTestVariant(e.target.value)}>
                    <option value="">Main</option>
                    {variants.map((v, i) => <option key={i} value={VERSION_KEYS[i]}>Version {VERSION_KEYS[i]}</option>)}
                  </select>
                </Field>
              </div>
              <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={async () => {
                const r = await act('/test', { emails: testTo.split(/[,\s]+/).filter(Boolean), contact_id: testContact ? Number(testContact) : null, variant: testVariant || null });
                if (r) {
                  const bad = r.messages.filter((m) => m.status !== 'SENT');
                  if (bad.length) toast.error(`Not sent to ${bad.map((m) => `${m.email} (${m.last_error || m.skip_reason})`).join(', ')}`);
                  else toast.success(`Test sent to ${r.messages.map((m) => m.email).join(', ')}`);
                }
              }}><Icon name="send" size={14} /> Send test</button>
            </div>
          )}

          <div className="card card-pad stack-sm">
            <h3>Approval</h3>
            {campaign.status === 'DRAFT' && (
              <>
                <div className="small muted">A second person checks and approves it before anything is sent. Approval covers exactly what they saw.</div>
                {can('marketing.manage') && <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={checks?.problems?.length > 0} onClick={() => act('/submit', {}, 'Sent for approval')}>Send for approval</button>}
              </>
            )}
            {campaign.status === 'IN_REVIEW' && (
              <>
                <div className="small">Sent for approval by {campaign.submitted_by_name} {formatDate(campaign.submitted_at, { withTime: true })}.</div>
                {can('marketing.approve') && !isSubmitter && (
                  <div className="stack-sm">
                    <textarea className="textarea" rows={2} placeholder="A note (needed if you ask for changes)" value={note} onChange={(e) => setNote(e.target.value)} />
                    <div className="row wrap">
                      <button type="button" className="btn btn-primary" onClick={() => act('/approve', { note }, 'Approved')}>Approve</button>
                      <button type="button" className="btn" disabled={!note.trim()} onClick={() => act('/request-changes', { note }, 'Sent back with your note')}>Ask for changes</button>
                    </div>
                  </div>
                )}
                {isSubmitter && <div className="small muted">Someone else with approval rights approves it; they have been notified.</div>}
              </>
            )}
            {['APPROVED', 'SCHEDULED'].includes(campaign.status) && <div className="small">Approved by {campaign.approved_by_name} {formatDate(campaign.approved_at, { withTime: true })}{campaign.review_note ? ` — “${campaign.review_note}”` : ''}.</div>}
            {STARTED.includes(campaign.status) && <div className="small">Approved by {campaign.approved_by_name || '—'}; started {formatDate(campaign.started_at, { withTime: true })}.</div>}
          </div>

          {can('marketing.send') && ['APPROVED', 'SCHEDULED'].includes(campaign.status) && (
            <div className="card card-pad stack-sm">
              <h3>When it goes</h3>
              <div className="stack-sm">
                {[['NOW', 'Send now'], ['SCHEDULED', 'At a set time'], ['OPTIMIZED', 'Each person at the hour they usually open (within 24 hours of the start)']].map(([k, l]) => (
                  <label key={k} className="row"><input type="radio" name="strategy" checked={strategy === k} onChange={() => setStrategy(k)} /> {l}</label>
                ))}
                {strategy !== 'NOW' && (
                  <Field label={strategy === 'OPTIMIZED' ? 'Start from' : 'Send at'} hint="India time">
                    <input className="input" type="datetime-local" style={{ maxWidth: 260 }} value={when} onChange={(e) => setWhen(e.target.value)} />
                  </Field>
                )}
              </div>
              <div className="row wrap">
                <button type="button" className="btn btn-primary" disabled={strategy === 'SCHEDULED' && !when}
                  onClick={() => act('/schedule', { at: strategy === 'NOW' || !when ? null : fromDateTimeLocal(when), strategy }, strategy === 'NOW' ? 'Sending has started' : 'Scheduled')}>
                  <Icon name="send" size={14} /> {strategy === 'NOW' ? 'Send now' : 'Schedule'}
                </button>
                {campaign.status === 'SCHEDULED' && <button type="button" className="btn" onClick={() => act('/unschedule', {}, 'No longer scheduled')}>Unschedule</button>}
              </div>
            </div>
          )}

          {can('marketing.send') && STARTED.includes(campaign.status) && campaign.status !== 'SENT' && campaign.status !== 'CANCELLED' && (
            <div className="card card-pad stack-sm">
              <h3>While it is sending</h3>
              <div className="row wrap">
                {['SENDING', 'TESTING'].includes(campaign.status) && <button type="button" className="btn" onClick={() => act('/pause', {}, 'Paused')}>Pause</button>}
                {campaign.status === 'PAUSED' && <button type="button" className="btn btn-primary" onClick={() => act('/resume', {}, 'Resumed')}>Resume</button>}
                {campaign.status === 'TESTING' && variants.map((v, i) => (
                  <button key={i} type="button" className="btn" onClick={() => act('/finish-test', { winner: VERSION_KEYS[i] }, `Version ${VERSION_KEYS[i]} goes to everyone else`)}>Send version {VERSION_KEYS[i]} to the rest</button>
                ))}
                <ConfirmButton label="Cancel the rest" confirmLabel="Cancel unsent emails?" onConfirm={() => act('/cancel', {}, 'Cancelled; what was sent stays sent')} />
              </div>
            </div>
          )}
          {can('marketing.send') && campaign.status === 'SENT' && (
            <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={async () => { const r = await act('/retry-failed'); if (r) toast.info(`${r.requeued} failed email(s) queued again`); }}>Retry failed emails</button>
          )}
        </div>
      )}

      {tab === 'report' && <CampaignReport campaignId={campaign.id} />}

      {picking && <TemplatePicker onPick={useTemplate} onClose={() => setPicking(false)} />}
    </div>
  );
}
