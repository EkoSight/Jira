# Sales CRM — metric definitions

Every number in **Sales CRM → Reports** is defined here exactly as
`server/src/services/sales/reports.js` computes it. The **?** next to a number
on screen shows the short form of the same definition.

## Rules that apply to every number

| Rule | What it means |
|---|---|
| **Population** | Leads worked in TaskFlow (not merged into another lead): every category, including leads whose category is not known yet, while retailers, FPOs and individuals are worked here (the default). While the setting still hands those to TeleCRM, TeleCRM's leads and the review queue are not counted. Deals: unarchived deals on unarchived organizations in a category worked here, plus legacy organizations still awaiting confirmation (when the setting keeps them in, the default). |
| **Commercial vs CSR** | "Commercial" means every pipeline except CSR / NGO: B2B and Retail, FPO & farmers. CSR commitments and receipts are always their own numbers. |
| **Visibility** | A report counts only the records the person viewing it may open. Two people can see different totals for the same filters, and that is correct. Scheduled reports are computed separately for each recipient, with that recipient's access. |
| **Dates** | Periods are **local days** in the CRM time zone (Settings → Calendar; default Asia/Kolkata). "From 1 Oct to 31 Oct" means 1 Oct 00:00 to 1 Nov 00:00 local time. |
| **Currency** | Money is reported in **one currency at a time** (the *Currency* filter; default the main currency). Deals in other currencies are counted in a separate note ("deals in USD are counted separately"), never converted or added in. A conversion needs a recorded rate, and the report says when one was used. |
| **Money is not revenue** | Commercial bookings, CSR commitments, invoices, receipts and refunds are separate numbers. None of them is accounting revenue, and they are never added together. |
| **Non-monetary deals** | Deals marked non-monetary (a partnership, an in-kind CSR project) count in deal counts and win rate, but never in values. |
| **Filters** | Owner, department, category, pipeline, source and campaign apply to leads and deals alike. For leads, source and campaign mean the **original** ones. |
| **No invented history** | Pipeline totals "as of" a past date are not offered. The CRM keeps stage changes, not daily snapshots, so it cannot state past pipeline values. |

## Summary — Leads

| Number | Counts | Date basis | Drill-down |
|---|---|---|---|
| **Captured** | Leads captured in the period | `captured_at` in period | yes |
| **Captured today** | Leads captured today | today, local | — |
| **Cohort conversion** | Of the leads *captured in the period*, the share whose status is now Converted. Numerator: captured in period AND converted; denominator: captured in period. It rises later as that cohort converts. | `captured_at` in period; status now | yes (numerator) |
| **Converted in period** | Leads converted to a deal during the period, whenever they arrived | `converted_at` in period | yes |
| **Unassigned now** | Open leads (New, Contacted, Qualifying, Qualified; not archived) with no owner | now | yes |
| **Open now** | Open leads, as above, with or without an owner | now | — |
| **First response (median)** | Median hours from capture to the first response: the first outbound attempt (a call, message or email, answered or not) or two-way contact logged on the lead, for leads captured in the period that have had one | `captured_at` in period | — |

The cohort rate and converted-in-period answer different questions. Do not
divide one by the other.

## Summary — Pipeline (open now)

Open deals are those with status **Active**. Won, lost and paused deals are
not open.

| Number | Counts | Currency |
|---|---|---|
| **Open deals** | Active deals (non-monetary included) | — |
| **Pipeline value** | Sum of each open monetary deal's *open value*: its estimated value, else the CSR amount requested | chosen currency only |
| **Weighted forecast** | Sum of open value × probability. Probability is the deal's own, else its stage's default. Leaves out stages set not to count in the forecast, and deals whose forecast category is *Omitted*. | chosen currency only |
| **Expected to close** | Open deals whose expected close date is in the period, with their open value | chosen currency for value |
| **Stale deals** | Open deals with no two-way external contact for the stale period (Settings → Follow-ups; default 14 days). Two-way means a logged external activity whose outcome is not *attempted*, *cancelled*, *no-show* or *scheduled*. Deals with no such activity count from their creation date. | — |
| **Reopened (open)** | Open deals that were closed and reopened at least once | — |

**Stale is not overdue.** Overdue means a scheduled follow-up's time has
passed. Stale means no conversation has happened, whatever is scheduled.

## Summary — Outcomes in the period

| Number | Counts | Date basis |
|---|---|---|
| **Won** | Deals with status Won, B2B and CSR together | `closed_at` in period |
| **Lost** | Deals with status Lost | `closed_at` in period |
| **Win rate** | Won ÷ (Won + Lost) among deals closed in the period. Open and paused deals are not in it. | `closed_at` in period |
| **Average cycle** | Average days from creation to close, for deals won in the period | `closed_at` in period |
| **Commercial bookings** | Sum of *agreed value* of won deals outside the CSR pipeline (B2B and retail) | `closed_at` in period; chosen currency |
| **CSR committed** | Sum of *committed amount* on won **CSR** deals. A commitment is not money received. | `closed_at` in period; chosen currency |
| **CSR non-monetary won** | Won CSR deals with no money attached | `closed_at` in period |

## Summary — Money

| Number | Counts | Date basis |
|---|---|---|
| **Invoiced** | Issued invoices (not cancelled) | `issued_on` in period; invoice currency = chosen |
| **Received (commercial)** | Receipts on deals outside the CSR pipeline, excluding refunds and voided entries | `received_on` in period; payment currency = chosen |
| **Received (CSR)** | Receipts on CSR deals (tranches), as above | as above |
| **Refunds** | Refunds paid, excluding voided entries | `received_on` in period |
| **Outstanding on schedules** | For won deals with a payment schedule: scheduled minus received net of refunds, floored at zero per deal. Cancelled schedule lines are left out. | now; schedule and payment currency = chosen |

A receipt is counted when it is recorded, whether or not finance has
**verified** it yet. Verification is shown on the deal.

## Summary — Follow-ups

Follow-ups are TaskFlow tasks with a follow-up kind. Each is attached to a
visible lead, or to a visible deal when it has no lead.

| Number | Counts |
|---|---|
| **Open** | Not completed, not cancelled, not archived |
| **Overdue now** | Open, and the due time has passed |
| **Due today** | Open, and due today (local) |
| **Completed** | Completed in the period |
| **Missed** | Completed in the period with outcome No answer, Busy, Wrong number or Not done |

## Calls & statuses

- For **leads captured in the period**, where they stand now.
- For **calls logged in the period**, who made them and how many connected.

| Number | Counts |
|---|---|
| Leads by calling status | Leads captured in the period, grouped by their calling status today, or "No calling status yet". A cohort figure: it moves as those leads are called. Clicking a status opens those leads. |
| Calls | Calls logged in the period, by the person who made them: manual call logs, calls recorded by setting a calling status, and provider calls. Only calls on leads the viewer may see. |
| Connected | Of those, calls that were answered (status completed, outcome not no-answer, busy or wrong number) |
| Connect rate | Connected ÷ Calls |
| Leads called | Different leads those calls were about |
| Talk time | Sum of call durations, where a duration is known (provider calls; manual logs only when the caller entered one) |
| Won / Lost | Calling status changes in the period, by that person, that closed a lead as won, or as lost (lost includes statuses such as Job Seeker that close the lead) |
| Breakdown | Leads captured in the period by state, category, source, owner, or any choice lead field. For several-choice fields, a lead counts once under each choice it holds. "Won or converted" counts leads now won or converted; "Lost" counts leads now closed as lost. |

Calls before the TeleCRM import are not in TaskFlow. The TeleCRM export
carries each lead's status, not its calls, so imported leads count as "Leads
called" only from their first call here.

## Sources & campaigns

- One row per **original source × original campaign**.
- *Original* means the source and campaign recorded when the lead first
  arrived; they are carried to the deal it became.

| Column | Counts | Date basis |
|---|---|---|
| Leads | Leads captured | `captured_at` in period |
| Converted | Of those, converted (cohort) | as above |
| Conversion rate | Converted ÷ Leads | as above |
| Won | Deals won from that source / campaign | `closed_at` in period |
| Won value | Agreed value of won B2B deals | chosen currency |
| CSR committed | Committed amount of won CSR deals | chosen currency |
| Spend | The campaign's recorded spend, in its own currency | as entered |

Leads and wins are counted on different date bases, so in a short period a
row can show wins from leads captured earlier. Spend is shown as recorded;
the report does not divide it into a cost per lead.

## People

- One row per active user (viewers excluded) who has anything in the period.
- When record-level access is on, the rows are limited to the people in the
  viewer's reach: a sales agent sees only their own row, a manager the people
  in their own and granted departments. Lead, deal and money columns count
  only records the viewer may see.

| Column | Counts | Date basis |
|---|---|---|
| Leads received | Leads they own that were captured in the period | `captured_at` |
| Leads converted | Leads they own converted in the period | `converted_at` |
| Activities | Calls, emails, WhatsApp messages, meetings, visits and demos they logged on leads and deals | `occurred_at` |
| Follow-ups done | Follow-ups assigned to them and completed | `completed_at` |
| Follow-ups overdue | Their open follow-ups past due, now | now |
| Won / Lost / Win rate | Deals they own closed in the period | `closed_at` |
| Bookings / CSR committed | As in the summary, for their deals | `closed_at` |
| Open deals | Active deals they own, now | now |

## Stages

One row per stage of the chosen pipeline (default B2B); retired stages are
hidden.

| Column | Counts |
|---|---|
| Open deals | Active deals in the stage now |
| Open value | Their open value, in the chosen currency |
| Ageing | Open deals that entered the stage longer ago than its ageing days |
| Stays ended / Average days | From the stage-change history: each stay in the stage that **ended** in the period, and the average days it lasted. A stage renamed later keeps its old name in older history lines, so its earlier stays appear under the old name. |

## Targets

- Targets are set per period for a person, department or pipeline.
- The actual figure is the summary measure for the target's own period and
  scope, counted only from what the viewer may see.

| Measure | Actual = |
|---|---|
| New leads | Captured |
| Converted leads | Converted in period |
| Won deals | Won |
| Won value | Commercial bookings (target currency) |
| CSR committed | CSR committed (target currency) |
| Receipts | Received (commercial + CSR) minus refunds (target currency) |
| Activities | Not measured yet; shown as "—" |

Attainment = actual ÷ target, as a percentage. It is shown only when both
exist.

## Drill-downs

A drill-down lists the records behind a number, with the same filters and the
same visibility. The number of rows equals the number shown (the automated
tests check this for Won and Lost). Exports of a drill-down carry the same rows.

Available for:

- Captured
- Cohort converted
- Converted in period
- Unassigned now
- Open deals
- Expected to close
- Won
- Lost

## Scheduled reports

**Send regularly** in Reports sends a schedule's headline numbers as an in-app
notice.

| Frequency | Period covered | Sent |
|---|---|---|
| Daily | Yesterday | Each day, soon after midnight |
| Weekly | The last complete Monday–Sunday | Each Monday, soon after midnight |
| Monthly | The last complete calendar month | On the 1st, soon after midnight |

- The numbers use the summary definitions above, the schedule's saved filters
  (not its dates), and each recipient's own access.
- A schedule is sent once per period, by the background worker's clock (every
  five minutes).
- Recipients who are inactive or have no CRM access are skipped.

## Scores

A lead's score comes from the scoring model for its category (Settings →
Scoring).

- Each criterion has a **weight** and reads a value from 0 to 1 from something
  recorded on the lead. For example, fit Strong = 1, Partial = 0.5, Weak = 0;
  timeline "this quarter" = 0.75.
- Score = Σ(weight × value) ÷ Σ(weights) × 100, rounded to a whole number.
- A criterion nobody has answered counts 0 and is **listed as missing**, so
  a low score can be told apart from an unknown one.
- Recent two-way contact and readiness come from what happened, so they are
  never missing.
- Leads in TeleCRM's categories and unclassified leads are not scored.

The lead page shows every part with its explanation.

**Override:** someone with the assign permission can override the score, and
must give a reason. The computed score is kept beside the override, and lists
and filters use the override while it is set. Clearing the override returns
to the computed score.

The default models are listed in `027_sales_crm.sql`. B2B corporate weights:
fit 25, requirement clarity 15, budget 15, decision maker 15, timeline 15,
recent contact 10, ready for a proposal 5. The CSR / NGO weights are the same,
with CSR wording.

The score is a fit indicator. It is **not** a probability and is not used in
any forecast.
