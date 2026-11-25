'use strict';

const P = require('../../src/services/import/parsers');
const T = require('../../src/services/questions/types');
const { TEMPLATES } = require('../../src/services/import/templates');
const exporter = require('../../src/services/import/exporter');

describe('templates re-import cleanly', () => {
  test.each(Object.keys(TEMPLATES))('%s template', async (fmt) => {
    const buf = await TEMPLATES[fmt].build();
    const format = fmt === 'docx' ? 'docx' : fmt;
    const { records, fileErrors } = await P.parseFile(format, buf);
    expect(fileErrors).toEqual([]);
    expect(records.length).toBeGreaterThanOrEqual(2);
    for (const r of records) {
      const problems = [...r.errors, ...T.validate(T.normalise(r.question)).map((e) => e.message)];
      expect([r.rowRef, problems]).toEqual([r.rowRef, []]);
    }
  });

  test('every type appears in the Excel template', async () => {
    const { records } = await P.parseFile('xlsx', await TEMPLATES.xlsx.build());
    const types = new Set(records.map((r) => r.question.type));
    for (const t of T.TYPE_KEYS.filter((x) => x !== 'hotspot' && x !== 'lab')) expect(types).toContain(t);
  });
});

describe('export round-trips through import', () => {
  const samples = [
    { type: 'single_choice', stem_html: '<p>Q1</p>', options: [{ text: 'a' }, { text: 'b', correct: true }], explanation_html: '<p>e</p>', marks: 1 },
    { type: 'fill_blank', stem_html: '<p>Port [[1]] or [[2]]</p>', blanks: [{ variants: ['1521', 'p1521'] }, { variants: ['x'] }], case_sensitive: false, trim_whitespace: true, explanation_html: '<p>e</p>', marks: 2 },
    { type: 'short_answer', stem_html: '<p>ACID</p>', keywords: [{ terms: ['atomicity', 'atomic'], weight: 1 }, { terms: ['durability'], weight: 2 }], threshold: 3, case_sensitive: false, explanation_html: '<p>e</p>', marks: 2 },
    { type: 'matching', stem_html: '<p>M</p>', pairs: [{ left: 'l1', right: 'r1' }, { left: 'l2', right: 'r2' }], distractors: ['r3'], explanation_html: '<p>e</p>', marks: 1 },
  ].map((a) => T.normalise(a));
  const items = samples.map((a, i) => ({ id: i + 1, authoring: a, meta: { category: 'Cat', difficulty: 3, tags: 'x' }, children: [] }));

  test('xlsx', async () => {
    const { records } = await P.parseFile('xlsx', await exporter.toXlsx(items));
    records.forEach((r, i) => expect(T.contentHash(T.normalise(r.question))).toBe(T.contentHash(samples[i])));
  });
  test('json', async () => {
    const { records } = await P.parseFile('json', exporter.toJsonExport(items));
    records.forEach((r, i) => expect(T.normalise(r.question)).toEqual(samples[i]));
  });
  test('gift (supported types)', async () => {
    const out = exporter.toGift(items).toString();
    expect(out).toContain('Not exported');
    const { records } = await P.parseFile('gift', Buffer.from(out));
    expect(records.map((r) => r.question.type)).toEqual(['single_choice', 'matching']);
  });
});
