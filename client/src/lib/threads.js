/**
 * How a conversation reads.
 *
 * Two families, kept apart on purpose:
 *
 *   ASKING — somebody is waiting on somebody else. These show as a flag on the
 *   thing being discussed until they are answered, so a blocked person does not
 *   have to chase anyone to be noticed.
 *
 *   TELLING — how the work is going. These are the record of what happened while
 *   it happened, and they gate nothing.
 */

export const THREAD_KINDS = [
  {
    value: 'review',
    label: 'Needs improvement',
    verb: 'Ask for changes',
    hint: 'This is too vague, too big, or not measurable as written',
    asking: true,
    severity: 'warning',
    managerOnly: true,
    placeholder: 'Say what is unclear and what would make it good enough.',
  },
  {
    value: 'help_needed',
    label: 'Help needed',
    verb: 'Ask for help',
    hint: 'Something is in the way and you cannot clear it alone',
    asking: true,
    severity: 'warning',
    placeholder: 'What is blocking you, and what would unblock it?',
  },
  {
    value: 'question',
    label: 'Question',
    verb: 'Ask a question',
    hint: 'Something needs deciding or clarifying before this moves',
    asking: true,
    severity: 'info',
    placeholder: 'What do you need to know, and from whom?',
  },
  {
    value: 'feedback',
    label: 'Feedback asked',
    verb: 'Ask for feedback',
    hint: 'You want a second opinion before going further',
    asking: true,
    severity: 'info',
    placeholder: 'What would you like looked at?',
  },
  {
    value: 'progress',
    label: 'Progress',
    verb: 'Post an update',
    hint: 'Where this got to, so nobody has to ask',
    asking: false,
    severity: 'info',
    placeholder: 'What moved since last time?',
  },
  {
    value: 'challenge',
    label: 'Challenge',
    verb: 'Flag a challenge',
    hint: 'Something is harder than expected, but you are handling it',
    asking: false,
    severity: 'warning',
    placeholder: 'What is proving difficult, and how are you approaching it?',
  },
  {
    value: 'blocker',
    label: 'Blocker',
    verb: 'Raise the blocker',
    hint: 'Something is stopping this lead converting, and you want help deciding what to do',
    asking: true,
    severity: 'warning',
    // raised on a lead or a deal, from its own screen — never on a task
    crmOnly: true,
    placeholder: 'What is stopping them saying yes, and what have you tried?',
  },
  {
    value: 'discussion',
    label: 'Discussion',
    verb: 'Start a discussion',
    hint: 'Anything else worth saying in the open',
    asking: false,
    severity: 'info',
    placeholder: 'What is on your mind about this?',
  },
];

export const KIND_META = Object.fromEntries(THREAD_KINDS.map((k) => [k.value, k]));

export const threadKind = (value) => KIND_META[value] || KIND_META.discussion;

/** The kinds this person is allowed to open. */
export const kindsFor = (canRaiseReview) =>
  THREAD_KINDS.filter((kind) => (!kind.managerOnly || canRaiseReview) && !kind.crmOnly);

/** What sort of thing is in a lead's way. Mirrors the server's list. */
export const BLOCKER_CATEGORIES = [
  { value: 'BUDGET', label: 'Budget', hint: 'No money this cycle, or it is committed elsewhere' },
  { value: 'APPROVAL', label: 'Approval', hint: 'Somebody above our contact has to say yes' },
  { value: 'PRICING', label: 'Pricing', hint: 'The price or terms do not work for them' },
  { value: 'PROOF', label: 'Proof', hint: 'They want evidence, a trial or references first' },
  { value: 'TECHNICAL', label: 'Technical', hint: 'A product or integration gap' },
  { value: 'TIMING', label: 'Timing', hint: 'Season, audit, elections — not now' },
  { value: 'COMPETITION', label: 'Competition', hint: 'They are leaning to someone else' },
  { value: 'CONTACT', label: 'Access', hint: 'We cannot reach the person who decides' },
  { value: 'OTHER', label: 'Something else', hint: '' },
];
export const blockerCategory = (value) =>
  BLOCKER_CATEGORIES.find((c) => c.value === value) || null;

/** Open threads where somebody is waiting on somebody else. */
export const openAsks = (threads = []) =>
  threads.filter((t) => t.status === 'open' && threadKind(t.kind).asking);

export const openReviews = (threads = []) =>
  threads.filter((t) => t.status === 'open' && t.kind === 'review');

/**
 * The one line a card shows when there is a conversation worth noticing.
 * Reviews outrank everything, because they are the ones asking for a change.
 */
export function threadHeadline(threads = []) {
  const reviews = openReviews(threads);
  if (reviews.length) {
    return {
      label: reviews.length === 1 ? 'Needs improvement' : `${reviews.length} changes asked for`,
      severity: 'warning',
      kind: 'review',
    };
  }
  const asks = openAsks(threads);
  if (asks.length) {
    const meta = threadKind(asks[0].kind);
    return {
      label: asks.length === 1 ? meta.label : `${asks.length} open asks`,
      severity: meta.severity,
      kind: asks[0].kind,
    };
  }
  return null;
}

/** "3 replies", or nothing at all when the thread is only its opening message. */
export function replyCount(thread) {
  const count = (thread.messages?.length ?? thread.message_count ?? 1) - 1;
  if (count <= 0) return null;
  return `${count} ${count === 1 ? 'reply' : 'replies'}`;
}
