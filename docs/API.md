# TaskFlow API

Base path: `API_PREFIX`, default `/api/taskflow`.

All routes except `GET /health` and `POST /auth/login` require
`Authorization: Bearer <token>`, or a host-supplied session when
`TRUST_HOST_AUTH=true`.

Errors come back as `{ "error": "...", "details": [...] }` with a matching status
code — 400 validation, 401 signed out, 403 not permitted, 404 missing, 409
duplicate.

---

## Auth

| Method | Route | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | `{ email, password }` → `{ token, user }` |
| GET | `/auth/me` | signed in | Current user with effective permissions |
| POST | `/auth/change-password` | signed in | `{ currentPassword, newPassword }`, returns a fresh token |

---

## Tasks

| Method | Route | Permission |
|---|---|---|
| GET | `/tasks` | view scope applies |
| GET | `/tasks/mine` | signed in |
| GET | `/tasks/:id` | view scope applies |
| POST | `/tasks` | `task.create` |
| PATCH | `/tasks/:id` | `task.edit.any` or `task.edit.own` |
| POST | `/tasks/:id/move` | as above |
| DELETE | `/tasks/:id` | `task.delete` (archives; `?permanent=true` deletes) |
| POST | `/tasks/:id/restore` | `task.delete` |
| POST | `/tasks/:id/comments` | `task.comment` |
| DELETE | `/tasks/:taskId/comments/:commentId` | author, or `task.edit.any` |
| POST | `/tasks/:id/checklist` | edit access |
| PATCH | `/tasks/:taskId/checklist/:itemId` | edit access |
| DELETE | `/tasks/:taskId/checklist/:itemId` | edit access |
| POST | `/tasks/:id/attachments/link` | task access — `{ url, title }` |
| POST | `/tasks/:id/attachments/upload` | task access — multipart `file` |
| GET | `/tasks/:taskId/attachments/:id/raw` | task access — streams the file |
| DELETE | `/tasks/:taskId/attachments/:id` | uploader, or `task.edit.any` |
| POST | `/tasks/:id/collaborators` | task access — `{ user_id }` |
| DELETE | `/tasks/:taskId/collaborators/:userId` | task access |

**Visibility.** Holders of `task.view.all` see everything. Otherwise a caller sees
tasks where they are the **owner** (`assignee_id`), the **follower**
(`follower_id`), the reporter or the creator, plus everything in their own
department — **and any card they have been tagged on**, whatever department it
belongs to. Tagging is what lets someone from another team follow a task.

**Two people on a task.** `assignee_id` is the accountable owner and is who a
missed-deadline black mark is recorded against. `follower_id` is a second person
who can see and edit the card but carries no deadline accountability.

**Sub tasks.** Set `parent_task_id` to make a card a sub task of another. The
parent's `effective_progress` becomes the average of its children (a child in a
`done` stage counts as 100), so a parent can never report more progress than its
children justify. `subtask_total` and `subtask_done` come back on every task row.

**Attachments.** Links are validated: only `http` and `https` are accepted, and
the provider (`google-docs`, `google-sheets`, `google-slides`, `google-drive`, …)
is detected from the URL. Uploads are written to `UPLOAD_DIR` on disk, never into
the database, with a random stored filename; the original name is kept only as a
label. Files are streamed back through the API so the same task permissions apply
— they are not publicly served.

**List filters** (query string, all optional):

`department_id`, `status_id`, `stage`, `priority` (comma separated),
`assignee_id` (or `none`), `task_type`, `tag`, `search`, `overdue=true`,
`due_within_days`, `open=true`, `archived=true`,
`sort` (`position` | `due_date` | `priority` | `created` | `updated`), `limit`.

**Create / update body:**

```json
{
  "title": "Raise PO for enclosure batch",
  "description": "500 units, compare three vendors",
  "department_id": 13,
  "status_id": 2,
  "priority": "high",
  "task_type": "procurement",
  "assignee_id": 7,
  "due_date": "2026-08-14T17:00:00.000Z",
  "estimate_hours": 6,
  "progress": 0,
  "tags": ["vendor", "q3"]
}
```

Moving a card into a `done` stage stamps `completed_at` and sets progress to 100;
moving it back out clears both and records a `reopened` activity entry, which is
what a `task_reopened` black mark rule keys off. Changing `due_date` increments
`due_date_changes` and preserves `original_due_date`, so repeatedly pushing a
deadline is visible at review time.

---

## People

| Method | Route | Permission |
|---|---|---|
| GET | `/users` | `user.view` |
| GET | `/users/:id` | `user.view` |
| POST | `/users` | `user.create` |
| PATCH | `/users/:id` | `user.edit` |
| POST | `/users/:id/reset-password` | `user.edit` |
| DELETE | `/users/:id` | `user.delete` (deactivates, never deletes) |
| GET | `/users/permissions/catalogue` | signed in |

Creating a member without a password returns `temporary_password` once — it is
never retrievable again. Assigning the `admin` role, or any permission override,
additionally requires `user.permissions`. The last active admin cannot be demoted
or deactivated.

Both user routes now also return `away_today` — today's leave entry, or `null`.

---

## Availability (leave)

| Method | Route | Permission |
|---|---|---|
| GET | `/availability?from=&to=&user_id=&department_id=` | signed in — everyone's, so work can be planned |
| GET | `/availability/summary?days=14` | signed in — away today, upcoming, and your own |
| GET | `/availability/on?date=YYYY-MM-DD` or `?at=<ISO instant>` | signed in — `{ away: { userId: entry } }` |
| GET | `/availability/check?user_id=&due=<ISO instant>` | signed in — the warning before assigning |
| POST | `/availability` | yourself; `user.edit` to record it for someone else — `UNAVAILABLE` only |
| PATCH | `/availability/:id` | the person, or `user.edit` — planning entries only |
| DELETE | `/availability/:id` | the person, or `user.edit` (cancels; the row is kept) — not for a leave request's copy |

Statuses are `ON_LEAVE`, `HALF_DAY` (one date, with `day_part` `MORNING` or
`AFTERNOON`) and `UNAVAILABLE`. "Available" is never stored — it is any day with
no entry.

**Leave has one lifecycle (November 2026).** `ON_LEAVE` and `HALF_DAY` entries
are written only by approving a leave request (`POST /leave`, then
`/leave/:id/decide`), which checks approval rights and payroll locks. Each entry
says where it came from in `source`:

- `LEAVE_REQUEST` — the calendar copy of an approved request (`leave_request_id`).
  `PATCH`/`DELETE` answer 409 `MANAGED_BY_LEAVE_REQUEST`; change or cancel the request.
- `LEGACY_LEAVE` — leave marked on the calendar before requests existed. It never
  reached attendance or pay. It cannot be edited (409 `USE_LEAVE_REQUEST`); it can
  be cancelled (audited as `LEGACY_LEAVE_CANCELLED`) unless that month's payroll is
  approved or locked for the person (409 `PAYROLL_LOCKED`).
- `PLANNING` — `UNAVAILABLE`: away but not on leave (travel, training, field work).

`POST /availability` with `ON_LEAVE` or `HALF_DAY`, or a `PATCH` turning an entry
into one, answers 409 `USE_LEAVE_REQUEST`. `npm run leave:reconcile` (server)
prints a read-only dry run of `LEGACY_LEAVE` rows for review. Dates are calendar days in `settings.organisation.timezone`
(default `Asia/Kolkata`), so a deadline is checked against the date it falls on in
India, not on the server's clock. Entries for one person may not overlap.

There is no reason field on purpose: the team can read every entry, and a reason
is often private. `note` is what the person chooses to share.

`POST /tasks` and `PATCH /tasks/:id` return `availability_warning` when the owner
is away on the deadline or for part of the run-up to it. It never blocks the
save. Creating an `UNAVAILABLE` entry, and approving a leave request
(`/leave/:id/decide`), return `tasks_due_during`, and whoever assigned those tasks
is notified once.

## Attendance

Check In / Start Work and Check Out / End Work. Separate from signing in: login,
refresh, a second device or logout never creates, closes or moves a record.
Times are the **server's** clock, stored in UTC; work dates are calendar dates in
the policy timezone (default `Asia/Kolkata`). Durations are integer seconds.

| Method | Route | Permission |
|---|---|---|
| GET | `/attendance/privacy` | signed in — the location notice text |
| GET | `/attendance/today` | own — policy summary, gate, session, open/overnight session, today's computed day, missing check-outs |
| POST | `/attendance/check-in` | own — `{ request_id, location: { latitude, longitude, accuracy, timestamp } }` |
| POST | `/attendance/check-out` | own — same body; completes the open session, even after midnight before the cutoff |
| GET | `/attendance/me?month=YYYY-MM` | own — day-by-day ledger, totals, allocations, sessions with coordinates |
| GET | `/attendance/people/:id?month=` | that person's authorised viewer |
| GET | `/attendance/sessions/:id/location` | own, or `attendance.location` + authorised for the person (logged as `LOCATION_VIEWED`) |
| GET | `/attendance/team/today?date=&department_id=` | `attendance.team` or `attendance.all`, scoped |
| GET | `/attendance/team/month?month=` | as above |
| GET | `/attendance/export.csv?from=&to=&user_id=&department_id=&include_location=1` | own; team/all scoped; coordinates only with `attendance.location` |
| GET/POST | `/attendance/corrections` (`?scope=team&status=PENDING`) | own requests; `attendance.approve` for the team queue |
| POST | `/attendance/corrections/:id/decide` | `attendance.approve`, authorised, never one's own — `{ decision: APPROVED|REJECTED, note }` |
| POST | `/attendance/corrections/:id/cancel` | the requester, while pending |
| POST | `/attendance/reviews/day` | `attendance.approve` — `{ user_id, work_date, decision: UNAPPROVED_ABSENCE|CLEAR, note }` |
| POST | `/attendance/reviews/extra` | `attendance.extra.review` — one item or `{ items: [...] }`; an item is `{ user_id, work_date, status: ELIGIBLE|REJECTED, eligible_seconds?, reason?, part?: ALL|BEFORE_START }` |
| GET | `/attendance/review-queue?month=` | `attendance.approve` or `attendance.extra.review` |
| GET | `/attendance/policy` | signed in (payroll part only for `attendance.policy`) |
| POST / PATCH | `/attendance/policy`, `/attendance/policy/:id` | `attendance.policy` — new version from a date / edit an unused version (clears acceptance) |
| POST | `/attendance/policy/:id/accept` | `attendance.policy` |
| GET/POST/DELETE | `/attendance/holidays` | read: signed in; change: `attendance.policy` |
| GET / PUT | `/attendance/profiles`, `/attendance/profiles/:userId` | `attendance.policy` (read also `attendance.all`, `payroll.view`) |
| GET / PUT | `/attendance/team-access`, `/attendance/team-access/:managerId` | `attendance.policy` |
| GET | `/attendance/audit?user_id=&entity_type=` | `attendance.all`, `payroll.view` or `attendance.policy` |

**Idempotency.** Every check-in/out carries a `request_id`. The same id returns
the first result unchanged (`replayed: true`); another device finds the open
session (`already: true`). The database allows one session per person per work
date and one open session per person, so simultaneous requests cannot create two.

**Location.** The body carries `{ latitude, longitude, accuracy, timestamp,
age_ms, method }`. Ranges are validated and an all-zero point is refused;
everything else is accepted and, where doubtful, flagged for a reviewer rather
than turned away: `LOW_ACCURACY` (worse than `lowAccuracyMeters`),
`ACCURACY_UNKNOWN`, `STALE_READING` (the device-measured `age_ms` is over
`locationMaxAgeSeconds`) and `NETWORK_LOCATION` (a Wi-Fi/cell fix after GPS gave
nothing). Freshness is judged by `age_ms`, measured on the device against its own
clock, so a phone whose clock is wrong is not refused; the device `timestamp` is
never compared with the server clock. `check_in_location_at` is the server time
less that age. No location is ever invented; there is no geofence and no address
lookup.

The client reads the position progressively: it watches high-accuracy (GPS)
readings for `locationTimeoutSeconds`, takes the first fix within 50 m at once,
otherwise uses the best fix seen by the deadline, and only if GPS produced nothing
asks for a network fix for a further 10 s.

**Missing check-out.** An open session becomes `MISSING_CHECKOUT` once the next
day's cutoff (default 04:00) passes. No time is guessed — a correction supplies it.

**Time outside office hours.** Every day carries `early_arrival` (seconds checked
in before office hours began, flagged `EARLY_ARRIVAL`) whatever the policy says.
Extra time `E_recorded` is `E_after` (after office hours) plus `E_before` (the early
arrival, only where the day's policy has `creditBeforeStart`; the day says so in
`counts_before_start`). Both are treated alike: counted automatically when the
policy's `extraRequiresReview` is false (the default since 12 October 2026), or
held for a reviewer when it is true. A session longer than `maxSessionHours` is
always held. `/attendance/review-queue` returns `policy: { extra_requires_review,
max_session_hours }` so a screen can say which applies. `/attendance/reviews/extra`
can be posted for any day at any time, including to mark time that counted
automatically as not counted (`REJECTED` needs a reason). A review records whether
it covered time before office hours (`extra_review.covers_before_start`); one
made before early time counted decided only `E_after`, and the early part waits
for its own decision. The review queue marks such a day `pending_part:
"BEFORE_START"` with the `earlier_review`, and posting `part: "BEFORE_START"`
decides only that part: the stored decision is rebuilt so the earlier one keeps
exactly what it counted or refused. Queue items also carry `extra_pending`,
`extra_before`, `extra_after` and `early_arrival`.

Month responses (`/attendance/me`, `/people/:id`, `/team/month`, and the payroll
person view) add `outside_hours: { early_arrival, early_days, extra_before,
extra_after }`, kept outside `totals` so a month already submitted reads exactly
as before. `/team/today` counts add `early`. The day CSV's *Extra after hours*
column is time after office hours only, and two columns are added at the end:
*Arrived early by* and *Extra before hours*. The payroll CSV adds *Days arrived
before office hours*, *Extra before office hours* and *Extra after office hours*
at the end (blank for months locked before they were recorded).

**The check-in requirement.** Off until the policy has a `startDate`. After it,
on a scheduled working day, a person who must record attendance and has no
session and no approved full-day leave gets `403 { details: { code:
"ATTENDANCE_REQUIRED" } }` on any write to `/tasks`, `/threads`, `/objectives`,
`/key-results`, `/accounts`, `/opportunities`, `/meetings`, `/engagements` and
`/resources`. Reads stay open, and `/attendance`, `/leave`, `/auth` and settings
are never blocked.

## Leave requests

| Method | Route | Permission |
|---|---|---|
| GET | `/leave/meta` | signed in — categories, notice hours, allowance mode, email note |
| GET | `/leave/mine` | own |
| GET | `/leave/balance?month=&user_id=` | own, or authorised viewer |
| GET | `/leave/preview?start=&end=&day_part=` | own — scheduled working days the range uses |
| GET | `/leave/team?status=pending` | `leave.approve`, `attendance.team` or `attendance.all`, scoped |
| POST | `/leave` | own; `leave.approve` to record for a team member — `{ category, start_date, end_date, day_part, reason, is_emergency, emergency_explanation, notified_user_id, email_reference, claimed_notified_at, draft }` |
| POST | `/leave/:id/submit` | the requester, from `DRAFT` |
| POST | `/leave/:id/decide` | `leave.approve`, authorised, never one's own — `{ decision: APPROVED_PAID|APPROVED_UNPAID|REJECTED, note }` |
| POST | `/leave/:id/cancel` | the requester before it starts; an approver with a reason |

Notice is measured from when TaskFlow received the request; less than
`leave.noticeHours` (48) makes it `NOTICE_EXCEPTION`, and emergencies go to
`EMERGENCY_REVIEW`. A claimed earlier email is shown to the reviewer as a claim
and never backdates the record. Approving as paid draws on each month's
allowance day by day (half-day steps); anything beyond it is unpaid and the
response says so. Approval adds an entry to the shared team calendar
(`/availability`); cancelling removes it. TaskFlow sends no email
(`email.sent: false`).

Eligibility (November 2026): when the policy starts the allowance after joining
(`leave.eligibility: JOINED_BEFORE_MONTH`) and no joining date is recorded,
`/leave/balance` returns `eligibility: "UNKNOWN"`, `provisional: true` and
`allowance`/`left` as `null` — never a definite number. Approving such leave as
paid answers 409 `ELIGIBILITY_UNKNOWN` until the date is recorded; approving it
as unpaid, rejecting it and statutory leave are unaffected. Each month's
allowance follows the policy in force on that month's first day.

## Payroll estimate

All routes need `payroll.view`. An estimate for payroll — TaskFlow pays nobody
and calculates no tax, PF or ESI.

| Method | Route | Permission |
|---|---|---|
| GET | `/payroll/:month` | everyone's month: stage, setup gaps, blockers, totals, money; `excluded` lists who is not in the month and why |
| GET | `/payroll/:month/readiness` | what stands between the month and a reliable payroll: each gap, its count, who, and where it is fixed. Reads only |
| GET | `/payroll/:month/people/:userId` | one person: every day, allocations, segments, versions |
| POST | `/payroll/:month/people/:userId/submit` · `/return` | `payroll.manage` |
| POST | `/payroll/:month/people/:userId/approve` · `/lock` | `payroll.approve`, never one's own pay |
| POST | `/payroll/:month/people/:userId/reopen` | `payroll.reopen`, with a reason; the locked version is kept as `SUPERSEDED` |
| POST | `/payroll/:month/bulk` | as the action — `{ action, user_ids, reason }` |

Who is in a month: everyone whose employment (work-profile joining and exit
dates) overlaps it, plus anyone with a saved result for it — not "active today".
A deactivated leaver stays in the months they worked; a future joiner is not in
earlier months. Missing dates are setup exceptions, never guesses.

Each transition body may carry `expected: { status, version }` — what the caller
was looking at. If the month has moved on, the answer is 409 `STALE_STATE`;
repeating a call that already took effect, by the same person, returns
`replayed: true` instead of acting twice. Transitions for one person-month run one
at a time. Approve and lock re-run every readiness check (setup, policy
acceptance, blockers), not only the figures: 409 `NOT_READY` when anything is
missing, 409 `CHANGED_SINCE_SUBMIT` when the figures or the applying policy
version changed.
| GET | `/payroll/:month/export.csv` | `payroll.manage` — locked snapshots only; no coordinates, no leave reasons |
| GET / POST | `/payroll/salary/:userId` | read `payroll.view`; add `payroll.salary.edit` (effective-dated, never overwritten) |

A month can be submitted only when it is `READY`: the policy versions it used
are accepted, breaks and the salary method are confirmed, the start date is set
and the month began on or after it, the joining date and salary are recorded,
the month has ended, and no day is unresolved. Approve and lock re-run the
calculation and refuse (`CHANGED_SINCE_SUBMIT`) if anything changed after
submission. Approved or locked months refuse new corrections, reviews, leave
decisions and salary amounts until reopened.

CSV text cells starting with `= + - @`, tab or carriage return are prefixed with
`'` so spreadsheets show them as text.

## B2B pipeline — progress tracking

The rules behind these are in `docs/PIPELINE_PROGRESS.md`.

| Method | Route | Permission | Notes |
|---|---|---|---|
| GET | `/opportunities/board` | signed in | One card per live deal, any kind of organization. Filters: `owner_id`, `next_owner_id`, `department_id`, `segment_id`, `account_type`, `state`, `search`, `mine=true` |
| GET | `/opportunities/stage-rules` | signed in | The evidence rules a stage can carry, with their wording |
| POST | `/opportunities/:id/next-action` | works on the deal | `{ next_step, next_step_owner_id, next_step_due, reason? }` — all three required, date not past |
| POST | `/opportunities/:id/stage` | `crm.activity.log` + works on the deal | Also takes `next_step`, `next_step_owner_id`, `next_step_due`, `proposal {sent_on, amount?, title?, link?}`, `order {kind, reference?, received_on, amount?, link?}`, `override_reason` (pipeline managers) |
| POST | `/opportunities/:id/collaborators` | works on the deal | `{ user_id, role? }` |
| DELETE | `/opportunities/:id/collaborators/:userId` | works on the deal | |
| GET | `/opportunities/:id/handovers` | signed in | |
| GET | `/opportunities/handovers/mine` | signed in | Handovers waiting for the caller to confirm |
| POST | `/opportunities/handovers/:id/acknowledge` | the person handed to, or `crm.manage.any` | |
| GET | `/opportunities/:id/commercial` | signed in | Proposals, orders, invoices, payments and totals |
| POST | `/opportunities/:id/proposals` | `crm.activity.log` + works on the deal | Sets the proposed value when it has an amount |
| POST | `/opportunities/:id/proposals/:proposalId/status` | as above | `{ status: SENT\|ACCEPTED\|DECLINED\|SUPERSEDED\|WITHDRAWN }` |
| POST | `/opportunities/:id/orders` | as above | Needs `reference` or `link`; fills a blank agreed value |
| POST | `/opportunities/:id/orders/:orderId/cancel` | as above | `{ reason }` — kept, not deleted |
| POST | `/opportunities/:id/invoices` | as above | `amount` required |
| POST | `/opportunities/:id/invoices/:invoiceId/cancel` | as above | `{ reason }` |
| POST | `/opportunities/:id/payments` | as above | `amount` > 0, `received_on` not in the future |
| POST | `/opportunities/:id/payments/:paymentId/void` | as above | `{ reason }` |
| GET | `/tasks/:id/completion-context` | view scope | What finishing this task should ask: `deal_task`, `deals`, `requires_next_step` |
| POST | `/tasks/:id/progress` | edit access | `{ note, evidence_url? }` — the task stays open |

"Works on the deal" means: its owner, the relationship owner, its creator, whoever
owes its next action, its escalation point, someone named as helping, or
`crm.manage.any`. Changing who **owns** a deal, or archiving it, is limited to the
owner, the relationship owner, the creator and `crm.manage.any`.

**Changes that need a reason** (`reason` in the body, kept on the history): the
owner of a deal that already had one; an estimated, proposed or agreed value that
was already set (on the deal, or the organization's "expected value").

**Finishing deal work.** Moving a task linked to an organization or deal into a
done stage (`PATCH /tasks/:id` with `status_id`, or `POST /tasks/:id/move`) also
takes `outcome_status` (`ACHIEVED` | `NOT_ACHIEVED`), `outcome_evidence_url`,
`confirm_intent`, and `next_step { opportunity_id?, text, owner_id, due }`. A task
can name its deal with `opportunity_id` (its organization is filled in).

**Activities** take `direction` `OUTBOUND` | `INBOUND` | `INTERNAL`; a next step
logged with an activity needs `next_step_due` and sets the deal's next action
(owner: `next_step_owner_id`, else whoever owes it now, else the deal owner).
`opportunity_id: null` logs it against the organization with no deal.

**Error codes** (in `details.code` of a 400):

| Code | Meaning | Also in `details` |
|---|---|---|
| `NEXT_ACTION_REQUIRED` | A live stage, or finishing this task, needs a complete next action | `gaps`, or `opportunity_id` |
| `NEXT_ACTION_INVALID` | The next action given is missing a part, dated in the past, or clears a live deal's | |
| `STAGE_EVIDENCE_REQUIRED` | The move lacks evidence the stage asks for | `missing [{rule, label, hint, phase, stage}]`, `can_override` |
| `OUTCOME_REQUIRED` | Deal work finished without an outcome, or without saying whether it achieved what was asked | `field` |
| `OUTCOME_READS_AS_PLAN` | The outcome reads like a plan; record progress or send `confirm_intent: true` | `field` |
| `REASON_REQUIRED` | An owner or value change that needs a reason | `field` |
| `REVISIT_REQUIRED` | On hold or Nurture needs `revisit_on` — not past, within 180 days | |
| `REVIEW_INCOMPLETE` | A weekly review was sent without an answer for every live deal | `missing [{opportunity_id, name, missing}]` |
| `MEETING_OUTCOME_REQUIRED` | A past calendar event was confirmed without `took_place: true` and an `outcome` | |

---

## B2B pipeline — the week

The rules are in `docs/PIPELINE_PROGRESS.md` (phase 2). Every route here needs
`crm.view` and the B2B module switched on.

| Method | Route | Permission | Notes |
|---|---|---|---|
| POST | `/opportunities/:id/waiting` | `crm.activity.log` + works on the deal | `{ waiting_on: CUSTOMER\|THIRD_PARTY\|INTERNAL, reason, until, owner_id? }` — live deals only; `until` not past, within 180 days. The next action becomes "Check back: …" due `until` |
| DELETE | `/opportunities/:id/waiting?reason=` | as above | Ends the wait (also ends by itself when the customer responds) |
| POST | `/opportunities/:id/status` | as above | `ON_HOLD` / `NURTURE` now need `reason` and `revisit_on` |
| GET | `/opportunities/:id/commitments` | signed in | What the customer committed to on this deal |
| POST | `/opportunities/:id/commitments` | `crm.activity.log` + works on the deal | `{ what, due_on?, contact_id? }` |
| POST | `/opportunities/commitments/:id/resolve` | as above | `{ status: KEPT\|MISSED\|WITHDRAWN, note? }` — once; never deleted |
| PATCH | `/accounts/stages/:id` | `crm.stages.manage` | Also `quiet_after_days` (1–365, or `null` for the default) |
| PATCH | `/threads/:id/blocker` | whoever may close the blocker | `{ blocked_item?, dependency?, external_party?, responsible_user_id?, expected_resolution?, note? }` — the change is noted in the thread; a new responsible person is told |
| GET | `/crm/week?start=` | signed in | The week containing `start` (Monday–Sunday, India). `stored: true` once written down; `running: true` while in progress |
| GET | `/crm/weeks` | signed in | Weeks on the record, newest first, with their summaries |
| POST | `/crm/weeks/snapshot` | `crm.manage.any` | `{ start }` — writes down an ended week now; never overwrites one already written |
| GET | `/crm/reviews/mine?start=` | signed in | My deals for the week: the record's outcomes, my logged activity, my answers |
| PUT | `/crm/reviews/mine/items/:opportunityId?start=` | `crm.activity.log` | `{ what_changed?, no_change?, evidence_url?, next_milestone?, next_milestone_due?, help_needed?, help_from_user_id? }` |
| POST | `/crm/reviews/mine/submit?start=` | `crm.activity.log` | `{ summary? }` — needs every live deal answered; tells anyone asked for help |
| GET | `/crm/reviews/team?start=&department_id=` | `crm.manage.any` or `report.view` | Everyone's reviews; unsent answers are withheld |
| POST | `/crm/import/email` | `crm.activity.log` | `{ raw, account_id? }` — a raw email (`.eml` or "show original"); returns a suggestion or `skipped` (`already_logged`, `already_suggested`) |
| POST | `/crm/import/calendar` | `crm.activity.log` | `{ raw, account_id? }` — an `.ics` file; returns counts |
| GET | `/crm/suggestions` | signed in | My pending suggestions |
| POST | `/crm/suggestions/:id/confirm` | `crm.activity.log`, mine only | `{ account_id?, opportunity_id?, direction?, took_place?, outcome?, commitment?, next_step?, next_step_owner_id?, next_step_due? }` |
| POST | `/crm/suggestions/:id/dismiss` | mine only | |
| GET / PUT | `/crm/mailbox-sync` | signed in | `{ gmail_enabled?, calendar_enabled? }` — only once an admin allows it (`crm.mailboxSync.enabled`) |
| POST | `/crm/mailbox-sync/run` | `crm.activity.log` | Reads my Gmail / Calendar now |

**Blockers** (`POST /threads` with `kind: "blocker"`) also need `blocked_item`,
`dependency` (`INTERNAL` | `EXTERNAL`), `external_party` (when external),
`responsible_user_id` and `expected_resolution`. Categories now include
`SAMPLE_VALIDATION`, `PRICING_APPROVAL`, `FUNDING` and `PROCUREMENT`.

**Activities** also take `commitment { what, due_on? }`: something the customer
said they would do, recorded with the activity.

---

## B2B pipeline — reporting and controls

The rules are in `docs/PIPELINE_PROGRESS.md` (phase 3). Every route here needs
`crm.view` and the B2B module switched on.

| Method | Route | Permission | Notes |
|---|---|---|---|
| GET | `/crm/data-quality?mine=&owner_id=&department_id=&task_days=` | signed in | Every check with its count and items (`entity_type`, `entity_id`, `account_id`, `opportunity_id`, `title`, `detail`, `owner_name`) and `summary.clean_percent` |
| POST | `/crm/data-quality/duplicates/dismiss` | `crm.manage.any` | `{ account_ids: [a, b], reason }` — kept apart from then on; audited. Nothing is merged |
| GET | `/crm/workload?department_id=` | signed in | Per person: `due {overdue, today, this_week, later, undated}`, `blocked`, `away_today`, `leave_ahead`, `capacity`, `moved_forward_this_week`; and `escalations` |
| POST | `/opportunities/:id/escalate` | `crm.activity.log` + works on the deal, or `crm.manage.any` | `{ reason, to_user_id? }` — to the deal's escalation point unless someone is named; once a day per person; on the history |
| GET | `/crm/investor-summary?from=&to=&anonymise=true` | `crm.manage.any` or `report.view` | Verified figures, open pipeline by supported stage (proposed and estimate apart), customers, exclusions, definitions. No contact details or staff names |
| GET | `/crm/investor-summary.csv` | as above | The same as rows; the download is recorded on the audit trail |
| POST | `/crm/investor-summary/printed` | as above | `{ from, to, anonymise }` — records a print on the audit trail |
| GET | `/crm/audit?group=&actor_id=&account_id=&opportunity_id=&from=&to=&search=&limit=&offset=` | `crm.manage.any` or `report.view` | `group`: `stage`, `status`, `owner`, `value`, `close_date`, `next_action`, `escalation`, `other`. Entries carry `no_reason`, `without_evidence`, `moved_back` |
| GET | `/crm/audit.csv` | as above | Up to 1000 rows |
| GET / PUT | `/crm/reminders/mine` | signed in | `{ digest_time: "HH:MM", digest_days: [1..7], paused_until?, pause_reason?, cover_while_away? }` — a pause is at most 30 days and needs a reason; GET also returns the defaults and recent reminders |

**Archiving** — `DELETE /opportunities/:id` and `DELETE /accounts/:id` take an
optional `reason` (body or `?reason=`); both are recorded.

**Workload status** (`/reports/workload`, `/reports/dashboard`) can now be
`unknown`: open work not all estimated, with nothing measured showing the person
busy. `load_basis` can be `hours_partial` (only the estimated part counted, as a
floor); rows carry `unestimated_tasks`.

**History tables are append-only:** `opportunity_history`,
`crm_ownership_history`, `crm_audit_events` and `pipeline_snapshots` refuse
`UPDATE` and `DELETE`.

---

## Google Chat

| Method | Route | Permission |
|---|---|---|
| POST | `/integrations/google-chat/events` | **Google only** — no TaskFlow login; every request must carry a bearer token Google signed for this endpoint (401 otherwise) |
| GET | `/chat/me` | signed in — `{ configured, linked, preferences: { instant, morning_summary } }` |
| PUT | `/chat/me/preferences` | signed in — `{ instant?, morning_summary? }` |
| POST | `/chat/me/test` | signed in — sends a test message to your own Chat |
| GET | `/chat/admin` | `settings.manage` — service account email (never the key), endpoint URL, spaces, who is connected, last 7 days, failures |
| PATCH | `/chat/admin/spaces/:id` | `settings.manage` — `{ department_id, team_summary }` |
| POST | `/chat/admin/retry` | `settings.manage` — retries failed messages from the last two days |
| POST | `/chat/admin/sync` | `settings.manage` — finds chats an admin install opened and connects them now (also runs at start-up and hourly) |

Settings key `googleChat`: `{ enabled, morningSummaryTime, teamSummaryTime, alertTypes }`.
Off until an admin enables it. New notifications of the chosen types become direct
messages to people who have added the app. The first run starts from the newest
notification, so history is never replayed. Messages go through `chat_outbox` and
are retried after 1, 5, 30 and 120 minutes. A space Google reports as gone stops
being used. Leave reasons, coordinates and pay are never sent.

---

## Email marketing

Staff routes are under `/marketing`, behind sign-in, the attendance check,
`settings.marketing.enabled` and `marketing.view`; changes ask their own
permission. See `docs/EMAIL_MARKETING.md` for how the module works.

| Method | Route | Permission |
|---|---|---|
| GET | `/marketing/overview` | view — last 30 days, approvals waiting, deadlines, health |
| GET | `/marketing/meta` | view — field catalogue, operators, triggers, block types, audiences, topics, what the caller can do |
| GET | `/marketing/contacts` | view — `?search&audience_id&tag&status&segment_id&limit&offset` |
| POST | `/marketing/contacts` | manage — `{ email, first_name, …, tags, custom, audience_ids, basis }`; `basis` required with audiences; an existing address is updated, never duplicated (200 vs 201) |
| GET | `/marketing/contacts/:id` | view — contact, memberships, topics, consent record, emails, events, follow-ups, suppression |
| PATCH | `/marketing/contacts/:id` | manage — refuses an address another contact has |
| POST | `/marketing/contacts/:id/archive` | manage — `{ archived }` |
| POST | `/marketing/contacts/:id/audiences` | manage — `{ audience_id, basis }`; returns `SUPPRESSED` / `KEPT_UNSUBSCRIBED` for people who said stop |
| DELETE | `/marketing/contacts/:id/audiences/:audienceId` | manage — removes (archives) without recording an unsubscribe |
| POST | `/marketing/contacts/:id/unsubscribe` | manage — `{ audience_id \| all, reason }`: the person asked a colleague |
| PUT | `/marketing/contacts/:id/topics` | manage — `{ choices: { topicId: bool } }` |
| POST | `/marketing/contacts/:id/notes` | manage |
| POST | `/marketing/contacts/tags` | manage — `{ ids, add, remove }` |
| POST | `/marketing/contacts/import/preview` | manage — body is the CSV (`text/csv`, ≤15 MB): header, suggested mapping, sample |
| POST | `/marketing/contacts/import` | manage — CSV body; `?audience_id&status&basis&tags&mode&filename&mapping` |
| GET | `/marketing/contacts/export.csv` | export |
| GET | `/marketing/imports`, `/marketing/tags`, `/marketing/fields` | view |
| POST, PATCH | `/marketing/fields[/:id]` | manage — a field's key never changes |
| GET, POST, PATCH | `/marketing/audiences[/:id]` | view / manage — a CRM sync rule (`crm_sync`) needs settings |
| GET | `/marketing/audiences/:id/members` | view |
| GET, POST, PATCH | `/marketing/topics[/:id]`, `/marketing/segments[/:id]` | view / manage |
| POST | `/marketing/segments/preview` | view — `{ rules, audience_id }` → count and sample |
| GET, POST, PATCH | `/marketing/forms[/:id]`; GET `/marketing/forms/:id/embed` | view / manage |
| GET, POST, PATCH | `/marketing/templates[/:id]` | view / manage — `{ name, category, description, subject: {en,hi}, preheader: {en,hi}, design, is_archived }`; starters are read-only. The list returns `{ starters, saved, categories }` |
| GET | `/marketing/templates/:id/preview?lang=`, `/marketing/templates/starters/:key/preview?lang=` | view — `{ html, text }` for a sample reader |
| GET | `/marketing/templates/:id/export`, `/marketing/templates/starters/:key/export` | view — a `taskflow.email-template` JSON file |
| POST | `/marketing/templates/starters/:key/copy` | manage — `{ name? }` → the copy |
| POST | `/marketing/templates/upload?filename=&name=&category=` | manage — body is the file (`application/octet-stream`, ≤8 MB): HTML or a TaskFlow export → `{ template, report: { notes: [{ tone, text }], … } }` |
| POST | `/marketing/design-check` | view — `{ design, subject?, subject_hi?, languages? }` → `{ problems, warnings }`, the brand and sending checks |
| GET, POST | `/marketing/assets` | view / manage — POST body is the image (`image/*`, ≤2 MB, `?filename`) |
| POST | `/marketing/preview` | view — `{ design, subject, preheader, lang, contact_id }` → `{ html, text }` |
| POST | `/marketing/test` | manage — a test of any design to ≤10 addresses |
| GET, POST | `/marketing/campaigns` | view / manage |
| GET, PATCH | `/marketing/campaigns/:id` | view / manage — content can't change once sending; a change after review returns it to draft |
| GET | `/marketing/campaigns/:id/checks` | view — problems, warnings, recipients now, sender |
| POST | `/marketing/campaigns/:id/preview`, `/test` | view / manage |
| POST | `/marketing/campaigns/:id/submit` | manage |
| POST | `/marketing/campaigns/:id/approve`, `/request-changes` | approve — not the person who submitted it (unless Settings allow) |
| POST | `/marketing/campaigns/:id/schedule` | send — `{ at, strategy: NOW \| SCHEDULED \| OPTIMIZED }`; approved, unchanged campaigns only |
| POST | `/marketing/campaigns/:id/unschedule`, `/pause`, `/resume`, `/cancel`, `/finish-test`, `/retry-failed` | send |
| POST | `/marketing/campaigns/:id/duplicate`, `/archive` | manage |
| GET | `/marketing/campaigns/:id/report` | view |
| GET | `/marketing/campaigns/:id/recipients.csv`, `/events.csv` | export |
| GET | `/marketing/calendar` | view — `?from&to` (dates) |
| GET, POST, PATCH | `/marketing/automations[/:id]` | view / manage — an active automation's path can't change |
| POST | `/marketing/automations/:id/submit` | manage |
| POST | `/marketing/automations/:id/approve` | approve |
| POST | `/marketing/automations/:id/status` | send — `{ status: ACTIVE \| PAUSED \| ARCHIVED \| DRAFT }`; ACTIVE needs the approved version |
| POST | `/marketing/automations/:id/enroll` | send — `{ contact_ids }` |
| GET | `/marketing/automations/:id/enrollments` | view |
| GET | `/marketing/festivals`; POST, PATCH `/marketing/festivals[/:id]` | view; settings to add, move or confirm dates |
| GET | `/marketing/followups`, `/marketing/reports/audiences` | view |
| POST | `/marketing/messages/:id/events` | manage — `{ type: REPLY \| CONVERSION, value, note }` recorded by hand, once |
| POST | `/marketing/ai` | manage — `{ task, text, context, language }`; 30 a person per 10 minutes; 400 when `ANTHROPIC_API_KEY` is not set |
| GET | `/marketing/settings` | view — settings, provider status (never a credential), webhook addresses |
| PUT | `/marketing/settings` | settings — partial; nested groups are merged |
| POST | `/marketing/settings/dns-check`, `/sync-crm`, `/sync-replies`; `/marketing/worker/run` | settings |
| GET | `/marketing/suppressions`; `/suppressions.csv`, `/consents.csv` | view; export |
| POST | `/marketing/suppressions` | settings — block an address |
| DELETE | `/marketing/suppressions/:email?note=` | settings — only blocks added by staff or for repeated soft bounces; never unsubscribes, hard bounces or complaints (403) |
| GET, DELETE | `/marketing/dev/outbox`; POST `/marketing/dev/simulate` | settings — only outside production with no provider set (404 otherwise) |

### Public addresses (no sign-in), under `/m`

| Method | Route | What |
|---|---|---|
| GET | `/m/o/:token.gif` | open tracking image |
| GET | `/m/c/:token/:linkId` | click redirect — only to a link in that email; adds UTM tags and `tf_ref` |
| GET | `/m/u/:token` | preference page (lists, topics, language, unsubscribe) |
| POST | `/m/u/:token` | `action=save \| unsubscribe_audience \| unsubscribe_all` (form post) |
| POST | `/m/u/:token/one-click` | RFC 8058 one-click unsubscribe; a GET only redirects to the page |
| GET | `/m/confirm/:token` | double opt-in confirmation |
| GET, POST | `/m/f/:publicId` | hosted signup form / submission (form post or JSON) |
| GET | `/m/a/:publicId/:name` | an image used in emails |
| GET | `/m/brand/:file` | the Soil Doctor images every email loads: `lockup-ink.png`, `lockup-paper.png`, `mark-96.png`, `mark-192.png`, `dot.png`, `pulse.png`, `watermark.png` |
| POST | `/m/webhooks/ses` | SNS notifications; signature verified; only `AWS_SES_SNS_TOPIC_ARN` |
| POST | `/m/webhooks/brevo/:secret` | Brevo events; secret must equal `EMAIL_WEBHOOK_SECRET` |
| POST | `/m/inbound/:key` | replies from an inbound mail service; key must equal `MARKETING_INBOUND_KEY` |
| POST | `/m/conversions` | website conversions; header `X-TaskFlow-Key: <MARKETING_CONVERSION_KEY>` |

Settings key `marketing`: `{ enabled, company, postalAddress, defaultFromName,
defaultFromEmail, defaultReplyTo, replyPlusAddressing, senders, sendingDomain,
dkimSelectors, approvals: { required, allowSelfApproval }, limits:
{ perContactPerDay, perContactPerWeek, ratePerMinute }, followUps: { dueDays,
departmentId }, crmSync: { enabled }, replies: { enabled, mailbox, lookbackDays },
softBounceLimit, sto: { defaultHour }, timezone }`.

---

## Structure

| Method | Route | Permission |
|---|---|---|
| GET | `/departments` | signed in |
| POST | `/departments` | `department.manage` |
| PATCH | `/departments/:id` | `department.manage` |
| DELETE | `/departments/:id` | `department.manage` (deactivates if it holds cards) |
| GET | `/statuses` | signed in |
| POST | `/statuses` | `workflow.manage` |
| PATCH | `/statuses/:id` | `workflow.manage` |
| POST | `/statuses/reorder` | `workflow.manage` — `{ order: [id, ...] }` |
| DELETE | `/statuses/:id?move_to=<id>` | `workflow.manage` |

Each status maps to one fixed **stage**: `backlog`, `todo`, `in_progress`,
`blocked`, `review`, `done`, `cancelled`. Name and colour are yours; the stage is
what the dashboard counts, so "Awaiting parts" on the `blocked` stage is counted
as blocked no matter what you call it.

---

## Black marks

| Method | Route | Permission |
|---|---|---|
| GET | `/blackmarks` | `blackmark.view` (own record only without `report.view` / `blackmark.waive`) |
| POST | `/blackmarks` | `blackmark.create` |
| POST | `/blackmarks/:id/waive` | `blackmark.waive` |
| POST | `/blackmarks/:id/restore` | `blackmark.waive` |
| GET | `/blackmarks/review` | `blackmark.view` |
| GET | `/blackmarks/rules` | `blackmark.view` |
| POST | `/blackmarks/rules` | `blackmark.rules` |
| PATCH | `/blackmarks/rules/:id` | `blackmark.rules` |
| DELETE | `/blackmarks/rules/:id` | `blackmark.rules` |
| POST | `/blackmarks/scan` | `blackmark.rules` |

### Rule shape

```json
{
  "name": "Missed deadline on a critical task",
  "trigger_type": "deadline_missed",
  "points": 2,
  "grace_hours": 4,
  "priorities": ["critical", "high"],
  "department_ids": [1, 2],
  "repeat_every_days": null,
  "max_points_per_task": null,
  "severity": "high",
  "is_active": true
}
```

| Trigger | Fires when |
|---|---|
| `deadline_missed` | The due date plus grace passes and the task is not done |
| `completed_late` | The task is finished, but after the due date plus grace |
| `overdue_escalation` | Every `repeat_every_days` while the task stays overdue, up to `max_points_per_task` |
| `task_reopened` | A task marked done is moved back out of a done status |
| `manual` | Never automatically — raised by hand |

Empty `priorities` or `department_ids` means "applies to everything".

Marks are de-duplicated by an occurrence key, so scanning repeatedly never double
counts. `POST /blackmarks/scan` is therefore safe to call at any time; it also
runs automatically every `SCANNER_INTERVAL_MINUTES` and whenever a card is
completed.

### Review response

`GET /blackmarks/review?month=2026-07&department_id=3`

```json
{
  "period": { "start": "...", "end": "...", "months": 1 },
  "thresholds": { "missedDeadlineLimit": 3, "warningPoints": 3, "criticalPoints": 6 },
  "members": [
    {
      "user_id": 4,
      "full_name": "Priya Nair",
      "department": "Marketing",
      "missed_deadlines": 4,
      "mark_count": 5,
      "waived_count": 1,
      "total_points": 6,
      "over_limit": true,
      "severity": "critical"
    }
  ],
  "flagged": [ "…members over the limit or at critical severity…" ]
}
```

---

## Reporting

| Method | Route | Notes |
|---|---|---|
| GET | `/reports/dashboard` | Everything the dashboard needs in one call |
| GET | `/reports/workload` | Per-person load, capacity and state |
| GET | `/reports/throughput` | Created vs completed per day |

Callers without `report.view` are scoped to their own tasks automatically, and the
team workload block comes back empty.

`workload` states: `idle` (no open work), `available`, `busy` (≥70% of capacity),
`overloaded` (at or above the configured percentage), `stalled` (holds open work
but nothing has moved for `idleDays`).

---

## Settings

| Method | Route | Permission |
|---|---|---|
| GET | `/settings` | signed in |
| PUT | `/settings/:key` | `settings.manage` — body `{ "value": { … } }` |

Keys: `blackmarks`, `workload`, `taskTypes`, `organisation`. Updates are merged
into the defaults, so you can send a single field.

---

## Notes (private)

| Method | Route | Permission |
|---|---|---|
| GET | `/notes` | `note.use` — only ever your own |
| POST | `/notes` | `note.use` |
| PATCH | `/notes/:id` | owner only |
| DELETE | `/notes/:id` | owner only |

Every query is scoped to the signed-in user. There is no route by which one person
can read another's notes, and an admin is not an exception.

---

## Feature requests

| Method | Route | Permission |
|---|---|---|
| GET | `/feature-requests` | signed in |
| POST | `/feature-requests` | `feature.request` |
| POST | `/feature-requests/:id/vote` | signed in — toggles |
| PATCH | `/feature-requests/:id` | `feature.manage` — status and admin reply |
| DELETE | `/feature-requests/:id` | author, or `feature.manage` |

Raising a request notifies every admin and manager; a status change notifies the
person who asked.

---

## Recognition

| Method | Route | Permission |
|---|---|---|
| GET | `/recognition/leaderboard` | signed in |
| GET | `/recognition/awards` | signed in |
| POST | `/recognition/awards` | `recognition.manage` |
| DELETE | `/recognition/awards/:id` | `recognition.manage` |
| GET | `/recognition/kudos` | signed in |
| POST | `/recognition/kudos` | `kudos.give` |

**Scoring**, per completed task in the month:

| | |
|---|---|
| each completed task | +1 |
| high priority | +0.5 |
| critical priority | +0.5 — the same as high |
| finished on or before the deadline | +0.5 |
| finished after the deadline | −0.5 |
| each active black mark point | −1 |
| kudos received | +0.25 each, capped at +2 |

Critical and high earn the same so that choosing a priority never changes what a
task pays; the label only says how urgent it is. Months before September 2026 are
still scored by the earlier rule (critical +1), so a month already ranked does not
re-order itself; `rule` in the response is `equal_priority` or `critical_double`
to say which applied. Awards keep the score they were given either way.

The weights come back in the response as `weights`, so the UI can explain the
number to the person being measured. Awarding the same person twice in a month
updates the citation instead of creating a duplicate.

---

## Notifications

| Method | Route |
|---|---|
| GET | `/notifications` |
| POST | `/notifications/read` — `{ ids: [...] }`, or empty to mark all read |

Generated on assignment, being made a follower, being tagged, new comments,
approaching deadlines, black marks, kudos, awards and feature request updates.
The client polls every 30 seconds and plays a chime plus a desktop notification
for anything new.
