# BUILD PROMPT — Skillscore Assess: Professional Assessment & Certification Exam Platform

> **How to use this file:** Put it in an empty project folder as `PROMPT.md` (or paste it into Claude Code). Then tell Claude Code: *"Read PROMPT.md fully. Build the platform phase by phase, as instructed. Don't skip phases, and don't leave stubs or TODOs."*

---

## 0. ROLE & MISSION

You are a senior full-stack engineer and assessment-systems architect. Build **Skillscore Assess**, a production-ready, international-standard online examination platform. The platform name, logo and colours are set by the admin in Settings. Do not hard-code them.

The platform serves four purposes:

1. **Pre-training assessment.** Professionals take a diagnostic test before a training programme. The system places them in a proficiency band (Beginner / Intermediate / Advanced / Expert) and recommends a training track. After training, a post-test measures their **learning gain**.
2. **Certification practice and mock exams.** Timed, realistic simulations of professional certification exams such as Oracle, AWS, PMP, Lean Six Sigma, CompTIA, Cisco, ICAN and CIPM. These are organised by category and certification.
3. **Past-question marketplace.** Users buy past-question / practice-question packs for professional certifications through **Paystack**. Admin enters the Paystack keys in the dashboard.
4. **Live and self-paced quizzes (Wayground/Quizizz-style).** A host runs a live session with a join PIN, a per-question timer and a real-time leaderboard. The same content can also be assigned as self-paced "homework".

Every submission is **marked automatically and instantly**. The candidate sees a detailed performance report the moment they submit, subject to the admin's result-release policy.

Quality bar: this is not a demo. Every feature in this document must work end to end, with validation, error handling, empty states, loading states and mobile layouts. **No placeholders, no "coming soon", no TODO comments, no mock data in production code paths.**

---

## 1. NON-NEGOTIABLE TECH STACK (Hostinger hPanel compatible)

The app must run as a **single Node.js process** on Hostinger hPanel Node.js hosting with a **MySQL/MariaDB** database. Design every choice around that.

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 LTS (must also run on 18 and 22) | hPanel Node versions |
| Server | Express.js 4.x | Required |
| Views | Server-rendered **EJS** with layouts (`express-ejs-layouts`) | No server-side build step needed |
| Styling | **Tailwind CSS**, compiled to `public/css/app.css` and **committed to the repo** | hPanel needs no build on deploy |
| Interactivity | **Alpine.js** + small vanilla JS modules. **Chart.js** for charts. **KaTeX** for maths. **highlight.js** for code | Light, no bundler required |
| Database | MySQL 8 / MariaDB 10.6+ through **Knex.js** (migrations + seeds) with the `mysql2` driver | Works on hPanel. No native binaries |
| Sessions | `express-session` + `express-mysql-session` | No Redis on shared hosting |
| Real-time | **Socket.IO** (it falls back to long-polling automatically if WebSockets are blocked by the proxy) | Live quiz mode |
| Validation | **zod** | Shared request schemas |
| Auth hashing | **bcryptjs** (NOT `bcrypt`, which is native) | Avoid native compilation on hPanel |
| 2FA | `otplib` + `qrcode` | TOTP for admin accounts |
| Uploads | `multer` (disk storage under `storage/uploads`) | |
| Import parsing | `exceljs` (xlsx), `csv-parse`, `mammoth` (docx), `adm-zip` (image bundles) | |
| PDF | **pdfkit** (result slips, certificates, invoices). **Do NOT use Puppeteer/Chromium** | Too heavy for shared hosting |
| Email | `nodemailer`. SMTP credentials stored in admin Settings | |
| Scheduling | `node-cron` in-process, **plus** a `/cron/run?token=...` endpoint and a `scripts/cron.js` CLI so hPanel Cron Jobs can trigger jobs if the process sleeps | |
| Security | `helmet`, `csurf`-equivalent (use `csrf-sync` or a double-submit token), `express-rate-limit`, `sanitize-html`, `hpp` | |
| Logging | `pino` + `pino-http`, rotating file logs in `storage/logs` | |
| Tests | **Jest** + **supertest** | |

**Hard hosting rules:**
- Read the port from `process.env.PORT`. The entry file is `server.js` in the project root. `package.json` has `"start": "node server.js"`.
- **No Docker, no Redis, no separate worker processes, no PM2 cluster mode.** Use a DB-backed `jobs` table with an in-process poller for background work (emails, imports, certificate generation).
- **No dependency that needs `node-gyp`/native compilation.** Before you add a package, check that it is pure JS or ships prebuilt binaries for linux-x64. If in doubt, choose the pure-JS option.
- Everything must work behind Hostinger's reverse proxy: `app.set('trust proxy', 1)`, secure cookies when `NODE_ENV=production`.
- All writable paths live under `/storage` (uploads, logs, generated PDFs, import temp files). Create them on boot if they are missing.
- Provide a **first-run web installer** at `/install`. It checks DB connectivity, runs migrations, creates the Super Admin and sets the site name. It then locks itself by writing `storage/installed.lock`.
- Set the default timezone to **Africa/Lagos**, configurable. Store all timestamps in UTC and show them in the user's or site's timezone.
- Set the default currency to **NGN**. Store money as **integer minor units (kobo)**.

---

## 2. USER ROLES & PERMISSIONS (RBAC)

Build permission-based RBAC, not just role names. Store `roles`, `permissions` and `role_permissions` in the database. Seed these roles:

| Role | Can do |
|---|---|
| **Super Admin** | Everything, including Settings, payment keys, roles and the audit log |
| **Admin** | Manage categories, exams, questions, imports, users, orders and reports. Cannot see the Paystack secret key or change roles |
| **Question Author** | Create and edit questions in assigned categories. Submit them for review |
| **Reviewer** | Approve or reject questions (the question workflow is Draft → In Review → Published → Retired) |
| **Organisation Manager** (corporate client / training coordinator) | Manage their organisation's candidates, assign exams, buy seats, view cohort reports |
| **Instructor / Live Host** | Run live quiz sessions, assign self-paced quizzes, view their sessions' results |
| **Candidate** | Browse the catalogue, take exams, buy past questions, view results, download certificates |

Admins can create custom roles by ticking permissions. Every admin action is written to the **audit log**: who, what, before/after JSON, IP and timestamp.

---

## 3. CORE MODULES & FEATURES

### 3.1 Authentication & Accounts
- Register with email and password. **Email verification** is required before a candidate can take a paid or proctored exam.
- Login, logout, "remember me", forgot/reset password (token expires in 60 minutes, single use).
- **TOTP 2FA**, mandatory for Super Admin and Admin, optional for others.
- Rate limiting on login (5 attempts per 15 minutes per IP + email). Show an account-locked notice.
- Profile: full name (used on certificates), phone, country, organisation, job title, years of experience, photo, timezone.
- **Accessibility accommodations**, set per user by an admin: extra time (+25% / +50% / custom), larger font, high-contrast mode. These apply automatically to every attempt.
- Optional Google sign-in, behind a Settings toggle with admin-entered OAuth credentials.
- Users can request account deletion and download their data (NDPR/GDPR friendly).

### 3.2 Catalogue: Categories, Certifications, Programmes
- **Categories** are hierarchical (parent → child), e.g. *Database → Oracle → Oracle 19c DBA*. Each has a slug, icon/image, description, display order and an active flag.
- **Certifications** belong to a category. Fields: issuing body (free text), exam code (e.g. `1Z0-082`), official passing score, official duration, number of questions, domains/objectives with weightings (%), and an external link.
- **Training Programmes** (for pre-training assessment): name, description, levels, and a recommended-course URL for each proficiency band.
- **Public catalogue pages** are SEO-friendly. They include search, filters (category, certification, type, free/paid, difficulty), sorting, and exam cards that show duration, question count, attempts allowed, price and rating.

### 3.3 Question Bank
Supported **question types**. Each has an exact marking rule, defined in §4:
1. Single choice (MCQ)
2. Multiple response ("select all that apply"), with an optional "select exactly N"
3. True / False
4. Fill in the blank (one or more blanks; accepts several correct variants per blank; case-sensitivity and whitespace-trim options)
5. Numeric (exact value or tolerance ±, with units shown)
6. Matching (pairs)
7. Ordering / sequencing
8. Hotspot-lite (the candidate picks one of several labelled regions on an image)
9. Short answer (keyword-based auto-marking with a configurable keyword weighting; admin can override)
10. Essay / long answer (**manual grading queue**. The result shows "pending" for this item only)
11. Case study / scenario group (a shared passage or exhibit with several child questions)

Each question has:
- A rich-text stem (sanitised HTML) with images, tables, code blocks and LaTeX
- Options with optional per-option feedback
- The correct answer(s)
- A **detailed explanation** shown in review, plus an optional reference (book/URL)
- Category, certification, **domain/objective**, topic, tags
- Difficulty: 1 to 5
- Bloom's level: Remember → Create
- Default marks
- Estimated time in seconds
- Status: Draft / In Review / Published / Retired
- Author, reviewer, version number (editing a published question creates a new version; past attempts keep the version they answered)
- A **content hash** for duplicate detection
- Usage statistics (see Item Analysis, §3.12)

Question bank UI: a data table with server-side pagination, full-text search, multi-filter, bulk actions (publish, retire, move category, add tags, add to exam, delete), a duplicate finder, a preview exactly as the candidate sees it, and a "report an issue" inbox.

### 3.4 Question Import (must be bullet-proof)
Admin uploads questions, which are **validated, imported and made usable immediately** (auto-publish when the admin chooses to).

Supported formats:
- **Excel (.xlsx)** and **CSV**. Provide downloadable **templates** for each question type, with an instructions sheet and example rows.
- **JSON** (documented schema)
- **Aiken** format (plain-text MCQ)
- **GIFT** format (Moodle)
- **Word (.docx)**, using a documented pattern: numbered question, lettered options, `Answer:` line, `Explanation:` line. Parse it with mammoth.
- **ZIP bundle**: a spreadsheet plus an `images/` folder. Image filenames referenced in cells are linked automatically.

Import flow (a wizard):
1. Upload the file and choose a format (auto-detected where possible).
2. Pick the defaults: target category, certification, difficulty and status (Draft or **Publish immediately**), and optionally **"Attach to exam: [select]"** or **"Create a new exam from these questions"**.
3. **Dry-run preview**: a table of the parsed questions with per-row ✅ / ⚠️ / ❌. It shows the exact error ("Row 14: correct answer 'E' not among options A–D") and flags duplicates by content hash, with Skip / Overwrite / Import-as-new options.
4. Confirm. Run the import as a background job with a progress bar (polling). Large files (5,000+ rows) must not time out the HTTP request.
5. Summary: imported / skipped / failed counts, and a **downloadable error report (xlsx)** with the failed rows and the reason, so the admin can fix them and re-upload.
6. Imports run inside a transaction per batch and are fully reversible: an **"Undo this import"** button stays available for 24 hours.

Export: questions, filtered or all, to xlsx / JSON / GIFT. Only roles with the `questions.export` permission can export.

### 3.5 Exam / Assessment Builder
Exam types: **Pre-Training Diagnostic**, **Post-Training Assessment**, **Practice Test**, **Mock Certification Exam**, **Past Questions Pack (practice mode)**, **Live Quiz**, **Self-paced Assignment**.

Settings for each exam (grouped into tabs in the builder):

**Basics.** Title, slug, category, certification, type, cover image, short and long description, language, difficulty label, tags, visibility (Public / Unlisted / Private-org only / Invite code).

**Content.**
- **Fixed question list** (drag-to-reorder), **or**
- **Dynamic blueprint**: rules such as "12 questions from Domain A, difficulty 2–3; 8 from Domain B, any difficulty". Each attempt draws its own set. Validate that the bank has enough questions for each rule and warn the admin if not.
- **Sections**, each with its own optional time limit, instructions and pass requirement (e.g. "Section 2 must score ≥ 50%").
- Question pool size versus the number of questions delivered.

**Timing.** Total duration, per-section timers, optional per-question timer, availability window (open from/to, in the exam timezone), grace period, and the action on time-out (auto-submit is the default).

**Attempts & access.**
- **Maximum attempts allowed** (1 to unlimited).
- **Cooldown between attempts** (e.g. 24 hours).
- **Per-user attempt override**: admin can grant extra attempts to a specific candidate, with a reason that is logged.
- **Buy extra attempts**: optional, paid through Paystack.
- Which score counts: best / latest / average / first.
- Free or Paid (price, sale price, access duration in days or lifetime).
- Require email verification. Require an organisation assignment.
- Prerequisite exam (must pass X before Y).

**Delivery.**
- Shuffle questions; shuffle options (and keep "All of the above" pinned last if the admin marks it).
- Navigation mode: **Free** (jump anywhere, flag for review) or **Linear** (no going back).
- One question per page, or all on one page.
- Show the question palette, show the timer, allow a calculator (built-in basic/scientific), allow a notepad (scratchpad).
- Practice mode: "Check answer" per question, with instant feedback and explanation.

**Scoring.**
- Pass mark (% or raw).
- **Negative marking** (e.g. −0.25 per wrong answer; unanswered = 0).
- Partial credit on/off for multi-response, matching and ordering.
- Scaled score: optionally map raw % to a scale such as 100–1000, like real certification exams, with a configurable formula.
- **Proficiency bands** for diagnostics, e.g. 0–39 Beginner, 40–64 Intermediate, 65–84 Advanced, 85–100 Expert. Each band links to a recommended training programme or course URL and a message.

**Result release policy.**
- Immediately: full review (the candidate's answer, the correct answer, the explanation)
- Immediately: score + domain breakdown only (no answers; protects the bank)
- Score only
- After the exam window closes
- Manual release by admin

**Integrity / proctoring (lightweight, browser-based):**
- Full-screen required (exits are logged and warned).
- **Tab/window-switch detection**: count the switches, warn, and optionally auto-submit after N.
- Disable right-click, copy, paste and text selection during the exam.
- One active session per attempt (a second device or tab is blocked and logged).
- IP and user-agent logging. Optional IP allow-list for corporate venues.
- Optional **webcam snapshots** at random intervals (with explicit consent; stored privately; viewable in the attempt review). Off by default.
- A visible watermark with the candidate's name and email on the exam screen, to discourage screenshots.
- An **integrity score** and **event timeline** per attempt for admin review.

**Certificate.** Award a certificate on pass: on/off, template selection, signatory name and signature image.

**Automatically generated instructions (required feature).**
Do not make the admin type instructions. Build an **Instruction Generator** service that composes clear, professional, candidate-facing instructions from the exam's actual settings. The generated text must cover:
- the exam title, type and purpose (diagnostic vs certification practice)
- the number of questions, sections, and question types present
- the total duration, per-section timers, and what happens when time expires
- the pass mark and scoring scheme, **negative marking** if enabled, and partial credit rules
- attempts allowed / remaining for *this* user, cooldown, and which attempt counts
- the navigation mode (whether they can go back), flag-for-review, palette, calculator, notepad
- the integrity rules in force (full-screen, tab-switch limit, webcam, single device)
- the result release policy (what they will see and when)
- accommodations applied to this user (e.g. "You have been granted 25% extra time")
- technical tips: stable internet, autosave behaviour, how to resume if disconnected

The generator re-runs whenever settings change, so the instructions never go stale. Admin can add **custom notes** (prepended or appended) but cannot accidentally contradict the settings. Show a live preview in the builder. Before starting, the candidate sees the instructions page with an **"I have read and agree"** checkbox and a system-check panel (browser, connection speed ping, full-screen support, webcam if required). Write the generator as a pure function, `generateInstructions(exam, user, attemptContext)`, with unit tests.

**Builder UX.** Autosave drafts, a "Preview as candidate" button, a **pre-publish checklist** (questions available, pass mark set, price set if paid, blueprint satisfiable), Publish / Unpublish, Duplicate exam, and a version history.

### 3.6 Exam-Taking Experience (the most important screen)
- Fully responsive and **mobile-first**. It must be comfortable on a 360px phone and on a desktop.
- Layout: a header with the exam title, the **server-synchronised countdown timer** and a progress bar. Main area: the question. Footer: Previous / Flag / Next. A slide-out **question palette** shows status colours: answered, unanswered, flagged, current.
- **Server-authoritative timing.** The server stores `started_at` and `expires_at`. The client timer re-syncs every 30 seconds and on every save. Refreshing or changing device never resets time.
- **Autosave** every answer immediately (debounced) via `PATCH /attempts/:id/answers`. If offline, queue answers in `localStorage` and replay them when the connection returns. Show a "Saved ✓ / Saving… / Offline – answers stored locally" indicator.
- **Resume**: if the browser closes, the candidate can resume the same attempt until `expires_at`.
- Before submitting, show a review screen listing unanswered and flagged questions, then a confirmation modal.
- **Auto-submit** when time expires, client-side and enforced server-side. A cron sweeper finalises any expired attempt that was never submitted.
- **Security: correct answers are NEVER sent to the browser before submission.** The client receives only stems and options (with option IDs shuffled per attempt). Marking happens only on the server.
- Accessibility: full keyboard navigation (1–9 or A–E to select options, N/P for next/previous, F to flag), ARIA labels, focus states, a font-size toggle, high-contrast mode, screen-reader friendly. Aim for WCAG 2.1 AA.
- Render KaTeX maths and syntax-highlighted code. Images open in a zoomable lightbox.
- Low-bandwidth friendly: lazy-load images and keep the exam page JS small.

### 3.7 Instant Marking & Performance Report
When the candidate submits, mark the attempt on the server in the same request (inside a DB transaction) and redirect to the **Result page**. The page shows, subject to the release policy:
- A big, clear score (raw, %, scaled if enabled), a **PASS/FAIL** badge or **proficiency band**, and the pass mark.
- Time taken versus time allowed, and average time per question.
- **Domain/objective breakdown**: a table plus a **radar chart**, highlighting strengths (≥ 75%) and weak areas (< 50%).
- Section breakdown, and difficulty breakdown (how they did on easy vs hard questions).
- **Percentile rank** against all candidates on this exam.
- **Attempt history graph**: score trend across their attempts.
- For diagnostics: the **recommended training track**, with a link, based on the band and the weakest domains.
- **Question-by-question review**: their answer, the correct answer, the explanation and the reference. Filters: All / Wrong / Flagged / Unanswered.
- **"Retake weak areas"**: generate a personalised practice set from the domains they failed (if practice content exists).
- Download a **PDF result slip** (branded, with a QR verification code).
- On pass, show a **certificate** with a unique ID and QR code linking to the public verification page `/verify/:certificateId`.
- Optional share buttons (LinkedIn share for certificates).
- Essay items appear as "Pending manual grading". The candidate is emailed when grading is complete and the final score updates.

### 3.8 Past Questions Marketplace
- **Packs** are linked to a certification. Each has a title, description, cover, number of questions, years/editions covered, a sample of 5 **free preview questions**, price, sale price, and access duration (lifetime or N days).
- **Bundles** combine several packs at a discounted price.
- **Coupons**: percentage or fixed; usage limits (total and per user); expiry; restricted to specific products.
- Cart and checkout through **Paystack**.
- After purchase, the pack unlocks in **"My Library"** with three modes:
  - **Study mode** (browse questions with answers and explanations)
  - **Practice mode** (instant feedback)
  - **Timed mock mode** (exam simulation using the pack's blueprint)
- Content protection: no bulk export for candidates; a dynamic watermark (name/email); rate-limited question fetching; copy disabled; access checks on every request.
- Ratings and reviews from verified purchasers only, with admin moderation.
- Invoices/receipts as PDF with an order number.

### 3.9 Payments — Paystack (admin-configured)
- **Settings → Payments**: Public key, Secret key, mode (**Test / Live**), webhook URL (displayed, read-only, with a copy button), allowed currencies (NGN default; also GHS, ZAR, KES, USD if the account supports them), and a "Test connection" button that calls the Paystack API to validate the keys.
- **Encrypt the secret key at rest** with AES-256-GCM, using `APP_KEY` from `.env`. Never render it back in full; show `sk_live_••••1234`.
- Flow: create a pending `order` → initialise the transaction server-side (`POST https://api.paystack.co/transaction/initialize`, amount in kobo, a unique `reference`, metadata with `order_id` and `user_id`) → redirect to Paystack or open Paystack Inline → on the callback, **always verify server-side** with `GET /transaction/verify/:reference` → check the amount, currency and status → fulfil.
- **Webhook** `POST /webhooks/paystack`: verify the `x-paystack-signature` header (HMAC SHA512 of the raw body using the secret key; use `express.raw` for this route only). Handle `charge.success` and `refund.processed`. **Make fulfilment idempotent** (unique constraint on `reference`; ignore duplicates). Respond 200 quickly.
- Fulfilment grants the right entitlement: exam access, pack access, extra attempts, or organisation seats.
- Admin **Orders** page: filter by status, date and product; view the order detail and the Paystack response payload; mark refunded (with a reason, which revokes access); export CSV.
- Optional **subscription plans** (e.g. "All-Access Monthly") using Paystack Plans. Handle `subscription.create` and `subscription.disable` webhooks, and expire access on lapse.
- Revenue dashboard: daily/monthly revenue, top products, coupon usage, conversion rate.
- Write **automated tests** for signature verification, idempotency and amount-mismatch rejection.

### 3.10 Organisations / Corporate Training Clients
- An organisation has a name, logo, contact, and **seat balance**. Seats can be bought via Paystack or allocated by an admin.
- Org managers can **bulk-invite candidates** (CSV upload or a list of emails), with auto-created accounts and invitation emails, or share an **org join link/code**.
- Create **cohorts/groups** (e.g. "Oracle 19c Bootcamp – Jan Cohort"). Assign pre-training and post-training exams to a cohort with a deadline.
- The **cohort report** shows completion rate, average score, band distribution, domain heatmap (candidates × domains), and **pre-vs-post learning gain** per candidate and for the cohort (normalised gain = (post − pre) / (100 − pre)). Export to xlsx and PDF.
- Reminder emails before deadlines (scheduled job).

### 3.11 Live Quiz Mode (Wayground/Quizizz-style)
- A host picks a quiz and launches a live session. The system generates a **6-digit game PIN** and a QR code.
- Players join at `/join` with the PIN and a nickname. A guest join is allowed if the host enables it; otherwise login is required.
- Lobby: the players list appears live, and the host clicks Start.
- Two modes:
  - **Host-paced**: the question shows on the host's projector screen and players answer on their phones.
  - **Player-paced**: everyone moves at their own speed.
- Points for correctness **plus a speed bonus**, and streak bonuses. A live **leaderboard** after each question, a podium at the end. Optional power-ups toggle, kept simple.
- Host dashboard: live response distribution per option, who has answered, kick player, pause, skip.
- After the session: a full report (per player, per question), exportable. Also an **"Assign as homework"** option to reuse the quiz self-paced with a deadline.
- Implement with Socket.IO rooms. All scoring stays on the server. Player state survives reconnects (rejoin with the same nickname and token).

### 3.12 Analytics & Psychometrics (makes the platform "international standard")
- **Item analysis** per question, recomputed by a nightly job:
  - Difficulty index (p-value = proportion correct)
  - **Discrimination index** (point-biserial correlation, and the upper/lower 27% method)
  - **Distractor analysis** (how often each wrong option is chosen; flag distractors nobody picks)
  - Average time spent
  - Auto-flags: "too easy (p > 0.90)", "too hard (p < 0.20)", "negative discrimination – check the answer key"
- **Exam reliability**: Cronbach's alpha / KR-20, shown on the exam analytics page.
- Exam analytics: attempts, completion rate, pass rate, score distribution histogram, average time, drop-off points.
- Admin dashboard KPIs: total users, new sign-ups, attempts today, pass rate, revenue (today/MTD), pending essays to grade, reported questions, failed imports.
- Candidate dashboard: exams in progress, upcoming assigned exams, recent results, library, certificates, a skills radar across all attempts, and a learning streak.

### 3.13 Notifications & Communication
- Email templates are editable in admin, with variables such as `{{name}}`, `{{exam_title}}` and `{{score}}`. Templates: welcome/verify email, password reset, purchase receipt, exam assigned, deadline reminder, result available, essay graded, certificate issued, org invitation.
- In-app notification bell with a read/unread state.
- Admin **announcements**: a site-wide banner, or targeted by role, organisation or cohort.
- SMTP settings with a **"Send test email"** button.

### 3.14 Support & Content Quality
- Candidates can **report a question** from the review screen ("wrong answer key", "typo", "unclear"). Reports go to an admin queue, where the admin can resolve, edit the question, or **re-grade all affected attempts** (re-scoring must update results and notify the affected candidates).
- An FAQ / Help Centre, editable in the CMS.
- A contact form that creates support tickets, with a simple ticket thread.

### 3.15 CMS, Branding & Settings
- **Settings** sections: General (site name, logo, favicon, tagline, timezone, date format), Branding (primary/secondary colours injected as CSS variables, plus a light/dark theme toggle for users), Payments (Paystack), Email (SMTP), Security (2FA enforcement, password policy, session timeout), Exam defaults, Certificates (templates, signatories), Legal (Terms, Privacy, Refund Policy pages), SEO (meta defaults, OG image), and Maintenance mode (admins can still log in).
- Homepage sections are editable: hero, featured certifications, featured exams, testimonials, stats counters, partner logos, and a call to action.
- Static pages CMS (About, Contact, FAQ, Terms, Privacy).

### 3.16 Data Management
- Exports: results per exam (xlsx/CSV), users, orders, item analysis.
- A **database backup** script (`npm run backup`) that writes a timestamped SQL dump to `storage/backups` through Knex. It does not use `mysqldump` (which may be unavailable). Also provide an admin download link.
- Soft deletes on users, exams and questions. A recycle bin with restore.

---

## 4. MARKING ENGINE SPECIFICATION (implement exactly; unit-test every rule)

Create `src/services/grading/` with one strategy per question type and a single entry point, `gradeAttempt(attemptId)`.

| Type | Full marks when | Partial credit (if enabled) | Negative marking |
|---|---|---|---|
| Single choice / True-False | The selected option = the correct option | n/a | Applies if wrong (not if unanswered) |
| Multiple response | The selected set = the correct set exactly | `max(0, (correctSelected − wrongSelected) / totalCorrect) × marks` | Applies only if the result is 0 and something was selected |
| Fill in blank | Every blank matches an accepted variant (respecting the case/trim settings) | Marks ÷ number of blanks, per blank | Per question if all wrong |
| Numeric | `abs(answer − correct) ≤ tolerance` | n/a | If wrong |
| Matching | All pairs correct | Correct pairs ÷ total pairs | No |
| Ordering | Exact order | Longest-correct-subsequence ÷ length | No |
| Short answer | Keyword score ≥ threshold | Keyword weight sum, capped at marks | No |
| Essay | Manual grade | Manual | No |

Rules:
- Unanswered = 0, never negative.
- The total score is never below 0.
- Round to 2 decimal places. Percentage = score ÷ max score.
- The pass decision uses the overall pass mark **and** every section's minimum (if set).
- The marker uses the **question version** stored on the attempt item.
- Every result stores a snapshot: per-item marks, domain totals, section totals and band, so reports never change when questions are edited later, except through an explicit re-grade.
- Performance target: grading a 200-question attempt in under 300 ms.

---

## 5. DATABASE SCHEMA (Knex migrations; utf8mb4; InnoDB; FKs and indexes)

Create migrations for at least these tables, with sensible columns, `created_at`/`updated_at`, and `deleted_at` where soft-delete applies:

`users, roles, permissions, role_permissions, user_roles, password_resets, email_verifications, user_accommodations, sessions` (created by the session store)
`organisations, organisation_users, cohorts, cohort_members, seat_ledger`
`categories, certifications, certification_domains, training_programmes, programme_bands`
`questions, question_versions, question_options, question_answers` (flexible JSON for complex types), `question_tags, tags, question_media, question_reports`
`imports, import_rows` (per-row status and error), `exams, exam_sections, exam_questions` (fixed), `exam_blueprint_rules, exam_bands, exam_access_rules, exam_attempt_overrides, exam_instruction_cache`
`attempts` (status: in_progress | submitted | expired | graded | pending_manual; `started_at`, `expires_at`, `submitted_at`, ip, ua, integrity_score), `attempt_items` (question_version_id, shuffled option order, response JSON, marks_awarded, is_correct, time_spent_sec, flagged), `attempt_events` (proctoring timeline), `attempt_snapshots` (webcam), `results` (JSON breakdown snapshot, percentile, band, pass)
`certificates` (unique public code), `products` (type: exam | pack | bundle | attempts | seats | plan), `product_items, past_question_packs, pack_questions, entitlements` (user/org, product, starts_at, expires_at, source_order_id), `coupons, coupon_redemptions, orders, order_items, payments` (unique reference, raw payload JSON), `subscriptions`
`live_sessions, live_players, live_answers`
`item_statistics, exam_statistics`
`notifications, email_templates, announcements, support_tickets, ticket_messages`
`settings` (key/value, with encrypted flag), `pages, homepage_blocks, reviews, audit_logs, jobs` (DB queue: type, payload, status, attempts, run_at, last_error)

Add composite indexes for the hot queries: attempts by (user_id, exam_id), attempt_items by (attempt_id), questions by (category_id, status, difficulty), entitlements by (user_id, product_id, expires_at), payments by (reference) UNIQUE.

---

## 6. PROJECT STRUCTURE

```
/server.js                 # boots app + Socket.IO + cron + job poller
/knexfile.js
/.env.example
/package.json
/src
  /config                  # env loader (validate with zod), db, logger, session
  /middleware              # auth, rbac(permission), csrf, rateLimit, maintenance, installGuard, errorHandler
  /routes                  # public, auth, candidate, admin/*, api/*, webhooks, live, install, cron
  /controllers
  /services
    /grading               # strategies + gradeAttempt
    /instructions          # generateInstructions()
    /import                # parsers: xlsx, csv, json, aiken, gift, docx, zip
    /payments              # paystack client, webhook handler, fulfilment
    /analytics             # item analysis, reliability, percentiles
    /pdf                   # result slip, certificate, invoice
    /mail                  # nodemailer + template renderer
    /live                  # socket handlers
    /jobs                  # queue, worker, scheduled tasks
  /validators              # zod schemas
  /models or /repositories # Knex query modules
  /utils                   # crypto (AES-GCM), money, time, slug, hashing
/views
  /layouts  /partials  /public  /auth  /candidate  /exam  /admin  /org  /live  /emails  /errors
/public
  /css/app.css (compiled, committed)  /js  /img  /vendor
/tailwind                  # source css + config (dev only)
/migrations  /seeds
/storage  (uploads, logs, pdf, imports, backups)  — gitignored except .gitkeep
/scripts                   # cron.js, backup.js, create-admin.js, recompute-stats.js
/tests                     # unit + integration
/docs                      # DEPLOY_HPANEL.md, ADMIN_GUIDE.md, IMPORT_FORMATS.md, API.md
```

---

## 7. UI / UX STANDARDS
- A clean, modern, professional design that looks like a credible certification body, not a template. Use a consistent design system: spacing scale, an 8px grid, one sans-serif font family (Inter or similar, self-hosted), and the primary colour from Settings.
- **Mobile-first and fully responsive** at 360 / 768 / 1024 / 1440 px. The admin sidebar collapses into a drawer on mobile, and data tables become cards on small screens.
- Light and dark mode.
- Every list has search, filters, pagination, an empty state with a call to action, and skeleton loaders.
- Toast notifications for actions. Confirmation modals for destructive actions.
- Forms: inline validation messages, preserved input on error, disabled submit while processing.
- Friendly branded 404 / 403 / 500 / maintenance pages.
- Performance: Lighthouse ≥ 90 on the public pages; gzip/brotli compression (`compression` middleware); cache headers for static assets.

---

## 8. SECURITY CHECKLIST (all required)
- Helmet with a strict CSP. Allow only the self-hosted assets plus `js.paystack.co` and `api.paystack.co`.
- CSRF protection on every state-changing form and AJAX call (webhooks are excluded).
- Parameterised queries only, through Knex.
- Sanitise all rich-text HTML on save (allow-list) and escape everything else in EJS (`<%= %>`).
- bcryptjs with cost 12. A password policy that admins can configure.
- Session fixation protection (regenerate on login), idle timeout, and an httpOnly / secure / sameSite=lax cookie.
- RBAC on **every** admin route **and** a resource ownership check on every candidate route (no IDOR: a user cannot read another user's attempt, result or order).
- Rate limiting: auth, answer-save, import upload, webhook.
- Upload hardening: MIME + extension allow-list, size limits, random filenames, stored outside `public/` and served through an authorised route.
- Secrets live only in `.env` or encrypted settings. Ship a `.env.example` with every variable documented.
- An audit log for admin actions, plus login history per user.

---

## 9. SEED DATA (for a realistic demo; run with `npm run seed`)
- The Super Admin from `.env` (or created through the installer).
- Categories: Database (Oracle, PostgreSQL), Cloud (AWS), Project Management (PMP), Quality (Lean Six Sigma), Programming (Python), Data (SQL / dbt).
- 3 certifications with domains and weightings, e.g. **Oracle 1Z0-082**, **AWS Cloud Practitioner**, **Lean Six Sigma Green Belt**.
- **At least 60 original, technically accurate sample questions** across all auto-marked types, with explanations. Write them yourself; do not copy any real exam content.
- Exams:
  - One **Pre-Training Diagnostic** with bands
  - One **Mock Certification Exam** (blueprint-driven, negative marking on, 3 attempts, 24-hour cooldown)
  - One free **Practice Test**
  - One **Live Quiz**
- One paid **Past Questions Pack** (₦5,000) with 5 preview questions, and one coupon, `WELCOME10`.
- One demo organisation with a cohort and 5 candidates who have completed attempts, so the analytics pages show real data.

---

## 10. BUILD PHASES (do them in order; finish each one fully before starting the next)

At the end of **each phase**, run the app, run the tests, fix every failure, and print a short summary: what was built, the files created, and how to test it.

1. **Foundation**: project scaffold, config/env validation, Knex + all migrations, logger, error handling, sessions, security middleware, layouts, Tailwind build, installer, auth (register/verify/login/2FA/reset), RBAC, base admin shell and candidate shell.
2. **Catalogue & Question Bank**: categories, certifications, domains, the full question CRUD for all types with preview, versioning, review workflow, media upload.
3. **Import / Export**: all formats, the wizard, dry-run, the background job, the error report, undo, templates.
4. **Exam Builder + Instruction Generator**: every setting in §3.5, blueprints, sections, bands, the pre-publish checklist, live instruction preview.
5. **Exam Engine + Grading + Results**: candidate flow, the timer, autosave/offline queue, resume, proctoring events, auto-submit sweeper, the grading engine (§4), the results page, PDF slip, certificates and verification.
6. **Commerce**: products, packs, bundles, coupons, cart, Paystack (settings, init, verify, webhook, idempotency), entitlements, the library, orders admin, invoices, optional subscriptions.
7. **Organisations & Cohorts**: seats, bulk invite, assignments, deadlines, cohort reports, learning gain.
8. **Live Quiz**: Socket.IO sessions, host and player screens, leaderboard, reports, homework mode.
9. **Analytics, Notifications, CMS, Support**: item analysis and reliability jobs, dashboards, email templates, in-app notifications, announcements, question reports and re-grade, tickets, homepage CMS, settings pages.
10. **Hardening & Delivery**: the full test suite, an accessibility pass, a performance pass, the security checklist review, seed data, and the documentation in §11.

---

## 11. REQUIRED DOCUMENTATION (in `/docs`)
- **DEPLOY_HPANEL.md**: a step-by-step guide to deploying on Hostinger hPanel. Cover: creating the MySQL database and user; creating the Node.js app (Node version, application root, entry file `server.js`); uploading via Git or ZIP (exclude `node_modules`); setting the environment variables; running `npm install --omit=dev`; running migrations (`npx knex migrate:latest`) and seeds; first-run `/install`; pointing the domain and enabling SSL; setting the Paystack webhook URL in the Paystack dashboard; configuring the **hPanel Cron Job** to call `/cron/run?token=CRON_TOKEN` every 5 minutes; checking that `storage/` is writable; restarting the app; and a troubleshooting section (port, 502/503, DB connection, file permissions, WebSocket fallback).
- **ADMIN_GUIDE.md**: how to create categories, questions and exams, import questions, set attempts, configure Paystack, manage organisations and run live quizzes.
- **IMPORT_FORMATS.md**: an exact specification with examples for every import format.
- **API.md**: the internal JSON endpoints used by the exam engine and the live quiz.
- **README.md**: overview, features list, local setup (`cp .env.example .env`, `npm install`, `npm run migrate`, `npm run seed`, `npm run dev`), scripts, and tests.

---

## 12. DEFINITION OF DONE (verify every item before you declare completion)
- [ ] `npm install && npm run migrate && npm run seed && npm start` works on a clean machine with Node 20 and MySQL 8.
- [ ] No native-compiled dependencies (`npm ls` checked). The app runs as a single process.
- [ ] Admin can import a 500-row xlsx file, see the dry-run errors, publish the questions, and attach them to an exam in one flow, and candidates can take that exam immediately.
- [ ] The attempt limit, cooldown and per-user override are enforced server-side (tested).
- [ ] Instructions are generated automatically and update when the exam settings change (tested).
- [ ] A candidate takes a timed exam on a phone, loses connection, reconnects, resumes, submits, and sees the instant result with the domain radar, percentile and review.
- [ ] Correct answers never appear in any network response before submission (verified by a test).
- [ ] Paystack test-mode purchase → webhook → entitlement works. A duplicate webhook doesn't double-grant. A tampered signature is rejected (tested).
- [ ] Live quiz works with 30+ simultaneous players in the browser, with the leaderboard updating.
- [ ] Item analysis and KR-20 compute correctly on the seed data.
- [ ] All pages are responsive at 360px. Keyboard navigation works in the exam player.
- [ ] Every admin route has a permission check. Every candidate resource has an ownership check (tested).
- [ ] Unit tests cover the grading engine, the instruction generator, the import parsers, Paystack verification and attempt rules. All tests pass.
- [ ] No TODOs, stubs, `console.log` debugging or dead links remain.
- [ ] Every document in §11 is written and accurate.

**Begin with Phase 1 now.** Ask questions only if something in this document truly contradicts itself. For anything unspecified, choose the option a world-class assessment platform would choose, write the decision down in `docs/DECISIONS.md`, and keep going.
