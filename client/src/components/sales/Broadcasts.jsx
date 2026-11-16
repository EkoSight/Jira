/**
 * WhatsApp broadcasts: one approved template to a filtered list of leads who
 * agreed to WhatsApp messages. Draft → approval (someone else) → send, then
 * what happened to each message (docs/WHATSAPP_BROADCASTS.md).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth, useToast } from '../../state/AppState.jsx';
import { Badge, ConfirmButton, EmptyState, Modal, Spinner } from '../ui.jsx';
import { CATEGORY, when } from '../../lib/sales.js';
import { INDIAN_STATES } from '../../lib/crmWork.js';
import {
  BROADCAST_STATUS, BROADCAST_VIEWS, BROADCAST_VIEW_LABEL, fillBlanks, filterWords, roomWords, variablesFor,
} from '../../lib/broadcasts.js';

function StatusBadge({ status }) {
  const s = BROADCAST_STATUS[status] || { label: status, tone: 'neutral' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** The message as it will look, in a chat bubble. */
function Bubble({ text, who }) {
  return (
    <figure className="wab-bubble">
      <blockquote>{text}</blockquote>
      {who && <figcaption className="small muted">to {who}</figcaption>}
    </figure>
  );
}

function NotConnected({ whatsapp }) {
  if (!whatsapp || whatsapp.configured) return null;
  return (
    <div className="mkt-callout small" role="note">
      WhatsApp is not connected on the server yet ({whatsapp.missing.join(', ')} not set), so nothing can be sent. Broadcasts can still be prepared and approved.
    </div>
  );
}

// ---------------------------------------------------------------- the list

function NewBroadcast({ meta, startFilters, onClose, onMade }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.sales.post('/broadcasts', { name: name.trim(), filters: startFilters || { view: 'open' } });
      onMade(r.broadcast.id);
    } catch (err) { toast.error(err); setBusy(false); }
  };
  return (
    <Modal title="New WhatsApp broadcast" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || name.trim().length < 3} onClick={save}>Create draft</button></>}>
      <div className="stack-sm">
        <label className="field"><span className="field-label">Name (only your team sees it)</span>
          <input className="input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} placeholder="For example: Kharif kit offer, retailers in the north" autoFocus />
        </label>
        <div className="small">
          <span className="field-label">The list</span>
          <div>{filterWords(startFilters || { view: 'open' }, { categories: CATEGORY, users: meta.users, sources: meta.sources, statuses: meta.call_statuses }).join(' · ')}</div>
          <div className="muted">You can change it, choose the message and see who gets it on the next page. Nothing is sent from a draft.</div>
        </div>
      </div>
    </Modal>
  );
}

function BroadcastList({ meta, open, startFilters }) {
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [making, setMaking] = useState(Boolean(startFilters));
  useEffect(() => { api.sales.get('/broadcasts').then(setData).catch((error) => setData({ error })); }, []);
  if (!data) return <Spinner label="Loading broadcasts" />;
  if (data.error) return <EmptyState title={data.error.status === 404 ? 'WhatsApp broadcasts are switched off' : 'Broadcasts could not load'}>{data.error.status === 404 ? 'An administrator can switch them on in Settings → WhatsApp.' : data.error.message}</EmptyState>;
  return (
    <div className="stack">
      <div className="row-between wrap" style={{ gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>WhatsApp broadcasts</h2>
          <div className="small muted">One approved WhatsApp template to a list of leads, only to numbers that agreed to WhatsApp messages.</div>
        </div>
        {can('marketing.manage') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setMaking(true)}>New broadcast</button>}
      </div>
      <NotConnected whatsapp={data.whatsapp} />
      <div className="small muted">{roomWords(data.room)}</div>
      {!data.broadcasts.length && (
        <EmptyState title="No broadcasts yet">
          Start one here, or from the lead list: filter the leads, then choose WhatsApp broadcast. Only numbers with a WhatsApp opt-in get it.
        </EmptyState>
      )}
      {data.broadcasts.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Broadcast</th><th>Status</th><th>List</th><th className="num">Sent</th><th className="num">Delivered</th><th className="num">Replied</th><th>Last change</th></tr></thead>
            <tbody>
              {data.broadcasts.map((b) => (
                <tr key={b.id}>
                  <td><button type="button" className="btn-link" onClick={() => open(b.id)}>{b.name}</button></td>
                  <td><StatusBadge status={b.status} /></td>
                  <td className="small">{filterWords(b.filters, { categories: CATEGORY, users: meta.users, sources: meta.sources, statuses: meta.call_statuses }).join(' · ')}</td>
                  <td className="num tnum">{b.progress ? b.progress.sent : (b.approved_count ?? '—')}</td>
                  <td className="num tnum">{b.progress ? b.progress.delivered : '—'}</td>
                  <td className="num tnum">{b.progress ? b.progress.replied : '—'}</td>
                  <td className="small">{when(b.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {making && <NewBroadcast meta={meta} startFilters={startFilters} onClose={() => setMaking(false)} onMade={open} />}
    </div>
  );
}

// ---------------------------------------------------------------- one broadcast

function ListEditor({ meta, filters, onChange, disabled }) {
  const set = (k) => (e) => onChange({ ...filters, [k]: e.target.value });
  const shown = ['view', 'category', 'state', 'district', 'owner_id', 'tag', 'source_id', 'call_status_id'];
  const others = Object.entries(filters).filter(([k]) => !shown.includes(k));
  return (
    <div className="stack-sm">
      <div className="wab-filters">
        <label className="field"><span className="field-label">Leads</span>
          <select className="select" value={filters.view || 'open'} onChange={set('view')} disabled={disabled}>
            {BROADCAST_VIEWS.map((v) => <option key={v} value={v}>{BROADCAST_VIEW_LABEL[v]}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Category</span>
          <select className="select" value={filters.category || ''} onChange={set('category')} disabled={disabled}>
            <option value="">Every category</option>{Object.entries(CATEGORY).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">State</span>
          <select className="select" value={filters.state || ''} onChange={set('state')} disabled={disabled}>
            <option value="">Any state</option>{INDIAN_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">District</span>
          <input className="input" value={filters.district || ''} onChange={set('district')} disabled={disabled} placeholder="Any district" />
        </label>
        <label className="field"><span className="field-label">Owner</span>
          <select className="select" value={filters.owner_id || ''} onChange={set('owner_id')} disabled={disabled}>
            <option value="">Any owner</option><option value="none">Nobody</option>
            {meta.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Tag</span>
          <input className="input" value={filters.tag || ''} onChange={set('tag')} disabled={disabled} placeholder="Any tag" />
        </label>
        <label className="field"><span className="field-label">Source</span>
          <select className="select" value={filters.source_id || ''} onChange={set('source_id')} disabled={disabled}>
            <option value="">Any source</option>{meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Calling status</span>
          <select className="select" value={filters.call_status_id || ''} onChange={set('call_status_id')} disabled={disabled}>
            <option value="">Any calling status</option><option value="none">No status yet</option>
            {(meta.call_statuses || []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {others.length > 0 && (
        <div className="row wrap small" style={{ gap: 6 }}>
          <span className="muted">Also from the lead list:</span>
          {others.map(([k, v]) => (
            <span key={k} className="wab-chip">
              {filterWords({ [k]: v }, { categories: CATEGORY, users: meta.users, sources: meta.sources, statuses: meta.call_statuses }).slice(1).join('')}
              {!disabled && <button type="button" className="btn-link" aria-label={`Remove ${k}`} onClick={() => { const n = { ...filters }; delete n[k]; onChange(n); }}>×</button>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageEditor({ options, draft, onChange, disabled }) {
  const template = options.templates.find((t) => t.name === draft.template_name && t.language === (draft.template_language || 'en'));
  const count = template?.variable_count || 0;
  const vars = variablesFor(count, draft.variables);
  const setVar = (i, patch) => onChange({ ...draft, variables: vars.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  return (
    <div className="stack-sm">
      <label className="field"><span className="field-label">Approved WhatsApp template</span>
        <select className="select" value={draft.template_name ? `${draft.template_name}|${draft.template_language || 'en'}` : ''} disabled={disabled}
          onChange={(e) => { const [name, language] = e.target.value.split('|'); const t = options.templates.find((x) => x.name === name && x.language === language); onChange({ ...draft, template_name: name || null, template_language: language || null, variables: variablesFor(t?.variable_count || 0, []) }); }}>
          <option value="">Choose a template…</option>
          {options.templates.map((t) => (
            <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`} disabled={!t.usable}>
              {t.name} ({t.language}{t.category ? `, ${t.category.toLowerCase()}` : ''}){t.usable ? '' : ` — ${t.why_not}`}
            </option>
          ))}
        </select>
        <span className="field-hint">Templates are written and approved in WhatsApp Manager, then synced in Settings → WhatsApp. Broadcasts cannot send free text.</span>
      </label>
      {!options.templates.length && <div className="small muted">No templates synced yet.</div>}
      {template && (
        <>
          <Bubble text={template.body} />
          {count > 0 && (
            <fieldset className="wab-blanks" disabled={disabled}>
              <legend className="field-label">What fills each blank</legend>
              {vars.map((v, i) => (
                <div key={i} className="wab-blank">
                  <span className="wab-blank-name">{`{{${i + 1}}}`}</span>
                  <select className="select" aria-label={`What fills {{${i + 1}}}`} value={v.source} onChange={(e) => setVar(i, { source: e.target.value })}>
                    <option value="">Choose…</option>
                    {Object.entries(options.sources).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  {v.source === 'fixed'
                    ? <input className="input" aria-label={`Text for {{${i + 1}}}`} value={v.text} maxLength={200} onChange={(e) => setVar(i, { text: e.target.value })} placeholder="The same for everyone" />
                    : <input className="input" aria-label={`If empty, {{${i + 1}}} says`} value={v.fallback} maxLength={200} onChange={(e) => setVar(i, { fallback: e.target.value })} placeholder="If empty, use… (else the person is skipped)" />}
                </div>
              ))}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}

function People({ id, reason, title, onClose }) {
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    api.sales.get(`/broadcasts/${id}`, { people: 1, reason: reason || undefined, offset, limit: 50 }).then(setData).catch((error) => setData({ error }));
  }, [id, reason, offset]);
  const rows = data?.people || [];
  return (
    <Modal title={title} onClose={onClose} size="lg">
      {!data && <Spinner label="Loading" />}
      {data?.error && <div role="alert">{data.error.message}</div>}
      {data && !data.error && (
        <div className="stack-sm">
          {!rows.length && <div className="small muted">Nobody.</div>}
          {rows.length > 0 && (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Lead</th><th>Phone</th><th>{data.progress ? 'What happened' : 'Why'}</th></tr></thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={`${p.lead_id}-${p.id || ''}`}>
                      <td><Link to={`/sales/leads/${p.lead_id}`}>{p.ref}</Link> {p.name}</td>
                      <td className="small tnum">{p.phone || '—'}</td>
                      <td className="small">{data.progress ? [p.status === 'SENT' ? (p.message_status === 'READ' ? 'Read' : p.message_status === 'DELIVERED' ? 'Delivered' : p.message_status === 'FAILED' ? `Failed: ${p.error_title || ''}` : 'Accepted by WhatsApp') : p.status === 'PENDING' ? 'Still to send' : p.reason].join('') : (p.why || 'Gets it')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row" style={{ gap: 6 }}>
            {offset > 0 && <button type="button" className="btn btn-sm" onClick={() => setOffset(Math.max(0, offset - 50))}>Previous 50</button>}
            {rows.length === 50 && <button type="button" className="btn btn-sm" onClick={() => setOffset(offset + 50)}>Next 50</button>}
            {data.people_total !== undefined && <span className="small muted">{data.people_total} in all</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Before({ data, openPeople }) {
  const { list, sample } = data;
  if (!list) return null;
  return (
    <div className="stack-sm">
      <div className="wab-tally">
        <div><strong className="wab-big tnum">{list.will_send}</strong><span className="small">will get it</span></div>
        <div><strong className="wab-big tnum">{list.matched}</strong><span className="small">in the list (the same as the lead list with these filters)</span></div>
      </div>
      {list.will_send > 0 && <button type="button" className="btn-link small" style={{ alignSelf: 'flex-start' }} onClick={() => openPeople('SEND', 'Who gets it')}>See who gets it</button>}
      {list.skipped.length > 0 && (
        <ul className="wab-reasons">
          {list.skipped.map((s) => (
            <li key={s.code}>
              <button type="button" className="btn-link" onClick={() => openPeople(s.code, s.words)}>{s.n} skipped</button> <span className="small">{s.words}</span>
            </li>
          ))}
        </ul>
      )}
      {sample?.length > 0 && (
        <div className="stack-sm">
          <span className="field-label">How it reads</span>
          <div className="wab-samples">{sample.map((s) => <Bubble key={s.ref} text={s.text} who={`${s.name} (${s.ref})`} />)}</div>
        </div>
      )}
    </div>
  );
}

function After({ data, openPeople }) {
  const p = data.progress;
  const b = data.broadcast;
  const tiles = [
    ['Accepted by WhatsApp', p.sent], ['Delivered', p.delivered], ['Read', p.read], ['Replied', p.replied],
    ['Failed', p.failed], ['Skipped', p.skipped], ['Still to send', p.pending], ['Opted out after', p.opted_out_after],
  ];
  let waiting = null;
  if (b.status === 'SENDING' && p.pending > 0) {
    if (!data.whatsapp.configured) waiting = 'Waiting: WhatsApp is not connected.';
    else if (!data.room.in_hours) waiting = `Waiting for the sending hours (${data.settings.sendFrom}–${data.settings.sendUntil}).`;
    else if (data.room.left_today <= 0) waiting = `Waiting: the daily limit of ${data.settings.dailyLimit} is reached; it carries on as the 24 hours roll on.`;
    else waiting = 'Sending a batch about every 30 seconds.';
  }
  return (
    <div className="stack-sm">
      {waiting && <div className="small" role="status">{waiting}</div>}
      {b.status === 'PAUSED' && b.pause_reason && <div className="mkt-callout small" role="status">{b.pause_reason}</div>}
      <div className="wab-stats">
        {tiles.map(([label, n]) => <div key={label} className="wab-stat"><strong className="tnum">{n}</strong><span className="small">{label}</span></div>)}
      </div>
      {p.reasons.length > 0 && (
        <ul className="wab-reasons">
          {p.reasons.map((r) => <li key={`${r.status}-${r.reason}`}><span className="tnum">{r.n}</span> {r.status === 'SKIPPED' ? 'skipped' : 'failed'}: <span className="small">{r.reason}</span></li>)}
        </ul>
      )}
      <button type="button" className="btn-link small" style={{ alignSelf: 'flex-start' }} onClick={() => openPeople(null, 'Everyone in this broadcast')}>See each person</button>
      <div className="small muted">"Replied" counts a WhatsApp reply within 7 days. Delivered and read come from WhatsApp as they happen; read receipts can be switched off by the person.</div>
    </div>
  );
}

function ScheduleDialog({ onClose, onSend, willSend, settings }) {
  const [at, setAt] = useState('');
  return (
    <Modal title="Schedule the broadcast" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!at} onClick={() => onSend(new Date(at).toISOString())}>Schedule</button></>}>
      <div className="stack-sm">
        <label className="field"><span className="field-label">Start sending at</span>
          <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <p className="small" style={{ margin: 0 }}>About {willSend} people. Who gets it is worked out again when it starts, and messages go only between {settings.sendFrom} and {settings.sendUntil}.</p>
      </div>
    </Modal>
  );
}

function BroadcastPage({ id, meta, back }) {
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState(null);
  const [asking, setAsking] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(() => api.sales.get(`/broadcasts/${id}`).then((d) => {
    setData(d);
    setDraft({ name: d.broadcast.name, filters: d.broadcast.filters, template_name: d.broadcast.template_name, template_language: d.broadcast.template_language, variables: d.broadcast.variables || [] });
  }).catch((error) => setData({ error })), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.sales.get('/broadcasts/options').then(setOptions).catch(() => setOptions({ templates: [], sources: {} })); }, []);
  // while it is going out, the numbers follow on their own
  useEffect(() => {
    if (!['SENDING', 'SCHEDULED'].includes(data?.broadcast?.status)) return undefined;
    const t = setInterval(() => { api.sales.get(`/broadcasts/${id}`).then(setData).catch(() => {}); }, 15000);
    return () => clearInterval(t);
  }, [id, data?.broadcast?.status]);

  const b = data?.broadcast;
  const dirty = useMemo(() => b && draft && JSON.stringify({ name: b.name, filters: b.filters, t: b.template_name, l: b.template_language, v: b.variables || [] })
    !== JSON.stringify({ name: draft.name, filters: draft.filters, t: draft.template_name, l: draft.template_language, v: draft.variables || [] }), [b, draft]);

  const act = async (fn, done) => {
    setBusy(true);
    try { const r = await fn(); if (r?.broadcast) { setData((d) => ({ ...d, ...r })); setDraft({ name: r.broadcast.name, filters: r.broadcast.filters, template_name: r.broadcast.template_name, template_language: r.broadcast.template_language, variables: r.broadcast.variables || [] }); } if (done) toast.success(done); await load(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const save = () => act(() => api.sales.patch(`/broadcasts/${id}`, draft), b.status === 'DRAFT' ? 'Saved' : 'Saved. It goes back for approval.');

  if (!data) return <Spinner label="Loading the broadcast" />;
  if (data.error) return <EmptyState title="This broadcast could not load" action={<button type="button" className="btn btn-sm" onClick={back}>All broadcasts</button>}>{data.error.message}</EmptyState>;
  const editing = b.can.edit;
  const started = Boolean(data.progress);

  return (
    <div className="stack">
      <div className="row-between wrap" style={{ gap: 10 }}>
        <div className="stack-sm" style={{ gap: 4 }}>
          <button type="button" className="btn-link small" style={{ alignSelf: 'flex-start' }} onClick={back}>← All broadcasts</button>
          {editing
            ? <input className="input wab-title" aria-label="Broadcast name" value={draft.name} maxLength={160} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            : <h2 style={{ margin: 0 }}>{b.name}</h2>}
          <div className="row wrap small" style={{ gap: 8 }}>
            <StatusBadge status={b.status} />
            <span className="muted">Made by {b.created_by_name}{b.approved_by_name ? ` · approved by ${b.approved_by_name}` : ''}{b.started_at ? ` · started ${when(b.started_at)}` : ''}{b.send_at && b.status === 'SCHEDULED' ? ` · starts ${when(b.send_at)}` : ''}</span>
          </div>
        </div>
      </div>
      <NotConnected whatsapp={data.whatsapp} />
      {b.review_note && ['DRAFT', 'APPROVED'].includes(b.status) && <div className="mkt-callout small" role="note">{b.review_note}</div>}

      <section className="card card-pad stack-sm" aria-labelledby="wab-who">
        <h3 id="wab-who" className="small">Who it is for</h3>
        {editing ? <ListEditor meta={meta} filters={draft.filters} onChange={(f) => setDraft({ ...draft, filters: f })} disabled={busy} />
          : <div className="small">{filterWords(b.filters, { categories: CATEGORY, users: meta.users, sources: meta.sources, statuses: meta.call_statuses }).join(' · ')}</div>}
        <div className="small muted">Only numbers with a WhatsApp opt-in, and not opted out, get it: one message per number.</div>
      </section>

      <section className="card card-pad stack-sm" aria-labelledby="wab-what">
        <h3 id="wab-what" className="small">The message</h3>
        {options ? <MessageEditor options={options} draft={draft} onChange={setDraft} disabled={!editing || busy} /> : <Spinner label="Loading templates" />}
      </section>

      {editing && dirty && (
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || draft.name.trim().length < 3} onClick={save}>Save changes</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={load}>Undo changes</button>
          {b.status !== 'DRAFT' && <span className="small warning-text">Saving a change to the list or the message sends it back for approval.</span>}
        </div>
      )}

      <section className="card card-pad stack-sm" aria-labelledby="wab-gets">
        <h3 id="wab-gets" className="small">{started ? 'What happened' : 'Who gets it, as of now'}</h3>
        {dirty && !started && <div className="small muted">Save your changes to see the list for them.</div>}
        {started ? <After data={data} openPeople={(reason, title) => setPeople({ reason, title })} />
          : <Before data={data} openPeople={(reason, title) => setPeople({ reason, title })} />}
      </section>

      <div className="row wrap wab-actions" style={{ gap: 8 }}>
        {b.can.test && <button type="button" className="btn btn-sm" disabled={busy || dirty} onClick={() => act(() => api.sales.post(`/broadcasts/${id}/test`), 'Test sent to your phone')}>Send me a test</button>}
        {b.can.submit && <button type="button" className="btn btn-primary btn-sm" disabled={busy || dirty} onClick={() => act(() => api.sales.post(`/broadcasts/${id}/submit`), 'Sent for approval')}>Send for approval</button>}
        {b.can.approve && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => api.sales.post(`/broadcasts/${id}/approve`, {}), 'Approved')}>Approve</button>}
        {b.can.approve && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setAsking(true)}>Ask for changes</button>}
        {b.can.send && (
          <ConfirmButton className="btn btn-primary btn-sm" label={`Send to ${b.approved_count ?? data.list?.will_send ?? 0} now`} confirmLabel="Yes, send it"
            onConfirm={() => act(() => api.sales.post(`/broadcasts/${id}/send`, {}), 'Sending has started')} />
        )}
        {b.can.send && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setScheduling(true)}>Schedule…</button>}
        {b.can.pause && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(() => api.sales.post(`/broadcasts/${id}/pause`), 'Paused')}>Pause</button>}
        {b.can.resume && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(() => api.sales.post(`/broadcasts/${id}/resume`), 'Sending again')}>Resume</button>}
        {can('marketing.send') && started && data.progress.failed > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(() => api.sales.post(`/broadcasts/${id}/retry-failed`), 'The failed ones are back in line')}>Retry the failed ones</button>}
        {b.can.cancel && <ConfirmButton label="Cancel broadcast" confirmLabel={started ? 'Yes, stop the rest' : 'Yes, cancel it'} onConfirm={() => act(() => api.sales.post(`/broadcasts/${id}/cancel`, {}), 'Cancelled')} />}
      </div>
      {b.status === 'IN_REVIEW' && <div className="small muted">Someone other than the person who sent it for approval approves it. Approval covers exactly this list and message.</div>}
      {b.status === 'APPROVED' && <div className="small muted">Who gets it is worked out again when sending starts, and each number is checked once more just before its message goes.</div>}

      {people && <People id={id} reason={people.reason} title={people.title} onClose={() => setPeople(null)} />}
      {asking && (
        <Modal title="Ask for changes" onClose={() => setAsking(false)}
          footer={<><button type="button" className="btn" onClick={() => setAsking(false)}>Cancel</button><button type="button" className="btn btn-primary" disabled={!note.trim()} onClick={() => { setAsking(false); act(() => api.sales.post(`/broadcasts/${id}/request-changes`, { note }), 'Sent back with your note'); }}>Send back</button></>}>
          <label className="field"><span className="field-label">What needs to change</span><textarea className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </Modal>
      )}
      {scheduling && <ScheduleDialog settings={data.settings} willSend={b.approved_count ?? 0} onClose={() => setScheduling(false)} onSend={(at) => { setScheduling(false); act(() => api.sales.post(`/broadcasts/${id}/send`, { send_at: at }), 'Scheduled'); }} />}
    </div>
  );
}

/** The Broadcasts tab: the list, or one broadcast (?b=id). The lead list can start one with its filters (?new=1&filters=…). */
export function Broadcasts({ meta }) {
  const [params, setParams] = useSearchParams();
  const id = Number(params.get('b')) || null;
  let startFilters = null;
  if (params.get('new') === '1') {
    try { startFilters = JSON.parse(params.get('filters') || '{"view":"open"}'); } catch { startFilters = { view: 'open' }; }
  }
  const open = (bid) => setParams({ tab: 'broadcasts', b: String(bid) });
  const back = () => setParams({ tab: 'broadcasts' });
  if (id) return <BroadcastPage key={id} id={id} meta={meta} back={back} />;
  return <BroadcastList meta={meta} open={open} startFilters={startFilters} />;
}
