# Email marketing

Email marketing lives inside TaskFlow under **Email marketing** in the sidebar.
It shares TaskFlow's sign-in, permissions, design and database, and reads the
B2B pipeline's organizations and people, so a click, reply or conversion on an
email becomes an ordinary TaskFlow task for the person who looks after that
contact.

This document covers what was built (checked against Mailchimp's Standard and
Premium plans), how the parts fit together, how to set it up, what it costs,
what it depends on, what tracking can and cannot see, and what is not built.

---

## 1. Feature checklist against Mailchimp

Mailchimp's own site could not be reached from the build environment, so the
benchmark list was put together from third-party summaries of its 2025–2026
Standard and Premium plans (moosend.com, activepieces.com, dreamlit.ai,
techradar.com, sendx.io, joinsecret.com, campaignhq.co, costbench.com) and
general knowledge of the product. Check anything that matters against
mailchimp.com before relying on the comparison.

**Built** = working and covered by tests. **Partly** = the core is there, with
the gap named. **Not built** = not in this release.

### Audience

| Mailchimp feature | TaskFlow | Status |
|---|---|---|
| One contact list, deduplicated | One record per email address (lower-cased, trimmed); imports, forms, the CRM and colleagues all update the same record | Built |
| Audiences / groups; one person in several | Any number of audiences per contact, each with its own status. Seeded: Customers, Leads, FPOs, Students, Farmers, Partners, Dealers; add your own | Built |
| Tags | On contacts; bulk add/remove; automations can add/remove | Built |
| Custom (merge) fields | Text, number, date, choice, yes/no; seeded district, crops, land, FPO name, college, course, graduation year, interest, dealer code, birthday | Built |
| Import / export | CSV import with column mapping, consent basis, de-duplication, problem report; CSV export of contacts, recipients, events, consents, suppressions | Built |
| Segments, advanced segmentation | Nested AND/OR rules over contact fields, tags, custom fields, location, engagement, campaign activity, audience, topic, and the CRM (pipeline type, organization tag, segment, owner, open deal); live count | Built |
| Signup forms (hosted, embedded) | Hosted page + embed HTML; consent tick box; double opt-in per audience; topics; honeypot and rate limits | Built |
| Pop-up forms, landing pages, websites | — | Not built |
| Preference centre (groups) | Topics people can opt out of, list-by-list unsubscribe, language choice | Built |
| Contact profile & activity | Everything sent, opened, clicked, replied, converted; consent record; follow-up tasks; notes | Built |
| Engagement rating | 0–100 score from the last 90 days of human activity, newer counting more | Built |
| CRM sync | Pipeline organizations' people join audiences by type, tag or segment; leave (archived, not unsubscribed) when they stop matching; off until an admin switches it on | Built |
| Predicted demographics, customer lifetime value, likelihood to buy | — | Not built |

### Content

| Mailchimp feature | TaskFlow | Status |
|---|---|---|
| Drag-and-drop builder | Brand sections — hero, cards, figures, soil data, steps, details, testimonial, call to action — and basics (heading, text, button, image, pulse line, divider, space, social links, custom HTML); a canvas that shows the email in the brand; drag in, drag to reorder, keyboard arrows, duplicate; a live brand check | Built |
| Templates | 14 Soil Doctor starters in English and Hindi with subject and preview text (field notes, festival, season advisory, soil report ready, product, follow-up, soil camp invite, FPO update, careers, welcome, re-engagement, impact story, partner programme update, retailer update); a gallery with live thumbnails; design your own, copy a starter, save a campaign as a template; export and import as a file | Built |
| Code your own / import | Upload an HTML email from Mailchimp, Brevo, Campaign Monitor, HubSpot or a designer: styles are written onto the layout, merge tags converted, embedded images hosted, scripts removed, colours and fonts moved onto the brand, with a report of every change. Or a custom HTML block | Built |
| Content studio / image hosting | Upload PNG/JPEG/GIF/WebP up to 2 MB, kept in the database, served publicly | Built (no image editor) |
| Personalization (merge tags) | `{{first_name|fallback}}`, standard fields, `{{custom.key}}`, `{{festival}}` | Built |
| Dynamic content | Show a block only to a language, tag, pipeline type, audience or field value | Built |
| AI writing (Intuit Assist) | Subject lines, preview text, rewrite, shorten, translate English↔Hindi, draft from a brief — suggestions only, a person picks | Built (needs `ANTHROPIC_API_KEY`) |
| Multilingual | English and Hindi side by side; each contact gets their language | Built (two languages) |
| Preview, test emails | Server-rendered preview on computer or phone width, as any contact; test sends marked [Test] that never count in results | Built |
| Inbox previews across mail apps | — | Not built |
| Content checks | Empty subject, buttons without links, unknown merge tags, missing alt text, insecure links, missing Hindi, spammy subjects — and the brand rules: no emoji, example figures replaced, Deep Green never twice in a row, gold used sparingly | Built |
| Brand control | Every email, whatever made it, is sent in the Soil Doctor brand: logo, palette, Manrope, pill buttons and footer are fixed; other colours move to the nearest brand colour | Built (beyond Mailchimp) |

### Sending

| Mailchimp feature | TaskFlow | Status |
|---|---|---|
| Scheduling | Send now or at a time | Built |
| Send-time optimization | Each person at the hour they usually open (from at least three readings; the audience's most common hour otherwise), within 24 hours of the start | Built |
| Time-zone sending | One time zone (India) | Not built |
| A/B tests | Up to 8 versions (subject, preview text, sender name, whole content); test share and waiting time; winner by clicks, opens or replies, or chosen by hand | Built |
| Multivariate on send time | — | Not built |
| Campaign calendar | Campaigns, festivals (confirmed or not) and festival automations by month | Built |
| Approvals | A second person approves exactly what they saw; any later change sends it back | Built (Mailchimp has no equivalent) |
| Roles and permissions | view, manage, send, approve, settings, export | Built |

### Automation

| Mailchimp feature | TaskFlow | Status |
|---|---|---|
| Customer journeys (visual builder) | Trigger, then steps: send, wait, if/else (two branches), actions, end; add a step anywhere; loops are refused | Built |
| Triggers | Joins an audience, tag added, form submitted, festival (confirmed dates only), a date field (birthdays), clicked/opened/ignored a campaign, inactivity, TaskFlow events (new lead, became customer, deal stage, deal won, deal lost, task finished), manual | Built |
| Actions | Tag, untag, add to / remove from audience, create a follow-up task, notify the owner, set a field, set language | Built |
| Pre-built journeys | Welcome series, lead nurturing, festival greetings, re-engagement, new customer onboarding | Built |
| E-commerce triggers (abandoned cart, purchase) | Conversions can be reported by the website; no shop integration | Not built |
| Webhook/API trigger | — | Not built |

### Reporting

| Mailchimp feature | TaskFlow | Status |
|---|---|---|
| Campaign report | Recipients, delivered (when the provider reports it), opens (people vs automatic), clicks, click-to-open, replies, conversions and value, bounces (permanent/temporary), unsubscribes, spam complaints, not sent and why, by hour, per link, per A/B version, follow-up tasks made | Built |
| Audience dashboard | Status counts, joined/left by week, sources, engagement bands, states, recent campaigns | Built |
| Click map overlay | A per-link table instead | Partly |
| Industry benchmarks, comparative reports | — | Not built |
| Exports | CSV of recipients, events, contacts, consent records, suppressions | Built |

### Deliverability and compliance

| Mailchimp feature | TaskFlow | Status |
|---|---|---|
| Sending infrastructure | Amazon SES, Brevo or any SMTP server; an outbox for development | Built (provider needed) |
| Domain authentication | SPF/DKIM/DMARC check from Settings; SES DKIM status read from SES | Built |
| Bounce and complaint handling | Signed SES events (SNS) and Brevo webhooks; hard bounces and complaints suppressed for good; soft bounces after a limit | Built |
| One-click unsubscribe (RFC 8058) | `List-Unsubscribe` + `List-Unsubscribe-Post` on every campaign and automation email | Built |
| Frequency limits | Per person per day and per week; per-minute sending rate | Built |
| Consent records | Every subscribe, confirm, unsubscribe and topic change with source, basis, words agreed to, IP and browser | Built |
| Dedicated IP, warm-up | Provider-side | Not built |
| SMS, WhatsApp, social posts, postcards | — | Not built |

---

## 2. How it fits together

```
contact ─► audience(s) ─► campaign or automation ─► queue ─► provider
   ▲              ▲                │ approval by           │
   │              │                │ a second person       ▼
 forms        CRM sync         recipients worked     delivery, bounces,
 imports      (pipeline)       out at send time      complaints (signed)
 colleagues                                            opens, clicks
                                                       (TaskFlow tracking)
                                                       replies (mailbox)
                                                       conversions (website,
                                                       pipeline, a person)
                                                             │
                     ┌───────────────────────────────────────┤
                     ▼                                       ▼
          follow-up task (one per person            organization history
          and campaign), assigned to the             in the pipeline
          contact's or organization's owner          (type "Email campaign")
```

**Every email is checked twice.** Recipients are worked out when sending starts,
and each person is checked again at the moment their own email is handed to the
provider: anyone who unsubscribed, bounced, complained, was blocked or opted out
of the topic in between is skipped, with the reason recorded.

**Nobody is put back after saying stop.** An import, the CRM sync, a colleague
or an automation can never re-subscribe someone who unsubscribed, bounced or
complained. Only the person can, by signing up again on a form — and if they had
unsubscribed before, that signup always needs the email confirmation, even on a
single opt-in form, so nobody can undo another person's choice by typing their
address.

**Duplicates are refused by the database**, not just by the code: one contact
per address, one copy of a campaign per person, one email per automation step
per run, one follow-up task per person per campaign (later reasons are added to
the same task as comments), one record per provider event (retried webhooks are
ignored).

### What happens in TaskFlow

- **A campaign has an owner, a task and a deadline.** "Make a TaskFlow task for
  preparing it" creates an ordinary task, assigned to the owner and due at the
  deadline. Sending posts a comment on it.
- **Follow-up tasks.** Per campaign, choose replies, conversions and/or human
  clicks (optionally on particular links). The task is due at 6 pm after the
  days you choose, assigned to whoever looks after the contact (their own
  owner, else their organization's owner, else the campaign owner), linked to
  the organization, tagged `email-follow-up`, and notifies the assignee. A
  missed follow-up counts like any other missed task (including black marks
  under the existing rules). Link scanners never create tasks.
- **Organization history.** The first human click, replies, conversions,
  unsubscribes, spam complaints and hard bounces appear on the organization's
  timeline as **Email campaign** entries. They never move a deal's "customer
  spoke to us", "we reached out" or "last worked" clocks: a bulk email is not a
  salesperson's touch. When the salesperson follows up, they log that as usual.
- **Engagement score** on each contact, used in segments and automations.
- **Conversions from the pipeline.** A deal won or a lead becoming a customer
  within a campaign's attribution window after someone at that organization
  clicked it is recorded as that campaign's conversion.
- **Approvals** notify everyone with approval rights; the result notifies the
  person who asked.

---

## 3. Setting it up

The migration (`025_email_marketing.sql`) runs with the usual update routine
and only adds tables (plus one allowed value, `CAMPAIGN`, on the timeline's
activity types). Nothing existing changes. Until a provider is configured,
nothing can be sent in production.

### 3.1 Choose a provider

| | Amazon SES (recommended) | Brevo | SMTP (Google Workspace, Zoho, etc.) |
|---|---|---|---|
| Bounces and complaints reported to TaskFlow | Yes (signed SNS) | Yes (webhook) | **No** — suppression is manual |
| Delivery reported | Yes | Yes | No |
| Good for bulk | Yes | Yes | Not really: Workspace limits sending and bulk mail risks the company's own mailboxes |

### 3.2 Server environment (`server/.env`)

Credentials live only in the server's environment — never in the database,
never in any screen or API response (Settings shows only whether each is
present).

| Variable | Needed for | Notes |
|---|---|---|
| `APP_PUBLIC_URL` | everything | Already set. Must be the public **https** address: every tracking, unsubscribe, form and image link starts with it |
| `EMAIL_PROVIDER` | sending | `ses`, `brevo`, `smtp`. Unset in production = sending is off. Unset elsewhere = outbox (nothing delivered) |
| `AWS_SES_REGION` | SES | e.g. `ap-south-1` (Mumbai, the default) |
| `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` | SES | An IAM user allowed only `ses:SendEmail`, `ses:SendRawEmail`, `ses:GetEmailIdentity` |
| `AWS_SES_CONFIGURATION_SET` | SES | The configuration set whose event destination is the SNS topic below |
| `AWS_SES_SNS_TOPIC_ARN` | SES events | Only notifications from this topic are accepted |
| `BREVO_API_KEY` | Brevo | Transactional API key |
| `EMAIL_WEBHOOK_SECRET` | Brevo events | A long random string; part of the webhook address |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | SMTP | |
| `MARKETING_INBOUND_KEY` | replies via an inbound mail service | A long random string; part of the inbound address |
| `MARKETING_CONVERSION_KEY` | website conversions | Sent by the website's **server** in `X-TaskFlow-Key` |
| `ANTHROPIC_API_KEY` | writing assistant | Optional |
| `MARKETING_WORKER` | | `true` by default; runs wherever `ENABLE_SCANNER` is true |
| `MARKETING_WORKER_INTERVAL_SECONDS` | | `15` by default |

Generate random secrets with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### 3.3 Amazon SES, step by step

1. In the SES console (region `ap-south-1`), **create a domain identity** for
   the sending domain (e.g. `ekosight.com`) with **Easy DKIM**. Add the three
   CNAME records it shows.
2. Set a **custom MAIL FROM domain** (e.g. `mail.ekosight.com`): add the MX
   record and the SPF TXT record SES shows. This aligns SPF for DMARC.
3. **Request production access** (new accounts are in the sandbox and can only
   send to verified addresses). Describe the consent you hold and your
   unsubscribe handling.
4. Create an **SNS topic**; add an **HTTPS subscription** to
   `https://taskflow.ekosight.com/api/taskflow/m/webhooks/ses`. TaskFlow checks
   the signature and confirms the subscription by itself.
5. Create a **configuration set** with an **event destination** of that topic
   for *Delivery, Bounce, Complaint, Reject, Delivery delay*.
6. Create the IAM user, put the five `AWS_SES_*` values in `.env`, set
   `EMAIL_PROVIDER=ses`, restart.
7. In TaskFlow → Email marketing → Settings: fill the postal address, sender,
   approved senders and reply-to, save, then **Check DNS now**.

### 3.4 Brevo

1. Brevo → Senders & domains: add and authenticate the domain (Brevo shows a
   `brevo-code` TXT record and DKIM records).
2. SMTP & API → create an API key → `BREVO_API_KEY`.
3. Transactional → Settings → Webhooks: add
   `https://taskflow.ekosight.com/api/taskflow/m/webhooks/brevo/<EMAIL_WEBHOOK_SECRET>`
   for *Delivered, Soft bounce, Hard bounce, Blocked, Spam, Invalid email,
   Deferred, Error*.
4. `EMAIL_PROVIDER=brevo`, restart. In Settings, add Brevo's DKIM selector
   (e.g. `brevo1`) so the DNS check can see it.

### 3.5 DNS records for the sending domain

Gmail and Yahoo require SPF, DKIM and DMARC from bulk senders (since February
2024), plus one-click unsubscribe (built in) and a spam-complaint rate under
0.3% (aim for under 0.1%).

| Record | Where | Value |
|---|---|---|
| SPF | TXT on the domain (or the MAIL FROM subdomain with SES) | One record only, e.g. `v=spf1 include:_spf.google.com include:amazonses.com ~all` (Brevo: `include:spf.brevo.com`) |
| DKIM | CNAMEs (SES: 3 × `…._domainkey`) or TXT (Brevo) | As the provider shows |
| DMARC | TXT on `_dmarc.<domain>` | Start with `v=DMARC1; p=none; rua=mailto:dmarc@<domain>`; move to `p=quarantine` once reports show only your own mail |
| MAIL FROM (SES) | MX + TXT on `mail.<domain>` | As SES shows |

Settings → **Check DNS now** reads these and says what to fix. It needs the
server to reach public DNS.

### 3.6 Replies

Choose one:

- **Google Workspace mailbox (recommended).** Use a mailbox people read (e.g.
  `replies@ekosight.com`) as the reply-to address and switch on **plus
  addressing** in Settings, so each reply goes to `replies+<code>@…` and is
  matched exactly. TaskFlow reads that one mailbox every five minutes with the
  Google Chat service account: in the Google Admin console → Security → API
  controls → Domain-wide delegation, add the scope
  `https://www.googleapis.com/auth/gmail.readonly` to the service account's
  client ID. Then in Settings tick "Read replies" and enter the mailbox.
  Without plus addressing, replies are still matched by the email they answer
  (In-Reply-To) or, failing that, by sender and "Re:" subject within 30 days.
- **An inbound mail service** (Postmark, Mailgun, SendGrid Inbound Parse) that
  posts to `https://taskflow.ekosight.com/api/taskflow/m/inbound/<MARKETING_INBOUND_KEY>`.

Out-of-office and delivery notices are not counted. A reply that just says
"unsubscribe" or "stop" unsubscribes the person from everything. People can
also mark a reply received by phone or WhatsApp on the contact.

### 3.7 Website conversions

When someone clicks a link, TaskFlow adds `tf_ref=<code>` (and UTM tags if the
link has none). When they complete something on soildoctor.in, the website's
**server** posts:

```
POST https://taskflow.ekosight.com/api/taskflow/m/conversions
X-TaskFlow-Key: <MARKETING_CONVERSION_KEY>
Content-Type: application/json

{ "ref": "<tf_ref from the landing URL>", "email": "optional", "value": 25000, "label": "Soil test booked", "id": "order-123" }
```

`id` makes retries safe. Never call this from the browser — the key would be
visible. Without `ref`, the person's latest clicked email within the attribution
window is used.

### 3.8 Before the first campaign

1. Settings: postal address, sender name and address, approved senders,
   reply-to, limits (default: 1 a day, 3 a week per person).
2. **Confirm festival dates.** Lunar festivals (Diwali, Holi, Makar Sankranti,
   the sowing seasons) are seeded **unconfirmed** with approximate dates; an
   automation never sends on an unconfirmed date. Check each and confirm it.
3. **Decide on the CRM sync.** Emailing people at organizations in the pipeline
   rests on your existing business relationship. Review that basis (see §7),
   then switch it on. It runs hourly.
4. Give people permissions: managers have view/manage/send/approve/export by
   default; admins also have settings. Members have none. Adjust per person in
   Team.
5. nginx: CSV imports can be up to 15 MB; raise `client_max_body_size` to
   `16M` if you will import files larger than the current 12 MB.

---

## 4. Costs (approximate — check current pricing)

| Item | Cost |
|---|---|
| Amazon SES | About **US$0.10 per 1,000 emails** (≈ ₹9). 20,000 emails a month ≈ US$2. Data transfer for images is small because images are served by TaskFlow. Optional dedicated IP ≈ US$25/month (not needed at this volume) |
| Brevo | Free plan limited to 300 emails a day; paid plans are priced by monthly volume — see brevo.com/pricing |
| SMTP via Google Workspace | No extra cost, but daily sending limits and the risk to company mailboxes make it unsuitable for bulk |
| Writing assistant (Claude Opus 5.5) | US$4 per million input tokens, US$20 per million output tokens: a suggestion is roughly 1,500 tokens in and 300 out ≈ **US$0.01 (≈ ₹1)**. Each person is limited to 30 requests per 10 minutes. Optional |
| Google Workspace reply mailbox | An existing mailbox; no extra cost |
| DNS, TaskFlow itself | No extra cost; the database grows by roughly 1–2 KB per email sent plus events |

For comparison, Mailchimp's Standard and Premium plans are priced by contact
count and rise steeply with it; check mailchimp.com/pricing for the figure at
your list size.

---

## 5. What it depends on

- **PostgreSQL** (the existing database, schema `taskflow`): all marketing data,
  including uploaded images.
- **`APP_PUBLIC_URL`** reachable over HTTPS from the internet: recipients'
  phones load images, follow links and open unsubscribe pages there. If it
  changes, links in emails already sent stop working.
- **The background worker** (`ENABLE_SCANNER=true`, `MARKETING_WORKER` not
  false): without it nothing is sent, scheduled or automated. Several servers
  may run it at once — messages are claimed with row locks so none is sent
  twice — but the signup forms' abuse limits are per server.
- **The pipeline's data**: organization types, tags, segments, owners and
  contacts' email addresses decide audiences and who gets follow-ups. Contacts
  without an email are not marketing contacts.
- **Google Workspace** (optional) for reading replies.
- **The provider's account health**: SES sandbox exit, bounce and complaint
  rates.

---

## 6. What tracking can and cannot see

- **Opens** come from a 1×1 image. Apps that block images are not counted (too
  low); Apple Mail Privacy Protection opens everything automatically (too
  high). Treat open rates as estimates; prefer clicks for A/B winners.
- **Clicks** pass through TaskFlow. Corporate link scanners (Mimecast, Proofpoint,
  Safe Links…) open links the instant mail arrives; clicks with scanner
  signatures or within 10 seconds of sending are kept but marked automatic and
  never counted as people or turned into tasks. Some scanners will still get
  through.
- **A click also counts as an open.**
- **Delivery and bounces** are only known from SES or Brevo. With SMTP or the
  outbox, reports say "not reported" rather than showing zero.
- **Replies** are counted only when the reply mailbox or an inbound service is
  connected and the reply can be matched.
- **Conversions** need the website to report them, a deal won / customer
  converted in the pipeline after a click, or a person marking one.
- **Forwarded emails**: actions by whoever it was forwarded to are attributed to
  the original recipient.

---

## 7. Compliance notes (not legal advice)

India's Digital Personal Data Protection Act 2023 requires a lawful basis
(consent, in most marketing cases), a clear notice, an easy way to withdraw
consent, and that data is used only for the stated purpose. The module helps:
the consent basis is required for every import and manual addition and kept
per person; signup forms record the exact words agreed to, the time, IP and
browser; double opt-in is available per audience; withdrawal is one click and
honoured everywhere; the consent log exports to CSV. Whether an existing
business relationship is enough for the CRM sync, and how long to keep data,
are decisions for EkoSight — take advice.

---

## 8. Not built, untested, and limits

**Not built in this release:** pop-up forms, landing pages and websites; inbox
previews across mail apps; time zones other than India; send-time as an A/B
variable; a click-map overlay; industry benchmarks; predictive scores (CLV,
likelihood to buy, predicted demographics); shop/e-commerce triggers and an API
trigger for automations; SMS, WhatsApp and social posting; languages other than
English and Hindi; an image editor; deleting contacts permanently (they are
archived; erasure requests need a database operation).

**Not tested against the live services** (no credentials in the build
environment): sending through Amazon SES, Brevo or SMTP; SES/SNS and Brevo
event delivery; reading a real Gmail mailbox; the Claude API; DNS lookups. The
request formats follow each provider's documentation; the AWS Signature V4
signer is checked against AWS's published example, and SNS signature checking
against keys generated in the test. Everything else — the whole flow from
contact to audience, approval, sending (outbox), delivery event, click, reply,
conversion, follow-up task, CRM history, unsubscribe enforcement, forms with
double opt-in, imports, A/B tests, automations (welcome, TaskFlow event,
festival), frequency limits, reports and CSV exports — is covered by automated
tests and was walked through in a browser. Template upload was tested with
HTML written the way Mailchimp and similar tools write it, not with real exports
from each tool, and the new brand design was checked in Chromium only, not in
Gmail, Outlook or Apple Mail.

**Before the first real send**, send tests to a Gmail, an Outlook and an
Apple Mail address and check placement (inbox vs spam), images, Hindi
rendering and the one-click unsubscribe in Gmail's header.

**Limits:** imports up to 50,000 rows / 15 MB per file; images up to 2 MB;
uploaded templates up to 8 MB as a file and 900 KB once prepared; up
to 8 A/B versions; segments up to 60 conditions, 4 levels deep; the outbox keeps
the last 500 messages in memory and is empty after a restart.

---

## 9. Day to day

- **Overview** shows the last 30 days, approvals waiting, deadlines and
  follow-ups.
- **Pausing**: a sending campaign can be paused, resumed or its unsent emails
  cancelled. An automation is paused to edit; it needs approving again after a
  change to its path, trigger, audience or sender.
- **Failures**: emails the provider refuses for a reason that may pass are
  retried after 1, 5, 30 and 120 minutes; refusals are marked failed. An email
  interrupted while being handed over is marked failed, not resent, because it
  may have arrived. "Retry failed emails" on a sent campaign queues them again.
- **Switching off**: Settings → Module. Staff screens disappear; unsubscribe
  and preference links in emails already sent keep working.

API reference: `docs/API.md` → *Email marketing*.

---

## 10. Templates and the Soil Doctor brand

Every email TaskFlow sends — campaigns, automation emails, tests, festival
greetings and the "please confirm" email — follows the Soil Doctor design
language (`soil-doctor-tokens.css`, October 2026). The brand is built into the
renderer rather than left to whoever designs the email, so it cannot drift:

- **Always added:** the Soil Doctor lockup at the top (or on a Deep Green band,
  or the small mark for personal notes) linking to the website set in
  Settings, and the footer with the mark, *Turning soil data into farmer
  prosperity*, company, postal address and the unsubscribe links.
- **Fixed:** Paper cards on a Sand (or Paper) ground, Manrope for everything
  (Noto Sans Devanagari for Hindi, Source Serif 4 italic only in testimonials),
  pill buttons in Deep Green, outline, gold or as a text link, 24–28 px
  corners, eyebrows with the strata dot, gold numbers on Deep Green, the
  data scale Soil Brown → Gold → Straw → Mint → Forest, and Mint / Aqua /
  Wheat tags. A design chooses among these; it never picks a colour or font.
- **Corrected:** colours in custom HTML or an uploaded template move to the
  nearest brand colour (its main colour becomes Deep Green) and fonts to
  Manrope, when it is saved and again when it is sent.
- **Checked:** emoji, example figures not yet replaced, two Deep Green
  sections in a row, more than two gold accents, and the usual sending checks.
  Emoji and example figures stop a campaign or automation being approved.

The logo, mark, strata dot, pulse line and watermark are PNG images served by
TaskFlow at `/api/taskflow/m/brand/…` (mail apps do not show SVG). Gmail and
Outlook do not load web fonts, so there Manrope falls back to Segoe UI,
Helvetica or Arial; Outlook on Windows also draws square corners and no
watermark. Apple Mail and iOS Mail show the full design.

### Adding templates, on screen

**Email marketing → Templates.** Anyone with *marketing.manage* can:

1. **Copy a starter** (*Copy & edit*): the copy is yours to change; the starter
   stays as it is. Starters marked *example sections* hold sample figures,
   readings, testimonials or event details — replace them with real ones; until
   then the email cannot be sent.
2. **Design a template** from the brand layout (hero, text, call to action):
   drag sections from the left, edit them on the right in English and Hindi,
   and watch the brand check above the canvas. *Preview* shows exactly what is
   sent, on a computer or a phone, as any contact.
3. **Save a campaign as a template**, from the campaign's Content tab.
4. **Upload a template**: an `.html` email exported from Mailchimp, Brevo,
   Campaign Monitor or HubSpot, or made by a designer, or a `.json` file
   exported from TaskFlow. The upload report lists every change: styles
   written onto elements (mail apps drop `<style>` sections), merge tags
   converted (`*|FNAME|*`, `[firstname,fallback=]`, `{{ contact.FIRSTNAME }}`
   → `{{first_name}}`; unsubscribe and preference links → TaskFlow's), images
   inside the file hosted, scripts, forms and frames removed, colours and fonts
   moved onto the brand, wide layouts made to shrink on phones. Merge tags
   TaskFlow cannot fill are listed for you to replace. Images the file points
   to on someone's computer (`images/hero.png`) cannot be fetched: upload them
   under Images and change the address. The template's own logo, if any, stays
   in its HTML — remove it, since the Soil Doctor header is added.
5. **Export** any template or starter as a `.json` file to keep, share or
   import into another TaskFlow.

Templates are archived, never deleted (*Show archived* brings them back).
*Use* starts a campaign from a template with its subject and preview text.

### Adding starters, for developers

Starters live in `server/src/services/marketing/starters.js`. Add an object
with a unique `key`, `name`, `category`, `description`, `subject` and
`preheader` as `{ en, hi }`, and a `design` built from the section types in
`server/src/lib/emailRender.js` (`BLOCK_TYPES`). Mark sections with sample
numbers, readings, quotes or details `example: true`. The tests in
`server/tests/emailTemplates.test.js` check every starter renders in both
languages with only brand colours, known merge tags and no emoji. The keys
`welcome`, `product`, `follow_up`, `festival` and `reengage` are used by the
automation recipes and must stay.

The brand values are in `server/src/lib/brand.js`. If the logo changes, render
new PNGs into `server/src/assets/brand/` with the same file names (two lockups
— ink and paper — at 4× of 150 px wide, the mark at 96 and 192 px, the strata
dot, the pulse line and the watermark).
