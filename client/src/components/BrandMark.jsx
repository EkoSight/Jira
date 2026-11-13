import { useId } from 'react';
import { useBranding } from '../state/AppState.jsx';

/**
 * The organisation's mark. The bundled Soil Doctor mark is drawn here, from
 * the exact geometry and timings in docs/SOIL_DOCTOR_LOGO_ANIMATION.md:
 *
 *   intro  the strata slide in from alternating sides (0.9 s each, 0.11 s
 *          apart), then the pulse draws left to right (0.8 s, from 0.5 s)
 *   loop   the intro, then from 1.5 s a spark runs along the pulse and the
 *          mark beats once (at most 1.07×) every 3.4 s
 *   off    the still mark
 *
 * Always still when the device asks for reduced motion (CSS). A logo an
 * administrator uploaded is shown as it is, without animation.
 */
const PULSE = '-3,49.5 42.9,49.5 48.8,37 58.7,64.7 65.6,49.9 103,49.9';

export function BrandMark({ size = 28, mode = 'off', className = '', label }) {
  const { branding, resolved } = useBranding();
  const clip = useId().replace(/:/g, '');
  const name = label ?? branding.appName;
  const custom = branding.custom?.mark;
  if (custom) {
    const src = resolved === 'dark' && branding.assets.markDark ? branding.assets.markDark : branding.assets.mark;
    return <img src={src} width={size} height={size} alt={name || ''} className={`brand-logo ${className}`} style={{ width: size, height: size }} />;
  }
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={name || undefined} aria-hidden={name ? undefined : true}
      className={`sd-mark ${className}`} data-mode={mode}>
      <defs><clipPath id={clip}><circle cx="50" cy="50" r="50" /></clipPath></defs>
      <g clipPath={`url(#${clip})`}>
        <circle cx="50" cy="50" r="50" fill="#FFFFFF" />
        <rect className="sd-band sd-l" x="0" y="0" width="100" height="21.6" fill="#9DDCF8" />
        <rect className="sd-band sd-r" x="0" y="24.9" width="100" height="42" fill="#AED252" style={{ animationDelay: '.11s' }} />
        <path className="sd-band sd-l" d="M0 49.5 L42.9 49.5 L48.8 37 L58.7 64.7 L65.6 49.9 L100 49.9 L100 75 L0 75Z" fill="#8B5E3B" style={{ animationDelay: '.22s' }} />
        <rect className="sd-band sd-r" x="0" y="78.4" width="100" height="21.6" fill="#593C28" style={{ animationDelay: '.33s' }} />
        <polyline className="sd-pulse" points={PULSE} pathLength="100" fill="none" stroke="#FFFFFF" strokeWidth="3.3" strokeLinejoin="round" strokeLinecap="round" />
        {mode === 'loop' && <polyline className="sd-spark" points={PULSE} pathLength="100" fill="none" stroke="#FFFFFF" strokeWidth="6.5" strokeLinejoin="round" strokeLinecap="round" />}
      </g>
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
