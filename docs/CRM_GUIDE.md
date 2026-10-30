# Sales CRM — user guide

The same guide is inside TaskFlow under **Sales CRM → Help**, searchable. This
copy adds the integration contracts an administrator or developer needs.

- [What goes where: Taskflow or TeleCRM](#what-goes-where-taskflow-or-telecrm)
- [Sales agent: your day](#sales-agent-your-day)
- [Manager: running the team](#manager-running-the-team)
- [Administrator: setting it up](#administrator-setting-it-up)
- [Worked examples](#worked-examples)
- [Importing and exporting](#importing-and-exporting)
- [Calls, WhatsApp, forms and the capture API](#calls-whatsapp-forms-and-the-capture-api)
- [What the numbers mean](#what-the-numbers-mean)
- [Permissions](#permissions)

---

## What goes where: Taskflow or TeleCRM

Taskflow's sales CRM works **B2B corporate** and **CSR / NGO** leads.
**Retailers**, **FPOs** (farmer producer organizations) and **individual**
farmers or consumers are handled in **TeleCRM**.

| Category | Where it is worked |
|---|---|
| B2B corporate — companies, institutions, government, agri-businesses | Taskflow, B2B pipeline |
| CSR / NGO — CSR teams, foundations, trusts, NGOs | Taskflow, CSR / NGO pipeline |
| Retailer — shops, dealers, agri-input retailers | TeleCRM (TeleCRM queue in Taskflow) |
| FPO — farmer producer organizations and companies | TeleCRM |
| Individual — a farmer or consumer acting for themselves | TeleCRM |
| Not known yet | "Needs classification" queue |

- Every lead has a category; choose it first. A retailer, FPO or individual
  lead is **kept** (nothing is thrown away) but goes to the TeleCRM queue. It
  never enters the pipeline, anyone's lead pool, automation or the sales totals.
- An FPO stays an FPO even when it is registered as a company. A person who
  works at a company is a business contact (B2B), not an "individual".
- A lead whose category is not known — a web form without the question, an
  unknown caller, an import row without the column — waits in **Needs
  classification** until someone with routing permission classifies it.
- The same rule applies on every way in: the screen, the hosted form, the
  capture API, imports, calls, WhatsApp, conversion and editing. It is enforced
  on the server, not just hidden on the screen.
- Organizations that existed before categories are marked *legacy, awaiting
  confirmation*. They stay where they were (in the pipeline, in totals) until
  an administrator confirms each one. Nothing is reclassified automatically.

## Sales agent: your day

**Sales CRM → My Day** lists:

- **Missed**: follow-ups overdue past the escalation time. Your manager has
  been told.
- **Overdue**: the time has passed.
- **Today**, **Coming up** and **Snoozed**.
- **New leads** still waiting for a first contact.

| To | Do this |
|---|---|
| Call | Tap **Call**. On a phone it opens your dialler. That does **not** record or log anything by itself. With Exotel connected, **Ring via Exotel** rings your phone first, then the customer, and logs the call. |
| Log a call | **Log call** → how it went → what was said → the next step, in the same box. |
| Finish a follow-up | **Done** → outcome → notes → next step. If there is genuinely none, say why (for example "waiting for their board on the 20th"). |
| Move a follow-up | **Reschedule** asks for the new time and a reason; the reason stays on its history. **Snooze** hides it until a time you choose. |
| Give a follow-up to someone | **Hand over** → person → reason (needs assign permission). They are told. |
| Add a lead | **Leads → New lead**. Choose who it is, then the organization and a phone or email. Possible duplicates are shown before you save; nothing is merged without a person choosing to. |
| Qualify | Open the lead → **Convert to deal**. The organization, contact and deal are created, or linked to an existing organization. The lead keeps its source, history and follow-ups. |
| Work a deal | The deal's **Sales** section holds CSR details, linked organizations, quotations, payments, delivery and renewal. A live deal always has a next action: what, who and by when. |

The **score** on a lead shows how good a fit it looks from what is recorded,
with each part listed and any missing inputs named. It is not the chance of
winning.

## Manager: running the team

- **My Day → Team** shows everyone's follow-ups. **Someone's day** shows one
  person's.
- **Leads** views worth watching:
  - **Unassigned**: no owner.
  - **Overdue**: a scheduled follow-up's time has passed.
  - **Stale**: nobody has had a two-way conversation with the lead for the
    stale period, whatever is scheduled.

  Overdue and stale are different. A lead can be stale with a follow-up
  booked for next month.
- **Reassign**:
  - One lead: from its page (Owner → Reassign).
  - Many leads: select them in the list → **Assign**.

  Every change records who made it, when, from whom and why.
- **Approvals** lists quotations and proposals waiting for you. You cannot
  approve your own request unless the rule allows it. An approved quotation
  that is then edited needs approval again.
- **Handovers**: when a deal is won, its owner presses **Start delivery** in
  the deal's Sales section. That creates one delivery engagement with kickoff
  tasks; pressing it again creates nothing new. Review it there and accept it,
  or return it with a note.
- **Reports**: every number has a **?** that says exactly what it counts. Tap
  a number to see the records behind it, and export them. **Send regularly**
  (for CRM settings users) sends a daily, weekly or monthly summary as an
  in-app notice. Each recipient's numbers are counted only from the records
  that person may open.

## Administrator: setting it up

Start at **Sales CRM → Settings → Setup checklist**. Each line opens its
section, and nothing changes until you save there.

### Visibility, routing and calendar

- **Record-level access** starts **off** after the upgrade: everyone with CRM
  access still sees every organization, deal and lead, as before.
  - When the team is ready, choose what sales agents see: their own and shared
    records (recommended), their department, or everything. Then switch it on
    and save.
  - Once it is on, managers see their own and granted departments, and
    administrators always see everything.
  - It applies to every screen, list, search, board, report and export, and to
    the API. A record outside someone's reach answers *forbidden* (an existing
    deal or organization) or *not found* (a lead).
  - Tell the team before switching it on: agents and managers will see fewer
    records.
- **Retailer, FPO and individual leads go to**: either the TeleCRM queue
  (default), or the classification queue so a person checks them first.
- **Existing organizations with no confirmed category**: keep them in
  pipelines and totals (default) or leave them out until confirmed.
- **Calendar and money**: time zone, main currency, financial year and
  working hours. These start as proposed defaults (Asia/Kolkata, INR,
  April–March, Monday–Saturday 09:30–18:30) and saving confirms them. Working
  hours drive first-response timing.
- **Quotation letterhead**: legal name, address, email, phone, website and tax
  registration (GSTIN). They are printed on every quotation and proposal PDF.

### Existing records to classify

Organizations from before categories are listed here, each with a
**suggestion** and the reason for it. For example: "The name reads like a
retailer or dealer", or "Its segment is Foundation". Confirm in bulk, or choose
a category for each. Confirming retailer, FPO or individual takes the record
out of the active pipeline; it is not deleted.

### Pipelines and stages

- There are two pipelines, **B2B corporate** and **CSR / NGO**:
  - The B2B pipeline is the existing stage list, with every stage id, deal and
    history line unchanged. One stage, *Approval / Contracting*, was added
    before Won.
  - The CSR pipeline has its own stages: New Enquiry, Fit Assessment, Concept
    / Proposal, Review, Budget Discussion, Agreement / Approval, Won /
    Committed, Lost.
- For each stage you can set the name, order, probability, required fields,
  allowed next stages, ageing days and an approval gate.
  - Renaming keeps the stage and its history.
  - Retiring a stage that holds deals asks where they go, and records the move
    on each deal.
- A deal moves only within its own pipeline. Changing a deal's pipeline is a
  separate, recorded action that asks which stage to land on.

### Assignment

- Rules run in order. Each one does one of:
  - take turns (round robin)
  - fewest open leads
  - by region or speciality
  - a fixed person
  - the organization's existing owner
- Set a **fallback owner** and a **capacity** per person. People on leave or
  at capacity are skipped.
- **Who would get it?** simulates a lead before you switch a rule on.
- With no rule and no fallback, new leads stay unassigned and the people who
  assign are told.

### Scoring

There is one model per category (B2B corporate, CSR / NGO). Each criterion
has a weight and reads something recorded on the lead: fit, requirement
clarity, budget, decision maker, timeline, recent contact, readiness. The
score is the weighted share met, from 0 to 100.

- Unanswered criteria are listed as missing.
- The lead page shows every part.
- Someone with the assign permission can override the score with a reason;
  the computed score is kept beside it.

### Sources, campaigns, forms and keys

- **Sources** (Website, Referral, Event, …) and **campaigns** (with spend
  and dates) are attributed to each lead. The **original source** is kept even
  if a later touch changes the current one.
- **Website forms**: a hosted enquiry form with its own link. The "who are
  you" question is built in, so retailers and FPOs can still enquire and are
  routed to TeleCRM.
- **API keys** for systems that post leads. The key is shown **once**; Taskflow
  stores only a hash.

### Catalogue, approvals and rates

- **Products and services** carry a price, unit and tax rate. A quotation
  line takes the catalogue price and tax unless you type your own.
- **Approval rules** trigger on a discount (%) or a total. Each rule names its
  approvers, and says whether a requester may approve their own request. A
  rule in a different currency from the quotation always applies; nothing is
  converted silently.
- **Currency rates** are entered by finance, with the date they apply from.

### Integrations, automation, targets and audit

- **Calls, WhatsApp and TeleCRM**: what is connected, what is missing, and
  the webhook addresses to register with the provider. See
  [below](#calls-whatsapp-forms-and-the-capture-api).
- **Automation**: rules start **off** and in **test mode**.
  1. Switch a rule on.
  2. Check its runs. Each says *simulated* and what it would have done.
  3. Take the rule out of test mode.

  WhatsApp sends from automation also need **live sends** switched on.
  - **Triggers**: lead captured, assigned, reassigned, converted, stale, or
    not contacted in time; follow-up overdue; deal stage changed, stale, won
    or lost; CSR proposal deadline near; quotation accepted; payment overdue;
    renewal near; WhatsApp message received; call logged.
  - **Actions**: assign, create a follow-up, notify, escalate, update a field,
    send a WhatsApp template, start the handover.
  - **Stopping conditions**: a reply, a terminal state, reassignment.
  - **Safeguards**: a rule cannot trigger itself, chains stop at a depth limit,
    each event runs a rule once, and failed runs retry three times and can
    be retried by hand.
- **Targets**: per person, department or pipeline, for a period. Measures: new
  leads, converted leads, won deals, won value, CSR committed, receipts.
- **Audit log**: settings changes, merges, exports, classification, approvals,
  payments and their corrections. It is append-only.

## Worked examples

### A corporate sale from enquiry to cash

1. Coromandel Agro fills in the website form and chooses "A company or
   institution". A B2B lead is created with its source (Website), assigned by
   the rules, and the owner is notified.
2. The owner calls from My Day, logs "Connected — wants pricing for 400
   dealers", and schedules a demo in the same box.
3. After the demo they **convert** the lead. The organization, Priya (decision
   maker) and the deal "Dealer soil programme" are created, and the original
   source is kept.
4. In the deal's Sales section they create a **quotation** from the catalogue
   with a 12% discount. The approval rule needs a manager, and Kiran approves.
5. They download the **PDF**, email it and press **Mark as sent**, which makes
   it the deal's proposal. The customer's purchase order arrives: **Record
   their answer → Accepted, by purchase order**. This is a record of acceptance,
   not an e-signature.
6. They move the deal to **Won** with the PO number, then press **Start
   delivery**. One engagement with kickoff tasks is created (pressing again
   creates nothing new), and a manager reviews the handover.
7. They add **due dates** (advance and on delivery) and record the advance
   with its bank reference. The deal shows scheduled, received, balance and
   overdue separately. Reports count the booking and the receipt as different
   numbers.

### A CSR / NGO opportunity

1. Bharat Agro Foundation is added as **CSR / NGO** (organization type: CSR
   foundation). Its deals go to the CSR / NGO pipeline.
2. On the deal, the **CSR details** hold:
   - thematic focus
   - project
   - geography
   - beneficiaries
   - funding requested
   - the proposal deadline (reminders come a week before)
3. Link the implementing partner (Gram Vikas Trust) under **Organizations on
   this deal**. The same organization is never created twice, and it can be a
   buyer on another deal.
4. Create a **proposal** with scope, objectives, outcomes, reporting and
   budget lines. It has its own PR- number and PDF.
5. When the funder signs, record committed funding and agreement status, then
   move to **Won / Committed** with the MoU reference. A commitment is not
   cash: tranches and receipts go under Payments.
6. Start delivery with **reporting dates**; each becomes a task. Next year,
   **Open the next funding cycle** creates a new linked deal, and the won one
   stays as it was.
7. A deal that does not go ahead is marked **Lost** with a reason. The
   foundation's other deals are unaffected.

### A returning customer

- When someone from an organization you already work with enquires (same
  company email domain), the lead is linked to that organization and goes to
  its owner.
- Converting it adds a new deal to the same organization, marked as a
  **repeat** sale. The earlier won deal, its value and history are untouched.
- For a contract that renews, open the won deal → **Open a renewal**. There is
  one renewal per deal; asking again returns the same one.

### A retailer routed to TeleCRM

1. Krishna Agro Store calls in. The agent adds a lead and chooses
   **Retailer**. Taskflow says it is handled in TeleCRM and saves it to the
   TeleCRM queue, not the pipeline.
2. Someone with routing permission opens **Leads → TeleCRM queue** and presses
   **Export**, which produces an Excel file. They upload the file to TeleCRM,
   then **confirm** each lead, optionally with TeleCRM's reference. Only that
   confirmation marks a lead as handed over. Taskflow has no TeleCRM API
   connection and never claims a transfer that a person has not confirmed.
3. If it turns out to be a distributor that should be a B2B customer,
   **classify** it as B2B corporate: it enters Taskflow and is assigned.

## Importing and exporting

**Import** (Sales CRM → Imports):

1. Download the template. Keep the header row, and format phone and ID columns
   as Text so leading zeros stay.
2. Upload CSV or Excel. Check the column matches and choose what to do with
   records that already exist:
   - **skip** (default)
   - **update** the existing record
   - **create anyway**
3. Press **Check the rows**. Every row gets a status with its reason: valid,
   problem, already there, or for TeleCRM.
4. Download the **corrections file**, fix the problem rows, and upload just
   those again. Uploading the same file twice does not duplicate anything.
5. Start the import. It runs in the background a batch at a time.
6. **Undo** archives the records the import created that nobody has worked on
   since. Anything worked on is kept, and listed with the reason.

**Export**: every list exports to Excel or CSV, limited to the records you may
see.

- Phone numbers, emails and registration ids are included only with the
  *sensitive export* permission.
- Cells that start with `=`, `+`, `-` or `@` are neutralised so a spreadsheet
  cannot run them.
- Each export is written to the audit log.

## Calls, WhatsApp, forms and the capture API

Credentials are **server environment variables**. They are never typed into
TaskFlow and never shown by it. **Settings → Calls, WhatsApp & TeleCRM** says
which variables are missing, using three states:

| State | Meaning |
|---|---|
| Not connected | A variable is missing. |
| Awaiting live verification | Configured, but no real event has arrived yet. |
| Receiving events | Working. |

None of these integrations has been tested against a live provider account
yet. See `docs/CRM_ROLLOUT.md`.

### WhatsApp (Meta WhatsApp Business Platform, Cloud API)

**Variables:**

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_BUSINESS_ACCOUNT_ID` (only to sync templates)
- optional: `WHATSAPP_GRAPH_VERSION` (default `v21.0`)

**Webhook**: in Meta's app dashboard, register
`https://<your host>/api/taskflow/s/whatsapp` with the verify token. Deliveries
are checked against `X-Hub-Signature-256`, and unsigned ones are refused.

**Rules:**

- Outside 24 hours since the customer last wrote, only **approved templates**
  can be sent; Taskflow refuses anything else.
- "STOP" from a customer opts them out, and a person can lift the opt-out with
  a reason.
- A reply cancels scheduled automation messages set to stop on reply.
- Message status only moves forward (sent → delivered → read), however late
  or out of order Meta reports it.
- "Accepted, waiting for status" means Meta took the message but has not
  reported back; check the webhook subscription.
- "Failed" shows Meta's reason. **Retry** resends only messages Meta never
  accepted.

### Calls

**Manual logging** always works.

**Exotel click-to-call:**

- Set `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`,
  `EXOTEL_SUBDOMAIN` (for example `api.exotel.com`), `EXOTEL_CALLER_ID` and
  `EXOTEL_CALLBACK_SECRET`.
- Each agent needs their phone number on their profile.
- Exotel's status callback goes to
  `https://<your host>/api/taskflow/s/calls/exotel/<EXOTEL_CALLBACK_SECRET>`.
  Exotel does not sign callbacks, so the address carries the secret.
- The callback field names follow Exotel's documentation but are **not yet
  confirmed** against a live account.

**Any other phone system**: post JSON to
`https://<your host>/api/taskflow/s/calls/hook`, signed with
`CALL_WEBHOOK_SECRET`. The header is `X-TaskFlow-Signature: sha256=<hex HMAC-SHA256 of the raw body>`:

```json
{
  "event_id": "evt-123",                 // retries with the same id are ignored
  "call_id": "provider-call-42",         // required
  "direction": "INBOUND",                // or OUTBOUND
  "status": "COMPLETED",                 // RINGING, IN_PROGRESS, COMPLETED, NO_ANSWER, BUSY, FAILED…
  "from": "+919876543210", "to": "+918000000000",
  "agent_email": "rupendra@ekosight.com",
  "started_at": "2026-10-30T10:00:00+05:30", "answered_at": "…", "ended_at": "…",
  "duration_sec": 184,
  "recording_url": "https://…"           // served only to the agent, their managers and crm.recordings
}
```

- Events may arrive in any order; a call's status only moves forward.
- A call from an unknown number creates an unclassified lead (channel: call)
  in Needs classification.
- Recording links are removed after the retention period set in Settings.

### Hosted enquiry form

Create a form in **Settings → Website forms & API keys**, then link to
`https://<your host>/api/taskflow/s/f/<form id>` or embed that page in an
iframe. If the form has consent text, ticking it is required, and the text and
time are stored with the lead.

### Capture API (websites, ad platforms, other systems)

```
POST https://<your host>/api/taskflow/s/leads
Authorization: Bearer <capture key>        (or X-TaskFlow-Key: <capture key>)
Content-Type: application/json             (form-encoded also accepted)
```

For systems that cannot set a header, the key can go in the path instead:
`POST /api/taskflow/s/hooks/<capture key>`.

**Fields** (common names are accepted; a nested `fields` object is read too):

| Field | Also accepted as |
|---|---|
| `organization_name` | organization, organisation, company, company_name, business |
| `contact_name` | name, full_name, contact, first_name (+ last_name) |
| `designation` | job_title, title, role |
| `email` | email_address, work_email |
| `phone` | phone_number, mobile, whatsapp, contact_number |
| `website`, `city`, `state`, `country` | town, district, region |
| `enquiry` | inquiry, message, comments, query |
| `requirement` | requirements, need, interest, product_interest |
| `category` | lead_category, who, customer_type, type |
| `external_id` | lead_id, id, leadgen_id |
| `source`, `campaign`, `referral`, `landing_page` | lead_source, campaign_name, referred_by, page_url |
| `utm_source` … `utm_content` | or a `utm` object |
| `consent` | `true`, or `{ "given": true, "text": "…" }` |
| `idempotency_key` | submission_id |

**Category** values:

- The explicit categories: `B2B_CORPORATE`, `CSR_NGO`, `RETAILER`, `FPO`,
  `INDIVIDUAL`.
- Plain words: company, business, institution, CSR, NGO, foundation, trust,
  retailer, dealer, distributor, shop, FPO, farmer producer company,
  individual, farmer, consumer.
- Anything else, or no category, is `UNCLASSIFIED`. A company name is never
  used to guess.

**Responses:**

```json
201 { "status": "accepted",         "ref": "LD-2026-0042", "routed_to": "TASKFLOW", "duplicate": null }
200 { "status": "already_received", "ref": "LD-2026-0042", "routed_to": "TASKFLOW", "duplicate": null }
```

- `routed_to` is `TASKFLOW`, `TELECRM` or `TRIAGE` (needs classification). It
  says where the lead went, never that anyone was contacted.
- Send an `idempotency_key` or `external_id` so that a retry returns the same
  lead instead of a second one.
- Keys are limited to 120 leads a minute. Beyond that the API answers `429`;
  slow down and retry with the same key.
- A `400` lists the fields at fault. A `5xx` means nothing was stored; retry
  with the same idempotency key.

## What the numbers mean

The full definitions are in [`docs/CRM_METRICS.md`](CRM_METRICS.md). In short:

| Term | Meaning |
|---|---|
| Score | How good a fit a lead looks. Not the chance of winning. |
| Probability | The chance a deal is won: the deal's own, else its stage's. |
| Weighted forecast | Value × probability, over open deals. |
| Bookings | The agreed value of won B2B deals. |
| CSR committed | Funding committed on won CSR deals. |
| Received | Money that arrived. |

Bookings, CSR committed and received are kept apart, are never added together,
and none of them is accounting revenue. Currencies are never mixed.

## Permissions

Roles get these by default. An administrator can add or remove any of them
per person under **Team**.

| Permission | Lets someone | Default roles |
|---|---|---|
| `crm.view` | See the CRM | admin, manager, member, viewer |
| `crm.create` | Add leads and organizations | admin, manager, member |
| `crm.view.team` | See their own and granted departments (once record-level access is on) | admin, manager |
| `crm.view.all` | See every record (once record-level access is on) | admin |
| `crm.assign` | Assign, reassign and bulk-change | admin, manager |
| `crm.routing` | Classify leads, work the TeleCRM queue | admin, manager |
| `crm.import` / `crm.export` | Import, export lists | admin, manager |
| `crm.export.sensitive` | Include phone, email and registration ids in exports | admin |
| `crm.merge` | Merge duplicates | admin, manager |
| `crm.approve` | Approve quotations and proposals | admin, manager |
| `crm.finance` | Verify payments, refunds and corrections, currency rates | admin |
| `crm.recordings` | Hear other people's call recordings | admin, manager |
| `crm.audit` | See the CRM audit log | admin, manager |
| `crm.settings` | Configure pipelines, assignment, scoring, sources, catalogue, integrations, report schedules | admin |
| `crm.automation` | Create, test and switch on automation | admin |
