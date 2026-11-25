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
const DEFAULTS = { timer: 20, shuffle: false, show_answers: true, deadline: null, auto_advance: true, reveal_seconds: 5, leaderboard_seconds: 6, max_flags: 0 };
const MAX_PLAYERS = 500;

// ---------------------------------------------------------------- Game mode (host can switch each part on or off live)
//   leaderboard  real-time ranking for everyone while playing (answers lock once given, so scores can't be probed)
//   race         every player is a racer on a track, moving with their progress
//   reactions    emoji reactions that float across every screen, plus achievement badges announced to the room
const FUN_KEYS = ['leaderboard', 'race', 'reactions'];
const REACTIONS = ['👏', '🔥', '😂', '😮', '🎉', '💯'];
const AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐵', '🐧', '🦄', '🐙', '🐝', '🐨', '🐳', '🦉', '🐢', '🦋', '🐞', '🦖', '🐬', '🦩', '🐺'];
const BADGES = {
  first_blood: { emoji: '⚡', text: 'answered first' },
  speedster: { emoji: '💨', text: 'answered 3 in a row in under 5 seconds' },
  halfway: { emoji: '🚀', text: 'is halfway there' },
  on_fire: { emoji: '🔥', text: 'is on fire — 3 correct in a row' },
  first_finish: { emoji: '🏁', text: 'finished first' },
};
const avatarFor = (id) => AVATARS[Number(id) % AVATARS.length];
const funOf = (sess) => {
  const f = (sess.settings && sess.settings.fun) || {};
  return { leaderboard: !!f.leaderboard, race: !!f.race, reactions: !!f.reactions };
};

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
async function createSession({ examId, hostId, kind = 'live', timer, allowGuests = false, shuffle = false, deadline = null, showAnswers = true, autoAdvance = true, revealSeconds = 5, leaderboardSeconds = 6, maxFlags = 0, fun = {} }, knex = db()) {
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
    settings: toJson({ timer: t, shuffle: !!shuffle, show_answers: !!showAnswers, deadline: dl ? dl.toISOString() : null, kind, title: exam.title, auto_advance: !!autoAdvance, reveal_seconds: clampSec(revealSeconds, 5), leaderboard_seconds: clampSec(leaderboardSeconds, 6), max_flags: Math.min(50, Math.max(0, Math.round(Number(maxFlags) || 0))), fun: Object.fromEntries(FUN_KEYS.map((k) => [k, !!(fun || {})[k]])) }),
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
    return answerAtOwnPace(sess, player, i, response, knex);
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

// ---------------------------------------------------------------- Own-pace play (the default "live" game)
//
// Each player moves independently. Answers can be changed (with Previous) until the player submits; nothing
// tells them whether an answer is right. Scores are calculated at submit, and every player sees their answers
// with the correct ones only when the game ends.

async function answeredIndexes(playerId, knex) {
  return (await knex('live_answers').where({ player_id: playerId }).orderBy('question_index').pluck('question_index')).map(Number);
}

/** The next unanswered question after `from` (wrapping round), or `total` (= the review & submit screen). */
function nextOpen(answered, from, total) {
  const done = new Set(answered);
  for (let k = 1; k <= total; k += 1) {
    const i = (from + k) % total;
    if (!done.has(i)) return i;
  }
  return total;
}

async function answerAtOwnPace(sess, player, i, response, knex) {
  if (sess.status !== 'running') throw new LiveError('The game has not started yet.');
  if (player.finished_at) throw new LiveError('You have already submitted your answers.');
  const ref = sess.question_ids[i];
  if (!ref) throw new LiveError('No such question.');
  const { v, answer: key, settings } = await loadVersion(ref.v, knex);
  const resp = normaliseResponse(v.type, response);
  const marked = await markItem({ type: v.type, marks: 1, answer: key, settings }, resp, { partialCredit: false, negative: 0 });
  const existing = await knex('live_answers').where({ player_id: player.id, question_index: i }).first('id');
  if (existing && funOf(sess).leaderboard) throw new LiveError('The live leaderboard is on, so answers are final once given.');
  const startedAt = player.question_started_at && player.current_index === i ? new Date(player.question_started_at) : now();
  if (existing) await knex('live_answers').where({ id: existing.id }).update({ response: toJson(resp), is_correct: !!marked.correct });
  else {
    const ms = Math.min(Math.max(0, Date.now() - startedAt.getTime()), 2147483647);
    await knex('live_answers').insert({ session_id: sess.id, player_id: player.id, question_index: i, question_id: ref.q, question_version_id: ref.v, response: toJson(resp), is_correct: !!marked.correct, points: 0, response_ms: ms });
    // Faster than anyone can read the question: worth a look (a bot or a shared answer key).
    if (ms < 900) await recordIntegrity(sess, player, 'fast_answer', { question: i + 1, ms }, knex, { count: false });
  }
  const answered = await answeredIndexes(player.id, knex);
  const total = sess.question_ids.length;
  // Next: the following question if it is still open, otherwise the next open one, otherwise review & submit.
  const next = answered.length >= total ? total : !answered.includes(i + 1) && i + 1 < total ? i + 1 : nextOpen(answered, i, total);
  await knex('live_players').where({ id: player.id }).update({ current_index: next, question_started_at: now() });
  const badges = existing ? [] : await awardBadges(sess, player, { answered: answered.length }, knex);
  return badges.length ? { saved: true, next, badges } : { saved: true, next };
}

/**
 * Achievement badges (game mode → reactions on). Each badge once per player; returned so the socket layer can
 * announce them to the room. "On fire" reveals correctness, so it only runs with the live leaderboard on.
 */
async function awardBadges(sess, player, { answered = 0, submitted = false } = {}, knex = db()) {
  const fun = funOf(sess);
  if (!fun.reactions) return [];
  const have = new Set(parseJson((await knex('live_players').where({ id: player.id }).first('badges')).badges, []) || []);
  const won = [];
  const give = (code) => {
    if (!have.has(code)) {
      have.add(code);
      won.push(code);
    }
  };
  const total = sess.question_ids.length;
  if (submitted) {
    const others = Number((await knex('live_players').where({ session_id: sess.id }).whereNot({ id: player.id }).whereNotNull('finished_at').count('* as n').first()).n);
    if (!others) give('first_finish');
  } else {
    if (Number((await knex('live_answers').where({ session_id: sess.id }).count('* as n').first()).n) === 1) give('first_blood');
    if (total >= 4 && answered === Math.ceil(total / 2)) give('halfway');
    const recent = await knex('live_answers').where({ player_id: player.id }).orderBy('id', 'desc').limit(3).select('response_ms', 'is_correct');
    if (recent.length === 3 && recent.every((a) => a.response_ms >= 900 && a.response_ms < 5000)) give('speedster');
    if (fun.leaderboard && recent.length === 3 && recent.every((a) => a.is_correct)) give('on_fire');
  }
  if (!won.length) return [];
  await knex('live_players').where({ id: player.id }).update({ badges: toJson([...have]) });
  return won.map((code) => ({ code, ...BADGES[code] }));
}

/** The host switches a game-mode feature on or off at any time. */
async function setFun(sess, key, on, knex = db()) {
  if (!FUN_KEYS.includes(key)) throw new LiveError('Unknown game mode option.');
  if (closed(sess)) throw new LiveError('This game has ended.');
  const fun = { ...funOf(sess), [key]: !!on };
  await knex('live_sessions').where({ id: sess.id }).update({ settings: toJson({ ...sess.settings, fun }), updated_at: now() });
  return getSession(sess.id, knex);
}

/**
 * Real-time standings. Own pace: provisional scores from the answers given so far (speed and streak bonuses as
 * at submit). Presenter-paced: the running score. `pct` drives the race track: progress through the questions
 * (own pace, which says nothing about correctness) or correct answers so far (presenter-paced, already revealed).
 */
async function standings(sess, knex = db()) {
  const players = await knex('live_players').where({ session_id: sess.id, kicked: false }).select('id', 'nickname', 'score', 'streak', 'finished_at', 'connected');
  const answers = await knex('live_answers').where({ session_id: sess.id }).orderBy('question_index').select('player_id', 'is_correct', 'response_ms');
  const by = new Map(players.map((p) => [p.id, []]));
  for (const a of answers) if (by.has(a.player_id)) by.get(a.player_id).push(a);
  const total = sess.question_ids.length || 1;
  const own = sess.mode === 'player_paced';
  const rows = players.map((p) => {
    const list = by.get(p.id);
    let score = p.score;
    let streak = p.streak;
    if (own && !p.finished_at) {
      score = 0;
      streak = 0;
      for (const a of list) {
        streak = a.is_correct ? streak + 1 : 0;
        score += points({ correct: !!a.is_correct, responseMs: a.response_ms, timerSec: sess.settings.timer, streak });
      }
    }
    const right = list.filter((a) => a.is_correct).length;
    const pct = Math.round(((own ? list.length : right) / total) * 100);
    return { id: p.id, nickname: p.nickname, avatar: avatarFor(p.id), score, streak, answered: list.length, pct: Math.min(100, pct), finished: !!p.finished_at, connected: !!p.connected };
  });
  rows.sort((a, b) => b.score - a.score || b.answered - a.answered || a.id - b.id);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

// ---------------------------------------------------------------- Anti-cheat

const INTEGRITY_TYPES = ['tab_hidden', 'tab_return', 'window_blur', 'split_screen', 'screenshot_key', 'devtools', 'print', 'copy', 'paste', 'context_menu', 'offline', 'fast_answer'];
const INTEGRITY_LABELS = {
  tab_hidden: 'left the game (switched tab or app)',
  tab_return: 'came back after leaving',
  window_blur: 'switched to another window',
  split_screen: 'used split screen or a small window',
  screenshot_key: 'pressed a screenshot key',
  devtools: 'tried to open developer tools',
  print: 'tried to print',
  copy: 'tried to copy',
  paste: 'tried to paste',
  context_menu: 'right-clicked',
  offline: 'went offline',
  fast_answer: 'answered faster than the question can be read',
  auto_submitted: 'was submitted automatically (too many warnings)',
};

/**
 * Records one anti-cheat signal from a player. Returns { flags, autoSubmitted }. "tab_return" and
 * "window_blur" add the time away; "tab_return" does not count as a second flag (the leave already did).
 */
async function recordIntegrity(sess, player, type, details, knex = db(), { count = true } = {}) {
  if (!INTEGRITY_TYPES.includes(type)) throw new LiveError('Unknown event.');
  if (player.finished_at || closed(sess)) return { flags: player.flags, ignored: true };
  const d = details && typeof details === 'object' ? details : {};
  const awayMs = Math.min(Math.max(0, Number(d.away_ms) || 0), 3600000);
  const clean = { away_ms: awayMs || undefined, question: d.question, ms: d.ms, width: d.width, screen: d.screen };
  await knex('live_integrity_events').insert({ session_id: sess.id, player_id: player.id, type, details: toJson(clean) });
  const counts = count && type !== 'tab_return' && type !== 'offline';
  const patch = {};
  if (counts) patch.flags = knex.raw('flags + 1');
  if (awayMs) patch.away_ms = knex.raw('LEAST(away_ms + ?, 2000000000)', [awayMs]);
  if (Object.keys(patch).length) await knex('live_players').where({ id: player.id }).update(patch);
  const fresh = await knex('live_players').where({ id: player.id }).first();
  let autoSubmitted = false;
  const max = Number(sess.settings.max_flags) || 0;
  if (counts && max && fresh.flags >= max && sess.mode === 'player_paced' && !fresh.finished_at && sess.status === 'running') {
    await knex('live_integrity_events').insert({ session_id: sess.id, player_id: player.id, type: 'auto_submitted', details: toJson({ flags: fresh.flags }) });
    await submitPlayer(sess, fresh, knex);
    autoSubmitted = true;
  }
  return { flags: fresh.flags, awayMs: fresh.away_ms, autoSubmitted, label: INTEGRITY_LABELS[type] };
}

async function integritySummary(sessionId, knex = db()) {
  const rows = await knex('live_integrity_events as e').join('live_players as p', 'p.id', 'e.player_id').where('e.session_id', sessionId).orderBy('e.id', 'desc').limit(200).select('e.id', 'e.type', 'e.details', 'e.created_at', 'p.nickname', 'p.id as player_id');
  return rows.map((r) => ({ ...r, details: parseJson(r.details, {}), label: INTEGRITY_LABELS[r.type] || r.type }));
}

/** Moves a player to question `index` (or `total` for the review & submit screen). */
async function goTo(sess, player, index) {
  const total = sess.question_ids.length;
  const i = Math.max(0, Math.min(total, Number(index) || 0));
  if (player.finished_at) throw new LiveError('You have already submitted your answers.');
  if (sess.status !== 'running') throw new LiveError('The game has not started yet.');
  await db()('live_players').where({ id: player.id }).update({ current_index: i, question_started_at: now() });
  return { at: i };
}

/** Final score for one player: speed and streak bonuses are applied in question order. */
async function scorePlayer(sess, player, knex) {
  const rows = await knex('live_answers').where({ player_id: player.id }).orderBy('question_index');
  let streak = 0;
  let best = 0;
  let total = 0;
  for (const a of rows) {
    streak = a.is_correct ? streak + 1 : 0;
    best = Math.max(best, streak);
    const pts = points({ correct: !!a.is_correct, responseMs: a.response_ms, timerSec: sess.settings.timer, streak });
    total += pts;
    if (pts !== a.points) await knex('live_answers').where({ id: a.id }).update({ points: pts });
  }
  return { score: total, streak: best };
}

/** A player submits: answers become final. When everyone in a live game has submitted, the game ends. */
async function submitPlayer(sess, player, knex = db(), { autoEnd = true } = {}) {
  if (player.finished_at) return { submitted: true };
  const { score, streak } = await scorePlayer(sess, player, knex);
  const badges = autoEnd ? await awardBadges(sess, player, { submitted: true }, knex) : [];
  await knex('live_players').where({ id: player.id }).update({ score, streak, finished_at: now(), current_index: sess.question_ids.length });
  if (autoEnd && sess.settings.kind !== 'homework' && sess.status === 'running') {
    const left = Number((await knex('live_players').where({ session_id: sess.id, kicked: false }).whereNull('finished_at').count('* as n').first()).n);
    if (!left) await finish(sess, knex);
  }
  return badges.length ? { submitted: true, badges } : { submitted: true };
}

/** Each question with the player's answer, the correct answer and the explanation (only once the game is over). */
async function resultsFor(sess, player, knex) {
  const answers = await knex('live_answers').where({ player_id: player.id }).select('question_index', 'response', 'is_correct', 'points');
  const byIndex = new Map(answers.map((a) => [Number(a.question_index), a]));
  const out = [];
  for (let i = 0; i < sess.question_ids.length; i += 1) {
    const q = await playerQuestion(sess, i, knex);
    const r = await reveal(sess, i, knex);
    const a = byIndex.get(i);
    out.push({
      index: i,
      stem_html: q.stem_html,
      type: q.type,
      options: q.options,
      response: a ? parseJson(a.response, {}) : null,
      correct: a ? !!a.is_correct : false,
      points: a ? a.points : 0,
      // The correct answer is always shown at the end; the explanation only when the host chose to show it.
      answerKey: { correct: r.correct, correctText: r.correctText, explanation_html: sess.settings.show_answers ? r.explanation_html : null },
    });
  }
  return out;
}

function normaliseResponse(type, r) {
  const x = r && typeof r === 'object' ? r : {};
  if (type === 'multiple_response') return { selected: [].concat(x.selected || []).map(String).slice(0, 10) };
  if (type === 'numeric') return { value: String(x.value ?? '').slice(0, 40) };
  if (type === 'fill_blank') return { blanks: [].concat(x.blanks || []).map((b) => String(b).slice(0, 200)).slice(0, 10) };
  return { selected: String([].concat(x.selected || [])[0] || '').slice(0, 4) };
}

// ---------------------------------------------------------------- Host actions

const clampSec = (v, d) => Math.min(30, Math.max(1, Math.round(Number(v) || d)));

/** Writes a patch; entering a new phase records when it started (drives auto-advance and the countdowns). */
async function update(sess, patch, knex) {
  const out = { ...patch };
  if ((patch.phase && patch.phase !== sess.phase) || patch.current_index !== undefined) {
    const base = patch.settings ? JSON.parse(patch.settings) : sess.settings;
    out.settings = toJson({ ...base, phase_started_at: now().toISOString() });
  }
  await knex('live_sessions').where({ id: sess.id }).update({ ...out, updated_at: now() });
  return getSession(sess.id, knex);
}

/** Host-paced: step back to the previous question's results (it re-opens when the game moves forward again). */
async function prev(sess, knex = db()) {
  if (sess.mode !== 'host_paced') throw new LiveError('Players move at their own pace in this game.');
  if (!['running', 'paused'].includes(sess.status)) throw new LiveError('The game is not running.');
  const target = sess.phase === 'question' ? sess.current_index - 1 : sess.phase === 'leaderboard' ? sess.current_index : sess.current_index - 1;
  if (target < 0) throw new LiveError('This is the first question.');
  const { paused_remaining_ms: _p, ...rest } = sess.settings;
  return update(sess, { status: 'running', phase: 'reveal', current_index: target, settings: toJson(rest) }, knex);
}

/** Turns host-paced auto-advance on or off. */
async function setAuto(sess, on, knex = db()) {
  return update(sess, { settings: toJson({ ...sess.settings, auto_advance: !!on, phase_started_at: now().toISOString() }) }, knex);
}

/** When the current phase ends on its own (null = waits for the host). */
function phaseEndsAt(sess) {
  if (sess.mode !== 'host_paced' || sess.status !== 'running') return null;
  if (sess.phase === 'question') return sess.question_started_at ? new Date(sess.question_started_at).getTime() + sess.settings.timer * 1000 : null;
  if (!sess.settings.auto_advance || !sess.settings.phase_started_at) return null;
  const startedAt = new Date(sess.settings.phase_started_at).getTime();
  if (sess.phase === 'reveal') return startedAt + sess.settings.reveal_seconds * 1000;
  if (sess.phase === 'leaderboard') return startedAt + sess.settings.leaderboard_seconds * 1000;
  return null;
}

/** Self-paced: a player looks back at a question they already answered (read-only). */
async function review(sess, player, index, knex = db()) {
  const i = Number(index);
  if (!(i >= 0 && i < player.current_index)) throw new LiveError('You can only look back at questions you have answered.');
  const q = await playerQuestion(sess, i, knex);
  const a = await knex('live_answers').where({ player_id: player.id, question_index: i }).first('response', 'is_correct', 'points');
  const out = { question: q, response: a ? parseJson(a.response, {}) : null, correct: a ? !!a.is_correct : false, points: a ? a.points : 0, answerKey: null };
  if (sess.settings.show_answers) {
    const r = await reveal(sess, i, knex);
    out.answerKey = { correct: r.correct, correctText: r.correctText, explanation_html: r.explanation_html };
  }
  return out;
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
  if (sess.mode === 'player_paced') {
    const open = await knex('live_players').where({ session_id: sess.id, kicked: false }).whereNull('finished_at');
    for (const p of open) await submitPlayer(sess, p, knex, { autoEnd: false });
  }
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
    phaseEndsAt: phaseEndsAt(sess) ? new Date(phaseEndsAt(sess)).toISOString() : null,
    autoAdvance: !!sess.settings.auto_advance,
    serverNow: Date.now(),
    pausedRemainingMs: sess.status === 'paused' ? sess.settings.paused_remaining_ms : null,
    deadline: sess.settings.deadline,
    players: lb.total,
    leaderboard: ['leaderboard', 'podium'].includes(sess.phase) || (sess.mode === 'player_paced' && closed(sess)) ? lb.top : [],
    lobby: sess.phase === 'lobby' ? lb.all.map((p) => p.nickname).slice(-60) : [],
    question: null,
    reveal: null,
    fun: funOf(sess),
    reactions: REACTIONS,
    liveBoard: null,
    race: null,
  };
  const playing = !closed(sess) && ['running', 'paused'].includes(sess.status);
  if (playing && (out.fun.leaderboard || out.fun.race)) {
    const rows = await standings(sess, knex);
    Object.defineProperty(out, '_standings', { value: rows, enumerable: false }); // reused for every player's view
    if (out.fun.leaderboard) out.liveBoard = rows.slice(0, 10).map((r) => ({ rank: r.rank, id: r.id, nickname: r.nickname, avatar: r.avatar, score: r.score, streak: r.streak }));
    if (out.fun.race) out.race = rows.slice(0, 60).map((r) => ({ id: r.id, nickname: r.nickname, avatar: r.avatar, pct: r.pct, finished: r.finished }));
  }
  if (sess.mode === 'host_paced' && sess.status !== 'lobby' && sess.current_index >= 0) {
    if (['question', 'reveal'].includes(sess.phase)) out.question = await playerQuestion(sess, sess.current_index, knex);
    if (sess.phase === 'reveal') out.reveal = await reveal(sess, sess.current_index, knex);
  }
  return out;
}

/** Personal state for one player. */
async function playerState(sess, player, knex = db(), pub = null) {
  const me = await (sess.mode === 'player_paced' ? ownPaceState(sess, player, knex) : pacedState(sess, player, knex));
  me.avatar = avatarFor(player.id);
  const fun = funOf(sess);
  if ((fun.leaderboard || fun.race) && !closed(sess) && ['running', 'paused'].includes(sess.status)) {
    const rows = (pub && pub._standings) || (await standings(sess, knex));
    const mine = rows.find((r) => r.id === player.id);
    if (mine && fun.leaderboard) me.live = { rank: mine.rank, of: rows.length, score: mine.score, streak: mine.streak };
    if (mine && fun.race) {
      // The racers just ahead of and behind me, for the phone's mini track.
      const byPct = rows.slice().sort((a, b) => b.pct - a.pct || a.id - b.id);
      const at = byPct.findIndex((r) => r.id === player.id);
      me.raceNear = byPct.slice(Math.max(0, at - 2), at + 3).map((r) => ({ id: r.id, nickname: r.nickname, avatar: r.avatar, pct: r.pct, me: r.id === player.id }));
      me.racePlace = at + 1;
    }
  }
  if (me.question && fun.leaderboard && me.question.response) me.question.locked = true;
  return me;
}

async function pacedState(sess, player, knex) {
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
async function ownPaceState(sess, player, knex) {
  const total = sess.question_ids.length;
  const over = closed(sess);
  if (over && !player.finished_at) {
    await submitPlayer(sess, player, knex, { autoEnd: false }); // deadline passed: answers so far count
    player = await knex('live_players').where({ id: player.id }).first();
  }
  const me = { id: player.id, nickname: player.nickname, total, finished: !!player.finished_at, gameOver: over, question: null, answered: [], atReview: false, results: null, submittedCount: 0 };
  if (over) {
    const lb = await leaderboard(sess.id, 1000, knex);
    Object.assign(me, { score: player.score, streak: player.streak, rank: lb.all.findIndex((p) => p.id === player.id) + 1, of: lb.total, results: await resultsFor(sess, player, knex) });
    return me;
  }
  me.answered = await answeredIndexes(player.id, knex);
  me.submittedCount = Number((await knex('live_players').where({ session_id: sess.id, kicked: false }).whereNotNull('finished_at').count('* as n').first()).n);
  if (player.finished_at || sess.status !== 'running') return me;
  if (player.current_index >= total) {
    me.atReview = true;
    return me;
  }
  me.question = await playerQuestion(sess, player.current_index, knex);
  const mine = await knex('live_answers').where({ player_id: player.id, question_index: player.current_index }).first('response');
  me.question.response = mine ? parseJson(mine.response, {}) : null;
  return me;
}

async function hostState(sess, knex = db()) {
  const state = await publicState(sess, knex);
  const lb = await leaderboard(sess.id, 1000, knex);
  state.pin = sess.pin;
  const counts = Object.fromEntries((await knex('live_answers').where({ session_id: sess.id }).select('player_id').count('* as n').groupBy('player_id')).map((r) => [r.player_id, Number(r.n)]));
  const integ = Object.fromEntries((await knex('live_players').where({ session_id: sess.id }).select('id', 'flags', 'away_ms')).map((r) => [r.id, r]));
  state.allPlayers = lb.all.map((p) => ({ id: p.id, avatar: avatarFor(p.id), nickname: p.nickname, score: p.score, progress: p.current_index, answered: counts[p.id] || 0, finished: !!p.finished_at, connected: !!p.connected, flags: (integ[p.id] || {}).flags || 0, awaySec: Math.round(((integ[p.id] || {}).away_ms || 0) / 1000) }));
  state.alerts = (await integritySummary(sess.id, knex)).slice(0, 15).map((a) => ({ id: a.id, nickname: a.nickname, label: a.label, type: a.type, away: a.details.away_ms ? Math.round(a.details.away_ms / 1000) : null, at: a.created_at }));
  state.maxFlags = Number(sess.settings.max_flags) || 0;
  state.submitted = state.allPlayers.filter((p) => p.finished).length;
  state.leaderboard = sess.mode === 'player_paced' && !closed(sess) ? [] : lb.all.slice(0, 10).map((p, i) => ({ rank: i + 1, id: p.id, nickname: p.nickname, score: p.score, streak: p.streak }));
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
    return { rank: i + 1, nickname: p.nickname, score: p.score, correct: right, answered: list.length, total, accuracy: list.length ? Math.round((right / total) * 100) : 0, avgSeconds: list.length ? Math.round(list.reduce((s, a) => s + a.response_ms, 0) / list.length / 100) / 10 : null, kicked: !!p.kicked, flags: p.flags || 0, awaySec: Math.round((p.away_ms || 0) / 1000) };
  });
  const stems = await knex('question_versions').whereIn('id', sess.question_ids.map((q) => q.v)).select('id', 'stem_html', 'type');
  const stemBy = new Map(stems.map((s) => [s.id, s]));
  const questions = sess.question_ids.map((ref, i) => {
    const list = answers.filter((a) => a.question_index === i);
    const right = list.filter((a) => a.is_correct).length;
    const s = stemBy.get(ref.v) || {};
    return { index: i, questionId: ref.q, type: s.type, stem: String(s.stem_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160), answered: list.length, correctPct: list.length ? Math.round((right / list.length) * 100) : null, avgSeconds: list.length ? Math.round(list.reduce((s2, a) => s2 + a.response_ms, 0) / list.length / 100) / 10 : null };
  });
  return { session: sess, players: rows, questions, integrity: await integritySummary(sessionId, knex) };
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
  prev,
  setAuto,
  setFun,
  standings,
  awardBadges,
  avatarFor,
  FUN_KEYS,
  REACTIONS,
  BADGES,
  phaseEndsAt,
  review,
  recordIntegrity,
  integritySummary,
  INTEGRITY_TYPES,
  INTEGRITY_LABELS,
  goTo,
  submitPlayer,
  answeredIndexes,
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
