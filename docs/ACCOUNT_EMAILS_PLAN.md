# Account emails: the plan

The owner's request (17 November 2026): when an administrator creates an account
or resets a password, email the person their sign-in details. The full brief is
"Build: account emails (welcome and password reset)". This is the short plan
after reading the code.

## What the code does today

- **Creating an account** (`POST /users`, `server/src/routes/users.js`).
  - With no password typed, it makes one with `generateTempPassword()`: 6
    random bytes, 8 characters.
  - It sets `must_change_password` and returns `temporary_password` once.
  - The Team page shows it in a "Member added" box.
- **An administrator's reset** (`POST /users/:id/reset-password`).
  - It makes a new temporary password, sets `must_change_password` and raises
    `token_version` (signed out everywhere).
  - The Team page shows the password **in a toast**.
- **First sign-in.** `ForcePasswordChange` asks for the temporary password and
  a new one. It uses `POST /auth/change-password`, which clears the flag and
  raises `token_version`. Settings → My account uses the same call.
- **Email.** `server/src/services/marketing/providers.js` has `log` (an
  in-memory outbox), `smtp`, `ses` and `brevo`.
  - With `EMAIL_PROVIDER` unset: `log` outside production, nothing in
    production.
  - Only marketing uses it.
  - The development outbox can be read on the marketing settings screen
    (`GET /marketing/dev/outbox`).
- **Sign-in** (`POST /auth/login`): no limit on failed attempts. For an
  unknown email it skips the password check, so it answers a little faster.
- There is **no "Forgot password?"**.
- **The audit trail:** `attendance_audit` through `audit()`. Account changes
  use entity `USER_ACCESS`.

## Where the code differs from the brief

1. **The reset password is shown in a toast,** not a box. It moves to a small
   dialog with the tick box. The fallback shows it once, in the same style as
   "Member added".
2. **The Team page has no password field,** so "a password the administrator
   typed" can only arrive through the API (`POST /users` with `password`). The
   rule still holds there: the welcome email goes without it.
3. **There is no separate person page.** "Team → a person" is the Edit dialog,
   so "Resend sign-in details" and "Account emails" go there.
4. **The development outbox is visible on the marketing screen.** Account
   emails must not show there. The marketing outbox list leaves out account
   emails, and account emails get their own outbox route, which exists only in
   development.
5. **A server set to "outbox only" in production** would keep passwords in
   memory. Account emails treat that as "email is not set up" in production.

## The design

**Data: migration 043, additive only.**

- `users.temp_password_expires_at` (NULL means no expiry, which is today's
  behaviour).
- `account_emails`: the delivery record. It never holds a password or a body.
- `password_reset_requests`: requests from "Forgot password?". Each holds the
  hash of its temporary password, the user, created / expires / used /
  cancelled, and the requesting IP address.
- A settings key `accountEmails`:
  - `senderName` "TaskFlow";
  - `senderEmail` empty (owner decision 4);
  - `replyTo` empty;
  - `expiryHours` 24 (decision 2);
  - `forgotPassword` on (decision 1).

**Server.**

- **`lib/password.js`:** `generateSignInPassword()` makes 14 characters from
  an alphabet with no 0/O/1/l/I. `generateTempPassword()` stays.
- **`services/accountEmail.js`:**
  - `emailReadiness()`;
  - the words of each email (HTML and plain text);
  - `sendAccountEmail()` sends through the active provider with reference
    `acct-…`, then writes `account_emails`;
  - `issueTempPassword()` hashes the password and sets its expiry.
- **`routes/users.js`:**
  - `POST /users` and `POST /users/:id/reset-password` take
    `email_details: true`. Callers that don't send it get today's response.
  - New: `POST /users/:id/resend-sign-in`, `GET /users/:id/account-emails`
    and `GET /users/account-email-status`.
- **`routes/accountEmails.js`:** `GET /account-emails/status`,
  `POST /account-emails/test`, and the development outbox.
- **`routes/auth.js`:**
  - **Sign-in:** a limit of 10 failures per typed email in 15 minutes; the
    same work for unknown accounts; the expiry check; and sign-in with a
    "Forgot password?" temporary password.
  - **`/auth/forgot-password`:** always the same answer. The work happens
    after the answer, and the limits are 3 per address and 20 per IP address
    per hour.
  - **`/auth/options`:** public; says whether "Forgot password?" is on.
  - **`change-password`:** clears the expiry, cancels pending requests and
    sends "Your password was changed".
- **Marketing.** Delivery reports for `acct-…` references are ignored, and the
  marketing outbox list leaves them out.

**Screens.**

- **Team:**
  - Add member: the tick box and the result.
  - Reset dialog: the tick box and the result.
  - Edit dialog: "Sign-in", with "Resend sign-in details" while they haven't
    signed in, and "Account emails".
- **Sign-in page:** "Forgot password?".
- **Settings → Email** (new tab, `settings.manage`):
  - the sender, reply-to address, expiry and "Forgot password?" switch;
  - the provider's state, as on the marketing screen;
  - "Send a test to me".

**Limits are kept in memory,** per server process. A restart clears them. That
is enough for one server; the docs say so.

## Tests

The brief's tests 1–11 go in `server/tests/accountEmails.test.js`, against the
outbox stand-in. Then the full suites, a browser walk with made-up people (the
outbox only) and screenshots.
