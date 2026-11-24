# Skillscore Assess

A professional assessment and certification exam platform: pre-training diagnostics with proficiency bands and learning gain, timed certification mock exams, a past-question marketplace (Paystack and bank transfer), and live or self-paced quizzes. Every submission is marked automatically and instantly.

It runs as **one Node.js process** with **MySQL 8 / MariaDB 10.6+**, built for Hostinger hPanel Node.js hosting. There is no Docker, no Redis, no build step on deploy, and no native modules.

> The full product brief is in [`PROMPT.md`](PROMPT.md). Decisions taken where the brief is open are in [`docs/DECISIONS.md`](docs/DECISIONS.md). The assessment of the earlier EXAMPRO prototype is in [`docs/00-exampro-assessment.md`](docs/00-exampro-assessment.md).

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1. Foundation | Config/env validation, all migrations, logging, errors, sessions, security, layouts, Tailwind, installer, auth (register, verify, login, 2FA, reset, Google), RBAC, admin and candidate shells | ✅ Done |
| 2. Catalogue & question bank | | Next |
| 3. Import / export | | |
| 4. Exam builder + instruction generator | | |
| 5. Exam engine, grading, results, certificates | | |
| 6. Commerce (Paystack + bank transfer) | | |
| 7. Organisations & cohorts | | |
| 8. Live quiz | | |
| 9. Analytics, notifications, CMS, support | | |
| 10. Hardening & delivery | | |

## What works today (Phase 1)

- **First-run installer** at `/install`. It checks Node, the database and storage permissions, runs migrations, creates the Super Admin, and then locks itself (`storage/installed.lock`).
- **Accounts**:
  - Registration with email verification.
  - Login with "remember me" and an idle timeout.
  - A lockout after 5 failures per email + IP in 15 minutes, with a visible notice.
  - Forgot/reset password with single-use 60-minute links.
  - Optional Google sign-in.
  - A password policy the admin can configure.
  - Sign-out of every other device after a password change.
- **TOTP two-factor authentication** with a QR code, recovery codes and replay protection. It is **mandatory for Super Admins and Admins**: they cannot reach anything else until they enrol.
- **Profile**: name for certificates, phone, country, organisation, job title, experience, timezone and photo. Users can **download their data** (JSON) and **request deletion** (NDPR/GDPR).
- **Permission-based RBAC**: 7 built-in roles, custom roles built by ticking permissions, and no privilege escalation. Every admin route checks a permission (enforced by a test).
- **Admin area**:
  - A KPI dashboard.
  - User management: search, filters, invite or set a password, roles, suspend, verify, reset 2FA, delete and anonymise, **accessibility accommodations** (extra time, large text, high contrast).
  - An **audit log** with before/after diffs.
  - **Settings**: general, branding colours and logo, security, SMTP with a test email, Google sign-in, maintenance mode and SEO.
  - Background jobs with retry.
- **Infrastructure**:
  - A DB-backed job queue with an in-process poller.
  - A scheduler that both `node-cron` and the hPanel Cron Job can trigger (`/cron/run?token=…`).
  - Rotating file logs in `storage/logs`.
  - Light and dark themes.
  - Mobile-first layouts: the sidebar becomes a drawer and tables become cards.

## Requirements

- Node.js 18, 20 or 22
- MySQL 8 or MariaDB 10.6+ (`utf8mb4`)

## Local setup

```bash
cp .env.example .env
```

```bash
npm run key:generate   # paste APP_KEY, SESSION_SECRET and CRON_TOKEN into .env, then set DB_* values
```

```bash
npm install
```

```bash
npm run migrate
```

```bash
npm run dev            # http://localhost:3000 → redirects to /install on first run
```

Instead of the web installer you can set `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` and `SUPERADMIN_NAME` in `.env` and run `npm run seed`, or run `node scripts/create-admin.js "Full Name" email@example.com "password"`.

Without SMTP settings in development, emails (verification, reset and so on) are written to `storage/mail-outbox/` so you can open the links.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Production start (`node server.js`) |
| `npm run dev` | Start with auto-restart on file changes |
| `npm run migrate` / `npm run migrate:rollback` | Apply or roll back Knex migrations |
| `npm run seed` | System data (roles, permissions, email templates) plus the Super Admin from `.env` |
| `npm run build:css` | Compile Tailwind to `public/css/app.css` (committed, so not needed on the server) |
| `npm run vendor` | Copy browser libraries into `public/vendor` (committed) |
| `npm run key:generate` | Print new `APP_KEY`, `SESSION_SECRET` and `CRON_TOKEN` values |
| `npm run cron` | Run due scheduled tasks and queued jobs once (CLI alternative to `/cron/run`) |
| `npm run create-admin` | Create or promote a Super Admin |
| `npm test` | Jest unit and integration tests |

## Tests

The integration tests use a real database, `skillscore_test` by default (override with `DB_NAME_TEST`). The DB user from `.env` needs full rights on it:

```sql
CREATE DATABASE skillscore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL ON skillscore_test.* TO 'skillscore'@'localhost';
```

```bash
npm test
```

The schema is rebuilt from the migrations at the start of every run, and each test file gets its own temporary `storage/` directory.

## Project layout

```
server.js            entry: Express + Socket.IO + scheduler + job poller (one process)
src/config           env (zod-validated), db (Knex), logger, paths, permissions, navigation
src/middleware       auth & RBAC, CSRF, sessions, security headers, rate limits, install guard, maintenance, errors
src/routes           public, auth, account, candidate, admin/*, install, cron
src/controllers      request handlers
src/services         settings, audit, RBAC, auth (users/passwords/tokens/TOTP), mail, jobs, uploads, theme
src/utils            crypto (AES-256-GCM), money (kobo), time (UTC ↔ timezone), html sanitising, pagination
views/               EJS layouts, partials and pages
public/              compiled CSS, JS, vendored libraries, fonts (all committed)
migrations/ seeds/   Knex
storage/             uploads, logs, PDFs, imports, backups (git-ignored)
tests/               Jest unit + integration
docs/                deployment guide, decisions, assessment
```

## Deployment

See [`docs/DEPLOY_HPANEL.md`](docs/DEPLOY_HPANEL.md).
