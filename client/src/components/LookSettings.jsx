import { useBranding } from '../state/AppState.jsx';
import { ACCENT_PRESETS } from '../../../shared/brandTheme.js';

const MODES = [['LIGHT', 'Light'], ['DARK', 'Dark'], ['SYSTEM', 'Match my device']];

/** In My account: light, dark or match the device, and an optional accent. Saved to the account, so it follows the person. */
export default function LookSettings() {
  const { mode, setMode, accent, setAccent, branding } = useBranding();
  return (
    <div className="card">
      <div className="card-head"><h2>How TaskFlow looks for you</h2></div>
      <div className="card-pad stack">
        <fieldset className="look-group">
          <legend className="small">Light or dark</legend>
          <div className="row wrap" style={{ gap: 6 }}>
            {MODES.map(([k, label]) => (
              <label key={k} className={`kind-chip${mode === k ? ' is-active' : ''}`}>
                <input type="radio" name="look-mode" value={k} checked={mode === k} onChange={() => setMode(k)} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="look-group">
          <legend className="small">Accent colour</legend>
          <div className="row wrap" style={{ gap: 8 }}>
            <label className={`look-swatch${!accent ? ' is-active' : ''}`}>
              <input type="radio" name="look-accent" checked={!accent} onChange={() => setAccent(null)} className="sr-only" />
              <span className="brand-swatch is-large" style={{ background: branding.primary }} />Organisation
            </label>
            {ACCENT_PRESETS.map((p) => (
              <label key={p.key} className={`look-swatch${accent === p.key ? ' is-active' : ''}`}>
                <input type="radio" name="look-accent" checked={accent === p.key} onChange={() => setAccent(p.key)} className="sr-only" />
                <span className="brand-swatch is-large" style={{ background: p.hex }} />{p.label}
              </label>
            ))}
          </div>
          <span className="small muted">Each of these has been checked to stay readable in light and dark mode. Only you see your choice.</span>
        </fieldset>
      </div>
    </div>
  );
}
