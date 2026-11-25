'use strict';

const { scopeOrg } = require('../../middleware/workspace');
const workspaces = require('../../services/workspaces');

const { db } = require('../../config/db');
const audit = require('../../services/audit');
const settings = require('../../services/settings');
const catalogue = require('../../services/catalogue');
const providers = require('../../services/ai/providers');
const generator = require('../../services/ai/generator');
const types = require('../../services/questions/types');
const examPlan = require('../../services/ai/examPlan');
const documents = require('../../services/ai/documents');

const LEVELS = [
  'Professional certification exam level — scenario-based, applied',
  'Foundation / associate level',
  'Advanced / expert level',
  'Pre-training diagnostic — spans beginner to expert so the result places candidates in a band',
  'Practice quiz — reinforce key facts and concepts',
];
const intOrNull = (v) => (v && /^\d+$/.test(String(v)) ? Number(v) : null);

async function newForm(req, res, view = 'admin/ai/new') {
  await settings.ensureLoaded();
  const enabled = settings.getSync('ai.enabled');
  const available = await providers.availableProviders();
  const [categories, certifications, exams, recent] = await Promise.all([
    catalogue.categoryTree(),
    catalogue.certificationsWithDomains(),
    db()('exams').whereNull('deleted_at').where((w) => (scopeOrg(req) ? w.where('organisation_id', scopeOrg(req)) : w.whereNull('organisation_id'))).whereIn('status', ['draft', 'published']).orderBy('title').select('id', 'title', 'status'),
    db()('ai_generations as g').leftJoin('imports as i', 'i.id', 'g.import_id').where((w) => (scopeOrg(req) ? w.where('g.organisation_id', scopeOrg(req)) : w.whereNull('g.organisation_id'))).orderBy('g.id', 'desc').limit(8).select('g.*', 'i.status as import_status', 'i.id as import_id'),
  ]);
  res.render(view, {
    title: view === 'admin/ai/exam' ? 'Generate an exam with AI' : 'Generate questions with AI',
    EXAM_KINDS: examPlan.EXAM_KINDS,
    certFormats: JSON.stringify(certifications.map((c) => ({ id: c.id, duration: c.official_duration_minutes, count: c.official_question_count, pass: c.official_passing_score, scale: c.official_score_scale }))),
    layout: 'layouts/app',
    enabled,
    available,
    defaultProvider: settings.getSync('ai.default_provider'),
    maxPerRun: settings.getSync('ai.max_questions_per_run'),
    aiQuota: scopeOrg(req) ? { limit: Number(req.workspace.limits.ai_questions_per_month) || 0, used: (await workspaces.usage(scopeOrg(req))).aiThisMonth } : null,
    categories,
    certifications,
    certJson: JSON.stringify(certifications.map((c) => ({ id: c.id, domains: c.domains.map((d) => ({ id: d.id, label: `${d.code ? `${d.code} · ` : ''}${d.name}`, weight: Number(d.weight_percent) })) }))),
    exams,
    recent,
    LEVELS,
    TYPES: types.TYPES,
    GENERATABLE: generator.GENERATABLE,
    canPublish: req.user.can('questions.publish'),
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, view === 'admin/ai/exam' ? { label: 'Exams', href: '/admin/exams' } : null, { label: view === 'admin/ai/exam' ? 'Generate an exam with AI' : 'AI generator' }].filter(Boolean),
  });
}

const examForm = (req, res) => newForm(req, res, 'admin/ai/exam');

async function create(req, res) {
  const isExam = req.body.kind === 'exam';
  const back = isExam ? '/admin/ai/exam' : '/admin/ai/new';
  const errors = {};
  const b = req.body;
  const available = (await providers.availableProviders()).map((p) => p.id);
  const provider = available.includes(b.provider) ? b.provider : null;
  if (!(await settings.get('ai.enabled'))) errors._form = 'AI generation is turned off in Settings → AI.';
  if (!provider) errors.provider = 'Choose a configured AI provider.';
  const prompt = String(b.prompt || '').trim();
  if (prompt.length < 20) errors.prompt = 'Describe what the questions should cover (at least 20 characters).';
  if (prompt.length > 4000) errors.prompt = 'Keep the brief under 4,000 characters; paste long material into “Reference material”.';
  const count = Number(b.count);
  const max = Number(await settings.get('ai.max_questions_per_run')) || 100;
  if (!Number.isInteger(count) || count < 1 || count > max) errors.count = `Choose between 1 and ${max} questions.`;
  const typesChosen = [].concat(b.types || []).filter((t) => generator.GENERATABLE.includes(t));
  if (!typesChosen.length) errors.types = 'Choose at least one question type.';
  const categoryId = intOrNull(b.category_id);
  if (!categoryId || !(await db()('categories').where({ id: categoryId }).first())) errors.category_id = 'Choose the category the questions belong to.';
  const certificationId = intOrNull(b.certification_id);
  const domainIds = [].concat(b.domain_ids || []).map(Number).filter(Boolean);
  const examMode = isExam ? 'create' : ['none', 'attach', 'create'].includes(b.exam_mode) ? b.exam_mode : 'none';
  const examType = isExam && examPlan.EXAM_KINDS[b.exam_type] ? b.exam_type : null;
  if (isExam && !examType) errors.exam_type = 'Choose the kind of exam.';
  if (examMode === 'create' && !String(b.exam_title || '').trim()) errors.exam_title = 'Give the new exam a title.';
  if (examMode === 'attach' && !intOrNull(b.exam_id)) errors.exam_id = 'Choose an exam.';
  else if (examMode === 'attach' && !(await db()('exams').where({ id: intOrNull(b.exam_id), organisation_id: scopeOrg(req) }).whereNull('deleted_at').first('id'))) errors.exam_id = 'Choose one of your exams.';
  // Reference documents: extract their text now, so a bad file is reported on the form, not in a background job.
  const docs = [];
  for (const f of req.files || []) {
    try {
      docs.push(await documents.extract(f));
    } catch (err) {
      if (!(err instanceof documents.DocumentError)) throw err;
      errors.documents = err.message;
      break;
    }
  }
  const { reference, truncated } = documents.combine(docs, b.reference);
  if (Object.keys(errors).length) {
    req.setFormState(b, errors);
    req.flash('danger', errors._form || 'Please correct the highlighted fields.');
    return res.redirect(back);
  }
  const spec = {
    provider,
    prompt,
    title: String(b.title || '').trim().slice(0, 120) || prompt.slice(0, 80),
    count,
    types: typesChosen,
    difficulty: ['mixed', '1', '2', '3', '4', '5'].includes(String(b.difficulty)) ? String(b.difficulty) : 'mixed',
    level: LEVELS.includes(b.level) ? b.level : LEVELS[0],
    language: String(b.language || 'English').slice(0, 40),
    reference,
    sources: docs.map((d) => ({ name: d.name, kind: d.kind, pages: d.pages, chars: d.chars })),
    category_id: categoryId,
    certification_id: certificationId,
    domain_ids: domainIds,
    status: b.status === 'published' && req.user.can('questions.publish') ? 'published' : 'draft',
    exam_mode: examMode,
    exam_id: intOrNull(b.exam_id),
    exam_title: String(b.exam_title || '').trim().slice(0, 200),
    exam_type: examType,
  };
  try {
    if (scopeOrg(req)) await workspaces.assertWithinLimit(scopeOrg(req), 'ai', spec.count);
    const { importId } = await generator.startGeneration({ user: req.user, spec, organisationId: scopeOrg(req) });
    await audit.record(req, 'ai.generate', { entityType: 'import', entityId: importId, after: { ...spec, reference: spec.reference ? `${spec.reference.length} chars` : null } });
    if (docs.length) req.flash(truncated ? 'warning' : 'info', `Questions will be based on ${docs.map((d) => `“${d.name}”`).join(', ')}${truncated ? '. The documents were long, so only the first part of each is used — split them or upload the key chapters for full coverage.' : '.'}`);
    return res.redirect(`/admin/imports/${importId}`);
  } catch (err) {
    if (!(err instanceof providers.AiError) && !(err instanceof workspaces.WorkspaceError)) throw err;
    req.setFormState(b, {});
    req.flash('danger', err.message);
    return res.redirect(back);
  }
}

module.exports = { newForm, examForm, create, LEVELS };
