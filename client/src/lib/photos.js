/**
 * Profile photos in the app.
 *
 *   - **Who has one:** a small list of person → version, fetched once after
 *     sign-in and refreshed when the app comes back into view (at most every
 *     few minutes). Screens pass a person's id to Avatar; nothing else changes.
 *   - **Fetching:** pictures are served only to signed-in people, so they are
 *     fetched with the person's token and shown from memory. Each address
 *     includes the version, so the browser keeps it, and a new photo is a new
 *     address.
 *   - **Never broken:** if a picture cannot be fetched, Avatar shows initials.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api/client.js';

export const PHOTO_SIZES = [64, 128, 256, 512];
const REFRESH_MS = 5 * 60_000;

const state = { versions: new Map(), loadedAt: 0, loading: null };
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
let snapshot = 0;
const bump = () => { snapshot += 1; emit(); };

export async function loadPhotoVersions({ force = false } = {}) {
  if (!api.token.get()) return;
  if (!force && Date.now() - state.loadedAt < REFRESH_MS) return;
  if (state.loading) return state.loading;
  state.loading = api.get('/photos/versions')
    .then((r) => {
      state.versions = new Map((r.versions || []).map((x) => [x.id, x.v]));
      state.loadedAt = Date.now();
      bump();
    })
    .catch(() => {})
    .finally(() => { state.loading = null; });
  return state.loading;
}

/** After a person changes their own photo: shown at once, everywhere. */
export function setPhotoVersion(userId, version) {
  if (version) state.versions.set(userId, version); else state.versions.delete(userId);
  bump();
}

export function clearPhotoVersions() {
  state.versions = new Map();
  state.loadedAt = 0;
  bump();
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export function usePhotoVersion(userId) {
  useSyncExternalStore(subscribe, () => snapshot);
  return userId ? state.versions.get(Number(userId)) || null : null;
}

/** The smallest stored size that stays sharp at this display size. */
export function photoSizeFor(displayPx, dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1) {
  const need = displayPx * Math.min(dpr, 3);
  return PHOTO_SIZES.find((s) => s >= need) || PHOTO_SIZES[PHOTO_SIZES.length - 1];
}

const blobs = new Map(); // `${id}:${v}:${size}` → Promise<objectURL|null>
export function photoObjectUrl(userId, version, size) {
  const key = `${userId}:${version}:${size}`;
  if (!blobs.has(key)) {
    const token = api.token.get();
    blobs.set(key, fetch(api.url(`/photos/${userId}/${size}`, { v: version }), { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => null));
  }
  return blobs.get(key);
}

/** The picture to show for a person at a display size, or null (initials). */
export function usePhotoUrl(userId, displayPx) {
  const version = usePhotoVersion(userId);
  const size = photoSizeFor(displayPx);
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let gone = false;
    if (!userId || !version) { setUrl(null); return undefined; }
    photoObjectUrl(userId, version, size).then((u) => { if (!gone) setUrl(u); });
    return () => { gone = true; };
  }, [userId, version, size]);
  return url;
}

// keep the list fresh when the app comes back into view
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadPhotoVersions(); });
}
