# EXAMPLY admin guide

This guide covers running the platform day to day. Every screen is in the admin area (`/admin`), and the menu only shows what your role allows. Roles and permissions are under **People → Roles & permissions**.

## 1. First steps after install

1. **Security:** sign in, then set up two-factor authentication (required for Super Admins and Admins). Keep the recovery codes.
2. **Settings → General / Branding:** site name, contact email, logo and colours. The default colours are navy `#1f3a5f` and gold `#a8822e`.
3. **Settings → Email (SMTP):** enter your mailbox details and click **Send test email**. Until this works, verification and reset emails wait in **Background jobs**.
4. **Settings → Payments:** your Paystack public and secret keys (Test, then Live), and your bank account for transfers. Copy the webhook URL shown there into Paystack → Settings → API Keys & Webhooks.
5. **Settings → AI:** add a Claude (Anthropic) or OpenAI key, choose the default provider and click **Test**.
6. **Email templates:** adjust the wording of every email. Variables such as `{{name}}` are filled in automatically, and you can reset any template to its default.

## 2. Catalogue

- **Categories:** a tree (for example Database → Oracle). Exams and questions belong to a category.
- **Certifications:** an official exam such as Oracle 1Z0-082, with its weighted **domains**, passing score, duration and question count. Blueprints and AI generation use the domain weights.
- **Training programmes:** recommended courses for each result band (Beginner, Intermediate, Advanced, Expert), shown to candidates after a diagnostic.

## 3. Questions

- **Question bank → New question.** There are 13 types:
  - single choice, multiple response, true/false
  - fill in the blank, numeric, matching, ordering, image hotspot
  - short answer, essay, case study (a scenario with child questions)
  - **SQL lab:** the candidate writes SQL against your sample database and is marked by comparing results.
  - **Cyber security lab:** a live Linux terminal; tasks are checked automatically on the final machine.
- **Workflow:** draft → in review → published → retired. Every save creates a version. Attempts always use the version they were given, so editing a question never changes past results.
- **Previews:** the candidate preview shows exactly what candidates see. The SQL and lab editors include a test bench (run the solution, try commands, watch the task ticks).
- **Duplicates and reports:** the bank flags near-duplicates. Candidates can report a question from the review screen. Fix it under **Reported questions**, and re-grade affected attempts if needed.

## 4. Importing questions

**Import questions** accepts Excel, CSV, JSON, Aiken, GIFT, Word and ZIP with images. Download a template first; `docs/IMPORT_FORMATS.md` has the exact format. Every import runs as a dry run first: you see each row, its errors and its duplicates, then confirm. You can undo an import within 24 hours.

## 5. AI generation

- **AI generator:** describe what to test, choose the category, certification, domains, question types, difficulty and count. Questions arrive in the same preview as an import, so nothing is saved until you confirm.
- **Use your documents:** upload up to 5 PDF, Word, PowerPoint, text or Markdown files (20 MB each). Questions are written only from those documents, and each cites its page or slide. Scanned PDFs without selectable text can't be read: paste the text instead.
- **Generate a complete exam** (Exams → Generate with AI): questions across the certification's domains, plus the exam's description, timing and pass mark.

## 6. Exams

1. **Exams → New exam:** choose the type (mock certification, pre/post-training diagnostic, practice, past-questions pack, live quiz) and category.
2. **Builder tabs:** content (a fixed list, sections or **blueprint rules** that draw random questions per domain), timing, scoring (pass mark, negative marking, partial credit, scaled scores), bands, delivery (shuffling, navigation, calculator, notepad, calm background music), integrity, access, certificate and release of results. The instructions candidates see are generated from these settings.
3. **Publish:** the pre-publish checklist blocks problems, such as not enough questions for a rule or a missing pass mark. Publishing creates a version, and later edits only apply after you publish again.
4. **Attempts:** you set the number allowed, the cooldown and the availability window. Grant extra attempts to individuals from **Attempts & results**.
5. **Grading queue:** essays and anything needing a person. Release withheld results here.

## 7. Selling exams

- **Products & plans:** every paid exam becomes a product automatically. Bundles, extra attempts and company plans are created here.
- **Coupons:** percentage or fixed amount, with limits and dates.
- **Orders:** Paystack payments confirm automatically. Bank transfers show the uploaded receipt: approve it or send it back with a note. Refunds remove access. **Grant** gives access for free, with a reason.

## 8. Companies (workspaces)

A company that buys a plan gets a private workspace. Its managers invite staff and candidates (by email, in bulk or with a join code), build their own questions and exams (including AI from their documents, and labs if the plan includes them), organise people into cohorts, assign exams with due dates, and see progress and learning gain. Platform admins manage all organisations under **Organisations**.

## 9. Live quiz

1. **Live quiz → New session:** pick an exam with a fixed question list. The usable types are single and multiple choice, true/false, numeric and fill in the blank. Then choose how people play:
   - **Live:** you run it from the host screen on a projector.
   - **Self-paced:** players move at their own speed.
   - **Homework:** self-paced with a deadline; no host screen is needed.
2. Allow guests (nickname only) or require sign-in, set the seconds per question, and optionally shuffle.
3. **Host screen:** shows the PIN, a QR code and the join link (`/play`). Players appear in the lobby; click **Start**.
   - **Auto-advance** (on by default; set the seconds when you create the session): each question reveals when time is up or everyone has answered, then the leaderboard shows, then the next question opens, with no clicking. **Auto: on/off** pauses it at any time, and **Next** still works by hand.
   - **◀ Previous** returns to the previous question's results; moving forward re-opens the next question (answers already given still count once). You can also pause the timer, remove a player or end the game.
   - **Game sounds** (original, generated in the browser): lobby music, join pops, question start, last-5-second ticks, correct and wrong cues, a reveal sting, the leaderboard roll and a podium fanfare. The 🔊 button mutes them on that device.
   - **Self-paced and homework:** players see "Correct +950" for a moment and the next question appears by itself; **◀ Previous** lets them look back at questions they've already answered (read-only, with the explanation if you chose to show answers).
4. **Report:** per player and per question, with CSV export.

## 10. Analytics

**Analytics** shows sign-ups, attempts, pass rate and every exam's reliability. Open an exam for item analysis:

- **p:** the share of candidates answering correctly. Aim for 0.30–0.85.
- **r:** point-biserial discrimination. 0.20 or higher is good; a negative value usually means a wrong answer key.
- **D:** the difference between the top and bottom 27% of candidates.
- **Distractors:** how often each option was chosen.

The checks column lists automatic flags. Reliability (Cronbach's alpha, or KR-20 when every item is right/wrong) needs at least 10 finished attempts; aim for 0.70 or higher. Statistics recompute nightly, or click **Recompute now**.

## 11. Engagement

- **Announcements:** banners shown to everyone, to visitors only, or to chosen roles or organisations, with optional start and end dates.
- **Pages & FAQ:** your own pages at `/p/<address>` (About, Terms and Privacy are included; have the legal pages reviewed) and the help centre at `/help`.
- **Support tickets:** messages from `/support`. Reply from the ticket, and the requester gets an email (and an in-app notification if they have an account). Set the status, priority and assignee.
- **Notifications:** candidates get a bell for results, certificates, assignments and support replies.

## 12. System

- **Users:** create, suspend, verify and reset 2FA. Set accessibility accommodations such as extra time and large text per user.
- **Audit log:** every sensitive action, with before and after values.
- **Background jobs:** emails, imports, AI and analytics. Failed jobs show the error and can be retried.
- **Cron:** keep the hPanel cron job calling `/cron/run?token=…` every 5 minutes (see `DEPLOY_HPANEL.md`).
