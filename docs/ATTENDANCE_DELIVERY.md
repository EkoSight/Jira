# Attendance, working hours, leave and salary estimate — delivery report

Brief: *Task Flow — Attendance, Hours, Leave and Salary* (version 2, 1 October 2026).
This report says what was built, what still needs a decision before money is
finalised, what was tested, and what was not.

## Ships switched off

Nothing changes for anyone on deploy. Until an administrator sets **Settings →
Attendance & pay → Attendance starts on**:

- nobody is blocked from any work;
- checking in is available but optional;
- no day is ever counted as unrecorded or absent;
- payroll shows every month as *Needs setup*.

Migration `016_attendance_leave_payroll.sql` only adds tables. No existing table,
column, row, ID or relationship is changed. It was applied to a copy of the dev
database that already held data, and the migration safety suite (additive-only
check, row preservation on a populated database) passes.

## What was built

**Daily attendance.** *Check In / Start Work* and *Check Out / End Work*, separate
from signing in. Each reads the device location once (`enableHighAccuracy`,
`maximumAge: 0`, 15 s timeout, configurable) and sends latitude, longitude,
accuracy and the device's reading time. The server's clock sets the attendance
time. Retries reuse a request id, so a retry never records twice. A dropped
connection is checked with the server before a retry is offered. Database
constraints allow one session per person per day and one open session across all
devices. A check-out after midnight but before the cutoff (04:00) completes the
original day. After the cutoff the session becomes *Missing check-out* and the
time is never guessed.

**Location handling.** Ranges are validated and stale or future-dated readings
are refused. Low-accuracy readings are accepted and flagged for review. There is
no geofence and no address lookup, and nothing is sent to any third party. *Open
in Google Maps* is a link the viewer chooses to click. If the location cannot be
read, the person gets the reason, *Try again*, and *Ask for a correction*.
Nothing is substituted. The check-in card always shows the agreed notice:
“Task Flow records your current location when you check in and check out for
attendance. It does not continuously track your location.”

**The check-in requirement**, once started, is enforced on the server. Writes to
tasks, discussions, goals, key results and the B2B pipeline return
`ATTENDANCE_REQUIRED` until the person checks in. Reading stays open.
Attendance, corrections, leave, account settings and signing out are never
blocked. The client shows a check-in screen in place of work pages. It does not
apply on weekly offs, on holidays, during approved full-day leave, or to people
marked *attendance not required*.

**Signing out while checked in** shows a reminder offering *Check Out / End Work,
then sign out* or *Sign out, stay checked in*. TaskFlow never checks anyone out
automatically.

**Corrections.** Missed check-in or check-out, wrong time, technical problem,
field duty, or reopening today. A correction goes to an authorised reviewer and
never to the requester. Approval writes the times marked *Manually regularised*
and keeps the original in the request and in the audit log. A pending request
changes nothing.

**Working-hours ledger** (`server/src/lib/attendanceCalc.js`, pure functions,
integer seconds). It implements §15 of the brief:

- R, C, L, G, N and E are built from disjoint intervals in that order of
  precedence.
- Unresolved time is never turned into attended or unpaid.
- Morning leave moves the expected arrival time and gives no second grace.
- Lateness beyond grace counts from 09:00.
- Extra time after 18:00 is captured automatically. It can offset a shortfall
  only once a reviewer counts it.
- Offsets are allocated within the month in date order, so the result is
  deterministic.
- Durations show as H:MM (8 h 30 m is “8:30”). Exports also give exact decimal
  hours (8.5).

**Unrecorded days** read *Unrecorded — needs review* until a reviewer confirms an
unapproved absence with a note. Nothing is assumed absent.

**Leave requests.** States: Draft, Pending, Emergency review, Short notice,
Approved paid, Approved unpaid, Rejected, Cancelled.

- Notice is measured from when TaskFlow received the request (48 hours).
- Emergencies need an explanation.
- An earlier email the employee mentions is shown to the reviewer as their claim.
  It never backdates the record.
- Paid leave draws on two paid days a month, day by day across month boundaries.
  Anything beyond that is approved unpaid, and the response says so.
- Statutory leave sits outside the allowance.
- Overlaps are refused, and only scheduled working days count.
- Approval puts the leave on the existing team calendar; cancelling removes it.
- Nobody approves their own leave.

**Monthly salary estimate.** Workflow: Draft → In review → Approved → Locked →
Export.

- Approve and lock re-run the calculation and stop if anything changed since
  submission.
- A locked month keeps a frozen snapshot, including the policy version it used.
- Reopening needs a reason and creates version 2. Version 1 is kept.
- Approved or locked months refuse new corrections, reviews, leave decisions and
  salary amounts until reopened.
- Nobody approves or locks their own pay.
- Salary amounts are effective-dated and never overwritten. Mid-month joiners
  are prorated once, and salary changes split the month into segments.
- Money is held in paise and rounded once.
- *Not applicable* is shown when there is no required time.

**Screens.**

- Dashboard: attendance card.
- *Attendance* page:
  - Today, My month and My leave for everyone.
  - Team (day and month, CSV) and Approvals (leave, corrections, extra time,
    unrecorded days) for authorised people.
- *Payroll* page: monthly summary, bulk actions, a per-person day ledger, salary
  history, versions and the locked CSV export.
- *Settings → Attendance & pay*:
  - Policy, grouped into *Confirmed*, *Proposed — needs your acceptance* and
    *Not supplied yet*.
  - Holidays, employee schedules, and who sees whom.

**Who sees what.** People see their own records. Managers see only the
departments an admin grants them, plus their direct reports. Being a manager
does not by itself open anything. The same rule applies to every API, the
location view, team lists, approvals and exports. Others' coordinates also need
`attendance.location`, and each view is logged. Payroll is separate.

New permissions:

| Area | Permissions |
|---|---|
| Attendance | `attendance.team`, `attendance.all`, `attendance.location`, `attendance.approve`, `attendance.extra.review`, `attendance.policy` |
| Leave | `leave.approve` |
| Payroll | `payroll.view`, `payroll.manage`, `payroll.approve`, `payroll.reopen`, `payroll.salary.edit` |

Admins have all of them. Managers get team, location, approve, extra-review and
leave-approve, and no payroll.

**Exports.** CSV only, because XLSX is not part of the existing stack. Text cells
that could run as spreadsheet formulas are neutralised. The payroll export
contains locked figures only, with no coordinates and no leave reasons. Every
export is logged.

**Reminders.** One check-in reminder and one check-out reminder a day go to the
TaskFlow notification bell, through the existing scanner.

**Audit.** Check-ins, check-outs, missing check-outs, corrections, reviews, leave
decisions, policy edits and acceptance, holidays, schedules, team access, salary
amounts, payroll transitions, exports and location views all go to
`attendance_audit`.

## Still needed before any month is finalised

Drafts run without these items and show them as assumptions:

1. **Accept the policy version.** This accepts the proposed interpretations:
   - grace credit inside the 20-minute window, with lateness counted from 09:00
     after it;
   - pre-09:00 time is not banked;
   - post-18:00 time offsets only after review, within the same month;
   - one pooled allowance of two paid days, from the first full month after
     joining.
2. **Breaks.** Which lunch or rest breaks exist and whether each is paid. This
   was not supplied, so currently none is deducted.
3. **Salary method.** HR or payroll must confirm attendance-sensitive amount ×
   unpaid time ÷ scheduled required time.
4. **Per employee:** joining date and the attendance-sensitive salary amount.
5. **Set the start date**, and grant managers their departments in *Who sees whom*.

Have a qualified HR or payroll adviser validate the deduction, leave, rest and
overtime treatment before using these amounts for actual payment. Internal
offsetting is not a legal exemption.

## Tests actually run

- Server: **296 passing, 0 skipped**, against PostgreSQL.
  - 33 engine tests: every acceptance example in §19, 09:20:00 against 09:20:01,
    the brief's ₹30,000 example, mid-month joining, salary-change segments, and
    reverse-order determinism.
  - 20 attendance API tests:
    - idempotent retries, six simultaneous devices, location validation, and
      ignored client timestamps;
    - overnight check-out and missing check-out;
    - corrections, including no self-approval and the original being kept;
    - location and team visibility by grant and by reporting line;
    - the enforcement gate;
    - leave notice, emergency, allowance split, privacy and cancellation;
    - the full payroll cycle with a known answer: changed-after-submit
      detection, locked-month refusals, reopen versions, export contents and
      formula safety;
    - separated payroll permissions.
  - All earlier tests, including the migration safety suite.
- Client: **49 passing**, including the location reader. A refused, failed,
  timed-out or unanswered permission prompt gives a reason, never a coordinate.
- Browser: Chromium via Playwright with **emulated** geolocation, desktop and
  phone, light and dark. Walked through:
  - dormant dashboard, setting the start date, granting access;
  - the check-in screen on a work page, location unavailable, then checking in;
  - a leave request, then the manager's team view, location and approval;
  - the sign-out reminder with check-out;
  - the payroll page and person detail;
  - the phone month view, with no sideways scrolling.

  Testing found two bugs, and both are fixed:
  - two devices racing a check-in could report a false “already recorded”;
  - an unanswered permission prompt left the button spinning indefinitely.

## Not done, or not claimed

- **Not deployed.**
- **No email is sent.** No mail service is configured. Screens and API responses
  say so, and leave records `email_sent_by_taskflow = false`.
- **No real-device location testing.** Only browser emulation was used, so
  accuracy on real phones, indoors and on iOS Safari is untested.
- **The location is device-reported**, not proof of presence. It is never
  described as verified.
- **No bank transfers, tax, PF, ESI or statutory calculations.** The payroll
  output is an estimate for payroll to use. Its legal compliance is not claimed.
- **One shift per day.** Split shifts and night shifts that start on one date and
  are scheduled across midnight are not modelled.
- **Data retention.** `retentionMonths` is stored but nothing is purged
  automatically.
- **Phone tab bar.** It still holds Dashboard, Board, My tasks, Goals and Notes.
  On a phone, attendance is reached from the dashboard card's *My attendance &
  leave* link.
