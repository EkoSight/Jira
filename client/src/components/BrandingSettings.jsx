import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useBranding, useToast } from '../state/AppState.jsx';
import { Badge, Field } from './ui.jsx';
import { BrandMark } from './BrandMark.jsx';
import { GROUNDS, checkBranding, normaliseHex } from '../../../shared/brandTheme.js';
import { exactTime } from '../lib/crmWork.js';

const LOGOS = [
  ['mark', 'Mark', 'The round logo: sidebar, sign-in, icons'],
  ['markDark', 'Mark for dark mode', 'Optional'],
  ['wordmark', 'Wordmark', 'The name as a logo: sign-in page'],
  ['wordmarkDark', 'Wordmark for dark mode', 'Optional; without it the wordmark sits on a light plate'],
];

/** One mode of the preview: the page's grounds plus the brand's shades, as CSS variables on a box. */
function Preview({ mode, palette, appName }) {
  const g = GROUNDS[mode];
  const status = mode === 'dark'
    ? { '--good-text': '#0ca30c', '--warning-text': '#fab219', '--critical-text': '#e88585', '--good-wash': 'rgba(12,163,12,0.16)', '--warning-wash': 'rgba(250,178,25,0.16)', '--critical-wash': 'rgba(208,59,59,0.18)' }
    : { '--good-text': '#006300', '--warning-text': '#8a5b00', '--critical-text': '#a52626', '--good-wash': '#e8f6e8', '--warning-wash': '#fdf3e0', '--critical-wash': '#fbebeb' };
  const style = {
    ...status,
    '--surface': g.surface, '--plane': g.plane, '--surface-2': g.surface2, '--surface-3': g.surface3, '--ink': g.ink,
    '--ink-muted': mode === 'dark' ? '#898781' : '#6c6b67', '--border': mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(11,11,11,0.12)',
    ...palette[mode], background: g.plane, color: g.ink,
  };
  return (
    <div className="brand-preview" style={style} aria-label={`${mode === 'dark' ? 'Dark' : 'Light'} mode preview`}>
      <div className="brand-preview-side">
        <span className="brand-preview-name">{appName}</span>
        <span className="brand-preview-nav is-active">My tasks</span>
        <span className="brand-preview-nav">Board</span>
      </div>
      <div className="brand-preview-main">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="btn btn-sm btn-primary">Save</span>
          <span className="btn btn-sm">Cancel</span>
          <span className="badge badge-brand">In progress</span>
        </div>
        <span className="brand-preview-link">Open the lead</span>
        <div className="brand-preview-bars" aria-hidden="true">
          <span style={{ height: '70%', background: 'var(--series-1)' }} />
          <span style={{ height: '45%', background: 'var(--series-2)' }} />
          <span style={{ height: '85%', background: 'var(--series-1)' }} />
          <span style={{ height: '30%', background: 'var(--series-2)' }} />
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge tone="critical">Overdue</Badge><Badge tone="warning">Due soon</Badge><Badge tone="good">Done</Badge>
        </div>
      </div>
    </div>
  );
}

function ColourField({ label, value, onChange, result }) {
  const hex = normaliseHex(value) || '#000000';
  return (
    <Field label={label}>
      <div className="row" style={{ gap: 8 }}>
        <input type="color" aria-label={`${label}: pick`} value={hex.toLowerCase()} onChange={(e) => onChange(e.target.value.toUpperCase())} className="brand-colour-pick" />
        <input className="input" aria-label={`${label}: hex code`} value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 120, fontFamily: 'ui-monospace, monospace' }} />
      </div>
      {result?.problems?.length > 0 && (
        <div className="small stack-xs" role="alert">
          {result.problems.map((p) => <span key={p.message} className="critical-text">{p.message}</span>)}
          {result.suggestion && (
            <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(result.suggestion)}>
              <span className="brand-swatch" style={{ background: result.suggestion }} /> Use {result.suggestion} instead
            </button>
          )}
        </div>
      )}
    </Field>
  );
}

/** Settings → Branding: name, colours with a live preview and readability checks, logos, Save, Reset and Undo. */
export default function BrandingSettings() {
  const toast = useToast();
  const { branding, setBranding } = useBranding();
  const [form, setForm] = useState(() => ({ appName: branding.appName, byline: branding.byline || '', primary: branding.primary, accent: branding.accent }));
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const loadHistory = () => api.get('/branding/history').then((r) => setHistory(r.history)).catch(() => {});
  useEffect(() => { loadHistory(); }, []);
  useEffect(() => {
    setForm({ appName: branding.appName, byline: branding.byline || '', primary: branding.primary, accent: branding.accent });
  }, [branding.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = useMemo(() => checkBranding({ primary: form.primary, accent: form.accent }), [form.primary, form.accent]);
  const changed = form.appName !== branding.appName || form.byline !== (branding.byline || '') || normaliseHex(form.primary) !== branding.primary || normaliseHex(form.accent) !== branding.accent;
  const apply = (b, message) => { setBranding(b); toast.success(message); loadHistory(); };
  const act = async (fn, message) => {
    if (busy) return;
    setBusy(true);
    try { apply(await fn(), message); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const save = () => act(() => api.put('/branding', { appName: form.appName, byline: form.byline, primary: form.primary, accent: form.accent }), 'Saved: everyone sees the new look within a couple of minutes');
  const reset = () => { if (window.confirm('Go back to the Soil Doctor defaults: name, colours and logos?')) act(() => api.post('/branding/reset'), 'Back to the defaults'); };
  const undo = () => act(() => api.post('/branding/undo'), 'The last change was undone');
  const upload = (kind) => (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const f = new FormData();
    f.append('file', file);
    act(() => api.form(`/branding/assets/${kind}`, f), 'Logo uploaded');
  };
  const clear = (kind) => act(() => api.del(`/branding/assets/${kind}`), 'Back to the bundled logo');

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Name and colours</h2></div>
        <div className="card-pad stack">
          <div className="grid-2">
            <Field label="App name" hint="What staff see in the sidebar, on the sign-in page and on their phone's home screen">
              <input className="input" value={form.appName} maxLength={40} onChange={(e) => setForm({ ...form, appName: e.target.value })} />
            </Field>
            <Field label="Under the name (optional)">
              <input className="input" value={form.byline} maxLength={60} onChange={(e) => setForm({ ...form, byline: e.target.value })} placeholder="by ekosight" />
            </Field>
            <ColourField label="Main colour" value={form.primary} onChange={(v) => setForm({ ...form, primary: v })} result={check.primary} />
            <ColourField label="Accent colour" value={form.accent} onChange={(v) => setForm({ ...form, accent: v })} result={check.accent} />
          </div>
          <div className="small muted">
            Every shade (hover, pressed, links, pale tints, dark mode) is worked out from these and checked for readability:
            at least 4.5:1 for text and 3:1 for buttons against the page. Status colours (overdue, warning, done) never change.
          </div>
          {check.ok ? (
            <div className="brand-previews">
              <Preview mode="light" palette={check.palette} appName={form.appName} />
              <Preview mode="dark" palette={check.palette} appName={form.appName} />
            </div>
          ) : <div className="mkt-callout is-warning small">Fix the colours above to see the preview.</div>}
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" className="btn btn-primary" disabled={busy || !changed || !check.ok || form.appName.trim().length < 2} onClick={save}>Save</button>
            <button type="button" className="btn" disabled={busy || history.length === 0} onClick={undo}>Undo the last change</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={reset}>Reset to default</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Logos</h2></div>
        <div className="card-pad stack-sm">
          <div className="small muted">SVG is best; PNG, JPEG and WebP are re-encoded. An SVG with scripts, links or embedded pages is refused. The browser icon and phone home-screen icons are made from the mark.</div>
          <div className="brand-logos">
            {LOGOS.map(([kind, label, hint]) => (
              <div key={kind} className="brand-logo-row">
                <div className={`brand-logo-sample${kind.endsWith('Dark') ? ' is-dark' : ''}`}>
                  {kind === 'mark' ? <BrandMark size={44} mode="off" label="" />
                    : branding.assets?.[kind] ? <img src={branding.assets[kind]} alt="" /> : <span className="small muted">Not set</span>}
                </div>
                <div className="stack-xs" style={{ flex: 1, minWidth: 160 }}>
                  <strong className="small">{label}</strong>
                  <span className="small muted">{branding.custom?.[kind] ? 'Uploaded' : kind === 'mark' || kind === 'wordmark' ? 'The bundled Soil Doctor one' : hint}</span>
                </div>
                <label className="btn btn-sm">
                  Upload<input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" hidden onChange={upload(kind)} />
                </label>
                {branding.custom?.[kind] && <button type="button" className="btn btn-sm btn-ghost" onClick={() => clear(kind)}>Use the bundled one</button>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Changes</h2></div>
        <div className="card-pad">
          {history.length === 0 ? <div className="small muted">No changes yet: the Soil Doctor defaults are in use.</div> : (
            <ul className="brand-history small">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="tnum muted">{exactTime(h.saved_at)}</span> · {h.saved_by_name || 'someone'} · {{ SAVE: 'saved', RESET: 'reset to default', UNDO: 'undid a change', ASSET: 'changed a logo' }[h.action]}
                  {' '}<span className="brand-swatch" style={{ background: h.primary }} title={h.primary} /><span className="brand-swatch" style={{ background: h.accent }} title={h.accent} /> {h.app_name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
