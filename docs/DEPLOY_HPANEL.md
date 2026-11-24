# Deploying on Hostinger hPanel (Node.js hosting)

This guide covers everything the platform needs as of Phase 1. Later phases add sections, such as the Paystack webhook (Phase 6).

## 1. Create the database

1. hPanel → **Databases → MySQL Databases**.
2. Create a database (for example `u123_assess`) and a user (`u123_assess_user`) with a strong password. Give the user **all privileges** on the database.
3. Note the host. On Hostinger shared/cloud plans it is usually `localhost`; check the "MySQL host" shown on that page.

The app creates every table itself (`utf8mb4`, InnoDB).

## 2. Create the Node.js application

1. hPanel → **Websites → your domain → Node.js** (or **Advanced → Node.js**).
2. **Node.js version:** 20 (18 and 22 also work).
3. **Application root:** the folder that will hold the code, for example `domains/example.com/assess`.
4. **Application startup file:** `server.js`.
5. Create the app. hPanel assigns the port through `PORT`, and the app reads it automatically.

## 3. Upload the code

Use either method:

- **Git** (hPanel → Git): deploy this repository into the application root.
- **ZIP**: zip the project **without `node_modules`** and `storage/*` contents, upload it with File Manager, then extract it into the application root.

`public/css/app.css` and `public/vendor/*` are committed, so **no build step is needed on the server**.

## 4. Environment variables

In the Node.js app settings, add every variable from `.env.example`. You can also create a `.env` file in the application root with the same contents. The required variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://assess.example.com` (no trailing slash) |
| `APP_KEY` | Run `npm run key:generate` on any machine with Node and copy the value. **Never change it later**: encrypted settings (SMTP password, Paystack secret, 2FA secrets) depend on it. |
| `SESSION_SECRET` | From `npm run key:generate` |
| `CRON_TOKEN` | From `npm run key:generate` |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | From step 1 |
| `DEFAULT_TIMEZONE` | `Africa/Lagos` (it can be changed later in Settings) |

Optional: `DB_POOL_MAX` (default 10), `LOG_LEVEL` (default `info`), `STORAGE_PATH`, `RUN_SCHEDULER`.

If a variable is missing or invalid, the app refuses to start and lists every problem in the application log.

## 5. Install dependencies

In the Node.js app page click **Run NPM install**, or in SSH from the application root run:

```bash
npm install --omit=dev
```

The production dependencies are pure JavaScript; nothing is compiled.

## 6. Database tables

Either let the web installer do it (step 8), or run it yourself over SSH:

```bash
npx knex migrate:latest
```

Migrations also run automatically every time the app starts after installation, so updates that add tables apply themselves.

## 7. Check that `storage/` is writable

The app creates `storage/uploads`, `storage/logs`, `storage/pdf`, `storage/imports`, `storage/backups` and `storage/mail-outbox` on boot. The application user must be able to write to the `storage/` folder (permissions `755` on folders are enough on Hostinger). The installer shows a red **Fix** badge if it cannot write there.

## 8. Start the app and run the installer

1. Click **Restart** (or **Start**) in the Node.js app page.
2. Open `https://your-domain/`. You will be redirected to `/install`.
3. Check that the three server checks are green, then enter the site name, timezone and the Super Admin account.
4. Sign in. You will be asked to set up two-factor authentication straight away; keep the recovery codes.

After a successful install `/install` returns 404. The lock file is `storage/installed.lock`.

## 9. Domain and SSL

1. Point the domain or subdomain at the Node.js application (hPanel does this when the app is created for that domain).
2. hPanel → **Security → SSL**: install the free SSL certificate and force HTTPS.
3. Make sure `APP_URL` starts with `https://`. In production, cookies are `Secure`, and the app trusts Hostinger's reverse proxy (`trust proxy = 1`).

## 10. Email (SMTP)

Admin → **Settings → Email (SMTP)**. For a Hostinger mailbox:

| Field | Value |
|---|---|
| Host | `smtp.hostinger.com` |
| Port / SSL | `465` with "Use SSL/TLS" ticked (or `587` without it) |
| Username / password | The full mailbox address and its password |
| From address | The same mailbox (or an alias of it) |

Click **Send test email**. Until SMTP works, verification and reset emails fail visibly under Admin → **Background jobs** (and on the dashboard), and you can retry them there.

## 11. Cron Job (keeps background work running)

hPanel can idle a Node.js app that receives no traffic. Add a Cron Job so scheduled tasks and queued jobs (emails, imports, certificates) always run:

hPanel → **Advanced → Cron Jobs → Custom**, every 5 minutes (`*/5 * * * *`), command:

```bash
wget -q -O /dev/null "https://your-domain/cron/run?token=YOUR_CRON_TOKEN"
```

Alternatively run the CLI directly (adjust the path to your application root):

```bash
cd ~/domains/example.com/assess && node scripts/cron.js
```

A task never runs twice, whether the in-process scheduler or the cron call reaches it first.

## 12. Restarting after an update

1. Pull the new code (Git) or upload the new files.
2. Run `npm install --omit=dev` if `package.json` changed.
3. Click **Restart**. Pending migrations and new permissions apply automatically on boot.

## Troubleshooting

| Symptom | What to check |
|---|---|
| **503 / 502 right after deploy** | Open the application log (Node.js page → logs, or `storage/logs/app.log`). A message starting with "Invalid environment configuration" lists the missing variables. |
| **Port errors** | Do not set `PORT` yourself on hPanel; it is assigned. The app always uses `process.env.PORT`. |
| **Installer shows "Database connection" in red** | The error text (for example `ER_ACCESS_DENIED_ERROR` or `ECONNREFUSED`) is shown. Check `DB_HOST` (often `localhost`), the user's privileges on the database, and the password. |
| **"storage/ folder is writable" in red** | Fix the folder permissions in File Manager (`755` on folders, owned by your hosting user). |
| **Signed out on every request / CSRF errors** | `APP_URL` must match the address in the browser (including `https://`), and SSL must be active: production cookies are `Secure`. |
| **Emails not arriving** | Admin → Background jobs → Failed shows the SMTP error. Use **Send test email** in Settings. Check spam, and SPF/DKIM for the sending domain in hPanel → Emails. |
| **Live features fall back to slow polling** | The proxy is blocking WebSockets; Socket.IO automatically falls back to HTTP long-polling. No action is needed. |
| **Forgot the Super Admin password and lost the 2FA device and recovery codes** | Over SSH, from the application root: `node scripts/create-admin.js "Name" admin@example.com "New-Password-123" --reset-2fa`. This resets the password, clears 2FA and signs out other sessions; you will enrol again at the next sign-in. |
