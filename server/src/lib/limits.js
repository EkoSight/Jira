/**
 * Simple sliding-window limits, kept in this server process's memory.
 *
 * Enough for one TaskFlow server: a restart clears them, and two servers
 * behind a load balancer would each count on their own (docs/ACCOUNT_EMAILS.md).
 */
const all = new Set();

export function makeLimiter({ max, windowMs }) {
  const hits = new Map(); // key → timestamps (ms), oldest first
  const fresh = (key, now) => {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  const limiter = {
    /** Whether this key has used up its allowance. */
    blocked(key, now = Date.now()) { return fresh(key, now).length >= max; },
    /** Counts one more for this key; returns whether it was still within the allowance. */
    hit(key, now = Date.now()) {
      const list = fresh(key, now);
      if (list.length >= max) return false;
      list.push(now);
      hits.set(key, list);
      return true;
    },
    /** Minutes until the key may try again (at least 1 when blocked). */
    waitMinutes(key, now = Date.now()) {
      const list = fresh(key, now);
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((windowMs - (now - list[0])) / 60000));
    },
    clear(key) { hits.delete(key); },
    reset() { hits.clear(); },
  };
  all.add(limiter);
  return limiter;
}

/** Tests start each case from a clean slate. */
export function resetLimits() {
  for (const limiter of all) limiter.reset();
}
