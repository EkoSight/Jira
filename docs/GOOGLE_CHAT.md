# Google Chat — set-up and how it works

TaskFlow sends three kinds of message to Google Chat:

| What | Where | When |
|---|---|---|
| **Instant alerts**: assignments, deadlines, mentions, comments, black marks, leave and attendance | A direct message to each person who has added the app | Within about a minute of the TaskFlow notification |
| **Morning summary**: overdue, due today, decisions waiting for you, a check-in reminder | The same direct message | Working days, default 08:45 India time; skipped when there is nothing to say |
| **Team summary**: who is away today, due today, overdue | A Chat space an admin points at a department | Working days, default 09:15 |

Everything still appears in TaskFlow's bell, too. Leave reasons, attendance
locations and pay are never sent to Chat.

## 1. Google Cloud: the Chat app (Configuration tab)

| Field | Value |
|---|---|
| App name | `TaskFlow` |
| Avatar URL | `https://taskflow.ekosight.com/icons/icon-192.png` |
| Description | `Task, deadline and leave alerts from TaskFlow` |
| Interactive features | On |
| Functionality | Receive 1:1 messages; Join spaces and group conversations |
| Connection settings | HTTP endpoint URL |
| HTTP endpoint URL | `https://taskflow.ekosight.com/api/taskflow/integrations/google-chat/events` |
| Authentication audience | HTTP endpoint URL |
| Build as a Workspace add-on | **Leave unticked** |
| Visibility | Yourself while testing; then everyone at ekosight.com |
| Logs | Log errors to Logging |

TaskFlow shows the exact endpoint it expects in **Settings → Google Chat**.

If you choose **Project number** as the authentication audience instead, also set
`GOOGLE_CHAT_PROJECT_NUMBER` in the server's `.env`.

## 2. The service account, in the server's `.env`

From the downloaded JSON key, TaskFlow needs three fields:

```
GOOGLE_CHAT_CLIENT_EMAIL=...        # client_email
GOOGLE_CHAT_PRIVATE_KEY="..."       # private_key, one line, \n for line breaks
GOOGLE_CHAT_PROJECT_ID=...          # project_id
```

This writes them in the right format, without copy-paste mistakes:

```bash
node -e '
const k = require("./taskflow-chat.json");
console.log("GOOGLE_CHAT_CLIENT_EMAIL=" + k.client_email);
console.log("GOOGLE_CHAT_PRIVATE_KEY=\"" + k.private_key.replace(/\n/g, "\\n") + "\"");
console.log("GOOGLE_CHAT_PROJECT_ID=" + k.project_id);
' >> server/.env
chmod 600 server/.env
shred -u taskflow-chat.json
```

Restart TaskFlow. The log line `Google Chat worker running as …` confirms it read
the credentials.

### If the key cannot be read

On the server, in the `server` folder:

```bash
npm run chat:check
```

It reports the key's length and line count (never its contents), names what is
wrong with it, and tries a real sign-in to Google. TaskFlow already repairs the
usual paste problems: single quotes, a trailing comma, `\\n`, real line breaks,
and backslashes stripped by systemd. Two things it cannot repair:

- **A key pasted over several lines without quotes.** Only the first line
  survives. Use the `node -e` command above.
- **A service manager with its own copy of the variable** (for example, systemd
  `Environment=` or `EnvironmentFile=`, or pm2). That copy takes precedence over
  `server/.env`; `chat:check` says so when the two differ.

If quoting keeps going wrong, store the key base64-encoded instead. Nothing in it
needs escaping:

```bash
node -e 'console.log("GOOGLE_CHAT_PRIVATE_KEY_BASE64=" + Buffer.from(require("./taskflow-chat.json").private_key).toString("base64"))' >> server/.env
```

Remove the old `GOOGLE_CHAT_PRIVATE_KEY` line when you use this.

**The private key is a password.** Never commit it or send it in chat or email.
If it leaks, delete the key in **Google Cloud → IAM & Admin → Service accounts**
and create a new one.

## 3. Turn it on

1. Open Google Chat. Choose **New chat**, find **TaskFlow** under apps, and start
   a chat. It replies "You're connected".
2. In TaskFlow, go to **Settings → My account → Google Chat** and click **Send me
   a test message**.
3. When the test arrives, go to **Settings → Google Chat**, tick **Send alerts and
   summaries to Google Chat**, and click **Save**.
4. Ask everyone to add the app (step 1). The People list shows who has.
5. For a team space: in Google Chat, open the space name, then **Apps &
   integrations → Add apps → TaskFlow**. Then choose its department in
   **Settings → Google Chat**.

People are matched by email. Their Google Workspace email must be the email on
their TaskFlow profile.

## 4. Install it for everyone (and everyone who joins later)

Instead of asking each person to add TaskFlow, an administrator can install it
for the whole organisation. Google then opens a TaskFlow chat for every person.
TaskFlow finds those chats and connects them, so nobody has to do anything.

### 4a. Publish TaskFlow privately to your organisation

Admin install only works for apps in the Google Workspace Marketplace. A
*private* listing is visible only inside ekosight.com and needs no Google review.

1. In Google Cloud, open the same project as the Chat app. Go to **APIs &
   Services → Library**, find **Google Workspace Marketplace SDK**, and enable it.
2. Make sure **APIs & Services → OAuth consent screen** exists, with user type
   **Internal**.
3. Open **Google Workspace Marketplace SDK → App configuration**:
   - **App visibility:** Private. This is permanent and cannot be changed later.
   - **Installation settings:** Individual + Admin install (the only option for Chat apps).
   - **App integration:** tick **Chat app**. It uses the Chat app you already configured.
   - **OAuth scopes:** add `https://www.googleapis.com/auth/chat.bot` if asked.
   - Developer name, website and email: EkoSight's.
   - Save.
4. Open **Store listing**:
   - Fill in the name (TaskFlow), a short and a long description, and a category.
   - Add icons: TaskFlow's are at `client/public/icons/`. Resize `icon-512.png`
     to the sizes asked for (128 × 128 and 32 × 32).
   - Add a screenshot of TaskFlow and the support links (your own website is fine).
   - Click **Publish**. Private apps are available immediately.

### 4b. Install it for everyone

1. In the Google Admin console (admin.google.com), go to **Apps → Google Workspace
   Marketplace apps → Apps list**.
2. Choose **Add app → Search for apps**. Open the **Internal apps** section and
   choose TaskFlow.
3. Click **Admin install**, choose **Everyone at your organization**, and finish.

Google opens a TaskFlow chat for each person. Users cannot uninstall an app an
administrator installed, but they can mute it, and they can still choose what
they get from TaskFlow under **My account**. Admin installs are made per
organisational unit, so people added to that unit later get the app as well.
Google's documentation does not say how soon a new person's chat appears.
TaskFlow checks every hour, so either way the person is connected at the next
check after their chat exists.

### 4c. Let TaskFlow match the chats to people (recommended)

An admin-installed chat starts empty, so Google does not tell TaskFlow whose it
is. TaskFlow can look it up when it can read the user directory (read-only):

1. In Google Cloud, open **IAM & Admin → Service accounts → taskflow-chat**, and
   copy its **Unique ID** (a long number, also called the client ID).
2. In the Admin console, go to **Security → Access and data control → API controls
   → Manage domain-wide delegation → Add new**:
   - **Client ID:** the number from step 1.
   - **OAuth scopes:** `https://www.googleapis.com/auth/admin.directory.user.readonly`
   - Authorise. This grants read-only access to the user list and nothing else.
3. In Google Cloud, enable the **Admin SDK API** for the project
   (**APIs & Services → Library**).
4. Add one line to `server/.env`, naming any super administrator the lookup
   reads as. Then restart TaskFlow.
   ```
   GOOGLE_CHAT_DIRECTORY_ADMIN=you@ekosight.com
   ```
5. In TaskFlow, go to **Settings → Google Chat → Install for everyone → Connect
   everyone now**.

TaskFlow then, at start-up and every hour:

- looks up each TaskFlow user's Google id by email (once per person);
- finds TaskFlow's chat with them;
- connects it, and sends a one-time welcome.

New TaskFlow users are connected automatically at the next hourly check, as long
as their TaskFlow email matches their Workspace email. The card lists anyone not
yet installed, and any TaskFlow user without a Workspace account.

**Without step 4c**, TaskFlow says hello once in each chat it cannot place,
asking the person to reply. Their first reply connects them.

## In Chat

In a direct message to TaskFlow, people can send:

| Message | What it does |
|---|---|
| `tasks` | Lists open tasks, soonest first |
| `summary` | Sends today's summary now |
| `stop` | Pauses instant alerts; the morning summary continues |
| `start` | Turns instant alerts back on |

Each person can also switch either kind off under **My account**.

## Reliability and security

- Every request to the endpoint must carry a token Google signed for that exact
  URL, from Chat's own account. Anything else gets a 401 and is ignored.
- Messages go through an outbox. Each one is sent once. A Google outage retries
  after 1, 5, 30 and 120 minutes. Failures are listed in Settings with a
  **Try again** button.
- When someone removes the app, Google reports the space as gone, and TaskFlow
  stops sending to it.
- Switching Chat on starts from the newest notification. History is never
  replayed.

## Not yet verified

These have been tested against stand-ins for Google, not the live service:

- Google Chat delivering events to `taskflow.ekosight.com`.
- Messages appearing in a real Chat space.

The sign-in call to Google's token service was exercised from the build
environment with a throwaway account. Google answered as expected ("account not
found"). The first real check is step 3 above, after deploying.
