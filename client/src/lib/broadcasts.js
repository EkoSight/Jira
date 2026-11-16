/**
 * WhatsApp broadcasts and opt-ins: words and small helpers shared by the
 * Broadcasts tab, the lead list and the lead page (docs/WHATSAPP_BROADCASTS.md).
 */

export const BROADCAST_STATUS = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  IN_REVIEW: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved, not sent', tone: 'good' },
  SCHEDULED: { label: 'Scheduled', tone: 'brand' },
  SENDING: { label: 'Sending', tone: 'brand' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  SENT: { label: 'Sent', tone: 'good' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

/** The lead list's views a broadcast can start from (not the routing queues or archived leads). */
export const BROADCAST_VIEWS = ['open', 'mine', 'unassigned', 'new', 'stale', 'nurture', 'won', 'converted', 'disqualified', 'all'];
export const BROADCAST_VIEW_LABEL = {
  open: 'Open leads', mine: 'My open leads', unassigned: 'Unassigned leads', new: 'New leads', stale: 'Stale leads', nurture: 'Nurture',
  won: 'Won', converted: 'Converted', disqualified: 'Lost', all: 'All leads (not archived)',
};

export const OPTIN_HOW = {
  ON_CALL: 'Agreed on a call', IN_PERSON: 'Agreed in person', FORM: 'Ticked the box on an enquiry form', IMPORT: 'Marked as agreed in an import', OTHER: 'Agreed',
};

/** The lead list's filters a broadcast keeps (the same keys the server keeps). */
const FILTER_KEYS = ['q', 'category', 'status', 'priority', 'owner_id', 'department_id', 'source_id', 'campaign_id', 'state', 'tag', 'from', 'to',
  'min_score', 'entry_channel', 'call_status_id', 'rating', 'city', 'district', 'block', 'pincode', 'wa_optin'];
export function broadcastFilters(view, filters = {}) {
  const out = { view: BROADCAST_VIEWS.includes(view) ? view : 'open' };
  for (const [k, v] of Object.entries(filters || {})) {
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (FILTER_KEYS.includes(k) || /^cf_[a-z][a-z0-9_]{1,40}$/.test(k)) out[k] = String(v).trim();
  }
  return out;
}

/** "Open leads · Retailer · District Sample District": the list in words. */
export function filterWords(filters = {}, { categories = {}, users = [], sources = [], statuses = [] } = {}) {
  const parts = [BROADCAST_VIEW_LABEL[filters.view] || BROADCAST_VIEW_LABEL.open];
  const label = {
    q: (v) => `Matching "${v}"`,
    category: (v) => categories[v]?.label || v,
    owner_id: (v) => (v === 'none' ? 'No owner' : `Owner ${users.find((u) => String(u.id) === String(v))?.full_name || v}`),
    source_id: (v) => `Source ${sources.find((s) => String(s.id) === String(v))?.name || v}`,
    call_status_id: (v) => (v === 'none' ? 'No calling status yet' : `Calling status ${statuses.find((s) => String(s.id) === String(v))?.label || v}`),
    state: (v) => (v === 'none' ? 'No state' : `State ${v}`),
    district: (v) => (v === 'none' ? 'No district' : `District ${v}`),
    city: (v) => `Place ${v}`, block: (v) => `Block ${v}`, pincode: (v) => `PIN starts ${v}`, tag: (v) => `Tag ${v}`,
    status: (v) => `Status ${String(v).toLowerCase()}`, priority: (v) => `Priority ${String(v).toLowerCase()}`,
    from: (v) => `From ${v}`, to: (v) => `To ${v}`, min_score: (v) => `Score ${v}+`, rating: (v) => `Rating ${v}+`,
    entry_channel: (v) => `Came in by ${String(v).toLowerCase().replace('_', ' ')}`,
    wa_optin: (v) => (v === 'yes' ? 'Agreed to WhatsApp' : 'Not agreed to WhatsApp'),
  };
  for (const [k, v] of Object.entries(filters)) {
    if (k === 'view') continue;
    if (label[k]) parts.push(label[k](v));
    else if (k.startsWith('cf_')) parts.push(`${k.slice(3).replace(/_/g, ' ')}: ${v}`);
  }
  return parts;
}

/** The template's text with the blanks filled (a missing one stays as {{n}}). */
export function fillBlanks(text, values = []) {
  return String(text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => (values[Number(n) - 1] ? String(values[Number(n) - 1]) : m));
}

/** What fills each blank, ready to save: one entry per blank, nothing extra. */
export function variablesFor(count, current = []) {
  return Array.from({ length: count }, (_, i) => ({ source: current[i]?.source || '', text: current[i]?.text || '', fallback: current[i]?.fallback || '' }));
}

/** Where a number stands for WhatsApp, in a sentence. */
export function standingWords(w) {
  if (!w || !w.phone) return 'No phone number, so no WhatsApp messages.';
  if (w.opted_out) return `Opted out of WhatsApp${w.opted_out.reason ? ` (${w.opted_out.reason})` : ''}. Broadcasts never go to this number.`;
  if (w.optin) return `${OPTIN_HOW[w.optin.how] || 'Agreed'} to WhatsApp messages${w.optin.recorded_by_name ? `, recorded by ${w.optin.recorded_by_name}` : ''}.`;
  if (w.wrote_first_at) return 'Wrote to us on WhatsApp first, which counts as agreeing to messages.';
  return 'No WhatsApp opt-in recorded. Broadcasts skip this number until one is.';
}

/** "12 of 250 sent in the last 24 hours · sending hours 09:00–20:00". */
export function roomWords(room) {
  if (!room) return '';
  const limit = room.dailyLimit ?? (room.sent_last_24h + room.left_today);
  return `${room.sent_last_24h} of ${limit} broadcast messages sent in the last 24 hours${room.sendFrom ? ` · sending hours ${room.sendFrom}–${room.sendUntil}` : ''}`;
}
