/**
 * Small, pure helpers for to-dos and Today's plan. The server decides what is
 * in the plan and counts it; these only word and arrange what it sent.
 */
import { api } from '../api/client.js';

const DAY_MS = 86_400_000;

/** "Fri 13 Nov", with the year when it is not this year. */
export function dayLabel(date, today = null) {
  if (!date) return 'Anytime';
  const d = new Date(`${date}T00:00:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const sameYear = today ? today.slice(0, 4) === date.slice(0, 4) : true;
  return `${parts.weekday} ${parts.day} ${parts.month}${sameYear ? '' : ` ${parts.year}`}`;
}

/** "Today", "Tomorrow", "Yesterday", or the day itself. Always with the date for clarity. */
export function relativeDay(date, today) {
  if (!date) return 'Anytime';
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  const label = dayLabel(date, today);
  if (diff === 0) return `Today, ${label}`;
  if (diff === 1) return `Tomorrow, ${label}`;
  if (diff === -1) return `Yesterday, ${label}`;
  return label;
}

/** The label on a carried-over line: where it came from, never "overdue". */
export const fromLabel = (date, today) => `From ${dayLabel(date, today)}`;

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The lines of a paste, one to-do each: blank lines dropped, list bullets and
 * empty tick boxes taken off ("- ", "* ", "• ", "1. ", "[ ] ").
 */
export function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•▪◦]|\d+[.)]|\[\s?[xX ]?\])\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** A fresh key per add, so a double tap or a retry makes one to-do. */
export function newClientKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Move one key up or down in an order; unchanged at the ends. */
export function moveKey(keys, key, direction) {
  const i = keys.indexOf(key);
  const j = i + (direction === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= keys.length) return keys;
  const next = [...keys];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Items grouped by their (derived) project, "No project" last. */
export function groupByProject(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.project ? `p${item.project.id}` : 'none';
    if (!groups.has(key)) groups.set(key, { key, project: item.project || null, label: item.project?.name || 'No project', items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1) || a.label.localeCompare(b.label));
}

/** "3 left", "Nothing left", "1 left". */
export const leftWords = (n) => (n ? `${n} left` : 'Nothing left');

/** What a link reads as on a line: "Task WS-12 Send the annex". */
export function linkWords(link) {
  if (!link) return '';
  if (!link.visible) return 'Not available';
  return link.label;
}

/** The five headings of "What I did", in order, with their item lists. */
export const WHAT_I_DID = [
  ['project', 'Projects'],
  ['task', 'Tasks'],
  ['goal', 'Goals'],
  ['department', 'Departments'],
  ['record', 'Deals, applications and meetings'],
];

/** One-line wording for a step's done state: never an invented date. */
export function doneWords(item, today) {
  if (!item.done) return '';
  if (item.done_date_unknown) return 'done (date not recorded)';
  if (!item.done_at) return 'done';
  return `done ${dayLabel(new Date(item.done_at).toISOString().slice(0, 10), today)}`;
}

/** The to-do API, in one place. */
export const todoApi = {
  today: () => api.get('/todos/today'),
  count: () => api.get('/todos/count'),
  upcoming: () => api.get('/todos/upcoming'),
  anytime: () => api.get('/todos/anytime'),
  done: (params) => api.get('/todos/done', params),
  suggestions: () => api.get('/todos/plan-suggestions'),
  parse: (text) => api.get('/todos/parse', { text }),
  search: (q, type) => api.get('/todos/link-search', { q, ...(type ? { type } : {}) }),
  add: (body) => api.post('/todos', body),
  addMany: (body) => api.post('/todos/batch', body),
  change: (id, body) => api.patch(`/todos/${id}`, body),
  remove: (id) => api.del(`/todos/${id}`),
  becameTask: (id, taskId) => api.post(`/todos/${id}/became-task`, { task_id: taskId }),
  sharePreview: (id) => api.get(`/todos/${id}/share-preview`),
  share: (id) => api.post(`/todos/${id}/share`),
  unshare: (id) => api.post(`/todos/${id}/unshare`),
  step: (id, body) => api.patch(`/todos/steps/${id}`, body),
  unshareStep: (id) => api.post(`/todos/steps/${id}/unshare`),
  order: (keys) => api.post('/todos/order', { keys }),
  pin: (taskId) => api.post('/todos/pins', { task_id: taskId }),
  unpin: (id) => api.del(`/todos/pins/${id}`),
  lists: () => api.get('/todos/lists'),
  list: (id) => api.get(`/todos/lists/${id}`),
  addList: (body) => api.post('/todos/lists', body),
  changeList: (id, body) => api.patch(`/todos/lists/${id}`, body),
  useAgain: (id) => api.post(`/todos/lists/${id}/use-again`),
  removeList: (id) => api.del(`/todos/lists/${id}`),
  record: (type, id) => api.get(`/todos/record/${type}/${id}`),
  prefs: (body) => api.put('/todos/prefs', body),
};

/** Tell every open plan (header, card, widget, page) that something changed. */
export function announceTodosChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('taskflow:todos-changed'));
}
