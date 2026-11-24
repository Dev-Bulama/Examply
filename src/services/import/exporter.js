'use strict';

/**
 * Exports questions to xlsx (re-importable, same columns as the template), JSON (authoring models) and GIFT.
 * `items` = [{ question row, authoring, tags, children: [...] }]
 */
const ExcelJS = require('exceljs');
const { COLUMNS, OPTION_COLUMNS } = require('./columns');
const { toPlainText } = require('../../utils/html');

const LETTERS = 'ABCDEFGHIJKL';

/** Authoring model → spreadsheet record (inverse of rowMapper). */
function toRecord(a, meta) {
  const r = { type: a.type, question: a.stem_html, explanation: a.explanation_html || '', reference: a.reference || '', marks: a.marks, ...meta };
  const setOptions = (list) => list.forEach((v, i) => {
    r[OPTION_COLUMNS[i]] = v;
  });
  switch (a.type) {
    case 'single_choice':
    case 'multiple_response':
      setOptions(a.options.map((o) => o.text));
      r.answer = a.options.map((o, i) => (o.correct ? LETTERS[i] : null)).filter(Boolean).join(',');
      if (a.select_exact) r.select_exact = a.select_exact;
      break;
    case 'true_false':
      r.answer = a.correct ? 'TRUE' : 'FALSE';
      break;
    case 'fill_blank':
      r.answer = a.blanks.map((b) => b.variants.join(' | ')).join(' || ');
      r.case_sensitive = a.case_sensitive ? 'TRUE' : '';
      break;
    case 'numeric':
      r.answer = a.tolerance ? `${a.value} ± ${a.tolerance}` : String(a.value);
      r.units = a.units || '';
      break;
    case 'matching':
      setOptions([...a.pairs.map((p) => `${p.left} => ${p.right}`), ...a.distractors]);
      break;
    case 'ordering':
      setOptions(a.items);
      break;
    case 'hotspot':
      setOptions(a.regions.map((g) => `${g.label} @ ${g.x},${g.y},${g.w},${g.h}`));
      r.answer = (a.regions.find((g) => g.correct) || {}).label || '';
      r.image = `${a.image}.png`;
      break;
    case 'short_answer':
      r.answer = a.keywords.map((k) => `${k.terms.join('|')}=${k.weight}`).join('; ');
      r.threshold = a.threshold;
      r.case_sensitive = a.case_sensitive ? 'TRUE' : '';
      break;
    case 'sql':
      r.answer = a.solution_sql;
      r.sql_mode = a.mode;
      r.schema_sql = a.schema_sql;
      r.seed_sql = a.seed_sql;
      r.starter_sql = a.starter_sql || '';
      r.check_sql = a.check_sql || '';
      r.order_matters = a.order_matters ? 'TRUE' : '';
      r.column_names_matter = a.column_names_matter ? 'TRUE' : '';
      r.tolerance = a.numeric_tolerance || '';
      break;
    case 'essay':
      r.answer = a.rubric_html || '';
      r.min_words = a.min_words ?? '';
      r.max_words = a.max_words ?? '';
      break;
    default:
      break;
  }
  return r;
}

async function toXlsx(items) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Skillscore Assess';
  const ws = wb.addWorksheet('Questions');
  ws.addRow(COLUMNS.map((c) => c.key));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  let caseNo = 0;
  for (const it of items) {
    const caseId = it.authoring.type === 'case_study' ? `CS${(caseNo += 1)}` : '';
    const rec = toRecord(it.authoring, it.meta);
    if (caseId) rec.case_id = caseId;
    ws.addRow(COLUMNS.map((c) => rec[c.key] ?? ''));
    for (const child of it.children || []) {
      const cr = toRecord(child.authoring, child.meta);
      cr.case_id = caseId;
      ws.addRow(COLUMNS.map((c) => cr[c.key] ?? ''));
    }
  }
  ws.getColumn(2).width = 60;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toJsonExport(items) {
  const one = (it) => ({ ...it.authoring, ...it.meta, tags: it.meta.tags ? it.meta.tags.split(',').map((t) => t.trim()).filter(Boolean) : [], ...(it.children && it.children.length ? { children: it.children.map(one) } : {}) });
  return Buffer.from(JSON.stringify({ exported_at: new Date().toISOString(), questions: items.map(one) }, null, 2));
}

const giftEsc = (s) => String(s).replace(/([~=#{}:\\])/g, '\\$1');
const giftText = (html) => giftEsc(toPlainText(html));

function toGift(items) {
  const out = ['// Exported from Skillscore Assess', ''];
  const skipped = [];
  const emit = (it, n) => {
    const a = it.authoring;
    const title = `::Q${n}::`;
    const stem = giftText(a.stem_html);
    const fb = a.explanation_html ? ` #### ${giftText(a.explanation_html)}` : '';
    switch (a.type) {
      case 'single_choice':
        out.push(`${title} ${stem} {${a.options.map((o) => `${o.correct ? '=' : '~'}${giftEsc(o.text)}${o.feedback ? ` #${giftEsc(o.feedback)}` : ''}`).join(' ')}${fb}}`);
        break;
      case 'multiple_response': {
        const right = a.options.filter((o) => o.correct).length;
        const wrong = a.options.length - right;
        const pos = Math.floor((100 / right) * 100000) / 100000;
        const neg = wrong ? -Math.floor((100 / wrong) * 100000) / 100000 : 0;
        out.push(`${title} ${stem} {${a.options.map((o) => `~%${o.correct ? pos : neg}%${giftEsc(o.text)}`).join(' ')}${fb}}`);
        break;
      }
      case 'true_false':
        out.push(`${title} ${stem} {${a.correct ? 'TRUE' : 'FALSE'}${fb}}`);
        break;
      case 'numeric':
        out.push(`${title} ${stem} {#${a.value}${a.tolerance ? `:${a.tolerance}` : ''}${fb}}`);
        break;
      case 'matching':
        out.push(`${title} ${stem} {${a.pairs.map((p) => `=${giftEsc(p.left)} -> ${giftEsc(p.right)}`).join(' ')}${fb}}`);
        break;
      case 'fill_blank':
        if (a.blanks.length !== 1) {
          skipped.push(`Q${n} (fill-in with ${a.blanks.length} blanks)`);
          return;
        }
        out.push(`${title} ${giftText(a.stem_html.replace('[[1]]', ' {BLANK} ')).replace('\\{BLANK\\}', `{${a.blanks[0].variants.map((v) => `=${giftEsc(v)}`).join(' ')}}`)}`);
        break;
      case 'essay':
        out.push(`${title} ${stem} {${fb}}`);
        break;
      default:
        skipped.push(`Q${n} (${a.type.replace('_', ' ')} has no GIFT equivalent)`);
        return;
    }
    out.push('');
  };
  let n = 0;
  for (const it of items) {
    if (it.authoring.type === 'case_study') {
      skipped.push(`case study #${it.id} (exported its child questions only)`);
      for (const c of it.children || []) emit(c, (n += 1));
    } else emit(it, (n += 1));
  }
  if (skipped.length) out.splice(1, 0, `// Not exported (no GIFT equivalent): ${skipped.join('; ')}`);
  return Buffer.from(out.join('\n'));
}

module.exports = { toRecord, toXlsx, toJsonExport, toGift };
