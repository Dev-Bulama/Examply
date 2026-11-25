'use strict';

const P = require('../../src/services/analytics/psychometrics');

describe('classical test theory', () => {
  test('difficulty is the proportion correct', () => {
    expect(P.difficulty([1, 0, 1, 1])).toBe(0.75);
    expect(P.difficulty([])).toBeNull();
  });

  test('KR-20 / alpha matches a hand-computed example', () => {
    // 5 people × 3 right/wrong items. Item variances (p·q): .24 .24 .24 → Σ = .72;
    // totals 3,2,2,1,0 → mean 1.6, population variance 1.04; KR-20 = 3/2 × (1 − .72/1.04) = 0.4615
    const m = [
      [1, 1, 1],
      [1, 1, 0],
      [1, 0, 1],
      [0, 1, 0],
      [0, 0, 0],
    ];
    expect(P.cronbachAlpha(m)).toBeCloseTo(0.4615, 4);
    expect(P.cronbachAlpha([[1, 1], [1, 1], [1, 1]])).toBeNull(); // no variance
    expect(P.cronbachAlpha([[1], [0], [1]])).toBeNull(); // one item
  });

  test('point-biserial is positive for a good item and negative for a miskeyed one', () => {
    const totals = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const good = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    const bad = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    expect(P.pointBiserial(good, totals.map((t, i) => t + good[i]))).toBeGreaterThan(0.7);
    expect(P.pointBiserial(bad, totals.map((t, i) => t + bad[i]))).toBeLessThan(-0.7);
    expect(P.pointBiserial([1, 1, 1], [3, 2, 1])).toBeNull(); // everyone right: undefined
  });

  test('upper/lower 27% discrimination', () => {
    const totals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const item = [0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1];
    expect(P.discrimination27(item, totals)).toBe(1); // top 3 all right, bottom 3 all wrong
  });

  test('histogram bins and flags', () => {
    const h = P.histogram([0, 5, 10, 55, 100], 10, 0, 100);
    expect(h[0].count).toBe(2);
    expect(h[1].count).toBe(1);
    expect(h[9].count).toBe(1); // 100 lands in the last bin
    const keys = (f) => f.map((x) => x.key);
    expect(keys(P.itemFlags({ n: 50, p: 0.95, rpb: 0.3 }))).toEqual(['too_easy']);
    expect(keys(P.itemFlags({ n: 50, p: 0.5, rpb: -0.2 }))).toEqual(['negative_discrimination']);
    expect(keys(P.itemFlags({ n: 15, p: 0.1, rpb: 0.1, unusedDistractors: ['D'] }))).toEqual(['low_sample', 'too_hard', 'weak_discrimination', 'unused_distractor']);
    expect(keys(P.itemFlags({ n: 3, p: 1, rpb: null }))).toEqual(['low_sample']);
    expect(P.reliabilityLabel(0.85, 100)).toBe('Good');
    expect(P.reliabilityLabel(0.85, 4)).toBe('Not enough data yet');
  });
});
