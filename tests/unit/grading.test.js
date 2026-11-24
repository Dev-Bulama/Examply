'use strict';

const { markItem, longestCorrectSubsequence, containsTerm } = require('../../src/services/grading/strategies');
const { scoreAttempt, percentileRank } = require('../../src/services/grading/score');
const runner = require('../../src/services/sql/runner');

afterAll(() => runner.shutdown());

const P = { partialCredit: false, negative: 0 };
const PC = { partialCredit: true, negative: 0 };
const NEG = { partialCredit: false, negative: 0.25 };
const item = (type, answer, extra = {}) => ({ type, marks: 4, answer, settings: {}, ...extra });

describe('single choice / true-false / hotspot', () => {
  const q = item('single_choice', { correct: ['B'] });
  test('correct = full marks', async () => expect(await markItem(q, { selected: 'B' }, P)).toMatchObject({ awarded: 4, correct: true }));
  test('wrong = 0, or −negative', async () => {
    expect((await markItem(q, { selected: 'A' }, P)).awarded).toBe(0);
    expect((await markItem(q, { selected: 'A' }, NEG)).awarded).toBe(-0.25);
  });
  test('unanswered is 0 and never negative', async () => {
    expect(await markItem(q, null, NEG)).toMatchObject({ awarded: 0, correct: false });
    expect((await markItem(q, { selected: '' }, NEG)).awarded).toBe(0);
  });
  test('true/false and hotspot follow the same rule', async () => {
    expect((await markItem(item('true_false', { correct: ['F'] }), { selected: 'F' }, P)).awarded).toBe(4);
    expect((await markItem(item('hotspot', { correct: ['H2'] }), { selected: 'H1' }, NEG)).awarded).toBe(-0.25);
  });
});

describe('multiple response', () => {
  const q = item('multiple_response', { correct: ['A', 'C', 'D'] }, { marks: 3 });
  test('exact set = full marks', async () => expect((await markItem(q, { selected: ['D', 'A', 'C'] }, P)).awarded).toBe(3));
  test('without partial credit, anything else = 0', async () => expect((await markItem(q, { selected: ['A', 'C'] }, P)).awarded).toBe(0));
  test('partial: max(0, (right − wrong) / totalCorrect) × marks', async () => {
    expect((await markItem(q, { selected: ['A', 'C'] }, PC)).awarded).toBe(2);
    expect((await markItem(q, { selected: ['A', 'C', 'B'] }, PC)).awarded).toBe(1);
    expect((await markItem(q, { selected: ['A', 'B', 'E'] }, PC)).awarded).toBe(0);
  });
  test('negative applies only when the result is 0 and something was selected', async () => {
    expect((await markItem(q, { selected: ['A', 'B', 'E'] }, { partialCredit: true, negative: 0.5 })).awarded).toBe(-0.5);
    expect((await markItem(q, { selected: ['A', 'C'] }, { partialCredit: true, negative: 0.5 })).awarded).toBe(2);
    expect((await markItem(q, { selected: [] }, { partialCredit: true, negative: 0.5 })).awarded).toBe(0);
  });
});

describe('fill in the blank', () => {
  const q = item('fill_blank', { blanks: [{ variants: ['1521', 'port 1521'] }, { variants: ['listener.ora'] }] }, { settings: { case_sensitive: false, trim_whitespace: true } });
  test('every blank must match a variant (case and spaces normalised)', async () => {
    expect((await markItem(q, { blanks: ['  Port   1521 ', 'LISTENER.ORA'] }, P)).awarded).toBe(4);
  });
  test('partial: marks ÷ blanks per correct blank', async () => {
    expect((await markItem(q, { blanks: ['1521', 'tnsnames.ora'] }, PC)).awarded).toBe(2);
    expect((await markItem(q, { blanks: ['1521', 'tnsnames.ora'] }, P)).awarded).toBe(0);
  });
  test('case-sensitive when set', async () => {
    const cs = { ...q, settings: { case_sensitive: true, trim_whitespace: true } };
    expect((await markItem(cs, { blanks: ['1521', 'LISTENER.ORA'] }, P)).correct).toBe(false);
  });
  test('negative per question only when all blanks are wrong', async () => {
    expect((await markItem(q, { blanks: ['x', 'y'] }, NEG)).awarded).toBe(-0.25);
    expect((await markItem(q, { blanks: ['1521', 'y'] }, NEG)).awarded).toBe(0);
  });
});

describe('numeric', () => {
  const q = item('numeric', { value: 6, tolerance: 0.1 });
  test('within tolerance', async () => {
    expect((await markItem(q, { value: '6.08' }, P)).awarded).toBe(4);
    expect((await markItem(q, { value: '5.9' }, P)).awarded).toBe(4);
    expect((await markItem(q, { value: '6.2' }, NEG)).awarded).toBe(-0.25);
  });
  test('thousands separators are accepted', async () => expect((await markItem(item('numeric', { value: 5000, tolerance: 0 }), { value: '5,000' }, P)).correct).toBe(true));
  test('non-numbers are unanswered', async () => expect((await markItem(q, { value: 'six' }, NEG)).awarded).toBe(0));
});

describe('matching and ordering', () => {
  const m = item('matching', { pairs: [['L1', 'R1'], ['L2', 'R2'], ['L3', 'R3'], ['L4', 'R4']] });
  test('matching: all pairs / partial share / never negative', async () => {
    expect((await markItem(m, { pairs: { L1: 'R1', L2: 'R2', L3: 'R3', L4: 'R4' } }, P)).awarded).toBe(4);
    expect((await markItem(m, { pairs: { L1: 'R1', L2: 'R2', L3: 'R4', L4: 'R3' } }, PC)).awarded).toBe(2);
    expect((await markItem(m, { pairs: { L1: 'R2' } }, { partialCredit: false, negative: 1 })).awarded).toBe(0);
  });
  const o = item('ordering', { order: ['I1', 'I2', 'I3', 'I4', 'I5'] }, { marks: 5 });
  test('ordering: exact / longest correct subsequence ÷ length', async () => {
    expect((await markItem(o, { order: ['I1', 'I2', 'I3', 'I4', 'I5'] }, P)).awarded).toBe(5);
    expect((await markItem(o, { order: ['I2', 'I1', 'I3', 'I4', 'I5'] }, PC)).awarded).toBe(4);
    expect((await markItem(o, { order: ['I5', 'I4', 'I3', 'I2', 'I1'] }, PC)).awarded).toBe(1);
    expect((await markItem(o, { order: ['I5', 'I4', 'I3', 'I2', 'I1'] }, { partialCredit: false, negative: 1 })).awarded).toBe(0);
    expect(longestCorrectSubsequence(['c', 'a', 'b', 'e', 'd'], ['a', 'b', 'c', 'd', 'e'])).toBe(3);
  });
});

describe('short answer and essay', () => {
  const q = item('short_answer', { keywords: [{ terms: ['atomicity', 'atomic'], weight: 1 }, { terms: ['consistency'], weight: 1 }, { terms: ['isolation'], weight: 1 }, { terms: ['durability'], weight: 1 }], threshold: 4 }, { marks: 2 });
  test('threshold reached = full marks', async () => expect((await markItem(q, { text: 'Atomic, consistency, isolation and durability.' }, P)).awarded).toBe(2));
  test('partial: keyword weights found, capped at the marks', async () => {
    expect((await markItem(q, { text: 'isolation' }, PC)).awarded).toBe(1);
    expect((await markItem(q, { text: 'consistency isolation durability' }, PC)).awarded).toBe(2);
    expect((await markItem(q, { text: 'consistency isolation durability' }, P)).awarded).toBe(0);
  });
  test('whole words only', () => {
    expect(containsTerm('the isolationist', 'isolation', false)).toBe(false);
    expect(containsTerm('Isolation-level', 'isolation', false)).toBe(true);
  });
  test('essays wait for a person', async () => expect(await markItem(item('essay', {}), { text: 'Long answer' }, P)).toMatchObject({ status: 'pending_manual', awarded: null }));
});

describe('sql', () => {
  const q = item('sql', { solution_sql: 'SELECT name FROM t WHERE n > 1', order_matters: false, column_names_matter: false, numeric_tolerance: 0 }, { settings: { mode: 'query', schema_sql: 'CREATE TABLE t (name TEXT, n INT);', seed_sql: "INSERT INTO t VALUES ('a',1),('b',2),('c',3);" } });
  test('equivalent query scores; wrong result does not', async () => {
    expect((await markItem(q, { sql: "SELECT name FROM t WHERE name <> 'a'" }, NEG)).awarded).toBe(4);
    const wrong = await markItem(q, { sql: 'SELECT name FROM t' }, NEG);
    expect(wrong).toMatchObject({ awarded: 0, correct: false });
    expect(wrong.detail.reason).toMatch(/3 rows/);
  });
  test('a broken model solution goes to manual review, never penalising the candidate', async () => {
    const broken = { ...q, answer: { ...q.answer, solution_sql: 'SELECT nope FROM t' } };
    expect((await markItem(broken, { sql: 'SELECT name FROM t' }, P)).status).toBe('pending_manual');
  });
});

describe('score aggregation', () => {
  const it = (awarded, extra = {}) => ({ marksPossible: 2, awarded, status: 'auto', correct: awarded === 2, sectionId: 1, sectionTitle: 'A', domainKey: 'D1', domainLabel: 'One', difficulty: 3, type: 'single_choice', ...extra });
  test('total never below zero; percent; pass', () => {
    const r = scoreAttempt([it(-0.5), it(-0.5)], { passMark: 50, passMarkType: 'percent', sections: [] });
    expect(r).toMatchObject({ raw: 0, max: 4, percent: 0, passed: false });
    const ok = scoreAttempt([it(2), it(2), it(0), it(0, { sectionId: 2, sectionTitle: 'B' })], { passMark: 50, passMarkType: 'percent', sections: [] });
    expect(ok).toMatchObject({ raw: 4, max: 8, percent: 50, passed: true });
  });
  test('raw pass mark', () => expect(scoreAttempt([it(2), it(1.5)], { passMark: 3.5, passMarkType: 'raw', sections: [] }).passed).toBe(true));
  test('a missed section minimum fails the attempt even above the pass mark', () => {
    const r = scoreAttempt([it(2), it(2), it(2), it(0, { sectionId: 2, sectionTitle: 'B' })], { passMark: 50, passMarkType: 'percent', sections: [{ id: 2, title: 'B', min_score_percent: 40 }] });
    expect(r.percent).toBe(75);
    expect(r.passed).toBe(false);
    expect(r.sectionMins[0]).toMatchObject({ section: 'B', met: false });
  });
  test('pending manual items defer the pass decision and the band', () => {
    const r = scoreAttempt([it(2), { ...it(null), status: 'pending_manual' }], { passMark: 50, passMarkType: 'percent', sections: [], bands: [{ name: 'All', min_percent: 0, max_percent: 100 }] });
    expect(r).toMatchObject({ pending: 1, passed: null, band: null });
  });
  test('bands, scaled score and domain breakdown', () => {
    const r = scoreAttempt([it(2), it(2, { domainKey: 'D2', domainLabel: 'Two' }), it(0, { domainKey: 'D2', domainLabel: 'Two' })], { passMark: null, sections: [], bands: [{ name: 'Low', min_percent: 0, max_percent: 59.99 }, { name: 'High', min_percent: 60, max_percent: 100 }], scaling: { enabled: true, min: 100, max: 1000 } });
    expect(r.percent).toBe(66.67);
    expect(r.band).toBe('High');
    expect(r.scaled).toBe(700);
    expect(r.passed).toBeNull();
    expect(r.domains.find((d) => d.key === 'D2')).toMatchObject({ score: 2, max: 4, percent: 50 });
  });
  test('percentile rank counts half the ties', () => {
    expect(percentileRank(70, [50, 60, 70, 80])).toBe(62.5);
    expect(percentileRank(70, [])).toBeNull();
  });
  test('200 items are marked well under 300 ms', async () => {
    const q = item('multiple_response', { correct: ['A', 'C'] });
    const started = process.hrtime.bigint();
    const marked = [];
    for (let i = 0; i < 200; i += 1) marked.push({ ...(await markItem(q, { selected: ['A'] }, PC)), marksPossible: 4, sectionId: null, domainKey: `D${i % 5}`, domainLabel: 'x', difficulty: 3, type: 'multiple_response' });
    scoreAttempt(marked, { passMark: 50, passMarkType: 'percent', sections: [] });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(300);
  });
});
