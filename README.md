# Skillscore Assess

A professional assessment and certification exam platform: pre-training diagnostics with proficiency bands and learning gain, timed certification mock exams, a past-question marketplace (Paystack and bank transfer), and live or self-paced quizzes. Every submission is marked automatically and instantly.

It runs as **one Node.js process** with **MySQL 8 / MariaDB 10.6+**, built for Hostinger hPanel Node.js hosting. There is no Docker, no Redis, no build step on deploy, and no native modules.

> The revised phase plan (adds AI generation, cyber security labs and company workspaces) is in [`docs/ROADMAP.md`](docs/ROADMAP.md). Import formats: [`docs/IMPORT_FORMATS.md`](docs/IMPORT_FORMATS.md).
>
> The full product brief is in [`PROMPT.md`](PROMPT.md). Decisions taken where the brief is open are in [`docs/DECISIONS.md`](docs/DECISIONS.md). The assessment of the earlier EXAMPRO prototype is in [`docs/00-exampro-assessment.md`](docs/00-exampro-assessment.md).

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1. Foundation | Config/env validation, all migrations, logging, errors, sessions, security, layouts, Tailwind, installer, auth (register, verify, login, 2FA, reset, Google), RBAC, admin and candidate shells | ✅ Done |
| 2. Catalogue & question bank | Hierarchical categories, certifications with weighted domains, training programmes with per-band courses; 11 question types with a rich editor, candidate preview (KaTeX, code highlighting), versioning, review workflow, tags, bulk actions, duplicate finder, report inbox, private image uploads | ✅ Done |
| 3. Import / export + AI generation | Excel, CSV, JSON, Aiken, GIFT, Word and ZIP imports with dry-run preview, duplicate handling, background batches, error report and 24-hour undo; templates; export to xlsx/JSON/GIFT; **AI question generation with Claude or OpenAI**; marketing landing page with plans | ✅ Done |
| 4. Exam builder + instruction generator + SQL lab + AI exams | 11-tab exam builder with autosave (sections, fixed lists, blueprint rules with live availability, bands, access rules, extra attempts, pre-publish checklist, versioned publishing, duplicate); instructions generated from the settings; **SQL lab question type** (sandboxed SQLite in worker threads, result-set marking); **AI “generate a complete exam”** | ✅ Done |
| 5. Exam engine, grading, results, certificates | Public catalogue and exam pages; eligibility rules (attempts, cooldown, overrides, window, invite code, IP/organisation, prerequisite, entitlement); mobile-first player with server timer, autosave + offline queue, resume, sections, palette, flags, review, keyboard, calculator/notepad, integrity events; §4 grading engine; results with domain radar, percentile, history and review; weak-area practice; PDF result slip; certificates with QR and `/verify`; admin attempts, grading queue, release, re-grade, revoke | ✅ Done |
| 6. Commerce (Paystack + bank transfer) | Paid exams, extra attempts, bundles and company plans; coupons; Paystack checkout with signed webhooks and idempotent fulfilment; bank transfer with receipt upload and admin approval; refunds; admin grants; PDF invoices/receipts and receipt emails; orders & library for candidates | ✅ Done |
| 7. Company workspaces & cohorts | | Next |
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

## Phase 2 highlights

- **Question types**: single choice, multiple response (optionally "select exactly N"), true/false, fill in the blank (several accepted variants, case and spacing options), numeric (± tolerance, units), matching (with distractors), ordering, hotspot (draw labelled regions on an image), short answer (weighted keywords and a threshold), essay (word limits and a marking guide), and case study (a scenario with child questions).
- **Versioning**: editing a question that has been live creates a new version; past attempts keep theirs. Every version can be viewed.
- **Workflow**: Draft → In review → Published → Retired. Authors are limited to their assigned categories; sending a question back requires a note.
- **Sample content**: `npm run seed` loads 13 categories, 3 certifications with weighted domains, a training programme and 25 original questions covering every type.

## Phase 4 highlights

- **Exam builder** (`/admin/exams`): Basics, Content, Timing, Attempts & access, Delivery, Scoring, Results, Integrity, Certificate, Instructions and Publish tabs. Every tab autosaves.
- **Content**: sections with their own time limits and minimum scores; a fixed list picked from the bank (marks per exam, ordering, move between sections), or **blueprint rules** that draw a random set per candidate by certification, domain, category, tag, difficulty and type, with a live “N questions available” check.
- **Pre-publish checklist** and **versioned publishing**: candidates always get the latest published snapshot.
- **Instructions** are generated from the exam's real settings (timing, scoring, negative marking, attempts, navigation, tools, integrity rules, result release, accommodations such as extra time).
- **SQL lab questions**: candidates write and run SQL against a sample database in the browser; answers are marked by comparing results with the model solution. Authors get a test bench (show tables, run the solution, verify).
- **AI “generate a complete exam”**: questions across the certification's domains (including SQL lab tasks), catalogue copy, and timing/pass mark scaled from the official format.
- `npm run seed` adds 6 SQL lab questions and three demo exams (a blueprint mock, a sectioned diagnostic, a draft practice test).

## Phase 5 highlights

- **Catalogue** at `/exams` and an exam page with the generated instructions, eligibility reasons and attempt history.
- **Exam player**: server-synchronised timer, autosave per answer, offline queue with automatic replay, resume on any device, timed sections, linear mode, palette with answered/flagged states, review screen, keyboard shortcuts (A–E, 1–9, N, P, F), larger text and high contrast, calculator and notepad, integrity events (tab switches, full screen, copy/paste) and a watermark. SQL lab questions run inside the attempt.
- **Grading** implements PROMPT §4 exactly (partial credit, negative marking, section minimums, bands, scaled scores) and is unit-tested rule by rule.
- **Results**: pass/fail or band, scaled score, percentile, time taken, domain radar, section and difficulty breakdowns, attempt history, question-by-question review with filters, recommended next step and “Practise my weak areas”.
- **Certificates and slips**: PDF certificate (three designs) and result slip with QR codes; public verification at `/verify`; LinkedIn sharing.
- **Admin**: attempts list with integrity filter, attempt timeline, override marks, grading queue for essays, release withheld results, re-grade, revoke certificates.
- To try the candidate side after `npm run seed`, register at `/register` and open the free certificate mock at `/exams/oracle-1z0-082-free-practice-mock`.

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

The schema is rebuilt from the migrations at the start of every run, and each test file gets its own temporary `storage/` directory. Test files run one at a time (`maxWorkers: 1`) because they share the test database and job queue.

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
