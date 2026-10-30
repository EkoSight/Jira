# Sales CRM — requirements matrix and gap analysis

Source of requirements: `CRM Modules.xlsx` (tabs *Module* and *Features*), and the
written brief that accompanied it. The workbook has 15 modules and three feature
groups (Basic CRM; Communication and Automation; Advanced CRM). The groups are
delivery phases, not scope cuts. Items the brief adds beyond the workbook are
marked **[Brief]**.

The workbook contained only the module and feature lists — no embedded
instructions, macros or comments.

Status key: **Verified** (automated test and browser journey pass) ·
**Built, awaiting verification** · **Blocked: <dependency>** · **Not started**.
Statuses are updated at the end of each milestone; the last update is at the
bottom of this file.

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
| D3 | **Visibility**: Sales Agents (role `member`) see the records they own, follow, are collaborators/watchers on, or owe the next action on; Managers see their own department and any departments granted to them; Admins see everything. Enforced in list, detail, search, board, dashboard, reports and exports. | Brief §15 | Setting `crm.visibility.agents` = `OWN` (default) / `TEAM` / `ALL`. **This narrows what members saw before this release** — see Q4 |
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

---

## 3. Questions (one consolidated set)

Work continues on the defaults above; answers change configuration, not code.

1. **Calling provider** — do you use Exotel, Knowlarity, MyOperator, Ozonetel, Twilio, or SIM-based calling (as TeleCRM does)? Which numbers, and may calls be recorded?
2. **WhatsApp** — is there a WhatsApp Business Account on Meta directly, or through a provider (Interakt, Gupshup, AiSensy, WATI)? Which phone number and which approved templates?
3. **TeleCRM** — can you get TeleCRM API documentation and a key? Until then the hand-off is an export.
4. **Visibility** — confirm that sales agents should see only their own and shared records (D3). Today every CRM user sees everything.
5. **Approvals** — discount and value thresholds for quotation approval, and who approves.
6. **Calendar** — confirm Asia/Kolkata, INR, April–March, working days and hours.
7. **PDF branding** — Soil Doctor (default) or EkoSight letterhead on quotations; GSTIN and bank details to print.
8. **Backups** — recovery point and recovery time objectives, and where backups should be stored.
9. **Volumes** — expected leads per month, users, and largest import file.

---

## 4. Requirements matrix

Columns: requirement · existing state · screen / workflow · backend / data · acceptance test.

### Workbook — Module tab

| ID | Requirement | Existing | Screen / workflow | Backend / data | Acceptance |
|---|---|---|---|---|---|
| M1 | Lead management: add, edit, delete, search, filter | Organizations only | CRM → Leads: list with views (mine, team, unassigned, new, overdue, stale, won/lost, needs classification), quick add, record page, bulk assign/tag/status, archive/restore | `crm_leads`, `services/sales/leads.js` | Journeys A, D |
| M2 | Lead assignment by type, equally, or other logic | — | Settings → Assignment rules: ordered rules, simulate, "why this owner" | `crm_assignment_rules`, round-robin state with row lock, idempotent per lead | Journey E |
| M3 | Follow-ups: reminders, callbacks, overdue | Tasks + nudges for deals | CRM → My Day; log call → outcome → next follow-up; complete / reschedule / snooze / hand off | task columns `followup_kind`, `crm_lead_id`, `snoozed_until`; escalation in worker | Journey F |
| M4 | Sales pipeline with custom stages | One pipeline | Opportunities board/list per pipeline; Settings → Pipelines (order, probability, required fields, allowed moves, aging, approval gate, retire with mapping) | `crm_pipelines`, stage columns | Journeys A, B |
| M5 | Dashboard: totals, today's leads, pending tasks, performance | Deal dashboard | CRM → Overview (role-aware) | `services/sales/reports.js` | Journeys A, J |
| M6 | Team management: admin, manager, agent | Roles/departments | Settings → Team & access (role mapping, reassignment when someone leaves) | new `crm.*` permissions | Journey I |
| M7 | Daily, weekly, monthly sales and agent reports | Weekly record | CRM → Reports with period, owner, team, category, pipeline, source, campaign, stage, currency; drill-down; export; scheduled delivery | reports service + `crm_report_schedules` | Journey J |
| M8 | Import leads from Excel and CSV | — (marketing contacts only) | CRM → Leads → Import: template, map, validate, preview, duplicate strategy, run, summary, error file, undo | `crm_import_jobs`, `crm_import_rows`; exceljs | Journey G |
| M9 | Calling: click-to-call, call logs, recordings | Manual CALL activity | Call button on lead/contact; call log; recording playback with permission | `crm_calls`, Exotel adapter, generic signed webhook | Journey H (blocked on Q1 for live) |
| M10 | WhatsApp: send, templates, conversations | — | Conversation panel on lead/contact; template picker with preview; opt-out | `crm_wa_messages`, `crm_wa_templates`, Cloud API adapter | Journey H (blocked on Q2 for live) |
| M11 | Automation: reminders, welcome messages, triggers | Nudges, digests | Settings → Automation: rules, test mode, history, retry | `crm_automation_rules`, `crm_events`, `crm_automation_runs` | Journey F |
| M12 | Lead sources: websites, ads, external platforms | — | Settings → Sources & capture: API keys, form, webhook docs | `/api/taskflow/s/leads` ingestion contract, `crm_sources` | Journey C |
| M13 | Advanced analytics: conversion, source performance, revenue | Partial | Reports → Conversion, Sources & campaigns, Revenue & payments | definitions in `docs/CRM_METRICS.md` | Journey J |
| M14 | Security: role permissions, audit logs, backups | Audit for deals | Settings → Audit; backup/restore procedure | scope helper on every query; `crm_audit_events` | Journeys I, K |
| M15 | Mobile-friendly interface | PWA, responsive | Phone layouts for My Day, lead, call log, follow-up, stage | — | Journey L |

### Workbook — Features tab

| ID | Requirement | Covered by |
|---|---|---|
| F1 | Login and user management | Existing auth/users; M6 |
| F2 | Lead management | M1 |
| F3 | Lead assignment | M2 |
| F4 | Follow-up reminders | M3 |
| F5 | Sales pipeline | M4 |
| F6 | Dashboard and basic reports | M5, M7 |
| F7 | **Excel import/export** | M8; export from every list (XLSX/CSV, permission-scoped, formula-safe) |
| F8 | WhatsApp Business integration | M10 |
| F9 | Calling integration | M9 |
| F10 | Call logs and recordings | M9 |
| F11 | Automated lead assignment | M2 |
| F12 | Automatic reminders | M3, M11 |
| F13 | Workflow automation | M11 |
| F14 | Advanced reports and analytics | M13 |
| F15 | **Lead scoring** | Transparent, configurable per category; contributions shown; override with reason |
| F16 | **Automated escalation of overdue leads** | Overdue activity vs stale record, thresholds, manager escalation (M3, M11) |
| F17 | **Marketing campaign tracking** | `crm_campaigns`, UTM, conversions and won value per campaign |
| F18 | **Revenue and payment tracking** | Schedules, partial receipts, refunds, balances, overdue; bookings ≠ commitments ≠ receipts |
| F19 | **Advanced permissions and integrations** | `crm.*` permissions, integration settings/health |

### Additions from the brief

| ID | Requirement | Screen / workflow | Backend / data |
|---|---|---|---|
| B1 | **[Brief]** Taskflow/TeleCRM boundary, every entry path | Needs-classification queue; TeleCRM hand-off list | `services/sales/routing.js`; `crm_routing_events`; `crm_handoffs` |
| B2 | **[Brief]** Legacy remediation of ineligible records | Settings → Remediation | suggestions only (D2) |
| B3 | **[Brief]** Organizations, contacts, leads, opportunities kept distinct; conversion keeps history | Convert dialog (link existing org/contact or create) | `crm_leads.converted_*`; lead activities shown on the organization |
| B4 | **[Brief]** Organization roles (funder, contracting, paying, implementing, referral) | Parties on an opportunity | `opportunity_parties`, `accounts.org_roles` |
| B5 | **[Brief]** CSR/NGO fields | CSR section on CSR deals | CSR columns on `opportunities` + configurable fields |
| B6 | **[Brief]** Contact decision roles, consent, preferences | Contact form | `account_contacts` columns |
| B7 | **[Brief]** Duplicate preview and merge | Merge dialog with reasons and field choices | `services/sales/merge.js`, `crm_merges` |
| B8 | **[Brief]** Product/service catalogue and quotations with versions | Settings → Catalogue; Quotes on a deal | `crm_products`, `crm_quotes`, `crm_quote_lines` |
| B9 | **[Brief]** CSR proposals / concept notes | Proposal on a CSR deal | `crm_quotes` kind `CSR_PROPOSAL` |
| B10 | **[Brief]** Branded PDFs | Download PDF | pdfkit + Soil Doctor assets |
| B11 | **[Brief]** Approvals (discount/value thresholds, no self-approval, re-approval on material change) | Approvals inbox | `crm_approval_rules`, `crm_approvals`, content hash |
| B12 | **[Brief]** Acceptance recorded without implying e-signature | Record acceptance (method, date, evidence) | quote columns |
| B13 | **[Brief]** Idempotent handover on Won with manager review | Handover panel | engagements + review |
| B14 | **[Brief]** Renewals / next cycle as new linked opportunity | Renew button; renewals due list | `opportunities.renewal_of_id`, `renewal_due_on` |
| B15 | **[Brief]** Payment schedules, partial receipts, refunds, duplicate-event guard, verification | Payments panel | `crm_payment_schedules`, payment `kind`, `verified_*`, `event_key` |
| B16 | **[Brief]** Multi-currency without adding unlike currencies | Totals per currency; optional conversion with stated rate | `crm_fx_rates` |
| B17 | **[Brief]** Unified timeline | Timeline tab merging activities, calls, messages, quotes, approvals, assignment, payments, lead history | `services/sales/timeline.js` |
| B18 | **[Brief]** Integration settings, health, diagnostics | Settings → Integrations | `crm_integration_events` |
| B19 | **[Brief]** Targets vs actuals, forecast categories | Reports → Targets | `crm_targets`, `opportunities.forecast_category` |
| B20 | **[Brief]** Setup wizard, contextual help, guides, demo data | Settings → Setup; Help panel | `docs/CRM_GUIDE.md`; `scripts/dev-crm-demo.mjs` |
| B21 | **[Brief]** Migration rehearsal, backup/restore, rollback | — | `docs/CRM_ROLLOUT.md` |
