'use strict';

const http = require('http');
const { io: ioClient } = require('socket.io-client');
const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const qrepo = require('../../src/services/questions/repository');
const examsRepo = require('../../src/services/exams/repository');
const live = require('../../src/services/live');
const realtime = require('../../src/services/live/socket');

let app;
let server;
let port;
let admin;
let adminAgent;
let examId;
const stamp = Date.now();

async function q(authoring, catId) {
  return (await qrepo.saveQuestion({ meta: { category_id: catId, difficulty: 2, est_time_sec: 20 }, authoring, tags: [], user: { id: admin.id, can: () => true }, status: 'published' })).id;
}

const connect = (auth, cookie) =>
  new Promise((resolve, reject) => {
    const s = ioClient(`http://127.0.0.1:${port}/live`, { auth, extraHeaders: cookie ? { cookie } : {}, transports: ['websocket'], forceNew: true, reconnection: false });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
const nextEvent = (s, name, pred = () => true) =>
  new Promise((resolve) => {
    const h = (data) => {
      if (pred(data)) {
        s.off(name, h);
        resolve(data);
      }
    };
    s.on(name, h);
  });
const emit = (s, evt, payload) => new Promise((resolve) => s.emit(evt, payload || {}, resolve));

beforeAll(async () => {
  app = await bootApp();
  server = http.createServer(app);
  realtime.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const a = await createUser({ roles: ['admin'] });
  admin = await db()('users').where({ id: a.id }).first();
  const { secret } = await enable2fa(a.id);
  adminAgent = await login(app, { email: a.email, totpSecret: secret });
  const [catId] = await db()('categories').insert({ name: `Live ${stamp}`, slug: `live-${stamp}` });
  const ids = [
    await q({ type: 'single_choice', stem_html: `<p>Port for HTTPS ${stamp}?</p>`, options: [{ text: '80' }, { text: '443', correct: true }, { text: '22' }] }, catId),
    await q({ type: 'true_false', stem_html: `<p>MFA helps ${stamp}</p>`, correct: true }, catId),
    await q({ type: 'numeric', stem_html: `<p>2 + 2 ${stamp}</p>`, value: 4, tolerance: 0 }, catId),
    await q({ type: 'essay', stem_html: `<p>Essay is skipped ${stamp}</p>`, rubric_html: '<p>x</p>', marks: 5 }, catId),
  ];
  examId = await examsRepo.createExam({ title: `Live quiz ${stamp}`, type: 'live_quiz', category_id: catId, user: { id: admin.id, can: () => true } });
  await examsRepo.addQuestions(examId, ids);
});

afterAll(async () => {
  await new Promise((r) => realtime.getIo().close(() => r()));
  await closeAll(app);
});

describe('scoring', () => {
  test('correct answers earn base + speed + streak; wrong answers earn nothing', () => {
    expect(live.points({ correct: false, responseMs: 100, timerSec: 20, streak: 0 })).toBe(0);
    expect(live.points({ correct: true, responseMs: 0, timerSec: 20, streak: 1 })).toBe(1000);
    expect(live.points({ correct: true, responseMs: 20000, timerSec: 20, streak: 1 })).toBe(500);
    expect(live.points({ correct: true, responseMs: 10000, timerSec: 20, streak: 3 })).toBe(500 + 250 + 200);
    expect(live.points({ correct: true, responseMs: 99999, timerSec: 20, streak: 20 })).toBe(1000); // streak bonus capped
  });

  test('nicknames are cleaned', () => {
    expect(live.cleanNickname('  <b>Ada</b>  Obi  ')).toBe('bAda/b Obi');
  });
});

describe('a host-paced game over Socket.IO', () => {
  test('lobby → questions → leaderboard → podium, with server-side scoring and a report', async () => {
    // The host creates a session from the admin screen.
    const t = await csrf(adminAgent, '/admin/live');
    const res = await adminAgent.post('/admin/live').type('form').send({ _csrf: t, exam_id: examId, kind: 'live', timer: '30', allow_guests: '1' });
    expect(res.status).toBe(302);
    const sessId = Number(res.headers.location.split('/').pop());
    const sess = await live.getSession(sessId);
    expect(sess.pin).toMatch(/^\d{6}$/);
    expect(sess.question_ids).toHaveLength(3); // the essay is not a live question
    const hostPage = await adminAgent.get(`/admin/live/${sessId}`);
    expect(hostPage.text).toContain(sess.pin);
    const hostTok = /data-token="([0-9a-f]+)"/.exec(hostPage.text)[1];

    // Two guests join with the PIN.
    const guest = async (nick) => {
      const agent = require('supertest').agent(app);
      const ct = await csrf(agent, `/play?pin=${sess.pin}`);
      const r = await agent.post('/play').type('form').send({ _csrf: ct, pin: sess.pin, nickname: nick });
      expect(r.headers.location).toBe(`/play/${sess.pin}`);
      const cookie = r.headers['set-cookie'].find((c) => c.startsWith(`lp_${sessId}=`)).split(';')[0];
      return { agent, cookie };
    };
    const ada = await guest('Ada');
    const bola = await guest('Bola');
    // Same nickname twice is refused.
    const dupAgent = require('supertest').agent(app);
    const dt = await csrf(dupAgent, `/play?pin=${sess.pin}`);
    await dupAgent.post('/play').type('form').send({ _csrf: dt, pin: sess.pin, nickname: 'Ada' });
    expect((await dupAgent.get(`/play?pin=${sess.pin}`)).text).toContain('nickname is taken');

    // A forged host token is rejected; the real one connects.
    await expect(connect({ session: sessId, host: 'f'.repeat(64) })).rejects.toThrow('forbidden');
    await expect(connect({ session: sessId })).rejects.toThrow('join_first');
    const hostS = await connect({ session: sessId, host: hostTok });
    const adaS = await connect({ session: sessId }, ada.cookie);
    const bolaS = await connect({ session: sessId }, bola.cookie);

    // Players cannot drive the game.
    adaS.emit('next', {});
    expect((await live.getSession(sessId)).status).toBe('lobby');

    // Start → question 1 reaches the players without the answer key.
    const q1 = nextEvent(adaS, 'state', (s) => s.phase === 'question' && s.index === 0);
    expect((await emit(hostS, 'start')).ok).toBe(true);
    const st = await q1;
    expect(st.question.options.map((o) => o.key)).toEqual(['A', 'B', 'C']);
    expect(JSON.stringify(st)).not.toMatch(/"correct"/);

    // Ada answers correctly, Bola wrongly → everyone answered → automatic reveal.
    const revealed = nextEvent(hostS, 'host', (s) => s.phase === 'reveal');
    const a1 = await emit(adaS, 'answer', { index: 0, response: { selected: 'B' } });
    expect(a1).toMatchObject({ ok: true, correct: true });
    expect(a1.points).toBeGreaterThan(900);
    expect((await emit(adaS, 'answer', { index: 0, response: { selected: 'B' } })).ok).toBe(false); // once only
    expect((await emit(bolaS, 'answer', { index: 0, response: { selected: 'A' } })).correct).toBe(false);
    const rv = await revealed;
    expect(rv.reveal.correct).toEqual(['B']);
    expect(rv.reveal.counts).toEqual({ A: 1, B: 1 });

    // Leaderboard, then questions 2 and 3.
    await emit(hostS, 'next');
    expect((await live.getSession(sessId)).phase).toBe('leaderboard');
    await emit(hostS, 'next');
    const tfKey = (await db()('question_options').where({ question_version_id: sess.question_ids[1].v }).where('content_html', 'like', '%True%').first('option_key')).option_key;
    await emit(adaS, 'answer', { index: 1, response: { selected: tfKey } });
    await emit(bolaS, 'answer', { index: 1, response: { selected: tfKey } });
    await emit(hostS, 'next'); // → leaderboard (already revealed automatically)
    let s = await live.getSession(sessId);
    if (s.phase === 'leaderboard') await emit(hostS, 'next');
    await emit(adaS, 'answer', { index: 2, response: { value: '4' } });
    const pausedAt = await emit(hostS, 'pause');
    expect(pausedAt.ok).toBe(true);
    expect((await emit(bolaS, 'answer', { index: 2, response: { value: '4' } })).ok).toBe(false); // paused
    await emit(hostS, 'resume');
    await emit(bolaS, 'answer', { index: 2, response: { value: '5' } });
    s = await live.getSession(sessId);
    while (s.status !== 'finished') {
      await emit(hostS, 'next');
      s = await live.getSession(sessId);
    }
    expect(s.phase).toBe('podium');

    // Scores were computed on the server; the report and CSV agree.
    const lb = await live.leaderboard(sessId);
    expect(lb.top[0].nickname).toBe('Ada');
    const report = await adminAgent.get(`/admin/live/${sessId}/report`);
    expect(report.text).toContain('Ada');
    expect(report.text).toContain('3/3');
    const csv = await adminAgent.get(`/admin/live/${sessId}/report.csv`);
    expect(csv.text).toContain('Rank,Nickname,Score');
    expect(csv.text).toMatch(/1,Ada,\d+,3,3,3,100/);
    [hostS, adaS, bolaS].forEach((x) => x.close());
  });

  test('sign-in is required unless guests are allowed; kicked players cannot rejoin', async () => {
    const sess = await live.createSession({ examId, hostId: admin.id, kind: 'live', timer: 20, allowGuests: false });
    const agent = require('supertest').agent(app);
    const ct = await csrf(agent, `/play?pin=${sess.pin}`);
    const r = await agent.post('/play').type('form').send({ _csrf: ct, pin: sess.pin, nickname: 'Guest' });
    expect(r.headers.location).toBe('/login');
    const u = await createUser();
    const member = await login(app, { email: u.email });
    const ct2 = await csrf(member, `/play?pin=${sess.pin}`);
    const r2 = await member.post('/play').type('form').send({ _csrf: ct2, pin: sess.pin, nickname: 'Member' });
    expect(r2.headers.location).toBe(`/play/${sess.pin}`);
    const p = await db()('live_players').where({ session_id: sess.id, user_id: u.id }).first();
    await live.kick(sess, p.id);
    const ct3 = await csrf(member, `/play?pin=${sess.pin}`);
    await member.post('/play').type('form').send({ _csrf: ct3, pin: sess.pin, nickname: 'Member' });
    expect((await member.get(`/play?pin=${sess.pin}`)).text).toContain('removed you');
  });
});

describe('auto-advance and previous', () => {
  test('a host-paced game moves on by itself; the host can go back and switch auto-advance off', async () => {
    const sess = await live.createSession({ examId, hostId: admin.id, kind: 'live', timer: 30, allowGuests: true, autoAdvance: true, revealSeconds: 1, leaderboardSeconds: 1 });
    expect(sess.settings).toMatchObject({ auto_advance: true, reveal_seconds: 1, leaderboard_seconds: 1 });
    const { token } = await live.join(sess, { nickname: 'Auto' });
    const hostS = await connect({ session: sess.id, host: live.hostToken(sess.id, sess.host_id) });
    const p = await connect({ session: sess.id }, `lp_${sess.id}=${token}`);
    await emit(hostS, 'start');
    // Answering reveals at once; then leaderboard and the next question follow with no clicks.
    const nextQ = nextEvent(p, 'state', (st) => st.phase === 'question' && st.index === 1);
    await emit(p, 'answer', { index: 0, response: { selected: 'B' } });
    expect((await live.getSession(sess.id)).phase).toBe('reveal');
    const st1 = await nextQ;
    expect(st1.autoAdvance).toBe(true);
    // Previous: back to question 1's results (read-only).
    expect((await emit(hostS, 'prev')).ok).toBe(true);
    let cur = await live.getSession(sess.id);
    expect([cur.phase, cur.current_index]).toEqual(['reveal', 0]);
    // Switch auto-advance off: the reveal now waits for the host.
    await emit(hostS, 'auto', { on: false });
    cur = await live.getSession(sess.id);
    expect(cur.settings.auto_advance).toBe(false);
    expect(live.phaseEndsAt(cur)).toBeNull();
    await new Promise((r) => setTimeout(r, 1300));
    expect((await live.getSession(sess.id)).phase).toBe('reveal');
    // Forward again by hand: leaderboard → question 2 re-opens; the earlier answer stays counted once.
    await emit(hostS, 'next');
    await emit(hostS, 'next');
    cur = await live.getSession(sess.id);
    expect([cur.phase, cur.current_index]).toEqual(['question', 1]);
    expect(Number((await db()('live_answers').where({ session_id: sess.id }).count('* as n').first()).n)).toBe(1);
    await emit(hostS, 'end');
    hostS.close();
    p.close();
  });

});

describe('own-pace live game (the default)', () => {
  const tfKeyOf = async (sess, i) => (await db()('question_options').where({ question_version_id: sess.question_ids[i].v }).where('content_html', 'like', '%True%').first('option_key')).option_key;

  test('players move on by themselves, see no right/wrong, can go back and change answers, then everyone sees results at the end', async () => {
    const t = await csrf(adminAgent, '/admin/live');
    const res = await adminAgent.post('/admin/live').type('form').send({ _csrf: t, exam_id: examId, timer: '30', allow_guests: ['0', '1'] }); // no kind → the default
    const sess = await live.getSession(Number(res.headers.location.split('/').pop()));
    expect(sess.mode).toBe('player_paced');
    expect(sess.settings.kind).toBe('self_paced');
    const a = await live.join(sess, { nickname: 'Amaka' });
    const b = await live.join(sess, { nickname: 'Bayo' });
    const hostS = await connect({ session: sess.id, host: live.hostToken(sess.id, sess.host_id) });
    const aS = await connect({ session: sess.id }, `lp_${sess.id}=${a.token}`);
    const bS = await connect({ session: sess.id }, `lp_${sess.id}=${b.token}`);
    await emit(hostS, 'start');

    // Amaka answers Q1 wrongly: no correctness in the reply, and she is moved to Q2 straight away.
    const r1 = await emit(aS, 'answer', { index: 0, response: { selected: 'A' } });
    expect(r1).toEqual({ ok: true, saved: true, next: 1 });
    let st = await live.playerState(await live.getSession(sess.id), await db()('live_players').where({ id: a.player.id }).first());
    expect(st.question.index).toBe(1);
    expect(st).not.toHaveProperty('score');
    expect(JSON.stringify(st)).not.toMatch(/"correct"|answerKey|explanation/);
    // Bayo has not moved: players are independent.
    expect((await db()('live_players').where({ id: b.player.id }).first()).current_index).toBe(0);

    // Previous: Amaka goes back to Q1, sees her saved answer and changes it to the right one.
    await emit(aS, 'goto', { index: 0 });
    st = await live.playerState(await live.getSession(sess.id), await db()('live_players').where({ id: a.player.id }).first());
    expect(st.question.response).toEqual({ selected: 'A' });
    expect((await emit(aS, 'answer', { index: 0, response: { selected: 'B' } })).next).toBe(1);
    await emit(aS, 'answer', { index: 1, response: { selected: await tfKeyOf(sess, 1) } });
    const last = await emit(aS, 'answer', { index: 2, response: { value: '4' } });
    expect(last.next).toBe(3); // all answered → review & submit screen
    st = await live.playerState(await live.getSession(sess.id), await db()('live_players').where({ id: a.player.id }).first());
    expect(st.atReview).toBe(true);
    expect(st.answered).toEqual([0, 1, 2]);

    // Amaka submits: she waits; nothing is revealed while Bayo is still playing.
    await emit(aS, 'submit');
    st = await live.playerState(await live.getSession(sess.id), await db()('live_players').where({ id: a.player.id }).first());
    expect(st).toMatchObject({ finished: true, gameOver: false, results: null });
    expect((await emit(aS, 'answer', { index: 0, response: { selected: 'A' } })).ok).toBe(false); // final once submitted
    expect((await live.publicState(await live.getSession(sess.id))).leaderboard).toEqual([]);

    // Bayo answers one question and submits → everyone has submitted → the game ends by itself.
    await emit(bS, 'answer', { index: 0, response: { selected: 'C' } });
    await emit(bS, 'submit');
    const over = await live.getSession(sess.id);
    expect(over.status).toBe('finished');

    // Results: every question with the player's answer, the correct one and the explanation; scores and ranks.
    const ra = await live.playerState(over, await db()('live_players').where({ id: a.player.id }).first());
    expect(ra.gameOver).toBe(true);
    expect(ra.rank).toBe(1);
    expect(ra.score).toBeGreaterThan(1500);
    expect(ra.results.map((r) => r.correct)).toEqual([true, true, true]);
    expect(ra.results[0]).toMatchObject({ response: { selected: 'B' }, answerKey: { correct: ['B'] } });
    const rb = await live.playerState(over, await db()('live_players').where({ id: b.player.id }).first());
    expect(rb.results.map((r) => (r.response ? r.correct : null))).toEqual([false, null, null]);
    expect(rb.score).toBe(0);
    [hostS, aS, bS].forEach((x) => x.close());
  });

  test('ending the game submits everyone still playing', async () => {
    const sess = await live.createSession({ examId, hostId: admin.id, kind: 'self_paced', timer: 30, allowGuests: true });
    const { player } = await live.join(sess, { nickname: 'Late' });
    await live.start(sess);
    await live.answer(await live.getSession(sess.id), await db()('live_players').where({ id: player.id }).first(), { index: 0, response: { selected: 'B' } });
    await live.finish(await live.getSession(sess.id));
    const p = await db()('live_players').where({ id: player.id }).first();
    expect(p.finished_at).not.toBeNull();
    expect(p.score).toBeGreaterThan(0);
  });
});

describe('self-paced homework', () => {
  test('homework stays open until the deadline, then shows results', async () => {
    await expect(live.createSession({ examId, hostId: admin.id, kind: 'homework', timer: 30 })).rejects.toThrow(/deadline/);
    const sess = await live.createSession({ examId, hostId: admin.id, kind: 'homework', timer: 30, allowGuests: true, deadline: new Date(Date.now() + 3600e3).toISOString() });
    expect(sess.status).toBe('running');
    const { player } = await live.join(sess, { nickname: 'Chidi' });
    await live.answer(sess, await db()('live_players').where({ id: player.id }).first(), { index: 0, response: { selected: 'B' } });
    await live.submitPlayer(sess, await db()('live_players').where({ id: player.id }).first());
    expect((await live.getSession(sess.id)).status).toBe('running'); // homework does not end when one person submits
    let me = await live.playerState(sess, await db()('live_players').where({ id: player.id }).first());
    expect(me).toMatchObject({ finished: true, gameOver: false });
    // After the deadline: nobody can join, and results appear.
    await db()('live_sessions').where({ id: sess.id }).update({ settings: JSON.stringify({ ...sess.settings, deadline: new Date(Date.now() - 1000).toISOString() }) });
    const after = await live.getSession(sess.id);
    await expect(live.join(after, { nickname: 'Late' })).rejects.toThrow(/ended/);
    me = await live.playerState(after, await db()('live_players').where({ id: player.id }).first());
    expect(me.gameOver).toBe(true);
    expect(me.results[0].correct).toBe(true);
  });

  test('a 6-digit PIN typed into the workspace join page goes to the live quiz', async () => {
    const u = await createUser();
    const agent = await login(app, { email: u.email });
    const t = await csrf(agent, '/join');
    const r = await agent.post('/join').type('form').send({ _csrf: t, code: '123456' });
    expect(r.headers.location).toBe('/play?pin=123456');
  });
});
