# No missed tasks: deadlines, reminders and fair black marks

The plan is in `DEADLINES_REMINDERS_PLAN.md` and the routes are in `API.md`
(sections "Deadline health and saved views" to "Black marks: fairness").
Problem numbers below follow the brief.

## What changed

**One definition of deadline health (problems 1–4, 20, 21)**

- **`shared/deadlineHealth.js`** decides Overdue, Due today, Due soon (working
  days), Upcoming, No deadline, Review due and Deferred.
  - It works in the organisation's time zone, and is used by the server, the
    board, the list, My Tasks, the dashboard and Chat.
  - A task is overdue at its due time (D4). Deferred work is never overdue.
  - Dates and times across the app now show in that time zone too.
- **The task list** returns counts for every matching task, per column, stage
  and health.
  - It has new date filters: today, tomorrow, next 7 or 30 days (overdue left
    out), overdue, no deadline, review due, and a custom range.
  - It can also filter by supporter and sort by longest overdue.
- **The board** keeps its filters in the address, so a link can be copied.
  - Views can be saved, as personal views or shared with a department by its
    manager.
  - Done is collapsed, with its count and a Show button.
  - A notice appears when more cards match than are shown.
- **My Tasks** has two sections, "I own" and "I'm supporting"; supporting
  means followed or tagged, and tagged work used to be missing.
  - Every open task is in exactly one group: Overdue, Today, Upcoming,
    Blocked, Backlog review due, Needs a date, Later, Deferred.
  - Each group links to the board filter that shows the same count.
- **Dashboard tiles** open matching board filters, and their overdue and
  due-soon counts equal the board's.
- **Two bugs found while planning are fixed:**
  - Problem 20: every save from the task dialog counted as a deadline move.
  - Problem 21: an overdue task could not be saved without pushing its
    deadline into the future.

**One reminder engine (problems 6–13)**

- **`task_reminders`** follows the sales follow-up pattern. Planned reminders:
  - 2 hours before the deadline;
  - at the deadline, to the owner;
  - after the grace period, to the reporting manager (or the department's
    managers).

  Each goes to both the bell and Chat. Plans are redone on every change and
  re-checked when they go out, and CRM follow-ups keep their own engine.
- **When nothing is sent:** on days off, holidays (including half days),
  leave, and in quiet hours. The reason is recorded, and anything due while
  the owner is away goes to their fallback person.
- **Failures and stale messages.**
  - A Chat message that fails reaches the fallback person.
  - A queued message about a task that has since been finished, handed over,
    re-dated or deferred is cancelled. This is a new outbox status,
    CANCELLED.
- **Every message carries:**
  - the task ID and title;
  - the owner;
  - the due time in IST;
  - the status and health;
  - the next action;
  - a link.
- **Summaries.**
  - **Personal:** Overdue, Today, Upcoming, Blocked, Review due, Needs a date,
    Supporting, Covering, Needs an owner and decisions waiting, plus counts of
    later and deferred work.
  - **Department:** overdue work by owner, work needing an owner, work due
    today, who is away, who is not connected.
  - **Weekly backlog review.**
  - People Chat cannot reach get their summary in the bell.
  - A missed morning is sent later, marked late, until 18:00, and is otherwise
    recorded as missed.
- **Delivery log.** One row per summary per person per day
  (`reminder_summary_log`).
  - States: queued, sent, failed, skipped (with the reason), bell only,
    acknowledged, and "would send".
  - "Skipped" is never stored as "sent" again. Old rows that were are read as
    skipped.
- **Settings → Reminders** covers:
  - mode (Off, Test, Live) and timing;
  - coverage today;
  - connections;
  - a preview of tomorrow;
  - the delivery log per person;
  - a 14-day audit (read only).

  My account → My reminders shows your own log.
- **The coverage check** runs daily and is stored. It lists every open task
  nobody will hear about today, with the reason: no owner, owner switched off,
  no date, not connected, away, delivery failed, no summary, or nobody to fall
  back on.
- **The old 24-hourly due-soon notice** stops only when an administrator
  switches the engine to Live.

**Deadline changes, deferral, blocks and the overdue review (problem 5)**

- **Every deadline change needs a reason.** Under D1, the owner may move their
  own deadline once, before it passes. Anything else waits for an approver:
  - the reporter (when not the owner);
  - the reporting manager;
  - the department's managers;
  - someone who may edit every task.

  The owner never approves their own. Approvers are told, and decisions are
  recorded with who and why.
- **Defer** records:
  - the reason;
  - the next action;
  - a review date;
  - what the task waits on.

  The deadline is kept and paused, with no reminders and no marks. Resuming
  needs an approved new deadline.
- **Blocks:** the owner records one, an approver accepts it, and it is cleared
  later. An accepted block pauses marks (D3).
- **The overdue review page:** mine, my team's, or all of it. Each task gets a
  new date, blocked, done with evidence, or defer. Everything is previewed
  before it is saved, and decisions waiting for you are listed on the same
  page.
  - **Filters:** project, goal, department and owner always show. "More
    filters" adds supporter, reporter, lead or organisation, deal, tag,
    priority, status, type, how long overdue, and "only with a request or
    block waiting". There is also a search box.
  - **Projects.** TaskFlow has no separate projects, so a project is a task
    with subtasks. Choosing one shows that task and its overdue subtasks.
  - **Counts.** Each choice shows how many tasks it would leave, given the
    other filters and the Mine / My team / All switch. Choices that would
    leave nothing are hidden, unless already chosen.
  - **Grouping and sorting.** The list can be grouped by project, goal,
    department or owner, and sorted oldest first, most recent first or by
    priority.
  - **Sharing.** Filters, grouping and sorting are kept in the address, so a
    filtered list can be shared.
  - **Hidden decisions.** If a filter hides a task you have already decided,
    the page says so; that decision is still previewed and saved.
  - **Each row** shows the task's department, project, goals, organisation and
    tags, so it is clear why it matched.
- **The task dialog** asks why when the deadline moves. Its "Deadline and
  reminders" panel shows the history, waiting decisions, defer, block, resume,
  and every reminder.

**Fair black marks (problems 14–19)**

- **One rule per kind (D2).** The most specific matching rule applies, and
  "delivered late" applies only when there is no missed mark. With the default
  rules, a critical task missed and finished three weeks late cost 5.5 points;
  it now costs 4.
- **The mark goes to whoever owned the task at its effective deadline.** A
  trigger records every owner change. Escalation stops when the task changes
  hands.
- **No marks:** while deferred, while an accepted block covers the deadline,
  or for a deactivated person.
- **Rules apply from when they are saved** (`effective_from`). Earlier work is
  covered only through a preview and an approval that applies exactly what was
  previewed. Existing rules keep applying as before.
- **The person can appeal.** Someone with `blackmark.waive` waives the mark or
  upholds it, with a reason, and never for their own appeal. Everything is in
  the mark's history.
- **The recheck list says why** a mark would not be given today: calendar,
  stacked, delivered late after a miss, wrong owner, deferred, blocked, or
  owner switched off. Nothing is waived automatically.
- **The monthly review** shows tasks missed, mark events and points
  separately.
- **The rules page** says how the rules combine, shows what one late task
  costs before and now, and says "working days" for escalations.

## Email (added 18 November 2026)

Task reminders and the summaries can now go by email as well as in Google Chat
and the TaskFlow bell. The plan and where it differs from the brief are in
`EMAIL_REMINDERS_PLAN.md`.

### Who hears how

The **TaskFlow bell always** carries a task reminder. Chat and email follow a
choice, made in two places:

- **The organisation's defaults**, in **Settings → Reminders → Channels**:
  - **Task reminders** (before, at and after the deadline; covering):
    **Google Chat and email**.
  - **The morning summary and the weekly backlog review**: **Google Chat, or
    email when Chat can't reach me**. They are long; one copy a day is enough.
  - **Notices to managers and covering people by email**: on.
  - **The team summary to each department's managers by email**: off.
  - **Reminder emails a day, per person**: 10.
  - **Send reminders by email**: on. Nothing goes until email is set up
    (Settings → Email) and the mode is Live.
- **Each person's own choice**, in **Settings → My account → My reminders →
  How you hear about your tasks**, for task reminders and for the summaries
  separately:
  - Google Chat and email;
  - Google Chat, or email when Chat can't reach me;
  - Email only;
  - Google Chat only;
  - The TaskFlow bell only.

  The same section shows whether Chat is connected (with the steps) and whether
  their email is reachable, and has **Send me a sample reminder email**. A box,
  "Email me 'all clear' on days with nothing open", is off unless ticked.

Two safety rules:

- **"Email only" falls back to Chat** while email cannot be used (not set up,
  or the address bounced), so nobody loses reminders by choosing it.
- **Someone who switched the Chat morning summary off**, and has not chosen
  anything here, does not start getting it by email. Switching it off meant "no
  summary".

Sales follow-up reminders and the workspace and personal reminders offer email
too (**Email** in the follow-up settings; **Email me** in each reminder row).
Both are **off unless the person turns them on**.

### What each email says

Reminder emails come from the system sender in Settings → Email, the same one
as the account emails. They go only to the person's own **login email**, as it
is when the email goes, never to a contact, lead or customer.

**Subjects:**

| Reminder | Subject |
|---|---|
| Before the deadline | `Due in 2 hours: TF-123 Sample report` |
| At the deadline | `Due now: TF-123 Sample report` |
| To the manager after the grace period | `Overdue, Sample Owner's task: TF-123 Sample report` |
| Covering | `Covering for Sample Owner: TF-123 Sample report` |
| Could not reach the owner | `Could not reach Sample Owner: TF-123 Sample report` |
| Several at once | `3 task reminders: Due now: TF-123 Sample report and 2 more` |
| Test mode | `TEST · ` before any of these |
| The sample | `SAMPLE · Due in …` |
| Morning summary | `Your TaskFlow day: 3 overdue, 2 due today`; with nothing due, `Your TaskFlow day: nothing due today`; asked-for all clear, `Your TaskFlow day: all clear` |
| Weekly backlog review | `Your TaskFlow backlog review for the week` |

**Body:** the same facts as the Chat message, one card per task:

- the reason, for a manager or covering person ("The grace period has passed
  and it is still open…");
- for the manager: `Overdue by 24 hours; owned by Sample Owner.`;
- `Owner: …`, `Due: Wed 18 Nov, 17:00 IST`, `Status: To Do · Due today`,
  `Next action: …`;
- an **Open the task** button, and the link written out.

A summary email has the same sections and links as the Chat summary, and an
**Open My tasks** button.

**Footer:** why they get it ("You get this because you own this task in
TaskFlow.", or "…because you are the fallback person for Sample Owner…"), a
**Change how you get reminders** link to My reminders, and the app name from
Branding. There is **no unsubscribe link and no marketing footer**: these are
work reminders, changed in My reminders. The headers say `Auto-Submitted:
auto-generated`.

### When it is sent

- **The same checks as Chat**, made when it is sent: the mode, quiet hours,
  days off, holidays, leave, "finished, handed over, re-dated or deferred", an
  inactive account, and "more than 12 hours late".
- **Checked again at the last moment.** The email is written when it goes,
  not when it is queued. A task closed in the meantime is left out, and its
  reminder is cancelled with the reason ("The task is done before the email
  went"). An email with nothing left is not sent.
- **"Chat, or email when Chat can't reach me"**: the email is skipped ("Google
  Chat carried it") when Chat reached them.
- **One email, not five.** Reminders for one person that fall due within
  **3 minutes** of the first go as one email listing each task. Each keeps its
  own row in the log. (The brief said 15 minutes; that would hold "Deadline
  now" for a quarter of an hour.) Sales follow-up reminders are not held.
- **The daily limit:** 10 reminder emails a person a day (task, follow-up and
  workspace reminders; summaries do not count). Beyond it: skipped, "Daily
  email limit reached (10); the next morning summary carries it". The bell
  still carries it.
- **Summaries by email** run in the reminder worker, so they go whether or not
  Google Chat is set up. They follow the mode: nothing when Off, only the test
  administrator's in Test, everyone's in Live. They are logged in
  `reminder_summary_log` with `channel = 'EMAIL'`, one row per channel. Every
  older row reads `CHAT`.
- **Retries:** after 1, 5, 30 and 120 minutes, then **failed**. A reminder
  email that failed is followed by a notice to the fallback person, once ("A
  reminder to … could not be delivered by email (…)").

### Bounces

Delivery reports for system emails (`acct-…` and `rem-…`) are handled on
their own. They never become marketing events, figures or contacts, and are
recorded in `system_email_events`.

- **A hard bounce or a spam complaint** marks the address undeliverable, with
  when and why. Reminder emails to it stop. The person and the administrators
  are told in the bell.
- **Soft bounces count:** three in a row count as hard. A delivery resets the
  count. A report about an address the person no longer uses changes nothing.
- **Clearing:** **Team → the person → Edit → Clear the bounce**, once the
  address is fixed. Reminder emails resume. It is recorded in the audit.

### When email or Chat isn't set up

- **Email not set up** (no email service, or no sender in Settings → Email):
  nothing is emailed or queued. An email reminder planned earlier is recorded
  as "Email is not set up (…); the TaskFlow bell carried it". Chat and the bell
  work as before. The coverage check says "Email is not set up, so it reaches
  nobody yet".
- **Chat not connected:** the Chat row says where it went instead ("Not
  connected to Google Chat; email and the TaskFlow bell carried it").
- **The coverage check:**
  - a summary the email service took counts like one Chat delivered ("owner's
    summary by email");
  - new reasons, once email is set up: "The owner's email address bounced" and
    "Reaches nobody: no Chat, no email".
- **Who covers whom:** a person reached by email is no longer counted as
  unreachable, so their fallback person is not told to cover them. While email
  is not set up, this is exactly as before.

### Going live

**Settings → Reminders** now starts with **Before going live**. It shows each
check with its state and where to fix it:

1. Google Chat switched on.
2. A test message sent and received (Settings → Google Chat → Send me a test).
3. People with open work connected to Chat, out of how many.
4. Email set up (Settings → Email).
5. The mode.

**Live stays a deliberate press** by an administrator, after the Test log has
been looked at. Nothing switches it automatically.

On the live site, an administrator:

1. sets up email (`ACCOUNT_EMAILS.md`, "What an administrator must do"), and
   sends a test;
2. checks **Settings → Reminders → Channels** (the defaults are the owner's
   decisions below);
3. in **Connections**, ticks the people not connected and presses **Send them
   the steps by email**;
4. leaves the mode on **Test** for a few days and reads the delivery log ("would
   send" rows, by channel);
5. then chooses **Live**.

### Owner decisions (defaults used)

1. Task reminders by Chat and email for everyone. A person can narrow it.
2. The morning summary by email only to people Chat can't reach, and anyone
   who asks.
3. Manager notices by email: yes.
4. A daily limit of 10 reminder emails a person.
5. Sales follow-ups and personal reminders by email: offered, off.
6. No buttons in Chat in this release.
7. No instant alerts (assigned, comments, mentions) by email.

## Migration and rollback

**Migration 035 is additive** and passes the additive-only guard. It adds:

- new columns on `tasks` (`review_date`, `next_action`, `deferral_id`) and on
  `blackmark_rules` (`effective_from`);
- new tables for deadline changes, blocks, owner history, saved views,
  reminders, the summary log, coverage reports, appeals and backfills;
- a trigger that writes only to `task_owner_changes`, filled from the activity
  log at migration;
- two widened CHECKs on `chat_outbox` (kind and status), each keeping every
  old value.

It changes no existing deadline, status, mark or history row, and creates no
marks.

**Rollback:** deploy the previous version. It ignores the new tables and
columns. The trigger keeps writing owner history, which is harmless.

**After deploying,** the reminder engine starts in test mode. While it is in
test mode, administrators can review the delivery log and the preview of
tomorrow before switching to Live.

**Migration 044 (email) is additive** and passes the same guard. It adds:

- `email_outbox` (reminder and summary emails waiting to go, with what to say,
  not the email), `reminder_channel_prefs` (each person's choice; no row means
  the defaults) and `system_email_events` (delivery reports for system emails);
- `users.email_undeliverable_at`, `email_undeliverable_reason` and
  `email_soft_bounces` (nullable or defaulted);
- `reminder_summary_log.channel` (default `CHAT`, so every existing row keeps
  its meaning), `reminder_rule_prefs.email` (unset means off) and
  `reminder_occurrences.email_outbox_key`;
- widened CHECKs, each keeping every old value: `task_reminders.channel` and
  `crm_followup_reminders.channel` gain `EMAIL`; `reminder_summary_log.status`
  gains `EMAILED`; `account_emails.kind` gains `CHAT_STEPS`.

Nobody gets a reminder email until an administrator has set up email and the
mode is Live (in Test, only the test administrator).

**Rollback:** the previous version ignores the new tables and columns, but it
would treat a pending `EMAIL` reminder as a Chat one and send a second Chat
message. So, **before** deploying the previous version, cancel the pending
email reminders (this changes no other row):

```sql
UPDATE task_reminders SET status = 'CANCELLED', reason = 'Email reminders rolled back', updated_at = now()
 WHERE channel = 'EMAIL' AND status = 'PENDING';
UPDATE crm_followup_reminders SET status = 'CANCELLED', cancel_reason = 'Email reminders rolled back'
 WHERE channel = 'EMAIL' AND status = 'PENDING';
```

## What was tested

- **Server: 631 tests, all passing.** This includes 44 new ones:
  - `tests/deadlines.test.js`: 13 tests (problems 1–4, 20, 21, counts, saved
    views);
  - `tests/taskReminders.test.js`: 15 tests (problems 6–13, test mode, double
    sending, fallback, acknowledgement, CRM follow-ups, coverage, the weekly
    backlog review);
  - `tests/deadlineChanges.test.js`: 8 tests (problem 5, D1, deferral, D3, the
    overdue review and its filters: project, goal, department, person,
    supporter, tag, age, search, the counts on each choice, the scope switch,
    and that a filter never shows work outside your scope);
  - `tests/blackmarkFairness.test.js`: 8 tests (problems 14–19, recheck
    reasons, the three counts).
- **Client: 124 tests, all passing**, including 2 new label tests.
- **Reproduced first.** Problems 20 and 21 were run against the old code and
  failed: "That deadline has already passed", and 3 moves counted for 3
  unchanged saves. For problems 14 and 15, the old behaviour was asserted by
  existing tests, which now expect the new behaviour:
  - "both the general and the critical rule fire" (api.test.js);
  - "finished late" on top of a missed mark (holidays.test.js, which now
    keeps such a mark as a legacy record).

  The other problems' tests were written against the fixed code. They show the
  new behaviour; they were not each run against the old code first.
- **Existing tests changed by design:**
  - Deadline moves in api.test.js now send a reason.
  - Three tests that back-date a deadline mark their rule as having been in
    force for a while.
- **Browser walk-through:** 45 checks, all passing, including 12 for the
  overdue review filters. It used made-up people, a made-up project and made-up
  goals in a separate schema, on desktop and phone, in light and dark, and
  Google Chat was not connected.
- **Accessibility:** axe-core found no violations on 13 screens. Three older
  problems were fixed along the way:
  - the task progress bar's label;
  - the black-marks filters' names;
  - subtask cards, where the "Subtask of …" button sat inside the card's own
    button and could not be reached. It now sits beside it.

## Not verified

- **Real Google Chat delivery.** Tests use a stand-in transport, and the
  walk-through had Chat unconnected, so messages stayed queued.
- **Production.** The live rules, settings and Chat connections were not read.
  The 14-day audit report is built but has not been run there. It is read
  only, and needs your approval to run.
- **Large boards.** The list loads every matching task lightly to count it;
  this has not been tried with thousands of tasks.
- **Two servers sending summaries at the same time.** The keys are unique,
  but only reminders were tested with two senders at once.
- **Real phones.** Phones were checked only in Chromium's iPhone emulation.

## Decisions for you

Answered by the owner on 16 November 2026:

1. **Backlog.** Confirmed: without an approved deferral, Backlog work with a
   deadline still counts for marks.
2. **A second miss after an approved new deadline** is not marked again.
   Confirmed.
3. **Escalation stops when a task changes hands**, and the new owner is not
   marked for an inherited miss. Confirmed.
4. **Personal summaries.** Kept: anyone with open work gets one every working
   day, even if it only says "nothing due soon; N later".
5. **Switching to Live.** Yes, after checking Settings → Reminders in test
   mode; an administrator does this on the live site. The morning summary now
   defaults to **09:00** (was 08:45). A site that already saved its Google Chat
   settings keeps the time it saved, so set 09:00 in Settings → Google Chat →
   Morning summary.
6. **Backfill approval.** No second person: whoever previewed can approve.
7. **Department summary spaces.** Yes: set one per department in Google Chat
   (Settings → Google Chat), or the coverage check keeps listing those
   departments.

## Concerns, not changed

- **Deleting a rule.** `DELETE /blackmarks/rules/:id` deletes the rule; its
  marks keep a copy of the rule but lose the link. Pausing would keep the
  history.
- **Waiving your own marks.** Anyone with `blackmark.waive` can still waive
  their own marks; only appeals stop someone deciding their own.
- **Reassigning.** Everyone has `task.assign`, so anyone can hand any visible
  task to someone just before its deadline. The mark now stays with the owner
  at the deadline, but the commitment still moves.
- **The scan button.** "Run scan now" was described in code as a dry run but
  records marks. The comment is corrected; the behaviour is unchanged.

## Defaults used

| Setting | Default |
|---|---|
| D1 | The owner may move their own deadline once, before it passes, with a reason; anything else needs the reporter or the owner's manager |
| D2 | The most specific matching rule; points never added across overlapping rules |
| D3 | An accepted block pauses marks until it is cleared |
| D4 | Overdue at the due time |
| D5 | In the summary on the day; 2 hours before; at the deadline; to the manager after the grace period (the matching rule's grace, else 24 h) |
| D6 | Quiet hours 20:00–08:30 India time; working days only |
| D7 | Supporters get a section in summaries; never marks |
| D8 | Not on Chat: bell, and listed to the manager and the department |
| D9 | Personal summary 09:00 (owner, 16 Nov 2026; was 08:45), department summary 09:15 |
| Due soon | 3 working days (`workload.dueSoonDays`) |
| Late morning summary | Still sent until 18:00 |
| Coverage check | Stored daily at 11:00 |
| Reminder mode | Test at first, sending only to the administrator who switched it on |
| Fallback person | The reporting manager, then the department's managers (`attendance_team_access`, or managers whose department it is) |
