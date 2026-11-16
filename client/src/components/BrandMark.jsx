import { useId } from 'react';
import { useBranding } from '../state/AppState.jsx';

/**
 * The organisation's mark. TaskFlow's own mark is drawn here (docs/TASKFLOW_MARK.md):
 * Soil Doctor's soil layers cut into a tick, on TaskFlow's deep green tile, so the
 * two apps are told apart at a glance while staying one family.
 *
 *   intro  the layers slide in from alternating sides (0.9 s each, 0.11 s apart,
 *          as in the Soil Doctor mark) while the tick draws itself on (0.9 s, from 0.15 s)
 *   loop   the intro, then from 1.5 s a glint runs along the tick and the mark
 *          beats once (at most 1.07x) every 3.4 s
 *   off    the still mark
 *
 * Always still when the device asks for reduced motion (CSS). A logo an
 * administrator uploaded is shown as it is, without animation.
 */
const TICK = '25,53 43,71 76,32';
const DEEP_GREEN = '#073F2A';

export function BrandMark({ size = 28, mode = 'off', className = '', label }) {
  const { branding, resolved } = useBranding();
  const mask = `tf-tick-${useId().replace(/:/g, '')}`;
  const name = label ?? branding.appName;
  const custom = branding.custom?.mark;
  if (custom) {
    const src = resolved === 'dark' && branding.assets.markDark ? branding.assets.markDark : branding.assets.mark;
    return <img src={src} width={size} height={size} alt={name || ''} className={`brand-logo ${className}`} style={{ width: size, height: size }} />;
  }
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={name || undefined} aria-hidden={name ? undefined : true}
      className={`sd-mark tf-mark ${className}`} data-mode={mode}>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <polyline className="tf-tick" points={TICK} pathLength="100" fill="none" stroke="#FFFFFF" strokeWidth="14.5" strokeLinejoin="round" strokeLinecap="round" />
        </mask>
      </defs>
      <rect width="100" height="100" rx="22" fill={DEEP_GREEN} />
      <g mask={`url(#${mask})`}>
        <rect className="sd-band sd-l" x="0" y="0" width="100" height="40" fill="#9DDCF8" />
        <rect className="sd-band sd-r" x="0" y="40" width="100" height="16" fill="#AED252" style={{ animationDelay: '.11s' }} />
        <rect className="sd-band sd-l" x="0" y="56" width="100" height="13" fill="#C08A5C" style={{ animationDelay: '.22s' }} />
        <rect className="sd-band sd-r" x="0" y="69" width="100" height="31" fill="#8B5E3B" style={{ animationDelay: '.33s' }} />
        <rect x="0" y="38.6" width="100" height="2.6" fill={DEEP_GREEN} />
        <rect x="0" y="54.6" width="100" height="2.6" fill={DEEP_GREEN} />
        <rect x="0" y="67.6" width="100" height="2.6" fill={DEEP_GREEN} />
      </g>
      {mode === 'loop' && <polyline className="sd-spark" points={TICK} pathLength="100" fill="none" stroke="#FFFFFF" strokeOpacity="0.9" strokeWidth="3.4" strokeLinejoin="round" strokeLinecap="round" />}
    </svg>
  );
}

/** The mark, the app's name and its byline, as in the sidebar. */
export function BrandLockup({ size = 28, mode = 'off' }) {
  const { branding } = useBranding();
  return (
    <span className="brand-lockup">
      <BrandMark size={size} mode={mode} label="" />
      <span className="brand-name">
        <span className="brand-app">{branding.appName}</span>
        {branding.byline && <span className="brand-byline">{branding.byline}</span>}
      </span>
    </span>
  );
}

/** The company's wordmark: the dark-mode version in dark mode, or the normal one on a light plate (never recoloured). */
export function Wordmark({ height = 40 }) {
  const { branding, resolved } = useBranding();
  if (!branding.assets?.wordmark) return null;
  const dark = resolved === 'dark';
  const src = dark && branding.assets.wordmarkDark ? branding.assets.wordmarkDark : branding.assets.wordmark;
  const plate = dark && !branding.assets.wordmarkDark;
  return (
    <span className={`brand-wordmark${plate ? ' on-plate' : ''}`}>
      <img src={src} alt="Soil Doctor by ekosight" style={{ height }} />
    </span>
  );
}

/** A full-page wait: the mark beating while something loads. */
export function BrandLoader({ label = 'Loading' }) {
  return (
    <div className="brand-loader" role="status" aria-live="polite">
      <BrandMark size={56} mode="loop" label="" />
      <span className="small muted">{label}…</span>
    </div>
  );
}

/** Whether the sidebar has already played its intro in this tab. */
export function introOnce(key = 'taskflow.introPlayed') {
  try {
    if (sessionStorage.getItem(key)) return 'off';
    sessionStorage.setItem(key, '1');
    return 'intro';
  } catch {
    return 'off';
  }
}
