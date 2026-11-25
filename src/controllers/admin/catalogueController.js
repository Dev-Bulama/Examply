'use strict';

const { db } = require('../../config/db');
const audit = require('../../services/audit');
const uploads = require('../../services/uploads');
const catalogue = require('../../services/catalogue');
const { uniqueSlug, slugify } = require('../../utils/slug');
const { notFound } = require('../../utils/errors');
const { fieldErrors } = require('../../middleware/validate');
const { z, trimmed, optionalTrimmed, checkbox, intOrNull } = require('../../validators/common');

const BANDS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
const ICONS = ['academic', 'chart', 'clipboard', 'cog', 'shield', 'key', 'users', 'clock', 'flag', 'banknotes', 'list', 'mail', 'computer', 'lock'];
const crumbs = (...rest) => [{ label: 'Admin', href: '/admin' }, ...rest];
const optUrl = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => v || null)
  .refine((v) => !v || /^https?:\/\/[^\s]+$/i.test(v), 'Enter a full URL starting with https://');

function fail(req, res, back, error) {
  req.setFormState(req.body, error.errors ? error.errors : fieldErrors(error));
  req.flash('danger', 'Please correct the highlighted fields.');
  return res.redirect(back);
}

// ================================================================ Categories

async function categoriesIndex(req, res) {
  const tree = await catalogue.categoryTree();
  const counts = await db()('categories as c')
    .leftJoin('questions as q', function joinQ() {
      this.on('q.category_id', 'c.id').andOnNull('q.deleted_at');
    })
    .groupBy('c.id')
    .select('c.id', db().raw('COUNT(q.id) as questions'));
  const certCounts = await db()('certifications').groupBy('category_id').select('category_id', db().raw('COUNT(*) as n'));
  for (const c of tree) {
    c.questions = Number((counts.find((x) => x.id === c.id) || {}).questions || 0);
    c.certifications = Number((certCounts.find((x) => x.category_id === c.id) || {}).n || 0);
  }
  res.render('admin/catalogue/categories', { title: 'Categories', layout: 'layouts/app', tree, breadcrumbs: crumbs({ label: 'Categories' }) });
}

async function categoryForm(req, res) {
  let category = { id: null, name: '', parent_id: req.query.parent || null, description: '', icon: 'academic', display_order: 0, is_active: true, image_path: null };
  if (req.params.id) {
    category = await db()('categories').where({ id: req.params.id }).first();
    if (!category) throw notFound('That category does not exist.');
  }
  const tree = await catalogue.categoryTree();
  const exclude = category.id ? await catalogue.descendantIds(category.id) : [];
  res.render('admin/catalogue/category-form', {
    title: category.id ? `Edit ${category.name}` : 'New category',
    layout: 'layouts/app',
    category,
    parents: tree.filter((c) => !exclude.includes(c.id)),
    icons: ICONS,
    breadcrumbs: crumbs({ label: 'Categories', href: '/admin/catalogue/categories' }, { label: category.id ? category.name : 'New' }),
  });
}

const categorySchema = z.object({
  name: trimmed(150, 2),
  slug: z.string().trim().max(160).optional(),
  parent_id: intOrNull(1, 2 ** 31),
  description: optionalTrimmed(2000),
  icon: z.string().optional().transform((v) => (ICONS.includes(v) ? v : null)),
  display_order: intOrNull(-9999, 9999).transform((v) => v || 0),
  is_active: checkbox,
});

async function categorySave(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const back = id ? `/admin/catalogue/categories/${id}/edit` : '/admin/catalogue/categories/new';
  const existing = id ? await db()('categories').where({ id }).first() : null;
  if (id && !existing) throw notFound('That category does not exist.');
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return fail(req, res, back, parsed.error);
  const v = parsed.data;
  if (v.parent_id) {
    if (!(await db()('categories').where({ id: v.parent_id }).first())) return fail(req, res, back, { errors: { parent_id: 'Choose a valid parent.' } });
    if (id && (await catalogue.descendantIds(id)).includes(v.parent_id)) return fail(req, res, back, { errors: { parent_id: 'A category cannot be placed inside itself or one of its sub-categories.' } });
  }
  const slugBase = v.slug ? slugify(v.slug) : v.name;
  const slug = await uniqueSlug(db(), 'categories', slugBase, { ignoreId: id });
  const row = { name: v.name, slug, parent_id: v.parent_id, description: v.description, icon: v.icon, display_order: v.display_order, is_active: v.is_active };
  let savedId = id;
  if (id) await db()('categories').where({ id }).update(row);
  else [savedId] = await db()('categories').insert(row);
  if (req.file) {
    try {
      const name = uploads.saveImage(req.file, { dir: 'branding', allowed: ['png', 'jpg', 'webp', 'svg'] });
      if (existing && existing.image_path) uploads.removeStored(existing.image_path, { dir: 'branding' });
      await db()('categories').where({ id: savedId }).update({ image_path: name });
    } catch (err) {
      req.flash('warning', `Saved, but the image was not: ${err.message}`);
    }
  }
  await audit.record(req, id ? 'category.update' : 'category.create', { entityType: 'category', entityId: savedId, before: existing || null, after: row });
  req.flash('success', `Category “${v.name}” saved.`);
  return res.redirect('/admin/catalogue/categories');
}

async function categoryDelete(req, res) {
  const c = await db()('categories').where({ id: req.params.id }).first();
  if (!c) throw notFound('That category does not exist.');
  const [kids, certs, questions, exams] = await Promise.all([
    db()('categories').where({ parent_id: c.id }).count('* as n').first(),
    db()('certifications').where({ category_id: c.id }).count('* as n').first(),
    db()('questions').where({ category_id: c.id }).whereNull('deleted_at').count('* as n').first(),
    db()('exams').where({ category_id: c.id }).whereNull('deleted_at').count('* as n').first(),
  ]);
  const blockers = [];
  if (Number(kids.n)) blockers.push(`${kids.n} sub-categor${Number(kids.n) === 1 ? 'y' : 'ies'}`);
  if (Number(certs.n)) blockers.push(`${certs.n} certification(s)`);
  if (Number(questions.n)) blockers.push(`${questions.n} question(s)`);
  if (Number(exams.n)) blockers.push(`${exams.n} exam(s)`);
  if (blockers.length) {
    req.flash('danger', `“${c.name}” still has ${blockers.join(', ')}. Move them first, or deactivate the category instead.`);
    return res.redirect('/admin/catalogue/categories');
  }
  await db()('categories').where({ id: c.id }).del();
  uploads.removeStored(c.image_path, { dir: 'branding' });
  await audit.record(req, 'category.delete', { entityType: 'category', entityId: c.id, before: c });
  req.flash('success', `Category “${c.name}” deleted.`);
  return res.redirect('/admin/catalogue/categories');
}

// ================================================================ Certifications

async function certificationsIndex(req, res) {
  const certs = await db()('certifications as c')
    .leftJoin('categories as cat', 'cat.id', 'c.category_id')
    .orderBy('c.display_order')
    .orderBy('c.name')
    .select('c.*', 'cat.name as category_name');
  const domainStats = await db()('certification_domains').groupBy('certification_id').select('certification_id', db().raw('COUNT(*) as n'), db().raw('SUM(weight_percent) as total'));
  const qCounts = await db()('questions').whereNull('deleted_at').whereNotNull('certification_id').groupBy('certification_id').select('certification_id', db().raw('COUNT(*) as n'), db().raw("SUM(status = 'published') as published"));
  for (const c of certs) {
    const d = domainStats.find((x) => x.certification_id === c.id) || {};
    const q = qCounts.find((x) => x.certification_id === c.id) || {};
    Object.assign(c, { domain_count: Number(d.n || 0), weight_total: Number(d.total || 0), questions: Number(q.n || 0), published: Number(q.published || 0) });
  }
  res.render('admin/catalogue/certifications', { title: 'Certifications', layout: 'layouts/app', certs, breadcrumbs: crumbs({ label: 'Certifications' }) });
}

async function certificationForm(req, res) {
  let cert = { id: null, name: '', category_id: null, issuing_body: '', exam_code: '', official_passing_score: null, official_score_scale: '%', official_duration_minutes: null, official_question_count: null, external_url: '', description: '', is_active: true, display_order: 0 };
  let domains = [];
  if (req.params.id) {
    cert = await db()('certifications').where({ id: req.params.id }).first();
    if (!cert) throw notFound('That certification does not exist.');
    domains = await db()('certification_domains as d')
      .where('d.certification_id', cert.id)
      .orderBy('d.display_order')
      .select('d.id', 'd.code', 'd.name', 'd.weight_percent', db().raw('(SELECT COUNT(*) FROM questions q WHERE q.domain_id = d.id AND q.deleted_at IS NULL) as questions'));
  }
  const oldDomains = res.locals.old.domains ? Object.values(res.locals.old.domains) : null;
  res.render('admin/catalogue/certification-form', {
    title: cert.id ? `Edit ${cert.name}` : 'New certification',
    layout: 'layouts/app',
    cert,
    domainsJson: JSON.stringify((oldDomains || domains).map((d) => ({ id: d.id ? Number(d.id) : null, code: d.code || '', name: d.name || '', weight: d.weight_percent !== undefined ? Number(d.weight_percent) : Number(d.weight || 0), questions: Number(d.questions || 0) }))),
    categories: await catalogue.categoryTree(),
    breadcrumbs: crumbs({ label: 'Certifications', href: '/admin/catalogue/certifications' }, { label: cert.id ? cert.name : 'New' }),
  });
}

const certSchema = z.object({
  name: trimmed(180, 2),
  category_id: z.coerce.number({ error: 'Choose a category.' }).int().positive('Choose a category.'),
  issuing_body: optionalTrimmed(150),
  exam_code: optionalTrimmed(60),
  official_passing_score: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100000) {
        ctx.addIssue({ code: 'custom', message: 'Enter a number.' });
        return z.NEVER;
      }
      return n;
    }),
  official_score_scale: optionalTrimmed(40),
  official_duration_minutes: intOrNull(1, 1440),
  official_question_count: intOrNull(1, 2000),
  external_url: optUrl,
  description: optionalTrimmed(5000),
  display_order: intOrNull(-9999, 9999).transform((v) => v || 0),
  is_active: checkbox,
  domains: z
    .union([
      z.array(z.any()),
      z.record(z.any()).transform((o) => Object.values(o)),
    ])
    .optional()
    .transform((v) => v || []),
});

const domainSchema = z.object({
  id: intOrNull(1, 2 ** 31),
  code: optionalTrimmed(30),
  name: trimmed(200, 1, 'Each domain needs a name.'),
  weight: z.coerce.number({ error: 'Weight must be a number.' }).min(0, 'Weight cannot be negative.').max(100, 'Weight cannot exceed 100%.'),
});

async function certificationSave(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const back = id ? `/admin/catalogue/certifications/${id}/edit` : '/admin/catalogue/certifications/new';
  const existing = id ? await db()('certifications').where({ id }).first() : null;
  if (id && !existing) throw notFound('That certification does not exist.');
  const parsed = certSchema.safeParse(req.body);
  if (!parsed.success) return fail(req, res, back, parsed.error);
  const v = parsed.data;
  const errors = {};
  if (!(await db()('categories').where({ id: v.category_id }).first())) errors.category_id = 'Choose a category.';
  const domains = [];
  v.domains.forEach((d, i) => {
    const r = domainSchema.safeParse(d);
    if (!r.success) errors.domains = `Domain ${i + 1}: ${r.error.issues[0].message}`;
    else domains.push(r.data);
  });
  const total = Math.round(domains.reduce((s, d) => s + d.weight, 0) * 100) / 100;
  if (domains.length && total > 100) errors.domains = `Domain weights add up to ${total}%. They cannot exceed 100%.`;
  if (Object.keys(errors).length) return fail(req, res, back, { errors });

  const row = {
    name: v.name,
    category_id: v.category_id,
    issuing_body: v.issuing_body,
    exam_code: v.exam_code,
    official_passing_score: v.official_passing_score,
    official_score_scale: v.official_score_scale,
    official_duration_minutes: v.official_duration_minutes,
    official_question_count: v.official_question_count,
    external_url: v.external_url,
    description: v.description,
    display_order: v.display_order,
    is_active: v.is_active,
  };
  let savedId = id;
  const beforeDomains = id ? await db()('certification_domains').where({ certification_id: id }).orderBy('display_order') : [];
  await db().transaction(async (trx) => {
    if (id) await trx('certifications').where({ id }).update({ ...row, slug: await uniqueSlug(trx, 'certifications', `${v.exam_code || ''} ${v.name}`, { ignoreId: id }) });
    else [savedId] = await trx('certifications').insert({ ...row, slug: await uniqueSlug(trx, 'certifications', `${v.exam_code || ''} ${v.name}`) });
    const keep = [];
    for (const [i, d] of domains.entries()) {
      const data = { code: d.code, name: d.name, weight_percent: d.weight, display_order: i };
      if (d.id && beforeDomains.some((b) => b.id === d.id)) {
        await trx('certification_domains').where({ id: d.id }).update(data);
        keep.push(d.id);
      } else {
        const [newId] = await trx('certification_domains').insert({ ...data, certification_id: savedId });
        keep.push(newId);
      }
    }
    // Removed domains: questions keep their certification but lose the domain (FK SET NULL).
    await trx('certification_domains').where({ certification_id: savedId }).whereNotIn('id', keep.length ? keep : [0]).del();
  });
  await audit.record(req, id ? 'certification.update' : 'certification.create', { entityType: 'certification', entityId: savedId, before: existing ? { ...existing, domains: beforeDomains } : null, after: { ...row, domains } });
  req.flash(domains.length && total !== 100 ? 'warning' : 'success', domains.length && total !== 100 ? `Saved. Note: domain weights add up to ${total}%, not 100%.` : `Certification “${v.name}” saved.`);
  return res.redirect('/admin/catalogue/certifications');
}

async function certificationDelete(req, res) {
  const c = await db()('certifications').where({ id: req.params.id }).first();
  if (!c) throw notFound('That certification does not exist.');
  const [q, e] = await Promise.all([
    db()('questions').where({ certification_id: c.id }).whereNull('deleted_at').count('* as n').first(),
    db()('exams').where({ certification_id: c.id }).whereNull('deleted_at').count('* as n').first(),
  ]);
  if (Number(q.n) || Number(e.n)) {
    req.flash('danger', `“${c.name}” is used by ${q.n} question(s) and ${e.n} exam(s). Deactivate it instead.`);
    return res.redirect('/admin/catalogue/certifications');
  }
  await db()('certifications').where({ id: c.id }).del();
  await audit.record(req, 'certification.delete', { entityType: 'certification', entityId: c.id, before: c });
  req.flash('success', `Certification “${c.name}” deleted.`);
  return res.redirect('/admin/catalogue/certifications');
}

/** JSON for dependent selects in the question editor and filters. */
async function domainsJson(req, res) {
  const rows = await db()('certification_domains').where({ certification_id: req.params.id }).orderBy('display_order').select('id', 'code', 'name', 'weight_percent');
  res.json({ domains: rows });
}

// ================================================================ Training programmes

async function programmesIndex(req, res) {
  const programmes = await db()('training_programmes as p').leftJoin('categories as c', 'c.id', 'p.category_id').orderBy('p.name').select('p.*', 'c.name as category_name');
  const bands = await db()('programme_bands').orderBy('display_order');
  for (const p of programmes) p.bands = bands.filter((b) => b.programme_id === p.id);
  res.render('admin/catalogue/programmes', { title: 'Training programmes', layout: 'layouts/app', programmes, breadcrumbs: crumbs({ label: 'Training programmes' }) });
}

async function programmeForm(req, res) {
  let programme = { id: null, name: '', description: '', category_id: null, is_active: true, levels: null };
  let bands = [];
  if (req.params.id) {
    programme = await db()('training_programmes').where({ id: req.params.id }).first();
    if (!programme) throw notFound('That programme does not exist.');
    bands = await db()('programme_bands').where({ programme_id: programme.id });
  }
  const bandRows = BANDS.map((name) => bands.find((b) => b.band === name) || { band: name, course_title: '', course_url: '', message: '' });
  res.render('admin/catalogue/programme-form', {
    title: programme.id ? `Edit ${programme.name}` : 'New training programme',
    layout: 'layouts/app',
    programme,
    bandRows,
    levelsText: (require('../../utils/json').parseJson(programme.levels, []) || []).join('\n'),
    categories: await catalogue.categoryTree(),
    breadcrumbs: crumbs({ label: 'Training programmes', href: '/admin/catalogue/programmes' }, { label: programme.id ? programme.name : 'New' }),
  });
}

async function programmeSave(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const back = id ? `/admin/catalogue/programmes/${id}/edit` : '/admin/catalogue/programmes/new';
  const existing = id ? await db()('training_programmes').where({ id }).first() : null;
  if (id && !existing) throw notFound('That programme does not exist.');
  const schema = z.object({ name: trimmed(180, 2), description: optionalTrimmed(5000), category_id: intOrNull(1, 2 ** 31), levels: optionalTrimmed(2000), is_active: checkbox });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(req, res, back, parsed.error);
  const v = parsed.data;
  const errors = {};
  const bands = [];
  for (const [i, name] of BANDS.entries()) {
    const b = (req.body.bands && typeof req.body.bands === 'object' && req.body.bands[name]) || {};
    const url = String(b.course_url || '').trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) errors[`bands.${name}.course_url`] = 'Enter a full URL starting with https://';
    bands.push({ band: name, course_title: String(b.course_title || '').trim().slice(0, 200) || null, course_url: url || null, message: String(b.message || '').trim().slice(0, 2000) || null, display_order: i });
  }
  if (Object.keys(errors).length) return fail(req, res, back, { errors });
  const levels = (v.levels || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20);
  const row = { name: v.name, description: v.description, category_id: v.category_id, levels: JSON.stringify(levels), is_active: v.is_active };
  let savedId = id;
  await db().transaction(async (trx) => {
    if (id) await trx('training_programmes').where({ id }).update({ ...row, slug: await uniqueSlug(trx, 'training_programmes', v.name, { ignoreId: id }) });
    else [savedId] = await trx('training_programmes').insert({ ...row, slug: await uniqueSlug(trx, 'training_programmes', v.name) });
    await trx('programme_bands').where({ programme_id: savedId }).del();
    await trx('programme_bands').insert(bands.map((b) => ({ ...b, programme_id: savedId })));
  });
  await audit.record(req, id ? 'programme.update' : 'programme.create', { entityType: 'programme', entityId: savedId, before: existing, after: { ...row, bands } });
  req.flash('success', `Programme “${v.name}” saved.`);
  return res.redirect('/admin/catalogue/programmes');
}

async function programmeDelete(req, res) {
  const p = await db()('training_programmes').where({ id: req.params.id }).first();
  if (!p) throw notFound('That programme does not exist.');
  const used = await db()('exams').where({ programme_id: p.id }).whereNull('deleted_at').count('* as n').first();
  if (Number(used.n)) {
    req.flash('danger', `“${p.name}” is linked to ${used.n} exam(s). Deactivate it instead.`);
    return res.redirect('/admin/catalogue/programmes');
  }
  await db()('training_programmes').where({ id: p.id }).del();
  await audit.record(req, 'programme.delete', { entityType: 'programme', entityId: p.id, before: p });
  req.flash('success', `Programme “${p.name}” deleted.`);
  return res.redirect('/admin/catalogue/programmes');
}

module.exports = {
  categoriesIndex,
  categoryForm,
  categorySave,
  categoryDelete,
  certificationsIndex,
  certificationForm,
  certificationSave,
  certificationDelete,
  domainsJson,
  programmesIndex,
  programmeForm,
  programmeSave,
  programmeDelete,
  BANDS,
};
