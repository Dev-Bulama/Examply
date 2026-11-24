'use strict';

const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const P = require('../../src/services/import/parsers');
const T = require('../../src/services/questions/types');

const valid = (rec) => T.validate(T.normalise(rec.question)).map((e) => e.message);

async function xlsxFrom(rows, sheet = 'Questions') {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Instructions').addRow(['ignored']);
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('spreadsheet (xlsx / csv)', () => {
  const header = ['Type', 'Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Explanation', 'Difficulty', 'Category', 'Tags'];
  test('maps headers, types and answers; reports exact row errors', async () => {
    const buf = await xlsxFrom([
      header,
      ['mcq', 'Which clause filters groups?', 'WHERE', 'HAVING', 'ORDER BY', 'GROUP BY', 'B', 'HAVING filters groups.', 'medium', 'Database > Oracle', 'sql, groups'],
      ['mcq', 'Bad key', 'A1', 'B1', 'C1', 'D1', 'E', '', '3', '', ''],
      ['tf', 'The sky is green.', '', '', '', '', 'FALSE', '', '1', '', ''],
      ['multi', 'Pick two', 'x', 'y', 'z', '', 'A, C', '', 'hard', '', ''],
      [],
      ['blank', 'Port ___ and file ___.', '', '', '', '', '1521 | port 1521 || listener.ora', '', '2', '', ''],
      ['numeric', 'Pi to 2dp', '', '', '', '', '3.14 ± 0.01', '', '9', '', ''],
    ]);
    const { records } = await P.parseXlsx(buf);
    expect(records).toHaveLength(6);
    const [mcq, bad, tf, multi, blank, num] = records;
    expect(mcq.rowRef).toBe('Row 2');
    expect(valid(mcq)).toEqual([]);
    expect(mcq.question.options[1].correct).toBe(true);
    expect(mcq.meta).toMatchObject({ difficulty: 3, category: 'Database > Oracle', tags: 'sql, groups' });
    expect(bad.errors).toContain("Correct answer 'E' is not among options A–D.");
    expect(tf.question.correct).toBe(false);
    expect(multi.question.options.map((o) => o.correct)).toEqual([true, false, true]);
    expect(blank.rowRef).toBe('Row 7');
    expect(blank.question.stem_html).toContain('[[1]]');
    expect(blank.question.blanks).toEqual([{ variants: ['1521', 'port 1521'] }, { variants: ['listener.ora'] }]);
    expect(valid(blank)).toEqual([]);
    expect(num.question).toMatchObject({ value: 3.14, tolerance: 0.01 });
    expect(num.errors).toContain('Difficulty “9” must be 1–5 or very easy / easy / medium / hard / very hard.');
  });

  test('csv with semicolons, BOM, matching, ordering and short answer', () => {
    const csv = '﻿type;question;option_a;option_b;option_c;answer\nmatching;Match them;Define => Scope;Measure => Baseline;Ignore data;\nordering;Order DMAIC;Define;Measure;Analyze;\nshort;ACID?;;;;"atomicity=1; consistency|consistent=2"\n';
    const { records } = P.parseCsvBuffer(Buffer.from(csv));
    expect(records[0].question.pairs).toHaveLength(2);
    expect(records[0].question.distractors).toEqual(['Ignore data']);
    expect(records[1].question.items).toEqual(['Define', 'Measure', 'Analyze']);
    expect(records[2].question.keywords).toEqual([{ terms: ['atomicity'], weight: 1 }, { terms: ['consistency', 'consistent'], weight: 2 }]);
    expect(records[2].question.threshold).toBe(3);
    for (const r of records) expect(valid(r)).toEqual([]);
  });

  test('rejects a file without a recognisable header', () => {
    const { fileErrors } = P.parseCsvBuffer(Buffer.from('foo,bar\n1,2\n'));
    expect(fileErrors[0]).toMatch(/no “question” or “type” column/);
  });
});

describe('JSON', () => {
  test('accepts authoring models, nested case-study children and plain text stems', () => {
    const json = JSON.stringify({ questions: [{ type: 'mcq', question: 'Q?', options: [{ text: 'a', correct: true }, { text: 'b' }], category: 'Cloud', tags: ['x', 'y'] }, { type: 'case_study', stem_html: '<p>Scenario</p>', children: [{ type: 'tf', text: 'Child', correct: true }] }] });
    const { records } = P.parseJsonBuffer(Buffer.from(json));
    expect(records).toHaveLength(3);
    expect(records[0].question.stem_html).toBe('<p>Q?</p>');
    expect(records[0].meta.tags).toBe('x, y');
    expect(records[2].parentCaseId).toBe(records[1].caseId);
    expect(records[2].rowRef).toBe('Question 2.1');
    expect(valid(records[0])).toEqual([]);
  });
  test('reports invalid JSON with a location', () => {
    expect(() => P.parseJsonBuffer(Buffer.from('[{"type": "mcq",\n "x": }]'))).toThrow(/^The JSON is not valid/);
  });
});

describe('Aiken', () => {
  test('parses blocks and flags a missing answer', () => {
    const txt = 'What is 2 + 2?\nA. 3\nB. 4\nC. 5\nANSWER: B\n\nWho wrote Hamlet?\nA) Marlowe\nB) Shakespeare\n';
    const { records } = P.parseAiken(Buffer.from(txt));
    expect(records).toHaveLength(2);
    expect(records[0].question.options[1]).toMatchObject({ text: '4', correct: true });
    expect(valid(records[0])).toEqual([]);
    expect(records[1].errors).toContain('Missing “ANSWER:” line.');
    expect(records[1].rowRef).toBe('Line 7');
  });
});

describe('GIFT', () => {
  test('covers MCQ, multi, true/false, numeric, matching, short answer, essay and escapes', () => {
    const gift = [
      '$CATEGORY: $course$/Cloud/AWS',
      '// comment',
      '::Q1:: Which is object storage? {=Amazon S3 #Yes ~Amazon EBS ~Amazon EFS #### S3 stores objects.}',
      '',
      'Select the compute services {~%50%EC2 ~%50%Lambda ~%-100%S3}',
      '',
      'The sky is blue {T}',
      '',
      'Pi to two decimals {#3.14:0.01}',
      '',
      'Match {=Define -> Scope =Measure -> Baseline}',
      '',
      'The default Oracle port is {=1521 =port 1521}.',
      '',
      'Explain ACID {}',
      '',
      'Use \\{braces\\} literally {=yes ~no}',
    ].join('\n');
    const { records } = P.parseGift(Buffer.from(gift));
    expect(records.map((r) => r.question.type)).toEqual(['single_choice', 'multiple_response', 'true_false', 'numeric', 'matching', 'fill_blank', 'essay', 'single_choice']);
    expect(records[0].meta.category).toBe('Cloud > AWS');
    expect(records[0].question.explanation_html).toContain('S3 stores objects.');
    expect(records[0].question.options[0].feedback).toBe('Yes');
    expect(records[1].question.options.map((o) => o.correct)).toEqual([true, true, false]);
    expect(records[3].question).toMatchObject({ value: 3.14, tolerance: 0.01 });
    expect(records[5].question.stem_html).toBe('<p>The default Oracle port is [[1]] .</p>');
    expect(records[7].question.stem_html).toContain('{braces}');
    for (const r of records) expect([r.rowRef, valid(r)]).toEqual([r.rowRef, []]);
  });
});

describe('Word (.docx)', () => {
  test('parses numbered questions with options, answers, explanations and meta lines', async () => {
    const { buildDocx } = require('../../src/services/import/docxWriter');
    const doc = buildDocx([
      'Sample questions',
      '1. Which clause filters groups after aggregation?',
      'A. WHERE',
      'B. HAVING',
      'C. ORDER BY',
      'Answer: B',
      'Explanation: HAVING is evaluated after GROUP BY.',
      'Difficulty: easy',
      '2. Which are AWS compute services?',
      'A) EC2',
      'B) S3',
      'C) Lambda',
      'Answer: A, C',
      'Explanation: S3 is storage.',
      'Q3. A primary key may contain NULL values.',
      'Answer: False',
      'Explanation: Primary keys are NOT NULL.',
      'Question 4: What does ROUND(156.785, -1) return?',
      'Answer: 160',
      'Explanation: Rounds to the nearest ten.',
    ]);
    const { records } = await P.parseDocx(doc);
    expect(records.map((r) => r.question.type)).toEqual(['single_choice', 'multiple_response', 'true_false', 'numeric']);
    expect(records[0].question.explanation_html).toContain('HAVING');
    expect(records[0].meta.difficulty).toBe(2);
    expect(records[3].question.value).toBe(160);
    for (const r of records) expect([r.rowRef, valid(r)]).toEqual([r.rowRef, []]);
  });
});

describe('ZIP bundle and detection', () => {
  test('reads the sheet and images, and detects formats', async () => {
    const sheet = await xlsxFrom([['type', 'question', 'option_a', 'option_b', 'answer', 'image'], ['hotspot', 'Click the DB', 'Web @ 0,0,40,40', 'DB @ 50,50,40,40', 'DB', 'Diagram.PNG']]);
    const zip = new AdmZip();
    zip.addFile('questions.xlsx', sheet);
    zip.addFile('images/diagram.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    const buf = zip.toBuffer();
    const { records, images } = await P.parseZip(buf);
    expect(records[0].question.regions[1].correct).toBe(true);
    expect(records[0].image).toBe('Diagram.PNG');
    expect(images.has('diagram.png')).toBe(true);
    expect(P.detectFormat('bundle.zip', buf)).toBe('zip');
    expect(P.detectFormat('q.xlsx', sheet)).toBe('xlsx');
    expect(P.detectFormat('q.txt', Buffer.from('Q?\nA. x\nB. y\nANSWER: A'))).toBe('aiken');
    expect(P.detectFormat('q.txt', Buffer.from('Q {=a ~b}'))).toBe('gift');
  });
});
