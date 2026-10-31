# Moving off TeleCRM

TeleCRM's subscription ends in **January 2027**. Its leads, and the way the
calling team works with them, now live in TaskFlow's Sales CRM.

This page covers:

- what replaced what, and the few things that need a provider or are not built;
- how to bring the data over (twice: now, and once more just before the
  subscription ends);
- what to save from TeleCRM before you lose access.

**Status.** Everything here was built and tested in the development
environment. The real TeleCRM export (688 leads, 31 Oct 2026) was imported into
a scratch database and walked through in a browser. Nothing has been run
against production.

---

## 1. What TeleCRM did, and where it is in TaskFlow

The TeleCRM features below are the ones its export and the team's way of
working show. They were not compared screen by screen against your TeleCRM
account.

| TeleCRM | TaskFlow | State |
|---|---|---|
| Leads with a status ("Ringing Not Responding", "Interested", "Lost"…) | **Calling statuses**, with the same 14 names. Each one says what happened on the call and where that leaves the lead. Editable in Settings → Calling statuses & lost reasons. | Ready |
| Lost reasons | Offered when *Lost* is chosen, and required. Editable list; a caller can also type their own. | Ready |
| Rating | One to five stars on each lead. | Ready |
| Custom fields from the enquiry form | **Lead fields**: "Associated with agriculture as", "Service needed", "Shop running for", "Event". Hindi and English answers are the same choice. The agriculture answer sets the lead's category. Add your own in Settings → Lead fields. | Ready |
| Lists / batches ("Form responses 1", "OLD SOCIAL MEDIA LEADS") | Tags, filterable in the lead list. | Ready |
| Dialler list: call one lead after another | **Sales CRM → Calling**. One lead at a time: callbacks due, then new leads, then retries. The caller taps Call (the phone dials), says how it went, then Save and next. | Ready |
| Automatic retry of unanswered calls | *Ringing Not Responding* comes back after 3 hours, *Busy* after 1 hour. Both stop after 6 tries and ask the caller to close the lead or book a callback. Times and limits are editable. | Ready |
| Callbacks and reminders | Callback times on the calling form (in an hour, this evening, tomorrow morning, any time). They appear first in the call list and in My Day, with a reminder and escalation if missed. | Ready |
| Lead assignment (round robin etc.) | Assignment rules: take turns, fewest open leads, by state or speciality, a fixed person; leave and capacity respected. | Ready |
| Reports (calls per agent, status funnel) | Reports → **Calls & statuses**: leads by calling status, calls and connect rate per person, won and lost, and a breakdown by state, service, who they are, source or owner. Every bar opens the leads behind it. | Ready |
| Excel import and export | Imports recognise a TeleCRM export as it is. Every list exports to Excel. | Ready |
| Lead capture from forms | Hosted enquiry form and capture API (with keys, idempotent, rate-limited). | Ready |
| Duplicate checks | On every way in: by phone, email, company domain and the other system's id. Two TeleCRM records are never merged automatically. | Ready |
| Mobile use | TaskFlow is a phone app (PWA): install it from the browser's menu. The Calling screen is built for phones. | Ready |
| **Call recording, and calls logged automatically from the phone's SIM** | A web app cannot read the phone's call log or record calls. That needs a calling provider. The **Exotel** click-to-call adapter is built (rings the caller's phone, then the customer; logs and records the call), and any other provider can post signed call events. | **Needs a provider** (Q1) |
| WhatsApp messages and templates | WhatsApp Business Platform (Meta Cloud API): templates, the 24-hour window, opt-outs, and automation sends. | Built; **needs Meta credentials** (Q2) |
| Bulk WhatsApp / SMS campaigns to a list | Not built. Automation can send a template to each lead that meets a condition. Email campaigns exist in Email marketing. | **Not built** |
| Direct connectors (Facebook Lead Ads, IndiaMART, JustDial, Google Sheets) | No direct connectors. Point the platform's webhook, or a Zapier/Make step, at the capture API. | Ready through the API |

## 2. What changed in TaskFlow

**Categories**
- Retailers, FPOs and individual farmers or consumers are now worked in
  TaskFlow, the same as B2B corporate and CSR / NGO leads.
- Their deals go in a new pipeline, **Retail, FPO & farmers** (Pipeline →
  the third switch). Quotations, payments and handover work there as for any
  deal.
- A lead whose category is not known is worked by its owner and marked "Who
  is it?". It is not hidden in a review queue any more, because there is
  nowhere else for it to go.

**Calling**
- A new **Calling** tab.
- On every lead: a "How did the call go?" panel, the lead's answers, stars,
  and a link to its TeleCRM record (until the subscription ends).
- A lead can be **won on the lead itself**, for a small sale closed on the
  call. Convert it to a deal when you want the payment recorded there.
- Many stale leads at once (after an import, after a holiday) arrive as **one
  notice**, not one each.

**Imports and reports**
- Imported history does not set off "not contacted yet" alarms or run
  new-lead automation.
- Commercial bookings and receipts in reports now include retail deals. CSR
  is still kept separate.

**The setting** (Settings → Visibility, routing & calendar → "Retailers, FPOs
and individuals are worked")

| Option | What happens |
|---|---|
| **Here in TaskFlow** | The default. |
| In TeleCRM | New retailers, FPOs and individuals go on the TeleCRM hand-off list, as before. |
| In the classification queue | A person checks each one first. |

When you move to TaskFlow, press **Bring waiting TeleCRM and review leads into
TaskFlow**. In the rehearsal on the scratch database, 4 queued leads came back
this way. Hand-off records stay as history.

> If the CRM settings were ever saved with an earlier build, the stored choice
> may be "In TeleCRM": an earlier version of that form saved TeleCRM as its
> default. Check this setting after deploying.

## 3. Bringing the data over

### The export

In TeleCRM, export **all leads with all columns** as CSV or Excel. Your export
of 31 Oct 2026 has the right shape: 27 columns including *Lead id*, *Lead
Link*, *Assignee emailid*, *Status*, *Lost Reason* and the form questions.

### Before importing

1. **Create each caller's TaskFlow account with the same email as in
   TeleCRM**, for example `isha@ekosight.com`.
   - Leads are matched to their owner by that email.
   - If the email is not a TaskFlow user, the lead is imported unassigned with
     a warning. You can pick a fallback owner on the import screen instead.
2. Set the routing to **Here in TaskFlow** (§2).

### Importing

Sales CRM → Imports → choose the file. TaskFlow recognises it ("This is a
TeleCRM export") and reads it this way:

| TeleCRM column | In TaskFlow |
|---|---|
| Status | Calling status (same name), and the lead's stage from it |
| Lost Reason | Why it was lost (Lost and Job Seeker leads) |
| Rating | Stars |
| Assignee emailid | Owner (matched by email) |
| Full Name · Mobile Number · E-Mail Address · Designation | Contact name · phone · email · designation |
| Company Name or Shop Name | Organization / shop name |
| You are associated with agriculture as | Lead field, and the lead's category (Retailer, FPO, Individual; "Other" and "Agri-Input Company or Distributor" are left for a person) |
| Service Needed | Lead field (several services in one cell are all kept) |
| Shop Duration · Event Name | Lead fields, as written |
| State Lead Belongs To | State, spelling corrected (Maharastra → Maharashtra, Gujrat → Gujarat, Karantaka → Karnataka…) |
| District | City |
| How did you hear about us | Source (Instagram, Facebook, Referral, WhatsApp, Google…, however spelt, in English or Hindi); an event is the source when nothing else is given |
| Campaign Name | Campaign (added if new, named as TeleCRM had it) |
| Batch Names | Tags |
| First Call Descripton | A note on the lead's timeline, marked as from TeleCRM |
| Created On | When the lead arrived (day/month/year, India time) |
| Modified On | Stands in for the last call (if its status means someone was called) and the last conversation (if they spoke), so worked leads are not raised as never contacted; also when unanswered leads come back for a retry |
| Lead Link | Link to the TeleCRM record (works until the subscription ends) |
| Lead id | Kept as its TeleCRM id: importing again updates the same lead |
| Date | Kept as written; its meaning varied |
| Assignee name, Assignee Manager name / emailid | Not used (the owner is matched by email; the manager columns are empty) |

"-" and "_" are read as blank. An invalid email is left out with a note,
rather than losing the lead.

### Importing again

Do this with TeleCRM's last export, just before the subscription ends. Choose
**Bring it up to date** (the default for a TeleCRM file):

- Leads already imported are found by their TeleCRM id and updated: status,
  stars, lost reason, missing details, new notes.
- If someone has changed a lead's calling status in TaskFlow since, that is
  kept, and the row says so.
- New TeleCRM leads are added.

### What the rehearsal showed with your file

Rehearsed on the export of 31 Oct 2026, in a scratch database, through the
same code the screen uses:

| | |
|---|---|
| Rows | 688; **all 688 imported**, none rejected |
| Calling statuses | Exactly as in the file: Just Curious 165, Lost 111, Ringing Not Responding 109, Busy 95, Fresh 56, Farmer Interested in Soil Testing 47, Interested 43, Student Who Wants to Start A SDC 21, Job Seeker 17, Won 9, Hot 5, Will Purchase the Device in Rabi 2026 5, Under Negotiation 4, Explore Partnership 1 |
| Lost reasons | All kept: No Need 53, Unknown Reason 31, Unable to Connect 15, Budget Issues 4, two others 3 each, Wrong Number 2; Job Seeker 17 |
| Categories | Retailer 211, Individual 150, FPO 35, **not known yet 292** (mostly unanswered calls where nobody learnt who they are, plus 40 "Other" answers) |
| Services | Clinic set-up 172, Kit 70, Testing service 38 (a lead can want several) |
| States | Normalised, e.g. Maharashtra 103 (31 spelt correctly + 72 "Maharastra"), Gujarat 35 |
| Notes | 460 first-call descriptions on the timelines |
| Owner | All 688 to isha@ekosight.com (when that user exists) |
| Warnings | 9: 2 emails that are not emails (left out); 7 rows sharing an email with another row but kept apart because TeleCRM holds them as different leads (check them with the merge tool if they are the same person) |
| Alarms | No "not contacted yet" notices; stale leads arrived as one digest notice |
| Isha's call list after import | 56 new, 204 to try again (the Ringing Not Responding and Busy leads, whose retry time has passed) |
| Importing the same file again | All 688 found as already there; nothing added twice |

## 4. Cut-over plan

| When | What |
|---|---|
| **Now (November)** | Deploy (with a backup first; see `docs/CRM_ROLLOUT.md`). Create the callers' accounts. Set routing to "Here in TaskFlow". Import the current TeleCRM export. The team calls from TaskFlow's Calling screen; TeleCRM is only for looking things up. |
| **First week** | Check the calling statuses and lost reasons with the team, and rename, add or retire as needed. Decide what *Just Curious* and *Job Seeker* should mean (Q-T1). Set assignment rules if more than one person calls. |
| **December** | Point the website and ad forms at TaskFlow's capture API or hosted form, so no new lead lands in TeleCRM. |
| **Just before the subscription ends** | Export everything from TeleCRM once more and import it ("Bring it up to date"). **Download anything you want to keep that TaskFlow cannot fetch:** call recordings, WhatsApp chats, and any reports or attachments. The *TeleCRM record* links stop working when the subscription ends. |
| **After** | TaskFlow is the only system. Optionally hide the "TeleCRM record" field (Settings → Lead fields). |

## 5. Decisions for you

| | Question | Today's setting |
|---|---|---|
| Q-T1 | **Just Curious** is "keep warm" (out of the call list until someone picks it), and **Job Seeker** closes the lead as lost. Is that how the team uses them? | As described; editable per status |
| Q-T2 | Should unanswered calls retry after 3 h (no answer) and 1 h (busy), stopping after 6 tries? | Yes |
| Q-T3 | Call recordings: which calling provider (Exotel, Knowlarity, MyOperator…)? Without one, calls are logged by the caller and not recorded. | Manual logging |
| Q-T4 | Is bulk WhatsApp to a list needed? It is not built; it needs approved templates and the Meta account (Q2). | Not built |
| Q-T5 | Who else calls besides Isha, and should new leads be shared by turns? | Leads keep their TeleCRM owner; new leads follow the assignment rules |
| Q-T6 | The TeleCRM **Date** column is filled on 52 rows with no consistent meaning. Is it a callback date? If so, it can become a callback when imported. | Kept as written |

## 6. Not verified

- Live calling through a provider and call recording: no provider account yet.
- WhatsApp sends: no Meta account connected.
- Behaviour on real phones: checked in a phone-sized Chromium window, not on
  devices.
- The import against production: rehearsed on a scratch database only. Run it
  on a copy first if you want to see the result before the team does (see
  `docs/CRM_ROLLOUT.md`).
