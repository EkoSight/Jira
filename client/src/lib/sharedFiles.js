/**
 * A recording shared to TaskFlow from the phone (the installed app is a
 * share target). The service worker keeps the file for a moment, under these
 * names, so the "Which call is this?" page can read it; public/sw.js uses the
 * same names (it cannot import this file).
 */
export const SHARE_CACHE = 'taskflow-shared-recordings';
export const sharedKey = (id) => `/__shared/recording/${encodeURIComponent(id)}`;

/** The shared file, or null when it is gone (already attached, or the phone cleared it). */
export async function readShared(id) {
  if (!id || typeof caches === 'undefined') return null;
  const cache = await caches.open(SHARE_CACHE);
  const res = await cache.match(sharedKey(id));
  if (!res) return null;
  const blob = await res.blob();
  const name = decodeURIComponent(res.headers.get('X-File-Name') || 'recording');
  const lastModified = Number(res.headers.get('X-Last-Modified')) || null;
  return { file: new File([blob], name, { type: blob.type, lastModified: lastModified || Date.now() }), lastModified };
}

/** Forgets the shared file: once attached, or when the person cancels. */
export async function dropShared(id) {
  if (!id || typeof caches === 'undefined') return;
  const cache = await caches.open(SHARE_CACHE);
  await cache.delete(sharedKey(id));
}
