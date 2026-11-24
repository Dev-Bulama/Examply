'use strict';

const ExcelJS = require('exceljs');
const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const { runDueJobs } = require('../../src/services/jobs/queue');
const { parseJson } = require('../../src/utils/json');

let app;
let agent;
let catPath;
let catId;

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Questions');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function upload(buf, name, fields = {}) {
  const t = await csrf(agent, '/admin/imports/new');
  let req = agent.post(`/admin/imports?_csrf=${encodeURIComponent(t)}`).attach('file', buf, name);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, String(v));
  const res = await req;
  expect(res.status).toBe(302);
  const id = Number(res.headers.location.split('/').pop());
  expect(id).toBeGreaterThan(0);
  await runDueJobs({ limit: 20 });
  return id;
}

beforeAll(async () => {
  app = await bootApp();
  const admin = await createUser({ roles: ['admin'] });
  const { secret } = await enable2fa(admin.id);
  agent = await login(app, { email: admin.email, totpSecret: secret });
  const stamp = Date.now();
  const [parent] = await db()('categories').insert({ name: `Imp ${stamp}`, slug: `imp-${stamp}` });
  [catId] = await db()('categories').insert({ name: `Sub ${stamp}`, slug: `sub-${stamp}`, parent_id: parent });
  catPath = `Imp ${stamp} > Sub ${stamp}`;
});
afterAll(() => closeAll(app));

test('full lifecycle: upload → preview with exact errors → duplicates → confirm → summary → error report → undo', async () => {
  const stamp = Date.now();
  const header = ['type', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'answer', 'explanation', 'category', 'difficulty', 'tags'];
  const buf = await xlsx([
    header,
    ['mcq', `Lifecycle good ${stamp}`, 'w', 'x', 'y', 'z', 'B', 'because', catPath, 'easy', 'imp'],
    ['mcq', `Lifecycle bad key ${stamp}`, 'w', 'x', 'y', 'z', 'E', '', catPath, '3', ''],
    ['tf', `Lifecycle tf ${stamp}`, '', '', '', '', 'TRUE', 'yes', 'No Such Category', '', ''],
    ['mcq', `Lifecycle good ${stamp}`, 'w', 'x', 'y', 'z', 'B', 'because', catPath, '2', ''],
  ]);
  const id = await upload(buf, 'questions.xlsx', { category_id: catId, status: 'published', exam_mode: 'create', exam_title: `Imported exam ${stamp}` });
  let imp = await db()('imports').where({ id }).first();
  expect(imp).toMatchObject({ status: 'parsed', total_rows: 4, error_rows: 1 });

  const rows = await db()('import_rows').where({ import_id: id }).orderBy('row_number');
  const msgs = (r) => parseJson(r.messages, []).map((m) => m.text);
  expect(rows[1].status).toBe('error');
  expect(msgs(rows[1])).toContain("Correct answer 'E' is not among options A–D.");
  expect(msgs(rows[2])).toContain('Category “No Such Category” does not exist — the import default was used.');
  expect(msgs(rows[3])).toContain('Duplicate of Row 2 in this file.');
  expect(rows[3].decision).toBe('skip');

  const page = await agent.get(`/admin/imports/${id}?filter=error`);
  expect(page.text).toContain("Correct answer &#39;E&#39; is not among options A–D.");
  expect(page.text).toContain('Import 2 questions');

  let t = await csrf(agent, `/admin/imports/${id}`);
  await agent.post(`/admin/imports/${id}/confirm`).type('form').send({ _csrf: t });
  await runDueJobs({ limit: 20 });
  imp = await db()('imports').where({ id }).first();
  expect(imp).toMatchObject({ status: 'completed', imported_count: 2, skipped_count: 1, failed_count: 1 });
  expect(imp.error_report_path).toBeTruthy();
  expect(imp.created_exam_id).toBeTruthy();

  const created = await db()('questions').where({ import_id: id });
  expect(created).toHaveLength(2);
  expect(created.every((q) => q.status === 'published' && q.category_id === catId)).toBe(true);
  expect(Number((await db()('exam_questions').where({ exam_id: imp.created_exam_id }).count('* as n').first()).n)).toBe(2);
  const tags = await db()('question_tags as qt').join('tags as tg', 'tg.id', 'qt.tag_id').whereIn('qt.question_id', created.map((q) => q.id)).pluck('tg.name');
  expect(tags).toContain('imp');

  const report = await agent.get(`/admin/imports/${id}/error-report`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(report.body);
  const ws = wb.getWorksheet('Failed rows');
  expect(ws.getRow(2).getCell(1).value).toBe('Row 3');
  expect(String(ws.getRow(2).getCell(2).value)).toContain("'E'");

  // Re-importing the same good question is flagged as an existing duplicate.
  const id2 = await upload(await xlsx([header, ['mcq', `Lifecycle good ${stamp}`, 'w', 'x', 'y', 'z', 'B', 'because', catPath, '1', '']]), 'again.xlsx');
  const dup = await db()('import_rows').where({ import_id: id2 }).first();
  expect(dup.duplicate_of_question_id).toBe(created[0].id);
  expect(dup.decision).toBe('skip');
  t = await csrf(agent, `/admin/imports/${id2}`);
  await agent.post(`/admin/imports/${id2}/decisions`).type('form').send({ _csrf: t, all_duplicates: 'overwrite' });
  await agent.post(`/admin/imports/${id2}/confirm`).type('form').send({ _csrf: t });
  await runDueJobs({ limit: 20 });
  const q = await db()('questions').where({ id: created[0].id }).first();
  expect(q.version).toBe(2);
  expect(q.difficulty).toBe(1);

  // Undo the overwrite → version 1 restored; undo the first import → questions and exam removed.
  t = await csrf(agent, `/admin/imports/${id2}`);
  await agent.post(`/admin/imports/${id2}/undo`).type('form').send({ _csrf: t });
  expect((await db()('questions').where({ id: created[0].id }).first()).version).toBe(1);
  await agent.post(`/admin/imports/${id}/undo`).type('form').send({ _csrf: t });
  expect(await db()('questions').where({ import_id: id })).toHaveLength(0);
  expect(await db()('exams').where({ id: imp.created_exam_id }).first()).toBeUndefined();
  expect((await db()('imports').where({ id }).first()).status).toBe('undone');
});

test('unreadable files fail with a clear message', async () => {
  const id = await upload(Buffer.from('{"not": "questions"}'), 'bad.json');
  const imp = await db()('imports').where({ id }).first();
  expect(imp.status).toBe('failed');
  expect(imp.last_error).toContain('array of questions');
  const page = await agent.get(`/admin/imports/${id}`);
  expect(page.text).toContain('The file could not be imported');
});

test('case studies, GIFT and Word imports', async () => {
  const gift = Buffer.from(`::A:: Which is object storage? {=S3 ~EBS}\n\n::B:: Pi {#3.14:0.01}\n`);
  const id = await upload(gift, 'qs.gift', { category_id: catId });
  expect((await db()('imports').where({ id }).first()).valid_rows + (await db()('imports').where({ id }).first()).warning_rows).toBe(2);

  const header = ['type', 'question', 'option_a', 'option_b', 'answer', 'explanation', 'case_id'];
  const id2 = await upload(await xlsx([header, ['case_study', `Scenario ${Date.now()}`, '', '', '', '', 'CS1'], ['tf', 'Child one', '', '', 'TRUE', 'x', 'CS1'], ['tf', 'Orphan', '', '', 'TRUE', 'x', 'CS9']]), 'case.xlsx', { category_id: catId });
  const rows = await db()('import_rows').where({ import_id: id2 }).orderBy('row_number');
  expect(parseJson(rows[2].messages, []).map((m) => m.text)).toContain('Case “CS9” has no case_study row in this file.');
  const t = await csrf(agent, `/admin/imports/${id2}`);
  await agent.post(`/admin/imports/${id2}/confirm`).type('form').send({ _csrf: t });
  await runDueJobs({ limit: 20 });
  const imported = await db()('import_rows').where({ import_id: id2 }).orderBy('row_number');
  const parent = imported[0].result_question_id;
  expect((await db()('questions').where({ id: imported[1].result_question_id }).first()).parent_id).toBe(parent);

  const { buildDocx } = require('../../src/services/import/docxWriter');
  const id3 = await upload(buildDocx(['1. Word question?', 'A. one', 'B. two', 'Answer: B', 'Explanation: two.']), 'word.docx', { category_id: catId });
  expect((await db()('imports').where({ id: id3 }).first()).total_rows).toBe(1);
});

test('templates download and export is permission-gated', async () => {
  for (const f of ['xlsx', 'csv', 'json', 'aiken', 'gift', 'docx']) {
    const res = await agent.get(`/admin/imports/templates/${f}`);
    expect([f, res.status]).toEqual([f, 200]);
  }
  const exp = await agent.get('/admin/questions/export?format=json&status=published');
  expect(exp.status).toBe(200);
  expect(JSON.parse(exp.text).questions).toBeInstanceOf(Array);
  const author = await createUser({ roles: ['question_author'] });
  const a2 = await login(app, { email: author.email });
  expect((await a2.get('/admin/questions/export?format=json')).status).toBe(403);
  expect((await a2.get('/admin/imports')).status).toBe(403);
});
