import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loading data for whatever period is on screen, safely.
 *
 * Every request is numbered. Only the answer to the latest one is shown: a
 * slow October response arriving after November was chosen is dropped, not
 * painted over November. A failure is an error with a retry — never an empty
 * list or a zero. An answer for a different period than the one asked for is
 * treated as an error too. A copy served from the device while offline is
 * marked as such, so it is never mistaken for current figures.
 */

/** Pure: hands out tickets and says whether a ticket is still the latest. */
export function createSequencer() {
  let latest = 0;
  return {
    next() {
      latest += 1;
      const mine = latest;
      return () => mine === latest;
    },
    cancel() { latest += 1; },
  };
}

/**
 * Pure: the state after a response. `accept` checks the answer belongs to the
 * period asked for.
 */
export function settle({ isLatest, accept }, outcome) {
  if (!isLatest()) return null; // stale: leave the screen alone
  if (outcome.error) return { status: 'error', data: null, error: outcome.error, offline: false };
  if (accept && !accept(outcome.data)) {
    return { status: 'error', data: null, error: new Error('The answer was for a different period. Try again.'), offline: false };
  }
  return { status: 'ready', data: outcome.data, error: null, offline: Boolean(outcome.data?.__offline) };
}

export const LOADING = { status: 'loading', data: null, error: null, offline: false };

/**
 * `fetcher(signal)` returns a promise. `deps` identify the period/view; when
 * they change the old data is cleared at once. `reload()` refetches the same
 * period and keeps showing it meanwhile (marked as refreshing).
 */
export function useLoad(fetcher, deps, { accept, enabled = true } = {}) {
  const sequencer = useRef(createSequencer());
  const controller = useRef(null);
  const [state, setState] = useState(LOADING);
  const [refreshing, setRefreshing] = useState(false);

  const run = useCallback((keep) => {
    if (!enabled) return;
    controller.current?.abort();
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    controller.current = abort;
    const isLatest = sequencer.current.next();
    if (keep) setRefreshing(true);
    else setState(LOADING);
    Promise.resolve()
      .then(() => fetcher(abort?.signal))
      .then((data) => ({ data }), (error) => ({ error }))
      .then((outcome) => {
        // an aborted request is simply superseded
        if (outcome.error?.name === 'AbortError') return;
        const next = settle({ isLatest, accept }, outcome);
        if (!next) return;
        setRefreshing(false);
        setState(next);
      });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    run(false);
    return () => {
      sequencer.current.cancel();
      controller.current?.abort();
    };
  }, [run]);

  const reload = useCallback(() => run(true), [run]);
  const retry = useCallback(() => run(false), [run]);
  return { ...state, refreshing, reload, retry };
}
