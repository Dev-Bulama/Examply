'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const settings = require('../../src/services/settings');
const qrepo = require('../../src/services/questions/repository');
const examsRepo = require('../../src/services/exams/repository');
const commerce = require('../../src/services/commerce');
const paystack = require('../../src/services/commerce/paystack');

const SECRET = 'sk_test_' + 'a1b2c3d4e5f6';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const stamp = Date.now();
let app;
let admin;
let adminAgent;
let exam;
let examProduct;
let attemptsProduct;
let spy;
const charges = new Map(); // reference → { status, amount }

const sign = (body) => crypto.createHmac('sha512', SECRET).update(body).digest('hex');

async function candidate() {
  const u = await createUser({ roles: ['candidate'] });
  return { user: await db()('users').where({ id: u.id }).first(), agent: await login(app, { email: u.email }) };
}

async function buy(agent, slug, body = {}) {
  const t = await csrf(agent, `/checkout/${slug}`);
  return agent.post(`/checkout/${slug}`).type('form').send({ _csrf: t, method: 'paystack', ...body });
}

beforeAll(async () => {
  app = await bootApp();
  const a = await createUser({ roles: ['super_admin'] });
  admin = await db()('users').where({ id: a.id }).first();
  const { secret } = await enable2fa(a.id);
  adminAgent = await login(app, { email: a.email, totpSecret: secret });
  await settings.setMany({ 'payments.paystack_enabled': true, 'payments.paystack_mode': 'test', 'payments.paystack_secret_key': SECRET, 'payments.bank_enabled': true, 'payments.bank_name': 'Test Bank', 'payments.bank_account_name': 'Skillscore Ltd', 'payments.bank_account_number': '0123456789' });
  const [catId] = await db()('categories').insert({ name: `Shop ${stamp}`, slug: `shop-${stamp}` });
  const user = { id: admin.id, can: () => true };
  const q = await qrepo.saveQuestion({ meta: { category_id: catId, difficulty: 2, est_time_sec: 60 }, authoring: { type: 'true_false', stem_html: `<p>Paid question ${stamp}</p>`, correct: true }, tags: [], user, status: 'published' });
  const id = await examsRepo.createExam({ title: `Paid exam ${stamp}`, type: 'practice', category_id: catId, user });
  await examsRepo.saveTab(id, 'attempts', { is_paid: '1', price: '5000', max_attempts: '1', allow_buy_attempts: '1', extra_attempt_price: '1000', visibility: 'public', score_policy: 'best' }, user);
  await examsRepo.addQuestions(id, [q.id]);
  await examsRepo.publish(id, user);
  exam = await db()('exams').where({ id }).first();
  examProduct = await db()('products').where({ exam_id: id, type: 'exam' }).first();
  attemptsProduct = await db()('products').where({ exam_id: id, type: 'attempts' }).first();
  spy = jest.spyOn(paystack.api, 'call').mockImplementation(async (method, path, body) => {
    if (path === '/transaction/initialize') {
      charges.set(body.reference, { status: 'success', amount: body.amount, currency: body.currency });
      return { authorization_url: `https://checkout.paystack.com/${body.reference}`, access_code: 'ac_test' };
    }
    const ref = decodeURIComponent(path.split('/').pop());
    const c = charges.get(ref);
    return { reference: ref, status: c.status, amount: c.amount, currency: c.currency, channel: 'card' };
  });
});

afterAll(async () => {
  spy.mockRestore();
  await settings.setMany({ 'payments.paystack_enabled': false, 'payments.paystack_secret_key': '', 'payments.bank_enabled': false });
  await closeAll(app);
});

describe('products', () => {
  test('a paid exam gets an exam product and an extra-attempt product automatically', () => {
    expect(examProduct).toMatchObject({ price_kobo: 500000, is_active: 1 });
    expect(attemptsProduct).toMatchObject({ price_kobo: 100000, quantity: 1, is_active: 1 });
  });

  test('the exam page offers “Buy now” instead of Start', async () => {
    const { agent } = await candidate();
    const page = await agent.get(`/exams/${exam.slug}`);
    expect(page.text).toContain(`/checkout/${examProduct.slug}`);
    expect(page.text).toContain('Buy now');
  });
});

describe('Paystack', () => {
  test('checkout → Paystack → callback verifies → access granted; coupon applied', async () => {
    await db()('coupons').insert({ code: `SAVE20-${stamp}`, discount_type: 'percent', value: 20, is_active: true });
    const { agent, user } = await candidate();
    const res = await buy(agent, examProduct.slug, { coupon: `save20-${stamp}` });
    expect(res.headers.location).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    const order = await db()('orders').where({ user_id: user.id }).first();
    expect(order).toMatchObject({ status: 'pending', subtotal_kobo: 500000, discount_kobo: 100000, total_kobo: 400000 });
    const pay = await db()('payments').where({ order_id: order.id }).first();
    const cb = await agent.get(`/payments/paystack/callback?reference=${pay.reference}`);
    expect(cb.headers.location).toBe(`/my/orders/${order.order_no}`);
    expect((await db()('orders').where({ id: order.id }).first()).status).toBe('paid');
    expect(await db()('entitlements').where({ user_id: user.id, product_id: examProduct.id }).first()).toBeTruthy();
    expect((await db()('coupons').where({ code: `SAVE20-${stamp}` }).first()).used_count).toBe(1);
    expect(await db()('jobs').where('type', 'email.send').whereRaw('payload LIKE ?', [`%${order.order_no}%`]).first()).toBeTruthy();
    // Now they can start the exam; buying again is refused.
    const t = await csrf(agent, `/exams/${exam.slug}`);
    expect((await agent.post(`/exams/${exam.slug}/start`).type('form').send({ _csrf: t, accept: '1' })).headers.location).toMatch(/^\/attempts\//);
    expect((await buy(agent, examProduct.slug)).headers.location).toBe(`/checkout/${examProduct.slug}`);
    expect((await agent.get(`/my/orders/${order.order_no}.pdf`)).headers['content-type']).toBe('application/pdf');
  });

  test('webhook: valid signature fulfils once; duplicates are ignored; tampered signatures are rejected', async () => {
    const { agent, user } = await candidate();
    await buy(agent, examProduct.slug);
    const order = await db()('orders').where({ user_id: user.id }).first();
    const pay = await db()('payments').where({ order_id: order.id }).first();
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: pay.reference, status: 'success', amount: order.total_kobo, currency: 'NGN', channel: 'bank' } }));
    const send = (b, sig) => request(app).post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(b.toString());

    const bad = await send(body, sign(Buffer.from('tampered')));
    expect(bad.status).toBe(401);
    expect((await db()('orders').where({ id: order.id }).first()).status).toBe('pending');

    const ok = await send(body, sign(body));
    expect(ok.body.outcome).toBe('processed');
    const dup = await send(body, sign(body));
    expect(dup.body.outcome).toBe('duplicate');
    expect(await db()('entitlements').where({ user_id: user.id, product_id: examProduct.id }).count({ n: '*' })).toEqual([{ n: 1 }]);
    expect((await db()('payments').where({ id: pay.id }).first()).channel).toBe('bank');
    // The callback afterwards is harmless.
    await agent.get(`/payments/paystack/callback?reference=${pay.reference}`);
    expect(await db()('entitlements').where({ user_id: user.id, product_id: examProduct.id }).count({ n: '*' })).toEqual([{ n: 1 }]);
    expect(await db()('webhook_events').where({ reference: pay.reference, outcome: 'rejected' }).first()).toBeTruthy();
  });

  test('an underpaid charge is not accepted', async () => {
    const { agent, user } = await candidate();
    await buy(agent, examProduct.slug);
    const order = await db()('orders').where({ user_id: user.id }).first();
    const pay = await db()('payments').where({ order_id: order.id }).first();
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: pay.reference, status: 'success', amount: 100, currency: 'NGN' } }));
    await request(app).post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sign(body)).send(body.toString());
    expect((await db()('orders').where({ id: order.id }).first()).status).toBe('pending');
    expect((await db()('payments').where({ id: pay.id }).first()).status).toBe('failed');
  });

  test('extra attempts can be bought once the limit is reached', async () => {
    const { agent, user } = await candidate();
    await db()('entitlements').insert({ user_id: user.id, product_id: examProduct.id, starts_at: new Date(), source: 'admin' });
    let t = await csrf(agent, `/exams/${exam.slug}`);
    const uuid = (await agent.post(`/exams/${exam.slug}/start`).type('form').send({ _csrf: t, accept: '1' })).headers.location.split('/').pop();
    t = await csrf(agent, `/attempts/${uuid}`);
    await agent.post(`/attempts/${uuid}/submit`).type('form').send({ _csrf: t });
    expect((await agent.get(`/exams/${exam.slug}`)).text).toContain('Buy another attempt');
    await buy(agent, attemptsProduct.slug, { quantity: '2' });
    const order = await db()('orders').where({ user_id: user.id }).orderBy('id', 'desc').first();
    expect(order.total_kobo).toBe(200000);
    const pay = await db()('payments').where({ order_id: order.id }).first();
    await agent.get(`/payments/paystack/callback?reference=${pay.reference}`);
    expect(await db()('exam_attempt_overrides').where({ user_id: user.id, exam_id: exam.id, source: 'purchase' }).first()).toMatchObject({ extra_attempts: 2 });
  });
});

describe('bank transfer', () => {
  test('order → receipt upload → admin confirms → access; refunds remove access', async () => {
    const { agent, user } = await candidate();
    const res = await buy(agent, examProduct.slug, { method: 'bank_transfer' });
    const order = await db()('orders').where({ user_id: user.id }).first();
    expect(res.headers.location).toBe(`/my/orders/${order.order_no}`);
    expect(order.status).toBe('awaiting_transfer');
    const page = await agent.get(`/my/orders/${order.order_no}`);
    expect(page.text).toContain('0123456789');
    const t = await csrf(agent, `/my/orders/${order.order_no}`);
    await agent.post(`/my/orders/${order.order_no}/transfer?_csrf=${encodeURIComponent(t)}`).field('transfer_reference', 'GTB-998877').attach('proof', PNG, 'receipt.png');
    const submitted = await db()('orders').where({ id: order.id }).first();
    expect(submitted.transfer_proof_path).toMatch(/\.png$/);
    // Other candidates cannot see it.
    const other = await candidate();
    expect((await other.agent.get(`/my/orders/${order.order_no}`)).status).toBe(404);
    // Admin sends it back, then confirms.
    let ta = await csrf(adminAgent, `/admin/orders/${order.id}`);
    await adminAgent.post(`/admin/orders/${order.id}/reject`).type('form').send({ _csrf: ta, note: 'Amount does not match' });
    expect((await agent.get(`/my/orders/${order.order_no}`)).text).toContain('Amount does not match');
    expect((await adminAgent.get(`/admin/orders/${order.id}/proof`)).status).toBe(200);
    ta = await csrf(adminAgent, `/admin/orders/${order.id}`);
    await adminAgent.post(`/admin/orders/${order.id}/approve`).type('form').send({ _csrf: ta });
    expect((await db()('orders').where({ id: order.id }).first()).status).toBe('paid');
    const ent = await db()('entitlements').where({ user_id: user.id, product_id: examProduct.id }).first();
    expect(ent.revoked_at).toBeNull();
    ta = await csrf(adminAgent, `/admin/orders/${order.id}`);
    await adminAgent.post(`/admin/orders/${order.id}/refund`).type('form').send({ _csrf: ta, reason: 'Duplicate purchase' });
    expect((await db()('orders').where({ id: order.id }).first()).status).toBe('refunded');
    expect((await db()('entitlements').where({ id: ent.id }).first()).revoked_at).not.toBeNull();
    expect(await db()('audit_logs').where({ action: 'order.refund', entity_id: order.id }).first()).toBeTruthy();
  });

  test('stale unpaid transfer orders expire', async () => {
    const { user } = await candidate();
    const o = await commerce.createOrder(user, examProduct.id, { method: 'bank_transfer' });
    await db()('orders').where({ id: o.id }).update({ expires_at: new Date(Date.now() - 1000) });
    await commerce.expireStaleOrders();
    expect((await db()('orders').where({ id: o.id }).first()).status).toBe('cancelled');
  });
});

describe('coupons', () => {
  test('validation rules', async () => {
    const { user } = await candidate();
    const line = [{ product_id: examProduct.id, total_kobo: 500000 }];
    await db()('coupons').insert([
      { code: `OLD-${stamp}`, discount_type: 'percent', value: 10, is_active: true, expires_at: new Date(Date.now() - 1000) },
      { code: `ONLYPLAN-${stamp}`, discount_type: 'percent', value: 10, is_active: true, product_ids: JSON.stringify([999999]) },
      { code: `BIG-${stamp}`, discount_type: 'fixed', value: 100000, is_active: true, min_order_kobo: 900000 },
      { code: `FIXED-${stamp}`, discount_type: 'fixed', value: 9900000, is_active: true },
    ]);
    await expect(commerce.applyCoupon(`OLD-${stamp}`, user, line)).rejects.toThrow(/expired/);
    await expect(commerce.applyCoupon(`ONLYPLAN-${stamp}`, user, line)).rejects.toThrow(/does not apply/);
    await expect(commerce.applyCoupon(`BIG-${stamp}`, user, line)).rejects.toThrow(/at least/);
    await expect(commerce.applyCoupon('NOPE', user, line)).rejects.toThrow(/not valid/);
    expect((await commerce.applyCoupon(`fixed-${stamp}`, user, line)).discount).toBe(500000); // never more than the price
  });

  test('a 100% discount is fulfilled immediately as a free order', async () => {
    await db()('coupons').insert({ code: `FREE-${stamp}`, discount_type: 'percent', value: 100, is_active: true, max_uses_per_user: 1 });
    const { agent, user } = await candidate();
    const res = await buy(agent, examProduct.slug, { coupon: `FREE-${stamp}` });
    const order = await db()('orders').where({ user_id: user.id }).first();
    expect(res.headers.location).toBe(`/my/orders/${order.order_no}`);
    expect(order).toMatchObject({ status: 'paid', payment_method: 'free', total_kobo: 0 });
    await expect(commerce.applyCoupon(`FREE-${stamp}`, user, [{ product_id: examProduct.id, total_kobo: 1 }])).rejects.toThrow(/already used/);
  });
});

describe('company plans', () => {
  test('buying a plan creates the company, its manager, a subscription and an organisation entitlement', async () => {
    const plan = await db()('products').where({ type: 'plan' }).first();
    const [planId] = plan ? [plan.id] : await db()('products').insert({ type: 'plan', name: 'Test plan', slug: `plan-test-${stamp}`, price_kobo: 2500000, plan_interval: 'monthly', audience: 'organisation', is_active: true });
    const p = await db()('products').where({ id: planId }).first();
    const { agent, user } = await candidate();
    expect((await buy(agent, p.slug, {})).headers.location).toBe(`/checkout/${p.slug}`); // company name required
    await buy(agent, p.slug, { organisation_name: `Acme Data ${stamp}` });
    const order = await db()('orders').where({ user_id: user.id }).first();
    const pay = await db()('payments').where({ order_id: order.id }).first();
    await agent.get(`/payments/paystack/callback?reference=${pay.reference}`);
    const org = await db()('organisations').where({ name: `Acme Data ${stamp}` }).first();
    expect(await db()('organisation_users').where({ organisation_id: org.id, user_id: user.id }).first()).toMatchObject({ role: 'manager' });
    const sub = await db()('subscriptions').where({ organisation_id: org.id }).first();
    expect(sub.status).toBe('active');
    expect(new Date(sub.current_period_end) > new Date(Date.now() + 27 * 86400000)).toBe(true);
    expect((await commerce.activePlanFor(org.id)).product_id).toBe(planId);
  });
});

describe('admin', () => {
  test('pages, grant, and permissions', async () => {
    for (const u of ['/admin/orders', '/admin/products', '/admin/coupons', '/admin/coupons/new', '/admin/products/new?type=plan', '/admin/orders/grant', '/pricing']) expect([u, (await adminAgent.get(u)).status]).toEqual([u, 200]);
    const { user, agent } = await candidate();
    const t = await csrf(adminAgent, '/admin/orders/grant');
    await adminAgent.post('/admin/orders/grant').type('form').send({ _csrf: t, email: user.email, product_id: examProduct.id, reason: 'Scholarship award' });
    expect(await db()('entitlements').where({ user_id: user.id, product_id: examProduct.id }).first()).toBeTruthy();
    expect((await agent.get('/admin/orders')).status).toBe(403);
  });

  test('payment settings validate Paystack keys', async () => {
    const t = await csrf(adminAgent, '/admin/settings/payments');
    await adminAgent.post('/admin/settings/payments').type('form').send({ _csrf: t, 'payments.paystack_mode': 'live', 'payments.paystack_public_key': 'pk_test_abc123', 'payments.bank_account_number': '12345' });
    const page = await adminAgent.get('/admin/settings/payments');
    expect(page.text).toContain('This is not a live key');
    expect(page.text).toContain('10 digits');
  });
});
