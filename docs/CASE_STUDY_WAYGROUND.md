# Case study: Wayground (formerly Quizizz) — and what EXAMPLY takes from it

*Researched 25 November 2026 from Wayground's live website: the home page, `/home/pricing`, `/home/about` and
`/forbusiness`. Statements marked **[site]** are quoted or paraphrased from those pages; **[analysis]** is our own
reading. Wayground's prices are not public ("Request a quote"), so none are given here.*

## 1. Who they are

- **[site]** "Quizizz is now Wayground." The company is Quizizz Inc. (DBA Wayground). Its about page says: "Our name
  may have changed, but our commitment remains the same", under the mission "Helping every student find their way."
- **[site]** Scale claims: teachers in **90% of U.S. schools**, used by **1 in 3 U.S. students**, in **150+ countries**,
  and **7 billion student responses** in the US last year. More than 3,000 schools and districts are named customers.
- **[site]** The pitch: *"Activate every lesson. Know every learner."* The platform turns "your curriculum, and anything
  else you teach" into activities students "want to finish", then shows teachers, schools and districts "what each
  student needs next".
- **[analysis]** The rebrand moves the company from "a fun quiz game" to curriculum and assessment infrastructure for
  K-12 districts. The about page frames it as "an AI-supported hub" for instruction, practice and assessment, and the
  wording leans on evidence and trust ("No flashy promises — just consistent, real results").

## 2. Product

| Area | What Wayground offers **[site]** |
|---|---|
| **One activity, many modes** | "Run it live, let students work at their own pace, assign it as homework, use it as a fun game or a locked-down test, or print it and scan it to auto-grade. Every result lands in one report." |
| **Content from anything** | "Turn any PDF, worksheet, video, slide deck, or standard into an interactive activity on any device in minutes." AI creates and adapts content "without any new logins". |
| **Question types** | "20+ question types, including ones that mirror your state test": drag and drop, hot spots, graphing, in "a test-style interface". |
| **AI** | Generate and import content; adapt resources (reading levels, engagement); AI answer explanations for students; AI grading with custom and state rubrics; small-group and resource recommendations; "admin chat with data". Separate generators for questions, rubrics, lesson plans, worksheets, presentations and math problems. |
| **Accessibility** | "20+ accommodations, including read-aloud and translation", so every student works on the same grade-level activity "without being singled out". Accommodations can be set up centrally across a school. |
| **Paper mode** | Print a differentiated worksheet and grade it by scanning with the Teacher app ("device-free classrooms"). |
| **Gamification** | "Game-based formats draw students in." Gamification is in every plan. The business product uses "intelligent gamification and cognitive insights". |
| **Integrity** | Anti-cheating *alerts* in the free plan; anti-cheating *prevention* in paid plans. |
| **Live data** | "Classroom Pulse" for live instruction data. |
| **Reports** | Standards-aligned reports, longitudinal growth graphs, student profiles, a district dashboard, and reports shared with colleagues and parents. |
| **Item bank** | "Wayground Official Libraries": items mapped to curriculum and state standards (math, science, ELA, grades 3–12), plus "40M+ standards-aligned resources". |
| **Integrations** | Google Classroom roster sync and grade passback; Canvas and Schoology (LTI 1.3); Clever and ClassLink; SSO with Google, Microsoft, Clever and ClassLink. The business product adds Moodle, Microsoft Teams, Slack, Brightspace, Adobe and a REST API. |
| **Evidence** | ESSA Level 3. Third-party studies of about 13,000 schools found the highest-use Texas schools scored about 16 points higher in reading and 22 in math. Classrooms "running 30+ formative questions a week" showed a significant link to higher scores. |

### Plans **[site]**

- **Basic**: "Free for every teacher, forever." Includes assessments, presentations, flashcards and videos; limited
  question types; live and self-paced delivery; AI (generate, import, adapt, explain); accommodations; up to **100
  students** and **20 stored activities**.
- **School and District** (quote; billed by purchase order, check, card or ACH): everything in Basic, plus all
  question types, unlimited storage and students, AI grading, longitudinal reports, the admin dashboard, LMS
  integrations, central accommodations, anti-cheating prevention and a dedicated success manager. The item bank,
  benchmark assessments and in-person training are add-ons.
- **Corporate plans** (Wayground for Business): courses that link lessons and quizzes, assignment to teams and
  departments, and reports on trainers, learners and content.

### Design and tone

- **[site]** The palette is a deep plum/aubergine (`#3B142A`) with soft pastels (peach `#FFC48A`, butter `#ECEB75`,
  lavender `#C6B4E5`, mint `#A3E5E0`) on a warm cream (`#F3EFDA`).
- **[analysis]** Adult, calm and premium: a big change from Quizizz's bright purple, aimed at district buyers rather
  than only at children. The copy is plain and outcome-led ("nobody spends a Friday afternoon reconciling
  spreadsheets"). Every section has two calls to action: *Book a demo* (administrators) and *Sign up free* (teachers).

## 3. Strengths and gaps

**[analysis] Strengths.** Huge free adoption by teachers that leads to district sales. "One activity, many modes"
keeps practice and testing in one place, with one report. Accessibility is built in rather than bolted on, and the
evidence (ESSA) unlocks public funding.

**[analysis] Gaps that matter for EXAMPLY's market** (professional certification, IT teams, Nigeria and West Africa):

1. **K-12 first.** Libraries, standards and reports are built around US grades and state tests. Nothing on the site
   covers professional certifications (Oracle, AWS, CompTIA), blueprints with weighted domains, scaled scores or
   pass/fail bands.
2. **No paid exams or certificates.** There is no candidate checkout, verifiable certificate or public `/verify`.
   Businesses buy seats; individuals don't buy exams.
3. **No hands-on labs.** There is no live terminal or SQL sandbox; "tech-enhanced items" means drag-and-drop, hot
   spots and graphing.
4. **Payments and local fit.** Billing is by US-style purchase order, check, card or ACH: no Paystack, Naira pricing
   or bank-transfer receipts.
5. **Integrity** in the free tier is alerts only; prevention is a paid feature.

## 4. What EXAMPLY adopted (this release)

| Wayground idea | EXAMPLY version |
|---|---|
| "Turn any PDF, slide deck … into an activity" | **AI from your documents**: upload up to 5 PDFs, Word or PowerPoint files, text or Markdown. Text is extracted on the server; questions are written only from those documents, and each one cites its source page or slide. |
| Engagement that keeps people finishing | **Calm generated music** in the exam player (off until the candidate chooses it; authors can disable it per exam), **milestone encouragement** at 25 / 50 / 75 / 100%, and a short **celebration on passing**. |
| Mature, trustworthy visual identity | **EXAMPLY rebrand**: deep navy (`#1f3a5f`) with antique gold (`#a8822e`), a new logo mark, a letter-spaced wordmark and a self-writing headline. |
| One report for every mode | Already in place: mock, diagnostic and practice exams, weak-area practice and cohorts all feed the same results, breakdowns and learning-gain reports. |

## 5. Recommended next steps (in priority order)

1. **Live mode (Phase 8)**: PIN join, live leaderboard and homework mode, the core of Quizizz's original growth.
   Gamify it for training sessions, but keep certification mocks serious.
2. **Accommodations**: read-aloud (the browser's speech synthesis, no cost), extra-time profiles (already per
   candidate), dyslexia-friendly font, and translation of the instructions.
3. **A generous free tier for trainers**, like Wayground Basic: e.g. 1 workspace, 50 candidates, 100 AI questions per
   month. It brings in training providers who later buy company plans.
4. **AI grading of short answers and essays** with a rubric, plus AI explanations of wrong answers on the review page.
5. **Integrations**: Google Classroom and Moodle (popular with Nigerian universities and training institutes), then
   LTI 1.3 and a REST API with webhooks for HR systems.
6. **A certification item bank by blueprint**: our equivalent of "Official Libraries" (CompTIA, AWS, Oracle, PMP,
   ITIL), sold as packs.
7. **Evidence**: publish pass-rate improvements from mocks (e.g. "candidates scoring 75%+ on EXAMPLY mocks passed
   first time X% of the time") once there is enough data.

## Sources fetched

- https://wayground.com/ — home ("Quizizz is now Wayground", product overview, evidence)
- https://wayground.com/home/pricing — plans and the feature comparison
- https://wayground.com/home/about — mission and rebrand note
- https://wayground.com/forbusiness — corporate training product
