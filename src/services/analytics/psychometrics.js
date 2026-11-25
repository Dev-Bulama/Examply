'use strict';

/**
 * Classical test theory — pure functions (unit-tested).
 *
 *   difficulty(scores01)                      p-value: proportion correct
 *   pointBiserial(itemScores01, totals)       correlation of the item (0/1) with the rest-of-test score
 *   discrimination27(itemScores01, totals)    p(upper 27%) − p(lower 27%)
 *   cronbachAlpha(matrix)                     matrix[person][item] in 0..1; equals KR-20 when every item is 0/1
 *   histogram(values, bins, min, max)         counts per equal-width bin
 */

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const variance = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length; // population variance
};
const round = (x, dp = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : null);

function difficulty(scores) {
  return scores.length ? round(mean(scores)) : null;
}

/** Point-biserial against the total WITHOUT this item (so the item does not correlate with itself). */
function pointBiserial(item, totals) {
  const n = item.length;
  if (n < 3) return null;
  const rest = totals.map((t, i) => t - item[i]);
  const p = mean(item);
  if (p === 0 || p === 1) return null;
  const sd = Math.sqrt(variance(rest));
  if (!sd) return null;
  const m1 = mean(rest.filter((_, i) => item[i] >= 0.5));
  const m0 = mean(rest.filter((_, i) => item[i] < 0.5));
  return round(((m1 - m0) / sd) * Math.sqrt(p * (1 - p)));
}

/** Upper/lower 27% method on the total score. */
function discrimination27(item, totals) {
  const n = item.length;
  if (n < 4) return null;
  const k = Math.max(1, Math.round(n * 0.27));
  const order = totals.map((t, i) => [t, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = order.slice(0, k).map(([, i]) => item[i]);
  const upper = order.slice(-k).map(([, i]) => item[i]);
  return round(mean(upper) - mean(lower));
}

/** Cronbach's alpha. With dichotomous (0/1) items this is exactly KR-20. */
function cronbachAlpha(matrix) {
  const people = matrix.length;
  const k = people ? matrix[0].length : 0;
  if (people < 3 || k < 2) return null;
  const totals = matrix.map((row) => row.reduce((s, x) => s + x, 0));
  const totalVar = variance(totals);
  if (!totalVar) return null;
  let itemVar = 0;
  for (let j = 0; j < k; j += 1) itemVar += variance(matrix.map((row) => row[j]));
  return round((k / (k - 1)) * (1 - itemVar / totalVar));
}

function histogram(values, bins = 10, min = 0, max = 100) {
  const out = Array.from({ length: bins }, (_, i) => ({ from: round(min + ((max - min) * i) / bins, 2), to: round(min + ((max - min) * (i + 1)) / bins, 2), count: 0 }));
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const i = Math.min(bins - 1, Math.max(0, Math.floor(((v - min) / (max - min)) * bins)));
    out[i].count += 1;
  }
  return out;
}

/** Plain-language flags for an item. */
function itemFlags({ n, p, rpb, unusedDistractors = [] }) {
  const flags = [];
  if (n < 10) return [{ key: 'low_sample', label: `Only ${n} response${n === 1 ? '' : 's'} — statistics appear from 10` }];
  if (n < 20) flags.push({ key: 'low_sample', label: 'Fewer than 20 responses — treat with care' });
  if (p !== null && p > 0.9) flags.push({ key: 'too_easy', label: 'Too easy (p > 0.90)' });
  if (p !== null && p < 0.2) flags.push({ key: 'too_hard', label: 'Too hard (p < 0.20)' });
  if (rpb !== null && rpb < 0) flags.push({ key: 'negative_discrimination', label: 'Negative discrimination — check the answer key' });
  else if (rpb !== null && rpb < 0.15) flags.push({ key: 'weak_discrimination', label: 'Weak discrimination (r < 0.15)' });
  if (unusedDistractors.length) flags.push({ key: 'unused_distractor', label: `Distractor nobody picks: ${unusedDistractors.join(', ')}` });
  return flags;
}

/** Reliability in words (common rule of thumb). */
function reliabilityLabel(alpha, n = Infinity) {
  if (alpha === null || alpha === undefined || n < 10) return 'Not enough data yet';
  if (alpha >= 0.9) return 'Excellent';
  if (alpha >= 0.8) return 'Good';
  if (alpha >= 0.7) return 'Acceptable';
  if (alpha >= 0.6) return 'Questionable';
  return 'Poor';
}

module.exports = { mean, variance, difficulty, pointBiserial, discrimination27, cronbachAlpha, histogram, itemFlags, reliabilityLabel, round };
