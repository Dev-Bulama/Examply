'use strict';

const T = require('../../src/services/questions/types');

const SAMPLES = {
  single_choice: { stem_html: '<p>Which SQL clause filters grouped rows?</p>', options: [{ text: 'WHERE' }, { text: 'HAVING', correct: true }, { text: 'ORDER BY' }, { text: 'None of the above', pin_last: true }] },
  multiple_response: { stem_html: '<p>Which are AWS compute services?</p>', options: [{ text: 'EC2', correct: true }, { text: 'Lambda', correct: true }, { text: 'S3' }, { text: 'Route 53' }], select_exact: 2 },
  true_false: { stem_html: '<p>A primary key may contain NULL values.</p>', correct: false, feedback_false: 'Primary keys are always NOT NULL.' },
  fill_blank: { stem_html: '<p>The default Oracle listener port is [[1]] and it uses [[2]].</p>', blanks: [{ variants: ['1521'] }, { variants: ['TCP', 'TCP/IP'] }] },
  numeric: { stem_html: '<p>Sigma level for 3.4 DPMO?</p>', value: 6, tolerance: 0.1, units: 'σ' },
  matching: { stem_html: '<p>Match each DMAIC phase to its purpose.</p>', pairs: [{ left: 'Define', right: 'Scope the problem' }, { left: 'Measure', right: 'Baseline performance' }, { left: 'Control', right: 'Sustain the gains' }], distractors: ['Ignore the data'] },
  ordering: { stem_html: '<p>Order the PMP process groups.</p>', items: ['Initiating', 'Planning', 'Executing', 'Monitoring and Controlling', 'Closing'] },
  hotspot: { stem_html: '<p>Click the database tier.</p>', image: '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', regions: [{ label: 'Web', x: 0, y: 0, w: 30, h: 30 }, { label: 'DB', x: 60, y: 60, w: 30, h: 30, correct: true }] },
  short_answer: { stem_html: '<p>Name the ACID properties.</p>', keywords: [{ terms: ['atomicity'], weight: 1 }, { terms: ['consistency'], weight: 1 }, { terms: ['isolation'], weight: 1 }, { terms: ['durability'], weight: 1 }], threshold: 4 },
  essay: { stem_html: '<p>Discuss risk responses.</p>', marks: 10, min_words: 100, max_words: 500, rubric_html: '<p>Avoid, mitigate, transfer, accept.</p>' },
  case_study: { stem_html: '<p>Read the scenario about Acme Ltd.</p>' },
};

describe('question type registry', () => {
  test('covers all 11 types', () => expect(T.TYPE_KEYS).toHaveLength(11));

  test.each(Object.entries(SAMPLES))('%s: valid sample round-trips through storage', (type, sample) => {
    const q = T.normalise({ type, ...sample });
    expect(T.validate(q)).toEqual([]);
    const stored = T.toStored(q);
    const back = T.normalise(T.fromStored({ type, stem_html: stored.stem_html, explanation_html: stored.explanation_html, reference: stored.reference, marks: stored.marks }, stored.options, stored.answer, stored.settings));
    expect(back).toEqual(q);
  });

  test.each(Object.entries(SAMPLES))('%s: candidate view never contains answers or feedback', (type, sample) => {
    const q = T.normalise({ type, ...sample });
    const stored = T.toStored(q);
    const view = T.candidateView({ type, stem_html: stored.stem_html, marks: stored.marks }, stored.options, stored.settings, { shuffleOptions: true });
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/is_correct|"correct"|feedback|variants|tolerance|keywords|rubric|"pairs"|"order"/);
    if (type === 'numeric') expect(json).not.toContain('"value"');
  });

  test('pinned option stays last when shuffled', () => {
    const q = T.normalise({ type: 'single_choice', ...SAMPLES.single_choice });
    const s = T.toStored(q);
    for (let i = 0; i < 20; i += 1) {
      const v = T.candidateView({ type: 'single_choice', stem_html: '', marks: 1 }, s.options, s.settings, { shuffleOptions: true });
      expect(v.options[v.options.length - 1].html).toBe('None of the above');
    }
  });

  test('option text escapes HTML but keeps `code`', () => {
    const q = T.normalise({ type: 'single_choice', stem_html: '<p>x</p>', options: [{ text: 'Use `SELECT *`', correct: true }, { text: '<script>alert(1)</script>' }] });
    const s = T.toStored(q);
    expect(s.options[0].content_html).toBe('Use <code>SELECT *</code>');
    expect(s.options[1].content_html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  describe('validation messages', () => {
    const msgs = (a) => T.validate(T.normalise(a)).map((e) => e.message);
    test('single choice', () => {
      expect(msgs({ type: 'single_choice', stem_html: '<p>Q</p>', options: [{ text: 'A' }, { text: 'B' }] })).toContain('Mark the correct option.');
      expect(msgs({ type: 'single_choice', stem_html: '<p>Q</p>', options: [{ text: 'A', correct: true }, { text: 'B', correct: true }] })).toContain('A single-choice question must have exactly one correct option.');
      expect(msgs({ type: 'single_choice', stem_html: '', options: [{ text: 'A', correct: true }] })).toEqual(expect.arrayContaining(['The question text (stem) is empty.', 'Add at least 2 options.']));
      expect(msgs({ type: 'single_choice', stem_html: '<p>Q</p>', options: [{ text: 'A', correct: true }, { text: 'a' }] })).toContain('Two options have the same text.');
    });
    test('multiple response select-exact must match', () => {
      expect(msgs({ ...SAMPLES.multiple_response, type: 'multiple_response', select_exact: 3 })).toContain('“Select exactly 3” does not match the 2 correct options.');
    });
    test('fill in the blank counts placeholders', () => {
      expect(msgs({ type: 'fill_blank', stem_html: '<p>A [[1]] and [[3]]</p>', blanks: [{ variants: ['x'] }] })).toEqual(
        expect.arrayContaining(['Blank [[2]] is missing from the question text (blanks must be numbered 1, 2, 3… without gaps).', 'The question text has 3 blanks but 1 answer is defined.']),
      );
    });
    test('short answer threshold reachable', () => {
      expect(msgs({ ...SAMPLES.short_answer, type: 'short_answer', threshold: 9 })).toContain('The threshold (9) is higher than the total keyword weight (4), so full marks could never be reached.');
    });
    test('hotspot needs exactly one correct region inside the image', () => {
      expect(msgs({ ...SAMPLES.hotspot, type: 'hotspot', regions: [{ label: 'A', x: 90, y: 0, w: 30, h: 10, correct: true }, { label: 'B', x: 0, y: 0, w: 5, h: 5, correct: true }] })).toEqual(
        expect.arrayContaining(['Region 1 must lie inside the image.', 'Mark exactly one region as correct.']),
      );
    });
    test('unknown type', () => expect(msgs({ type: 'poll', stem_html: '<p>x</p>' })[0]).toMatch(/Unknown question type "poll"/));
  });

  describe('content hash (duplicate detection)', () => {
    const hash = (a) => T.contentHash(T.normalise(a));
    test('ignores formatting, case and option order', () => {
      const a = hash({ type: 'single_choice', stem_html: '<p>Which <b>clause</b> filters groups?</p>', options: [{ text: 'WHERE' }, { text: 'HAVING', correct: true }] });
      const b = hash({ type: 'single_choice', stem_html: '<div>which clause   FILTERS groups?</div>', options: [{ text: 'having', correct: true }, { text: 'where' }] });
      expect(a).toBe(b);
    });
    test('changes when the content changes', () => {
      expect(hash({ type: 'numeric', stem_html: '<p>x</p>', value: 1 })).not.toBe(hash({ type: 'numeric', stem_html: '<p>x</p>', value: 2 }));
      expect(hash({ type: 'true_false', stem_html: '<p>x</p>', correct: true })).not.toBe(hash({ type: 'single_choice', stem_html: '<p>x</p>', options: [] }));
    });
  });

  test('empty authoring models exist for every type and are invalid until filled', () => {
    for (const t of T.TYPE_KEYS) {
      const e = T.emptyAuthoring(t);
      expect(e.type).toBe(t);
      expect(T.validate(T.normalise(e)).length).toBeGreaterThan(0);
    }
  });
});
