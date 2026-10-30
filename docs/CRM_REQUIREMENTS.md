# Sales CRM — requirements matrix and gap analysis

Source of requirements: `CRM Modules.xlsx` (tabs *Module* and *Features*), and the
written brief that accompanied it. The workbook has 15 modules and three feature
groups (Basic CRM; Communication and Automation; Advanced CRM). The groups are
delivery phases, not scope cuts. Items the brief adds beyond the workbook are
marked **[Brief]**.

The workbook contained only the module and feature lists — no embedded
instructions, macros or comments.

Status key:

- **Verified**: an automated test and a browser walk-through both pass.
- **Tested**: an automated test passes; not walked in the browser.
- **Built, awaiting live verification**: works against test stand-ins, not yet
  against the real provider.
- **Partial**: what is missing is named.
- **Blocked**: waiting on a named dependency.
- **Not built**.

All verification is in the development environment; nothing has been run
against production. The last update is at the bottom of this file.

---

## 1. What already existed (discovery)

TaskFlow is a single-organization Node 22 / Express / PostgreSQL application with
a React (Vite) PWA client. There are no tenants: "organization-wide" means the
whole installation. Roles are `admin`, `manager`, `member`, `viewer`, with
per-user extra and revoked permissions; teams are **departments**. Managers'
reach over other departments already exists for attendance
(`attendance_team_access`). Background work runs in-process (a scanner every few
minutes and a fast worker for email), with `FOR UPDATE SKIP LOCKED` claiming.

The existing CRM ("B2B Pipeline", migrations 008–022) already provides:

| Area | Existing |
|---|---|
| Organizations | `accounts` (type LEAD/CUSTOMER/PARTNER), segments (CSR team, Foundation, NGO, Input manufacturer, Agri-tech, Agri enterprise, Government/institution, Other), dossier, locations, logo, tags, archive |
| Contacts | `account_contacts` with designation, department, channel, influence, primary flag; duplicate warning |
| Deals | `opportunities` — several per organization, engagement model (incl. CSR project, partnership), five separate amounts, probability, close date and slippage, requirements, stakeholders with roles |
| Stages | one global stage list with default probability, entry/exit evidence rules, quiet-after days, manager override with reason |
| Next action | mandatory what/who/when on live deals, handovers with confirmation, collaborators, escalation owner |
| Activities | timeline with direction and outcome, three clocks (customer responded / we followed up / internal) |
| Meetings | scheduling, reschedule history, outcomes, prep and follow-up tasks created once |
| Commercial | proposals, orders, invoices, payments (void, not delete); bookings ≠ invoiced ≠ cash |
| Delivery | `engagements` with milestones and kickoff tasks, one per deal (idempotent) |
| Follow-ups | ordinary TaskFlow tasks linked to account/deal; nudges (gone quiet, overdue, no next action…), digests, leave-aware escalation |
| Reporting | dashboard (portfolio vs activity), weekly record and reviews, investor summary, data quality, workload, audit trail (append-only) |
| Email | `.eml`/`.ics` import and optional Gmail/Calendar reading, confirmed by a person |
| Visibility | everyone with `crm.view` sees every record |

Not present: a separate inbound **lead** (enquiry) record, any notion of lead
category or of TeleCRM, assignment rules, scoring, a capture API or forms for
sales leads, campaigns, a second pipeline, a product catalogue, quotations with
line items, approvals, PDFs, payment schedules, refunds, currency conversion,
calling, WhatsApp, a rule-based automation engine, Excel import/export,
record-level visibility, merging.

---

## 2. Decisions taken (reversible defaults)

| # | Decision | Why | How to change |
|---|---|---|---|
| D1 | **Lead category** is stored on every inbound lead and organization: `B2B_CORPORATE`, `CSR_NGO` (eligible) and `RETAILER`, `FPO`, `INDIVIDUAL` (TeleCRM), plus `UNCLASSIFIED`. Destination is derived from the category on the server and cannot be set directly. | One rule, enforced in one function used by every entry path | Categories are fixed in code; routing destinations of the excluded categories are configurable only between "TeleCRM hand-off" and "review queue" |
| D2 | **Existing organizations are not reclassified.** They keep `lead_category = NULL` and are marked *legacy — awaiting confirmation*. They stay in the pipeline (so nothing existing breaks) and are listed in a remediation queue with a *suggested* category (from segment and name) that an admin confirms. Confirming an excluded category takes the record out of active workflows; nothing is deleted. | Brief: preserve, flag, admin-led remediation; never silently reinterpret | Setting `crm.routing.legacyUnclassified` = `INCLUDE` (default) or `EXCLUDE` |
| D3 | **Visibility**: when record-level access is on, Sales Agents (role `member`) see the records they own, follow, are collaborators/watchers on, or owe the next action on; Managers see their own department and any departments granted to them; Admins see everything. Enforced in list, detail, search, board, dashboard, reports and exports. **Record-level access starts off** (see D16). | Brief §15 | Settings → Visibility: on/off, and `agents` = `OWN` (recommended) / `TEAM` / `ALL`. See Q4 |
| D4 | **Teams = departments.** Managers' team reach reuses `attendance_team_access`. | No second team structure | — |
| D5 | **Follow-ups are TaskFlow tasks** with a follow-up kind, outcome and lead link; there is no separate CRM to-do list. Meetings stay `crm_meetings`. | Brief §6: no duplicate follow-up records | — |
| D6 | **Delivery handover on Won = the existing engagement** (one per deal, idempotent) plus milestone tasks, now with a handover review step and the payment/reporting schedule. | Reuse; TaskFlow has no separate "project" object | — |
| D7 | **Pipelines**: existing stages become the *B2B Corporate* pipeline unchanged (one stage, *Approval / Contracting*, is added before Won). A *CSR / NGO* pipeline is added with its own stages. Existing deals all stay in B2B. | Preserve stage ids and history | Settings → Pipelines |
| D8 | Calendar defaults: Asia/Kolkata, INR, financial year April–March, working days Mon–Sat 09:30–18:30, holidays from the attendance holiday list. Labelled *initial defaults — confirm*. | Brief §6 | Settings → CRM → Calendar |
| D9 | **Secrets live only in server environment variables**, as for email marketing. Settings show configured / missing, never the value. | Existing pattern | — |
| D10 | **TeleCRM hand-off is an explicit export** (CSV/XLSX in a TeleCRM-importable layout) with per-lead status *Pending → Exported → Confirmed in TeleCRM* recorded by a person. No public TeleCRM lead API could be found; nothing is pushed automatically and no transfer is claimed without a person confirming it. | Brief §2: do not invent an API | Becomes an API push once TeleCRM API access is provided (Q3) |
| D11 | **WhatsApp** uses the Meta WhatsApp Business Platform (Cloud API) — the official interface — behind an adapter. **Calling** has a provider-neutral call log, a signed TaskFlow call-event webhook any provider or middleware can post to, and an **Exotel** click-to-call adapter. Neither is called "working" until verified with real credentials. | Brief §10 | Q1, Q2 |
| D12 | Money is `NUMERIC(16,2)` in the database and integer paise in JavaScript arithmetic; amounts in different currencies are never added; conversion happens only with an admin-entered rate and date, and the report says so. | Brief §9 | Settings → CRM → Currencies |
| D13 | Quotation/proposal PDFs carry the **Soil Doctor** brand (same assets as email). | Existing brand guideline | Q7 |
| D14 | Live outbound automation (WhatsApp sends) is **off** until an admin switches it on after a test run. | Brief §11 | Settings → Automation |
| D15 | **Organizations created without a category** (an older API client, or the existing form path before it asked) are created exactly as before (201, in the pipeline) and marked `LEGACY_UNCONFIRMED` with `category_source = 'UNSPECIFIED'`, so they join the classification queue like the organizations that predate categories. | Existing API contracts keep working; nothing is guessed | — |
| D16 | **Record-level access starts off.** Until an administrator switches it on, everyone with CRM access sees every record, as before the release. Turning it on applies D3 everywhere at once. | Narrowing what people see on deploy day, before anyone decided it, would break existing work (brief: nothing existing may break) | Settings → Visibility. The setup checklist shows it as open until decided |
| D17 | **Scheduled reports are in-app notices**, not emails, with numbers computed separately for each recipient's access. | No CRM mail path exists yet; a notice cannot leak data to an address outside TaskFlow | Email delivery can be added later |

---

## 3. Questions (one consolidated set)

Work continues on the defaults above; answers change configuration, not code.

1. **Calling provider** — do you use Exotel, Knowlarity, MyOperator, Ozonetel, Twilio, or SIM-based calling (as TeleCRM does)? Which numbers, and may calls be recorded?
2. **WhatsApp** — is there a WhatsApp Business Account on Meta directly, or through a provider (Interakt, Gupshup, AiSensy, WATI)? Which phone number and which approved templates?
3. **TeleCRM** — can you get TeleCRM API documentation and a key? Until then the hand-off is an export.
4. **Visibility** — when should record-level access be switched on, and should sales agents see only their own and shared records (D3, D16)? Until then every CRM user sees everything, as today.
5. **Approvals** — discount and value thresholds for quotation approval, and who approves.
6. **Calendar** — confirm Asia/Kolkata, INR, April–March, working days and hours.
7. **PDF branding** — Soil Doctor (default) or EkoSight letterhead on quotations; GSTIN and bank details to print.
8. **Backups** — recovery point and recovery time objectives, and where backups should be stored.
9. **Volumes** — expected leads per month, users, and largest import file.

---


## 4. Requirements matrix

Evidence:

- **Test X** names an automated test: `server/tests/sales.test.js`,
  `salesOps.test.js`, `salesMigration.test.js` or `migrations.test.js`.
- **Walk** names a step of the browser walk-through. It runs in Chromium
  against a scratch database:
  - phone steps at 390 × 844
  - desktop steps at 1400 × 950
  - plus the dark theme and keyboard checks

### Workbook — Module tab

| ID | Requirement | Where | Status | Evidence |
|---|---|---|---|---|
| M1 | Lead management: add, edit, delete, search, filter | Sales CRM → Leads: views (mine, team, unassigned, new, overdue, stale, needs classification, TeleCRM, archived), filters, saved views, bulk actions, record page; archive and restore instead of delete | Verified | Tests C, D; walk: phone lead list, convert, keyboard reaches the new-lead form, a missing lead says so |
| M2 | Lead assignment by type, equally, or other logic | Settings → Assignment: ordered rules, capacity, leave, fallback, "Who would get it?" | Tested | Test E (equal shares, skipping unavailable or full people, retries do not reassign). Not walked in the browser |
| M3 | Follow-ups: reminders, callbacks, overdue | My Day; log call → outcome → next step; done / reschedule / snooze / hand over; reminders and escalation in the worker | Verified | Test F (overdue vs stale, each escalated once); walk: phone My Day, log a call with the next step, complete from My Day |
| M4 | Sales pipeline with custom stages | Pipeline board per pipeline; Settings → Pipelines & stages (rename, order, probability, required fields, allowed moves, ageing, approval gate, retire with mapping) | Verified | Test "pipelines"; walk: pipelines and stages, board switches to CSR / NGO, win through the move dialog |
| M5 | Dashboard: totals, today's leads, pending tasks, performance | **Reports → Summary** (leads, pipeline, outcomes, money, follow-ups) and **My Day**; the existing deal dashboard is unchanged. There is no separate "Overview" tab | Verified | Test J; walk: reports with definitions and drill-down |
| M6 | Team management: admin, manager, agent | Existing roles and per-person permissions (Team) with the new `crm.*` permissions; record-level access switch; bulk reassignment from Leads | Partial | Tests I, F15; walk: record-level access switch. No dedicated "someone is leaving" hand-over screen: use Leads → select → Assign |
| M7 | Daily, weekly, monthly sales and agent reports | Reports: summary, sources & campaigns, people, stages, targets; filters; drill-down; export; **Send regularly** (in-app, D17) | Verified | Tests J (reconciling drill-downs, currencies, access; scheduled delivery once per period, per-recipient access); walk: reports and drill-down; schedule dialog and recipient's notice on a phone |
| M8 | Import leads from Excel and CSV | Imports: template, mapping, check, duplicate strategy, background run, corrections file, undo | Verified | Test G; walk: import a CSV |
| M9 | Calling: click-to-call, call logs, recordings | Call / Log call on leads and deals; Calls tab; recordings for the agent, their managers and `crm.recordings`; Exotel adapter; signed call webhook | Built, awaiting live verification | Test H calls (signed events in any order, duplicates, unknown callers, private recordings) against a test stand-in. **Blocked: Q1** for live calling |
| M10 | WhatsApp: send, templates, conversations | WhatsApp tab on a lead; templates synced from Meta; 24-hour window; opt-out | Built, awaiting live verification | Test H WhatsApp (window, templates, signed webhooks, out-of-order statuses, failures, retries, opt-outs) against a test stand-in for Meta. **Blocked: Q2** for live sending |
| M11 | Automation: reminders, welcome messages, triggers | Settings → Automation: presets, rules, test mode, preview, runs, retry | Tested | Test F (off by default, simulates in test mode, runs once, cannot loop, stops on a reply). Not walked in the browser |
| M12 | Lead sources: websites, ads, external platforms | Hosted form; capture API with keys; sources and campaigns; UTM | Verified | Test C (every entry path, including the public form and API); walk: public form on a phone |
| M13 | Advanced analytics: conversion, source performance, revenue | Reports; definitions in `docs/CRM_METRICS.md` | Verified | Test J; walk: reports with definitions |
| M14 | Security: role permissions, audit logs, backups | Permission checks on every route; record scope on every query; audit log; backup / restore procedure in `docs/CRM_ROLLOUT.md` | Partial | Tests I, F15, migrations, salesMigration (rehearsal on a populated database). The backup and restore procedure is **documented, not exercised** on this installation's data; Q8 open |
| M15 | Mobile-friendly interface | Phone layouts for My Day, leads, lead page, call log, follow-ups, public form | Verified (emulated) | Walk: phone steps. Checked in an emulated phone viewport, not on real devices |

### Workbook — Features tab

| ID | Requirement | Status | Evidence / note |
|---|---|---|---|
| F1 | Login and user management | Verified | Existing auth and Team page, unchanged; the existing test suite passes |
| F2 | Lead management | Verified | M1 |
| F3 | Lead assignment | Tested | M2 |
| F4 | Follow-up reminders | Verified | M3 |
| F5 | Sales pipeline | Verified | M4 |
| F6 | Dashboard and basic reports | Verified | M5, M7 |
| F7 | **Excel import/export** | Verified | M8; Test G exports (permitted rows and columns only, formulas neutralised) |
| F8 | WhatsApp Business integration | Built, awaiting live verification | M10; Q2 |
| F9 | Calling integration | Built, awaiting live verification | M9; Q1 |
| F10 | Call logs and recordings | Tested | Test H calls; manual logging also in the walk |
| F11 | Automated lead assignment | Tested | M2 |
| F12 | Automatic reminders | Verified | M3 |
| F13 | Workflow automation | Tested | M11 |
| F14 | Advanced reports and analytics | Verified | M13 |
| F15 | **Lead scoring** | Verified | Test F15 (exact weighted score, missing inputs listed, override needs permission and reason, TeleCRM leads unscored); walk: lead page shows the score with what is missing |
| F16 | **Automated escalation of overdue leads** | Tested | Test F: overdue follow-ups escalate to the manager once; stale leads separately |
| F17 | **Marketing campaign tracking** | Tested | Test J (sources report). Campaign spend is shown as recorded; no cost-per-lead division |
| F18 | **Revenue and payment tracking** | Verified | Tests A, B (schedules, part payments, refunds capped and permissioned, duplicate events, verification); walk: part payment shows scheduled / received / balance / overdue |
| F19 | **Advanced permissions and integrations** | Verified / awaiting live | Test I; walk: integrations say what is not connected. Live provider states await Q1–Q3 |

### Additions from the brief

| ID | Requirement | Status | Evidence / note |
|---|---|---|---|
| B1 | **[Brief]** Taskflow/TeleCRM boundary, every entry path | Verified | Test C; walk: TeleCRM queue and classification, public form |
| B2 | **[Brief]** Legacy remediation of ineligible records | Verified | salesMigration test (suggestions only, nothing reclassified); walk: existing organization flagged for classification |
| B3 | **[Brief]** Organizations, contacts, leads, opportunities distinct; conversion keeps history | Verified | Test D; walk: convert the lead |
| B4 | **[Brief]** Organization roles (funder, contracting, paying, implementing, referral) | Tested | Test B (funder and implementer on one deal; one organization, several roles) |
| B5 | **[Brief]** CSR/NGO fields | Tested | Test B. The CSR panel was not walked in the browser |
| B6 | **[Brief]** Contact decision roles, consent, preferences | Partial | Captured on conversion and on capture (consent text and time); used by stage rules. The existing contact form on an organization does **not** yet show or edit decision roles, consent or do-not-contact |
| B7 | **[Brief]** Duplicate preview and merge | Tested | Test D (preview with reasons, field choices, history kept). Merge dialog not walked |
| B8 | **[Brief]** Catalogue and quotations with versions | Verified | Tests A and "quotation totals are exact to the paisa"; walk: quotation with a 12% discount |
| B9 | **[Brief]** CSR proposals / concept notes | Tested | Test B |
| B10 | **[Brief]** Branded PDFs | Tested | Test A (PDF served to permitted people only). Letterhead content awaits Q7 |
| B11 | **[Brief]** Approvals (thresholds, no self-approval, re-approval on change) | Verified | Test A; walk: manager approves from Approvals |
| B12 | **[Brief]** Acceptance recorded without implying e-signature | Verified | Test A; walk: records the PO |
| B13 | **[Brief]** Idempotent handover on Won with manager review | Verified | Test A; walk: double click on Start delivery creates one engagement, in review |
| B14 | **[Brief]** Renewals / next cycle as a new linked opportunity | Tested | Test B (asking twice returns the same renewal) |
| B15 | **[Brief]** Payment schedules, partial receipts, refunds, duplicate-event guard, verification | Verified | Tests A, B; walk: part payment |
| B16 | **[Brief]** Multi-currency without adding unlike currencies | Tested | Test J (USD deal counted separately) |
| B17 | **[Brief]** Unified timeline | Partial | The lead page timeline merges activities, calls, WhatsApp messages, routing and assignment. The deal timeline is the existing activity timeline, which now also gets quotation and payment entries; automation runs are listed in Settings → Automation, not on the timeline |
| B18 | **[Brief]** Integration settings, health, diagnostics | Verified | Walk: integrations say what is not connected; Test H (events recorded) |
| B19 | **[Brief]** Targets vs actuals, forecast categories | Partial | Targets: Settings → Targets and Reports → Targets (Test J path). Forecast category is stored, used by the weighted forecast and settable by automation, but has **no field on the deal screen** yet |
| B20 | **[Brief]** Setup wizard, contextual help, guides, demo data | Partial | Setup checklist, Help tab and `docs/CRM_GUIDE.md` are verified (walk: setup checklist). **No demo data script**; the browser walk-through's fixtures are not shipped |
| B21 | **[Brief]** Migration rehearsal, backup/restore, rollback | Partial | `docs/CRM_ROLLOUT.md`; salesMigration test (populated database, every existing column fingerprinted); reconciliation script exercised across the upgrade. **Rehearsal on a copy of production is still to be done** by whoever deploys |

## 5. Acceptance journeys

| Journey | What it proves | Automated | Browser |
|---|---|---|---|
| A | Corporate sale: quotation approved by someone else, sent, accepted, won, handed over once, paid in part | Test A | Agent and quote phases |
| B | CSR commitment in its own pipeline, funder and implementer, kept apart from receipts; a loss; a renewal | Test B | Board switches to CSR / NGO |
| C | Retailer, FPO and individual leads stay out of the Taskflow pipeline on every entry path | Test C | TeleCRM queue and classification; public form on a phone |
| D | One organization, several contacts and deals; conversion keeps the lead; merge preview | Test D | Convert the lead |
| E | Assignment rules: equal shares, unavailable or full people skipped, retry-safe | Test E | — |
| F | Follow-ups, overdue vs stale, escalation, automation off and in test mode, loop-safe | Tests F (salesOps), F15 | My Day: log a call, complete a follow-up |
| G | Import with mixed categories, duplicates and bad rows; corrections; undo keeps later work; permitted exports | Tests G | Import a CSV |
| H | Calls and WhatsApp against test stand-ins of the providers | Tests H | — (no live provider; Q1, Q2) |
| I | People outside a record cannot read or change it through the API; settings need permission; record-level access off keeps today's view | Test I | Record-level access switch |
| J | Reports reconcile with drill-downs, keep currencies and CSR apart, respect access; scheduled reports | Tests J | Reports with definitions and drill-down; scheduled report notice |
| K | Existing data survives the upgrade; migrations additive; constraints only widen | migrations, salesMigration | — (production-copy rehearsal pending) |
| L | Usable on a phone; keyboard; dark theme | — | Phone steps, keyboard, dark theme |

## 6. Not done, and why

| Item | State |
|---|---|
| Live WhatsApp and Exotel | Built to the providers' documented APIs and tested against stand-ins only. Exotel callback field names are unconfirmed (Q1, Q2) |
| TeleCRM API | No public lead API found; hand-off is export plus confirmation (Q3) |
| Backup and restore on this installation | Procedure documented; not exercised (Q8) |
| Production-copy rehearsal | Steps and reconciliation script ready; to be run before deploying |
| Performance | No benchmarks run; volumes unknown (Q9) |
| Contact form: decision roles and consent | Not on the existing contact form (B6) |
| Deal screen: forecast category | Not editable on screen (B19) |
| Demo data | Not shipped (B20) |
| Email delivery of reports | In-app notices only (D17) |

---

Last update: 30 October 2026. Statuses reflect the test suites and browser
walk-throughs run on this branch on that date.
