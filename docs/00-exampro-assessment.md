# Assessment of `Dev-Bulama/EXAMPRO` (input to Skillscore Assess)

Assessed: 2026-11-24. Sources: `main` (commit 4421c32) and the unmerged PR branch
`codex/create-online-exam-management-system-gtoe4p` (commit fa1464c, PR #2).

## 1. What actually exists

| Branch | Contents | Runnable? |
|---|---|---|
| `main` | README, a 67-line roadmap (`docs/implementation-plan.md`), a Laravel scaffold shell script, and an `index.html` that says "sample" | No. Planning only. |
| PR #2 (unmerged) | About 2,600 lines of framework-less PHP 8.2: a JSON API (`routes/api.php`), 10 controllers, 17 repositories, 3 services, one SQL schema (19 tables), a seeder, and a Tailwind CDN landing page | Partly. There is no UI beyond the landing page and no tests. |

The README on PR #2 calls itself "production-ready". It is not (see §3).

## 2. The import feature: does not exist

Nothing in either branch parses or uploads questions: no CSV, XLSX, DOCX, Aiken, GIFT, JSON or ZIP
handling, no upload endpoint for questions, and no templates. The only mention is one line in the README:
*"Integrate queue workers for heavy background jobs (e.g., video processing or bulk imports)."*

The only way to add questions is `POST /api/admin/sections/{section_id}/questions`, one question per
request. That endpoint has **no validation**. A missing `type` or `prompt` raises a PHP error. It does
not check that a correct option exists, and it does not wrap the question and its options in a
transaction, so a failure can leave a question with no options.

**Conclusion:** the import pipeline in §3.4 of the new brief must be built from scratch. There is nothing to port.

### Why the old data model can't support import

- `questions.section_id NOT NULL`: every question belongs to exactly one exam section. There is **no
  reusable question bank**. An import could not target a category or certification, and it could not
  "attach to exam" or "create a new exam from these questions".
- A question has no category, certification, domain, difficulty, Bloom's level, explanation, reference,
  status, version, author or content hash. Duplicate detection, a review workflow and dry-run reporting
  all have nowhere to store their data.
- Rows carry no `import_id`, so an "Undo this import" is impossible.
- There is no jobs table and no worker, so a 5,000-row import would run inside one HTTP request.

## 3. Assessment of the other features

### 3.1 Marking engine (`app/Services/ExamService.php`)
| Finding | Severity |
|---|---|
| Marking is all-or-nothing. There is no partial credit and no negative marking. | Functional gap |
| MCQ and ordering share `compareOptions`, which **sorts** both arrays. Ordering questions are therefore marked correct for *any* order of the correct items. | **Bug** |
| Fill-in-the-blank sorts the blanks too: answers given in swapped blanks count as correct. There is one accepted answer per blank, no variants, and no case-sensitivity option. | **Bug** / gap |
| Short answer is an exact string match only. There is no keyword marking and no essay or manual grading queue. | Gap |
| `comprehension` and `media` are modelled as question *types*. They are really containers (a passage or a media stem). They cannot hold child questions. | Design flaw |
| Answers are marked as each one arrives (`submitAnswer`), not at submission. If a question is edited mid-exam, the score is inconsistent. Question versioning does not exist. | Design flaw |
| There are no True/False, Numeric, Multiple-response "select N" or Hotspot types. | Gap |

### 3.2 Exam delivery & integrity
| Finding | Severity |
|---|---|
| `GET /api/exams/{id}` is **public, with no auth**, and returns `SELECT *` from `answer_options`, **including `is_correct`**. Anyone can download every answer key. | **Critical** |
| `POST /api/attempts/{id}/submit` never checks that the attempt belongs to the caller, is still `in_progress`, or is within time. Any logged-in user can write answers into anyone's attempt, or after the deadline. | **Critical** |
| `POST /api/attempts/{attempt_id}/complete` reads `$params['exam_id']`, which is not in the route. It resolves to `0`, so the scoreboard insert breaks its foreign key. The attempt is marked complete, but the scoreboard and rewards fail. | **Bug** |
| Timing: `timer_remaining` is written once and never enforced. There is no `expires_at`, no server-side auto-submit, and no sweeper. | **Critical** for a certification platform |
| `startExam` ignores `price`, `starts_at`/`ends_at`, attempt limits and prerequisites. Paid exams are free to take. | **Critical** |
| No shuffling, no per-attempt option IDs, no proctoring events. | Gap |

### 3.3 Payments (`PaymentController`)
- `user_id` is taken from the **request body**, so a user can create transactions in someone else's name.
- It never calls Paystack: no initialise, no verify, no webhook signature check. "Paystack-ready" means a random reference is stored.
- Money is stored as `DECIMAL(10,2)` and cast through PHP `float`. The new brief requires integer kobo.
- Transactions only reference `pricing_plans`. You cannot buy an exam, a past-question pack or extra attempts.

### 3.4 Auth, RBAC, audit
- Roles are an `ENUM('admin','user')`. There are no permissions, no custom roles and no audit log.
- Session tokens are stored **in plaintext** in `sessions.token`. A DB leak means session hijack. The new build should store a hash.
- No email verification, password reset, 2FA, rate limiting or lockout.
- Single-session enforcement (log in → delete the user's other sessions) is a sound idea worth keeping. In the new build it should apply per **exam attempt**, not per account.
- Seeder admin: `admin@example.com` / `Admin@123`, a hard-coded credential. The new brief uses an `/install` wizard instead.

### 3.5 Engineering
- No tests, no CI, no input validation layer, no CSRF (fine for a header-token API, but the new app is server-rendered, so CSRF is needed).
- One monolithic SQL file, and no migration runner (the schema uses `CREATE TABLE IF NOT EXISTS`).
- Hosting: it targets PHP + MySQL. The new brief is a single Node.js process on Hostinger hPanel. **No code is portable.** Only the domain ideas carry over.

## 4. What is worth carrying forward (ideas, not code)

1. **`UNIQUE (attempt_id, question_id)` on responses** with upsert. This is the right shape for autosave.
2. **Exam → sections → questions** structure. Keep it, but the new build links sections to bank questions through a join table (`exam_section_questions`) or a blueprint.
3. **`match_key` on options** for matching questions. Generalise it to a typed `answer_key` JSON per question type.
4. **Rewards ledger and leaderboard tables.** These are useful later for live quizzes.
5. **`quiz_schedules` / `quiz_participants`.** A starting point for live sessions (PIN, host, state).
6. **Bank transfer + admin approval** as a second payment method next to Paystack. This is not in the new brief, but it is common in Nigeria. Worth deciding on.

## 5. Proposed import architecture for Skillscore Assess

```
upload ──► detect format ──► parser (xlsx | csv | json | aiken | gift | docx | zip)
                                   │  each emits the SAME shape:
                                   ▼
                     NormalizedQuestion { rowRef, type, stem, options[], answerKey,
                       explanation, reference, category, certification, domain,
                       topic, tags[], difficulty, bloom, marks, timeSec, images[] }
                                   │
                    validate (zod, one schema per type)  ──► ✅ / ⚠️ / ❌ + exact message
                                   │
                    sanitise HTML, resolve images, compute content hash, dedupe
                                   │
                 dry-run preview stored in import_rows (status, errors JSON, decision)
                                   │  admin confirms (Skip / Overwrite / Import-as-new)
                                   ▼
                 jobs table ──► in-process poller ──► batches of 200 in a transaction
                                   │                    (every row gets import_id)
                                   ▼
             summary + error-report.xlsx  ·  "Undo" = delete/restore by import_id (24 h)
```

Key decisions:
- **One normaliser, many parsers.** Each format parser is a pure function `(buffer, opts) → NormalizedQuestion[]` with fixture-based Jest tests. Validation, dedup and persistence are shared, so all formats behave the same.
- **Parse and validate inside the job too.** The upload request only stores the file and creates an `imports` row. Parsing a 5,000-row xlsx runs on the poller, and the preview page polls for progress.
- **Content hash** = sha256 of the normalised stem text + sorted option texts + type. It is stored on `questions` with an index.
- **Overwrite** on a published question creates a new version (in line with §3.3). Undo for an overwrite restores the previous version pointer instead of deleting.
- **Templates** are generated by code with exceljs (one sheet per type + an instructions sheet), so they never drift from the validator.

## 6. Verdict

EXAMPRO is a planning document plus an early, unmerged API prototype. It has critical security flaws
(public answer keys, unowned attempts, unenforced timers and payments) and **no import feature**.
Treat it as a source of domain vocabulary only. Build Skillscore Assess fresh on the Node/Express/Knex
stack in the brief.
