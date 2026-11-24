# Import formats

Every format goes through the same pipeline:

1. **Upload** the file.
2. **Background check**, which:
   - validates every row with the question-type rules;
   - looks up categories, certifications and domains;
   - flags duplicates in the file and in the bank.
3. **Dry-run preview** (✅ / ⚠️ / ❌ per row, with the exact problem).
4. **Confirm**: rows are imported in batches; you can leave the page.
5. **Summary** with a downloadable `.xlsx` of the failed rows and their reasons.
6. **Undo** is available for 24 hours.

Limits: 25 MB per file, 10,000 questions per file. Templates for every format are under **Admin → Import questions → Templates**; every template row imports without errors.

Duplicates are detected by a hash of the type, the question text and the option texts, ignoring formatting, letter case and option order. For each duplicate choose **Skip** (the default), **Overwrite** (the existing question gets a new version) or **Import as new**.

---

## Excel (.xlsx) and CSV

One row per question. Row 1 is the header row. Header names are matched loosely (`Option A`, `option_a` and `a` all work). An `Instructions` sheet is ignored; every other sheet is read. CSV may use `,`, `;` or tab as the delimiter, and UTF-8 with or without a BOM.

| Column | Required | Content |
|---|---|---|
| `type` | yes | `single_choice` (`mcq`), `multiple_response` (`multi`), `true_false` (`tf`), `fill_blank` (`blank`), `numeric`, `matching`, `ordering`, `hotspot`, `short_answer` (`short`), `essay`, `case_study`, `sql` |
| `question` | yes | The question text: plain text, or simple HTML. Fill-in blanks are written `[[1]]`, `[[2]]` (or `___`, numbered in order) |
| `option_a` … `option_l` | type-dependent | Choices A–L. **Matching:** `left => right`, and a line without `=>` is a distractor. **Ordering:** items in the *correct* order. **Hotspot:** `Label @ x,y,w,h` (percentages of the image) |
| `answer` | type-dependent | See the table below |
| `explanation` | recommended | Shown in review |
| `reference` |  | Book, standard or URL |
| `marks` |  | Default 1 (essay: 10) |
| `difficulty` |  | `1`–`5`, or `very easy` / `easy` / `medium` / `hard` / `very hard` |
| `bloom` |  | `remember`, `understand`, `apply`, `analyze`, `evaluate`, `create` |
| `category` |  | Name, slug or path such as `Database > Oracle`. Falls back to the import's default category |
| `certification` |  | Exam code (e.g. `1Z0-082`) or certification name |
| `domain` |  | Domain code (e.g. `D2`) or name within that certification |
| `topic`, `tags` |  | Tags are comma-separated |
| `time_seconds` |  | Estimated time to answer (default 60) |
| `units` |  | Numeric questions: units shown to candidates |
| `select_exact` |  | Multiple response: candidates must select exactly N |
| `case_sensitive` |  | `TRUE` for case-sensitive fill-in / short-answer marking |
| `threshold` |  | Short answer: keyword score needed for full marks (default: the total weight) |
| `min_words`, `max_words` |  | Essay word limits |
| `image` |  | ZIP imports: a file name in `images/` (the hotspot image, or an image shown above the question) |
| `sql_mode`, `schema_sql`, `seed_sql`, `starter_sql`, `check_sql`, `order_matters`, `column_names_matter`, `tolerance` |  | SQL lab questions (type `sql`): the dataset, the task mode (`query` or `modify`), the check query for modify tasks and the marking options. The `answer` column holds the model solution. Every SQL row is executed during the background check; a dataset or solution that fails is reported as an error |
| `case_id` |  | Case studies: give the `case_study` row an id (e.g. `CS1`) and put the same id on each child question |

### The `answer` column

| Type | Example | Meaning |
|---|---|---|
| single_choice | `B` | Letter of the correct option (`2` also works) |
| multiple_response | `A,C` | All correct letters |
| true_false | `TRUE` / `FALSE` | Also `T`/`F`, `yes`/`no` |
| fill_blank | `1521 \| port 1521 \|\| listener.ora` | Blanks are separated by `\|\|`; alternatives within a blank by `\|` |
| numeric | `6` or `6 ± 0.1` | `+/-` also works |
| hotspot | `DB` or `B` | Label or letter of the correct region |
| short_answer | `atomicity\|atomic=1; durability=2` | Keyword groups separated by `;`; synonyms by `\|`; weight after `=` |
| essay | marking guide text | Shown to graders only |
| sql | `SELECT name FROM hosts WHERE open_ports > 1` | The model solution (SQLite dialect) |
| matching / ordering | (empty) | The answer comes from the options |

**Example error messages:**
- `Correct answer 'E' is not among options A–D.`
- `The question text has 3 blanks but 1 answer is defined.`
- `Category “X” does not exist — the import default was used.`
- `Already in the bank as question #42.`

---

## JSON

An array of questions, or `{ "questions": [ … ] }`. Each item is the platform's authoring model plus classification fields:

```json
{
  "questions": [
    {
      "type": "single_choice",
      "question": "Which clause filters groups after aggregation?",
      "options": [{ "text": "WHERE" }, { "text": "HAVING", "correct": true, "feedback": "Correct." }],
      "explanation": "HAVING runs after GROUP BY.",
      "category": "Database > Oracle", "certification": "1Z0-082", "domain": "SQL",
      "difficulty": 2, "bloom": "understand", "tags": ["sql"], "marks": 1
    },
    { "type": "fill_blank", "stem_html": "<p>Port [[1]]</p>", "blanks": [{ "variants": ["1521"] }] },
    { "type": "numeric", "question": "DPMO?", "value": 5000, "tolerance": 0, "units": "DPMO" },
    { "type": "matching", "question": "Match", "pairs": [{ "left": "Pareto", "right": "Vital few" }], "distractors": ["Budget"] },
    { "type": "ordering", "question": "Order DMAIC", "items": ["Define", "Measure", "Analyze", "Improve", "Control"] },
    { "type": "short_answer", "question": "ACID?", "keywords": [{ "terms": ["atomicity"], "weight": 1 }], "threshold": 1 },
    { "type": "essay", "question": "Discuss…", "rubric_html": "<p>…</p>", "min_words": 100, "max_words": 400 },
    { "type": "case_study", "question": "Scenario…", "children": [ { "type": "true_false", "question": "…", "correct": true } ] }
  ]
}
```

`question`, `stem` and `text` are accepted as plain-text alternatives to `stem_html`, and `explanation` as an alternative to `explanation_html`. A JSON export from the bank re-imports unchanged.

---

## Aiken (.txt)

Single-choice questions only. Questions are separated by a blank line:

```
What is 2 + 2?
A. 3
B. 4
C. 5
ANSWER: B
```

Options may use `A.` or `A)`.

---

## GIFT (Moodle, .gift or .txt)

| GIFT | Imported as |
|---|---|
| `Q {=right ~wrong ~wrong}` | single choice (`#feedback` after an answer is kept) |
| `Q {~%50%a ~%50%b ~%-100%c}` | multiple response (positive weights are correct) |
| `Q {T}` / `{FALSE}` | true / false |
| `Q {#3.14:0.01}` or `{#4..6}` | numeric |
| `Q {=a -> 1 =b -> 2}` | matching |
| `The port is {=1521 =port 1521}.` | fill in the blank (the blank goes where the braces are) |
| `Q {}` | essay |

The parser also supports:
- `::title::` before a question;
- `// comments`;
- `$CATEGORY: Cloud/AWS` (becomes the category path `Cloud > AWS`);
- `#### general feedback` (becomes the explanation);
- escaped characters `\~ \= \# \{ \} \:`.

---

## Word (.docx)

Write questions one after another:

```
1. Which clause filters groups after aggregation?
A. WHERE
B. HAVING
C. ORDER BY
Answer: B
Explanation: HAVING is evaluated after GROUP BY.
Difficulty: easy
Category: Database > Oracle
```

- **Questions** start with `1.`, `1)`, `Q1.` or `Question 1:`. Options start with `A.` or `A)`.
- **`Answer:` decides the type:**
  - one letter → single choice;
  - several letters (`A, C`) → multiple response;
  - `True` / `False` → true/false;
  - a number → numeric.
  - Use `Type: essay` and similar to force a type.
- **Optional lines:** `Explanation:`, `Type:`, `Difficulty:`, `Category:`, `Certification:`, `Domain:`, `Topic:`, `Tags:`, `Marks:`, `Units:`, `Reference:`.
- **Images** inside a question are imported with it. Bold, italics, lists and tables in the question text are kept.

---

## ZIP bundle

A `.zip` containing one questions file (`.xlsx`, `.csv` or `.json`) and an `images/` folder:

```
questions.xlsx
images/network-diagram.png
images/er-diagram.jpg
```

Put the file name in the `image` column; matching is case-insensitive. Images must be PNG, JPG, WebP or GIF. Hotspot questions use the image as the clickable picture; other types show it above the question. A missing image fails only that row.

---

## AI generation

**Admin → AI generator** creates the same kind of batch. Generated questions arrive in the preview with the same checks and duplicate detection, then follow the same confirm, summary and undo steps. See `docs/DECISIONS.md` (#35–#40).
