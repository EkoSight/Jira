/**
 * The working-time and salary calculation, as pure functions.
 *
 * Nothing here reads the database, the clock or the environment. The same saved
 * inputs and the same policy always give the same answer, which is what lets a
 * locked month be re-explained years later and lets every rule be tested on its
 * own.
 *
 * All durations are integer SECONDS. Times within a day are seconds after
 * midnight of the work date in the organisation's timezone; a session that
 * runs past midnight simply has a check-out above 86 400. Nothing is ever stored
 * as "8.30 hours".
 *
 * The per-day quantities follow the brief exactly:
 *
 *   R  scheduled payroll-required time
 *   C  attendance coverage inside the payroll-creditable schedule
 *   L  approved paid-leave coverage inside that schedule
 *   G  eligible arrival-grace credit inside that schedule
 *   N  confirmed non-offsettable unpaid time (approved unpaid leave, confirmed
 *      unapproved absence)
 *   E  eligible post-shift time
 *
 * C, L, G and N are built as a union of disjoint intervals, in that order of
 * precedence, so no scheduled second is ever counted twice. Anything that is not
 * yet resolved (a missing check-out, a pending leave, a day nobody has reviewed)
 * is reported as UNRESOLVED and is never quietly turned into C or N.
 */

// ---------------------------------------------------------------- intervals

/** Sorted, merged, non-empty intervals. */
export function normalise(intervals) {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .map(([a, b]) => [a, b])
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export const length = (intervals) => normalise(intervals).reduce((sum, [a, b]) => sum + (b - a), 0);

export function intersect(xs, ys) {
  const a = normalise(xs);
  const b = normalise(ys);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i += 1; else j += 1;
  }
  return out;
}

export function subtract(xs, ys) {
  let result = normalise(xs);
  for (const [c, d] of normalise(ys)) {
    const next = [];
    for (const [a, b] of result) {
      if (d <= a || c >= b) { next.push([a, b]); continue; }
      if (c > a) next.push([a, c]);
      if (d < b) next.push([d, b]);
    }
    result = next;
  }
  return result;
}

export const union = (...lists) => normalise(lists.flat());

// ---------------------------------------------------------------- time helpers

/** "09:20" → 33 600 seconds after midnight. */
export function clock(hhmm) {
  if (typeof hhmm === 'number') return hhmm;
  const [h, m = '0', s = '0'] = String(hhmm).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** 30 600 → "08:30". Never "8.30". */
export function hhmm(seconds, { signed = false } = {}) {
  if (seconds === null || seconds === undefined) return '—';
  const negative = seconds < 0;
  const total = Math.round(Math.abs(seconds) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const text = `${h}:${String(m).padStart(2, '0')}`;
  if (negative) return `−${text}`;
  return signed && seconds > 0 ? `+${text}` : text;
}

/** Exact decimal hours for export: 8h30m is 8.5, not 8.30. */
export const decimalHours = (seconds) => Math.round((seconds / 3600) * 10000) / 10000;

// ---------------------------------------------------------------- the schedule

/**
 * The payroll-creditable intervals of a scheduled day: the office span minus
 * any break that is configured as unpaid. A paid break stays creditable.
 */
export function creditableIntervals(schedule) {
  const span = [[schedule.start, schedule.end]];
  const unpaid = (schedule.breaks || []).filter((b) => !b.paid).map((b) => [b.start, b.end]);
  return subtract(span, unpaid);
}

// ---------------------------------------------------------------- one day

export const DAY_STATES = {
  WORKDAY: 'WORKDAY',
  WEEKLY_OFF: 'WEEKLY_OFF',
  HOLIDAY: 'HOLIDAY',
  NOT_EMPLOYED: 'NOT_EMPLOYED',
  BEFORE_START: 'BEFORE_START',
};

const zero = () => ({
  R: 0, C: 0, L: 0, G: 0, N: 0, U: 0,
  E_recorded: 0, E_eligible: 0, E_pending: 0, E_rejected: 0,
  early_arrival: 0, late_seconds: 0, early_departure: 0,
  duration: 0, net_estimate: 0,
  ordinary_short: 0, same_day_offset: 0, remaining_short: 0, remaining_extra: 0,
});

/**
 * One scheduled day.
 *
 *   input.schedule   { state, start, end, breaks: [{ start, end, paid }], beforeStart? }
 *   input.session    null | { checkIn, checkOut, status: OPEN|COMPLETED|MISSING_CHECKOUT, regularized }
 *   input.leave      [{ start, end, paid, status: APPROVED|PENDING }]
 *   input.absence    null | 'UNAPPROVED_ABSENCE'   (a reviewer's confirmed decision)
 *   input.extra      { status: PENDING|ELIGIBLE|REJECTED, eligibleSeconds? }
 *   input.phase      PAST | TODAY | FUTURE   (relative to now and the day's cutoff)
 *   policy           { graceSeconds, graceMode, creditBeforeStart, extraRequiresReview, maxSessionSeconds }
 */
export function computeDay(input, policy) {
  const out = { date: input.date, ...zero(), flags: [], blockers: [], classification: null };
  const { schedule, session, phase } = input;

  // ---- days that are not working days at all
  if (schedule.state !== DAY_STATES.WORKDAY) {
    out.classification = schedule.state;
    if (session?.checkIn !== undefined && session?.checkIn !== null) {
      // somebody checked in on a day off: record it, credit nothing automatically
      out.flags.push('WORKED_ON_NON_WORKING_DAY');
      if (session.status === 'COMPLETED') out.duration = session.checkOut - session.checkIn;
    }
    return out;
  }

  const hasCheckIn = session && session.checkIn !== null && session.checkIn !== undefined;

  // before attendance tracking starts, a working day nobody recorded is not
  // owed, not short and not waiting for review — it simply was not tracked.
  // A day someone did record is worked out in full below.
  if (schedule.beforeStart && !hasCheckIn) {
    const leave = input.leave || [];
    if (leave.some((l) => l.status === 'PENDING')) out.classification = 'PENDING_LEAVE';
    else if (leave.some((l) => l.status === 'APPROVED' && l.paid)) out.classification = 'PAID_LEAVE';
    else if (leave.some((l) => l.status === 'APPROVED')) out.classification = 'UNPAID_LEAVE';
    else out.classification = phase === 'FUTURE' ? 'UPCOMING' : phase === 'TODAY' ? 'NOT_CHECKED_IN' : DAY_STATES.BEFORE_START;
    return out;
  }

  const S = creditableIntervals(schedule);
  out.R = length(S);

  if (phase === 'FUTURE') {
    out.classification = 'UPCOMING';
    return out;
  }

  const hasSession = session && session.checkIn !== null && session.checkIn !== undefined;
  const completed = hasSession && session.status === 'COMPLETED' && session.checkOut !== null;

  if (phase === 'TODAY' && !completed) {
    // the working day is not over: nothing is short, late or banked yet
    out.classification = hasSession ? 'IN_PROGRESS' : 'NOT_CHECKED_IN';
    if (hasSession) {
      const grace = arrivalJudgement(session.checkIn, schedule, [], policy);
      out.late_seconds = grace.lateSeconds;
      if (grace.late) out.flags.push('LATE');
    }
    return out;
  }

  // ---- leave, in the order it is trusted
  const approvedPaid = (input.leave || []).filter((l) => l.status === 'APPROVED' && l.paid).map((l) => [l.start, l.end]);
  const approvedUnpaid = (input.leave || []).filter((l) => l.status === 'APPROVED' && !l.paid).map((l) => [l.start, l.end]);
  const pending = (input.leave || []).filter((l) => l.status === 'PENDING').map((l) => [l.start, l.end]);

  // ---- attendance coverage
  let A = [];
  if (completed) {
    A = [[session.checkIn, session.checkOut]];
    out.duration = session.checkOut - session.checkIn;
    const unpaidBreaks = (schedule.breaks || []).filter((b) => !b.paid).map((b) => [b.start, b.end]);
    // net working estimate: presence minus any unpaid break it overlapped
    out.net_estimate = out.duration - length(intersect(A, unpaidBreaks));
    if (session.regularized) out.flags.push('MANUALLY_REGULARIZED');
    if (policy.maxSessionSeconds && out.duration > policy.maxSessionSeconds) {
      out.flags.push('LONG_SESSION');
    }
  }

  const Cset = intersect(A, S);
  out.C = length(Cset);

  // paid leave covers what attendance did not; working on leave is flagged, not paid twice
  const paidLeaveInSchedule = intersect(approvedPaid, S);
  if (length(intersect(paidLeaveInSchedule, Cset)) > 0) out.flags.push('WORKED_DURING_PAID_LEAVE');
  const Lset = subtract(paidLeaveInSchedule, Cset);
  out.L = length(Lset);

  // ---- arrival grace
  const leaveCovered = union(Lset, intersect(approvedUnpaid, S), intersect(pending, S));
  let Gset = [];
  if (hasSession) {
    const judgement = arrivalJudgement(session.checkIn, schedule, leaveCovered, policy);
    out.late_seconds = judgement.lateSeconds;
    if (judgement.late) out.flags.push('LATE');
    if (judgement.withinGrace) out.flags.push('WITHIN_GRACE');
    Gset = subtract(intersect(judgement.graceInterval, S), union(Cset, Lset));
    out.early_arrival = Math.max(0, schedule.start - session.checkIn);
  }
  out.G = length(Gset);

  // ---- unpaid, non-offsettable time
  let Nset = subtract(intersect(approvedUnpaid, S), union(Cset, Lset, Gset));

  // ---- what is still unknown
  const pendingSet = subtract(intersect(pending, S), union(Cset, Lset, Gset, Nset));
  if (length(pendingSet) > 0) out.blockers.push('PENDING_LEAVE');

  let unresolved = pendingSet;
  if (hasSession && !completed) {
    // a past day still open: nobody knows when they left
    out.blockers.push('MISSING_CHECKOUT');
    out.flags.push('MISSING_CHECKOUT');
    unresolved = union(unresolved, subtract(S, union(Lset, Nset, pendingSet)));
  }

  if (!hasSession) {
    const uncovered = subtract(S, union(Lset, Nset, pendingSet));
    if (length(uncovered) > 0) {
      if (input.absence === 'UNAPPROVED_ABSENCE') {
        // a reviewer has confirmed it: unpaid, and not something extra time can buy back
        Nset = union(Nset, uncovered);
      } else {
        out.blockers.push('UNRECORDED');
        unresolved = union(unresolved, uncovered);
      }
    }
  }
  out.N = length(Nset);
  out.U = length(unresolved);

  // ---- early departure, against what was expected after any leave
  if (completed) {
    const expectedEnd = expectedEndTime(schedule, union(Lset, intersect(approvedUnpaid, S)));
    if (session.checkOut < expectedEnd) {
      out.early_departure = length(subtract(intersect([[session.checkOut, expectedEnd]], S), union(Lset, Nset)));
      if (out.early_departure > 0) out.flags.push('EARLY_DEPARTURE');
    }
  }

  // ---- extra time after the shift
  if (completed) {
    const postStart = Math.max(session.checkIn, schedule.end);
    let post = session.checkOut > postStart ? [[postStart, session.checkOut]] : [];
    const unpaidAfter = (schedule.breaks || []).filter((b) => !b.paid).map((b) => [b.start, b.end]);
    post = subtract(post, unpaidAfter);
    out.E_recorded = length(post);
    if (policy.creditBeforeStart) out.E_recorded += out.early_arrival;

    const review = input.extra || { status: policy.extraRequiresReview ? 'PENDING' : 'ELIGIBLE' };
    // an implausibly long session is never banked without a person looking at it
    const status = out.flags.includes('LONG_SESSION') && review.status === 'ELIGIBLE' && !review.reviewed
      ? 'PENDING' : review.status;

    if (out.E_recorded > 0) {
      if (status === 'ELIGIBLE') {
        out.E_eligible = Math.min(out.E_recorded, review.eligibleSeconds ?? out.E_recorded);
        out.E_rejected = out.E_recorded - out.E_eligible;
      } else if (status === 'REJECTED') {
        out.E_rejected = out.E_recorded;
      } else {
        out.E_pending = out.E_recorded;
        out.blockers.push('EXTRA_PENDING');
      }
    }
  }

  // ---- the day's balance
  out.ordinary_short = Math.max(0, out.R - out.C - out.L - out.G - out.N - out.U);
  out.same_day_offset = Math.min(out.ordinary_short, out.E_eligible);
  out.remaining_short = out.ordinary_short - out.same_day_offset;
  out.remaining_extra = out.E_eligible - out.same_day_offset;

  // before tracking starts the hours are shown, but nothing is owed: no
  // shortfall, no unpaid time, and no extra time waiting for anyone to review
  if (schedule.beforeStart) {
    out.ordinary_short = 0;
    out.same_day_offset = 0;
    out.remaining_short = 0;
    out.remaining_extra = 0;
    out.E_eligible = 0;
    out.E_pending = 0;
    out.E_rejected = 0;
    out.blockers = out.blockers.filter((b) => b !== 'EXTRA_PENDING');
  }

  out.classification = classify(out, { hasSession, completed, approvedPaid, approvedUnpaid, S, absence: input.absence });
  return out;
}

/** Whether an arrival was on time, within grace, or late — and how much grace it earns. */
export function arrivalJudgement(checkIn, schedule, leaveCovered, policy) {
  const S = creditableIntervals(schedule);
  // when leave covers the start of the day, expected arrival is when that leave
  // ends, and there is no second morning grace on top of it
  const morningLeave = leaveCovered.length && leaveCovered[0][0] <= schedule.start;
  const expected = morningLeave ? firstUncovered(S, leaveCovered) : schedule.start;
  if (expected === null) return { late: false, withinGrace: false, lateSeconds: 0, graceInterval: [] };

  const delay = checkIn - expected;
  if (delay <= 0) return { late: false, withinGrace: false, lateSeconds: 0, graceInterval: [] };
  if (morningLeave) {
    return { late: true, withinGrace: false, lateSeconds: delay, graceInterval: [] };
  }

  const grace = policy.graceSeconds ?? 0;
  const mode = policy.graceMode || 'THRESHOLD';
  if (mode !== 'NONE' && delay <= grace) {
    return { late: false, withinGrace: true, lateSeconds: 0, graceInterval: [[expected, checkIn]] };
  }
  // after the cutoff the lateness is measured from the start, not from the cutoff
  const forgiven = mode === 'FORGIVE_FIRST' ? [[expected, expected + grace]] : [];
  return { late: true, withinGrace: false, lateSeconds: delay, graceInterval: forgiven };
}

function firstUncovered(S, covered) {
  const free = subtract(S, covered);
  return free.length ? free[0][0] : null;
}

function expectedEndTime(schedule, leaveCovered) {
  const S = creditableIntervals(schedule);
  const free = subtract(S, leaveCovered);
  return free.length ? free[free.length - 1][1] : schedule.end;
}

function classify(out, { hasSession, completed, approvedPaid, approvedUnpaid, S, absence }) {
  if (out.blockers.includes('MISSING_CHECKOUT')) return 'MISSING_CHECKOUT';
  const paidAll = length(intersect(approvedPaid, S)) >= out.R && out.R > 0;
  const unpaidAll = length(intersect(approvedUnpaid, S)) >= out.R && out.R > 0;
  if (!hasSession) {
    if (paidAll) return 'PAID_LEAVE';
    if (unpaidAll) return 'UNPAID_LEAVE';
    if (absence === 'UNAPPROVED_ABSENCE') return 'UNAPPROVED_ABSENCE';
    if (out.blockers.includes('PENDING_LEAVE')) return 'PENDING_LEAVE';
    if (out.blockers.includes('UNRECORDED')) return 'UNRECORDED_NEEDS_REVIEW';
    return out.L > 0 ? 'PARTIAL_LEAVE' : 'UNRECORDED_NEEDS_REVIEW';
  }
  if (!completed) return 'MISSING_CHECKOUT';
  if (out.L > 0 || out.N > 0) return 'ATTENDED_WITH_PARTIAL_LEAVE';
  return 'ATTENDED';
}

// ---------------------------------------------------------------- a month

/**
 * Pools the month and allocates leftover extra time to leftover shortfalls.
 *
 * Deterministic: sources and targets are both taken in date order, so the
 * answer never depends on which record happened to be processed first. Every
 * allocated second is linked to the day it came from and the day it covered,
 * and no second is used twice. Nothing crosses a month boundary — the caller
 * passes one payroll month.
 */
export function computeMonth(days) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sum = (key) => sorted.reduce((total, d) => total + (d[key] || 0), 0);

  const sources = sorted.filter((d) => d.remaining_extra > 0).map((d) => ({ date: d.date, left: d.remaining_extra }));
  const targets = sorted.filter((d) => d.remaining_short > 0).map((d) => ({ date: d.date, left: d.remaining_short }));

  const allocations = [];
  let i = 0;
  let j = 0;
  while (i < sources.length && j < targets.length) {
    const take = Math.min(sources[i].left, targets[j].left);
    if (take > 0) {
      allocations.push({ source_date: sources[i].date, target_date: targets[j].date, seconds: take });
      sources[i].left -= take;
      targets[j].left -= take;
    }
    if (sources[i].left === 0) i += 1;
    if (targets[j].left === 0) j += 1;
  }

  const remainingShort = sum('remaining_short');
  const remainingExtra = sum('remaining_extra');
  const crossDay = allocations.reduce((total, a) => total + a.seconds, 0);
  const residual = remainingShort - crossDay;
  const nonOffsettable = sum('N');
  const unpaid = residual + nonOffsettable;
  const required = sum('R');
  const unresolved = sum('U');
  const blockers = [...new Set(sorted.flatMap((d) => d.blockers.map((b) => `${b}`)))];

  const count = (pred) => sorted.filter(pred).length;
  const scheduled = sorted.filter((d) => d.R > 0);

  return {
    totals: {
      required: required,
      recorded_duration: sum('duration'),
      net_estimate: sum('net_estimate'),
      in_schedule: sum('C'),
      grace: sum('G'),
      paid_leave: sum('L'),
      non_offsettable_unpaid: nonOffsettable,
      unresolved,
      ordinary_short: sum('ordinary_short'),
      extra_recorded: sum('E_recorded'),
      extra_eligible: sum('E_eligible'),
      extra_pending: sum('E_pending'),
      extra_rejected: sum('E_rejected'),
      same_day_offset: sum('same_day_offset'),
      cross_day_offset: crossDay,
      residual_short: residual,
      unpaid,
      salary_credited: required - unpaid,
      unused_extra: remainingExtra - crossDay,
      late_seconds: sum('late_seconds'),
      early_departure: sum('early_departure'),
    },
    days: {
      scheduled: scheduled.length,
      attended: count((d) => d.C > 0 || d.classification === 'ATTENDED'),
      paid_leave: count((d) => d.classification === 'PAID_LEAVE'),
      unpaid_leave: count((d) => d.classification === 'UNPAID_LEAVE'),
      unapproved_absence: count((d) => d.classification === 'UNAPPROVED_ABSENCE'),
      needs_review: count((d) => d.classification === 'UNRECORDED_NEEDS_REVIEW'),
      weekly_off: count((d) => d.classification === DAY_STATES.WEEKLY_OFF),
      holiday: count((d) => d.classification === DAY_STATES.HOLIDAY),
      upcoming: count((d) => d.classification === 'UPCOMING'),
      // flags overlap other classifications; they are counts of days, not extra days
      late: count((d) => d.flags.includes('LATE')),
      early_departure: count((d) => d.flags.includes('EARLY_DEPARTURE')),
      missing_checkout: count((d) => d.flags.includes('MISSING_CHECKOUT')),
      regularized: count((d) => d.flags.includes('MANUALLY_REGULARIZED')),
    },
    allocations,
    blockers,
    final: blockers.length === 0 && unresolved === 0,
  };
}

// ---------------------------------------------------------------- salary

/** Paise from rupees, exactly. */
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const fromPaise = (paise) => Math.round(paise) / 100;

/**
 * The proposed scheduled-hours method, per salary segment.
 *
 *   segments: [{ monthlyBase, fullMonthRequired, segmentRequired, segmentUnpaid }]
 *
 * A segment is a stretch of the month under one salary and one employment
 * status. Its entitlement is the monthly base prorated by the scheduled time it
 * covers (so a mid-month joiner is prorated once, here), and the attendance
 * adjustment is then that entitlement × unpaid / required for the segment.
 * Money is held in paise and rounded once, at the end.
 */
export function computeSalary(segments) {
  if (!segments.length) return { status: 'NEEDS_SETUP', reason: 'No salary basis for this period' };
  let entitlement = 0;
  let adjustment = 0;
  const lines = [];

  for (const seg of segments) {
    if (!seg.fullMonthRequired || !seg.segmentRequired) {
      return { status: 'NOT_APPLICABLE', reason: 'No required time in the period — needs payroll review' };
    }
    const unpaid = Math.min(Math.max(seg.segmentUnpaid, 0), seg.segmentRequired);
    const base = toPaise(seg.monthlyBase);
    const segEntitlement = (base * seg.segmentRequired) / seg.fullMonthRequired;
    const segAdjustment = (segEntitlement * unpaid) / seg.segmentRequired;
    entitlement += segEntitlement;
    adjustment += segAdjustment;
    lines.push({
      monthly_base: fromPaise(base),
      prorated_entitlement: fromPaise(segEntitlement),
      required_seconds: seg.segmentRequired,
      unpaid_seconds: unpaid,
      adjustment: fromPaise(segAdjustment),
    });
  }

  const entitlementR = Math.round(entitlement);
  const adjustmentR = Math.round(adjustment);
  return {
    status: 'CALCULATED',
    entitlement: fromPaise(entitlementR),
    attendance_adjustment: fromPaise(adjustmentR),
    attendance_adjusted_earnings: fromPaise(entitlementR - adjustmentR),
    lines,
  };
}
