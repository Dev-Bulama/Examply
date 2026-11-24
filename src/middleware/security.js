'use strict';

const crypto = require('crypto');
const helmet = require('helmet');
const { getEnv } = require('../config/env');

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
        styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        // KaTeX and Chart.js set inline style attributes on generated elements.
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://api.paystack.co', ...(env.isProduction ? [] : ['ws:', 'wss:'])],
        frameSrc: ["'self'", 'https://checkout.paystack.com', 'https://js.paystack.co'],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        ...(env.isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: env.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  return [nonce, h];
}

module.exports = { securityHeaders };
