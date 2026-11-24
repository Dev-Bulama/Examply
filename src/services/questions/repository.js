'use strict';

const crypto = require('crypto');
const { db } = require('../../config/db');
const { parseJson, toJson } = require('../../utils/json');
const { slugify } = require('../../utils/slug');
const types = require('./types');
const sqlLab = require('../sql/lab');

class QuestionError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.errors = errors;
    this.status = 422;
  }
}

// ---------------------------------------------------------------- Category scope for authors

/** Every descendant id of the given categories (including themselves). */
async function withDescendants(categoryIds, knex = db()) {
  if (!categoryIds.length) return [];
  const all = await knex('categories').select('id', 'parent_id');
  const out = new Set(categoryIds.map(Number));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return [...out];
}

/**
 * Categories the user may author in: null = unrestricted (questions.edit_any), otherwise an id list
 * (assigned categories and their sub-categories).
 */
async function authorScope(user, knex = db()) {
  if (user.can('questions.edit_any')) return null;
  const assigned = await knex('author_categories').where({ user_id: user.id }).pluck('category_id');
  return withDescendants(assigned, knex);
}

/** Can `user` edit this question right now? Returns null if yes, otherwise the reason. */
async function editBlocker(user, question, knex = db()) {
  if (user.can('questions.edit_any')) return null;
  if (!user.can('questions.create')) return 'You do not have permission to edit questions.';
  if (question.author_id !== user.id) return 'You can only edit questions you wrote.';
  if (!['draft'].includes(question.status)) return 'This question is in review or published. Ask a reviewer to send it back to draft before editing.';
  const scope = await authorScope(user, knex);
  if (scope && !scope.includes(question.category_id)) return 'This question is outside the categories assigned to you.';
  return null;
}

// ---------------------------------------------------------------- Load

async function loadVersion(versionId, knex = db()) {
  const version = await knex('question_versions').where({ id: versionId }).first();
  if (!version) return null;
  const options = await knex('question_options').where({ question_version_id: versionId }).orderBy('display_order');
  for (const o of options) o.region = parseJson(o.region);
  const ans = await knex('question_answers').where({ question_version_id: versionId }).first();
  const answer = parseJson(ans && ans.answer, {});
  const settings = parseJson(version.settings, {});
  const authoring = parseJson(version.authoring) || types.fromStored(version, options, answer, settings);
  return { version, options, answer, settings, authoring };
}

async function loadQuestion(id, knex = db(), { withDeleted = false } = {}) {
  const q = knex('questions as q')
    .leftJoin('categories as c', 'c.id', 'q.category_id')
    .leftJoin('certifications as ce', 'ce.id', 'q.certification_id')
    .leftJoin('certification_domains as d', 'd.id', 'q.domain_id')
    .leftJoin('users as a', 'a.id', 'q.author_id')
    .leftJoin('users as r', 'r.id', 'q.reviewer_id')
    .where('q.id', id)
    .first('q.*', 'c.name as category_name', 'ce.name as certification_name', 'd.name as domain_name', 'a.full_name as author_name', 'r.full_name as reviewer_name');
  if (!withDeleted) q.whereNull('q.deleted_at');
  const question = await q;
  if (!question) return null;
  const current = question.current_version_id ? await loadVersion(question.current_version_id, knex) : null;
  const tags = await knex('question_tags as qt').join('tags as t', 't.id', 'qt.tag_id').where('qt.question_id', id).orderBy('t.name').pluck('t.name');
  const children = question.type === 'case_study' ? await knex('questions').where({ parent_id: id }).whereNull('deleted_at').orderBy('display_order').orderBy('id').select('id', 'type', 'status', 'stem_text', 'default_marks') : [];
  return { ...question, current, tags, children };
}

// ---------------------------------------------------------------- Tags

function parseTagInput(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,;\n]/);
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const name = String(t).trim().replace(/\s+/g, ' ').slice(0, 80);
    const slug = slugify(name, 90);
    if (name && slug && !seen.has(slug)) {
      seen.add(slug);
      out.push({ name, slug });
    }
  }
  return out.slice(0, 20);
}

async function ensureTags(names, knex) {
  const parsed = parseTagInput(names);
  const ids = [];
  for (const t of parsed) {
    await knex('tags').insert(t).onConflict('slug').ignore();
    ids.push((await knex('tags').where({ slug: t.slug }).first('id')).id);
  }
  return ids;
}

async function setTags(questionId, names, knex) {
  const ids = await ensureTags(names, knex);
  await knex('question_tags').where({ question_id: questionId }).del();
  if (ids.length) await knex('question_tags').insert(ids.map((tag_id) => ({ question_id: questionId, tag_id })));
}

async function addTags(questionIds, names, knex) {
  const ids = await ensureTags(names, knex);
  const rows = questionIds.flatMap((question_id) => ids.map((tag_id) => ({ question_id, tag_id })));
  if (rows.length) await knex('question_tags').insert(rows).onConflict(['question_id', 'tag_id']).ignore();
}

// ---------------------------------------------------------------- Save

const META_FIELDS = ['category_id', 'certification_id', 'domain_id', 'topic', 'difficulty', 'bloom_level', 'est_time_sec', 'parent_id'];

async function writeVersionRows(trx, versionId, stored) {
  if (stored.options.length) {
    await trx('question_options').insert(stored.options.map((o) => ({ ...o, question_version_id: versionId, region: o.region ? toJson(o.region) : null })));
  }
  await trx('question_answers').insert({ question_version_id: versionId, answer: toJson(stored.answer) });
}

/** Validates the meta fields against the catalogue (domain must belong to the certification, etc.). */
async function validateMeta(meta, knex) {
  const errs = [];
  if (meta.category_id && !(await knex('categories').where({ id: meta.category_id }).first())) errs.push({ field: 'category_id', message: 'Choose a valid category.' });
  if (meta.certification_id && !(await knex('certifications').where({ id: meta.certification_id }).first())) errs.push({ field: 'certification_id', message: 'Choose a valid certification.' });
  if (meta.domain_id) {
    const d = await knex('certification_domains').where({ id: meta.domain_id }).first();
    if (!d) errs.push({ field: 'domain_id', message: 'Choose a valid domain.' });
    else if (meta.certification_id && d.certification_id !== meta.certification_id) errs.push({ field: 'domain_id', message: 'That domain belongs to a different certification.' });
  }
  if (!Number.isInteger(meta.difficulty) || meta.difficulty < 1 || meta.difficulty > 5) errs.push({ field: 'difficulty', message: 'Difficulty must be between 1 and 5.' });
  if (meta.bloom_level && !types.BLOOM.includes(meta.bloom_level)) errs.push({ field: 'bloom_level', message: 'Choose a Bloom level from the list.' });
  if (!Number.isInteger(meta.est_time_sec) || meta.est_time_sec < 5 || meta.est_time_sec > 7200) errs.push({ field: 'est_time_sec', message: 'Estimated time must be between 5 and 7200 seconds.' });
  if (meta.parent_id) {
    const p = await knex('questions').where({ id: meta.parent_id, type: 'case_study' }).whereNull('deleted_at').first();
    if (!p) errs.push({ field: 'parent_id', message: 'The parent case study does not exist.' });
  }
  return errs;
}

/**
 * Creates or updates a question.
 *  - New question → version 1.
 *  - Current version never published → updated in place.
 *  - Current version has been published → a NEW version is created (past attempts keep theirs).
 * Returns { id, versionId, version, created, newVersion }.
 */
async function saveQuestion({ id = null, meta, authoring, tags, user, changeNote = null, status = null, importId = null }, knex = db()) {
  const q = types.normalise(authoring);
  const errors = [...types.validate(q), ...(await validateMeta(meta, knex))];
  if (q.type === 'case_study' && meta.parent_id) errors.push({ field: 'type', message: 'A case study cannot be inside another case study.' });
  // SQL lab: actually build the dataset and run the model solution, so a broken question never reaches candidates.
  if (q.type === 'sql' && !errors.length) errors.push(...(await sqlLab.verify(q)));
  if (errors.length) throw new QuestionError('The question has errors.', errors);
  const stored = types.toStored(q);
  const hash = types.contentHash(q);

  return knex.transaction(async (trx) => {
    let questionId = id;
    let versionId;
    let versionNo;
    let created = false;
    let newVersion = false;
    const metaRow = Object.fromEntries(META_FIELDS.map((k) => [k, meta[k] === undefined ? null : meta[k]]));
    const versionRow = {
      type: q.type,
      stem_html: stored.stem_html,
      stem_text: stored.stem_text,
      explanation_html: stored.explanation_html,
      reference: stored.reference,
      settings: toJson(stored.settings),
      marks: stored.marks,
      content_hash: hash,
      authoring: toJson(q),
    };

    if (!questionId) {
      created = true;
      [questionId] = await trx('questions').insert({
        uuid: crypto.randomUUID(),
        type: q.type,
        ...metaRow,
        default_marks: stored.marks,
        status: status || 'draft',
        stem_text: stored.stem_text,
        content_hash: hash,
        author_id: user ? user.id : null,
        import_id: importId,
        version: 1,
      });
      [versionId] = await trx('question_versions').insert({ ...versionRow, question_id: questionId, version_no: 1, created_by: user ? user.id : null, change_note: changeNote });
      versionNo = 1;
      await writeVersionRows(trx, versionId, stored);
    } else {
      const existing = await trx('questions').where({ id: questionId }).forUpdate().first();
      const current = await trx('question_versions').where({ id: existing.current_version_id }).first();
      if (current && current.published_at && existing.type !== q.type) throw new QuestionError('The type of a published question cannot change. Duplicate it instead.', [{ field: 'type', message: 'Type is locked after publishing.' }]);
      if (!current || current.published_at) {
        newVersion = true;
        versionNo = (await trx('question_versions').where({ question_id: questionId }).max('version_no as n').first()).n + 1;
        [versionId] = await trx('question_versions').insert({ ...versionRow, question_id: questionId, version_no: versionNo, created_by: user ? user.id : null, change_note: changeNote });
        await writeVersionRows(trx, versionId, stored);
      } else {
        versionId = current.id;
        versionNo = current.version_no;
        await trx('question_versions').where({ id: versionId }).update({ ...versionRow, change_note: changeNote || current.change_note });
        await trx('question_options').where({ question_version_id: versionId }).del();
        await trx('question_answers').where({ question_version_id: versionId }).del();
        await writeVersionRows(trx, versionId, stored);
      }
      const patch = { type: q.type, ...metaRow, default_marks: stored.marks, stem_text: stored.stem_text, content_hash: hash, version: versionNo };
      if (status) patch.status = status;
      await trx('questions').where({ id: questionId }).update(patch);
    }
    await trx('questions').where({ id: questionId }).update({ current_version_id: versionId });
    // A version saved straight into "published" is live immediately.
    const finalStatus = (await trx('questions').where({ id: questionId }).first('status')).status;
    if (finalStatus === 'published') {
      await trx('question_versions').where({ id: versionId }).whereNull('published_at').update({ published_at: new Date() });
      await trx('questions').where({ id: questionId }).whereNull('published_at').update({ published_at: new Date() });
    }
    if (tags !== undefined) await setTags(questionId, tags, trx);
    if (stored.options.length && q.type === 'hotspot') {
      await trx('question_media').where({ uuid: q.image }).update({ question_id: questionId });
    }
    return { id: questionId, versionId, version: versionNo, created, newVersion };
  });
}

// ---------------------------------------------------------------- Workflow

/**
 * Allowed transitions and the permission each needs:
 *   submit   draft → in_review         (author)
 *   approve  in_review → published     questions.review
 *   reject   in_review → draft         questions.review (note required)
 *   publish  draft/in_review/retired → published   questions.publish
 *   retire   published → retired       questions.publish
 *   to_draft published/retired → draft questions.edit_any
 */
const TRANSITIONS = {
  submit: { from: ['draft'], to: 'in_review', perm: 'questions.create' },
  approve: { from: ['in_review'], to: 'published', perm: 'questions.review' },
  reject: { from: ['in_review'], to: 'draft', perm: 'questions.review' },
  publish: { from: ['draft', 'in_review', 'retired'], to: 'published', perm: 'questions.publish' },
  retire: { from: ['published'], to: 'retired', perm: 'questions.publish' },
  to_draft: { from: ['retired'], to: 'draft', perm: 'questions.edit_any' },
};

async function transition(id, action, user, { note = null } = {}, knex = db()) {
  const t = TRANSITIONS[action];
  if (!t) throw new QuestionError('Unknown action.');
  const question = await knex('questions').where({ id }).whereNull('deleted_at').first();
  if (!question) throw new QuestionError('That question does not exist.');
  if (!user.can(t.perm)) throw new QuestionError('You do not have permission to do that.');
  if (!t.from.includes(question.status)) throw new QuestionError(`A ${question.status.replace('_', ' ')} question cannot be ${action === 'to_draft' ? 'moved to draft' : `${action}ed`}.`);
  if (action === 'submit' && !user.can('questions.edit_any') && question.author_id !== user.id) throw new QuestionError('You can only submit your own questions.');
  if (action === 'reject' && !String(note || '').trim()) throw new QuestionError('Explain what needs to change when sending a question back.', [{ field: 'note', message: 'A note is required.' }]);
  if (t.to === 'published') {
    const loaded = await loadVersion(question.current_version_id, knex);
    const problems = types.validate(types.normalise(loaded.authoring));
    if (problems.length) throw new QuestionError(`It cannot be published: ${problems[0].message}`, problems);
  }
  await knex.transaction(async (trx) => {
    const patch = { status: t.to };
    if (['approve', 'reject'].includes(action)) Object.assign(patch, { reviewer_id: user.id, reviewed_at: new Date(), review_note: note ? String(note).slice(0, 1000) : null });
    if (t.to === 'published') {
      patch.published_at = question.published_at || new Date();
      await trx('question_versions').where({ id: question.current_version_id }).whereNull('published_at').update({ published_at: new Date() });
    }
    await trx('questions').where({ id }).update(patch);
    // Case studies move their children with them.
    if (question.type === 'case_study' && ['published', 'retired'].includes(t.to)) {
      const kids = await trx('questions').where({ parent_id: id }).whereNull('deleted_at').whereIn('status', t.to === 'published' ? ['draft', 'in_review'] : ['published']);
      for (const k of kids) {
        await trx('questions').where({ id: k.id }).update({ status: t.to, ...(t.to === 'published' ? { published_at: k.published_at || new Date() } : {}) });
        if (t.to === 'published') await trx('question_versions').where({ id: k.current_version_id }).whereNull('published_at').update({ published_at: new Date() });
      }
    }
  });
  return { from: question.status, to: t.to };
}

// ---------------------------------------------------------------- List / search

/** Builds the filtered question-bank query (without select/order/limit). */
function filteredQuery(filters, knex = db()) {
  const q = knex('questions as q').whereNull('q.deleted_at');
  const f = filters || {};
  if (f.parent_id) q.where('q.parent_id', f.parent_id);
  else if (!f.include_children) q.whereNull('q.parent_id');
  if (f.q) {
    const term = String(f.q).trim();
    if (/^#?\d+$/.test(term)) q.where('q.id', Number(term.replace('#', '')));
    else if (term.length >= 3) {
      const boolean = term
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}_]/gu, ''))
        .filter((w) => w.length >= 3)
        .map((w) => `+${w}*`)
        .join(' ');
      q.where((w) => {
        if (boolean) w.whereRaw('MATCH(q.stem_text) AGAINST (? IN BOOLEAN MODE)', [boolean]);
        w.orWhere('q.stem_text', 'like', `%${term.replace(/[%_\\]/g, '\\$&')}%`);
      });
    } else q.where('q.stem_text', 'like', `%${term.replace(/[%_\\]/g, '\\$&')}%`);
  }
  if (f.category_ids && f.category_ids.length) q.whereIn('q.category_id', f.category_ids);
  if (f.certification_id) q.where('q.certification_id', f.certification_id);
  if (f.domain_id) q.where('q.domain_id', f.domain_id);
  if (f.type) q.where('q.type', f.type);
  if (f.status) q.where('q.status', f.status);
  if (f.difficulty) q.where('q.difficulty', f.difficulty);
  if (f.author_id) q.where('q.author_id', f.author_id);
  if (f.tag) q.whereExists((s) => s.select(1).from('question_tags as qt').join('tags as t', 't.id', 'qt.tag_id').whereRaw('qt.question_id = q.id').where('t.slug', f.tag));
  if (f.import_id) q.where('q.import_id', f.import_id);
  return q;
}

/** Groups of questions with identical content hashes. */
async function duplicateGroups(knex = db()) {
  const hashes = await knex('questions').whereNull('deleted_at').whereNotNull('content_hash').groupBy('content_hash').havingRaw('COUNT(*) > 1').orderByRaw('COUNT(*) DESC').limit(200).select('content_hash', knex.raw('COUNT(*) as n'));
  if (!hashes.length) return [];
  const rows = await knex('questions as q')
    .leftJoin('categories as c', 'c.id', 'q.category_id')
    .whereNull('q.deleted_at')
    .whereIn(
      'q.content_hash',
      hashes.map((h) => h.content_hash),
    )
    .orderBy('q.id')
    .select('q.id', 'q.type', 'q.status', 'q.stem_text', 'q.content_hash', 'q.created_at', 'c.name as category_name');
  return hashes.map((h) => ({ hash: h.content_hash, questions: rows.filter((r) => r.content_hash === h.content_hash) }));
}

async function findByHash(hash, knex = db()) {
  return knex('questions').where({ content_hash: hash }).whereNull('deleted_at').orderBy('id').first('id', 'status', 'current_version_id');
}

/** Copies the current version into a new draft question. */
async function duplicate(id, user, knex = db()) {
  const src = await loadQuestion(id, knex);
  if (!src || !src.current) throw new QuestionError('That question does not exist.');
  const meta = Object.fromEntries(META_FIELDS.map((k) => [k, src[k]]));
  return saveQuestion({ meta, authoring: src.current.authoring, tags: src.tags, user, changeNote: `Duplicated from #${id}` }, knex);
}

module.exports = {
  QuestionError,
  withDescendants,
  authorScope,
  editBlocker,
  loadVersion,
  loadQuestion,
  saveQuestion,
  transition,
  TRANSITIONS,
  filteredQuery,
  duplicateGroups,
  findByHash,
  duplicate,
  parseTagInput,
  setTags,
  addTags,
  META_FIELDS,
};
