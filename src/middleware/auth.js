'use strict';

const { db } = require('../config/db');
const rbac = require('../services/rbac');
const settings = require('../services/settings');
const { forbidden } = require('../utils/errors');

const wantsJson = (req) => req.xhr || req.path.startsWith('/api/') || (req.get('accept') || '').includes('application/json');

/** Loads the signed-in user (with roles + permissions) into req.user / res.locals.user. */
async function loadUser(req, res, next) {
  try {
    res.locals.user = null;
    req.user = null;
    const s = req.session;
    if (!s || !s.userId) return next();

    // Idle timeout (skipped for "remember me" sessions).
    const idleMinutes = settings.getSync('security.session_idle_minutes');
    const now = Date.now();
    if (!s.remember && s.lastSeen && now - s.lastSeen > idleMinutes * 60000) {
      return req.session.regenerate(() => {
        req.flash('info', 'You were signed out after a period of inactivity.');
        next();
      });
    }

    const user = await db()('users').where({ id: s.userId }).whereNull('deleted_at').first();
    const staleSession = user && (user.auth_version || 0) !== (s.authVersion || 0);
    if (!user || user.status !== 'active' || staleSession) {
      return req.session.regenerate(() => {
        if (user && user.status !== 'active') req.flash('danger', 'Your account is suspended. Contact support if you think this is a mistake.');
        next();
      });
    }
    s.lastSeen = now;

    const access = await rbac.loadUserAccess(user.id);
    const roleSlugs = access.roles.map((r) => r.slug);
    req.user = {
      ...user,
      roles: access.roles,
      roleSlugs,
      permissions: access.permissions,
      can: (...keys) => keys.every((k) => access.permissions.has(k)),
      canAny: (...keys) => keys.some((k) => access.permissions.has(k)),
      hasRole: (slug) => roleSlugs.includes(slug),
      isStaff: access.permissions.has('admin.access'),
    };
    req.user.mustEnroll2fa = !user.totp_enabled_at && settings.getSync('security.require_2fa_admin') && rbac.requires2fa(roleSlugs);
    res.locals.user = req.user;
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Please sign in.' });
  if (req.method === 'GET' && req.session) req.session.returnTo = req.originalUrl;
  req.flash('info', 'Please sign in to continue.');
  return res.redirect('/login');
}

function guestOnly(req, res, next) {
  if (!req.user) return next();
  return res.redirect(req.user.isStaff ? '/admin' : '/dashboard');
}

const TWO_FA_ALLOWED = [/^\/account\/security(\/|$)/, /^\/logout$/, /^\/theme\.css$/];

/** Admins without 2FA (when required by Settings → Security) can only reach the 2FA setup page. */
function enforce2faEnrollment(req, res, next) {
  if (!req.user || !req.user.mustEnroll2fa) return next();
  if (TWO_FA_ALLOWED.some((re) => re.test(req.path))) return next();
  if (wantsJson(req)) return res.status(403).json({ error: 'Two-factor authentication must be set up first.' });
  req.flash('warning', 'Your role requires two-factor authentication. Set it up to continue.');
  return res.redirect('/account/security/2fa');
}

function requireVerifiedEmail(req, res, next) {
  if (req.user && req.user.email_verified_at) return next();
  if (wantsJson(req)) return res.status(403).json({ error: 'Please verify your email address first.' });
  req.flash('warning', 'Please verify your email address first. We can resend the link from your account page.');
  return res.redirect('/account');
}

/** RBAC: requires every listed permission. Use on every admin route. */
function can(...keys) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (req.user.can(...keys)) return next();
    return next(forbidden());
  };
}

/** RBAC: requires at least one of the listed permissions. */
function canAny(...keys) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (req.user.canAny(...keys)) return next();
    return next(forbidden());
  };
}

module.exports = { loadUser, requireAuth, guestOnly, enforce2faEnrollment, requireVerifiedEmail, can, canAny, wantsJson };
