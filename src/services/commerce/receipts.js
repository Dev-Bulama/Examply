'use strict';

/** Invoices (PDF) and receipt emails. */
const PDFDocument = require('pdfkit');
const { db } = require('../../config/db');
const { getEnv } = require('../../config/env');
const { getLogger } = require('../../config/logger');
const { formatMoney } = require('../../utils/money');
const { formatDateTime, formatDate } = require('../../utils/time');
const settings = require('../settings');
const mail = require('../mail');

/** pdfkit's built-in fonts have no ₦ glyph, so PDFs write "NGN 5,000". */
const pdfMoney = (kobo, currency = 'NGN') => `${currency} ${(Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function loadOrder(orderId, knex = db()) {
  const order = await knex('orders as o').join('users as u', 'u.id', 'o.user_id').leftJoin('coupons as c', 'c.id', 'o.coupon_id').where('o.id', orderId).first('o.*', 'u.full_name', 'u.email', 'c.code as coupon_code');
  if (!order) return null;
  order.items = await knex('order_items').where({ order_id: orderId });
  order.payments = await knex('payments').where({ order_id: orderId }).orderBy('id');
  return order;
}

async function sendReceipt(orderId) {
  try {
    const o = await loadOrder(orderId);
    if (!o || o.total_kobo === 0) return;
    await mail.queue({
      to: o.email,
      template: 'purchase_receipt',
      vars: { name: o.full_name.split(' ')[0], order_no: o.order_no, total: formatMoney(o.total_kobo, o.currency), items: o.items.map((i) => `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`).join(', '), library_url: `${String(getEnv().APP_URL).replace(/\/$/, '')}/my/orders/${o.order_no}` },
    });
  } catch (err) {
    getLogger().warn({ err: err.message, orderId }, 'receipt email not queued');
  }
}

/** A4 invoice / receipt. Marked PAID, REFUNDED or UNPAID. */
async function invoicePdf(orderId, knex = db()) {
  const o = await loadOrder(orderId, knex);
  if (!o) return null;
  await settings.ensureLoaded();
  const s = (k) => settings.getSync(k);
  const tz = s('general.timezone') || 'Africa/Lagos';
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${o.order_no}` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const hex = String(s('branding.primary_color') || '#1f3a5f');
  doc.rect(0, 0, doc.page.width, 6).fill(hex);
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(20).text(s('payments.business_name') || s('general.site_name'), 50, 40);
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text([s('payments.business_address'), s('general.contact_email'), s('payments.tax_id') ? `TIN ${s('payments.tax_id')}` : ''].filter(Boolean).join('\n'), 50, 66, { width: 260 });
  const label = o.status === 'paid' ? 'RECEIPT' : o.status === 'refunded' ? 'REFUNDED' : 'INVOICE';
  doc.font('Helvetica-Bold').fontSize(22).fillColor(o.status === 'paid' ? '#059669' : o.status === 'refunded' ? '#dc2626' : '#0f172a').text(label, 300, 40, { width: 245, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#334155').text(`No. ${o.order_no}\nDate ${formatDate(o.created_at, { timezone: tz })}${o.paid_at ? `\nPaid ${formatDateTime(o.paid_at, { timezone: tz })}` : ''}`, 300, 70, { width: 245, align: 'right' });
  doc.fillColor('#64748b').fontSize(9).text('BILLED TO', 50, 140);
  doc.fillColor('#0f172a').fontSize(11).text(`${o.full_name}\n${o.email}${o.buyer_note ? `\n${o.buyer_note}` : ''}`, 50, 154);

  let y = 220;
  doc.rect(50, y, 495, 22).fill('#f1f5f9');
  doc.fillColor('#334155').font('Helvetica-Bold').fontSize(9).text('ITEM', 58, y + 7).text('QTY', 340, y + 7, { width: 40, align: 'right' }).text('UNIT', 385, y + 7, { width: 75, align: 'right' }).text('AMOUNT', 465, y + 7, { width: 72, align: 'right' });
  y += 30;
  doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
  for (const it of o.items) {
    doc.text(it.name, 58, y, { width: 270 });
    doc.text(String(it.quantity), 340, y, { width: 40, align: 'right' });
    doc.text(pdfMoney(it.unit_price_kobo, o.currency), 385, y, { width: 75, align: 'right' });
    doc.text(pdfMoney(it.total_kobo, o.currency), 465, y, { width: 72, align: 'right' });
    y = Math.max(doc.y, y + 14) + 8;
  }
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#e2e8f0').stroke();
  y += 10;
  const row = (k, v, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#0f172a').text(k, 290, y, { width: 140, align: 'right' }).text(v, 435, y, { width: 102, align: 'right' });
    y += bold ? 20 : 16;
  };
  row('Subtotal', pdfMoney(o.subtotal_kobo, o.currency));
  if (o.discount_kobo) row(`Discount${o.coupon_code ? ` (${o.coupon_code})` : ''}`, `- ${pdfMoney(o.discount_kobo, o.currency)}`);
  const vat = Number(s('payments.vat_percent')) || 0;
  if (vat) row(`VAT included (${vat}%)`, pdfMoney(Math.round((o.total_kobo * vat) / (100 + vat)), o.currency));
  row('Total', pdfMoney(o.total_kobo, o.currency), true);
  const paid = o.payments.find((p) => p.status === 'success' || p.status === 'refunded');
  y += 20;
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(
    o.payment_method === 'paystack' ? `Paid with Paystack${paid && paid.channel ? ` (${paid.channel})` : ''}${paid ? ` · reference ${paid.reference}` : ''}` : o.payment_method === 'bank_transfer' ? `Bank transfer${o.transfer_reference ? ` · reference ${o.transfer_reference}` : ''}` : o.payment_method === 'free' ? 'No payment was required.' : 'Granted by an administrator.',
    50,
    y,
    { width: 495 },
  );
  if (o.status === 'refunded') doc.text(`Refunded ${formatDateTime(o.refunded_at, { timezone: tz })}: ${o.refund_reason || ''}`, 50, doc.y + 4, { width: 495 });
  doc.end();
  return done;
}

module.exports = { sendReceipt, invoicePdf, loadOrder, pdfMoney };
