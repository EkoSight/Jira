# No missed tasks: plan

The brief is `the no-missed-tasks prompt` (deadlines, backlog, Google Chat
reminders and fair black marks). Results and the test record go in
`DEADLINES_REMINDERS.md`.

## What exists, and is kept

- **Statuses.** Workflow statuses are custom. Each belongs to a fixed stage
  (backlog, todo, in_progress, blocked, review, done, cancelled). The owner is
  `assignee_id`; the supporters are `follower_id` and `task_collaborators`.
  `original_due_date`, `due_date_changes` and `task_activity` record history.
- **Google Chat.** Three parts are kept: the outbox (dedupe key, retries), the
  morning and department summaries (`services/googleChat.js`), and the instant
  alerts that copy bell notifications to Chat.
- **The sales follow-up reminder engine.** This is
  `services/sales/followupReminders.js`: planned rows, re-planned on change,
  claimed before sending, and honest about why something was not sent. It is
  the model for task reminders. CRM follow-up tasks (`followup_kind` set) keep
  it.
- **Black marks.** Rules, idempotent keys, the owner's calendar (days off,
  holidays, half days, leave), evidence, waive and restore, the recheck list,
  and the monthly review that never touches attendance or pay.

## Two more problems found while planning

These were read from the code. Each will be reproduced in a test first.

20. **Every save from the task dialog counts as a deadline move.** The dialog
    always sends the deadline. The server compares it as text with a date
    object, so the two never match and `due_date_changes` goes up on every
    save.
21. **An overdue task cannot be saved from the dialog unless its deadline is
    moved into the future.** Both the dialog and the server refuse a deadline
    that has passed, even when it is unchanged. People are pushed into moving
    deadlines, which feeds problem 5.

## What changes

**Step 1: one definition, matching counts (problems 1–4, 20, 21)**

- **`shared/deadlineHealth.js`** gives one definition in the organisation's
  time zone:
  - the health: Overdue, Due today, Due soon (working days), Upcoming,
    No deadline, Review due, Deferred;
  - the date ranges for filters.

  The server, board, list, My Tasks, dashboard and Chat all use it.
- **The task list:**
  - takes `due=` (today, tomorrow, next7, next30, overdue, none, review,
    range with `due_from` and `due_to`), `supporter_id`, `exclude_stage` and
    `sort=overdue_age`;
  - returns the total and the per-status counts for the whole filtered set,
    not just the rows sent.
- **The board:**
  - date, stage, owner, supporter, department and priority filters, all kept in
    the URL;
  - saved views, which can be personal or shared with a department by its
    manager;
  - Done collapsed, with its count;
  - a warning when more cards match than are shown.
- **My Tasks.** Two sections, "I own" and "I'm supporting" (followed and
  tagged). The groups are:
  - Overdue, Today, Upcoming (7 days), Blocked, Backlog review due,
    Needs a date;
  - Later and Deferred, shown collapsed.

  The groups don't overlap: Blocked takes every blocked task, whatever its
  deadline. Each group links to the board filter that gives the same count.
- **Deadline edits.** Only a real change counts as a move, and an unchanged
  past deadline no longer blocks saving other fields.

**Step 2: one reminder engine, summaries and the coverage check
(problems 6–13)**

- **`task_reminders`**, following the follow-up pattern. One row per task,
  person, moment and channel:
  - 2 hours before the deadline (D5);
  - at the deadline, to the owner;
  - after the grace period, to the fallback person.

  Plans are redone when a task is finished, reassigned, deferred, re-dated or
  blocked, when leave is approved, or when someone is deactivated. Pending
  rows that no longer fit are cancelled.
- **When reminders are not sent.** Working days only. Nothing goes on holidays,
  during the person's leave or half day off, or in quiet hours (D6). Anything
  that falls then is skipped with the reason and picked up by the next morning
  summary. Something urgent while the owner is away goes to their fallback
  person.
- **The fallback person** is the owner's reporting manager, then the managers
  of the task's department. If there is nobody, the coverage check lists it.
- **Every message carries:**
  - the task ID and title;
  - the owner;
  - the due date and time with the time zone;
  - the status and deadline health;
  - the next action;
  - a link.
- **The personal summary:**
  - sections: Overdue, Today, Upcoming (3 working days), Blocked, Review due,
    Needs a date, Supporting, and Covering (for fallback people);
  - a final line counting later work.

  It skips holidays, leave and the person's own days off.
- **The department summary:**
  - overdue work, grouped by owner;
  - work that needs an owner;
  - work due today;
  - who is away;
  - who is not connected.
- **The weekly backlog review** goes out on the first working day of the week.
- **A missed morning is made up** the same day, marked late.
- **`reminder_summary_log`** records one row per recipient per summary:
  queued, sent, failed or skipped, each with a reason. "Skipped" is never
  stored as "sent", and old rows are read correctly.
- **The connections page:**
  - who is connected;
  - who is not;
  - whose last message failed;
  - departments with no summary space;
  - a test to yourself.
- **The delivery log**, for each recipient and each reminder: queued, sent,
  failed, skipped and acknowledged. Acknowledged means opening the task from
  the link, or "Got it".
- **The coverage check** runs daily and is stored. It answers "which open
  tasks will nobody hear about today?", listing every exception with its
  reason.
- **Test mode is the starting state** (`reminders.mode`). Messages go only to
  the administrator who switched it on, and everything else is logged as
  "would send". The old 24-hour due-soon insert stops only when an
  administrator switches the engine to live.
- **A read-only audit report** covers 14 days of delivery for each recipient.

**Step 3: deadline changes, deferral, blocks, the overdue review screen
(problem 5)**

- **Every deadline change needs a reason**, and follows D1. A change that needs
  approval leaves the deadline as it is until someone approves it.
- **The approvers** are the reporter (if they are not the owner), the owner's
  reporting manager, the managers of the task's department, and anyone with
  `task.edit.any`. Never the owner.
- **Defer** records:
  - the reason;
  - the next action;
  - the review date;
  - any dependency;
  - the previous status and deadline.

  It is approved the same way. The original deadline is kept, and the task
  shows Deferred and later Review due, never Overdue.
- **Block (D3).** The owner records what is blocking the task. An approver
  accepts the block, and it clears when the work can go on.
- **The overdue review screen.** Owners see their own overdue tasks and
  approvers see their scope. For each task they choose a new date, blocked,
  done with evidence, or defer. Bulk choices are allowed, every change is
  previewed, and every change is audited.

**Step 4: fair black marks (problems 14–19)**

- **Precedence (D2).** The most specific matching missed-deadline rule gives
  the task's one missed mark. "Delivered late" only applies when there is no
  missed mark.
- **The mark belongs to whoever owned the task at the effective deadline.**
  - **Owner history.** It comes from `task_owner_changes`, which a trigger
    fills on every owner change, backed by the existing activity history.
  - **Escalation.** It stops once the task changes hands; the new owner gets
    it on the overdue review screen instead.
- **No marks:**
  - while a deferral or extension is approved;
  - while an accepted block covers the deadline;
  - for deactivated people.
- **Rules apply from a date onwards** (`effective_from`). Applying a rule to
  past tasks needs a preview and an approval, both recorded. Existing rules
  keep their history, and the migration creates and changes no marks.
- **The recheck list says why** a mark would not be given today: stacked,
  delivered late after a miss, wrong owner, deferred, or blocked. Someone
  waives it by hand; nothing is waived automatically.
- **Appeals.** The person appeals, and someone with `blackmark.waive` upholds
  it or waives the mark, with reasons.
- **The counts are kept apart:** tasks missed, mark events, and points.
- **The escalation rule** says "working days" on screen.
- **The live rules** are documented with worked examples. This is a read-only
  report.

## Data model (migration 035, additive)

| New | What it holds |
|---|---|
| `tasks.review_date`, `tasks.next_action`, `tasks.deferral_id` | The review date for Backlog or deferred work, the next step, and the active deferral |
| `task_deadline_changes` | Every requested re-dating or deferral: who, why, from, to, status, and who decided |
| `task_blocks` | What blocks a task, who accepted it, and when it cleared |
| `task_owner_changes` (+ trigger) | Who owned a task when; backfilled from the activity history |
| `task_saved_views` | Saved board filters: personal, or shared with a department |
| `task_reminders` | Every planned reminder and what happened to it |
| `reminder_summary_log` | Each summary, for each recipient and day, with its status and reason |
| `coverage_reports` | The daily coverage check, with its exceptions |
| `blackmark_rules.effective_from` | The date a rule applies from (null means as before) |
| `black_mark_appeals` | Appeals and their decisions |
| `blackmark_backfills` | Each preview and approval to apply a rule to past tasks |
| `chat_outbox` kinds | Adds TASK_REMINDER and BACKLOG_WEEKLY, keeping every existing kind |

**Rollback.** Deploy the previous version. It ignores the new tables and
columns. The trigger only writes to `task_owner_changes`. Nothing existing is
changed or deleted.

## Decisions

The brief's defaults D1–D9 are used. Points I had to interpret:

- **Backlog.** Backlog without an approved deferral still keeps its deadline,
  so marks can apply, and it shows on the overdue review screen. Otherwise,
  moving a card to Backlog would be a way round the deferral record.
- **Blocked** pauses marks only when the block has been accepted (D3).
- **A second miss after an approved extension** is not marked again; one missed
  mark per task, as today. This can be revisited.
- **CRM follow-up tasks** keep their own reminders and their own reschedule
  flow. D1 and the general engine leave them alone.
- **The personal summary** goes every working day to anyone with open work, so
  every open task is mentioned, even if only in the "later" count. Switching it
  off makes the person "not reachable in Chat" for the fallback.
- **The manager notice after grace** uses the grace period of the rule that
  would apply (D2), or 24 hours if no rule does.
