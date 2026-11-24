'use strict';

/**
 * Spreadsheet (xlsx / csv / zip) column specification — shared by the parser, the downloadable templates and the
 * xlsx export, so a file exported from the bank re-imports unchanged.
 */
const OPTION_COLUMNS = 'abcdefghijkl'.split('').map((l) => `option_${l}`);

const COLUMNS = [
  { key: 'type', aliases: ['question type', 'qtype'], help: 'single_choice, multiple_response, true_false, fill_blank, numeric, matching, ordering, hotspot, short_answer, essay, case_study (short forms: mcq, multi, tf, blank, num, match, order, short).' },
  { key: 'question', aliases: ['stem', 'question text', 'text'], help: 'The question text. Plain text or simple HTML. For fill-in-the-blank, mark blanks as [[1]], [[2]]…' },
  ...OPTION_COLUMNS.map((k, i) => ({ key: k, aliases: [`option ${k.slice(-1)}`, k.slice(-1)], help: i === 0 ? 'Options A–L (choice questions). Matching: “left => right”; a line without => is a distractor. Ordering: items in the CORRECT order. Hotspot: “label @ x,y,w,h” in % of the image.' : '' })),
  { key: 'answer', aliases: ['correct', 'correct answer', 'key'], help: 'MCQ: B · multiple response: A,C · true/false: TRUE or FALSE · numeric: 6 or 6 ± 0.1 · fill-in: answers per blank separated by ||, alternatives by | (e.g. 1521 | port 1521 || listener.ora) · short answer: keyword|synonym=weight; … · hotspot: the correct label or letter · essay: marking guide.' },
  { key: 'explanation', aliases: ['rationale', 'feedback'], help: 'Shown to candidates in review.' },
  { key: 'reference', aliases: ['source', 'ref'], help: 'Book, standard or URL.' },
  { key: 'marks', aliases: ['points', 'score'], help: 'Default 1.' },
  { key: 'difficulty', aliases: ['level'], help: '1–5, or very easy / easy / medium / hard / very hard. Default: the import default.' },
  { key: 'bloom', aliases: ['bloom level', 'blooms'], help: 'remember, understand, apply, analyze, evaluate, create.' },
  { key: 'category', aliases: ['category path'], help: 'Category name, slug or path like “Database > Oracle”. Default: the import default.' },
  { key: 'certification', aliases: ['cert', 'exam code'], help: 'Exam code (e.g. 1Z0-082) or certification name.' },
  { key: 'domain', aliases: ['objective', 'domain code'], help: 'Domain code (e.g. D2) or name within the certification.' },
  { key: 'topic', aliases: [], help: 'Free text.' },
  { key: 'tags', aliases: ['tag'], help: 'Comma-separated.' },
  { key: 'time_seconds', aliases: ['time', 'seconds', 'est_time_sec'], help: 'Estimated seconds to answer. Default 60.' },
  { key: 'units', aliases: ['unit'], help: 'Numeric: units shown to candidates.' },
  { key: 'select_exact', aliases: ['select exactly'], help: 'Multiple response: candidates must select exactly this many.' },
  { key: 'case_sensitive', aliases: [], help: 'Fill-in / short answer: TRUE to make matching case-sensitive.' },
  { key: 'threshold', aliases: [], help: 'Short answer: keyword score for full marks (default: total weight).' },
  { key: 'min_words', aliases: [], help: 'Essay: minimum words.' },
  { key: 'max_words', aliases: [], help: 'Essay: maximum words.' },
  { key: 'image', aliases: ['image file', 'hotspot image'], help: 'ZIP imports: file name in images/ (used by hotspot, or shown above the question).' },
  { key: 'case_id', aliases: ['case', 'group', 'scenario id'], help: 'Case studies: give the case_study row an id (e.g. CS1) and put the same id on each of its child questions.' },
];

const KEYS = COLUMNS.map((c) => c.key);

/** Maps a header cell to a column key ("Option A" → option_a, "Correct Answer" → answer). Unknown → null. */
function headerKey(header) {
  const h = String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!h) return null;
  for (const c of COLUMNS) {
    if (h === c.key.replace(/_/g, ' ') || c.aliases.includes(h)) return c.key;
  }
  const opt = /^(?:option|opt|choice)\s*([a-l])$/.exec(h);
  if (opt) return `option_${opt[1]}`;
  return null;
}

const TYPE_ALIASES = {
  single_choice: 'single_choice', mcq: 'single_choice', 'single choice': 'single_choice', single: 'single_choice', 'multiple choice': 'single_choice',
  multiple_response: 'multiple_response', multi: 'multiple_response', 'multiple response': 'multiple_response', mr: 'multiple_response', 'select all': 'multiple_response',
  true_false: 'true_false', tf: 'true_false', 'true false': 'true_false', 'true/false': 'true_false', boolean: 'true_false',
  fill_blank: 'fill_blank', blank: 'fill_blank', 'fill in the blank': 'fill_blank', 'fill blank': 'fill_blank', cloze: 'fill_blank',
  numeric: 'numeric', num: 'numeric', number: 'numeric', numerical: 'numeric',
  matching: 'matching', match: 'matching',
  ordering: 'ordering', order: 'ordering', sequence: 'ordering', sequencing: 'ordering',
  hotspot: 'hotspot',
  short_answer: 'short_answer', short: 'short_answer', 'short answer': 'short_answer',
  essay: 'essay', 'long answer': 'essay',
  case_study: 'case_study', case: 'case_study', scenario: 'case_study', 'case study': 'case_study',
};

function normaliseType(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return TYPE_ALIASES[v] || TYPE_ALIASES[v.replace(/ /g, '_')] || null;
}

module.exports = { COLUMNS, KEYS, OPTION_COLUMNS, headerKey, normaliseType, TYPE_ALIASES };
