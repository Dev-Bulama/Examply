'use strict';

const request = require('supertest');
const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const { parseJson } = require('../../src/utils/json');

let app;
let admin;
let cats;
let cert;

async function adminAgent() {
  const u = await createUser({ roles: ['admin'] });
  const { secret } = await enable2fa(u.id);
  return { user: u, agent: await login(app, { email: u.email, totpSecret: secret }) };
}

/** Posts the question editor form. */
async function postQuestion(agent, { url = '/admin/questions', type, stem, payload, meta = {}, action = 'draft', extra = {} }) {
  const t = await csrf(agent, '/admin/questions/new?type=single_choice');
  return agent
    .post(url)
    .type('form')
    .send({
      _csrf: t,
      type,
      stem_html: stem,
      explanation_html: '<p>Because.</p>',
      payload: JSON.stringify(payload),
      category_id: meta.category_id ?? cats.child,
      certification_id: meta.certification_id ?? '',
      domain_id: meta.domain_id ?? '',
      difficulty: meta.difficulty ?? 3,
      est_time_sec: 60,
      marks: 1,
      tags: meta.tags ?? '',
      save_action: action,
      ...extra,
    });
}

const mcq = (correct = 1) => ({ options: ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((text, i) => ({ text, correct: i === correct })) });

beforeAll(async () => {
  app = await bootApp();
  admin = await adminAgent();
  const stamp = Date.now();
  const [parent] = await db()('categories').insert({ name: `Parent ${stamp}`, slug: `parent-${stamp}` });
  const [child] = await db()('categories').insert({ name: `Child ${stamp}`, slug: `child-${stamp}`, parent_id: parent });
  const [other] = await db()('categories').insert({ name: `Other ${stamp}`, slug: `other-${stamp}` });
  cats = { parent, child, other };
  const [certId] = await db()('certifications').insert({ name: `Cert ${stamp}`, slug: `cert-${stamp}`, category_id: parent });
  const [d1] = await db()('certification_domains').insert({ certification_id: certId, name: 'Domain one', weight_percent: 60 });
  const [d2] = await db()('certification_domains').insert({ certification_id: certId, name: 'Domain two', weight_percent: 40 });
  cert = { id: certId, d1, d2 };
});
afterAll(() => closeAll(app));

describe('creating questions', () => {
  test('creates, publishes and previews a question without leaking the answer key', async () => {
    const res = await postQuestion(admin.agent, { type: 'single_choice', stem: '<p>Pick Bravo <script>alert(1)</script></p>', payload: mcq(1), meta: { certification_id: cert.id, domain_id: cert.d1, tags: 'alpha, beta' }, action: 'publish' });
    expect(res.status).toBe(302);
    const id = Number(res.headers.location.split('/').pop());
    const q = await db()('questions').where({ id }).first();
    expect(q).toMatchObject({ status: 'published', certification_id: cert.id, domain_id: cert.d1, author_id: admin.user.id });
    const v = await db()('question_versions').where({ id: q.current_version_id }).first();
    expect(v.stem_html).not.toContain('<script');
    expect(v.published_at).not.toBeNull();
    const tags = await db()('question_tags as qt').join('tags as t', 't.id', 'qt.tag_id').where('qt.question_id', id).pluck('t.name');
    expect(tags.sort()).toEqual(['alpha', 'beta']);
    // The candidate preview markup carries no correctness data.
    const page = await admin.agent.get(`/admin/questions/${id}`);
    const preview = page.text.split('Candidate preview')[1].split('Answer key')[0];
    expect(preview).toContain('Bravo');
    expect(preview).not.toMatch(/is_correct|data-correct|✔/);
  });

  test('every problem is reported at once and the form keeps the input (422)', async () => {
    const res = await postQuestion(admin.agent, { type: 'fill_blank', stem: '<p>Port [[1]] and [[3]]</p>', payload: { blanks: [{ variants: [] }] }, meta: { category_id: '' } });
    expect(res.status).toBe(422);
    for (const msg of ['Choose a category.', 'Blank [[2]] is missing from the question text', 'The question text has 3 blanks but 1 answer is defined.', 'Blank 1 needs at least one accepted answer.']) expect(res.text).toContain(msg);
    expect(res.text).toContain('Port [[1]] and [[3]]');
  });

  test('a domain must belong to the chosen certification', async () => {
    const [otherCert] = await db()('certifications').insert({ name: `X ${Date.now()}`, slug: `x-${Date.now()}`, category_id: cats.parent });
    const res = await postQuestion(admin.agent, { type: 'single_choice', stem: '<p>Q</p>', payload: mcq(), meta: { certification_id: otherCert, domain_id: cert.d1 } });
    expect(res.status).toBe(422);
    expect(res.text).toContain('That domain belongs to a different certification.');
  });

  test('all auto-marked types can be created through the editor', async () => {
    const media = await admin.agent
      .post(`/admin/questions/media?_csrf=${encodeURIComponent(await csrf(admin.agent, '/admin/questions'))}`)
      .attach('file', Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000000c4944415408d763f8ffff3f0005fe02fea7d6a4510000000049454e44ae426082', 'hex'), 'x.png');
    expect(media.status).toBe(200);
    expect(media.body.width).toBe(2);
    const payloads = {
      multiple_response: { options: [{ text: 'a', correct: true }, { text: 'b', correct: true }, { text: 'c' }], select_exact: 2 },
      true_false: { correct: true },
      fill_blank: { blanks: [{ variants: ['x', 'y'] }] },
      numeric: { value: 3.14, tolerance: 0.01, units: 'rad' },
      matching: { pairs: [{ left: 'l1', right: 'r1' }, { left: 'l2', right: 'r2' }], distractors: ['r3'] },
      ordering: { items: ['one', 'two', 'three'] },
      hotspot: { image: media.body.uuid, regions: [{ label: 'A', x: 0, y: 0, w: 40, h: 40, correct: true }, { label: 'B', x: 50, y: 50, w: 40, h: 40 }] },
      short_answer: { keywords: [{ terms: ['acid'], weight: 1 }], threshold: 1 },
      essay: { min_words: 10, max_words: 100 },
    };
    for (const [type, payload] of Object.entries(payloads)) {
      const res = await postQuestion(admin.agent, { type, stem: type === 'fill_blank' ? `<p>${type} [[1]] ${Date.now()}</p>` : `<p>${type} ${Date.now()}</p>`, payload });
      expect([type, res.status]).toEqual([type, 302]);
    }
    // the image is served to signed-in users only
    expect((await admin.agent.get(media.body.url)).status).toBe(200);
    expect((await request(app).get(media.body.url)).status).toBe(302);
  });

  test('rejects non-image uploads', async () => {
    const t = await csrf(admin.agent, '/admin/questions');
    const res = await admin.agent.post(`/admin/questions/media?_csrf=${encodeURIComponent(t)}`).attach('file', Buffer.from('<?php echo 1; ?>'), 'evil.png');
    expect(res.status).toBe(400);
  });
});

describe('versioning', () => {
  test('editing a draft updates in place; editing a published question creates a new version', async () => {
    const created = await postQuestion(admin.agent, { type: 'single_choice', stem: `<p>Versioned ${Date.now()}</p>`, payload: mcq(0) });
    const id = Number(created.headers.location.split('/').pop());
    await postQuestion(admin.agent, { url: `/admin/questions/${id}`, type: 'single_choice', stem: '<p>Versioned draft edit</p>', payload: mcq(0), action: 'save' });
    expect(await db()('question_versions').where({ question_id: id }).count('* as n').first()).toEqual({ n: 1 });

    const t = await csrf(admin.agent, `/admin/questions/${id}`);
    await admin.agent.post(`/admin/questions/${id}/transition/publish`).type('form').send({ _csrf: t });
    const v1 = (await db()('questions').where({ id }).first()).current_version_id;

    const edit = await postQuestion(admin.agent, { url: `/admin/questions/${id}`, type: 'single_choice', stem: '<p>Versioned published edit</p>', payload: mcq(2), action: 'save', extra: { change_note: 'Changed key' } });
    expect(edit.status).toBe(302);
    const q = await db()('questions').where({ id }).first();
    expect(q.version).toBe(2);
    expect(q.status).toBe('published');
    expect(q.current_version_id).not.toBe(v1);
    // Version 1 is untouched (past attempts keep it).
    const old = await db()('question_answers').where({ question_version_id: v1 }).first();
    expect(parseJson(old.answer)).toEqual({ correct: ['A'] });
    const now = await db()('question_answers').where({ question_version_id: q.current_version_id }).first();
    expect(parseJson(now.answer)).toEqual({ correct: ['C'] });
    expect((await admin.agent.get(`/admin/questions/${id}/versions/${v1}`)).status).toBe(200);
  });

  test('the type of a published question is locked', async () => {
    const created = await postQuestion(admin.agent, { type: 'true_false', stem: `<p>Lock ${Date.now()}</p>`, payload: { correct: true }, action: 'publish' });
    const id = Number(created.headers.location.split('/').pop());
    const res = await postQuestion(admin.agent, { url: `/admin/questions/${id}`, type: 'single_choice', stem: '<p>Lock</p>', payload: mcq(), action: 'save' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Type is locked after publishing.');
  });
});

describe('review workflow and author scope', () => {
  test('author writes in assigned categories only; reviewer approves or sends back with a note', async () => {
    const author = await createUser({ roles: ['question_author'] });
    const authorAgent = await login(app, { email: author.email });
    // No categories assigned → cannot start a question.
    expect((await authorAgent.get('/admin/questions/new?type=single_choice')).headers.location).toBe('/admin/questions');
    await db()('author_categories').insert({ user_id: author.id, category_id: cats.parent });
    // Sub-categories of an assigned category are allowed; others are not.
    const outside = await postQuestion(authorAgent, { type: 'single_choice', stem: `<p>Outside ${Date.now()}</p>`, payload: mcq(), meta: { category_id: cats.other } });
    expect(outside.status).toBe(422);
    expect(outside.text).toContain('Choose one of the categories assigned to you.');
    const ok = await postQuestion(authorAgent, { type: 'single_choice', stem: `<p>Inside ${Date.now()}</p>`, payload: mcq(), meta: { category_id: cats.child }, action: 'submit' });
    expect(ok.status).toBe(302);
    const id = Number(ok.headers.location.split('/').pop());
    expect((await db()('questions').where({ id }).first()).status).toBe('in_review');
    // The author cannot publish or edit while in review.
    let t = await csrf(authorAgent, `/admin/questions/${id}`);
    await authorAgent.post(`/admin/questions/${id}/transition/publish`).type('form').send({ _csrf: t });
    expect((await db()('questions').where({ id }).first()).status).toBe('in_review');
    expect((await authorAgent.get(`/admin/questions/${id}/edit`)).headers.location).toBe(`/admin/questions/${id}`);

    const reviewer = await createUser({ roles: ['reviewer'] });
    const revAgent = await login(app, { email: reviewer.email });
    t = await csrf(revAgent, `/admin/questions/${id}`);
    await revAgent.post(`/admin/questions/${id}/transition/reject`).type('form').send({ _csrf: t, note: '' });
    expect((await db()('questions').where({ id }).first()).status).toBe('in_review'); // note required
    await revAgent.post(`/admin/questions/${id}/transition/reject`).type('form').send({ _csrf: t, note: 'Option C is ambiguous.' });
    let q = await db()('questions').where({ id }).first();
    expect(q).toMatchObject({ status: 'draft', reviewer_id: reviewer.id, review_note: 'Option C is ambiguous.' });
    // Author fixes and resubmits; reviewer approves.
    const fix = await postQuestion(authorAgent, { url: `/admin/questions/${id}`, type: 'single_choice', stem: '<p>Inside, fixed</p>', payload: mcq(), action: 'submit' });
    expect(fix.status).toBe(302);
    t = await csrf(revAgent, `/admin/questions/${id}`);
    await revAgent.post(`/admin/questions/${id}/transition/approve`).type('form').send({ _csrf: t });
    q = await db()('questions').where({ id }).first();
    expect(q.status).toBe('published');
    // Authors cannot edit published questions.
    expect((await authorAgent.get(`/admin/questions/${id}/edit`)).headers.location).toBe(`/admin/questions/${id}`);
  });

  test('publishing a case study publishes its children', async () => {
    const cs = await postQuestion(admin.agent, { type: 'case_study', stem: `<p>Scenario ${Date.now()}</p>`, payload: {} });
    const csId = Number(cs.headers.location.split('/').pop());
    const child = await postQuestion(admin.agent, { type: 'single_choice', stem: `<p>Child ${Date.now()}</p>`, payload: mcq(), extra: { parent_id: csId } });
    expect(child.headers.location).toBe(`/admin/questions/${csId}`);
    const t = await csrf(admin.agent, `/admin/questions/${csId}`);
    await admin.agent.post(`/admin/questions/${csId}/transition/publish`).type('form').send({ _csrf: t });
    const kids = await db()('questions').where({ parent_id: csId });
    expect(kids.map((k) => k.status)).toEqual(['published']);
    // Children are hidden from the main list but visible on the case study.
    const page = await admin.agent.get(`/admin/questions/${csId}`);
    expect(page.text).toContain('Question 1');
  });
});

describe('list, bulk actions and duplicates', () => {
  test('filters by category tree, certification, status and full-text search', async () => {
    const word = `zebracrossing${Date.now()}`;
    await postQuestion(admin.agent, { type: 'single_choice', stem: `<p>The ${word} question</p>`, payload: mcq(), meta: { certification_id: cert.id, domain_id: cert.d2 } });
    const byParent = await admin.agent.get(`/admin/questions?category=${cats.parent}&q=${word}`);
    expect(byParent.text).toContain(word);
    const byOther = await admin.agent.get(`/admin/questions?category=${cats.other}&q=${word}`);
    expect(byOther.text).not.toContain(`The ${word}`);
    expect((await admin.agent.get(`/admin/questions?certification=${cert.id}&domain=${cert.d2}&status=draft`)).text).toContain(word);
  });

  test('bulk publish, add tags, move and delete', async () => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await postQuestion(admin.agent, { type: 'true_false', stem: `<p>Bulk ${i} ${Date.now()}</p>`, payload: { correct: i % 2 === 0 } });
      ids.push(Number(r.headers.location.split('/').pop()));
    }
    const t = await csrf(admin.agent, '/admin/questions');
    await admin.agent.post('/admin/questions/bulk').type('form').send({ _csrf: t, bulk_action: 'publish', ids });
    expect(await db()('questions').whereIn('id', ids).pluck('status')).toEqual(['published', 'published', 'published']);
    await admin.agent.post('/admin/questions/bulk').type('form').send({ _csrf: t, bulk_action: 'add_tags', tags: 'bulk-tag', ids });
    expect(Number((await db()('question_tags as qt').join('tags as t', 't.id', 'qt.tag_id').whereIn('qt.question_id', ids).where('t.slug', 'bulk-tag').count('* as n').first()).n)).toBe(3);
    await admin.agent.post('/admin/questions/bulk').type('form').send({ _csrf: t, bulk_action: 'move_category', category_id: cats.other, ids });
    expect(await db()('questions').whereIn('id', ids).pluck('category_id')).toEqual([cats.other, cats.other, cats.other]);
    await admin.agent.post('/admin/questions/bulk').type('form').send({ _csrf: t, bulk_action: 'delete', ids: [ids[0]] });
    expect((await db()('questions').where({ id: ids[0] }).first()).deleted_at).not.toBeNull();
    const log = await db()('audit_logs').where({ action: 'question.bulk_publish' }).orderBy('id', 'desc').first();
    expect(log.user_id).toBe(admin.user.id);
  });

  test('duplicate finder groups questions that differ only in formatting and option order', async () => {
    const stem = `Duplicate stem ${Date.now()}`;
    await postQuestion(admin.agent, { type: 'single_choice', stem: `<p>${stem}</p>`, payload: { options: [{ text: 'One', correct: true }, { text: 'Two' }] } });
    await postQuestion(admin.agent, { type: 'single_choice', stem: `<div><b>${stem.toUpperCase()}</b></div>`, payload: { options: [{ text: 'two' }, { text: 'ONE', correct: true }] } });
    const page = await admin.agent.get('/admin/questions/duplicates');
    expect(page.text).toContain(stem);
    expect(page.text).toMatch(/2 copies/);
  });
});

describe('catalogue', () => {
  test('categories cannot be moved inside their own sub-tree and in-use categories cannot be deleted', async () => {
    const t = await csrf(admin.agent, '/admin/catalogue/categories');
    // Admin lacks catalogue.manage? No — Admin has it. Moving parent under child must fail.
    const res = await admin.agent.post(`/admin/catalogue/categories/${cats.parent}?_csrf=${encodeURIComponent(t)}`).type('form').send({ name: 'Parent renamed', parent_id: cats.child });
    expect(res.headers.location).toBe(`/admin/catalogue/categories/${cats.parent}/edit`);
    expect((await db()('categories').where({ id: cats.parent }).first()).parent_id).toBeNull();
    await admin.agent.post(`/admin/catalogue/categories/${cats.parent}/delete`).type('form').send({ _csrf: t });
    expect(await db()('categories').where({ id: cats.parent }).first()).toBeTruthy();
  });

  test('certification domains are saved in order; weights over 100% are rejected', async () => {
    const t = await csrf(admin.agent, '/admin/catalogue/certifications/new');
    const name = `Weighted ${Date.now()}`;
    const bad = await admin.agent.post('/admin/catalogue/certifications').type('form').send({ _csrf: t, name, category_id: cats.parent, 'domains[0][name]': 'A', 'domains[0][weight]': '70', 'domains[1][name]': 'B', 'domains[1][weight]': '40' });
    expect(bad.headers.location).toBe('/admin/catalogue/certifications/new');
    expect(await db()('certifications').where({ name }).first()).toBeUndefined();
    const good = await admin.agent.post('/admin/catalogue/certifications').type('form').send({ _csrf: t, name, category_id: cats.parent, exam_code: 'W-1', 'domains[0][code]': 'A', 'domains[0][name]': 'Alpha', 'domains[0][weight]': '70', 'domains[1][code]': 'B', 'domains[1][name]': 'Beta', 'domains[1][weight]': '30' });
    if (good.headers.location !== '/admin/catalogue/certifications') {
      const pg = await admin.agent.get(good.headers.location);
      throw new Error((pg.text.match(/field-error[^>]*>([^<]+)/g) || []).join(' | '));
    }
    const c = await db()('certifications').where({ name }).first();
    const doms = await db()('certification_domains').where({ certification_id: c.id }).orderBy('display_order');
    expect(doms.map((d) => [d.name, Number(d.weight_percent)])).toEqual([['Alpha', 70], ['Beta', 30]]);
    const json = await admin.agent.get(`/admin/catalogue/certifications/${c.id}/domains.json`);
    expect(json.body.domains).toHaveLength(2);
  });

  test('training programme stores a course per band and validates URLs', async () => {
    const t = await csrf(admin.agent, '/admin/catalogue/programmes/new');
    const name = `Bootcamp ${Date.now()}`;
    const bad = await admin.agent.post('/admin/catalogue/programmes').type('form').send({ _csrf: t, name, 'bands[Beginner][course_title]': 'Basics', 'bands[Beginner][course_url]': 'not a url' });
    expect(bad.headers.location).toBe('/admin/catalogue/programmes/new');
    await admin.agent.post('/admin/catalogue/programmes').type('form').send({ _csrf: t, name, levels: 'One\nTwo', 'bands[Beginner][course_title]': 'Basics', 'bands[Beginner][course_url]': 'https://example.com/b', 'bands[Expert][message]': 'Go pro' });
    const p = await db()('training_programmes').where({ name }).first();
    const rows = await db()('programme_bands').where({ programme_id: p.id }).orderBy('display_order');
    expect(rows.map((r) => r.band)).toEqual(['Beginner', 'Intermediate', 'Advanced', 'Expert']);
    expect(rows[0].course_url).toBe('https://example.com/b');
    expect(rows[3].message).toBe('Go pro');
    expect(parseJson(p.levels)).toEqual(['One', 'Two']);
  });
});

describe('reports inbox', () => {
  test('resolves a candidate report', async () => {
    const q = await db()('questions').whereNull('deleted_at').first('id', 'current_version_id');
    const reporter = await createUser();
    const [rid] = await db()('question_reports').insert({ question_id: q.id, question_version_id: q.current_version_id, user_id: reporter.id, reason: 'typo', message: 'Spelling in option B' });
    const page = await admin.agent.get('/admin/questions/reports');
    expect(page.text).toContain('Spelling in option B');
    const t = await csrf(admin.agent, '/admin/questions/reports');
    await admin.agent.post(`/admin/questions/reports/${rid}/resolve`).type('form').send({ _csrf: t, note: 'Fixed in v2' });
    expect(await db()('question_reports').where({ id: rid }).first()).toMatchObject({ status: 'resolved', resolution_note: 'Fixed in v2', resolved_by: admin.user.id });
  });
});
