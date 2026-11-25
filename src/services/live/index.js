'use strict';

/**
 * Live quiz (Wayground/Quizizz-style) — all state and scoring live on the server.
 *
 * Modes
 *   host_paced    the host's screen drives every question (lobby → question → reveal → leaderboard → … → podium)
 *   player_paced  everyone moves at their own speed; with `settings.deadline` it is "homework"
 *
 * Scoring (per question, correct answers only)
 *   500 base + up to 500 speed bonus (linear over the timer) + streak bonus 100 × (streak − 1), capped at 500.
 *
 * Sockets only transport events (see socket.js); every rule is enforced here so it can be unit-tested.
 */
const crypto = require('crypto');
const { db } = require('../../config/db');
const { getEnv } = require('../../config/env');
const { parseJson, toJson } = require('../../utils/json');
const types = require('../questions/types');
const { markItem } = require('../grading/strategies');

const LIVE_TYPES = ['single_choice', 'multiple_response', 'true_false', 'numeric', 'fill_blank'];
const DEFAULTS = { timer: 20, shuffle: false, show_answers: true, deadline: null };
const MAX_PLAYERS = 500;

class LiveError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const now = () => new Date();

// ---------------------------------------------------------------- Tokens

function hostToken(sessionId, userId) {
  return crypto.createHmac('sha256', getEnv().SESSION_SECRET).update(`live-host:${sessionId}:${userId}`).digest('hex');
}

function checkHostToken(sessionId, userId, token) {
  const want = Buffer.from(hostToken(sessionId, userId));
  const got = Buffer.from(String(token || ''));
  return got.length === want.length && crypto.timingSafeEqual(want, got);
}

// ---------------------------------------------------------------- Questions

/** Questions an exam can contribute to a live quiz (fixed list, auto-marked types, current version). */
async function liveQuestions(examId, knex = db()) {
  return knex('exam_questions as eq')
    .join('questions as q', 'q.id', 'eq.question_id')
    .join('question_versions as v', 'v.id', 'q.current_version_id')
    .where('eq.exam_id', examId)
    .whereNull('q.deleted_at')
    .whereIn('v.type', LIVE_TYPES)
    .orderBy('eq.display_order')
    .select('q.id as q', 'v.id as v');
}

async function loadVersion(versionId, knex = db()) {
  const v = await knex('question_versions as v').leftJoin('question_answers as qa', 'qa.question_version_id', 'v.id').where('v.id', versionId).first('v.*', 'qa.answer');
  const options = await knex('question_options').where({ question_version_id: versionId }).orderBy('display_order');
  return { v, options, settings: parseJson(v.settings, {}), answer: parseJson(v.answer, {}) };
}

/** What players see: no answers, no explanations. */
async function playerQuestion(sess, index, knex = db()) {
  const ref = sess.question_ids[index];
  if (!ref) return null;
  const { v, options, settings } = await loadVersion(ref.v, knex);
  const view = types.candidateView(v, options, settings, { shuffleOptions: false });
  return { index, total: sess.question_ids.length, type: v.type, stem_html: view.stem_html, options: view.options || null, settings: view.settings, timer: sess.settings.timer };
}

/** Correct answer + per-option counts for the reveal screen. */
async function reveal(sess, index, knex = db()) {
  const ref = sess.question_ids[index];
  const { v, options, answer } = await loadVersion(ref.v, knex);
  const rows = await knex('live_answers').where({ session_id: sess.id, question_index: index }).select('response', 'is_correct');
  const counts = {};
  for (const r of rows) {
    const resp = parseJson(r.response, {}) || {};
    for (const k of [].concat(resp.selected || [])) counts[k] = (counts[k] || 0) + 1;
  }
  let correctText = null;
  if (v.type === 'numeric') correctText = `${answer.value}${answer.tolerance ? ` (± ${answer.tolerance})` : ''}`;
  if (v.type === 'fill_blank') correctText = (answer.blanks || []).map((b) => (b.variants || [])[0]).join(' / ');
  return {
    index,
    correct: answer.correct || [],
    correctText,
    counts,
    answered: rows.length,
    right: rows.filter((r) => r.is_correct).length,
    explanation_html: sess.settings.show_answers ? v.explanation_html || null : null,
    options: options.map((o) => o.option_key),
  };
}

// ---------------------------------------------------------------- Sessions

async function uniquePin(knex) {
  for (let i = 0; i < 20; i += 1) {
    const pin = String(crypto.randomInt(100000, 1000000));
    const clash = await knex('live_sessions').where({ pin }).whereIn('status', ['lobby', 'running', 'paused']).first('id');
    if (!clash) return pin;
  }
  throw new LiveError('Could not allocate a game PIN. Try again.');
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, settings: { ...DEFAULTS, ...(parseJson(row.settings, {}) || {}) }, question_ids: parseJson(row.question_ids, []) || [] };
}

async function getSession(id, knex = db()) {
  return hydrate(await knex('live_sessions').where({ id }).first());
}

async function byPin(pin, knex = db()) {
  return hydrate(await knex('live_sessions').where({ pin: String(pin || '').trim() }).whereIn('status', ['lobby', 'running', 'paused']).orderBy('id', 'desc').first());
}

/** Creates a session. kind: live | self_paced | homework. */
async function createSession({ examId, hostId, kind = 'live', timer, allowGuests = false, shuffle = false, deadline = null, showAnswers = true }, knex = db()) {
  const exam = await knex('exams').where({ id: examId }).whereNull('deleted_at').first('id', 'title');
  if (!exam) throw new LiveError('Choose a quiz.');
  let qs = await liveQuestions(examId, knex);
  if (!qs.length) throw new LiveError('That exam has no questions a live quiz can use (single or multiple choice, true/false, numeric or fill in the blank, in a fixed question list).');
  if (shuffle) qs = types.shuffle(qs);
  const t = Math.round(Number(timer) || DEFAULTS.timer);
  if (t < 5 || t > 240) throw new LiveError('The question timer must be between 5 and 240 seconds.');
  let dl = null;
  if (kind === 'homework') {
    dl = deadline ? new Date(deadline) : null;
    if (!dl || Number.isNaN(dl.getTime()) || dl <= now()) throw new LiveError('Set a deadline in the future for homework.');
  }
  const selfPaced = kind !== 'live';
  const [id] = await knex('live_sessions').insert({
    pin: await uniquePin(knex),
    exam_id: examId,
    host_id: hostId,
    mode: selfPaced ? 'player_paced' : 'host_paced',
    status: kind === 'homework' ? 'running' : 'lobby',
    phase: kind === 'homework' ? 'question' : 'lobby',
    allow_guests: !!allowGuests,
    settings: toJson({ timer: t, shuffle: !!shuffle, show_answers: !!showAnswers, deadline: dl ? dl.toISOString() : null, kind, title: exam.title }),
    question_ids: toJson(qs),
    started_at: kind === 'homework' ? now() : null,
  });
  return getSession(id, knex);
}

function closed(sess) {
  if (['finished', 'cancelled'].includes(sess.status)) return true;
  return !!(sess.settings.deadline && new Date(sess.settings.deadline) <= now());
}

// ---------------------------------------------------------------- Players

function cleanNickname(n) {
  return String(n || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

/** Joins (or rejoins with the same token). Returns { player, token }. */
async function join(sess, { nickname, userId = null, token = null }, knex = db()) {
  if (!sess || closed(sess)) throw new LiveError('That game has ended or the PIN is wrong.', 404);
  if (token) {
    const p = await knex('live_players').where({ session_id: sess.id, token_hash: sha(token) }).first();
    if (p && !p.kicked) return { player: p, token };
  }
  if (userId) {
    const mine = await knex('live_players').where({ session_id: sess.id, user_id: userId }).first();
    if (mine) {
      if (mine.kicked) throw new LiveError('The host removed you from this game.', 403);
      const fresh = crypto.randomBytes(24).toString('hex');
      await knex('live_players').where({ id: mine.id }).update({ token_hash: sha(fresh) });
      return { player: { ...mine, token_hash: sha(fresh) }, token: fresh };
    }
  }
  if (!userId && !sess.allow_guests) throw new LiveError('Sign in to join this game.', 401);
  const name = cleanNickname(nickname);
  if (name.length < 2) throw new LiveError('Choose a nickname of at least 2 characters.');
  const count = Number((await knex('live_players').where({ session_id: sess.id }).count('* as n').first()).n);
  if (count >= MAX_PLAYERS) throw new LiveError('This game is full.');
  if (await knex('live_players').where({ session_id: sess.id, nickname: name }).first('id')) throw new LiveError('That nickname is taken in this game. Choose another.');
  const fresh = crypto.randomBytes(24).toString('hex');
  const selfPaced = sess.mode === 'player_paced' && sess.status === 'running';
  const [id] = await knex('live_players').insert({ session_id: sess.id, user_id: userId, nickname: name, token_hash: sha(fresh), current_index: 0, question_started_at: selfPaced ? now() : null });
  return { player: await knex('live_players').where({ id }).first(), token: fresh };
}

async function playerByToken(sessionId, token, knex = db()) {
  if (!token) return null;
  const p = await knex('live_players').where({ session_id: sessionId, token_hash: sha(token) }).first();
  return p && !p.kicked ? p : null;
}

// ---------------------------------------------------------------- Scoring

function points({ correct, responseMs, timerSec, streak }) {
  if (!correct) return 0;
  const limit = timerSec * 1000;
  const speed = Math.round(500 * Math.max(0, 1 - Math.min(responseMs, limit) / limit));
  const bonus = Math.min(500, 100 * Math.max(0, streak - 1));
  return 500 + speed + bonus;
}

/** Records one answer. Returns { correct, points, score, streak }. One answer per question per player. */
async function answer(sess, player, { index, response }, knex = db()) {
  if (closed(sess)) throw new LiveError('This game has ended.');
  const i = Number(index);
  let startedAt;
  if (sess.mode === 'host_paced') {
    if (sess.status !== 'running' || sess.phase !== 'question' || i !== sess.current_index) throw new LiveError('This question is closed.');
    startedAt = new Date(sess.question_started_at);
    if (Date.now() > startedAt.getTime() + sess.settings.timer * 1000 + 1500) throw new LiveError('Time is up for this question.');
  } else {
    if (sess.status !== 'running') throw new LiveError('The game has not started yet.');
    if (i !== player.current_index) throw new LiveError('Answer the current question.');
    startedAt = player.question_started_at ? new Date(player.question_started_at) : now();
  }
  const ref = sess.question_ids[i];
  if (!ref) throw new LiveError('No such question.');
  if (await knex('live_answers').where({ player_id: player.id, question_index: i }).first('id')) throw new LiveError('You already answered this question.');
  const { v, answer: key, settings } = await loadVersion(ref.v, knex);
  const resp = normaliseResponse(v.type, response);
  const marked = await markItem({ type: v.type, marks: 1, answer: key, settings }, resp, { partialCredit: false, negative: 0 });
  const correct = !!marked.correct;
  const responseMs = Math.max(0, Date.now() - startedAt.getTime());
  const streak = correct ? player.streak + 1 : 0;
  const pts = points({ correct, responseMs, timerSec: sess.settings.timer, streak });
  await knex.transaction(async (trx) => {
    await trx('live_answers').insert({ session_id: sess.id, player_id: player.id, question_index: i, question_id: ref.q, question_version_id: ref.v, response: toJson(resp), is_correct: correct, points: pts, response_ms: Math.min(responseMs, 2147483647) });
    const patch = { score: player.score + pts, streak };
    if (sess.mode === 'player_paced') {
      patch.current_index = i + 1;
      patch.question_started_at = now();
      if (i + 1 >= sess.question_ids.length) patch.finished_at = now();
    }
    await trx('live_players').where({ id: player.id }).update(patch);
  });
  return { correct, points: pts, score: player.score + pts, streak };
}

function normaliseResponse(type, r) {
  const x = r && typeof r === 'object' ? r : {};
  if (type === 'multiple_response') return { selected: [].concat(x.selected || []).map(String).slice(0, 10) };
  if (type === 'numeric') return { value: String(x.value ?? '').slice(0, 40) };
  if (type === 'fill_blank') return { blanks: [].concat(x.blanks || []).map((b) => String(b).slice(0, 200)).slice(0, 10) };
  return { selected: String([].concat(x.selected || [])[0] || '').slice(0, 4) };
}

// ---------------------------------------------------------------- Host actions

async function update(sess, patch, knex) {
  await knex('live_sessions').where({ id: sess.id }).update({ ...patch, updated_at: now() });
  return getSession(sess.id, knex);
}

async function start(sess, knex = db()) {
  if (sess.status !== 'lobby') throw new LiveError('The game has already started.');
  if (sess.mode === 'player_paced') {
    await knex('live_players').where({ session_id: sess.id }).update({ question_started_at: now(), current_index: 0 });
    return update(sess, { status: 'running', phase: 'question', started_at: now() }, knex);
  }
  return update(sess, { status: 'running', phase: 'question', current_index: 0, question_started_at: now(), started_at: now() }, knex);
}

/** Host-paced: question → reveal → leaderboard → next question (or podium). */
async function next(sess, knex = db()) {
  if (sess.mode !== 'host_paced') throw new LiveError('Players move at their own pace in this game.');
  if (sess.status === 'lobby') return start(sess, knex);
  if (sess.status !== 'running') throw new LiveError('Resume the game first.');
  if (sess.phase === 'question') return update(sess, { phase: 'reveal' }, knex);
  if (sess.phase === 'reveal') return update(sess, { phase: 'leaderboard' }, knex);
  if (sess.phase === 'leaderboard') {
    if (sess.current_index + 1 >= sess.question_ids.length) return finish(sess, knex);
    return update(sess, { phase: 'question', current_index: sess.current_index + 1, question_started_at: now() }, knex);
  }
  return sess;
}

async function pause(sess, knex = db()) {
  if (sess.status !== 'running' || sess.phase !== 'question' || sess.mode !== 'host_paced') throw new LiveError('You can pause while a question is open.');
  const remaining = Math.max(0, new Date(sess.question_started_at).getTime() + sess.settings.timer * 1000 - Date.now());
  return update(sess, { status: 'paused', settings: toJson({ ...sess.settings, paused_remaining_ms: remaining }) }, knex);
}

async function resume(sess, knex = db()) {
  if (sess.status !== 'paused') throw new LiveError('The game is not paused.');
  const remaining = Number(sess.settings.paused_remaining_ms) || 0;
  const startedAt = new Date(Date.now() - (sess.settings.timer * 1000 - remaining));
  const { paused_remaining_ms: _drop, ...rest } = sess.settings;
  return update(sess, { status: 'running', question_started_at: startedAt, settings: toJson(rest) }, knex);
}

async function kick(sess, playerId, knex = db()) {
  await knex('live_players').where({ id: playerId, session_id: sess.id }).update({ kicked: true, connected: false });
}

async function finish(sess, knex = db()) {
  return update(sess, { status: 'finished', phase: 'podium', ended_at: now() }, knex);
}

// ---------------------------------------------------------------- Views

async function leaderboard(sessionId, limit = 10, knex = db()) {
  const rows = await knex('live_players').where({ session_id: sessionId, kicked: false }).orderBy([{ column: 'score', order: 'desc' }, { column: 'id', order: 'asc' }]).select('id', 'nickname', 'score', 'streak', 'current_index', 'finished_at', 'connected');
  return { total: rows.length, top: rows.slice(0, limit).map((r, i) => ({ rank: i + 1, id: r.id, nickname: r.nickname, score: r.score, streak: r.streak })), all: rows };
}

function endsAt(sess) {
  if (sess.mode !== 'host_paced' || sess.phase !== 'question' || !sess.question_started_at) return null;
  if (sess.status === 'paused') return null;
  return new Date(new Date(sess.question_started_at).getTime() + sess.settings.timer * 1000).toISOString();
}

/** State every player in the room sees. */
async function publicState(sess, knex = db()) {
  const lb = await leaderboard(sess.id, 10, knex);
  const out = {
    id: sess.id,
    title: sess.settings.title,
    mode: sess.mode,
    kind: sess.settings.kind,
    status: closed(sess) && sess.status !== 'finished' ? 'finished' : sess.status,
    phase: sess.phase,
    index: sess.current_index,
    total: sess.question_ids.length,
    endsAt: endsAt(sess),
    serverNow: Date.now(),
    pausedRemainingMs: sess.status === 'paused' ? sess.settings.paused_remaining_ms : null,
    deadline: sess.settings.deadline,
    players: lb.total,
    leaderboard: ['leaderboard', 'podium'].includes(sess.phase) || sess.mode === 'player_paced' ? lb.top : [],
    lobby: sess.phase === 'lobby' ? lb.all.map((p) => p.nickname).slice(-60) : [],
    question: null,
    reveal: null,
  };
  if (sess.mode === 'host_paced' && sess.status !== 'lobby' && sess.current_index >= 0) {
    if (['question', 'reveal'].includes(sess.phase)) out.question = await playerQuestion(sess, sess.current_index, knex);
    if (sess.phase === 'reveal') out.reveal = await reveal(sess, sess.current_index, knex);
  }
  return out;
}

/** Personal state for one player. */
async function playerState(sess, player, knex = db()) {
  const lb = await leaderboard(sess.id, 1000, knex);
  const rank = lb.all.findIndex((p) => p.id === player.id) + 1;
  const me = { id: player.id, nickname: player.nickname, score: player.score, streak: player.streak, rank, of: lb.total, answeredCurrent: false, last: null, question: null, finished: !!player.finished_at };
  const idx = sess.mode === 'host_paced' ? sess.current_index : player.current_index;
  if (idx >= 0) {
    const a = await knex('live_answers').where({ player_id: player.id, question_index: sess.mode === 'host_paced' ? idx : idx - 1 }).first('is_correct', 'points');
    if (sess.mode === 'host_paced') me.answeredCurrent = !!(await knex('live_answers').where({ player_id: player.id, question_index: idx }).first('id'));
    if (a) me.last = { correct: !!a.is_correct, points: a.points };
  }
  if (sess.mode === 'player_paced' && sess.status === 'running' && !closed(sess) && !player.finished_at) me.question = await playerQuestion(sess, player.current_index, knex);
  return me;
}

/** Extra detail for the host: who has answered, live distribution, every player's progress. */
async function hostState(sess, knex = db()) {
  const state = await publicState(sess, knex);
  const lb = await leaderboard(sess.id, 1000, knex);
  state.pin = sess.pin;
  state.allPlayers = lb.all.map((p) => ({ id: p.id, nickname: p.nickname, score: p.score, progress: p.current_index, finished: !!p.finished_at, connected: !!p.connected }));
  state.leaderboard = lb.all.slice(0, 10).map((p, i) => ({ rank: i + 1, id: p.id, nickname: p.nickname, score: p.score, streak: p.streak }));
  if (sess.mode === 'host_paced' && sess.current_index >= 0 && sess.status !== 'lobby') {
    const r = await reveal(sess, sess.current_index, knex);
    state.live = { answered: r.answered, counts: r.counts };
  }
  return state;
}

// ---------------------------------------------------------------- Report

async function report(sessionId, knex = db()) {
  const sess = await getSession(sessionId, knex);
  const players = await knex('live_players').where({ session_id: sessionId }).orderBy('score', 'desc').select('*');
  const answers = await knex('live_answers').where({ session_id: sessionId }).select('*');
  const byPlayer = new Map(players.map((p) => [p.id, []]));
  for (const a of answers) if (byPlayer.has(a.player_id)) byPlayer.get(a.player_id).push(a);
  const total = sess.question_ids.length;
  const rows = players.map((p, i) => {
    const list = byPlayer.get(p.id);
    const right = list.filter((a) => a.is_correct).length;
    return { rank: i + 1, nickname: p.nickname, score: p.score, correct: right, answered: list.length, total, accuracy: list.length ? Math.round((right / total) * 100) : 0, avgSeconds: list.length ? Math.round(list.reduce((s, a) => s + a.response_ms, 0) / list.length / 100) / 10 : null, kicked: !!p.kicked };
  });
  const stems = await knex('question_versions').whereIn('id', sess.question_ids.map((q) => q.v)).select('id', 'stem_html', 'type');
  const stemBy = new Map(stems.map((s) => [s.id, s]));
  const questions = sess.question_ids.map((ref, i) => {
    const list = answers.filter((a) => a.question_index === i);
    const right = list.filter((a) => a.is_correct).length;
    const s = stemBy.get(ref.v) || {};
    return { index: i, questionId: ref.q, type: s.type, stem: String(s.stem_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160), answered: list.length, correctPct: list.length ? Math.round((right / list.length) * 100) : null, avgSeconds: list.length ? Math.round(list.reduce((s2, a) => s2 + a.response_ms, 0) / list.length / 100) / 10 : null };
  });
  return { session: sess, players: rows, questions };
}

module.exports = {
  LIVE_TYPES,
  LiveError,
  hostToken,
  checkHostToken,
  liveQuestions,
  createSession,
  getSession,
  byPin,
  join,
  playerByToken,
  answer,
  points,
  start,
  next,
  pause,
  resume,
  kick,
  finish,
  closed,
  publicState,
  playerState,
  hostState,
  leaderboard,
  report,
  cleanNickname,
};
