'use strict';

const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const { runDueJobs } = require('../../src/services/jobs/queue');
const settings = require('../../src/services/settings');
const providers = require('../../src/services/ai/providers');
const generator = require('../../src/services/ai/generator');
const T = require('../../src/services/questions/types');

const fakeQuestion = (type, n, extra = {}) => ({
  type,
  stem: `Generated ${type} question ${n} ${Date.now()}`,
  options: [],
  blanks: [],
  numeric_value: null,
  tolerance: null,
  units: null,
  pairs: [],
  distractors: [],
  keywords: [],
  threshold: null,
  rubric: null,
  sql: null,
  explanation: 'Because the key is right and the distractors are wrong.',
  reference: null,
  difficulty: 3,
  bloom: 'apply',
  domain: null,
  topic: 'Testing',
  ...extra,
});

describe('generator helpers', () => {
  test('allocates questions across domains by weight and batches them by 20', () => {
    const domains = [
      { id: 1, code: 'D1', name: 'One', weight_percent: 24 },
      { id: 2, code: 'D2', name: 'Two', weight_percent: 30 },
      { id: 3, code: 'D3', name: 'Three', weight_percent: 34 },
      { id: 4, code: 'D4', name: 'Four', weight_percent: 12 },
    ];
    const alloc = generator.allocate(50, domains);
    expect(alloc.reduce((s, a) => s + a.count, 0)).toBe(50);
    expect(alloc.find((a) => a.domain.code === 'D3').count).toBe(17);
    const batches = generator.planBatches(alloc);
    expect(batches.map((b) => b.reduce((s, x) => s + x.count, 0))).toEqual([20, 20, 10]);
    expect(generator.allocate(7, [])).toEqual([{ domain: null, count: 7 }]);
  });

  test('the output schema is strict (every object closed, every property required)', () => {
    const check = (s) => {
      if (s.type === 'object') {
        expect(s.additionalProperties).toBe(false);
        expect(s.required.sort()).toEqual(Object.keys(s.properties).sort());
        Object.values(s.properties).forEach(check);
      }
      if (s.type === 'array') check(s.items);
      if (s.anyOf) s.anyOf.forEach(check);
    };
    check(generator.batchSchema());
  });

  test('maps every generatable type into a valid question', () => {
    const samples = [
      fakeQuestion('single_choice', 1, { options: [{ text: 'a', correct: false }, { text: 'b', correct: true }, { text: 'c', correct: false }] }),
      fakeQuestion('multiple_response', 2, { options: [{ text: 'a', correct: true }, { text: 'b', correct: true }, { text: 'c', correct: false }, { text: 'd', correct: false }] }),
      fakeQuestion('true_false', 3, { options: [{ text: 'True', correct: false }, { text: 'False', correct: true }] }),
      fakeQuestion('fill_blank', 4, { stem: 'Port [[1]] is used by `sshd`.', blanks: [{ variants: ['22'] }] }),
      fakeQuestion('numeric', 5, { numeric_value: 443, tolerance: 0 }),
      fakeQuestion('matching', 6, { pairs: [{ left: 'SSH', right: '22' }, { left: 'HTTPS', right: '443' }], distractors: ['25'] }),
      fakeQuestion('ordering', 7, { options: [{ text: 'Identify', correct: true }, { text: 'Contain', correct: true }, { text: 'Eradicate', correct: true }] }),
      fakeQuestion('short_answer', 8, { keywords: [{ terms: ['least privilege'], weight: 1 }], threshold: 1 }),
      fakeQuestion('essay', 9, { rubric: 'Covers containment (5) and lessons learned (5).' }),
      fakeQuestion('sql', 10, { sql: { mode: 'modify', schema_sql: 'CREATE TABLE t (a INT);', seed_sql: '', starter_sql: '', solution_sql: 'INSERT INTO t VALUES (1)', check_sql: 'SELECT a FROM t', order_matters: false, column_names_matter: false } }),
    ];
    samples.forEach((q, i) => {
      const rec = generator.toRecord(q, i + 1, new Map());
      expect([q.type, T.validate(T.normalise(rec.question)).map((e) => e.message)]).toEqual([q.type, []]);
    });
    expect(generator.toRecord(samples[3], 1, new Map()).question.stem_html).toContain('<code>sshd</code>');
  });

  test('the batch prompt carries coverage, brief, reference and an avoid-list', () => {
    const p = generator.batchPrompt({ spec: { prompt: 'Linux hardening', types: ['single_choice'], difficulty: 'mixed', level: 'Pro', reference: 'NOTES' }, batch: [{ domain: { code: 'D2', name: 'Security' }, count: 5 }], cert: { name: 'Sec+', exam_code: 'SY0' }, avoid: ['Old question'] });
    for (const s of ['Write 5 exam questions.', 'Linux hardening', 'domain D2', '<reference>', 'Old question', 'Sec+ (SY0)']) expect(p).toContain(s);
  });
});

describe('generation flow (fake provider)', () => {
  let app;
  let agent;
  let catId;
  let certId;
  let spy;
  beforeAll(async () => {
    app = await bootApp();
    const admin = await createUser({ roles: ['admin'] });
    const { secret } = await enable2fa(admin.id);
    agent = await login(app, { email: admin.email, totpSecret: secret });
    const stamp = Date.now();
    [catId] = await db()('categories').insert({ name: `AI ${stamp}`, slug: `ai-${stamp}` });
    [certId] = await db()('certifications').insert({ name: `Cyber ${stamp}`, slug: `cyber-${stamp}`, category_id: catId, exam_code: `CY${stamp % 1000}` });
    await db()('certification_domains').insert([
      { certification_id: certId, code: 'NET', name: 'Network security', weight_percent: 50 },
      { certification_id: certId, code: 'IR', name: 'Incident response', weight_percent: 50 },
    ]);
    await settings.setMany({ 'ai.enabled': true, 'ai.anthropic_api_key': 'sk-ant-test-key', 'ai.anthropic_model': 'claude-opus-5-5' });
  });
  afterEach(() => spy && spy.mockRestore());
  afterAll(async () => {
    await settings.setMany({ 'ai.enabled': false, 'ai.anthropic_api_key': '' });
    await closeAll(app);
  });

  test('prompt → background generation → import preview → confirm → questions in an exam', async () => {
    const calls = [];
    spy = jest.spyOn(providers, 'generateJson').mockImplementation(async (provider, args) => {
      calls.push({ provider, args });
      const lines = [...args.prompt.matchAll(/- (\d+) question\(s\) for domain .*?use "([A-Z]+)" as the domain/g)];
      const questions = lines.flatMap(([, n, domain]) => Array.from({ length: Number(n) }, (_, i) => fakeQuestion('single_choice', `${domain}-${i}-${calls.length}`, { domain, options: [{ text: 'Yes', correct: true }, { text: 'No', correct: false }, { text: 'Maybe', correct: false }] })));
      return {
        data: { questions },
        usage: { input: 1000, output: 2000 },
        model: 'claude-opus-5-5',
      };
    });
    const page = await agent.get('/admin/ai/new');
    expect(page.text).toContain('Claude (Anthropic) — claude-opus-5-5');
    const t = await csrf(agent, '/admin/ai/new');
    const res = await agent
      .post('/admin/ai')
      .type('form')
      .send({ _csrf: t, provider: 'anthropic', prompt: 'Scenario questions on network defence and incident response for SOC analysts.', count: '24', types: ['single_choice'], category_id: catId, certification_id: certId, difficulty: 'mixed', level: generator.SYSTEM_PROMPT ? require('../../src/controllers/admin/aiController').LEVELS[0] : '', status: 'published', exam_mode: 'create', exam_title: 'AI SOC exam' });
    expect(res.status).toBe(302);
    const importId = Number(res.headers.location.split('/').pop());
    await runDueJobs({ limit: 200 });

    expect(calls).toHaveLength(2); // 24 questions → batches of 20 + 4
    expect(calls[0].args.schema.properties.questions.type).toBe('array');
    expect(calls[0].args.system).toContain('Original content only');
    let imp = await db()('imports').where({ id: importId }).first();
    expect(imp).toMatchObject({ status: 'parsed', source: 'ai', total_rows: 24 });
    const gen = await db()('ai_generations').where({ import_id: importId }).first();
    expect(gen).toMatchObject({ status: 'completed', generated_count: 24, input_tokens: 2000, output_tokens: 4000 });
    const preview = await agent.get(`/admin/imports/${importId}`);
    expect(preview.text).toContain('AI generation');
    expect(preview.text).toContain('Import 24 questions');

    const t2 = await csrf(agent, `/admin/imports/${importId}`);
    await agent.post(`/admin/imports/${importId}/confirm`).type('form').send({ _csrf: t2 });
    await runDueJobs({ limit: 200 });
    imp = await db()('imports').where({ id: importId }).first();
    expect(imp.imported_count).toBe(24);
    const qs = await db()('questions').where({ import_id: importId });
    expect(qs.every((q) => q.status === 'published' && q.certification_id === certId && q.domain_id)).toBe(true);
    const byDomain = await db()('questions').where({ import_id: importId }).groupBy('domain_id').select('domain_id', db().raw('COUNT(*) as n'));
    expect(byDomain.map((d) => Number(d.n)).sort()).toEqual([12, 12]);
    expect(Number((await db()('exam_questions').where({ exam_id: imp.created_exam_id }).count('* as n').first()).n)).toBe(24);
  });

  test('complete exam: SQL lab questions are verified, settings follow the official format, exam is created as a draft', async () => {
    await db()('certifications').where({ id: certId }).update({ official_duration_minutes: 90, official_question_count: 60, official_passing_score: 750, official_score_scale: '100-900' });
    const sqlQ = (n, solution) =>
      fakeQuestion('sql', `sql-${n}`, {
        domain: 'NET',
        sql: { mode: 'query', schema_sql: 'CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT, open_ports INTEGER);', seed_sql: "INSERT INTO hosts VALUES (1,'web',3),(2,'db',1),(3,'mail',2);", starter_sql: '', solution_sql: solution, check_sql: '', order_matters: false, column_names_matter: false },
      });
    spy = jest.spyOn(providers, 'generateJson').mockImplementation(async (provider, args) => {
      if (!args.schema.properties.questions) {
        return { data: { title: 'SOC Analyst Full Mock', short_description: 'A realistic mock for SOC analysts.', description: 'Covers network defence.\n\nIncludes SQL log analysis.', instructions_note: 'Read each scenario carefully.' }, usage: { input: 10, output: 20 } };
      }
      return { data: { questions: [sqlQ(1, 'SELECT name FROM hosts WHERE open_ports > 1'), sqlQ(2, 'SELECT nope FROM hosts'), fakeQuestion('single_choice', 'mc', { domain: 'IR', options: [{ text: 'Contain', correct: true }, { text: 'Ignore', correct: false }] })] }, usage: { input: 100, output: 200 } };
    });
    expect((await agent.get('/admin/ai/exam')).text).toContain('Generate a complete exam');
    const t = await csrf(agent, '/admin/ai/exam');
    const res = await agent.post('/admin/ai').type('form').send({ _csrf: t, kind: 'exam', provider: 'anthropic', exam_type: 'mock', exam_title: 'SOC mock', prompt: 'A full mock exam for SOC analysts including SQL log analysis tasks.', count: '3', types: ['single_choice', 'sql'], category_id: catId, certification_id: certId, status: 'published', level: require('../../src/controllers/admin/aiController').LEVELS[0] });
    const importId = Number(res.headers.location.split('/').pop());
    await runDueJobs({ limit: 200 });
    const rows = await db()('import_rows').where({ import_id: importId }).orderBy('row_number');
    expect(rows.map((r) => r.status)).toEqual(['valid', 'error', 'valid']);
    expect(JSON.stringify(rows[1].messages)).toContain('model solution failed');
    const preview = await agent.get(`/admin/imports/${importId}`);
    expect(preview.text).toContain('SOC Analyst Full Mock');
    expect(preview.text).toContain('Duration 5 min'.replace('5', '10')); // 1.5 min × 3 → minimum of 10
    expect(preview.text).toContain('on a 100–900 scale');

    const t2 = await csrf(agent, `/admin/imports/${importId}`);
    await agent.post(`/admin/imports/${importId}/confirm`).type('form').send({ _csrf: t2 });
    await runDueJobs({ limit: 200 });
    const imp = await db()('imports').where({ id: importId }).first();
    const exam = await db()('exams').where({ id: imp.created_exam_id }).first();
    expect(exam).toMatchObject({ title: 'SOC Analyst Full Mock', type: 'mock', status: 'draft', duration_minutes: 10, certificate_enabled: 1, short_description: 'A realistic mock for SOC analysts.' });
    expect(Number(exam.pass_mark)).toBe(81.3);
    const s = require('../../src/utils/json').parseJson(exam.settings, {});
    expect(s.scaling).toEqual({ enabled: true, min: 100, max: 900 });
    expect(s.instructions.custom_before).toBe('Read each scenario carefully.');
    expect(exam.description_html).toContain('<p>Includes SQL log analysis.</p>');
    expect((await db()('ai_generations').where({ import_id: importId }).first())).toMatchObject({ kind: 'exam', exam_id: exam.id });
    expect(Number((await db()('exam_questions').where({ exam_id: exam.id }).count('* as n').first()).n)).toBe(2);
    // The exam passes its checklist and publishes.
    const t3 = await csrf(agent, `/admin/exams/${exam.id}/publish`);
    await agent.post(`/admin/exams/${exam.id}/publish`).type('form').send({ _csrf: t3 });
    expect((await db()('exams').where({ id: exam.id }).first()).status).toBe('published');
  });

  test('provider failures are shown, not hidden', async () => {
    spy = jest.spyOn(providers, 'generateJson').mockRejectedValue(new providers.AiError('The Anthropic API key was rejected. Check it in Settings → AI.'));
    const t = await csrf(agent, '/admin/ai/new');
    const res = await agent.post('/admin/ai').type('form').send({ _csrf: t, provider: 'anthropic', prompt: 'Twenty questions about firewalls and IDS tuning please.', count: '3', types: ['true_false'], category_id: catId });
    const importId = Number(res.headers.location.split('/').pop());
    await runDueJobs({ limit: 200 });
    const imp = await db()('imports').where({ id: importId }).first();
    expect(imp.status).toBe('failed');
    expect(imp.last_error).toContain('API key was rejected');
    expect((await db()('ai_generations').where({ import_id: importId }).first()).status).toBe('failed');
  });

  test('validation and permissions', async () => {
    const t = await csrf(agent, '/admin/ai/new');
    await agent.post('/admin/ai').type('form').send({ _csrf: t, provider: 'openai', prompt: 'short', count: '999' });
    const page = await agent.get('/admin/ai/new');
    expect(page.text).toContain('Choose a configured AI provider.');
    expect(page.text).toContain('at least 20 characters');
    const author = await createUser({ roles: ['question_author'] });
    const a2 = await login(app, { email: author.email });
    expect((await a2.get('/admin/ai/new')).status).toBe(403);
  });

  test('the API key is stored encrypted and the settings page never shows it', async () => {
    const row = await db()('settings').where({ key: 'ai.anthropic_api_key' }).first();
    expect(row.value.startsWith('v1:')).toBe(true);
    const sa = await createUser({ roles: ['super_admin'] });
    const { secret } = await enable2fa(sa.id);
    const saAgent = await login(app, { email: sa.email, totpSecret: secret });
    const page = await saAgent.get('/admin/settings/ai');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('sk-ant-test-key');
    expect(page.text).toContain('Test Claude');
  });
});
