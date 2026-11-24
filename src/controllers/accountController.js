'use strict';

const { db } = require('../config/db');
const settings = require('../services/settings');
const passwords = require('../services/auth/passwords');
const users = require('../services/auth/users');
const totp = require('../services/auth/totp');
const rbac = require('../services/rbac');
const mail = require('../services/mail');
const audit = require('../services/audit');
const uploads = require('../services/uploads');
const { parseJson, toJson } = require('../utils/json');
const { TIMEZONES } = require('../utils/time');
const { COUNTRIES, isCountry } = require('../utils/countries');
const { fieldErrors } = require('../middleware/validate');
const { z, trimmed, optionalTrimmed, timezone, intOrNull } = require('../validators/common');

const PROFILE_FIELDS = ['full_name', 'phone', 'country', 'organisation_name', 'job_title', 'years_experience', 'timezone'];

const profileSchema = z.object({
  full_name: trimmed(150, 2, 'Enter your full name as it should appear on certificates.'),
  phone: optionalTrimmed(40).refine((v) => !v || /^[+0-9 ()-]{6,40}$/.test(v), 'Enter a valid phone number.'),
  country: z
    .string()
    .optional()
    .transform((v) => (v ? v.toUpperCase() : null))
    .refine((v) => !v || isCountry(v), 'Choose a country from the list.'),
  organisation_name: optionalTrimmed(150),
  job_title: optionalTrimmed(120),
  years_experience: intOrNull(0, 60),
  timezone: z
    .string()
    .optional()
    .transform((v) => v || null)
    .pipe(timezone.nullable()),
});

function layoutLocals(title, extra = {}) {
  return { title, layout: 'layouts/app', area: 'candidate', ...extra };
}

async function profile(req, res) {
  res.render('account/profile', {
    ...layoutLocals('Profile'),

    countries: COUNTRIES,
    timezones: TIMEZONES,
    breadcrumbs: [{ label: 'Account' }, { label: 'Profile' }],
  });
}

async function updateProfile(req, res) {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    req.setFormState(req.body, fieldErrors(parsed.error));
    req.flash('danger', 'Please correct the highlighted fields.');
    return res.redirect('/account');
  }
  const before = Object.fromEntries(PROFILE_FIELDS.map((k) => [k, req.user[k]]));
  await db()('users').where({ id: req.user.id }).update(parsed.data);
  if (before.full_name !== parsed.data.full_name) {
    await audit.record(req, 'account.name_changed', { entityType: 'user', entityId: req.user.id, before: { full_name: before.full_name }, after: { full_name: parsed.data.full_name } });
  }
  req.flash('success', 'Your profile has been saved.');
  return res.redirect('/account');
}

async function uploadPhoto(req, res) {
  let name;
  try {
    name = uploads.saveImage(req.file, { dir: 'avatars', allowed: ['png', 'jpg', 'webp'] });
  } catch (err) {
    req.flash('danger', err.message);
    return res.redirect('/account');
  }
  uploads.removeStored(req.user.photo_path, { dir: 'avatars' });
  await db()('users').where({ id: req.user.id }).update({ photo_path: name });
  req.flash('success', 'Your photo has been updated.');
  return res.redirect('/account');
}

async function removePhoto(req, res) {
  uploads.removeStored(req.user.photo_path, { dir: 'avatars' });
  await db()('users').where({ id: req.user.id }).update({ photo_path: null });
  req.flash('success', 'Your photo has been removed.');
  return res.redirect('/account');
}

async function preferences(req, res) {
  const theme = ['system', 'light', 'dark'].includes(req.body.theme) ? req.body.theme : 'system';
  await db()('users').where({ id: req.user.id }).update({ theme });
  if (req.accepts(['json', 'html']) === 'json') return res.json({ ok: true, theme });
  return res.redirect('/account');
}

// ---------------------------------------------------------------- Security

async function security(req, res) {
  const history = await db()('login_history').where({ user_id: req.user.id }).orderBy('created_at', 'desc').limit(15);
  const p = await passwords.policy();
  res.render('account/security', {
    ...layoutLocals('Security'),

    history,
    recoveryCount: parseJson(req.user.totp_recovery_codes, []).length,
    policyText: passwords.describe(p),
    twoFactorRequired: settings.getSync('security.require_2fa_admin') && rbac.requires2fa(req.user.roleSlugs),
    breadcrumbs: [{ label: 'Account' }, { label: 'Security' }],
  });
}

async function changePassword(req, res) {
  const { current_password: current = '', password = '', password_confirmation: confirmation = '' } = req.body;
  const errors = {};
  if (req.user.password_hash && !(await passwords.verify(String(current), req.user.password_hash))) errors.current_password = 'Your current password is incorrect.';
  const problems = passwords.check(String(password), await passwords.policy(), { email: req.user.email, name: req.user.full_name });
  if (problems.length) errors.password = problems.join(' ');
  if (password !== confirmation) errors.password_confirmation = 'The passwords do not match.';
  if (Object.keys(errors).length) {
    req.setFormState({}, errors);
    req.flash('danger', 'Your password was not changed.');
    return res.redirect('/account/security');
  }
  const hash = await passwords.hash(String(password));
  const now = new Date();
  await db()('users').where({ id: req.user.id }).update({ password_hash: hash, password_changed_at: now });
  // Keep this session; every other session for this user is signed out (auth_version check in loadUser).
  req.session.authVersion = await users.bumpAuthVersion(req.user.id);
  await mail.queue({ to: req.user.email, template: 'password_changed', vars: { name: req.user.full_name, ip: req.ip, time: now.toUTCString() } });
  await audit.record(req, 'account.password_changed', { entityType: 'user', entityId: req.user.id });
  req.flash('success', 'Your password has been changed. Other devices have been signed out.');
  return res.redirect('/account/security');
}

async function twoFactorSetup(req, res) {
  if (req.user.totp_enabled_at) return res.redirect('/account/security');
  if (!req.session.pendingTotp) req.session.pendingTotp = totp.generateSecret();
  const secret = req.session.pendingTotp;
  const { dataUrl } = await totp.qrDataUrl({ secret, email: req.user.email, issuer: settings.getSync('general.site_name') });
  res.render('account/two-factor-setup', {
    ...layoutLocals('Set up two-factor authentication'),

    qr: dataUrl,
    secretGrouped: secret.match(/.{1,4}/g).join(' '),
    breadcrumbs: [{ label: 'Account' }, { label: 'Security', href: '/account/security' }, { label: 'Two-factor' }],
  });
}

async function twoFactorEnable(req, res) {
  const secret = req.session.pendingTotp;
  if (!secret) return res.redirect('/account/security/2fa');
  const step = totp.matchStep(secret, req.body.code);
  if (step === null) {
    req.setFormState({}, { code: 'That code is not valid. Codes change every 30 seconds — try the current one.' });
    return res.redirect('/account/security/2fa');
  }
  const { codes, hashes } = await totp.generateRecoveryCodes();
  await db()('users')
    .where({ id: req.user.id })
    .update({ totp_secret_enc: totp.encryptSecret(secret), totp_enabled_at: new Date(), totp_recovery_codes: toJson(hashes), totp_last_step: step });
  delete req.session.pendingTotp;
  await audit.record(req, 'account.2fa_enabled', { entityType: 'user', entityId: req.user.id });
  return res.render('account/recovery-codes', {
    ...layoutLocals('Recovery codes'),

    codes,
    justEnabled: true,
    user: { ...req.user, mustEnroll2fa: false, totp_enabled_at: new Date() },
  });
}

async function verifyPasswordAndCode(req) {
  if (req.user.password_hash && !(await passwords.verify(String(req.body.password || ''), req.user.password_hash))) return 'Your password is incorrect.';
  const step = totp.matchStep(totp.decryptSecret(req.user.totp_secret_enc), req.body.code, req.user.totp_last_step);
  if (step === null) return 'That authentication code is not valid (or was already used).';
  await db()('users').where({ id: req.user.id }).update({ totp_last_step: step });
  return null;
}

async function twoFactorDisable(req, res) {
  if (settings.getSync('security.require_2fa_admin') && rbac.requires2fa(req.user.roleSlugs)) {
    req.flash('danger', 'Your role requires two-factor authentication, so it cannot be turned off.');
    return res.redirect('/account/security');
  }
  const problem = await verifyPasswordAndCode(req);
  if (problem) {
    req.flash('danger', problem);
    return res.redirect('/account/security');
  }
  await db()('users').where({ id: req.user.id }).update({ totp_secret_enc: null, totp_enabled_at: null, totp_recovery_codes: null, totp_last_step: null });
  await audit.record(req, 'account.2fa_disabled', { entityType: 'user', entityId: req.user.id });
  req.flash('success', 'Two-factor authentication is now off.');
  return res.redirect('/account/security');
}

async function regenerateRecoveryCodes(req, res) {
  const problem = await verifyPasswordAndCode(req);
  if (problem) {
    req.flash('danger', problem);
    return res.redirect('/account/security');
  }
  const { codes, hashes } = await totp.generateRecoveryCodes();
  await db()('users').where({ id: req.user.id }).update({ totp_recovery_codes: toJson(hashes) });
  await audit.record(req, 'account.recovery_codes_regenerated', { entityType: 'user', entityId: req.user.id });
  return res.render('account/recovery-codes', { ...layoutLocals('Recovery codes'), codes, justEnabled: false });
}

// ---------------------------------------------------------------- Privacy (NDPR / GDPR)

const EXPORT_TABLES = [
  ['login_history', 'user_id', ['created_at', 'ip', 'user_agent', 'success', 'reason']],
  ['attempts', 'user_id', ['uuid', 'exam_id', 'attempt_no', 'mode', 'status', 'started_at', 'submitted_at', 'percent', 'passed', 'band', 'ip']],
  ['results', 'user_id', ['exam_id', 'raw_score', 'max_score', 'percent', 'passed', 'band', 'percentile', 'created_at']],
  ['certificates', 'user_id', ['code', 'exam_title', 'percent', 'issued_at', 'revoked_at']],
  ['orders', 'user_id', ['order_no', 'status', 'payment_method', 'total_kobo', 'currency', 'paid_at', 'created_at']],
  ['entitlements', 'user_id', ['product_id', 'starts_at', 'expires_at', 'source', 'revoked_at']],
  ['notifications', 'user_id', ['type', 'title', 'body', 'read_at', 'created_at']],
  ['organisation_users', 'user_id', ['organisation_id', 'role', 'joined_at']],
  ['reviews', 'user_id', ['product_id', 'rating', 'title', 'body', 'status', 'created_at']],
  ['support_tickets', 'user_id', ['ticket_no', 'subject', 'status', 'created_at']],
];

async function exportData(req, res) {
  const u = req.user;
  const data = {
    exported_at: new Date().toISOString(),
    profile: {
      email: u.email,
      full_name: u.full_name,
      phone: u.phone,
      country: u.country,
      organisation_name: u.organisation_name,
      job_title: u.job_title,
      years_experience: u.years_experience,
      timezone: u.timezone,
      email_verified_at: u.email_verified_at,
      two_factor_enabled: !!u.totp_enabled_at,
      created_at: u.created_at,
      roles: u.roles.map((r) => r.name),
    },
    accommodations: await db()('user_accommodations').where({ user_id: u.id }).first('extra_time_percent', 'large_font', 'high_contrast'),
  };
  for (const [table, col, cols] of EXPORT_TABLES) data[table] = await db()(table).where(col, u.id).select(cols);
  await audit.record(req, 'account.data_exported', { entityType: 'user', entityId: u.id });
  res.set('Content-Disposition', `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
}

async function requestDeletion(req, res) {
  if (req.user.password_hash && !(await passwords.verify(String(req.body.password || ''), req.user.password_hash))) {
    req.flash('danger', 'Your password is incorrect. Your account was not scheduled for deletion.');
    return res.redirect('/account');
  }
  if (req.user.hasRole('super_admin')) {
    req.flash('danger', 'A Super Admin account cannot request deletion. Transfer the role to someone else first.');
    return res.redirect('/account');
  }
  const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
  await db()('users').where({ id: req.user.id }).update({ deletion_requested_at: new Date(), deletion_reason: reason });
  await audit.record(req, 'account.deletion_requested', { entityType: 'user', entityId: req.user.id, after: { reason } });
  req.flash('success', 'Your deletion request has been received. An administrator will process it within 30 days; you can cancel it until then.');
  return res.redirect('/account');
}

async function cancelDeletion(req, res) {
  await db()('users').where({ id: req.user.id }).update({ deletion_requested_at: null, deletion_reason: null });
  await audit.record(req, 'account.deletion_cancelled', { entityType: 'user', entityId: req.user.id });
  req.flash('success', 'Your deletion request has been cancelled.');
  return res.redirect('/account');
}

module.exports = {
  profile,
  updateProfile,
  uploadPhoto,
  removePhoto,
  preferences,
  security,
  changePassword,
  twoFactorSetup,
  twoFactorEnable,
  twoFactorDisable,
  regenerateRecoveryCodes,
  exportData,
  requestDeletion,
  cancelDeletion,
};
