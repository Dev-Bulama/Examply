'use strict';

const settings = require('../../services/settings');
const audit = require('../../services/audit');
const mail = require('../../services/mail');
const uploads = require('../../services/uploads');
const { getEnv } = require('../../config/env');
const { isHexColor, contrast, parseHex } = require('../../services/theme');
const { TIMEZONES, isValidTimezone, DATE_FORMATS } = require('../../utils/time');
const { CURRENCIES } = require('../../utils/money');
const { notFound } = require('../../utils/errors');

/** Declarative settings sections. Each field maps 1:1 to a settings key. */
const SECTIONS = {
  general: {
    label: 'General',
    description: 'Site identity, timezone and formats.',
    fields: [
      { key: 'general.site_name', label: 'Site name', type: 'text', required: true, max: 120 },
      { key: 'general.tagline', label: 'Tagline', type: 'text', max: 200 },
      { key: 'general.contact_email', label: 'Contact email', type: 'email', hint: 'Shown on receipts and the contact page.' },
      { key: 'general.timezone', label: 'Site timezone', type: 'select', options: () => TIMEZONES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') })), hint: 'Users can override this in their profile. Times are stored in UTC.' },
      { key: 'general.date_format', label: 'Date format', type: 'select', options: () => DATE_FORMATS.map((f) => ({ value: f, label: f })) },
      { key: 'general.currency', label: 'Default currency', type: 'select', options: () => Object.entries(CURRENCIES).map(([c, d]) => ({ value: c, label: `${c} — ${d.name}` })) },
    ],
  },
  branding: {
    label: 'Branding',
    description: 'Colours are applied as CSS variables across the site, emails and PDFs.',
    fields: [
      { key: 'branding.primary_color', label: 'Primary colour', type: 'color', required: true },
      { key: 'branding.secondary_color', label: 'Secondary colour', type: 'color', required: true },
      { key: 'branding.default_theme', label: 'Default theme for visitors', type: 'select', options: () => [{ value: 'system', label: 'Follow device setting' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
    ],
    uploads: [
      { key: 'general.logo_path', label: 'Logo', hint: 'PNG, SVG or WebP, up to 1 MB. Shown in the header, emails and PDFs.', allowed: ['png', 'svg', 'webp', 'jpg'] },
      { key: 'general.favicon_path', label: 'Favicon', hint: 'Square PNG, SVG or ICO, up to 1 MB.', allowed: ['png', 'svg', 'ico'] },
      { key: 'seo.og_image_path', label: 'Social sharing image', hint: '1200 × 630 PNG or JPG, used when links are shared.', allowed: ['png', 'jpg'] },
    ],
  },
  security: {
    label: 'Security',
    description: 'Password policy, sessions, two-factor authentication and registration.',
    fields: [
      { key: 'security.require_2fa_admin', label: 'Require two-factor authentication for Super Admins and Admins', type: 'checkbox' },
      { key: 'security.registration_open', label: 'Allow anyone to create an account', type: 'checkbox', hint: 'When off, accounts are created by admins or organisation invitations.' },
      { key: 'security.password_min_length', label: 'Minimum password length', type: 'number', min: 8, max: 64 },
      { key: 'security.password_require_mixed_case', label: 'Require upper- and lower-case letters', type: 'checkbox' },
      { key: 'security.password_require_number', label: 'Require a number', type: 'checkbox' },
      { key: 'security.password_require_symbol', label: 'Require a symbol', type: 'checkbox' },
      { key: 'security.session_idle_minutes', label: 'Sign out after inactivity (minutes)', type: 'number', min: 5, max: 1440, hint: 'Does not apply to “Keep me signed in” sessions.' },
      { key: 'security.remember_me_days', label: '“Keep me signed in” lasts (days)', type: 'number', min: 1, max: 365 },
    ],
  },
  email: {
    label: 'Email (SMTP)',
    description: 'Outgoing mail for verification, receipts, reminders and results.',
    fields: [
      { key: 'email.smtp_host', label: 'SMTP host', type: 'text', max: 191, hint: 'For Hostinger email: smtp.hostinger.com' },
      { key: 'email.smtp_port', label: 'Port', type: 'number', min: 1, max: 65535, hint: '465 with SSL, or 587 with STARTTLS.' },
      { key: 'email.smtp_secure', label: 'Use SSL/TLS from the start (port 465)', type: 'checkbox' },
      { key: 'email.smtp_user', label: 'Username', type: 'text', max: 191 },
      { key: 'email.smtp_password', label: 'Password', type: 'secret' },
      { key: 'email.from_name', label: 'From name', type: 'text', max: 120 },
      { key: 'email.from_address', label: 'From address', type: 'email' },
    ],
  },
  auth: {
    label: 'Sign-in options',
    description: 'Optional Google sign-in.',
    fields: [
      { key: 'auth.google_enabled', label: 'Enable “Continue with Google”', type: 'checkbox' },
      { key: 'auth.google_client_id', label: 'Google OAuth client ID', type: 'text', max: 255 },
      { key: 'auth.google_client_secret', label: 'Google OAuth client secret', type: 'secret' },
    ],
  },
  ai: {
    label: 'AI generation',
    description: 'Connect Claude (Anthropic) or OpenAI so staff can generate certification-level questions and exams from a prompt.',
    fields: [
      { key: 'ai.enabled', label: 'Enable AI question generation', type: 'checkbox' },
      { key: 'ai.default_provider', label: 'Default provider', type: 'select', options: () => [{ value: 'anthropic', label: 'Claude (Anthropic)' }, { value: 'openai', label: 'OpenAI / OpenAI-compatible' }] },
      { key: 'ai.anthropic_api_key', label: 'Anthropic API key', type: 'secret' },
      { key: 'ai.anthropic_model', label: 'Claude model', type: 'select', options: () => require('../../services/ai/providers').ANTHROPIC_MODELS.map((m) => ({ value: m.id, label: m.label })) },
      { key: 'ai.anthropic_effort', label: 'Claude effort', type: 'select', options: () => ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ value: e, label: e === 'high' ? 'high (recommended for exam writing)' : e })), hint: 'Higher effort = more careful questions, more tokens.' },
      { key: 'ai.openai_api_key', label: 'OpenAI API key', type: 'secret' },
      { key: 'ai.openai_model', label: 'OpenAI model', type: 'text', max: 80, hint: 'The exact model name from your OpenAI account; it must support JSON-schema structured outputs.' },
      { key: 'ai.openai_base_url', label: 'OpenAI API base URL', type: 'text', max: 255, hint: 'Leave as https://api.openai.com/v1 unless you use Azure OpenAI or a compatible gateway.' },
      { key: 'ai.max_questions_per_run', label: 'Maximum questions per generation', type: 'number', min: 1, max: 300 },
    ],
  },
  maintenance: {
    label: 'Maintenance & SEO',
    description: 'Maintenance mode blocks everyone except staff. SEO defaults apply to every public page.',
    fields: [
      { key: 'maintenance.enabled', label: 'Maintenance mode', type: 'checkbox', hint: 'Staff can still sign in at /login.' },
      { key: 'maintenance.message', label: 'Maintenance message', type: 'textarea', max: 500 },
      { key: 'seo.meta_description', label: 'Default meta description', type: 'textarea', max: 300 },
    ],
  },
};

function sectionOr404(name) {
  const section = SECTIONS[name];
  if (!section) throw notFound('Unknown settings section.');
  return section;
}

async function show(req, res) {
  const name = req.params.section || 'general';
  const section = sectionOr404(name);
  await settings.ensureLoaded();
  const values = {};
  const secretsSet = {};
  for (const f of section.fields) {
    if (f.type === 'secret') secretsSet[f.key] = await settings.isSet(f.key);
    else values[f.key] = settings.getSync(f.key);
  }
  const uploaded = {};
  for (const u of section.uploads || []) uploaded[u.key] = settings.getSync(u.key);
  res.render('admin/settings/index', {
    title: `Settings · ${section.label}`,
    layout: 'layouts/app',
    sections: SECTIONS,
    current: name,
    section,
    values,
    secretsSet,
    uploaded,
    googleRedirect: `${getEnv().APP_URL}/auth/google/callback`,
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Settings', href: '/admin/settings' }, { label: section.label }],
  });
}

function validateField(f, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  switch (f.type) {
    case 'checkbox':
      return { value: Array.isArray(v) ? v.includes('1') : v === '1' || v === 'on' };
    case 'number': {
      const n = Number(v);
      if (v === '' || !Number.isInteger(n) || n < f.min || n > f.max) return { error: `Enter a whole number between ${f.min} and ${f.max}.` };
      return { value: n };
    }
    case 'color':
      if (!isHexColor(v)) return { error: 'Enter a colour like #1f4fd1.' };
      return { value: v.toLowerCase() };
    case 'email':
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: 'Enter a valid email address.' };
      return { value: v || '' };
    case 'select': {
      const allowed = f.options().map((o) => String(o.value));
      if (!allowed.includes(String(v))) return { error: 'Choose an option from the list.' };
      return { value: v };
    }
    default:
      if (f.required && !v) return { error: 'This field is required.' };
      if (f.max && String(v || '').length > f.max) return { error: `Use at most ${f.max} characters.` };
      return { value: v || '' };
  }
}

async function save(req, res) {
  const name = req.params.section;
  const section = sectionOr404(name);
  const back = `/admin/settings/${name}`;
  const errors = {};
  const changes = {};
  for (const f of section.fields) {
    if (f.type === 'secret') {
      if (req.body[`${f.key}__clear`] === '1') changes[f.key] = '';
      else if (typeof req.body[f.key] === 'string' && req.body[f.key] !== '') changes[f.key] = req.body[f.key];
      continue;
    }
    const r = validateField(f, req.body[f.key]);
    if (r.error) errors[f.key] = r.error;
    else changes[f.key] = r.value;
  }
  if (name === 'general' && changes['general.timezone'] && !isValidTimezone(changes['general.timezone'])) errors['general.timezone'] = 'Choose a valid timezone.';
  if (name === 'branding' && changes['branding.primary_color']) {
    const ratio = contrast(parseHex(changes['branding.primary_color']), [255, 255, 255]);
    if (ratio < 3) errors['branding.primary_color'] = `This colour is too light for buttons with white text (contrast ${ratio.toFixed(1)}:1; needs at least 3:1). Choose a darker shade.`;
  }
  if (name === 'auth' && changes['auth.google_enabled']) {
    const hasSecret = changes['auth.google_client_secret'] || (await settings.isSet('auth.google_client_secret'));
    if (!changes['auth.google_client_id'] || !hasSecret) errors['auth.google_enabled'] = 'Enter the client ID and secret before enabling Google sign-in.';
  }
  if (name === 'ai' && changes['ai.openai_base_url'] && !/^https:\/\/[^\s]+$/i.test(changes['ai.openai_base_url'])) errors['ai.openai_base_url'] = 'Enter an https:// URL.';
  if (Object.keys(errors).length) {
    req.setFormState(req.body, errors);
    req.flash('danger', 'Settings were not saved. Please correct the highlighted fields.');
    return res.redirect(back);
  }
  const { before, after } = await settings.setMany(changes, { userId: req.user.id });
  await audit.record(req, `settings.${name}`, { entityType: 'settings', entityId: name, before, after });
  req.flash('success', `${section.label} settings saved.`);
  return res.redirect(back);
}

async function upload(req, res) {
  const section = SECTIONS.branding;
  const spec = section.uploads.find((u) => u.key === req.params.key);
  if (!spec) throw notFound();
  let fileName;
  try {
    fileName = uploads.saveImage(req.file, { dir: 'branding', allowed: spec.allowed });
  } catch (err) {
    req.flash('danger', err.message);
    return res.redirect('/admin/settings/branding');
  }
  const previous = settings.getSync(spec.key);
  await settings.set(spec.key, fileName, { userId: req.user.id });
  uploads.removeStored(previous, { dir: 'branding' });
  await audit.record(req, 'settings.branding_upload', { entityType: 'settings', entityId: spec.key, before: { [spec.key]: previous }, after: { [spec.key]: fileName } });
  req.flash('success', `${spec.label} updated.`);
  return res.redirect('/admin/settings/branding');
}

async function removeUpload(req, res) {
  const spec = SECTIONS.branding.uploads.find((u) => u.key === req.params.key);
  if (!spec) throw notFound();
  const previous = settings.getSync(spec.key);
  await settings.set(spec.key, '', { userId: req.user.id });
  uploads.removeStored(previous, { dir: 'branding' });
  await audit.record(req, 'settings.branding_remove', { entityType: 'settings', entityId: spec.key, before: { [spec.key]: previous } });
  req.flash('success', `${spec.label} removed.`);
  return res.redirect('/admin/settings/branding');
}

async function testEmail(req, res) {
  const to = String(req.body.to || req.user.email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    req.flash('danger', 'Enter a valid email address for the test.');
    return res.redirect('/admin/settings/email');
  }
  try {
    const smtp = await mail.smtpConfig();
    if (!smtp) throw new mail.MailNotConfiguredError();
    await mail.sendNow({ to, template: 'test_email', vars: { name: req.user.full_name, time: new Date().toUTCString() } });
    req.flash('success', `Test email sent to ${to}. Check the inbox (and spam folder).`);
  } catch (err) {
    req.flash('danger', `The test email failed: ${err.message}`);
  }
  await audit.record(req, 'settings.test_email', { entityType: 'settings', entityId: 'email', after: { to } });
  return res.redirect('/admin/settings/email');
}

async function testAi(req, res) {
  const provider = req.params.provider === 'openai' ? 'openai' : 'anthropic';
  const problem = await require('../../services/ai/providers').testConnection(provider);
  await audit.record(req, 'settings.test_ai', { entityType: 'settings', entityId: 'ai', after: { provider, ok: !problem } });
  req.flash(problem ? 'danger' : 'success', problem ? `Connection test failed: ${problem}` : `${provider === 'anthropic' ? 'Claude' : 'OpenAI'} is connected and the model is available.`);
  return res.redirect('/admin/settings/ai');
}

module.exports = { show, save, upload, removeUpload, testEmail, testAi, SECTIONS };
