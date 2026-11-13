# Sales CRM — calls, locations and follow-ups: what changed and how it was tested

The findings and the plan are in `SALES_CRM_CALLS_PLAN.md`. This document
covers what was built, how it was tested, what is still unverified, and the
decisions left for an administrator.

**The production database was not touched.** Lead 692 and lead 693 were not
read: neither the live server nor a copy of its data was available here.
Everything below was tested on throwaway databases, with made-up people and
leads. No message went outside: Chat messages stopped in the outbox table, and
no customer was messaged.

## For the people calling

- **One way to record a call on a lead:**
  1. **Call.** The button opens the phone's dialler. It records nothing by
     itself.
  2. **Choose how it went.**
  3. **Write what was said.**
  4. **Book the next step.**

  The separate "Log call" button is gone from leads. It stays on
  organisations and deals.
- **Saving:**
  - Save is disabled while it works, and the page says
    "Call #123 saved at 13 Nov 2026, 5:15:42 pm IST as Busy".
  - The form then clears, so it never looks unsaved after saving.
  - If a call-back was due, saving closes it, linked to the call.
- **Leaving with something unsaved** (a chosen outcome or a typed note) asks
  first. In My Day, closing the call box asks too.
- **"What is the difference?"** under the form explains three things:
  - the call outcome: what happened on this call;
  - the lead stage: where the lead stands;
  - the deal stage: where a sale stands.

  A call never marks a lead won or creates revenue by itself.
- **Calls tab on each lead:** every call shows its number, the time to the
  second, who made it, the outcome, the length and the note.
  - **Open** shows the whole call: how it was recorded, every correction
    (with what it said before) and the follow-ups it answered.
  - **Correct the note or length** changes that call. It never adds a call or
    changes a count.
  - The Calls tab of the Sales CRM page shows the same call numbers and times.
- **Location section** in New lead and Edit, no longer under "More details":
  - state (from the list of 36 states and union territories, or "Not known");
  - district (it suggests districts already recorded for that state, and
    accepts a new one);
  - city, town or village;
  - block or tehsil;
  - two address lines;
  - PIN code, checked for shape only: six digits, not starting with 0.

  Anything missing shows "Not provided".
- **My Day** is one queue, worked from the top:
  1. overdue follow-ups;
  2. due later today;
  3. try again now;
  4. new and not called yet;
  5. no next step;
  6. unassigned (for people who assign);
  7. gone quiet.

  Each group shows its count and pages 25 at a time, so nothing stops at 50.
  "Open in Leads" shows exactly the same leads. Each row shows the owner, the
  place, the last contact, the next step with its exact time and "Due now" or
  "Overdue", and the latest note, marked "Imported" when it came from an
  import. From a row you can call, say how it went, or move the follow-up,
  without leaving My Day. Follow-ups on organisations and deals are listed
  below the queue.
- **Reminders:**
  - Settings → My account sets your usual reminders: any of 30, 15, 10 and 5
    minutes before, in TaskFlow and, if an administrator allows it, in Google
    Chat.
  - Each follow-up can have its own choice.
  - A follow-up shows its time with the time zone, and the state of each of
    its reminders (planned, sent, not sent and why, cancelled or skipped).
  - Opening a reminder takes you to the lead and marks the reminder as seen.

## For administrators

- **Sales CRM settings → Follow-up reminders & daily summary:**
  - whether Chat reminders are allowed;
  - the daily summary: on or off, test mode, the time, a latest time after
    which a late day is skipped rather than sent late, working days, and
    skipping holidays, weekly days off and approved full-day leave;
  - a preview of anyone's summary;
  - a test sent only to your own Chat;
  - exceptions for one person;
  - a record for each day: sent, skipped and why, and Chat delivery.
- **Sales CRM settings → Repeated calls to review:** a list of calls close
  together. Building it changes nothing. A manager can mark one call at a time
  as an accidental repeat, with a reason. The call is kept and shown, is no
  longer counted, and can be counted again.
- **Sales CRM settings → Lead locations to review:** suggestions for existing
  leads:
  - a District column an older import put into City;
  - a single state named in the notes;
  - a PIN code written in the notes.

  Each one changes its lead only when someone chooses "Use it". It only ever
  fills an empty field.
- **Reports → Calls & statuses** now starts with separate figures for the
  period: call attempts, leads called, conversations, leads spoken to,
  qualified, orders and money received. Each is counted from its own records,
  never worked out from the step before.
  - Calls a manager marked as accidental repeats are left out.
  - Calls that came in from customers are listed apart.
  - Attempts that came in with imports, which have no call record, are shown
    on their own and never added in.
- **Export** of leads adds:
  - the lead stage and calling status;
  - the full location;
  - the next follow-up, the retry time and the last call;
  - "Calls logged (by id)", the last call id and the imported attempts;
  - the latest note, marked `[imported]` when it came from an import.

  The export still respects each person's access, and the sensitive-field
  permission.

## Server commands (read only)

```
npm run crm:call-review -- --lead 693 --lead 692     # suspected repeats on these leads
npm run crm:call-review -- --since 2026-11-01        # on every lead since a date
npm run crm:call-review -- --lead 693 --json         # the same, as JSON
npm run crm:owner-review                             # leads, follow-ups and rules tied to switched-off accounts; who holds CRM admin powers
```

Both run inside a `READ ONLY` transaction, which is then rolled back. They
cannot change anything. `crm:call-review` also works before migration 033 is
applied. It then reports how each call was recorded as unknown.

## Data and deployment

- **Migration 033 only adds things:** new columns and tables. No existing row
  is changed, city and state keep their values, and calls keep their ids.
  - The migration guard test checks that 033 drops, truncates and deletes
    nothing.
  - The Chat message kinds keep every earlier value and add `CRM_REMINDER` and
    `CRM_DIGEST`.
- **Rollback:** deploy the previous version. The new columns and tables are
  then ignored, and nothing is lost.
- **Development copies only:** migration 033 was edited while it was being
  written. A development database that ran an early draft is missing
  `tasks.completion_call_id`. The file is safe to run again; that is how the
  browser-check copy here was repaired. Production never ran 033.
- **Follow-ups created before this release** keep their single 15-minute
  reminder until they are moved or reassigned. They then get planned
  reminders.

## What was tested

| Area | How | Result |
|---|---|---|
| Whole server suite | `npm test` in `server/` (every test file, including the new one) | **580 passed, 0 failed** |
| New acceptance tests | `server/tests/crmCallsFollowups.test.js`, 12 tests, on a throwaway schema | **12 passed** |
| Browser helpers | `client/tests/crmWork.test.js`; whole client suite `npm test` in `client/` | **114 passed, 0 failed** |
| Walk-through in a real browser | Chromium on a fresh made-up database: 34 checks, desktop (1360 px) and phone (iPhone 13) | **34 passed, no page errors** |
| Accessibility | axe-core 4.10 (WCAG 2 A and AA) on 12 screens and dialogs | See below |

**The 12 acceptance tests cover:**

- **K1 Repeat submissions:**
  - two submissions of one call at the same moment make one call, and one
    answer says it was a repeat;
  - pressing Save again after a lost answer returns the first call;
  - two genuine calls with the same words stay two;
  - an older screen without request ids still saves;
  - "Log call" is protected the same way;
  - the same request id from someone else is their own call.
- **K2 Corrections:**
  - correcting a note keeps the call's id and the lead's count, and records
    the before and after;
  - a teammate can see the call but cannot correct it;
  - the Calls list, the timeline, the lead page and the export agree call by
    call.
- **K3 Review and repeats:**
  - the review list is for managers only and changes nothing;
  - marking a repeat keeps the call, lowers the count by one and is recorded;
  - counting it again restores both;
  - a member cannot mark a repeat.
- **K4 Call-backs and follow-ups:**
  - saving how a call went closes the call-back due, linked to the call, and
    the lead no longer comes straight back to the top of the call list;
  - completing a Call follow-up twice at once records one call;
  - "Done" for something that was not a call records none.
- **L1 Location:**
  - every location field is saved and reloaded;
  - a misspelt state is corrected;
  - a malformed PIN or an unknown state is refused with a clear message;
  - blanking a field removes it, and other fields keep their values;
  - the filters work: state, district, PIN prefix, "state not provided",
    "district not provided" and "no location";
  - search by PIN or town works;
  - districts are offered by state;
  - every location column appears in the export.
- **L2 Import:** District, Block and PIN columns map to their own fields; a
  malformed PIN is left out with a warning on the row.
- **L3 Suggestions:**
  - a state and a PIN found in a note become suggestions, and the lead does
    not change by itself;
  - two states named in a note give no suggestion;
  - a teammate cannot accept a suggestion;
  - accepting one fills the field and records it, and a second accept is
    refused;
  - a PIN typed in meanwhile is never overwritten.
- **Q1 My Day:** 65 made-up leads.
  - Every group's count equals the Leads list's total for the same filters.
  - A retry due now appears in My Day; retries later are their own view.
  - 60 new leads page through in three pages, each lead exactly once.
  - Someone else's queue needs team access; a manager sees "Unassigned".
- **R1 Reminders:**
  - 30, 15, 10 and 5 minutes before, each sent once at its time, with the
    lead's name, the time in IST and the next action;
  - two senders running at once do not double any reminder;
  - the older built-in reminder adds nothing;
  - opening the reminder marks it as seen.
- **R2 Changes to a follow-up:**
  - personal defaults are saved, and a choice other than 30, 15, 10 or 5 is
    refused;
  - rescheduling cancels the old reminders and plans new ones, so nothing is
    sent for the old time;
  - handing over moves the reminders to the new person, with their own
    defaults;
  - completing a follow-up, or losing its lead, cancels its reminders;
  - a follow-up set seven minutes ahead skips the 30, 15 and 10 minute
    reminders and keeps the 5;
  - when the worker is behind, only the latest reminder due is sent, saying
    the minutes really left;
  - a follow-up time that passed while the server was down is skipped, never
    sent late;
  - a reminder for a follow-up just after midnight falls the evening before.
- **R3 Chat reminders:**
  - none while Chat reminders are switched off;
  - "Not linked" when the person has no Chat link;
  - refused when the linked Chat account is not the person's login;
  - otherwise exactly one outbox message to their own direct message, with
    the lead and a link.
- **D1 Daily summary:**
  - it starts off and in test mode;
  - test mode records who would get what and sends nothing;
  - live, Isha gets only her own items, once even when run twice, while Ravi
    without a Chat link is skipped with the reason;
  - an administrator's exception skips a person, and only administrators can
    set one;
  - anyone can preview their own summary, and only administrators can preview
    someone else's;
  - a test goes only to the administrator's own Chat, labelled TEST.

**The browser walk-through also confirmed:**

- a double click on Save records one call;
- the confirmation shows the call number and the time to the second;
- reloading with an unsaved note asks first;
- correcting a call adds no row;
- a malformed PIN is explained as it is typed;
- My Day's "Open in Leads" lands on the same records;
- the phone layouts do not scroll sideways.

Screenshots: lead page, saved call, Calls tab, call detail, Edit with
Location, follow-up reminders, My Day on desktop and on a phone, the Leads list
with locations, New lead on a phone, reminder defaults, the report figures,
the repeat review list, the daily summary settings and preview, and the
location review.

## Accessibility

The new screens pass axe-core's WCAG 2 A and AA checks, except for the
existing colours below.

**Fixed:**

- **The shared muted grey** was 4.0–4.4:1 against white and the page
  background, below the 4.5:1 minimum. It is now `#6c6b67`, at least 4.7:1
  everywhere it is used. This darkens secondary text slightly on every screen.
- **Dimmed "repeat" rows** made their text and badges too faint. They now use
  a shaded row and a struck-through call number instead.

**Not changed (brand decisions):**

- **White text on the brand blue `#2a78d6`** is 4.41:1, just under 4.5:1.
  This affects primary buttons and the logo.
- **The "Leads" breadcrumb link** is told apart from its text by colour only.

**Also built in:**

- Form controls have labels.
- The outcome chips are radio groups.
- The queue groups are tabs.
- Each save's confirmation is announced as a status.
- The PIN error is announced as an alert.

## Still unverified

- **Leads 692 and 693.** The causes are the likely explanations in the plan,
  not confirmed. To confirm, run `npm run crm:call-review -- --lead 693 --lead 692`
  on the server after deploying, and read the output with the person who made
  the calls.
- **Real Google Chat delivery.** Chat messages were checked as far as the
  outbox. Sending them uses the existing outbox sender, which already has its
  own tests. No message was sent to Google from here.
- **Pop-up notifications on real phones.** These depend on each browser's
  permission. In-app reminders arrive under the bell whether or not TaskFlow
  is open. Pop-ups appear only while it is open and allowed. Chat reaches a
  phone with TaskFlow closed.
- **Large real lists.** The queue was tested with 65 leads, and its counts use
  the same queries as the Leads list, which is already in use with real data.
  Its speed on the live data was not measured.
- **Device clocks outside India.** The new exact times always show India time
  and say IST. Older short times elsewhere in the app follow the device's
  clock, as before.
- **District list.** No official district list is installed. The District
  picker offers districts already recorded for the state.

## Decisions for an administrator

1. **Daily summary.** Whether to turn it on, at what time, on which days, and
   when to leave test mode. It is off, and in test mode, until someone
   decides.
2. **Chat reminders.** Whether to allow follow-up reminders in Google Chat.
   They are off.
3. **Repeated calls.** After running the review list, which calls (if any) to
   mark as accidental repeats. Nothing is changed until a manager does it, one
   call at a time.
4. **Location suggestions.** Whether to run "Look for suggestions" and have
   owners confirm them.
5. **District list.** Whether to install a verified list as
   `server/src/data/districts.json`, shaped `{ "<State>": ["<District>", …] }`.
6. **Owners and access.** Run `npm run crm:owner-review` and decide on what it
   lists:
   - leads and follow-ups with switched-off owners;
   - assignment rules naming them;
   - approval rules with no active approver, or that allow self-approval;
   - who holds CRM settings, assign, sensitive-export and audit powers.

   No permission or owner was changed by this work.
7. **Brand colour contrast.** Whether to darken the brand blue slightly so that
   white button text passes 4.5:1.
