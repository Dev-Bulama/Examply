'use strict';

/**
 * Attempts: start (from the latest published exam snapshot), resume, autosave, navigation and section timing,
 * integrity events, submit (graded in the same transaction) and the expiry sweeper.
 *
 * Timing is server-authoritative: `expires_at` is fixed when the attempt starts (duration × extra-time accommodation,
 * capped by the exam window). Saves are accepted until expires_at + the exam's grace period + a 5-second network
 * allowance; after that the attempt is submitted with whatever was saved.
 */
const crypto = require('crypto');
const { db } = require('../../config/db');
const { parseJson, toJson } = require('../../utils/json');
const types = require('../questions/types');
const examsRepo = require('../exams/repository');
const grading = require('../grading');
const { checkEligibility, COUNTED_MODES } = require('./eligibility');

const NETWORK_ALLOWANCE_MS = 5000;
const MAX_RESPONSE_BYTES = 60000;
const SHUFFLE_OPTION_TYPES = ['single_choice', 'multiple_response'];

class AttemptError extends Error {
  constructor(message, status = 422, code = 'attempt') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function latestSnapshot(examId, knex = db()) {
  const v = await knex('exam_versions').where({ exam_id: examId }).orderBy('version_no', 'desc').first();
  return v ? { versionNo: v.version_no, ...parseJson(v.snapshot, {}) } : null;
}

/** Per-attempt option order: shuffled choices (pinned stay last), shuffled right-hand matching items, shuffled ordering items. */
function optionOrderFor(type, options, shuffleOptions) {
  if (SHUFFLE_OPTION_TYPES.includes(type) && shuffleOptions) {
    const pinned = options.filter((o) => o.pin_last).map((o) => o.option_key);
    return [...shuffle(options.filter((o) => !o.pin_last).map((o) => o.option_key)), ...pinned];
  }
  if (type === 'matching') return shuffle(options.filter((o) => o.side === 'right').map((o) => o.option_key));
  if (type === 'ordering') {
    const keys = options.map((o) => o.option_key);
    let order = shuffle(keys);
    for (let i = 0; i < 5 && keys.length > 1 && order.every((k, j) => k === keys[j]); i += 1) order = shuffle(keys);
    return order;
  }
  return null;
}

/** Picks the questions for a new attempt: [{ questionId, versionId, sectionId, marks, children: [...] }]. */
async function drawQuestions(snap, exam, knex) {
  const delivery = snap.settings.delivery;
  let picked = [];
  if (exam.content_mode === 'blueprint') {
    const used = new Set();
    for (const rule of snap.rules) {
      const { q } = await examsRepo.ruleQuery(rule, exam, knex);
      const rows = await q.clone().whereNotIn('q.id', [...used, 0]).orderByRaw('RAND()').limit(rule.question_count).select('q.id', 'q.current_version_id', 'q.default_marks');
      for (const r of rows) {
        used.add(r.id);
        picked.push({ questionId: r.id, versionId: r.current_version_id, sectionId: rule.section_id || null, marks: rule.marks !== null && rule.marks !== undefined ? Number(rule.marks) : Number(r.default_marks) });
      }
    }
  } else {
    picked = snap.items.map((i) => ({ questionId: i.question_id, versionId: i.version_id, sectionId: i.section_id || null, marks: Number(i.marks), order: i.display_order }));
    picked.sort((a, b) => a.order - b.order);
  }

  // Case studies bring their (published) child questions.
  const caseIds = picked.length ? await knex('questions').whereIn('id', picked.map((p) => p.questionId)).where('type', 'case_study').pluck('id') : [];
  for (const p of picked) {
    if (!caseIds.includes(p.questionId)) continue;
    const kids = await knex('questions').where({ parent_id: p.questionId, status: 'published' }).whereNull('deleted_at').orderBy(['display_order', 'id']).select('id', 'current_version_id', 'default_marks');
    p.children = kids.map((k) => ({ questionId: k.id, versionId: k.current_version_id, marks: Number(k.default_marks) }));
  }

  // Fixed list: deliver a random subset (case studies count as their parts).
  if (exam.content_mode === 'fixed' && delivery.deliver_count && delivery.deliver_count < picked.length) {
    const out = [];
    let n = 0;
    for (const p of shuffle(picked)) {
      if (n >= delivery.deliver_count) break;
      out.push(p);
      n += p.children ? p.children.length : 1;
    }
    picked = picked.filter((p) => out.includes(p));
  }

  // Group by section in section order; shuffle within a section when asked.
  const sectionOrder = [null, ...snap.sections.map((s) => s.id)];
  const grouped = sectionOrder.map((sid) => picked.filter((p) => (p.sectionId || null) === sid));
  return grouped.flatMap((g) => (delivery.shuffle_questions ? shuffle(g) : g));
}

async function startAttempt(user, exam, { ip = null, userAgent = null, invited = false, now = new Date() } = {}, knex = db()) {
  return knex.transaction(async (trx) => {
    // Serialise starts per user so two tabs cannot both create an attempt.
    await trx('users').where({ id: user.id }).forUpdate().first('id');
    const elig = await checkEligibility(user, exam, { ip, invited, now }, trx);
    if (elig.inProgress) return { attempt: elig.inProgress, resumed: true, token: null };
    if (!elig.ok) throw new AttemptError(elig.reasons.map((r) => r.message).join(' '), 403, elig.reasons[0].code);

    const snap = await latestSnapshot(exam.id, trx);
    const e = snap.exam;
    const acc = await trx('user_accommodations').where({ user_id: user.id }).first();
    const extra = acc ? Number(acc.extra_time_percent) || 0 : 0;
    let expires = e.duration_minutes ? new Date(now.getTime() + Math.ceil(e.duration_minutes * (1 + extra / 100)) * 60000) : null;
    if (e.available_until && (!expires || new Date(e.available_until) < expires)) expires = new Date(e.available_until);

    const drawn = await drawQuestions(snap, e, trx);
    if (!drawn.length) throw new AttemptError('This exam has no questions available right now. Please contact support.', 409, 'empty');

    const [{ n }] = await trx('attempts').where({ exam_id: exam.id, user_id: user.id }).whereIn('mode', COUNTED_MODES).count({ n: '*' });
    const token = crypto.randomBytes(24).toString('hex');
    const timedSections = snap.sections.some((s) => s.time_limit_minutes);
    const sectionOrder = [null, ...snap.sections.map((s) => s.id)].filter((sid) => drawn.some((d) => (d.sectionId || null) === sid));
    const state = { pos: 0, posStartedAt: now.toISOString(), timedSections, sectionOrder, sectionIndex: 0, sectionEndsAt: null };
    if (timedSections) state.sectionEndsAt = sectionDeadline(snap, sectionOrder[0], now, extra, expires);

    const [attemptId] = await trx('attempts').insert({
      uuid: crypto.randomUUID(),
      exam_id: exam.id,
      user_id: user.id,
      attempt_no: Number(n) + 1,
      mode: e.type === 'practice' ? 'practice' : e.type === 'mock' ? 'mock' : 'exam',
      status: 'in_progress',
      started_at: now,
      expires_at: expires,
      extra_time_percent: extra,
      exam_version: snap.versionNo,
      ip,
      user_agent: String(userAgent || '').slice(0, 255),
      session_token_hash: sha256(token),
      instructions_accepted_at: now,
      state: toJson(state),
    });

    // Items (case-study parents first, then their parts) with per-attempt option order.
    const versionIds = drawn.flatMap((d) => [d.versionId, ...(d.children || []).map((c) => c.versionId)]);
    const opts = await trx('question_options').whereIn('question_version_id', versionIds).orderBy('display_order');
    const vtypes = new Map((await trx('question_versions').whereIn('id', versionIds).select('id', 'type')).map((v) => [v.id, v.type]));
    let order = 0;
    for (const d of drawn) {
      const type = vtypes.get(d.versionId);
      const row = (q, parentId, marks) => ({
        attempt_id: attemptId,
        parent_item_id: parentId,
        question_id: q.questionId,
        question_version_id: q.versionId,
        section_id: d.sectionId,
        display_order: order++,
        option_order: toJson(optionOrderFor(vtypes.get(q.versionId), opts.filter((o) => o.question_version_id === q.versionId), snap.settings.delivery.shuffle_options)),
        marks_possible: marks,
      });
      const [parentId] = await trx('attempt_items').insert(row(d, null, type === 'case_study' ? 0 : d.marks));
      for (const c of d.children || []) await trx('attempt_items').insert(row(c, parentId, c.marks));
    }
    await trx('attempt_events').insert({ attempt_id: attemptId, type: 'started', details: toJson({ version: snap.versionNo, items: order }), ip });
    const attempt = await trx('attempts').where({ id: attemptId }).first();
    return { attempt, resumed: false, token };
  });
}

function sectionDeadline(snap, sectionId, from, extra, expires) {
  const sec = snap.sections.find((s) => s.id === sectionId);
  if (!sec || !sec.time_limit_minutes) return expires ? new Date(expires).toISOString() : null;
  const end = new Date(new Date(from).getTime() + Math.ceil(sec.time_limit_minutes * (1 + extra / 100)) * 60000);
  return (expires && new Date(expires) < end ? new Date(expires) : end).toISOString();
}

// ---------------------------------------------------------------- Loading for the player (no answers inside)

async function getOwnedAttempt(uuid, user, knex = db()) {
  const a = await knex('attempts').where({ uuid }).first();
  if (!a || a.user_id !== user.id) throw new AttemptError('Attempt not found.', 404, 'not_found');
  return a;
}

/** Candidate-safe payload: stems, options in this attempt's order, saved responses and flags. Never answers. */
async function playerView(attempt, knex = db()) {
  const snap = parseJson((await knex('exam_versions').where({ exam_id: attempt.exam_id, version_no: attempt.exam_version }).first('snapshot')).snapshot, {});
  const items = await knex('attempt_items as ai').join('question_versions as v', 'v.id', 'ai.question_version_id').where('ai.attempt_id', attempt.id).orderBy('ai.display_order').select('ai.*', 'v.type', 'v.stem_html', 'v.marks as v_marks', 'v.settings');
  const opts = await knex('question_options').whereIn('question_version_id', items.map((i) => i.question_version_id)).orderBy('display_order');
  const sections = new Map(snap.sections.map((s) => [s.id, s]));
  const view = items.map((it) => {
    const options = opts.filter((o) => o.question_version_id === it.question_version_id).map((o) => ({ ...o, region: parseJson(o.region) }));
    const cv = types.candidateView({ type: it.type, stem_html: it.stem_html, marks: it.marks_possible }, options, parseJson(it.settings, {}), { optionOrder: parseJson(it.option_order, null) });
    return {
      id: it.id,
      parentId: it.parent_item_id,
      sectionId: it.section_id,
      sectionTitle: it.section_id && sections.get(it.section_id) ? sections.get(it.section_id).title : null,
      type: it.type,
      marks: Number(it.marks_possible),
      view: cv,
      response: parseJson(it.response, null),
      flagged: !!it.flagged,
    };
  });
  return { snap, items: view, state: parseJson(attempt.state, {}) };
}

// ---------------------------------------------------------------- Saving

function deadlineMs(attempt, exam) {
  if (!attempt.expires_at) return Infinity;
  return new Date(attempt.expires_at).getTime() + (Number(exam.grace_seconds) || 0) * 1000 + NETWORK_ALLOWANCE_MS;
}

/** Applies a section timeout: moves on to the next section (or reports that the last one has ended). */
function advanceExpiredSections(state, snap, attempt, now) {
  let changed = false;
  while (state.timedSections && state.sectionEndsAt && new Date(state.sectionEndsAt) <= now && state.sectionIndex < state.sectionOrder.length - 1) {
    const from = new Date(state.sectionEndsAt);
    state.sectionIndex += 1;
    state.sectionEndsAt = sectionDeadline(snap, state.sectionOrder[state.sectionIndex], from, attempt.extra_time_percent, attempt.expires_at);
    changed = true;
  }
  const finished = state.timedSections && state.sectionEndsAt && new Date(state.sectionEndsAt) <= now && state.sectionIndex === state.sectionOrder.length - 1;
  return { changed, finished };
}

/**
 * Saves answers/flags. payload = { answers: [{ itemId, response?, flagged?, timeSpent? }], pos?, token? }.
 * Returns { saved: [itemId], rejected: [{ itemId, reason }], expiresAt, serverTime, state, submitted }.
 */
async function saveAnswers(attempt, payload, { token = null, now = new Date() } = {}, knex = db()) {
  if (attempt.status !== 'in_progress') throw new AttemptError('This attempt has already been submitted.', 409, 'submitted');
  const snap = parseJson((await knex('exam_versions').where({ exam_id: attempt.exam_id, version_no: attempt.exam_version }).first('snapshot')).snapshot, {});
  const exam = snap.exam;
  const single = snap.settings.integrity.single_session;
  if (single && attempt.session_token_hash && (!token || sha256(token) !== attempt.session_token_hash)) {
    throw new AttemptError('This exam is open in another browser or device. Continue there, or reopen it here to move it.', 409, 'other_session');
  }
  if (now.getTime() > deadlineMs(attempt, exam)) {
    await submitAttempt(attempt, 'timeout', { now }, knex);
    return { saved: [], rejected: (payload.answers || []).map((a) => ({ itemId: a.itemId, reason: 'time' })), submitted: true };
  }

  const state = parseJson(attempt.state, {});
  const sec = advanceExpiredSections(state, snap, attempt, now);
  if (sec.finished) {
    await knex('attempts').where({ id: attempt.id }).update({ state: toJson(state) });
    await submitAttempt({ ...attempt, state: toJson(state) }, 'timeout', { now }, knex);
    return { saved: [], rejected: [], submitted: true };
  }

  const items = await knex('attempt_items').where({ attempt_id: attempt.id }).select('id', 'display_order', 'section_id', 'parent_item_id');
  const byId = new Map(items.map((i) => [String(i.id), i]));
  const linear = snap.settings.delivery.navigation === 'linear';
  const perQ = exam.per_question_seconds ? Number(exam.per_question_seconds) * (1 + attempt.extra_time_percent / 100) * 1000 + (Number(exam.grace_seconds) || 0) * 1000 + NETWORK_ALLOWANCE_MS : null;
  const topLevel = items.filter((i) => !i.parent_item_id).sort((a, b) => a.display_order - b.display_order);
  const posOf = (it) => topLevel.findIndex((t) => t.id === (it.parent_item_id || it.id));

  // Navigation (linear exams can only move forward; per-question time limits are enforced here).
  if (payload.pos !== undefined && payload.pos !== null) {
    const p = Math.max(0, Math.min(topLevel.length - 1, Number(payload.pos) || 0));
    if (!linear || p > state.pos) {
      if (p !== state.pos) state.posStartedAt = now.toISOString();
      state.pos = p;
    }
  }

  const saved = [];
  const rejected = [];
  const currentSection = state.timedSections ? state.sectionOrder[state.sectionIndex] : undefined;
  for (const a of (payload.answers || []).slice(0, 200)) {
    const it = byId.get(String(a.itemId));
    if (!it) {
      rejected.push({ itemId: a.itemId, reason: 'unknown' });
      continue;
    }
    if (currentSection !== undefined && (it.section_id || null) !== currentSection) {
      rejected.push({ itemId: a.itemId, reason: 'section_closed' });
      continue;
    }
    const pos = posOf(it);
    if (linear && pos < state.pos) {
      rejected.push({ itemId: a.itemId, reason: 'linear' });
      continue;
    }
    if (perQ && pos === state.pos && now - new Date(state.posStartedAt) > perQ) {
      rejected.push({ itemId: a.itemId, reason: 'question_time' });
      continue;
    }
    const patch = {};
    if (a.response !== undefined) {
      const json = toJson(a.response === null ? null : a.response);
      if (json && json.length > MAX_RESPONSE_BYTES) {
        rejected.push({ itemId: a.itemId, reason: 'too_large' });
        continue;
      }
      patch.response = json;
      patch.answered_at = now;
    }
    if (a.flagged !== undefined) patch.flagged = !!a.flagged;
    if (a.timeSpent !== undefined) patch.time_spent_sec = knex.raw('LEAST(time_spent_sec + ?, 86400)', [Math.max(0, Math.min(3600, Math.round(Number(a.timeSpent) || 0)))]);
    if (Object.keys(patch).length) await knex('attempt_items').where({ id: it.id }).update(patch);
    saved.push(it.id);
  }
  await knex('attempts').where({ id: attempt.id }).update({ state: toJson(state), updated_at: now });
  return { saved, rejected, submitted: false, expiresAt: attempt.expires_at, serverTime: now.toISOString(), state };
}

/** Candidate finishes the current timed section early. */
async function finishSection(attempt, { now = new Date() } = {}, knex = db()) {
  const state = parseJson(attempt.state, {});
  if (!state.timedSections) return state;
  if (state.sectionIndex >= state.sectionOrder.length - 1) return state;
  const snap = parseJson((await knex('exam_versions').where({ exam_id: attempt.exam_id, version_no: attempt.exam_version }).first('snapshot')).snapshot, {});
  state.sectionIndex += 1;
  state.sectionEndsAt = sectionDeadline(snap, state.sectionOrder[state.sectionIndex], now, attempt.extra_time_percent, attempt.expires_at);
  await knex('attempts').where({ id: attempt.id }).update({ state: toJson(state) });
  await knex('attempt_events').insert({ attempt_id: attempt.id, type: 'section_finished', details: toJson({ section: state.sectionOrder[state.sectionIndex - 1] }) });
  return state;
}

/** Moves the attempt to this browser (single-session exams): issues a new token, invalidating the other tab/device. */
async function takeOver(attempt, ip, knex = db()) {
  const token = crypto.randomBytes(24).toString('hex');
  await knex('attempts').where({ id: attempt.id }).update({ session_token_hash: sha256(token) });
  await knex('attempt_events').insert({ attempt_id: attempt.id, type: 'session_moved', details: null, ip });
  return token;
}

// ---------------------------------------------------------------- Integrity events

const EVENT_TYPES = ['tab_hidden', 'tab_visible', 'fullscreen_exit', 'fullscreen_enter', 'copy', 'paste', 'context_menu', 'offline', 'online', 'resume', 'webcam_denied'];
const PENALTY = { tab_hidden: 5, fullscreen_exit: 5, copy: 2, paste: 2, context_menu: 1 };

async function recordEvent(attempt, type, details, ip, knex = db()) {
  if (!EVENT_TYPES.includes(type) || attempt.status !== 'in_progress') return { recorded: false };
  await knex('attempt_events').insert({ attempt_id: attempt.id, type, details: toJson(details || null), ip });
  const patch = {};
  if (type === 'tab_hidden') patch.tab_switches = knex.raw('tab_switches + 1');
  if (type === 'fullscreen_exit') patch.fullscreen_exits = knex.raw('fullscreen_exits + 1');
  if (PENALTY[type]) patch.integrity_score = knex.raw('GREATEST(0, integrity_score - ?)', [PENALTY[type]]);
  if (Object.keys(patch).length) await knex('attempts').where({ id: attempt.id }).update(patch);
  if (type === 'tab_hidden') {
    const snap = parseJson((await knex('exam_versions').where({ exam_id: attempt.exam_id, version_no: attempt.exam_version }).first('snapshot')).snapshot, {});
    const ig = snap.settings.integrity;
    const fresh = await knex('attempts').where({ id: attempt.id }).first('tab_switches');
    if (ig.auto_submit_on_limit && ig.tab_switch_limit && fresh.tab_switches >= ig.tab_switch_limit) {
      await submitAttempt(attempt, 'integrity', {}, knex);
      return { recorded: true, submitted: true, tabSwitches: fresh.tab_switches };
    }
    return { recorded: true, tabSwitches: fresh.tab_switches, limit: ig.tab_switch_limit || null };
  }
  return { recorded: true };
}

// ---------------------------------------------------------------- Submit

/**
 * Submits and grades in one transaction. Idempotent: a second submit (double click, sweeper race) is a no-op.
 * reason: candidate | timeout | sweeper | integrity | admin
 */
async function submitAttempt(attempt, reason = 'candidate', { now = new Date() } = {}, knex = db()) {
  const certificates = require('../certificates');
  const out = await knex.transaction(async (trx) => {
    const locked = await trx('attempts').where({ id: attempt.id }).forUpdate().first();
    if (!locked || locked.status !== 'in_progress') return { alreadySubmitted: true, attempt: locked };
    const late = locked.expires_at && now > new Date(locked.expires_at);
    await trx('attempts')
      .where({ id: locked.id })
      .update({ status: late && reason !== 'candidate' ? 'expired' : 'submitted', submitted_at: late ? new Date(Math.min(now.getTime(), new Date(locked.expires_at).getTime() + 1000)) : now, submit_reason: reason });
    await trx('attempt_events').insert({ attempt_id: locked.id, type: 'submitted', details: toJson({ reason }) });
    const result = await grading.gradeAttempt(locked.id, { knex: trx });
    let certificate = null;
    if (result.passed && locked.mode !== 'study') certificate = await certificates.issueForAttempt(locked.id, trx);
    return { alreadySubmitted: false, result, certificate };
  });
  if (out.certificate) await require('../notifications/results').certificateIssued(attempt.id, out.certificate.code);
  return out;
}

/**
 * "Retake weak areas": an untimed personal practice set (mode 'study') of up to 15 published questions from the given
 * domains. It never counts as an attempt, never issues a certificate and is excluded from percentiles.
 */
async function startStudySet(user, exam, domainIds, { ip = null, now = new Date() } = {}, knex = db()) {
  const snap = await latestSnapshot(exam.id, knex);
  if (!snap) return null;
  const rows = await knex('questions as q')
    .whereIn('q.domain_id', domainIds)
    .where('q.status', 'published')
    .whereNull('q.deleted_at')
    .whereNull('q.parent_id')
    .whereNot('q.type', 'case_study')
    .where((w) => {
      w.whereNull('q.organisation_id');
      if (exam.organisation_id) w.orWhere('q.organisation_id', exam.organisation_id);
    })
    .orderByRaw('RAND()')
    .limit(15)
    .select('q.id', 'q.current_version_id', 'q.default_marks');
  if (!rows.length) return null;
  return knex.transaction(async (trx) => {
    const token = crypto.randomBytes(24).toString('hex');
    const [attemptId] = await trx('attempts').insert({
      uuid: crypto.randomUUID(),
      exam_id: exam.id,
      user_id: user.id,
      attempt_no: 0,
      mode: 'study',
      status: 'in_progress',
      started_at: now,
      expires_at: null,
      exam_version: snap.versionNo,
      ip,
      session_token_hash: sha256(token),
      instructions_accepted_at: now,
      state: toJson({ pos: 0, posStartedAt: now.toISOString(), timedSections: false, sectionOrder: [null], sectionIndex: 0, sectionEndsAt: null, study: true }),
    });
    const vids = rows.map((r) => r.current_version_id);
    const opts = await trx('question_options').whereIn('question_version_id', vids).orderBy('display_order');
    const vtypes = new Map((await trx('question_versions').whereIn('id', vids).select('id', 'type')).map((v) => [v.id, v.type]));
    let order = 0;
    for (const r of rows) {
      await trx('attempt_items').insert({ attempt_id: attemptId, question_id: r.id, question_version_id: r.current_version_id, section_id: null, display_order: order++, option_order: toJson(optionOrderFor(vtypes.get(r.current_version_id), opts.filter((o) => o.question_version_id === r.current_version_id), true)), marks_possible: Number(r.default_marks) });
    }
    return { attempt: await trx('attempts').where({ id: attemptId }).first(), token };
  });
}

/** Scheduled: submits every in-progress attempt whose time (plus grace) has run out. */
async function sweepExpired({ knex = db(), now = new Date() } = {}) {
  const rows = await knex('attempts as a').join('exams as e', 'e.id', 'a.exam_id').where('a.status', 'in_progress').whereNotNull('a.expires_at').whereRaw('DATE_ADD(a.expires_at, INTERVAL (e.grace_seconds + 5) SECOND) < ?', [now]).limit(200).select('a.*');
  let n = 0;
  for (const a of rows) {
    const r = await submitAttempt(a, 'sweeper', { now }, knex);
    if (!r.alreadySubmitted) n += 1;
  }
  return { submitted: n };
}

/** Scheduled: releases results of "after the window" exams once the window has closed. */
async function releaseClosedWindows({ knex = db(), now = new Date() } = {}) {
  const ids = await knex('results as r').join('exams as e', 'e.id', 'r.exam_id').where('r.release_status', 'withheld').where('e.result_release', 'after_window').whereNotNull('e.available_until').where('e.available_until', '<=', now).pluck('r.id');
  if (ids.length) {
    await knex('results').whereIn('id', ids).update({ release_status: 'released', released_at: now });
    const notify = require('../notifications/results');
    for (const a of await knex('results').whereIn('id', ids).pluck('attempt_id')) await notify.resultReleased(a);
  }
  return { released: ids.length };
}

module.exports = { startStudySet, startAttempt, playerView, getOwnedAttempt, saveAnswers, finishSection, takeOver, recordEvent, submitAttempt, sweepExpired, releaseClosedWindows, latestSnapshot, optionOrderFor, AttemptError, EVENT_TYPES, sha256 };
