'use strict';

const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const { parseJson } = require('../../src/utils/json');
const qrepo = require('../../src/services/questions/repository');
const examsRepo = require('../../src/services/exams/repository');
const attempts = require('../../src/services/attempts');
const sqlRunner = require('../../src/services/sql/runner');

let app;
let admin;
let adminAgent;
let catId;
const stamp = Date.now();
const SECRET_EXPLANATION = `Because-${stamp}-explanation`;
const SQL_SOLUTION = `SELECT name FROM hosts WHERE open_ports > ${stamp % 7 + 100} OR open_ports > 1`;
let qids = {};

async function question(authoring, meta = {}) {
  const saved = await qrepo.saveQuestion({ meta: { category_id: catId, difficulty: 3, est_time_sec: 60, ...meta }, authoring: { explanation_html: `<p>${SECRET_EXPLANATION}</p>`, ...authoring }, tags: [], user: { id: admin.id, can: () => true }, status: 'published' });
  return saved.id;
}

/** Builds and publishes an exam; returns the exam row. */
async function makeExam(title, questionIds, tabs = {}) {
  const user = { id: admin.id, can: () => true };
  const id = await examsRepo.createExam({ title: `${title} ${stamp}`, type: 'practice', category_id: catId, user });
  for (const [tab, input] of Object.entries(tabs)) await examsRepo.saveTab(id, tab, input, user);
  await examsRepo.addQuestions(id, questionIds);
  await examsRepo.publish(id, user);
  return db()('exams').where({ id }).first();
}

async function candidate() {
  const u = await createUser({ roles: ['candidate'] });
  return { user: await db()('users').where({ id: u.id }).first(), agent: await login(app, { email: u.email }) };
}

async function startVia(agent, exam) {
  const t = await csrf(agent, `/exams/${exam.slug}`);
  const res = await agent.post(`/exams/${exam.slug}/start`).type('form').send({ _csrf: t, accept: '1' });
  return res;
}

const patch = async (agent, uuid, body) => {
  const t = await csrf(agent, '/dashboard');
  return agent.patch(`/attempts/${uuid}/answers`).set('Accept', 'application/json').set('X-CSRF-Token', t).send(body);
};

beforeAll(async () => {
  app = await bootApp();
  const a = await createUser({ roles: ['admin'] });
  admin = await db()('users').where({ id: a.id }).first();
  const { secret } = await enable2fa(a.id);
  adminAgent = await login(app, { email: a.email, totpSecret: secret });
  [catId] = await db()('categories').insert({ name: `Attempts ${stamp}`, slug: `attempts-${stamp}` });
  qids.mcq = await question({ type: 'single_choice', stem_html: `<p>Capital of Nigeria ${stamp}?</p>`, options: [{ text: 'Lagos' }, { text: 'Abuja', correct: true }, { text: 'Kano' }] });
  qids.multi = await question({ type: 'multiple_response', stem_html: `<p>Pick the primes ${stamp}</p>`, options: [{ text: '2', correct: true }, { text: '3', correct: true }, { text: '4' }, { text: '6' }] });
  qids.sql = await question({ type: 'sql', marks: 2, stem_html: `<p>Hosts with more than one open port ${stamp}</p>`, mode: 'query', schema_sql: 'CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT, open_ports INTEGER);', seed_sql: "INSERT INTO hosts VALUES (1,'web',3),(2,'db',1),(3,'mail',2);", solution_sql: SQL_SOLUTION });
  qids.essay = await question({ type: 'essay', marks: 4, stem_html: `<p>Explain backups ${stamp}</p>`, rubric_html: '<p>Mentions RMAN</p>' });
});

afterAll(async () => {
  await sqlRunner.shutdown();
  await closeAll(app);
});

describe('taking an exam', () => {
  let exam;
  beforeAll(async () => {
    exam = await makeExam('Core', [qids.mcq, qids.multi, qids.sql], { timing: { duration_minutes: '20' }, scoring: { pass_mark: '50', pass_mark_type: 'percent', partial_credit: '1' }, certificate: { certificate_enabled: '1' } });
  });

  test('catalogue and exam page are public; starting needs sign-in', async () => {
    const request = require('supertest');
    const guest = request.agent(app);
    expect((await guest.get('/exams')).text).toContain(exam.title);
    const page = await guest.get(`/exams/${exam.slug}`);
    expect(page.text).toContain('Sign in to start');
    expect(page.text).toContain('You have 20 minutes in total');
  });

  test('correct answers never reach the browser before submission', async () => {
    const { agent } = await candidate();
    const res = await startVia(agent, exam);
    const uuid = res.headers.location.split('/').pop();
    const page = await agent.get(`/attempts/${uuid}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`Capital of Nigeria ${stamp}`);
    for (const secret of [SECRET_EXPLANATION, SQL_SOLUTION, 'is_correct', '"correct"', 'INSERT INTO hosts', 'rubric']) expect(page.text).not.toContain(secret);
    const items = await db()('attempt_items').where({ attempt_id: (await db()('attempts').where({ uuid }).first()).id });
    const save = await patch(agent, uuid, { answers: [{ itemId: items[0].id, response: { selected: 'A' } }] });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toMatch(/correct|explanation|solution/i);
    const sqlItem = items.find((i) => i.question_id === qids.sql);
    const t = await csrf(agent, '/dashboard');
    const run = await agent.post(`/attempts/${uuid}/items/${sqlItem.id}/sql`).set('Accept', 'application/json').set('X-CSRF-Token', t).send({ sql: 'SELECT name FROM hosts ORDER BY id' });
    expect(run.body.run.result.rows).toEqual([['web'], ['db'], ['mail']]);
    expect(JSON.stringify(run.body)).not.toContain(SQL_SOLUTION);
  });

  test('autosave, resume, submit, instant result with review and certificate', async () => {
    const { agent, user } = await candidate();
    const res = await startVia(agent, exam);
    const uuid = res.headers.location.split('/').pop();
    const attempt = await db()('attempts').where({ uuid }).first();
    const items = await db()('attempt_items as ai').join('question_options as o', 'o.question_version_id', 'ai.question_version_id').where('ai.attempt_id', attempt.id).select('ai.id', 'ai.question_id', 'o.option_key', 'o.is_correct');
    const keyFor = (qid) => items.filter((i) => i.question_id === qid && i.is_correct).map((i) => i.option_key);
    const idOf = async (qid) => (await db()('attempt_items').where({ attempt_id: attempt.id, question_id: qid }).first()).id;
    await patch(agent, uuid, { answers: [{ itemId: await idOf(qids.mcq), response: { selected: keyFor(qids.mcq)[0] } }, { itemId: await idOf(qids.multi), response: { selected: [keyFor(qids.multi)[0]] }, flagged: true }] });
    // Starting again resumes the same attempt.
    const again = await startVia(agent, exam);
    expect(again.headers.location).toBe(`/attempts/${uuid}`);
    expect((await agent.get(`/attempts/${uuid}`)).text).toContain('checked');
    await patch(agent, uuid, { answers: [{ itemId: await idOf(qids.sql), response: { sql: "SELECT name FROM hosts WHERE name IN ('web','mail')" } }] });
    const t = await csrf(agent, `/attempts/${uuid}`);
    const sub = await agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    expect(sub.headers.location).toBe(`/results/${uuid}`);
    const r = await db()('results').where({ attempt_id: attempt.id }).first();
    // 1 (mcq) + 0.5 of 1 (multi, partial) + 2 (sql) = 3.5 of 4
    expect(Number(r.raw_score)).toBe(3.5);
    expect(Number(r.percent)).toBe(87.5);
    expect(r.passed).toBe(1);
    const page = await agent.get(`/results/${uuid}`);
    expect(page.text).toContain('PASS');
    expect(page.text).toContain(SECRET_EXPLANATION); // explanations appear only after submission
    const cert = await db()('certificates').where({ attempt_id: attempt.id }).first();
    expect(cert.code).toMatch(/^EXM-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(cert.holder_name).toBe(user.full_name);
    const verify = await require('supertest')(app).get(`/verify/${cert.code}`);
    expect(verify.text).toContain('Valid certificate');
    const pdf = await agent.get(`/certificates/${cert.code}.pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((await agent.get(`/results/${uuid}/slip.pdf`)).headers['content-type']).toBe('application/pdf');
    // Submitting twice is harmless; saving afterwards is refused.
    const t2 = await csrf(agent, `/results/${uuid}`);
    await agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t2 });
    expect(await db()('results').where({ attempt_id: attempt.id }).count({ n: '*' })).toEqual([{ n: 1 }]);
    expect((await patch(agent, uuid, { answers: [] })).status).toBe(409);
  });

  test('other users cannot see or touch an attempt, its result or certificate', async () => {
    const owner = await candidate();
    const uuid = (await startVia(owner.agent, exam)).headers.location.split('/').pop();
    const other = await candidate();
    expect((await other.agent.get(`/attempts/${uuid}`)).status).toBe(404);
    expect((await patch(other.agent, uuid, { answers: [] })).status).toBe(404);
    expect((await other.agent.get(`/results/${uuid}`)).status).toBe(404);
    const t = await csrf(owner.agent, `/attempts/${uuid}`);
    await owner.agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    const cert = await db()('certificates').join('attempts', 'attempts.id', 'certificates.attempt_id').where('attempts.uuid', uuid).first('certificates.code');
    if (cert) expect((await other.agent.get(`/certificates/${cert.code}.pdf`)).status).toBe(404);
  });
});

describe('attempt rules (server-side)', () => {
  test('attempt limit, cooldown, and per-user override', async () => {
    const exam = await makeExam('Limits', [qids.mcq], { attempts: { max_attempts: '1', cooldown_minutes: '60', score_policy: 'best', visibility: 'public' } });
    const { agent, user } = await candidate();
    const uuid = (await startVia(agent, exam)).headers.location.split('/').pop();
    const t = await csrf(agent, `/attempts/${uuid}`);
    await agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    const blocked = await startVia(agent, exam);
    expect(blocked.headers.location).toBe(`/exams/${exam.slug}#start`);
    expect((await agent.get(`/exams/${exam.slug}`)).text).toContain('You have used all 1 attempt');
    expect(await db()('attempts').where({ user_id: user.id, exam_id: exam.id }).count({ n: '*' })).toEqual([{ n: 1 }]);
    // An extra attempt alone is not enough during the cooldown…
    await examsRepo.grantAttempts(exam.id, { email: user.email, extra_attempts: 1, reason: 'Network failure' }, admin.id);
    await startVia(agent, exam);
    expect(await db()('attempts').where({ user_id: user.id, exam_id: exam.id }).count({ n: '*' })).toEqual([{ n: 1 }]);
    expect((await agent.get(`/exams/${exam.slug}`)).text).toContain('You can try again from');
    // …unless the override also resets the cooldown.
    await examsRepo.grantAttempts(exam.id, { email: user.email, extra_attempts: 1, reason: 'Power outage at centre', reset_cooldown: '1' }, admin.id);
    expect((await startVia(agent, exam)).headers.location).toMatch(/^\/attempts\//);
  });

  test('invite codes, IP rules and paid exams', async () => {
    const inv = await makeExam('Invite', [qids.mcq], { attempts: { visibility: 'invite_code', invite_code: `ACME-${stamp}` } });
    const { agent, user: me } = await candidate();
    expect((await startVia(agent, inv)).headers.location).toBe(`/exams/${inv.slug}#start`);
    let t = await csrf(agent, `/exams/${inv.slug}`);
    await agent.post(`/exams/${inv.slug}/invite`).type('form').send({ _csrf: t, invite_code: 'wrong' });
    expect((await startVia(agent, inv)).headers.location).toBe(`/exams/${inv.slug}#start`);
    t = await csrf(agent, `/exams/${inv.slug}`);
    await agent.post(`/exams/${inv.slug}/invite`).type('form').send({ _csrf: t, invite_code: `acme-${stamp}` });
    expect((await startVia(agent, inv)).headers.location).toMatch(/^\/attempts\//);

    const ipExam = await makeExam('IP', [qids.mcq]);
    await examsRepo.addAccessRule(ipExam.id, 'ip_allow', '102.89.0.0/16');
    expect((await startVia(agent, ipExam)).headers.location).toBe(`/exams/${ipExam.slug}#start`);
    const { ipInRange } = require('../../src/services/attempts/eligibility');
    expect(ipInRange('102.89.44.1', '102.89.0.0/16')).toBe(true);
    expect(ipInRange('::ffff:102.89.44.1', '102.89.0.0/16')).toBe(true);
    expect(ipInRange('102.90.0.1', '102.89.0.0/16')).toBe(false);

    const paid = await makeExam('Paid', [qids.mcq], { attempts: { is_paid: '1', price: '5000', visibility: 'public' } });
    expect((await startVia(agent, paid)).headers.location).toBe(`/exams/${paid.slug}#start`);
    const [productId] = await db()('products').insert({ type: 'exam', name: `Paid ${stamp}`, slug: `paid-${stamp}`, exam_id: paid.id, price_kobo: 500000 });
    await db()('entitlements').insert({ user_id: me.id, product_id: productId, starts_at: new Date(Date.now() - 1000), source: 'admin' });
    expect((await startVia(agent, paid)).headers.location).toMatch(/^\/attempts\//);
  });
});

describe('timing', () => {
  test('saves after the deadline submit the attempt; the sweeper finalises abandoned attempts', async () => {
    const exam = await makeExam('Timed', [qids.mcq], { timing: { duration_minutes: '5', grace_seconds: '0' } });
    const a = await candidate();
    const uuid = (await startVia(a.agent, exam)).headers.location.split('/').pop();
    await db()('attempts').where({ uuid }).update({ expires_at: new Date(Date.now() - 60000) });
    const late = await patch(a.agent, uuid, { answers: [] });
    expect(late.body.submitted).toBe(true);
    expect((await db()('attempts').where({ uuid }).first()).submit_reason).toBe('timeout');

    const b = await candidate();
    const uuid2 = (await startVia(b.agent, exam)).headers.location.split('/').pop();
    await db()('attempts').where({ uuid: uuid2 }).update({ expires_at: new Date(Date.now() - 60000) });
    const swept = await attempts.sweepExpired();
    expect(swept.submitted).toBeGreaterThanOrEqual(1);
    expect((await db()('attempts').where({ uuid: uuid2 }).first()).submit_reason).toBe('sweeper');
  });

  test('linear navigation and closed sections reject late changes', async () => {
    const user = { id: admin.id, can: () => true };
    const id = await examsRepo.createExam({ title: `Sections ${stamp}`, type: 'practice', category_id: catId, user });
    await examsRepo.saveTab(id, 'timing', { duration_minutes: '60' }, user);
    await examsRepo.saveTab(id, 'delivery', { navigation: 'linear' }, user);
    const s1 = await examsRepo.saveSection(id, null, { title: 'One', time_limit_minutes: '10' });
    const s2 = await examsRepo.saveSection(id, null, { title: 'Two', time_limit_minutes: '10' });
    await examsRepo.addQuestions(id, [qids.mcq], s1);
    await examsRepo.addQuestions(id, [qids.multi], s2);
    await examsRepo.publish(id, user);
    const exam = await db()('exams').where({ id }).first();
    const c = await candidate();
    const { attempt, token } = await attempts.startAttempt(c.user, exam, {});
    const items = await db()('attempt_items').where({ attempt_id: attempt.id }).orderBy('display_order');
    let r = await attempts.saveAnswers(attempt, { answers: [{ itemId: items[1].id, response: { selected: ['A'] } }] }, { token });
    expect(r.rejected[0].reason).toBe('section_closed');
    const st = await attempts.finishSection(await db()('attempts').where({ id: attempt.id }).first());
    expect(st.sectionIndex).toBe(1);
    const fresh = await db()('attempts').where({ id: attempt.id }).first();
    r = await attempts.saveAnswers(fresh, { answers: [{ itemId: items[0].id, response: { selected: 'A' } }, { itemId: items[1].id, response: { selected: ['A'] } }], pos: 1 }, { token });
    expect(r.rejected).toEqual([{ itemId: items[0].id, reason: 'section_closed' }]);
    expect(r.saved).toEqual([items[1].id]);
    // single-session: another token is refused
    await expect(attempts.saveAnswers(fresh, { answers: [] }, { token: 'someone-else' })).rejects.toThrow(/another browser/);
  });
});

describe('manual grading', () => {
  test('essays wait for a grader; the certificate follows the final grade', async () => {
    const exam = await makeExam('Essay', [qids.mcq, qids.essay], { scoring: { pass_mark: '60', pass_mark_type: 'percent' }, certificate: { certificate_enabled: '1' } });
    const { agent } = await candidate();
    const uuid = (await startVia(agent, exam)).headers.location.split('/').pop();
    const attempt = await db()('attempts').where({ uuid }).first();
    const mcqItem = await db()('attempt_items as ai').join('question_options as o', 'o.question_version_id', 'ai.question_version_id').where({ 'ai.attempt_id': attempt.id, 'ai.question_id': qids.mcq, 'o.is_correct': true }).first('ai.id', 'o.option_key');
    const essayItem = await db()('attempt_items').where({ attempt_id: attempt.id, question_id: qids.essay }).first();
    await patch(agent, uuid, { answers: [{ itemId: mcqItem.id, response: { selected: mcqItem.option_key } }, { itemId: essayItem.id, response: { text: 'Use RMAN incremental backups with a recovery catalogue.' } }] });
    const t = await csrf(agent, `/attempts/${uuid}`);
    await agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    let a = await db()('attempts').where({ uuid }).first();
    expect(a.status).toBe('pending_manual');
    expect(a.passed).toBeNull();
    expect(await db()('certificates').where({ attempt_id: a.id }).first()).toBeUndefined();
    expect((await agent.get(`/results/${uuid}`)).text).toContain('Provisional');
    const queue = await adminAgent.get('/admin/grading');
    expect(queue.text).toContain('Use RMAN incremental backups');
    const t2 = await csrf(adminAgent, '/admin/grading');
    await adminAgent.post(`/admin/attempts/${a.id}/items/${essayItem.id}/grade`).type('form').send({ _csrf: t2, marks: '3', feedback: 'Good, mention retention.' });
    a = await db()('attempts').where({ uuid }).first();
    expect(a.status).toBe('graded');
    expect(Number(a.percent)).toBe(80);
    expect(a.passed).toBe(1);
    expect(await db()('certificates').where({ attempt_id: a.id }).first()).toBeTruthy();
    expect(await db()('jobs').where('type', 'email.send').whereRaw('payload LIKE ?', ['%essay_graded%']).first()).toBeTruthy();
    const t3 = await csrf(adminAgent, '/admin/grading');
    const bad = await adminAgent.post(`/admin/attempts/${a.id}/items/${essayItem.id}/grade`).type('form').send({ _csrf: t3, marks: '9' });
    expect(bad.status).toBe(302);
    expect(Number((await db()('attempt_items').where({ id: essayItem.id }).first()).marks_awarded)).toBe(3);
    expect((await adminAgent.get(`/admin/attempts/${a.id}`)).text).toContain('Good, mention retention.');
  });

  test('manual-release exams withhold results until released; certificates can be revoked', async () => {
    const exam = await makeExam('Manual release', [qids.mcq], { release: { result_release: 'manual' }, scoring: { pass_mark: '0', pass_mark_type: 'percent' }, certificate: { certificate_enabled: '1' } });
    const { agent } = await candidate();
    const uuid = (await startVia(agent, exam)).headers.location.split('/').pop();
    const t = await csrf(agent, `/attempts/${uuid}`);
    await agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    const page = await agent.get(`/results/${uuid}`);
    expect(page.text).toContain('released by the examiner');
    expect(page.text).not.toContain(SECRET_EXPLANATION);
    expect((await agent.get(`/results/${uuid}/slip.pdf`)).status).toBe(403);
    const t2 = await csrf(adminAgent, '/admin/attempts');
    await adminAgent.post(`/admin/exams/${exam.id}/results/release`).type('form').send({ _csrf: t2 });
    expect((await agent.get(`/results/${uuid}`)).text).toContain('Score');
    const a = await db()('attempts').where({ uuid }).first();
    const cert = await db()('certificates').where({ attempt_id: a.id }).first();
    const t3 = await csrf(adminAgent, `/admin/attempts/${a.id}`);
    await adminAgent.post(`/admin/certificates/${cert.id}/revoke`).type('form').send({ _csrf: t3, reason: 'Integrity review upheld' });
    const v = await require('supertest')(app).get(`/verify/${cert.code}`);
    expect(v.text).toContain('This certificate has been revoked');
    expect(v.text).toContain('Integrity review upheld');
  });

  test('candidates cannot open admin grading', async () => {
    const { agent } = await candidate();
    expect((await agent.get('/admin/grading')).status).toBe(403);
    expect((await agent.get('/admin/attempts')).status).toBe(403);
  });
});
