'use strict';

const { db } = require('../../config/db');
const audit = require('../../services/audit');
const attempts = require('../../services/attempts');
const grading = require('../../services/grading');
const certificates = require('../../services/certificates');
const notify = require('../../services/notifications/results');
const { buildReview } = require('../examController');
const { paginate } = require('../../utils/paginate');
const { parseJson } = require('../../utils/json');
const { notFound } = require('../../utils/errors');
const { scopeOrg } = require('../../middleware/workspace');

/** Workspace staff see only their workspace's attempts; platform staff see every attempt (support). */
const orgWhere = (req, col) => (w) => (scopeOrg(req) ? w.where(col, scopeOrg(req)) : w);

const STATUS = { in_progress: ['badge-blue', 'In progress'], submitted: ['badge-gray', 'Submitted'], expired: ['badge-gray', 'Timed out'], graded: ['badge-green', 'Graded'], pending_manual: ['badge-amber', 'Needs grading'] };
const crumbs = (...rest) => [{ label: 'Admin', href: '/admin' }, { label: 'Attempts', href: '/admin/attempts' }, ...rest];

async function index(req, res) {
  const f = {
    exam: /^\d+$/.test(String(req.query.exam || '')) ? Number(req.query.exam) : null,
    status: STATUS[req.query.status] ? req.query.status : '',
    q: String(req.query.q || '').slice(0, 120),
    integrity: req.query.integrity === 'low',
  };
  const q = db()('attempts as a').join('users as u', 'u.id', 'a.user_id').join('exams as e', 'e.id', 'a.exam_id').leftJoin('results as r', 'r.attempt_id', 'a.id').where(orgWhere(req, 'e.organisation_id'));
  if (f.exam) q.where('a.exam_id', f.exam);
  if (f.status) q.where('a.status', f.status);
  if (f.integrity) q.where('a.integrity_score', '<', 80);
  if (f.q) q.where((w) => w.where('u.email', 'like', `%${f.q.replace(/[%_\\]/g, '\\$&')}%`).orWhere('u.full_name', 'like', `%${f.q.replace(/[%_\\]/g, '\\$&')}%`));
  q.select('a.id', 'a.uuid', 'a.attempt_no', 'a.mode', 'a.status', 'a.started_at', 'a.submitted_at', 'a.integrity_score', 'a.tab_switches', 'a.percent', 'a.passed', 'a.band', 'u.full_name', 'u.email', 'e.title', 'e.id as exam_id', 'r.release_status').orderBy('a.id', 'desc');
  const pager = await paginate(q, { page: req.query.page });
  const exams = await db()('exams').whereNull('deleted_at').where(orgWhere(req, 'organisation_id')).orderBy('title').select('id', 'title');
  const [{ n: pending }] = await db()('attempt_items as ai').join('attempts as a', 'a.id', 'ai.attempt_id').join('exams as e', 'e.id', 'a.exam_id').where('ai.grading_status', 'pending_manual').where(orgWhere(req, 'e.organisation_id')).count({ n: '*' });
  res.render('admin/attempts/index', { title: 'Attempts', layout: 'layouts/app', pager, f, query: req.query, exams, STATUS, pending: Number(pending), breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Attempts' }] });
}

async function loadAttempt(id) {
  const a = await db()('attempts as a').join('users as u', 'u.id', 'a.user_id').join('exams as e', 'e.id', 'a.exam_id').where('a.id', id).first('a.*', 'u.full_name', 'u.email', 'e.title', 'e.result_release');
  if (!a) throw notFound('Attempt not found.');
  return a;
}

async function show(req, res) {
  const a = await loadAttempt(Number(req.params.id));
  const [result, events, certificate] = await Promise.all([db()('results').where({ attempt_id: a.id }).first(), db()('attempt_events').where({ attempt_id: a.id }).orderBy('id'), db()('certificates').where({ attempt_id: a.id }).first()]);
  const review = await buildReview(a);
  res.render('admin/attempts/show', {
    title: `Attempt · ${a.full_name}`,
    layout: 'layouts/app',
    a,
    result,
    bd: result ? parseJson(result.breakdown, {}) : {},
    events: events.map((e) => ({ ...e, details: parseJson(e.details, null) })),
    certificate,
    review,
    STATUS,
    breadcrumbs: crumbs({ label: `${a.full_name} · ${a.title}` }),
  });
}

async function gradeItem(req, res) {
  const a = await loadAttempt(Number(req.params.id));
  const item = await db()('attempt_items').where({ id: Number(req.params.itemId), attempt_id: a.id }).first();
  if (!item) throw notFound();
  const wasPending = a.status === 'pending_manual';
  try {
    const out = await grading.gradeItemManually(item.id, { marks: req.body.marks, feedback: req.body.feedback, graderId: req.user.id });
    await audit.record(req, 'attempt.item.grade', { entityType: 'attempt', entityId: a.id, before: { item: item.id, marks: item.marks_awarded }, after: { item: item.id, marks: Number(req.body.marks), feedback: req.body.feedback || null } });
    if (wasPending && !out.pending) {
      // Fully graded now: issue the certificate if passed, and tell the candidate.
      const fresh = await db()('attempts').where({ id: a.id }).first();
      if (fresh.passed && fresh.mode !== 'study') {
        const cert = await certificates.issueForAttempt(a.id);
        if (cert) await notify.certificateIssued(a.id, cert.code);
      }
      await notify.essayGraded(a.id);
    }
    req.flash('success', `Saved. The attempt now scores ${out.percent}%${out.pending ? ` (${out.pending} answer${out.pending === 1 ? '' : 's'} still to grade)` : ''}.`);
  } catch (err) {
    if (err.status !== 422) throw err;
    req.flash('danger', err.message);
  }
  const back = String(req.body.back || '');
  res.redirect(back.startsWith('/admin/') ? back : `/admin/attempts/${a.id}#item-${item.id}`);
}

async function regrade(req, res) {
  const a = await loadAttempt(Number(req.params.id));
  if (a.status === 'in_progress') {
    req.flash('danger', 'This attempt is still in progress.');
    return res.redirect(`/admin/attempts/${a.id}`);
  }
  const before = await db()('results').where({ attempt_id: a.id }).first('percent', 'passed');
  const out = await grading.gradeAttempt(a.id, { regrade: true });
  await audit.record(req, 'attempt.regrade', { entityType: 'attempt', entityId: a.id, before, after: { percent: out.percent, passed: out.passed } });
  req.flash('success', `Re-graded: ${out.percent}%${out.passed === null ? '' : out.passed ? ' · pass' : ' · fail'}. Manual grades were kept.`);
  return res.redirect(`/admin/attempts/${a.id}`);
}

async function release(req, res) {
  const a = await loadAttempt(Number(req.params.id));
  const n = await db()('results').where({ attempt_id: a.id, release_status: 'withheld' }).update({ release_status: 'released', released_at: new Date() });
  if (n) {
    await audit.record(req, 'result.release', { entityType: 'attempt', entityId: a.id });
    await notify.resultReleased(a.id);
    req.flash('success', 'Result released. The candidate has been emailed.');
  }
  res.redirect(`/admin/attempts/${a.id}`);
}

/** Releases every withheld result of an exam (manual-release exams). */
async function releaseAll(req, res) {
  const examId = Number(req.params.examId);
  const ids = await db()('results').where({ exam_id: examId, release_status: 'withheld', has_pending_manual: false }).pluck('attempt_id');
  if (ids.length) await db()('results').whereIn('attempt_id', ids).update({ release_status: 'released', released_at: new Date() });
  for (const id of ids) await notify.resultReleased(id);
  await audit.record(req, 'result.release_all', { entityType: 'exam', entityId: examId, after: { released: ids.length } });
  req.flash('success', `${ids.length} result${ids.length === 1 ? '' : 's'} released.`);
  res.redirect(`/admin/attempts?exam=${examId}`);
}

async function forceSubmit(req, res) {
  const a = await loadAttempt(Number(req.params.id));
  if (a.status === 'in_progress') {
    const raw = await db()('attempts').where({ id: a.id }).first();
    await attempts.submitAttempt(raw, 'admin');
    await audit.record(req, 'attempt.force_submit', { entityType: 'attempt', entityId: a.id, after: { reason: req.body.reason || null } });
    req.flash('success', 'The attempt was submitted and graded.');
  }
  res.redirect(`/admin/attempts/${a.id}`);
}

async function revokeCertificate(req, res) {
  const c = await db()('certificates').where({ id: Number(req.params.certId) }).first();
  if (!c) throw notFound();
  const reason = String(req.body.reason || '').trim().slice(0, 255);
  if (reason.length < 5) {
    req.flash('danger', 'Give a reason (at least 5 characters); it is shown on the public verification page.');
    return res.redirect(`/admin/attempts/${c.attempt_id}`);
  }
  await db()('certificates').where({ id: c.id }).update({ revoked_at: new Date(), revoke_reason: reason });
  await audit.record(req, 'certificate.revoke', { entityType: 'certificate', entityId: c.id, after: { code: c.code, reason } });
  req.flash('success', `Certificate ${c.code} revoked.`);
  return res.redirect(`/admin/attempts/${c.attempt_id}`);
}

/** Manual grading queue: every answer waiting for a person, oldest first. */
async function queue(req, res) {
  const q = db()('attempt_items as ai')
    .join('attempts as a', 'a.id', 'ai.attempt_id')
    .join('users as u', 'u.id', 'a.user_id')
    .join('exams as e', 'e.id', 'a.exam_id')
    .join('question_versions as v', 'v.id', 'ai.question_version_id')
    .leftJoin('question_answers as qa', 'qa.question_version_id', 'v.id')
    .where('ai.grading_status', 'pending_manual')
    .where(orgWhere(req, 'e.organisation_id'))
    .orderBy('a.submitted_at')
    .select('ai.id', 'ai.attempt_id', 'ai.marks_possible', 'ai.response', 'v.type', 'v.stem_html', 'v.settings', 'qa.answer', 'a.submitted_at', 'u.full_name', 'e.title');
  const pager = await paginate(q, { page: req.query.page, perPage: 10 });
  for (const r of pager.rows) {
    r.response = parseJson(r.response, null);
    r.answer = parseJson(r.answer, {});
    r.settings = parseJson(r.settings, {});
  }
  res.render('admin/attempts/queue', { title: 'Grading queue', layout: 'layouts/app', pager, query: req.query, breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Grading queue' }] });
}

// ---------------------------------------------------------------- Live monitor (anti-cheat)

async function monitorData(req) {
  const { EVENT_LABELS } = require('../../services/attempts');
  const live = await db()('attempts as a')
    .join('users as u', 'u.id', 'a.user_id')
    .join('exams as e', 'e.id', 'a.exam_id')
    .where(orgWhere(req, 'e.organisation_id'))
    .where('a.status', 'in_progress')
    .whereNot('a.mode', 'study')
    .orderBy('a.integrity_score')
    .limit(200)
    .select('a.id', 'a.started_at', 'a.expires_at', 'a.integrity_score', 'a.tab_switches', 'a.fullscreen_exits', 'u.full_name', 'e.title', db().raw('(select count(*) from attempt_items ai where ai.attempt_id = a.id and ai.parent_item_id is null) as items'), db().raw('(select count(*) from attempt_items ai where ai.attempt_id = a.id and ai.answered_at is not null) as answered'));
  const since = new Date(Date.now() - 2 * 3600e3);
  const events = await db()('attempt_events as ev')
    .join('attempts as a', 'a.id', 'ev.attempt_id')
    .join('users as u', 'u.id', 'a.user_id')
    .join('exams as e', 'e.id', 'a.exam_id')
    .where(orgWhere(req, 'e.organisation_id'))
    .where('ev.created_at', '>=', since)
    .whereIn('ev.type', Object.keys(EVENT_LABELS))
    .whereNot('ev.type', 'tab_return')
    .orderBy('ev.id', 'desc')
    .limit(60)
    .select('ev.id', 'ev.type', 'ev.details', 'ev.created_at', 'a.id as attempt_id', 'u.full_name', 'e.title');
  return {
    serverTime: new Date().toISOString(),
    attempts: live.map((a) => ({ id: a.id, name: a.full_name, exam: a.title, startedAt: a.started_at, expiresAt: a.expires_at, score: a.integrity_score, tabSwitches: a.tab_switches, fullscreenExits: a.fullscreen_exits, answered: Number(a.answered), items: Number(a.items) })),
    events: events.map((e) => {
      const d = parseJson(e.details, {}) || {};
      return { id: Number(e.id), attemptId: e.attempt_id, name: e.full_name, exam: e.title, type: e.type, label: EVENT_LABELS[e.type] || e.type, away: d.away_ms ? Math.round(d.away_ms / 1000) : null, at: e.created_at };
    }),
  };
}

async function monitor(req, res) {
  res.render('admin/attempts/monitor', { title: 'Live monitor', layout: 'layouts/app', breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Attempts & results', href: '/admin/attempts' }, { label: 'Live monitor' }] });
}

async function monitorJson(req, res) {
  res.set('Cache-Control', 'no-store').json(await monitorData(req));
}

module.exports = { monitor, monitorJson, monitorData, index, show, gradeItem, regrade, release, releaseAll, forceSubmit, revokeCertificate, queue };
