'use strict';

const QRCode = require('qrcode');
const { stringify } = require('csv-stringify/sync');
const { db } = require('../config/db');
const { getEnv } = require('../config/env');
const { notFound, forbidden } = require('../utils/errors');
const audit = require('../services/audit');
const live = require('../services/live');
const { COOKIE } = require('../services/live/socket');

const base = () => String(getEnv().APP_URL).replace(/\/$/, '');
const crumbs = (...extra) => [{ label: 'Admin', href: '/admin' }, { label: 'Live quiz', href: '/admin/live' }, ...extra];
/** Checkbox fields post a hidden "0" plus "1" when ticked. */
const on = (v) => [].concat(v === undefined ? [] : v).includes('1');
const KINDS = {
  self_paced: 'Live game — everyone answers at their own pace; answers and scores are revealed when the game ends (recommended)',
  live: 'Presenter-paced — everyone answers each question together on the big screen',
  homework: 'Homework — at their own pace, with a deadline; results after the deadline',
};

async function loadOwn(req) {
  const sess = await live.getSession(Number(req.params.id));
  if (!sess) throw notFound();
  if (sess.host_id !== req.user.id && !req.user.can('live.view_all')) throw forbidden();
  return sess;
}

// ---------------------------------------------------------------- Admin

async function index(req, res) {
  const mineOnly = !req.user.can('live.view_all');
  const sessions = await db()('live_sessions as s')
    .join('exams as e', 'e.id', 's.exam_id')
    .join('users as u', 'u.id', 's.host_id')
    .modify((q) => (mineOnly ? q.where('s.host_id', req.user.id) : q))
    .orderBy('s.id', 'desc')
    .limit(50)
    .select('s.*', 'e.title as exam_title', 'u.full_name as host_name', db().raw('(select count(*) from live_players p where p.session_id = s.id and p.kicked = 0) as players'));
  const exams = await db()('exams as e')
    .whereNull('e.deleted_at')
    .whereNull('e.organisation_id')
    .whereIn('e.status', ['draft', 'published'])
    .whereExists(function () {
      this.select(1).from('exam_questions as eq').join('questions as q', 'q.id', 'eq.question_id').join('question_versions as v', 'v.id', 'q.current_version_id').whereRaw('eq.exam_id = e.id').whereIn('v.type', live.LIVE_TYPES);
    })
    .orderByRaw("e.type = 'live_quiz' desc")
    .orderBy('e.title')
    .select('e.id', 'e.title', 'e.type');
  res.render('admin/live/index', { title: 'Live quiz', layout: 'layouts/app', sessions: sessions.map((s) => ({ ...s, settings: JSON.parse(typeof s.settings === 'string' ? s.settings : JSON.stringify(s.settings || {})) })), exams, KINDS, breadcrumbs: crumbs() });
}

async function create(req, res) {
  const b = req.body;
  try {
    const sess = await live.createSession({
      examId: Number(b.exam_id),
      hostId: req.user.id,
      kind: KINDS[b.kind] ? b.kind : 'self_paced',
      timer: b.timer,
      allowGuests: on(b.allow_guests),
      shuffle: on(b.shuffle),
      showAnswers: on(b.show_answers),
      autoAdvance: on(b.auto_advance),
      maxFlags: b.max_flags,
      revealSeconds: b.reveal_seconds,
      leaderboardSeconds: b.leaderboard_seconds,
      deadline: b.deadline || null,
    });
    await audit.record(req, 'live.create', { entityType: 'live_session', entityId: sess.id, after: { pin: sess.pin, kind: sess.settings.kind, exam_id: sess.exam_id } });
    return res.redirect(sess.settings.kind === 'homework' ? `/admin/live/${sess.id}/report` : `/admin/live/${sess.id}`);
  } catch (err) {
    if (!(err instanceof live.LiveError)) throw err;
    req.setFormState(b, {});
    req.flash('danger', err.message);
    return res.redirect('/admin/live');
  }
}

async function host(req, res) {
  const sess = await loadOwn(req);
  if (sess.host_id !== req.user.id) return res.redirect(`/admin/live/${sess.id}/report`);
  const joinUrl = `${base()}/play?pin=${sess.pin}`;
  res.render('live/host', {
    title: `Host · ${sess.settings.title}`,
    layout: 'layouts/exam',
    sess,
    joinUrl,
    joinHost: base().replace(/^https?:\/\//, ''),
    qr: await QRCode.toDataURL(joinUrl, { margin: 1, width: 280, errorCorrectionLevel: 'M' }),
    hostToken: live.hostToken(sess.id, sess.host_id),
  });
}

async function report(req, res) {
  const sess = await loadOwn(req);
  const r = await live.report(sess.id);
  res.render('admin/live/report', { title: `Report · ${sess.settings.title}`, layout: 'layouts/app', sess, r, KINDS, joinUrl: `${base()}/play?pin=${sess.pin}`, closed: live.closed(sess), breadcrumbs: crumbs({ label: `${sess.settings.title} · ${sess.pin}` }) });
}

async function reportCsv(req, res) {
  const sess = await loadOwn(req);
  const r = await live.report(sess.id);
  const rows = [['Rank', 'Nickname', 'Score', 'Correct', 'Answered', 'Questions', 'Accuracy %', 'Avg seconds', 'Anti-cheat warnings', 'Seconds away', 'Removed'], ...r.players.map((p) => [p.rank, p.nickname, p.score, p.correct, p.answered, p.total, p.accuracy, p.avgSeconds ?? '', p.flags, p.awaySec, p.kicked ? 'yes' : ''])];
  res.set('Content-Type', 'text/csv; charset=utf-8').attachment(`live-${sess.pin}-${sess.id}.csv`);
  res.send(`﻿${stringify(rows)}`);
}

async function close(req, res) {
  const sess = await loadOwn(req);
  if (!live.closed(sess)) await live.finish(sess);
  await require('../services/live/socket').broadcast(sess.id);
  req.flash('success', 'The game has been closed.');
  res.redirect(`/admin/live/${sess.id}/report`);
}

// ---------------------------------------------------------------- Players

async function joinForm(req, res) {
  res.render('live/join', { title: 'Join a live quiz', layout: 'layouts/public', pin: String(req.query.pin || '').replace(/\D/g, '').slice(0, 6), suggested: req.user ? req.user.full_name.split(' ')[0] : '' });
}

async function join(req, res) {
  const pin = String(req.body.pin || '').replace(/\D/g, '').slice(0, 6);
  const sess = pin.length === 6 ? await live.byPin(pin) : null;
  const back = `/play?pin=${pin}`;
  if (!sess || live.closed(sess)) {
    req.setFormState(req.body, { pin: 'No game is running with that PIN.' });
    return res.redirect(back);
  }
  try {
    const { token } = await live.join(sess, { nickname: req.body.nickname, userId: req.user ? req.user.id : null, token: parseCookies(req.headers.cookie)[COOKIE(sess.id)] || null });
    res.cookie(COOKIE(sess.id), token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 12 * 3600 * 1000, path: '/' });
    return res.redirect(`/play/${pin}`);
  } catch (err) {
    if (!(err instanceof live.LiveError)) throw err;
    if (err.status === 401) {
      req.flash('info', 'Sign in to join this game.');
      req.session.returnTo = back;
      return res.redirect('/login');
    }
    req.setFormState(req.body, { nickname: err.message });
    return res.redirect(back);
  }
}

async function play(req, res) {
  const sess = await live.byPin(req.params.pin);
  if (!sess) {
    req.flash('warning', 'That game has ended or the PIN is wrong.');
    return res.redirect('/play');
  }
  const cookies = parseCookies(req.headers.cookie);
  const player = await live.playerByToken(sess.id, cookies[COOKIE(sess.id)]);
  if (!player) return res.redirect(`/play?pin=${sess.pin}`);
  res.render('live/play', { title: sess.settings.title, layout: 'layouts/exam', sess, player });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { index, create, host, report, reportCsv, close, joinForm, join, play, parseCookies, KINDS };
