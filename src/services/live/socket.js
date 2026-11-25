'use strict';

const { Server } = require('socket.io');
const { getEnv } = require('../../config/env');
const { getLogger } = require('../../config/logger');

let io = null;
const timers = new Map(); // sessionId → timeout for the automatic reveal

const COOKIE = (id) => `lp_${id}`;

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Attaches Socket.IO to the HTTP server. Socket.IO falls back to HTTP long-polling automatically when the
 * hosting proxy blocks WebSockets. The /live namespace carries the live quiz; every rule lives in ./index.js.
 */
function attach(server) {
  const env = getEnv();
  io = new Server(server, {
    path: '/socket.io',
    serveClient: true,
    cors: { origin: env.APP_URL, credentials: true },
    pingInterval: 20000,
    pingTimeout: 25000,
    maxHttpBufferSize: 64 * 1024,
  });
  registerLive(io.of('/live'));
  return io;
}

const getIo = () => io;

// ---------------------------------------------------------------- Broadcasting

async function broadcast(sessionId) {
  if (!io) return;
  const live = require('./index');
  const ns = io.of('/live');
  const sess = await live.getSession(sessionId);
  if (!sess) return;
  const pub = await live.publicState(sess);
  const sockets = await ns.in(`s:${sessionId}`).fetchSockets();
  let host = null;
  for (const s of sockets) {
    if (s.data.role === 'host') {
      if (!host) host = await live.hostState(sess);
      s.emit('host', host);
    } else if (s.data.role === 'player') {
      const p = await require('../../config/db').db()('live_players').where({ id: s.data.playerId }).first();
      if (!p || p.kicked) {
        s.emit('kicked');
        s.disconnect(true);
        continue;
      }
      s.emit('state', { ...pub, me: await live.playerState(sess, p) });
    }
  }
}

function clearTimer(id) {
  if (timers.has(id)) clearTimeout(timers.get(id));
  timers.delete(id);
}

/** Host-paced: reveal automatically when the timer runs out. */
function schedule(sess) {
  clearTimer(sess.id);
  if (sess.mode !== 'host_paced' || sess.status !== 'running' || sess.phase !== 'question') return;
  const due = new Date(sess.question_started_at).getTime() + sess.settings.timer * 1000 + 600;
  const index = sess.current_index;
  timers.set(
    sess.id,
    setTimeout(() => autoReveal(sess.id, index).catch((err) => getLogger().warn({ err: err.message }, 'live auto-reveal failed')), Math.max(0, due - Date.now())),
  );
}

async function autoReveal(sessionId, index) {
  const live = require('./index');
  const sess = await live.getSession(sessionId);
  if (sess && sess.status === 'running' && sess.phase === 'question' && sess.current_index === index) {
    await live.next(sess);
    await broadcast(sessionId);
  }
}

/** Host-paced: when everyone still in the game has answered, reveal straight away. */
async function revealIfAllAnswered(sess) {
  const { db } = require('../../config/db');
  const players = Number((await db()('live_players').where({ session_id: sess.id, kicked: false }).count('* as n').first()).n);
  const answered = Number((await db()('live_answers').where({ session_id: sess.id, question_index: sess.current_index }).count('* as n').first()).n);
  if (players > 0 && answered >= players) await autoReveal(sess.id, sess.current_index);
}

// ---------------------------------------------------------------- Handlers

function registerLive(ns) {
  const live = require('./index');
  const { db } = require('../../config/db');

  ns.use(async (socket, next) => {
    try {
      const sessionId = Number(socket.handshake.auth && socket.handshake.auth.session);
      const sess = sessionId ? await live.getSession(sessionId) : null;
      if (!sess) return next(new Error('not_found'));
      const hostTok = socket.handshake.auth.host;
      if (hostTok) {
        if (!live.checkHostToken(sess.id, sess.host_id, hostTok)) return next(new Error('forbidden'));
        socket.data = { role: 'host', sessionId: sess.id };
        return next();
      }
      const player = await live.playerByToken(sess.id, readCookie(socket.handshake.headers.cookie, COOKIE(sess.id)));
      if (!player) return next(new Error('join_first'));
      socket.data = { role: 'player', sessionId: sess.id, playerId: player.id };
      return next();
    } catch (err) {
      return next(new Error('error'));
    }
  });

  ns.on('connection', async (socket) => {
    const { sessionId, role, playerId } = socket.data;
    socket.join(`s:${sessionId}`);
    if (role === 'player') await db()('live_players').where({ id: playerId }).update({ connected: true });
    if (role === 'host' && !timers.has(sessionId)) schedule(await live.getSession(sessionId)); // e.g. after a restart
    await broadcast(sessionId);

    const guard = (fn) => async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const out = await fn(payload || {});
        reply({ ok: true, ...(out || {}) });
      } catch (err) {
        if (!(err instanceof live.LiveError)) getLogger().error({ err }, 'live handler failed');
        reply({ ok: false, error: err instanceof live.LiveError ? err.message : 'Something went wrong.' });
      }
    };

    if (role === 'host') {
      const act = (fn) =>
        guard(async (p) => {
          const sess = await live.getSession(sessionId);
          const after = await fn(sess, p);
          const fresh = after && after.id ? after : await live.getSession(sessionId);
          if (fresh.status !== 'running' || fresh.phase !== 'question') clearTimer(sessionId);
          else schedule(fresh);
          await broadcast(sessionId);
        });
      socket.on('start', act((s) => live.start(s)));
      socket.on('next', act((s) => live.next(s)));
      socket.on('pause', act((s) => live.pause(s)));
      socket.on('resume', act((s) => live.resume(s)));
      socket.on('kick', act((s, p) => live.kick(s, Number(p.playerId))));
      socket.on('end', act((s) => live.finish(s)));
    } else {
      socket.on(
        'answer',
        guard(async (p) => {
          const sess = await live.getSession(sessionId);
          const player = await db()('live_players').where({ id: playerId }).first();
          if (!player || player.kicked) throw new live.LiveError('You are no longer in this game.');
          const out = await live.answer(sess, player, { index: p.index, response: p.response });
          if (sess.mode === 'host_paced') await revealIfAllAnswered(sess);
          await broadcast(sessionId);
          return out;
        }),
      );
    }

    socket.on('disconnect', async () => {
      if (role === 'player') {
        const others = (await ns.in(`s:${sessionId}`).fetchSockets()).some((s) => s.data.playerId === playerId);
        if (!others) await db()('live_players').where({ id: playerId }).update({ connected: false });
      }
      broadcast(sessionId).catch(() => {});
    });
  });
}

module.exports = { attach, getIo, broadcast, COOKIE };
