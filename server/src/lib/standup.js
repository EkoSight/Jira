/**
 * The daily standup's content rules, as pure functions: reading a standup
 * posted in Chat, checking a plan is specific enough to check at the end of
 * the day, and wording the feedback.
 *
 * The template:
 *
 *   Name | Date | Role
 *   1. <TaskFlow ID or link> | <action> | <measurable target or output> | <done by HH:MM>
 *   … three to five items …
 *   Blockers: <what help is needed> | Owner: <who> | By: <HH:MM>     (or "Blockers: none")
 *
 * Nothing here judges effort. A vague plan gets a specific, polite request to
 * sharpen it; numbers someone writes are their own plan, never a quota, and
 * feedback never suggests a number.
 */

export const TASK_REF = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/;
const TASK_LINK = /[?&]task=(\d+)\b|\/tasks?\/(\d+)\b/;

/** "11:00", "11", "3pm", "3:30 pm", "15.30" → seconds after midnight, or null. */
export function parseClock(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  const m = text.match(/^(?:by|before|till|until)?(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
  } else if (h > 23) return null;
  return h * 3600 + min * 60;
}

export const clockText = (seconds) => (seconds === null || seconds === undefined ? ''
  : `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`);

/** A task reference from text: { ref } or { taskId }, or null. */
export function taskReference(value) {
  const text = String(value ?? '');
  const link = text.match(TASK_LINK);
  if (link) return { taskId: Number(link[1] || link[2]), text: text.trim() };
  const ref = text.match(TASK_REF);
  if (ref) return { ref: ref[1], text: text.trim() };
  return null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** "12 Nov 2026", "12/11/2026", "2026-11-12", "today" → YYYY-MM-DD, or null. */
export function parseDate(value, today) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'today') return today;
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : today.slice(0, 4);
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const plain = text.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const build = (day, monthName, year) => {
    const month = MONTHS[monthName.slice(0, 3)];
    if (!month || Number(day) < 1 || Number(day) > 31) return null;
    return `${year || today.slice(0, 4)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  // "12 Nov 2026", "Thu 12 Nov"
  m = plain.match(/^(?:[a-z]+ )?(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/);
  if (m) return build(m[1], m[2], m[3]);
  // "Nov 12 2026", "Thu Nov 12"
  m = plain.match(/^(?:[a-z]{3,9} )?([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/);
  if (m) return build(m[2], m[1], m[3]);
  return null;
}

const cells = (line) => line.split('|').map((c) => c.trim());
const stripBullet = (line) => line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s*/, '');

/**
 * Reads a standup written in Chat. Tolerant of bullets, numbering, the
 * literal header row and "@TaskFlow standup" in front; strict about nothing
 * it would have to guess. What it cannot read is listed in `problems`.
 */
export function parseStandupText(raw, { today }) {
  const out = { name: null, date: null, role: null, items: [], blockers: [], no_blockers: false, problems: [] };
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*@\S+\s*/, '').replace(/^\s*\/?standup\b[:\s]*/i, '').trim())
    .filter(Boolean);
  for (const line of lines) {
    const bare = stripBullet(line);
    const blocker = bare.match(/^(?:blockers?|help(?:\s+needed)?|need(?:s|ed)?\s+help)\s*[:-]\s*(.*)$/i);
    if (blocker) {
      const rest = blocker[1].trim();
      if (/^(none|no|nil|na|n\/a|nothing|-)\.?$/i.test(rest)) { out.no_blockers = true; continue; }
      const parts = cells(rest);
      const entry = { text: parts[0] || '', owner: null, needed_by: null };
      for (const part of parts.slice(1)) {
        const owner = part.match(/^owner\s*[:-]\s*(.+)$/i);
        const by = part.match(/^(?:needed\s+)?by\s*[:-]\s*(.+)$/i);
        if (owner) entry.owner = owner[1].trim();
        else if (by) entry.needed_by = parseClock(by[1]);
      }
      out.blockers.push(entry);
      continue;
    }
    if (!line.includes('|')) continue;
    const parts = cells(bare);
    // the literal header row from the template
    if (/^name$/i.test(parts[0]) && /^date$/i.test(parts[1] || '')) continue;
    // Name | Date | Role
    if (!out.name && parts.length >= 2 && parseDate(parts[1], today)) {
      out.name = parts[0] || null;
      out.date = parseDate(parts[1], today);
      out.role = parts[2] || null;
      continue;
    }
    // an item: ref | action | target | time
    if (parts.length >= 3) {
      const [first, second, third, fourth] = parts;
      const ref = taskReference(first);
      const time = parseClock(fourth ?? '');
      out.items.push({
        task: ref ? first : (first || ''),
        action: second || '',
        target: third || '',
        done_by: time,
        done_by_text: fourth ?? '',
      });
      continue;
    }
    out.problems.push(`Could not read: “${line.slice(0, 80)}”`);
  }
  if (!out.name) out.problems.push('No “Name | Date | Role” line');
  return out;
}

/** True when it reads like a standup at all — a header line and at least one item. */
export const looksLikeStandup = (parsed) => Boolean(parsed.name && parsed.items.length);

// ---------------------------------------------------------------- quality

const VAGUE_ACTIONS = [
  'work on', 'working on', 'work', 'look into', 'looking into', 'check', 'checking', 'follow up', 'follow-up', 'followup',
  'coordinate', 'coordination', 'misc', 'miscellaneous', 'various', 'general', 'stuff', 'things', 'continue', 'continuing',
  'ongoing', 'same as yesterday', 'tbd', 'na', 'n/a', 'routine', 'regular work', 'pending work', 'support', 'help',
];
const VAGUE_TARGETS = [
  'done', 'complete', 'completed', 'finish', 'finished', 'progress', 'some progress', 'as much as possible', 'best effort',
  'maximum', 'max', 'update', 'updates', 'ok', 'good', 'better', 'proper', 'properly', 'work', 'tbd', 'na', 'n/a', '-',
];
// words that name something you can point to at the end of the day
const OUTPUTS = /\b(sent|send|submitted|submit|shared|share|published|uploaded|approved|signed|merged|deployed|released|filed|logged|recorded|booked|scheduled|delivered|closed|resolved|fixed|report|draft|document|doc|sheet|list|deck|slides?|quote|quotation|invoice|po|order|minutes|mom|pr|release|design|file|entries|records?|visits?|meetings?|calls?|leads?|samples?|photos?|summary|plan|proposal|agreement|contract|email|mail|message|ticket|post|video|catalogue|catalog|test|tests|checklist|spreadsheet|dashboard|page)\b/i;

const words = (s) => String(s || '').trim().toLowerCase().replace(/[.!]+$/, '');

export function isVagueAction(action) {
  const a = words(action);
  if (!a) return true;
  if (VAGUE_ACTIONS.includes(a)) return true;
  // a vague verb with almost nothing after it ("work on task", "check things")
  const n = a.split(/\s+/).length;
  return n <= 3 && VAGUE_ACTIONS.some((v) => a.startsWith(`${v} `)) && !OUTPUTS.test(a);
}

export function isMeasurable(target) {
  const t = words(target);
  if (!t || VAGUE_TARGETS.includes(t)) return false;
  return /\d/.test(t) || OUTPUTS.test(t);
}

/**
 * The checks on one version of a standup. `tasks` maps each reference text to
 * what TaskFlow knows: { exists, id, ref, title, stage, archived }.
 * Returns findings, each { code, item, message } — empty when the plan is fine.
 */
export function reviewContent(content, { minItems = 3, maxItems = 5, submittedAtSeconds = null, tasks = new Map() } = {}) {
  const findings = [];
  const add = (code, item, message) => findings.push({ code, item, message });
  const items = content.items || [];
  if (items.length < minItems) add('TOO_FEW_ITEMS', null, `There ${items.length === 1 ? 'is 1 item' : `are ${items.length} items`}; the standup asks for ${minItems} to ${maxItems}.`);
  if (items.length > maxItems) add('TOO_MANY_ITEMS', null, `There are ${items.length} items; the standup asks for ${minItems} to ${maxItems} — pick the ones that matter most today.`);

  items.forEach((item, i) => {
    const n = i + 1;
    const label = item.task ? `Item ${n} (${String(item.task).slice(0, 40)})` : `Item ${n}`;
    const ref = taskReference(item.task);
    if (!ref) {
      add('NO_TASK', n, `${label}: add its TaskFlow ID or link, so the plan connects to the work on the board (create the task first if there is none).`);
    } else {
      const known = tasks.get(item.task);
      if (known && !known.exists) add('TASK_NOT_FOUND', n, `${label}: TaskFlow has no task ${ref.ref || `#${ref.taskId}`} — check the ID.`);
      else if (known?.archived) add('TASK_ARCHIVED', n, `${label}: ${known.ref} is archived — is there a current task for this?`);
      else if (known && ['done', 'cancelled'].includes(known.stage)) add('TASK_CLOSED', n, `${label}: ${known.ref} is already ${known.stage === 'done' ? 'done' : 'cancelled'} — is there a follow-on task?`);
    }
    if (isVagueAction(item.action)) {
      add('VAGUE_ACTION', n, `${label}: “${String(item.action || '').slice(0, 60) || 'no action'}” doesn’t say what you will do — name the step itself.`);
    }
    if (!isMeasurable(item.target)) {
      add('NOT_MEASURABLE', n, `${label}: the target “${String(item.target || '').slice(0, 60) || 'none given'}” can’t be checked at the end of the day — say what will exist or be finished when it is done (a document, a reply, a count you set yourself).`);
    }
    if (item.done_by === null || item.done_by === undefined) {
      add('NO_TIME', n, `${label}: add a completion time, like 13:00.`);
    } else if (submittedAtSeconds !== null && item.done_by < submittedAtSeconds) {
      add('TIME_PASSED', n, `${label}: ${clockText(item.done_by)} is before this was posted — what time today will it be done?`);
    }
  });

  for (const [i, blocker] of (content.blockers || []).entries()) {
    const label = `Blocker${(content.blockers || []).length > 1 ? ` ${i + 1}` : ''}`;
    if (!String(blocker.text || '').trim()) add('BLOCKER_EMPTY', null, `${label}: say what help is needed.`);
    if (!String(blocker.owner || '').trim()) add('BLOCKER_NO_OWNER', null, `${label}: name who can help, so they can be asked.`);
    if (blocker.needed_by === null || blocker.needed_by === undefined) add('BLOCKER_NO_TIME', null, `${label}: say by when you need it.`);
  }
  return findings;
}

/**
 * The threaded reply asking for a correction. Specific, polite, and clear
 * that it is about the written plan only.
 */
export function feedbackText({ firstName, findings, link }) {
  const lines = [
    `Thanks${firstName ? `, ${firstName}` : ''}. A few changes would make today’s plan easy to check this evening:`,
    ...findings.slice(0, 8).map((f) => `• ${f.message}`),
  ];
  if (findings.length > 8) lines.push(`• …and ${findings.length - 8} more in TaskFlow.`);
  lines.push('', `Please correct it here in this thread or in TaskFlow: ${link}`);
  lines.push('_This looks only at how the plan is written — it says nothing about your effort._');
  return lines.join('\n');
}

export const correctedText = ({ firstName }) => `Thanks${firstName ? `, ${firstName}` : ''} — the corrected plan is clear. Nothing more needed.`;

/** The 09:30 reminder: the template, with neutral examples (no sales figures, no quotas). */
export function reminderText({ dateLabel, deadline, link, minItems = 3, maxItems = 5 }) {
  return [
    `*Daily standup — ${dateLabel}*`,
    `Please post yours by *${deadline}*: reply here mentioning @TaskFlow, message TaskFlow directly starting with “standup”, or use the form: ${link}`,
    '',
    '```',
    'Name | Date | Role',
    `1. <TaskFlow ID or link> | <what you will do> | <what will exist when done> | <done by HH:MM>`,
    `… ${minItems} to ${maxItems} items`,
    'Blockers: <help needed> | Owner: <who> | By: <HH:MM>     (or “Blockers: none”)',
    '```',
    'If you share a login, write your own name on the first line.',
    '_On leave or a holiday today? Nothing to do._',
  ].join('\n');
}

/** Normalises a form submission into the same shape the parser produces. */
export function normaliseForm(input, { today }) {
  const items = (input.items || []).map((item) => ({
    task: String(item.task ?? '').trim(),
    action: String(item.action ?? '').trim(),
    target: String(item.target ?? '').trim(),
    done_by: typeof item.done_by === 'number' ? item.done_by : parseClock(item.done_by),
    done_by_text: String(item.done_by ?? ''),
  }));
  const blockers = (input.blockers || [])
    .filter((b) => String(b.text ?? '').trim() || String(b.owner ?? '').trim())
    .map((b) => ({
      text: String(b.text ?? '').trim(),
      owner: String(b.owner ?? '').trim() || null,
      needed_by: typeof b.needed_by === 'number' ? b.needed_by : parseClock(b.needed_by),
    }));
  return {
    name: String(input.name ?? '').trim() || null,
    date: today,
    role: String(input.role ?? '').trim() || null,
    items,
    blockers,
    no_blockers: blockers.length === 0,
    problems: [],
  };
}

/** The standup as one Chat message, posted for someone who used the form. */
export function postText(content, { link }) {
  const lines = [`*${content.name || 'Standup'}* | ${content.date} | ${content.role || '—'}`];
  content.items.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.task || '—'} | ${item.action || '—'} | ${item.target || '—'} | ${clockText(item.done_by) || '—'}`);
  });
  if (content.blockers?.length) {
    for (const b of content.blockers) lines.push(`Blockers: ${b.text || '—'} | Owner: ${b.owner || '—'} | By: ${clockText(b.needed_by) || '—'}`);
  } else lines.push('Blockers: none');
  lines.push(`_Posted from TaskFlow — ${link}_`);
  return lines.join('\n');
}
