'use strict';

/**
 * Commerce: products, coupons, orders, fulfilment and refunds. Money is integer kobo everywhere.
 *
 * Product types and what buying one grants:
 *   exam     → an entitlement to take that exam (for access_days, or for life)
 *   bundle   → an entitlement to the bundle; eligibility treats it as access to every exam inside
 *   attempts → `quantity` extra attempts on its exam (exam_attempt_overrides, source = purchase)
 *   plan     → a company subscription: an organisation (created from the buyer's company name if needed),
 *              the buyer as its manager, and an organisation entitlement for the billing period
 *
 * Fulfilment is idempotent: an order is fulfilled once, whichever of the Paystack callback, the webhook or an
 * admin's bank-transfer approval arrives first.
 */
const crypto = require('crypto');
const { db } = require('../../config/db');
const { toJson, parseJson } = require('../../utils/json');
const { uniqueSlug } = require('../../utils/slug');
const settings = require('../settings');

class CommerceError extends Error {
  constructor(message, status = 422, field = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

const PLAN_MONTHS = { monthly: 1, quarterly: 3, biannually: 6, annually: 12 };
const priceOf = (p) => (p.sale_price_kobo !== null && p.sale_price_kobo !== undefined && p.sale_price_kobo < p.price_kobo ? Number(p.sale_price_kobo) : Number(p.price_kobo));

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

// ---------------------------------------------------------------- Products

/**
 * Keeps the exam's sellable products in step with its settings: an "exam" product while it is paid, and an
 * "attempts" product (one extra attempt) while candidates may buy attempts.
 */
async function syncExamProducts(examId, knex = db()) {
  const e = await knex('exams').where({ id: examId }).first();
  if (!e) return;
  const upsert = async (type, active, fields) => {
    const existing = await knex('products').where({ exam_id: e.id, type }).whereNull('deleted_at').first();
    if (existing) {
      await knex('products').where({ id: existing.id }).update({ ...fields, is_active: active });
      return existing.id;
    }
    if (!active) return null;
    const [id] = await knex('products').insert({ type, exam_id: e.id, slug: await uniqueSlug(knex, 'products', `${type}-${e.slug}`), ...fields, is_active: true });
    return id;
  };
  const live = e.status === 'published' && !e.deleted_at;
  await upsert('exam', live && !!e.is_paid && e.price_kobo > 0, { name: e.title, description: e.short_description, price_kobo: e.price_kobo, sale_price_kobo: e.sale_price_kobo, currency: e.currency, access_days: e.access_days });
  await upsert('attempts', live && !!e.allow_buy_attempts && Number(e.extra_attempt_price_kobo) > 0, { name: `Extra attempt — ${e.title}`, price_kobo: e.extra_attempt_price_kobo || 0, quantity: 1, currency: e.currency });
}

async function getProduct(id, knex = db()) {
  const p = await knex('products').where({ id }).whereNull('deleted_at').first();
  if (!p || !p.is_active) throw new CommerceError('This product is not available.', 404);
  return { ...p, features: parseJson(p.features, []), limits: parseJson(p.limits, {}) };
}

/** What a bundle contains (for display and eligibility). */
async function bundleContents(bundleId, knex = db()) {
  return knex('product_items as pi').join('products as p', 'p.id', 'pi.product_id').leftJoin('exams as e', 'e.id', 'p.exam_id').where('pi.bundle_product_id', bundleId).select('p.id', 'p.name', 'p.type', 'p.price_kobo', 'e.slug as exam_slug', 'e.title as exam_title');
}

// ---------------------------------------------------------------- Coupons

/** Validates a coupon for a user and a list of order lines. Returns { coupon, discount } or throws. */
async function applyCoupon(code, user, lines, knex = db(), now = new Date()) {
  const c = await knex('coupons').where({ code: String(code || '').trim().toUpperCase() }).first();
  const fail = (m) => {
    throw new CommerceError(m, 422, 'coupon');
  };
  if (!c || !c.is_active) fail('That coupon code is not valid.');
  if (c.starts_at && new Date(c.starts_at) > now) fail('That coupon is not active yet.');
  if (c.expires_at && new Date(c.expires_at) <= now) fail('That coupon has expired.');
  if (c.max_uses !== null && c.used_count >= c.max_uses) fail('That coupon has been fully used.');
  if (c.max_uses_per_user !== null) {
    const [{ n }] = await knex('coupon_redemptions').where({ coupon_id: c.id, user_id: user.id }).count({ n: '*' });
    if (Number(n) >= c.max_uses_per_user) fail('You have already used this coupon.');
  }
  const allowed = parseJson(c.product_ids, null);
  const eligible = allowed && allowed.length ? lines.filter((l) => allowed.includes(l.product_id)) : lines;
  if (!eligible.length) fail('That coupon does not apply to this item.');
  const base = eligible.reduce((s, l) => s + l.total_kobo, 0);
  const subtotal = lines.reduce((s, l) => s + l.total_kobo, 0);
  if (c.min_order_kobo && subtotal < c.min_order_kobo) fail(`That coupon needs an order of at least ₦${(c.min_order_kobo / 100).toLocaleString('en-NG')}.`);
  const discount = c.discount_type === 'percent' ? Math.round((base * Math.min(100, c.value)) / 100) : Math.min(base, c.value);
  return { coupon: c, discount };
}

// ---------------------------------------------------------------- Orders

function orderNo() {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `SS-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * Creates an order for one product (quantity for attempt packs). method: paystack | bank_transfer.
 * A zero total is fulfilled immediately as a free order.
 */
async function createOrder(user, productId, { quantity = 1, couponCode = '', method = 'paystack', organisationName = '' } = {}, knex = db()) {
  await settings.ensureLoaded();
  const product = await getProduct(productId, knex);
  const qty = product.type === 'attempts' ? Math.max(1, Math.min(10, Number(quantity) || 1)) : 1;
  if (product.type === 'plan' && !String(organisationName || '').trim()) {
    const orgs = await knex('organisation_users').where({ user_id: user.id, role: 'manager' }).first('organisation_id');
    if (!orgs) throw new CommerceError('Enter your company name.', 422, 'organisation_name');
  }
  if (product.type === 'exam') {
    const { hasExamEntitlement } = require('../attempts/eligibility');
    if (await hasExamEntitlement(user.id, product.exam_id, knex)) throw new CommerceError('You already have access to this exam.', 409);
  }
  const unit = priceOf(product);
  const lines = [{ product_id: product.id, name: product.name, quantity: qty, unit_price_kobo: unit, total_kobo: unit * qty, meta: product.type === 'plan' ? toJson({ organisation_name: String(organisationName || '').trim().slice(0, 150) }) : null }];
  const subtotal = lines[0].total_kobo;
  let discount = 0;
  let coupon = null;
  if (String(couponCode || '').trim()) ({ coupon, discount } = await applyCoupon(couponCode, user, lines, knex));
  const total = Math.max(0, subtotal - discount);

  if (total > 0) {
    if (method === 'paystack' && !settings.getSync('payments.paystack_enabled')) throw new CommerceError('Card payment is not available right now.', 422, 'method');
    if (method === 'bank_transfer' && !settings.getSync('payments.bank_enabled')) throw new CommerceError('Bank transfer is not available right now.', 422, 'method');
    if (!['paystack', 'bank_transfer'].includes(method)) throw new CommerceError('Choose a payment method.', 422, 'method');
  }

  const id = await knex.transaction(async (trx) => {
    const [orderId] = await trx('orders').insert({
      order_no: orderNo(),
      user_id: user.id,
      status: total === 0 ? 'pending' : method === 'bank_transfer' ? 'awaiting_transfer' : 'pending',
      payment_method: total === 0 ? 'free' : method,
      subtotal_kobo: subtotal,
      discount_kobo: discount,
      total_kobo: total,
      currency: product.currency || 'NGN',
      coupon_id: coupon ? coupon.id : null,
      expires_at: method === 'bank_transfer' && total > 0 ? new Date(Date.now() + (Number(settings.getSync('payments.transfer_expiry_hours')) || 72) * 3600000) : null,
      buyer_note: product.type === 'plan' ? String(organisationName || '').trim().slice(0, 150) || null : null,
    });
    await trx('order_items').insert(lines.map((l) => ({ ...l, order_id: orderId })));
    return orderId;
  });
  if (total === 0) await markPaid(id, { method: 'free' }, knex);
  return knex('orders').where({ id }).first();
}

// ---------------------------------------------------------------- Fulfilment

async function ensureOrganisation(trx, order, name) {
  const existing = await trx('organisation_users').where({ user_id: order.user_id, role: 'manager' }).first('organisation_id');
  if (existing && !name) return existing.organisation_id;
  const user = await trx('users').where({ id: order.user_id }).first('full_name', 'email');
  const orgName = name || `${user.full_name}'s company`;
  const same = existing ? await trx('organisations').where({ id: existing.organisation_id }).first('id', 'name') : null;
  if (same && same.name.toLowerCase() === orgName.toLowerCase()) return same.id;
  const [orgId] = await trx('organisations').insert({ name: orgName, slug: await uniqueSlug(trx, 'organisations', orgName), contact_name: user.full_name, contact_email: user.email });
  await trx('organisation_users').insert({ organisation_id: orgId, user_id: order.user_id, role: 'manager', joined_at: new Date() }).onConflict(['organisation_id', 'user_id']).ignore();
  return orgId;
}

/** Grants what the order bought. Runs inside the payment transaction; safe to call twice. */
async function fulfil(orderId, trx) {
  const order = await trx('orders').where({ id: orderId }).forUpdate().first();
  if (!order || order.fulfilled_at || order.status !== 'paid') return { fulfilled: false };
  const now = new Date();
  const items = await trx('order_items as oi').join('products as p', 'p.id', 'oi.product_id').where('oi.order_id', orderId).select('oi.*', 'p.type', 'p.exam_id', 'p.access_days', 'p.quantity as unit_quantity', 'p.plan_interval', 'p.paystack_plan_code');
  let organisationId = null;
  for (const it of items) {
    if (it.type === 'exam' || it.type === 'bundle' || it.type === 'pack') {
      await trx('entitlements').insert({ user_id: order.user_id, product_id: it.product_id, starts_at: now, expires_at: it.access_days ? new Date(now.getTime() + it.access_days * 86400000) : null, source_order_id: order.id, source: 'purchase' });
    } else if (it.type === 'attempts') {
      await trx('exam_attempt_overrides').insert({ exam_id: it.exam_id, user_id: order.user_id, extra_attempts: (it.unit_quantity || 1) * it.quantity, reset_cooldown: false, reason: `Purchased (order ${order.order_no})`, source: 'purchase', order_id: order.id });
    } else if (it.type === 'plan') {
      const meta = parseJson(it.meta, {});
      organisationId = await ensureOrganisation(trx, order, meta.organisation_name || order.buyer_note);
      const periodEnd = addMonths(now, PLAN_MONTHS[it.plan_interval] || 1);
      await trx('subscriptions').insert({ user_id: order.user_id, organisation_id: organisationId, product_id: it.product_id, order_id: order.id, status: 'active', current_period_end: periodEnd });
      await trx('entitlements').insert({ organisation_id: organisationId, product_id: it.product_id, starts_at: now, expires_at: periodEnd, source_order_id: order.id, source: 'subscription' });
    }
  }
  if (order.coupon_id) {
    await trx('coupon_redemptions').insert({ coupon_id: order.coupon_id, user_id: order.user_id, order_id: order.id, discount_kobo: order.discount_kobo }).onConflict('order_id').ignore();
    await trx('coupons').where({ id: order.coupon_id }).increment('used_count', 1);
  }
  await trx('orders').where({ id: order.id }).update({ fulfilled_at: now, organisation_id: organisationId || order.organisation_id });
  return { fulfilled: true };
}

/**
 * Marks an order paid (after a verified payment, an approved transfer or a free checkout) and fulfils it in the
 * same transaction. Amount and currency are checked against the order. Idempotent.
 */
async function markPaid(orderId, { method, amountKobo = null, currency = null, reviewerId = null, note = null } = {}, knex = db()) {
  const out = await knex.transaction(async (trx) => {
    const order = await trx('orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw new CommerceError('Order not found.', 404);
    if (order.status === 'paid') return { order, alreadyPaid: true };
    if (['refunded', 'cancelled'].includes(order.status)) throw new CommerceError(`This order is ${order.status}.`, 409);
    if (amountKobo !== null && Number(amountKobo) < order.total_kobo) throw new CommerceError(`Amount paid (${amountKobo}) is less than the order total (${order.total_kobo}).`, 409);
    if (currency && currency !== order.currency) throw new CommerceError('Currency does not match the order.', 409);
    const patch = { status: 'paid', paid_at: new Date() };
    if (method === 'bank_transfer') Object.assign(patch, { reviewed_by: reviewerId, reviewed_at: new Date(), review_note: note });
    await trx('orders').where({ id: orderId }).update(patch);
    await fulfil(orderId, trx);
    return { order: await trx('orders').where({ id: orderId }).first(), alreadyPaid: false };
  });
  if (!out.alreadyPaid) await require('./receipts').sendReceipt(orderId);
  return out;
}

/** Refund: revokes what the order granted (entitlements, purchased attempts, subscription). The money is returned in Paystack or by bank. */
async function refundOrder(orderId, { reason, by }, knex = db()) {
  return knex.transaction(async (trx) => {
    const order = await trx('orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw new CommerceError('Order not found.', 404);
    if (order.status !== 'paid') throw new CommerceError('Only paid orders can be refunded.', 409);
    const now = new Date();
    await trx('entitlements').where({ source_order_id: order.id }).whereNull('revoked_at').update({ revoked_at: now, revoke_reason: `Refunded: ${reason}`.slice(0, 255) });
    await trx('exam_attempt_overrides').where({ order_id: order.id }).del();
    await trx('subscriptions').where({ order_id: order.id }).update({ status: 'cancelled', cancelled_at: now });
    await trx('orders').where({ id: order.id }).update({ status: 'refunded', refunded_at: now, refund_reason: String(reason).slice(0, 500), refunded_by: by });
    await trx('payments').where({ order_id: order.id, status: 'success' }).update({ status: 'refunded' });
    return trx('orders').where({ id: order.id }).first();
  });
}

/** Scheduled: cancels bank-transfer orders that were never paid (no proof uploaded) after the expiry. */
async function expireStaleOrders({ knex = db(), now = new Date() } = {}) {
  const n = await knex('orders').where('status', 'awaiting_transfer').whereNull('transfer_submitted_at').whereNotNull('expires_at').where('expires_at', '<', now).update({ status: 'cancelled' });
  const m = await knex('orders').where('status', 'pending').where('payment_method', 'paystack').where('created_at', '<', new Date(now.getTime() - 7 * 86400000)).update({ status: 'cancelled' });
  return { expiredTransfers: n, abandonedCheckouts: m };
}

/** Active company plan for an organisation (used by workspaces). */
async function activePlanFor(organisationId, knex = db(), now = new Date()) {
  const sub = await knex('subscriptions as s').join('products as p', 'p.id', 's.product_id').where('s.organisation_id', organisationId).whereIn('s.status', ['active', 'non_renewing']).where((w) => w.whereNull('s.current_period_end').orWhere('s.current_period_end', '>', now)).orderBy('s.id', 'desc').first('s.*', 'p.name', 'p.limits', 'p.slug as product_slug', 'p.price_kobo');
  return sub ? { ...sub, limits: parseJson(sub.limits, {}) } : null;
}

module.exports = { CommerceError, priceOf, syncExamProducts, getProduct, bundleContents, applyCoupon, createOrder, fulfil, markPaid, refundOrder, expireStaleOrders, activePlanFor, PLAN_MONTHS, addMonths };
