'use strict';

const crypto = require('crypto');
const helmet = require('helmet');
const { getEnv } = require('../config/env');

const TERMINAL_PAGES = [/^\/attempts\/[0-9a-f-]{36}$/, /^\/admin\/questions\/\d+(\/edit)?$/, /^\/admin\/questions\/new$/];

/** Per-request nonce (available as res.locals.cspNonce) + Helmet with a strict CSP. */
function securityHeaders() {
  const env = getEnv();
  const nonce = (req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  };
  const h = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://checkout.paystack.com', 'https://accounts.google.com'],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, 'https://js.paystack.co'],
        scriptSrcAttr: ["'none'"],
        // Pages that host the lab terminal (xterm.js injects <style> elements it cannot nonce) allow inline styles;
        // scripts stay nonce-locked everywhere.
        styleSrc: ["'self'", (req, res) => (TERMINAL_PAGES.some((r) => r.test(req.path)) ? "'unsafe-inline'" : `'nonce-${res.locals.cspNonce}'`)],
        // KaTeX and Chart.js set inline style attributes on generated elements.
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://api.paystack.co', ...(env.isProduction ? [] : ['ws:', 'wss:'])],
        frameSrc: ["'self'", 'https://checkout.paystack.com', 'https://js.paystack.co'],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        // Only when the site really is on HTTPS — otherwise a site opened over http before SSL is set up loses its CSS/JS.
        ...(env.isProduction && /^https:/.test(env.APP_URL) ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: env.isProduction && /^https:/.test(env.APP_URL) ? { maxAge: 15552000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  return [nonce, h];
}

module.exports = { securityHeaders };
