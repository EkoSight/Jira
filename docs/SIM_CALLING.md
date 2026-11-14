# Calling leads from company phones

Salespeople call leads and customers from company Android phones, on company
SIMs. TaskFlow records each call once, with its real length, keeps the
recording where the phone makes one, and respects people who ask not to be
called or recorded.

**Where things stand**

| Part | State |
| --- | --- |
| Server: calls, lengths, recordings, opt-outs, complaints, phones | Built and tested (`server/tests/simCalling.test.js`: 22 tests; full server suite passes) |
| Web screens: Call button, call panel, "How did it go?", settings | Built and tested in a browser walk-through (desktop and phone, light and dark, accessibility checks) |
| Android app (`apps/android`) | Written. Its logic has unit tests, and its Android code was type-checked. **Not yet built into an APK or tried on a phone**: there was no Android SDK on the build machine |
| Real-phone checklist (below) | Not yet run |
| Recordings | **Off**, until an administrator switches them on after the phone check |

The plan this was built from is `SIM_CALLING_PLAN.md`.

---

## For the people calling

1. **Tap Call** on a lead, on My Day, on a follow-up, on an organisation's
   contact or on a deal.
   - In the **TaskFlow Android app**, the company SIM dials at once.
   - In a **browser**, the phone's own dialler opens.
   - The number is always shown as text too, so it can be copied.
2. **A panel stays at the bottom** while the call lasts. It shows who you are
   calling and since when. When recordings are on, it shows the sentence to
   say first, in English or Hindi:
   *"Hello, this is {your first name} from {company}, calling about your
   enquiry. This call may be recorded for quality and training."*
3. **Come back and press "How did it go?"** It fills in the same call; it
   never adds a second one.
   - In the app, the panel says *Connected · 3m 12s* or *Not answered* as soon
     as the phone reports the call, and the length is taken from the phone.
   - In a browser, TaskFlow estimates the length from the time you were away
     and fills in "About 4 min, estimated". Change it if you know better: it is
     then saved as typed.
4. If they say so:
   - **"They don't want this recorded"** on the panel: this call's recording
     is not kept, and later calls with this lead or contact are not recorded.
     The call itself goes on.
   - **"Asked not to be called again"** in the form (and **"and no WhatsApp
     or SMS"**): the number goes on the opt-out list. Its retries, call-backs
     and place in the call list end.
   - **"Customer complained…"** on the lead or the call: write what they said.
     The number is opted out and administrators are told.
5. **"Send the privacy notice"** on the panel opens the phone's share sheet,
   with the link to the notice, for WhatsApp or SMS. Nothing is sent
   automatically.
6. **"Attach recording"** on the panel or the call's details, for a recording
   the phone did not hand over by itself. On a phone with the installed web
   app or the Android app, you can also **share** a recording from the phone's
   recordings to TaskFlow. TaskFlow asks **"Which call is this?"**, suggests
   the call whose time fits, and attaches nothing until you confirm.
7. A call you started but never described stays at the top of My Day as
   **"Dialled: say how it went"**. At the end of the day it closes as
   "Dialled, outcome not given".

## How a call is kept

- **Tapping Call records the call first** (`POST /sales/calls/start`), then the
  phone dials. The call starts as `DIALLED`, with the time it was dialled and
  how (`DIALLER` in a browser, `ANDROID_APP` in the app).
  - TaskFlow refuses the call when the number opted out, when the lead already
    had the day's number of attempts, or, outside calling hours, unless a
    reason is given. Two exceptions are allowed, and labelled: a call-back the
    lead asked for, and a call back to a number that rang the company in the
    last 24 hours.
  - With no connection, the phone still dials. The call is sent to TaskFlow
    when the connection is back, with the time it was dialled.
- **"How did it go?" and Log call fill in that call**: outcome, notes, length,
  next step. A form saved without the call's id still finds it: the person's
  open call on the same record from the last 12 hours.
- **The attempt count changes exactly once per call**, however many times
  the call is described or reported by the phone.
- **The length comes from the best source**:
  phone's call log > recording > typed > estimated. A correction by a person
  is kept as *corrected*, with its history. Screens and reports label where
  each length came from, and the calling report adds talk time up separately
  for measured, typed and estimated lengths.
- **When the outcome and the phone disagree** ("Connected", but the phone says
  nobody answered), both are kept and the call is listed for a manager in
  Settings → Repeated calls to review.
- Calls from before this work, and calls from Exotel, are unchanged.

## What leaves the phone

Only calls with leads and customers the person may see. Every other call stays
on the phone and is never sent.

- Each day the app downloads the numbers it may send, as **salted hashes**:
  `HMAC-SHA256(salt, number)`, with a salt made per person per day from a
  server secret. The app hashes each call-log number the same way and sends a
  call only when the hash matches. The list never holds phone numbers.
- The server checks again: a number that is not a lead's or contact's within
  the person's view is refused, and nothing about it is stored.
- Only calls on the **company SIM** are looked at, on phones with two SIMs.
- Opted-out numbers are in a separate list, so the app can refuse to dial them
  even offline, and still send a call they make to the company.
- The phone signs in with a **device token** that reaches nothing in TaskFlow
  except the phone endpoints (`/api/taskflow/device/…`). An administrator can
  block a phone at once.
- The app keeps its data in its private storage, excluded from backups and from
  moving to a new phone.
- The app asks for **no storage permission**. It reads recordings only in the
  one folder the person picks, through the access that choice gives. It removes
  a file only after TaskFlow confirms it holds exactly that file (same SHA-256),
  or when the lead asked not to be recorded.

## Recordings

**Recording stays off until an administrator switches it on.** That needs:

- the company name, the opening sentence, and the privacy notice's details
  filled in;
- the privacy notice published.

How a phone's recordings reach TaskFlow depends on its phone app (its
"dialler"). Android does not let ordinary apps record calls since Android 10;
TaskFlow relies on the phone's own dialler.

| Phone | Dialler | How recordings reach TaskFlow |
| --- | --- | --- |
| Samsung | Samsung's Phone app (`com.samsung.android.dialer`) | Automatic recording saves files to a folder: **picked up automatically** (expected; confirm on a test call) |
| OPPO (ColorOS) | ODialer, made the default phone app | Saves files to a folder: picked up automatically, once confirmed on a test call |
| Motorola | Google's Phone app (`com.google.android.dialer`) | Keeps recordings inside the app: **shared by hand** from the call history |
| Anything else | — | **Not confirmed** until an administrator checks it on a test call |

An administrator confirms each dialler in **Settings → Calls from company
phones → Phones & the app**, with where its files are saved (shown in the
app's setup).

- **"Do not record calls with this lead"**, on the lead (or contact): later
  recordings are refused; a change is recorded in the audit log.
- **Who can listen:** the person who made the call, and people with the
  recordings permission, within what they may see. The player streams through
  a link that lasts 10 minutes. Downloads need the recordings permission. Every
  play and download is in the audit log.
- **Kept for 6 months** (`recordingRetentionMonths`), counted in calendar
  months from the call, India time. Then the audio file is deleted; the call,
  its notes and outcome stay, with when and why the recording went.
- **"Keep: needed for a dispute"** (administrators): retention skips that
  recording until the mark is removed. Both changes are audited.
- Exotel-era recordings keep their own switch and their own retention setting
  (`recordingRetentionDays`, 365 days unless changed).
- A recording is checked on the server: its type (m4a, mp3, aac, amr, 3gp,
  ogg/opus, wav), its size, and its length, measured on the server. A file much
  longer than the time since the call started is refused as probably the wrong
  file.

## Telling people, and "don't call me"

All words are in Settings, in English and Hindi, never in the code. Placeholders
such as `{company}` and `{first_name}` are filled from Settings and the signed-in
person. **The wording is a draft for the owner and their adviser to approve; it
is not legal advice.**

- **The opening sentence** is shown on the call panel when recordings are on.
- **The privacy notice** for leads is a public page, in English and Hindi, at
  `/api/taskflow/s/privacy` (`?lang=hi` for Hindi), once published. Edits are a
  draft until **Publish**. Every hosted enquiry form shows, by its Send button:
  *"By sending this, you agree that we may call you about your enquiry. Calls
  may be recorded."* with links to the notice. **Website forms that send leads
  through the capture API should show the same line and link.**
- **The company phone policy** is shown in the app's setup with "I understand".
  Until it is accepted, the app does not dial through TaskFlow or send
  anything. Changing its words makes a new version, and everyone is asked again.
  The phone list shows who has not accepted the current version.
- **Opt-outs** are refused on every path: the Call button and `/calls/start`,
  the call list and My Day, retries, automation, and the app (even offline).
  Lifting one needs the settings permission and a reason, and is audited. An
  opted-out lead may still call the company: a missed call becomes a follow-up
  marked "Opted out earlier: they called you", and calling back is allowed for
  24 hours, labelled as such.
- **At most 3 attempts per lead per day** (retries included), except a call-back
  the lead asked for.
- **Calling hours** (09:00–21:00 on working days by default): outside them a
  call needs a reason, which is listed in the weekly review.
- **Complaints**: three or more within 10 days raise a warning to
  administrators. This is an early signal only: complaints made to the telecom
  operator are not visible to TaskFlow.
- **The weekly review** reaches administrators on Monday morning (the bell):
  new opt-outs, complaints, calls outside hours, leads that hit the daily limit.
- **A do-not-call list** (for example TeleCRM's "do not call" leads) can be
  imported in Settings: paste or choose a CSV, check the preview, then add.

## Rollout guide for an administrator

In this order. Do not skip the phone check before switching recordings on.

1. **Deploy.** Migration 036 adds tables and columns only; nothing existing is
   changed or removed.
2. **Settings → Sales CRM → Calls from company phones → Recording & rules.**
   Check that recordings are kept for **6 months**. A value saved earlier
   overrides the default, so look at what is saved. Leave recordings off.
3. **Words & privacy notice.** Type in the company name, the legal name,
   address and contact for questions and complaints, from the separate sheet
   the owner holds. Those details never go into the code repository. Read the
   opening sentence, the staff policy and the notice in both languages;
   **Preview**, then **Publish**.
4. **Build and sign the Android app** (`apps/android/README.md`) and upload it in
   **Phones & the app**.
5. **One phone of each make first** (Samsung, OPPO, Motorola). Install the app,
   go through its setup, and run the real-phone checklist below. For Samsung
   and OPPO, confirm the dialler in **How each phone app records**, with the
   folder it saves to.
6. **Switch recordings on** in Recording & rules.
7. **The other phones:** install through the company's device management
   (preferred), or the private download in Settings → My account. Each person
   signs in and follows the setup.
8. **For the first weeks,** watch **Phones & the app** (not synced for a day,
   no recordings, warnings, policy not accepted) and the weekly review.

## Real-phone checklist (not yet run)

Run on one phone of each make, with a made-up test lead whose number is a
second company phone. Never call a real lead while testing.

| Check | Samsung | OPPO | Motorola |
| --- | --- | --- | --- |
| The signed release installs (device management or private link) | ☐ | ☐ | ☐ |
| Setup: sign in, accept the policy, choose the company SIM, allow permissions, battery unrestricted | ☐ | ☐ | ☐ |
| Call from a lead dials at once on the company SIM (not the other one) | ☐ | ☐ | ☐ |
| The panel turns to *Connected · length* within a minute; the length matches the phone's call history | ☐ | ☐ | ☐ |
| An unanswered call shows *Not answered* | ☐ | ☐ | ☐ |
| A call to or from a number that is not a lead does not reach TaskFlow (check the calls list) | ☐ | ☐ | ☐ |
| A missed call from the test lead makes a "Call back" follow-up for its owner | ☐ | ☐ | ☐ |
| A call dialled from the phone app directly (not TaskFlow) to the test lead appears within 15 minutes | ☐ | ☐ | ☐ |
| Recording: found in the chosen folder, uploaded, the phone's copy removed | ☐ | ☐ | n/a |
| A "do not record" lead: the phone's recording removed, not uploaded | ☐ | ☐ | n/a |
| Share by hand: Phone app → Recents → the call → recording → Share → TaskFlow → "Which call is this?" | n/a | n/a | ☐ |
| Sync keeps working with the screen off for an hour, after a restart, and after the app is swiped away | ☐ | ☐ | ☐ |
| Airplane mode: Call still dials; the call reaches TaskFlow when back online, with its time | ☐ | ☐ | ☐ |
| Airplane mode: an opted-out number is refused | ☐ | ☐ | ☐ |
| Hand the phone to someone else (Settings), then sign in as the next person: earlier calls stay with the first | ☐ | ☐ | ☐ |
| A newer app version uploaded in Settings is offered in the setup page and installs over the old one | ☐ | ☐ | ☐ |

Write down, per model, where recordings are saved and the dialler's package
name (shown in Settings → Phones), and confirm the dialler there.

## Make by make

- **Samsung.** Phone app → ⋮ → Settings → Record calls → Auto record calls.
  Turn Wi-Fi Calling off for the company SIM: calls over Wi-Fi may not be
  recorded. Recordings are usually in a "Recordings → Call" folder; confirm on
  the phone.
- **OPPO.** Install ODialer, make it the default phone app, turn on its auto-record,
  make one test call so its recordings folder exists, then choose that folder in
  the setup. The app warns if the default phone app changes.
- **Motorola.** Google's Phone app keeps recordings inside itself, so they are
  shared by hand. Where the Phone app offers it, let it delete old recordings by
  itself, so they do not stay on the phone past the six months.
- **Battery.** Every make stops background work to save battery. The setup page
  asks for "Unrestricted"; the app's README lists the menus per make.

The app warns the person and administrators when three connected calls in a row
had no recording on a phone that should save them while recording is on
(usually auto-record switched off, Wi-Fi Calling on, or ODialer no longer the
default), and when the default phone app changes.

## The company phone policy: longer text for HR (draft)

*A draft for HR and the owner to adapt; not legal advice.*

> **Company phones and calls with leads and customers**
>
> **What this covers.** Company phones and company SIMs given to staff for
> sales and customer work.
>
> **What is logged.** Calls on the company SIM with leads and customers
> recorded in TaskFlow: the time, the length, the outcome and the notes you
> write, and a recording of the call where the phone makes one.
>
> **What is never logged.** Calls with anyone who is not a lead or customer in
> TaskFlow. The phone checks every call against TaskFlow's list and sends
> nothing about the others. TaskFlow does not read messages, photos or other
> files on the phone.
>
> **Who can listen.** You can listen to your own calls. Managers with the
> recordings permission can listen to calls of the people they manage, to
> check quality, train the team and settle complaints. Every time a recording
> is played or downloaded, it is noted.
>
> **How long.** Recordings are kept for 6 months and then deleted, unless one
> is needed to settle a complaint or dispute. The phone's own copy is removed
> once TaskFlow has it.
>
> **Respecting customers.** Say the opening sentence on every call. If someone
> does not want to be recorded, press "They don't want this recorded". If
> someone asks not to be called, tick "Asked not to be called again". Never
> call a number on the opt-out list, except to answer them when they called
> the company.
>
> **Personal calls.** Please use your own phone for personal calls.
>
> **Questions.** Ask your manager, or HR.

## Limits

- TaskFlow cannot record calls itself on Android; the phone's dialler must.
  A model whose dialler does not record leaves calls without recordings, and
  they can still be logged with their length.
- In a browser (no app), the length is an estimate and the recording must be
  attached by hand.
- TaskFlow cannot see complaints made to the telecom operator. India's 2025
  telecom rules (TRAI) act on complaints against numbers that make unwanted
  calls, which is why opt-outs are enforced everywhere and complaints raise an
  early warning.
- India's data protection rules (the DPDP Act, with its rules notified in
  November 2025 and most duties starting later) apply to leads' details and
  recordings. The privacy notice is a draft to check with an adviser.

## Where it is in the code

| What | Where |
| --- | --- |
| Data (additive) | `server/src/db/migrations/036_sim_calling.sql` |
| Starting and describing calls, lengths | `server/src/services/sales/phoneCalls.js` |
| Recordings: storing, playback links, holds, retention | `server/src/services/sales/callRecordings.js`, `audioLength.js` |
| Opt-outs, complaints, notice, policy, weekly review | `server/src/services/sales/callingCare.js`, `callRules.js` |
| Phones: sign-in, numbers, call log, warnings, the app's download | `server/src/services/sales/phoneDevices.js` |
| Routes | `server/src/routes/salesPhone.js` (people), `device.js` (phones), `salesPublic.js` (notice, links) |
| Call button, panel, pending calls, player, complaint | `client/src/components/sales/PhoneCall.jsx` |
| Settings → Calls from company phones | `client/src/components/sales/PhoneSettings.jsx` |
| Phone setup, "Which call is this?" | `client/src/pages/PhoneSetup.jsx`, `ShareRecording.jsx` |
| The Android app | `apps/android` (see its README) |
| Shared phone-number answers | `shared/callingVectors.json` |

## Tests

- **Server:** `server/tests/simCalling.test.js`, 22 tests in a throwaway schema
  with made-up people, numbers and company details: one record per call, double
  taps and offline starts, the length's sources, recordings (off until switched
  on, type, size, wrong file, measured length, playback rights, ranges,
  retention, holds), the phone's side (device tokens, policy first, salted
  numbers, call-log entries, incoming and missed calls, blocking, hand-over,
  recordings, warnings), opt-outs, complaints, the daily limit, calling hours,
  the weekly review, the import, and that running migration 036 again changes
  no call. The full server suite passes.
- **Client:** `client/tests/phoneCalls.test.js` (the Call path, the estimate,
  "Which call is this?", targets, makes of phone).
- **Android logic:** `apps/android` → `npm run test:java` (JUnit, no SDK
  needed): number rules against the shared answers, which call-log entries are
  sent, matching recordings, versions.
- **Browser walk-through** (local, made-up data; the app stood in for by a fake
  phone bridge): the Call button and panel, the estimate, an opted-out lead,
  the whole phone setup, a call reported by the phone, a shared recording and
  its playback, every settings tab and the public notice, desktop and Pixel
  sizes, light and dark. 33 checks passed, with no page errors and no axe
  (WCAG 2 A/AA) violations in any of the 11 views checked.
- **Not tested:** the Android app on a real phone (see the checklist), and the
  signed release build.

## Decisions for the owner

- **The number leads see** on the privacy notice and the **email for questions
  and complaints**: typed into Settings from the owner's sheet.
- **The company name leads hear** (Settings → Words).
- **The Android application id** (`com.ekosight.taskflow` unless changed before
  the first install) and who holds the signing key.
- Two points interpreted while building:
  - an unknown dialler is "not confirmed" until an administrator checks it;
    Samsung's and Google's are pre-filled as *expected*, not confirmed;
  - the new recordings have their own switch (`deviceRecordings`, off); the
    Exotel-era `recordings` switch keeps governing provider recordings only, so
    nothing existing changes silently.
