# Folding TaskFlow into the existing EkoSight application

TaskFlow is deliberately built as a module rather than a separate product. Nothing
about the standalone setup has to be undone when you integrate — the same code runs
both ways.

Three things make this work:

1. **The entire API is one Express router**, exported as `createTaskFlowRouter()`.
2. **Every table lives in its own PostgreSQL schema** (`taskflow` by default), so
   it can share the existing database without colliding with anything.
3. **Authentication is pluggable** — TaskFlow can issue its own tokens, or trust
   the session the host application has already established.

---

## Step 1 — decide where the data lives

**Option A (recommended): same database, own schema.**
Point `PGDATABASE` at the existing database and leave `DB_SCHEMA=taskflow`.
Migrations create the schema; nothing else in the database is touched. Reporting
across both systems is then a plain SQL join away.

**Option B: separate database.** Keep the values as they are in
`server/.env.example`. Simpler to reason about, but cross-system reporting means
two connections.

Run the migration from the host app at boot, or as a deploy step:

```js
import { runMigrations } from '@taskflow/server';
await runMigrations();
```

---

## Step 2 — mount the router

In the existing Express application:

```js
import { createTaskFlowRouter, runMigrations, startDeadlineScanner } from '@taskflow/server';

await runMigrations();

app.use(
  '/api/taskflow',
  requireLogin,               // the host app's existing auth middleware
  createTaskFlowRouter(),
);

startDeadlineScanner();       // background deadline / black mark scan
```

A complete, runnable example is in
[`examples/mount-in-existing-app.js`](./examples/mount-in-existing-app.js).

To depend on the package by path, add it to the host application's
`package.json`:

```json
{ "dependencies": { "@taskflow/server": "file:../Jira/server" } }
```

or copy `server/src` into the host repository and import from there. Either way
the import surface is the same: everything public is re-exported from
`server/src/module.js`.

---

## Step 3 — choose how people sign in

### Keep TaskFlow's own login

Leave `TRUST_HOST_AUTH=false`. TaskFlow issues its own JWTs against its own user
table. Useful while the two systems run side by side, and the fastest path to a
pilot.

### Reuse the host application's session (single sign-on)

Set `TRUST_HOST_AUTH=true`. TaskFlow then takes the caller from the request the
host app has already authenticated, in this order:

1. `req.taskflowUserId` — set it yourself if you keep an explicit mapping.
2. `req.user.taskflowUserId`.
3. `req.user.id` matched against the TaskFlow member's `external_user_id`.
4. `req.user.email` matched against the TaskFlow member's email.

So the minimum host-side glue is:

```js
app.use('/api/taskflow', requireLogin, (req, res, next) => {
  req.taskflowUserId = req.session.user.taskflowUserId; // optional, if you map ids
  next();
}, createTaskFlowRouter());
```

With option 3 or 4 no glue is needed at all — set `external_user_id` on each
TaskFlow member (there is a field for it in the Team screen), or make sure the
email addresses match.

**Note:** in this mode TaskFlow trusts the host completely for *identity*.
Authorisation is still TaskFlow's own — roles and permissions come from the
TaskFlow member record, so being an admin in the main app does not make anyone an
admin here.

---

## Step 4 — bring people across

Members can be added through the Team screen, or seeded from the existing employee
table:

```sql
INSERT INTO taskflow.users (full_name, email, role, department_id, external_user_id, is_active)
SELECT e.name,
       e.email,
       'member',
       (SELECT id FROM taskflow.departments WHERE key = 'OPS'),
       e.id::text,
       e.active
  FROM public.employees e
 WHERE e.active
ON CONFLICT DO NOTHING;
```

Members created this way have no password, which is correct when
`TRUST_HOST_AUTH=true`. If they also need TaskFlow's own login, use the Team
screen's **Reset password** action to issue a one-time password.

---

## Step 5 — serve the PWA

**As a sub-path of the main site** (`https://app.ekosight.com/taskflow/`):

```bash
cd client
VITE_BASE=/taskflow/ VITE_API_URL=/api/taskflow npm run build
```

Then serve `client/dist` from the host app:

```js
app.use('/taskflow', express.static('path/to/client/dist'));
app.get('/taskflow/*', (req, res) => res.sendFile('path/to/client/dist/index.html'));
```

The router picks the base path up automatically, and the service worker scope
follows it.

**As its own subdomain** (`https://tasks.ekosight.com`): build with the defaults
and set `CORS_ORIGINS` on the server to that origin.

---

## What the host application should not do

- **Do not write to TaskFlow tables directly.** Deadline changes, status moves and
  completions all have side effects — activity history, notifications, black mark
  evaluation. Go through the API so those stay consistent.
- **Do not disable the scanner in more than one process.** If the host app runs
  several instances, enable `ENABLE_SCANNER` on exactly one, or run
  `node server/src/jobs/runScan.js` from cron instead. Black marks are
  de-duplicated by a unique key, so a double run is harmless — but a single
  scanner keeps the logs readable.

---

## Endpoints at a glance

Everything is under `API_PREFIX` (default `/api/taskflow`). Full detail in
[API.md](./API.md).

| Area | Routes |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password` |
| Tasks | `GET/POST /tasks`, `GET /tasks/mine`, `GET/PATCH/DELETE /tasks/:id`, `POST /tasks/:id/move`, comments, checklist |
| People | `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password`, `GET /users/permissions/catalogue` |
| Structure | `/departments`, `/statuses` (with `POST /statuses/reorder`) |
| Black marks | `/blackmarks`, `/blackmarks/rules`, `/blackmarks/review`, `POST /blackmarks/scan`, `POST /blackmarks/:id/waive` |
| Reporting | `/reports/dashboard`, `/reports/workload`, `/reports/throughput` |
| Settings | `GET /settings`, `PUT /settings/:key` |

A health check that needs no authentication sits at `GET /health`.
