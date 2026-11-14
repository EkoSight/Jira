# My workspace: the plan

The build prompt asks for a personal, configurable home for every employee:
one attention queue, linked records, and private reminders. This plan records
what the code already has, what is missing, and how the gaps are filled.
The full description of the finished feature is in `docs/MY_WORKSPACE.md`.

## What exists and is reused

| Need | Already in TaskFlow | Reused as |
| --- | --- | --- |
| Company overview | `pages/Dashboard.jsx`, `GET /reports/dashboard` (`scopeFor`) | Moves to `/overview` unchanged; also the "Company overview" widget |
| Tasks, deadline health | `tasks`, `shared/deadlineHealth.js`, saved views | My tasks, Deadlines coming up, attention items |
| Task reminders | `task_reminders`, `services/taskReminders.js`, worker `jobs/reminderWorker.js` | The pattern for the new occurrences; the worker runs the new planner and sender |
| CRM follow-up reminders | `services/sales/followupReminders.js`, `crm_reminder_prefs` | Listed in My reminders; unchanged |
| OKR alerts | `jobs/okrScanner.js`, `services/okrInsights.js` | Listed in My reminders; signals feed Key results to check in |
| Google Chat | `chat_outbox`, `services/googleChat.js` | Delivery channel (`WORKSPACE_REMINDER` kind) |
| Bell | `notifications`, `routes/notifications.js`, `Layout.jsx` | Extended with states and a record link |
| Waiting on me | `task_deadline_changes`, `task_blocks` (`APPROVER_SQL`), leave (`leave.approve` + `visibleUserIds`), holiday requests (`holiday.approve`), extra time (`/attendance/review-queue`), quote approvals (`crm_approvals.approver_ids`), handovers (`pendingHandoversFor`), appeals (`blackmark.waive`), standup reviews (`standup.review`) | Needs my decision: each module's own condition |
| Deals | `opportunities`: next step and its task, `next_action_absent_reason`, `waiting_on/until/since`, `revisit_on`, `last_external_at`, handovers, commitments, `dealFlags` | Deals widget, attention items, waiting on others |
| Leads | `crm_leads` with sources, `referral`, assignment history, `logLeadActivity` | Introduced by and last incoming added beside them |
| Work queue, pending calls | `services/sales/workQueue.js`, pending calls endpoint | Leads to work and Calls to describe call the same endpoints, so counts match |
| Meetings | `crm_meetings`, `services/meetings.js`, `routes/meetings.js` | Extended for "to arrange" and internal meetings |
| Settings | `settings.manage` permission | Edits templates and the rollout (no new permission) |
| Timezone | `settings.organisation.timezone` (Asia/Kolkata) | The default when a person has none |

## Gaps and how they are filled

### Part A: home and layouts

- `user_dashboards` (one row per user): `version`, `layout` (JSON, null means
  "follow my template"), `home` (personal opt-in or opt-out), `updated_at`.
  Resetting sets the layout to null and bumps the version; no row is deleted.
- `dashboard_templates`: `key`, `name`, `layout`, `applies_departments`,
  `applies_roles`, `position`, `version`, `updated_by`. Six are seeded:
  everyone, partnerships, callers, managers (role manager), hr (role admin)
  and leadership (role super_admin). Department matches come before roles
  (D3); the partnerships and callers templates get their departments in
  Settings, since the code cannot know them.
- `shared/workspaceWidgets.js`: the registry (type, version, title, module,
  permissions, widths, settings, scopes, drill-down) used by both the server
  (which filters by permission) and the client.
- Rollout (D1): `settings.workspace.rollout = { mode: PILOT | EVERYONE | OFF,
  departmentIds }`. PILOT with no departments chosen changes nobody's home
  until an administrator picks them. Anyone can still open `/workspace` and
  choose "Make this my home"; anyone in the rollout can choose "Use the
  overview as my home".
- Routes: `/` decides between My workspace and today's page; `/overview` is
  today's page; `/workspace` is always My workspace. `/?task=ID` keeps
  working (Layout handles it on every page).

### Part B: attention and decisions

- `services/workspace/attention.js` gathers items from contributors
  (tasks, follow-ups, calls to describe, deals, applications, meetings, key
  results, standup, personal reminders due). Each uses its module's own rule
  (deadline health, `dealFlags`, the OKR analysis, the pending-calls query).
- Tiers as in the prompt (B2), with "Why this order?" in the widget.
- A deal or application whose next step is tracked by a task gives one item,
  linked to both.
- `attention_snoozes` (user, item key, until): personal and private. CRM
  nudge snoozes stay as they are (team-level).
- `services/workspace/decisions.js`: one list from the modules above, each
  with its own permission and condition.

### Part C: reminders and notifications

**Model choice: a sibling table that follows the task engine exactly.**
`task_reminders` needs a task (`task_id NOT NULL`, unique on task, person,
kind, due time and channel). Making it generic would mean relaxing that
column and rebuilding its unique key, which risks the live task reminders.
A sibling, `reminder_occurrences`, copies its design instead:

- unique on `(recipient, entity_type, entity_id, rule_key, occurrence_key,
  schedule_version)`, so a second planner run or a retry adds nothing;
- statuses PENDING, SENDING, SENT, FAILED, CANCELLED, SKIPPED, WOULD_SEND;
- claimed with `FOR UPDATE SKIP LOCKED`, re-checked against the record and the
  recipient's access just before sending;
- one occurrence gives at most one bell notification and one Chat message
  (`chat_outbox`, kind `WORKSPACE_REMINDER`, dedupe key per occurrence);
- run by the existing reminder worker (`jobs/reminderWorker.js`): plan every
  ten minutes, send every minute;
- test mode: `settings.workspace.reminderMode` (OFF, TEST, LIVE; default
  TEST). In TEST only the chosen test recipient receives anything; everyone
  else's occurrences end as "would send". A person's own "remind me" is
  always delivered to them in the app, because it reaches nobody else.

Also in Part C:

- `reminder_rule_prefs` (user, rule, enabled, time, chat): the person's own
  choices.
- `personal_reminders` (user, record, when, note, version, status): "Remind
  me about this".
- `reminder_rule_launches` (rule, launched_at): the launch policy (C7, D7).
  The first planner run for a rule records any occurrence already due as
  SKIPPED "Before launch". Nothing old is sent, and the dashboard shows those
  items.
- `notifications` gains `entity_type`, `entity_id`, `occurrence_id`,
  `reason`, `resolved_at`, `snoozed_until`, `cancelled_at`. Old rows keep
  working: the new columns are null.
- `users.timezone` (D4): null means the company calendar's timezone.
- Existing engines (task reminders, CRM follow-ups, OKR alerts, summaries)
  are unchanged and listed read-only in My reminders, with links to their own
  settings.

### Part D: records

- **Applications:**
  - widen `crm_pipelines.category` with `APPLICATIONS`, keeping both old
    values;
  - seed the "Applications & programmes" pipeline and its eight stages
    (Selected is won; Not selected and Withdrawn are lost);
  - `opportunity_applications` holds what deals lack: type (D2), URL, the
    deadline (a date, or an instant with its timezone), submitted on (only
    from "Mark submitted"), acknowledgement and reference, submitted link,
    expected response, next check date and its source, last substantive
    update;
  - `application_updates` (acknowledgement, follow-up sent, response,
    outcome) and `application_rounds` (own deadline and meeting).
- **CSR proposals:** the deadline rule also covers a CSR / NGO deal's
  `proposal_deadline` (date-only) until a proposal is recorded as sent.
- **Meetings:**
  - widen the status check with TO_ARRANGE and TIME_PROPOSED;
  - add `arrange_by`, `scheduling_owner_id`, `lead_id`, `proposed_at`;
  - allow `scheduled_at` and `account_id` to be empty.

  Justification: a meeting still to be arranged has no time, and an internal
  meeting has no organisation. A new check keeps a time required for every
  other status. Every existing row already has both values, so none changes
  (a test proves it). Joins that assumed an organisation become left joins in
  `services/meetings.js`.
- **Introduced by:** `introduced_by_user_id` / `introduced_by_contact_id` on
  leads and deals. The free-text `referral` stays. Changes are recorded in
  the existing history.
- **Last incoming contact:** `crm_leads.last_incoming_at`, moved only by
  inbound activity in `logLeadActivity`. It is filled once from the inbound
  activities already recorded, and from nothing else.
- **Waiting on others:**
  - deals and applications I own that are marked waiting;
  - open customer commitments;
  - tasks I gave out that are blocked (a recorded block is shown apart from a
    plain Blocked status) or overdue;
  - my own pending requests.

### Part E: rules

| Rule | Record | When (recipient's timezone) | Default |
| --- | --- | --- | --- |
| `APPLICATION_DEADLINE` | application or CSR proposal deadline, and round deadlines | 3 calendar days before, 09:00; at once if added inside the window | on |
| `APPLICATION_DEADLINE_1D` / `_SAME_DAY` | same | 1 day before / on the day, 09:00 | off (opt-in) |
| `APPLICATION_STATUS_CHECK` | submitted application | next check date, else organiser's date, else submitted + 15 days, 09:00 | on |
| `MEETING_TO_ARRANGE` | meeting to arrange or time proposed | arrange-by date, 09:00, to the scheduling owner | on |
| `MEETING_PREP` / `MEETING_START` | confirmed meeting | day before 09:00 / 30 minutes before, to the owner and internal participants | on |
| `DEAL_NEXT_STEP` | deal next step without a task | due date 09:00 (a step with a task is covered by task reminders) | on |
| `DEAL_REVISIT` / `DEAL_WAITING_UNTIL` | deal | that date, 09:00 | on |
| `PERSONAL` | any record I can see | the time I chose | always |

A personal reminder for the same record on the same local day suppresses that
day's rule occurrence, so the person gets one reminder.

## Screens

- **`/` or `/workspace`, My workspace:** header (date, scope, Add, Edit) and
  widgets. In edit mode: catalogue, remove, drag or Move up / Move down,
  width, settings, Save, Cancel, Reset.
- **`/overview`:** today's dashboard.
- **`/workspace/attention`:** the full list (views, snoozes); drill-down
  target for summary counts.
- **`/applications` and `/applications/:id`:** the pipeline's list and
  detail: Mark submitted, Log update, rounds, tasks and meetings.
- **`/meetings`:** confirmed, to arrange, past without outcome.
- **Settings → Workspace** (`settings.manage`): templates, rollout and the
  reminder mode.
- **Settings → My account:** My reminders (rules, channels, personal
  reminders), timezone.
- **Bell:** states, Snooze, Open with access re-checked, Manage my reminder.

## Not in this release

- Email and push for reminders.
- Calendar sync and invitations.
- AI layouts.
- A new permission for templates (it would need the owner's approval).
