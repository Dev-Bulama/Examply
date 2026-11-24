'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { db } = require('../../config/db');
const { getEnv } = require('../../config/env');
const { storagePath } = require('../../config/paths');
const { getLogger } = require('../../config/logger');
const settings = require('../settings');
const { escapeHtml, toPlainText } = require('../../utils/html');
const { DEFAULT_TEMPLATES } = require('./templates');

class MailNotConfiguredError extends Error {
  constructor() {
    super('SMTP is not configured. Add SMTP details in Admin → Settings → Email.');
    this.code = 'SMTP_NOT_CONFIGURED';
  }
}

/** Replaces {{var}} with HTML-escaped values (or raw text when escape=false). Unknown variables render empty. */
function interpolate(template, vars, { escape = true } = {}) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
    const v = vars[name];
    if (v === undefined || v === null) return '';
    return escape ? escapeHtml(v) : String(v);
  });
}

function layout({ siteName, brandColor, bodyHtml, siteUrl }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f1f5f9;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${escapeHtml(brandColor)};padding:18px 28px;color:#ffffff;font-size:18px;font-weight:700">${escapeHtml(siteName)}</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">© ${new Date().getFullYear()} ${escapeHtml(siteName)} · <a href="${escapeHtml(siteUrl)}" style="color:#64748b">${escapeHtml(siteUrl.replace(/^https?:\/\//, ''))}</a></td></tr>
</table></td></tr></table></body></html>`;
}

async function loadTemplate(key, knex = db()) {
  const row = await knex('email_templates').where({ key }).first();
  if (row) return row;
  const def = DEFAULT_TEMPLATES.find((t) => t.key === key);
  if (!def) throw new Error(`Unknown email template: ${key}`);
  return def;
}

/** Renders a template into { subject, html, text }. */
async function render(key, vars = {}) {
  await settings.ensureLoaded();
  const env = getEnv();
  const siteName = settings.getSync('general.site_name');
  const brandColor = settings.getSync('branding.primary_color');
  const all = { site_name: siteName, site_url: env.APP_URL, year: new Date().getFullYear(), brand_color: brandColor, ...vars };
  const tpl = await loadTemplate(key);
  const subject = interpolate(tpl.subject, all, { escape: false }).replace(/[\r\n]+/g, ' ').slice(0, 250);
  const bodyHtml = interpolate(tpl.body_html, all);
  return { subject, html: layout({ siteName, brandColor, bodyHtml, siteUrl: env.APP_URL }), text: toPlainText(bodyHtml) };
}

async function smtpConfig() {
  const s = await settings.getMany('email.');
  if (!s['email.smtp_host']) return null;
  return {
    host: s['email.smtp_host'],
    port: s['email.smtp_port'],
    secure: s['email.smtp_secure'],
    auth: s['email.smtp_user'] ? { user: s['email.smtp_user'], pass: s['email.smtp_password'] } : undefined,
    from: {
      name: s['email.from_name'] || settings.getSync('general.site_name'),
      address: s['email.from_address'] || s['email.smtp_user'],
    },
  };
}

/** Writes the message to storage/mail-outbox (development/test fallback when SMTP is not configured). */
function writeToOutbox(message) {
  const dir = storagePath('mail-outbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${String(message.to).replace(/[^a-z0-9@.]/gi, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(message, null, 2));
  return file;
}

/** Sends immediately. Prefer queue() in request handlers. */
async function sendNow({ to, template, vars, overrideSmtp }) {
  const env = getEnv();
  const message = await render(template, vars);
  const smtp = overrideSmtp || (await smtpConfig());
  if (!smtp) {
    if (env.isProduction) throw new MailNotConfiguredError();
    const file = writeToOutbox({ to, template, ...message });
    getLogger().info({ to, template, file }, 'SMTP not configured — email written to storage/mail-outbox');
    return { outbox: file };
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.auth,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  const info = await transport.sendMail({ from: smtp.from, to, subject: message.subject, html: message.html, text: message.text });
  return { messageId: info.messageId };
}

/** Queues an email as a background job (retried on failure). */
async function queue({ to, template, vars = {} }, knex = db()) {
  const jobs = require('../jobs/queue');
  return jobs.enqueue('email.send', { to, template, vars }, { maxAttempts: 5, knex });
}

/** Copies default templates into the DB (keeps admin edits). */
async function seedTemplates(knex = db()) {
  for (const tpl of DEFAULT_TEMPLATES) {
    await knex('email_templates')
      .insert({ key: tpl.key, name: tpl.name, subject: tpl.subject, body_html: tpl.body_html, variables: JSON.stringify(tpl.variables) })
      .onConflict('key')
      .ignore();
  }
}

module.exports = { render, sendNow, queue, seedTemplates, interpolate, smtpConfig, MailNotConfiguredError };
