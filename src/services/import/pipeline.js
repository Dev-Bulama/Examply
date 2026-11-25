'use strict';

/**
 * Import pipeline (runs as background jobs):
 *   createImport → job import.parse  → rows stored with ✅/⚠️/❌ + duplicate flags   (status: parsed)
 *   confirmImport → job import.run   → batches of 100 rows, one transaction per batch, savepoint per row,
 *                                      resumable (re-enqueues itself after ~15 s)    (status: completed)
 *   undoImport (within 24 h)          → deletes created questions (retires those already answered), restores overwritten versions
 * AI generations (Phase 3) feed records into the same parse step, so they get the same preview and checks.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { db } = require('../../config/db');
const { storagePath } = require('../../config/paths');
const { getLogger } = require('../../config/logger');
const queue = require('../jobs/queue');
const repo = require('../questions/repository');
const types = require('../questions/types');
const sqlLab = require('../sql/lab');
const { sniff } = require('../uploads');
const { parseFile, detectFormat, ImportFileError } = require('./parsers');
const { toJson, parseJson } = require('../../utils/json');
const { slugify } = require('../../utils/slug');

const BATCH = 100;
const RUN_BUDGET_MS = 15000;
const UNDO_HOURS = 24;
const importsDir = () => storagePath('imports');

// ---------------------------------------------------------------- Create

async function createImport({ user, buffer, originalName, format, options, organisationId = null }) {
  const detected = format && format !== 'auto' ? format : detectFormat(originalName, buffer);
  if (!detected) throw new ImportFileError('The file type could not be recognised. Use .xlsx, .csv, .json, .txt (Aiken/GIFT), .gift, .docx or .zip.');
  const uuid = crypto.randomUUID();
  const ext = path.extname(originalName || '').toLowerCase().replace(/[^a-z.]/g, '') || `.${detected}`;
  fs.mkdirSync(importsDir(), { recursive: true });
  const stored = `${uuid}${ext}`;
  fs.writeFileSync(path.join(importsDir(), stored), buffer);
  const [id] = await db()('imports').insert({
    uuid,
    user_id: user.id,
    organisation_id: organisationId,
    original_name: String(originalName || stored).slice(0, 255),
    stored_path: stored,
    format: detected,
    source: 'file',
    status: 'uploaded',
    options: toJson(options),
    target_exam_id: options.exam_mode === 'attach' ? options.exam_id : null,
  });
  await queue.enqueue('import.parse', { importId: id }, { maxAttempts: 1 });
  kick();
  return id;
}

/** Runs due jobs right away (instead of waiting for the poller tick) without blocking the request. */
function kick() {
  if (process.env.NODE_ENV === 'test') return;
  setImmediate(() => queue.runDueJobs({ limit: 5, timeBudgetMs: 20000 }).catch((err) => getLogger().error({ err: err.message }, 'job kick failed')));
}

// ---------------------------------------------------------------- Resolve catalogue references

async function resolver(organisationId) {
  const k = db();
  const cats = await k('categories').where((w) => w.whereNull('organisation_id').orWhere('organisation_id', organisationId || 0)).select('id', 'name', 'slug', 'parent_id');
  const byId = new Map(cats.map((c) => [c.id, c]));
  const pathOf = (c) => {
    const parts = [];
    let cur = c;
    let guard = 0;
    while (cur && guard < 20) {
      parts.unshift(cur.name.toLowerCase());
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
      guard += 1;
    }
    return parts.join(' > ');
  };
  const catIndex = new Map();
  const nameCount = new Map();
  for (const c of cats) nameCount.set(c.name.toLowerCase(), (nameCount.get(c.name.toLowerCase()) || 0) + 1);
  for (const c of cats) {
    catIndex.set(pathOf(c), c.id);
    catIndex.set(c.slug, c.id);
    if (nameCount.get(c.name.toLowerCase()) === 1) catIndex.set(c.name.toLowerCase(), c.id);
  }
  const certs = await k('certifications').select('id', 'name', 'exam_code');
  const domains = await k('certification_domains').select('id', 'certification_id', 'code', 'name');
  return {
    category(text) {
      if (!text) return null;
      const key = String(text).toLowerCase().replace(/\s*[›/\\>]\s*/g, ' > ').replace(/\s+/g, ' ').trim();
      return catIndex.get(key) || catIndex.get(slugify(text)) || null;
    },
    certification(text) {
      if (!text) return null;
      const t = String(text).trim().toLowerCase();
      const c = certs.find((x) => (x.exam_code && x.exam_code.toLowerCase() === t) || x.name.toLowerCase() === t);
      return c ? c.id : null;
    },
    domain(text, certId) {
      if (!text || !certId) return null;
      const t = String(text).trim().toLowerCase();
      const d = domains.find((x) => x.certification_id === certId && ((x.code && x.code.toLowerCase() === t) || x.name.toLowerCase() === t));
      return d ? d.id : null;
    },
    isLeafOrAny(id) {
      return byId.has(id);
    },
  };
}

// ---------------------------------------------------------------- Images

async function saveImage(buffer, name, importId, userId) {
  const kind = sniff(buffer);
  if (!kind || !['png', 'jpg', 'webp', 'gif'].includes(kind.ext)) return null;
  const uuid = crypto.randomUUID();
  const file = `${uuid}.${kind.ext}`;
  const dir = storagePath('uploads', 'private', 'questions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buffer);
  await require('../fileStore').persist(path.join(dir, file));
  const { imageSize } = require('../../controllers/admin/questionsController');
  const dims = imageSize(buffer, kind.ext);
  await db()('question_media').insert({ uuid, import_id: importId, uploaded_by: userId, path: file, original_name: String(name).slice(0, 255), mime: kind.mime, size_bytes: buffer.length, width: dims.width, height: dims.height });
  return uuid;
}

// ---------------------------------------------------------------- Parse

/** Validates parsed records and stores them as import_rows. Shared by file imports and AI generation. */
async function storeRecords(imp, records, { fileErrors = [], images = new Map() } = {}) {
  const k = db();
  const options = parseJson(imp.options, {});
  const resolve = await resolver(imp.organisation_id);
  const saved = new Map();
  const imageFor = async (name) => {
    const key = path.basename(String(name)).toLowerCase();
    if (saved.has(key)) return saved.get(key);
    const entry = images.get(key) || images.get(String(name));
    const uuid = entry ? await saveImage(entry.buffer, key, imp.id, imp.user_id) : null;
    saved.set(key, uuid);
    return uuid;
  };

  const caseIds = new Set(records.filter((r) => r.caseId).map((r) => r.caseId));
  const seenHashes = new Map();
  const rows = [];
  let n = 0;
  for (const rec of records) {
    n += 1;
    const errors = [...(rec.errors || [])];
    const warnings = [...(rec.warnings || [])];
    const q = { ...rec.question };

    // Images referenced in the stem (Word/ZIP: src="images/x.png") or in the image column.
    if (q.stem_html && /src="images\//i.test(q.stem_html)) {
      for (const m of [...q.stem_html.matchAll(/src="images\/([^"]+)"/gi)]) {
        const uuid = await imageFor(m[1]);
        if (uuid) q.stem_html = q.stem_html.replace(m[0], `src="/qmedia/${uuid}"`);
        else errors.push(`Image “${m[1]}” is missing or is not a PNG/JPG/WebP/GIF.`);
      }
    }
    if (rec.image) {
      const uuid = await imageFor(rec.image);
      if (!uuid) errors.push(`Image “${rec.image}” was not found in the ZIP’s images/ folder (or is not an image).`);
      else if (q.type === 'hotspot') q.image = uuid;
      else q.stem_html = `<p><img src="/qmedia/${uuid}" alt=""></p>${q.stem_html || ''}`;
    }

    // Catalogue references (row value, else the import defaults).
    const meta = rec.meta || {};
    let categoryId = resolve.category(meta.category);
    if (meta.category && !categoryId) {
      if (options.category_id) warnings.push(`Category “${meta.category}” does not exist — the import default was used.`);
      else errors.push(`Category “${meta.category}” does not exist.`);
    }
    categoryId = categoryId || options.category_id || null;
    if (!categoryId) errors.push('No category: fill the category column or choose a default category for the import.');
    let certificationId = resolve.certification(meta.certification);
    if (meta.certification && !certificationId) warnings.push(`Certification “${meta.certification}” was not found and was left empty.`);
    certificationId = certificationId || (meta.certification ? null : options.certification_id || null);
    const domainId = resolve.domain(meta.domain, certificationId);
    if (meta.domain && !domainId) warnings.push(`Domain “${meta.domain}” was not found${certificationId ? ' in that certification' : ' (no certification)'} and was left empty.`);

    if (rec.parentCaseId && !caseIds.has(rec.parentCaseId)) errors.push(`Case “${rec.parentCaseId}” has no case_study row in this file.`);
    if (q.type === 'case_study' && rec.parentCaseId) errors.push('A case study cannot be inside another case study.');

    let normalised = null;
    let hash = null;
    if (q.type && types.TYPES[q.type]) {
      normalised = types.normalise(q);
      // Skip the registry's generic "mark the correct option" when the row already names the exact wrong key.
      const keyError = errors.some((e) => /^Correct answer/.test(e));
      for (const e of types.validate(normalised)) {
        if (keyError && /correct option/i.test(e.message)) continue;
        if (!errors.includes(e.message)) errors.push(e.message);
      }
      if (normalised.type === 'sql' && !errors.length) for (const e of await sqlLab.verify(normalised)) errors.push(e.message);
      hash = types.contentHash(normalised);
      if (seenHashes.has(hash)) warnings.push(`Duplicate of ${seenHashes.get(hash)} in this file.`);
      else seenHashes.set(hash, rec.rowRef);
    } else if (!errors.length) errors.push('Unknown question type.');

    rows.push({
      import_id: imp.id,
      row_number: rec.rowNumber || n,
      row_ref: String(rec.rowRef || `Row ${n}`).slice(0, 60),
      status: errors.length ? 'error' : warnings.length ? 'warning' : 'valid',
      messages: toJson([...errors.map((text) => ({ level: 'error', text })), ...warnings.map((text) => ({ level: 'warning', text }))]),
      source: toJson(rec.source || {}),
      payload: toJson({
        question: normalised || q,
        meta: { category_id: categoryId, certification_id: certificationId, domain_id: domainId, topic: meta.topic || null, tags: meta.tags || '', difficulty: meta.difficulty || options.difficulty || 3, bloom_level: meta.bloom || null, est_time_sec: meta.est_time_sec || null },
        caseId: rec.caseId || null,
        parentCaseId: rec.parentCaseId || null,
      }),
      content_hash: hash,
      decision: 'import',
    });
  }

  // Duplicates already in the bank.
  const hashes = [...new Set(rows.map((r) => r.content_hash).filter(Boolean))];
  const existing = new Map();
  for (let i = 0; i < hashes.length; i += 500) {
    const found = await k('questions')
      .whereIn('content_hash', hashes.slice(i, i + 500))
      .whereNull('deleted_at')
      .where((w) => (imp.organisation_id ? w.where('organisation_id', imp.organisation_id) : w.whereNull('organisation_id')))
      .orderBy('id')
      .select('id', 'content_hash');
    for (const f of found) if (!existing.has(f.content_hash)) existing.set(f.content_hash, f.id);
  }
  const fileDupSeen = new Set();
  for (const r of rows) {
    const msgs = parseJson(r.messages, []);
    if (r.content_hash && existing.has(r.content_hash)) {
      r.duplicate_of_question_id = existing.get(r.content_hash);
      msgs.push({ level: 'warning', text: `Already in the bank as question #${r.duplicate_of_question_id}.` });
      if (r.status === 'valid') r.status = 'warning';
      r.decision = ['skip', 'overwrite', 'new'].includes(options.duplicate_default) ? options.duplicate_default : 'skip';
    } else if (r.content_hash && fileDupSeen.has(r.content_hash)) {
      r.decision = 'skip';
    }
    if (r.content_hash) fileDupSeen.add(r.content_hash);
    r.messages = toJson(msgs);
  }

  await k.transaction(async (trx) => {
    for (let i = 0; i < rows.length; i += 500) await trx('import_rows').insert(rows.slice(i, i + 500));
  });
  const counts = { valid: 0, warning: 0, error: 0 };
  for (const r of rows) counts[r.status] += 1;
  await k('imports')
    .where({ id: imp.id })
    .update({
      status: 'parsed',
      parse_progress: 100,
      total_rows: rows.length,
      valid_rows: counts.valid,
      warning_rows: counts.warning,
      error_rows: counts.error,
      last_error: fileErrors.length ? fileErrors.join('\n').slice(0, 4000) : null,
    });
  return counts;
}

async function parseImport(importId) {
  const imp = await db()('imports').where({ id: importId }).first();
  if (!imp || imp.status !== 'uploaded') return { skipped: true };
  await db()('imports').where({ id: importId }).update({ status: 'parsing', parse_progress: 10 });
  try {
    const buffer = fs.readFileSync(path.join(importsDir(), imp.stored_path));
    const parsed = await parseFile(imp.format, buffer);
    await db()('imports').where({ id: importId }).update({ parse_progress: 50 });
    if (!parsed.records.length) throw new ImportFileError(parsed.fileErrors.join(' ') || 'No questions were found in the file.');
    const counts = await storeRecords(imp, parsed.records, parsed);
    return counts;
  } catch (err) {
    await db()('imports').where({ id: importId }).update({ status: 'failed', last_error: String(err instanceof ImportFileError ? err.message : `Unexpected error while reading the file: ${err.message}`).slice(0, 4000) });
    if (!(err instanceof ImportFileError)) getLogger().error({ err, importId }, 'import parse failed');
    return { failed: true };
  }
}

// ---------------------------------------------------------------- Decisions & confirm

async function setDecisions(importId, decisions) {
  for (const [rowId, decision] of Object.entries(decisions)) {
    if (!['import', 'skip', 'overwrite', 'new'].includes(decision)) continue;
    const q = db()('import_rows').where({ import_id: importId, id: rowId });
    if (decision === 'overwrite') q.whereNotNull('duplicate_of_question_id');
    await q.update({ decision });
  }
}

async function setDuplicateDecision(importId, decision) {
  if (!['skip', 'overwrite', 'new'].includes(decision)) return 0;
  return db()('import_rows').where({ import_id: importId }).whereNotNull('duplicate_of_question_id').update({ decision });
}

async function createPlainExam(imp, options) {
  const exams = require('../exams/repository');
  return exams.createExam({ title: options.exam_title, type: 'practice', category_id: options.category_id, certification_id: options.certification_id, organisation_id: imp.organisation_id, user: imp.user_id ? { id: imp.user_id } : null });
}

/** "Generate a complete exam": type defaults + the certification's official format + AI catalogue copy. */
async function createAiExam(imp, options) {
  const exams = require('../exams/repository');
  const examPlan = require('../ai/examPlan');
  const { withDefaults } = require('../exams/settings');
  const { sanitizeRich } = require('../../utils/html');
  const k = db();
  const gen = await k('ai_generations').where({ import_id: imp.id }).first('id');
  const meta = options.exam_meta || {};
  const examId = await exams.createExam({ title: meta.title || options.exam_title, type: options.exam_type, category_id: options.category_id, certification_id: options.certification_id, organisation_id: imp.organisation_id, user: imp.user_id ? { id: imp.user_id } : null, aiGenerationId: gen ? gen.id : null });
  const cert = options.certification_id ? await k('certifications').where({ id: options.certification_id }).first() : null;
  const plan = examPlan.planFromCertification(cert, { type: options.exam_type, count: options.exam_count || imp.valid_rows || 10 });
  const exam = await k('exams').where({ id: examId }).first('settings');
  const s = withDefaults(parseJson(exam.settings, {}));
  if (plan.scaling) s.scaling = plan.scaling;
  if (meta.instructions_note) s.instructions.custom_before = meta.instructions_note;
  await k('exams')
    .where({ id: examId })
    .update({
      ...plan.columns,
      short_description: meta.short_description || null,
      description_html: meta.description ? sanitizeRich(meta.description.split(/\n{2,}/).map((p) => `<p>${p.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</p>`).join('')) : null,
      settings: toJson(s),
    });
  if (gen) await k('ai_generations').where({ id: gen.id }).update({ exam_id: examId });
  return examId;
}

async function confirmImport(importId) {
  const n = await db()('imports').where({ id: importId, status: 'parsed' }).update({ status: 'importing', progress: 0 });
  if (n !== 1) return false;
  const imp = await db()('imports').where({ id: importId }).first();
  const options = parseJson(imp.options, {});
  if (options.exam_mode === 'create' && options.exam_title) {
    const examId = options.exam_type ? await createAiExam(imp, options) : await createPlainExam(imp, options);
    await db()('imports').where({ id: importId }).update({ created_exam_id: examId });
  }
  await queue.enqueue('import.run', { importId }, { maxAttempts: 3 });
  kick();
  return true;
}

// ---------------------------------------------------------------- Run (resumable)

async function runImport(importId) {
  const k = db();
  const started = Date.now();
  const imp = await k('imports').where({ id: importId }).first();
  if (!imp || imp.status !== 'importing') return { skipped: true };
  const options = parseJson(imp.options, {});
  const user = { id: imp.user_id, can: () => true };
  const examId = imp.created_exam_id || imp.target_exam_id || null;
  const status = options.status === 'published' ? 'published' : 'draft';

  // Case-study parents first so children can find them.
  const caseMap = new Map(
    (await k('import_rows').where({ import_id: importId }).whereIn('result', ['imported', 'overwritten']).select('payload', 'result_question_id'))
      .map((r) => [parseJson(r.payload, {}).caseId, r.result_question_id])
      .filter(([c]) => c),
  );

  while (Date.now() - started < RUN_BUDGET_MS) {
    const batch = await k('import_rows').where({ import_id: importId, result: 'pending' }).orderByRaw("JSON_EXTRACT(payload, '$.question.type') = 'case_study' DESC").orderBy('row_number').orderBy('id').limit(BATCH);
    if (!batch.length) break;
    let order = examId ? Number((await k('exam_questions').where({ exam_id: examId }).max('display_order as m').first()).m || 0) : 0;
    await k.transaction(async (trx) => {
      for (const row of batch) {
        const p = parseJson(row.payload, {});
        const patch = {};
        if (row.status === 'error') Object.assign(patch, { result: 'failed', result_error: parseJson(row.messages, []).filter((m) => m.level === 'error').map((m) => m.text).join(' ') });
        else if (row.decision === 'skip') patch.result = 'skipped';
        else {
          try {
            const parentId = p.parentCaseId ? caseMap.get(p.parentCaseId) : null;
            if (p.parentCaseId && !parentId) throw new repo.QuestionError('Its case study was not imported.');
            const meta = { ...p.meta, est_time_sec: p.meta.est_time_sec || (p.question.type === 'essay' ? 900 : 60), parent_id: parentId };
            const tags = repo.parseTagInput(p.meta.tags || '').map((t) => t.name);
            if (row.decision === 'overwrite' && row.duplicate_of_question_id) {
              const before = await trx('questions').where({ id: row.duplicate_of_question_id }).first('current_version_id', 'status');
              const saved = await repo.saveQuestion({ id: row.duplicate_of_question_id, meta, authoring: p.question, tags, user, changeNote: `Overwritten by import #${importId}`, status }, trx);
              Object.assign(patch, { result: 'overwritten', result_question_id: saved.id, previous_version_id: before.current_version_id, previous_status: before.status });
            } else {
              const saved = await repo.saveQuestion({ meta, authoring: p.question, tags, user, status, importId, changeNote: `Imported (#${importId})` }, trx);
              Object.assign(patch, { result: 'imported', result_question_id: saved.id });
            }
            if (imp.organisation_id) await trx('questions').where({ id: patch.result_question_id }).update({ organisation_id: imp.organisation_id });
            if (p.caseId) caseMap.set(p.caseId, patch.result_question_id);
            if (examId && !parentId) {
              order += 1;
              await trx('exam_questions').insert({ exam_id: examId, question_id: patch.result_question_id, display_order: order }).onConflict(['exam_id', 'question_id']).ignore();
            }
          } catch (err) {
            if (!(err instanceof repo.QuestionError)) getLogger().error({ err, importId, row: row.id }, 'import row failed');
            Object.assign(patch, { result: 'failed', result_error: err.errors && err.errors.length ? err.errors.map((e) => e.message).join(' ') : err.message });
          }
        }
        await trx('import_rows').where({ id: row.id }).update(patch);
      }
    });
    const done = await k('import_rows').where({ import_id: importId }).whereNot('result', 'pending').count('* as n').first();
    await k('imports').where({ id: importId }).update({ progress: Math.min(99, Math.floor((Number(done.n) / Math.max(1, imp.total_rows)) * 100)) });
  }

  const remaining = await k('import_rows').where({ import_id: importId, result: 'pending' }).count('* as n').first();
  if (Number(remaining.n)) {
    await queue.enqueue('import.run', { importId }, { maxAttempts: 3 });
    kick();
    return { continued: true };
  }
  return finishImport(importId);
}

async function finishImport(importId) {
  const k = db();
  const counts = await k('import_rows').where({ import_id: importId }).groupBy('result').select('result', k.raw('COUNT(*) as n'));
  const c = Object.fromEntries(counts.map((x) => [x.result, Number(x.n)]));
  const reportPath = await writeErrorReport(importId);
  await k('imports')
    .where({ id: importId })
    .update({
      status: 'completed',
      progress: 100,
      imported_count: (c.imported || 0) + (c.overwritten || 0),
      skipped_count: c.skipped || 0,
      failed_count: c.failed || 0,
      error_report_path: reportPath,
      completed_at: new Date(),
      undo_expires_at: new Date(Date.now() + UNDO_HOURS * 3600000),
    });
  return c;
}

/** Excel report of failed rows (original columns + the reason) so the file can be fixed and re-uploaded. */
async function writeErrorReport(importId) {
  const rows = await db()('import_rows').where({ import_id: importId, result: 'failed' }).orderBy('row_number');
  if (!rows.length) return null;
  const imp = await db()('imports').where({ id: importId }).first();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Failed rows');
  const sources = rows.map((r) => parseJson(r.source, {}));
  const keys = [...new Set(sources.flatMap((s) => Object.keys(s)))];
  ws.addRow(['Row', 'Problems', ...keys]);
  ws.getRow(1).font = { bold: true };
  rows.forEach((r, i) => ws.addRow([r.row_ref, r.result_error || '', ...keys.map((k) => sources[i][k] ?? '')]));
  ws.getColumn(2).width = 70;
  ws.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const file = `${imp.uuid}-errors.xlsx`;
  await wb.xlsx.writeFile(path.join(importsDir(), file));
  return file;
}

// ---------------------------------------------------------------- Undo

async function undoImport(importId) {
  const k = db();
  const imp = await k('imports').where({ id: importId }).first();
  if (!imp || imp.status !== 'completed') throw new repo.QuestionError('Only completed imports can be undone.');
  if (!imp.undo_expires_at || imp.undo_expires_at < new Date()) throw new repo.QuestionError(`The ${UNDO_HOURS}-hour undo window for this import has closed.`);
  const report = { deleted: 0, retired: 0, restored: 0 };
  await k.transaction(async (trx) => {
    const rows = await trx('import_rows').where({ import_id: importId }).whereIn('result', ['imported', 'overwritten']).orderBy('id', 'desc');
    for (const r of rows) {
      if (r.result === 'imported') {
        const used = await trx('attempt_items').where({ question_id: r.result_question_id }).first('id');
        if (used) {
          await trx('questions').where({ id: r.result_question_id }).update({ status: 'retired' });
          report.retired += 1;
        } else {
          await trx('questions').where({ parent_id: r.result_question_id }).del();
          await trx('questions').where({ id: r.result_question_id }).del();
          report.deleted += 1;
        }
      } else if (r.result === 'overwritten' && r.previous_version_id) {
        const q = await trx('questions').where({ id: r.result_question_id }).first();
        const prev = await trx('question_versions').where({ id: r.previous_version_id }).first();
        if (q && prev) {
          const newerVersionId = q.current_version_id;
          await trx('questions').where({ id: q.id }).update({ current_version_id: prev.id, version: prev.version_no, status: r.previous_status || q.status, stem_text: prev.stem_text, content_hash: prev.content_hash, type: prev.type, default_marks: prev.marks });
          if (newerVersionId !== prev.id && !(await trx('attempt_items').where({ question_version_id: newerVersionId }).first('id'))) await trx('question_versions').where({ id: newerVersionId }).del();
          report.restored += 1;
        }
      }
    }
    if (imp.created_exam_id && !(await trx('attempts').where({ exam_id: imp.created_exam_id }).first('id'))) await trx('exams').where({ id: imp.created_exam_id }).del();
    await trx('imports').where({ id: importId }).update({ status: 'undone', undone_at: new Date() });
  });
  // Images uploaded by this import that no question uses any more.
  const orphans = await k('question_media').where({ import_id: importId }).whereNull('question_id');
  for (const m of orphans) {
    const stillUsed = await k('question_versions').where('stem_html', 'like', `%${m.uuid}%`).first('id');
    if (!stillUsed) {
      fs.rm(storagePath('uploads', 'private', 'questions', m.path), { force: true }, () => {});
      await k('question_media').where({ id: m.id }).del();
    }
  }
  return report;
}

/** Discards a parsed import that was never confirmed. */
async function discardImport(importId) {
  const imp = await db()('imports').where({ id: importId }).first();
  if (!imp || !['parsed', 'failed', 'uploaded'].includes(imp.status)) return false;
  await db()('import_rows').where({ import_id: importId }).del();
  await db()('imports').where({ id: importId }).update({ status: 'undone', undone_at: new Date() });
  return true;
}

function registerJobs() {
  queue.register('import.parse', ({ importId }) => parseImport(importId));
  queue.register('import.run', ({ importId }) => runImport(importId));
}

module.exports = { createImport, parseImport, storeRecords, setDecisions, setDuplicateDecision, confirmImport, runImport, undoImport, discardImport, registerJobs, writeErrorReport, UNDO_HOURS, importsDir, kick };
