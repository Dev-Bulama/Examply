'use strict';

const { csrfSync } = require('csrf-sync');

const EXEMPT = [/^\/webhooks\//, /^\/cron\/run/];

const { csrfSynchronisedProtection, generateToken } = csrfSync({
  // Forms send `_csrf`; fetch() sends the X-CSRF-Token header; multipart uploads put it in the query string
  // because the body is not parsed until multer runs.
  getTokenFromRequest: (req) => req.get('x-csrf-token') || (req.body && req.body._csrf) || (req.query && req.query._csrf),
  skipCsrfProtection: (req) => EXEMPT.some((re) => re.test(req.path)),
  errorConfig: { statusCode: 403, message: 'Your session expired or the form was tampered with. Please reload the page and try again.', code: 'EBADCSRFTOKEN' },
});

/** Exposes res.locals.csrfToken to every view (generated lazily per session). */
function csrfLocals(req, res, next) {
  if (req.session) res.locals.csrfToken = generateToken(req);
  next();
}

module.exports = { csrfProtection: csrfSynchronisedProtection, csrfLocals, generateToken };
