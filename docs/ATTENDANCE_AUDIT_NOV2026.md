# Attendance, leave and payroll — November 2026 audit fixes

Response to the 1 November 2026 audit and fix prompt. Every finding was checked
against the source at `ab11ce37f33ecd3bafc49ed14fc38b0db5990c8c` (the commit the
audit inspected) before anything was changed. All of them held up.

**Not done here, and not authorised:** no merge, deployment, production
migration, change to live HR records, leave approval, payroll finalisation or
payment. Nothing was run against production. Tests use synthetic people and
amounts only. **This change adds no database migration**: it is code-only.

## Findings, by how they were established

**Reproduced live by the auditor; fixed here, with a test that fails on the old code**

| | Finding | Where (at `ab11ce3`) | Fix |
|---|---|---|---|
| A | Payroll detail showed `Provisional: [object Object]`. Payroll sends blockers as `{ code, label }`; the attendance month sends codes; `MonthLedger` handled only codes. | `client/src/components/Attendance.jsx:662`; `server/src/routes/payroll.js:105,132` | `blockerLabel()` in `client/src/lib/attendance.js` reads both shapes; anything unknown still reads as words. |

**Found in the source and confirmed by a synthetic test (failing on the old code, passing now)**

| | Finding | Where (at `ab11ce3`) | Fix |
|---|---|---|---|
| C | Approved leave today showed as *Not checked in*; future approved leave as plain *Upcoming*. The today/future early returns ran before leave was read. | `server/src/lib/attendanceCalc.js:182–201` (leave read at `:204`) | Leave is read first. Full-day leave today is worked out as leave. Future approved leave is `PLANNED_PAID_LEAVE` / `PLANNED_UNPAID_LEAVE` / `PLANNED_PARTIAL_LEAVE`, shown but never accrued (`L`/`N` stay 0). Pending leave stays pending (`LEAVE_PENDING` flag). |
| D | A 09:10 check-in with no check-out: grace 10 min **and** unresolved 9 h — 9 h 10 min accounted against 9 h. | `attendanceCalc.js:257` | Unresolved time excludes grace and coverage. Every day now checks `C + L + G + N + U ≤ R`; a day that ever broke it would be held back (`ACCOUNTING_CHECK`), not paid. Randomised test: 3,000 days. |
| E | No joining date under "first full month after joining" still gave the full allowance. | `server/src/services/leave.js:67–74` | Eligibility is `ELIGIBLE` / `NOT_YET_ELIGIBLE` / `UNKNOWN`. Unknown shows no number ("Not known yet"); paid approval is refused (`ELIGIBILITY_UNKNOWN`) until HR records the date. Existing approvals are untouched. |
| G | Reading a report wrote to attendance: `buildLedgers` turned open sessions into missing check-outs and wrote audit rows. | `server/src/services/attendanceLedger.js:67`; also the today card relied on it (`server/src/routes/attendance.js:88`) | Reads work the state out without writing. The transition is made only by the attendance sweep and by write actions. It is idempotent and judged by each day's own policy, and its audit row records that policy. A test checksums six tables around seven GET routes. |
| J | Approve/lock compared figures only. A policy acceptance cleared after submission, with identical figures, did not stop approval. | `server/src/services/payroll.js:138–145`; `attendanceLedger.js:298` | Approve and lock re-run every readiness check (`NOT_READY`) and compare the policy versions too. |
| K | Status was read outside the transaction and updated by id with no state guard; concurrent approve/return/lock could overwrite each other. | `payroll.js:103–104, 111, 148` | One transaction per call, serialised per person-month (advisory lock), row re-read `FOR UPDATE`, conditional updates. Optional `expected: { status, version }` gives `STALE_STATE`. A repeated call by the same person returns `replayed: true` instead of acting twice. |
| I | Payroll took "active users + saved results": a leaver without a saved result dropped out; a future joiner was listed. | `payroll.js:30–39` | Employment overlap with the month (joining/exit dates), plus saved results. Missing dates are exceptions; `excluded` lists who is left out and why. |
| F | `currentPolicy()` returned the newest version even if it starts later. | `server/src/services/attendancePolicy.js:159` | `currentPolicy(now)` is the version in force on today's date in Asia/Kolkata. Leave allocation, notice, the cutoff for each session, corrections and the gate use the policy of the date concerned. Settings builds new versions on `latestPolicy()`. |
| B | "Mark leave" wrote straight to the calendar. Calendar edit/delete could change or cancel an approved request's copy without approval or payroll-lock checks. | `client/src/components/Availability.jsx:72–85, 250–254`; `server/src/routes/availability.js:132–249`; projection at `leave.js:329` | Every "Mark leave" opens the leave request (an approver can record one for someone; it still needs a decision). The server refuses `ON_LEAVE`/`HALF_DAY` writes (`USE_LEAVE_REQUEST`) and any edit of a request's copy (`MANAGED_BY_LEAVE_REQUEST`). Old calendar leave can only be cancelled — audited, and never past a payroll lock. `UNAVAILABLE` (planning) is unchanged. Approval now tells task owners about deadlines in the leave, as calendar booking did. |
| H | No stale-response guard: a slow October answer could replace November; failures left a spinner or a stale screen. | `client/src/pages/Payroll.jsx:27–32`; `client/src/pages/Attendance.jsx:100, 195–204, 350`; `client/src/components/Availability.jsx:374–378` | `useLoad()`: numbered requests with abort, and an answer must be for the period asked. A failure shows an error with a retry, never an empty month or a zero. Offline copies are labelled. |

**Found while fixing (not in the audit)**

- `client/public/sw.js:48` cached every API GET on the device, payroll
  included, and served the last copy when offline. Payroll is no longer cached.
  The cache version is bumped, which clears copies already stored.
- `server/tests/progress.test.js` dated a purchase order "yesterday" and expected
  it in the current month, so it failed on the 1st of every month (it fails on
  `ab11ce3` too). Test-only fix: dated today.
- Some existing tests use first names that may belong to real staff (for example in
  `attendance.test.js`). The new tests use synthetic names only. Renaming the old
  ones is left as a separate, test-only change.

**Not verified — hypotheses only**

- Deployment parity: which commit production runs was not established. The source
  findings apply to production only if it runs this code.
- The correction requests that mention location or check-out trouble. Location
  failures were exercised with mocked geolocation (below), not on staff devices.
  No real-device or production location test was done.
- Whether the live pages wrote missing check-outs while the auditor browsed
  (finding G) cannot be told from here; the audit log on production would show
  `MARKED_MISSING_CHECKOUT` rows with `source = SYSTEM`.

## Screens

- **Payroll headline** says how much of the team it covers before any total:
  "0 of 28 … No estimate yet" (no number at all), "Partial total … covers N
  people only — not the team's payroll", or "Total" only when every row is
  calculated and ready. A calculated row with unresolved days is marked as able to
  go down. Every money figure says it is the attendance-sensitive part, not net pay.
- **Readiness check** (`GET /payroll/:month/readiness`, button on Payroll): it covers
  - joining and exit dates, salary coverage, policy decisions and holidays;
  - who can approve each person, leave eligibility and unrecorded days;
  - missing check-outs, extra time waiting and pending leave/corrections;
  - opening balances, which are marked *outside TaskFlow*.

  Each item has a count, the people and a link to the existing workflow. It reads
  only.
- **Labels:**
  - Team month "Extra (pending)" is now **Extra recorded · awaiting review**.
  - "Required so far" (attendance) and **Required (whole month)** (payroll) each
    say why they differ.
- **Names that collide:** payroll rows show the person's id (`#12`).
- Unchanged: aggregation of money, the fixed-components rule (maximum across
  segments), the salary method and divisor, breaks, rounding and penalties. These wait
  for the payroll owner (see questions).

## Tests actually run (1 November 2026, local)

| Suite | Result |
|---|---|
| Server, all files (`npm test`, test schema) | **518 / 518 pass** — includes `auditEngine.test.js` (16) and `auditPayroll.test.js` (12) |
| Client (`npm test`) | **103 / 103 pass** — includes `auditAttendance.test.js` (16) |
| Client build (`vite build`) | passes |
| Browser walk (Chromium, local test schema, synthetic data) | **20 / 20 checks pass, no page errors** |

**Shown to fail on the old code before passing:**

- 10 of the 16 engine tests (C, D and the partition rule) fail on `ab11ce3`'s
  engine.
- The no-writes test fails on the old ledger at "GET requests changed nothing".

Acceptance tests from the fix prompt, by number:

1. **Tested:**
   - Frozen 1 Nov 2026: November 225:00 whole month and 0:00 so far; October
     243:00.
   - No future absence; October unrecorded rather than absent.
2. **Tested:**
   - Joining 10 Nov, exit 12 Nov (deactivated), exit in October and joining in
     December: the right months.
   - No pre-joining or post-exit absence.
3. **Tested:** unknown eligibility, a setup exception and readiness items.
4. **Tested:**
   - Leave today is shown as leave; future leave as planned and not accrued.
   - Pending, rejected and cancelled leave never look approved.
5. **Tested:** grace 10 min plus unresolved 8:50 ≤ 9:00, no check-out invented,
   and submit refused.
6. **Tested:** half days with paid/unpaid leave, overlapping leave and absence,
   and leave on days off — no double counting.
7. **Tested (server and browser):**
   - Mark leave creates one pending request, and one approval creates one
     calendar entry.
   - Calendar edit/delete of that entry is refused.
   - Cancelling the request removes the entry.
   - Old calendar leave can be cancelled, is audited and is blocked by a payroll
     lock.
8. **Tested (unit and browser):** string and object blockers, unknown codes and
   junk all read as words.
9. **Partly tested:**
   - List, detail and calculation agree; fixed components stay separate.
   - The headline covers the all-uncalculated, partial, complete and
     mixed-currency cases.
   - **Not tested:** salary-effective-date rounding against an *approved* fixture,
     and export-versus-list for the same cutoff. There is no approved method to
     test against yet.
10. **Tested (unit and browser):**
    - Reordered October/November answers; a wrong-period answer; failure, then
      retry; an empty month; offline copies.
11. **Tested:**
    - Repeated calculations give the same fingerprint, and retried transitions are
      `replayed`.
    - A double reopen makes one version.
    - The locked snapshot is unchanged after later attendance and salary edits.
12. **Tested:**
    - At `2026-10-31T18:29:59.999Z` a check-in belongs to 31 October; at
      `18:30:00Z`, to 1 November.
    - Year rollover; February 2027 (28 days) and leap February 2028 (225:00).
    - A December policy leaves November alone, including the November cutoff.
13. **Tested in the browser, mocked geolocation:**
    - Denied and timeout each give a clear message and no record.
    - Offline says nothing was recorded, and retry records once.
    - A stale reading is recorded once and flagged `STALE_READING`, as the
      existing policy says. The policy was not weakened.
    - A double click on Check Out gives one completed session.
14. **Tested:** seven GET routes leave six tables byte-identical; the sweep runs
    once, is audited and uses each date's policy.
15. **Tested:** black marks and kudos change no classification, totals, money or
    leave balance.
16. **Tested:**
    - An acceptance reset with identical figures blocks approve and lock.
    - Racing lock vs. return: one wins and the other gets `STALE_STATE`.
    - Retries add no audit row.

## Legacy calendar leave — dry run

```
cd server && npm run leave:reconcile        # JSON on stdout; READ ONLY transaction, rolled back
```

For each old calendar leave row that never became a request, the report gives:

- the overlapping requests and their states;
- the days with attendance;
- any closed payroll months;
- a proposal: `COVERED_BY_APPROVED_REQUEST`, `WAIT_FOR_PENDING_REQUEST` or
  `REVIEW_WITH_PERSON`.

It also lists active people with no joining date and deactivated accounts with
no exit date, and states that opening balances are not in TaskFlow. It shows ids
only, never names, reasons, salaries or contact or location data.

It approves nothing, makes nothing unpaid and has no apply mode. Decisions are
made by people in the app, where each one is checked and audited.

Run on the local test schema it reported: 0 legacy rows, 4 people with unknown
eligibility, 0 deactivated accounts without an exit date, and `writes: 0`. The
production report has not been run.

## Questions for the payroll owner and HR (blocking finalisation, not attendance)

1. **Unresolved and future time in earnings.** `salary_credited` and the estimate
   do not deduct unresolved or future scheduled time until it is decided. Is the
   headline figure meant to be:
   - earned to date,
   - a whole-month projection, or
   - "gross if everything resolves"?
2. **Fixed components across salary changes.** The ledger shows the *maximum*
   across a month's segments. Should a mid-month change instead be prorated?
3. **Method, divisor and rounding.** Scheduled hours (proposed) or something
   else? Rounding rule?
4. **Breaks.** Which exist, and are they paid?
5. **Holidays.** None are recorded for 2026. Confirm or add them.
6. **Leave eligibility.**
   - Confirm "first full month after joining".
   - Carry-forward rules.
   - November opening balances.
   - Which policy governs a month whose policy changes mid-month? (Now: the one in
     force on the 1st.)
7. **Employment dates.** All 28 people need joining dates, and leavers need exit
   dates. Who records them, from which source?
8. **Approval routes.** Who approves leave, corrections and payroll for each
   team?

## November go / no-go

**No-go today.** The code fixes are in this branch, but every item below must hold
first:

- [ ] Review and merge this branch; confirm the deployed commit matches it.
- [ ] Back up production and restore-test the backup. This change has no
      migration, so there is nothing to rehearse; it is a code-only rollout.
- [ ] Deploy; open Payroll → *Readiness check* for November.
- [ ] HR records joining and exit dates, attendance-sensitive salaries,
      holidays, breaks, the method/divisor and approval routes. An administrator
      then accepts the policy version.
- [ ] Run `npm run leave:reconcile`. HR decides each old calendar leave row in the
      app.
- [ ] Reconcile opening leave balances, advances and adjustments outside
      TaskFlow, and keep that record.
- [ ] Run November in TaskFlow alongside the existing process. Compare sample
      employees and team totals before relying on it.
- [ ] Keep October and earlier as they are. Nothing here rewrites them.

**Rollback:** redeploy the previous commit. There is no schema or data change to
undo. Old calendar leave cancelled after deploy stays cancelled (it is audited and
was never in pay). Leave requests created since remain valid with the old code.
