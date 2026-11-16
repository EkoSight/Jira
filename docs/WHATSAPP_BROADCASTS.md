# WhatsApp broadcasts

One approved WhatsApp template, sent to a list of CRM leads, and only to the
numbers that agreed to WhatsApp messages. It is in **Sales CRM →
Broadcasts**. The routes are in `docs/API.md` under "WhatsApp broadcasts".

The owner chose (16 November 2026):

- **Recipients:** recorded opt-ins only.
- **Approval:** the same as email campaigns.
- **The list:** CRM leads, chosen with the lead list's filters.

## Who agreed: WhatsApp opt-ins

A broadcast goes only to a number that **agreed** to WhatsApp messages and has
**not opted out**. An opt-in belongs to the number, not to one lead, so two
leads with the same number share it.

A number counts as agreed in four ways:

| How | Recorded by |
| --- | --- |
| On a call, in person, or another way (with a note) | a person, on the lead's **WhatsApp** tab: "Record WhatsApp opt-in…" (needs `crm.activity.log`) |
| The tick box on an enquiry form | the form. Settings → Capture: give the form WhatsApp wording, for example "Send me updates on WhatsApp". The box is optional and never ticked for them |
| A "yes" in an import's **WhatsApp opt-in** column | the import. "No" records nothing and never removes an opt-in. Any other word is a warning on that row |
| Having written to us on WhatsApp first | worked out from the messages; nothing is stored |

**An opt-out always wins.** A STOP reply on WhatsApp opts the number out, as
before; so does staff recording "and messages" with a "don't call me". A
number that opted out cannot be given a new opt-in. If the person asks to hear
from us again, an administrator lifts the opt-out first.

An opt-in recorded by mistake is removed with a reason. Recording or removing
one goes on the lead's timeline and in the CRM audit log.

The lead list has a **WhatsApp** filter: "Agreed to WhatsApp" or "Not agreed".
The lead's **Details** tab says where the number stands.

## Making a broadcast

1. **Start it.** Use **New broadcast**, or go to the lead list, filter it,
   and choose **WhatsApp broadcast…**; the filters come with you.
   - Allowed views: Open, Mine, Unassigned, New, Stale, Nurture, Won,
     Converted, Lost and All.
   - The routing queues and archived leads cannot be broadcast to.
2. **The list.** It is exactly the lead list with the same filters.
   - It is taken from the view of the CRM of the person who made the
     broadcast.
   - "In the list" is the same number the lead list shows.
3. **The message.** Choose an approved template.
   - Templates are written and approved in WhatsApp Manager, then synced in
     Settings → Integrations.
   - Broadcasts never send free text.
   - Each blank (`{{1}}`, `{{2}}`…) is filled by one of: first name, full
     name, organisation, district, place, state, the lead owner's name, or
     the same text for everyone.
   - A blank can have an "if empty, use…" text. Without one, a person with
     nothing to fill it is skipped.
4. **Who gets it.** Before anything is sent, the page shows:
   - how many will get it, of how many in the list;
   - everyone else, counted by reason (open each to see who);
   - three sample messages with real values.

**Why someone is skipped:**

| Reason | Meaning |
| --- | --- |
| No full phone number | no number, or too short to have a country code |
| Same number as … | one message per number: the earliest lead keeps it |
| Opted out of WhatsApp | a STOP reply, or staff recorded it |
| No WhatsApp opt-in recorded | none of the four ways above |
| Got a broadcast recently | the number got one in the last 3 days (a setting) |
| Nothing to fill {{n}} | a blank with no value and no "if empty" text |

**Templates a broadcast cannot use yet** are listed with the reason, and
cannot be chosen:

- one that is not approved at Meta;
- one with a header image, video or file;
- one with a blank in its heading or in a button link.

## Approval: like email campaigns

The same permissions and the same approval setting as email campaigns:

| Step | Who |
| --- | --- |
| See broadcasts | `marketing.view` |
| Draft, change, send for approval, send a test | `marketing.manage` |
| Approve, or ask for changes with a note | `marketing.approve`, and not the person who sent it for approval |
| Send now, schedule, pause, resume, retry the failed ones | `marketing.send` |
| Cancel | `marketing.manage` or `marketing.send` |

- **What is approved:** exactly the list's filters, the template and what
  fills each blank (a fingerprint).
- **Changes after approval:** any change to those sends it back to draft, and
  it is approved again. A new name alone does not.
- **The approval setting:** if Settings → Email marketing switches approval
  off, or allows people to approve their own, broadcasts follow the same
  setting.
- **Who is told:** approvers are notified when one is waiting, the sender
  when it is approved or sent back, and both when it finishes or is paused.
- **No new permission was added.** Managers hold these permissions today, and
  members and viewers do not. The Broadcasts tab is hidden from people without
  `marketing.view`.

## Sending

- **Send now** or **Schedule** (within 60 days).
- **Who gets it is worked out when sending starts**, from the list as it is
  then. Each number is checked once more just before its message goes. A
  number that opted out, or lost its opt-in, since then is skipped with the
  reason.
- **Never twice:** each message has its own key, so a retry, a restart or two
  servers never send one twice.
- **The background sender** sends a batch about every 30 seconds:
  - only inside the **sending hours** (09:00–20:00, company calendar);
  - only up to the **daily limit** (250 broadcast messages in any 24 hours,
    across all broadcasts).

  Outside them it waits, and the page says why.
- **Ten refusals in a row** from WhatsApp pause the broadcast and tell the
  sender, with WhatsApp's reason. Ten in a row usually means a problem with
  the number, the template or the limit.
- **Pause, resume, cancel:** cancelling skips everything not yet sent, with
  the reason. A message WhatsApp already accepted cannot be called back.
- **Retry the failed ones** puts back the messages WhatsApp did not accept
  (up to five tries each). A message WhatsApp accepted is never sent again.
- **Send me a test** sends the template to your own phone (from your
  profile), with the first person's values. It is not counted, and needs no
  approval.
- **On the lead:** each message goes on the lead's timeline, like any
  WhatsApp message.

## What happened

| Count | Means |
| --- | --- |
| Accepted by WhatsApp | Meta took the message |
| Delivered / Read | from WhatsApp's status updates, as they arrive. A person can switch read receipts off |
| Replied | a WhatsApp message from that number within 7 days after the broadcast |
| Failed | not accepted, or failed later; grouped by WhatsApp's reason |
| Skipped | with the reason |
| Still to send | waiting for the sending hours, the daily limit or the next batch |
| Opted out after | the number opted out after the broadcast |

"See each person" lists everyone with what happened to them.

## Settings

Settings → Integrations → **WhatsApp broadcasts** (`crm.settings`):

| Setting | Default |
| --- | --- |
| Broadcasts on | yes. Off hides the tab's contents and the routes answer 404. Nothing is lost |
| Daily limit (any 24 hours) | 250, Meta's starting messaging limit. Set it to the number's limit shown in WhatsApp Manager |
| Sending hours | 09:00 to 20:00, company calendar |
| Skip a number that got a broadcast in the last … days | 3 (0 allows one a day) |

Messages per pass of the sender (40) is a setting without a screen.

## Data

Migration `042_whatsapp_broadcasts.sql` is additive only:

- **New tables:**
  - `crm_wa_optins`: one active opt-in per number, with how, a note, who and
    when; removal keeps the row;
  - `crm_wa_broadcasts`;
  - `crm_wa_broadcast_recipients`.
- **New columns:**
  - `crm_wa_messages.broadcast_id`;
  - `crm_capture_forms.whatsapp_optin_text`.
- **Defaults:** new settings defaults under `crm.sales.whatsapp.broadcasts`.

Nothing existing is changed. Leads keep their general `consent` (from forms)
as before. That consent is not a WhatsApp opt-in.

## Defaults chosen while building (say if any should change)

- **A "don't call me" alone does not block WhatsApp broadcasts.** It is a
  calls opt-out, as before; staff tick "and messages" to opt out of
  WhatsApp too.
- **Writing to us first counts as agreeing.** Leads who wrote to the business
  number get broadcasts unless they opt out.
- **Sending hours** are 09:00–20:00, and the **gap** is 3 days.
- **The list uses the maker's CRM view**, so a caller who can see only their
  own leads can only broadcast to them.

## Not available in this build

- Templates with a header image, video or file, or with blanks in the
  heading or button links.
- Lists of marketing contacts or organisation contacts: CRM leads only, as
  chosen.
- Free-text broadcasts: WhatsApp allows only approved templates outside the
  24 hours after someone writes.
- Per-message cost estimates.

## Not verified

- **Real sending through Meta:** no WhatsApp Business account is connected.
  Every test and the browser walk-through used a stand-in for Meta's Graph
  API inside the process, so no message left the machine.
- **Meta's actual limits and errors on a real number:** quality rating,
  messaging tier, and marketing-message frequency caps.
- **Delivered, read and replied counts from real WhatsApp traffic:** they were
  tested with made-up webhook events.
