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
| critical priority | +1 |
| finished on or before the deadline | +0.5 |
| finished after the deadline | −0.5 |
| each active black mark point | −1 |
| kudos received | +0.25 each, capped at +2 |

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
