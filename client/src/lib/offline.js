/**
 * Offline copies belong to one sign-in.
 *
 * The service worker keeps network-first copies of API reads so the board can
 * still show something when the phone drops off the network. Those copies are
 * kept per sign-in, and signing in or out deletes them all, so the next person
 * on the same browser is never shown the previous person's data.
 */
const DATA_CACHE = /-data(-|$)/;

/** Deletes every offline copy of API reads, and asks the worker to do the same. */
export async function clearOfflineCopies() {
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => DATA_CACHE.test(k)).map((k) => caches.delete(k)));
    }
  } catch { /* storage may be unavailable */ }
  try {
    navigator.serviceWorker?.controller?.postMessage('clear-data');
  } catch { /* no worker */ }
}
