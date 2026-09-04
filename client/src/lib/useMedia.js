import { useEffect, useState } from 'react';

/**
 * Tracks a media query in JS.
 *
 * Layout stays in CSS wherever it can. This is for the cases where the two
 * screens are genuinely different products rather than the same one reflowed —
 * a tabbed mobile page cannot be a desktop page with `display: none` on the
 * parts it hides, because the hidden parts still mount, still fetch, and still
 * end up in the tab order.
 */
export function useMediaQuery(queryString) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(queryString).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(queryString);
    const onChange = (event) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [queryString]);

  return matches;
}

/** The app's one breakpoint: below it the sidebar becomes the bottom nav. */
export const useIsNarrow = () => useMediaQuery('(max-width: 900px)');
