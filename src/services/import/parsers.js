'use strict';

/**
 * File parsers. Every parser returns { records, fileErrors, images } where each record is:
 *   { rowNumber, rowRef, source (original cells/text, for the error report), question, meta, caseId, parentCaseId,
 *     image, errors[], warnings[] }
 * `images` maps a file name to { buffer } (ZIP bundles and Word documents).
 */
const path = require('path');
const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const { headerKey, normaliseType, OPTION_COLUMNS } = require('./columns');
const { mapRecord, textToHtml, parseDifficulty } = require('./rowMapper');
const { toPlainText } = require('../../utils/html');

const MAX_ROWS = 10000;
const LETTERS = 'ABCDEFGHIJKL';

class ImportFileError extends Error {}

// ---------------------------------------------------------------- Spreadsheets (xlsx / csv)

function recordsFromTable(rows, { sheetName = null, firstRowNumber = 1 } = {}) {
  const out = { records: [], fileErrors: [] };
  if (!rows.length) return out;
  const header = rows[0].map(headerKey);
  if (!header.includes('question') && !header.includes('type')) {
    out.fileErrors.push(`${sheetName ? `Sheet “${sheetName}”: ` : ''}no “question” or “type” column found in the first row. Download the template to see the expected headers.`);
    return out;
  }
  const unknown = rows[0].filter((h, i) => String(h || '').trim() && !header[i]);
  if (unknown.length) out.fileErrors.push(`${sheetName ? `Sheet “${sheetName}”: ` : ''}ignored unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;
    const rec = {};
    header.forEach((k, i) => {
      if (k) rec[k] = cells[i] === undefined || cells[i] === null ? '' : String(cells[i]);
    });
    const rowNumber = firstRowNumber + r;
    out.records.push({ rowNumber, rowRef: sheetName ? `${sheetName} row ${rowNumber}` : `Row ${rowNumber}`, source: rec, ...mapRecord(rec) });
    if (out.records.length > MAX_ROWS) throw new ImportFileError(`The file has more than ${MAX_ROWS} questions. Split it into smaller files.`);
  }
  return out;
}

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw new ImportFileError(`This is not a valid Excel (.xlsx) file: ${err.message}`);
  }
  const sheets = wb.worksheets.filter((ws) => !/^(instructions|readme|help)$/i.test(ws.name.trim()));
  const result = { records: [], fileErrors: [], images: new Map() };
  const multi = sheets.filter((ws) => ws.actualRowCount > 1).length > 1;
  for (const ws of sheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells = [];
      for (let c = 1; c <= ws.columnCount; c += 1) cells.push(cellText(row.getCell(c)));
      rows[n - 1] = cells;
    });
    const dense = Array.from({ length: rows.length }, (_, i) => rows[i] || []);
    if (dense.length < 2) continue;
    const r = recordsFromTable(dense, { sheetName: multi ? ws.name : null });
    result.records.push(...r.records);
    result.fileErrors.push(...r.fileErrors);
  }
  if (!result.records.length && !result.fileErrors.length) result.fileErrors.push('No questions found. The first row must be the header row (see the template).');
  return result;
}

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  let rows;
  try {
    rows = parseCsv(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: false });
  } catch (err) {
    throw new ImportFileError(`The CSV file could not be read: ${err.message}`);
  }
  const r = recordsFromTable(rows);
  return { ...r, images: new Map() };
}

// ---------------------------------------------------------------- JSON

/**
 * JSON: an array (or { "questions": [...] }) of authoring models plus classification fields:
 *   { "type": "single_choice", "stem_html": "...", "options": [{ "text": "...", "correct": true }], "explanation_html": "...",
 *     "category": "Database > Oracle", "certification": "1Z0-082", "domain": "SQL", "difficulty": 3, "tags": ["sql"],
 *     "children": [ … ] (case studies) }
 * A plain "question"/"stem"/"text" string is accepted for stem_html.
 */
function parseJsonBuffer(buffer) {
  let data;
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  try {
    data = JSON.parse(text);
  } catch (err) {
    const pos = /position (\d+)/.exec(err.message);
    const lc = /line (\d+)/.exec(err.message);
    const line = pos ? text.slice(0, Number(pos[1])).split('\n').length : lc ? Number(lc[1]) : null;
    throw new ImportFileError(`The JSON is not valid${line ? ` (around line ${line})` : ''}: ${err.message}`);
  }
  const list = Array.isArray(data) ? data : Array.isArray(data.questions) ? data.questions : null;
  if (!list) throw new ImportFileError('The JSON must be an array of questions, or an object with a "questions" array.');
  const records = [];
  let caseSeq = 0;
  const one = (item, idx, parentCaseId = null, label = null) => {
    const errors = [];
    const warnings = [];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      records.push({ rowNumber: idx + 1, rowRef: label || `Question ${idx + 1}`, source: { raw: JSON.stringify(item).slice(0, 500) }, question: {}, meta: {}, errors: ['Each question must be an object.'], warnings });
      return;
    }
    const type = normaliseType(item.type);
    if (!type) errors.push(item.type ? `Unknown question type “${item.type}”.` : 'Missing "type".');
    const question = { ...item, type };
    const stemText = item.stem_html ?? item.question ?? item.stem ?? item.text ?? '';
    question.stem_html = textToHtml(stemText);
    question.explanation_html = textToHtml(item.explanation_html ?? item.explanation ?? '');
    for (const k of ['children', 'category', 'certification', 'domain', 'topic', 'tags', 'difficulty', 'bloom', 'bloom_level', 'est_time_sec', 'time_seconds', 'question', 'stem', 'text', 'explanation']) delete question[k];
    const difficulty = parseDifficulty(item.difficulty);
    if (difficulty === undefined) errors.push(`Difficulty “${item.difficulty}” must be 1–5.`);
    const caseId = type === 'case_study' ? `json-case-${(caseSeq += 1)}` : null;
    records.push({
      rowNumber: idx + 1,
      rowRef: label || `Question ${idx + 1}`,
      source: { json: JSON.stringify(item).slice(0, 2000) },
      question,
      meta: {
        category: item.category || '',
        certification: item.certification || '',
        domain: item.domain || '',
        topic: item.topic || '',
        tags: Array.isArray(item.tags) ? item.tags.join(', ') : item.tags || '',
        difficulty: difficulty || null,
        bloom: item.bloom || item.bloom_level || null,
        est_time_sec: Number(item.est_time_sec || item.time_seconds) || null,
      },
      caseId,
      parentCaseId,
      image: item.image_file || null,
      errors,
      warnings,
    });
    if (type === 'case_study') (item.children || []).forEach((child, j) => one(child, idx, caseId, `Question ${idx + 1}.${j + 1}`));
  };
  list.forEach((item, i) => one(item, i));
  if (records.length > MAX_ROWS) throw new ImportFileError(`The file has more than ${MAX_ROWS} questions. Split it into smaller files.`);
  return { records, fileErrors: [], images: new Map() };
}

// ---------------------------------------------------------------- Aiken

/**
 * Aiken (Moodle) — one question per block:
 *   What is 2 + 2?
 *   A. 3
 *   B. 4
 *   ANSWER: B
 */
function parseAiken(buffer) {
  const lines = buffer.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const records = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (!cur.answer) cur.errors.push('Missing “ANSWER:” line.');
    const rec = { type: 'single_choice', question: cur.stem.join('\n'), answer: cur.answer || '' };
    cur.options.forEach((o, i) => {
      rec[OPTION_COLUMNS[i]] = o;
    });
    const mapped = mapRecord(rec);
    records.push({ rowNumber: cur.line, rowRef: `Line ${cur.line}`, source: { text: cur.raw.join('\n') }, ...mapped, errors: [...cur.errors, ...mapped.errors.filter((e) => !/answer column is empty/.test(e))] });
    cur = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) {
      if (cur && cur.answer) flush();
      return;
    }
    if (!cur) cur = { line: i + 1, stem: [], options: [], answer: null, errors: [], raw: [] };
    cur.raw.push(raw);
    const opt = /^([A-L])[.)]\s+(.*)$/.exec(line);
    const ans = /^ANSWER\s*:\s*([A-L])\s*$/i.exec(line);
    if (ans) {
      cur.answer = ans[1].toUpperCase();
      flush();
    } else if (opt && (cur.options.length || cur.stem.length)) {
      if (LETTERS[cur.options.length] !== opt[1]) cur.errors.push(`Option “${opt[1]}” is out of sequence (expected ${LETTERS[cur.options.length]}).`);
      cur.options.push(opt[2]);
    } else if (cur.options.length) {
      cur.options[cur.options.length - 1] += ` ${line}`;
    } else cur.stem.push(line);
  });
  flush();
  if (!records.length) throw new ImportFileError('No Aiken questions found. Each question needs lettered options (A. …) and an “ANSWER: X” line.');
  return { records, fileErrors: [], images: new Map() };
}

// ---------------------------------------------------------------- GIFT

const GIFT_ESC = { '\\~': '\u0001', '\\=': '\u0002', '\\#': '\u0003', '\\{': '\u0004', '\\}': '\u0005', '\\:': '\u0006', '\\n': '\n' };
const unesc = (s) => s.replace(/\u0001/g, '~').replace(/\u0002/g, '=').replace(/\u0003/g, '#').replace(/\u0004/g, '{').replace(/\u0005/g, '}').replace(/\u0006/g, ':');

function giftText(s) {
  return unesc(String(s).replace(/^\[(html|moodle|plain|markdown)\]/i, '')).trim();
}

/** Splits "=a #fb ~b ~%50%c" into answer entries. */
function giftAnswers(body) {
  const out = [];
  const re = /([=~])(%-?[\d.]+%)?([^=~]*)/g;
  let m;
  while ((m = re.exec(body))) {
    const [text, feedback] = m[3].split('#');
    out.push({ sign: m[1], weight: m[2] ? Number(m[2].replace(/%/g, '')) : null, text: giftText(text || ''), feedback: feedback ? giftText(feedback) : '' });
  }
  return out;
}

/**
 * GIFT (Moodle): multiple choice {=right ~wrong}, multiple response {~%50%a ~%50%b ~%-100%c}, true/false {T} {F},
 * short answer / fill-in {=a =b}, numeric {#5:0.1} {#4..6}, matching {=a -> 1 =b -> 2}, essay {}. Supports ::title::,
 * // comments, $CATEGORY: lines and escaped characters (\~ \= \# \{ \} \:).
 */
function parseGift(buffer) {
  let text = buffer.toString('utf8').replace(/^﻿/, '');
  for (const [k, v] of Object.entries(GIFT_ESC)) text = text.split(k).join(v);
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = [];
  let start = 1;
  let category = '';
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    const cat = /^\s*\$CATEGORY:\s*(.+)$/.exec(line);
    if (cat) {
      category = cat[1].replace(/^\$(course|system|module)\$\//, '').replace(/\//g, ' > ').trim();
      return;
    }
    if (!line.trim()) {
      if (cur.length) blocks.push({ text: cur.join('\n'), line: start, category });
      cur = [];
      return;
    }
    if (!cur.length) start = i + 1;
    cur.push(line);
  });
  if (cur.length) blocks.push({ text: cur.join('\n'), line: start, category });

  const records = [];
  for (const b of blocks) {
    const errors = [];
    const warnings = [];
    let body = b.text.replace(/^\s*::(.*?)::/, '').trim();
    const open = body.indexOf('{');
    const close = body.lastIndexOf('}');
    let q = { type: null };
    if (open < 0 || close < open) {
      errors.push('No answer block { … } found.');
      records.push({ rowNumber: b.line, rowRef: `Line ${b.line}`, source: { text: unesc(b.text) }, question: { type: null, stem_html: textToHtml(giftText(body)) }, meta: { category: b.category }, errors, warnings });
      continue;
    }
    const before = giftText(body.slice(0, open));
    const after = giftText(body.slice(close + 1));
    const inner = body.slice(open + 1, close).trim();
    const stemWith = (mid) => textToHtml([before, mid, after].filter(Boolean).join(' '));
    let explanation = '';
    const general = /####(.*)$/s.exec(inner);
    const ans = general ? inner.slice(0, general.index) : inner;
    if (general) explanation = giftText(general[1]);

    if (!ans.trim()) {
      q = { type: 'essay', stem_html: stemWith(''), marks: 10 };
    } else if (/^(T|TRUE|F|FALSE)\b/i.test(ans.trim())) {
      q = { type: 'true_false', stem_html: stemWith(''), correct: /^T/i.test(ans.trim()) };
    } else if (ans.trim().startsWith('#')) {
      const n = ans.trim().slice(1).split(/[=~]/)[0].trim() || ans.trim().slice(2);
      const range = /^(-?[\d.]+)\.\.(-?[\d.]+)/.exec(n);
      const tol = /^(-?[\d.]+)(?::([\d.]+))?/.exec(n);
      if (range) q = { type: 'numeric', stem_html: stemWith(''), value: (Number(range[1]) + Number(range[2])) / 2, tolerance: Math.abs(Number(range[2]) - Number(range[1])) / 2 };
      else if (tol) q = { type: 'numeric', stem_html: stemWith(''), value: Number(tol[1]), tolerance: tol[2] ? Number(tol[2]) : 0 };
      else errors.push(`Numeric answer “${unesc(n)}” is not a number.`);
    } else {
      const entries = giftAnswers(ans);
      if (entries.some((e) => /->/.test(e.text))) {
        q = { type: 'matching', stem_html: stemWith(''), pairs: [], distractors: [] };
        for (const e of entries) {
          const [l, r] = e.text.split('->').map((x) => x.trim());
          if (l) q.pairs.push({ left: l, right: r || '' });
          else if (r) q.distractors.push(r);
        }
      } else if (entries.every((e) => e.sign === '=') && entries.length) {
        q = { type: 'fill_blank', stem_html: stemWith('[[1]]'), blanks: [{ variants: entries.map((e) => e.text).filter(Boolean) }], case_sensitive: false, trim_whitespace: true };
        if (!after && before) warnings.push('Short-answer question imported as a fill-in-the-blank with the blank at the end.');
      } else {
        const positives = entries.filter((e) => e.sign === '=' || (e.weight !== null && e.weight > 0));
        const multi = positives.length > 1 || entries.some((e) => e.weight !== null && e.weight > 0 && e.weight < 100);
        q = {
          type: multi ? 'multiple_response' : 'single_choice',
          stem_html: stemWith(''),
          options: entries.map((e) => ({ text: e.text, correct: e.sign === '=' || (e.weight !== null && e.weight > 0), feedback: e.feedback })),
        };
      }
    }
    if (explanation) q.explanation_html = textToHtml(explanation);
    records.push({ rowNumber: b.line, rowRef: `Line ${b.line}`, source: { text: unesc(b.text) }, question: q, meta: { category: b.category }, errors, warnings: [...warnings, ...(explanation ? [] : ['No explanation — candidates will see only the correct answer in review.'])] });
  }
  if (!records.length) throw new ImportFileError('No GIFT questions found.');
  return { records, fileErrors: [], images: new Map() };
}

// ---------------------------------------------------------------- Word (.docx)

/**
 * Word documents written to this pattern (one question after another):
 *   1. Which clause filters groups?            (or "Q1." / "Question 1:")
 *   A. WHERE
 *   B. HAVING
 *   Answer: B                                   (A,C for several; True/False; a number with Type: numeric)
 *   Explanation: HAVING runs after GROUP BY.    (optional, may continue over several paragraphs)
 *   Type: / Difficulty: / Category: / Certification: / Domain: / Tags: / Topic:   (optional lines)
 * Images in a question are imported with it.
 */
async function parseDocx(buffer) {
  const images = new Map();
  let n = 0;
  let html;
  try {
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          n += 1;
          const ext = (image.contentType || 'image/png').split('/')[1].replace('jpeg', 'jpg');
          const name = `docx-image-${n}.${ext}`;
          images.set(name, { buffer: Buffer.from(await image.read('base64'), 'base64') });
          return { src: `images/${name}` };
        }),
      },
    );
    html = result.value;
  } catch (err) {
    throw new ImportFileError(`This is not a readable Word (.docx) file: ${err.message}`);
  }
  const paras = [...html.matchAll(/<(p|h\d|li|pre)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]);
  const records = [];
  let cur = null;
  let field = 'question';
  const META = { type: 'type', difficulty: 'difficulty', category: 'category', certification: 'certification', domain: 'domain', tags: 'tags', topic: 'topic', marks: 'marks', units: 'units', reference: 'reference' };
  const flush = () => {
    if (!cur) return;
    const rec = { ...cur.meta, question: cur.question.join('\n\n'), answer: cur.answer, explanation: cur.explanation.join('\n\n') };
    cur.options.forEach((o, i) => {
      rec[OPTION_COLUMNS[i]] = o;
    });
    if (!rec.type) {
      const a = String(cur.answer || '').trim();
      if (/^(true|false)$/i.test(a) && cur.options.length <= 2) rec.type = 'true_false';
      else if (/^[A-L](\s*[,;&]\s*[A-L])+$/i.test(a)) rec.type = 'multiple_response';
      else if (cur.options.length) rec.type = 'single_choice';
      else if (/^-?[\d.,]+(\s*(±|\+\/-)\s*[\d.,]+)?$/.test(a)) rec.type = 'numeric';
      else rec.type = 'essay';
    }
    records.push({ rowNumber: cur.number, rowRef: `Question ${cur.number}`, source: { text: toPlainText(rec.question).slice(0, 500) }, ...mapRecord(rec) });
    cur = null;
  };
  for (const p of paras) {
    const text = toPlainText(p);
    const qStart = /^(?:Q(?:uestion)?\s*)?(\d{1,4})\s*[.):]\s*(.*)$/i.exec(text);
    const opt = /^\(?([A-La-l])[.)]\s+(.*)$/.exec(text);
    const ans = /^(?:Answer|Ans|Correct(?:\s+answer)?)\s*[:\-–]\s*(.+)$/i.exec(text);
    const exp = /^(?:Explanation|Rationale)\s*[:\-–]\s*(.*)$/i.exec(text);
    const meta = /^(Type|Difficulty|Category|Certification|Domain|Tags|Topic|Marks|Units|Reference)\s*:\s*(.+)$/i.exec(text);
    if (qStart && (!cur || cur.answer !== null || field !== 'question' || !cur.question.length)) {
      flush();
      const rest = p.replace(/^\s*(?:<[^>]+>\s*)*(?:Q(?:uestion)?\s*)?\d{1,4}\s*[.):]\s*/i, '');
      cur = { number: Number(qStart[1]), question: [rest || qStart[2]], options: [], answer: null, explanation: [], meta: {} };
      field = 'question';
    } else if (!cur) {
      continue;
    } else if (opt && cur.answer === null && (field === 'question' || field === 'options')) {
      cur.options.push(opt[2]);
      field = 'options';
    } else if (ans) {
      cur.answer = ans[1].trim();
      field = 'answer';
    } else if (exp) {
      cur.explanation.push(exp[1]);
      field = 'explanation';
    } else if (meta) {
      cur.meta[META[meta[1].toLowerCase()]] = meta[2].trim();
    } else if (field === 'question') cur.question.push(p);
    else if (field === 'options') cur.options[cur.options.length - 1] += ` ${text}`;
    else if (field === 'explanation') cur.explanation.push(p);
  }
  flush();
  if (!records.length) throw new ImportFileError('No questions found. Number each question (1. …), letter the options (A. …) and add an “Answer:” line.');
  return { records, fileErrors: [], images };
}

// ---------------------------------------------------------------- ZIP bundle

/** A ZIP containing one questions file (.xlsx, .csv or .json) and an images/ folder. */
async function parseZip(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new ImportFileError(`This is not a valid ZIP file: ${err.message}`);
  }
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.)/.test(e.entryName));
  let total = 0;
  for (const e of entries) {
    total += e.header.size;
    if (total > 200 * 1024 * 1024) throw new ImportFileError('The ZIP expands to more than 200 MB.');
  }
  const sheet = entries.find((e) => /\.(xlsx|csv|json)$/i.test(e.entryName));
  if (!sheet) throw new ImportFileError('The ZIP must contain a questions file (.xlsx, .csv or .json) next to an images/ folder.');
  const ext = path.extname(sheet.entryName).slice(1).toLowerCase();
  const data = sheet.getData();
  const parsed = ext === 'xlsx' ? await parseXlsx(data) : ext === 'csv' ? parseCsvBuffer(data) : parseJsonBuffer(data);
  const images = new Map();
  for (const e of entries) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(e.entryName)) images.set(path.basename(e.entryName).toLowerCase(), { buffer: e.getData() });
  }
  return { ...parsed, images };
}

// ---------------------------------------------------------------- Detection & dispatch

function detectFormat(originalName, buffer) {
  const ext = path.extname(originalName || '').toLowerCase();
  const head = buffer.slice(0, 4);
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (ext === '.xlsx' && isZip) return 'xlsx';
  if (ext === '.docx' && isZip) return 'docx';
  if (ext === '.zip' && isZip) return 'zip';
  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  if (ext === '.gift') return 'gift';
  if (ext === '.txt') {
    const t = buffer.toString('utf8', 0, Math.min(buffer.length, 20000));
    if (/\{[^}]*[=~#][^}]*\}|::.*::|\{\s*(T|F|TRUE|FALSE)\s*\}/i.test(t)) return 'gift';
    if (/^ANSWER\s*:\s*[A-L]\s*$/im.test(t)) return 'aiken';
    return 'aiken';
  }
  if (isZip) {
    const names = new AdmZip(buffer).getEntries().map((e) => e.entryName);
    if (names.includes('word/document.xml')) return 'docx';
    if (names.includes('xl/workbook.xml')) return 'xlsx';
    return 'zip';
  }
  return null;
}

async function parseFile(format, buffer) {
  switch (format) {
    case 'xlsx':
      return parseXlsx(buffer);
    case 'csv':
      return parseCsvBuffer(buffer);
    case 'json':
      return parseJsonBuffer(buffer);
    case 'aiken':
      return parseAiken(buffer);
    case 'gift':
      return parseGift(buffer);
    case 'docx':
      return parseDocx(buffer);
    case 'zip':
      return parseZip(buffer);
    default:
      throw new ImportFileError('Unsupported file format.');
  }
}

module.exports = { parseFile, detectFormat, ImportFileError, parseXlsx, parseCsvBuffer, parseJsonBuffer, parseAiken, parseGift, parseDocx, parseZip, MAX_ROWS };
