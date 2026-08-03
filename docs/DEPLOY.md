# Deploying updates to taskflow.ekosight.com

**The short version — no existing data is ever lost by an update:**

```bash
cd /srv/taskflow            # wherever the app is checked out
git pull
npm install
npm run build
npm run migrate
sudo systemctl restart taskflow
```

Everything below explains why that is safe and what to check if it is not.

---

## Why your tasks, users and black marks survive

Three guarantees, each enforced by a test that runs in CI and in `npm test`:

1. **Migrations are additive and tracked.** Every change lives in its own file in
   `server/src/db/migrations/`, and `schema_migrations` records which have already
   been applied. Running `npm run migrate` twice does nothing the second time.
2. **No migration may destroy data.** A test reads every migration file after the
   first and fails the build if it contains `DROP TABLE`, `DROP COLUMN`,
   `TRUNCATE`, `DELETE FROM`, a table rename, or a `NOT NULL` column with no
   default (which would fail on rows that already exist).
3. **The upgrade is tested against a populated database.** A test fills a database
   with tasks, comments, users, black marks and settings, then runs the
   migrations and asserts a fingerprint of every row is byte-for-byte identical.

To see those checks pass yourself before deploying:

```bash
npm test
```

**The one thing that is not in the database: uploaded files.** Images and
documents attached to tasks live on disk. See "Attachments" below — get this
wrong and a redeploy can delete them.

---

## First-time server setup

### 1. Environment

Create `server/.env` on the server (it is gitignored, so a `git pull` never
touches it):

```bash
NODE_ENV=production
PORT=4000
API_PREFIX=/api/taskflow

PGHOST=localhost
PGPORT=5432
PGUSER=taskflow
PGPASSWORD=<a strong password>
PGDATABASE=taskflow
DB_SCHEMA=taskflow

# generate with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=<64+ random characters>

CORS_ORIGINS=https://taskflow.ekosight.com

# attachments — MUST be outside the deployment folder
UPLOAD_DIR=/var/lib/taskflow/uploads
UPLOAD_MAX_MB=10

ENABLE_SCANNER=true
SCANNER_INTERVAL_MINUTES=15
```

### 2. Attachments

```bash
sudo mkdir -p /var/lib/taskflow/uploads
sudo chown -R taskflow:taskflow /var/lib/taskflow
```

Uploaded files are **not** in the database and **not** in git. If `UPLOAD_DIR`
points inside the checkout, a deploy that cleans the working tree deletes them.
`npm run doctor` warns when it is misconfigured.

Back it up alongside the database:

```bash
pg_dump -U taskflow -n taskflow taskflow | gzip > /backup/taskflow-$(date +%F).sql.gz
tar czf /backup/taskflow-uploads-$(date +%F).tar.gz -C /var/lib/taskflow uploads
```

### 3. Service

`/etc/systemd/system/taskflow.service`:

```ini
[Unit]
Description=TaskFlow
After=network.target postgresql.service

[Service]
Type=simple
User=taskflow
WorkingDirectory=/srv/taskflow
ExecStart=/usr/bin/node server/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now taskflow
```

### 4. nginx

```nginx
server {
    server_name taskflow.ekosight.com;

    client_max_body_size 12M;          # must exceed UPLOAD_MAX_MB

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

HTTPS is required, not optional: the PWA's service worker, desktop notification
permission and "install to home screen" all refuse to work over plain HTTP.

```bash
sudo certbot --nginx -d taskflow.ekosight.com
```

---

## The update routine

```bash
cd /srv/taskflow
git pull
npm install              # only when dependencies changed, harmless otherwise
npm run build            # rebuild the PWA
npm run migrate          # apply any new migrations; a no-op when there are none
npm run doctor           # confirms database, schema and upload folder are healthy
sudo systemctl restart taskflow
```

`npm start` also migrates on boot (`AUTO_MIGRATE` defaults to true), so the
explicit `npm run migrate` is belt-and-braces — it surfaces a migration failure
*before* the restart rather than during it.

### Zero-surprise checklist

```bash
# before
pg_dump -U taskflow -n taskflow taskflow | gzip > /backup/pre-deploy.sql.gz

# after
curl -s https://taskflow.ekosight.com/api/taskflow/health   # {"ok":true,...}
npm run doctor
sudo journalctl -u taskflow -n 50 --no-pager
```

### Rolling back

Migrations are additive, so an older build runs happily against a newer schema —
the new columns and tables are simply ignored:

```bash
git checkout <previous-tag>
npm install && npm run build
sudo systemctl restart taskflow
```

Only restore the database dump if a release actually corrupted data; you almost
certainly do not need to.

---

## After this release

Nothing is required — the new features light up on their own. Two optional steps:

- **Alerts.** Users get a chime and a desktop notification for new assignments.
  The browser asks for permission the first time; anyone who dismissed it can
  re-enable it from the bell menu, and the speaker icon in the top bar mutes the
  sound per device.
- **Permissions.** The new capabilities (`note.use`, `feature.request`,
  `kudos.give`, and for admins `feature.manage`, `recognition.manage`) are added
  to the existing roles automatically. Nothing to run.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `502 Bad Gateway` | The service is not running: `sudo systemctl status taskflow`, then `journalctl -u taskflow -n 100` |
| Attachments 404 after a deploy | `UPLOAD_DIR` is inside the checkout — move it to `/var/lib/taskflow/uploads` and restart |
| `413 Request Entity Too Large` | Raise `client_max_body_size` in nginx above `UPLOAD_MAX_MB` |
| Everyone logged out after a deploy | `JWT_SECRET` changed — it must stay the same across releases |
| Notifications never appear | The site must be served over HTTPS, and the browser must have been granted permission |
| Migration failed mid-deploy | Each migration runs in its own transaction and rolls back on failure. Fix the cause, run `npm run migrate` again — already-applied migrations are skipped |
