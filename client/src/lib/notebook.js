/**
 * The notebook's pure logic (Part N): dates and weeks, the month grid, when a
 * swipe turns a page, the order an offline queue is sent in, and the undo
 * stack. No React and no browser APIs here, so it is tested on its own.
 */

const DAY_MS = 86_400_000;

export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** ISO week number (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - jan4) / DAY_MS - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

export const mondayOf = (date) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/** "Monday 16 November", written large on the page. */
export function longDay(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .formatToParts(new Date(`${date}T00:00:00Z`)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "Mon 16 Nov". */
export function shortDay(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .formatToParts(new Date(`${date}T00:00:00Z`)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** The month index: weeks of seven cells, Monday first; cells outside the month are null. */
export function monthGrid(month) {
  const first = `${month}-01`;
  const daysIn = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => addDays(first, i))];
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export const monthOf = (date) => date.slice(0, 7);
export function addMonths(month, n) {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export function monthLabel(month) {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
}

/**
 * Whether a finished touch gesture turns the page, and which way. Swipes that
 * start within 24 px of the screen edge belong to the phone (its own back
 * gesture), swipes while text is selected are reading, and a mostly vertical
 * move is scrolling.
 */
export function swipeDirection({ startX, startY, endX, endY, screenWidth, selecting = false, edge = 24, min = 60 }) {
  if (selecting) return null;
  if (startX < edge || startX > screenWidth - edge) return null;
  const dx = endX - startX;
  const dy = endY - startY;
  if (Math.abs(dx) < min || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 'next' : 'previous';
}

/** The page-turn keys, never while typing: Alt+, for the previous day, Alt+. for the next. */
export function pageTurnKey(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.code === 'Comma') return 'previous';
  if (e.code === 'Period') return 'next';
  return null;
}

/** Undo: Ctrl+Z or Cmd+Z, not with Shift (that is redo). */
export const isUndoKey = (e) => Boolean((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z'));

// ---------------------------------------------------------------- the offline queue

/**
 * Changes made while offline are kept in order and sent in that order when
 * the connection is back. Each carries a client key (an add) or the id of the
 * line it changes, and when it was made. A line added offline is known by its
 * temporary key until the server gives it an id; later changes to it wait
 * for that id.
 */
export function queueAdd(queue, op) {
  return [...queue, { ...op, seq: (queue.at(-1)?.seq || 0) + 1 }];
}

/** Replace a temporary key by the server's id in every waiting change. */
export function resolveTemp(queue, tempKey, id) {
  return queue.map((op) => (op.target === tempKey ? { ...op, target: `TODO:${id}` } : op));
}

/** The next change that can be sent now: the first in order (order is never skipped). */
export const nextToSend = (queue) => queue[0] || null;

/** Apply waiting changes over a page loaded from the device, so it shows what the person did. */
export function applyQueue(page, queue) {
  if (!page) return page;
  const lists = ['carried', 'items'];
  const out = { ...page, carried: [...(page.carried || [])], items: [...(page.items || [])] };
  const find = (target) => {
    for (const l of lists) { const i = out[l].findIndex((x) => x.key === target); if (i >= 0) return [l, i]; }
    return null;
  };
  for (const op of queue) {
    if (op.kind === 'add') {
      if (!find(op.target)) out.items.push({ source: 'TODO', key: op.target, id: null, title: op.body.title, done: false, planned_on: page.day, planned_time: null, position: 1e9, starred: false, sync: 'local', created_at: op.at });
      continue;
    }
    const at = find(op.target);
    if (!at) continue;
    const [l, i] = at;
    const item = { ...out[l][i], sync: 'local' };
    if (op.kind === 'tick') item.done = Boolean(op.body.done);
    if (op.kind === 'edit') item.title = op.body.title;
    if (op.kind === 'star') item.starred = Boolean(op.body.starred);
    out[l][i] = item;
  }
  if (queue.some((op) => op.kind === 'note')) out.note = { ...(out.note || {}), body: queue.filter((op) => op.kind === 'note').at(-1).body.body, sync: 'local' };
  out.left = [...out.carried, ...out.items].filter((x) => !x.done).length;
  return out;
}

// ---------------------------------------------------------------- undo

export const UNDO_LIMIT = 20;

/** The last 20 changes of this session, newest last. */
export function pushUndo(stack, entry) {
  const next = [...stack, entry];
  return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
}
