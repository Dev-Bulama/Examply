'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../../config/db');
const { storagePath } = require('../../config/paths');
const audit = require('../../services/audit');
const catalogue = require('../../services/catalogue');
const repo = require('../../services/questions/repository');
const types = require('../../services/questions/types');
const { sniff } = require('../../services/uploads');
const { paginate } = require('../../utils/paginate');
const { notFound, forbidden, badRequest } = require('../../utils/errors');

const crumbs = (...rest) => [{ label: 'Admin', href: '/admin' }, { label: 'Question bank', href: '/admin/questions' }, ...rest];
const STATUS_BADGE = { draft: 'badge-gray', in_review: 'badge-amber', published: 'badge-green', retired: 'badge-red' };
const STATUS_LABEL = { draft: 'Draft', in_review: 'In review', published: 'Published', retired: 'Retired' };
const intOrNull = (v) => (v === undefined || v === null || v === '' || !/^\d+$/.test(String(v)) ? null : Number(v));

async function formOptions() {
  const [categories, certifications] = await Promise.all([catalogue.categoryTree(), catalogue.certificationsWithDomains()]);
  return { categories, certifications };
}

// ---------------------------------------------------------------- List

async function index(req, res) {
  const f = {
    q: String(req.query.q || '').slice(0, 200),
    category: intOrNull(req.query.category),
    certification: intOrNull(req.query.certification),
    domain: intOrNull(req.query.domain),
    type: types.TYPES[req.query.type] ? req.query.type : '',
    status: STATUS_LABEL[req.query.status] ? req.query.status : '',
    difficulty: intOrNull(req.query.difficulty),
    tag: String(req.query.tag || '').slice(0, 90),
    mine: req.query.mine === '1',
    import: intOrNull(req.query.import),
    sort: ['newest', 'oldest', 'difficulty', 'updated'].includes(req.query.sort) ? req.query.sort : 'newest',
  };
  const filters = {
    q: f.q,
    category_ids: f.category ? await catalogue.descendantIds(f.category) : null,
    certification_id: f.certification,
    domain_id: f.domain,
    type: f.type,
    status: f.status,
    difficulty: f.difficulty,
    tag: f.tag,
    author_id: f.mine ? req.user.id : null,
    import_id: f.import,
  };
  const query = repo
    .filteredQuery(filters)
    .leftJoin('categories as c', 'c.id', 'q.category_id')
    .leftJoin('certifications as ce', 'ce.id', 'q.certification_id')
    .leftJoin('certification_domains as d', 'd.id', 'q.domain_id')
    .leftJoin('users as a', 'a.id', 'q.author_id')
    .select('q.id', 'q.type', 'q.status', 'q.stem_text', 'q.difficulty', 'q.default_marks', 'q.version', 'q.updated_at', 'q.created_at', 'c.name as category_name', 'ce.exam_code', 'ce.name as certification_name', 'd.name as domain_name', 'a.full_name as author_name', 'q.author_id');
  const order = { newest: ['q.id', 'desc'], oldest: ['q.id', 'asc'], difficulty: ['q.difficulty', 'desc'], updated: ['q.updated_at', 'desc'] }[f.sort];
  query.orderBy(order[0], order[1]);
  const pager = await paginate(query, { page: req.query.page, perPage: Math.min(100, intOrNull(req.query.per) || 25) });
  const ids = pager.rows.map((r) => r.id);
  const tagRows = ids.length ? await db()('question_tags as qt').join('tags as t', 't.id', 'qt.tag_id').whereIn('qt.question_id', ids).select('qt.question_id', 't.name', 't.slug') : [];
  for (const r of pager.rows) r.tags = tagRows.filter((t) => t.question_id === r.id);
  const counts = await db()('questions').whereNull('deleted_at').whereNull('parent_id').groupBy('status').select('status', db().raw('COUNT(*) as n'));
  const opts = await formOptions();
  res.render('admin/questions/index', {
    title: 'Question bank',
    layout: 'layouts/app',
    pager,
    f,
    query: req.query,
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    ...opts,
    domains: f.certification ? (opts.certifications.find((c) => c.id === f.certification) || { domains: [] }).domains : [],
    TYPES: types.TYPES,
    STATUS_BADGE,
    STATUS_LABEL,
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Question bank' }],
  });
}

// ---------------------------------------------------------------- Create / edit

async function chooseType(req, res) {
  res.render('admin/questions/choose-type', {
    title: 'New question',
    layout: 'layouts/app',
    TYPES: types.TYPES,
    parentId: intOrNull(req.query.parent),
    breadcrumbs: crumbs({ label: 'New question' }),
  });
}

async function renderForm(req, res, { question, authoring, meta, tags, errors = [], status = 200 }) {
  const opts = await formOptions();
  const scope = await repo.authorScope(req.user);
  const categories = scope ? opts.categories.filter((c) => scope.includes(c.id)) : opts.categories;
  const parent = meta.parent_id ? await db()('questions').where({ id: meta.parent_id }).first('id', 'stem_text', 'category_id', 'certification_id') : null;
  res.status(status).render('admin/questions/form', {
    title: question ? `Edit question #${question.id}` : `New ${types.TYPES[authoring.type].label} question`,
    layout: 'layouts/app',
    question,
    authoring,
    meta,
    tags,
    errorList: errors,
    errorMap: Object.fromEntries(errors.map((e) => [e.field, e.message])),
    errors: Object.fromEntries(errors.map((e) => [e.field, e.message])),
    categories,
    certifications: opts.certifications,
    authorRestricted: !!scope,
    parent,
    TYPES: types.TYPES,
    BLOOM: types.BLOOM,
    canPublish: req.user.can('questions.publish'),
    lockedType: !!(question && question.current && question.current.version.published_at),
    breadcrumbs: crumbs({ label: question ? `#${question.id}` : 'New question', href: question ? `/admin/questions/${question.id}` : undefined }, ...(question ? [{ label: 'Edit' }] : [])),
  });
}

async function newForm(req, res) {
  const type = req.query.type;
  if (!types.TYPES[type]) return res.redirect(`/admin/questions/new/choose${req.query.parent ? `?parent=${intOrNull(req.query.parent)}` : ''}`);
  const scope = await repo.authorScope(req.user);
  if (scope && !scope.length) {
    req.flash('warning', 'No categories are assigned to you yet. Ask an administrator to assign the categories you write for.');
    return res.redirect('/admin/questions');
  }
  const parentId = intOrNull(req.query.parent);
  if (parentId && type === 'case_study') throw badRequest('A case study cannot contain another case study.');
  const parent = parentId ? await db()('questions').where({ id: parentId, type: 'case_study' }).whereNull('deleted_at').first() : null;
  if (parentId && !parent) throw notFound('That case study does not exist.');
  return renderForm(req, res, {
    question: null,
    authoring: types.emptyAuthoring(type),
    meta: {
      category_id: parent ? parent.category_id : intOrNull(req.query.category),
      certification_id: parent ? parent.certification_id : intOrNull(req.query.certification),
      domain_id: parent ? parent.domain_id : null,
      topic: parent ? parent.topic : '',
      difficulty: parent ? parent.difficulty : 3,
      bloom_level: '',
      est_time_sec: type === 'essay' ? 900 : type === 'case_study' ? 120 : 60,
      parent_id: parentId,
    },
    tags: [],
  });
}

/** Reads the editor form into { meta, authoring, tags }. */
function readForm(req, type) {
  let payload = {};
  try {
    payload = JSON.parse(req.body.payload || '{}');
  } catch {
    payload = {};
  }
  const authoring = { ...payload, type, stem_html: req.body.stem_html, explanation_html: req.body.explanation_html, reference: req.body.reference, marks: req.body.marks };
  if (type === 'essay') authoring.rubric_html = req.body.rubric_html;
  const meta = {
    category_id: intOrNull(req.body.category_id),
    certification_id: intOrNull(req.body.certification_id),
    domain_id: intOrNull(req.body.domain_id),
    topic: String(req.body.topic || '').trim().slice(0, 150) || null,
    difficulty: Number(req.body.difficulty) || 3,
    bloom_level: types.BLOOM.includes(req.body.bloom_level) ? req.body.bloom_level : null,
    est_time_sec: Number(req.body.est_time_sec) || 60,
    parent_id: intOrNull(req.body.parent_id),
  };
  return { meta, authoring, tags: repo.parseTagInput(req.body.tags || '').map((t) => t.name) };
}

function targetStatus(req, question) {
  const action = req.body.save_action;
  if (action === 'publish' && req.user.can('questions.publish')) return 'published';
  if (action === 'submit') return 'in_review';
  if (!question) return 'draft';
  return null; // keep the current status
}

async function create(req, res) {
  const type = req.body.type;
  if (!types.TYPES[type]) throw badRequest('Unknown question type.');
  const { meta, authoring, tags } = readForm(req, type);
  const scope = await repo.authorScope(req.user);
  const errors = [];
  if (!meta.category_id) errors.push({ field: 'category_id', message: 'Choose a category.' });
  else if (scope && !scope.includes(meta.category_id)) errors.push({ field: 'category_id', message: 'Choose one of the categories assigned to you.' });
  if (meta.parent_id && type === 'case_study') errors.push({ field: 'type', message: 'A case study cannot contain another case study.' });
  try {
    // Report every problem at once: catalogue/scope errors plus the type's own validation.
    if (errors.length) throw new repo.QuestionError('Invalid', [...errors, ...types.validate(types.normalise(authoring))]);
    const saved = await repo.saveQuestion({ meta, authoring, tags, user: req.user, status: targetStatus(req, null) });
    await audit.record(req, 'question.create', { entityType: 'question', entityId: saved.id, after: { type, status: targetStatus(req, null), ...meta, tags } });
    req.flash('success', `Question #${saved.id} saved${targetStatus(req, null) === 'published' ? ' and published' : targetStatus(req, null) === 'in_review' ? ' and sent for review' : ' as a draft'}.`);
    if (req.body.save_action === 'save_new') return res.redirect(`/admin/questions/new?type=${type}${meta.parent_id ? `&parent=${meta.parent_id}` : ''}&category=${meta.category_id || ''}&certification=${meta.certification_id || ''}`);
    return res.redirect(meta.parent_id ? `/admin/questions/${meta.parent_id}` : `/admin/questions/${saved.id}`);
  } catch (err) {
    if (!(err instanceof repo.QuestionError)) throw err;
    res.locals.flash.push({ type: 'danger', message: 'The question was not saved. Fix the problems listed below.' });
    return renderForm(req, res, { question: null, authoring: types.normalise(authoring), meta, tags, errors: err.errors.length ? err.errors : [{ field: '_form', message: err.message }], status: 422 });
  }
}

async function loadOr404(id) {
  const q = await repo.loadQuestion(id);
  if (!q) throw notFound('That question does not exist.');
  return q;
}

async function editForm(req, res) {
  const question = await loadOr404(req.params.id);
  const blocker = await repo.editBlocker(req.user, question);
  if (blocker) {
    req.flash('warning', blocker);
    return res.redirect(`/admin/questions/${question.id}`);
  }
  return renderForm(req, res, { question, authoring: question.current.authoring, meta: question, tags: question.tags });
}

async function update(req, res) {
  const question = await loadOr404(req.params.id);
  const blocker = await repo.editBlocker(req.user, question);
  if (blocker) throw forbidden(blocker);
  const type = req.body.type;
  const { meta, authoring, tags } = readForm(req, type);
  meta.parent_id = question.parent_id; // parent never changes from the editor
  const scope = await repo.authorScope(req.user);
  const status = targetStatus(req, question);
  try {
    const metaErrors = [];
    if (!meta.category_id) metaErrors.push({ field: 'category_id', message: 'Choose a category.' });
    else if (scope && !scope.includes(meta.category_id)) metaErrors.push({ field: 'category_id', message: 'Choose one of the categories assigned to you.' });
    if (metaErrors.length) throw new repo.QuestionError('Invalid', [...metaErrors, ...types.validate(types.normalise(authoring))]);
    const saved = await repo.saveQuestion({ id: question.id, meta, authoring, tags, user: req.user, changeNote: String(req.body.change_note || '').slice(0, 500) || null, status });
    await audit.record(req, 'question.update', {
      entityType: 'question',
      entityId: question.id,
      before: { version: question.version, status: question.status, stem: question.stem_text && question.stem_text.slice(0, 300), category_id: question.category_id, tags: question.tags },
      after: { version: saved.version, status: status || question.status, new_version: saved.newVersion, category_id: meta.category_id, tags },
    });
    req.flash('success', saved.newVersion ? `Saved as version ${saved.version}. Past attempts keep the version they answered.` : 'Question saved.');
    return res.redirect(`/admin/questions/${question.id}`);
  } catch (err) {
    if (!(err instanceof repo.QuestionError)) throw err;
    res.locals.flash.push({ type: 'danger', message: 'The question was not saved. Fix the problems listed below.' });
    return renderForm(req, res, { question, authoring: types.normalise(authoring), meta: { ...meta }, tags, errors: err.errors.length ? err.errors : [{ field: '_form', message: err.message }], status: 422 });
  }
}

// ---------------------------------------------------------------- Show / preview / versions

async function show(req, res) {
  const question = await loadOr404(req.params.id);
  const cur = question.current;
  const view = types.candidateView(cur.version, cur.options, cur.settings, { shuffleOptions: false });
  const children = [];
  for (const c of question.children) {
    const full = await repo.loadQuestion(c.id);
    children.push({ ...full, view: types.candidateView(full.current.version, full.current.options, full.current.settings) });
  }
  const versions = await db()('question_versions as v').leftJoin('users as u', 'u.id', 'v.created_by').where('v.question_id', question.id).orderBy('v.version_no', 'desc').select('v.id', 'v.version_no', 'v.created_at', 'v.published_at', 'v.change_note', 'u.full_name');
  const reports = await db()('question_reports').where({ question_id: question.id, status: 'open' }).count('* as n').first();
  const usage = await db()('exam_questions as eq').join('exams as e', 'e.id', 'eq.exam_id').whereNull('e.deleted_at').where('eq.question_id', question.id).select('e.id', 'e.title', 'e.status');
  const blocker = await repo.editBlocker(req.user, question);
  res.render('admin/questions/show', {
    title: `Question #${question.id}`,
    layout: 'layouts/app',
    q: question,
    view,
    children,
    versions,
    usage,
    openReports: Number(reports.n),
    canEdit: !blocker,
    editBlocker: blocker,
    TYPES: types.TYPES,
    STATUS_BADGE,
    STATUS_LABEL,
    parent: question.parent_id ? await db()('questions').where({ id: question.parent_id }).first('id', 'stem_text') : null,
    breadcrumbs: crumbs({ label: `#${question.id}` }),
  });
}

async function versionShow(req, res) {
  const question = await loadOr404(req.params.id);
  const v = await db()('question_versions').where({ id: req.params.vid, question_id: question.id }).first();
  if (!v) throw notFound('That version does not exist.');
  const loaded = await repo.loadVersion(v.id);
  res.render('admin/questions/version', {
    title: `Question #${question.id} · v${v.version_no}`,
    layout: 'layouts/app',
    q: question,
    v: loaded,
    view: types.candidateView(loaded.version, loaded.options, loaded.settings),
    isCurrent: v.id === question.current_version_id,
    TYPES: types.TYPES,
    breadcrumbs: crumbs({ label: `#${question.id}`, href: `/admin/questions/${question.id}` }, { label: `Version ${v.version_no}` }),
  });
}

// ---------------------------------------------------------------- Workflow, duplicate, delete

async function transition(req, res) {
  const { action } = req.params;
  try {
    const r = await repo.transition(Number(req.params.id), action, req.user, { note: req.body.note });
    await audit.record(req, `question.${action}`, { entityType: 'question', entityId: req.params.id, before: { status: r.from }, after: { status: r.to, note: req.body.note || null } });
    req.flash('success', { submit: 'Sent for review.', approve: 'Approved and published.', reject: 'Sent back to the author.', publish: 'Published — it can now be used in exams.', retire: 'Retired — it will no longer be drawn into new attempts.', to_draft: 'Moved back to draft.' }[action]);
  } catch (err) {
    if (!(err instanceof repo.QuestionError)) throw err;
    req.flash('danger', err.message);
  }
  return res.redirect(req.body.back === 'list' ? '/admin/questions' : `/admin/questions/${req.params.id}`);
}

async function duplicateQuestion(req, res) {
  const src = await loadOr404(req.params.id);
  const scope = await repo.authorScope(req.user);
  if (scope && !scope.includes(src.category_id)) throw forbidden('You can only duplicate questions in your assigned categories.');
  const saved = await repo.duplicate(src.id, req.user);
  await audit.record(req, 'question.duplicate', { entityType: 'question', entityId: saved.id, after: { source: src.id } });
  req.flash('success', `Copied to new draft #${saved.id}.`);
  return res.redirect(`/admin/questions/${saved.id}/edit`);
}

async function destroy(req, res) {
  const q = await loadOr404(req.params.id);
  const now = new Date();
  await db().transaction(async (trx) => {
    await trx('questions').where({ id: q.id }).update({ deleted_at: now });
    await trx('questions').where({ parent_id: q.id }).whereNull('deleted_at').update({ deleted_at: now });
  });
  await audit.record(req, 'question.delete', { entityType: 'question', entityId: q.id, before: { status: q.status, stem: (q.stem_text || '').slice(0, 300) } });
  req.flash('success', `Question #${q.id} moved to the recycle bin.`);
  return res.redirect(q.parent_id ? `/admin/questions/${q.parent_id}` : '/admin/questions');
}

// ---------------------------------------------------------------- Bulk actions

const BULK = {
  submit: 'questions.create',
  publish: 'questions.publish',
  retire: 'questions.publish',
  move_category: 'questions.edit_any',
  add_tags: 'questions.edit_any',
  delete: 'questions.delete',
};

async function bulk(req, res) {
  const action = req.body.bulk_action;
  const ids = [].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  const back = req.body.back && String(req.body.back).startsWith('/admin/questions') ? req.body.back : '/admin/questions';
  if (!BULK[action]) {
    req.flash('danger', 'Choose a bulk action.');
    return res.redirect(back);
  }
  if (!ids.length) {
    req.flash('danger', 'Select at least one question.');
    return res.redirect(back);
  }
  if (!req.user.can(BULK[action])) throw forbidden();
  let ok = 0;
  const failures = [];
  if (action === 'submit' || action === 'publish' || action === 'retire') {
    for (const id of ids) {
      try {
        await repo.transition(id, action, req.user);
        ok += 1;
      } catch (err) {
        failures.push(`#${id}: ${err.message}`);
      }
    }
  } else if (action === 'move_category') {
    const cat = await db()('categories').where({ id: intOrNull(req.body.category_id) }).first();
    if (!cat) {
      req.flash('danger', 'Choose the category to move the questions to.');
      return res.redirect(back);
    }
    ok = await db()('questions').whereIn('id', ids).whereNull('deleted_at').update({ category_id: cat.id });
    await db()('questions').whereIn('parent_id', ids).whereNull('deleted_at').update({ category_id: cat.id });
  } else if (action === 'add_tags') {
    const tags = repo.parseTagInput(req.body.tags || '');
    if (!tags.length) {
      req.flash('danger', 'Type the tags to add.');
      return res.redirect(back);
    }
    await repo.addTags(ids, tags.map((t) => t.name), db());
    ok = ids.length;
  } else if (action === 'delete') {
    ok = await db()('questions').whereIn('id', ids).whereNull('deleted_at').update({ deleted_at: new Date() });
    await db()('questions').whereIn('parent_id', ids).whereNull('deleted_at').update({ deleted_at: new Date() });
  }
  await audit.record(req, `question.bulk_${action}`, { entityType: 'question', entityId: ids.slice(0, 20).join(','), after: { ids, ok, failures: failures.length, category_id: req.body.category_id || null, tags: req.body.tags || null } });
  if (ok) req.flash('success', `${ok} question${ok === 1 ? '' : 's'} updated.`);
  if (failures.length) req.flash('warning', `${failures.length} skipped — ${failures.slice(0, 3).join(' · ')}${failures.length > 3 ? ' …' : ''}`);
  return res.redirect(back);
}

// ---------------------------------------------------------------- Duplicates

async function duplicates(req, res) {
  const groups = await repo.duplicateGroups();
  res.render('admin/questions/duplicates', { title: 'Duplicate finder', layout: 'layouts/app', groups, TYPES: types.TYPES, STATUS_BADGE, STATUS_LABEL, breadcrumbs: crumbs({ label: 'Duplicates' }) });
}

// ---------------------------------------------------------------- Media

const MEDIA_DIR = () => storagePath('uploads', 'private', 'questions');

async function uploadMedia(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });
  const kind = sniff(req.file.buffer);
  if (!kind || !['png', 'jpg', 'webp', 'gif'].includes(kind.ext)) return res.status(400).json({ error: 'Use a PNG, JPG, WebP or GIF image.' });
  const uuid = crypto.randomUUID();
  const file = `${uuid}.${kind.ext}`;
  fs.mkdirSync(MEDIA_DIR(), { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR(), file), req.file.buffer);
  const dims = imageSize(req.file.buffer, kind.ext);
  await db()('question_media').insert({ uuid, uploaded_by: req.user.id, path: file, original_name: String(req.file.originalname || '').slice(0, 255), mime: kind.mime, size_bytes: req.file.size, width: dims.width, height: dims.height, alt: null });
  return res.json({ uuid, url: `/qmedia/${uuid}`, width: dims.width, height: dims.height });
}

/** Reads width/height from PNG, JPEG, GIF and WebP headers (no native image library needed). */
function imageSize(buf, ext) {
  try {
    if (ext === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (ext === 'webp') {
      const chunk = buf.slice(12, 16).toString();
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (ext === 'jpg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return { width: null, height: null };
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch {
    /* fall through */
  }
  return { width: null, height: null };
}

/** Serves question images to signed-in users (exam content is not public). */
async function serveMedia(req, res, next) {
  if (!/^[0-9a-f-]{36}$/.test(req.params.uuid)) return next();
  const row = await db()('question_media').where({ uuid: req.params.uuid }).first();
  if (!row) return next();
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(row.mime);
  return res.sendFile(path.join(MEDIA_DIR(), row.path), (err) => {
    if (err) next();
  });
}

// ---------------------------------------------------------------- Report inbox

async function reportsIndex(req, res) {
  const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const q = db()('question_reports as r')
    .join('questions as q', 'q.id', 'r.question_id')
    .leftJoin('users as u', 'u.id', 'r.user_id')
    .leftJoin('users as rb', 'rb.id', 'r.resolved_by')
    .where('r.status', status)
    .orderBy('r.created_at', status === 'open' ? 'asc' : 'desc')
    .select('r.*', 'q.stem_text', 'q.type', 'u.full_name as reporter', 'rb.full_name as resolver');
  const pager = await paginate(q, { page: req.query.page, perPage: 25 });
  const counts = await db()('question_reports').groupBy('status').select('status', db().raw('COUNT(*) as n'));
  res.render('admin/questions/reports', {
    title: 'Reported questions',
    layout: 'layouts/app',
    pager,
    status,
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    query: req.query,
    breadcrumbs: crumbs({ label: 'Reports' }),
  });
}

async function reportResolve(req, res) {
  const r = await db()('question_reports').where({ id: req.params.id }).first();
  if (!r) throw notFound('That report does not exist.');
  const status = req.params.action === 'dismiss' ? 'dismissed' : 'resolved';
  const note = String(req.body.note || '').trim().slice(0, 2000) || null;
  await db()('question_reports').where({ id: r.id }).update({ status, resolution_note: note, resolved_by: req.user.id, resolved_at: new Date() });
  await audit.record(req, `question_report.${status}`, { entityType: 'question_report', entityId: r.id, before: { status: r.status }, after: { status, note } });
  req.flash('success', status === 'resolved' ? 'Report marked as resolved.' : 'Report dismissed.');
  return res.redirect('/admin/questions/reports');
}

// ---------------------------------------------------------------- Author categories (on the user page)

async function setAuthorCategories(req, res) {
  const userId = Number(req.params.id);
  const ids = [].concat(req.body.category_ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const valid = ids.length ? await db()('categories').whereIn('id', ids).pluck('id') : [];
  const before = await db()('author_categories').where({ user_id: userId }).pluck('category_id');
  await db().transaction(async (trx) => {
    await trx('author_categories').where({ user_id: userId }).del();
    if (valid.length) await trx('author_categories').insert(valid.map((category_id) => ({ user_id: userId, category_id })));
  });
  await audit.record(req, 'user.author_categories', { entityType: 'user', entityId: userId, before: { category_ids: before }, after: { category_ids: valid } });
  req.flash('success', 'Authoring categories saved.');
  return res.redirect(`/admin/users/${userId}#authoring`);
}

module.exports = {
  index,
  chooseType,
  newForm,
  create,
  editForm,
  update,
  show,
  versionShow,
  transition,
  duplicateQuestion,
  destroy,
  bulk,
  duplicates,
  uploadMedia,
  serveMedia,
  reportsIndex,
  reportResolve,
  setAuthorCategories,
  imageSize,
  STATUS_LABEL,
};
