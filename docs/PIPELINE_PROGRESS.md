# B2B pipeline — trustworthy progress tracking

The brief: sixteen pipeline features, with one priority above the rest —
*trustworthy progress tracking*. An audit found real work happening while the
pipeline still showed outdated stages and next steps.

This report covers what was built, why each rule is shaped the way it is, what was
tested, and what was not. It is written in phases: **phase 1, items 1–7 ("Must
build first")**, then **phase 2, items 8–12 ("Weekly visibility")** further down.

---

## Why the pipeline showed old next steps

Two bugs, both fixed:

1. **A next step logged with an activity only reached the organization.**
   Logging "Spoke to procurement — next: share validation data" wrote the step on
   the organization's card, not on the deal. The next change to the deal copied
   the deal's old step back over it, so the card quietly went back to the old plan.
   Next steps now always land on a deal, as its next action.
2. **Editing a lead's next step did the same.** The edit dialog wrote the step on
   the organization; any later deal edit replaced it. The next action now lives on
   the deal only, and the organization's card shows the deal's.

A third: **customers' deals vanished from the board.** The board showed leads
only, so once an organization became a customer, its second deal was nowhere on it.
The board is now one card per live deal, for leads, customers and partners alike.

And a fourth, found while doing this: stages without their own follow-up cadence
(any stage an admin added) could never be flagged as gone quiet, because the
fallback read `NaN` days. Fixed.

---

## What changed in the database

`020_trustworthy_pipeline.sql`, additive only. The migration safety suite (no
drops, no renames, no `DELETE FROM`, no `NOT NULL` without a default, every row
preserved on a populated database) passes.

| Change | Existing data |
|---|---|
| `opportunities.next_step_owner_id`, `next_step_set_at`, `next_step_set_by` | Owners left blank — nobody said who owes those moves, so the deals are **flagged**, not guessed. `next_step_set_at` filled only from the change history that already recorded it. |
| `opportunities.escalation_owner_id`; `opportunity_collaborators`; `opportunity_handovers` | New, empty. |
| `account_activities.direction` accepts `INTERNAL`; `source` column; new types `TASK_DONE`, `ORDER`, `INVOICE`, `PAYMENT`, `HANDOVER`, `NEXT_ACTION` | CHECKs widened only. `source` is blank on old rows: not inferred. |
| `tasks.outcome_status`, `outcome_evidence_url`, `outcome_next_step`, `outcome_intent_confirmed` | Blank on every existing task; completion notes untouched. |
| `account_stages.entry_rules`, `exit_rules` | Proposal and Negotiation ask for a proposal on entry, Won asks for an accepted order, leaving Meeting / Demo asks for a meeting that happened — the standard stages only, editable in Settings. No deal is moved or relabelled; the rules apply to moves from now on. |
| `opportunity_history.evidence_missing` | New; records which evidence a manager moved a deal without. |
| `opportunity_proposals`, `opportunity_orders`, `opportunity_invoices`, `opportunity_payments` | New, empty. The hand-typed `collected_value` column stays exactly as it was. |

---

## The rules, item by item

### 1. Mandatory next action

Every live deal owes **a specific action, one person, and a date**.

- Missing any part is flagged on the card, the deal, the list, the nudges
  ("No next action", "Next action incomplete") and the dashboard (two counts).
- Setting or changing a next action needs all three; the date cannot already be
  past; the person must be active. Saving a form that repeats the current next
  action changes nothing and is never refused.
- **A deal cannot move into a live stage without a complete, current next
  action.** A stage change is exactly when the old step stops being true, so the
  move dialog pre-fills the current one and asks for confirmation.
- A live deal's next action can be changed, never cleared.
- New leads and new deals are created with one (the forms require it; the API
  still accepts a quick-captured lead without a date, which is then flagged).

### 2. Three clocks, not one

| Clock | Moves when |
|---|---|
| **Customer last responded** | they wrote or called in, a reply was received, a call / meeting / demo / visit took place, an order arrived |
| **We last followed up** | something was sent, an attempt was made, or an exchange we were part of |
| **Last internal update** | notes, edits, stage changes, finished tasks — never contact |

Logging asks *which way* it went (we reached out / they reached us / internal).
Internal entries are labelled and can never read as a reply. A card says
"waiting on them" when we have chased since they last responded.

**Finished tasks and meetings now appear on the timeline.** A finished deal task
is recorded as internal work (with its outcome and evidence link); a meeting's
outcome was already recorded and still counts as contact.

### 3. Stage entry and exit checks

| Rule | Satisfied by |
|---|---|
| `proposal` | a proposal record with a sent date (not withdrawn) |
| `order` | an accepted order, purchase order, contract, work order or MoU, with its number or a link |
| `meeting_completed` | a meeting or demo on the deal (or on the organization, naming no deal) recorded as **completed** |
| `contact`, `value`, `close_date`, `must_haves_met` | available in Settings, off by default |

- Checked on the server for **every** path: the board, the deal, the
  organization's header, and "mark as customer".
- The evidence can be recorded in the move dialog itself. A future-dated proposal
  or order is refused ("not sent yet").
- Moving **backwards** or to **Lost** needs no evidence.
- A **pipeline manager** (`crm.manage.any`) can move without the evidence only by
  writing why; the history shows the move as "moved without evidence" with the
  reason. Nobody else can.
- **A finished task never moves a deal.** There is no code path that does, and a
  test asserts the stage is unchanged after a deal task is completed.

### 4. Evidence-based task completion

A task linked to an organization or a deal is pipeline work. Finishing it asks:

- **Did it achieve what the task asked?** *Yes — it is done* / *Not yet —
  record progress* (the task stays open; the note goes on its history and the
  timeline) / *It cannot be done* (closed as not achieved, with why).
- **The outcome in words.** "Done", "ok" and the like are refused as statuses.
- **"Will send samples" does not complete "Test samples".** An outcome whose
  first clause reads as a plan is caught (on the screen and on the server). The
  person either records it as progress, or confirms in their own name that it is
  done — that confirmation is stored on the task.
- **A link to the evidence.** Asked every time; finishing without one is allowed
  and shown as "no evidence link" on the organization's task list.
- **What happens next** — required when finishing would leave the deal with no
  valid next action (none, overdue, or this task *was* the next action).

Ordinary tasks (no organization or deal) finish exactly as before. Every way of
finishing a task — board drag, My tasks, the task dialog, sub tasks — goes through
the same server check.

### 5. Organization and deal kept apart

- The board is **one card per live deal**, whatever the organization is. A
  customer's second deal is on it, labelled *Customer*.
- Filters: Mine (owns, owes the next move, escalation point, or helps), Owed by
  me, deal owner, kind of organization, department, state.
- Paused and nurtured deals are listed under the board; a live deal sitting in a
  closed stage (or none) is called out so it can be fixed.
- The List view is per deal too; the dashboard already counted deals of every
  kind.

### 6. The commercial record

Four kinds of fact, never added together:

| Record | Means | Dashboard figure (by its own date) |
|---|---|---|
| Proposal | an offer we made; sets the deal's proposed value | Proposals sent |
| Order / contract | a commitment they made | **Bookings** (by date received) |
| Invoice | revenue billed | **Invoiced** (by date issued) |
| Payment | cash that arrived | **Cash received** (by date it arrived) |

- Unknown amounts stay blank: an order without an amount is counted but adds
  nothing, and the dashboard says how many such orders there are.
- An invoice needs its amount; a payment must be positive; nothing can be dated
  in the future.
- Nothing is deleted: orders and invoices are cancelled, payments voided,
  proposals withdrawn — each with a reason, and they stay on the record.
- The money status (invoiced / part paid / paid) follows the invoices and
  payments once there are any.
- The old hand-typed "collected" figure is shown as exactly that, and can no
  longer be typed once payments exist.

### 7. One accountable owner, and explicit handovers

- **Accountable owner** (one), **owes the next move**, **escalate to**, and
  **helping** (with what they help with) are shown separately on every deal.
- Changing the owner of a deal that was somebody's needs a reason. A live deal
  can never be left with no owner.
- Every change of owner, next-action owner or escalation point is a
  **handover**: recorded, both people are told, and the new person confirms
  "I have it". Unconfirmed handovers show on the deal, on the card, and at the
  top of the pipeline for the person they were handed to.
- Helpers can work the deal (log, set the next action, record evidence); only the
  owner, the relationship owner or a pipeline manager decides who leads it.
- Changing an expected, proposed or agreed value somebody relied on needs a
  reason (filling a blank does not). The history shows who, from what, to what,
  and why.

---

## Tested

- **Server: 355 passing, 0 skipped**, against PostgreSQL — including 29 new
  tests in `server/tests/progress.test.js` covering every rule above, and the
  existing CRM tests updated where a move now needs evidence (each still checks
  what it checked before).
- **Client: 61 passing**, including the next-action, evidence, clock and
  "reads like a plan" helpers.
- **Browser** (Chromium via Playwright, desktop 1400 px and phone 390 px, light
  and dark), against a fresh database filled through the API:
  - the board shows a customer's second deal; the header counts live deals and
    organizations;
  - dragging a deal out of Meeting / Demo with only a booked demo is refused,
    names the missing evidence, and offers a manager the recorded override;
  - the deal panel: next action, three clocks, people, value, commercial record
    and history; the won deal's order, invoice and payment;
  - finishing "Test samples" with "Will send samples" is caught, and saved as
    progress with the task left open;
  - no sideways scrolling on a phone on the board or the deal page.

## Not done, or not claimed

- **Not deployed.**
- **Older deals are flagged, not fixed.** Deals created before this release have
  no next-action owner; they show "who?" until someone sets one.

---

# Phase 2 — weekly visibility (items 8–12)

## What changed in the database

`021_weekly_visibility.sql`, additive only; the migration safety suite passes.

| Change | Existing data |
|---|---|
| `opportunities.waiting_on`, `waiting_reason`, `waiting_until`, `waiting_since`, `waiting_set_by` | Blank: no existing deal is marked as waiting. |
| `account_stages.quiet_after_days` | Blank: every stage keeps the follow-up cadence it already had. |
| `customer_commitments` | New, empty. |
| `pipeline_snapshots` (one row per week, unique on the week) | New, empty. Past weeks are **not** back-filled. |
| `discussion_threads.blocked_item`, `dependency`, `responsible_user_id`, `external_party`, `expected_resolution` | Blank on existing blockers, which are shown as "not yet recorded" with a link to add the details. Nothing is guessed. |
| `account_activities.external_ref`, `crm_meetings.external_ref`, each with a unique index that ignores blanks | Blank on every existing row. |
| `crm_suggestions`, `crm_mailbox_sync`, `weekly_reviews`, `weekly_review_items` | New, empty. |

## The rules, item by item

### 8. The week, on the record

**B2B Pipeline → This week.** A week runs Monday to Sunday, India time.

- **Customer outcomes first:** deals moved forward and back; what customers
  committed to, kept, missed, and still owe past its date; proposals sent;
  **booked** (orders received), **invoiced** and **cash received** — never added
  together; **what slipped** (next actions past their date, deal tasks not
  finished on time); and **what needs a decision** (open blockers, deals past
  their close date, handovers nobody confirmed, deals moved without evidence,
  help asked for in reviews).
- **Effort apart:** how many emails, calls and meetings were logged, in their
  own section. Orders, payments and proposals already on the ledger are outcomes
  and are not counted again as effort.
- Every figure jumps to the records behind it; every deal links to its page.
- **Written down once.** After 08:30 on Monday (India time) the scanner writes
  down the week just ended and tells the pipeline managers. A week is never
  rewritten: writing it again returns the existing record, and the database
  allows one per week. The week in progress is worked out live and labelled
  *In progress*.
- **History:** back and forward by week, and a table of every week on the record.
- **What a stored week means:** events (moves, commitments, money) are counted to
  the end of the week; the current-state parts (next actions, close dates,
  blockers, handovers) are as they stood when it was written — the screen says when.
- A pipeline manager can write down an ended week that was not written (for
  example, a week before this release); it records the data as it stands then,
  and says so.

### 9. Stalled-deal alerts that respect deliberate pauses

- **Stalled is read on the customer's clock** — days since they last responded —
  never on internal edits.
- **Each stage can set its own threshold** (*Settings → Pipeline stages → Stalled
  after*). Blank keeps the existing per-stage cadence.
- Two different nudges: **Gone quiet** (nobody has been in touch) and **Chased, no
  reply** (we followed up within the threshold; they have not answered).
- **Waiting, on purpose.** A live deal can be marked *waiting on the customer*,
  *a third party* or *us*, with a reason and a date (at most 180 days away). It
  stays on the board with a "waiting" badge; its next action becomes *Check back:
  …* on that date, owed by whoever checks back; it is not flagged until the date,
  and then once (*Time to look again*). **Waiting on the customer ends by itself
  when they respond**, and the history says so.
- **On hold and Nurture now need a reason and a date to look again** (same 180-day
  limit). They are silent until then. Deals paused before this release keep the
  old slow cadence until someone gives them a date.
- Also raised: a customer commitment past its date, a handover not confirmed
  after two days (to the person it was handed to), and a blocker past its date
  (to the person responsible).

### 10. Blockers

- A new blocker records **what is blocked**, whether it **depends on us or on
  someone outside** (and who), **who on our side clears it**, and **the date it
  should clear**. New categories: *Sample validation*, *Pricing approval*,
  *Funding*, *Procurement* (the earlier ones remain).
- The person responsible is told and added to the conversation.
- Changing the date, the person or the dependency is noted in the blocker's
  thread; on screen, moving the date asks why. Fields that did not change are
  not reported as changed.
- Past its date, a blocker is raised to the person responsible and listed in
  the week's decisions.

### 11. Email and calendar, confirmed rather than retyped

**B2B Pipeline → Correspondence.**

- Bring in an email (`.eml`, or "show original" pasted) or a calendar file
  (`.ics`). Each becomes a **suggestion**: matched to a contact by exact email
  address, else to an organization by its domain (from its contacts or website).
  Public webmail domains are never used to match. An email between colleagues
  only is refused.
- **Nothing is logged until the person confirms it.** A confirmed email goes on
  the timeline as *from them* or *to them*, dated when it was sent, marked "from
  an imported email", and moves the right clock. The same step can record what
  the customer committed to and the deal's next action.
- A **future** calendar event becomes a booked meeting. A **past** one is logged
  only if the person says it took place and what came of it.
- The same email or event cannot land twice on an organization, whoever imports it.
- **Reading Gmail and Calendar directly** is optional: an admin allows it, and
  each person switches it on for themselves. Only correspondence with the
  pipeline's contacts and organization domains is read — headers and Gmail's
  preview, never full bodies or attachments — and still only suggested. Setup and
  the domain-wide permission it needs: `docs/GOOGLE_CHAT.md`, section 5.
- **Today's FarMart and Coromandel follow-ups** therefore reach the record by
  importing (or syncing) the emails and confirming them — they appear on the
  timeline and in the week, and move the customer clock, without a second log.

### 12. The weekly review

**B2B Pipeline → Weekly review.**

- Each owner (and whoever owes a deal's next move) answers per deal: **what
  changed** (or "nothing changed"), **the evidence** (a link), **the next
  milestone and its date**, and **help needed** — and from whom.
- Beside each deal: **what the record shows moved** that week (stage, proposal,
  order, payment, commitments, hearing from them). Apart from it: **what they
  logged** — effort, not outcome.
- Sending needs an answer for every live deal; the missing ones are highlighted.
  A sent review is not rewritten. Anyone asked for help is told.
- Owners who have not sent one by 15:00 on Friday (India time) are reminded, once.
- **Everyone's** (pipeline managers, and people with reports access): who has
  sent theirs, help asked for, and each deal's record beside what the owner says —
  with a note when someone says something changed but nothing on the record
  moved. Answers are not shown to anyone else until they are sent.

## Settings

| Setting | Default | Where |
|---|---|---|
| Stalled after, per stage | the stage's existing cadence | Settings → Pipeline stages |
| Gmail and Calendar reading | off; look back 3 days | Settings → Google Chat |
| `crm.weekly` — snapshot Monday 08:30, review reminder Friday 15:00 (India) | as shown | settings API only, for now |
| `crm.handoverConfirmDays` | 2 | settings API only |

## Tested (phase 2)

- **Server: 372 passing, 0 skipped**, including 17 new tests in
  `server/tests/weekly.test.js`: waiting (validation, the next action it sets,
  silence until its date, the reminder on it, ending when the customer writes);
  On hold / Nurture needing a date; per-stage thresholds read on the customer's
  clock ("gone quiet" vs "chased, no reply"; an internal note does not count);
  commitments (recorded with an activity, raised when late, closed once);
  blockers (every field required, the responsible person told, raised when late,
  updates noted in the thread, unchanged fields not reported); the week
  (contents, effort kept apart, never stored while running, never rewritten,
  managers only); the weekly job (stores and notifies once on Monday, reminds
  once on Friday — on a simulated clock); reviews (outcomes beside effort,
  incomplete reviews refused, help notified, sent reviews locked, drafts hidden
  from the team view, permissions); correspondence (parsing, matching by contact
  and by domain, webmail never matched, internal mail refused, duplicates,
  confirming, past vs future meetings, someone else's suggestion refused); and
  Gmail / Calendar reading against a stand-in for Google (opt-in, reading as the
  right person, unmatched mail never stored).
- **Client: 67 passing**, including week arithmetic, pause dates, blocker
  details, effort wording and that every nudge kind has words on screen.
- **Browser** (Chromium via Playwright; 1400 px and 390 px; light and dark) on a
  fresh database filled through the API: the week in progress and last week's
  stored record with its history table; everyone's reviews; the stalled-after
  setting saving; a deal's blocker details, commitments and pause dialog (a
  pause without a reason is refused); the blocker dialog's new fields;
  confirming an imported FarMart email with a new next action (the timeline,
  the next action and the customer clock all updated); a past calendar call
  refused until marked as held, then logged; an incomplete review highlighting
  the missing deal; the waiting banner on Coromandel's second deal; no sideways
  scrolling on a phone on the week, review, correspondence and deal screens.

## Not done, or not claimed (phase 2)

- **Not deployed.**
- **Gmail and Calendar reading has not been run against real Google accounts** —
  only against a stand-in. It needs the two delegation scopes and APIs above
  before it can work, and the domain-wide nature of that permission is a
  decision for the Workspace admin.
- **No back-filled weeks.** The record starts with the first week that ends after
  deployment (or a week a manager writes down by hand).
- The Monday and Friday timings were tested with a simulated clock, not observed
  on a running server across a real week.
- The weekly schedule times have no Settings screen yet.
- Phase 3 (items 13–16) follows.
