# TaskFlow — EkoSight

A lightweight, Jira-style task manager for day to day work across every EkoSight
department, built to be folded into the existing web application once it has been
tested and signed off.

React (Vite) PWA · Node.js + Express · PostgreSQL · JavaScript throughout.

---

## What it does

**Cards and boards**
- Task cards with department, status, stage, priority, type, assignee, reporter,
  deadline, estimate, progress, tags, checklist, comments and full history.
- Card references are department-prefixed and sequential: `MKT-14`, `EMB-3`.
- Kanban board with drag and drop on desktop and a move control on touch, plus a
  list view, saved filters in the URL, search and optional WIP limits per column.

**Visual summary**
- Tiles for open, in progress, overdue, due soon, critical, unassigned, blocked
  and completed — each one clicks through to the filtered board.
- Created vs completed trend, breakdowns by department, priority and status.
- Upcoming deadlines with how late or how soon each one is.

**People and bandwidth**
- "Who is working on what": open, active, overdue and critical counts per person,
  a capacity meter from their weekly hours, and a state of idle, available, busy,
  overloaded or stalled.
- Stalled means the person holds open work but nothing has moved for N days —
  that is the signal that someone is stuck, not just quiet.

**Black marks**
- Missed deadlines are recorded automatically against the assignee.
- Rules are yours to write: what triggers a mark, how many points, how much grace,
  which priorities, which departments, whether it escalates while a task stays
  overdue, and a cap per task.
- Monthly review lists everyone with their missed deadlines, marks and points, and
  flags anyone over your limit (3 by default) so action can be taken.
- Marks can be waived with a reason, and the waiver is kept on the record.

**Recurring work**
- A task can repeat daily, every working day, weekly or monthly. Completing one
  automatically creates the next occurrence — same owner, checklist and tags, due
  date rolled forward — so a daily routine is a fresh, closeable card each day
  with its own record.

**A real close-out, not just a status flip**
- Marking a task done opens a prompt that asks for the outcome and any proof
  (a link or image) before it will complete. The wording is tailored to the work
  and the person — a bug asks how the fix was verified, a procurement task asks
  for the PO, an overdue task asks what held it up — so it reads as a smart nudge
  rather than a blank box. The outcome is saved on the card for anyone to see.

**Working together on a card**
- Two people per task: an **owner** who is accountable for the deadline, and a
  **follower** who works on it alongside them. Black marks stay with the owner.
- **Tag anyone from any department** — a tagged person sees and can comment on the
  card even when it belongs to a team they are not in.
- **Sub tasks** are real cards. Completing them drives the parent's progress, so a
  parent can never claim to be further along than its children. On the board and in
  the list they are visually set apart — indented, with a link back to their parent
  task — and a parent shows how many subtasks it has. Clicking the link opens the
  parent.
- **Delete your own duplicates.** Whoever created a task can delete it outright
  (managers keep the softer archive). This is the fix for the accidental duplicates
  that creep in — only the creator, or a manager, can remove a card.
- **Attach Google Docs, Sheets, Slides and Drive links**, or upload images and
  documents. Uploads are served only to people allowed to see the task.

**Alerts**
- A chime and a desktop notification the moment work is assigned to you, or you
  are tagged, or a black mark is recorded. Mutable per device.

**Notes, ideas and recognition**
- A private **notepad** for each person — for the half-formed things you want to
  refer back to. Nobody else can read them, not even an admin.
- **Feature requests** from anyone, with voting, so the admin team can see what
  people actually want and reply to them.
- **Performer of the month**: a transparent score from completed work, on-time
  delivery and black marks, plus **kudos** anyone can give. The winner gets a
  shareable award card they can download and post.

**Access control**
- Roles: admin, manager, member, viewer — each with sensible defaults.
- Per-person overrides on top of the role, so one team lead can be given a single
  extra capability without inventing a new role.
- New members get a one-time password and are forced to change it at first sign in.

**PWA**
- Installs to a phone home screen, works in standalone mode, and keeps serving the
  last data it loaded when the network drops.

---

## Running it locally

Requirements: **Node 20+** and **PostgreSQL 13+**. Nothing else — no Docker, no
native build steps.

> Every command below is run **from inside the project folder**, and none of them
> take comments — do not paste a trailing `#  …` into Windows CMD or PowerShell,
> where `#` is not a comment character.

**1. Make sure PostgreSQL is running, then create a database.**

macOS: `brew services start postgresql`
Linux: `sudo service postgresql start`

On **Windows**, starting the service needs administrator rights — running
`net start postgresql-x64-18` from an ordinary prompt fails with
`System error 5 … Access is denied`. Either:

- press the Windows key, type `cmd`, right-click **Command Prompt** →
  **Run as administrator**, then `net start postgresql-x64-18` (use your own
  version number), or
- press `Win+R`, run `services.msc`, find `postgresql-x64-…`, right-click →
  **Start**. Set **Startup type** to **Automatic** in its Properties so it comes
  up with Windows from now on.

`npm run doctor` detects the exact service name installed on your machine and
prints the command for it.

```bash
createdb taskflow
```

If `createdb` is not on your PATH (common on Windows), use pgAdmin, or:

```bash
psql -U postgres -c "CREATE DATABASE taskflow;"
```

**2. Clone, enter the folder, and install.**

```bash
git clone https://github.com/EkoSight/Jira.git
cd Jira
npm install
```

That `cd` matters — every `npm run …` below has to run inside the `Jira` folder,
or npm reports `Could not read package.json`.

**3. Configure.**

Copy the example environment file:

```bash
cp server/.env.example server/.env
```

On Windows CMD, use `copy server\.env.example server\.env` instead.

Open `server/.env` and set `PGUSER`, `PGPASSWORD` and `PGDATABASE` to match your
machine. Generate a `JWT_SECRET` while you are there:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**4. Create the tables and the first account.**

```bash
npm run migrate
npm run seed
```

`migrate` creates the schema and tables; `seed` adds the departments, board
statuses, default black mark rules and the admin account, and prints the login it
created.

Set `SEED_DEMO=true` in `server/.env` before seeding to also load a demo team and
16 sample cards — the quickest way to see the dashboard and black marks with real
numbers in them.

**5. Start it.**

```bash
npm run dev
```

- PWA: <http://localhost:5173>
- API: <http://localhost:4000/api/taskflow>

Both restart on save. Sign in with the admin account the seed prints
(`admin@ekosight.com` / `ChangeMe123!` unless you set `ADMIN_EMAIL` and
`ADMIN_PASSWORD`); you are asked to change the password straight away.

### Trying it on a phone

The dev server also listens on your local network, so the mobile layout and the
install prompt can be tested on a real device on the same wifi. Vite prints the
address on startup:

```
➜  Network: http://192.168.1.24:5173/
```

Open that on the phone. For the full PWA experience — installing to the home
screen and offline reads — use the production build below, since service workers
need HTTPS or `localhost`.

### Production-style run (single server)

```bash
npm run build
npm start
```

`build` compiles the PWA into `client/dist`; `start` serves the API and that build
together on <http://localhost:4000>, with the service worker active.

### If it will not start

Run the setup check — it works through everything in order and stops at the first
thing that is wrong, with the command that fixes it:

```bash
npm run doctor
```

```
TaskFlow setup check

  ✓ server/.env found
  ✓ Node 22.22.2
  ✓ something is listening on localhost:5432
  ✓ connected to database "taskflow"
  ✗ the TaskFlow tables are not in schema "taskflow" yet

Next step:

  npm run migrate
  npm run seed
```

Failures elsewhere explain themselves the same way rather than printing a stack
trace — at startup in the terminal, and on the sign-in screen if something breaks
while the app is running.

| What you see | What it means |
|---|---|
| `Could not read package.json` | You are not inside the `Jira` folder — `cd Jira` first |
| `Cannot reach PostgreSQL` | The database service is not running (Windows: start `postgresql-x64-…` in Services) |
| `The TaskFlow tables are missing` | Run `npm run migrate` then `npm run seed` |
| `The database "taskflow" does not exist` | Create it: `createdb taskflow` |
| `PostgreSQL rejected the credentials` | Fix `PGUSER` / `PGPASSWORD` in `server/.env` |
| Sign-in says email or password is incorrect | The admin password has already been changed — see below |

To reset the admin account back to the seeded password:

```bash
psql -d taskflow -c "DELETE FROM taskflow.users WHERE email = 'admin@ekosight.com';"
npm run seed
```

### Tests

```bash
npm test
```

The suite covers permissions, password hashing, the task lifecycle, WIP limits,
black mark rules (idempotency, grace periods, priority scoping), waiving, the
monthly review, and the dashboard. It runs in its own `taskflow_test` schema and
skips cleanly if no database is reachable.

---

## Layout

```
server/
  src/
    router.js            the entire API as one mountable Express router
    module.js            public entry point for embedding into the existing app
    app.js               standalone Express app (API + built PWA)
    db/                  pool, migrations, seed
    routes/              auth, users, departments, statuses, tasks, blackmarks,
                         reports, settings, notifications
    services/            black mark engine, dashboard metrics, settings, activity
    jobs/                background deadline and black mark scanner
    middleware/          authentication, permission guards, error handling
client/
  src/
    pages/               Dashboard, Board, MyTasks, Team, BlackMarks, Settings
    components/          layout, task card, task dialog, charts, UI primitives
    state/               auth, reference data, toasts
  public/                manifest, service worker, generated icons
docs/
  INTEGRATION.md         folding TaskFlow into the existing application
  API.md                 endpoint reference
```

---

## Configuration

All server configuration is environment driven — see `server/.env.example`.
The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `DB_SCHEMA` | `taskflow` | Every table lives here, so TaskFlow can share the existing database without name clashes |
| `API_PREFIX` | `/api/taskflow` | Where the API mounts |
| `JWT_SECRET` | — | Set this in production |
| `TRUST_HOST_AUTH` | `false` | Set true when embedded, to reuse the host application's session instead of TaskFlow's own login |
| `UPLOAD_DIR` | `./uploads` | Where attachments are stored. **On a server, point this outside the deployment folder** or a redeploy can delete them |
| `UPLOAD_MAX_MB` | `10` | Largest attachment accepted |
| `ENABLE_SCANNER` | `true` | Background deadline / black mark scan |
| `SCANNER_INTERVAL_MINUTES` | `15` | How often that scan runs |

---

## Integrating with the existing application

TaskFlow was written to be mounted, not merged. The whole API is one Express
router and every table lives in its own schema, so the integration is three lines
in the host app plus a decision about authentication.

See **[docs/INTEGRATION.md](docs/INTEGRATION.md)** for the full checklist,
including how to map existing employees onto TaskFlow members and how to serve the
PWA from a sub-path of the main site.

## Deploying an update

Already running on a server? **[docs/DEPLOY.md](docs/DEPLOY.md)** covers the
release routine, and why an update never destroys existing tasks or users:

```bash
git pull && npm install && npm run build && npm run migrate
sudo systemctl restart taskflow
```

Migrations are additive and recorded, so re-running them is a no-op. A test in the
suite reads every migration and fails the build if one contains `DROP`, `TRUNCATE`
or `DELETE`, and another applies the migrations to a database full of tasks and
proves every row is unchanged.
