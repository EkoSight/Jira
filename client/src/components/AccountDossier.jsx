import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../state/AppState.jsx';
import { AuthedImage, Badge, ConfirmButton, Field, Icon, Modal, Spinner } from './ui.jsx';
import { exactMoney } from '../lib/crm.js';

/**
 * The organization dossier — who they are, rather than what deal is open.
 *
 * Everything here outlives any one opportunity: the segment they belong to, where
 * they operate, what they grow, why the relationship matters to us. The deal's
 * money lives on the opportunity; the number here is a standing estimate of what
 * the whole relationship could be worth, and it is deliberately kept out of every
 * forecast.
 */

const chips = (value) => (value || []).filter(Boolean);
const parseList = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** A logo or banner: pick a file, or paste an address. Both are supported. */
function ImageSlot({ account, kind, label, hint, aspect, canEdit, onChanged }) {
  const toast = useToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const src = kind === 'logo' ? account.logo_src : account.banner_src;
  const uploaded = kind === 'logo' ? account.logo_uploaded_at : account.banner_uploaded_at;
  const linked = kind === 'logo' ? account.logo_url : account.banner_url;

  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      await api.uploadAccountImage(account.id, kind, file);
      toast.success(`${label} updated`);
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="stack-sm">
      <div className="row-between">
        <span className="stat-label">{label}</span>
        {uploaded && linked && (
          <span className="small muted" title={linked}>a pasted address is kept underneath</span>
        )}
      </div>
      <div className={`image-slot image-slot-${aspect}`}>
        <AuthedImage
          src={src}
          alt={`${account.name} ${label.toLowerCase()}`}
          className="image-slot-img"
          fallback={
            <span className="image-slot-empty small muted">
              <Icon name="image" size={18} />
              {busy ? 'Uploading…' : 'Nothing yet'}
            </span>
          }
        />
      </div>
      {canEdit && (
        <div className="row wrap" style={{ gap: 6 }}>
          <input ref={input} type="file" accept="image/*" hidden
            onChange={(e) => pick(e.target.files?.[0])} />
          <button type="button" className="btn btn-sm" disabled={busy}
            onClick={() => input.current?.click()}>
            {uploaded ? 'Replace' : 'Upload'}
          </button>
          {uploaded && (
            <ConfirmButton label="Remove" confirmLabel="Remove it?" className="btn btn-sm btn-ghost"
              onConfirm={async () => {
                try {
                  await api.removeAccountImage(account.id, kind);
                  toast.success(linked ? 'Upload removed — the pasted address is used again' : 'Removed');
                  onChanged();
                } catch (err) { toast.error(err); }
              }} />
          )}
        </div>
      )}
      {hint && <div className="small muted">{hint}</div>}
    </div>
  );
}

function LocationDialog({ accountId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    label: '', kind: 'OPERATING', address: '', city: '', state: '', country: 'India',
    latitude: '', longitude: '', precision: 'APPROXIMATE',
  });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  const save = async () => {
    if (!form.city.trim() && !form.state.trim() && !form.address.trim()) {
      return toast.error('Say where — a city, a state or an address');
    }
    setSaving(true);
    try {
      await api.addAccountLocation(accountId, {
        label: form.label.trim() || null,
        kind: form.kind,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        country: form.country.trim() || 'India',
        latitude: form.latitude === '' ? null : Number(form.latitude),
        longitude: form.longitude === '' ? null : Number(form.longitude),
        precision: form.precision,
      });
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
      title="Add a place"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Add it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="What is it called?">
            <input className="input" autoFocus value={form.label}
              onChange={(e) => set({ label: e.target.value })} placeholder="Pune head office" />
          </Field>
          <Field label="What kind">
            <select className="select" value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
              <option value="HQ">Head office</option>
              <option value="OPERATING">Where they operate</option>
              <option value="SITE">A specific site</option>
            </select>
          </Field>
        </div>
        <Field label="Address">
          <textarea className="textarea" rows={2} value={form.address}
            onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <div className="grid-2">
          <Field label="City / district">
            <input className="input" value={form.city} onChange={(e) => set({ city: e.target.value })} />
          </Field>
          <Field label="State">
            <input className="input" value={form.state} onChange={(e) => set({ state: e.target.value })} />
          </Field>
        </div>
        <Field
          label="Coordinates, if you know them"
          hint="Left blank they stay blank. Nothing is looked up or guessed, so a place with no coordinates is listed as unmapped rather than dropped on the map somewhere wrong."
        >
          <div className="grid-2">
            <input className="input" type="number" step="any" placeholder="Latitude"
              value={form.latitude} onChange={(e) => set({ latitude: e.target.value })} />
            <input className="input" type="number" step="any" placeholder="Longitude"
              value={form.longitude} onChange={(e) => set({ longitude: e.target.value })} />
          </div>
        </Field>
        <Field label="How exact is that">
          <select className="select" value={form.precision}
            onChange={(e) => set({ precision: e.target.value })}>
            <option value="EXACT">Exact — taken on site</option>
            <option value="APPROXIMATE">Approximate — the town centre, roughly</option>
            <option value="REGION">Region only — the district, not a point</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

export default function AccountDossier({ account, locations = [], canEdit, onChanged }) {
  const toast = useToast();
  const [segments, setSegments] = useState(null);
  const [editing, setEditing] = useState(false);
  const [addingPlace, setAddingPlace] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.crmSegments().then((r) => setSegments(r.segments)).catch(() => setSegments([]));
  }, []);

  const startEdit = () => {
    setForm({
      segment_id: account.segment_id || '',
      hq_address: account.hq_address || '',
      linkedin_url: account.linkedin_url || '',
      operating_regions: chips(account.operating_regions).join(', '),
      crops: chips(account.crops).join(', '),
      tags: chips(account.tags).join(', '),
      relationship_summary: account.relationship_summary || '',
      why_it_matters: account.why_it_matters || '',
      relationship_potential: account.relationship_potential ?? '',
    });
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAccount(account.id, {
        segment_id: form.segment_id ? Number(form.segment_id) : null,
        hq_address: form.hq_address.trim() || null,
        linkedin_url: form.linkedin_url.trim() || null,
        operating_regions: parseList(form.operating_regions),
        crops: parseList(form.crops),
        tags: parseList(form.tags),
        relationship_summary: form.relationship_summary.trim() || null,
        why_it_matters: form.why_it_matters.trim() || null,
        relationship_potential: form.relationship_potential === ''
          ? null : Number(form.relationship_potential),
      });
      toast.success('Saved');
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const segment = segments?.find((s) => s.id === account.segment_id);
  const template = segment?.scope_template || [];
  const set = (patch) => setForm((c) => ({ ...c, ...patch }));

  return (
    <div className="stack">
      <section className="card card-pad stack">
        <div className="row-between wrap">
          <div>
            <h2>Who they are</h2>
            <div className="small muted">
              This outlives any one deal — the relationship, not the opportunity.
            </div>
          </div>
          {canEdit && !editing && (
            <button type="button" className="btn btn-sm" onClick={startEdit}>
              <Icon name="edit" size={13} /> Edit the dossier
            </button>
          )}
        </div>

        <div className="dossier-images">
          <ImageSlot account={account} kind="banner" label="Banner" aspect="wide"
            canEdit={canEdit} onChanged={onChanged}
            hint="A photograph of their work, their site, their team." />
          <ImageSlot account={account} kind="logo" label="Logo" aspect="square"
            canEdit={canEdit} onChanged={onChanged} />
        </div>

        {editing ? (
          <div className="stack">
            <Field label="What kind of organization are they?"
              hint="This decides which scope questions are worth asking about a deal with them.">
              <select className="select" value={form.segment_id}
                onChange={(e) => set({ segment_id: e.target.value })}>
                <option value="">Not classified</option>
                {(segments || []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
            <div className="grid-2">
              <Field label="Head office">
                <textarea className="textarea" rows={2} value={form.hq_address}
                  onChange={(e) => set({ hq_address: e.target.value })} />
              </Field>
              <Field label="LinkedIn">
                <input className="input" value={form.linkedin_url}
                  onChange={(e) => set({ linkedin_url: e.target.value })}
                  placeholder="https://www.linkedin.com/company/…" />
              </Field>
            </div>
            <div className="grid-2">
              <Field label="Where they operate" hint="Comma separated">
                <input className="input" value={form.operating_regions}
                  onChange={(e) => set({ operating_regions: e.target.value })}
                  placeholder="Maharashtra, Karnataka, Telangana" />
              </Field>
              <Field label="Crops" hint="Comma separated">
                <input className="input" value={form.crops}
                  onChange={(e) => set({ crops: e.target.value })}
                  placeholder="cotton, soybean, sugarcane" />
              </Field>
            </div>
            <Field label="Tags" hint="Anything you want to filter on later">
              <input className="input" value={form.tags}
                onChange={(e) => set({ tags: e.target.value })}
                placeholder="csr-funded, fpo-network, warm" />
            </Field>
            <Field label="Who are they, in a paragraph?">
              <textarea className="textarea" rows={3} value={form.relationship_summary}
                onChange={(e) => set({ relationship_summary: e.target.value })}
                placeholder="A farmer producer company federating 40 FPOs across western Maharashtra…" />
            </Field>
            <Field label="Why does this relationship matter to us?"
              hint="The reason somebody should still be working this in six months">
              <textarea className="textarea" rows={2} value={form.why_it_matters}
                onChange={(e) => set({ why_it_matters: e.target.value })} />
            </Field>
            <Field
              label="What could the whole relationship be worth?"
              hint="A standing estimate about the organization, not a deal. It is never added to the pipeline and never forecast."
            >
              <input className="input" type="number" min="0" value={form.relationship_potential}
                onChange={(e) => set({ relationship_potential: e.target.value })} />
            </Field>
            <div className="row">
              <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save the dossier'}
              </button>
            </div>
          </div>
        ) : (
          <div className="stack-sm">
            <div className="row wrap" style={{ gap: 6 }}>
              {account.segment_name
                ? <Badge dot={account.segment_color}>{account.segment_name}</Badge>
                : <span className="small muted">Not classified — a segment decides which scope questions to ask.</span>}
              {chips(account.tags).map((t) => <span key={t} className="tag-chip">{t}</span>)}
            </div>

            <dl className="dossier-grid">
              {account.hq_address && (
                <div><dt>Head office</dt><dd>{account.hq_address}</dd></div>
              )}
              {chips(account.operating_regions).length > 0 && (
                <div><dt>Operates in</dt><dd>{chips(account.operating_regions).join(' · ')}</dd></div>
              )}
              {chips(account.crops).length > 0 && (
                <div><dt>Crops</dt><dd>{chips(account.crops).join(' · ')}</dd></div>
              )}
              {account.linkedin_url && (
                <div>
                  <dt>LinkedIn</dt>
                  <dd><a className="btn-link" href={account.linkedin_url} target="_blank" rel="noreferrer noopener">
                    their page
                  </a></dd>
                </div>
              )}
              {account.relationship_potential !== null && account.relationship_potential !== undefined && (
                <div>
                  <dt>Relationship potential</dt>
                  <dd>
                    {exactMoney(account.relationship_potential, account.currency)}
                    <div className="small muted">
                      A standing estimate about them. Not in the pipeline, not forecast.
                    </div>
                  </dd>
                </div>
              )}
            </dl>

            {account.relationship_summary && (
              <div className="record-block" style={{ padding: 10 }}>
                <div className="record-block-title">Who they are</div>
                <p className="record-text">{account.relationship_summary}</p>
              </div>
            )}
            {account.why_it_matters && (
              <div className="record-block" style={{ padding: 10 }}>
                <div className="record-block-title">Why it matters to us</div>
                <p className="record-text">{account.why_it_matters}</p>
              </div>
            )}
            {!account.relationship_summary && !account.why_it_matters && (
              <p className="small muted">
                Nothing written about them yet. When whoever leads this is away, this page is all
                anyone else has.
              </p>
            )}
          </div>
        )}
      </section>

      {template.length > 0 && !editing && (
        <section className="card card-pad stack-sm">
          <h2>What to pin down</h2>
          <div className="small muted">
            Because they are {account.segment_name ? <strong>{account.segment_name}</strong> : 'this kind of partner'}.
            A different kind of partner would be asked different things. These are prompts, not
            required fields, and they are answered per deal on the Opportunities tab.
          </div>
          <ul className="prompt-list">
            {template.map((field) => (
              <li key={field.key}>
                <strong>{field.label}</strong>
                {field.hint && <span className="muted small"> — {field.hint}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card card-pad stack-sm">
        <div className="row-between wrap">
          <div>
            <h2>Where they are</h2>
            <div className="small muted">
              Places with coordinates appear on the map. Places without are listed, never guessed at.
            </div>
          </div>
          {canEdit && (
            <button type="button" className="btn btn-sm" onClick={() => setAddingPlace(true)}>
              <Icon name="plus" size={13} /> Add a place
            </button>
          )}
        </div>
        {locations.length === 0 ? (
          <p className="small muted">No places recorded.</p>
        ) : (
          <ul className="plain-list">
            {locations.map((loc) => (
              <li key={loc.id} className="row" style={{ gap: 8 }}>
                <Icon name="target" size={14} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 13 }}>
                    {loc.label || [loc.city, loc.state].filter(Boolean).join(', ') || 'Unnamed place'}
                  </strong>
                  <div className="small muted">
                    {[loc.city, loc.state, loc.country].filter(Boolean).join(', ')}
                    {loc.kind === 'HQ' && ' · head office'}
                    {loc.latitude === null || loc.latitude === undefined
                      ? ' · not on the map'
                      : ` · ${Number(loc.latitude).toFixed(3)}, ${Number(loc.longitude).toFixed(3)} (${String(loc.precision || '').toLowerCase()})`}
                  </div>
                  {loc.address && <div className="small">{loc.address}</div>}
                </span>
                {canEdit && (
                  <ConfirmButton label="Remove" confirmLabel="Remove it?" className="btn btn-sm btn-ghost"
                    onConfirm={async () => {
                      try {
                        await api.deleteAccountLocation(account.id, loc.id);
                        onChanged();
                      } catch (err) { toast.error(err); }
                    }} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!segments && <Spinner label="Loading segments" />}
      {addingPlace && (
        <LocationDialog accountId={account.id}
          onClose={() => setAddingPlace(false)} onSaved={onChanged} />
      )}
    </div>
  );
}
