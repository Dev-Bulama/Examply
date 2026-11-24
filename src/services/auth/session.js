'use strict';

const settings = require('../settings');
const users = require('./users');

/**
 * Completes sign-in: regenerates the session id (prevents fixation), records login history and sets the
 * cookie lifetime ("remember me" keeps it for N days, otherwise it is a browser-session cookie with an idle timeout).
 */
function establishSession(req, user, { remember = false, method = 'password' } = {}) {
  const returnTo = req.session && req.session.returnTo;
  const pendingFlash = req.session && req.session.flash;
  return new Promise((resolve, reject) => {
    req.session.regenerate(async (err) => {
      if (err) return reject(err);
      try {
        req.session.userId = user.id;
        req.session.remember = !!remember;
        req.session.authAt = Date.now();
        req.session.lastSeen = Date.now();
        req.session.authVersion = user.auth_version || 0;
        req.session.authMethod = method;
        if (pendingFlash) req.session.flash = pendingFlash;
        if (remember) req.session.cookie.maxAge = settings.getSync('security.remember_me_days') * 24 * 3600 * 1000;
        else req.session.cookie.expires = false;
        await users.recordLogin({ userId: user.id, email: user.email, ip: req.ip, userAgent: req.get('user-agent'), success: true, reason: method });
        req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve(returnTo)));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Only allow same-site relative redirects after login. */
function safeReturnTo(url, fallback) {
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') && !url.startsWith('/logout')) return url;
  return fallback;
}

module.exports = { establishSession, safeReturnTo };
