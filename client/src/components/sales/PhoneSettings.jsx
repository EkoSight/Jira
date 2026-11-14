import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, BASE, tokenStore } from '../../api/client.js';
import { useToast } from '../../state/AppState.jsx';
import { Badge, EmptyState, Field, Icon, Modal, Spinner } from '../ui.jsx';
import { exactTime } from '../../lib/crmWork.js';
import { phoneLabel } from '../../lib/sales.js';

/**
 * Settings → Calls from company phones. Everything a lead hears or reads
 * (the opening sentence, the privacy notice) and every rule the phones follow
 * is set here, in English and Hindi; nothing is written into the code.
 */
const TABS = [
  ['rules', 'Recording & rules'], ['words', 'Words & privacy notice'], ['phones', 'Phones & the app'],
  ['optouts', 'Opt-outs & complaints'], ['review', 'Weekly review'],
];

const LANGS = [['en', 'English'], ['hi', 'हिंदी']];

const MODE = {
  AUTOMATIC: ['Picked up automatically', 'good'], SHARE_BY_HAND: ['Shared by hand', 'warning'], NONE: ['Does not record', 'neutral'], UNKNOWN: ['Not confirmed', 'warning'],
};

const PERMISSION_WORDS = { phone: 'Phone', callLog: 'Call history', audio: 'Audio files', notifications: 'Notifications' };

/** Two languages side by side (stacked on a phone). */
function TwoLanguages({ label, hint, value = {}, onChange, rows = 2, mono = false }) {
  return (
    <fieldset className="two-langs stack-xs">
      <legend className="small"><strong>{label}</strong></legend>
      {hint && <div className="field-hint">{hint}</div>}
      <div className="grid-2">
        {LANGS.map(([k, l]) => (
          <Field key={k} label={l}>
            <textarea className={`textarea${mono ? ' is-mono' : ''}`} rows={rows} lang={k} value={value[k] || ''} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------- recording & rules

function Rules({ setup, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({ ...setup.settings }));
  const [busy, setBusy] = useState(false);
  const hours = f.callingHours || { start: '09:00', end: '21:00', workingDaysOnly: true };
  const blockers = setup.recording_blockers || [];
  const save = async () => {
    setBusy(true);
    try {
      await api.sales.put('/calling/setup', {
        deviceRecordings: f.deviceRecordings === true, recordingRetentionMonths: Number(f.recordingRetentionMonths) || 6,
        removePhoneCopy: f.removePhoneCopy !== false, maxRecordingMb: Number(f.maxRecordingMb) || 50, deviceSync: f.deviceSync !== false,
        callingHours: hours, dailyAttemptCap: Number(f.dailyAttemptCap) || 0,
      });
      toast.success('Saved');
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <section className="card card-pad stack">
        <h3>Recordings</h3>
        <label className="row small" style={{ gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={f.deviceRecordings === true} disabled={f.deviceRecordings !== true && blockers.length > 0}
            onChange={(e) => setF({ ...f, deviceRecordings: e.target.checked })} />
          <span><strong>Keep recordings of calls</strong><br /><span className="muted">From the phones that record by themselves, shared from a phone, or attached by hand. While this is off, calls are logged with their length and no recording is accepted.</span></span>
        </label>
        {blockers.length > 0 && (
          <div className="mkt-callout is-warning small">
            <strong>Before recordings can be switched on:</strong>
            <ul className="tight-list">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )}
        <div className="grid-3">
          <Field label="Keep each recording for (months)" hint="Counted in calendar months from the call, India time. Then the audio is deleted; the call, notes and outcome stay.">
            <input className="input" type="number" min="1" max="60" value={f.recordingRetentionMonths ?? 6} onChange={(e) => setF({ ...f, recordingRetentionMonths: e.target.value })} />
          </Field>
          <Field label="Largest recording (MB)">
            <input className="input" type="number" min="1" max="200" value={f.maxRecordingMb ?? 50} onChange={(e) => setF({ ...f, maxRecordingMb: e.target.value })} />
          </Field>
        </div>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.removePhoneCopy !== false} onChange={(e) => setF({ ...f, removePhoneCopy: e.target.checked })} />
          Remove the phone’s copy once TaskFlow has the recording (keeps the time limit true on the phone as well)
        </label>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.deviceSync !== false} onChange={(e) => setF({ ...f, deviceSync: e.target.checked })} />
          Phones send the calls with leads and customers from their call history
        </label>
      </section>
      <section className="card card-pad stack">
        <h3>Calling hours and pace</h3>
        <div className="grid-3">
          <Field label="Calls from"><input className="input" type="time" value={hours.start} onChange={(e) => setF({ ...f, callingHours: { ...hours, start: e.target.value } })} /></Field>
          <Field label="Until"><input className="input" type="time" value={hours.end} onChange={(e) => setF({ ...f, callingHours: { ...hours, end: e.target.value } })} /></Field>
          <Field label="Attempts per lead per day" hint="Retries included. A call-back the lead asked for is allowed past it. 0 means no limit.">
            <input className="input" type="number" min="0" max="20" value={f.dailyAttemptCap ?? 3} onChange={(e) => setF({ ...f, dailyAttemptCap: e.target.value })} />
          </Field>
        </div>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={hours.workingDaysOnly !== false} onChange={(e) => setF({ ...f, callingHours: { ...hours, workingDaysOnly: e.target.checked } })} />
          Only on working days (the sales calendar’s holidays and weekly offs)
        </label>
        <p className="small muted">Outside these hours a call needs a reason, which is kept and listed in the weekly review.</p>
      </section>
      <div><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
    </div>
  );
}

// ---------------------------------------------------------------- words & the privacy notice

function Words({ setup, onSaved }) {
  const toast = useToast();
  const s = setup.settings;
  const [f, setF] = useState(() => ({
    companyName: s.companyName || '', openingSentence: s.openingSentence || {}, staffPolicy: { en: s.staffPolicy?.en || '', hi: s.staffPolicy?.hi || '' },
    notice: {
      legalName: s.privacyNotice?.legalName || '', address: s.privacyNotice?.address || '', contactName: s.privacyNotice?.contactName || '',
      contactPhone: s.privacyNotice?.contactPhone || '', contactEmail: s.privacyNotice?.contactEmail || '',
      en: s.privacyNotice?.en || '', hi: s.privacyNotice?.hi || '', formLine: s.privacyNotice?.formLine || {},
    },
  }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [lang, setLang] = useState('en');
  const n = f.notice;
  const setN = (patch) => setF({ ...f, notice: { ...n, ...patch } });
  const published = setup.notice_published;
  const save = async () => {
    setBusy(true);
    try {
      await api.sales.put('/calling/setup', {
        companyName: f.companyName.trim(), openingSentence: { en: f.openingSentence.en || '', hi: f.openingSentence.hi || '' }, staffPolicy: f.staffPolicy,
        privacyNotice: {
          legalName: n.legalName.trim(), address: n.address.trim(), contactName: n.contactName.trim(), contactPhone: n.contactPhone.trim(),
          contactEmail: n.contactEmail.trim(), en: n.en, hi: n.hi, formLine: { en: n.formLine.en || '', hi: n.formLine.hi || '' },
        },
      });
      toast.success('Saved. The privacy notice changes only when you publish it.');
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const showPreview = async () => {
    try { setPreview(await api.sales.get('/calling/notice/preview')); } catch (err) { toast.error(err); }
  };
  const publish = async () => {
    if (!window.confirm('Publish the privacy notice as it is saved now? Leads will see this version.')) return;
    try {
      await api.sales.post('/calling/notice/publish', {});
      toast.success('Published');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <div className="stack">
      <section className="card card-pad stack">
        <h3>What the salesperson says</h3>
        <Field label="The company name leads hear" hint="Used in the opening sentence, the privacy notice and the phone policy as {company}.">
          <input className="input" value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} />
        </Field>
        <TwoLanguages label="The opening sentence, said at the start of every recorded call" hint="Shown at the top of the call panel. {first_name} is the salesperson, {company} the name above."
          value={f.openingSentence} onChange={(v) => setF({ ...f, openingSentence: v })} />
        <TwoLanguages label={`The company phone policy (version ${s.staffPolicy?.version || 1})`} hint="Shown in the app’s setup with “I understand”. Changing the words makes a new version, and everyone is asked again."
          value={f.staffPolicy} onChange={(v) => setF({ ...f, staffPolicy: v })} rows={4} />
      </section>
      <section className="card card-pad stack">
        <div className="row-between wrap" style={{ gap: 8 }}>
          <h3>The privacy notice for leads</h3>
          {published ? <Badge tone="good">Published: version {published.version}, {exactTime(published.publishedAt)}</Badge> : <Badge tone="warning">Not published</Badge>}
        </div>
        {setup.notice_draft_changed && <div className="mkt-callout small">The saved text differs from what leads see. Publish it when it is ready.</div>}
        <div className="grid-2">
          <Field label="Legal name"><input className="input" value={n.legalName} onChange={(e) => setN({ legalName: e.target.value })} /></Field>
          <Field label="Contact person for questions and complaints"><input className="input" value={n.contactName} onChange={(e) => setN({ contactName: e.target.value })} /></Field>
          <Field label="Contact phone"><input className="input" inputMode="tel" value={n.contactPhone} onChange={(e) => setN({ contactPhone: e.target.value })} /></Field>
          <Field label="Contact email"><input className="input" type="email" value={n.contactEmail} onChange={(e) => setN({ contactEmail: e.target.value })} /></Field>
        </div>
        <Field label="Address"><textarea className="textarea" rows={2} value={n.address} onChange={(e) => setN({ address: e.target.value })} /></Field>
        {setup.notice_missing?.length > 0 && <div className="small warning-text">Still needed before publishing: {setup.notice_missing.join(', ')}.</div>}
        <TwoLanguages label="The notice" rows={12} mono
          hint="“# ” starts the title, “## ” a heading, “- ” a list item; a blank line starts a new paragraph. {legal_name}, {address}, {company}, {retention_months}, {contact_name}, {contact_lines} and {date} are filled in."
          value={{ en: n.en, hi: n.hi }} onChange={(v) => setN({ en: v.en, hi: v.hi })} />
        <TwoLanguages label="The line under every hosted enquiry form" hint="Followed by a link to the notice." value={n.formLine} onChange={(v) => setN({ formLine: v })} />
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn" onClick={showPreview}>Preview the saved notice</button>
          <button type="button" className="btn" disabled={setup.notice_missing?.length > 0} onClick={publish}>Publish</button>
          {published && <a className="btn btn-ghost" href={`${BASE}/s/privacy`} target="_blank" rel="noreferrer">Open the public page <Icon name="link" size={13} /></a>}
        </div>
        <p className="small muted">Website forms that send leads through the capture API should show the same line and link: {window.location.origin}{BASE}/s/privacy</p>
      </section>
      {preview && (
        <Modal title="Privacy notice (saved, not yet published)" size="lg" onClose={() => setPreview(null)}>
          <div className="stack-sm">
            <div className="row" style={{ gap: 4 }} role="group" aria-label="Language">
              {LANGS.map(([k, l]) => <button key={k} type="button" className={`kind-chip${lang === k ? ' is-active' : ''}`} aria-pressed={lang === k} onClick={() => setLang(k)}>{l}</button>)}
            </div>
            {/* the server builds this from the saved text (escaped); it is shown in a sandbox all the same */}
            <iframe className="notice-preview" title="Privacy notice preview" sandbox=""
              srcDoc={`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>body{font:15px/1.55 system-ui,sans-serif;margin:16px;color:#1d2420;background:#fff;max-width:70ch}h1{font-size:20px}h2{font-size:15px;margin-top:16px}</style></head><body>${preview[lang] || ''}</body></html>`} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- phones and the app

async function uploadApp(file, version, notes) {
  const form = new FormData();
  form.append('version', version);
  form.append('notes', notes);
  form.append('file', file, file.name);
  const token = tokenStore.get();
  const res = await fetch(`${BASE}/sales/calling/app`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

function DiallerModeForm({ packages, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ package: packages[0] || '', mode: 'AUTOMATIC', folder_hint: '', note: '' });
  const save = async () => {
    try {
      await api.sales.put('/calling/dialler-modes', { package: f.package.trim(), mode: f.mode, folder_hint: f.folder_hint.trim() || null, note: f.note.trim() || null });
      toast.success('Confirmed');
      onDone();
    } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack-sm">
      <div className="grid-2">
        <Field label="Phone app (package, as the phone reports it)">
          <input className="input" list="dialler-packages" value={f.package} onChange={(e) => setF({ ...f, package: e.target.value })} />
          <datalist id="dialler-packages">{packages.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
        <Field label="Its recordings">
          <select className="select" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
            <option value="AUTOMATIC">Saved to a folder: picked up automatically</option>
            <option value="SHARE_BY_HAND">Kept inside the app: shared by hand</option>
            <option value="NONE">Not recorded</option>
          </select>
        </Field>
        <Field label="Where the recordings are saved (shown in the app’s setup)"><input className="input" value={f.folder_hint} onChange={(e) => setF({ ...f, folder_hint: e.target.value })} placeholder="Internal storage → Recordings → Call" /></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Checked on a test call" /></Field>
      </div>
      <div><button type="button" className="btn btn-sm" disabled={!f.package.trim()} onClick={save}>Confirm</button></div>
    </div>
  );
}

function Phones({ setup, onSaved }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [app, setApp] = useState({ file: null, version: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.sales.get('/calling/devices').then(setData).catch((err) => setData({ error: err.message })), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Spinner />;
  if (data.error) return <div className="critical-text small">{data.error}</div>;
  const act = async (p, message) => { try { await p; toast.success(message); load(); } catch (err) { toast.error(err); } };
  const release = setup.settings.appRelease;
  const unconfirmed = [...new Set(data.devices.filter((d) => d.dialler_package && !d.recording_mode?.confirmed).map((d) => d.dialler_package))];
  const sendApp = async () => {
    setBusy(true);
    try {
      await uploadApp(app.file, app.version.trim(), app.notes.trim());
      toast.success('Uploaded: phones are offered this version');
      setApp({ file: null, version: '', notes: '' });
      onSaved();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><h3>Phones</h3><span className="small muted">{data.devices.length} registered</span></div>
        {data.devices.length === 0 ? <div className="card-pad small muted">No phone has been set up yet. Install the app on a company phone and sign in; its setup registers it here.</div> : (
          <ul className="plain-list phone-list">
            {data.devices.map((d) => {
              const [modeLabel, modeTone] = MODE[d.recording_mode?.mode] || MODE.UNKNOWN;
              const perms = d.permissions && typeof d.permissions === 'object' ? Object.entries(d.permissions) : [];
              return (
                <li key={d.id} className={`phone-row${d.revoked_at ? ' is-revoked' : ''}`}>
                  <div className="stack-xs grow" style={{ minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <strong>{d.asset_label || `Phone #${d.id}`}</strong>
                      <span className="small muted">{[d.maker, d.model].filter(Boolean).join(' ')}{d.android_version ? ` · Android ${d.android_version}` : ''}{d.app_version ? ` · app ${d.app_version}` : ''}</span>
                      {d.revoked_at && <Badge tone="critical">Blocked</Badge>}
                      {d.not_synced_for_a_day && !d.revoked_at && <Badge tone="warning">Not synced for over a day</Badge>}
                    </div>
                    <div className="small row wrap" style={{ gap: 6 }}>
                      <span>{d.signed_in_name ? <>Used by <strong>{d.signed_in_name}</strong></> : <span className="muted">Nobody signed in</span>}</span>
                      {d.signed_in_name && d.policy_acknowledged === false && <Badge tone="warning">Phone policy not acknowledged</Badge>}
                      {d.sim_number && <span className="muted">SIM {phoneLabel(d.sim_number)}</span>}
                    </div>
                    <div className="small row wrap" style={{ gap: 6 }}>
                      <span className="muted">{d.dialler_package || 'phone app not reported'}</span>
                      <Badge tone={modeTone}>{modeLabel}{d.recording_mode?.confirmed ? '' : ' (expected)'}</Badge>
                      <span className="muted">Folder {d.folder_chosen ? 'chosen' : 'not chosen'}</span>
                      <span className="muted tnum">Last sync {d.last_sync_at ? exactTime(d.last_sync_at) : 'never'}</span>
                      <span className="muted tnum">7 days: {d.calls_7_days} call{d.calls_7_days === 1 ? '' : 's'}, {d.recordings_7_days} recording{d.recordings_7_days === 1 ? '' : 's'}</span>
                    </div>
                    {perms.length > 0 && (
                      <div className="small row wrap" style={{ gap: 4 }}>
                        {perms.map(([k, v]) => <Badge key={k} tone={v === 'granted' ? 'good' : 'warning'}>{PERMISSION_WORDS[k] || k}: {v === 'granted' ? 'allowed' : 'not allowed'}</Badge>)}
                      </div>
                    )}
                    {Array.isArray(d.warnings) && d.warnings.length > 0 && (
                      <ul className="tight-list small warning-text">{d.warnings.map((w) => <li key={w.code}>{w.text} ({w.day})</li>)}</ul>
                    )}
                    {d.last_error && <div className="small critical-text">Last problem: {d.last_error}</div>}
                    {d.revoked_at && <div className="small muted">Blocked {exactTime(d.revoked_at)} by {d.revoked_by_name || 'an administrator'}{d.revoke_reason ? `: ${d.revoke_reason}` : ''}</div>}
                  </div>
                  <div className="row wrap phone-actions" style={{ gap: 4 }}>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => { const v = window.prompt('The company’s label for this phone (asset tag)', d.asset_label || ''); if (v !== null) act(api.sales.patch(`/calling/devices/${d.id}`, { asset_label: v.trim() || null }), 'Saved'); }}>Label…</button>
                    {d.signed_in_user_id && !d.revoked_at && <button type="button" className="btn btn-sm" onClick={() => window.confirm('Hand this phone to someone else? The current person’s sync on it ends; their earlier calls stay theirs.') && act(api.sales.post(`/calling/devices/${d.id}/hand-over`, {}), 'Handed over: the next person signs in on the phone')}>Hand to someone else</button>}
                    {d.revoked_at
                      ? <button type="button" className="btn btn-sm" onClick={() => act(api.sales.post(`/calling/devices/${d.id}/allow`, {}), 'Allowed again')}>Allow again</button>
                      : <button type="button" className="btn btn-sm btn-ghost" onClick={() => { const r = window.prompt('Why block this phone? Nothing more is accepted from it.'); if (r && r.trim().length >= 3) act(api.sales.post(`/calling/devices/${d.id}/revoke`, { reason: r.trim() }), 'Blocked'); }}>Block…</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="card card-pad stack-sm">
        <h3>How each phone app records</h3>
        <p className="small muted">A phone’s recordings are picked up automatically only once its phone app is confirmed here, after a test call on that model. Samsung’s phone app is expected to save recordings to a folder; Google’s Phone app (Motorola) keeps them inside the app, so they are shared by hand.</p>
        {data.dialler_modes.length > 0 && (
          <ul className="plain-list stack-xs">
            {data.dialler_modes.map((m) => (
              <li key={m.package} className="small row wrap" style={{ gap: 6 }}>
                <code>{m.package}</code><Badge tone={MODE[m.mode]?.[1]}>{MODE[m.mode]?.[0]}</Badge>
                {m.folder_hint && <span className="muted">{m.folder_hint}</span>}
                <span className="muted">confirmed by {m.confirmed_by_name || 'someone'} {exactTime(m.confirmed_at)}</span>
              </li>
            ))}
          </ul>
        )}
        <DiallerModeForm packages={unconfirmed} onDone={load} />
      </section>
      <section className="card card-pad stack-sm">
        <h3>The Android app</h3>
        {release?.version ? <p className="small">Current version <strong>{release.version}</strong>, uploaded {exactTime(release.uploadedAt)}{release.notes ? `: ${release.notes}` : ''}. Staff download it from Settings → My account, behind a link that lasts 30 minutes.</p>
          : <p className="small muted">No version uploaded yet. Build a signed release (apps/android/README.md), then upload the .apk here. Phones offer the update by themselves.</p>}
        <div className="grid-3">
          <Field label="The .apk file"><input className="input" type="file" accept=".apk,application/vnd.android.package-archive" onChange={(e) => setApp({ ...app, file: e.target.files?.[0] || null })} /></Field>
          <Field label="Version"><input className="input" value={app.version} onChange={(e) => setApp({ ...app, version: e.target.value })} placeholder="1.0.0" /></Field>
          <Field label="What changed"><input className="input" value={app.notes} onChange={(e) => setApp({ ...app, notes: e.target.value })} /></Field>
        </div>
        <div><button type="button" className="btn btn-sm" disabled={!app.file || !app.version.trim() || busy} onClick={sendApp}><Icon name="upload" size={13} /> {busy ? 'Uploading…' : 'Upload this version'}</button></div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- opt-outs and complaints

function OptOuts() {
  const toast = useToast();
  const [all, setAll] = useState(false);
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const load = useCallback(() => api.sales.get('/calling/optouts', { all: all ? '1' : undefined }).then(setData).catch((err) => setData({ error: err.message })), [all]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Spinner />;
  if (data.error) return <div className="critical-text small">{data.error}</div>;
  const lift = async (o) => {
    const reason = window.prompt(`Lift the opt-out for ${phoneLabel(o.address)}? Say why (for example: the customer asked us to call them).`);
    if (!reason || reason.trim().length < 3) return;
    try { await api.sales.post('/calling/optouts/lift', { address: o.address, reason: reason.trim() }); toast.success('Lifted: the number can be called again'); load(); } catch (err) { toast.error(err); }
  };
  const readFile = (file) => file && file.text().then((t) => { setText(t); setPreview(null); });
  const runPreview = async () => {
    try { setPreview(await api.sales.post('/calling/optouts/import/preview', { text })); } catch (err) { toast.error(err); }
  };
  const apply = async () => {
    try {
      const r = await api.sales.post('/calling/optouts/import/apply', { text, fingerprint: preview.fingerprint });
      toast.success(`${r.added} number${r.added === 1 ? '' : 's'} added to the opt-out list`);
      setText(''); setPreview(null); load();
    } catch (err) { toast.error(err); }
  };
  return (
    <div className="stack">
      {data.complaints_10_days >= 3 && (
        <div className="mkt-callout is-warning small">
          <strong>{data.complaints_10_days} complaints in the last 10 days.</strong> Check what is causing them. Complaints made to the telecom operator, which TaskFlow cannot see, can lead to the company’s numbers being cut off.
        </div>
      )}
      <section className="card">
        <div className="card-head"><h3>Complaints</h3><span className="small muted">{data.complaints.length} recorded</span></div>
        {data.complaints.length === 0 ? <div className="card-pad small muted">None.</div> : (
          <ul className="plain-list card-pad stack-sm">
            {data.complaints.map((k) => (
              <li key={k.id} className="stack-xs">
                <div className="small row wrap" style={{ gap: 6 }}>
                  <span className="tnum muted">{exactTime(k.created_at)}</span>
                  {k.lead_id ? <Link to={`/sales/leads/${k.lead_id}`}>{k.about || k.lead_ref}</Link> : <span>{k.about || '—'}</span>}
                  <span className="muted">recorded by {k.recorded_by_name || 'someone'}</span>
                </div>
                <blockquote className="call-note small">{k.what_they_said}</blockquote>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Do not call</h3>
          <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show lifted ones too</label>
        </div>
        {data.optouts.length === 0 ? <div className="card-pad small muted">Nobody has asked not to be called.</div> : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Number</th><th>Lead</th><th>Since</th><th>How</th><th>Reason</th><th /></tr></thead>
              <tbody>{data.optouts.map((o) => (
                <tr key={o.id} className={o.lifted_at ? 'is-voided' : ''}>
                  <td className="tnum nowrap">{phoneLabel(o.address)}</td>
                  <td>{o.lead_id ? <Link to={`/sales/leads/${o.lead_id}`}>{o.lead_name || o.lead_ref}</Link> : <span className="muted">—</span>}</td>
                  <td className="tnum nowrap">{exactTime(o.created_at)}</td>
                  <td className="small">{o.complaint ? <Badge tone="critical">Complaint</Badge> : String(o.source || '').toLowerCase().replace(/_/g, ' ')}{o.actor_name ? ` · ${o.actor_name}` : ''}</td>
                  <td className="small">{o.reason || '—'}{o.lifted_at ? <div className="muted">Lifted {exactTime(o.lifted_at)} by {o.lifted_by_name || 'someone'}: {o.lift_reason}</div> : null}</td>
                  <td>{!o.lifted_at && <button type="button" className="btn btn-sm btn-ghost" onClick={() => lift(o)}>Lift…</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card card-pad stack-sm">
        <h3>Import a do-not-call list</h3>
        <p className="small muted">Paste numbers, one per line, or a CSV with a phone column (for example, the leads TeleCRM marked “do not call”). Nothing is saved until you check the preview and add them.</p>
        <Field label="Numbers"><textarea className="textarea" rows={5} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} /></Field>
        <div className="row wrap" style={{ gap: 6 }}>
          <input type="file" accept=".csv,text/csv,text/plain" aria-label="Or choose a CSV file" onChange={(e) => readFile(e.target.files?.[0])} />
          <button type="button" className="btn btn-sm" disabled={!text.trim()} onClick={runPreview}>Preview</button>
        </div>
        {preview && (
          <div className="mkt-callout small stack-xs">
            <div><strong>{preview.new_numbers}</strong> new number{preview.new_numbers === 1 ? '' : 's'} to opt out · {preview.already_opted_out} already on the list · {preview.leads_matched} lead{preview.leads_matched === 1 ? '' : 's'} match · {preview.duplicates} repeated · {preview.invalid_count} not a phone number</div>
            {preview.invalid_count > 0 && <div className="muted">Not used: {preview.invalid.slice(0, 8).join(', ')}{preview.invalid_count > 8 ? '…' : ''}</div>}
            <div><button type="button" className="btn btn-sm btn-primary" disabled={!preview.new_numbers} onClick={apply}>Add {preview.new_numbers} to the opt-out list</button></div>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- the weekly review

function Review() {
  const [data, setData] = useState(null);
  useEffect(() => { api.sales.get('/calling/review').then(setData).catch((err) => setData({ error: err.message })); }, []);
  if (!data) return <Spinner />;
  if (data.error) return <div className="critical-text small">{data.error}</div>;
  const tiles = [
    ['New opt-outs', data.opt_outs, data.opt_outs_imported ? `${data.opt_outs_imported} from an import` : null],
    ['Complaints', data.complaints.length, null],
    ['Calls outside hours', data.calls_outside_hours.length, null],
    ['Leads that hit the daily limit', data.leads_at_daily_cap, null],
  ];
  return (
    <div className="stack">
      <p className="small muted">The week from {exactTime(data.from)} to {exactTime(data.to)}. Administrators also get this in the bell every Monday morning.</p>
      <div className="stat-grid">
        {tiles.map(([label, value, note]) => (
          <div key={label} className="stat sales-metric"><span className="stat-label">{label}</span><span className="stat-value tnum">{value}</span>{note && <span className="stat-note">{note}</span>}</div>
        ))}
      </div>
      {data.complaints.length > 0 && (
        <section className="card card-pad stack-xs">
          <h3>Complaints</h3>
          {data.complaints.map((k) => <div key={k.id} className="small"><span className="tnum muted">{exactTime(k.created_at)}</span> · {k.about || '—'}: “{k.what_they_said}”</div>)}
        </section>
      )}
      {data.calls_outside_hours.length > 0 && (
        <section className="card card-pad stack-xs">
          <h3>Calls outside calling hours</h3>
          {data.calls_outside_hours.map((c) => <div key={c.id} className="small"><span className="tnum muted">{exactTime(c.at)}</span> · call #{c.id} by {c.agent_name || 'someone'}: {c.hours_override_reason}</div>)}
        </section>
      )}
      {Object.keys(data.callbacks_past_limits || {}).length > 0 && (
        <p className="small muted">Allowed past a limit: {Object.entries(data.callbacks_past_limits).map(([k, v]) => `${v} ${k === 'THEY_CALLED' ? 'because they called' : 'call-backs they asked for'}`).join(', ')}.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the section

export default function PhoneSettings() {
  const [tab, setTab] = useState('rules');
  const [setup, setSetup] = useState(null);
  const load = useCallback(() => api.sales.get('/calling/setup').then(setSetup).catch((err) => setSetup({ error: err.message })), []);
  useEffect(() => { load(); }, [load]);
  if (!setup) return <Spinner />;
  if (setup.error) return <EmptyState title="Could not load the calling settings">{setup.error}</EmptyState>;
  const on = setup.settings.deviceRecordings === true;
  return (
    <div className="stack phone-settings">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <div className="stack-xs">
          <h2>Calls from company phones</h2>
          <span className="small muted">Calls with leads and customers on the company SIMs: what is kept, for how long, and what leads are told.</span>
        </div>
        <Badge tone={on ? 'good' : 'neutral'}>{on ? 'Recordings on' : 'Recordings off'}</Badge>
      </div>
      <div className="tabs tabs-scroll" role="tablist">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'rules' && <Rules key={JSON.stringify(setup.settings)} setup={setup} onSaved={load} />}
      {tab === 'words' && <Words key={JSON.stringify(setup.settings)} setup={setup} onSaved={load} />}
      {tab === 'phones' && <Phones setup={setup} onSaved={load} />}
      {tab === 'optouts' && <OptOuts />}
      {tab === 'review' && <Review />}
    </div>
  );
}
