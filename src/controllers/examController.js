'use strict';

const { db } = require('../config/db');
const catalogue = require('../services/catalogue');
const audit = require('../services/audit');
const attempts = require('../services/attempts');
const { checkEligibility } = require('../services/attempts/eligibility');
const grading = require('../services/grading');
const certificates = require('../services/certificates');
const sqlLab = require('../services/sql/lab');
const { SqlRunError } = require('../services/sql/runner');
const { buildSummary } = require('../services/exams/summary');
const examsRepo = require('../services/exams/repository');
const { generateInstructions } = require('../services/instructions');
const { parseJson } = require('../utils/json');
const { paginate } = require('../utils/paginate');
const { formatDateTime } = require('../utils/time');
const { notFound, forbidden } = require('../utils/errors');

const EXAM_TYPES = examsRepo.EXAM_TYPES;
const LISTED = ['public'];

function tokensOf(req) {
  if (!req.session.attemptTokens) req.session.attemptTokens = {};
  return req.session.attemptTokens;
}
function invitesOf(req) {
  if (!req.session.examInvites) req.session.examInvites = [];
  return req.session.examInvites;
}

async function publishedExamBySlug(slug) {
  const exam = await db()('exams as e')
    .leftJoin('categories as c', 'c.id', 'e.category_id')
    .leftJoin('certifications as ce', 'ce.id', 'e.certification_id')
    .where('e.slug', String(slug))
    .whereNull('e.deleted_at')
    .where('e.status', 'published')
    .first('e.*', 'c.name as category_name', 'c.slug as category_slug', 'ce.name as certification_name', 'ce.exam_code', 'ce.issuing_body');
  if (!exam) throw notFound('This exam does not exist or is no longer available.');
  return exam;
}

/** Summary of what candidates get, from the live snapshot (not the draft being edited). */
async function liveSummary(exam) {
  const snap = await attempts.latestSnapshot(exam.id);
  return snap ? snap.summary : null;
}

// ---------------------------------------------------------------- Catalogue

async function catalogueIndex(req, res) {
  const f = {
    q: String(req.query.q || '').slice(0, 120),
    type: EXAM_TYPES[req.query.type] ? req.query.type : '',
    category: /^\d+$/.test(String(req.query.category || '')) ? Number(req.query.category) : null,
    certification: /^\d+$/.test(String(req.query.certification || '')) ? Number(req.query.certification) : null,
    price: ['free', 'paid'].includes(req.query.price) ? req.query.price : '',
  };
  const q = db()('exams as e')
    .leftJoin('categories as c', 'c.id', 'e.category_id')
    .leftJoin('certifications as ce', 'ce.id', 'e.certification_id')
    .whereNull('e.deleted_at')
    .where('e.status', 'published')
    .whereIn('e.visibility', LISTED)
    .whereNull('e.organisation_id');
  if (f.q) q.where((w) => w.where('e.title', 'like', `%${f.q.replace(/[%_\\]/g, '\\$&')}%`).orWhere('ce.exam_code', 'like', `%${f.q.replace(/[%_\\]/g, '\\$&')}%`));
  if (f.type) q.where('e.type', f.type);
  if (f.category) q.whereIn('e.category_id', await catalogue.descendantIds(f.category));
  if (f.certification) q.where('e.certification_id', f.certification);
  if (f.price === 'free') q.where('e.is_paid', false);
  if (f.price === 'paid') q.where('e.is_paid', true);
  q.select('e.id', 'e.slug', 'e.title', 'e.type', 'e.short_description', 'e.duration_minutes', 'e.pass_mark', 'e.pass_mark_type', 'e.is_paid', 'e.price_kobo', 'e.sale_price_kobo', 'e.certificate_enabled', 'e.difficulty_label', 'e.published_at', 'c.name as category_name', 'ce.exam_code', 'ce.name as certification_name')
    .select(db().raw('(SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id) as attempt_count'))
    .orderBy('e.published_at', 'desc');
  const pager = await paginate(q, { page: req.query.page, perPage: 12 });
  for (const e of pager.rows) {
    const s = await liveSummary(e);
    e.questionCount = s ? s.questionCount : null;
    e.questionTypes = s ? s.questionTypes : [];
  }
  const [categories, certifications] = await Promise.all([catalogue.categoryTree({ activeOnly: true }), catalogue.certificationsWithDomains()]);
  res.render('public/exams', { title: 'Exams', layout: 'layouts/public', pager, f, query: req.query, categories, certifications: certifications.filter((c) => c.is_active), EXAM_TYPES });
}

async function examShow(req, res) {
  const exam = await publishedExamBySlug(req.params.slug);
  const snap = await attempts.latestSnapshot(exam.id);
  if (!snap) throw notFound();
  const user = req.user || null;
  const invited = invitesOf(req).includes(exam.id);
  if (exam.visibility === 'org_private' && !user) throw notFound();
  let elig = null;
  let accommodations = null;
  if (user) {
    elig = await checkEligibility(user, exam, { ip: req.ip, invited });
    accommodations = await db()('user_accommodations').where({ user_id: user.id }).first();
  }
  if (exam.visibility === 'org_private' && elig && elig.reasons.some((r) => r.code === 'org_private')) throw notFound();
  const tz = res.locals.fmt.tz;
  const instructions = generateInstructions(snap.summary, user ? { full_name: user.full_name, accommodations } : null, {
    attemptsUsed: elig ? elig.attemptsUsed : undefined,
    extraAttempts: elig ? elig.extraAttempts : 0,
    cooldownEndsAt: elig ? elig.cooldownEndsAt : null,
    now: new Date(),
    formatDateTime: (d) => formatDateTime(d, { timezone: tz }),
  });
  const history = user
    ? await db()('attempts as a').leftJoin('results as r', 'r.attempt_id', 'a.id').where({ 'a.exam_id': exam.id, 'a.user_id': user.id }).orderBy('a.id', 'desc').limit(10).select('a.uuid', 'a.attempt_no', 'a.status', 'a.started_at', 'a.submitted_at', 'a.mode', 'r.percent', 'r.passed', 'r.band', 'r.release_status', 'r.has_pending_manual')
    : [];
  res.render('public/exam', {
    title: exam.title,
    layout: 'layouts/public',
    exam,
    summary: snap.summary,
    domains: exam.certification_id ? await db()('certification_domains').where({ certification_id: exam.certification_id }).orderBy('display_order').select('code', 'name', 'weight_percent') : [],
    instructions,
    elig,
    invited,
    history,
    EXAM_TYPES,
    metaDescription: exam.short_description,
  });
}

async function redeemInvite(req, res) {
  const exam = await publishedExamBySlug(req.params.slug);
  const code = String(req.body.invite_code || '').trim();
  if (exam.visibility === 'invite_code' && exam.invite_code && code.toLowerCase() === String(exam.invite_code).toLowerCase()) {
    if (!invitesOf(req).includes(exam.id)) invitesOf(req).push(exam.id);
    req.flash('success', 'Invite code accepted.');
  } else req.flash('danger', 'That invite code is not valid for this exam.');
  res.redirect(`/exams/${exam.slug}#start`);
}

async function start(req, res) {
  const exam = await publishedExamBySlug(req.params.slug);
  if (!req.body.accept) {
    req.flash('danger', 'Please confirm that you have read the instructions.');
    return res.redirect(`/exams/${exam.slug}#start`);
  }
  try {
    const out = await attempts.startAttempt(req.user, exam, { ip: req.ip, userAgent: req.get('user-agent'), invited: invitesOf(req).includes(exam.id) });
    if (out.token) tokensOf(req)[out.attempt.uuid] = out.token;
    if (!out.resumed) await audit.record(req, 'attempt.start', { entityType: 'attempt', entityId: out.attempt.id, after: { exam_id: exam.id, attempt_no: out.attempt.attempt_no } });
    return res.redirect(`/attempts/${out.attempt.uuid}`);
  } catch (err) {
    if (!(err instanceof attempts.AttemptError)) throw err;
    req.flash('danger', err.message);
    return res.redirect(`/exams/${exam.slug}#start`);
  }
}

// ---------------------------------------------------------------- Player

async function loadAttempt(req) {
  try {
    return await attempts.getOwnedAttempt(String(req.params.uuid), req.user);
  } catch (err) {
    if (err instanceof attempts.AttemptError) throw notFound('Attempt not found.');
    throw err;
  }
}

/** Render-friendly response (the renderer expects `selected` as a list). */
function forRender(response) {
  if (!response) return {};
  const r = { ...response };
  if (typeof r.selected === 'string') r.selected = [r.selected];
  return r;
}

async function player(req, res) {
  const attempt = await loadAttempt(req);
  if (attempt.status !== 'in_progress') return res.redirect(`/results/${attempt.uuid}`);
  // Expired while away: submit now and show the result.
  const exam = await db()('exams').where({ id: attempt.exam_id }).first();
  if (attempt.expires_at && Date.now() > new Date(attempt.expires_at).getTime() + (Number(exam.grace_seconds) || 0) * 1000 + 5000) {
    await attempts.submitAttempt(attempt, 'timeout');
    req.flash('info', 'Time ran out while you were away, so your exam was submitted with the answers you had saved.');
    return res.redirect(`/results/${attempt.uuid}`);
  }
  const { snap, items, state } = await attempts.playerView(attempt);
  const single = snap.settings.integrity.single_session;
  const token = tokensOf(req)[attempt.uuid];
  if (single && (!token || attempts.sha256(token) !== attempt.session_token_hash)) {
    return res.render('exam/takeover', { title: snap.exam.title, layout: 'layouts/exam', attempt, exam: snap.exam });
  }
  await db()('attempt_events').insert({ attempt_id: attempt.id, type: 'resume', details: null, ip: req.ip });
  const top = items.filter((i) => !i.parentId);
  const children = (id) => items.filter((i) => i.parentId === id);
  const acc = await db()('user_accommodations').where({ user_id: req.user.id }).first();
  res.render('exam/player', {
    title: snap.exam.title,
    layout: 'layouts/exam',
    attempt,
    exam: snap.exam,
    settings: snap.settings,
    sections: snap.sections,
    top,
    children,
    forRender,
    state,
    token: token || '',
    accommodations: acc || {},
    hasSql: items.some((i) => i.type === 'sql'),
    config: {
      uuid: attempt.uuid,
      expiresAt: attempt.expires_at ? new Date(attempt.expires_at).toISOString() : null,
      serverTime: new Date().toISOString(),
      navigation: snap.settings.delivery.navigation,
      layout: snap.settings.delivery.layout,
      showTimer: snap.settings.delivery.show_timer,
      perQuestionSeconds: snap.exam.per_question_seconds ? Math.round(snap.exam.per_question_seconds * (1 + attempt.extra_time_percent / 100)) : null,
      integrity: snap.settings.integrity,
      pos: state.pos || 0,
      timedSections: !!state.timedSections,
      sectionOrder: state.sectionOrder || [],
      sectionIndex: state.sectionIndex || 0,
      sectionEndsAt: state.sectionEndsAt || null,
      count: top.length,
      token: token || '',
    },
  });
}

async function takeOver(req, res) {
  const attempt = await loadAttempt(req);
  if (attempt.status !== 'in_progress') return res.redirect(`/results/${attempt.uuid}`);
  tokensOf(req)[attempt.uuid] = await attempts.takeOver(attempt, req.ip);
  return res.redirect(`/attempts/${attempt.uuid}`);
}

/** PATCH /attempts/:uuid/answers — JSON autosave. */
async function saveAnswers(req, res) {
  const attempt = await loadAttempt(req);
  try {
    const out = await attempts.saveAnswers(attempt, { answers: Array.isArray(req.body.answers) ? req.body.answers : [], pos: req.body.pos }, { token: req.get('X-Attempt-Token') || tokensOf(req)[attempt.uuid] || null });
    const fresh = await db()('attempts').where({ id: attempt.id }).first('state', 'status');
    res.json({ ok: true, ...out, state: parseJson(fresh.state, {}), status: fresh.status, serverTime: new Date().toISOString(), expiresAt: attempt.expires_at });
  } catch (err) {
    if (!(err instanceof attempts.AttemptError)) throw err;
    res.status(err.status).json({ ok: false, error: err.message, code: err.code });
  }
}

async function event(req, res) {
  const attempt = await loadAttempt(req);
  const out = await attempts.recordEvent(attempt, String(req.body.type || ''), req.body.details && typeof req.body.details === 'object' ? req.body.details : null, req.ip);
  res.json({ ok: true, ...out });
}

async function finishSection(req, res) {
  const attempt = await loadAttempt(req);
  if (attempt.status !== 'in_progress') return res.status(409).json({ ok: false, error: 'This attempt has been submitted.' });
  const state = await attempts.finishSection(attempt);
  return res.json({ ok: true, state });
}

async function submit(req, res) {
  const attempt = await loadAttempt(req);
  const out = await attempts.submitAttempt(attempt, req.body.reason === 'timeout' ? 'timeout' : 'candidate');
  if (!out.alreadySubmitted) await audit.record(req, 'attempt.submit', { entityType: 'attempt', entityId: attempt.id, after: { percent: out.result.percent, passed: out.result.passed } });
  delete tokensOf(req)[attempt.uuid];
  if (req.get('accept') && req.get('accept').includes('application/json')) return res.json({ ok: true, redirect: `/results/${attempt.uuid}` });
  return res.redirect(`/results/${attempt.uuid}`);
}

/** Runs SQL for an SQL lab item inside the candidate's attempt (fresh dataset each time; no marking). */
async function runSql(req, res) {
  const attempt = await loadAttempt(req);
  if (attempt.status !== 'in_progress') return res.status(409).json({ ok: false, error: 'This attempt has been submitted.' });
  const it = await db()('attempt_items as ai').join('question_versions as v', 'v.id', 'ai.question_version_id').where({ 'ai.id': Number(req.params.itemId), 'ai.attempt_id': attempt.id }).first('v.type', 'v.settings');
  if (!it || it.type !== 'sql') throw notFound();
  const spec = parseJson(it.settings, {});
  try {
    if (req.body.describe) return res.json({ ok: true, schema: await sqlLab.describe(spec) });
    return res.json({ ok: true, run: await sqlLab.preview(spec, String(req.body.sql || '')) });
  } catch (err) {
    if (err instanceof SqlRunError) return res.status(422).json({ ok: false, error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------- Results

const canSeeBreakdown = (exam) => ['full_review', 'score_breakdown'].includes(exam.result_release);
const canSeeReview = (exam) => exam.result_release === 'full_review';

async function resultPage(req, res) {
  const attempt = await loadAttempt(req);
  if (attempt.status === 'in_progress') return res.redirect(`/attempts/${attempt.uuid}`);
  const result = await db()('results').where({ attempt_id: attempt.id }).first();
  const snap = parseJson((await db()('exam_versions').where({ exam_id: attempt.exam_id, version_no: attempt.exam_version }).first('snapshot')).snapshot, {});
  const exam = snap.exam;
  const liveExam = await db()('exams').where({ id: attempt.exam_id }).first('slug', 'status', 'deleted_at');
  const withheld = !result || result.release_status === 'withheld';
  const bd = result ? parseJson(result.breakdown, {}) : {};
  const certificate = await db()('certificates').where({ attempt_id: attempt.id }).first();
  const history = await db()('attempts as a').join('results as r', 'r.attempt_id', 'a.id').where({ 'a.exam_id': attempt.exam_id, 'a.user_id': req.user.id, 'r.release_status': 'released' }).whereNot('a.mode', 'study').orderBy('a.id').select('a.attempt_no', 'a.submitted_at', 'r.percent');

  // Recommended track (diagnostics): the band's programme/course, plus the weakest domains.
  let band = null;
  if (result && result.band) band = (snap.bands || []).find((b) => b.name === result.band) || null;
  let programme = null;
  if (band && band.programme_id) programme = await db()('training_programmes').where({ id: band.programme_id }).first('id', 'name', 'slug');
  const domains = (bd.domains || []).slice().sort((a, b) => a.percent - b.percent);
  const weak = domains.filter((d) => d.percent < 50);

  // Review (full review only, and never while results are withheld).
  let review = [];
  if (!withheld && canSeeReview(exam)) review = await buildReview(attempt);

  const durationAllowed = exam.duration_minutes ? Math.ceil(exam.duration_minutes * (1 + attempt.extra_time_percent / 100)) : null;
  const taken = attempt.submitted_at ? Math.max(0, Math.round((new Date(attempt.submitted_at) - new Date(attempt.started_at)) / 1000)) : null;
  res.render('candidate/result', {
    title: `Result · ${exam.title}`,
    layout: 'layouts/app',
    attempt,
    exam,
    examSlug: liveExam && !liveExam.deleted_at && liveExam.status === 'published' ? liveExam.slug : null,
    result,
    withheld,
    showBreakdown: !withheld && canSeeBreakdown(exam),
    showReview: !withheld && canSeeReview(exam),
    bd,
    band,
    programme,
    weak,
    domains,
    certificate,
    history,
    review,
    filter: ['wrong', 'flagged', 'unanswered', 'pending'].includes(req.query.filter) ? req.query.filter : 'all',
    durationAllowed,
    taken,
    breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'My results', href: '/my/results' }, { label: exam.title }],
  });
}

/** Question-by-question review: the candidate's answer, the key, explanation and reference. */
async function buildReview(attempt) {
  const items = await grading.loadItemsForMarking(db(), attempt.id);
  const vids = items.map((i) => i.question_version_id);
  const versions = new Map((await db()('question_versions').whereIn('id', vids).select('id', 'stem_html', 'explanation_html', 'reference', 'authoring')).map((v) => [v.id, v]));
  const opts = await db()('question_options').whereIn('question_version_id', vids).orderBy('display_order');
  const types = require('../services/questions/types');
  return items.map((it) => {
    const v = versions.get(it.question_version_id);
    const options = opts.filter((o) => o.question_version_id === it.question_version_id).map((o) => ({ ...o, region: parseJson(o.region) }));
    const authoring = parseJson(v.authoring) || types.fromStored({ ...v, type: it.type, marks: it.marks_possible }, options, it.answer, it.settings);
    return {
      id: it.id,
      parentId: it.parent_item_id,
      type: it.type,
      stem_html: v.stem_html,
      explanation_html: v.explanation_html,
      reference: v.reference,
      authoring,
      options,
      optionOrder: parseJson(it.option_order, null),
      response: it.response,
      awarded: it.marks_awarded === null ? null : Number(it.marks_awarded),
      possible: Number(it.marks_possible),
      correct: it.is_correct === null ? null : !!it.is_correct,
      status: it.grading_status,
      flagged: !!it.flagged,
      feedback: it.grader_feedback,
      unanswered: it.response === null || (typeof it.response === 'object' && !Object.values(it.response).some((x) => (Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.values(x).some(Boolean) : String(x || '').trim() !== ''))),
    };
  });
}

async function slip(req, res) {
  const attempt = await loadAttempt(req);
  const result = await db()('results').where({ attempt_id: attempt.id }).first('release_status');
  if (!result || result.release_status !== 'released') throw forbidden('Your result has not been released yet.');
  const buf = await certificates.resultSlipPdf(attempt.id);
  res.type('application/pdf').set('Content-Disposition', `inline; filename="result-${attempt.uuid.slice(0, 8)}.pdf"`).send(buf);
}

/** "Retake weak areas": a personal practice set from published questions in the domains scored below 50%. */
async function practiceWeak(req, res) {
  const attempt = await loadAttempt(req);
  const result = await db()('results').where({ attempt_id: attempt.id }).first();
  if (!result || result.release_status !== 'released') throw forbidden();
  const bd = parseJson(result.breakdown, {});
  const weak = (bd.domains || []).filter((d) => d.percent < 50).map((d) => Number(d.key));
  if (!weak.length) {
    req.flash('info', 'No weak domains to practise — well done.');
    return res.redirect(`/results/${attempt.uuid}`);
  }
  const exam = await db()('exams').where({ id: attempt.exam_id }).first();
  const study = await attempts.startStudySet(req.user, exam, weak, { ip: req.ip });
  if (!study) {
    req.flash('info', 'There are no practice questions for those domains yet.');
    return res.redirect(`/results/${attempt.uuid}`);
  }
  tokensOf(req)[study.attempt.uuid] = study.token;
  return res.redirect(`/attempts/${study.attempt.uuid}`);
}

// ---------------------------------------------------------------- My exams, results, certificates

async function myResults(req, res) {
  const rows = await db()('attempts as a')
    .join('exams as e', 'e.id', 'a.exam_id')
    .leftJoin('results as r', 'r.attempt_id', 'a.id')
    .leftJoin('certificates as c', 'c.attempt_id', 'a.id')
    .where('a.user_id', req.user.id)
    .orderBy('a.id', 'desc')
    .select('a.uuid', 'a.attempt_no', 'a.status', 'a.mode', 'a.started_at', 'a.submitted_at', 'a.expires_at', 'e.title', 'e.slug', 'e.type', 'r.percent', 'r.passed', 'r.band', 'r.release_status', 'r.has_pending_manual', 'c.code as certificate_code');
  res.render('candidate/results', { title: 'My exams & results', layout: 'layouts/app', rows, EXAM_TYPES, breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'My results' }] });
}

async function myCertificates(req, res) {
  const rows = await db()('certificates').where({ user_id: req.user.id }).orderBy('issued_at', 'desc');
  res.render('candidate/certificates', { title: 'My certificates', layout: 'layouts/app', rows, verifyUrl: certificates.verifyUrl, breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Certificates' }] });
}

async function certificatePdf(req, res) {
  const code = String(req.params.code || '').toUpperCase();
  const c = await db()('certificates').where({ code }).first();
  if (!c || c.revoked_at) throw notFound();
  if (c.user_id !== req.user.id && !req.user.can('certificates.manage')) throw notFound();
  const buf = await certificates.certificatePdf(code);
  res.type('application/pdf').set('Content-Disposition', `inline; filename="certificate-${code}.pdf"`).send(buf);
}

async function verifyPage(req, res) {
  const code = String(req.params.code || req.query.code || '').trim().toUpperCase();
  const cert = code ? await certificates.verify(code) : null;
  res.status(code && !cert ? 404 : 200).render('public/verify', { title: cert ? `Certificate ${cert.code}` : 'Verify a certificate', layout: 'layouts/public', code, cert, metaDescription: 'Check that a Skillscore Assess certificate is genuine.' });
}

module.exports = { catalogueIndex, examShow, redeemInvite, start, player, takeOver, saveAnswers, event, finishSection, submit, runSql, resultPage, slip, practiceWeak, myResults, myCertificates, certificatePdf, verifyPage, buildReview, forRender };
