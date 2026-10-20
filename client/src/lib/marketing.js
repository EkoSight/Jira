/**
 * Email marketing's shared vocabulary and the pure parts of its editors: the
 * email builder's blocks, the automation path, segment rules and the words
 * every screen uses for statuses and events.
 */

export const CAMPAIGN_STATUS = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  IN_REVIEW: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'brand' },
  SCHEDULED: { label: 'Scheduled', tone: 'brand' },
  SENDING: { label: 'Sending', tone: 'brand' },
  TESTING: { label: 'A/B testing', tone: 'brand' },
  SENT: { label: 'Sent', tone: 'good' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const WORKFLOW_STATUS = {
  DRAFT: { label: 'Off', tone: 'neutral' },
  ACTIVE: { label: 'Running', tone: 'good' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
};

export const MEMBERSHIP_STATUS = {
  SUBSCRIBED: { label: 'Subscribed', tone: 'good' },
  PENDING: { label: 'Waiting to confirm', tone: 'warning' },
  UNSUBSCRIBED: { label: 'Unsubscribed', tone: 'neutral' },
  CLEANED: { label: 'Bounced', tone: 'critical' },
  ARCHIVED: { label: 'Removed', tone: 'neutral' },
};

export const ADDRESS_STATUS = {
  ACTIVE: { label: 'Can be emailed', tone: 'good' },
  BOUNCED: { label: 'Bounced', tone: 'critical' },
  COMPLAINED: { label: 'Marked as spam', tone: 'critical' },
  UNSUBSCRIBED: { label: 'Unsubscribed from all', tone: 'neutral' },
  INVALID: { label: 'Not a working address', tone: 'critical' },
};

export const MESSAGE_STATUS = {
  HELD: 'Waiting for the A/B winner', QUEUED: 'Queued', SENDING: 'Sending', SENT: 'Sent', DELIVERED: 'Delivered',
  BOUNCED: 'Bounced', COMPLAINED: 'Marked as spam', FAILED: 'Failed', SKIPPED: 'Not sent', CANCELLED: 'Cancelled',
};

export const EVENT_WORDS = {
  SENT: 'Sent', DELIVERED: 'Delivered', DEFERRED: 'Delayed by the receiving server', BOUNCE_HARD: 'Bounced (permanent)',
  BOUNCE_SOFT: 'Bounced (temporary)', COMPLAINT: 'Marked as spam', REJECTED: 'Refused by the provider', FAILED: 'Failed',
  OPEN: 'Opened', CLICK: 'Clicked', UNSUBSCRIBE: 'Unsubscribed', REPLY: 'Replied', CONVERSION: 'Converted',
};

export const SOURCE_WORDS = {
  MANUAL: 'Added by hand', IMPORT: 'Import', FORM: 'Signup form', CRM_SYNC: 'From the pipeline', API: 'API',
  DOUBLE_OPT_IN: 'Confirmed by email', AUTOMATION: 'Automation', STAFF: 'By a colleague', PREFERENCES: 'Preference page',
  ONE_CLICK: 'One-click unsubscribe', REPLY: 'By reply', TRACKING: 'TaskFlow tracking', MAILBOX: 'Reply mailbox',
  INBOUND: 'Inbound mail', CRM: 'Pipeline', PROVIDER_COMPLAINT: 'Spam complaint',
};
export const sourceWords = (source) => {
  if (!source) return '';
  if (source.startsWith('PROVIDER:')) return `Reported by ${source.slice(9) === 'log' ? 'the outbox' : source.slice(9).toUpperCase()}`;
  return SOURCE_WORDS[source] || source.toLowerCase().replace(/_/g, ' ');
};

const SKIP = {
  CONTACT_REMOVED: 'The contact was removed',
  CONTACT_ARCHIVED: 'The contact is archived',
  UNSUBSCRIBED_ALL: 'Unsubscribed from all emails',
  NOT_SUBSCRIBED: 'No longer subscribed to the audience',
  TOPIC_OPTED_OUT: 'Opted out of this topic',
  FREQUENCY_LIMIT: 'Already emailed as often as the limit allows',
};
const SUPPRESSION = {
  HARD_BOUNCE: 'the address bounced', SOFT_BOUNCES: 'repeated temporary bounces', COMPLAINT: 'they marked an email as spam',
  UNSUBSCRIBED_ALL: 'they unsubscribed from everything', MANUAL: 'a colleague blocked the address', INVALID: 'the address does not work',
};
export const SUPPRESSION_WORDS = SUPPRESSION;

/** Why a message was not sent, in words. */
export function skipWords(reason) {
  if (!reason) return '';
  if (SKIP[reason]) return SKIP[reason];
  if (reason.startsWith('SUPPRESSED_')) return `Blocked: ${SUPPRESSION[reason.slice(11)] || reason.slice(11).toLowerCase()}`;
  if (reason.startsWith('ADDRESS_')) return `Address ${ADDRESS_STATUS[reason.slice(8)]?.label.toLowerCase() || reason.slice(8).toLowerCase()}`;
  return reason.toLowerCase().replace(/_/g, ' ');
}

/** "12.5%" — or a dash when there is nothing to divide by. */
export const percent = (value) => (value === null || value === undefined ? '—' : `${Number(value).toFixed(Number(value) % 1 ? 1 : 0)}%`);
export const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

export const personName = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || '';

// ---------------------------------------------------------------- the email builder

export const BLOCKS = {
  heading: { label: 'Heading', icon: 'edit', hint: 'A title' },
  text: { label: 'Text', icon: 'list', hint: 'Paragraphs, bold, links, lists' },
  button: { label: 'Button', icon: 'zap', hint: 'One clear action' },
  image: { label: 'Image', icon: 'image', hint: 'A picture, with a link if you like' },
  columns: { label: 'Two columns', icon: 'board', hint: 'Side by side; stacked on phones' },
  divider: { label: 'Divider', icon: 'menu', hint: 'A thin line' },
  spacer: { label: 'Space', icon: 'grip', hint: 'Breathing room' },
  social: { label: 'Social links', icon: 'link', hint: 'Website, Facebook, YouTube…' },
  html: { label: 'Custom HTML', icon: 'note', hint: 'For experts; scripts are removed' },
};

export const SOCIAL_NETWORKS = [['website', 'Website'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube'], ['x', 'X'], ['whatsapp', 'WhatsApp']];

let uid = 0;
const blockId = () => `b${Date.now().toString(36)}${(uid += 1).toString(36)}`;

/** A new block of a type, with words in both languages ready to fill. */
export function newBlock(type) {
  const base = { id: blockId(), type };
  switch (type) {
    case 'heading': return { ...base, text: { en: 'A clear headline', hi: '' }, level: 1, align: 'left' };
    case 'text': return { ...base, text: { en: 'Hello {{first_name|there}},\n\nWrite your message here.', hi: '' }, align: 'left' };
    case 'button': return { ...base, text: { en: 'Find out more', hi: '' }, href: 'https://', align: 'left' };
    case 'image': return { ...base, src: '', alt: { en: '', hi: '' }, href: '', align: 'center' };
    case 'columns': return { ...base, columns: [{ title: { en: 'Left', hi: '' }, text: { en: 'A sentence or two.', hi: '' } }, { title: { en: 'Right', hi: '' }, text: { en: 'A sentence or two.', hi: '' } }] };
    case 'divider': return base;
    case 'spacer': return { ...base, height: 24 };
    case 'social': return { ...base, links: [{ network: 'website', url: 'https://soildoctor.in' }] };
    case 'html': return { ...base, html: { en: '<p>Your HTML</p>', hi: '' } };
    default: return base;
  }
}

/** Gives every block an id the editor can track (designs from templates have none). */
export const withIds = (design) => ({ ...design, blocks: (design?.blocks || []).map((b) => (b.id ? b : { ...b, id: blockId() })) });

export function moveItem(list, from, to) {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to > from ? to - 1 : to, next.length)), 0, item);
  return next;
}

export const insertAt = (list, index, item) => [...list.slice(0, index), item, ...list.slice(index)];

/** Words of a field in one language, from { en, hi } or a plain string. */
export const pick = (value, lang = 'en') => (value && typeof value === 'object' ? value[lang] || '' : lang === 'en' ? value || '' : '');
/** Sets one language of a field, turning a plain string into { en, hi }. */
export const setLang = (value, lang, text) => ({ ...(value && typeof value === 'object' ? value : { en: value || '', hi: '' }), [lang]: text });

export const designHasHindi = (design) => (design?.blocks || []).some(
  (b) => ['text', 'heading', 'button', 'html'].some((k) => b[k] && typeof b[k] === 'object' && String(b[k].hi || '').trim())
    || (b.columns || []).some((c) => String(c.text?.hi || c.title?.hi || '').trim()),
);

/** What a block shows in the builder's outline. */
export function blockSummary(block) {
  const text = pick(block.text) || pick(block.html) || pick(block.alt) || '';
  const plain = String(text).replace(/<[^>]+>/g, ' ').replace(/[*#[\]()]/g, '').replace(/\s+/g, ' ').trim();
  if (block.type === 'columns') return (block.columns || []).map((c) => pick(c.title)).filter(Boolean).join(' · ');
  if (block.type === 'spacer') return `${block.height || 24}px`;
  if (block.type === 'social') return (block.links || []).map((l) => l.network).join(', ');
  return plain.slice(0, 80);
}

export const CONDITION_KINDS = [
  ['', 'Everyone'],
  ['language', 'Readers of a language'],
  ['tag', 'People with a tag'],
  ['crm', 'By pipeline type'],
  ['audience', 'Members of an audience'],
  ['field', 'By a field'],
];

// ---------------------------------------------------------------- automations

export const TRIGGER_LABEL = {
  AUDIENCE_JOINED: 'Someone joins an audience',
  TAG_ADDED: 'A tag is added to someone',
  FORM_SUBMITTED: 'Someone submits a signup form',
  FESTIVAL: 'A festival or season is coming',
  DATE_FIELD: 'A date on the contact (birthday, renewal)',
  CAMPAIGN_ACTIVITY: 'Someone opens, clicks or ignores a campaign',
  INACTIVE: 'Someone goes quiet',
  TASKFLOW_EVENT: 'Something happens in TaskFlow',
  MANUAL: 'Only when people are added by hand',
};

export const TASKFLOW_EVENT_LABEL = {
  LEAD_CREATED: 'A new lead is added to the pipeline',
  BECAME_CUSTOMER: 'A lead becomes a customer',
  DEAL_STAGE: 'A deal moves to a stage',
  DEAL_WON: 'A deal is won',
  DEAL_LOST: 'A deal is lost',
  TASK_COMPLETED: 'A task on their organization is finished',
};

export const NODE_LABEL = { email: 'Send an email', delay: 'Wait', condition: 'If / else', action: 'Do something', exit: 'End' };

export const CONDITION_LABEL = {
  opened: 'Opened an email in this automation', clicked: 'Clicked an email in this automation', replied: 'Replied',
  converted: 'Converted since starting', tag: 'Has a tag', field: 'A field matches', audience: 'Is subscribed to an audience',
  engagement_at_least: 'Engagement score at least', crm_type: 'Organization’s pipeline type is', has_open_deal: 'Has an open deal',
};

export const ACTION_LABEL = {
  add_tag: 'Add a tag', remove_tag: 'Remove a tag', add_to_audience: 'Add to an audience', remove_from_audience: 'Remove from an audience',
  create_task: 'Create a follow-up task', notify_owner: 'Notify their owner', update_field: 'Set a field', set_language: 'Set their language',
};

export const UNIT_LABEL = { minutes: 'minutes', hours: 'hours', days: 'days', weeks: 'weeks' };

export function newNode(type) {
  switch (type) {
    case 'email': return { type, config: { subject: '', design: { blocks: [newBlock('text')] } }, next: null };
    case 'delay': return { type, config: { amount: 2, unit: 'days' }, next: null };
    case 'condition': return { type, config: { kind: 'opened' }, yes: null, no: null };
    case 'action': return { type, config: { kind: 'add_tag', value: '' }, next: null };
    default: return { type: 'exit' };
  }
}

const nextFree = (nodes) => {
  let i = Object.keys(nodes).length + 1;
  while (nodes[`s${i}`]) i += 1;
  return `s${i}`;
};

/**
 * Inserts a step. `at` says where: { parent: id, branch: 'next' | 'yes' | 'no' }
 * or { parent: null } for the very start. The new step takes over what
 * followed, so nothing is lost.
 */
export function insertNode(graph, at, type) {
  const nodes = { ...(graph.nodes || {}) };
  const id = nextFree(nodes);
  const node = newNode(type);
  const following = at.parent ? nodes[at.parent]?.[at.branch || 'next'] ?? null : graph.start ?? null;
  if (node.type === 'condition') node.yes = following;
  else if (node.type !== 'exit') node.next = following;
  nodes[id] = node;
  if (at.parent) nodes[at.parent] = { ...nodes[at.parent], [at.branch || 'next']: id };
  return { graph: { ...graph, start: at.parent ? graph.start : id, nodes }, id };
}

/** Steps reachable from the start; the rest are dropped. */
export function prune(graph) {
  const keep = new Set();
  const visit = (id) => {
    if (!id || keep.has(id) || !graph.nodes[id]) return;
    keep.add(id);
    const n = graph.nodes[id];
    if (n.type === 'condition') { visit(n.yes); visit(n.no); } else visit(n.next);
  };
  visit(graph.start);
  return { ...graph, nodes: Object.fromEntries(Object.entries(graph.nodes).filter(([id]) => keep.has(id))) };
}

/**
 * Removes a step and joins what came before to what came after. Removing an
 * if/else keeps its "yes" path and drops the "no" path.
 */
export function removeNode(graph, id) {
  const node = graph.nodes[id];
  if (!node) return graph;
  const after = node.type === 'condition' ? node.yes ?? null : node.next ?? null;
  const nodes = {};
  for (const [key, n] of Object.entries(graph.nodes)) {
    if (key === id) continue;
    const copy = { ...n };
    for (const branch of ['next', 'yes', 'no']) if (copy[branch] === id) copy[branch] = after;
    nodes[key] = copy;
  }
  return prune({ ...graph, start: graph.start === id ? after : graph.start, nodes });
}

/** The path as a tree for drawing: [{ id, node, yes: [...], no: [...] }]. */
export function pathTree(graph, start = graph?.start, seen = new Set()) {
  const out = [];
  let id = start;
  while (id && graph.nodes?.[id] && !seen.has(id)) {
    seen.add(id);
    const node = graph.nodes[id];
    if (node.type === 'condition') {
      out.push({ id, node, yes: pathTree(graph, node.yes, seen), no: pathTree(graph, node.no, seen) });
      break;
    }
    out.push({ id, node });
    id = node.next;
  }
  return out;
}

export function triggerSummary(trigger = {}, { audiences = [], forms = [], festivals = [] } = {}) {
  const name = (list, value) => list.find((x) => Number(x.id) === Number(value))?.name || 'one';
  switch (trigger.type) {
    case 'AUDIENCE_JOINED': return `Joins ${name(audiences, trigger.audience_id)}`;
    case 'TAG_ADDED': return `Tagged “${trigger.tag || '…'}”`;
    case 'FORM_SUBMITTED': return `Submits ${name(forms, trigger.form_id)}`;
    case 'FESTIVAL': {
      const which = (trigger.festival_ids || []).map((f) => name(festivals, f));
      return `${Number(trigger.days_before) ? `${trigger.days_before} day(s) before` : 'On'} ${which.length ? which.join(', ') : 'every confirmed festival'}`;
    }
    case 'DATE_FIELD': return `On their ${trigger.field || 'date'}${Number(trigger.days_before) ? `, ${trigger.days_before} day(s) early` : ''}`;
    case 'CAMPAIGN_ACTIVITY': return `${{ CLICKED: 'Clicks', OPENED: 'Opens', NOT_OPENED: 'Does not open' }[trigger.activity] || 'Acts on'} a campaign`;
    case 'INACTIVE': return `No opens or clicks for ${trigger.days || 90} days`;
    case 'TASKFLOW_EVENT': return TASKFLOW_EVENT_LABEL[trigger.event] || 'A TaskFlow event';
    default: return TRIGGER_LABEL.MANUAL;
  }
}

export function nodeSummary(node) {
  const c = node.config || {};
  switch (node.type) {
    case 'email': return c.subject || 'No subject yet';
    case 'delay': return `${c.amount || '?'} ${UNIT_LABEL[c.unit] || c.unit || ''}`;
    case 'condition': return `${CONDITION_LABEL[c.kind] || 'Choose a condition'}${c.value !== undefined && c.value !== '' && !['opened', 'clicked', 'replied', 'converted', 'has_open_deal'].includes(c.kind) ? `: ${c.value}` : ''}`;
    case 'action': return `${ACTION_LABEL[c.kind] || 'Choose an action'}${c.value ? `: ${c.value}` : c.title ? `: ${c.title}` : ''}`;
    default: return 'The end';
  }
}

// ---------------------------------------------------------------- segments

export const emptyRules = () => ({ match: 'all', conditions: [] });

/** A fresh condition for a field from the server's catalogue. */
export function newCondition(field, operators) {
  const ops = operators[field.type] || [];
  const value = field.type === 'number' ? 0 : field.type === 'date' ? 30 : field.type === 'select' ? field.options?.[0]?.[0] ?? '' : '';
  return { field: field.key, op: ops[0], value, ...(field.type === 'custom' ? { key: '' } : {}) };
}

export const OPERATOR_WORDS = {
  is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', ends_with: 'ends with',
  empty: 'is empty', not_empty: 'is not empty', eq: '=', gt: '>', gte: '≥', lt: '<', lte: '≤',
  within_days: 'in the last … days', not_within_days: 'not in the last … days', before: 'before', after: 'after', never: 'never', ever: 'at any time',
  has: 'has', not_has: 'does not have', subscribed: 'is subscribed to', not_subscribed: 'is not subscribed to', unsubscribed: 'unsubscribed from',
  pending: 'is waiting to confirm', opted_out: 'opted out of', not_opted_out: 'did not opt out of', received: 'received', opened: 'opened',
  not_opened: 'did not open', clicked: 'clicked', not_clicked: 'did not click', replied: 'replied to', converted: 'converted from', yes: 'yes', no: 'no',
};

/** Whether an operator needs a value typed after it. */
export const needsValue = (op) => !['empty', 'not_empty', 'never', 'ever', 'yes', 'no'].includes(op);

// ---------------------------------------------------------------- import

export const IMPORT_FIELDS = [
  ['', 'Skip this column'], ['email', 'Email address'], ['first_name', 'First name'], ['last_name', 'Last name'], ['full_name', 'Full name'],
  ['phone', 'Phone'], ['organization', 'Organization'], ['designation', 'Designation'], ['city', 'City or village'], ['state', 'State'],
  ['country', 'Country'], ['language', 'Language (English / Hindi)'], ['tags', 'Tags'],
];

/** The calendar's weeks for a month: Monday first, days outside the month included to fill the grid. */
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(1 - offset);
  const weeks = [];
  const cursor = new Date(start);
  do {
    const week = [];
    for (let i = 0; i < 7; i += 1) {
      week.push({ date: cursor.toISOString().slice(0, 10), inMonth: cursor.getUTCMonth() === month });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  } while (cursor.getUTCMonth() === month);
  return weeks;
}

/** A date or time as India sees it, for grouping by day. */
export const istDay = (value) => (value ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(value)) : null);
