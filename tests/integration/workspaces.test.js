'use strict';

const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const qrepo = require('../../src/services/questions/repository');
const examsRepo = require('../../src/services/exams/repository');
const ws = require('../../src/services/workspaces');

const stamp = Date.now();
let app;
let adminAgent;
let platformQ;
let platformExam;
let orgA;
let orgB;
let catId;

async function makeOrg(name, limits) {
  const [pid] = await db()('products').insert({ type: 'plan', name: `Plan ${name}`, slug: `plan-${name}-${stamp}`.toLowerCase(), price_kobo: 1000000, plan_interval: 'monthly', audience: 'organisation', limits: JSON.stringify(limits), is_active: true });
  const [orgId] = await db()('organisations').insert({ name: `${name} ${stamp}`, slug: `${name}-${stamp}`.toLowerCase() });
  const u = await createUser({ roles: ['candidate'] });
  await db()('organisation_users').insert({ organisation_id: orgId, user_id: u.id, role: 'manager', joined_at: new Date() });
  await db()('subscriptions').insert({ user_id: u.id, organisation_id: orgId, product_id: pid, status: 'active', current_period_end: new Date(Date.now() + 30 * 86400000) });
  return { id: orgId, planId: pid, manager: u, agent: await login(app, { email: u.email }) };
}

const tokenFromOutbox = async (email) => {
  const job = await db()('jobs').where('type', 'email.send').whereRaw('payload LIKE ?', [`%${email}%`]).orderBy('id', 'desc').first();
  const payload = typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload);
  return /\/join\/([0-9a-f]{48})/.exec(payload)[1];
};

beforeAll(async () => {
  app = await bootApp();
  const a = await createUser({ roles: ['admin'] });
  const { secret } = await enable2fa(a.id);
  adminAgent = await login(app, { email: a.email, totpSecret: secret });
  [catId] = await db()('categories').insert({ name: `WS ${stamp}`, slug: `ws-${stamp}` });
  const user = { id: a.id, can: () => true };
  platformQ = await qrepo.saveQuestion({ meta: { category_id: catId, difficulty: 2, est_time_sec: 60 }, authoring: { type: 'true_false', stem_html: `<p>PLATFORM-SECRET-${stamp}</p>`, correct: true }, tags: [], user, status: 'published' });
  const eid = await examsRepo.createExam({ title: `Platform exam ${stamp}`, type: 'practice', category_id: catId, user });
  await examsRepo.addQuestions(eid, [platformQ.id]);
  await examsRepo.publish(eid, user);
  platformExam = await db()('exams').where({ id: eid }).first();
  orgA = await makeOrg('Acme', { candidates: 2, staff_seats: 2, exams: 1, ai_questions_per_month: 0 });
  orgB = await makeOrg('Globex', { candidates: 10, staff_seats: 3, exams: 5, ai_questions_per_month: 50 });
});

afterAll(() => closeAll(app));

const post = async (agent, url, body, from = '/org') => {
  const t = await csrf(agent, from);
  return agent.post(url).type('form').send({ _csrf: t, ...body });
};

describe('workspace access', () => {
  test('managers land on their workspace; platform admin pages are closed', async () => {
    const a = orgA.agent;
    expect((await a.get('/org')).text).toContain(`Acme ${stamp}`);
    expect((await a.get('/admin')).headers.location).toBe('/org');
    for (const url of ['/admin/users', '/admin/settings/general', '/admin/catalogue/categories', '/admin/orders', '/admin/questions/reports', '/admin/audit']) expect([url, (await a.get(url)).status]).toEqual([url, 403]);
    for (const url of ['/admin/questions', '/admin/exams', '/admin/imports', '/admin/attempts', '/admin/grading']) expect([url, (await a.get(url)).status]).toEqual([url, 200]);
  });

  test('no AI quota → no AI generator; a plan with quota shows it', async () => {
    expect((await orgA.agent.get('/admin/ai/new')).status).toBe(403);
    const page = await orgB.agent.get('/admin/ai/new');
    expect(page.status).toBe(200);
    expect(page.text).toContain('50</strong> AI-generated questions a month');
  });

  test('platform and other workspaces’ content is invisible and untouchable', async () => {
    const a = orgA.agent;
    // Workspace B writes a question.
    const t = await csrf(orgB.agent, '/admin/questions/new?type=true_false');
    await orgB.agent.post('/admin/questions').type('form').send({ _csrf: t, type: 'true_false', stem_html: `<p>GLOBEX-SECRET-${stamp}</p>`, payload: JSON.stringify({ type: 'true_false', correct: true }), category_id: catId, difficulty: 3, est_time_sec: 60, save_action: 'draft' });
    const bq = await db()('questions').where('stem_text', 'like', `%GLOBEX-SECRET-${stamp}%`).first();
    expect(bq.organisation_id).toBe(orgB.id);
    const list = await a.get('/admin/questions');
    expect(list.text).not.toContain(`PLATFORM-SECRET-${stamp}`);
    expect(list.text).not.toContain(`GLOBEX-SECRET-${stamp}`);
    for (const url of [`/admin/questions/${platformQ.id}`, `/admin/questions/${bq.id}`, `/admin/questions/${bq.id}/edit`, `/admin/exams/${platformExam.id}/basics`, `/admin/exams/${platformExam.id}/content`]) expect([url, (await a.get(url)).status]).toEqual([url, 404]);
    const t2 = await csrf(a, '/admin/questions');
    expect((await a.post(`/admin/questions/${bq.id}/delete`).type('form').send({ _csrf: t2 })).status).toBe(404);
    expect((await a.post(`/admin/exams/${platformExam.id}/publish`).type('form').send({ _csrf: t2 })).status).toBe(404);
    expect((await db()('questions').where({ id: bq.id }).first()).deleted_at).toBeNull();
    // Platform staff do not see workspace questions in the platform bank.
    expect((await adminAgent.get('/admin/questions')).text).not.toContain(`GLOBEX-SECRET-${stamp}`);
  });
});

describe('building and limits', () => {
  test('workspace exams are private, use only workspace questions, and respect the published-exam limit', async () => {
    const a = orgA.agent;
    let t = await csrf(a, '/admin/questions/new?type=true_false');
    await a.post('/admin/questions').type('form').send({ _csrf: t, type: 'true_false', stem_html: `<p>ACME-Q-${stamp}</p>`, payload: JSON.stringify({ type: 'true_false', correct: false }), category_id: catId, difficulty: 2, est_time_sec: 60, save_action: 'publish' });
    const q = await db()('questions').where('stem_text', 'like', `%ACME-Q-${stamp}%`).first();
    expect(q.organisation_id).toBe(orgA.id);
    t = await csrf(a, '/admin/exams');
    const created = await a.post('/admin/exams').type('form').send({ _csrf: t, title: `Acme onboarding ${stamp}`, type: 'practice' });
    const examId = Number(created.headers.location.match(/exams\/(\d+)/)[1]);
    const exam = await db()('exams').where({ id: examId }).first();
    expect(exam).toMatchObject({ organisation_id: orgA.id, visibility: 'org_private' });
    // The bank panel only offers workspace questions.
    const content = await a.get(`/admin/exams/${examId}/content`);
    expect(content.text).toContain(`ACME-Q-${stamp}`);
    expect(content.text).not.toContain(`PLATFORM-SECRET-${stamp}`);
    await post(a, `/admin/exams/${examId}/items/add`, { question_ids: [q.id, platformQ.id] }, '/admin/exams');
    expect(await db()('exam_questions').where({ exam_id: examId }).pluck('question_id')).toEqual([q.id]);
    // Cannot be made public or paid.
    await post(a, `/admin/exams/${examId}/tab/attempts`, { visibility: 'public', is_paid: '1', price: '5000' }, '/admin/exams');
    expect(await db()('exams').where({ id: examId }).first('visibility', 'is_paid')).toEqual({ visibility: 'org_private', is_paid: 0 });
    await post(a, `/admin/exams/${examId}/publish`, {}, '/admin/exams');
    expect((await db()('exams').where({ id: examId }).first()).status).toBe('published');
    // Second exam: over the plan's limit of 1.
    t = await csrf(a, '/admin/exams');
    const second = await a.post('/admin/exams').type('form').send({ _csrf: t, title: `Acme second ${stamp}`, type: 'practice' });
    const id2 = Number(second.headers.location.match(/exams\/(\d+)/)[1]);
    await post(a, `/admin/exams/${id2}/items/add`, { question_ids: [q.id] }, '/admin/exams');
    await post(a, `/admin/exams/${id2}/publish`, {}, '/admin/exams');
    expect((await db()('exams').where({ id: id2 }).first()).status).toBe('draft');
    expect((await a.get(`/admin/exams/${id2}/publish`)).text).toContain('allows 1 published exams');
    // It never appears in the public catalogue.
    expect((await require('supertest')(app).get('/exams')).text).not.toContain(`Acme onboarding ${stamp}`);
  });
});

describe('people, cohorts and reports', () => {
  test('invitations respect the candidate limit; accepting requires the invited email', async () => {
    const a = orgA.agent;
    await post(a, '/org/members/invite', { emails: `x1-${stamp}@example.com\nx2-${stamp}@example.com\nx3-${stamp}@example.com`, role: 'member' });
    expect(await db()('organisation_invitations').where({ organisation_id: orgA.id }).count({ n: '*' })).toEqual([{ n: 0 }]);
    const c1 = await createUser({ roles: ['candidate'] });
    const c2 = await createUser({ roles: ['candidate'] });
    await post(a, '/org/members/invite', { emails: `${c1.email}, ${c2.email}`, role: 'member' });
    expect(await db()('organisation_invitations').where({ organisation_id: orgA.id }).count({ n: '*' })).toEqual([{ n: 2 }]);
    const token = await tokenFromOutbox(c1.email);
    const wrong = await login(app, { email: c2.email });
    let t = await csrf(wrong, `/join/${token}`);
    await wrong.post(`/join/${token}`).type('form').send({ _csrf: t });
    expect(await db()('organisation_users').where({ organisation_id: orgA.id, user_id: c2.id }).first()).toBeUndefined();
    const right = await login(app, { email: c1.email });
    t = await csrf(right, `/join/${token}`);
    await right.post(`/join/${token}`).type('form').send({ _csrf: t });
    expect(await db()('organisation_users').where({ organisation_id: orgA.id, user_id: c1.id }).first()).toMatchObject({ role: 'member' });
    // Members get no workspace powers.
    expect((await right.get('/admin/questions')).status).toBe(403);
    expect((await right.get('/org')).status).toBe(403);
  });

  test('cohort: assign pre and post exams, members see them, progress and learning gain', async () => {
    const m = orgB.agent;
    const user = { id: orgB.manager.id, can: () => true };
    const q = await qrepo.saveQuestion({ meta: { category_id: catId, difficulty: 2, est_time_sec: 60 }, authoring: { type: 'true_false', stem_html: `<p>Globex check ${stamp}</p>`, correct: true }, tags: [], user, status: 'published', organisationId: orgB.id });
    const mk = async (title, type) => {
      const id = await examsRepo.createExam({ title: `${title} ${stamp}`, type, organisation_id: orgB.id, user });
      await examsRepo.addQuestions(id, [q.id]);
      await examsRepo.publish(id, user);
      return id;
    };
    const pre = await mk('Baseline', 'practice');
    const postExam = await mk('Final', 'practice');
    const learner = await createUser({ roles: ['candidate'] });
    await db()('organisation_users').insert({ organisation_id: orgB.id, user_id: learner.id, role: 'member' });
    let r = await post(m, '/org/cohorts', { name: `Cohort ${stamp}` });
    const cohortId = Number(r.headers.location.split('/').pop());
    await post(m, `/org/cohorts/${cohortId}/members`, { user_ids: [learner.id] });
    await post(m, `/org/cohorts/${cohortId}/assign`, { exam_id: pre, kind: 'pre' });
    await post(m, `/org/cohorts/${cohortId}/assign`, { exam_id: postExam, kind: 'post', due_at: '2030-01-01T09:00' });
    // Another workspace's exam cannot be assigned.
    const acmeExam = await db()('exams').where({ organisation_id: orgA.id, status: 'published' }).first('id');
    await post(m, `/org/cohorts/${cohortId}/assign`, { exam_id: acmeExam.id, kind: 'general' });
    expect(await db()('cohort_assignments').where({ cohort_id: cohortId }).count({ n: '*' })).toEqual([{ n: 2 }]);
    const la = await login(app, { email: learner.email });
    const dash = await la.get('/dashboard');
    expect(dash.text).toContain('Assigned to you');
    expect(dash.text).toContain(`Baseline ${stamp}`);
    const take = async (examId, correct) => {
      const exam = await db()('exams').where({ id: examId }).first();
      let t = await csrf(la, `/exams/${exam.slug}`);
      const uuid = (await la.post(`/exams/${exam.slug}/start`).type('form').send({ _csrf: t, accept: '1' })).headers.location.split('/').pop();
      const att = await db()('attempts').where({ uuid }).first();
      const item = await db()('attempt_items').where({ attempt_id: att.id }).first();
      t = await csrf(la, '/dashboard');
      await la.patch(`/attempts/${uuid}/answers`).set('Accept', 'application/json').set('X-CSRF-Token', t).send({ answers: [{ itemId: item.id, response: { selected: correct ? 'T' : 'F' } }] });
      t = await csrf(la, `/attempts/${uuid}`);
      await la.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    };
    await take(pre, false);
    await take(postExam, true);
    const p = await ws.cohortProgress(orgB.id, cohortId);
    expect(p.grid[0].cells.map((c) => c.percent)).toEqual([0, 100]);
    expect(p.gain).toMatchObject({ avgPre: 0, avgPost: 100, avgGain: 100 });
    const page = await m.get(`/org/cohorts/${cohortId}`);
    expect(page.text).toContain('+100 pts');
    expect((await m.get(`/org/cohorts/${cohortId}/export.csv`)).text).toContain(learner.email);
    expect((await m.get('/org/reports')).text).toContain(`Cohort ${stamp}`);
    // Workspace staff see their learners' attempts — and only theirs.
    const attempts = await m.get('/admin/attempts');
    expect(attempts.text).toContain(`Final ${stamp}`);
    expect(attempts.text).not.toContain(`Platform exam ${stamp}`);
  });

  test('join codes add candidates; managers cannot remove the last manager', async () => {
    const m = orgB.agent;
    await post(m, '/org/join-code', { enabled: '1' });
    const org = await db()('organisations').where({ id: orgB.id }).first();
    const j = await createUser({ roles: ['candidate'] });
    const ja = await login(app, { email: j.email });
    const t = await csrf(ja, '/join');
    await ja.post('/join').type('form').send({ _csrf: t, code: org.join_code.toLowerCase() });
    expect(await db()('organisation_users').where({ organisation_id: orgB.id, user_id: j.id }).first()).toMatchObject({ role: 'member' });
    await post(m, `/org/members/${orgB.manager.id}/role`, { role: 'member' });
    expect((await db()('organisation_users').where({ organisation_id: orgB.id, user_id: orgB.manager.id }).first()).role).toBe('manager');
  });

  test('a lapsed plan closes the builder but keeps the overview', async () => {
    await db()('subscriptions').where({ organisation_id: orgA.id }).update({ current_period_end: new Date(Date.now() - 1000) });
    const a = await login(app, { email: orgA.manager.email });
    expect((await a.get('/admin/exams')).status).toBe(403);
    const ov = await a.get('/org');
    expect(ov.status).toBe(200);
    expect(ov.text).toContain('Your company plan is not active');
  });
});
