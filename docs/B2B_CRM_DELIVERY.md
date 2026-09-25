# TaskFlow B2B CRM — delivery report

What was built for the agriculture-focused B2B relationship and opportunity
management brief, what it does, what it deliberately refuses to do, and what is
still open.

Branch `claude/task-management-pwa-62ca7t`. Nothing in the existing database was
dropped, renamed, reset or reinterpreted; every migration is additive and a test
fails the build if one is not.

---

## 1. What changed in the database

Three migrations, all additive, all re-runnable.

| Migration | What it adds |
| --- | --- |
| `011_b2b_crm.sql` | The organization/opportunity split, contacts, requirements, engagements, meetings, resources, locations, segments, ownership and change history, and the enriched activity log |
| `012_crm_workflows.sql` | Idempotency flags on meetings and engagements, meeting reschedule history, nudge snoozes and nudge-event de-duplication |
| `013_segment_templates_and_images.sql` | The scope-question templates on each segment, and a table for an uploaded logo or banner |

**`accounts` was not emptied out.** Its old columns — `contact_name`, `value`,
`stage_id` and the rest — are all still there and still written to, so a rollback
reads them unchanged. 011 backfills one opportunity per existing lead, carrying
its stage, value, status, next step and history, and points
`accounts.primary_opportunity_id` at it. A test builds a pre-011 database,
inserts old-shape leads, upgrades it, and asserts that no lead, activity, task
link or contact was lost, that a lost deal stays lost, and that running the
migration twice does not mint a second opportunity.

---

## 2. The nine rules the code is built around

These are the places where a CRM most easily starts lying. Each is enforced in
one place and surfaced in the interface.

**One deal has one value, and a blank is not a zero.** Five amounts are stored
separately — estimated, proposed, agreed, collected, and an explicit "not known".
They are never summed. A forecast uses exactly one of them (agreed, else
proposed, else estimated) and the screen always names which. An unpaid pilot, a
CSR project or a partnership contributes nothing at all, and the dashboard says
how many open deals have no value rather than quietly treating them as ₹0.

**Signed is not collected.** `agreed_value` and `collected_value` are different
columns with different labels, and "Value won" carries the note *signed, not
collected*. Collected amounts are entered by hand; TaskFlow has no accounting
feed and says so on the tile.

**A forecast is an estimate, not a prediction.** Every weighted figure shows the
probability applied and where it came from — set by hand, or the stage default.

**Winning a deal does not close the relationship.** An organization can hold
several opportunities at once; one being won, lost or paused leaves the others and
the relationship untouched.

**Scheduled is not completed.** A booked demo counts for nothing. Only a recorded
outcome turns it into evidence, and a meeting that has been and gone with nothing
written is listed as *waiting for an outcome* — neither having happened nor not.

**Sending is not conversing.** Activities carry an outcome (attempted, sent,
received, completed, no-show…). Only a real exchange moves the follow-up clock.
The dashboard counts conversations and attempts separately.

**Tidying up a record is not working the relationship.** `last_external_at` is
kept apart from `last_activity_at`. Editing a banner, moving a stage or writing an
internal note never resets the cadence clock.

**A pointer is not a copy, and having a link is not having sent it.** Resources
are addresses of documents that live elsewhere. Using a shared resource on a lead
creates a reference; removing it leaves the original alone. Recording that
something was sent is a separate, deliberate act — and the dialog states plainly
that TaskFlow did not send it and cannot grant anyone access to it.

**Nothing is geocoded, nothing is invented.** Coordinates are typed in by a
person, with a stated precision. An organization without them is listed as
unmapped, in full, never dropped and never guessed onto a spot it is not.

---

## 3. One task record, not two

Preparation work, follow-ups and delivery kick-off all go through the ordinary
task engine. They are normal TaskFlow tasks with a normal ref, a normal assignee
and a normal place in My Tasks — there is no parallel CRM to-do list. Creating
them is idempotent: a retry, a double submit or a reschedule cannot mint a second
set, and rescheduling moves the existing preparation tasks rather than
duplicating them.

Where a task genuinely cannot be created — the organization has no department, so
there is nowhere to file it — the API now says so and the interface repeats it,
instead of reporting success and creating nothing.

---

## 4. What each section delivered

**§4 The organization dossier.** Segment, head office, LinkedIn, operating
regions, crops, tags, who they are, why the relationship matters, and a standing
relationship-potential figure that is deliberately excluded from every pipeline
and forecast. Logo and banner can be an uploaded file or a pasted address; both
are supported and kept apart, so uploading does not destroy a link and removing
the upload falls back to it.

**§5 People.** Contacts with roles, influence, preferred channel and a duplicate
check. External contacts are records, not users: none of them is ever invited or
messaged.

**§6 Stage entry.** Each stage declares what it expects — somebody named, a next
action with a date, a value or an explicit "unknown". Moving a deal shows the gaps
for the stage being *entered*, at the moment the question is useful, and lets you
move it anyway. It is advice, not a lock, because a tool that refuses is a tool
people route around by lying to it.

**§7 Requirements.** What must be true to win, by category and importance, with a
top blocker surfaced and unresolved must-haves feeding the closing-soon nudge.

**§8 Outcomes.** A lost deal must say why. A won one records the agreement type,
date, evidence link, agreed amount and money status separately.

**§9 Meetings and demos.** Schedule, reschedule with a reason, record the outcome
— what came of it, what they pushed back on, what proof they asked for, what they
are deciding next, and who actually turned up as opposed to who was invited. One
follow-up task, created once.

**§10 Tasks.** One record, as above.

**§11 The link library.** Folders, versions, tags, pinning, search over metadata
only, a shared organization-wide library that leads reference rather than copy,
and a log of what was actually sent to whom, when and how.

**§12 Delivery.** Post-win engagements with their own states — work can be at
risk while the agreement is perfectly sound — milestones where *delivered by us*
and *accepted by them* stay distinct, blockers, review cadence, and the agreed
money referenced from the deal rather than recorded twice.

**§13 The views.** Board, list, map and manager tree over one authorized set with
one set of filters. The tree groups by a single primary ownership so no
organization is counted under two people; followers are shown without adding to
anyone's totals.

**§14 The dashboards.** Portfolio ("as things stand") and activity ("what
happened in September") are separate blocks that are never added together. Every
figure ships its definition and date basis, readable in place, and the counts with
records behind them open them.

**§15 Nudges.** Cadence varies by stage; a nurtured deal is chased far less often.
Kinds: gone quiet, next action overdue, no next action, closing with blockers
unresolved, meeting outcome missing, milestone overdue. Each line says what to do.
A nudge can be put down only with a reason and a date — there is no "never".

---

## 5. What it will not do

- It will not message, email or invite anyone outside the company, and it never
  claims to have. Scheduling a meeting creates a record; the invitation is still
  yours to send.
- It will not change sharing permissions in Google Drive or anywhere else, and
  recording that a link was shared implies nothing about who can open it.
- It will not download, copy or crawl the contents of any linked document. Search
  covers titles, notes and tags only.
- It will not geocode an address or infer a coordinate.
- It will not count an unsigned MoU, an unpaid pilot or a potential CSR budget as
  recognized or collected revenue.
- It will not block a stage move, and it will not let a blank be read as a zero.

---

## 6. Testing

252 tests pass: 217 server, 35 client. `npm test` runs both.

The server suite runs against a real PostgreSQL schema (`taskflow_test`) and
covers the money rules, stage gates, idempotency of every task-creating path, the
external-vs-internal activity clock, authorization on every new route, the
segment templates, and the logo upload including its permission check and its
refusal of a non-image.

The client suite is pure JavaScript and covers the derivation helpers —
particularly stage-entry gaps, where the cases worth guarding are "nothing is
missing", "a value genuinely not known is an answer", and "a settled stage gates
nothing".

Verified in a real browser against a populated database — desktop and mobile
widths, light and dark — with no console errors and no failed requests. Browser
checks caught two things the tests did not: an effect returning a promise, which
blanked the delivery tab, and a map projection that stretched its pins into
ellipses.

Dev fixtures (`scripts/dev-b2b-fixture.mjs`, `scripts/dev-b2b-workflows-fixture.mjs`)
build a realistic relationship through the ordinary API so it cannot end up in a
shape the application could not produce. They are development aids and are not run
against production.

---

## 7. Still open

- **Deals cannot yet be moved on the board by segment or by relationship owner
  from the map or tree views.** Those views are read-and-navigate; stage changes
  happen on the board or the deal.
- **The map is a coarse outline, not a tile service.** It shows clustering
  honestly and sends no address anywhere. A real basemap would need an external
  provider and a decision about what leaves the network.
- **Contact enrichment, email sync and calendar integration are not built**, and
  are not stubbed: there is nothing that looks like it works and does not.
- **Collected revenue is typed in.** Connecting it to an accounting system was out
  of scope, and the dashboard says where the number comes from rather than
  implying a feed.
