import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadFile } from '../../api/client.js';
import { useAuth, useRefData, useToast } from '../../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from '../ui.jsx';
import { formatDate, relativeTime } from '../../lib/format.js';
import {
  ADDRESS_STATUS, EVENT_WORDS, IMPORT_FIELDS, MESSAGE_STATUS, SUPPRESSION_WORDS, personName, skipWords, sourceWords,
} from '../../lib/marketing.js';
import { MembershipBadge } from './parts.jsx';

const BASIS_EXAMPLES = ['Signed up at our stall at Krishi Mela 2026', 'Existing customer: bought Soil Doctor', 'Asked for information on a call', 'Dealer agreement includes email updates'];

function AddContact({ meta, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', phone: '', organization: '', city: '', state: '', language: 'en', tags: '', audience_ids: [], basis: '' });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    try {
      const r = await api.mkt.post('/contacts', { ...form, tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean), basis: form.basis || undefined });
      toast.success(r.created ? 'Contact added' : 'That address was already here; blank details were filled in');
      for (const j of r.joined || []) if (j.result === 'SUPPRESSED' || j.result === 'KEPT_UNSUBSCRIBED') toast.info('They unsubscribed or bounced before, so they were not added back to the audience');
      onSaved(r.contact);
    } catch (err) { toast.error(err); }
  };
  return (
    <Modal title="Add a contact" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!form.email.includes('@')} onClick={save}>Add</button></>}>
      <div className="stack">
        <div className="grid-2">
          <Field label="Email address"><input className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoFocus /></Field>
          <Field label="Language they read">
            <select className="select" value={form.language} onChange={(e) => set('language', e.target.value)}><option value="en">English</option><option value="hi">Hindi</option></select>
          </Field>
          <Field label="First name"><input className="input" value={form.first_name} onChange={(e) => set('first_name', e.target.value)} /></Field>
          <Field label="Last name"><input className="input" value={form.last_name} onChange={(e) => set('last_name', e.target.value)} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="Organization"><input className="input" value={form.organization} onChange={(e) => set('organization', e.target.value)} /></Field>
          <Field label="City or village"><input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="State"><input className="input" value={form.state} onChange={(e) => set('state', e.target.value)} /></Field>
        </div>
        <Field label="Tags" hint="Comma-separated"><input className="input" value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="farmer, sehore" /></Field>
        <Field label="Audiences">
          <div className="row wrap">
            {meta.audiences.map((a) => (
              <label key={a.id} className="row small mkt-chip-check"><input type="checkbox" checked={form.audience_ids.includes(a.id)}
                onChange={(e) => set('audience_ids', e.target.checked ? [...form.audience_ids, a.id] : form.audience_ids.filter((x) => x !== a.id))} /> {a.name}</label>
            ))}
          </div>
        </Field>
        {form.audience_ids.length > 0 && (
          <Field label="How did they agree to hear from you?" hint="Kept in their consent record. Required to put someone on an audience.">
            <input className="input" list="basis-examples" value={form.basis} onChange={(e) => set('basis', e.target.value)} />
            <datalist id="basis-examples">{BASIS_EXAMPLES.map((b) => <option key={b} value={b} />)}</datalist>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function ImportWizard({ meta, onClose, onDone }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState([]);
  const [opts, setOpts] = useState({ audience_id: '', status: 'SUBSCRIBED', basis: '', tags: '', mode: 'fill' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const fields = [...IMPORT_FIELDS, ...meta.custom_fields.map((f) => [`custom.${f.key}`, f.label])];

  const read = async (f) => {
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) return toast.error('The file is larger than 15 MB; split it into smaller files');
    const content = await f.text();
    setFile(f);
    setText(content);
    try {
      const p = await api.mkt.send('/contacts/import/preview', content, 'text/csv');
      setPreview(p);
      setMapping(p.mapping.map((m) => m || ''));
    } catch (err) { toast.error(err); }
    return undefined;
  };

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.mkt.send('/contacts/import', text, 'text/csv', {
        ...opts, audience_id: opts.audience_id || undefined, filename: file?.name, mapping: JSON.stringify(mapping.map((m) => m || null)),
      });
      setResult(r);
      onDone();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <Modal title="Import contacts" size="lg" onClose={onClose}
      footer={result ? <button type="button" className="btn btn-primary" onClick={onClose}>Done</button> : (
        <><button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!preview || !mapping.includes('email') || busy || opts.basis.trim().length < 5} onClick={run}>{busy ? 'Importing…' : `Import ${preview?.rows ?? ''} rows`}</button></>
      )}>
      {result ? (
        <div className="stack">
          <div className="stat-grid">
            {[['created', 'New contacts'], ['updated', 'Updated'], ['unchanged', 'Already up to date'], ['subscribed', 'Added to the audience'], ['not_resubscribed', 'Unsubscribed before — not added back'], ['suppressed', 'Blocked addresses — not added'], ['duplicate_in_file', 'Repeated in the file'], ['invalid', 'Not an email address']].map(([k, l]) => (
              <div key={k} className="stat" style={{ cursor: 'default' }}><span className="stat-label">{l}</span><span className="stat-value tnum">{result.totals[k] || 0}</span></div>
            ))}
          </div>
          {result.problems.length > 0 && (
            <div className="table-wrap"><table className="data"><thead><tr><th>Line</th><th>Value</th><th>Problem</th></tr></thead>
              <tbody>{result.problems.slice(0, 50).map((p) => <tr key={p.line}><td>{p.line}</td><td>{p.email}</td><td>{p.problem}</td></tr>)}</tbody></table></div>
          )}
        </div>
      ) : (
        <div className="stack">
          <label className="mkt-dropfile">
            <Icon name="paperclip" /> {file ? file.name : 'Choose a CSV file (Excel: Save as → CSV UTF-8)'}
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => read(e.target.files?.[0])} />
          </label>
          {preview && (
            <>
              <div className="small muted">{preview.rows} rows. Choose what each column is — the same address twice becomes one contact, and an address already here is updated, not duplicated.</div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr>{preview.header.map((h, i) => (
                    <th key={i} style={{ minWidth: 150 }}>
                      <div className="stack-sm">
                        <span>{h}</span>
                        <select className="select select-sm" value={mapping[i] || ''} onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? e.target.value : x)))}>
                          {fields.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </div>
                    </th>
                  ))}</tr></thead>
                  <tbody>{preview.sample.map((row, r) => <tr key={r}>{preview.header.map((_, i) => <td key={i} className="small">{row[i]}</td>)}</tr>)}</tbody>
                </table>
              </div>
              {!mapping.includes('email') && <div className="field-error">Choose the column that holds the email address.</div>}
              <div className="grid-2">
                <Field label="Add them to">
                  <select className="select" value={opts.audience_id} onChange={(e) => setOpts({ ...opts, audience_id: e.target.value })}>
                    <option value="">The contact database only</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
                {opts.audience_id && (
                  <Field label="As">
                    <select className="select" value={opts.status} onChange={(e) => setOpts({ ...opts, status: e.target.value })}>
                      <option value="SUBSCRIBED">Subscribed (they already agreed)</option>
                      <option value="PENDING">Waiting to confirm (no email is sent; use a form for double opt-in)</option>
                    </select>
                  </Field>
                )}
                <Field label="How did these people agree to hear from you?" hint="Required. Written into each person’s consent record with the file name.">
                  <input className="input" list="basis-examples-import" value={opts.basis} onChange={(e) => setOpts({ ...opts, basis: e.target.value })} />
                  <datalist id="basis-examples-import">{BASIS_EXAMPLES.map((b) => <option key={b} value={b} />)}</datalist>
                </Field>
                <Field label="Tag everyone with" hint="Comma-separated"><input className="input" value={opts.tags} onChange={(e) => setOpts({ ...opts, tags: e.target.value })} /></Field>
                <Field label="When an address is already here">
                  <select className="select" value={opts.mode} onChange={(e) => setOpts({ ...opts, mode: e.target.value })}>
                    <option value="fill">Only fill in what is blank</option><option value="overwrite">Replace with the file’s values</option>
                  </select>
                </Field>
              </div>
              <div className="small muted">Nobody who unsubscribed, bounced or marked an email as spam is ever re-subscribed by an import.</div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Everything about one person, and what can be done for them. */
export function ContactDrawer({ contactId, meta, onClose, onChanged }) {
  const toast = useToast();
  const { can } = useAuth();
  const { users } = useRefData();
  const [d, setD] = useState(null);
  const [edit, setEdit] = useState(null);
  const [tab, setTab] = useState('activity');
  const [join, setJoin] = useState({ audience_id: '', basis: '' });
  const [noteText, setNoteText] = useState('');

  const load = useCallback(() => api.mkt.get(`/contacts/${contactId}`).then((r) => { setD(r); setEdit(null); }).catch((err) => toast.error(err)), [contactId]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <Modal title="Contact" onClose={onClose}><Spinner /></Modal>;
  const c = d.contact;
  const manage = can('marketing.manage');
  const run = async (fn, success) => { try { await fn(); toast.success(success); await load(); onChanged?.(); } catch (err) { toast.error(err); } };

  return (
    <Modal size="lg" onClose={onClose} title={(
      <div className="stack-sm">
        <h2 className="truncate">{personName(c)}</h2>
        <div className="row wrap small">
          <span className="muted">{c.email}</span>
          <Badge tone={ADDRESS_STATUS[c.email_status]?.tone}>{ADDRESS_STATUS[c.email_status]?.label}</Badge>
          <Badge tone="brand" title="0–100, from opens, clicks, replies and conversions in the last 90 days; newer counts more">Engagement {c.engagement_score}</Badge>
          {c.account_id && <Link to={`/accounts/${c.account_id}`} className="badge">{c.account_name} · {c.account_type?.toLowerCase()}</Link>}
        </div>
      </div>
    )}>
      <div className="stack">
        {d.suppression && <div className="mkt-callout is-critical small">Never emailed: {SUPPRESSION_WORDS[d.suppression.reason] || d.suppression.reason} ({formatDate(d.suppression.created_at)}).</div>}
        <div className="tabs" role="tablist">
          {[['activity', 'Activity'], ['details', 'Details'], ['lists', 'Audiences & preferences'], ['consent', 'Consent record']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>

        {tab === 'activity' && (
          <div className="stack">
            {d.followups.length > 0 && (
              <div className="stack-sm">
                <h3>Follow-up tasks</h3>
                {d.followups.map((f) => (
                  <div key={f.id} className="row small"><Link className="task-ref" to={`?task=${f.task_id}`}>{f.task_ref || 'task'}</Link><span className="grow truncate">{f.task_title}</span>{f.task_stage === 'done' && <Badge tone="good">done</Badge>}</div>
                ))}
              </div>
            )}
            <h3>Emails</h3>
            {d.messages.length === 0 ? <div className="empty small">Nothing sent yet.</div> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Email</th><th>Status</th><th>Opened</th><th>Clicked</th><th>Replied</th>{manage && <th />}</tr></thead>
                  <tbody>
                    {d.messages.map((m) => (
                      <tr key={m.id}>
                        <td>{m.campaign_name || m.workflow_name}<div className="small muted">{m.subject} · {formatDate(m.sent_at, { withTime: true })}</div></td>
                        <td>{MESSAGE_STATUS[m.status]}{m.skip_reason && <div className="small muted">{skipWords(m.skip_reason)}</div>}</td>
                        <td>{m.first_opened_at ? relativeTime(m.first_opened_at) : '—'}</td>
                        <td>{m.first_clicked_at ? `${relativeTime(m.first_clicked_at)} (${m.click_count})` : '—'}</td>
                        <td>{m.replied_at ? relativeTime(m.replied_at) : '—'}</td>
                        {manage && (
                          <td><div className="row" style={{ gap: 4 }}>
                            {!m.replied_at && m.sent_at && <button type="button" className="btn btn-ghost btn-sm" title="They replied by phone, WhatsApp or another inbox" onClick={() => run(() => api.mkt.post(`/messages/${m.id}/events`, { type: 'REPLY', note: 'Recorded by a colleague' }), 'Reply recorded')}>Mark replied</button>}
                            {!m.converted_at && m.sent_at && <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => api.mkt.post(`/messages/${m.id}/events`, { type: 'CONVERSION', note: 'Recorded by a colleague' }), 'Conversion recorded')}>Mark converted</button>}
                          </div></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3>What happened</h3>
            <div className="stack-sm">
              {d.events.slice(0, 60).map((e) => (
                <div key={e.id} className="row small">
                  <span className="tnum muted" style={{ width: 120 }}>{formatDate(e.occurred_at, { withTime: true })}</span>
                  <span className="grow">{EVENT_WORDS[e.type]}{e.campaign_name ? ` · ${e.campaign_name}` : ''}{e.url ? ` · ${e.url}` : ''}{e.meta?.snippet ? ` — “${e.meta.snippet}”` : ''}</span>
                  {e.is_machine && <Badge title="An automatic open or click by a mail system or link scanner">automatic</Badge>}
                  <span className="muted">{e.type === 'SENT' ? 'Handed to the provider' : sourceWords(e.source)}</span>
                </div>
              ))}
              {d.events.length === 0 && <div className="empty small">No activity yet.</div>}
            </div>
            {manage && (
              <div className="row">
                <input className="input" placeholder="Add a note to their history" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
                <button type="button" className="btn" disabled={!noteText.trim()} onClick={() => run(() => api.mkt.post(`/contacts/${c.id}/notes`, { note: noteText }).then(() => setNoteText('')), 'Note added')}>Add</button>
              </div>
            )}
          </div>
        )}

        {tab === 'details' && (
          <fieldset disabled={!manage} className="stack mkt-fieldset">
            {(() => {
              const v = edit || c;
              const set = (k, val) => setEdit({ ...(edit || c), [k]: val });
              return (
                <>
                  <div className="grid-2">
                    {[['email', 'Email address'], ['first_name', 'First name'], ['last_name', 'Last name'], ['phone', 'Phone'], ['organization', 'Organization'], ['designation', 'Designation'], ['city', 'City or village'], ['state', 'State'], ['country', 'Country']].map(([k, l]) => (
                      <Field key={k} label={l}><input className="input" value={v[k] || ''} onChange={(e) => set(k, e.target.value)} /></Field>
                    ))}
                    <Field label="Language">
                      <select className="select" value={v.language} onChange={(e) => set('language', e.target.value)}><option value="en">English</option><option value="hi">Hindi</option></select>
                    </Field>
                    <Field label="Looks after them" hint="Gets their follow-up tasks; otherwise their organization’s owner does">
                      <select className="select" value={v.owner_user_id || ''} onChange={(e) => set('owner_user_id', Number(e.target.value) || null)}>
                        <option value="">Their organization’s owner</option>{users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </select>
                    </Field>
                    <Field label="Tags" hint="Comma-separated"><input className="input" value={(v.tags || []).join(', ')} onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))} /></Field>
                  </div>
                  <h3>Custom fields</h3>
                  <div className="grid-3">
                    {meta.custom_fields.map((f) => (
                      <Field key={f.key} label={f.label}>
                        {f.type === 'SELECT' ? (
                          <select className="select" value={v.custom?.[f.key] || ''} onChange={(e) => set('custom', { ...(v.custom || {}), [f.key]: e.target.value })}>
                            <option value="" />{(f.options || []).map((o) => <option key={o}>{o}</option>)}
                          </select>
                        ) : (
                          <input className="input" type={f.type === 'DATE' ? 'date' : f.type === 'NUMBER' ? 'number' : 'text'} value={v.custom?.[f.key] || ''}
                            onChange={(e) => set('custom', { ...(v.custom || {}), [f.key]: e.target.value })} />
                        )}
                      </Field>
                    ))}
                  </div>
                  <div className="small muted">Added {formatDate(c.created_at)} · {sourceWords(c.source)}{c.best_send_hour !== null ? ` · usually opens around ${c.best_send_hour}:00` : ''}</div>
                  {manage && (
                    <div className="row wrap">
                      <button type="button" className="btn btn-primary" disabled={!edit} onClick={() => run(() => api.mkt.patch(`/contacts/${c.id}`, {
                        email: edit.email, first_name: edit.first_name, last_name: edit.last_name, phone: edit.phone, organization: edit.organization, designation: edit.designation,
                        city: edit.city, state: edit.state, country: edit.country, language: edit.language, tags: edit.tags, custom: edit.custom, owner_user_id: edit.owner_user_id || null,
                      }), 'Saved')}>Save</button>
                      <button type="button" className="btn" onClick={() => run(() => api.mkt.post(`/contacts/${c.id}/archive`, { archived: !c.is_archived }), c.is_archived ? 'Restored' : 'Archived')}>{c.is_archived ? 'Restore' : 'Archive'}</button>
                    </div>
                  )}
                </>
              );
            })()}
          </fieldset>
        )}

        {tab === 'lists' && (
          <div className="stack">
            <div className="stack-sm">
              {d.memberships.map((m) => (
                <div key={m.audience_id} className="row-between mkt-row">
                  <div className="row"><span className="chip-dot" style={{ background: m.color || 'var(--axis)' }} /> {m.audience_name} <MembershipBadge status={m.status} />{m.synced && <span className="small muted">from the pipeline</span>}</div>
                  {manage && ['SUBSCRIBED', 'PENDING'].includes(m.status) && (
                    <div className="row">
                      <button type="button" className="btn btn-ghost btn-sm" title="Not their choice: take them off without recording an unsubscribe" onClick={() => run(() => api.mkt.del(`/contacts/${c.id}/audiences/${m.audience_id}`), 'Removed from the audience')}>Remove</button>
                      <button type="button" className="btn btn-ghost btn-sm" title="They asked a colleague to stop" onClick={() => run(() => api.mkt.post(`/contacts/${c.id}/unsubscribe`, { audience_id: m.audience_id, reason: 'Asked a colleague' }), 'Unsubscribed')}>They asked to stop</button>
                    </div>
                  )}
                </div>
              ))}
              {d.memberships.length === 0 && <div className="empty small">Not on any audience.</div>}
            </div>
            {manage && !c.unsubscribed_all_at && !d.suppression && (
              <div className="mkt-subcard stack-sm">
                <div className="grid-2">
                  <Field label="Add to">
                    <select className="select" value={join.audience_id} onChange={(e) => setJoin({ ...join, audience_id: e.target.value })}>
                      <option value="">Choose…</option>{meta.audiences.filter((a) => !d.memberships.some((m) => m.audience_id === a.id && ['SUBSCRIBED', 'PENDING'].includes(m.status))).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </Field>
                  <Field label="How they agreed">
                    <input className="input" list="basis-examples-drawer" value={join.basis} onChange={(e) => setJoin({ ...join, basis: e.target.value })} />
                    <datalist id="basis-examples-drawer">{BASIS_EXAMPLES.map((b) => <option key={b} value={b} />)}</datalist>
                  </Field>
                </div>
                <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} disabled={!join.audience_id || join.basis.trim().length < 5}
                  onClick={() => run(async () => {
                    const r = await api.mkt.post(`/contacts/${c.id}/audiences`, { audience_id: Number(join.audience_id), basis: join.basis });
                    if (['KEPT_UNSUBSCRIBED', 'SUPPRESSED'].includes(r.result)) throw new Error('They unsubscribed or bounced before; only they can subscribe again, through a signup form');
                    setJoin({ audience_id: '', basis: '' });
                  }, 'Added')}>Add to audience</button>
              </div>
            )}
            <h3>What they want to hear about</h3>
            <div className="stack-sm">
              {d.topics.map((t) => (
                <label key={t.id} className="row small"><input type="checkbox" checked={t.opted_in} disabled={!manage}
                  onChange={(e) => run(() => api.mkt.put(`/contacts/${c.id}/topics`, { choices: { [t.id]: e.target.checked } }), 'Preference saved')} /> {t.name}</label>
              ))}
            </div>
            {manage && !c.unsubscribed_all_at && (
              <button type="button" className="btn btn-danger btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => run(() => api.mkt.post(`/contacts/${c.id}/unsubscribe`, { all: true, reason: 'Asked a colleague to stop all emails' }), 'Unsubscribed from everything')}>They asked to stop all emails</button>
            )}
          </div>
        )}

        {tab === 'consent' && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>What</th><th>How</th><th>Basis / words agreed to</th><th>By</th></tr></thead>
              <tbody>
                {d.consents.map((k) => (
                  <tr key={k.id}>
                    <td className="small">{formatDate(k.created_at, { withTime: true })}</td>
                    <td>{k.action.toLowerCase().replace(/_/g, ' ')}{k.audience_name ? ` · ${k.audience_name}` : ''}{k.topic_name ? ` · ${k.topic_name}` : ''}</td>
                    <td className="small">{sourceWords(k.source)}{k.ip ? <div className="muted">IP {k.ip}</div> : null}</td>
                    <td className="small">{k.basis}{k.consent_text && <div className="muted">“{k.consent_text}”</div>}{k.meta?.reason && <div className="muted">{k.meta.reason}</div>}</td>
                    <td className="small">{k.actor_name || 'Them'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function MarketingContacts({ meta }) {
  const { can } = useAuth();
  const toast = useToast();
  const [filters, setFilters] = useState({ search: '', audience_id: '', tag: '', status: '', segment_id: '' });
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [segments, setSegments] = useState([]);
  const [tags, setTags] = useState([]);
  const [bulkTag, setBulkTag] = useState('');

  const load = useCallback(() => {
    api.mkt.get('/contacts', { ...filters, limit: 50, offset: page * 50 }).then(setData).catch((err) => toast.error(err));
  }, [filters, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    api.mkt.get('/segments').then((r) => setSegments(r.segments)).catch(() => {});
    api.mkt.get('/tags').then((r) => setTags(r.tags)).catch(() => {});
  }, []);

  const setF = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(0); setSelected(new Set()); };
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bulk = async (op) => {
    try {
      await api.mkt.post('/contacts/tags', { ids: [...selected], [op]: [bulkTag] });
      toast.success(op === 'add' ? `Tagged ${selected.size}` : `Tag removed from ${selected.size}`);
      setBulkTag('');
      load();
    } catch (err) { toast.error(err); }
  };

  return (
    <div className="stack">
      <div className="filters">
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search name, email, phone, organization" value={filters.search} onChange={(e) => setF('search', e.target.value)} />
        <select className="select" style={{ width: 170 }} value={filters.audience_id} onChange={(e) => setF('audience_id', e.target.value)}>
          <option value="">Every audience</option>{meta.audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select className="select" style={{ width: 150 }} value={filters.tag} onChange={(e) => setF('tag', e.target.value)}>
          <option value="">Any tag</option>{tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.contacts})</option>)}
        </select>
        <select className="select" style={{ width: 170 }} value={filters.segment_id} onChange={(e) => setF('segment_id', e.target.value)}>
          <option value="">No segment</option>{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="select" style={{ width: 170 }} value={filters.status} onChange={(e) => setF('status', e.target.value)}>
          <option value="">Everyone</option><option value="SUBSCRIBED">Subscribed to something</option><option value="UNSUBSCRIBED">Unsubscribed from all</option>
          <option value="BOUNCED">Bounced or spam</option><option value="SUPPRESSED">Blocked</option><option value="ARCHIVED">Archived</option>
        </select>
        <div className="grow" />
        {can('marketing.export') && <button type="button" className="btn btn-sm" onClick={() => downloadFile(api.mkt.url('/contacts/export.csv', { audience_id: filters.audience_id || undefined }), 'contacts.csv').catch((err) => toast.error(err))}><Icon name="download" size={13} /> Export</button>}
        {can('marketing.manage') && <button type="button" className="btn btn-sm" onClick={() => setImporting(true)}>Import</button>}
        {can('marketing.manage') && <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={13} /> Add contact</button>}
      </div>

      {selected.size > 0 && can('marketing.manage') && (
        <div className="card card-pad row wrap">
          <strong>{selected.size} selected</strong>
          <input className="input" style={{ width: 160 }} placeholder="tag" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={!bulkTag.trim()} onClick={() => bulk('add')}>Add tag</button>
          <button type="button" className="btn btn-sm" disabled={!bulkTag.trim()} onClick={() => bulk('remove')}>Remove tag</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="card">
        {!data ? <Spinner /> : data.contacts.length === 0 ? (
          <EmptyState title="No contacts here">Add people by hand, import a CSV, publish a signup form, or switch on the pipeline sync in Settings.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th style={{ width: 30 }}><input type="checkbox" aria-label="Select all on this page" checked={data.contacts.every((c) => selected.has(c.id))} onChange={(e) => setSelected(e.target.checked ? new Set(data.contacts.map((c) => c.id)) : new Set())} /></th>
                <th>Person</th><th>Audiences</th><th>Tags</th><th className="num">Engagement</th><th>Last opened</th></tr></thead>
              <tbody>
                {data.contacts.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${c.email}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} /></td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{personName(c)} {c.language === 'hi' && <span className="badge" title="Reads Hindi">हि</span>}</div>
                      <div className="small muted">{c.email}{c.organization ? ` · ${c.organization}` : ''}{c.account_name && c.account_name !== c.organization ? ` · ${c.account_name}` : ''}</div>
                      {c.email_status !== 'ACTIVE' && <Badge tone={ADDRESS_STATUS[c.email_status]?.tone}>{ADDRESS_STATUS[c.email_status]?.label}</Badge>}
                    </td>
                    <td><div className="row wrap" style={{ gap: 4 }}>{c.audiences.map((a) => <span key={a.id} className="badge" title={a.status === 'PENDING' ? 'Waiting to confirm' : 'Subscribed'}><span className="badge-dot" style={{ background: a.color || 'var(--axis)' }} />{a.name}{a.status === 'PENDING' ? ' (pending)' : ''}</span>)}</div></td>
                    <td className="small dim">{(c.tags || []).join(', ')}</td>
                    <td className="num">{c.engagement_score}</td>
                    <td className="small">{c.last_opened_at ? relativeTime(c.last_opened_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 50 && (
          <div className="row-between card-pad small">
            <span className="muted">{page * 50 + 1}–{Math.min(data.total, (page + 1) * 50)} of {data.total}</span>
            <div className="row"><button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><button type="button" className="btn btn-sm" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</button></div>
          </div>
        )}
      </div>
      {data && <div className="small muted">{data.total} contact{data.total === 1 ? '' : 's'}. One record per email address, however many audiences, imports and pipeline records they come from.</div>}

      {adding && <AddContact meta={meta} onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); load(); setOpen(c.id); }} />}
      {importing && <ImportWizard meta={meta} onClose={() => setImporting(false)} onDone={load} />}
      {open && <ContactDrawer contactId={open} meta={meta} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}
