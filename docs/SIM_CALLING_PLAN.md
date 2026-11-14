# Calling from company phones: plan

> **Built.** What was built, how it was tested and how to roll it out: `SIM_CALLING.md`. This plan is kept as written before building; where they differ, `SIM_CALLING.md` describes what exists (for example, sample audio is generated in the tests rather than with ffmpeg, and the app uses Android's JobScheduler rather than WorkManager).

This plan is written from the brief "calling leads from company Android phones and
SIMs". Results and the test record go in `SIM_CALLING.md`.

**Settled by the owner:**
- no calling provider;
- company Android phones (Motorola, Samsung, OPPO) with company SIMs;
- only calls with leads and contacts are tracked;
- calls are recorded, and recordings are kept for 6 months;
- staff acknowledge a phone policy, and leads get a privacy notice;
- opt-outs and complaints are taken seriously.

The real company details are typed into Settings by an administrator after
deploying. They are not in this repository.

## What exists

| Piece | Where | Kept as is? |
|---|---|---|
| Calls table | `crm_calls` (migrations 027, 033): provider, status, numbers, lead / account / contact / deal, times, `duration_sec`, `recording_ref`, outcome, notes, `request_id`, `recorded_via`, edits, void | Kept; columns added |
| Typed-in calls | `recordManualCall()` / `logCall()` in `server/src/services/sales/comms.js` (lines 138–197) | Kept; can now fill in a call that was started from TaskFlow |
| "How did the call go?" | `setCallStatus()` in `server/src/services/sales/calling.js` (256–351) | Kept; can now save onto an existing call |
| Double-submit protection | `claimSubmission()` / `settleSubmission()` in `callRecords.js` | Reused |
| Corrections and repeats | `editCall()` / `voidCall()` / `callReview()` in `callRecords.js` | Reused; a corrected length is labelled as corrected |
| Opt-outs | `crm_optouts`, `optOut()` / `liftOptOut()` in `comms.js`, `POST /sales/optouts` | Reused; columns added |
| Provider events | `applyCallEvent()`, Exotel | **Not touched**, switched off |
| Provider recordings | `GET /sales/calls/:id/recording` (Exotel only), retention in `automation.js` (~512) | **Not touched**; new recordings live in their own table |
| Private files | `UPLOAD_DIR`, photos pattern (`services/photos.js`) | Reused |
| Hosted enquiry forms | `server/src/routes/salesPublic.js` | Get the privacy line and link |

## The problems, confirmed in the code

**S1. Two records for one call.**
- `setCallStatus` always calls `recordManualCall(... recorded_via: 'OUTCOME_FORM')`
  (`calling.js:286`).
- So does the follow-up "Done" path (`followups.js:182`), and "Log call"
  (`comms.js:143`).
- Once a call also comes from the phone's call log, or was started in TaskFlow,
  each of these would add a second row.

**S2. No call length on leads.**
- The outcome form `CallStatusForm` (`client/src/components/sales/Calling.jsx:65`)
  never sends `duration_sec`.
- Only "Log call" (organisations and deals) and corrections can set one.

**S3. No record that a call was started.** Every Call button is a bare `tel:` link:
- `Calling.jsx:238`;
- `SalesLead.jsx:279`;
- `WorkQueue.jsx:51`;
- `SalesWork.jsx:47`;
- `CrmPeople.jsx:17`;
- `parts.jsx:561`.

**S4. Opt-outs and calling hours are not checked when dialling.**
- Only Exotel's `clickToCall` checks the opt-out (`comms.js:311`).
- No path knows about calling hours.

**S5. Recording is on by default.**
- `sales.calls.recordings: true` (`services/settings.js:247`).
- There is no "do not record" choice, and no announcement rule.
- Only provider (Exotel) recordings are kept today, and no provider is connected.
  Changing this default therefore affects no existing data.

## Data changes: migration 036, additive only

**`crm_calls`, new columns:**
- `talk_sec`;
- `duration_source` (`DEVICE_LOG` / `RECORDING` / `TYPED` / `ESTIMATED` /
  `CORRECTED`);
- `connected`;
- `device_id`;
- `device_log_key` (unique where not null);
- `sim_label`;
- `dialled_at`;
- `outcome_at`;
- `attempt_counted`;
- `hours_override_reason`;
- `callback_reason`;
- `no_recording`.

The status CHECK gains `DIALLED`, keeping every old value.

**New tables:**
- `crm_call_recordings`: one stored file per call. It has a hold for disputes, and
  `deleted_at` / `delete_reason`.
- `crm_call_devices` and `crm_call_device_sessions`:
  - one row per phone;
  - one row per person signed in on it, with a hashed device token;
  - `ended_at` on handover or sign-out, `revoked_at` when blocked.
- `crm_dialler_modes`: the recording mode for each dialler app, confirmed by an
  administrator.
- `crm_policy_acks`: who acknowledged which version of the phone policy, and on
  which phone.
- `crm_calling_reviews`: one row per weekly review sent.

**Other new columns:**
- `crm_leads.do_not_record` and `account_contacts.do_not_record`;
- `crm_optouts.call_id`, `complaint`, `complaint_text`, `lift_reason`.

**Settings** (`sales.calls`, defaults):
- `deviceRecordings: false` (the switch for the new recordings);
- `recordingRetentionMonths: 6`;
- `removePhoneCopy: true`;
- `callingHours` (09:00–21:00, working days);
- `dailyAttemptCap: 3`;
- `maxRecordingMb: 50`;
- `deviceSync: true`;
- `openingSentence` (en, hi);
- `staffPolicy` (en, hi, version);
- `privacyNotice` (company, address, contact, texts, published).

The existing `recordings` and `recordingRetentionDays` keep governing old
provider rows only.

**Rollback:** deploy the previous version. New columns and tables are ignored,
and every existing call reads as before.

## Screens

- **One Call button** (`CallAction`) everywhere a number is dialled:
  - it starts a session first (`POST /sales/calls/start`), then opens the
    phone's dialler, or the app's plugin;
  - it always shows the number, so it can be copied;
  - it refuses opted-out numbers, the daily cap and (without a reason) calls
    outside hours.
- **The call bar** at the bottom of the screen shows the call in progress:
  - "Calling *lead* · started 15:02:10";
  - "How did it go?" links to the lead's form;
  - in the app, "Connected · 3 min 12 s" once the phone reports the call;
  - "They don't want this recorded";
  - "Attach recording".
- **The outcome form** saves onto the session:
  - a length field, pre-filled with the estimate or the phone's measured length;
  - "Asked not to be called again", with "and no WhatsApp or SMS";
  - the opening sentence at the top when recording is on.
- **My Day** starts with "Dialled: say how it went".
- **The lead page** gets:
  - "Do not record calls";
  - "Customer complained";
  - the Calls tab with talk time and its source, recordings with a player, and
    "Keep for a dispute".
- **Settings → Calling** (administrators):
  - recording (refused until the sentence and the published notice exist),
    retention and calling hours;
  - the texts in English and Hindi;
  - the privacy notice;
  - Phones (devices, handover, revoke, recording mode);
  - Complaints & opt-outs (list, lift with a reason, CSV import with preview);
  - the weekly review.
- **Share to TaskFlow** (installed PWA on Android): a recording shared from the
  phone opens "Which call is this?".
- **Phone setup** (inside the Android app):
  1. the policy;
  2. permissions;
  3. the work SIM;
  4. the brand's recording steps;
  5. the folder;
  6. battery.

## How only lead and contact calls leave the phone

1. **The app downloads salted hashes, not numbers.** It gets the numbers of the
   leads and contacts the person may see as HMAC-SHA256 hashes, with a salt per
   person that changes daily (`GET /device/numbers`).
2. **It matches on the phone.** It hashes each call-log number the same way and
   uploads only the matches.
3. **The server checks again.** It refuses any entry whose number is not a lead or
   contact in that person's scope, and stores nothing about it.

Phone numbers are short, so a hash can be guessed by trying numbers. The hashes
stop the list being read at a glance on a lost phone; they are not encryption.
`SIM_CALLING.md` says so.

## Android app

**The app**
- A Capacitor 8 app in `apps/android/`. It is not an npm workspace, so the
  server's install is unchanged.
- It loads the TaskFlow site (set at build time).
- Its one plugin, `TaskFlowPhone`, is written in Java.

**What can be tested here**
- The pure-Java parts are compiled and unit-tested on this machine with `javac`:
  number normalising, hashing, recording-file matching and the sync cursor.
- They use the same test vectors as the server.

**What cannot be built here**
- The Android SDK cannot be downloaded in this environment: `dl.google.com` is
  blocked.
- So the APK is not built here. The README says how to build and sign it.

## Test plan

- **Server** (`tests/simCalling.test.js`, throwaway schema): every item in the
  brief's test list. Sample audio files are generated with ffmpeg at test time.
- **Client:** `CallAction` path choice, the estimate, the "Which call is this?"
  suggestion, the length-source labels.
- **Browser walk-through:**
  - made-up data in a separate schema;
  - a fake phone bridge injected into the page, standing in for the app;
  - desktop and Pixel sizes, light and dark;
  - axe;
  - screenshots.
- **Java:** the logic tests with `javac` / `java`.
- **Real phones:** a checklist in `SIM_CALLING.md` for the owner, marked "not yet
  run".

## Decisions

Defaults from the brief:
- recording on, after the per-model check;
- 6 months;
- remove the phone's copy;
- 09:00–21:00 on working days;
- 3 attempts a day;
- 50 MB;
- a Dialled session closes at the end of the day;
- English and Hindi.

Two points I had to interpret:

- **Unknown dialler apps** get the recording mode **"not confirmed"** until an
  administrator confirms it after testing that model. Google's and Samsung's
  dialler package names are pre-filled as *expected*, not confirmed.
- **The Exotel-era `calls.recordings` switch** is left as it was, for provider
  rows. The new recordings have their own switch, `deviceRecordings`, which is
  off. That way no existing behaviour changes silently.
