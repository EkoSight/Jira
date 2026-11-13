# Sales CRM — lead details, calls and follow-ups: findings and plan

For Isha and everyone who works a long list of leads each day. The goal: the
next action is obvious, and every number on screen agrees with the records
behind it.

The production database was **not** examined: lead 692 and lead 693 were read
neither from the live server nor from a copy. Every finding below comes from
the code, and every fix was tested against a sandbox with made-up leads. Each
finding is marked:

- **Existing:** works today, kept.
- **Confirmed defect:** reproduced in code or in a test.
- **Hypothesis:** likely, but it needs the production rows to confirm.

## 1. Findings

### Calls

| | Finding |
|---|---|
| Existing | A call is a row in `crm_calls` with its own id. Each manual call also puts one `CALL` entry on the lead timeline, keyed `call:<id>`, so the timeline cannot show the same call twice. |
| Confirmed defect | **No protection against repeat submissions.** Saving "How did the call go?" (`POST /leads/:id/call-status`) or "Log call" (`POST /calls`) a second time — a double tap, a retry after a slow or dropped response, or a second tab — records a second call. The lead row lock only puts the two submissions in order; both succeed. |
| Confirmed defect | **The form still looks unsaved after saving.** On a lead's page, "How did the call go?" keeps the chosen outcome and the note after Save. It resets only when the lead changes. Pressing Save again, or editing the note "to correct it" and saving, records another call. |
| Confirmed defect | **A worked callback comes straight back.** In the call list, a lead with a callback due comes first. "Save and next" logs the call but leaves the callback open, so the same lead is first again. |
| Confirmed defect | **Four ways to say a call happened, and they do not agree:** the outcome form, the "Log call" modal, completing a "Call" follow-up, and a timeline activity of type CALL. Completing a Call follow-up writes a `CALL` timeline entry with **no** call record. "Log call" records a call but does **not** update the lead's call count, last-called time or calling status. So the "N calls" on the lead, the Calls list and the timeline can each say something different. |
| Confirmed defect | **Calls cannot be opened or edited.** Times show to the minute, with no seconds and no call id. A correction can only be made by logging another call. |
| Confirmed defect | **Imported attempts have no call records.** TeleCRM imports set the lead's attempt count and last-called time without any call record. Reports add these imported counts to live calls. |
| Hypothesis | **Lead 693** (three identical calls at 5:15 PM on 13 Nov) fits the first three defects: repeat saves of a form that still looked unsaved, or the call list putting the same lead first again. **Lead 692** (two calls at 5:12 PM with different notes) fits saving again to "fix" a note, or one call logged plus one Call follow-up completed. To confirm, run the review list (§4) on the server. It shows each entry's call id, when it was created to the millisecond, who made it, and whether it came from a call record, a follow-up or the timeline. |

### Location

| | Finding |
|---|---|
| Existing | Leads have only `city`, `state` and `country`, tucked under "More details". States are normalised against the 36 states and union territories, and anything else is kept as typed, with a warning. |
| Confirmed defect | **District goes into the City field.** Imports map a "District" column to `city`, so for TeleCRM leads, City often holds a district. |
| Confirmed defect | **Missing parts of a location.** There is no district, block or tehsil, address or PIN code on a lead, so none of these can be filtered or exported. |
| Decision | **No district list is bundled.** No reliable district list is in the code. The District picker suggests districts already recorded for the chosen state and accepts new ones, so nothing is guessed. A verified list, for example one exported from the government's Local Government Directory, can be added as a data file later. |

### My Day and the lists

| | Finding |
|---|---|
| Confirmed defect | **"Retry due" counts retries that are not due.** The chip shows every lead with *any* retry scheduled, including retries for later. My Day ignores retries altogether, so My Day can say "Nothing due now" while "Retry due" shows leads. This is the discrepancy that was observed. |
| Confirmed defect | **New leads stop at 50.** My Day's "New leads waiting for a first contact" is capped at 50, with no next page. The Leads list pages correctly (50 a page). |
| Confirmed defect | **Missing work is not shown.** My Day does not show leads with no next action, unassigned leads or stale leads. |

### Reminders and Chat

| | Finding |
|---|---|
| Existing | A follow-up gets one reminder, 15 minutes before by default, as an in-app notification, from the server's timer, so it does not need an open tab. Overdue follow-ups are escalated to managers. |
| Confirmed defect | **Rescheduling resets the reminder.** Moving a follow-up always sets the reminder back to 15 minutes, whatever was chosen. |
| Confirmed defect | **Follow-up reminders never reach Google Chat.** The reminder type is not on Chat's list of message types. |
| Existing | Google Chat sends direct messages through an outbox with dedupe keys and retries, and DM spaces are linked to people. A morning summary of open tasks already exists. |
| Missing | There is no follow-up digest with lead context. There is no choice of how long before a follow-up to be reminded, and no delivery status shown for reminders. |

### Reports, owners, access

| | Finding |
|---|---|
| Confirmed defect | **The calling report mixes things up.** It counts imported attempts as calls, and "connected" is the only measure of a conversation. |
| Review needed | **Owner pickers hide former staff.** They list active people only. A lead owned by someone switched off shows just their name, which can look like a current person. Reported for an administrator; no permission was changed. |

## 2. What changes (screens)

- **Lead page: one way to log a call.** At the top there is a single card,
  **Call → How did it go? → Notes → Next step**:
  - "Call" opens the phone's dialler and does not claim a conversation took place.
  - Saving shows "Call #123 saved at 5:15:42 PM", clears the form, and closes any callback that was due.
  - Leaving with unsaved text asks first.
  - The separate "Log call" button is removed for leads. It stays for organisations and deals.
  - A short line explains the difference between the call outcome (what happened on this call), the lead stage (where the lead stands) and the deal stage (where the sale stands). A call never marks a lead Won or creates revenue by itself.
- **Calls tab.** Every call shows its id, date and time to the second, who made it, outcome, length and note. **Open** shows the whole call and its edit history. **Edit note** changes the note, keeps the earlier version, and does not add a call. A manager can mark a call as an *accidental repeat* with a reason. It stays visible, struck through, and is no longer counted. This can be undone.
- **Location section** in New lead and Edit, not hidden:
  - State (searchable, the 36 states and union territories).
  - District (suggestions per state, free text allowed, or "Not known").
  - City, town or village; block or tehsil; two address lines; PIN code (format checked only).
  - A missing value shows "Not provided".
  - The lead list shows the location and can filter by state, district, PIN or "location missing".
  - The lead page offers suggestions to confirm (from an import's District column, or a state or PIN mentioned in notes). Nothing is filled in by itself.
- **My Day** becomes one prioritised queue, with a count for each group and pages:
  1. overdue follow-ups;
  2. due today;
  3. retries due now;
  4. new leads nobody has called;
  5. open leads with no next action;
  6. unassigned (for people who assign);
  7. gone quiet.

  Each group links to the Leads list filtered the same way, so the totals match.
- **Follow-up reminders:**
  - Each person chooses defaults in Settings → My account: any of 30, 15, 10 or 5 minutes before, in the app and/or Google Chat.
  - A single follow-up can override them.
  - Each follow-up shows its time with the timezone, "due now", "overdue" and each reminder's delivery status.
- **Daily follow-up summary in Google Chat:**
  - Settings → Sales CRM, for administrators: on or off, test mode, time, working days and holidays, plus per-person exceptions.
  - A preview of any person's summary, and a test send to yourself.

## 3. Data model (migration 033, additive only)

| Table | Change |
|---|---|
| `crm_calls` | Adds `request_id`, unique per person who made it. Adds edit fields (`edited_at`, `edited_by`, `edit_count`) and accidental-repeat fields (`voided_at`, `voided_by`, `void_reason`). |
| `crm_call_edits` | **New.** Every change to a call's note or length, with the value before and after. |
| `crm_submissions` | **New.** One row per form submission (person + request id). A repeat returns the first answer. |
| `crm_leads` | Adds `district`, `block`, `address_line1`, `address_line2` and `pincode`. `city` keeps its meaning: city, town or village. |
| `crm_location_suggestions` | **New.** Proposed location values, with where each came from, waiting for a person to accept or reject. |
| `tasks` | Adds `reminder_offsets` and `reminder_channels`: a single follow-up's own choice. |
| `crm_reminder_prefs` | **New.** Each person's default reminders. |
| `crm_followup_reminders` | **New.** Every planned reminder: the follow-up time it was planned for, the offset, the channel, its status (pending, sent, failed, cancelled or skipped), attempts and error. A reminder for an earlier time can never be sent. |
| `crm_digest_exceptions` | **New.** Per-person exceptions to the daily summary, set by administrators. |
| `crm_digest_log` | **New.** One row per person per day: sent, failed or skipped, and why. |

**Existing data.** No existing row is changed by the migration:

- City and state stay as they are.
- Existing calls keep their ids and history.
- Follow-ups created before the update keep their single 15-minute in-app reminder until they are moved.

**Rollback.** Every change is a new column or table. Going back means
deploying the previous version; the new columns are then ignored and nothing
is lost. A planned reminder that is not sent is just a row.

## 4. Repeated calls in production: reviewing them

```
npm run crm:call-review -- --lead 693 --lead 692        # read only
npm run crm:call-review -- --since 2026-11-01            # every lead, from a date
```

- **It only reads.** The review runs in a read-only database transaction that
  is always rolled back.
- **It lists every call entry on those leads:**
  - the call id, or "no call record" for a timeline-only entry;
  - when it was created, to the millisecond;
  - who made it;
  - the outcome and duration;
  - a fingerprint of the note;
  - the linked follow-up;
  - which path made it (outcome form, Log call, follow-up, provider, import).
- **It groups suspected repeats:** same lead, same person, created within 120
  seconds. Each group is labelled:
  - **likely accidental:** same outcome and note, seconds apart;
  - **different notes:** probably a correction saved as a new call;
  - **needs a person:** anything else.
- **Nothing is deleted or merged.** Calls are never merged because the lead and
  the time match. After you review the list, a manager can mark individual
  calls as accidental repeats in the app, with a reason. The call stays visible
  and the change can be undone. No production data is changed by this work.

## 5. Order of work

1. **Calls:** stop new repeat calls (request ids, a disabled button while
   saving, a form that clears after saving, closing the callback that was
   due); one workflow; open and edit a call; the review list.
2. **Location:** fields, the Location section, filters, list and detail, import
   and export, reviewed suggestions.
3. **My Day:** a prioritised queue with pages, counts that match the Leads list,
   and "Retry due" meaning due.
4. **Reminders:** offsets, channels, delivery status, cancelling and
   re-planning when a follow-up changes.
5. **Daily Chat summary:** preview, test mode and the log first; live delivery
   only when an administrator switches it on.
6. **Reports and export:**
   - Call attempts, unique leads called, conversations, qualified, orders and verified revenue are reported separately.
   - Imported counts are labelled as imported.
   - The export gains calling status, lead stage, location, next follow-up or retry, latest note and a call count.

## 6. Decisions for an administrator

- **District list.** Whether to load an official district list for the State → District picker.
- **Daily summary.** Whether to switch on the daily Chat summary, at what time,
  and for whom. It is off, and in test mode, until someone decides.
- **Reminders.** The default reminders for everyone (15 minutes, in the app,
  unless changed), and whether Chat reminders are allowed.
- **Repeated calls.** Which suspected repeats to mark as accidental, after
  reviewing the list.
- **Former owners.** Leads owned by switched-off accounts. They are listed in the
  owner review, and nothing is reassigned automatically.

The results of the work are listed in `SALES_CRM_CALLS.md`: what was tested,
how, and what is still unverified.
