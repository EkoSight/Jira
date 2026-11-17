# Account emails

TaskFlow emails a person their sign-in details when an administrator creates
their account or resets their password. It also offers "Forgot password?" on
the sign-in page, and tells people when their password changes. Built 17
November 2026 at the owner's request. The plan is in `ACCOUNT_EMAILS_PLAN.md`.

## What is sent, when, and to whom

Every email goes only to the person's own sign-in address.

| Email | When | Has a password? |
| --- | --- | --- |
| **Your TaskFlow account is ready** | An administrator adds someone with "Email their sign-in details" ticked (on by default), or presses **Resend sign-in details** | Yes, a temporary one. Not when the administrator typed a password themselves |
| **Your TaskFlow password was reset** | An administrator resets a password with "Email the new temporary password" ticked (on by default) | Yes, a temporary one |
| **Reset your TaskFlow password** | Someone uses "Forgot password?" on the sign-in page | Yes, a temporary one |
| **Your TaskFlow password was changed** | Someone chooses their own password (at first sign-in, or later in My account) | No |
| **TaskFlow account emails: a test** | An administrator presses "Send a test to me" in Settings → Email; it goes to their own address | No |

The app's name in these emails comes from Settings → Branding. They are
TaskFlow's emails, never Soil Doctor's.

They are **system emails, not marketing**:

- no unsubscribe link and no marketing footer;
- nobody is added to marketing contacts;
- nothing counts in campaign figures, and marketing consent is not checked;
- they never show in the marketing outbox, and a delivery report about one is
  ignored by marketing.

They go through the email service the server already uses (SES, Brevo or SMTP).

## The words of each email

Each email comes in HTML and plain text, saying the same thing. It is short and
readable on a phone. Words in braces are filled in.

**Your {app} account is ready**

> {First name}, your {app} account is ready.
> *(when resent)* These sign-in details replace the ones sent to you earlier.
> Sign in with your work email: {email}
> Your temporary password: **{password}**
> *(or, when the administrator typed one)* {Administrator} will give you your password.
> [Sign in to {app}] Or open: {address}/login
> It works until {date, time} (India time).
> When you sign in, you will choose your own password. This one then stops working.
> {Administrator} created your account. If you need help, ask {administrator}.
> If you weren't expecting this, tell {administrator} or ignore this email.

**Your {app} password was reset**

> {First name}, your {app} password was reset.
> {Administrator} reset it on {date, time}. Your old password no longer works, and you were signed out everywhere.
> Sign in with your work email: {email}
> Your temporary password: **{password}**
> [Sign in] It works until … When you sign in, you will choose your own password …
> If you didn't ask for this, tell {administrator}.

**Reset your {app} password** ("Forgot password?")

> {First name}, here is a temporary password.
> Someone asked to reset the {app} password for {email}. If it was you, sign in with this temporary password: **{password}**
> It works until … Your current password keeps working too, until you use this one.
> When you sign in with it, you will choose a new password, and you will be signed out everywhere else.
> If you didn't ask for this, ignore this email: nothing changes.

**Your {app} password was changed**

> {First name}, your {app} password was changed. It was changed on {date, time}, for {email}.
> If this wasn't you, tell your administrator now.

**Every email ends with:** "Never share your password. {app} will never ask you
for it by email or phone."

**No subject line contains a secret.**

## The rules for a temporary password

- **Issued by TaskFlow:** 14 characters, with no look-alike characters (no
  0/O, 1/l/I).
- **Expiry.** It works for **24 hours** (Settings → Email, 1 to 168 hours).
  After that, signing in with it says "This temporary password has expired.
  Ask your administrator to send a new one."
- **Temporary passwords from before this release** have no expiry recorded,
  and keep working exactly as before.
- **One use.** Choosing your own password ends it, along with its expiry and
  any open "Forgot password?" request.
- **A password an administrator types** (through the API) is never emailed and
  never expires.
- **Shown on screen only when it was not emailed,** once, with the reason. It
  is never in an answer once emailed, and never kept in the browser.
- **Stored only as a hash.** "Resend sign-in details" therefore makes a new
  one, and says so: "This replaces the earlier password."

## "Forgot password?"

- **Offered only** while it is switched on (Settings → Email) and email is set
  up.
- **No account guessing.** The page always says "If that email has a TaskFlow
  account, we've sent instructions." The work happens after that answer, so a
  known and an unknown address answer alike.
- **No lock-out.** A request never changes the current password. The emailed
  temporary password works alongside it until it is used or expires. Only the
  newest request works.
- **Using it** makes it the password, asks for a new one straight away, and
  signs out every other session.
- **Limits:** 3 requests per address and 20 per IP address in an hour. Beyond
  that, the same answer and nothing is sent.
- **Nothing is sent** to deactivated accounts or to super admin accounts.

## Failed sign-ins

- **The limit.** After 10 failed sign-ins for one email within 15 minutes,
  every sign-in for that email waits: "Too many sign-in attempts. Wait N
  minutes and try again."
- **Unknown accounts** are treated the same.
- **The work matches.** The server checks the password even for an unknown
  account, so the answer takes the same time.
- **A successful sign-in** clears the count.
- **Someone else's mistakes.** Ten wrong guesses at someone else's email also
  make that person wait a few minutes. That is the cost of the limit.

The sign-in and "Forgot password?" limits are counted in the server's memory.
A restart clears them, and two servers would each count on their own. That is
enough for TaskFlow's single server.

## When email isn't set up

Account emails go out only when all of these hold:

- the server has an email service (`EMAIL_PROVIDER` and its keys);
- the sender address is filled in (Settings → Email);
- the server is not set to "outbox only" in production. An outbox would keep
  a password in memory and deliver nothing.

Otherwise:

- the tick boxes are off, with the reason;
- the temporary password is shown on screen to pass on, as before;
- "Forgot password?" is hidden;
- "Resend sign-in details" changes nothing and says why;
- nothing ever claims an email was sent. Each attempt is recorded as "Email
  not set up".

If the email service refuses a message, the password is shown once with the
reason ("We couldn't email it (…). Pass this on yourself."), and the attempt is
recorded as "Not sent".

## Where a password never appears

- server logs and error messages;
- the audit trail (it records "welcome email", "password reset", "sign-in
  details resent", "reset requested by the person" and "signed in with a
  reset", with who and when);
- the account email record (`account_emails`: who, what kind, which address,
  status, the provider's id, the error);
- the "Forgot password?" requests (a hash only);
- any answer once emailed;
- the browser's storage;
- the production outbox.

The email service you use keeps its own copy of what it sent. That is one
reason a temporary password expires.

## Screens

- **Team → Add member:**
  - the tick box "Email their sign-in details to {email}";
  - then "Sign-in details emailed to …", or the password once with the reason.
- **Team → Reset password:**
  - a dialog that says what happens;
  - the tick box "Email the new temporary password to {email}";
  - the same kind of result.
- **Team → Edit (a person):** the **Sign-in** section, with:
  - whether they have chosen their own password;
  - when their temporary password stops working;
  - **Resend sign-in details**;
  - **Account emails**: date, kind, status, and who sent it.
- **Sign-in page:** "Forgot password?" when offered.
- **Settings → Email** (`settings.manage`):
  - the state of the email service;
  - the sender name and address, and the reply-to address;
  - how long a temporary password works;
  - the "Forgot password?" switch;
  - "Send a test to me".

## What an administrator must do on the live site

1. **The email service.** Make sure the server has an email service set up
   (`EMAIL_PROVIDER` = `ses`, `brevo` or `smtp`, with its keys). It is the one
   marketing uses; see `EMAIL_MARKETING.md`.
2. **The sender.** In **Settings → Email**, enter a sender address on a domain
   the email service has verified, for example "TaskFlow" and a `no-reply@`
   address on your domain. Save.
3. **A test.** Press **Send a test to me**, and check it arrives and is not
   in spam.
4. **The sign-in link.** Check that `APP_PUBLIC_URL` is the address people sign
   in at. The emails link to `{APP_PUBLIC_URL}/login`.
5. **Optional:** change how long a temporary password works, or switch
   "Forgot password?" off.

Until step 2 is done, everything works as it did before: the temporary password
is shown on screen to pass on.

## Owner decisions (defaults used)

1. **"Forgot password?"** — built, on.
2. **How long a temporary password works** — 24 hours.
3. **A link instead of a password** — not now. The temporary password is sent,
   as asked. A single-use "set your password" link would be safer, because an
   inbox would then hold nothing that signs in. Switching later changes only
   the email words and the sign-in check.
4. **The sender** — left empty until an administrator fills it in.
5. **Telling the person's manager** when an account is created — no.

## What was tested

**Server:** `server/tests/accountEmails.test.js`, 13 tests, against the outbox
stand-in. No real email was sent, and all the people are made up. They cover:

- the welcome email;
- not set up, and the provider failing;
- a typed password never emailed;
- an administrator's reset and the rules on whose password may be reset;
- expiry, with older accounts unchanged;
- one use, and "your password was changed";
- resend;
- "Forgot password?": the same answer, no lock-out, the limits, who gets
  nothing, the switch;
- the failed sign-in limit;
- Settings → Email;
- no password in logs, the audit trail or the records.

**Browser walk** (development server, outbox only, made-up people): 26 of 26
checks.

- Settings → Email: not set up, then ready, then a test.
- Adding someone with the box ticked: the email is sent, and they sign in and
  are made to choose a password.
- "Your password was changed" goes out.
- A reset, emailed; the Sign-in section; resend; the history.
- "Forgot password?": the same answer, and the current password still works.
- The "not set up" fallback.
- Phone width and dark mode.

**Not verified:** delivery through a real email service, or a real inbox (spam
filtering, how each mail app shows the email).
