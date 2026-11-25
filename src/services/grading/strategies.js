'use strict';

/**
 * Marking strategies — one per question type, implementing PROMPT §4 exactly. Pure functions (except SQL, which
 * runs the candidate's query in the sandbox), so every rule is unit-tested.
 *
 *   markItem(item, response, policy) → Promise<{ awarded, correct, status, detail }>
 *     item    = { type, marks, answer, settings, options }        (from the question VERSION stored on the attempt)
 *     response = the candidate's saved response (shape per type, see below) or null
 *     policy  = { partialCredit: bool, negative: number }        (negative = marks deducted for a wrong answer)
 *
 * Response shapes:
 *   single_choice / true_false / hotspot  { selected: 'B' }
 *   multiple_response                     { selected: ['A', 'C'] }
 *   fill_blank                            { blanks: ['1521', 'listener.ora'] }
 *   numeric                               { value: '6.02' }
 *   matching                              { pairs: { L1: 'R2', L2: 'R1' } }
 *   ordering                              { order: ['I2', 'I1', 'I3'] }
 *   short_answer / essay                  { text: '…' }
 *   sql                                   { sql: 'SELECT …' }
 *
 * Rules shared by all types: unanswered = 0 and never negative; awarded is rounded to 2 dp.
 */
const sqlLab = require('../sql/lab');
const labScenario = require('../labs/scenario');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v));

const result = (awarded, correct, extra = {}) => ({ awarded: round2(awarded), correct, status: 'auto', detail: null, ...extra });
const unanswered = () => ({ awarded: 0, correct: false, status: 'auto', detail: { unanswered: true } });

function isAnswered(type, r) {
  if (!r || typeof r !== 'object') return false;
  switch (type) {
    case 'multiple_response':
      return Array.isArray(r.selected) && r.selected.length > 0;
    case 'single_choice':
    case 'true_false':
    case 'hotspot':
      return !!str(r.selected);
    case 'fill_blank':
      return Array.isArray(r.blanks) && r.blanks.some((b) => str(b).trim() !== '');
    case 'numeric':
      return str(r.value).trim() !== '' && !Number.isNaN(Number(str(r.value).replace(/,/g, '')));
    case 'matching':
      return !!r.pairs && Object.values(r.pairs).some((v) => !!str(v));
    case 'ordering':
      return Array.isArray(r.order) && r.order.length > 0;
    case 'short_answer':
    case 'essay':
      return str(r.text).trim() !== '';
    case 'sql':
      return str(r.sql).trim() !== '';
    case 'lab':
      return !!(r.lab && Array.isArray(r.lab.history) && r.lab.history.length);
    default:
      return false;
  }
}

function normaliseText(s, { caseSensitive = false, trim = true } = {}) {
  let v = str(s);
  if (trim) v = v.trim().replace(/\s+/g, ' ');
  return caseSensitive ? v : v.toLowerCase();
}

/** Length of the longest subsequence of `seq` that appears in the same relative order as in `correct`. */
function longestCorrectSubsequence(seq, correct) {
  const pos = seq.map((k) => correct.indexOf(k)).filter((p) => p >= 0);
  // Longest strictly increasing subsequence of positions (patience sorting, O(n log n)).
  const tails = [];
  for (const p of pos) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = p;
  }
  return tails.length;
}

/** Whole-word / whole-phrase match of a keyword in a text. */
function containsTerm(text, term, caseSensitive) {
  const t = normaliseText(term, { caseSensitive });
  if (!t) return false;
  const hay = normaliseText(text, { caseSensitive });
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu').test(hay);
}

const STRATEGIES = {
  single_choice(item, r, policy) {
    const key = (item.answer.correct || [])[0];
    const ok = str(r.selected) === key;
    return ok ? result(item.marks, true) : result(-policy.negative, false);
  },

  true_false(item, r, policy) {
    return STRATEGIES.single_choice(item, r, policy);
  },

  hotspot(item, r, policy) {
    return STRATEGIES.single_choice(item, r, policy);
  },

  multiple_response(item, r, policy) {
    const correct = new Set(item.answer.correct || []);
    const chosen = new Set((r.selected || []).map(str));
    let right = 0;
    let wrong = 0;
    for (const k of chosen) {
      if (correct.has(k)) right += 1;
      else wrong += 1;
    }
    if (right === correct.size && wrong === 0) return result(item.marks, true);
    let awarded = 0;
    if (policy.partialCredit && correct.size) awarded = Math.max(0, (right - wrong) / correct.size) * item.marks;
    // Negative marking applies only when the result is 0 and something was selected.
    if (awarded === 0 && chosen.size > 0) awarded = -policy.negative;
    return result(awarded, false, { detail: { right, wrong, of: correct.size } });
  },

  fill_blank(item, r, policy) {
    const blanks = item.answer.blanks || [];
    const opts = { caseSensitive: !!item.settings.case_sensitive, trim: item.settings.trim_whitespace !== false };
    const given = r.blanks || [];
    const hits = blanks.map((b, i) => (b.variants || []).some((v) => normaliseText(v, opts) === normaliseText(given[i], opts)));
    const n = hits.filter(Boolean).length;
    if (blanks.length && n === blanks.length) return result(item.marks, true, { detail: { blanks: hits } });
    if (n === 0) return result(-policy.negative, false, { detail: { blanks: hits } }); // all wrong → negative per question
    return result(policy.partialCredit ? (item.marks / blanks.length) * n : 0, false, { detail: { blanks: hits } });
  },

  numeric(item, r, policy) {
    const value = Number(str(r.value).replace(/,/g, '').trim());
    const ok = Math.abs(value - Number(item.answer.value)) <= Number(item.answer.tolerance || 0) + 1e-9;
    return ok ? result(item.marks, true) : result(-policy.negative, false);
  },

  matching(item, r, policy) {
    const pairs = item.answer.pairs || [];
    const given = r.pairs || {};
    const n = pairs.filter(([l, rt]) => str(given[l]) === rt).length;
    if (pairs.length && n === pairs.length) return result(item.marks, true, { detail: { correctPairs: n, of: pairs.length } });
    return result(policy.partialCredit && pairs.length ? (n / pairs.length) * item.marks : 0, false, { detail: { correctPairs: n, of: pairs.length } });
  },

  ordering(item, r, policy) {
    const correct = item.answer.order || [];
    const given = (r.order || []).map(str);
    const exact = given.length === correct.length && given.every((k, i) => k === correct[i]);
    if (exact) return result(item.marks, true);
    const lcs = longestCorrectSubsequence(given, correct);
    return result(policy.partialCredit && correct.length ? (lcs / correct.length) * item.marks : 0, false, { detail: { inOrder: lcs, of: correct.length } });
  },

  short_answer(item, r, policy) {
    const caseSensitive = !!item.settings.case_sensitive;
    let score = 0;
    const found = [];
    for (const k of item.answer.keywords || []) {
      if ((k.terms || []).some((t) => containsTerm(r.text, t, caseSensitive))) {
        score += Number(k.weight) || 0;
        found.push((k.terms || [])[0]);
      }
    }
    const threshold = Number(item.answer.threshold) || 0;
    if (threshold > 0 && score >= threshold) return result(item.marks, true, { detail: { score, threshold, found } });
    return result(policy.partialCredit ? Math.min(score, item.marks) : 0, false, { detail: { score, threshold, found } });
  },

  essay() {
    return { awarded: null, correct: null, status: 'pending_manual', detail: null };
  },

  /** Labs: each task's marks when its check passes on the candidate's final machine (task-based partial credit). */
  lab(item, r) {
    const g = labScenario.grade(item.answer.scenario || {}, r.lab);
    const scale = g.total > 0 ? item.marks / g.total : 0;
    return result(g.awarded * scale, g.allPassed, { detail: { tasks: g.tasks.map((t) => ({ id: t.id, title: t.title, marks: t.marks, passed: t.passed })) } });
  },

  async sql(item, r) {
    const spec = { ...item.settings, ...item.answer };
    const out = await sqlLab.check(spec, r.sql);
    // A broken model solution must not penalise the candidate: send it to manual review instead.
    if (out.error && /^solution:/.test(out.error)) return { awarded: null, correct: null, status: 'pending_manual', detail: { reason: out.reason } };
    return result(out.correct ? item.marks : 0, out.correct, { detail: { reason: out.reason } });
  },
};

/** Marks one item. Never throws for a bad response; unknown types go to manual grading. */
async function markItem(item, response, policy = { partialCredit: false, negative: 0 }) {
  const strategy = STRATEGIES[item.type];
  if (!strategy) return { awarded: null, correct: null, status: 'pending_manual', detail: null };
  if (item.type === 'essay') return strategy(item, response || {}, policy);
  if (!isAnswered(item.type, response)) return unanswered();
  return strategy({ ...item, marks: Number(item.marks), answer: item.answer || {}, settings: item.settings || {} }, response, { partialCredit: !!policy.partialCredit, negative: Number(policy.negative) || 0 });
}

module.exports = { markItem, isAnswered, longestCorrectSubsequence, containsTerm, normaliseText, round2, STRATEGIES };
