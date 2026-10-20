import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile } from '../../api/client.js';
import { useAuth, useRefData, useToast } from '../../state/AppState.jsx';
import { Badge, ConfirmButton, Field, Icon, Spinner } from '../ui.jsx';
import { formatDate } from '../../lib/format.js';
import { SUPPRESSION_WORDS } from '../../lib/marketing.js';
import { CopyButton } from './parts.jsx';

const CHECK_TONE = { ok: 'good', warning: 'warning', missing: 'critical', problem: 'critical', unknown: 'neutral' };
const CHECK_WORD = { ok: 'Set up', warning: 'Check', missing: 'Missing', problem: 'Problem', unknown: 'Not checked' };

function Section({ title, children, note }) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3></div>
      <div className="card-pad stack">{note && <div className="small muted">{note}</div>}{children}</div>
    </div>
  );
}

function Festivals({ editable }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ name: '', name_hi: '', date: '', region: '', is_confirmed: false });
  const load = useCallback(() => api.mkt.get('/festivals').then((r) => setList(r.festivals)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const patch = async (f, body) => { try { await api.mkt.patch(`/festivals/${f.id}`, body); load(); } catch (err) { toast.error(err); } };
  return (
    <Section title="Festivals and seasons" note="Festival automations send only on dates someone has confirmed. Lunar festivals move every year: check each date and confirm it.">
      {!list ? <Spinner /> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Day</th><th>Date</th><th>Region</th><th>Status</th>{editable && <th />}</tr></thead>
            <tbody>
              {list.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}{f.name_hi && <div className="small muted">{f.name_hi}</div>}{f.notes && <div className="small muted">{f.notes}</div>}</td>
                  <td>{editable ? <input className="input" type="date" style={{ width: 150 }} value={f.date} onChange={(e) => patch(f, { date: e.target.value, is_confirmed: false })} /> : formatDate(f.date)}</td>
                  <td className="small">{f.region}</td>
                  <td>{f.is_confirmed ? <Badge tone="good">Confirmed</Badge> : <Badge tone="warning">Not confirmed</Badge>}</td>
                  {editable && <td>{f.is_confirmed ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => patch(f, { is_confirmed: false })}>Unconfirm</button> : <button type="button" className="btn btn-sm" onClick={() => patch(f, { is_confirmed: true })}>Confirm the date</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <div className="row wrap">
          <input className="input" style={{ width: 170 }} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" style={{ width: 140 }} placeholder="हिन्दी नाम" dir="auto" value={form.name_hi} onChange={(e) => setForm({ ...form, name_hi: e.target.value })} />
          <input className="input" style={{ width: 150 }} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <input className="input" style={{ width: 130 }} placeholder="Region" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
          <label className="row small"><input type="checkbox" checked={form.is_confirmed} onChange={(e) => setForm({ ...form, is_confirmed: e.target.checked })} /> Date checked</label>
          <button type="button" className="btn btn-sm" disabled={!form.name || !form.date} onClick={async () => { try { await api.mkt.post('/festivals', form); setForm({ name: '', name_hi: '', date: '', region: '', is_confirmed: false }); load(); } catch (err) { toast.error(err); } }}>Add</button>
        </div>
      )}
    </Section>
  );
}

function Suppressions({ editable, canExport }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [search, setSearch] = useState('');
  const [add, setAdd] = useState({ email: '', note: '' });
  const load = useCallback(() => api.mkt.get('/suppressions', { search }).then((r) => setList(r.suppressions)).catch(() => {}), [search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  return (
    <Section title="Never email" note="Addresses no campaign or automation will ever send to: hard bounces, spam complaints, people who unsubscribed from everything, and any you add. Hard bounces and complaints can never be lifted; an unsubscribe only by the person, from a signup form they confirm.">
      <div className="row wrap">
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search addresses" value={search} onChange={(e) => setSearch(e.target.value)} />
        {canExport && <button type="button" className="btn btn-sm" onClick={() => downloadFile(api.mkt.url('/suppressions.csv'), 'suppressions.csv').catch((err) => toast.error(err))}><Icon name="download" size={13} /> Export</button>}
        {canExport && <button type="button" className="btn btn-sm" onClick={() => downloadFile(api.mkt.url('/consents.csv'), 'consent-records.csv').catch((err) => toast.error(err))}><Icon name="download" size={13} /> Consent records</button>}
      </div>
      {!list ? <Spinner /> : list.length === 0 ? <div className="empty small">Nobody yet.</div> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>Address</th><th>Why</th><th>Since</th>{editable && <th />}</tr></thead>
          <tbody>{list.map((s) => (
            <tr key={s.email_normalized}>
              <td>{s.email_normalized}</td><td className="small">{SUPPRESSION_WORDS[s.reason] || s.reason}{s.note && <div className="muted">{s.note}</div>}</td>
              <td className="small">{formatDate(s.created_at)}</td>
              {editable && <td>{['MANUAL', 'SOFT_BOUNCES'].includes(s.reason) && (
                <ConfirmButton className="btn btn-ghost btn-sm" label="Lift" confirmLabel="Email them again?" onConfirm={async () => {
                  try { await api.mkt.del(`/suppressions/${encodeURIComponent(s.email_normalized)}`, { note: 'Checked by a colleague' }); load(); toast.success('Lifted'); } catch (err) { toast.error(err); }
                }} />
              )}</td>}
            </tr>
          ))}</tbody></table></div>
      )}
      {editable && (
        <div className="row wrap">
          <input className="input" style={{ width: 240 }} placeholder="address@example.com" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} />
          <input className="input" style={{ width: 240 }} placeholder="Why (optional)" value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} />
          <button type="button" className="btn btn-sm" disabled={!add.email.includes('@')} onClick={async () => { try { await api.mkt.post('/suppressions', add); setAdd({ email: '', note: '' }); load(); } catch (err) { toast.error(err); } }}>Block</button>
        </div>
      )}
    </Section>
  );
}

function Outbox() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api.mkt.get('/dev/outbox').then((r) => setList(r.messages)).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  return (
    <Section title="Outbox (nothing is delivered)" note="With no email provider set, TaskFlow builds every email exactly as it would send it and keeps the last 50 here, in memory. Simulate what a provider would report to try bounces and complaints.">
      <div className="row"><button type="button" className="btn btn-sm" onClick={load}>Refresh</button></div>
      {!list ? <Spinner /> : list.length === 0 ? <div className="empty small">Empty. Run the worker or send a test.</div> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>To</th><th>Subject</th><th>At</th><th /></tr></thead>
          <tbody>{list.map((m) => (
            <tr key={`${m.providerMessageId}`}>
              <td>{m.to}</td><td className="small">{m.subject}</td><td className="small">{formatDate(m.at, { withTime: true })}</td>
              <td><div className="row" style={{ gap: 4 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === m.providerMessageId ? null : m.providerMessageId)}>View</button>
              </div></td>
            </tr>
          ))}</tbody></table></div>
      )}
      {open && list && (() => {
        const m = list.find((x) => x.providerMessageId === open);
        return m ? (
          <div className="stack-sm">
            <div className="small dim">Reference {m.reference} · {m.size} bytes</div>
            <iframe title="Outbox email" sandbox="" srcDoc={m.html} className="mkt-outbox-frame" />
            <div className="row wrap">
              {['DELIVERED', 'BOUNCE_HARD', 'BOUNCE_SOFT', 'COMPLAINT', 'REPLY'].map((type) => (
                <button key={type} type="button" className="btn btn-sm" onClick={async () => {
                  try {
                    const r = await api.mkt.post('/dev/simulate', { message_id: Number(m.message_id), type });
                    toast.success(r.recorded ? `${type.toLowerCase().replace('_', ' ')} recorded` : 'Already recorded');
                  } catch (err) { toast.error(err); }
                }} disabled={!m.message_id}>{type.toLowerCase().replace('_', ' ')}</button>
              ))}
            </div>
          </div>
        ) : null;
      })()}
    </Section>
  );
}

export default function MarketingSettings({ onSaved }) {
  const toast = useToast();
  const { can } = useAuth();
  const { departments } = useRefData();
  const [view, setView] = useState(null);
  const [s, setS] = useState(null);
  const [dns, setDns] = useState(null);
  const [checking, setChecking] = useState(false);
  const editable = can('marketing.settings');

  const load = useCallback(() => api.mkt.get('/settings').then((r) => { setView(r); setS(r.settings); }).catch((err) => toast.error(err)), []);
  useEffect(() => { load(); }, [load]);
  if (!view || !s) return <Spinner />;

  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const setIn = (k, sub, v) => setS((x) => ({ ...x, [k]: { ...x[k], [sub]: v } }));
  const save = async () => {
    try {
      const r = await api.mkt.put('/settings', {
        enabled: s.enabled, company: s.company, postalAddress: s.postalAddress, defaultFromName: s.defaultFromName, defaultFromEmail: s.defaultFromEmail,
        defaultReplyTo: s.defaultReplyTo, replyPlusAddressing: s.replyPlusAddressing, senders: s.senders, sendingDomain: s.sendingDomain,
        dkimSelectors: s.dkimSelectors, approvals: s.approvals, limits: s.limits, followUps: s.followUps, crmSync: s.crmSync, replies: s.replies,
        softBounceLimit: s.softBounceLimit, sto: s.sto,
      });
      setView(r); setS(r.settings);
      toast.success('Settings saved');
      onSaved?.();
    } catch (err) { toast.error(err); }
  };
  const runNow = async (path, label) => {
    try {
      const r = await api.mkt.post(path, {});
      const counts = r.queue ? { sent: r.queue.sent, skipped: r.queue.skipped, failed: r.queue.failed } : r;
      const words = Object.entries(counts).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
      toast.success(`${label}: ${words || r.skipped || 'nothing waiting'}`);
    } catch (err) { toast.error(err); }
  };
  const p = view.provider;

  return (
    <div className="stack">
      {!editable && <div className="mkt-callout is-warning small">You can see these settings; changing them needs the email marketing settings permission.</div>}

      <Section title="Sending" note="The provider and its keys are set on the server (environment variables), never here, so a credential is never shown on screen or stored in the database.">
        <div className="row wrap">
          <Badge tone={p.configured ? (p.delivers ? 'good' : 'warning') : 'critical'}>{p.label}</Badge>
          {p.configured && !p.delivers && <span className="small">Emails are built and recorded but not delivered. Set EMAIL_PROVIDER to ses, brevo or smtp to send.</span>}
          {!p.configured && <span className="small">Missing on the server: {p.missing.join(', ')}</span>}
          {p.region && <span className="small muted">Region {p.region}</span>}
        </div>
        {p.configured && p.delivers && (
          <div className="small dim">Reports back: delivery {p.events.delivery ? 'yes' : 'no'} · bounces {p.events.bounce ? 'yes' : 'no'} · spam complaints {p.events.complaint ? 'yes' : 'no'}{!p.events.bounce && ' — with SMTP, bounces are not suppressed automatically; prefer Amazon SES or Brevo for bulk email.'}</div>
        )}
        <div className="small muted">Background sender: {view.worker.enabled ? `on, every ${view.worker.interval_seconds} seconds` : 'off on this server (MARKETING_WORKER or ENABLE_SCANNER is false)'} · Writing assistant: {view.keys.anthropic ? 'on' : 'off (ANTHROPIC_API_KEY)'}</div>
        {editable && <div className="row"><button type="button" className="btn btn-sm" onClick={() => runNow('/worker/run', 'Worker ran')}>Run the sender now</button></div>}
      </Section>

      <fieldset disabled={!editable} className="stack mkt-fieldset">
        <Section title="Sender and footer" note="Every email’s footer shows the company, its postal address, why the person gets it, and links to unsubscribe and change preferences. Gmail, Yahoo and India’s data protection rules expect these.">
          <div className="grid-2">
            <Field label="Company name"><input className="input" value={s.company} onChange={(e) => set('company', e.target.value)} /></Field>
            <Field label="Postal address" hint="Required before anything can be sent"><input className="input" value={s.postalAddress} onChange={(e) => set('postalAddress', e.target.value)} placeholder="Street, city, state, PIN" /></Field>
            <Field label="Default sender name"><input className="input" value={s.defaultFromName} onChange={(e) => set('defaultFromName', e.target.value)} /></Field>
            <Field label="Default sender address" hint="On your authenticated sending domain"><input className="input" value={s.defaultFromEmail} onChange={(e) => set('defaultFromEmail', e.target.value)} placeholder="news@ekosight.com" /></Field>
            <Field label="Replies go to" hint="A mailbox someone reads"><input className="input" value={s.defaultReplyTo} onChange={(e) => set('defaultReplyTo', e.target.value)} placeholder="hello@ekosight.com" /></Field>
            <Field label="Approved senders" hint="Comma-separated. When set, only these addresses can send.">
              <input className="input" value={(s.senders || []).map((x) => x.email).join(', ')} onChange={(e) => set('senders', e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((email) => ({ email })))} />
            </Field>
          </div>
          <label className="row small"><input type="checkbox" checked={Boolean(s.replyPlusAddressing)} onChange={(e) => set('replyPlusAddressing', e.target.checked)} /> Add a code to the reply address (replies+code@…) so each reply is matched to the email it answers. Google Workspace delivers these to the same mailbox.</label>
        </Section>

        <Section title="Domain authentication" note="SPF, DKIM and DMARC prove your emails are really from you. Gmail and Yahoo require all three of bulk senders.">
          <div className="grid-2">
            <Field label="Sending domain"><input className="input" value={s.sendingDomain} onChange={(e) => set('sendingDomain', e.target.value)} placeholder="ekosight.com" /></Field>
            <Field label="DKIM selectors" hint="Comma-separated, from your provider (not needed for Amazon SES)"><input className="input" value={(s.dkimSelectors || []).join(', ')} onChange={(e) => set('dkimSelectors', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>
          </div>
          <div className="row"><button type="button" className="btn btn-sm" disabled={checking} onClick={async () => { setChecking(true); try { setDns(await api.mkt.post('/settings/dns-check', { domain: s.sendingDomain || undefined })); } catch (err) { toast.error(err); } finally { setChecking(false); } }}>{checking ? 'Checking…' : 'Check DNS now'}</button></div>
          {dns && (
            <div className="stack-sm">
              {dns.error && <div className="field-error">{dns.error}</div>}
              {(dns.checks || []).map((c) => (
                <div key={c.key} className="mkt-subcard stack-sm">
                  <div className="row"><strong>{c.label}</strong><Badge tone={CHECK_TONE[c.status]}>{CHECK_WORD[c.status]}</Badge></div>
                  <code className="small mkt-code">{c.detail}</code>
                  {c.fix && <div className="small">{c.fix}</div>}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Rules">
          <label className="row small"><input type="checkbox" checked={Boolean(s.approvals?.required)} onChange={(e) => setIn('approvals', 'required', e.target.checked)} /> A second person approves every campaign and automation before it sends</label>
          <label className="row small"><input type="checkbox" checked={Boolean(s.approvals?.allowSelfApproval)} onChange={(e) => setIn('approvals', 'allowSelfApproval', e.target.checked)} /> Allow people to approve their own (not recommended)</label>
          <div className="grid-3">
            <Field label="Most marketing emails to one person a day" hint="0 means no limit"><input className="input" type="number" min={0} max={20} value={s.limits?.perContactPerDay ?? 1} onChange={(e) => setIn('limits', 'perContactPerDay', Number(e.target.value))} /></Field>
            <Field label="…and a week"><input className="input" type="number" min={0} max={50} value={s.limits?.perContactPerWeek ?? 3} onChange={(e) => setIn('limits', 'perContactPerWeek', Number(e.target.value))} /></Field>
            <Field label="Sending rate (emails a minute)" hint="Keep within your provider’s limit"><input className="input" type="number" min={1} max={3000} value={s.limits?.ratePerMinute ?? 120} onChange={(e) => setIn('limits', 'ratePerMinute', Number(e.target.value))} /></Field>
            <Field label="Temporary bounces before blocking"><input className="input" type="number" min={1} max={10} value={s.softBounceLimit ?? 3} onChange={(e) => set('softBounceLimit', Number(e.target.value))} /></Field>
            <Field label="Send-time optimization: hour for people with no history" hint="India time"><input className="input" type="number" min={0} max={23} value={s.sto?.defaultHour ?? 10} onChange={(e) => setIn('sto', 'defaultHour', Number(e.target.value))} /></Field>
            <Field label="Follow-up tasks due after (days)"><input className="input" type="number" min={0} max={30} value={s.followUps?.dueDays ?? 2} onChange={(e) => setIn('followUps', 'dueDays', Number(e.target.value))} /></Field>
            <Field label="Department for follow-ups of people with none">
              <select className="select" value={s.followUps?.departmentId || ''} onChange={(e) => setIn('followUps', 'departmentId', Number(e.target.value) || null)}>
                <option value="">The assignee’s own</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="small muted">A campaign over the limit skips that person; an automation step waits a day.</div>
        </Section>

        <Section title="Pipeline and replies">
          <label className="row small"><input type="checkbox" checked={Boolean(s.crmSync?.enabled)} onChange={(e) => setIn('crmSync', 'enabled', e.target.checked)} /> Keep audiences in step with the pipeline (hourly): people at matching organizations join, and leave when the organization stops matching</label>
          <div className="small muted">Check before switching on: emailing business contacts relies on your existing relationship with them. Anyone who unsubscribes is never added back.</div>
          {editable && <div className="row"><button type="button" className="btn btn-sm" onClick={() => runNow('/settings/sync-crm', 'Pipeline sync')}>Sync now</button></div>}
          <label className="row small"><input type="checkbox" checked={Boolean(s.replies?.enabled)} onChange={(e) => setIn('replies', 'enabled', e.target.checked)} /> Read replies from a Google Workspace mailbox</label>
          <div className="grid-2">
            <Field label="Reply mailbox" hint="Uses the Google Chat service account, with gmail.readonly granted for this one mailbox"><input className="input" value={s.replies?.mailbox || ''} onChange={(e) => setIn('replies', 'mailbox', e.target.value)} placeholder="replies@ekosight.com" /></Field>
            <Field label="Look back (days)"><input className="input" type="number" min={1} max={30} value={s.replies?.lookbackDays ?? 3} onChange={(e) => setIn('replies', 'lookbackDays', Number(e.target.value))} /></Field>
          </div>
          {view.replies.enabled && !view.replies.usable && <div className="mkt-callout is-warning small">Not reading yet — missing: {view.replies.missing.join(', ')}</div>}
          {editable && view.replies.usable && <div className="row"><button type="button" className="btn btn-sm" onClick={() => runNow('/settings/sync-replies', 'Replies read')}>Read replies now</button></div>}
        </Section>

        <Section title="Module">
          <label className="row small"><input type="checkbox" checked={s.enabled !== false} onChange={(e) => set('enabled', e.target.checked)} /> Email marketing is switched on. Off hides it for everyone; links in emails already sent (unsubscribe, preferences) keep working.</label>
        </Section>
        {editable && <div className="row"><button type="button" className="btn btn-primary" onClick={save}>Save settings</button></div>}
      </fieldset>

      <Section title="Addresses for your provider and website" note="Set these up where each service asks for a webhook or callback. The parts in angle brackets are the values from the server’s environment.">
        {Object.entries({ 'Amazon SES events (SNS subscription, HTTPS)': view.endpoints.ses_sns, 'Brevo webhook': view.endpoints.brevo, 'Inbound replies (Postmark, Mailgun, SendGrid)': view.endpoints.inbound, 'Website conversions (POST from your server, header X-TaskFlow-Key)': view.endpoints.conversions }).map(([label, url]) => (
          <div key={label} className="stack-sm">
            <div className="small dim">{label}</div>
            <div className="row"><code className="small mkt-code grow">{url}</code><CopyButton text={url} /></div>
          </div>
        ))}
        <div className="small muted">Keys present on the server: webhook secret {view.keys.webhook_secret ? 'yes' : 'no'} · conversion key {view.keys.conversion_key ? 'yes' : 'no'} · inbound key {view.keys.inbound_key ? 'yes' : 'no'}</div>
      </Section>

      <Festivals editable={editable} />
      <Suppressions editable={editable} canExport={can('marketing.export')} />
      {p.name === 'log' && editable && <Outbox />}
    </div>
  );
}
