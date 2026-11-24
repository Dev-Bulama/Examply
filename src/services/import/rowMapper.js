'use strict';

/**
 * Converts one spreadsheet record ({ column key: cell text }) into an ImportRecord:
 *   { question: <authoring model>, meta: { category, certification, domain, topic, tags, difficulty, bloom, est_time_sec },
 *     caseId, parentCaseId, image, errors: [string], warnings: [string] }
 * Error messages name the row and the exact problem, e.g. “Correct answer 'E' is not among options A–D.”
 */
const { OPTION_COLUMNS, normaliseType } = require('./columns');
const { escapeHtml } = require('../../utils/html');

const LETTERS = 'ABCDEFGHIJKL';
const DIFFICULTY_WORDS = { 'very easy': 1, easy: 2, medium: 3, moderate: 3, hard: 4, difficult: 4, 'very hard': 5, expert: 5 };
const truthy = (v) => /^(true|t|yes|y|1|correct)$/i.test(String(v || '').trim());
const falsy = (v) => /^(false|f|no|n|0|incorrect)$/i.test(String(v || '').trim());

/** Plain text becomes <p> paragraphs; text that already contains HTML tags is kept (sanitised later). */
function textToHtml(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (/<\/?(p|div|br|strong|em|b|i|code|pre|table|ul|ol|img|span|sup|sub)\b/i.test(s)) return s;
  return s
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function parseDifficulty(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^[1-5]$/.test(s)) return Number(s);
  return DIFFICULTY_WORDS[s] || undefined;
}

function letterRange(n) {
  return n <= 1 ? 'A' : `A–${LETTERS[n - 1]}`;
}

function mapRecord(rec) {
  const errors = [];
  const warnings = [];
  const get = (k) => (rec[k] === undefined || rec[k] === null ? '' : String(rec[k]).trim());
  const rawType = get('type');
  const type = normaliseType(rawType || (get('option_a') ? 'single_choice' : ''));
  if (!type) errors.push(rawType ? `Unknown question type “${rawType}”.` : 'The type column is empty.');

  const options = OPTION_COLUMNS.map((k) => get(k)).filter((v, i, arr) => v !== '' || arr.slice(i).some(Boolean));
  while (options.length && options[options.length - 1] === '') options.pop();
  const gaps = options.map((v, i) => (v === '' ? LETTERS[i] : null)).filter(Boolean);
  if (gaps.length) errors.push(`Option${gaps.length > 1 ? 's' : ''} ${gaps.join(', ')} ${gaps.length > 1 ? 'are' : 'is'} empty but later options are filled in.`);

  const answer = get('answer');
  const q = { type, stem_html: textToHtml(get('question')), explanation_html: textToHtml(get('explanation')), reference: get('reference') };
  const marksRaw = get('marks');
  if (marksRaw) {
    if (Number.isNaN(Number(marksRaw))) errors.push(`Marks “${marksRaw}” is not a number.`);
    else q.marks = Number(marksRaw);
  }

  const lettersFromAnswer = () => {
    const parts = answer
      .toUpperCase()
      .split(/[\s,;/&]+|\band\b/i)
      .map((p) => p.replace(/[^A-Z0-9]/g, ''))
      .filter(Boolean);
    return parts.map((p) => (/^\d+$/.test(p) ? LETTERS[Number(p) - 1] || p : p));
  };

  switch (type) {
    case 'single_choice':
    case 'multiple_response': {
      if (!answer) {
        errors.push('The answer column is empty — give the letter of the correct option.');
        q.options = options.map((text) => ({ text }));
        break;
      }
      const letters = lettersFromAnswer();
      const bad = letters.filter((l) => !/^[A-L]$/.test(l) || LETTERS.indexOf(l) >= options.length);
      if (bad.length) errors.push(`Correct answer ${bad.map((b) => `'${b}'`).join(', ')} ${bad.length > 1 ? 'are' : 'is'} not among options ${letterRange(options.length)}.`);
      q.options = options.map((text, i) => ({ text, correct: letters.includes(LETTERS[i]) }));
      if (type === 'single_choice' && letters.length > 1) warnings.push(`Several correct answers (${letters.join(', ')}) — imported as multiple response.`);
      if (type === 'single_choice' && letters.length > 1) q.type = 'multiple_response';
      if (get('select_exact')) q.select_exact = Number(get('select_exact'));
      break;
    }
    case 'true_false': {
      const a = answer || get('option_a');
      if (truthy(a)) q.correct = true;
      else if (falsy(a)) q.correct = false;
      else errors.push(`Answer “${answer}” must be TRUE or FALSE.`);
      break;
    }
    case 'fill_blank': {
      q.blanks = answer
        ? answer.split('||').map((b) => ({
            variants: b
              .split('|')
              .map((x) => x.trim())
              .filter(Boolean),
          }))
        : [];
      if (!answer) errors.push('The answer column is empty — list the accepted answers for each blank (blanks separated by ||, alternatives by |).');
      q.case_sensitive = truthy(get('case_sensitive'));
      q.trim_whitespace = true;
      if (!/\[\[\d+\]\]/.test(get('question')) && /_{3,}/.test(get('question'))) {
        // Convenience: "___" placeholders are numbered in order.
        let n = 0;
        q.stem_html = textToHtml(get('question').replace(/_{3,}/g, () => {
          n += 1;
          return `[[${n}]]`;
        }));
        warnings.push(n === 1 ? 'The underscore blank was converted to [[1]].' : `Underscore blanks were converted to [[1]]…[[${n}]].`);
      }
      break;
    }
    case 'numeric': {
      const m = /^\s*(-?[\d.,]+)\s*(?:(?:±|\+\/-|\+-|plus or minus)\s*([\d.,]+))?\s*$/i.exec(answer);
      if (!m) errors.push(answer ? `Numeric answer “${answer}” is not a number (use e.g. 6 or 6 ± 0.1).` : 'The answer column is empty — give the correct number.');
      else {
        q.value = Number(m[1].replace(/,/g, ''));
        q.tolerance = m[2] ? Number(m[2].replace(/,/g, '')) : 0;
      }
      q.units = get('units');
      break;
    }
    case 'matching': {
      q.pairs = [];
      q.distractors = [];
      options.forEach((o, i) => {
        const parts = o.split(/\s*(?:=>|->|→)\s*/);
        if (parts.length === 2 && parts[0] && parts[1]) q.pairs.push({ left: parts[0], right: parts[1] });
        else if (parts.length === 1 && o) q.distractors.push(o);
        else errors.push(`Option ${LETTERS[i]} “${o}” should look like “left => right”.`);
      });
      break;
    }
    case 'ordering':
      q.items = options;
      break;
    case 'hotspot': {
      q.image = '';
      q.regions = [];
      options.forEach((o, i) => {
        const m = /^(.*?)\s*@\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/.exec(o);
        if (!m) errors.push(`Option ${LETTERS[i]} “${o}” should look like “Label @ x,y,w,h” (percentages of the image).`);
        else q.regions.push({ label: m[1], x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]), correct: false });
      });
      const a = answer.trim();
      const idx = /^[A-L]$/i.test(a) ? LETTERS.indexOf(a.toUpperCase()) : q.regions.findIndex((r) => r.label.toLowerCase() === a.toLowerCase());
      if (idx < 0 || idx >= q.regions.length) errors.push(answer ? `Correct region “${answer}” is not one of the regions.` : 'The answer column is empty — give the correct region label or letter.');
      else q.regions[idx].correct = true;
      if (!get('image')) errors.push('Hotspot questions need an image file (use a ZIP import with an images/ folder).');
      break;
    }
    case 'short_answer': {
      q.keywords = [];
      if (!answer) errors.push('The answer column is empty — list keywords like “atomicity=1; consistency=1”.');
      for (const part of answer.split(/;|\n/).map((p) => p.trim()).filter(Boolean)) {
        const m = /^(.*?)(?:\s*=\s*([\d.]+))?$/.exec(part);
        q.keywords.push({ terms: m[1].split('|').map((t) => t.trim()).filter(Boolean), weight: m[2] ? Number(m[2]) : 1 });
      }
      const total = q.keywords.reduce((s, k) => s + k.weight, 0);
      q.threshold = get('threshold') ? Number(get('threshold')) : total;
      q.case_sensitive = truthy(get('case_sensitive'));
      break;
    }
    case 'essay':
      q.rubric_html = textToHtml(answer);
      q.min_words = get('min_words') ? Number(get('min_words')) : null;
      q.max_words = get('max_words') ? Number(get('max_words')) : null;
      if (!q.marks) q.marks = 10;
      break;
    case 'case_study':
      if (!get('case_id')) errors.push('A case_study row needs a case_id so its child questions can refer to it.');
      break;
    default:
      break;
  }

  const difficulty = parseDifficulty(get('difficulty'));
  if (difficulty === undefined) errors.push(`Difficulty “${get('difficulty')}” must be 1–5 or very easy / easy / medium / hard / very hard.`);
  const bloom = get('bloom').toLowerCase().replace('analyse', 'analyze');
  if (bloom && !['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'].includes(bloom)) warnings.push(`Bloom level “${get('bloom')}” is not recognised and was left empty.`);
  const time = get('time_seconds');
  if (time && (!/^\d+$/.test(time) || Number(time) < 5)) errors.push(`Time “${time}” must be a whole number of seconds (5 or more).`);
  if (type && type !== 'case_study' && !get('explanation')) warnings.push('No explanation — candidates will see only the correct answer in review.');

  return {
    question: q,
    meta: {
      category: get('category'),
      certification: get('certification'),
      domain: get('domain'),
      topic: get('topic'),
      tags: get('tags'),
      difficulty: difficulty || null,
      bloom: ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'].includes(bloom) ? bloom : null,
      est_time_sec: time && /^\d+$/.test(time) ? Number(time) : null,
    },
    caseId: type === 'case_study' ? get('case_id') : null,
    parentCaseId: type !== 'case_study' && get('case_id') ? get('case_id') : null,
    image: get('image') || null,
    errors,
    warnings,
  };
}

module.exports = { mapRecord, textToHtml, parseDifficulty };
