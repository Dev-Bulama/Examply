'use strict';

/**
 * Downloadable import templates. Examples are authoring models passed through the exporter, so every template
 * row is guaranteed to re-import cleanly (a unit test checks this).
 */
const ExcelJS = require('exceljs');
const { stringify } = require('csv-stringify/sync');
const { COLUMNS } = require('./columns');
const { toRecord } = require('./exporter');
const { buildDocx } = require('./docxWriter');

const meta = (extra = {}) => ({ difficulty: 2, category: 'Database > Oracle', certification: '1Z0-082', domain: 'SQL', topic: 'Basics', tags: 'sample', time_seconds: 60, ...extra });

const EXAMPLES = {
  'Single choice': [
    { a: { type: 'single_choice', stem_html: 'Which clause filters groups after aggregation?', options: [{ text: 'WHERE' }, { text: 'HAVING', correct: true }, { text: 'ORDER BY' }, { text: 'GROUP BY' }], explanation_html: 'HAVING is applied after GROUP BY.', marks: 1 }, m: meta() },
  ],
  'Multiple response': [
    { a: { type: 'multiple_response', stem_html: 'Which are AWS compute services?', options: [{ text: 'EC2', correct: true }, { text: 'S3' }, { text: 'Lambda', correct: true }, { text: 'Route 53' }], select_exact: 2, explanation_html: 'S3 is storage; Route 53 is DNS.', marks: 2 }, m: meta({ category: 'Cloud > AWS', certification: 'CLF-C02', domain: 'D3' }) },
  ],
  'True-False': [{ a: { type: 'true_false', stem_html: 'A primary key column may contain NULL values.', correct: false, explanation_html: 'Primary keys are always NOT NULL.', marks: 1 }, m: meta() }],
  'Fill in the blank': [
    { a: { type: 'fill_blank', stem_html: 'The default listener port is [[1]] and it is configured in [[2]].', blanks: [{ variants: ['1521', 'port 1521'] }, { variants: ['listener.ora'] }], explanation_html: 'See the Oracle Net documentation.', marks: 2 }, m: meta({ domain: 'INST' }) },
  ],
  Numeric: [{ a: { type: 'numeric', stem_html: 'A process has 25 defects in 5,000 opportunities. What is its DPMO?', value: 5000, tolerance: 0, units: 'DPMO', explanation_html: '25 ÷ 5,000 × 1,000,000.', marks: 1 }, m: meta({ category: 'Quality > Lean Six Sigma', certification: 'LSSGB', domain: 'MEA' }) }],
  Matching: [
    { a: { type: 'matching', stem_html: 'Match each tool to its purpose.', pairs: [{ left: 'Pareto chart', right: 'Focus on the vital few' }, { left: '5 Whys', right: 'Find the root cause' }], distractors: ['Track the budget'], explanation_html: 'Pareto prioritises; 5 Whys drills down.', marks: 2 }, m: meta({ category: 'Quality > Lean Six Sigma', certification: 'LSSGB', domain: 'ANA' }) },
  ],
  Ordering: [{ a: { type: 'ordering', stem_html: 'Put the DMAIC phases in order.', items: ['Define', 'Measure', 'Analyze', 'Improve', 'Control'], explanation_html: 'D-M-A-I-C.', marks: 1 }, m: meta({ category: 'Quality > Lean Six Sigma', certification: 'LSSGB', domain: 'DEF' }) }],
  'Short answer': [
    { a: { type: 'short_answer', stem_html: 'Name the four ACID properties.', keywords: [{ terms: ['atomicity'], weight: 1 }, { terms: ['consistency'], weight: 1 }, { terms: ['isolation'], weight: 1 }, { terms: ['durability'], weight: 1 }], threshold: 4, explanation_html: 'Atomicity, Consistency, Isolation, Durability.', marks: 2 }, m: meta() },
  ],
  Essay: [{ a: { type: 'essay', stem_html: 'Describe how you would sustain a process improvement for 12 months.', min_words: 100, max_words: 400, rubric_html: 'Metrics (2), control chart (3), owners and reaction plan (3), standard work (2).', explanation_html: 'A strong answer covers measurement, monitoring and ownership.', marks: 10 }, m: meta({ category: 'Quality > Lean Six Sigma', certification: 'LSSGB', domain: 'CTL' }) }],
  'SQL lab': [
    {
      a: {
        type: 'sql',
        stem_html: 'List each department name with its number of employees, largest department first. Name the columns <code>department</code> and <code>headcount</code>.',
        mode: 'query',
        schema_sql: 'CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\nCREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, department_id INTEGER REFERENCES departments(id), salary INTEGER);',
        seed_sql: "INSERT INTO departments VALUES (1,'Engineering'),(2,'Sales'),(3,'Finance');\nINSERT INTO employees VALUES (1,'Ada',1,900000),(2,'Bayo',1,750000),(3,'Chi',2,500000),(4,'Dami',1,820000),(5,'Efe',3,610000),(6,'Funmi',2,480000);",
        solution_sql: 'SELECT d.name AS department, COUNT(e.id) AS headcount FROM departments d JOIN employees e ON e.department_id = d.id GROUP BY d.name ORDER BY headcount DESC;',
        order_matters: true,
        column_names_matter: true,
        explanation_html: 'Join employees to departments, GROUP BY the department and ORDER BY the count descending.',
        marks: 2,
      },
      m: meta(),
    },
  ],
};

const CASE_EXAMPLE = [
  { a: { type: 'case_study', stem_html: 'Scenario: after a reboot, clients get ORA-12541: TNS:no listener. The instance is OPEN.', marks: 0 }, m: meta({ domain: 'INST' }), case_id: 'CS1' },
  { a: { type: 'single_choice', stem_html: 'What is the most likely cause?', options: [{ text: 'The listener was not started', correct: true }, { text: 'Passwords expired' }, { text: 'SYSTEM tablespace full' }], explanation_html: 'ORA-12541 means nothing is listening.', marks: 1 }, m: meta({ domain: 'INST' }), case_id: 'CS1' },
  { a: { type: 'fill_blank', stem_html: 'The utility that starts the listener is [[1]].', blanks: [{ variants: ['lsnrctl', 'lsnrctl start'] }], explanation_html: 'lsnrctl start.', marks: 1 }, m: meta({ domain: 'INST' }), case_id: 'CS1' },
];

function rowValues(ex) {
  const rec = { ...toRecord({ reference: '', ...ex.a }, ex.m), ...(ex.case_id ? { case_id: ex.case_id } : {}) };
  return COLUMNS.map((c) => rec[c.key] ?? '');
}

async function xlsxTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Skillscore Assess';
  const ins = wb.addWorksheet('Instructions');
  ins.columns = [{ width: 22 }, { width: 110 }];
  ins.addRow(['Question import template']).font = { bold: true, size: 14 };
  [
    'One row per question. The first row of every sheet is the header row — keep the header names.',
    'You may keep all questions on one sheet or use the per-type sheets below; this Instructions sheet is ignored.',
    'Delete the example rows before importing your own questions (or keep them to see how they import).',
    'Only “type”, “question” and the answer columns are required. Category/certification can come from the import defaults.',
    'For a ZIP import, put this workbook and an images/ folder in one .zip file and write the image file names in the “image” column.',
    'You will see a dry-run preview with every problem before anything is saved.',
  ].forEach((t) => ins.addRow(['', t]));
  ins.addRow([]);
  ins.addRow(['Column', 'How to fill it']).font = { bold: true };
  for (const c of COLUMNS) if (c.help) ins.addRow([c.key, c.help]);
  ins.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const all = wb.addWorksheet('All types');
  all.addRow(COLUMNS.map((c) => c.key));
  for (const list of Object.values(EXAMPLES)) for (const ex of list) all.addRow(rowValues(ex));
  for (const ex of CASE_EXAMPLE) all.addRow(rowValues(ex));
  all.getRow(1).font = { bold: true };
  all.views = [{ state: 'frozen', ySplit: 1 }];
  all.getColumn(2).width = 60;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function csvTemplate() {
  const rows = [COLUMNS.map((c) => c.key)];
  for (const list of Object.values(EXAMPLES)) for (const ex of list) rows.push(rowValues(ex));
  return Buffer.from(`﻿${stringify(rows)}`);
}

function jsonTemplate() {
  const qs = [];
  for (const list of Object.values(EXAMPLES)) for (const ex of list) qs.push({ ...ex.a, category: ex.m.category, certification: ex.m.certification, domain: ex.m.domain, difficulty: ex.m.difficulty, tags: [ex.m.tags] });
  qs.push({ ...CASE_EXAMPLE[0].a, category: 'Database > Oracle', children: CASE_EXAMPLE.slice(1).map((c) => c.a) });
  return Buffer.from(JSON.stringify({ questions: qs }, null, 2));
}

function aikenTemplate() {
  return Buffer.from(
    ['Which clause filters groups after aggregation?', 'A. WHERE', 'B. HAVING', 'C. ORDER BY', 'D. GROUP BY', 'ANSWER: B', '', 'Which AWS service stores objects?', 'A. Amazon EBS', 'B. Amazon S3', 'C. Amazon EFS', 'ANSWER: B', ''].join('\n'),
  );
}

function giftTemplate() {
  return Buffer.from(
    [
      '// GIFT sample — one question per paragraph, separated by a blank line.',
      '$CATEGORY: Database/Oracle',
      '',
      '::Q1:: Which clause filters groups after aggregation? {=HAVING ~WHERE ~ORDER BY #### HAVING runs after GROUP BY.}',
      '',
      '::Q2:: Which are AWS compute services? {~%50%EC2 ~%50%Lambda ~%-100%S3}',
      '',
      '::Q3:: A primary key may contain NULL values. {F}',
      '',
      '::Q4:: What is ROUND(156.785, -1)? {#160}',
      '',
      '::Q5:: The default listener port is {=1521 =port 1521}.',
      '',
      '::Q6:: Match each tool to its purpose. {=Pareto chart -> Focus on the vital few =5 Whys -> Find the root cause}',
      '',
      '::Q7:: Describe your control plan. {}',
      '',
    ].join('\n'),
  );
}

function docxTemplate() {
  return buildDocx([
    { text: 'Question import — Word format', bold: true },
    'Number each question, letter the options, then add an Answer line. Explanation, Type, Difficulty, Category, Certification, Domain, Topic, Tags and Marks lines are optional.',
    '1. Which clause filters groups after aggregation?',
    'A. WHERE',
    'B. HAVING',
    'C. ORDER BY',
    'D. GROUP BY',
    'Answer: B',
    'Explanation: HAVING is evaluated after GROUP BY.',
    'Difficulty: easy',
    'Category: Database > Oracle',
    '2. Which are AWS compute services?',
    'A. EC2',
    'B. S3',
    'C. Lambda',
    'Answer: A, C',
    'Explanation: S3 is object storage.',
    '3. A primary key may contain NULL values.',
    'Answer: False',
    '4. What does ROUND(156.785, -1) return?',
    'Answer: 160',
    'Type: numeric',
  ]);
}

const TEMPLATES = {
  xlsx: { file: 'question-import-template.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', build: xlsxTemplate },
  csv: { file: 'question-import-template.csv', mime: 'text/csv', build: csvTemplate },
  json: { file: 'question-import-template.json', mime: 'application/json', build: jsonTemplate },
  aiken: { file: 'question-import-aiken.txt', mime: 'text/plain', build: aikenTemplate },
  gift: { file: 'question-import-gift.txt', mime: 'text/plain', build: giftTemplate },
  docx: { file: 'question-import-template.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', build: docxTemplate },
};

module.exports = { TEMPLATES, EXAMPLES };
