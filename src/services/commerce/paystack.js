'use strict';

/**
 * Paystack: initialize → redirect → callback verify, plus the signed webhook (the source of truth).
 * No SDK: two HTTPS calls with the secret key. Webhooks are verified with HMAC-SHA512 over the raw body.
 */
const crypto = require('crypto');
const { db } = require('../../config/db');
const { getLogger } = require('../../config/logger');
const { toJson } = require('../../utils/json');
const settings = require('../settings');
const commerce = require('./index');

const API = 'https://api.paystack.co';

class PaystackError extends Error {}

async function secretKey() {
  await settings.ensureLoaded();
  const key = await settings.get('payments.paystack_secret_key');
  if (!key) throw new PaystackError('Paystack is not configured.');
  return key;
}

/** Low-level call. Exposed for tests (jest.spyOn(paystack, 'call')). */
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await secretKey()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  if (!res.ok || json.status === false) throw new PaystackError(json.message || `Paystack returned HTTP ${res.status}.`);
  return json.data;
}

const api = { call };

/** Starts a Paystack checkout for an order. Returns the authorization URL to redirect to. */
async function initialize(order, user, callbackUrl, knex = db()) {
  const reference = `${order.order_no}-${crypto.randomBytes(3).toString('hex')}`;
  const plan = await knex('order_items as oi').join('products as p', 'p.id', 'oi.product_id').where('oi.order_id', order.id).where('p.type', 'plan').whereNotNull('p.paystack_plan_code').first('p.paystack_plan_code');
  const data = await api.call('POST', '/transaction/initialize', {
    email: user.email,
    amount: order.total_kobo,
    currency: order.currency,
    reference,
    callback_url: callbackUrl,
    ...(plan ? { plan: plan.paystack_plan_code } : {}),
    metadata: { order_no: order.order_no, order_id: order.id, user_id: user.id, cancel_action: callbackUrl.replace(/\/callback.*$/, '') },
  });
  await knex('payments').insert({ order_id: order.id, provider: 'paystack', reference, amount_kobo: order.total_kobo, currency: order.currency, status: 'initialized', authorization_url: data.authorization_url });
  await knex('orders').where({ id: order.id }).update({ paystack_access_code: data.access_code || null });
  return { reference, authorizationUrl: data.authorization_url };
}

/** Verifies a transaction with Paystack and, if successful, marks the order paid. Idempotent. */
async function verifyAndApply(reference, knex = db()) {
  const payment = await knex('payments').where({ reference: String(reference).slice(0, 100), provider: 'paystack' }).first();
  if (!payment) return { ok: false, reason: 'unknown_reference' };
  if (payment.status === 'success') return { ok: true, orderId: payment.order_id, already: true };
  const data = await api.call('GET', `/transaction/verify/${encodeURIComponent(payment.reference)}`);
  return applyCharge(payment, data, knex);
}

async function applyCharge(payment, data, knex = db()) {
  const status = data.status === 'success' ? 'success' : ['failed', 'abandoned', 'reversed'].includes(data.status) ? data.status : null;
  if (!status) return { ok: false, reason: data.status || 'pending', orderId: payment.order_id };
  if (status !== 'success') {
    await knex('payments').where({ id: payment.id }).update({ status, raw_payload: toJson(data), verified_at: new Date() });
    if (status === 'failed') await knex('orders').where({ id: payment.order_id, status: 'pending' }).update({ status: 'failed' });
    return { ok: false, reason: status, orderId: payment.order_id };
  }
  if (Number(data.amount) !== Number(payment.amount_kobo) || (data.currency && data.currency !== payment.currency)) {
    getLogger().error({ reference: payment.reference, expected: payment.amount_kobo, got: data.amount }, 'Paystack amount mismatch');
    await knex('payments').where({ id: payment.id }).update({ status: 'failed', raw_payload: toJson(data), verified_at: new Date() });
    return { ok: false, reason: 'amount_mismatch', orderId: payment.order_id };
  }
  await knex('payments').where({ id: payment.id }).update({ status: 'success', channel: String(data.channel || '').slice(0, 40) || null, raw_payload: toJson(data), verified_at: new Date() });
  await commerce.markPaid(payment.order_id, { method: 'paystack', amountKobo: Number(data.amount), currency: data.currency }, knex);
  // Plans charged through a Paystack Plan: remember the subscription so renewals can extend it.
  if (data.plan && data.customer) await knex('subscriptions').where({ order_id: payment.order_id }).update({ customer_code: data.customer.customer_code || null });
  return { ok: true, orderId: payment.order_id };
}

/** True when the signature header matches HMAC-SHA512(rawBody, secret key). Constant-time comparison. */
async function validSignature(rawBody, signature) {
  if (!signature || !/^[0-9a-f]{128}$/i.test(String(signature))) return false;
  const key = await settings.get('payments.paystack_secret_key');
  if (!key) return false;
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature).toLowerCase(), 'hex'));
}

/**
 * Handles a webhook. Every delivery is logged in webhook_events. Returns the outcome.
 * charge.success → verify amount → mark paid (or extend a subscription on renewal)
 * subscription.create / subscription.disable / subscription.not_renew / invoice.payment_failed → subscription status
 */
async function handleWebhook(rawBody, signature, knex = db()) {
  let payload = null;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    payload = null;
  }
  const event = payload && payload.event ? String(payload.event).slice(0, 60) : 'unknown';
  const data = (payload && payload.data) || {};
  const reference = data.reference ? String(data.reference).slice(0, 100) : data.subscription_code || null;
  const log = (outcome, error = null, valid = true) => knex('webhook_events').insert({ provider: 'paystack', event, reference, signature_valid: valid, payload: valid ? toJson(payload) : null, outcome, error });

  if (!(await validSignature(rawBody, signature))) {
    await log('rejected', 'Invalid signature', false);
    return { status: 401, outcome: 'rejected' };
  }
  if (reference) {
    const seen = await knex('webhook_events').where({ provider: 'paystack', event, reference, outcome: 'processed' }).first('id');
    if (seen) {
      await log('duplicate');
      return { status: 200, outcome: 'duplicate' };
    }
  }
  try {
    if (event === 'charge.success') {
      const payment = await knex('payments').where({ reference, provider: 'paystack' }).first();
      if (payment) {
        const r = await applyCharge(payment, data, knex);
        await log(r.ok ? 'processed' : 'ignored', r.ok ? null : r.reason);
        return { status: 200, outcome: r.ok ? 'processed' : 'ignored' };
      }
      // A renewal charge for a Paystack Plan: extend the matching subscription.
      if (data.plan && data.customer) {
        const sub = await knex('subscriptions as s').join('products as p', 'p.id', 's.product_id').where('p.paystack_plan_code', data.plan.plan_code || data.plan).where('s.customer_code', data.customer.customer_code).whereIn('s.status', ['active', 'attention', 'non_renewing']).first('s.*', 'p.plan_interval');
        if (sub) {
          const from = sub.current_period_end && new Date(sub.current_period_end) > new Date() ? new Date(sub.current_period_end) : new Date();
          const end = commerce.addMonths(from, commerce.PLAN_MONTHS[sub.plan_interval] || 1);
          await knex('subscriptions').where({ id: sub.id }).update({ status: 'active', current_period_end: end });
          await knex('entitlements').where({ organisation_id: sub.organisation_id, product_id: sub.product_id, source: 'subscription' }).whereNull('revoked_at').update({ expires_at: end });
          await log('processed');
          return { status: 200, outcome: 'processed' };
        }
      }
      await log('ignored', 'No matching payment');
      return { status: 200, outcome: 'ignored' };
    }
    if (event.startsWith('subscription.') || event === 'invoice.payment_failed') {
      const code = data.subscription_code || (data.subscription && data.subscription.subscription_code);
      const customer = data.customer && data.customer.customer_code;
      const status = { 'subscription.create': 'active', 'subscription.disable': 'cancelled', 'subscription.not_renew': 'non_renewing', 'invoice.payment_failed': 'attention' }[event];
      if (status && customer) {
        const q = knex('subscriptions').where('customer_code', customer);
        if (event === 'subscription.create') await q.whereNull('subscription_code').update({ subscription_code: code || null, email_token: data.email_token || null, status });
        else await q.where((w) => (code ? w.where('subscription_code', code) : w)).update({ status, ...(status === 'cancelled' ? { cancelled_at: new Date() } : {}) });
        await log('processed');
        return { status: 200, outcome: 'processed' };
      }
    }
    await log('ignored');
    return { status: 200, outcome: 'ignored' };
  } catch (err) {
    getLogger().error({ err: err.message, event, reference }, 'Paystack webhook failed');
    await log('error', err.message);
    return { status: 500, outcome: 'error' };
  }
}

module.exports = { api, initialize, verifyAndApply, handleWebhook, validSignature, PaystackError, API };
