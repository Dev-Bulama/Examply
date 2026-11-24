'use strict';

const crypto = require('crypto');
const { db } = require('../config/db');
const { getEnv } = require('../config/env');
const settings = require('../services/settings');
const users = require('../services/auth/users');
const passwords = require('../services/auth/passwords');
const tokens = require('../services/auth/tokens');
const totp = require('../services/auth/totp');
const mail = require('../services/mail');
const rbac = require('../services/rbac');
const { establishSession, safeReturnTo } = require('../services/auth/session');
const { parseJson, toJson } = require('../utils/json');
const { fieldErrors } = require('../middleware/validate');
const { z, trimmed, email, checkbox } = require('../validators/common');

const PENDING_2FA_MINUTES = 10;
const MAX_2FA_FAILURES = 5;
// Dummy hash so unknown emails take as long as wrong passwords (prevents user enumeration by timing).
let dummyHash = null;
const getDummyHash = async () => {
  if (!dummyHash) dummyHash = await passwords.hash(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
};

const loginSchema = z.object({ email, password: z.string().min(1, 'Enter your password.').max(200), remember: checkbox });
const registerSchema = z.object({
  full_name: trimmed(150, 2, 'Enter your full name as it should appear on certificates.'),
  email,
  password: z.string().min(1, 'Choose a password.').max(200),
  password_confirmation: z.string(),
  accept_terms: checkbox.refine((v) => v === true, 'You must accept the terms to create an account.'),
});

/** Staff land in the admin area, everyone else on their dashboard. */
async function homeFor(user) {
  const access = await rbac.loadUserAccess(user.id);
  return access.permissions.has('admin.access') ? '/admin' : '/dashboard';
}

function verifyUrl(token) {
  return `${getEnv().APP_URL}/verify-email/${token}`;
}

async function sendVerification(user) {
  const token = await tokens.createEmailVerification(user);
  await mail.queue({ to: user.email, template: 'verify_email', vars: { name: user.full_name, verify_url: verifyUrl(token), expires_hours: tokens.VERIFY_HOURS } });
}

// ---------------------------------------------------------------- Login

function showLogin(req, res) {
  if (req.query.installed) res.locals.flash.push({ type: 'success', message: 'Installation complete. Sign in with your Super Admin account.' });
  res.render('auth/login', { title: 'Sign in', layout: 'layouts/auth', locked: null });
}

async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    req.setFormState(req.body, fieldErrors(parsed.error));
    return res.redirect('/login');
  }
  const { email: em, password, remember } = parsed.data;
  const lockMinutes = await users.lockRemainingMinutes(em, req.ip);
  if (lockMinutes > 0) {
    await users.recordLogin({ email: em, ip: req.ip, userAgent: req.get('user-agent'), success: false, reason: 'locked' });
    return res.status(429).render('auth/login', { title: 'Sign in', layout: 'layouts/auth', locked: lockMinutes, old: { email: em } });
  }

  const user = await users.findByEmail(em);
  const ok = await passwords.verify(password, user && user.password_hash ? user.password_hash : await getDummyHash());
  if (!user || !ok || !user.password_hash) {
    await users.recordLogin({ userId: user ? user.id : null, email: em, ip: req.ip, userAgent: req.get('user-agent'), success: false, reason: 'bad_credentials' });
    const failures = await users.recentFailures(em, req.ip);
    if (failures >= users.LOCK_MAX_FAILURES) {
      return res.status(429).render('auth/login', { title: 'Sign in', layout: 'layouts/auth', locked: users.LOCK_WINDOW_MINUTES, old: { email: em } });
    }
    const left = users.LOCK_MAX_FAILURES - failures;
    req.setFormState({ email: em }, {});
    req.flash('danger', `The email or password is incorrect.${left <= 2 ? ` ${left} attempt${left === 1 ? '' : 's'} left before sign-in is locked for ${users.LOCK_WINDOW_MINUTES} minutes.` : ''}`);
    return res.redirect('/login');
  }
  if (user.status !== 'active') {
    await users.recordLogin({ userId: user.id, email: em, ip: req.ip, userAgent: req.get('user-agent'), success: false, reason: 'suspended' });
    req.flash('danger', 'Your account is suspended. Contact support if you think this is a mistake.');
    return res.redirect('/login');
  }
  return continueAfterFirstFactor(req, res, user, { remember, method: 'password' });
}

async function continueAfterFirstFactor(req, res, user, { remember, method }) {
  if (user.totp_enabled_at) {
    req.session.pending2fa = { userId: user.id, remember: !!remember, method, at: Date.now(), failures: 0 };
    return res.redirect('/login/2fa');
  }
  const returnTo = await establishSession(req, user, { remember, method });
  return res.redirect(safeReturnTo(returnTo, await homeFor(user)));
}

function pending2fa(req) {
  const p = req.session && req.session.pending2fa;
  if (!p || Date.now() - p.at > PENDING_2FA_MINUTES * 60000) return null;
  return p;
}

function show2fa(req, res) {
  if (!pending2fa(req)) {
    req.flash('info', 'Please sign in again.');
    return res.redirect('/login');
  }
  return res.render('auth/two-factor', { title: 'Two-factor verification', layout: 'layouts/auth' });
}

async function verify2fa(req, res) {
  const p = pending2fa(req);
  if (!p) {
    req.flash('info', 'Your sign-in expired. Please sign in again.');
    return res.redirect('/login');
  }
  const user = await users.findById(p.userId);
  if (!user || user.status !== 'active' || !user.totp_enabled_at) {
    delete req.session.pending2fa;
    return res.redirect('/login');
  }
  const code = String(req.body.code || '').trim();
  let ok = false;
  let usedRecovery = false;
  if (/^\d{3}\s?\d{3}$/.test(code)) {
    const step = totp.matchStep(totp.decryptSecret(user.totp_secret_enc), code, user.totp_last_step);
    if (step !== null) {
      // Conditional update: two concurrent requests with the same code cannot both succeed.
      const n = await db()('users')
        .where({ id: user.id })
        .where((w) => w.whereNull('totp_last_step').orWhere('totp_last_step', '<', step))
        .update({ totp_last_step: step });
      ok = n === 1;
    }
  } else if (code) {
    const remaining = await totp.useRecoveryCode(parseJson(user.totp_recovery_codes, []), code);
    if (remaining) {
      ok = true;
      usedRecovery = true;
      await db()('users').where({ id: user.id }).update({ totp_recovery_codes: toJson(remaining) });
    }
  }
  if (!ok) {
    p.failures += 1;
    await users.recordLogin({ userId: user.id, email: user.email, ip: req.ip, userAgent: req.get('user-agent'), success: false, reason: 'bad_2fa' });
    if (p.failures >= MAX_2FA_FAILURES) {
      delete req.session.pending2fa;
      req.flash('danger', 'Too many incorrect codes. Please sign in again.');
      return res.redirect('/login');
    }
    req.flash('danger', 'That code is not valid. Check your authenticator app and try again.');
    return res.redirect('/login/2fa');
  }
  delete req.session.pending2fa;
  if (usedRecovery) req.flash('warning', 'You signed in with a recovery code. Each code works once — generate new codes from Security if you are running low.');
  const returnTo = await establishSession(req, user, { remember: p.remember, method: `${p.method}+2fa` });
  return res.redirect(safeReturnTo(returnTo, await homeFor(user)));
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie('ssa.sid');
    res.redirect('/');
  });
}

// ---------------------------------------------------------------- Registration & verification

async function showRegister(req, res) {
  if (!settings.getSync('security.registration_open')) {
    return res.status(403).render('auth/registration-closed', { title: 'Registration closed', layout: 'layouts/auth' });
  }
  const p = await passwords.policy();
  return res.render('auth/register', { title: 'Create account', layout: 'layouts/auth', policyText: passwords.describe(p) });
}

async function register(req, res) {
  if (!settings.getSync('security.registration_open')) return res.redirect('/register');
  const parsed = registerSchema.safeParse(req.body);
  const errors = parsed.success ? {} : fieldErrors(parsed.error);
  const v = parsed.success ? parsed.data : null;
  // Password rules are checked even when other fields fail, so every problem is shown at once.
  const pw = String(req.body.password || '');
  const problems = passwords.check(pw, await passwords.policy(), { email: req.body.email, name: req.body.full_name });
  if (problems.length) errors.password = problems.join(' ');
  if (pw !== String(req.body.password_confirmation || '')) errors.password_confirmation = 'The passwords do not match.';
  if (Object.keys(errors).length) {
    req.setFormState(req.body, errors);
    req.flash('danger', 'Please correct the highlighted fields.');
    return res.redirect('/register');
  }
  if (await users.findByEmail(v.email)) {
    // Same message whether or not the address exists elsewhere, but tell the user how to recover.
    req.setFormState(req.body, { email: 'An account with this email already exists. Sign in or reset your password.' });
    return res.redirect('/register');
  }
  const user = await users.createUser({ email: v.email, password: v.password, fullName: v.full_name });
  await sendVerification(user);
  req.flash('success', `Welcome, ${user.full_name.split(' ')[0]}! We sent a verification link to ${user.email}.`);
  await establishSession(req, user, { remember: false, method: 'register' });
  return res.redirect('/dashboard');
}

async function verifyEmail(req, res) {
  const userId = await tokens.consumeEmailVerification(req.params.token);
  if (!userId) {
    req.flash('danger', 'That verification link is invalid or has expired. Sign in and request a new one.');
    return res.redirect(req.user ? '/account' : '/login');
  }
  req.flash('success', 'Your email address is verified. Thank you!');
  return res.redirect(req.user ? '/dashboard' : '/login');
}

async function resendVerification(req, res) {
  if (req.user.email_verified_at) {
    req.flash('info', 'Your email address is already verified.');
  } else {
    const recent = await db()('email_verifications').where({ user_id: req.user.id }).where('created_at', '>', new Date(Date.now() - 60000)).first();
    if (recent) req.flash('info', 'We just sent a link — please wait a minute before asking again.');
    else {
      await sendVerification(req.user);
      req.flash('success', `We sent a new verification link to ${req.user.email}.`);
    }
  }
  return res.redirect(safeReturnTo(req.get('referer') && new URL(req.get('referer'), getEnv().APP_URL).pathname, '/account'));
}

// ---------------------------------------------------------------- Password reset

function showForgot(req, res) {
  res.render('auth/forgot', { title: 'Forgot password', layout: 'layouts/auth', sent: false });
}

async function forgot(req, res) {
  const parsed = z.object({ email }).safeParse(req.body);
  if (!parsed.success) {
    req.setFormState(req.body, fieldErrors(parsed.error));
    return res.redirect('/forgot-password');
  }
  const user = await users.findByEmail(parsed.data.email);
  if (user && user.status === 'active') {
    const recent = await db()('password_resets').where({ user_id: user.id }).where('created_at', '>', new Date(Date.now() - 60000)).first();
    if (!recent) {
      const token = await tokens.createPasswordReset(user, req.ip);
      await mail.queue({
        to: user.email,
        template: 'password_reset',
        vars: { name: user.full_name, reset_url: `${getEnv().APP_URL}/reset-password/${token}`, expires_minutes: tokens.RESET_MINUTES, ip: req.ip },
      });
    }
  }
  // Same response whether or not the account exists (no user enumeration).
  return res.render('auth/forgot', { title: 'Check your email', layout: 'layouts/auth', sent: parsed.data.email });
}

async function showReset(req, res) {
  const row = await tokens.findPasswordReset(req.params.token);
  if (!row) return res.status(400).render('auth/reset-invalid', { title: 'Link expired', layout: 'layouts/auth' });
  const p = await passwords.policy();
  return res.render('auth/reset', { title: 'Choose a new password', layout: 'layouts/auth', token: req.params.token, policyText: passwords.describe(p) });
}

async function reset(req, res) {
  const row = await tokens.findPasswordReset(req.params.token);
  if (!row) return res.status(400).render('auth/reset-invalid', { title: 'Link expired', layout: 'layouts/auth' });
  const user = await users.findById(row.user_id);
  if (!user) return res.status(400).render('auth/reset-invalid', { title: 'Link expired', layout: 'layouts/auth' });
  const pw = String(req.body.password || '');
  const errors = {};
  const problems = passwords.check(pw, await passwords.policy(), { email: user.email, name: user.full_name });
  if (problems.length) errors.password = problems.join(' ');
  if (pw !== String(req.body.password_confirmation || '')) errors.password_confirmation = 'The passwords do not match.';
  if (Object.keys(errors).length) {
    req.setFormState({}, errors);
    return res.redirect(`/reset-password/${req.params.token}`);
  }
  const hash = await passwords.hash(pw);
  const consumed = await db().transaction(async (trx) => {
    if (!(await tokens.consumePasswordReset(row.id, trx))) return false;
    await trx('users')
      .where({ id: user.id })
      .update({ password_hash: hash, password_changed_at: new Date(), auth_version: trx.raw('auth_version + 1'), email_verified_at: user.email_verified_at || new Date() });
    return true;
  });
  if (!consumed) return res.status(400).render('auth/reset-invalid', { title: 'Link expired', layout: 'layouts/auth' });
  await mail.queue({ to: user.email, template: 'password_changed', vars: { name: user.full_name, ip: req.ip, time: new Date().toUTCString() } });
  if (req.session) delete req.session.userId;
  req.flash('success', 'Your password has been changed. Sign in with your new password.');
  return res.redirect('/login');
}

// ---------------------------------------------------------------- Google sign-in (OAuth 2.0 / OpenID Connect)

function googleEnabled() {
  return settings.getSync('auth.google_enabled') && settings.getSync('auth.google_client_id') && settings.getSync('auth.google_client_secret');
}

function googleRedirectUri() {
  return `${getEnv().APP_URL}/auth/google/callback`;
}

function googleStart(req, res) {
  if (!googleEnabled()) {
    req.flash('danger', 'Google sign-in is not enabled.');
    return res.redirect('/login');
  }
  const state = crypto.randomBytes(24).toString('base64url');
  req.session.googleState = { state, remember: req.query.remember === '1', at: Date.now() };
  const params = new URLSearchParams({
    client_id: settings.getSync('auth.google_client_id'),
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

async function googleCallback(req, res) {
  const saved = req.session.googleState;
  delete req.session.googleState;
  if (!googleEnabled() || !saved || saved.state !== req.query.state || Date.now() - saved.at > 10 * 60000 || !req.query.code) {
    req.flash('danger', 'Google sign-in failed or was cancelled. Please try again.');
    return res.redirect('/login');
  }
  let profile;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: settings.getSync('auth.google_client_id'),
        client_secret: settings.getSync('auth.google_client_secret'),
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    if (!resp.ok || !data.id_token) throw new Error(data.error_description || data.error || 'token exchange failed');
    // The ID token came straight from Google's token endpoint over TLS, so its claims can be trusted
    // (OpenID Connect Core §3.1.3.7); we still check issuer, audience and expiry.
    profile = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8'));
    const audOk = profile.aud === settings.getSync('auth.google_client_id');
    const issOk = ['accounts.google.com', 'https://accounts.google.com'].includes(profile.iss);
    if (!audOk || !issOk || profile.exp * 1000 < Date.now()) throw new Error('invalid id_token claims');
    if (!profile.email || !profile.email_verified) throw new Error('Google account email is not verified');
  } catch (err) {
    req.log && req.log.warn({ err: err.message }, 'google sign-in failed');
    req.flash('danger', 'Google sign-in failed. Please try again or use your email and password.');
    return res.redirect('/login');
  }

  let user = await db()('users').where({ google_id: profile.sub }).whereNull('deleted_at').first();
  if (!user) {
    user = await users.findByEmail(profile.email);
    if (user) {
      await db()('users').where({ id: user.id }).update({ google_id: profile.sub, email_verified_at: user.email_verified_at || new Date() });
    } else {
      if (!settings.getSync('security.registration_open')) {
        req.flash('danger', 'Registration is closed. Ask an administrator for an account.');
        return res.redirect('/login');
      }
      user = await users.createUser({ email: profile.email, password: null, fullName: profile.name || profile.email.split('@')[0], emailVerified: true, extra: { google_id: profile.sub } });
    }
  }
  if (user.status !== 'active') {
    req.flash('danger', 'Your account is suspended. Contact support if you think this is a mistake.');
    return res.redirect('/login');
  }
  return continueAfterFirstFactor(req, res, user, { remember: saved.remember, method: 'google' });
}

module.exports = {
  showLogin,
  login,
  show2fa,
  verify2fa,
  logout,
  showRegister,
  register,
  verifyEmail,
  resendVerification,
  showForgot,
  forgot,
  showReset,
  reset,
  googleStart,
  googleCallback,
  sendVerification,
};
