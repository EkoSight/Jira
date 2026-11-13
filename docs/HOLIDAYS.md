# Holidays and closures — planning, approval and reconciliation

Holidays are planned a month or so ahead, or added on the day for an unplanned
closure. All of it is managed in one place: **Settings → Attendance & pay →
Holidays**. There is no second calendar. Attendance, required hours, check-in
reminders, the daily standup, leave and black marks all read this calendar.

## What an entry can be

| | Choices |
|---|---|
| Dates | one day, or a range of up to 62 days (a range can cross a month end) |
| Who it covers | everyone, one department, or one person |
| How much of the day | full day, morning off, or afternoon off. The split is the policy's "Half day splits at" time (13:30 by default). |
| Type | holiday (planned) or closure (unplanned: power cut, weather, office shut) |

A half day stays a working day, with shorter hours:

- **Morning off:** work starts at the split. The required hours, the "late"
  measure and the check-in reminder all start from then.
- **Afternoon off:** work ends at the split.

Two entries covering both halves of a day make a full day.

## Who does what

1. **Propose** — someone with *Set working hours, holidays…*
   (`attendance.policy`; HR can be given this one permission) proposes an
   addition, a change or a cancellation, and says why. Nothing changes yet.
2. **Approve** — someone with *Approve holiday and closure changes*
   (`holiday.approve`; administrators by default) opens the request and sees
   what it changes. They then approve or reject it.
   - Nobody approves their own change. The exception is an administrator who
     writes a note saying why; that note is kept, and the request is marked as
     their own.
3. **Publish** — on approval, everyone the entry covers is notified with:
   - the dates and how much of the day;
   - who approved it;
   - the reason.

   The list shows each entry as *In force*, with who approved it and when it
   was announced.

Nothing is ever deleted. A cancelled or replaced entry stays on the list,
struck through, with who cancelled it and why. **History** on any entry shows
the requests that made and ended it, and the audit trail. Payroll months that
are approved or locked cannot be changed; reopen the month first.

## A change to a day that has already happened

The approver sees the impact before deciding, and the request keeps that impact
as they saw it:

- **Attendance** follows the calendar at once. The day ledger is worked out from
  the calendar, so a day that becomes a holiday stops being owed: an unrecorded
  day no longer waits for a reviewer, and a confirmed absence no longer counts.
  No check-in record or reviewer decision is changed; they are kept as they
  were. Draft payroll months recalculate the next time they are opened.
- **Stored records** wait for a person. Each is listed as a correction, and is
  changed only when someone with the right permission applies it:

  | Correction | Applied by someone with |
  |---|---|
  | Waive a black mark whose deadline now falls on a day off | `blackmark.waive` |
  | Restore a mark that was waived for a holiday now cancelled | `blackmark.waive` |
  | Record a mark for a deadline on a holiday cancelled after its day | `blackmark.create` |
  | Excuse a standup recorded missing or late on a day now off (what was recorded stays recorded) | `standup.review` |
  | Undo that excuse when the holiday is cancelled | `standup.review` |
  | Give back a leave day counted on a day now a holiday (paid days return to the allowance) | `leave.approve` |
  | Count it again when the holiday is cancelled | `leave.approve` |

  Rules for corrections:
  - Nobody applies a correction about themselves.
  - Applying keeps the record as it was before and as it became.
  - **Reverse** puts the record back exactly as it was. It is refused if the
    record has changed since; change the record directly instead.
  - A record that changed before the correction was applied is marked "no
    longer applies" rather than overwritten.
  - If a later change ends the holiday, proposals that relied on it and were
    never applied are withdrawn the same way.

  Managers see the corrections they may apply under **Attendance → Approvals**.
  Administrators also see them in Settings.
- **Tasks** are never marked done, and their due dates are never moved.

## Black marks and days off

The black-mark scan judges each deadline against the assignee's own calendar:

- their weekly days: their personal schedule, or the company's;
- approved holidays that cover them, including half days;
- their approved leave.

A deadline that falls while they are not working is in force from the same time
on their next working day. An overdue escalation counts their working days. So
a deadline on a Sunday or a holiday is not missed until the next working day
has passed.

A holiday does not excuse work that was still not done by the deadline in
force. A task due on Friday that becomes a holiday, and is still open after
Saturday's deadline, keeps its mark.

Other rules for marks and days off:

- **Late cancellations.** If a holiday is cancelled after its day began, the
  scan still treats that day as off for *automatic* marks. Any mark for it is
  proposed for a person to decide.
- **Leave approved later.** **Black marks → Check against the calendar** lists
  active marks whose deadline, judged against today's calendar, was not missed.
  This usually means leave or a holiday was approved after the mark. Nothing
  changes there; open the source and waive it if that is right.
- **Where a mark came from.** **Source** on any mark shows:
  - the task;
  - the rule as it stood when the mark was recorded;
  - the deadline, and the deadline in force with what it moved past;
  - the attendance policy version used;
  - every waive, restore and holiday correction, with who and why.

  Marks recorded before this release have no stored evidence, and say so.
- **Months.** Months run midnight to midnight India time. Marks recorded earlier
  keep the month they were given.

## The "three black marks make one day's absence" rule

**It does not exist in TaskFlow, and it has not been built.** The code was
searched in full. The thresholds under **Settings → Thresholds** (warning
points, action points, the missed-deadline limit) only flag people for the
monthly review conversation. No code turns marks into absence, leave debits or
pay deductions. The review screen says so.

Before any such rule could be built, the owner would need to decide in writing:

1. **Counting window**: per calendar month, a rolling 30 days, or something
   else, and in which timezone.
2. **Eligible mark types**: missed deadline, delivered late, escalation cycles,
   reopened, manual. Do escalation cycles of one task count once or each time?
3. **Exemptions**:
   - waived marks;
   - marks on days of leave, holidays or field work;
   - marks under appeal;
   - new joiners;
   - marks from a rule changed after the mark.
4. **Reset and rounding**:
   - does the count reset each window or carry over;
   - what happens to 4 or 5 marks;
   - is the outcome a full day, a half day or unpaid time;
   - which day of the month it is booked to.
5. **Review**: who confirms each conversion before it reaches attendance or pay,
   how it is appealed, and how it is reversed.

Until then, marks never change attendance, leave or pay.

## Tested, and not yet verified

- **Sandbox tests** (`server/tests/holidays.test.js`): a throwaway database
  with synthetic people and fixed October 2026 dates. They cover:
  - a regular workday;
  - a Sunday;
  - a personal schedule override;
  - proposing, approval by someone else, and an administrator's own approval
    with a note;
  - a full-day and a half-day holiday, including the moved check-in reminder
    and the standup;
  - a late-added closure: preview, approval, each correction applied or
    reversed by permission, records unchanged until then;
  - a holiday cancelled after its day;
  - an amendment across a month end;
  - approved leave, and leave approved after a mark;
  - duplicate runs of the scan and of decisions;
  - a waived mark through restore;
  - the India-time month boundary and the thresholds, with attendance, leave
    and pay records unchanged;
  - that no task is marked done or has its deadline moved.

  Screen wording: `client/tests/holidays.test.js`.
- **Browser check:** the screens were also walked through in a browser against
  a local copy with made-up people: proposing, reviewing the impact, approving,
  applying a correction from Approvals, a mark's source, and phone width.
- **Not done:** nothing was run against the live database. No real holiday,
  attendance record, mark, leave, payslip or deadline was changed. Approving
  real holidays, and reviewing any corrections they list, is for the people
  who hold those permissions.
