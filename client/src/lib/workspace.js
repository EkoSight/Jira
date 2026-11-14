/**
 * My workspace: the pure parts of editing a layout and of writing dates, so
 * they are tested without a browser.
 */
import { WIDGET_TYPES, normaliseLayout } from '../../../shared/workspaceWidgets.js';

/** Moves the widget at `index` by `by` places (−1 up, +1 down); the list is unchanged at an edge. */
export function moveWidget(widgets, index, by) {
  const to = index + by;
  if (index < 0 || index >= widgets.length || to < 0 || to >= widgets.length) return widgets;
  const next = [...widgets];
  const [w] = next.splice(index, 1);
  next.splice(to, 0, w);
  return next;
}

/** Moves a widget to another place (drag and drop). */
export function placeWidget(widgets, fromId, toId) {
  const from = widgets.findIndex((w) => w.id === fromId);
  const to = widgets.findIndex((w) => w.id === toId);
  if (from < 0 || to < 0 || from === to) return widgets;
  const next = [...widgets];
  const [w] = next.splice(from, 1);
  next.splice(to, 0, w);
  return next;
}

/** A new copy of a widget type, with an id no other widget in the layout has. */
export function newWidget(type, widgets) {
  const w = WIDGET_TYPES[type];
  let n = widgets.length + 1;
  const ids = new Set(widgets.map((x) => x.id));
  while (ids.has(`w${n}`)) n += 1;
  return { id: `w${n}`, type, typeVersion: w?.version || 1, width: w?.widths?.includes('half') ? 'half' : 'full', config: {} };
}

/** Removes a widget from the layout (it hides it; it deletes nothing). */
export const removeWidget = (widgets, id) => widgets.filter((w) => w.id !== id);

export const updateWidget = (widgets, id, patch) => widgets.map((w) => (w.id === id ? { ...w, ...patch, config: { ...w.config, ...(patch.config || {}) } } : w));

/** Whether a draft differs from what was saved (ignoring what the server adds). */
export function layoutChanged(saved, draft) {
  const clean = (list) => JSON.stringify(normaliseLayout({ widgets: list }).widgets);
  return clean(saved) !== clean(draft);
}

/** What is sent to the server: only presentation. */
export const layoutBody = (widgets) => widgets.map(({ id, type, typeVersion, width, config }) => ({ id, type, typeVersion, width, config }));

const DAY = 86_400_000;

/** Calendar days from `today` to `date` (both YYYY-MM-DD). */
export function daysBetween(today, date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
}

export const localDay = (instant, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));

/** "in 3 days", "today", "tomorrow", "yesterday", "5 days ago". */
export function relativeDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/**
 * An absolute date with a relative label: "Tue 17 Nov, in 3 days". A date
 * with no time stays a date (never given a made-up time); an instant is shown
 * in the person's timezone, with its time.
 */
export function whenWords({ date = null, at = null }, { timeZone = 'Asia/Kolkata', now = new Date() } = {}) {
  const today = localDay(now, timeZone);
  if (date) {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T00:00:00Z`));
    return `${day}, ${relativeDays(daysBetween(today, date))}`;
  }
  if (!at) return 'No date';
  const d = new Date(at);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${day} ${time}, ${relativeDays(daysBetween(today, localDay(d, timeZone)))}`;
}

/** Today's date in words for the header: "Saturday 14 November 2026". */
export const longDate = (now = new Date(), timeZone = 'Asia/Kolkata') => new Intl.DateTimeFormat('en-GB', {
  timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
}).format(now);

/** The cached copy of a layout: a convenience only, never what decides it. */
const CACHE = 'taskflow.workspace';
export const workspaceCache = {
  read(userId) {
    try { const v = JSON.parse(sessionStorage.getItem(CACHE) || 'null'); return v && v.userId === userId ? v.data : null; } catch { return null; }
  },
  write(userId, data) {
    try { sessionStorage.setItem(CACHE, JSON.stringify({ userId, data })); } catch { /* storage may be unavailable */ }
  },
  clear() {
    try { sessionStorage.removeItem(CACHE); } catch { /* storage may be unavailable */ }
  },
};
