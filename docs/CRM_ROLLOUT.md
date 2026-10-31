# Sales CRM — rollout, backup and recovery

How to put the sales CRM live without putting existing data at risk: what the
upgrade changes, how to rehearse it on a copy of production, how to deploy,
check and recover. Read with [`DEPLOY.md`](DEPLOY.md), which covers the
server itself.

**Status.** Everything below that says *tested* was run in the development
environment: the automated suite, and browser walk-throughs on a scratch
database. Nothing has been run against production or a copy of it. Steps
marked **do before deploying** are still to be done by whoever deploys.

---

## 1. What changes on day one

**For people using TaskFlow**

| Change | Effect |
|---|---|
| A **Sales CRM** item in the menu | My Day, Leads, Approvals, Calls, Reports, Imports, Settings, Help. |
| "B2B Pipeline" is now **Pipeline** | It has a **B2B corporate / CSR / NGO** switch. Every existing deal is on the B2B board, in the stage it was in. |
| The B2B pipeline gains a stage, **Approval / Contracting**, before Won | Won and Lost keep their ids; they move one place down the order. No deal changes stage. |
| New organizations ask **who they are** first (B2B corporate, CSR / NGO, or a TeleCRM category) | A retailer, FPO or individual is saved to the TeleCRM queue as a lead instead of the pipeline. Nothing is refused or lost. |
| Existing organizations are marked *legacy, awaiting confirmation* | They stay in the pipeline and in totals (the default) until an administrator confirms each one in **Settings → Existing records to classify**. None is reclassified automatically. |
| A deal's **Sales** section | Quotations, payments, delivery and renewals. It sits beside what was there; nothing existing moves. |
| **Record-level access is off** | Everyone with CRM access sees every record, exactly as before. Switching it on is an administrator's decision; see §6. |
| **Automation is off**, and in test mode; WhatsApp live sends are off | Nothing is sent to a customer by the release itself. |

**For API clients (existing contracts)**

| Call | Before | After |
|---|---|---|
| `POST /accounts` without a category | 201, organization in the pipeline | **Unchanged**: 201, organization in the pipeline, marked *legacy, awaiting confirmation* (`category_source = UNSPECIFIED`) for an administrator to confirm. |
| `POST /accounts` with `lead_category` RETAILER / FPO / INDIVIDUAL | (field did not exist) | 202 with the lead it created in the TeleCRM queue. |
| `POST /opportunities` on an organization confirmed as RETAILER / FPO / INDIVIDUAL | (could not happen) | 400, `CATEGORY_EXCLUDED`. |
| `POST /opportunities/:id/stage` to a stage of the other pipeline | (one pipeline) | 400, `STAGE_NOT_ALLOWED`; changing pipeline is its own call. |
| Deal money fields (`cash_received`, `booked_value`, `invoiced_value`) | Summed every payment, refund-unaware, across currencies | Only in the deal's own currency, refunds subtracted. For data entered before the release (no refunds existed; payments in the deal's currency) the numbers are the same; the rehearsal test checks a won deal's. A pre-release payment recorded in a different currency from its deal would now be left out of that deal's total. |

All other existing routes, fields and response shapes are unchanged. The
existing test suite (all of it, not only the CRM tests) passes on this
branch.

## 2. What the migration does to existing data

The migration is `server/src/db/migrations/027_sales_crm.sql`, and it is
additive:

- No table, column or row is dropped, renamed, truncated or deleted.
- No id changes.
- Every `CHECK` constraint it redefines still allows every value it allowed
  before.

Two automated tests enforce these rules on every migration file
(`tests/migrations.test.js`).

The only `UPDATE`s to existing rows:

| Table | Statement | Changes existing values? |
|---|---|---|
| `account_stages` | Sets the new `pipeline_id` column to the B2B pipeline | No (new column) |
| `account_stages` | Won `position` 9 → 10, Lost 10 → 11, to make room for Approval / Contracting at 9 | **Yes**: display order only, only if they are still at 9 and 10 |
| `accounts` | New `routing_status = LEGACY_UNCONFIRMED`, `category_source = LEGACY`, plus a *suggested* category with its reason | No (new columns); `lead_category` stays empty |
| `accounts` | New `domain` = the website's plain host, where a website exists | No (new column; a copy) |
| `account_contacts` | New `email_normalized` and `phone_normalized` (lower-case email; digits, with 91 added to 10-digit Indian mobiles) | No (new columns; copies) |
| `opportunities` | New `pipeline_id` = the B2B pipeline | No (new column) |

**Verified by test**: `server/tests/salesMigration.test.js` builds the schema
up to the previous migration and fills it like the live site:

- organizations in several segments
- contacts with untidy phone numbers and emails
- deals that are open, won and lost, including one in USD
- stage history
- activities, including the `CAMPAIGN` type
- an order, an invoice, a payment, an ownership change and a task

It then fingerprints every column that existed and runs the real migrator.
After the migration:

- every existing column holds exactly what it held;
- only Won and Lost moved position;
- no organization was given a category;
- a member of another department still sees every organization and deal;
- the board still shows every open deal;
- a won deal's money reads the same.

A second migration run changes nothing.

### Migration 028 (tele-sales)

`028_telesales.sql` is additive as well. It widens three CHECK constraints,
keeping every value they allowed:

- lead status gains `WON`;
- pipeline and scoring-model categories gain the retail categories.

It also adds:

- calling statuses, seeded with TeleCRM's 14;
- lead fields, seeded with the enquiry form's questions;
- the Retail, FPO & farmers pipeline and its 7 stages;
- scoring models for retailer, FPO and individual;
- three sources (Instagram, Facebook, Google search);
- nullable or defaulted lead columns (calling status, attempts, retry time,
  rating).

No existing row is changed. The population rehearsal test now runs 027 and 028
together and expects 16 new stage rows.

Two behaviours change with it:

- **Retailers, FPOs and individuals are worked in TaskFlow by default**, and
  leads of unknown category are worked by their owner. See
  `docs/TELECRM_MIGRATION.md`.
- **Commercial bookings and receipts** in reports include retail deals; CSR
  is still separate.

After deploying, check **Settings → Visibility, routing & calendar →
"Are worked"**: an earlier build's form saved "In TeleCRM" as its default.

## 3. Before deploying

### 3.1 Back up (do before deploying)

The database and the uploads folder (attachments, organization images,
imports) are backed up together:

```bash
TS=$(date +%F-%H%M)
pg_dump -U taskflow -n taskflow -Fc taskflow > /backup/taskflow-$TS.dump
tar czf /backup/taskflow-uploads-$TS.tar.gz -C /var/lib/taskflow uploads
ls -lh /backup/taskflow-$TS.dump /backup/taskflow-uploads-$TS.tar.gz   # both non-empty
pg_restore --list /backup/taskflow-$TS.dump | head                    # the dump is readable
```

- Keep the backups off the server as well.
- How far back a restore may reach (RPO) and how long it may take (RTO) are
  open questions (Q8 in [`CRM_REQUIREMENTS.md`](CRM_REQUIREMENTS.md)). Until
  they are answered, take this backup immediately before the deploy.

### 3.2 Rehearse on a copy of production (do before deploying)

Restore the dump into a separate database, upgrade the copy, and compare
before and after. Production is not touched.

```bash
createdb -U postgres taskflow_rehearsal
pg_restore -U postgres -d taskflow_rehearsal --no-owner /backup/taskflow-$TS.dump

# 1. counts and fingerprints BEFORE (save the output)
psql -U postgres -d taskflow_rehearsal -f docs/examples/crm-reconcile.sql > before.txt

# 2. upgrade the copy with the new build, pointing only at the copy
cd /srv/taskflow-new/server
DATABASE_URL=postgres://postgres@localhost/taskflow_rehearsal DB_SCHEMA=taskflow npm run migrate

# 3. counts and fingerprints AFTER, and compare
psql -U postgres -d taskflow_rehearsal -f docs/examples/crm-reconcile.sql > after.txt
diff before.txt after.txt
```

The script leaves out the stages the release adds. **The one expected
difference** is the *stage positions* line: Won and Lost move one place down.
Anything else in the diff, such as a count, fingerprint or money total, means
**stop**. Do not deploy; investigate on the copy.

The script itself has been run across the upgrade on a test database at the
previous migration, holding organizations, a contact, a deal and a payment:

- it reads only columns that existed before;
- its only difference was the stage positions line.

Then start the new build against the copy (`PORT=4100`, `AUTO_MIGRATE=false`,
`SALES_WORKER=false`) and open a few real organizations and deals as an admin,
a manager and a member.

**Dropping the copy afterwards:** `dropdb -U postgres taskflow_rehearsal`. The
copy holds real customer data, so treat it like production.

### 3.3 Environment variables

All are optional. Without them, the CRM works with manual calls, no WhatsApp
and the export-based TeleCRM hand-off, and Settings says what is not
connected. Secrets go in `server/.env` (or the service manager). They are never
committed, typed into TaskFlow, or shown by it.

| Variable | Purpose |
|---|---|
| `SALES_WORKER` | `true` (default) runs the CRM background worker in this process. Set `false` on extra app servers if you run several; any number can run safely, since every step claims its work. |
| `SALES_WORKER_INTERVAL_SECONDS` | How often the worker runs automation, imports and outgoing messages (default 30, minimum 10). Reminders, escalations, payment and renewal checks and scheduled reports run every 5 minutes. |
| `WHATSAPP_ACCESS_TOKEN` | Meta system-user token for the WhatsApp Business Platform (Cloud API). |
| `WHATSAPP_PHONE_NUMBER_ID` | The sending number's id in Meta. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Needed to sync approved templates. |
| `WHATSAPP_APP_SECRET` | Verifies `X-Hub-Signature-256` on Meta's webhooks. |
| `WHATSAPP_VERIFY_TOKEN` | Any long random string; entered again in Meta when registering the webhook. |
| `WHATSAPP_GRAPH_VERSION` | Graph API version (default `v21.0`). |
| `WHATSAPP_SANDBOX` | `true` labels everything as a test number. |
| `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN` | Exotel API credentials, for click-to-call. |
| `EXOTEL_SUBDOMAIN` | Exotel API host (for example `api.exotel.com`). |
| `EXOTEL_CALLER_ID` | Your ExoPhone number. |
| `EXOTEL_CALLBACK_SECRET` | Long random string; part of the status-callback address. |
| `CALL_WEBHOOK_SECRET` | Signs events from any other phone system (`X-TaskFlow-Signature`). |
| `APP_PUBLIC_URL` | Already used by TaskFlow; the webhook addresses shown in Settings are built from it. |

## 4. Deploying

Follow the update routine in [`DEPLOY.md`](DEPLOY.md):

```bash
cd /srv/taskflow && git pull && npm install && npm run build
npm run migrate      # applies 027; each migration runs in one transaction and rolls back entirely on error
npm run doctor
sudo systemctl restart taskflow
```

If `npm run migrate` fails, nothing from 027 is applied (one transaction).
Fix the cause and run it again; already-applied migrations are skipped.

## 5. After deploying

**Checks (minutes):**

```bash
curl -s https://taskflow.ekosight.com/api/taskflow/health          # {"ok":true,...}
npm run doctor
sudo journalctl -u taskflow -n 80 --no-pager | grep -i "sales CRM"  # "sales CRM worker running every 30s", no errors
```

Then in the browser:

1. **Pipeline** shows the same deals in the same stages.
2. An existing organization opens with its contacts, deals, timeline and money
   as before.
3. A member who could see an organization yesterday still can.
4. **Sales CRM → Settings → Setup checklist** opens.
5. **Calls, WhatsApp & TeleCRM** says *Not connected* for anything not
   configured.

Run the reconciliation script against production too, and compare it with the
rehearsal's *after*. The counts match the backup's, plus any records created
since.

**Setting up (in this order, at the team's pace):**

1. Calendar and money: confirm, and fill in the quotation letterhead.
2. Classify existing organizations (suggestions are listed with reasons).
3. Review the two pipelines' stages and probabilities.
4. Assignment rules and fallback owner; check them with **Who would get it?**
5. Catalogue and approval rules (Q5).
6. Sources, campaigns, website form or API keys.
7. Integrations, once credentials exist (Q1, Q2).
8. Automation: switch rules on in test mode, read their runs, then take them
   out of test mode.
9. **Record-level access** (§6).

## 6. Switching on record-level access

Until it is switched on, every CRM user sees every record, as before the
release. When it is switched on:

- Sales agents see their own and shared records, or their department, or
  everything, as chosen.
- Managers see their own and granted departments.
- Administrators see everything.

This applies to the API, lists, search, the board, reports and exports, so
agents and managers **will see fewer records**. Tell them first. Switching it
off again restores the previous view immediately; nothing is deleted either
way. The choice and every change to it are in the audit log.

## 7. If something goes wrong

### Prefer fixing forward

Most problems are a setting (switch automation or record-level access back
off) or a small code fix deployed on top. Neither loses anything recorded
since the release.

### Rolling the code back (keeps the database)

The schema is additive, so the previous build runs against the upgraded
database and ignores the new tables and columns:

```bash
git checkout <previous release tag> && npm install && npm run build && sudo systemctl restart taskflow
```

What the previous build does with data created after the release (checked
against its code):

| Created after the release | Under the previous build |
|---|---|
| Leads, follow-ups on leads, calls, WhatsApp messages, quotations, approvals, payment schedules, automation, imports | Kept in the database but not shown. They reappear when the new build returns. |
| CSR / NGO stages and the Approval / Contracting stage | The previous build lists every active stage on one board, so they appear as extra columns, and CSR deals sit in them. |
| Refunds | The previous build adds every payment into "cash received", **including refunds**, and across currencies. If refunds or other-currency payments were recorded, its cash figures are overstated until the new build returns. |
| Organizations created in TeleCRM categories | Kept as leads, so not shown. |

Because of the last two rows, **once refunds or CSR deals exist, prefer
fixing forward to rolling the code back.**

### Restoring the database (last resort)

Only if data was actually damaged. A restore returns the database to the
backup and **loses every change made since**: new deals, activities, payments
and leads, in the CRM and in the rest of TaskFlow.

1. Export what was created since the backup:
   - Sales CRM → Leads (all views) → Export.
   - Pipeline → each organization's deals.
   - Reports → drill-downs → Export.
   - The audit log.
2. Stop TaskFlow.
3. Restore the database:
   ```bash
   pg_restore -U taskflow -d taskflow --clean --if-exists -n taskflow /backup/taskflow-$TS.dump
   ```
4. Restore the uploads folder from the matching archive.
5. Start the **previous** build.
6. Re-enter the exported records by hand or through the import.

The backup and restore commands above are standard PostgreSQL. They have
**not** been exercised against this installation's data; do so during the
rehearsal (restore into `taskflow_rehearsal` is exactly that).

## 8. Integrations: what is and is not verified

| Integration | State | To verify live |
|---|---|---|
| WhatsApp (Meta Cloud API) | Built to Meta's documented API, tested against a stand-in for Meta's servers. Not run against Meta. | Use Meta's test number with `WHATSAPP_SANDBOX=true`. Register the webhook, send an approved template to your own phone, reply "STOP", and check that statuses and the opt-out arrive. |
| Exotel click-to-call | Built to Exotel's documented `Calls/connect` API. Callback field names are not confirmed. | One call from an agent's profile number. Check the call log fills in and the callback's fields match. |
| Other phone systems | Signed webhook, tested with signed and unsigned events, duplicates and out-of-order events. | Point the provider (or middleware) at the call webhook with the shared secret. |
| TeleCRM | No API connection: export plus a person's confirmation. | Needs TeleCRM API documentation and a key (Q3). |
| Website form / capture API | Tested end to end (form, API key, idempotency, rate limit, routing). | Post one real enquiry from the website. |
| Scheduled reports | In-app notices; tested, including that each recipient sees only their own records. | — |

Not done:

- No performance benchmark has been run; expected volumes are Q9.
- No email delivery of CRM reports; they are in-app notices.

## 9. Reconciliation script

`docs/examples/crm-reconcile.sql` prints counts and fingerprints for the
tables that existed before the release. Run it before and after the upgrade
(on the rehearsal copy and on production). It only reads.
