'use strict';

const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const { parseJson } = require('../../src/utils/json');
const repo = require('../../src/services/questions/repository');
const sqlRunner = require('../../src/services/sql/runner');

let app;
let agent;
let admin;
let catId;
let certId;
let domainId;
const qids = [];
let sqlId;

const SQL_Q = {
  type: 'sql',
  stem_html: '<p>List hosts with more than one open port.</p>',
  marks: 2,
  mode: 'query',
  schema_sql: 'CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT, open_ports INTEGER);',
  seed_sql: "INSERT INTO hosts VALUES (1,'web',3),(2,'db',1),(3,'mail',2);",
  solution_sql: 'SELECT name FROM hosts WHERE open_ports > 1',
};

beforeAll(async () => {
  app = await bootApp();
  admin = await createUser({ roles: ['admin'] });
  const { secret } = await enable2fa(admin.id);
  agent = await login(app, { email: admin.email, totpSecret: secret });
  const stamp = Date.now();
  [catId] = await db()('categories').insert({ name: `Exams ${stamp}`, slug: `exams-${stamp}` });
  [certId] = await db()('certifications').insert({ name: `Cert ${stamp}`, slug: `cert-${stamp}`, category_id: catId, exam_code: `EX${stamp % 1000}` });
  [domainId] = await db()('certification_domains').insert({ certification_id: certId, code: 'D1', name: 'Domain one', weight_percent: 100 });
  const user = { id: admin.id, can: () => true };
  for (let i = 0; i < 6; i += 1) {
    const saved = await repo.saveQuestion({ meta: { category_id: catId, certification_id: certId, domain_id: domainId, difficulty: 2 + (i % 3), est_time_sec: 60 }, authoring: { type: 'single_choice', stem_html: `<p>Builder question ${i} ${stamp}</p>`, options: [{ text: 'A', correct: true }, { text: 'B' }, { text: 'C' }] }, tags: [], user, status: 'published' });
    qids.push(saved.id);
  }
  sqlId = (await repo.saveQuestion({ meta: { category_id: catId, certification_id: certId, domain_id: domainId, difficulty: 3, est_time_sec: 120 }, authoring: { ...SQL_Q, stem_html: `<p>SQL ${stamp}</p>` }, tags: [], user, status: 'published' })).id;
});

afterAll(async () => {
  await sqlRunner.shutdown();
  await closeAll(app);
});

async function newExam(fields) {
  const t = await csrf(agent, '/admin/exams');
  const res = await agent.post('/admin/exams').type('form').send({ _csrf: t, ...fields });
  expect(res.status).toBe(302);
  return Number(res.headers.location.match(/exams\/(\d+)/)[1]);
}

const post = async (url, body, json = false) => {
  const t = await csrf(agent, '/admin/exams');
  const r = agent.post(url).type('form');
  if (json) r.set('Accept', 'application/json');
  return r.send({ _csrf: t, ...body });
};

describe('exam builder', () => {
  test('create with type defaults; every tab renders', async () => {
    const id = await newExam({ title: 'Builder mock', type: 'mock', certification_id: certId, category_id: catId });
    const e = await db()('exams').where({ id }).first();
    expect(e).toMatchObject({ type: 'mock', status: 'draft', duration_minutes: 90, max_attempts: 3, certificate_enabled: 1 });
    expect(Number(e.pass_mark)).toBe(70);
    for (const tab of ['basics', 'content', 'timing', 'attempts', 'delivery', 'scoring', 'release', 'integrity', 'certificate', 'instructions', 'publish']) {
      const r = await agent.get(`/admin/exams/${id}/${tab}`);
      expect([tab, r.status]).toEqual([tab, 200]);
    }
  });

  test('pre-training exams get four default bands', async () => {
    const id = await newExam({ title: 'Diag', type: 'pre_training' });
    const bands = await db()('exam_bands').where({ exam_id: id }).orderBy('min_percent');
    expect(bands.map((b) => b.name)).toEqual(['Beginner', 'Intermediate', 'Advanced', 'Expert']);
  });

  test('autosave returns JSON, validates, and records an audit entry', async () => {
    const id = await newExam({ title: 'Autosave', type: 'practice' });
    const ok = await post(`/admin/exams/${id}/tab/timing`, { duration_minutes: '45', grace_seconds: '30', available_from: '2026-12-01T09:00', available_until: '2026-12-02T09:00', time_out_action: 'lock' }, true);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true });
    const e = await db()('exams').where({ id }).first();
    expect(e.duration_minutes).toBe(45);
    expect(new Date(e.available_from).toISOString()).toBe('2026-12-01T08:00:00.000Z'); // Africa/Lagos → UTC
    expect(parseJson(e.settings).timing.time_out_action).toBe('lock');
    const bad = await post(`/admin/exams/${id}/tab/timing`, { duration_minutes: '0', available_from: '2026-12-02T09:00', available_until: '2026-12-01T09:00' }, true);
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((x) => x.field)).toEqual(expect.arrayContaining(['duration_minutes', 'available_until']));
    expect(await db()('audit_logs').where({ action: 'exam.update', entity_id: id }).first()).toBeTruthy();
    const scoring = await post(`/admin/exams/${id}/tab/scoring`, { pass_mark: '120', pass_mark_type: 'percent' }, true);
    expect(scoring.body.errors[0].message).toMatch(/0–100/);
    const paid = await post(`/admin/exams/${id}/tab/attempts`, { is_paid: '1', price: '', visibility: 'invite_code' }, true);
    expect(paid.body.errors.map((x) => x.field)).toEqual(expect.arrayContaining(['price', 'invite_code']));
  });

  test('fixed list: sections, add, marks, reorder, remove; checklist; publish snapshot; edits need republishing', async () => {
    const id = await newExam({ title: 'Fixed list', type: 'mock', category_id: catId });
    let pub = await post(`/admin/exams/${id}/publish`, {});
    expect((await db()('exams').where({ id }).first()).status).toBe('draft'); // empty exam is blocked
    await post(`/admin/exams/${id}/sections`, { title: 'Part A', time_limit_minutes: '30' });
    await post(`/admin/exams/${id}/sections`, { title: 'Part B', time_limit_minutes: '70' });
    const [a, b] = await db()('exam_sections').where({ exam_id: id }).orderBy('display_order');
    await post(`/admin/exams/${id}/items/add`, { question_ids: qids.slice(0, 3), section_id: a.id });
    await post(`/admin/exams/${id}/items/add`, { question_ids: [qids[3], sqlId, qids[0]], section_id: b.id });
    let items = await db()('exam_questions').where({ exam_id: id }).orderBy('display_order');
    expect(items).toHaveLength(5); // qids[0] was not added twice
    await post(`/admin/exams/${id}/items`, { item_id: items[0].id, marks: '2.5' }, true);
    await post(`/admin/exams/${id}/items`, { action: 'reorder', order: items.map((i) => i.id).reverse() }, true);
    items = await db()('exam_questions').where({ exam_id: id }).orderBy('display_order');
    expect(items[4].question_id).toBe(qids[0]);
    expect(Number(items[4].marks)).toBe(2.5);
    // Section timers (100) exceed the 90-minute duration → blocked
    pub = await post(`/admin/exams/${id}/publish`, {});
    expect((await db()('exams').where({ id }).first()).status).toBe('draft');
    await post(`/admin/exams/${id}/sections/${b.id}`, { title: 'Part B', time_limit_minutes: '60' });
    await post(`/admin/exams/${id}/items`, { action: 'remove', item_ids: [items[1].id] });
    pub = await post(`/admin/exams/${id}/publish`, { note: 'First release' });
    expect(pub.status).toBe(302);
    const e = await db()('exams').where({ id }).first();
    expect(e).toMatchObject({ status: 'published', version: 1 });
    const v = await db()('exam_versions').where({ exam_id: id }).first();
    const snap = parseJson(v.snapshot);
    expect(snap.items).toHaveLength(4);
    expect(snap.items.every((i) => i.version_id)).toBe(true);
    expect(snap.summary.questionCount).toBe(4);
    expect(snap.summary.questionTypes).toEqual(['single_choice', 'sql']);
    expect((await agent.get(`/admin/exams/${id}/versions/1`)).text).toContain('version 1');
    // Edit after publishing → banner until republished as v2
    await new Promise((r) => setTimeout(r, 2100));
    await post(`/admin/exams/${id}/tab/delivery`, { navigation: 'linear', shuffle_questions: '1' }, true);
    expect((await agent.get(`/admin/exams/${id}/basics`)).text).toContain('changes that candidates do not see yet');
    await post(`/admin/exams/${id}/publish`, {});
    expect((await db()('exams').where({ id }).first()).version).toBe(2);
    // Instructions reflect the settings
    const ins = await agent.get(`/admin/exams/${id}/instructions`);
    expect(ins.text).toContain('cannot go back');
    expect(ins.text).toContain('SQL lab questions give you a sample database');
  });

  test('blueprint rules: live availability, satisfiable check', async () => {
    const id = await newExam({ title: 'Blueprint', type: 'practice', content_mode: 'blueprint', category_id: catId });
    const prev = await agent.get(`/admin/exams/${id}/rules/preview.json?certification_id=${certId}&domain_id=${domainId}&question_types=single_choice`).set('Accept', 'application/json');
    expect(prev.body).toMatchObject({ ok: true, available: 6, pool_types: ['single_choice'] });
    const hard = await agent.get(`/admin/exams/${id}/rules/preview.json?certification_id=${certId}&difficulty_min=4`).set('Accept', 'application/json');
    expect(hard.body.available).toBe(2);
    await post(`/admin/exams/${id}/rules`, { question_count: '10', certification_id: certId });
    await post(`/admin/exams/${id}/publish`, {});
    expect((await db()('exams').where({ id }).first()).status).toBe('draft');
    const rule = await db()('exam_blueprint_rules').where({ exam_id: id }).first();
    await post(`/admin/exams/${id}/rules/${rule.id}`, { question_count: '5', certification_id: certId });
    await post(`/admin/exams/${id}/publish`, {});
    expect((await db()('exams').where({ id }).first()).status).toBe('published');
    const bad = await post(`/admin/exams/${id}/rules`, { question_count: '0', difficulty_min: '4', difficulty_max: '2' });
    expect(bad.status).toBe(302);
    expect(await db()('exam_blueprint_rules').where({ exam_id: id }).count('* as n').first()).toEqual({ n: 1 });
  });

  test('bands must not overlap; access rules validate IPs; extra attempts are audited', async () => {
    const id = await newExam({ title: 'Access', type: 'pre_training' });
    await post(`/admin/exams/${id}/bands`, { bands: { 0: { name: 'Low', min_percent: '0', max_percent: '60' }, 1: { name: 'High', min_percent: '50', max_percent: '100' } } });
    expect(await db()('exam_bands').where({ exam_id: id }).count('* as n').first()).toEqual({ n: 4 }); // unchanged
    await post(`/admin/exams/${id}/bands`, { bands: { 0: { name: 'Low', min_percent: '0', max_percent: '59.99' }, 1: { name: 'High', min_percent: '60', max_percent: '100', course_url: 'https://example.com/c' } } });
    expect((await db()('exam_bands').where({ exam_id: id }).orderBy('min_percent')).map((b) => b.name)).toEqual(['Low', 'High']);
    await post(`/admin/exams/${id}/access`, { rule_type: 'ip_allow', value: '300.1.1.1' });
    await post(`/admin/exams/${id}/access`, { rule_type: 'ip_allow', value: '102.89.0.0/16' });
    expect((await db()('exam_access_rules').where({ exam_id: id })).map((r) => r.value)).toEqual(['102.89.0.0/16']);
    const cand = await createUser({ roles: ['candidate'] });
    await post(`/admin/exams/${id}/overrides`, { email: cand.email, extra_attempts: '2', reason: 'x' });
    expect(await db()('exam_attempt_overrides').where({ exam_id: id }).first()).toBeUndefined();
    await post(`/admin/exams/${id}/overrides`, { email: cand.email, extra_attempts: '2', reason: 'Power cut during the attempt' });
    expect(await db()('exam_attempt_overrides').where({ exam_id: id }).first()).toMatchObject({ user_id: cand.id, extra_attempts: 2, granted_by: admin.id });
    expect(await db()('audit_logs').where({ action: 'exam.attempts.grant', entity_id: id }).first()).toBeTruthy();
    expect((await agent.get(`/admin/exams/${id}/instructions`)).text).toContain('approved locations');
  });

  test('duplicate copies structure; delete only without attempts', async () => {
    const id = await newExam({ title: 'To copy', type: 'mock' });
    await post(`/admin/exams/${id}/sections`, { title: 'S1' });
    await post(`/admin/exams/${id}/items/add`, { question_ids: qids.slice(0, 2) });
    const r = await post(`/admin/exams/${id}/duplicate`, {});
    const copyId = Number(r.headers.location.match(/exams\/(\d+)/)[1]);
    expect(copyId).not.toBe(id);
    expect((await db()('exams').where({ id: copyId }).first()).title).toBe('To copy (copy)');
    expect(await db()('exam_questions').where({ exam_id: copyId }).count('* as n').first()).toEqual({ n: 2 });
    expect(await db()('exam_sections').where({ exam_id: copyId }).count('* as n').first()).toEqual({ n: 1 });
    await post(`/admin/exams/${copyId}/delete`, {});
    expect((await db()('exams').where({ id: copyId }).first()).deleted_at).not.toBeNull();
  });

  test('permissions: a question author cannot open or change exams', async () => {
    const author = await createUser({ roles: ['question_author'] });
    const a2 = await login(app, { email: author.email });
    expect((await a2.get('/admin/exams')).status).toBe(403);
  });
});

describe('SQL lab endpoints', () => {
  test('run and check against a saved question; the solution never reaches the browser', async () => {
    const page = await agent.get(`/admin/questions/${sqlId}`);
    expect(page.text).toContain('data-run="/admin/questions/' + sqlId + '/sql/run"');
    const t = await csrf(agent, `/admin/questions/${sqlId}`);
    const run = await agent.post(`/admin/questions/${sqlId}/sql/run`).set('Accept', 'application/json').set('X-CSRF-Token', t).send({ sql: 'SELECT name FROM hosts ORDER BY id', check: true });
    expect(run.body.run.result.rows).toEqual([['web'], ['db'], ['mail']]);
    expect(run.body.check).toMatchObject({ correct: false });
    expect(JSON.stringify(run.body)).not.toContain('open_ports > 1');
    const good = await agent.post(`/admin/questions/${sqlId}/sql/run`).set('Accept', 'application/json').set('X-CSRF-Token', t).send({ sql: 'select name from hosts where open_ports >= 2', check: true });
    expect(good.body.check.correct).toBe(true);
    const desc = await agent.post(`/admin/questions/${sqlId}/sql/run`).set('Accept', 'application/json').set('X-CSRF-Token', t).send({ describe: true });
    expect(desc.body.schema.tables[0].name).toBe('hosts');
  });

  test('the editor bench verifies a draft; saving a broken SQL question is refused', async () => {
    const t = await csrf(agent, '/admin/questions/new?type=sql');
    const v = await agent.post('/admin/sql/run').set('Accept', 'application/json').set('X-CSRF-Token', t).send({ question: { ...SQL_Q, solution_sql: 'SELECT x FROM hosts' }, target: 'verify' });
    expect(v.body.errors[0].message).toMatch(/model solution failed/);
    const res = await agent
      .post('/admin/questions')
      .type('form')
      .send({ _csrf: t, type: 'sql', stem_html: '<p>Broken</p>', payload: JSON.stringify({ ...SQL_Q, solution_sql: 'SELECT x FROM hosts' }), category_id: catId, difficulty: 3, est_time_sec: 60, save_action: 'draft' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('model solution failed');
  });
});
