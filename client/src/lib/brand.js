/**
 * The organisation's branding and each person's look, applied to the page.
 *
 *   - **Organisation:** name, colours and logos from /branding (public, so
 *     the sign-in page has them). Kept in this browser so the next visit
 *     opens in the right colours before the network answers. Checked again
 *     when the app comes back into view and every two minutes, so a change
 *     reaches everyone without a redeploy.
 *   - **Person:** light, dark or match the device; optionally an accent from
 *     the pre-checked list, which takes the place of the organisation's main
 *     colour for them only.
 *
 * Colours come from shared/brandTheme.js, the same rules the server checks
 * with. Status colours (overdue, warning, done) are never touched.
 */
import { BASE } from '../api/client.js';
import { DEFAULT_BRANDING, accentPreset, buildPalette, themeCss } from '../../../shared/brandTheme.js';

const CACHE = 'taskflow.branding';
const MODE_KEY = 'taskflow.theme';
const ACCENT_KEY = 'taskflow.accent';
export const REFRESH_MS = 2 * 60_000;

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

export const DEFAULT_PUBLIC = Object.freeze({
  version: 0,
  appName: DEFAULT_BRANDING.appName,
  byline: DEFAULT_BRANDING.byline,
  primary: DEFAULT_BRANDING.primary,
  accent: DEFAULT_BRANDING.accent,
  assets: { mark: `${BASE}/branding/assets/mark`, wordmark: `${BASE}/branding/assets/wordmark`, markDark: null, wordmarkDark: null },
  icons: {},
});

export const cachedBranding = () => safe(() => JSON.parse(localStorage.getItem(CACHE)), null) || DEFAULT_PUBLIC;

export async function fetchBranding() {
  const r = await fetch(`${BASE}/branding`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('branding unavailable');
  const b = await r.json();
  safe(() => localStorage.setItem(CACHE, JSON.stringify(b)));
  return b;
}

// ---------------------------------------------------------------- the person's mode and accent

/** "LIGHT", "DARK" or "SYSTEM"; older saves said "light" or "dark". */
export function storedMode() {
  const v = safe(() => localStorage.getItem(MODE_KEY), null);
  if (v === 'dark' || v === 'DARK') return 'DARK';
  if (v === 'system' || v === 'SYSTEM') return 'SYSTEM';
  return v ? 'LIGHT' : 'SYSTEM';
}
export const storedAccent = () => safe(() => localStorage.getItem(ACCENT_KEY), null) || null;
export function rememberLook({ mode, accent }) {
  safe(() => {
    if (mode) localStorage.setItem(MODE_KEY, mode);
    if (accent !== undefined) { if (accent) localStorage.setItem(ACCENT_KEY, accent); else localStorage.removeItem(ACCENT_KEY); }
  });
}

const systemDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
export const resolveMode = (mode) => (mode === 'DARK' || (mode === 'SYSTEM' && systemDark()) ? 'dark' : 'light');

// ---------------------------------------------------------------- applying

function setLink(rel, href, sizes) {
  if (!href) return;
  const selector = sizes ? `link[rel="${rel}"][sizes="${sizes}"]` : `link[rel="${rel}"]:not([sizes])`;
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement('link');
    el.rel = rel;
    if (sizes) el.sizes = sizes;
    document.head.appendChild(el);
  }
  el.href = href;
}

/** Puts the colours, the tab icon, the browser's theme colour and the title on the page. */
export function applyBranding(b, { mode = storedMode(), accent = storedAccent() } = {}) {
  if (typeof document === 'undefined') return;
  const resolved = resolveMode(mode);
  document.documentElement.dataset.theme = resolved;
  const main = accentPreset(accent)?.hex || b.primary || DEFAULT_BRANDING.primary;
  const palette = buildPalette(main, b.accent || DEFAULT_BRANDING.accent);
  let style = document.getElementById('brand-theme');
  if (!style) {
    style = document.createElement('style');
    style.id = 'brand-theme';
    document.head.appendChild(style);
  }
  style.textContent = themeCss(palette);
  const meta = document.head.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = palette[resolved]['--brand'];
  if (b.icons?.['favicon-48.png']) {
    setLink('icon', b.icons['favicon-48.png'], '48x48');
    setLink('icon', b.icons['icon-192.png'], '192x192');
    setLink('apple-touch-icon', b.icons['apple-touch-180.png']);
  }
  document.title = `${b.appName || DEFAULT_BRANDING.appName}${b.byline ? ` ${b.byline}` : ''}`;
  return palette;
}
