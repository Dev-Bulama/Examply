'use strict';

/**
 * Combines marked items into the attempt result (pure). PROMPT §4 rules:
 *  - the total is never below 0; round to 2 dp; percentage = score ÷ max score;
 *  - pass requires the overall pass mark AND every section minimum;
 *  - while any item awaits manual grading, the pass decision is deferred (passed = null).
 *
 * items: [{ marksPossible, awarded, status, sectionId, sectionTitle, domainKey, domainLabel, difficulty, type }]
 * ctx:   { passMark, passMarkType: 'percent'|'raw', sections: [{ id, title, min_score_percent }], bands, scaling }
 */
const { round2 } = require('./strategies');

const pct = (a, b) => (b > 0 ? round2((a / b) * 100) : 0);

function groupBy(items, keyFn, labelFn) {
  const map = new Map();
  for (const it of items) {
    const key = keyFn(it);
    if (!map.has(key)) map.set(key, { key, label: labelFn(it), score: 0, max: 0, count: 0, correct: 0, pending: 0 });
    const g = map.get(key);
    g.max += it.marksPossible;
    g.count += 1;
    if (it.status === 'pending_manual') g.pending += 1;
    else {
      g.score += it.awarded || 0;
      if (it.correct) g.correct += 1;
    }
  }
  return [...map.values()].map((g) => ({ ...g, score: round2(Math.max(0, g.score)), max: round2(g.max), percent: pct(Math.max(0, g.score), g.max) }));
}

function bandFor(percent, bands) {
  const b = (bands || []).find((x) => percent >= Number(x.min_percent) - 1e-9 && percent <= Number(x.max_percent) + 1e-9);
  return b ? b.name : null;
}

function scoreAttempt(items, ctx) {
  const graded = items.filter((i) => i.status !== 'pending_manual');
  const pending = items.length - graded.length;
  const max = round2(items.reduce((s, i) => s + i.marksPossible, 0));
  const raw = round2(Math.max(0, graded.reduce((s, i) => s + (i.awarded || 0), 0)));
  const percent = pct(raw, max);

  const sections = groupBy(items, (i) => i.sectionId || 0, (i) => i.sectionTitle || 'General');
  const sectionMins = [];
  for (const sec of ctx.sections || []) {
    if (sec.min_score_percent === null || sec.min_score_percent === undefined) continue;
    const g = sections.find((s) => s.key === sec.id);
    const met = !!g && g.percent >= Number(sec.min_score_percent) - 1e-9;
    sectionMins.push({ section: sec.title, min: Number(sec.min_score_percent), percent: g ? g.percent : 0, met });
  }

  let passed = null;
  const hasPassMark = ctx.passMark !== null && ctx.passMark !== undefined && ctx.passMark !== '';
  if (!pending && hasPassMark) {
    const overall = ctx.passMarkType === 'raw' ? raw >= Number(ctx.passMark) - 1e-9 : percent >= Number(ctx.passMark) - 1e-9;
    passed = overall && sectionMins.every((s) => s.met);
  }

  let scaled = null;
  if (ctx.scaling && ctx.scaling.enabled) scaled = Math.round(Number(ctx.scaling.min) + (percent / 100) * (Number(ctx.scaling.max) - Number(ctx.scaling.min)));

  return {
    raw,
    max,
    percent,
    scaled,
    passed,
    band: pending ? null : bandFor(percent, ctx.bands),
    pending,
    answered: items.filter((i) => !i.unanswered).length,
    correct: graded.filter((i) => i.correct).length,
    sections,
    sectionMins,
    domains: groupBy(items.filter((i) => i.domainKey), (i) => i.domainKey, (i) => i.domainLabel),
    difficulty: groupBy(items, (i) => i.difficulty || 3, (i) => ['Very easy', 'Easy', 'Medium', 'Hard', 'Very hard'][(i.difficulty || 3) - 1]).sort((a, b) => a.key - b.key),
    types: groupBy(items, (i) => i.type, (i) => i.type),
  };
}

/** Percentile rank: share of other results strictly below, plus half of the ties (0–100). */
function percentileRank(percent, others) {
  if (!others.length) return null;
  let below = 0;
  let equal = 0;
  for (const p of others) {
    if (p < percent - 1e-9) below += 1;
    else if (Math.abs(p - percent) <= 1e-9) equal += 1;
  }
  return round2(((below + equal / 2) / others.length) * 100);
}

module.exports = { scoreAttempt, percentileRank, bandFor };
