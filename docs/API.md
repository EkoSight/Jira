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
| POST | `/availability` | yourself; `user.edit` to record it for someone else |
| PATCH | `/availability/:id` | the person, or `user.edit` |
| DELETE | `/availability/:id` | the person, or `user.edit` (cancels; the row is kept) |

Statuses are `ON_LEAVE`, `HALF_DAY` (one date, with `day_part` `MORNING` or
`AFTERNOON`) and `UNAVAILABLE`. "Available" is never stored — it is any day with
no entry. Dates are calendar days in `settings.organisation.timezone`
(default `Asia/Kolkata`), so a deadline is checked against the date it falls on in
India, not on the server's clock. Entries for one person may not overlap.

There is no reason field on purpose: the team can read every entry, and a reason
is often private. `note` is what the person chooses to share.

`POST /tasks` and `PATCH /tasks/:id` return `availability_warning` when the owner
is away on the deadline or for part of the run-up to it. It never blocks the
save. Creating leave returns `tasks_due_during`, and whoever assigned those tasks
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
| POST | `/attendance/reviews/extra` | `attendance.extra.review` — one item or `{ items: [...] }` |
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

**Location.** Latitude/longitude ranges are validated, accuracy must be positive,
and a reading older than `locationMaxAgeSeconds` (or more than 5 minutes ahead of
the server) is refused with `LOCATION_STALE`. A reading less accurate than
`lowAccuracyMeters` is accepted and flagged `LOW_ACCURACY`. No location is ever
invented; there is no geofence and no address lookup.

**Missing check-out.** An open session becomes `MISSING_CHECKOUT` once the next
day's cutoff (default 04:00) passes. No time is guessed — a correction supplies it.

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

## Payroll estimate

All routes need `payroll.view`. An estimate for payroll — TaskFlow pays nobody
and calculates no tax, PF or ESI.

| Method | Route | Permission |
|---|---|---|
| GET | `/payroll/:month` | everyone's month: stage, setup gaps, blockers, totals, money |
| GET | `/payroll/:month/people/:userId` | one person: every day, allocations, segments, versions |
| POST | `/payroll/:month/people/:userId/submit` · `/return` | `payroll.manage` |
| POST | `/payroll/:month/people/:userId/approve` · `/lock` | `payroll.approve`, never one's own pay |
| POST | `/payroll/:month/people/:userId/reopen` | `payroll.reopen`, with a reason; the locked version is kept as `SUPERSEDED` |
| POST | `/payroll/:month/bulk` | as the action — `{ action, user_ids, reason }` |
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

Settings key `googleChat`: `{ enabled, morningSummaryTime, teamSummaryTime, alertTypes }`.
Off until an admin enables it. New notifications of the chosen types become direct
messages to people who have added the app. The first run starts from the newest
notification, so history is never replayed. Messages go through `chat_outbox` and
are retried after 1, 5, 30 and 120 minutes. A space Google reports as gone stops
being used. Leave reasons, coordinates and pay are never sent.

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
