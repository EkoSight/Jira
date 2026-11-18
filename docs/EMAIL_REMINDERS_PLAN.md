# Email reminders, and Google Chat reminders switched on: the plan

The owner's request (18 November 2026): TaskFlow should remind people to finish
their tasks automatically, by email and by Google Chat. The brief is "Build:
task reminders by email, and Google Chat reminders switched on". This is the
short plan after reading the code.

## What the code does today

- **Task reminders** (`services/taskReminders.js`, run every minute by
  `jobs/reminderWorker.js`).
  - **What is planned:** one row per task, person, moment and channel in
    `task_reminders`. The moments are BEFORE_DUE (2 h), AT_DUE and
    AFTER_GRACE (manager), plus COVER and UNREACHED (fallback person).
  - **Channels:** only `APP` and `CHAT`. Every row plans both.
  - **Checked when sent:** the task as it stands, the mode (OFF / TEST /
    LIVE), days off, leave, quiet hours, inactive accounts, and "more than 12
    hours late".
  - **Chat failures:** a failed Chat message is followed by a notice to the
    fallback person (`followUpFailedChats`).
- **Summaries** (`services/taskSummaries.js`).
  - The personal morning summary (`queueSummaries`) is queued **by the Chat
    worker**, which starts only when Google Chat is configured. If
    `googleChat.enabled` is false it returns at once: no summary at all, not
    even to the bell.
  - It ignores the reminders' TEST mode. The weekly backlog review (in the
    reminder worker) respects it.
  - The text is Chat markup: `*bold*`, `_italic_`, `<url|text>`.
  - Logged in `reminder_summary_log`, one row per person per day
    (`personal:<id>:<date>`).
- **Coverage** (`services/coverage.js`): one PERSONAL log row per owner, keyed
  by user.
- **Sales follow-up reminders** (`services/sales/followupReminders.js`):
  - channels `APP` / `CHAT` in `crm_followup_reminders` (with a CHECK) and in
    `crm_reminder_prefs.channels`;
  - 30/15/10/5 minutes before.
- **Workspace and personal reminders** (`services/workspace/reminders.js`):
  - each occurrence goes to the bell, and to Chat when the rule's `chat`
    preference allows;
  - preferences live in `reminder_rule_prefs (enabled, at_time, chat)`.
- **System email:** `services/accountEmail.js` holds `emailReadiness()`, the
  system sender (Settings → Email) and `account_emails`. It sends through
  `services/marketing/providers.js`.
  - Delivery reports for `acct-…` are ignored by marketing
    (`recordEvent`), and nothing else reads them.
- **The screens:**
  - Settings → Reminders (`TaskReminderSettings.jsx`): mode, coverage,
    connections, tomorrow, the log, the audit;
  - My account: `DeliveryLog`;
  - My account → My reminders (`MyReminders.jsx`, `/settings?tab=account`): rule choices and personal
    reminders;
  - the task dialog's panel (`TaskDeadlinePanel.jsx`): its "Where" column
    knows only Chat and the bell.

## Why Chat reminders may not be reaching people

All of these are settings or set-up, not faults in the code.

1. **Chat is off.** `googleChat.enabled` defaults to **false**. Until it is
   switched on, no Chat message goes, and **no morning summary goes at all**.
2. **Test mode.** `reminders.mode` defaults to **TEST**: only the
   administrator who chose TEST receives task reminders. Everyone else's are
   recorded as "would send".
3. **Not connected.** A person has to have TaskFlow in their Chat (a direct
   message space). Without it, they get the bell only.
4. **Never verified.** Real delivery through Google has not been checked on
   the live site.

## Where this build differs from the brief

1. **Batching window: 3 minutes, not 15.** Holding a "Deadline now" reminder
   for up to 15 minutes defeats it. Reminder emails for one person that fall
   due within 3 minutes of the first go as one email. Sales follow-up
   reminders, which are minutes before a call, are not held at all.
2. **Email bodies are rendered when sent, not stored.** `email_outbox` keeps
   what to say (the reminder ids, or the summary's text) and the subject once
   sent. Rendering at the last moment re-checks every task, so a batch whose
   tasks have all closed is cancelled. Nothing needs clearing after 30 days.
3. **Summaries by email run in the reminder worker,** so they go whether or
   not Google Chat is set up. The Chat summary itself is unchanged, except
   that a person who chose "Email only" or "The bell only" no longer gets the
   Chat copy (only when email can actually go).
4. **Reminder emails follow the reminders' mode** (OFF / TEST / LIVE),
   summaries included. The Chat summary keeps its existing behaviour.
5. **"My account → My reminders"** is the existing section of Settings → My
   account (`/settings?tab=account#how-you-hear`; its server routes are under
   `/workspace/reminders`). The channel choices go there, at the top. My
   account's delivery log gains a channel column.

## The design

**Data (migration 044, additive only).**

- **Wider CHECKs:**
  - `task_reminders.channel` and `crm_followup_reminders.channel` gain
    `EMAIL`;
  - `reminder_summary_log` gains `channel` (default 'CHAT') and an EMAILED
    status;
  - `account_emails.kind` gains CHAT_STEPS.
- **`email_outbox`:**
  - dedupe key, user, address, kind (REMINDER, SUMMARY, FOLLOW_UP,
    WORKSPACE);
  - the payload, status, attempts, the next attempt, the error, the subject,
    the provider's id;
  - `hold_until` and `items`.
- **`reminder_channel_prefs`:** per person, `task_reminders` and `summaries`,
  each one of BOTH, CHAT_ELSE_EMAIL, EMAIL, CHAT, BELL. Also
  `summary_all_clear`.
- **Undeliverable email:** `users.email_undeliverable_at`,
  `email_undeliverable_reason` and `email_soft_bounces`.
- **Other new columns:** `reminder_rule_prefs.email` (nullable: unset means
  off) and `reminder_occurrences.email_outbox_key`.
- **The defaults:** `settings.reminders.email` = { enabled, taskReminders
  BOTH, summaries CHAT_ELSE_EMAIL, managerNotices, teamSummary false,
  dailyCap 10 }.

**Server.**

- **`services/reminderEmail.js`:**
  - **Choices:** channel preferences, and who gets what by email.
  - **The queue:** `queueReminderEmail` (with the batching window and the
    daily cap) and `queueSummaryEmail`.
  - **The sender:** `sendEmailOutbox`, with retries after 1, 5, 30 and 120
    minutes; it renders at send time.
  - **Bounces:** `recordSystemEmailEvent`.
  - **Summaries:** `queueEmailSummaries` (personal, backlog and team).
  - **Failures:** `followUpFailedEmails`.
- **`taskReminders.js`:**
  - **Planning:** EMAIL rows by preference, plus covering notices by email.
  - **Sending:** an EMAIL branch, with an extra check that the person still
    wants email.
- **`deliveryStatus`** reads the email outbox.
- **`taskSummaries.js`:** the Chat summary respects "Email only" and "The bell
  only".
- **`coverage.js`:**
  - a summary delivered by email counts as seen;
  - new reasons: email bounced, reaches nobody (no Chat, no email).
- **`followupReminders.js`** and **`workspace/reminders.js`:** an email branch,
  off by default.
- **Marketing events:** system references go to `recordSystemEmailEvent`.
- **Routes:**
  - `GET/PUT /reminders/channels` (my choices), `POST /reminders/sample-email`;
  - `GET /reminders/go-live` (the checks), `POST /reminders/chat-steps`
    (email the Chat steps);
  - `POST /users/:id/clear-email-bounce`;
  - Settings → Reminders saves the email defaults.

**Screens.**

- **Settings → Reminders:** the go-live checks, Channels, the channel column in
  the log and in tomorrow's preview, and who cannot be reached.
- **My reminders:** "How you hear about your tasks", a sample, and
  Chat and email reachability. Each rule row also gets an email box.
- **Team → Edit:** reminder reachability, and "Clear the bounce".
- **The task dialog:** Email in its channel column.
- **The home banner:** for people not connected to Chat.

## Tests

The brief's tests 1–12 go in `server/tests/emailReminders.test.js`, against the
outbox stand-in. Then the existing reminder, summary, coverage, CRM and
workspace tests, the full suites, a browser walk and screenshots.

## Found while building

- **Who covers whom.** A person whom email reaches is no longer counted as
  unreachable for the summaries, so their fallback person is not told to cover
  them. While email is not set up this is exactly as before.
- **The coverage check** counts a summary delivered by email. "Email is not
  set up" is said once for the report (`email_ready`, `email_reason`) rather
  than on every task, so the reasons of today's reports do not change until
  email is set up.
- **Rollback needs one step first.** The previous version would send a pending
  `EMAIL` reminder as a Chat message. `DEADLINES_REMINDERS.md` gives the two
  UPDATE statements to run before rolling back.
- **"Forgot password?" asked twice quickly** could leave the person with the
  replaced password in the email that arrived last. Requests for one address
  now run one after another (`services/accountEmail.js`).
