'use strict';

const { scopeOrg } = require('../../middleware/workspace');

const path = require('path');
const { db } = require('../../config/db');
const audit = require('../../services/audit');
const catalogue = require('../../services/catalogue');
const pipeline = require('../../services/import/pipeline');
const { TEMPLATES } = require('../../services/import/templates');
const exporter = require('../../services/import/exporter');
const repo = require('../../services/questions/repository');
const types = require('../../services/questions/types');
const { ImportFileError } = require('../../services/import/parsers');
const { paginate } = require('../../utils/paginate');
const { parseJson } = require('../../utils/json');
const { notFound, badRequest } = require('../../utils/errors');

const crumbs = (...rest) => [{ label: 'Admin', href: '/admin' }, { label: 'Imports', href: '/admin/imports' }, ...rest];
const FORMATS = { auto: 'Detect automatically', xlsx: 'Excel (.xlsx)', csv: 'CSV', json: 'JSON', aiken: 'Aiken (.txt)', gift: 'GIFT (Moodle)', docx: 'Word (.docx)', zip: 'ZIP bundle (sheet + images)' };
const STATUS_BADGE = { uploaded: 'badge-gray', parsing: 'badge-blue', parsed: 'badge-amber', importing: 'badge-blue', completed: 'badge-green', failed: 'badge-red', undone: 'badge-gray' };
const intOrNull = (v) => (v && /^\d+$/.test(String(v)) ? Number(v) : null);

async function index(req, res) {
  const q = db()('imports as i').leftJoin('users as u', 'u.id', 'i.user_id').where((w) => (scopeOrg(req) ? w.where('i.organisation_id', scopeOrg(req)) : w.whereNull('i.organisation_id'))).orderBy('i.id', 'desc').select('i.*', 'u.full_name');
  const pager = await paginate(q, { page: req.query.page, perPage: 20 });
  res.render('admin/imports/index', { title: 'Imports', layout: 'layouts/app', pager, query: req.query, STATUS_BADGE, FORMATS, breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Imports' }] });
}

async function newForm(req, res) {
  const [categories, certifications, exams] = await Promise.all([
    catalogue.categoryTree(),
    catalogue.certificationsWithDomains(),
    db()('exams').whereNull('deleted_at').where((w) => (scopeOrg(req) ? w.where('organisation_id', scopeOrg(req)) : w.whereNull('organisation_id'))).whereIn('status', ['draft', 'published']).orderBy('title').select('id', 'title', 'status'),
  ]);
  res.render('admin/imports/new', { title: 'Import questions', layout: 'layouts/app', categories, certifications, exams, FORMATS, TEMPLATES, canPublish: req.user.can('questions.publish'), breadcrumbs: crumbs({ label: 'New import' }) });
}

async function create(req, res) {
  const back = '/admin/imports/new';
  const fail = (msg, errors = {}) => {
    req.setFormState(req.body, errors);
    req.flash('danger', msg);
    return res.redirect(back);
  };
  if (!req.file) return fail('Choose a file to import.', { file: 'Choose a file to import.' });
  const options = {
    category_id: intOrNull(req.body.category_id),
    certification_id: intOrNull(req.body.certification_id),
    difficulty: [1, 2, 3, 4, 5].includes(Number(req.body.difficulty)) ? Number(req.body.difficulty) : 3,
    status: req.body.status === 'published' && req.user.can('questions.publish') ? 'published' : 'draft',
    duplicate_default: ['skip', 'overwrite', 'new'].includes(req.body.duplicate_default) ? req.body.duplicate_default : 'skip',
    exam_mode: ['none', 'attach', 'create'].includes(req.body.exam_mode) ? req.body.exam_mode : 'none',
    exam_id: intOrNull(req.body.exam_id),
    exam_title: String(req.body.exam_title || '').trim().slice(0, 200),
  };
  if (options.exam_mode === 'attach' && !(options.exam_id && (await db()('exams').where({ id: options.exam_id, organisation_id: scopeOrg(req) }).whereNull('deleted_at').first()))) return fail('Choose the exam to attach the questions to.', { exam_id: 'Choose an exam.' });
  if (options.exam_mode === 'create' && !options.exam_title) return fail('Give the new exam a title.', { exam_title: 'Enter a title for the new exam.' });
  if (options.category_id && !(await db()('categories').where({ id: options.category_id }).first())) return fail('Choose a valid default category.');
  try {
    const id = await pipeline.createImport({ user: req.user, buffer: req.file.buffer, originalName: req.file.originalname, format: FORMATS[req.body.format] ? req.body.format : 'auto', options, organisationId: scopeOrg(req) });
    await audit.record(req, 'import.upload', { entityType: 'import', entityId: id, after: { file: req.file.originalname, size: req.file.size, options } });
    return res.redirect(`/admin/imports/${id}`);
  } catch (err) {
    if (err instanceof ImportFileError) return fail(err.message, { file: err.message });
    throw err;
  }
}

async function loadImport(id) {
  const imp = await db()('imports as i').leftJoin('users as u', 'u.id', 'i.user_id').where('i.id', id).first('i.*', 'u.full_name');
  if (!imp) throw notFound('That import does not exist.');
  imp.options = parseJson(imp.options, {});
  return imp;
}

const FILTERS = {
  all: (q) => q,
  valid: (q) => q.where('status', 'valid'),
  warning: (q) => q.where('status', 'warning'),
  error: (q) => q.where('status', 'error'),
  duplicate: (q) => q.whereNotNull('duplicate_of_question_id'),
  failed: (q) => q.where('result', 'failed'),
};

async function show(req, res) {
  const imp = await loadImport(req.params.id);
  const filter = FILTERS[req.query.filter] ? req.query.filter : 'all';
  let pager = null;
  let counts = {};
  if (['parsed', 'completed', 'importing'].includes(imp.status)) {
    const q = FILTERS[filter](db()('import_rows').where({ import_id: imp.id })).orderBy('row_number').orderBy('id');
    pager = await paginate(q, { page: req.query.page, perPage: 50 });
    for (const r of pager.rows) {
      r.messages = parseJson(r.messages, []);
      const p = parseJson(r.payload, {});
      r.qtype = p.question && p.question.type;
      r.stem = require('../../utils/html').toPlainText((p.question && p.question.stem_html) || '').slice(0, 180);
      r.caseId = p.caseId;
      r.parentCaseId = p.parentCaseId;
    }
    const dup = await db()('import_rows').where({ import_id: imp.id }).whereNotNull('duplicate_of_question_id').count('* as n').first();
    const toImport = await db()('import_rows').where({ import_id: imp.id }).whereNot('status', 'error').whereNot('decision', 'skip').count('* as n').first();
    const failed = await db()('import_rows').where({ import_id: imp.id, result: 'failed' }).count('* as n').first();
    counts = { duplicates: Number(dup.n), toImport: Number(toImport.n), failed: Number(failed.n) };
  }
  const exam = imp.created_exam_id || imp.target_exam_id ? await db()('exams').where({ id: imp.created_exam_id || imp.target_exam_id }).first('id', 'title') : null;
  const generation = imp.source === 'ai' ? await db()('ai_generations').where({ import_id: imp.id }).first() : null;
  res.render('admin/imports/show', {
    title: imp.source === 'ai' ? `AI generation #${imp.id}` : `Import #${imp.id}`,
    layout: 'layouts/app',
    imp,
    pager,
    filter,
    counts,
    exam,
    examPlan: await aiExamPlan(imp),
    generation,
    query: req.query,
    TYPES: types.TYPES,
    STATUS_BADGE,
    FORMATS,
    undoOpen: imp.status === 'completed' && imp.undo_expires_at && imp.undo_expires_at > new Date(),
    breadcrumbs: crumbs({ label: `#${imp.id}` }),
  });
}

async function status(req, res) {
  const imp = await db()('imports').where({ id: req.params.id }).first('id', 'status', 'progress', 'parse_progress', 'total_rows', 'imported_count', 'failed_count', 'last_error');
  if (!imp) return res.status(404).json({ error: 'Not found' });
  const done = imp.status === 'importing' ? await db()('import_rows').where({ import_id: imp.id }).whereNot('result', 'pending').count('* as n').first() : { n: 0 };
  return res.json({ ...imp, processed: Number(done.n) });
}

async function decisions(req, res) {
  const imp = await loadImport(req.params.id);
  if (imp.status !== 'parsed') throw badRequest('Decisions can only be changed before the import starts.');
  if (req.body.all_duplicates) {
    const n = await pipeline.setDuplicateDecision(imp.id, req.body.all_duplicates);
    req.flash('success', `${n} duplicate row${n === 1 ? '' : 's'} set to “${{ skip: 'Skip', overwrite: 'Overwrite', new: 'Import as new' }[req.body.all_duplicates]}”.`);
  } else if (req.body.decision && typeof req.body.decision === 'object') {
    await pipeline.setDecisions(imp.id, req.body.decision);
    req.flash('success', 'Choices saved.');
  }
  return res.redirect(`/admin/imports/${imp.id}?${new URLSearchParams({ filter: req.body.filter || 'all', page: req.body.page || 1 })}`);
}

async function confirm(req, res) {
  const imp = await loadImport(req.params.id);
  if (!(await pipeline.confirmImport(imp.id))) {
    req.flash('warning', 'This import has already started or finished.');
    return res.redirect(`/admin/imports/${imp.id}`);
  }
  await audit.record(req, 'import.confirm', { entityType: 'import', entityId: imp.id, after: { total: imp.total_rows, options: imp.options } });
  return res.redirect(`/admin/imports/${imp.id}`);
}

async function discard(req, res) {
  const imp = await loadImport(req.params.id);
  if (await pipeline.discardImport(imp.id)) {
    await audit.record(req, 'import.discard', { entityType: 'import', entityId: imp.id });
    req.flash('success', 'The import was discarded. Nothing was saved to the question bank.');
  }
  return res.redirect('/admin/imports');
}

async function undo(req, res) {
  const imp = await loadImport(req.params.id);
  try {
    const r = await pipeline.undoImport(imp.id);
    await audit.record(req, 'import.undo', { entityType: 'import', entityId: imp.id, after: r });
    req.flash('success', `Import undone: ${r.deleted} question(s) removed${r.retired ? `, ${r.retired} retired because candidates already answered them` : ''}${r.restored ? `, ${r.restored} overwritten question(s) restored` : ''}.`);
  } catch (err) {
    if (!(err instanceof repo.QuestionError)) throw err;
    req.flash('danger', err.message);
  }
  return res.redirect(`/admin/imports/${imp.id}`);
}

async function errorReport(req, res) {
  const imp = await loadImport(req.params.id);
  if (!imp.error_report_path) throw notFound('This import has no error report.');
  return res.download(path.join(pipeline.importsDir(), imp.error_report_path), `import-${imp.id}-failed-rows.xlsx`);
}

async function template(req, res) {
  const t = TEMPLATES[req.params.format];
  if (!t) throw notFound();
  const buf = await t.build();
  res.set('Content-Disposition', `attachment; filename="${t.file}"`);
  return res.type(t.mime).send(buf);
}

// ---------------------------------------------------------------- Export

async function exportQuestions(req, res) {
  const format = ['xlsx', 'json', 'gift'].includes(req.query.format) ? req.query.format : 'xlsx';
  const filters = {
    q: String(req.query.q || ''),
    category_ids: intOrNull(req.query.category) ? await catalogue.descendantIds(intOrNull(req.query.category)) : null,
    certification_id: intOrNull(req.query.certification),
    domain_id: intOrNull(req.query.domain),
    type: types.TYPES[req.query.type] ? req.query.type : '',
    status: ['draft', 'in_review', 'published', 'retired'].includes(req.query.status) ? req.query.status : '',
    difficulty: intOrNull(req.query.difficulty),
    tag: String(req.query.tag || ''),
    organisation_id: scopeOrg(req),
  };
  const ids = await repo.filteredQuery(filters).orderBy('q.id').limit(10000).pluck('q.id');
  const cats = new Map((await catalogue.categoryTree()).map((c) => [c.id, c.path.replace(/ › /g, ' > ')]));
  const certs = new Map((await db()('certifications').select('id', 'exam_code', 'name')).map((c) => [c.id, c.exam_code || c.name]));
  const doms = new Map((await db()('certification_domains').select('id', 'code', 'name')).map((d) => [d.id, d.code || d.name]));
  const item = async (id) => {
    const q = await repo.loadQuestion(id);
    return {
      id,
      authoring: q.current.authoring,
      meta: { category: cats.get(q.category_id) || '', certification: certs.get(q.certification_id) || '', domain: doms.get(q.domain_id) || '', topic: q.topic || '', tags: q.tags.join(', '), difficulty: q.difficulty, bloom: q.bloom_level || '', time_seconds: q.est_time_sec },
      children: await Promise.all(q.children.map((c) => item(c.id))),
    };
  };
  const items = [];
  for (const id of ids) items.push(await item(id));
  const stamp = new Date().toISOString().slice(0, 10);
  await audit.record(req, 'question.export', { entityType: 'question', entityId: null, after: { format, count: items.length, filters: req.query } });
  if (format === 'json') {
    res.set('Content-Disposition', `attachment; filename="questions-${stamp}.json"`);
    return res.type('application/json').send(exporter.toJsonExport(items));
  }
  if (format === 'gift') {
    res.set('Content-Disposition', `attachment; filename="questions-${stamp}.gift.txt"`);
    return res.type('text/plain').send(exporter.toGift(items));
  }
  res.set('Content-Disposition', `attachment; filename="questions-${stamp}.xlsx"`);
  return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await exporter.toXlsx(items));
}

async function aiExamPlan(imp) {
  const o = imp.options || {};
  if (!o.exam_type) return null;
  const cert = o.certification_id ? await db()('certifications').where({ id: o.certification_id }).first() : null;
  return require('../../services/ai/examPlan').planFromCertification(cert, { type: o.exam_type, count: o.exam_count || imp.valid_rows || 10 });
}

module.exports = { index, newForm, create, show, status, decisions, confirm, discard, undo, errorReport, template, exportQuestions, FORMATS };
