# Daily standup — set-up and how it works

A daily plan in the company's Google Chat space. It sits beside the individual
morning summary and the department team summary; neither is changed.

| When (India time, company working days) | What |
|---|---|
| **09:30** | One reminder in the standup space, with the template |
| **09:40** | Submissions due. If the reminder arrived late, the deadline moves so everyone still gets the full ten minutes from its delivery. |
| **After 09:40** | Every expected person is reviewed. Vague or unmeasurable plans get a polite, specific request in their own thread. |
| **11:00** | Anything still unresolved goes privately to the chosen reviewers: counts in Chat, names only in TaskFlow. |

All four times can be changed under **Daily standup → Set-up**.

**What it never does.** It never names anyone who is missing in the space. It
does not change attendance, leave, pay or black marks, and it never decides
anything about anyone's work. A missing or vague standup is recorded for a
person to look at; it is not proof of anything. Any consequence would need its
own written policy covering:

- which kinds of miss count;
- the counting period;
- exemptions;
- how the count resets.

That policy has not been given, so none is applied.

## The template

```
Name | Date | Role
1. <TaskFlow ID or link> | <what you will do> | <what will exist when done> | <done by HH:MM>
… 3 to 5 items
Blockers: <help needed> | Owner: <who> | By: <HH:MM>      (or "Blockers: none")
```

Numbers people write are their own plan. The review never compares them with a
quota and never suggests one, and the reminder's examples contain no sales
figures.

## How people post

You can post in any of these three ways; they all end up as the same record.

1. **In TaskFlow:** go to **Daily standup → My standup**. The form shows the
   reviewer's checks as you type. The standup is then posted in the space, in
   its own thread, under the person's name.
2. **In the standup space:** post the template and **mention @TaskFlow**.
   Google sends an app only the messages that mention it; for a way round that,
   see the optional reading set-up below.
3. **Privately:** send TaskFlow a direct message that starts with `standup`.
   TaskFlow then posts the standup in the space.

**Corrections.** A correction is a new version: post the whole standup again
(in its thread, by message, or in the form). The first arrival time is kept;
every version is stored. Google does not tell apps when a message is edited, so
editing the original message in Chat is not seen.

**Shared logins** (for example one HR account used by several people):

- Each person is added by name under **People** as a "shared login" member.
- In TaskFlow, the shared login has to choose the person every time; there is
  no default.
- In Chat, the first line must carry the person's full name exactly as it is on
  the list.
- A name that matches nobody is held for a person to resolve. It is never
  guessed.

## Who is expected

Only active people on the list whose identity is **verified**:

- **Company accounts** (`@ekosight.com`) added with their own login are
  verified by that login.
- **Shared logins and outside accounts** need an admin to verify them under
  **People**, with a note on how it was confirmed. Until then they are not
  counted, and their messages are held.
- **Former staff** are left out: their account is deactivated, or they have an
  exit date before the day.

On the day itself, each expected person is classified separately:

| Status | Meaning |
|---|---|
| On time | First posted by the deadline in force |
| Late | First posted after it — including after the review ran |
| Not seen ("missing") | Nothing by the deadline, after a reminder that was delivered. They get a friendly private message; nobody else is told in Chat. |
| Exempt | Approved leave (or morning leave), a leave request still pending, their own weekly off, a department or personal holiday (a morning off counts), or not yet joined |
| Could not be reached | No reminder went out, or it never arrived. Nobody is called missing for a reminder they did not get. |

Company holidays and weekly offs send nothing at all; the day is recorded as
skipped. A company holiday that takes the morning off skips the standup too;
one that takes only the afternoon off does not. Holidays come from **Settings →
Attendance & pay → Holidays** (see `HOLIDAYS.md`), and count once approved. A
holiday added after the day lists any standup recorded missing or late that day
for a standup reviewer to excuse; nothing is changed by itself.

## Set-up (an admin with "Set up the daily standup")

1. In Google Chat, open the standup space and add the **TaskFlow** app to it
   (**Apps & integrations → Add apps**).
2. In TaskFlow, go to **Daily standup → Set-up**. Paste the space's link and
   save, then click **Check the space**. TaskFlow asks Google whether the app is
   in the space, whether it is a space (not a direct message), and whether
   people outside the company can join. The standup can be switched on only
   for a space that passes this check, and changing the space switches it off
   again.
3. Go to **People** and click **Add everyone active**. Add each person on a
   shared login separately, and verify them. Remove anyone who should not post.
4. Back in **Set-up**, choose who gets the 11:00 follow-up. They need the
   "standup review" permission, which managers have.
5. Switch it on.

**The destination needs an owner decision.** The current standup group
is reported to block external membership. Whether it is the
right destination, or should be replaced, is for the owner to decide. Nothing
is posted anywhere until a space is entered, checked and switched on.

### Optional: read standups posted without a mention

To accept standups that people simply post in the space, without mentioning
TaskFlow:

1. A Google Workspace admin grants the scope
   `https://www.googleapis.com/auth/chat.messages.readonly` to TaskFlow's
   service account under **Domain-wide delegation**. This is the same place as
   the directory scope in `GOOGLE_CHAT.md`.
2. In **Set-up**, enter the email of a member of the space for TaskFlow to read
   as.

The grant is domain-wide: it allows reading the Chat messages of any space that
account belongs to. TaskFlow only reads the standup space, from 30 minutes
before the reminder to an hour after the latest review time. Only messages that
look like the template are used.

## Reliability

- **Each message is sent once.** Every Chat message goes through the same
  outbox as the other Chat messages, under a stable key: the reminder, a posted
  standup or correction, feedback, a private nudge, a follow-up. A retry, a
  restart or two servers running at once cannot send any of them twice.
- **A Google outage delays, it does not lose.** It retries after 1, 5, 30 and
  120 minutes. A late reminder moves the deadline. A reminder that never
  arrives makes people "could not be reached", not missing.
- **A missed window is recorded, not filled in.** If TaskFlow was not running
  between 09:30 and 09:40, it does not send a reminder after the deadline, and
  it records why.
- **The review runs once per day.** It claims the day before it starts, and
  claims it back only if a run died part-way. Each version of a standup is
  reviewed once.
- **Times are India time, not the server's clock.** 09:30 is
  `04:00:00Z`; one second earlier, nothing happens.
- **Everything is kept as evidence.** **Review** shows when the reminder was
  due, when Google accepted it, the deadline in force, each Chat message with
  its delivery status, attempts and Google's message name, every version of
  every standup, and every follow-up.

## Tested, and not yet verified

- **Tested** (`server/tests/standup.test.js`, `standupContent.test.js`), against
  a stand-in for Google Chat:
  - a working day;
  - a company holiday;
  - approved leave;
  - shared and outside accounts;
  - a missing standup and a corrected one;
  - a late arrival;
  - a delayed, failed and missed reminder;
  - duplicate and concurrent runs;
  - the India-time boundary;
  - the space privacy check;
  - and that attendance, leave, pay, black marks and tasks are unchanged.
- **Browser check:** the screens were also checked in a browser against a local
  copy with made-up people.
- **Not yet verified against the live Google service:**
  - a real message appearing in a real space and thread;
  - Google delivering @mentions in the standup space to TaskFlow;
  - the privacy check against a real space;
  - reading a space with the optional grant.

  The first real check is to set it up as above and run it on one working day
  with a small group. Read the **Review** evidence before relying on it.
