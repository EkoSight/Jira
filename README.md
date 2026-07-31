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

**1. Make sure PostgreSQL is running and create a database.**

```bash
# macOS (Homebrew)
brew services start postgresql
# Linux
sudo service postgresql start
# Windows: start the "postgresql" service, or use the pgAdmin tray icon

createdb taskflow
```

**2. Install and configure.**

```bash
git clone https://github.com/EkoSight/Jira.git && cd Jira
npm install

cp server/.env.example server/.env
```

Open `server/.env` and set `PGUSER`, `PGPASSWORD` and `PGDATABASE` to match your
machine. Generate a `JWT_SECRET` while you are there:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**3. Create the tables and the first account.**

```bash
npm run migrate          # creates the taskflow schema and tables
npm run seed             # departments, statuses, default rules, admin account
```

Set `SEED_DEMO=true` in `server/.env` before seeding to also load a demo team and
16 sample cards — the quickest way to see the dashboard and black marks with real
numbers in them.

**4. Start it.**

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
npm run build            # builds the PWA into client/dist
npm start                # Express serves the API and the built PWA together
```

Everything is then on <http://localhost:4000> with the service worker active.

### If it will not start

The server explains the common failures rather than printing a stack trace — a
database that is not running, a wrong password, or a database that does not exist
yet each come with the command that fixes them.

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
