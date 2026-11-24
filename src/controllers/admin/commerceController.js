'use strict';

const { db } = require('../../config/db');
const audit = require('../../services/audit');
const commerce = require('../../services/commerce');
const receipts = require('../../services/commerce/receipts');
const { paginate } = require('../../utils/paginate');
const { parseJson, toJson } = require('../../utils/json');
const { toMinor, toMajor } = require('../../utils/money');
const { uniqueSlug, slugify } = require('../../utils/slug');
const { localInputToUtc, utcToLocalInput } = require('../../utils/time');
const { notFound } = require('../../utils/errors');

const TYPE_LABEL = { exam: 'Exam', attempts: 'Extra attempts', bundle: 'Bundle', plan: 'Company plan', pack: 'Past-question pack', seats: 'Seats' };
const ORDER_STATUS = { pending: ['badge-amber', 'Awaiting payment'], awaiting_transfer: ['badge-amber', 'Awaiting transfer'], paid: ['badge-green', 'Paid'], failed: ['badge-red', 'Failed'], cancelled: ['badge-gray', 'Cancelled'], refunded: ['badge-red', 'Refunded'] };
const crumbs = (label, href, ...rest) => [{ label: 'Admin', href: '/admin' }, { label, href }, ...rest];
const major = (k) => (k === null || k === undefined ? '' : String(toMajor(k)));

// ---------------------------------------------------------------- Products

async function products(req, res) {
  const type = TYPE_LABEL[req.query.type] ? req.query.type : '';
  const q = db()('products as p').leftJoin('exams as e', 'e.id', 'p.exam_id').whereNull('p.deleted_at');
  if (type) q.where('p.type', type);
  q.select('p.*', 'e.title as exam_title', 'e.id as exam_id_')
    .select(db().raw("(SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status = 'paid') as sold"))
    .orderBy(['p.type', 'p.display_order', 'p.name']);
  const pager = await paginate(q, { page: req.query.page, perPage: 50 });
  res.render('admin/commerce/products', { title: 'Products', layout: 'layouts/app', pager, type, query: req.query, TYPE_LABEL, breadcrumbs: crumbs('Products') });
}

async function productForm(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const p = id ? await db()('products').where({ id }).whereNull('deleted_at').first() : { type: req.query.type === 'plan' ? 'plan' : 'bundle', is_active: true, currency: 'NGN', plan_interval: 'monthly', audience: req.query.type === 'plan' ? 'organisation' : 'individual' };
  if (!p) throw notFound();
  if (id && ['exam', 'attempts'].includes(p.type)) return res.redirect(`/admin/exams/${p.exam_id}/attempts`);
  const items = id ? await db()('product_items').where({ bundle_product_id: id }).pluck('product_id') : [];
  const examProducts = await db()('products as p').join('exams as e', 'e.id', 'p.exam_id').where('p.type', 'exam').whereNull('p.deleted_at').select('p.id', 'p.price_kobo', 'e.title');
  res.render('admin/commerce/product-form', {
    title: id ? `Edit ${p.name}` : 'New product',
    layout: 'layouts/app',
    p: { ...p, features: parseJson(p.features, []), limits: parseJson(p.limits, {}) },
    items,
    examProducts,
    major,
    errors: req.session.formErrors || {},
    breadcrumbs: crumbs('Products', '/admin/products', { label: id ? p.name : 'New' }),
  });
  delete req.session.formErrors;
}

async function productSave(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const b = req.body;
  const errors = {};
  const type = id ? (await db()('products').where({ id }).first('type')).type : b.type === 'plan' ? 'plan' : 'bundle';
  const name = String(b.name || '').trim().slice(0, 200);
  if (!name) errors.name = 'Enter a name.';
  let price = 0;
  let sale = null;
  try {
    price = toMinor(b.price || 0);
    sale = b.sale_price ? toMinor(b.sale_price) : null;
  } catch {
    errors.price = 'Enter prices like 25000 or 25,000.00.';
  }
  if (!(price > 0)) errors.price = 'Enter a price.';
  if (sale !== null && sale >= price) errors.sale_price = 'The sale price must be lower than the price.';
  const items = [].concat(b.items || []).map(Number).filter(Boolean);
  if (type === 'bundle' && items.length < 2) errors.items = 'A bundle needs at least two exams.';
  const limits = type === 'plan' ? { candidates: Number(b.limit_candidates) || null, ai_questions_per_month: Number(b.limit_ai) || 0, exams: Number(b.limit_exams) || null, staff_seats: Number(b.limit_staff) || 1, labs: !!b.limit_labs, custom_branding: !!b.limit_branding } : null;
  if (type === 'plan' && b.paystack_plan_code && !/^PLN_[A-Za-z0-9]+$/.test(String(b.paystack_plan_code).trim())) errors.paystack_plan_code = 'Paystack plan codes look like PLN_xxxxxxxx.';
  if (Object.keys(errors).length) {
    req.session.formErrors = errors;
    req.flash('danger', Object.values(errors).join(' '));
    return res.redirect(id ? `/admin/products/${id}/edit` : `/admin/products/new?type=${type}`);
  }
  const row = {
    name,
    description: String(b.description || '').slice(0, 2000) || null,
    tagline: String(b.tagline || '').slice(0, 200) || null,
    price_kobo: price,
    sale_price_kobo: sale,
    access_days: type === 'bundle' ? Number(b.access_days) || null : null,
    plan_interval: type === 'plan' ? (['monthly', 'quarterly', 'biannually', 'annually'].includes(b.plan_interval) ? b.plan_interval : 'monthly') : null,
    paystack_plan_code: type === 'plan' ? String(b.paystack_plan_code || '').trim() || null : null,
    features: toJson(String(b.features || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20)),
    limits: toJson(limits),
    is_featured: !!b.is_featured,
    is_active: !!b.is_active,
    display_order: Number(b.display_order) || 0,
    audience: type === 'plan' ? 'organisation' : 'individual',
  };
  let pid = id;
  await db().transaction(async (trx) => {
    if (id) await trx('products').where({ id }).update(row);
    else [pid] = await trx('products').insert({ ...row, type, slug: await uniqueSlug(trx, 'products', `${type}-${slugify(name)}`) });
    if (type === 'bundle') {
      await trx('product_items').where({ bundle_product_id: pid }).del();
      await trx('product_items').insert(items.map((x) => ({ bundle_product_id: pid, product_id: x })));
    }
  });
  await audit.record(req, id ? 'product.update' : 'product.create', { entityType: 'product', entityId: pid, after: { ...row, items } });
  req.flash('success', 'Product saved.');
  return res.redirect('/admin/products');
}

// ---------------------------------------------------------------- Coupons

async function coupons(req, res) {
  const rows = await db()('coupons').orderBy('id', 'desc');
  res.render('admin/commerce/coupons', { title: 'Coupons', layout: 'layouts/app', rows, breadcrumbs: crumbs('Coupons') });
}

async function couponForm(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const c = id ? await db()('coupons').where({ id }).first() : { discount_type: 'percent', is_active: true };
  if (!c) throw notFound();
  const allProducts = await db()('products').whereNull('deleted_at').where('is_active', true).orderBy('name').select('id', 'name', 'type');
  res.render('admin/commerce/coupon-form', { title: id ? `Coupon ${c.code}` : 'New coupon', layout: 'layouts/app', c: { ...c, product_ids: parseJson(c.product_ids, []) || [] }, allProducts, major, toLocal: (d) => utcToLocalInput(d, res.locals.fmt.tz), errors: req.session.formErrors || {}, breadcrumbs: crumbs('Coupons', '/admin/coupons', { label: id ? c.code : 'New' }) });
  delete req.session.formErrors;
}

async function couponSave(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const b = req.body;
  const errors = {};
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) errors.code = 'Use 3–40 letters, numbers, hyphens or underscores.';
  else if (await db()('coupons').where({ code }).whereNot({ id: id || 0 }).first('id')) errors.code = 'That code already exists.';
  const type = b.discount_type === 'fixed' ? 'fixed' : 'percent';
  let value = 0;
  try {
    value = type === 'percent' ? Math.round(Number(b.value)) : toMinor(b.value);
  } catch {
    errors.value = 'Enter an amount.';
  }
  if (type === 'percent' && !(value >= 1 && value <= 100)) errors.value = 'A percentage must be 1–100.';
  if (type === 'fixed' && !(value > 0)) errors.value = 'Enter the discount amount.';
  const startsAt = localInputToUtc(b.starts_at, res.locals.fmt.tz);
  const expiresAt = localInputToUtc(b.expires_at, res.locals.fmt.tz);
  if (startsAt && expiresAt && startsAt >= expiresAt) errors.expires_at = 'The end must be after the start.';
  if (Object.keys(errors).length) {
    req.session.formErrors = errors;
    req.flash('danger', Object.values(errors).join(' '));
    return res.redirect(id ? `/admin/coupons/${id}/edit` : '/admin/coupons/new');
  }
  let minOrder = null;
  try {
    minOrder = b.min_order ? toMinor(b.min_order) : null;
  } catch {
    minOrder = null;
  }
  const productIds = [].concat(b.product_ids || []).map(Number).filter(Boolean);
  const row = { code, discount_type: type, value, max_uses: Number(b.max_uses) || null, max_uses_per_user: Number(b.max_uses_per_user) || null, min_order_kobo: minOrder, starts_at: startsAt, expires_at: expiresAt, product_ids: productIds.length ? toJson(productIds) : null, is_active: !!b.is_active };
  let cid = id;
  if (id) await db()('coupons').where({ id }).update(row);
  else [cid] = await db()('coupons').insert(row);
  await audit.record(req, id ? 'coupon.update' : 'coupon.create', { entityType: 'coupon', entityId: cid, after: row });
  req.flash('success', `Coupon ${code} saved.`);
  return res.redirect('/admin/coupons');
}

// ---------------------------------------------------------------- Orders

async function orders(req, res) {
  const f = { status: ORDER_STATUS[req.query.status] ? req.query.status : '', q: String(req.query.q || '').slice(0, 100), method: ['paystack', 'bank_transfer', 'free', 'admin'].includes(req.query.method) ? req.query.method : '' };
  const q = db()('orders as o').join('users as u', 'u.id', 'o.user_id');
  if (f.status) q.where('o.status', f.status);
  if (f.method) q.where('o.payment_method', f.method);
  if (f.q) q.where((w) => w.where('o.order_no', 'like', `%${f.q}%`).orWhere('u.email', 'like', `%${f.q.replace(/[%_\\]/g, '\\$&')}%`).orWhere('u.full_name', 'like', `%${f.q.replace(/[%_\\]/g, '\\$&')}%`));
  q.select('o.*', 'u.full_name', 'u.email').orderBy('o.id', 'desc');
  const pager = await paginate(q, { page: req.query.page });
  const ids = pager.rows.map((r) => r.id);
  const items = ids.length ? await db()('order_items').whereIn('order_id', ids) : [];
  for (const r of pager.rows) r.items = items.filter((i) => i.order_id === r.id);
  const [toReview] = await db()('orders').where('status', 'awaiting_transfer').whereNotNull('transfer_submitted_at').count({ n: '*' });
  const since30 = new Date(Date.now() - 30 * 86400000);
  const [rev] = await db()('orders').where('status', 'paid').where('paid_at', '>=', since30).sum({ s: 'total_kobo' }).count({ n: '*' });
  res.render('admin/commerce/orders', { title: 'Orders', layout: 'layouts/app', pager, f, query: req.query, ORDER_STATUS, toReview: Number(toReview.n), revenue30: Number(rev.s || 0), paid30: Number(rev.n || 0), breadcrumbs: crumbs('Orders') });
}

async function orderShow(req, res) {
  const order = await receipts.loadOrder(Number(req.params.id));
  if (!order) throw notFound();
  const [entitlements, subs, webhooks] = await Promise.all([
    db()('entitlements as en').join('products as p', 'p.id', 'en.product_id').where('en.source_order_id', order.id).select('en.*', 'p.name'),
    db()('subscriptions').where({ order_id: order.id }),
    db()('webhook_events').whereIn('reference', order.payments.map((p) => p.reference).concat([''])).orderBy('id'),
  ]);
  res.render('admin/commerce/order', { title: `Order ${order.order_no}`, layout: 'layouts/app', o: order, entitlements, subs, webhooks, ORDER_STATUS, breadcrumbs: crumbs('Orders', '/admin/orders', { label: order.order_no }) });
}

async function approveTransfer(req, res) {
  const id = Number(req.params.id);
  try {
    const out = await commerce.markPaid(id, { method: 'bank_transfer', reviewerId: req.user.id, note: String(req.body.note || '').slice(0, 500) || null });
    if (!out.alreadyPaid) {
      await db()('payments').insert({ order_id: id, provider: 'bank_transfer', reference: `BT-${out.order.order_no}`, amount_kobo: out.order.total_kobo, currency: out.order.currency, status: 'success', verified_at: new Date(), channel: 'bank_transfer' }).onConflict('reference').ignore();
      await audit.record(req, 'order.transfer_approved', { entityType: 'order', entityId: id });
      req.flash('success', 'Transfer confirmed. Access granted and a receipt emailed.');
    }
  } catch (err) {
    if (!(err instanceof commerce.CommerceError)) throw err;
    req.flash('danger', err.message);
  }
  res.redirect(`/admin/orders/${id}`);
}

async function rejectTransfer(req, res) {
  const id = Number(req.params.id);
  const note = String(req.body.note || '').trim().slice(0, 500);
  if (note.length < 5) {
    req.flash('danger', 'Tell the candidate what is wrong (at least 5 characters).');
    return res.redirect(`/admin/orders/${id}`);
  }
  await db()('orders').where({ id, status: 'awaiting_transfer' }).update({ review_note: note, transfer_submitted_at: null, reviewed_by: req.user.id, reviewed_at: new Date() });
  await audit.record(req, 'order.transfer_rejected', { entityType: 'order', entityId: id, after: { note } });
  req.flash('success', 'The candidate can see your note and upload a new receipt.');
  return res.redirect(`/admin/orders/${id}`);
}

async function refund(req, res) {
  const id = Number(req.params.id);
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) {
    req.flash('danger', 'Give a reason for the refund (at least 5 characters).');
    return res.redirect(`/admin/orders/${id}`);
  }
  try {
    await commerce.refundOrder(id, { reason, by: req.user.id });
    await audit.record(req, 'order.refund', { entityType: 'order', entityId: id, after: { reason } });
    req.flash('success', 'Order refunded and access removed. Return the money in your Paystack dashboard or by bank transfer.');
  } catch (err) {
    if (!(err instanceof commerce.CommerceError)) throw err;
    req.flash('danger', err.message);
  }
  return res.redirect(`/admin/orders/${id}`);
}

/** Admin grants a product to a user without payment (scholarships, partners). Recorded as an "admin" order. */
async function grant(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db()('users').where({ email }).whereNull('deleted_at').first();
  const productId = Number(req.body.product_id);
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!user || !productId || reason.length < 5) {
    req.flash('danger', !user ? 'No user with that email.' : 'Choose a product and give a reason.');
    return res.redirect('/admin/orders');
  }
  const p = await commerce.getProduct(productId).catch(() => null);
  if (!p) throw notFound();
  const [orderId] = await db()('orders').insert({ order_no: `SS-ADM-${Date.now().toString(36).toUpperCase()}`, user_id: user.id, status: 'pending', payment_method: 'admin', subtotal_kobo: 0, discount_kobo: 0, total_kobo: 0, currency: p.currency, buyer_note: p.type === 'plan' ? String(req.body.organisation_name || '').trim().slice(0, 150) || null : reason });
  await db()('order_items').insert({ order_id: orderId, product_id: p.id, name: p.name, quantity: 1, unit_price_kobo: 0, total_kobo: 0 });
  await commerce.markPaid(orderId, { method: 'admin' });
  await audit.record(req, 'order.grant', { entityType: 'order', entityId: orderId, after: { user: user.email, product: p.name, reason } });
  req.flash('success', `${p.name} granted to ${user.full_name}.`);
  return res.redirect(`/admin/orders/${orderId}`);
}

async function invoice(req, res) {
  const o = await db()('orders').where({ id: Number(req.params.id) }).first('id', 'order_no');
  if (!o) throw notFound();
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${o.order_no}.pdf"`).send(await receipts.invoicePdf(o.id));
}

async function grantForm(req, res) {
  const products = await db()('products').whereNull('deleted_at').where('is_active', true).whereIn('type', ['exam', 'bundle', 'attempts', 'plan']).orderBy('name').select('id', 'name', 'type');
  res.render('admin/commerce/grant', { title: 'Grant access', layout: 'layouts/app', products, TYPE_LABEL, breadcrumbs: crumbs('Orders', '/admin/orders', { label: 'Grant access' }) });
}

module.exports = { products, productForm, productSave, coupons, couponForm, couponSave, orders, orderShow, approveTransfer, rejectTransfer, refund, grant, grantForm, invoice, TYPE_LABEL, ORDER_STATUS };
