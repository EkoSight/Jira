import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { Avatar, Badge, ConfirmButton, EmptyState, Field, Icon, Modal, Spinner } from './ui.jsx';
import { formatDate, relativeTime } from '../lib/format.js';

/**
 * The link library.
 *
 * Everything here is a pointer to something that lives somewhere else. TaskFlow
 * holds the address, the title and where it belongs; the document itself stays in
 * Drive or Canva or wherever it was made.
 *
 * Two things this screen is careful to say out loud, because both are easy to
 * assume and wrong:
 *   — Using a shared resource on a lead creates a reference, not a copy.
 *   — Saving a link grants nobody access to it, and sending it is a separate act
 *     that somebody has to record.
 */

const STATUSES = [
  { value: 'DRAFT', label: 'Draft', tone: 'neutral' },
  { value: 'CURRENT', label: 'Current', tone: 'good' },
  { value: 'SUPERSEDED', label: 'Superseded', tone: 'warning' },
  { value: 'ARCHIVED', label: 'Archived', tone: 'neutral' },
];
const STATUS_META = Object.fromEntries(STATUSES.map((s) => [s.value, s]));

const CHANNELS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'LINKEDIN', label: 'LinkedIn' },
  { value: 'IN_PERSON', label: 'Handed over in person' },
  { value: 'CALL', label: 'On a call' },
  { value: 'OTHER', label: 'Some other way' },
];

/** The host, which is the most honest one-word description of where a link goes. */
const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; }
};

function ResourceDialog({ accountId, folders, opportunities, resource, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    title: resource?.title || '',
    url: resource?.url || '',
    folder_id: resource?.folder_id || folders[0]?.id || '',
    description: resource?.description || '',
    version_label: resource?.version_label || '',
    status: resource?.status || 'CURRENT',
    opportunity_id: resource?.opportunity_id || '',
    tags: (resource?.tags || []).join(', '),
    is_restricted: resource?.is_restricted || false,
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const save = async () => {
    if (!form.title.trim()) return toast.error('Give it a title');
    if (!resource && !form.url.trim()) return toast.error('Paste the link');
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        folder_id: form.folder_id ? Number(form.folder_id) : null,
        description: form.description.trim() || null,
        version_label: form.version_label.trim() || null,
        status: form.status,
        opportunity_id: form.opportunity_id ? Number(form.opportunity_id) : null,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        is_restricted: form.is_restricted,
      };
      if (resource) {
        await api.updateResource(resource.id, { ...payload, url: form.url.trim() });
      } else {
        await api.addResource({ ...payload, account_id: accountId ?? null, url: form.url.trim() });
      }
      toast.success(resource ? 'Saved' : 'Link saved');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={resource ? 'Edit the link' : accountId ? 'Save a link on this lead' : 'Save a link in the shared library'}
      size="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="What is it? *">
          <input className="input" autoFocus value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Soil Doctor validation report — Rabi 2025" />
        </Field>
        <Field label="Link *" hint="A web address. The file stays where it is — nothing is uploaded or copied here.">
          <input className="input" value={form.url} onChange={(e) => set({ url: e.target.value })}
            placeholder="https://docs.google.com/document/d/…" />
        </Field>
        <div className="grid-2">
          <Field label="Which shelf">
            <select className="select" value={form.folder_id}
              onChange={(e) => set({ folder_id: e.target.value })}>
              <option value="">Unfiled</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Which version is this">
            <select className="select" value={form.status}
              onChange={(e) => set({ status: e.target.value })}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Version label" hint="v3, Final, post-review…">
            <input className="input" value={form.version_label}
              onChange={(e) => set({ version_label: e.target.value })} />
          </Field>
          <Field label="Tags" hint="Comma separated">
            <input className="input" value={form.tags}
              onChange={(e) => set({ tags: e.target.value })}
              placeholder="fpo, pricing, hindi" />
          </Field>
        </div>
        {accountId && opportunities?.length > 0 && (
          <Field label="About a particular deal?">
            <select className="select" value={form.opportunity_id}
              onChange={(e) => set({ opportunity_id: e.target.value })}>
              <option value="">Not deal-specific</option>
              {opportunities.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Notes for whoever uses it next">
          <textarea className="textarea" rows={2} value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Use the Hindi version with FPOs; pricing slide is out of date" />
        </Field>
        <label className="checklist-item" style={{ padding: 0 }}>
          <input type="checkbox" checked={form.is_restricted}
            onChange={(e) => set({ is_restricted: e.target.checked })} />
          <span>Sensitive — only managers should see it listed here.</span>
        </label>
      </div>
    </Modal>
  );
}

/** Recording what was actually sent. TaskFlow sends nothing. */
function ShareDialog({ resource, accountId, contacts, opportunities, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    contact_id: '', channel: 'EMAIL', purpose: '',
    opportunity_id: opportunities?.[0]?.id || '',
    shared_at: '',
    version_label: resource.version_label || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      await api.recordShare(resource.id, {
        account_id: accountId,
        contact_id: form.contact_id ? Number(form.contact_id) : null,
        opportunity_id: form.opportunity_id ? Number(form.opportunity_id) : null,
        channel: form.channel,
        version_label: form.version_label.trim() || null,
        purpose: form.purpose.trim() || null,
        shared_at: form.shared_at ? new Date(form.shared_at).toISOString() : null,
      });
      toast.success('Recorded as sent by you');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Record that you sent: ${resource.title}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Record it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="callout is-quiet">
          <Icon name="alert" size={15} />
          <span className="small">
            This records what <strong>you</strong> did. TaskFlow does not send the link, and saving
            this does not give anyone access to the document — that is set where the document lives.
          </span>
        </div>
        <div className="grid-2">
          <Field label="To whom">
            <select className="select" value={form.contact_id}
              onChange={(e) => set({ contact_id: e.target.value })}>
              <option value="">Not a specific person</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.full_name}{c.designation ? ` · ${c.designation}` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="How">
            <select className="select" value={form.channel}
              onChange={(e) => set({ channel: e.target.value })}>
              {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Which version">
            <input className="input" value={form.version_label}
              onChange={(e) => set({ version_label: e.target.value })} />
          </Field>
          <Field label="When" hint="Leave blank for now">
            <input className="input" type="datetime-local" value={form.shared_at}
              onChange={(e) => set({ shared_at: e.target.value })} />
          </Field>
        </div>
        <Field label="Why did they need it?">
          <input className="input" value={form.purpose}
            onChange={(e) => set({ purpose: e.target.value })}
            placeholder="Dr Rao asked for the lab correlation data after the demo" />
        </Field>
      </div>
    </Modal>
  );
}

/** The shared library, to pick something into this lead by reference. */
function BorrowDialog({ accountId, onClose, onSaved }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.resources({}).then(setData).catch((err) => toast.error(err));
  }, []);

  const shown = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    if (!term) return data.resources;
    return data.resources.filter((r) =>
      r.title.toLowerCase().includes(term)
      || (r.description || '').toLowerCase().includes(term)
      || (r.tags || []).some((t) => t.toLowerCase().includes(term)));
  }, [data, search]);

  return (
    <Modal title="Use something from the shared library" size="sheet" onClose={onClose}>
      <div className="stack">
        <div className="callout is-quiet">
          <Icon name="link" size={15} />
          <span className="small">
            This creates a <strong>reference</strong>, not a copy. The shared original stays where
            it is, and removing the reference later leaves it alone.
          </span>
        </div>
        <input className="input" placeholder="Search the shared library" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        {!data ? <Spinner label="Loading the shared library" /> : shown.length === 0 ? (
          <EmptyState title="Nothing in the shared library yet">
            A manager can add the standard pitch deck, the validation reports and the price list
            once, and every lead can point at them.
          </EmptyState>
        ) : (
          <ul className="plain-list">
            {shown.map((r) => (
              <li key={r.id} className="row" style={{ gap: 8 }}>
                <Icon name="link" size={14} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 13 }}>{r.title}</strong>
                  <div className="small muted">
                    {hostOf(r.url)}
                    {r.version_label && ` · ${r.version_label}`}
                    {r.reference_count > 0 && ` · used by ${r.reference_count} lead${r.reference_count === 1 ? '' : 's'}`}
                  </div>
                </span>
                <button type="button" className="btn btn-sm" onClick={async () => {
                  try {
                    await api.referenceResource(r.id, { account_id: accountId });
                    toast.success('Referenced — the shared original is unchanged');
                    onSaved();
                  } catch (err) { toast.error(err); }
                }}>
                  Use it
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

export default function CrmResources({ accountId, opportunities, contacts, canEdit, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [shares, setShares] = useState(null);
  const [folder, setFolder] = useState('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [borrowing, setBorrowing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [newFolder, setNewFolder] = useState('');

  const load = () => {
    api.resources({ account_id: accountId })
      .then(setData).catch((err) => toast.error(err));
    api.accountShares(accountId).then((r) => setShares(r.shares)).catch(() => setShares([]));
  };

  useEffect(load, [accountId]);

  const shown = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.resources.filter((r) => {
      if (folder === 'pinned' && !r.is_pinned) return false;
      if (folder === 'shared' && !r.from_global) return false;
      if (typeof folder === 'number' && r.folder_id !== folder) return false;
      if (!term) return true;
      return r.title.toLowerCase().includes(term)
        || (r.description || '').toLowerCase().includes(term)
        || (r.tags || []).some((t) => t.toLowerCase().includes(term));
    });
  }, [data, folder, search]);

  if (!data) return <Spinner label="Loading the library" />;

  const refresh = () => { load(); onChanged?.(); };

  return (
    <section className="card card-pad stack">
      <div className="row-between wrap">
        <div>
          <h2>Links & documents</h2>
          <div className="small muted">
            Pointers to things that live elsewhere — nothing is uploaded here.
          </div>
        </div>
        {canEdit && (
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => setBorrowing(true)}>
              From the shared library
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} /> Save a link
            </button>
          </div>
        )}
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        <button type="button" className={`kind-chip${folder === 'all' ? ' is-active' : ''}`}
          onClick={() => setFolder('all')}>
          All ({data.resources.length})
        </button>
        <button type="button" className={`kind-chip${folder === 'pinned' ? ' is-active' : ''}`}
          onClick={() => setFolder('pinned')}>
          Pinned
        </button>
        <button type="button" className={`kind-chip${folder === 'shared' ? ' is-active' : ''}`}
          onClick={() => setFolder('shared')}>
          From the shared library
        </button>
        {data.folders.map((f) => (
          <button key={f.id} type="button"
            className={`kind-chip${folder === f.id ? ' is-active' : ''}`}
            onClick={() => setFolder(f.id)}>
            {f.name}{f.resource_count > 0 ? ` (${f.resource_count})` : ''}
          </button>
        ))}
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        <input className="input grow" style={{ minWidth: 180 }}
          placeholder="Search titles, notes and tags"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        {canEdit && (
          <form className="row" style={{ gap: 6 }} onSubmit={async (event) => {
            event.preventDefault();
            if (!newFolder.trim()) return;
            try {
              await api.createResourceFolder({ account_id: accountId, name: newFolder.trim() });
              setNewFolder('');
              refresh();
            } catch (err) { toast.error(err); }
          }}>
            <input className="input" style={{ width: 150 }} placeholder="New shelf"
              value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />
            <button type="submit" className="btn btn-sm">Add</button>
          </form>
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState title={search ? 'Nothing matches' : 'No links saved yet'}>
          {search
            ? 'Only titles, notes and tags are searched — the contents of the documents themselves are never read.'
            : 'Save the deck you pitched with, the proposal you sent, the report they asked for. The files stay where they are.'}
        </EmptyState>
      ) : (
        <ul className="resource-list">
          {shown.map((r) => {
            const meta = STATUS_META[r.status] || STATUS_META.CURRENT;
            return (
              <li key={`${r.is_reference ? 'ref' : 'own'}-${r.id}`}
                className={`resource${r.is_pinned ? ' is-pinned' : ''}`}>
                <a className="resource-link" href={r.url} target="_blank" rel="noreferrer noopener">
                  <Icon name="link" size={15} />
                </a>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <a href={r.url} target="_blank" rel="noreferrer noopener"
                      className="resource-title">{r.title}</a>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {r.version_label && <Badge tone="neutral">{r.version_label}</Badge>}
                    {r.from_global && (
                      <Badge tone="brand" title="A reference to the shared library — not a copy">
                        shared
                      </Badge>
                    )}
                    {r.is_restricted && <Badge tone="warning">sensitive</Badge>}
                  </div>
                  <div className="small muted row wrap" style={{ gap: 6 }}>
                    <span>{hostOf(r.url)}</span>
                    {r.folder_name && <><span>·</span><span>{r.folder_name}</span></>}
                    {r.opportunity_name && <><span>·</span><span>{r.opportunity_name}</span></>}
                    {r.added_by_name && <><span>·</span><span>added by {r.added_by_name}</span></>}
                    {r.share_count > 0 && (
                      <><span>·</span>
                        <span>sent {r.share_count}×, last {relativeTime(r.last_shared_at)}</span></>
                    )}
                  </div>
                  {r.description && <div className="small">{r.description}</div>}
                  {r.tags?.length > 0 && (
                    <div className="row wrap" style={{ gap: 4 }}>
                      {r.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}
                    </div>
                  )}
                </div>
                {canEdit && (
                  <div className="row wrap" style={{ gap: 4 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setSharing(r)}>
                      I sent this
                    </button>
                    {!r.is_reference && (
                      <>
                        <button type="button" className="icon-btn"
                          title={r.is_pinned ? 'Unpin' : 'Pin to the top'}
                          onClick={async () => {
                            try { await api.pinResource(r.id); refresh(); }
                            catch (err) { toast.error(err); }
                          }}>
                          <Icon name="flag" size={13} />
                        </button>
                        <button type="button" className="icon-btn" title="Edit"
                          onClick={() => setEditing(r)}>
                          <Icon name="edit" size={13} />
                        </button>
                        <ConfirmButton label="Remove" confirmLabel="Remove the link?"
                          className="btn btn-sm btn-ghost"
                          onConfirm={async () => {
                            try {
                              await api.removeResource(r.id);
                              toast.success('Link removed — the document itself is untouched');
                              refresh();
                            } catch (err) { toast.error(err); }
                          }} />
                      </>
                    )}
                    {r.is_reference && (
                      <ConfirmButton label="Stop using" confirmLabel="Remove the reference?"
                        className="btn btn-sm btn-ghost"
                        onConfirm={async () => {
                          try {
                            await api.unreferenceResource(r.id, accountId);
                            toast.success('Reference removed — the shared original is untouched');
                            refresh();
                          } catch (err) { toast.error(err); }
                        }} />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {shares?.length > 0 && (
        <div className="stack-sm">
          <button type="button" className="disclosure" onClick={() => setShowLog(!showLog)}>
            <Icon name="chevron" size={12} style={{ transform: showLog ? 'rotate(90deg)' : 'none' }} />
            What has actually been sent ({shares.length})
          </button>
          {showLog && (
            <ul className="plain-list">
              {shares.map((s) => (
                <li key={s.id} className="row" style={{ gap: 8 }}>
                  {s.shared_by_name && <Avatar name={s.shared_by_name} size={20} />}
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 13 }}>{s.resource_title}</strong>
                    {s.version_label && <span className="muted small"> · {s.version_label}</span>}
                    <div className="small muted">
                      {s.contact_name ? `to ${s.contact_name}` : 'no specific person'}
                      {s.channel && ` · ${s.channel.replaceAll('_', ' ').toLowerCase()}`}
                      {` · ${formatDate(s.shared_at, { withTime: true })}`}
                      {s.shared_by_name && ` · recorded by ${s.shared_by_name}`}
                    </div>
                    {s.purpose && <div className="small">{s.purpose}</div>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {adding && (
        <ResourceDialog accountId={accountId} folders={data.folders} opportunities={opportunities}
          onClose={() => setAdding(false)} onSaved={refresh} />
      )}
      {editing && (
        <ResourceDialog accountId={accountId} folders={data.folders} opportunities={opportunities}
          resource={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      {sharing && (
        <ShareDialog resource={sharing} accountId={accountId} contacts={contacts}
          opportunities={opportunities} onClose={() => setSharing(null)} onSaved={refresh} />
      )}
      {borrowing && (
        <BorrowDialog accountId={accountId} onClose={() => setBorrowing(false)} onSaved={refresh} />
      )}
    </section>
  );
}
