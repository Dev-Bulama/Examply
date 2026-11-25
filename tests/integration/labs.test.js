'use strict';

const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const qrepo = require('../../src/services/questions/repository');
const examsRepo = require('../../src/services/exams/repository');
const demo = require('../../seeds/data/labQuestions');

let app;
let admin;
let adminAgent;
let catId;
let labId;
let exam;
const stamp = Date.now();

async function candidate() {
  const u = await createUser({ roles: ['candidate'] });
  return { user: u, agent: await login(app, { email: u.email }) };
}

async function start(agent) {
  const t = await csrf(agent, `/exams/${exam.slug}`);
  const res = await agent.post(`/exams/${exam.slug}/start`).type('form').send({ _csrf: t, accept: '1' });
  const uuid = res.headers.location.split('/').pop();
  const attempt = await db()('attempts').where({ uuid }).first();
  const item = await db()('attempt_items').where({ attempt_id: attempt.id }).first();
  return { uuid, attempt, item };
}

const cmd = async (agent, uuid, itemId, body) => {
  const t = await csrf(agent, '/dashboard');
  return agent.post(`/attempts/${uuid}/items/${itemId}/lab`).set('Accept', 'application/json').set('X-CSRF-Token', t).send(body);
};

beforeAll(async () => {
  app = await bootApp();
  const a = await createUser({ roles: ['admin'] });
  admin = await db()('users').where({ id: a.id }).first();
  const { secret } = await enable2fa(a.id);
  adminAgent = await login(app, { email: a.email, totpSecret: secret });
  [catId] = await db()('categories').insert({ name: `Labs ${stamp}`, slug: `labs-${stamp}` });
  const q = JSON.parse(JSON.stringify(demo[1].q));
  q.stem_html = `<p>Fix permissions ${stamp}</p>`;
  const saved = await qrepo.saveQuestion({ meta: { category_id: catId, difficulty: 2, est_time_sec: 600 }, authoring: q, tags: [], user: { id: admin.id, can: () => true }, status: 'published' });
  labId = saved.id;
  const user = { id: admin.id, can: () => true };
  const id = await examsRepo.createExam({ title: `Lab exam ${stamp}`, type: 'practice', category_id: catId, user });
  await examsRepo.saveTab(id, 'scoring', { pass_mark: '50', pass_mark_type: 'percent', partial_credit: '1' }, user);
  await examsRepo.addQuestions(id, [labId]);
  await examsRepo.publish(id, user);
  exam = await db()('exams').where({ id }).first();
});

afterAll(async () => closeAll(app));

describe('terminal labs in an exam', () => {
  test('the player renders the terminal without leaking checks', async () => {
    const { agent } = await candidate();
    const { uuid } = await start(agent);
    const page = await agent.get(`/attempts/${uuid}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('lab-terminal');
    expect(page.text).toContain('/etc/shadow must not be readable');
    expect(page.text).not.toContain('file_mode');
    expect(page.text).not.toContain('Sup3rS3cret');
  });

  test('commands run on a persistent per-candidate machine and are graded with partial credit', async () => {
    const { agent } = await candidate();
    const { uuid, item } = await start(agent);
    const init = await cmd(agent, uuid, item.id, { init: true });
    expect(init.body.ok).toBe(true);
    expect(init.body.prompt).toContain('analyst@files01');
    const denied = await cmd(agent, uuid, item.id, { command: 'chmod 640 /etc/shadow' });
    expect(denied.body.exit).not.toBe(0);
    expect((await cmd(agent, uuid, item.id, { command: 'sudo chmod 640 /etc/shadow' })).body.exit).toBe(0);
    expect((await cmd(agent, uuid, item.id, { command: 'sudo rm /opt/app/backup.sql' })).body.exit).toBe(0);
    // Reconnecting replays the transcript instead of building a new machine.
    const again = await cmd(agent, uuid, item.id, { init: true });
    expect(again.body.replay).toContain('sudo rm /opt/app/backup.sql');

    const t = await csrf(agent, `/attempts/${uuid}`);
    await agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    const graded = await db()('attempt_items').where({ id: item.id }).first();
    expect(Number(graded.marks_awarded)).toBe(2); // 2 of 4 tasks, item worth 4
    expect(!!graded.is_correct).toBe(false);
    const result = await agent.get(`/results/${uuid}`);
    expect(result.text).toContain('Delete the stray database dump');

    const late = await cmd(agent, uuid, item.id, { command: 'ls' });
    expect(late.status).toBe(409);
  });

  test("a candidate cannot use another candidate's lab", async () => {
    const owner = await candidate();
    const { uuid, item } = await start(owner.agent);
    const other = await candidate();
    const res = await cmd(other.agent, uuid, item.id, { command: 'whoami' });
    expect([403, 404]).toContain(res.status);
  });

  test('an untouched lab scores zero', async () => {
    const { agent } = await candidate();
    const { uuid, item } = await start(agent);
    const t = await csrf(agent, `/attempts/${uuid}`);
    await agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    const graded = await db()('attempt_items').where({ id: item.id }).first();
    expect(Number(graded.marks_awarded)).toBe(0);
  });
});

describe('staff lab preview', () => {
  test('staff see task progress and can reset', async () => {
    const t = await csrf(adminAgent, `/admin/questions/${labId}`);
    const send = (body) => adminAgent.post(`/admin/questions/${labId}/lab`).set('Accept', 'application/json').set('X-CSRF-Token', t).send(body);
    await send({ init: true });
    const res = await send({ command: 'sudo chmod 600 /opt/app/config/db.env' });
    expect(res.body.ok).toBe(true);
    expect(res.body.tasks.find((x) => x.id === 'env-mode').passed).toBe(true);
    await send({ reset: true });
    const after = await send({ command: 'stat /opt/app/config/db.env' });
    expect(after.body.tasks.find((x) => x.id === 'env-mode').passed).toBe(false);
  });

  test('candidates cannot use the preview endpoint', async () => {
    const { agent } = await candidate();
    const t = await csrf(agent, '/dashboard');
    const res = await agent.post(`/admin/questions/${labId}/lab`).set('Accept', 'application/json').set('X-CSRF-Token', t).send({ command: 'ls' });
    expect([302, 403, 404]).toContain(res.status);
  });
});
