# My workspace

A personal home for every employee. It shows:

- what needs them now;
- what is next;
- what they are waiting on;
- every open record they own with no next action.

Each person arranges their own home, and nobody else's changes. The request
came from the partnerships and programmes team. It was built company-wide, and
their layout is one of the role templates.

The plan and design choices are in `docs/MY_WORKSPACE_PLAN.md`. The API is in
`docs/API.md` (sections "My workspace" and "Applications").

## Who sees it, and where

- **Home.** People in the rollout land on My workspace at `/`. Everyone else
  keeps today's page there, with an "Open My workspace" link.
- **Your own choice.** Anyone can make either page their home ("Make this my
  home", "Use the overview as my home"), and that choice wins over the
  rollout.
- **Fixed addresses.** Today's company overview is always at `/overview`, and
  My workspace at `/workspace`. `/?task=ID` links still open the task from
  any page.
- **Navigation** changes only for people whose home is My workspace: "My
  workspace" and "Overview" at the top, then Meetings and Applications (with
  CRM access). Board, My tasks, Pipeline and the rest stay as they were.
- **Rollout** (Settings → Workspace, `settings.manage`):
  - a first group of departments (the default, with none chosen, so nobody's
    home changes until an administrator picks them);
  - everyone;
  - or nobody.

## The widgets

Every widget is described once, in `shared/workspaceWidgets.js`, and the
server decides who may use each one:

- a module that must be on (CRM, Goals);
- a permission;
- for Today, whether attendance applies (it does not for super admins).

A widget the person cannot use is never offered. One already in a layout
shows "Not available to you" or "This module is switched off". A retired type
shows "This widget is no longer available", with Remove.

| Widget | Shows | Data from |
| --- | --- | --- |
| Summary | Needs attention, overdue, due today, waiting on others, decisions | `/workspace/widgets/summary` |
| Needs attention | One ordered list from every module (below) | `/workspace/attention` |
| Needs my decision | Approvals waiting on you | `/workspace/decisions` |
| Today | Check-in and today's standup | the attendance and standup endpoints |
| My tasks | Open tasks: mine, supporting, assigned by me, or my team | `/tasks`, with exactly the board's filters |
| Deadlines coming up | The same, with deadlines in the next 3/7/14/30 days | `/tasks` |
| Waiting on others | What you wait for, from whom, since when, the promised date, the next check | `/workspace/waiting` |
| Meetings | Confirmed and coming; separately, those to arrange or with a time proposed | `/workspace/meetings` |
| Applications | Preparing, and submitted and waiting | `/applications` |
| Deals | Open deals; "Overdue" and "No next action" flagged apart | `/workspace/widgets/deals` |
| Leads to work, Follow-ups | The CRM work queue, the same as Sales → My Day | `/sales/work-queue` |
| Calls to describe | Your calls with no outcome yet | `/sales/calls/pending` |
| Key results to check in | Your key results that are quiet or behind | `/workspace/widgets/key_results` |
| Team workload, Company overview | Today's dashboard numbers, with today's scope | `/reports/dashboard` |
| Recognition, My black marks, Pinned notes, Saved view | Your own | their existing endpoints |

**Counts.** Every count comes from the same request as the list its "Open"
link shows:

- a task widget's count is the board's count for the same filters;
- a summary tile's count is the length of the list it opens.

The walk-through checked this for every summary tile.

**States.** Each widget loads on its own and has its own states:

- loading;
- empty, with the action that would fill it;
- error, with Retry;
- not available.

One failing widget never blanks the page.

## Arranging it

Press **Edit**. In edit mode you can:

- add from the catalogue (new types appear under "New", never on their own);
- remove;
- drag, or use Move up and Move down (keyboard; each move is announced);
- switch between full and half width;
- change settings: title, density, rows, date range, sort, scope.

Then press:

- **Save**: confirmed only when the server has saved it;
- **Cancel**: puts the saved layout back;
- **Reset my layout**: back to your team's template. It says that records
  and reminders stay as they are.

A save from an older version than the one stored is refused. The person sees
"Your layout was changed on another device", with two choices:

- **Reload**: shows the newer layout and drops these changes;
- **Keep mine**: replaces the newer layout, after a confirmation.

The layout is kept on the server for each person. This tab keeps a copy only
so the page paints at once, and signing out clears it.

On a phone, widgets stack in their saved order at full width.

## Templates (Settings → Workspace)

A template chooses widgets and their order. It never grants access.

**Which template applies:** the person's department first, then their role,
then "Everyone".

**Seeded templates:**

| Template | Applies to |
| --- | --- |
| Everyone | everyone else |
| Partnerships and programmes | the departments you assign |
| Callers | the departments you assign |
| Managers and department heads | role manager |
| HR and administration | role admin |
| Leadership | role super admin |

**Editing a template:**

- it reaches everyone who has not customised their layout, on their next
  visit;
- people who customised keep their layout, and can choose "Reset my layout"
  to take the new default;
- the table shows how many people follow each template and how many
  customised it.

Editing templates uses the existing `settings.manage` permission. No new
permission was added.

## Needs attention

Each module contributes its items through one shape, using its own rule:

- **tasks:** deadline health; blocked tasks show under Waiting on others
  instead;
- **CRM follow-ups and calls still to describe;**
- **deals:** the next-action rules, waiting until, and revisit;
- **applications:** deadline, status check, and no next action;
- **meetings:** today, to arrange, and no outcome recorded;
- **key results:** the OKR attention engine;
- **today's standup;**
- **decisions;**
- **the person's own "remind me" reminders.**

The order has no hidden score, and "Why this order?" shows it:

1. Fixed deadlines passed or due today, and meetings today.
2. Overdue commitments.
3. Decisions waiting on you.
4. Due in the next 3 days.
5. No next action recorded.
6. Everything else, by date.

**Duplicates.** A deal or application late on a next step its task tracks
shows as one item, linked to both. When the tracked task is done, the item
becomes "Choose the next action". The deal is never closed by this.

**Snooze** hides one item from your own list until a time you choose.

- The record, its dates and its owner do not change.
- The dialog says so, including when the snooze runs past the item's date.
- CRM nudge snoozes (team-wide, with a reason) are separate and unchanged.

**Views:** Today & overdue, Coming up, Overdue, Due today, Decisions, All,
and Including snoozed.

## Needs my decision

Each source keeps its own rule for who decides:

| Source | Who decides |
| --- | --- |
| Deadline changes and blocks | the overdue review's rule |
| Leave | `leave.approve`, for the people they can see |
| Attendance corrections and the review queue | `attendance.approve` / `attendance.extra.review`; the review queue is now one function, shared with its page |
| Holiday changes | `holiday.approve` |
| Quotations | named approvers |
| Deal handovers | the person the deal was handed to |
| Black-mark appeals | `blackmark.waive` |
| Standup follow-ups | `standup.review` |

Note: managers hold `task.edit.any` by role. Under the existing rule, that
already lets them decide any deadline change, not only their reporting
line's, and the list follows that rule. A manager without `task.edit.any`
sees only their reporting line. Narrowing managers by default would be a
permission change, so it is listed as a decision below.

## Applications

Applications are deals in the "Applications & programmes" pipeline.

**Stages:** Considering, Preparing, Submitted (awaiting response), Under
review, Further round, Selected, Not selected, Withdrawn.

**Types:** Grant, Incubation, Acceleration, Challenge, Award, Tender / RFP,
Government scheme, Other.

**Reused from deals:** the organisation (the organising institution),
contacts, owner and collaborators, stages with history, next step, waiting
on, tasks, meetings and activity.

**Added:**

- **The deadline:** either a date, shown as "Closing time not specified" and
  never given a made-up time, or an exact time with its timezone. An exact
  time is shown in the reader's timezone, with the original zone beside it.
- **Mark submitted:** the only way an application becomes submitted, with
  the real date. Correcting the date needs a reason and is recorded.
- **Acknowledgement and reference.**
- **The submitted document or link.**
- **The organiser's response date.**
- **The next check date,** and what set it.
- **The last substantive update.**
- **Rounds:** each keeps its own deadline; the original deadline is never
  overwritten.

**Updates.** An acknowledgement, or a follow-up we sent, is not a decision.
A follow-up sets the next check, 7 days later unless chosen. A response, or
the outcome, ends the status check; after a response the person is asked for
the next action.

**Outcomes.** Selected, Not selected and Withdrawn stop the reminders.
Selected can start an onboarding task. Open tasks are never closed by an
outcome.

**Tasks** added on an application are ordinary tasks. They have the same id
on the application, on the board and in My tasks.

**CSR / NGO proposals.** The CSR / NGO pipeline is unchanged. A CSR deal's
proposal deadline uses the same deadline rule, as a date-only deadline,
until a proposal is recorded as sent.

## Meetings

**New states.** Meetings can now be "To arrange" (with an arrange-by date and
the person arranging it) or "Time proposed".

- Neither is ever shown as a booked meeting.
- Neither ever gets a start reminder.
- Confirming one makes it a booked meeting.

**Internal meetings** need no organisation and no CRM. They are visible only
to their owner, creator, the person arranging them, and the colleagues taking
part.

**Afterwards**, a past meeting with no outcome is listed until someone records
how it went. Only what the person writes is recorded; nothing is read out of
the notes.

**No invitations.** Nothing is sent to anyone, and nothing is added to a
calendar. The screens say so.

**The schema change.** `scheduled_at` and `account_id` may now be empty, which
a meeting to arrange and an internal meeting need. A new check still requires
a time for every other status. Test 27 in `workspaceRecords.test.js`
migrates a database with existing meetings and checks that every column of
every one is unchanged.

## Leads and deals: where they came from

The panel "Where it came from" (on leads and applications) shows these apart:

- the original source and latest source;
- the free-text referral (kept);
- **introduced by**: a colleague or a contact (new, and audited);
- who created it and when;
- the owner now;
- every change of owner, with who made it.

Reassigning never rewrites the source or the record's age.

**Last incoming contact** (new on leads) moves only when the lead reached us.
Our calls, answered or not, never move it. It was filled once, from the
inbound activity already recorded.

**Deals changing hands.** When a deal changes hands, the open tasks and
meetings on it held by someone else are listed. Only the ones the person
ticks are moved. Personal reminders stay with the people who set them.

## Reminders

### Channels

- **The TaskFlow bell,** for everyone.
- **Google Chat,** for people who connected it and kept Chat alerts on.
- **Email and push are not available** for these reminders. The screens say
  so, and nothing claims they were sent.

### The rules

Each rule reaches the record's current owner. Meeting rules also reach the
colleagues taking part, each under their own settings. A rule never reaches
everyone, all supporters, or the person who assigned the work.

The default time is 09:00 in the person's own timezone, and each person can
change it.

| Rule | When | Default |
| --- | --- | --- |
| Application deadline | 3 calendar days before the deadline's date in your timezone, while the submission is outstanding (also round deadlines and CSR proposal deadlines) | on |
| Application deadline, 1 day before / on the day | as named | off; only if you turn it on |
| Check application status | your next check date, else the organiser's response date, else 15 days after the submitted date; only while no substantive update is recorded. It says which date drives it, and there is only ever one | on |
| Meeting still to arrange | the arrange-by date, to the person arranging it | on |
| Meeting tomorrow: prepare | the day before a confirmed meeting | on |
| Meeting starts in 30 minutes | 30 minutes before a confirmed meeting | on |
| Deal next action due | the next action's date, unless a task tracks it (then the task reminders cover it) | on |
| Deal waiting: their date has come | the waiting-until date | on |
| Revisit a deal on hold | the revisit date | on |
| Remind me about this | the time you choose; private to you | always |

**Calendar days, not hours.** A deadline of 29 March 2027, 17:00 London is
21:30 IST. Its 3-day reminder is on 26 March at 09:00 IST, not 72 hours
earlier.

**Added late.** An application added or assigned inside the window gets one
immediate alert with the real time left, for example "1 day left". After the
deadline it gets none, and the list shows "Deadline passed".

**Changes.**

- A new deadline cancels the old reminder.
- Marking an application submitted cancels its deadline reminders, and
  clears the attention item.
- Rescheduling a meeting cancels the old reminders; cancelling a meeting
  cancels them all.
- When the owner changes, the new owner's reminders are planned and the old
  owner's are not sent.

### How a reminder is planned and sent

**Model.** `reminder_occurrences` is a sibling of the task reminder table,
built the same way.

- **One identity.** Each reminder is unique per recipient, record, rule,
  occurrence and version. Planning twice, or retrying, adds nothing.
- **The worker.** The existing reminder worker (`jobs/reminderWorker.js`)
  plans every 10 minutes and sends every minute. Changes to applications and
  meetings re-plan at once. No browser is involved.
- **Checked before sending.** The record is read again, and the person's
  access re-checked, just before each reminder is sent. One that no longer
  applies is cancelled, with the reason.
- **After downtime,** at most one still-relevant reminder per person, record
  and rule is sent. Its moment must not have passed.
- **Pause and leave.** A pause (from the existing reminder preferences),
  leave or a holiday holds a reminder back; My workspace still shows the
  item.
- **Weekly day off.** It does not hold reminders back, because these rules
  count calendar days.
- **Cover while away.** For deals and applications, if the owner chose cover
  while away, the reminder goes to the deal's escalation point while the
  owner is away.
- **Quiet hours.** For time-of-day rules, quiet hours hold a reminder until
  they end. Start-of-meeting and your own reminders are not held.
- **Test mode** (the default). Until an administrator switches workspace
  reminders to Live (Settings → Workspace), only the administrator who chose
  Test receives anything. Everyone else's reminders are recorded as "would
  send". Your own "Remind me" always reaches you, since it reaches nobody
  else.

### The bell

A workspace reminder in the bell shows:

- what to do, and why you got it ("You own this application");
- the record and its date;
- **Open,** with access checked when pressed. A record you can no longer see
  shows "This item is not available to you", with no title.
- **Snooze,** which changes only your bell;
- **Manage my reminder.**

Reading or snoozing completes nothing and moves no date. A reminder whose
reason has gone (submitted, answered, changed) shows as Resolved.

### My reminders (Settings → My account)

- **Every rule,** with its default, your choice, the time, and the channels.
  Turning a rule off cancels only your own pending reminders of that rule.
- **The older engines,** listed with a link to their own settings: task
  deadlines, the morning summary, CRM follow-ups, goal alerts. They are
  unchanged.
- **Your own reminders,** with "Change my reminder" and Remove. Changing your
  reminder never changes the deadline.
- **Your timezone:** empty means the company calendar's.
- **What was sent and planned,** in your timezone.

### Launch policy

Turning this on sends nothing old.

- A rule's first full run (the worker's first sweep) records any reminder
  already due as skipped, "Before launch: shown in My workspace, not sent".
- Only reminders due after launch are sent.
- No launch summary is sent; the dashboard shows the current items.

## Running it

- **The migration.** `server/src/db/migrations/037_my_workspace.sql` is
  additive, and the migration guard test still passes. It runs with the
  others at start-up (AUTO_MIGRATE) or `npm run migrate`. It was not run on
  any live database.
- **The worker.** It starts with the server, as `startReminderWorker` in
  `index.js`; no new process is needed.
- **Server tests** (from `server/`): `npm test`. The workspace tests are:
  - `workspace.test.js`: layouts, templates, rollout, permissions;
  - `workspaceAttention.test.js`: attention, decisions, waiting;
  - `workspaceReminders.test.js`: the engine, notifications, privacy,
    launch;
  - `applications.test.js`: deadlines, submission, status checks, time zones;
  - `workspaceRecords.test.js`: meetings, origin, last incoming, handover.

  Run one with
  `node --env-file=.env.test --test --test-concurrency=1 tests/<file>`.
- **Client tests** (from `client/`): `node --test tests/*.test.js`; see
  `tests/workspace.test.js`.

## Not available in this release

- Email and push reminders.
- Calendar sync, and meeting invitations.
- AI-generated layouts, and user-written widgets.
- A "Today" item for leave or a holiday today. The Today widget shows the
  check-in and the standup only.

## Not verified

- Behaviour in the TaskFlow Android app. The PWA layout was checked at phone
  size in a browser only; the Android app was not built or run.
- Google Chat delivery. Tests use a stand-in that records what it was given,
  and the walk-through ran with Chat switched off.
- Load. Attention is built per request, from each module. It was checked
  with small made-up data sets only, not at the company's real volumes.
- Drag and drop with a mouse. The walk-through used the Move up / Move down
  buttons (keyboard). Drag and drop was built, but was not exercised by the
  automated walk.

## Decisions still open

The defaults D1 to D7 from the build prompt are in use.

- **D1 (rollout):** pilot, with no departments chosen yet.
- **D2 (application types):** as above.
- **D3 (templates):** by department, then role; edited with
  `settings.manage`.
- **D4 (timezone):** a personal timezone was added; it is empty for everyone.
- **D5 (internal meetings):** allowed.
- **D6 (reminder defaults):** as in the table above.
- **D7 (launch):** nothing old is sent.

New questions from the build:

1. **Managers and deadline changes.** Managers can decide any deadline change
   (`task.edit.any`, by role). Should Needs my decision, and the overdue
   review, show only their reporting line? Either way it is a permission
   change, so it waits for the owner.
2. **The weekly day off.** Workspace reminders are sent on a weekly day off,
   because the rules count calendar days. Should they instead wait for the
   next working morning?
