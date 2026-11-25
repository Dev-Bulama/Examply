'use strict';

/**
 * Question type registry — the single definition of every question type.
 *
 * AUTHORING MODEL (what the editor posts, what JSON import accepts, what export produces):
 *   common: { type, stem_html, explanation_html, reference, marks }
 *   single_choice      { options: [{ text, correct, feedback, pin_last }] }
 *   multiple_response  { options: [...same], select_exact: null | n }
 *   true_false         { correct: true|false, feedback_true, feedback_false }
 *   fill_blank         { blanks: [{ variants: [string] }], case_sensitive, trim_whitespace }   stem contains [[1]], [[2]]…
 *   numeric            { value, tolerance, units }
 *   matching           { pairs: [{ left, right }], distractors: [string] }
 *   ordering           { items: [string] }            (in the correct order)
 *   hotspot            { image: mediaUuid, regions: [{ label, x, y, w, h, correct }] }   (percentages of the image)
 *   short_answer       { keywords: [{ terms: [string], weight }], threshold, case_sensitive }
 *   essay              { min_words, max_words, rubric_html }
 *   case_study         {}                              (children are separate questions with parent_id)
 *   sql                { mode: 'query'|'modify', schema_sql, seed_sql, starter_sql, solution_sql, check_sql,
 *                        order_matters, column_names_matter, numeric_tolerance }   (SQLite dialect, see services/sql)
 *
 * Short texts (options, items, variants) use "inline markup": `code` and \( maths \).
 *
 * STORED FORM (question_versions + question_options + question_answers):
 *   options[{ option_key, content_html, feedback_html, is_correct, pin_last, side, region, display_order }]
 *   answer (JSON) — the marking key; settings (JSON) — type options shown to the candidate.
 */
const crypto = require('crypto');
const labScenario = require('../labs/scenario');
const { sanitizeRich, toPlainText } = require('../../utils/html');
const { inlineToHtml, htmlToInline } = require('../../utils/inline');

const TYPES = {
  single_choice: { label: 'Single choice (MCQ)', short: 'MCQ', auto: true },
  multiple_response: { label: 'Multiple response', short: 'Multi', auto: true },
  true_false: { label: 'True / False', short: 'T/F', auto: true },
  fill_blank: { label: 'Fill in the blank', short: 'Blank', auto: true },
  numeric: { label: 'Numeric', short: 'Numeric', auto: true },
  matching: { label: 'Matching', short: 'Match', auto: true },
  ordering: { label: 'Ordering / sequencing', short: 'Order', auto: true },
  hotspot: { label: 'Hotspot (labelled regions)', short: 'Hotspot', auto: true },
  short_answer: { label: 'Short answer (keywords)', short: 'Short', auto: true },
  essay: { label: 'Essay (manual grading)', short: 'Essay', auto: false },
  case_study: { label: 'Case study / scenario group', short: 'Case', auto: false },
  sql: { label: 'SQL lab (write and run a query)', short: 'SQL', auto: true },
  lab: { label: 'Cyber security lab (live terminal)', short: 'Lab', auto: true },
};
const TYPE_KEYS = Object.keys(TYPES);
const BLOOM = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_OPTIONS = 12;

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'yes';
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const blankCount = (html) => {
  const nums = [...String(html || '').matchAll(/\[\[(\d{1,2})\]\]/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
};
const sqlText = (v) => (v === undefined || v === null ? '' : String(v)).replace(/\r\n/g, '\n').trim().slice(0, 200000);
const blankNumbers = (html) => [...String(html || '').matchAll(/\[\[(\d{1,2})\]\]/g)].map((m) => Number(m[1]));

/** Normalises loosely-typed input (form JSON or import rows) into a clean authoring model. */
function normalise(input) {
  const a = input || {};
  const type = str(a.type);
  const base = {
    type,
    stem_html: sanitizeRich(a.stem_html),
    explanation_html: sanitizeRich(a.explanation_html),
    reference: str(a.reference).slice(0, 500),
    marks: num(a.marks) === null ? 1 : num(a.marks),
  };
  switch (type) {
    case 'single_choice':
    case 'multiple_response':
      return {
        ...base,
        options: list(a.options).map((o) => ({ text: str(o.text), correct: bool(o.correct), feedback: str(o.feedback), pin_last: bool(o.pin_last) })),
        ...(type === 'multiple_response' ? { select_exact: num(a.select_exact) } : {}),
      };
    case 'true_false':
      return { ...base, correct: a.correct === undefined || a.correct === null || a.correct === '' ? null : bool(a.correct), feedback_true: str(a.feedback_true), feedback_false: str(a.feedback_false) };
    case 'fill_blank':
      return {
        ...base,
        blanks: list(a.blanks).map((b) => ({ variants: list(b && b.variants !== undefined ? b.variants : b).map(str).filter(Boolean) })),
        case_sensitive: bool(a.case_sensitive),
        trim_whitespace: a.trim_whitespace === undefined ? true : bool(a.trim_whitespace),
      };
    case 'numeric':
      return { ...base, value: num(a.value), tolerance: num(a.tolerance) === null ? 0 : num(a.tolerance), units: str(a.units).slice(0, 40) };
    case 'matching':
      return { ...base, pairs: list(a.pairs).map((p) => ({ left: str(p.left), right: str(p.right) })), distractors: list(a.distractors).map(str).filter(Boolean) };
    case 'ordering':
      return { ...base, items: list(a.items).map(str) };
    case 'hotspot':
      return {
        ...base,
        image: str(a.image),
        regions: list(a.regions).map((r) => ({ label: str(r.label), x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h), correct: bool(r.correct) })),
      };
    case 'short_answer':
      return {
        ...base,
        keywords: list(a.keywords).map((k) => ({ terms: list(k.terms).map(str).filter(Boolean), weight: num(k.weight) })),
        threshold: num(a.threshold),
        case_sensitive: bool(a.case_sensitive),
      };
    case 'essay':
      return { ...base, min_words: num(a.min_words), max_words: num(a.max_words), rubric_html: sanitizeRich(a.rubric_html) };
    case 'case_study':
      return { ...base, marks: 0 };
    case 'sql':
      return {
        ...base,
        mode: str(a.mode) === 'modify' ? 'modify' : 'query',
        schema_sql: sqlText(a.schema_sql),
        seed_sql: sqlText(a.seed_sql),
        starter_sql: sqlText(a.starter_sql),
        solution_sql: sqlText(a.solution_sql),
        check_sql: sqlText(a.check_sql),
        order_matters: bool(a.order_matters),
        column_names_matter: bool(a.column_names_matter),
        numeric_tolerance: num(a.numeric_tolerance) === null ? 0 : num(a.numeric_tolerance),
      };
    case 'lab': {
      let scenario = a.scenario;
      if (typeof scenario === 'string') {
        try {
          scenario = JSON.parse(scenario);
        } catch {
          scenario = { __invalid: String(a.scenario).slice(0, 200000) };
        }
      }
      scenario = scenario && typeof scenario === 'object' ? scenario : {};
      return { ...base, scenario, marks: scenario.__invalid ? 1 : labScenario.totalMarks(scenario) || 1 };
    }
    default:
      return base;
  }
}

/**
 * Validates a normalised authoring model. Returns [{ field, message }] — empty when valid.
 * Messages are written for humans and reused verbatim in import dry-run reports.
 */
function validate(q) {
  const errs = [];
  const add = (field, message) => errs.push({ field, message });
  if (!TYPES[q.type]) {
    add('type', `Unknown question type "${q.type}". Use one of: ${TYPE_KEYS.join(', ')}.`);
    return errs;
  }
  if (!toPlainText(q.stem_html) && !/<img/i.test(q.stem_html)) add('stem_html', 'The question text (stem) is empty.');
  if (q.type !== 'case_study' && (q.marks === null || q.marks <= 0 || q.marks > 1000)) add('marks', 'Marks must be greater than 0 and at most 1000.');

  const optionChecks = (min) => {
    const opts = q.options || [];
    if (opts.length < min) add('options', `Add at least ${min} options.`);
    if (opts.length > MAX_OPTIONS) add('options', `Use at most ${MAX_OPTIONS} options.`);
    opts.forEach((o, i) => {
      if (!o.text) add(`options.${i}`, `Option ${LETTERS[i]} is empty.`);
    });
    const texts = opts.map((o) => o.text.toLowerCase()).filter(Boolean);
    if (new Set(texts).size !== texts.length) add('options', 'Two options have the same text.');
    if (opts.filter((o) => o.pin_last).length > 1) add('options', 'Only one option can be pinned last.');
    return opts;
  };

  switch (q.type) {
    case 'single_choice': {
      const opts = optionChecks(2);
      const n = opts.filter((o) => o.correct).length;
      if (n !== 1) add('options', n === 0 ? 'Mark the correct option.' : 'A single-choice question must have exactly one correct option.');
      break;
    }
    case 'multiple_response': {
      const opts = optionChecks(3);
      const n = opts.filter((o) => o.correct).length;
      if (n < 1) add('options', 'Mark at least one correct option.');
      if (n === opts.length && opts.length) add('options', 'At least one option must be incorrect.');
      if (q.select_exact !== null && q.select_exact !== undefined) {
        if (!Number.isInteger(q.select_exact) || q.select_exact < 1) add('select_exact', '“Select exactly” must be a whole number of 1 or more.');
        else if (q.select_exact !== n) add('select_exact', `“Select exactly ${q.select_exact}” does not match the ${n} correct option${n === 1 ? '' : 's'}.`);
      }
      break;
    }
    case 'true_false':
      if (q.correct === null) add('correct', 'Choose whether the statement is True or False.');
      break;
    case 'fill_blank': {
      const nums = blankNumbers(q.stem_html);
      const count = blankCount(q.stem_html);
      if (!count) add('stem_html', 'Add at least one blank to the question text, written as [[1]], [[2]]…');
      else {
        for (let i = 1; i <= count; i += 1) if (!nums.includes(i)) add('stem_html', `Blank [[${i}]] is missing from the question text (blanks must be numbered 1, 2, 3… without gaps).`);
        if (new Set(nums).size !== nums.length) add('stem_html', 'Each blank number can appear only once in the question text.');
      }
      if (q.blanks.length !== count) add('blanks', `The question text has ${count} blank${count === 1 ? '' : 's'} but ${q.blanks.length} answer${q.blanks.length === 1 ? ' is' : 's are'} defined.`);
      q.blanks.forEach((b, i) => {
        if (!b.variants.length) add(`blanks.${i}`, `Blank ${i + 1} needs at least one accepted answer.`);
      });
      break;
    }
    case 'numeric':
      if (q.value === null) add('value', 'Enter the correct numeric answer.');
      if (q.tolerance === null || q.tolerance < 0) add('tolerance', 'Tolerance must be 0 or a positive number.');
      break;
    case 'matching': {
      if (q.pairs.length < 2) add('pairs', 'Add at least 2 pairs.');
      if (q.pairs.length + q.distractors.length > MAX_OPTIONS * 2) add('pairs', 'Too many items.');
      q.pairs.forEach((p, i) => {
        if (!p.left || !p.right) add(`pairs.${i}`, `Pair ${i + 1} needs both a left and a right item.`);
      });
      const lefts = q.pairs.map((p) => p.left.toLowerCase());
      if (new Set(lefts).size !== lefts.length) add('pairs', 'Two left-hand items are identical.');
      const rights = [...q.pairs.map((p) => p.right), ...q.distractors].map((r) => r.toLowerCase());
      if (new Set(rights).size !== rights.length) add('pairs', 'Two right-hand items (including distractors) are identical.');
      break;
    }
    case 'ordering':
      if (q.items.length < 2) add('items', 'Add at least 2 items to order.');
      if (q.items.length > MAX_OPTIONS) add('items', `Use at most ${MAX_OPTIONS} items.`);
      q.items.forEach((t, i) => {
        if (!t) add(`items.${i}`, `Item ${i + 1} is empty.`);
      });
      if (new Set(q.items.map((t) => t.toLowerCase())).size !== q.items.length) add('items', 'Two items are identical.');
      break;
    case 'hotspot': {
      if (!/^[0-9a-f-]{36}$/.test(q.image)) add('image', 'Upload the image candidates will click on.');
      if (q.regions.length < 2) add('regions', 'Draw at least 2 labelled regions.');
      q.regions.forEach((r, i) => {
        if (!r.label) add(`regions.${i}`, `Region ${i + 1} needs a label.`);
        const ok = [r.x, r.y, r.w, r.h].every((v) => v !== null && v >= 0 && v <= 100) && r.w > 0 && r.h > 0 && r.x + r.w <= 100.5 && r.y + r.h <= 100.5;
        if (!ok) add(`regions.${i}`, `Region ${i + 1} must lie inside the image.`);
      });
      const n = q.regions.filter((r) => r.correct).length;
      if (n !== 1) add('regions', 'Mark exactly one region as correct.');
      break;
    }
    case 'short_answer': {
      if (!q.keywords.length) add('keywords', 'Add at least one keyword.');
      q.keywords.forEach((k, i) => {
        if (!k.terms.length) add(`keywords.${i}`, `Keyword ${i + 1} is empty.`);
        if (k.weight === null || k.weight <= 0) add(`keywords.${i}`, `Keyword ${i + 1} needs a weight greater than 0.`);
      });
      const total = q.keywords.reduce((s, k) => s + (k.weight || 0), 0);
      if (q.threshold === null || q.threshold <= 0) add('threshold', 'Set the keyword score needed for full marks.');
      else if (q.threshold > total) add('threshold', `The threshold (${q.threshold}) is higher than the total keyword weight (${total}), so full marks could never be reached.`);
      break;
    }
    case 'lab':
      if (q.scenario.__invalid !== undefined) add('scenario', 'The scenario is not valid JSON.');
      else labScenario.validate(q.scenario).forEach((e) => add(e.field, e.message));
      if (JSON.stringify(q.scenario).length > 200000) add('scenario', 'The scenario is too large (200,000 characters at most).');
      break;
    case 'sql':
      if (!q.schema_sql) add('schema_sql', 'Add the dataset schema (CREATE TABLE statements).');
      if (!q.solution_sql) add('solution_sql', 'Add the model solution query.');
      if (q.mode === 'modify' && !q.check_sql) add('check_sql', 'In “modify” mode, add a check query that reads the changed data.');
      if (q.numeric_tolerance === null || q.numeric_tolerance < 0) add('numeric_tolerance', 'Numeric tolerance must be 0 or a positive number.');
      if (q.schema_sql.length + q.seed_sql.length > 200000) add('seed_sql', 'The dataset is too large (200,000 characters at most).');
      break;
    case 'essay':
      if (q.min_words !== null && q.min_words < 0) add('min_words', 'Minimum words cannot be negative.');
      if (q.max_words !== null && q.max_words < 1) add('max_words', 'Maximum words must be at least 1.');
      if (q.min_words !== null && q.max_words !== null && q.min_words > q.max_words) add('max_words', 'Maximum words must be greater than the minimum.');
      break;
    default:
      break;
  }
  return errs;
}

/** Converts a valid authoring model into stored rows. */
function toStored(q) {
  const settings = {};
  const options = [];
  let answer = {};
  const opt = (key, text, extra = {}) => options.push({ option_key: key, content_html: inlineToHtml(text), feedback_html: extra.feedback ? inlineToHtml(extra.feedback) : null, is_correct: !!extra.correct, pin_last: !!extra.pin_last, side: extra.side || null, region: extra.region || null, display_order: options.length });

  switch (q.type) {
    case 'single_choice':
    case 'multiple_response':
      q.options.forEach((o, i) => opt(LETTERS[i], o.text, o));
      answer = { correct: q.options.map((o, i) => (o.correct ? LETTERS[i] : null)).filter(Boolean) };
      if (q.type === 'multiple_response' && q.select_exact) settings.select_exact = q.select_exact;
      break;
    case 'true_false':
      opt('T', 'True', { correct: q.correct === true, feedback: q.feedback_true });
      opt('F', 'False', { correct: q.correct === false, feedback: q.feedback_false });
      answer = { correct: [q.correct ? 'T' : 'F'] };
      break;
    case 'fill_blank':
      settings.blanks = q.blanks.length;
      settings.case_sensitive = q.case_sensitive;
      settings.trim_whitespace = q.trim_whitespace;
      answer = { blanks: q.blanks.map((b) => ({ variants: b.variants })) };
      break;
    case 'numeric':
      settings.units = q.units || null;
      answer = { value: q.value, tolerance: q.tolerance };
      break;
    case 'matching':
      q.pairs.forEach((p, i) => opt(`L${i + 1}`, p.left, { side: 'left' }));
      q.pairs.forEach((p, i) => opt(`R${i + 1}`, p.right, { side: 'right' }));
      q.distractors.forEach((d, i) => opt(`R${q.pairs.length + i + 1}`, d, { side: 'right' }));
      answer = { pairs: q.pairs.map((p, i) => [`L${i + 1}`, `R${i + 1}`]) };
      break;
    case 'ordering':
      q.items.forEach((t, i) => opt(`I${i + 1}`, t));
      answer = { order: q.items.map((t, i) => `I${i + 1}`) };
      break;
    case 'hotspot':
      settings.image = q.image;
      q.regions.forEach((r, i) => opt(`H${i + 1}`, r.label, { correct: r.correct, region: { x: r.x, y: r.y, w: r.w, h: r.h } }));
      answer = { correct: q.regions.map((r, i) => (r.correct ? `H${i + 1}` : null)).filter(Boolean) };
      break;
    case 'short_answer':
      settings.case_sensitive = q.case_sensitive;
      answer = { keywords: q.keywords, threshold: q.threshold };
      break;
    case 'essay':
      settings.min_words = q.min_words;
      settings.max_words = q.max_words;
      answer = { rubric_html: q.rubric_html || '' };
      break;
    case 'lab':
      settings.brief = labScenario.candidateBrief(q.scenario);
      answer = { scenario: q.scenario };
      break;
    case 'sql':
      settings.dialect = 'sqlite';
      settings.mode = q.mode;
      settings.schema_sql = q.schema_sql;
      settings.seed_sql = q.seed_sql;
      settings.starter_sql = q.starter_sql;
      answer = { solution_sql: q.solution_sql, check_sql: q.check_sql, order_matters: q.order_matters, column_names_matter: q.column_names_matter, numeric_tolerance: q.numeric_tolerance };
      break;
    default:
      break;
  }
  return { stem_html: q.stem_html, stem_text: toPlainText(q.stem_html).slice(0, 60000), explanation_html: q.explanation_html || null, reference: q.reference || null, marks: q.marks, settings, options, answer };
}

/**
 * Duplicate-detection hash: type + normalised stem text + sorted normalised option/answer texts.
 * Formatting, option order and letter case do not change it.
 */
function contentHash(q) {
  const norm = (s) => toPlainText(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const parts = [];
  switch (q.type) {
    case 'single_choice':
    case 'multiple_response':
      parts.push(...q.options.map((o) => norm(o.text)));
      break;
    case 'matching':
      parts.push(...q.pairs.map((p) => `${norm(p.left)}=${norm(p.right)}`));
      break;
    case 'ordering':
      parts.push(...q.items.map(norm));
      break;
    case 'hotspot':
      parts.push(...q.regions.map((r) => norm(r.label)));
      break;
    case 'numeric':
      parts.push(String(q.value));
      break;
    case 'lab':
      parts.push(JSON.stringify({ t: q.scenario.title, tasks: (q.scenario.tasks || []).map((t) => t.check) }));
      break;
    case 'sql':
      parts.push(String(q.solution_sql).toLowerCase().replace(/\s+/g, ' ').trim());
      break;
    default:
      break;
  }
  return crypto.createHash('sha256').update([q.type, norm(q.stem_html), ...parts.sort()].join('␟')).digest('hex');
}

/** Rebuilds the authoring model from stored rows (used when the stored authoring JSON is absent). */
function fromStored(version, options, answer, settings) {
  const base = { type: version.type, stem_html: version.stem_html, explanation_html: version.explanation_html || '', reference: version.reference || '', marks: Number(version.marks) };
  const byKey = (k) => options.find((o) => o.option_key === k);
  const text = (o) => (o ? htmlToInline(o.content_html) : '');
  switch (version.type) {
    case 'single_choice':
    case 'multiple_response':
      return { ...base, options: options.map((o) => ({ text: text(o), correct: !!o.is_correct, feedback: o.feedback_html ? htmlToInline(o.feedback_html) : '', pin_last: !!o.pin_last })), ...(version.type === 'multiple_response' ? { select_exact: settings.select_exact || null } : {}) };
    case 'true_false':
      return { ...base, correct: (answer.correct || [])[0] === 'T', feedback_true: htmlToInline(byKey('T')?.feedback_html || ''), feedback_false: htmlToInline(byKey('F')?.feedback_html || '') };
    case 'fill_blank':
      return { ...base, blanks: answer.blanks || [], case_sensitive: !!settings.case_sensitive, trim_whitespace: settings.trim_whitespace !== false };
    case 'numeric':
      return { ...base, value: answer.value, tolerance: answer.tolerance || 0, units: settings.units || '' };
    case 'matching': {
      const pairs = (answer.pairs || []).map(([l, r]) => ({ left: text(byKey(l)), right: text(byKey(r)) }));
      const used = new Set((answer.pairs || []).map((p) => p[1]));
      return { ...base, pairs, distractors: options.filter((o) => o.side === 'right' && !used.has(o.option_key)).map(text) };
    }
    case 'ordering':
      return { ...base, items: (answer.order || []).map((k) => text(byKey(k))) };
    case 'hotspot':
      return { ...base, image: settings.image || '', regions: options.map((o) => ({ label: text(o), ...(o.region || {}), correct: !!o.is_correct })) };
    case 'short_answer':
      return { ...base, keywords: answer.keywords || [], threshold: answer.threshold, case_sensitive: !!settings.case_sensitive };
    case 'essay':
      return { ...base, min_words: settings.min_words ?? null, max_words: settings.max_words ?? null, rubric_html: answer.rubric_html || '' };
    case 'lab':
      return { ...base, scenario: answer.scenario || {} };
    case 'sql':
      return { ...base, mode: settings.mode || 'query', schema_sql: settings.schema_sql || '', seed_sql: settings.seed_sql || '', starter_sql: settings.starter_sql || '', solution_sql: answer.solution_sql || '', check_sql: answer.check_sql || '', order_matters: !!answer.order_matters, column_names_matter: !!answer.column_names_matter, numeric_tolerance: answer.numeric_tolerance || 0 };
    default:
      return base;
  }
}

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * What a candidate is allowed to see: NO correctness flags, NO answer key, NO feedback.
 * `optionOrder` (array of option keys) applies a per-attempt shuffle; pinned options stay last.
 */
function candidateView(version, options, settings, { optionOrder = null, shuffleOptions = false, rng } = {}) {
  const view = { type: version.type, stem_html: version.stem_html, marks: Number(version.marks), settings: {} };
  const clean = (o) => ({ key: o.option_key, html: o.content_html });
  const order = (opts) => {
    if (optionOrder) return optionOrder.map((k) => opts.find((o) => o.option_key === k)).filter(Boolean);
    if (!shuffleOptions) return opts;
    const pinned = opts.filter((o) => o.pin_last);
    return [...shuffle(opts.filter((o) => !o.pin_last), rng), ...pinned];
  };
  switch (version.type) {
    case 'single_choice':
    case 'multiple_response':
    case 'true_false':
      view.options = order(options).map(clean);
      if (settings.select_exact) view.settings.select_exact = settings.select_exact;
      break;
    case 'fill_blank':
      view.settings.blanks = settings.blanks;
      break;
    case 'numeric':
      view.settings.units = settings.units || null;
      break;
    case 'matching':
      view.left = options.filter((o) => o.side === 'left').map(clean);
      view.right = (optionOrder ? order(options.filter((o) => o.side === 'right')) : shuffle(options.filter((o) => o.side === 'right'), rng)).map(clean);
      break;
    case 'ordering':
      view.items = (optionOrder ? order(options) : shuffle(options, rng)).map(clean);
      break;
    case 'hotspot':
      view.settings.image = settings.image;
      view.regions = options.map((o) => ({ key: o.option_key, label: o.content_html, region: o.region }));
      break;
    case 'essay':
      view.settings.min_words = settings.min_words ?? null;
      view.settings.max_words = settings.max_words ?? null;
      break;
    case 'lab':
      // Brief and task list only — never the checks, flags or the machine's files.
      view.settings.brief = settings.brief || { tasks: [] };
      break;
    case 'sql':
      // The schema DDL and starter code only — never the seed rows' expected output, the solution or the check query.
      view.settings.mode = settings.mode || 'query';
      view.settings.schema_sql = settings.schema_sql || '';
      view.settings.starter_sql = settings.starter_sql || '';
      break;
    default:
      break;
  }
  return view;
}

/** A blank authoring model for the editor. */
function emptyAuthoring(type) {
  const base = { type, stem_html: '', explanation_html: '', reference: '', marks: 1 };
  switch (type) {
    case 'single_choice':
      return { ...base, options: [0, 1, 2, 3].map(() => ({ text: '', correct: false, feedback: '', pin_last: false })) };
    case 'multiple_response':
      return { ...base, options: [0, 1, 2, 3].map(() => ({ text: '', correct: false, feedback: '', pin_last: false })), select_exact: null };
    case 'true_false':
      return { ...base, correct: null, feedback_true: '', feedback_false: '' };
    case 'fill_blank':
      return { ...base, blanks: [{ variants: [] }], case_sensitive: false, trim_whitespace: true };
    case 'numeric':
      return { ...base, value: null, tolerance: 0, units: '' };
    case 'matching':
      return { ...base, pairs: [{ left: '', right: '' }, { left: '', right: '' }, { left: '', right: '' }], distractors: [] };
    case 'ordering':
      return { ...base, items: ['', '', ''] };
    case 'hotspot':
      return { ...base, image: '', regions: [] };
    case 'short_answer':
      return { ...base, keywords: [{ terms: [], weight: 1 }], threshold: 1, case_sensitive: false };
    case 'essay':
      return { ...base, marks: 10, min_words: null, max_words: null, rubric_html: '' };
    case 'case_study':
      return { ...base, marks: 0 };
    case 'lab':
      return {
        ...base,
        scenario: {
          title: 'Lab title',
          hostname: 'web01',
          user: 'analyst',
          intro: 'Describe the situation the candidate is in.',
          users: { analyst: { groups: ['analyst', 'sudo'] } },
          files: {},
          services: {},
          tasks: [{ id: 'task1', title: 'Describe the first task', marks: 1, check: { type: 'flag_submitted', flag: 'FLAG{example}' } }],
        },
      };
    case 'sql':
      return { ...base, marks: 2, mode: 'query', schema_sql: '', seed_sql: '', starter_sql: '', solution_sql: '', check_sql: '', order_matters: false, column_names_matter: false, numeric_tolerance: 0 };
    default:
      return base;
  }
}

module.exports = { TYPES, TYPE_KEYS, BLOOM, LETTERS, normalise, validate, toStored, fromStored, contentHash, candidateView, emptyAuthoring, shuffle, blankCount };
