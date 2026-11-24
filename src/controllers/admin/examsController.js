'use strict';

const { db } = require('../../config/db');
const audit = require('../../services/audit');
const catalogue = require('../../services/catalogue');
const repo = require('../../services/exams/repository');
const { buildSummary } = require('../../services/exams/summary');
const { prePublishChecklist, canPublish } = require('../../services/exams/checklist');
const { generateInstructions } = require('../../services/instructions');
const questionRepo = require('../../services/questions/repository');
const types = require('../../services/questions/types');
const { paginate } = require('../../utils/paginate');
const { utcToLocalInput, formatDateTime } = require('../../utils/time');
const { toMajor } = require('../../utils/money');
const { notFound } = require('../../utils/errors');
const { wantsJson } = require('../../middleware/auth');

const intOrNull = (v) => (v === undefined || v === null || v === '' || !/^\d+$/.test(String(v)) ? null : Number(v));
const STATUS_BADGE = { draft: 'badge-gray', published: 'badge-green', archived: 'badge-red' };

const BUILDER_TABS = [
  ['basics', 'Basics'],
  ['content', 'Content'],
  ['timing', 'Timing'],
  ['attempts', 'Attempts & access'],
  ['delivery', 'Delivery'],
  ['scoring', 'Scoring'],
  ['release', 'Results'],
  ['integrity', 'Integrity'],
  ['certificate', 'Certificate'],
  ['instructions', 'Instructions'],
  ['publish', 'Publish'],
];

const crumbs = (...rest) => [{ label: 'Admin', href: '/admin' }, { label: 'Exams', href: '/admin/exams' }, ...rest];

/** Sends ExamError details back as JSON (autosave) or as a flash + redirect. */
function handleError(req, res, err, back) {
  if (!(err instanceof repo.ExamError)) throw err;
  if (err.status === 404) throw notFound(err.message);
  if (wantsJson(req)) return res.status(err.status).json({ ok: false, error: err.message, errors: err.errors });
  req.flash('error', [err.message, ...err.errors.map((e) => e.message)].filter((m, i, a) => a.indexOf(m) === i).join(' '));
  if (err.errors.length) req.session.examErrors = err.errors;
  return res.redirect(back);
}

async function loadOr404(id) {
  try {
    return await repo.loadFull(id);
  } catch (e) {
    if (e instanceof repo.ExamError && e.status === 404) throw notFound('Exam not found.');
    throw e;
  }
}

// ---------------------------------------------------------------- List & create

async function index(req, res) {
  const f = {
    q: String(req.query.q || '').slice(0, 200),
    type: repo.EXAM_TYPES[req.query.type] ? req.query.type : '',
    status: STATUS_BADGE[req.query.status] ? req.query.status : '',
  };
  const query = repo
    .listQuery(f)
    .leftJoin('certifications as ce', 'ce.id', 'e.certification_id')
    .select(
      'e.id', 'e.title', 'e.type', 'e.status', 'e.content_mode', 'e.duration_minutes', 'e.pass_mark', 'e.pass_mark_type', 'e.is_paid', 'e.price_kobo', 'e.version', 'e.updated_at', 'e.published_at', 'e.certificate_enabled', 'e.ai_generation_id',
      'c.name as category_name', 'ce.exam_code',
      db().raw('(SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) as item_count'),
      db().raw('(SELECT COALESCE(SUM(r.question_count), 0) FROM exam_blueprint_rules r WHERE r.exam_id = e.id) as rule_count'),
      db().raw('(SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id) as attempt_count'),
    )
    .orderBy('e.updated_at', 'desc');
  const pager = await paginate(query, { page: req.query.page });
  const counts = await db()('exams').whereNull('deleted_at').groupBy('status').select('status', db().raw('COUNT(*) as n'));
  res.render('admin/exams/index', {
    title: 'Exams',
    layout: 'layouts/app',
    pager,
    f,
    query: req.query,
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    EXAM_TYPES: repo.EXAM_TYPES,
    STATUS_BADGE,
    categories: await catalogue.categoryTree(),
    certifications: await catalogue.certificationsWithDomains(),
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Exams' }],
  });
}

async function create(req, res) {
  try {
    const id = await repo.createExam({ ...req.body, user: req.user });
    await audit.record(req, 'exam.create', { entityType: 'exam', entityId: id, after: { title: req.body.title, type: req.body.type } });
    req.flash('success', 'Exam created. Work through the tabs, then publish when the checklist is green.');
    return res.redirect(`/admin/exams/${id}/content`);
  } catch (err) {
    return handleError(req, res, err, '/admin/exams?new=1');
  }
}

// ---------------------------------------------------------------- Builder

async function builder(req, res) {
  const tab = BUILDER_TABS.some((t) => t[0] === req.params.tab) ? req.params.tab : 'basics';
  const id = Number(req.params.id);
  const full = await loadOr404(id);
  const summary = buildSummary(full);
  const checklist = prePublishChecklist(full);
  const sessionErrors = req.session.examErrors || [];
  delete req.session.examErrors;
  const tz = res.locals.fmt.tz;
  const data = {
    title: `${full.exam.title} · ${BUILDER_TABS.find((t) => t[0] === tab)[1]}`,
    layout: 'layouts/app',
    tab,
    query: req.query,
    TABS: BUILDER_TABS,
    full,
    e: full.exam,
    s: full.settings,
    summary,
    checklist,
    ready: canPublish(checklist),
    unpublishedChanges: full.exam.status === 'published' && full.exam.published_at && new Date(full.exam.updated_at) - new Date(full.exam.published_at) >= 1000,
    errors: Object.fromEntries(sessionErrors.map((x) => [x.field, x.message])),
    EXAM_TYPES: repo.EXAM_TYPES,
    STATUS_BADGE,
    QTYPES: types.TYPES,
    toLocal: (d) => utcToLocalInput(d, tz),
    major: (k) => (k === null || k === undefined ? '' : String(toMajor(k))),
    breadcrumbs: crumbs({ label: full.exam.title }),
  };

  if (['basics', 'content'].includes(tab)) {
    data.categories = await catalogue.categoryTree();
    data.certifications = await catalogue.certificationsWithDomains();
    data.programmes = await db()('training_programmes').orderBy('name').select('id', 'name');
  }
  if (tab === 'content') {
    // Bank search panel for fixed lists
    const b = {
      q: String(req.query.bq || '').slice(0, 200),
      type: types.TYPES[req.query.btype] ? req.query.btype : '',
      category: intOrNull(req.query.bcategory),
      certification: intOrNull(req.query.bcert) || full.exam.certification_id,
      status: req.query.bstatus === 'any' ? '' : 'published',
    };
    data.bank = b;
    if (full.exam.content_mode === 'fixed') {
      const query = questionRepo
        .filteredQuery({ q: b.q, type: b.type, status: b.status, certification_id: b.certification, category_ids: b.category ? await catalogue.descendantIds(b.category) : null })
        .where((w) => {
          w.whereNull('q.organisation_id');
          if (full.exam.organisation_id) w.orWhere('q.organisation_id', full.exam.organisation_id);
        })
        .whereNotIn('q.id', full.items.map((i) => i.question_id).concat([0]))
        .leftJoin('certification_domains as d', 'd.id', 'q.domain_id')
        .select('q.id', 'q.type', 'q.status', 'q.stem_text', 'q.difficulty', 'q.default_marks', 'd.code as domain_code', 'd.name as domain_name')
        .orderBy('q.id', 'desc');
      data.bankPager = await paginate(query, { page: req.query.bpage, perPage: 10 });
    }
    data.tags = await db()('tags').orderBy('name').limit(500).select('id', 'name', 'slug');
  }
  if (tab === 'scoring') data.programmes = await db()('training_programmes').orderBy('name').select('id', 'name');
  if (tab === 'attempts') {
    data.overrides = await repo.listOverrides(id);
    data.organisations = await db()('organisations').orderBy('name').limit(500).select('id', 'name');
    data.otherExams = await db()('exams').whereNull('deleted_at').whereNot({ id }).orderBy('title').select('id', 'title');
  }
  if (tab === 'instructions') {
    const sample = { full_name: req.user.full_name, accommodations: req.query.extra ? { extra_time_percent: 25 } : null };
    data.preview = req.query.extra;
    data.instructions = generateInstructions(summary, req.query.as === 'candidate' || req.query.extra ? sample : null, {
      attemptsUsed: req.query.as === 'candidate' || req.query.extra ? 0 : undefined,
      formatDateTime: (d) => formatDateTime(d, { timezone: tz }),
    });
  }
  if (tab === 'publish') data.versions = await repo.listVersions(id);
  res.render('admin/exams/builder', data);
}

async function saveTab(req, res) {
  const id = Number(req.params.id);
  const tab = req.params.tab;
  try {
    const { before, patch, settingsPatch } = await repo.saveTab(id, tab, req.body, req.user, { timezone: res.locals.fmt.tz });
    await audit.record(req, 'exam.update', { entityType: 'exam', entityId: id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), after: { ...patch, ...settingsPatch } });
    if (wantsJson(req)) {
      const full = await repo.loadFull(id);
      const checklist = prePublishChecklist(full);
      return res.json({ ok: true, savedAt: new Date().toISOString(), ready: canPublish(checklist), open: checklist.filter((c) => !c.ok).length, summary: buildSummary(full) });
    }
    req.flash('success', 'Saved.');
    return res.redirect(`/admin/exams/${id}/${tab}`);
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/${tab}`);
  }
}

// ---------------------------------------------------------------- Content: sections, items, rules, bands

async function sectionSave(req, res) {
  const id = Number(req.params.id);
  try {
    await repo.getExam(id);
    const sid = await repo.saveSection(id, intOrNull(req.params.sid), req.body);
    await audit.record(req, req.params.sid ? 'exam.section.update' : 'exam.section.create', { entityType: 'exam', entityId: id, after: { section_id: sid, title: req.body.title } });
    req.flash('success', req.params.sid ? 'Section updated.' : 'Section added.');
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/content`);
  }
  return res.redirect(`/admin/exams/${id}/content`);
}

async function sectionDelete(req, res) {
  const id = Number(req.params.id);
  await repo.deleteSection(id, Number(req.params.sid));
  await audit.record(req, 'exam.section.delete', { entityType: 'exam', entityId: id, before: { section_id: Number(req.params.sid) } });
  req.flash('success', 'Section removed. Its questions were moved to “General”.');
  res.redirect(`/admin/exams/${id}/content`);
}

async function itemsAdd(req, res) {
  const id = Number(req.params.id);
  try {
    const ids = [].concat(req.body.question_ids || []);
    const r = await repo.addQuestions(id, ids, intOrNull(req.body.section_id));
    await audit.record(req, 'exam.questions.add', { entityType: 'exam', entityId: id, after: { question_ids: ids.map(Number), added: r.added } });
    req.flash(r.added ? 'success' : 'warning', r.added ? `${r.added} question${r.added === 1 ? '' : 's'} added.${r.skipped ? ` ${r.skipped} skipped (already in the exam or not available).` : ''}` : 'No questions were added — select questions that are not already in the exam.');
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/content`);
  }
  return res.redirect(req.body.back && String(req.body.back).startsWith(`/admin/exams/${id}/`) ? req.body.back : `/admin/exams/${id}/content`);
}

async function itemsUpdate(req, res) {
  const id = Number(req.params.id);
  try {
    if (req.body.action === 'remove') {
      const ids = [].concat(req.body.item_ids || []);
      const n = await repo.removeItems(id, ids);
      await audit.record(req, 'exam.questions.remove', { entityType: 'exam', entityId: id, before: { item_ids: ids.map(Number) } });
      req.flash('success', `${n} question${n === 1 ? '' : 's'} removed from the exam.`);
    } else if (req.body.action === 'reorder') {
      await repo.reorder('exam_questions', id, [].concat(req.body.order || []));
      if (wantsJson(req)) return res.json({ ok: true });
    } else if (req.body.action === 'move') {
      const ids = [].concat(req.body.item_ids || []);
      for (const itemId of ids) await repo.updateItem(id, Number(itemId), { section_id: req.body.section_id || null });
      req.flash('success', 'Questions moved.');
    } else {
      // Per-item marks/section (autosaved from the content table)
      await repo.updateItem(id, Number(req.body.item_id), { marks: req.body.marks, section_id: req.body.section_id });
      if (wantsJson(req)) return res.json({ ok: true });
      req.flash('success', 'Saved.');
    }
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/content`);
  }
  return res.redirect(`/admin/exams/${id}/content`);
}

async function ruleSave(req, res) {
  const id = Number(req.params.id);
  try {
    const rid = await repo.saveRule(id, intOrNull(req.params.rid), req.body);
    await audit.record(req, req.params.rid ? 'exam.rule.update' : 'exam.rule.create', { entityType: 'exam', entityId: id, after: { rule_id: rid, ...req.body, _csrf: undefined } });
    req.flash('success', req.params.rid ? 'Rule updated.' : 'Rule added.');
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/content`);
  }
  return res.redirect(`/admin/exams/${id}/content`);
}

async function rulePreview(req, res) {
  try {
    res.json({ ok: true, ...(await repo.previewRule(Number(req.params.id), req.query)) });
  } catch (err) {
    if (!(err instanceof repo.ExamError)) throw err;
    res.status(err.status).json({ ok: false, error: err.message, errors: err.errors });
  }
}

async function ruleDelete(req, res) {
  const id = Number(req.params.id);
  await repo.deleteRule(id, Number(req.params.rid));
  await audit.record(req, 'exam.rule.delete', { entityType: 'exam', entityId: id, before: { rule_id: Number(req.params.rid) } });
  req.flash('success', 'Rule removed.');
  res.redirect(`/admin/exams/${id}/content`);
}

async function bandsSave(req, res) {
  const id = Number(req.params.id);
  try {
    const raw = req.body.bands || {};
    const bands = Array.isArray(raw) ? raw : Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map((k) => raw[k]);
    await repo.saveBands(id, bands);
    await audit.record(req, 'exam.bands.update', { entityType: 'exam', entityId: id, after: { bands } });
    req.flash('success', 'Proficiency bands saved.');
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/scoring`);
  }
  return res.redirect(`/admin/exams/${id}/scoring`);
}

// ---------------------------------------------------------------- Access & overrides

async function accessAdd(req, res) {
  const id = Number(req.params.id);
  try {
    await repo.addAccessRule(id, req.body.rule_type, req.body.value);
    await audit.record(req, 'exam.access.add', { entityType: 'exam', entityId: id, after: { rule_type: req.body.rule_type, value: req.body.value } });
    req.flash('success', 'Access rule added.');
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/attempts`);
  }
  return res.redirect(`/admin/exams/${id}/attempts`);
}

async function accessRemove(req, res) {
  const id = Number(req.params.id);
  await repo.removeAccessRule(id, Number(req.params.rid));
  await audit.record(req, 'exam.access.remove', { entityType: 'exam', entityId: id, before: { rule_id: Number(req.params.rid) } });
  req.flash('success', 'Access rule removed.');
  res.redirect(`/admin/exams/${id}/attempts`);
}

async function grantAttempts(req, res) {
  const id = Number(req.params.id);
  try {
    const r = await repo.grantAttempts(id, req.body, req.user.id);
    await audit.record(req, 'exam.attempts.grant', { entityType: 'exam', entityId: id, after: { user_id: r.user.id, email: r.user.email, extra_attempts: r.extra, reason: req.body.reason, reset_cooldown: !!req.body.reset_cooldown } });
    req.flash('success', `${r.extra} extra attempt${r.extra === 1 ? '' : 's'} granted to ${r.user.full_name}.`);
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/attempts`);
  }
  return res.redirect(`/admin/exams/${id}/attempts`);
}

// ---------------------------------------------------------------- Lifecycle

async function publish(req, res) {
  const id = Number(req.params.id);
  try {
    const v = await repo.publish(id, req.user, req.body.note);
    await audit.record(req, 'exam.publish', { entityType: 'exam', entityId: id, after: { version: v, note: req.body.note || null } });
    req.flash('success', `Published as version ${v}. Candidates now get this version; attempts already in progress keep theirs.`);
  } catch (err) {
    return handleError(req, res, err, `/admin/exams/${id}/publish`);
  }
  return res.redirect(`/admin/exams/${id}/publish`);
}

async function lifecycle(req, res) {
  const id = Number(req.params.id);
  const action = req.params.action;
  const exam = await repo.getExam(id).catch(() => null);
  if (!exam) throw notFound('Exam not found.');
  if (action === 'unpublish') {
    await repo.unpublish(id, req.user);
    req.flash('success', 'Unpublished. The exam is hidden from candidates; attempts in progress can still be finished.');
  } else if (action === 'archive') {
    await repo.archive(id, req.user);
    req.flash('success', 'Archived.');
  } else if (action === 'duplicate') {
    const newId = await repo.duplicateExam(id, req.user);
    await audit.record(req, 'exam.duplicate', { entityType: 'exam', entityId: newId, after: { from: id } });
    req.flash('success', 'Exam duplicated. You are now editing the copy.');
    return res.redirect(`/admin/exams/${newId}/basics`);
  } else if (action === 'delete') {
    try {
      await repo.softDelete(id, req.user);
    } catch (err) {
      return handleError(req, res, err, `/admin/exams/${id}/publish`);
    }
    await audit.record(req, 'exam.delete', { entityType: 'exam', entityId: id, before: { title: exam.title } });
    req.flash('success', 'Exam deleted.');
    return res.redirect('/admin/exams');
  }
  await audit.record(req, `exam.${action}`, { entityType: 'exam', entityId: id });
  return res.redirect(`/admin/exams/${id}/publish`);
}

async function versionShow(req, res) {
  const id = Number(req.params.id);
  const exam = await repo.getExam(id).catch(() => null);
  if (!exam) throw notFound('Exam not found.');
  let v;
  try {
    v = await repo.getVersion(id, Number(req.params.v));
  } catch {
    throw notFound('Version not found.');
  }
  res.render('admin/exams/version', {
    title: `${exam.title} · version ${v.version_no}`,
    layout: 'layouts/app',
    exam,
    v,
    instructions: generateInstructions(v.snapshot.summary, null, { formatDateTime: (d) => formatDateTime(d, { timezone: res.locals.fmt.tz }) }),
    breadcrumbs: crumbs({ label: exam.title, href: `/admin/exams/${id}/publish` }, { label: `Version ${v.version_no}` }),
  });
}

module.exports = { index, create, builder, saveTab, sectionSave, sectionDelete, itemsAdd, itemsUpdate, ruleSave, rulePreview, ruleDelete, bandsSave, accessAdd, accessRemove, grantAttempts, publish, lifecycle, versionShow, BUILDER_TABS };
