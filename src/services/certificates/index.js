'use strict';

/**
 * Certificates: issued automatically when a candidate passes an exam that has certificates turned on. Each has a
 * unique public code (e.g. EXM-7KQ2-M9XD) and a QR code that opens /verify/<code>.
 * PDFs (certificate and result slip) are generated on demand with pdfkit (pure JS) and cached in storage/pdf.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { db } = require('../../config/db');
const { storagePath } = require('../../config/paths');
const { getEnv } = require('../../config/env');
const { parseJson } = require('../../utils/json');
const { formatDate, formatDateTime } = require('../../utils/time');
const settings = require('../settings');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

function newCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `EXM-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

const verifyUrl = (code) => `${String(getEnv().APP_URL).replace(/\/$/, '')}/verify/${code}`;

async function examSnapshot(attempt, knex) {
  const v = await knex('exam_versions').where({ exam_id: attempt.exam_id, version_no: attempt.exam_version }).first('snapshot');
  return parseJson(v && v.snapshot, {});
}

/** Issues the certificate for a passed attempt (idempotent). Returns the certificate row or null. */
async function issueForAttempt(attemptId, knex = db()) {
  const existing = await knex('certificates').where({ attempt_id: attemptId }).first();
  if (existing) return existing;
  const attempt = await knex('attempts').where({ id: attemptId }).first();
  if (!attempt || !attempt.passed) return null;
  const snap = await examSnapshot(attempt, knex);
  if (!snap.exam || !Number(snap.exam.certificate_enabled)) return null;
  const user = await knex('users').where({ id: attempt.user_id }).first('full_name');
  let code = newCode();
  for (let i = 0; i < 5 && (await knex('certificates').where({ code }).first('id')); i += 1) code = newCode();
  const [id] = await knex('certificates').insert({
    code,
    user_id: attempt.user_id,
    exam_id: attempt.exam_id,
    attempt_id: attempt.id,
    holder_name: user.full_name,
    exam_title: snap.exam.title,
    percent: attempt.percent,
    band: attempt.band,
    template: snap.exam.certificate_template || 'classic',
    issued_at: new Date(),
  });
  return knex('certificates').where({ id }).first();
}

/** Public verification data (no personal data beyond the holder's name). */
async function verify(code, knex = db()) {
  const c = await knex('certificates as c')
    .join('exams as e', 'e.id', 'c.exam_id')
    .join('attempts as a', 'a.id', 'c.attempt_id')
    .leftJoin('certifications as ce', 'ce.id', 'e.certification_id')
    .where('c.code', String(code || '').toUpperCase().slice(0, 24))
    .first('c.*', 'e.slug as exam_slug', 'e.type as exam_type', 'a.scaled_score', 'a.exam_version', 'a.exam_id as a_exam_id', 'ce.name as certification_name', 'ce.exam_code');
  if (!c) return null;
  const snap = await examSnapshot({ exam_id: c.a_exam_id, exam_version: c.exam_version }, knex);
  const months = snap.settings && snap.settings.certificate ? snap.settings.certificate.validity_months : null;
  const expiresAt = months ? new Date(new Date(c.issued_at).setMonth(new Date(c.issued_at).getMonth() + Number(months))) : null;
  const status = c.revoked_at ? 'revoked' : expiresAt && expiresAt < new Date() ? 'expired' : 'valid';
  return { ...c, expiresAt, status, signatory: (snap.settings && snap.settings.certificate) || {}, scaling: snap.settings ? snap.settings.scaling : null };
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0x1f3a5f;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function brand() {
  await settings.ensureLoaded();
  return { name: settings.getSync('general.site_name') || 'EXAMPLY', primary: hexToRgb(settings.getSync('branding.primary_color')), timezone: settings.getSync('general.timezone') || 'Africa/Lagos' };
}

/** Landscape A4 certificate in one of three designs. Returns a Buffer (cached on disk by code). */
async function certificatePdf(code, knex = db()) {
  const file = storagePath('pdf', 'certificates', `${code}.pdf`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const c = await verify(code, knex);
  if (!c) return null;
  const b = await brand();
  const qr = await QRCode.toBuffer(verifyUrl(code), { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate ${code}`, Author: b.name, Subject: c.exam_title } });
  const W = doc.page.width;
  const H = doc.page.height;
  const [r, g, bl] = b.primary;
  const template = c.template || 'classic';

  if (template === 'modern') {
    doc.rect(0, 0, 200, H).fill([r, g, bl]);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(b.name, 30, 60, { width: 150 });
    doc.font('Helvetica').fontSize(10).text('Certificate of Achievement', 30, H - 90, { width: 150 });
  } else if (template === 'classic') {
    doc.lineWidth(6).strokeColor([r, g, bl]).rect(22, 22, W - 44, H - 44).stroke();
    doc.lineWidth(1).rect(34, 34, W - 68, H - 68).stroke();
  } else {
    doc.rect(0, 0, W, 8).fill([r, g, bl]);
  }
  const left = template === 'modern' ? 240 : 70;
  const width = W - left - 70;
  const align = template === 'modern' ? 'left' : 'center';
  doc.fillColor('#64748b').font('Helvetica').fontSize(12).text(template === 'modern' ? 'This certifies that' : `${b.name.toUpperCase()} · CERTIFICATE OF ACHIEVEMENT`, left, 95, { width, align, characterSpacing: template === 'modern' ? 0 : 2 });
  if (template !== 'modern') doc.fillColor('#64748b').fontSize(13).text('This certifies that', left, 140, { width, align });
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(36).text(c.holder_name, left, template === 'modern' ? 125 : 170, { width, align });
  doc.fillColor('#334155').font('Helvetica').fontSize(14).text('has successfully passed', left, doc.y + 14, { width, align });
  doc.fillColor([r, g, bl]).font('Helvetica-Bold').fontSize(22).text(c.exam_title, left, doc.y + 10, { width, align });
  const facts = [`Score ${Number(c.percent)}%`, c.scaled_score ? `Scaled score ${Number(c.scaled_score)}` : null, c.band ? `Band: ${c.band}` : null, `Issued ${formatDate(c.issued_at, { timezone: b.timezone })}`, c.expiresAt ? `Valid until ${formatDate(c.expiresAt, { timezone: b.timezone })}` : null].filter(Boolean);
  doc.fillColor('#475569').font('Helvetica').fontSize(12).text(facts.join('   ·   '), left, doc.y + 16, { width, align });
  if (c.certification_name) doc.fontSize(10).fillColor('#94a3b8').text(`Preparation for ${c.certification_name}${c.exam_code ? ` (${c.exam_code})` : ''}. Not issued by or affiliated with the certification body.`, left, doc.y + 8, { width, align });

  // Signature block and QR
  const baseY = H - 150;
  if (c.signatory.signatory_name) {
    const sx = template === 'modern' ? left : W / 2 - 230;
    doc.moveTo(sx, baseY + 40).lineTo(sx + 200, baseY + 40).lineWidth(0.8).strokeColor('#94a3b8').stroke();
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(c.signatory.signatory_name, sx, baseY + 46, { width: 200 });
    if (c.signatory.signatory_title) doc.fillColor('#64748b').font('Helvetica').fontSize(10).text(c.signatory.signatory_title, sx, doc.y + 2, { width: 200 });
  }
  const qx = W - 70 - 96;
  doc.image(qr, qx, baseY - 6, { width: 96 });
  doc.fillColor('#475569').font('Helvetica').fontSize(9).text(`Certificate ID ${code}`, qx - 160, baseY + 50, { width: 150, align: 'right' });
  doc.text(`Verify: ${verifyUrl(code).replace(/^https?:\/\//, '')}`, qx - 260, baseY + 64, { width: 250, align: 'right' });

  const buf = await toBuffer(doc);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

/** Portrait A4 result slip for an attempt (score, sections, domains, QR to the certificate when there is one). */
async function resultSlipPdf(attemptId, knex = db()) {
  const a = await knex('attempts as a').join('users as u', 'u.id', 'a.user_id').where('a.id', attemptId).first('a.*', 'u.full_name', 'u.email');
  const r = await knex('results').where({ attempt_id: attemptId }).first();
  if (!a || !r) return null;
  const snap = await examSnapshot(a, knex);
  const cert = await knex('certificates').where({ attempt_id: attemptId }).whereNull('revoked_at').first('code');
  const bd = parseJson(r.breakdown, {});
  const b = await brand();
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Result slip — ${snap.exam.title}`, Author: b.name } });
  const [rr, gg, bb] = b.primary;
  doc.rect(0, 0, doc.page.width, 70).fill([rr, gg, bb]);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text(b.name, 50, 26);
  doc.font('Helvetica').fontSize(10).text('RESULT SLIP', 50, 30, { align: 'right' });
  doc.moveDown(3);
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text(snap.exam.title, 50, 95);
  doc.font('Helvetica').fontSize(11).fillColor('#334155');
  const rows = [
    ['Candidate', a.full_name],
    ['Attempt', `#${a.attempt_no} · submitted ${formatDateTime(a.submitted_at, { timezone: b.timezone })}`],
    ['Score', `${Number(r.raw_score)} / ${Number(r.max_score)} (${Number(r.percent)}%)${r.scaled_score ? ` · scaled ${Number(r.scaled_score)}` : ''}`],
    ['Result', r.has_pending_manual ? 'Provisional — some answers await manual grading' : r.passed === null ? r.band || '—' : r.passed ? 'PASS' : 'FAIL'],
    bd.passMark !== null && bd.passMark !== undefined ? ['Pass mark', `${bd.passMark}${bd.passMarkType === 'raw' ? ' marks' : '%'}`] : null,
    r.band ? ['Proficiency band', r.band] : null,
    r.percentile !== null ? ['Percentile', `${Number(r.percentile)}`] : null,
  ].filter(Boolean);
  let y = 125;
  for (const [k, v] of rows) {
    doc.fillColor('#64748b').text(k, 50, y, { width: 130 });
    doc.fillColor('#0f172a').text(String(v), 190, y, { width: 350 });
    y += 20;
  }
  const table = (title, list) => {
    if (!list || !list.length) return;
    y += 14;
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(12).text(title, 50, y);
    y += 20;
    doc.font('Helvetica').fontSize(10);
    for (const s of list) {
      doc.fillColor('#334155').text(s.label, 50, y, { width: 300 });
      doc.text(`${s.score} / ${s.max}`, 360, y, { width: 80, align: 'right' });
      doc.text(`${s.percent}%`, 450, y, { width: 80, align: 'right' });
      doc.rect(50, y + 13, 480, 3).fill('#e2e8f0');
      doc.rect(50, y + 13, Math.max(0, Math.min(480, (s.percent / 100) * 480)), 3).fill([rr, gg, bb]);
      y += 24;
    }
  };
  table('Sections', bd.sections && bd.sections.length > 1 ? bd.sections : null);
  table('Domains', bd.domains);
  const verifyTarget = cert ? verifyUrl(cert.code) : null;
  if (verifyTarget) {
    const qr = await QRCode.toBuffer(verifyTarget, { type: 'png', margin: 1, width: 200 });
    doc.image(qr, doc.page.width - 50 - 90, doc.page.height - 50 - 110, { width: 90 });
    doc.fontSize(9).fillColor('#475569').text(`Certificate ${cert.code} — verify at ${verifyTarget.replace(/^https?:\/\//, '')}`, 50, doc.page.height - 50 - 30, { width: 350 });
  }
  return toBuffer(doc);
}

module.exports = { issueForAttempt, verify, certificatePdf, resultSlipPdf, newCode, verifyUrl };
