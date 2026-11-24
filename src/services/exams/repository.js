'use strict';

/**
 * Exams: create, load, edit by builder tab, sections, fixed question lists, blueprint rules (with live availability),
 * bands, access rules, attempt overrides, publish (immutable snapshot in exam_versions), duplicate.
 *
 * Candidates are always served from the latest published snapshot, so editing a live exam never changes an exam in
 * progress; the builder shows "unpublished changes" until the exam is published again.
 */
const crypto = require('crypto');
const { db } = require('../../config/db');
const { parseJson, toJson } = require('../../utils/json');
const { uniqueSlug } = require('../../utils/slug');
const { sanitizeRich } = require('../../utils/html');
const { toMinor } = require('../../utils/money');
const { localInputToUtc } = require('../../utils/time');
const { descendantIds } = require('../catalogue');
const types = require('../questions/types');
const S = require('./settings');
const { buildSummary } = require('./summary');
const { prePublishChecklist, canPublish } = require('./checklist');

const EXAM_TYPES = {
  pre_training: 'Pre-training diagnostic',
  post_training: 'Post-training assessment',
  practice: 'Practice test',
  mock: 'Certification mock exam',
  past_questions: 'Past questions',
  live_quiz: 'Live quiz',
  assignment: 'Assignment',
};

class ExamError extends Error {
  constructor(message, errors = [], status = 422) {
    super(message);
    this.errors = errors;
    this.status = status;
  }
}

const str = (v, max = 255) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const intOrNull = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
const numOrNull = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------- Create / list

async function createExam({ title, type, category_id = null, certification_id = null, content_mode = 'fixed', organisation_id = null, user, aiGenerationId = null }, knex = db()) {
  const errors = [];
  if (!str(title)) errors.push({ field: 'title', message: 'Enter a title.' });
  if (!EXAM_TYPES[type]) errors.push({ field: 'type', message: 'Choose an exam type.' });
  if (errors.length) throw new ExamError('The exam could not be created.', errors);
  const d = S.typeDefaults(type);
  return knex.transaction(async (trx) => {
    const [id] = await trx('exams').insert({
      uuid: crypto.randomUUID(),
      title: str(title, 200),
      slug: await uniqueSlug(trx, 'exams', title),
      type,
      category_id: intOrNull(category_id),
      certification_id: intOrNull(certification_id),
      content_mode: content_mode === 'blueprint' ? 'blueprint' : 'fixed',
      organisation_id,
      visibility: organisation_id ? 'org_private' : 'public',
      ...d.columns,
      settings: toJson(d.settings),
      ai_generation_id: aiGenerationId,
      created_by: user ? user.id : null,
      updated_by: user ? user.id : null,
    });
    if (type === 'pre_training') await trx('exam_bands').insert(S.DEFAULT_BANDS.map((b, i) => ({ exam_id: id, ...b, display_order: i })));
    return id;
  });
}

function listQuery(filters = {}, knex = db()) {
  const q = knex('exams as e').whereNull('e.deleted_at').leftJoin('categories as c', 'c.id', 'e.category_id');
  if (filters.q) q.where('e.title', 'like', `%${String(filters.q).replace(/[%_\\]/g, '\\$&')}%`);
  if (filters.type) q.where('e.type', filters.type);
  if (filters.status) q.where('e.status', filters.status);
  if (filters.category_id) q.where('e.category_id', filters.category_id);
  if (filters.organisation_id !== undefined) {
    if (filters.organisation_id === null) q.whereNull('e.organisation_id');
    else q.where('e.organisation_id', filters.organisation_id);
  }
  return q;
}

// ---------------------------------------------------------------- Load

async function getExam(id, knex = db()) {
  const exam = await knex('exams').where({ id }).whereNull('deleted_at').first();
  if (!exam) throw new ExamError('Exam not found.', [], 404);
  return exam;
}

/** Scope of questions an exam may use: platform questions, plus the exam's own workspace questions. */
function scopeQuestions(q, exam) {
  q.where((w) => {
    w.whereNull('q.organisation_id');
    if (exam.organisation_id) w.orWhere('q.organisation_id', exam.organisation_id);
  });
}

/**
 * Questions matching a blueprint rule (published, top-level, not case studies). Returns { q } — wrapped because a
 * Knex builder is thenable and would run if returned directly from an async function.
 */
async function ruleQuery(rule, exam, knex = db()) {
  const q = knex('questions as q').whereNull('q.deleted_at').whereNull('q.parent_id').where('q.status', 'published').whereNot('q.type', 'case_study');
  scopeQuestions(q, exam);
  if (rule.category_id) q.whereIn('q.category_id', await descendantIds(rule.category_id, knex));
  if (rule.certification_id) q.where('q.certification_id', rule.certification_id);
  if (rule.domain_id) q.where('q.domain_id', rule.domain_id);
  if (rule.tag_id) q.whereExists((s) => s.select(1).from('question_tags as qt').whereRaw('qt.question_id = q.id').where('qt.tag_id', rule.tag_id));
  if (rule.difficulty_min) q.where('q.difficulty', '>=', rule.difficulty_min);
  if (rule.difficulty_max) q.where('q.difficulty', '<=', rule.difficulty_max);
  const t = parseJson(rule.question_types, []) || [];
  if (t.length) q.whereIn('q.type', t);
  return { q };
}

/** { available, pool_types, avg_marks } for a rule. */
async function ruleAvailability(rule, exam, knex = db()) {
  const { q: base } = await ruleQuery(rule, exam, knex);
  const [{ n, avg }] = await base.clone().count({ n: '*' }).avg({ avg: 'q.default_marks' });
  const typeRows = await base.clone().distinct('q.type');
  return { available: Number(n), pool_types: typeRows.map((r) => r.type).sort(), avg_marks: avg === null ? null : Number(avg) };
}

async function loadFull(id, knex = db()) {
  const exam = await getExam(id, knex);
  const settings = S.withDefaults(parseJson(exam.settings, {}));
  const [sections, itemsRaw, rulesRaw, bands, access] = await Promise.all([
    knex('exam_sections').where({ exam_id: id }).orderBy(['display_order', 'id']),
    knex('exam_questions as eq')
      .join('questions as q', 'q.id', 'eq.question_id')
      .where('eq.exam_id', id)
      .orderBy(['eq.display_order', 'eq.id'])
      .select('eq.id', 'eq.question_id', 'eq.section_id', 'eq.marks as marks_override', 'eq.display_order', 'q.type', 'q.status', 'q.default_marks', 'q.stem_text', 'q.difficulty', 'q.deleted_at', 'q.organisation_id'),
    knex('exam_blueprint_rules as r')
      .leftJoin('categories as c', 'c.id', 'r.category_id')
      .leftJoin('certifications as ce', 'ce.id', 'r.certification_id')
      .leftJoin('certification_domains as d', 'd.id', 'r.domain_id')
      .leftJoin('tags as t', 't.id', 'r.tag_id')
      .where('r.exam_id', id)
      .orderBy(['r.display_order', 'r.id'])
      .select('r.*', 'c.name as category_name', 'ce.name as certification_name', 'ce.exam_code', 'd.name as domain_name', 'd.code as domain_code', 't.name as tag_name'),
    knex('exam_bands as b').leftJoin('training_programmes as p', 'p.id', 'b.programme_id').where('b.exam_id', id).orderBy('b.min_percent').select('b.*', 'p.name as programme_name'),
    knex('exam_access_rules').where({ exam_id: id }).orderBy('id'),
  ]);

  // Case-study children
  const caseIds = itemsRaw.filter((i) => i.type === 'case_study').map((i) => i.question_id);
  const children = caseIds.length ? await knex('questions').whereIn('parent_id', caseIds).whereNull('deleted_at').select('parent_id', 'type', 'default_marks') : [];
  const items = itemsRaw.map((it) => {
    const kids = children.filter((c) => c.parent_id === it.question_id);
    const caseMarks = kids.reduce((n, c) => n + Number(c.default_marks), 0);
    return {
      ...it,
      marks: it.marks_override !== null ? Number(it.marks_override) : it.type === 'case_study' ? caseMarks : Number(it.default_marks),
      child_count: kids.length,
      child_types: [...new Set(kids.map((c) => c.type))],
      status: it.deleted_at ? 'deleted' : it.status,
    };
  });

  const rules = [];
  for (const r of rulesRaw) {
    const qt = parseJson(r.question_types, []) || [];
    rules.push({ ...r, question_types: qt, ...(await ruleAvailability(r, exam, knex)) });
  }
  return { exam, settings, sections, items, rules, bands, access };
}

// ---------------------------------------------------------------- Tabs (autosave)

const TABS = ['basics', 'timing', 'attempts', 'delivery', 'scoring', 'release', 'integrity', 'certificate'];

/**
 * Validates and saves one builder tab. Returns the saved column patch; throws ExamError with field errors.
 * Unchanged tabs/fields are not touched, so two admins editing different tabs do not overwrite each other.
 */
async function saveTab(id, tab, input, user, { timezone = 'Africa/Lagos' } = {}, knex = db()) {
  if (!TABS.includes(tab)) throw new ExamError('Unknown tab.', [], 400);
  const exam = await getExam(id, knex);
  const current = S.withDefaults(parseJson(exam.settings, {}));
  const i = input || {};
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const patch = {};
  const settingsPatch = {};

  switch (tab) {
    case 'basics': {
      patch.title = str(i.title, 200);
      if (!patch.title) add('title', 'Enter a title.');
      if (!EXAM_TYPES[i.type]) add('type', 'Choose an exam type.');
      else patch.type = i.type;
      patch.category_id = intOrNull(i.category_id);
      patch.certification_id = intOrNull(i.certification_id);
      patch.programme_id = intOrNull(i.programme_id);
      patch.short_description = str(i.short_description, 300) || null;
      patch.description_html = sanitizeRich(i.description_html || '') || null;
      patch.language = str(i.language, 10) || 'en';
      patch.difficulty_label = str(i.difficulty_label, 40) || null;
      patch.content_mode = i.content_mode === 'blueprint' ? 'blueprint' : 'fixed';
      if (i.slug !== undefined) {
        const slug = str(i.slug, 200);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) add('slug', 'Use lowercase letters, numbers and hyphens.');
        else if (await knex('exams').where({ slug }).whereNot({ id }).first('id')) add('slug', 'Another exam already uses this address.');
        else patch.slug = slug;
      }
      if (patch.certification_id && !(await knex('certifications').where({ id: patch.certification_id }).first('id'))) add('certification_id', 'Certification not found.');
      if (patch.category_id && !(await knex('categories').where({ id: patch.category_id }).first('id'))) add('category_id', 'Category not found.');
      break;
    }
    case 'timing': {
      patch.duration_minutes = intOrNull(i.duration_minutes);
      if (patch.duration_minutes !== null && (patch.duration_minutes < 1 || patch.duration_minutes > 1440)) add('duration_minutes', 'Duration must be between 1 and 1,440 minutes.');
      patch.grace_seconds = intOrNull(i.grace_seconds) || 0;
      if (patch.grace_seconds < 0 || patch.grace_seconds > 600) add('grace_seconds', 'Grace period must be 0–600 seconds.');
      patch.per_question_seconds = intOrNull(i.per_question_seconds);
      if (patch.per_question_seconds !== null && (patch.per_question_seconds < 10 || patch.per_question_seconds > 3600)) add('per_question_seconds', 'Per-question time must be 10–3,600 seconds.');
      patch.available_from = localInputToUtc(i.available_from, timezone);
      patch.available_until = localInputToUtc(i.available_until, timezone);
      if (patch.available_from && patch.available_until && patch.available_from >= patch.available_until) add('available_until', 'The closing time must be after the opening time.');
      settingsPatch.timing = S.normaliseGroup('timing', i, current);
      break;
    }
    case 'attempts': {
      patch.max_attempts = intOrNull(i.max_attempts);
      if (patch.max_attempts !== null && (patch.max_attempts < 1 || patch.max_attempts > 100)) add('max_attempts', 'Attempts must be 1–100, or empty for unlimited.');
      patch.cooldown_minutes = intOrNull(i.cooldown_minutes) || 0;
      if (patch.cooldown_minutes < 0 || patch.cooldown_minutes > 525600) add('cooldown_minutes', 'Cooldown must be 0 or more minutes (up to a year).');
      patch.score_policy = ['best', 'latest', 'average', 'first'].includes(i.score_policy) ? i.score_policy : 'best';
      patch.visibility = ['public', 'unlisted', 'org_private', 'invite_code'].includes(i.visibility) ? i.visibility : 'public';
      patch.invite_code = str(i.invite_code, 40) || null;
      if (patch.visibility === 'invite_code' && !patch.invite_code) add('invite_code', 'Enter the invite code candidates will use.');
      if (patch.invite_code && !/^[A-Za-z0-9-]{4,40}$/.test(patch.invite_code)) add('invite_code', 'Use 4–40 letters, numbers or hyphens.');
      patch.require_verified_email = bool(i.require_verified_email);
      patch.require_org = bool(i.require_org);
      patch.prerequisite_exam_id = intOrNull(i.prerequisite_exam_id);
      if (patch.prerequisite_exam_id === Number(id)) add('prerequisite_exam_id', 'An exam cannot be its own prerequisite.');
      patch.is_paid = bool(i.is_paid);
      try {
        patch.price_kobo = toMinor(i.price || 0);
        patch.sale_price_kobo = i.sale_price ? toMinor(i.sale_price) : null;
        patch.extra_attempt_price_kobo = i.extra_attempt_price ? toMinor(i.extra_attempt_price) : null;
      } catch {
        add('price', 'Enter prices as amounts like 5000 or 5,000.00.');
      }
      if (patch.is_paid && !(patch.price_kobo > 0)) add('price', 'Enter a price for a paid exam.');
      if (patch.sale_price_kobo !== null && patch.sale_price_kobo >= patch.price_kobo) add('sale_price', 'The sale price must be lower than the price.');
      patch.access_days = intOrNull(i.access_days);
      patch.allow_buy_attempts = bool(i.allow_buy_attempts);
      if (patch.allow_buy_attempts && !(patch.extra_attempt_price_kobo > 0)) add('extra_attempt_price', 'Set the price of an extra attempt.');
      break;
    }
    case 'delivery':
      settingsPatch.delivery = S.normaliseGroup('delivery', i, current);
      break;
    case 'scoring': {
      patch.pass_mark = numOrNull(i.pass_mark);
      patch.pass_mark_type = i.pass_mark_type === 'raw' ? 'raw' : 'percent';
      if (patch.pass_mark !== null && patch.pass_mark < 0) add('pass_mark', 'The pass mark cannot be negative.');
      if (patch.pass_mark !== null && patch.pass_mark_type === 'percent' && patch.pass_mark > 100) add('pass_mark', 'A percentage pass mark must be 0–100.');
      patch.negative_marking = numOrNull(i.negative_marking) || 0;
      if (patch.negative_marking < 0 || patch.negative_marking > 10) add('negative_marking', 'Negative marking must be 0–10 marks per wrong answer.');
      patch.partial_credit = bool(i.partial_credit);
      settingsPatch.scaling = S.normaliseGroup('scaling', i.scaling || {}, current);
      if (settingsPatch.scaling.enabled && settingsPatch.scaling.max <= settingsPatch.scaling.min) add('scaling.max', 'The scaled maximum must be greater than the minimum.');
      break;
    }
    case 'release':
      patch.result_release = ['full_review', 'score_breakdown', 'score_only', 'after_window', 'manual'].includes(i.result_release) ? i.result_release : 'full_review';
      settingsPatch.instructions = S.normaliseGroup('instructions', i, current);
      break;
    case 'integrity':
      settingsPatch.integrity = S.normaliseGroup('integrity', i, current);
      if (settingsPatch.integrity.auto_submit_on_limit && !settingsPatch.integrity.tab_switch_limit) add('tab_switch_limit', 'Set the number of tab switches allowed before auto-submit.');
      break;
    case 'certificate':
      patch.certificate_enabled = bool(i.certificate_enabled);
      patch.certificate_template = ['classic', 'modern', 'minimal'].includes(i.certificate_template) ? i.certificate_template : 'classic';
      settingsPatch.certificate = S.normaliseGroup('certificate', i, current);
      break;
    default:
      break;
  }
  if (errors.length) throw new ExamError('Please fix the highlighted fields.', errors);

  const merged = { ...current, ...settingsPatch };
  await knex('exams')
    .where({ id })
    .update({ ...patch, settings: toJson(merged), updated_by: user ? user.id : null, updated_at: knex.fn.now() });
  if (tab === 'attempts' || tab === 'basics') await require('../commerce').syncExamProducts(id, knex);
  return { before: exam, patch, settingsPatch };
}

// ---------------------------------------------------------------- Sections

async function saveSection(examId, sectionId, input, knex = db()) {
  const title = str(input.title, 200);
  if (!title) throw new ExamError('Enter a section title.', [{ field: 'title', message: 'Enter a section title.' }]);
  const row = {
    title,
    instructions_html: sanitizeRich(input.instructions_html || '') || null,
    time_limit_minutes: intOrNull(input.time_limit_minutes),
    min_score_percent: numOrNull(input.min_score_percent),
  };
  if (row.time_limit_minutes !== null && (row.time_limit_minutes < 1 || row.time_limit_minutes > 1440)) throw new ExamError('Section time must be 1–1,440 minutes.', [{ field: 'time_limit_minutes', message: 'Section time must be 1–1,440 minutes.' }]);
  if (row.min_score_percent !== null && (row.min_score_percent < 0 || row.min_score_percent > 100)) throw new ExamError('Section minimum must be 0–100%.', [{ field: 'min_score_percent', message: 'Section minimum must be 0–100%.' }]);
  if (sectionId) {
    await knex('exam_sections').where({ id: sectionId, exam_id: examId }).update(row);
    return sectionId;
  }
  const [{ n }] = await knex('exam_sections').where({ exam_id: examId }).count({ n: '*' });
  const [id] = await knex('exam_sections').insert({ exam_id: examId, ...row, display_order: Number(n) });
  return id;
}

async function deleteSection(examId, sectionId, knex = db()) {
  return knex.transaction(async (trx) => {
    await trx('exam_questions').where({ exam_id: examId, section_id: sectionId }).update({ section_id: null });
    await trx('exam_blueprint_rules').where({ exam_id: examId, section_id: sectionId }).update({ section_id: null });
    await trx('exam_sections').where({ id: sectionId, exam_id: examId }).del();
  });
}

async function reorder(table, examId, ids, knex = db()) {
  const clean = (ids || []).map(Number).filter(Boolean);
  await knex.transaction(async (trx) => {
    for (let i = 0; i < clean.length; i += 1) await trx(table).where({ id: clean[i], exam_id: examId }).update({ display_order: i });
  });
}

// ---------------------------------------------------------------- Fixed question list

async function addQuestions(examId, questionIds, sectionId = null, knex = db()) {
  const exam = await getExam(examId, knex);
  const ids = [...new Set((questionIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return { added: 0, skipped: 0 };
  const q = knex('questions as q').whereIn('q.id', ids).whereNull('q.deleted_at').whereNull('q.parent_id');
  scopeQuestions(q, exam);
  const allowed = (await q.select('q.id')).map((r) => r.id);
  const existing = new Set((await knex('exam_questions').where({ exam_id: examId }).whereIn('question_id', allowed).select('question_id')).map((r) => r.question_id));
  const [{ max }] = await knex('exam_questions').where({ exam_id: examId }).max({ max: 'display_order' });
  let order = (max === null ? -1 : Number(max)) + 1;
  const rows = allowed.filter((id) => !existing.has(id)).map((id) => ({ exam_id: examId, question_id: id, section_id: sectionId || null, display_order: order++ }));
  if (rows.length) await knex('exam_questions').insert(rows);
  return { added: rows.length, skipped: ids.length - rows.length };
}

async function updateItem(examId, itemId, input, knex = db()) {
  const patch = {};
  if (input.marks !== undefined) {
    patch.marks = numOrNull(input.marks);
    if (patch.marks !== null && (patch.marks <= 0 || patch.marks > 1000)) throw new ExamError('Marks must be greater than 0.', [{ field: 'marks', message: 'Marks must be greater than 0 and at most 1000.' }]);
  }
  if (input.section_id !== undefined) patch.section_id = intOrNull(input.section_id);
  if (patch.section_id && !(await knex('exam_sections').where({ id: patch.section_id, exam_id: examId }).first('id'))) throw new ExamError('Section not found.', [], 404);
  if (Object.keys(patch).length) await knex('exam_questions').where({ id: itemId, exam_id: examId }).update(patch);
}

const removeItems = (examId, itemIds, knex = db()) => knex('exam_questions').where({ exam_id: examId }).whereIn('id', (itemIds || []).map(Number)).del();

// ---------------------------------------------------------------- Blueprint rules

async function normaliseRule(input, examId, knex) {
  const typesIn = [].concat(input.question_types || []).filter((t) => types.TYPES[t] && t !== 'case_study');
  const r = {
    section_id: intOrNull(input.section_id),
    question_count: intOrNull(input.question_count),
    category_id: intOrNull(input.category_id),
    certification_id: intOrNull(input.certification_id),
    domain_id: intOrNull(input.domain_id),
    tag_id: null,
    difficulty_min: intOrNull(input.difficulty_min),
    difficulty_max: intOrNull(input.difficulty_max),
    question_types: toJson(typesIn),
    marks: numOrNull(input.marks),
  };
  const errors = [];
  if (!r.question_count || r.question_count < 1 || r.question_count > 500) errors.push({ field: 'question_count', message: 'Number of questions must be 1–500.' });
  if (r.difficulty_min && r.difficulty_max && r.difficulty_min > r.difficulty_max) errors.push({ field: 'difficulty_max', message: 'Maximum difficulty must be at least the minimum.' });
  if (r.marks !== null && (r.marks <= 0 || r.marks > 1000)) errors.push({ field: 'marks', message: 'Marks must be greater than 0.' });
  if (input.tag) {
    const tag = await knex('tags').where('slug', String(input.tag).toLowerCase()).orWhere('name', String(input.tag)).first('id');
    if (!tag) errors.push({ field: 'tag', message: `Tag “${input.tag}” does not exist.` });
    else r.tag_id = tag.id;
  }
  if (r.domain_id && r.certification_id && !(await knex('certification_domains').where({ id: r.domain_id, certification_id: r.certification_id }).first('id'))) errors.push({ field: 'domain_id', message: 'That domain is not part of the chosen certification.' });
  if (r.section_id && !(await knex('exam_sections').where({ id: r.section_id, exam_id: examId }).first('id'))) errors.push({ field: 'section_id', message: 'Section not found.' });
  if (errors.length) throw new ExamError('The rule has errors.', errors);
  return r;
}

async function saveRule(examId, ruleId, input, knex = db()) {
  const r = await normaliseRule(input, examId, knex);
  if (ruleId) {
    await knex('exam_blueprint_rules').where({ id: ruleId, exam_id: examId }).update(r);
    return ruleId;
  }
  const [{ n }] = await knex('exam_blueprint_rules').where({ exam_id: examId }).count({ n: '*' });
  const [id] = await knex('exam_blueprint_rules').insert({ exam_id: examId, ...r, display_order: Number(n) });
  return id;
}

/** Live availability for an unsaved rule (builder preview). */
async function previewRule(examId, input, knex = db()) {
  const exam = await getExam(examId, knex);
  const r = await normaliseRule({ question_count: 1, ...input }, examId, knex);
  return ruleAvailability(r, exam, knex);
}

const deleteRule = (examId, ruleId, knex = db()) => knex('exam_blueprint_rules').where({ id: ruleId, exam_id: examId }).del();

// ---------------------------------------------------------------- Bands

async function saveBands(examId, bands, knex = db()) {
  const rows = (bands || [])
    .filter((b) => b && (str(b.name) || b.min_percent !== '' || b.max_percent !== ''))
    .map((b, i) => ({
      exam_id: examId,
      name: str(b.name, 60),
      min_percent: numOrNull(b.min_percent),
      max_percent: numOrNull(b.max_percent),
      programme_id: intOrNull(b.programme_id),
      course_url: str(b.course_url, 500) || null,
      message: str(b.message, 2000) || null,
      display_order: i,
    }));
  const errors = [];
  rows.forEach((b, i) => {
    if (!b.name) errors.push({ field: `bands.${i}.name`, message: `Band ${i + 1} needs a name.` });
    if (b.min_percent === null || b.max_percent === null || b.min_percent < 0 || b.max_percent > 100 || b.min_percent > b.max_percent) errors.push({ field: `bands.${i}.min_percent`, message: `Band ${i + 1} needs a range within 0–100 (minimum ≤ maximum).` });
    if (b.course_url && !/^https?:\/\//i.test(b.course_url)) errors.push({ field: `bands.${i}.course_url`, message: `Band ${i + 1}: the course link must start with http:// or https://.` });
  });
  const sorted = [...rows].sort((a, b) => a.min_percent - b.min_percent);
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i].min_percent <= sorted[i - 1].max_percent) errors.push({ field: 'bands', message: `Bands “${sorted[i - 1].name}” and “${sorted[i].name}” overlap.` });
  if (errors.length) throw new ExamError('The bands have errors.', errors);
  await knex.transaction(async (trx) => {
    await trx('exam_bands').where({ exam_id: examId }).del();
    if (rows.length) await trx('exam_bands').insert(rows);
  });
}

// ---------------------------------------------------------------- Access rules & overrides

function validIpRule(v) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(v);
  return !!m && m.slice(1, 5).every((o) => Number(o) <= 255) && (m[5] === undefined || Number(m[5]) <= 32);
}

async function addAccessRule(examId, ruleType, value, knex = db()) {
  const v = str(value, 191);
  if (ruleType === 'ip_allow' && !validIpRule(v)) throw new ExamError('Enter an IPv4 address or range like 102.89.0.0/16.', [{ field: 'value', message: 'Enter an IPv4 address or range like 102.89.0.0/16.' }]);
  if (ruleType === 'organisation' && !(await knex('organisations').where({ id: Number(v) || 0 }).first('id'))) throw new ExamError('Organisation not found.', [{ field: 'value', message: 'Organisation not found.' }]);
  if (!['ip_allow', 'organisation', 'cohort'].includes(ruleType)) throw new ExamError('Unknown rule.', [], 400);
  if (await knex('exam_access_rules').where({ exam_id: examId, rule_type: ruleType, value: v }).first('id')) return null;
  const [id] = await knex('exam_access_rules').insert({ exam_id: examId, rule_type: ruleType, value: v });
  return id;
}

const removeAccessRule = (examId, id, knex = db()) => knex('exam_access_rules').where({ exam_id: examId, id }).del();

async function grantAttempts(examId, { email, extra_attempts, reason, reset_cooldown }, grantedBy, knex = db()) {
  const errors = [];
  const n = intOrNull(extra_attempts);
  if (!n || n < 1 || n > 20) errors.push({ field: 'extra_attempts', message: 'Grant 1–20 extra attempts.' });
  if (str(reason, 500).length < 5) errors.push({ field: 'reason', message: 'Give a reason (at least 5 characters); it is recorded in the audit log.' });
  const user = await knex('users').where('email', str(email).toLowerCase()).whereNull('deleted_at').first('id', 'full_name', 'email');
  if (!user) errors.push({ field: 'email', message: 'No user with that email address.' });
  if (errors.length) throw new ExamError('The attempts could not be granted.', errors);
  const [id] = await knex('exam_attempt_overrides').insert({ exam_id: examId, user_id: user.id, extra_attempts: n, reset_cooldown: bool(reset_cooldown), reason: str(reason, 500), source: 'admin', granted_by: grantedBy });
  return { id, user, extra: n };
}

const listOverrides = (examId, knex = db()) =>
  knex('exam_attempt_overrides as o')
    .join('users as u', 'u.id', 'o.user_id')
    .leftJoin('users as g', 'g.id', 'o.granted_by')
    .where('o.exam_id', examId)
    .orderBy('o.id', 'desc')
    .select('o.*', 'u.full_name', 'u.email', 'g.full_name as granted_by_name');

// ---------------------------------------------------------------- Publish / versions / duplicate

/** The immutable snapshot candidates are served from. */
async function snapshot(full, knex) {
  const versionIds = full.items.length
    ? await knex('questions').whereIn('id', full.items.map((i) => i.question_id)).select('id', 'current_version_id')
    : [];
  const vmap = new Map(versionIds.map((r) => [r.id, r.current_version_id]));
  const e = full.exam;
  return {
    exam: { ...e, settings: undefined },
    settings: full.settings,
    sections: full.sections.map(({ id, title, instructions_html, time_limit_minutes, min_score_percent, display_order }) => ({ id, title, instructions_html, time_limit_minutes, min_score_percent, display_order })),
    items: full.items.map((i) => ({ question_id: i.question_id, version_id: vmap.get(i.question_id) || null, section_id: i.section_id, marks: i.marks, display_order: i.display_order })),
    rules: full.rules.map(({ id, section_id, question_count, category_id, certification_id, domain_id, tag_id, difficulty_min, difficulty_max, question_types, marks }) => ({ id, section_id, question_count, category_id, certification_id, domain_id, tag_id, difficulty_min, difficulty_max, question_types, marks })),
    bands: full.bands.map(({ name, min_percent, max_percent, programme_id, course_url, message }) => ({ name, min_percent, max_percent, programme_id, course_url, message })),
    access: full.access.map(({ rule_type, value }) => ({ rule_type, value })),
    summary: buildSummary(full),
  };
}

async function publish(id, user, note = null, knex = db()) {
  const full = await loadFull(id, knex);
  const checks = prePublishChecklist(full);
  if (!canPublish(checks)) throw new ExamError('The exam is not ready to publish.', checks.filter((c) => !c.ok && c.level === 'error').map((c) => ({ field: c.key, message: c.message })));
  const snap = await snapshot(full, knex);
  return knex.transaction(async (trx) => {
    const [{ max }] = await trx('exam_versions').where({ exam_id: id }).max({ max: 'version_no' });
    const versionNo = (max === null ? 0 : Number(max)) + 1;
    await trx('exam_versions').insert({ exam_id: id, version_no: versionNo, snapshot: toJson(snap), note: str(note, 255) || null, created_by: user ? user.id : null });
    const now = new Date();
    await trx('exams').where({ id }).update({ status: 'published', version: versionNo, published_at: now, updated_at: now, updated_by: user ? user.id : null });
    await require('../commerce').syncExamProducts(id, trx);
    return versionNo;
  });
}

async function unpublish(id, user, knex = db()) {
  await knex('exams').where({ id }).update({ status: 'draft', updated_by: user ? user.id : null });
  await require('../commerce').syncExamProducts(id, knex);
}
async function archive(id, user, knex = db()) {
  await knex('exams').where({ id }).update({ status: 'archived', updated_by: user ? user.id : null });
  await require('../commerce').syncExamProducts(id, knex);
}

async function duplicateExam(id, user, knex = db()) {
  const full = await loadFull(id, knex);
  const e = full.exam;
  return knex.transaction(async (trx) => {
    const title = `${e.title} (copy)`.slice(0, 200);
    const { id: _i, uuid: _u, slug: _s, created_at: _c, updated_at: _up, published_at: _p, deleted_at: _d, rating_avg: _ra, rating_count: _rc, ...rest } = e;
    const [newId] = await trx('exams').insert({ ...rest, uuid: crypto.randomUUID(), title, slug: await uniqueSlug(trx, 'exams', title), status: 'draft', version: 1, ai_generation_id: null, created_by: user ? user.id : null, updated_by: user ? user.id : null });
    const sectionMap = new Map();
    for (const s of full.sections) {
      const [sid] = await trx('exam_sections').insert({ exam_id: newId, title: s.title, instructions_html: s.instructions_html, time_limit_minutes: s.time_limit_minutes, min_score_percent: s.min_score_percent, display_order: s.display_order });
      sectionMap.set(s.id, sid);
    }
    const sec = (v) => (v ? sectionMap.get(v) || null : null);
    if (full.items.length) await trx('exam_questions').insert(full.items.map((i) => ({ exam_id: newId, question_id: i.question_id, section_id: sec(i.section_id), marks: i.marks_override, display_order: i.display_order })));
    for (const r of full.rules) {
      await trx('exam_blueprint_rules').insert({ exam_id: newId, section_id: sec(r.section_id), question_count: r.question_count, category_id: r.category_id, certification_id: r.certification_id, domain_id: r.domain_id, tag_id: r.tag_id, difficulty_min: r.difficulty_min, difficulty_max: r.difficulty_max, question_types: toJson(r.question_types), marks: r.marks, display_order: r.display_order });
    }
    if (full.bands.length) await trx('exam_bands').insert(full.bands.map(({ name, min_percent, max_percent, programme_id, course_url, message, display_order }) => ({ exam_id: newId, name, min_percent, max_percent, programme_id, course_url, message, display_order })));
    if (full.access.length) await trx('exam_access_rules').insert(full.access.map(({ rule_type, value }) => ({ exam_id: newId, rule_type, value })));
    return newId;
  });
}

const listVersions = (id, knex = db()) =>
  knex('exam_versions as v').leftJoin('users as u', 'u.id', 'v.created_by').where('v.exam_id', id).orderBy('v.version_no', 'desc').select('v.id', 'v.version_no', 'v.note', 'v.created_at', 'u.full_name as created_by_name');

async function getVersion(id, versionNo, knex = db()) {
  const v = await knex('exam_versions').where({ exam_id: id, version_no: versionNo }).first();
  if (!v) throw new ExamError('Version not found.', [], 404);
  return { ...v, snapshot: parseJson(v.snapshot, {}) };
}

async function softDelete(id, user, knex = db()) {
  const [{ n }] = await knex('attempts').where({ exam_id: id }).count({ n: '*' });
  if (Number(n) > 0) throw new ExamError('This exam has attempts, so it cannot be deleted. Archive it instead.', [], 409);
  await knex('exams').where({ id }).update({ deleted_at: knex.fn.now(), updated_by: user ? user.id : null });
  await require('../commerce').syncExamProducts(id, knex);
}

module.exports = {
  EXAM_TYPES,
  TABS,
  ExamError,
  createExam,
  listQuery,
  getExam,
  loadFull,
  saveTab,
  saveSection,
  deleteSection,
  reorder,
  addQuestions,
  updateItem,
  removeItems,
  saveRule,
  previewRule,
  deleteRule,
  ruleAvailability,
  ruleQuery,
  saveBands,
  addAccessRule,
  removeAccessRule,
  grantAttempts,
  listOverrides,
  publish,
  unpublish,
  archive,
  duplicateExam,
  listVersions,
  getVersion,
  softDelete,
  validIpRule,
};
