# B2B pipeline — trustworthy progress tracking

The brief: sixteen pipeline features, with one priority above the rest —
*trustworthy progress tracking*. An audit found real work happening while the
pipeline still showed outdated stages and next steps.

This report covers what was built, why each rule is shaped the way it is, what was
tested, and what was not. It is written in phases; this is **phase 1, items 1–7
("Must build first")**.

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
- Phases 2 and 3 (items 8–16) follow in later commits.
