'use strict';

const path = require('path');
const { db } = require('../config/db');
const { storagePath } = require('../config/paths');
const { getEnv } = require('../config/env');
const audit = require('../services/audit');
const settings = require('../services/settings');
const commerce = require('../services/commerce');
const paystack = require('../services/commerce/paystack');
const receipts = require('../services/commerce/receipts');
const { saveImage } = require('../services/uploads');
const { parseJson } = require('../utils/json');
const { notFound } = require('../utils/errors');

const base = () => String(getEnv().APP_URL).replace(/\/$/, '');

async function productBySlug(slug) {
  const p = await db()('products as p').leftJoin('exams as e', 'e.id', 'p.exam_id').where('p.slug', String(slug)).whereNull('p.deleted_at').where('p.is_active', true).first('p.*', 'e.slug as exam_slug', 'e.title as exam_title', 'e.duration_minutes', 'e.certificate_enabled');
  if (!p) throw notFound('This product is not available.');
  return { ...p, features: parseJson(p.features, []), limits: parseJson(p.limits, {}) };
}

async function methods() {
  await settings.ensureLoaded();
  return { paystack: !!settings.getSync('payments.paystack_enabled'), bank: !!settings.getSync('payments.bank_enabled') };
}

// ---------------------------------------------------------------- Pricing page (plans, bundles)

async function pricing(req, res) {
  const k = db();
  const [plans, bundles] = await Promise.all([
    k('products').where({ type: 'plan', is_active: true }).whereNull('deleted_at').orderBy('display_order').orderBy('price_kobo'),
    k('products').where({ type: 'bundle', is_active: true }).whereNull('deleted_at').orderBy('display_order').orderBy('price_kobo'),
  ]);
  for (const p of plans) {
    p.features = parseJson(p.features, []);
    p.limits = parseJson(p.limits, {});
  }
  for (const b of bundles) b.contents = await commerce.bundleContents(b.id);
  res.render('public/pricing', { title: 'Pricing', layout: 'layouts/public', plans, bundles, priceOf: commerce.priceOf, metaDescription: 'Plans for companies and exam bundles for individuals.' });
}

// ---------------------------------------------------------------- Checkout

async function checkoutForm(req, res) {
  const product = await productBySlug(req.params.slug);
  const m = await methods();
  const contents = product.type === 'bundle' ? await commerce.bundleContents(product.id) : [];
  const managed = await db()('organisation_users as ou').join('organisations as o', 'o.id', 'ou.organisation_id').where({ 'ou.user_id': req.user.id, 'ou.role': 'manager' }).first('o.name');
  const qty = product.type === 'attempts' ? Math.max(1, Math.min(10, Number(req.query.qty) || 1)) : 1;
  let preview = null;
  if (req.query.coupon) {
    try {
      const unit = commerce.priceOf(product);
      const { discount } = await commerce.applyCoupon(req.query.coupon, req.user, [{ product_id: product.id, total_kobo: unit * qty }]);
      preview = { code: String(req.query.coupon).toUpperCase(), discount };
    } catch (err) {
      if (!(err instanceof commerce.CommerceError)) throw err;
      preview = { code: String(req.query.coupon).toUpperCase(), error: err.message };
    }
  }
  res.render('shop/checkout', { title: `Checkout · ${product.name}`, layout: 'layouts/public', product, contents, m, managed, qty, preview, unit: commerce.priceOf(product), bank: { name: settings.getSync('payments.bank_name') } });
}

async function checkout(req, res) {
  const product = await productBySlug(req.params.slug);
  const back = `/checkout/${product.slug}${req.body.quantity ? `?qty=${Number(req.body.quantity) || 1}` : ''}`;
  try {
    const order = await commerce.createOrder(req.user, product.id, { quantity: req.body.quantity, couponCode: req.body.coupon, method: req.body.method, organisationName: req.body.organisation_name });
    await audit.record(req, 'order.create', { entityType: 'order', entityId: order.id, after: { order_no: order.order_no, product: product.slug, total_kobo: order.total_kobo, method: order.payment_method } });
    if (order.status === 'paid') {
      req.flash('success', 'Done — you have access now.');
      return res.redirect(`/my/orders/${order.order_no}`);
    }
    if (order.payment_method === 'paystack') {
      const { authorizationUrl } = await paystack.initialize(order, req.user, `${base()}/payments/paystack/callback`);
      return res.redirect(authorizationUrl);
    }
    return res.redirect(`/my/orders/${order.order_no}`);
  } catch (err) {
    if (err instanceof commerce.CommerceError) {
      req.flash('danger', err.message);
      return res.redirect(back);
    }
    if (err instanceof paystack.PaystackError) {
      req.flash('danger', `Paystack could not start the payment: ${err.message} Please try again, or choose bank transfer.`);
      return res.redirect(back);
    }
    throw err;
  }
}

/** Paystack redirects here after payment; the webhook may already have fulfilled the order. */
async function paystackCallback(req, res) {
  const reference = String(req.query.reference || req.query.trxref || '').slice(0, 100);
  const payment = reference ? await db()('payments').where({ reference }).first('order_id') : null;
  if (!payment) throw notFound('Payment not found.');
  const order = await db()('orders').where({ id: payment.order_id }).first('order_no', 'user_id');
  if (order.user_id !== req.user.id) throw notFound();
  try {
    const r = await paystack.verifyAndApply(reference);
    if (r.ok) req.flash('success', 'Payment received — you have access now.');
    else if (r.reason === 'abandoned' || r.reason === 'pending' || r.reason === 'ongoing') req.flash('warning', 'The payment was not completed. You can try again below.');
    else req.flash('danger', 'The payment did not go through. You have not been charged; please try again.');
  } catch (err) {
    if (!(err instanceof paystack.PaystackError)) throw err;
    req.flash('warning', 'We could not confirm the payment with Paystack yet. If you were charged, access is granted automatically within a few minutes.');
  }
  return res.redirect(`/my/orders/${order.order_no}`);
}

async function webhook(req, res) {
  const out = await paystack.handleWebhook(req.body, req.get('x-paystack-signature'));
  res.status(out.status).json({ outcome: out.outcome });
}

// ---------------------------------------------------------------- My orders

async function ownedOrder(req) {
  const o = await db()('orders').where({ order_no: String(req.params.no || '') }).first();
  if (!o || o.user_id !== req.user.id) throw notFound('Order not found.');
  return o;
}

async function myOrders(req, res) {
  const rows = await db()('orders').where({ user_id: req.user.id }).orderBy('id', 'desc').limit(100);
  const items = rows.length ? await db()('order_items').whereIn('order_id', rows.map((r) => r.id)) : [];
  for (const r of rows) r.items = items.filter((i) => i.order_id === r.id);
  const access = await db()('entitlements as en').join('products as p', 'p.id', 'en.product_id').leftJoin('exams as e', 'e.id', 'p.exam_id').where('en.user_id', req.user.id).whereNull('en.revoked_at').orderBy('en.id', 'desc').select('en.*', 'p.name', 'p.type', 'e.slug as exam_slug');
  res.render('shop/orders', { title: 'Orders & library', layout: 'layouts/app', rows, access, breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Orders' }] });
}

async function orderShow(req, res) {
  const o = await ownedOrder(req);
  const order = await receipts.loadOrder(o.id);
  const products = await db()('order_items as oi').join('products as p', 'p.id', 'oi.product_id').leftJoin('exams as e', 'e.id', 'p.exam_id').where('oi.order_id', o.id).select('p.type', 'p.id', 'e.slug as exam_slug', 'e.title as exam_title');
  for (const p of products) if (p.type === 'bundle') p.contents = await commerce.bundleContents(p.id);
  await settings.ensureLoaded();
  res.render('shop/order', {
    title: `Order ${o.order_no}`,
    layout: 'layouts/app',
    order,
    products,
    bank: { name: settings.getSync('payments.bank_name'), account_name: settings.getSync('payments.bank_account_name'), account_number: settings.getSync('payments.bank_account_number'), instructions: settings.getSync('payments.bank_instructions') },
    m: await methods(),
    breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Orders', href: '/my/orders' }, { label: o.order_no }],
  });
}

/** Candidate uploads the transfer receipt (image or PDF). */
async function submitTransfer(req, res) {
  const o = await ownedOrder(req);
  if (o.status !== 'awaiting_transfer') {
    req.flash('warning', 'This order is not waiting for a transfer.');
    return res.redirect(`/my/orders/${o.order_no}`);
  }
  const reference = String(req.body.transfer_reference || '').trim().slice(0, 120);
  if (!req.file && !reference) {
    req.flash('danger', 'Upload the transfer receipt or enter the transfer reference.');
    return res.redirect(`/my/orders/${o.order_no}`);
  }
  let file = o.transfer_proof_path;
  if (req.file) {
    try {
      file = saveImage(req.file, { dir: 'transfers', allowed: ['png', 'jpg', 'webp', 'pdf'], visibility: 'private' });
    } catch (err) {
      req.flash('danger', err.message);
      return res.redirect(`/my/orders/${o.order_no}`);
    }
  }
  await db()('orders').where({ id: o.id }).update({ transfer_proof_path: file, transfer_reference: reference || o.transfer_reference, transfer_note: String(req.body.transfer_note || '').slice(0, 1000) || null, transfer_submitted_at: new Date(), review_note: null });
  await audit.record(req, 'order.transfer_submitted', { entityType: 'order', entityId: o.id, after: { reference } });
  req.flash('success', 'Thanks — we will confirm your transfer shortly and email you when access is ready.');
  return res.redirect(`/my/orders/${o.order_no}`);
}

/** Retry a Paystack payment for a pending/failed order. */
async function payAgain(req, res) {
  const o = await ownedOrder(req);
  if (!['pending', 'failed'].includes(o.status) || o.payment_method !== 'paystack') return res.redirect(`/my/orders/${o.order_no}`);
  try {
    await db()('orders').where({ id: o.id }).update({ status: 'pending' });
    const { authorizationUrl } = await paystack.initialize(o, req.user, `${base()}/payments/paystack/callback`);
    return res.redirect(authorizationUrl);
  } catch (err) {
    if (!(err instanceof paystack.PaystackError)) throw err;
    req.flash('danger', `Paystack could not start the payment: ${err.message}`);
    return res.redirect(`/my/orders/${o.order_no}`);
  }
}

async function cancel(req, res) {
  const o = await ownedOrder(req);
  if (['pending', 'awaiting_transfer', 'failed'].includes(o.status)) {
    await db()('orders').where({ id: o.id }).update({ status: 'cancelled' });
    req.flash('success', 'Order cancelled.');
  }
  return res.redirect('/my/orders');
}

async function invoice(req, res) {
  const o = await ownedOrder(req);
  const buf = await receipts.invoicePdf(o.id);
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${o.order_no}.pdf"`).send(buf);
}

/** Admin-only: view a transfer receipt. */
async function transferProof(req, res) {
  const o = await db()('orders').where({ id: Number(req.params.id) }).first('transfer_proof_path');
  if (!o || !o.transfer_proof_path || !/^[A-Za-z0-9_-]{8,80}\.(png|jpg|webp|pdf)$/.test(o.transfer_proof_path)) throw notFound();
  res.set('X-Content-Type-Options', 'nosniff').set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  return res.sendFile(path.join(storagePath('uploads', 'private', 'transfers'), o.transfer_proof_path));
}

module.exports = { pricing, checkoutForm, checkout, paystackCallback, webhook, myOrders, orderShow, submitTransfer, payAgain, cancel, invoice, transferProof };
